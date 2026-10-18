import { describe, expect, it } from 'vitest';
import { buildMessage, type GameFingerprint, type ParticipantInfo } from '@castcade/protocol';
import { MatchLog } from './log.js';
import { allGamesEnded, nextGrantTarget, remainingParticipants, replayLog, isStrictMajority } from './state.js';
import { rankEntries, pickWinner } from './result.js';

const hex = 'ab'.repeat(32);
const key = Buffer.alloc(32, 1).toString('base64');
const sig = Buffer.alloc(64, 2).toString('base64');
const game: GameFingerprint = { kind: 'vpx', tableName: 'T', tableHash: hex, romName: null, romHash: null, physicsHash: null, recipeVersion: null, sidecarHash: null, emulatorVersion: '10.8.0' };
const part = (id: string): ParticipantInfo => ({ playerId: id, displayName: id, publicKey: key, rig: 'pc' });

function readyLog(players: string[], balls: number): MatchLog {
  const log = new MatchLog();
  const ready = buildMessage(
    'MATCH_READY',
    { matchId: 'M', ballsPerGame: balls, playerOrder: players, participants: players.map(part), hostPlayerId: players[0] ?? 'p1', hostPublicKey: key, game, seed: null, turnMode: 'alternating' },
    { matchId: 'M', seq: 1, from: 'p1', ts: 10 },
  );
  log.append({ ts: 10, kind: 'msg', from: 'p1', message: ready });
  return log;
}

let seq = 10;
function grant(log: MatchLog, player: string, ball: number, grantSeq: number): void {
  const msg = buildMessage('TURN_GRANT', { grant: { matchId: 'M', player, ballNumber: ball, grantSeq, issuedAt: 1, logHash: log.head().hash }, grantSig: sig }, { matchId: 'M', seq: ++seq, from: 'p1', ts: 1 });
  log.append({ ts: 1, kind: 'grant', from: 'p1', message: msg });
}
function ballEnd(log: MatchLog, player: string, ball: number, grantSeq: number, score: number, shootAgain = false): void {
  const msg = buildMessage('BALL_END', { grantSeq, ballNumber: ball, finalScore: score, detectorReason: 'script', shootAgain }, { matchId: 'M', seq: ++seq, from: player, ts: 2 });
  log.append({ ts: 2, kind: 'msg', from: player, message: msg });
}

describe('state fold', () => {
  it('MATCH_READY opens the match and the rotation goes ball by ball', () => {
    const log = readyLog(['p1', 'p2'], 2);
    let st = replayLog(log);
    expect(st.phase).toBe('running');
    expect(nextGrantTarget(st)).toEqual({ player: 'p1', ballNumber: 1 });
    grant(log, 'p1', 1, 1);
    st = replayLog(log);
    expect(st.currentGrant?.grant.grantSeq).toBe(1);
    expect(st.lastGrantSeq).toBe(1);
    ballEnd(log, 'p1', 1, 1, 100);
    st = replayLog(log);
    expect(st.currentGrant).toBeNull();
    expect(st.players['p1']).toMatchObject({ ballsPlayed: 1, score: 100, status: 'playing' });
    expect(nextGrantTarget(st)).toEqual({ player: 'p2', ballNumber: 1 });
  });

  it('shootAgain keeps the ball count and the rotation on the same player', () => {
    const log = readyLog(['p1', 'p2'], 2);
    grant(log, 'p1', 1, 1);
    ballEnd(log, 'p1', 1, 1, 50, true);
    const st = replayLog(log);
    expect(st.players['p1']).toMatchObject({ ballsPlayed: 0, score: 50 });
    expect(nextGrantTarget(st)).toEqual({ player: 'p1', ballNumber: 1 });
  });

  it('the last ball finishes a game; GAME_OVER and FORFEIT end one early; all ended -> phase ended', () => {
    const log = readyLog(['p1', 'p2', 'p3'], 2);
    grant(log, 'p1', 1, 1);
    ballEnd(log, 'p1', 1, 1, 100);
    grant(log, 'p2', 1, 2);
    log.append({ ts: 3, kind: 'msg', from: 'p2', message: buildMessage('GAME_OVER', { finalScore: 70, ballsPlayed: 1 }, { matchId: 'M', seq: ++seq, from: 'p2', ts: 3 }) });
    let st = replayLog(log);
    expect(st.players['p2']).toMatchObject({ status: 'finished', score: 70, ballsPlayed: 1 });
    expect(st.currentGrant).toBeNull();
    expect(nextGrantTarget(st)).toEqual({ player: 'p3', ballNumber: 1 });
    log.append({ ts: 4, kind: 'msg', from: 'p1', message: buildMessage('FORFEIT', { player: 'p3', reason: 'gone' }, { matchId: 'M', seq: ++seq, from: 'p1', ts: 4 }) });
    st = replayLog(log);
    expect(st.players['p3']?.status).toBe('forfeit');
    expect(remainingParticipants(st)).toEqual(['p1', 'p2']);
    expect(nextGrantTarget(st)).toEqual({ player: 'p1', ballNumber: 2 });
    grant(log, 'p1', 2, 3);
    ballEnd(log, 'p1', 2, 3, 300);
    st = replayLog(log);
    expect(allGamesEnded(st)).toBe(true);
    expect(st.phase).toBe('ended');
    expect(st.endedAt).toBe(2);
    const entries = rankEntries(st);
    expect(entries.map((e) => [e.playerId, e.rank, e.status])).toEqual([
      ['p1', 1, 'finished'],
      ['p2', 2, 'finished'],
      ['p3', 3, 'forfeit'],
    ]);
    expect(pickWinner(entries)).toBe('p1');
  });

  it('PAUSE marks a disconnect; RESUME schedules a re-issue of the outstanding grant', () => {
    const log = readyLog(['p1', 'p2'], 1);
    grant(log, 'p1', 1, 1);
    log.append({ ts: 5, kind: 'msg', from: 'p1', message: buildMessage('PAUSE', { reason: 'disconnect', player: 'p2' }, { matchId: 'M', seq: ++seq, from: 'p1', ts: 5 }) });
    let st = replayLog(log);
    expect(st.paused).toEqual({ reason: 'disconnect', player: 'p2' });
    expect(st.players['p2']?.connected).toBe(false);
    expect(remainingParticipants(st)).toEqual(['p1']);
    log.append({ ts: 6, kind: 'msg', from: 'p2', message: buildMessage('RESUME', {}, { matchId: 'M', seq: ++seq, from: 'p2', ts: 6 }) });
    st = replayLog(log);
    expect(st.paused).toBeNull();
    expect(st.currentGrant).toBeNull();
    expect(st.pendingReissue).toEqual({ player: 'p1', ballNumber: 1 });
    grant(log, 'p1', 1, 2);
    st = replayLog(log);
    expect(st.pendingReissue).toBeNull();
    expect(st.lastGrantSeq).toBe(2);
  });

  it('HOST_TRANSFER resolves the new host by key; the event switches host and re-issues', () => {
    const otherKey = Buffer.alloc(32, 9).toString('base64');
    const log = new MatchLog();
    const ready = buildMessage(
      'MATCH_READY',
      { matchId: 'M', ballsPerGame: 1, playerOrder: ['p1', 'p2'], participants: [part('p1'), { ...part('p2'), publicKey: otherKey }], hostPlayerId: 'p1', hostPublicKey: key, game, seed: null, turnMode: 'alternating' },
      { matchId: 'M', seq: 1, from: 'p1', ts: 10 },
    );
    log.append({ ts: 10, kind: 'msg', from: 'p1', message: ready });
    grant(log, 'p2', 1, 1);
    const transfer = buildMessage(
      'HOST_TRANSFER',
      { proposer: 'p1', reason: 'host_requested', logHash: log.head().hash, logLength: log.length, currentGrant: null, newHostPublicKey: otherKey },
      { matchId: 'M', seq: ++seq, from: 'p1', ts: 20 },
    );
    log.append({ ts: 20, kind: 'msg', from: 'p1', message: transfer });
    let st = replayLog(log);
    expect(st.pendingTransfer).toMatchObject({ proposer: 'p1', newHost: 'p2', reason: 'host_requested', proposedTs: 20 });
    log.append({ ts: 20, kind: 'event', from: 'p1', event: { type: 'host_transfer', reason: 'host_requested', proposer: 'p1', from: 'p1', to: 'p2', newHostPublicKey: otherKey } });
    st = replayLog(log);
    expect(st.hostId).toBe('p2');
    expect(st.hostPublicKey).toBe(otherKey);
    expect(st.hostTransfers).toBe(1);
    expect(st.pendingTransfer).toBeNull();
    expect(st.currentGrant).toBeNull();
    expect(st.pendingReissue).toEqual({ player: 'p2', ballNumber: 1 });
    expect(st.players['p1']?.connected).toBe(true);
  });

  it('strict majority', () => {
    expect(isStrictMajority(1, 1)).toBe(true);
    expect(isStrictMajority(1, 2)).toBe(false);
    expect(isStrictMajority(2, 2)).toBe(true);
    expect(isStrictMajority(2, 3)).toBe(true);
    expect(isStrictMajority(2, 4)).toBe(false);
    expect(isStrictMajority(3, 4)).toBe(true);
  });

  it('ranks: ties share a rank and the next rank skips; winner null on a tie for first', () => {
    const log = readyLog(['p1', 'p2', 'p3'], 1);
    grant(log, 'p1', 1, 1);
    ballEnd(log, 'p1', 1, 1, 500);
    grant(log, 'p2', 1, 2);
    ballEnd(log, 'p2', 1, 2, 500);
    grant(log, 'p3', 1, 3);
    ballEnd(log, 'p3', 1, 3, 100);
    const entries = rankEntries(replayLog(log));
    expect(entries.map((e) => e.rank)).toEqual([1, 1, 3]);
    expect(pickWinner(entries)).toBeNull();
  });
});
