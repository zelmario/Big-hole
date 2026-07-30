/**
 * Replica-set member state over time.
 *
 * "Which member was primary, and when did that change" is the first question asked of a
 * replica-set capture and the last one the dashboard could answer: `replSetGetStatus.myState`
 * is a small integer that spends hours flat, which is precisely the shape a line chart renders
 * as an uninformative horizontal rule. It wants to be a band per member, and bands want runs
 * rather than samples.
 *
 * Three decisions carry this file:
 *
 * - **Runs are built once, from the min/max envelope, and never re-read on zoom.** A state
 *   column is read at a bounded resolution -- a bucket is seconds wide on the longest capture
 *   anyone loads -- and collapsed to a handful of runs, so panning and zooming the strip costs
 *   nothing. Downsampling cannot hide a transition here, because a bucket containing one
 *   reports two different values in `min` and `max`: the bucket is split rather than resolved
 *   to whichever end happened to be sampled.
 *
 * - **A hole in the capture is its own state, not a longer run of the last one.** The collector
 *   stopping is one of the strongest signals FTDC carries, and reading a two-hour gap as two
 *   more hours of SECONDARY is exactly the wrong answer.
 *
 * - **Members that were not loaded still get a row.** A bundle routinely arrives with one
 *   member's diagnostic.data out of three, and each node reports every *other* member's state
 *   through its heartbeats -- which is where DOWN comes from, since no node ever reports itself
 *   as down. Peer rows are labelled as the second-hand evidence they are.
 *
 * DOM-free on purpose: `StateStrip.tsx` renders these, and the tests build them without a
 * browser.
 */

import { detectRolePrefixes, expandMetric } from '../dashboard/layout.js';
import type { CatalogEntry, SeriesQuery } from '../data/reader.js';
import type { SeriesPayload } from '../workers/protocol.js';

/**
 * `replSetGetStatus` member states, by code.
 *
 * From `mongo/db/repl/member_state.h`. Codes 4 (FATAL) and 11 (never used) are historical --
 * they are listed because a capture from an old server may still carry them, and an unmapped
 * code renders as its number rather than being silently dropped.
 */
export const MEMBER_STATES: Readonly<Record<number, string>> = {
  0: 'STARTUP',
  1: 'PRIMARY',
  2: 'SECONDARY',
  3: 'RECOVERING',
  4: 'FATAL',
  5: 'STARTUP2',
  6: 'UNKNOWN',
  7: 'ARBITER',
  8: 'DOWN',
  9: 'ROLLBACK',
  10: 'REMOVED',
};

/** Not a member state: the capture has no sample here, so nothing is known. */
export const NO_DATA = -1;

export function stateName(code: number): string {
  if (code === NO_DATA) return 'no data';
  return MEMBER_STATES[code] ?? `state ${code}`;
}

/**
 * Colour per state.
 *
 * Green for the one member that takes writes, olive for the ones that do not, red for anything
 * that means "not serving", amber for the transitional states. Deliberately few colours: the
 * strip is read at a glance to answer "did this change", and a per-code rainbow answers a
 * question nobody asked.
 */
export function stateColour(code: number): string {
  switch (code) {
    case 1:
      return '#73bf69'; // PRIMARY
    case 2:
      return '#b5a213'; // SECONDARY
    case 7:
      return '#5794f2'; // ARBITER
    case 0:
    case 3:
    case 5:
      return '#ff9830'; // STARTUP / RECOVERING / STARTUP2
    case 9:
      return '#b877d9'; // ROLLBACK
    case 4:
    case 6:
    case 8:
    case 10:
      return '#f2495c'; // FATAL / UNKNOWN / DOWN / REMOVED
    default:
      return '#8b94a3';
  }
}

/** A stretch of time one member spent in one state. Half-open: `[fromMs, toMs)`. */
export interface StateRun {
  readonly fromMs: number;
  readonly toMs: number;
  readonly state: number;
}

/** One row of the strip: a member, and what it did over the capture. */
export interface MemberRow {
  /** Stable identity for React keys and for colouring. */
  readonly key: string;
  readonly label: string;
  /** Replica-set config `_id`, when the capture says which member is which. */
  readonly memberId: number | null;
  /** The loaded capture this row *is*, or null for a member reported only by its peers. */
  readonly captureId: string | null;
  /** Label of the node whose view this is. Equal to `label` for a self-reported row. */
  readonly reportedBy: string;
  /** False when the row is another node's heartbeat view of this member. */
  readonly self: boolean;
  readonly runs: StateRun[];
}

/** What the timeline needs to know about a loaded capture. */
export interface StateCapture {
  readonly id: string;
  readonly label: string;
  readonly paths: ReadonlySet<string>;
  readonly catalog: readonly CatalogEntry[];
}

/**
 * Buckets a state column is read into.
 *
 * The whole point of the strip is that it is built once and re-rendered free at any zoom, so
 * the read has to be bounded by something other than the capture's length. 20,000 buckets is
 * about 7.6 s on the longest real capture measured (42.3 h) and full resolution on anything
 * under about five hours -- and a transition inside a bucket survives it, because the envelope
 * reports both states (see `runsOf`). The same bound the detectors use, for the same reason.
 */
const STATE_POINTS = 20_000;

export interface StateSource {
  series(captureId: string, expressions: string[], query: SeriesQuery): Promise<SeriesPayload[]>;
}

/**
 * Typical spacing of a time column, in ms.
 *
 * Taken from the column handed in rather than from the capture's cadence, because these arrays
 * may be bucketed: on a 42-hour capture a bucket is several seconds wide, and a gap test written
 * against the 1 s sample cadence would call every bucket boundary a hole in the capture.
 * Median rather than mean, so one real gap does not set the scale for the rest.
 */
function stepOf(t: Float64Array): number {
  if (t.length < 2) return 1000;
  const stride = Math.max(1, Math.floor(t.length / 512));
  const deltas: number[] = [];
  for (let i = stride; i < t.length; i += stride) {
    const d = (t[i]! - t[i - stride]!) / stride;
    if (d > 0) deltas.push(d);
  }
  if (deltas.length === 0) return 1000;
  deltas.sort((a, b) => a - b);
  return deltas[deltas.length >> 1]!;
}

/**
 * Collapse a sampled state column into runs.
 *
 * `lo` and `hi` are the min/max envelope of the same column; for a full-resolution read they are
 * the same array. Where they differ the state changed inside that bucket, and the bucket is
 * **split in half** rather than resolved to one end of it: the half that continues the previous
 * run is drawn first, the other second. That keeps a downsampled read from silently deciding
 * which side of an election a bucket falls on -- and the two states involved are exactly `lo`
 * and `hi`, since state codes only ever take one of a dozen values.
 *
 * NaN -- a metric absent from a chunk's schema, or a bucket with no samples in it -- becomes
 * `NO_DATA` rather than being skipped: "the node stopped reporting its state" is a fact worth
 * drawing, not a hole to interpolate across.
 *
 * Runs tile the timeline with no seams: each ends where the next begins, and the last is given
 * one step of width so a single trailing sample is visible rather than zero pixels wide. A jump
 * in the clock wider than four steps opens a `NO_DATA` run of its own -- without it, a capture
 * that stopped for five hours and came back in the same state would draw as one unbroken run
 * straight through the outage, which is the same mistake `episodesOf` refuses to make in
 * `src/insights/detect.ts`, for the same reason.
 */
export function runsOf(t: Float64Array, lo: Float64Array, hi: Float64Array): StateRun[] {
  const step = stepOf(t);
  const stale = step * 4;
  const out: StateRun[] = [];

  let open = false;
  let state = 0;
  let startMs = 0;
  let lastMs = 0;

  const close = (endMs: number): void => {
    if (open && endMs > startMs) out.push({ fromMs: startMs, toMs: endMs, state });
    open = false;
  };

  const at = (ms: number, code: number): void => {
    if (!open) {
      state = code;
      startMs = ms;
      open = true;
    } else if (code !== state) {
      close(ms);
      state = code;
      startMs = ms;
      open = true;
    }
  };

  for (let i = 0; i < t.length; i++) {
    const ms = t[i]!;
    const a = lo[i]!;
    const b = hi[i]!;

    if (open && ms - lastMs > stale) {
      // The clock jumped. Close what was known, then say the gap out loud.
      close(lastMs + step);
      out.push({ fromMs: lastMs + step, toMs: ms, state: NO_DATA });
      open = false;
    }

    if (Number.isNaN(a) && Number.isNaN(b)) {
      at(ms, NO_DATA);
    } else if (a === b || Number.isNaN(a) || Number.isNaN(b)) {
      at(ms, Math.round(Number.isNaN(a) ? b : a));
    } else {
      // A transition inside this bucket. Continue the open run through the first half.
      const first = Math.round(b) === state ? b : a;
      const second = first === a ? b : a;
      const width = i + 1 < t.length ? t[i + 1]! - ms : step;
      at(ms, Math.round(first));
      at(ms + width / 2, Math.round(second));
    }

    lastMs = ms;
  }

  close(lastMs + step);

  // Bridging a gap can leave two NO_DATA runs touching; one band beats two.
  const merged: StateRun[] = [];
  for (const run of out) {
    const prev = merged[merged.length - 1];
    if (prev !== undefined && prev.state === run.state && prev.toMs >= run.fromMs) {
      merged[merged.length - 1] = { ...prev, toMs: Math.max(prev.toMs, run.toMs) };
    } else {
      merged.push(run);
    }
  }
  return merged;
}

/** Index part of `…replSetGetStatus.members.<n>.state`, or null when the path is not one. */
function memberIndexOf(path: string): string | null {
  return /\.members\.([^.]+)\.state$/.exec(path)?.[1] ?? null;
}

/**
 * Replica-set config `_id` of a member, from the catalogue alone.
 *
 * No I/O: a member's `_id` does not change, so the manifest's whole-capture min/max already
 * answer it. When they disagree the replica-set configuration was edited mid-capture and the
 * index-to-member mapping is genuinely ambiguous, so the row is left unnamed rather than
 * labelled with one of the two.
 */
function memberIdOf(catalog: ReadonlyMap<string, CatalogEntry>, statePath: string): number | null {
  const entry = catalog.get(statePath.replace(/\.state$/, '._id'));
  if (entry === undefined || entry.min !== entry.max) return null;
  return entry.min;
}

/** Paths this capture reports a per-member state under, and how each one is identified. */
interface MemberPath {
  readonly path: string;
  readonly index: string;
  readonly memberId: number | null;
  /** True when `replSetGetStatus` marked this entry as the reporting node itself. */
  readonly isSelf: boolean;
}

function memberPathsOf(capture: StateCapture): MemberPath[] {
  const prefixes = detectRolePrefixes(capture.paths);
  const catalog = new Map(capture.catalog.map((e) => [e.path, e]));

  const out: MemberPath[] = [];
  for (const path of expandMetric('replSetGetStatus.members.*.state', capture.paths, prefixes)) {
    const index = memberIndexOf(path);
    if (index === null) continue;
    out.push({
      path,
      index,
      memberId: memberIdOf(catalog, path),
      // `self: true` is only ever written on the reporting node's own entry, so the field's
      // existence is the test -- there is no `self: false` to distinguish.
      isSelf: capture.paths.has(path.replace(/\.state$/, '.self')),
    });
  }
  return out.sort((a, b) => (a.memberId ?? 0) - (b.memberId ?? 0) || a.index.localeCompare(b.index));
}

/** The `myState` expression this capture resolves, or null for a standalone. */
function myStatePathOf(capture: StateCapture): string | null {
  const prefixes = detectRolePrefixes(capture.paths);
  return expandMetric('replSetGetStatus.myState', capture.paths, prefixes)[0] ?? null;
}

/**
 * Every member's state timeline, across every loaded capture.
 *
 * One read per capture, all captures concurrently -- the same rule the rest of the app follows:
 * plan the reads, issue them together (ARCHITECTURE.md, "Storage").
 *
 * A member is drawn from its own capture when one is loaded, and from a peer's heartbeat view
 * otherwise. Self-reported always wins: a node knows its own state, whereas a peer's view is up
 * to a heartbeat interval stale and reports DOWN for anything it merely cannot reach.
 */
export async function buildMemberRows(
  source: StateSource,
  captures: readonly StateCapture[],
): Promise<MemberRow[]> {
  if (captures.length === 0) return [];

  const plans = captures.map((capture) => ({
    capture,
    myState: myStatePathOf(capture),
    members: memberPathsOf(capture),
  }));

  /**
   * Members that have a capture of their own, by config `_id`.
   *
   * Built before any row is emitted, so a peer's view of a node is never drawn beside that
   * node's own row -- the same member twice, disagreeing, is worse than not answering.
   */
  const loadedIds = new Set<number>();
  for (const plan of plans) {
    const own = plan.members.find((m) => m.isSelf);
    if (own?.memberId != null) loadedIds.add(own.memberId);
  }

  const results = await Promise.all(
    plans.map(async (plan) => {
      // Only the peers this capture is the best available source for. Its own row comes from
      // `myState`, which every replica-set member reports whether or not it lists members.
      const peers = plan.members.filter(
        (m) => !m.isSelf && (m.memberId === null || !loadedIds.has(m.memberId)),
      );
      const wanted = [...(plan.myState !== null ? [plan.myState] : []), ...peers.map((p) => p.path)];
      if (wanted.length === 0) return { plan, peers, byPath: new Map<string, SeriesPayload>() };

      try {
        // The arrays are dropped as soon as they are run-length encoded; what survives is a
        // handful of runs per member, which is what makes the strip free to redraw.
        const payloads = await source.series(plan.capture.id, wanted, { maxPoints: STATE_POINTS });
        const byPath = new Map<string, SeriesPayload>();
        for (let i = 0; i < payloads.length; i++) byPath.set(wanted[i]!, payloads[i]!);
        return { plan, peers, byPath };
      } catch {
        // One node that cannot be read must not cost the others their rows.
        return { plan, peers, byPath: new Map<string, SeriesPayload>() };
      }
    }),
  );

  const rows: MemberRow[] = [];
  const claimed = new Set<number>();

  // Self rows first, in load order, so the strip reads in the order the nodes were dropped.
  for (const { plan, byPath } of results) {
    if (plan.myState === null) continue;
    const payload = byPath.get(plan.myState);
    if (payload === undefined) continue;
    const own = plan.members.find((m) => m.isSelf);
    rows.push({
      key: plan.capture.id,
      label: plan.capture.label,
      memberId: own?.memberId ?? null,
      captureId: plan.capture.id,
      reportedBy: plan.capture.label,
      self: true,
      runs: runsOf(payload.t, payload.min, payload.max),
    });
    if (own?.memberId != null) claimed.add(own.memberId);
  }

  // Then the members nobody loaded, as whichever node saw them first describes them.
  for (const { plan, peers, byPath } of results) {
    for (const peer of peers) {
      if (peer.memberId !== null && claimed.has(peer.memberId)) continue;
      const payload = byPath.get(peer.path);
      if (payload === undefined) continue;
      if (peer.memberId !== null) claimed.add(peer.memberId);
      rows.push({
        key: `${plan.capture.id}/${peer.index}`,
        label: peer.memberId !== null ? `member ${peer.memberId}` : `members.${peer.index}`,
        memberId: peer.memberId,
        captureId: null,
        reportedBy: plan.capture.label,
        self: false,
        runs: runsOf(payload.t, payload.min, payload.max),
      });
    }
  }

  return rows;
}
