/**
 * Find the part of a log that covers a time window, without reading the log.
 *
 * A support bundle pairs a 36-hour, 2.58 GB log with a capture covering a few hours of it.
 * Scanning the whole file to draw markers over that capture is mostly wasted work, and on a
 * slow disk it is the difference between a usable tool and a spinner.
 *
 * Logs are chronological and `File.slice()` is lazy -- it hands back a view, not bytes -- so a
 * binary search over byte offsets locates the window by reading a few dozen kilobytes. The
 * assumption is monotonic timestamps, which holds within a rotated log file; where it does not
 * (a file concatenated out of order), the search simply lands somewhere approximate, and the
 * caller pads the range.
 */

import { jsonStart } from './parse.js';

/** Probe size: comfortably larger than the longest line seen in real bundles (11 KB). */
const PROBE_BYTES = 96 * 1024;

async function textAt(file: Blob, offset: number, length: number): Promise<string> {
  const slice = file.slice(offset, Math.min(file.size, offset + length));
  return new TextDecoder().decode(await slice.arrayBuffer());
}

/** Timestamp of the first complete line at or after `offset`, or null near the end. */
export async function timeAt(file: Blob, offset: number): Promise<number | null> {
  const text = await textAt(file, offset, PROBE_BYTES);
  // Skip a partial first line unless we are at the very start of the file.
  let from = offset === 0 ? 0 : text.indexOf('\n') + 1;
  if (from <= 0 && offset !== 0) return null;

  while (from < text.length) {
    const end = text.indexOf('\n', from);
    const line = text.slice(from, end < 0 ? undefined : end);
    const start = jsonStart(line);
    if (start >= 0) {
      const date = /"\$date":"([^"]+)"/.exec(line.slice(start, start + 512));
      if (date !== null) {
        const ms = Date.parse(date[1]!);
        if (Number.isFinite(ms)) return ms;
      }
    }
    if (end < 0) break;
    from = end + 1;
  }
  return null;
}

/**
 * First byte offset whose line is at or after `targetMs`.
 *
 * Returns 0 when the whole file is later than the target, and `file.size` when it is all
 * earlier -- both of which the caller reads as "nothing to index here".
 */
export async function seekTime(file: Blob, targetMs: number): Promise<number> {
  let lo = 0;
  let hi = file.size;

  // A dozen probes over a 2.5 GB file; each reads 96 KB.
  while (hi - lo > PROBE_BYTES) {
    const mid = Math.floor((lo + hi) / 2);
    const ms = await timeAt(file, mid);
    if (ms === null) {
      // No parsable line in this probe: treat it as "later" so the search still terminates.
      hi = mid;
      continue;
    }
    if (ms < targetMs) lo = mid;
    else hi = mid;
  }
  return lo;
}

export interface ByteRange {
  readonly from: number;
  readonly to: number;
  /** True when the search was skipped and the whole file will be read. */
  readonly whole: boolean;
}

/**
 * Byte range covering [fromMs, toMs], padded by one probe at each end.
 *
 * The padding matters: the search lands on a boundary, and an event a few hundred bytes before
 * it is still inside the window the caller asked for.
 */
export async function rangeFor(
  file: Blob,
  fromMs: number | undefined,
  toMs: number | undefined,
): Promise<ByteRange> {
  if (fromMs === undefined || toMs === undefined || file.size <= PROBE_BYTES * 4) {
    return { from: 0, to: file.size, whole: true };
  }

  const first = await timeAt(file, 0);
  const last = await timeAt(file, Math.max(0, file.size - PROBE_BYTES));
  // Not chronological, or unreadable: fall back to the whole file rather than guess.
  if (first === null || last === null || last < first) {
    return { from: 0, to: file.size, whole: true };
  }
  // No overlap at all: an empty range, which the caller reports rather than silently ignores.
  if (last < fromMs || first > toMs) return { from: 0, to: 0, whole: false };

  const from = first >= fromMs ? 0 : await seekTime(file, fromMs);
  const to = last <= toMs ? file.size : await seekTime(file, toMs);
  return {
    from: Math.max(0, from - PROBE_BYTES),
    to: Math.min(file.size, to + PROBE_BYTES),
    whole: from === 0 && to === file.size,
  };
}
