/**
 * What a capture says about the machine it came from.
 *
 * FTDC's sample stream is numeric by construction, so none of this can come from the metrics:
 * the hostname, the CPU model, the OS, the effective mongod configuration and the ulimits exist
 * only in the type-0 metadata document at the head of each `metrics.*` file. That document is
 * the mongod's own `hostInfo`, `buildInfo` and `getCmdLineOpts` verbatim -- which means the
 * "config?" half of this answer is not reconstructed from anything, it is the parsed
 * configuration the server was actually running.
 *
 * The numbers that a support engineer wants next to it -- the WiredTiger cache size, peak RSS,
 * how long the process had been up -- *are* metrics, and they cost no I/O either: the manifest
 * already carries each path's whole-capture min and max, so this reads them out of the
 * catalogue rather than reading a series.
 *
 * Two rules, both inherited from the rest of the codebase:
 *
 * - **Resolve from the capture, never from a version string.** Metadata is nested under a role
 *   prefix on a sharded 8.0 node (`common.hostInfo.…`) and bare elsewhere, and metric paths
 *   carry the same prefixes -- so both go through a probe rather than an assumption.
 * - **A field that is not there is absent, not zero.** Every one of these is missing on some
 *   server someone will load, and a blank row is an honest answer where a fabricated one is not.
 */

import { detectRolePrefixes, expandMetric } from '../dashboard/layout.js';
import { formatValue } from '../data/format.js';
import { scaleOfPath } from '../data/expr.js';
import type { CatalogEntry } from '../data/reader.js';

/** One row of the info page. */
export interface InfoField {
  readonly section: string;
  readonly label: string;
  readonly value: string;
  /** Where it came from -- an FTDC metadata path or a metric path. Shown as a tooltip. */
  readonly source: string;
}

/** Everything one node contributes to the page. */
export interface NodeInfo {
  readonly captureId: string;
  readonly label: string;
  readonly fields: InfoField[];
  /** The raw metadata document, for the reader who wants the field this page did not pick. */
  readonly meta: Record<string, unknown> | undefined;
}

export interface InfoCapture {
  readonly id: string;
  readonly label: string;
  readonly paths: ReadonlySet<string>;
  readonly catalog: readonly CatalogEntry[];
  readonly meta?: Record<string, unknown>;
  readonly startMs: number;
  readonly endMs: number;
  readonly sampleCount: number;
  readonly cadenceMs: number;
  readonly gaps: number;
  readonly restarts: number;
  readonly mongoVersion?: string;
}

/* ------------------------------------------------------------ metadata ---- */

function walk(root: unknown, path: readonly string[]): unknown {
  let cur = root;
  for (const key of path) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/**
 * Read a dotted path out of the metadata document, wherever the server chose to put it.
 *
 * MongoDB 8.0 scopes FTDC by role on a sharded cluster, and the metadata document is scoped with
 * it: the same `hostInfo.system.hostname` arrives bare on a plain replica set and as
 * `common.hostInfo.system.hostname` on a shard member. Rather than list the role names -- which
 * would be a version assumption in disguise -- this tries the bare path, then every top-level
 * object in the document. Roles differ by topology, not by release (ARCHITECTURE.md).
 */
export function pick(meta: Record<string, unknown> | undefined, dotted: string): unknown {
  if (meta === undefined) return undefined;
  const path = dotted.split('.');

  const bare = walk(meta, path);
  if (bare !== undefined) return bare;

  for (const value of Object.values(meta)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
    const under = walk(value, path);
    if (under !== undefined) return under;
  }
  return undefined;
}

/** A metadata value as one line of text, or undefined when the capture does not carry it. */
function text(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value.trim() === '' ? undefined : value;
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'number') {
    // mongod writes "no limit" as an int64 that JS cannot hold exactly, so it prints as
    // 9223372036854776000 -- a number that looks like a real ceiling and is not one.
    if (!Number.isSafeInteger(value) && Math.abs(value) > Number.MAX_SAFE_INTEGER) return 'unlimited';
    return String(value);
  }
  if (Array.isArray(value)) return value.length === 0 ? '(none)' : value.map(String).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/* -------------------------------------------------------------- metrics ---- */

/**
 * Metric lookup for one node.
 *
 * The role prefixes and the path index are built once per node rather than per field: a real
 * sharded capture carries 5,763 paths, and rebuilding both for each of a dozen rows is the
 * kind of quadratic that only shows up on the captures that matter.
 */
function lookup(capture: InfoCapture): (path: string, end: 'min' | 'max') => {
  value: number;
  path: string;
} | undefined {
  const prefixes = detectRolePrefixes(capture.paths);
  const byPath = new Map(capture.catalog.map((e) => [e.path, e]));

  return (path, end) => {
    for (const resolved of expandMetric(path, capture.paths, prefixes)) {
      const entry = byPath.get(resolved);
      if (entry === undefined || !Number.isFinite(entry[end])) continue;
      // `serverStatus.mem.resident` is reported in MiB by mongod, so it needs the same scaling
      // a panel applies -- otherwise 62,000 renders as "62 kB" of resident memory.
      return { value: entry[end] * scaleOfPath(entry.path), path: entry.path };
    }
    return undefined;
  };
}

/* ---------------------------------------------------------------- rows ---- */

function iso(ms: number): string {
  // Whole seconds: these are derived instants (a capture boundary, an uptime subtracted from
  // one), and a millisecond of false precision on "the process started at" reads as a
  // measurement rather than as the estimate it is.
  return `${new Date(ms).toISOString().replace('T', ' ').slice(0, 19)}Z`;
}

/**
 * The fields one node contributes, in the order they are worth reading.
 *
 * Ordered by what an investigation needs first: which machine this is, then what it had to work
 * with (cores, RAM, cache), then what it was running, then how it was configured. The raw
 * document is available underneath for everything not listed here -- the list is a starting
 * point, not a claim to be complete.
 */
export function nodeFields(capture: InfoCapture): InfoField[] {
  const out: InfoField[] = [];
  const meta = capture.meta;
  const peak = lookup(capture);

  const add = (section: string, label: string, value: string | undefined, source: string): void => {
    if (value !== undefined) out.push({ section, label, value, source });
  };

  const fromMeta = (section: string, label: string, path: string): void => {
    add(section, label, text(pick(meta, path)), path);
  };

  const fromMetric = (
    section: string,
    label: string,
    path: string,
    unit: 'bytes' | 'count' | 'seconds',
    end: 'min' | 'max' = 'max',
  ): void => {
    const hit = peak(path, end);
    if (hit !== undefined) add(section, label, formatValue(hit.value, unit), hit.path);
  };

  /* --- host --- */
  fromMeta('Host', 'hostname', 'hostInfo.system.hostname');
  const osName = text(pick(meta, 'hostInfo.os.name'));
  const osVersion = text(pick(meta, 'hostInfo.os.version'));
  add(
    'Host',
    'operating system',
    osName === undefined ? osVersion : `${osName}${osVersion === undefined ? '' : ` — ${osVersion}`}`,
    'hostInfo.os',
  );
  fromMeta('Host', 'kernel', 'hostInfo.extra.kernelVersion');
  fromMeta('Host', 'libc', 'hostInfo.extra.libcVersion');
  const numa = pick(meta, 'hostInfo.system.numaEnabled');
  if (numa !== undefined) {
    const nodes = text(pick(meta, 'hostInfo.system.numNumaNodes'));
    add(
      'Host',
      'NUMA',
      `${numa === true ? 'enabled' : 'disabled'}${nodes === undefined ? '' : ` (${nodes} node(s))`}`,
      'hostInfo.system.numaEnabled',
    );
  }

  /* --- processors --- */
  fromMeta('Processors', 'model', 'hostInfo.extra.cpuString');
  const cores = text(pick(meta, 'hostInfo.system.numCores'));
  const physical = text(pick(meta, 'hostInfo.system.numPhysicalCores'));
  const usable = text(pick(meta, 'hostInfo.system.numCoresAvailableToProcess'));
  if (cores !== undefined) {
    const notes = [
      physical !== undefined && physical !== cores ? `${physical} physical` : undefined,
      // Under a cgroup CPU limit this is smaller than numCores, and it is the number that
      // actually governs how much work the server can do.
      usable !== undefined && usable !== cores ? `${usable} available to mongod` : undefined,
    ].filter((n): n is string => n !== undefined);
    add(
      'Processors',
      'cores',
      notes.length === 0 ? cores : `${cores} (${notes.join(', ')})`,
      'hostInfo.system.numCores',
    );
  }
  fromMeta('Processors', 'sockets', 'hostInfo.system.numCpuSockets');
  fromMeta('Processors', 'architecture', 'hostInfo.system.cpuArch');
  const mhz = text(pick(meta, 'hostInfo.extra.cpuFrequencyMHz'));
  add('Processors', 'frequency', mhz === undefined ? undefined : `${mhz} MHz`, 'hostInfo.extra.cpuFrequencyMHz');

  /* --- memory --- */
  const memMB = pick(meta, 'hostInfo.system.memSizeMB');
  if (typeof memMB === 'number') {
    add('Memory', 'physical', formatValue(memMB * 1024 * 1024, 'bytes'), 'hostInfo.system.memSizeMB');
  }
  const limitMB = pick(meta, 'hostInfo.system.memLimitMB');
  // Only worth a row when it differs: equal to memSizeMB it says nothing, and different it is
  // usually the cgroup limit a container was given, which is the number WiredTiger sized against.
  if (typeof limitMB === 'number' && limitMB !== memMB) {
    add('Memory', 'limit', formatValue(limitMB * 1024 * 1024, 'bytes'), 'hostInfo.system.memLimitMB');
  }
  fromMetric('Memory', 'WiredTiger cache configured', 'serverStatus.wiredTiger.cache.maximum bytes configured', 'bytes');
  fromMetric('Memory', 'WiredTiger cache peak', 'serverStatus.wiredTiger.cache.bytes currently in the cache', 'bytes');
  fromMetric('Memory', 'resident peak', 'serverStatus.mem.resident', 'bytes');
  fromMetric('Memory', 'virtual peak', 'serverStatus.mem.virtual', 'bytes');

  /* --- mongod --- */
  add(
    'MongoDB',
    'version',
    text(pick(meta, 'buildInfo.version')) ?? capture.mongoVersion,
    'buildInfo.version',
  );
  fromMeta('MongoDB', 'Percona build', 'buildInfo.psmdbVersion');
  fromMeta('MongoDB', 'git version', 'buildInfo.gitVersion');
  fromMeta('MongoDB', 'modules', 'buildInfo.modules');
  fromMeta('MongoDB', 'allocator', 'buildInfo.allocator');
  fromMeta('MongoDB', 'javascript engine', 'buildInfo.javascriptEngine');
  fromMeta('MongoDB', 'OpenSSL', 'buildInfo.openssl.running');
  fromMeta('MongoDB', 'storage engine', 'getCmdLineOpts.parsed.storage.engine');
  fromMeta('MongoDB', 'dbPath', 'getCmdLineOpts.parsed.storage.dbPath');
  const uptime = peak('serverStatus.uptime', 'max');
  if (uptime !== undefined) {
    // The capture ends at a known instant and the process had been up this long by then, so the
    // process start time follows -- and "the server restarted an hour before the capture" is a
    // fact that reframes everything else on the page.
    add(
      'MongoDB',
      'uptime at capture end',
      `${formatValue(uptime.value, 'seconds')} — started ≈ ${iso(capture.endMs - uptime.value * 1000)}`,
      uptime.path,
    );
  }

  /* --- replication --- */
  fromMeta('Replication', 'replica set', 'getCmdLineOpts.parsed.replication.replSetName');
  fromMeta('Replication', 'cluster role', 'getCmdLineOpts.parsed.sharding.clusterRole');
  const oplogMB = pick(meta, 'getCmdLineOpts.parsed.replication.oplogSizeMB');
  if (typeof oplogMB === 'number') {
    add(
      'Replication',
      'oplog configured',
      formatValue(oplogMB * 1024 * 1024, 'bytes'),
      'getCmdLineOpts.parsed.replication.oplogSizeMB',
    );
  }
  fromMetric('Replication', 'oplog on disk', 'local.oplog.rs.stats.storageSize', 'bytes');
  fromMeta(
    'Replication',
    'oplog min retention (h)',
    'getCmdLineOpts.parsed.storage.oplogMinRetentionHours',
  );
  fromMetric('Replication', 'voting members', 'replSetGetStatus.votingMembersCount', 'count');
  fromMetric('Replication', 'election term (max)', 'replSetGetStatus.term', 'count');

  /* --- network and security --- */
  fromMeta('Network', 'port', 'getCmdLineOpts.parsed.net.port');
  fromMeta('Network', 'bindIp', 'getCmdLineOpts.parsed.net.bindIp');
  fromMeta('Network', 'TLS mode', 'getCmdLineOpts.parsed.net.tls.mode');
  fromMeta('Network', 'wire compressors', 'getCmdLineOpts.parsed.net.compression.compressors');
  fromMetric('Network', 'connections peak', 'serverStatus.connections.current', 'count');
  fromMetric('Network', 'connections still available', 'serverStatus.connections.available', 'count', 'min');
  fromMeta('Security', 'authorization', 'getCmdLineOpts.parsed.security.authorization');
  fromMeta('Security', 'cluster auth mode', 'getCmdLineOpts.parsed.security.clusterAuthMode');
  fromMeta('Security', 'audit log', 'getCmdLineOpts.parsed.auditLog.destination');

  /* --- limits --- */
  // A support case that begins "connections stopped being accepted" usually ends here.
  const limit = (label: string, key: string): void => {
    const soft = text(pick(meta, `ulimits.${key}.soft`));
    const hard = text(pick(meta, `ulimits.${key}.hard`));
    if (soft === undefined && hard === undefined) return;
    const say = (v: string | undefined): string => (v === undefined ? '?' : v === '-1' ? 'unlimited' : v);
    add('Limits', label, `${say(soft)} soft / ${say(hard)} hard`, `ulimits.${key}`);
  };
  limit('open files', 'fileDescriptors');
  limit('processes', 'processes');
  limit('locked memory (kB)', 'memLock_kb');
  limit('address space (kB)', 'addressSpace_kb');
  limit('core file size (blocks)', 'coreFileSize_blocks');
  fromMeta('Limits', 'system file handles', 'sysMaxOpenFiles.sys_max_file_handles');

  /* --- the capture itself --- */
  add('Capture', 'window', `${iso(capture.startMs)} → ${iso(capture.endMs)}`, 'manifest');
  add(
    'Capture',
    'samples',
    `${capture.sampleCount.toLocaleString()} at ${(capture.cadenceMs / 1000).toFixed(1)}s`,
    'manifest',
  );
  add('Capture', 'metrics', capture.paths.size.toLocaleString(), 'manifest');
  add('Capture', 'gaps', String(capture.gaps), 'manifest');
  add('Capture', 'restarts detected', String(capture.restarts), 'manifest');
  fromMeta(
    'Capture',
    'FTDC directory size cap',
    'getCmdLineOpts.parsed.setParameter.diagnosticDataCollectionDirectorySizeMB',
  );

  return out;
}

/** Section order for the page, so every node's rows line up under the same headings. */
export const SECTION_ORDER = [
  'Host',
  'Processors',
  'Memory',
  'MongoDB',
  'Replication',
  'Network',
  'Security',
  'Limits',
  'Capture',
] as const;

/** Rows to render: every (section, label) any node has, in a stable order. */
export function mergeFields(nodes: readonly NodeInfo[]): Array<{ section: string; label: string }> {
  const seen = new Set<string>();
  const rows: Array<{ section: string; label: string }> = [];
  const rank = (s: string): number => {
    const i = (SECTION_ORDER as readonly string[]).indexOf(s);
    return i < 0 ? SECTION_ORDER.length : i;
  };

  // Order comes from the node that has the most rows, so the sequence within a section is the
  // one `nodeFields` produced rather than an alphabetical scramble of it.
  const ordered = [...nodes].sort((a, b) => b.fields.length - a.fields.length);
  for (const node of ordered) {
    for (const field of node.fields) {
      const key = `${field.section} ${field.label}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ section: field.section, label: field.label });
    }
  }

  return rows.sort((a, b) => rank(a.section) - rank(b.section));
}
