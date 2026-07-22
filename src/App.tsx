import { useState, type ReactElement } from 'react';

import { DropZone } from './ui/DropZone.js';
import { ErrorBoundary } from './ui/ErrorBoundary.js';
import { TimeRange } from './ui/TimeRange.js';
import { DashboardMenu } from './ui/DashboardMenu.js';
import { Grid } from './dashboard/Grid.js';
import { MetricCatalog } from './dashboard/MetricCatalog.js';
import { toPermalink } from './dashboard/layout.js';
import { useStore } from './store/useStore.js';

function ms(d: number): string {
  return new Date(d).toISOString().replace('T', ' ').replace('.000Z', 'Z');
}

export function App(): ReactElement {
  const status = useStore((s) => s.status);
  const summary = useStore((s) => s.summary);
  const cursor = useStore((s) => s.cursor);
  const showBand = useStore((s) => s.showBand);
  const showCatalog = useStore((s) => s.showCatalog);
  const toggleCatalog = useStore((s) => s.toggleCatalog);
  const setShowBand = useStore((s) => s.setShowBand);
  const addPanel = useStore((s) => s.addPanel);
  const dashboard = useStore((s) => s.dashboard);
  const reset = useStore((s) => s.reset);

  const [copied, setCopied] = useState<string | null>(null);

  async function share(): Promise<void> {
    const link = toPermalink(dashboard(), window.location.href);
    if (!link.withinLimit) {
      // Too big for a URL: hand over the JSON instead of silently producing a broken link.
      const blob = new Blob([JSON.stringify(dashboard(), null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'ftdc-lens-dashboard.json';
      a.click();
      URL.revokeObjectURL(a.href);
      setCopied('layout too large for a URL — downloaded as JSON');
    } else {
      window.history.replaceState(null, '', link.url);
      try {
        await navigator.clipboard.writeText(link.url);
        setCopied('link copied — it carries the layout, never the data');
      } catch {
        setCopied('link is in the address bar');
      }
    }
    setTimeout(() => setCopied(null), 4000);
  }

  return (
    <div className="app">
      <header>
        <h1>ftdc-lens</h1>
        {summary && (
          <div className="summary">
            <b>{summary.hostname ?? 'unknown host'}</b>
            {summary.mongoVersion && <span className="muted"> · {summary.mongoVersion}</span>}
            <span className="muted">
              {' '}· {summary.sampleCount.toLocaleString()} samples ·{' '}
              {summary.pathCount.toLocaleString()} metrics ·{' '}
              {(summary.cadenceMs / 1000).toFixed(1)}s cadence
            </span>
            <div className="muted small">
              {ms(summary.startMs)} → {ms(summary.endMs)}
            </div>
            {(summary.gaps.length > 0 || summary.restarts.length > 0) && (
              <div className="small warn">
                {summary.gaps.length > 0 && <>⚠ {summary.gaps.length} gap(s) — no samples collected </>}
                {summary.restarts.length > 0 && <>⚠ {summary.restarts.length} restart(s)</>}
              </div>
            )}
          </div>
        )}
        <div className="spacer" />
        {cursor !== null && <code className="cursor">{ms(cursor)}</code>}
        {status === 'ready' && (
          <>
            <DashboardMenu />
            <TimeRange />
            <label className="muted small band-toggle" title="Shade min/max between samples">
              <input
                type="checkbox"
                checked={showBand}
                onChange={(e) => setShowBand(e.target.checked)}
              />
              range
            </label>
            <button onClick={addPanel}>+ panel</button>
            <button onClick={() => void share()}>share</button>
            <button className="link" onClick={reset}>load another</button>
          </>
        )}
      </header>

      {copied !== null && <div className="toast">{copied}</div>}

      {status === 'ready' ? (
        <main>
          <div className={showCatalog ? 'sidebar' : 'sidebar collapsed'}>
            <button
              className="catalog-toggle"
              title={showCatalog ? 'Hide metric catalog' : 'Show metric catalog'}
              onClick={toggleCatalog}
            >
              {showCatalog ? '⯇ metrics' : '⯈'}
            </button>
            {showCatalog && <MetricCatalog />}
          </div>
          <section className="charts">
            <ErrorBoundary>
              <Grid />
            </ErrorBoundary>
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
