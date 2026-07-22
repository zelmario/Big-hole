import { useMemo, useState, type ReactElement } from 'react';

import { useStore } from '../store/useStore.js';

/**
 * Searchable metric picker.
 *
 * Every metric in the capture is here, always -- the old workflow of editing a
 * metrics_to_get.txt and rebuilding a container is exactly what this replaces. Flat metrics
 * are hidden by default because a large fraction of FTDC never changes and would otherwise
 * bury the useful paths.
 */
export function MetricCatalog(): ReactElement {
  const catalog = useStore((s) => s.catalog);
  const selected = useStore((s) => s.selected);
  const toggle = useStore((s) => s.toggle);
  const status = useStore((s) => s.status);

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

  if (status !== 'ready') return <></>;

  const varying = catalog.filter((c) => !c.flat).length;

  return (
    <aside className="catalog">
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
          const on = selected.includes(entry.path);
          return (
            <li key={entry.path}>
              <button className={on ? 'metric on' : 'metric'} onClick={() => toggle(entry.path)}>
                <span className="metric-path">{entry.path}</span>
                <span className="muted small">
                  {entry.type}
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
