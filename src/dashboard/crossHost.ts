/**
 * Metrics that only exist once more than one node is loaded.
 *
 * Every other panel in this app could be produced from a single capture. These cannot: they
 * are differences *between* servers, and they are the reason multi-capture is a milestone
 * rather than a convenience.
 *
 * Replication lag is the case that matters. The usual way to get it is to ask the primary,
 * which reports its own view of every member -- but that view is only as fresh as the last
 * heartbeat, and during exactly the incidents you are investigating (a stalled secondary, a
 * saturated network) the heartbeat is what breaks first. Taking each node's *own* report of
 * its own last write and differencing them sidesteps the heartbeat entirely.
 *
 * The cost is that the two nodes' clocks are compared as well as their progress, which is why
 * clock skew gets its own panel: if it is not flat, read the lag panel with that offset in
 * mind. Saying so on the dashboard is better than a lag number that quietly includes it.
 */

import { detectRolePrefixes, expandMetric, panelId, type PanelSpec } from './layout.js';
import type { Unit } from '../data/expr.js';
import { qualifyPath } from '../data/qualify.js';

export interface CrossHostCapture {
  readonly id: string;
  readonly label: string;
  readonly paths: ReadonlySet<string>;
  /** Highest value `replSetGetStatus.myState` reached; 1 means it was primary. */
  readonly maxState?: number;
}

/** Resolve a template path against one capture, honouring role prefixes and aliases. */
function resolve(path: string, capture: CrossHostCapture): string | null {
  const prefixes = detectRolePrefixes(capture.paths);
  const matches = expandMetric(path, capture.paths, prefixes);
  return matches[0] ?? null;
}

/**
 * The node everything else is compared against.
 *
 * The primary, when the captures say which one it is -- lag is conventionally read as "how far
 * behind the primary", and the sign of the difference should match that. Falling back to the
 * first capture keeps the panel working on a set of secondaries, where the comparison is still
 * useful, just relative.
 */
export function referenceCapture(captures: readonly CrossHostCapture[]): CrossHostCapture | null {
  return captures.find((c) => c.maxState === 1) ?? captures[0] ?? null;
}

interface Comparison {
  readonly title: string;
  readonly path: string;
  readonly unit: Unit;
  readonly describe: string;
}

const COMPARISONS: Comparison[] = [
  {
    title: 'Replication lag',
    path: 'serverStatus.repl.lastWrite.lastWriteDate',
    unit: 'ms',
    describe: 'how far behind the reference node each member last wrote',
  },
  {
    // Not a diagnostic in itself -- it is the error bar on the panel above.
    title: 'Clock skew',
    path: 'serverStatus.localTime',
    unit: 'ms',
    describe: 'offset between the hosts, which lag is measured through',
  },
];

/**
 * Panels comparing every loaded capture against the reference one.
 *
 * Returns [] for fewer than two captures, or when the metric is missing anywhere it is needed
 * -- a panel that cannot resolve is dropped, never drawn empty.
 */
export function crossHostPanels(
  captures: readonly CrossHostCapture[],
  startY = 0,
): PanelSpec[] {
  if (captures.length < 2) return [];
  const reference = referenceCapture(captures);
  if (reference === null) return [];
  const others = captures.filter((c) => c.id !== reference.id);

  const panels: PanelSpec[] = [];
  let y = startY;

  for (const comparison of COMPARISONS) {
    const refPath = resolve(comparison.path, reference);
    if (refPath === null) continue;

    const metrics: string[] = [];
    for (const other of others) {
      const path = resolve(comparison.path, other);
      if (path === null) continue;
      metrics.push(
        `diff(${qualifyPath(reference.id, refPath)}, ${qualifyPath(other.id, path)})`,
      );
    }
    if (metrics.length === 0) continue;

    panels.push({
      id: panelId(),
      kind: 'chart',
      title: `${comparison.title} vs ${reference.label}`,
      metrics,
      unit: comparison.unit,
      x: 0,
      y,
      w: 24,
      h: 8,
    });
    y += 8;
  }

  if (panels.length === 0) return [];

  return [
    {
      id: panelId(),
      kind: 'section',
      title: `Across hosts — ${captures.length} nodes, reference ${reference.label}`,
      metrics: [],
      x: 0,
      y: startY,
      w: 24,
      h: 1,
    },
    ...panels.map((p) => ({ ...p, y: p.y + 1 })),
  ];
}

/** One-line explanation for a cross-host panel, or null if it is not one. */
export function describeCrossHost(title: string): string | null {
  const match = COMPARISONS.find((c) => title.startsWith(c.title));
  return match?.describe ?? null;
}
