/**
 * Cross-version compatibility.
 *
 * The tool has to work on whatever arrives, and MongoDB moves metrics between
 * releases: concurrency tickets left `wiredTiger.concurrentTransactions` for
 * `queues.execution` in 8.0, and 8.0 scopes sections by role on a sharded cluster
 * (`shard.serverStatus.…`). Both failures are silent -- the panel is simply empty, with no
 * error to follow -- which is exactly why they need a test rather than a bug report.
 *
 * Fixtures come from `bash tools/fixtures/versions.sh` (Docker). The suite skips when they
 * are absent so a checkout without Docker still runs green, but CI should generate them.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { decodeFTDC } from '../src/ftdc/index.js';
import { defaultDashboard, detectRolePrefixes, expandMetric } from '../src/dashboard/layout.js';
import { RULES } from '../src/insights/rules.js';

const ROOT = 'sample-data/versions';

/**
 * Metrics an investigation cannot proceed without.
 *
 * Written in the names the dashboard templates use; each must resolve on every version via
 * some combination of alias, role prefix, and glob. If one of these breaks, the tool has
 * quietly stopped answering the question it exists to answer.
 */
const ESSENTIAL: ReadonlyArray<[string, string]> = [
  ['read tickets', 'serverStatus.wiredTiger.concurrentTransactions.read.available'],
  ['write tickets', 'serverStatus.wiredTiger.concurrentTransactions.write.available'],
  ['cache size', 'serverStatus.wiredTiger.cache.bytes currently in the cache'],
  ['cache max', 'serverStatus.wiredTiger.cache.maximum bytes configured'],
  ['dirty cache', 'serverStatus.wiredTiger.cache.tracked dirty bytes in the cache'],
  ['connections', 'serverStatus.connections.current'],
  ['queued readers', 'serverStatus.globalLock.currentQueue.readers'],
  ['queued writers', 'serverStatus.globalLock.currentQueue.writers'],
  ['queries', 'rate(serverStatus.opcounters.query)'],
  ['inserts', 'rate(serverStatus.opcounters.insert)'],
  ['resident memory', 'serverStatus.mem.resident'],
  ['cpu user', 'scale(rate(systemMetrics.cpu.user_ms), 0.1)'],
  ['page faults', 'rate(serverStatus.extra_info.page_faults)'],
  // The oplog collStats moved under `storageStats` in 7.0, and nothing said so: "Storage Size"
  // and "avg Obj Size" simply stopped existing on 4.4/5.0/6.0. Oplog window is a first
  // question in most replication investigations, so these are essential rather than nice.
  ['oplog size', 'local.oplog.rs.stats.storageSize'],
  ['oplog free space', 'local.oplog.rs.stats.freeStorageSize'],
  ['oplog avg doc size', 'local.oplog.rs.stats.avgObjSize'],
];

interface Capture {
  readonly version: string;
  readonly paths: Set<string>;
  readonly samples: number;
}

function load(dir: string): { paths: Set<string>; samples: number } {
  const paths = new Set<string>();
  let samples = 0;
  for (const name of readdirSync(dir)) {
    if (!name.startsWith('metrics.')) continue;
    const file = join(dir, name);
    if (!statSync(file).isFile()) continue;
    for (const chunk of decodeFTDC(new Uint8Array(readFileSync(file)))) {
      samples += chunk.sampleCount;
      for (const key of chunk.keys) paths.add(key);
    }
  }
  return { paths, samples };
}

const captures: Capture[] = existsSync(ROOT)
  ? readdirSync(ROOT)
      .filter((n) => statSync(join(ROOT, n)).isDirectory())
      .sort()
      .map((version) => ({ version, ...load(join(ROOT, version)) }))
      .filter((c) => c.samples > 0)
  : [];

if (captures.length === 0) {
  describe('cross-version', () => {
    it.skip('no version fixtures -- run `npm run fixtures:versions` (needs Docker)', () => {});
  });
}

describe.each(captures)('MongoDB $version', (capture) => {
  it('decodes to a non-empty catalogue', () => {
    expect(capture.samples).toBeGreaterThan(0);
    expect(capture.paths.size).toBeGreaterThan(100);
  });

  it('exposes a sample clock', () => {
    // The writer needs `start` (or a role-scoped equivalent) or ingest fails outright.
    const hasClock = [...capture.paths].some(
      (p) => p === 'start' || (p.endsWith('.start') && !p.slice(0, -6).includes('.')),
    );
    expect(hasClock, `no sample clock in ${capture.version}`).toBe(true);
  });

  it('resolves every essential metric', () => {
    const prefixes = detectRolePrefixes(capture.paths);
    const missing: string[] = [];

    for (const [label, metric] of ESSENTIAL) {
      if (expandMetric(metric, capture.paths, prefixes).length === 0) {
        missing.push(`${label} (${metric})`);
      }
    }

    expect(
      missing,
      `MongoDB ${capture.version} [roles: ${prefixes.map((p) => p || 'none').join(',')}] ` +
        `cannot resolve:\n  ${missing.join('\n  ')}\n` +
        `Add an alias in src/dashboard/aliases.ts -- run \`npm run catalogs\` for candidates.`,
    ).toEqual([]);
  });

  /**
   * A detector whose metric was renamed does not fail -- it reports nothing, which is
   * indistinguishable from a healthy server. That is the worst failure this tool can have:
   * the check that would have caught the incident silently stops running on the version the
   * server happens to be on, and the capture comes back clean.
   */
  it('resolves every pathology rule', () => {
    const prefixes = detectRolePrefixes(capture.paths);
    const missing = RULES.filter(
      (rule) => expandMetric(rule.metric, capture.paths, prefixes).length === 0,
    ).map((rule) => `${rule.id} (${rule.metric})`);

    expect(
      missing,
      `MongoDB ${capture.version} cannot evaluate these checks, so they would report ` +
        `"nothing found" on every capture from this release:\n  ${missing.join('\n  ')}`,
    ).toEqual([]);
  });

  it('builds a dashboard with most panels populated', () => {
    const charts = defaultDashboard(capture.paths).panels.filter((p) => p.kind === 'chart');
    // 43 of the 44 charts resolve on every captured version. The one that does not is
    // "Replica members ping", which needs a peer to ping and so is genuinely absent from a
    // single-node fixture -- it does resolve on a real multi-member capture.
    //
    // This floor used to be 25, which is why three panels could disappear on 4.4/5.0/6.0
    // without a single test going red. A floor set well below what actually passes is not a
    // guardrail.
    expect(
      charts.length,
      `only ${charts.length} panels resolved on ${capture.version}`,
    ).toBeGreaterThanOrEqual(43);
  });
});
