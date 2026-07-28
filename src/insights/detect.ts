/**
 * Pathology detection: the questions an engineer asks of every capture, asked automatically.
 *
 * A dashboard answers "what did this metric do". It does not answer "was anything wrong",
 * and on a 44-panel dashboard over 42 hours that second question is answered by scrolling and
 * squinting. Every support engineer opening an FTDC bundle runs the same handful of checks
 * first -- did the ticket pool empty, did the cache go dirty, did the queues build -- and
 * those checks are mechanical. This runs them.
 *
 * Three properties matter more than the rule list, which will always be incomplete:
 *
 * **Detection is conservative under downsampling.** A finding is read off the min/max envelope,
 * not full resolution, because reading 42 hours of full-resolution data for a dozen rules would
 * cost more than the dashboard does. That is only sound if the envelope cannot manufacture a
 * finding, so each test reads the column that makes it pessimistic: `<= threshold` reads the
 * bucket's MAX -- the whole bucket must have stayed at or below -- and `>=` reads its MIN.
 * Downsampling can then hide a short episode, never invent one. A tool that cries wolf on a
 * healthy capture gets switched off, and then it catches nothing at all.
 *
 * **Nothing is keyed to a version.** Rules name metrics the way dashboard templates do and
 * resolve through the same `expandMetric`, so aliases and role prefixes apply and a rule
 * written against 6.0 fires on 8.0 where the metric was renamed. A rule that cannot resolve
 * produces no finding rather than a wrong one.
 *
 * **Episodes aggregate.** A saturating ticket pool flaps -- dozens of separate crossings in a
 * minute. Reporting each as its own finding buries the other rules, so all episodes of one rule
 * on one node collapse into a single finding carrying the count, the total time spent in the
 * state, and the worst single stretch to jump to.
 */

import { detectRolePrefixes, expandMetric } from '../dashboard/layout.js';
import type { Unit } from '../data/expr.js';
import type { SeriesQuery } from '../data/reader.js';
import type { SeriesPayload } from '../workers/protocol.js';

export type Severity = 'critical' | 'warning' | 'info';

/**
 * One pathology, as data.
 *
 * Deliberately declarative -- no predicates, no callbacks. Rules live in `rules.ts` and must
 * stay readable by someone who knows MongoDB and not this codebase, because that is who will
 * need to add the twentieth one.
 */
export interface Rule {
  readonly id: string;
  readonly title: string;
  readonly severity: Severity;
  /** Metric expression, written exactly as a dashboard template would write it. */
  readonly metric: string;
  readonly op: '<=' | '>=';
  readonly threshold: number;
  /** How long the condition must hold, in total, before it is worth reporting. */
  readonly sustainMs: number;
  /**
   * Recovery shorter than this does not end an episode.
   *
   * Real pathologies flap. WiredTiger's eviction pulls dirty cache back below its trigger within
   * seconds and lets it climb again; a ticket pool empties and refills. Measured on a capture
   * that spent 377 seconds above the 20% dirty trigger and peaked at 36%: the longest *unbroken*
   * stretch was 30 s, so a rule needing 60 s of unbroken breach reported nothing at all. Requiring
   * an unbroken run does not make a detector conservative, it makes it blind to the shape real
   * incidents have.
   *
   * The honesty is preserved elsewhere: `sustainMs` is compared against time actually spent in
   * breach, never against the bridged span, so tolerating a dip can extend an episode but can
   * never invent one. Omit for a condition that genuinely should be continuous.
   */
  readonly toleranceMs?: number;
  readonly unit: Unit;
  /** What it means, in one sentence. */
  readonly what: string;
  /** What to look at next. */
  readonly check: string;
}

export interface Finding {
  readonly ruleId: string;
  readonly title: string;
  readonly severity: Severity;
  readonly captureId: string;
  readonly captureLabel: string;
  /** The expression that actually resolved, which may be an alias of the rule's. */
  readonly metric: string;
  /** Separate stretches where the condition held. */
  readonly episodes: number;
  /** Span from the first episode's start to the last one's end. */
  readonly firstMs: number;
  readonly lastMs: number;
  /** The longest single episode -- the one worth jumping to. */
  readonly worstFromMs: number;
  readonly worstToMs: number;
  /** Time spent in the state, summed across episodes. */
  readonly totalMs: number;
  /** Most extreme value observed while the condition held. */
  readonly peak: number;
  readonly unit: Unit;
  readonly what: string;
  readonly check: string;
}

/** What detection needs to know about a loaded capture. */
export interface DetectCapture {
  readonly id: string;
  readonly label: string;
  readonly paths: ReadonlySet<string>;
}

export interface DetectSource {
  series(captureId: string, expressions: string[], query: SeriesQuery): Promise<SeriesPayload[]>;
}

interface Episode {
  readonly fromMs: number;
  readonly toMs: number;
  readonly peak: number;
  /** Time actually spent in breach, which is less than `toMs - fromMs` when dips were bridged. */
  readonly inStateMs: number;
}

/**
 * Stretches where the condition held for at least `sustainMs` in total.
 *
 * `guard` is the conservative envelope column -- the one that must satisfy the test for the
 * whole bucket to count -- and `extreme` is the opposite one, used only to report how bad it
 * got. A NaN breaks the run outright: a gap in the capture is not evidence that the condition
 * continued across it, and treating it as such is how a detector reports a five-hour ticket
 * outage because the collector stopped for five hours.
 *
 * A recovery shorter than `toleranceMs` does not end the episode -- see `Rule.toleranceMs` for
 * why, and for the capture that made it necessary. Two properties keep that from becoming a
 * licence to invent findings:
 *
 *  - the qualifying test is on **time spent in breach**, not on the bridged span, so bridging a
 *    dip can join two halves of one episode but cannot manufacture duration that never happened;
 *  - an episode's reported window still starts and ends on samples that were in breach.
 *
 * Each in-breach sample contributes the interval up to the next sample, so a single sample
 * counts for one sample period rather than zero. On a 1 s clock that is the difference between
 * "377 seconds above the eviction trigger" and a detector that says nothing.
 */
export function episodesOf(
  t: Float64Array,
  guard: Float64Array,
  extreme: Float64Array,
  op: '<=' | '>=',
  threshold: number,
  sustainMs: number,
  toleranceMs = 0,
): Episode[] {
  const holds = (v: number): boolean => (op === '<=' ? v <= threshold : v >= threshold);
  const worse = (a: number, b: number): number =>
    op === '<=' ? Math.min(a, b) : Math.max(a, b);

  // Median-ish sample interval, used to give the last sample of a run a width. Taken from the
  // first gap rather than computed: this runs per rule per capture, and the clock is regular.
  const step = t.length > 1 ? Math.max(1, t[1]! - t[0]!) : 1;

  const out: Episode[] = [];
  let start = -1; // first in-breach sample of the open episode
  let last = -1; // most recent in-breach sample
  let peak = NaN;
  let inStateMs = 0;

  const close = (): void => {
    if (start < 0) return;
    if (inStateMs >= sustainMs) {
      out.push({ fromMs: t[start]!, toMs: t[last]!, peak, inStateMs });
    }
    start = -1;
    last = -1;
    inStateMs = 0;
  };

  for (let i = 0; i <= t.length; i++) {
    const gapHere = i >= t.length || Number.isNaN(guard[i]!);
    if (gapHere) {
      // A hole in the capture, or the end of it. Neither is evidence either way.
      close();
      continue;
    }

    if (holds(guard[i]!)) {
      const value = Number.isNaN(extreme[i]!) ? guard[i]! : extreme[i]!;
      peak = start < 0 ? value : worse(peak, value);
      if (start < 0) start = i;
      // The interval this sample stands for: up to the next sample, or one step at the tail.
      inStateMs += i + 1 < t.length ? t[i + 1]! - t[i]! : step;
      last = i;
      continue;
    }

    // Out of breach. Keep the episode open while the recovery is shorter than the tolerance.
    if (start >= 0 && t[i]! - t[last]! > toleranceMs) close();
  }

  return out;
}

const RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

/**
 * Every rule, against every capture that can resolve it.
 *
 * One read per capture regardless of the rule count: the storage layer is explicit that reads
 * must be planned and issued together, and a dozen serialised round trips per node is exactly
 * the shape it warns about.
 */
export async function detect(
  source: DetectSource,
  captures: readonly DetectCapture[],
  rules: readonly Rule[],
  query: SeriesQuery,
): Promise<Finding[]> {
  const perCapture = await Promise.all(
    captures.map(async (capture): Promise<Finding[]> => {
      const prefixes = detectRolePrefixes(capture.paths);

      // A rule may expand to several series -- a glob over disks or mounts -- and two rules may
      // want the same expression. Ask for each distinct one once.
      const wanted: Array<{ rule: Rule; expression: string }> = [];
      for (const rule of rules) {
        for (const expression of expandMetric(rule.metric, capture.paths, prefixes)) {
          wanted.push({ rule, expression });
        }
      }
      if (wanted.length === 0) return [];

      const expressions = [...new Set(wanted.map((w) => w.expression))];
      let payloads: SeriesPayload[];
      try {
        payloads = await source.series(capture.id, expressions, query);
      } catch {
        // A node that cannot be read is not a node with no pathologies, but reporting a read
        // failure as a finding would be worse than saying nothing. The dashboard already
        // surfaces per-capture read errors.
        return [];
      }

      const byExpression = new Map<string, SeriesPayload>();
      for (let i = 0; i < expressions.length; i++) {
        const payload = payloads[i];
        if (payload !== undefined) byExpression.set(expressions[i]!, payload);
      }

      const found: Finding[] = [];
      for (const { rule, expression } of wanted) {
        const series = byExpression.get(expression);
        if (series === undefined || series.t.length === 0) continue;

        // Conservative column first: `<=` must hold for the whole bucket, so read its maximum.
        const guard = rule.op === '<=' ? series.max : series.min;
        const extreme = rule.op === '<=' ? series.min : series.max;
        const episodes = episodesOf(
          series.t,
          guard,
          extreme,
          rule.op,
          rule.threshold,
          rule.sustainMs,
          rule.toleranceMs ?? 0,
        );
        if (episodes.length === 0) continue;

        let worst = episodes[0]!;
        let totalMs = 0;
        let peak = episodes[0]!.peak;
        for (const episode of episodes) {
          totalMs += episode.inStateMs;
          if (episode.inStateMs > worst.inStateMs) worst = episode;
          peak = rule.op === '<=' ? Math.min(peak, episode.peak) : Math.max(peak, episode.peak);
        }

        found.push({
          ruleId: rule.id,
          title: rule.title,
          severity: rule.severity,
          captureId: capture.id,
          captureLabel: capture.label,
          metric: expression,
          episodes: episodes.length,
          firstMs: episodes[0]!.fromMs,
          lastMs: episodes[episodes.length - 1]!.toMs,
          worstFromMs: worst.fromMs,
          worstToMs: worst.toMs,
          totalMs,
          peak,
          unit: rule.unit,
          what: rule.what,
          check: rule.check,
        });
      }
      return found;
    }),
  );

  // Worst first, then earliest: an investigation starts at the most severe thing that happened
  // and works outward in time from it.
  return perCapture
    .flat()
    .sort((a, b) => RANK[a.severity] - RANK[b.severity] || a.firstMs - b.firstMs);
}
