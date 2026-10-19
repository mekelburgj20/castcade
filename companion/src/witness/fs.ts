/**
 * The small file-system surface the witness module needs (nvram snapshots, the maps corpus, the
 * offline queue), behind an interface so every test runs on an in-memory `MemoryFs` and never
 * touches a real VPinMAME directory. `nodeFs` is the production implementation.
 */
import { promises as fsp } from 'node:fs';

export interface FileStat {
  size: number;
  mtimeMs: number;
}

/**
 * Random access into one open file, for readers that must not load the file whole (a `.vpx` is
 * 100 MB to 1 GB and the companion is an always-on tray app). `size` is the length at open time.
 */
export interface RandomAccessFile {
  readonly size: number;
  /** Bytes `[offset, offset + length)`; exactly the bytes available, so shorter at end of file. */
  read(offset: number, length: number): Promise<Uint8Array>;
  close(): Promise<void>;
}

export interface WitnessFs {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
  /** Entry names (not paths) of a directory. */
  readdir(dir: string): Promise<string[]>;
  stat(path: string): Promise<FileStat>;
  /** Recursive; a directory that already exists is not an error. */
  mkdir(dir: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  /** Open for random-access reads; the caller must `close()` it. */
  open(path: string): Promise<RandomAccessFile>;
}

/** True for the "no such file or directory" error of either implementation. */
export function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT';
}

export function notFound(path: string): Error & { code: string } {
  const e = new Error(`ENOENT: no such file or directory, '${path}'`) as Error & { code: string };
  e.code = 'ENOENT';
  return e;
}

export const nodeFs: WitnessFs = {
  readFile: (p) => fsp.readFile(p),
  writeFile: (p, d) => fsp.writeFile(p, d),
  readdir: (d) => fsp.readdir(d),
  stat: async (p) => {
    const s = await fsp.stat(p);
    return { size: s.size, mtimeMs: s.mtimeMs };
  },
  mkdir: async (d) => {
    await fsp.mkdir(d, { recursive: true });
  },
  rename: (a, b) => fsp.rename(a, b),
  unlink: (p) => fsp.unlink(p),
  open: async (p) => {
    const handle = await fsp.open(p, 'r');
    const size = (await handle.stat()).size;
    return {
      size,
      async read(offset, length) {
        // One positioned read can return fewer bytes than asked for (not only at EOF), so loop
        // until the buffer is full or the file ends; callers rely on "short only at EOF".
        const buf = new Uint8Array(length);
        let got = 0;
        while (got < length) {
          const { bytesRead } = await handle.read(buf, got, length - got, offset + got);
          if (bytesRead === 0) break;
          got += bytesRead;
        }
        return got === length ? buf : buf.subarray(0, got);
      },
      close: () => handle.close(),
    };
  },
};

/** Normalise separators so Windows-style and POSIX-style paths address the same entry. */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

interface MemoryFile {
  data: Uint8Array;
  mtimeMs: number;
}

/**
 * In-memory file system for tests. Directories are implicit: a file exists at the path it was
 * written to and `readdir` lists the direct children of a prefix. `now` supplies the mtime of
 * writes so tests with a manual clock see deterministic timestamps.
 */
export class MemoryFs implements WitnessFs {
  private readonly files = new Map<string, MemoryFile>();
  private readonly dirs = new Set<string>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Place a file directly (test setup); `mtimeMs` defaults to `now()`. */
  put(path: string, data: Uint8Array | string, mtimeMs?: number): void {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
    this.files.set(normalizePath(path), { data: bytes, mtimeMs: mtimeMs ?? this.now() });
  }

  has(path: string): boolean {
    return this.files.has(normalizePath(path));
  }

  text(path: string): string | null {
    const f = this.files.get(normalizePath(path));
    return f ? new TextDecoder().decode(f.data) : null;
  }

  async readFile(path: string): Promise<Uint8Array> {
    const f = this.files.get(normalizePath(path));
    if (!f) throw notFound(path);
    return new Uint8Array(f.data);
  }

  async writeFile(path: string, data: Uint8Array | string): Promise<void> {
    this.put(path, data);
  }

  async readdir(dir: string): Promise<string[]> {
    const prefix = normalizePath(dir) + '/';
    const names = new Set<string>();
    for (const key of this.files.keys()) {
      if (key.startsWith(prefix)) {
        const rest = key.slice(prefix.length);
        const first = rest.split('/')[0];
        if (first) names.add(first);
      }
    }
    for (const d of this.dirs) {
      if (d.startsWith(prefix)) {
        const first = d.slice(prefix.length).split('/')[0];
        if (first) names.add(first);
      }
    }
    if (names.size === 0 && !this.dirs.has(normalizePath(dir))) throw notFound(dir);
    return [...names].sort();
  }

  async stat(path: string): Promise<FileStat> {
    const f = this.files.get(normalizePath(path));
    if (f) return { size: f.data.length, mtimeMs: f.mtimeMs };
    if (this.dirs.has(normalizePath(path))) return { size: 0, mtimeMs: 0 };
    throw notFound(path);
  }

  async mkdir(dir: string): Promise<void> {
    this.dirs.add(normalizePath(dir));
  }

  async rename(from: string, to: string): Promise<void> {
    const f = this.files.get(normalizePath(from));
    if (!f) throw notFound(from);
    this.files.delete(normalizePath(from));
    this.files.set(normalizePath(to), f);
  }

  async unlink(path: string): Promise<void> {
    if (!this.files.delete(normalizePath(path))) throw notFound(path);
  }

  async open(path: string): Promise<RandomAccessFile> {
    const f = this.files.get(normalizePath(path));
    if (!f) throw notFound(path);
    const data = f.data;
    return {
      size: data.length,
      async read(offset, length) {
        return data.slice(offset, Math.min(data.length, offset + length));
      },
      async close() {},
    };
  }
}
