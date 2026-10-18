/**
 * The post decision for one VPX session, as a pure function, mirroring the rules ArcAid's cabinet
 * Witness applies before it posts (ADR 0022 §5, `VpxScoreIngestService`):
 *
 * - Player 1 only. A game with more than one player is skipped whole: the device knows one
 *   paired account and cannot say who played the other balls.
 * - Only real games: a session too short to contain one, or whose `.nv` game state did not
 *   change (VPinMAME rewrites the file on every exit), posts nothing.
 * - `reason=exit_sample`: basic mode reads one score when the player leaves and has no game
 *   start of its own, so `started` is the SESSION launch, a bound rather than a measurement. The
 *   server stores `sample='exit'` on the game observation and will not call it `flagged`
 *   (ADR 0022 addendum, v2.158.0). `restarts` and `partial` are launcher-side facts basic mode
 *   cannot know and are not sent; `via` is omitted (= live: the device watched the session).
 */
import { hasScores, sameGame, type CompiledMap, type GameState } from './maps.js';

export const MIN_SESSION_SEC = 20;
export const EXIT_SAMPLE_REASON = 'exit_sample';

export interface CaptureInput {
  table: string;
  /** ROM whose `.nv` changed, or null when none did. */
  rom: string | null;
  map: CompiledMap | null;
  /** Game state decoded from the `.nv` as it was at launch (null when the file did not exist). */
  before: GameState | null;
  /** Game state decoded from the `.nv` after the exit. */
  after: GameState | null;
  launchedAtMs: number;
  exitedAtMs: number;
}

export type CaptureDecision =
  | { kind: 'skip'; players: number; score: number | null; detail: string }
  | { kind: 'score'; players: 1; score: number; reason: typeof EXIT_SAMPLE_REASON; gameOver: boolean | null; detail?: string };

/**
 * How many people played the last game: the larger of "players with a nonzero score" and the
 * ROM's own `player_count` when it is plausible (1–4; Data East clears it to 0 at game over).
 */
export function countPlayers(state: GameState): number {
  const nonzero = state.scores.filter((s) => s !== null && s > 0).length;
  const pc = state.playerCount !== null && state.playerCount >= 1 && state.playerCount <= 4 ? state.playerCount : 0;
  return Math.max(nonzero, pc);
}

export function decideCapture(input: CaptureInput): CaptureDecision {
  const skip = (detail: string, players = 0, score: number | null = null): CaptureDecision => ({ kind: 'skip', players, score, detail });

  if (!input.rom) return skip('no .nv changed: the table has no ROM (original) or VPinMAME did not write one');
  if (!input.map) return skip(`no map for ROM ${input.rom} in the maps corpus`);
  if (!hasScores(input.map)) return skip(`map for ${input.rom} has no game_state scores`);
  if (!input.after) return skip(`could not decode ${input.rom}.nv`);

  const after = input.after;
  const players = countPlayers(after);
  const score = after.scores[0] ?? null;

  if (input.before && sameGame(input.before, after)) return skip('no new game: the .nv was rewritten but the game state is unchanged', players, score);
  if (players > 1) return skip(`multi-player game (${players} players): not attributable to one account`, players, score);
  if (players === 0 || score === null || score <= 0) return skip('no game played (player 1 score is 0)', players, score);

  const durationSec = Math.round((input.exitedAtMs - input.launchedAtMs) / 1000);
  if (durationSec < MIN_SESSION_SEC) return skip(`session too short to contain a game (${durationSec} s)`, players, score);

  return {
    kind: 'score',
    players: 1,
    score,
    reason: EXIT_SAMPLE_REASON,
    gameOver: after.gameOver,
    ...(after.gameOver === false ? { detail: 'exited mid-game; score as of the exit' } : {}),
  };
}
