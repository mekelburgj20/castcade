import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { VpsGameEntry, VpsIndexFile } from './identity-types.js';
import { createMapCorpus, type CompiledMap } from './maps.js';
import { buildSupportList, NO_MAP_REASON, NO_PLATFORM, NO_ROM_REASON, preloadMaps, type SupportList } from './support-list.js';

const repo = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const corpus = createMapCorpus(repo('fixtures/maps'));
const fixtureVps = JSON.parse(readFileSync(repo('fixtures/vps/index.json'), 'utf8')) as VpsIndexFile;
const verifiedRoms = new Set(readdirSync(repo('fixtures/nvram'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name));

const game = (over: Partial<VpsGameEntry> & Pick<VpsGameEntry, 'id' | 'name'>): VpsGameEntry => ({
  manufacturer: 'Stern',
  year: 2014,
  type: 'SS',
  roms: [],
  tables: [{ id: `${over.id}-t`, authors: [], version: null, features: [], format: 'VPX', comment: null, updatedAt: null }],
  ...over,
});

/** The fixture index plus two Stern SAM games: no game of the VPS fixture lists a SAM ROM. */
const games: VpsGameEntry[] = [
  ...fixtureVps.games,
  game({ id: 'sam-acd', name: 'AC/DC (Premium)', roms: ['acd_170h'] }),
  game({ id: 'sam-twd', name: 'The Walking Dead (Limited Edition)', roms: ['twd_160h'] }),
];

async function build(roms = verifiedRoms, mapFor?: (rom: string) => CompiledMap | null): Promise<SupportList> {
  const loaded = await preloadMaps(corpus, games);
  return buildSupportList({
    vps: { games },
    mapFor: mapFor ?? loaded.mapFor,
    mapFile: loaded.mapFile,
    verifiedRoms: roms,
    versions: { vps: fixtureVps.version, maps: 'f0c4220', app: '0.0.0' },
    generatedAt: '2026-10-30T00:00:00.000Z',
  });
}

const find = (list: SupportList, id: string) => {
  const g = list.games.find((x) => x.vpsId === id);
  if (!g) throw new Error(`no game ${id}`);
  return g;
};

describe('buildSupportList (B14)', () => {
  it('mm_109c has a recorded game: verified; its sibling revision is supported; the game takes the best ROM', async () => {
    const mm = find(await build(), '-5yMpqSy');
    expect(mm.roms.map((r) => [r.rom, r.status])).toEqual([
      ['mm_109c', 'verified'],
      ['mm_109b', 'supported'],
      ['mm_10', 'unsupported'],
    ]);
    expect(mm.roms[0]).toMatchObject({ map: 'maps/williams/wpc/mm_109.map.json', platform: 'williams-wpc-12K', reason: null });
    expect(mm.roms[0]!.live).toEqual({ scores: true, game_over: true, current_ball: true, current_player: true });
    expect(mm.roms[2]).toMatchObject({ map: null, platform: null, reason: NO_MAP_REASON });
    expect(mm).toMatchObject({ status: 'verified', reason: null, platform: 'williams-wpc-12K' });
  });

  it('Stern SAM is supported through the end-of-game record, with ball, player and game over unseen', async () => {
    // Both SAM ROMs have a fixtures/nvram folder; leave acd_170h out to see plain "supported".
    const list = await build(new Set(['twd_160h']));
    const acd = find(list, 'sam-acd');
    expect(acd).toMatchObject({ status: 'supported', platform: 'stern-sam', reason: null });
    expect(acd.roms[0]!.live).toEqual({ scores: true, game_over: false, current_ball: false, current_player: false });
    expect(find(list, 'sam-twd').status).toBe('verified');
  });

  it('a ROM with no map, and a game with no ROM, are unsupported with their reasons', async () => {
    const list = await build();
    expect(find(list, '-bG4P570')).toMatchObject({ name: 'Rolling Stones', status: 'unsupported', reason: NO_MAP_REASON, platform: null });
    expect(find(list, '-5vpyFdfos')).toMatchObject({ name: "Sittin' Pretty", status: 'unsupported', reason: NO_ROM_REASON, roms: [] });
  });

  it("a mapped machine whose live fields are not readable carries liveSupport's reason, not 'no map'", async () => {
    const loaded = await preloadMaps(corpus, games);
    const mm = loaded.mapFor('mm_109c')!;
    const { current_ball: _ball, ...rest } = mm.gameState;
    const noBall = { ...mm, gameState: rest };
    const list = await build(new Set(), (rom) => (rom.startsWith('mm_') ? (rom === 'mm_10' ? null : noBall) : loaded.mapFor(rom)));
    const g = find(list, '-5yMpqSy');
    expect(g.status).toBe('unsupported');
    expect(g.reason).toBe('williams-wpc-12K: no current_ball in the map');
    expect(g.roms[0]!.live.current_ball).toBe(false);
    expect(list.counts.byReason['williams-wpc-12K: no current_ball in the map']).toBe(1);
  });

  it('leaves out games with no VPX table, sorts by name, and the counts add up', async () => {
    const list = await build();
    const ids = list.games.map((g) => g.vpsId);
    expect(ids).not.toContain('-bv6-HSX'); // Deadpool (Zen): FX only
    expect(ids).not.toContain('1ZFzSEzm3C'); // Black Belt (Zaccaria): VP9 only
    const names = list.games.map((g) => g.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, 'en')));

    const { counts } = list;
    expect(counts.games).toBe(list.games.length);
    expect(counts.verified + counts.supported + counts.unsupported).toBe(counts.games);
    expect(Object.values(counts.byReason).reduce((a, b) => a + b, 0)).toBe(counts.unsupported);
    for (const s of ['verified', 'supported', 'unsupported'] as const) {
      expect(Object.values(counts.byPlatform).reduce((a, row) => a + row[s], 0)).toBe(counts[s]);
    }
    expect(counts.byPlatform[NO_PLATFORM]!.unsupported).toBe(list.games.filter((g) => g.platform === null).length);
    // Every fixture ROM of a listed game has a recorded game, so all five readable games are verified.
    expect(list.games.filter((g) => g.status === 'verified').map((g) => g.name)).toEqual([
      'AC/DC (Premium)',
      'Medieval Madness',
      'Monster Bash',
      'Tales from the Crypt',
      'The Walking Dead (Limited Edition)',
    ]);
  });

  it('every game status is the best of its ROM statuses', async () => {
    const rank = { verified: 2, supported: 1, unsupported: 0 } as const;
    for (const g of (await build()).games) {
      const best = Math.max(0, ...g.roms.map((r) => rank[r.status]));
      expect(rank[g.status]).toBe(best);
    }
  });

  it('is byte-stable for the same input', async () => {
    expect(JSON.stringify(await build())).toBe(JSON.stringify(await build()));
  });
});
