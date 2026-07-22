import { useCallback, useMemo, useRef, useState, type ReactElement } from 'react';
import { GridLayout, useContainerWidth, type Layout } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';

import { TimeSeriesPanel } from '../panels/TimeSeriesPanel.js';
import { useStore } from '../store/useStore.js';
import { GRID_COLUMNS } from './layout.js';

/**
 * Config objects are hoisted, not written inline.
 *
 * react-grid-layout v2 merges these with `useMemo(..., [configProp])`, memoised by object
 * identity. An inline literal is a new object every render, so the merge recomputes and the
 * handlers built from it churn.
 */
const GRID_CONFIG = { cols: GRID_COLUMNS, rowHeight: 30, margin: [12, 12] as [number, number] };
/** Drag from the header only, so dragging inside a chart still brushes to zoom. */
const DRAG_CONFIG = { handle: '.drag-handle' };

/**
 * Draggable, resizable panel grid.
 *
 * react-grid-layout v2 dropped the `WidthProvider` HOC in favour of `useContainerWidth`; the
 * old API still exists under `react-grid-layout/legacy`, but the hook is the supported path.
 */
export function Grid(): ReactElement {
  const panels = useStore((s) => s.panels);
  const focusPanel = useStore((s) => s.focusPanel);
  const applyGeometry = useStore((s) => s.applyGeometry);

  const { width, containerRef } = useContainerWidth();

  /**
   * Layout held locally while a gesture is in flight.
   *
   * `onLayoutChange` fires continuously during a drag. Writing each intermediate value to the
   * store fed a fresh `layout` prop back into the grid mid-gesture, which fought its internal
   * drag state and made panels look immovable. The store is updated on drag/resize *stop*
   * instead; until then this local copy is what renders.
   */
  const [draft, setDraft] = useState<Layout | null>(null);
  const interacting = useRef(false);

  const fromPanels = useMemo<Layout>(
    () =>
      panels.map((p) =>
        p.kind === 'section'
          ? // Row headings span the grid and are not resizable, matching Grafana's rows.
            { i: p.id, x: 0, y: p.y, w: GRID_COLUMNS, h: 1, isResizable: false }
          : { i: p.id, x: p.x, y: p.y, w: p.w, h: p.h, minW: 2, minH: 4 },
      ),
    [panels],
  );

  const onLayoutChange = useCallback((next: Layout) => {
    // Mid-gesture this stays local; the store is written once, on stop.
    if (interacting.current) setDraft(next);
  }, []);

  const onStart = useCallback(() => {
    interacting.current = true;
  }, []);

  const onStop = useCallback(
    (next: Layout) => {
      interacting.current = false;
      setDraft(null);
      applyGeometry(next);
    },
    [applyGeometry],
  );

  if (panels.length === 0) {
    return (
      <p className="muted pad">
        No panels. Use “+ panel”, or the dashboard menu to restore the default.
      </p>
    );
  }

  return (
    <div ref={containerRef} className="grid-host">
      {width > 0 && (
        <GridLayout
          className="grid"
          width={width}
          layout={draft ?? fromPanels}
          gridConfig={GRID_CONFIG}
          dragConfig={DRAG_CONFIG}
          onLayoutChange={onLayoutChange}
          onDragStart={onStart}
          onResizeStart={onStart}
          onDragStop={onStop}
          onResizeStop={onStop}
        >
          {panels.map((panel) => (
            <div key={panel.id} onMouseDown={() => focusPanel(panel.id)}>
              <TimeSeriesPanel panel={panel} />
            </div>
          ))}
        </GridLayout>
      )}
    </div>
  );
}
