import { useEffect, useRef, type ReactElement } from 'react';

import { useStore } from '../store/useStore.js';
import { formatValue } from '../data/format.js';
import { unitOfPath, type Unit } from '../data/expr.js';
import { legendLabel } from '../panels/plotData.js';
import { MAX_SCAN_SAMPLES, type HostChange } from './ranking.js';

/**
 * What changed in the window on screen.
 *
 * The checks tab says whether anything was wrong with the capture. This says what was different
 * about *this* moment, which is the question you have as soon as you see a spike and the one no
 * fixed rule list can answer. Brush the spike on any chart -- the dashboard is already zoomed to
 * it -- and every metric in the capture is ranked by how far it moved against the stretch of
 * time immediately before.
 *
 * Nothing is hidden behind a click. Each row prints the two numbers it is comparing, in the
 * metric's own units, and clicking one puts the metric on the focused panel so the claim can be
 * checked against the curve rather than believed.
 */

function stamp(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(11, 19);
}

function span(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/**
 * Unit for a row.
 *
 * A counter is being compared per second, so its unit is the rate's -- exactly what
 * `unitOf(rate(x))` produces, since a row is a metric the user can put on a chart as `rate(x)`
 * and should read the same in both places.
 */
function unitFor(change: HostChange): Unit {
  const base = unitOfPath(change.path);
  if (change.kind === 'level') return base;
  return base === 'bytes' ? 'bytes/s' : 'per-sec';
}

/** The expression that draws this row: a counter is only meaningful as a rate. */
function expressionOf(change: HostChange): string {
  return change.kind === 'rate' ? `rate(${change.path})` : change.path;
}

/**
 * "×3.4", "−82%", "+412 MiB" -- whichever states the move most directly.
 *
 * The absolute fallback is not cosmetic. A metric can move by most of its whole-capture range
 * and still be a fraction of a percent of its own value -- an oplog that grew, a counter that
 * barely ever ticks -- and those rows printed "223k → 223k +0%", which reads as a bug in the
 * ranking rather than as a small but unusual change.
 */
function magnitude(from: number, to: number, unit: Unit): string {
  const delta = `${to > from ? '+' : '−'}${formatValue(Math.abs(to - from), unit)}`;
  if (from === 0) return to > from ? 'from zero' : 'to zero';
  if (to === 0) return 'to zero';

  const ratio = to / from;
  // A ratio only means anything between two values of the same sign. Across zero it is
  // arithmetic nonsense -- -0.68 to 6.7e18 printed as "-977359053000902836224%", which reads
  // as a broken tool rather than as a large change. Say what it moved by instead.
  if (!Number.isFinite(ratio) || ratio <= 0 || from < 0) return delta;

  if (ratio > 1.5) return `×${ratio.toFixed(ratio >= 10 ? 0 : 1)}`;
  const percent = (ratio - 1) * 100;
  // Below half a percent the ratio rounds to +0%, which reads as a bug in the ranking rather
  // than as a small but unusual move. A metric can cross most of its whole-capture range and
  // still be a fraction of a percent of its own value.
  if (Math.abs(percent) < 0.5) return delta;
  return percent < 0 ? `−${(-percent).toFixed(0)}%` : `+${percent.toFixed(0)}%`;
}

function Row({ change, multiNode }: { change: HostChange; multiNode: boolean }): ReactElement {
  const toggleMetric = useStore((s) => s.toggleMetric);
  const unit = unitFor(change);
  const expression = expressionOf(change);

  return (
    <button
      className="change"
      title={`${expression} — click to add it to the focused panel`}
      onClick={() => toggleMetric(expression)}
    >
      <div className="change-head">
        {multiNode && <span className="finding-host">{change.captureLabel}</span>}
        <span className="change-label">{legendLabel(change.path)}</span>
        <span className="spacer" />
        <span className={change.window >= change.base ? 'change-up' : 'change-down'}>
          {magnitude(change.base, change.window, unit)}
        </span>
      </div>
      <div className="change-values muted small">
        {formatValue(change.base, unit)} → <b>{formatValue(change.window, unit)}</b>
        {change.kind === 'rate' && ' · rate'}
      </div>
    </button>
  );
}

export function Explain(): ReactElement {
  const range = useStore((s) => s.range);
  const bounds = useStore((s) => s.bounds)();
  const explanation = useStore((s) => s.explanation);
  const explaining = useStore((s) => s.explaining);
  const explainWindow = useStore((s) => s.explainWindow);
  const captures = useStore((s) => s.captures);
  const revealLogAt = useStore((s) => s.revealLogAt);
  const multiNode = captures.filter((c) => c.visible).length > 1;

  const cadence = bounds?.cadenceMs ?? 1000;
  const samples = range === null ? 0 : (range[1] - range[0]) / cadence;
  const tooWide = samples > MAX_SCAN_SAMPLES;

  // Run as soon as this tab is showing a window it has not explained yet. The tab is only
  // mounted when it is selected, so this cannot fire while someone is working on the charts --
  // and once it is open, having to press a button to see the answer for the window already on
  // screen is a step with no decision in it.
  const ran = useRef<string | null>(null);
  const key = range === null ? null : `${range[0]}-${range[1]}`;
  useEffect(() => {
    if (key === null || tooWide || explaining) return;
    if (ran.current === key) return;
    ran.current = key;
    void explainWindow();
  }, [key, tooWide, explaining, explainWindow]);

  if (range === null) {
    return (
      <div className="logview empty muted small">
        Drag across any chart to zoom into a window, then this ranks every metric in the capture
        by how far it moved compared with the stretch of time just before it.
      </div>
    );
  }

  if (tooWide) {
    return (
      <div className="logview empty muted small">
        This window is {span(range[1] - range[0])} — too wide to explain. Explaining reads full
        resolution over every metric, so it is deliberately capped at{' '}
        {MAX_SCAN_SAMPLES.toLocaleString()} samples (about 5 hours at a 1 s cadence). Zoom into
        the incident.
      </div>
    );
  }

  const stale = explanation !== null && key !== `${explanation.window.fromMs}-${explanation.window.toMs}`;

  return (
    <div className="insights">
      <div className="logview-note muted small">
        {stamp(range[0])}–{stamp(range[1])} ({span(range[1] - range[0])})
        <button
          className="link small"
          onClick={() => {
            ran.current = key;
            void explainWindow();
          }}
        >
          {explaining ? 'ranking…' : stale ? 're-run' : 'refresh'}
        </button>
      </div>

      {explanation !== null && explanation.baseline !== null && (
        <div className="muted small pad">
          against {stamp(explanation.baseline.fromMs)}–{stamp(explanation.baseline.toMs)}, the{' '}
          {span(explanation.baseline.toMs - explanation.baseline.fromMs)} before it ·{' '}
          {explanation.compared.toLocaleString()} metrics compared
        </div>
      )}

      {explanation?.errors.map((e) => (
        <div key={e} className="small warn pad">
          ⚠ {e}
        </div>
      ))}

      {/* Before the ranking, because it explains the ranking. Every cumulative counter returns
          to zero at a restart, so a comparison spanning one is mostly reporting that one fact
          over and over. */}
      {explanation?.restarts.map((r) => (
        <div key={`${r.captureId}-${r.tMs}`} className="small warn pad">
          ⚠ {multiNode ? `${r.captureLabel} ` : ''}restarted at {stamp(r.tMs)}, inside the{' '}
          {r.where}. Counters reset at a restart, so much of what follows is that, not a change
          in behaviour.
        </div>
      ))}

      {/* Log first. When an election or a sync-source change lands inside the window, it is the
          explanation and the metrics are its consequences. */}
      {explanation !== null && explanation.events.length > 0 && (
        <div className="explain-events">
          <div className="explain-heading small">log events in this window</div>
          {explanation.events.map((event, i) => (
            <button
              key={`${event.tMs}-${event.kind}-${i}`}
              className="change change-event"
              title="Show this line in the log"
              onClick={() => revealLogAt(event.tMs)}
            >
              <div className="change-head">
                {multiNode && <span className="finding-host">{event.captureLabel}</span>}
                <span className="change-label">{event.label}</span>
                <span className="spacer" />
                <span className="muted small">{stamp(event.tMs)}</span>
              </div>
              <div className="change-values muted small">{event.detail || event.message}</div>
            </button>
          ))}
          {explanation.moreEvents > 0 && (
            <div className="muted small pad">
              and {explanation.moreEvents} more — open the log tab for the window
            </div>
          )}
        </div>
      )}

      {explanation !== null && explanation.changes.length > 0 && (
        <div className="explain-heading small">what moved</div>
      )}
      <div className="findings">
        {(explanation?.changes ?? []).map((change) => (
          <Row
            key={`${change.captureId}-${change.path}-${change.kind}`}
            change={change}
            multiNode={multiNode}
          />
        ))}
      </div>

      {/* An empty ranking is a real answer: this window is not different from the one before it,
          which usually means the incident starts outside it. */}
      {!explaining &&
        explanation !== null &&
        explanation.changes.length === 0 &&
        explanation.events.length === 0 &&
        explanation.errors.length === 0 && (
          <div className="muted small pad">
            Nothing moved enough to report. This window looks like the one before it — try
            brushing across the edge of the spike rather than inside it.
          </div>
        )}
    </div>
  );
}
