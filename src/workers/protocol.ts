/**
 * Main thread <-> worker message contract.
 *
 * The worker owns the storage layer outright. That is not a style preference: OPFS
 * `createSyncAccessHandle` is only available inside a Worker, so both ingest and reads have
 * to live there. The main thread never touches a FileStore.
 *
 * Series come back as transferable Float64Arrays -- the buffers are moved, not copied.
 */

import type { LogAnalysis } from '../logs/analyze.js';
import type { CatalogEntry, SeriesQuery } from '../data/reader.js';
import type { Change } from '../insights/ranking.js';
import type { CaptureManifest, Gap } from '../data/types.js';

export interface IngestRequest {
  readonly kind: 'ingest';
  readonly captureId: string;
  readonly files: File[];
}

export interface CatalogRequest {
  readonly kind: 'catalog';
  readonly captureId: string;
}

export interface SeriesRequest {
  readonly kind: 'series';
  readonly captureId: string;
  readonly paths: string[];
  readonly query: SeriesQuery;
}

/**
 * Rank every metric by how much it moved in a window, against an adjacent baseline.
 *
 * In the worker because it reads full resolution over every column: the answer is a few dozen
 * rows, but arriving at it touches every byte the window covers, and that is not work the main
 * thread should be holding still for.
 */
export interface ExplainRequest {
  readonly kind: 'explain';
  readonly captureId: string;
  readonly fromMs: number;
  readonly toMs: number;
  readonly baseFromMs: number;
  readonly baseToMs: number;
  /** Rows to return. The tail of a ranked list is noise by construction. */
  readonly limit?: number;
  /** Refuse rather than read a window wider than this many samples. See CaptureReader.scan. */
  readonly maxSamples?: number;
}

/**
 * Parse mongod logs and attach them to a capture.
 *
 * Parsing happens in the worker for the same reason decoding does: a support bundle's log is
 * routinely tens of megabytes, and the main thread should not be holding still for it.
 */
export interface LogsRequest {
  readonly kind: 'logs';
  readonly captureId: string;
  readonly files: File[];
  /**
   * Only index the part of the log covering this window -- normally the capture's own span.
   *
   * A bundle pairs a 36-hour, 2.58 GB log with a capture covering a few hours of it. Logs are
   * chronological and File.slice() is lazy, so the range is found by binary search and the
   * rest of the file is never read.
   */
  readonly fromMs?: number;
  readonly toMs?: number;
}

/**
 * Raw log lines within a time window, read on demand from the file the worker still holds.
 *
 * This is the log viewer's whole data source: the visible dashboard window in, the lines that
 * fall inside it out. Nothing is precomputed and nothing is cached -- the File is on disk and
 * the bytes for a window are a positioned read, so following the dashboard as it zooms costs a
 * few milliseconds per move rather than any resident memory.
 */
export interface LogRangeRequest {
  readonly kind: 'logRange';
  readonly captureId: string;
  readonly fromMs: number;
  readonly toMs: number;
  readonly maxLines: number;
  /** Show only the lines that classify as notable, for scanning a wide window. */
  readonly importantOnly: boolean;
  /** Case-insensitive substring filter, applied to the whole raw line. */
  readonly query: string;
  /**
   * Which end of the window to fill from.
   *
   * `head` takes the first `maxLines` -- a fresh window, and paging forwards. `tail` takes the
   * LAST `maxLines`, which is how the viewer pages backwards: it asks for the window ending at
   * the line it currently holds first. Without it, scrolling up could only be served by reading
   * the window from its start and throwing most of it away.
   */
  readonly end?: 'head' | 'tail';
}

/**
 * Summaries of every capture already in OPFS.
 *
 * Ingest produces a durable artifact, so re-opening one should cost nothing -- but until the
 * app can see what is on disk it cannot offer that, and a reload sends the user back to the
 * folder picker for a capture that is already decoded on their own machine.
 */
export interface CapturesRequest {
  readonly kind: 'captures';
}

/**
 * Re-attach a capture's persisted log after a reload, rebuilding its annotations.
 *
 * The raw log was copied into OPFS when it was first attached, so this reads it back rather than
 * asking the user to re-drop the mongod.log. Returns a `logs` response like a fresh attach.
 */
export interface RestoreLogsRequest {
  readonly kind: 'restoreLogs';
  readonly captureId: string;
}

/** Close the reader and delete the capture's bytes. Used when a capture is removed. */
export interface DropRequest {
  readonly kind: 'drop';
  readonly captureId: string;
}

export type Request =
  | IngestRequest
  | CatalogRequest
  | SeriesRequest
  | ExplainRequest
  | LogsRequest
  | LogRangeRequest
  | CapturesRequest
  | RestoreLogsRequest
  | DropRequest;

export interface IngestProgressMessage {
  readonly kind: 'progress';
  readonly id: number;
  readonly file: string;
  readonly filesDone: number;
  readonly filesTotal: number;
  readonly samples: number;
  readonly bytesWritten: number;
}

export interface CaptureSummary {
  readonly captureId: string;
  readonly hostname?: string;
  readonly mongoVersion?: string;
  /**
   * The FTDC type-0 metadata document -- host, CPU, RAM, OS, build, effective config, ulimits.
   *
   * Everything about a node that is not a number is here and nowhere else, because the sample
   * stream carries only numbers. Absent for a capture ingested before it was recorded.
   */
  readonly meta?: Record<string, unknown>;
  readonly sampleCount: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly cadenceMs: number;
  readonly pathCount: number;
  readonly gaps: Gap[];
  readonly restarts: number[];
  readonly skipped: string[];
  /**
   * A log was persisted with this capture and can be restored on reopen. Absent/false when the
   * capture has no stored log. Not carried in the manifest -- it is an existence check on the
   * log sidecar, done where the recent list is built.
   */
  readonly hasLog?: boolean;
}

/** One series, flattened for structured cloning. */
export interface SeriesPayload {
  readonly path: string;
  readonly t: Float64Array;
  readonly min: Float64Array;
  readonly max: Float64Array;
  readonly mean: Float64Array;
  readonly raw: boolean;
}

export type Response =
  | IngestProgressMessage
  | { readonly kind: 'ingested'; readonly id: number; readonly summary: CaptureSummary }
  | { readonly kind: 'catalog'; readonly id: number; readonly entries: CatalogEntry[] }
  | { readonly kind: 'series'; readonly id: number; readonly series: SeriesPayload[] }
  | {
      readonly kind: 'explain';
      readonly id: number;
      readonly changes: Change[];
      /** Metrics the window and the baseline had in common, i.e. what the ranking chose from. */
      readonly compared: number;
    }
  | { readonly kind: 'captures'; readonly id: number; readonly captures: CaptureSummary[] }
  | { readonly kind: 'logs'; readonly id: number; readonly analysis: LogAnalysis }
  | {
      readonly kind: 'logRange';
      readonly id: number;
      readonly lines: LogViewLine[];
      /**
       * Whether matching lines exist outside what was returned, on each side. This is what makes
       * the viewer's buffer a window onto the log rather than the whole of it: reaching either
       * edge is a question the reader can answer, so scrolling can load the next page instead of
       * stopping dead at an arbitrary cap.
       */
      readonly hasBefore: boolean;
      readonly hasAfter: boolean;
    }
  | { readonly kind: 'dropped'; readonly id: number }
  | { readonly kind: 'error'; readonly id: number; readonly message: string };

/**
 * One log line as read from disk.
 *
 * Message and attributes are separated because that is how a line reads -- the message says
 * what happened, the attributes say to what -- and the raw JSON put the useful half past the
 * ellipsis. `attr` is truncated in the worker so a slow-query line's 11 KB command document
 * does not travel across the port. `kind`/`label` carry the classification so the viewer can
 * highlight a notable line without re-running the rules.
 */
export interface LogViewLine {
  readonly tMs: number;
  readonly severity: string;
  readonly component: string;
  readonly msg: string;
  readonly attr: string;
  /** Classification kind, or '' for an ordinary line. */
  readonly kind: string;
  /** Human label when the line is notable enough to highlight, else ''. */
  readonly label: string;
  /** True for the classes that would otherwise have been markers. */
  readonly important: boolean;
}

export function summarise(manifest: CaptureManifest, skipped: string[]): CaptureSummary {
  return {
    captureId: manifest.captureId,
    ...(manifest.hostname !== undefined ? { hostname: manifest.hostname } : {}),
    ...(manifest.mongoVersion !== undefined ? { mongoVersion: manifest.mongoVersion } : {}),
    ...(manifest.meta !== undefined ? { meta: manifest.meta } : {}),
    sampleCount: manifest.sampleCount,
    startMs: manifest.startMs,
    endMs: manifest.endMs,
    cadenceMs: manifest.cadenceMs,
    pathCount: manifest.paths.length,
    gaps: manifest.gaps,
    restarts: manifest.restarts,
    skipped,
  };
}
