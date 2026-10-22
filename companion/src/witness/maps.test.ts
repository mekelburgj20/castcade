import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MemoryFs } from './fs.js';
import { readJournalLines, replayJournal } from './journal-replay.js';
import {
  compileMap,
  createMapCorpus,
  decodeGameState,
  decodeHighScores,
  decodeLastPlayed,
  gameStateOffsets,
  descriptorEnum,
  descriptorString,
  NvMemory,
  romFromNvName,
  sameGame,
  stripRomVersion,
  toInt,
  type Json,
} from './maps.js';

const repo = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const corpus = createMapCorpus(repo('fixtures/maps'));

/**
 * Ground truth for both fixtures comes from the reference implementation: the final shadow
 * buffer of each journal decoded with `py-pinmame-nvmaps` (`nvram_parser.py`, commit 00ea784)
 * against `pinmame-nvram-maps` f16a0cc, i.e. what `vpx-hook/spike/tail-journal.py` reports at
 * `table_exit` (2026-10-18). Each fixture's `.meta.json` carries the same final scores in prose.
 */
describe('fixture replay decodes like the reference parser', () => {
  it('mm_109c (Williams WPC): two games, last game 1,089,510, game over', async () => {
    const journal = replayJournal(readJournalLines(repo('fixtures/nvram/mm_109c/2026-10-17-1.jsonl.gz')));
    expect(journal.rom).toBe('mm_109c');
    expect(journal.table).toBe('Medieval Madness (Williams 1997) VPW v1.0.1');
    expect(journal.fulls).toBe(16);
    expect(journal.deltas).toBe(77546); // 77547 in the file; the first precedes the first nvram_full and is skipped
    expect(journal.torn).toBe(0);
    expect(journal.buffer?.length).toBe(12334);

    const map = await corpus.mapFor('mm_109c');
    expect(map).not.toBeNull();
    if (!map || !journal.buffer) throw new Error('no map or buffer');
    expect(map.platform.name).toBe('williams-wpc-12K');

    const state = decodeGameState(map, journal.buffer);
    expect(state.scores).toEqual([1089510, 0, 0, 0]);
    expect(state.playerCount).toBe(1);
    expect(state.currentPlayer).toBe(1);
    expect(state.currentBall).toBe(3);
    expect(state.gameOver).toBe(true);
    expect(state.ballCount).toBe(3);
    expect(state.extraBalls).toBe(0);
    expect(state.credits).toBe(5);
    expect(state.other).toMatchObject({ volume: 24, replay: 28000000, max_credits: 10, free_play: 0, eb_on_this_ball: 0 });

    expect(decodeHighScores(map, journal.buffer)).toEqual([
      { label: 'Grand Champion', shortLabel: 'GC', initials: 'JRM', score: 95793090 },
      { label: 'First Place', shortLabel: '1st', initials: 'SLL', score: 52000000 },
      { label: 'Second Place', shortLabel: '2nd', initials: 'BRE', score: 44000000 },
      { label: 'Third Place', shortLabel: '3rd', initials: 'LFS', score: 40000000 },
      { label: 'Fourth Place', shortLabel: '4th', initials: 'ZAP', score: 36000000 },
    ]);
    expect(decodeLastPlayed(map, journal.buffer)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it('tftc_400 (Data East, offsets lists, inverted bool): one game, 2,318,430, game over', async () => {
    const journal = replayJournal(readJournalLines(repo('fixtures/nvram/tftc_400/2026-10-17-1.jsonl.gz')));
    expect(journal.rom).toBe('tftc_400');
    expect(journal.fulls).toBe(5);
    expect(journal.deltas).toBe(22234); // 22235 in the file, same first-delta skip
    expect(journal.buffer?.length).toBe(8238);

    const map = await corpus.mapFor('tftc_400');
    if (!map || !journal.buffer) throw new Error('no map or buffer');
    expect(map.platform.name).toBe('dataeast');

    const state = decodeGameState(map, journal.buffer);
    expect(state.scores).toEqual([2318430, 0, 0, 0]);
    // Data East clears player/ball at game over; the map derives game_over from current_player == 0.
    expect(state.playerCount).toBe(0);
    expect(state.currentPlayer).toBe(0);
    expect(state.currentBall).toBe(0);
    expect(state.gameOver).toBe(true);
    expect(state.ballCount).toBe(3);
    expect(state.credits).toBe(5);
    expect(state.other).toMatchObject({ max_credits: 30, free_play: 0 });

    expect(decodeHighScores(map, journal.buffer)).toEqual([
      { label: 'First', shortLabel: '#1', initials: 'JRL', score: 1124774750 },
      { label: 'Second', shortLabel: '#2', initials: 'CNH', score: 750000000 },
      { label: 'Third', shortLabel: '#3', initials: 'JRM', score: 663929960 },
      { label: 'Fourth', shortLabel: '#4', initials: 'DAN', score: 600000000 },
      { label: 'Fifth', shortLabel: '#5', initials: 'MGC', score: 550000000 },
      { label: 'Sixth', shortLabel: '#6', initials: 'MSS', score: 500000000 },
    ]);
  });

  it('exposes the corpus version and resolves ROM aliases and .nv names', async () => {
    expect(await corpus.version()).toBe('f16a0cc6c347370706bf1a3f2c7a77568b3f69e7');
    expect(await corpus.mapFor('mm_109')).toBe(await corpus.mapFor('mm_109c'));
    expect(await corpus.mapFor('nope_123')).toBeNull();
    expect(romFromNvName('mm_109c.nv')).toBe('mm_109c');
    expect(romFromNvName('tftc_400-b.nv')).toBe('tftc_400');
    const empty = createMapCorpus('/nowhere', new MemoryFs());
    expect(await empty.mapFor('mm_109c')).toBeNull();
    expect(await empty.version()).toBeNull();
    expect(await empty.romName('mm_109c')).toBeNull();
  });

  it('names a ROM from romnames.json without its version parenthetical', async () => {
    expect(await corpus.romName('mb_106b')).toBe('Monster Bash');
    expect(await corpus.romName('mm_109c')).toBe('Medieval Madness');
    expect(await corpus.romName('tftc_400.nv')).toBe('Tales from the Crypt');
    expect(await corpus.romName('zzz_999')).toBeNull();
    expect(stripRomVersion('Monster Bash (1.06b)')).toBe('Monster Bash');
    expect(stripRomVersion('Tales from the Crypt (4.00 unofficial MOD)')).toBe('Tales from the Crypt');
    expect(stripRomVersion('(1.0)')).toBe('(1.0)');
    expect(stripRomVersion('Plain')).toBe('Plain');
  });
});

const platformBig: Json = {
  endian: 'big',
  memory_layout: [{ address: 0, size: '0x100', type: 'nvram' }],
};

function mapWith(gameState: Json, extra: Json = {}, platform: Json = platformBig, meta: Json = {}) {
  const json: Json = {
    _fileformat: 0.8,
    _metadata: { version: 1, roms: ['t_1'], platform: 'p', ...(meta as object) },
    game_state: gameState,
    ...(extra as object),
  };
  return compileMap(json, () => platform);
}

describe('descriptor encodings', () => {
  it('bcd big/little endian, int, scale and offset', () => {
    const map = mapWith({
      scores: [
        { encoding: 'bcd', start: 0, length: 3 },
        { encoding: 'bcd', start: 3, length: 3, endian: 'little' },
      ],
      current_ball: { encoding: 'int', start: 6, length: 2 },
      credits: { encoding: 'int', start: 8, scale: 10, offset: -5 },
    });
    const nv = Uint8Array.from([0x12, 0x34, 0x56, 0x50, 0x34, 0x12, 0x01, 0x02, 0x03]);
    const st = decodeGameState(map, nv);
    expect(st.scores).toEqual([123456, 123450]);
    expect(st.currentBall).toBe(258);
    expect(st.credits).toBe(25);
  });

  it('bcd treats 0xA–0xF nibbles as 0 and bool honours invert', () => {
    const map = mapWith({
      scores: [{ encoding: 'bcd', start: 0, length: 2 }],
      game_over: { encoding: 'bool', start: 2, invert: true },
      player_count: { encoding: 'bool', start: 3 },
    });
    expect(decodeGameState(map, Uint8Array.from([0xf1, 0x2a, 0x00, 0x07]))).toMatchObject({
      scores: [120],
      gameOver: true,
      playerCount: 1,
    });
    expect(decodeGameState(map, Uint8Array.from([0x00, 0x00, 0x01, 0x00])).gameOver).toBe(false);
  });

  it('nibble low/high from the platform region and per entry, with an odd length', () => {
    const lowPlatform: Json = { endian: 'big', memory_layout: [{ address: 0, size: 16, type: 'nvram', nibble: 'low' }] };
    const map = mapWith(
      {
        scores: [{ encoding: 'bcd', start: 0, length: 6 }],
        credits: { encoding: 'bcd', start: 0, length: 6, nibble: 'high' },
        current_ball: { encoding: 'int', start: 6, length: 3 },
      },
      {},
      lowPlatform,
    );
    const nv = Uint8Array.from([0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0x01, 0x02, 0x03]);
    const st = decodeGameState(map, nv);
    expect(st.scores).toEqual([246800]); // low nibbles 2,4,6,8,a,c -> 24 68 a0 -> a reads as 0
    expect(st.credits).toBe(135790); // high nibbles 1,3,5,7,9,b
    expect(st.currentBall).toBe(1 * 256 + 0x23); // odd length: first nibble alone, then 0x23
  });

  it('offsets lists, mask, special_values, out-of-memory reads and the synthetic platform', () => {
    const json: Json = {
      _fileformat: 0.5,
      _metadata: { version: 1, roms: ['x'], ramsize: 8, endian: 'big' },
      last_game: [
        { encoding: 'bcd', offsets: ['0x3', '0x0', '0x1'] },
        { encoding: 'bcd', start: 20, length: 2 },
      ],
      game_state: {
        credits: { encoding: 'int', start: 4, mask: '0x0F' },
        current_ball: { encoding: 'int', start: 5, special_values: { '255': 0, '7': 'OFF' } },
      },
    };
    const map = compileMap(json, () => null);
    expect(map.platform.name).toBe('auto-generated');
    const st = decodeGameState(map, Uint8Array.from([0x34, 0x56, 0x00, 0x12, 0xf9, 0xff, 0, 0]));
    expect(st.scores).toEqual([123456, null]);
    expect(st.credits).toBe(9);
    expect(st.currentBall).toBe(0);
    expect(decodeGameState(map, Uint8Array.from([0x34, 0x56, 0x00, 0x12, 0xf9, 0x07, 0, 0])).currentBall).toBe(7);
  });

  it('ch with char_map, null policy and default; enum via shared values', () => {
    const map = mapWith(
      {
        mode: { encoding: 'enum', start: 6, values: 'modes' },
        other: { encoding: 'enum', start: 7, values: ['a', 'b'] },
      },
      {
        high_scores: [
          { label: 'GC', initials: { encoding: 'ch', start: 0, length: 3 }, score: { encoding: 'bcd', start: 3, length: 3 } },
        ],
      },
      platformBig,
      { values: { modes: ['x', 'y', 'z'] } },
    );
    const nv = Uint8Array.from([0x41, 0x42, 0x43, 0x00, 0x00, 0x99, 0x02, 0x05]);
    expect(decodeHighScores(map, nv)).toEqual([{ label: 'GC', shortLabel: null, initials: 'ABC', score: 99 }]);
    const mem = new NvMemory(map.platform, nv);
    expect(descriptorEnum(mem, { encoding: 'enum', start: 6, values: 'modes' }, map)).toBe('z');
    expect(descriptorEnum(mem, { encoding: 'enum', start: 7, values: ['a', 'b'] }, map)).toBe('?5');

    // default initials read as "no entry"; nulls terminate when asked to
    expect(descriptorString(mem, { encoding: 'ch', start: 3, length: 2, default: '' }, map)).toBe(null);
    expect(descriptorString(mem, { encoding: 'ch', start: 0, length: 5, null: 'terminate' }, map)).toBe('ABC');
    expect(descriptorString(mem, { encoding: 'ch', start: 0, length: 5 }, map)).toBe('ABC');

    const mapped = mapWith({}, {}, platformBig, { char_map: ' ABCDEFGHIJKLMNOPQRSTUVWXYZ' });
    const mem2 = new NvMemory(mapped.platform, Uint8Array.from([1, 2, 3]));
    expect(descriptorString(mem2, { encoding: 'ch', start: 0, length: 3 }, mapped)).toBe('ABC');
  });

  it('toInt accepts numbers, decimal and hex strings; sameGame compares the fields that matter', () => {
    expect(toInt(12)).toBe(12);
    expect(toInt('0x1786')).toBe(0x1786);
    expect(toInt('42')).toBe(42);
    expect(toInt(undefined, 7)).toBe(7);
    expect(() => toInt('abc')).toThrow();
    const a = decodeGameState(mapWith({ scores: [{ encoding: 'bcd', start: 0 }] }), Uint8Array.from([0x10]));
    const b = decodeGameState(mapWith({ scores: [{ encoding: 'bcd', start: 0 }] }), Uint8Array.from([0x10]));
    const c = decodeGameState(mapWith({ scores: [{ encoding: 'bcd', start: 0 }] }), Uint8Array.from([0x11]));
    expect(sameGame(a, b)).toBe(true);
    expect(sameGame(a, c)).toBe(false);
  });
});

describe('gameStateOffsets', () => {
  it('lists every byte decodeGameState reads for mm_109c, sorted and unique, and covers the score bytes', async () => {
    const map = await corpus.mapFor('mm_109c');
    if (!map) throw new Error('no map');
    const offs = gameStateOffsets(map);
    expect(offs.length).toBeGreaterThan(10);
    expect(offs.length).toBeLessThan(200); // a WPC .nv is 12,334 bytes; the game state is a sliver of it
    expect([...offs].sort((a, b) => a - b)).toEqual(offs);
    expect(new Set(offs).size).toBe(offs.length);
    // Player 1's score lives at 5792..5796 (the fixtures poke those bytes), player_count at 5901.
    for (const b of [5792, 5793, 5794, 5795, 5796, 5901]) expect(offs).toContain(b);
  });

  it('tftc_400 (offsets lists) is covered too', async () => {
    const map = await corpus.mapFor('tftc_400');
    if (!map) throw new Error('no map');
    const offs = gameStateOffsets(map);
    expect(offs.length).toBeGreaterThan(5);
    expect(offs.every((o) => Number.isInteger(o) && o >= 0 && o < 8238)).toBe(true);
  });
});
