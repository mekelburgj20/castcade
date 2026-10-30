/**
 * HostMatch: the arbiter. Accepts HELLOs, starts the match, rotates grants, validates every
 * client message against the outstanding grant, logs exactly what it broadcasts, pauses on
 * disconnect/timeout, collects LOG_SIGNs and publishes the RESULT. The host is also a player:
 * its own BALL_END / STATE enter through `localBallEnd` / `localState` and take the same
 * validation path as a client's.
 *
 * Log discipline (the reason all participants end with the same hash): every state-changing
 * message the host accepts is broadcast verbatim to *every* participant, including the sender
 * as an echo, and each participant logs the broadcast stream in order. STATE and DMD_FRAME are
 * mirrored to the other participants but never logged. HELLO/HELLO_ACK/REFUSE/REJECT/LOG_SIGN/
 * RESULT/HOST_TRANSFER_ACK are never logged either. The log is frozen at the moment the last
 * game ends; LOG_SIGN and RESULT refer to that frozen head.
 *
 * Choices where SPEC is silent (listed in the Phase 1 report):
 * - TURN_GRANT is broadcast to all, not only the holder, so everyone logs it and knows whose turn it is.
 * - While a host_requested transfer is pending the old host rejects state changes
 *   (`unexpected_state`), so no entry can land between the HOST_TRANSFER entry and the commit event.
 * - A BALL_END for the outstanding grant is accepted during a pause; RESUME then simply advances.
 * - GAME_OVER from a player whose game already ended is rejected (`unexpected_state`).
 */
import {
  PROTOCOL_VERSION,
  type AnyMessage,
  type GameFingerprint,
  type GrantBody,
  type Message,
  type MessageType,
  type ParticipantInfo,
  type PayloadOf,
  type PlayerId,
} from '@castcade/protocol';
import { ClientMatch } from './client.js';
import type { Clock, TimerHandle } from './clock.js';
import { Emitter } from './events.js';
import { signCanonical, verifyCanonical, type KeyPair } from './keys.js';
import { GENESIS_HASH, type LogHead, type MatchLog } from './log.js';
import { logSignBody, pickWinner, rankEntries, reconnectSignBody } from './result.js';
import { Session } from './session.js';
import {
  cloneState,
  isStrictMajority,
  nextGrantTarget,
  remainingParticipants,
  type GrantTarget,
  type MatchState,
} from './state.js';
import type { Transport } from './transport.js';

export type RejectCode = PayloadOf<'REJECT'>['code'];
export type RefuseCode = PayloadOf<'REFUSE'>['code'];
export type ReconnectCode = NonNullable<PayloadOf<'RECONNECT_ACK'>['code']>;

export interface HostOptions {
  transport: Transport;
  keys: KeyPair;
  matchId: string;
  ballsPerGame: number;
  hostParticipant: ParticipantInfo;
  hostGame: GameFingerprint;
  turnMode?: 'alternating' | 'simultaneous';
  clock?: Clock;
  /** No BALL_END within this long of a grant pauses the match. Default 20 minutes. */
  ballEndTimeoutMs?: number;
  /** How long to wait for LOG_SIGNs before sending RESULT anyway. Default 10 s. */
  logSignTimeoutMs?: number;
  companionVersion?: string;
}

export interface ResumeOptions {
  transport: Transport;
  keys: KeyPair;
  clock?: Clock;
  /** Reuse an existing session (seq counters) instead of starting one from the log. */
  session?: Session;
  ballEndTimeoutMs?: number;
  logSignTimeoutMs?: number;
  /** Peers already known to have dropped (the departed host, for one). */
  gone?: Iterable<PlayerId>;
}

export interface RejectInfo extends PayloadOf<'REJECT'> {
  to: PlayerId;
}

export interface LogSignRecord {
  playerId: PlayerId;
  signature: string;
  logHash: string;
  logLength: number;
  agrees: boolean;
}

export interface HostEvents extends Record<string, unknown> {
  joined: ParticipantInfo;
  refused: { playerId: PlayerId; refuse: PayloadOf<'REFUSE'> };
  ready: PayloadOf<'MATCH_READY'>;
  grant: GrantBody;
  ballEnd: Message<'BALL_END'>;
  gameOver: Message<'GAME_OVER'>;
  forfeit: Message<'FORFEIT'>;
  pause: PayloadOf<'PAUSE'>;
  resume: { from: PlayerId };
  reject: RejectInfo;
  state: Message<'STATE'>;
  dmd: Message<'DMD_FRAME'>;
  logSign: LogSignRecord;
  allGamesEnded: LogHead;
  transferProposed: PayloadOf<'HOST_TRANSFER'>;
  /** This host stepped down; `client` continues the match on the same session. */
  hostTransfer: { from: PlayerId; to: PlayerId; client: ClientMatch };
  result: { result: PayloadOf<'RESULT'>; signatures: LogSignRecord[] };
  peerLeft: PlayerId;
  /** A RECONNECT was accepted; `entries` is how many log entries it was sent. */
  reconnected: { playerId: PlayerId; entries: number };
  reconnectRejected: { playerId: PlayerId; code: ReconnectCode };
}

const DEFAULT_BALL_END_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_LOG_SIGN_TIMEOUT_MS = 10_000;
const HOST_ONLY_TYPES: ReadonlySet<MessageType> = new Set(['HELLO_ACK', 'REFUSE', 'MATCH_READY', 'TURN_GRANT', 'RESULT', 'REJECT']);
/** Frames a host passes on with `from` preserved on a star transport. */
const RELAYED_TYPES: ReadonlySet<MessageType> = new Set(['STATE', 'DMD_FRAME', 'HOST_TRANSFER_ACK']);

export class HostMatch {
  readonly events = new Emitter<HostEvents>();
  private readonly s: Session;
  private readonly matchId: string;
  private readonly ballEndTimeoutMs: number;
  private readonly logSignTimeoutMs: number;
  private readonly companionVersion: string;
  /** Pre-start roster, host first. After start the roster lives in state.participants. */
  private lobby: ParticipantInfo[] = [];
  private hostGame: GameFingerprint;
  private turnMode: 'alternating' | 'simultaneous';
  private ballEndTimer: TimerHandle | null = null;
  private logSignTimer: TimerHandle | null = null;
  private finalHead: LogHead | null = null;
  private resultSent = false;
  private readonly signatures = new Map<PlayerId, LogSignRecord>();
  /** Players whose link dropped, by the transport's account (independent of the log). */
  private readonly gone = new Set<PlayerId>();
  private transferAccepts = new Set<PlayerId>();
  private detached = false;
  private readonly unsubscribe: (() => void)[] = [];

  constructor(opts: HostOptions, session?: Session) {
    this.s = session ?? new Session({ transport: opts.transport, keys: opts.keys, clock: opts.clock });
    this.matchId = opts.matchId;
    this.ballEndTimeoutMs = opts.ballEndTimeoutMs ?? DEFAULT_BALL_END_TIMEOUT_MS;
    this.logSignTimeoutMs = opts.logSignTimeoutMs ?? DEFAULT_LOG_SIGN_TIMEOUT_MS;
    this.companionVersion = opts.companionVersion ?? '0.1.0';
    this.hostGame = { ...opts.hostGame };
    this.turnMode = opts.turnMode ?? 'alternating';
    if (opts.hostParticipant.playerId !== opts.transport.localId) {
      throw new Error('hostParticipant.playerId must equal transport.localId');
    }
    this.lobby = [{ ...opts.hostParticipant, publicKey: opts.keys.publicKeyB64 }];
    this.ballsPerGameInit = opts.ballsPerGame;
    this.attach();
  }

  private ballsPerGameInit = 0;

  /**
   * Become host of a match in progress from its log (after an accepted HOST_TRANSFER). The
   * state is rebuilt by replaying the log; `log` must already contain the host_transfer event
   * naming `opts.transport.localId` as the new host. Call `run()` afterwards to re-issue the
   * outstanding grant.
   */
  static resumeFromLog(log: MatchLog, opts: ResumeOptions): HostMatch {
    const session = opts.session ?? new Session({ transport: opts.transport, keys: opts.keys, clock: opts.clock, log });
    if (session.log !== log) throw new Error('resumeFromLog: session.log must be the given log');
    session.replay();
    const st = session.state;
    if (st.phase === 'lobby' || !st.matchId || !st.game) throw new Error('resumeFromLog: log has no MATCH_READY');
    if (st.hostId !== session.localId) throw new Error(`resumeFromLog: log names ${st.hostId} as host, not ${session.localId}`);
    const me = st.participants.find((p) => p.playerId === session.localId);
    if (!me) throw new Error('resumeFromLog: local player is not in the roster');
    const host = new HostMatch(
      {
        transport: session.transport,
        keys: session.keys,
        matchId: st.matchId,
        ballsPerGame: st.ballsPerGame,
        hostParticipant: me,
        hostGame: st.game,
        turnMode: st.turnMode,
        clock: session.clock,
        ballEndTimeoutMs: opts.ballEndTimeoutMs,
        logSignTimeoutMs: opts.logSignTimeoutMs,
      },
      session,
    );
    for (const id of opts.gone ?? []) host.gone.add(id);
    return host;
  }

  // ------------------------------------------------------------------------------------------
  // Public surface
  // ------------------------------------------------------------------------------------------

  get localId(): PlayerId {
    return this.s.localId;
  }

  get log(): MatchLog {
    return this.s.log;
  }

  get session(): Session {
    return this.s;
  }

  get state(): MatchState {
    return this.s.state;
  }

  get publicKey(): string {
    return this.s.keys.publicKeyB64;
  }

  /** Roster so far: the lobby before start, the MATCH_READY roster afterwards. */
  roster(): ParticipantInfo[] {
    return this.s.state.phase === 'lobby' ? [...this.lobby] : [...this.s.state.participants];
  }

  on<K extends keyof HostEvents>(name: K, cb: (payload: HostEvents[K]) => void): () => void {
    return this.events.on(name, cb);
  }

  snapshot(): { role: 'host'; state: MatchState; log: LogHead; lobby: ParticipantInfo[]; gone: PlayerId[]; finalHead: LogHead | null; signatures: LogSignRecord[] } {
    return {
      role: 'host',
      state: cloneState(this.s.state),
      log: this.s.log.head(),
      lobby: [...this.lobby],
      gone: [...this.gone],
      finalHead: this.finalHead,
      signatures: [...this.signatures.values()],
    };
  }

  /** Freeze the roster and start the rotation. Needs at least two participants. */
  start(): void {
    this.assertActive();
    if (this.s.state.phase !== 'lobby') throw new Error('match already started');
    if (this.lobby.length < 2) throw new Error('need at least two participants to start');
    const payload: PayloadOf<'MATCH_READY'> = {
      matchId: this.matchId,
      ballsPerGame: this.ballsPerGameInit,
      playerOrder: this.lobby.map((p) => p.playerId),
      participants: this.lobby.map((p) => ({ ...p })),
      hostPlayerId: this.localId,
      hostPublicKey: this.publicKey,
      game: { ...this.hostGame },
      seed: null,
      turnMode: this.turnMode,
    };
    const msg = this.s.build('MATCH_READY', payload, this.matchId);
    this.s.commit({ ts: msg.ts, kind: 'msg', from: this.localId, message: msg });
    this.s.transport.send('all', msg);
    this.events.emit('ready', msg.payload);
    this.advance();
  }

  /** After `resumeFromLog`: re-issue the outstanding grant (or continue the rotation). */
  run(): void {
    this.assertActive();
    this.advance();
  }

  /** The host's own ball end; same validation as a client's BALL_END. */
  localBallEnd(
    finalScore: number,
    detectorReason: PayloadOf<'BALL_END'>['detectorReason'],
    shootAgain = false,
    override: { grantSeq?: number; ballNumber?: number } = {},
  ): void {
    this.assertActive();
    const g = this.s.state.currentGrant?.grant;
    const msg = this.s.build(
      'BALL_END',
      {
        grantSeq: override.grantSeq ?? g?.grantSeq ?? Math.max(1, this.s.state.lastGrantSeq),
        ballNumber: override.ballNumber ?? g?.ballNumber ?? 1,
        finalScore,
        detectorReason,
        shootAgain,
      },
      this.matchId,
    );
    this.onBallEnd(msg);
  }

  localState(state: Omit<PayloadOf<'STATE'>, 'extraBalls'> & { extraBalls?: number }): void {
    this.assertActive();
    const msg = this.s.build('STATE', state, this.matchId);
    this.mirror(msg);
    this.events.emit('state', msg);
  }

  localDmd(frame: PayloadOf<'DMD_FRAME'>): void {
    this.assertActive();
    const msg = this.s.build('DMD_FRAME', frame, this.matchId);
    this.mirror(msg);
    this.events.emit('dmd', msg);
  }

  localGameOver(finalScore: number, ballsPlayed: number): void {
    this.assertActive();
    this.onGameOver(this.s.build('GAME_OVER', { finalScore, ballsPlayed }, this.matchId));
  }

  /** Host forfeits a player (itself or one who does not return). */
  forfeit(player: PlayerId, reason: string): void {
    this.assertActive();
    this.onForfeit(this.s.build('FORFEIT', { player, reason }, this.matchId));
  }

  pause(reason: PayloadOf<'PAUSE'>['reason'], player: PlayerId | null): void {
    this.assertActive();
    this.acceptPause(this.s.build('PAUSE', { reason, player }, this.matchId));
  }

  resume(): void {
    this.assertActive();
    this.onResume(this.s.build('RESUME', {}, this.matchId));
  }

  /**
   * Planned handover (`host_requested`). Takes effect once a strict majority acks. Over WebSocket
   * `endpoint` is the new host's open listener (A2); how this host learned it is above the protocol.
   */
  transferHost(to: PlayerId, opts: { endpoint?: string } = {}): void {
    this.assertActive();
    const st = this.s.state;
    if (st.phase !== 'running') throw new Error('transferHost: match is not running');
    if (st.pendingTransfer) throw new Error('transferHost: a transfer is already pending');
    const target = st.participants.find((p) => p.playerId === to);
    if (!target || to === this.localId) throw new Error(`transferHost: ${to} is not another participant`);
    const head = this.s.log.head();
    const msg = this.s.build(
      'HOST_TRANSFER',
      {
        proposer: this.localId,
        newHost: to,
        reason: 'host_requested',
        logHash: head.hash,
        logLength: head.length,
        currentGrant: st.currentGrant,
        newHostPublicKey: target.publicKey,
        newHostEndpoint: opts.endpoint ?? null,
      },
      this.matchId,
    );
    this.clearBallEndTimer();
    this.s.commit({ ts: msg.ts, kind: 'msg', from: this.localId, message: msg });
    this.s.transport.send('all', msg);
    this.transferAccepts = new Set([this.localId]);
    this.events.emit('transferProposed', msg.payload);
    this.checkTransferMajority(null, null);
  }

  /** Stop acting as host (timers cleared, transport handlers removed). The session stays usable. */
  close(): void {
    this.detach();
  }

  // ------------------------------------------------------------------------------------------
  // Transport plumbing
  // ------------------------------------------------------------------------------------------

  private attach(): void {
    const t = this.s.transport;
    this.unsubscribe.push(t.onMessage((from, msg) => this.handle(from, msg)));
    this.unsubscribe.push(t.onPeerLeave((peer) => this.onPeerLeave(peer)));
  }

  private detach(): void {
    if (this.detached) return;
    this.detached = true;
    for (const off of this.unsubscribe) off();
    this.unsubscribe.length = 0;
    this.clearBallEndTimer();
    if (this.logSignTimer !== null) {
      this.s.clock.clearTimeout(this.logSignTimer);
      this.logSignTimer = null;
    }
  }

  private assertActive(): void {
    if (this.detached) throw new Error('this HostMatch has stepped down or been closed');
  }

  private broadcast(msg: AnyMessage): void {
    this.s.transport.send('all', msg);
  }

  /** STATE / DMD_FRAME: to every other participant, `from` preserved, never logged. */
  private mirror(msg: AnyMessage): void {
    const ids = this.s.state.phase === 'lobby' ? this.lobby.map((p) => p.playerId) : this.s.state.playerOrder;
    for (const id of ids) {
      if (id === msg.from || id === this.localId || this.gone.has(id)) continue;
      this.s.transport.send(id, msg);
    }
  }

  private reject(ref: AnyMessage, code: RejectCode, message: string): void {
    const payload: PayloadOf<'REJECT'> = { refSeq: ref.seq, refType: ref.type, code, message };
    this.events.emit('reject', { to: ref.from, ...payload });
    if (ref.from !== this.localId) this.s.transport.send(ref.from, this.s.build('REJECT', payload, this.matchId));
  }

  private refuse(hello: Message<'HELLO'>, code: RefuseCode, message: string, mismatches: PayloadOf<'REFUSE'>['mismatches'] = []): void {
    const msg = this.s.build('REFUSE', { code, message, mismatches }, null);
    this.s.transport.send(hello.from, msg);
    this.events.emit('refused', { playerId: hello.from, refuse: msg.payload });
    this.s.transport.closePeer?.(hello.from);
  }

  // ------------------------------------------------------------------------------------------
  // Inbound dispatch
  // ------------------------------------------------------------------------------------------

  /** Public so a client that just won a transfer can hand over the RECONNECTs it held (A2). */
  handle(linkFrom: PlayerId, msg: AnyMessage, opts: { seqChecked?: boolean } = {}): void {
    if (this.detached) return;
    if (msg.from !== linkFrom) {
      // On a star the old host relays acks and mirrors frames until it steps down; one that
      // reaches this host after the transfer is stale, not an impersonation (A2, 2026-10-30).
      if (this.s.transport.topology === 'star' && RELAYED_TYPES.has(msg.type)) return;
      this.reject(msg, 'unknown_player', `from=${msg.from} does not match the link peer ${linkFrom}`);
      return;
    }
    if (!opts.seqChecked && !this.s.checkSeq(msg.from, msg.seq)) {
      this.reject(msg, 'unexpected_state', `seq ${msg.seq} is not greater than the last accepted from ${msg.from}`);
      return;
    }
    if (msg.type === 'HELLO') {
      this.onHello(msg);
      return;
    }
    if (msg.type === 'RECONNECT') {
      this.onReconnect(linkFrom, msg);
      return;
    }
    if (!this.isParticipant(msg.from)) {
      this.reject(msg, 'unknown_player', `${msg.from} has not joined this match`);
      return;
    }
    const pt = this.s.state.pendingTransfer;
    if (pt && pt.newHost === msg.from && HOST_ONLY_TYPES.has(msg.type)) {
      // The new host already counted its majority and started acting; follow it.
      this.commitTransfer(linkFrom, msg);
      return;
    }
    if (msg.matchId !== this.matchId) {
      this.reject(msg, 'schema', `matchId ${String(msg.matchId)} is not this match`);
      return;
    }
    switch (msg.type) {
      case 'STATE':
        this.mirror(msg);
        this.events.emit('state', msg);
        return;
      case 'DMD_FRAME':
        this.mirror(msg);
        this.events.emit('dmd', msg);
        return;
      case 'BALL_END':
        this.onBallEnd(msg);
        return;
      case 'GAME_OVER':
        this.onGameOver(msg);
        return;
      case 'FORFEIT':
        if (msg.payload.player !== msg.from) {
          this.reject(msg, 'unexpected_state', 'a client may only forfeit itself');
          return;
        }
        this.onForfeit(msg);
        return;
      case 'PAUSE':
        this.onClientPause(msg);
        return;
      case 'RESUME':
        this.onResume(msg);
        return;
      case 'LOG_SIGN':
        this.onLogSign(msg);
        return;
      case 'HOST_TRANSFER':
        this.reject(msg, 'unexpected_state', 'the host is present; only it may propose a transfer');
        return;
      case 'HOST_TRANSFER_ACK':
        this.onTransferAck(msg);
        return;
      default:
        this.reject(msg, 'unexpected_state', `${msg.type} is not a client -> host message`);
    }
  }

  private isParticipant(id: PlayerId): boolean {
    return this.s.state.phase === 'lobby' ? this.lobby.some((p) => p.playerId === id) : this.s.state.players[id] !== undefined;
  }

  private onPeerLeave(peer: PlayerId): void {
    if (this.detached) return;
    const st = this.s.state;
    if (st.phase === 'lobby') {
      this.lobby = this.lobby.filter((p) => p.playerId !== peer);
      this.events.emit('peerLeft', peer);
      return;
    }
    const p = st.players[peer];
    if (!p || this.gone.has(peer)) return;
    this.gone.add(peer);
    this.events.emit('peerLeft', peer);
    if (st.phase === 'running' && p.status === 'playing' && !st.pendingTransfer) {
      this.clearBallEndTimer();
      this.pause('disconnect', peer);
    } else if (st.phase === 'ended') {
      this.maybeSendResult();
    }
  }

  // ------------------------------------------------------------------------------------------
  // Joining
  // ------------------------------------------------------------------------------------------

  private onHello(msg: Message<'HELLO'>): void {
    const p = msg.payload;
    const hostId = this.localId;
    if ((msg.v as number) !== PROTOCOL_VERSION || (p.protocolVersion as number) !== PROTOCOL_VERSION) {
      this.refuse(msg, 'protocol_version', `host speaks protocol ${PROTOCOL_VERSION}`);
      return;
    }
    if (this.s.state.phase !== 'lobby') {
      this.refuse(msg, 'match_started', 'the roster is final');
      return;
    }
    if (p.participant.playerId !== msg.from) {
      this.refuse(msg, 'other', 'participant.playerId must equal the envelope from');
      return;
    }
    if (p.throwdownCode !== this.matchId) {
      this.refuse(msg, 'unknown_throwdown', `this host runs ${this.matchId}, not ${p.throwdownCode}`);
      return;
    }
    if (this.lobby.some((x) => x.playerId === p.participant.playerId)) {
      this.refuse(msg, 'duplicate_player', `${p.participant.playerId} is already in the match`);
      return;
    }
    if (this.lobby.length >= 4) {
      this.refuse(msg, 'match_full', 'four participants already');
      return;
    }
    const mismatches = compareFingerprints(this.hostGame, p.game, hostId);
    if (mismatches.length > 0) {
      const fields = mismatches.map((m) => m.field).join(', ');
      this.refuse(msg, 'fingerprint_mismatch', `game fingerprint differs in: ${fields}`, mismatches);
      return;
    }
    const participant: ParticipantInfo = { ...p.participant };
    this.lobby.push(participant);
    const ack = this.s.build(
      'HELLO_ACK',
      { hostPlayerId: hostId, hostPublicKey: this.publicKey, participants: this.lobby.map((x) => ({ ...x })) },
      null,
    );
    this.s.transport.send(msg.from, ack);
    this.events.emit('joined', participant);
  }

  // ------------------------------------------------------------------------------------------
  // Turn rotation
  // ------------------------------------------------------------------------------------------

  private advance(): void {
    const st = this.s.state;
    if (st.phase === 'ended') {
      this.finish();
      return;
    }
    if (st.phase !== 'running' || st.pendingTransfer || st.paused || st.currentGrant) return;
    if (st.turnMode === 'simultaneous') return; // no grants in simultaneous mode; games end on GAME_OVER
    const target = st.pendingReissue ?? nextGrantTarget(st);
    if (!target) return;
    const p = st.players[target.player];
    if (!p || !p.connected || this.gone.has(target.player)) {
      this.pause('disconnect', target.player);
      return;
    }
    this.issueGrant(target);
  }

  private issueGrant(target: GrantTarget): void {
    const st = this.s.state;
    const body: GrantBody = {
      matchId: this.matchId,
      player: target.player,
      ballNumber: target.ballNumber,
      grantSeq: st.lastGrantSeq + 1,
      issuedAt: this.s.clock.now(),
      logHash: this.s.log.head().hash,
    };
    const msg = this.s.build('TURN_GRANT', { grant: body, grantSig: signCanonical(body, this.s.keys.privateKey) }, this.matchId);
    this.s.commit({ ts: msg.ts, kind: 'grant', from: this.localId, message: msg });
    this.broadcast(msg);
    this.clearBallEndTimer();
    this.ballEndTimer = this.s.clock.setTimeout(() => this.onBallEndTimeout(body.grantSeq), this.ballEndTimeoutMs);
    // Listeners may act on the grant (e.g. start a transfer), so arm the timer before telling them.
    this.events.emit('grant', body);
  }

  private clearBallEndTimer(): void {
    if (this.ballEndTimer !== null) {
      this.s.clock.clearTimeout(this.ballEndTimer);
      this.ballEndTimer = null;
    }
  }

  private onBallEndTimeout(grantSeq: number): void {
    this.ballEndTimer = null;
    if (this.detached) return;
    const st = this.s.state;
    if (!st.currentGrant || st.currentGrant.grant.grantSeq !== grantSeq || st.paused || st.pendingTransfer) return;
    this.pause('ball_end_timeout', st.currentGrant.grant.player);
  }

  private onBallEnd(msg: Message<'BALL_END'>): void {
    const st = this.s.state;
    if (st.phase !== 'running') {
      this.reject(msg, 'unexpected_state', 'the match is not running');
      return;
    }
    if (st.pendingTransfer) {
      this.reject(msg, 'unexpected_state', 'host transfer pending; wait for the re-issued grant');
      return;
    }
    const g = st.currentGrant?.grant;
    if (!g) {
      this.reject(msg, 'unexpected_state', 'no grant is outstanding');
      return;
    }
    if (g.player !== msg.from) {
      this.reject(msg, 'not_grant_holder', `${g.player} holds the grant`);
      return;
    }
    if (msg.payload.grantSeq !== g.grantSeq) {
      this.reject(msg, 'stale_grant', `current grantSeq is ${g.grantSeq}`);
      return;
    }
    if (msg.payload.ballNumber !== g.ballNumber) {
      this.reject(msg, 'unexpected_state', `grant is for ball ${g.ballNumber}`);
      return;
    }
    this.clearBallEndTimer();
    this.s.commit({ ts: msg.ts, kind: 'msg', from: msg.from, message: msg });
    this.broadcast(msg);
    this.events.emit('ballEnd', msg);
    this.advance();
  }

  private onGameOver(msg: Message<'GAME_OVER'>): void {
    const st = this.s.state;
    if (st.phase !== 'running') {
      this.reject(msg, 'unexpected_state', 'the match is not running');
      return;
    }
    if (st.pendingTransfer) {
      this.reject(msg, 'unexpected_state', 'host transfer pending');
      return;
    }
    const p = st.players[msg.from];
    if (!p || p.status !== 'playing') {
      this.reject(msg, 'unexpected_state', `${msg.from}'s game has already ended`);
      return;
    }
    if (st.currentGrant?.grant.player === msg.from) this.clearBallEndTimer();
    this.s.commit({ ts: msg.ts, kind: 'msg', from: msg.from, message: msg });
    this.broadcast(msg);
    this.events.emit('gameOver', msg);
    this.advance();
  }

  private onForfeit(msg: Message<'FORFEIT'>): void {
    const st = this.s.state;
    if (st.phase !== 'running') {
      this.reject(msg, 'unexpected_state', 'the match is not running');
      return;
    }
    if (st.pendingTransfer) {
      this.reject(msg, 'unexpected_state', 'host transfer pending');
      return;
    }
    const p = st.players[msg.payload.player];
    if (!p || p.status !== 'playing') {
      this.reject(msg, 'unexpected_state', `${msg.payload.player} is not playing`);
      return;
    }
    if (st.currentGrant?.grant.player === msg.payload.player) this.clearBallEndTimer();
    this.s.commit({ ts: msg.ts, kind: 'msg', from: msg.from, message: msg });
    this.broadcast(msg);
    this.events.emit('forfeit', msg);
    this.advance();
  }

  private onClientPause(msg: Message<'PAUSE'>): void {
    const st = this.s.state;
    if (st.phase !== 'running' || st.pendingTransfer) {
      this.reject(msg, 'unexpected_state', 'cannot pause now');
      return;
    }
    if (st.paused) {
      this.reject(msg, 'unexpected_state', 'already paused');
      return;
    }
    this.clearBallEndTimer();
    this.acceptPause(msg);
  }

  private acceptPause(msg: Message<'PAUSE'>): void {
    if (this.s.state.phase !== 'running') return;
    this.clearBallEndTimer();
    this.s.commit({ ts: msg.ts, kind: 'msg', from: msg.from, message: msg });
    this.broadcast(msg);
    this.events.emit('pause', msg.payload);
  }

  private onResume(msg: Message<'RESUME'>): void {
    const st = this.s.state;
    if (st.phase !== 'running' || !st.paused || st.pendingTransfer) {
      this.reject(msg, 'unexpected_state', 'not paused');
      return;
    }
    this.s.commit({ ts: msg.ts, kind: 'msg', from: msg.from, message: msg });
    this.broadcast(msg);
    this.events.emit('resume', { from: msg.from });
    this.advance();
  }

  // ------------------------------------------------------------------------------------------
  // Finishing
  // ------------------------------------------------------------------------------------------

  private finish(): void {
    if (this.finalHead) return;
    this.clearBallEndTimer();
    this.finalHead = this.s.log.head();
    this.events.emit('allGamesEnded', this.finalHead);
    if (!this.maybeSendResult()) {
      this.logSignTimer = this.s.clock.setTimeout(() => {
        this.logSignTimer = null;
        this.sendResult();
      }, this.logSignTimeoutMs);
    }
  }

  private expectedSigners(): PlayerId[] {
    return this.s.state.playerOrder.filter((id) => id !== this.localId && !this.gone.has(id) && this.s.state.players[id]?.connected);
  }

  private onLogSign(msg: Message<'LOG_SIGN'>): void {
    if (!this.finalHead) {
      this.reject(msg, 'unexpected_state', 'games are still in progress');
      return;
    }
    const rec: LogSignRecord = {
      playerId: msg.from,
      signature: msg.payload.signature,
      logHash: msg.payload.logHash,
      logLength: msg.payload.logLength,
      agrees: msg.payload.logHash === this.finalHead.hash && msg.payload.logLength === this.finalHead.length,
    };
    this.signatures.set(msg.from, rec);
    this.events.emit('logSign', rec);
    this.maybeSendResult();
  }

  private maybeSendResult(): boolean {
    if (!this.finalHead || this.resultSent) return false;
    if (this.expectedSigners().every((id) => this.signatures.has(id))) {
      this.sendResult();
      return true;
    }
    return false;
  }

  private sendResult(): void {
    if (!this.finalHead || this.resultSent) return;
    this.resultSent = true;
    if (this.logSignTimer !== null) {
      this.s.clock.clearTimeout(this.logSignTimer);
      this.logSignTimer = null;
    }
    const st = this.s.state;
    const entries = rankEntries(st);
    const head = this.finalHead;
    const payload: PayloadOf<'RESULT'> = {
      matchId: this.matchId,
      entries,
      winner: pickWinner(entries),
      logHash: head.hash,
      logLength: head.length,
      hostSignature: signCanonical(logSignBody(this.matchId, head.hash, head.length), this.s.keys.privateKey),
      signatures: [...this.signatures.values()].map((r) => ({ playerId: r.playerId, signature: r.signature, logHash: r.logHash, logLength: r.logLength })),
      hostTransfers: st.hostTransfers,
      startedAt: st.startedAt ?? head.length,
      finishedAt: st.endedAt ?? this.s.clock.now(),
    };
    const msg = this.s.build('RESULT', payload, this.matchId);
    this.broadcast(msg);
    this.events.emit('result', { result: msg.payload, signatures: [...this.signatures.values()] });
  }

  // ------------------------------------------------------------------------------------------
  // Host transfer (this host stepping down)
  // ------------------------------------------------------------------------------------------

  private onTransferAck(msg: Message<'HOST_TRANSFER_ACK'>): void {
    // A star has no client-to-client links: pass every ack on so the new host can count it (A2).
    if (this.s.transport.topology === 'star') this.mirror(msg);
    const pt = this.s.state.pendingTransfer;
    // Acks that arrive after the transfer already took effect are expected; ignore them quietly.
    if (!pt || msg.payload.proposer !== pt.proposer) return;
    if (msg.payload.accept && msg.payload.logHash === pt.logHash) this.transferAccepts.add(msg.from);
    this.checkTransferMajority(null, null);
  }

  private checkTransferMajority(linkFrom: PlayerId | null, trigger: AnyMessage | null): void {
    const st = this.s.state;
    if (!st.pendingTransfer) return;
    const remaining = remainingParticipants(st).filter((id) => !this.gone.has(id));
    const accepts = [...this.transferAccepts].filter((id) => remaining.includes(id)).length;
    if (isStrictMajority(accepts, remaining.length)) this.commitTransfer(linkFrom, trigger);
  }

  /** Append the host_transfer event, step down, and continue as a ClientMatch on this session. */
  private commitTransfer(linkFrom: PlayerId | null, trigger: AnyMessage | null): void {
    const pt = this.s.state.pendingTransfer;
    if (!pt || !pt.newHost) return;
    const from = this.localId;
    this.s.commit({
      ts: pt.proposedTs,
      kind: 'event',
      from,
      event: { type: 'host_transfer', reason: pt.reason, proposer: pt.proposer, from, to: pt.newHost, newHostPublicKey: pt.newHostPublicKey },
    });
    this.detach();
    const me = this.s.state.participants.find((p) => p.playerId === from);
    const client = ClientMatch.adopt(this.s, {
      participant: me ?? { playerId: from, displayName: from, publicKey: this.publicKey, rig: 'pc' },
      game: this.hostGame,
      throwdownCode: this.matchId,
      companionVersion: this.companionVersion,
      gone: this.gone,
    });
    this.events.emit('hostTransfer', { from, to: pt.newHost, client });
    if (trigger && linkFrom !== null) client.handle(linkFrom, trigger, { seqChecked: true });
    // Over WebSocket the old host becomes a client of the new host's listener, and closes its own
    // once that RECONNECT is accepted (A2, 2026-10-30).
    if (pt.newHostEndpoint !== null) client.relinkTo(pt.newHost, { endpoint: pt.newHostEndpoint, closeListenerOnAccept: true });
  }

  // ------------------------------------------------------------------------------------------
  // Reconnect (A2/A3, 2026-10-30): resume from the log head, never a fresh HELLO
  // ------------------------------------------------------------------------------------------

  private onReconnect(linkFrom: PlayerId, msg: Message<'RECONNECT'>): void {
    const code = this.checkReconnect(msg);
    const head = this.s.log.head();
    const matchId = this.s.state.matchId ?? this.matchId;
    if (code !== null) {
      this.s.transport.send(linkFrom, this.s.build('RECONNECT_ACK', { accept: false, code, entries: [], logHash: head.hash, logLength: head.length }, matchId));
      this.events.emit('reconnectRejected', { playerId: msg.from, code });
      this.s.transport.closePeer?.(linkFrom);
      return;
    }
    const entries = this.s.log.entries().slice(msg.payload.logLength);
    this.s.transport.send(
      linkFrom,
      this.s.build('RECONNECT_ACK', { accept: true, code: null, entries: entries.map((e) => ({ ...e })), logHash: head.hash, logLength: head.length }, matchId),
    );
    this.events.emit('reconnected', { playerId: msg.from, entries: entries.length });
  }

  private checkReconnect(msg: Message<'RECONNECT'>): ReconnectCode | null {
    const st = this.s.state;
    const p = msg.payload;
    if (st.phase === 'lobby' || !st.matchId) return 'match_not_started';
    const who = st.participants.find((x) => x.playerId === msg.from);
    if (!who || p.player !== msg.from) return 'unknown_player';
    if (!verifyCanonical(reconnectSignBody(st.matchId, p.player, p.logHash, p.logLength), p.signature, who.publicKey)) return 'bad_signature';
    const known = p.logLength === 0 ? p.logHash === GENESIS_HASH : this.s.log.at(p.logLength - 1)?.hash === p.logHash;
    return known ? null : 'unknown_log_hash';
  }
}

export function compareFingerprints(expected: GameFingerprint, received: GameFingerprint, expectedFrom: PlayerId): PayloadOf<'REFUSE'>['mismatches'] {
  const out: PayloadOf<'REFUSE'>['mismatches'] = [];
  const keys = Object.keys(expected) as (keyof GameFingerprint)[];
  for (const field of keys) {
    const a = expected[field];
    const b = received[field];
    if (a !== b) out.push({ field, expected: a === null ? null : String(a), received: b === null ? null : String(b), expectedFrom });
  }
  return out;
}
