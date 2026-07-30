/**
 * Member-state timeline and node info.
 *
 * Both features answer a question by *asserting* something about a server, so the risk in each
 * is the same: a confident wrong answer. A band that claims SECONDARY through an outage, or a
 * row that reports a peer's guess as the node's own state, is worse than no strip at all --
 * so most of what is tested here is the ways either could overclaim.
 */

import { describe, expect, it } from 'vitest';

import {
  NO_DATA,
  buildMemberRows,
  runsOf,
  stateName,
  type StateCapture,
} from '../src/replset/state.js';
import { mergeFields, nodeFields, pick, type InfoCapture } from '../src/replset/hostInfo.js';
import type { CatalogEntry } from '../src/data/reader.js';
import type { SeriesPayload } from '../src/workers/protocol.js';

/** Seconds -> epoch ms, so the numbers in these tests read as a clock. */
const at = (...secs: number[]): Float64Array => Float64Array.from(secs.map((s) => s * 1000));
const f = (...xs: number[]): Float64Array => Float64Array.from(xs);

describe('collapsing a state column into runs', () => {
  it('turns an unchanging column into one run covering the capture', () => {
    const t = at(0, 1, 2, 3, 4);
    const v = f(2, 2, 2, 2, 2);
    // The last sample is given one step of width, so a run is never zero pixels wide.
    expect(runsOf(t, v, v)).toEqual([{ fromMs: 0, toMs: 5000, state: 2 }]);
  });

  it('splits at a transition, on the sample the new state first appears', () => {
    const t = at(0, 1, 2, 3);
    const v = f(2, 2, 1, 1);
    expect(runsOf(t, v, v)).toEqual([
      { fromMs: 0, toMs: 2000, state: 2 },
      { fromMs: 2000, toMs: 4000, state: 1 },
    ]);
  });

  /**
   * The strip is built from a bounded read, so on a long capture a transition lands *inside* a
   * bucket rather than between two. Resolving that bucket to one end of the envelope would put
   * an election on whichever side the sampling happened to favour; splitting it says what is
   * actually known -- both states occurred, somewhere in here.
   */
  it('splits a bucket that holds a transition rather than picking an end of it', () => {
    const t = at(0, 10, 20);
    const lo = f(2, 1, 1);
    const hi = f(2, 2, 1);
    expect(runsOf(t, lo, hi)).toEqual([
      { fromMs: 0, toMs: 15_000, state: 2 },
      { fromMs: 15_000, toMs: 30_000, state: 1 },
    ]);
  });

  /**
   * A hole in the capture is not evidence that the state continued across it. Reading it as one
   * is how a two-hour FTDC outage becomes two hours of confidently-drawn SECONDARY.
   */
  it('opens a no-data run across a hole in the sample clock', () => {
    const t = at(0, 1, 2, 600, 601);
    const v = f(1, 1, 1, 1, 1);
    expect(runsOf(t, v, v)).toEqual([
      { fromMs: 0, toMs: 3000, state: 1 },
      { fromMs: 3000, toMs: 600_000, state: NO_DATA },
      { fromMs: 600_000, toMs: 602_000, state: 1 },
    ]);
  });

  it('reads a NaN sample as no data rather than skipping it', () => {
    const t = at(0, 1, 2, 3);
    const v = f(2, NaN, NaN, 2);
    expect(runsOf(t, v, v)).toEqual([
      { fromMs: 0, toMs: 1000, state: 2 },
      { fromMs: 1000, toMs: 3000, state: NO_DATA },
      { fromMs: 3000, toMs: 4000, state: 2 },
    ]);
  });

  /**
   * A bucketed clock steps in seconds, not in the capture's 1 s cadence. A gap test written
   * against the cadence would call every bucket boundary a hole and shred the strip into
   * alternating bands of no-data -- so the step comes from the column handed in.
   */
  it('does not mistake a coarse bucket clock for a series of gaps', () => {
    const t = at(0, 8, 16, 24, 32);
    const v = f(2, 2, 2, 2, 2);
    expect(runsOf(t, v, v)).toEqual([{ fromMs: 0, toMs: 40_000, state: 2 }]);
  });

  it('names the states an engineer reads, and admits when it cannot', () => {
    expect(stateName(1)).toBe('PRIMARY');
    expect(stateName(8)).toBe('DOWN');
    expect(stateName(NO_DATA)).toBe('no data');
    expect(stateName(42)).toBe('state 42');
  });
});

/* ------------------------------------------------------------- rows ---- */

const entry = (path: string, min: number, max = min): CatalogEntry => ({
  path,
  type: 'int32',
  min,
  max,
  flat: min === max,
});

/**
 * A capture as `replSetGetStatus` reports it: this node's own state, plus one entry per member
 * with its config `_id`, and `self` present only on the reporting node's own entry.
 */
function member(
  id: string,
  label: string,
  opts: { myState: number; members: Array<{ idx: number; memberId: number; self?: boolean }> },
  prefix = '',
): StateCapture {
  const catalog: CatalogEntry[] = [entry(`${prefix}replSetGetStatus.myState`, opts.myState)];
  for (const m of opts.members) {
    const base = `${prefix}replSetGetStatus.members.${m.idx}`;
    catalog.push(entry(`${base}.state`, 0, 10), entry(`${base}._id`, m.memberId));
    if (m.self === true) catalog.push(entry(`${base}.self`, 1));
  }
  return { id, label, paths: new Set(catalog.map((c) => c.path)), catalog };
}

/** A source that answers with a constant column per expression. */
function constantSource(values: Record<string, number>): {
  series: (
    captureId: string,
    expressions: string[],
  ) => Promise<SeriesPayload[]>;
} {
  return {
    series: (captureId, expressions) =>
      Promise.resolve(
        expressions.map((path) => {
          const v = f(values[`${captureId}:${path}`] ?? NaN, values[`${captureId}:${path}`] ?? NaN);
          return { path, t: at(0, 1), min: v, max: v, mean: v, raw: true };
        }),
      ),
  };
}

describe('building the member rows', () => {
  it('gives every loaded node its own row, from its own myState', async () => {
    const a = member('c0', 'node0', { myState: 1, members: [{ idx: 0, memberId: 0, self: true }] });
    const b = member('c1', 'node1', { myState: 2, members: [{ idx: 1, memberId: 1, self: true }] });
    const rows = await buildMemberRows(
      constantSource({
        'c0:replSetGetStatus.myState': 1,
        'c1:replSetGetStatus.myState': 2,
      }),
      [a, b],
    );

    expect(rows.map((r) => [r.label, r.self, r.runs[0]!.state])).toEqual([
      ['node0', true, 1],
      ['node1', true, 2],
    ]);
  });

  /**
   * The case a support bundle actually arrives in: one member's diagnostic.data out of three.
   * The other two are only knowable through this node's heartbeats -- which is also the only
   * place DOWN can come from, since no node ever reports itself as down.
   */
  it('draws members nobody loaded from the peer that can see them', async () => {
    const only = member('c0', 'node0', {
      myState: 1,
      members: [
        { idx: 0, memberId: 0, self: true },
        { idx: 1, memberId: 1 },
        { idx: 2, memberId: 2 },
      ],
    });
    const rows = await buildMemberRows(
      constantSource({
        'c0:replSetGetStatus.myState': 1,
        'c0:replSetGetStatus.members.1.state': 2,
        'c0:replSetGetStatus.members.2.state': 8,
      }),
      [only],
    );

    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ label: 'node0', self: true });
    expect(rows[1]).toMatchObject({ label: 'member 1', self: false, reportedBy: 'node0' });
    expect(rows[2]).toMatchObject({ label: 'member 2', self: false });
    expect(rows[2]!.runs[0]!.state).toBe(8);
  });

  /**
   * A node's own state and a peer's guess at it are not the same claim, and drawing both would
   * put the same member on the strip twice, disagreeing. Self-reported wins.
   */
  it('never draws a peer view of a member that is loaded in its own right', async () => {
    const a = member('c0', 'node0', {
      myState: 1,
      members: [
        { idx: 0, memberId: 0, self: true },
        { idx: 1, memberId: 1 },
      ],
    });
    const b = member('c1', 'node1', {
      myState: 2,
      members: [
        { idx: 0, memberId: 0 },
        { idx: 1, memberId: 1, self: true },
      ],
    });
    const rows = await buildMemberRows(
      constantSource({
        'c0:replSetGetStatus.myState': 1,
        'c1:replSetGetStatus.myState': 2,
      }),
      [a, b],
    );

    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.self)).toBe(true);
  });

  /**
   * Role scoping comes from the topology, not the release: a sharded 8.0 member reports
   * `shard.replSetGetStatus.…` and nothing under the bare name. Resolving through the same
   * machinery the dashboard uses is what keeps the strip from being blank on exactly the
   * captures that are hardest to reason about.
   */
  it('resolves under a role prefix', async () => {
    const sharded = member(
      'c0',
      'shardnode',
      { myState: 2, members: [{ idx: 0, memberId: 4, self: true }] },
      'shard.',
    );
    const rows = await buildMemberRows(
      constantSource({ 'c0:shard.replSetGetStatus.myState': 2 }),
      [sharded],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ label: 'shardnode', memberId: 4 });
    expect(rows[0]!.runs[0]!.state).toBe(2);
  });

  /**
   * A member `_id` is unique within a replica set and nowhere else: every shard of a sharded
   * cluster numbers its members 0, 1, 2. A nine-node bundle is usually three shards, so
   * identifying peers by bare `_id` made shard1's member 1 collide with shard0's and vanish --
   * and the surviving row showed one shard's view while appearing to describe the cluster.
   */
  it('does not confuse one shard\'s members with another\'s', async () => {
    const trio = (idx: number): Array<{ idx: number; memberId: number; self?: boolean }> =>
      [0, 1, 2].map((i) => ({ idx: i, memberId: i, ...(i === idx ? { self: true } : {}) }));
    const s0 = { ...member('c0', 'shard0-node0', { myState: 1, members: trio(0) }, 'shard.'), replSetName: 'shard0' };
    const s1 = { ...member('c1', 'shard1-node0', { myState: 1, members: trio(0) }, 'shard.'), replSetName: 'shard1' };

    const rows = await buildMemberRows(
      constantSource({
        'c0:shard.replSetGetStatus.myState': 1,
        'c0:shard.replSetGetStatus.members.1.state': 2,
        'c0:shard.replSetGetStatus.members.2.state': 8,
        'c1:shard.replSetGetStatus.myState': 1,
        'c1:shard.replSetGetStatus.members.1.state': 2,
        'c1:shard.replSetGetStatus.members.2.state': 2,
      }),
      [s0, s1],
    );

    // Two loaded nodes and four peers, not two peers with one shard's answer for both.
    expect(rows).toHaveLength(6);
    // Grouped by set, and peers named by it -- "member 1" alone names two different servers.
    expect(rows.map((r) => r.label)).toEqual([
      'shard0-node0',
      'shard0 member 1',
      'shard0 member 2',
      'shard1-node0',
      'shard1 member 1',
      'shard1 member 2',
    ]);
    // Whose DOWN it was survives the fix: shard0's member 2, not shard1's.
    expect(rows.find((r) => r.label === 'shard0 member 2')!.runs[0]!.state).toBe(8);
    expect(rows.find((r) => r.label === 'shard1 member 2')!.runs[0]!.state).toBe(2);
  });

  /**
   * Without metadata there is no replica-set name to scope member ids by, and deduping is the
   * right default: one replica set is what a bundle almost always is, and drawing each node's
   * view of every other one would triple the strip.
   */
  it('still dedupes by bare id when no capture knows its replica set', async () => {
    const a = member('c0', 'node0', {
      myState: 1,
      members: [{ idx: 0, memberId: 0, self: true }, { idx: 1, memberId: 1 }],
    });
    const b = member('c1', 'node1', {
      myState: 2,
      members: [{ idx: 0, memberId: 0 }, { idx: 1, memberId: 1, self: true }],
    });
    const rows = await buildMemberRows(
      constantSource({
        'c0:replSetGetStatus.myState': 1,
        'c1:replSetGetStatus.myState': 2,
      }),
      [a, b],
    );
    expect(rows.map((r) => r.label)).toEqual(['node0', 'node1']);
  });

  it('scales to a nine-member set with one capture loaded', async () => {
    const members = Array.from({ length: 9 }, (_, i) => ({
      idx: i,
      memberId: i,
      ...(i === 0 ? { self: true } : {}),
    }));
    const only = member('c0', 'node0', { myState: 1, members });
    const values: Record<string, number> = { 'c0:replSetGetStatus.myState': 1 };
    for (let i = 1; i < 9; i++) {
      values[`c0:replSetGetStatus.members.${i}.state`] = i === 4 ? 8 : 2;
    }

    const rows = await buildMemberRows(constantSource(values), [only]);
    expect(rows).toHaveLength(9);
    expect(rows.filter((r) => r.self)).toHaveLength(1);
    expect(rows.find((r) => r.label === 'member 4')!.runs[0]!.state).toBe(8);
  });

  it('produces no rows for a standalone, rather than an empty strip', async () => {
    const standalone: StateCapture = {
      id: 'c0',
      label: 'solo',
      paths: new Set(['serverStatus.uptime']),
      catalog: [entry('serverStatus.uptime', 0, 100)],
    };
    expect(await buildMemberRows(constantSource({}), [standalone])).toEqual([]);
  });
});

/* --------------------------------------------------------- node info ---- */

/**
 * The shape a real sharded 8.0 node's metadata document has, scoped under `common.`.
 *
 * Field-for-field as observed on a production capture, with the identifying values replaced --
 * a fixture is published and a hostname or a replica-set name is somebody's infrastructure.
 */
const SHARDED_META = {
  common: {
    hostInfo: {
      system: {
        hostname: 'shard0-node1.example.internal',
        memSizeMB: 62923,
        memLimitMB: 62923,
        numCores: 8,
        numPhysicalCores: 4,
        cpuArch: 'x86_64',
        numaEnabled: false,
      },
      os: { name: 'Amazon Linux release 2023', version: 'Kernel 6.18.20' },
      extra: { cpuString: 'AMD EPYC 7R13 Processor', kernelVersion: '6.18.20' },
    },
    buildInfo: { version: '8.0.19-7', psmdbVersion: '8.0.19-7', allocator: 'tcmalloc-google' },
    ulimits: { fileDescriptors: { soft: 64000, hard: 64000 }, memLock_kb: { soft: -1, hard: -1 } },
    getCmdLineOpts: {
      parsed: {
        net: { port: 27017 },
        replication: { replSetName: 'shard0', oplogSizeMB: 20480 },
        sharding: { clusterRole: 'shardsvr' },
        storage: { engine: 'wiredTiger', dbPath: '/var/lib/mongo' },
      },
    },
  },
};

function infoCapture(meta: Record<string, unknown> | undefined, prefix = 'common.'): InfoCapture {
  const catalog = [
    entry(`${prefix}serverStatus.wiredTiger.cache.maximum bytes configured`, 32452378624),
    entry(`${prefix}serverStatus.mem.resident`, 900, 4096),
  ];
  return {
    id: 'c0',
    label: 'node0',
    paths: new Set(catalog.map((c) => c.path)),
    catalog,
    ...(meta !== undefined ? { meta } : {}),
    startMs: 0,
    endMs: 3_600_000,
    sampleCount: 3600,
    cadenceMs: 1000,
    gaps: 0,
    restarts: 0,
  };
}

describe('reading a node out of its FTDC metadata', () => {
  /**
   * A sharded 8.0 node nests its metadata under `common.`, a plain replica set does not, and
   * which one you get is decided by topology rather than by release. Probing beats assuming.
   */
  it('finds a field whether or not the server scoped it by role', () => {
    expect(pick(SHARDED_META, 'hostInfo.system.numCores')).toBe(8);
    expect(pick({ hostInfo: { system: { numCores: 2 } } }, 'hostInfo.system.numCores')).toBe(2);
    expect(pick(SHARDED_META, 'hostInfo.system.notAField')).toBeUndefined();
    expect(pick(undefined, 'hostInfo.system.numCores')).toBeUndefined();
  });

  it('reports the host, its processors and its memory in units a human reads', () => {
    const fields = nodeFields(infoCapture(SHARDED_META));
    const value = (label: string): string | undefined =>
      fields.find((f2) => f2.label === label)?.value;

    expect(value('hostname')).toBe('shard0-node1.example.internal');
    expect(value('model')).toBe('AMD EPYC 7R13 Processor');
    expect(value('cores')).toBe('8 (4 physical)');
    expect(value('physical')).toBe('61.4 GiB');
    expect(value('WiredTiger cache configured')).toBe('30.2 GiB');
    // mongod reports mem.resident in MiB, so an unscaled read renders 4 GiB as "4.1 kB".
    expect(value('resident peak')).toBe('4.00 GiB');
    expect(value('replica set')).toBe('shard0');
    expect(value('oplog configured')).toBe('20.0 GiB');
    expect(value('open files')).toBe('64000 soft / 64000 hard');
    expect(value('locked memory (kB)')).toBe('unlimited soft / unlimited hard');
  });

  /**
   * A capture ingested before the metadata document was recorded still has to render. Every
   * metadata row is simply absent -- which is an honest "not captured", not a zero.
   */
  it('degrades to the metrics when a capture carries no metadata', () => {
    const fields = nodeFields(infoCapture(undefined));
    expect(fields.find((f2) => f2.label === 'hostname')).toBeUndefined();
    expect(fields.find((f2) => f2.label === 'WiredTiger cache configured')?.value).toBe('30.2 GiB');
    expect(fields.find((f2) => f2.label === 'samples')?.value).toBe('3,600 at 1.0s');
  });

  it('lines every node up on the same rows, including ones only some of them have', () => {
    const full = { captureId: 'c0', label: 'a', meta: SHARDED_META, fields: nodeFields(infoCapture(SHARDED_META)) };
    const bare = { captureId: 'c1', label: 'b', meta: undefined, fields: nodeFields(infoCapture(undefined)) };
    const rows = mergeFields([full, bare]);

    expect(rows.some((r) => r.section === 'Host' && r.label === 'hostname')).toBe(true);
    expect(rows.some((r) => r.section === 'Capture' && r.label === 'samples')).toBe(true);
    // Sections stay in reading order regardless of which node contributed the row.
    const sections = [...new Set(rows.map((r) => r.section))];
    expect(sections.indexOf('Host')).toBeLessThan(sections.indexOf('Capture'));
    // And a row is listed once, not once per node that has it.
    expect(rows.filter((r) => r.label === 'hostname')).toHaveLength(1);
  });
});
