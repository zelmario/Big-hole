/**
 * Promise-based wrapper over a pool of decode workers.
 *
 * One worker per capture, up to `navigator.hardwareConcurrency`. That is the point of the
 * pool: a replica set is three or five captures, and decoding them one after another
 * serialises exactly the case the product exists for (ARCHITECTURE.md, "worker pool").
 *
 * A capture is pinned to the worker that ingested it and stays there. It has to: the worker
 * holds the OPFS sync access handle for that capture's columns.bin, and those handles are
 * exclusive, so a read routed elsewhere would fail rather than merely be slow.
 *
 * Ingest is long-running and reports progress, so it takes a callback; everything else is a
 * plain request/response pair.
 */

import type { LogAnalysis } from '../logs/analyze.js';
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

function poolSize(): number {
  const cores = typeof navigator === 'undefined' ? 4 : (navigator.hardwareConcurrency || 4);
  // More workers than captures buys nothing, and each one costs an OPFS handle plus a decoder
  // instance. Eight is well past any replica set a support engineer opens at once.
  return Math.max(1, Math.min(8, cores));
}

export class FtdcClient {
  private readonly workers: Worker[] = [];
  private readonly pending = new Map<number, Pending>();
  /** captureId -> index into `workers`; sticky for the life of the capture. */
  private readonly owner = new Map<string, number>();
  private nextId = 1;
  private nextWorker = 0;

  constructor(private readonly size: number = poolSize()) {}

  private worker(index: number): Worker {
    let w = this.workers[index];
    if (w === undefined) {
      w = new Worker(new URL('./ftdc.worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (event: MessageEvent<Response>) => this.receive(event.data);
      this.workers[index] = w;
    }
    return w;
  }

  private receive(msg: Response): void {
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
      case 'captures':
        this.pending.delete(msg.id);
        entry.resolve(msg.captures as never);
        return;
      case 'logs':
        this.pending.delete(msg.id);
        entry.resolve(msg.analysis as never);
        return;
      case 'dropped':
        this.pending.delete(msg.id);
        entry.resolve(undefined as never);
        return;
    }
  }

  /** Worker that owns this capture, assigning one on first use. */
  private route(captureId: string): Worker {
    let index = this.owner.get(captureId);
    if (index === undefined) {
      index = this.nextWorker % this.size;
      this.nextWorker++;
      this.owner.set(captureId, index);
    }
    return this.worker(index);
  }

  private send<T>(
    target: Worker,
    request: Request,
    onProgress?: (p: IngestProgressMessage) => void,
  ): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: never) => void,
        reject,
        ...(onProgress !== undefined ? { onProgress } : {}),
      });
      target.postMessage({ id, request });
    });
  }

  ingest(
    captureId: string,
    files: File[],
    onProgress?: (p: IngestProgressMessage) => void,
  ): Promise<CaptureSummary> {
    return this.send<CaptureSummary>(
      this.route(captureId),
      { kind: 'ingest', captureId, files },
      onProgress,
    );
  }

  catalog(captureId: string): Promise<CatalogEntry[]> {
    return this.send<CatalogEntry[]>(this.route(captureId), { kind: 'catalog', captureId });
  }

  series(captureId: string, paths: string[], query: SeriesQuery): Promise<SeriesPayload[]> {
    return this.send<SeriesPayload[]>(this.route(captureId), {
      kind: 'series',
      captureId,
      paths,
      query,
    });
  }

  /** Parse mongod logs for a capture. Routed to that capture's worker, like everything else. */
  logs(captureId: string, files: File[]): Promise<LogAnalysis> {
    return this.send<LogAnalysis>(this.route(captureId), { kind: 'logs', captureId, files });
  }

  /** Every capture already in OPFS, newest first. Reads manifests only. */
  captures(): Promise<CaptureSummary[]> {
    return this.send<CaptureSummary[]>(this.worker(0), { kind: 'captures' });
  }

  /**
   * Close the reader and delete the capture from OPFS.
   *
   * Routes even when the capture was never opened this session -- after a reload the recent
   * list is read from disk, so "forget" has to reach a capture no worker owns yet. Returning
   * early there left the bytes on disk while the row vanished from the UI.
   */
  async drop(captureId: string): Promise<void> {
    await this.send<void>(this.route(captureId), { kind: 'drop', captureId });
    this.owner.delete(captureId);
  }
}
