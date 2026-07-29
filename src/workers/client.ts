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
import type { Change } from '../insights/ranking.js';
import type {
  CaptureSummary,
  LogViewLine,
  IngestProgressMessage,
  Request,
  Response,
  SeriesPayload,
} from './protocol.js';

/** What moved in a window, and how many metrics that was chosen from. */
export interface ExplainResult {
  readonly changes: Change[];
  readonly compared: number;
}

/** One page of log lines, with whether the window holds more on either side of it. */
export interface LogPage {
  readonly lines: LogViewLine[];
  readonly hasBefore: boolean;
  readonly hasAfter: boolean;
}

type Pending = {
  resolve: (value: never) => void;
  reject: (err: Error) => void;
  onProgress?: (p: IngestProgressMessage) => void;
  /** Which worker owes this answer, so a failure in that worker can settle the promise. */
  target: Worker;
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
      // An error that escapes the worker's own handler settles nothing, so every request
      // routed to that worker stays pending forever -- and because ingest awaits all of its
      // nodes together, one such error leaves the whole app on "Decoding…" with nothing on
      // screen to say why. A silent permanent wait is strictly worse than the error it hides.
      //
      // The worker is not discarded, only its outstanding requests: `onerror` does not mean
      // the worker is gone, and it must keep its OPFS handles for the captures pinned to it.
      // (A worker the browser really does terminate fires nothing at all, and nothing here can
      // help with that.)
      const failed = (detail: string): void => this.abandon(w!, detail);
      w.onerror = (e: ErrorEvent) => failed(e.message || 'the decode worker failed');
      w.onmessageerror = () => failed('a reply from the decode worker could not be read');
      this.workers[index] = w;
    }
    return w;
  }

  /** Fail every request this worker still owes, so its callers stop waiting on an answer. */
  private abandon(target: Worker, detail: string): void {
    for (const [id, entry] of [...this.pending]) {
      if (entry.target !== target) continue;
      this.pending.delete(id);
      entry.reject(new Error(detail));
    }
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
      case 'explain':
        this.pending.delete(msg.id);
        entry.resolve({ changes: msg.changes, compared: msg.compared } as never);
        return;
      case 'captures':
        this.pending.delete(msg.id);
        entry.resolve(msg.captures as never);
        return;
      case 'logs':
        this.pending.delete(msg.id);
        entry.resolve(msg.analysis as never);
        return;
      case 'logRange':
        this.pending.delete(msg.id);
        entry.resolve({
          lines: msg.lines,
          hasBefore: msg.hasBefore,
          hasAfter: msg.hasAfter,
        } as never);
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
        target,
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

  /**
   * Rank every metric in a capture by how much it moved in a window, against a baseline.
   *
   * Routed to the capture's worker like every other read. Rejects when the window is wider than
   * the scan's sample cap -- that is a real answer ("narrow it"), not a failure to hide.
   */
  explain(
    captureId: string,
    window: { fromMs: number; toMs: number },
    baseline: { fromMs: number; toMs: number },
    opts: { limit?: number; maxSamples?: number } = {},
  ): Promise<ExplainResult> {
    return this.send<ExplainResult>(this.route(captureId), {
      kind: 'explain',
      captureId,
      fromMs: window.fromMs,
      toMs: window.toMs,
      baseFromMs: baseline.fromMs,
      baseToMs: baseline.toMs,
      ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
      ...(opts.maxSamples !== undefined ? { maxSamples: opts.maxSamples } : {}),
    });
  }

  /**
   * Parse mongod logs for a capture, indexing only the window the capture covers.
   *
   * Routed to that capture's worker, like everything else, and the worker keeps the file
   * handles so raw lines can be read later without holding any of the log in memory.
   */
  logs(
    captureId: string,
    files: File[],
    fromMs?: number,
    toMs?: number,
    onProgress?: (p: IngestProgressMessage) => void,
  ): Promise<LogAnalysis> {
    return this.send<LogAnalysis>(
      this.route(captureId),
      {
        kind: 'logs',
        captureId,
        files,
        ...(fromMs !== undefined ? { fromMs } : {}),
        ...(toMs !== undefined ? { toMs } : {}),
      },
      onProgress,
    );
  }

  /**
   * Raw log lines within a window, read positionally from the file on disk.
   *
   * The log viewer's only data source. `hasBefore`/`hasAfter` report what the window holds
   * outside the page returned, which is what lets the viewer page rather than stop at the cap.
   */
  logLines(
    captureId: string,
    fromMs: number,
    toMs: number,
    opts: {
      maxLines?: number;
      importantOnly?: boolean;
      query?: string;
      end?: 'head' | 'tail';
    } = {},
  ): Promise<LogPage> {
    return this.send<LogPage>(this.route(captureId), {
      kind: 'logRange',
      captureId,
      fromMs,
      toMs,
      maxLines: opts.maxLines ?? 500,
      importantOnly: opts.importantOnly ?? false,
      query: opts.query ?? '',
      end: opts.end ?? 'head',
    });
  }

  /**
   * Re-attach a capture's persisted log after a reload.
   *
   * Reads the raw log back from OPFS and rebuilds its annotations -- the reopen counterpart to
   * {@link logs}. Routed to the capture's worker, which then holds the restored bytes for the
   * viewer's positioned reads, exactly as a fresh attach would.
   */
  restoreLogs(
    captureId: string,
    onProgress?: (p: IngestProgressMessage) => void,
  ): Promise<LogAnalysis> {
    return this.send<LogAnalysis>(
      this.route(captureId),
      { kind: 'restoreLogs', captureId },
      onProgress,
    );
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
