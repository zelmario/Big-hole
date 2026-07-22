import { useCallback, useRef, useState, type ReactElement } from 'react';

import { useStore } from '../store/useStore.js';

/**
 * Accepts a dropped `diagnostic.data` directory, or a folder picked through the file input.
 *
 * Directory drops arrive as a FileSystemEntry tree, which has to be walked -- `dataTransfer.files`
 * is empty for folders. Nothing is uploaded anywhere; the files are read in a worker on this
 * machine and that is the whole product promise.
 */
export function DropZone(): ReactElement {
  const ingest = useStore((s) => s.ingest);
  const status = useStore((s) => s.status);
  const progress = useStore((s) => s.progress);
  const error = useStore((s) => s.error);
  const [hover, setHover] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const onDrop = useCallback(
    async (event: React.DragEvent) => {
      event.preventDefault();
      setHover(false);

      const entries = Array.from(event.dataTransfer.items)
        .map((item) => item.webkitGetAsEntry())
        .filter((e): e is FileSystemEntry => e !== null);

      const files: File[] = [];
      for (const entry of entries) await walk(entry, files);

      if (files.length === 0) {
        for (const f of Array.from(event.dataTransfer.files)) files.push(f);
      }
      if (files.length > 0) await ingest(files);
    },
    [ingest],
  );

  if (status === 'ingesting') {
    const pct =
      progress && progress.filesTotal > 0
        ? Math.round((progress.filesDone / progress.filesTotal) * 100)
        : 0;
    return (
      <div className="drop working">
        <h2>Decoding…</h2>
        {progress && (
          <>
            <div className="bar">
              <div className="bar-fill" style={{ width: `${pct}%` }} />
            </div>
            <p className="muted">
              {progress.filesDone} / {progress.filesTotal} files ·{' '}
              {progress.samples.toLocaleString()} samples ·{' '}
              {(progress.bytesWritten / 1e6).toFixed(1)} MB written
            </p>
            <p className="muted small">{progress.file}</p>
          </>
        )}
      </div>
    );
  }

  return (
    <div
      className={hover ? 'drop hover' : 'drop'}
      onDragOver={(e) => {
        e.preventDefault();
        setHover(true);
      }}
      onDragLeave={() => setHover(false)}
      onDrop={onDrop}
    >
      <h2>Drop a diagnostic.data folder</h2>
      <p className="muted">
        Everything is decoded on this machine. No upload, no server, no telemetry.
      </p>
      <button onClick={() => input.current?.click()}>Choose folder…</button>
      <input
        ref={input}
        type="file"
        multiple
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {...({ webkitdirectory: '', directory: '' } as any)}
        style={{ display: 'none' }}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length > 0) void ingest(files);
        }}
      />
      {error !== null && <p className="error">{error}</p>}
    </div>
  );
}

async function walk(entry: FileSystemEntry, out: File[]): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) =>
      (entry as FileSystemFileEntry).file(resolve, reject),
    );
    out.push(file);
    return;
  }
  if (entry.isDirectory) {
    const dir = (entry as FileSystemDirectoryEntry).createReader();
    // readEntries returns at most ~100 per call and must be drained.
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
        dir.readEntries(resolve, reject),
      );
      if (batch.length === 0) break;
      for (const child of batch) await walk(child, out);
    }
  }
}
