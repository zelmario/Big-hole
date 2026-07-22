import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
// The v1-compatible entry point, shipped by react-grid-layout for exactly this purpose.
//
// v2's new API (GridLayout + gridConfig/dragConfig + useContainerWidth) would not start a
// drag: onDragStart and onDrag never fired, only onDragStop, and the dragged panel never
// moved -- reproduced in tests/grid.test.tsx. Rather than keep reverse-engineering it, this
// uses the API that has been stable for years. Revisit if v2 settles.
import { WidthProvider, Responsive } from 'react-grid-layout/legacy';
import type { Layout } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
// Required, and NOT shipped by react-grid-layout: its own stylesheet defines only the generic
// `.react-grid-item > .react-resizable-handle` rule. The positioning that puts the handle at
// the bottom-right corner (`.react-resizable-handle-se`) and `.react-resizable{position:
// relative}` live here. Without it the handle renders in the wrong place with no cursor.
import 'react-resizable/css/styles.css';

import { TimeSeriesPanel } from '../panels/TimeSeriesPanel.js';
import { useStore } from '../store/useStore.js';
import { GRID_COLUMNS } from './layout.js';

const ResponsiveGrid = WidthProvider(Responsive);

/** One breakpoint: the dashboard is a fixed 24-column grid, ported 1:1 from Grafana. */
const BREAKPOINTS = { lg: 0 };
const COLS = { lg: GRID_COLUMNS };

export function Grid(): ReactElement {
  const panels = useStore((s) => s.panels);
  const applyGeometry = useStore((s) => s.applyGeometry);

  /**
   * Layout held locally while a gesture is in flight, committed to the store on stop.
   *
   * Persisting every intermediate position would write to localStorage on every mouse move.
   */
  const [draft, setDraft] = useState<Layout | null>(null);

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

  // Anything the store does to the panels -- switching dashboards, adding, removing -- must
  // win over a stale draft.
  useEffect(() => setDraft(null), [panels]);

  const onLayoutChange = useCallback((next: Layout) => setDraft(next), []);

  const onStop = useCallback(
    (next: Layout) => {
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
    <ResponsiveGrid
      className="grid"
      layouts={{ lg: draft ?? fromPanels }}
      breakpoints={BREAKPOINTS}
      cols={COLS}
      rowHeight={30}
      margin={[12, 12]}
      // Drag from the header only, so dragging inside a chart still brushes to zoom.
      draggableHandle=".drag-handle"
      isDraggable
      isResizable
      onLayoutChange={onLayoutChange}
      onDragStop={onStop}
      onResizeStop={onStop}
    >
      {panels.map((panel) => (
        <div key={panel.id}>
          <TimeSeriesPanel panel={panel} />
        </div>
      ))}
    </ResponsiveGrid>
  );
}
