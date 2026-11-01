import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readJournalLines } from './journal-replay.js';
import { ballyTransition, detectTransition, JournalDetector, plausible, replayDetector, samTransition, type GameEvent, type JournalEvent } from './journal-detector.js';
import { ballyLiveInputs, createMapCorpus, decodeFinalScores, decodeGameState, descriptorOffsets, gameStateOffsets, type CompiledMap, type GameState, type JsonObject } from './maps.js';
import { engineSlope } from './attestation-types.js';

const repo = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const corpus = createMapCorpus(repo('fixtures/maps'));

interface Meta {
  recipe: string;
  rom: string | null;
  games: number;
  balls_per_game?: number;
}

const FIXTURES = [
  'fixtures/nvram/mm_109c/2026-10-17-1',
  'fixtures/nvram/tftc_400/2026-10-17-1',
  'fixtures/script/iron-maiden-lotb/2026-10-17-1',
  // Gottlieb System 3 (owner's rig, 2026-11-01): the ball byte is cleared 3.5 s before game over; `lastInPlay` ends the game.
  'fixtures/nvram/cueball/2026-11-01-1',
];

async function mapLookup(): Promise<(rom: string) => CompiledMap | null> {
  const maps = new Map<string, CompiledMap | null>();
  for (const rom of ['mm_109c', 'tftc_400', 'mb_106b', 'cueball']) maps.set(rom, await corpus.mapFor(rom));
  return (rom) => maps.get(rom) ?? null;
}

function loadFixture(base: string): { lines: string[]; meta: Meta } {
  const meta = JSON.parse(readFileSync(repo(base + '.meta.json'), 'utf8')) as Meta & { journal_file: string };
  const journal = repo(base.slice(0, base.lastIndexOf('/') + 1) + meta.journal_file);
  return { lines: readJournalLines(journal), meta };
}

const games = (events: JournalEvent[]) => events.filter((e): e is GameEvent => ['game_start', 'current_scores', 'ball_end', 'game_end', 'game_abandoned'].includes(e.kind));
const ofKind = <K extends GameEvent['kind']>(events: JournalEvent[], kind: K) => games(events).filter((e): e is Extract<GameEvent, { kind: K }> => e.kind === kind);

/**
 * The same gate `fixtures/check.py` applies to the Python oracle, per fixture:
 * game_start == games, ball_end == balls_per_game * games, game_end == games, balls ending == 1..n.
 */
describe('engine line (hook 0.4.0)', () => {
  it('decodes the sample (GlobalDifficulty 0–100 → 0–1), nulls a failed read, and keeps a missing nudge block null', () => {
    const d = new JournalDetector();
    d.feed('{"event":"table_loaded","t":0,"table":"T","recipe":"A","rom":"mb_106b","lib":"0.4.0","session":"s","locked":false}');
    const [ev] = d.feed('{"event":"engine","t":0.5,"reason":"init","difficulty":20.0000,"slope_min":6.5000,"slope_max":6.5000,"physics_set":0,"gravity":0.9700,"friction":0.0750,"elasticity":0.2500,"elasticity_falloff":0.0000,"scatter":null,"nudge_time":5.0000,"nudge":{"xmax":700,"ymax":700,"xgain":115,"ygain":115,"dead_zone":0,"tilt":400}}');
    expect(ev).toMatchObject({ kind: 'engine', t: 0.5, sample: { reason: 'init', difficulty: 0.2, slopeMin: 6.5, physicsSet: 0, scatter: null, nudge: { tilt: 400, xgain: 115, deadZone: 0 } } });
    const [bare] = d.feed('{"event":"engine","t":9,"reason":"key","difficulty":80,"nudge":null}');
    expect(bare).toMatchObject({ kind: 'engine', sample: { reason: 'key', difficulty: 0.8, slopeMin: null, nudge: null } });
  });
});

describe('the recorded fixtures replay like the Python oracle (and the System 3 one the oracle has no rules for)', () => {
  for (const base of FIXTURES) {
    it(base, async () => {
      const { lines, meta } = loadFixture(base);
      const { events, detector } = replayDetector(lines, { mapFor: await mapLookup() });
      const perGame = meta.balls_per_game ?? 3;
      const summary = detector.summary();
      expect(summary).not.toBeNull();
      if (!summary) return;
      expect(summary.recipe).toBe(meta.recipe);
      expect(summary.rom).toBe(meta.rom);
      expect(summary.counts.game_start).toBe(meta.games);
      expect(summary.counts.ball_end).toBe(perGame * meta.games);
      expect(summary.counts.game_end).toBe(meta.games);
      expect(summary.counts.game_abandoned).toBe(0);
      expect(summary.ballsSeen).toEqual(Array.from({ length: perGame }, (_, i) => i + 1));
      expect(summary.exited).toBe(true);
      expect(summary.inGame).toBe(false);
      expect(summary.torn).toBe(0);
      // Events arrive in play order: every game is start, three ball ends, end.
      const order = games(events).filter((e) => e.kind !== 'current_scores').map((e) => e.kind);
      expect(order).toEqual(Array.from({ length: meta.games }, () => ['game_start', 'ball_end', 'ball_end', 'ball_end', 'game_end']).flat());
    });
  }

  it('mm_109c: two games (277,500 then 1,089,510), nothing derived from the boot-time RAM test', async () => {
    const { lines } = loadFixture(FIXTURES[0]);
    const { events, detector } = replayDetector(lines, { mapFor: await mapLookup() });
    expect(ofKind(events, 'game_end').map((e) => e.scores[0])).toEqual([277500, 1089510]);
    // The WPC RAM test fills NVRAM with 0x55 / 0xAA for the first ~10 s; the first real event is
    // the owner's hand-played game_start at t≈169 s.
    const first = games(events)[0];
    expect(first.kind).toBe('game_start');
    expect(first.t).toBeGreaterThan(100);
    expect(detector.summary()?.lines.nvram_full).toBe(16);
    expect(detector.summary()?.lines.nvram_delta).toBe(77547);
    expect(detector.summary()?.orphanDeltas).toBe(1); // the first delta precedes the first nvram_full
  });

  it('tftc_400 (Data East): one game, 2,318,430; ball ends carry the ended ball and player 1', async () => {
    const { lines } = loadFixture(FIXTURES[1]);
    const { events } = replayDetector(lines, { mapFor: await mapLookup() });
    expect(ofKind(events, 'game_end')[0].scores[0]).toBe(2318430);
    expect(ofKind(events, 'ball_end').map((e) => e.ball)).toEqual([1, 2, 3]);
  });

  it('iron maiden (recipe B script events): 206 score updates, bonus lands after ball_end', () => {
    const { lines } = loadFixture(FIXTURES[2]);
    const { events, detector } = replayDetector(lines);
    expect(detector.summary()?.counts.current_scores).toBe(206);
    expect(ofKind(events, 'game_end')[0].scores[0]).toBe(384260);
    // Finding 3: the score at the last ball_end (259,760) is not the ball's final score.
    const lastBallEnd = ofKind(events, 'ball_end')[2];
    const atBallEnd = ofKind(events, 'current_scores').filter((e) => e.t < lastBallEnd.t).at(-1);
    expect(atBallEnd?.scores[0]).toBe(259760);
    expect(detector.wantsMapFor).toBeNull();
  });
});

describe('mb_106b: the hook-0.3.0 live-mode gate (2026-10-23, three table loads, five games)', () => {
  const BASE = 'fixtures/nvram/mb_106b/2026-10-23-1';

  it('every game is start, three ball ends, end, with its own score', async () => {
    const { lines, meta } = loadFixture(BASE);
    const { events, detector } = replayDetector(lines, { mapFor: await mapLookup() });
    expect(ofKind(events, 'game_end').map((e) => e.scores[0])).toEqual([19548230, 14959390, 48488530, 34055250, 144785330]);
    expect(ofKind(events, 'game_end')).toHaveLength(meta.games);
    const order = games(events).filter((e) => e.kind !== 'current_scores').map((e) => e.kind);
    expect(order).toEqual(Array.from({ length: meta.games }, () => ['game_start', 'ball_end', 'ball_end', 'ball_end', 'game_end']).flat());
    expect(ofKind(events, 'ball_end').map((e) => e.ball)).toEqual(Array.from({ length: meta.games }, () => [1, 2, 3]).flat());
    expect(ofKind(events, 'game_abandoned')).toHaveLength(0);
    // Hook 0.3.0 journals one snapshot per load and only the map's game_state bytes.
    expect(events.filter((e) => e.kind === 'table_loaded')).toHaveLength(3);
    expect(detector.summary()).toMatchObject({ exited: true, inGame: false, torn: 0, orphanDeltas: 0, lines: { nvram_full: 1 } });
  });

  it("the second load's boot race (player 1 / ball 1, then game over 59 ms later) does not end the last game again", async () => {
    const { lines } = loadFixture(BASE);
    const { events } = replayDetector(lines, { mapFor: await mapLookup() });
    const loads = events.flatMap((e, i) => (e.kind === 'table_loaded' ? [i] : []));
    const second = games(events.slice(loads[1], loads[2]));
    expect(second[0].kind).toBe('game_start');
    expect(second[0].t).toBeCloseTo(26.699, 3);
    expect(second.filter((e) => e.kind === 'game_end' && e.scores[0] === 48488530)).toHaveLength(0);
  });
});

describe('mm_109c 2026-10-25: hook 0.4.0 on real VPX (two games, one engine line)', () => {
  const BASE = 'fixtures/nvram/mm_109c/2026-10-25-1';

  it('two games with their scores, and the engine sample in the 0–1 difficulty the table file uses', async () => {
    const { lines, meta } = loadFixture(BASE);
    const { events } = replayDetector(lines, { mapFor: await mapLookup() });
    expect(ofKind(events, 'game_end').map((e) => e.scores[0])).toEqual([16814490, 19643660]);
    const order = games(events).filter((e) => e.kind !== 'current_scores').map((e) => e.kind);
    expect(order).toEqual(Array.from({ length: meta.games }, () => ['game_start', 'ball_end', 'ball_end', 'ball_end', 'game_end']).flat());
    const engine = events.filter((e): e is Extract<JournalEvent, { kind: 'engine' }> => e.kind === 'engine');
    expect(engine).toHaveLength(1);
    // The table file says 0.5; VPX's GlobalDifficulty said 50 (0.2.12 showed "difficulty 5000%").
    expect(engine[0].sample).toMatchObject({ reason: 'init', difficulty: 0.5, slopeMin: 6.5, slopeMax: 6.5, physicsSet: 0, nudge: { tilt: 300 } });
    expect(engineSlope(engine[0].sample)).toBe(6.5);
  });

  it('a table with a slope range: Monster Bash live 56 on 6–7° is 6.56°, not 62°', () => {
    const d = new JournalDetector();
    d.feed('{"event":"table_loaded","t":0,"table":"T","recipe":"A","rom":"mb_106b","lib":"0.4.0","session":"s","locked":false}');
    const [eng] = d.feed('{"event":"engine","t":0.03,"reason":"init","difficulty":56.0000,"slope_min":6.0000,"slope_max":7.0000,"physics_set":0}');
    expect(eng.kind === 'engine' && engineSlope(eng.sample)).toBeCloseTo(6.56, 6);
  });
});

describe('Stern SAM: games from NVRAM alone (B10, owner\'s rig 2026-10-25/26)', () => {
  const samLookup = async () => {
    const maps = new Map<string, CompiledMap | null>();
    for (const rom of ['acd_170h', 'twd_160h']) maps.set(rom, await corpus.mapFor(rom));
    return (rom: string) => maps.get(rom) ?? null;
  };
  const order = (events: JournalEvent[]) => games(events).filter((e) => e.kind !== 'current_scores').map((e) => e.kind);

  it('acd_170h: three games end with their scores (the third a 2-player game), the fourth is abandoned at exit', async () => {
    const { lines } = loadFixture('fixtures/nvram/acd_170h/2026-10-25-1');
    const { events, detector } = replayDetector(lines, { mapFor: await samLookup() });
    expect(order(events)).toEqual(['game_start', 'game_end', 'game_start', 'game_end', 'game_start', 'game_end', 'game_start', 'game_abandoned']);
    const ends = ofKind(events, 'game_end');
    expect(ends.map((e) => e.scores.slice(0, e.players ?? 1))).toEqual([[20030090], [4518000], [2675390, 10649390]]);
    expect(ends.map((e) => e.players)).toEqual([1, 1, 2]);
    expect(detector.summary()).toMatchObject({ exited: true, inGame: false, torn: 0, counts: { ball_end: 0 } });
  });

  it('twd_160h: a different score address, the same record; the quit game posts nothing', async () => {
    const { lines } = loadFixture('fixtures/nvram/twd_160h/2026-10-26-1');
    const { events } = replayDetector(lines, { mapFor: await samLookup() });
    expect(order(events)).toEqual(['game_start', 'game_end', 'game_start', 'game_end', 'game_start', 'game_abandoned']);
    const ends = ofKind(events, 'game_end');
    expect(ends.map((e) => e.scores.slice(0, e.players ?? 1))).toEqual([[8853730], [2275720, 5470620]]);
    expect(ofKind(events, 'game_start').map((e) => e.t)).toEqual([expect.closeTo(8.76, 1), expect.closeTo(146.12, 1), expect.closeTo(306.57, 1)]);
    expect(ofKind(events, 'game_abandoned')[0].scores[0]).toBe(608660);
  });

  it('only the watched bytes (what an imported table journals) give the same games', async () => {
    const lookup = await samLookup();
    const map = lookup('twd_160h');
    if (!map) throw new Error('no map');
    const watch = new Set(gameStateOffsets(map));
    const { lines } = loadFixture('fixtures/nvram/twd_160h/2026-10-26-1');
    const filtered = lines.flatMap((l) => {
      if (!l.includes('"nvram_delta"')) return [l];
      const e = JSON.parse(l) as { t: number; d: [number, number, number][] };
      const d = e.d.filter(([o]) => watch.has(o));
      return d.length ? [JSON.stringify({ event: 'nvram_delta', t: e.t, n: d.length, d })] : [];
    });
    const { events } = replayDetector(filtered, { mapFor: lookup });
    expect(ofKind(events, 'game_end').map((e) => e.scores[0])).toEqual([8853730, 2275720]);
    expect(filtered.length).toBeLessThan(lines.length / 2);
  });
});

describe('samTransition (pure)', () => {
  const sam = (scores: number[], playerCount = 1) => state({ scores, playerCount, currentBall: null, currentPlayer: null, gameOver: null });

  it('a restart from the start button mid-game abandons the open game, then starts', () => {
    expect(samTransition(sam([5000, 0, 0, 0]), sam([0, 0, 0, 0]), 7, 7, true, 1).map((e) => e.kind)).toEqual(['game_abandoned', 'game_start']);
  });

  it('a fresh NVRAM (no last game) starts at the first points; a counter rise with no game open is ignored', () => {
    expect(samTransition(sam([0, 0, 0, 0]), sam([10, 0, 0, 0]), 0, 0, false, 1).map((e) => e.kind)).toEqual(['game_start']);
    expect(samTransition(sam([10, 0, 0, 0]), sam([10, 0, 0, 0]), 4, 5, false, 1)).toEqual([]);
  });

  it('a counter jump that cannot be one game (a reset NVRAM) ends nothing', () => {
    expect(samTransition(sam([10, 0, 0, 0]), sam([10, 0, 0, 0]), 4, 900, true, 1)).toEqual([]);
  });
});

describe('map attached late (the corpus answers asynchronously)', () => {
  it('deltas before setMap still patch the shadow buffer; decoding starts when the map lands', async () => {
    const { lines } = loadFixture(FIXTURES[1]);
    const detector = new JournalDetector();
    const events: JournalEvent[] = [];
    const lookup = await mapLookup();
    for (const line of lines) {
      events.push(...detector.feed(line));
      if (detector.wantsMapFor && detector.summary()?.lines.nvram_delta === 500) {
        // Half a thousand deltas in (still in attract mode), the map arrives.
        detector.setMap(lookup(detector.wantsMapFor));
      }
    }
    expect(detector.wantsMapFor).toBeNull();
    expect(ofKind(events, 'game_end')[0].scores[0]).toBe(2318430);
    expect(detector.summary()?.ballsSeen).toEqual([1, 2, 3]);
  });
});

describe('a player who quits mid-game', () => {
  it('recipe A: table_exit with a ball in play yields game_abandoned with the live scores', async () => {
    const { lines } = loadFixture(FIXTURES[1]);
    const detector = new JournalDetector({ mapFor: await mapLookup() });
    const events: JournalEvent[] = [];
    let ballEnds = 0;
    for (const line of lines) {
      const out = detector.feed(line);
      events.push(...out);
      ballEnds += out.filter((e) => e.kind === 'ball_end').length;
      if (ballEnds === 1) break; // on ball 2 now
    }
    const tail = detector.feed('{"event":"table_exit","t":100,"lines":1,"nvram_callbacks":1,"blocked_keys":0}');
    expect(tail.map((e) => e.kind)).toEqual(['game_abandoned', 'table_exit']);
    const abandoned = tail[0] as Extract<GameEvent, { kind: 'game_abandoned' }>;
    expect(abandoned.ball).toBe(2);
    expect(abandoned.player).toBe(1);
    expect(abandoned.scores[0]).toBeGreaterThan(0);
    expect(detector.summary()?.inGame).toBe(false);
    expect(detector.summary()?.counts.game_end).toBe(0);
  });

  it('script recipe: the last current_scores names the player and ball that were up', () => {
    const { lines } = loadFixture(FIXTURES[2]);
    const detector = new JournalDetector();
    for (const line of lines) {
      const out = detector.feed(line);
      if (out.some((e) => e.kind === 'ball_end')) break;
    }
    const tail = detector.feed('{"event":"table_exit","t":100,"lines":1,"nvram_callbacks":0,"blocked_keys":0}');
    expect(tail[0]).toMatchObject({ kind: 'game_abandoned', player: 1, ball: 1 });
    expect((tail[0] as Extract<GameEvent, { kind: 'game_abandoned' }>).scores[0]).toBe(1980);
  });

  it('a session that ended cleanly abandons nothing at exit', () => {
    const { lines } = loadFixture(FIXTURES[2]);
    const { detector } = replayDetector(lines);
    expect(detector.summary()?.counts.game_abandoned).toBe(0);
  });
});

function state(partial: Partial<GameState>): GameState {
  return {
    scores: [0, 0, 0, 0],
    playerCount: 1,
    currentPlayer: 1,
    currentBall: 1,
    gameOver: false,
    ballCount: 3,
    extraBalls: 0,
    credits: 0,
    other: {},
    ...partial,
  };
}

describe('detectTransition (pure)', () => {
  it('an extra ball (extra_balls decrements, ball and player unchanged) fires no ball_end', () => {
    const prev = state({ currentBall: 2, extraBalls: 1, scores: [1000, 0, 0, 0] });
    const cur = state({ currentBall: 2, extraBalls: 0, scores: [1000, 0, 0, 0] });
    expect(detectTransition(prev, cur, 10)).toEqual([]);
  });

  it('ball 0 between games never ends; game over from ball 0 is not a game end', () => {
    const prev = state({ currentBall: 0 });
    expect(detectTransition(prev, state({ currentBall: 0, gameOver: true }), 1)).toEqual([]);
    expect(detectTransition(prev, state({ currentBall: 1 }), 1)).toEqual([]);
  });

  it('player change in a 2-player game ends the previous player\'s ball', () => {
    const prev = state({ playerCount: 2, currentPlayer: 1, currentBall: 1 });
    const cur = state({ playerCount: 2, currentPlayer: 2, currentBall: 1 });
    expect(detectTransition(prev, cur, 5)).toEqual([{ kind: 'ball_end', t: 5, player: 1, ball: 1, extraBalls: 0 }]);
  });

  it('game over with a ball in play: ball_end then game_end with the final scores', () => {
    const prev = state({ currentBall: 3, scores: [5000, 0, 0, 0] });
    const cur = state({ currentBall: 3, gameOver: true, scores: [7000, 0, 0, 0] });
    expect(detectTransition(prev, cur, 9).map((e) => e.kind)).toEqual(['ball_end', 'game_end', 'current_scores']);
  });

  it('the WPC RAM-test pattern (player 85 / 170) is implausible and fires nothing', () => {
    expect(plausible(state({ currentPlayer: 85 }))).toBe(false);
    expect(plausible(state({ currentPlayer: 170, currentBall: 170 }))).toBe(false);
    expect(plausible(state({ scores: [1.5, 0, 0, 0] }))).toBe(false);
    expect(plausible(state({}))).toBe(true);
    expect(detectTransition(state({ gameOver: true }), state({ currentPlayer: 85 }), 1)).toEqual([]);
  });
});

describe('torn and foreign lines', () => {
  it('counts torn lines, ignores unknown events, and nothing happens before table_loaded', () => {
    const d = new JournalDetector();
    expect(d.feed('{"event":"lock","t":1,"locked":true}')).toEqual([]);
    expect(d.feed('{"event":"nvram_del')).toEqual([]);
    expect(d.feed('{"event":"table_loaded","t":0,"table":"T","recipe":"B","rom":"","lib":"0.1.0","session":"s","locked":false}')).toHaveLength(1);
    expect(d.feed('{"event":"something_new","t":2}')).toEqual([]);
    expect(d.feed('{"event":"lock","t":3,"locked":true}')).toEqual([{ kind: 'lock', t: 3, locked: true }]);
    expect(d.feed('not json')).toEqual([]);
    expect(d.summary()).toMatchObject({ torn: 2, rom: null, recipe: 'B', lines: { table_loaded: 1, something_new: 1, lock: 1 } });
  });
});

describe('hook events the detector passes through', () => {
  it('embedded_patch (hook 0.4.1, C10): the patch ran from the table\'s own script', () => {
    const d = new JournalDetector();
    expect(d.feed('{"event":"table_loaded","t":0,"table":"MB","recipe":"A","rom":"mb_106b","lib":"0.4.1","session":"2026-10-29T10:00:00","locked":false}')).toEqual([expect.objectContaining({ kind: 'table_loaded' })]);
    expect(d.feed('{"event":"embedded_patch","t":0.512,"original":"C:\\\\Tables\\\\MB.vpx"}')).toEqual([{ kind: 'embedded_patch', t: 0.512, original: 'C:\\Tables\\MB.vpx' }]);
    expect(d.feed('{"event":"stale_sidecar","t":0.6,"detail":"size 1 vs 2","original":"x"}')).toEqual([{ kind: 'stale_sidecar', t: 0.6, detail: 'size 1 vs 2' }]);
  });
});

// ------------------------------------------------------------- B10.2: Bally / Stern M100 and Gottlieb System 3 --

/** NVRAM region base of a compiled map (journal offsets count from it). */
const nvBase = (map: CompiledMap) => map.platform.layout.find((r) => r.type === 'nvram')?.address ?? 0;

/**
 * Write a BCD score the way the machine shows it: on a nibble platform (Bally / Stern M100: one digit per
 * byte in the high nibble, little-endian) at least `00` with blank (0xF) leading digits; null blanks the
 * whole display. On a byte platform (System 3) packed BCD, big-endian.
 */
function putScore(map: CompiledMap, buf: Uint8Array, entry: JsonObject, value: number | null): void {
  const offs = descriptorOffsets(entry).map((a) => a - nvBase(map));
  const region = map.platform.layout.find((r) => r.type === 'nvram');
  const nibble = region?.nibble ?? 'both';
  const little = map.platform.endian === 'little';
  const order = little ? offs : [...offs].reverse(); // least significant first
  if (nibble === 'both') {
    let v = value ?? 0;
    for (const o of order) {
      buf[o] = ((Math.floor(v / 10) % 10) << 4) | (v % 10);
      v = Math.floor(v / 100);
    }
    return;
  }
  const digits = value === null ? 0 : Math.max(2, String(value).length);
  order.forEach((o, i) => {
    const d = i < digits ? Math.floor((value ?? 0) / 10 ** i) % 10 : 0xf;
    buf[o] = nibble === 'high' ? (d << 4) | (buf[o]! & 0x0f) : (buf[o]! & 0xf0) | d;
  });
}

/** Set a `bool` lamp descriptor so it decodes as `on` (honours `mask`, `invert` and the high nibble). */
function putBool(map: CompiledMap, buf: Uint8Array, entry: JsonObject, on: boolean): void {
  const o = (descriptorOffsets(entry)[0] as number) - nvBase(map);
  const nibble = map.platform.layout.find((r) => r.type === 'nvram')?.nibble ?? 'both';
  let bit = Number(entry['mask'] ?? 0xff);
  if (nibble === 'high') bit <<= 4;
  const raw = entry['invert'] === true ? !on : on;
  buf[o] = raw ? buf[o]! | bit : buf[o]! & ~bit;
}

/** A synthetic recipe-A journal: one baseline snapshot, then one delta line per changed buffer. */
class Journal {
  readonly lines: string[] = [];
  private last: Uint8Array;
  private t = 1;
  constructor(rom: string, readonly buf: Uint8Array) {
    this.lines.push(JSON.stringify({ event: 'table_loaded', t: 0, table: rom, recipe: 'A', rom, lib: '0.5.0', session: 's', locked: false }));
    this.lines.push(JSON.stringify({ event: 'nvram_full', t: 0.5, bytes: [...buf] }));
    this.last = Uint8Array.from(buf);
  }
  /** Journal what changed since the last line (the hook's `nvram_delta` triples: index, new, old). */
  step(): this {
    const d: [number, number, number][] = [];
    for (let i = 0; i < this.buf.length; i++) if (this.buf[i] !== this.last[i]) d.push([i, this.buf[i]!, this.last[i]!]);
    if (d.length) this.lines.push(JSON.stringify({ event: 'nvram_delta', t: this.t++, n: d.length, d }));
    this.last = Uint8Array.from(this.buf);
    return this;
  }
  exit(): string[] {
    return [...this.lines, JSON.stringify({ event: 'table_exit', t: this.t++, lines: this.lines.length, nvram_callbacks: 1, blocked_keys: 0 })];
  }
}

const kinds = (events: JournalEvent[]) => games(events).filter((e) => e.kind !== 'current_scores').map((e) => e.kind);

describe('Bally AS-2518-35 and Stern M100: games from the lamp and the last-game scores (B10.2, synthetic)', () => {
  const lookup = async (rom: string) => {
    const map = await corpus.mapFor(rom);
    if (!map) throw new Error(`no map for ${rom}`);
    return map;
  };

  /** A machine in attract after a game of `last` points: GAME OVER lit, displays and last-game scores alike. */
  const machine = (map: CompiledMap, last: number[]) => {
    const inputs = ballyLiveInputs(map);
    if (!inputs) throw new Error('not a Bally family map');
    const buf = new Uint8Array(0x100);
    const scores = map.gameState['scores']!;
    const show = (vals: (number | null)[], entries: JsonObject[]) => entries.forEach((e, i) => putScore(map, buf, e, vals[i] ?? null));
    const pad = (vals: number[]) => scores.map((_, i) => (i < vals.length ? vals[i]! : null));
    show(pad(last), scores);
    show(pad(last), inputs.finalScores);
    putBool(map, buf, inputs.lamp, true);
    return {
      buf,
      lamp: (on: boolean) => putBool(map, buf, inputs.lamp, on),
      displays: (vals: number[]) => show(pad(vals), scores),
      finals: (vals: number[]) => show(pad(vals), inputs.finalScores),
      /** The ROM's game-over copy spread over two callbacks: the low digits of player 1's last-game score, then the rest. */
      finalsInParts: (vals: number[], j: Journal) => {
        const done = Uint8Array.from(buf);
        pad(vals).forEach((v, i) => putScore(map, done, inputs.finalScores[i]!, v));
        const base = nvBase(map);
        for (const a of descriptorOffsets(inputs.finalScores[0]!).slice(0, 3)) buf[a - base] = done[a - base]!;
        j.step();
        buf.set(done);
        j.step();
      },
    };
  };

  for (const rom of ['eballdlx', 'stingray']) {
    it(`${rom}: the synthetic NVRAM decodes as intended (lamp, displays, last-game scores)`, async () => {
      const map = await lookup(rom);
      const m = machine(map, [734560]);
      let st = decodeGameState(map, m.buf);
      expect(st.gameOver).toBe(true);
      expect(st.scores).toEqual([734560, 0, 0, 0]);
      expect(st.currentBall).toBeNull(); // CPU RAM
      expect(plausible(st)).toBe(true);
      m.lamp(false);
      m.displays([0]);
      st = decodeGameState(map, m.buf);
      expect(st.gameOver).toBe(false);
      expect(st.scores).toEqual([0, 0, 0, 0]);
      expect(decodeFinalScores(map, m.buf)).toEqual([734560, 0, 0, 0]);
    });

    it(`${rom}: a 1-player game is start then end, with the last-game scores; a copy in parts ends it once`, async () => {
      const map = await lookup(rom);
      const m = machine(map, [734560]);
      const j = new Journal(rom, m.buf);
      m.lamp(false);
      j.step(); // the lamp first: the displays still show the last game, no start yet
      m.displays([0]);
      j.step(); // now a start
      m.displays([12000]);
      j.step();
      m.displays([87650]);
      j.step();
      m.lamp(true);
      j.step(); // GAME OVER lit, the last-game record not yet written
      m.finalsInParts([87650], j);
      const { events, detector } = replayDetector(j.exit(), { mapFor: (r) => (r === rom ? map : null) });
      expect(kinds(events)).toEqual(['game_start', 'game_end']);
      const end = ofKind(events, 'game_end')[0]!;
      expect(end).toMatchObject({ scores: [87650, 0, 0, 0], players: 1, t: 7 });
      expect(ofKind(events, 'current_scores').map((e) => e.scores[0])).toEqual([0, 12000, 87650]);
      expect(detector.summary()).toMatchObject({ inGame: false, counts: { ball_end: 0, game_abandoned: 0 } });
    });

    it(`${rom}: a 2-player game ends with both scores and 2 players; the displays clearing first also starts`, async () => {
      const map = await lookup(rom);
      const m = machine(map, [500000]);
      const j = new Journal(rom, m.buf);
      m.displays([0]);
      j.step(); // displays cleared with the lamp still lit: not yet
      m.lamp(false);
      j.step(); // start
      m.displays([0, 0]);
      j.step(); // player 2 added
      m.displays([31000, 64000]);
      j.step();
      m.lamp(true);
      j.step(); // the lamp first this time: the end waits for the last-game scores
      m.finals([31000, 64000]);
      j.step();
      const { events } = replayDetector(j.exit(), { mapFor: () => map });
      expect(kinds(events)).toEqual(['game_start', 'game_end']);
      expect(ofKind(events, 'game_end')[0]).toMatchObject({ scores: [31000, 64000, 0, 0], players: 2 });
    });

    it(`${rom}: a reset and new game mid-game abandons the first; table_exit abandons the second`, async () => {
      const map = await lookup(rom);
      const m = machine(map, [500000]);
      const j = new Journal(rom, m.buf);
      m.lamp(false);
      m.displays([0]);
      j.step();
      m.displays([3000]);
      j.step();
      m.lamp(true); // F3: the machine reboots into attract, the displays still show 3,000
      j.step();
      m.lamp(false);
      m.displays([0]);
      j.step();
      m.displays([40]);
      j.step();
      const { events } = replayDetector(j.exit(), { mapFor: () => map });
      expect(kinds(events)).toEqual(['game_start', 'game_abandoned', 'game_start', 'game_abandoned']);
      expect(ofKind(events, 'game_abandoned').map((e) => e.scores[0])).toEqual([3000, 40]);
      expect(ofKind(events, 'game_end')).toHaveLength(0);
    });

    it(`${rom}: an attract lamp flicker over the last game's scores starts nothing; the old record never re-posts`, async () => {
      const map = await lookup(rom);
      const m = machine(map, [734560]);
      const j = new Journal(rom, m.buf);
      for (let i = 0; i < 3; i++) {
        m.lamp(false);
        j.step();
        m.lamp(true);
        j.step();
      }
      m.displays([999990]); // the high score to date in the displays
      j.step();
      m.displays([734560]);
      j.step();
      const { events } = replayDetector(j.exit(), { mapFor: () => map });
      expect(kinds(events)).toEqual([]);
    });
  }

  it('ballyTransition (pure): displays at 0 mid-game with the lamp off are not a restart; the start\'s own record is not an end', () => {
    const f = (scores: number[], gameOver: boolean, finals: number[]) => ({ state: state({ scores, gameOver, currentBall: null, currentPlayer: null, playerCount: null }), finals });
    expect(ballyTransition(f([5000, 0, 0, 0], false, [100, 0, 0, 0]), f([0, 0, 0, 0], false, [100, 0, 0, 0]), true, [100, 0, 0, 0], 1)).toEqual([]);
    expect(ballyTransition(f([100, 0, 0, 0], false, [100, 0, 0, 0]), f([100, 0, 0, 0], true, [100, 0, 0, 0]), true, [100, 0, 0, 0], 1)).toEqual([]);
    expect(ballyTransition(f([100, 0, 0, 0], false, [100, 0, 0, 0]), f([100, 0, 0, 0], true, [100, 0, 0, 0]), true, [7, 0, 0, 0], 1).map((e) => e.kind)).toEqual(['game_end']);
    // A score past seven BCD digits cannot be a display: the state is rejected and nothing fires.
    expect(ballyTransition(f([0, 0, 0, 0], true, [1, 0, 0, 0]), f([1.5, 0, 0, 0], false, [1, 0, 0, 0]), false, null, 1)).toEqual([]);
  });

  it('the watched offsets (what an imported table journals) give the same game', async () => {
    const map = await lookup('eballdlx');
    const watch = new Set(gameStateOffsets(map));
    const m = machine(map, [734560]);
    const j = new Journal('eballdlx', m.buf);
    m.buf[0x80] = 0x55; // an audit byte nobody watches
    m.lamp(false);
    m.displays([0]);
    j.step();
    m.displays([87650]);
    j.step();
    m.finals([87650]);
    m.lamp(true);
    j.step();
    const filtered = j.exit().flatMap((l) => {
      if (!l.includes('"nvram_delta"')) return [l];
      const e = JSON.parse(l) as { t: number; d: [number, number, number][] };
      const d = e.d.filter(([o]) => watch.has(o));
      return d.length ? [JSON.stringify({ event: 'nvram_delta', t: e.t, n: d.length, d })] : [];
    });
    const { events } = replayDetector(filtered, { mapFor: () => map });
    expect(kinds(events)).toEqual(['game_start', 'game_end']);
    expect(ofKind(events, 'game_end')[0]?.scores[0]).toBe(87650);
  });
});

describe('Gottlieb System 3: the ball byte carries flags in its high nibble (masked 0x0F by default)', () => {
  /** Freddy / Cue Ball Wizard NVRAM (8 KB at 0x0000): ball byte 0x15, player 0x200, player count + game over 0x201, balls per game 0xD5F. */
  const run = (map: CompiledMap, rom: string) => {
    const buf = new Uint8Array(0x2000);
    buf[0xd5f] = 0x03;
    buf[0x15] = 0x70; // attract: ball 0 with the flag bits the owner's .nv files showed
    const p1 = map.gameState['scores']![0]!;
    putScore(map, buf, p1, 36898150);
    const j = new Journal(rom, buf);
    buf[0x201] = 1; // one player: game over goes off
    buf[0x15] = 0x71;
    putScore(map, buf, p1, 0);
    j.step();
    putScore(map, buf, p1, 120000);
    j.step();
    buf[0x15] = 0x72;
    j.step();
    putScore(map, buf, p1, 450000);
    buf[0x15] = 0x73;
    j.step();
    putScore(map, buf, p1, 910000);
    buf[0x201] = 0; // game over
    buf[0x15] = 0x70;
    j.step();
    return replayDetector(j.exit(), { mapFor: () => map });
  };

  for (const rom of ['freddy', 'cueball']) {
    it(`${rom}: a 3-ball game with the ball at 0x71..0x73 then 0x70 is start, three ball ends, end`, async () => {
      const map = (await corpus.mapFor(rom))!;
      const { events } = run(map, rom);
      expect(kinds(events)).toEqual(['game_start', 'ball_end', 'ball_end', 'ball_end', 'game_end']);
      expect(ofKind(events, 'ball_end').map((e) => e.ball)).toEqual([1, 2, 3]);
      expect(ofKind(events, 'game_end')[0]).toMatchObject({ scores: [910000, 0, 0, 0], players: 1 });
    });

    it(`${rom}: without the default mask the same journal is implausible throughout and fires nothing (the bug)`, async () => {
      const map = (await corpus.mapFor(rom))!;
      const unmasked: CompiledMap = { ...map, gameState: { ...map.gameState, current_ball: map.gameState['current_ball']!.map(({ mask: _m, ...e }) => e) } };
      const { events } = run(unmasked, rom);
      expect(kinds(events)).toEqual([]);
    });
  }
});
