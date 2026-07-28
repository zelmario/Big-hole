/**
 * mongod structured log parsing.
 *
 * From 4.4 onward mongod writes one JSON object per line:
 *
 *   {"t":{"$date":"2026-07-20T03:41:09.910-05:00"},"s":"I","c":"REPL","id":21080,
 *    "ctx":"ReplCoordExtern-0","msg":"Clearing sync source to choose a new one",
 *    "attr":{"syncSource":"mongod-b3:27017"}}
 *
 * Two properties of that format drive everything here. The timestamp carries an offset, so
 * events land on the same absolute axis as FTDC without asking anyone what timezone the server
 * was in. And `id` is a stable numeric identifier for the log statement, which does not change
 * when MongoDB rewords the message -- so classification keys off ids, not prose.
 *
 * Two properties of real support bundles drive the rest. Collected logs are frequently
 * **syslog-wrapped** ("Jul 15 06:52:31 host mongo[3731]: {…}"), and individual lines are
 * **enormous** -- a slow-query line carrying its command document runs to 11 KB, and a 36-hour
 * log to 2.58 GB. `JSON.parse` on every one of those to discover it was a connection message is
 * most of the cost of reading a log, so the header is extracted with bounded regexes and the
 * full document is parsed only for the handful of lines that become markers.
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
  readonly msg: string;
}

/** Why a line did not parse, so ingest can say something useful about the file. */
export interface ParseStats {
  parsed: number;
  /** Lines that are not mongod JSON at all -- almost always a pre-4.4 text log. */
  text: number;
  /** Looked like JSON, but missing the fields that make it a log line. */
  malformed: number;
  /** Lines that carried a syslog prefix before the JSON. */
  wrapped: number;
}

export function emptyStats(): ParseStats {
  return { parsed: 0, text: 0, malformed: 0, wrapped: 0 };
}

/**
 * Where the mongod JSON starts within a line, or -1.
 *
 * Collected bundles routinely pipe mongod through syslog, so the line begins with a facility
 * timestamp and a process tag. `{"t":` is a precise enough anchor: it is how every mongod
 * structured log line starts, and it does not appear in a syslog prefix.
 */
export function jsonStart(text: string): number {
  if (text.charCodeAt(0) === 123 /* { */) return 0;
  const at = text.indexOf('{"t":');
  return at;
}

/* The header fields, in the order mongod emits them, matched over a bounded prefix. */
const RE_DATE = /"\$date":"([^"]+)"/;
const RE_SEVERITY = /"s":"([A-Z])"/;
const RE_COMPONENT = /"c":"([A-Z-]+)"/;
const RE_ID = /"id":(\d+)/;
const RE_MSG = /"msg":"((?:[^"\\]|\\.)*)"/;

/**
 * Header fields only, without parsing the document.
 *
 * Everything classification needs sits in the first few hundred bytes of the line; `attr` --
 * which is all of the size -- does not. On a 2.58 GB log this is the difference between
 * minutes and seconds.
 */
export function parseLine(text: string, stats: ParseStats): LogLine | null {
  if (text.length === 0) return null;

  const start = jsonStart(text);
  if (start < 0) {
    stats.text++;
    return null;
  }
  if (start > 0) stats.wrapped++;

  // mongod writes t, s, c, id, svc, ctx, msg before attr. 512 bytes covers that with room for
  // a long context; anything longer falls back to searching the whole line.
  let head = text.slice(start, start + 512);
  let msg = RE_MSG.exec(head);
  if (msg === null && text.length > start + 512) {
    head = text.slice(start);
    msg = RE_MSG.exec(head);
  }

  const date = RE_DATE.exec(head);
  if (date === null || msg === null) {
    stats.malformed++;
    return null;
  }

  const tMs = Date.parse(date[1]!);
  if (!Number.isFinite(tMs)) {
    stats.malformed++;
    return null;
  }

  stats.parsed++;
  return {
    tMs,
    s: RE_SEVERITY.exec(head)?.[1] ?? 'I',
    c: RE_COMPONENT.exec(head)?.[1] ?? '-',
    id: Number(RE_ID.exec(head)?.[1] ?? 0),
    msg: msg[1]!,
  };
}

/**
 * The full document, for the rare line that becomes a marker.
 *
 * Only called after classification has decided a line is worth showing, so the cost of parsing
 * an 11 KB command document is paid a few hundred times per log rather than a few million.
 */
export function attrOf(text: string): Record<string, unknown> | undefined {
  const start = jsonStart(text);
  if (start < 0) return undefined;
  try {
    const parsed = JSON.parse(text.slice(start)) as { attr?: Record<string, unknown> };
    return parsed.attr;
  } catch {
    return undefined;
  }
}

const RE_DURATION = /"durationMillis":(\d+)/;

/** The duration a slow-query line reports, without parsing the document around it. */
export function durationOf(text: string): number | null {
  const found = RE_DURATION.exec(text);
  return found === null ? null : Number(found[1]);
}

/** True when a file looks like a mongod log at all, from its first few lines. */
export function looksLikeMongodLog(sample: string): boolean {
  for (const line of sample.split('\n', 20)) {
    const text = line.trim();
    if (text.length === 0) continue;
    if (jsonStart(text) >= 0 && text.includes('"msg"')) return true;
    // The pre-4.4 text format, recognised only so it can be reported as unsupported.
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+[+-]\d{4}\s+[IWEF]\s/.test(text)) return true;
  }
  return false;
}
