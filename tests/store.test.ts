/**
 * Storage round-trip.
 *
 * The decoder is verified against MongoDB's implementation (decoder.test.ts); this verifies
 * that nothing is lost between the decoder and a panel. Every metric of every sample goes
 * through ingest and comes back out, and is compared exactly -- constant-column elision,
 * schema drift, and chunk-major layout all have to be transparent.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { decodeFTDC, readMetadata } from '../src/ftdc/index.js';
import { NodeFileStore } from '../src/data/nodeFileStore.js';
import { CaptureWriter } from '../src/data/writer.js';
import { CaptureReader } from '../src/data/reader.js';
import { envelope } from '../src/data/downsample.js';
import { scaleOfPath } from '../src/data/expr.js';
import { discoverFixtures } from './oracle.js';

const fixtures = discoverFixtures();

/** Full-resolution expectation built straight from the decoder, gaps included. */
function referenceSeries(bytes: Uint8Array): {
  series: Map<string, number[]>;
  times: number[];
  total: number;
} {
  const series = new Map<string, number[]>();
  const times: number[] = [];
  let total = 0;

  for (const chunk of decodeFTDC(bytes)) {
    const clock = chunk.keys.indexOf('start');
    for (let s = 0; s < chunk.sampleCount; s++) times.push(chunk.columns[clock]![s]!);

    // Mirror the store's collision suffixing: real captures contain duplicate dotted paths
    // (two mounts at the same mountpoint), so the raw key list is not a set of identifiers.
    const seen = new Map<string, number>();
    const unique = chunk.keys.map((k) => {
      const n = seen.get(k) ?? 0;
      seen.set(k, n + 1);
      return n === 0 ? k : `${k}#${n}`;
    });
    const present = new Set(unique);

    // Any path we have seen before but that this chunk lacks must become NaN, not vanish.
    for (const [path, arr] of series) {
      if (!present.has(path)) {
        for (let s = 0; s < chunk.sampleCount; s++) arr.push(NaN);
      }
    }

    for (let c = 0; c < chunk.keys.length; c++) {
      const path = unique[c]!;
      let arr = series.get(path);
      if (arr === undefined) {
        // Backfill NaN for the samples before this path first appeared.
        arr = new Array<number>(total).fill(NaN);
        series.set(path, arr);
      }
      const col = chunk.columns[c]!;
      for (let s = 0; s < chunk.sampleCount; s++) arr.push(col[s]!);
    }

    total += chunk.sampleCount;
  }

  return { series, times, total };
}

describe.each(fixtures)('capture store: $name', (fixture) => {
  let dir: string;
  let store: NodeFileStore;
  let reader: CaptureReader;
  let expected: ReturnType<typeof referenceSeries>;
  let rawBytes: number;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ftdc-lens-test-'));
    store = new NodeFileStore(dir);

    const bytes = new Uint8Array(readFileSync(fixture.ftdc));
    expected = referenceSeries(bytes);
    rawBytes = expected.total * expected.series.size * 8;

    const meta = readMetadata(bytes);
    const writer = await CaptureWriter.create(store, {
      captureId: 'cap',
      sourceFile: fixture.ftdc,
      ...(meta?.hostname !== undefined ? { hostname: meta.hostname } : {}),
      ...(meta?.version !== undefined ? { mongoVersion: meta.version } : {}),
    });
    for (const chunk of decodeFTDC(bytes)) await writer.addChunk(chunk);
    await writer.finish();

    reader = await CaptureReader.open(store, 'cap');
  }, 120_000);

  afterAll(async () => {
    await reader?.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('preserves the sample clock', () => {
    expect(reader.manifest.sampleCount).toBe(expected.total);
    const t = reader.manifest;
    expect(t.startMs).toBe(expected.times[0]);
    expect(t.endMs).toBe(expected.times[expected.times.length - 1]);
  });

  it('catalogs every metric path', () => {
    expect(new Set(reader.manifest.paths)).toEqual(new Set(expected.series.keys()));
  });

  it('returns every metric of every sample unchanged', async () => {
    let compared = 0;

    for (const [path, want] of expected.series) {
      // getSeries normalises units (mem.* is MiB, /proc values are kB), so the expectation
      // taken straight from the decoder has to be scaled the same way.
      const factor = scaleOfPath(path);
      const got = await reader.getSeries(path);
      expect(got.raw, `${path} should come back at full resolution`).toBe(true);
      expect(got.mean.length, `${path} length`).toBe(want.length);

      for (let i = 0; i < want.length; i++) {
        const a = got.mean[i]!;
        const b = want[i]! * factor;
        if (Number.isNaN(b)) {
          if (!Number.isNaN(a)) {
            throw new Error(`${path}[${i}]: expected NaN (gap), got ${a}`);
          }
        } else if (!Object.is(a, b)) {
          throw new Error(`${path}[${i}]: expected ${b}, got ${a}`);
        }
        compared++;
      }
    }

    // eslint-disable-next-line no-console
    console.log(
      `${fixture.name}: ${compared.toLocaleString()} values round-tripped, ` +
        `${expected.series.size} paths`,
    );
    expect(compared).toBeGreaterThan(0);
  }, 120_000);

  it('elides constant columns', async () => {
    const written = (await stat(join(dir, 'cap', 'columns.bin'))).size;
    const ratio = rawBytes / written;

    // eslint-disable-next-line no-console
    console.log(
      `${fixture.name}: ${(rawBytes / 1e6).toFixed(1)} MB dense -> ` +
        `${(written / 1e6).toFixed(1)} MB stored (${ratio.toFixed(1)}x)`,
    );

    // FTDC is mostly structurally flat; anything below 2x means elision is not working.
    expect(ratio).toBeGreaterThan(2);
  });

  it('serves a time-bounded slice', async () => {
    const { startMs, endMs } = reader.manifest;
    const mid = startMs + (endMs - startMs) / 2;

    const full = await reader.getSeries('start');
    const half = await reader.getSeries('start', { from: mid });

    expect(half.t.length).toBeGreaterThan(0);
    expect(half.t.length).toBeLessThan(full.t.length);
    expect(half.t[0]).toBeGreaterThanOrEqual(mid);
  });

  it('downsamples without hiding extremes', async () => {
    const path = reader.manifest.paths.find((p) => !reader.manifest.flat[reader.manifest.paths.indexOf(p)]!);
    expect(path, 'fixture should contain at least one varying metric').toBeDefined();

    const full = await reader.getSeries(path!);
    const small = await reader.getSeries(path!, { maxPoints: 50 });

    expect(small.raw).toBe(false);
    expect(small.t.length).toBeLessThanOrEqual(50);

    const trueMin = Math.min(...Array.from(full.mean).filter((v) => !Number.isNaN(v)));
    const trueMax = Math.max(...Array.from(full.mean).filter((v) => !Number.isNaN(v)));

    // The whole point of an envelope over LTTB: extremes survive downsampling.
    expect(Math.min(...Array.from(small.min).filter((v) => !Number.isNaN(v)))).toBe(trueMin);
    expect(Math.max(...Array.from(small.max).filter((v) => !Number.isNaN(v)))).toBe(trueMax);
  });
});

describe('envelope', () => {
  it('keeps a one-sample spike that LTTB would drop', () => {
    const n = 10_000;
    const t = new Float64Array(n);
    const v = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      t[i] = i * 1000;
      v[i] = 100;
    }
    v[7777] = 0; // a single-sample dropout: exactly the signal that matters

    const out = envelope('x', t, v, 100);
    expect(out.raw).toBe(false);
    expect(Math.min(...Array.from(out.min))).toBe(0);
  });

  it('propagates all-NaN buckets as gaps', () => {
    const n = 1000;
    const t = new Float64Array(n);
    const v = new Float64Array(n).fill(1);
    for (let i = 0; i < n; i++) t[i] = i * 1000;
    for (let i = 400; i < 600; i++) v[i] = NaN;

    const out = envelope('x', t, v, 10);
    expect(Array.from(out.mean).some((x) => Number.isNaN(x))).toBe(true);
  });
});

describe('FileStore contract', () => {
  it('reads the same file concurrently without either read failing', async () => {
    // OPFS sync access handles are EXCLUSIVE. readText used to take one, so two concurrent
    // reads of a manifest collided and the loser threw NoModificationAllowedError -- which the
    // capture list caught and turned into "there are no captures", hiding data that was
    // sitting on disk. Both backends have to allow this.
    const dir = await mkdtemp(join(tmpdir(), 'ftdc-lens-concurrent-'));
    try {
      const store = new NodeFileStore(dir);
      await store.writeText('cap/manifest.json', '{"captureId":"cap"}');
      const [a, b, c] = await Promise.all([
        store.readText('cap/manifest.json'),
        store.readText('cap/manifest.json'),
        store.readText('cap/manifest.json'),
      ]);
      expect(a).toBe('{"captureId":"cap"}');
      expect(b).toBe(a);
      expect(c).toBe(a);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('lists capture directories', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ftdc-lens-list-'));
    try {
      const store = new NodeFileStore(dir);
      await store.writeText('c0/manifest.json', '{}');
      await store.writeText('c1/manifest.json', '{}');
      expect((await store.listDirs()).sort()).toEqual(['c0', 'c1']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('removeDir resolves when the directory does not exist', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ftdc-lens-contract-'));
    try {
      const store = new NodeFileStore(dir);
      // Both backends must agree here. OPFS removeEntry throws NotFoundError by default,
      // which broke every first-ever ingest: CaptureWriter clears its target before writing,
      // and on a fresh origin that target has never existed.
      await expect(store.removeDir('never-existed')).resolves.toBeUndefined();
      // Idempotent: a second call after a real create/remove cycle is also fine.
      const w = await store.createWritable('cap/columns.bin');
      await w.append(new Uint8Array([1, 2, 3]));
      await w.close();
      await expect(store.removeDir('cap')).resolves.toBeUndefined();
      await expect(store.removeDir('cap')).resolves.toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/**
 * A capture has to know which node it is after the tab that ingested it has gone.
 *
 * Hostname and version come out of the FTDC metadata document while decoding, so they are not
 * known when the writer is created. They used to be attached only to the reply the worker
 * posted, never to the manifest -- so a capture showed its hostname when it was first dropped
 * in and came back as "c4" when it was reopened from OPFS. It looks like the tool forgetting
 * which server it is looking at, and on a replica set it makes the nodes indistinguishable.
 */
describe('capture identity survives a reload', () => {
  it('writes the decoded hostname and version into the manifest', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ftdc-lens-identity-'));
    try {
      const store = new NodeFileStore(dir);
      const writer = await CaptureWriter.create(store, {
        captureId: 'c0',
        sourceFile: 'metrics.2026-07-20T00-00-00Z-00000',
      });
      await writer.finish({ hostname: 'node1.example.com', mongoVersion: '8.0.19-7' });

      // Read it back the way a later session does, rather than trusting the return value.
      const manifest = JSON.parse(await store.readText('c0/manifest.json')) as {
        hostname?: string;
        mongoVersion?: string;
      };
      expect(manifest.hostname).toBe('node1.example.com');
      expect(manifest.mongoVersion).toBe('8.0.19-7');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('leaves them out when the capture carried no metadata', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ftdc-lens-identity-none-'));
    try {
      const store = new NodeFileStore(dir);
      const writer = await CaptureWriter.create(store, { captureId: 'c0', sourceFile: 'm' });
      await writer.finish();
      const manifest = JSON.parse(await store.readText('c0/manifest.json')) as {
        hostname?: string;
      };
      expect(manifest.hostname).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('time range clamping', () => {
  // Zooming repeatedly used to land on a window shorter than the sample interval, which
  // resolves to zero points and a blank panel with nothing to explain it.
  const capture = { startMs: 1_000_000, endMs: 1_000_000 + 3_600_000, cadenceMs: 1000 };
  const FLOOR = Math.max(capture.cadenceMs * 4, 1000);

  /** Mirrors the clamp in useStore.setRange. */
  function clamp(range: [number, number]): [number, number] {
    let [from, to] = range;
    if (to < from) [from, to] = [to, from];
    if (to - from < FLOOR) {
      const centre = (from + to) / 2;
      from = centre - FLOOR / 2;
      to = centre + FLOOR / 2;
    }
    from = Math.max(capture.startMs, from);
    to = Math.min(capture.endMs, to);
    if (to - from < FLOOR) {
      if (from <= capture.startMs) to = Math.min(capture.endMs, from + FLOOR);
      else from = Math.max(capture.startMs, to - FLOOR);
    }
    return [Math.round(from), Math.round(to)];
  }

  it('widens a window narrower than the sample interval', () => {
    const [from, to] = clamp([1_500_000, 1_500_010]);
    expect(to - from).toBeGreaterThanOrEqual(FLOOR);
  });

  it('normalises an inverted selection', () => {
    const [from, to] = clamp([1_600_000, 1_500_000]);
    expect(from).toBeLessThan(to);
  });

  it('stays inside the capture at either end', () => {
    const atStart = clamp([capture.startMs - 500_000, capture.startMs + 10]);
    expect(atStart[0]).toBeGreaterThanOrEqual(capture.startMs);
    expect(atStart[1] - atStart[0]).toBeGreaterThanOrEqual(FLOOR);

    const atEnd = clamp([capture.endMs - 10, capture.endMs + 500_000]);
    expect(atEnd[1]).toBeLessThanOrEqual(capture.endMs);
    expect(atEnd[1] - atEnd[0]).toBeGreaterThanOrEqual(FLOOR);
  });
});
