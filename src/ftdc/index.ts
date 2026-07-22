/**
 * FTDC decoder -- NOT YET IMPLEMENTED (milestone M1).
 *
 * The oracle harness (M0.5) is deliberately built first, so this module starts as a stub
 * that fails loudly. `npm test` should be red until M1 lands, and green only when the
 * decoder matches MongoDB's reference implementation across every metric and every sample
 * of all fixtures.
 *
 * Before implementing, read docs/ftdc-format.md in full. The four traps in ARCHITECTURE.md are
 * each capable of producing plausible-looking but wrong output; two of them survive a
 * spot-check, which is the entire reason this harness exists.
 */

import type { DecodeOptions, DecodedChunk, FTDCMetadata } from './types.js';

export * from './types.js';

const NOT_IMPLEMENTED =
  'FTDC decoder not implemented (milestone M1). ' +
  'See docs/ftdc-format.md and ARCHITECTURE.md before starting.';

/**
 * Decode an FTDC file into a stream of chunks.
 *
 * @param bytes Raw contents of a `metrics.*` file.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars, require-yield
export function* decodeFTDC(
  _bytes: Uint8Array,
  _opts?: DecodeOptions,
): Generator<DecodedChunk> {
  throw new Error(NOT_IMPLEMENTED);
}

/** Read the type-0 metadata document, if the file has one. */
export function readMetadata(_bytes: Uint8Array): FTDCMetadata | null {
  throw new Error(NOT_IMPLEMENTED);
}
