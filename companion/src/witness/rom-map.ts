/**
 * B8: the ROM → VPS game map ArcAid serves (`GET /api/witness/roms`, ArcAid 2.193.0, W12; contract in ArcAid
 * docs/vpx-desktop-witness-plan.md §4 "Wire contract: the ROM -> VPS game map"). It is built from the same VPS
 * `romFiles` the shipped seed (`resources/vps`) is, but is correctable without a Castcade release
 * (docs/design/fairness-and-table-identity.md §8: served by ArcAid with a shipped seed).
 *
 * The route is public catalogue data: no device token. `version` is a content hash and also the ETag, so the
 * companion keeps the last answer in `roms.json` and revalidates with `If-None-Match` (304 = unchanged).
 *
 * Precedence (`withServedRoms`): a served entry for the EXACT ROM naming one game wins; an `ambiguous` entry, or
 * no entry, falls through to the seed's own rule, including the family fallback (`mm_109x` → `mm`), which the
 * server deliberately does not have.
 */
import { buildUrl, DEFAULT_TIMEOUT_MS } from './arcaid-client.js';
import { isNotFound, type WitnessFs } from './fs.js';
import type { VpsGameEntry, VpsIndex } from './identity-types.js';

export const ROM_MAP_FILE = 'roms.json';
/** Re-fetched once a day after the fetch at start (B8); the server's own `max-age` is an hour. */
export const DEFAULT_ROM_MAP_REFRESH_MS = 24 * 60 * 60_000;

export interface RomMapGame {
  vpsGameId: string;
  /** ArcAid's catalogue id (a string on today's server). */
  globalGameId: number | string;
  name: string;
  manufacturer: string | null;
  year: number | null;
}

/** One game, or (a ROM VPS lists under several games: mods and originals reuse ROMs) never resolved to one. */
export type RomMapEntry = RomMapGame | { ambiguous: true; candidates: RomMapGame[] };

export interface RomMap {
  /** ArcAid's content hash of `roms`: changes exactly when the map does. */
  version: string;
  /** ROM keys held (after parsing; entries that do not type-check are dropped). */
  count: number;
  /** Keyed by ROM id, lowercased and trimmed. */
  roms: Record<string, RomMapEntry>;
}

/** What `roms.json` holds: the last good answer and its ETag. */
export interface CachedRomMap {
  fetchedAt: string;
  etag: string | null;
  map: RomMap;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);

function parseGame(v: unknown): RomMapGame | null {
  if (!isObj(v)) return null;
  const vpsGameId = text(v['vpsGameId']);
  const name = text(v['name']);
  const gid = v['globalGameId'];
  if (!vpsGameId || !name || !((typeof gid === 'string' && gid !== '') || (typeof gid === 'number' && Number.isFinite(gid)))) return null;
  const year = v['year'];
  return {
    vpsGameId,
    globalGameId: gid,
    name,
    manufacturer: text(v['manufacturer']),
    year: typeof year === 'number' && Number.isFinite(year) ? year : null,
  };
}

/**
 * Type-check the answer (or the cached copy). Null when the shape is wrong (not an object, no `version`, no `roms`
 * object); a single entry that does not type-check is dropped rather than discarding the whole map.
 */
export function parseRomMap(json: unknown): RomMap | null {
  if (!isObj(json)) return null;
  const version = text(json['version']);
  const raw = json['roms'];
  if (!version || !isObj(raw)) return null;
  const roms: Record<string, RomMapEntry> = {};
  for (const [k, v] of Object.entries(raw)) {
    const key = k.trim().toLowerCase();
    if (!key) continue;
    if (isObj(v) && v['ambiguous'] === true) {
      const candidates = (Array.isArray(v['candidates']) ? v['candidates'] : []).map(parseGame).filter((g): g is RomMapGame => g !== null);
      if (candidates.length > 0) roms[key] = { ambiguous: true, candidates };
      continue;
    }
    const game = parseGame(v);
    if (game) roms[key] = game;
  }
  return { version, count: Object.keys(roms).length, roms };
}

export interface RomMapStore {
  load(): Promise<CachedRomMap | null>;
  save(cached: CachedRomMap): Promise<void>;
}

function joinPath(dir: string, name: string): string {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return dir.replace(/[\\/]+$/, '') + sep + name;
}

/** `<dir>/roms.json`, rewritten whole through a temp file (as `identity-store.ts` does). */
export function createRomMapStore(fs: WitnessFs, dir: string): RomMapStore {
  const file = joinPath(dir, ROM_MAP_FILE);
  return {
    async load() {
      let raw: string;
      try {
        raw = new TextDecoder().decode(await fs.readFile(file));
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
      try {
        const parsed: unknown = JSON.parse(raw);
        if (!isObj(parsed)) return null;
        const map = parseRomMap(parsed['map']);
        if (!map) return null;
        return { fetchedAt: text(parsed['fetchedAt']) ?? '', etag: text(parsed['etag']), map };
      } catch {
        // A torn file: the next fetch replaces it, and the seed serves meanwhile.
        return null;
      }
    },
    async save(cached) {
      await fs.mkdir(dir);
      const tmp = file + '.tmp';
      await fs.writeFile(tmp, JSON.stringify(cached) + '\n');
      await fs.rename(tmp, file);
    },
  };
}

/** `FetchLike` with the response headers, which only this call needs (the ETag). */
export type RomMapFetch = (
  input: string,
  init: { method: 'GET'; headers: Record<string, string>; signal: AbortSignal },
) => Promise<{ status: number; text(): Promise<string>; headers?: { get(name: string): string | null } }>;

export type RomMapFetchResult = { kind: 'fresh'; map: RomMap; etag: string | null } | { kind: 'unchanged' } | { kind: 'failed'; error: string };

/** One revalidating GET of the served map. Never throws: a failure keeps whatever the caller holds. */
export async function fetchRomMap(fetchLike: RomMapFetch, baseUrl: string, etag: string | null, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<RomMapFetchResult> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (etag) headers['if-none-match'] = etag;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchLike(buildUrl(baseUrl, 'api/witness/roms', {}), { method: 'GET', headers, signal: controller.signal });
    if (res.status === 304) return { kind: 'unchanged' };
    if (res.status < 200 || res.status >= 300) return { kind: 'failed', error: `HTTP ${res.status}` };
    let json: unknown;
    try {
      json = JSON.parse(await res.text());
    } catch {
      return { kind: 'failed', error: 'not JSON' };
    }
    const map = parseRomMap(json);
    if (!map) return { kind: 'failed', error: 'malformed map' };
    // The ETag is `"<version>"` (W12); a response without readable headers still revalidates by it.
    return { kind: 'fresh', map, etag: res.headers?.get('etag') ?? `"${map.version}"` };
  } catch (err) {
    return { kind: 'failed', error: err instanceof Error && err.name === 'AbortError' ? `no answer within ${timeoutMs} ms` : err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The seed index with the served map in front of its ROM lookup. With no served map (`served()` null) every call is
 * the seed's own. A served one-game entry returns the seed's record of that game (its tables are what the table match
 * needs), with the ROM listed so the match reads it as exact; a game the seed does not know yet is built from the entry.
 */
export function withServedRoms(seed: VpsIndex, served: () => RomMap | null): VpsIndex {
  let byId: { map: RomMap; games: Map<string, RomMapGame & { rom: string }> } | null = null;
  const servedGame = (map: RomMap, id: string): (RomMapGame & { rom: string }) | null => {
    if (byId?.map !== map) {
      const games = new Map<string, RomMapGame & { rom: string }>();
      for (const [rom, e] of Object.entries(map.roms)) if (!('ambiguous' in e) && !games.has(e.vpsGameId)) games.set(e.vpsGameId, { ...e, rom });
      byId = { map, games };
    }
    return byId.games.get(id) ?? null;
  };
  const fromServed = (g: RomMapGame, rom: string): VpsGameEntry => ({ id: g.vpsGameId, name: g.name, manufacturer: g.manufacturer, year: g.year, type: null, roms: [rom], tables: [] });

  return {
    version: () => seed.version(),
    async game(id) {
      const hit = await seed.game(id);
      if (hit) return hit;
      const map = served();
      const g = map ? servedGame(map, id) : null;
      return g ? fromServed(g, g.rom) : null;
    },
    async gamesForRom(rom) {
      const key = rom.trim().toLowerCase();
      const entry = key ? served()?.roms[key] : undefined;
      if (entry && !('ambiguous' in entry)) {
        const known = await seed.game(entry.vpsGameId);
        if (!known) return [fromServed(entry, key)];
        return [known.roms.includes(key) ? known : { ...known, roms: [...known.roms, key] }];
      }
      return seed.gamesForRom(rom);
    },
    gamesByName: (name, hint) => seed.gamesByName(name, hint),
  };
}
