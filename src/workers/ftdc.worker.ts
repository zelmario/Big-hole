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
import { OpfsFileStore } from '../data/fileStore.js';
import { CaptureWriter } from '../data/writer.js';
import { CaptureReader } from '../data/reader.js';
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
 * A File is a reference to bytes on disk; holding one costs nothing and makes "show me the log
 * around this moment" a positioned read instead of a reason to keep 2.5 GB in memory.
 */
const logFiles = new Map<string, File[]>();

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

  const manifest = await writer.finish();

  post({
    kind: 'ingested',
    id,
    summary: {
      ...summarise(manifest, skipped),
      ...(hostname !== undefined ? { hostname } : {}),
      ...(mongoVersion !== undefined ? { mongoVersion } : {}),
    },
  });
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

      case 'logRange': {
        // The log viewer's data source. The File handles are still held from ingest, so the
        // bytes covering the visible window are a positioned read -- following the dashboard as
        // it zooms costs milliseconds, not memory.
        const held = logFiles.get(request.captureId) ?? [];
        const { fromMs, toMs, maxLines, importantOnly } = request;
        const query = request.query.toLowerCase();
        const out: LogViewLine[] = [];
        let truncated = false;
        // Never read more than this scanning for notable lines in a wide window; past it the
        // viewer says so and asks for a narrower one.
        const SCAN_BUDGET = 256 * 1024 * 1024;

        for (const file of held) {
          if (out.length >= maxLines) break;
          const range = await rangeFor(file, fromMs, toMs);
          if (range.to <= range.from) continue;
          const end = Math.min(range.to, range.from + SCAN_BUDGET);
          if (end < range.to) truncated = true;

          const reader = file
            .slice(range.from, end)
            .stream()
            .pipeThrough(new TextDecoderStream())
            .getReader();
          let carry = '';
          const stats = emptyStats();

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
              out.push({
                tMs: line.tMs,
                severity: line.s,
                component: line.c,
                msg: line.msg,
                // Enough to identify the operation; the whole command document is not worth
                // moving across the port to be ellipsized in a narrow column.
                attr: at < 0 ? '' : raw.slice(at + 7, at + 407),
                kind: rule?.kind ?? '',
                label: important ? (rule?.label ?? '') : '',
                important,
              });
              if (out.length >= maxLines) {
                truncated = true;
                break read;
              }
            }
          }
          await reader.cancel();
        }

        out.sort((a, b) => a.tMs - b.tMs);
        post({ kind: 'logRange', id, lines: out, truncated });
        break;
      }

      case 'logs': {
        // Streamed into the analyzer, never collected. Real bundles carry mongo_log_36h.log at
        // 2.58 GB; holding those lines as JS strings is an out-of-memory crash, not a slow
        // parse. Memory here is the accumulators only, a few MB whatever the file size.
        const analyzer = new LogAnalyzer();
        let bytes = 0;
        let lines = 0;
        let done = 0;
        let skipped = 0;
        // Held, not read: clicking an event later reads the raw lines straight from disk.
        logFiles.set(request.captureId, request.files);

        for (const file of request.files) {
          // Only the part covering the capture. On a 36-hour log beside a 4-hour capture this
          // is the difference between reading 2.5 GB and reading a few hundred megabytes.
          const range = await rangeFor(file, request.fromMs, request.toMs);
          skipped += file.size - (range.to - range.from);
          if (range.to <= range.from) {
            done++;
            continue;
          }
          const reader = file
            .slice(range.from, range.to)
            .stream()
            .pipeThrough(new TextDecoderStream())
            .getReader();
          let carry = '';
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.length;
            const parts = (carry + chunk.value).split('\n');
            // The last piece may be half a line; the next chunk completes it.
            carry = parts.pop() ?? '';
            for (const part of parts) {
              analyzer.push(part);
              lines++;
            }
            // A 2.5 GB log takes a while. Say so, or it looks like a hang.
            if (lines % 200_000 < parts.length) {
              post({
                kind: 'progress',
                id,
                file: file.name,
                filesDone: done,
                filesTotal: request.files.length,
                samples: lines,
                bytesWritten: bytes,
              });
            }
          }
          if (carry.length > 0) analyzer.push(carry);
          done++;
        }

        const analysis = analyzer.finish();
        if (skipped > 0) {
          // eslint-disable-next-line no-console
          console.info(
            `ftdc-lens: indexed ${(bytes / 1e6).toFixed(0)} MB of log, skipped ` +
              `${(skipped / 1e6).toFixed(0)} MB outside the capture window`,
          );
        }
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
            found.push(summarise(manifest, []));
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
