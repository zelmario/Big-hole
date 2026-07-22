/**
 * Dashboard layout: shape, defaults, persistence, and permalinks.
 *
 * A permalink carries the *view* -- which panels, which metrics, which time window -- and
 * never the data. That is not a limitation to work around; it is the product promise. A
 * colleague opening your link loads their own copy of the capture from their own disk, and
 * nothing about the customer's server has crossed a network.
 */

import { deflateSync, inflateSync } from 'fflate';

export const LAYOUT_VERSION = 1;

export interface PanelSpec {
  readonly id: string;
  readonly title: string;
  readonly metrics: string[];
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface DashboardState {
  readonly v: typeof LAYOUT_VERSION;
  readonly panels: PanelSpec[];
  /** Visible window in epoch ms, or null for the whole capture. */
  readonly range: [number, number] | null;
}

export const GRID_COLUMNS = 12;

let counter = 0;
export function panelId(): string {
  counter += 1;
  return `p${counter}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * The predefined dashboard.
 *
 * Curated rather than generic: these are the panels that answer "is this server in trouble"
 * fastest, in roughly the order an engineer checks them. Anything missing from a given
 * capture is dropped at load time, so an older server or a different storage engine still
 * gets a working dashboard instead of a wall of empty charts.
 */
const DEFAULT_PANELS: ReadonlyArray<Omit<PanelSpec, 'id'>> = [
  {
    title: 'Concurrency tickets available',
    metrics: [
      'serverStatus.wiredTiger.concurrentTransactions.read.available',
      'serverStatus.wiredTiger.concurrentTransactions.write.available',
    ],
    x: 0, y: 0, w: 6, h: 8,
  },
  {
    title: 'Queued operations',
    metrics: [
      'serverStatus.globalLock.currentQueue.readers',
      'serverStatus.globalLock.currentQueue.writers',
      'serverStatus.globalLock.activeClients.readers',
      'serverStatus.globalLock.activeClients.writers',
    ],
    x: 6, y: 0, w: 6, h: 8,
  },
  {
    title: 'WiredTiger cache',
    metrics: [
      'serverStatus.wiredTiger.cache.bytes currently in the cache',
      'serverStatus.wiredTiger.cache.tracked dirty bytes in the cache',
      'serverStatus.wiredTiger.cache.maximum bytes configured',
    ],
    x: 0, y: 8, w: 6, h: 8,
  },
  {
    title: 'Operations',
    metrics: [
      'serverStatus.opcounters.query',
      'serverStatus.opcounters.insert',
      'serverStatus.opcounters.update',
      'serverStatus.opcounters.delete',
      'serverStatus.opcounters.getmore',
      'serverStatus.opcounters.command',
    ],
    x: 6, y: 8, w: 6, h: 8,
  },
  {
    title: 'Connections',
    metrics: ['serverStatus.connections.current', 'serverStatus.connections.available'],
    x: 0, y: 16, w: 6, h: 8,
  },
  {
    title: 'Memory',
    metrics: ['serverStatus.mem.resident', 'serverStatus.mem.virtual'],
    x: 6, y: 16, w: 6, h: 8,
  },
];

/** Build the default dashboard, keeping only metrics this capture actually has. */
export function defaultDashboard(available: ReadonlySet<string>): DashboardState {
  const panels = DEFAULT_PANELS.map((p) => ({
    ...p,
    id: panelId(),
    metrics: p.metrics.filter((m) => available.has(m)),
  })).filter((p) => p.metrics.length > 0);

  // Nothing recognised -- an unfamiliar server shape. Show something rather than nothing.
  if (panels.length === 0) {
    return {
      v: LAYOUT_VERSION,
      panels: [{ id: panelId(), title: 'Metrics', metrics: [], x: 0, y: 0, w: 12, h: 9 }],
      range: null,
    };
  }

  return { v: LAYOUT_VERSION, panels: compact(panels), range: null };
}

/** Re-flow panels so there are no vertical holes after a removal. */
export function compact(panels: PanelSpec[]): PanelSpec[] {
  return [...panels].sort((a, b) => a.y - b.y || a.x - b.x);
}

/* ------------------------------------------------------- encode / decode ---- */

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Compress a layout into a URL-safe token.
 *
 * Uses fflate, which is already a dependency for FTDC inflate -- no extra bytes shipped, and
 * nothing fetched at runtime.
 */
export function encodeState(state: DashboardState): string {
  return toBase64Url(deflateSync(new TextEncoder().encode(JSON.stringify(state))));
}

export function decodeState(token: string): DashboardState | null {
  try {
    const json = new TextDecoder().decode(inflateSync(fromBase64Url(token)));
    const parsed = JSON.parse(json) as DashboardState;
    if (parsed.v !== LAYOUT_VERSION || !Array.isArray(parsed.panels)) return null;
    return parsed;
  } catch {
    // A truncated or hand-edited link should fall back to the default dashboard, not crash.
    return null;
  }
}

/**
 * Browsers vary, but ~8 KB is the smallest limit worth respecting. Past that the caller
 * offers a downloadable file instead of a link.
 */
export const MAX_PERMALINK_CHARS = 8000;

export interface Permalink {
  readonly url: string;
  /** False when the layout is too large to survive a URL; export the JSON instead. */
  readonly withinLimit: boolean;
}

export function toPermalink(state: DashboardState, base: string): Permalink {
  const token = encodeState(state);
  const url = `${base.split('#')[0]}#d=${token}`;
  return { url, withinLimit: url.length <= MAX_PERMALINK_CHARS };
}

export function fromHash(hash: string): DashboardState | null {
  const match = /[#&]d=([A-Za-z0-9\-_]+)/.exec(hash);
  return match?.[1] === undefined ? null : decodeState(match[1]);
}

/* ------------------------------------------------------------ local disk ---- */

const STORAGE_KEY = 'ftdc-lens:layout';

/**
 * Persist the layout only.
 *
 * Never series data: raw capture bytes belong in OPFS, which is storage rather than a
 * network surface. tests/privacy.test.ts enforces that this module is the only place
 * localStorage is touched at all.
 */
export function saveLayout(state: DashboardState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...state, range: null }));
  } catch {
    // Private browsing, quota, or a disabled store. A dashboard that does not persist is
    // still a working dashboard.
  }
}

export function loadLayout(): DashboardState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as DashboardState;
    return parsed.v === LAYOUT_VERSION && Array.isArray(parsed.panels) ? parsed : null;
  } catch {
    return null;
  }
}

export function clearLayout(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* see saveLayout */
  }
}
