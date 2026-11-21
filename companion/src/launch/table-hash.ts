/**
 * I11.4.11 (2026-11-21): the SHA-256 of a table file that nothing has hashed yet, for finding the host's identical
 * file on a joining PC. A `.vpx` that was only found in the tables folder has no hash (`known-tables.ts`), and neither
 * has an imported one whose file changed since it was read; `find-table.ts` could then never see that one of them is
 * the host's file, and a same-name copy won (Congo, 2026-11-20: a modified copy was opened, and both PCs showed 2D).
 *
 * Bounded by its caller: only the files whose title is the host's game are hashed, a few at most. The file is read in
 * chunks with a pause between them (`sha256File`), so a 300 MB table does not hold the app; one file at a time. The
 * result is kept by path, size and modification time (`<userData>/table-hashes.json`), so a file is read once.
 *
 * Nothing here takes a path from outside this PC: every path is one a manifest or a folder listing on this disk gave.
 */
import type { WitnessFs } from '../witness/fs.js';
import { sha256File } from '../witness/vpx-file.js';

export interface TableHasher {
  /** The file's SHA-256 (lower-case hex), or null when it cannot be read. */
  hashOf(vpxPath: string): Promise<string | null>;
}

export interface TableHasherOptions {
  fs: WitnessFs;
  /** The cache file: `{ v: 1, hashes: { "<path, lower-case>|<size>|<mtime ms>": "<sha256>" } }`. Absent: nothing is kept. */
  io?: { read(): string | null; write(text: string): void };
  /** Test seam: the hash itself. Default: `sha256File`. */
  hash?: (fs: WitnessFs, path: string) => Promise<string>;
}

const CACHE_MAX = 400;
const pathKey = (p: string): string => p.replace(/\//g, '\\').toLowerCase();

export function createTableHasher(o: TableHasherOptions): TableHasher {
  let hashes: Record<string, string> = {};
  try {
    const raw: unknown = JSON.parse(o.io?.read() ?? '{}');
    const h = typeof raw === 'object' && raw !== null ? (raw as { hashes?: unknown }).hashes : null;
    if (typeof h === 'object' && h !== null) {
      for (const [k, v] of Object.entries(h as Record<string, unknown>)) if (typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)) hashes[k] = v;
    }
  } catch {
    hashes = {};
  }
  const save = (): void => {
    const keys = Object.keys(hashes);
    // The oldest entries go first (insertion order): a file that is hashed again is simply read again.
    for (const old of keys.slice(0, Math.max(0, keys.length - CACHE_MAX))) delete hashes[old];
    try {
      o.io?.write(`${JSON.stringify({ v: 1, hashes }, null, 2)}\n`);
    } catch {
      /* the cache is a convenience */
    }
  };
  /** One file at a time: two 300 MB reads at once are what would be felt. */
  let chain: Promise<unknown> = Promise.resolve();
  return {
    hashOf(vpxPath) {
      const run = chain.then(async (): Promise<string | null> => {
        try {
          const st = await o.fs.stat(vpxPath);
          const key = `${pathKey(vpxPath)}|${st.size}|${Math.floor(st.mtimeMs)}`;
          const known = hashes[key];
          if (known) return known;
          const sha = (await (o.hash ?? sha256File)(o.fs, vpxPath)).toLowerCase();
          hashes[key] = sha;
          save();
          return sha;
        } catch {
          return null;
        }
      });
      chain = run.catch(() => undefined);
      return run;
    },
  };
}
