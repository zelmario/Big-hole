/**
 * Group logged operations by what they do.
 *
 * A log holds every operation that was written down — slow queries, profiler documents, and
 * commands that never crossed `slowms`. Same shape means same operation, namespace, predicate
 * and plan. The raw line is parsed and dropped; nothing about the file's size is discarded.
 * The one exception is the slowest call of each shape: its command is kept whole, literals and
 * all, because the shape alone cannot say whether `/…/` was an anchored regex or which id
 * was looked up.
 */

import { commandAttr, parseSlowOp, type QueryShape } from './queryShape.js';

/** One real call of a shape, as mongod logged it. */
export interface SlowestCall {
  readonly tMs: number;
  readonly durationMs: number;
  /** The command document, indented. A getMore also carries the command that opened its cursor. */
  readonly command: string;
}

export interface QueryPattern {
  readonly op: string;
  readonly ns: string;
  readonly pattern: string;
  readonly plan: string;
  readonly collscan: boolean;
  readonly doing: string;
  readonly count: number;
  readonly totalMs: number;
  readonly maxMs: number;
  readonly docsExamined: number;
  readonly keysExamined: number;
  readonly returned: number;
  /** False for a count, or a write that did not report how many documents it affected. */
  readonly yields: boolean;
  readonly reslen: number;
  readonly firstMs: number;
  readonly lastMs: number;
  readonly appNames: readonly string[];
  /** Absent on a report built before the slowest call was kept. */
  readonly slowest?: SlowestCall;
}

export interface QueryReport {
  /** Slowest total time first — where the log actually spent its milliseconds. */
  readonly patterns: readonly QueryPattern[];
  /** User operations that were grouped above. */
  readonly ops: number;
  /** Handshakes and heartbeats. Counted so the omission is visible, not shown as queries. */
  readonly internal: number;
  /** Kept for callers that used to hear about a pattern cap. There is no cap. */
  readonly ungrouped: number;
  /** Slow-query lines whose command document could not be read. */
  readonly unread: number;
}

export function emptyQueryReport(): QueryReport {
  return { patterns: [], ops: 0, internal: 0, ungrouped: 0, unread: 0 };
}

interface Acc {
  shape: QueryShape;
  count: number;
  totalMs: number;
  maxMs: number;
  docsExamined: number;
  keysExamined: number;
  returned: number;
  yields: boolean;
  reslen: number;
  firstMs: number;
  lastMs: number;
  apps: string[];
  slowest: SlowestCall | undefined;
}

/**
 * The command of one call, as the reader would want to paste it into a shell.
 *
 * Stringified only when a call becomes the slowest of its shape, which after the first few
 * calls is rare, so a log with millions of lines does not pay for millions of JSON.stringify.
 */
function commandText(attr: Record<string, unknown>): string {
  const command = attr['command'];
  const originating = attr['originatingCommand'];
  const doc = originating !== undefined && command !== undefined ? { command, originatingCommand: originating } : (command ?? originating);
  return JSON.stringify(doc, null, 2);
}

const SLOW_IDS = new Set([51803, 51801]);

export class QueryAggregator {
  private readonly groups = new Map<string, Acc>();
  private ops = 0;
  private internal = 0;
  private ungrouped = 0;
  private unread = 0;

  /** True for the statement ids that always carry a command document. */
  static isSlowOp(id: number): boolean {
    return SLOW_IDS.has(id);
  }

  add(raw: string, tMs: number): void {
    const attr = commandAttr(raw);
    if (attr === undefined) {
      this.unread++;
      return;
    }
    const parsed = parseSlowOp(attr);
    if (parsed.kind === 'internal') {
      this.internal++;
      return;
    }
    if (parsed.kind === 'skip') {
      this.unread++;
      return;
    }

    this.ops++;
    const shape = parsed.shape;
    const key = `${shape.op}\0${shape.ns}\0${shape.pattern}\0${shape.plan}`;
    let acc = this.groups.get(key);
    if (acc === undefined) {
      acc = {
        shape,
        count: 0,
        totalMs: 0,
        maxMs: 0,
        docsExamined: 0,
        keysExamined: 0,
        returned: 0,
        yields: false,
        reslen: 0,
        firstMs: tMs,
        lastMs: tMs,
        apps: [],
        slowest: undefined,
      };
      this.groups.set(key, acc);
    }

    acc.count++;
    acc.totalMs += shape.durationMs;
    if (shape.durationMs > acc.maxMs) acc.maxMs = shape.durationMs;
    acc.docsExamined += shape.docsExamined;
    acc.keysExamined += shape.keysExamined;
    acc.returned += shape.returned;
    if (shape.yields) acc.yields = true;
    acc.reslen += shape.reslen;
    if (tMs < acc.firstMs) acc.firstMs = tMs;
    if (tMs > acc.lastMs) acc.lastMs = tMs;
    if (acc.slowest === undefined || shape.durationMs > acc.slowest.durationMs) {
      acc.slowest = { tMs, durationMs: shape.durationMs, command: commandText(attr) };
    }
    if (shape.appName !== '' && acc.apps.length < 6 && !acc.apps.includes(shape.appName)) {
      acc.apps.push(shape.appName);
    }
  }

  finish(): QueryReport {
    const patterns: QueryPattern[] = [];
    for (const acc of this.groups.values()) {
      patterns.push({
        op: acc.shape.op,
        ns: acc.shape.ns,
        pattern: acc.shape.pattern,
        plan: acc.shape.plan,
        collscan: acc.shape.collscan,
        doing: acc.shape.doing,
        count: acc.count,
        totalMs: acc.totalMs,
        maxMs: acc.maxMs,
        docsExamined: acc.docsExamined,
        keysExamined: acc.keysExamined,
        returned: acc.returned,
        yields: acc.yields,
        reslen: acc.reslen,
        firstMs: acc.firstMs,
        lastMs: acc.lastMs,
        appNames: acc.apps,
        ...(acc.slowest !== undefined ? { slowest: acc.slowest } : {}),
      });
    }
    patterns.sort((a, b) => b.totalMs - a.totalMs || b.maxMs - a.maxMs || b.count - a.count);
    return {
      patterns,
      ops: this.ops,
      internal: this.internal,
      ungrouped: this.ungrouped,
      unread: this.unread,
    };
  }
}
