import { useMemo } from 'react';

import { useStore } from '../store/useStore.js';

/**
 * The one clock every timestamp on screen is written in.
 *
 * UTC unless the reader picks an offset. The data never moves: FTDC is epoch milliseconds and
 * a mongod log line carries its own offset, so both already sit on one absolute axis. What an
 * offset changes is the label, so a customer who says "it slowed down at 03:00" can be read in
 * their own clock instead of converted by hand.
 *
 * A fixed offset rather than a named zone, on purpose. A zone name brings daylight saving
 * rules with it, and a capture that crosses a DST change would then show one hour twice. An
 * offset is what the log line itself says (`-05:00`), so it is the thing a reader can check.
 *
 * Every formatter in the app goes through here. A component that keeps its own
 * `toISOString()` would stay in UTC while the rest moves, which is the two-clocks bug the
 * chart axes once had.
 */

/** Offsets in real use, in minutes east of UTC: whole hours plus the :30 and :45 zones. */
export const OFFSETS: readonly number[] = [
  -720, -660, -600, -570, -540, -480, -420, -360, -300, -240, -210, -180, -150, -120, -60, 0,
  60, 120, 180, 210, 240, 270, 300, 330, 345, 360, 390, 420, 480, 525, 540, 570, 600, 630, 660,
  720, 765, 780, 840,
];

/** `UTC`, or `UTC+05:30` / `UTC-03:00`. */
export function offsetLabel(offsetMin: number): string {
  if (offsetMin === 0) return 'UTC';
  const sign = offsetMin < 0 ? '-' : '+';
  const abs = Math.abs(offsetMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `UTC${sign}${hh}:${mm}`;
}

export interface Clock {
  readonly offsetMin: number;
  /** `UTC` or `UTC-03:00`, for a label beside a bare time. */
  readonly zone: string;
  /** `2026-08-05 00:13:30.123`: the wall-clock time at this offset, no zone. */
  wall(ms: number): string;
  /** `2026-08-05` */
  date(ms: number): string;
  /** `00:13:30` */
  time(ms: number): string;
  /** `00:13` */
  hm(ms: number): string;
  /** `2026-08-05 00:13` */
  minute(ms: number): string;
  /** `2026-08-05 00:13:30` */
  second(ms: number): string;
  /** `2026-08-05 00:13:30Z` in UTC, `2026-08-04 21:13:30 UTC-03:00` otherwise; ms kept when non-zero. */
  stamp(ms: number): string;
  /** The epoch ms whose UTC fields read as this clock's wall time. For tick maths and uPlot. */
  shift(ms: number): number;
}

export function clockFor(offsetMin: number): Clock {
  const shift = (ms: number): number => ms + offsetMin * 60_000;
  const wall = (ms: number): string => new Date(shift(ms)).toISOString().replace('T', ' ').slice(0, 23);
  const zone = offsetLabel(offsetMin);
  return {
    offsetMin,
    zone,
    wall,
    date: (ms) => wall(ms).slice(0, 10),
    time: (ms) => wall(ms).slice(11, 19),
    hm: (ms) => wall(ms).slice(11, 16),
    minute: (ms) => wall(ms).slice(0, 16),
    second: (ms) => wall(ms).slice(0, 19),
    stamp: (ms) => {
      const w = wall(ms).replace(/\.000$/, '');
      return offsetMin === 0 ? `${w}Z` : `${w} ${zone}`;
    },
    shift,
  };
}

/** The reader's chosen clock, re-rendering whatever uses it when the offset changes. */
export function useClock(): Clock {
  const offsetMin = useStore((s) => s.tzOffsetMin);
  return useMemo(() => clockFor(offsetMin), [offsetMin]);
}
