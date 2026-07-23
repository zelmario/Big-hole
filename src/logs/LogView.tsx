import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';

import { useStore } from '../store/useStore.js';
import type { LogViewLine } from '../workers/protocol.js';

/**
 * The log, as a stream, following the dashboard's time window.
 *
 * Not a curated list of events -- the raw lines, in order, with the notable ones highlighted.
 * The window it shows IS the dashboard's visible range, so zooming into an incident on the
 * charts narrows the log to the same minutes, and the two read as one thing. Nothing is
 * precomputed: the lines for a window are a positioned read from the file the worker still
 * holds, so a 2.5 GB log costs the same as a small one to browse.
 *
 * Double-click a line to pin it -- a marker appears on every chart at that instant, which is
 * how a log entry and a metric spike become the same observation.
 */
type ViewLine = LogViewLine & { captureId: string; captureLabel: string };

const SEVERITY_CLASS: Record<string, string> = { F: 'sev-error', E: 'sev-error', W: 'sev-warn' };

function stamp(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 23);
}

const MAX_LINES = 800;

export function LogView(): ReactElement {
  const hasLogs = useStore((s) => s.hasLogs)();
  const range = useStore((s) => s.range);
  const bounds = useStore((s) => s.bounds)();
  const logLines = useStore((s) => s.logLines);
  const togglePin = useStore((s) => s.togglePin);
  const clearPins = useStore((s) => s.clearPins);
  const pins = useStore((s) => s.pins);
  const captures = useStore((s) => s.captures);
  // Redraw when a log is attached to a node that is already open.
  const logsKey = useStore((s) => s.captures.map((c) => (c.logs ? c.id : '')).join(','));

  const [importantOnly, setImportantOnly] = useState(false);
  const [query, setQuery] = useState('');
  const [lines, setLines] = useState<ViewLine[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const list = useRef<HTMLDivElement>(null);

  const [from, to] = range ?? (bounds ? [bounds.startMs, bounds.endMs] : [0, 0]);
  const pinned = useMemo(() => new Set(pins.map((p) => p.tMs)), [pins]);

  // Re-read whenever the window, the filter, or the set of loaded logs changes. Debounced,
  // because dragging the time range fires setRange continuously and each read is a worker round
  // trip -- there is no point issuing one per pixel of the drag.
  useEffect(() => {
    if (!hasLogs || to <= from) {
      setLines([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(() => {
      void logLines(from, to, { maxLines: MAX_LINES, importantOnly, query })
        .then((result) => {
          if (cancelled) return;
          setLines(result.lines);
          setTruncated(result.truncated);
          // Newest at the bottom, like a tail; jump there so the latest lines are in view.
          requestAnimationFrame(() => {
            if (list.current) list.current.scrollTop = list.current.scrollHeight;
          });
        })
        .catch(() => {
          if (!cancelled) setLines([]);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasLogs, from, to, importantOnly, query, logsKey]);

  if (!hasLogs) {
    return (
      <div className="logview empty muted small">
        No log loaded. Drop a <code>mongod.log</code> next to the capture, or use{' '}
        <b>+ log</b> on a node — the lines appear here following the dashboard's time range,
        with elections, sync-source changes and stalls highlighted. Double-click a line to pin
        a marker across every chart.
      </div>
    );
  }

  const multiNode = captures.filter((c) => c.logs !== undefined && c.visible).length > 1;

  return (
    <div className="logview">
      <div className="logview-head">
        <input
          className="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter the log"
        />
        <label className="muted small" title="Only lines worth a marker">
          <input
            type="checkbox"
            checked={importantOnly}
            onChange={(e) => setImportantOnly(e.target.checked)}
          />
          notable
        </label>
      </div>

      <div className="logview-note muted small">
        {loading ? 'reading…' : `${lines.length} line${lines.length === 1 ? '' : 's'}`}
        {truncated && ' (window has more — zoom in)'}
        {range === null && ' · whole capture'}
        {pins.length > 0 && (
          <button className="link small" onClick={clearPins}>
            clear {pins.length} pin{pins.length === 1 ? '' : 's'}
          </button>
        )}
      </div>

      <div className="logview-lines" ref={list}>
        {lines.map((line, i) => {
          const isPinned = pinned.has(line.tMs);
          const cls =
            'logline' +
            (line.important ? ' important' : '') +
            (isPinned ? ' pinned' : '') +
            ` ${SEVERITY_CLASS[line.severity] ?? ''}`;
          return (
            <div
              key={`${line.captureId}-${line.tMs}-${i}`}
              className={cls}
              title={`${line.msg} ${line.attr}\nDouble-click to pin a marker across every chart`}
              onDoubleClick={() =>
                togglePin({ tMs: line.tMs, label: line.label || line.msg, severity: line.severity })
              }
            >
              <span className="logline-time">{stamp(line.tMs)}</span>
              {multiNode && <span className="logline-host">{line.captureLabel}</span>}
              <span className="logline-comp muted">{line.component}</span>
              {line.label !== '' && <span className="logline-badge">{line.label}</span>}
              <span className="logline-msg">
                <b>{line.msg}</b>
                {line.attr !== '' && <span className="muted"> {line.attr}</span>}
              </span>
            </div>
          );
        })}
        {!loading && lines.length === 0 && (
          <div className="muted small pad">
            No log lines in this window{query ? ' matching the filter' : ''}.
          </div>
        )}
      </div>
    </div>
  );
}
