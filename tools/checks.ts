/**
 * Run the M6 pathology checks over a real capture, from the command line.
 *
 * The point is calibration, not convenience. Thresholds that look reasonable in a rule file
 * are only worth anything if they fire on captures where something was actually wrong and stay
 * quiet on captures where nothing was -- and the only way to know that is to run them over
 * real bundles and read the output next to what you already know about the incident.
 *
 *   npm run checks -- /path/to/diagnostic.data
 *   npm run checks -- /path/to/node1/diagnostic.data /path/to/node2/diagnostic.data
 */

import { readFileSync, statSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';

import { decodeFTDC, readMetadata } from '../src/ftdc/index.js';
import { NodeFileStore } from '../src/data/nodeFileStore.js';
import { CaptureWriter } from '../src/data/writer.js';
import { CaptureReader } from '../src/data/reader.js';
import { detectRolePrefixes, expandMetric } from '../src/dashboard/layout.js';
import { formatValue } from '../src/data/format.js';
import { detect, type DetectCapture } from '../src/insights/detect.js';
import { RULES } from '../src/insights/rules.js';
import type { SeriesQuery } from '../src/data/reader.js';

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error('usage: npm run checks -- <diagnostic.data dir> [more dirs...]');
  process.exit(1);
}

function collect(path: string): string[] {
  const st = statSync(path);
  if (st.isFile()) return [path];
  return readdirSync(path)
    .filter((n) => n.startsWith('metrics.') && !n.includes(':'))
    .sort()
    .map((n) => join(path, n));
}

const dir = await mkdtemp(join(tmpdir(), 'big-hole-checks-'));
const store = new NodeFileStore(dir);
const readers = new Map<string, CaptureReader>();
const captures: DetectCapture[] = [];

try {
  for (let i = 0; i < targets.length; i++) {
    const target = targets[i]!;
    const files = collect(target);
    if (files.length === 0) {
      console.error(`no metrics.* files in ${target}`);
      continue;
    }

    const captureId = `c${i}`;
    const writer = await CaptureWriter.create(store, { captureId, sourceFile: target });
    let hostname: string | undefined;
    let mongoVersion: string | undefined;

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
        for (const chunk of decodeFTDC(bytes)) await writer.addChunk(chunk);
        process.stdout.write(`  ${basename(file)}\r`);
      } catch {
        /* a partially written file must not sink the capture */
      }
    }

    const manifest = await writer.finish({
      ...(hostname !== undefined ? { hostname } : {}),
      ...(mongoVersion !== undefined ? { mongoVersion } : {}),
    });
    const reader = await CaptureReader.open(store, captureId);
    readers.set(captureId, reader);

    const label = hostname ?? basename(target);
    captures.push({ id: captureId, label, paths: new Set(reader.catalog.map((c) => c.path)) });

    const hours = (manifest.endMs - manifest.startMs) / 3.6e6;
    console.log(
      `${label.padEnd(46)} ${captureId} · ${manifest.sampleCount.toLocaleString()} samples · ` +
        `${hours.toFixed(1)} h · ${mongoVersion ?? '?'}`,
    );
  }

  const source = {
    async series(captureId: string, expressions: string[], query: SeriesQuery) {
      const reader = readers.get(captureId)!;
      const out = await Promise.all(expressions.map((e) => reader.getSeries(e, query)));
      return out.map((s) => ({
        path: s.path,
        t: s.t,
        min: s.min,
        max: s.max,
        mean: s.mean,
        raw: s.raw,
      }));
    },
  };

  const t0 = performance.now();
  // Same bucket width the app uses, so what prints here is what a reader would see.
  const findings = await detect(source, captures, RULES, { maxPoints: 20_000 });
  const ms = performance.now() - t0;

  console.log('\n' + '='.repeat(78));
  console.log(
    `${RULES.length} rules over ${captures.length} capture(s) in ${ms.toFixed(0)} ms ` +
      `-> ${findings.length} finding(s)\n`,
  );

  if (findings.length === 0) {
    console.log('  nothing fired.\n');
  }

  const when = (msEpoch: number): string =>
    new Date(msEpoch).toISOString().replace('T', ' ').slice(0, 19);

  for (const finding of findings) {
    const tag = finding.severity.toUpperCase().padEnd(8);
    console.log(`${tag} ${finding.title}  [${finding.captureLabel}]`);
    // Both spans, because they answer different questions: how long the pathology was a
    // feature of this capture at all, and which single stretch to go and look at.
    console.log(
      `         seen  ${when(finding.firstMs)} -> ${when(finding.lastMs)}` +
        `  (${finding.episodes} episode(s), ${(finding.totalMs / 1000).toFixed(0)}s in state,` +
        ` worst ${formatValue(finding.peak, finding.unit)})`,
    );
    console.log(`         worst ${when(finding.worstFromMs)} -> ${when(finding.worstToMs)}`);
    console.log(`         ${finding.metric}`);
    console.log(`         ${finding.what}`);
    console.log('');
  }

  // Which rules could not even be evaluated here. A rule that silently fails to resolve looks
  // identical to a rule that found nothing, and that is the failure mode this whole project
  // keeps running into.
  const unresolved = RULES.filter((rule) =>
    captures.every((c) => !resolves(rule.metric, c.paths)),
  );
  if (unresolved.length > 0) {
    console.log('rules no capture could resolve (renamed metric, or absent on this build):');
    for (const rule of unresolved) console.log(`  ${rule.id}  ${rule.metric}`);
  }
} finally {
  for (const reader of readers.values()) await reader.close?.();
  await rm(dir, { recursive: true, force: true });
}

/** Cheap resolution check for the report above; mirrors what detect() does internally. */
function resolves(metric: string, paths: ReadonlySet<string>): boolean {
  return expandMetric(metric, paths, detectRolePrefixes(paths)).length > 0;
}
