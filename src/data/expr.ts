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

export type Unit = 'count' | 'bytes' | 'bytes/s' | 'ms' | 'us' | 'percent' | 'per-sec';

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
      return v;
    }
    case 'rate':
      return rateOf(t, evaluate(e.arg, t, raw));
    case 'pct':
      return zip(evaluate(e.num, t, raw), evaluate(e.den, t, raw), (x, y) => safeDiv(x, y) * 100);
    case 'div':
      return zip(evaluate(e.num, t, raw), evaluate(e.den, t, raw), safeDiv);
    case 'diff':
      return zip(evaluate(e.a, t, raw), evaluate(e.b, t, raw), (x, y) => x - y);
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

/** Guess a unit from a metric path. FTDC has no unit metadata, so naming is all we have. */
export function unitOfPath(path: string): Unit {
  const p = path.toLowerCase();
  if (/micros$/.test(p) || p.endsWith('_us')) return 'us';
  if (/millis$|_ms$|\bms\b/.test(p)) return 'ms';
  if (p.includes('bytes') || p.endsWith('.size') || /\bmem\.(resident|virtual|mapped)/.test(p)) {
    // serverStatus.mem.* is reported in MiB, not bytes -- see toBytes() in format.ts.
    return 'bytes';
  }
  return 'count';
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
    case 'div':
      // Average of a total over a count: latency/ops keeps the numerator's unit.
      return unitOf(e.num) === 'per-sec' || unitOf(e.num) === 'bytes/s' ? 'count' : unitOf(e.num);
    case 'scale':
    case 'diff':
      return unitOf(e.fn === 'scale' ? e.arg : e.a);
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
