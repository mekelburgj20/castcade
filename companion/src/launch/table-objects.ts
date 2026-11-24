/**
 * I11.4.15 (2026-11-24): what this PC knows about the table objects of its table files: for each `.vpx`, the identity
 * the Castcade VPX build gives it (`fork-identity.ts`), kept by path, size and modification time as `table-hash.ts`
 * keeps the file hashes (`<userData>/table-objects.json`), so a file is read once.
 *
 * Two sources, the build's own word first:
 *
 * - `learn`: the Castcade VPX build said `hello` for a table Castcade started in it (the `hello` that names the stream
 *   port that start asked for, so it is that table's and no other's). Kept as `fork`; nothing computed replaces it.
 * - `objectsOf`: computed from the file (`readForkIdentity`), kept as `file`. A file it cannot be told from is kept as
 *   unknown, so it is not read at every join; the build's word, when it comes, replaces that too.
 *
 * When the build's word differs from what was computed for the same file, `learn` says so (its caller logs it): that
 * is how a table the computation gets wrong would show, and from then on the build's word is used for that file.
 *
 * Bounded by its caller as the hashing is: only the copies of the host's title are read, a few at most, one file at a
 * time, and a read can be given up (`signal`). Nothing here takes a path from outside this PC.
 */
import type { WitnessFs } from '../witness/fs.js';
import { forkIdentityText, parseForkIdentity, readForkIdentity, sameForkIdentity, type ForkIdentity } from './fork-identity.js';

export interface TableObjects {
  /** The identity of this file's table objects, or null: the file cannot be read, cannot be told, or `signal` gave the read up. */
  objectsOf(vpxPath: string, signal?: AbortSignal): Promise<ForkIdentity | null>;
  /**
   * The Castcade VPX build reported `id` for this file. Answers what was kept for the file before when that was
   * computed and is another identity (`computed`), else null.
   */
  learn(vpxPath: string, id: ForkIdentity): Promise<{ computed: ForkIdentity } | null>;
}

export interface TableObjectsOptions {
  fs: WitnessFs;
  /** The cache file: `{ v: 1, tables: { "<path, lower-case>|<size>|<mtime ms>": { editables, hash, from } | { unknown: true } } }`. Absent: nothing is kept. */
  io?: { read(): string | null; write(text: string): void };
  /** Test seam: the computation. Default: `readForkIdentity`. */
  compute?: (fs: WitnessFs, path: string) => Promise<ForkIdentity | null>;
}

type Entry = { id: ForkIdentity; from: 'fork' | 'file' } | { id: null };

const CACHE_MAX = 400;
const pathKey = (p: string): string => p.replace(/\//g, '\\').toLowerCase();

export function createTableObjects(o: TableObjectsOptions): TableObjects {
  let tables = new Map<string, Entry>();
  try {
    const raw: unknown = JSON.parse(o.io?.read() ?? '{}');
    const t = typeof raw === 'object' && raw !== null ? (raw as { tables?: unknown }).tables : null;
    if (typeof t === 'object' && t !== null) {
      for (const [k, v] of Object.entries(t as Record<string, unknown>)) {
        const id = parseForkIdentity(v);
        if (id) tables.set(k, { id, from: (v as { from?: unknown }).from === 'fork' ? 'fork' : 'file' });
        else if (typeof v === 'object' && v !== null && (v as { unknown?: unknown }).unknown === true) tables.set(k, { id: null });
      }
    }
  } catch {
    tables = new Map();
  }
  const save = (): void => {
    // The oldest entries go first (insertion order): a file that is asked for again is simply read again.
    for (const old of [...tables.keys()].slice(0, Math.max(0, tables.size - CACHE_MAX))) tables.delete(old);
    const out: Record<string, unknown> = {};
    for (const [k, e] of tables) out[k] = e.id ? { editables: e.id.editables, hash: e.id.hash, from: e.from } : { unknown: true };
    try {
      o.io?.write(`${JSON.stringify({ v: 1, tables: out }, null, 2)}\n`);
    } catch {
      /* the cache is a convenience */
    }
  };
  const keyOf = async (vpxPath: string): Promise<string> => {
    const st = await o.fs.stat(vpxPath);
    return `${pathKey(vpxPath)}|${st.size}|${Math.floor(st.mtimeMs)}`;
  };
  /** One file at a time: a table's item streams are up to 200 MB, and two reads at once are what would be felt. */
  let chain: Promise<unknown> = Promise.resolve();
  return {
    objectsOf(vpxPath, signal) {
      const run = chain.then(async (): Promise<ForkIdentity | null> => {
        try {
          // Asked for behind another read and given up meanwhile: nothing is read at all.
          if (signal?.aborted) return null;
          const key = await keyOf(vpxPath);
          const known = tables.get(key);
          if (known) return known.id ? { ...known.id } : null;
          const id = await (o.compute ?? readForkIdentity)(o.fs, vpxPath);
          // Given up while it was read: the answer is not used, and a half-read file is not kept as unknown.
          if (signal?.aborted) return null;
          tables.set(key, id ? { id, from: 'file' } : { id: null });
          save();
          return id ? { ...id } : null;
        } catch {
          return null;
        }
      });
      chain = run.catch(() => undefined);
      return run;
    },
    async learn(vpxPath, id) {
      try {
        const said = parseForkIdentity(id);
        if (!said) return null;
        const key = await keyOf(vpxPath);
        const was = tables.get(key);
        if (was?.id && was.from === 'fork' && sameForkIdentity(was.id, said)) return null;
        // Moved to the end: the newest entry is the last to go.
        tables.delete(key);
        tables.set(key, { id: said, from: 'fork' });
        save();
        return was?.id && was.from === 'file' && !sameForkIdentity(was.id, said) ? { computed: { ...was.id } } : null;
      } catch {
        return null;
      }
    },
  };
}

/** `launch:` line for a file whose computed identity the build contradicted (I11.4.15): seen in the log, the build's word is used. */
export const objectsDisagreeLine = (table: string, said: ForkIdentity, computed: ForkIdentity): string =>
  `launch: the Castcade VPX build reports table ${forkIdentityText(said)} for ${table}; Castcade had computed ${forkIdentityText(computed)} from the file. The build's word is kept for this file`;
