/**
 * Result assembly: ranks from scores (competition ranking: ties share a rank, the next rank
 * skips), the winner (null on a tie for first) and the result-entry status of each player.
 * Pure functions over MatchState, shared by the host and by tests that check a RESULT.
 */
import type { PayloadOf, PlayerId } from '@castcade/protocol';
import type { MatchState, PlayerProgress } from './state.js';

export type ResultEntry = PayloadOf<'RESULT'>['entries'][number];

export function entryStatus(p: PlayerProgress): ResultEntry['status'] {
  if (p.status === 'forfeit') return p.connected ? 'forfeit' : 'disconnected';
  if (p.status === 'finished') return 'finished';
  return p.connected ? 'abandoned' : 'disconnected';
}

export function rankEntries(st: MatchState): ResultEntry[] {
  const players = st.playerOrder.map((id) => st.players[id]).filter((p): p is PlayerProgress => p !== undefined);
  return players.map((p) => ({
    playerId: p.playerId,
    score: p.score,
    ballsPlayed: p.ballsPlayed,
    status: entryStatus(p),
    rank: 1 + players.filter((o) => o.score > p.score).length,
  }));
}

export function pickWinner(entries: readonly ResultEntry[]): PlayerId | null {
  const first = entries.filter((e) => e.rank === 1);
  return first.length === 1 && first[0] ? first[0].playerId : null;
}

/** The object both LOG_SIGN and RESULT.hostSignature sign. */
export function logSignBody(matchId: string, logHash: string, logLength: number): { matchId: string; logHash: string; logLength: number } {
  return { matchId, logHash, logLength };
}

/** The object a RECONNECT signs with the participant's roster key (A2, 2026-10-30). */
export function reconnectSignBody(
  matchId: string,
  player: PlayerId,
  logHash: string,
  logLength: number,
): { matchId: string; player: PlayerId; logHash: string; logLength: number } {
  return { matchId, player, logHash, logLength };
}
