/**
 * Interpreter for `pinmame-nvram-maps` map files: a TypeScript port of the read side of
 * `nvram_parser.py` (tomlogic/py-pinmame-nvmaps, the reference implementation), sufficient to
 * decode a ROM's `game_state` block (per-player scores, player count, current player and ball,
 * game-over flag), the deprecated `last_game` block, `high_scores` and `last_played`.
 *
 * Phase 0 proved on the owner's rig that `Controller.NVRAM` indexes equal on-disk `.nv` offsets
 * for WPC and Data East, so decoding a `.nv` file and decoding a journal-reconstructed buffer are
 * the same operation: both go through `decodeGameState(map, bytes)`.
 *
 * Pure functions over bytes; the corpus loader (`createMapCorpus`) is the only piece that reads
 * files, lazily, through `WitnessFs`.
 */
import { isNotFound, nodeFs, type WitnessFs } from './fs.js';

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export type Nibble = 'both' | 'low' | 'high';
export type Endian = 'big' | 'little';

export interface MemoryRegion {
  label: string | null;
  address: number;
  size: number;
  type: string;
  nibble: Nibble;
}

export interface Platform {
  name: string;
  endian: Endian;
  layout: MemoryRegion[];
}

export interface HighScoreDescriptor {
  label: string | null;
  shortLabel: string | null;
  score: JsonObject | null;
  initials: JsonObject | null;
}

/** One operator adjustment from a map's `adjustments` block: its group, label and raw descriptor. */
export interface AdjustmentDescriptor {
  group: string;
  label: string;
  entry: JsonObject;
}

export interface CompiledMap {
  /** ROMs this map claims to cover (`_metadata.roms`). */
  roms: string[];
  fileFormat: number | null;
  platform: Platform;
  /** `_metadata.char_map`, for `ch` fields that are not ASCII. */
  charMap: string | null;
  /** `_metadata.values`: shared enum value lists. */
  sharedValues: Record<string, Json[]>;
  /** `game_state` descriptors by key; `scores` is normally a list of four. */
  gameState: Record<string, JsonObject[]>;
  /** Deprecated `last_game` list of per-player score descriptors (fileformat < 0.6). */
  lastGame: JsonObject[];
  highScores: HighScoreDescriptor[];
  lastPlayed: JsonObject | null;
  /** Operator adjustments (F2), empty for the many maps without an `adjustments` block. */
  adjustments: AdjustmentDescriptor[];
}

export interface GameState {
  /** Per-player scores in map order (player 1 first); null where memory is not covered. */
  scores: (number | null)[];
  playerCount: number | null;
  currentPlayer: number | null;
  currentBall: number | null;
  gameOver: boolean | null;
  ballCount: number | null;
  extraBalls: number | null;
  credits: number | null;
  /** Every other numeric `game_state` field by its map key. */
  other: Record<string, number | null>;
}

export interface HighScore {
  label: string | null;
  shortLabel: string | null;
  initials: string | null;
  score: number | null;
}

// ---------------------------------------------------------------------------------------- json --

export function isObject(v: Json | undefined): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Python `int(v, 0)` for the map files: numbers pass through, strings may be decimal, `0x` hex,
 * `0o` octal or `0b` binary.
 */
export function toInt(v: Json | undefined, fallback?: number): number {
  if (typeof v === 'number') return Math.trunc(v);
  if (typeof v === 'string') {
    const s = v.trim();
    const n = /^[+-]?0[xob]/i.test(s) ? Number(s) : Number.parseInt(s, 10);
    if (Number.isFinite(n)) return n;
  }
  if (fallback !== undefined) return fallback;
  throw new Error(`map: expected an integer, got ${JSON.stringify(v)}`);
}

function parseNibble(v: Json | undefined): Nibble {
  if (v === undefined || v === null || v === 'both') return 'both';
  if (v === 'low' || v === 'high') return v;
  throw new Error(`map: invalid nibble ${JSON.stringify(v)}`);
}

function parseEndian(v: Json | undefined): Endian {
  return v === 'little' ? 'little' : 'big';
}

function str(v: Json | undefined): string | null {
  return typeof v === 'string' ? v : null;
}

// ------------------------------------------------------------------------------------ platform --

export function compilePlatform(name: string, json: Json): Platform {
  if (!isObject(json)) throw new Error(`platform ${name}: not an object`);
  const layoutJson = json['memory_layout'];
  const layout: MemoryRegion[] = [];
  if (Array.isArray(layoutJson)) {
    for (const region of layoutJson) {
      if (!isObject(region)) continue;
      layout.push({
        label: str(region['label']),
        address: toInt(region['address'], 0),
        size: toInt(region['size'], 0),
        type: str(region['type']) ?? 'ram',
        nibble: parseNibble(region['nibble']),
      });
    }
  }
  return { name, endian: parseEndian(json['endian']), layout };
}

/** The platform the Python parser synthesises for a map without `_metadata.platform`. */
function syntheticPlatform(metadata: JsonObject): Platform {
  return {
    name: 'auto-generated',
    endian: parseEndian(metadata['endian']),
    layout: [
      {
        label: 'undefined',
        address: 0,
        size: toInt(metadata['ramsize'], 0xffff),
        type: 'nvram',
        nibble: parseNibble(metadata['nibble']),
      },
    ],
  };
}

// ----------------------------------------------------------------------------------------- map --

function asList(v: Json | undefined): JsonObject[] {
  if (Array.isArray(v)) return v.filter(isObject);
  return isObject(v) ? [v] : [];
}

/**
 * Flatten a map's `adjustments` block: `{ "A.1 Standard Adjustments": { "01": {label, …}, … }, … }`
 * (groups and entries may also be lists). Entries without a label are skipped; `_`-keys are notes.
 */
export function flattenAdjustments(adjustments: Json | undefined): AdjustmentDescriptor[] {
  if (!isObject(adjustments)) return [];
  const out: AdjustmentDescriptor[] = [];
  for (const [group, entries] of Object.entries(adjustments)) {
    if (group.startsWith('_')) continue;
    const list: JsonObject[] = Array.isArray(entries)
      ? entries.filter(isObject)
      : isObject(entries)
        ? Object.entries(entries)
            .filter(([k]) => !k.startsWith('_'))
            .map(([, v]) => v)
            .filter(isObject)
        : [];
    for (const entry of list) {
      const label = entry['label'];
      if (typeof label !== 'string' || !label) continue;
      out.push({ group, label, entry });
    }
  }
  return out;
}

/**
 * Compile a map file. `loadPlatform` resolves `_metadata.platform` to the platform JSON (null
 * when the corpus does not have it, in which case the synthetic single-region platform is used).
 */
export function compileMap(mapJson: Json, loadPlatform: (name: string) => Json | null): CompiledMap {
  if (!isObject(mapJson)) throw new Error('map: not an object');
  const metadata = mapJson['_metadata'];
  if (!isObject(metadata)) throw new Error('map: unsupported file format, needs _metadata (v0.6+)');

  const platformName = str(metadata['platform']);
  let platform: Platform;
  if (platformName) {
    const pj = loadPlatform(platformName);
    platform = pj === null ? syntheticPlatform(metadata) : compilePlatform(platformName, pj);
  } else {
    platform = syntheticPlatform(metadata);
  }

  const sharedValues: Record<string, Json[]> = {};
  const values = metadata['values'];
  if (isObject(values)) {
    for (const [k, v] of Object.entries(values)) if (Array.isArray(v)) sharedValues[k] = v;
  }

  const gameState: Record<string, JsonObject[]> = {};
  const gs = mapJson['game_state'];
  if (isObject(gs)) {
    for (const [key, v] of Object.entries(gs)) {
      if (key.startsWith('_')) continue;
      gameState[key] = asList(v);
    }
  }

  const highScores: HighScoreDescriptor[] = asList(mapJson['high_scores']).map((e) => ({
    label: str(e['label']),
    shortLabel: str(e['short_label']),
    score: isObject(e['score']) ? e['score'] : null,
    initials: isObject(e['initials']) ? e['initials'] : null,
  }));

  const romsJson = metadata['roms'];
  const roms = Array.isArray(romsJson) ? romsJson.filter((r): r is string => typeof r === 'string') : [];
  const ff = mapJson['_fileformat'];

  return {
    roms,
    fileFormat: typeof ff === 'number' ? ff : null,
    platform,
    charMap: str(metadata['char_map']),
    sharedValues,
    gameState,
    lastGame: asList(mapJson['last_game']),
    highScores,
    lastPlayed: isObject(mapJson['last_played']) ? mapJson['last_played'] : null,
    adjustments: flattenAdjustments(mapJson['adjustments']),
  };
}

// -------------------------------------------------------------------------------------- memory --

/**
 * A `.nv` file placed at the platform's nvram region. Bytes past the region's size are PinMAME's
 * trailer (DIP switches and the like) and are not addressable; bytes outside the file read as
 * undefined, which makes every descriptor touching them decode to null, as in the reference.
 */
export class NvMemory {
  private readonly base: number;
  private readonly data: Uint8Array;

  constructor(platform: Platform, nv: Uint8Array) {
    const region = platform.layout.find((r) => r.type === 'nvram');
    this.base = region?.address ?? 0;
    const size = region && region.size > 0 ? Math.min(region.size, nv.length) : nv.length;
    this.data = nv.subarray(0, size);
  }

  byte(address: number): number | undefined {
    const i = address - this.base;
    return i >= 0 && i < this.data.length ? this.data[i] : undefined;
  }
}

// --------------------------------------------------------------------------------- descriptors --

export function descriptorOffsets(entry: JsonObject): number[] {
  const offsets = entry['offsets'];
  if (Array.isArray(offsets)) return offsets.map((o) => toInt(o));
  const start = toInt(entry['start'], 0);
  let end = start;
  if (entry['length'] !== undefined) {
    const length = toInt(entry['length']);
    if (length <= 0) throw new Error(`map: invalid length ${length}; must be > 0`);
    end = start + length - 1;
  } else if (entry['end'] !== undefined) {
    end = toInt(entry['end']);
    if (end < start) throw new Error(`map: end (${end}) is less than start (${start})`);
  }
  const out: number[] = [];
  for (let a = start; a <= end; a++) out.push(a);
  return out;
}

function descriptorNibble(entry: JsonObject, platform: Platform): Nibble {
  if (entry['packed'] === false) return 'low';
  const own = entry['nibble'];
  if (own !== undefined && own !== null) return parseNibble(own);
  const first = descriptorOffsets(entry)[0];
  if (first === undefined) return 'both';
  for (const region of platform.layout) {
    if (first >= region.address && first <= region.address + region.size - 1) return region.nibble;
  }
  return 'both';
}

function littleEndian(entry: JsonObject, platform: Platform): boolean {
  const endian = entry['endian'];
  return (typeof endian === 'string' ? endian : platform.endian) === 'little';
}

const INTEGER_ENCODINGS = new Set(['bcd', 'int', 'bits', 'bool', 'enum']);

/**
 * The raw bytes of a descriptor after the reference's normalisation: reversed for little-endian
 * integer encodings, nibbles combined into bytes, `mask` applied. Null when any byte is outside
 * the memory. (`dipsw` is not supported: DIP switches live in the trailer, not in game memory.)
 */
export function descriptorBytes(mem: NvMemory, entry: JsonObject, platform: Platform): number[] | null {
  const encoding = str(entry['encoding']);
  if (encoding === 'dipsw') return null;
  let ba: number[] = [];
  for (const offset of descriptorOffsets(entry)) {
    const b = mem.byte(offset);
    if (b === undefined) return null;
    ba.push(b);
  }
  if (encoding !== null && INTEGER_ENCODINGS.has(encoding) && encoding !== 'enum' && littleEndian(entry, platform)) {
    ba.reverse();
  }
  const nibble = descriptorNibble(entry, platform);
  if (nibble !== 'both') {
    const combined: number[] = [];
    let value = 0;
    while (ba.length > 0) {
      let b = ba.shift() as number;
      b = nibble === 'low' ? b & 0x0f : b >> 4;
      value = (value << 4) + b;
      if (ba.length % 2 === 0) {
        combined.push(value);
        value = 0;
      }
    }
    ba = combined;
  }
  if (entry['mask'] !== undefined) {
    const mask = toInt(entry['mask']);
    ba = ba.map((x) => x & mask);
  }
  return ba;
}

/** `bcd_nibble_to_int`: 0xA–0xF read as 0 (a blank digit on the display). */
function bcdByte(b: number): number {
  const hi = b >> 4;
  const lo = b & 0x0f;
  return (hi > 9 ? 0 : hi) * 10 + (lo > 9 ? 0 : lo);
}

/**
 * The value as stored (`bcd`, `int`, `bits`, `bool`, `enum`), before `scale`, `offset` and
 * `special_values`: the domain the map's `min`, `max` and `default` describe (corpus README,
 * "Encodings can include properties …"). Null for other encodings or bytes outside the memory.
 */
export function descriptorStoredValue(mem: NvMemory, entry: JsonObject, platform: Platform): number | null {
  const encoding = str(entry['encoding']);
  if (encoding === null || !INTEGER_ENCODINGS.has(encoding)) return null;
  const ba = descriptorBytes(mem, entry, platform);
  if (ba === null) return null;
  let value = 0;
  if (encoding === 'bcd') {
    for (const b of ba) value = value * 100 + bcdByte(b);
  } else {
    for (const b of ba) value = value * 256 + b;
  }
  return value;
}

/**
 * Numeric value of a descriptor (`bcd`, `int`, `bits`, `bool`, `enum`), with `scale`, `offset`,
 * bool normalisation/inversion and numeric `special_values` applied. Null for other encodings or
 * when the bytes are not in memory. `bool` yields 0 or 1.
 */
export function descriptorValue(mem: NvMemory, entry: JsonObject, platform: Platform): number | null {
  const encoding = str(entry['encoding']);
  if (encoding === null || !INTEGER_ENCODINGS.has(encoding)) return null;
  let value = descriptorStoredValue(mem, entry, platform);
  if (value === null) return null;
  const scale = entry['scale'];
  if (typeof scale === 'number') value *= scale;
  else if (typeof scale === 'string') value *= toInt(scale);
  value += toInt(entry['offset'], 0);
  if (encoding === 'bool') {
    const truthy = value !== 0;
    return (entry['invert'] === true ? !truthy : truthy) ? 1 : 0;
  }
  const special = entry['special_values'];
  if (isObject(special)) {
    const replacement = special[String(value)];
    if (typeof replacement === 'number') return replacement;
  }
  return value;
}

function isPrintable(ch: string): boolean {
  // Python str.isprintable(): nothing from the "Other" or "Separator" categories except ' '.
  return ch === ' ' || !/[\p{C}\p{Z}]/u.test(ch);
}

/**
 * A `ch` field as a string, honouring `char_map`, the `null` policy and `default` (which reads
 * as null, e.g. an unused high-score slot). Null when the bytes are not in memory.
 */
export function descriptorString(mem: NvMemory, entry: JsonObject, map: CompiledMap): string | null {
  const ba = descriptorBytes(mem, entry, map.platform);
  if (ba === null) return null;
  let result = '';
  const nullPolicy = str(entry['null']) ?? 'ignore';
  for (const b of ba) {
    let ch: string;
    if (map.charMap !== null) {
      ch = map.charMap[b] ?? '';
    } else if (b === 0 && nullPolicy !== 'ignore') {
      break;
    } else {
      ch = String.fromCharCode(b);
    }
    if (ch !== '' && isPrintable(ch)) result += ch;
  }
  const dflt = str(entry['default']) ?? '   ';
  return result === dflt ? null : result;
}

/** A `wpc_rtc` field as `YYYY-MM-DD HH:MM` (the reference's format), or null. */
export function descriptorRtc(mem: NvMemory, entry: JsonObject, platform: Platform): string | null {
  const ba = descriptorBytes(mem, entry, platform);
  if (ba === null || ba.length < 7) return null;
  const pad = (n: number, w: number) => String(n).padStart(w, '0');
  const year = (ba[0] as number) * 256 + (ba[1] as number);
  return `${pad(year, 4)}-${pad(ba[2] as number, 2)}-${pad(ba[3] as number, 2)} ${pad(ba[5] as number, 2)}:${pad(ba[6] as number, 2)}`;
}

/** The display string of an `enum` descriptor (`values[value]`), `?N` when out of range. */
export function descriptorEnum(mem: NvMemory, entry: JsonObject, map: CompiledMap): string | null {
  const value = descriptorValue(mem, entry, map.platform);
  if (value === null) return null;
  let values = entry['values'];
  if (typeof values === 'string') values = map.sharedValues[values] ?? [];
  if (!Array.isArray(values)) return `?${value}`;
  const v = values[value];
  return typeof v === 'string' ? v : `?${value}`;
}

// ---------------------------------------------------------------------------------- game state --

const KNOWN_GAME_STATE_KEYS = new Set([
  'scores',
  'player_count',
  'current_player',
  'current_ball',
  'game_over',
  'ball_count',
  'extra_balls',
  'credits',
]);

function firstValue(mem: NvMemory, entries: JsonObject[] | undefined, platform: Platform): number | null {
  const e = entries?.[0];
  return e ? descriptorValue(mem, e, platform) : null;
}

/** Decode the `game_state` block (falling back to `last_game` for the scores) from `.nv` bytes. */
export function decodeGameState(map: CompiledMap, nv: Uint8Array): GameState {
  const mem = new NvMemory(map.platform, nv);
  const gs = map.gameState;
  const scoreEntries = gs['scores'] && gs['scores'].length > 0 ? gs['scores'] : map.lastGame;
  const scores = scoreEntries.map((e) => descriptorValue(mem, e, map.platform));

  const gameOverRaw = firstValue(mem, gs['game_over'], map.platform);
  const other: Record<string, number | null> = {};
  for (const [key, entries] of Object.entries(gs)) {
    if (KNOWN_GAME_STATE_KEYS.has(key)) continue;
    other[key] = firstValue(mem, entries, map.platform);
  }
  return {
    scores,
    playerCount: firstValue(mem, gs['player_count'], map.platform),
    currentPlayer: firstValue(mem, gs['current_player'], map.platform),
    currentBall: firstValue(mem, gs['current_ball'], map.platform),
    gameOver: gameOverRaw === null ? null : gameOverRaw !== 0,
    ballCount: firstValue(mem, gs['ball_count'], map.platform),
    extraBalls: firstValue(mem, gs['extra_balls'], map.platform),
    credits: firstValue(mem, gs['credits'], map.platform),
    other,
  };
}

/** True when the map can tell us anything about a game (scores from `game_state` or `last_game`). */
export function hasScores(map: CompiledMap): boolean {
  return (map.gameState['scores']?.length ?? 0) > 0 || map.lastGame.length > 0;
}

export function decodeHighScores(map: CompiledMap, nv: Uint8Array): HighScore[] {
  const mem = new NvMemory(map.platform, nv);
  return map.highScores.map((h) => ({
    label: h.label,
    shortLabel: h.shortLabel,
    initials: h.initials ? descriptorString(mem, h.initials, map) : null,
    score: h.score ? descriptorValue(mem, h.score, map.platform) : null,
  }));
}

export function decodeLastPlayed(map: CompiledMap, nv: Uint8Array): string | null {
  if (!map.lastPlayed) return null;
  return descriptorRtc(new NvMemory(map.platform, nv), map.lastPlayed, map.platform);
}

/**
 * Two game states describe the same game when every score and the ball/player/game-over fields
 * agree. Used to tell "VPinMAME rewrote the `.nv` on exit" from "a new game was played".
 */
export function sameGame(a: GameState, b: GameState): boolean {
  if (a.scores.length !== b.scores.length) return false;
  for (let i = 0; i < a.scores.length; i++) if (a.scores[i] !== b.scores[i]) return false;
  return (
    a.currentBall === b.currentBall &&
    a.currentPlayer === b.currentPlayer &&
    a.gameOver === b.gameOver &&
    a.playerCount === b.playerCount
  );
}

// -------------------------------------------------------------------------------------- corpus --

export interface MapCorpus {
  readonly dir: string;
  /** The compiled map for a ROM, or null when the corpus has none. Cached after the first load. */
  mapFor(rom: string): Promise<CompiledMap | null>;
  /** Corpus identity: contents of `VERSION` or `.commit` in the corpus dir, else null. */
  version(): Promise<string | null>;
  /**
   * The ROM's descriptive name from `romnames.json` (`"mb_106b": "Monster Bash (1.06b)"`), with
   * the trailing version parenthetical removed → `Monster Bash`; null when unknown.
   */
  romName(rom: string): Promise<string | null>;
}

/** `Monster Bash (1.06b)` → `Monster Bash`; `Tales from the Crypt (4.00 unofficial MOD)` → `Tales from the Crypt`. */
export function stripRomVersion(name: string): string {
  return name.replace(/\s*\([^()]*\)\s*$/, '').trim() || name.trim();
}

/** `rom_for_nvpath`: a `.nv` basename minus the extension and any `-suffix`. */
export function romFromNvName(name: string): string {
  const base = name.replace(/\.nv$/i, '');
  const dash = base.indexOf('-');
  return dash >= 0 ? base.slice(0, dash) : base;
}

function joinPath(dir: string, rel: string): string {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return dir.replace(/[\\/]+$/, '') + sep + rel.replace(/\//g, sep);
}

export function createMapCorpus(dir: string, fs: WitnessFs = nodeFs): MapCorpus {
  let index: Promise<Record<string, string> | null> | null = null;
  let romnames: Promise<Record<string, string> | null> | null = null;
  const maps = new Map<string, Promise<CompiledMap | null>>();
  const platforms = new Map<string, Json | null>();
  const decoder = new TextDecoder();

  const readJson = async (path: string): Promise<Json | null> => {
    try {
      return JSON.parse(decoder.decode(await fs.readFile(path))) as Json;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  };

  const loadIndex = (): Promise<Record<string, string> | null> => {
    index ??= readJson(joinPath(dir, 'index.json')).then((json) => {
      if (!isObject(json)) return null;
      const out: Record<string, string> = {};
      for (const [rom, v] of Object.entries(json)) {
        if (rom.startsWith('_')) continue;
        if (typeof v === 'string') out[rom] = v;
        else if (isObject(v)) {
          const p = str(v['path']) ?? str(v['map']);
          if (p) out[rom] = p;
        }
      }
      return out;
    });
    return index;
  };

  const loadPlatforms = async (names: string[]): Promise<void> => {
    for (const name of names) {
      if (!platforms.has(name)) platforms.set(name, await readJson(joinPath(dir, `platforms/${name}.json`)));
    }
  };

  const loadMap = (rel: string): Promise<CompiledMap | null> => {
    let p = maps.get(rel);
    if (!p) {
      p = (async () => {
        const json = await readJson(joinPath(dir, rel));
        if (!isObject(json)) return null;
        const meta = json['_metadata'];
        const platformName = isObject(meta) ? str(meta['platform']) : null;
        if (platformName) await loadPlatforms([platformName]);
        return compileMap(json, (name) => platforms.get(name) ?? null);
      })();
      maps.set(rel, p);
    }
    return p;
  };

  return {
    dir,
    async mapFor(rom) {
      const idx = await loadIndex();
      if (!idx) return null;
      const rel = idx[rom] ?? idx[romFromNvName(rom)];
      return rel ? loadMap(rel) : null;
    },
    async romName(rom) {
      romnames ??= readJson(joinPath(dir, 'romnames.json')).then((json) => {
        if (!isObject(json)) return null;
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(json)) if (!k.startsWith('_') && typeof v === 'string') out[k] = v;
        return out;
      });
      const names = await romnames;
      const raw = names?.[rom] ?? names?.[romFromNvName(rom)];
      return raw ? stripRomVersion(raw) : null;
    },
    async version() {
      for (const name of ['VERSION', '.commit']) {
        try {
          const text = decoder.decode(await fs.readFile(joinPath(dir, name))).trim();
          if (text) return text;
        } catch (err) {
          if (!isNotFound(err)) throw err;
        }
      }
      return null;
    },
  };
}
