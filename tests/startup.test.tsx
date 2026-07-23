/**
 * A failure must never be a blank page.
 *
 * This is the difference between a bug report that says "it broke, here is the message" and
 * one that says "I see a blank page", which is indistinguishable from "still loading" and
 * leaves the cause in a console nobody opens.
 *
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { ErrorBoundary } from '../src/ui/ErrorBoundary.js';

function Explodes(): never {
  throw new Error('metricsCount did not match flattenedColumns');
}

afterEach(cleanup);

describe('render failures', () => {
  it('shows what went wrong instead of unmounting the app', () => {
    // React logs the error itself; silence it so the suite output stays readable.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      render(
        <ErrorBoundary>
          <Explodes />
        </ErrorBoundary>,
      );
    } finally {
      spy.mockRestore();
    }

    expect(screen.getByText(/Something broke while rendering/)).toBeTruthy();
    // The message is the whole point: a boundary that renders "an error occurred" is barely
    // better than the blank page it replaced.
    expect(
      screen.getByText(/metricsCount did not match flattenedColumns/),
    ).toBeTruthy();
    expect(screen.getByRole('button')).toBeTruthy();
  });

  it('keeps rendering children when nothing throws', () => {
    render(
      <ErrorBoundary>
        <p>dashboard</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText('dashboard')).toBeTruthy();
  });
});
