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
  samEndCounter,
  ballyLiveInputs,
  liveSupport,
  stripRomVersion,
  toInt,
  type Json,
} from './maps.js';

const repo = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const corpus = createMapCorpus(repo('fixtures/maps'));

/**
 * Ground truth for both fixtures comes from the reference implementation: the final shadow
 * buffer of each journal decoded with `py-pinmame-nvmaps` (`nvram_parser.py`, commit 00ea784)
 * against `pinmame-nvram-maps` f0c4220, i.e. what `vpx-hook/spike/tail-journal.py` reports at
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
    expect(await corpus.version()).toBe('f0c422099f0b50b69bfdf6d071a6653a8b25a6fd');
    expect(await corpus.mapFor('mm_109')).toBe(await corpus.mapFor('mm_109c'));
    expect(await corpus.mapFor('nope_123')).toBeNull();
    expect(await corpus.mapFor('MM_109c')).toBe(await corpus.mapFor('mm_109c')); // a script's cGameName may be capitalised
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

  it('Stern SAM: offsets count from NVRAM at 0x02100000, CPU-RAM fields are dropped, the end counter is added', async () => {
    const map = await corpus.mapFor('twd_160h');
    if (!map) throw new Error('no map');
    const offs = gameStateOffsets(map);
    expect(samEndCounter(map)).toBe(0x10a94);
    // Player 1's score 0x02110A9C (8 bytes), player count 0x02110900, the end counter 16 bytes before the score + 8.
    for (const b of [0x10a9c, 0x10aa3, 0x10900, 0x10a94, 0x10a97]) expect(offs).toContain(b);
    // Ball 0x00036135 and game over 0x00036166 are CPU RAM: the hook never sees them, so never watched.
    expect(offs.every((o) => o >= 0 && o < 0x20000)).toBe(true);
    expect(samEndCounter((await corpus.mapFor('mm_109c'))!)).toBeNull();
  });
});

describe('liveSupport (B12)', () => {
  it('WPC and Data East: all four live fields in NVRAM', async () => {
    for (const rom of ['mm_109c', 'tftc_400']) {
      expect(liveSupport(await corpus.mapFor(rom))).toMatchObject({ readable: true, via: 'game_state', absent: [], outside: [] });
    }
  });

  it('Stern SAM: ball, player and game over are CPU RAM, but scores and the end-of-game record qualify it', async () => {
    for (const rom of ['acd_170h', 'twd_160h']) {
      const s = liveSupport(await corpus.mapFor(rom));
      expect(s).toMatchObject({ readable: true, via: 'sam_end_counter' });
      expect(s.outside).toEqual(expect.arrayContaining(['current_ball', 'game_over']));
    }
  });

  it('a machine whose scores sit in CPU RAM is not readable, and the reason names the platform and the fields', async () => {
    const map = (await corpus.mapFor('mm_109c'))!;
    const moved = { ...map, platform: { ...map.platform, name: 'gottlieb-system80', layout: map.platform.layout.map((r) => (r.type === 'nvram' ? { ...r, address: 0x1800, size: 0x100 } : r)) } };
    const s = liveSupport(moved);
    expect(s.readable).toBe(false);
    expect(s.outside).toContain('scores');
    expect(s.reason).toMatch(/^gottlieb-system80: .*scores.* in CPU RAM/);
  });

  it('a map without a live field is not readable; no map at all says so', async () => {
    const map = (await corpus.mapFor('mm_109c'))!;
    const { current_ball: _ball, ...rest } = map.gameState;
    const s = liveSupport({ ...map, gameState: rest });
    expect(s).toMatchObject({ readable: false, absent: ['current_ball'] });
    expect(s.reason).toMatch(/no current_ball in the map/);
    expect(liveSupport(null)).toMatchObject({ readable: false, reason: 'no NVRAM map for this ROM' });
  });
});

describe('liveSupport: the families B10.2 / B10.3 looked at (vendored maps, fixtures/maps)', () => {
  it('Bally AS-2518-35 (Eight Ball Deluxe) and Stern M100: readable via the game-over lamp and the last-game scores', async () => {
    for (const [rom, platform] of [['eballdlx', 'bally-35-8K'], ['stingray', 'stern-m100']] as const) {
      const map = (await corpus.mapFor(rom))!;
      expect(map.platform.name).toBe(platform);
      const s = liveSupport(map);
      expect(s).toMatchObject({ readable: true, via: 'bally_lamp', absent: [] });
      expect(s.outside).toEqual(['current_ball', 'current_player']);
      expect(s.reason).toBe(`${platform}: scores, the game-over lamp and the last-game scores in NVRAM (unverified)`);
      expect(ballyLiveInputs(map)?.finalScores).toHaveLength(map.gameState['scores']!.length);
    }
  });

  it('the Bally detector needs the lamp and one last-game score per score, all in NVRAM', async () => {
    const map = (await corpus.mapFor('eballdlx'))!;
    const { game_over: _go, ...noLamp } = map.gameState;
    expect(liveSupport({ ...map, gameState: noLamp })).toMatchObject({ readable: false, via: null });
    expect(liveSupport({ ...map, gameState: { ...map.gameState, final_scores: map.gameState['final_scores']!.slice(0, 2) } }).readable).toBe(false);
    expect(liveSupport({ ...map, gameState: { ...map.gameState, game_over: [{ ...map.gameState['game_over']![0]!, start: '0x0C' }] } }).readable).toBe(false);
    // Another platform with the same fields is not this family (the rules are the Bally MPU's).
    expect(ballyLiveInputs({ ...map, platform: { ...map.platform, name: 'stern-m200' } })).toBeNull();
  });

  it('Eight Ball Deluxe: the hook watches the lamp, the displays and the last-game scores, nothing in CPU RAM', async () => {
    const map = (await corpus.mapFor('eballdlx'))!;
    const offs = gameStateOffsets(map);
    // Lamp 0x20C, player 1's display 0x21E..0x224, player 4's last-game score ends at 0x263; NVRAM starts at 0x200.
    for (const b of [0x0c, 0x1e, 0x24, 0x48, 0x63]) expect(offs).toContain(b);
    expect(offs.every((o) => o >= 0 && o < 0x100)).toBe(true);
  });

  it('Zaccaria gen 2, Gottlieb System 80 and Stern M200 stay unsupported, each with its reason', async () => {
    expect(liveSupport(await corpus.mapFor('dvlrider'))).toMatchObject({ readable: false, via: null, absent: ['game_over', 'current_ball', 'current_player'], outside: [] });
    const s80 = liveSupport(await corpus.mapFor('spirit'));
    expect(s80).toMatchObject({ readable: false, via: null, outside: ['scores', 'game_over', 'current_ball', 'current_player'] });
    expect(s80.reason).toBe('gottlieb-system80-1prom: scores, game_over, current_ball, current_player in CPU RAM');
    // M200 has its last-game scores in NVRAM, but the displays, the lamp, ball and player are CPU RAM.
    expect(liveSupport(await corpus.mapFor('cheetah'))).toMatchObject({ readable: false, via: null, outside: ['scores', 'game_over', 'current_ball', 'current_player'] });
  });
});

describe('Gottlieb System 3: current_ball and current_player read the low nibble unless the map masks them', () => {
  const ballFrom = async (rom: string, byte: number) => {
    const map = (await corpus.mapFor(rom))!;
    const nv = new Uint8Array(8238); // the size of a System 3 .nv on the owner's rig
    nv[0x15] = byte;
    return decodeGameState(map, nv).currentBall;
  };

  it('freddy and cueball (no mask in the map): 0x70 → 0, 0x90 → 0, 0x03 → 3, 0x31 → 1, 0x83 → 3', async () => {
    for (const rom of ['freddy', 'cueball']) {
      const got: (number | null)[] = [];
      for (const b of [0x70, 0x90, 0x03, 0x31, 0x83]) got.push(await ballFrom(rom, b));
      expect(got).toEqual([0, 0, 3, 1, 3]);
      const map = (await corpus.mapFor(rom))!;
      expect(map.gameState['current_ball']![0]!['mask']).toBe('0x0F');
      expect(liveSupport(map)).toMatchObject({ readable: true, via: 'game_state' });
    }
  });

  it("a map's own mask wins (Tee'd Off masks the ball 0x7F); other platforms are untouched", async () => {
    expect((await corpus.mapFor('teedoff3'))!.gameState['current_ball']![0]!['mask']).toBe('0x7F');
    expect(await ballFrom('teedoff3', 0x83)).toBe(3);
    expect((await corpus.mapFor('mm_109c'))!.gameState['current_ball']![0]!['mask']).toBeUndefined();
  });
});
