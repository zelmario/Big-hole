/**
 * The reader's clock. Every timestamp on screen goes through it, so a wrong sign or a dropped
 * half hour here would be wrong everywhere at once.
 */

import { describe, expect, it } from 'vitest';

import { clockFor, offsetLabel, OFFSETS } from '../src/ui/clock.js';

const T = Date.parse('2026-08-05T00:13:30.000Z');

describe('the display clock', () => {
  it('is UTC by default, with the Z every other UTC stamp in the app carries', () => {
    const clock = clockFor(0);
    expect(clock.zone).toBe('UTC');
    expect(clock.stamp(T)).toBe('2026-08-05 00:13:30Z');
    expect(clock.stamp(T + 123)).toBe('2026-08-05 00:13:30.123Z');
  });

  it('moves the label west of UTC across midnight, and names the offset', () => {
    const clock = clockFor(-180);
    expect(clock.zone).toBe('UTC-03:00');
    expect(clock.date(T)).toBe('2026-08-04');
    expect(clock.time(T)).toBe('21:13:30');
    expect(clock.stamp(T)).toBe('2026-08-04 21:13:30 UTC-03:00');
  });

  it('keeps the half hour of a :30 zone', () => {
    const clock = clockFor(330);
    expect(clock.zone).toBe('UTC+05:30');
    expect(clock.second(T)).toBe('2026-08-05 05:43:30');
  });

  it('offers UTC and only offsets that exist', () => {
    expect(OFFSETS).toContain(0);
    expect(Math.min(...OFFSETS)).toBe(-720);
    expect(Math.max(...OFFSETS)).toBe(840);
    expect(offsetLabel(-570)).toBe('UTC-09:30');
    expect(OFFSETS.every((m) => m % 15 === 0)).toBe(true);
  });
});
