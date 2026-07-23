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
 * Parse mongod logs and attach them to a capture.
 *
 * Parsing happens in the worker for the same reason decoding does: a support bundle's log is
 * routinely tens of megabytes, and the main thread should not be holding still for it.
 */
export interface LogsRequest {
  readonly kind: 'logs';
  readonly captureId: string;
  readonly files: File[];
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

/** Close the reader and delete the capture's bytes. Used when a capture is removed. */
export interface DropRequest {
  readonly kind: 'drop';
  readonly captureId: string;
}

export type Request =
  | IngestRequest
  | CatalogRequest
  | SeriesRequest
  | LogsRequest
  | CapturesRequest
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
  readonly sampleCount: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly cadenceMs: number;
  readonly pathCount: number;
  readonly gaps: Gap[];
  readonly restarts: number[];
  readonly skipped: string[];
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
  | { readonly kind: 'captures'; readonly id: number; readonly captures: CaptureSummary[] }
  | { readonly kind: 'logs'; readonly id: number; readonly analysis: LogAnalysis }
  | { readonly kind: 'dropped'; readonly id: number }
  | { readonly kind: 'error'; readonly id: number; readonly message: string };

export function summarise(manifest: CaptureManifest, skipped: string[]): CaptureSummary {
  return {
    captureId: manifest.captureId,
    ...(manifest.hostname !== undefined ? { hostname: manifest.hostname } : {}),
    ...(manifest.mongoVersion !== undefined ? { mongoVersion: manifest.mongoVersion } : {}),
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
