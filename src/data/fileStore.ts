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
  /**
   * Read a whole file back as a `Blob`, for the log path's lazy `slice`/`stream` reads.
   *
   * Deliberately a `Blob`, not a {@link ReadableFile}: the log viewer reads a window by
   * `blob.slice(from, to).stream()`, and an OPFS file handle's `getFile()` returns exactly that
   * -- so a restored log is byte-for-byte the same shape as the dropped `File` it replaces. Not
   * via `openReadable`, whose sync access handle is exclusive and would collide with concurrent
   * reads (see {@link readText}).
   */
  openBlob(path: string): Promise<Blob>;
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

/**
 * The origin ran out of room, and the write was silently truncated.
 *
 * Its own type because it is the one storage failure with a cause a user can act on, and
 * because the layers above have to be able to tell it apart from a bug in order to say so.
 * See {@link OpfsFileStore.createWritable} for how it is detected and why it is not a
 * `QuotaExceededError`.
 */
export class OutOfStorageError extends Error {
  override readonly name = 'OutOfStorageError';
  constructor(
    readonly path: string,
    /** Bytes the write asked for. */
    readonly asked: number,
    /** Bytes the filesystem actually took. */
    readonly wrote: number,
  ) {
    super(
      `out of browser storage writing ${path} -- asked to write ${asked} bytes, the ` +
        `filesystem took ${wrote}`,
    );
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
  /**
   * The directory name is deliberately still the project's old one.
   *
   * This string is a storage identity, not a brand. OPFS has no rename, so changing it would
   * not move the captures already decoded on disk -- it would strand them: unreachable from the
   * UI, still counting against the origin's quota, and gigabytes each. That is precisely the
   * wreckage the ingest-failure cleanup exists to prevent, and creating it deliberately for a
   * name nobody sees would be a poor trade.
   */
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

  /**
   * Open a file for appending.
   *
   * **`write()` returning a short count is a failure, not a partial success.** When the origin
   * runs out of room, Firefox's `FileSystemSyncAccessHandle.write()` does not throw -- it
   * writes what fits, returns that smaller number, and lets the next call write zero bytes,
   * still without throwing. Ignoring the return value therefore turns "out of storage" into
   * silent data loss that reports itself as success: a nine-node bundle decoded, three nodes
   * quietly stopped receiving column data, their `manifest.json` was written as zero bytes,
   * ingest posted `ingested`, and the very next read failed with `JSON.parse: unexpected end
   * of data at line 1 column 1` -- a message that names neither storage nor the node. That is
   * the reported failure, and it is why the byte count is checked on every append.
   *
   * The handle is closed on the way out of a failure. It has to be: OPFS refuses `removeEntry`
   * on a directory holding an open sync access handle (`NoModificationAllowedError`), so
   * leaking it would defeat the ingest-failure cleanup that exists to stop a half-written
   * capture from occupying the quota that the retry needs.
   */
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
    let open = true;
    const release = (): void => {
      if (!open) return;
      open = false;
      try {
        access.close();
      } catch {
        // Already failing; a close that also fails has nothing left to tell us.
      }
    };

    return {
      get size() {
        return size;
      },
      append(data: Uint8Array): Promise<number> {
        const at = size;
        let wrote: number;
        try {
          wrote = access.write(data, { at });
        } catch (err) {
          release();
          return Promise.reject(new FileStoreError('append', path, err));
        }
        if (wrote !== data.byteLength) {
          release();
          return Promise.reject(new OutOfStorageError(path, data.byteLength, wrote));
        }
        size += wrote;
        return Promise.resolve(at);
      },
      async close(): Promise<void> {
        if (!open) return;
        try {
          // flush() is where a buffered short write would surface, so it is inside the guard
          // and the handle is released either way.
          access.flush();
        } catch (err) {
          release();
          throw new FileStoreError('close', path, err);
        }
        release();
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

  async openBlob(path: string): Promise<Blob> {
    try {
      const { dir, name } = await this.resolve(path, false);
      const handle = await dir.getFileHandle(name);
      // getFile() is a plain, non-exclusive read (like readText), and the File it returns is a
      // Blob whose slice/stream read lazily from OPFS -- no bytes are pulled into memory here.
      return await handle.getFile();
    } catch (err) {
      throw new FileStoreError('openBlob', path, err);
    }
  }

  async writeText(path: string, text: string): Promise<void> {
    const w = await this.createWritable(path);
    await w.append(new TextEncoder().encode(text));
    await w.close();
  }

  /**
   * Read a whole small file as text.
   *
   * Deliberately NOT via openReadable: that takes a sync access handle, which OPFS makes
   * exclusive, so two concurrent readers of the same file collide and the loser throws
   * NoModificationAllowedError. Manifests are read concurrently -- listing captures, opening
   * one, ingesting another -- and a failure there presents as "this capture does not exist"
   * rather than as an error. getFile() is a plain read with no exclusivity.
   */
  async readText(path: string): Promise<string> {
    try {
      const { dir, name } = await this.resolve(path, false);
      const handle = await dir.getFileHandle(name);
      return await (await handle.getFile()).text();
    } catch (err) {
      throw new FileStoreError('readText', path, err);
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
