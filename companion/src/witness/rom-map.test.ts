import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MemoryFs } from './fs.js';
import { createRomMapStore, fetchRomMap, parseRomMap, withServedRoms, type RomMap, type RomMapFetch } from './rom-map.js';
import { matchGame } from './table-match.js';
import { createVpsIndex } from './vps-index.js';

const repo = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const seed = createVpsIndex(repo('fixtures/vps'));

const MB = { vpsGameId: 'F1Skyh5h', globalGameId: 'gg-mb', name: 'Monster Bash', manufacturer: 'Williams', year: 1998 };
const STONES = { vpsGameId: '-bG4P570', globalGameId: 'gg-rs', name: 'Rolling Stones', manufacturer: 'Bally', year: 1980 };
const CONAN = { vpsGameId: 'oImbzGjd', globalGameId: 'gg-co', name: 'Conan', manufacturer: 'Rowamet', year: 1983 };

/** ArcAid's answer as `GlobalGameRomService.romMap()` builds it. */
const ANSWER = {
  version: '0123456789abcdef',
  count: 2,
  roms: {
    mb_106b: MB,
    rollstob: { ambiguous: true, candidates: [CONAN, STONES] },
  },
};

describe('parseRomMap', () => {
  it('reads one-game and ambiguous entries, lowercasing and trimming the ROM keys', () => {
    const map = parseRomMap({ ...ANSWER, roms: { ' MB_106B ': MB, rollstob: ANSWER.roms.rollstob } });
    expect(map).toEqual({ version: '0123456789abcdef', count: 2, roms: { mb_106b: MB, rollstob: { ambiguous: true, candidates: [CONAN, STONES] } } });
  });

  it('keeps numeric catalogue ids and missing manufacturer / year as null', () => {
    expect(parseRomMap({ version: 'v', count: 1, roms: { x_1: { vpsGameId: 'X', globalGameId: 7, name: 'X', manufacturer: null } } })?.roms['x_1']).toEqual({
      vpsGameId: 'X', globalGameId: 7, name: 'X', manufacturer: null, year: null,
    });
  });

  it('is null for a malformed answer and drops an entry that does not type-check', () => {
    expect(parseRomMap(null)).toBeNull();
    expect(parseRomMap('nope')).toBeNull();
    expect(parseRomMap([ANSWER])).toBeNull();
    expect(parseRomMap({ ...ANSWER, version: '' })).toBeNull();
    expect(parseRomMap({ ...ANSWER, roms: [] })).toBeNull();
    expect(parseRomMap({ count: 2, roms: ANSWER.roms })).toBeNull();
    const map = parseRomMap({ version: 'v', count: 4, roms: { mb_106b: MB, bad_1: { name: 'no id' }, empty_1: { ambiguous: true, candidates: [{}] }, ' ': MB } });
    expect(map).toEqual({ version: 'v', count: 1, roms: { mb_106b: MB } });
  });
});

describe('RomMapStore', () => {
  it('round-trips the map with its ETag, and reads a missing or torn file as none', async () => {
    const fs = new MemoryFs();
    const store = createRomMapStore(fs, '/data');
    expect(await store.load()).toBeNull();
    const map = parseRomMap(ANSWER)!;
    await store.save({ fetchedAt: '2026-10-30T12:00:00.000Z', etag: '"0123456789abcdef"', map });
    expect(fs.has('/data/roms.json')).toBe(true);
    expect(await createRomMapStore(fs, '/data').load()).toEqual({ fetchedAt: '2026-10-30T12:00:00.000Z', etag: '"0123456789abcdef"', map });

    fs.put('/data/roms.json', '{"fetchedAt":"x","map":{');
    expect(await store.load()).toBeNull();
    fs.put('/data/roms.json', JSON.stringify({ fetchedAt: 'x', etag: null, map: { version: 'v' } }));
    expect(await store.load()).toBeNull();
  });
});

describe('fetchRomMap', () => {
  function fake(respond: () => { status: number; body?: unknown; etag?: string } | Error) {
    const calls: { url: URL; headers: Record<string, string> }[] = [];
    const fetch: RomMapFetch = async (input, init) => {
      calls.push({ url: new URL(input), headers: init.headers });
      const r = respond();
      if (r instanceof Error) throw r;
      return {
        status: r.status,
        text: async () => (r.body === undefined ? '' : JSON.stringify(r.body)),
        headers: { get: (n: string) => (n.toLowerCase() === 'etag' ? (r.etag ?? null) : null) },
      };
    };
    return { fetch, calls };
  }

  it('GETs the public route without a device token and returns the map with its ETag', async () => {
    const { fetch, calls } = fake(() => ({ status: 200, body: ANSWER, etag: '"0123456789abcdef"' }));
    const r = await fetchRomMap(fetch, 'https://arcaid.app/', null);
    expect(r).toEqual({ kind: 'fresh', map: parseRomMap(ANSWER), etag: '"0123456789abcdef"' });
    expect(calls[0]?.url.toString()).toBe('https://arcaid.app/api/witness/roms');
    expect(calls[0]?.headers['x-witness-token']).toBeUndefined();
    expect(calls[0]?.headers['if-none-match']).toBeUndefined();
  });

  it('falls back to the version as the ETag when the response has no headers', async () => {
    const fetch: RomMapFetch = async () => ({ status: 200, text: async () => JSON.stringify(ANSWER) });
    expect(await fetchRomMap(fetch, 'https://a', null)).toMatchObject({ kind: 'fresh', etag: '"0123456789abcdef"' });
  });

  it('revalidates with If-None-Match: 304 is unchanged', async () => {
    const { fetch, calls } = fake(() => ({ status: 304 }));
    expect(await fetchRomMap(fetch, 'https://a', '"0123456789abcdef"')).toEqual({ kind: 'unchanged' });
    expect(calls[0]?.headers['if-none-match']).toBe('"0123456789abcdef"');
  });

  it('a 500, a malformed body or no answer is a failure, never a throw', async () => {
    expect(await fetchRomMap(fake(() => ({ status: 500, body: { error: 'Internal Server Error' } })).fetch, 'https://a', null)).toEqual({ kind: 'failed', error: 'HTTP 500' });
    expect(await fetchRomMap(fake(() => ({ status: 200, body: { roms: {} } })).fetch, 'https://a', null)).toEqual({ kind: 'failed', error: 'malformed map' });
    expect(await fetchRomMap(fake(() => new TypeError('fetch failed')).fetch, 'https://a', null)).toEqual({ kind: 'failed', error: 'fetch failed' });
  });
});

describe('withServedRoms (precedence: served exact ROM, then the seed)', () => {
  const served = (map: unknown) => withServedRoms(seed, () => parseRomMap(map));

  it('with no served map every lookup is the seed', async () => {
    const plain = withServedRoms(seed, () => null);
    expect(await plain.gamesForRom('rollstob')).toEqual(await seed.gamesForRom('rollstob'));
    expect(await plain.gamesForRom('mm_109x')).toEqual(await seed.gamesForRom('mm_109x'));
    expect(await plain.version()).toBe(await seed.version());
  });

  it("a served one-game entry beats the seed's list for the same ROM, and matches as exact", async () => {
    // The seed lists `rollstob` under six games (re-themes and originals): ambiguous by ROM alone.
    expect((await seed.gamesForRom('rollstob')).length).toBeGreaterThan(1);
    const index = served({ version: 'v', count: 1, roms: { rollstob: STONES } });
    const hits = await index.gamesForRom('RollStoB');
    expect(hits.map((g) => g.id)).toEqual(['-bG4P570']);
    expect(hits[0]?.tables.length).toBeGreaterThan(0); // the seed's record, tables and all
    expect(await matchGame(index, { rom: 'rollstob', fileName: null, tableInfo: null, romName: null })).toMatchObject({ game: { id: '-bG4P570' }, confidence: 'exact', source: 'rom' });
  });

  it('a served revision the seed knows only by family resolves exactly; a game the seed lacks is built from the entry', async () => {
    const index = served({ version: 'v', count: 2, roms: { mm_109x: { vpsGameId: '-5yMpqSy', globalGameId: 'gg-mm', name: 'Medieval Madness', manufacturer: 'Williams', year: 1997 }, zz_100: { vpsGameId: 'NEWGAME1', globalGameId: 'gg-new', name: 'New Game', manufacturer: 'Stern', year: 2026 } } });
    expect(await matchGame(index, { rom: 'mm_109x', fileName: null, tableInfo: null, romName: null })).toMatchObject({ game: { id: '-5yMpqSy' }, confidence: 'exact' });
    expect(await matchGame(seed, { rom: 'mm_109x', fileName: null, tableInfo: null, romName: null })).toMatchObject({ game: { id: '-5yMpqSy' }, confidence: 'likely' });
    expect(await index.gamesForRom('zz_100')).toEqual([{ id: 'NEWGAME1', name: 'New Game', manufacturer: 'Stern', year: 2026, type: null, roms: ['zz_100'], tables: [] }]);
    expect(await index.game('NEWGAME1')).toMatchObject({ id: 'NEWGAME1', name: 'New Game' });
    expect(await seed.game('NEWGAME1')).toBeNull();
  });

  it("an ambiguous served entry falls through to the seed's rule", async () => {
    const index = served(ANSWER);
    expect(await index.gamesForRom('rollstob')).toEqual(await seed.gamesForRom('rollstob'));
  });

  it("a ROM the served map does not list uses the seed's family fallback (the server has none)", async () => {
    const index = served(ANSWER);
    expect((await index.gamesForRom('mm_109x')).map((g) => g.id)).toEqual(['-5yMpqSy']);
    expect(await index.gamesForRom('nothing_1')).toEqual([]);
  });

  it('follows the map it is handed: a later fetch takes effect on the next lookup', async () => {
    let map: RomMap | null = null;
    const index = withServedRoms(seed, () => map);
    expect((await index.gamesForRom('rollstob')).length).toBeGreaterThan(1);
    map = parseRomMap({ version: 'v2', count: 1, roms: { rollstob: CONAN } });
    expect((await index.gamesForRom('rollstob')).map((g) => g.id)).toEqual(['oImbzGjd']);
  });
});
