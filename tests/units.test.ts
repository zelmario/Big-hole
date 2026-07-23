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

describe('dimensional analysis', () => {
  // Units verified against mongod's own collectors, not inferred from names:
  //   util/processinfo.h    getResidentSize() -> "@return mbytes"
  //   util/procparser.cpp   parseProcMemInfoFile appends _kb only when /proc says kB
  //   util/procparser.cpp   kDiskFields names /proc/diskstats verbatim (512-byte sectors)
  //   util/procparser.cpp   convertTicksToMilliSeconds normalises USER_HZ before FTDC
  it('scales disk sectors to bytes', () => {
    expect(scaleOfPath('systemMetrics.disks.nvme0n1.write_sectors')).toBe(512);
    expect(unitOfPath('systemMetrics.disks.nvme0n1.read_sectors')).toBe('bytes');
    expect(unitOf(parseExpr('rate(systemMetrics.disks.sda.write_sectors)'))).toBe('bytes/s');
  });

  it('does not scale CPU, which mongod already converts to ms', () => {
    expect(scaleOfPath('systemMetrics.cpu.user_ms')).toBe(1);
    expect(unitOfPath('systemMetrics.cpu.user_ms')).toBe('ms');
  });

  it('reads a rate over a rate as the numerator per operation', () => {
    // ms/s over ops/s is ms per op -- not a bare count.
    expect(
      unitOf(parseExpr('div(rate(systemMetrics.disks.sda.write_time_ms), rate(systemMetrics.disks.sda.writes))')),
    ).toBe('ms');
    expect(
      unitOf(parseExpr('div(rate(serverStatus.opLatencies.reads.latency), rate(serverStatus.opLatencies.reads.ops))')),
    ).toBe('us');
    // Counter over counter really is a ratio.
    expect(
      unitOf(parseExpr('div(rate(serverStatus.metrics.queryExecutor.scannedObjects), rate(serverStatus.metrics.document.returned))')),
    ).toBe('count');
  });

  it('reads time-per-time scaled by 0.1 as a percentage', () => {
    // 1000 ms/s is one core, or one device, fully busy.
    expect(unitOf(parseExpr('scale(rate(systemMetrics.cpu.user_ms), 0.1)'))).toBe('percent');
    expect(unitOf(parseExpr('scale(rate(systemMetrics.disks.sda.io_time_ms), 0.1)'))).toBe('percent');
    // A different factor is not a percentage.
    expect(unitOf(parseExpr('scale(rate(systemMetrics.cpu.user_ms), 2)'))).toBe('per-sec');
    // Microseconds accumulated per second is the same dimensionless quantity, three orders
    // further down: 1e6 µs/s is 100% of wall time. Flow control reports in µs.
    expect(
      unitOf(parseExpr('scale(rate(serverStatus.flowControl.isLaggedTimeMicros), 0.0001)')),
    ).toBe('percent');
    expect(
      unitOf(parseExpr('scale(rate(serverStatus.flowControl.isLaggedTimeMicros), 0.1)')),
    ).toBe('per-sec');
  });

  it('reads time-per-time scaled to a plain ratio as a count', () => {
    // Average queue depth from /proc/diskstats' weighted io_queued_ms. Left as 'per-sec' it
    // renders "18/s", which reads as an IOPS figure rather than 18 requests in flight.
    expect(unitOf(parseExpr('scale(rate(systemMetrics.disks.sda.io_queued_ms), 0.001)'))).toBe(
      'count',
    );
  });

  it('reads a share of a total as a percentage', () => {
    // CPU usage as Big-hole computed it: 100 * user / (sum of every cpu counter). Bounded
    // 0-100 whatever the core count, and immune to a stalled collector catching up, because
    // numerator and denominator stretch together.
    expect(
      unitOf(
        parseExpr(
          'pct(rate(systemMetrics.cpu.user_ms), sum(rate(systemMetrics.cpu.user_ms), rate(systemMetrics.cpu.idle_ms)))',
        ),
      ),
    ).toBe('percent');
  });
});
