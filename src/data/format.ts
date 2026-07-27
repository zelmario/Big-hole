/**
 * Unit-aware value formatting.
 *
 * FTDC carries no unit metadata, so a raw axis reads `3221225472` where an engineer wants
 * `3.0 GiB`. Getting this right is most of the difference between a chart you can read at a
 * glance and one you have to decode.
 */

import type { Unit } from './expr.js';

const BINARY = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
const DECIMAL = ['', 'k', 'M', 'G', 'T', 'P'];

function bytes(v: number, suffix: string): string {
  const neg = v < 0;
  let x = Math.abs(v);
  let i = 0;
  while (x >= 1024 && i < BINARY.length - 1) {
    x /= 1024;
    i++;
  }
  const digits = x >= 100 || i === 0 ? 0 : x >= 10 ? 1 : 2;
  return `${neg ? '-' : ''}${x.toFixed(digits)} ${BINARY[i]}${suffix}`;
}

function count(v: number): string {
  const neg = v < 0;
  let x = Math.abs(v);
  let i = 0;
  while (x >= 1000 && i < DECIMAL.length - 1) {
    x /= 1000;
    i++;
  }
  const digits = i === 0 ? (Number.isInteger(x) ? 0 : 2) : x >= 100 ? 0 : x >= 10 ? 1 : 2;
  return `${neg ? '-' : ''}${x.toFixed(digits)}${DECIMAL[i]}`;
}

/** Duration from a millisecond value, scaling up to units a human reads quickly. */
function duration(ms: number): string {
  const abs = Math.abs(ms);
  if (abs < 1) return `${(ms * 1000).toFixed(0)} µs`;
  if (abs < 1000) return `${ms.toFixed(abs < 10 ? 2 : 0)} ms`;
  if (abs < 60_000) return `${(ms / 1000).toFixed(2)} s`;
  if (abs < 3_600_000) return `${(ms / 60_000).toFixed(1)} min`;
  if (abs < 86_400_000) return `${(ms / 3_600_000).toFixed(1)} h`;
  return `${(ms / 86_400_000).toFixed(1)} d`;
}

/**
 * Decimals for a percentage, scaled to how small it is.
 *
 * A fixed precision cannot serve this unit. The same axis draws a cache-dirty ratio pinned near
 * 100% and a CPU chart that lives under half a percent, and one decimal turns the second into a
 * column of "0.0%" -- which does not read as "small", it reads as "nothing is happening". On an
 * idle-looking node, telling 0.04% from 0.004% is often the whole question.
 */
function percentDigits(v: number): number {
  const a = Math.abs(v);
  if (a >= 100) return 0;
  if (a >= 0.1 || a === 0) return 1;
  if (a >= 0.01) return 2;
  return 3;
}

export function formatValue(v: number, unit: Unit): string {
  if (!Number.isFinite(v)) return '—';

  switch (unit) {
    case 'bytes':
      return bytes(v, '');
    case 'bytes/s':
      return bytes(v, '/s');
    case 'percent':
      return `${v.toFixed(percentDigits(v))}%`;
    case 'ms':
      return duration(v);
    case 'us':
      return duration(v / 1000);
    case 'seconds':
      return duration(v * 1000);
    case 'per-sec':
      return `${count(v)}/s`;
    default:
      return count(v);
  }
}

/**
 * Decimals needed for consecutive ticks to read as different numbers.
 *
 * Derived from the tick SPACING, not from the values. uPlot chooses where the ticks go; the
 * formatter's only remaining job is to render them distinguishably, and a hard-coded precision
 * cannot, because one unit has to serve a chart pinned at 100% and one living under half a
 * percent. Round the second to whole numbers and every tick on the axis prints "0%" -- not an
 * imprecise axis but an empty one, which is worse than no axis at all because it looks like a
 * reading.
 *
 * uPlot's linear ticks step by 1, 2 or 5 times a power of ten, so `ceil(-log10(step))` lands on
 * exactly the digits that step needs. Capped, because a degenerate scale must not produce a
 * fifteen-digit label.
 */
function tickDigits(ticks: readonly number[], max = 6): number {
  let step = Infinity;
  for (let i = 1; i < ticks.length; i++) {
    const gap = Math.abs(ticks[i]! - ticks[i - 1]!);
    if (gap > 0 && gap < step) step = gap;
  }
  // One tick, or every tick identical: there is no spacing to read, and falling back to whole
  // numbers would round the only label on the axis -- a lone 0.5 rendering as "1". Use the
  // value's own magnitude instead, which is the same question asked of a different number.
  if (!Number.isFinite(step)) {
    const peak = Math.max(...ticks.map(Math.abs));
    if (!Number.isFinite(peak) || peak === 0) return 0;
    return Math.min(max, Math.max(0, Math.ceil(-Math.log10(peak))));
  }
  return Math.min(max, Math.max(0, Math.ceil(-Math.log10(step))));
}

/**
 * Axis-tick variant: terser, and consistent across a tick sequence.
 *
 * uPlot hands the whole tick array in, so the scale is chosen once from the largest tick
 * rather than per value -- otherwise an axis reads 900 MiB, 1.0 GiB, 1.1 GiB with the unit
 * jumping mid-sequence.
 */
export function axisFormatter(unit: Unit): (ticks: number[]) => string[] {
  return (ticks: number[]) => {
    if (ticks.length === 0) return [];

    if (unit === 'bytes' || unit === 'bytes/s') {
      const peak = Math.max(...ticks.map(Math.abs));
      let div = 1;
      let i = 0;
      while (peak / div >= 1024 && i < BINARY.length - 1) {
        div *= 1024;
        i++;
      }
      const suffix = `${BINARY[i]}${unit === 'bytes/s' ? '/s' : ''}`;
      return ticks.map((t) => `${(t / div).toFixed(i === 0 ? 0 : 1)} ${suffix}`);
    }

    if (unit === 'percent') {
      const digits = tickDigits(ticks);
      return ticks.map((t) => `${t.toFixed(digits)}%`);
    }
    if (unit === 'ms') return ticks.map((t) => duration(t));
    if (unit === 'us') return ticks.map((t) => duration(t / 1000));
    if (unit === 'seconds') return ticks.map((t) => duration(t * 1000));

    const peak = Math.max(...ticks.map(Math.abs));
    let div = 1;
    let i = 0;
    while (peak / div >= 1000 && i < DECIMAL.length - 1) {
      div *= 1000;
      i++;
    }
    const suffix = `${DECIMAL[i]}${unit === 'per-sec' ? '/s' : ''}`;
    const scaled = ticks.map((t) => t / div);
    // Same reasoning as percentages: a fixed one decimal turns an axis of small rates into a
    // stack of "0.0/s". Integers still print bare, because the digit count comes from the step.
    const digits = tickDigits(scaled);
    return scaled.map((x) => `${x.toFixed(digits)}${suffix}`);
  };
}
