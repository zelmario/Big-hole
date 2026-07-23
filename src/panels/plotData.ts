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
