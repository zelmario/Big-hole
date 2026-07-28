/**
 * On-disk capture format.
 *
 * Three files per capture:
 *
 *   manifest.json   paths, schemas, per-chunk index, gaps, restarts
 *   time.bin        one contiguous Float64 sample clock for the whole capture
 *   columns.bin     per-chunk column blocks
 *
 * A chunk block in columns.bin is laid out as:
 *
 *   [constant bitmap, ceil(nCols/8) bytes, padded to 8]
 *   [constant values, 8 bytes each, in column order]
 *   [varying columns, 8 bytes x sampleCount each, in column order]
 *
 * Constant-column elision is the reason this fits: a column whose value never moves within a
 * chunk costs 8 bytes instead of sampleCount x 8. On an idle server -- the common case in
 * support work, where a whole retention window arrives for a ten-minute
 * incident -- that is most of the file.
 *
 * Chunk-major rather than path-major is deliberate. It lets ingest stream: decode a chunk,
 * write it, drop it, with memory bounded by one chunk rather than by the capture. Reading one
 * metric costs one small positioned read per chunk, which on a local file is microseconds.
 */

import type { MetricType } from '../ftdc/types.js';

export const MANIFEST_VERSION = 1;

/**
 * Per-chunk index, stored as parallel arrays rather than an array of objects -- at a few
 * thousand chunks per capture the JSON is several times smaller and parses faster.
 */
export interface ChunkIndex {
  /** Index into `schemas` for this chunk's column layout. */
  readonly schemaId: number[];
  /** Chunk start time in epoch ms, from the chunk document's `_id`. */
  readonly startMs: number[];
  readonly sampleCount: number[];
  /** Global index of this chunk's first sample. */
  readonly firstSample: number[];
  /** Byte offset of the chunk block in columns.bin. */
  readonly offset: number[];
  /** Number of elided constant columns in this chunk. */
  readonly constCount: number[];
}

export interface Gap {
  /** Last sample time before the gap. */
  readonly fromMs: number;
  /** First sample time after the gap. */
  readonly toMs: number;
  /** Samples that should have been present, given the capture's cadence. */
  readonly missingSamples: number;
}

export interface CaptureManifest {
  readonly version: typeof MANIFEST_VERSION;
  readonly captureId: string;
  readonly sourceFile: string;
  readonly hostname?: string;
  readonly mongoVersion?: string;

  readonly sampleCount: number;
  readonly startMs: number;
  readonly endMs: number;
  /** Median inter-sample interval in ms; the basis for gap detection. */
  readonly cadenceMs: number;

  /** Global metric catalog. Index into these arrays is a pathId. */
  readonly paths: string[];
  readonly types: MetricType[];
  /** Per path, min/max across the whole capture. Powers catalog previews without I/O. */
  readonly min: number[];
  readonly max: number[];
  /**
   * Per path: true when the value never changed anywhere in the capture. Lets the metric
   * catalog hide the large fraction of FTDC that is structurally flat.
   */
  readonly flat: boolean[];

  /** schemaId -> ordered pathIds. Chunks reference these, so a repeated layout costs nothing. */
  readonly schemas: number[][];
  readonly chunks: ChunkIndex;

  readonly gaps: Gap[];
  /** Sample times at which the server appears to have restarted (uptime went backwards). */
  readonly restarts: number[];
}

/** A series as returned to a panel: either raw samples or a per-bucket envelope. */
export interface Series {
  readonly path: string;
  readonly t: Float64Array;
  /** Bucket minimum, or the raw value when `raw` is true. */
  readonly min: Float64Array;
  readonly max: Float64Array;
  readonly mean: Float64Array;
  /** True when no downsampling was applied and min === max === mean === the sample value. */
  readonly raw: boolean;
}
