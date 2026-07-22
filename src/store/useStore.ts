import { create } from 'zustand';

import type { CatalogEntry } from '../data/reader.js';
import {
  LAYOUT_VERSION,
  compact,
  defaultDashboard,
  fromHash,
  loadLayout,
  panelId,
  saveLayout,
  type DashboardState,
  type PanelSpec,
} from '../dashboard/layout.js';
import { exprPaths, parseExpr } from '../data/expr.js';
import { FtdcClient } from '../workers/client.js';
import type { CaptureSummary, IngestProgressMessage } from '../workers/protocol.js';

const CAPTURE_ID = 'capture-0'; // single capture until M4

export interface Progress {
  readonly file: string;
  readonly filesDone: number;
  readonly filesTotal: number;
  readonly samples: number;
  readonly bytesWritten: number;
}

interface State {
  readonly client: FtdcClient;
  status: 'empty' | 'ingesting' | 'ready' | 'error';
  error: string | null;
  progress: Progress | null;
  summary: CaptureSummary | null;
  catalog: CatalogEntry[];

  panels: PanelSpec[];
  /** Panel that catalog clicks add to, and that renders with a highlight. */
  focused: string | null;
  /** Visible window in epoch ms; null means the whole capture. */
  range: [number, number] | null;
  /** Shared time cursor in epoch ms, or null when the pointer is off-chart. */
  cursor: number | null;

  ingest(files: File[]): Promise<void>;
  addPanel(): void;
  removePanel(id: string): void;
  renamePanel(id: string, title: string): void;
  focusPanel(id: string): void;
  toggleMetric(path: string): void;
  removeMetric(id: string, path: string): void;
  applyGeometry(next: ReadonlyArray<{ i: string; x: number; y: number; w: number; h: number }>): void;
  applyState(state: DashboardState): void;
  dashboard(): DashboardState;
  setRange(range: [number, number] | null): void;
  setCursor(ms: number | null): void;
  reset(): void;
}

/** True when every raw path an expression needs exists in this capture. */
function hasMetric(expression: string, available: ReadonlySet<string>): boolean {
  try {
    return exprPaths(parseExpr(expression)).every((p) => available.has(p));
  } catch {
    return false;
  }
}

function persist(panels: PanelSpec[], range: [number, number] | null): void {
  saveLayout({ v: LAYOUT_VERSION, panels, range });
}

export const useStore = create<State>((set, get) => ({
  client: new FtdcClient(),
  status: 'empty',
  error: null,
  progress: null,
  summary: null,
  catalog: [],
  panels: [],
  focused: null,
  range: null,
  cursor: null,

  async ingest(files: File[]) {
    set({ status: 'ingesting', error: null, progress: null });
    try {
      const onProgress = (p: IngestProgressMessage) =>
        set({
          progress: {
            file: p.file,
            filesDone: p.filesDone,
            filesTotal: p.filesTotal,
            samples: p.samples,
            bytesWritten: p.bytesWritten,
          },
        });

      const summary = await get().client.ingest(CAPTURE_ID, files, onProgress);
      const catalog = await get().client.catalog(CAPTURE_ID);
      const available = new Set(catalog.map((c) => c.path));

      // A permalink beats a saved layout, which beats the built-in default: an explicitly
      // shared link is the strongest statement of intent.
      const shared = fromHash(window.location.hash);
      const saved = shared ?? loadLayout();

      let state: DashboardState;
      if (saved !== null) {
        // Drop metrics this capture does not have; a layout built against another server
        // version should degrade, not produce empty charts.
        const panels = saved.panels
          .map((p) =>
            p.kind === 'section'
              ? p
              : { ...p, metrics: p.metrics.filter((m) => hasMetric(m, available)) },
          )
          .filter((p) => p.kind === 'section' || p.metrics.length > 0);
        state =
          panels.length > 0
            ? { v: LAYOUT_VERSION, panels, range: saved.range }
            : defaultDashboard(available);
      } else {
        state = defaultDashboard(available);
      }

      set({
        status: 'ready',
        summary,
        catalog,
        panels: state.panels,
        focused: state.panels[0]?.id ?? null,
        range: state.range,
        progress: null,
      });
    } catch (err) {
      set({
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
        progress: null,
      });
    }
  },

  addPanel() {
    const panels = get().panels;
    const maxY = panels.reduce((m, p) => Math.max(m, p.y + p.h), 0);
    const created: PanelSpec = {
      id: panelId(),
      kind: 'chart',
      title: 'New panel',
      metrics: [],
      x: 0,
      y: maxY,
      w: 12,
      h: 8,
    };
    const next = [...panels, created];
    set({ panels: next, focused: created.id });
    persist(next, get().range);
  },

  removePanel(id: string) {
    const next = compact(get().panels.filter((p) => p.id !== id));
    set({ panels: next, focused: get().focused === id ? (next[0]?.id ?? null) : get().focused });
    persist(next, get().range);
  },

  renamePanel(id: string, title: string) {
    const next = get().panels.map((p) => (p.id === id ? { ...p, title } : p));
    set({ panels: next });
    persist(next, get().range);
  },

  focusPanel(id: string) {
    set({ focused: id });
  },

  toggleMetric(path: string) {
    const { panels, focused } = get();
    const target = focused ?? panels[0]?.id;
    if (target === undefined) return;

    const next = panels.map((p) => {
      if (p.id !== target) return p;
      return {
        ...p,
        metrics: p.metrics.includes(path)
          ? p.metrics.filter((m) => m !== path)
          : [...p.metrics, path],
      };
    });
    set({ panels: next });
    persist(next, get().range);
  },

  removeMetric(id: string, path: string) {
    const next = get().panels.map((p) =>
      p.id === id ? { ...p, metrics: p.metrics.filter((m) => m !== path) } : p,
    );
    set({ panels: next });
    persist(next, get().range);
  },

  applyGeometry(geometry) {
    const byId = new Map(geometry.map((g) => [g.i, g]));
    const next = get().panels.map((p) => {
      const g = byId.get(p.id);
      return g === undefined ? p : { ...p, x: g.x, y: g.y, w: g.w, h: g.h };
    });
    set({ panels: next });
    persist(next, get().range);
  },

  applyState(state) {
    set({
      panels: state.panels,
      range: state.range,
      focused: state.panels[0]?.id ?? null,
    });
    persist(state.panels, state.range);
  },

  dashboard() {
    return { v: LAYOUT_VERSION, panels: get().panels, range: get().range };
  },

  setRange(range) {
    set({ range });
  },

  setCursor(ms) {
    set({ cursor: ms });
  },

  reset() {
    set({ status: 'empty', summary: null, catalog: [], range: null, error: null });
  },
}));

export { CAPTURE_ID };
