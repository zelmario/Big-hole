/**
 * Public contract for the FTDC decoder.
 *
 * This module must stay DOM-free (no `window`, no `File`, no worker APIs) so that
 * `src/ftdc/` can be extracted as a standalone npm package and run under Node. See
 * ARCHITECTURE.md.
 */

/** BSON type a column was derived from, as recorded in the chunk's reference document. */
export type MetricType = 'double' | 'int32' | 'int64' | 'bool' | 'datetime';

export interface DecodedChunk {
  /**
   * Dotted metric paths in flatten order. This order is not cosmetic: it defines the
   * column order of the delta block, so a decoder that produces correct values under a
   * different order is wrong. See docs/ftdc-format.md §3.
   */
  readonly keys: readonly string[];

  /**
   * Per-column source BSON type, positionally aligned with `keys`. Required for correct
   * restoration -- `double` columns are delta-encoded as IEEE-754 bit patterns and must be
   * reinterpreted (docs/ftdc-format.md CORRECTION 1).
   */
  readonly types: readonly MetricType[];

  /**
   * Column-major series. `columns[i]` is the full series for `keys[i]` and has length
   * `sampleCount`.
   *
   * Values are fully restored: `double` columns have already been passed through
   * Float64frombits, `datetime` columns are epoch milliseconds. Integer columns are exact
   * while |value| < 2^53, which holds for every realistic FTDC metric.
   */
  readonly columns: readonly Float64Array[];

  /** Number of samples in this chunk: deltaCount + 1. */
  readonly sampleCount: number;

  /** Chunk start time, taken from the chunk document's `_id`, in epoch milliseconds. */
  readonly startMs: number;
}

export interface FTDCMetadata {
  /** The decoded type-0 document, as-is. */
  readonly doc: Readonly<Record<string, unknown>>;
  readonly hostname?: string;
  readonly version?: string;
}

export interface DecodeOptions {
  /** Stop after this many chunks. Used by previews and benchmarks. */
  readonly maxChunks?: number;

  /**
   * Tolerate a truncated trailing chunk instead of throwing. Normal for `metrics.interim`,
   * which mongod is actively appending to. Defaults to true.
   */
  readonly tolerateTruncatedTail?: boolean;
}

/** Thrown when a chunk is structurally invalid in a way that indicates a decoder bug. */
export class FTDCFormatError extends Error {
  override readonly name = 'FTDCFormatError';
}
