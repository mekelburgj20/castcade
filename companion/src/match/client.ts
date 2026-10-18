/**
 * ClientMatch: a participant that is not the arbiter. Joins with HELLO, verifies every
 * TURN_GRANT against the host key before releasing the input lock, reports BALL_END / STATE /
 * GAME_OVER, keeps the same log as the host from the broadcast stream, sends LOG_SIGN once the
 * log shows every game has ended, verifies RESULT, and runs the client side of host transfer
 * (acking a planned handover, proposing itself when the host is gone, becoming the HostMatch
 * when it wins a majority).
 *
 * LOG_SIGN rule (SPEC leaves the trigger implicit): the client derives "every game has ended"
 * from its own log — the fold over MATCH_READY / BALL_END / GAME_OVER / FORFEIT entries — and
 * signs its head at that moment. The host freezes its log at the same entry, so the hashes line
 * up without any extra message.
 *
 * Transfer commit rule: only the prospective new host counts acks. Every other participant
 * commits the transfer when the first host-only message (TURN_GRANT, PAUSE, ...) arrives from the
 * new host, which keeps the position of the commit event identical in every log regardless of
 * the order acks travel in.
 */
import type { AnyMessage, GameFingerprint, GrantBody, Message, MessageType, ParticipantInfo, PayloadOf, PlayerId } from '@castcade/protocol';
import { PROTOCOL_VERSION } from '@castcade/protocol';
import type { Clock } from './clock.js';
import { Emitter } from './events.js';
import { HostMatch } from './host.js';
import { signCanonical, verifyCanonical, type KeyPair } from './keys.js';
import type { LogHead, MatchLog } from './log.js';
import { logSignBody } from './result.js';
import { Session } from './session.js';
import { cloneState, isStrictMajority, remainingParticipants, type MatchState } from './state.js';
import type { Transport } from './transport.js';

export interface ClientOptions {
  transport: Transport;
  keys: KeyPair;
  participant: ParticipantInfo;
  game: GameFingerprint;
  throwdownCode: string;
  companionVersion?: string;
  /** Where HELLO goes on a full-mesh transport; omit on a point-to-point transport. */
  hostId?: PlayerId;
  clock?: Clock;
  /** Used if this client becomes host after a transfer. */
  hostTimeouts?: { ballEndTimeoutMs?: number; logSignTimeoutMs?: number };
}

export interface AdoptOptions {
  participant: ParticipantInfo;
  game: GameFingerprint;
  throwdownCode: string;
  companionVersion?: string;
  gone?: Iterable<PlayerId>;
  hostTimeouts?: { ballEndTimeoutMs?: number; logSignTimeoutMs?: number };
}

export interface DroppedInfo {
  from: PlayerId;
  type: MessageType;
  seq: number;
  reason: 'seq' | 'bad_signature' | 'stale_grant' | 'not_host' | 'unexpected';
}

export interface DesyncInfo {
  context: 'grant.logHash' | 'result.logHash';
  expected: string;
  actual: string;
}

export interface ResultInfo {
  result: PayloadOf<'RESULT'>;
  logMatches: boolean;
  signatureValid: boolean;
}

export interface ClientEvents extends Record<string, unknown> {
  joined: PayloadOf<'HELLO_ACK'>;
  refused: PayloadOf<'REFUSE'>;
  ready: PayloadOf<'MATCH_READY'>;
  grant: GrantBody;
  myTurn: GrantBody;
  ballEnd: Message<'BALL_END'>;
  gameOver: Message<'GAME_OVER'>;
  forfeit: Message<'FORFEIT'>;
  pause: PayloadOf<'PAUSE'>;
  resume: { from: PlayerId };
  state: Message<'STATE'>;
  dmd: Message<'DMD_FRAME'>;
  reject: PayloadOf<'REJECT'>;
  dropped: DroppedInfo;
  desync: DesyncInfo;
  transferProposed: PayloadOf<'HOST_TRANSFER'>;
  transferAck: Message<'HOST_TRANSFER_ACK'>;
  hostChanged: { from: PlayerId; to: PlayerId };
  becameHost: HostMatch;
  hostLost: PlayerId;
  logSigned: PayloadOf<'LOG_SIGN'>;
  result: ResultInfo;
  peerLeft: PlayerId;
}

const HOST_ONLY_TYPES: ReadonlySet<MessageType> = new Set(['TURN_GRANT', 'RESULT', 'PAUSE', 'RESUME', 'FORFEIT', 'REJECT']);

export class ClientMatch {
  readonly events = new Emitter<ClientEvents>();
  private readonly s: Session;
  private readonly participant: ParticipantInfo;
  private readonly game: GameFingerprint;
  private readonly throwdownCode: string;
  private readonly companionVersion: string;
  private readonly explicitHostId: PlayerId | null;
  private readonly hostTimeouts: { ballEndTimeoutMs?: number; logSignTimeoutMs?: number };
  private ackHostId: PlayerId | null = null;
  private ackHostKey: string | null = null;
  private joined = false;
  private refusedWith: PayloadOf<'REFUSE'> | null = null;
  private _inputUnlocked = false;
  private _myGrant: GrantBody | null = null;
  private lastGrantSeqSeen = 0;
  private signed = false;
  private hostLost = false;
  private transferAccepts = new Set<PlayerId>();
  private readonly gone = new Set<PlayerId>();
  private detached = false;
  private readonly unsubscribe: (() => void)[] = [];

  constructor(opts: ClientOptions, session?: Session) {
    this.s = session ?? new Session({ transport: opts.transport, keys: opts.keys, clock: opts.clock });
    if (opts.participant.playerId !== this.s.localId) throw new Error('participant.playerId must equal transport.localId');
    this.participant = { ...opts.participant, publicKey: this.s.keys.publicKeyB64 };
    this.game = { ...opts.game };
    this.throwdownCode = opts.throwdownCode;
    this.companionVersion = opts.companionVersion ?? '0.1.0';
    this.explicitHostId = opts.hostId ?? null;
    this.hostTimeouts = opts.hostTimeouts ?? {};
    this.attach();
  }

  /** Continue an in-progress match as a client on an existing session (a host that stepped down). */
  static adopt(session: Session, opts: AdoptOptions): ClientMatch {
    const client = new ClientMatch(
      {
        transport: session.transport,
        keys: session.keys,
        participant: opts.participant,
        game: opts.game,
        throwdownCode: opts.throwdownCode,
        companionVersion: opts.companionVersion,
        hostTimeouts: opts.hostTimeouts,
      },
      session,
    );
    client.joined = true;
    for (const id of opts.gone ?? []) client.gone.add(id);
    return client;
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

  get hostId(): PlayerId | null {
    return this.s.state.hostId ?? this.ackHostId ?? this.explicitHostId;
  }

  get hostPublicKey(): string | null {
    return this.s.state.hostPublicKey ?? this.ackHostKey;
  }

  get inputUnlocked(): boolean {
    return this._inputUnlocked;
  }

  get myGrant(): GrantBody | null {
    return this._myGrant;
  }

  get isJoined(): boolean {
    return this.joined;
  }

  get refused(): PayloadOf<'REFUSE'> | null {
    return this.refusedWith;
  }

  on<K extends keyof ClientEvents>(name: K, cb: (payload: ClientEvents[K]) => void): () => void {
    return this.events.on(name, cb);
  }

  snapshot(): { role: 'client'; state: MatchState; log: LogHead; inputUnlocked: boolean; myGrant: GrantBody | null; hostId: PlayerId | null; signed: boolean } {
    return {
      role: 'client',
      state: cloneState(this.s.state),
      log: this.s.log.head(),
      inputUnlocked: this._inputUnlocked,
      myGrant: this._myGrant,
      hostId: this.hostId,
      signed: this.signed,
    };
  }

  join(): void {
    this.assertActive();
    if (this.joined) throw new Error('already joined');
    const msg = this.s.build(
      'HELLO',
      { protocolVersion: PROTOCOL_VERSION, companionVersion: this.companionVersion, throwdownCode: this.throwdownCode, participant: this.participant, game: this.game },
      null,
    );
    this.s.transport.send(this.explicitHostId ?? 'all', msg);
  }

  /** Answer the held grant. Locks input again. `override` exists so tests can send bad grantSeqs. */
  reportBallEnd(
    finalScore: number,
    detectorReason: PayloadOf<'BALL_END'>['detectorReason'],
    shootAgain = false,
    override: { grantSeq?: number; ballNumber?: number } = {},
  ): Message<'BALL_END'> {
    this.assertActive();
    const g = this._myGrant;
    const grantSeq = override.grantSeq ?? g?.grantSeq;
    if (grantSeq === undefined) throw new Error('reportBallEnd: no grant held');
    const msg = this.s.build(
      'BALL_END',
      { grantSeq, ballNumber: override.ballNumber ?? g?.ballNumber ?? 1, finalScore, detectorReason, shootAgain },
      this.matchIdForWire(),
    );
    if (override.grantSeq === undefined) {
      this._inputUnlocked = false;
      this._myGrant = null;
    }
    this.sendToHost(msg);
    return msg;
  }

  reportState(state: Omit<PayloadOf<'STATE'>, 'extraBalls'> & { extraBalls?: number }): void {
    this.assertActive();
    this.sendToHost(this.s.build('STATE', state, this.matchIdForWire()));
  }

  reportDmd(frame: PayloadOf<'DMD_FRAME'>): void {
    this.assertActive();
    this.sendToHost(this.s.build('DMD_FRAME', frame, this.matchIdForWire()));
  }

  reportGameOver(finalScore: number, ballsPlayed: number): void {
    this.assertActive();
    this._inputUnlocked = false;
    this._myGrant = null;
    this.sendToHost(this.s.build('GAME_OVER', { finalScore, ballsPlayed }, this.matchIdForWire()));
  }

  forfeit(reason: string): void {
    this.assertActive();
    this.sendToHost(this.s.build('FORFEIT', { player: this.localId, reason }, this.matchIdForWire()));
  }

  pause(reason: PayloadOf<'PAUSE'>['reason'] = 'requested'): void {
    this.assertActive();
    this.sendToHost(this.s.build('PAUSE', { reason, player: this.localId }, this.matchIdForWire()));
  }

  resume(): void {
    this.assertActive();
    this.sendToHost(this.s.build('RESUME', {}, this.matchIdForWire()));
  }

  close(): void {
    this.detach();
  }

  // ------------------------------------------------------------------------------------------
  // Plumbing
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
  }

  private assertActive(): void {
    if (this.detached) throw new Error('this ClientMatch has become host or been closed');
  }

  private matchIdForWire(): string {
    return this.s.state.matchId ?? this.throwdownCode;
  }

  private sendToHost(msg: AnyMessage): void {
    this.s.transport.send(this.hostId ?? 'all', msg);
  }

  private drop(msg: AnyMessage, reason: DroppedInfo['reason']): void {
    this.events.emit('dropped', { from: msg.from, type: msg.type, seq: msg.seq, reason });
  }

  // ------------------------------------------------------------------------------------------
  // Inbound dispatch
  // ------------------------------------------------------------------------------------------

  /** Public so a stepping-down HostMatch can hand the triggering frame to its successor client. */
  handle(linkFrom: PlayerId, msg: AnyMessage, opts: { seqChecked?: boolean } = {}): void {
    if (this.detached) return;
    if (!opts.seqChecked && !this.s.checkSeq(msg.from, msg.seq)) {
      this.drop(msg, 'seq');
      return;
    }
    if (!this.joined) {
      if (msg.type === 'HELLO_ACK') {
        this.joined = true;
        this.ackHostId = msg.payload.hostPlayerId;
        this.ackHostKey = msg.payload.hostPublicKey;
        this.events.emit('joined', msg.payload);
      } else if (msg.type === 'REFUSE') {
        this.refusedWith = msg.payload;
        this.events.emit('refused', msg.payload);
      }
      return;
    }
    const pt = this.s.state.pendingTransfer;
    if (pt && pt.newHost !== null && pt.newHost !== this.localId && pt.newHost === msg.from && HOST_ONLY_TYPES.has(msg.type)) {
      this.commitTransferAsClient();
    }
    if (msg.type === 'HOST_TRANSFER') {
      this.onHostTransfer(linkFrom, msg);
      return;
    }
    if (msg.type === 'HOST_TRANSFER_ACK') {
      this.onTransferAck(msg);
      return;
    }
    if (linkFrom !== this.hostId) {
      this.drop(msg, 'not_host');
      return;
    }
    switch (msg.type) {
      case 'MATCH_READY':
        if (msg.from !== this.hostId) return this.drop(msg, 'not_host');
        this.s.commit({ ts: msg.ts, kind: 'msg', from: msg.from, message: msg });
        this.events.emit('ready', msg.payload);
        return;
      case 'TURN_GRANT':
        this.onGrant(msg);
        return;
      case 'BALL_END':
        this.s.commit({ ts: msg.ts, kind: 'msg', from: msg.from, message: msg });
        if (msg.from === this.localId) {
          this._myGrant = null;
          this._inputUnlocked = false;
        }
        this.events.emit('ballEnd', msg);
        this.maybeSignLog();
        return;
      case 'GAME_OVER':
        this.s.commit({ ts: msg.ts, kind: 'msg', from: msg.from, message: msg });
        this.events.emit('gameOver', msg);
        this.maybeSignLog();
        return;
      case 'FORFEIT':
        this.s.commit({ ts: msg.ts, kind: 'msg', from: msg.from, message: msg });
        if (msg.payload.player === this.localId) {
          this._myGrant = null;
          this._inputUnlocked = false;
        }
        this.events.emit('forfeit', msg);
        this.maybeSignLog();
        return;
      case 'PAUSE':
        this.s.commit({ ts: msg.ts, kind: 'msg', from: msg.from, message: msg });
        this._inputUnlocked = false;
        this.events.emit('pause', msg.payload);
        return;
      case 'RESUME':
        this.s.commit({ ts: msg.ts, kind: 'msg', from: msg.from, message: msg });
        this.events.emit('resume', { from: msg.from });
        return;
      case 'STATE':
        this.events.emit('state', msg);
        return;
      case 'DMD_FRAME':
        this.events.emit('dmd', msg);
        return;
      case 'REJECT':
        this.events.emit('reject', msg.payload);
        return;
      case 'RESULT':
        this.onResult(msg);
        return;
      default:
        this.drop(msg, 'unexpected');
    }
  }

  private onGrant(msg: Message<'TURN_GRANT'>): void {
    const { grant, grantSig } = msg.payload;
    const key = this.hostPublicKey;
    if (!key || msg.from !== this.hostId) return this.drop(msg, 'not_host');
    if (!verifyCanonical(grant, grantSig, key)) return this.drop(msg, 'bad_signature');
    if (grant.grantSeq <= this.lastGrantSeqSeen) return this.drop(msg, 'stale_grant');
    const head = this.s.log.head();
    if (grant.logHash !== head.hash) this.events.emit('desync', { context: 'grant.logHash', expected: grant.logHash, actual: head.hash });
    this.lastGrantSeqSeen = grant.grantSeq;
    this.s.commit({ ts: msg.ts, kind: 'grant', from: msg.from, message: msg });
    this.events.emit('grant', grant);
    if (grant.player === this.localId) {
      this._myGrant = grant;
      this._inputUnlocked = true;
      this.events.emit('myTurn', grant);
    } else {
      this._myGrant = null;
      this._inputUnlocked = false;
    }
  }

  private maybeSignLog(): void {
    const st = this.s.state;
    if (this.signed || st.phase !== 'ended' || !st.matchId) return;
    this.signed = true;
    const head = this.s.log.head();
    const payload: PayloadOf<'LOG_SIGN'> = {
      logHash: head.hash,
      logLength: head.length,
      signature: signCanonical(logSignBody(st.matchId, head.hash, head.length), this.s.keys.privateKey),
    };
    this.sendToHost(this.s.build('LOG_SIGN', payload, st.matchId));
    this.events.emit('logSigned', payload);
  }

  private onResult(msg: Message<'RESULT'>): void {
    const r = msg.payload;
    const key = this.hostPublicKey;
    const head = this.s.log.head();
    const logMatches = r.logHash === head.hash && r.logLength === head.length;
    const signatureValid = key !== null && verifyCanonical(logSignBody(r.matchId, r.logHash, r.logLength), r.hostSignature, key);
    if (!logMatches) this.events.emit('desync', { context: 'result.logHash', expected: r.logHash, actual: head.hash });
    this.events.emit('result', { result: r, logMatches, signatureValid });
  }

  // ------------------------------------------------------------------------------------------
  // Host transfer
  // ------------------------------------------------------------------------------------------

  private onPeerLeave(peer: PlayerId): void {
    if (this.detached) return;
    this.events.emit('peerLeft', peer);
    if (peer === this.hostId && this.s.state.phase === 'running' && !this.s.state.pendingTransfer && !this.hostLost) {
      this.hostLost = true;
      this.events.emit('hostLost', peer);
      this.proposeIfCandidate();
      return;
    }
    this.gone.add(peer);
  }

  private votingParticipants(): PlayerId[] {
    const hostId = this.hostId;
    return remainingParticipants(this.s.state).filter((id) => !this.gone.has(id) && !(this.hostLost && id === hostId));
  }

  /** Host gone: the lowest remaining playerId proposes itself. */
  private proposeIfCandidate(): void {
    const candidates = this.votingParticipants().sort();
    if (candidates[0] !== this.localId) return;
    const st = this.s.state;
    const head = this.s.log.head();
    const msg = this.s.build(
      'HOST_TRANSFER',
      {
        proposer: this.localId,
        reason: 'host_left',
        logHash: head.hash,
        logLength: head.length,
        currentGrant: st.currentGrant,
        newHostPublicKey: this.publicKey,
      },
      this.matchIdForWire(),
    );
    this.s.commit({ ts: msg.ts, kind: 'msg', from: this.localId, message: msg });
    this.s.transport.send('all', msg);
    this.transferAccepts = new Set([this.localId]);
    this.events.emit('transferProposed', msg.payload);
    this.checkTransferMajority();
  }

  private onHostTransfer(linkFrom: PlayerId, msg: Message<'HOST_TRANSFER'>): void {
    const st = this.s.state;
    const p = msg.payload;
    if (st.phase !== 'running' || st.pendingTransfer) return this.drop(msg, 'unexpected');
    if (p.reason === 'host_requested') {
      if (msg.from !== this.hostId || linkFrom !== this.hostId) return this.drop(msg, 'not_host');
    } else {
      if (!this.hostLost || msg.from !== p.proposer || !st.players[msg.from]) return this.drop(msg, 'unexpected');
    }
    const headBefore = this.s.log.head();
    const target = st.participants.find((x) => x.publicKey === p.newHostPublicKey);
    const accept = target !== undefined && p.logHash === headBefore.hash && p.logLength === headBefore.length;
    this.s.commit({ ts: msg.ts, kind: 'msg', from: msg.from, message: msg });
    this.events.emit('transferProposed', p);
    const ack = this.s.build('HOST_TRANSFER_ACK', { proposer: p.proposer, accept, logHash: headBefore.hash }, this.matchIdForWire());
    this.s.transport.send('all', ack);
    this.transferAccepts = accept ? new Set([p.proposer, this.localId]) : new Set([p.proposer]);
    if (this.s.state.pendingTransfer?.newHost === this.localId) this.checkTransferMajority();
  }

  private onTransferAck(msg: Message<'HOST_TRANSFER_ACK'>): void {
    const pt = this.s.state.pendingTransfer;
    if (!pt || msg.payload.proposer !== pt.proposer) return this.drop(msg, 'unexpected');
    this.events.emit('transferAck', msg);
    if (msg.payload.accept && msg.payload.logHash === pt.logHash) this.transferAccepts.add(msg.from);
    if (pt.newHost === this.localId) this.checkTransferMajority();
  }

  private checkTransferMajority(): void {
    const pt = this.s.state.pendingTransfer;
    if (!pt || pt.newHost !== this.localId) return;
    const remaining = this.votingParticipants();
    const accepts = [...this.transferAccepts].filter((id) => remaining.includes(id)).length;
    if (isStrictMajority(accepts, remaining.length)) this.commitAndBecomeHost();
  }

  private commitTransferEvent(): { oldHost: PlayerId; newHost: PlayerId } | null {
    const pt = this.s.state.pendingTransfer;
    const oldHost = this.s.state.hostId;
    if (!pt || !pt.newHost || !oldHost) return null;
    this.s.commit({
      ts: pt.proposedTs,
      kind: 'event',
      from: oldHost,
      event: { type: 'host_transfer', reason: pt.reason, proposer: pt.proposer, from: oldHost, to: pt.newHost, newHostPublicKey: pt.newHostPublicKey },
    });
    if (this.hostLost) {
      this.gone.add(oldHost);
      this.hostLost = false;
    }
    this.transferAccepts.clear();
    return { oldHost, newHost: pt.newHost };
  }

  private commitTransferAsClient(): void {
    const done = this.commitTransferEvent();
    if (done) this.events.emit('hostChanged', { from: done.oldHost, to: done.newHost });
  }

  private commitAndBecomeHost(): void {
    const done = this.commitTransferEvent();
    if (!done) return;
    this.detach();
    const host = HostMatch.resumeFromLog(this.s.log, {
      transport: this.s.transport,
      keys: this.s.keys,
      clock: this.s.clock,
      session: this.s,
      gone: this.gone,
      ...this.hostTimeouts,
    });
    this.events.emit('hostChanged', { from: done.oldHost, to: done.newHost });
    this.events.emit('becameHost', host);
    host.run();
  }
}
