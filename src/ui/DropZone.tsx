import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';

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
function when(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16);
}

function hours(from: number, to: number): string {
  const h = (to - from) / 3_600_000;
  return h >= 1 ? `${h.toFixed(1)} h` : `${Math.round(h * 60)} min`;
}

export function DropZone(): ReactElement {
  const ingest = useStore((s) => s.ingest);
  const status = useStore((s) => s.status);
  const progress = useStore((s) => s.progress);
  const logProgress = useStore((s) => s.logProgress);
  const error = useStore((s) => s.error);
  const recent = useStore((s) => s.recent);
  const loadRecent = useStore((s) => s.loadRecent);
  const reopen = useStore((s) => s.reopen);
  const forget = useStore((s) => s.forget);
  const [hover, setHover] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  // What is already decoded on this machine, asked for once on mount.
  useEffect(() => {
    void loadRecent();
  }, [loadRecent]);

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
    const logBytes = Object.values(logProgress).reduce((n, p) => n + p.bytes, 0);
    const logLineCount = Object.values(logProgress).reduce((n, p) => n + p.lines, 0);
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
        {/* Log parsing runs after a node's FTDC, and a multi-gigabyte log is not instant.
            Without this the FTDC bar sits full and it looks hung -- the reported complaint. */}
        {logBytes > 0 && (
          <div className="node-progress">
            <p className="muted small">
              reading log… {(logBytes / 1e6).toFixed(0)} MB · {logLineCount.toLocaleString()} lines
            </p>
            <div className="bar indeterminate">
              <div className="bar-fill" />
            </div>
          </div>
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

      {/* Ingest produces a durable artifact, so a capture opened before costs a manifest read
          to put back. Without this the folder picker was the only way in, for data already
          sitting decoded in OPFS. */}
      {recent.length > 0 && (
        <div className="recent">
          <div className="recent-head muted small">
            <span>already decoded on this machine</span>
            {recent.length > 1 && (
              <button
                className="link small"
                onClick={() => void reopen(recent.map((c) => c.captureId))}
              >
                open all {recent.length}
              </button>
            )}
          </div>
          <ul>
            {recent.map((capture) => (
              <li key={capture.captureId}>
                <button className="recent-open" onClick={() => void reopen([capture.captureId])}>
                  <b>{capture.hostname ?? capture.captureId}</b>
                  <span className="muted small">
                    {' '}
                    {when(capture.startMs)} · {hours(capture.startMs, capture.endMs)} ·{' '}
                    {capture.sampleCount.toLocaleString()} samples ·{' '}
                    {capture.pathCount.toLocaleString()} metrics
                    {capture.mongoVersion !== undefined && ` · ${capture.mongoVersion}`}
                  </span>
                </button>
                <button
                  className="link small"
                  title="Delete this capture's decoded data from this browser"
                  onClick={() => void forget(capture.captureId)}
                >
                  forget
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
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
