/**
 * mongod structured log parsing.
 *
 * From 4.4 onward mongod writes one JSON object per line:
 *
 *   {"t":{"$date":"2026-07-20T03:41:09.910-05:00"},"s":"I","c":"REPL","id":21080,
 *    "ctx":"ReplCoordExtern-0","msg":"Clearing sync source to choose a new one",
 *    "attr":{"syncSource":"mongod-b3:27100"}}
 *
 * Two properties of that format drive everything here. The timestamp carries an offset, so
 * events land on the same absolute axis as FTDC without asking anyone what timezone the server
 * was in. And `id` is a stable numeric identifier for the log statement, which does not change
 * when MongoDB rewords the message -- so classification keys off ids, not prose.
 *
 * A pre-4.4 server writes plain text instead. Rather than half-parse it, that is detected and
 * reported: "this log is too old to correlate" is a fact worth stating, where a silently empty
 * annotation layer is indistinguishable from "nothing happened".
 */

export interface LogLine {
  /** Epoch milliseconds, absolute -- the log's own UTC offset is honoured. */
  readonly tMs: number;
  /** Severity: F(atal), E(rror), W(arning), I(nformational), D(ebug). */
  readonly s: string;
  /** Component: REPL, COMMAND, NETWORK, STORAGE, … */
  readonly c: string;
  /** Stable statement id. Survives rewordings; the message text does not. */
  readonly id: number;
  readonly ctx: string;
  readonly msg: string;
  readonly attr?: Record<string, unknown>;
}

/** Why a line did not parse, so ingest can say something useful about the file. */
export interface ParseStats {
  parsed: number;
  /** Lines that are not JSON at all -- almost always a pre-4.4 text log. */
  text: number;
  /** JSON, but missing the fields that make it a log line. */
  malformed: number;
}

export function emptyStats(): ParseStats {
  return { parsed: 0, text: 0, malformed: 0 };
}

/**
 * Parse one line, counting failures rather than throwing.
 *
 * A truncated final line, a rotated file with a partial write, a stray shell banner -- all
 * routine in a support bundle, and none of them a reason to abandon a 73 MB log.
 */
export function parseLine(line: string, stats: ParseStats): LogLine | null {
  const text = line.trim();
  if (text.length === 0) return null;
  if (text.charCodeAt(0) !== 123 /* { */) {
    stats.text++;
    return null;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    stats.malformed++;
    return null;
  }

  const d = raw as {
    t?: { $date?: string };
    s?: string;
    c?: string;
    id?: number;
    ctx?: string;
    msg?: string;
    attr?: Record<string, unknown>;
  };

  const stamp = d.t?.$date;
  if (typeof stamp !== 'string' || typeof d.msg !== 'string') {
    stats.malformed++;
    return null;
  }

  const tMs = Date.parse(stamp);
  if (!Number.isFinite(tMs)) {
    stats.malformed++;
    return null;
  }

  stats.parsed++;
  return {
    tMs,
    s: d.s ?? 'I',
    c: d.c ?? '-',
    id: d.id ?? 0,
    ctx: d.ctx ?? '',
    msg: d.msg,
    ...(d.attr !== undefined ? { attr: d.attr } : {}),
  };
}

/** True when a file looks like a mongod log at all, from its first few lines. */
export function looksLikeMongodLog(sample: string): boolean {
  for (const line of sample.split('\n', 20)) {
    const text = line.trim();
    if (text.length === 0) continue;
    if (text.startsWith('{') && text.includes('"msg"')) return true;
    // The pre-4.4 text format, recognised only so it can be reported as unsupported.
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+[+-]\d{4}\s+[IWEF]\s/.test(text)) return true;
  }
  return false;
}

/** Number a slow-query line reports, or null. */
export function durationMs(line: LogLine): number | null {
  const value = line.attr?.['durationMillis'];
  return typeof value === 'number' ? value : null;
}
