/**
 * Decoder correctness against MongoDB's reference implementation.
 *
 * This is the M0.5 harness and it is intentionally uncompromising: it compares **every
 * metric of every sample**, not a spot-check. Two of the four decoder traps documented in
 * ARCHITECTURE.md (BSON Timestamp producing two columns, and zero-run state carrying across
 * column boundaries) produce output that a spot-check happily accepts -- plausible numbers,
 * right magnitudes, attached to the wrong metric names.
 *
 * Expect this suite to be RED until milestone M1 is complete.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import { decodeFTDC } from '../src/ftdc/index.js';
import { discoverFixtures, readOracle } from './oracle.js';

const fixtures = discoverFixtures();

if (fixtures.length === 0) {
  describe('ftdc decoder', () => {
    it.skip('no fixtures found -- run `npm run fixtures` to generate them', () => {});
  });
}

describe.each(fixtures)('ftdc decoder: $name', (fixture) => {
  it('matches the reference decode for every metric of every sample', async () => {
    const bytes = new Uint8Array(readFileSync(fixture.ftdc));
    const oracle = readOracle(fixture.oracle);

    let sampleIndex = 0;
    let comparisons = 0;

    for (const chunk of decodeFTDC(bytes)) {
      expect(chunk.columns.length).toBe(chunk.keys.length);
      expect(chunk.types.length).toBe(chunk.keys.length);
      for (const col of chunk.columns) {
        expect(col.length).toBe(chunk.sampleCount);
      }

      for (let s = 0; s < chunk.sampleCount; s++) {
        const next = await oracle.next();
        if (next.done) {
          throw new Error(
            `decoder produced more samples than the reference (stopped at ${sampleIndex})`,
          );
        }
        const expected = next.value;

        // Flatten order defines the delta-block column order. Compare it explicitly:
        // correct values under a wrong order is still a broken decoder.
        if (expected.schemaChanged || s === 0) {
          expect(
            chunk.keys,
            `metric paths diverge at sample ${sampleIndex}`,
          ).toEqual([...expected.keys]);
        }

        for (let m = 0; m < chunk.keys.length; m++) {
          const actual = chunk.columns[m]![s]!;
          const want = expected.values[m]!;

          // Exact equality is correct here, not approximate. Integer columns are exact
          // below 2^53, and doubles come from a deterministic Float64frombits of an
          // exactly-reconstructed bit pattern -- there is no floating-point drift to
          // tolerate. Any mismatch is a decoder bug.
          if (Number.isNaN(want)) {
            expect(
              Number.isNaN(actual),
              `${chunk.keys[m]} @ sample ${sampleIndex}: expected NaN, got ${actual}`,
            ).toBe(true);
          } else if (!Object.is(actual, want)) {
            throw new Error(
              `mismatch at sample ${sampleIndex}, metric "${chunk.keys[m]}" ` +
                `(type ${chunk.types[m]}, column ${m}): expected ${want}, got ${actual}`,
            );
          }
          comparisons++;
        }

        sampleIndex++;
      }
    }

    const trailing = await oracle.next();
    expect(
      trailing.done,
      `reference produced more samples than the decoder (decoder stopped at ${sampleIndex})`,
    ).toBe(true);

    expect(sampleIndex, 'decoded zero samples').toBeGreaterThan(0);
    // eslint-disable-next-line no-console
    console.log(
      `${fixture.name}: ${sampleIndex} samples, ${comparisons.toLocaleString()} value comparisons`,
    );
  });
});
