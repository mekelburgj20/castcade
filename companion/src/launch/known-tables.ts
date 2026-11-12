/**
 * A14 (2026-11-12): the tables Castcade already knows, for the Match tab's table picker and for finding the host's
 * table on a joining rig. A known table is one the import patched: it has a manifest under `<userData>/witness/tables`
 * (`patcher/manifest.ts`) and its `.vpx` is still where the manifest says. The TableInfo name comes from the witness's
 * identity cache when the witness has read that file (`table-identity.json`, read only here); "most recent first" is
 * the last time the witness saw the table open (`recent-tables.json`, written here), then the patch date.
 *
 * Nothing here takes a path from outside this PC: every path is one a manifest or a folder listing on this disk gave.
 */
import { readManifest } from '../patcher/index.js';
import type { WitnessFs } from '../witness/fs.js';
import { createIdentityStore } from '../witness/identity-store.js';

export interface KnownTable {
  /** The `.vpx` basename without its extension. */
  tableId: string;
  vpxPath: string;
  /** `TableInfo.tableName` when the witness has read this file, else null. */
  infoName: string | null;
  rom: string | null;
  /** SHA-256 of the `.vpx` as the import (or the witness) computed it, lower-case; null when never hashed. */
  sha256: string | null;
  /** True: the import patched it (a manifest). False: only a file found in the tables folder. */
  imported: boolean;
  /** ISO 8601: the last time the witness saw it open, null when never. */
  lastPlayedAt: string | null;
  /** ISO 8601: when the patch was rendered; null for a file that is not imported. */
  patchedAt: string | null;
}

function joinPath(dir: string, name: string): string {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return dir.replace(/[\\/]+$/, '') + sep + name;
}

const pathKey = (p: string): string => p.replace(/\//g, '\\').toLowerCase();

/** Most recent first: last played, then patched, then by name. */
export function sortKnownTables(tables: KnownTable[]): KnownTable[] {
  return [...tables].sort(
    (a, b) =>
      (b.lastPlayedAt ?? '').localeCompare(a.lastPlayedAt ?? '') || (b.patchedAt ?? '').localeCompare(a.patchedAt ?? '') || a.tableId.localeCompare(b.tableId, undefined, { sensitivity: 'base' }),
  );
}

export interface KnownTablesOptions {
  fs: WitnessFs;
  /** Where the import keeps its manifests (`manifestDirFor(dataDir)`). */
  manifestDir: string;
  /** The witness's data folder, for its identity cache; null skips the TableInfo names. */
  dataDir: string | null;
  /** `recent.played()`: path key → ISO time. */
  recent?: () => Record<string, string>;
}

/** The imported tables whose `.vpx` still exists, most recent first. A missing manifest folder is an empty list. */
export async function listKnownTables(o: KnownTablesOptions): Promise<KnownTable[]> {
  const { fs } = o;
  const names = await fs.readdir(o.manifestDir).catch(() => [] as string[]);
  const identity = o.dataDir ? createIdentityStore(fs, o.dataDir) : null;
  await identity?.load().catch(() => undefined);
  const played = o.recent?.() ?? {};
  const out: KnownTable[] = [];
  await Promise.all(
    names
      .filter((n) => /\.json$/i.test(n))
      .map(async (n) => {
        const m = await readManifest(fs, joinPath(o.manifestDir, n)).catch(() => null);
        if (!m || !/\.vpx$/i.test(m.vpxPath)) return;
        const st = await fs.stat(m.vpxPath).catch(() => null);
        if (!st) return;
        // The cache is keyed by path, size and mtime: a re-saved file has no facts until the witness reads it again.
        const facts = identity?.facts(identity.key(m.vpxPath, st.size, st.mtimeMs)) ?? null;
        const same = st.size === m.vpxSize && st.mtimeMs === m.vpxMtimeMs;
        const sha = facts?.sha256 ?? (same ? m.vpxSha256 : null);
        out.push({
          tableId: m.tableId,
          vpxPath: m.vpxPath,
          infoName: facts?.tableInfo.tableName?.trim() || null,
          rom: m.rom,
          sha256: sha ? sha.toLowerCase() : null,
          imported: true,
          lastPlayedAt: played[pathKey(m.vpxPath)] ?? null,
          patchedAt: m.renderedAt,
        });
      }),
  );
  return sortKnownTables(out);
}

/**
 * The `.vpx` files in a tables folder and one level of sub-folders (name only: nothing is opened), for a joining rig
 * whose copy of the host's table was never imported. `skip`: paths already known.
 */
export async function listTableFiles(fs: WitnessFs, tablesDir: string | null, skip: readonly KnownTable[] = []): Promise<KnownTable[]> {
  if (!tablesDir) return [];
  const have = new Set(skip.map((t) => pathKey(t.vpxPath)));
  const out: KnownTable[] = [];
  const take = (dir: string, name: string): void => {
    const vpxPath = joinPath(dir, name);
    if (have.has(pathKey(vpxPath))) return;
    out.push({ tableId: name.replace(/\.vpx$/i, ''), vpxPath, infoName: null, rom: null, sha256: null, imported: false, lastPlayedAt: null, patchedAt: null });
  };
  const top = await fs.readdir(tablesDir).catch(() => [] as string[]);
  const subs: string[] = [];
  for (const n of top) {
    if (/\.vpx$/i.test(n)) take(tablesDir, n);
    else if (!/\.[A-Za-z0-9]{1,8}$/.test(n)) subs.push(n);
  }
  await Promise.all(
    subs.slice(0, 200).map(async (s) => {
      const dir = joinPath(tablesDir, s);
      for (const n of await fs.readdir(dir).catch(() => [] as string[])) if (/\.vpx$/i.test(n)) take(dir, n);
    }),
  );
  return out.sort((a, b) => a.tableId.localeCompare(b.tableId, undefined, { sensitivity: 'base' }));
}

// ------------------------------------------------------------------------------- recent tables --

export interface RecentTables {
  played(): Record<string, string>;
  /** The witness saw this table file open now. Saved when the file changed since the last note. */
  note(vpxPath: string, at: string): void;
}

const RECENT_MAX = 300;

/** `<userData>/recent-tables.json`: `{ v: 1, played: { "<path, lower-case>": "<ISO time>" } }`. Never throws. */
export function createRecentTables(io: { read(): string | null; write(text: string): void }): RecentTables {
  let played: Record<string, string> = {};
  try {
    const raw: unknown = JSON.parse(io.read() ?? '{}');
    const p = typeof raw === 'object' && raw !== null ? (raw as { played?: unknown }).played : null;
    if (typeof p === 'object' && p !== null) {
      for (const [k, v] of Object.entries(p as Record<string, unknown>)) if (typeof v === 'string') played[k] = v;
    }
  } catch {
    played = {};
  }
  let last: string | null = null;
  return {
    played: () => ({ ...played }),
    note(vpxPath, at) {
      const k = pathKey(vpxPath);
      if (k === last) return;
      last = k;
      played[k] = at;
      const keys = Object.keys(played);
      if (keys.length > RECENT_MAX) {
        keys.sort((a, b) => (played[a] ?? '').localeCompare(played[b] ?? ''));
        for (const old of keys.slice(0, keys.length - RECENT_MAX)) delete played[old];
      }
      try {
        io.write(`${JSON.stringify({ v: 1, played }, null, 2)}\n`);
      } catch {
        /* the order is a convenience */
      }
    },
  };
}
