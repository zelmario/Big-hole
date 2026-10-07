/**
 * The int64 mongod writes for a BSON Double.
 *
 * The fixtures only hold finite, in-range doubles, so the oracle never sees the edges. They
 * still matter: the seed is the base every later sample in the chunk is a delta from, so a
 * wrong seed shifts the whole column, not one point. The expected values are mongod 5.0+
 * (src/mongo/db/ftdc/util.cpp, extractMetricsFromDocument).
 */

import { describe, expect, it } from 'vitest';

import { int64FromDouble } from '../src/ftdc/bson.js';

const halves = (hi: number, lo: number) => ({ hi, lo });

describe('the int64 mongod stores for a Double', () => {
  it('truncates toward zero, on both sides', () => {
    expect(int64FromDouble(295870.9)).toEqual(halves(0, 295870));
    expect(int64FromDouble(-1.9)).toEqual(halves(0xffffffff, 0xffffffff)); // -1
    expect(int64FromDouble(-0)).toEqual(halves(0, 0));
  });

  it('keeps integers above 2^32 exact', () => {
    expect(int64FromDouble(2 ** 40 + 7)).toEqual(halves(2 ** 8, 7));
  });

  it('writes 0 for NaN', () => {
    expect(int64FromDouble(NaN)).toEqual(halves(0, 0));
  });

  it('saturates at ±2^63, infinities included, instead of wrapping', () => {
    const max = halves(0x7fffffff, 0xffffffff);
    const min = halves(0x80000000, 0);
    expect(int64FromDouble(Infinity)).toEqual(max);
    expect(int64FromDouble(2 ** 63)).toEqual(max);
    expect(int64FromDouble(1e20)).toEqual(max);
    expect(int64FromDouble(-Infinity)).toEqual(min);
    expect(int64FromDouble(-1e20)).toEqual(min);
    // -2^63 is representable, so it is the value itself, not a clamp.
    expect(int64FromDouble(-(2 ** 63))).toEqual(min);
  });
});
