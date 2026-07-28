/**
 * Log persistence round-trip: a reload brings the log back.
 *
 * Metrics survive a reload because ingest writes them to OPFS; logs used not to, because
 * attaching one produced only in-memory aggregates plus a browser File handle the browser
 * revokes on reload. This verifies the fix end to end against the NodeFileStore backend:
 * persist a log, throw away all in-memory state by opening a *fresh* store over the same
 * directory (exactly what a reload is), and confirm both the annotations and the raw bytes the
 * viewer reads come back identical -- with no reference to the original dropped file.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NodeFileStore } from '../src/data/nodeFileStore.js';
import { hasStoredLog, persistAndAnalyze, restoreLog } from '../src/logs/logStore.js';
import { analyzeLines } from '../src/logs/analyze.js';
import { parseLine, emptyStats } from '../src/logs/parse.js';
import { rangeFor } from '../src/logs/locate.js';

/** Real-shaped lines across a few minutes: rare replication events plus high-volume noise. */
function fixtureLines(): string[] {
  const at = (t: string) => `2026-07-20T${t}-05:00`;
  const lines: string[] = [];
  // A base of connection + slow-query noise, the high-volume classes that become series.
  for (let i = 0; i < 40; i++) {
    const s = String(i % 60).padStart(2, '0');
    lines.push(
      `{"t":{"$date":"${at(`03:38:${s}.000`)}"},"s":"I","c":"NETWORK","id":22943,"ctx":"listener","msg":"Connection accepted","attr":{"remote":"10.0.0.${i}:5000"}}`,
    );
    lines.push(
      `{"t":{"$date":"${at(`03:39:${s}.171`)}"},"s":"I","c":"COMMAND","id":51803,"ctx":"conn${i}","msg":"Slow query","attr":{"type":"command","ns":"appdb.events","durationMillis":${100 + i}}}`,
    );
  }
  // The two rare events that must not be drowned -- and the reason the log matters at all.
  lines.push(
    `{"t":{"$date":"${at('03:41:09.910')}"},"s":"W","c":"REPL","id":21122,"ctx":"BackgroundSync","msg":"Oplog fetcher stopped querying remote oplog with error","attr":{"error":"NetworkTimeout: Error while getting the next batch in the oplog fetcher"}}`,
  );
  lines.push(
    `{"t":{"$date":"${at('03:41:09.911')}"},"s":"I","c":"REPL","id":21080,"ctx":"BackgroundSync","msg":"Clearing sync source to choose a new one","attr":{"syncSource":"mongod-b3.example.net:27017"}}`,
  );
  return lines;
}

describe('log persistence', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ftdc-logstore-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('brings the log back after a reload, annotations and raw bytes both', async () => {
    const lines = fixtureLines();
    const content = lines.join('\n') + '\n';
    const file = new File([content], 'mongod.log');

    // Attach: persist the log into the capture's OPFS directory and build its annotations.
    const attachStore = new NodeFileStore(dir);
    const attached = await persistAndAnalyze(attachStore, 'c0', [file], undefined, undefined);

    // The annotations are exactly what analysing the lines directly would produce.
    const expected = analyzeLines(lines);
    expect(attached.events.map((e) => e.kind)).toEqual(expected.events.map((e) => e.kind));
    expect(attached.stats.counts).toEqual(expected.stats.counts);
    expect(Object.keys(attached.series).sort()).toEqual(Object.keys(expected.series).sort());

    // --- the reload: a brand-new store over the same directory, no in-memory state carried. ---
    const reloadStore = new NodeFileStore(dir);
    expect(await hasStoredLog(reloadStore, 'c0')).toBe(true);

    const restored = await restoreLog(reloadStore, 'c0');
    expect(restored).not.toBeNull();

    // Annotations rebuilt identically from disk.
    expect(restored!.analysis.events.map((e) => e.kind)).toEqual(expected.events.map((e) => e.kind));
    expect(restored!.analysis.events.map((e) => e.detail)).toEqual(expected.events.map((e) => e.detail));
    expect(restored!.analysis.stats.counts).toEqual(expected.stats.counts);
    expect(Object.keys(restored!.analysis.series).sort()).toEqual(Object.keys(expected.series).sort());
    // The rare replication events survived the round-trip with their marker detail intact.
    expect(restored!.analysis.events.find((e) => e.kind === 'syncSource')?.detail).toContain(
      'mongod-b3',
    );

    // The raw bytes the viewer reads are byte-for-byte the log, from a Blob with no File behind
    // it -- this is what makes the `less` window work after a reload.
    const blob = restored!.files[0]!;
    expect(blob.size).toBe(content.length);
    const back = await blob.text();
    expect(back).toBe(content);

    // And a positioned read -- the log viewer's actual data path -- yields the lines in order.
    const range = await rangeFor(blob, undefined, undefined);
    const slice = await blob.slice(range.from, range.to).text();
    const read = slice
      .split('\n')
      .map((raw) => parseLine(raw, emptyStats()))
      .filter((l): l is NonNullable<typeof l> => l !== null);
    expect(read).toHaveLength(lines.length);
  });

  it('reports no stored log for a capture that never had one', async () => {
    const store = new NodeFileStore(dir);
    expect(await hasStoredLog(store, 'c9')).toBe(false);
    expect(await restoreLog(store, 'c9')).toBeNull();
  });
});
