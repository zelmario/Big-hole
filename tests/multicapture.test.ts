/**
 * M4: several captures at once.
 *
 * The failure modes here are quiet ones. Three members' files merged into a single capture
 * still produces a chart -- just an incoherent one. A cross-host difference computed without
 * aligning the clocks still produces a line -- just one that shows lag where there is none.
 * Neither raises an error, so both are tested against known-good values rather than "does it
 * render".
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { decodeFTDC } from '../src/ftdc/index.js';
import { NodeFileStore } from '../src/data/nodeFileStore.js';
import { CaptureWriter } from '../src/data/writer.js';
import { CaptureReader } from '../src/data/reader.js';
import { groupCaptures, labelFor, type SourceFile } from '../src/ingest/discover.js';
import {
  alignOnto,
  capturesOf,
  planExpr,
  qualifyExpr,
  splitRef,
  stripCaptures,
} from '../src/data/qualify.js';
import { parseExpr, exprToString } from '../src/data/expr.js';
import {
  fetchPanelData,
  planPanel,
  unitOfMetric,
  type CaptureRef,
  type SeriesSource,
} from '../src/data/panelData.js';
import { crossHostPanels, referenceCapture } from '../src/dashboard/crossHost.js';
import { legendLabel, plotColumn, timeColumn } from '../src/panels/plotData.js';
import { discoverFixtures } from './oracle.js';

const known = (id: string): boolean => id === 'c0' || id === 'c1';

/* ------------------------------------------------------------- grouping ---- */

function source(path: string): SourceFile {
  return { file: new File([], path.split('/').pop()!), path };
}

describe('grouping dropped files into captures', () => {
  it('keeps each replica-set member separate', () => {
    const groups = groupCaptures([
      source('bundle/node1/diagnostic.data/metrics.2026-07-20T00-00-00Z-00000'),
      source('bundle/node1/diagnostic.data/metrics.interim'),
      source('bundle/node2/diagnostic.data/metrics.2026-07-20T00-00-00Z-00000'),
      source('bundle/node3/diagnostic.data/metrics.2026-07-20T00-00-00Z-00000'),
    ]);

    expect(groups).toHaveLength(3);
    expect(groups.map((g) => g.label)).toEqual(['node1', 'node2', 'node3']);
    // Merging these would interleave three servers' metrics under one set of paths and
    // silently produce a timeline no node ever had.
    expect(groups[0]!.files).toHaveLength(2);
  });

  it('treats a bare diagnostic.data folder as one capture, as before M4', () => {
    const groups = groupCaptures([
      source('diagnostic.data/metrics.2026-07-20T00-00-00Z-00000'),
      source('diagnostic.data/metrics.interim'),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.files).toHaveLength(2);
  });

  it('ignores everything that is not FTDC', () => {
    const groups = groupCaptures([
      source('node1/diagnostic.data/metrics.2026-07-20T00-00-00Z-00000'),
      source('node1/diagnostic.data/mongod.lock'),
      source('node1/mongod.log'),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.files).toHaveLength(1);
  });

  it('names a node by the first non-generic directory above its FTDC', () => {
    expect(labelFor('bundle/mongo-2/var/lib/mongodb/data/db/diagnostic.data')).toBe('mongo-2');
    expect(labelFor('diagnostic.data')).toBe('diagnostic.data');
  });

  it('keeps two identically named folders apart', () => {
    const groups = groupCaptures([
      source('a/data/diagnostic.data/metrics.1'),
      source('b/data/diagnostic.data/metrics.1'),
    ]);
    expect(new Set(groups.map((g) => g.label)).size).toBe(2);
  });

  it('sorts files chronologically within a capture', () => {
    const groups = groupCaptures([
      source('n/diagnostic.data/metrics.interim'),
      source('n/diagnostic.data/metrics.2026-07-21T00-00-00Z-00000'),
      source('n/diagnostic.data/metrics.2026-07-20T00-00-00Z-00000'),
    ]);
    expect(groups[0]!.files.map((f) => f.name)).toEqual([
      'metrics.2026-07-20T00-00-00Z-00000',
      'metrics.2026-07-21T00-00-00Z-00000',
      'metrics.interim', // the tail, and it sorts last on its own
    ]);
  });
});

/* ------------------------------------------------------------ qualifiers ---- */

describe('capture-qualified paths', () => {
  it('only splits on a capture that is loaded', () => {
    expect(splitRef('c1:serverStatus.mem.resident', known)).toEqual({
      captureId: 'c1',
      path: 'serverStatus.mem.resident',
    });
    // A real FTDC path is not a tame identifier. Anything not naming a loaded capture is
    // part of the path, or a metric would become unresolvable the first time one contains a
    // colon.
    expect(splitRef('systemMetrics.mounts./run:foo.bar', known).captureId).toBeNull();
    expect(splitRef('c9:serverStatus.mem.resident', known).captureId).toBeNull();
  });

  it('qualifies only the paths that are not already pinned', () => {
    const out = qualifyExpr('div(a.b, c1:c.d)', 'c0', known);
    expect(out).toBe('div(c0:a.b, c1:c.d)');
  });

  it('strips qualifiers back to something a single reader understands', () => {
    const stripped = stripCaptures(parseExpr('diff(c0:a.b, c1:a.b)'), known);
    expect(exprToString(stripped)).toBe('diff(a.b, a.b)');
  });

  it('attributes unqualified paths to the fallback capture', () => {
    expect([...capturesOf(parseExpr('diff(a.b, c1:a.b)'), known, 'c0')].sort()).toEqual([
      'c0',
      'c1',
    ]);
  });
});

describe('splitting an expression across captures', () => {
  it('sends a single-capture expression to one reader whole', () => {
    const plan = planExpr('rate(serverStatus.opcounters.query)', 'c0', known);
    expect(plan.single).toBe(true);
    expect(plan.parts).toEqual([
      { key: '#0', captureId: 'c0', expression: 'rate(serverStatus.opcounters.query)' },
    ]);
  });

  it('keeps each side of a cross-host expression whole', () => {
    // The rate() must stay inside the part, so it is computed at full resolution by the
    // reader that owns the data. Splitting at the leaves instead would rate() over
    // already-bucketed means and smear exactly the spikes the envelope exists to keep.
    const plan = planExpr('div(rate(c0:a.b), rate(c1:a.b))', 'c0', known);
    expect(plan.single).toBe(false);
    expect(plan.parts).toEqual([
      { key: '#0', captureId: 'c0', expression: 'rate(a.b)' },
      { key: '#1', captureId: 'c1', expression: 'rate(a.b)' },
    ]);
    expect(exprToString(plan.combine)).toBe('div(#0, #1)');
  });

  it('splits no further than it has to', () => {
    const plan = planExpr('diff(pct(c0:a.b, c0:c.d), c1:a.b)', 'c0', known);
    expect(plan.parts.map((p) => p.expression)).toEqual(['pct(a.b, c.d)', 'a.b']);
  });
});

describe('aligning two nodes onto one clock', () => {
  const grid = Float64Array.from([1000, 2000, 3000, 4000]);

  it('takes the sample nearest in time to each grid point', () => {
    const t = Float64Array.from([900, 2100, 3100]);
    const v = Float64Array.from([10, 20, 30]);
    expect(Array.from(alignOnto(grid, t, v, 5000))).toEqual([10, 20, 30, 30]);
  });

  it('goes blank rather than reaching for a distant sample', () => {
    // A node whose capture ends early, or that has a gap, must not keep contributing its last
    // sample: a lag chart would show a clean linear climb that is entirely an artefact of the
    // missing data.
    const t = Float64Array.from([2500]);
    const v = Float64Array.from([7]);
    const out = alignOnto(grid, t, v, 800);
    expect(Number.isNaN(out[0]!)).toBe(true); // 1500 ms away
    expect(out[1]).toBe(7);
    expect(out[2]).toBe(7);
    expect(Number.isNaN(out[3]!)).toBe(true);
  });

  it('survives an empty series', () => {
    const out = alignOnto(grid, new Float64Array(0), new Float64Array(0), 5000);
    expect(Array.from(out).every((v) => Number.isNaN(v))).toBe(true);
  });
});

/* ------------------------------------------------------------ panel plan ---- */

function ref(id: string, label: string, paths: string[], cadenceMs = 1000): CaptureRef {
  return { id, label, paths: new Set(paths), cadenceMs };
}

describe('what a panel draws', () => {
  const a = ref('c0', 'node1', ['serverStatus.mem.resident', 'wt.cache']);
  const b = ref('c1', 'node2', ['serverStatus.mem.resident']);

  it('leaves a single-capture dashboard exactly as M3 had it', () => {
    const planned = planPanel(['serverStatus.mem.resident'], [a]);
    expect(planned).toEqual([
      {
        key: 'serverStatus.mem.resident',
        expression: 'serverStatus.mem.resident',
        captureId: 'c0',
        captureLabel: '',
      },
    ]);
  });

  it('fans one metric out to every node', () => {
    const planned = planPanel(['serverStatus.mem.resident'], [a, b]);
    expect(planned.map((p) => p.key)).toEqual([
      'c0:serverStatus.mem.resident',
      'c1:serverStatus.mem.resident',
    ]);
    expect(planned.map((p) => p.captureLabel)).toEqual(['node1', 'node2']);
  });

  it('skips a node that does not have the metric', () => {
    // A different server version, or an arbiter with no WiredTiger. One series, not an empty
    // second one.
    expect(planPanel(['wt.cache'], [a, b]).map((p) => p.captureId)).toEqual(['c0']);
  });

  it('does not fan out an expression that already names its captures', () => {
    const planned = planPanel(['diff(c0:serverStatus.mem.resident, c1:serverStatus.mem.resident)'], [a, b]);
    expect(planned).toHaveLength(1);
    expect(planned[0]!.captureId).toBeNull(); // belongs to no single host
    expect(planned[0]!.captureLabel).toBe('');
  });

  it('reads units through the qualifier', () => {
    expect(unitOfMetric('c1:serverStatus.mem.resident', known)).toBe('bytes');
  });
});

/* ---------------------------------------------------------- cross-host ---- */

describe('cross-host panels', () => {
  const paths = new Set([
    'serverStatus.repl.lastWrite.lastWriteDate',
    'serverStatus.localTime',
    'replSetGetStatus.myState',
  ]);

  it('compares every member against the primary', () => {
    const panels = crossHostPanels([
      { id: 'c0', label: 'sec1', paths, maxState: 2 },
      { id: 'c1', label: 'prim', paths, maxState: 1 },
      { id: 'c2', label: 'sec2', paths, maxState: 2 },
    ]);

    const lag = panels.find((p) => p.title.startsWith('Replication lag'));
    expect(lag?.title).toBe('Replication lag vs prim');
    expect(lag?.unit).toBe('ms');
    // Primary first in the difference, so a lagging secondary reads as positive lag.
    expect(lag?.metrics).toEqual([
      'diff(c1:serverStatus.repl.lastWrite.lastWriteDate, c0:serverStatus.repl.lastWrite.lastWriteDate)',
      'diff(c1:serverStatus.repl.lastWrite.lastWriteDate, c2:serverStatus.repl.lastWrite.lastWriteDate)',
    ]);
    expect(panels.some((p) => p.title.startsWith('Clock skew'))).toBe(true);
  });

  it('needs two nodes to exist at all', () => {
    expect(crossHostPanels([{ id: 'c0', label: 'only', paths, maxState: 1 }])).toEqual([]);
  });

  it('falls back to the first node when no primary is in the bundle', () => {
    const captures = [
      { id: 'c0', label: 'a', paths, maxState: 2 },
      { id: 'c1', label: 'b', paths, maxState: 2 },
    ];
    expect(referenceCapture(captures)?.id).toBe('c0');
  });

  it('drops a comparison the capture cannot resolve', () => {
    const bare = new Set(['serverStatus.localTime']);
    const panels = crossHostPanels([
      { id: 'c0', label: 'a', paths: bare },
      { id: 'c1', label: 'b', paths: bare },
    ]);
    expect(panels.some((p) => p.title.startsWith('Replication lag'))).toBe(false);
    expect(panels.some((p) => p.title.startsWith('Clock skew'))).toBe(true);
  });

  it('resolves through a role prefix, as a sharded 8.0 member reports it', () => {
    const sharded = new Set([
      'common.serverStatus.localTime',
      'shard.serverStatus.repl.lastWrite.lastWriteDate',
    ]);
    const panels = crossHostPanels([
      { id: 'c0', label: 'a', paths: sharded },
      { id: 'c1', label: 'b', paths: sharded },
    ]);
    const lag = panels.find((p) => p.title.startsWith('Replication lag'));
    expect(lag?.metrics[0]).toBe(
      'diff(c0:shard.serverStatus.repl.lastWrite.lastWriteDate, c1:shard.serverStatus.repl.lastWrite.lastWriteDate)',
    );
  });
});

/* ------------------------------------------------- cross-host evaluation ---- */

/**
 * Two nodes sampling 400 ms out of phase, the second 2 s behind on its last write.
 *
 * Both report a wall-clock-anchored value: at any instant T, node A's lastWriteDate is T and
 * node B's is T - 2000. The 400 ms phase difference is sampling, not lag, and the question is
 * how much of it leaks into the answer.
 */
function fakeSource(): SeriesSource {
  return {
    // eslint-disable-next-line @typescript-eslint/require-await
    series: async (captureId, expressions) =>
      expressions.map((expression) => {
        const offset = captureId === 'c1' ? 400 : 0;
        const behind = captureId === 'c1' ? 2000 : 0;
        const t = Float64Array.from([0, 1, 2, 3, 4], (i) => 10_000 + i * 1000 + offset);
        const v = Float64Array.from(t, (x) => x - behind);
        return { path: expression, t, min: v, max: v, mean: v, raw: true };
      }),
  };
}

describe('a metric computed across two nodes', () => {
  const a = ref('c0', 'primary', ['serverStatus.repl.lastWrite.lastWriteDate']);
  const b = ref('c1', 'secondary', ['serverStatus.repl.lastWrite.lastWriteDate']);

  it('measures the lag rather than the clock offset', async () => {
    const data = await fetchPanelData(
      fakeSource(),
      [
        'diff(c0:serverStatus.repl.lastWrite.lastWriteDate, c1:serverStatus.repl.lastWrite.lastWriteDate)',
      ],
      [a, b],
      { maxPoints: 0 },
    );

    expect(data.errors).toEqual([]);
    expect(data.series).toHaveLength(1);
    const values = Array.from(data.series[0]!.mean).filter((v) => !Number.isNaN(v));
    expect(values.length).toBeGreaterThan(0);
    // The true answer is 2000 ms. Two nodes sampling 1 s apart cannot resolve better than
    // about half a sample interval, so what is asserted is that the residual stays inside
    // that -- and in particular that the answer is not 2400 or 12000, which is what dropping
    // the alignment or the unit handling respectively would produce.
    for (const v of values) expect(Math.abs(v - 2000)).toBeLessThanOrEqual(500);
  });

  it('fans an unqualified metric out to both nodes instead', async () => {
    const data = await fetchPanelData(
      fakeSource(),
      ['serverStatus.repl.lastWrite.lastWriteDate'],
      [a, b],
      { maxPoints: 0 },
    );
    expect(data.series.map((s) => s.key)).toEqual([
      'c0:serverStatus.repl.lastWrite.lastWriteDate',
      'c1:serverStatus.repl.lastWrite.lastWriteDate',
    ]);
    expect(data.series.map((s) => s.captureLabel)).toEqual(['primary', 'secondary']);
  });

  it('keeps the other nodes when one fails', async () => {
    const flaky: SeriesSource = {
      series: async (captureId, expressions) => {
        if (captureId === 'c1') throw new Error('columns.bin is truncated');
        return fakeSource().series(captureId, expressions, {});
      },
    };

    const data = await fetchPanelData(
      flaky,
      ['serverStatus.repl.lastWrite.lastWriteDate'],
      [a, b],
      { maxPoints: 0 },
    );
    expect(data.series.map((s) => s.captureId)).toEqual(['c0']);
    expect(data.errors[0]).toContain('secondary');
  });
});

/* ------------------------------------------------------------ end to end ---- */

const fixtures = discoverFixtures();

describe.skipIf(fixtures.length === 0)('two real captures on one dashboard', () => {
  const fixture = fixtures[0]!;
  let dir: string;
  let readers: Map<string, CaptureReader>;
  let refs: CaptureRef[];

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ftdc-lens-m4-'));
    const store = new NodeFileStore(dir);
    const bytes = new Uint8Array(readFileSync(fixture.ftdc));

    readers = new Map();
    refs = [];
    // The same capture ingested twice: two independent stores, two readers, and a known
    // answer for every cross-host metric -- two copies of one node cannot lag each other.
    for (const id of ['c0', 'c1']) {
      const writer = await CaptureWriter.create(store, { captureId: id, sourceFile: fixture.ftdc });
      for (const chunk of decodeFTDC(bytes)) await writer.addChunk(chunk);
      await writer.finish();
      const reader = await CaptureReader.open(store, id);
      readers.set(id, reader);
      refs.push({
        id,
        label: id === 'c0' ? 'nodeA' : 'nodeB',
        paths: new Set(reader.manifest.paths),
        cadenceMs: reader.manifest.cadenceMs,
      });
    }
  }, 180_000);

  afterAll(async () => {
    for (const reader of readers?.values() ?? []) await reader.close();
    await rm(dir, { recursive: true, force: true });
  });

  const source = (): SeriesSource => ({
    series: async (captureId, expressions, query) =>
      Promise.all(expressions.map((e) => readers.get(captureId)!.getSeries(e, query))),
  });

  it('draws one series per node from a single panel definition', async () => {
    const data = await fetchPanelData(source(), ['start'], refs, { maxPoints: 200 });
    expect(data.errors).toEqual([]);
    expect(data.series.map((s) => s.key)).toEqual(['c0:start', 'c1:start']);
    expect(data.series[0]!.t.length).toBeGreaterThan(0);
  });

  it('differences two nodes to zero when they are the same node', async () => {
    const data = await fetchPanelData(source(), ['diff(c0:start, c1:start)'], refs, {
      maxPoints: 200,
    });
    expect(data.errors).toEqual([]);
    const values = Array.from(data.series[0]!.mean).filter((v) => !Number.isNaN(v));
    expect(values.length).toBeGreaterThan(10);
    expect(values.every((v) => v === 0)).toBe(true);
  });
});

/* ------------------------------------------------------------ plot columns ---- */

describe('handing a series to uPlot', () => {
  it('marks gaps with null, which is what uPlot understands', () => {
    // Verified in Chromium against the bundled uPlot: [NaN, 20, 30] gives series.min === NaN,
    // which makes the shared y scale NaN and draws NOTHING -- no line, no axis, for every
    // series in the panel. [null, 20, 30] ranges correctly. The storage layer uses NaN because
    // a gap has to be representable inside a Float64Array, so the conversion belongs at this
    // boundary.
    expect(plotColumn(Float64Array.from([NaN, 20, 30]))).toEqual([null, 20, 30]);
    expect(plotColumn(Float64Array.from([10, NaN, 30]))).toEqual([10, null, 30]);
    expect(plotColumn(Float64Array.from([10, 20, 30]))).toEqual([10, 20, 30]);
  });

  it('keeps zero, which is a value and not a gap', () => {
    // A ticket pool at zero IS the finding. Anything that treats it as missing hides exactly
    // the event the panel exists to show.
    expect(plotColumn(Float64Array.from([0, 0]))).toEqual([0, 0]);
  });

  it('converts the clock to the seconds uPlot expects', () => {
    expect(timeColumn(Float64Array.from([1000, 2500]))).toEqual([1, 2.5]);
  });
});

describe('legend labels', () => {
  it('drops the prefix every series in a panel shares', () => {
    expect(legendLabel('rate(common.serverStatus.opcounters.query)')).toBe('rate(opcounters.query)');
    expect(legendLabel('shard.replSetGetStatus.members.0.health')).toBe('rs.members.0.health');
    expect(legendLabel('local.oplog.rs.stats.storageStats.storageSize')).toBe(
      'oplog.storageStats.storageSize',
    );
  });

  it('collapses the shared total in a share-of-total expression', () => {
    // CPU usage is one numerator over a seven-term denominator, repeated for every series.
    // Spelled out, three legend rows are identical for their first 30 characters.
    const total =
      'sum(rate(systemMetrics.cpu.user_ms), rate(systemMetrics.cpu.system_ms), rate(systemMetrics.cpu.idle_ms))';
    expect(legendLabel(`pct(rate(systemMetrics.cpu.user_ms), ${total})`)).toBe(
      'pct(rate(sys.cpu.user_ms), sum(…))',
    );
  });

  it('leaves a two-term sum spelled out', () => {
    // Short enough to read, and the terms are the information.
    expect(legendLabel('sum(serverStatus.a, serverStatus.b)')).toBe('sum(a, b)');
  });
});
