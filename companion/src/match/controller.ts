/**
 * MatchController (A6 + C3, docs/design/alpha-match.md §3, 2026-10-30): the match as this companion's player lives
 * it. It sits between one role object of the engine (a `HostMatch`, which also plays, or a `ClientMatch`), the turn
 * lock the hook reads, the audio cue and the media layer, and turns the witness's detector events into the engine's
 * BALL_END / GAME_OVER / STATE. Pure: no Electron, no file system, no timers of its own (the caller passes them), so
 * every step is unit-tested against the real engine on a MemoryBus.
 *
 * Rules (§3):
 * - Locked the moment the match starts (MATCH_READY); unlocked by a verified grant for this player (a client's
 *   `myTurn`, which the engine raises only after checking the host's signature; the host signed its own); locked
 *   again as soon as this player's ball end is reported (the next grant is someone else's, or a shoot-again grant
 *   unlocks it at once); unlocked when the RESULT is in, so solo play works again.
 * - While this player holds a grant: `current_scores` → STATE (at most 10 a second; player 1's score: every game
 *   in a match is a one-player game); `ball_end` → wait for the next `current_scores` (the end-of-ball bonus) or
 *   2 s, then BALL_END with `shootAgain` when the machine says an extra ball is pending; `game_end` → GAME_OVER
 *   unless the last ball end already finished this player's game; `game_abandoned` / `table_exit` → FORFEIT.
 * - The bookkeeping (lock, `setSending(false)`) happens before the engine call: a HostMatch answers its own
 *   BALL_END synchronously, so the next grant (a shoot-again one for this player) arrives inside that call.
 * - Media: attached at `open()` (host / join time) with no peers so the panel can show before the match; peers are
 *   added at MATCH_READY, removed when they leave, re-added when they reconnect. Video only from the player up.
 */
import type { GrantBody, ParticipantInfo, PayloadOf, PlayerId } from '@castcade/protocol';
import type { MatchMedia, MediaSignal, MediaSignalling, PanelState } from '../media/match-media-types.js';
import type { GameEvent } from '../witness/journal-detector.js';
import type { ClientMatch } from './client.js';
import type { HostMatch } from './host.js';
import type { MatchState } from './state.js';

/** What a host-side role must offer (structurally a HostMatch; tests may pass the real one). */
export type HostRole = Pick<HostMatch, 'localId' | 'state' | 'roster' | 'on' | 'localBallEnd' | 'localState' | 'localGameOver' | 'forfeit'>;
/** What a client-side role must offer (structurally a ClientMatch). */
export type ClientRole = Pick<ClientMatch, 'localId' | 'state' | 'on' | 'reportBallEnd' | 'reportState' | 'reportGameOver' | 'forfeit'>;
export type MatchRole = HostRole | ClientRole;

/** A HostMatch plays through `local*`; a ClientMatch through `report*` (host.ts / client.ts). */
export function isHostRole(role: MatchRole): role is HostRole {
  return typeof (role as Partial<HostRole>).localBallEnd === 'function';
}

export type CueKind = 'your_turn' | 'opponent_turn' | 'match_over';

/** What the witness feeds in: every detector game event, plus `table_exit` when VPX closes. */
export type ControllerFeed = GameEvent | { kind: 'table_exit' };

export type ControllerPhase = 'lobby' | 'playing' | 'paused' | 'over';

export interface ControllerStatus {
  phase: ControllerPhase;
  locked: boolean;
  /** This player holds the outstanding grant (playing a ball now). */
  myTurn: boolean;
  /** Lobby roster before the start, the MATCH_READY roster after. */
  participants: ParticipantInfo[];
  hostId: PlayerId | null;
  /** Players whose GameFingerprint differed from the host's at HELLO (advisory). */
  tableMismatch: PlayerId[];
  panel: PanelState;
}

export interface MatchControllerOptions {
  role: MatchRole;
  localId: PlayerId;
  lock: { lock(): void; unlock(): void };
  cue: { play(kind: CueKind): void };
  media?: MatchMedia;
  /** How the media layer reaches the other players (MEDIA_SIGNAL, D2); absent → media gets a mute signalling. */
  signalling?: MediaSignalling;
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  log(line: string): void;
  /** Wait this long after a ball end for the bonus to land in the score. Default 2 s (§1 step 6). */
  ballEndSettleMs?: number;
  /** Minimum gap between two STATEs. Default 100 ms (the protocol's 10 Hz). */
  stateIntervalMs?: number;
  /** For the panel before MATCH_READY says it (the host knows its own choice; a client learns it at the start). */
  ballsPerGame?: number;
}

const DEFAULT_SETTLE_MS = 2000;
const DEFAULT_STATE_INTERVAL_MS = 100;
const MAX_SCORE = 1_000_000_000_000;

interface PendingBallEnd {
  grant: GrantBody;
  shootAgain: boolean;
  timer: unknown;
}

/** A signalling that goes nowhere: what the media layer gets until MEDIA_SIGNAL is wired (D2). */
export function muteSignalling(localId: PlayerId): MediaSignalling {
  return {
    localId,
    send: (_to: PlayerId, _signal: MediaSignal) => undefined,
    onSignal: () => () => undefined,
  };
}

function cleanScore(v: number | null | undefined): number | null {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  return Math.min(MAX_SCORE, Math.max(0, Math.round(v)));
}

export class MatchController {
  private role: MatchRole;
  private readonly localId: PlayerId;
  private readonly opts: MatchControllerOptions;
  private readonly settleMs: number;
  private readonly stateIntervalMs: number;
  private offs: (() => void)[] = [];
  private readonly listeners = new Set<(s: ControllerStatus) => void>();

  private phase: ControllerPhase = 'lobby';
  private locked = false;
  private lobby: ParticipantInfo[] = [];
  private hostId: PlayerId | null = null;
  /** The grant this player is playing, from its arrival until the ball end is reported. */
  private holding: GrantBody | null = null;
  private pending: PendingBallEnd | null = null;
  /** Who is up (the last grant), and on which ball. */
  private upPlayer: PlayerId | null = null;
  private upBall: number | null = null;
  /** This player's balls finished, by its own reports (a client's state lags the host's echo). */
  private myBallsDone = 0;
  private myScore: number | null = null;
  private myGameOver = false;
  /** Latest score known per player: STATE, BALL_END, GAME_OVER. */
  private readonly scores = new Map<PlayerId, number>();
  private readonly mismatch = new Map<PlayerId, string[]>();
  private readonly left = new Set<PlayerId>();
  private result: PanelState['result'] = null;
  private message: string | null = null;
  private lastStateAt = Number.NEGATIVE_INFINITY;
  private stateTimer: unknown = null;
  private attached: Promise<void> | null = null;
  private lastPanel: string | null = null;
  private closed = false;

  constructor(opts: MatchControllerOptions) {
    this.opts = opts;
    this.role = opts.role;
    this.localId = opts.localId;
    this.settleMs = opts.ballEndSettleMs ?? DEFAULT_SETTLE_MS;
    this.stateIntervalMs = opts.stateIntervalMs ?? DEFAULT_STATE_INTERVAL_MS;
    this.bind(opts.role);
  }

  /** The role in charge now (it changes after a host transfer). */
  get currentRole(): MatchRole {
    return this.role;
  }

  /** Attach the media layer with no peers yet and push the first panel (host / join time; coordinator 2026-10-30). */
  async open(): Promise<void> {
    this.push(true);
    await this.ensureAttached();
  }

  status(): ControllerStatus {
    return {
      phase: this.phase,
      locked: this.locked,
      myTurn: this.holding !== null,
      participants: this.participants().map((p) => ({ ...p })),
      hostId: this.hostId,
      tableMismatch: [...this.mismatch.keys()],
      panel: this.panel(),
    };
  }

  onChange(cb: (s: ControllerStatus) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /** A participant whose fingerprint differed from the host's (`fields`: the GameFingerprint fields). Advisory. */
  noteTableMismatch(player: PlayerId, fields: string[]): void {
    this.mismatch.set(player, [...fields]);
    this.push();
  }

  /** One line for the player (an error from the shell); null clears it. */
  setMessage(message: string | null): void {
    this.message = message;
    this.push();
  }

  /** Re-push the panel (the media layer's mic state changed). */
  refresh(): void {
    this.push();
  }

  feed(ev: ControllerFeed): void {
    if (this.closed) return;
    switch (ev.kind) {
      case 'current_scores': {
        if (!this.holding) return;
        const score = cleanScore(ev.scores[0]);
        if (score !== null) {
          this.myScore = score;
          this.scores.set(this.localId, score);
        }
        if (this.pending) {
          this.flushBallEnd();
          return;
        }
        this.queueState();
        this.push();
        return;
      }
      case 'ball_end': {
        if (!this.holding || this.pending) return;
        const grant = this.holding;
        const shootAgain = (ev.extraBalls ?? 0) > 0;
        this.pending = { grant, shootAgain, timer: this.opts.setTimeout(() => this.flushBallEnd(), this.settleMs) };
        this.opts.log(`match: ball ${grant.ballNumber} ended on the table${shootAgain ? ' (shoot again)' : ''}; reporting once the bonus is in`);
        return;
      }
      case 'game_end': {
        if (!this.inPlay()) return;
        const score = cleanScore(ev.scores[0]);
        if (score !== null) {
          this.myScore = score;
          this.scores.set(this.localId, score);
        }
        if (this.pending) this.flushBallEnd();
        if (this.myGameDone()) return;
        this.reportGameOver();
        return;
      }
      case 'game_abandoned':
      case 'table_exit': {
        if (!this.inPlay() || this.myGameDone()) return;
        this.forfeit('table closed');
        return;
      }
      default:
        return;
    }
  }

  /** Unlock, stop sending, detach media, stop listening to the role. The caller closes the role and transport. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.clearPending();
    this.clearStateTimer();
    for (const off of this.offs) off();
    this.offs = [];
    this.setLocked(false);
    this.listeners.clear();
    const media = this.opts.media;
    if (media && this.attached) {
      media.setSending(false);
      await this.attached;
      await media.detach().catch((e: unknown) => this.opts.log(`match: media detach failed: ${String(e)}`));
    }
  }

  /** The player leaves mid-match: forfeit while their game is still on (the engine then plays on without them). */
  leave(reason: string): void {
    if (this.closed || !this.inPlay() || this.myGameDone()) return;
    this.forfeit(reason);
  }

  // ------------------------------------------------------------------------------------------
  // Engine events
  // ------------------------------------------------------------------------------------------

  private bind(role: MatchRole): void {
    for (const off of this.offs) off();
    this.offs = [];
    this.role = role;
    if (isHostRole(role)) this.bindHost(role);
    else this.bindClient(role);
  }

  private bindHost(h: HostRole): void {
    this.hostId = this.localId;
    this.lobby = h.roster();
    const offs = this.offs;
    offs.push(h.on('joined', () => this.onLobby(h.roster())));
    offs.push(
      h.on('refused', (r) => {
        if (r.refuse.code !== 'fingerprint_mismatch') return;
        // The client re-joins with the host's fingerprint (main/match-host.ts): the table check is advisory (§3).
        this.mismatch.set(r.playerId, r.refuse.mismatches.map((m) => m.field));
        this.push();
      }),
    );
    offs.push(h.on('ready', (p) => this.onReady(p)));
    offs.push(h.on('grant', (g) => this.onGrant(g, g.player === this.localId)));
    offs.push(h.on('ballEnd', (m) => this.onBallEndMsg(m.from, m.payload.finalScore)));
    offs.push(h.on('gameOver', (m) => this.onScoreMsg(m.from, m.payload.finalScore)));
    offs.push(h.on('forfeit', () => this.push()));
    offs.push(h.on('state', (m) => this.onScoreMsg(m.from, m.payload.score)));
    offs.push(h.on('pause', () => this.onPause()));
    offs.push(h.on('resume', () => this.onResume()));
    offs.push(
      h.on('reject', (r) => {
        if (r.to === this.localId) this.onReject(r);
      }),
    );
    offs.push(h.on('peerLeft', (id) => this.onPeerLeft(id)));
    offs.push(h.on('reconnected', (r) => this.onPeerBack(r.playerId)));
    offs.push(h.on('result', (r) => this.onResult(r.result)));
    offs.push(
      h.on('hostTransfer', (t) => {
        this.opts.log(`match: host handed over to ${t.to}; continuing as a client`);
        this.bind(t.client);
        this.hostId = t.to;
        this.push();
      }),
    );
  }

  private bindClient(c: ClientRole): void {
    this.hostId = c.state.hostId ?? this.hostId;
    if (c.state.phase !== 'lobby') this.lobby = c.state.participants.map((p) => ({ ...p }));
    const offs = this.offs;
    offs.push(
      c.on('joined', (ack) => {
        this.hostId = ack.hostPlayerId;
        this.onLobby(ack.participants);
      }),
    );
    offs.push(c.on('ready', (p) => this.onReady(p)));
    // `grant` comes for every grant; this player's own is acted on at `myTurn`, raised only once its signature verified.
    offs.push(
      c.on('grant', (g) => {
        if (g.player !== this.localId) this.onGrant(g, false);
      }),
    );
    offs.push(c.on('myTurn', (g) => this.onGrant(g, true)));
    offs.push(c.on('ballEnd', (m) => this.onBallEndMsg(m.from, m.payload.finalScore)));
    offs.push(c.on('gameOver', (m) => this.onScoreMsg(m.from, m.payload.finalScore)));
    offs.push(c.on('forfeit', () => this.push()));
    offs.push(c.on('state', (m) => this.onScoreMsg(m.from, m.payload.score)));
    offs.push(c.on('pause', () => this.onPause()));
    offs.push(c.on('resume', () => this.onResume()));
    offs.push(c.on('reject', (r) => this.onReject(r)));
    offs.push(c.on('peerLeft', (id) => this.onPeerLeft(id)));
    offs.push(c.on('reconnected', (r) => this.onPeerBack(r.host)));
    offs.push(
      c.on('hostChanged', (h) => {
        this.hostId = h.to;
        this.push();
      }),
    );
    offs.push(c.on('desync', (d) => this.opts.log(`match: log desync (${d.context}): expected ${d.expected}, have ${d.actual}`)));
    offs.push(c.on('result', (r) => this.onResult(r.result)));
    offs.push(
      c.on('becameHost', (h) => {
        this.opts.log('match: this companion is the host now');
        this.bind(h);
        this.push();
      }),
    );
  }

  private onLobby(participants: ParticipantInfo[]): void {
    this.lobby = participants.map((p) => ({ ...p }));
    this.push();
  }

  private onReady(p: PayloadOf<'MATCH_READY'>): void {
    this.phase = 'playing';
    this.hostId = p.hostPlayerId;
    this.lobby = p.participants.map((x) => ({ ...x }));
    this.message = null;
    // Locked from the start: each player begins their own game when their first grant arrives (§1 step 4).
    this.setLocked(true);
    const peers = p.playerOrder.filter((id) => id !== this.localId);
    void this.ensureAttached().then(() => {
      if (this.closed) return;
      for (const id of peers) this.opts.media?.addPeer(id);
    });
    this.push();
  }

  private onGrant(g: GrantBody, mine: boolean): void {
    const changed = this.upPlayer !== g.player;
    this.upPlayer = g.player;
    this.upBall = g.ballNumber;
    if (this.phase === 'lobby' || this.phase === 'paused') this.phase = 'playing';
    if (mine) {
      const was = this.holding;
      this.holding = g;
      this.setLocked(false);
      if (!was) {
        this.opts.cue.play('your_turn');
        this.opts.media?.setSending(true);
        this.opts.log(`match: grant ${g.grantSeq}: my ball ${g.ballNumber}`);
      }
    } else {
      if (this.holding) {
        // A grant for someone else while this player still held one (a re-issue after a transfer): stop playing.
        this.holding = null;
        this.clearPending();
        this.opts.media?.setSending(false);
      }
      this.setLocked(true);
      if (changed) this.opts.cue.play('opponent_turn');
    }
    this.push();
  }

  private onBallEndMsg(from: PlayerId, finalScore: number): void {
    this.scores.set(from, finalScore);
    if (this.upPlayer === from && this.role.state.currentGrant === null) this.upBall = null;
    this.push();
  }

  private onScoreMsg(from: PlayerId, score: number): void {
    if (from === this.localId) return;
    this.scores.set(from, score);
    this.push();
  }

  private onPause(): void {
    if (this.phase === 'over') return;
    // The player up keeps the table: locking mid-ball would drain it. A re-issued grant follows the RESUME.
    this.phase = 'paused';
    this.push();
  }

  private onResume(): void {
    if (this.phase === 'paused') this.phase = 'playing';
    this.push();
  }

  private onReject(r: PayloadOf<'REJECT'>): void {
    this.message = `The host rejected ${r.refType}: ${r.message}`;
    this.opts.log(`match: ${this.message} (${r.code})`);
    this.push();
  }

  private onPeerLeft(id: PlayerId): void {
    this.left.add(id);
    this.opts.media?.removePeer(id);
    if (isHostRole(this.role)) this.lobby = this.role.state.phase === 'lobby' ? this.role.roster() : this.lobby;
    this.push();
  }

  private onPeerBack(id: PlayerId): void {
    this.left.delete(id);
    if (this.phase !== 'lobby') this.opts.media?.addPeer(id);
    this.push();
  }

  private onResult(r: PayloadOf<'RESULT'>): void {
    if (this.phase === 'over') return;
    this.phase = 'over';
    this.clearPending();
    this.clearStateTimer();
    this.holding = null;
    this.upPlayer = null;
    this.upBall = null;
    this.opts.media?.setSending(false);
    const name = (id: PlayerId): string => this.participants().find((p) => p.playerId === id)?.displayName ?? id;
    this.result = [...r.entries]
      .sort((a, b) => a.rank - b.rank || b.score - a.score)
      .map((e) => ({ id: e.playerId, name: name(e.playerId), score: e.score, place: e.rank }));
    for (const e of r.entries) this.scores.set(e.playerId, e.score);
    this.setLocked(false);
    this.opts.cue.play('match_over');
    this.opts.log(`match: result ${this.result.map((x) => `${x.place}. ${x.name} ${x.score}`).join(', ')}`);
    this.push();
  }

  // ------------------------------------------------------------------------------------------
  // This player's reports
  // ------------------------------------------------------------------------------------------

  private inPlay(): boolean {
    return (this.phase === 'playing' || this.phase === 'paused') && !this.myGameOver;
  }

  private myGameDone(): boolean {
    if (this.myGameOver) return true;
    const st: MatchState = this.role.state;
    const p = st.players[this.localId];
    if (p && p.status !== 'playing') return true;
    return st.ballsPerGame > 0 && this.myBallsDone >= st.ballsPerGame;
  }

  private flushBallEnd(): void {
    const p = this.pending;
    if (!p) return;
    this.clearPending();
    this.clearStateTimer();
    const finalScore = this.myScore ?? 0;
    if (!p.shootAgain) this.myBallsDone = Math.max(this.myBallsDone, p.grant.ballNumber);
    this.scores.set(this.localId, finalScore);
    // Bookkeeping first: a HostMatch issues the next grant inside localBallEnd.
    this.holding = null;
    this.opts.media?.setSending(false);
    this.setLocked(true);
    this.opts.log(`match: BALL_END ball ${p.grant.ballNumber} score ${finalScore}${p.shootAgain ? ' (shoot again)' : ''}`);
    this.call(() => {
      const r = this.role;
      if (isHostRole(r)) r.localBallEnd(finalScore, 'nvram', p.shootAgain);
      else r.reportBallEnd(finalScore, 'nvram', p.shootAgain);
    }, 'BALL_END');
    this.push();
  }

  private reportGameOver(): void {
    const finalScore = this.myScore ?? 0;
    const balls = Math.max(this.myBallsDone, this.holding?.ballNumber ?? 0);
    this.myGameOver = true;
    this.holding = null;
    this.clearStateTimer();
    this.opts.media?.setSending(false);
    this.setLocked(true);
    this.opts.log(`match: GAME_OVER score ${finalScore} after ${balls} ball(s)`);
    this.call(() => {
      const r = this.role;
      if (isHostRole(r)) r.localGameOver(finalScore, balls);
      else r.reportGameOver(finalScore, balls);
    }, 'GAME_OVER');
    this.push();
  }

  private forfeit(reason: string): void {
    this.myGameOver = true;
    this.holding = null;
    this.clearPending();
    this.clearStateTimer();
    this.opts.media?.setSending(false);
    this.setLocked(true);
    this.opts.log(`match: FORFEIT (${reason})`);
    this.call(() => {
      const r = this.role;
      if (isHostRole(r)) r.forfeit(this.localId, reason);
      else r.forfeit(reason);
    }, 'FORFEIT');
    this.push();
  }

  private queueState(): void {
    if (this.stateTimer !== null) return;
    const wait = this.lastStateAt + this.stateIntervalMs - this.opts.now();
    if (wait <= 0) {
      this.sendState();
      return;
    }
    this.stateTimer = this.opts.setTimeout(() => {
      this.stateTimer = null;
      this.sendState();
    }, wait);
  }

  private sendState(): void {
    const g = this.holding;
    if (!g || this.pending || this.closed) return;
    this.lastStateAt = this.opts.now();
    const state = { ballNumber: g.ballNumber, score: this.myScore ?? 0, ballInPlay: true, tilt: false };
    this.call(() => {
      const r = this.role;
      if (isHostRole(r)) r.localState(state);
      else r.reportState(state);
    }, 'STATE');
  }

  private call(fn: () => void, what: string): void {
    try {
      fn();
    } catch (e) {
      this.message = `Could not send ${what}: ${e instanceof Error ? e.message : String(e)}`;
      this.opts.log(`match: ${this.message}`);
    }
  }

  private clearPending(): void {
    if (this.pending) this.opts.clearTimeout(this.pending.timer);
    this.pending = null;
  }

  private clearStateTimer(): void {
    if (this.stateTimer !== null) this.opts.clearTimeout(this.stateTimer);
    this.stateTimer = null;
  }

  private setLocked(on: boolean): void {
    if (this.locked === on) return;
    this.locked = on;
    try {
      if (on) this.opts.lock.lock();
      else this.opts.lock.unlock();
    } catch (e) {
      this.opts.log(`match: could not ${on ? 'lock' : 'unlock'} the table: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private ensureAttached(): Promise<void> {
    const media = this.opts.media;
    if (!media) return Promise.resolve();
    if (!this.attached) {
      const signalling = this.opts.signalling ?? muteSignalling(this.localId);
      this.attached = media.attach(signalling, []).catch((e: unknown) => {
        this.opts.log(`match: media attach failed: ${e instanceof Error ? e.message : String(e)}`);
      });
    }
    return this.attached;
  }

  // ------------------------------------------------------------------------------------------
  // Panel
  // ------------------------------------------------------------------------------------------

  private participants(): ParticipantInfo[] {
    const st = this.role.state;
    return st.phase === 'lobby' ? this.lobby : st.participants;
  }

  private nameOf(id: PlayerId | null): string {
    if (id === null) return '?';
    return this.participants().find((p) => p.playerId === id)?.displayName ?? id;
  }

  panel(): PanelState {
    const st = this.role.state;
    const players = this.participants().map((p) => {
      const prog = st.players[p.playerId];
      const flags: PanelState['players'][number]['flags'] = [];
      if (this.mismatch.has(p.playerId)) flags.push('table_mismatch');
      if (this.left.has(p.playerId) || prog?.connected === false) flags.push('disconnected');
      return {
        id: p.playerId,
        name: p.displayName,
        score: this.scores.get(p.playerId) ?? null,
        ballsDone: prog?.ballsPlayed ?? 0,
        isUp: this.phase !== 'over' && this.upPlayer === p.playerId,
        flags,
      };
    });
    const phase: PanelState['phase'] = this.phase === 'lobby' ? 'idle' : this.phase;
    const myTurn = this.phase !== 'over' && this.upPlayer !== null && this.upPlayer === this.localId;
    return {
      playerUp: this.phase === 'over' ? null : this.upPlayer,
      myTurn,
      ball: this.phase === 'over' ? null : this.upBall,
      ballsPerGame: st.ballsPerGame || (this.opts.ballsPerGame ?? 0),
      players,
      phase,
      result: this.result,
      message: this.panelMessage(),
      mic: this.opts.media?.status().mic ?? 'unavailable',
    };
  }

  private panelMessage(): string | null {
    if (this.message) return this.message;
    if (this.mismatch.size > 0 && this.phase !== 'over') {
      const who = [...this.mismatch.keys()].map((id) => (id === this.localId ? 'you' : this.nameOf(id)));
      const fields = new Set([...this.mismatch.values()].flat());
      const what = fields.has('tableHash') || fields.has('tableName') ? 'different table file' : fields.has('emulatorVersion') ? 'different VPX build' : 'different table setup';
      return `${what}: ${who.join(', ')}`;
    }
    const st = this.role.state;
    if (this.phase === 'lobby') return isHostRole(this.role) && this.participants().length >= 2 ? 'Everyone in? Press Start match' : isHostRole(this.role) ? 'Waiting for players' : 'Waiting for the host to start';
    if (this.phase === 'paused') {
      const who = st.paused?.player ?? null;
      return st.paused?.reason === 'disconnect' && who ? `Paused: waiting for ${this.nameOf(who)} to reconnect` : 'Paused';
    }
    if (this.phase === 'playing' && this.holding && this.holding.ballNumber === 1 && this.myScore === null) return 'Press Start on the table to begin your game';
    if (this.phase === 'playing' && this.myGameDone() && this.upPlayer !== this.localId) return 'Your game is over; the others are still playing';
    return null;
  }

  private push(force = false): void {
    if (this.closed && !force) return;
    const panel = this.panel();
    const text = JSON.stringify(panel);
    if (!force && text === this.lastPanel) return;
    this.lastPanel = text;
    this.opts.media?.setPanelState(panel);
    const s = this.status();
    for (const l of [...this.listeners]) l(s);
  }
}
