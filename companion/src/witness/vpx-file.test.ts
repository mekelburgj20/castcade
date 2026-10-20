import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { MemoryFs, type RandomAccessFile } from './fs.js';
import { ascii, buildVpx, codeRecord, concat, f32le, floatRecord, record, u32le, utf16 } from './synth-vpx.test-support.js';
import { parseGameDataPhysics, parseTableInfo, readVpxFacts, sha256File } from './vpx-file.js';

/** MemoryFs that counts what the reader actually touches. */
class CountingFs extends MemoryFs {
  bytesRead = 0;
  opens = 0;
  closes = 0;
  override async open(path: string): Promise<RandomAccessFile> {
    const f = await super.open(path);
    this.opens++;
    return {
      size: f.size,
      read: async (offset, length) => {
        const b = await f.read(offset, length);
        this.bytesRead += b.length;
        return b;
      },
      close: async () => {
        this.closes++;
        await f.close();
      },
    };
  }
}

const difatSectorCount = (file: Uint8Array): number => new DataView(file.buffer, file.byteOffset).getUint32(0x48, true);

// --------------------------------------------------------------------------- pure parsers --------

describe('parseGameDataPhysics', () => {
  it('reads the physics floats, skips CODE by its inner length and stops at ENDB', () => {
    const script = concat(ascii('x'.repeat(10)), record('ENDB', new Uint8Array(0)), ascii('y'.repeat(7)));
    const bytes = concat(
      record('LEFT', u32le(0)),
      floatRecord('GAVT', 1.7629848),
      floatRecord('FRCT', 0.2),
      floatRecord('ELAS', 0.25),
      floatRecord('ELFA', 0),
      floatRecord('PFSC', 0),
      floatRecord('SCAT', 2),
      codeRecord(script),
      floatRecord('NDGT', 5),
      floatRecord('SLOP', 6),
      floatRecord('SLPX', 7),
      record('ENDB', new Uint8Array(0)),
      floatRecord('GAVT', 99),
    );
    const { physics, scriptBytes } = parseGameDataPhysics(bytes);
    expect(scriptBytes).toBe(script.length);
    expect(physics).toEqual({
      gravity: Math.fround(1.7629848),
      friction: Math.fround(0.2),
      elasticity: 0.25,
      elasticityFalloff: 0,
      playfieldScatter: 0,
      defaultScatter: 2,
      nudgeTime: 5,
      slopeMin: 6,
      slopeMax: 7,
      difficulty: null,
      overridePhysicsSet: null,
      overridePhysicsFlippers: null,
    });
  });

  it('yields nulls for empty or truncated input, never throws', () => {
    expect(parseGameDataPhysics(new Uint8Array(0))).toEqual({
      physics: {
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
      },
      scriptBytes: null,
    });
    const truncated = concat(floatRecord('GAVT', 1), u32le(400), ascii('FRCT'), f32le(0.5));
    const r = parseGameDataPhysics(truncated);
    expect(r.physics.gravity).toBe(1);
    expect(r.physics.friction).toBeNull();
    const cutCode = concat(u32le(4), ascii('CODE'), u32le(1000), ascii('short'), record('ENDB', new Uint8Array(0)));
    expect(parseGameDataPhysics(cutCode).scriptBytes).toBe(1000);
  });
});

describe('parseTableInfo', () => {
  it('decodes UTF-16LE strings, parses plain integers, keeps every stream in raw', () => {
    const info = parseTableInfo({
      TableName: utf16('Monster Bash VPW Mod'),
      AuthorName: utf16('VPW'),
      TableVersion: utf16('1.0'),
      ReleaseDate: utf16('Feb 2022'),
      TableSaveDate: utf16('Tue Jan  6 20:19:27 2026'),
      TableSaveRev: utf16('7'),
      Manufacturer: utf16('Williams'),
      Year: utf16('1998\0'),
      TableRules: utf16('# Rules\r\nKnock stuff down'),
    });
    expect(info).toMatchObject({
      tableName: 'Monster Bash VPW Mod',
      authorName: 'VPW',
      tableVersion: '1.0',
      releaseDate: 'Feb 2022',
      saveDate: 'Tue Jan  6 20:19:27 2026',
      saveRev: 7,
      manufacturer: 'Williams',
      year: 1998,
    });
    expect(info.raw.TableRules).toBe('# Rules\r\nKnock stuff down');
    expect(info.raw.Year).toBe('1998');
    expect(Object.keys(info.raw)).toHaveLength(9);
  });

  it('leaves non-integer numbers null, matches names case-insensitively, tolerates an odd byte', () => {
    const info = parseTableInfo({
      tablename: utf16('x'),
      Year: utf16('1998?'),
      TableSaveRev: utf16('7a'),
      AuthorName: concat(utf16('VP'), new Uint8Array([0x57])), // odd trailing byte
    });
    expect(info.tableName).toBe('x');
    expect(info.year).toBeNull();
    expect(info.saveRev).toBeNull();
    expect(info.authorName).toBe('VP');
    expect(parseTableInfo({})).toMatchObject({ tableName: null, saveRev: null, raw: {} });
  });
});

// -------------------------------------------------------------------- the compound file --------

describe('readVpxFacts', () => {
  // Built once: 8 MB of filler is what it takes for a 512-byte-sector file to need more than the
  // header's 109 DIFAT entries, so the chained DIFAT path is exercised and not just present.
  const FILLER = 8 * 1024 * 1024;
  let big: Uint8Array;
  beforeAll(() => {
    big = buildVpx({ fillerBytes: FILLER });
  });

  it('reads a v3 file with a chained DIFAT, touching only a sliver of it', async () => {
    expect(difatSectorCount(big)).toBeGreaterThanOrEqual(1);
    const fs = new CountingFs(() => 1_700_000_000_000);
    fs.put('C:/tables/synth.vpx', big);
    const facts = await readVpxFacts(fs, 'C:\\tables\\synth.vpx');
    expect(facts.path).toBe('C:\\tables\\synth.vpx');
    expect(facts.size).toBe(big.length);
    expect(facts.mtimeMs).toBe(1_700_000_000_000);
    expect(facts.fileVersion).toBe(1080);
    expect(facts.tableInfo).toMatchObject({
      tableName: 'Synth Table',
      authorName: 'Castcade CI',
      tableVersion: '1.2',
      releaseDate: 'Oct 2026',
      saveDate: 'Sat Oct 18 10:00:00 2026',
      saveRev: 42,
      manufacturer: 'Williams',
      year: 1998,
    });
    expect(facts.tableInfo.raw.TableBlurb).toBe('A blurb');
    expect(facts.tableInfo.raw).not.toHaveProperty('Screenshot');
    expect(facts.physics).toEqual({
      gravity: 1.75,
      friction: Math.fround(0.2),
      elasticity: null,
      elasticityFalloff: null,
      playfieldScatter: null,
      defaultScatter: null,
      nudgeTime: 5,
      slopeMin: 6,
      slopeMax: 7,
      difficulty: null,
      overridePhysicsSet: null,
      overridePhysicsFlippers: null,
    });
    expect(facts.scriptBytes).toBe(Buffer.byteLength("Sub Table1_Init\r\n ' ENDB inside the script must not end parsing\r\nEnd Sub\r\n"));
    // Header + a few FAT/DIFAT/directory sectors + the tiny streams: nowhere near the 8 MB filler.
    expect(fs.bytesRead).toBeLessThan(64 * 1024);
    expect(fs.opens).toBe(1);
    expect(fs.closes).toBe(1);
  });

  it('reads a large regular stream whole (GameData with a multi-MB script) and skips it correctly', async () => {
    const script = new Uint8Array(2_500_000);
    for (let i = 0; i < script.length; i++) script[i] = (i * 31) & 0xff;
    const gameData = concat(floatRecord('GAVT', 1.5), codeRecord(script), floatRecord('ELAS', 0.3), record('ENDB', new Uint8Array(0)));
    const fs = new CountingFs();
    fs.put('/t/big-script.vpx', buildVpx({ gameData, fillerBytes: 0 }));
    const facts = await readVpxFacts(fs, '/t/big-script.vpx');
    expect(facts.scriptBytes).toBe(2_500_000);
    expect(facts.physics?.gravity).toBe(1.5);
    expect(facts.physics?.elasticity).toBe(Math.fround(0.3));
    expect(fs.bytesRead).toBeGreaterThan(2_500_000);
    expect(fs.bytesRead).toBeLessThan(2_500_000 + 128 * 1024);
  });

  it('gives nulls for a table without TableInfo, and without GameStg', async () => {
    const fs = new MemoryFs();
    fs.put('/t/no-info.vpx', buildVpx({ tableInfo: null }));
    const noInfo = await readVpxFacts(fs, '/t/no-info.vpx');
    expect(noInfo.tableInfo).toEqual({
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
    expect(noInfo.fileVersion).toBe(1080);
    expect(noInfo.physics?.slopeMax).toBe(7);

    fs.put('/t/no-stg.vpx', buildVpx({ gameStg: false }));
    const noStg = await readVpxFacts(fs, '/t/no-stg.vpx');
    expect(noStg.tableInfo.tableName).toBe('Synth Table');
    expect(noStg.fileVersion).toBeNull();
    expect(noStg.physics).toBeNull();
    expect(noStg.scriptBytes).toBeNull();
  });

  it('rejects anything that is not a compound file with "not a .vpx"', async () => {
    const fs = new CountingFs();
    fs.put('/t/garbage.vpx', new Uint8Array(4096).fill(0x41));
    await expect(readVpxFacts(fs, '/t/garbage.vpx')).rejects.toThrow(/^not a \.vpx/);
    fs.put('/t/short.vpx', new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]));
    await expect(readVpxFacts(fs, '/t/short.vpx')).rejects.toThrow(/^not a \.vpx/);
    expect(fs.closes).toBe(fs.opens);
    await expect(readVpxFacts(fs, '/t/missing.vpx')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('sha256File', () => {
  it('matches node:crypto over the same bytes, in unaligned chunks', async () => {
    const bytes = new Uint8Array(300_001);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7 + 3) & 0xff;
    const fs = new CountingFs();
    fs.put('/t/a.vpx', bytes);
    const expected = createHash('sha256').update(bytes).digest('hex');
    expect(await sha256File(fs, '/t/a.vpx', { chunkBytes: 1000 })).toBe(expected);
    expect(await sha256File(fs, '/t/a.vpx')).toBe(expected);
    expect(fs.bytesRead).toBe(2 * bytes.length);
    expect(fs.closes).toBe(2);
    fs.put('/t/empty', new Uint8Array(0));
    expect(await sha256File(fs, '/t/empty')).toBe(createHash('sha256').digest('hex'));
  });

  it('stops when the signal is aborted and still closes the file', async () => {
    const fs = new CountingFs();
    fs.put('/t/a.vpx', new Uint8Array(10_000));
    const ac = new AbortController();
    ac.abort(new Error('tray shutting down'));
    await expect(sha256File(fs, '/t/a.vpx', { signal: ac.signal, chunkBytes: 100 })).rejects.toThrow('tray shutting down');
    expect(fs.closes).toBe(1);
  });
});

describe('MemoryFs.open', () => {
  it('serves slices, short at end of file, and reports size', async () => {
    const fs = new MemoryFs();
    fs.put('/f', Uint8Array.from([1, 2, 3, 4, 5]));
    const f = await fs.open('/f');
    expect(f.size).toBe(5);
    expect(await f.read(1, 2)).toEqual(Uint8Array.from([2, 3]));
    expect(await f.read(3, 10)).toEqual(Uint8Array.from([4, 5]));
    expect(await f.read(9, 10)).toEqual(new Uint8Array(0));
    await f.close();
    await expect(fs.open('/nope')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
