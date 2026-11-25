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
 * RESULT/HOST_TRANSFER_ACK are never logged either, nor is MEDIA_SIGNAL, which goes to its `to`
 * only (D2), nor PARTICIPANT_UPDATE, a lobby-only correction that MATCH_READY's roster carries (A6). The log is frozen at the moment the last game ends; LOG_SIGN and RESULT refer to
 * that frozen head.
 *
 * Choices where SPEC is silent (listed in the Phase 1 report):
 * - TURN_GRANT is broadcast to all, not only the holder, so everyone logs it and knows whose turn it is.
 * - While a host_requested transfer is pending the old host rejects state changes
 *   (`unexpected_state`), so no entry can land between the HOST_TRANSFER entry and the commit event.
 * - A BALL_END for the outstanding grant is accepted during a pause; RESUME then simply advances.
 * - GAME_OVER from a player whose game already ended is rejected (`unexpected_state`).
 * - A3 (2026-10-30): an accepted RECONNECT puts the player back on a link but does not RESUME; the
 *   pause its drop caused waits for a RESUME from anyone (the fake client sends its own). A
 *   participant that reconnects after RESULT went out is sent RESULT again. A8 (2026-10-31): in the companion that
 *   RESUME comes from the reconnecting player's own controller, or from the host's Match tab.
 * - A8 (2026-10-31): every lobby roster change (a join, a leave, a PARTICIPANT_UPDATE) re-sends HELLO_ACK to every
 *   accepted client, with `tableMismatches` (who differs from this host's fingerprint and how). The list survives a
 *   transfer through `ResumeOptions.tableMismatches` / `AdoptOptions.tableMismatches`; it is never logged.
 * - A10 (2026-11-02): a match is a series. After a game's RESULT the match stays open: `nextGame()` appends NEXT_GAME
 *   (the connected roster, this host first) and issues grant 1 of the new game; `endMatch()` sends MATCH_END (never
 *   logged) and nothing more can happen. Neither works before the current game's RESULT went out, so a `game_start`
 *   seen on the host's table while the last RESULT is still due starts nothing. Each RESULT carries `game` and the
 *   series so far (`seriesOf`, a fold over the log, so a host that took over mid-series computes the same). A peer
 *   that reconnects is sent every RESULT this host sent, oldest first. A LOG_SIGN for an earlier game is dropped.
 * - A11 (2026-11-02): `startIn(ms)` starts the match after a countdown the lobby sees (`HELLO_ACK.startsInMs`); a
 *   second call while it runs changes nothing, `start()` during it starts at once. `HELLO_ACK.loading` names the
 *   participants whose fingerprint says no table is open (`HostOptions.tableOpen`).
 * - A13 (2026-11-12): `HELLO_ACK.ballEndReady` carries what each lobby participant said about its table's ball ends
 *   (`HELLO` / `PARTICIPANT_UPDATE.ballEndReady`, this host's own through `HostOptions.ballEndReady` / `updateLocal`);
 *   the engine only passes it on, and `start()` does not look at it (the shell asks the host to confirm). `passTurn()`
 *   ends the outstanding grant's ball by hand with a logged TURN_PASS (this host's own ball or a client's), under the
 *   same conditions as a BALL_END (running, no transfer pending, also while paused); the BALL_END that arrives for
 *   that grant afterwards meets the usual `stale_grant` / `not_grant_holder` REJECT.
 * - I11.4.9 (2026-11-20): `HELLO_ACK.stream3dWait` lists the lobby participants whose PC is still making its 3D
 *   connection (`PARTICIPANT_UPDATE.stream3dWaitMs`, this host's own through `updateLocal`), each with the ms left of
 *   its own wait (`stream3dWaiting()`); a PC that says nothing more is dropped from the list a grace after its time ran
 *   out. The engine only keeps and passes the list: `startIn()` and `start()` do not look at it (the controller holds a
 *   start for it; `start()` is the host's "start now"). Lobby only: NEXT_GAME and a rejoin never wait.
 * - A18 (2026-11-24, the owner: "We never want another player's disconnect to cause the active player to have a messed
 *   up session"; match ECVYGP, 2026-11-23: one second without ArcAid paused the match in the owner's ball). Two rules
 *   for a peer whose link drops after MATCH_READY:
 *   - a grace (`disconnectGraceMs`, 5 s): the peer counts as not reachable at once (nothing is sent to it), but nobody
 *     is told and nothing is paused until the grace is over. A RECONNECT inside it is answered as ever (the entries the
 *     peer missed) and that is all that happened; a grant that came due for that peer meanwhile waits for it.
 *   - after the grace, only the player who is up is paused for (`PAUSE(disconnect)`: the others wait for it, as
 *     before). A player who is not up changes nothing: no PAUSE, no entry in the log, the outstanding grant and its
 *     ball-end timer untouched. Its absence counts when its own grant comes due: the rotation then pauses for it
 *     (`advance`, as it always did for a player known to be gone) and waits for its RESUME or the host's forfeit.
 *   Simultaneous mode has no player up, so a drop there pauses as before (after the grace).
 *   Three things follow from "inside the grace it is not a disconnect" (review of PR 126, 2026-11-24):
 *   - a game that ends meanwhile waits for that player's LOG_SIGN like anyone's (the 10 s log-sign timer bounds it);
 *   - a next game asked for meanwhile is held until the grace settles (`nextGame`), so its order holds who is there:
 *     a player who left between games is not put into it, one whose link only blinked is;
 *   - a client up to 0.2.50 does not send a lost ball end again by itself (`RECONNECT.resends` absent): it reports it
 *     only for a grant issued again. For such a client that holds the grant, the pause it always got is committed
 *     before its RECONNECT_ACK, also inside the grace, so its own RESUME has the grant issued again. A client that
 *     says `resends` is not paused for, and a waiting player of any build never is.
 * - A17 step 5 (2026-11-25, docs/design/alpha-match.md section 11: "a lobby that outlives a match"), behind
 *   `HostOptions.lobby`, which is OFF by default: with it off nothing in this file behaves or sends differently
 *   (`lobby-off.test.ts` compares a whole match, frame by frame, with one recorded before this step). With it on
 *   this engine is a LOBBY for its whole life, and a match is something that happens in it, any number of times:
 *   - **members, not a roster.** Everyone who said HELLO is a member until they leave, the lobby's PC (this one)
 *     like any other, each with a choice (`stance`: Play or Watch). HELLO is taken in every phase while there is
 *     room (`lobby.size`, four). HELLO_ACK is the lobby as it is now, sent to every member on every change in every
 *     phase (`lobbyFacts`: the choices, who is away, who has no copy of the table, the open match).
 *   - **a match has players, and they are a choice.** `start()` / `startMatch(players?)` starts one with the people
 *     set to Play who are here and have the table, or with the players given; this PC need not be one of them
 *     (it still arbitrates: grants, the log, the RESULT). MATCH_READY's roster is the players and nobody else, so a
 *     match's log is what it would be without a lobby. Its id is `<lobby code>-<n>`, n counting from 1.
 *   - **matches in sequence.** MATCH_END means "back to the lobby": the log is put away (`Session.newMatch`) and the
 *     next match starts one from nothing: index 0, `prevHash` 64 zeros, `grantSeq` from 1. The envelope's `seq` goes
 *     on. `nextGame()` is the match's own players (those set to Play and here); anyone else comes in only by a new
 *     match, which `startMatch` between games makes by ending the open one first.
 *   - **watchers.** A member who is not in the game being played gets every broadcast and keeps the same log, and
 *     nothing is taken from them: a BALL_END, GAME_OVER, FORFEIT, PAUSE, RESUME or LOG_SIGN of theirs is rejected, a
 *     STATE or DMD_FRAME dropped. STATE, DMD_FRAME and MEDIA_SIGNAL go to every member.
 *   - **the log, unasked and in pages.** A member who joins while a match is open is sent HELLO_ACK and then that
 *     match's whole log in MATCH_LOG pages (100 entries; the relay takes 256 KB a frame), and no logged message
 *     goes to a member whose log has not been sent in full (`logAudience`): what is committed meanwhile is in a
 *     later page. A RECONNECT_ACK that would hold more than one page says `more` and the rest follows the same way.
 *   - **no host transfer** (`transferHost` refuses).
 *   Left for the next step (start requests and their checks, the starter, the countdown on every start, the away
 *   clocks, RECONNECT in every phase, the table pick, a game ended for everyone), and stubbed here by the rule that
 *   was there: a member the open match does not hold drops out when their link drops; a player of the open match
 *   keeps A18's rules and today's RECONNECT, and is dropped when the match closes while they are still gone;
 *   START_REQUEST, START_CANCEL, END_REQUEST and TABLE_PICK are answered with REJECT; the lobby's table is still
 *   whatever this PC has open (`hostGame`).
 */
import {
  MATCH_LOG_PAGE_SIZE,
  PROTOCOL_VERSION,
  type AnyMessage,
  type GameFingerprint,
  type GrantBody,
  type Message,
  type MessageType,
  type MidnightMode,
  type ParticipantInfo,
  type PayloadInput,
  type PayloadOf,
  type PlayerAdvisory,
  type PlayerId,
  type Stance,
} from '@castcade/protocol';
import { ClientMatch } from './client.js';
import type { Clock, TimerHandle } from './clock.js';
import { Emitter } from './events.js';
import { signCanonical, verifyCanonical, type KeyPair } from './keys.js';
import { GENESIS_HASH, type LogHead, type MatchLog } from './log.js';
import { logSignBody, pickWinner, rankEntries, reconnectSignBody, seriesOf } from './result.js';
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

/** A17 (2026-11-25): what a lobby can be told at its start. Every key has a default. */
export interface LobbyOptions {
  /** How many people the lobby holds, its own PC included. Default 4 (five or more is A17.1). */
  size?: number;
  /** This PC's own choice, Play or Watch, until `updateLocal` changes it. Default play. */
  stance?: Stance;
  /** The number of the first match started here (`<code>-<n>`). Default 1; a lobby opened again goes on counting. */
  firstMatch?: number;
  /** Log entries in one MATCH_LOG. Default, and the most: 100 (`MATCH_LOG_PAGE_SIZE`). */
  logPageSize?: number;
  /** ms between two pages to one member. Default 0: the whole log in the turn that took the HELLO. */
  logPageGapMs?: number;
}

export interface HostOptions {
  transport: Transport;
  keys: KeyPair;
  matchId: string;
  ballsPerGame: number;
  hostParticipant: ParticipantInfo;
  hostGame: GameFingerprint;
  /**
   * A HELLO whose `game` differs from `hostGame`: `refuse` it with `fingerprint_mismatch` (default, the Phase 1 rule),
   * or `advise`: accept it and raise `tableMismatch` (the alpha match, alpha-match.md §3, 2026-10-30: "different
   * table file" on both panels, never a refusal; the client learns it from `HELLO_ACK.hostGame`).
   */
  fingerprintPolicy?: 'refuse' | 'advise';
  turnMode?: 'alternating' | 'simultaneous';
  clock?: Clock;
  /** No BALL_END within this long of a grant pauses the match. Default 20 minutes. */
  ballEndTimeoutMs?: number;
  /** How long to wait for LOG_SIGNs before sending RESULT anyway. Default 10 s. */
  logSignTimeoutMs?: number;
  companionVersion?: string;
  /**
   * A11 (2026-11-02): whether a fingerprint says the player has a table open (the lobby's `loading`, and the start from
   * the host's table waits for none). Default: a table hash that is not all zeros.
   */
  tableOpen?: (game: GameFingerprint) => boolean;
  /** A13: whether this host's own table can report ball ends (`HELLO_ACK.ballEndReady`); omitted = unknown. */
  ballEndReady?: boolean;
  /** A18: how long a dropped link is not yet a disconnect (the file header). Default 5 s; 0: at once. */
  disconnectGraceMs?: number;
  /**
   * A17 step 5 (2026-11-25): this engine is a lobby that outlives its matches (the file header). Off by default, and
   * off it changes nothing. `matchId` is then the lobby's code, and each match gets `<code>-<n>`.
   */
  lobby?: boolean | LobbyOptions;
}

export interface ResumeOptions {
  transport: Transport;
  keys: KeyPair;
  clock?: Clock;
  /** Reuse an existing session (seq counters) instead of starting one from the log. */
  session?: Session;
  ballEndTimeoutMs?: number;
  logSignTimeoutMs?: number;
  /** A18: see `HostOptions.disconnectGraceMs`. */
  disconnectGraceMs?: number;
  /** Peers already known to have dropped (the departed host, for one). */
  gone?: Iterable<PlayerId>;
  /**
   * A8 (2026-10-31): who differs from the match's fingerprint and how, as this player knew it as a client (the last
   * HELLO_ACK's `tableMismatches`, its own entry from its own comparison): the log does not carry it.
   */
  tableMismatches?: Record<PlayerId, PayloadOf<'REFUSE'>['mismatches']>;
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
  /**
   * `fingerprintPolicy: 'advise'`: a player accepted although its fingerprint differs; raised just before `joined`.
   * A6 (2026-10-31): raised again when a lobby update (`PARTICIPANT_UPDATE`, `updateLocal`) changes what differs;
   * an empty `mismatches` means that player's table agrees now.
   */
  tableMismatch: { playerId: PlayerId; mismatches: PayloadOf<'REFUSE'>['mismatches'] };
  /** A6 (2026-10-31): a lobby participant's rig or fingerprint changed (its PARTICIPANT_UPDATE, or `updateLocal`). */
  participantUpdated: ParticipantInfo;
  /**
   * A6.1 (2026-11-01): a participant's rig changed after MATCH_READY (its PARTICIPANT_UPDATE, or `updateLocal`). The
   * roster in the log keeps what MATCH_READY said; this is the rig now.
   */
  rigUpdated: { playerId: PlayerId; rig: ParticipantInfo['rig'] };
  /**
   * B26 (2026-11-16): a player flagged one of its own balls after MATCH_READY (a client's PARTICIPANT_UPDATE, passed on
   * to the others, or this host's own `localAdvisory`). Never logged; a flag only.
   */
  advisory: { playerId: PlayerId; advisory: PlayerAdvisory };
  /**
   * B26.4 (2026-11-16): a player said how the Midnight Madness setting reads on its table (a client's
   * PARTICIPANT_UPDATE, or this host's own `localMidnightMode`), in any phase. Never logged; display only.
   */
  midnightMode: { playerId: PlayerId; mode: MidnightMode };
  ready: PayloadOf<'MATCH_READY'>;
  grant: GrantBody;
  ballEnd: Message<'BALL_END'>;
  /** A13: this host passed the turn (`passTurn`): the holder's ball ended by hand; the next grant follows at once. */
  turnPassed: Message<'TURN_PASS'>;
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
  /** A peer's link dropped and it did not come back inside the grace (A18); in the lobby, at once. */
  peerLeft: PlayerId;
  /**
   * A RECONNECT was accepted; `entries` is how many log entries it was sent. A18: `quiet` when it came inside the
   * grace: `peerLeft` was never raised for this drop and nothing was paused for it.
   */
  reconnected: { playerId: PlayerId; entries: number; quiet: boolean };
  reconnectRejected: { playerId: PlayerId; code: ReconnectCode };
  /** A MEDIA_SIGNAL addressed to this host's own player (D2); signals for anyone else are only forwarded. */
  mediaSignal: { from: PlayerId; signal: PayloadOf<'MEDIA_SIGNAL'> };
  /** A10: NEXT_GAME went out; grant 1 of that game follows at once. */
  nextGame: PayloadOf<'NEXT_GAME'>;
  /** A10: MATCH_END went out; the series is over. */
  matchEnded: PayloadOf<'MATCH_END'>;
  /** A18: a next game that was held for a player inside the grace does not start after all (`reason`: the blocker). */
  nextGameOff: { reason: string };
  /** A11: a start countdown began (`startIn`); MATCH_READY follows after `startsInMs` unless the lobby fell below two. */
  countdown: { startsInMs: number };
  /** A11: the countdown ran out with fewer than two players; nothing started. */
  countdownCancelled: { reason: string };
  /** A17: the lobby as every member was just told (the HELLO_ACK that went out), this PC's own row included. Lobby only. */
  lobby: PayloadOf<'HELLO_ACK'>;
  /**
   * A17: a member who did not hold the open match's log has been sent all of it (`pages` MATCH_LOG messages, the
   * log `entries` long at the end, `during` of them committed while the pages went out); the logged messages reach
   * it live from here on.
   */
  caughtUp: { playerId: PlayerId; entries: number; pages: number; during: number };
  /** A17: LOBBY_CLOSED went out (`closeLobby`). */
  lobbyClosed: PayloadOf<'LOBBY_CLOSED'>;
}

/**
 * What the media layer hands over to send; the engine adds `to` and the envelope (D2). The schema's input shape
 * (D10.3): `channel` is optional here, and the build defaults it to `rtc`.
 */
export type OutgoingMediaSignal = Omit<PayloadInput<'MEDIA_SIGNAL'>, 'to'>;

const DEFAULT_BALL_END_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_LOG_SIGN_TIMEOUT_MS = 10_000;
/**
 * A18: a link that drops and is back within this long was never a disconnect. Five seconds: the three short drops of
 * 2026-11-23 took the host 1.0 to 1.6 s to be back on ArcAid, and a client then needs its own retry delay (1 s) and one
 * round trip for its RECONNECT, so 2 to 3 s as the host sees that client; five leaves room for one failed attempt of
 * either. It is also about when a path that is really gone shows on the direct connections (ICE `disconnected`), and
 * short enough that players who wait for somebody who did leave are told almost at once.
 */
export const DEFAULT_DISCONNECT_GRACE_MS = 5_000;
/** I11.4.9: a PC whose own 3D wait ran out and that said nothing more is waited for this much longer, then let go. */
export const STREAM3D_WAIT_GRACE_MS = 2_000;
/** I11.4.9: the longest a PC can ask to be waited for in one PARTICIPANT_UPDATE (the schema's limit). */
export const STREAM3D_WAIT_MAX_MS = 120_000;
const HOST_ONLY_TYPES: ReadonlySet<MessageType> = new Set(['HELLO_ACK', 'REFUSE', 'MATCH_READY', 'TURN_GRANT', 'TURN_PASS', 'RESULT', 'REJECT', 'NEXT_GAME', 'MATCH_END']);
const ZERO_HASH = '0'.repeat(64);
const defaultTableOpen = (g: GameFingerprint): boolean => g.tableHash !== ZERO_HASH;
/** A17: what a member says to the lobby and not to a match: the envelope carries the lobby's code (the open match's id is taken too). */
const LOBBY_TYPES: ReadonlySet<MessageType> = new Set(['PARTICIPANT_UPDATE', 'MEDIA_SIGNAL', 'START_REQUEST', 'START_CANCEL', 'END_REQUEST', 'TABLE_PICK']);
/** A17: what only a player of the game being played may send; a watcher reports nothing and signs nothing. */
const PLAYER_ONLY_TYPES: ReadonlySet<MessageType> = new Set(['STATE', 'DMD_FRAME', 'BALL_END', 'GAME_OVER', 'FORFEIT', 'PAUSE', 'RESUME', 'LOG_SIGN']);
/** Frames a host passes on with `from` preserved on a star transport. MEDIA_SIGNAL goes to its `to` only (D2). */
const RELAYED_TYPES: ReadonlySet<MessageType> = new Set(['STATE', 'DMD_FRAME', 'HOST_TRANSFER_ACK', 'MEDIA_SIGNAL', 'PARTICIPANT_UPDATE']);

export class HostMatch {
  readonly events = new Emitter<HostEvents>();
  private readonly s: Session;
  /** The id on match frames. Without a lobby it never changes; in a lobby it is the open match's, and the code when none is open. */
  private matchId: string;
  private readonly ballEndTimeoutMs: number;
  private readonly logSignTimeoutMs: number;
  private readonly companionVersion: string;
  /** Pre-start roster, host first. After start the roster lives in state.participants. */
  private lobby: ParticipantInfo[] = [];
  private hostGame: GameFingerprint;
  private readonly fingerprintPolicy: 'refuse' | 'advise';
  /** Players accepted with a differing fingerprint (`advise` only), with what differed. */
  private readonly mismatched = new Map<PlayerId, PayloadOf<'REFUSE'>['mismatches']>();
  /** Each lobby client's fingerprint (HELLO, then PARTICIPANT_UPDATE), so a change of `hostGame` can re-compare them. */
  private readonly lobbyGames = new Map<PlayerId, GameFingerprint>();
  /** A13: what each lobby participant (this host included) said about its table's ball ends; not in it = unknown. */
  private readonly ballEndReady = new Map<PlayerId, boolean>();
  /** B26.4: what each participant said about the Midnight Madness setting on its table (HELLO_ACK `midnightModes`). */
  private readonly midnightModeOf = new Map<PlayerId, MidnightMode>();
  /** A6.1 (2026-11-01): rigs changed after MATCH_READY, by player (the log's roster keeps the ones it started with). */
  private readonly liveRigs = new Map<PlayerId, ParticipantInfo['rig']>();
  private turnMode: 'alternating' | 'simultaneous';
  private ballEndTimer: TimerHandle | null = null;
  private logSignTimer: TimerHandle | null = null;
  private finalHead: LogHead | null = null;
  private resultSent = false;
  /** Every RESULT as sent, one per game (A10), for a participant that reconnects after they went out (A3). */
  private readonly resultMsgs: Message<'RESULT'>[] = [];
  /** A10: MATCH_END went out. */
  private ended = false;
  /** A11: the start countdown under way: its timer and when it runs out (this host's clock). */
  private startTimer: TimerHandle | null = null;
  private startAt: number | null = null;
  /**
   * I11.4.9: the lobby participants whose PC said its 3D connection is still being made, with when (this host's
   * clock) it said it would stop waiting. A start from the table waits for them (the controller's `tryStartFromTable`).
   */
  private readonly stream3dWait = new Map<PlayerId, number>();
  private stream3dTimer: TimerHandle | null = null;
  private readonly tableOpen: (game: GameFingerprint) => boolean;
  private readonly signatures = new Map<PlayerId, LogSignRecord>();
  /** Players whose link dropped, by the transport's account (independent of the log). */
  private readonly gone = new Set<PlayerId>();
  /** A18: of those, the ones still inside the grace (the timer that ends it): not yet a disconnect for anyone. */
  private readonly grace = new Map<PlayerId, TimerHandle>();
  private readonly graceMs: number;
  /** A18: `nextGame()` was asked for while a player was inside the grace: it starts when the grace settles. */
  private nextGameHeld = false;
  private transferAccepts = new Set<PlayerId>();
  private detached = false;
  private readonly unsubscribe: (() => void)[] = [];
  /** A17: this engine is a lobby (`HostOptions.lobby`). Everything the lobby adds is behind this flag. */
  private readonly lobbyOn: boolean;
  /** A17: the lobby's code: what a HELLO names (`HostOptions.matchId`). */
  private readonly code: string;
  private readonly lobbySize: number;
  /** A17: the number the next match gets. */
  private matchNumber: number;
  private readonly logPageSize: number;
  private readonly logPageGapMs: number;
  /** A17: each member's choice at the next start; not in it = play. */
  private readonly stances = new Map<PlayerId, Stance>();
  /** A17: the members whose PC said it has no copy of the lobby's table. */
  private readonly withoutCopy = new Set<PlayerId>();
  /** A17: the members on whose table a game of their own is running. */
  private readonly inOwnGame = new Set<PlayerId>();
  /**
   * A17: the members the open match's log is still being sent to, each with the index of the next entry to send.
   * Nobody in here is sent a logged message (it would land in a log that is not there yet); the page that follows
   * carries it.
   */
  private readonly catchUps = new Map<PlayerId, { next: number; restart: boolean; pages: number; from: number; timer: TimerHandle | null }>();
  /** A17: the match that was closed last, with its log as it stood. */
  private lastMatch: { matchId: string; log: MatchLog } | null = null;
  /** A17: the order a held next game was asked with (`nextGame(order)`), if any. */
  private heldOrder: PlayerId[] | undefined;

  constructor(opts: HostOptions, session?: Session) {
    this.s = session ?? new Session({ transport: opts.transport, keys: opts.keys, clock: opts.clock });
    this.matchId = opts.matchId;
    this.code = opts.matchId;
    const lobby: LobbyOptions | null = opts.lobby === true ? {} : opts.lobby || null;
    this.lobbyOn = lobby !== null;
    this.lobbySize = Math.max(2, Math.floor(lobby?.size ?? 4));
    this.matchNumber = Math.max(1, Math.floor(lobby?.firstMatch ?? 1));
    this.logPageSize = Math.max(1, Math.min(MATCH_LOG_PAGE_SIZE, Math.floor(lobby?.logPageSize ?? MATCH_LOG_PAGE_SIZE)));
    this.logPageGapMs = Math.max(0, lobby?.logPageGapMs ?? 0);
    this.ballEndTimeoutMs = opts.ballEndTimeoutMs ?? DEFAULT_BALL_END_TIMEOUT_MS;
    this.logSignTimeoutMs = opts.logSignTimeoutMs ?? DEFAULT_LOG_SIGN_TIMEOUT_MS;
    this.graceMs = Math.max(0, opts.disconnectGraceMs ?? DEFAULT_DISCONNECT_GRACE_MS);
    this.companionVersion = opts.companionVersion ?? '0.1.0';
    this.hostGame = { ...opts.hostGame };
    this.fingerprintPolicy = opts.fingerprintPolicy ?? 'refuse';
    this.turnMode = opts.turnMode ?? 'alternating';
    this.tableOpen = opts.tableOpen ?? defaultTableOpen;
    if (opts.hostParticipant.playerId !== opts.transport.localId) {
      throw new Error('hostParticipant.playerId must equal transport.localId');
    }
    this.lobby = [{ ...opts.hostParticipant, publicKey: opts.keys.publicKeyB64 }];
    if (opts.ballEndReady !== undefined) this.ballEndReady.set(this.localId, opts.ballEndReady);
    if (lobby !== null) this.stances.set(this.localId, lobby.stance ?? 'play');
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
        disconnectGraceMs: opts.disconnectGraceMs,
      },
      session,
    );
    for (const id of opts.gone ?? []) host.gone.add(id);
    for (const [id, m] of Object.entries(opts.tableMismatches ?? {})) if (m.length > 0) host.mismatched.set(id, m.map((x) => ({ ...x })));
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

  /** A17: this engine is a lobby (`HostOptions.lobby`). */
  get isLobby(): boolean {
    return this.lobbyOn;
  }

  /** A17: the lobby's code (`HostOptions.matchId`): what a HELLO names, and what the lobby's own messages carry. */
  get lobbyCode(): string {
    return this.code;
  }

  /**
   * A17: everyone in the lobby, this PC first, then in the order they joined, in every phase. Without a lobby it is
   * the people who joined before the start (afterwards `roster()` has the match's).
   */
  members(): ParticipantInfo[] {
    return this.lobby.map((p) => ({ ...p }));
  }

  /** A17: a member's choice at the next start; null for somebody who is not in the lobby (or with no lobby). */
  stanceOf(id: PlayerId): Stance | null {
    if (!this.lobbyOn || !this.isMember(id)) return null;
    return this.stances.get(id) ?? 'play';
  }

  /**
   * A17: who a match started now would be played by: the members set to Play who are on a link and whose PC has
   * the table, in the lobby's order.
   */
  playSet(): PlayerId[] {
    if (!this.lobbyOn) return [];
    return this.lobby.map((p) => p.playerId).filter((id) => this.stances.get(id) !== 'watch' && !this.gone.has(id) && !this.withoutCopy.has(id));
  }

  /** A17: the match that is open in the lobby, as HELLO_ACK says it (`match`); null when none is, and without a lobby. */
  openMatch(): NonNullable<PayloadOf<'HELLO_ACK'>['match']> | null {
    const st = this.s.state;
    if (!this.lobbyOn || st.phase === 'lobby' || !st.matchId) return null;
    return { matchId: st.matchId, players: st.participants.map((p) => p.playerId), game: Math.max(1, st.gameNumber), state: st.phase === 'running' ? 'game' : 'between' };
  }

  /** A17: the match that was closed last in this lobby, with its log as it stood at MATCH_END; null before any. */
  previousMatch(): { matchId: string; log: MatchLog } | null {
    return this.lastMatch ? { ...this.lastMatch } : null;
  }

  /** Who joined with a differing fingerprint (`fingerprintPolicy: 'advise'`) and what differed. Advisory only. */
  tableMismatches(): Record<PlayerId, PayloadOf<'REFUSE'>['mismatches']> {
    return Object.fromEntries([...this.mismatched].map(([id, m]) => [id, m.map((x) => ({ ...x }))]));
  }

  /** A13: what each participant said about its table's ball ends (false: it cannot report them); not listed = unknown. */
  ballEndReadiness(): Record<PlayerId, boolean> {
    return Object.fromEntries(this.ballEndReady);
  }

  /** B26.4: what each participant said about the Midnight Madness setting on its table; not listed = it said nothing. */
  midnightModes(): Record<PlayerId, MidnightMode> {
    return Object.fromEntries([...this.midnightModeOf].map(([id, m]) => [id, { ...m }]));
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

  /**
   * A6 (2026-10-31): the host's own rig or table changed while in the lobby (it hosted before its table loaded).
   * Replaces its roster entry's `rig` and `hostGame`, re-compares every client's fingerprint, and re-sends HELLO_ACK
   * to every client. False (nothing done) when nothing changed. A6.1 (2026-11-01): after MATCH_READY only the rig
   * counts (the owner's rig read VR 7 s after Start): it goes to every client as this host's PARTICIPANT_UPDATE.
   * A13: `ballEndReady` is this host's own table (lobby only), told to every client in the same HELLO_ACK.
   * I11.4.9: so is `stream3dWaitMs`, this host's own 3D connection (lobby only; `stream3dWaiting`).
   */
  updateLocal(u: PayloadOf<'PARTICIPANT_UPDATE'>): boolean {
    this.assertActive();
    // A17: in a lobby this PC is a member row like any other, in every phase (and `stance`, `noCopy` and `ownGame`
    // are its own choice and facts; without a lobby those three keys are not read).
    if (this.lobbyOn) return this.updateMember(this.localId, u, null);
    if (this.s.state.phase !== 'lobby') {
      if (u.rig === undefined || !this.noteLiveRig(this.localId, u.rig)) return false;
      const msg = this.s.build('PARTICIPANT_UPDATE', { rig: u.rig }, this.matchId);
      for (const id of this.s.state.playerOrder) if (id !== this.localId && !this.gone.has(id)) this.s.transport.send(id, msg);
      return true;
    }
    const me = this.lobby[0]!;
    const rigChanged = u.rig !== undefined && u.rig !== me.rig;
    const gameChanged = u.game !== undefined && !sameGame(u.game, this.hostGame);
    const readyChanged = u.ballEndReady !== undefined && u.ballEndReady !== this.ballEndReady.get(this.localId);
    // I11.4.9: this host's own 3D connection is (or is no longer) being made.
    const waitChanged = u.stream3dWaitMs !== undefined && this.noteStream3dWait(this.localId, u.stream3dWaitMs);
    if (!rigChanged && !gameChanged && !readyChanged && !waitChanged) return false;
    if (readyChanged) this.ballEndReady.set(this.localId, u.ballEndReady!);
    if (rigChanged) this.lobby[0] = { ...me, rig: u.rig! };
    if (gameChanged) {
      this.hostGame = { ...u.game! };
      for (const [id, g] of this.lobbyGames) this.setMismatch(id, compareFingerprints(this.hostGame, g, this.localId));
    }
    this.events.emit('participantUpdated', { ...this.lobby[0]! });
    this.resendAck();
    return true;
  }

  /**
   * B26 (2026-11-16): this host flags one of its own balls (the Midnight Madness flag): to every client as this
   * host's PARTICIPANT_UPDATE, and `advisory` here. Never logged. False (nothing sent) in the lobby.
   */
  localAdvisory(advisory: PlayerAdvisory): boolean {
    this.assertActive();
    if (this.s.state.phase === 'lobby') return false;
    // A17: a lobby's PC that is not in the game has no ball of its own to flag.
    if (this.watchesNow()) return false;
    const msg = this.s.build('PARTICIPANT_UPDATE', { advisory }, this.matchId);
    for (const id of this.updateAudience()) this.s.transport.send(id, msg);
    this.events.emit('advisory', { playerId: this.localId, advisory: msg.payload.advisory! });
    return true;
  }

  /**
   * B26.4 (2026-11-16): how the Midnight Madness setting reads on this host's own table. In the lobby every client
   * hears it in a re-sent HELLO_ACK (`midnightModes`); after MATCH_READY as this host's PARTICIPANT_UPDATE. Never
   * logged. False (nothing sent) when it is what this host said last.
   */
  localMidnightMode(mode: MidnightMode): boolean {
    this.assertActive();
    if (!this.noteMidnightMode(this.localId, mode)) return false;
    // A17: in a lobby HELLO_ACK says it in every phase.
    if (this.s.state.phase === 'lobby' || this.lobbyOn) {
      this.resendAck();
      return true;
    }
    const msg = this.s.build('PARTICIPANT_UPDATE', { midnightMode: mode }, this.matchId);
    for (const id of this.updateAudience()) this.s.transport.send(id, msg);
    return true;
  }

  /** Who a PARTICIPANT_UPDATE of this host's own goes to after MATCH_READY: the game's players; in a lobby (A17) every member. */
  private updateAudience(): PlayerId[] {
    const ids = this.lobbyOn ? this.lobby.map((p) => p.playerId) : this.s.state.playerOrder;
    return ids.filter((id) => id !== this.localId && !this.gone.has(id));
  }

  /** B26.4: records a player's setting and raises `midnightMode`; false when it is the one already known. */
  private noteMidnightMode(id: PlayerId, mode: MidnightMode): boolean {
    const known = this.midnightModeOf.get(id);
    if (known && known.enabled === mode.enabled && known.adjustment === mode.adjustment) return false;
    this.midnightModeOf.set(id, { enabled: mode.enabled, adjustment: mode.adjustment });
    this.events.emit('midnightMode', { playerId: id, mode: { enabled: mode.enabled, adjustment: mode.adjustment } });
    return true;
  }

  /**
   * A11 (2026-11-02): the lobby participants whose table is not open (by `HostOptions.tableOpen` over their latest
   * fingerprint), this host included. Empty after the start.
   */
  loading(): PlayerId[] {
    // A17: a lobby says it in every phase: a member's table can close and open while a match is played.
    if (this.s.state.phase !== 'lobby' && !this.lobbyOn) return [];
    return this.lobby
      .map((p) => p.playerId)
      .filter((id) => {
        const g = id === this.localId ? this.hostGame : this.lobbyGames.get(id);
        return g === undefined || !this.tableOpen(g);
      });
  }

  /**
   * I11.4.9 (2026-11-20): the lobby participants (this host included) whose 3D connection is still being made, and the
   * ms after which each stops being waited for (`PARTICIPANT_UPDATE.stream3dWaitMs`, this host's own through
   * `updateLocal`). A PC that said nothing more is let go `STREAM3D_WAIT_GRACE_MS` after its own time ran out. Empty
   * after the start: only the match's first start waits.
   */
  stream3dWaiting(): Array<{ playerId: PlayerId; leftMs: number }> {
    if (this.s.state.phase !== 'lobby') return [];
    const now = this.s.clock.now();
    return this.lobby
      .map((p) => ({ playerId: p.playerId, until: this.stream3dWait.get(p.playerId) }))
      .filter((x): x is { playerId: PlayerId; until: number } => x.until !== undefined && now < x.until + STREAM3D_WAIT_GRACE_MS)
      .map((x) => ({ playerId: x.playerId, leftMs: Math.max(0, Math.min(STREAM3D_WAIT_MAX_MS, Math.round(x.until - now))) }));
  }

  /**
   * I11.4.9: what a participant said about its 3D connection (0: settled). True when who is waited for changed, or the
   * time one of them is waited for moved by more than a second (a re-sent estimate is not news).
   */
  private noteStream3dWait(id: PlayerId, ms: number): boolean {
    const now = this.s.clock.now();
    const before = this.stream3dWait.get(id);
    const was = before !== undefined && now < before + STREAM3D_WAIT_GRACE_MS;
    if (ms <= 0) this.stream3dWait.delete(id);
    else this.stream3dWait.set(id, now + Math.min(STREAM3D_WAIT_MAX_MS, ms));
    this.armStream3dTimer();
    const until = this.stream3dWait.get(id);
    if (until === undefined) return was;
    return !was || Math.abs(until - (before as number)) > 1000;
  }

  /** I11.4.9: a PC that never says it settled is let go when its time (and the grace) is up: the lobby hears of it. */
  private armStream3dTimer(): void {
    if (this.stream3dTimer !== null) this.s.clock.clearTimeout(this.stream3dTimer);
    this.stream3dTimer = null;
    if (this.detached || this.s.state.phase !== 'lobby' || this.stream3dWait.size === 0) return;
    const now = this.s.clock.now();
    const next = Math.min(...this.stream3dWait.values()) + STREAM3D_WAIT_GRACE_MS;
    this.stream3dTimer = this.s.clock.setTimeout(() => {
      this.stream3dTimer = null;
      if (this.detached || this.s.state.phase !== 'lobby') return;
      const t = this.s.clock.now();
      for (const [id, until] of [...this.stream3dWait]) if (t >= until + STREAM3D_WAIT_GRACE_MS) this.stream3dWait.delete(id);
      this.armStream3dTimer();
      this.events.emit('participantUpdated', { ...this.lobby[0]! });
      this.resendAck();
    }, Math.max(0, next - now));
  }

  private clearStream3dWait(): void {
    if (this.stream3dTimer !== null) this.s.clock.clearTimeout(this.stream3dTimer);
    this.stream3dTimer = null;
    this.stream3dWait.clear();
  }

  /** A11: ms left of the start countdown, or null when none runs. */
  countdownRemaining(): number | null {
    return this.startAt === null ? null : Math.max(0, this.startAt - this.s.clock.now());
  }

  /**
   * A11 (2026-11-02): start the match in `ms` (the host's first game on its table): every client sees the countdown in
   * a HELLO_ACK. False (nothing done) when one already runs (a second plunge does not restart or cancel it), the match
   * has started, or fewer than two are in. When it runs out with fewer than two, nothing starts (`countdownCancelled`).
   */
  startIn(ms: number): boolean {
    this.assertActive();
    if (this.s.state.phase !== 'lobby' || this.startAt !== null || this.startCount() < 2) return false;
    const wait = Math.max(0, Math.min(60_000, Math.round(ms)));
    this.startAt = this.s.clock.now() + wait;
    this.startTimer = this.s.clock.setTimeout(() => {
      this.startTimer = null;
      this.startAt = null;
      if (this.detached || this.s.state.phase !== 'lobby') return;
      // A17: in a lobby, whatever stops a match from starting now stops this one (the people set to Play changed).
      const off = this.lobbyOn ? this.startMatchBlocker() : this.lobby.length < 2 ? 'fewer than two players are in' : null;
      if (off !== null) {
        this.events.emit('countdownCancelled', { reason: off });
        this.resendAck();
        return;
      }
      this.start();
    }, wait);
    this.events.emit('countdown', { startsInMs: wait });
    this.resendAck();
    return true;
  }

  private clearStartTimer(): void {
    if (this.startTimer !== null) this.s.clock.clearTimeout(this.startTimer);
    this.startTimer = null;
    this.startAt = null;
  }

  /** How many would play a match started now: everyone who joined; in a lobby (A17) the people set to Play (`playSet`). */
  private startCount(): number {
    return this.lobbyOn ? this.playSet().length : this.lobby.length;
  }

  /**
   * Freeze the roster and start the rotation. Needs at least two participants. Ends a countdown (A11).
   * A17: in a lobby it starts a match with `playSet()` (two to four people), and only while no match is open: with
   * one open, `nextGame()` goes on with its players and `startMatch()` starts a new one.
   */
  start(): void {
    this.assertActive();
    if (this.s.state.phase !== 'lobby') throw new Error('match already started');
    if (this.lobbyOn) {
      const why = this.startMatchBlocker();
      if (why !== null) throw new Error(why);
      this.beginMatch(this.playSet());
      return;
    }
    if (this.lobby.length < 2) throw new Error('need at least two participants to start');
    this.clearStartTimer();
    // I11.4.9: only the first start waits for a 3D connection, and this is it (or the host's "start now").
    this.clearStream3dWait();
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

  /**
   * A17 (2026-11-25): why a NEW match cannot start now with `players` (default `playSet()`), or null when it can: no
   * game may be running, the last game's RESULT must be out, and the players must be two to four members who are on
   * a link. Who is set to Play is the caller's business when it names the players itself.
   */
  startMatchBlocker(players?: readonly PlayerId[]): string | null {
    const st = this.s.state;
    if (!this.lobbyOn) return 'this match has no lobby';
    if (this.detached) return 'this companion is not the host any more';
    if (this.ended) return 'the lobby is closed';
    if (st.phase === 'running') return 'a game is being played';
    if (st.phase === 'ended' && !this.resultSent) return "the last game's result has not gone out yet";
    const order = players ?? this.playSet();
    if (new Set(order).size !== order.length) return 'a player is named twice';
    for (const id of order) {
      if (!this.isMember(id)) return `${id} is not in the lobby`;
      if (this.gone.has(id)) return `${id} is away`;
    }
    if (order.length < 2) return 'a match needs two people set to Play';
    if (order.length > 4) return 'a match has at most four players';
    return null;
  }

  /**
   * A17 (2026-11-25): start a new match in the lobby with `players`, the first to go first (default: `playSet()`).
   * This PC need not be one of them. With a match open between games it ends that one first (MATCH_END, "a new
   * match was started") and the new one follows at once: the one way a person who is not in the open match comes
   * into play. False, with nothing done, when `startMatchBlocker` says why not.
   */
  startMatch(players?: readonly PlayerId[]): boolean {
    this.assertActive();
    if (this.startMatchBlocker(players) !== null) return false;
    const order = players ? [...players] : this.playSet();
    if (this.s.state.phase === 'ended') this.closeMatch('a new match was started');
    this.beginMatch(order);
    return true;
  }

  /** A17: MATCH_READY for a match of the lobby: a new log, the next id, the players and nobody else in its roster. */
  private beginMatch(order: PlayerId[]): void {
    this.clearStartTimer();
    this.clearStream3dWait();
    this.resetMatch();
    this.matchId = `${this.code}-${this.matchNumber}`;
    this.matchNumber += 1;
    const first = order[0] as PlayerId;
    const payload: PayloadOf<'MATCH_READY'> = {
      matchId: this.matchId,
      ballsPerGame: this.ballsPerGameInit,
      playerOrder: [...order],
      participants: order.map((id) => ({ ...(this.lobby.find((p) => p.playerId === id) as ParticipantInfo) })),
      hostPlayerId: this.localId,
      hostPublicKey: this.publicKey,
      // The table of the first player in the order, as their PC has it open.
      game: { ...(first === this.localId ? this.hostGame : (this.lobbyGames.get(first) ?? this.hostGame)) },
      seed: null,
      turnMode: this.turnMode,
    };
    const msg = this.s.build('MATCH_READY', payload, this.matchId);
    this.s.commit({ ts: msg.ts, kind: 'msg', from: this.localId, message: msg });
    // Every member holds this log in full: it begins here. MATCH_READY first, then the lobby that has a match open
    // (a member told of an open match before its MATCH_READY would wait for a log to be sent).
    this.broadcast(msg);
    this.events.emit('ready', msg.payload);
    this.resendAck();
    this.advance();
  }

  /** A17: what belongs to one match is forgotten: its end, its signatures, its RESULTs, its timers. */
  private resetMatch(): void {
    this.clearBallEndTimer();
    if (this.logSignTimer !== null) {
      this.s.clock.clearTimeout(this.logSignTimer);
      this.logSignTimer = null;
    }
    this.finalHead = null;
    this.resultSent = false;
    this.signatures.clear();
    this.resultMsgs.length = 0;
    this.liveRigs.clear();
    this.nextGameHeld = false;
    this.heldOrder = undefined;
  }

  /**
   * A17: the open match is over and everyone is back in the lobby: MATCH_END to every member (also one whose log
   * was still on its way), the log put away, and the lobby said again with no match in it. Nobody leaves and no
   * connection closes, with one exception that is this step's stub for "away": a player of that match whose link is
   * still down is dropped from the lobby, as a link that drops in a lobby always was.
   */
  private closeMatch(reason: string): void {
    const closed = this.matchId;
    const msg = this.s.build('MATCH_END', { games: this.resultMsgs.length, reason: reason.slice(0, 200) }, closed);
    this.stopCatchUps();
    for (const id of this.reachable()) this.s.transport.send(id, msg);
    this.resetMatch();
    this.lastMatch = { matchId: closed, log: this.s.newMatch() };
    this.matchId = this.code;
    for (const id of [...this.gone]) this.dropMember(id, false);
    this.gone.clear();
    this.events.emit('matchEnded', msg.payload);
    this.resendAck();
  }

  /**
   * A17 (2026-11-25): close the lobby for everyone: a match open between games is ended first (MATCH_END), then
   * every member is told LOBBY_CLOSED and nothing more can happen here; the caller closes the engine. A game that
   * is being played is not ended by a message of its own yet (the next step ends it for everyone, with no result):
   * its log stops where it stands. False without a lobby, or when it is closed already.
   */
  closeLobby(reason = 'the lobby was closed'): boolean {
    this.assertActive();
    if (!this.lobbyOn || this.ended) return false;
    if (this.s.state.phase === 'ended' && this.resultSent) this.closeMatch('the lobby was closed');
    this.ended = true;
    // Nothing of a game that was being played acts after this: no ball-end timeout, no grace running out.
    this.clearStartTimer();
    this.clearStream3dWait();
    this.stopCatchUps();
    this.resetMatch();
    for (const t of this.grace.values()) this.s.clock.clearTimeout(t);
    this.grace.clear();
    const msg = this.s.build('LOBBY_CLOSED', { reason: reason.slice(0, 200) }, this.code);
    for (const id of this.reachable()) this.s.transport.send(id, msg);
    this.events.emit('lobbyClosed', msg.payload);
    return true;
  }

  /**
   * A10 (2026-11-02): why the next game cannot start now, or null when it can: the current game must have ended and
   * its RESULT gone out, the series not be over, and two of the roster still be connected.
   * A17: in a lobby the next game is for the open match's own players: `order`, when given, must name only them
   * (anyone else takes a new match, `startMatch`); without it, those of them who are set to Play and here.
   */
  nextGameBlocker(order?: readonly PlayerId[]): string | null {
    const st = this.s.state;
    if (this.detached) return 'this companion is not the host any more';
    if (this.ended) return this.lobbyOn ? 'the lobby is closed' : 'the match has ended';
    if (st.phase === 'lobby') return 'the match has not started';
    if (st.phase !== 'ended') return 'the current game is still being played';
    if (!this.resultSent) return "the last game's result has not gone out yet";
    if (this.lobbyOn && order) {
      if (new Set(order).size !== order.length) return 'a player is named twice';
      for (const id of order) {
        if (!st.participants.some((p) => p.playerId === id)) return `${id} is not a player of this match: that takes a new match`;
        if (!this.isMember(id) || this.away(id)) return `${id} is away`;
      }
      if (order.length > 4) return 'a game has at most four players';
    }
    if (this.nextGameOrder(order).length < 2) return this.lobbyOn ? 'fewer than two players of this match are set to Play and here' : 'fewer than two players are still connected';
    return null;
  }

  /** A18: gone for longer than the grace (a player inside it may be back before anyone notices). */
  private away(id: PlayerId): boolean {
    return this.gone.has(id) && !this.grace.has(id);
  }

  /**
   * The next game's players: the roster still connected, in roster order, this host first.
   * A17: in a lobby, `order` as given, else the open match's players who are still members, on a link, set to Play
   * and with the table, in the match's order; this PC first when it is one of them (its table starts the game,
   * until a start can be asked for by anyone).
   */
  private nextGameOrder(order?: readonly PlayerId[]): PlayerId[] {
    if (this.lobbyOn) {
      if (order) return [...order];
      const ids = this.s.state.participants.map((p) => p.playerId).filter((id) => this.isMember(id) && !this.away(id) && this.stances.get(id) !== 'watch' && !this.withoutCopy.has(id));
      return ids.includes(this.localId) ? [this.localId, ...ids.filter((id) => id !== this.localId)] : ids;
    }
    const ids = this.s.state.participants.map((p) => p.playerId).filter((id) => id !== this.localId && !this.away(id));
    return [this.localId, ...ids];
  }

  /**
   * A10: start the next game of the series (NEXT_GAME, logged) and issue its grant 1 (to this host). False, with
   * nothing done, when `nextGameBlocker()` says why not: a `game_start` on the table before the last RESULT went out
   * is ignored this way.
   */
  nextGame(order?: readonly PlayerId[]): boolean {
    this.assertActive();
    // A17: `order` (who plays it, the first to go first) is read in a lobby only.
    const asked = this.lobbyOn && order ? [...order] : undefined;
    if (this.nextGameBlocker(asked) !== null) return false;
    // A18: who plays it is not known while a player's link dropped a moment ago: back in time, they are in it; gone,
    // they are not (and with only them left there is no next game). Held until the grace settles (`settleNextGame`).
    if (this.grace.size > 0) {
      this.nextGameHeld = true;
      this.heldOrder = asked;
      return true;
    }
    this.startNextGame(asked);
    return true;
  }

  /** A18: a next game is held for a player inside the grace (asked for, not started yet). */
  get nextGamePending(): boolean {
    return this.nextGameHeld;
  }

  /** A18: the grace of a player ended, one way or the other: a next game that was held for it starts now, or is off. */
  private settleNextGame(): void {
    if (!this.nextGameHeld || this.grace.size > 0 || this.detached) return;
    this.nextGameHeld = false;
    const asked = this.heldOrder;
    this.heldOrder = undefined;
    const why = this.nextGameBlocker(asked);
    if (why !== null) {
      this.events.emit('nextGameOff', { reason: why });
      return;
    }
    this.startNextGame(asked);
  }

  private startNextGame(order?: readonly PlayerId[]): void {
    const st = this.s.state;
    const msg = this.s.build('NEXT_GAME', { game: st.gameNumber + 1, playerOrder: this.nextGameOrder(order) }, this.matchId);
    this.finalHead = null;
    this.resultSent = false;
    this.signatures.clear();
    if (this.logSignTimer !== null) {
      this.s.clock.clearTimeout(this.logSignTimer);
      this.logSignTimer = null;
    }
    this.s.commit({ ts: msg.ts, kind: 'msg', from: this.localId, message: msg });
    this.broadcast(msg);
    this.events.emit('nextGame', msg.payload);
    // A17: the lobby's open match is in another game now.
    if (this.lobbyOn) this.resendAck();
    this.advance();
  }

  /**
   * A10: end the series between games (MATCH_END, never logged; the last RESULT stands). False when a game is still
   * being played or its RESULT has not gone out (the Match tab's Leave covers a match left mid-game), or it already ended.
   */
  endMatch(reason = 'the host ended the match'): boolean {
    this.assertActive();
    const st = this.s.state;
    if (this.ended || st.phase !== 'ended' || !this.resultSent) return false;
    // A17: in a lobby the end of a match is not the end of anything else: back to the lobby, and another can start.
    if (this.lobbyOn) {
      this.closeMatch(reason);
      return true;
    }
    this.ended = true;
    this.nextGameHeld = false;
    const msg = this.s.build('MATCH_END', { games: Math.max(1, st.gameNumber), reason: reason.slice(0, 200) }, this.matchId);
    this.broadcast(msg);
    this.events.emit('matchEnded', msg.payload);
    return true;
  }

  /** A10: MATCH_END went out. */
  get matchEnded(): boolean {
    return this.ended;
  }

  /** A10: the current game's RESULT went out (so the next game may start). */
  get resultOut(): boolean {
    return this.resultSent;
  }

  /** After `resumeFromLog`: re-issue the outstanding grant (or continue the rotation). */
  run(): void {
    this.assertActive();
    this.advance();
  }

  /**
   * A15: after `resumeFromLog` from a saved log (Castcade restarted; nobody is on a link yet). The grant that was
   * outstanding is issued again under a new number, as after a RESUME: at once when it is this host's own, else once
   * its holder is back (the usual disconnect pause, which that player's RESUME clears). So a ball end that was
   * reported into the dead link, or happened while Castcade was closed, has a live grant to be reported for. Between
   * games the result goes out again (each player gets it at its RECONNECT), so the next game can start.
   */
  runAfterRestart(): void {
    this.assertActive();
    const st = this.s.state;
    if (st.phase === 'running' && st.currentGrant && !st.paused && !st.pendingTransfer) {
      st.pendingReissue = { player: st.currentGrant.grant.player, ballNumber: st.currentGrant.grant.ballNumber };
      st.currentGrant = null;
    }
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
    // A17: a lobby's PC that is not in the game reports nothing from its own table, as any watcher.
    if (this.watchesNow()) return;
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

  /** A13: why the turn cannot be passed now, or null when it can: a grant must be outstanding and no transfer pending. */
  passTurnBlocker(): string | null {
    const st = this.s.state;
    if (this.detached) return 'this companion is not the host any more';
    if (st.phase !== 'running') return 'no game is being played';
    if (st.pendingTransfer) return 'a host transfer is under way';
    if (!st.currentGrant) return 'nobody holds the turn right now';
    return null;
  }

  /**
   * A13 (2026-11-12): end the outstanding grant's ball by hand and go on with the rotation, as if the holder's BALL_END
   * (no shoot-again) had arrived: a logged TURN_PASS from this host, naming the grant, its holder and the score the
   * ball ends at (`score`; default: the holder's last logged score). Works for this host's own ball and a client's.
   * False, with nothing done, when `passTurnBlocker()` says why not.
   */
  passTurn(score?: number): boolean {
    this.assertActive();
    const g = this.s.state.currentGrant?.grant;
    if (this.passTurnBlocker() !== null || !g) return false;
    const msg = this.s.build(
      'TURN_PASS',
      { grantSeq: g.grantSeq, player: g.player, ballNumber: g.ballNumber, score: score ?? this.s.state.players[g.player]?.score ?? 0 },
      this.matchId,
    );
    this.clearBallEndTimer();
    this.s.commit({ ts: msg.ts, kind: 'msg', from: this.localId, message: msg });
    this.broadcast(msg);
    this.events.emit('turnPassed', msg);
    this.advance();
    return true;
  }

  localState(state: Omit<PayloadOf<'STATE'>, 'extraBalls'> & { extraBalls?: number }): void {
    this.assertActive();
    if (this.watchesNow()) return;
    const msg = this.s.build('STATE', state, this.matchId);
    this.mirror(msg);
    this.events.emit('state', msg);
  }

  /**
   * D2: the host's own WebRTC signal, straight to `to`. Never throws and never logs: ICE callbacks fire late (after a
   * step-down, or for a peer that just dropped), and a lost signal costs a renegotiation, not the match. False when
   * nothing was sent.
   */
  sendMediaSignal(to: PlayerId, signal: OutgoingMediaSignal): boolean {
    if (this.detached || to === this.localId) return false;
    let msg: Message<'MEDIA_SIGNAL'>;
    try {
      msg = this.s.build('MEDIA_SIGNAL', { ...signal, to }, this.matchId);
    } catch {
      return false; // not a valid MEDIA_SIGNAL (an oversized SDP, a bad id): the schema refused it
    }
    return this.forwardMediaSignal(msg);
  }

  localDmd(frame: PayloadOf<'DMD_FRAME'>): void {
    this.assertActive();
    if (this.watchesNow()) return;
    const msg = this.s.build('DMD_FRAME', frame, this.matchId);
    this.mirror(msg);
    this.events.emit('dmd', msg);
  }

  localGameOver(finalScore: number, ballsPlayed: number): void {
    this.assertActive();
    if (this.watchesNow()) return;
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
    // A17: the lobby's PC arbitrates every match in it; the hand-over of a lobby is work of its own (design 11.8a).
    if (this.lobbyOn) throw new Error('transferHost: a lobby does not change hands');
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
    this.clearStream3dWait();
    this.clearBallEndTimer();
    this.clearStartTimer();
    this.stopCatchUps();
    for (const t of this.grace.values()) this.s.clock.clearTimeout(t);
    this.grace.clear();
    if (this.logSignTimer !== null) {
      this.s.clock.clearTimeout(this.logSignTimer);
      this.logSignTimer = null;
    }
  }

  private assertActive(): void {
    if (this.detached) throw new Error('this HostMatch has stepped down or been closed');
  }

  /**
   * The logged stream, and RESULT. A17: in a lobby it goes to the members who hold the open match's log in full and
   * to nobody else (`logAudience`); `send('all')` reaches any socket that is connected, also one whose log is still
   * being sent, and a logged message that lands in a log that is not there yet cannot be put right.
   */
  private broadcast(msg: AnyMessage): void {
    if (this.lobbyOn) {
      for (const id of this.logAudience()) this.s.transport.send(id, msg);
      return;
    }
    this.s.transport.send('all', msg);
  }

  /** A17: is in the lobby. */
  private isMember(id: PlayerId): boolean {
    return this.lobby.some((p) => p.playerId === id);
  }

  /** A17: every member but this PC whose link is up. */
  private reachable(): PlayerId[] {
    return this.lobby.map((p) => p.playerId).filter((id) => id !== this.localId && !this.gone.has(id));
  }

  /** A17: the members a logged message goes to: on a link, and not in the middle of being sent the log. */
  private logAudience(): PlayerId[] {
    return this.reachable().filter((id) => !this.catchUps.has(id));
  }

  /** A17: `id` is in the game that is being played (or was played last). */
  private playsNow(id: PlayerId): boolean {
    return this.s.state.phase !== 'lobby' && this.s.state.players[id] !== undefined;
  }

  /** A17: this PC is a lobby's PC and not a player of the game: it has nothing of its own to report. */
  private watchesNow(): boolean {
    return this.lobbyOn && !this.playsNow(this.localId);
  }

  /** STATE / DMD_FRAME: to every other participant, `from` preserved, never logged. A17: in a lobby, to every member. */
  private mirror(msg: AnyMessage): void {
    const ids = this.s.state.phase === 'lobby' || this.lobbyOn ? this.lobby.map((p) => p.playerId) : this.s.state.playerOrder;
    for (const id of ids) {
      if (id === msg.from || id === this.localId || this.gone.has(id)) continue;
      this.s.transport.send(id, msg);
    }
  }

  /** MEDIA_SIGNAL (D2): to `payload.to` and nobody else, `from` preserved, never logged. A peer that is gone is skipped. */
  private forwardMediaSignal(msg: Message<'MEDIA_SIGNAL'>): boolean {
    const to = msg.payload.to;
    if (to === msg.from || to === this.localId || !this.isParticipant(to) || this.gone.has(to)) return false;
    this.s.transport.send(to, msg);
    return true;
  }

  private onMediaSignal(msg: Message<'MEDIA_SIGNAL'>): void {
    const to = msg.payload.to;
    if (to === this.localId) {
      this.events.emit('mediaSignal', { from: msg.from, signal: msg.payload });
      return;
    }
    if (!this.isParticipant(to)) {
      this.reject(msg, 'unknown_player', `MEDIA_SIGNAL for ${to}, who has not joined this match`);
      return;
    }
    this.forwardMediaSignal(msg);
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
    // A17: a closed lobby reads nothing more; only somebody who still tries to join is told so (`onHello`).
    if (this.lobbyOn && this.ended && msg.type !== 'HELLO') return;
    if (msg.from !== linkFrom) {
      // On a star the old host relays acks and mirrors frames until it steps down; one that
      // reaches this host after the transfer is stale, not an impersonation (A2, 2026-10-30).
      if (this.s.transport.topology === 'star' && RELAYED_TYPES.has(msg.type)) return;
      this.reject(msg, 'unknown_player', `from=${msg.from} does not match the link peer ${linkFrom}`);
      return;
    }
    // `seq` is strictly increasing within a connection, and a HELLO opens one: a client that must
    // re-join after a rejected RECONNECT starts a fresh session, so its counter starts over (A3).
    if (msg.type === 'HELLO') this.s.resetSeq(msg.from);
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
    if (this.lobbyOn) {
      if (!this.takesInLobby(msg)) return;
    } else if (msg.matchId !== this.matchId) {
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
      case 'MEDIA_SIGNAL':
        this.onMediaSignal(msg);
        return;
      case 'PARTICIPANT_UPDATE':
        this.onParticipantUpdate(msg);
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
      case 'START_REQUEST':
      case 'START_CANCEL':
      case 'END_REQUEST':
      case 'TABLE_PICK':
        // A17: what a member asks of the lobby. The engine learns to answer them in the next step; until then the
        // asker is told so, and the lobby's PC starts and ends matches itself.
        this.reject(msg, 'unexpected_state', this.lobbyOn ? `${msg.type} is not answered by this build yet` : `${msg.type} is not a client -> host message`);
        return;
      default:
        this.reject(msg, 'unexpected_state', `${msg.type} is not a client -> host message`);
    }
  }

  /**
   * A17: the two things a lobby checks on a member's frame before it is read. The envelope's `matchId`: the lobby's
   * code on what is said to the lobby (the open match's id is taken too), the open match's id on what is said to a
   * match; a frame for a match that is over, or for none, is dropped (a STATE or DMD_FRAME without a word, anything
   * else with a REJECT that changes nothing). And the watcher's rule: what only a player may send is taken from
   * nobody else.
   */
  private takesInLobby(msg: AnyMessage): boolean {
    const open = this.s.state.matchId;
    const quiet = msg.type === 'STATE' || msg.type === 'DMD_FRAME';
    if (LOBBY_TYPES.has(msg.type)) {
      if (msg.matchId === this.code || (open !== null && msg.matchId === open)) return true;
      this.reject(msg, 'schema', `matchId ${String(msg.matchId)} is not this lobby`);
      return false;
    }
    if (open === null || msg.matchId !== open) {
      if (!quiet) this.reject(msg, 'unexpected_state', open === null ? 'no match is open' : `match ${String(msg.matchId)} is over`);
      return false;
    }
    if (PLAYER_ONLY_TYPES.has(msg.type) && !this.playsNow(msg.from)) {
      if (!quiet) this.reject(msg, 'unexpected_state', `${msg.from} is not a player of this game`);
      return false;
    }
    return true;
  }

  /** In the roster (A10: a player out of the current game of a series is still a participant: media, reconnect). */
  private isParticipant(id: PlayerId): boolean {
    // A17: in a lobby, a member: a watcher sends media signals and updates, and is in no match's roster.
    if (this.lobbyOn) return this.isMember(id);
    return this.s.state.phase === 'lobby' ? this.lobby.some((p) => p.playerId === id) : this.s.state.participants.some((p) => p.playerId === id);
  }

  /** `final` (A18): the peer cannot come back (its RECONNECT was refused): a disconnect at once, grace or not. */
  private onPeerLeave(peer: PlayerId, final = false): void {
    if (this.detached) return;
    const st = this.s.state;
    if (this.lobbyOn && this.ended) return;
    if (this.lobbyOn) {
      // A17 step 5, the stub for "away" (the next step keeps a place for three minutes): a member the open match
      // does not hold is out when their link drops, in every phase, as in a lobby before. A player of the open
      // match is kept and follows A18 below, also one who sits this game out (their place in the next is theirs).
      if (!this.isMember(peer)) return;
      if (st.phase === 'lobby' || !st.participants.some((p) => p.playerId === peer)) {
        this.dropMember(peer, true);
        return;
      }
      this.stopCatchUp(peer);
    }
    if (st.phase === 'lobby') {
      const wasIn = this.lobby.some((p) => p.playerId === peer);
      this.lobby = this.lobby.filter((p) => p.playerId !== peer);
      this.lobbyGames.delete(peer);
      this.ballEndReady.delete(peer);
      this.midnightModeOf.delete(peer);
      if (this.stream3dWait.delete(peer)) this.armStream3dTimer();
      if (wasIn) this.setMismatch(peer, []);
      this.events.emit('peerLeft', peer);
      // A8 (2026-10-31): the others' rosters drop the leaver too.
      if (wasIn) this.resendAck();
      return;
    }
    const p = st.players[peer];
    if (!p && !this.lobbyOn) return;
    if (this.gone.has(peer)) {
      const timer = this.grace.get(peer);
      if (!final || timer === undefined) return;
      this.s.clock.clearTimeout(timer);
      this.grace.delete(peer);
      this.confirmLeave(peer);
      return;
    }
    this.gone.add(peer);
    // A18: not a disconnect yet. Nothing is sent to the peer from here on; what it misses is in its RECONNECT_ACK.
    // (A game that ended waits for this player's signature until the grace is over: `confirmLeave`.)
    if (final || this.graceMs <= 0) {
      this.confirmLeave(peer);
      return;
    }
    this.grace.set(
      peer,
      this.s.clock.setTimeout(() => {
        this.grace.delete(peer);
        this.confirmLeave(peer);
      }, this.graceMs),
    );
  }

  /**
   * A18: the grace is over and the peer is not back: now it is a disconnect. The match waits for it only when the
   * waiting cannot be avoided: it holds the outstanding grant (the others see the pause; that player's own table plays
   * on), or its grant is the next to go out (`advance`). A player who is not up changes nothing for the one who is.
   */
  private confirmLeave(peer: PlayerId): void {
    if (this.detached || !this.gone.has(peer)) return;
    this.events.emit('peerLeft', peer);
    // A17: the lobby hears that this member is away.
    if (this.lobbyOn) this.resendAck();
    const st = this.s.state;
    const p = st.players[peer];
    if (st.phase === 'ended') {
      // A game that has ended does not wait any longer for the signature of a player it cannot reach, and a next
      // game that was held for this player is decided now.
      this.maybeSendResult();
      this.settleNextGame();
      return;
    }
    if (st.phase !== 'running' || !p || p.status !== 'playing' || st.pendingTransfer) return;
    if (st.turnMode === 'simultaneous' || st.currentGrant?.grant.player === peer) {
      this.clearBallEndTimer();
      this.pause('disconnect', peer);
      return;
    }
    // A grant that came due for this player during the grace was held: the rotation pauses for it now.
    this.advance();
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
    // A17: a lobby takes a HELLO in every phase while there is room; only a closed one refuses.
    if (this.s.state.phase !== 'lobby' && !this.lobbyOn) {
      this.refuse(msg, 'match_started', 'the roster is final');
      return;
    }
    if (this.lobbyOn && this.ended) {
      this.refuse(msg, 'other', 'this lobby is closed');
      return;
    }
    if (p.participant.playerId !== msg.from) {
      this.refuse(msg, 'other', 'participant.playerId must equal the envelope from');
      return;
    }
    if (p.throwdownCode !== this.code) {
      this.refuse(msg, 'unknown_throwdown', `this host runs ${this.code}, not ${p.throwdownCode}`);
      return;
    }
    if (this.lobby.some((x) => x.playerId === p.participant.playerId)) {
      this.refuse(msg, 'duplicate_player', `${p.participant.playerId} is already in the match`);
      return;
    }
    if (this.lobbyOn && this.lobby.length >= this.lobbySize) {
      this.refuse(msg, 'match_full', `This lobby is full (${this.lobbySize === 4 ? 'four' : this.lobbySize} people).`);
      return;
    }
    if (!this.lobbyOn && this.lobby.length >= 4) {
      this.refuse(msg, 'match_full', 'four participants already');
      return;
    }
    const mismatches = compareFingerprints(this.hostGame, p.game, hostId);
    if (mismatches.length > 0 && this.fingerprintPolicy === 'refuse') {
      const fields = mismatches.map((m) => m.field).join(', ');
      this.refuse(msg, 'fingerprint_mismatch', `game fingerprint differs in: ${fields}`, mismatches);
      return;
    }
    const participant: ParticipantInfo = { ...p.participant };
    this.lobby.push(participant);
    this.lobbyGames.set(participant.playerId, { ...p.game });
    if (p.ballEndReady !== undefined) this.ballEndReady.set(participant.playerId, p.ballEndReady);
    if (this.lobbyOn) this.stances.set(participant.playerId, p.stance ?? 'play');
    if (mismatches.length > 0) {
      this.mismatched.set(participant.playerId, mismatches);
      this.events.emit('tableMismatch', { playerId: participant.playerId, mismatches });
    }
    // The newcomer's answer, and (A8, 2026-10-31) the roster again for everyone already in: with 3-4 players each
    // client sees who else joined, and whose table differs, before MATCH_READY.
    this.resendAck();
    // A17: a match is open: its log follows the answer, unasked, in the same turn (or page by page), and until the
    // last page this member is sent no logged message.
    if (this.lobbyOn && this.s.state.phase !== 'lobby') this.sendLog(participant.playerId, 0, true);
    this.events.emit('joined', participant);
  }

  // ------------------------------------------------------------------------------------------
  // A17: the lobby's members, and the log for a member who does not hold it
  // ------------------------------------------------------------------------------------------

  /**
   * A17: one member's facts or choice changed (their PARTICIPANT_UPDATE, or `updateLocal` for this PC), in any
   * phase: the row is replaced and HELLO_ACK goes to every member. A match's logged roster and fingerprint stay
   * what its MATCH_READY said. `msg` is the member's frame (null for this PC). False when nothing changed.
   */
  private updateMember(id: PlayerId, u: PayloadOf<'PARTICIPANT_UPDATE'>, msg: Message<'PARTICIPANT_UPDATE'> | null): boolean {
    const i = this.lobby.findIndex((p) => p.playerId === id);
    if (i < 0) return false;
    const st = this.s.state;
    let changed = false;
    if (u.game !== undefined && id === this.localId) {
      if (!sameGame(u.game, this.hostGame)) {
        this.hostGame = { ...u.game };
        for (const [other, g] of this.lobbyGames) this.setMismatch(other, compareFingerprints(this.hostGame, g, this.localId));
        changed = true;
      }
    } else if (u.game !== undefined && !sameGame(u.game, this.lobbyGames.get(id))) {
      const mismatches = compareFingerprints(this.hostGame, u.game, this.localId);
      if (mismatches.length > 0 && this.fingerprintPolicy === 'refuse') {
        if (msg) this.reject(msg, 'unexpected_state', `game fingerprint differs in: ${mismatches.map((m) => m.field).join(', ')}`);
        return false;
      }
      this.lobbyGames.set(id, { ...u.game });
      this.setMismatch(id, mismatches);
      changed = true;
    }
    if (u.rig !== undefined && u.rig !== (this.lobby[i] as ParticipantInfo).rig) {
      this.lobby[i] = { ...(this.lobby[i] as ParticipantInfo), rig: u.rig };
      // A6.1: whoever follows the rigs of a match that is open hears it as it always did.
      if (st.phase !== 'lobby') this.noteLiveRig(id, u.rig);
      changed = true;
    }
    if (u.ballEndReady !== undefined && u.ballEndReady !== this.ballEndReady.get(id)) {
      this.ballEndReady.set(id, u.ballEndReady);
      changed = true;
    }
    if (u.midnightMode !== undefined && this.noteMidnightMode(id, u.midnightMode)) changed = true;
    // I11.4.9: counted while no match is open, as before a match's first start (a start between games is the next step's).
    if (u.stream3dWaitMs !== undefined && st.phase === 'lobby' && this.noteStream3dWait(id, u.stream3dWaitMs)) changed = true;
    if (u.stance !== undefined && u.stance !== (this.stances.get(id) ?? 'play')) {
      this.stances.set(id, u.stance);
      changed = true;
    }
    if (u.noCopy !== undefined && u.noCopy !== this.withoutCopy.has(id)) {
      if (u.noCopy) this.withoutCopy.add(id);
      else this.withoutCopy.delete(id);
      changed = true;
    }
    if (u.ownGame !== undefined && u.ownGame !== this.inOwnGame.has(id)) {
      if (u.ownGame) this.inOwnGame.add(id);
      else this.inOwnGame.delete(id);
      changed = true;
    }
    // B26: a flag about one of a player's own balls is no fact of the lobby: it is passed on as it came.
    if (msg && u.advisory !== undefined && st.phase !== 'lobby' && this.playsNow(id)) {
      this.events.emit('advisory', { playerId: id, advisory: u.advisory });
      this.mirror(msg);
    }
    if (!changed) return false;
    this.events.emit('participantUpdated', { ...(this.lobby[i] as ParticipantInfo) });
    this.resendAck();
    return true;
  }

  /** A17: a member is out of the lobby: the row and everything kept for it go; `tell`: the others hear it now. */
  private dropMember(peer: PlayerId, tell: boolean): void {
    if (!this.isMember(peer) || peer === this.localId) return;
    this.lobby = this.lobby.filter((p) => p.playerId !== peer);
    this.lobbyGames.delete(peer);
    this.ballEndReady.delete(peer);
    this.midnightModeOf.delete(peer);
    this.stances.delete(peer);
    this.withoutCopy.delete(peer);
    this.inOwnGame.delete(peer);
    if (this.stream3dWait.delete(peer)) this.armStream3dTimer();
    const held = this.grace.get(peer);
    if (held !== undefined) this.s.clock.clearTimeout(held);
    this.grace.delete(peer);
    const told = this.gone.delete(peer) && held === undefined;
    this.stopCatchUp(peer);
    this.setMismatch(peer, []);
    // A member already known to be away has had its `peerLeft`.
    if (!told) this.events.emit('peerLeft', peer);
    if (tell) this.resendAck();
  }

  /** A17: what HELLO_ACK says in a lobby beyond a match's lobby of before. */
  private lobbyFacts(): Pick<PayloadOf<'HELLO_ACK'>, 'stances' | 'away' | 'noCopy' | 'ownGame' | 'ballsPerGame' | 'match'> {
    const ids = this.lobby.map((p) => p.playerId);
    return {
      stances: ids.map((playerId) => ({ playerId, stance: this.stances.get(playerId) ?? 'play' })),
      away: ids.filter((id) => this.away(id)),
      noCopy: ids.filter((id) => this.withoutCopy.has(id)),
      ownGame: ids.filter((id) => this.inOwnGame.has(id)),
      ballsPerGame: this.ballsPerGameInit,
      match: this.openMatch(),
    };
  }

  /**
   * A17: send `member` the open match's log from entry `from` on, in pages of `logPageSize` (`restart`: the first
   * page says the receiver starts an empty log). All in this turn, or one page every `logPageGapMs`. The pages are
   * cut from the log as it is when each goes out, so what was committed meanwhile is in them, and the member is
   * current at the page that says `more: false`; the RESULTs of the match (never logged) follow it.
   */
  private sendLog(member: PlayerId, from: number, restart: boolean): void {
    this.stopCatchUp(member);
    this.catchUps.set(member, { next: from, restart, pages: 0, from: this.s.log.length, timer: null });
    this.pumpLog(member);
  }

  private pumpLog(member: PlayerId): void {
    const c = this.catchUps.get(member);
    const matchId = this.s.state.matchId;
    if (!c || this.detached || !matchId) return;
    c.timer = null;
    for (;;) {
      const all = this.s.log.entries();
      const page = all.slice(c.next, c.next + this.logPageSize);
      c.next += page.length;
      c.pages += 1;
      const more = c.next < all.length;
      const head = this.s.log.head();
      this.s.transport.send(
        member,
        this.s.build('MATCH_LOG', { match: matchId, restart: c.restart, entries: page.map((e) => ({ ...e })), logHash: head.hash, logLength: head.length, more }, this.code),
      );
      c.restart = false;
      if (!more) break;
      if (this.logPageGapMs > 0) {
        c.timer = this.s.clock.setTimeout(() => this.pumpLog(member), this.logPageGapMs);
        return;
      }
    }
    this.catchUps.delete(member);
    this.events.emit('caughtUp', { playerId: member, entries: this.s.log.length, pages: c.pages, during: this.s.log.length - c.from });
    this.sendResults(member);
  }

  private stopCatchUp(member: PlayerId): void {
    const c = this.catchUps.get(member);
    if (!c) return;
    if (c.timer !== null) this.s.clock.clearTimeout(c.timer);
    this.catchUps.delete(member);
  }

  private stopCatchUps(): void {
    for (const id of [...this.catchUps.keys()]) this.stopCatchUp(id);
  }

  /**
   * Every RESULT of the match as sent, oldest first, to one member. A fresh envelope for each: the receiver drops a
   * frame whose seq is not above the last it took from this host (A10: the payload, signatures and all, is the same).
   */
  private sendResults(to: PlayerId): void {
    const matchId = this.s.state.matchId ?? this.matchId;
    for (const r of this.resultMsgs) this.s.transport.send(to, this.s.build('RESULT', r.payload, matchId));
  }

  /**
   * A6 (2026-10-31): a lobby client's rig or table changed after its HELLO (it joined before its table loaded).
   * After MATCH_READY the roster and fingerprint in the log are final; A6.1 (2026-11-01): a new rig is still noted and
   * passed on to the other participants (`from` preserved), so their Match tab and panel know it. A refusing host keeps
   * the old fingerprint and rejects one that differs, as it would have refused that HELLO. B26 (2026-11-16): an
   * `advisory` (a flag about one of the sender's own balls) is raised here and passed on the same way. B26.4: so is
   * `midnightMode` (the Midnight Madness setting on the sender's table); in the lobby it goes into HELLO_ACK.
   */
  private onParticipantUpdate(msg: Message<'PARTICIPANT_UPDATE'>): void {
    // A17: in a lobby an update counts in every phase, and HELLO_ACK answers it.
    if (this.lobbyOn) {
      this.updateMember(msg.from, msg.payload, msg);
      return;
    }
    if (this.s.state.phase !== 'lobby') {
      const rigChanged = msg.payload.rig !== undefined && this.noteLiveRig(msg.from, msg.payload.rig);
      const advisory = msg.payload.advisory;
      if (advisory !== undefined) this.events.emit('advisory', { playerId: msg.from, advisory });
      const modeChanged = msg.payload.midnightMode !== undefined && this.isParticipant(msg.from) && this.noteMidnightMode(msg.from, msg.payload.midnightMode);
      if (rigChanged || advisory !== undefined || modeChanged) this.mirror(msg);
      return;
    }
    const i = this.lobby.findIndex((p) => p.playerId === msg.from);
    if (i <= 0) return;
    const u = msg.payload;
    let changed = false;
    if (u.game !== undefined && !sameGame(u.game, this.lobbyGames.get(msg.from))) {
      const mismatches = compareFingerprints(this.hostGame, u.game, this.localId);
      if (mismatches.length > 0 && this.fingerprintPolicy === 'refuse') {
        this.reject(msg, 'unexpected_state', `game fingerprint differs in: ${mismatches.map((m) => m.field).join(', ')}`);
        return;
      }
      this.lobbyGames.set(msg.from, { ...u.game });
      this.setMismatch(msg.from, mismatches);
      changed = true;
    }
    if (u.rig !== undefined && u.rig !== this.lobby[i]!.rig) {
      this.lobby[i] = { ...this.lobby[i]!, rig: u.rig };
      changed = true;
    }
    // A13: the table's ball ends can (or cannot) be reported now: the player opened another table, or patched this one.
    if (u.ballEndReady !== undefined && u.ballEndReady !== this.ballEndReady.get(msg.from)) {
      this.ballEndReady.set(msg.from, u.ballEndReady);
      changed = true;
    }
    // B26.4: how the Midnight Madness setting reads on that player's table.
    if (u.midnightMode !== undefined && this.noteMidnightMode(msg.from, u.midnightMode)) changed = true;
    // I11.4.9: that player's 3D connection is (or is no longer) being made.
    if (u.stream3dWaitMs !== undefined && this.noteStream3dWait(msg.from, u.stream3dWaitMs)) changed = true;
    if (!changed) return;
    this.events.emit('participantUpdated', { ...this.lobby[i]! });
    this.resendAck();
  }

  /** A6.1: a rig after MATCH_READY; false when it is the one already known (the roster's, or the last update's). */
  private noteLiveRig(id: PlayerId, rig: ParticipantInfo['rig']): boolean {
    const known = this.liveRigs.get(id) ?? this.s.state.participants.find((p) => p.playerId === id)?.rig;
    if (known === rig) return false;
    this.liveRigs.set(id, rig);
    this.events.emit('rigUpdated', { playerId: id, rig });
    return true;
  }

  /** Records what differs for a player and raises `tableMismatch` when that changed (empty: it agrees now). */
  private setMismatch(id: PlayerId, mismatches: PayloadOf<'REFUSE'>['mismatches']): void {
    const before = (this.mismatched.get(id) ?? []).map((m) => m.field).join(',');
    if (mismatches.length > 0) this.mismatched.set(id, mismatches);
    else this.mismatched.delete(id);
    if (mismatches.map((m) => m.field).join(',') !== before) this.events.emit('tableMismatch', { playerId: id, mismatches });
  }

  /**
   * The lobby's HELLO_ACK, to every accepted client (never 'all': a socket mid-HELLO would take it as its own).
   * A8 (2026-10-31): with every participant that differs, so each client can flag the others.
   */
  private resendAck(): void {
    const ack = this.s.build(
      'HELLO_ACK',
      {
        hostPlayerId: this.localId,
        hostPublicKey: this.publicKey,
        participants: this.lobby.map((x) => ({ ...x })),
        hostGame: { ...this.hostGame },
        // A17: the lobby as it is; nothing of it is sent without a lobby.
        ...(this.lobbyOn ? this.lobbyFacts() : {}),
        tableMismatches: [...this.mismatched].map(([playerId, mismatches]) => ({ playerId, mismatches: mismatches.map((x) => ({ ...x })) })),
        startsInMs: this.countdownRemaining(),
        loading: this.loading(),
        ballEndReady: [...this.ballEndReady].map(([playerId, ready]) => ({ playerId, ready })),
        midnightModes: [...this.midnightModeOf].map(([playerId, m]) => ({ playerId, enabled: m.enabled, adjustment: m.adjustment })),
        stream3dWait: this.stream3dWaiting(),
      },
      null,
    );
    if (this.lobbyOn) {
      // A17: in every phase, so to the members whose link is up; and this PC's own row is news to its own shell.
      for (const id of this.reachable()) this.s.transport.send(id, ack);
      this.events.emit('lobby', ack.payload);
      return;
    }
    for (const p of this.lobby) if (p.playerId !== this.localId) this.s.transport.send(p.playerId, ack);
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
    // A18: its link dropped a moment ago and it may be back before anyone notices: the grant waits for the grace to
    // end one way (its RECONNECT: `onReconnect` comes back here) or the other (`confirmLeave`: the pause below).
    if (this.grace.has(target.player)) return;
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
      game: Math.max(1, st.gameNumber),
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

  /** A18: a player inside the grace still signs (it is not a disconnect yet); one who is away does not. */
  private expectedSigners(): PlayerId[] {
    return this.s.state.playerOrder.filter((id) => id !== this.localId && !this.away(id) && this.s.state.players[id]?.connected);
  }

  private onLogSign(msg: Message<'LOG_SIGN'>): void {
    // A10: a LOG_SIGN over a head at or before this game's start signs an earlier game, whose RESULT already went out.
    if (msg.payload.logLength <= this.s.state.gameStartIndex) return;
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
      game: Math.max(1, st.gameNumber),
      series: seriesOf(st),
    };
    const msg = this.s.build('RESULT', payload, this.matchId);
    this.resultMsgs.push(msg);
    this.broadcast(msg);
    this.events.emit('result', { result: msg.payload, signatures: [...this.signatures.values()] });
    // A17: the lobby's open match is between games now, and the next start can be asked for.
    if (this.lobbyOn && !this.detached) this.resendAck();
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
      tableMismatches: this.tableMismatches(),
      disconnectGraceMs: this.graceMs,
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
    const matchId = this.s.state.matchId ?? this.matchId;
    if (code !== null) {
      const head = this.s.log.head();
      this.s.transport.send(linkFrom, this.s.build('RECONNECT_ACK', { accept: false, code, entries: [], logHash: head.hash, logLength: head.length }, matchId));
      this.events.emit('reconnectRejected', { playerId: msg.from, code });
      this.s.transport.closePeer?.(linkFrom);
      // A participant that cannot resume is disconnected: the usual pause rules apply (A3). A18: with no grace: it
      // will not be back on this log.
      if (this.isParticipant(linkFrom)) this.onPeerLeave(linkFrom, true);
      return;
    }
    // A18: a client that does not send a lost ball end again (up to 0.2.50: no `resends`) and holds the grant gets the
    // pause it always got, before its answer: its RESUME then has the grant issued again, which is the one way such
    // a client reports a ball that ended while its link was away. Inside the grace, and also when no drop was ever
    // noted here (a relay peer of the same player that replaced the old one with no leave in between): frames may
    // have been lost either way. Not when the match is already paused for that player (the pause is in its answer).
    const st0 = this.s.state;
    const pausedForIt = st0.paused?.reason === 'disconnect' && st0.paused.player === msg.from;
    let legacyPause = false;
    if (msg.payload.resends !== true && st0.phase === 'running' && st0.turnMode !== 'simultaneous' && !st0.pendingTransfer && !pausedForIt && st0.currentGrant?.grant.player === msg.from) {
      const held = this.grace.get(msg.from);
      if (held !== undefined) {
        this.s.clock.clearTimeout(held);
        this.grace.delete(msg.from);
      }
      this.pauseBehind(msg.from);
      legacyPause = true;
    }
    // The head is read HERE, after that pause is committed, with the entries it belongs to: the answer names the head
    // of the log it carries. (Read before the pause, `logHash` was one entry behind `entries`, and the client, which
    // compares the head it ends at with the one the answer names, raised `desync` at the very reconnect the pause is
    // for: 0.2.46 to 0.2.50 and this build alike. Found on PR 126, 2026-11-24.)
    const head = this.s.log.head();
    const entries = this.s.log.entries().slice(msg.payload.logLength);
    // A17: in a lobby an answer of more than one page says `more` and the rest follows in MATCH_LOG (a log of 600
    // entries is over the relay's 256 KB as one frame). Without a lobby the answer is one frame, as it was.
    const paged = this.lobbyOn && entries.length > this.logPageSize;
    const first = paged ? entries.slice(0, this.logPageSize) : entries;
    this.s.transport.send(
      linkFrom,
      this.s.build('RECONNECT_ACK', { accept: true, code: null, entries: first.map((e) => ({ ...e })), logHash: head.hash, logLength: head.length, ...(paged ? { more: true } : {}) }, matchId),
    );
    // Back on a link (A3). Its log still says disconnected until a RESUME clears the disconnect
    // pause; until then the rotation pauses again rather than grant to it.
    // A18: back inside the grace: nobody was told it had left, and nothing was paused for it.
    const timer = this.grace.get(msg.from);
    // (A return that had to be paused for, above, is not a quiet one: the others were told to wait.)
    const quiet = timer !== undefined && !legacyPause;
    if (timer !== undefined) {
      this.s.clock.clearTimeout(timer);
      this.grace.delete(msg.from);
    }
    this.gone.delete(msg.from);
    this.events.emit('reconnected', { playerId: msg.from, entries: entries.length, quiet });
    // A17: a member the lobby was told is away is back.
    if (this.lobbyOn && !quiet) this.resendAck();
    if (paged) {
      // The rest of the log, then the RESULTs (`pumpLog`).
      this.sendLog(msg.from, msg.payload.logLength + first.length, false);
    } else {
      // A fresh envelope for each: the receiver drops a frame whose seq is not above the last it took from this host,
      // and the RECONNECT_ACK just went out with a newer one (A10: the payload, signatures and all, is the same).
      for (const r of this.resultMsgs) this.s.transport.send(linkFrom, this.s.build('RESULT', r.payload, matchId));
    }
    // A18: a grant that waited for this player's grace goes out now, after the RECONNECT_ACK it follows in the log;
    // so does a next game that was held for it.
    if (quiet) {
      this.advance();
      this.settleNextGame();
    }
  }

  /**
   * A18: `PAUSE(disconnect, player)` committed while that player's RECONNECT is being answered. It goes to everyone
   * but that player, who finds it in the RECONNECT_ACK's entries, as it always did from a host that paused at the
   * drop. Sent live as well, it would arrive ahead of the answer on the new link, and that client's controller would
   * resume twice: once for the live pause, once at `reconnected` (the second is rejected, "not paused", and that
   * line stays on its panel).
   */
  private pauseBehind(player: PlayerId): void {
    const msg = this.s.build('PAUSE', { reason: 'disconnect', player }, this.matchId);
    this.clearBallEndTimer();
    this.s.commit({ ts: msg.ts, kind: 'msg', from: msg.from, message: msg });
    // A17: in a lobby, to the members who hold the log (the watchers too), as any logged message.
    const to = this.lobbyOn ? this.logAudience() : this.s.state.participants.map((p) => p.playerId).filter((id) => id !== this.localId);
    for (const id of to) if (id !== player) this.s.transport.send(id, msg);
    this.events.emit('pause', msg.payload);
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

function sameGame(a: GameFingerprint, b: GameFingerprint | undefined): boolean {
  return b !== undefined && compareFingerprints(a, b, 'x').length === 0;
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
