/**
 * Joining one page of log lines onto the next.
 *
 * The viewer's buffer is a window, not the whole log: reaching either edge loads the next page
 * and drops the same number of lines off the far end. The only subtle part is the seam, and it
 * is subtle for a reason that is specific to logs rather than to pagination in general.
 *
 * A page boundary is a timestamp, and it has to be requested INCLUSIVELY. One millisecond
 * routinely holds dozens of lines -- a burst of connections, a storm of slow queries all
 * finishing at once -- so asking for the lines strictly after the boundary instant would skip
 * however many of them fell on the far side of the cap. Asking inclusively means the lines at
 * that instant come back a second time, and the overlap has to be removed here.
 *
 * Which is where the log-specific part comes in: these lines have no identity. A log repeats
 * itself verbatim -- three connections accepted in the same millisecond produce three lines that
 * differ only past the port number, and `attr` is truncated before it ever reaches the viewer.
 * So the overlap is matched by COUNT, not by key. Treating the key as an identity would delete
 * real lines as though they were duplicates, and it would do it silently, on exactly the bursts
 * an investigation is usually looking at.
 */

/** The fields identity is computed from; `ViewLine` satisfies this. */
export interface OverlapLine {
  readonly captureId: string;
  readonly tMs: number;
  readonly msg: string;
  readonly attr: string;
}

function keyOf(line: OverlapLine): string {
  return `${line.captureId}|${line.tMs}|${line.msg}|${line.attr.slice(0, 120)}`;
}

/**
 * `page` with as many copies of each boundary line removed as `held` already contains.
 *
 * Order is preserved, and a line the buffer does not hold survives even when it looks identical
 * to one that it does.
 */
export function dropOverlap<T extends OverlapLine>(
  page: readonly T[],
  held: readonly OverlapLine[],
): T[] {
  if (held.length === 0) return [...page];
  const budget = new Map<string, number>();
  for (const line of held) {
    const key = keyOf(line);
    budget.set(key, (budget.get(key) ?? 0) + 1);
  }
  return page.filter((line) => {
    const key = keyOf(line);
    const left = budget.get(key) ?? 0;
    if (left === 0) return true;
    budget.set(key, left - 1);
    return false;
  });
}

/** What the direction decision needs to know about the list. */
export interface EdgeView {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  readonly hasBefore: boolean;
  readonly hasAfter: boolean;
}

/**
 * Which edge to load next, or null to leave the buffer alone.
 *
 * Loading starts before the reader reaches the very edge, so the next lines are usually already
 * there. The subtlety is that a buffer shorter than twice that margin is inside BOTH edges at
 * every scroll position it has -- and a filtered window, or one whose read stopped at the scan
 * budget, is routinely that short.
 *
 * So position alone cannot decide it. Answering "up" for a small scrollTop makes "down"
 * unreachable on exactly those buffers, and a freshly loaded window has nothing before it, so
 * the request that comes back is a no-op and the log stops loading however far it is scrolled.
 * What settles it is which side actually has more, forwards first: reading a log forward is the
 * common direction, and it is the one a short buffer is usually short at.
 */
export function pageDirection(view: EdgeView, nearEdgePx = 600): 'up' | 'down' | null {
  const nearTop = view.scrollTop < nearEdgePx;
  const nearBottom = view.scrollHeight - view.scrollTop - view.clientHeight < nearEdgePx;
  if (nearBottom && view.hasAfter) return 'down';
  if (nearTop && view.hasBefore) return 'up';
  return null;
}

/**
 * How much of the buffer one page replaces.
 *
 * A third, so two thirds of what the reader was looking at survives the load. Paging a whole
 * buffer at a time would leave nothing on screen that was there when they arrived, which reads
 * as losing your place rather than as scrolling.
 */
export function pageSize(cap: number): number {
  return Math.max(200, Math.floor(cap / 3));
}
