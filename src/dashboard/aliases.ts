/**
 * Cross-version metric aliases.
 *
 * MongoDB renames and relocates metrics between releases. A dashboard pinned to one
 * release's names silently resolves nothing on another -- the panel is simply empty, with no
 * error to follow. Aliases let one logical metric name resolve to whichever path the capture
 * in front of you actually has.
 *
 * Entries are keyed by the name the dashboard templates use, with alternatives tried in
 * order. Every entry should be justified by an observed capture, not by reading release
 * notes: run `npm run catalogs` to diff real captures across the version matrix produced by
 * tools/fixtures/versions.sh.
 */

export const METRIC_ALIASES: Readonly<Record<string, readonly string[]>> = {
  // Concurrency tickets moved out of the WiredTiger section in 8.0, when the execution
  // control queues became engine-independent. This is the single most important panel in a
  // saturation investigation, so losing it silently is the worst case.
  'serverStatus.wiredTiger.concurrentTransactions.read.available': [
    'serverStatus.queues.execution.read.available',
  ],
  'serverStatus.wiredTiger.concurrentTransactions.write.available': [
    'serverStatus.queues.execution.write.available',
  ],
  'serverStatus.wiredTiger.concurrentTransactions.read.out': [
    'serverStatus.queues.execution.read.out',
  ],
  'serverStatus.wiredTiger.concurrentTransactions.write.out': [
    'serverStatus.queues.execution.write.out',
  ],
  'serverStatus.wiredTiger.concurrentTransactions.read.totalTickets': [
    'serverStatus.queues.execution.read.totalTickets',
  ],
  'serverStatus.wiredTiger.concurrentTransactions.write.totalTickets': [
    'serverStatus.queues.execution.write.totalTickets',
  ],

  // The oplog's collStats moved under a `storageStats` sub-document in 7.0. Observed across
  // the whole matrix (`npm run catalogs`): 4.4, 5.0 and 6.0 report the flat form, 7.0 and 8.0
  // the nested one. The Big-hole dashboard was written against the flat form, so that is the
  // template name and the nested one is the alternative. Without these, "Storage Size" and
  // "avg Obj Size" -- the panels that answer "how much oplog window is left" -- silently
  // vanish on one side or the other of the 7.0 boundary.
  'local.oplog.rs.stats.storageSize': ['local.oplog.rs.stats.storageStats.storageSize'],
  'local.oplog.rs.stats.freeStorageSize': [
    'local.oplog.rs.stats.storageStats.freeStorageSize',
  ],
  'local.oplog.rs.stats.avgObjSize': ['local.oplog.rs.stats.storageStats.avgObjSize'],
};

/**
 * Candidate expressions for a template metric, most-preferred first.
 *
 * Substitutes aliases one path at a time. Expressions reference at most a handful of paths
 * and each has at most a couple of alternatives, so the product stays tiny -- but it is
 * capped anyway so a future table cannot turn this into a combinatorial surprise.
 */
export function aliasCandidates(expression: string, paths: readonly string[]): string[] {
  let candidates = [expression];

  for (const path of paths) {
    const alternatives = METRIC_ALIASES[path];
    if (alternatives === undefined || alternatives.length === 0) continue;

    const next: string[] = [];
    for (const candidate of candidates) {
      next.push(candidate);
      for (const alternative of alternatives) {
        next.push(candidate.split(path).join(alternative));
      }
    }
    candidates = next;
    if (candidates.length > 64) break;
  }

  return [...new Set(candidates)];
}
