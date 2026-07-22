import { create } from 'zustand';

import type { CatalogEntry } from '../data/reader.js';
import { FtdcClient } from '../workers/client.js';
import type { CaptureSummary, IngestProgressMessage } from '../workers/protocol.js';

const CAPTURE_ID = 'capture-0'; // single capture until M4

export interface Progress {
  readonly file: string;
  readonly filesDone: number;
  readonly filesTotal: number;
  readonly samples: number;
  readonly bytesWritten: number;
}

interface State {
  readonly client: FtdcClient;
  status: 'empty' | 'ingesting' | 'ready' | 'error';
  error: string | null;
  progress: Progress | null;
  summary: CaptureSummary | null;
  catalog: CatalogEntry[];
  selected: string[];
  /** Visible window in epoch ms; null means the whole capture. */
  range: [number, number] | null;
  /** Shared time cursor in epoch ms, or null when the pointer is off-chart. */
  cursor: number | null;

  ingest(files: File[]): Promise<void>;
  toggle(path: string): void;
  setRange(range: [number, number] | null): void;
  setCursor(ms: number | null): void;
  reset(): void;
}

/** Metrics worth showing first: they answer "is this server in trouble" faster than anything else. */
const DEFAULT_METRICS = [
  'serverStatus.wiredTiger.concurrentTransactions.read.available',
  'serverStatus.wiredTiger.concurrentTransactions.write.available',
  'serverStatus.wiredTiger.cache.bytes currently in the cache',
  'serverStatus.connections.current',
  'serverStatus.opcounters.query',
  'serverStatus.opcounters.insert',
  'serverStatus.globalLock.currentQueue.readers',
  'serverStatus.globalLock.currentQueue.writers',
];

export const useStore = create<State>((set, get) => ({
  client: new FtdcClient(),
  status: 'empty',
  error: null,
  progress: null,
  summary: null,
  catalog: [],
  selected: [],
  range: null,
  cursor: null,

  async ingest(files: File[]) {
    set({ status: 'ingesting', error: null, progress: null });
    try {
      const onProgress = (p: IngestProgressMessage) =>
        set({
          progress: {
            file: p.file,
            filesDone: p.filesDone,
            filesTotal: p.filesTotal,
            samples: p.samples,
            bytesWritten: p.bytesWritten,
          },
        });

      const summary = await get().client.ingest(CAPTURE_ID, files, onProgress);
      const catalog = await get().client.catalog(CAPTURE_ID);

      const available = new Set(catalog.map((c) => c.path));
      const selected = DEFAULT_METRICS.filter((p) => available.has(p));

      set({
        status: 'ready',
        summary,
        catalog,
        // Fall back to whatever varies, so an unfamiliar server shape still shows something.
        selected:
          selected.length > 0
            ? selected
            : catalog.filter((c) => !c.flat).slice(0, 4).map((c) => c.path),
        range: null,
        progress: null,
      });
    } catch (err) {
      set({
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
        progress: null,
      });
    }
  },

  toggle(path: string) {
    const selected = get().selected;
    set({
      selected: selected.includes(path)
        ? selected.filter((p) => p !== path)
        : [...selected, path],
    });
  },

  setRange(range) {
    set({ range });
  },

  setCursor(ms) {
    set({ cursor: ms });
  },

  reset() {
    set({ status: 'empty', summary: null, catalog: [], selected: [], range: null, error: null });
  },
}));

export { CAPTURE_ID };
