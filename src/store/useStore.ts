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
import { crossHostPanels } from '../dashboard/crossHost.js';
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
import { splitRef, type KnownCapture } from '../data/qualify.js';
import type { CaptureRef, SeriesSource } from '../data/panelData.js';
import { groupCaptures, groupLogs, isLogFile, type SourceFile } from '../ingest/discover.js';
import { withLogs } from '../logs/logSource.js';
import type { LogAnalysis } from '../logs/analyze.js';
import { FtdcClient } from '../workers/client.js';
import type { CaptureSummary, IngestProgressMessage } from '../workers/protocol.js';
import type { Gap } from '../data/types.js';
import type { LogEvent } from '../logs/analyze.js';

export interface Progress {
  readonly file: string;
  readonly filesDone: number;
  readonly filesTotal: number;
  readonly samples: number;
  readonly bytesWritten: number;
}

/** One loaded node. Several of these is the entire point of M4. */
export interface CaptureState {
  readonly id: string;
  /** Hostname when the FTDC metadata carries one, otherwise the folder it came from. */
  readonly label: string;
  /** Directory the files came from, kept so two same-named hosts stay distinguishable. */
  readonly source: string;
  readonly summary: CaptureSummary;
  readonly catalog: CatalogEntry[];
  readonly paths: ReadonlySet<string>;
  /** Highest `replSetGetStatus.myState` seen; 1 means this node was primary at some point. */
  readonly maxState?: number;
  /** Parsed mongod log for this node, once one has been dropped. */
  readonly logs?: LogAnalysis;
  /** Unchecked captures stay loaded but are not drawn -- cheaper than re-ingesting. */
  readonly visible: boolean;
}

interface State {
  readonly client: FtdcClient;
  status: 'empty' | 'ingesting' | 'ready' | 'error';
  error: string | null;
  /** Per-capture ingest progress, keyed by the folder being decoded. */
  progress: Record<string, Progress>;
  captures: CaptureState[];
  /** Capture the metric catalogue lists, and that catalogue clicks are added for. */
  activeId: string | null;
  /**
   * Captures already decoded into OPFS and not currently loaded.
   *
   * Ingest produces a durable artifact, so re-opening one costs a manifest read. Without this
   * a reload sent the user back to the folder picker for a capture that was already sitting
   * decoded on their own disk.
   */
  recent: CaptureSummary[];

  panels: PanelSpec[];
  /** Panel that catalog clicks add to, and that renders with a highlight. */
  focused: string | null;
  /** Visible window in epoch ms; null means the whole of every loaded capture. */
  range: [number, number] | null;
  /** Shared time cursor in epoch ms, or null when the pointer is off-chart. */
  cursor: number | null;
  /**
   * Draw the min/max envelope behind each line. Off by default: at any visible alpha it reads
   * as a drop shadow rather than as a range. It is what keeps a one-sample spike from being
   * averaged away by downsampling, so it stays available.
   */
  showBand: boolean;
  /** Metric catalogue visibility; charts take the full width when hidden. */
  showCatalog: boolean;
  /**
   * Panel blown up to fill the chart area, or null.
   *
   * Deliberately not part of DashboardState: it is where you are looking right now, not how
   * the dashboard is laid out, so it must not end up in a permalink or a saved dashboard.
   */
  maximized: string | null;

  /** Saved dashboards, most recently updated first. */
  library: SavedDashboard[];
  /** Which saved dashboard the working layout came from, if any. */
  currentId: string | null;

  ingest(sources: SourceFile[]): Promise<void>;
  /** Refresh the list of captures already in OPFS. */
  loadRecent(): Promise<void>;
  /** Re-open previously ingested captures without decoding them again. */
  reopen(ids: string[]): Promise<void>;
  /** Delete a capture's bytes from OPFS. */
  forget(id: string): Promise<void>;
  removeCapture(id: string): Promise<void>;
  toggleCapture(id: string): void;
  setActive(id: string): void;
  /** Captures currently drawn, in load order. */
  visibleCaptures(): CaptureState[];
  /** What panelData needs: id, label, paths, cadence. */
  refs(): CaptureRef[];
  /**
   * Series source for panels: log paths from memory, everything else from the worker pool.
   * Recreated per call so a log dropped mid-session is picked up without remounting anything.
   */
  source(): SeriesSource;
  /** Annotations from every visible capture, filtered, oldest first. */
  events(): Array<LogEvent & { captureId: string; captureLabel: string }>;
  /** Event class to show, or '' for all. Filters the list AND the chart markers together. */
  eventKind: string;
  eventTerm: string;
  setEventFilter(kind: string, term: string): void;
  /** Every class present, with counts, ignoring the current filter. */
  eventKinds(): Array<{ kind: string; label: string; n: number }>;
  /** Attach logs to a capture that is already open. */
  addLogs(captureId: string, files: File[]): Promise<void>;
  /** True for an id that names a loaded capture. */
  known: KnownCapture;
  /** Union bounds across visible captures, or null when nothing is loaded. */
  bounds(): { startMs: number; endMs: number; cadenceMs: number } | null;
  /** Gaps from every visible capture, for the shaded bands. */
  gaps(): Gap[];
  /** Every path any visible capture has. */
  availablePaths(): Set<string>;

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
  toggleCatalog(): void;
  toggleMaximized(id: string | null): void;

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

/**
 * True when every raw path an expression needs exists somewhere it could be drawn.
 *
 * A capture-qualified path has to exist in that capture specifically; an unqualified one only
 * has to exist in some loaded capture, because that is where it will fan out to.
 */
function hasMetric(
  expression: string,
  available: ReadonlySet<string>,
  known: KnownCapture,
  perCapture: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  try {
    return exprPaths(parseExpr(expression)).every((p) => {
      const ref = splitRef(p, known);
      if (ref.captureId === null) return available.has(ref.path);
      return perCapture.get(ref.captureId)?.has(ref.path) ?? false;
    });
  } catch {
    return false;
  }
}

function persist(panels: PanelSpec[], range: [number, number] | null): void {
  saveLayout({ v: LAYOUT_VERSION, panels, range });
}

/** Highest value a capture's `replSetGetStatus.myState` reached, if it reports one. */
function maxStateOf(catalog: readonly CatalogEntry[]): number | undefined {
  const entry = catalog.find((c) => c.path.endsWith('replSetGetStatus.myState'));
  return entry?.max;
}

let captureCounter = 0;
/**
 * Never reused within a session, and never colliding with a capture already on disk.
 *
 * Two reasons. A stale `c1:` reference in a saved dashboard must not silently alias a
 * different node; and ingest clears its target directory before writing, so minting an id
 * that OPFS already holds would destroy a capture the user can still see in the recent list.
 */
function mintCaptureId(taken: ReadonlySet<string>): string {
  while (taken.has(`c${captureCounter}`)) captureCounter++;
  const id = `c${captureCounter}`;
  captureCounter++;
  return id;
}


/**
 * Fold newly available captures into the dashboard.
 *
 * Shared by ingest and reopen, because "a capture arrived" means the same thing either way:
 * name it unambiguously, decide which layout to show if it is the first, and add the
 * cross-host panels once a second node exists.
 */
function adopt(
  get: () => State,
  set: (partial: Partial<State>) => void,
  added: CaptureState[],
  first: boolean,
  failures: string[] = [],
): void {
  // Two members of the same replica set can report the same hostname when the bundle was
  // collected from containers. Keep the folder alongside so they stay tellable apart.
  const seenLabels = new Map<string, number>();
  for (const capture of [...get().captures, ...added]) {
    seenLabels.set(capture.label, (seenLabels.get(capture.label) ?? 0) + 1);
  }
  const captures = [
    ...get().captures,
    ...added.map((c) =>
      (seenLabels.get(c.label) ?? 0) > 1
        ? { ...c, label: `${c.label} (${c.source.split('/').filter(Boolean).pop() ?? c.id})` }
        : c,
    ),
  ];

  set({ captures });

  const available = get().availablePaths();
  const perCapture = new Map(captures.map((c) => [c.id, c.paths] as const));
  const known: KnownCapture = (id) => perCapture.has(id);

  let panels: PanelSpec[];
  let currentId = get().currentId;

  if (first) {
    // A permalink beats the last-open dashboard, which beats the autosaved working layout,
    // which beats the built-in default. An explicitly shared link is the strongest statement
    // of intent.
    const savedId = getCurrentId();
    const shared = fromHash(window.location.hash);
    const saved =
      shared ??
      (savedId !== null ? (getDashboard(savedId)?.state ?? null) : null) ??
      loadLayout();

    let state: DashboardState;
    if (saved !== null) {
      // Drop metrics no loaded capture has; a layout built against another server version
      // should degrade, not produce empty charts.
      const kept = saved.panels
        .map((p) =>
          p.kind === 'section'
            ? p
            : { ...p, metrics: p.metrics.filter((m) => hasMetric(m, available, known, perCapture)) },
        )
        .filter((p) => p.kind === 'section' || p.metrics.length > 0);
      state =
        kept.length > 0
          ? { v: LAYOUT_VERSION, panels: kept, range: saved.range }
          : defaultDashboard(available);
    } else {
      state = defaultDashboard(available);
    }
    panels = state.panels;
    currentId = shared === null ? savedId : null;
    set({ library: listDashboards(), range: state.range });
  } else {
    // Adding a node to a dashboard that is already up: every unqualified panel metric picks
    // the new capture up on its next fetch, so the layout is left alone.
    panels = get().panels;
  }

  // Cross-host panels can only exist now, and only once.
  const hasCrossHost = panels.some((p) => p.title.startsWith('Across hosts'));
  if (captures.length > 1 && !hasCrossHost) {
    const maxY = panels.reduce((m, p) => Math.max(m, p.y + p.h), 0);
    panels = [...panels, ...crossHostPanels(captures, maxY)];
  }

  const loaded = new Set(captures.map((c) => c.id));
  set({
    status: 'ready',
    error: failures.length > 0 ? failures.join('; ') : null,
    panels,
    currentId,
    focused: get().focused ?? panels[0]?.id ?? null,
    activeId: get().activeId ?? captures[0]?.id ?? null,
    progress: {},
    // A capture cannot be both open and "recent"; the list is what you could open next.
    recent: get().recent.filter((c) => !loaded.has(c.captureId)),
  });
  persist(panels, get().range);
}

export const useStore = create<State>((set, get) => ({
  client: new FtdcClient(),
  status: 'empty',
  error: null,
  progress: {},
  captures: [],
  activeId: null,
  recent: [],
  eventKind: '',
  eventTerm: '',
  panels: [],
  focused: null,
  range: null,
  cursor: null,
  showBand: false,
  showCatalog: true,
  maximized: null,
  library: [],
  currentId: null,

  known: (id: string) => get().captures.some((c) => c.id === id),

  visibleCaptures() {
    return get().captures.filter((c) => c.visible);
  },

  source() {
    const byId = new Map(get().captures.map((c) => [c.id, c.logs]));
    return withLogs(get().client, (id) => byId.get(id));
  },

  events() {
    const { eventKind, eventTerm } = get();
    const needles = eventTerm.toLowerCase().split(/\s+/).filter(Boolean);
    return get()
      .visibleCaptures()
      .flatMap((c) =>
        (c.logs?.events ?? []).map((e) => ({
          ...e,
          captureId: c.id,
          captureLabel: c.label,
        })),
      )
      // Filtering here rather than in the list is what makes the markers follow it: a panel
      // asks the store for events, so narrowing to "oplog fetcher error" clears 235 checkpoint
      // lines off every chart at the same time.
      .filter((e) => eventKind === '' || e.kind === eventKind)
      .filter((e) => {
        if (needles.length === 0) return true;
        const hay = `${e.label} ${e.message} ${e.detail} ${e.captureLabel}`.toLowerCase();
        return needles.every((n) => hay.includes(n));
      })
      .sort((a, b) => a.tMs - b.tMs);
  },

  eventKinds() {
    const counts = new Map<string, { label: string; n: number }>();
    for (const capture of get().visibleCaptures()) {
      for (const e of capture.logs?.events ?? []) {
        const seen = counts.get(e.kind);
        counts.set(e.kind, { label: e.label, n: (seen?.n ?? 0) + 1 });
      }
    }
    return [...counts]
      .map(([kind, v]) => ({ kind, ...v }))
      .sort((a, b) => b.n - a.n);
  },

  setEventFilter(kind, term) {
    set({ eventKind: kind, eventTerm: term });
  },

  async addLogs(captureId: string, files: File[]) {
    if (files.length === 0) return;
    try {
      const analysis = await get().client.logs(captureId, files);
      set({
        captures: get().captures.map((c) =>
          c.id === captureId
            ? {
                ...c,
                logs: analysis,
                paths: new Set([...c.paths, ...Object.keys(analysis.series)]),
              }
            : c,
        ),
      });
    } catch (err) {
      set({ error: `log parse failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  },

  refs() {
    return get()
      .visibleCaptures()
      .map((c) => ({
        id: c.id,
        label: c.label,
        paths: c.paths,
        cadenceMs: c.summary.cadenceMs,
      }));
  },

  bounds() {
    const captures = get().visibleCaptures();
    if (captures.length === 0) return null;
    // The union, not the intersection: a member whose capture starts later should show as
    // starting later, not truncate everyone else's window.
    return {
      startMs: Math.min(...captures.map((c) => c.summary.startMs)),
      endMs: Math.max(...captures.map((c) => c.summary.endMs)),
      cadenceMs: Math.min(...captures.map((c) => c.summary.cadenceMs)),
    };
  },

  gaps() {
    return get()
      .visibleCaptures()
      .flatMap((c) => c.summary.gaps);
  },

  availablePaths() {
    const out = new Set<string>();
    for (const capture of get().visibleCaptures()) for (const p of capture.paths) out.add(p);
    return out;
  },

  async ingest(sources: SourceFile[]) {
    const groups = groupCaptures(sources);
    if (groups.length === 0) {
      set({ status: get().captures.length > 0 ? 'ready' : 'error', error: 'no metrics.* files found' });
      return;
    }

    const first = get().captures.length === 0;
    set({ status: 'ingesting', error: null, progress: {} });

    const logsByGroup = groupLogs(sources, groups);
    const failures: string[] = [];

    // One capture per worker, decoded concurrently. Sequential ingest would make a three-node
    // replica set take three times as long for no reason -- the files are independent and so
    // are their OPFS directories.
    // Everything currently loaded, plus everything on disk: ingest clears its target before
    // writing, so a collision here would silently destroy another capture.
    const taken = new Set([
      ...get().captures.map((c) => c.id),
      ...get().recent.map((c) => c.captureId),
    ]);

    const results = await Promise.all(
      groups.map(async (group): Promise<CaptureState | null> => {
        const id = mintCaptureId(taken);
        taken.add(id);
        try {
          const onProgress = (p: IngestProgressMessage) =>
            set((s) => ({
              progress: {
                ...s.progress,
                [group.label]: {
                  file: p.file,
                  filesDone: p.filesDone,
                  filesTotal: p.filesTotal,
                  samples: p.samples,
                  bytesWritten: p.bytesWritten,
                },
              },
            }));

          const summary = await get().client.ingest(id, group.files, onProgress);
          const catalog = await get().client.catalog(id);
          const maxState = maxStateOf(catalog);
          // Logs are parsed after the metrics they annotate, on the same worker, so a huge
          // mongod.log cannot delay the charts appearing.
          const logFiles = logsByGroup.get(group.key) ?? [];
          let logs: LogAnalysis | undefined;
          if (logFiles.length > 0) {
            try {
              logs = await get().client.logs(id, logFiles);
            } catch (err) {
              failures.push(`${group.label} logs: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
          return {
            id,
            label: summary.hostname ?? group.label,
            source: group.key,
            summary,
            catalog,
            // Log-derived series are metrics this node has, as far as every panel is
            // concerned. Keeping one set means resolution, dashboard pruning and the
            // degradation check all agree about what is available.
            paths: new Set([...catalog.map((c) => c.path), ...Object.keys(logs?.series ?? {})]),
            ...(maxState !== undefined ? { maxState } : {}),
            ...(logs !== undefined ? { logs } : {}),
            visible: true,
          };
        } catch (err) {
          // One bad folder must not sink the other nodes: a bundle routinely contains a
          // member whose diagnostic.data was collected mid-write.
          failures.push(`${group.label}: ${err instanceof Error ? err.message : String(err)}`);
          return null;
        }
      }),
    );

    const added = results.filter((c): c is CaptureState => c !== null);
    if (added.length === 0) {
      set({
        status: first ? 'error' : 'ready',
        error: failures.join('; ') || 'nothing could be decoded',
        progress: {},
      });
      return;
    }

    adopt(get, set, added, first, failures);
  },

  async loadRecent() {
    try {
      const found = await get().client.captures();
      const loaded = new Set(get().captures.map((c) => c.id));
      set({
        recent: found
          .filter((c) => !loaded.has(c.captureId))
          .sort((a, b) => b.endMs - a.endMs),
      });
    } catch {
      // OPFS unavailable (private browsing, an old browser): the drop zone still works, and
      // offering nothing is better than refusing to render.
      set({ recent: [] });
    }
  },

  async reopen(ids: string[]) {
    const first = get().captures.length === 0;
    const byId = new Map(get().recent.map((c) => [c.captureId, c]));
    set({ status: 'ingesting', error: null, progress: {} });

    const failures: string[] = [];
    const results = await Promise.all(
      ids.map(async (id): Promise<CaptureState | null> => {
        const summary = byId.get(id);
        if (summary === undefined) return null;
        try {
          // The bytes are already columnar in OPFS; this is a manifest read and a catalogue
          // build, not a decode.
          const catalog = await get().client.catalog(id);
          const maxState = maxStateOf(catalog);
          return {
            id,
            label: summary.hostname ?? id,
            source: '',
            summary,
            catalog,
            paths: new Set(catalog.map((c) => c.path)),
            ...(maxState !== undefined ? { maxState } : {}),
            // Logs are not persisted with the capture, so a re-opened node starts without
            // them; drop the mongod.log again to get its annotations back.
            visible: true,
          };
        } catch (err) {
          failures.push(`${summary.hostname ?? id}: ${err instanceof Error ? err.message : String(err)}`);
          return null;
        }
      }),
    );

    const added = results.filter((c): c is CaptureState => c !== null);
    if (added.length === 0) {
      set({
        status: first ? 'empty' : 'ready',
        error: failures.join('; ') || 'nothing could be re-opened',
      });
      return;
    }
    // Ids come back from disk, so the session counter has to move past them or the next
    // ingest would clear a directory that is now open.
    for (const capture of added) {
      const n = Number(capture.id.slice(1));
      if (Number.isFinite(n) && n >= captureCounter) captureCounter = n + 1;
    }
    adopt(get, set, added, first, failures);
  },

  async forget(id: string) {
    set({ recent: get().recent.filter((c) => c.captureId !== id) });
    await get().client.drop(id);
  },

  async removeCapture(id: string) {
    const closing = get().captures.find((c) => c.id === id);
    const captures = get().captures.filter((c) => c.id !== id);
    // Drop panels that referred to this capture explicitly -- a cross-host lag panel with one
    // side gone is not a lag panel. Unqualified metrics simply stop fanning out to it.
    const panels = get()
      .panels.map((p) =>
        p.kind === 'section' ? p : { ...p, metrics: p.metrics.filter((m) => !m.includes(`${id}:`)) },
      )
      .filter((p) => p.kind === 'section' || p.metrics.length > 0);

    // Closed, not deleted. The decoded columns stay in OPFS and the capture moves to the
    // recent list, so putting it back is a manifest read rather than another ingest. Deleting
    // is a separate, explicit action ("forget").
    set({
      captures,
      panels,
      status: captures.length === 0 ? 'empty' : 'ready',
      activeId: get().activeId === id ? (captures[0]?.id ?? null) : get().activeId,
      range: null,
      ...(closing !== undefined ? { recent: [closing.summary, ...get().recent] } : {}),
    });
    persist(panels, null);
  },

  toggleCapture(id: string) {
    set({
      captures: get().captures.map((c) => (c.id === id ? { ...c, visible: !c.visible } : c)),
    });
  },

  setActive(id: string) {
    set({ activeId: id });
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
    set({
      panels: next,
      focused: get().focused === id ? (next[0]?.id ?? null) : get().focused,
      // Closing the panel you are looking at should return you to the dashboard, not leave a
      // maximised view of something that no longer exists.
      maximized: get().maximized === id ? null : get().maximized,
    });
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

    const bounds = get().bounds();
    let [from, to] = range;
    if (to < from) [from, to] = [to, from];

    if (bounds !== null) {
      // Keep the window inside the loaded captures, and never narrower than a handful of
      // samples. Zooming repeatedly would otherwise land on a span shorter than the sample
      // interval, which yields zero points and a blank panel with nothing to explain it.
      const floor = Math.max(bounds.cadenceMs * 4, 1000);
      if (to - from < floor) {
        const centre = (from + to) / 2;
        from = centre - floor / 2;
        to = centre + floor / 2;
      }
      from = Math.max(bounds.startMs, from);
      to = Math.min(bounds.endMs, to);
      if (to - from < floor) {
        // Clamping against an end can re-narrow the window; push it back off that end.
        if (from <= bounds.startMs) to = Math.min(bounds.endMs, from + floor);
        else from = Math.max(bounds.startMs, to - floor);
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

  toggleCatalog() {
    set({ showCatalog: !get().showCatalog });
  },

  toggleMaximized(id) {
    // Maximising also focuses: the catalogue's "adding to" target should follow the panel you
    // are actually working on.
    set({
      maximized: id === null || get().maximized === id ? null : id,
      ...(id !== null ? { focused: id } : {}),
    });
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
    // Drop metrics no loaded capture has, exactly as on ingest: a dashboard built against
    // another server version should degrade rather than draw empty panels.
    const available = get().availablePaths();
    const perCapture = new Map(get().captures.map((c) => [c.id, c.paths] as const));
    const known: KnownCapture = (cid) => perCapture.has(cid);
    const panels = entry.state.panels
      .map((p) =>
        p.kind === 'section'
          ? p
          : { ...p, metrics: p.metrics.filter((m) => hasMetric(m, available, known, perCapture)) },
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
    const state = defaultDashboard(get().availablePaths());
    const panels = [
      ...state.panels,
      ...crossHostPanels(
        get().captures,
        state.panels.reduce((m, p) => Math.max(m, p.y + p.h), 0),
      ),
    ];
    setCurrentId(null);
    set({ panels, focused: panels[0]?.id ?? null, currentId: null, range: null });
    persist(panels, null);
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
    // Closes everything without deleting anything: the captures reappear in the recent list,
    // where "forget" removes their bytes for real. Clearing the view and destroying decoded
    // data are different intentions and should not share a button.
    const closed = get().captures.map((c) => c.summary);
    set({
      status: 'empty',
      captures: [],
      activeId: null,
      range: null,
      error: null,
      recent: [...closed, ...get().recent],
    });
  },
}));
