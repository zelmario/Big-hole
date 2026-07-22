/**
 * Downsampling for rendering.
 *
 * Min/max envelope per bucket, NOT LTTB. For diagnostic data LTTB is actively dangerous: a
 * two-second drop of `wiredTiger.concurrentTransactions.read.available` to zero *is* the
 * finding, and LTTB discards it as visually insignificant. An envelope cannot hide a spike or
 * a dropout, which is the only property that matters here (PLAN.md §2.4).
 *
 * Full resolution is never destroyed -- it stays in columns.bin and is re-read on zoom.
 */

import type { Series } from './types.js';

/**
 * Reduce samples to at most `maxPoints` buckets, keeping each bucket's extremes.
 *
 * NaN marks a gap (a metric absent from a chunk, or a hole in the capture). Buckets ignore
 * NaNs; a bucket that is entirely NaN stays NaN so the gap survives to the chart, which must
 * render it as a break rather than interpolating across it.
 */
export function envelope(
  path: string,
  t: Float64Array,
  v: Float64Array,
  maxPoints: number,
): Series {
  const n = t.length;

  if (n <= maxPoints || maxPoints <= 0) {
    return { path, t, min: v, max: v, mean: v, raw: true };
  }

  const buckets = maxPoints;
  const outT = new Float64Array(buckets);
  const outMin = new Float64Array(buckets);
  const outMax = new Float64Array(buckets);
  const outMean = new Float64Array(buckets);

  for (let b = 0; b < buckets; b++) {
    const start = Math.floor((b * n) / buckets);
    const end = Math.min(n, Math.floor(((b + 1) * n) / buckets));

    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    let sum = 0;
    let count = 0;

    for (let i = start; i < end; i++) {
      const x = v[i]!;
      if (Number.isNaN(x)) continue;
      if (x < lo) lo = x;
      if (x > hi) hi = x;
      sum += x;
      count++;
    }

    // Bucket time is the midpoint of the samples it covers, not of the time range: with an
    // irregular clock those differ, and the former is what actually has data behind it.
    outT[b] = t[Math.min(n - 1, (start + end) >> 1)]!;

    if (count === 0) {
      outMin[b] = NaN;
      outMax[b] = NaN;
      outMean[b] = NaN;
    } else {
      outMin[b] = lo;
      outMax[b] = hi;
      outMean[b] = sum / count;
    }
  }

  return { path, t: outT, min: outMin, max: outMax, mean: outMean, raw: false };
}
