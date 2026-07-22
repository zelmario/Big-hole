/**
 * Dashboard layout serialization.
 *
 * A permalink is meant to be pasted into a support ticket and opened months later, so the
 * encoding is a compatibility surface: it has to round-trip exactly, survive being mangled,
 * and never grow so large that the link silently breaks.
 */

import { describe, expect, it } from 'vitest';

import { exprPaths, parseExpr } from '../src/data/expr.js';
import {
  LAYOUT_VERSION,
  MAX_PERMALINK_CHARS,
  decodeState,
  defaultDashboard,
  encodeState,
  fromHash,
  toPermalink,
  type DashboardState,
} from '../src/dashboard/layout.js';

const sample: DashboardState = {
  v: LAYOUT_VERSION,
  panels: [
    {
      id: 'p1',
      kind: 'chart' as const,
      title: 'Concurrency tickets available',
      metrics: [
        'serverStatus.wiredTiger.concurrentTransactions.read.available',
        'serverStatus.wiredTiger.concurrentTransactions.write.available',
      ],
      x: 0,
      y: 0,
      w: 6,
      h: 8,
    },
    { id: 'p2', kind: 'chart' as const, title: 'Queues', metrics: ['serverStatus.globalLock.currentQueue.readers'], x: 6, y: 0, w: 6, h: 8 },
  ],
  range: [1784728337300, 1784728437300],
};

describe('layout serialization', () => {
  it('round-trips exactly', () => {
    expect(decodeState(encodeState(sample))).toEqual(sample);
  });

  it('produces a URL-safe token', () => {
    expect(encodeState(sample)).toMatch(/^[A-Za-z0-9\-_]+$/);
  });

  it('compresses -- metric paths are long and highly repetitive', () => {
    const raw = JSON.stringify(sample).length;
    expect(encodeState(sample).length).toBeLessThan(raw);
  });

  it('round-trips through a URL hash', () => {
    const { url, withinLimit } = toPermalink(sample, 'http://localhost:5173/');
    expect(withinLimit).toBe(true);
    expect(fromHash(new URL(url).hash)).toEqual(sample);
  });

  it('replaces an existing hash rather than appending', () => {
    const first = toPermalink(sample, 'http://localhost:5173/#d=stale').url;
    expect(first.match(/#d=/g)).toHaveLength(1);
  });

  it('returns null for junk instead of throwing', () => {
    // A hand-edited or truncated link must fall back to the default dashboard, not crash the
    // app on load.
    expect(decodeState('not-valid-base64!!')).toBeNull();
    expect(decodeState('')).toBeNull();
    expect(decodeState(encodeState(sample).slice(0, 10))).toBeNull();
    expect(fromHash('#nothing-here')).toBeNull();
    expect(fromHash('')).toBeNull();
  });

  it('rejects a layout from a future version', () => {
    const future = encodeState({ ...sample, v: 99 as unknown as typeof LAYOUT_VERSION });
    expect(decodeState(future)).toBeNull();
  });

  it('flags a layout too large to survive a URL', () => {
    const huge: DashboardState = {
      v: LAYOUT_VERSION,
      panels: Array.from({ length: 400 }, (_, i) => ({
        id: `p${i}`,
        kind: 'chart' as const,
        title: `Panel number ${i} with a deliberately long title`,
        // Random-ish paths so they do not simply compress away.
        metrics: Array.from({ length: 12 }, (_, j) => `serverStatus.metric.${i}.${j}.${Math.random()}`),
        x: 0,
        y: i * 8,
        w: 6,
        h: 8,
      })),
      range: null,
    };
    const link = toPermalink(huge, 'http://localhost:5173/');
    expect(link.url.length).toBeGreaterThan(MAX_PERMALINK_CHARS);
    expect(link.withinLimit).toBe(false);
  });
});

describe('default dashboard', () => {
  it('keeps only metrics the capture actually has', () => {
    const available = new Set([
      'serverStatus.wiredTiger.concurrentTransactions.read.available',
      'serverStatus.connections.current',
    ]);
    const state = defaultDashboard(available);

    const charts = state.panels.filter((p) => p.kind === 'chart');
    const used = charts.flatMap((p) => p.metrics);
    expect(used.length).toBeGreaterThan(0);
    // Panel metrics are expressions now, so check the raw paths each one depends on.
    for (const m of used) {
      for (const path of exprPaths(parseExpr(m))) expect(available.has(path)).toBe(true);
    }
    // Chart panels left with nothing to draw are dropped rather than shown empty. Section
    // headings carry no metrics by design.
    for (const p of charts) expect(p.metrics.length).toBeGreaterThan(0);
  });

  it('still yields a usable dashboard for an unrecognised server shape', () => {
    const state = defaultDashboard(new Set(['something.completely.different']));
    expect(state.panels).toHaveLength(1);
    expect(state.panels[0]!.w).toBe(24);
  });

  it('gives every panel a unique id', () => {
    const state = defaultDashboard(
      new Set([
        'serverStatus.wiredTiger.concurrentTransactions.read.available',
        'serverStatus.globalLock.currentQueue.readers',
        'serverStatus.connections.current',
        'serverStatus.mem.resident',
        'serverStatus.opcounters.query',
      ]),
    );
    const ids = state.panels.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('layout compatibility', () => {
  it('rejects a layout from an older shape instead of rendering it', () => {
    // The v1 -> v2 bug: panels gained `kind` and the grid went 12 -> 24 columns, but a v1
    // layout still parsed. The saved dashboard then suppressed the new default silently.
    const v1 = {
      v: 1,
      panels: [{ id: 'p1', title: 'Old', metrics: ['a.b'], x: 0, y: 0, w: 6, h: 8 }],
      range: null,
    };
    expect(decodeState(encodeState(v1 as unknown as DashboardState))).toBeNull();
  });

  it('rejects a v2 layout whose panels are missing required fields', () => {
    const broken = {
      v: LAYOUT_VERSION,
      panels: [{ id: 'p1', title: 'No kind', metrics: [], x: 0, y: 0, w: 6, h: 8 }],
      range: null,
    };
    expect(decodeState(encodeState(broken as unknown as DashboardState))).toBeNull();
  });

  it('accepts a well-formed current layout', () => {
    expect(decodeState(encodeState(sample))).toEqual(sample);
  });
});

describe('per-series visibility', () => {
  it('rejects a v2 layout now that panels carry `hidden`', () => {
    // Same lesson as v1 -> v2: a shape change needs a version bump or a stale saved layout
    // silently overrides the new default.
    const v2 = {
      v: 2,
      panels: [{ id: 'p1', kind: 'chart', title: 'Old', metrics: ['a.b'], x: 0, y: 0, w: 6, h: 8 }],
      range: null,
    };
    expect(decodeState(encodeState(v2 as unknown as DashboardState))).toBeNull();
  });

  it('round-trips hidden series', () => {
    const withHidden: DashboardState = {
      ...sample,
      panels: sample.panels.map((p, i) => (i === 0 ? { ...p, hidden: [p.metrics[0]!] } : p)),
    };
    const back = decodeState(encodeState(withHidden));
    expect(back?.panels[0]?.hidden).toEqual([sample.panels[0]!.metrics[0]]);
  });
});
