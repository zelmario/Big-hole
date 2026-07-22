/**
 * Chunk payload decoding: inflate output -> per-column series.
 *
 * Performance rules (ARCHITECTURE.md, docs/ftdc-format.md CORRECTION 3): no BigInt, no allocation
 * inside the sample loop, varints read straight out of the Uint8Array, and zero runs
 * collapsed to TypedArray.fill. A node-day is ~216M values; this loop is the product's floor.
 */

import { f64FromBits, readInt32LE, readUint32LE } from './bson.js';
import { flattenReference } from './flatten.js';
import { FTDCFormatError, type DecodedChunk } from './types.js';

const enum Kind {
  Wide = 0, // int64 / datetime
  Int32 = 1,
  Double = 2,
  Bool = 3,
}

const KIND: Record<string, Kind> = {
  int64: Kind.Wide,
  datetime: Kind.Wide,
  int32: Kind.Int32,
  double: Kind.Double,
  bool: Kind.Bool,
};

/**
 * Convert an exact int64 accumulator, held as unsigned 32-bit halves, into the value the
 * column's declared type actually carries.
 *
 * Mirrors restoreFlat (bson_restore.go:100-115). Matching it matters: FTDC stores every
 * metric as int64 regardless of declared BSON type, and some columns overflow their declared
 * width -- `wiredTiger.transaction.transaction range of timestamps currently pinned` is
 * declared Int32 but carries a 64-bit WiredTiger timestamp, so the reference truncates it to
 * its low 32 bits. Every FTDC tool in the ecosystem reports that truncated value; diverging
 * would make our charts disagree with MongoDB's own tooling on identical bytes.
 *
 * Each case reads straight off the halves, so all four are exact and none needs a modulo.
 */
function convert(kind: Kind, hi: number, lo: number): number {
  switch (kind) {
    case Kind.Int32:
      return lo | 0; // int32(value): low 32 bits, sign-extended
    case Kind.Bool:
      return hi !== 0 || lo !== 0 ? 1 : 0;
    case Kind.Double:
      return f64FromBits(hi, lo);
    default:
      // Single correctly-rounded conversion of the exact int64. See the precision note in
      // docs/ftdc-format.md CORRECTION 3: values above 2^53 (WiredTiger timestamps) are
      // rounded to the nearest double, exactly as the reference's own int64->JSON->float
      // path rounds them. Accumulating in double instead would compound per-sample error.
      return (hi >= 0x80000000 ? hi - 0x100000000 : hi) * 0x100000000 + lo;
  }
}

/**
 * Decode one inflated chunk payload.
 *
 * Layout: [reference BSON document][uint32 metricsCount][uint32 deltaCount][varint deltas].
 * The counts follow the reference document, not precede it.
 */
export function decodeChunkPayload(b: Uint8Array, startMs: number): DecodedChunk {
  const refLen = readInt32LE(b, 0);
  if (refLen <= 0 || refLen + 8 > b.length) {
    throw new FTDCFormatError(
      `chunk: reference document length ${refLen} does not fit in ${b.length} bytes`,
    );
  }

  const schema = flattenReference(b, 0);
  const nmetrics = readUint32LE(b, refLen);
  const ndeltas = readUint32LE(b, refLen + 4);

  // The cheapest corruption detector there is, and it catches a mis-flattened Timestamp
  // (CORRECTION 2) on the very first chunk instead of via wrong-looking charts.
  if (nmetrics !== schema.keys.length) {
    throw new FTDCFormatError(
      `chunk: metricsCount mismatch -- file says ${nmetrics}, flattening produced ` +
        `${schema.keys.length}. The reference document walk is wrong (likely a BSON type ` +
        `emitting the wrong number of columns).`,
    );
  }

  const nSamples = ndeltas + 1;
  const columns: Float64Array[] = new Array<Float64Array>(nmetrics);
  const { types, startHi, startLo } = schema;

  let p = refLen + 8;
  // Zero-run state is intentionally declared OUTSIDE the column loop: a run started near
  // the end of one column continues into the next without consuming any bytes
  // (CORRECTION 4). Resetting this per column silently corrupts idle captures.
  let nzeroes = 0;

  for (let m = 0; m < nmetrics; m++) {
    const out = new Float64Array(nSamples);
    const kind = KIND[types[m]!] ?? Kind.Wide;

    // The accumulator stays an exact int64 in two halves for every column type, not just
    // doubles. Accumulating in double would round once per sample and drift a full ULP
    // away from the reference on WiredTiger timestamp columns.
    let accHi = startHi[m]!;
    let accLo = startLo[m]!;
    let cur = convert(kind, accHi, accLo);

    out[0] = cur;

    let j = 0;
    while (j < ndeltas) {
      if (nzeroes > 0) {
        // A zero delta means the value is unchanged, so the whole run is one memset.
        const avail = ndeltas - j;
        const run = nzeroes < avail ? nzeroes : avail;
        out.fill(cur, j + 1, j + 1 + run);
        nzeroes -= run;
        j += run;
        continue;
      }

      // Inlined LEB128 read into 32-bit halves. Deltas are unsigned varints holding
      // two's-complement-wrapped int64 -- there is no zigzag encoding.
      let dLo = 0;
      let dHi = 0;
      let shift = 0;
      let byte = 0;
      do {
        byte = b[p++]!;
        if (shift < 28) dLo |= (byte & 0x7f) << shift;
        else if (shift === 28) {
          dLo |= (byte & 0x0f) << 28;
          dHi = (byte & 0x7f) >>> 4;
        } else dHi |= (byte & 0x7f) << (shift - 32);
        shift += 7;
      } while (byte >= 0x80);
      dLo >>>= 0;
      dHi >>>= 0;

      if (dLo === 0 && dHi === 0) {
        // A literal zero delta, followed by a varint counting ADDITIONAL zeros.
        out[j + 1] = cur;
        j++;

        let run = 0;
        let mul = 1;
        do {
          byte = b[p++]!;
          run += (byte & 0x7f) * mul;
          mul *= 128;
        } while (byte >= 0x80);
        nzeroes = run;
        continue;
      }

      // Exact 64-bit add with explicit carry. Wrapping is intended: a negative delta
      // arrives as its two's-complement bit pattern and wraps back to the right value.
      const sum = accLo + dLo;
      accLo = sum >>> 0;
      accHi = (accHi + dHi + (sum > 0xffffffff ? 1 : 0)) >>> 0;

      cur = convert(kind, accHi, accLo);
      out[j + 1] = cur;
      j++;
    }

    columns[m] = out;
  }

  return {
    keys: schema.keys,
    types: schema.types,
    columns,
    sampleCount: nSamples,
    startMs,
  };
}
