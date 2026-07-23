import { useCallback, useRef, useState, type ReactElement } from 'react';

import { useStore } from '../store/useStore.js';
import type { SourceFile } from '../ingest/discover.js';

/**
 * Accepts a dropped `diagnostic.data` directory, or a folder picked through the file input.
 *
 * Directory drops arrive as a FileSystemEntry tree, which has to be walked -- `dataTransfer.files`
 * is empty for folders. Nothing is uploaded anywhere; the files are read in a worker on this
 * machine and that is the whole product promise.
 *
 * The walk keeps each file's path as well as the file. `File.name` is only the basename, and
 * without the directory there is no way to tell one replica-set member's metrics from
 * another's -- they are all called `metrics.<timestamp>`, and merging them would produce one
 * incoherent timeline rather than three nodes.
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

      const files: SourceFile[] = [];
      for (const entry of entries) await walk(entry, files);

      if (files.length === 0) {
        // A plain multi-file drop: no directories to group by, so it is one capture.
        for (const f of Array.from(event.dataTransfer.files)) files.push({ file: f, path: f.name });
      }
      if (files.length > 0) await ingest(files);
    },
    [ingest],
  );

  if (status === 'ingesting') {
    // One bar per node: they decode concurrently, one worker each, and a single merged bar
    // would hide a member that is stuck while the others finish.
    const nodes = Object.entries(progress);
    return (
      <div className="drop working">
        <h2>Decoding{nodes.length > 1 ? ` ${nodes.length} nodes` : ''}…</h2>
        {nodes.map(([label, p]) => {
          const pct = p.filesTotal > 0 ? Math.round((p.filesDone / p.filesTotal) * 100) : 0;
          return (
            <div key={label} className="node-progress">
              <p className="muted small">
                <b>{label}</b> — {p.filesDone} / {p.filesTotal} files ·{' '}
                {p.samples.toLocaleString()} samples ·{' '}
                {(p.bytesWritten / 1e6).toFixed(1)} MB written
              </p>
              <div className="bar">
                <div className="bar-fill" style={{ width: `${pct}%` }} />
              </div>
              <p className="muted small">{p.file}</p>
            </div>
          );
        })}
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
        Or a folder containing one per node — a whole replica set loads at once, one worker
        each, and every panel becomes a per-member comparison.
      </p>
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
          const files: SourceFile[] = Array.from(e.target.files ?? []).map((file) => ({
            file,
            // webkitRelativePath keeps the picked folder's tree, so a bundle containing
            // several members still groups into one capture per member.
            path: file.webkitRelativePath || file.name,
          }));
          if (files.length > 0) void ingest(files);
        }}
      />
      {error !== null && <p className="error">{error}</p>}
    </div>
  );
}

async function walk(entry: FileSystemEntry, out: SourceFile[]): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) =>
      (entry as FileSystemFileEntry).file(resolve, reject),
    );
    // fullPath is relative to the drop, which is exactly the grouping key we want.
    out.push({ file, path: entry.fullPath.replace(/^\//, '') || file.name });
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
