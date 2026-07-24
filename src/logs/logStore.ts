/**
 * Persisting a log alongside its capture, so a reload brings it back.
 *
 * Metrics survive a reload because ingest writes them into OPFS and reopen is a manifest read.
 * Logs used to be the exception: attaching one produced only in-memory aggregates plus a
 * browser `File` handle, and the browser revokes that handle on reload -- so the bytes were
 * still on the user's disk but the app had no durable way back to them, and every reopen sent
 * them to re-drop the mongod.log.
 *
 * This closes that gap without changing the storage promise. At attach time the same streaming
 * pass that builds the annotations also copies the log's bytes into the capture's OPFS
 * directory; a small sidecar records what was written. On reopen the bytes are read back from
 * OPFS -- an OPFS file *is* a `Blob`, so the viewer's positioned reads (`rangeFor`/`logRange`)
 * work against it unchanged -- and the annotations are rebuilt by streaming it once more.
 *
 * Only the window the capture covers is stored, exactly as only that window is indexed: a
 * 36-hour, 2.5 GB log beside a 4-hour capture costs a few hundred megabytes of local disk, not
 * the whole file. OPFS is local disk, private to the origin, and never a network surface, so
 * the privacy promise is untouched.
 */

import type { FileStore } from '../data/fileStore.js';
import { LogAnalyzer, type LogAnalysis } from './analyze.js';
import { rangeFor } from './locate.js';

/** Bumped if the on-disk shape changes; a mismatched sidecar is treated as "no stored log". */
export const LOG_MANIFEST_VERSION = 1;

export interface LogManifest {
  readonly version: number;
  /** One entry per source log file, in the order they were attached. */
  readonly files: ReadonlyArray<{ readonly name: string; readonly path: string; readonly size: number }>;
  /** The window that was indexed and stored -- normally the capture's own span. */
  readonly fromMs: number;
  readonly toMs: number;
}

/** Progress during a persist or restore pass, so a multi-gigabyte log does not look hung. */
export type LogProgress = (p: {
  readonly bytes: number;
  readonly lines: number;
  readonly file: string;
  readonly filesDone: number;
  readonly filesTotal: number;
}) => void;

/** Sidecar path for a capture's log. */
export function logManifestPath(captureId: string): string {
  return `${captureId}/logs.json`;
}

/** Whether a capture has a persisted log to restore. */
export async function hasStoredLog(store: FileStore, captureId: string): Promise<boolean> {
  return store.exists(logManifestPath(captureId));
}

/** Emit one line per newline, returning the unterminated remainder to prepend next time. */
function feed(analyzer: LogAnalyzer, carry: string, text: string): { carry: string; lines: number } {
  const parts = (carry + text).split('\n');
  const rest = parts.pop() ?? '';
  for (const part of parts) analyzer.push(part);
  return { carry: rest, lines: parts.length };
}

/**
 * Copy the log's window into OPFS and build its annotations in one pass.
 *
 * The bytes are streamed, appended to disk, and decoded into the analyzer chunk by chunk, so
 * memory stays a few megabytes whatever the file size -- the same discipline the analyzer keeps
 * on its own. Returns the annotations; the sidecar and `log.N` files are left on disk for
 * {@link restoreLog}.
 */
export async function persistAndAnalyze(
  store: FileStore,
  captureId: string,
  files: readonly File[],
  fromMs: number | undefined,
  toMs: number | undefined,
  onProgress?: LogProgress,
): Promise<LogAnalysis> {
  const analyzer = new LogAnalyzer();
  const stored: Array<{ name: string; path: string; size: number }> = [];
  let bytes = 0;
  let lines = 0;

  for (let i = 0; i < files.length; i++) {
    const file = files[i]!;
    const path = `${captureId}/log.${i}`;
    // Only the part covering the capture. rangeFor binary-searches by timestamp and File.slice
    // is lazy, so the bytes outside the window are never read and never stored.
    const range = await rangeFor(file, fromMs, toMs);
    const writable = await store.createWritable(path);
    let written = 0;

    if (range.to > range.from) {
      const decoder = new TextDecoder();
      const reader = file.slice(range.from, range.to).stream().getReader();
      let carry = '';
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        await writable.append(chunk.value);
        written += chunk.value.length;
        bytes += chunk.value.length;
        const fed = feed(analyzer, carry, decoder.decode(chunk.value, { stream: true }));
        carry = fed.carry;
        lines += fed.lines;
        if (onProgress && lines % 200_000 < fed.lines) {
          onProgress({ bytes, lines, file: file.name, filesDone: i, filesTotal: files.length });
        }
      }
      carry += decoder.decode();
      if (carry.length > 0) analyzer.push(carry);
    }

    await writable.close();
    stored.push({ name: file.name, path, size: written });
  }

  const manifest: LogManifest = {
    version: LOG_MANIFEST_VERSION,
    files: stored,
    fromMs: fromMs ?? 0,
    toMs: toMs ?? 0,
  };
  await store.writeText(logManifestPath(captureId), JSON.stringify(manifest));
  return analyzer.finish();
}

/**
 * Read a persisted log back from OPFS and rebuild its annotations.
 *
 * Returns the annotations plus the stored files as `Blob`s -- the worker keeps those in place
 * of the dropped `File`s, so the log viewer's positioned reads work exactly as they did in the
 * session that attached the log. Null when there is no sidecar, or one from an older shape.
 */
export async function restoreLog(
  store: FileStore,
  captureId: string,
  onProgress?: LogProgress,
): Promise<{ analysis: LogAnalysis; files: Blob[] } | null> {
  const path = logManifestPath(captureId);
  if (!(await store.exists(path))) return null;

  let manifest: LogManifest;
  try {
    manifest = JSON.parse(await store.readText(path)) as LogManifest;
  } catch {
    return null;
  }
  if (manifest.version !== LOG_MANIFEST_VERSION) return null;

  const analyzer = new LogAnalyzer();
  const files: Blob[] = [];
  let bytes = 0;
  let lines = 0;
  let done = 0;

  for (const entry of manifest.files) {
    const blob = await store.openBlob(entry.path);
    files.push(blob);
    if (blob.size > 0) {
      const decoder = new TextDecoder();
      const reader = blob.stream().getReader();
      let carry = '';
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.length;
        const fed = feed(analyzer, carry, decoder.decode(chunk.value, { stream: true }));
        carry = fed.carry;
        lines += fed.lines;
        if (onProgress && lines % 200_000 < fed.lines) {
          onProgress({ bytes, lines, file: entry.name, filesDone: done, filesTotal: manifest.files.length });
        }
      }
      carry += decoder.decode();
      if (carry.length > 0) analyzer.push(carry);
    }
    done++;
  }

  return { analysis: analyzer.finish(), files };
}
