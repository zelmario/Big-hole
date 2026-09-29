/**
 * The landing page has to accept a log the way a person actually has one: a file, not a folder.
 *
 * The folder picker stays. This checks the second control hands the chosen files to ingest
 * with their names as paths, which is what groups several loose files into one log.
 *
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { act } from 'react';

import { DropZone } from '../src/ui/DropZone.js';
import { useStore } from '../src/store/useStore.js';

vi.mock('../src/workers/client.js', () => ({
  FtdcClient: class {
    captures = vi.fn(async () => []);
  },
}));

afterEach(cleanup);

async function renderZone(): Promise<void> {
  await act(async () => {
    render(<DropZone />);
  });
}

describe('choosing files', () => {
  it('keeps a folder picker and adds one for individual log files', async () => {
    useStore.setState({ status: 'empty', recent: [], error: null });
    await renderZone();

    expect(screen.getByRole('button', { name: 'Choose folder…' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Choose log files…' })).toBeTruthy();

    const inputs = document.querySelectorAll('input[type="file"]');
    expect(inputs).toHaveLength(2);
    expect(inputs[0]?.hasAttribute('webkitdirectory')).toBe(true);
    expect(inputs[1]?.hasAttribute('webkitdirectory')).toBe(false);
    expect(inputs[1]?.hasAttribute('multiple')).toBe(true);
  });

  it('ingests chosen log files by name, so several files are one log', async () => {
    const ingest = vi.fn(async (_sources: { file: File; path: string }[]) => {});
    useStore.setState({ status: 'empty', recent: [], error: null, ingest });
    await renderZone();

    const input = document.querySelectorAll('input[type="file"]')[1]!;
    const a = new File(['a'], 'queries.jsonl');
    const b = new File(['b'], 'queries-2.jsonl');
    fireEvent.change(input, { target: { files: [a, b] } });

    expect(ingest).toHaveBeenCalledTimes(1);
    const sources = ingest.mock.calls[0]![0];
    expect(sources.map((s) => s.path)).toEqual(['queries.jsonl', 'queries-2.jsonl']);
    expect(sources.map((s) => s.file)).toEqual([a, b]);
  });
});
