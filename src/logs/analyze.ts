/**
 * A log file becomes two things: a few markers, and some series.
 *
 * Nothing keeps the raw lines. A support bundle's mongod.log is routinely 73 MB and can be
 * gigabytes; holding it resident would break the same promise the storage layer keeps for
 * metrics (resident memory is a function of what is on screen, not of capture size). What
 * survives a pass is bounded by construction: at most a few hundred annotations, plus fixed
 * buckets of counts.
 *
 * Slow queries are the case that justifies the design. There are 11,552 of them in one real
 * 24-hour log -- useless as markers, and exactly what you want as a rate next to tickets and
 * cache, with p95 duration beside it.
 */

import { classify, ANNOTATION_LIMIT, RULES, type Rule } from './classify.js';
import { durationMs, emptyStats, parseLine, type LogLine, type ParseStats } from './parse.js';

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
    readonly bucketMs: number;
    /** Classes that fired too often to draw, with their counts. */
    readonly demoted: Array<{ kind: string; count: number }>;
    /** Total events matched per class, drawn or not. */
    readonly counts: Record<string, number>;
  };
}

/** Bucket width. 10 s is finer than FTDC's 1 s clock needs and keeps a week under 60k points. */
export const DEFAULT_BUCKET_MS = 10_000;

/** The attribute worth putting on a marker, chosen per class rather than dumped wholesale. */
function detailOf(line: LogLine): string {
  const attr = line.attr;
  if (attr === undefined) return '';
  for (const key of ['syncSource', 'error', 'errmsg', 'newState', 'oldState', 'target', 'namespace', 'ns']) {
    const value = attr[key];
    if (typeof value === 'string') return `${key}: ${value}`;
    if (value !== null && typeof value === 'object') {
      const nested = (value as Record<string, unknown>)['errmsg'];
      if (typeof nested === 'string') return `${key}: ${nested}`;
    }
  }
  const ms = durationMs(line);
  return ms === null ? '' : `${ms} ms`;
}

/**
 * A growing accumulator per class, bucketed on a fixed grid.
 *
 * Two passes are not possible on a stream, and the log's time span is not known up front, so
 * buckets are held in a map keyed by bucket index and flattened at the end.
 */
class Buckets {
  private readonly counts = new Map<number, number>();
  /** Durations per bucket, kept only for the classes that report one. */
  private readonly durations = new Map<number, number[]>();

  add(bucket: number, ms: number | null): void {
    this.counts.set(bucket, (this.counts.get(bucket) ?? 0) + 1);
    if (ms === null) return;
    const list = this.durations.get(bucket);
    if (list === undefined) this.durations.set(bucket, [ms]);
    else list.push(ms);
  }

  get hasDurations(): boolean {
    return this.durations.size > 0;
  }

  /** Per-second rate, so the value does not change meaning if the bucket width does. */
  rate(first: number, last: number, bucketMs: number): LogSeries {
    return this.flatten(first, last, bucketMs, (b) => (this.counts.get(b) ?? 0) / (bucketMs / 1000));
  }

  quantile(first: number, last: number, bucketMs: number, q: number): LogSeries {
    return this.flatten(first, last, bucketMs, (b) => {
      const list = this.durations.get(b);
      if (list === undefined || list.length === 0) return NaN;
      const sorted = [...list].sort((a, c) => a - c);
      return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]!;
    });
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
}

/**
 * Fold a stream of log lines into events and series.
 *
 * Takes an iterable of lines so the caller decides how the bytes arrive -- a worker streams a
 * 73 MB file in chunks, a test passes an array.
 */
export function analyzeLines(
  lines: Iterable<string>,
  options: AnalyzeOptions = {},
): LogAnalysis {
  const bucketMs = options.bucketMs ?? DEFAULT_BUCKET_MS;
  const limit = options.annotationLimit ?? ANNOTATION_LIMIT;

  const stats = emptyStats();
  const events: LogEvent[] = [];
  const buckets = new Map<string, Buckets>();
  const counts: Record<string, number> = {};
  const demotedKinds = new Set<string>();

  let firstBucket = Number.POSITIVE_INFINITY;
  let lastBucket = Number.NEGATIVE_INFINITY;
  let firstMs = Number.POSITIVE_INFINITY;
  let lastMs = Number.NEGATIVE_INFINITY;

  const bucketsFor = (kind: string): Buckets => {
    let b = buckets.get(kind);
    if (b === undefined) {
      b = new Buckets();
      buckets.set(kind, b);
    }
    return b;
  };

  for (const raw of lines) {
    const line = parseLine(raw, stats);
    if (line === null) continue;

    if (line.tMs < firstMs) firstMs = line.tMs;
    if (line.tMs > lastMs) lastMs = line.tMs;
    const bucket = Math.floor(line.tMs / bucketMs);
    if (bucket < firstBucket) firstBucket = bucket;
    if (bucket > lastBucket) lastBucket = bucket;

    const rule: Rule | null = classify(line);
    if (rule === null) continue;

    counts[rule.kind] = (counts[rule.kind] ?? 0) + 1;
    // Every matched class is counted, including the annotated ones: the rate is worth having
    // even when the markers are the point, and it is what a demoted class falls back to.
    bucketsFor(rule.kind).add(bucket, durationMs(line));

    if (rule.mode !== 'annotate' || demotedKinds.has(rule.kind)) continue;

    if ((counts[rule.kind] ?? 0) > limit) {
      // Too many to draw. Drop the ones already collected for this class rather than keep an
      // arbitrary prefix, which would look like the event stopped happening.
      demotedKinds.add(rule.kind);
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i]!.kind === rule.kind) events.splice(i, 1);
      }
      continue;
    }

    events.push({
      tMs: line.tMs,
      kind: rule.kind,
      label: rule.label,
      severity: line.s,
      message: line.msg,
      detail: detailOf(line),
    });
  }

  const series: Record<string, LogSeries> = {};
  if (Number.isFinite(firstBucket)) {
    for (const [kind, b] of buckets) {
      series[`logs.${kind}.count`] = b.rate(firstBucket, lastBucket, bucketMs);
      if (b.hasDurations) {
        series[`logs.${kind}.p95Ms`] = b.quantile(firstBucket, lastBucket, bucketMs, 0.95);
        series[`logs.${kind}.maxMs`] = b.quantile(firstBucket, lastBucket, bucketMs, 1);
      }
    }
  }

  events.sort((a, b) => a.tMs - b.tMs);

  return {
    events,
    series,
    stats: {
      ...stats,
      firstMs: Number.isFinite(firstMs) ? firstMs : 0,
      lastMs: Number.isFinite(lastMs) ? lastMs : 0,
      bucketMs,
      demoted: [...demotedKinds].map((kind) => ({ kind, count: counts[kind] ?? 0 })),
      counts,
    },
  };
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
