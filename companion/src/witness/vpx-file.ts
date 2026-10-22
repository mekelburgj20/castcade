/**
 * Reader for Visual Pinball X `.vpx` files: what the file says about itself (the `TableInfo`
 * strings), the file version, the table's physics scalars and the script length, plus a streaming
 * SHA-256. Implements the ".vpx file" section of `identity-types.ts` (F1 of
 * `docs/design/fairness-and-table-identity.md`).
 *
 * A `.vpx` is an OLE2 / Compound File Binary ([MS-CFB]) and tables run from 100 MB to 1 GB, so this
 * is a minimal CFB reader that never loads the file whole: header, DIFAT (including the chained
 * DIFAT sectors a large file needs), FAT sectors on demand, directory entries on demand, the mini
 * stream for streams under the cutoff. Of the `GameStg` storage only `Version` and `GameData` are
 * read; the `GameItem*` / `Image*` / `Sound*` streams that make up the bulk are never touched. The
 * parsing of what comes out (`parseTableInfo`, `parseGameDataPhysics`) is pure and testable without
 * a compound file.
 */
import { createHash } from 'node:crypto';
import type { RandomAccessFile, WitnessFs } from './fs.js';
import type { VpxFileFacts, VpxTableInfo, VpxTablePhysics } from './identity-types.js';

// --------------------------------------------------------------------------------------- CFB --

const CFB_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const HEADER_BYTES = 512;
const DIR_ENTRY_BYTES = 128;
const DIFAT_IN_HEADER = 109;
const MINI_SECTOR_SHIFT = 6;

/** Sector numbers at or above this are markers (FREESECT, ENDOFCHAIN, FATSECT, DIFSECT), not sectors. */
const MAX_REGULAR_SECTOR = 0xfffffffa;
const ENDOFCHAIN = 0xfffffffe;
const NOSTREAM = 0xffffffff;

const STORAGE = 1;
const STREAM = 2;
const ROOT = 5;

/** TableInfo streams are tiny; anything larger is a binary (screenshot) and not worth decoding. */
const MAX_TABLE_INFO_STREAM_BYTES = 64 * 1024;
/** GameData is a few hundred KB; a stream claiming more is corrupt or not a table. */
const MAX_GAME_DATA_BYTES = 64 * 1024 * 1024;
/** Bound on the directory and sibling-tree walks so a corrupt file cannot spin us. */
const MAX_DIR_ENTRIES = 1 << 20;

export interface CfbEntry {
  id: number;
  name: string;
  type: number;
  left: number;
  right: number;
  child: number;
  startSector: number;
  size: number;
}

class NotVpxError extends Error {
  constructor(detail: string) {
    super(`not a .vpx: ${detail}`);
    this.name = 'NotVpxError';
  }
}

function u32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

/** [MS-CFB] 2.6.4: shorter names first, then an ordinal compare of the upper-cased UTF-16 code units. */
function compareEntryNames(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  const ua = a.toUpperCase();
  const ub = b.toUpperCase();
  for (let i = 0; i < ua.length; i++) {
    const d = ua.charCodeAt(i) - ub.charCodeAt(i);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Minimal compound-file reader over a `RandomAccessFile`. Everything is lazy and cached: FAT
 * sectors, directory sectors, the mini FAT and the mini stream's sector chain are read the first
 * time a lookup needs them, and only those parts.
 */
class CompoundFile {
  private readonly sectorSize: number;
  private readonly sectorShift: number;
  private readonly fatEntriesPerSector: number;
  private readonly dirEntriesPerSector: number;
  private readonly miniCutoff: number;
  private readonly firstDirSector: number;
  private readonly firstMiniFatSector: number;
  private readonly miniFatSectorCount: number;
  private readonly firstDifatSector: number;
  private readonly difatSectorCount: number;
  private readonly fatSectorCount: number;
  private readonly headerDifat: number[] = [];

  /** Sector numbers of the FAT sectors, in order (DIFAT contents), resolved once. */
  private difat: number[] | null = null;
  private readonly fatSectors = new Map<number, Uint32Array>();
  private dirChain: number[] | null = null;
  private readonly dirSectors = new Map<number, Uint8Array>();
  private readonly dirEntries = new Map<number, CfbEntry | null>();
  private miniFat: Uint32Array | null = null;
  private miniStreamChain: number[] | null = null;

  private constructor(
    private readonly file: RandomAccessFile,
    header: Uint8Array,
  ) {
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
    const major = view.getUint16(0x1a, true);
    this.sectorShift = view.getUint16(0x1e, true);
    if ((major !== 3 && major !== 4) || (this.sectorShift !== 9 && this.sectorShift !== 12)) {
      throw new NotVpxError(`unsupported compound file version ${major} / sector shift ${this.sectorShift}`);
    }
    if (view.getUint16(0x20, true) !== MINI_SECTOR_SHIFT) throw new NotVpxError('unexpected mini sector size');
    this.sectorSize = 1 << this.sectorShift;
    this.fatEntriesPerSector = this.sectorSize / 4;
    this.dirEntriesPerSector = this.sectorSize / DIR_ENTRY_BYTES;
    this.fatSectorCount = u32(view, 0x2c);
    this.firstDirSector = u32(view, 0x30);
    this.miniCutoff = u32(view, 0x38);
    this.firstMiniFatSector = u32(view, 0x3c);
    this.miniFatSectorCount = u32(view, 0x40);
    this.firstDifatSector = u32(view, 0x44);
    this.difatSectorCount = u32(view, 0x48);
    for (let i = 0; i < DIFAT_IN_HEADER; i++) {
      const s = u32(view, 0x4c + i * 4);
      if (s >= MAX_REGULAR_SECTOR) break;
      this.headerDifat.push(s);
    }
  }

  static async open(file: RandomAccessFile): Promise<CompoundFile> {
    const header = await file.read(0, HEADER_BYTES);
    if (header.length < HEADER_BYTES) throw new NotVpxError('file shorter than a compound file header');
    for (let i = 0; i < CFB_SIGNATURE.length; i++) {
      if (header[i] !== CFB_SIGNATURE[i]) throw new NotVpxError('not an OLE compound file');
    }
    return new CompoundFile(file, header);
  }

  private sectorOffset(sector: number): number {
    return (sector + 1) * this.sectorSize;
  }

  private async readSector(sector: number): Promise<Uint8Array> {
    const bytes = await this.file.read(this.sectorOffset(sector), this.sectorSize);
    if (bytes.length < this.sectorSize) throw new Error(`truncated .vpx: sector ${sector} past end of file`);
    return bytes;
  }

  /**
   * The DIFAT: header entries first, then the chained DIFAT sectors (each holds `entries - 1` FAT
   * sector numbers and, last, the next DIFAT sector). Required, not optional: with 512-byte sectors
   * the header's 109 entries cover only ~7 MB of file.
   */
  private async loadDifat(): Promise<number[]> {
    if (this.difat) return this.difat;
    const difat = [...this.headerDifat];
    const seen = new Set<number>();
    let sector = this.firstDifatSector;
    let count = 0;
    while (sector < MAX_REGULAR_SECTOR && count < this.difatSectorCount) {
      if (seen.has(sector)) throw new Error('corrupt .vpx: DIFAT chain loops');
      seen.add(sector);
      const bytes = await this.readSector(sector);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (let i = 0; i < this.fatEntriesPerSector - 1; i++) {
        const s = u32(view, i * 4);
        if (s >= MAX_REGULAR_SECTOR) continue;
        difat.push(s);
      }
      sector = u32(view, (this.fatEntriesPerSector - 1) * 4);
      count++;
    }
    // Trust the header's count of FAT sectors over trailing junk in the last DIFAT sector.
    this.difat = difat.slice(0, Math.max(this.fatSectorCount, 0));
    return this.difat;
  }

  /** The FAT entry for `sector`: the next sector in its chain, or a marker. */
  private async nextSector(sector: number): Promise<number> {
    const fatIndex = Math.floor(sector / this.fatEntriesPerSector);
    let fat = this.fatSectors.get(fatIndex);
    if (!fat) {
      const difat = await this.loadDifat();
      const fatSector = difat[fatIndex];
      if (fatSector === undefined) throw new Error(`corrupt .vpx: sector ${sector} beyond the FAT`);
      const bytes = await this.readSector(fatSector);
      fat = new Uint32Array(this.fatEntriesPerSector);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (let i = 0; i < fat.length; i++) fat[i] = u32(view, i * 4);
      this.fatSectors.set(fatIndex, fat);
    }
    return fat[sector % this.fatEntriesPerSector] ?? ENDOFCHAIN;
  }

  /** Follow a FAT chain from `start` for at most `maxSectors` sectors (or to ENDOFCHAIN), with a cycle guard. */
  private async chain(start: number, maxSectors: number): Promise<number[]> {
    const out: number[] = [];
    const seen = new Set<number>();
    let sector = start;
    while (sector < MAX_REGULAR_SECTOR && out.length < maxSectors) {
      if (seen.has(sector)) throw new Error('corrupt .vpx: sector chain loops');
      seen.add(sector);
      out.push(sector);
      sector = await this.nextSector(sector);
    }
    return out;
  }

  /** Read `size` bytes of a regular (FAT) stream, coalescing contiguous sectors into single reads. */
  private async readChain(start: number, size: number): Promise<Uint8Array> {
    const sectors = await this.chain(start, Math.ceil(size / this.sectorSize));
    if (sectors.length * this.sectorSize < size) throw new Error('truncated .vpx: stream chain shorter than its size');
    const out = new Uint8Array(size);
    let written = 0;
    let i = 0;
    while (i < sectors.length && written < size) {
      let run = 1;
      while (i + run < sectors.length && sectors[i + run] === sectors[i]! + run) run++;
      const want = Math.min(run * this.sectorSize, size - written);
      const bytes = await this.file.read(this.sectorOffset(sectors[i]!), want);
      if (bytes.length < want) throw new Error('truncated .vpx: stream past end of file');
      out.set(bytes, written);
      written += want;
      i += run;
    }
    return out;
  }

  private async loadDirChain(): Promise<number[]> {
    if (!this.dirChain) {
      // The directory's length is not in the v3 header; bound it by the file instead.
      const maxSectors = Math.ceil(this.file.size / this.sectorSize);
      this.dirChain = await this.chain(this.firstDirSector, maxSectors);
    }
    return this.dirChain;
  }

  /** Directory entry `id`, or null when it is out of range or unused. */
  async entry(id: number): Promise<CfbEntry | null> {
    const cached = this.dirEntries.get(id);
    if (cached !== undefined) return cached;
    const chain = await this.loadDirChain();
    const sectorIndex = Math.floor(id / this.dirEntriesPerSector);
    const sector = chain[sectorIndex];
    if (sector === undefined) {
      this.dirEntries.set(id, null);
      return null;
    }
    let bytes = this.dirSectors.get(sectorIndex);
    if (!bytes) {
      bytes = await this.readSector(sector);
      this.dirSectors.set(sectorIndex, bytes);
    }
    const off = (id % this.dirEntriesPerSector) * DIR_ENTRY_BYTES;
    const view = new DataView(bytes.buffer, bytes.byteOffset + off, DIR_ENTRY_BYTES);
    const type = view.getUint8(0x42);
    let entry: CfbEntry | null = null;
    if (type === STORAGE || type === STREAM || type === ROOT) {
      const nameBytes = Math.min(view.getUint16(0x40, true), 64);
      // The stored length counts the terminating NUL; drop it (and any stray trailing NULs).
      let name = decodeUtf16(bytes.subarray(off, off + Math.max(nameBytes, 0)));
      name = name.replace(/\0+$/, '');
      // Sizes are 64-bit in v4 files; a stream over 2^53 is not something we would read anyway.
      const size = u32(view, 0x78) + u32(view, 0x7c) * 2 ** 32;
      entry = {
        id,
        name,
        type,
        left: u32(view, 0x44),
        right: u32(view, 0x48),
        child: u32(view, 0x4c),
        startSector: u32(view, 0x74),
        size,
      };
    }
    this.dirEntries.set(id, entry);
    return entry;
  }

  async root(): Promise<CfbEntry> {
    const root = await this.entry(0);
    if (!root || root.type !== ROOT) throw new NotVpxError('compound file has no root entry');
    return root;
  }

  /**
   * Every entry directly inside `storage`: an in-order walk of its red-black sibling tree, with a
   * visited set and a size bound so a corrupt tree cannot loop.
   */
  async children(storage: CfbEntry): Promise<CfbEntry[]> {
    const out: CfbEntry[] = [];
    const seen = new Set<number>();
    const stack: number[] = [];
    let id = storage.child;
    while ((id !== NOSTREAM && id < MAX_DIR_ENTRIES) || stack.length > 0) {
      while (id !== NOSTREAM && id < MAX_DIR_ENTRIES) {
        if (seen.has(id) || seen.size > MAX_DIR_ENTRIES) throw new Error('corrupt .vpx: directory tree loops');
        seen.add(id);
        stack.push(id);
        id = (await this.entry(id))?.left ?? NOSTREAM;
      }
      const top = stack.pop();
      if (top === undefined) break;
      const e = await this.entry(top);
      if (e) {
        out.push(e);
        id = e.right;
      } else {
        id = NOSTREAM;
      }
    }
    return out;
  }

  /**
   * The child of `storage` named `name` (case-insensitive, as the format compares names). A binary
   * search down the sibling tree first, so a storage with thousands of entries (GameStg) costs a
   * handful of directory reads; a full walk as the fallback for a writer whose tree ordering is off.
   */
  async find(storage: CfbEntry, name: string): Promise<CfbEntry | null> {
    let id = storage.child;
    const seen = new Set<number>();
    while (id !== NOSTREAM && id < MAX_DIR_ENTRIES && !seen.has(id)) {
      seen.add(id);
      const e = await this.entry(id);
      if (!e) break;
      const c = compareEntryNames(name, e.name);
      if (c === 0) return e;
      id = c < 0 ? e.left : e.right;
    }
    for (const e of await this.children(storage)) {
      if (compareEntryNames(e.name, name) === 0) return e;
    }
    return null;
  }

  private async loadMiniFat(): Promise<Uint32Array> {
    if (this.miniFat) return this.miniFat;
    const sectors = await this.chain(this.firstMiniFatSector, this.miniFatSectorCount);
    const fat = new Uint32Array(sectors.length * this.fatEntriesPerSector);
    for (let i = 0; i < sectors.length; i++) {
      const bytes = await this.readSector(sectors[i]!);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (let j = 0; j < this.fatEntriesPerSector; j++) fat[i * this.fatEntriesPerSector + j] = u32(view, j * 4);
    }
    this.miniFat = fat;
    return fat;
  }

  private async loadMiniStreamChain(): Promise<number[]> {
    if (!this.miniStreamChain) {
      const root = await this.root();
      this.miniStreamChain = await this.chain(root.startSector, Math.ceil(root.size / this.sectorSize));
    }
    return this.miniStreamChain;
  }

  /** Read a stream that lives in the root entry's mini stream (64-byte mini sectors). */
  private async readMiniChain(start: number, size: number): Promise<Uint8Array> {
    const miniFat = await this.loadMiniFat();
    const miniStream = await this.loadMiniStreamChain();
    const miniSize = 1 << MINI_SECTOR_SHIFT;
    const perSector = this.sectorSize / miniSize;
    const out = new Uint8Array(size);
    const seen = new Set<number>();
    let written = 0;
    let mini = start;
    while (written < size) {
      if (mini >= MAX_REGULAR_SECTOR) throw new Error('truncated .vpx: mini stream chain shorter than its size');
      if (seen.has(mini)) throw new Error('corrupt .vpx: mini stream chain loops');
      seen.add(mini);
      const sector = miniStream[Math.floor(mini / perSector)];
      if (sector === undefined) throw new Error('corrupt .vpx: mini sector outside the mini stream');
      const offset = this.sectorOffset(sector) + (mini % perSector) * miniSize;
      const want = Math.min(miniSize, size - written);
      const bytes = await this.file.read(offset, want);
      if (bytes.length < want) throw new Error('truncated .vpx: mini stream past end of file');
      out.set(bytes, written);
      written += want;
      mini = miniFat[mini] ?? ENDOFCHAIN;
    }
    return out;
  }

  /** The whole content of a stream entry. Streams under the cutoff live in the mini stream. */
  async readStream(entry: CfbEntry): Promise<Uint8Array> {
    if (entry.type !== STREAM) throw new Error(`'${entry.name}' is not a stream`);
    if (entry.size === 0) return new Uint8Array(0);
    if (entry.size < this.miniCutoff) return this.readMiniChain(entry.startSector, entry.size);
    return this.readChain(entry.startSector, entry.size);
  }
}

// ----------------------------------------------------------------------------------- parsing --

const utf16 = new TextDecoder('utf-16le');

function decodeUtf16(bytes: Uint8Array): string {
  // An odd trailing byte cannot be a code unit; drop it rather than decode a replacement char.
  const even = bytes.length & 1 ? bytes.subarray(0, bytes.length - 1) : bytes;
  return utf16.decode(even);
}

function plainInteger(s: string | null): number | null {
  if (s === null) return null;
  return /^\s*[+-]?\d+\s*$/.test(s) ? parseInt(s, 10) : null;
}

function pick(raw: Record<string, string>, name: string): string | null {
  const key = Object.keys(raw).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? null : raw[key]!;
}

/**
 * Decode the `TableInfo` streams (UTF-16LE, no terminator) into the modelled fields. `streams` is
 * keyed by stream name; every decoded string is kept in `raw`, so the custom info tags a table
 * author added (`Manufacturer`, `Year`, anything else) stay available even when not modelled.
 */
export function parseTableInfo(streams: Record<string, Uint8Array>): VpxTableInfo {
  const raw: Record<string, string> = {};
  for (const [name, bytes] of Object.entries(streams)) {
    raw[name] = decodeUtf16(bytes).replace(/\0+$/, '');
  }
  return {
    tableName: pick(raw, 'TableName'),
    authorName: pick(raw, 'AuthorName'),
    tableVersion: pick(raw, 'TableVersion'),
    releaseDate: pick(raw, 'ReleaseDate'),
    saveDate: pick(raw, 'TableSaveDate'),
    saveRev: plainInteger(pick(raw, 'TableSaveRev')),
    manufacturer: pick(raw, 'Manufacturer'),
    year: plainInteger(pick(raw, 'Year')),
    raw,
  };
}

export const EMPTY_TABLE_INFO: Readonly<VpxTableInfo> = Object.freeze({
  tableName: null,
  authorName: null,
  tableVersion: null,
  releaseDate: null,
  saveDate: null,
  saveRev: null,
  manufacturer: null,
  year: null,
  raw: {},
});

type PhysicsFloatField = Exclude<keyof VpxTablePhysics, 'overridePhysicsFlippers'>;

const PHYSICS_TAGS: Record<string, PhysicsFloatField> = {
  GAVT: 'gravity',
  FRCT: 'friction',
  ELAS: 'elasticity',
  ELFA: 'elasticityFalloff',
  PFSC: 'playfieldScatter',
  SCAT: 'defaultScatter',
  NDGT: 'nudgeTime',
  SLOP: 'slopeMin',
  SLPX: 'slopeMax',
  TDFT: 'difficulty',
};

/**
 * Walk the BIFF records of `GameStg/GameData` (`[len:u32 LE][tag:4 ASCII][data:len-4]`) and pull out
 * the table-level physics floats and the script length. `CODE` is the one irregular record: its
 * header length covers only the tag, and the script follows as `[len:u32][bytes]`, so it is skipped
 * by that inner length. `ENDB` ends the record list. Malformed input yields nulls, never a throw.
 */
export function parseGameDataPhysics(bytes: Uint8Array): { physics: VpxTablePhysics; scriptBytes: number | null } {
  const physics: VpxTablePhysics = {
    gravity: null,
    friction: null,
    elasticity: null,
    elasticityFalloff: null,
    playfieldScatter: null,
    defaultScatter: null,
    nudgeTime: null,
    slopeMin: null,
    slopeMax: null,
    difficulty: null,
    overridePhysicsSet: null,
    overridePhysicsFlippers: null,
  };
  let scriptBytes: number | null = null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 0;
  while (pos + 8 <= bytes.length) {
    const len = view.getUint32(pos, true);
    if (len < 4) break;
    const tag = String.fromCharCode(bytes[pos + 4]!, bytes[pos + 5]!, bytes[pos + 6]!, bytes[pos + 7]!);
    const dataStart = pos + 8;
    const dataLen = len - 4;
    if (tag === 'ENDB') break;
    if (tag === 'CODE') {
      if (dataStart + 4 > bytes.length) break;
      const scriptLen = view.getUint32(dataStart, true);
      scriptBytes = scriptLen;
      pos = dataStart + 4 + scriptLen;
      continue;
    }
    if (dataStart + dataLen > bytes.length) break;
    const field = PHYSICS_TAGS[tag];
    if (field && dataLen === 4) physics[field] = view.getFloat32(dataStart, true);
    // Two int records beside the floats: the physics-set override (int) and its flipper flag (bool as int32).
    else if (tag === 'ORRP' && dataLen === 4) physics.overridePhysicsSet = view.getInt32(dataStart, true);
    else if (tag === 'ORPF' && dataLen === 4) physics.overridePhysicsFlippers = view.getInt32(dataStart, true) !== 0;
    pos = dataStart + dataLen;
  }
  return { physics, scriptBytes };
}

// ----------------------------------------------------------------------------------- reading --

/**
 * The table script: the bytes of the `CODE` record of `GameStg/GameData` (`[len:u32=4][CODE][scriptLen:u32][bytes]`),
 * as VPX stores them, which is the script's own code page (cp1252 in practice; never re-encode it). Null when the
 * stream has no `CODE` record or it is cut short.
 */
export function extractScript(gameData: Uint8Array): Uint8Array | null {
  const view = new DataView(gameData.buffer, gameData.byteOffset, gameData.byteLength);
  let pos = 0;
  while (pos + 8 <= gameData.length) {
    const len = view.getUint32(pos, true);
    if (len < 4) return null;
    const tag = String.fromCharCode(gameData[pos + 4]!, gameData[pos + 5]!, gameData[pos + 6]!, gameData[pos + 7]!);
    const dataStart = pos + 8;
    if (tag === 'ENDB') return null;
    if (tag === 'CODE') {
      if (dataStart + 4 > gameData.length) return null;
      const scriptLen = view.getUint32(dataStart, true);
      if (dataStart + 4 + scriptLen > gameData.length) return null;
      return gameData.slice(dataStart + 4, dataStart + 4 + scriptLen);
    }
    pos = dataStart + (len - 4);
  }
  return null;
}

export interface VpxScript {
  /** The script bytes exactly as stored (the table's code page, usually cp1252). */
  bytes: Uint8Array;
  /** Lower-case hex SHA-256 of `bytes`. */
  sha256: string;
  /** The `.vpx` file's size and mtime at read time (the cheap stamp a sidecar can re-check in VBScript). */
  size: number;
  mtimeMs: number;
}

/**
 * Read a table's script out of its `.vpx` without loading the file whole (the Phase 3 patcher's
 * first step: `vpxtool extractvbs` without vpxtool). Throws `not a .vpx: ...` for a non-compound
 * file; returns null for a compound file with no `GameStg/GameData` or no `CODE` record.
 */
export async function readVpxScript(fs: WitnessFs, path: string): Promise<VpxScript | null> {
  const st = await fs.stat(path);
  const file = await fs.open(path);
  try {
    const cfb = await CompoundFile.open(file);
    const gameStg = await cfb.find(await cfb.root(), 'GameStg');
    if (!gameStg || gameStg.type !== STORAGE) return null;
    const gameData = await cfb.find(gameStg, 'GameData');
    if (!gameData || gameData.type !== STREAM || gameData.size > MAX_GAME_DATA_BYTES) return null;
    const bytes = extractScript(await cfb.readStream(gameData));
    if (!bytes) return null;
    return { bytes, sha256: createHash('sha256').update(bytes).digest('hex'), size: st.size, mtimeMs: st.mtimeMs };
  } finally {
    await file.close();
  }
}

/**
 * Read what a `.vpx` says about itself without loading it whole. Throws `not a .vpx: ...` for a file
 * that is not a compound file; a table without a `TableInfo` storage (or without `GameStg`) yields
 * nulls for those parts rather than an error, because identity never blocks a post.
 */
export async function readVpxFacts(fs: WitnessFs, path: string): Promise<VpxFileFacts> {
  const st = await fs.stat(path);
  const file = await fs.open(path);
  try {
    const cfb = await CompoundFile.open(file);
    const root = await cfb.root();

    let tableInfo: VpxTableInfo = { ...EMPTY_TABLE_INFO, raw: {} };
    const infoStorage = await cfb.find(root, 'TableInfo');
    if (infoStorage && infoStorage.type === STORAGE) {
      const streams: Record<string, Uint8Array> = {};
      for (const e of await cfb.children(infoStorage)) {
        if (e.type !== STREAM) continue;
        // Screenshot is a binary image; so is anything else this large.
        if (e.name.toLowerCase() === 'screenshot' || e.size > MAX_TABLE_INFO_STREAM_BYTES) continue;
        streams[e.name] = await cfb.readStream(e);
      }
      tableInfo = parseTableInfo(streams);
    }

    let fileVersion: number | null = null;
    let physics: VpxTablePhysics | null = null;
    let scriptBytes: number | null = null;
    const gameStg = await cfb.find(root, 'GameStg');
    if (gameStg && gameStg.type === STORAGE) {
      const version = await cfb.find(gameStg, 'Version');
      if (version && version.type === STREAM && version.size >= 4) {
        const bytes = await cfb.readStream(version);
        fileVersion = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt32(0, true);
      }
      const gameData = await cfb.find(gameStg, 'GameData');
      if (gameData && gameData.type === STREAM && gameData.size <= MAX_GAME_DATA_BYTES) {
        const parsed = parseGameDataPhysics(await cfb.readStream(gameData));
        physics = parsed.physics;
        scriptBytes = parsed.scriptBytes;
      }
    }

    return { path, size: st.size, mtimeMs: st.mtimeMs, fileVersion, tableInfo, physics, scriptBytes };
  } finally {
    await file.close();
  }
}

export interface Sha256Options {
  /** Read size per step; 1 MiB by default. */
  chunkBytes?: number;
  signal?: AbortSignal;
}

export const DEFAULT_SHA256_CHUNK_BYTES = 1 << 20;

/** SHA-256 of a file as lower-case hex, streamed in chunks so a 1 GB table never sits in memory. */
export async function sha256File(fs: WitnessFs, path: string, opts: Sha256Options = {}): Promise<string> {
  const chunk = Math.max(1, opts.chunkBytes ?? DEFAULT_SHA256_CHUNK_BYTES);
  const file = await fs.open(path);
  try {
    const hash = createHash('sha256');
    let offset = 0;
    while (offset < file.size) {
      if (opts.signal?.aborted) throw opts.signal.reason instanceof Error ? opts.signal.reason : new Error('sha256File aborted');
      const bytes = await file.read(offset, Math.min(chunk, file.size - offset));
      if (bytes.length === 0) break;
      hash.update(bytes);
      offset += bytes.length;
    }
    return hash.digest('hex');
  } finally {
    await file.close();
  }
}
