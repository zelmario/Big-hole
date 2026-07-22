/**
 * Cross-version catalogue diff.
 *
 * Decodes every capture under sample-data/versions and reports, per version, how much of the
 * dashboard resolves and exactly which template metrics are missing. That list is the
 * evidence for src/dashboard/aliases.ts -- entries there should come from a capture that
 * demonstrably lacks the path, not from reading release notes.
 *
 *   bash tools/fixtures/versions.sh     # capture the matrix (needs Docker)
 *   npm run catalogs
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { decodeFTDC } from '../src/ftdc/index.js';
import { DEFAULT_TEMPLATES } from '../src/dashboard/defaultDashboard.js';
import { defaultDashboard, detectRolePrefixes, expandMetric } from '../src/dashboard/layout.js';
import { exprPaths, parseExpr } from '../src/data/expr.js';

const ROOT = 'sample-data/versions';

if (!existsSync(ROOT)) {
  console.error(`no captures in ${ROOT} -- run: bash tools/fixtures/versions.sh`);
  process.exit(1);
}

/** Every metric path a capture contains, taken straight from the decoder. */
function catalogue(dir: string): Set<string> {
  const paths = new Set<string>();
  for (const name of readdirSync(dir)) {
    if (!name.startsWith('metrics.')) continue;
    const file = join(dir, name);
    if (!statSync(file).isFile()) continue;
    try {
      for (const chunk of decodeFTDC(new Uint8Array(readFileSync(file)))) {
        for (const key of chunk.keys) paths.add(key);
      }
    } catch {
      /* a partial file still contributes what it decoded */
    }
  }
  return paths;
}

const versions = readdirSync(ROOT)
  .filter((n) => statSync(join(ROOT, n)).isDirectory())
  .sort();

const catalogues = new Map<string, Set<string>>();
const chartTemplates = DEFAULT_TEMPLATES.filter((t) => t.kind === 'chart');

console.log('version  paths  roles        panels  series');
console.log('-'.repeat(52));

for (const version of versions) {
  const paths = catalogue(join(ROOT, version));
  if (paths.size === 0) {
    console.log(`${version.padEnd(8)} (no decodable capture)`);
    continue;
  }
  catalogues.set(version, paths);

  const roles = detectRolePrefixes(paths);
  const charts = defaultDashboard(paths).panels.filter((p) => p.kind === 'chart');
  const series = charts.reduce((n, p) => n + p.metrics.length, 0);

  console.log(
    `${version.padEnd(8)} ${String(paths.size).padEnd(6)} ` +
      `${(roles.map((r) => r || '(none)').join(',')).padEnd(12)} ` +
      `${String(charts.length).padStart(2)}/${chartTemplates.length}   ${series}`,
  );
}

// Which template metrics fail to resolve, and where. A metric missing on ONE version is an
// alias candidate; missing everywhere means the template itself is wrong.
console.log('\nunresolved template metrics');
console.log('-'.repeat(52));

const unresolved = new Map<string, string[]>();
for (const [version, paths] of catalogues) {
  const prefixes = detectRolePrefixes(paths);
  for (const template of chartTemplates) {
    for (const metric of template.metrics) {
      if (expandMetric(metric, paths, prefixes).length === 0) {
        const list = unresolved.get(metric) ?? [];
        list.push(version);
        unresolved.set(metric, list);
      }
    }
  }
}

const all = [...catalogues.keys()];
const partial = [...unresolved.entries()].filter(([, vs]) => vs.length < all.length);
const never = [...unresolved.entries()].filter(([, vs]) => vs.length === all.length);

console.log(`\n  MISSING ON SOME VERSIONS (${partial.length}) -- alias candidates:`);
for (const [metric, vs] of partial.sort((a, b) => a[0].localeCompare(b[0]))) {
  console.log(`    ${metric}`);
  console.log(`      absent: ${vs.join(', ')}`);
  // Suggest a replacement: a path present on the failing versions whose tail matches.
  const tail = exprPaths(parseExpr(metric))[0]?.split('.').slice(-2).join('.');
  if (tail !== undefined) {
    const near = new Set<string>();
    for (const v of vs) {
      for (const p of catalogues.get(v) ?? []) {
        if (p.endsWith(tail) && !p.includes('concurrentTransactions')) near.add(p);
      }
    }
    if (near.size > 0 && near.size <= 6) {
      console.log(`      candidates: ${[...near].join(', ')}`);
    }
  }
}

console.log(`\n  MISSING EVERYWHERE (${never.length}) -- template may be wrong:`);
for (const [metric] of never.sort((a, b) => a[0].localeCompare(b[0]))) {
  console.log(`    ${metric}`);
}

// Paths that appear or disappear between adjacent versions, restricted to sections the
// dashboard cares about -- the raw material for future alias entries.
if (all.length > 1) {
  console.log('\nsection-level drift between adjacent versions');
  console.log('-'.repeat(52));
  for (let i = 1; i < all.length; i++) {
    const prev = catalogues.get(all[i - 1]!)!;
    const curr = catalogues.get(all[i]!)!;
    const strip = (p: string): string => p.replace(/^(shard|router|configsvr|common)\./, '');
    const prevStripped = new Set([...prev].map(strip));
    const currStripped = new Set([...curr].map(strip));

    const gone = [...prevStripped].filter((p) => !currStripped.has(p));
    const added = [...currStripped].filter((p) => !prevStripped.has(p));
    console.log(`  ${all[i - 1]} -> ${all[i]}: -${gone.length} +${added.length}`);
  }
}
