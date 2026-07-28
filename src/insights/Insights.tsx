import type { ReactElement } from 'react';

import { useStore } from '../store/useStore.js';
import { formatValue } from '../data/format.js';
import type { Finding } from './detect.js';

/**
 * What the detectors found, as a flat list.
 *
 * Nothing is collapsed and nothing is behind a click. A finding is three facts -- what happened,
 * when, and what to look at next -- and all three are short enough to print. Hiding the third
 * one behind a disclosure triangle would make this a list of alarms instead of a list of leads,
 * and an alarm you have to click to understand is one you learn to ignore.
 *
 * Clicking a finding zooms the dashboard to its worst episode, because the finding is not the
 * answer -- it is a coordinate. The answer is on the charts at that moment.
 */

function stamp(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(11, 19);
}

function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** "6m 30s", "2h 05m" -- durations here span seconds to hours. */
function span(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

function Row({ finding }: { finding: Finding }): ReactElement {
  const setRange = useStore((s) => s.setRange);
  const explainRange = useStore((s) => s.explainRange);
  const captures = useStore((s) => s.captures);
  const multiNode = captures.filter((c) => c.visible).length > 1;

  // A window with context either side: the episode alone tells you nothing about what led to it,
  // and what led to it is the whole reason to look.
  const width = Math.max(finding.worstToMs - finding.worstFromMs, 60_000);
  const jump = (): void => {
    setRange([finding.worstFromMs - width, finding.worstToMs + width]);
  };

  return (
    <div
      className={`finding sev-${finding.severity}`}
      onClick={jump}
      title="Zoom the dashboard to this episode"
    >
      <div className="finding-head">
        <span className={`finding-dot sev-${finding.severity}`} />
        <b>{finding.title}</b>
        {multiNode && <span className="finding-host">{finding.captureLabel}</span>}
      </div>

      {/* Two spans, because they answer different questions. The first is how long this was a
          feature of the capture at all -- 174 episodes over twenty minutes and over sixty hours
          mean very different things. The second is the stretch the click jumps to. */}
      <div className="finding-when muted small">
        {day(finding.firstMs)} {stamp(finding.firstMs)}–{stamp(finding.lastMs)}
        {finding.episodes > 1 && ` · ${finding.episodes} episodes`}
        {' · '}
        {span(finding.totalMs)} in state
        {' · worst '}
        {formatValue(finding.peak, finding.unit)}
      </div>
      <div className="finding-when muted small">
        worst stretch {stamp(finding.worstFromMs)}–{stamp(finding.worstToMs)} — click to zoom
        {/* The finding says a threshold was crossed; the explanation says what else was
            different while it was. Stop the click so it does not also fire the plain zoom. */}
        <button
          className="link small"
          title="Rank every metric over this episode"
          onClick={(e) => {
            e.stopPropagation();
            explainRange(finding.worstFromMs - width, finding.worstToMs + width);
          }}
        >
          explain
        </button>
      </div>

      <div className="finding-what small">{finding.what}</div>
      <div className="finding-check muted small">
        <b>Next:</b> {finding.check}
      </div>
      <div className="finding-metric muted small">{finding.metric}</div>
    </div>
  );
}

export function Insights(): ReactElement {
  const findings = useStore((s) => s.findings);
  const analyzing = useStore((s) => s.analyzing);
  const analyze = useStore((s) => s.analyze);
  const captures = useStore((s) => s.captures);

  if (captures.length === 0) {
    return <div className="logview empty muted small">Load a capture and the checks run on it.</div>;
  }

  return (
    <div className="insights">
      <div className="logview-note muted small">
        {analyzing
          ? 'checking…'
          : findings === null
            ? 'not checked yet'
            : `${findings.length} finding${findings.length === 1 ? '' : 's'}`}
        <button className="link small" onClick={() => void analyze()}>
          re-check
        </button>
      </div>

      {/* An empty result is a real answer and deserves to be stated, not left as a blank panel
          that reads as "this did not run". */}
      {!analyzing && findings !== null && findings.length === 0 && (
        <div className="muted small pad">
          None of the checks fired. No sustained ticket exhaustion, cache pressure, queueing,
          flow control or page faulting anywhere in this capture. That is not a clean bill of
          health for everything — only for what is checked.
        </div>
      )}

      <div className="findings">
        {(findings ?? []).map((finding) => (
          <Row key={`${finding.captureId}-${finding.ruleId}-${finding.metric}`} finding={finding} />
        ))}
      </div>
    </div>
  );
}
