/**
 * Explain a window of a real capture, from the command line.
 *
 * Same purpose as `npm run checks`: a ranking is only worth anything if it puts the right thing
 * at the top on captures where you already know what happened, and the only way to find that
 * out is to run it over real bundles and read the list next to what you remember of the
 * incident. It also prints what the scan cost, which is the other half of whether this is
 * usable -- it reads full resolution over every column.
 *
 *   npm run explain -- <diagnostic.data dir> <from ISO> <to ISO>
 *   npm run explain -- <diagnostic.data dir> 2025-11-19T14:30:00Z 2025-11-19T14:40:00Z
 *
 * With no window, it explains the worst episode the M6 detectors found -- which is the gesture
 * the sidebar offers, end to end, without a browser.
 */

import { readFileSync, statSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';

import { decodeFTDC, readMetadata } from '../src/ftdc/index.js';
import { NodeFileStore } from '../src/data/nodeFileStore.js';
import { CaptureWriter } from '../src/data/writer.js';
import { CaptureReader } from '../src/data/reader.js';
import { formatValue } from '../src/data/format.js';
import { unitOfPath, type Unit } from '../src/data/expr.js';
import { detect } from '../src/insights/detect.js';
import { RULES } from '../src/insights/rules.js';
import {
  MAX_SCAN_SAMPLES,
  baselineFor,
  changeInputs,
  rankChanges,
  type Change,
} from '../src/insights/explain.js';
import type { SeriesQuery } from '../src/data/reader.js';

const [target, fromArg, toArg] = process.argv.slice(2);
if (target === undefined) {
  console.error('usage: npm run explain -- <diagnostic.data dir> [from ISO] [to ISO]');
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

const when = (ms: number): string => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

/** Same unit rule the sidebar row uses: a counter is compared per second. */
function unitFor(change: Change): Unit {
  const base = unitOfPath(change.path);
  if (change.kind === 'level') return base;
  return base === 'bytes' ? 'bytes/s' : 'per-sec';
}

const dir = await mkdtemp(join(tmpdir(), 'ftdc-lens-explain-'));
const store = new NodeFileStore(dir);
let reader: CaptureReader | undefined;

try {
  const files = collect(target);
  if (files.length === 0) {
    console.error(`no metrics.* files in ${target}`);
    process.exit(1);
  }

  const writer = await CaptureWriter.create(store, { captureId: 'c0', sourceFile: target });
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
    } catch {
      /* a partially written file must not sink the capture */
    }
  }
  const manifest = await writer.finish({
    ...(hostname !== undefined ? { hostname } : {}),
    ...(mongoVersion !== undefined ? { mongoVersion } : {}),
  });
  reader = await CaptureReader.open(store, 'c0');

  console.log(
    `${hostname ?? basename(target)} · ${manifest.sampleCount.toLocaleString()} samples · ` +
      `${manifest.paths.length.toLocaleString()} metrics · ${mongoVersion ?? '?'}`,
  );
  console.log(`${when(manifest.startMs)} -> ${when(manifest.endMs)}\n`);

  let fromMs: number;
  let toMs: number;

  if (fromArg !== undefined && toArg !== undefined) {
    fromMs = Date.parse(fromArg);
    toMs = Date.parse(toArg);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
      console.error('from/to must be ISO timestamps, e.g. 2025-11-19T14:30:00Z');
      process.exit(1);
    }
  } else {
    // No window given: explain the worst thing the detectors found, which is the sidebar's
    // "explain this episode" button taken end to end.
    const source = {
      async series(_captureId: string, expressions: string[], query: SeriesQuery) {
        const out = await Promise.all(expressions.map((e) => reader!.getSeries(e, query)));
        return out.map((s) => ({ path: s.path, t: s.t, min: s.min, max: s.max, mean: s.mean, raw: s.raw }));
      },
    };
    const findings = await detect(
      source,
      [{ id: 'c0', label: hostname ?? 'node', paths: new Set(manifest.paths) }],
      RULES,
      { maxPoints: 20_000 },
    );
    const worst = findings[0];
    if (worst === undefined) {
      console.error('no finding to explain, and no window given — pass a from/to');
      process.exit(1);
    }
    const width = Math.max(worst.worstToMs - worst.worstFromMs, 60_000);
    fromMs = worst.worstFromMs - width;
    toMs = worst.worstToMs + width;
    console.log(`explaining the worst finding: ${worst.title} (${worst.metric})\n`);
  }

  const window = { fromMs, toMs };
  const baseline = baselineFor(window, { fromMs: manifest.startMs, toMs: manifest.endMs });
  if (baseline === null) {
    console.error('no room for a baseline beside that window — narrow it');
    process.exit(1);
  }

  console.log(`window   ${when(fromMs)} -> ${when(toMs)}`);
  console.log(`baseline ${when(baseline.fromMs)} -> ${when(baseline.toMs)}\n`);

  const t0 = performance.now();
  let win, base;
  try {
    [win, base] = await Promise.all([
      reader.scan({ from: fromMs, to: toMs, maxSamples: MAX_SCAN_SAMPLES }),
      reader.scan({ from: baseline.fromMs, to: baseline.toMs, maxSamples: MAX_SCAN_SAMPLES }),
    ]);
  } catch (err) {
    // The sample cap, almost always. It is a real answer -- narrow the window -- so it prints
    // as one rather than as a stack trace.
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  const scanMs = performance.now() - t0;

  const inputs = changeInputs(
    base,
    win,
    (path) => reader!.rangeOf(path),
    manifest.endMs - manifest.startMs,
  );
  const changes = rankChanges(inputs, { limit: 40 });

  console.log(
    `scanned ${inputs.length.toLocaleString()} metrics in ${scanMs.toFixed(0)} ms ` +
      `-> ${changes.length} change(s)\n`,
  );

  for (const change of changes) {
    const unit = unitFor(change);
    const arrow = change.window >= change.base ? 'up  ' : 'down';
    console.log(
      `${change.score.toFixed(1).padStart(8)}  ${arrow}  ` +
        `${formatValue(change.base, unit).padStart(12)} -> ${formatValue(change.window, unit).padEnd(12)}` +
        `  ${change.kind === 'rate' ? '/s ' : '   '}${change.path}`,
    );
  }
  console.log('');
} finally {
  await reader?.close();
  await rm(dir, { recursive: true, force: true });
}
