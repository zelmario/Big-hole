import { useEffect, type ReactElement } from 'react';

import { useStore } from '../store/useStore.js';

/**
 * In-app help, as an overlay.
 *
 * Deliberately in the app and not a hosted page: the whole product runs client-side and works
 * offline, so its documentation should too -- no network, nothing to load, consistent with the
 * privacy promise. Same scrim + Esc pattern as the log window and a maximised panel.
 */
function K({ children }: { children: string }): ReactElement {
  return <kbd className="kbd">{children}</kbd>;
}

export function Help(): ReactElement | null {
  const open = useStore((s) => s.showHelp);
  const toggle = useStore((s) => s.toggleHelp);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') toggle(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, toggle]);

  if (!open) return null;
  const close = (): void => toggle(false);

  return (
    <div className="help-scrim" onMouseDown={close}>
      <div
        className="help"
        role="dialog"
        aria-label="Help"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="help-bar">
          <span className="help-title">ftdc-lens — help</span>
          <span className="spacer" />
          <button className="link" title="Close (Esc)" onClick={close}>
            ✕
          </button>
        </div>

        <div className="help-body">
          <p className="help-lede">
            A browser-native viewer for MongoDB FTDC diagnostic data. Everything runs on your
            machine — <b>no capture, log, or metric ever leaves the browser</b>, and it works
            fully offline.
          </p>

          <section>
            <h3>Loading data</h3>
            <ul>
              <li>
                Drag a <code>diagnostic.data</code> folder (or a support tarball) onto the drop
                zone, or use the file picker.
              </li>
              <li>
                <b>Multiple nodes:</b> drop a bundle with one folder per node — each becomes its
                own capture (<code>c0</code>, <code>c1</code>, …) and every panel fans out to all
                of them. Use <b>+ node</b> to add more later.
              </li>
              <li>
                Captures are decoded once and stored locally (OPFS). Reopening one from the recent
                list is instant — no re-decoding.
              </li>
            </ul>
          </section>

          <section>
            <h3>The dashboard</h3>
            <ul>
              <li>Panels are grouped in sections. Add one with <b>+ panel</b>.</li>
              <li>
                <b>Zoom time:</b> drag left-to-right across any chart to select a window; every
                panel zooms together. The <b>time range</b> control resets or sets it.
              </li>
              <li>Hover shows a shared cursor and each series' value across all panels.</li>
              <li>Maximize a panel with <K>⤢</K>, back with <K>Esc</K>.</li>
              <li>
                Pick metrics from the <b>metrics</b> sidebar. Drag the sidebar's right edge to
                widen it.
              </li>
            </ul>
          </section>

          <section>
            <h3>Logs</h3>
            <ul>
              <li>
                Attach a <code>mongod.log</code> with <b>+ log</b>, or drop it next to the capture.
                The log is stored with the capture, so a reload brings it back.
              </li>
              <li>
                The log <b>follows the dashboard's time window</b> — zoom an incident on the charts
                and the log narrows to the same minutes. Notable lines (elections, sync-source
                changes, stalls) are highlighted; the <b>notable</b> box shows only those.
              </li>
              <li>
                <b>Double-click a log line</b> to pin a marker on every chart — that is how a log
                event and a metric spike become the same observation.
              </li>
              <li>
                <b>Double-click a chart</b> to jump the log to that instant.
              </li>
              <li>
                <b>Full-screen window</b> (<b>⤢ full screen</b>): a <code>less</code>-style reader
                with room for long lines — scroll sideways to read a full command document.
              </li>
              <li>
                <b>Zoom the log</b>: the log leads instead of following. Scroll it and the charts
                pan to the lines on screen; a shaded band marks that window on every panel.
              </li>
              <li>
                <b>checks</b> runs the usual first questions over the whole capture the moment it
                loads — ticket exhaustion, dirty cache, queue buildup, flow control, page
                faulting. Each finding says what happened, for how long, and what to look at
                next; click one to zoom the dashboard to its worst stretch. An empty list means
                none of those fired, not that the server was healthy in every respect.
              </li>
              <li>
                <b>Scroll to load more</b>. The list holds a few thousand lines at a time and
                slides: reach either end and the next lines load while the far end is dropped.
                <b> more ↑↓</b> in the header says which way there is still log to read.
              </li>
            </ul>
          </section>

          <section>
            <h3>Reading the charts</h3>
            <ul>
              <li>
                <b>Red vertical band</b> — the capture has no samples there (mongod was down,
                stalled, or the host froze). One of the strongest signals in a capture; the header
                also flags gaps and restarts.
              </li>
              <li>
                <b>Blue shaded band</b> — the span of the log lines you are currently reading.
              </li>
              <li>
                <b>Line colours</b> are just a palette (two of the twelve are red) — they carry no
                meaning; the legend under each panel shows which metric is which.
              </li>
              <li>
                <b>Dashed vertical line</b> — a pin, coloured by the log line's severity.
              </li>
            </ul>
          </section>

          <section>
            <h3>Full-screen log — keys</h3>
            <table className="help-keys">
              <tbody>
                <tr><td><K>j</K> <K>k</K> / <K>↑</K> <K>↓</K></td><td>move the selected line</td></tr>
                <tr><td><K>←</K> <K>→</K> / <K>h</K> <K>l</K></td><td>scroll a long line sideways</td></tr>
                <tr><td><K>space</K> <K>b</K></td><td>page down / up</td></tr>
                <tr><td><K>g</K> <K>G</K></td><td>jump to top / bottom</td></tr>
                <tr><td><K>n</K> <K>N</K></td><td>next / previous notable line</td></tr>
                <tr><td><K>/</K></td><td>jump to the filter box</td></tr>
                <tr><td><K>Esc</K></td><td>leave the filter, then close</td></tr>
              </tbody>
            </table>
          </section>

          <section>
            <h3>Sharing &amp; privacy</h3>
            <ul>
              <li>
                <b>share</b> copies a link that carries the <b>dashboard layout only</b> — never
                any data. Too large for a URL and it downloads as a JSON file instead.
              </li>
              <li>
                Nothing is ever uploaded. Data lives in the browser's private local storage (OPFS)
                and on your disk; the network is never touched.
              </li>
            </ul>
          </section>

          <p className="help-foot muted small">
            Press <K>Esc</K> or click outside to close.
          </p>
        </div>
      </div>
    </div>
  );
}
