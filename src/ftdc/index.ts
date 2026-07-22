/**
 * FTDC decoder -- public entry point.
 *
 * A `metrics.*` file is a bare concatenation of BSON documents with no header or index.
 * Type-0 documents carry metadata; type-1 documents carry a zlib-compressed block of
 * samples. See docs/ftdc-format.md.
 *
 * This module is DOM-free (ARCHITECTURE.md): it takes bytes and returns data, so it runs
 * unchanged in a worker, in Node, or in a future server-side ingest path.
 */

import { unzlibSync } from 'fflate';

import {
  BsonType,
  cstringEnd,
  readCString,
  readDocument,
  readInt32LE,
  readInt64LE,
  valueSize,
} from './bson.js';
import { decodeChunkPayload } from './decoder.js';
import { FTDCFormatError, type DecodeOptions, type DecodedChunk, type FTDCMetadata } from './types.js';

export * from './types.js';

interface Envelope {
  readonly type: number;
  readonly idMs: number;
  /** Bounds of the `data` binary payload, or -1 when absent. */
  readonly dataStart: number;
  readonly dataEnd: number;
  readonly docEnd: number;
}

/**
 * Read a top-level document envelope without materialising it.
 *
 * These documents are small (a few fields wrapping one large binary), so walking for the
 * three fields we need is far cheaper than building an object per chunk.
 */
function readEnvelope(b: Uint8Array, start: number): Envelope {
  const docEnd = start + readInt32LE(b, start);
  let p = start + 4;

  let type = -1;
  let idMs = 0;
  let dataStart = -1;
  let dataEnd = -1;

  while (p < docEnd - 1) {
    const bt = b[p]!;
    p++;
    const key = readCString(b, p);
    p = cstringEnd;
    const size = valueSize(b, bt, p);

    if (key === 'type') {
      // Written as int32 in practice, but the reference tolerates any numeric type.
      if (bt === BsonType.Int32) type = readInt32LE(b, p);
      else if (bt === BsonType.Int64 || bt === BsonType.DateTime) type = readInt64LE(b, p);
    } else if (key === '_id') {
      if (bt === BsonType.DateTime) idMs = readInt64LE(b, p);
    } else if (key === 'data') {
      if (bt === BsonType.Binary) {
        const len = readInt32LE(b, p);
        dataStart = p + 5; // int32 length + 1 subtype byte
        dataEnd = dataStart + len;
      }
    }

    p += size;
  }

  return { type, idMs, dataStart, dataEnd, docEnd };
}

/** True when `start` cannot hold a complete BSON document. */
function isTruncated(b: Uint8Array, start: number): boolean {
  if (start + 4 > b.length) return true;
  const len = readInt32LE(b, start);
  return len < 5 || start + len > b.length;
}

/**
 * Decode an FTDC file into a stream of chunks.
 *
 * Chunks are yielded lazily, so a caller can stop early without paying for the rest of the
 * file, and the decoded columns of a consumed chunk become garbage immediately.
 */
export function* decodeFTDC(
  bytes: Uint8Array,
  opts: DecodeOptions = {},
): Generator<DecodedChunk> {
  const tolerate = opts.tolerateTruncatedTail ?? true;
  const maxChunks = opts.maxChunks ?? Infinity;

  let p = 0;
  let emitted = 0;

  while (p < bytes.length && emitted < maxChunks) {
    if (isTruncated(bytes, p)) {
      // Normal for metrics.interim, which mongod is actively appending to. Everything
      // decoded up to here is valid.
      if (tolerate) return;
      throw new FTDCFormatError(`truncated document at offset ${p}`);
    }

    const env = readEnvelope(bytes, p);
    p = env.docEnd;

    // Type 0 is metadata; anything else unrecognised is skipped rather than fatal, matching
    // the reference implementation's tolerance (read.go:45-52).
    if (env.type !== 1 || env.dataStart < 0) continue;

    let inflated: Uint8Array;
    try {
      // First 4 bytes are the uncompressed length, which the reference ignores; the zlib
      // stream (RFC 1950, not raw deflate) follows.
      inflated = unzlibSync(bytes.subarray(env.dataStart + 4, env.dataEnd));
    } catch (err) {
      if (tolerate) return;
      throw new FTDCFormatError(`inflate failed at offset ${env.dataStart}: ${String(err)}`);
    }

    yield decodeChunkPayload(inflated, env.idMs);
    emitted++;
  }
}

function nested(doc: Record<string, unknown>, path: readonly string[]): unknown {
  let cur: unknown = doc;
  for (const key of path) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/**
 * Read the type-0 metadata document, if the file has one.
 *
 * Field layout differs across server versions -- some nest everything under `common` -- so
 * both shapes are probed rather than assumed.
 */
export function readMetadata(bytes: Uint8Array): FTDCMetadata | null {
  let p = 0;

  while (p < bytes.length) {
    if (isTruncated(bytes, p)) return null;

    const env = readEnvelope(bytes, p);
    if (env.type === 0) {
      const envelope = readDocument(bytes, p);
      const doc = (envelope['doc'] ?? envelope) as Record<string, unknown>;

      const hostname =
        (nested(doc, ['hostInfo', 'system', 'hostname']) as string | undefined) ??
        (nested(doc, ['common', 'hostInfo', 'system', 'hostname']) as string | undefined);
      const version =
        (nested(doc, ['buildInfo', 'version']) as string | undefined) ??
        (nested(doc, ['common', 'buildInfo', 'version']) as string | undefined);

      return {
        doc,
        ...(hostname !== undefined ? { hostname } : {}),
        ...(version !== undefined ? { version } : {}),
      };
    }
    p = env.docEnd;
  }

  return null;
}
