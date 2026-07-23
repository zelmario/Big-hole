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
 * Three interactions: click a line to expand it and read it in full; double-click to pin a
 * marker across every chart; and double-clicking a chart scrolls this list to the moment there.
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
  const logReveal = useStore((s) => s.logReveal);
  // A log being parsed: bytes read so far, summed across whatever is loading.
  const progress = useStore((s) => s.logProgress);
  // Redraw when a log is attached to a node that is already open.
  const logsKey = useStore((s) => s.captures.map((c) => (c.logs ? c.id : '')).join(','));

  const [importantOnly, setImportantOnly] = useState(false);
  const [query, setQuery] = useState('');
  const [lines, setLines] = useState<ViewLine[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const rows = useRef(new Map<string, HTMLDivElement>());

  const [from, to] = range ?? (bounds ? [bounds.startMs, bounds.endMs] : [0, 0]);
  const pinned = useMemo(() => new Set(pins.map((p) => p.tMs)), [pins]);

  const parsing = Object.values(progress);
  const parsingBytes = parsing.reduce((n, p) => n + p.bytes, 0);
  const parsingLines = parsing.reduce((n, p) => n + p.lines, 0);

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

  // Scroll to the line nearest a revealed instant (double-click on a chart). Runs after the
  // lines for the new window have loaded, since revealLogAt also moved the range.
  const [flash, setFlash] = useState<number | null>(null);
  useEffect(() => {
    if (logReveal === null || lines.length === 0) return;
    let best = lines[0]!;
    for (const line of lines) {
      if (Math.abs(line.tMs - logReveal.tMs) < Math.abs(best.tMs - logReveal.tMs)) best = line;
    }
    const key = `${best.captureId}-${best.tMs}`;
    const el = [...rows.current].find(([k]) => k.startsWith(key))?.[1];
    el?.scrollIntoView({ block: 'center' });
    setFlash(best.tMs);
    const timer = setTimeout(() => setFlash(null), 1600);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logReveal, lines]);

  if (!hasLogs && parsing.length === 0) {
    return (
      <div className="logview empty muted small">
        No log loaded. Drop a <code>mongod.log</code> next to the capture, or use <b>+ log</b> on
        a node — the lines appear here following the dashboard's time range, with elections,
        sync-source changes and stalls highlighted. Double-click a line to pin a marker; click a
        line to read it in full.
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

      {/* Parsing bar. A multi-gigabyte log is not instant, and without this it looks hung. The
          total is unknown until the read finishes -- it is a windowed scan -- so this reports
          progress made rather than a percentage. */}
      {parsing.length > 0 && (
        <div className="logview-parsing">
          <div className="bar indeterminate">
            <div className="bar-fill" />
          </div>
          <div className="muted small">
            reading log… {(parsingBytes / 1e6).toFixed(0)} MB · {parsingLines.toLocaleString()} lines
          </div>
        </div>
      )}

      {hasLogs && (
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
      )}

      <div className="logview-lines" ref={list}>
        {lines.map((line, i) => {
          const key = `${line.captureId}-${line.tMs}-${i}`;
          const isOpen = expanded === key;
          const cls =
            'logline' +
            (line.important ? ' important' : '') +
            (pinned.has(line.tMs) ? ' pinned' : '') +
            (flash === line.tMs ? ' flash' : '') +
            (isOpen ? ' open' : '') +
            ` ${SEVERITY_CLASS[line.severity] ?? ''}`;
          return (
            <div
              key={key}
              ref={(el) => {
                if (el) rows.current.set(key, el);
                else rows.current.delete(key);
              }}
              className={cls}
              title="Click to expand · double-click to pin a marker"
              // A double-click fires two clicks first, so expansion toggles back to where it
              // was and the marker is pinned without leaving a row open.
              onClick={() => setExpanded(isOpen ? null : key)}
              onDoubleClick={() =>
                togglePin({ tMs: line.tMs, label: line.label || line.msg, severity: line.severity })
              }
            >
              <div className="logline-row">
                <span className="logline-time">{stamp(line.tMs)}</span>
                {multiNode && <span className="logline-host">{line.captureLabel}</span>}
                <span className="logline-comp muted">{line.component}</span>
                {line.label !== '' && <span className="logline-badge">{line.label}</span>}
                <span className="logline-msg">
                  <b>{line.msg}</b>
                  {line.attr !== '' && <span className="muted"> {line.attr}</span>}
                </span>
              </div>
              {isOpen && (
                <div className="logline-full">
                  <b>{line.msg}</b>
                  {line.attr !== '' && <div className="logline-attr">{line.attr}</div>}
                </div>
              )}
            </div>
          );
        })}
        {!loading && hasLogs && lines.length === 0 && (
          <div className="muted small pad">
            No log lines in this window{query ? ' matching the filter' : ''}.
          </div>
        )}
      </div>
    </div>
  );
}
