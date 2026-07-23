/**
 * Capture-qualified metric references, and planning an expression that spans captures.
 *
 * With one capture loaded a metric is just a path. With a replica set loaded, "which node" is
 * part of the question, so a reference can name a capture:
 *
 *   serverStatus.mem.resident              every visible capture (fan-out, see panelData.ts)
 *   c1:serverStatus.mem.resident           that node only
 *   diff(c0:…lastWriteDate, c1:…lastWriteDate)   the cross-host metric M4 exists for
 *
 * The qualifier is a capture id we mint ourselves (`c0`, `c1`, …) followed by a colon, and it
 * is only treated as a qualifier when it names a capture that is actually loaded. That matters
 * because FTDC paths are not tame identifiers -- they contain dots, spaces, slashes,
 * parentheses and `#` collision suffixes -- so a syntactic rule alone would eventually
 * misread a real path. Resolution against the loaded set cannot.
 *
 * Cross-capture evaluation cannot happen inside one reader: the readers may live in different
 * workers, and two nodes do not share a sample clock. So an expression is split at the highest
 * nodes whose subtrees belong to a single capture. Each of those is evaluated by its own
 * reader at FULL resolution -- rate() stays exact, which is the property ARCHITECTURE.md insists on
 * -- and only the pointwise combination on top (diff/div/pct/sum/scale) is applied afterwards,
 * on a shared time grid.
 */

import { exprToString, parseExpr, type Expr } from './expr.js';

/** True for text shaped like `<id>:<rest>` where `<id>` is a loaded capture. */
export type KnownCapture = (id: string) => boolean;

export interface Ref {
  /** null when the path names no capture explicitly. */
  readonly captureId: string | null;
  readonly path: string;
}

/**
 * Split a possibly qualified path.
 *
 * Only splits on a capture that is loaded, so `systemMetrics.mounts./run:foo` stays a path.
 */
export function splitRef(text: string, known: KnownCapture): Ref {
  const colon = text.indexOf(':');
  if (colon <= 0) return { captureId: null, path: text };
  const head = text.slice(0, colon);
  if (!known(head)) return { captureId: null, path: text };
  return { captureId: head, path: text.slice(colon + 1) };
}

export function qualifyPath(captureId: string, path: string): string {
  return `${captureId}:${path}`;
}

/* --------------------------------------------------------------- tree ops ---- */

function mapLeaves(e: Expr, f: (path: string) => string): Expr {
  switch (e.fn) {
    case 'raw':
      return { fn: 'raw', path: f(e.path) };
    case 'rate':
      return { fn: 'rate', arg: mapLeaves(e.arg, f) };
    case 'scale':
      return { fn: 'scale', arg: mapLeaves(e.arg, f), k: e.k };
    case 'pct':
      return { fn: 'pct', num: mapLeaves(e.num, f), den: mapLeaves(e.den, f) };
    case 'div':
      return { fn: 'div', num: mapLeaves(e.num, f), den: mapLeaves(e.den, f) };
    case 'diff':
      return { fn: 'diff', a: mapLeaves(e.a, f), b: mapLeaves(e.b, f) };
    case 'sum':
      return { fn: 'sum', args: e.args.map((a) => mapLeaves(a, f)) };
  }
}

function children(e: Expr): Expr[] {
  switch (e.fn) {
    case 'raw':
      return [];
    case 'rate':
    case 'scale':
      return [e.arg];
    case 'pct':
    case 'div':
      return [e.num, e.den];
    case 'diff':
      return [e.a, e.b];
    case 'sum':
      return e.args;
  }
}

/** Rebuild a node from replacement children, in the same order `children` returns them. */
function withChildren(e: Expr, kids: Expr[]): Expr {
  switch (e.fn) {
    case 'raw':
      return e;
    case 'rate':
      return { fn: 'rate', arg: kids[0]! };
    case 'scale':
      return { fn: 'scale', arg: kids[0]!, k: e.k };
    case 'pct':
      return { fn: 'pct', num: kids[0]!, den: kids[1]! };
    case 'div':
      return { fn: 'div', num: kids[0]!, den: kids[1]! };
    case 'diff':
      return { fn: 'diff', a: kids[0]!, b: kids[1]! };
    case 'sum':
      return { fn: 'sum', args: kids };
  }
}

/** Every capture an expression names, with unqualified paths attributed to `fallback`. */
export function capturesOf(e: Expr, known: KnownCapture, fallback: string): Set<string> {
  const out = new Set<string>();
  const visit = (node: Expr): void => {
    if (node.fn === 'raw') {
      out.add(splitRef(node.path, known).captureId ?? fallback);
      return;
    }
    for (const kid of children(node)) visit(kid);
  };
  visit(e);
  return out;
}

/** Drop capture qualifiers, leaving an expression a single reader can evaluate. */
export function stripCaptures(e: Expr, known: KnownCapture): Expr {
  return mapLeaves(e, (p) => splitRef(p, known).path);
}

/** Qualify every unqualified path with `captureId`, leaving explicit ones alone. */
export function qualifyExpr(expression: string, captureId: string, known: KnownCapture): string {
  return exprToString(
    mapLeaves(parseExpr(expression), (p) =>
      splitRef(p, known).captureId === null ? qualifyPath(captureId, p) : p,
    ),
  );
}

/* ----------------------------------------------------------------- plans ---- */

/** One single-capture subtree, evaluated in full by that capture's reader. */
export interface SeriesPart {
  /** Placeholder path the combining tree refers to. */
  readonly key: string;
  readonly captureId: string;
  /** Unqualified expression text, ready for `CaptureReader.getSeries`. */
  readonly expression: string;
}

export interface ExprPlan {
  readonly parts: SeriesPart[];
  /** Pointwise combination over the parts; `raw` leaves hold part keys. */
  readonly combine: Expr;
  /** True when one reader answers the whole thing -- the common case, and the fast path. */
  readonly single: boolean;
}

/**
 * Split an expression into per-capture parts plus the combination on top.
 *
 * `fallback` is the capture unqualified paths belong to -- for a fanned-out panel metric that
 * is the capture the series is being drawn for.
 */
export function planExpr(expression: string, fallback: string, known: KnownCapture): ExprPlan {
  const root = parseExpr(expression);
  const parts: SeriesPart[] = [];

  const emit = (node: Expr, captureId: string): Expr => {
    const key = `#${parts.length}`;
    parts.push({
      key,
      captureId,
      expression: exprToString(stripCaptures(node, known)),
    });
    return { fn: 'raw', path: key };
  };

  const split = (node: Expr): Expr => {
    const used = capturesOf(node, known, fallback);
    // One capture below this node: hand the whole subtree to that reader, so derivation
    // happens at full resolution rather than over already-bucketed means.
    if (used.size <= 1) return emit(node, [...used][0] ?? fallback);
    return withChildren(
      node,
      children(node).map((kid) => split(kid)),
    );
  };

  const combine = split(root);
  return { parts, combine, single: parts.length === 1 && combine.fn === 'raw' };
}

/* ------------------------------------------------------------- alignment ---- */

/**
 * Resample `(t, v)` onto `grid`, taking the sample nearest in time to each grid point.
 *
 * Two nodes never share a sample clock, so a cross-host metric has to be put on one before it
 * can be combined. Nearest sample rather than linear interpolation: FTDC values are
 * instantaneous observations, and interpolating would put numbers on the chart that no server
 * ever reported. Nearest rather than last-value-at-or-before because the error then straddles
 * zero instead of being one-sided -- carrying the previous value would make every cross-host
 * lag read systematically high by up to a full sample interval, on a chart whose whole
 * purpose is to say how far behind something is.
 *
 * What survives either way: two nodes sampling 1 s apart cannot resolve sub-second lag. The
 * result is accurate to about half a sample interval, which is why the clock-skew panel exists
 * next to the lag one.
 *
 * `maxStaleMs` is what keeps this honest at the edges. Without it, a node whose capture ends
 * early would keep contributing its final sample and a lag chart would show a clean linear
 * climb that is entirely an artefact of the missing data. Past the bound the series goes NaN,
 * which the panel draws as a break.
 */
export function alignOnto(
  grid: Float64Array,
  t: Float64Array,
  v: Float64Array,
  maxStaleMs: number,
): Float64Array {
  const out = new Float64Array(grid.length).fill(NaN);
  if (t.length === 0) return out;

  let j = 0;
  for (let i = 0; i < grid.length; i++) {
    const at = grid[i]!;
    // Advance while the next sample is at least as close as the current one. Both series are
    // sorted, so this scan is linear over the pair rather than a search per point.
    while (j + 1 < t.length && Math.abs(t[j + 1]! - at) <= Math.abs(t[j]! - at)) j++;
    if (Math.abs(t[j]! - at) > maxStaleMs) continue; // a gap, or outside this capture
    out[i] = v[j]!;
  }
  return out;
}
