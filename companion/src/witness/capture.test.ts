import { describe, expect, it } from 'vitest';
import { countPlayers, decideCapture, MIN_SESSION_SEC } from './capture.js';
import { compileMap, type CompiledMap, type GameState, type Json } from './maps.js';

const map: CompiledMap = compileMap(
  {
    _fileformat: 0.8,
    _metadata: { version: 1, roms: ['t'], platform: 'p' },
    game_state: { scores: [{ encoding: 'bcd', start: 0 }, { encoding: 'bcd', start: 1 }] },
  } satisfies Json,
  () => ({ endian: 'big', memory_layout: [{ address: 0, size: 16, type: 'nvram' }] }),
);
const scoreless: CompiledMap = compileMap({ _fileformat: 0.8, _metadata: { version: 1, roms: ['t'], platform: 'p' }, high_scores: [] } satisfies Json, () => null);

function state(scores: (number | null)[], extra: Partial<GameState> = {}): GameState {
  return {
    scores,
    playerCount: null,
    currentPlayer: null,
    currentBall: null,
    gameOver: true,
    ballCount: 3,
    extraBalls: null,
    credits: null,
    other: {},
    ...extra,
  };
}

const base = { table: 'T', rom: 'mm_109c', map, before: null, launchedAtMs: 1_000_000, exitedAtMs: 1_000_000 + 300_000 };

describe('decideCapture', () => {
  it('posts a one-player game as an exit sample', () => {
    const d = decideCapture({ ...base, after: state([1089510, 0, 0, 0], { playerCount: 1 }) });
    expect(d).toEqual({ kind: 'score', players: 1, score: 1089510, reason: 'exit_sample', gameOver: true });
  });

  it('notes a game that was still in progress at exit but still posts it', () => {
    const d = decideCapture({ ...base, after: state([4200, 0], { gameOver: false, currentBall: 2 }) });
    expect(d).toMatchObject({ kind: 'score', score: 4200, gameOver: false, detail: expect.stringMatching(/mid-game/) });
  });

  it('skips a multi-player game whole, by nonzero scores or by player_count', () => {
    expect(decideCapture({ ...base, after: state([100, 50, 0, 0]) })).toMatchObject({ kind: 'skip', players: 2, score: 100, detail: expect.stringMatching(/multi-player/) });
    expect(decideCapture({ ...base, after: state([100, 0, 0, 0], { playerCount: 3 }) })).toMatchObject({ kind: 'skip', players: 3 });
  });

  it('skips when nothing changed, when no game was played, and when the session is too short', () => {
    const after = state([1089510, 0, 0, 0], { playerCount: 1, currentBall: 3, currentPlayer: 1 });
    expect(decideCapture({ ...base, before: state([1089510, 0, 0, 0], { playerCount: 1, currentBall: 3, currentPlayer: 1 }), after })).toMatchObject({
      kind: 'skip',
      detail: expect.stringMatching(/no new game/),
    });
    expect(decideCapture({ ...base, before: state([277500, 0, 0, 0], { playerCount: 1, currentBall: 3, currentPlayer: 1 }), after })).toMatchObject({ kind: 'score' });
    expect(decideCapture({ ...base, after: state([0, 0, 0, 0], { playerCount: 0 }) })).toMatchObject({ kind: 'skip', players: 0, detail: expect.stringMatching(/no game played/) });
    expect(decideCapture({ ...base, after: state([null, null]) })).toMatchObject({ kind: 'skip', detail: expect.stringMatching(/no game played/) });
    expect(decideCapture({ ...base, exitedAtMs: base.launchedAtMs + (MIN_SESSION_SEC - 1) * 1000, after: state([500, 0]) })).toMatchObject({
      kind: 'skip',
      detail: expect.stringMatching(/too short/),
    });
  });

  it('skips when no .nv changed, when the ROM has no map, when the map has no scores, or decoding failed', () => {
    expect(decideCapture({ ...base, rom: null, map: null, after: null })).toMatchObject({ kind: 'skip', detail: expect.stringMatching(/no \.nv changed/) });
    expect(decideCapture({ ...base, map: null, after: null })).toMatchObject({ kind: 'skip', detail: 'no map for ROM mm_109c in the maps corpus' });
    expect(decideCapture({ ...base, map: scoreless, after: null })).toMatchObject({ kind: 'skip', detail: expect.stringMatching(/no game_state scores/) });
    expect(decideCapture({ ...base, after: null })).toMatchObject({ kind: 'skip', detail: 'could not decode mm_109c.nv' });
  });

  it('countPlayers takes the larger of nonzero scores and a plausible player_count', () => {
    expect(countPlayers(state([10, 0, 0, 0], { playerCount: 0 }))).toBe(1); // Data East clears it at game over
    expect(countPlayers(state([10, 20, 0, 0], { playerCount: 1 }))).toBe(2);
    expect(countPlayers(state([10, 0, 0, 0], { playerCount: 85 }))).toBe(1); // WPC boot garbage
    expect(countPlayers(state([0, 0, 0, 0], { playerCount: 4 }))).toBe(4);
  });
});
