/**
 * Decode + storage worker.
 *
 * Owns the OPFS store (sync access handles are worker-only) and keeps the main thread free
 * during ingest, which is CPU-bound for as long as it takes to decode the capture.
 */

/// <reference lib="webworker" />

import { decodeFTDC, readMetadata } from '../ftdc/index.js';
import { OpfsFileStore } from '../data/fileStore.js';
import { CaptureWriter } from '../data/writer.js';
import { CaptureReader } from '../data/reader.js';
import {
  summarise,
  type Request,
  type Response,
  type SeriesPayload,
} from './protocol.js';

const store = new OpfsFileStore();
const readers = new Map<string, CaptureReader>();

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
  readers.get(captureId)?.close();
  readers.delete(captureId);

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
        const series: SeriesPayload[] = [];
        const transfer: Transferable[] = [];

        for (const path of request.paths) {
          const s = await r.getSeries(path, request.query);
          // Copy before transferring: raw results alias the reader's cached clock, and
          // transferring that buffer would detach it for every later query.
          const t = Float64Array.from(s.t);
          const min = Float64Array.from(s.min);
          const max = Float64Array.from(s.max);
          const mean = Float64Array.from(s.mean);
          series.push({ path, t, min, max, mean, raw: s.raw });
          transfer.push(t.buffer, min.buffer, max.buffer, mean.buffer);
        }

        post({ kind: 'series', id, series }, transfer);
        break;
      }
    }
  } catch (err) {
    post({ kind: 'error', id, message: err instanceof Error ? err.message : String(err) });
  }
};
