/**
 * Audit every dashboard series against real data.
 *
 * Prints the expression, its inferred unit, and a formatted median value. Unit bugs are
 * invisible in code review and obvious here: memory in KiB when it should be GiB, a gauge
 * wrapped in rate() reading "0.5/s".
 *
 *   npm run units -- /path/to/diagnostic.data
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeFTDC } from '../src/ftdc/index.js';
import { NodeFileStore } from '../src/data/nodeFileStore.js';
import { CaptureWriter } from '../src/data/writer.js';
import { CaptureReader } from '../src/data/reader.js';
import { defaultDashboard } from '../src/dashboard/layout.js';
import { formatValue } from '../src/data/format.js';
import { parseExpr, unitOf } from '../src/data/expr.js';

const dir = process.argv[2]!;
const tmp = await mkdtemp(join(tmpdir(), 'u-'));
const store = new NodeFileStore(tmp);
const w = await CaptureWriter.create(store, { captureId: 'c', sourceFile: dir });
for (const n of readdirSync(dir).filter((f) => f.startsWith('metrics.')).sort()) {
  const f = join(dir, n);
  if (!statSync(f).isFile()) continue;
  for (const ch of decodeFTDC(new Uint8Array(readFileSync(f)))) await w.addChunk(ch);
}
const man = await w.finish();
const r = await CaptureReader.open(store, 'c');

for (const p of defaultDashboard(new Set(man.paths)).panels) {
  if (p.kind !== 'chart') continue;
  console.log(`\n[${p.title}]  unit=${p.unit ?? 'auto'}`);
  for (const m of p.metrics) {
    const s = await r.getSeries(m, { maxPoints: 200 });
    const vals = Array.from(s.mean).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    const med = vals.length ? vals[vals.length >> 1]! : NaN;
    // The envelope max, not the max of bucket means -- otherwise peaks are understated by
    // exactly the amount downsampling smooths away, which is the thing worth seeing.
    const peaks = Array.from(s.max).filter((v) => Number.isFinite(v));
    const max = peaks.length ? Math.max(...peaks) : NaN;
    const unit = p.unit ?? unitOf(parseExpr(m));
    console.log(
      `   ${formatValue(med, unit).padStart(12)}  max ${formatValue(max, unit).padStart(12)}   ${m}`,
    );
  }
}
await r.close();
await rm(tmp, { recursive: true, force: true });
