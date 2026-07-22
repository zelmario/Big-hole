/**
 * Byte-level storage abstraction.
 *
 * Decoded FTDC does not fit in memory -- a 3-node replica-set week is ~36 GB at full
 * resolution against a ~1.5 GB tab budget (PLAN.md §2.3) -- so series are persisted and read
 * back on demand. In the browser that persistence is OPFS: real local disk, private to the
 * origin, and never a network surface, so the privacy promise holds exactly.
 *
 * The interface exists so the same store works under Node (tests, and any future server-side
 * ingest) and under Tauri, without the reader or writer knowing which. Keeping this seam
 * clean is what preserves the desktop option (PLAN.md §6.2).
 */

export interface WritableFile {
  /** Append bytes; resolves with the offset they were written at. */
  append(data: Uint8Array): Promise<number>;
  /** Total bytes written so far. */
  readonly size: number;
  close(): Promise<void>;
}

export interface ReadableFile {
  read(offset: number, length: number): Promise<Uint8Array>;
  readonly size: number;
  close(): Promise<void>;
}

export interface FileStore {
  createWritable(path: string): Promise<WritableFile>;
  openReadable(path: string): Promise<ReadableFile>;
  writeText(path: string, text: string): Promise<void>;
  readText(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
  /**
   * Remove a whole capture directory.
   *
   * **Must resolve, not throw, when the directory does not exist.** Callers use this to clear
   * a target before writing, so a fresh install would otherwise fail on first use. The two
   * backends disagree by default here: `fs.rm({force:true})` is silent, OPFS `removeEntry`
   * throws NotFoundError.
   */
  removeDir(path: string): Promise<void>;
  listDirs(): Promise<string[]>;
}

/**
 * Wrap a backend failure with the operation and path that caused it.
 *
 * Raw OPFS errors are close to useless in a bug report -- "A requested file or directory
 * could not be found at the time an operation was processed" names neither the file nor the
 * operation.
 */
export class FileStoreError extends Error {
  override readonly name = 'FileStoreError';
  constructor(op: string, path: string, cause: unknown) {
    const detail = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
    super(`${op}(${path}) failed -- ${detail}`);
    this.cause = cause;
  }
}

/** The slice of FileSystemSyncAccessHandle we use; not in every lib.dom yet. */
interface FileSystemSyncAccessHandleLike {
  read(buf: Uint8Array, opts: { at: number }): number;
  write(buf: Uint8Array, opts: { at: number }): number;
  truncate(size: number): void;
  getSize(): number;
  flush(): void;
  close(): void;
}

/* ------------------------------------------------------------------ OPFS ---- */

/**
 * Origin Private File System backend.
 *
 * `createSyncAccessHandle` is only available inside a Worker, which is where ingest belongs
 * anyway. It gives synchronous positioned reads and writes -- effectively pread/pwrite on a
 * local file -- which is what makes per-chunk random access cheap.
 */
export class OpfsFileStore implements FileStore {
  constructor(private readonly rootName = 'ftdc-lens') {}

  private async root(): Promise<FileSystemDirectoryHandle> {
    const base = await navigator.storage.getDirectory();
    return base.getDirectoryHandle(this.rootName, { create: true });
  }

  private async resolve(
    path: string,
    create: boolean,
  ): Promise<{ dir: FileSystemDirectoryHandle; name: string }> {
    const parts = path.split('/').filter(Boolean);
    const name = parts.pop();
    if (name === undefined) throw new Error(`fileStore: invalid path ${path}`);

    let dir = await this.root();
    for (const part of parts) dir = await dir.getDirectoryHandle(part, { create });
    return { dir, name };
  }

  async createWritable(path: string): Promise<WritableFile> {
    let access: FileSystemSyncAccessHandleLike;
    try {
      const { dir, name } = await this.resolve(path, true);
      const handle = await dir.getFileHandle(name, { create: true });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      access = await (handle as any).createSyncAccessHandle();
      access.truncate(0);
    } catch (err) {
      throw new FileStoreError('createWritable', path, err);
    }

    let size = 0;
    return {
      get size() {
        return size;
      },
      append(data: Uint8Array): Promise<number> {
        const at = size;
        access.write(data, { at });
        size += data.byteLength;
        return Promise.resolve(at);
      },
      async close(): Promise<void> {
        access.flush();
        access.close();
      },
    };
  }

  async openReadable(path: string): Promise<ReadableFile> {
    let access: FileSystemSyncAccessHandleLike;
    let size: number;
    try {
      const { dir, name } = await this.resolve(path, false);
      const handle = await dir.getFileHandle(name);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      access = await (handle as any).createSyncAccessHandle();
      size = access.getSize();
    } catch (err) {
      throw new FileStoreError('openReadable', path, err);
    }

    return {
      size,
      read(offset: number, length: number): Promise<Uint8Array> {
        const buf = new Uint8Array(length);
        access.read(buf, { at: offset });
        return Promise.resolve(buf);
      },
      async close(): Promise<void> {
        access.close();
      },
    };
  }

  async writeText(path: string, text: string): Promise<void> {
    const w = await this.createWritable(path);
    await w.append(new TextEncoder().encode(text));
    await w.close();
  }

  async readText(path: string): Promise<string> {
    const f = await this.openReadable(path);
    try {
      return new TextDecoder().decode(await f.read(0, f.size));
    } finally {
      await f.close();
    }
  }

  async exists(path: string): Promise<boolean> {
    try {
      const { dir, name } = await this.resolve(path, false);
      await dir.getFileHandle(name);
      return true;
    } catch {
      return false;
    }
  }

  async removeDir(path: string): Promise<void> {
    const root = await this.root();
    try {
      await root.removeEntry(path, { recursive: true });
    } catch (err) {
      // Removing something that was never there is not an error. OPFS disagrees and throws
      // NotFoundError, unlike fs.rm({force:true}) -- which made every first-ever ingest fail
      // on a fresh origin, since CaptureWriter clears the target directory before writing.
      if (err instanceof DOMException && err.name === 'NotFoundError') return;
      throw err;
    }
  }

  async listDirs(): Promise<string[]> {
    const root = await this.root();
    const out: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for await (const [name, handle] of (root as any).entries()) {
      if (handle.kind === 'directory') out.push(name);
    }
    return out;
  }
}
