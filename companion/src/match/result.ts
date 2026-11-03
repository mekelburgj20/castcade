/**
 * Result assembly: ranks from scores (competition ranking: ties share a rank, the next rank
 * skips), the winner (null on a tie for first) and the result-entry status of each player.
 * Pure functions over MatchState, shared by the host and by tests that check a RESULT.
 */
import type { PayloadOf, PlayerId } from '@castcade/protocol';
import type { MatchState, PlayerProgress } from './state.js';

export type ResultEntry = PayloadOf<'RESULT'>['entries'][number];
export type SeriesEntry = PayloadOf<'RESULT'>['series'][number];

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

/**
 * A10 (2026-11-02): the series standings over every game in `games` (each game's ranked entries, oldest first): per
 * player the games played, the outright wins (a tie for first wins nobody the game, as `winner` is null then) and the
 * total score; ranked by wins, then total score (competition ranking). Players in roster order of first appearance.
 */
export function seriesStandings(games: readonly { entries: readonly ResultEntry[] }[]): SeriesEntry[] {
  const rows = new Map<PlayerId, SeriesEntry>();
  for (const g of games) {
    const winner = pickWinner(g.entries);
    for (const e of g.entries) {
      const r = rows.get(e.playerId) ?? { playerId: e.playerId, games: 0, wins: 0, totalScore: 0, rank: 1 };
      r.games += 1;
      if (winner === e.playerId) r.wins += 1;
      r.totalScore += e.score;
      rows.set(e.playerId, r);
    }
  }
  const list = [...rows.values()];
  for (const r of list) r.rank = 1 + list.filter((o) => o.wins > r.wins || (o.wins === r.wins && o.totalScore > r.totalScore)).length;
  return list;
}

/** A10: the series so far, the current game included once it has ended. */
export function seriesOf(st: MatchState): SeriesEntry[] {
  const games: { entries: readonly ResultEntry[] }[] = [...st.pastGames];
  if (st.phase === 'ended') games.push({ entries: rankEntries(st) });
  return seriesStandings(games);
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
