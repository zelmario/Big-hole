/**
 * Dashboard layout: shape, defaults, persistence, and permalinks.
 *
 * A permalink carries the *view* -- which panels, which metrics, which time window -- and
 * never the data. That is not a limitation to work around; it is the product promise. A
 * colleague opening your link loads their own copy of the capture from their own disk, and
 * nothing about the customer's server has crossed a network.
 */

import { deflateSync, inflateSync } from 'fflate';

import { exprPaths, parseExpr, type Unit } from '../data/expr.js';
import { DEFAULT_TEMPLATES } from './defaultDashboard.js';
import { METRIC_ALIASES } from './aliases.js';

/**
 * Bump whenever the PanelSpec shape or the grid geometry changes.
 *
 * v1 -> v2: panels gained `kind`, and the grid went from 12 to 24 columns to match the ported
 * Grafana layout.
 * v2 -> v3: panels gained `hidden`, the per-series visibility toggled from the legend. A v1 layout still *parses*, so without this bump a saved dashboard silently
 * suppressed the new default and rendered old panels at half width. Persisted layouts are a
 * compatibility surface: shape changes need a version bump, not just a type change.
 */
export const LAYOUT_VERSION = 3;

export interface PanelSpec {
  readonly id: string;
  /** `section` renders a row heading rather than a chart, mirroring Grafana's row panels. */
  readonly kind: 'chart' | 'section';
  readonly title: string;
  /** Expressions, not just paths -- see src/data/expr.ts. */
  readonly metrics: string[];
  /**
   * Series hidden from the plot but kept in the legend, toggled by clicking it -- Grafana's
   * behaviour. Distinct from removing a metric, which is done from the catalogue.
   */
  readonly hidden?: string[];
  readonly unit?: Unit;
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

/** 24 columns to match Grafana's grid 1:1, so the ported layout lands unchanged. */
export const GRID_COLUMNS = 24;

let counter = 0;
export function panelId(): string {
  counter += 1;
  return `p${counter}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Top-level sections a metric path can start with, once any role prefix is removed. */
const SECTIONS = ['serverStatus', 'replSetGetStatus', 'systemMetrics', 'local'] as const;

const SECTION_START = new RegExp(
  `(^|[(,]\\s*)(${SECTIONS.join('|')})\\.`,
  'g',
);

/**
 * Detect role prefixes used by this capture.
 *
 * MongoDB 8.0 scopes FTDC by role on a sharded cluster, so a shard member reports
 * `shard.serverStatus.…` rather than `serverStatus.…`, and a node running an embedded router
 * or config server adds `router.` / `configsvr.` alongside. Older servers nest some sections
 * under `common.`. A dashboard written against bare `serverStatus.…` paths matches nothing on
 * such a capture -- which looks exactly like "the dashboard didn't load".
 *
 * Detected from the data rather than hardcoded, so a role name we have not seen still works.
 * The empty prefix is included when a capture also has un-prefixed sections.
 */
export function detectRolePrefixes(available: ReadonlySet<string>): string[] {
  const prefixes = new Set<string>();

  for (const path of available) {
    for (const section of SECTIONS) {
      if (path.startsWith(`${section}.`)) {
        prefixes.add('');
        break;
      }
      const marker = `.${section}.`;
      const at = path.indexOf(marker);
      // Only a single leading segment counts as a role, so `local.oplog.rs.stats.…` is not
      // mistaken for a prefix on `oplog`.
      if (at > 0 && !path.slice(0, at).includes('.')) {
        prefixes.add(path.slice(0, at));
        break;
      }
    }
  }

  return [...prefixes].sort();
}

/** Rewrite an expression's metric paths to sit under a role prefix. */
export function applyRolePrefix(expression: string, prefix: string): string {
  if (prefix === '') return expression;
  return expression.replace(SECTION_START, (_m, lead: string, section: string) =>
    `${lead}${prefix}.${section}.`,
  );
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Expand `*` in an expression against the metric paths this capture actually has.
 *
 * Grafana fanned several panels out with a regex -- every disk, every mount, every replica
 * member. There is no equivalent in a static panel definition, so templates carry a `*` that
 * matches one path segment and is expanded at load time. All wildcards in one expression share
 * the same substitution, which is what makes
 * `diff(serverStatus.localTime, replSetGetStatus.members.*.lastAppliedWallTime)` produce one
 * series per member rather than a cross product.
 */
/** Prefix a single path with a role, if it starts with a known section. */
function prefixPath(path: string, prefix: string): string {
  if (prefix === '') return path;
  return SECTIONS.some((section) => path.startsWith(`${section}.`)) ? `${prefix}.${path}` : path;
}

/** Concrete paths a glob resolves to. */
function globMatches(pattern: string, available: ReadonlySet<string>): string[] {
  const re = new RegExp(`^${escapeRegExp(pattern).replace(/\\\*/g, '([^.]+)')}$`);
  return [...available].filter((path) => re.test(path)).sort();
}

/**
 * Resolve every path in an expression, trying the given prefixes in order for each.
 * Returns [] if any path fails to resolve.
 */
function resolveWith(
  expression: string,
  paths: readonly string[],
  available: ReadonlySet<string>,
  order: readonly string[],
): string[] {
  let expr = expression;
  const globs: string[] = [];

  const pin = (path: string, match: (full: string) => boolean): string | undefined => {
    for (const candidate of [path, ...(METRIC_ALIASES[path] ?? [])]) {
      for (const prefix of order) {
        const full = prefixPath(candidate, prefix);
        if (match(full)) return full;
      }
    }
    return undefined;
  };

  for (const path of paths) {
    if (path.includes('*')) {
      globs.push(path);
      continue;
    }
    const resolved = pin(path, (full) => available.has(full));
    if (resolved === undefined) return [];
    if (resolved !== path) expr = expr.split(path).join(resolved);
  }

  for (const glob of globs) {
    const pinned = pin(glob, (full) => globMatches(full, available).length > 0);
    if (pinned === undefined) return [];
    if (pinned !== glob) expr = expr.split(glob).join(pinned);
  }

  return globs.length === 0 ? [expr] : expandOne(expr, available);
}

/**
 * Resolve a template metric against a real capture.
 *
 * Three axes of variation, all driven by what the capture contains rather than by a version
 * number:
 *
 *   1. aliases  -- renamed between releases (tickets left wiredTiger.concurrentTransactions
 *                  for queues.execution in 8.0)
 *   2. role     -- sections scoped by role on a sharded cluster (`shard.serverStatus.…`)
 *   3. globs    -- one series per disk, mount, or replica-set member
 *
 * Roles are resolved in two passes, because both behaviours are wanted and they conflict:
 *
 *   uniform -- every path under one prefix, tried for each prefix in turn. A node running
 *              several roles (a config shard reports `shard.` and `configsvr.`) genuinely has
 *              a different value per role, so a simple metric should show all of them.
 *   mixed   -- each path resolved independently. A real sharded 8.0 capture puts the clock
 *              under `common.` and replication under `shard.`, so an expression spanning two
 *              sections resolves under no single prefix. Without this fallback, replica lag
 *              disappears on exactly the captures it matters most for.
 *
 * Uniform wins when it works, so multi-role fan-out is preserved; mixing only kicks in for
 * genuinely cross-section expressions.
 *
 * Returns an empty array when nothing resolves, so the panel is dropped rather than drawn
 * blank.
 */
export function expandMetric(
  expression: string,
  available: ReadonlySet<string>,
  prefixes: readonly string[] = [''],
): string[] {
  let paths: string[];
  try {
    paths = [...new Set(exprPaths(parseExpr(expression)))];
  } catch {
    return [];
  }

  // Always keep the bare form as a fallback: a capture may prefix some sections and not
  // others.
  const order = prefixes.includes('') ? [...prefixes] : [...prefixes, ''];

  const uniform: string[] = [];
  for (const prefix of order) {
    uniform.push(...resolveWith(expression, paths, available, [prefix]));
  }
  if (uniform.length > 0) return [...new Set(uniform)];

  return [...new Set(resolveWith(expression, paths, available, order))];
}

function expandOne(expression: string, available: ReadonlySet<string>): string[] {
  const complete = (expr: string): boolean => {
    try {
      return exprPaths(parseExpr(expr)).every((p) => available.has(p));
    } catch {
      return false;
    }
  };

  if (!expression.includes('*')) return complete(expression) ? [expression] : [];

  let wild: string | undefined;
  try {
    wild = exprPaths(parseExpr(expression)).find((p) => p.includes('*'));
  } catch {
    return [];
  }
  if (wild === undefined) return [];

  const pattern = new RegExp(`^${escapeRegExp(wild).replace('\\*', '([^.]+)')}$`);
  const values = new Set<string>();
  for (const path of available) {
    const match = pattern.exec(path);
    if (match?.[1] !== undefined) values.add(match[1]);
  }

  return [...values]
    .sort()
    .map((v) => expression.split('*').join(v))
    .filter(complete);
}

/**
 * Build the default dashboard for a capture.
 *
 * Panels whose metrics this capture lacks are dropped rather than shown empty, so an older
 * server, a different storage engine, or a standalone with no replSetGetStatus still gets a
 * working dashboard.
 */
export function defaultDashboard(available: ReadonlySet<string>): DashboardState {
  const panels: PanelSpec[] = [];
  const prefixes = detectRolePrefixes(available);

  for (const template of DEFAULT_TEMPLATES) {
    if (template.kind === 'section') {
      panels.push({ ...template, id: panelId(), metrics: [] });
      continue;
    }
    const metrics = template.metrics.flatMap((m) => expandMetric(m, available, prefixes));
    if (metrics.length === 0) continue;
    panels.push({ ...template, id: panelId(), metrics });
  }

  // Drop a section heading that ended up with nothing beneath it.
  const kept = panels.filter((p, i) => {
    if (p.kind !== 'section') return true;
    const next = panels.slice(i + 1).find((q) => q.kind === 'section');
    const until = next === undefined ? panels.length : panels.indexOf(next);
    return panels.slice(i + 1, until).some((q) => q.kind === 'chart');
  });

  if (kept.filter((p) => p.kind === 'chart').length === 0) {
    return {
      v: LAYOUT_VERSION,
      panels: [
        { id: panelId(), kind: 'chart', title: 'Metrics', metrics: [], x: 0, y: 0, w: 24, h: 9 },
      ],
      range: null,
    };
  }

  return { v: LAYOUT_VERSION, panels: kept, range: null };
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

/** A layout is only usable if every panel has the fields the renderer relies on. */
function isValidState(state: unknown): state is DashboardState {
  if (typeof state !== 'object' || state === null) return false;
  const s = state as DashboardState;
  if (s.v !== LAYOUT_VERSION || !Array.isArray(s.panels)) return false;
  return s.panels.every(
    (p) =>
      typeof p?.id === 'string' &&
      (p.kind === 'chart' || p.kind === 'section') &&
      Array.isArray(p.metrics) &&
      typeof p.x === 'number' &&
      typeof p.y === 'number' &&
      typeof p.w === 'number' &&
      typeof p.h === 'number',
  );
}

export function decodeState(token: string): DashboardState | null {
  try {
    const json = new TextDecoder().decode(inflateSync(fromBase64Url(token)));
    const parsed: unknown = JSON.parse(json);
    return isValidState(parsed) ? parsed : null;
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
    const parsed: unknown = JSON.parse(raw);
    if (isValidState(parsed)) return parsed;
    // Stale or incompatible: drop it so the current default dashboard is used instead of
    // silently rendering something from an older shape.
    localStorage.removeItem(STORAGE_KEY);
    return null;
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
