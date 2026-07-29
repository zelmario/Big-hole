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
import { ExprError, evaluate, exprPaths, parseExpr, scaleOfPath, unitOf, type Unit } from './expr.js';
import { SeriesScan, type WindowStats } from './scan.js';
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

/**
 * Read a manifest, and say something useful when it is not one.
 *
 * A bare `JSON.parse` here reports `unexpected end of data at line 1 column 1` -- the message a
 * nine-node bundle produced when the browser ran out of storage and the manifest was written as
 * zero bytes. It names neither the capture nor the cause, and it is the first thing
 * the user sees, so it is worth the six lines to answer both.
 */
export function parseManifest(captureId: string, text: string): CaptureManifest {
  try {
    return JSON.parse(text) as CaptureManifest;
  } catch {
    const what = text.length === 0 ? 'is empty' : `is not valid JSON (${text.length} bytes)`;
    throw new Error(
      `capture ${captureId}: manifest.json ${what} -- it was never written completely, which ` +
        `usually means the browser ran out of storage during ingest. Decode this node again.`,
    );
  }
}

export class CaptureReader {
  /** schemaId -> (pathId -> column index within that schema). Built lazily. */
  private readonly schemaLookup = new Map<number, Map<number, number>>();
  /** chunk index -> constant bitmap. Small (~313 B per chunk) and reused across queries. */
  private readonly bitmapCache = new Map<number, Uint8Array>();
  private readonly pathIds = new Map<string, number>();
  /** (chunk, column) -> slot index, so the popcount scan runs once per column per chunk. */
  private readonly slotCache = new Map<number, number>();

  private constructor(
    readonly manifest: CaptureManifest,
    private readonly times: Float64Array,
    private readonly columns: ReadableFile,
  ) {
    for (let i = 0; i < manifest.paths.length; i++) this.pathIds.set(manifest.paths[i]!, i);
  }

  static async open(store: FileStore, captureId: string): Promise<CaptureReader> {
    const manifest = parseManifest(captureId, await store.readText(`${captureId}/manifest.json`));

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

    // Plan every chunk read first, then issue them together. A 42-hour capture is ~500
    // chunks, and awaiting each read in turn made a single series cost ~40 ms -- the reads
    // are independent, so serialising them was pure latency.
    interface Job {
      readonly offset: number;
      readonly length: number;
      readonly isConst: boolean;
      readonly lo: number;
      readonly hi: number;
    }
    const jobs: Job[] = [];

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

      let slot = this.slotOf(c, col, isConst, bm);

      const base = m.chunks.offset[c]! + bitmapBytes;
      const constCount = m.chunks.constCount[c]!;
      const lo = Math.max(first, s0);
      const hi = Math.min(last, s1);

      if (isConst) {
        jobs.push({ offset: base + slot * 8, length: 8, isConst: true, lo, hi });
      } else {
        const colStart = base + constCount * 8 + slot * count * 8;
        jobs.push({
          offset: colStart + (lo - first) * 8,
          length: (hi - lo) * 8,
          isConst: false,
          lo,
          hi,
        });
      }
    }

    const buffers = await Promise.all(jobs.map((j) => this.columns.read(j.offset, j.length)));

    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i]!;
      const raw = buffers[i]!;
      const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
      if (job.isConst) {
        values.fill(view.getFloat64(0, true), job.lo - s0, job.hi - s0);
      } else {
        const want = job.hi - job.lo;
        for (let k = 0; k < want; k++) values[job.lo - s0 + k] = view.getFloat64(k * 8, true);
      }
    }

    return values;
  }

  /**
   * Index of a column among the like-kind (constant or varying) columns before it.
   *
   * Cached per (chunk, column): the popcount scan is cheap but runs once per chunk per
   * series, and a dashboard re-reads the same columns on every zoom.
   */
  private slotOf(chunk: number, col: number, isConst: boolean, bm: Uint8Array): number {
    const key = chunk * 100_000 + col;
    const hit = this.slotCache.get(key);
    if (hit !== undefined) return hit;

    let slot = 0;
    for (let i = 0; i < col; i++) {
      if (((bm[i >> 3]! & (1 << (i & 7))) !== 0) === isConst) slot++;
    }
    this.slotCache.set(key, slot);
    return slot;
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

  /**
   * What every metric did over one window, in a single pass.
   *
   * Chunk-major storage is what makes this affordable: the columns for a window sit together,
   * so the whole window is a handful of positioned reads regardless of how many metrics it
   * covers. Reading the same thing series by series would be one read per chunk per metric --
   * five thousand times the round trips for the same bytes.
   *
   * Deliberately bounded by `maxSamples` rather than being clever about wide windows. The cost
   * is linear in the window's duration and this reads FULL resolution, which is the point:
   * downsampling first would hide the short excursions the ranking is looking for. A window
   * wider than the cap is refused by name so the caller can say "narrow it" instead of freezing
   * the tab for twenty seconds.
   */
  async scan(
    query: SeriesQuery & { readonly maxSamples?: number } = {},
  ): Promise<Map<string, WindowStats>> {
    const m = this.manifest;
    const s0 = this.lowerBound(query.from ?? m.startMs);
    const s1 = this.lowerBound((query.to ?? m.endMs) + 1);

    const out = new Map<string, WindowStats>();
    if (s1 <= s0) return out;

    const cap = query.maxSamples ?? Number.POSITIVE_INFINITY;
    if (s1 - s0 > cap) {
      throw new ExprError(
        `window covers ${(s1 - s0).toLocaleString()} samples, more than the ${cap.toLocaleString()} a scan reads`,
      );
    }

    // A delta may not span a hole in the capture: the collector stopping is not evidence about
    // what the metric did while it was stopped.
    const maxGapMs = Math.max(m.cadenceMs * 4, 5000);
    const scans = new Map<number, SeriesScan>();
    const factors = new Map<number, number>();

    const nChunks = m.chunks.offset.length;
    for (let c = 0; c < nChunks; c++) {
      const first = m.chunks.firstSample[c]!;
      const count = m.chunks.sampleCount[c]!;
      const last = first + count;
      if (last <= s0 || first >= s1) continue;

      const schema = m.schemas[m.chunks.schemaId[c]!]!;
      const bitmapBytes = (Math.ceil(schema.length / 8) + 7) & ~7;
      const constCount = m.chunks.constCount[c]!;
      const varyingCount = schema.length - constCount;
      const blockBytes = bitmapBytes + constCount * 8 + varyingCount * count * 8;

      const raw = await this.columns.read(m.chunks.offset[c]!, blockBytes);
      // A Float64Array view needs 8-byte alignment and the backend may hand back a view at any
      // offset. Copying a whole chunk is one memcpy of a few MB; reading it a value at a time
      // through a DataView instead costs a call per value, and there are 100M of them.
      const block = (raw.byteOffset & 7) === 0 ? raw : new Uint8Array(raw);
      const values = new Float64Array(
        block.buffer,
        block.byteOffset + bitmapBytes,
        constCount + varyingCount * count,
      );

      const lo = Math.max(first, s0);
      const hi = Math.min(last, s1);

      let constSlot = 0;
      let varSlot = 0;
      for (let col = 0; col < schema.length; col++) {
        const pathId = schema[col]!;
        const isConst = (block[col >> 3]! & (1 << (col & 7))) !== 0;

        let scan = scans.get(pathId);
        if (scan === undefined) {
          scan = new SeriesScan(maxGapMs);
          scans.set(pathId, scan);
          // Same normalisation getSeries applies, so a scanned value and a charted value are
          // the same number -- mem.resident in bytes, not in MiB.
          factors.set(pathId, scaleOfPath(m.paths[pathId]!));
        }
        const factor = factors.get(pathId)!;

        if (isConst) {
          scan.run(values[constSlot]! * factor, this.times[lo]!, this.times[hi - 1]!, hi - lo);
          constSlot++;
        } else {
          const base = constCount + varSlot * count - first;
          for (let i = lo; i < hi; i++) scan.push(this.times[i]!, values[base + i]! * factor);
          varSlot++;
        }
      }
    }

    for (const [pathId, scan] of scans) out.set(m.paths[pathId]!, scan.result());
    return out;
  }

  /** BSON type the column was decoded from, or undefined for a path this capture lacks. */
  typeOf(path: string): MetricType | undefined {
    const id = this.pathIds.get(path);
    return id === undefined ? undefined : this.manifest.types[id];
  }

  /** Whole-capture range of a path, normalised like its values. Zero for a metric that never moved. */
  rangeOf(path: string): number {
    const id = this.pathIds.get(path);
    if (id === undefined) return NaN;
    const factor = scaleOfPath(path);
    return (this.manifest.max[id]! - this.manifest.min[id]!) * factor;
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
