/**
 * Which dropped files belong to which node.
 *
 * A support bundle for a replica set is one folder per member, each containing its own
 * `diagnostic.data`. Handing all of those files to one capture would merge three nodes'
 * metrics into a single incoherent timeline -- same paths, three different servers, silently
 * interleaved. So files are grouped by the directory that holds them, which is the one thing
 * every bundle layout agrees on:
 *
 *   node1/diagnostic.data/metrics.2026-…     ->  capture "node1"
 *   node2/diagnostic.data/metrics.2026-…     ->  capture "node2"
 *   diagnostic.data/metrics.2026-…           ->  one capture, exactly as before
 *
 * Hostname would be the more meaningful label, but it lives inside the FTDC metadata document
 * and is not known until the file is decoded. Grouping has to happen first, so it happens on
 * the path and the label is upgraded to the hostname once ingest reports it.
 */

/** A dropped file plus the path it had in the dropped tree. */
export interface SourceFile {
  readonly file: File;
  /** Slash-separated path relative to whatever was dropped. May be just the file name. */
  readonly path: string;
}

export interface CaptureGroup {
  /** The directory the files share; stable identity for the group. */
  readonly key: string;
  /** Best label available before decoding. */
  readonly label: string;
  readonly files: File[];
}

/**
 * Files mongod writes into diagnostic.data that are not FTDC.
 *
 * The `:Zone.Identifier` exclusion is not hypothetical tidiness. A capture that reaches an
 * engineer through Windows -- downloaded from a ticket, unpacked on the desktop, read from WSL --
 * carries one NTFS alternate-data-stream file per real file, named `<original>:Zone.Identifier`.
 * They begin with `metrics.` like everything else in the folder, so half of what gets dropped is
 * a 26-byte `[ZoneTransfer]` stub. Each one then fails to decode and lands in the skipped list,
 * which buries any genuinely corrupt file among a dozen non-files.
 */
export function isFtdcFile(name: string): boolean {
  const base = name.split('/').pop() ?? name;
  if (base.includes(':')) return false;
  return base.startsWith('metrics.');
}

/**
 * A mongod log, by name.
 *
 * Deliberately permissive about what surrounds `.log`: real bundles contain `mongod.log`,
 * `mongodb.log`, `mongodb.log-202607210201`, `mongod-a1_mongodb.log` and worse. Anything
 * that turns out not to be a mongod log is rejected on content when it is parsed, which is a
 * more reliable test than the filename ever is.
 */
export function isLogFile(name: string): boolean {
  const base = (name.split('/').pop() ?? name).toLowerCase();
  if (base.endsWith('.gz') || base.endsWith('.zip')) return false;
  return /\.log(\.|-|$)/.test(base);
}

/**
 * Attach log files to the node they belong to.
 *
 * A bundle puts a member's log next to its diagnostic.data, or a directory or two above it, so
 * the log goes to the capture with the longest shared path prefix. With one capture loaded
 * every log belongs to it, which is the common case and needs no cleverness.
 */
export function groupLogs(
  sources: readonly SourceFile[],
  groups: readonly CaptureGroup[],
): Map<string, File[]> {
  const out = new Map<string, File[]>();
  if (groups.length === 0) return out;

  const segments = (path: string): string[] => path.split('/').filter(Boolean);

  for (const source of sources) {
    if (!isLogFile(source.path)) continue;

    let best = groups[0]!;
    let bestShared = -1;
    for (const group of groups) {
      const a = segments(group.key);
      const b = segments(source.path);
      let shared = 0;
      while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared++;
      if (shared > bestShared) {
        bestShared = shared;
        best = group;
      }
    }

    const list = out.get(best.key);
    if (list === undefined) out.set(best.key, [source.file]);
    else list.push(source.file);
  }

  for (const list of out.values()) list.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function dirname(path: string): string {
  const at = path.lastIndexOf('/');
  return at < 0 ? '' : path.slice(0, at);
}

/**
 * A name for the node, given the directory its FTDC sits in.
 *
 * `diagnostic.data` is the same for every member, so it is never the answer -- the segment
 * above it is. `.../mongodb/data/db/diagnostic.data` skips those generic wrappers too, so a
 * bundle laid out that way still yields the host directory rather than "db".
 */
const GENERIC = new Set(['diagnostic.data', 'data', 'db', 'dbpath', 'mongodb', 'mongod', 'var', 'lib']);

export function labelFor(dir: string): string {
  const parts = dir.split('/').filter((p) => p.length > 0 && p !== '.');
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i]!;
    if (!GENERIC.has(part)) return part;
  }
  return parts[parts.length - 1] ?? 'capture';
}

/**
 * Group dropped files into one capture per node.
 *
 * Files are ordered within a group by name, which is chronological: mongod names them by ISO
 * timestamp and `metrics.interim` sorts last, which is also where it belongs.
 */
export function groupCaptures(sources: readonly SourceFile[]): CaptureGroup[] {
  const groups = new Map<string, File[]>();

  for (const source of sources) {
    if (!isFtdcFile(source.path)) continue;
    const dir = dirname(source.path);
    const list = groups.get(dir);
    if (list === undefined) groups.set(dir, [source.file]);
    else list.push(source.file);
  }

  const keys = [...groups.keys()].sort();
  const labels = new Map<string, number>();

  return keys.map((key) => {
    // Two different directories can still share a label (`mongo1/data` and `backup/data`).
    // Suffix rather than merge: they are different captures and must stay so.
    const base = labelFor(key);
    const seen = labels.get(base) ?? 0;
    labels.set(base, seen + 1);
    return {
      key,
      label: seen === 0 ? base : `${base} (${seen + 1})`,
      files: groups.get(key)!.sort((a, b) => a.name.localeCompare(b.name)),
    };
  });
}
