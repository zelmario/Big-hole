/**
 * Units and counter/gauge classification.
 *
 * Both failure modes are silent and both were live: memory read "956 B" because
 * `serverStatus.mem.*` is MiB, and connections read "0.5/s" because the upstream Grafana
 * dashboard applies derivative() per panel and swept a gauge along with the counters. A wrong
 * unit is worse than a missing panel -- it looks authoritative.
 */

import { describe, expect, it } from 'vitest';

import { parseExpr, scaleOfPath, unitOf, unitOfPath, evaluate } from '../src/data/expr.js';
import { formatValue } from '../src/data/format.js';
import { DEFAULT_TEMPLATES } from '../src/dashboard/defaultDashboard.js';

describe('unit inference', () => {
  it.each([
    ['serverStatus.mem.resident', 'bytes'],
    ['serverStatus.mem.virtual', 'bytes'],
    ['systemMetrics.memory.MemAvailable_kb', 'bytes'],
    ['systemMetrics.memory.SwapTotal_kb', 'bytes'],
    ['serverStatus.wiredTiger.cache.bytes currently in the cache', 'bytes'],
    ['local.oplog.rs.stats.storageStats.avgObjSize', 'bytes'],
    ['local.oplog.rs.stats.storageStats.storageSize', 'bytes'],
    ['serverStatus.uptime', 'seconds'],
    ['replSetGetStatus.members.0.pingMs', 'ms'],
    ['serverStatus.flowControl.isLaggedTimeMicros', 'us'],
    ['serverStatus.opLatencies.reads.latency', 'us'],
    ['systemMetrics.disks.sda.io_time_ms', 'ms'],
    ['serverStatus.connections.current', 'count'],
  ])('%s -> %s', (path, unit) => {
    expect(unitOfPath(path)).toBe(unit);
  });

  it('promotes a rated byte counter to a throughput', () => {
    expect(unitOf(parseExpr('rate(serverStatus.network.bytesIn)'))).toBe('bytes/s');
    expect(unitOf(parseExpr('rate(serverStatus.opcounters.query)'))).toBe('per-sec');
  });
});

describe('unit scaling', () => {
  it('normalises MiB and kB metrics to bytes', () => {
    expect(scaleOfPath('serverStatus.mem.resident')).toBe(1024 * 1024);
    expect(scaleOfPath('systemMetrics.memory.MemFree_kb')).toBe(1024);
    expect(scaleOfPath('serverStatus.connections.current')).toBe(1);
  });

  it('applies the scale during evaluation, so a catalogue pick is right too', () => {
    const t = Float64Array.from([0, 1000]);
    const raw = new Map([['serverStatus.mem.resident', Float64Array.from([956, 1024])]]);
    const v = evaluate(parseExpr('serverStatus.mem.resident'), t, raw);
    expect(formatValue(v[0]!, 'bytes')).toBe('956 MiB');
    expect(formatValue(v[1]!, 'bytes')).toBe('1.00 GiB');
  });
});

describe('counters vs gauges in the shipped dashboard', () => {
  const rated = DEFAULT_TEMPLATES.filter((t) => t.kind === 'chart').flatMap((t) =>
    t.metrics.filter((m) => m.includes('rate(')),
  );

  /** An instantaneous reading; differencing it produces a meaningless number. */
  const GAUGE =
    /\.(current|available|active|out|totalTickets|queueLength|processing)\)|\.(resident|virtual|mapped)\)|currently in the cache\)|maximum bytes configured\)|tracked dirty bytes|currently active\)|\.(health|state|pingMs|uptime)\)|cursor\.open\.|io_in_progress\)|_kb\)|\.(avgObjSize|storageSize|freeStorageSize)\)|Tcp:CurrEstab\)/;

  it('never rates a gauge', () => {
    const offenders = rated.filter((m) => GAUGE.test(m));
    expect(
      offenders,
      `these are gauges and must not be differenced:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('still rates the counters that need it', () => {
    // A regression here would mean cumulative counters charting as monotonic ramps again.
    for (const needle of [
      'rate(serverStatus.opcounters.query)',
      'rate(serverStatus.connections.totalCreated)',
      'rate(serverStatus.extra_info.page_faults)',
      'rate(serverStatus.network.bytesIn)',
    ]) {
      expect(rated, `${needle} should be rated`).toContain(needle);
    }
  });

  it('keeps the gauges unrated', () => {
    const all = DEFAULT_TEMPLATES.filter((t) => t.kind === 'chart').flatMap((t) => t.metrics);
    for (const needle of [
      'serverStatus.connections.current',
      'serverStatus.connections.active',
      'serverStatus.mem.resident',
      'serverStatus.wiredTiger.concurrentTransactions.read.available',
    ]) {
      expect(all, `${needle} should be plotted raw`).toContain(needle);
    }
  });
});

describe('derived panels', () => {
  it('reports latency per operation, not microseconds accumulated per second', () => {
    const all = DEFAULT_TEMPLATES.flatMap((t) => t.metrics);
    expect(all).toContain(
      'div(rate(serverStatus.opLatencies.reads.latency), rate(serverStatus.opLatencies.reads.ops))',
    );
    expect(all).not.toContain('rate(serverStatus.opLatencies.reads.latency)');
  });

  it('treats a never-reported operand as missing rather than as 1970', () => {
    // A replica member that has not checked in has lastAppliedWallTime 0; differencing gives
    // ~56 years of "lag", which reads as catastrophic instead of as absent.
    const t = Float64Array.from([0, 1000]);
    const raw = new Map([
      ['now', Float64Array.from([1_700_000_000_000, 1_700_000_000_000])],
      ['then', Float64Array.from([0, 1_699_999_999_000])],
    ]);
    const v = evaluate(parseExpr('diff(now, then)'), t, raw);
    expect(Number.isNaN(v[0]!)).toBe(true);
    expect(v[1]).toBe(1000);
  });
});

describe('formatting', () => {
  it.each([
    [956 * 1024 * 1024, 'bytes', '956 MiB'],
    [1536, 'bytes', '1.50 KiB'],
    [0.5, 'percent', '0.5%'],
    [2040, 'seconds', '34.0 min'],
    [1500, 'ms', '1.50 s'],
    [1_500_000, 'us', '1.50 s'],
    [1024 * 1024, 'bytes/s', '1.00 MiB/s'],
  ] as const)('%s as %s -> %s', (value, unit, expected) => {
    expect(formatValue(value, unit)).toBe(expected);
  });
});
