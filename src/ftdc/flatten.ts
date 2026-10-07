/**
 * Flatten a chunk's reference document into ordered metric columns.
 *
 * The traversal order produced here IS the column order of the delta block. It is not
 * cosmetic and it is not negotiable -- see docs/ftdc-format.md §3. Two rules are easy to get
 * wrong and both are silent:
 *
 *   - BSON Timestamp emits TWO columns (`key` and `key.inc`). Miss it and every subsequent
 *     column is attributed to the wrong metric (CORRECTION 2).
 *   - String, ObjectId and Decimal128 emit ZERO columns. So does anything else not listed.
 */

import {
  BsonType,
  cstringEnd,
  f64FromBits,
  int64FromDouble,
  readCString,
  readInt32LE,
  readUint32LE,
  toHiLo,
  valueSize,
} from './bson.js';
import type { MetricType } from './types.js';

export interface FlatSchema {
  readonly keys: string[];
  readonly types: MetricType[];
  /** 1 when the column is a Double and needs bit-pattern accumulation. */
  readonly isDouble: Uint8Array;
  /** Starting value per column, as unsigned two's-complement int64 halves. */
  readonly startHi: Uint32Array;
  readonly startLo: Uint32Array;
}

class Builder {
  readonly keys: string[] = [];
  readonly types: MetricType[] = [];
  private readonly dbl: number[] = [];
  private readonly hi: number[] = [];
  private readonly lo: number[] = [];

  push(key: string, type: MetricType, hi: number, lo: number): void {
    this.keys.push(key);
    this.types.push(type);
    this.dbl.push(type === 'double' ? 1 : 0);
    this.hi.push(hi);
    this.lo.push(lo);
  }

  pushNumber(key: string, type: MetricType, v: number): void {
    const { hi, lo } = toHiLo(v);
    this.push(key, type, hi, lo);
  }

  finish(): FlatSchema {
    return {
      keys: this.keys,
      types: this.types,
      isDouble: Uint8Array.from(this.dbl),
      startHi: Uint32Array.from(this.hi),
      startLo: Uint32Array.from(this.lo),
    };
  }
}

function walkValue(b: Uint8Array, type: number, p: number, key: string, out: Builder): void {
  switch (type) {
    case BsonType.Double:
      // mongod truncates a Double to int64 when it builds the metrics array, so the starting
      // value is the *numeric* value and the deltas are ordinary value deltas. It does not
      // store the IEEE-754 bit pattern.
      //
      // docs/ftdc-format.md CORRECTION 1 once said the opposite, citing `normalizeFloat` in
      // github.com/mongodb/ftdc. That function belongs to the Go library's own *writer*; it
      // describes files that library produces, not the ones mongod produces. Applying it to a
      // real capture leaves every Double column frozen: the deltas land in the mantissa's low
      // bits, so the value only moves by an ULP per sample and snaps back to the truth at each
      // chunk boundary, where the reference document restores it. serverStatus.uptime reads
      // flat at 29 while uptimeMillis, an int64 in the same document, counts correctly.
      //
      // Verified on sample-data/demo: read this way, uptime advances by exactly 1 per second
      // and systemMetrics.cpu.user_ms by 660-4400 ms/s on an 8-core host under load. The rule
      // itself is mongod's extractMetricsFromDocument; int64FromDouble has the edge cases.
      {
        const { hi, lo } = int64FromDouble(f64FromBits(readUint32LE(b, p + 4), readUint32LE(b, p)));
        out.push(key, 'double', hi, lo);
      }
      return;

    case BsonType.Int32:
      // int64(int32) -- sign-extended, so negatives must reach toHiLo as negatives.
      out.pushNumber(key, 'int32', readInt32LE(b, p));
      return;

    case BsonType.Int64:
      out.push(key, 'int64', readInt32LE(b, p + 4) >>> 0, readUint32LE(b, p));
      return;

    case BsonType.DateTime:
      out.push(key, 'datetime', readInt32LE(b, p + 4) >>> 0, readUint32LE(b, p));
      return;

    case BsonType.Boolean:
      out.pushNumber(key, 'bool', b[p] === 1 ? 1 : 0);
      return;

    case BsonType.Timestamp:
      // Two columns. Low 4 bytes are the increment, high 4 the seconds; the seconds column
      // is scaled to milliseconds, matching bson_metric.go:123-138.
      out.pushNumber(key, 'int64', readUint32LE(b, p + 4) * 1000);
      out.pushNumber(`${key}.inc`, 'int64', readUint32LE(b, p));
      return;

    case BsonType.Document:
      walkDocument(b, p, key, out);
      return;

    case BsonType.Array:
      walkArray(b, p, key, out);
      return;

    default:
      // String, ObjectId, Decimal128, Null, Binary, Regex, ... contribute no columns.
      return;
  }
}

function walkDocument(b: Uint8Array, start: number, prefix: string, out: Builder): void {
  const end = start + readInt32LE(b, start);
  let p = start + 4;

  while (p < end - 1) {
    const type = b[p]!;
    p++;
    const key = readCString(b, p);
    p = cstringEnd;
    const size = valueSize(b, type, p);
    walkValue(b, type, p, prefix ? `${prefix}.${key}` : key, out);
    p += size;
  }
}

/**
 * Array elements are keyed by position, not by their BSON element names, and the index is
 * appended to the array's own key: `members` -> `members.0`, `members.1`. Matches
 * metricForArray in bson_metric.go:27-41.
 */
function walkArray(b: Uint8Array, start: number, key: string, out: Builder): void {
  const end = start + readInt32LE(b, start);
  let p = start + 4;
  let idx = 0;

  while (p < end - 1) {
    const type = b[p]!;
    p++;
    readCString(b, p);
    p = cstringEnd;
    const size = valueSize(b, type, p);
    walkValue(b, type, p, `${key}.${idx}`, out);
    p += size;
    idx++;
  }
}

/** Flatten a reference document starting at `start` into ordered metric columns. */
export function flattenReference(b: Uint8Array, start: number): FlatSchema {
  const out = new Builder();
  walkDocument(b, start, '', out);
  return out.finish();
}
