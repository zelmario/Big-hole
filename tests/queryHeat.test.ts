/**
 * Color follows how bad the number is, not how it compares with the worst row in the file.
 *
 * A 14 second call stays red when another call took minutes. A fast indexed call stays green
 * when it merely ran often.
 */

import { describe, expect, it } from 'vitest';

import { compareQueries, costColor, heatScale, loadByRow, rowHeat, severityByRow, type HeatInput, type SortableQuery } from '../src/logs/queryHeat.js';

function row(partial: Partial<HeatInput> & Pick<HeatInput, 'totalMs' | 'maxMs'>): HeatInput {
  return {
    count: 1,
    docsExamined: 0,
    returned: 0,
    ...partial,
  };
}

function sortable(partial: Partial<SortableQuery> & Pick<SortableQuery, 'totalMs' | 'maxMs'>): SortableQuery {
  return { count: 1, docsExamined: 0, returned: 0, collscan: false, ...partial };
}

describe('query heat', () => {
  it('leaves a log with no spread uncolored', () => {
    const rows = [1, 2, 3, 4].map(() => row({ totalMs: 1000, maxMs: 1000 }));
    const scale = heatScale(rows);
    expect(scale.avg).toBeNull();
    expect(rowHeat(rows[0]!, scale).row).toBe('ok');
  });

  it('marks the slow outlier and leaves the rest alone', () => {
    const calm = Array.from({ length: 9 }, () => row({ totalMs: 20, maxMs: 30, count: 10 }));
    const slow = row({ totalMs: 50_000, maxMs: 8_000, count: 10 });
    const scale = heatScale([...calm, slow]);
    expect(rowHeat(slow, scale).avg).toBe('hot');
    expect(rowHeat(slow, scale).max).toBe('hot');
    expect(rowHeat(slow, scale).total).toBe('hot');
    expect(rowHeat(calm[0]!, scale).avg).toBe('ok');
    expect(rowHeat(slow, scale).row).toBe('hot');
  });

  it('marks a query that reads far more than it returns, even when it is not the slowest', () => {
    const indexed = Array.from({ length: 8 }, () =>
      row({ totalMs: 100, maxMs: 100, docsExamined: 10, returned: 10 }),
    );
    const wasteful = row({ totalMs: 80, maxMs: 80, docsExamined: 50_000, returned: 2 });
    const scale = heatScale([...indexed, wasteful]);
    const heat = rowHeat(wasteful, scale);
    expect(heat.avg).toBe('ok');
    expect(heat.docs).toBe('hot');
    expect(heat.ratio).toBe('hot');
    expect(heat.row).toBe('hot');
    expect(rowHeat(indexed[0]!, scale).ratio).toBe('ok');
  });

  it('keeps a multi-second shape red even when another shape consumed more time', () => {
    const calm = sortable({ totalMs: 20, maxMs: 20, count: 1, docsExamined: 2, returned: 2 });
    const slow = sortable({ totalMs: 50_000, maxMs: 8_000, count: 10, docsExamined: 1, returned: 1 });
    const half = sortable({ totalMs: 25_000, maxMs: 8_000, count: 10 });
    const monster = sortable({ totalMs: 3_600_000, maxMs: 3_600_000, count: 1 });
    const costs = loadByRow([calm, half, slow, monster]);
    expect(costs.get(slow)!).toBeGreaterThan(0.75);
    expect(costs.get(half)!).toBeGreaterThan(0.7);
    expect(costs.get(slow)!).toBeGreaterThan(costs.get(half)!);
    expect(costs.get(half)!).toBeGreaterThan(costs.get(calm)!);
    expect(costs.get(calm)!).toBeLessThan(0.25);
    expect(costColor(0)).toBe('rgb(74, 168, 108)');
    expect(costColor(1)).toBe('rgb(235, 87, 87)');
  });

  it('does not let a collection scan change the load when the time is the same', () => {
    const indexed = sortable({ totalMs: 1000, maxMs: 1000, docsExamined: 20, returned: 20 });
    const scan = sortable({ totalMs: 1000, maxMs: 1000, docsExamined: 20, returned: 20, collscan: true });
    const lighter = sortable({ totalMs: 100, maxMs: 100 });
    const costs = loadByRow([indexed, scan, lighter]);
    expect(costs.get(scan)).toBe(costs.get(indexed));
    expect(costs.get(lighter)!).toBeLessThan(costs.get(scan)!);
    const severity = severityByRow([indexed, scan, lighter]);
    expect(severity.get(scan)!).toBeGreaterThan(severity.get(indexed)!);
    expect(severity.get(scan)!).toBeGreaterThan(0.5);
  });

  it('still colors a slow shape when every shape took the same time', () => {
    const rows = [1, 2, 3].map(() => sortable({ totalMs: 14_000, maxMs: 14_000 }));
    const costs = loadByRow(rows);
    expect(costs.get(rows[0]!)).toBeGreaterThan(0.65);
    expect(new Set(costs.values()).size).toBe(1);
  });

  it('does not paint a 14s call that read 36k documents to return 64 as green', () => {
    const outlier = sortable({ totalMs: 3_600_000, maxMs: 3_600_000, docsExamined: 1, returned: 1 });
    const reported = sortable({
      totalMs: 14_000,
      maxMs: 236_000,
      docsExamined: 36_000,
      returned: 64,
    });
    const cheap = sortable({ totalMs: 20, maxMs: 20, docsExamined: 2, returned: 2 });
    const loads = loadByRow([outlier, reported, cheap]);
    const severities = severityByRow([outlier, reported, cheap]);
    expect(loads.get(reported)!).toBeGreaterThan(0.65);
    expect(severities.get(reported)!).toBeGreaterThan(0.9);
    expect(severities.get(cheap)!).toBeLessThan(0.25);
    expect(loads.get(cheap)!).toBeLessThan(0.25);
  });

  it('lets a popular indexed query be red on load and green on severity', () => {
    const popular = sortable({ totalMs: 5_000_000, maxMs: 80, count: 100_000, docsExamined: 100_000, returned: 100_000 });
    const loads = loadByRow([popular]);
    const severities = severityByRow([popular]);
    expect(loads.get(popular)!).toBeGreaterThan(0.9);
    expect(severities.get(popular)!).toBeLessThan(0.25);
  });

  it('ranks a wasteful read as more severe even when it used little of the log', () => {
    const indexed = sortable({ totalMs: 5_000, maxMs: 5_000, docsExamined: 10, returned: 10 });
    const waste = sortable({ totalMs: 40, maxMs: 40, docsExamined: 50_000, returned: 1, collscan: true });
    const loads = loadByRow([indexed, waste]);
    const severities = severityByRow([indexed, waste]);
    expect(loads.get(indexed)!).toBeGreaterThan(loads.get(waste)!);
    expect(severities.get(waste)!).toBeGreaterThan(severities.get(indexed)!);
    expect(severities.get(waste)!).toBeGreaterThan(0.9);
  });

  it('sorts collection scans first, wasteful reads next, and big results on their own', () => {
    const scan = sortable({ totalMs: 10, maxMs: 10, collscan: true, docsExamined: 100, returned: 100 });
    const heavy = sortable({ totalMs: 9_000, maxMs: 9_000, docsExamined: 100, returned: 100 });
    expect(compareQueries(scan, heavy, 'collscan')).toBeLessThan(0);

    const waste = sortable({ totalMs: 10, maxMs: 10, docsExamined: 5_000, returned: 1 });
    const both = sortable({ totalMs: 10, maxMs: 10, docsExamined: 5_000, returned: 5_000 });
    expect(compareQueries(waste, both, 'waste')).toBeLessThan(0);
    expect(compareQueries(both, waste, 'bulk')).toBeLessThan(0);
  });

  it('does not treat a large result as bad when it returned what it read', () => {
    const small = Array.from({ length: 8 }, () =>
      row({ totalMs: 50, maxMs: 50, docsExamined: 5, returned: 5 }),
    );
    const big = row({ totalMs: 60, maxMs: 60, docsExamined: 20_000, returned: 20_000 });
    const scale = heatScale([...small, big]);
    const heat = rowHeat(big, scale);
    expect(heat.docs).toBe('hot');
    expect(heat.ratio).toBe('ok');
  });
});
