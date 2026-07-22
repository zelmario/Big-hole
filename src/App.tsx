import type { ReactElement } from 'react';

import { DropZone } from './ui/DropZone.js';
import { MetricCatalog } from './dashboard/MetricCatalog.js';
import { TimeSeriesPanel } from './panels/TimeSeriesPanel.js';
import { useStore } from './store/useStore.js';

function ms(d: number): string {
  return new Date(d).toISOString().replace('T', ' ').replace('.000Z', 'Z');
}

export function App(): ReactElement {
  const status = useStore((s) => s.status);
  const summary = useStore((s) => s.summary);
  const cursor = useStore((s) => s.cursor);
  const reset = useStore((s) => s.reset);

  return (
    <div className="app">
      <header>
        <h1>ftdc-lens</h1>
        {summary && (
          <div className="summary">
            <b>{summary.hostname ?? 'unknown host'}</b>
            {summary.mongoVersion && <span className="muted"> · {summary.mongoVersion}</span>}
            <span className="muted">
              {' '}· {summary.sampleCount.toLocaleString()} samples · {summary.pathCount.toLocaleString()} metrics
              {' '}· {(summary.cadenceMs / 1000).toFixed(1)}s cadence
            </span>
            <div className="muted small">
              {ms(summary.startMs)} → {ms(summary.endMs)}
            </div>
            {(summary.gaps.length > 0 || summary.restarts.length > 0) && (
              <div className="small warn">
                {summary.gaps.length > 0 && <>⚠ {summary.gaps.length} gap(s) — no samples collected </>}
                {summary.restarts.length > 0 && <>⚠ {summary.restarts.length} restart(s) detected</>}
              </div>
            )}
            {summary.skipped.length > 0 && (
              <details className="small muted">
                <summary>{summary.skipped.length} file(s) skipped</summary>
                <ul>{summary.skipped.map((s) => <li key={s}>{s}</li>)}</ul>
              </details>
            )}
          </div>
        )}
        <div className="spacer" />
        {cursor !== null && <code className="cursor">{ms(cursor)}</code>}
        {status === 'ready' && <button className="link" onClick={reset}>load another</button>}
      </header>

      {status === 'ready' ? (
        <main>
          <MetricCatalog />
          <section className="charts">
            <TimeSeriesPanel />
          </section>
        </main>
      ) : (
        <main className="centered">
          <DropZone />
        </main>
      )}
    </div>
  );
}
