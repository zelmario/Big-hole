import { type ReactElement } from 'react';

import { useStore } from '../store/useStore.js';
import { LogView } from './LogView.js';

/**
 * The log as a full-screen window -- a `less` for the mongod log.
 *
 * The sidebar strip is too narrow to read a slow-query command doc or a stack, which is what
 * the log is for. This blows it up to fill the screen and adds keyboard navigation, while
 * keeping everything that makes the sidebar viewer useful: it still follows the dashboard's
 * time window, a chart double-click still scrolls it to the instant, and the data path is the
 * same positioned read off disk -- nothing about storage changes.
 *
 * View state, like a maximised panel: it never enters a permalink or a saved dashboard.
 */
export function LogWindow(): ReactElement | null {
  const open = useStore((s) => s.logFullscreen);
  const toggle = useStore((s) => s.toggleLogFullscreen);
  if (!open) return null;

  const close = (): void => toggle(false);

  return (
    // Click the backdrop to close, the way every overlay does; mousedown, not click, so a text
    // selection that ends outside the window does not dismiss it.
    <div className="logwindow-scrim" onMouseDown={close}>
      <div
        className="logwindow"
        role="dialog"
        aria-label="Log viewer"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="logwindow-bar">
          <span className="logwindow-title">log</span>
          <span className="logwindow-keys muted small">
            j / k move · ← / → scroll · space page · g / G ends · n / N notable · / search · esc
            close
          </span>
          <div className="spacer" />
          <button className="link" title="Close (Esc)" onClick={close}>
            ✕
          </button>
        </div>
        <LogView fullscreen onClose={close} />
      </div>
    </div>
  );
}
