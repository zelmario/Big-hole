import { useState, type ReactElement } from 'react';

import { CaptureBar } from './ui/CaptureBar.js';
import { DropZone } from './ui/DropZone.js';
import { ErrorBoundary } from './ui/ErrorBoundary.js';
import { TimeRange } from './ui/TimeRange.js';
import { DashboardMenu } from './ui/DashboardMenu.js';
import { Grid } from './dashboard/Grid.js';
import { MetricCatalog } from './dashboard/MetricCatalog.js';
import { LogView } from './logs/LogView.js';
import { LogWindow } from './logs/LogWindow.js';
import { Insights } from './insights/Insights.js';
import { Explain } from './insights/Explain.js';
import { Help } from './ui/Help.js';
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
  const sidebarWidth = useStore((s) => s.sidebarWidth);
  const setSidebarWidth = useStore((s) => s.setSidebarWidth);
  const setShowBand = useStore((s) => s.setShowBand);
  const addPanel = useStore((s) => s.addPanel);
  const dashboard = useStore((s) => s.dashboard);
  const reset = useStore((s) => s.reset);
  const toggleHelp = useStore((s) => s.toggleHelp);

  const [copied, setCopied] = useState<string | null>(null);
  const tab = useStore((s) => s.sidebarTab);
  const setTab = useStore((s) => s.setSidebarTab);
  const hasLogs = useStore((s) => s.hasLogs)();
  const pinCount = useStore((s) => s.pins.length);
  const logLoading = useStore((s) => Object.keys(s.logProgress).length > 0);
  const analyzing = useStore((s) => s.analyzing);
  const explaining = useStore((s) => s.explaining);
  const findingCount = useStore((s) => s.findings?.length ?? 0);
  const worstSeverity = useStore((s) => s.findings?.[0]?.severity ?? null);

  // Drag the sidebar's right edge to widen it. Listeners live on window so the drag survives
  // the pointer leaving the 5px handle, and body selection is suppressed so it does not paint
  // a text selection across the app mid-drag. Clamped so it can neither vanish nor swallow the
  // charts.
  function startResize(e: React.MouseEvent): void {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebarWidth;
    const onMove = (ev: MouseEvent): void => {
      const w = Math.max(240, Math.min(window.innerWidth * 0.8, startW + ev.clientX - startX));
      setSidebarWidth(w);
    };
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = '';
    };
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

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
        <button className="help-btn" title="Help" aria-label="Help" onClick={() => toggleHelp(true)}>
          ?
        </button>
      </header>

      {copied !== null && <div className="toast">{copied}</div>}

      {status === 'ready' && <CaptureBar />}
      {/* A folder that failed while others succeeded: the dashboard is up, but saying nothing
          would leave a missing node looking like a node that has no data. */}
      {status === 'ready' && error !== null && <div className="small warn pad">⚠ {error}</div>}

      {status === 'ready' ? (
        <main>
          <div
            className={showCatalog ? 'sidebar' : 'sidebar collapsed'}
            style={showCatalog ? { flex: `0 0 ${sidebarWidth}px` } : undefined}
          >
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
                  <button
                    className={tab === 'insights' ? 'tab on' : 'tab'}
                    onClick={() => setTab('insights')}
                  >
                    checks
                    {analyzing && <span className="tab-loading"> ●</span>}
                    {/* The count is the point of the tab: it says whether to open it. */}
                    {findingCount > 0 && (
                      <span className={worstSeverity === 'critical' ? 'tab-bad' : 'tab-warn'}>
                        {' '}
                        {findingCount}
                      </span>
                    )}
                  </button>
                  <button
                    className={tab === 'explain' ? 'tab on' : 'tab'}
                    title="Rank every metric by how much it moved in the visible window"
                    onClick={() => setTab('explain')}
                  >
                    explain
                    {explaining && <span className="tab-loading"> ●</span>}
                  </button>
                </div>
                {tab === 'metrics' ? (
                  <MetricCatalog />
                ) : tab === 'log' ? (
                  <LogView />
                ) : tab === 'insights' ? (
                  <Insights />
                ) : (
                  <Explain />
                )}
              </>
            )}
          </div>
          {showCatalog && (
            <div
              className="sidebar-resizer"
              title="Drag to resize the sidebar"
              onMouseDown={startResize}
            />
          )}
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

      {status === 'ready' && <LogWindow />}
      <Help />
    </div>
  );
}
