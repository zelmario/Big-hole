/**
 * Capture ingest: decoded chunks -> columns.bin + time.bin + manifest.json.
 *
 * Streams. Memory stays bounded by one chunk (~6 MB) regardless of capture size, which is
 * what lets a multi-GB replica-set bundle land on disk without the tab going near its limit.
 */

import type { DecodedChunk, MetricType } from '../ftdc/types.js';
import type { FileStore, WritableFile } from './fileStore.js';
import {
  MANIFEST_VERSION,
  type CaptureManifest,
  type ChunkIndex,
  type Gap,
} from './types.js';

/** Paths tried, in order, when locating the sample clock. See docs/ftdc-format.md §5. */
const CLOCK_PATHS = ['start', 'serverStatus.localTime'] as const;

/** Path used to detect restarts; it goes backwards when the server has restarted. */
const UPTIME_PATH = 'serverStatus.uptimeMillis';

export interface WriteOptions {
  readonly captureId: string;
  readonly sourceFile: string;
  readonly hostname?: string;
  readonly mongoVersion?: string;
}

export interface IngestProgress {
  readonly chunks: number;
  readonly samples: number;
  readonly bytesWritten: number;
}

export class CaptureWriter {
  private readonly pathIds = new Map<string, number>();
  private readonly paths: string[] = [];
  private readonly types: MetricType[] = [];
  private readonly min: number[] = [];
  private readonly max: number[] = [];
  private readonly flat: boolean[] = [];
  private readonly firstValue: number[] = [];

  private readonly schemas: number[][] = [];
  private readonly chunks: {
    schemaId: number[];
    startMs: number[];
    sampleCount: number[];
    firstSample: number[];
    offset: number[];
    constCount: number[];
  } = {
    schemaId: [],
    startMs: [],
    sampleCount: [],
    firstSample: [],
    offset: [],
    constCount: [],
  };

  private times: Float64Array = new Float64Array(1 << 16);
  private sampleCount = 0;
  private uptimeLast = Number.NEGATIVE_INFINITY;
  private readonly restarts: number[] = [];

  private constructor(
    private readonly store: FileStore,
    private readonly opts: WriteOptions,
    private readonly columns: WritableFile,
    private readonly timeFile: WritableFile,
  ) {}

  static async create(store: FileStore, opts: WriteOptions): Promise<CaptureWriter> {
    const dir = opts.captureId;
    await store.removeDir(dir);
    const columns = await store.createWritable(`${dir}/columns.bin`);
    const timeFile = await store.createWritable(`${dir}/time.bin`);
    return new CaptureWriter(store, opts, columns, timeFile);
  }

  private internPath(path: string, type: MetricType): number {
    let id = this.pathIds.get(path);
    if (id === undefined) {
      id = this.paths.length;
      this.pathIds.set(path, id);
      this.paths.push(path);
      this.types.push(type);
      this.min.push(Number.POSITIVE_INFINITY);
      this.max.push(Number.NEGATIVE_INFINITY);
      this.flat.push(true);
      this.firstValue.push(NaN);
    }
    return id;
  }

  /** Reuse an identical column layout if we have seen it. Consecutive chunks usually match. */
  private internSchema(ids: number[]): number {
    const same = (a: number[], b: number[]): boolean => {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
      return true;
    };

    const last = this.schemas.length - 1;
    if (last >= 0 && same(this.schemas[last]!, ids)) return last;
    for (let i = 0; i < this.schemas.length; i++) if (same(this.schemas[i]!, ids)) return i;

    this.schemas.push(ids);
    return this.schemas.length - 1;
  }

  private growTimes(needed: number): void {
    if (needed <= this.times.length) return;
    let cap = this.times.length;
    while (cap < needed) cap *= 2;
    const next = new Float64Array(cap);
    next.set(this.times.subarray(0, this.sampleCount));
    this.times = next;
  }

  async addChunk(chunk: DecodedChunk): Promise<void> {
    const { keys, types, columns, sampleCount } = chunk;
    const nCols = keys.length;

    // A dotted path is NOT a unique identifier. BSON permits duplicate keys, and real
    // captures contain them: `systemMetrics.mounts./run/user.{capacity,available,free}`
    // appears twice on a host with two mounts at the same mountpoint. The decoder stays
    // faithful to the reference and emits both columns; the store has to address them
    // separately, so collisions within a chunk get an occurrence suffix.
    //
    // Like array-index paths (docs/ftdc-format.md §6), a suffixed path is only as stable as
    // document order: if the mount table is reordered between chunks, `path#1` may refer to a
    // different mount. Unavoidable without a natural key, and the same caveat applies.
    const ids = new Array<number>(nCols);
    const seen = new Map<string, number>();
    for (let i = 0; i < nCols; i++) {
      const raw = keys[i]!;
      const n = seen.get(raw) ?? 0;
      seen.set(raw, n + 1);
      ids[i] = this.internPath(n === 0 ? raw : `${raw}#${n}`, types[i]!);
    }
    const schemaId = this.internSchema(ids);

    // Sample clock. Fail loudly rather than synthesising a time axis: a wrong clock silently
    // misaligns every correlation the product exists to make.
    let clockCol = -1;
    for (const candidate of CLOCK_PATHS) {
      const idx = keys.indexOf(candidate);
      if (idx >= 0) {
        clockCol = idx;
        break;
      }
    }
    if (clockCol < 0) {
      throw new Error(
        `capture ${this.opts.captureId}: chunk at ${chunk.startMs} has no sample clock ` +
          `(tried ${CLOCK_PATHS.join(', ')})`,
      );
    }

    // Classify columns and track catalog statistics in the same pass.
    const bitmapBytes = (Math.ceil(nCols / 8) + 7) & ~7; // padded so f64 stays 8-aligned
    const bitmap = new Uint8Array(bitmapBytes);
    const varying: number[] = [];
    const constants: number[] = [];

    for (let c = 0; c < nCols; c++) {
      const col = columns[c]!;
      const first = col[0]!;

      let isConst = true;
      let lo = first;
      let hi = first;
      for (let s = 1; s < sampleCount; s++) {
        const v = col[s]!;
        if (v !== first) isConst = false;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }

      const id = ids[c]!;
      if (lo < this.min[id]!) this.min[id] = lo;
      if (hi > this.max[id]!) this.max[id] = hi;
      if (Number.isNaN(this.firstValue[id]!)) this.firstValue[id] = first;
      if (!isConst || this.firstValue[id] !== first) this.flat[id] = false;

      if (isConst) {
        bitmap[c >> 3]! |= 1 << (c & 7);
        constants.push(first);
      } else {
        varying.push(c);
      }
    }

    const blockBytes = bitmapBytes + constants.length * 8 + varying.length * sampleCount * 8;
    const block = new Uint8Array(blockBytes);
    block.set(bitmap, 0);

    const f64 = new Float64Array(block.buffer, bitmapBytes, constants.length + varying.length * sampleCount);
    for (let i = 0; i < constants.length; i++) f64[i] = constants[i]!;

    let w = constants.length;
    for (const c of varying) {
      f64.set(columns[c]!, w);
      w += sampleCount;
    }

    const offset = await this.columns.append(block);

    // Sample clock and restart detection.
    this.growTimes(this.sampleCount + sampleCount);
    this.times.set(columns[clockCol]!, this.sampleCount);

    const uptimeCol = keys.indexOf(UPTIME_PATH);
    if (uptimeCol >= 0) {
      const col = columns[uptimeCol]!;
      for (let s = 0; s < sampleCount; s++) {
        const v = col[s]!;
        // Uptime going backwards means a different process is reporting: a restart.
        if (v < this.uptimeLast) this.restarts.push(columns[clockCol]![s]!);
        this.uptimeLast = v;
      }
    }

    this.chunks.schemaId.push(schemaId);
    this.chunks.startMs.push(chunk.startMs);
    this.chunks.sampleCount.push(sampleCount);
    this.chunks.firstSample.push(this.sampleCount);
    this.chunks.offset.push(offset);
    this.chunks.constCount.push(constants.length);

    this.sampleCount += sampleCount;
  }

  get progress(): IngestProgress {
    return {
      chunks: this.chunks.offset.length,
      samples: this.sampleCount,
      bytesWritten: this.columns.size,
    };
  }

  async finish(): Promise<CaptureManifest> {
    const times = this.times.subarray(0, this.sampleCount);
    await this.timeFile.append(
      new Uint8Array(times.buffer, times.byteOffset, times.byteLength),
    );
    await this.timeFile.close();
    await this.columns.close();

    const cadenceMs = medianInterval(times);
    const gaps = detectGaps(times, cadenceMs);

    const manifest: CaptureManifest = {
      version: MANIFEST_VERSION,
      captureId: this.opts.captureId,
      sourceFile: this.opts.sourceFile,
      ...(this.opts.hostname !== undefined ? { hostname: this.opts.hostname } : {}),
      ...(this.opts.mongoVersion !== undefined ? { mongoVersion: this.opts.mongoVersion } : {}),
      sampleCount: this.sampleCount,
      startMs: this.sampleCount > 0 ? times[0]! : 0,
      endMs: this.sampleCount > 0 ? times[this.sampleCount - 1]! : 0,
      cadenceMs,
      paths: this.paths,
      types: this.types,
      min: this.min,
      max: this.max,
      flat: this.flat,
      schemas: this.schemas,
      chunks: this.chunks as ChunkIndex,
      gaps,
      restarts: this.restarts,
    };

    await this.store.writeText(
      `${this.opts.captureId}/manifest.json`,
      JSON.stringify(manifest),
    );
    return manifest;
  }
}

/**
 * Median inter-sample interval.
 *
 * Median rather than mean specifically because gaps are what we are looking for -- a few
 * multi-minute holes would drag a mean far off the real cadence and then hide themselves.
 */
export function medianInterval(times: Float64Array): number {
  if (times.length < 2) return 1000;

  // Sampling is enough: cadence is near-constant, and this runs on every ingest.
  const stride = Math.max(1, Math.floor(times.length / 4096));
  const deltas: number[] = [];
  for (let i = stride; i < times.length; i += stride) {
    const d = (times[i]! - times[i - stride]!) / stride;
    if (d > 0) deltas.push(d);
  }
  if (deltas.length === 0) return 1000;

  deltas.sort((a, b) => a - b);
  return deltas[deltas.length >> 1]!;
}

/**
 * Find holes in the sample clock.
 *
 * Missing FTDC samples mean mongod was down, stalled, or the host froze -- one of the
 * strongest signals in a capture, and nothing else surfaces it (PLAN.md §2.5).
 */
export function detectGaps(times: Float64Array, cadenceMs: number, tolerance = 3): Gap[] {
  const gaps: Gap[] = [];
  const threshold = cadenceMs * tolerance;

  for (let i = 1; i < times.length; i++) {
    const delta = times[i]! - times[i - 1]!;
    if (delta > threshold) {
      gaps.push({
        fromMs: times[i - 1]!,
        toMs: times[i]!,
        missingSamples: Math.max(0, Math.round(delta / cadenceMs) - 1),
      });
    }
  }
  return gaps;
}
