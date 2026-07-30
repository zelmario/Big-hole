import { useCallback, useMemo, useState, type ReactElement } from 'react';

import { useStore } from '../store/useStore.js';
import { NO_DATA, stateColour, stateName, type MemberRow, type StateRun } from './state.js';

/**
 * Replica-set member state as a band per member, above the charts.
 *
 * This is the frame every other panel is read inside. "RSS climbed on this node" means one thing
 * on a primary and another on a secondary that spent the window in RECOVERING, and until now the
 * only way to find out which was to build a panel on `replSetGetStatus.myState` and squint at a
 * flat line. The strip answers it before anyone asks.
 *
 * Rendered as positioned divs rather than as a uPlot panel, deliberately. A band chart of a dozen
 * discrete codes is not a time series -- there is nothing to interpolate, no y scale to share and
 * no envelope to draw -- and as DOM it gets legible labels inside the bands, per-run tooltips and
 * click-to-zoom for free. It sits outside the grid for the same reason the maximised panel does:
 * it is not a panel, so it must not enter a layout, a permalink or a saved dashboard.
 *
 * The x domain is the dashboard's own window, so zooming a chart moves the strip with it. Exact
 * pixel alignment with the plots is not attempted -- uPlot's y-axis gutter is measured from its
 * tick labels and varies per panel -- so the strip carries its own axis and says its own times.
 */

/** Ticks are chosen from this ladder, so labels land on round times rather than on n/8ths. */
const TICK_STEPS_MS = [
  1_000, 5_000, 15_000, 30_000,
  60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000,
  3_600_000, 3 * 3_600_000, 6 * 3_600_000, 12 * 3_600_000,
  86_400_000, 7 * 86_400_000,
];

function tickStep(spanMs: number, target: number): number {
  const want = spanMs / Math.max(1, target);
  return TICK_STEPS_MS.find((s) => s >= want) ?? TICK_STEPS_MS[TICK_STEPS_MS.length - 1]!;
}

/**
 * UTC, like every other timestamp this app renders.
 *
 * A local-time axis here beside a UTC axis on the charts would be the exact bug fixed in
 * `TimeSeriesPanel` -- two notations for one clock, with nothing on screen saying which is which.
 */
function tickLabel(ms: number, step: number): string {
  const iso = new Date(ms).toISOString();
  if (step >= 86_400_000) return iso.slice(0, 10);
  if (step >= 60_000) return iso.slice(11, 16);
  return iso.slice(11, 19);
}

function fullStamp(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').replace('.000Z', 'Z');
}

function humanSpan(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  return `${(ms / 86_400_000).toFixed(1)}d`;
}

/** Runs clipped to the visible window, dropping the ones entirely outside it. */
function clip(runs: readonly StateRun[], fromMs: number, toMs: number): StateRun[] {
  const out: StateRun[] = [];
  for (const run of runs) {
    if (run.toMs <= fromMs || run.fromMs >= toMs) continue;
    out.push({
      state: run.state,
      fromMs: Math.max(run.fromMs, fromMs),
      toMs: Math.min(run.toMs, toMs),
    });
  }
  return out;
}

/**
 * Narrowest band that gets to carry its state name, in pixels.
 *
 * Without it the label is simply clipped, and a clipped state name is not a shortened label --
 * it is a different word. A two-percent "no data" band rendered as "o data" next to a
 * "SECONDARY" band reads as data, which is the one thing it must not do. Measured against the
 * real track rather than expressed as a percentage, because the percentage a name needs depends
 * entirely on how wide the window is.
 */
const LABEL_MIN_PX = 66;

function Row({
  row,
  fromMs,
  toMs,
  trackPx,
}: {
  row: MemberRow;
  fromMs: number;
  toMs: number;
  trackPx: number;
}): ReactElement {
  const setRange = useStore((s) => s.setRange);
  const span = Math.max(1, toMs - fromMs);
  const runs = clip(row.runs, fromMs, toMs);

  return (
    <div className="states-row">
      <div
        className={row.self ? 'states-name' : 'states-name peer'}
        title={
          row.self
            ? `${row.label} — its own replSetGetStatus.myState${
                row.memberId !== null ? ` (member ${row.memberId})` : ''
              }`
            : `${row.label} — not loaded; this is ${row.reportedBy}'s heartbeat view of it, so ` +
              `DOWN here means ${row.reportedBy} could not reach it`
        }
      >
        {row.label}
        {!row.self && <span className="muted"> ⟵ {row.reportedBy}</span>}
      </div>
      <div className="states-track">
        {runs.map((run) => {
          const left = ((run.fromMs - fromMs) / span) * 100;
          const width = ((run.toMs - run.fromMs) / span) * 100;
          const name = stateName(run.state);
          return (
            <button
              key={`${run.fromMs}-${run.state}`}
              className={run.state === NO_DATA ? 'states-run nodata' : 'states-run'}
              style={{
                left: `${left}%`,
                width: `${width}%`,
                ...(run.state === NO_DATA ? {} : { background: stateColour(run.state) }),
              }}
              title={
                `${row.label} — ${name}\n${fullStamp(run.fromMs)} → ${fullStamp(run.toMs)}` +
                ` (${humanSpan(run.toMs - run.fromMs)})\nclick to zoom to it`
              }
              // Zooming to the run is the gesture this makes obvious: an election is a boundary
              // between two bands, and what anyone wants next is the minutes around it on every
              // chart.
              onClick={() => setRange([Math.round(run.fromMs), Math.round(run.toMs)])}
            >
              {(width / 100) * trackPx >= LABEL_MIN_PX && (
                <span className="states-run-label">{name}</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function StateStrip(): ReactElement | null {
  const rows = useStore((s) => s.memberStates);
  const bounds = useStore((s) => s.bounds)();
  const range = useStore((s) => s.range);
  const show = useStore((s) => s.showStates);
  const toggle = useStore((s) => s.toggleStates);
  const setRange = useStore((s) => s.setRange);

  // Every row's track is the same width, so one measurement serves all of them. It decides
  // which bands are wide enough to be named -- see LABEL_MIN_PX.
  const [trackPx, setTrackPx] = useState(0);
  const measure = useCallback((el: HTMLDivElement | null) => {
    if (el === null) return undefined;
    setTrackPx(el.clientWidth);
    const observer = new ResizeObserver(() => setTrackPx(el.clientWidth));
    observer.observe(el);
    // React 19 runs a ref callback's return value as its cleanup, so the observer dies with the
    // element rather than outliving a collapsed strip.
    return () => observer.disconnect();
  }, []);

  const view = useMemo<[number, number] | null>(() => {
    if (range !== null) return range;
    if (bounds === null) return null;
    return [bounds.startMs, bounds.endMs];
  }, [range, bounds]);

  // A standalone server has no replSetGetStatus at all, and a strip of nothing is worse than no
  // strip: it claims the question was asked and answered.
  if (rows === null || rows.length === 0 || view === null) return null;

  const [fromMs, toMs] = view;
  const span = Math.max(1, toMs - fromMs);
  const step = tickStep(span, 8);
  const ticks: number[] = [];
  for (let t = Math.ceil(fromMs / step) * step; t <= toMs; t += step) ticks.push(t);

  return (
    <div className="states">
      <div className="states-head">
        <button
          className="link small"
          title={show ? 'Hide the member-state strip' : 'Show the member-state strip'}
          onClick={() => toggle()}
        >
          {show ? '▾' : '▸'} member state
        </button>
        {show && (
          <>
            <span className="muted small">
              {rows.length} member{rows.length === 1 ? '' : 's'}
              {rows.some((r) => !r.self) && ' · dimmed rows are a peer’s heartbeat view'}
            </span>
            <span className="spacer" />
            {range !== null && (
              <button className="link small" title="Back to the whole capture" onClick={() => setRange(null)}>
                reset zoom
              </button>
            )}
          </>
        )}
      </div>

      {show && (
        <>
          {rows.map((row) => (
            <Row key={row.key} row={row} fromMs={fromMs} toMs={toMs} trackPx={trackPx} />
          ))}
          <div className="states-row states-axis">
            <div className="states-name" />
            <div className="states-track" ref={measure}>
              {ticks.map((t) => (
                <span
                  key={t}
                  className="states-tick"
                  style={{ left: `${((t - fromMs) / span) * 100}%` }}
                >
                  {tickLabel(t, step)}
                </span>
              ))}
              <span className="states-tz muted">UTC</span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
