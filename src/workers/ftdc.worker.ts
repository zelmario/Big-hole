/**
 * Decode + storage worker.
 *
 * Owns the OPFS store (sync access handles are worker-only) and keeps the main thread free
 * during ingest, which is CPU-bound for as long as it takes to decode the capture.
 */

/// <reference lib="webworker" />

import { decodeFTDC, readMetadata } from '../ftdc/index.js';
import { LogAnalyzer } from '../logs/analyze.js';
import { emptyStats, parseLine } from '../logs/parse.js';
import { classify } from '../logs/classify.js';
import { rangeFor } from '../logs/locate.js';
import { hasStoredLog, persistAndAnalyze, restoreLog, type LogProgress } from '../logs/logStore.js';
import { OpfsFileStore } from '../data/fileStore.js';
import { CaptureWriter } from '../data/writer.js';
import { CaptureReader } from '../data/reader.js';
import { changeInputs, rankChanges } from '../insights/ranking.js';
import type { CaptureManifest } from '../data/types.js';
import {
  summarise,
  type CaptureSummary,
  type LogViewLine,
  type Request,
  type Response,
  type SeriesPayload,
} from './protocol.js';

const store = new OpfsFileStore();
const readers = new Map<string, CaptureReader>();
/**
 * Log files per capture, kept as handles rather than contents.
 *
 * A Blob is a reference to bytes on disk; holding one costs nothing and makes "show me the log
 * around this moment" a positioned read instead of a reason to keep 2.5 GB in memory. A fresh
 * attach holds the dropped `File`s; a reopen holds the OPFS `Blob`s the log was persisted to --
 * both slice and stream identically, so the viewer never knows which it has.
 */
const logFiles = new Map<string, Blob[]>();

function post(message: Response, transfer: Transferable[] = []): void {
  (self as unknown as Worker).postMessage(message, transfer);
}

/** Files mongod writes into diagnostic.data that are not FTDC. */
function isFtdcFile(name: string): boolean {
  const base = name.split('/').pop() ?? name;
  return base.startsWith('metrics.');
}

async function ingest(id: number, captureId: string, files: File[]): Promise<void> {
  // Ascending name order is chronological: mongod names files by ISO timestamp, and
  // metrics.interim is the tail, which sorts last naturally.
  const candidates = files
    .filter((f) => isFtdcFile(f.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (candidates.length === 0) throw new Error('no metrics.* files found');

  // OPFS sync access handles are exclusive. A reader left open from a previous capture holds
  // columns.bin, and both removeDir and createWritable would fail against it -- so releasing
  // it has to happen before the writer is created, not after ingest finishes.
  const existing = readers.get(captureId);
  if (existing !== undefined) {
    await existing.close();
    readers.delete(captureId);
  }

  const writer = await CaptureWriter.create(store, {
    captureId,
    sourceFile: candidates.map((f) => f.name).join(', '),
  });

  const skipped: string[] = [];
  let hostname: string | undefined;
  let mongoVersion: string | undefined;
  let done = 0;

  try {
    for (const file of candidates) {
      const bytes = new Uint8Array(await file.arrayBuffer());

      if (hostname === undefined) {
        try {
          const meta = readMetadata(bytes);
          hostname = meta?.hostname;
          mongoVersion = meta?.version;
        } catch {
          // metadata is a nicety; a file without it still decodes
        }
      }

      try {
        for (const chunk of decodeFTDC(bytes)) await writer.addChunk(chunk);
      } catch (err) {
        // One unreadable file must not sink the capture -- real diagnostic.data directories
        // contain lock files and partially written data.
        skipped.push(`${file.name}: ${err instanceof Error ? err.message : String(err)}`);
      }

      done++;
      const p = writer.progress;
      post({
        kind: 'progress',
        id,
        file: file.name,
        filesDone: done,
        filesTotal: candidates.length,
        samples: p.samples,
        bytesWritten: p.bytesWritten,
      });
    }

    // Into the manifest, not just the reply: the reply names this node for as long as the tab
    // lives, the manifest names it for every session after.
    const manifest = await writer.finish({
      ...(hostname !== undefined ? { hostname } : {}),
      ...(mongoVersion !== undefined ? { mongoVersion } : {}),
    });

    post({
      kind: 'ingested',
      id,
      summary: {
        ...summarise(manifest, skipped),
        ...(hostname !== undefined ? { hostname } : {}),
        ...(mongoVersion !== undefined ? { mongoVersion } : {}),
      },
    });
  } catch (err) {
    // Ingest that fails part-way has already written most of its columns -- a 42-hour node is
    // 1.5 GB on disk before the manifest is due. Leaving that behind is worse than the failure
    // itself: with no manifest the recent list skips it, so nothing in the UI can reach it to
    // drop it, and it still counts against the origin's quota. Since running out of quota is
    // the commonest reason to get here at all, the wreckage of one attempt is precisely what
    // makes the next attempt fail. Clean it up before reporting.
    await store.removeDir(captureId).catch(() => {
      // Best effort; the original failure is the one worth propagating.
    });
    throw err;
  }
}

async function reader(captureId: string): Promise<CaptureReader> {
  let r = readers.get(captureId);
  if (r === undefined) {
    r = await CaptureReader.open(store, captureId);
    readers.set(captureId, r);
  }
  return r;
}

self.onmessage = async (event: MessageEvent<{ id: number; request: Request }>) => {
  const { id, request } = event.data;

  try {
    switch (request.kind) {
      case 'ingest':
        await ingest(id, request.captureId, request.files);
        break;

      case 'catalog': {
        const r = await reader(request.captureId);
        post({ kind: 'catalog', id, entries: r.catalog });
        break;
      }

      case 'series': {
        const r = await reader(request.captureId);
        // A panel asks for all of its metrics at once and the reads are independent, so
        // resolve them together rather than one after another.
        const resolved = await Promise.all(
          request.paths.map(async (path) => {
            const s = await r.getSeries(path, request.query);
            // Copy before transferring: raw results alias the reader's cached clock, and
            // transferring that buffer would detach it for every later query.
            return {
              path,
              t: Float64Array.from(s.t),
              min: Float64Array.from(s.min),
              max: Float64Array.from(s.max),
              mean: Float64Array.from(s.mean),
              raw: s.raw,
            };
          }),
        );

        const series: SeriesPayload[] = resolved;
        const transfer: Transferable[] = resolved.flatMap((s) => [
          s.t.buffer,
          s.min.buffer,
          s.max.buffer,
          s.mean.buffer,
        ]);

        post({ kind: 'series', id, series }, transfer);
        break;
      }

      case 'explain': {
        const r = await reader(request.captureId);
        // Both windows before either is ranked: the comparison is per metric, so the two scans
        // are independent and the second is not waiting on anything the first produced.
        const [win, base] = await Promise.all([
          r.scan({
            from: request.fromMs,
            to: request.toMs,
            ...(request.maxSamples !== undefined ? { maxSamples: request.maxSamples } : {}),
          }),
          r.scan({
            from: request.baseFromMs,
            to: request.baseToMs,
            ...(request.maxSamples !== undefined ? { maxSamples: request.maxSamples } : {}),
          }),
        ]);
        const inputs = changeInputs(
          base,
          win,
          (path) => r.rangeOf(path),
          r.manifest.endMs - r.manifest.startMs,
          (path) => r.typeOf(path),
        );
        post({
          kind: 'explain',
          id,
          changes: rankChanges(inputs, {
            ...(request.limit !== undefined ? { limit: request.limit } : {}),
          }),
          compared: inputs.length,
        });
        break;
      }

      case 'logRange': {
        // The log viewer's data source. The File handles are still held from ingest, so the
        // bytes covering the visible window are a positioned read -- following the dashboard as
        // it zooms costs milliseconds, not memory.
        const held = logFiles.get(request.captureId) ?? [];
        const { fromMs, toMs, maxLines, importantOnly } = request;
        const query = request.query.toLowerCase();
        const wantTail = request.end === 'tail';
        // Never read more than this scanning for notable lines in a wide window; past it the
        // viewer says so and asks for a narrower one.
        const SCAN_BUDGET = 256 * 1024 * 1024;
        // Reverse paging reads backwards from the window's end, growing the slice until it holds
        // a full page. Starting small keeps the common case -- a dense log, one page back -- to a
        // few megabytes; doubling keeps a sparse filter from needing many round trips.
        const REVERSE_FIRST = 4 * 1024 * 1024;

        /** Every matching line in a byte slice, in file order. `cap` bounds head reads only. */
        const scan = async (
          file: Blob,
          fromByte: number,
          toByte: number,
          cap: number,
        ): Promise<{ lines: LogViewLine[]; stopped: boolean }> => {
          const found: LogViewLine[] = [];
          const reader = file
            .slice(fromByte, toByte)
            .stream()
            .pipeThrough(new TextDecoderStream())
            .getReader();
          let carry = '';
          const stats = emptyStats();
          let stopped = false;

          read: for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            const parts = (carry + chunk.value).split('\n');
            carry = parts.pop() ?? '';
            for (const raw of parts) {
              const line = parseLine(raw, stats);
              if (line === null || line.tMs < fromMs || line.tMs > toMs) continue;
              if (query.length > 0 && !raw.toLowerCase().includes(query)) continue;
              const rule = classify(line);
              const important = rule?.mode === 'annotate';
              if (importantOnly && !important) continue;

              const at = raw.indexOf('"attr":');
              found.push({
                tMs: line.tMs,
                severity: line.s,
                component: line.c,
                msg: line.msg,
                // Enough for the row and for an expanded line to read complete: a slow-query
                // command document runs to a few KB, and only the pathological ones exceed
                // this. Short lines stay short -- slice just takes what is there.
                attr: at < 0 ? '' : raw.slice(at + 7, at + 6007),
                kind: rule?.kind ?? '',
                label: important ? (rule?.label ?? '') : '',
                important,
              });
              if (found.length >= cap) {
                stopped = true;
                break read;
              }
            }
          }
          await reader.cancel();
          return { lines: found, stopped };
        };

        const out: LogViewLine[] = [];
        let hasBefore = false;
        let hasAfter = false;

        for (const file of held) {
          const range = await rangeFor(file, fromMs, toMs);
          if (range.to <= range.from) continue;

          if (wantTail) {
            // Grow a slice backwards from the end of the window until it yields a full page, or
            // until it covers the window. Re-reading what the previous attempt already read costs
            // at most twice the final slice, which is far less than scanning a 36-hour log from
            // its start every time the reader scrolls up one screen.
            let span = REVERSE_FIRST;
            for (;;) {
              const start = Math.max(range.from, range.to - span);
              const { lines } = await scan(file, start, range.to, Number.POSITIVE_INFINITY);
              const enough = lines.length >= maxLines;
              if (enough || start === range.from || span >= SCAN_BUDGET) {
                // Lines earlier than this page exist if we dropped some, or if the slice never
                // reached the start of the window.
                if (lines.length > maxLines || start > range.from) hasBefore = true;
                out.push(...(lines.length > maxLines ? lines.slice(-maxLines) : lines));
                break;
              }
              span *= 4;
            }
          } else {
            const end = Math.min(range.to, range.from + SCAN_BUDGET);
            if (end < range.to) hasAfter = true;
            const { lines, stopped } = await scan(file, range.from, end, maxLines);
            if (stopped) hasAfter = true;
            out.push(...lines);
          }
        }

        out.sort((a, b) => a.tMs - b.tMs);
        // Several files under one capture are read independently, so the merge can exceed a page.
        // Trim from the end the reader is paging away from, and say so.
        let lines = out;
        if (lines.length > maxLines) {
          if (wantTail) {
            hasBefore = true;
            lines = lines.slice(-maxLines);
          } else {
            hasAfter = true;
            lines = lines.slice(0, maxLines);
          }
        }
        post({ kind: 'logRange', id, lines, hasBefore, hasAfter });
        break;
      }

      case 'logs': {
        // Copy the window into OPFS and build the annotations in one streaming pass. Nothing is
        // collected -- real bundles carry mongo_log_36h.log at 2.58 GB, and holding those lines
        // as JS strings is an out-of-memory crash, not a slow parse. Memory stays a few MB.
        //
        // Held, not read: clicking an event later reads the raw lines straight from disk. The
        // dropped File is what's held for this session; the OPFS copy is what a later reopen
        // will hold instead (see restoreLogs).
        logFiles.set(request.captureId, request.files);
        const onProgress: LogProgress = (p) =>
          post({
            kind: 'progress',
            id,
            file: p.file,
            filesDone: p.filesDone,
            filesTotal: p.filesTotal,
            samples: p.lines,
            bytesWritten: p.bytes,
          });

        const analysis = await persistAndAnalyze(
          store,
          request.captureId,
          request.files,
          request.fromMs,
          request.toMs,
          onProgress,
        );
        const transfer: Transferable[] = Object.values(analysis.series).flatMap((s) => [
          s.t.buffer,
          s.v.buffer,
        ]);
        post({ kind: 'logs', id, analysis }, transfer);
        break;
      }

      case 'restoreLogs': {
        // The reopen counterpart to 'logs': read the persisted log back from OPFS, hold its
        // Blobs for the viewer, and rebuild the annotations. Reuses the same 'logs' response.
        const onProgress: LogProgress = (p) =>
          post({
            kind: 'progress',
            id,
            file: p.file,
            filesDone: p.filesDone,
            filesTotal: p.filesTotal,
            samples: p.lines,
            bytesWritten: p.bytes,
          });
        const restored = await restoreLog(store, request.captureId, onProgress);
        // Null only if the sidecar vanished between listing and reopen; a capture asked to
        // restore had one when the recent list was built. Fall back to empty rather than throw.
        logFiles.set(request.captureId, restored?.files ?? []);
        const analysis = restored?.analysis ?? new LogAnalyzer().finish();
        const transfer: Transferable[] = Object.values(analysis.series).flatMap((s) => [
          s.t.buffer,
          s.v.buffer,
        ]);
        post({ kind: 'logs', id, analysis }, transfer);
        break;
      }

      case 'captures': {
        // Read manifests only -- no reader is opened, so this cannot collide with the sync
        // access handle another worker holds on the same capture's columns.bin.
        const dirs = await store.listDirs();
        const found: CaptureSummary[] = [];
        const unreadable: string[] = [];
        for (const dir of dirs) {
          try {
            const manifest = JSON.parse(
              await store.readText(`${dir}/manifest.json`),
            ) as CaptureManifest;
            // A separate existence check on the log sidecar, not a manifest field: the log is
            // attached after ingest, so the manifest was already written when it arrived.
            found.push({ ...summarise(manifest, []), hasLog: await hasStoredLog(store, dir) });
          } catch (err) {
            // A capture killed mid-ingest genuinely has no manifest, and skipping it is right.
            // Anything else here means a readable capture is being hidden, which looks exactly
            // like "it was never ingested" -- so it does not get to be silent.
            unreadable.push(`${dir}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        if (found.length === 0 && unreadable.length > 0) {
          throw new Error(`no capture could be listed -- ${unreadable.join('; ')}`);
        }
        post({ kind: 'captures', id, captures: found });
        break;
      }

      case 'drop': {
        // Release the sync access handle before removing the directory: OPFS will not delete
        // a file another handle still holds open, and it fails silently enough to look like
        // the capture came back from the dead on the next ingest.
        const open = readers.get(request.captureId);
        if (open !== undefined) {
          await open.close();
          readers.delete(request.captureId);
        }
        await store.removeDir(request.captureId);
        post({ kind: 'dropped', id });
        break;
      }
    }
  } catch (err) {
    post({ kind: 'error', id, message: err instanceof Error ? err.message : String(err) });
  }
};
