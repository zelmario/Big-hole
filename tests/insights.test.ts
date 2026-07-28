/**
 * M6 pathology detection.
 *
 * The risk here is not missing a finding -- it is reporting one that is not there. A detector
 * that fires on a healthy capture gets switched off within a day, and then it catches nothing
 * at all. So most of this tests the ways a finding could be manufactured: by downsampling, by
 * a gap in the capture, or by a threshold touched briefly on a server that is fine.
 */

import { describe, expect, it } from 'vitest';

import { detect, episodesOf, type DetectCapture, type Rule } from '../src/insights/detect.js';
import { RULES } from '../src/insights/rules.js';
import { parseExpr, unitOf } from '../src/data/expr.js';
import type { SeriesPayload } from '../src/workers/protocol.js';

const f = (...xs: number[]): Float64Array => Float64Array.from(xs);

/** Seconds -> epoch ms, so the numbers in these tests read as a clock. */
const at = (...secs: number[]): Float64Array => Float64Array.from(secs.map((s) => s * 1000));

describe('finding episodes in a series', () => {
  it('reports a stretch that holds for long enough', () => {
    const t = at(0, 10, 20, 30, 40);
    const v = f(5, 0, 0, 0, 5);
    // Three samples at zero on a 10 s clock: 30 s in state, against a 10 s requirement.
    expect(episodesOf(t, v, v, '<=', 0, 10_000)).toEqual([
      { fromMs: 10_000, toMs: 30_000, peak: 0, inStateMs: 30_000 },
    ]);
  });

  it('ignores a stretch too short to mean anything', () => {
    const t = at(0, 10, 20, 30);
    const v = f(5, 0, 5, 5);
    // Every one of these metrics touches its threshold briefly on a healthy server.
    expect(episodesOf(t, v, v, '<=', 0, 30_000)).toEqual([]);
  });

  it('separates two episodes rather than spanning the recovery between them', () => {
    const t = at(0, 10, 20, 30, 40, 50, 60);
    const v = f(0, 0, 0, 9, 0, 0, 0);
    const episodes = episodesOf(t, v, v, '<=', 0, 10_000);
    expect(episodes).toHaveLength(2);
    expect(episodes[0]!.toMs).toBe(20_000);
    expect(episodes[1]!.fromMs).toBe(40_000);
  });

  /**
   * A gap is not evidence. The collector stopping for five hours must not be read as five hours
   * of whatever the metric was doing when it stopped -- that turns an FTDC outage into a
   * fabricated critical finding, on exactly the captures where the collector was struggling.
   */
  it('breaks a run at a gap instead of spanning it', () => {
    const t = at(0, 10, 20, 30, 40);
    const v = f(0, 0, NaN, 0, 0);
    const episodes = episodesOf(t, v, v, '<=', 0, 10_000);
    expect(episodes).toHaveLength(2);
    expect(episodes[0]).toEqual({ fromMs: 0, toMs: 10_000, peak: 0, inStateMs: 20_000 });
    expect(episodes[1]).toEqual({ fromMs: 30_000, toMs: 40_000, peak: 0, inStateMs: 20_000 });
  });

  it('reports the worst value reached, not the one that triggered it', () => {
    const t = at(0, 10, 20, 30);
    const guard = f(100, 100, 100, 10);
    const extreme = f(100, 340, 200, 10);
    const [episode] = episodesOf(t, guard, extreme, '>=', 50, 10_000);
    expect(episode!.peak).toBe(340);
  });
});

/**
 * Flapping is the shape real incidents have.
 *
 * WiredTiger fights its own dirty cache, so the metric crosses the trigger and is pulled back
 * within seconds. Measured on a capture that spent 377 s above the 20% trigger and peaked at
 * 36%: the longest unbroken stretch was 30 s, so a rule wanting 60 s of unbroken breach saw
 * nothing. Tolerating short recoveries is what makes that visible -- without letting a detector
 * claim time that was never in breach.
 */
describe('a condition that flaps', () => {
  // Over the line, back under for one sample, over again -- repeatedly, for a minute.
  const t = at(...Array.from({ length: 12 }, (_, i) => i * 10));
  const v = f(30, 30, 5, 30, 30, 5, 30, 30, 5, 30, 30, 5);

  it('is one episode when the recoveries are shorter than the tolerance', () => {
    const episodes = episodesOf(t, v, v, '>=', 20, 60_000, 20_000);
    expect(episodes).toHaveLength(1);
    expect(episodes[0]!.fromMs).toBe(0);
    expect(episodes[0]!.toMs).toBe(100_000);
  });

  it('counts only the time actually in breach, never the bridged dips', () => {
    const [episode] = episodesOf(t, v, v, '>=', 20, 60_000, 20_000);
    // Eight samples over the line on a 10 s clock -- not the 110 s the episode spans.
    expect(episode!.inStateMs).toBe(80_000);
  });

  it('still requires that in-breach time to reach sustainMs', () => {
    // The same shape, asked for two minutes in state. It only ever managed 80 s.
    expect(episodesOf(t, v, v, '>=', 20, 120_000, 20_000)).toEqual([]);
  });

  it('is several episodes without a tolerance, which is what made the flapping invisible', () => {
    // Each crossing is 20 s, so a 60 s requirement rejects all four.
    expect(episodesOf(t, v, v, '>=', 20, 60_000)).toEqual([]);
  });

  /** A gap is not a short recovery. No tolerance may bridge one. */
  it('never bridges a hole in the capture, however generous the tolerance', () => {
    const withGap = f(30, 30, 30, NaN, 30, 30, 30);
    const clock = at(0, 10, 20, 30, 40, 50, 60);
    const episodes = episodesOf(clock, withGap, withGap, '>=', 20, 20_000, 600_000);
    expect(episodes).toHaveLength(2);
  });
});

/**
 * The property the whole design rests on: findings are read off the min/max envelope rather
 * than full resolution, which is only sound if the envelope cannot invent one.
 */
describe('downsampling cannot manufacture a finding', () => {
  it('needs the whole bucket below the threshold, not just its minimum', () => {
    const t = at(0, 10, 20, 30);
    // Each bucket dipped to zero but also recovered inside the same bucket. Reading the min
    // would call this a sustained outage; reading the max -- the guard for `<=` -- does not.
    const min = f(0, 0, 0, 0);
    const max = f(8, 7, 9, 8);
    expect(episodesOf(t, max, min, '<=', 0, 10_000)).toEqual([]);
    // And the pessimistic reading does fire once the bucket genuinely never recovers.
    expect(episodesOf(t, f(0, 0, 0, 0), min, '<=', 0, 10_000)).toHaveLength(1);
  });

  it('needs the whole bucket above the threshold for a >= rule', () => {
    const t = at(0, 10, 20, 30);
    const min = f(1, 2, 1, 2);
    const max = f(99, 99, 99, 99);
    expect(episodesOf(t, min, max, '>=', 20, 10_000)).toEqual([]);
  });
});

/* --------------------------------------------------------------- end to end ---- */

/** A capture that reports whatever paths the test names, answering with canned series. */
function fakeSource(answers: Record<string, { t: Float64Array; min: Float64Array; max: Float64Array }>) {
  return {
    series(_captureId: string, expressions: string[]): Promise<SeriesPayload[]> {
      return Promise.resolve(
        expressions.map((expression) => {
          const a = answers[expression];
          const empty = new Float64Array(0);
          if (a === undefined) {
            return { path: expression, t: empty, min: empty, max: empty, mean: empty, raw: false };
          }
          return { path: expression, t: a.t, min: a.min, max: a.max, mean: a.min, raw: false };
        }),
      );
    },
  } as Parameters<typeof detect>[0];
}

const TICKETS = 'serverStatus.wiredTiger.concurrentTransactions.read.available';

describe('detecting across captures', () => {
  const capture = (id: string, label: string, paths: string[]): DetectCapture => ({
    id,
    label,
    paths: new Set(paths),
  });

  const ticketRule: Rule = {
    id: 'read-tickets-exhausted',
    title: 'Read tickets exhausted',
    severity: 'critical',
    metric: TICKETS,
    op: '<=',
    threshold: 0,
    sustainMs: 10_000,
    unit: 'count',
    what: '',
    check: '',
  };

  it('aggregates flapping into one finding with the episode count', async () => {
    // A saturating pool crosses the line repeatedly. Twelve findings would bury every other
    // rule in the list; one finding that says "12 episodes" is the same information.
    const t = at(0, 10, 20, 30, 40, 50, 60, 70);
    const v = f(0, 0, 5, 0, 0, 5, 0, 0);
    const source = fakeSource({ [TICKETS]: { t, min: v, max: v } });

    const findings = await detect(source, [capture('c0', 'node1', [TICKETS])], [ticketRule], {});
    expect(findings).toHaveLength(1);
    expect(findings[0]!.episodes).toBe(3);
    // Six samples at zero on a 10 s clock. The old measure summed each run's span and reported
    // 30 s, which undercounted every episode by its last sample.
    expect(findings[0]!.totalMs).toBe(60_000);
    expect(findings[0]!.firstMs).toBe(0);
    expect(findings[0]!.lastMs).toBe(70_000);
    expect(findings[0]!.captureLabel).toBe('node1');
  });

  it('resolves through the alias table, so a rule written once fires on 8.0 too', async () => {
    // The rule names the pre-8.0 path; this capture only has the renamed one. Losing the
    // ticket detector on 8.0 would be the worst possible silent failure.
    const renamed = 'serverStatus.queues.execution.read.available';
    const t = at(0, 10, 20, 30);
    const v = f(0, 0, 0, 0);
    const source = fakeSource({ [renamed]: { t, min: v, max: v } });

    const findings = await detect(source, [capture('c0', 'n', [renamed])], [ticketRule], {});
    expect(findings).toHaveLength(1);
    expect(findings[0]!.metric).toBe(renamed);
  });

  it('resolves under a role prefix, as a sharded member reports it', async () => {
    const prefixed = `shard.${TICKETS}`;
    const t = at(0, 10, 20, 30);
    const v = f(0, 0, 0, 0);
    const source = fakeSource({ [prefixed]: { t, min: v, max: v } });

    const findings = await detect(
      source,
      [capture('c0', 'n', [prefixed, 'shard.serverStatus.localTime'])],
      [ticketRule],
      {},
    );
    expect(findings.map((x) => x.metric)).toEqual([prefixed]);
  });

  it('says nothing about a capture that cannot resolve the metric', async () => {
    const source = fakeSource({});
    const findings = await detect(
      source,
      [capture('c0', 'n', ['serverStatus.mem.resident'])],
      [ticketRule],
      {},
    );
    expect(findings).toEqual([]);
  });

  it('names the node, so a replica set says which member', async () => {
    const t = at(0, 10, 20, 30);
    const bad = f(0, 0, 0, 0);
    const good = f(60, 60, 60, 60);
    const source = {
      series: (id: string, expressions: string[]) =>
        Promise.resolve(
          expressions.map((expression) => {
            const v = id === 'c1' ? bad : good;
            return { path: expression, t, min: v, max: v, mean: v, raw: false };
          }),
        ),
    } as Parameters<typeof detect>[0];

    const findings = await detect(
      source,
      [capture('c0', 'primary', [TICKETS]), capture('c1', 'secondary', [TICKETS])],
      [ticketRule],
      {},
    );
    expect(findings.map((x) => x.captureLabel)).toEqual(['secondary']);
  });

  it('orders the worst thing first', async () => {
    const t = at(0, 10, 20, 30);
    const v = f(0, 0, 0, 0);
    const queue = 'serverStatus.globalLock.currentQueue.readers';
    const source = fakeSource({
      [TICKETS]: { t, min: v, max: v },
      [queue]: { t, min: f(99, 99, 99, 99), max: f(99, 99, 99, 99) },
    });
    const queueRule: Rule = {
      ...ticketRule,
      id: 'q',
      title: 'Read queue building',
      severity: 'warning',
      metric: queue,
      op: '>=',
      threshold: 10,
    };

    const findings = await detect(
      source,
      [capture('c0', 'n', [TICKETS, queue])],
      [queueRule, ticketRule],
      {},
    );
    expect(findings.map((x) => x.severity)).toEqual(['critical', 'warning']);
  });

  it('survives a capture whose reader throws rather than reporting a false all-clear', async () => {
    const source = {
      series: () => Promise.reject(new Error('columns.bin is truncated')),
    } as unknown as Parameters<typeof detect>[0];
    await expect(
      detect(source, [capture('c0', 'n', [TICKETS])], [ticketRule], {}),
    ).resolves.toEqual([]);
  });
});

/**
 * The rule file is edited by people who know MongoDB, not this codebase. These catch the
 * mistakes that produce a rule which silently never fires.
 */
describe('the shipped rule set', () => {
  it('has unique ids', () => {
    expect(new Set(RULES.map((r) => r.id)).size).toBe(RULES.length);
  });

  it('parses every metric expression', () => {
    for (const rule of RULES) {
      expect(() => parseExpr(rule.metric), `${rule.id}: ${rule.metric}`).not.toThrow();
    }
  });

  it('declares the unit the expression actually produces', () => {
    // A mismatch here formats the evidence wrongly -- "20 bytes" for a percentage -- which
    // makes a correct finding look like a bug.
    for (const rule of RULES) {
      expect(unitOf(parseExpr(rule.metric)), `${rule.id}`).toBe(rule.unit);
    }
  });

  it('requires every rule to persist before it fires', () => {
    for (const rule of RULES) {
      expect(rule.sustainMs, `${rule.id} would fire on a single sample`).toBeGreaterThanOrEqual(
        30_000,
      );
    }
  });

  it('covers the two pathologies M6 exists to surface', () => {
    const ids = RULES.map((r) => r.id);
    expect(ids).toContain('read-tickets-exhausted');
    expect(ids).toContain('cache-dirty-high');
  });
});
