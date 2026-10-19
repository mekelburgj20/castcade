import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MemoryFs } from './fs.js';
import type { VpsTableEntry } from './identity-types.js';
import { createVpsIndex, normalizeVpsName, romFamily, sameManufacturer, tableLabel } from './vps-index.js';

const repo = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const index = createVpsIndex(repo('fixtures/vps'));

const table = (over: Partial<VpsTableEntry>): VpsTableEntry => ({
  id: 't',
  authors: [],
  version: null,
  features: [],
  format: 'VPX',
  comment: null,
  updatedAt: null,
  ...over,
});

describe('normalizeVpsName', () => {
  it('folds case, punctuation, parentheticals, ampersands and diacritics', () => {
    expect(normalizeVpsName("Sittin' Pretty")).toBe('sittin pretty');
    expect(normalizeVpsName('Tom & Jerry (Original 2024)')).toBe('tom and jerry');
    expect(normalizeVpsName('  Medieval   Madness ')).toBe('medieval madness');
    expect(normalizeVpsName('Pokémon')).toBe('pokemon');
    expect(normalizeVpsName('Game of Thrones (Limited Edition)')).toBe('game of thrones');
  });
});

describe('romFamily', () => {
  it('takes the part before the first underscore when it is at least two characters', () => {
    expect(romFamily('mm_109c')).toBe('mm');
    expect(romFamily('tftc_400')).toBe('tftc');
    expect(romFamily('MB_106b')).toBe('mb');
    expect(romFamily('rollstob')).toBeNull();
    expect(romFamily('x_1')).toBeNull();
  });
});

describe('sameManufacturer', () => {
  it('is a loose, two-way containment', () => {
    expect(sameManufacturer('Bally', 'Bally/Midway')).toBe(true);
    expect(sameManufacturer('Data East', 'data east')).toBe(true);
    expect(sameManufacturer('Williams', 'Stern')).toBe(false);
    expect(sameManufacturer(null, 'Stern')).toBe(false);
  });
});

describe('tableLabel', () => {
  it('shows a group author alone, a person with a co-author, the version and up to three features', async () => {
    const mb = await index.game('F1Skyh5h');
    const vpw = mb?.tables.find((t) => t.id === 'rxmbAdBi');
    const arvid = mb?.tables.find((t) => t.id === 'G7Df7_IH');
    const hanibal = mb?.tables.find((t) => t.id === 'KCOAM4aM');
    expect(vpw && tableLabel(vpw)).toBe('VPW 1.0 · MOD, VR, FSS');
    expect(arvid && tableLabel(arvid)).toBe('Arvid & Tom Tower 1.0.0 · VR');
    // The comment is appended when short and when it adds words the label does not already carry.
    expect(hanibal && tableLabel(hanibal)).toBe('Hanibal 2.3 · MOD · Frank Eye and Flasher MODs');
  });
  it('copes with missing fields', () => {
    expect(tableLabel(table({}))).toBe('unknown author');
    expect(tableLabel(table({ authors: ['JPSalas'], version: '6.0.0' }))).toBe('JPSalas 6.0.0');
    expect(tableLabel(table({ authors: ['Zen Studios', 'Peter Grafl'], comment: 'Williams Pinball - Universal Monsters Pack - Table 130' }))).toBe(
      'Zen Studios',
    );
  });
});

describe('createVpsIndex over the fixture subset', () => {
  it('reports the commit it was built from and finds games by id', async () => {
    expect(await index.version()).toBe('cce9160b30110ee174786239fdfb30a6e4caaab7');
    const mb = await index.game('F1Skyh5h');
    expect(mb?.name).toBe('Monster Bash');
    expect(mb?.manufacturer).toBe('Williams');
    expect(mb?.year).toBe(1998);
    expect(mb?.roms).toEqual(['mb_106b']);
    expect(mb?.tables.map((t) => t.id)).toContain('rxmbAdBi');
    expect(await index.game('nope')).toBeNull();
  });

  it('gamesForRom: exact hits first, family hits only when nothing lists the id, case-insensitive', async () => {
    expect((await index.gamesForRom('mm_109c')).map((g) => g.id)).toEqual(['-5yMpqSy']);
    expect((await index.gamesForRom('MM_109C')).map((g) => g.id)).toEqual(['-5yMpqSy']);
    // An unlisted revision of a listed family.
    expect((await index.gamesForRom('mm_109x')).map((g) => g.id)).toEqual(['-5yMpqSy']);
    expect((await index.gamesForRom('tftc_303')).map((g) => g.id)).toEqual(['fXaQ33KC']);
    // Five games share rollstob; sorted by name.
    expect((await index.gamesForRom('rollstob')).map((g) => g.name)).toEqual([
      'Conan',
      'Conan the Barbarian',
      'Rolling Stones',
      'Stray Cats',
      'Tiger King',
    ]);
    // No underscore: exact only, no family fallback.
    expect(await index.gamesForRom('rollstox')).toEqual([]);
    expect(await index.gamesForRom('')).toEqual([]);
  });

  it('gamesByName: normalised equality; hints narrow a tie but never empty it', async () => {
    expect((await index.gamesByName('monster bash')).map((g) => g.id)).toEqual(['F1Skyh5h']);
    expect((await index.gamesByName("Sittin' Pretty")).map((g) => g.id)).toEqual(['-5vpyFdfos']);
    expect((await index.gamesByName('Deadpool')).map((g) => g.id).sort()).toEqual(['-bv6-HSX', 'K3qwGUCAYu'].sort());
    expect((await index.gamesByName('Deadpool', { year: 2018 })).map((g) => g.id)).toEqual(['K3qwGUCAYu']);
    expect((await index.gamesByName('Deadpool', { manufacturer: 'Zen Studios' })).map((g) => g.id)).toEqual(['-bv6-HSX']);
    // Same name, same year, different manufacturer.
    expect((await index.gamesByName('Black Belt', { manufacturer: 'Bally', year: 1986 })).map((g) => g.id)).toEqual(['atmZ8zPG']);
    // A wrong hint on a tie keeps the tie; a wrong hint on a single hit keeps the hit.
    expect((await index.gamesByName('Deadpool', { year: 1999 })).length).toBe(2);
    expect((await index.gamesByName('Monster Bash', { manufacturer: 'Gottlieb', year: 1950 })).map((g) => g.id)).toEqual(['F1Skyh5h']);
    expect(await index.gamesByName('No Such Table')).toEqual([]);
  });

  it('is empty, not broken, when the index file is missing or malformed', async () => {
    const missing = createVpsIndex('C:\\nowhere\\vps', new MemoryFs());
    expect(await missing.version()).toBeNull();
    expect(await missing.game('F1Skyh5h')).toBeNull();
    expect(await missing.gamesForRom('mb_106b')).toEqual([]);
    expect(await missing.gamesByName('Monster Bash')).toEqual([]);

    const fs = new MemoryFs();
    fs.put('/vps/index.json', JSON.stringify({ version: 'abc', games: [{ id: 'x' }, { id: 'y', name: 'Y', roms: ['R_1'], tables: [{ id: 't1', format: 'VPX' }, {}] }] }));
    const partial = createVpsIndex('/vps', fs);
    expect(await partial.version()).toBe('abc');
    expect(await partial.game('x')).toBeNull();
    const y = await partial.game('y');
    expect(y?.roms).toEqual(['r_1']);
    expect(y?.tables).toEqual([{ id: 't1', authors: [], version: null, features: [], format: 'VPX', comment: null, updatedAt: null }]);
    expect((await partial.gamesForRom('r_1')).map((g) => g.id)).toEqual(['y']);
  });
});
