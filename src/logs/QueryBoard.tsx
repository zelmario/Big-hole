import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';

import type { QueryPattern } from './queries.js';
import { compareQueries, costColor, loadByRow, LOAD_LABEL, SEVERITY_LABEL, severityByRow, type QuerySort } from './queryHeat.js';
import { useStore } from '../store/useStore.js';
import { useClock } from '../ui/clock.js';

/**
 * Slow operations, grouped by what they do.
 *
 * One row is every call that shared an operation, a namespace, a predicate shape and a plan.
 * Literals from the log are already replaced, so a query that ran a thousand times with a
 * thousand different ids is one sentence. Clicking a row opens the query so it can be read
 * without scrolling the sidebar, with the slowest call's command in full -- the shape says
 * `/…/`, the call says whether the regex was anchored. "Show in log" lands on that call's line.
 */

type SortKey = QuerySort | 'load' | 'severity';

interface Row extends QueryPattern {
  readonly captureId: string;
  readonly captureLabel: string;
}

function ms(n: number): string {
  if (n >= 10_000) return `${Math.round(n / 1000)} s`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)} s`;
  return `${Math.round(n)} ms`;
}

function insight(row: Row): string | null {
  if (row.count === 0) return null;
  const docs = row.docsExamined / row.count;
  const back = row.returned / row.count;
  if (row.collscan && docs >= 1000) {
    return `About ${Math.round(docs).toLocaleString()} documents read per call, with no index.`;
  }
  if (row.yields && back >= 1 && docs / back >= 50) {
    const each = row.op === 'delete' || row.op === 'remove' ? 'deleted' : row.op === 'update' ? 'modified' : 'returned';
    return `About ${Math.round(docs / back).toLocaleString()} documents examined per document ${each}.`;
  }
  if (row.yields && row.keysExamined > 0 && back >= 1 && row.keysExamined / row.count / back >= 50) {
    const keys = row.keysExamined / row.count / back;
    return `About ${Math.round(keys).toLocaleString()} index keys examined per document returned.`;
  }
  return null;
}

export function QueryBoard(): ReactElement {
  const captures = useStore((s) => s.captures);
  const range = useStore((s) => s.range);
  const setRange = useStore((s) => s.setRange);
  const setSidebarTab = useStore((s) => s.setSidebarTab);
  const revealLogAt = useStore((s) => s.revealLogAt);
  const clock = useClock();
  const [sort, setSort] = useState<SortKey>('load');
  const [collscanOnly, setCollscanOnly] = useState(false);
  const [query, setQuery] = useState('');
  const [reading, setReading] = useState<Row | null>(null);

  const rows = useMemo(() => {
    const out: Row[] = [];
    for (const capture of captures) {
      if (!capture.visible || capture.logs === undefined) continue;
      for (const pattern of capture.logs.queries.patterns) {
        out.push({ ...pattern, captureId: capture.id, captureLabel: capture.label });
      }
    }
    return out;
  }, [captures]);

  const stats = useMemo(() => {
    let ops = 0;
    let internal = 0;
    let ungrouped = 0;
    for (const capture of captures) {
      if (!capture.visible || capture.logs === undefined) continue;
      ops += capture.logs.queries.ops;
      internal += capture.logs.queries.internal;
      ungrouped += capture.logs.queries.ungrouped;
    }
    return { ops, internal, ungrouped };
  }, [captures]);

  const loads = useMemo(() => loadByRow(rows), [rows]);
  const severities = useMemo(() => severityByRow(rows), [rows]);
  const multi = new Set(rows.map((row) => row.captureId)).size > 1;
  const needle = query.trim().toLowerCase();
  const shown = rows
    .filter((row) => range === null || (row.lastMs >= range[0] && row.firstMs <= range[1]))
    .filter((row) => !collscanOnly || row.collscan)
    .filter((row) => {
      if (needle === '') return true;
      return (
        row.op.toLowerCase().includes(needle) ||
        row.ns.toLowerCase().includes(needle) ||
        row.pattern.toLowerCase().includes(needle) ||
        row.doing.toLowerCase().includes(needle) ||
        row.plan.toLowerCase().includes(needle) ||
        row.appNames.some((name) => name.toLowerCase().includes(needle))
      );
    })
    .sort((a, b) => {
      if (sort === 'load') return (loads.get(b) ?? -1) - (loads.get(a) ?? -1) || b.totalMs - a.totalMs;
      if (sort === 'severity') return (severities.get(b) ?? -1) - (severities.get(a) ?? -1) || b.totalMs - a.totalMs;
      return compareQueries(a, b, sort);
    });

  const scans = rows.filter((row) => row.collscan).length;

  useEffect(() => {
    if (reading === null) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setReading(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [reading]);

  const openLog = (row: Row) => {
    if (row.slowest !== undefined) {
      revealLogAt(row.slowest.tMs, row.captureId);
      return;
    }
    const span = Math.max(row.lastMs - row.firstMs, 60_000);
    const pad = Math.min(span, 60_000);
    setRange([row.firstMs - pad, row.lastMs + pad]);
    setSidebarTab('log');
  };

  if (captures.every((c) => c.logs === undefined)) {
    return (
      <div className="logview empty muted small">
        Drop a mongod log to see what its logged operations were doing. A log on its own is enough —
        FTDC is not required. <code>.log</code>, <code>.jsonl</code> and a <code>system.profile</code> export all work.
      </div>
    );
  }

  return (
    <div className="query-board">
      <div className="logview-head">
        <input
          className="search"
          placeholder="namespace, operation, or predicate"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <label className="muted small band-toggle" title="Only shapes that used a collection scan">
          <input
            type="checkbox"
            checked={collscanOnly}
            onChange={(e) => setCollscanOnly(e.target.checked)}
          />
          collection scans
        </label>
        <select
          className="search query-sort"
          value={sort}
          onChange={(e) => setSort(e.target.value as SortKey)}
          aria-label="Sort query shapes"
        >
          <option value="load">load</option>
          <option value="severity">severity</option>
          <option value="total">total time</option>
          <option value="avg">average</option>
          <option value="max">slowest</option>
          <option value="count">count</option>
          <option value="docs">docs examined</option>
          <option value="collscan">collection scans</option>
          <option value="waste">most examined, least returned</option>
          <option value="bulk">most examined, most returned</option>
        </select>
      </div>

      <div className="muted small query-summary">
        {rows.length === 0
          ? 'No logged operations in this log. Heartbeats are hidden; everything else that carried a command is listed, whether or not it was slow.'
          : `${shown.length} of ${rows.length} shape${rows.length === 1 ? '' : 's'} · ${stats.ops.toLocaleString()} logged operation${stats.ops === 1 ? '' : 's'}`}
        {scans > 0 && ` · ${scans} collection scan${scans === 1 ? '' : 's'}`}
        {stats.internal > 0 && ` · ${stats.internal.toLocaleString()} handshakes hidden`}
        {stats.ungrouped > 0 && ` · ${stats.ungrouped.toLocaleString()} extra shapes not listed`}
        {range !== null && ' · counts are every call of that shape, not only this time range'}
      </div>

      <div className="query-list">
        {shown.map((row) => {
          const note = insight(row);
          const avg = row.count > 0 ? row.totalMs / row.count : 0;
          const load = loads.get(row);
          const severity = severities.get(row);
          return (
            <button
              key={`${row.captureId}\0${row.op}\0${row.ns}\0${row.pattern}\0${row.plan}`}
              className="query-row"
              onClick={() => setReading(row)}
              title="Read this query"
            >
              <div className="query-top">
                <span className="query-op">{row.op}</span>
                {row.collscan && (
                  <span className="query-scan" title="Collection scan — no index was used.">
                    COLLSCAN
                  </span>
                )}
                {load !== undefined && (
                  <span
                    className="query-rank"
                    data-rank="load"
                    style={{ background: costColor(load) }}
                    title="Total time of every call of this shape."
                  >
                    {LOAD_LABEL}
                  </span>
                )}
                {severity !== undefined && (
                  <span
                    className="query-rank"
                    data-rank="severity"
                    style={{ background: costColor(severity) }}
                    title="How long one call took, and how many documents it read."
                  >
                    {SEVERITY_LABEL}
                  </span>
                )}
                <span className="query-ns">{row.ns}</span>
                {multi && <span className="finding-host">{row.captureLabel}</span>}
              </div>
              <div className="query-doing">{row.doing}</div>
              {row.pattern !== '' && <div className="query-pattern">{row.pattern}</div>}
              {note !== null && <div className="query-note">{note}</div>}
              <div className="query-stats muted small">
                <span>{row.count.toLocaleString()}×</span>
                <span>avg {ms(avg)}</span>
                <span>max {ms(row.maxMs)}</span>
                <span>total {ms(row.totalMs)}</span>
                {row.docsExamined > 0 && (
                  <span>{Math.round(row.docsExamined / row.count).toLocaleString()} docs examined</span>
                )}
                {row.yields && row.returned > 0 && (
                  <span>
                    {Math.round(row.returned / row.count).toLocaleString()}{' '}
                    {row.op === 'delete' || row.op === 'remove' ? 'deleted' : row.op === 'update' ? 'modified' : 'returned'}
                  </span>
                )}
                {row.yields && row.returned === 0 && row.docsExamined > 0 && <span>0 returned</span>}
                {row.plan !== '' && !row.collscan && <span>{row.plan}</span>}
                {row.appNames.length > 0 && <span>{row.appNames.join(', ')}</span>}
              </div>
            </button>
          );
        })}
      </div>
      {reading !== null &&
        createPortal(
          <div className="logwindow-scrim" onMouseDown={() => setReading(null)}>
            <div
              className="query-modal"
              role="dialog"
              aria-label="Query"
              onMouseDown={(event) => event.stopPropagation()}
            >
              <div className="logwindow-bar">
                <span className="query-op">{reading.op}</span>
                <span className="query-ns">{reading.ns}</span>
                <div className="spacer" />
                <button
                  className="link"
                  title={reading.slowest !== undefined ? 'Open the log at the slowest call' : 'Open the log over the time these calls ran'}
                  onClick={() => {
                    openLog(reading);
                    setReading(null);
                  }}
                >
                  Show in log
                </button>
                <button className="link" title="Close (Esc)" onClick={() => setReading(null)}>
                  ✕
                </button>
              </div>
              <div className="query-modal-body">
                <div className="query-doing">{reading.doing}</div>
                {reading.pattern !== '' && <pre className="query-modal-pattern">{reading.pattern}</pre>}
                {reading.plan !== '' && <div className="muted small query-modal-plan">{reading.plan}</div>}
                {reading.slowest !== undefined && (
                  <>
                    <div className="muted small query-modal-call">
                      Slowest call · {clock.stamp(reading.slowest.tMs)} · {ms(reading.slowest.durationMs)}
                      {multi && ` · ${reading.captureLabel}`}
                    </div>
                    <pre className="query-modal-pattern query-modal-command">{reading.slowest.command}</pre>
                  </>
                )}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
