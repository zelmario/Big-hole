/**
 * Saved dashboards.
 *
 * The library is a compatibility surface like the permalink: an engineer saves a view and
 * expects it back weeks later, possibly after the app has been updated. So it validates on
 * read rather than trusting whatever is in storage.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  LAYOUT_VERSION,
  loadLayout,
  saveLayout,
  type DashboardState,
} from '../src/dashboard/layout.js';
import {
  deleteDashboard,
  fromFile,
  getCurrentId,
  getDashboard,
  isDirty,
  listDashboards,
  renameDashboard,
  saveDashboard,
  toFile,
  type SavedDashboard,
} from '../src/dashboard/library.js';

// Node has no localStorage; a minimal stand-in is enough and keeps the test honest about
// what the module actually touches.
class MemoryStorage {
  private data = new Map<string, string>();
  getItem(k: string): string | null {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.data.set(k, v);
  }
  removeItem(k: string): void {
    this.data.delete(k);
  }
  clear(): void {
    this.data.clear();
  }
}

const state = (title: string): DashboardState => ({
  v: LAYOUT_VERSION,
  panels: [
    { id: 'p1', kind: 'chart', title, metrics: ['serverStatus.mem.resident'], x: 0, y: 0, w: 12, h: 8 },
  ],
  range: null,
});

beforeEach(() => {
  vi.stubGlobal('localStorage', new MemoryStorage());
});

describe('dashboard library', () => {
  it('saves, lists and reopens', () => {
    const saved = saveDashboard('Replication', state('Lag'));
    expect(listDashboards().map((d) => d.name)).toEqual(['Replication']);
    expect(getDashboard(saved.id)?.state.panels[0]?.title).toBe('Lag');
    expect(getCurrentId()).toBe(saved.id);
  });

  it('updates in place when given an id, rather than duplicating', () => {
    const first = saveDashboard('Cache', state('v1'));
    saveDashboard('Cache', state('v2'), first.id);
    const all = listDashboards();
    expect(all).toHaveLength(1);
    expect(all[0]!.state.panels[0]!.title).toBe('v2');
  });

  it('orders by most recently updated', () => {
    const a = saveDashboard('A', state('a'));
    saveDashboard('B', state('b'));
    saveDashboard('A again', state('a2'), a.id);
    expect(listDashboards()[0]!.name).toBe('A again');
  });

  it('renames and deletes', () => {
    const saved = saveDashboard('Old', state('x'));
    renameDashboard(saved.id, 'New');
    expect(listDashboards()[0]!.name).toBe('New');
    deleteDashboard(saved.id);
    expect(listDashboards()).toEqual([]);
    expect(getCurrentId()).toBeNull();
  });

  it('falls back to a name rather than saving an empty one', () => {
    expect(saveDashboard('   ', state('x')).name).toBe('Untitled');
  });

  it('drops entries from an older layout version instead of rendering them', () => {
    localStorage.setItem(
      'big-hole:dashboards',
      JSON.stringify([
        { id: 'old', name: 'Ancient', updatedAt: 1, state: { v: 1, panels: [], range: null } },
      ]),
    );
    expect(listDashboards()).toEqual([]);
  });

  it('survives corrupt storage', () => {
    localStorage.setItem('big-hole:dashboards', '{not json');
    expect(listDashboards()).toEqual([]);
  });

  it('tracks unsaved changes', () => {
    const saved = saveDashboard('Work', state('one'));
    expect(isDirty(saved.id, state('one'))).toBe(false);
    expect(isDirty(saved.id, state('two'))).toBe(true);
    // Never saved: always dirty, so Save prompts for a name.
    expect(isDirty(null, state('one'))).toBe(true);
  });
});

describe('dashboard files', () => {
  it('round-trips through export and import', () => {
    const text = toFile('Exported', state('panel'));
    const back = fromFile(text);
    expect(back?.name).toBe('Exported');
    expect(back?.state.panels[0]?.title).toBe('panel');
  });

  it('rejects files that are not dashboards', () => {
    expect(fromFile('{}')).toBeNull();
    expect(fromFile('not json at all')).toBeNull();
    expect(fromFile(JSON.stringify({ kind: 'something-else', state: state('x') }))).toBeNull();
  });

  it('rejects a dashboard file from an older layout version', () => {
    const stale = JSON.stringify({
      kind: 'ftdc-lens-dashboard',
      v: 1,
      name: 'Old',
      state: { v: 1, panels: [], range: null },
    });
    expect(fromFile(stale)).toBeNull();
  });
});

/**
 * Surviving the rename.
 *
 * The project was ftdc-lens while it was being built and is Big Hole now. Saved dashboards and
 * the working layout are the only things in this app a user has actually authored, so a rename
 * is the worst possible reason to lose them -- and a layout that silently reverts to the
 * default is indistinguishable from a bug.
 */
describe('state saved under the old name', () => {
  const legacy: SavedDashboard = {
    id: 'old',
    name: 'Replication',
    updatedAt: 5,
    state: state('panel'),
  };

  it('moves saved dashboards across on first read', () => {
    localStorage.setItem('ftdc-lens:dashboards', JSON.stringify([legacy]));
    localStorage.setItem('ftdc-lens:current', JSON.stringify('old'));

    expect(listDashboards().map((d) => d.name)).toEqual(['Replication']);
    expect(getCurrentId()).toBe('old');
    // Moved, not copied: the old keys must not linger and shadow later edits.
    expect(localStorage.getItem('ftdc-lens:dashboards')).toBeNull();
    expect(localStorage.getItem('big-hole:dashboards')).not.toBeNull();
  });

  it('does not overwrite dashboards already saved under the new name', () => {
    saveDashboard('Current', state('new'));
    localStorage.setItem('ftdc-lens:dashboards', JSON.stringify([legacy]));
    expect(listDashboards().map((d) => d.name)).toEqual(['Current']);
  });

  it('moves the working layout across too', () => {
    localStorage.setItem('ftdc-lens:layout', JSON.stringify(state('working')));
    expect(loadLayout()?.panels[0]?.title).toBe('working');
    expect(localStorage.getItem('ftdc-lens:layout')).toBeNull();
    // And the next save lands under the new key, where the next load will look for it.
    saveLayout(state('edited'));
    expect(loadLayout()?.panels[0]?.title).toBe('edited');
  });

  it('still imports a dashboard file exported before the rename', () => {
    const exported = JSON.stringify({
      kind: 'ftdc-lens-dashboard',
      v: LAYOUT_VERSION,
      name: 'From a runbook',
      state: state('panel'),
    });
    expect(fromFile(exported)?.name).toBe('From a runbook');
  });
});
