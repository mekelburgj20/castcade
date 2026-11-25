/**
 * I11.4.15 (2026-11-24): the table identity of the Castcade VPX build, computed from the `.vpx` file before the table
 * is started. The fork says `hello 1 <build> <editables> <table hash> <stream port>` when a table has loaded, and a
 * watcher gets the 3D view only when both PCs name the same `<editables> <table hash>` (`match/stream3d.ts` `decide`).
 * The file's SHA-256 says less: on the match night of 2026-11-23 two tables of two had other bytes on the joining PC
 * and the same identity (3D ran), and a third copy with another identity won the pick and gave 2D.
 *
 * What the fork hashes (`CastcadeStream.cpp` `BuildObjectMap`, read 2026-11-24 at build 32c0746): the live table's
 * editables in their order, and for each one its item type (u32), the length of its name (u32, in UTF-16 units) and
 * the name's UTF-16LE bytes, into a 64-bit FNV-1a. The same from the file:
 *
 * - the editables are `GameStg/GameItem0` … `GameItem<n-1>`, n from `GameData`'s `SEDT` record; a stream starts with
 *   the item type, then BIFF records, among them the wide `NAME`;
 * - a name is cut at 31 units (the fork's buffer is 32) and at a NUL; a decal has no script name: the empty name;
 * - VPX adds one primitive, `playfield_mesh`, at the end when the table has no primitive of that name (`player.cpp`,
 *   before the stream session is made), so it is counted and hashed as the fork sees it. VPX renames that mesh
 *   (`playfield_mesh001`, …) when the name is taken by any other script name of the table: another kind of object,
 *   a collection, the table itself (`IEditable::SetName` → `PinTable::IsNameUnique`, which looks in the script
 *   editor's list, without regard to case). No table seen so far does that; such a file is "not to be told".
 *
 * Checked against the fork's own log on the owner's PC on 2026-11-24: the eight tables it had reported an identity
 * for all compute to the reported value (count and hash; three of them with the added mesh). A table this cannot
 * answer for yields null, never a guess: an item type VPX does not load, a stream that is missing or that the reader
 * leaves out (a game item over its 64 MB cap: one table of the 144 in that tables folder), a scriptable item with no
 * name (VPX then names it after a memory address), a table with no playfield mesh of its own where the name
 * `playfield_mesh` is taken by something that is not a primitive. What the fork itself reported for a file
 * (`table-objects.ts`) always comes before what is computed here.
 *
 * Only `GameData`, the `GameItem*` and the `Collection*` streams are read (`readVpxTableObjectStreams`), never the
 * images or sounds.
 */
import type { WitnessFs } from '../witness/fs.js';
import { readVpxTableObjectStreams, type VpxPlayfieldStreams } from '../witness/vpx-file.js';

/**
 * The version of this computation. **Bump it whenever anything in this file changes what `forkIdentityOf` answers for
 * some table** (a rule added or corrected, a later VPX build that hashes otherwise): what was computed before is kept
 * per file in `<userData>/table-objects.json` (`table-objects.ts`), and only a new number here makes those values,
 * and the "cannot be told" ones, be computed again. What the build itself reported is kept across versions.
 */
export const FORK_IDENTITY_VERSION = 1;

/** `hello`'s `<editables> <table hash>`: the count of table objects and the FNV-1a of their types and names (16 hex digits, lower-case). */
export interface ForkIdentity {
  editables: number;
  hash: string;
}

/** `769 fc87ddefd36bdd13`: as the fork's log and `companion.log` write an identity. */
export const forkIdentityText = (id: ForkIdentity): string => `${id.editables} ${id.hash}`;

export const sameForkIdentity = (a: ForkIdentity, b: ForkIdentity): boolean => a.editables === b.editables && a.hash.toLowerCase() === b.hash.toLowerCase();

/** A well-formed identity from outside (a cache file, the wire), or null. */
export function parseForkIdentity(x: unknown): ForkIdentity | null {
  if (typeof x !== 'object' || x === null) return null;
  const { editables, hash } = x as { editables?: unknown; hash?: unknown };
  if (typeof editables !== 'number' || !Number.isInteger(editables) || editables < 0 || editables > 0xffffffff) return null;
  if (typeof hash !== 'string' || !/^[0-9a-fA-F]{16}$/.test(hash)) return null;
  return { editables, hash: hash.toLowerCase() };
}

/** `769 fc87ddefd36bdd13` as a `hello` or the stream machine carries it, or null for anything else. */
export function parseForkIdentityText(text: string | null | undefined): ForkIdentity | null {
  const m = typeof text === 'string' ? /^(\d{1,10}) ([0-9a-fA-F]{16})$/.exec(text) : null;
  return m ? parseForkIdentity({ editables: Number(m[1]), hash: m[2] }) : null;
}

/** VPX `ItemTypeEnum`: the types a table file holds as game items. 9 is the decal, the one without a script name. */
const ITEM_TYPES = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 17, 18, 19, 20, 21, 22]);
const DECAL = 9;
const PRIMITIVE = 19;
/** The fork's name buffer holds 32 UTF-16 units, the last one the terminator. */
const NAME_UNITS_MAX = 31;
const PLAYFIELD_MESH = 'playfield_mesh';

const FNV_OFFSET = 14695981039346656037n;
const FNV_PRIME = 1099511628211n;
const MASK64 = (1n << 64n) - 1n;

const tagAt = (b: Uint8Array, pos: number): string => String.fromCharCode(b[pos]!, b[pos + 1]!, b[pos + 2]!, b[pos + 3]!);

/** A wide string record's text as VPX keeps a name: `[bytes:u32][UTF-16LE]`, cut at 31 units and at a NUL. */
function nameUnits(view: DataView, at: number, end: number): { start: number; units: number } {
  const bytes = Math.min(view.getUint32(at, true), end - (at + 4));
  let units = Math.min(Math.floor(bytes / 2), NAME_UNITS_MAX);
  for (let i = 0; i < units; i++) {
    if (view.getUint16(at + 4 + i * 2, true) === 0) units = i;
  }
  return { start: at + 4, units };
}

const utf16 = new TextDecoder('utf-16le');

/**
 * `GameData`'s `SEDT` record (how many game items the table has; null when the stream has none) and the table's own
 * script name (its `NAME` record, which follows the counts; null when there is none). Both come before the script.
 */
function tableRecords(gameData: Uint8Array): { count: number | null; name: string | null } {
  const view = new DataView(gameData.buffer, gameData.byteOffset, gameData.byteLength);
  let count: number | null = null;
  let name: string | null = null;
  let pos = 0;
  while (pos + 8 <= gameData.length) {
    const len = view.getUint32(pos, true);
    if (len < 4) break;
    const tag = tagAt(gameData, pos + 4);
    // The script (its record length covers the tag only, the text follows) comes after everything read here.
    if (tag === 'ENDB' || tag === 'CODE') break;
    const end = pos + 4 + len;
    if (end > gameData.length) break;
    if (tag === 'SEDT') count = len === 8 ? view.getInt32(pos + 8, true) : null;
    else if (tag === 'NAME' && len >= 8) {
      const n = nameUnits(view, pos + 8, end);
      name = utf16.decode(gameData.subarray(n.start, n.start + n.units * 2));
    }
    pos = end;
  }
  return { count, name };
}

/** A collection's script name: the `NAME` record of its stream (all of a collection's records are regular). Null: none. */
function collectionName(stream: Uint8Array): string | null {
  const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
  let name: string | null = null;
  let pos = 0;
  while (pos + 8 <= stream.length) {
    const len = view.getUint32(pos, true);
    if (len < 4) break;
    const tag = tagAt(stream, pos + 4);
    const end = pos + 4 + len;
    if (tag === 'ENDB' || end > stream.length) break;
    if (tag === 'NAME' && len >= 8) {
      const n = nameUnits(view, pos + 8, end);
      name = utf16.decode(stream.subarray(n.start, n.start + n.units * 2));
    }
    pos = end;
  }
  return name;
}

/**
 * The bytes of an item's name as the fork holds it: the last `NAME` record of the item's own records (a shape point's
 * records, `DPNT` … `ENDB`, are skipped), cut at 31 units and at a NUL. Null: the item has no `NAME` record.
 */
function itemNameBytes(body: Uint8Array): Uint8Array | null {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  let name: Uint8Array | null = null;
  let inPoint = false;
  let pos = 0;
  while (pos + 8 <= body.length) {
    const len = view.getUint32(pos, true);
    if (len < 4) break;
    const tag = tagAt(body, pos + 4);
    const end = pos + 4 + len;
    if (end > body.length) break;
    if (tag === 'ENDB') {
      if (!inPoint) break;
      inPoint = false;
    } else if (tag === 'DPNT') inPoint = true;
    else if (tag === 'FONT' && len === 4 && !inPoint) {
      // A decal's or a text box's font follows its tag outside the record's length, as the last thing of the item.
      break;
    } else if (tag === 'NAME' && !inPoint && len >= 8) {
      const n = nameUnits(view, pos + 8, end);
      name = body.subarray(n.start, n.start + n.units * 2);
    }
    pos = end;
  }
  return name;
}

/** What `forkIdentityOf` reads: the playfield streams, and the `Collection<n>` streams when the caller read them. */
export type TableObjectStreams = VpxPlayfieldStreams & { collections?: readonly Uint8Array[] };

/** The identity the Castcade VPX build will report for these streams, or null when it cannot be told from the file. Pure. */
export function forkIdentityOf(streams: TableObjectStreams): ForkIdentity | null {
  if (!streams.gameData) return null;
  const { count, name: tableName } = tableRecords(streams.gameData);
  if (count === null || count < 0) return null;
  const byIndex = new Map<number, (typeof streams.items)[number]>();
  for (const it of streams.items) {
    const m = /^GameItem(\d+)$/i.exec(it.stream);
    if (m) byIndex.set(Number(m[1]), it);
  }
  let h = FNV_OFFSET;
  const mix = (bytes: Uint8Array): void => {
    for (let i = 0; i < bytes.length; i++) h = ((h ^ BigInt(bytes[i]!)) * FNV_PRIME) & MASK64;
  };
  const u32 = new Uint8Array(4);
  const mixU32 = (n: number): void => {
    new DataView(u32.buffer).setUint32(0, n, true);
    mix(u32);
  };
  const mixItem = (type: number, name: Uint8Array): void => {
    mixU32(type);
    mixU32(name.length / 2);
    mix(name);
  };
  let hasPlayfieldMesh = false;
  /** The playfield's name on something that is not a primitive: VPX would rename the mesh it adds. */
  let nameTaken = false;
  for (let i = 0; i < count; i++) {
    const it = byIndex.get(i);
    if (!it || !ITEM_TYPES.has(it.type)) return null;
    let name = itemNameBytes(it.body);
    if (it.type === DECAL) name = new Uint8Array(0);
    // No name: VPX makes one up from the object's address, which no file can foretell.
    if (!name || name.length === 0) {
      if (it.type !== DECAL) return null;
      mixItem(it.type, new Uint8Array(0));
      continue;
    }
    if (utf16.decode(name).toLowerCase() === PLAYFIELD_MESH) {
      if (it.type === PRIMITIVE) hasPlayfieldMesh = true;
      else nameTaken = true;
    }
    mixItem(it.type, name);
  }
  let editables = count;
  if (!hasPlayfieldMesh) {
    // The mesh VPX adds is called `playfield_mesh` only while no other script name of the table is (it asks the
    // script editor's list: every scriptable object, every collection, the table itself, without regard to case);
    // otherwise it becomes `playfield_mesh001` or a later number, by what else is taken. Not worked out here: no
    // table seen so far does it, and a wrong value said with confidence is worse than none.
    const taken = (n: string | null): boolean => n !== null && n.toLowerCase() === PLAYFIELD_MESH;
    if (nameTaken || taken(tableName) || (streams.collections ?? []).some((c) => taken(collectionName(c)))) return null;
    mixItem(PRIMITIVE, new Uint8Array(Buffer.from(PLAYFIELD_MESH, 'utf16le')));
    editables++;
  }
  return { editables, hash: h.toString(16).padStart(16, '0') };
}

/**
 * Read a `.vpx` and compute the identity the fork will report for it; null: its streams were read and the identity is
 * not to be told from them. Throws when the file cannot be read (locked, gone, on a disk that does not answer) or is
 * no table: that is no answer about the file, and must not be kept as one (`table-objects.ts`).
 */
export async function computeForkIdentity(fs: WitnessFs, vpxPath: string): Promise<ForkIdentity | null> {
  return forkIdentityOf(await readVpxTableObjectStreams(fs, vpxPath));
}

/** `computeForkIdentity` for a caller that keeps nothing: null also for a file that cannot be read or is no table. */
export async function readForkIdentity(fs: WitnessFs, vpxPath: string): Promise<ForkIdentity | null> {
  try {
    return await computeForkIdentity(fs, vpxPath);
  } catch {
    return null;
  }
}
