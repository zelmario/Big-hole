/**
 * The pathology rules, as data.
 *
 * Kept free of logic on purpose: this is the file a support engineer edits, and it should be
 * editable by someone who knows MongoDB rather than this codebase. `detect.ts` holds every
 * behaviour; a rule is a metric, a comparison, a threshold and a duration.
 *
 * Three constraints on adding one:
 *
 * 1. **Name the metric the way a dashboard template does.** Rules resolve through the same
 *    `expandMetric`, so aliases and role prefixes apply and a rule written against one release
 *    fires on another where the metric was renamed. Never write a version-specific path.
 * 2. **Justify the threshold.** Every number below is either a documented WiredTiger trigger or
 *    a value observed on a real capture. A guessed threshold produces findings nobody trusts,
 *    and one untrusted finding discredits the whole list.
 * 3. **Make `sustainMs` long enough to mean something.** Almost all of these metrics touch
 *    their threshold briefly on a perfectly healthy server. What distinguishes a pathology is
 *    that it persists.
 */

import type { Rule } from './detect.js';

export const RULES: readonly Rule[] = [
  /* ------------------------------------------------------- execution tickets ---- */
  // The single most useful signal in a saturation investigation. Available tickets at zero
  // means every further operation queues, and the server is no longer keeping up with what is
  // being asked of it -- everything else (latency, queue depth, connection count) is downstream
  // of this. The 8.0 rename to `queues.execution` is handled by the alias table.
  {
    id: 'read-tickets-exhausted',
    title: 'Read tickets exhausted',
    severity: 'critical',
    metric: 'serverStatus.wiredTiger.concurrentTransactions.read.available',
    op: '<=',
    threshold: 0,
    // Brief exhaustion is normal under load; a pool that stays empty is not.
    sustainMs: 30_000,
    unit: 'count',
    what: 'No read ticket was available, so every incoming read waited for one.',
    check: 'Read latency and the global lock read queue over the same window, then what was consuming the tickets — a collection scan, a missing index, or storage that stopped keeping up.',
  },
  {
    id: 'write-tickets-exhausted',
    title: 'Write tickets exhausted',
    severity: 'critical',
    metric: 'serverStatus.wiredTiger.concurrentTransactions.write.available',
    op: '<=',
    threshold: 0,
    sustainMs: 30_000,
    unit: 'count',
    what: 'No write ticket was available, so every incoming write waited for one.',
    check: 'Dirty cache and checkpoint activity over the same window — write tickets usually empty because eviction is behind, not because the writes themselves are slow.',
  },

  /* ---------------------------------------------------------- WiredTiger cache ---- */
  // WiredTiger targets 5% dirty and starts evicting application threads at 20%. Past that
  // trigger the server is making user operations do eviction work, which is felt as latency
  // with no corresponding change in workload.
  {
    id: 'cache-dirty-high',
    title: 'Cache dirty above the eviction trigger',
    severity: 'warning',
    metric:
      'pct(serverStatus.wiredTiger.cache.tracked dirty bytes in the cache, serverStatus.wiredTiger.cache.maximum bytes configured)',
    op: '>=',
    threshold: 20,
    sustainMs: 60_000,
    unit: 'percent',
    what: 'Dirty cache stayed at or above the 20% mark where WiredTiger makes application threads evict.',
    check: 'Checkpoint duration and disk write throughput — this is eviction failing to keep up with the write rate, and the storage is the usual reason.',
  },
  // The cache is meant to sit near full; that is what it is for. What matters is being pinned
  // at the ceiling, because it means eviction has no headroom left.
  {
    id: 'cache-full',
    title: 'Cache pinned at capacity',
    severity: 'warning',
    metric:
      'pct(serverStatus.wiredTiger.cache.bytes currently in the cache, serverStatus.wiredTiger.cache.maximum bytes configured)',
    op: '>=',
    threshold: 95,
    sustainMs: 300_000,
    unit: 'percent',
    what: 'The cache stayed within 5% of its configured maximum, leaving eviction no headroom.',
    check: 'Pages evicted and bytes read into cache — a working set larger than the cache shows up here first, and as page faults next.',
  },

  /* ----------------------------------------------------------------- queueing ---- */
  // The global lock queue is the symptom the user actually feels. It is downstream of the
  // ticket pool, so it is `warning` rather than `critical`: worth surfacing, but the tickets
  // above are the finding.
  {
    id: 'read-queue-building',
    title: 'Read queue building',
    severity: 'warning',
    metric: 'serverStatus.globalLock.currentQueue.readers',
    op: '>=',
    threshold: 10,
    sustainMs: 60_000,
    unit: 'count',
    what: 'Reads were waiting on the global lock queue rather than executing.',
    check: 'Read tickets over the same window — a sustained read queue is almost always the ticket pool emptying.',
  },
  {
    id: 'write-queue-building',
    title: 'Write queue building',
    severity: 'warning',
    metric: 'serverStatus.globalLock.currentQueue.writers',
    op: '>=',
    threshold: 10,
    sustainMs: 60_000,
    unit: 'count',
    what: 'Writes were waiting on the global lock queue rather than executing.',
    check: 'Write tickets and dirty cache over the same window.',
  },

  /* -------------------------------------------------------------- replication ---- */
  // Flow control throttles writes on the primary when secondaries fall behind the configured
  // majority-commit window. Any sustained time in it means replication, not the primary, is
  // setting the write rate. The metric is microseconds accumulated per second; scaling by 1e-4
  // turns that into a percentage of wall clock, matching the dashboard's own panel.
  {
    id: 'flow-control-engaged',
    title: 'Flow control throttling writes',
    severity: 'warning',
    metric: 'scale(rate(serverStatus.flowControl.isLaggedTimeMicros), 0.0001)',
    op: '>=',
    threshold: 10,
    sustainMs: 60_000,
    unit: 'percent',
    what: 'The primary was throttling its own writes because a secondary was behind the majority-commit point.',
    check: 'Replication lag across the nodes, and whether the lagging secondary was itself ticket- or cache-bound.',
  },

  /* ------------------------------------------------------------------ storage ---- */
  // Page faults on a database server mean the working set is not resident. A handful is
  // routine; a sustained rate is the machine paging its way through the workload.
  {
    id: 'page-faults-sustained',
    title: 'Sustained page faults',
    severity: 'warning',
    metric: 'rate(serverStatus.extra_info.page_faults)',
    op: '>=',
    threshold: 100,
    sustainMs: 300_000,
    unit: 'per-sec',
    what: 'The server was faulting pages from disk continuously, so its working set did not fit in memory.',
    check: 'Resident memory against the cache size, and whether another process on the host is taking the memory.',
  },
];
