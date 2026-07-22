import { useMemo, type ReactElement } from 'react';
import { GridLayout, useContainerWidth, type Layout } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';

import { TimeSeriesPanel } from '../panels/TimeSeriesPanel.js';
import { useStore } from '../store/useStore.js';
import { GRID_COLUMNS } from './layout.js';

/**
 * Draggable, resizable panel grid.
 *
 * react-grid-layout v2 dropped the `WidthProvider` HOC in favour of `useContainerWidth`; the
 * old API still exists under `react-grid-layout/legacy`, but the hook is the supported path
 * and avoids the extra wrapper element.
 */
export function Grid(): ReactElement {
  const panels = useStore((s) => s.panels);
  const focusPanel = useStore((s) => s.focusPanel);
  const applyGeometry = useStore((s) => s.applyGeometry);

  const { width, containerRef } = useContainerWidth();

  const layout = useMemo<Layout>(
    () =>
      panels.map((p) =>
        p.kind === 'section'
          ? // Row headings span the grid and are not resizable, matching Grafana's rows.
            { i: p.id, x: 0, y: p.y, w: GRID_COLUMNS, h: 1, isResizable: false }
          : { i: p.id, x: p.x, y: p.y, w: p.w, h: p.h, minW: 2, minH: 4 },
      ),
    [panels],
  );

  if (panels.length === 0) {
    return (
      <p className="muted pad">
        No panels. Use “+ panel”, or “reset layout” to restore the default dashboard.
      </p>
    );
  }

  return (
    <div ref={containerRef} className="grid-host">
      {width > 0 && (
        <GridLayout
          className="grid"
          width={width}
          layout={layout}
          gridConfig={{ cols: GRID_COLUMNS, rowHeight: 30, margin: [12, 12] }}
          // Drags start on the header only, so dragging inside a chart still brushes to zoom
          // rather than moving the panel.
          dragConfig={{ handle: '.drag-handle' }}
          onLayoutChange={(next: Layout) => applyGeometry(next)}
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
