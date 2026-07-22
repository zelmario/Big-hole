/**
 * Promise-based wrapper over the decode worker.
 *
 * Ingest is long-running and reports progress, so it takes a callback; everything else is a
 * plain request/response pair.
 */

import type { CatalogEntry, SeriesQuery } from '../data/reader.js';
import type {
  CaptureSummary,
  IngestProgressMessage,
  Request,
  Response,
  SeriesPayload,
} from './protocol.js';

type Pending = {
  resolve: (value: never) => void;
  reject: (err: Error) => void;
  onProgress?: (p: IngestProgressMessage) => void;
};

export class FtdcClient {
  private readonly worker: Worker;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;

  constructor() {
    this.worker = new Worker(new URL('./ftdc.worker.ts', import.meta.url), {
      type: 'module',
    });

    this.worker.onmessage = (event: MessageEvent<Response>) => {
      const msg = event.data;
      const entry = this.pending.get(msg.id);
      if (entry === undefined) return;

      switch (msg.kind) {
        case 'progress':
          entry.onProgress?.(msg);
          return; // progress does not settle the promise
        case 'error':
          this.pending.delete(msg.id);
          entry.reject(new Error(msg.message));
          return;
        case 'ingested':
          this.pending.delete(msg.id);
          entry.resolve(msg.summary as never);
          return;
        case 'catalog':
          this.pending.delete(msg.id);
          entry.resolve(msg.entries as never);
          return;
        case 'series':
          this.pending.delete(msg.id);
          entry.resolve(msg.series as never);
          return;
      }
    };
  }

  private send<T>(
    request: Request,
    onProgress?: (p: IngestProgressMessage) => void,
    transfer: Transferable[] = [],
  ): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: never) => void,
        reject,
        ...(onProgress !== undefined ? { onProgress } : {}),
      });
      this.worker.postMessage({ id, request }, transfer);
    });
  }

  ingest(
    captureId: string,
    files: File[],
    onProgress?: (p: IngestProgressMessage) => void,
  ): Promise<CaptureSummary> {
    return this.send<CaptureSummary>({ kind: 'ingest', captureId, files }, onProgress);
  }

  catalog(captureId: string): Promise<CatalogEntry[]> {
    return this.send<CatalogEntry[]>({ kind: 'catalog', captureId });
  }

  series(captureId: string, paths: string[], query: SeriesQuery): Promise<SeriesPayload[]> {
    return this.send<SeriesPayload[]>({ kind: 'series', captureId, paths, query });
  }
}
