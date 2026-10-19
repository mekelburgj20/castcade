/**
 * Loader for the compact VPS index (`resources/vps/index.json`, built by `scripts/fetch-vps.mjs`
 * from the Virtual Pinball Spreadsheet database) and the lookups `table-match.ts` needs: a game by
 * id, the games that list a PinMAME ROM, the games with a given name. Everything is read once,
 * lazily, through `WitnessFs` so tests run on the vendored subset in `fixtures/vps` or a `MemoryFs`;
 * a missing or unreadable index makes every lookup empty rather than failing, because identity
 * never blocks a post.
 */
import { isNotFound, nodeFs, type WitnessFs } from './fs.js';
import type { VpsGameEntry, VpsIndex, VpsIndexFile, VpsTableEntry } from './identity-types.js';
import { isObject, type Json } from './maps.js';

/**
 * Fold a game name for equality: lower-case, diacritics removed, parentheticals dropped (edition
 * and "(Manufacturer Year)" suffixes), `&` read as `and`, punctuation gone, one space between
 * words. `Sittin' Pretty` and `Tom & Jerry (Original 2024)` become `sittin pretty` / `tom and jerry`.
 */
export function normalizeVpsName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * The family of a PinMAME ROM id: the part before the first `_` when that is at least two
 * characters (`mm` of `mm_109c`, `tftc` of `tftc_400`), so an unlisted revision still finds the
 * game. Null for ids without an underscore (`rollstob`), which only match exactly.
 */
export function romFamily(rom: string): string | null {
  const i = rom.indexOf('_');
  return i >= 2 ? rom.slice(0, i).toLowerCase() : null;
}

/** Authors that are teams, not people: shown alone in a label where a person gets a co-author. */
const GROUP_AUTHORS = new Set(['vpw', 'vpinworkshop', 'vpin workshop', 'zen studios']);

/** The VPS feature tags worth a place in a short label, in display order. */
const NOTABLE_FEATURES = ['MOD', 'VR', 'FSS', 'SSF', 'nFozzy', 'Fleep', 'FizX', 'BAM', 'Hybrid', 'no ROM', 'Retheme'];

/**
 * A short human label for a table file, for the picker and Status:
 * `VPW 1.0 · MOD, VR, FSS`, `Arvid & Tom Tower 1.0.0 · VR`, `Hanibal 2.3 · MOD · Frank Eye and Flasher MODs`.
 * The comment is appended only when it is short and says something the label does not already.
 */
export function tableLabel(table: VpsTableEntry): string {
  const [first, second] = table.authors;
  let who: string;
  if (!first) who = 'unknown author';
  else if (second && !GROUP_AUTHORS.has(first.toLowerCase())) who = `${first} & ${second}`;
  else who = first;

  const parts = [table.version ? `${who} ${table.version}` : who];
  const features = NOTABLE_FEATURES.filter((f) => table.features.some((x) => x.toLowerCase() === f.toLowerCase())).slice(0, 3);
  if (features.length > 0) parts.push(features.join(', '));

  const comment = table.comment?.trim() ?? '';
  if (comment && comment.length <= 32) {
    const said = normalizeVpsName(parts.join(' ')).split(' ');
    const words = normalizeVpsName(comment).split(' ').filter(Boolean);
    if (words.some((w) => !said.includes(w))) parts.push(comment);
  }
  return parts.join(' · ');
}

interface LoadedIndex {
  version: string | null;
  byId: Map<string, VpsGameEntry>;
  byRom: Map<string, VpsGameEntry[]>;
  byFamily: Map<string, VpsGameEntry[]>;
  byName: Map<string, VpsGameEntry[]>;
}

const str = (v: Json | undefined): string | null => (typeof v === 'string' && v !== '' ? v : null);
const num = (v: Json | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const strList = (v: Json | undefined): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []);

/** Type-check one game record of the index file; the file is build output but still data. */
function parseGame(json: Json): VpsGameEntry | null {
  if (!isObject(json)) return null;
  const id = str(json['id']);
  const name = str(json['name']);
  if (!id || !name) return null;
  const tables: VpsTableEntry[] = [];
  for (const t of Array.isArray(json['tables']) ? json['tables'] : []) {
    if (!isObject(t)) continue;
    const tid = str(t['id']);
    if (!tid) continue;
    tables.push({
      id: tid,
      authors: strList(t['authors']),
      version: str(t['version']),
      features: strList(t['features']),
      format: str(t['format']),
      comment: str(t['comment']),
      updatedAt: num(t['updatedAt']),
    });
  }
  return {
    id,
    name,
    manufacturer: str(json['manufacturer']),
    year: num(json['year']),
    type: str(json['type']),
    roms: strList(json['roms']).map((r) => r.toLowerCase()),
    tables,
  };
}

function push<K>(map: Map<K, VpsGameEntry[]>, key: K, game: VpsGameEntry): void {
  const list = map.get(key);
  if (list) {
    if (!list.includes(game)) list.push(game);
  } else map.set(key, [game]);
}

/** Build the lookup tables from a parsed `VpsIndexFile` (exported for tests that assemble one in memory). */
export function indexGames(file: Pick<VpsIndexFile, 'games'> & Partial<VpsIndexFile>): LoadedIndex {
  const loaded: LoadedIndex = { version: file.version ?? null, byId: new Map(), byRom: new Map(), byFamily: new Map(), byName: new Map() };
  for (const game of file.games) {
    loaded.byId.set(game.id, game);
    for (const rom of game.roms) {
      push(loaded.byRom, rom, game);
      const family = romFamily(rom);
      if (family) push(loaded.byFamily, family, game);
    }
    push(loaded.byName, normalizeVpsName(game.name), game);
  }
  return loaded;
}

const byName = (a: VpsGameEntry, b: VpsGameEntry): number => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

/**
 * Loose manufacturer equality: either normalised name contains the other, so `Bally` meets
 * `Bally/Midway` and `Data East` meets `Data East USA`. False when either side is empty.
 */
export function sameManufacturer(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = normalizeVpsName(a ?? '');
  const y = normalizeVpsName(b ?? '');
  return x !== '' && y !== '' && (x.includes(y) || y.includes(x));
}

export function createVpsIndex(dir: string, fs: WitnessFs = nodeFs): VpsIndex {
  let loading: Promise<LoadedIndex> | null = null;
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  const path = dir.replace(/[\\/]+$/, '') + sep + 'index.json';

  const load = (): Promise<LoadedIndex> => {
    loading ??= (async () => {
      let json: Json;
      try {
        json = JSON.parse(new TextDecoder().decode(await fs.readFile(path))) as Json;
      } catch (err) {
        if (isNotFound(err)) return indexGames({ games: [] });
        throw err;
      }
      if (!isObject(json)) return indexGames({ games: [] });
      const games = (Array.isArray(json['games']) ? json['games'] : []).map(parseGame).filter((g): g is VpsGameEntry => g !== null);
      return indexGames({ version: str(json['version']) ?? undefined, games });
    })();
    return loading;
  };

  return {
    async version() {
      return (await load()).version;
    },
    async game(id) {
      return (await load()).byId.get(id) ?? null;
    },
    async gamesForRom(rom) {
      const idx = await load();
      const key = rom.trim().toLowerCase();
      if (!key) return [];
      const exact = idx.byRom.get(key);
      if (exact && exact.length > 0) return [...exact].sort(byName);
      const family = romFamily(key);
      const cousins = family ? idx.byFamily.get(family) : undefined;
      return cousins ? [...cousins].sort(byName) : [];
    },
    async gamesByName(name, hint) {
      const idx = await load();
      const key = normalizeVpsName(name);
      if (!key) return [];
      let hits = [...(idx.byName.get(key) ?? [])].sort(byName);
      // A hint only breaks a tie: narrowing that would leave nothing is ignored, so a wrong
      // manufacturer in a file name never hides the one game that has this name.
      if (hits.length > 1 && hint?.manufacturer) {
        const narrowed = hits.filter((g) => sameManufacturer(g.manufacturer, hint.manufacturer));
        if (narrowed.length > 0) hits = narrowed;
      }
      if (hits.length > 1 && hint?.year != null) {
        const narrowed = hits.filter((g) => g.year === hint.year);
        if (narrowed.length > 0) hits = narrowed;
      }
      return hits;
    },
  };
}
