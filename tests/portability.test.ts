/**
 * The repository has to work on a filesystem that ignores case.
 *
 * Linux does not, macOS and Windows do by default, and the difference is invisible until someone
 * else clones the repo. It cost a colleague their first `npm run dev`:
 *
 *   src/insights/explain.ts   the ranking logic
 *   src/insights/Explain.tsx  the React component
 *
 * Those two names never collide as *files* -- the extensions differ. What collides is module
 * resolution. `import { Explain } from './Explain.js'` makes the resolver try the configured
 * extensions in order, `.ts` before `.tsx`, so on a case-insensitive filesystem `Explain.ts`
 * matched `explain.ts`, the wrong module, and esbuild reported "No matching export ... for import
 * Explain" -- an error that names the symbol and says nothing about the cause. On Linux
 * `Explain.ts` simply does not exist, the resolver falls through to `Explain.tsx`, and everything
 * works.
 *
 * So the rule is stricter than "no two files with the same name": within a directory, no two
 * files may share a name once case and extension are removed.
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { dirname, basename, extname, join } from 'node:path';

/** Tracked files, from git, so untracked scratch files never fail the build. */
function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
}

describe('checking out on a case-insensitive filesystem', () => {
  it('has no two paths differing only in case', () => {
    const byLower = new Map<string, string[]>();
    for (const file of trackedFiles()) {
      const key = file.toLowerCase();
      byLower.set(key, [...(byLower.get(key) ?? []), file]);
    }
    const clashes = [...byLower.values()].filter((paths) => paths.length > 1);
    expect(clashes, `these cannot coexist on macOS or Windows:\n${JSON.stringify(clashes)}`).toEqual(
      [],
    );
  });

  it('has no two modules in a directory whose names differ only in case or extension', () => {
    // Only source files: a `.md` next to a `.ts` is never reached by module resolution.
    const CODE = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
    const byStem = new Map<string, string[]>();

    for (const file of trackedFiles()) {
      const ext = extname(file);
      if (!CODE.has(ext)) continue;
      const stem = join(dirname(file), basename(file, ext)).toLowerCase();
      byStem.set(stem, [...(byStem.get(stem) ?? []), file]);
    }

    const ambiguous = [...byStem.entries()].filter(([, paths]) => paths.length > 1);
    expect(
      ambiguous,
      `an import of one of these resolves to the other on a case-insensitive filesystem, ` +
        `and the error names a missing export rather than the real cause:\n` +
        ambiguous.map(([stem, paths]) => `  ${stem}: ${paths.join(', ')}`).join('\n'),
    ).toEqual([]);
  });
});
