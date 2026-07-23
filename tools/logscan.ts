/**
 * Run the log analyzer over a real mongod.log and report what it made of it.
 *
 *   npm run logscan -- /path/to/mongod.log
 */
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { analyzeLines } from '../src/logs/analyze.js';

const path = process.argv[2];
if (path === undefined) throw new Error('usage: npm run logscan -- <mongod.log>');

const lines: string[] = [];
const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
for await (const line of rl) lines.push(line);

const started = Date.now();
const analysis = analyzeLines(lines);
const ms = Date.now() - started;
const { stats } = analysis;

console.log(`${path}`);
console.log(`  ${stats.parsed.toLocaleString()} lines parsed in ${ms} ms ` +
  `(${Math.round(stats.parsed / (ms / 1000)).toLocaleString()} lines/s), ` +
  `${stats.text} text, ${stats.malformed} malformed`);
console.log(`  span ${new Date(stats.firstMs).toISOString()} -> ${new Date(stats.lastMs).toISOString()}`);
console.log(`\n  ${analysis.events.length} annotations kept:`);
const byKind = new Map<string, number>();
for (const e of analysis.events) byKind.set(e.kind, (byKind.get(e.kind) ?? 0) + 1);
for (const [kind, n] of [...byKind].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${String(n).padStart(5)}  ${kind}`);
}
console.log(`\n  demoted to series (too frequent to draw):`);
for (const d of analysis.stats.demoted) console.log(`    ${String(d.count).padStart(6)}  ${d.kind}`);
console.log(`\n  series available as metrics:`);
for (const p of Object.keys(analysis.series).sort()) {
  const v = analysis.series[p]!.v;
  const finite = Array.from(v).filter(Number.isFinite);
  const peak = finite.length ? Math.max(...finite) : 0;
  console.log(`    ${p.padEnd(34)} peak ${peak.toFixed(1)}`);
}
console.log(`\n  first 12 annotations:`);
for (const e of analysis.events.slice(0, 12)) {
  console.log(`    ${new Date(e.tMs).toISOString()} [${e.severity}] ${e.label}: ${e.message}` +
    (e.detail ? ` (${e.detail.slice(0, 90)})` : ''));
}
