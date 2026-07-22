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

export function formatValue(v: number, unit: Unit): string {
  if (!Number.isFinite(v)) return '—';

  switch (unit) {
    case 'bytes':
      return bytes(v, '');
    case 'bytes/s':
      return bytes(v, '/s');
    case 'percent':
      return `${v.toFixed(v >= 100 ? 0 : 1)}%`;
    case 'ms':
      return duration(v);
    case 'us':
      return duration(v / 1000);
    case 'per-sec':
      return `${count(v)}/s`;
    default:
      return count(v);
  }
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

    if (unit === 'percent') return ticks.map((t) => `${t.toFixed(0)}%`);
    if (unit === 'ms') return ticks.map((t) => duration(t));
    if (unit === 'us') return ticks.map((t) => duration(t / 1000));

    const peak = Math.max(...ticks.map(Math.abs));
    let div = 1;
    let i = 0;
    while (peak / div >= 1000 && i < DECIMAL.length - 1) {
      div *= 1000;
      i++;
    }
    const suffix = `${DECIMAL[i]}${unit === 'per-sec' ? '/s' : ''}`;
    return ticks.map((t) => {
      const x = t / div;
      return `${Number.isInteger(x) ? x : x.toFixed(1)}${suffix}`;
    });
  };
}
