import { useRef, type ReactElement } from 'react';

import { useStore } from '../store/useStore.js';
import type { SourceFile } from '../ingest/discover.js';

/**
 * The loaded nodes, and the controls for them.
 *
 * With one capture this is a single chip and reads as a status line. With a replica set it is
 * the main navigation of the app: which members are drawn, which one the metric catalogue is
 * listing, and which was primary -- the last of those decides the sign of every cross-host
 * lag panel, so it is worth showing rather than leaving implicit.
 */
function shortTime(ms: number): string {
  return new Date(ms).toISOString().slice(11, 19);
}

export function CaptureBar(): ReactElement {
  const captures = useStore((s) => s.captures);
  const activeId = useStore((s) => s.activeId);
  const setActive = useStore((s) => s.setActive);
  const toggleCapture = useStore((s) => s.toggleCapture);
  const removeCapture = useStore((s) => s.removeCapture);
  const ingest = useStore((s) => s.ingest);
  const input = useRef<HTMLInputElement>(null);

  return (
    <div className="capture-bar">
      {captures.map((capture) => (
        <div
          key={capture.id}
          className={
            'capture-chip' +
            (capture.visible ? '' : ' off') +
            (capture.id === activeId ? ' active' : '')
          }
        >
          <input
            type="checkbox"
            checked={capture.visible}
            title="Draw this node"
            onChange={() => toggleCapture(capture.id)}
          />
          <button
            className="capture-name"
            title={`${capture.source || 'dropped folder'} — click to list its metrics`}
            onClick={() => setActive(capture.id)}
          >
            <b>{capture.label}</b>
            {capture.maxState === 1 && <span className="badge" title="was primary">P</span>}
            <span className="muted small">
              {' '}
              {capture.id} · {shortTime(capture.summary.startMs)}–
              {shortTime(capture.summary.endMs)} ·{' '}
              {capture.summary.sampleCount.toLocaleString()} samples
              {capture.summary.mongoVersion !== undefined && ` · ${capture.summary.mongoVersion}`}
            </span>
          </button>
          <button
            className="link small"
            title="Remove this node"
            onClick={() => void removeCapture(capture.id)}
          >
            ✕
          </button>
        </div>
      ))}

      <button className="link small" onClick={() => input.current?.click()}>
        + node
      </button>
      <input
        ref={input}
        type="file"
        multiple
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {...({ webkitdirectory: '', directory: '' } as any)}
        style={{ display: 'none' }}
        onChange={(e) => {
          const sources: SourceFile[] = Array.from(e.target.files ?? []).map((file) => ({
            file,
            path: file.webkitRelativePath || file.name,
          }));
          if (sources.length > 0) void ingest(sources);
          e.target.value = ''; // so the same folder can be picked again after a removal
        }}
      />
    </div>
  );
}
