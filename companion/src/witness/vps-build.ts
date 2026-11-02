/**
 * Build the compact VPS index (`VpsIndexFile`) from the raw Virtual Pinball Spreadsheet database
 * (`db/vpsdb.json` of VirtualPinballSpreadsheet/vps-db). One implementation for both producers:
 * `scripts/fetch-vps.ts` writes the bundled `resources/vps/index.json` (and the `fixtures/vps`
 * subset) at package time; `vps-refresh.ts` rebuilds it inside the running app from vps-db `main`
 * (B24), so a table released after the pin is known the next day without a release.
 *
 * One entry per game that has a name, with its PinMAME ROM ids and its table files reduced to
 * id / authors / version / features / format / comment / updatedAt. Download URLs, images and the
 * rest of the sheet are dropped on purpose: the repo declares no licence, so we keep only the
 * identifiers and attribution the matcher needs.
 *
 * The database is untrusted data: every field is type-checked before it is copied; nothing from it
 * is executed or used as a path.
 */
import type { VpsGameEntry, VpsIndexFile, VpsTableEntry } from './identity-types.js';

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.trim() !== '').map((s) => s.trim()) : [];
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** One `tableFiles[]` record → `VpsTableEntry`, or null when it has no id. */
export function tableEntry(t: unknown): VpsTableEntry | null {
  if (!isRecord(t)) return null;
  const id = str(t['id']);
  if (!id) return null;
  return {
    id,
    authors: strList(t['authors']),
    version: str(t['version']),
    features: strList(t['features']),
    format: str(t['tableFormat']),
    comment: str(t['comment']),
    updatedAt: num(t['updatedAt']),
  };
}

/** One game record → `VpsGameEntry`, or null when it has no id or name. */
export function gameEntry(g: unknown): VpsGameEntry | null {
  if (!isRecord(g)) return null;
  const id = str(g['id']);
  const name = str(g['name']);
  if (!id || !name) return null;
  const roms: string[] = [];
  for (const r of Array.isArray(g['romFiles']) ? g['romFiles'] : []) {
    const rom = isRecord(r) ? str(r['version']) : null;
    if (rom && !roms.includes(rom.toLowerCase())) roms.push(rom.toLowerCase());
  }
  const tables = (Array.isArray(g['tableFiles']) ? g['tableFiles'] : []).map(tableEntry).filter((t): t is VpsTableEntry => t !== null);
  return {
    id,
    name,
    manufacturer: str(g['manufacturer']),
    year: num(g['year']),
    type: str(g['type']),
    roms,
    tables,
  };
}

export interface BuildIndexOptions {
  /** What the index records as its origin: the vps-db commit (bundled) or the content ETag (refreshed). */
  version: string;
  /** Keep only these game ids (the committed test fixture); `onMissing` hears each id the database lacks. */
  subset?: Set<string> | null;
  onMissing?: (id: string) => void;
  generatedAt?: string;
}

/** The whole database → `VpsIndexFile` (`games` in source order, optionally limited to `subset`). Throws when `db` is not an array. */
export function buildIndex(db: unknown, { version, subset = null, onMissing, generatedAt = new Date().toISOString() }: BuildIndexOptions): VpsIndexFile {
  if (!Array.isArray(db)) throw new Error('vpsdb.json: expected a top-level array of games');
  const games: VpsGameEntry[] = [];
  for (const raw of db) {
    const game = gameEntry(raw);
    if (!game) continue;
    if (subset && !subset.has(game.id)) continue;
    games.push(game);
  }
  if (subset && onMissing) {
    for (const id of subset) if (!games.some((g) => g.id === id)) onMissing(id);
  }
  return { version, generatedAt, games };
}

/** Table files across every game of an index (what the log and Status count). */
export function countTables(file: Pick<VpsIndexFile, 'games'>): number {
  return file.games.reduce((n, g) => n + g.tables.length, 0);
}
