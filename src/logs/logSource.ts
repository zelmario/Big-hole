/**
 * Log-derived series, served alongside FTDC metrics.
 *
 * A panel should not care whether `logs.slowQuery.p95Ms` came from a log file and
 * `serverStatus.wiredTiger.cache.bytes currently in the cache` came from a decoded chunk --
 * the whole point of M5 is to put them on one axis. So log series are exposed as ordinary
 * metric paths and this wrapper routes them, leaving `fetchPanelData` and every panel
 * untouched.
 *
 * They stay in memory rather than going through OPFS: a whole day of 10-second buckets is a
 * few thousand points per class, which is nothing, and writing them would mean a second
 * columnar format for data that is already bounded.
 *
 * Expressions work the same way as anywhere else -- `rate()`, `div()` and the rest are the
 * same evaluator. The one thing that is not supported is mixing a log path and an FTDC path
 * inside a single expression: they have different clocks, and the honest answer is the
 * cross-capture alignment machinery, not a silent join. Such an expression is refused by name
 * rather than quietly producing a line.
 */

import { envelope } from '../data/downsample.js';
import { ExprError, evaluate, exprPaths, parseExpr } from '../data/expr.js';
import type { SeriesSource } from '../data/panelData.js';
import type { SeriesQuery } from '../data/reader.js';
import type { SeriesPayload } from '../workers/protocol.js';
import type { LogAnalysis } from './analyze.js';

export const LOG_PREFIX = 'logs.';

export function isLogPath(path: string): boolean {
  return path.startsWith(LOG_PREFIX);
}

/** Classify an expression: entirely log paths, entirely not, or an unsupported mixture. */
export function logExpressionKind(expression: string): 'logs' | 'metrics' | 'mixed' {
  let paths: string[];
  try {
    paths = exprPaths(parseExpr(expression));
  } catch {
    return 'metrics';
  }
  const logs = paths.filter(isLogPath).length;
  if (logs === 0) return 'metrics';
  return logs === paths.length ? 'logs' : 'mixed';
}

function evaluateLog(
  expression: string,
  analysis: LogAnalysis,
  query: SeriesQuery,
): SeriesPayload {
  const expr = parseExpr(expression);
  const paths = [...new Set(exprPaths(expr))];

  const first = analysis.series[paths[0]!];
  if (first === undefined) throw new ExprError(`no log data for ${paths[0]!}`);

  // Every class shares one bucket grid, built over the log's whole span, so no alignment is
  // needed between them -- only a window trim.
  const from = query.from ?? -Infinity;
  const to = query.to ?? Infinity;
  let lo = 0;
  let hi = first.t.length;
  while (lo < hi && first.t[lo]! < from) lo++;
  while (hi > lo && first.t[hi - 1]! > to) hi--;

  const t = first.t.subarray(lo, hi);
  const raw = new Map<string, Float64Array>();
  for (const path of paths) {
    const series = analysis.series[path];
    if (series === undefined) throw new ExprError(`no log data for ${path}`);
    raw.set(path, series.v.subarray(lo, hi));
  }

  const values = evaluate(expr, t, raw);
  const out = envelope(expression, t, values, query.maxPoints ?? 0);
  return { path: expression, t: out.t, min: out.min, max: out.max, mean: out.mean, raw: out.raw };
}

/**
 * Wrap a series source so `logs.*` expressions resolve from parsed logs.
 *
 * `logsOf` is a lookup rather than a value because logs arrive after a capture does -- a log
 * dropped ten minutes into an investigation has to light up the panels already on screen.
 */
export function withLogs(
  base: SeriesSource,
  logsOf: (captureId: string) => LogAnalysis | undefined,
): SeriesSource {
  return {
    async series(captureId, expressions, query): Promise<SeriesPayload[]> {
      const analysis = logsOf(captureId);
      const fromLogs = new Map<string, SeriesPayload>();
      const delegate: string[] = [];

      for (const expression of expressions) {
        const kind = logExpressionKind(expression);
        if (kind === 'metrics') {
          delegate.push(expression);
          continue;
        }
        if (kind === 'mixed') {
          throw new ExprError(
            `${expression}: a log series and a metric cannot be combined in one expression -- ` +
              'they are sampled on different clocks. Put them on the same panel instead.',
          );
        }
        if (analysis === undefined) {
          throw new ExprError(`no logs loaded for this node -- drop its mongod.log alongside`);
        }
        fromLogs.set(expression, evaluateLog(expression, analysis, query));
      }

      const answered = delegate.length > 0 ? await base.series(captureId, delegate, query) : [];
      const byExpression = new Map(delegate.map((e, i) => [e, answered[i]!]));

      // Order has to match the request: fetchPanelData pairs answers with requests positionally.
      return expressions.map((e) => fromLogs.get(e) ?? byExpression.get(e)!);
    },
  };
}
