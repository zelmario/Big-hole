/**
 * Running out of browser storage must fail loudly, at the moment it happens.
 *
 * Reported against a real nine-node bundle (9 x ~210 MB of FTDC, which decodes to ~21 GB): it
 * loaded seven nodes and reported the other two as
 *
 *     ⚠ node6: JSON.parse: unexpected end of data at line 1 column 1 of the JSON data
 *
 * The chain, verified in a real Firefox against a quota-limited profile: OPFS
 * `FileSystemSyncAccessHandle.write()` does **not** throw when the origin is out of room. It
 * writes what fits and returns that smaller count -- 9 MiB out of a requested 16 MiB -- and the
 * next call returns 0, still silently. `append()` ignored the return value, so columns.bin
 * stopped growing while the writer believed otherwise, `manifest.json` was written as zero
 * bytes, ingest posted `ingested`, and the failure only surfaced one call later as JSON.parse
 * on an empty string: a message naming neither storage, nor the node, nor anything actionable.
 *
 * Two things are pinned here. A short write is an error, and an unreadable manifest says why.
 */
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { OpfsFileStore, OutOfStorageError, type FileStore } from '../src/data/fileStore.js';
import { NodeFileStore } from '../src/data/nodeFileStore.js';
import { parseManifest } from '../src/data/reader.js';
import { CaptureWriter } from '../src/data/writer.js';
import { joinFailures, storageWarning } from '../src/store/useStore.js';
import type { DecodedChunk } from '../src/ftdc/types.js';

/* ------------------------------------------------------------- a full disk ---- */

/**
 * An OPFS good enough to run out of room in.
 *
 * Models the one behaviour that matters and that no mock library gets right by default:
 * `write()` returns a byte count, and that count goes short rather than throwing once the
 * budget is gone. Everything else is the minimum the store touches.
 */
function fakeOpfs(budgetBytes: number): { navigator: unknown; used: () => number } {
  let used = 0;
  const files = new Map<string, { bytes: Uint8Array; size: number }>();

  const fileHandle = (path: string) => ({
    createSyncAccessHandle: () =>
      Promise.resolve({
        read(buf: Uint8Array, opts: { at: number }): number {
          const f = files.get(path)!;
          const n = Math.max(0, Math.min(buf.byteLength, f.size - opts.at));
          buf.set(f.bytes.subarray(opts.at, opts.at + n));
          return n;
        },
        write(buf: Uint8Array, opts: { at: number }): number {
          const f = files.get(path)!;
          // The whole point: what fits, not what was asked for, and no exception either way.
          const room = Math.max(0, budgetBytes - used);
          const n = Math.min(buf.byteLength, room);
          if (opts.at + n > f.bytes.byteLength) {
            const grown = new Uint8Array(Math.max(1024, (opts.at + n) * 2));
            grown.set(f.bytes.subarray(0, f.size));
            f.bytes = grown;
          }
          f.bytes.set(buf.subarray(0, n), opts.at);
          f.size = Math.max(f.size, opts.at + n);
          used += n;
          return n;
        },
        truncate(size: number): void {
          const f = files.get(path)!;
          used -= Math.max(0, f.size - size);
          f.size = size;
        },
        getSize(): number {
          return files.get(path)!.size;
        },
        flush(): void {},
        close(): void {},
      }),
    getFile: () =>
      Promise.resolve({
        text: () => {
          const f = files.get(path)!;
          return Promise.resolve(new TextDecoder().decode(f.bytes.subarray(0, f.size)));
        },
      }),
  });

  const dirHandle = (prefix: string): unknown => ({
    kind: 'directory',
    getDirectoryHandle: (name: string) => Promise.resolve(dirHandle(`${prefix}${name}/`)),
    getFileHandle: (name: string, opts?: { create?: boolean }) => {
      const path = `${prefix}${name}`;
      if (!files.has(path)) {
        if (opts?.create !== true) return Promise.reject(new Error('NotFoundError'));
        files.set(path, { bytes: new Uint8Array(1024), size: 0 });
      }
      return Promise.resolve(fileHandle(path));
    },
    removeEntry: (name: string) => {
      for (const key of [...files.keys()]) {
        if (key === `${prefix}${name}` || key.startsWith(`${prefix}${name}/`)) {
          used -= files.get(key)!.size;
          files.delete(key);
        }
      }
      return Promise.resolve();
    },
    entries: () => [][Symbol.iterator](),
  });

  return {
    navigator: { storage: { getDirectory: () => Promise.resolve(dirHandle('')) } },
    used: () => used,
  };
}

/** One chunk of plausible decoded FTDC: a clock that ticks and a column that moves. */
function chunk(startMs: number, samples: number, columns: number): DecodedChunk {
  const keys = ['start', ...Array.from({ length: columns }, (_, i) => `serverStatus.m${i}`)];
  const cols = keys.map((_, c) => {
    const out = new Float64Array(samples);
    for (let s = 0; s < samples; s++) out[s] = c === 0 ? startMs + s * 1000 : s * (c + 1);
    return out;
  });
  return {
    startMs,
    sampleCount: samples,
    keys,
    types: keys.map(() => 0),
    columns: cols,
  } as unknown as DecodedChunk;
}

async function withFakeOpfs<T>(budget: number, body: (store: FileStore) => Promise<T>): Promise<T> {
  const fake = fakeOpfs(budget);
  const original = (globalThis as { navigator?: unknown }).navigator;
  Object.defineProperty(globalThis, 'navigator', {
    value: fake.navigator,
    configurable: true,
    writable: true,
  });
  try {
    return await body(new OpfsFileStore('test-root'));
  } finally {
    Object.defineProperty(globalThis, 'navigator', {
      value: original,
      configurable: true,
      writable: true,
    });
  }
}

/* --------------------------------------------------------------- the tests ---- */

describe('running out of browser storage', () => {
  it('rejects a short write instead of reporting success', async () => {
    await withFakeOpfs(4096, async (store) => {
      const w = await store.createWritable('c0/columns.bin');
      await w.append(new Uint8Array(2048));
      // Only 2048 bytes of room left, and this asks for 4096.
      await expect(w.append(new Uint8Array(4096))).rejects.toBeInstanceOf(OutOfStorageError);
    });
  });

  it('never writes a manifest that parses as nothing', async () => {
    // The exact shape of the bug: room for the columns but not for the manifest. Before the
    // fix this resolved, and `JSON.parse('')` was the first anyone heard of it.
    await withFakeOpfs(200_000, async (store) => {
      const writer = await CaptureWriter.create(store, { captureId: 'c0', sourceFile: 'm' });
      let failed: unknown = null;
      try {
        for (let i = 0; i < 40; i++) await writer.addChunk(chunk(1_700_000_000_000 + i * 300_000, 300, 12));
        await writer.finish({ hostname: 'node1' });
      } catch (err) {
        failed = err;
      }
      expect(failed).toBeInstanceOf(OutOfStorageError);

      // And whatever did land must never masquerade as a readable capture.
      const text = await store.readText('c0/manifest.json').catch(() => '');
      if (text !== '') expect(() => parseManifest('c0', text)).not.toThrow();
    });
  });

  it('releases the file handle when a write fails, so the capture can be cleaned up', async () => {
    // OPFS refuses removeEntry on a directory holding an open sync access handle
    // (NoModificationAllowedError, confirmed in Firefox). Leaking the handle on the failure
    // path would strand the partial capture: invisible in the UI, still spending the quota the
    // retry needs. Verified against the real backend contract rather than the fake, since the
    // Node backend is the one this suite can actually exercise end to end.
    const dir = await mkdtemp(join(tmpdir(), 'big-hole-release-'));
    try {
      const store = new NodeFileStore(dir);
      const w = await store.createWritable('c0/columns.bin');
      await w.append(new Uint8Array([1, 2, 3]));
      await w.close();
      await expect(w.close()).resolves.toBeUndefined(); // idempotent
      await expect(store.removeDir('c0')).resolves.toBeUndefined();
      await expect(stat(join(dir, 'c0'))).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('warning before the twenty minutes', () => {
  const GB = 1e9;

  it('says nothing when the bundle fits', () => {
    // 200 MB of FTDC at ~12x is ~2.4 GB, and there are 8 GB free.
    expect(storageWarning(1, 200e6, 8 * GB)).toBeNull();
  });

  it('names both numbers when it does not', () => {
    // The reported case: nine nodes, ~1.9 GB of FTDC, against Firefox's 10 GiB per-origin cap.
    const notice = storageWarning(9, 1.9 * GB, 10 * 1024 ** 3);
    expect(notice).toContain('9 nodes');
    expect(notice).toContain('22.8 GB'); // what it needs
    expect(notice).toContain('10.7 GB'); // what it has
    expect(notice).toMatch(/Load fewer at a time/);
  });

  it('counts one node in the singular', () => {
    expect(storageWarning(1, 4 * GB, 1 * GB)).toMatch(/^1 node of FTDC/);
  });
});

describe('reporting several nodes that failed for one reason', () => {
  // Nodes are decoded concurrently against one shared quota, so they fail together. Repeating
  // the same paragraph once per node is where the reader stops reading it.
  const OUT_OF_ROOM = 'ran out of browser storage part-way through decoding this node.';

  it('says the reason once and names every node it happened to', () => {
    const out = joinFailures([
      { label: 'node0 logs', detail: OUT_OF_ROOM },
      { label: 'node3 logs', detail: OUT_OF_ROOM },
      { label: 'node6 logs', detail: OUT_OF_ROOM },
    ]);
    expect(out).toBe(
      `node0 logs, node3 logs, node6 logs: ${OUT_OF_ROOM}`,
    );
    expect(out.split(OUT_OF_ROOM)).toHaveLength(2); // said exactly once
  });

  it('keeps genuinely different reasons apart', () => {
    expect(
      joinFailures([
        { label: 'rs0', detail: OUT_OF_ROOM },
        { label: 'rs1', detail: 'no metrics.* files found' },
      ]),
    ).toBe(`rs0: ${OUT_OF_ROOM} — rs1: no metrics.* files found`);
  });

  it('is empty when nothing failed', () => {
    expect(joinFailures([])).toBe('');
  });
});

describe('an unreadable manifest explains itself', () => {
  it('names the capture and the likely cause for an empty manifest', () => {
    // This is the message the user actually gets. "unexpected end of data at line 1 column 1"
    // is what it replaces.
    expect(() => parseManifest('c3', '')).toThrow(/capture c3/);
    expect(() => parseManifest('c3', '')).toThrow(/empty/);
    expect(() => parseManifest('c3', '')).toThrow(/ran out of storage/);
  });

  it('reports the byte count when the manifest is truncated rather than empty', () => {
    expect(() => parseManifest('c3', '{"captureId":"c3","pat')).toThrow(/22 bytes/);
  });

  it('still parses a whole manifest', () => {
    expect(parseManifest('c3', '{"captureId":"c3"}')).toEqual({ captureId: 'c3' });
  });
});
