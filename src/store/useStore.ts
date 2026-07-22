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
import {
  deleteDashboard as removeSaved,
  getDashboard,
  getCurrentId,
  isDirty,
  listDashboards,
  renameDashboard as renameSaved,
  saveDashboard,
  setCurrentId,
  type SavedDashboard,
} from '../dashboard/library.js';
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
  /**
   * Draw the min/max envelope behind each line. Off by default: at any visible alpha it reads
   * as a drop shadow rather than as a range. It is what keeps a one-sample spike from being
   * averaged away by downsampling, so it stays available.
   */
  showBand: boolean;

  /** Saved dashboards, most recently updated first. */
  library: SavedDashboard[];
  /** Which saved dashboard the working layout came from, if any. */
  currentId: string | null;

  ingest(files: File[]): Promise<void>;
  addPanel(): void;
  removePanel(id: string): void;
  renamePanel(id: string, title: string): void;
  focusPanel(id: string): void;
  toggleMetric(path: string): void;
  /** Show/hide one series without removing it from the panel. */
  toggleSeries(id: string, metric: string): void;
  /** Show every series in a panel again. */
  showAllSeries(id: string): void;
  removeMetric(id: string, path: string): void;
  applyGeometry(next: ReadonlyArray<{ i: string; x: number; y: number; w: number; h: number }>): void;
  applyState(state: DashboardState): void;
  dashboard(): DashboardState;
  setRange(range: [number, number] | null): void;
  setCursor(ms: number | null): void;
  setShowBand(on: boolean): void;

  saveCurrent(name?: string): void;
  saveAsNew(name: string): void;
  openDashboard(id: string): void;
  deleteDashboard(id: string): void;
  renameDashboard(id: string, name: string): void;
  newDashboard(): void;
  restoreDefault(): void;
  applyImported(name: string, state: DashboardState): void;
  currentName(): string;
  isDirty(): boolean;
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
  showBand: false,
  library: [],
  currentId: null,

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

      // A permalink beats the last-open dashboard, which beats the autosaved working layout,
      // which beats the built-in default. An explicitly shared link is the strongest
      // statement of intent.
      const library = listDashboards();
      const currentId = getCurrentId();
      const shared = fromHash(window.location.hash);
      const saved =
        shared ??
        (currentId !== null ? (getDashboard(currentId)?.state ?? null) : null) ??
        loadLayout();

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
        library,
        currentId: shared === null ? currentId : null,
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

  toggleSeries(id: string, metric: string) {
    const next = get().panels.map((p) => {
      if (p.id !== id) return p;
      const hidden = p.hidden ?? [];
      return {
        ...p,
        hidden: hidden.includes(metric)
          ? hidden.filter((m) => m !== metric)
          : [...hidden, metric],
      };
    });
    set({ panels: next });
    persist(next, get().range);
  },

  showAllSeries(id: string) {
    const next = get().panels.map((p) => (p.id === id ? { ...p, hidden: [] } : p));
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
    if (range === null) {
      set({ range: null });
      return;
    }

    const summary = get().summary;
    let [from, to] = range;
    if (to < from) [from, to] = [to, from];

    if (summary !== null) {
      // Keep the window inside the capture, and never narrower than a handful of samples.
      // Zooming repeatedly would otherwise land on a span shorter than the sample interval,
      // which yields zero points and a blank panel with nothing to explain it.
      const floor = Math.max(summary.cadenceMs * 4, 1000);
      if (to - from < floor) {
        const centre = (from + to) / 2;
        from = centre - floor / 2;
        to = centre + floor / 2;
      }
      from = Math.max(summary.startMs, from);
      to = Math.min(summary.endMs, to);
      if (to - from < floor) {
        // Clamping against an end can re-narrow the window; push it back off that end.
        if (from <= summary.startMs) to = Math.min(summary.endMs, from + floor);
        else from = Math.max(summary.startMs, to - floor);
      }
    }

    set({ range: [Math.round(from), Math.round(to)] });
  },

  setCursor(ms) {
    set({ cursor: ms });
  },

  setShowBand(on) {
    set({ showBand: on });
  },

  saveCurrent(name) {
    const { currentId, panels, range } = get();
    const state: DashboardState = { v: LAYOUT_VERSION, panels, range };
    const title = name ?? get().currentName();
    const entry = saveDashboard(title, state, currentId ?? undefined);
    set({ library: listDashboards(), currentId: entry.id });
  },

  saveAsNew(name) {
    const { panels, range } = get();
    const entry = saveDashboard(name, { v: LAYOUT_VERSION, panels, range });
    set({ library: listDashboards(), currentId: entry.id });
  },

  openDashboard(id) {
    const entry = getDashboard(id);
    if (entry === null) return;
    // Drop metrics this capture lacks, exactly as on ingest: a dashboard built against
    // another server version should degrade rather than draw empty panels.
    const available = new Set(get().catalog.map((c) => c.path));
    const panels = entry.state.panels
      .map((p) =>
        p.kind === 'section' ? p : { ...p, metrics: p.metrics.filter((m) => hasMetric(m, available)) },
      )
      .filter((p) => p.kind === 'section' || p.metrics.length > 0);

    setCurrentId(id);
    set({ panels, range: entry.state.range, focused: panels[0]?.id ?? null, currentId: id });
    persist(panels, entry.state.range);
  },

  deleteDashboard(id) {
    removeSaved(id);
    set({ library: listDashboards(), currentId: get().currentId === id ? null : get().currentId });
  },

  renameDashboard(id, name) {
    renameSaved(id, name);
    set({ library: listDashboards() });
  },

  newDashboard() {
    const panels: PanelSpec[] = [
      { id: panelId(), kind: 'chart', title: 'New panel', metrics: [], x: 0, y: 0, w: 12, h: 8 },
    ];
    setCurrentId(null);
    set({ panels, focused: panels[0]!.id, currentId: null, range: null });
    persist(panels, null);
  },

  restoreDefault() {
    const state = defaultDashboard(new Set(get().catalog.map((c) => c.path)));
    setCurrentId(null);
    set({ panels: state.panels, focused: state.panels[0]?.id ?? null, currentId: null, range: null });
    persist(state.panels, null);
  },

  applyImported(name, state) {
    const entry = saveDashboard(name, state);
    set({ library: listDashboards(), currentId: entry.id });
    get().openDashboard(entry.id);
  },

  currentName() {
    const { currentId, library } = get();
    return library.find((d) => d.id === currentId)?.name ?? 'Default dashboard';
  },

  isDirty() {
    const { currentId, panels, range } = get();
    return isDirty(currentId, { v: LAYOUT_VERSION, panels, range });
  },

  reset() {
    set({ status: 'empty', summary: null, catalog: [], range: null, error: null });
  },
}));

export { CAPTURE_ID };
