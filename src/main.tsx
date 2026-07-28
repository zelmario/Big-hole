import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.js';
import { clearAllLocalState } from './dashboard/library.js';
import { ErrorBoundary } from './ui/ErrorBoundary.js';
import './ui/styles.css';

/**
 * Never hand back a blank page.
 *
 * A blank page is the worst failure this tool can produce: it says nothing, it is
 * indistinguishable from "still loading", and the cause sits in a console the reporter has no
 * reason to open. Three layers, because each catches something the others cannot:
 *
 *   1. ErrorBoundary around the whole app -- a throw during render. It used to wrap only the
 *      grid, so anything thrown in the header, capture bar or catalogue unmounted the app
 *      silently.
 *   2. try/catch around the first render -- a throw before React is mounted, which no
 *      boundary can see.
 *   3. window error handlers -- a module that failed to evaluate at import time, or an async
 *      failure with no React frame to attach to. React never ran, so the message is written
 *      into the page directly.
 *
 * All three end the same way: say what happened, and offer the two things that help -- reload,
 * and clear the local state that a stale layout can wedge the app with.
 */
function fatal(error: unknown): void {
  const root = document.getElementById('root');
  if (root === null || root.dataset['mounted'] === 'ok') return;

  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const stack = error instanceof Error ? (error.stack ?? '') : '';

  root.textContent = '';
  const box = document.createElement('div');
  box.className = 'drop';

  const title = document.createElement('h2');
  title.textContent = 'Big Hole failed to start';

  const detail = document.createElement('p');
  detail.className = 'error';
  detail.textContent = message;

  const trace = document.createElement('pre');
  trace.className = 'muted small fatal-stack';
  trace.textContent = stack.split('\n').slice(0, 6).join('\n');

  const note = document.createElement('p');
  note.className = 'muted small';
  note.textContent = 'Nothing was uploaded anywhere; this happened entirely in this tab.';

  const reload = document.createElement('button');
  reload.textContent = 'Reload';
  reload.onclick = () => window.location.reload();

  const clear = document.createElement('button');
  clear.className = 'link';
  clear.textContent = 'Clear saved layouts and reload';
  clear.onclick = () => {
    clearAllLocalState();
    window.location.hash = '';
    window.location.reload();
  };

  box.append(title, detail, trace, note, reload, clear);
  root.append(box);
}

window.addEventListener('error', (event) => fatal(event.error ?? event.message));
window.addEventListener('unhandledrejection', (event) => fatal(event.reason));

try {
  const root = document.getElementById('root');
  if (root === null) throw new Error('missing #root');
  createRoot(root).render(
    <StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </StrictMode>,
  );
  root.dataset['mounted'] = 'ok';
} catch (err) {
  fatal(err);
}
