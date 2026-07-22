/**
 * Capture reads.
 *
 * Resident memory is a function of what is on screen, not of capture size: the manifest and
 * the sample clock stay in memory (a few MB), everything else is read from columns.bin on
 * demand and dropped.
 *
 * The API is async by design. Making it synchronous "for now" would force a rewrite of every
 * panel later (ARCHITECTURE.md).
 */

import type { MetricType } from '../ftdc/types.js';
import type { FileStore, ReadableFile } from './fileStore.js';
import { envelope } from './downsample.js';
import { ExprError, evaluate, exprPaths, parseExpr, unitOf, type Unit } from './expr.js';
import type { CaptureManifest, Gap, Series } from './types.js';

export interface SeriesQuery {
  /** Inclusive lower bound in epoch ms. Defaults to the start of the capture. */
  readonly from?: number;
  /** Inclusive upper bound in epoch ms. Defaults to the end of the capture. */
  readonly to?: number;
  /** Target point count. Omit or pass 0 to get full resolution. */
  readonly maxPoints?: number;
}

export interface CatalogEntry {
  readonly path: string;
  readonly type: MetricType;
  readonly min: number;
  readonly max: number;
  /** True when the value never changes anywhere in the capture. */
  readonly flat: boolean;
}

export class CaptureReader {
  /** schemaId -> (pathId -> column index within that schema). Built lazily. */
  private readonly schemaLookup = new Map<number, Map<number, number>>();
  /** chunk index -> constant bitmap. Small (~313 B per chunk) and reused across queries. */
  private readonly bitmapCache = new Map<number, Uint8Array>();
  private readonly pathIds = new Map<string, number>();

  private constructor(
    readonly manifest: CaptureManifest,
    private readonly times: Float64Array,
    private readonly columns: ReadableFile,
  ) {
    for (let i = 0; i < manifest.paths.length; i++) this.pathIds.set(manifest.paths[i]!, i);
  }

  static async open(store: FileStore, captureId: string): Promise<CaptureReader> {
    const manifest = JSON.parse(
      await store.readText(`${captureId}/manifest.json`),
    ) as CaptureManifest;

    const timeFile = await store.openReadable(`${captureId}/time.bin`);
    let times: Float64Array;
    try {
      const raw = await timeFile.read(0, timeFile.size);
      // Copy into an aligned buffer: the backend may hand back a view at any offset.
      times = new Float64Array(raw.byteLength / 8);
      new Uint8Array(times.buffer).set(raw);
    } finally {
      await timeFile.close();
    }

    const columns = await store.openReadable(`${captureId}/columns.bin`);
    return new CaptureReader(manifest, times, columns);
  }

  async close(): Promise<void> {
    await this.columns.close();
  }

  get catalog(): CatalogEntry[] {
    const m = this.manifest;
    return m.paths.map((path, i) => ({
      path,
      type: m.types[i]!,
      min: m.min[i]!,
      max: m.max[i]!,
      flat: m.flat[i]!,
    }));
  }

  get gaps(): readonly Gap[] {
    return this.manifest.gaps;
  }

  get restarts(): readonly number[] {
    return this.manifest.restarts;
  }

  private lookup(schemaId: number): Map<number, number> {
    let map = this.schemaLookup.get(schemaId);
    if (map === undefined) {
      map = new Map();
      const schema = this.manifest.schemas[schemaId]!;
      for (let i = 0; i < schema.length; i++) map.set(schema[i]!, i);
      this.schemaLookup.set(schemaId, map);
    }
    return map;
  }

  private async bitmap(chunk: number): Promise<Uint8Array> {
    let bm = this.bitmapCache.get(chunk);
    if (bm === undefined) {
      const schema = this.manifest.schemas[this.manifest.chunks.schemaId[chunk]!]!;
      const bytes = (Math.ceil(schema.length / 8) + 7) & ~7;
      bm = await this.columns.read(this.manifest.chunks.offset[chunk]!, bytes);
      this.bitmapCache.set(chunk, bm);
    }
    return bm;
  }

  /** First sample index with time >= ms. */
  private lowerBound(ms: number): number {
    let lo = 0;
    let hi = this.times.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.times[mid]! < ms) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /**
   * Read one raw metric's values over a global sample range.
   *
   * Samples the metric is absent for -- because its chunk's schema did not contain it -- come
   * back as NaN rather than being dropped or forward-filled. Merging is by path, never by
   * column index, so a schema change mid-capture does not shift a series onto another metric.
   */
  private async readRaw(path: string, s0: number, s1: number): Promise<Float64Array> {
    const pathId = this.pathIds.get(path);
    if (pathId === undefined) throw new ExprError(`unknown metric path: ${path}`);

    const m = this.manifest;
    const n = Math.max(0, s1 - s0);
    const values = new Float64Array(n).fill(NaN);

    const nChunks = m.chunks.offset.length;
    for (let c = 0; c < nChunks; c++) {
      const first = m.chunks.firstSample[c]!;
      const count = m.chunks.sampleCount[c]!;
      const last = first + count;
      if (last <= s0 || first >= s1) continue;

      const schemaId = m.chunks.schemaId[c]!;
      const col = this.lookup(schemaId).get(pathId);
      if (col === undefined) continue; // absent from this chunk -> stays NaN

      const schema = m.schemas[schemaId]!;
      const bitmapBytes = (Math.ceil(schema.length / 8) + 7) & ~7;
      const bm = await this.bitmap(c);
      const isConst = (bm[col >> 3]! & (1 << (col & 7))) !== 0;

      // Slot index = how many like-kind columns precede this one.
      let slot = 0;
      for (let i = 0; i < col; i++) {
        const bit = (bm[i >> 3]! & (1 << (i & 7))) !== 0;
        if (bit === isConst) slot++;
      }

      const base = m.chunks.offset[c]! + bitmapBytes;
      const constCount = m.chunks.constCount[c]!;

      // Overlap of this chunk with the requested range.
      const lo = Math.max(first, s0);
      const hi = Math.min(last, s1);

      if (isConst) {
        const raw = await this.columns.read(base + slot * 8, 8);
        const v = new DataView(raw.buffer, raw.byteOffset, 8).getFloat64(0, true);
        values.fill(v, lo - s0, hi - s0);
      } else {
        const colStart = base + constCount * 8 + slot * count * 8;
        const offInChunk = lo - first;
        const want = hi - lo;
        const raw = await this.columns.read(colStart + offInChunk * 8, want * 8);
        const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
        for (let i = 0; i < want; i++) {
          values[lo - s0 + i] = view.getFloat64(i * 8, true);
        }
      }
    }

    return values;
  }

  /**
   * Evaluate an expression over a time range.
   *
   * `expression` is either a bare metric path or a derived expression such as
   * `rate(serverStatus.opcounters.query)` -- see src/data/expr.ts. Most of FTDC is cumulative
   * counters, so raw values are frequently not what anyone wants to look at.
   *
   * Derivation happens at FULL resolution and downsampling comes after. Computing a rate from
   * already-bucketed means would smear exactly the short spikes the min/max envelope exists to
   * preserve.
   */
  async getSeries(expression: string, query: SeriesQuery = {}): Promise<Series> {
    const expr = parseExpr(expression);
    const m = this.manifest;

    const s0 = this.lowerBound(query.from ?? m.startMs);
    const s1 = this.lowerBound((query.to ?? m.endMs) + 1);
    const t = this.times.subarray(s0, s1);

    const raw = new Map<string, Float64Array>();
    for (const path of new Set(exprPaths(expr))) {
      raw.set(path, await this.readRaw(path, s0, s1));
    }

    return envelope(expression, t, evaluate(expr, t, raw), query.maxPoints ?? 0);
  }

  /** Unit implied by an expression, used to format axes and legend values. */
  unitFor(expression: string): Unit {
    try {
      return unitOf(parseExpr(expression));
    } catch {
      return 'count';
    }
  }

  /** True when every metric an expression needs is present in this capture. */
  has(expression: string): boolean {
    try {
      return exprPaths(parseExpr(expression)).every((p) => this.pathIds.has(p));
    } catch {
      return false;
    }
  }
}
