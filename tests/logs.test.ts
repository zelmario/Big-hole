/**
 * Log correlation.
 *
 * The failure mode is volume, not parsing. A real 73 MB customer log holds 19,220 connection
 * events and 18,485 TLS warnings against 5 sync-source changes, and a correlator that draws
 * everything hides the five lines that explain the incident. So most of this is about what
 * gets shown, not what gets read.
 */

import { describe, expect, it } from 'vitest';

import { analyzeLines, logMetricLabel } from '../src/logs/analyze.js';
import { classify, RULES } from '../src/logs/classify.js';
import { attrOf, durationOf, emptyStats, looksLikeMongodLog, parseLine } from '../src/logs/parse.js';
import { logExpressionKind } from '../src/logs/logSource.js';
import { dropOverlap, pageSize, type OverlapLine } from '../src/logs/paging.js';
import { groupLogs, isFtdcFile, isLogFile, type SourceFile } from '../src/ingest/discover.js';

/** Real lines, copied from a customer capture with hostnames left as they were. */
const REAL = {
  slow: '{"t":{"$date":"2026-07-20T03:38:36.171-05:00"},"s":"I","c":"COMMAND","id":51803,"ctx":"conn7","msg":"Slow query","attr":{"type":"command","ns":"db.objectdata_v2","durationMillis":936}}',
  fetcher:
    '{"t":{"$date":"2026-07-20T03:41:09.910-05:00"},"s":"W","c":"REPL","id":21122,"ctx":"BackgroundSync","msg":"Oplog fetcher stopped querying remote oplog with error","attr":{"error":"NetworkTimeout: Error while getting the next batch in the oplog fetcher"}}',
  syncSource:
    '{"t":{"$date":"2026-07-20T03:41:09.910-05:00"},"s":"I","c":"REPL","id":21080,"ctx":"BackgroundSync","msg":"Clearing sync source to choose a new one","attr":{"syncSource":"mongod-b3.example.net:27100"}}',
  connection:
    '{"t":{"$date":"2026-07-20T03:38:35.000-05:00"},"s":"I","c":"NETWORK","id":22943,"ctx":"listener","msg":"Connection accepted","attr":{"remote":"10.0.0.1:5000"}}',
  tls: '{"t":{"$date":"2026-07-20T03:38:35.000-05:00"},"s":"W","c":"NETWORK","id":23234,"ctx":"conn1","msg":"No SSL certificate provided by peer"}',
};

describe('parsing mongod JSON logs', () => {
  it('reads the absolute instant, honouring the log\'s own UTC offset', () => {
    const stats = emptyStats();
    const line = parseLine(REAL.slow, stats)!;
    // -05:00 in the log; the axis is absolute, so this must be 08:38:36Z and not 03:38:36Z.
    expect(new Date(line.tMs).toISOString()).toBe('2026-07-20T08:38:36.171Z');
    expect(line.id).toBe(51803);
    expect(stats.parsed).toBe(1);
  });

  it('unwraps a syslog prefix, which collected bundles almost always have', () => {
    // "Jul 15 06:52:31 host mongo[3731]: {json}" -- 2.5 GB of a real customer bundle looks
    // exactly like this, and rejecting it reported "0 lines parsed" on a perfectly good log.
    const stats = emptyStats();
    const wrapped = `Jul 15 06:52:31 ip-10-0-0-152 mongo[3731]: ${REAL.slow}`;
    const line = parseLine(wrapped, stats)!;
    expect(line.id).toBe(51803);
    expect(stats.wrapped).toBe(1);
    expect(looksLikeMongodLog(wrapped)).toBe(true);
  });

  it('reads the header without parsing the document', () => {
    // A slow-query line carries its whole command; real ones reach 11 KB. Classification needs
    // none of it, and parsing every one is most of the cost of reading a log.
    const fat = REAL.slow.replace('"durationMillis":936', `"filter":{"x":"${'y'.repeat(9000)}"},"durationMillis":936`);
    const stats = emptyStats();
    const line = parseLine(fat, stats)!;
    expect(line.msg).toBe('Slow query');
    expect(durationOf(fat)).toBe(936);
    // The document is available when something actually needs it.
    expect(attrOf(fat)?.['ns']).toBe('db.objectdata_v2');
  });

  it('counts unparsable lines instead of throwing', () => {
    const stats = emptyStats();
    // A truncated final line and a pre-4.4 text line: both routine in a support bundle.
    expect(parseLine('{"t":{"$date":"2026-07-2', stats)).toBeNull();
    expect(parseLine('2026-07-20T03:38:35.067-0500 I CONTROL [main] ***** SERVER RESTARTED', stats)).toBeNull();
    expect(parseLine('', stats)).toBeNull();
    expect(stats.malformed).toBe(1);
    expect(stats.text).toBe(1);
  });

  it('recognises both log formats, so an old one can be reported rather than ignored', () => {
    expect(looksLikeMongodLog(REAL.slow)).toBe(true);
    expect(looksLikeMongodLog('2026-07-20T03:38:35.067-0500 I CONTROL  [main] MongoDB starting')).toBe(true);
    expect(looksLikeMongodLog('hello\nworld')).toBe(false);
  });
});

describe('classification', () => {
  const parse = (raw: string) => parseLine(raw, emptyStats())!;

  it('keys off the statement id, which survives rewordings', () => {
    expect(classify(parse(REAL.syncSource))?.kind).toBe('syncSource');
    expect(classify(parse(REAL.fetcher))?.kind).toBe('oplogFetcher');
  });

  it('sends high-volume classes to series, never to markers', () => {
    expect(classify(parse(REAL.slow))?.mode).toBe('count');
    expect(classify(parse(REAL.connection))?.mode).toBe('count');
    // 18,485 of these in one real log. As markers they would erase everything else.
    expect(classify(parse(REAL.tls))?.mode).toBe('count');
  });

  it('marks the rare replication events', () => {
    expect(classify(parse(REAL.syncSource))?.mode).toBe('annotate');
    expect(classify(parse(REAL.fetcher))?.mode).toBe('annotate');
  });

  it('has no rule that matches everything', () => {
    // A rule with only an `ids` list must not fall through to matching on nothing.
    const line = parse(REAL.connection);
    const idOnly = RULES.filter((r) => r.ids !== undefined && r.component === undefined && r.contains === undefined);
    for (const rule of idOnly) {
      if (!rule.ids!.includes(line.id)) {
        expect(
          classify(line)?.kind === rule.kind && rule.kind !== 'connection',
          `${rule.kind} claimed an unrelated line`,
        ).toBe(false);
      }
    }
  });
});

describe('analysis', () => {
  it('turns rare events into markers and frequent ones into series', () => {
    const lines = [REAL.fetcher, REAL.syncSource, ...Array<string>(50).fill(REAL.slow)];
    const out = analyzeLines(lines);

    expect(out.events.map((e) => e.kind)).toEqual(['oplogFetcher', 'syncSource']);
    expect(out.stats.counts['slowQuery']).toBe(50);
    // 50 slow queries produced a series, not 50 markers.
    expect(out.series['logs.slowQuery.count']).toBeDefined();
    expect(out.series['logs.slowQuery.p95Ms']).toBeDefined();
  });

  it('carries the one attribute worth reading on the marker', () => {
    const out = analyzeLines([REAL.syncSource]);
    expect(out.events[0]!.detail).toContain('mongod-b3');
  });

  it('demotes an annotation class that turns out to be frequent', () => {
    // A rule that is rare on one server can be constant on another. Being wrong about that
    // should degrade the display, not destroy it.
    const many = Array.from({ length: 40 }, () => REAL.syncSource);
    const out = analyzeLines(many, { annotationLimit: 10 });

    expect(out.events).toHaveLength(0);
    expect(out.stats.demoted).toEqual([{ kind: 'syncSource', count: 40 }]);
    // The data is not lost -- it is a rate now.
    expect(out.series['logs.syncSource.count']).toBeDefined();
  });

  it('reports per-second rates, so bucket width does not change the meaning', () => {
    const out = analyzeLines(Array<string>(10).fill(REAL.slow), { bucketMs: 10_000 });
    const v = out.series['logs.slowQuery.count']!.v;
    expect(Math.max(...Array.from(v))).toBeCloseTo(1, 5); // 10 events in a 10 s bucket
  });

  it('survives a log with nothing recognisable in it', () => {
    const out = analyzeLines(['not json', '{"t":{"$date":"nope"},"msg":"x"}']);
    expect(out.events).toEqual([]);
    expect(out.stats.text).toBe(1);
    expect(out.stats.malformed).toBe(1);
  });

  it('labels its metrics for the legend', () => {
    expect(logMetricLabel('logs.slowQuery.p95Ms')).toBe('Slow query p95');
    expect(logMetricLabel('logs.syncSource.count')).toBe('Sync source change/s');
  });
});

describe('log series in expressions', () => {
  it('separates log expressions from metric ones', () => {
    expect(logExpressionKind('logs.slowQuery.p95Ms')).toBe('logs');
    expect(logExpressionKind('serverStatus.mem.resident')).toBe('metrics');
    // Two different clocks. Refused by name rather than silently joined.
    expect(logExpressionKind('div(logs.slowQuery.count, serverStatus.opcounters.query)')).toBe('mixed');
  });
});

describe('finding logs in a bundle', () => {
  const source = (path: string): SourceFile => ({
    file: new File([], path.split('/').pop()!),
    path,
  });

  it('recognises the names real bundles use', () => {
    expect(isLogFile('mongod.log')).toBe(true);
    expect(isLogFile('mongod-a1_mongodb.log')).toBe(true);
    expect(isLogFile('mongodb.log-202607210201')).toBe(true);
    expect(isLogFile('metrics.2026-07-20T00-00-00Z-00000')).toBe(false);
    // Compressed logs would need inflating first; claiming them would fail at parse time.
    expect(isLogFile('mongod.log.gz')).toBe(false);
    // An NTFS alternate data stream, which a capture that came through Windows carries one of
    // per file. Rejected here already, because ':' is none of the separators `.log` may precede.
    expect(isLogFile('mongo_log_36h.log:Zone.Identifier')).toBe(false);
  });

  /**
   * A capture downloaded on Windows and read from WSL brings one `<name>:Zone.Identifier` stub
   * per file -- a 26-byte `[ZoneTransfer]` marker. They begin with `metrics.` like the real
   * files, so taking them as FTDC means half the folder fails to decode and the skipped list
   * fills with non-files, hiding any capture that is genuinely corrupt.
   */
  it('ignores Windows alternate data streams beside the metrics files', () => {
    expect(isFtdcFile('metrics.2026-07-15T00-35-59Z-00000')).toBe(true);
    expect(isFtdcFile('metrics.interim')).toBe(true);
    expect(isFtdcFile('metrics.2026-07-15T00-35-59Z-00000:Zone.Identifier')).toBe(false);
    expect(isFtdcFile('metrics.interim:Zone.Identifier')).toBe(false);
    // A directory prefix is stripped before the check, so the stream suffix is still caught.
    expect(isFtdcFile('node1/diagnostic.data/metrics.x:Zone.Identifier')).toBe(false);
  });

  it('attaches each log to the node it sits closest to', () => {
    const sources = [
      source('bundle/node1/diagnostic.data/metrics.1'),
      source('bundle/node1/mongod.log'),
      source('bundle/node2/diagnostic.data/metrics.1'),
      source('bundle/node2/mongod.log'),
    ];
    const groups = [
      { key: 'bundle/node1/diagnostic.data', label: 'node1', files: [] as File[] },
      { key: 'bundle/node2/diagnostic.data', label: 'node2', files: [] as File[] },
    ];
    const logs = groupLogs(sources, groups);
    expect(logs.get('bundle/node1/diagnostic.data')?.[0]?.name).toBe('mongod.log');
    expect(logs.get('bundle/node2/diagnostic.data')).toHaveLength(1);
  });

  it('gives every log to the only node when there is one', () => {
    const groups = [{ key: 'diagnostic.data', label: 'n', files: [] as File[] }];
    const logs = groupLogs([source('logs/mongod.log')], groups);
    expect(logs.get('diagnostic.data')).toHaveLength(1);
  });
});

/* ------------------------------------------------------- paging the buffer ---- */

/**
 * The seam between one page of the log viewer's buffer and the next.
 *
 * A page boundary is requested inclusively -- a millisecond holds many lines and "strictly
 * after" would skip whatever fell past the cap -- so the boundary instant always comes back
 * twice and the duplicate has to be removed without removing anything real.
 */
describe('joining log pages', () => {
  const line = (tMs: number, msg: string, attr = ''): OverlapLine & { id: string } => ({
    captureId: 'c0',
    tMs,
    msg,
    attr,
    id: `${tMs}/${msg}/${attr}`,
  });

  it('removes the lines the buffer already holds', () => {
    const held = [line(100, 'a'), line(100, 'b')];
    const page = [line(100, 'a'), line(100, 'b'), line(101, 'c')];
    expect(dropOverlap(page, held).map((l) => l.id)).toEqual(['101/c/']);
  });

  /**
   * The case a Set gets wrong, and gets wrong silently. A log repeats itself verbatim inside one
   * millisecond -- three connections accepted at once differ only past the port, and `attr` is
   * truncated before the viewer ever sees it. Keying on content would delete the two extra
   * copies as duplicates and quietly shorten a burst, which is usually the thing being read.
   */
  it('keeps repeated lines the buffer does not hold, counting rather than matching', () => {
    const held = [line(100, 'connection accepted')];
    const page = [
      line(100, 'connection accepted'),
      line(100, 'connection accepted'),
      line(100, 'connection accepted'),
    ];
    expect(dropOverlap(page, held)).toHaveLength(2);
  });

  it('leaves a page alone when the buffer holds nothing at the boundary', () => {
    const page = [line(100, 'a'), line(101, 'b')];
    expect(dropOverlap(page, [])).toHaveLength(2);
  });

  it('distinguishes lines that differ only by node', () => {
    const held = [{ ...line(100, 'a'), captureId: 'c0' }];
    const page = [
      { ...line(100, 'a'), captureId: 'c0' },
      { ...line(100, 'a'), captureId: 'c1' },
    ];
    expect(dropOverlap(page, held).map((l) => l.captureId)).toEqual(['c1']);
  });

  it('replaces a third of the buffer per page, with a floor for small ones', () => {
    expect(pageSize(3000)).toBe(1000);
    expect(pageSize(10000)).toBe(3333);
    // Two thirds of what was on screen has to survive, but a tiny buffer would page one line at
    // a time; the floor keeps a scroll from turning into a round trip per row.
    expect(pageSize(120)).toBe(200);
  });
});
