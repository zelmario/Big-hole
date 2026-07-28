/**
 * "Explain this window": brush a spike, get the metrics that moved and the log lines that
 * landed inside it.
 *
 * The detectors (detect.ts) answer "was anything wrong" from a fixed list of pathologies. This
 * answers the question that follows and cannot be listed in advance -- *why this*, at *this*
 * moment -- by comparing the window against the stretch of capture immediately before it and
 * ranking every metric by how much it moved. A capture has 5,763 of them; the whole value is in
 * the ordering, because an unranked list of 5,763 changes is the same as no answer.
 *
 * Three decisions carry the ranking:
 *
 * **The baseline is the adjacent window, not the whole capture.** "Compared to normal" sounds
 * better and is worse: a 42-hour capture usually contains several different normals, and
 * averaging over them makes every busy hour look anomalous. The question an engineer actually
 * asks at a spike is what changed *going into it*. It is also what keeps the cost bounded --
 * the scan reads full resolution, so a whole-capture baseline would read the whole capture.
 *
 * **Counters are compared as rates.** Most of FTDC is cumulative, and a cumulative counter's
 * mean is always higher in the later window; ranking on levels would put every counter in the
 * capture above every real finding. A column that never goes backwards across either window is
 * read as a counter and compared per second. The failure mode is stated rather than hidden: a
 * level metric that happens to rise monotonically through both windows is reported as a rate,
 * which is visible in the row and harmless -- the direction is still right.
 *
 * **Score = deviation x share of the metric's own range.** Deviation alone (a z-score against
 * baseline variability) ranks a metric that normally never moves above one that moved through
 * most of its whole-capture range, which is how anomaly detectors end up reporting thermal
 * noise. Share alone ignores whether the move is unusual for that metric. The product asks both
 * questions, and both factors are computable from what the scan already collected.
 */

import { EMPTY_STATS, type WindowStats } from '../data/scan.js';
import type { LogEvent } from '../logs/analyze.js';

/** One metric's behaviour in the window, against the baseline. */
export interface Change {
  readonly path: string;
  /**
   * `rate` when the column only ever increased, so the comparison is per second; `level` when
   * the value itself is what moved.
   */
  readonly kind: 'level' | 'rate';
  readonly base: number;
  readonly window: number;
  /** Multiples of the baseline's own variability. */
  readonly z: number;
  /** Share of the metric's whole-capture range that the move covers, 0..1. */
  readonly rel: number;
  readonly score: number;
}

export interface ChangeInput {
  readonly path: string;
  readonly base: WindowStats;
  readonly win: WindowStats;
  /** Whole-capture range of this metric, in the same units as the stats. */
  readonly range: number;
  /**
   * Whole-capture average rate -- the metric's range spread over the capture's duration.
   *
   * A rate needs a scale that does not come from the two numbers being compared. Using the
   * larger of them makes every counter that was idle and then moved score identically, whether
   * it went to 0.001/s or to 1.6M/s: the comparison normalises itself away, and the ranking
   * degenerates into insertion order. Measured against what the counter averages over the whole
   * capture, "0 -> 1.6M/s" is a burst and "0 -> 0.001/s" is a metric that ticked once.
   */
  readonly rateScale: number;
}

export interface RankOptions {
  readonly limit?: number;
  readonly minScore?: number;
}

/**
 * Floor under the noise term, as a share of the metric's own range.
 *
 * A baseline that never moved has zero variability, and dividing by it makes every such metric
 * infinitely significant -- including the large fraction of FTDC that is structurally flat.
 * Five percent of the metric's whole-capture range is a scale-free stand-in for "how much this
 * metric moving is worth noticing at all".
 */
const NOISE_FLOOR = 0.05;

const DEFAULT_LIMIT = 40;

/** Ceiling on the deviation term. See `reading` for why it has to exist. */
const Z_CAP = 200;

/**
 * Deliberately not zero. Everything wiggles; a window that reported every metric whose mean
 * differed would be a list of five thousand rows, which is the failure this exists to avoid.
 */
const DEFAULT_MIN_SCORE = 1;

/**
 * Share of a window's samples that must actually move for it to be read as a rate.
 *
 * One in twenty is low on purpose: a counter that increments every twenty seconds -- a slow
 * query arriving, a page being forced out -- is a real rate and losing it would be worse than
 * the noise it admits. What it excludes is the far larger class that moved once or twice.
 */
const MIN_ACTIVE = 0.05;

/** True when a window ticked often enough for its rate to mean anything. */
function sustained(s: WindowStats): boolean {
  return s.dn > 0 && s.dChanges >= 3 && s.dChanges / s.dn >= MIN_ACTIVE;
}

/**
 * Compare one metric across the two windows.
 *
 * Returns null when there is nothing to compare (the metric is absent from a window, or never
 * moved anywhere in the capture) or when the move is too small to report.
 */
export function compare(input: ChangeInput, minScore: number): Change | null {
  const { base, win, range, rateScale, path } = input;
  if (base.n === 0 || win.n === 0) return null;

  /** One way of reading the same pair of windows, scored. */
  const reading = (
    kind: 'level' | 'rate',
    a: number,
    b: number,
    sd: number,
    scale: number,
  ): Change | null => {
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    const delta = Math.abs(b - a);
    if (delta === 0) return null;
    if (!Number.isFinite(scale) || scale <= 0) return null;
    // Capped: past a couple of hundred noise units the difference between "unprecedented" and
    // "even more unprecedented" is not information, and uncapped it lets an arbitrarily quiet
    // metric -- one whose whole-capture average is near zero -- outrank every large change on
    // the node purely by being quiet.
    const z = Math.min(Z_CAP, delta / ((Number.isFinite(sd) ? sd : 0) + NOISE_FLOOR * scale));
    const rel = Math.min(1, delta / scale);
    return { path, kind, base: a, window: b, z, rel, score: z * rel };
  };

  const level = reading('level', base.mean, win.mean, base.sd, range);

  // A column that never goes backwards in either window is cumulative, so it can also be read
  // as a rate -- but only if it actually ticked. Without the sustain test the top of every
  // ranking is metrics that stepped once: dividing a single increment by the window produces a
  // "rate" hundreds of times the metric's own capture-wide average, so the list fills with
  // 0/s -> 0.00/s rows and buries the eviction storm underneath them. Measured on the 67.7 h 7.0.34 dirty-cache capture.
  const counter =
    base.dn > 0 &&
    win.dn > 0 &&
    base.rateMin >= 0 &&
    win.rateMin >= 0 &&
    (sustained(win) || sustained(base));
  const rate = counter ? reading('rate', base.rate, win.rate, base.rateSd, rateScale) : null;

  // Both readings are legitimate for a rising column -- opcounters is only meaningful as a
  // rate, a gauge that started climbing is meaningful either way -- so take whichever is the
  // more unusual against that metric's own history, rather than guessing from the name.
  const best =
    rate === null ? level : level === null ? rate : rate.score >= level.score ? rate : level;

  return best !== null && best.score >= minScore ? best : null;
}

/** Every metric that moved, biggest change first. */
export function rankChanges(inputs: Iterable<ChangeInput>, options: RankOptions = {}): Change[] {
  const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
  const out: Change[] = [];
  for (const input of inputs) {
    const change = compare(input, minScore);
    if (change !== null) out.push(change);
  }
  out.sort((x, y) => y.score - x.score);
  return out.slice(0, options.limit ?? DEFAULT_LIMIT);
}

/**
 * Pair the two scans up by path. A metric missing from one side is simply not comparable.
 *
 * `spanMs` is the capture's own duration, which is what turns each metric's range into the
 * average rate a burst is judged against.
 */
export function changeInputs(
  base: ReadonlyMap<string, WindowStats>,
  win: ReadonlyMap<string, WindowStats>,
  rangeOf: (path: string) => number,
  spanMs: number,
): ChangeInput[] {
  const seconds = Math.max(1, spanMs / 1000);
  const out: ChangeInput[] = [];
  for (const [path, w] of win) {
    const range = rangeOf(path);
    out.push({
      path,
      base: base.get(path) ?? EMPTY_STATS,
      win: w,
      range,
      rateScale: range / seconds,
    });
  }
  return out;
}

export interface Window {
  readonly fromMs: number;
  readonly toMs: number;
}

/**
 * Widest window a scan will read, in samples.
 *
 * The scan reads full resolution -- roughly 10 KB of stored bytes per sample on a real 5,763
 * metric capture -- so this is about 200 MB per window and a second of work. It is deliberately
 * a refusal rather than a silent downsample: an explanation computed off an envelope would
 * quietly stop seeing the short excursions that are the reason to ask.
 *
 * 20,000 samples is 5.5 hours at a 1 s cadence, which is far wider than any spike worth
 * brushing.
 */
export const MAX_SCAN_SAMPLES = 20_000;

/** One ranked change, tagged with the node it was found on. */
export interface HostChange extends Change {
  readonly captureId: string;
  readonly captureLabel: string;
}

/** One annotated log line inside the window. */
export interface WindowEvent extends LogEvent {
  readonly captureId: string;
  readonly captureLabel: string;
}

/** Everything the window explanation shows. */
export interface Explanation {
  readonly window: Window;
  readonly baseline: Window | null;
  readonly changes: HostChange[];
  readonly events: WindowEvent[];
  /** Annotated lines inside the window beyond the ones listed. */
  readonly moreEvents: number;
  /** Metrics the ranking chose from, across every node. */
  readonly compared: number;
  /** Per-node failures -- a node that could not be scanned is not a node with no changes. */
  readonly errors: string[];
}

/**
 * The stretch to compare against: the same duration immediately before the window.
 *
 * Falls back to the same duration immediately *after* when the window sits at the very start of
 * the capture -- brushing the first spike in a bundle is common, and "no baseline" would be a
 * useless answer to it. A shorter baseline than asked for is fine (the statistics are per
 * sample, not per window), but too short a one compares against noise, so below a quarter of
 * the window it is refused and the caller says so.
 */
export function baselineFor(window: Window, capture: Window): Window | null {
  const width = window.toMs - window.fromMs;
  if (width <= 0) return null;
  const least = width / 4;

  const beforeMs = window.fromMs - capture.fromMs;
  if (beforeMs >= least) {
    return { fromMs: Math.max(capture.fromMs, window.fromMs - width), toMs: window.fromMs - 1 };
  }

  const afterMs = capture.toMs - window.toMs;
  if (afterMs >= least) {
    return { fromMs: window.toMs + 1, toMs: Math.min(capture.toMs, window.toMs + width) };
  }

  return null;
}
