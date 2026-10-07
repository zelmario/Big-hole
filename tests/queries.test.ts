/**
 * Query-shape reports from mongod logs, including a log that has no FTDC beside it.
 *
 * The thing being protected is grouping: two slow finds that differ only in the literal they
 * searched for are one query, and a collection scan has to say so. A heartbeat is not a query.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { groupLogCaptures, type SourceFile } from '../src/ingest/discover.js';
import { analyzeLines } from '../src/logs/analyze.js';
import { severityByRow } from '../src/logs/queryHeat.js';
import { parseSlowOp } from '../src/logs/queryShape.js';
import { attrOf } from '../src/logs/parse.js';

function line(attr: Record<string, unknown>, id = 51803): string {
  return JSON.stringify({
    t: { $date: '2026-07-20T03:38:36.171-05:00' },
    s: 'I',
    c: 'COMMAND',
    id,
    ctx: 'conn7',
    msg: 'Slow query',
    attr,
  });
}

function shape(attr: Record<string, unknown>) {
  const parsed = parseSlowOp(attr);
  if (parsed.kind !== 'op') throw new Error(`expected an op, got ${parsed.kind}`);
  return parsed.shape;
}

describe('what a slow query is doing', () => {
  it('groups calls that differ only by the literal they searched for', () => {
    const a = line({
      type: 'command',
      ns: 'demo.events',
      command: { find: 'events', filter: { n: { $gt: 10 } }, limit: 20, $db: 'demo' },
      planSummary: 'COLLSCAN',
      docsExamined: 1000,
      nreturned: 1,
      durationMillis: 400,
    });
    const b = line({
      type: 'command',
      ns: 'demo.events',
      command: { find: 'events', filter: { n: { $gt: 999 } }, limit: 20, $db: 'demo' },
      planSummary: 'COLLSCAN',
      docsExamined: 5000,
      nreturned: 20,
      durationMillis: 900,
      appName: 'checkout',
    });
    const report = analyzeLines([a, b]).queries;
    expect(report.ops).toBe(2);
    expect(report.patterns).toHaveLength(1);
    const row = report.patterns[0]!;
    expect(row.op).toBe('find');
    expect(row.ns).toBe('demo.events');
    expect(row.pattern).toBe('{ n: { $gt: 1 } }');
    expect(row.collscan).toBe(true);
    expect(row.count).toBe(2);
    expect(row.totalMs).toBe(1300);
    expect(row.maxMs).toBe(900);
    expect(row.docsExamined).toBe(6000);
    expect(row.doing).toContain('demo.events');
    expect(row.doing).toContain('Collection scan');
    expect(row.appNames).toEqual(['checkout']);
  });

  it('keeps the slowest call whole, so the literal the shape hides can still be read', () => {
    const at = (iso: string, ms: number, regex: string) =>
      JSON.stringify({
        t: { $date: iso },
        s: 'I',
        c: 'COMMAND',
        id: 51803,
        ctx: 'conn7',
        msg: 'Slow query',
        attr: {
          type: 'command',
          ns: 'demo.events',
          command: { find: 'events', filter: { blob: { $regularExpression: { pattern: regex, options: '' } } }, $db: 'demo' },
          planSummary: 'COLLSCAN',
          durationMillis: ms,
        },
      });
    const report = analyzeLines([
      at('2026-08-05T00:01:00.000Z', 48, 'abc'),
      at('2026-08-05T00:02:00.000Z', 332, '^zz'),
      at('2026-08-05T00:03:00.000Z', 332, 'later'),
    ]).queries;
    expect(report.patterns).toHaveLength(1);
    const row = report.patterns[0]!;
    expect(row.pattern).toBe('{ blob: /…/ }');
    // The first of two equally slow calls, so the choice does not move as the log grows.
    expect(row.slowest?.tMs).toBe(Date.parse('2026-08-05T00:02:00.000Z'));
    expect(row.slowest?.durationMs).toBe(332);
    expect(row.slowest?.command).toContain('"pattern": "^zz"');
  });

  it('keeps the command that opened the cursor beside a slow getMore', () => {
    const report = analyzeLines([
      line({
        type: 'getMore',
        ns: 'demo.events',
        command: { getMore: 42, collection: 'events', $db: 'demo' },
        originatingCommand: { find: 'events', filter: { n: { $gt: 7 } }, $db: 'demo' },
        durationMillis: 90,
      }),
    ]).queries;
    const command = JSON.parse(report.patterns[0]!.slowest!.command) as Record<string, unknown>;
    expect(command['command']).toEqual({ getMore: 42, collection: 'events', $db: 'demo' });
    expect(command['originatingCommand']).toEqual({ find: 'events', filter: { n: { $gt: 7 } }, $db: 'demo' });
  });

  it('keeps an indexed find apart from the collection scan of the same predicate', () => {
    const scan = line({
      type: 'command',
      ns: 'app.orders',
      command: { find: 'orders', filter: { status: 'open' }, $db: 'app' },
      planSummary: 'COLLSCAN',
      durationMillis: 200,
    });
    const index = line({
      type: 'command',
      ns: 'app.orders',
      command: { find: 'orders', filter: { status: 'closed' }, $db: 'app' },
      planSummary: 'IXSCAN { status: 1 }',
      keysExamined: 4,
      nreturned: 4,
      durationMillis: 12,
    });
    const report = analyzeLines([scan, index]).queries;
    expect(report.patterns).toHaveLength(2);
    expect(report.patterns.map((p) => p.collscan).sort()).toEqual([false, true]);
    const indexed = report.patterns.find((p) => !p.collscan)!;
    expect(indexed.pattern).toBe('{ status: 1 }');
    expect(indexed.doing).toContain('IXSCAN { status: 1 }');
  });

  it('replaces object ids and collapses $in lists', () => {
    const parsed = shape({
      type: 'command',
      ns: 'app.users',
      command: {
        find: 'users',
        filter: { _id: { $oid: '64b1f2e2e13e4a1a1a1a1a1a' }, tag: { $in: ['a', 'b', 'c'] } },
        $db: 'app',
      },
      planSummary: 'IDHACK',
      durationMillis: 5,
    });
    expect(parsed.pattern).toBe('{ _id: 1, tag: { $in: […] } }');
  });

  it('keeps a regular expression as a pattern, not as its text', () => {
    const parsed = shape({
      type: 'command',
      ns: 'demo.events',
      command: {
        find: 'events',
        filter: { blob: { $regex: 'a]{200}', $options: '' } },
        $db: 'demo',
      },
      planSummary: 'COLLSCAN',
      durationMillis: 100,
    });
    expect(parsed.pattern).toBe('{ blob: /…/ }');
    expect(parsed.doing).toContain('/…/');
  });

  it('describes an update by its query and the operator it applied', () => {
    const parsed = shape({
      type: 'update',
      ns: 'app.users',
      command: {
        update: 'users',
        updates: [{ q: { _id: { $oid: 'abc' } }, u: { $set: { name: 'ada' } } }],
        $db: 'app',
      },
      planSummary: 'IXSCAN { _id: 1 }',
      durationMillis: 30,
      nMatched: 1,
    });
    expect(parsed.op).toBe('update');
    expect(parsed.pattern).toBe('{ _id: 1 }');
    expect(parsed.doing).toContain('Updates documents in app.users');
    expect(parsed.doing).toContain('$set');
    expect(parsed.returned).toBe(1);
  });

  it('describes an aggregation by its stages and the $match', () => {
    const parsed = shape({
      type: 'command',
      ns: 'demo.events',
      command: {
        aggregate: 'events',
        pipeline: [{ $match: { n: { $gt: 3 } } }, { $group: { _id: '$user', n: { $sum: 1 } } }],
        $db: 'demo',
      },
      planSummary: 'COLLSCAN',
      durationMillis: 800,
    });
    expect(parsed.op).toBe('aggregate');
    expect(parsed.pattern).toBe('{ n: { $gt: 1 } }');
    expect(parsed.doing).toContain('$match → $group');
    expect(parsed.doing).toContain('Collection scan');
  });

  it('reads a getMore as the query that opened the cursor', () => {
    const parsed = shape({
      type: 'command',
      ns: 'demo.events',
      command: { getMore: 42, collection: 'events', $db: 'demo' },
      originatingCommand: { find: 'events', filter: { n: { $gt: 1 } }, $db: 'demo' },
      planSummary: 'COLLSCAN',
      durationMillis: 50,
    });
    expect(parsed.op).toBe('getMore');
    expect(parsed.pattern).toBe('{ n: { $gt: 1 } }');
    expect(parsed.doing).toContain('next batch of a find');
    expect(parsed.doing).toContain('demo.events');
  });

  it('counts heartbeats instead of listing them as queries', () => {
    const hello = line({
      type: 'command',
      ns: 'admin.$cmd',
      command: { hello: 1, $db: 'admin' },
      durationMillis: 200,
    });
    const report = analyzeLines([hello]).queries;
    expect(report.patterns).toHaveLength(0);
    expect(report.internal).toBe(1);
    expect(report.ops).toBe(0);
  });

  it('describes the index a createIndexes command is building', () => {
    const parsed = shape({
      type: 'command',
      ns: 'app.orders',
      command: {
        createIndexes: 'orders',
        indexes: [{ name: 'byStatus', key: { status: 1, created: -1 } }],
        $db: 'app',
      },
      durationMillis: 40,
    });
    expect(parsed.op).toBe('createIndexes');
    expect(parsed.pattern).toBe('{ status: 1, created: -1 }');
    expect(parsed.doing).toContain('Creates an index on app.orders');
  });

  it('says when a find matches every document', () => {
    const parsed = shape({
      type: 'command',
      ns: 'app.events',
      command: { find: 'events', filter: {}, $db: 'app' },
      planSummary: 'COLLSCAN',
      durationMillis: 100,
    });
    expect(parsed.doing).toContain('empty filter');
  });
});

describe('operations that were logged without being slow', () => {
  it('includes a command whose statement id is not a slow-query id', () => {
    const fast = line(
      {
        type: 'command',
        ns: 'app.orders',
        command: { find: 'orders', filter: { sku: 'abc' }, $db: 'app' },
        planSummary: 'IXSCAN { sku: 1 }',
        durationMillis: 4,
      },
      20250,
    );
    const report = analyzeLines([fast]).queries;
    expect(report.ops).toBe(1);
    expect(report.patterns[0]!.op).toBe('find');
    expect(report.patterns[0]!.maxMs).toBe(4);
  });

  it('reads a system.profile document, including one under the slow threshold', () => {
    const profile = JSON.stringify({
      op: 'query',
      ns: 'app.orders',
      command: { find: 'orders', filter: { sku: 'abc' }, $db: 'app' },
      millis: 12,
      ts: { $date: '2026-09-18T00:00:00.000Z' },
      planSummary: 'IXSCAN { sku: 1 }',
      docsExamined: 3,
      nreturned: 1,
    });
    const report = analyzeLines([profile]).queries;
    expect(report.ops).toBe(1);
    expect(report.patterns[0]!.ns).toBe('app.orders');
    expect(report.patterns[0]!.pattern).toBe('{ sku: 1 }');
    expect(report.patterns[0]!.maxMs).toBe(12);
  });

  it('reads a profiler getMore from its originating command', () => {
    const profile = JSON.stringify({
      op: 'getmore',
      ns: 'app.orders',
      command: { getMore: 7, collection: 'orders', $db: 'app' },
      originatingCommand: { find: 'orders', filter: { sku: 'abc' }, $db: 'app' },
      millis: 20,
      ts: { $date: '2026-09-18T00:00:01.000Z' },
      planSummary: 'IXSCAN { sku: 1 }',
    });
    const report = analyzeLines([profile]).queries;
    expect(report.patterns[0]!.op).toBe('getMore');
    expect(report.patterns[0]!.pattern).toBe('{ sku: 1 }');
  });

  it('names findAndModify from the first key, not from its update field', () => {
    const parsed = shape({
      type: 'command',
      ns: 'app.$cmd',
      command: {
        findAndModify: 'orders',
        query: { _id: 1 },
        update: { $set: { n: 2 } },
        $db: 'app',
      },
      planSummary: 'IDHACK',
      durationMillis: 4,
    });
    expect(parsed.op).toBe('findAndModify');
    expect(parsed.ns).toBe('app.orders');
    expect(parsed.doing).toContain('Modifies and returns');
    expect(parsed.doing).toContain('$set');
  });

  it('scores a fast idhack delete from ndeleted, not as a query that returned nothing', () => {
    const report = analyzeLines([
      line({
        type: 'remove',
        ns: 'app.orders',
        command: { q: { _id: 1 }, limit: 1 },
        planSummary: 'IDHACK',
        keysExamined: 1,
        docsExamined: 1,
        ndeleted: 1,
        durationMillis: 2,
      }),
    ]).queries;
    const row = report.patterns[0]!;
    expect(row.op).toBe('remove');
    expect(row.returned).toBe(1);
    expect(row.yields).toBe(true);
    expect(severityByRow([row]).get(row)!).toBeLessThan(0.25);
  });

  it('does not score a fast count as if it had returned nothing', () => {
    const report = analyzeLines([
      line({
        type: 'command',
        ns: 'app.$cmd',
        command: { count: 'orders', query: { _id: 1 }, $db: 'app' },
        planSummary: 'IDHACK',
        docsExamined: 1,
        durationMillis: 2,
      }),
    ]).queries;
    const row = report.patterns[0]!;
    expect(row.op).toBe('count');
    expect(row.yields).toBe(false);
    expect(severityByRow([row]).get(row)!).toBeLessThan(0.25);
  });

  it('reads a pre-4.4 text command, shell syntax included', () => {
    const text =
      '2026-07-20T03:38:35.067-0500 I COMMAND  [conn1] command app.orders command: find { find: "orders", filter: { sku: "abc" }, $db: "app" } planSummary: IXSCAN { sku: 1 } 8ms';
    const report = analyzeLines([text]).queries;
    expect(report.ops).toBe(1);
    expect(report.patterns[0]!.ns).toBe('app.orders');
    expect(report.patterns[0]!.pattern).toBe('{ sku: 1 }');
    expect(report.patterns[0]!.maxMs).toBe(8);
  });

  it('keeps documents examined and returned on a pre-4.4 text line', () => {
    const text =
      '2026-07-20T03:38:35.067-0500 I COMMAND  [conn1] command app.orders command: find { find: "orders", filter: { sku: "abc" } } planSummary: COLLSCAN keysExamined:0 docsExamined:100000 nreturned:64 150ms';
    const row = analyzeLines([text]).queries.patterns[0]!;
    expect(row.collscan).toBe(true);
    expect(row.keysExamined).toBe(0);
    expect(row.docsExamined).toBe(100_000);
    expect(row.returned).toBe(64);
    expect(row.yields).toBe(true);
  });

  it('reads an update and a remove logged with a top-level q and u', () => {
    const update = line({
      type: 'update',
      ns: 'app.buildings',
      command: { q: { _id: { $oid: 'abc' } }, u: { $set: { name: 'ada' } }, multi: false },
      planSummary: 'IDHACK',
      durationMillis: 1100,
    });
    const remove = line({
      type: 'remove',
      ns: 'app.buildings',
      command: { q: { uuid: 'x' } },
      planSummary: 'IXSCAN { uuid: 1 }',
      durationMillis: 1200,
    });
    const report = analyzeLines([update, remove]).queries;
    expect(report.ops).toBe(2);
    const updated = report.patterns.find((p) => p.op === 'update')!;
    expect(updated.pattern).toBe('{ _id: 1 }');
    expect(updated.doing).toContain('$set');
    const removed = report.patterns.find((p) => p.op === 'remove')!;
    expect(removed.pattern).toBe('{ uuid: 1 }');
    expect(removed.doing).toContain('Deletes');
  });

  it('keeps every distinct shape, including a predicate longer than a few hundred characters', () => {
    const lines = Array.from({ length: 30 }, (_, i) =>
      line({
        type: 'command',
        ns: 'app.events',
        command: { find: 'events', filter: { [`f${i}`]: i }, $db: 'app' },
        planSummary: 'COLLSCAN',
        durationMillis: 5,
      }),
    );
    const wide: Record<string, number> = {};
    for (let i = 0; i < 80; i++) wide[`field${String(i).padStart(3, '0')}`] = i;
    lines.push(
      line({
        type: 'command',
        ns: 'app.events',
        command: { find: 'events', filter: wide, $db: 'app' },
        planSummary: 'COLLSCAN',
        durationMillis: 5,
      }),
    );
    const report = analyzeLines(lines).queries;
    expect(report.patterns).toHaveLength(31);
    expect(report.ungrouped).toBe(0);
    expect(report.ops).toBe(31);
    const longest = report.patterns.reduce((a, b) => (a.pattern.length > b.pattern.length ? a : b));
    expect(longest.pattern.length).toBeGreaterThan(480);
    expect(longest.pattern).toContain('field079');
  });

  it('keeps $and clauses instead of collapsing them', () => {
    const parsed = shape({
      type: 'command',
      ns: 'app.orders',
      command: {
        find: 'orders',
        filter: { $and: [{ a: 1 }, { b: 2 }, { c: 3 }, { d: 4 }] },
        $db: 'app',
      },
      durationMillis: 5,
    });
    expect(parsed.pattern).toBe('{ $and: [{ a: 1 }, { b: 1 }, { c: 1 }, { d: 1 }] }');
  });
});

describe('a real mongod log', () => {
  it('collapses the demo capture\'s repeated collection scans into one shape', () => {
    const text = readFileSync('public/demo/shard-00-01/mongodb.log', 'utf8');
    const report = analyzeLines(text.split('\n')).queries;
    const finds = report.patterns.filter((p) => p.op === 'find' && p.ns === 'demo.events' && p.collscan);
    expect(finds.length).toBeGreaterThan(0);
    const row = finds[0]!;
    expect(row.count).toBeGreaterThan(1);
    expect(row.pattern).toContain('$gt');
    expect(row.doing).toContain('Collection scan');
    expect(row.docsExamined).toBeGreaterThan(row.returned);
  });
});

describe('logs with no FTDC', () => {
  it('makes one capture per directory of logs', () => {
    const file = (path: string): SourceFile =>
      ({ file: new File(['x'], path.split('/').pop() ?? path), path });
    const groups = groupLogCaptures([
      file('rs0/mongod.log'),
      file('rs0/mongod.log.1'),
      file('rs1/mongodb.log'),
      file('rs0/diagnostic.data/metrics.2026'),
    ]);
    expect(groups.map((g) => g.label).sort()).toEqual(['rs0', 'rs1']);
    expect(groups.find((g) => g.label === 'rs0')!.files).toHaveLength(2);
  });

  it('names a bare dropped log from the file', () => {
    const groups = groupLogCaptures([
      { file: new File(['x'], 'mongod.log'), path: 'mongod.log' },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.label).toBe('mongod.log');
  });
});

describe('attr round-trip used by the shaper', () => {
  it('reads attr off a slow-query line', () => {
    const raw = line({ ns: 'app.x', command: { find: 'x', filter: { a: 1 } } });
    expect(attrOf(raw)?.['ns']).toBe('app.x');
  });
});
