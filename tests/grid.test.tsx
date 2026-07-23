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
import type { ReactElement } from 'react';

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
  useStore.setState({ status: 'ready', panels, focused: 'a', captures: [] });
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

// Captured before any test swaps it for a spy; without restoring it, one test's stub leaks
// into every test after it.
const realApplyGeometry = useStore.getState().applyGeometry;

afterEach(() => {
  cleanup();
  useStore.setState({ panels: [], focused: null, maximized: null, applyGeometry: realApplyGeometry });
});

describe('panel grid', () => {
  it('settles instead of looping', async () => {
    // A previous version passed `layouts={{ lg: ... }}` inline. The new object identity every
    // render made the grid report a layout change, which set state, which produced another
    // new object -- an infinite loop that hung the tab. Every other test still passed.
    stubWidth(1200);
    const applyGeometry = vi.fn();
    useStore.setState({ status: 'ready', panels, focused: 'a', captures: [], applyGeometry });

    let renders = 0;
    function Counted(): ReactElement {
      renders += 1;
      return <Grid />;
    }
    render(<Counted />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    expect(renders, `Grid re-rendered ${renders} times while idle`).toBeLessThan(6);
    expect(
      applyGeometry.mock.calls.length,
      'geometry was written without any gesture',
    ).toBe(0);
  });

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

describe('maximizing a panel', () => {
  /** The maximize control, which sits next to the panel's remove button. */
  function maximizeButton(index = 0): Element {
    return [...document.querySelectorAll('.panel-head button')].filter((b) =>
      (b.getAttribute('title') ?? '').includes('aximize'),
    )[index]!;
  }

  it('shows only the chosen panel, and leaves the grid behind', () => {
    stubWidth(1200);
    mount();
    expect(document.querySelectorAll('.react-grid-item')).toHaveLength(2);

    act(() => {
      (maximizeButton() as HTMLElement).click();
    });

    // Out of the grid entirely: react-grid-layout sizes rows in fixed units and cannot fill
    // the viewport, so a maximised panel is not a grid item at all.
    expect(document.querySelectorAll('.react-grid-item')).toHaveLength(0);
    expect(document.querySelectorAll('.maximized-host .panel')).toHaveLength(1);
    expect(useStore.getState().maximized).toBe('a');
    // Maximising is also a focus: the catalogue adds to the panel you are looking at.
    expect(useStore.getState().focused).toBe('a');
  });

  it('comes back on Escape', () => {
    stubWidth(1200);
    mount();
    act(() => {
      (maximizeButton() as HTMLElement).click();
    });
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(useStore.getState().maximized).toBeNull();
    expect(document.querySelectorAll('.react-grid-item')).toHaveLength(2);
  });

  it('does not strand the view when the maximized panel is removed', () => {
    stubWidth(1200);
    mount();
    act(() => {
      (maximizeButton() as HTMLElement).click();
    });
    act(() => {
      useStore.getState().removePanel('a');
    });
    expect(useStore.getState().maximized).toBeNull();
  });

  it('stays out of the saved layout', () => {
    // It is where you are looking, not how the dashboard is laid out. In a permalink it would
    // reopen someone else's dashboard zoomed into one panel.
    stubWidth(1200);
    mount();
    act(() => {
      (maximizeButton() as HTMLElement).click();
    });
    expect(JSON.stringify(useStore.getState().dashboard())).not.toContain('maximiz');
  });
});
