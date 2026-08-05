import { useEffect, type ReactElement } from 'react';

import { useStore } from '../store/useStore.js';
import { AUTHOR, AUTHOR_GITHUB, AUTHOR_URL } from './author.js';

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
          <span className="help-title">Big Hole — help</span>
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
            <h3>Member state, and what each node is</h3>
            <ul>
              <li>
                The strip above the charts is one band per replica-set member, coloured by state:
                green <b>PRIMARY</b>, olive <b>SECONDARY</b>, amber for the transitional states
                (STARTUP2, RECOVERING), red for <b>DOWN</b>, <b>ROLLBACK</b> in purple. Hatching
                means the capture has no sample there.
              </li>
              <li>
                <b>Click a band</b> to zoom every chart to it — an election is a boundary between
                two bands, and the minutes around it are usually what you came for.
              </li>
              <li>
                <b>Dimmed, italic rows</b> are members you did not load, drawn from a loaded
                node's heartbeats. That is the only place <b>DOWN</b> can come from — no node ever
                reports itself as down — but it is one node's view, so it says "could not reach"
                rather than "was not running".
              </li>
              <li>
                <b>info</b> in the header shows every loaded node side by side: host, CPU, RAM,
                WiredTiger cache, build, ulimits and the configuration mongod was actually started
                with. Rows where the nodes disagree are marked <b>≠</b> — a member with half the
                cache or an unraised file-descriptor limit is often the whole finding. The raw
                metadata document is at the bottom of the page.
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
                <b>explain</b> answers the question a finding leaves you with: what else was
                different at that moment. Drag across a chart to zoom into a window, open the tab,
                and every metric in the capture is ranked by how far it moved against the stretch
                of time immediately before — with the annotated log lines that fall inside it
                listed first, since an election or a sync-source change is usually the
                explanation rather than a consequence. Click a row to put that metric on the
                focused panel. Counters are compared as rates, so the numbers read the way the
                charts do. It reads full resolution, so the window is capped at about five hours.
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

          <section>
            <h3>About</h3>
            <p className="small">
              Built by <b>{AUTHOR}</b>.{' '}
              {/* Plain links: nothing is requested until you click one, so the privacy promise
                  holds. rel=noreferrer keeps even the click from carrying where it came from. */}
              <a href={AUTHOR_URL} target="_blank" rel="noreferrer noopener">
                LinkedIn
              </a>{' '}
              ·{' '}
              <a href={AUTHOR_GITHUB} target="_blank" rel="noreferrer noopener">
                github.com/zelmario
              </a>
            </p>
            <p className="small muted">
              A capture this reads wrongly, or a metric it cannot resolve, is worth reporting: it
              fails silently by design — an empty panel, never an error — so nobody finds out
              unless you say so.
            </p>
          </section>

          <p className="help-foot muted small">
            Press <K>Esc</K> or click outside to close.
          </p>
        </div>
      </div>
    </div>
  );
}
