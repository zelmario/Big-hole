/**
 * Print the member-state timeline and the node info page for real captures, from the command
 * line.
 *
 * The same argument as `npm run checks`: both of these *assert* something about a server, and
 * an assertion is only worth anything if it has been read next to a capture you already know.
 * A strip that claims a member was SECONDARY through an FTDC outage, or an info page that
 * reports a cache size off by a factor of 1024, is worse than no answer at all -- and neither
 * failure shows up against a synthetic fixture.
 *
 *   npm run replset -- /path/to/diagnostic.data
 *   npm run replset -- /path/to/node1/diagnostic.data /path/to/node2/diagnostic.data
 */

import { readFileSync, statSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';

import { decodeFTDC, readMetadata } from '../src/ftdc/index.js';
import { NodeFileStore } from '../src/data/nodeFileStore.js';
import { CaptureWriter } from '../src/data/writer.js';
import { CaptureReader, type SeriesQuery } from '../src/data/reader.js';
import { buildMemberRows, stateName, type StateCapture } from '../src/replset/state.js';
import { nodeFields, type InfoCapture } from '../src/replset/hostInfo.js';

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error('usage: npm run replset -- <diagnostic.data dir> [more dirs...]');
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

const dir = await mkdtemp(join(tmpdir(), 'big-hole-replset-'));
const store = new NodeFileStore(dir);
const readers = new Map<string, CaptureReader>();
const stateCaptures: StateCapture[] = [];
const infoCaptures: InfoCapture[] = [];

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
    let meta: Record<string, unknown> | undefined;

    for (const file of files) {
      const bytes = new Uint8Array(readFileSync(file));
      if (meta === undefined) {
        try {
          const found = readMetadata(bytes);
          hostname = found?.hostname;
          mongoVersion = found?.version;
          meta = found?.doc as Record<string, unknown> | undefined;
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
      ...(meta !== undefined ? { meta } : {}),
    });
    const reader = await CaptureReader.open(store, captureId);
    readers.set(captureId, reader);

    const label = hostname ?? basename(target);
    const paths = new Set(reader.catalog.map((c) => c.path));
    stateCaptures.push({ id: captureId, label, paths, catalog: reader.catalog });
    infoCaptures.push({
      id: captureId,
      label,
      paths,
      catalog: reader.catalog,
      ...(manifest.meta !== undefined ? { meta: manifest.meta } : {}),
      startMs: manifest.startMs,
      endMs: manifest.endMs,
      sampleCount: manifest.sampleCount,
      cadenceMs: manifest.cadenceMs,
      gaps: manifest.gaps.length,
      restarts: manifest.restarts.length,
      ...(mongoVersion !== undefined ? { mongoVersion } : {}),
    });
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
  const rows = await buildMemberRows(source, stateCaptures);
  const ms = performance.now() - t0;

  console.log('\n' + '='.repeat(78));
  console.log(`member state — ${rows.length} row(s) built in ${ms.toFixed(0)} ms\n`);
  if (rows.length === 0) console.log('  no replSetGetStatus in these captures (standalone?)\n');

  for (const row of rows) {
    const via = row.self ? 'self' : `via ${row.reportedBy}`;
    const id = row.memberId === null ? '' : ` _id=${row.memberId}`;
    console.log(`${row.label}${id}  (${via})`);
    for (const run of row.runs) {
      const mins = (run.toMs - run.fromMs) / 60000;
      console.log(
        `    ${when(run.fromMs)} -> ${when(run.toMs)}  ${stateName(run.state).padEnd(10)} ${mins.toFixed(1)}m`,
      );
    }
    console.log('');
  }

  console.log('='.repeat(78));
  console.log('node info\n');
  for (const capture of infoCaptures) {
    console.log(`--- ${capture.label} (${capture.id}) ---`);
    let section = '';
    for (const field of nodeFields(capture)) {
      if (field.section !== section) {
        section = field.section;
        console.log(`  [${section}]`);
      }
      console.log(`    ${field.label.padEnd(30)} ${field.value}`);
    }
    console.log('');
  }
} finally {
  for (const reader of readers.values()) await reader.close?.();
  await rm(dir, { recursive: true, force: true });
}
