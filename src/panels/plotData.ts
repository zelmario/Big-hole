/**
 * Turning a series into the columns uPlot draws.
 *
 * `null` is uPlot's gap marker, not `NaN`. This is not a stylistic detail: a series whose
 * FIRST value is NaN comes back with `series.min === NaN`, which makes the shared y scale NaN,
 * which draws no line and no axis at all -- for every series in the panel, not just that one.
 * Verified directly in Chromium against the bundled uPlot:
 *
 *   [10, 20, 30, 40]   -> min 10, max 40      (y 7..43)
 *   [NaN, 20, 30, 40]  -> min NaN, max NaN    (y NaN..NaN, panel draws nothing)
 *   [10, NaN, 30, 40]  -> min 10, max 40      (fine)
 *   [null, 20, 30, 40] -> min 20, max 40      (correct)
 *
 * The storage layer uses NaN throughout, deliberately -- it is a Float64Array and a gap has to
 * be representable inside one. So the conversion belongs here, at the boundary, and has to be
 * applied to every column handed to uPlot.
 *
 * The bug is easy to miss because it depends on where the bucket boundaries fall: the same
 * panel drew fine tiled and blank maximized, because the wider plot asked for more buckets and
 * the capture's first sample -- a gap on that metric -- stopped being averaged in with its
 * neighbour.
 */

/** One uPlot column: gaps as null, everything else unchanged. */
export function plotColumn(values: Float64Array): Array<number | null> {
  const out = new Array<number | null>(values.length);
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    out[i] = Number.isNaN(v) ? null : v;
  }
  return out;
}

/** The x column: epoch ms to the seconds uPlot's time axis expects. */
export function timeColumn(ms: Float64Array): number[] {
  const out = new Array<number>(ms.length);
  for (let i = 0; i < ms.length; i++) out[i] = ms[i]! / 1000;
  return out;
}

/**
 * Trim a legend label to what distinguishes it.
 *
 * Full paths are unreadable at panel width -- `rate(common.serverStatus.opcounters.query)` is
 * mostly prefix shared with every other series in the panel. The role prefix and section are
 * dropped for display; the full expression stays in the tooltip and in the panel definition.
 */
export function legendLabel(expression: string): string {
  return collapseSums(expression)
    .replace(/\b(common|shard|router|configsvr)\./g, '')
    .replace(/\bserverStatus\./g, '')
    .replace(/\bsystemMetrics\./g, 'sys.')
    .replace(/\breplSetGetStatus\./g, 'rs.')
    .replace(/\blocal\.oplog\.rs\.stats\./g, 'oplog.');
}

/**
 * Shorten a wide `sum(...)` to `sum(…)`.
 *
 * CPU usage is a percentage of a seven-term total, so each of its three series carries the
 * same 300-character denominator. Left alone the legend shows three rows that are identical
 * for the first 30 characters and then run out of width -- the one part that distinguishes
 * them, which is the numerator, sits at the front but the row reads as noise. The full
 * expression stays in the row's tooltip and in the panel definition.
 */
function collapseSums(expression: string): string {
  let out = '';
  let i = 0;
  while (i < expression.length) {
    const at = expression.indexOf('sum(', i);
    if (at < 0) {
      out += expression.slice(i);
      break;
    }
    // Find this sum's matching close paren, and count its top-level arguments.
    let depth = 0;
    let commas = 0;
    let end = at + 3;
    for (; end < expression.length; end++) {
      const ch = expression[end]!;
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) break;
      } else if (ch === ',' && depth === 1) commas++;
    }
    if (end >= expression.length) {
      out += expression.slice(i); // unbalanced: leave it alone
      break;
    }
    out += expression.slice(i, at);
    out += commas >= 2 ? 'sum(…)' : expression.slice(at, end + 1);
    i = end + 1;
  }
  return out;
}
