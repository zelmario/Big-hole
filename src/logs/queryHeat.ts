/**
 * Which query shapes stand out.
 *
 * Load is how much time the shape consumed, on a fixed scale: a fraction of a second is green,
 * a second is amber, and several seconds is red. Sorting by load is still share of time — the
 * Percona PMM and Datadog order — but the color is not "how you compare with the worst row".
 * A 14 second shape stays red when another shape took longer.
 *
 * Severity is each call, on that same scale: how long it took, how many documents it read, how
 * many it read per document returned, and whether it was a collection scan. Total time is left
 * out, so a popular indexed query can be red on load and green on severity.
 */

export type Heat = 'ok' | 'warm' | 'hot';

export interface HeatInput {
  readonly count: number;
  readonly totalMs: number;
  readonly maxMs: number;
  readonly docsExamined: number;
  readonly returned: number;
  /**
   * Set false when the operation has no document yield to compare with documents examined.
   * Absent means the ratio applies, which is the case for a find.
   */
  readonly yields?: boolean;
}

interface Cut {
  /** Values at or below this are the bulk of the log and stay quiet. */
  readonly floor: number;
  /** 75th percentile. Above the floor and at this line, the number is high. */
  readonly mid: number;
  /** 90th percentile. At this line, the number is among the worst. */
  readonly high: number;
}

export interface HeatScale {
  readonly avg: Cut | null;
  readonly max: Cut | null;
  readonly total: Cut | null;
  readonly docs: Cut | null;
  readonly ratio: Cut | null;
}

export interface RowHeat {
  readonly avg: Heat;
  readonly max: Heat;
  readonly total: Heat;
  readonly docs: Heat;
  /** Examined per document returned. `ok` when the query gave back about what it read. */
  readonly ratio: Heat;
  /** The strongest of the above. Drives the row's edge. */
  readonly row: Heat;
}

export function avgMs(row: HeatInput): number {
  return row.count > 0 ? row.totalMs / row.count : 0;
}

export function docsPerCall(row: HeatInput): number {
  return row.count > 0 ? row.docsExamined / row.count : 0;
}

/**
 * Documents read per document returned.
 *
 * Infinite when a read examined documents and returned none. A count, or a write that did not
 * report how many documents it affected, has no yield: that is not the same as returning none.
 */
export function examineRatio(row: HeatInput): number {
  if (row.yields === false) return 0;
  if (row.docsExamined <= 0) return 0;
  if (row.returned <= 0) return Number.POSITIVE_INFINITY;
  return row.docsExamined / row.returned;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 1) return sorted[0]!;
  const index = p * (sorted.length - 1);
  const lo = Math.floor(index);
  const hi = Math.ceil(index);
  const a = sorted[lo]!;
  const b = sorted[hi]!;
  return a + (b - a) * (index - lo);
}

/** 75th and 90th percentile above the median, or null when the values do not spread. */
function cutOf(values: readonly number[]): Cut | null {
  const usable = values.filter((value) => value > 0 && Number.isFinite(value));
  if (usable.length < 2) return null;
  const sorted = [...usable].sort((a, b) => a - b);
  const floor = percentile(sorted, 0.5);
  const mid = percentile(sorted, 0.75);
  const high = percentile(sorted, 0.9);
  // A flat log — nine identical queries and nothing else — has no ranking to show.
  if (!(high > floor)) return null;
  return { floor, mid, high };
}

export function heatScale(rows: readonly HeatInput[]): HeatScale {
  return {
    avg: cutOf(rows.map(avgMs)),
    max: cutOf(rows.map((row) => row.maxMs)),
    total: cutOf(rows.map((row) => row.totalMs)),
    docs: cutOf(rows.map(docsPerCall)),
    ratio: cutOf(rows.map(examineRatio)),
  };
}

export function heatOf(value: number, cut: Cut | null): Heat {
  if (cut === null || !(value > cut.floor)) return 'ok';
  if (value >= cut.high) return 'hot';
  if (value >= cut.mid) return 'warm';
  return 'ok';
}

const RANK: Record<Heat, number> = { ok: 0, warm: 1, hot: 2 };

function worst(heats: readonly Heat[]): Heat {
  return heats.reduce((best, heat) => (RANK[heat] > RANK[best] ? heat : best), 'ok');
}

export function rowHeat(row: HeatInput, scale: HeatScale): RowHeat {
  const avg = heatOf(avgMs(row), scale.avg);
  const max = heatOf(row.maxMs, scale.max);
  const total = heatOf(row.totalMs, scale.total);
  const ratio = heatOf(examineRatio(row), scale.ratio);
  const docs = worst([heatOf(docsPerCall(row), scale.docs), ratio]);
  return { avg, max, total, docs, ratio, row: worst([avg, max, total, docs]) };
}

/** Total time the shape used, summed across every call. The color is that total, on a log scale. */
export const LOAD_LABEL = 'load';

/** How bad each call was: latency, documents read, and a collection scan. */
export const SEVERITY_LABEL = 'severity';

/**
 * 0 is a short call, 1 is a few minutes.
 *
 * 100ms stays green, a second is amber, ten seconds is past amber, and a few minutes is red.
 * Logarithmic so one huge outlier cannot paint a 14 second call green.
 */
function durationScore(ms: number): number {
  if (!(ms > 0)) return 0;
  if (ms <= 100) return (ms / 100) * 0.22;
  const t = Math.min(1, Math.log10(ms / 100) / Math.log10(3_000));
  return 0.22 + t * 0.78;
}

/** 1:1 is fine. 10:1 is notable. 100:1 is red, and reading without returning anything is red. */
function ratioScore(ratio: number): number {
  if (!Number.isFinite(ratio)) return 1;
  if (ratio <= 1) return 0;
  return Math.min(1, Math.log10(ratio) / 3);
}

/** A hundred documents is quiet. Tens of thousands is not. */
function docsScore(docs: number): number {
  if (!(docs > 0)) return 0;
  if (docs <= 100) return (docs / 100) * 0.15;
  const t = Math.min(1, Math.log10(docs / 100) / 4);
  return 0.15 + t * 0.85;
}

/** A collection scan is never green. The badge stays the louder mark. */
const COLLSCAN_SCORE = 0.62;

/**
 * Load for each shape, from the time it consumed.
 *
 * The number is absolute. The heaviest shape is no longer red by definition, and a slow shape
 * is no longer green because something else consumed more.
 */
export function loadByRow<T extends HeatInput>(rows: readonly T[]): Map<T, number> {
  const out = new Map<T, number>();
  for (const row of rows) out.set(row, durationScore(row.totalMs));
  return out;
}

/**
 * Severity for each shape: the worst of how long a call took, how many documents it read,
 * how many it read per document returned, and a collection scan.
 *
 * The worst signal wins, so a 236 second call is red even when the other signals are milder.
 * Total time is absent: that is load.
 */
export function severityByRow<T extends SortableQuery>(rows: readonly T[]): Map<T, number> {
  const out = new Map<T, number>();
  for (const row of rows) {
    const ratio = examineRatio(row);
    const score = Math.max(
      durationScore(avgMs(row)),
      durationScore(row.maxMs),
      docsScore(docsPerCall(row)),
      ratioScore(ratio),
      row.collscan ? COLLSCAN_SCORE : 0,
    );
    out.set(row, score);
  }
  return out;
}

/** Green at 0, amber in the middle, red at 1. */
export function costColor(score: number): string {
  const green = [74, 168, 108];
  const amber = [242, 201, 76];
  const red = [235, 87, 87];
  const t = Math.min(1, Math.max(0, score));
  const [from, to, u] = t <= 0.5 ? [green, amber, t * 2] : [amber, red, (t - 0.5) * 2];
  const channel = (index: number) => Math.round(from[index]! + (to[index]! - from[index]!) * u);
  return `rgb(${channel(0)}, ${channel(1)}, ${channel(2)})`;
}

export type QuerySort = 'total' | 'avg' | 'max' | 'count' | 'docs' | 'collscan' | 'waste' | 'bulk';

export interface SortableQuery extends HeatInput {
  readonly collscan: boolean;
}

/** Descending, with non-finite values (a scan that returned nothing) sorting first. */
function cmpDesc(a: number, b: number): number {
  const aInf = !Number.isFinite(a);
  const bInf = !Number.isFinite(b);
  if (aInf || bInf) return aInf === bInf ? 0 : aInf ? -1 : 1;
  return b - a;
}

/** Examined and returned both large. A big scan that kept nothing scores nothing here. */
function bulkScore(row: HeatInput): number {
  if (row.docsExamined <= 0 || row.returned <= 0) return 0;
  return row.docsExamined * row.returned;
}

export function compareQueries(a: SortableQuery, b: SortableQuery, sort: QuerySort): number {
  switch (sort) {
    case 'collscan':
      return Number(b.collscan) - Number(a.collscan) || b.totalMs - a.totalMs;
    case 'waste':
      return cmpDesc(examineRatio(a), examineRatio(b)) || cmpDesc(a.docsExamined, b.docsExamined);
    case 'bulk':
      return cmpDesc(bulkScore(a), bulkScore(b)) || cmpDesc(a.returned, b.returned);
    case 'avg':
      return cmpDesc(avgMs(a), avgMs(b)) || b.totalMs - a.totalMs;
    case 'max':
      return b.maxMs - a.maxMs || b.totalMs - a.totalMs;
    case 'count':
      return b.count - a.count || b.totalMs - a.totalMs;
    case 'docs':
      return b.docsExamined - a.docsExamined || b.totalMs - a.totalMs;
    case 'total':
      return b.totalMs - a.totalMs || b.maxMs - a.maxMs;
  }
}
