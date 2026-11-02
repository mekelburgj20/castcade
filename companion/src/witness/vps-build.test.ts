import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MemoryFs } from './fs.js';
import type { VpsIndexFile } from './identity-types.js';
import { buildIndex, countTables, gameEntry, tableEntry } from './vps-build.js';
import { createVpsIndex } from './vps-index.js';

const repo = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const fixture = JSON.parse(readFileSync(repo('fixtures/vps/index.json'), 'utf8')) as VpsIndexFile;

/** A vpsdb.json-shaped database: two games with the sheet's own field names, plus the noise the sheet carries. */
const rawDb = [
  {
    id: 'F1Skyh5h',
    name: ' Monster Bash ',
    manufacturer: 'Williams',
    year: 1998,
    type: 'SS',
    theme: ['Horror'],
    imgUrl: 'https://example.invalid/mb.png',
    romFiles: [{ id: 'r1', version: 'MB_106b' }, { id: 'r2', version: 'mb_106b' }, { id: 'r3' }, 'junk'],
    tableFiles: [
      {
        id: 'rxmbAdBi',
        authors: ['VPW', '', ' Sixtoe '],
        version: '1.0',
        features: ['MOD', 'VR', 'FSS'],
        tableFormat: 'VPX',
        comment: 'VPW mod',
        updatedAt: 1700000000000,
        urls: [{ url: 'https://example.invalid/dl' }],
      },
      { id: '', authors: ['nobody'] },
      { authors: ['no id either'] },
      { id: 'bare' },
    ],
  },
  { id: 'noname', manufacturer: 'Stern' },
  { id: 'later', name: 'Added After The Pin', year: 'not a number', romFiles: 'nope', tableFiles: null },
  null,
  'junk',
];

describe('tableEntry / gameEntry', () => {
  it('reduce a sheet record to the index shape, trimming strings and dropping what has no id', () => {
    expect(tableEntry(rawDb[0] && (rawDb[0] as { tableFiles: unknown[] }).tableFiles[0])).toEqual({
      id: 'rxmbAdBi',
      authors: ['VPW', 'Sixtoe'],
      version: '1.0',
      features: ['MOD', 'VR', 'FSS'],
      format: 'VPX',
      comment: 'VPW mod',
      updatedAt: 1700000000000,
    });
    expect(tableEntry({ id: 'bare' })).toEqual({ id: 'bare', authors: [], version: null, features: [], format: null, comment: null, updatedAt: null });
    expect(tableEntry({ id: '  ' })).toBeNull();
    expect(tableEntry(null)).toBeNull();

    const mb = gameEntry(rawDb[0]);
    expect(mb?.name).toBe('Monster Bash');
    expect(mb?.roms).toEqual(['mb_106b']);
    expect(mb?.tables.map((t) => t.id)).toEqual(['rxmbAdBi', 'bare']);
    expect(gameEntry(rawDb[1])).toBeNull();
    expect(gameEntry(rawDb[2])).toEqual({ id: 'later', name: 'Added After The Pin', manufacturer: null, year: null, type: null, roms: [], tables: [] });
  });
});

describe('buildIndex', () => {
  it('builds a VpsIndexFile in source order, with the version and time it is given', () => {
    const index = buildIndex(rawDb, { version: 'abc123', generatedAt: '2026-11-02T04:10:00.000Z' });
    expect(index.version).toBe('abc123');
    expect(index.generatedAt).toBe('2026-11-02T04:10:00.000Z');
    expect(index.games.map((g) => g.id)).toEqual(['F1Skyh5h', 'later']);
    expect(countTables(index)).toBe(2);
  });

  it('keeps only a subset when asked and reports the ids the database lacks', () => {
    const missing: string[] = [];
    const index = buildIndex(rawDb, { version: 'v', subset: new Set(['later', 'ghost']), onMissing: (id) => missing.push(id) });
    expect(index.games.map((g) => g.id)).toEqual(['later']);
    expect(missing).toEqual(['ghost']);
  });

  it('refuses anything but an array of games', () => {
    expect(() => buildIndex({ games: [] }, { version: 'v' })).toThrow(/top-level array/);
  });

  it('produces exactly the shape of the committed fixture, and the loader reads it back unchanged', async () => {
    const index = buildIndex(rawDb, { version: 'v', generatedAt: 't' });
    const game = index.games[0];
    const fixtureGame = fixture.games.find((g) => g.id === 'F1Skyh5h');
    expect(game && Object.keys(game)).toEqual(fixtureGame && Object.keys(fixtureGame));
    expect(game?.tables[0] && Object.keys(game.tables[0])).toEqual(fixtureGame?.tables[0] && Object.keys(fixtureGame.tables[0]));
    expect(Object.keys(index)).toEqual(Object.keys(fixture));

    const fs = new MemoryFs();
    fs.put('/vps/index.json', JSON.stringify(index));
    const loaded = createVpsIndex('/vps', fs);
    expect(await loaded.game('F1Skyh5h')).toEqual(game);
    expect(await loaded.game('later')).toEqual(index.games[1]);
    expect((await loaded.gamesForRom('MB_106B')).map((g) => g.id)).toEqual(['F1Skyh5h']);
  });
});
