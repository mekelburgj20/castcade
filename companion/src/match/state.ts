/**
 * Match state as a pure fold over the log. Host and clients both derive their view of the
 * match by applying every log entry through `applyEntry`, so `HostMatch.resumeFromLog` is
 * just `replayLog`, and any two participants holding the same log hold the same state.
 * Nothing here does I/O or reads a clock.
 */
import type { AnyMessage, GameFingerprint, ParticipantInfo, PayloadOf, PlayerId } from '@castcade/protocol';
import type { LogEntry, MatchLog } from './log.js';

export type PlayerStatus = 'playing' | 'finished' | 'forfeit';

export interface PlayerProgress {
  playerId: PlayerId;
  ballsPlayed: number;
  score: number;
  status: PlayerStatus;
  /**
   * False once a PAUSE(disconnect) named this player or the player left as host; true again when a
   * RESUME clears that disconnect pause while the player still plays (A3).
   */
  connected: boolean;
}

export interface GrantTarget {
  player: PlayerId;
  ballNumber: number;
}

export interface PendingTransfer {
  proposer: PlayerId;
  /** `newHost` from the message; null if that participant is unknown or does not hold `newHostPublicKey`. */
  newHost: PlayerId | null;
  newHostPublicKey: string;
  reason: 'host_left' | 'host_requested';
  logHash: string;
  logLength: number;
  /** `ts` of the HOST_TRANSFER message; reused as the `ts` of the commit event so all logs agree. */
  proposedTs: number;
  currentGrant: PayloadOf<'TURN_GRANT'> | null;
  /** Where the new host listens, when the transport needs one (WebSocket, A2). */
  newHostEndpoint: string | null;
}

export interface MatchState {
  phase: 'lobby' | 'running' | 'ended';
  matchId: string | null;
  ballsPerGame: number;
  turnMode: 'alternating' | 'simultaneous';
  playerOrder: PlayerId[];
  participants: ParticipantInfo[];
  game: GameFingerprint | null;
  hostId: PlayerId | null;
  hostPublicKey: string | null;
  players: Record<PlayerId, PlayerProgress>;
  /** The grant currently outstanding (issued, not yet answered). */
  currentGrant: PayloadOf<'TURN_GRANT'> | null;
  lastGrantSeq: number;
  /** A grant that must be re-issued (after RESUME or a host transfer) before the rotation continues. */
  pendingReissue: GrantTarget | null;
  paused: { reason: PayloadOf<'PAUSE'>['reason']; player: PlayerId | null } | null;
  pendingTransfer: PendingTransfer | null;
  hostTransfers: number;
  startedAt: number | null;
  endedAt: number | null;
}

export function initialState(): MatchState {
  return {
    phase: 'lobby',
    matchId: null,
    ballsPerGame: 0,
    turnMode: 'alternating',
    playerOrder: [],
    participants: [],
    game: null,
    hostId: null,
    hostPublicKey: null,
    players: {},
    currentGrant: null,
    lastGrantSeq: 0,
    pendingReissue: null,
    paused: null,
    pendingTransfer: null,
    hostTransfers: 0,
    startedAt: null,
    endedAt: null,
  };
}

export function replayLog(log: MatchLog): MatchState {
  const st = initialState();
  for (const e of log.entries()) applyEntry(st, e);
  return st;
}

export function applyEntry(st: MatchState, entry: LogEntry): void {
  if (entry.kind === 'event') {
    if (entry.event) applyEvent(st, entry.event);
  } else if (entry.message) {
    applyMessage(st, entry.message);
  }
  if (st.phase === 'running' && allGamesEnded(st)) {
    st.phase = 'ended';
    st.endedAt = entry.ts;
  }
}

function clearGrantFor(st: MatchState, player: PlayerId): void {
  if (st.currentGrant?.grant.player === player) st.currentGrant = null;
  if (st.pendingReissue?.player === player) st.pendingReissue = null;
}

function applyMessage(st: MatchState, msg: AnyMessage): void {
  switch (msg.type) {
    case 'MATCH_READY': {
      const p = msg.payload;
      st.phase = 'running';
      st.matchId = p.matchId;
      st.ballsPerGame = p.ballsPerGame;
      st.turnMode = p.turnMode;
      st.playerOrder = [...p.playerOrder];
      st.participants = p.participants.map((x) => ({ ...x }));
      st.game = { ...p.game };
      st.hostId = p.hostPlayerId;
      st.hostPublicKey = p.hostPublicKey;
      st.players = {};
      for (const id of p.playerOrder) st.players[id] = { playerId: id, ballsPlayed: 0, score: 0, status: 'playing', connected: true };
      st.startedAt = msg.ts;
      break;
    }
    case 'TURN_GRANT': {
      st.currentGrant = msg.payload;
      st.lastGrantSeq = Math.max(st.lastGrantSeq, msg.payload.grant.grantSeq);
      st.pendingReissue = null;
      break;
    }
    case 'BALL_END': {
      const p = st.players[msg.from];
      if (!p) break;
      p.score = msg.payload.finalScore;
      if (!msg.payload.shootAgain) {
        p.ballsPlayed = Math.max(p.ballsPlayed, msg.payload.ballNumber);
        if (p.ballsPlayed >= st.ballsPerGame && p.status === 'playing') p.status = 'finished';
      }
      st.currentGrant = null;
      break;
    }
    case 'GAME_OVER': {
      const p = st.players[msg.from];
      if (!p) break;
      p.status = p.status === 'forfeit' ? 'forfeit' : 'finished';
      p.score = msg.payload.finalScore;
      p.ballsPlayed = Math.max(p.ballsPlayed, msg.payload.ballsPlayed);
      clearGrantFor(st, msg.from);
      break;
    }
    case 'FORFEIT': {
      const p = st.players[msg.payload.player];
      if (!p) break;
      p.status = 'forfeit';
      clearGrantFor(st, msg.payload.player);
      break;
    }
    case 'PAUSE': {
      st.paused = { reason: msg.payload.reason, player: msg.payload.player };
      if (msg.payload.reason === 'disconnect' && msg.payload.player) {
        const p = st.players[msg.payload.player];
        if (p) p.connected = false;
      }
      break;
    }
    case 'RESUME': {
      // A3 (2026-10-30): clearing a disconnect pause for a player still playing means it is back;
      // if it is not, the host pauses again at its next grant (SPEC, Reconnect).
      const held = st.paused;
      if (held?.reason === 'disconnect' && held.player) {
        const p = st.players[held.player];
        if (p && p.status === 'playing') p.connected = true;
      }
      st.paused = null;
      if (st.currentGrant) {
        st.pendingReissue = { player: st.currentGrant.grant.player, ballNumber: st.currentGrant.grant.ballNumber };
        st.currentGrant = null;
      }
      break;
    }
    case 'HOST_TRANSFER': {
      const p = msg.payload;
      const target = st.participants.find((x) => x.playerId === p.newHost);
      st.pendingTransfer = {
        proposer: p.proposer,
        newHost: target && target.publicKey === p.newHostPublicKey ? target.playerId : null,
        newHostPublicKey: p.newHostPublicKey,
        reason: p.reason,
        logHash: p.logHash,
        logLength: p.logLength,
        proposedTs: msg.ts,
        currentGrant: p.currentGrant,
        newHostEndpoint: p.newHostEndpoint,
      };
      break;
    }
    default:
      // STATE, DMD_FRAME, HELLO*, REFUSE, REJECT, LOG_SIGN, RESULT, HOST_TRANSFER_ACK are never logged.
      break;
  }
}

function applyEvent(st: MatchState, ev: NonNullable<LogEntry['event']>): void {
  if (ev.type !== 'host_transfer') return;
  st.hostId = ev.to;
  st.hostPublicKey = ev.newHostPublicKey;
  st.hostTransfers += 1;
  st.pendingTransfer = null;
  if (ev.reason === 'host_left') {
    const old = st.players[ev.from];
    if (old) old.connected = false;
  }
  if (st.currentGrant) {
    st.pendingReissue = { player: st.currentGrant.grant.player, ballNumber: st.currentGrant.grant.ballNumber };
    st.currentGrant = null;
  }
}

export function allGamesEnded(st: MatchState): boolean {
  if (st.playerOrder.length === 0) return false;
  return st.playerOrder.every((id) => st.players[id]?.status !== 'playing');
}

/** Rotation: ball 1 for each player in order, then ball 2, ... skipping ended games. */
export function nextGrantTarget(st: MatchState): GrantTarget | null {
  for (let ball = 1; ball <= st.ballsPerGame; ball++) {
    for (const id of st.playerOrder) {
      const p = st.players[id];
      if (p && p.status === 'playing' && p.ballsPlayed < ball) return { player: id, ballNumber: ball };
    }
  }
  return null;
}

/** Participants who vote on a host transfer: still connected and not forfeited. */
export function remainingParticipants(st: MatchState): PlayerId[] {
  return st.playerOrder.filter((id) => {
    const p = st.players[id];
    return p !== undefined && p.connected && p.status !== 'forfeit';
  });
}

export function isStrictMajority(accepts: number, remaining: number): boolean {
  return accepts * 2 > remaining;
}

export function cloneState(st: MatchState): MatchState {
  return structuredClone(st);
}
