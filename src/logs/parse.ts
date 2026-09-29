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
 * A pre-4.4 server writes plain text. A `system.profile` export is JSON too, but it is not a
 * log line: `op`, `ns`, `millis`, `ts`. Both are read, so a query log is not only the 4.4+
 * "Slow query" shape.
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
  const tight = text.indexOf('{"t":');
  if (tight >= 0) return tight;
  // Some collectors pretty-print the header. The `$date` anchor is the same either way.
  return text.indexOf('{"t" :');
}

/* Optional whitespace: mongod usually writes `"id":51803`, exporters sometimes `"id": 51803`. */
const RE_DATE = /"\$date"\s*:\s*"([^"]+)"/;
const RE_SEVERITY = /"s"\s*:\s*"([A-Z][0-9]?)"/;
const RE_COMPONENT = /"c"\s*:\s*"([A-Z0-9-]+)"/;
const RE_ID = /"id"\s*:\s*(\d+)/;
const RE_MSG = /"msg"\s*:\s*"((?:[^"\\]|\\.)*)"/;
const RE_LEGACY =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+)([+-]\d{2}:?\d{2})\s+([IWEFD])\d*\s+([A-Z0-9]+)/;

/**
 * Header fields only, without parsing the document.
 *
 * Everything classification needs sits in the first few hundred bytes of the line; `attr` --
 * which is all of the size -- does not. On a 2.58 GB log this is the difference between
 * minutes and seconds.
 */
export function parseLine(text: string, stats: ParseStats): LogLine | null {
  if (text.length === 0) return null;

  const logv2 = readLogv2(text);
  if (logv2 !== null) {
    if (logv2.wrapped) stats.wrapped++;
    stats.parsed++;
    return logv2.line;
  }

  const profile = readProfile(text);
  if (profile !== null) {
    stats.parsed++;
    return profile;
  }

  const legacy = readLegacy(text);
  if (legacy !== null) {
    stats.parsed++;
    return legacy;
  }

  stats[text.includes('{') ? 'malformed' : 'text']++;
  return null;
}

function readLogv2(text: string): { line: LogLine; wrapped: boolean } | null {
  const start = jsonStart(text);
  if (start < 0) return null;

  // mongod writes t, s, c, id, svc, ctx, msg before attr. 512 bytes covers that with room for
  // a long context; anything longer falls back to searching the whole line.
  let head = text.slice(start, start + 512);
  let msg = RE_MSG.exec(head);
  if (msg === null && text.length > start + 512) {
    head = text.slice(start);
    msg = RE_MSG.exec(head);
  }

  const date = RE_DATE.exec(head);
  if (date === null || msg === null) return null;

  const tMs = Date.parse(date[1]!);
  if (!Number.isFinite(tMs)) return null;

  return {
    wrapped: start > 0,
    line: {
      tMs,
      s: RE_SEVERITY.exec(head)?.[1] ?? 'I',
      c: RE_COMPONENT.exec(head)?.[1] ?? '-',
      id: Number(RE_ID.exec(head)?.[1] ?? 0),
      msg: msg[1]!,
    },
  };
}

/**
 * One `system.profile` document, as mongoexport writes it: one JSON object per line, with
 * `millis` instead of `durationMillis` and `ts` instead of the log header.
 */
function readProfile(text: string): LogLine | null {
  const start = text.indexOf('{');
  if (start < 0 || !text.includes('"millis"') || !text.includes('"ns"')) return null;
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(text.slice(start)) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof doc['ns'] !== 'string' || typeof doc['millis'] !== 'number') return null;
  if (doc['command'] === undefined && doc['query'] === undefined) return null;
  const ts = doc['ts'];
  const date =
    ts !== null && typeof ts === 'object' && !Array.isArray(ts)
      ? (ts as Record<string, unknown>)['$date']
      : undefined;
  const tMs = typeof date === 'string' ? Date.parse(date) : NaN;
  if (!Number.isFinite(tMs)) return null;
  const op = typeof doc['op'] === 'string' ? doc['op'] : 'command';
  return { tMs, s: 'I', c: 'COMMAND', id: 0, msg: `profile ${op}` };
}

/** Pre-4.4 plain text. The timestamp has no colon in the offset (`+0000`). */
function readLegacy(text: string): LogLine | null {
  const head = RE_LEGACY.exec(text.trim());
  if (head === null) return null;
  const tMs = Date.parse(`${head[1]!}${head[2]!}`);
  if (!Number.isFinite(tMs)) return null;
  const body = text.slice(head[0].length).trim();
  return {
    tMs,
    s: head[3]!,
    c: head[4]!,
    id: 0,
    msg: body.length > 0 ? body : 'command',
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

const RE_DURATION = /"durationMillis"\s*:\s*(\d+)/;

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
    if (text.includes('"millis"') && text.includes('"ns"') && text.includes('"op"')) return true;
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+[+-]\d{2}:?\d{2}\s+[IWEF]/.test(text)) return true;
  }
  return false;
}
