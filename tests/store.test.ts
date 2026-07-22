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
      const got = await reader.getSeries(path);
      expect(got.raw, `${path} should come back at full resolution`).toBe(true);
      expect(got.mean.length, `${path} length`).toBe(want.length);

      for (let i = 0; i < want.length; i++) {
        const a = got.mean[i]!;
        const b = want[i]!;
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
