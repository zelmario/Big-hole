/**
 * The colors have to land on the numbers, not only in a helper.
 *
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { QueryBoard } from '../src/logs/QueryBoard.js';
import type { QueryPattern } from '../src/logs/queries.js';
import { useStore } from '../src/store/useStore.js';

vi.mock('../src/workers/client.js', () => ({
  FtdcClient: class {},
}));

afterEach(cleanup);

function pattern(partial: Partial<QueryPattern> & Pick<QueryPattern, 'op' | 'totalMs' | 'maxMs'>): QueryPattern {
  return {
    ns: 'app.orders',
    pattern: '{ n: 1 }',
    plan: 'IXSCAN { n: 1 }',
    collscan: false,
    doing: `${partial.op} on app.orders`,
    count: 1,
    docsExamined: 0,
    keysExamined: 0,
    returned: 0,
    reslen: 0,
    firstMs: 0,
    lastMs: 1_000,
    appNames: [],
    ...partial,
  };
}

describe('query board colors', () => {
  it('paints the slow shape and the wasteful one, and leaves a cheap indexed find alone', () => {
    const cheap = pattern({
      op: 'find',
      totalMs: 20,
      maxMs: 20,
      docsExamined: 2,
      returned: 2,
      pattern: '{ ok: 1 }',
      doing: 'cheap indexed find',
    });
    const peers = Array.from({ length: 8 }, (_, i) =>
      pattern({ op: 'count', totalMs: 30 + i, maxMs: 30 + i, docsExamined: 4, returned: 4, pattern: `{ n: ${i} }` }),
    );
    const slow = pattern({ op: 'aggregate', totalMs: 80_000, maxMs: 40_000, docsExamined: 10, returned: 10 });
    const wasteful = pattern({
      op: 'find',
      totalMs: 25,
      maxMs: 25,
      docsExamined: 80_000,
      returned: 1,
      pattern: '{ sku: 1 }',
      collscan: true,
    });

    useStore.setState({
      captures: [
        {
          id: 'c0',
          label: 'rs0',
          visible: true,
          logs: { queries: { patterns: [cheap, ...peers, slow, wasteful], ops: 12, internal: 0, ungrouped: 0 } },
        },
      ] as never,
      setRange: vi.fn(),
      setSidebarTab: vi.fn(),
    });
    render(<QueryBoard />);

    expect(screen.getByRole('option', { name: 'load' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'severity' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'most examined, least returned' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'most examined, most returned' })).toBeTruthy();

    const slowRow = screen.getByText('aggregate').closest('.query-row')!;
    const cheapRow = screen.getByText('cheap indexed find').closest('.query-row')!;
    expect(slowRow.querySelector('[data-rank="load"]')?.tagName).toBe('SPAN');
    expect(slowRow.querySelector('.query-rank')?.textContent).toBe('load');
    expect(cheapRow.querySelector('.query-rank')?.textContent).toBe('load');
    expect(redness(slowRow, 'load')).toBeGreaterThan(redness(cheapRow, 'load'));
    expect(slowRow.querySelector('[data-rank="severity"]')?.textContent).toBe('severity');
    expect(redness(slowRow, 'severity')).toBeGreaterThan(0.5);
    expect(screen.queryByText('worst')).toBeNull();
    expect(screen.queryByText('high')).toBeNull();

    const wastefulRow = screen.getByText('{ sku: 1 }').closest('.query-row')!;
    expect(wastefulRow.querySelector('.query-scan')?.textContent).toBe('COLLSCAN');
    expect(redness(wastefulRow, 'severity')).toBeGreaterThan(redness(cheapRow, 'severity'));
    expect(redness(slowRow, 'load')).toBeGreaterThan(redness(wastefulRow, 'load'));
    expect(wastefulRow.textContent).toContain('80,000 docs examined');
    expect(cheapRow.querySelector('.query-scan')).toBeNull();
  });

  it('sorts collection scans ahead of a slower indexed query', () => {
    const indexed = pattern({ op: 'aggregate', totalMs: 90_000, maxMs: 90_000, doing: 'slow indexed' });
    const scan = pattern({
      op: 'find',
      totalMs: 30,
      maxMs: 30,
      collscan: true,
      plan: 'COLLSCAN',
      doing: 'small scan',
    });
    useStore.setState({
      captures: [
        {
          id: 'c0',
          label: 'rs0',
          visible: true,
          logs: { queries: { patterns: [indexed, scan], ops: 2, internal: 0, ungrouped: 0 } },
        },
      ] as never,
      setRange: vi.fn(),
      setSidebarTab: vi.fn(),
    });
    render(<QueryBoard />);
    fireEvent.change(screen.getByLabelText('Sort query shapes'), { target: { value: 'collscan' } });
    const order = [...document.querySelectorAll('.query-doing')].map((node) => node.textContent);
    expect(order[0]).toBe('small scan');
    expect(order[1]).toBe('slow indexed');
  });

  it('highlights a collection scan that is not among the slowest', () => {
    const peers = Array.from({ length: 8 }, (_, i) =>
      pattern({ op: 'count', totalMs: 1000 + i, maxMs: 1000 + i, pattern: `{ n: ${i} }` }),
    );
    const scan = pattern({
      op: 'find',
      totalMs: 200,
      maxMs: 200,
      collscan: true,
      plan: 'COLLSCAN',
      pattern: '{ mild: 1 }',
      doing: 'mild collection scan',
    });
    useStore.setState({
      captures: [
        {
          id: 'c0',
          label: 'rs0',
          visible: true,
          logs: { queries: { patterns: [...peers, scan], ops: 9, internal: 0, ungrouped: 0 } },
        },
      ] as never,
      setRange: vi.fn(),
      setSidebarTab: vi.fn(),
    });
    render(<QueryBoard />);

    const row = screen.getByText('mild collection scan').closest('.query-row')!;
    expect(row.querySelector('.query-scan')?.textContent).toBe('COLLSCAN');
    expect(row.querySelector('[data-rank="load"]')?.textContent).toBe('load');
    expect(row.querySelector('[data-rank="severity"]')?.textContent).toBe('severity');
    expect(redness(row, 'severity')).toBeGreaterThan(0.4);
  });

  it('sorts severity from the menu, and the tags themselves do not sort', () => {
    const cheap = pattern({
      op: 'find',
      totalMs: 20,
      maxMs: 20,
      docsExamined: 2,
      returned: 2,
      pattern: '{ ok: 1 }',
      doing: 'cheap indexed find',
    });
    const slow = pattern({
      op: 'aggregate',
      totalMs: 80_000,
      maxMs: 40_000,
      docsExamined: 10,
      returned: 10,
      pattern: '{ heavy: 1 }',
      doing: 'heavy aggregate',
    });
    const wasteful = pattern({
      op: 'find',
      totalMs: 25,
      maxMs: 25,
      docsExamined: 80_000,
      returned: 1,
      pattern: '{ sku: 1 }',
      plan: 'COLLSCAN',
      collscan: true,
      doing: 'wasteful scan',
    });
    useStore.setState({
      captures: [
        {
          id: 'c0',
          label: 'rs0',
          visible: true,
          logs: { queries: { patterns: [cheap, slow, wasteful], ops: 3, internal: 0, ungrouped: 0 } },
        },
      ] as never,
      setRange: vi.fn(),
      setSidebarTab: vi.fn(),
    });
    render(<QueryBoard />);

    const order = () => [...document.querySelectorAll('.query-doing')].map((node) => node.textContent);
    expect(order()[0]).toBe('heavy aggregate');
    expect(screen.queryByRole('button', { name: 'severity' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'load' })).toBeNull();

    fireEvent.change(screen.getByLabelText('Sort query shapes'), { target: { value: 'severity' } });
    expect(order()[0]).toBe('wasteful scan');
  });
});

function redness(row: Element, rank: 'load' | 'severity'): number {
  const style = row.querySelector(`[data-rank="${rank}"]`)?.getAttribute('style') ?? '';
  const match = /rgb\((\d+), (\d+), (\d+)\)/.exec(style);
  if (match === null) return 0;
  return Number(match[1]) - Number(match[2]);
}
