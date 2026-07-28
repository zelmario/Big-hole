/**
 * Windowed statistics over every metric at once.
 *
 * `getSeries` answers "what did this metric do". "Explain this window" asks the opposite
 * question -- *which* metrics did anything -- and there is no way to answer that one series at a
 * time: a real capture is 5,763 of them, so 5,763 round trips through the expression layer is
 * not a slow implementation, it is a different product.
 *
 * So a scan walks the stored bytes once and accumulates, per column, everything the ranking
 * needs and nothing it does not: enough to say how big the value was, how much it normally
 * moved, and whether it was a counter. One pass, one number set per column, no series
 * materialised.
 *
 * Two properties are worth stating because the ranking depends on them:
 *
 * **A NaN breaks the delta chain.** A metric absent from a chunk, or a stretch where the
 * collector stopped, must not contribute a delta spanning the hole -- that turns an FTDC outage
 * into an enormous apparent rate, on exactly the captures where the collector was struggling.
 * The same reasoning as `episodesOf` in the detectors.
 *
 * **A constant run costs O(1).** Constant-column elision means most columns of an idle capture
 * are a single stored value; the scan takes the same shortcut rather than expanding them, which
 * is what keeps the pass proportional to what actually moved.
 */

/** What one column did within one window. */
export interface WindowStats {
  /** Samples with a value. Zero means the metric is absent from this window entirely. */
  readonly n: number;
  readonly mean: number;
  /** Population standard deviation -- how much this metric normally moves. */
  readonly sd: number;
  readonly min: number;
  readonly max: number;
  readonly first: number;
  readonly last: number;
  readonly firstMs: number;
  readonly lastMs: number;
  /** Consecutive-sample deltas observed, i.e. how much of the window is joined up. */
  readonly dn: number;
  /**
   * Deltas that were not zero.
   *
   * The difference between a counter and a value that stepped once. Most of FTDC is
   * non-decreasing over a short window -- including plenty of gauges -- and a column that moved
   * twice in three thousand samples has a "rate" that is an artefact of dividing by the window,
   * not a rate anybody would recognise.
   */
  readonly dChanges: number;
  /** Mean change per second: the rate, for a column that turns out to be a counter. */
  readonly rate: number;
  readonly rateSd: number;
  /**
   * Smallest per-second change seen. `>= 0` means the column never went backwards, which is
   * how a cumulative counter is told from a level -- see `classify` in insights/explain.ts.
   */
  readonly rateMin: number;
}

export const EMPTY_STATS: WindowStats = {
  n: 0,
  mean: NaN,
  sd: NaN,
  min: NaN,
  max: NaN,
  first: NaN,
  last: NaN,
  firstMs: NaN,
  lastMs: NaN,
  dn: 0,
  dChanges: 0,
  rate: NaN,
  rateSd: NaN,
  rateMin: NaN,
};

/**
 * Streaming accumulator for one column.
 *
 * Welford rather than sum-of-squares, in both streams. WiredTiger timestamp columns are
 * `seconds << 32` (~7.7e18) and squaring those loses the variance entirely to cancellation --
 * the same 2^53 problem the decoder has to solve, arriving one layer later.
 *
 * Samples are pushed in time order and may arrive chunk by chunk; the delta chain carries
 * across a chunk boundary, because a column that is constant within each of two chunks has
 * still changed between them.
 */
export class SeriesScan {
  private count = 0;
  private m1 = 0;
  private m2 = 0;
  private lo = Number.POSITIVE_INFINITY;
  private hi = Number.NEGATIVE_INFINITY;
  private firstV = NaN;
  private lastV = NaN;
  private firstT = NaN;
  private lastT = NaN;

  private dCount = 0;
  private dMoved = 0;
  private dM1 = 0;
  private dM2 = 0;
  private dLo = Number.POSITIVE_INFINITY;

  private prevV = NaN;
  private prevT = NaN;

  /**
   * @param maxGapMs Deltas spanning longer than this are dropped rather than averaged over the
   * hole. Callers pass a few sample intervals; the default keeps every delta, which is what a
   * caller with no clock of its own wants.
   */
  constructor(private readonly maxGapMs: number = Number.POSITIVE_INFINITY) {}

  /** One sample. NaN is a hole: it is not a value, and it breaks the delta chain. */
  push(tMs: number, v: number): void {
    if (Number.isNaN(v)) {
      this.prevV = NaN;
      return;
    }
    this.delta(tMs, v);
    this.value(v, 1);
    if (this.count === 1) {
      this.firstV = v;
      this.firstT = tMs;
    }
    this.lastV = v;
    this.lastT = tMs;
    this.prevV = v;
    this.prevT = tMs;
  }

  /**
   * A run of `n` samples all holding `value` -- what an elided constant column stores.
   *
   * Equivalent to pushing each sample in turn, and the reason a scan of an idle capture costs
   * almost nothing. The interior deltas are all exactly zero, so they go in as a batch; only
   * the delta onto the previous chunk is real.
   */
  run(value: number, fromMs: number, toMs: number, n: number): void {
    if (n <= 0 || Number.isNaN(value)) {
      if (n > 0) this.prevV = NaN;
      return;
    }
    this.delta(fromMs, value);
    this.value(value, n);
    if (this.count === n) {
      this.firstV = value;
      this.firstT = fromMs;
    }
    this.lastV = value;
    this.lastT = toMs;
    if (n > 1) this.rateBatch(0, n - 1);
    this.prevV = value;
    this.prevT = toMs;
  }

  private value(v: number, k: number): void {
    const n = this.count + k;
    const d = v - this.m1;
    this.m1 += (d * k) / n;
    this.m2 += d * d * ((this.count * k) / n);
    this.count = n;
    if (v < this.lo) this.lo = v;
    if (v > this.hi) this.hi = v;
  }

  private delta(tMs: number, v: number): void {
    if (Number.isNaN(this.prevV)) return;
    const spanMs = tMs - this.prevT;
    if (spanMs <= 0 || spanMs > this.maxGapMs) return;
    this.rateBatch((v - this.prevV) / (spanMs / 1000), 1);
  }

  private rateBatch(r: number, k: number): void {
    const n = this.dCount + k;
    if (r !== 0) this.dMoved += k;
    const d = r - this.dM1;
    this.dM1 += (d * k) / n;
    this.dM2 += d * d * ((this.dCount * k) / n);
    this.dCount = n;
    if (r < this.dLo) this.dLo = r;
  }

  result(): WindowStats {
    if (this.count === 0) return EMPTY_STATS;
    return {
      n: this.count,
      mean: this.m1,
      sd: Math.sqrt(this.m2 / this.count),
      min: this.lo,
      max: this.hi,
      first: this.firstV,
      last: this.lastV,
      firstMs: this.firstT,
      lastMs: this.lastT,
      dn: this.dCount,
      dChanges: this.dMoved,
      rate: this.dCount === 0 ? NaN : this.dM1,
      rateSd: this.dCount === 0 ? NaN : Math.sqrt(this.dM2 / this.dCount),
      rateMin: this.dCount === 0 ? NaN : this.dLo,
    };
  }
}

/**
 * Stats for a series already in memory, over a time window.
 *
 * Used for the log-derived series (`logs.slowQuery.count` and friends), which never go through
 * the storage layer -- so they are ranked by the same code from the same numbers as everything
 * read off disk.
 */
export function statsOf(
  t: Float64Array | readonly number[],
  v: Float64Array | readonly number[],
  fromMs: number,
  toMs: number,
  maxGapMs?: number,
): WindowStats {
  const scan = new SeriesScan(maxGapMs);
  for (let i = 0; i < t.length; i++) {
    const time = t[i]!;
    if (time < fromMs || time > toMs) continue;
    scan.push(time, v[i]!);
  }
  return scan.result();
}
