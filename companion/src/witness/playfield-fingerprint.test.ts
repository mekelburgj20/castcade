import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { MemoryFs } from './fs.js';
import { canonicalJson, canonicalPlayfield, fingerprintPlayfield, readPlayfieldFingerprint } from './playfield-fingerprint.js';
import type { VpxPlayfieldStreams } from './vpx-file.js';
import { ascii, buildVpx, concat, f32le, floatRecord, gameItem, intRecord, nameRecord, record, stringRecord, u32le, vec2Record } from './synth-vpx.test-support.js';

const ENDB = record('ENDB', new Uint8Array(0));
const stream = (bytes: Uint8Array, n = 0) => ({ stream: `GameItem${n}`, type: new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true), body: bytes.subarray(4) });

const flipper = (o: { x?: number; strength?: number; image?: string; name?: string } = {}) =>
  gameItem(
    1,
    vec2Record('VCEN', o.x ?? 274.3, 1822.2),
    floatRecord('BASR', 21.5),
    floatRecord('STRG', o.strength ?? 3250),
    floatRecord('FRTN', 0.055),
    stringRecord('IMAG', o.image ?? 'flippertexl'),
    nameRecord(o.name ?? 'LeftFlipper'),
    stringRecord('SURF', ''),
    intRecord('ENBL', 1),
  );

const point = (x: number, y: number) =>
  concat(record('DPNT', new Uint8Array(0)), vec2Record('VCEN', x, y), floatRecord('POSZ', 0), intRecord('SMTH', 0), intRecord('SLNG', 0), intRecord('LOCK', 0), ENDB);

const wall = (o: { collidable?: boolean; ovph?: number; mat?: string; px?: number; name?: string } = {}) =>
  concat(
    u32le(0),
    intRecord('CLDW', o.collidable === false ? 0 : 1),
    floatRecord('ELAS', 0.3),
    intRecord('OVPH', o.ovph ?? 1),
    stringRecord('MAPH', o.mat ?? ''),
    floatRecord('HTTP', 50),
    nameRecord(o.name ?? 'Wall1'),
    record('PNTS', new Uint8Array(0)),
    point(o.px ?? 10, 20),
    point(30, 40),
    ENDB,
  );

/** `PHMA` entries: 48 bytes each, a 32-byte name then elasticity, falloff, friction, scatter angle. */
const phmaEntry = (name: string, e: number, f: number) => concat(ascii(name.padEnd(32, '\0')), f32le(e), f32le(0), f32le(f), f32le(0));
const gameData = (o: { gravity?: number; metalFriction?: number; unusedFriction?: number } = {}) =>
  concat(
    floatRecord('GAVT', o.gravity ?? 1.7629847),
    floatRecord('SLOP', 6),
    floatRecord('SLPX', 7),
    floatRecord('TDFT', 0.56),
    record('PHMA', concat(phmaEntry('zCol_Metal', 0.4, o.metalFriction ?? 0.2), phmaEntry('zCol_Unused', 0.9, o.unusedFriction ?? 0.9))),
    ENDB,
  );

const streams = (items: Uint8Array[], gd: Uint8Array | null = gameData()): VpxPlayfieldStreams => ({ gameData: gd, items: items.map((b, i) => stream(b, i)) });
const fp = (items: Uint8Array[], gd?: Uint8Array | null) => fingerprintPlayfield(streams(items, gd)).id;

describe('playfield fingerprint', () => {
  it('pf1:<sha256>, deterministic, with the table physics and per-type counts', () => {
    const a = fingerprintPlayfield(streams([flipper(), wall()]));
    expect(a.id).toMatch(/^pf1:[0-9a-f]{64}$/);
    expect(fingerprintPlayfield(streams([flipper(), wall()])).id).toBe(a.id);
    expect(a.counts).toEqual({ flipper: 1, wall: 1 });
    expect(JSON.parse(a.canonical).table).toMatchObject({ GAVT: 1.762985, SLOP: 6, SLPX: 7, TDFT: 0.56, ORRP: null });
  });

  it('a moved or weakened flipper changes it; its image or name does not', () => {
    const base = fp([flipper()]);
    expect(fp([flipper({ x: 275.3 })])).not.toBe(base);
    expect(fp([flipper({ strength: 3000 })])).not.toBe(base);
    expect(fp([flipper({ image: 'flippertexr' })])).toBe(base);
    expect(fp([flipper({ name: 'FlipperL' })])).toBe(base);
  });

  it('item order and names never matter (items are sorted by content)', () => {
    expect(fp([wall({ name: 'A', px: 1 }), wall({ name: 'B', px: 2 })])).toBe(fp([wall({ name: 'Z', px: 2 }), wall({ name: 'Y', px: 1 })]));
  });

  it('a non-collidable wall is left out; making it collidable changes the fingerprint', () => {
    const base = fp([flipper()]);
    expect(fp([flipper(), wall({ collidable: false })])).toBe(base);
    expect(fp([flipper(), wall()])).not.toBe(base);
  });

  it('shape points are kept per point, and moving one changes it', () => {
    const c = canonicalPlayfield(streams([wall()]));
    expect(c.items[0]?.points).toEqual([
      { VCEN: [10, 20], POSZ: 0, SMTH: 0, SLNG: 0 },
      { VCEN: [30, 40], POSZ: 0, SMTH: 0, SLNG: 0 },
    ]);
    expect(fp([wall({ px: 11 })])).not.toBe(fp([wall()]));
  });

  it('a material is pulled in only when the item takes its physics from it, and then its physics count', () => {
    expect(canonicalPlayfield(streams([wall({ ovph: 1, mat: 'zCol_Metal' })])).materials).toEqual({});
    expect(canonicalPlayfield(streams([wall({ ovph: 0, mat: 'zCol_Metal' })])).materials).toEqual({ zCol_Metal: [0.4, 0, 0.2, 0] });
    const viaMetal = [wall({ ovph: 0, mat: 'zCol_Metal' })];
    expect(fp(viaMetal, gameData({ metalFriction: 0.05 }))).not.toBe(fp(viaMetal));
    // A material no included item uses changes nothing.
    expect(fp(viaMetal, gameData({ unusedFriction: 0.1 }))).toBe(fp(viaMetal));
  });

  it('table gravity counts; lights and triggers do not', () => {
    expect(fp([flipper()], gameData({ gravity: 1.9 }))).not.toBe(fp([flipper()]));
    const light = gameItem(7, vec2Record('VCEN', 1, 2), nameRecord('l1'));
    const trigger = gameItem(6, vec2Record('VCEN', 1, 2), nameRecord('sw1'));
    expect(fp([flipper(), light, trigger])).toBe(fp([flipper()]));
  });

  it('a collidable 3D-mesh primitive hashes vertex positions and indices, not normals or texture coordinates; a toy is left out', () => {
    // Three vertices of 8 floats (x y z nx ny nz tu tv) and one triangle of u16 indices.
    const verts = (tu: number, z: number) =>
      new Uint8Array(Buffer.concat([0, 1, 2].map((i) => Buffer.from(new Float32Array([i, i * 2, z, 0, 0, 1, tu, 0]).buffer))));
    const prim = (o: { tu?: number; z?: number; toy?: boolean } = {}) =>
      gameItem(
        19,
        record('VPOS', concat(f32le(1), f32le(2), f32le(3), f32le(0))),
        intRecord('CLDR', 1),
        intRecord('ISTO', o.toy ? 1 : 0),
        intRecord('U3DM', 1),
        intRecord('M3VN', 3),
        intRecord('M3FN', 3),
        record('M3CX', new Uint8Array(deflateSync(verts(o.tu ?? 0, o.z ?? 0)))),
        record('M3CI', new Uint8Array(deflateSync(Buffer.from(new Uint16Array([0, 1, 2]).buffer)))),
        nameRecord('p1'),
      );
    expect(canonicalPlayfield(streams([prim()])).items[0]?.mesh).toEqual({ positions: [0, 0, 0, 1, 2, 0, 2, 4, 0], indices: [0, 1, 2] });
    expect(fp([prim({ tu: 0.5 })])).toBe(fp([prim()]));
    expect(fp([prim({ z: 1 })])).not.toBe(fp([prim()]));
    expect(fp([prim({ toy: true })])).toBe(fp([]));
  });

  it('a missing record is null, so a renamed tag changes the hash rather than vanishing', () => {
    const bare = gameItem(1, vec2Record('VCEN', 274.3, 1822.2), nameRecord('LeftFlipper'));
    expect(canonicalPlayfield(streams([bare])).items[0]?.fields['STRG']).toBeNull();
  });

  it('canonical JSON sorts keys at every level', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{"a":[{"c":3,"d":2}],"b":1}');
  });

  it('reads a .vpx through the compound-file reader (GameData + GameItem streams)', async () => {
    const fs = new MemoryFs();
    fs.put('/t.vpx', buildVpx({ gameData: gameData(), gameItems: [flipper(), wall()], fillerBytes: 10_000 }));
    const got = await readPlayfieldFingerprint(fs, '/t.vpx');
    expect(got.id).toBe(fp([flipper(), wall()]));
    expect(got.counts).toEqual({ flipper: 1, wall: 1 });
  });
});
