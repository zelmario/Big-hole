/**
 * Node filesystem backend for the FileStore seam.
 *
 * Kept in its own module so the browser bundle never even references `node:fs`. Used by
 * tests and by tools/inspect.ts, and the path a future server-side ingest would take.
 */

import { OutOfStorageError, type FileStore, type ReadableFile, type WritableFile } from './fileStore.js';
export class NodeFileStore implements FileStore {
  constructor(private readonly root: string) {}

  private async fs() {
    return import('node:fs/promises');
  }

  private async full(path: string): Promise<string> {
    const { join } = await import('node:path');
    return join(this.root, path);
  }

  private async ensureDir(path: string): Promise<void> {
    const fs = await this.fs();
    const { dirname } = await import('node:path');
    await fs.mkdir(dirname(await this.full(path)), { recursive: true });
  }

  async createWritable(path: string): Promise<WritableFile> {
    await this.ensureDir(path);
    const fs = await this.fs();
    const handle = await fs.open(await this.full(path), 'w');

    let size = 0;
    return {
      get size() {
        return size;
      },
      async append(data: Uint8Array): Promise<number> {
        const at = size;
        // Checked for the same reason as the OPFS backend: a short write is a truncated
        // capture that reports itself as a successful one. ENOSPC does throw here, unlike in
        // OPFS, but a partial write is still permitted and must not pass for a whole one.
        const { bytesWritten } = await handle.write(data, 0, data.byteLength, at);
        if (bytesWritten !== data.byteLength) {
          await handle.close();
          throw new OutOfStorageError(path, data.byteLength, bytesWritten);
        }
        size += bytesWritten;
        return at;
      },
      async close(): Promise<void> {
        await handle.close();
      },
    };
  }

  async openReadable(path: string): Promise<ReadableFile> {
    const fs = await this.fs();
    const full = await this.full(path);
    const handle = await fs.open(full, 'r');
    const stat = await handle.stat();

    return {
      size: stat.size,
      async read(offset: number, length: number): Promise<Uint8Array> {
        const buf = new Uint8Array(length);
        await handle.read(buf, 0, length, offset);
        return buf;
      },
      async close(): Promise<void> {
        await handle.close();
      },
    };
  }

  async openBlob(path: string): Promise<Blob> {
    const fs = await this.fs();
    const buf = await fs.readFile(await this.full(path));
    // A whole-file read: the Node backend is for tests and tooling, where files are small and
    // there is no lazy-slice OPFS handle to mirror. Node's global Blob supports slice/stream.
    return new Blob([buf]);
  }

  async writeText(path: string, text: string): Promise<void> {
    await this.ensureDir(path);
    const fs = await this.fs();
    await fs.writeFile(await this.full(path), text, 'utf8');
  }

  async readText(path: string): Promise<string> {
    const fs = await this.fs();
    return fs.readFile(await this.full(path), 'utf8');
  }

  async exists(path: string): Promise<boolean> {
    const fs = await this.fs();
    try {
      await fs.access(await this.full(path));
      return true;
    } catch {
      return false;
    }
  }

  async removeDir(path: string): Promise<void> {
    const fs = await this.fs();
    await fs.rm(await this.full(path), { recursive: true, force: true });
  }

  async listDirs(): Promise<string[]> {
    const fs = await this.fs();
    try {
      const entries = await fs.readdir(this.root, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
  }
}
