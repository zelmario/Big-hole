import { useMemo, type ReactElement } from 'react';

import { useStore } from '../store/useStore.js';

/**
 * What the log said, and when.
 *
 * The markers on the charts answer "was there an event here"; this answers "what was it". They
 * are the same data and deliberately so -- clicking a row zooms every panel to a window around
 * that event, which is the move an investigation actually makes: see a spike, ask what happened
 * at that moment, then look at the metrics around it.
 *
 * Only annotation-worthy classes appear. High-volume ones (slow queries, connection churn) are
 * series, and the catalogue carries them as `logs.*` metrics.
 */
function stamp(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

const SEVERITY_CLASS: Record<string, string> = { F: 'sev-error', E: 'sev-error', W: 'sev-warn' };

export function EventList(): ReactElement {
  // The filter lives in the store, not here: the same predicate decides which markers the
  // charts draw, so narrowing the list narrows the charts.
  const events = useStore((s) => s.events)();
  const kinds = useStore((s) => s.eventKinds)();
  const kind = useStore((s) => s.eventKind);
  const term = useStore((s) => s.eventTerm);
  const setFilter = useStore((s) => s.setEventFilter);
  const captures = useStore((s) => s.captures);
  const setRange = useStore((s) => s.setRange);

  const matches = useMemo(() => events.slice(0, 500), [events]);
  const total = kinds.reduce((n, k) => n + k.n, 0);
  const multiNode = captures.length > 1;

  if (total === 0) {
    return (
      <div className="events empty muted small">
        No log events. Drop a <code>mongod.log</code> next to the capture — elections,
        sync-source changes, restarts and stalls become markers on every chart, and slow queries
        become <code>logs.*</code> metrics you can plot.
      </div>
    );
  }

  return (
    <div className="events">
      <div className="events-head">
        <input
          className="search"
          value={term}
          onChange={(e) => setFilter(kind, e.target.value)}
          placeholder="Filter events"
        />
        <select value={kind} onChange={(e) => setFilter(e.target.value, term)}>
          <option value="">all ({total})</option>
          {kinds.map((k) => (
            <option key={k.kind} value={k.kind}>
              {k.label} ({k.n})
            </option>
          ))}
        </select>
      </div>

      <p className="muted small">
        {events.length === total
          ? 'Every event is marked on the charts.'
          : `${events.length} of ${total} marked on the charts.`}
      </p>
      <ul>
        {matches.map((e, i) => (
          <li key={`${e.captureId}-${e.tMs}-${i}`}>
            <button
              className={`event ${SEVERITY_CLASS[e.severity] ?? ''}`}
              title={`${e.message}${e.detail ? ` — ${e.detail}` : ''}\nClick to zoom every panel here`}
              // A two-minute window either side: wide enough to show what led up to it, narrow
              // enough that a one-second stall is still a visible feature rather than a pixel.
              onClick={() => setRange([e.tMs - 120_000, e.tMs + 120_000])}
            >
              <span className="event-time">{stamp(e.tMs)}</span>
              {multiNode && <span className="event-host">{e.captureLabel}</span>}
              <span className="event-label">{e.label}</span>
              <span className="event-msg muted">{e.detail || e.message}</span>
            </button>
          </li>
        ))}
      </ul>
      {matches.length === 500 && <p className="muted small pad">showing first 500</p>}
    </div>
  );
}
