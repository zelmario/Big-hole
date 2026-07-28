/**
 * What a log line means, and whether it is worth drawing.
 *
 * The rules live in the table below rather than in code, so adding a message is a data change
 * (ARCHITECTURE.md's line about pathology rules applies here for the same reason: these will be
 * edited far more often than the code that reads them).
 *
 * Matching prefers `id`, the stable numeric statement identifier, over the message text --
 * MongoDB rewords messages between releases and the id survives it. Text matching is a
 * fallback for families of messages that share wording but not ids.
 *
 * The hard part is not recognising events, it is *volume*. A real 73 MB production log holds
 * 19,220 "Connection ended", 18,485 TLS warnings and 11,552 slow queries against 5 sync-source
 * changes. Annotating everything buries the five lines that explain the incident. So each rule
 * declares how it should be shown:
 *
 *   annotate -- rare and specific: elections, sync-source changes, restarts, oplog truncation.
 *               Drawn as a marker on the shared time axis.
 *   count    -- high volume and meaningful in aggregate: slow queries, connection churn, auth
 *               failures. Becomes a chartable series, never a marker.
 *
 * And a density guard on top: an `annotate` class that turns out to fire hundreds of times is
 * demoted to `count` automatically, because a rule that is rare on one server is not
 * necessarily rare on another, and being wrong about that should degrade the display rather
 * than destroy it.
 */

import type { LogLine } from './parse.js';

export type Mode = 'annotate' | 'count';

export interface Rule {
  /** Series/annotation class. Also the metric name: `logs.<kind>.count`. */
  readonly kind: string;
  /** Short human label for the marker and the legend. */
  readonly label: string;
  readonly mode: Mode;
  /** Statement ids, preferred over text because they survive rewordings. */
  readonly ids?: readonly number[];
  readonly component?: string;
  /** Substring of `msg`, matched case-insensitively, when ids are impractical. */
  readonly contains?: string;
  readonly severity?: readonly string[];
}

/**
 * Ids are from real captures and from mongodb/mongo's logv2 statements. Where a family is
 * open-ended (every election message, every index build) the component plus a text match is
 * used, since new members of the family appear between releases.
 */
export const RULES: readonly Rule[] = [
  // --- replication: the reason multi-node correlation exists -------------------------------
  { kind: 'election', label: 'Election', mode: 'annotate', component: 'REPL', contains: 'election' },
  {
    kind: 'stateChange',
    label: 'State transition',
    mode: 'annotate',
    ids: [21358, 21106, 21329],
    component: 'REPL',
    contains: 'state transition',
  },
  { kind: 'stepdown', label: 'Stepdown', mode: 'annotate', component: 'REPL', contains: 'stepping down' },
  {
    kind: 'syncSource',
    label: 'Sync source change',
    mode: 'annotate',
    ids: [21080, 21799, 21798, 3873103],
  },
  {
    kind: 'oplogFetcher',
    label: 'Oplog fetcher error',
    mode: 'annotate',
    ids: [21122, 21274, 21104],
  },
  { kind: 'replLag', label: 'Replication progress', mode: 'annotate', ids: [21764, 21232] },
  { kind: 'rollback', label: 'Rollback', mode: 'annotate', component: 'REPL', contains: 'rollback' },
  { kind: 'initialSync', label: 'Initial sync', mode: 'annotate', component: 'REPL', contains: 'initial sync' },

  // --- lifecycle ---------------------------------------------------------------------------
  { kind: 'startup', label: 'Startup', mode: 'annotate', ids: [20721, 4615611, 21951, 20698] },
  { kind: 'shutdown', label: 'Shutdown', mode: 'annotate', ids: [23138, 20565, 4784900, 20520] },

  // --- storage ----------------------------------------------------------------------------
  { kind: 'oplogTruncate', label: 'Oplog truncation', mode: 'annotate', ids: [22402] },
  { kind: 'indexBuild', label: 'Index build', mode: 'annotate', component: 'INDEX' },
  // Counted, not annotated. A checkpoint is periodic and routine -- one every fifteen seconds
  // per node -- so as a marker it is pure noise, and on a three-node bundle it filled the whole
  // "what happened in this window" list with a hundred identical rows before a single metric.
  // As a rate it is genuinely useful: checkpoints getting longer or more frequent is what
  // eviction pressure looks like from the log side.
  { kind: 'checkpoint', label: 'Checkpoints', mode: 'count', component: 'WTCHKPT' },

  // --- high volume: series, never markers ---------------------------------------------------
  { kind: 'slowQuery', label: 'Slow query', mode: 'count', ids: [51803] },
  { kind: 'appliedOp', label: 'Slow applied op', mode: 'count', ids: [51801] },
  { kind: 'connection', label: 'Connections opened', mode: 'count', ids: [22943] },
  { kind: 'disconnection', label: 'Connections closed', mode: 'count', ids: [22944] },
  { kind: 'authFailure', label: 'Auth failures', mode: 'count', component: 'ACCESS', contains: 'fail' },
  { kind: 'interrupted', label: 'Interrupted operations', mode: 'count', ids: [20883] },
  { kind: 'planError', label: 'Plan executor errors', mode: 'count', ids: [23798] },

  // --- catch-alls, last: anything the rules above did not claim ----------------------------
  { kind: 'fatal', label: 'Fatal', mode: 'annotate', severity: ['F'] },
  { kind: 'error', label: 'Error', mode: 'annotate', severity: ['E'] },
  { kind: 'warning', label: 'Warnings', mode: 'count', severity: ['W'] },
];

/**
 * Beyond this many, an `annotate` class is demoted to counts.
 *
 * Chosen from real data: a busy 24-hour log has a handful of sync-source changes and tens of
 * checkpoints, but tens of thousands of warnings. Anything firing more than a few hundred
 * times is a rate, not an event.
 */
export const ANNOTATION_LIMIT = 300;

export function matches(rule: Rule, line: LogLine): boolean {
  if (rule.ids !== undefined && rule.ids.includes(line.id)) return true;
  // An id list alone is exact; anything else has to satisfy every condition it states.
  if (rule.ids !== undefined && rule.component === undefined && rule.contains === undefined) {
    return false;
  }
  if (rule.component !== undefined && line.c !== rule.component) return false;
  if (rule.severity !== undefined && !rule.severity.includes(line.s)) return false;
  if (rule.contains !== undefined && !line.msg.toLowerCase().includes(rule.contains)) return false;
  return rule.component !== undefined || rule.severity !== undefined || rule.contains !== undefined;
}

/** First rule that claims this line, or null for the vast majority of informational noise. */
export function classify(line: LogLine): Rule | null {
  for (const rule of RULES) if (matches(rule, line)) return rule;
  return null;
}
