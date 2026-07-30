import { create } from 'zustand';

import type { CatalogEntry } from '../data/reader.js';
import {
  LAYOUT_VERSION,
  compact,
  defaultDashboard,
  dropEmptySections,
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
import { detect, type Finding } from '../insights/detect.js';
import { buildMemberRows, type MemberRow } from '../replset/state.js';
import {
  MAX_SCAN_SAMPLES,
  baselineFor,
  rankChanges,
  type Explanation,
  type HostChange,
  type RestartNote,
  type WindowEvent,
} from '../insights/ranking.js';
import { statsOf } from '../data/scan.js';
import { RULES } from '../insights/rules.js';
import type { LogAnalysis } from '../logs/analyze.js';
import { FtdcClient } from '../workers/client.js';
import type {
  CaptureSummary,
  IngestProgressMessage,
  LogViewLine,
} from '../workers/protocol.js';
import type { Gap } from '../data/types.js';

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
  /**
   * Something worth saying before the result is in -- currently only "this will not fit".
   *
   * Separate from `error` because it is raised while ingest is still running and is a
   * prediction, not an outcome: decoding a bundle the browser has no room for takes twenty
   * minutes to fail, and the whole value is in saying so at minute zero.
   */
  notice: string | null;
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
  /** Sidebar width in px, dragged by the resizer on its right edge. Session state, like the toggle. */
  sidebarWidth: number;
  setSidebarWidth(px: number): void;
  /**
   * "Zoom the log": the log leads the dashboard instead of following it. Scrolling the log pans
   * the charts to the span of the lines on screen. Off by default -- the log follows the charts.
   * Session view state, not layout, so it stays out of permalinks and saved dashboards.
   */
  logFollow: boolean;
  toggleLogFollow(on?: boolean): void;
  /**
   * Time span of the log lines currently on screen, or null when no log is being read. The
   * panels shade it, so you can see where in the charts the lines you are looking at fall --
   * following or not. Pure view state, out of permalinks and saved dashboards.
   */
  logViewSpan: [number, number] | null;
  setLogViewSpan(span: [number, number] | null): void;
  /**
   * Panel blown up to fill the chart area, or null.
   *
   * Deliberately not part of DashboardState: it is where you are looking right now, not how
   * the dashboard is laid out, so it must not end up in a permalink or a saved dashboard.
   */
  maximized: string | null;
  /**
   * The log opened as a full-screen window -- a `less` for the mongod log, since the sidebar
   * strip is too narrow to read a slow-query command doc. Like `maximized`, this is where you
   * are looking, not how the dashboard is laid out, so it stays out of permalinks and saved
   * dashboards.
   */
  logFullscreen: boolean;
  /** Open (`true`), close (`false`), or flip the full-screen log window. */
  toggleLogFullscreen(on?: boolean): void;
  /** The help overlay. View state, never persisted. */
  showHelp: boolean;
  toggleHelp(on?: boolean): void;
  /** Which sidebar panel is showing. In the store so revealing a log line can switch to it. */
  sidebarTab: 'metrics' | 'log' | 'insights' | 'explain';
  setSidebarTab(tab: 'metrics' | 'log' | 'insights' | 'explain'): void;
  /**
   * Pathologies found by the M6 detectors, worst first.
   *
   * Recomputed when the set of loaded captures changes, not when the time range does: a finding
   * is a statement about the capture, and one that vanished because the user zoomed in would be
   * worse than useless. `null` means the pass has not run yet, which reads differently from an
   * empty array -- that is a clean bill of health and worth saying out loud.
   */
  findings: Finding[] | null;
  analyzing: boolean;
  analyze(): Promise<void>;
  /**
   * Replica-set member state over time, one row per member.
   *
   * Computed when the set of drawn captures changes, not when the range does. Runs are absolute
   * spans, so the strip clips them to whatever window is on screen without going back to disk --
   * the whole reason they are built once. `null` means the pass has not run; an empty array
   * means it ran and this bundle has no replica-set status in it at all (a standalone).
   */
  memberStates: MemberRow[] | null;
  buildMemberStates(): Promise<void>;
  /** The member-state strip's visibility. Session view state, out of permalinks and layouts. */
  showStates: boolean;
  toggleStates(on?: boolean): void;
  /** The node information page, a full-screen overlay. View state, like the log window. */
  showInfo: boolean;
  toggleInfo(on?: boolean): void;
  /**
   * What changed in the visible window, against the stretch of capture before it.
   *
   * The other half of M6, and the opposite of `findings`: a finding is a statement about the
   * whole capture, an explanation is a statement about *this* window, so this one is keyed to
   * the range and recomputed when it moves. `null` means it has not been asked.
   */
  explanation: Explanation | null;
  explaining: boolean;
  /** Rank every metric over the current range. Refused, with a reason, on a window too wide. */
  explainWindow(): Promise<void>;
  /** Zoom to a span and explain it -- the "explain this episode" gesture on a finding. */
  explainRange(fromMs: number, toMs: number): void;
  /**
   * Per-capture log-parse progress, while a log is being read. Absent when idle.
   *
   * Parsing a multi-gigabyte log is not instant, and without a bar it looks like a hang -- the
   * complaint that motivated this.
   */
  logProgress: Record<string, { bytes: number; lines: number }>;
  /**
   * A log line to scroll to and flash, set by double-clicking a chart. `nonce` makes repeated
   * reveals of the same instant still fire.
   */
  logReveal: { tMs: number; nonce: number } | null;
  /** Zoom to an instant and reveal the log line there -- the double-click-a-chart gesture. */
  revealLogAt(tMs: number): void;

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
  /** Attach logs to a capture that is already open. */
  addLogs(captureId: string, files: File[]): Promise<void>;
  /**
   * Raw log lines within a window, read from disk on demand, merged across every visible node
   * that has a log and sorted by time. This is the log viewer's whole data source.
   */
  logLines(
    fromMs: number,
    toMs: number,
    opts?: {
      maxLines?: number;
      importantOnly?: boolean;
      query?: string;
      /** Fill from the start of the window (default) or its end -- see LogPage. */
      end?: 'head' | 'tail';
    },
  ): Promise<{
    lines: Array<LogViewLine & { captureId: string; captureLabel: string }>;
    hasBefore: boolean;
    hasAfter: boolean;
  }>;
  /**
   * User-pinned markers, epoch ms. Double-clicking a log line pins one; the panels draw it.
   * View state, not layout -- deliberately out of the permalink and saved dashboards.
   */
  pins: Array<{ tMs: number; label: string; severity: string }>;
  togglePin(pin: { tMs: number; label: string; severity: string }): void;
  clearPins(): void;
  /** Whether any visible capture has a log loaded. */
  hasLogs(): boolean;
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

/**
 * True when a chart compares two named captures -- the shape `crossHostPanels` produces.
 *
 * Structural rather than by title, so a renamed panel and a hand-written cross-host expression
 * both count, and a title that merely mentions a host does not.
 */
function isCrossHost(panel: PanelSpec, known: KnownCapture): boolean {
  if (panel.kind !== 'chart') return false;
  return panel.metrics.some((m) => {
    try {
      const ids = new Set(
        exprPaths(parseExpr(m))
          .map((p) => splitRef(p, known).captureId)
          .filter((id): id is string => id !== null),
      );
      return ids.size > 1;
    } catch {
      return false;
    }
  });
}

function persist(panels: PanelSpec[], range: [number, number] | null): void {
  saveLayout({ v: LAYOUT_VERSION, panels, range });
}

/** Highest value a capture's `replSetGetStatus.myState` reached, if it reports one. */
function maxStateOf(catalog: readonly CatalogEntry[]): number | undefined {
  const entry = catalog.find((c) => c.path.endsWith('replSetGetStatus.myState'));
  return entry?.max;
}

/**
 * Rows an explanation shows, across every node.
 *
 * The tail of a ranked list is noise by construction: past the first few dozen the scores are
 * within the ranking's own uncertainty, and a longer list reads as "everything changed", which
 * is what the ranking exists to avoid saying.
 */
const CHANGE_LIMIT = 60;

/**
 * Annotated log lines an explanation lists, across every node, before the rest become a count.
 *
 * Small on purpose. The value of a log annotation is that it is rare and specific -- an
 * election, a sync-source change, a restart -- and a window that lists a hundred of them has
 * reproduced the problem the annotate/count split exists to prevent, one layer up. When the
 * window holds more than this, the rarest classes are kept: twenty identical checkpoints say
 * less than one oplog-truncation line does.
 */
const EVENT_LIMIT = 16;

/** Whole-series range of a log-derived series, the counterpart of CaptureReader.rangeOf. */
function rangeOfSeries(v: Float64Array): number {
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < v.length; i++) {
    const x = v[i]!;
    if (Number.isNaN(x)) continue;
    if (x < lo) lo = x;
    if (x > hi) hi = x;
  }
  return hi >= lo ? hi - lo : NaN;
}

/**
 * First panel a metric can actually be added to.
 *
 * The default dashboard opens with a section heading ("WiredTiger"), so focusing `panels[0]`
 * pointed the catalogue -- and the explain rows -- at a panel that draws nothing: clicking a
 * metric stored it on the heading and no chart ever appeared. A click that silently does
 * nothing is the worst possible failure for the one gesture the catalogue exists for.
 */
function firstChart(panels: readonly PanelSpec[]): PanelSpec | undefined {
  return panels.find((p) => p.kind === 'chart');
}

/** One node that did not make it, and why. */
export interface Failure {
  /** The node, as the user named it -- its folder, or its hostname on a reopen. */
  readonly label: string;
  readonly detail: string;
}

/**
 * One line per distinct reason, naming every node it happened to.
 *
 * Nodes fail together far more often than they fail individually: they are decoded
 * concurrently against one shared storage quota, so whatever stops one usually stops the rest.
 * Printing the full explanation once per node turned three failures into three identical
 * paragraphs, which is where a reader stops reading -- and the paragraph is the part actually
 * worth reading, since it is the one that says what to do about it.
 */
export function joinFailures(failures: readonly Failure[]): string {
  const byDetail = new Map<string, string[]>();
  for (const f of failures) {
    const labels = byDetail.get(f.detail);
    if (labels === undefined) byDetail.set(f.detail, [f.label]);
    else labels.push(f.label);
  }
  return [...byDetail].map(([detail, labels]) => `${labels.join(', ')}: ${detail}`).join(' — ');
}

/**
 * Decoded size, as a multiple of the FTDC bytes on disk.
 *
 * Two real production captures measured with `npm run inspect`: 102 MB -> 1,522 MB stored
 * (14.9x) and 210 MB -> 2,367 MB (11.3x). FTDC is delta-and-zlib compressed and the writer
 * elides constant columns, so the ratio moves with how much of a node's metric surface is
 * actually varying; 12x sits between the two and is only ever used to answer "is this
 * hopeless", never to reserve or allocate anything.
 */
const DECODED_BYTES_PER_FTDC_BYTE = 12;

/**
 * The sentence to show when a bundle cannot fit, or null when it can.
 *
 * Pure, and exported, so the arithmetic and the wording are testable without a browser --
 * `navigator.storage.estimate()` is the only part that needs one.
 */
export function storageWarning(
  nodes: number,
  inputBytes: number,
  freeBytes: number,
): string | null {
  const needed = inputBytes * DECODED_BYTES_PER_FTDC_BYTE;
  if (needed <= freeBytes) return null;
  const size = (b: number): string =>
    b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`;
  return (
    `${nodes} node${nodes === 1 ? '' : 's'} of FTDC decodes to roughly ${size(needed)}, and ` +
    `this browser has ${size(freeBytes)} left for this site. Expect the nodes that do not fit ` +
    `to fail. Load fewer at a time, or forget captures you are done with.`
  );
}

/**
 * Say up front when a bundle cannot possibly fit.
 *
 * Ingest is the long pole: nine nodes is twenty minutes of decoding, and finding out at the
 * end that the browser had 4 GB to give is the worst possible moment to learn it. The check
 * is advisory and never blocks -- the ratio is an estimate, the quota is itself an estimate,
 * and a wrong refusal would be far more annoying than a wrong warning. It runs unawaited so
 * decoding starts immediately.
 */
async function warnIfItWillNotFit(
  groups: readonly { label: string; files: File[] }[],
  set: (partial: Partial<State>) => void,
): Promise<void> {
  try {
    if (typeof navigator === 'undefined' || navigator.storage?.estimate === undefined) return;
    const { quota, usage } = await navigator.storage.estimate();
    if (quota === undefined || usage === undefined) return;

    const input = groups.reduce((n, g) => n + g.files.reduce((m, f) => m + f.size, 0), 0);
    const notice = storageWarning(groups.length, input, Math.max(0, quota - usage));
    if (notice !== null) set({ notice });
  } catch {
    // A storage estimate is a courtesy. Never let asking for one stop an ingest.
  }
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
  failures: Failure[] = [],
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
      const kept = dropEmptySections(
        saved.panels
          .map((p) =>
            p.kind === 'section'
              ? p
              : {
                  ...p,
                  metrics: p.metrics.filter((m) => hasMetric(m, available, known, perCapture)),
                },
          )
          .filter((p) => p.kind === 'section' || p.metrics.length > 0),
      );
      // Sections are always kept, so "kept is non-empty" is not enough: a layout whose every
      // chart resolved to nothing -- metrics qualified to a capture that is not loaded, or built
      // against a different server version -- would otherwise leave a dashboard of bare section
      // headings, which is what it looks like when "nothing shows up". Fall back to the default
      // built from what this capture actually has.
      const hasChart = kept.some((p) => p.kind === 'chart');
      state = hasChart
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

  // Cross-host panels can only exist now, and only once. Asked of the charts, not of the
  // heading: the heading is what survives when the charts were dropped, so keying off it made
  // a layout that had *lost* its cross-host panels the one case that could never rebuild them.
  const hasCrossHost = panels.some((p) => isCrossHost(p, known));
  if (captures.length > 1 && !hasCrossHost) {
    const maxY = panels.reduce((m, p) => Math.max(m, p.y + p.h), 0);
    panels = [...panels, ...crossHostPanels(captures, maxY)];
  }

  const loaded = new Set(captures.map((c) => c.id));
  set({
    status: 'ready',
    error: failures.length > 0 ? joinFailures(failures) : null,
    panels,
    currentId,
    focused: get().focused ?? firstChart(panels)?.id ?? null,
    activeId: get().activeId ?? captures[0]?.id ?? null,
    progress: {},
    // A capture cannot be both open and "recent"; the list is what you could open next.
    recent: get().recent.filter((c) => !loaded.has(c.captureId)),
  });
  persist(panels, get().range);

  // Automatic, because a check nobody remembers to run is a check that does not happen -- and
  // "did the ticket pool empty at any point in these 42 hours" is the first thing anyone asks.
  // Not awaited: the dashboard must paint first, and a finding arriving a second later is fine.
  void get().analyze();
  // Same trigger, same argument: which member was primary and when it changed is asked of
  // every replica-set capture before anything else.
  void get().buildMemberStates();
}

export const useStore = create<State>((set, get) => ({
  client: new FtdcClient(),
  status: 'empty',
  error: null,
  notice: null,
  progress: {},
  captures: [],
  activeId: null,
  recent: [],
  pins: [],
  sidebarTab: 'metrics',
  findings: null,
  analyzing: false,
  memberStates: null,
  showStates: true,
  showInfo: false,
  explanation: null,
  explaining: false,
  logProgress: {},
  logReveal: null,
  panels: [],
  focused: null,
  range: null,
  cursor: null,
  showBand: false,
  showCatalog: true,
  sidebarWidth: 380,
  logFollow: false,
  logViewSpan: null,
  maximized: null,
  logFullscreen: false,
  showHelp: false,
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

  hasLogs() {
    return get().visibleCaptures().some((c) => c.logs !== undefined);
  },

  async logLines(fromMs, toMs, opts = {}) {
    // One read per node that has a log, issued together. Merging on the main thread keeps the
    // worker side a plain positioned read; the volume that comes back is bounded by maxLines.
    const withLog = get()
      .visibleCaptures()
      .filter((c) => c.logs !== undefined);
    if (withLog.length === 0) {
      return { lines: [], hasBefore: false, hasAfter: false };
    }

    const results = await Promise.all(
      withLog.map(async (capture) => {
        const page = await get().client.logLines(capture.id, fromMs, toMs, opts);
        return {
          ...page,
          lines: page.lines.map((line) => ({
            ...line,
            captureId: capture.id,
            captureLabel: capture.label,
          })),
        };
      }),
    );

    const merged = results.flatMap((r) => r.lines).sort((a, b) => a.tMs - b.tMs);
    // Each node was capped at maxLines; cap the merge too, so a three-node bundle shows the same
    // bounded number of lines as one node rather than three times as many. Trim from the end the
    // reader is paging away from: dropping the tail of a backwards page would discard exactly the
    // lines that join onto what is already on screen.
    const cap = opts.maxLines ?? merged.length;
    const over = merged.length > cap;
    const tail = opts.end === 'tail';
    return {
      lines: over ? (tail ? merged.slice(-cap) : merged.slice(0, cap)) : merged,
      hasBefore: results.some((r) => r.hasBefore) || (over && tail),
      hasAfter: results.some((r) => r.hasAfter) || (over && !tail),
    };
  },

  togglePin(pin) {
    const pins = get().pins;
    // Same instant toggles off, so a double-click that pinned a marker un-pins it.
    const without = pins.filter((p) => p.tMs !== pin.tMs);
    set({ pins: without.length === pins.length ? [...pins, pin] : without });
  },

  clearPins() {
    set({ pins: [] });
  },

  setSidebarTab(tab) {
    set({ sidebarTab: tab });
  },

  toggleStates(on) {
    set({ showStates: on ?? !get().showStates });
  },

  toggleInfo(on) {
    set({ showInfo: on ?? !get().showInfo });
  },

  /**
   * Build the member-state strip for every drawn capture.
   *
   * Runs beside `analyze()` on the same triggers, and for the same reason: "which member was
   * primary, and did that change" is one of the handful of questions asked of every capture
   * before anyone looks at a chart, and one nobody should have to construct a panel to answer.
   *
   * Failure is silent by design -- a bundle with no `replSetGetStatus` in it is a standalone,
   * not an error, and the strip simply does not appear.
   */
  async buildMemberStates() {
    const captures = get().visibleCaptures();
    if (captures.length === 0) {
      set({ memberStates: null });
      return;
    }
    try {
      const rows = await buildMemberRows(
        get().source(),
        captures.map((c) => ({ id: c.id, label: c.label, paths: c.paths, catalog: c.catalog })),
      );
      set({ memberStates: rows });
    } catch {
      set({ memberStates: null });
    }
  },

  /**
   * Run every detector over every visible capture.
   *
   * Deliberately over the WHOLE capture rather than the visible range: "was anything wrong with
   * this server" is a question about the bundle, and an answer that changed as you zoomed would
   * be untrustworthy in both directions.
   *
   * `maxPoints` sets the bucket width the detectors reason over -- about 7 s on a 42-hour
   * capture, and full resolution on anything smaller. Detection reads the conservative end of
   * each bucket's envelope (see detect.ts), so a coarser bucket can only hide a short episode,
   * never invent one.
   */
  async analyze() {
    const captures = get().visibleCaptures();
    if (captures.length === 0) {
      set({ findings: null, analyzing: false });
      return;
    }
    set({ analyzing: true });
    try {
      const findings = await detect(
        get().source(),
        captures.map((c) => ({ id: c.id, label: c.label, paths: c.paths })),
        RULES,
        { maxPoints: 20_000 },
      );
      set({ findings });
    } catch {
      // A detector pass that fails must not look like a clean capture.
      set({ findings: null });
    } finally {
      set({ analyzing: false });
    }
  },

  /**
   * Rank every metric by how much it moved inside the visible window.
   *
   * Per capture and concurrently, because the scans are independent and a three-node bundle
   * would otherwise take three times as long for no reason -- the same argument as ingest.
   *
   * Log-derived series are ranked here rather than in the worker: they never went to disk, so
   * the numbers are already in memory. They go through the same `rankChanges` as everything
   * else, so a burst of slow queries is ranked against the metrics it happened alongside rather
   * than being a separate list nobody correlates.
   */
  async explainWindow() {
    const range = get().range;
    const bounds = get().bounds();
    if (range === null || bounds === null) {
      set({ explanation: null });
      return;
    }

    const window = { fromMs: range[0], toMs: range[1] };
    const capture = { fromMs: bounds.startMs, toMs: bounds.endMs };
    const baseline = baselineFor(window, capture);
    if (baseline === null) {
      set({
        explanation: {
          window,
          baseline: null,
          changes: [],
          events: [],
          restarts: [],
          moreEvents: 0,
          compared: 0,
          errors: [
            'the window covers the whole capture, so there is nothing to compare it against — zoom in',
          ],
        },
      });
      return;
    }

    set({ explaining: true });
    const captures = get().visibleCaptures();
    const errors: string[] = [];
    const changes: HostChange[] = [];
    const events: WindowEvent[] = [];
    const restarts: RestartNote[] = [];
    let compared = 0;
    let moreEvents = 0;

    try {
      await Promise.all(
        captures.map(async (c) => {
          // A restart resets every cumulative counter, so a window or baseline containing one
          // produces hundreds of "changes" that are all the same fact. Say the fact instead.
          for (const tMs of c.summary.restarts) {
            const where =
              tMs >= window.fromMs && tMs <= window.toMs
                ? 'window'
                : tMs >= baseline.fromMs && tMs <= baseline.toMs
                  ? 'baseline'
                  : null;
            if (where !== null) {
              restarts.push({ captureId: c.id, captureLabel: c.label, tMs, where });
            }
          }

          try {
            const result = await get().client.explain(c.id, window, baseline, {
              maxSamples: MAX_SCAN_SAMPLES,
            });
            compared += result.compared;
            for (const change of result.changes) {
              changes.push({ ...change, captureId: c.id, captureLabel: c.label });
            }
          } catch (err) {
            errors.push(`${c.label}: ${err instanceof Error ? err.message : String(err)}`);
          }

          const logs = c.logs;
          if (logs === undefined) return;

          // Annotated lines are the rare, specific ones -- an election, a sync-source change --
          // so inside a brushed window there are normally a handful, and they are the answer far
          // more often than any metric is. Trimming happens after the merge, across all nodes.
          for (const event of logs.events) {
            if (event.tMs < window.fromMs || event.tMs > window.toMs) continue;
            events.push({ ...event, captureId: c.id, captureLabel: c.label });
          }

          const seconds = Math.max(1, (capture.toMs - capture.fromMs) / 1000);
          const logInputs = Object.entries(logs.series).map(([path, series]) => {
            const range = rangeOfSeries(series.v);
            return {
              path,
              base: statsOf(series.t, series.v, baseline.fromMs, baseline.toMs),
              win: statsOf(series.t, series.v, window.fromMs, window.toMs),
              range,
              rateScale: range / seconds,
            };
          });
          compared += logInputs.length;
          for (const change of rankChanges(logInputs)) {
            changes.push({ ...change, captureId: c.id, captureLabel: c.label });
          }
        }),
      );

      changes.sort((a, b) => b.score - a.score);
      restarts.sort((a, b) => a.tMs - b.tMs);

      // Keep the rarest classes when there are too many: a window holding sixty checkpoints and
      // one oplog truncation must not lose the truncation. Ties fall back to time order.
      const perKind = new Map<string, number>();
      for (const event of events) perKind.set(event.kind, (perKind.get(event.kind) ?? 0) + 1);
      const kept = [...events]
        .sort(
          (a, b) =>
            (perKind.get(a.kind) ?? 0) - (perKind.get(b.kind) ?? 0) || a.tMs - b.tMs,
        )
        .slice(0, EVENT_LIMIT)
        .sort((a, b) => a.tMs - b.tMs);
      moreEvents = events.length - kept.length;
      set({
        explanation: {
          window,
          baseline,
          changes: changes.slice(0, CHANGE_LIMIT),
          events: kept,
          restarts,
          moreEvents,
          compared,
          errors,
        },
      });
    } finally {
      set({ explaining: false });
    }
  },

  explainRange(fromMs, toMs) {
    get().setRange([fromMs, toMs]);
    set({ sidebarTab: 'explain', showCatalog: true });
    void get().explainWindow();
  },

  revealLogAt(tMs) {
    // Zoom to a couple of minutes either side, so the log window is small enough to hold this
    // instant (the whole-capture window is capped at a few hundred lines and might not), and
    // the charts show what surrounds it. Then switch to the log and mark the moment; the
    // LogView scrolls to the nearest line once its window has loaded.
    get().setRange([tMs - 120_000, tMs + 120_000]);
    set({
      sidebarTab: 'log',
      showCatalog: true,
      logReveal: { tMs, nonce: (get().logReveal?.nonce ?? 0) + 1 },
    });
  },

  async addLogs(captureId: string, files: File[]) {
    if (files.length === 0) return;
    // Switch to the log tab immediately, so the progress bar is where the user is looking.
    set({ sidebarTab: 'log' });
    try {
      const capture = get().captures.find((c) => c.id === captureId);
      const analysis = await get().client.logs(
        captureId,
        files,
        capture?.summary.startMs,
        capture?.summary.endMs,
        (p) =>
          set((st) => ({
            logProgress: { ...st.logProgress, [captureId]: { bytes: p.bytesWritten, lines: p.samples } },
          })),
      );
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
    } finally {
      set((st) => {
        const next = { ...st.logProgress };
        delete next[captureId];
        return { logProgress: next };
      });
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
    set({ status: 'ingesting', error: null, notice: null, progress: {} });
    void warnIfItWillNotFit(groups, set);

    const logsByGroup = groupLogs(sources, groups);
    const failures: Failure[] = [];

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
              // Index only what the capture covers: a 36-hour log beside a 4-hour capture is
              // mostly bytes nobody will look at.
              logs = await get().client.logs(id, logFiles, summary.startMs, summary.endMs, (p) =>
                set((st) => ({
                  logProgress: {
                    ...st.logProgress,
                    [id]: { bytes: p.bytesWritten, lines: p.samples },
                  },
                })),
              );
            } catch (err) {
              failures.push({
                label: `${group.label} logs`,
                detail: err instanceof Error ? err.message : String(err),
              });
            }
            set((st) => {
              const next = { ...st.logProgress };
              delete next[id];
              return { logProgress: next };
            });
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
          failures.push({
            label: group.label,
            detail: err instanceof Error ? err.message : String(err),
          });
          return null;
        }
      }),
    );

    const added = results.filter((c): c is CaptureState => c !== null);
    if (added.length === 0) {
      set({
        status: first ? 'error' : 'ready',
        error: joinFailures(failures) || 'nothing could be decoded',
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

    const failures: Failure[] = [];
    const results = await Promise.all(
      ids.map(async (id): Promise<CaptureState | null> => {
        const summary = byId.get(id);
        if (summary === undefined) return null;
        try {
          // The bytes are already columnar in OPFS; this is a manifest read and a catalogue
          // build, not a decode.
          const catalog = await get().client.catalog(id);
          const maxState = maxStateOf(catalog);
          // The log was persisted alongside the metrics, so a reopen brings it back too --
          // re-read from OPFS and rebuild the annotations, rather than asking for the file
          // again. Cheap: only the capture window was stored.
          let logs: LogAnalysis | undefined;
          if (summary.hasLog === true) {
            try {
              logs = await get().client.restoreLogs(id, (p) =>
                set((st) => ({
                  logProgress: { ...st.logProgress, [id]: { bytes: p.bytesWritten, lines: p.samples } },
                })),
              );
            } catch (err) {
              failures.push({
                label: `${summary.hostname ?? id} logs`,
                detail: err instanceof Error ? err.message : String(err),
              });
            } finally {
              set((st) => {
                const next = { ...st.logProgress };
                delete next[id];
                return { logProgress: next };
              });
            }
          }
          return {
            id,
            label: summary.hostname ?? id,
            source: '',
            summary,
            catalog,
            paths: new Set([...catalog.map((c) => c.path), ...Object.keys(logs?.series ?? {})]),
            ...(maxState !== undefined ? { maxState } : {}),
            ...(logs !== undefined ? { logs } : {}),
            visible: true,
          };
        } catch (err) {
          failures.push({
            label: summary.hostname ?? id,
            detail: err instanceof Error ? err.message : String(err),
          });
          return null;
        }
      }),
    );

    const added = results.filter((c): c is CaptureState => c !== null);
    if (added.length === 0) {
      set({
        status: first ? 'empty' : 'ready',
        error: joinFailures(failures) || 'nothing could be re-opened',
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
      explanation: null,
      ...(closing !== undefined ? { recent: [closing.summary, ...get().recent] } : {}),
    });
    persist(panels, null);
    // A closed node cannot keep a row, and it may have been the only node reporting a peer.
    void get().buildMemberStates();
  },

  toggleCapture(id: string) {
    set({
      captures: get().captures.map((c) => (c.id === id ? { ...c, visible: !c.visible } : c)),
      // Like findings, an explanation names the nodes it was computed over. Hiding one has to
      // withdraw it rather than leave rows attributed to a node that is no longer drawn.
      explanation: null,
    });
    // Findings name the node they were found on, so hiding one has to withdraw its findings.
    void get().analyze();
    // And a hidden node's row has to leave the strip -- including any peer row it was the only
    // source for, which is why this rebuilds rather than filters.
    void get().buildMemberStates();
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
      focused: get().focused === id ? (firstChart(next)?.id ?? null) : get().focused,
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
    // A section can be focused -- by a saved layout, or by removing the last chart above it --
    // and metrics stored on one are never drawn. Fall through to a real chart instead.
    const focusedPanel = panels.find((p) => p.id === focused);
    const target = (focusedPanel?.kind === 'chart' ? focusedPanel : firstChart(panels))?.id;
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
      focused: firstChart(state.panels)?.id ?? null,
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

  setSidebarWidth(px) {
    set({ sidebarWidth: px });
  },

  toggleLogFollow(on) {
    set({ logFollow: on ?? !get().logFollow });
  },

  setLogViewSpan(span) {
    set({ logViewSpan: span });
  },

  toggleLogFullscreen(on) {
    set({ logFullscreen: on ?? !get().logFullscreen });
  },

  toggleHelp(on) {
    set({ showHelp: on ?? !get().showHelp });
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
    set({ panels, range: entry.state.range, focused: firstChart(panels)?.id ?? null, currentId: id });
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
    set({ panels, focused: firstChart(panels)?.id ?? null, currentId: null, range: null });
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
      notice: null,
      explanation: null,
      findings: null,
      recent: [...closed, ...get().recent],
    });
  },
}));
