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
 * - A8 (2026-10-31): a client whose RECONNECT is accepted while the match is paused for ITS OWN drop sends RESUME
 *   (what the fake client does; the host never resumes on its own, A3). A pause nobody resumes is the host's Match
 *   tab's Resume button (`main/match-host.ts`). A host transfer under way is shown (`status().transfer`); the engine
 *   acks it by itself (accept = the same log head), so there is nothing for the player to decide.
 * - A10 (2026-11-02): a match is a series of games (docs/design/alpha-match.md §8). A game's RESULT puts the panel in
 *   `over` with the game's standings, the series so far and "Next game: <host> starts a game on the table"; the
 *   match stays open (peers, media, panel). The host's table is unlocked then and its own `game_start` starts the next
 *   game (`HostMatch.nextGame`, which refuses before the RESULT went out); a client's table stays locked until its
 *   grant in the next game. MATCH_END (the host's End match), or the host gone between games, ends the series:
 *   `seriesOver`, every table unlocked.
 * - A11 (2026-11-02): in the lobby the host's `game_start` starts the match: when two or more are in and every table
 *   is open, a 5 s countdown (`HostMatch.startIn`) the whole lobby sees ("Starting the match: <names>"); a second
 *   `game_start` changes nothing. With a table still loading the start is armed and fires once the last one opens;
 *   the host's game ending in the lobby disarms it. The desktop Start button works throughout.
 * - A12 (2026-11-05): no game before the match. The owner pressed Start before the other player joined; the join then
 *   started nothing. `preMatchPlay` decides the host's table in the lobby: `free` (default), the host may play, and a
 *   game running when the lobby becomes complete (two or more in, every table open) is never the match's game 1: the
 *   panel waits for it to end (`waitingForHostGame`), then the next `game_start` starts the countdown as in A11 (a
 *   second `game_start` with no `game_end` between is taken as that next game); `locked`, the host's table is locked
 *   from Host until the lobby is complete, locked again when it falls apart, and the lock rule above takes over at
 *   MATCH_READY. A client's table is never locked in the lobby. The A11 armed start (the host's press with everyone in
 *   and a table still loading) keeps its meaning: that game is game 1.
 * - A13 (2026-11-12, three matches stuck at grant 1 on an unpatched original): a turn only ends when the holder's
 *   companion reports BALL_END, which needs a table whose hook journal the witness follows. Each player says whether
 *   its open table is one (`setLocalBallEnds`, sent by the shell in HELLO / PARTICIPANT_UPDATE; the host's HELLO_ACK
 *   carries everyone's). The lobby line names every player whose table cannot report ball ends (`startWarnings`), a
 *   start from the host's table does not go while there is one (the Match tab's Start match asks the host to confirm
 *   instead), and during a game the host may `passTurn()`: the holder's ball ends by hand at its last known score
 *   (TURN_PASS, logged), for this host's own ball or a client's. The passed player's controller stops playing that
 *   ball at once (locked, nothing more reported for it).
 */
import type { GrantBody, ParticipantInfo, PayloadOf, PlayerId } from '@castcade/protocol';
import type { MatchMedia, MediaSignal, MediaSignalling, PanelState, VrViewMode } from '../media/match-media-types.js';
import type { GameEvent } from '../witness/journal-detector.js';
import type { ClientMatch } from './client.js';
import type { HostMatch } from './host.js';
import type { MatchState } from './state.js';

/** What a host-side role must offer (structurally a HostMatch; tests may pass the real one). */
export type HostRole = Pick<
  HostMatch,
  'localId' | 'state' | 'roster' | 'on' | 'localBallEnd' | 'localState' | 'localGameOver' | 'forfeit' | 'nextGame' | 'nextGameBlocker' | 'endMatch' | 'startIn' | 'loading' | 'ballEndReadiness' | 'passTurn' | 'passTurnBlocker'
>;
/** What a client-side role must offer (structurally a ClientMatch). */
export type ClientRole = Pick<ClientMatch, 'localId' | 'state' | 'on' | 'reportBallEnd' | 'reportState' | 'reportGameOver' | 'forfeit' | 'resume'>;
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
  /**
   * Players whose table differs from the host's (advisory): any GameFingerprint field but `emulatorVersion`. A VPX
   * build difference alone is not a table difference (D2.5, 2026-10-31): see `mismatches`.
   */
  tableMismatch: PlayerId[];
  /** The GameFingerprint fields that differ from the host's, per player (none: agrees); `mismatchWords` words them. */
  mismatches: Record<PlayerId, string[]>;
  /**
   * A12 (2026-11-05): the lobby is complete, but a game is running on the host's table (free play); the match starts
   * at the host's next Start after it ends. On the host only: the lobby's HELLO_ACK has no field for it.
   */
  waitingForHostGame: boolean;
  /** A8 (2026-10-31): a HOST_TRANSFER proposed and not committed yet (the log's `pendingTransfer`), else null. */
  transfer: { proposer: PlayerId; newHost: PlayerId | null; reason: 'host_left' | 'host_requested' } | null;
  /**
   * A10 (2026-11-02): the series: the game being played (or just played), whether it is over for good, and, for the
   * host between games, why the next game cannot start now (null: it can).
   */
  series: { game: number; over: boolean; nextGameBlocker: string | null };
  /**
   * A13 (2026-11-12): whether each player's table can report ball ends (its companion follows the table's hook
   * journal), as each said it; a player not listed is unknown (no table open yet). False: that player's turn never
   * ends by itself.
   */
  ballEnds: Record<PlayerId, boolean>;
  /** A13: in the lobby, one line per player whose table cannot report ball ends; a start then needs the host's confirmation. */
  startWarnings: string[];
  /** A13: for the host while a grant is outstanding: the turn Pass the turn would end, and the score it would end at. Else null. */
  pass: { player: PlayerId; name: string; ball: number; score: number } | null;
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
  /** A11: the countdown before a start from the host's table. Default 5 s. */
  startCountdownMs?: number;
  /** A12 (2026-11-05): the host's table in the lobby: free play (default) or locked until the lobby is complete. */
  preMatchPlay?: PreMatchPlay;
  /** A12: a game is already running on this player's table when the controller is made (the witness's live game). */
  tableGameRunning?: boolean;
}

/** A12 (2026-11-05): match.json `preMatchPlay` (main/match-setup.ts). */
export type PreMatchPlay = 'free' | 'locked';

/**
 * D2.5 (2026-10-31, the second two-player match): what a fingerprint difference means to a player. The two rigs ran
 * different VPX builds (10.8.0.2078.Panasony and 10.8.0.2058.800a99c); `emulatorVersion` carries the build, and the
 * panel read "different table file" although the table may have been the same. So the build is its own advisory note
 * (`build`), and the table line says what differs: another table (`tableName`, or the patch recipe), the same table
 * in another file (only `tableHash`: a re-save or another download), or something else of its setup (ROM, physics).
 */
export function mismatchWords(fields: readonly string[]): { table: string | null; build: string | null } {
  const f = new Set(fields);
  const build = f.has('emulatorVersion') ? 'different VPX build' : null;
  f.delete('emulatorVersion');
  let table: string | null = null;
  if (f.has('tableName') || f.has('recipeVersion')) table = 'different table file';
  else if (f.has('tableHash')) table = 'same table, different file (a re-save or another download)';
  else if (f.size > 0) table = 'different table setup';
  return { table, build };
}

const DEFAULT_SETTLE_MS = 2000;
const DEFAULT_START_COUNTDOWN_MS = 5000;
const DEFAULT_STATE_INTERVAL_MS = 100;
const MAX_SCORE = 1_000_000_000_000;

/**
 * D7.4 (2026-10-31): what the headset shows when (match.json, the Match tab). The owner: "I want to see his playfield
 * where my playfield was… not a window popup that I look at while he's playing". `theaterDuringMyTurn` (the name the
 * work item gave it) is what this player sees on their own ball: nothing over the table (`hidden`) or the panel.
 * `spectate` is what they see while another player is up: the theater (their video where the table was) or the panel.
 */
export interface VrViewSettings {
  theaterDuringMyTurn: 'hidden' | 'panel';
  spectate: 'theater' | 'panel';
}

export const DEFAULT_VR_VIEW: VrViewSettings = { theaterDuringMyTurn: 'hidden', spectate: 'theater' };

/**
 * D7.4: the headset's mode for a panel state. My ball → `theaterDuringMyTurn`; another player's ball → `spectate`;
 * the lobby, a pause (someone dropped: the panel says why), the gap between grants and the result → the panel.
 */
export function vrViewMode(p: Pick<PanelState, 'phase' | 'myTurn' | 'playerUp'>, settings: VrViewSettings = DEFAULT_VR_VIEW): VrViewMode {
  if (p.phase !== 'playing') return 'panel';
  if (p.myTurn) return settings.theaterDuringMyTurn;
  return p.playerUp !== null ? settings.spectate : 'panel';
}

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
  /**
   * A6.1 (2026-11-01): rigs that changed after MATCH_READY (`rigUpdated`), laid over the log's roster wherever this
   * controller shows a participant (the Match tab, the panel's `rig`, which the headset's stereo guess reads).
   */
  private readonly liveRigs = new Map<PlayerId, ParticipantInfo['rig']>();
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
  private lastTransfer = 'null';
  private closed = false;
  /** A10: the game the last RESULT was for, and the series after it (names resolved at the panel). */
  private resultGame = 0;
  private series: PayloadOf<'RESULT'>['series'] | null = null;
  /** A10: no next game follows (MATCH_END, or the host gone between games), and what the panel says about it. */
  private seriesOver = false;
  private seriesOverLine: string | null = null;
  /** A10: a game was started on this player's table in the current game (the "press Start" prompt is then moot). */
  private tableStarted = false;
  /** A11: the lobby start countdown (local deadline and tick timer), and a start from the table waiting for a table. */
  private countdownEnd: number | null = null;
  private countdownTimer: unknown = null;
  private startArmed = false;
  /** A11: lobby players whose table is not open (the host's `loading()`, a client's last HELLO_ACK). */
  private loadingIds: PlayerId[] = [];
  /** A12: a game is running on this player's own table (the hook's `game_start` until its `game_end`), any phase. */
  private tableGameRunning: boolean;
  /** A12: free play: the lobby is complete while the host's game runs; the match starts at the next Start after it ends. */
  private waitingForHostGame = false;
  /** A12: the host's table is locked by the lobby rule (`preMatchPlay: 'locked'`, lobby not complete). */
  private lobbyLocked = false;
  private preMatchPlay: PreMatchPlay;
  /** A13: what each player said about its table's ball ends (the host's engine, or a client's last HELLO_ACK). */
  private ballEndReady = new Map<PlayerId, boolean>();
  /** A13: this player's own table, from the witness (null: unknown, no table open), and the witness's reason when it cannot. */
  private localBallEnds: boolean | null = null;
  private localBallEndsReason: string | null = null;

  constructor(opts: MatchControllerOptions) {
    this.opts = opts;
    this.role = opts.role;
    this.localId = opts.localId;
    this.settleMs = opts.ballEndSettleMs ?? DEFAULT_SETTLE_MS;
    this.stateIntervalMs = opts.stateIntervalMs ?? DEFAULT_STATE_INTERVAL_MS;
    this.tableGameRunning = opts.tableGameRunning ?? false;
    this.preMatchPlay = opts.preMatchPlay ?? 'free';
    this.bind(opts.role);
  }

  /** A12: the Match tab changed the setting during a lobby: the lobby lock follows at once. */
  setPreMatchPlay(mode: PreMatchPlay): void {
    if (this.closed || this.preMatchPlay === mode) return;
    this.preMatchPlay = mode;
    const r = this.role;
    if (isHostRole(r)) this.syncLobby(r);
    this.push();
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
      tableMismatch: [...this.mismatch].filter(([, f]) => mismatchWords(f).table !== null).map(([id]) => id),
      mismatches: Object.fromEntries([...this.mismatch].map(([id, f]) => [id, [...f]])),
      waitingForHostGame: this.waitingForHostGame,
      transfer: this.transfer(),
      series: { game: this.gameNumber(), over: this.seriesOver, nextGameBlocker: this.nextGameBlocker() },
      ballEnds: this.ballEnds(),
      startWarnings: this.phase === 'lobby' ? this.unreadableLines() : [],
      pass: this.passInfo(),
      panel: this.panel(),
    };
  }

  private gameNumber(): number {
    return Math.max(1, this.role.state.gameNumber);
  }

  /** A10: for the host's Next game button: why not now, or null. A client is never the one to start it. */
  private nextGameBlocker(): string | null {
    const r = this.role;
    if (!isHostRole(r)) return 'only the host starts the next game';
    if (this.seriesOver) return 'the match has ended';
    return r.nextGameBlocker();
  }

  /**
   * A10: the host's Next game (the Match tab's button; the table's `game_start` does the same). False, with the reason
   * on the panel's message line, when it cannot start now.
   */
  nextGame(): boolean {
    const r = this.role;
    if (this.closed || !isHostRole(r)) return false;
    const why = this.nextGameBlocker();
    if (why !== null) {
      this.opts.log(`match: no next game: ${why}`);
      return false;
    }
    let ok = false;
    this.call(() => {
      ok = r.nextGame();
    }, 'NEXT_GAME');
    return ok;
  }

  /** A10: the host's End match, between games: MATCH_END to everyone; the series is over. */
  endMatch(): boolean {
    const r = this.role;
    if (this.closed || !isHostRole(r) || this.seriesOver) return false;
    let ok = false;
    this.call(() => {
      ok = r.endMatch('the host ended the match');
    }, 'MATCH_END');
    return ok;
  }

  // ------------------------------------------------------------------------------------------
  // A13: tables that cannot report ball ends, and the host's Pass the turn
  // ------------------------------------------------------------------------------------------

  /**
   * A13: this player's own table, from the witness: it can report ball ends (true), it cannot (false, with the
   * witness's reason when it has one), or nothing is known (null: no table open). Display only: the shell tells the
   * others through the engine (HELLO / PARTICIPANT_UPDATE / `updateLocal`).
   */
  setLocalBallEnds(ready: boolean | null, reason: string | null): void {
    if (this.closed || (this.localBallEnds === ready && this.localBallEndsReason === reason)) return;
    this.localBallEnds = ready;
    this.localBallEndsReason = reason;
    this.push();
  }

  private readyOf(id: PlayerId): boolean | undefined {
    if (id === this.localId && this.localBallEnds !== null) return this.localBallEnds;
    return this.ballEndReady.get(id);
  }

  private ballEnds(): Record<PlayerId, boolean> {
    const out: Record<PlayerId, boolean> = {};
    for (const p of this.participants()) {
      const r = this.readyOf(p.playerId);
      if (r !== undefined) out[p.playerId] = r;
    }
    return out;
  }

  /**
   * The participants whose table is known not to report ball ends (unknown is not unreadable). A player whose table is
   * not open any more is loading, not unreadable: what it last said was about the table it closed.
   */
  private unreadableIds(): PlayerId[] {
    return this.participants()
      .map((p) => p.playerId)
      .filter((id) => this.readyOf(id) === false && !(this.phase === 'lobby' && this.loadingIds.includes(id)));
  }

  private unreadableLines(): string[] {
    return this.unreadableIds().map((id) =>
      id === this.localId
        ? `Your table cannot report ball ends: ${this.localBallEndsReason ?? 'Castcade is not reading its score (not patched, or an original table)'}`
        : `${this.nameOf(id)}'s table cannot report ball ends: its score is not being read (not patched, or an original table)`,
    );
  }

  private noteBallEndReady(list: Record<PlayerId, boolean>): void {
    this.ballEndReady = new Map(Object.entries(list));
  }

  private passInfo(): ControllerStatus['pass'] {
    const r = this.role;
    if (this.closed || !isHostRole(r) || r.passTurnBlocker() !== null) return null;
    const g = r.state.currentGrant?.grant;
    if (!g) return null;
    return { player: g.player, name: this.nameOf(g.player), ball: g.ballNumber, score: this.scores.get(g.player) ?? r.state.players[g.player]?.score ?? 0 };
  }

  /**
   * A13: the host's Pass the turn (the Match tab's button, after its confirmation): the holder's ball ends at its last
   * known score and the next grant goes out, as if its BALL_END had arrived; logged as the host's TURN_PASS. False,
   * with the reason in the log, when there is no turn to pass or this player is not the host.
   */
  passTurn(): boolean {
    const r = this.role;
    if (this.closed || !isHostRole(r)) return false;
    const info = this.passInfo();
    if (!info) {
      this.opts.log(`match: the turn cannot be passed: ${r.passTurnBlocker() ?? 'nobody holds the turn right now'}`);
      return false;
    }
    let ok = false;
    this.call(() => {
      ok = r.passTurn(info.score);
    }, 'TURN_PASS');
    return ok;
  }

  /**
   * A13: a TURN_PASS was logged (this host's own, or the host's as a client sees it). For the passed player it is the
   * end of the ball it was playing: nothing more is reported for it and the table locks until the next grant (which,
   * on a host, arrives right after this inside `passTurn`).
   */
  private onTurnPassed(p: PayloadOf<'TURN_PASS'>): void {
    if (p.player === this.localId) {
      this.clearPending();
      this.clearStateTimer();
      this.holding = null;
      this.myBallsDone = Math.max(this.myBallsDone, p.ballNumber);
      this.opts.media?.setSending(false);
      this.setLocked(true);
    }
    const who = p.player === this.localId ? 'my' : `${this.nameOf(p.player)}'s`;
    this.opts.log(`match: ${isHostRole(this.role) ? 'passed the turn' : `${this.nameOf(this.hostId)} (host) passed the turn`}: ${who} ball ${p.ballNumber} ended by hand at ${p.score}`);
    this.onBallEndMsg(p.player, p.score);
  }

  private transfer(): ControllerStatus['transfer'] {
    const pt = this.role.state.pendingTransfer;
    return pt ? { proposer: pt.proposer, newHost: pt.newHost, reason: pt.reason } : null;
  }

  onChange(cb: (s: ControllerStatus) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /**
   * A participant whose fingerprint differed from the host's (`fields`: the GameFingerprint fields). Advisory. No
   * fields: it agrees now (a lobby update, A6 2026-10-31).
   */
  noteTableMismatch(player: PlayerId, fields: string[]): void {
    if (fields.length > 0) this.mismatch.set(player, [...fields]);
    else this.mismatch.delete(player);
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
    // A12: this player's own table game, any phase (the lobby rules read it).
    if (ev.kind === 'game_start') this.tableGameRunning = true;
    else if (ev.kind === 'game_end' || ev.kind === 'game_abandoned' || ev.kind === 'table_exit') this.tableGameRunning = false;
    switch (ev.kind) {
      case 'game_start':
        this.onTableGameStart();
        return;
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
        if (this.phase === 'lobby') {
          this.disarmStart('the game on your table ended');
          this.onLobbyGameEnded();
        }
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
        if (this.phase === 'lobby') {
          this.disarmStart(ev.kind === 'table_exit' ? 'your table closed' : 'the game on your table ended');
          this.onLobbyGameEnded();
        }
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
    this.clearCountdown();
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
  // A10 / A11: a game started on this player's table
  // ------------------------------------------------------------------------------------------

  /**
   * The hook's `game_start` (the player pressed Start on the table). The host's starts the match from the lobby (A11)
   * or the next game between games (A10); a client's, and the host's during a game, only clear the "press Start" prompt.
   */
  private onTableGameStart(): void {
    const r = this.role;
    if (this.phase === 'playing' || this.phase === 'paused') {
      if (this.holding && !this.tableStarted) {
        this.tableStarted = true;
        this.push();
      }
      return;
    }
    if (!isHostRole(r)) return;
    if (this.phase === 'lobby') {
      // A12: a second game_start with no game_end between (the detector missed the end, or a restart): this is the
      // next game, the one the lobby waited for.
      if (this.waitingForHostGame) {
        this.waitingForHostGame = false;
        this.opts.log('match: a new game started on the table while the lobby waited for the last one to end; taking it as the start');
      }
      this.tryStartFromTable(r, true);
      return;
    }
    if (this.phase === 'over' && !this.seriesOver) {
      const why = r.nextGameBlocker();
      if (why !== null) {
        this.opts.log(`match: a game started on the table; no next game (${why})`);
        return;
      }
      this.opts.log(`match: a game started on the table; game ${this.gameNumber() + 1} starts for everyone`);
      let ok = false;
      this.call(() => {
        ok = r.nextGame();
      }, 'NEXT_GAME');
      // nextGame resets the per-game state (onNextGame); this host's own game is already running on its table.
      if (ok) {
        this.tableStarted = true;
        this.push();
      }
    }
  }

  /** A11: start the countdown if the lobby is complete, else arm the start for when it is (`fromTable`: a new press). */
  private tryStartFromTable(h: HostRole, fromTable: boolean): void {
    if (h.state.phase !== 'lobby' || this.countdownEnd !== null) return;
    const roster = h.roster();
    if (roster.length < 2) {
      if (fromTable) this.opts.log('match: a game started on the table, but nobody has joined yet; the match does not start');
      return;
    }
    const loading = h.loading();
    if (loading.length > 0) {
      if (!this.startArmed) {
        this.startArmed = true;
        this.opts.log(`match: a game started on the table; the match starts once ${loading.map((id) => this.nameOf(id)).join(', ')}'s table is open`);
        this.push();
      }
      return;
    }
    // A13: a table that cannot report ball ends would hold the first turn for ever: no start from the table; the Match
    // tab's Start match asks the host to confirm instead.
    const unreadable = this.unreadableIds();
    if (unreadable.length > 0) {
      this.startArmed = false;
      this.opts.log(
        `match: a game started on the table, but ${unreadable.map((id) => (id === this.localId ? 'your' : `${this.nameOf(id)}'s`)).join(', ')} table cannot report ball ends; the match does not start from the table (Start match on the Match tab starts it anyway)`,
      );
      this.push();
      return;
    }
    this.startArmed = false;
    const ms = this.opts.startCountdownMs ?? DEFAULT_START_COUNTDOWN_MS;
    let ok = false;
    this.call(() => {
      ok = h.startIn(ms);
    }, 'the start');
    if (ok) this.opts.log(`match: starting in ${Math.round(ms / 1000)} s from the table: ${roster.map((p) => p.displayName).join(', ')}`);
  }

  private disarmStart(why: string): void {
    if (!this.startArmed) return;
    this.startArmed = false;
    this.opts.log(`match: the start from the table is off: ${why}`);
    this.push();
  }

  // ------------------------------------------------------------------------------------------
  // A12: the host's table before the match
  // ------------------------------------------------------------------------------------------

  /** A12: two or more in and every table open (A11's condition for a start from the table). */
  private lobbyComplete(h: HostRole): boolean {
    return h.state.phase === 'lobby' && h.roster().length >= 2 && h.loading().length === 0;
  }

  /**
   * A12: the lobby rules after any lobby change (a join, a leave, a table opened, the setting changed). Free play: a
   * game running on the host's table when the lobby becomes complete is waited out (never game 1), unless the host
   * armed the start itself (A11: everyone in, a table loading: that game is game 1). Locked: the host's table is locked
   * until the lobby is complete, and again when it falls apart. Never for a client.
   */
  private syncLobby(h: HostRole): void {
    if (this.phase !== 'lobby' || h.state.phase !== 'lobby') return;
    const complete = this.lobbyComplete(h);
    const wait = complete && this.tableGameRunning && !this.startArmed && this.countdownEnd === null;
    if (wait !== this.waitingForHostGame) {
      this.waitingForHostGame = wait;
      if (wait) this.opts.log("match: the lobby is complete, but a game is running on the host's table; the match starts at the next Start after it ends");
    }
    // A14 (2026-11-12): never in the middle of a game. A host who hosts (or loses the last other player) while a game
    // runs on the table keeps the flippers until that game ends; the lock goes on then (`onLobbyGameEnded`).
    const lock = this.preMatchPlay === 'locked' && !complete && !this.tableGameRunning;
    if (lock !== this.lobbyLocked) {
      this.lobbyLocked = lock;
      this.setLocked(lock);
      this.opts.log(
        lock
          ? 'match: your table is locked until the lobby is complete (Before the match: locked)'
          : complete
            ? 'match: the lobby is complete; your table is unlocked'
            : 'match: a game is running on your table; it is locked once that game ends (Before the match: locked)',
      );
    }
  }

  /** A12: the host's game ended in the lobby: the lobby, if complete, now waits for the Start that begins the match. */
  private onLobbyGameEnded(): void {
    const waited = this.waitingForHostGame;
    // A14: the lock a running game held off (`syncLobby`) goes on now.
    if (isHostRole(this.role)) this.syncLobby(this.role);
    if (!waited) return;
    this.waitingForHostGame = false;
    this.opts.log("match: the game on the host's table ended; the next Start on the table starts the match");
    this.push();
  }

  /** A11: the lobby countdown, from this host's `countdown` or a client's HELLO_ACK (`startsInMs`, null: none). */
  private setCountdown(ms: number | null): void {
    if (ms === null) {
      if (this.countdownEnd === null) return;
      this.clearCountdown();
      this.push();
      return;
    }
    const end = this.opts.now() + ms;
    // A re-sent HELLO_ACK during the countdown carries what is left; keep the earlier deadline (it only drifts by latency).
    if (this.countdownEnd !== null && Math.abs(this.countdownEnd - end) < 1000) return;
    this.clearCountdown();
    this.countdownEnd = end;
    this.tickCountdown();
  }

  private tickCountdown(): void {
    this.countdownTimer = null;
    if (this.closed || this.countdownEnd === null) return;
    this.push();
    const left = this.countdownEnd - this.opts.now();
    if (left <= 0) return;
    const step = left % 1000 || 1000;
    this.countdownTimer = this.opts.setTimeout(() => this.tickCountdown(), step);
  }

  private clearCountdown(): void {
    if (this.countdownTimer !== null) this.opts.clearTimeout(this.countdownTimer);
    this.countdownTimer = null;
    this.countdownEnd = null;
  }

  private countdownSeconds(): number | null {
    if (this.countdownEnd === null || this.phase !== 'lobby') return null;
    return Math.max(0, Math.ceil((this.countdownEnd - this.opts.now()) / 1000));
  }

  /** A11: who is still loading, as the host knows it (its engine) or last told this client (HELLO_ACK.loading). */
  private noteLoading(ids: readonly PlayerId[]): void {
    this.loadingIds = [...ids];
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
    this.noteLoading(h.loading());
    if (h.state.phase === 'lobby') this.noteBallEndReady(h.ballEndReadiness());
    this.syncLobby(h);
    const offs = this.offs;
    offs.push(h.on('joined', () => this.onHostLobby(h)));
    // A6 (2026-10-31): a lobby rig / table correction (a client's PARTICIPANT_UPDATE, or this host's own).
    offs.push(h.on('participantUpdated', () => this.onHostLobby(h)));
    offs.push(h.on('countdown', (c) => this.setCountdown(c.startsInMs)));
    offs.push(
      h.on('countdownCancelled', (c) => {
        this.opts.log(`match: the start from the table did not happen: ${c.reason}`);
        this.setCountdown(null);
      }),
    );
    offs.push(h.on('nextGame', (p) => this.onNextGame(p)));
    offs.push(h.on('matchEnded', (p) => this.onSeriesOver(`Match over after ${p.games} game${p.games === 1 ? '' : 's'}`)));
    offs.push(h.on('rigUpdated', (r) => this.onRigUpdated(r.playerId, r.rig)));
    // A host in `advise` mode accepted a different table file (§3): flagged, never refused.
    offs.push(h.on('tableMismatch', (m) => this.noteTableMismatch(m.playerId, m.mismatches.map((x) => x.field))));
    offs.push(h.on('ready', (p) => this.onReady(p)));
    offs.push(h.on('grant', (g) => this.onGrant(g, g.player === this.localId)));
    offs.push(h.on('ballEnd', (m) => this.onBallEndMsg(m.from, m.payload.finalScore)));
    offs.push(h.on('turnPassed', (m) => this.onTurnPassed(m.payload)));
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
    offs.push(
      h.on('peerLeft', (id) => {
        this.onPeerLeft(id);
        if (h.state.phase === 'lobby') this.onHostLobby(h);
      }),
    );
    offs.push(h.on('reconnected', (r) => this.onPeerBack(r.playerId)));
    offs.push(h.on('result', (r) => this.onResult(r.result)));
    offs.push(h.on('transferProposed', () => this.push()));
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
        this.onClientAck(ack);
      }),
    );
    // A6 (2026-10-31): the host re-sent HELLO_ACK in the lobby (a rig or a table changed; A11: a start countdown).
    offs.push(c.on('roster', (ack) => this.onClientAck(ack)));
    offs.push(c.on('nextGame', (p) => this.onNextGame(p)));
    offs.push(c.on('matchEnded', (p) => this.onSeriesOver(`The host ended the match after ${p.games} game${p.games === 1 ? '' : 's'}`)));
    offs.push(
      c.on('hostGone', () => {
        if (this.phase === 'over') this.onSeriesOver('The host left; the match is over');
      }),
    );
    offs.push(c.on('rigUpdated', (r) => this.onRigUpdated(r.playerId, r.rig)));
    // HELLO_ACK's `hostGame` differs from this player's own: the host accepted it anyway (§3, advisory).
    offs.push(c.on('tableMismatch', (m) => this.noteTableMismatch(m.playerId, m.mismatches.map((x) => x.field))));
    offs.push(c.on('ready', (p) => this.onReady(p)));
    // `grant` comes for every grant; this player's own is acted on at `myTurn`, raised only once its signature verified.
    offs.push(
      c.on('grant', (g) => {
        if (g.player !== this.localId) this.onGrant(g, false);
      }),
    );
    offs.push(c.on('myTurn', (g) => this.onGrant(g, true)));
    offs.push(c.on('ballEnd', (m) => this.onBallEndMsg(m.from, m.payload.finalScore)));
    offs.push(c.on('turnPassed', (m) => this.onTurnPassed(m.payload)));
    offs.push(c.on('gameOver', (m) => this.onScoreMsg(m.from, m.payload.finalScore)));
    offs.push(c.on('forfeit', () => this.push()));
    offs.push(c.on('state', (m) => this.onScoreMsg(m.from, m.payload.score)));
    offs.push(c.on('pause', () => this.onPause()));
    offs.push(c.on('resume', () => this.onResume()));
    offs.push(c.on('reject', (r) => this.onReject(r)));
    offs.push(c.on('peerLeft', (id) => this.onPeerLeft(id)));
    offs.push(
      c.on('reconnected', (r) => {
        this.onPeerBack(r.host);
        this.resumeAfterMyDrop(c);
      }),
    );
    offs.push(c.on('transferProposed', () => this.push()));
    offs.push(c.on('transferAck', () => this.push()));
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

  /** A host's lobby changed (a join, a leave, a table loaded): the roster, who is loading, and an armed start (A11). */
  private onHostLobby(h: HostRole): void {
    this.noteLoading(h.loading());
    this.noteBallEndReady(h.ballEndReadiness());
    if (this.startArmed) this.tryStartFromTable(h, false);
    this.syncLobby(h);
    this.onLobby(h.roster());
  }

  private onClientAck(ack: PayloadOf<'HELLO_ACK'>): void {
    this.noteLoading(ack.loading);
    this.noteBallEndReady(Object.fromEntries(ack.ballEndReady.map((x) => [x.playerId, x.ready])));
    this.setCountdown(ack.startsInMs);
    this.onLobby(ack.participants);
  }

  /**
   * A10: the next game of the series began (NEXT_GAME, logged): every per-game note starts again; the table stays
   * locked until this player's grant (the host's grant 1 follows at once). The series standings stay on the panel.
   */
  private onNextGame(p: PayloadOf<'NEXT_GAME'>): void {
    this.clearPending();
    this.clearStateTimer();
    this.phase = 'playing';
    this.holding = null;
    this.upPlayer = null;
    this.upBall = null;
    this.myBallsDone = 0;
    this.myScore = null;
    this.myGameOver = false;
    this.tableStarted = false;
    this.scores.clear();
    this.result = null;
    this.message = null;
    this.setLocked(true);
    this.opts.log(`match: game ${p.game} begins: ${p.playerOrder.map((id) => this.nameOf(id)).join(', ')}`);
    this.push();
  }

  /** A10: no next game follows. Every table is unlocked (solo play works again); the panel keeps the standings. */
  private onSeriesOver(line: string): void {
    if (this.seriesOver) return;
    this.seriesOver = true;
    this.seriesOverLine = line;
    this.setLocked(false);
    this.opts.log(`match: ${line}`);
    this.push();
  }

  private onRigUpdated(id: PlayerId, rig: ParticipantInfo['rig']): void {
    if (this.liveRigs.get(id) === rig) return;
    this.liveRigs.set(id, rig);
    this.opts.log(`match: ${this.nameOf(id)}'s rig is ${rig} now`);
    this.push();
  }

  private onReady(p: PayloadOf<'MATCH_READY'>): void {
    this.clearCountdown();
    this.startArmed = false;
    this.waitingForHostGame = false;
    this.lobbyLocked = false;
    this.loadingIds = [];
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

  /**
   * A8 (2026-10-31): back on a link after a drop. The host paused the match for it and waits for a RESUME from
   * anyone (A3); the player who dropped is the one who knows it is back, so it sends it. Only for its own drop: a
   * pause for someone else stays theirs (or the host's Resume button).
   */
  private resumeAfterMyDrop(c: ClientRole): void {
    const p = c.state.paused;
    if (c.state.phase !== 'running' || !p || p.reason !== 'disconnect' || p.player !== this.localId || c.state.pendingTransfer) return;
    this.opts.log('match: back after a drop; resuming the match');
    try {
      c.resume();
    } catch (e) {
      this.opts.log(`match: could not resume: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * A game's RESULT (A10: one per game). One for an earlier game (sent again after a reconnect) only brings the series
   * if this player has none newer. The host's table is unlocked for the next game; a client's stays locked.
   */
  private onResult(r: PayloadOf<'RESULT'>): void {
    if (r.game > this.resultGame) {
      this.resultGame = r.game;
      this.series = r.series.map((x) => ({ ...x }));
    }
    if (r.game < this.role.state.gameNumber) {
      this.push();
      return;
    }
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
    this.setLocked(!isHostRole(this.role) && !this.seriesOver);
    this.opts.cue.play('match_over');
    this.opts.log(`match: game ${r.game} result ${this.result.map((x) => `${x.place}. ${x.name} ${x.score}`).join(', ')}`);
    if (r.series.length > 0) this.opts.log(`match: series ${[...r.series].sort((a, b) => a.rank - b.rank).map((x) => `${x.rank}. ${name(x.playerId)} ${x.wins} win(s), ${x.totalScore}`).join(', ')}`);
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
    if (st.phase === 'lobby') return this.lobby;
    if (this.liveRigs.size === 0) return st.participants;
    return st.participants.map((p) => {
      const rig = this.liveRigs.get(p.playerId);
      return rig && rig !== p.rig ? { ...p, rig } : p;
    });
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
      const words = mismatchWords(this.mismatch.get(p.playerId) ?? []);
      if (words.table) flags.push('table_mismatch');
      if (words.build) flags.push('build_mismatch');
      if (this.left.has(p.playerId) || prog?.connected === false) flags.push('disconnected');
      if (this.phase === 'lobby' && this.loadingIds.includes(p.playerId)) flags.push('loading');
      return {
        id: p.playerId,
        name: p.displayName,
        score: this.scores.get(p.playerId) ?? null,
        ballsDone: prog?.ballsPlayed ?? 0,
        isUp: this.phase !== 'over' && this.upPlayer === p.playerId,
        flags,
        rig: p.rig,
      };
    });
    const phase: PanelState['phase'] = this.phase === 'lobby' ? 'idle' : this.phase;
    const myTurn = this.phase !== 'over' && this.upPlayer !== null && this.upPlayer === this.localId;
    const series = this.series
      ? [...this.series]
          .sort((a, b) => a.rank - b.rank || b.wins - a.wins || b.totalScore - a.totalScore)
          .map((x) => ({ id: x.playerId, name: this.nameOf(x.playerId), wins: x.wins, games: x.games, total: x.totalScore, place: x.rank }))
      : null;
    return {
      game: this.phase === 'lobby' ? 1 : this.gameNumber(),
      series,
      seriesOver: this.seriesOver,
      countdown: this.countdownSeconds(),
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
    // The table line, grouped by what differs. A VPX build difference alone is a muted flag on the player's row, not
    // this line: it would hold the line for the whole match and hide the turn prompts (D2.5, 2026-10-31).
    const byWhat = new Map<string, string[]>();
    for (const [id, fields] of this.mismatch) {
      const what = mismatchWords(fields).table;
      if (what) byWhat.set(what, [...(byWhat.get(what) ?? []), id === this.localId ? 'you' : this.nameOf(id)]);
    }
    const st = this.role.state;
    // A11: the countdown is the one line that matters in the lobby, over a table note.
    const count = this.countdownSeconds();
    if (count !== null) return `Starting the match: ${this.participants().map((p) => (p.playerId === this.localId ? 'you' : p.displayName)).join(', ')}`;
    // A13: in the lobby a table that cannot report ball ends is the line that matters (the lobby line names it).
    if (byWhat.size > 0 && this.phase !== 'over' && !(this.phase === 'lobby' && (this.loadingIds.length > 0 || this.unreadableIds().length > 0))) return [...byWhat].map(([what, who]) => `${what}: ${who.join(', ')}`).join(' · ');
    if (this.phase === 'lobby') return this.lobbyMessage();
    if (this.phase === 'over') {
      if (this.seriesOver) return this.seriesOverLine;
      return isHostRole(this.role) ? 'Next game: start a game on your table (or press Next game)' : `Next game: ${this.nameOf(this.hostId)} starts a game on the table`;
    }
    if (this.phase === 'paused') {
      const who = st.paused?.player ?? null;
      return st.paused?.reason === 'disconnect' && who ? `Paused: waiting for ${this.nameOf(who)} to reconnect` : 'Paused';
    }
    if (this.phase === 'playing' && this.holding && this.holding.ballNumber === 1 && this.myScore === null && !this.tableStarted) return 'Press Start on the table to begin your game';
    if (this.phase === 'playing' && this.myGameDone() && this.upPlayer !== this.localId) return 'Your game is over; the others are still playing';
    // Nothing about the match to say: say what is wrong with video or voice (no window to send, no microphone).
    return this.opts.media?.status().lastError ?? null;
  }

  /**
   * The lobby line (A11): who is still loading, an armed start, else what starts the match. A13: every player whose
   * table cannot report ball ends is named, alone or after the loading note.
   */
  private lobbyMessage(): string {
    const host = isHostRole(this.role);
    const warn = this.unreadableLines();
    const warned = warn.length > 0 ? ` · ${warn.join(' · ')}` : '';
    const loading = this.loadingIds.map((id) => (id === this.localId ? 'your' : `${this.nameOf(id)}'s`));
    // A12: the host's table before the match (the lobby lock, the wait for the host's own game to end).
    if (host && this.lobbyLocked && this.participants().length < 2) return `Waiting for players — the table unlocks when someone joins${warned}`;
    if (this.participants().length < 2) return `${host ? 'Waiting for players' : 'Waiting for the host to start'}${warned}`;
    if (loading.length > 0) {
      const tables = `${loading.join(', ')} table${loading.length > 1 ? 's' : ''}`;
      if (host && this.startArmed) return `The match starts once ${tables} ${loading.length > 1 ? 'are' : 'is'} open${warned}`;
      return `Waiting for ${tables} to open${this.lobbyLocked ? '; your table unlocks then' : ''}${warned}`;
    }
    if (warn.length > 0) return `${warn.join(' · ')}${host ? ' · Start match on the Match tab starts anyway; Pass the turn then ends such a ball by hand' : ''}`;
    if (host && this.waitingForHostGame) return 'Everyone is in: finish the game on your table, then press Start on it to start the match';
    return host ? 'Everyone in? Start a game on your table (or press Start match)' : `Waiting for ${this.nameOf(this.hostId)} to start a game on the table`;
  }

  private push(force = false): void {
    if (this.closed && !force) return;
    const panel = this.panel();
    const text = JSON.stringify(panel);
    // A8: a transfer proposal is on the Match tab only, not the panel; the tab hears of it all the same. A13: so are
    // the ball-end readiness of each player and the turn the host may pass.
    const transfer = JSON.stringify([this.transfer(), this.ballEnds(), this.passInfo()]);
    if (!force && text === this.lastPanel && transfer === this.lastTransfer) return;
    this.lastTransfer = transfer;
    if (force || text !== this.lastPanel) this.opts.media?.setPanelState(panel);
    this.lastPanel = text;
    const s = this.status();
    for (const l of [...this.listeners]) l(s);
  }
}
