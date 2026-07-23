/**
 * A log file becomes two things: a few markers, and some series.
 *
 * Nothing keeps the raw lines, and nothing keeps a line-indexed array of them either. Real
 * support bundles carry `mongo_log_36h.log` at **2.58 GB**; materialising that as JS strings is
 * an out-of-memory crash, not a slow parse. So this is an incremental accumulator: push a line,
 * keep what matters, drop the line. The same rule the storage layer follows for metrics --
 * resident memory is a function of what is on screen, not of capture size.
 *
 * Three things are bounded explicitly, because "the log is bigger than you expected" must
 * degrade the result rather than kill the tab:
 *
 *   events     -- capped per class, and a class that exceeds the cap is demoted to a rate.
 *   buckets    -- the grid coarsens itself as the log turns out to be longer, so a month-long
 *                 log costs the same as an hour-long one.
 *   durations  -- p95 comes from a bounded sample per bucket; the max is tracked exactly,
 *                 because the worst slow query is a fact and an estimate of it is not.
 */

import { classify, ANNOTATION_LIMIT, RULES, type Rule } from './classify.js';
import { attrOf, durationOf, emptyStats, parseLine, type LogLine, type ParseStats } from './parse.js';

export interface LogEvent {
  readonly tMs: number;
  readonly kind: string;
  readonly label: string;
  readonly severity: string;
  readonly message: string;
  /** The one attribute worth showing inline -- a sync source, an error string, a duration. */
  readonly detail: string;
}

export interface LogSeries {
  /** Bucket start times, epoch ms. */
  readonly t: Float64Array;
  readonly v: Float64Array;
}

export interface LogAnalysis {
  readonly events: LogEvent[];
  /** Pseudo-metric path -> series, e.g. `logs.slowQuery.count`. */
  readonly series: Record<string, LogSeries>;
  readonly stats: ParseStats & {
    readonly firstMs: number;
    readonly lastMs: number;
    /** Final bucket width; larger than the requested one if the log turned out to be long. */
    readonly bucketMs: number;
    /** Classes that fired too often to draw, with their counts. */
    readonly demoted: Array<{ kind: string; count: number }>;
    /** Total events matched per class, drawn or not. */
    readonly counts: Record<string, number>;
  };
}

/** Bucket width to start from. 10 s is finer than FTDC's 1 s clock needs. */
export const DEFAULT_BUCKET_MS = 10_000;

/**
 * Buckets past which the grid doubles.
 *
 * 8,640 buckets is a day at 10 s. A 36-hour log coarsens once, a week coarsens four times, and
 * the arrays stay small enough to hand to a chart without thinking about it.
 */
export const MAX_BUCKETS = 8_640;

/** Durations kept per bucket for the p95 estimate. The max is tracked separately and exactly. */
export const DURATION_SAMPLES = 256;

/**
 * The attribute worth putting on a marker, chosen per class rather than dumped wholesale.
 *
 * Takes the raw line because this is the only place the full document is parsed -- a few
 * hundred times per log, rather than once per line.
 */
function detailOf(raw: string, line: LogLine): string {
  const attr = attrOf(raw);
  if (attr === undefined) return '';
  for (const key of ['syncSource', 'error', 'errmsg', 'newState', 'oldState', 'target', 'namespace', 'ns']) {
    const value = attr[key];
    if (typeof value === 'string') return `${key}: ${value}`;
    if (value !== null && typeof value === 'object') {
      const nested = (value as Record<string, unknown>)['errmsg'];
      if (typeof nested === 'string') return `${key}: ${nested}`;
    }
  }
  const ms = durationOf(raw);
  return ms === null ? '' : `${ms} ms`;
}

/** Per-class accumulator: a count per bucket, and a bounded duration sample per bucket. */
class Buckets {
  readonly counts = new Map<number, number>();
  readonly samples = new Map<number, number[]>();
  readonly maxima = new Map<number, number>();
  private durations = false;

  add(bucket: number, ms: number | null): void {
    this.counts.set(bucket, (this.counts.get(bucket) ?? 0) + 1);
    if (ms === null) return;
    this.durations = true;

    const prior = this.maxima.get(bucket);
    if (prior === undefined || ms > prior) this.maxima.set(bucket, ms);

    let list = this.samples.get(bucket);
    if (list === undefined) {
      list = [];
      this.samples.set(bucket, list);
    }
    // Bounded: after the cap, replace at random so the sample stays representative of the
    // whole bucket rather than of its first quarter-second.
    if (list.length < DURATION_SAMPLES) list.push(ms);
    else list[(list.length * Math.abs(Math.sin(ms))) | 0] = ms;
  }

  get hasDurations(): boolean {
    return this.durations;
  }

  /** Merge every pair of adjacent buckets, halving the resolution. */
  coarsen(): void {
    const merge = <T>(from: Map<number, T>, combine: (a: T, b: T) => T): Map<number, T> => {
      const to = new Map<number, T>();
      for (const [bucket, value] of from) {
        const half = bucket >> 1;
        const seen = to.get(half);
        to.set(half, seen === undefined ? value : combine(seen, value));
      }
      return to;
    };

    const counts = merge(this.counts, (a, b) => a + b);
    this.counts.clear();
    for (const [k, v] of counts) this.counts.set(k, v);

    const maxima = merge(this.maxima, (a, b) => Math.max(a, b));
    this.maxima.clear();
    for (const [k, v] of maxima) this.maxima.set(k, v);

    const samples = merge(this.samples, (a, b) => [...a, ...b].slice(0, DURATION_SAMPLES));
    this.samples.clear();
    for (const [k, v] of samples) this.samples.set(k, v);
  }

  /** Per-second rate, so the value does not change meaning when the grid coarsens. */
  rate(first: number, last: number, bucketMs: number): LogSeries {
    return this.flatten(first, last, bucketMs, (b) => (this.counts.get(b) ?? 0) / (bucketMs / 1000));
  }

  p95(first: number, last: number, bucketMs: number): LogSeries {
    return this.flatten(first, last, bucketMs, (b) => {
      const list = this.samples.get(b);
      if (list === undefined || list.length === 0) return NaN;
      const sorted = [...list].sort((a, c) => a - c);
      return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!;
    });
  }

  max(first: number, last: number, bucketMs: number): LogSeries {
    return this.flatten(first, last, bucketMs, (b) => this.maxima.get(b) ?? NaN);
  }

  private flatten(
    first: number,
    last: number,
    bucketMs: number,
    value: (bucket: number) => number,
  ): LogSeries {
    const n = Math.max(1, last - first + 1);
    const t = new Float64Array(n);
    const v = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      t[i] = (first + i) * bucketMs;
      v[i] = value(first + i);
    }
    return { t, v };
  }
}

export interface AnalyzeOptions {
  readonly bucketMs?: number;
  readonly annotationLimit?: number;
  readonly maxBuckets?: number;
}

/**
 * Streaming log analyzer.
 *
 * Push lines as they arrive from disk and never hold them. A 2.58 GB log costs a few megabytes
 * here: the events (capped), one count per bucket per class, and a bounded duration sample.
 */
export class LogAnalyzer {
  private readonly stats = emptyStats();
  private readonly events: LogEvent[] = [];
  private readonly buckets = new Map<string, Buckets>();
  private readonly counts: Record<string, number> = {};
  private readonly demotedKinds = new Set<string>();

  private bucketMs: number;
  private readonly limit: number;
  private readonly maxBuckets: number;

  private firstBucket = Number.POSITIVE_INFINITY;
  private lastBucket = Number.NEGATIVE_INFINITY;
  private firstMs = Number.POSITIVE_INFINITY;
  private lastMs = Number.NEGATIVE_INFINITY;

  constructor(options: AnalyzeOptions = {}) {
    this.bucketMs = options.bucketMs ?? DEFAULT_BUCKET_MS;
    this.limit = options.annotationLimit ?? ANNOTATION_LIMIT;
    this.maxBuckets = options.maxBuckets ?? MAX_BUCKETS;
  }

  push(raw: string): void {
    const line = parseLine(raw, this.stats);
    if (line === null) return;

    if (line.tMs < this.firstMs) this.firstMs = line.tMs;
    if (line.tMs > this.lastMs) this.lastMs = line.tMs;

    const rule: Rule | null = classify(line);
    if (rule === null) {
      // Still worth extending the time span: a log made entirely of unclassified lines still
      // has a start and an end, and the grid has to cover it.
      this.track(Math.floor(line.tMs / this.bucketMs));
      return;
    }

    this.counts[rule.kind] = (this.counts[rule.kind] ?? 0) + 1;

    let bucketsFor = this.buckets.get(rule.kind);
    if (bucketsFor === undefined) {
      bucketsFor = new Buckets();
      this.buckets.set(rule.kind, bucketsFor);
    }
    this.track(Math.floor(line.tMs / this.bucketMs));
    // A regex over the line, not a parse of it: durationMillis is the one attribute a
    // high-volume class needs, and slow-query lines are the fattest in the file.
    bucketsFor.add(
      Math.floor(line.tMs / this.bucketMs),
      rule.kind === 'slowQuery' || rule.kind === 'appliedOp' || rule.kind === 'oplogTruncate'
        ? durationOf(raw)
        : null,
    );

    if (rule.mode !== 'annotate' || this.demotedKinds.has(rule.kind)) return;

    if ((this.counts[rule.kind] ?? 0) > this.limit) {
      // Too many to draw. Drop the ones already collected rather than keep an arbitrary
      // prefix, which would look like the event stopped happening.
      this.demotedKinds.add(rule.kind);
      for (let i = this.events.length - 1; i >= 0; i--) {
        if (this.events[i]!.kind === rule.kind) this.events.splice(i, 1);
      }
      return;
    }

    this.events.push({
      tMs: line.tMs,
      kind: rule.kind,
      label: rule.label,
      severity: line.s,
      message: line.msg,
      detail: detailOf(raw, line),
    });
  }

  /** Extend the covered span, coarsening the grid if it has grown past the cap. */
  private track(bucket: number): void {
    if (bucket < this.firstBucket) this.firstBucket = bucket;
    if (bucket > this.lastBucket) this.lastBucket = bucket;

    while (this.lastBucket - this.firstBucket + 1 > this.maxBuckets) {
      for (const b of this.buckets.values()) b.coarsen();
      this.firstBucket >>= 1;
      this.lastBucket >>= 1;
      this.bucketMs *= 2;
    }
  }

  finish(): LogAnalysis {
    const series: Record<string, LogSeries> = {};
    if (Number.isFinite(this.firstBucket)) {
      for (const [kind, b] of this.buckets) {
        series[`logs.${kind}.count`] = b.rate(this.firstBucket, this.lastBucket, this.bucketMs);
        if (b.hasDurations) {
          series[`logs.${kind}.p95Ms`] = b.p95(this.firstBucket, this.lastBucket, this.bucketMs);
          series[`logs.${kind}.maxMs`] = b.max(this.firstBucket, this.lastBucket, this.bucketMs);
        }
      }
    }

    this.events.sort((a, b) => a.tMs - b.tMs);

    return {
      events: this.events,
      series,
      stats: {
        ...this.stats,
        firstMs: Number.isFinite(this.firstMs) ? this.firstMs : 0,
        lastMs: Number.isFinite(this.lastMs) ? this.lastMs : 0,
        bucketMs: this.bucketMs,
        demoted: [...this.demotedKinds].map((kind) => ({ kind, count: this.counts[kind] ?? 0 })),
        counts: this.counts,
      },
    };
  }
}

/** Convenience for tests and tooling; the worker streams into LogAnalyzer directly. */
export function analyzeLines(lines: Iterable<string>, options: AnalyzeOptions = {}): LogAnalysis {
  const analyzer = new LogAnalyzer(options);
  for (const line of lines) analyzer.push(line);
  return analyzer.finish();
}

/** Every pseudo-metric a set of classes exposes, for the catalogue. */
export function logMetricPaths(analysis: LogAnalysis): string[] {
  return Object.keys(analysis.series).sort();
}

/** Label for a log pseudo-metric, for the legend. */
export function logMetricLabel(path: string): string {
  const kind = path.split('.')[1] ?? '';
  const rule = RULES.find((r) => r.kind === kind);
  const stat = path.endsWith('.p95Ms') ? ' p95' : path.endsWith('.maxMs') ? ' max' : '/s';
  return `${rule?.label ?? kind}${stat}`;
}
