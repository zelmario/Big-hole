/**
 * M6, second half: "explain this window".
 *
 * The detectors could only report a false alarm; this can do something worse -- rank the wrong
 * thing first. A list of 5,763 metrics ordered badly is indistinguishable from no answer, and
 * unlike a missing finding it looks authoritative. So most of what follows is about the ways
 * the ordering degenerates: a counter compared as a level, a gauge compared as a rate, and the
 * "0 -> something" case where a comparison normalises itself away and every metric that moved
 * at all scores identically.
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
import { SeriesScan, statsOf, type WindowStats } from '../src/data/scan.js';
import {
  baselineFor,
  changeInputs,
  compare,
  isClockPath,
  rankChanges,
  type ChangeInput,
} from '../src/insights/ranking.js';
import { discoverFixtures } from './oracle.js';

const SECOND = 1000;

/** A window of evenly spaced samples, starting at t0. */
function series(t0: number, values: number[], cadenceMs = SECOND): WindowStats {
  const scan = new SeriesScan(cadenceMs * 4);
  for (let i = 0; i < values.length; i++) scan.push(t0 + i * cadenceMs, values[i]!);
  return scan.result();
}

/** `n` samples of the same value -- what a window of an idle metric looks like. */
function flat(t0: number, value: number, n: number): WindowStats {
  return series(t0, new Array<number>(n).fill(value));
}

/** A counter ticking at `per` units per sample. */
function ramp(t0: number, start: number, per: number, n: number): WindowStats {
  return series(
    t0,
    Array.from({ length: n }, (_, i) => start + i * per),
  );
}

describe('scanning a window', () => {
  it('summarises what the column did', () => {
    const s = series(0, [10, 20, 30, 40]);
    expect(s.n).toBe(4);
    expect(s.mean).toBe(25);
    expect(s.min).toBe(10);
    expect(s.max).toBe(40);
    expect(s.first).toBe(10);
    expect(s.last).toBe(40);
    expect(s.rate).toBe(10); // 10 per second
    expect(s.rateMin).toBe(10);
    expect(s.dChanges).toBe(3);
  });

  /**
   * The elision shortcut has to be exactly equivalent, because most columns of a real capture
   * take it: a constant column is stored as one value and expanding it would undo the whole
   * point of chunk-major storage.
   */
  it('treats a constant run identically to pushing every sample', () => {
    const oneByOne = new SeriesScan();
    for (let i = 0; i < 5; i++) oneByOne.push(i * SECOND, 7);
    oneByOne.push(5 * SECOND, 9);

    const batched = new SeriesScan();
    batched.run(7, 0, 4 * SECOND, 5);
    batched.push(5 * SECOND, 9);

    expect(batched.result()).toEqual(oneByOne.result());
  });

  /**
   * A hole is not a value. Averaging a delta across it turns a collector outage into an
   * enormous apparent rate, on exactly the captures where the collector was struggling -- the
   * same trap the detectors avoid by breaking a run at a gap.
   */
  it('does not carry a delta across a hole in the capture', () => {
    const withHole = new SeriesScan();
    withHole.push(0, 100);
    withHole.push(SECOND, NaN);
    withHole.push(2 * SECOND, 900);
    const s = withHole.result();
    expect(s.n).toBe(2);
    expect(s.dn).toBe(0); // no delta joined 100 to 900
    expect(Number.isNaN(s.rate)).toBe(true);
  });

  it('does not carry a delta across a stretch longer than the gap bound', () => {
    const scan = new SeriesScan(4 * SECOND);
    scan.push(0, 100);
    scan.push(60 * SECOND, 900); // the collector was away for a minute
    expect(scan.result().dn).toBe(0);
  });

  it('reads a sub-window of an in-memory series, for the log-derived metrics', () => {
    const t = Float64Array.from([0, SECOND, 2 * SECOND, 3 * SECOND]);
    const v = Float64Array.from([1, 2, 3, 99]);
    const s = statsOf(t, v, 0, 2 * SECOND);
    expect(s.n).toBe(3);
    expect(s.max).toBe(3);
  });
});

describe('choosing a baseline', () => {
  const capture = { fromMs: 0, toMs: 1000 * SECOND };

  it('takes the same span immediately before the window', () => {
    const base = baselineFor({ fromMs: 500 * SECOND, toMs: 600 * SECOND }, capture);
    expect(base).toEqual({ fromMs: 400 * SECOND, toMs: 500 * SECOND - 1 });
  });

  /** Brushing the first spike in a bundle is common; "no baseline" is a useless answer to it. */
  it('falls back to the span after, at the very start of the capture', () => {
    const base = baselineFor({ fromMs: 0, toMs: 100 * SECOND }, capture);
    expect(base?.fromMs).toBe(100 * SECOND + 1);
    expect(base?.toMs).toBe(200 * SECOND);
  });

  it('refuses when the window is the whole capture', () => {
    expect(baselineFor({ fromMs: 0, toMs: 1000 * SECOND }, capture)).toBeNull();
  });

  it('clamps a baseline that would run off the start rather than inventing samples', () => {
    const base = baselineFor({ fromMs: 100 * SECOND, toMs: 300 * SECOND }, capture);
    expect(base).toEqual({ fromMs: 0, toMs: 100 * SECOND - 1 });
  });
});

describe('ranking what changed', () => {
  const input = (over: Partial<ChangeInput>): ChangeInput => ({
    path: 'x',
    base: flat(0, 0, 60),
    win: flat(60 * SECOND, 0, 60),
    range: 100,
    rateScale: 1,
    ...over,
  });

  /**
   * The single most important case. Most of FTDC is cumulative, and a counter's mean is always
   * higher in the later window -- so ranking counters on levels puts every counter in the
   * capture above every real finding, and the answer is 5,000 rows of nothing.
   */
  it('compares a counter as a rate, not as a level', () => {
    // Ticking 10/s before, 200/s during: the level "changed" by 11,400, but the finding is 20x.
    const change = compare(
      input({
        base: ramp(0, 0, 10, 60),
        win: ramp(60 * SECOND, 600, 200, 60),
        range: 1e6,
        rateScale: 20,
      }),
      1,
    );
    expect(change?.kind).toBe('rate');
    expect(change?.base).toBeCloseTo(10, 6);
    expect(change?.window).toBeCloseTo(200, 6);
  });

  /**
   * A column that stepped once is non-decreasing too, and dividing that step by the window
   * produces a "rate" hundreds of times its own capture-wide average. Left in, those rows took
   * the entire top of the list on a real dirty-cache capture and buried the eviction storm.
   */
  it('does not call a column that stepped twice a rate', () => {
    const win = series(60 * SECOND, [
      ...new Array<number>(30).fill(5),
      ...new Array<number>(30).fill(6),
    ]);
    const change = compare(input({ base: flat(0, 5, 60), win, range: 1, rateScale: 0.001 }), 1);
    expect(change?.kind).toBe('level');
  });

  it('ranks a metric that moved through its whole range above one that wiggled', () => {
    const changes = rankChanges([
      // Moved 90 of a range it never exceeds.
      input({ path: 'big', base: flat(0, 5, 60), win: flat(60 * SECOND, 95, 60), range: 100 }),
      // Moved a third of the same range.
      input({ path: 'small', base: flat(0, 5, 60), win: flat(60 * SECOND, 40, 60), range: 100 }),
    ]);
    expect(changes.map((c) => c.path)).toEqual(['big', 'small']);
  });

  /**
   * With the rate scale taken from the two values being compared, every metric that went from
   * nothing to something scored identically -- 0 -> 0.001/s ranked with 0 -> 1.6M/s, and the
   * ordering collapsed into whatever order the paths happened to be in.
   */
  it('separates a burst from a metric that merely ticked', () => {
    const burst = input({
      path: 'burst',
      base: flat(0, 0, 60),
      win: ramp(60 * SECOND, 0, 1000, 60),
      range: 1e6,
      rateScale: 100, // the capture normally does 100/s; this window does 1000/s
    });
    const tick = input({
      path: 'tick',
      base: flat(0, 0, 60),
      win: ramp(60 * SECOND, 0, 1, 60),
      range: 1000,
      rateScale: 0.9,
    });
    const changes = rankChanges([tick, burst]);
    expect(changes[0]!.path).toBe('burst');
  });

  it('says nothing about a metric that never moved anywhere in the capture', () => {
    expect(compare(input({ range: 0 }), 1)).toBeNull();
  });

  it('says nothing about a metric absent from one of the windows', () => {
    const absent = compare(
      input({ base: flat(0, 0, 0), win: flat(60 * SECOND, 500, 60) }),
      1,
    );
    expect(absent).toBeNull();
  });

  it('drops changes below the score floor rather than listing everything', () => {
    // A tenth of a percent of the metric's range: true, and not worth a row.
    const change = compare(
      input({ base: flat(0, 500, 60), win: flat(60 * SECOND, 500.1, 60), range: 100 }),
      1,
    );
    expect(change).toBeNull();
  });

  it('keeps the strongest changes first and caps the list', () => {
    const many = Array.from({ length: 100 }, (_, i) =>
      input({
        path: `m${i}`,
        base: flat(0, 0, 60),
        win: flat(60 * SECOND, i + 1, 60),
        range: 200,
      }),
    );
    const changes = rankChanges(many, { limit: 5 });
    expect(changes).toHaveLength(5);
    expect(changes[0]!.path).toBe('m99');
  });

  /**
   * Clocks move in every window by construction, and after a restart or a gap they move
   * enormously -- an optime catching up reads as a metric that went up 1,367x. On the teaching
   * dataset this put six clocks and two BSON timestamp halves above every real metric.
   */
  it('never nominates a clock', () => {
    for (const path of [
      'start',
      'end',
      'shard.start',
      'replSetGetStatus.members.0.optime.ts',
      'replSetGetStatus.members.0.optime.ts.inc',
      'serverStatus.uptimeMillis',
      'serverStatus.storageEngine.oldestRequiredTimestampForCrashRecovery',
    ]) {
      expect(isClockPath(path), path).toBe(true);
    }
    expect(isClockPath('serverStatus.localTime', 'datetime')).toBe(true);

    // And does not throw out metrics that merely look adjacent to one.
    for (const path of [
      'serverStatus.wiredTiger.cache.bytes currently in the cache',
      'replSetGetStatus.members.0.optime.t',
      'serverStatus.metrics.ttl.passes',
    ]) {
      expect(isClockPath(path, 'int64'), path).toBe(false);
    }
  });

  it('leaves clocks out of the ranking entirely', () => {
    const moved = flat(60 * SECOND, 500, 60);
    const win = new Map([
      ['start', moved],
      ['serverStatus.wiredTiger.cache.pages evicted', moved],
    ]);
    const base = new Map([
      ['start', flat(0, 0, 60)],
      ['serverStatus.wiredTiger.cache.pages evicted', flat(0, 0, 60)],
    ]);
    const inputs = changeInputs(base, win, () => 1000, 3600 * SECOND);
    expect(inputs.map((i) => i.path)).toEqual(['serverStatus.wiredTiger.cache.pages evicted']);
  });

  /**
   * WiredTiger packs transaction times as `seconds << 32` and hides them in storageStats under
   * names like "btree clean tree checkpoint expiration time". They are also the columns the
   * reference truncates to 32 bits, so one chunk reads -0.68 and the next 6.6e18 -- which ranks
   * as the largest change in the capture and means nothing.
   */
  it('leaves packed timestamps out, whatever they are called', () => {
    const packed = 'config.transactions.stats.storageStats.wiredTiger.btree.btree clean tree checkpoint expiration time';
    const win = new Map([
      [packed, flat(60 * SECOND, 6.643e18, 60)],
      ['serverStatus.wiredTiger.cache.pages evicted', flat(60 * SECOND, 500, 60)],
    ]);
    const base = new Map([
      [packed, flat(0, -0.68, 60)],
      ['serverStatus.wiredTiger.cache.pages evicted', flat(0, 0, 60)],
    ]);
    const inputs = changeInputs(base, win, () => 1000, 3600 * SECOND);
    expect(inputs.map((i) => i.path)).toEqual(['serverStatus.wiredTiger.cache.pages evicted']);
  });

  it('pairs the two scans by path and derives the rate scale from the capture span', () => {
    const base = new Map([['a', flat(0, 0, 60)]]);
    const win = new Map([['a', flat(60 * SECOND, 5, 60)]]);
    // A range of 3,600 spread over an hour is one per second.
    const [only] = changeInputs(base, win, () => 3600, 3600 * SECOND);
    expect(only?.rateScale).toBeCloseTo(1, 9);
  });
});

/* ------------------------------------------------------------ against real bytes ---- */

/**
 * The scan reads columns.bin directly rather than going through getSeries, taking the
 * constant-column shortcut and carrying the delta chain across chunk boundaries by hand. That
 * is three chances to disagree with the series a panel would draw, on captures that contain
 * real schema drift -- so it is checked against the reader it bypasses.
 */
describe.each(discoverFixtures())('scan matches getSeries: $name', (fixture) => {
  let dir: string;
  let reader: CaptureReader;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'big-hole-scan-'));
    const store = new NodeFileStore(dir);
    const bytes = new Uint8Array(readFileSync(fixture.ftdc));
    const writer = await CaptureWriter.create(store, { captureId: 'cap', sourceFile: fixture.ftdc });
    for (const chunk of decodeFTDC(bytes)) await writer.addChunk(chunk);
    await writer.finish();
    reader = await CaptureReader.open(store, 'cap');
  }, 120_000);

  afterAll(async () => {
    await reader?.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('agrees with the series the panels draw, metric by metric', async () => {
    const m = reader.manifest;
    // A window in the middle, so it starts and ends inside chunks rather than on their edges.
    const span = m.endMs - m.startMs;
    const from = m.startMs + Math.floor(span / 3);
    const to = m.startMs + Math.floor((span * 2) / 3);
    const maxGapMs = Math.max(m.cadenceMs * 4, 5000);

    const scanned = await reader.scan({ from, to });
    expect(scanned.size).toBeGreaterThan(0);

    // Every tenth path: the point is coverage of constant, varying and drifting columns, and
    // the whole catalogue would make this the slowest test in the suite for no more assurance.
    const paths = m.paths.filter((_, i) => i % 10 === 0);
    for (const path of paths) {
      const got = scanned.get(path);
      if (got === undefined) continue; // absent from every chunk in the window

      const drawn = await reader.getSeries(path, { from, to });
      const want = statsOf(drawn.t, drawn.mean, from, to, maxGapMs);

      expect(got.n, `${path} sample count`).toBe(want.n);
      if (want.n === 0) continue;
      expect(got.min, `${path} min`).toBe(want.min);
      expect(got.max, `${path} max`).toBe(want.max);
      expect(got.first, `${path} first`).toBe(want.first);
      expect(got.last, `${path} last`).toBe(want.last);
      expect(got.dn, `${path} deltas`).toBe(want.dn);
      expect(got.dChanges, `${path} changes`).toBe(want.dChanges);
      // Welford over the same values in the same order, so this is exact bar float assembly.
      expect(got.mean, `${path} mean`).toBeCloseTo(want.mean, 6);
    }
  }, 120_000);
});
