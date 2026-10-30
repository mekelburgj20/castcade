/**
 * B14: the platform-wide list of games the desktop Witness can score on its own. Every game of the
 * VPS index that has a VPX table, each of its PinMAME ROMs looked up in the maps corpus by the
 * witness's own rule (`MapCorpus.mapFor`: the exact ROM, case-insensitive) and judged by
 * `liveSupport`, the same check Import and Status use (B12). Pure: the script
 * `scripts/witness-games.ts` loads the inputs and writes `docs/witness-games.json` (for ArcAid,
 * which seeds the Limited-attempts list from it, F13) and `docs/witness-games.md` (for directors).
 *
 * No ROM family fallback for the map: the witness has none (the family rule in `vps-index.ts` finds
 * a VPS game from a ROM, not a map). Measured 2026-10-30 on vps-db cce9160 × maps f0c4220: no game
 * whose listed ROMs all lack a map has a mapped cousin in an unambiguous family, so the list would
 * not change.
 */
import { isNotFound, nodeFs, type WitnessFs } from './fs.js';
import type { VpsGameEntry, VpsIndexFile } from './identity-types.js';
import { isObject, liveSupport, romFromNvName, type CompiledMap, type Json, type MapCorpus } from './maps.js';

export type SupportStatus = 'verified' | 'supported' | 'unsupported';

/** Reason for a game VPS lists no ROM for: an original or EM, scored only by a table-script recipe. */
export const NO_ROM_REASON = 'no ROM (original table: needs recipe B–E, C1.1)';
/** Reason for a ROM the corpus has no map for (`liveSupport(null)` words it for the app, not the list). */
export const NO_MAP_REASON = 'no map in pinmame-nvram-maps';
/** `counts.byPlatform` key for games with no mapped ROM. */
export const NO_PLATFORM = 'none';

export interface RomSupport {
  rom: string;
  /** The corpus map file the ROM resolves to (`maps/williams/wpc/mm_109.map.json`), or null when there is none. */
  map: string | null;
  platform: string | null;
  status: SupportStatus;
  /** Why the ROM is unsupported; null when it is supported or verified. */
  reason: string | null;
  /** Which live fields the map puts in NVRAM, where the hook can see them. */
  live: { scores: boolean; game_over: boolean; current_ball: boolean; current_player: boolean };
}

export interface GameSupport {
  vpsId: string;
  name: string;
  manufacturer: string | null;
  year: number | null;
  /** The best ROM's platform (the corpus platform file name, e.g. `williams-wpc-12K`); null with no map. */
  platform: string | null;
  status: SupportStatus;
  reason: string | null;
  roms: RomSupport[];
}

export interface StatusCounts {
  verified: number;
  supported: number;
  unsupported: number;
}

export interface SupportList {
  generatedAt: string;
  versions: { vps: string; maps: string; app: string };
  counts: StatusCounts & {
    games: number;
    /** Unsupported games by reason; sums to `unsupported`. */
    byReason: Record<string, number>;
    /** Games by their platform (`none` for no mapped ROM); each row sums to its games. */
    byPlatform: Record<string, StatusCounts>;
  };
  games: GameSupport[];
}

export interface SupportListInput {
  vps: Pick<VpsIndexFile, 'games'>;
  /** Synchronous view of `MapCorpus.mapFor`; `preloadMaps` builds one. */
  mapFor: (rom: string) => CompiledMap | null;
  /** The map file a ROM resolves to, for display only (the corpus `index.json` entry); null when unknown. */
  mapFile?: (rom: string) => string | null;
  /** ROMs with a recorded game that replays in CI (the folder names under `fixtures/nvram`). */
  verifiedRoms: Set<string>;
  versions: { vps: string; maps: string; app: string };
  generatedAt: string;
}

const RANK: Record<SupportStatus, number> = { verified: 2, supported: 1, unsupported: 0 };

/** Judge one ROM. */
export function romSupport(rom: string, map: CompiledMap | null, verifiedRoms: Set<string>, file: string | null = null): RomSupport {
  if (!map) {
    return { rom, map: null, platform: null, status: 'unsupported', reason: NO_MAP_REASON, live: { scores: false, game_over: false, current_ball: false, current_player: false } };
  }
  const support = liveSupport(map);
  const seen = (field: string): boolean => !support.absent.includes(field) && !support.outside.includes(field);
  const live = { scores: seen('scores'), game_over: seen('game_over'), current_ball: seen('current_ball'), current_player: seen('current_player') };
  const status: SupportStatus = !support.readable ? 'unsupported' : verifiedRoms.has(rom.toLowerCase()) ? 'verified' : 'supported';
  return { rom, map: file, platform: map.platform.name, status, reason: support.readable ? null : support.reason, live };
}

/**
 * The best ROM of a game: highest status, then (among unsupported) one with a map, whose reason
 * names the missing fields rather than just "no map", then the order VPS lists them.
 */
function bestRom(roms: RomSupport[]): RomSupport | null {
  let best: RomSupport | null = null;
  for (const r of roms) {
    if (!best || RANK[r.status] > RANK[best.status] || (RANK[r.status] === RANK[best.status] && r.map !== null && best.map === null)) best = r;
  }
  return best;
}

function gameSupport(game: VpsGameEntry, input: SupportListInput): GameSupport {
  const roms = [...new Set(game.roms)].map((rom) => {
    const map = input.mapFor(rom);
    return romSupport(rom, map, input.verifiedRoms, map ? (input.mapFile?.(rom) ?? null) : null);
  });
  const best = bestRom(roms);
  return {
    vpsId: game.id,
    name: game.name,
    manufacturer: game.manufacturer,
    year: game.year,
    platform: best?.platform ?? null,
    status: best?.status ?? 'unsupported',
    reason: best ? best.reason : NO_ROM_REASON,
    roms,
  };
}

/** Insert keys in sorted order so the JSON is byte-stable between runs. */
function sortedRecord<T>(entries: Map<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const key of [...entries.keys()].sort()) out[key] = entries.get(key) as T;
  return out;
}

/**
 * Build the list. Games without a VPX table (Pinball FX, Future Pinball only) are left out: the
 * list is about the desktop companion scoring VPX tables. Games sort by name, then VPS id.
 */
export function buildSupportList(input: SupportListInput): SupportList {
  const games = input.vps.games
    .filter((g) => g.tables.some((t) => t.format === 'VPX'))
    .map((g) => gameSupport(g, input))
    .sort((a, b) => a.name.localeCompare(b.name, 'en') || (a.vpsId < b.vpsId ? -1 : a.vpsId > b.vpsId ? 1 : 0));
  const totals: StatusCounts = { verified: 0, supported: 0, unsupported: 0 };
  const byReason = new Map<string, number>();
  const byPlatform = new Map<string, StatusCounts>();
  for (const g of games) {
    totals[g.status]++;
    if (g.status === 'unsupported' && g.reason) byReason.set(g.reason, (byReason.get(g.reason) ?? 0) + 1);
    const key = g.platform ?? NO_PLATFORM;
    const row = byPlatform.get(key) ?? { verified: 0, supported: 0, unsupported: 0 };
    row[g.status]++;
    byPlatform.set(key, row);
  }
  return {
    generatedAt: input.generatedAt,
    versions: input.versions,
    counts: { games: games.length, ...totals, byReason: sortedRecord(byReason), byPlatform: sortedRecord(byPlatform) },
    games,
  };
}

/**
 * Load every map the games name, through `corpus.mapFor`, so `buildSupportList` can stay synchronous,
 * and the corpus `index.json` for the map file names (looked up with the same key chain as `mapFor`).
 * A map that fails to load counts as none, as it does for Import and the witness (`.catch(() => null)`).
 */
export async function preloadMaps(
  corpus: MapCorpus,
  games: Pick<VpsGameEntry, 'roms'>[],
  fs: WitnessFs = nodeFs,
): Promise<{ mapFor: (rom: string) => CompiledMap | null; mapFile: (rom: string) => string | null }> {
  const maps = new Map<string, CompiledMap | null>();
  for (const game of games) {
    for (const rom of game.roms) {
      if (!maps.has(rom)) maps.set(rom, await corpus.mapFor(rom).catch(() => null));
    }
  }
  const sep = corpus.dir.includes('\\') && !corpus.dir.includes('/') ? '\\' : '/';
  let index: Json = null;
  try {
    index = JSON.parse(new TextDecoder().decode(await fs.readFile(corpus.dir.replace(/[\\/]+$/, '') + sep + 'index.json'))) as Json;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  const files = isObject(index) ? index : {};
  const fileOf = (key: string): string | null => {
    const v = files[key];
    if (typeof v === 'string') return v;
    if (isObject(v)) {
      const p = v['path'] ?? v['map'];
      return typeof p === 'string' ? p : null;
    }
    return null;
  };
  return {
    mapFor: (rom) => maps.get(rom) ?? null,
    mapFile: (rom) => {
      const nv = romFromNvName(rom);
      return fileOf(rom) ?? fileOf(rom.toLowerCase()) ?? fileOf(nv) ?? fileOf(nv.toLowerCase());
    },
  };
}
