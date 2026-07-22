/**
 * Privacy gate.
 *
 * "Your data never leaves your machine" is a product promise and a sales argument, so it has
 * to be verifiable rather than asserted. This fails the build if anything that could put
 * bytes on the network appears in shipped source.
 *
 * Anything genuinely needed later (a licence check, an opt-in share) must be added to
 * ALLOWED with a comment saying why -- the point is that it becomes a deliberate, reviewed
 * decision instead of something that drifts in.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Calls that can move bytes off the machine. */
const NETWORK_APIS = [
  /\bfetch\s*\(/,
  /\bXMLHttpRequest\b/,
  /\bnavigator\s*\.\s*sendBeacon\b/,
  /\bnew\s+WebSocket\b/,
  /\bEventSource\b/,
  /\bimportScripts\s*\(/,
];

/** Files exempt, each for a stated reason. */
const ALLOWED = new Set<string>([
  // (empty -- nothing in the app needs the network)
]);

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(path);
  }
  return out;
}

describe('privacy', () => {
  it('ships no network calls', () => {
    const offenders: string[] = [];

    for (const file of sources('src')) {
      if (ALLOWED.has(file)) continue;
      const text = readFileSync(file, 'utf8');

      text.split('\n').forEach((line, i) => {
        // Ignore comments: prose about the promise is not a violation of it.
        const code = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
        for (const pattern of NETWORK_APIS) {
          if (pattern.test(code)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
        }
      });
    }

    expect(offenders, `network APIs found in shipped source:\n${offenders.join('\n')}`).toEqual(
      [],
    );
  });

  it('keeps raw capture data out of localStorage', () => {
    const offenders: string[] = [];
    for (const file of sources('src')) {
      const text = readFileSync(file, 'utf8');
      if (/localStorage|sessionStorage/.test(text.replace(/\/\/.*$/gm, ''))) {
        offenders.push(file);
      }
    }
    // Layouts and settings may live here later; series data must not. Revisit this
    // assertion at M3 when dashboard persistence lands, and narrow it rather than delete it.
    expect(offenders).toEqual([]);
  });
});
