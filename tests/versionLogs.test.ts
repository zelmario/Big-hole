/**
 * The same operations, logged by PSMDB 4.0 through 8.0 with slowms 0.
 *
 * 4.0 and 4.2 are text. 4.4 and later are JSON. The fixtures are a synthetic `t.c`
 * collection from a lab, not a customer capture.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { analyzeLines } from '../src/logs/analyze.js';
import { severityByRow } from '../src/logs/queryHeat.js';
import type { QueryPattern } from '../src/logs/queries.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/psmdb-logs');

function score(raw: string): { unread: number; ops: number; row: QueryPattern | undefined; severity: number | null } {
  const report = analyzeLines([raw]).queries;
  const row = report.patterns[0];
  return {
    unread: report.unread,
    ops: report.ops,
    row,
    severity: row === undefined ? null : severityByRow([row]).get(row) ?? null,
  };
}

describe('versioned mongod logs', () => {
  const files = readdirSync(dir).filter((name) => name.endsWith('.log')).sort();

  it('covers 4.0 through 8.0', () => {
    expect(files.map((name) => name.replace(/^psmdb-|\.log$/g, ''))).toEqual([
      '4.0.28',
      '4.2.25',
      '4.4.29',
      '5.0.29',
      '6.0.29',
      '7.0.40',
      '8.0.29',
    ]);
  });

  for (const file of files) {
    const lines = readFileSync(join(dir, file), 'utf8').split('\n').filter((line) => line.trim() !== '');
    const text = file.startsWith('psmdb-4.0') || file.startsWith('psmdb-4.2');

    it(`${file} keeps a findAndModify delete, a no-op update, and a distinct off red`, () => {
      const fam = lines.filter((line) => /findAndModify/.test(line) && /remove"\s*:\s*true|remove:\s*true/.test(line));
      expect(fam).toHaveLength(1);
      const removed = score(fam[0]!);
      expect(removed.row?.op).toBe('findAndModify');
      expect(removed.row?.docsExamined).toBe(1);
      expect(removed.row?.returned).toBe(1);
      expect(removed.severity!).toBeLessThan(0.25);

      const distinct = lines.filter((line) => /distinct/.test(line) && /"key"\s*:\s*"s"|key:\s*"s"/.test(line));
      expect(distinct).toHaveLength(1);
      const values = score(distinct[0]!);
      expect(values.row?.op).toBe('distinct');
      expect(values.row?.docsExamined).toBe(20);
      expect(values.row?.yields).toBe(false);
      expect(values.severity!).toBeLessThan(0.25);

      const updates = lines.filter((line) => score(line).row?.op === 'update');
      const noop = updates.filter((line) => {
        const row = score(line).row!;
        return row.docsExamined === 1 && row.returned === 1 && row.pattern.includes('_id') && /nModified"\s*:\s*0|nModified:0/.test(line);
      });
      expect(noop).toHaveLength(1);
      expect(score(noop[0]!).severity!).toBeLessThan(0.25);

      const many = updates.filter((line) => {
        const row = score(line).row!;
        return row.docsExamined === 20 && row.returned === 20 && /nModified"\s*:\s*0|nModified:0/.test(line);
      });
      expect(many).toHaveLength(1);
      expect(score(many[0]!).severity!).toBeLessThan(0.25);

      const missed = updates.filter((line) => score(line).row!.docsExamined === 20 && score(line).row!.returned === 0);
      expect(missed.length).toBeGreaterThan(0);
      for (const line of missed) expect(score(line).severity!).toBeGreaterThan(0.9);
    });

    if (text) {
      it(`${file} reads update and remove lines`, () => {
        const writes = lines.filter((line) => /\b(?:update|remove) t\.c\b/.test(line));
        expect(writes).toHaveLength(7);
        for (const line of writes) {
          const parsed = score(line);
          expect(parsed.unread).toBe(0);
          expect(parsed.ops).toBe(1);
          expect(parsed.row?.op === 'update' || parsed.row?.op === 'remove').toBe(true);
          expect(parsed.row?.plan).not.toBe('');
          expect(parsed.row?.ns).toBe('t.c');
        }
      });
    }
  }
});
