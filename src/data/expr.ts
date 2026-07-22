/**
 * Derived metrics.
 *
 * Most of FTDC is cumulative counters. `serverStatus.opcounters.query` only ever goes up, so
 * charting it raw produces a monotonic ramp that tells you nothing -- what an engineer
 * actually wants is queries per second. The same is true of network bytes, disk IO, page
 * faults, evictions and asserts. Several of the most useful signals are ratios that exist
 * nowhere in the raw data at all: cache dirty %, ticket utilisation, average operation
 * latency, disk utilisation.
 *
 * So expressions are not a power-user extra; without them the default dashboard is close to
 * useless. They are deliberately a tiny language rather than a general one -- small enough to
 * be safe, serialisable into a permalink, and readable in a panel legend.
 *
 *   serverStatus.mem.resident                          a raw metric
 *   rate(serverStatus.opcounters.query)                per-second delta of a counter
 *   pct(wt.cache.dirty, wt.cache.max)                  100 * a / b
 *   div(rate(latency), rate(ops))                      nested: average latency per op
 *   scale(rate(sys.cpu.user_ms), 0.1)                  ms/s -> % of one core
 *   sum(a, b, c)   diff(a, b)
 *
 * Evaluation happens in the reader at FULL resolution, before downsampling. Computing a rate
 * from already-bucketed means would smear exactly the short spikes the envelope exists to
 * preserve.
 */

export type Unit =
  | 'count'
  | 'bytes'
  | 'bytes/s'
  | 'ms'
  | 'us'
  | 'seconds'
  | 'percent'
  | 'per-sec';

export type Expr =
  | { readonly fn: 'raw'; readonly path: string }
  | { readonly fn: 'rate'; readonly arg: Expr }
  | { readonly fn: 'pct'; readonly num: Expr; readonly den: Expr }
  | { readonly fn: 'div'; readonly num: Expr; readonly den: Expr }
  | { readonly fn: 'sum'; readonly args: Expr[] }
  | { readonly fn: 'diff'; readonly a: Expr; readonly b: Expr }
  | { readonly fn: 'scale'; readonly arg: Expr; readonly k: number };

export class ExprError extends Error {
  override readonly name = 'ExprError';
}

const FUNCTIONS = new Set(['rate', 'pct', 'div', 'diff', 'scale', 'sum']);

/* ------------------------------------------------------------------ parse ---- */

/**
 * Split on top-level commas only, so nested calls survive.
 * `rate(a), div(b, c)` -> ['rate(a)', 'div(b, c)']
 */
function splitArgs(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  // Only leading whitespace is stripped -- see parseExpr on why the trailing kind matters.
  return out.map((s) => s.replace(/^\s+/, '')).filter((s) => s.length > 0);
}

export function parseExpr(text: string): Expr {
  // Leading whitespace is formatting; TRAILING whitespace can be part of the metric name.
  // WiredTiger emits paths that genuinely end in a space, e.g.
  // `serverStatus.wiredTiger.reconciliation.pages written including an aggregated newest
  // start durable timestamp ` -- 11 such paths in one real capture, and trimming them makes
  // the metric unresolvable. Leading whitespace was never observed on any path.
  const src = text.replace(/^\s+/, '');
  if (src.length === 0) throw new ExprError('empty expression');

  const open = src.indexOf('(');
  // No call syntax: a bare metric path. Paths contain dots, spaces and slashes and may carry
  // a duplicate-collision suffix (`path#1`), so anything non-empty is accepted here.
  if (open < 0 || !src.endsWith(')')) return { fn: 'raw', path: src };

  const fn = src.slice(0, open).trim();

  // Metric paths legitimately contain parentheses -- 80 of them in a real catalogue, e.g.
  // `systemMetrics.memory.Active(anon)_kb` and
  // `serverStatus.wiredTiger.transaction.transaction checkpoint prepare max time (msecs)`.
  // So a leading `something(` is only a call when `something` is a function we know; anything
  // else is part of the path. This also makes the nested case work, because the inner text is
  // re-parsed and falls through to the same check.
  if (!FUNCTIONS.has(fn)) return { fn: 'raw', path: src };

  const args = splitArgs(src.slice(open + 1, -1));

  const need = (n: number): void => {
    if (args.length !== n) {
      throw new ExprError(`${fn}() takes ${n} argument(s), got ${args.length}`);
    }
  };

  switch (fn) {
    case 'rate':
      need(1);
      return { fn: 'rate', arg: parseExpr(args[0]!) };
    case 'pct':
      need(2);
      return { fn: 'pct', num: parseExpr(args[0]!), den: parseExpr(args[1]!) };
    case 'div':
      need(2);
      return { fn: 'div', num: parseExpr(args[0]!), den: parseExpr(args[1]!) };
    case 'diff':
      need(2);
      return { fn: 'diff', a: parseExpr(args[0]!), b: parseExpr(args[1]!) };
    case 'scale': {
      need(2);
      const k = Number(args[1]);
      if (!Number.isFinite(k)) throw new ExprError(`scale() needs a number, got "${args[1]}"`);
      return { fn: 'scale', arg: parseExpr(args[0]!), k };
    }
    case 'sum':
      if (args.length < 2) throw new ExprError('sum() takes at least 2 arguments');
      return { fn: 'sum', args: args.map(parseExpr) };
    default:
      throw new ExprError(`unknown function "${fn}"`);
  }
}

/** Every raw metric path an expression depends on. */
export function exprPaths(e: Expr): string[] {
  switch (e.fn) {
    case 'raw':
      return [e.path];
    case 'rate':
    case 'scale':
      return exprPaths(e.arg);
    case 'pct':
    case 'div':
      return [...exprPaths(e.num), ...exprPaths(e.den)];
    case 'diff':
      return [...exprPaths(e.a), ...exprPaths(e.b)];
    case 'sum':
      return e.args.flatMap(exprPaths);
  }
}

/* --------------------------------------------------------------- evaluate ---- */

/**
 * Per-second rate of a cumulative counter.
 *
 * Two cases have to be handled or the chart lies. A counter that goes *backwards* means the
 * process restarted, so the delta is meaningless -- emit NaN (a visible break) rather than a
 * huge negative spike that reads as a real event. And a zero time delta would divide by zero.
 */
function rateOf(t: Float64Array, v: Float64Array): Float64Array {
  const out = new Float64Array(v.length);
  out[0] = NaN; // no previous sample to difference against
  for (let i = 1; i < v.length; i++) {
    const dt = (t[i]! - t[i - 1]!) / 1000;
    const dv = v[i]! - v[i - 1]!;
    out[i] = dt > 0 && dv >= 0 ? dv / dt : NaN;
  }
  return out;
}

function zip(
  a: Float64Array,
  b: Float64Array,
  f: (x: number, y: number) => number,
): Float64Array {
  const out = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = f(a[i]!, b[i]!);
  return out;
}

/** Divide, treating a zero or absent denominator as "no value" rather than Infinity. */
function safeDiv(x: number, y: number): number {
  return y === 0 || Number.isNaN(y) || Number.isNaN(x) ? NaN : x / y;
}

export function evaluate(
  e: Expr,
  t: Float64Array,
  raw: ReadonlyMap<string, Float64Array>,
): Float64Array {
  switch (e.fn) {
    case 'raw': {
      const v = raw.get(e.path);
      if (v === undefined) throw new ExprError(`unknown metric: ${e.path}`);
      // Normalise to the base unit here rather than in the templates, so a metric picked
      // straight from the catalogue is as correct as one the dashboard shipped with.
      const factor = scaleOfPath(e.path);
      if (factor === 1) return v;
      const out = new Float64Array(v.length);
      for (let i = 0; i < v.length; i++) out[i] = v[i]! * factor;
      return out;
    }
    case 'rate':
      return rateOf(t, evaluate(e.arg, t, raw));
    case 'pct':
      return zip(evaluate(e.num, t, raw), evaluate(e.den, t, raw), (x, y) => safeDiv(x, y) * 100);
    case 'div':
      return zip(evaluate(e.num, t, raw), evaluate(e.den, t, raw), safeDiv);
    case 'diff':
      // A zero operand means the field was never reported -- a replica member that has not
      // checked in yet. Differencing against epoch yields ~56 years of "lag", which reads as
      // catastrophic rather than as missing.
      return zip(evaluate(e.a, t, raw), evaluate(e.b, t, raw), (x, y) =>
        x === 0 || y === 0 ? NaN : x - y,
      );
    case 'scale': {
      const v = evaluate(e.arg, t, raw);
      const out = new Float64Array(v.length);
      for (let i = 0; i < v.length; i++) out[i] = v[i]! * e.k;
      return out;
    }
    case 'sum': {
      const parts = e.args.map((a) => evaluate(a, t, raw));
      const out = new Float64Array(t.length);
      for (let i = 0; i < out.length; i++) {
        let acc = 0;
        let seen = false;
        for (const p of parts) {
          const x = p[i]!;
          if (!Number.isNaN(x)) {
            acc += x;
            seen = true;
          }
        }
        out[i] = seen ? acc : NaN;
      }
      return out;
    }
  }
}

/* ------------------------------------------------------------------ units ---- */

/**
 * Metrics reported in a unit other than the base one, with the multiplier to normalise them.
 *
 * FTDC carries no unit metadata, so these are taken from mongod's own collectors rather than
 * guessed from the names:
 *
 * - `serverStatus.mem.{resident,virtual}` -- `ProcessInfo::getResidentSize()` and
 *   `getVirtualMemorySize()` are both documented "@return mbytes" (`util/processinfo.h`).
 *   A raw 956 would otherwise format as "956 B" instead of "956 MiB".
 * - `*_kb` -- `parseProcMemInfoFile` appends the `_kb` suffix only when /proc/meminfo itself
 *   reports the value in kB (`util/procparser.cpp`), so the suffix is a reliable marker.
 * - `*_sectors` -- `kDiskFields` names /proc/diskstats columns verbatim with no conversion
 *   (`util/procparser.cpp`). Linux always reports those in 512-byte sectors regardless of
 *   the device's physical block size, so they are bytes once scaled.
 *
 * CPU is deliberately absent: `convertTicksToMilliSeconds` already normalises USER_HZ to ms
 * before FTDC sees it, so `*_ms` needs no scaling -- only the /10 that turns ms/s into a
 * percentage of one core, which the templates do explicitly.
 */
export const PATH_SCALES: ReadonlyArray<readonly [RegExp, number, Unit]> = [
  [/(^|\.)mem\.(resident|virtual|mapped|mappedWithJournal)$/, 1024 * 1024, 'bytes'],
  [/_kb$/, 1024, 'bytes'],
  [/_sectors$/, 512, 'bytes'],
];

/** Multiplier needed to bring a path to its base unit, or 1. */
export function scaleOfPath(path: string): number {
  for (const [pattern, factor] of PATH_SCALES) if (pattern.test(path)) return factor;
  return 1;
}

/** Guess a unit from a metric path. FTDC has no unit metadata, so naming is all we have. */
export function unitOfPath(path: string): Unit {
  for (const [pattern, , unit] of PATH_SCALES) if (pattern.test(path)) return unit;

  const p = path.toLowerCase();
  if (/micros$/.test(p) || p.endsWith('_us')) return 'us';
  if (/millis$|_ms$|\bpingms$|\bms$/.test(p)) return 'ms';
  if (/\buptime$|uptimeestimate$/.test(p)) return 'seconds';
  if (/\.latency$/.test(p)) return 'us'; // opLatencies are microseconds
  if (
    p.includes('bytes') ||
    /(^|\.)(storagesize|freestoragesize|avgobjsize|totalsize|totalindexsize|size)$/.test(p)
  ) {
    return 'bytes';
  }
  return 'count';
}

/**
 * Unit of an expression with any outer rate()/scale() peeled off.
 *
 * `rate(x_ms)` is milliseconds per second; its *base* is still milliseconds, which is what
 * the dimensional rules below need.
 */
function baseUnit(e: Expr): Unit {
  return e.fn === 'rate' || e.fn === 'scale' ? baseUnit(e.arg) : unitOf(e);
}

export function unitOf(e: Expr): Unit {
  switch (e.fn) {
    case 'raw':
      return unitOfPath(e.path);
    case 'pct':
      return 'percent';
    case 'rate': {
      const inner = unitOf(e.arg);
      return inner === 'bytes' ? 'bytes/s' : 'per-sec';
    }
    case 'div': {
      // A rate over a rate cancels the per-second and leaves the numerator's own unit:
      // ms/s over ops/s is milliseconds per operation. This is what makes the latency and
      // disk-service-time panels read in time rather than as a bare number.
      if (e.num.fn === 'rate' && e.den.fn === 'rate') return baseUnit(e.num);
      const n = unitOf(e.num);
      return n === 'per-sec' || n === 'bytes/s' ? 'count' : n;
    }
    case 'scale': {
      const inner = unitOf(e.arg);
      // Time accumulated per unit time is dimensionless -- 1000 ms/s is one core, or one
      // device, fully busy. Scaling by 0.1 expresses that as a percentage, which is how both
      // CPU usage and iostat's %util are conventionally read.
      if (inner === 'per-sec' && baseUnit(e.arg) === 'ms' && e.k === 0.1) return 'percent';
      return inner;
    }
    case 'diff':
      return unitOf(e.a);
    case 'sum':
      return unitOf(e.args[0]!);
  }
}

/** Render an expression back to its canonical text form. */
export function exprToString(e: Expr): string {
  switch (e.fn) {
    case 'raw':
      return e.path;
    case 'rate':
      return `rate(${exprToString(e.arg)})`;
    case 'pct':
      return `pct(${exprToString(e.num)}, ${exprToString(e.den)})`;
    case 'div':
      return `div(${exprToString(e.num)}, ${exprToString(e.den)})`;
    case 'diff':
      return `diff(${exprToString(e.a)}, ${exprToString(e.b)})`;
    case 'scale':
      return `scale(${exprToString(e.arg)}, ${e.k})`;
    case 'sum':
      return `sum(${e.args.map(exprToString).join(', ')})`;
  }
}
