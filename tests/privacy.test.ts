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
  // Loads the demo capture that ships with the built site: same-origin GETs for assets this
  // deployment already serves, so the bytes travel towards the page and never away from it.
  // No request body, no destination built from state, nothing that reads a loaded capture.
  // The promise is about data leaving; this is the site handing the visitor a sample.
  join('src', 'ingest', 'demo.ts'),
]);

/**
 * Strip comments before scanning.
 *
 * Prose *about* the privacy promise is not a violation of it, and block comments explaining
 * why something deliberately avoids localStorage were being flagged as offenders.
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

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

  /**
   * The allowlist is a hole in the gate, so the hole itself gets a test.
   *
   * Exempting a file from the scan means nobody looks at its `fetch` calls again. What makes
   * the demo loader safe is not that it was reviewed once -- it is that every request it can
   * make is a relative path under this site's own base, and carries no body. Both of those are
   * checkable, so they are checked, and a later edit that adds an absolute URL or a POST fails
   * here rather than shipping.
   */
  it('holds the allowlisted loader to same-origin reads', () => {
    const file = join('src', 'ingest', 'demo.ts');
    const code = stripComments(readFileSync(file, 'utf8'));

    const targets = [...code.matchAll(/fetch\(([^)]*)\)/g)].map((m) => m[1]!.trim());
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      // A scheme or a protocol-relative prefix would be another origin.
      expect(target).not.toMatch(/https?:|\/\//);
      // Every request is a GET of a path: no init object, so no method, body or credentials.
      expect(target).not.toMatch(/,/);
    }
    // The root every path is built from is the deployment's own base, not an outside address.
    expect(code).toMatch(/import\.meta\.env\.BASE_URL/);
  });

  it('confines localStorage to layout persistence', () => {
    // Narrowed at M3 when dashboard persistence landed. Layouts and settings may live in
    // localStorage; capture data must not. Keeping the allowlist to a single small module
    // means "does anything store user data in the browser" stays a one-file review.
    const allowed = ['src/dashboard/layout.ts', 'src/dashboard/library.ts'];
    const offenders = sources('src').filter(
      (file) =>
        !allowed.includes(file.replace(/\\/g, '/')) &&
        /localStorage|sessionStorage/.test(stripComments(readFileSync(file, 'utf8'))),
    );
    expect(offenders).toEqual([]);
  });

  it('never persists series data to localStorage', () => {
    const text = ['src/dashboard/layout.ts', 'src/dashboard/library.ts']
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n');
    // The only values written are the layout object; anything reaching for series, columns,
    // or samples here would mean capture data leaving OPFS for a synchronous browser store.
    const writes = [...text.matchAll(/localStorage\.setItem\(([^)]*)\)/g)].map((m) => m[1] ?? '');
    expect(writes.length).toBeGreaterThan(0);
    for (const w of writes) {
      expect(w).not.toMatch(/series|columns|samples|values|Float64/i);
    }
  });
});
