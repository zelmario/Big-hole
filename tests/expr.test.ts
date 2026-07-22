/**
 * Expression layer.
 *
 * Two properties matter most here and both come from real capture data rather than from
 * theory: metric paths contain parentheses, and some end in a space. Either one silently
 * breaks a naive parser, and the symptom is "that metric doesn't exist" rather than a crash.
 */

import { describe, expect, it } from 'vitest';

import {
  ExprError,
  evaluate,
  exprPaths,
  exprToString,
  parseExpr,
  unitOf,
} from '../src/data/expr.js';
import { expandMetric } from '../src/dashboard/layout.js';

const t = Float64Array.from([0, 1000, 2000, 3000]); // 1 Hz

function raw(entries: Record<string, number[]>): Map<string, Float64Array> {
  return new Map(Object.entries(entries).map(([k, v]) => [k, Float64Array.from(v)]));
}

describe('parsing', () => {
  it('treats a bare path as a raw metric', () => {
    expect(parseExpr('serverStatus.mem.resident')).toEqual({
      fn: 'raw',
      path: 'serverStatus.mem.resident',
    });
  });

  it('keeps parentheses that belong to the metric name', () => {
    // 80 real paths look like this. `Active(anon)_kb` does not end in ')', while
    // `... max time (msecs)` does -- both must stay whole.
    for (const path of [
      'systemMetrics.memory.Active(anon)_kb',
      'serverStatus.wiredTiger.transaction.transaction checkpoint prepare max time (msecs)',
    ]) {
      expect(parseExpr(path)).toEqual({ fn: 'raw', path });
      expect(exprPaths(parseExpr(`rate(${path})`))).toEqual([path]);
    }
  });

  it('preserves a trailing space in a metric name', () => {
    // WiredTiger emits these; trimming makes the metric unresolvable.
    const path = 'serverStatus.wiredTiger.reconciliation.pages written including an aggregated newest start durable timestamp ';
    expect(exprPaths(parseExpr(path))).toEqual([path]);
    expect(exprPaths(parseExpr(`rate(${path})`))).toEqual([path]);
    expect(exprPaths(parseExpr(`div(${path}, other.metric)`))).toEqual([path, 'other.metric']);
  });

  it('strips leading whitespace, which is only ever formatting', () => {
    expect(parseExpr('  a.b')).toEqual({ fn: 'raw', path: 'a.b' });
    expect(exprPaths(parseExpr('pct(a.b, c.d)'))).toEqual(['a.b', 'c.d']);
  });

  it('nests', () => {
    const e = parseExpr('div(rate(a.lat), rate(a.ops))');
    expect(exprPaths(e)).toEqual(['a.lat', 'a.ops']);
    expect(exprToString(e)).toBe('div(rate(a.lat), rate(a.ops))');
  });

  it('rejects malformed expressions', () => {
    expect(() => parseExpr('rate(a, b)')).toThrow(ExprError);
    expect(() => parseExpr('sum(a)')).toThrow(ExprError);
    expect(() => parseExpr('scale(a, notanumber)')).toThrow(ExprError);
    expect(() => parseExpr('')).toThrow(ExprError);
  });
});

describe('evaluation', () => {
  it('rates a counter per second', () => {
    const v = evaluate(parseExpr('rate(c)'), t, raw({ c: [10, 20, 40, 40] }));
    expect(Number.isNaN(v[0]!)).toBe(true); // nothing to difference against
    expect(Array.from(v.slice(1))).toEqual([10, 20, 0]);
  });

  it('breaks the rate when a counter goes backwards', () => {
    // A counter resetting means the process restarted. Emitting the negative delta would draw
    // a huge downward spike that reads as a real event.
    const v = evaluate(parseExpr('rate(c)'), t, raw({ c: [100, 200, 5, 15] }));
    expect(Number.isNaN(v[2]!)).toBe(true);
    expect(v[3]).toBe(10);
  });

  it('computes percentages and guards a zero denominator', () => {
    const v = evaluate(parseExpr('pct(a, b)'), t, raw({ a: [1, 2, 3, 4], b: [4, 4, 0, 8] }));
    expect(v[0]).toBe(25);
    expect(v[1]).toBe(50);
    expect(Number.isNaN(v[2]!)).toBe(true); // 3/0 is not Infinity, it is "no value"
    expect(v[3]).toBe(50);
  });

  it('scales, diffs and sums', () => {
    expect(Array.from(evaluate(parseExpr('scale(a, 0.1)'), t, raw({ a: [10, 20, 30, 40] })))).toEqual([1, 2, 3, 4]);
    expect(Array.from(evaluate(parseExpr('diff(a, b)'), t, raw({ a: [5, 5, 5, 5], b: [1, 2, 3, 4] })))).toEqual([4, 3, 2, 1]);
    expect(Array.from(evaluate(parseExpr('sum(a, b)'), t, raw({ a: [1, 1, 1, 1], b: [2, 2, 2, 2] })))).toEqual([3, 3, 3, 3]);
  });

  it('treats a gap as absent rather than zero when summing', () => {
    const v = evaluate(parseExpr('sum(a, b)'), t, raw({ a: [1, NaN, NaN, 1], b: [2, 2, NaN, NaN] }));
    expect(Array.from(v.slice(0, 2))).toEqual([3, 2]);
    expect(Number.isNaN(v[2]!)).toBe(true); // no contributor at all -> still a gap
    expect(v[3]).toBe(1);
  });

  it('reports an unknown metric rather than returning zeros', () => {
    expect(() => evaluate(parseExpr('missing.metric'), t, raw({}))).toThrow(ExprError);
  });
});

describe('units', () => {
  it('infers from the path and the wrapping function', () => {
    expect(unitOf(parseExpr('serverStatus.wiredTiger.cache.bytes read into cache'))).toBe('bytes');
    expect(unitOf(parseExpr('rate(serverStatus.wiredTiger.cache.bytes read into cache)'))).toBe('bytes/s');
    expect(unitOf(parseExpr('rate(serverStatus.opcounters.query)'))).toBe('per-sec');
    expect(unitOf(parseExpr('pct(a, b)'))).toBe('percent');
    expect(unitOf(parseExpr('serverStatus.wiredTiger.transaction.checkpoint currently running_ms'))).toBe('ms');
  });
});

describe('glob expansion', () => {
  const available = new Set([
    'systemMetrics.disks.sda.io_time_ms',
    'systemMetrics.disks.nvme0n1.io_time_ms',
    'serverStatus.localTime',
    'replSetGetStatus.members.0.lastAppliedWallTime',
    'replSetGetStatus.members.1.lastAppliedWallTime',
  ]);

  it('fans out one series per matching segment', () => {
    expect(expandMetric('rate(systemMetrics.disks.*.io_time_ms)', available)).toEqual([
      'rate(systemMetrics.disks.nvme0n1.io_time_ms)',
      'rate(systemMetrics.disks.sda.io_time_ms)',
    ]);
  });

  it('substitutes the same value into every wildcard in one expression', () => {
    // Otherwise replica lag would produce a cross product instead of one series per member.
    expect(
      expandMetric('diff(serverStatus.localTime, replSetGetStatus.members.*.lastAppliedWallTime)', available),
    ).toEqual([
      'diff(serverStatus.localTime, replSetGetStatus.members.0.lastAppliedWallTime)',
      'diff(serverStatus.localTime, replSetGetStatus.members.1.lastAppliedWallTime)',
    ]);
  });

  it('drops expressions whose metrics the capture lacks', () => {
    expect(expandMetric('systemMetrics.disks.*.write_sectors', available)).toEqual([]);
    expect(expandMetric('not.present.at.all', available)).toEqual([]);
  });

  it('passes through a non-wildcard expression that resolves', () => {
    expect(expandMetric('serverStatus.localTime', available)).toEqual(['serverStatus.localTime']);
  });
});
