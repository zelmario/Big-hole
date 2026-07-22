import { useRef, useState, type ReactElement } from 'react';

import { useStore } from '../store/useStore.js';
import { fromFile, toFile } from '../dashboard/library.js';
import { LAYOUT_VERSION } from '../dashboard/layout.js';

function when(ms: number): string {
  const age = Date.now() - ms;
  if (age < 60_000) return 'just now';
  if (age < 3_600_000) return `${Math.floor(age / 60_000)}m ago`;
  if (age < 86_400_000) return `${Math.floor(age / 3_600_000)}h ago`;
  return `${Math.floor(age / 86_400_000)}d ago`;
}

/**
 * Dashboard picker: switch, save, rename, delete, import, export.
 *
 * The ported Grafana dashboard is a starting point. An engineer building a view for a
 * particular class of problem needs to keep it, so saved dashboards are first-class and the
 * built-in one is always recoverable from "Restore default".
 */
export function DashboardMenu(): ReactElement {
  const library = useStore((s) => s.library);
  const currentId = useStore((s) => s.currentId);
  const panels = useStore((s) => s.panels);
  const range = useStore((s) => s.range);
  const currentName = useStore((s) => s.currentName);
  const dirty = useStore((s) => s.isDirty);
  const saveCurrent = useStore((s) => s.saveCurrent);
  const saveAsNew = useStore((s) => s.saveAsNew);
  const openDashboard = useStore((s) => s.openDashboard);
  const removeDashboard = useStore((s) => s.deleteDashboard);
  const renameDashboard = useStore((s) => s.renameDashboard);
  const newDashboard = useStore((s) => s.newDashboard);
  const restoreDefault = useStore((s) => s.restoreDefault);
  const applyImported = useStore((s) => s.applyImported);

  const [open, setOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const name = currentName();
  const unsaved = dirty();

  const flash = (message: string): void => {
    setNote(message);
    setTimeout(() => setNote(null), 2500);
  };

  const save = (): void => {
    if (currentId === null) {
      const chosen = window.prompt('Name this dashboard', 'My dashboard');
      if (chosen === null) return;
      saveAsNew(chosen);
    } else {
      saveCurrent();
    }
    flash('saved');
    setOpen(false);
  };

  const saveAs = (): void => {
    const chosen = window.prompt('Save a copy as', `${name} copy`);
    if (chosen === null) return;
    saveAsNew(chosen);
    flash('saved a copy');
    setOpen(false);
  };

  const exportJson = (): void => {
    const blob = new Blob([toFile(name, { v: LAYOUT_VERSION, panels, range })], {
      type: 'application/json',
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${name.replace(/[^\w.-]+/g, '-').toLowerCase()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    setOpen(false);
  };

  const importJson = async (file: File): Promise<void> => {
    const parsed = fromFile(await file.text());
    if (parsed === null) {
      flash('not a valid dashboard file');
      return;
    }
    applyImported(parsed.name, parsed.state);
    flash(`imported “${parsed.name}”`);
    setOpen(false);
  };

  return (
    <div className="dashmenu">
      <button className="dash-current" onClick={() => setOpen(!open)} title="Dashboards">
        ▤ {name}
        {unsaved && <span className="dirty" title="Unsaved changes">•</span>}
      </button>

      {note !== null && <span className="muted small">{note}</span>}

      {open && (
        <>
          {/* Click-away layer, so the menu closes like a real dropdown. */}
          <div className="dash-scrim" onClick={() => setOpen(false)} />
          <div className="dash-menu">
            <div className="dash-actions">
              <button onClick={save}>{currentId === null ? 'Save as…' : 'Save'}</button>
              <button onClick={saveAs} disabled={currentId === null}>
                Save a copy…
              </button>
            </div>

            <div className="dash-actions">
              <button
                onClick={() => {
                  newDashboard();
                  setOpen(false);
                }}
              >
                New empty
              </button>
              <button
                onClick={() => {
                  restoreDefault();
                  setOpen(false);
                  flash('default restored');
                }}
              >
                Restore default
              </button>
            </div>

            <div className="dash-actions">
              <button onClick={exportJson}>Export JSON</button>
              <button onClick={() => fileInput.current?.click()}>Import JSON…</button>
              <input
                ref={fileInput}
                type="file"
                accept="application/json,.json"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file !== undefined) void importJson(file);
                }}
              />
            </div>

            <div className="dash-list-head muted small">
              {library.length === 0 ? 'No saved dashboards yet' : 'Saved dashboards'}
            </div>

            <ul className="dash-list">
              {library.map((d) => (
                <li key={d.id} className={d.id === currentId ? 'dash-row on' : 'dash-row'}>
                  <button
                    className="dash-open"
                    onClick={() => {
                      openDashboard(d.id);
                      setOpen(false);
                    }}
                    title="Open"
                  >
                    <span className="dash-name">{d.name}</span>
                    <span className="muted small">{when(d.updatedAt)}</span>
                  </button>
                  <button
                    className="link small"
                    title="Rename"
                    onClick={() => {
                      const next = window.prompt('Rename dashboard', d.name);
                      if (next !== null) renameDashboard(d.id, next);
                    }}
                  >
                    ✎
                  </button>
                  <button
                    className="link small danger"
                    title="Delete"
                    onClick={() => {
                      if (window.confirm(`Delete “${d.name}”? This cannot be undone.`)) {
                        removeDashboard(d.id);
                      }
                    }}
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}
