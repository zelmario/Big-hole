import { useState, type ReactElement } from 'react';

import { CaptureBar } from './ui/CaptureBar.js';
import { DropZone } from './ui/DropZone.js';
import { ErrorBoundary } from './ui/ErrorBoundary.js';
import { TimeRange } from './ui/TimeRange.js';
import { DashboardMenu } from './ui/DashboardMenu.js';
import { Grid } from './dashboard/Grid.js';
import { MetricCatalog } from './dashboard/MetricCatalog.js';
import { LogView } from './logs/LogView.js';
import { toPermalink } from './dashboard/layout.js';
import { useStore } from './store/useStore.js';

function ms(d: number): string {
  return new Date(d).toISOString().replace('T', ' ').replace('.000Z', 'Z');
}

export function App(): ReactElement {
  const status = useStore((s) => s.status);
  const captures = useStore((s) => s.captures);
  const bounds = useStore((s) => s.bounds)();
  const cursor = useStore((s) => s.cursor);
  const error = useStore((s) => s.error);
  const showBand = useStore((s) => s.showBand);
  const showCatalog = useStore((s) => s.showCatalog);
  const toggleCatalog = useStore((s) => s.toggleCatalog);
  const setShowBand = useStore((s) => s.setShowBand);
  const addPanel = useStore((s) => s.addPanel);
  const dashboard = useStore((s) => s.dashboard);
  const reset = useStore((s) => s.reset);

  const [copied, setCopied] = useState<string | null>(null);
  const tab = useStore((s) => s.sidebarTab);
  const setTab = useStore((s) => s.setSidebarTab);
  const hasLogs = useStore((s) => s.hasLogs)();
  const pinCount = useStore((s) => s.pins.length);
  const logLoading = useStore((s) => Object.keys(s.logProgress).length > 0);

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
        {bounds !== null && (
          <div className="summary">
            <span className="muted">
              {captures.length} node{captures.length === 1 ? '' : 's'} ·{' '}
              {captures.reduce((n, c) => n + c.summary.sampleCount, 0).toLocaleString()} samples ·{' '}
              {(bounds.cadenceMs / 1000).toFixed(1)}s cadence
            </span>
            <div className="muted small">
              {ms(bounds.startMs)} → {ms(bounds.endMs)}
            </div>
            {captures.some((c) => c.summary.gaps.length > 0 || c.summary.restarts.length > 0) && (
              <div className="small warn">
                {/* Per node: "two gaps" across a replica set means something quite different
                    depending on whether they are on one member or on all three. */}
                {captures
                  .filter((c) => c.summary.gaps.length > 0 || c.summary.restarts.length > 0)
                  .map((c) => (
                    <div key={c.id}>
                      ⚠ {c.label}
                      {c.summary.gaps.length > 0 && <> · {c.summary.gaps.length} gap(s)</>}
                      {c.summary.restarts.length > 0 && (
                        <> · {c.summary.restarts.length} restart(s)</>
                      )}
                    </div>
                  ))}
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
            <button className="link" onClick={reset}>clear all</button>
          </>
        )}
      </header>

      {copied !== null && <div className="toast">{copied}</div>}

      {status === 'ready' && <CaptureBar />}
      {/* A folder that failed while others succeeded: the dashboard is up, but saying nothing
          would leave a missing node looking like a node that has no data. */}
      {status === 'ready' && error !== null && <div className="small warn pad">⚠ {error}</div>}

      {status === 'ready' ? (
        <main>
          <div className={showCatalog ? 'sidebar' : 'sidebar collapsed'}>
            <button
              className="catalog-toggle"
              title={showCatalog ? 'Hide sidebar' : 'Show sidebar'}
              onClick={toggleCatalog}
            >
              {showCatalog ? '⯇' : '⯈'}
            </button>
            {showCatalog && (
              <>
                <div className="sidebar-tabs">
                  <button
                    className={tab === 'metrics' ? 'tab on' : 'tab'}
                    onClick={() => setTab('metrics')}
                  >
                    metrics
                  </button>
                  <button
                    className={tab === 'log' ? 'tab on' : 'tab'}
                    onClick={() => setTab('log')}
                  >
                    log{hasLogs ? '' : ' +'}
                    {logLoading && <span className="tab-loading"> ●</span>}
                    {pinCount > 0 && <span className="tab-pins"> {pinCount}📌</span>}
                  </button>
                </div>
                {tab === 'metrics' ? <MetricCatalog /> : <LogView />}
              </>
            )}
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
