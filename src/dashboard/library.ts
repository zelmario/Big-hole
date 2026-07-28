/**
 * Saved dashboards.
 *
 * The ported Grafana dashboard is a starting point, not the product. An engineer investigating
 * a particular class of problem builds their own view -- a replication set, a cache-pressure
 * set -- and wants it back next week without rebuilding it. So dashboards are named, listed,
 * and switchable, with the built-in one always recoverable.
 *
 * Stored in localStorage: layouts only, never series data. Capture bytes live in OPFS, which
 * is storage rather than a synchronous browser store, and tests/privacy.test.ts enforces the
 * split.
 */

import {
  LAYOUT_VERSION,
  clearLayout,
  encodeState,
  decodeState,
  type DashboardState,
} from './layout.js';

const LIBRARY_KEY = 'big-hole:dashboards';
const CURRENT_KEY = 'big-hole:current';

/** Keys used before the project took the Big Hole name. Migrated on first read; see below. */
const LEGACY_KEYS: ReadonlyArray<readonly [legacy: string, current: string]> = [
  ['ftdc-lens:dashboards', LIBRARY_KEY],
  ['ftdc-lens:current', CURRENT_KEY],
];

/**
 * Move anything saved under the old names across, once.
 *
 * Saved dashboards are the only thing in this app a user has actually authored, and a rename
 * is the worst possible reason to lose them. Runs before every read rather than at startup so
 * it cannot be skipped by whichever module happens to load first.
 */
function migrateLegacy(): void {
  try {
    for (const [legacy, current] of LEGACY_KEYS) {
      if (localStorage.getItem(current) !== null) continue;
      const raw = localStorage.getItem(legacy);
      if (raw === null) continue;
      localStorage.setItem(current, raw);
      localStorage.removeItem(legacy);
    }
  } catch {
    /* see write(): storage can be unavailable, and that is not worth failing over */
  }
}

export interface SavedDashboard {
  readonly id: string;
  readonly name: string;
  /** Epoch ms of the last save, for ordering the list. */
  readonly updatedAt: number;
  readonly state: DashboardState;
}

function newId(): string {
  return `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function read<T>(key: string, fallback: T): T {
  try {
    migrateLegacy();
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private browsing or quota. A dashboard that does not persist is still usable.
  }
}

/** Saved dashboards, most recently updated first. Entries failing validation are dropped. */
export function listDashboards(): SavedDashboard[] {
  const raw = read<SavedDashboard[]>(LIBRARY_KEY, []);
  if (!Array.isArray(raw)) return [];

  return raw
    .filter(
      (d): d is SavedDashboard =>
        typeof d?.id === 'string' &&
        typeof d.name === 'string' &&
        // Round-trip through the layout validator so a dashboard saved by an older version
        // is discarded rather than rendered into.
        d.state?.v === LAYOUT_VERSION &&
        decodeState(encodeState(d.state)) !== null,
    )
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function persist(all: SavedDashboard[]): void {
  write(LIBRARY_KEY, all);
}

export function saveDashboard(
  name: string,
  state: DashboardState,
  id?: string,
): SavedDashboard {
  const all = listDashboards();
  const entry: SavedDashboard = {
    id: id ?? newId(),
    name: name.trim() === '' ? 'Untitled' : name.trim(),
    updatedAt: Date.now(),
    state,
  };

  const at = all.findIndex((d) => d.id === entry.id);
  if (at >= 0) all[at] = entry;
  else all.unshift(entry);

  persist(all);
  setCurrentId(entry.id);
  return entry;
}

export function deleteDashboard(id: string): void {
  persist(listDashboards().filter((d) => d.id !== id));
  if (getCurrentId() === id) setCurrentId(null);
}

export function renameDashboard(id: string, name: string): void {
  const all = listDashboards().map((d) =>
    d.id === id ? { ...d, name: name.trim() === '' ? d.name : name.trim(), updatedAt: Date.now() } : d,
  );
  persist(all);
}

export function getDashboard(id: string): SavedDashboard | null {
  return listDashboards().find((d) => d.id === id) ?? null;
}

export function getCurrentId(): string | null {
  return read<string | null>(CURRENT_KEY, null);
}

export function setCurrentId(id: string | null): void {
  if (id === null) {
    try {
      localStorage.removeItem(CURRENT_KEY);
    } catch {
      /* see write() */
    }
    return;
  }
  write(CURRENT_KEY, id);
}

/* ------------------------------------------------------------ file transfer ---- */

export interface DashboardFile {
  readonly kind: 'big-hole-dashboard';
  readonly v: typeof LAYOUT_VERSION;
  readonly name: string;
  readonly state: DashboardState;
}

/**
 * Serialize for download.
 *
 * A file rather than a permalink when the layout is large or when it should live in a repo
 * next to a runbook. Same guarantee either way: the view travels, the data does not.
 */
export function toFile(name: string, state: DashboardState): string {
  const payload: DashboardFile = { kind: 'big-hole-dashboard', v: LAYOUT_VERSION, name, state };
  return JSON.stringify(payload, null, 2);
}

export function fromFile(text: string): { name: string; state: DashboardState } | null {
  try {
    const parsed = JSON.parse(text) as Partial<DashboardFile> & { kind?: string };
    // The old name is still accepted: a dashboard someone exported and put next to a runbook
    // has to keep importing after the project was renamed.
    const known = parsed.kind === 'big-hole-dashboard' || parsed.kind === 'ftdc-lens-dashboard';
    if (!known || parsed.state === undefined) return null;
    // Validate through the same path a permalink takes.
    const state = decodeState(encodeState(parsed.state));
    return state === null ? null : { name: parsed.name ?? 'Imported', state };
  } catch {
    return null;
  }
}

/** True when the working layout differs from what was last saved under `id`. */
export function isDirty(id: string | null, state: DashboardState): boolean {
  if (id === null) return true;
  const saved = getDashboard(id);
  if (saved === null) return true;
  return JSON.stringify(saved.state.panels) !== JSON.stringify(state.panels);
}

/**
 * Wipe every piece of state this app keeps in the browser.
 *
 * The recovery path when a stale or hand-edited layout wedges the app at startup. It lives
 * here, next to the writes, so localStorage access stays confined to this module and
 * layout.ts -- "does anything store user data in the browser" has to remain a two-file
 * review, and that is enforced by tests/privacy.test.ts.
 *
 * Captures are untouched: they are in OPFS, they are the expensive thing, and a broken
 * dashboard is no reason to make someone decode 42 hours of FTDC again.
 */
export function clearAllLocalState(): void {
  try {
    localStorage.removeItem(LIBRARY_KEY);
    localStorage.removeItem(CURRENT_KEY);
    for (const [legacy] of LEGACY_KEYS) localStorage.removeItem(legacy);
  } catch {
    /* private browsing, or a disabled store: nothing to clear */
  }
  clearLayout();
}
