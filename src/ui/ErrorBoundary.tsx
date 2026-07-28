import { Component, type ErrorInfo, type ReactNode } from 'react';

import { clearAllLocalState } from '../dashboard/library.js';

/**
 * Keep a render failure visible.
 *
 * Without this, a throw anywhere in the panel tree unmounts the whole app and leaves a blank
 * page with the real cause only in the console -- which reads as "the dashboard didn't load"
 * and is close to undiagnosable from a bug report.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error('Big Hole render error:', error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;

    return (
      <div className="drop">
        <h2>Something broke while rendering</h2>
        <p className="error">{error.message}</p>
        <pre className="muted small fatal-stack">
          {(error.stack ?? '').split('\n').slice(1, 5).join('\n')}
        </pre>
        <p className="muted small">
          The capture itself is still on disk. Resetting the layout usually clears this.
        </p>
        <button
          onClick={() => {
            clearAllLocalState();
            window.location.hash = '';
            window.location.reload();
          }}
        >
          Reset layout and reload
        </button>
      </div>
    );
  }
}
