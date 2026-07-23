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

/** Files mongod writes into diagnostic.data that are not FTDC. */
export function isFtdcFile(name: string): boolean {
  const base = name.split('/').pop() ?? name;
  return base.startsWith('metrics.');
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
