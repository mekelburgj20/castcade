/**
 * I11.4.15 (2026-11-24): what this PC knows about the table objects of its table files: for each `.vpx`, the identity
 * the Castcade VPX build gives it (`fork-identity.ts`), kept by path, size and modification time as `table-hash.ts`
 * keeps the file hashes (`<userData>/table-objects.json`), so a file is read once.
 *
 * Two sources, the build's own word first:
 *
 * - `learn`: the Castcade VPX build said `hello` for a table Castcade started in it (the `hello` that names the stream
 *   port that start asked for, so it is that table's and no other's). Kept as `fork`; nothing computed replaces it,
 *   not even a computation of the same file that was under way when the build spoke.
 * - `objectsOf`: computed from the file (`computeForkIdentity`), kept as `file`. A file whose streams were read and
 *   that cannot be told from them is kept as unknown, so it is not read at every join; the build's word, when it
 *   comes, replaces that too. A file that could not be read at all (locked by an editor, a scanner or a sync client,
 *   a disk that did not answer) is kept as nothing: it is read again the next time it is asked for.
 *
 * What was computed is only as good as the computation that made it: the file carries the computation's version
 * (`FORK_IDENTITY_VERSION`), and a file written by another version keeps the build's own words and drops the rest.
 *
 * When the build's word differs from what was computed for the same file, the caller is told (`learn`'s answer, or
 * `onDisagree` when the computation finished after the build spoke) and logs it: that is how a table the computation
 * gets wrong would show, and from then on the build's word is used for that file.
 *
 * Bounded by its caller as the hashing is: only the copies of the host's title are read, a few at most, one file at a
 * time, and a read can be given up (`signal`). Nothing here takes a path from outside this PC.
 */
import type { WitnessFs } from '../witness/fs.js';
import { FORK_IDENTITY_VERSION, computeForkIdentity, forkIdentityText, parseForkIdentity, sameForkIdentity, type ForkIdentity } from './fork-identity.js';

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
  /**
   * The cache file: `{ v: 1, computation: <FORK_IDENTITY_VERSION>, tables: { "<path, lower-case>|<size>|<mtime ms>":
   * { editables, hash, from } | { unknown: true } } }`. Absent: nothing is kept.
   */
  io?: { read(): string | null; write(text: string): void };
  /**
   * Test seam: the computation. Default: `computeForkIdentity`. Null: the file was read and cannot be told (kept as
   * that); a throw: the file could not be read (nothing is kept).
   */
  compute?: (fs: WitnessFs, path: string) => Promise<ForkIdentity | null>;
  /** The version of the computation the cache is checked against (the tests'); default `FORK_IDENTITY_VERSION`. */
  computation?: number;
  /** A computation that finished after the build had spoken for the same file gave another identity: the build's word stands. */
  onDisagree?(vpxPath: string, said: ForkIdentity, computed: ForkIdentity): void;
}

type Entry = { id: ForkIdentity; from: 'fork' | 'file' } | { id: null };

/** The shape of the cache file; a file of another shape is not read at all. */
const CACHE_FORMAT = 1;
const CACHE_MAX = 400;
const pathKey = (p: string): string => p.replace(/\//g, '\\').toLowerCase();

export function createTableObjects(o: TableObjectsOptions): TableObjects {
  const computation = o.computation ?? FORK_IDENTITY_VERSION;
  let tables = new Map<string, Entry>();
  try {
    const raw: unknown = JSON.parse(o.io?.read() ?? '{}');
    const file = typeof raw === 'object' && raw !== null ? (raw as { v?: unknown; computation?: unknown; tables?: unknown }) : null;
    const t = file && file.v === CACHE_FORMAT ? file.tables : null;
    // What another version of the computation made of a file (a value, or "cannot be told") is not kept: it is
    // computed again when asked for. What the build itself said does not depend on the computation.
    const sameComputation = file?.computation === computation;
    if (typeof t === 'object' && t !== null) {
      for (const [k, v] of Object.entries(t as Record<string, unknown>)) {
        const id = parseForkIdentity(v);
        const fromFork = (v as { from?: unknown } | null)?.from === 'fork';
        if (id && (fromFork || sameComputation)) tables.set(k, { id, from: fromFork ? 'fork' : 'file' });
        else if (!id && sameComputation && typeof v === 'object' && v !== null && (v as { unknown?: unknown }).unknown === true) tables.set(k, { id: null });
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
      o.io?.write(`${JSON.stringify({ v: CACHE_FORMAT, computation, tables: out }, null, 2)}\n`);
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
          // A read that fails (the file is locked, the disk does not answer) throws: nothing is kept for the file.
          const id = await (o.compute ?? computeForkIdentity)(o.fs, vpxPath);
          // The build spoke for this file while it was being read: its word stands, whatever was computed.
          const now = tables.get(key);
          if (now?.id && now.from === 'fork') {
            if (id && !sameForkIdentity(id, now.id)) o.onDisagree?.(vpxPath, { ...now.id }, id);
            return { ...now.id };
          }
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
