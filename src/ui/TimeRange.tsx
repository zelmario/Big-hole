import { useState, type ReactElement } from 'react';

import { useStore } from '../store/useStore.js';

/**
 * Grafana-style time range control.
 *
 * One difference from Grafana that matters: a capture is historical, so "last 1 hour" means
 * the last hour **of the capture**, not the last hour of wall-clock time. Anchoring to `now`
 * would land outside the data and show an empty dashboard.
 */
const PRESETS: ReadonlyArray<[string, number]> = [
  ['5m', 5 * 60_000],
  ['15m', 15 * 60_000],
  ['1h', 3_600_000],
  ['3h', 3 * 3_600_000],
  ['6h', 6 * 3_600_000],
  ['12h', 12 * 3_600_000],
  ['24h', 24 * 3_600_000],
  ['2d', 2 * 86_400_000],
  ['7d', 7 * 86_400_000],
];

function stamp(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

export function TimeRange(): ReactElement {
  // The union across every loaded node: the picker covers the whole investigation window,
  // not one member's slice of it.
  const bounds = useStore((s) => s.bounds)();
  const range = useStore((s) => s.range);
  const setRange = useStore((s) => s.setRange);
  const [open, setOpen] = useState(false);

  if (bounds === null) return <></>;

  const full: [number, number] = [bounds.startMs, bounds.endMs];
  const [from, to] = range ?? full;
  const span = to - from;
  const captureSpan = bounds.endMs - bounds.startMs;

  /** Anchor a relative window to the end of the capture, clamped to what exists. */
  const applyPreset = (windowMs: number): void => {
    if (windowMs >= captureSpan) setRange(null);
    else setRange([bounds.endMs - windowMs, bounds.endMs]);
    setOpen(false);
  };

  const zoom = (factor: number): void => {
    const centre = from + span / 2;
    const next = span * factor;
    if (next >= captureSpan) {
      setRange(null);
      return;
    }
    setRange([
      Math.max(bounds.startMs, Math.round(centre - next / 2)),
      Math.min(bounds.endMs, Math.round(centre + next / 2)),
    ]);
  };

  const shift = (direction: -1 | 1): void => {
    const step = span / 2;
    let nextFrom = from + direction * step;
    let nextTo = to + direction * step;
    // Slide against the ends of the capture rather than scrolling off into empty space.
    if (nextFrom < bounds.startMs) {
      nextTo += bounds.startMs - nextFrom;
      nextFrom = bounds.startMs;
    }
    if (nextTo > bounds.endMs) {
      nextFrom -= nextTo - bounds.endMs;
      nextTo = bounds.endMs;
    }
    setRange([Math.round(Math.max(bounds.startMs, nextFrom)), Math.round(nextTo)]);
  };

  return (
    <div className="timerange">
      <button className="tr-btn" title="Shift earlier" onClick={() => shift(-1)}>
        ‹
      </button>

      <button className="tr-main" onClick={() => setOpen(!open)} title="Change time range">
        🕐 {stamp(from)} → {stamp(to)}
        {range === null && <span className="muted"> (all)</span>}
      </button>

      <button className="tr-btn" title="Shift later" onClick={() => shift(1)}>
        ›
      </button>
      <button className="tr-btn" title="Zoom out" onClick={() => zoom(2)}>
        ⊖
      </button>
      <button className="tr-btn" title="Zoom in" onClick={() => zoom(0.5)}>
        ⊕
      </button>

      {open && (
        <div className="tr-menu">
          <div className="tr-menu-head muted small">
            Relative to the end of the capture
            <div>{stamp(bounds.startMs)} → {stamp(bounds.endMs)}</div>
          </div>
          <button
            className="tr-preset"
            onClick={() => {
              setRange(null);
              setOpen(false);
            }}
          >
            Whole capture
          </button>
          {PRESETS.filter(([, ms]) => ms < captureSpan).map(([label, ms]) => (
            <button key={label} className="tr-preset" onClick={() => applyPreset(ms)}>
              Last {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
