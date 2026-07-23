import { useMemo, useState, type ReactElement } from 'react';

import { useStore } from '../store/useStore.js';
import { qualifyPath } from '../data/qualify.js';
import { logMetricLabel } from '../logs/analyze.js';
import type { CatalogEntry } from '../data/reader.js';

/**
 * Searchable metric picker.
 *
 * Every metric in the capture is here, always -- the old workflow of editing a
 * metrics_to_get.txt and rebuilding a container is exactly what this replaces. Flat metrics
 * are hidden by default because a large fraction of FTDC never changes and would otherwise
 * bury the useful paths.
 *
 * With several nodes loaded the list is one node's -- metric *names* barely differ between
 * members of a replica set, so a merged list would be three copies of the same thing. A click
 * still adds the metric for every node, because "show me this on all three" is the question
 * being asked almost every time. Shift-click pins it to the node being listed, which is how a
 * cross-host expression gets written.
 */
export function MetricCatalog(): ReactElement {
  const captures = useStore((s) => s.captures);
  const activeId = useStore((s) => s.activeId);
  const setActive = useStore((s) => s.setActive);
  const panels = useStore((s) => s.panels);
  const focused = useStore((s) => s.focused);
  const toggle = useStore((s) => s.toggleMetric);
  const status = useStore((s) => s.status);

  const active = captures.find((c) => c.id === activeId) ?? captures[0];
  // Log-derived series sit in the same list as decoded metrics, deliberately: from a panel's
  // point of view `logs.slowQuery.p95Ms` is a metric, and having to look somewhere else for it
  // would defeat the point of putting logs on the same axis.
  const catalog = useMemo(() => {
    const base = active?.catalog ?? [];
    const logs = active?.logs;
    if (logs === undefined) return base;
    const derived: CatalogEntry[] = Object.entries(logs.series).map(([path, series]) => {
      const finite = Array.from(series.v).filter(Number.isFinite);
      return {
        path,
        type: 'double' as CatalogEntry['type'],
        min: finite.length > 0 ? Math.min(...finite) : 0,
        max: finite.length > 0 ? Math.max(...finite) : 0,
        flat: finite.length > 0 && Math.min(...finite) === Math.max(...finite),
      };
    });
    return [...derived, ...base];
  }, [active]);

  const target = panels.find((p) => p.id === focused) ?? panels[0];
  const selected = target?.metrics ?? [];

  const [term, setTerm] = useState('');
  const [showFlat, setShowFlat] = useState(false);

  const matches = useMemo(() => {
    const needles = term.toLowerCase().split(/\s+/).filter(Boolean);
    return catalog
      .filter((entry) => {
        if (!showFlat && entry.flat && !selected.includes(entry.path)) return false;
        if (needles.length === 0) return true;
        const hay = entry.path.toLowerCase();
        return needles.every((n) => hay.includes(n));
      })
      .slice(0, 400);
  }, [catalog, term, showFlat, selected]);

  if (status !== 'ready' || active === undefined) return <></>;

  const varying = catalog.filter((c) => !c.flat).length;

  return (
    <aside className="catalog">
      <div className="catalog-target muted small">
        adding to <b>{target?.title ?? 'no panel'}</b>
      </div>
      {captures.length > 1 && (
        <select
          className="capture-select"
          value={active.id}
          onChange={(e) => setActive(e.target.value)}
          title="Which node's metric list to show"
        >
          {captures.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label} ({c.catalog.length.toLocaleString()} metrics)
            </option>
          ))}
        </select>
      )}
      <input
        value={term}
        onChange={(e) => setTerm(e.target.value)}
        placeholder="Search metrics — try: cache, tickets, queue"
        className="search"
      />
      <label className="muted small">
        <input type="checkbox" checked={showFlat} onChange={(e) => setShowFlat(e.target.checked)} />
        show flat ({catalog.length - varying} of {catalog.length} never change)
      </label>

      <ul className="metric-list">
        {matches.map((entry) => {
          const pinned = qualifyPath(active.id, entry.path);
          const on = selected.includes(entry.path) || selected.includes(pinned);
          return (
            <li key={entry.path}>
              <button
                className={on ? 'metric on' : 'metric'}
                title={
                  captures.length > 1
                    ? `Click: all nodes · Shift-click: ${active.label} only`
                    : entry.path
                }
                onClick={(e) => toggle(e.shiftKey && captures.length > 1 ? pinned : entry.path)}
              >
                <span className="metric-path">
                  {entry.path.startsWith('logs.') && <span className="from-log">log</span>}
                  {entry.path}
                </span>
                <span className="muted small">
                  {entry.path.startsWith('logs.') ? logMetricLabel(entry.path) : entry.type}
                  {entry.flat ? ' · flat' : ` · ${fmt(entry.min)} – ${fmt(entry.max)}`}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {matches.length === 400 && <p className="muted small pad">showing first 400 matches</p>}
    </aside>
  );
}

function fmt(v: number): string {
  if (!Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1e12) return `${(v / 1e12).toFixed(1)}T`;
  if (abs >= 1e9) return `${(v / 1e9).toFixed(1)}G`;
  if (abs >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(2);
}
