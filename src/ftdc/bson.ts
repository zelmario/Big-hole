/**
 * Minimal BSON reader.
 *
 * Only what FTDC needs: enough to walk a document's elements, skip values by type, and
 * materialise the (small, once-per-file) metadata document. Deliberately not a
 * general-purpose BSON library -- the reference document is walked once per chunk and the
 * skip table has to be exhaustive, but nothing here needs to allocate per sample.
 *
 * DOM-free by design (see ARCHITECTURE.md): takes Uint8Array, returns plain data.
 */

export const enum BsonType {
  Double = 0x01,
  String = 0x02,
  Document = 0x03,
  Array = 0x04,
  Binary = 0x05,
  Undefined = 0x06,
  ObjectId = 0x07,
  Boolean = 0x08,
  DateTime = 0x09,
  Null = 0x0a,
  Regex = 0x0b,
  DbPointer = 0x0c,
  JavaScript = 0x0d,
  Symbol = 0x0e,
  CodeWithScope = 0x0f,
  Int32 = 0x10,
  Timestamp = 0x11,
  Int64 = 0x12,
  Decimal128 = 0x13,
  MinKey = 0xff,
  MaxKey = 0x7f,
}

export function readInt32LE(b: Uint8Array, p: number): number {
  return (b[p]! | (b[p + 1]! << 8) | (b[p + 2]! << 16) | (b[p + 3]! << 24)) | 0;
}

export function readUint32LE(b: Uint8Array, p: number): number {
  return (
    (b[p]! | (b[p + 1]! << 8) | (b[p + 2]! << 16) | (b[p + 3]! << 24)) >>> 0
  );
}

/**
 * Read a signed 64-bit little-endian value as a JS number.
 *
 * Exact while |value| < 2^53, which holds for every realistic FTDC integer (epoch ms are
 * ~1.7e12; a byte counter would need to reach 9 petabytes). Not valid for Double bit
 * patterns -- those keep their hi/lo halves, see docs/ftdc-format.md CORRECTION 1.
 */
export function readInt64LE(b: Uint8Array, p: number): number {
  const lo = readUint32LE(b, p);
  const hi = readInt32LE(b, p + 4);
  return hi * 0x100000000 + lo;
}

/** Split an integral JS number into unsigned two's-complement 32-bit halves. */
export function toHiLo(v: number): { hi: number; lo: number } {
  const hi = Math.floor(v / 0x100000000);
  const lo = v - hi * 0x100000000;
  return { hi: hi >>> 0, lo: lo >>> 0 };
}

const _bits = new DataView(new ArrayBuffer(8));

/** Reinterpret unsigned 32-bit halves of an int64 as an IEEE-754 double. */
export function f64FromBits(hi: number, lo: number): number {
  _bits.setUint32(0, lo, true);
  _bits.setUint32(4, hi, true);
  return _bits.getFloat64(0, true);
}

/** End offset of the most recent readCString call. */
export let cstringEnd = 0;

const decoder = new TextDecoder('utf-8');

/**
 * Read a NUL-terminated key. Fast-pathed for ASCII, which every FTDC metric name is;
 * falls back to TextDecoder otherwise.
 */
export function readCString(b: Uint8Array, p: number): string {
  let end = p;
  while (b[end] !== 0) end++;

  const len = end - p;
  let ascii = true;
  for (let i = p; i < end; i++) {
    if (b[i]! >= 0x80) {
      ascii = false;
      break;
    }
  }

  cstringEnd = end + 1;

  if (!ascii) return decoder.decode(b.subarray(p, end));

  // fromCharCode.apply is faster than building char by char, but blows the stack on long
  // input; metric names are short so the threshold is never hit in practice.
  if (len < 1024) {
    let s = '';
    for (let i = p; i < end; i++) s += String.fromCharCode(b[i]!);
    return s;
  }
  return decoder.decode(b.subarray(p, end));
}

/**
 * Byte length of a BSON value of the given type starting at `p`.
 * Throws on unknown types rather than guessing -- a wrong skip silently desynchronises the
 * whole document walk.
 */
export function valueSize(b: Uint8Array, type: number, p: number): number {
  switch (type) {
    case BsonType.Double:
    case BsonType.DateTime:
    case BsonType.Timestamp:
    case BsonType.Int64:
      return 8;
    case BsonType.Int32:
      return 4;
    case BsonType.Boolean:
      return 1;
    case BsonType.ObjectId:
      return 12;
    case BsonType.Decimal128:
      return 16;
    case BsonType.Null:
    case BsonType.Undefined:
    case BsonType.MinKey:
    case BsonType.MaxKey:
      return 0;
    case BsonType.String:
    case BsonType.JavaScript:
    case BsonType.Symbol:
      return 4 + readInt32LE(b, p);
    case BsonType.Document:
    case BsonType.Array:
    case BsonType.CodeWithScope:
      return readInt32LE(b, p);
    case BsonType.Binary:
      return 5 + readInt32LE(b, p);
    case BsonType.DbPointer:
      return 4 + readInt32LE(b, p) + 12;
    case BsonType.Regex: {
      let q = p;
      while (b[q] !== 0) q++;
      q++;
      while (b[q] !== 0) q++;
      q++;
      return q - p;
    }
    default:
      throw new Error(`bson: unknown element type 0x${type.toString(16)} at offset ${p}`);
  }
}

/**
 * Materialise a document as a plain object. Used only for the type-0 metadata document and
 * for locating fields in chunk envelopes -- never on the per-sample path.
 */
export function readDocument(b: Uint8Array, start: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const end = start + readInt32LE(b, start);
  let p = start + 4;

  while (p < end - 1) {
    const type = b[p]!;
    p++;
    const key = readCString(b, p);
    p = cstringEnd;
    const size = valueSize(b, type, p);
    out[key] = readValue(b, type, p, size);
    p += size;
  }
  return out;
}

function readValue(b: Uint8Array, type: number, p: number, size: number): unknown {
  switch (type) {
    case BsonType.Double:
      return f64FromBits(readUint32LE(b, p + 4), readUint32LE(b, p));
    case BsonType.String:
    case BsonType.JavaScript:
    case BsonType.Symbol:
      return decoder.decode(b.subarray(p + 4, p + size - 1));
    case BsonType.Document:
      return readDocument(b, p);
    case BsonType.Array: {
      const doc = readDocument(b, p);
      return Object.values(doc);
    }
    case BsonType.Boolean:
      return b[p] === 1;
    case BsonType.Int32:
      return readInt32LE(b, p);
    case BsonType.Int64:
    case BsonType.DateTime:
      return readInt64LE(b, p);
    case BsonType.Timestamp:
      // low 4 bytes are the increment, high 4 the seconds (BSON spec)
      return { t: readUint32LE(b, p + 4), i: readUint32LE(b, p) };
    case BsonType.ObjectId: {
      let s = '';
      for (let i = p; i < p + 12; i++) s += b[i]!.toString(16).padStart(2, '0');
      return s;
    }
    case BsonType.Null:
    case BsonType.Undefined:
      return null;
    default:
      return undefined;
  }
}
