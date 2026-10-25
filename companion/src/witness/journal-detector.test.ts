import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readJournalLines } from './journal-replay.js';
import { detectTransition, JournalDetector, plausible, replayDetector, type GameEvent, type JournalEvent } from './journal-detector.js';
import { createMapCorpus, type CompiledMap, type GameState } from './maps.js';
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
];

async function mapLookup(): Promise<(rom: string) => CompiledMap | null> {
  const maps = new Map<string, CompiledMap | null>();
  for (const rom of ['mm_109c', 'tftc_400', 'mb_106b']) maps.set(rom, await corpus.mapFor(rom));
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

describe('the three Phase 0 fixtures replay like the Python oracle', () => {
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
