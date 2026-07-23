/**
 * Debug harness: mounts the real Grid with static panels, no worker and no OPFS.
 *
 * Exists because jsdom passes while a real browser does not, so drag/resize has to be
 * exercised somewhere with actual layout and offsetParent. Not part of the app bundle.
 */
import { createRoot } from 'react-dom/client';

import { Grid } from './dashboard/Grid.js';
import { useStore } from './store/useStore.js';
import './ui/styles.css';

useStore.setState({
  status: 'ready',
  focused: 'a',
  captures: [],
  panels: [
    { id: 'a', kind: 'chart', title: 'Panel A', metrics: [], x: 0, y: 0, w: 6, h: 6 },
    { id: 'b', kind: 'chart', title: 'Panel B', metrics: [], x: 6, y: 0, w: 6, h: 6 },
  ],
});

// Expose geometry so the driver can read it without scraping the DOM.
(window as unknown as { geometry: () => string }).geometry = () =>
  useStore
    .getState()
    .panels.map((p) => `${p.id}:${p.x},${p.y},${p.w}x${p.h}`)
    .join(' ');

createRoot(document.getElementById('root')!).render(
  <div className="app">
    <main>
      <section className="charts">
        <Grid />
      </section>
    </main>
  </div>,
);
