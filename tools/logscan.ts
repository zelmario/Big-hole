/**
 * Run the log analyzer over a real mongod.log and report what it made of it.
 *
 *   npm run logscan -- /path/to/mongod.log
 */
import { createReadStream, openAsBlob } from 'node:fs';
import { createInterface } from 'node:readline';
import { rangeFor } from '../src/logs/locate.js';
import { LogAnalyzer } from '../src/logs/analyze.js';

const path = process.argv[2];
if (path === undefined) throw new Error('usage: npm run logscan -- <mongod.log>');

// Optional window, exactly as the app passes the capture's span.
const fromArg = process.argv[3];
const toArg = process.argv[4];
if (fromArg !== undefined && toArg !== undefined) {
  const blob = await openAsBlob(path);
  const t0 = Date.now();
  const range = await rangeFor(blob, Date.parse(fromArg), Date.parse(toArg));
  console.log(
    `window ${fromArg} .. ${toArg}\n  located in ${Date.now() - t0} ms: bytes ` +
      `${(range.from / 1e6).toFixed(0)}–${(range.to / 1e6).toFixed(0)} MB of ` +
      `${(blob.size / 1e6).toFixed(0)} MB ` +
      `(${(((range.to - range.from) / blob.size) * 100).toFixed(1)}% of the file)`,
  );
}

// Streamed, exactly as the worker does it: never hold the lines.
const started = Date.now();
const analyzer = new LogAnalyzer();
const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
for await (const line of rl) analyzer.push(line);
const analysis = analyzer.finish();
const ms = Date.now() - started;
const peak = Math.round(process.memoryUsage().heapUsed / 1e6);
const { stats } = analysis;

console.log(`${path}`);
console.log(`  ${stats.parsed.toLocaleString()} lines parsed in ${ms} ms ` +
  `(${Math.round(stats.parsed / (ms / 1000)).toLocaleString()} lines/s), ` +
  `${stats.text} text, ${stats.malformed} malformed, heap ${peak} MB, ` +
  `bucket ${analysis.stats.bucketMs / 1000}s`);
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
