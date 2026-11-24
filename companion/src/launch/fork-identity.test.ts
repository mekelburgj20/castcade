/**
 * I11.4.15: the table identity of the Castcade VPX build, computed from a `.vpx` (`fork-identity.ts`). Every table here
 * is built in the test (`witness/synth-vpx.test-support.ts`); no real table is read. The expected values of the first
 * test were computed by a second implementation (Python, straight from `CastcadeStream.cpp`'s `BuildObjectMap`: for
 * each object its type as u32, its name's length as u32 and the name as UTF-16LE, into a 64-bit FNV-1a), and the same
 * computation gave the value the build itself had logged for each of eight real tables on 2026-11-24.
 */
import { describe, expect, it } from 'vitest';
import { MemoryFs } from '../witness/fs.js';
import { ascii, buildVpx, codeRecord, concat, floatRecord, gameItem, intRecord, record, stringRecord, u32le, utf16, vec2Record } from '../witness/synth-vpx.test-support.js';
import type { VpxPlayfieldStreams } from '../witness/vpx-file.js';
import { forkIdentityOf, forkIdentityText, parseForkIdentity, parseForkIdentityText, readForkIdentity, sameForkIdentity } from './fork-identity.js';

const ENDB = record('ENDB', new Uint8Array(0));
/** An item's NAME record as VPX writes it (`BiffWriter::WriteWideString`): the length in bytes, then UTF-16LE. */
const nameRecord = (s: string): Uint8Array => record('NAME', concat(u32le(s.length * 2), utf16(s)));
/** `GameData` as VPX writes it: the item count (`SEDT`) among other records, the script, `ENDB`. */
const gameData = (items: number, script = "Sub Table1_Init\r\n ' SEDT inside the script is not the count\r\nEnd Sub\r\n"): Uint8Array =>
  concat(floatRecord('GAVT', 1.75), intRecord('SEDT', items), intRecord('SSND', 3), codeRecord(ascii(script)), floatRecord('SLOP', 6), ENDB);

const WALL = 0;
const FLIPPER = 1;
const TIMER = 2;
const TEXTBOX = 4;
const LIGHT = 7;
const DECAL = 9;
const PRIMITIVE = 19;

const item = (type: number, name: string | null, ...more: Uint8Array[]): Uint8Array => gameItem(type, floatRecord('HTTP', 50), ...(name === null ? [] : [nameRecord(name)]), ...more);
const streams = (items: Uint8Array[], count = items.length): VpxPlayfieldStreams => ({
  gameData: gameData(count),
  items: items.map((bytes, n) => ({ stream: `GameItem${n}`, type: new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true), body: bytes.subarray(4) })),
});
const text = (items: Uint8Array[], count?: number): string | null => {
  const id = forkIdentityOf(streams(items, count));
  return id ? forkIdentityText(id) : null;
};

describe('the table identity of the Castcade VPX build, from the file (I11.4.15)', () => {
  it('counts the game items and hashes each type and name as the build does; VPX adds a `playfield_mesh` primitive when the table has none', () => {
    // No object at all: the mesh VPX adds is the one object.
    expect(text([])).toBe('1 27b7aafed9d002b2');
    // A wall, a flipper, a decal (no script name: the empty name, whatever its record says), and the added mesh.
    expect(text([item(WALL, 'Wall1'), item(FLIPPER, 'LeftFlipper'), item(DECAL, 'Decal7')])).toBe('4 a64af20306c8c92c');
    // The table's own playfield mesh, in any case of letters: nothing is added.
    expect(text([item(WALL, 'Wall1'), item(PRIMITIVE, 'Playfield_Mesh'), item(LIGHT, 'L1')])).toBe('3 b80c38a797c6d680');
    // A name is cut at 31 UTF-16 units (the build's buffer holds 32 with the terminator).
    expect(text([item(TIMER, 'T'.repeat(40))])).toBe('2 dabcb04f24e281fb');
    expect(text([item(TIMER, 'T'.repeat(31))])).toBe('2 dabcb04f24e281fb');
  });

  it('only the types, the names and their order count: another position, script or shape leaves the identity alone; a renamed, added, removed or moved object changes it', () => {
    const base = [item(WALL, 'Wall1'), item(FLIPPER, 'LeftFlipper'), item(PRIMITIVE, 'playfield_mesh'), item(LIGHT, 'L1')];
    const id = text(base);
    expect(id).toMatch(/^4 [0-9a-f]{16}$/);
    // A re-save with other numbers in the items and another script: the same objects.
    const resaved: VpxPlayfieldStreams = {
      gameData: gameData(4, 'Option Explicit\r\n'),
      items: streams([
        gameItem(WALL, floatRecord('HTTP', 99), stringRecord('IMAG', 'another image'), nameRecord('Wall1')),
        gameItem(FLIPPER, nameRecord('LeftFlipper'), vec2Record('VCEN', 1, 2)),
        item(PRIMITIVE, 'playfield_mesh'),
        item(LIGHT, 'L1'),
      ]).items,
    };
    expect(forkIdentityText(forkIdentityOf(resaved)!)).toBe(id);
    // A mod: one object renamed, one more, one fewer, two swapped, one of another type under the same name.
    expect(text([item(WALL, 'Wall2'), base[1]!, base[2]!, base[3]!])).not.toBe(id);
    expect(text([...base, item(LIGHT, 'L2')])).not.toBe(id);
    expect(text(base.slice(0, 3))).not.toBe(id);
    expect(text([base[1]!, base[0]!, base[2]!, base[3]!])).not.toBe(id);
    expect(text([item(TIMER, 'Wall1'), base[1]!, base[2]!, base[3]!])).not.toBe(id);
    // The case of a name counts (the build hashes the letters as stored).
    expect(text([item(WALL, 'wall1'), base[1]!, base[2]!, base[3]!])).not.toBe(id);
  });

  it("reads an item's own NAME record: not a shape point's, not past the font a text box or a decal ends with, the last one when there are two, and up to a NUL", () => {
    const plain = text([item(WALL, 'Wall1'), item(TEXTBOX, 'Score'), item(PRIMITIVE, 'playfield_mesh')]);
    const point = concat(record('DPNT', new Uint8Array(0)), vec2Record('VCEN', 1, 2), nameRecord('NotTheWall'), ENDB);
    // A text box ends with its font outside any record: `[4][FONT]` and then bytes that are no record at all.
    const font = concat(u32le(4), ascii('FONT'), new Uint8Array([1, 0, 0, 0, 0x90, 0x01, 0x10, 0x27, 0, 0, 5]), ascii('Arial'));
    const tricky = [
      concat(u32le(WALL), nameRecord('Wall1'), record('PNTS', new Uint8Array(0)), point, point, ENDB),
      concat(u32le(TEXTBOX), nameRecord('Score'), font, ENDB),
      item(PRIMITIVE, 'playfield_mesh'),
    ];
    expect(text(tricky)).toBe(plain);
    expect(text([gameItem(WALL, nameRecord('Old'), nameRecord('Wall1')), tricky[1]!, tricky[2]!])).toBe(plain);
    const withNul = record('NAME', concat(u32le(14), utf16('Wall1\0zz')));
    expect(text([gameItem(WALL, withNul), tricky[1]!, tricky[2]!])).toBe(plain);
  });

  it("the count is GameData's SEDT: streams past it are not objects; what cannot be told from the file is null, never a guess", () => {
    const three = [item(WALL, 'Wall1'), item(PRIMITIVE, 'playfield_mesh'), item(LIGHT, 'L1')];
    expect(text([...three, item(LIGHT, 'Stale')], 3)).toBe(text(three));
    // A stream VPX would look for is not there.
    expect(text(three, 4)).toBeNull();
    // An item type VPX has no object for (13 is the table itself, 99 nothing).
    expect(text([item(13, 'Table1')])).toBeNull();
    expect(text([item(99, 'What')])).toBeNull();
    // A scriptable object with no name, or an empty one: VPX names it after a memory address.
    expect(text([item(WALL, null)])).toBeNull();
    expect(text([item(WALL, '')])).toBeNull();
    // Another kind of object under the playfield's name: VPX renames the mesh it adds.
    expect(text([item(WALL, 'playfield_mesh')])).toBeNull();
    // No GameData, or one without the count.
    expect(forkIdentityOf({ gameData: null, items: [] })).toBeNull();
    expect(forkIdentityOf({ gameData: concat(floatRecord('GAVT', 1), ENDB), items: [] })).toBeNull();
  });

  it('from a compound file on disk: the same value, the images never needed; a file that is no table, or is gone, is null', async () => {
    const fs = new MemoryFs();
    const items = [item(WALL, 'Wall1'), item(FLIPPER, 'LeftFlipper'), item(DECAL, 'Decal7')];
    fs.put('C:\\t\\a.vpx', buildVpx({ gameData: gameData(3), gameItems: items, fillerBytes: 200_000 }));
    expect(await readForkIdentity(fs, 'C:\\t\\a.vpx')).toEqual({ editables: 4, hash: 'a64af20306c8c92c' });
    // More than nine items: the streams are taken by their number, not by the order of their names.
    const many = Array.from({ length: 12 }, (_, i) => item(LIGHT, `L${i}`));
    fs.put('C:\\t\\b.vpx', buildVpx({ gameData: gameData(12), gameItems: many }));
    expect(await readForkIdentity(fs, 'C:\\t\\b.vpx')).toEqual(forkIdentityOf(streams(many)));
    fs.put('C:\\t\\c.vpx', 'not a compound file');
    expect(await readForkIdentity(fs, 'C:\\t\\c.vpx')).toBeNull();
    expect(await readForkIdentity(fs, 'C:\\t\\gone.vpx')).toBeNull();
    fs.put('C:\\t\\d.vpx', buildVpx({ gameStg: false }));
    expect(await readForkIdentity(fs, 'C:\\t\\d.vpx')).toBeNull();
  });

  it('an identity from outside (a cache file, a hello, the wire) is read strictly, compared without the case of its digits, and written as the logs write it', () => {
    expect(parseForkIdentity({ editables: 769, hash: 'FC87DDEFD36BDD13' })).toEqual({ editables: 769, hash: 'fc87ddefd36bdd13' });
    for (const bad of [null, 'x', {}, { editables: '769', hash: 'fc87ddefd36bdd13' }, { editables: 1.5, hash: 'fc87ddefd36bdd13' }, { editables: -1, hash: 'fc87ddefd36bdd13' }, { editables: 769, hash: 'fc87' }, { editables: 769, hash: 'zz87ddefd36bdd13' }]) {
      expect(parseForkIdentity(bad)).toBeNull();
    }
    expect(parseForkIdentityText('769 fc87ddefd36bdd13')).toEqual({ editables: 769, hash: 'fc87ddefd36bdd13' });
    for (const bad of [null, undefined, '', '769', '769  fc87ddefd36bdd13', 'x fc87ddefd36bdd13', '769 fc87ddefd36bdd13 1', '769 fc87']) expect(parseForkIdentityText(bad)).toBeNull();
    expect(forkIdentityText({ editables: 738, hash: '512b43b0598d481c' })).toBe('738 512b43b0598d481c');
    expect(sameForkIdentity({ editables: 738, hash: '512b43b0598d481c' }, { editables: 738, hash: '512B43B0598D481C' })).toBe(true);
    expect(sameForkIdentity({ editables: 738, hash: '512b43b0598d481c' }, { editables: 739, hash: '512b43b0598d481c' })).toBe(false);
    expect(sameForkIdentity({ editables: 766, hash: 'e4b9bf66f04cfcf9' }, { editables: 769, hash: 'fc87ddefd36bdd13' })).toBe(false);
  });
});
