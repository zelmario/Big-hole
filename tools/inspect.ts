/**
 * Inspect a real FTDC capture from the command line.
 *
 * Decodes, ingests, and reports throughput, storage efficiency, and the things that matter
 * before any chart exists: sample cadence, gaps, restarts, catalog size. Useful for
 * validating a customer capture without opening a browser, and for checking that the numbers
 * measured on synthetic fixtures hold on real data.
 *
 *   npm run inspect -- /path/to/diagnostic.data
 *   npm run inspect -- /path/to/metrics.2026-07-21T18-09-21Z-00000
 */

import { readFileSync, statSync, readdirSync } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';

import { decodeFTDC, readMetadata } from '../src/ftdc/index.js';
import { NodeFileStore } from '../src/data/nodeFileStore.js';
import { CaptureWriter } from '../src/data/writer.js';
import { CaptureReader } from '../src/data/reader.js';
import { defaultDashboard, detectRolePrefixes } from '../src/dashboard/layout.js';
import { DEFAULT_TEMPLATES } from '../src/dashboard/defaultDashboard.js';

const target = process.argv[2];
if (target === undefined) {
  console.error('usage: npm run inspect -- <diagnostic.data dir | metrics.* file>');
  process.exit(1);
}

function collect(path: string): string[] {
  const st = statSync(path);
  if (st.isFile()) return [path];
  return readdirSync(path)
    .filter((n) => n.startsWith('metrics.') && !n.endsWith('.jsonl'))
    .sort()
    .map((n) => join(path, n));
}

const files = collect(target);
if (files.length === 0) {
  console.error(`no metrics.* files found in ${target}`);
  process.exit(1);
}

const inputBytes = files.reduce((n, f) => n + statSync(f).size, 0);
console.log(`${files.length} file(s), ${(inputBytes / 1e6).toFixed(1)} MB on disk\n`);

const dir = await mkdtemp(join(tmpdir(), 'big-hole-inspect-'));
const store = new NodeFileStore(dir);

let hostname: string | undefined;
let mongoVersion: string | undefined;
let values = 0;
let decodeMs = 0;
const skipped: string[] = [];

const writer = await CaptureWriter.create(store, {
  captureId: 'c',
  sourceFile: target,
});

for (const file of files) {
  const bytes = new Uint8Array(readFileSync(file));

  if (hostname === undefined) {
    try {
      const meta = readMetadata(bytes);
      hostname = meta?.hostname;
      mongoVersion = meta?.version;
    } catch {
      /* metadata is optional */
    }
  }

  try {
    // Decode and write interleaved, exactly as the worker does. Buffering the chunks first
    // would be faster to write but would hold the whole decoded capture in memory -- the one
    // thing the storage layer exists to avoid.
    const t0 = performance.now();
    for (const chunk of decodeFTDC(bytes)) {
      values += chunk.sampleCount * chunk.keys.length;
      await writer.addChunk(chunk);
    }
    decodeMs += performance.now() - t0;
    process.stdout.write(`  ${basename(file)}: ${writer.progress.samples} samples\r`);
  } catch (err) {
    skipped.push(`${basename(file)}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const manifest = await writer.finish();
const stored = (await stat(join(dir, 'c', 'columns.bin'))).size;
const clock = (await stat(join(dir, 'c', 'time.bin'))).size;
const manifestBytes = (await stat(join(dir, 'c', 'manifest.json'))).size;
const dense = manifest.sampleCount * manifest.paths.length * 8;

const iso = (ms: number): string => new Date(ms).toISOString();
const varying = manifest.flat.filter((f) => !f).length;

console.log(`\n${'='.repeat(64)}`);
console.log(`host          ${hostname ?? 'unknown'}${mongoVersion ? `  (mongod ${mongoVersion})` : ''}`);
console.log(`window        ${iso(manifest.startMs)}  ->  ${iso(manifest.endMs)}`);
const hours = (manifest.endMs - manifest.startMs) / 3_600_000;
console.log(`duration      ${hours.toFixed(1)} h`);
console.log(`samples       ${manifest.sampleCount.toLocaleString()}`);
console.log(`cadence       ${(manifest.cadenceMs / 1000).toFixed(2)} s`);
console.log(`metrics       ${manifest.paths.length.toLocaleString()} (${varying.toLocaleString()} vary, ${(manifest.paths.length - varying).toLocaleString()} flat)`);
console.log(`chunks        ${manifest.chunks.offset.length.toLocaleString()} in ${manifest.schemas.length} schema(s)`);

console.log(`\n${'-'.repeat(64)}`);
console.log(`ingest        ${(decodeMs / 1000).toFixed(2)} s  ->  ${(values / decodeMs / 1000).toFixed(0)}M values/s  (decode + write, cold)`);
console.log(`values        ${(values / 1e6).toFixed(1)}M`);
console.log(`dense size    ${(dense / 1e6).toFixed(1)} MB`);
console.log(`stored        ${(stored / 1e6).toFixed(1)} MB  (${(dense / stored).toFixed(1)}x elision)`);
console.log(`resident      ${((clock + manifestBytes) / 1e6).toFixed(2)} MB  (clock + manifest)`);

if (manifest.gaps.length > 0) {
  console.log(`\n${'-'.repeat(64)}`);
  console.log(`GAPS (${manifest.gaps.length}) -- no samples collected`);
  console.log(`  mongod down, stalled, or host frozen. Note: gaps that recur at a fixed`);
  console.log(`  interval are usually the FTDC collector itself falling behind, not an outage.`);
  const worst = [...manifest.gaps].sort((a, b) => b.missingSamples - a.missingSamples).slice(0, 10);
  for (const g of worst) {
    const secs = ((g.toMs - g.fromMs) / 1000).toFixed(0);
    console.log(`  ${iso(g.fromMs)}  ${secs.padStart(7)}s  ${g.missingSamples} samples missing`);
  }
  if (manifest.gaps.length > 10) console.log(`  ... and ${manifest.gaps.length - 10} more`);
}

if (manifest.restarts.length > 0) {
  console.log(`\nRESTARTS (${manifest.restarts.length}) -- uptime went backwards`);
  for (const r of manifest.restarts.slice(0, 10)) console.log(`  ${iso(r)}`);
}

if (skipped.length > 0) {
  console.log(`\nSKIPPED (${skipped.length})`);
  for (const s of skipped) console.log(`  ${s}`);
}

// How much of the ported dashboard this capture can actually draw.
const paths = new Set(manifest.paths);
const roles = detectRolePrefixes(paths);
const dash = defaultDashboard(paths);
const charts = dash.panels.filter((p) => p.kind === 'chart');
const templates = DEFAULT_TEMPLATES.filter((p) => p.kind === 'chart');
console.log(`\n${'-'.repeat(64)}`);
console.log(`roles         ${roles.map((r) => r === '' ? '(none)' : r).join(', ') || '(none)'}`);
console.log(`dashboard     ${charts.length}/${templates.length} panels resolve, ` +
  `${charts.reduce((n, p) => n + p.metrics.length, 0)} series`);
const missing = templates.filter((t) => !charts.some((c) => c.title === t.title));
if (missing.length > 0) {
  console.log(`  empty: ${missing.map((m) => m.title).join(', ')}`);
}

// Read-path timing on the real catalog, not a synthetic one.
const reader = await CaptureReader.open(store, 'c');
const sample = manifest.paths.filter((_, i) => !manifest.flat[i]).slice(0, 40);
const t0 = performance.now();
for (const p of sample) await reader.getSeries(p, { maxPoints: 1200 });
const readMs = performance.now() - t0;
console.log(`\n${'-'.repeat(64)}`);
console.log(`read          ${sample.length} series @1200pt in ${readMs.toFixed(0)} ms  (${(readMs / Math.max(1, sample.length)).toFixed(2)} ms each)`);
await reader.close();

await rm(dir, { recursive: true, force: true });
