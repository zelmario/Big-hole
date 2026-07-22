/**
 * Decoder throughput.
 *
 * Speed is a hard requirement (ARCHITECTURE.md): a node-day is ~216M values and a replica-set week
 * is billions. Run with `npm run bench`.
 *
 * The headline number to watch is values/sec, since input bytes vary enormously with how
 * compressible a capture is -- an idle server packs far more samples into the same bytes.
 */

import { bench, describe } from 'vitest';
import { readFileSync } from 'node:fs';

import { decodeFTDC } from '../src/ftdc/index.js';
import { discoverFixtures } from './oracle.js';

const fixtures = discoverFixtures();

for (const fixture of fixtures) {
  const bytes = new Uint8Array(readFileSync(fixture.ftdc));

  // Report the shape once so the bench numbers below are interpretable.
  let samples = 0;
  let values = 0;
  for (const chunk of decodeFTDC(bytes)) {
    samples += chunk.sampleCount;
    values += chunk.sampleCount * chunk.keys.length;
  }

  describe(`${fixture.name} [${(fixture.bytes / 1024).toFixed(0)} KiB, ${samples} samples, ${(values / 1e6).toFixed(2)}M values]`, () => {
    bench('decodeFTDC', () => {
      for (const chunk of decodeFTDC(bytes)) {
        // Touch a column so nothing can be optimised away.
        if (chunk.columns.length === 0) throw new Error('empty chunk');
      }
    });
  });
}
