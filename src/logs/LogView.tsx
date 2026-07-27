import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from 'react';

import { useStore } from '../store/useStore.js';
import { dropOverlap, pageSize } from './paging.js';
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
 *
 * Rendered twice over: the narrow sidebar strip, and -- when `fullscreen` is set -- a `less`-like
 * window (see LogWindow) with room to read and keyboard navigation. The data path is identical;
 * only the chrome and the line budget differ.
 */
type ViewLine = LogViewLine & { captureId: string; captureLabel: string };

const SEVERITY_CLASS: Record<string, string> = { F: 'sev-error', E: 'sev-error', W: 'sev-warn' };

function stamp(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 23);
}

// How many lines the buffer holds. Generous, because zooming out to see more of the log is the
// whole point -- and affordable, because `content-visibility: auto` on each row means the
// browser lays out and paints only the handful on screen, whatever the count (see styles.css).
//
// It is a cap on what is RESIDENT, not on what is reachable: hitting either edge loads the next
// page and drops the same number of lines off the far end, so the buffer slides through the
// window instead of stopping at an arbitrary line. That is what the cap has to be, because a
// line costs up to 12 KB of strings -- a 24-hour log held whole is hundreds of megabytes, which
// is the same promise the metric store keeps by not holding series resident.
const MAX_LINES = 3000;
const MAX_LINES_FULL = 10000;


export function LogView({
  fullscreen = false,
  onClose,
}: {
  fullscreen?: boolean;
  onClose?: () => void;
} = {}): ReactElement {
  const hasLogs = useStore((s) => s.hasLogs)();
  const range = useStore((s) => s.range);
  const bounds = useStore((s) => s.bounds)();
  const logLines = useStore((s) => s.logLines);
  const togglePin = useStore((s) => s.togglePin);
  const clearPins = useStore((s) => s.clearPins);
  const pins = useStore((s) => s.pins);
  const captures = useStore((s) => s.captures);
  const toggleLogFullscreen = useStore((s) => s.toggleLogFullscreen);
  const logFollow = useStore((s) => s.logFollow);
  const toggleLogFollow = useStore((s) => s.toggleLogFollow);
  const setRange = useStore((s) => s.setRange);
  const setLogViewSpan = useStore((s) => s.setLogViewSpan);
  const logReveal = useStore((s) => s.logReveal);
  // A log being parsed: bytes read so far, summed across whatever is loading.
  const progress = useStore((s) => s.logProgress);
  // Redraw when a log is attached to a node that is already open.
  const logsKey = useStore((s) => s.captures.map((c) => (c.logs ? c.id : '')).join(','));

  const [importantOnly, setImportantOnly] = useState(false);
  const [query, setQuery] = useState('');
  const [lines, setLines] = useState<ViewLine[]>([]);
  const [loading, setLoading] = useState(false);
  // Whether the window holds lines outside the resident buffer, on each side.
  const [hasBefore, setHasBefore] = useState(false);
  const [hasAfter, setHasAfter] = useState(false);
  const [paging, setPaging] = useState<'up' | 'down' | null>(null);
  // Keyboard selection, only meaningful in the full-screen window. The highlighted row the
  // arrow/j-k keys move, expand and page around.
  const [selected, setSelected] = useState<number | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const rows = useRef(new Map<string, HTMLDivElement>());
  const rowEls = useRef<Array<HTMLDivElement | null>>([]);
  const search = useRef<HTMLInputElement>(null);
  // Where to scroll the buffer to on entering follow mode, so the charts do not jump.
  const pendingScrollMs = useRef<number | null>(null);
  // rAF gate: scroll fires far faster than a chart needs to repaint.
  const followTick = useRef(false);
  // One page load at a time, and the pixels to add to scrollTop once it has rendered so the
  // lines under the reader's eye do not move (see the layout effect below).
  const pagingLock = useRef(false);
  const scrollAdjust = useRef(0);

  // "Zoom the log" only makes sense beside the charts, so it is a sidebar behaviour; the
  // full-screen window covers the charts and never drives them.
  const followActive = logFollow && !fullscreen;

  // The window whose lines are loaded. Following, it is the whole capture -- a fixed buffer the
  // user scrolls, decoupled from `range` so panning the charts cannot refetch it and loop.
  // Otherwise it is the dashboard range, and the log follows the charts as before.
  const wholeMs: [number, number] = bounds ? [bounds.startMs, bounds.endMs] : [0, 0];
  const [from, to] = followActive ? wholeMs : (range ?? wholeMs);
  const pinned = useMemo(() => new Set(pins.map((p) => p.tMs)), [pins]);

  const parsing = Object.values(progress);
  const parsingBytes = parsing.reduce((n, p) => n + p.bytes, 0);
  const parsingLines = parsing.reduce((n, p) => n + p.lines, 0);

  // Re-read whenever the window, the filter, or the set of loaded logs changes. Debounced,
  // because dragging the time range fires setRange continuously and each read is a worker round
  // trip -- there is no point issuing one per pixel of the drag.
  // A follow buffer spans the whole capture, so it needs the larger budget too.
  const bufferCap = fullscreen || followActive ? MAX_LINES_FULL : MAX_LINES;

  useEffect(() => {
    if (!hasLogs || to <= from) {
      setLines([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(() => {
      void logLines(from, to, {
        maxLines: bufferCap,
        importantOnly,
        query,
      })
        .then((result) => {
          if (cancelled) return;
          setLines(result.lines);
          // A fresh window starts at its beginning, so there is nothing before it yet.
          setHasBefore(false);
          setHasAfter(result.hasAfter);
          // Keep the highlighted row in range as the window shifts under it, rather than
          // pointing past the end of a shorter result.
          setSelected((s) => (s === null ? null : Math.min(s, result.lines.length - 1)));
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
  }, [hasLogs, from, to, importantOnly, query, logsKey, fullscreen, followActive]);

  /**
   * Load the next page at one edge of the buffer and drop the same number of lines off the other.
   *
   * The request is a sub-range of the window the viewer is already showing, anchored on the line
   * at the edge -- forwards from the last line held, or backwards to the first. Backwards asks
   * the reader for the END of that sub-range (`end: 'tail'`), which is why scrolling up does not
   * cost a scan from the start of a 36-hour log.
   */
  async function loadPage(dir: 'up' | 'down'): Promise<void> {
    const el = list.current;
    if (pagingLock.current || loading || el === null || lines.length === 0) return;
    if (dir === 'up' ? !hasBefore : !hasAfter) return;

    pagingLock.current = true;
    setPaging(dir);
    try {
      // Rows are a uniform height, which the follow-mode mapping already relies on.
      const rowH = el.scrollHeight / lines.length;
      const anchor = dir === 'up' ? lines[0]!.tMs : lines[lines.length - 1]!.tMs;
      const held = lines.filter((l) => l.tMs === anchor);
      const size = pageSize(bufferCap);

      const ask = async (shift: number) =>
        dir === 'up'
          ? logLines(from, anchor + shift, { maxLines: size, importantOnly, query, end: 'tail' })
          : logLines(anchor + shift, to, { maxLines: size, importantOnly, query, end: 'head' });

      let page = await ask(0);
      let fresh = dropOverlap(page.lines, held);
      // A page's worth of lines sharing one millisecond would otherwise wedge here, the boundary
      // filter removing everything the request returned. Stepping past the instant loses those
      // duplicates rather than the reader's ability to scroll.
      if (fresh.length === 0 && page.lines.length > 0) {
        page = await ask(dir === 'up' ? -1 : 1);
        fresh = page.lines;
      }

      if (fresh.length === 0) {
        if (dir === 'up') setHasBefore(false);
        else setHasAfter(false);
        return;
      }

      const joined = dir === 'up' ? [...fresh, ...lines] : [...lines, ...fresh];
      const over = Math.max(0, joined.length - bufferCap);

      if (dir === 'up') {
        setLines(over > 0 ? joined.slice(0, joined.length - over) : joined);
        setHasBefore(page.hasBefore);
        if (over > 0) setHasAfter(true);
        // Everything that was on screen moved down by the lines inserted above it.
        scrollAdjust.current = fresh.length * rowH;
        setSelected((s) => (s === null ? null : s + fresh.length));
      } else {
        setLines(over > 0 ? joined.slice(over) : joined);
        setHasAfter(page.hasAfter);
        if (over > 0) setHasBefore(true);
        scrollAdjust.current = -over * rowH;
        setSelected((s) => (s === null ? null : Math.max(0, s - over)));
      }
    } catch {
      // A failed page leaves the buffer as it was; the next scroll tries again.
    } finally {
      pagingLock.current = false;
      setPaging(null);
    }
  }

  // Hold the reader's place across a page load. Must be layout, not effect: the browser would
  // otherwise paint one frame with the buffer shifted, which reads as the log jumping.
  useLayoutEffect(() => {
    if (scrollAdjust.current !== 0 && list.current !== null) {
      list.current.scrollTop += scrollAdjust.current;
    }
    scrollAdjust.current = 0;
  }, [lines]);

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

  // Keep the keyboard-selected row on screen as it moves.
  useEffect(() => {
    if (selected === null) return;
    rowEls.current[selected]?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  // less-style keyboard navigation, only while the full-screen window is up. Typing in the
  // filter takes precedence -- only Escape is honoured there, to step back out to the list.
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent): void => {
      const inSearch = document.activeElement === search.current;
      if (e.key === 'Escape') {
        if (inSearch) search.current?.blur();
        else onClose?.();
        return;
      }
      if (inSearch) return;
      const n = lines.length;
      const to = (i: number): void => {
        e.preventDefault();
        setSelected(Math.max(0, Math.min(n - 1, i)));
      };
      const page = (dir: 1 | -1): void => {
        e.preventDefault();
        list.current?.scrollBy({ top: dir * (list.current.clientHeight * 0.9) });
      };
      // Long lines do not wrap -- they scroll sideways, the way `less -S` chops them. h/l and
      // the arrows walk across a wide JSON command doc without a mouse.
      const pan = (dir: 1 | -1): void => {
        e.preventDefault();
        list.current?.scrollBy({ left: dir * (list.current.clientWidth * 0.5) });
      };
      // Jump to the next/previous notable line -- an election, a stall -- skating over the
      // connection-churn between them. The reason to read a 24-hour log at all.
      const notable = (dir: 1 | -1): void => {
        e.preventDefault();
        for (let i = (selected ?? (dir === 1 ? -1 : n)) + dir; i >= 0 && i < n; i += dir) {
          if (lines[i]!.important) {
            setSelected(i);
            return;
          }
        }
      };
      switch (e.key) {
        case 'j': case 'ArrowDown': to((selected ?? -1) + 1); break;
        case 'k': case 'ArrowUp': to((selected ?? n) - 1); break;
        case 'h': case 'ArrowLeft': pan(-1); break;
        case 'l': case 'ArrowRight': pan(1); break;
        case 'g': to(0); break;
        case 'G': to(n - 1); break;
        case ' ': case 'PageDown': page(1); break;
        case 'b': case 'PageUp': page(-1); break;
        case 'n': notable(1); break;
        case 'N': notable(-1); break;
        case '/':
          e.preventDefault();
          search.current?.focus();
          search.current?.select();
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreen, lines, selected, onClose]);

  // Entering follow mode, position the buffer so the charts do not jump: scroll to the line at
  // the range the charts were already showing. Set once the whole-capture buffer has loaded.
  useEffect(() => {
    if (!followActive || pendingScrollMs.current === null || lines.length === 0) return;
    const target = pendingScrollMs.current;
    pendingScrollMs.current = null;
    const el = list.current;
    if (el === null) return;
    let idx = lines.findIndex((l) => l.tMs >= target);
    if (idx < 0) idx = lines.length - 1;
    // Uniform row height: every log line is one physical row in the same font.
    el.scrollTop = (el.scrollHeight / lines.length) * idx;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [followActive, lines]);

  // The time span of the log lines currently on screen. Rows are a uniform height, so the
  // visible range maps straight from the scroll offset without measuring each one.
  function visibleSpan(): [number, number] | null {
    const el = list.current;
    if (el === null || lines.length === 0) return null;
    const rowH = el.scrollHeight / lines.length;
    if (rowH <= 0) return null;
    const clamp = (i: number): number => Math.max(0, Math.min(lines.length - 1, i));
    const first = clamp(Math.floor(el.scrollTop / rowH));
    const last = clamp(Math.floor((el.scrollTop + el.clientHeight) / rowH));
    return [lines[first]!.tMs, lines[last]!.tMs];
  }

  // Publish the visible span so the panels can shade it, and -- when following -- pan the charts
  // to it. The panning window is a little wider than the span, so the shaded band reads as a
  // window with metric context around it rather than filling the whole chart. rAF-gated, because
  // scroll fires per pixel. The buffer is pinned to the whole capture (not `range`), so setting
  // `range` here cannot refetch it -- that is what breaks the feedback loop.
  function onListScroll(): void {
    // Page before the reader reaches the very edge, so the next lines are usually already there.
    // Ahead of the follow-mode gate below, because the full-screen window is exactly where a
    // long log gets read and it does not drive the charts.
    const el = list.current;
    if (el !== null) {
      const NEAR_EDGE_PX = 600;
      if (el.scrollTop < NEAR_EDGE_PX) void loadPage('up');
      else if (el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_EDGE_PX) void loadPage('down');
    }

    if (fullscreen || followTick.current) return;
    followTick.current = true;
    requestAnimationFrame(() => {
      followTick.current = false;
      const span = visibleSpan();
      if (span === null) return;
      setLogViewSpan(span);
      if (followActive) {
        const [a, b] = span;
        // Context on each side: a third of the span, or a sample interval when the span is
        // effectively an instant.
        const margin = Math.max((b - a) / 3, bounds?.cadenceMs ?? 1000);
        setRange([a - margin, b + margin]);
      }
    });
  }

  // The band should be there before the first scroll, and gone when the log tab is not open.
  useEffect(() => {
    if (fullscreen) return;
    setLogViewSpan(lines.length === 0 ? null : visibleSpan());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullscreen, lines]);
  useEffect(() => {
    if (fullscreen) return undefined;
    return () => setLogViewSpan(null);
  }, [fullscreen, setLogViewSpan]);

  if (!hasLogs && parsing.length === 0) {
    return (
      <div className="logview empty muted small">
        No log loaded. Drop a <code>mongod.log</code> next to the capture, or use <b>+ log</b> on
        a node — the lines appear here following the dashboard's time range, with elections,
        sync-source changes and stalls highlighted. Double-click a line to pin a marker.
      </div>
    );
  }

  const multiNode = captures.filter((c) => c.logs !== undefined && c.visible).length > 1;

  return (
    <div className="logview">
      <div className="logview-head">
        <input
          ref={search}
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
        {!fullscreen && (
          <>
            <button
              className={followActive ? 'link small on' : 'link small'}
              title="Zoom the log: scroll the log and the charts pan to follow the lines on screen"
              onClick={() => {
                // Remember where the charts are, so entering does not jump them.
                if (!logFollow) pendingScrollMs.current = (range ?? wholeMs)[0];
                toggleLogFollow();
              }}
            >
              {followActive ? '● following' : 'zoom the log'}
            </button>
            <button
              className="link small"
              title="Open the log full-screen"
              onClick={() => toggleLogFullscreen(true)}
            >
              ⤢ full screen
            </button>
          </>
        )}
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
          {/* The buffer is a window, so say which way there is more of it rather than the old
              "zoom in" -- scrolling now reaches it. */}
          {!loading && (hasBefore || hasAfter) && (
            <span className="muted"> · more {hasBefore ? (hasAfter ? '↑↓' : '↑') : '↓'}</span>
          )}
          {paging !== null && <span className="muted"> · loading {paging === 'up' ? '↑' : '↓'}</span>}
          {followActive ? ' · scroll to pan the charts' : range === null && ' · whole capture'}
          {pins.length > 0 && (
            <button className="link small" onClick={clearPins}>
              clear {pins.length} pin{pins.length === 1 ? '' : 's'}
            </button>
          )}
        </div>
      )}

      <div className="logview-lines" ref={list} onScroll={onListScroll}>
        {lines.map((line, i) => {
          const key = `${line.captureId}-${line.tMs}-${i}`;
          const cls =
            'logline' +
            (line.important ? ' important' : '') +
            (pinned.has(line.tMs) ? ' pinned' : '') +
            (flash === line.tMs ? ' flash' : '') +
            (selected === i ? ' sel' : '') +
            ` ${SEVERITY_CLASS[line.severity] ?? ''}`;
          return (
            <div
              key={key}
              ref={(el) => {
                rowEls.current[i] = el;
                if (el) rows.current.set(key, el);
                else rows.current.delete(key);
              }}
              className={cls}
              // No expand-on-click any more -- the full line is read by scrolling the window
              // sideways. A click just anchors the keyboard selection; a double-click still pins
              // a marker across every chart.
              title="Double-click to pin a marker on every chart"
              onClick={() => setSelected(i)}
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
