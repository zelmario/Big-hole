/**
 * Drag and resize actually work.
 *
 * Written after diagnosing this twice by reading source and being wrong both times. The
 * symptom -- correct cursors, no movement -- is invisible to every other test in this suite,
 * so it needs a real DOM and a real gesture.
 *
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { act } from 'react';

import { Grid } from '../src/dashboard/Grid.js';
import { useStore } from '../src/store/useStore.js';
import type { PanelSpec } from '../src/dashboard/layout.js';

// The worker is irrelevant here and jsdom has no Worker; stub the client so panels mount.
vi.mock('../src/workers/client.js', () => ({
  FtdcClient: class {
    ingest = vi.fn();
    catalog = vi.fn(async () => []);
    series = vi.fn(async () => []);
  },
}));

const panels: PanelSpec[] = [
  { id: 'a', kind: 'chart', title: 'A', metrics: ['x.y'], x: 0, y: 0, w: 6, h: 6 },
  { id: 'b', kind: 'chart', title: 'B', metrics: ['x.z'], x: 6, y: 0, w: 6, h: 6 },
];

function mount(): void {
  useStore.setState({ status: 'ready', panels, focused: 'a', catalog: [], summary: null });
  render(<Grid />);
}

/** react-grid-layout measures its container; jsdom reports 0 for everything. */
function stubWidth(px: number): void {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { value: px, configurable: true });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { value: px, configurable: true });
}

function drag(node: Element, dx: number, dy: number): void {
  const opts = { bubbles: true, cancelable: true };
  act(() => {
    node.dispatchEvent(new MouseEvent('mousedown', { ...opts, clientX: 100, clientY: 100, button: 0 }));
  });
  act(() => {
    document.dispatchEvent(
      new MouseEvent('mousemove', { ...opts, clientX: 100 + dx, clientY: 100 + dy }),
    );
  });
  act(() => {
    document.dispatchEvent(
      new MouseEvent('mouseup', { ...opts, clientX: 100 + dx, clientY: 100 + dy }),
    );
  });
}

afterEach(() => {
  cleanup();
  useStore.setState({ panels: [], focused: null });
});

describe('panel grid', () => {
  it('renders one grid item per panel', () => {
    stubWidth(1200);
    mount();
    expect(document.querySelectorAll('.react-grid-item')).toHaveLength(2);
  });

  it('puts a drag handle on every panel', () => {
    stubWidth(1200);
    mount();
    // dragConfig.handle points at this selector; without it react-draggable ignores the press.
    expect(document.querySelectorAll('.drag-handle').length).toBeGreaterThanOrEqual(2);
  });

  it('renders a resize handle inside the grid item', () => {
    stubWidth(1200);
    mount();
    // Must be a DIRECT child: the positioning rule is `.react-grid-item > .react-resizable-handle`.
    const handles = document.querySelectorAll('.react-grid-item > .react-resizable-handle');
    expect(handles.length).toBeGreaterThanOrEqual(2);
  });

  it('commits a drag to the store', () => {
    stubWidth(1200);
    mount();

    const before = useStore.getState().panels.map((p) => `${p.id}:${p.x},${p.y}`);
    const handle = document.querySelector('.react-grid-item .drag-handle');
    expect(handle, 'no drag handle rendered').not.toBeNull();
    // eslint-disable-next-line no-console
    console.log('handle tag/class:', handle!.tagName, handle!.className,
      '| parent:', (handle!.parentElement as HTMLElement).className,
      '| grandparent:', (handle!.parentElement!.parentElement as HTMLElement).className);

    drag(handle!, 300, 0);

    const after = useStore.getState().panels.map((p) => `${p.id}:${p.x},${p.y}`);
    expect(after, `layout unchanged after drag (before: ${before.join(' ')})`).not.toEqual(before);
  });

  it('commits a resize to the store', () => {
    stubWidth(1200);
    mount();

    const before = useStore.getState().panels.map((p) => `${p.id}:${p.w}x${p.h}`);
    const handle = document.querySelector('.react-grid-item > .react-resizable-handle');
    expect(handle, 'no resize handle rendered').not.toBeNull();

    drag(handle!, 200, 120);

    const after = useStore.getState().panels.map((p) => `${p.id}:${p.w}x${p.h}`);
    expect(after, `size unchanged after resize (before: ${before.join(' ')})`).not.toEqual(before);
  });

  it('keeps the store as the source of truth after a gesture', () => {
    stubWidth(1200);
    mount();
    const handle = document.querySelector('.react-grid-item .drag-handle')!;
    drag(handle, 300, 0);
    // Every panel must survive; a drag must not drop or duplicate one.
    expect(useStore.getState().panels).toHaveLength(2);
    expect(useStore.getState().panels.map((p) => p.id).sort()).toEqual(['a', 'b']);
  });
});
