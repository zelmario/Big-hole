/**
 * Which dashboard panels a capture cannot draw, and exactly why.
 *
 * A panel whose metrics do not resolve is dropped rather than drawn empty, which is the right
 * behaviour and a terrible way to find out something is wrong -- the panel simply is not there
 * and nothing says so. This prints the drop list with the offending paths, plus near-miss
 * candidates from the capture's own catalogue, which is what turns "some panels disappear"
 * into either "that server genuinely lacks the metric" or "we need an alias".
 *
 *   npm run coverage -- /path/to/diagnostic.data
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { decodeFTDC } from '../src/ftdc/index.js';
import { NodeFileStore } from '../src/data/nodeFileStore.js';
import { CaptureWriter } from '../src/data/writer.js';
import { DEFAULT_TEMPLATES } from '../src/dashboard/defaultDashboard.js';
import { detectRolePrefixes, expandMetric } from '../src/dashboard/layout.js';
import { exprPaths, parseExpr } from '../src/data/expr.js';

const dir = process.argv[2];
if (dir === undefined) throw new Error('usage: npm run coverage -- <diagnostic.data dir>');

const tmp = await mkdtemp(join(tmpdir(), 'cov-'));
try {
  const store = new NodeFileStore(tmp);
  const writer = await CaptureWriter.create(store, { captureId: 'c', sourceFile: dir });
  for (const name of readdirSync(dir).filter((f) => f.startsWith('metrics.')).sort()) {
    const file = join(dir, name);
    if (!statSync(file).isFile()) continue;
    for (const chunk of decodeFTDC(new Uint8Array(readFileSync(file)))) await writer.addChunk(chunk);
  }
  const manifest = await writer.finish();
  const available = new Set(manifest.paths);
  const prefixes = detectRolePrefixes(available);

  console.log(`${dir}`);
  console.log(`  ${manifest.paths.length} paths · roles [${prefixes.join(', ') || 'none'}]\n`);

  /** Paths that look like the one asked for, to suggest an alias. */
  function nearMisses(path: string): string[] {
    const tail = path.split('.').slice(-2).join('.').toLowerCase();
    const leaf = path.split('.').pop()!.toLowerCase();
    return [...available]
      .filter((p) => {
        const low = p.toLowerCase();
        return low.endsWith(tail) || low.endsWith(`.${leaf}`);
      })
      .slice(0, 4);
  }

  let charts = 0;
  let drawn = 0;
  const partial: string[] = [];

  for (const template of DEFAULT_TEMPLATES) {
    if (template.kind === 'section') continue;
    charts++;

    const resolved = template.metrics.map((m) => ({
      metric: m,
      series: expandMetric(m, available, prefixes),
    }));
    const got = resolved.filter((r) => r.series.length > 0);

    if (got.length === 0) {
      console.log(`DROPPED  ${template.title}`);
      for (const r of resolved) {
        console.log(`    ✗ ${r.metric}`);
        for (const path of exprPaths(parseExpr(r.metric))) {
          if (path.includes('*')) continue;
          if (available.has(path)) continue;
          const hints = nearMisses(path);
          console.log(`        missing: ${path}`);
          if (hints.length > 0) console.log(`        maybe:   ${hints.join('  ')}`);
        }
      }
      continue;
    }

    drawn++;
    if (got.length < resolved.length) {
      partial.push(
        `PARTIAL  ${template.title} — ${got.length}/${resolved.length} metrics\n` +
          resolved
            .filter((r) => r.series.length === 0)
            .map((r) => `    ✗ ${r.metric}`)
            .join('\n'),
      );
    }
  }

  if (partial.length > 0) console.log(`\n${partial.join('\n')}`);
  console.log(`\n${drawn}/${charts} panels draw something.`);
} finally {
  await rm(tmp, { recursive: true, force: true });
}
