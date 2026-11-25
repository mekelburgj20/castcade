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
 * - 2026-11-25: a link belongs to a player once this engine has accepted the link's first frame (`LinkCandidate` in
 *   transport.ts; `judge`, `admit`). A HELLO or a RECONNECT that is refused changes nothing about the player it names:
 *   the answer goes to the link it came on, a link that was nobody's yet is closed, and the frame's `seq` is not
 *   recorded (a RECONNECT's signature is verified before its `seq` is looked at). An accepted RECONNECT makes the
 *   link it came on the player's, in place of the one they had. A RECONNECT never names this host, nor a head its
 *   player is past (`checkReconnect`: the log's own floor, and the head of that player's last accepted RECONNECT).
 *   One that carried the player's own signature and is refused on a new link starts that player's ordinary grace
 *   (`presumeAway`); one that did not verify starts nothing. And every answer goes to the link its frame came on,
 *   also for a frame in another participant's name (`reject`).
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
 * - A17 step 6 (2026-11-25, design 11.4, 11.5, 11.7, 11.8, 11.8a), still behind `HostOptions.lobby`:
 *   - **a start is asked for, by anyone** (`requestStart`, a member's START_REQUEST): one set of checks (`checkStart`,
 *     in the design's order), an announced start that counts down (`lobby.countdownMs`, 5 s) or waits, with who it is
 *     for and what it waits for in HELLO_ACK `start`; the checks run again when the countdown runs out; a second
 *     press (`now`) starts without what is waited for; anybody cancels (`cancelStart`, START_CANCEL). **The
 *     starter** (HELLO_ACK `starter`) is the one member whose own table may ask (`fromTable`). With a match open a
 *     start is its next game, with its own players; `newMatch` ends it and starts one with everyone set to Play.
 *     `start()`, `startMatch()` and `nextGame()` stay as the arbiter's own, unchecked, immediate starts.
 *   - **the lobby's table is a pick** (`pickTable`, TABLE_PICK): `hostGame` is the pick (its identity keys,
 *     `table-identity.ts`), `tablePickedBy` who made it; this PC's own table is kept beside it (`selfGame`) and is a
 *     row like any other: loading, differing, another game (`otherTable`). With no pick made, the first table this PC
 *     has open is the pick, as before the lobby. A pick ends the open match ("the table changed") and is refused
 *     during a game and while a start is announced. In a lobby a differing table is never a refusal.
 *   - **away, and two clocks** (`reviewClocks`): a member whose link drops (past A18's grace) is away, in every
 *     phase, and keeps their place. The place clock (`lobby.placeMs`, 3 minutes) runs for a member the game does not
 *     need and ends with their row. The turn clock (`lobby.turnMs`, 3 minutes) runs only from the pause at that
 *     player's own turn and ends with their forfeit (`playOnWithout`), except for a player who holds the grant and
 *     is still seen playing (`lobby.stillSeen`): then the owner of this PC is asked (`awayQuestion`, answered with
 *     `answerAway`). Both stand still while this PC is itself cut off (`setCutOff`), and start from zero after it;
 *     meanwhile nobody is paused for and no leave is confirmed.
 *   - **RECONNECT in every phase** (`onLobbyReconnect`): checked against the member's key as the lobby holds it, the
 *     lobby's code in the envelope and the signed body, the envelope's `seq` signed and taken only when it is above
 *     the last from that member (`stale_seq`). The same match and a known head: the entries after it, in pages;
 *     anything else: `restart`, and the open match's whole log in MATCH_LOG. A member whose place is gone is
 *     answered `unknown_player` and says HELLO again, as the first frame of a link of its own. Every answer names
 *     the head of the log it carries, a page of MATCH_LOG too. What this lobby holds about a member (the row, the
 *     place, the counter, the stance, the link) does not change for a RECONNECT it refuses.
 *   - **the lobby on the seam of 2026-11-25** (a link is a member's once its first frame is accepted): the lobby's
 *     RECONNECT and the signed HELLO of a returning member are taken in `admit` like any opening frame, after their
 *     signature, and only then is anything marked or sent (`admit(msg, { keepCount: true })` for that HELLO: its
 *     count goes on); every refusal, LOBBY_CLOSED among them, answers the link the frame came on and closes a link
 *     that was nobody's yet, whatever the code. The RECONNECT's signed body also names this PC (`host`), so a frame
 *     written for one lobby's PC is not taken by another.
 *   - **End match for everyone** (`endMatch` during a game, the lobby's PC only): no FORFEIT, no RESULT, the log
 *     stops where it is, MATCH_END says `abandoned`. A member's END_REQUEST ends a match between games.
 * - A17 step 6, after the review of 2026-11-25 (still behind the option):
 *   - **a member inside A18's grace is not away**: they are counted for a start and stay the starter (`canPlay`
 *     reads `away`); a countdown that runs out while one of its players is inside the grace, or while this PC is
 *     cut off, is held and judged when the grace has settled (`judgeStart`);
 *   - **cut off**: every grace is held with no timer running and begins from zero when this PC is back; nobody is
 *     away for it; the ball-end timeout and the wait for LOG_SIGN stand still as the clocks do (`setCutOff`);
 *   - **Leave lobby** (LEAVE_LOBBY, `memberLeaves`): the row goes at once, after a FORFEIT for a game they play;
 *   - **a member's own HELLO** while its place is kept (`HELLO.proof`, `returnsByHello`) is its return; `stale_seq`
 *     says where the counter stands (`seqAbove`), and the member comes back above it;
 *   - **the match that was closed last** is kept with its RESULTs and its MATCH_END: a member who was away gets the
 *     rest of its log and both (`RECONNECT_ACK.closed`), so every PC ends a match with the same tally;
 *   - a closed lobby answers a returning member with LOBBY_CLOSED; a player whose row is gone is not waited for
 *     to sign; `answerAway` takes the score for "End their ball" and `awayQuestionOff` withdraws a question;
 *   - a sentence that goes into a bounded key is cut where it is built, and in a lobby nothing thrown inside this
 *     engine leaves a transport's handler or a timer (`guard`, `engineError`).
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
import { helloProofBody, lobbyReconnectSignBody, logSignBody, pickWinner, rankEntries, reconnectSignBody, seriesOf } from './result.js';
import { compareWithPick, pickName, pickOf, samePick, tableRelation } from './table-identity.js';
import { Session } from './session.js';
import {
  cloneState,
  isStrictMajority,
  nextGrantTarget,
  remainingParticipants,
  type GrantTarget,
  type MatchState,
} from './state.js';
import type { LinkCandidate, Transport } from './transport.js';

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
  /**
   * Step 6: the table picked when the lobby was opened (its opener's pick; `HostOptions.hostGame` is then this PC's
   * own table, open or not). Omitted: no pick is made yet, and the first table this PC has open is taken for it.
   */
  table?: GameFingerprint;
  /** Step 10: the Castcade VPX build's identity of that table (`pickTable`'s `objects`), when its picker's PC knew it. */
  tableObjects?: { editables: number; hash: string } | null;
  /** Step 10: that table is this PC's own, taken by default, and not one a person picked (a restored lobby says so). Default: a person's. */
  tableByDefault?: boolean;
  /**
   * Step 10: how often the lobby's table can change: the least time between two picks by anyone, and between two
   * picks by one member. Defaults `PICK_GAP_MS` and `PICK_MEMBER_GAP_MS`; 0: no limit (tests of other things).
   */
  pickGapMs?: number;
  pickMemberGapMs?: number;
  /** Step 6: every start counts down this long before MATCH_READY or NEXT_GAME. Default 5 s; at most 60 s. */
  countdownMs?: number;
  /** Step 6: how long the place of a member the game does not need is kept while they are away. Default 3 minutes. */
  placeMs?: number;
  /** Step 6: how long a player is waited for, from the pause at their own turn. Default 3 minutes. */
  turnMs?: number;
  /**
   * Step 7 (2026-11-25, the review of PR 136): after this PC itself was cut off and is back (`setCutOff(false)`), how
   * long a member whose link was down at that moment has to find the lobby again before either clock counts against
   * them. The shell knows how its members ask for the room (the relay's `LOBBY_REJOIN`: the next ask can be two and
   * a half minutes after this PC's return) and names the longest that can take. Such a member is away, and the game
   * is paused for them, as soon as the grace is over, so every panel says so; but their place clock and their turn
   * clock run for this long in addition, counted from the return. So a member who comes back at the latest moment
   * its own schedule allows has lost nothing of the three minutes, and neither has one whose ask failed once.
   * Default 0: the clocks run from the end of the grace, as in step 6.
   */
  returnAllowMs?: number;
  /** Step 6: the longest a start waits for its players' 3D connections, from the first time it was held for them. Default 45 s. */
  start3dMaxMs?: number;
  /**
   * Step 6: whether the picture or the state stream of a player who is away still reaches this PC (the shell knows;
   * the engine asks once, when that player's turn clock runs out while they hold the grant). Default: it does not.
   */
  stillSeen?: (player: PlayerId) => boolean;
}

/**
 * A17 step 8 (2026-11-26, alpha-match.md section 11.8: "the lobby's PC also saves what only it knows"): what a
 * lobby's PC keeps beside the open match's log so that, after its Castcade started again, it is the same lobby and
 * not a new one (`HostMatch.savedLobby`, `HostMatch.restoreLobby`). Plain data. No private key: the keys are the
 * members' public ones, as every member's HELLO_ACK has them.
 */
export interface SavedLobby {
  code: string;
  /** Everyone but this PC, in the order they joined, as their row stands, with their choice. */
  members: Array<{ participant: ParticipantInfo; stance: Stance }>;
  /**
   * The table that is picked (`HELLO_ACK.hostGame`), whether a pick was made, and who made it. Step 10: `byDefault`
   * (the pick is the lobby PC's own table, not one a person made) and `objects` (the Castcade VPX build's identity
   * of the picked table); a record from before step 10 has neither, and reads as a pick with nothing known of it.
   */
  table: { game: GameFingerprint; fixed: boolean; pickedBy: PlayerId | null; byDefault?: boolean; objects?: { editables: number; hash: string } | null };
  /** The number the next match gets (`<code>-<n>`): a lobby never uses a match id twice. */
  nextMatch: number;
  /** The balls per game the lobby was opened with. */
  ballsPerGame: number;
  /** I11.4.15: what this PC said its table's objects are (`HELLO_ACK.hostTableObjects`); it cannot be said again while a match is open. */
  tableObjects?: { editables: number; hash: string } | null;
  /**
   * The match that is open: its id, and the RESULT of every game of it that has one (a RESULT is not in the log).
   * The log itself is the session's, and is saved beside this. Null: no match is open.
   */
  match: { matchId: string; results: PayloadOf<'RESULT'>[] } | null;
}

/** A17 step 6: what a start can be asked with (START_REQUEST's payload; every key defaults to false). */
export interface StartAsk {
  fromTable?: boolean;
  newMatch?: boolean;
  anyway?: boolean;
  now?: boolean;
}

type StartWait = 'result' | 'tables' | 'other_tables' | 'own_games' | '3d';

/** A17 step 6: the start that is announced: counting down (`endsAt`) or waiting (`waitsFor`). */
interface PendingStart {
  /** Who asked; a start belongs to that person. */
  by: PlayerId;
  byName: string;
  /** Who plays it, the first to go first. Fixed at the request; people only ever go out of it. */
  players: PlayerId[];
  newMatch: boolean;
  /** The member whose own game on their table is this start's first (a start from the table); null: asked from a button. */
  tableOf: PlayerId | null;
  anyway: boolean;
  /** A second press took the wait away, or its limit ran out: the 3D connections are not waited for. */
  no3d: boolean;
  waitsFor: StartWait | null;
  waitsOn: PlayerId[];
  endsAt: number | null;
  timer: TimerHandle | null;
  /** The countdown has just run out: if the checks pass now, it starts. */
  due: boolean;
  capTimer: TimerHandle | null;
  capAt: number | null;
  /** A HELLO_ACK has said it. */
  announced: boolean;
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
  /**
   * A17 step 8 (the review of PR 138): a member came back holding a log of the OPEN match that this PC's log does
   * not contain (this PC was restored from a record that was behind). The member is sent this PC's log in its place
   * (`restart`); the shell says on this PC that the match went back.
   */
  memberAhead: { playerId: PlayerId; entries: number };
  /** A17: LOBBY_CLOSED went out (`closeLobby`). */
  lobbyClosed: PayloadOf<'LOBBY_CLOSED'>;
  /** A17 step 6: an announced start was taken away without anything starting; `reason` is the sentence every panel shows. */
  startOff: { reason: string };
  /** A17 step 6: the lobby's table was picked (`pickTable`, a member's TABLE_PICK). */
  tablePicked: { by: PlayerId; game: GameFingerprint };
  /** A17 step 6: the place of a member who was away ran out (`lobby.placeMs`): their row is gone. */
  memberRemoved: PlayerId;
  /**
   * A17 step 6: `player` holds the grant, has been out of this PC's reach for the turn clock's time, and is still
   * seen playing (`lobby.stillSeen`). Nothing is done by itself: the owner of this PC decides, with `answerAway`
   * (keep waiting, end their ball, play on without them). Asked again after every "keep waiting".
   */
  awayQuestion: { player: PlayerId; waitedMs: number };
  /**
   * A17 step 6 (review): the question about `player` is no longer open and was not answered: they came back, the game
   * went on some other way, or this PC was cut off (the clock starts from zero after it). `answerAway` is false now.
   */
  awayQuestionOff: { player: PlayerId };
  /** A17 step 6 (review): a member left on purpose (LEAVE_LOBBY): their row is gone and their place is free. */
  memberLeft: PlayerId;
  /**
   * A17 step 6 (review): in a lobby, something threw inside this engine while it handled a frame, a dropped link or
   * one of its own timers (`where`). It is reported here and nowhere else: nothing is thrown out of a transport's
   * handler or a timer, and the engine goes on. Without a lobby an error is thrown as it always was.
   */
  engineError: { where: string; error: Error };
}

/**
 * What the media layer hands over to send; the engine adds `to` and the envelope (D2). The schema's input shape
 * (D10.3): `channel` is optional here, and the build defaults it to `rtc`.
 */
export type OutgoingMediaSignal = Omit<PayloadInput<'MEDIA_SIGNAL'>, 'to'>;

const DEFAULT_BALL_END_TIMEOUT_MS = 20 * 60 * 1000;
/** A17 step 6: every start of a lobby counts down this long (design 11.4). */
export const DEFAULT_START_COUNTDOWN_MS = 5_000;
/** A17 step 6: the place clock and the turn clock (design 11.8): three minutes each. */
export const DEFAULT_AWAY_MS = 3 * 60 * 1000;
/** A17 step 6: a start waits for its players' 3D connections this long at most, from the first time it was held (I11.4.9). */
export const DEFAULT_START_3D_MAX_MS = 45_000;
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
/**
 * A17 step 10: how often the lobby's table can change. A change makes every PC close a table and open another, which
 * takes each of them the better part of a minute: 10 s between two picks by anyone, 30 s between two picks by one
 * member. Inside either, a pick is refused with a sentence.
 */
export const PICK_GAP_MS = 10_000;
export const PICK_MEMBER_GAP_MS = 30_000;
const UNHASHED = /^0{64}$/;

const LOBBY_TYPES: ReadonlySet<MessageType> = new Set(['PARTICIPANT_UPDATE', 'MEDIA_SIGNAL', 'START_REQUEST', 'START_CANCEL', 'END_REQUEST', 'TABLE_PICK', 'LEAVE_LOBBY']);
/** The longest sentence REJECT, REFUSE and HELLO_ACK `startOff` take (the schemas' limit); a sentence with names in it is cut to this where it is built. */
const SENTENCE_MAX = 500;
/** The longest reason FORFEIT, MATCH_END and LOBBY_CLOSED take. */
const REASON_MAX = 200;
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
  /** I11.4.15: the table objects of this host's table as the shell last said them (HELLO_ACK `hostTableObjects`); null: not known. */
  private hostTableObjects: { editables: number; hash: string } | null = null;
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
  /**
   * A17: the match that was closed last, with its log as it stood; and (step 6, review) what went out about it that
   * is in no log: its RESULTs and its MATCH_END, for a member who was away when they did.
   */
  private lastMatch: { matchId: string; log: MatchLog; results: PayloadOf<'RESULT'>[]; end: PayloadOf<'MATCH_END'> } | null = null;
  /** A17: what LOBBY_CLOSED said, for a member who comes back after it. */
  private closedReason = '';
  /** A17: the order a held next game was asked with (`nextGame(order)`), if any. */
  private heldOrder: PlayerId[] | undefined;
  /** A17 step 6: this PC's own table in a lobby, where `hostGame` is the lobby's pick. Without a lobby it is not read. */
  private selfGame: GameFingerprint;
  /** A17 step 6: a pick has been made (at the opening, by a member, or by this PC's first open table). */
  private pickFixed = false;
  private pickedBy: PlayerId | null = null;
  /** A17 step 10: the pick is this PC's own table, taken by default (true), or one a person made (false). */
  private pickDefault = true;
  /** A17 step 10: the Castcade VPX build's identity of the picked table, as its picker's PC said it; null: not said. */
  private pickObjects: { editables: number; hash: string } | null = null;
  /** A17 step 10: when a person last picked, and when each member last did (`PICK_GAP_MS`, `PICK_MEMBER_GAP_MS`). */
  private lastPickAt: number | null = null;
  private readonly lastPickBy = new Map<PlayerId, number>();
  private readonly pickGapMs: number;
  private readonly pickMemberGapMs: number;
  /** A17 step 10: where each member's PC stands on its way to the lobby's table (`PARTICIPANT_UPDATE.tableChange`). */
  private readonly changing = new Map<PlayerId, NonNullable<PayloadOf<'PARTICIPANT_UPDATE'>['tableChange']>>();
  private pending: PendingStart | null = null;
  /** A17 step 6: why the announced start went away, for the next HELLO_ACK (`startOff`), once. */
  private startOffNote: string | null = null;
  private readonly countdownMs: number;
  private readonly placeMs: number;
  private readonly turnMs: number;
  /** Step 7: `LobbyOptions.returnAllowMs`; when this PC was last back from being cut off; the members who were gone then and have not been back since. */
  private readonly returnAllowMs: number;
  private returnedAt: number | null = null;
  private readonly returning = new Set<PlayerId>();
  /** The review of PR 138: who was away by themselves already when this PC was cut off: the time to return is not theirs. */
  private readonly awayBefore = new Set<PlayerId>();
  /** A17 step 8: this PC's Castcade is being closed and the lobby kept (`sayKept`): for how long, said in the next HELLO_ACK. */
  private keptMs: number | null = null;
  private readonly start3dMaxMs: number;
  private readonly stillSeen: (player: PlayerId) => boolean;
  /** A17 step 6: this PC is itself cut off from the relay (`setCutOff`): the drops it sees are its own, not the members'. */
  private cutOff = false;
  private readonly placeTimers = new Map<PlayerId, TimerHandle>();
  private turnClock: { player: PlayerId; timer: TimerHandle | null; since: number; asked: boolean } | null = null;

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
    this.selfGame = { ...opts.hostGame };
    this.countdownMs = Math.max(0, Math.min(60_000, Math.round(lobby?.countdownMs ?? DEFAULT_START_COUNTDOWN_MS)));
    this.placeMs = Math.max(0, lobby?.placeMs ?? DEFAULT_AWAY_MS);
    this.pickGapMs = Math.max(0, lobby?.pickGapMs ?? PICK_GAP_MS);
    this.pickMemberGapMs = Math.max(0, lobby?.pickMemberGapMs ?? PICK_MEMBER_GAP_MS);
    this.turnMs = Math.max(0, lobby?.turnMs ?? DEFAULT_AWAY_MS);
    this.returnAllowMs = Math.max(0, lobby?.returnAllowMs ?? 0);
    this.start3dMaxMs = Math.max(0, lobby?.start3dMaxMs ?? DEFAULT_START_3D_MAX_MS);
    this.stillSeen = lobby?.stillSeen ?? (() => false);
    this.fingerprintPolicy = opts.fingerprintPolicy ?? 'refuse';
    this.turnMode = opts.turnMode ?? 'alternating';
    this.tableOpen = opts.tableOpen ?? defaultTableOpen;
    if (opts.hostParticipant.playerId !== opts.transport.localId) {
      throw new Error('hostParticipant.playerId must equal transport.localId');
    }
    this.lobby = [{ ...opts.hostParticipant, publicKey: opts.keys.publicKeyB64 }];
    if (opts.ballEndReady !== undefined) this.ballEndReady.set(this.localId, opts.ballEndReady);
    if (lobby !== null) {
      this.stances.set(this.localId, lobby.stance ?? 'play');
      // Step 6: the lobby's table is a pick. Given at the opening, or this PC's own table when it has one open
      // already; else there is none yet, and the first table this PC opens is taken for it (`updateMember`).
      this.hostGame = pickOf(lobby.table ?? opts.hostGame);
      this.pickFixed = lobby.table !== undefined || this.tableOpen(opts.hostGame);
      this.pickedBy = this.pickFixed ? this.localId : null;
      // Step 10: a table given at the opening is its opener's pick, with what their PC knew of it.
      this.pickDefault = lobby.table === undefined || lobby.tableByDefault === true;
      this.pickObjects = lobby.table !== undefined && lobby.tableObjects ? { editables: lobby.tableObjects.editables, hash: lobby.tableObjects.hash } : null;
      const mine = compareWithPick(this.hostGame, this.selfGame, this.localId);
      if (mine.length > 0) this.mismatched.set(this.localId, mine);
    }
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

  /**
   * A17 step 8 (2026-11-26): the lobby as it has to be saved for a restart of this PC's Castcade (`SavedLobby`);
   * the open match's log is `log`, and the counters are the session's (`Session.seqCeilings`). What is NOT in it,
   * and is said again by each member when it is back (the engine's own rule for every return): the table each has
   * open, whether it can report ball ends, no copy, a game of one's own. Nor a start that was counting down (it is
   * off), nor the match before the open one.
   */
  savedLobby(): SavedLobby {
    if (!this.lobbyOn) throw new Error('savedLobby: this match has no lobby');
    const st = this.s.state;
    const open = st.phase !== 'lobby' && st.matchId !== null;
    return {
      code: this.code,
      members: this.lobby.filter((p) => p.playerId !== this.localId).map((p) => ({ participant: { ...p }, stance: this.stances.get(p.playerId) ?? 'play' })),
      table: { game: { ...this.hostGame }, fixed: this.pickFixed, pickedBy: this.pickedBy, byDefault: this.pickDefault, objects: this.pickObjects ? { ...this.pickObjects } : null },
      nextMatch: this.matchNumber,
      ballsPerGame: this.ballsPerGameInit,
      tableObjects: this.hostTableObjects ? { ...this.hostTableObjects } : null,
      match: open ? { matchId: st.matchId as string, results: this.resultMsgs.map((r) => ({ ...r.payload })) } : null,
    };
  }

  /**
   * A17 step 8 (2026-11-26, design 11.8: "the lobby's PC opens the same code again, with every member away until
   * they return; an open match is taken up from its log"). The lobby of a PC whose Castcade started again, from
   * what it saved: the members with their keys and choices and their places kept, the picked table, the number of
   * the next match, and the open match from its log (`session.log`, replayed) with the RESULTs it had sent.
   *
   * `opts` is what a new lobby is opened with (this PC's own row, its table as it is now, the lobby's options);
   * `session` holds the open match's log, or an empty one, and the counters this PC must not fall behind
   * (`SeqGuard`). Throws when the saved lobby and the log do not belong together: the caller then has no lobby to
   * restore, and says so.
   *
   * The lobby comes back as one whose PC was away (`setCutOff`): every member's link is down and none of them is at
   * fault, so nobody is paused for, no place runs out and no clock runs. `runAfterRestore()` ends that, once this
   * PC can be reached again.
   */
  static restoreLobby(saved: SavedLobby, opts: HostOptions, session: Session): HostMatch {
    const lobby: LobbyOptions = opts.lobby === true || !opts.lobby ? {} : opts.lobby;
    if (!opts.lobby) throw new Error('restoreLobby: the lobby option is off');
    if (saved.code !== opts.matchId) throw new Error(`restoreLobby: the saved lobby is ${saved.code}, not ${opts.matchId}`);
    const me = opts.transport.localId;
    const st = session.state;
    const open = st.phase !== 'lobby' && st.matchId !== null;
    if (saved.match === null && open) throw new Error('restoreLobby: a log was saved, and no match is said to be open');
    if (saved.match !== null && !open) throw new Error(`restoreLobby: ${saved.match.matchId} is said to be open, and its log was not saved`);
    if (saved.match !== null && st.matchId !== saved.match.matchId) throw new Error(`restoreLobby: the saved log is of ${st.matchId}, not of ${saved.match.matchId}`);
    if (open && st.hostId !== me) throw new Error(`restoreLobby: the saved log names ${st.hostId} as the lobby's PC, not ${me}`);
    if (open && !st.matchId?.startsWith(`${saved.code}-`)) throw new Error(`restoreLobby: ${st.matchId} is not a match of the lobby ${saved.code}`);
    const ids = new Set<PlayerId>([me]);
    for (const m of saved.members) {
      const id = m.participant.playerId;
      if (ids.has(id)) throw new Error(`restoreLobby: ${id} is in the saved lobby twice`);
      ids.add(id);
    }
    // A player of the open match may have left the lobby since its MATCH_READY; nobody else is in a roster.
    const host = new HostMatch(
      {
        ...opts,
        ballsPerGame: Number.isSafeInteger(saved.ballsPerGame) && saved.ballsPerGame > 0 ? saved.ballsPerGame : opts.ballsPerGame,
        turnMode: open ? st.turnMode : opts.turnMode,
        lobby: {
          ...lobby,
          firstMatch: Math.max(1, Math.floor(saved.nextMatch)),
          // Step 10: with what was known of the pick, and whether a person made it.
          ...(saved.table.fixed ? { table: saved.table.game, tableObjects: saved.table.objects ?? null, tableByDefault: saved.table.byDefault === true } : {}),
        },
      },
      session,
    );
    host.pickedBy = saved.table.fixed && saved.table.pickedBy !== null && ids.has(saved.table.pickedBy) ? saved.table.pickedBy : host.pickedBy;
    for (const m of saved.members.slice(0, host.lobbySize - 1)) {
      const id = m.participant.playerId;
      host.lobby.push({ ...m.participant });
      host.stances.set(id, m.stance === 'watch' ? 'watch' : 'play');
      // Nobody is on a link yet, and nobody was told that anybody left: each is inside a grace that is held.
      host.gone.add(id);
      host.grace.set(id, null as unknown as TimerHandle);
    }
    host.cutOff = true;
    if (saved.tableObjects && Number.isSafeInteger(saved.tableObjects.editables) && typeof saved.tableObjects.hash === 'string') {
      host.hostTableObjects = { editables: saved.tableObjects.editables, hash: saved.tableObjects.hash };
    }
    if (open && saved.match) {
      host.matchId = saved.match.matchId;
      for (const r of saved.match.results) {
        if (r.matchId === saved.match.matchId) host.resultMsgs.push(session.build('RESULT', r, saved.match.matchId));
      }
      // Between games: the RESULT of the game that is over went out before the restart (it is sent again to each
      // member at its return); when it had not gone out yet, `runAfterRestore` ends the game as it would have ended.
      const last = st.phase === 'ended' ? host.resultMsgs.find((r) => r.payload.game === Math.max(1, st.gameNumber)) : undefined;
      if (last) {
        host.finalHead = { hash: last.payload.logHash, length: last.payload.logLength };
        host.resultSent = true;
      }
    }
    return host;
  }

  /**
   * A17 step 8: after `restoreLobby`, once this PC can be reached again (its listener is up, its room registered).
   * This PC's own outstanding grant is issued again under a new number, as after a RESUME (A15: its table may have
   * ended that ball while Castcade was closed, and the shell reports it for a grant that is live). A member's
   * outstanding grant stands as it is: the member holds it, plays on, and reports for it when it is back. Then the
   * absence ends as any absence of this PC does: every member has the grace from zero and the time to return
   * (`returnAllowMs`) before a clock counts.
   */
  runAfterRestore(o: { reachable?: boolean } = {}): void {
    this.assertActive();
    if (!this.lobbyOn) throw new Error('runAfterRestore: this match has no lobby');
    const st = this.s.state;
    const g = st.currentGrant?.grant;
    if (st.phase === 'running' && g && g.player === this.localId && !st.paused && !st.pendingTransfer) {
      st.pendingReissue = { player: g.player, ballNumber: g.ballNumber };
      st.currentGrant = null;
    }
    // Between games: the RESULT that went out before the restart is this PC's own shell's to show again (a member
    // gets it at its return).
    const last = st.phase === 'ended' && this.resultSent ? this.resultMsgs[this.resultMsgs.length - 1] : undefined;
    if (last) this.events.emit('result', { result: last.payload, signatures: [] });
    // The review of PR 138: `reachable: false`: this PC's room at ArcAid is not held yet. It stays a PC that is
    // away (nobody's grace or time to return runs from a moment at which they could not have come back); the caller
    // ends that with `setCutOff(false)` when the room is held. This PC's own grant is issued all the same.
    if (o.reachable === false) {
      this.advance();
      return;
    }
    if (this.cutOff) this.setCutOff(false);
    else this.advance();
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
    return this.lobby.map((p) => p.playerId).filter((id) => this.canPlay(id));
  }

  /**
   * A17: in the lobby, set to Play, not away, and with a copy of the lobby's table: who a start counts. A member
   * inside A18's grace IS counted (review, 2026-11-25): a link that blinks for two seconds takes nobody out of a
   * match and changes nobody's turn to start; the start itself waits for the grace to settle (`judgeStart`).
   */
  private canPlay(id: PlayerId): boolean {
    return this.isMember(id) && this.stances.get(id) !== 'watch' && !this.away(id) && !this.withoutCopy.has(id);
  }

  /**
   * A17 step 6 (design 11.4): the one member whose Start on their own table asks for a game. With no match open:
   * the first in the lobby's order who is set to Play, here and has the table. With one open: the player who went
   * first in the game being played or just played, while they are here and set to Play, else the next in that
   * game's order. (Whoever asks from a button goes first in the game that follows, and so is the starter after it.)
   */
  starter(): PlayerId | null {
    if (!this.lobbyOn || this.ended) return null;
    const st = this.s.state;
    const order = st.phase === 'lobby' ? this.lobby.map((p) => p.playerId) : st.playerOrder;
    return order.find((id) => this.canPlay(id)) ?? null;
  }

  /** A17 step 6: the start that is announced, as HELLO_ACK says it (`start`); null when none is. */
  announcedStart(): NonNullable<PayloadOf<'HELLO_ACK'>['start']> | null {
    const p = this.pending;
    if (!p) return null;
    const now = this.s.clock.now();
    const leftMs = p.endsAt !== null ? p.endsAt - now : p.waitsFor === '3d' && p.capAt !== null ? p.capAt - now : null;
    return { by: p.by, players: [...p.players], newMatch: p.newMatch, waitsFor: p.waitsFor, waitsOn: [...p.waitsOn], leftMs: leftMs === null ? null : Math.max(0, Math.min(120_000, Math.round(leftMs))) };
  }

  /** A17 step 6: the lobby's table as picked, and who picked it (null: nobody yet, it follows this PC's own table). */
  table(): { game: GameFingerprint; pickedBy: PlayerId | null } {
    return { game: { ...this.hostGame }, pickedBy: this.pickedBy };
  }

  /**
   * A17 step 10: the Castcade VPX build's identity of the lobby's table (HELLO_ACK `hostTableObjects` in a lobby):
   * what its picker said with the pick; else this PC's own table's (`setHostTableObjects`) while this PC's table is
   * the picked file, or the pick is this PC's own table by default. Null: not known. It follows the pick, never a
   * table this PC opened beside it.
   */
  tableObjects(): { editables: number; hash: string } | null {
    if (!this.lobbyOn) return this.hostTableObjects ? { ...this.hostTableObjects } : null;
    if (this.pickObjects) return { ...this.pickObjects };
    if (!this.hostTableObjects || !this.pickFixed) return null;
    const mine = this.selfGame;
    const sameFile = !UNHASHED.test(this.hostGame.tableHash) && this.hostGame.tableHash.toLowerCase() === mine.tableHash.toLowerCase();
    const ownByName = this.pickDefault && UNHASHED.test(this.hostGame.tableHash) && this.hostGame.tableName === pickName(mine.tableName);
    return sameFile || ownByName ? { ...this.hostTableObjects } : null;
  }

  /** A17 step 10: where each member's PC stands on its way to the lobby's table; a member not listed has nothing to say. */
  tableChanges(): Array<{ playerId: PlayerId; state: NonNullable<PayloadOf<'PARTICIPANT_UPDATE'>['tableChange']> }> {
    return this.lobby.map((p) => p.playerId).flatMap((playerId) => (this.changing.has(playerId) ? [{ playerId, state: this.changing.get(playerId)! }] : []));
  }

  /** A17: the match that is open in the lobby, as HELLO_ACK says it (`match`); null when none is, and without a lobby. */
  openMatch(): NonNullable<PayloadOf<'HELLO_ACK'>['match']> | null {
    const st = this.s.state;
    if (!this.lobbyOn || st.phase === 'lobby' || !st.matchId) return null;
    return { matchId: st.matchId, players: st.participants.map((p) => p.playerId), game: Math.max(1, st.gameNumber), state: st.phase === 'running' ? 'game' : 'between' };
  }

  /** A17: the match that was closed last in this lobby, with its log as it stood at MATCH_END, its RESULTs and its MATCH_END; null before any. */
  previousMatch(): { matchId: string; log: MatchLog; results: PayloadOf<'RESULT'>[]; end: PayloadOf<'MATCH_END'> } | null {
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
   * I11.4.15 (2026-11-24): the table objects of this host's own table (what the Castcade VPX build names in its
   * `hello`, or what the companion computed from the file before that), for every client in a re-sent HELLO_ACK
   * (`hostTableObjects`): a joining PC picks its copy of the table by it. Lobby only, never logged. False (nothing
   * sent) when it is what was said last, or after MATCH_READY.
   */
  setHostTableObjects(objects: { editables: number; hash: string } | null): boolean {
    this.assertActive();
    if (this.s.state.phase !== 'lobby') return false;
    const said = JSON.stringify(this.tableObjects());
    const was = this.hostTableObjects;
    if (objects === null ? was === null : was !== null && was.editables === objects.editables && was.hash === objects.hash) return false;
    this.hostTableObjects = objects ? { editables: objects.editables, hash: objects.hash } : null;
    // A17 step 10: in a lobby what is said is the picked table's; this PC's own only counts while it is that table.
    if (this.lobbyOn && JSON.stringify(this.tableObjects()) === said) return false;
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
    return this.lobby.map((p) => p.playerId).filter((id) => !this.tableIsOpen(id));
  }

  /** A member's table as their PC last said it; this PC's own is `hostGame`, and in a lobby (where that is the pick) `selfGame`. */
  private tableOf(id: PlayerId): GameFingerprint | undefined {
    if (id === this.localId) return this.lobbyOn ? this.selfGame : this.hostGame;
    return this.lobbyGames.get(id);
  }

  private tableIsOpen(id: PlayerId): boolean {
    const g = this.tableOf(id);
    return g !== undefined && this.tableOpen(g);
  }

  /** A17 step 6: the members whose open table is another game than the lobby's table (nobody while no table is picked). */
  private otherTableIds(): PlayerId[] {
    if (!this.lobbyOn || !this.tableOpen(this.hostGame)) return [];
    return this.lobby
      .map((p) => p.playerId)
      .filter((id) => {
        const g = this.tableOf(id);
        return g !== undefined && this.tableOpen(g) && tableRelation(this.hostGame, g) === 'other';
      });
  }

  /** A17 step 6: every member's table against the pick again (the pick changed, or this PC's own table did). */
  private recompareAll(): void {
    for (const p of this.lobby) {
      const g = this.tableOf(p.playerId);
      this.setMismatch(p.playerId, g ? compareWithPick(this.hostGame, g, this.localId) : []);
    }
  }

  /** I11.4.9: whether a 3D connection that is still being made counts now: before the start; in a lobby (A17), whenever no game is played. */
  private waits3dNow(): boolean {
    return this.lobbyOn ? this.s.state.phase !== 'running' : this.s.state.phase === 'lobby';
  }

  /**
   * I11.4.9 (2026-11-20): the lobby participants (this host included) whose 3D connection is still being made, and the
   * ms after which each stops being waited for (`PARTICIPANT_UPDATE.stream3dWaitMs`, this host's own through
   * `updateLocal`). A PC that said nothing more is let go `STREAM3D_WAIT_GRACE_MS` after its own time ran out. Empty
   * after the start: only the match's first start waits.
   */
  stream3dWaiting(): Array<{ playerId: PlayerId; leftMs: number }> {
    if (!this.waits3dNow()) return [];
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
    if (this.detached || !this.waits3dNow() || this.stream3dWait.size === 0) return;
    const now = this.s.clock.now();
    const next = Math.min(...this.stream3dWait.values()) + STREAM3D_WAIT_GRACE_MS;
    this.stream3dTimer = this.s.clock.setTimeout(this.guarded('the 3D wait', () => {
      this.stream3dTimer = null;
      if (this.detached || !this.waits3dNow()) return;
      const t = this.s.clock.now();
      for (const [id, until] of [...this.stream3dWait]) if (t >= until + STREAM3D_WAIT_GRACE_MS) this.stream3dWait.delete(id);
      this.armStream3dTimer();
      this.events.emit('participantUpdated', { ...this.lobby[0]! });
      this.resendAck();
    }), Math.max(0, next - now));
  }

  private clearStream3dWait(): void {
    if (this.stream3dTimer !== null) this.s.clock.clearTimeout(this.stream3dTimer);
    this.stream3dTimer = null;
    this.stream3dWait.clear();
  }

  /** A11: ms left of the start countdown, or null when none runs. */
  countdownRemaining(): number | null {
    // A17 step 6: in a lobby the countdown is the announced start's.
    if (this.lobbyOn) return this.pending?.endsAt == null ? null : Math.max(0, Math.min(60_000, this.pending.endsAt - this.s.clock.now()));
    return this.startAt === null ? null : Math.max(0, this.startAt - this.s.clock.now());
  }

  /**
   * A11 (2026-11-02): start the match in `ms` (the host's first game on its table): every client sees the countdown in
   * a HELLO_ACK. False (nothing done) when one already runs (a second plunge does not restart or cancel it), the match
   * has started, or fewer than two are in. When it runs out with fewer than two, nothing starts (`countdownCancelled`).
   */
  startIn(ms: number): boolean {
    this.assertActive();
    // A17 step 6: a lobby's start is asked for (`requestStart`), with its checks and its own countdown.
    if (this.lobbyOn) return false;
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
      if (this.away(id)) return `${id} is away`;
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
    this.clearPending();
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
      game: { ...(this.tableOf(first) ?? this.hostGame) },
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
   * connection closes; a member who is away stays away, and their place clock runs from here (`reviewClocks`).
   * `abandoned` (step 6): the game that was being played and is ended for everyone: no FORFEIT is logged and no
   * RESULT is sent for it, the log stops where it stands, and `games` counts the ones before it.
   */
  private closeMatch(reason: string, abandoned: number | null = null): void {
    const closed = this.matchId;
    const msg = this.s.build('MATCH_END', { games: this.resultMsgs.length, reason: reason.slice(0, REASON_MAX), ...(abandoned !== null ? { abandoned } : {}) }, closed);
    this.stopCatchUps();
    for (const id of this.reachable()) this.s.transport.send(id, msg);
    const results = this.resultMsgs.map((r) => r.payload);
    this.resetMatch();
    this.lastMatch = { matchId: closed, log: this.s.newMatch(), results, end: msg.payload };
    this.matchId = this.code;
    this.events.emit('matchEnded', msg.payload);
    this.resendAck();
  }

  /**
   * A17 (2026-11-25): close the lobby for everyone: an open match is ended first (MATCH_END; a game that is being
   * played is ended for everyone, with no result, as by `endMatch`), then every member is told LOBBY_CLOSED and
   * nothing more can happen here; the caller closes the engine. False without a lobby, or when it is closed already.
   */
  closeLobby(reason = 'the lobby was closed'): boolean {
    this.assertActive();
    if (!this.lobbyOn || this.ended) return false;
    this.clearPending();
    if (this.s.state.phase !== 'lobby') this.endOpenMatch('the lobby was closed');
    this.ended = true;
    this.closedReason = reason.slice(0, REASON_MAX);
    // Nothing of a game that was being played acts after this: no ball-end timeout, no grace or clock running out.
    this.clearClocks();
    this.clearStartTimer();
    this.clearStream3dWait();
    this.stopCatchUps();
    this.resetMatch();
    for (const t of this.grace.values()) this.s.clock.clearTimeout(t);
    this.grace.clear();
    const msg = this.s.build('LOBBY_CLOSED', { reason: this.closedReason }, this.code);
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
    this.clearPending();
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
    // A17: in a lobby the end of a match is not the end of anything else: back to the lobby, and another can start.
    // Step 6: and the lobby's PC may end it in the middle of a game, for everyone: that game has no result.
    if (this.lobbyOn) {
      if (this.ended || st.phase === 'lobby') return false;
      this.endOpenMatch(reason);
      return true;
    }
    if (this.ended || st.phase !== 'ended' || !this.resultSent) return false;
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
    this.onForfeit(this.s.build('FORFEIT', { player, reason: reason.slice(0, REASON_MAX) }, this.matchId));
  }

  pause(reason: PayloadOf<'PAUSE'>['reason'], player: PlayerId | null): void {
    this.assertActive();
    // A17 step 8 (the review of PR 138): the game is paused already for this player's disconnect (the PAUSE is in
    // the log, also after a restore): it is not logged a second time.
    const paused = this.s.state.paused;
    if (this.lobbyOn && reason === 'disconnect' && player !== null && paused?.reason === 'disconnect' && paused.player === player) return;
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
    // 2026-11-25: a candidate is nobody's link, so its first frame is read under the name the frame itself gives.
    // (A throw while it is read still leaves the candidate with a verdict: `judge` refuses it before `guard` sees it.)
    this.unsubscribe.push(
      t.onMessage((from, msg, candidate) => this.guard(`a ${msg.type}`, () => (candidate ? this.handle(msg.from, msg, { candidate }) : this.handle(from, msg)))),
    );
    this.unsubscribe.push(t.onPeerLeave((peer) => this.guard('a dropped link', () => this.onPeerLeave(peer))));
  }

  /**
   * A17 step 6 (review, 2026-11-25): in a lobby nothing this engine does for a frame, a dropped link or one of its
   * own timers throws out of the transport's handler or the timer that called it: it is caught, reported
   * (`engineError`) and the engine goes on with what it holds. Without a lobby `fn` runs as it always did.
   */
  private guard(where: string, fn: () => void): void {
    if (!this.lobbyOn) {
      fn();
      return;
    }
    try {
      fn();
    } catch (e) {
      this.events.emit('engineError', { where, error: e instanceof Error ? e : new Error(String(e)) });
    }
  }

  private guarded(where: string, fn: () => void): () => void {
    return () => this.guard(where, fn);
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
    this.clearPending();
    this.clearClocks();
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

  /** `to`: the link the frame came on, when that is not the link of the player the frame names. */
  private reject(ref: AnyMessage, code: RejectCode, message: string, to: PlayerId = ref.from): void {
    const payload: PayloadOf<'REJECT'> = { refSeq: ref.seq, refType: ref.type, code, message: message.slice(0, SENTENCE_MAX) };
    // 2026-11-25: the answer to a frame goes to the link the frame came on, and the event is raised for that link.
    // For the first frame of a link that is nobody's yet that is the candidate (which is closed with it); for a
    // frame in another player's name it is the link that sent it. The player a frame names is sent nothing for it.
    const candidate = this.candidateOf(ref);
    if (candidate) candidate.refuse(this.s.build('REJECT', payload, this.matchId));
    this.events.emit('reject', { to, ...payload });
    if (!candidate && to !== this.localId) this.s.transport.send(to, this.s.build('REJECT', payload, this.matchId));
  }

  private refuse(hello: Message<'HELLO'>, code: RefuseCode, message: string, mismatches: PayloadOf<'REFUSE'>['mismatches'] = []): void {
    const msg = this.s.build('REFUSE', { code, message: message.slice(0, SENTENCE_MAX), mismatches }, null);
    // 2026-11-25: a HELLO that is refused changes nothing about the player it names. On a link that is nobody's yet
    // the answer goes to that link, which is then closed. On a link that is a participant's already the answer is
    // all; only the link of somebody who is in nothing is closed, as before.
    const candidate = this.candidateOf(hello);
    const known = this.isParticipant(hello.from);
    if (candidate) candidate.refuse(msg);
    else this.s.transport.send(hello.from, msg);
    this.events.emit('refused', { playerId: hello.from, refuse: msg.payload });
    if (!candidate && !known) this.s.transport.closePeer?.(hello.from);
  }

  /**
   * 2026-11-25: the first frame of a link that is nobody's yet, while it is being read (`judge`), with that link.
   * Null for every frame that comes from a link that is a player's.
   */
  private first: { candidate: LinkCandidate; msg: AnyMessage } | null = null;

  /**
   * 2026-11-25: the candidate `msg` came on, when `msg` is the first frame being judged (whatever its verdict by
   * now: an answer to that frame never goes to another link); null for any other frame.
   */
  private candidateOf(msg: AnyMessage): LinkCandidate | null {
    return this.first !== null && this.first.msg === msg ? this.first.candidate : null;
  }

  /**
   * 2026-11-25: read the first frame of a link that is nobody's yet. Whatever `run` does, the candidate leaves here
   * with a verdict: accepted where the frame was taken (`admit`), and otherwise refused, so no path through the
   * engine, present or added later, can leave such a link open or make it a player's by saying nothing.
   */
  private judge(candidate: LinkCandidate, msg: AnyMessage, run: () => void): void {
    const outer = this.first;
    this.first = { candidate, msg };
    try {
      // The link would become the player the transport named: a frame that names another is not read at all.
      if (candidate.player === msg.from) run();
    } finally {
      this.first = outer;
      candidate.refuse();
    }
  }

  /**
   * 2026-11-25: the frame that opens a link is taken. Only here does a candidate become its player's link, and only
   * here is the frame's `seq` recorded: a HELLO opens a connection, so the count starts over with it (A3: a client
   * that joins again starts a fresh session); a RECONNECT continues the count and must be above it. False, with
   * nothing changed, when the candidate is gone by now or the `seq` is not above the last taken.
   *
   * `keepCount`: a HELLO that continues the count instead of starting it over: its `seq` must be above the last taken
   * from that player, as a RECONNECT's must. For a HELLO that proves who sent it with a signature over its own `seq`
   * (a member's return to a lobby): starting the count over there would make one such frame good for any number of
   * uses. Nothing in a plain match asks for it.
   *
   * A frame that was held before it was read (`handle`'s `heldAtCount`) is judged against the count as it stood when
   * it arrived: the frames of the same player that were taken while it waited do not make it late.
   */
  protected admit(msg: Message<'HELLO'> | Message<'RECONNECT'>, opts: { keepCount?: boolean } = {}): boolean {
    const candidate = this.candidateOf(msg);
    if (candidate && candidate.state !== 'open') return false;
    const then = this.heldAt.get(msg);
    if (then !== undefined) {
      if (then !== null && msg.seq <= then) return false;
      this.s.noteSeq(msg.from, msg.seq);
    } else {
      if (msg.type === 'HELLO' && opts.keepCount !== true) this.s.resetSeq(msg.from);
      if (!this.s.checkSeq(msg.from, msg.seq)) return false;
    }
    candidate?.accept();
    return true;
  }

  /** 2026-11-25: for an opening frame that was held before it was read, the count of its player when it arrived (null: none). */
  private readonly heldAt = new WeakMap<AnyMessage, number | null>();

  // ------------------------------------------------------------------------------------------
  // Inbound dispatch
  // ------------------------------------------------------------------------------------------

  /**
   * Public so a client that just won a transfer can hand over the RECONNECTs it held (A2). `candidate` (2026-11-25):
   * `msg` is the first frame of a link that is nobody's yet; it leaves here accepted or refused (`judge`).
   * `heldAtCount`: `msg` is an opening frame that waited before it was handed over; the count of its player as it
   * stood when the frame arrived (null: none was kept), which is what its `seq` is judged against (`admit`).
   */
  handle(linkFrom: PlayerId, msg: AnyMessage, opts: { seqChecked?: boolean; candidate?: LinkCandidate; heldAtCount?: number | null } = {}): void {
    if (this.detached) return;
    if (msg.from !== linkFrom) {
      // A17: a closed lobby reads nothing more, and answers nothing in somebody else's name.
      if (this.lobbyOn && this.ended && msg.type !== 'HELLO') return;
      // On a star the old host relays acks and mirrors frames until it steps down; one that
      // reaches this host after the transfer is stale, not an impersonation (A2, 2026-10-30).
      if (this.s.transport.topology === 'star' && RELAYED_TYPES.has(msg.type)) return;
      this.reject(msg, 'unknown_player', `from=${msg.from} does not match the link peer ${linkFrom}`, linkFrom);
      return;
    }
    // `seq` is strictly increasing within a connection, and a HELLO opens one: a client that must
    // re-join after a rejected RECONNECT starts a fresh session, so its counter starts over (A3).
    // 2026-11-25: a frame that opens a link (HELLO, RECONNECT) has its `seq` looked at and recorded where the frame
    // itself is taken (`admit`), after every check that can refuse it, a RECONNECT's signature among them: a frame
    // that is refused leaves the count of the player it names where it was. And the first frame of a link that is
    // nobody's yet is read under `judge`; nothing but an opening frame is read from such a link.
    // (A17: that holds in a lobby as it stands: a member's count moves only for a frame that was taken.)
    if (opts.heldAtCount !== undefined) this.heldAt.set(msg, opts.heldAtCount);
    if (opts.candidate && this.candidateOf(msg) !== opts.candidate) return this.judge(opts.candidate, msg, () => this.handle(linkFrom, msg, opts));
    const opening = msg.type === 'HELLO' || msg.type === 'RECONNECT';
    if (opts.candidate && !opening) return;
    // A17: a closed lobby reads nothing more. Somebody who still tries to join is told so (`onHello`), and so is a
    // member who was away when it closed and comes back now: LOBBY_CLOSED on the link the frame came on (which, when
    // it is nobody's yet, is closed with that answer), so its PC stops waiting.
    if (this.lobbyOn && this.ended && msg.type !== 'HELLO') {
      if (msg.type === 'RECONNECT') {
        const closed = this.s.build('LOBBY_CLOSED', { reason: this.closedReason }, this.code);
        const candidate = this.candidateOf(msg);
        if (candidate) candidate.refuse(closed);
        else this.s.transport.send(linkFrom, closed);
      }
      return;
    }
    if (!opts.seqChecked && !opening && !this.s.checkSeq(msg.from, msg.seq)) {
      this.reject(msg, 'unexpected_state', `seq ${msg.seq} is not greater than the last accepted from ${msg.from}`);
      return;
    }
    // 2026-11-25: a player this host took for away on that player's own word (`presumeAway`) and whose own link then
    // brings a frame under its next number is on that link after all.
    if (!opening && this.presumed.has(msg.from)) this.backOnOwnLink(msg.from);
    if (msg.type === 'HELLO') {
      this.onHello(msg);
      return;
    }
    if (msg.type === 'RECONNECT') {
      if (this.lobbyOn) this.onLobbyReconnect(linkFrom, msg);
      else this.onReconnect(linkFrom, msg);
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
      case 'TABLE_PICK': {
        // A17 step 6: what a member asks of the lobby. Each is answered by the change it asks for (a HELLO_ACK, a
        // MATCH_END), or by a REJECT whose message is the sentence the asker is shown.
        if (!this.lobbyOn) {
          this.reject(msg, 'unexpected_state', `${msg.type} is not a client -> host message`);
          return;
        }
        const why =
          msg.type === 'START_REQUEST'
            ? this.requestStart(msg.payload, msg.from)
            : msg.type === 'START_CANCEL'
              ? this.cancelStart(msg.from)
              : msg.type === 'END_REQUEST'
                ? this.requestEnd(msg.from)
                : this.pickTable(msg.payload.game, msg.from, msg.payload.tableObjects ?? null);
        if (why !== null) this.reject(msg, 'unexpected_state', why);
        return;
      }
      case 'LEAVE_LOBBY':
        if (!this.lobbyOn) {
          this.reject(msg, 'unexpected_state', `${msg.type} is not a client -> host message`);
          return;
        }
        this.memberLeaves(msg.from);
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
      // A17 step 6: in a lobby a link that drops is never a leave. In every phase the member goes through A18's
      // grace below and is then away, with their place kept (`reviewClocks`); the game changes only for a player
      // it needs, and only when it needs them.
      if (!this.isMember(peer) || peer === this.localId) return;
      this.stopCatchUp(peer);
    }
    if (st.phase === 'lobby' && !this.lobbyOn) {
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
    this.startGrace(peer);
  }

  /**
   * A18: the grace of a peer whose link dropped begins (again): `graceMs` from now. A17 step 6 (review): while this
   * PC is itself cut off the grace is HELD, in the map with no timer running, and begins from zero when this PC is
   * back (`setCutOff`): a member is not away because the lobby's PC was.
   */
  private startGrace(peer: PlayerId): void {
    const running: TimerHandle | null | undefined = this.grace.get(peer);
    if (running != null) this.s.clock.clearTimeout(running);
    if (this.lobbyOn && this.cutOff) {
      this.grace.set(peer, null);
      return;
    }
    this.grace.set(
      peer,
      this.s.clock.setTimeout(
        this.guarded('the end of a grace', () => {
          this.grace.delete(peer);
          this.confirmLeave(peer);
        }),
        this.graceMs,
      ),
    );
  }

  /**
   * A18: the grace is over and the peer is not back: now it is a disconnect. The match waits for it only when the
   * waiting cannot be avoided: it holds the outstanding grant (the others see the pause; that player's own table plays
   * on), or its grant is the next to go out (`advance`). A player who is not up changes nothing for the one who is.
   */
  private confirmLeave(peer: PlayerId): void {
    if (this.detached || !this.gone.has(peer)) return;
    // A17 step 6: while this PC is itself cut off, the drop is its own: no leave is told and nobody is paused for.
    // The member is held inside the grace, which begins from zero when this PC is back.
    if (this.lobbyOn && this.cutOff) {
      this.grace.set(peer, null);
      return;
    }
    this.events.emit('peerLeft', peer);
    // A17: the lobby hears that this member is away (and a start they were in, and the clocks, are looked at again).
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
    const row = this.lobby.find((x) => x.playerId === p.participant.playerId);
    // A17 step 6 (review): a member whose Castcade started again holds nothing to RECONNECT with and says HELLO
    // afresh. While its place is kept, that HELLO is its return when it is signed with the row's own key.
    if (row && this.lobbyOn && this.returnsByHello(msg, row)) return;
    if (row) {
      // A17 step 6: also for a member who is away: a HELLO that is not that member's own never takes the place.
      // That member comes back with RECONNECT, or joins again once the place has run out.
      this.refuse(msg, 'duplicate_player', this.lobbyOn && this.gone.has(p.participant.playerId) ? `${p.participant.playerId} is in this lobby and away: the place is kept for a few minutes` : `${p.participant.playerId} is already in the match`);
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
    // A17 step 6: in a lobby the table is a pick, compared on its identity keys, and a table that differs (or is not
    // open, or is another game) is a state of that member's row, never a refusal.
    const mismatches = this.lobbyOn ? compareWithPick(this.hostGame, p.game, hostId) : compareFingerprints(this.hostGame, p.game, hostId);
    if (mismatches.length > 0 && this.fingerprintPolicy === 'refuse' && !this.lobbyOn) {
      const fields = mismatches.map((m) => m.field).join(', ');
      this.refuse(msg, 'fingerprint_mismatch', `game fingerprint differs in: ${fields}`, mismatches);
      return;
    }
    // 2026-11-25: taken. Its link is this player's from here on, and its `seq` is the first of a new count.
    if (!this.admit(msg)) return;
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
      if (!sameGame(u.game, this.selfGame)) {
        this.selfGame = { ...u.game };
        // No pick yet: the lobby's table follows this PC's own, and the first table it has open is the pick (what a
        // lobby opened with "No table: I open it myself" always did). After a pick this PC is a row like any other.
        if (!this.pickFixed) {
          this.hostGame = pickOf(u.game);
          if (this.tableOpen(u.game)) {
            this.pickFixed = true;
            this.pickedBy = this.localId;
            this.pickDefault = true;
          }
        } else if (this.pickDefault && UNHASHED.test(this.hostGame.tableHash) && !UNHASHED.test(u.game.tableHash) && u.game.kind === this.hostGame.kind && u.game.tableName === this.hostGame.tableName) {
          // Step 10: a table is named a moment before its file is hashed, and the default pick was made at the name.
          // The same table's hash, when it comes, is the pick's: without it nobody could be told to have the same file.
          this.hostGame = pickOf(u.game);
        }
        this.recompareAll();
        changed = true;
      }
    } else if (u.game !== undefined && !sameGame(u.game, this.lobbyGames.get(id))) {
      this.lobbyGames.set(id, { ...u.game });
      this.setMismatch(id, compareWithPick(this.hostGame, u.game, this.localId));
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
    // I11.4.9: counted whenever no game is being played: every start of a lobby waits for its players' 3D connections.
    if (u.stream3dWaitMs !== undefined && this.waits3dNow() && this.noteStream3dWait(id, u.stream3dWaitMs)) changed = true;
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
    // Step 10: where this member's PC stands on its way to the lobby's table (null: nothing to say any more).
    if (u.tableChange !== undefined && (u.tableChange ?? undefined) !== this.changing.get(id)) {
      if (u.tableChange === null) this.changing.delete(id);
      else this.changing.set(id, u.tableChange);
      changed = true;
    }
    // Step 6: a start from the table belongs to the game that asked for it. That game ended on its table before the
    // start came to anything (the PC says `ownGame: false`): the start is off, and the next one asks again (A12).
    if (u.ownGame === false && this.pending?.tableOf === id) {
      this.dropStart(`${this.nameOf(id)}'s game on the table ended: the start is off.`);
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
    // Step 8: a row that is gone keeps no count across a restart (a later frame of that name is a newcomer's).
    this.s.dropCeiling(peer);
    this.lobbyGames.delete(peer);
    this.ballEndReady.delete(peer);
    this.midnightModeOf.delete(peer);
    this.stances.delete(peer);
    this.withoutCopy.delete(peer);
    this.inOwnGame.delete(peer);
    this.changing.delete(peer);
    if (this.stream3dWait.delete(peer)) this.armStream3dTimer();
    const inGrace = this.grace.has(peer);
    const held: TimerHandle | null | undefined = this.grace.get(peer);
    if (held != null) this.s.clock.clearTimeout(held);
    this.grace.delete(peer);
    const told = this.gone.delete(peer) && !inGrace;
    const place = this.placeTimers.get(peer);
    if (place !== undefined) this.s.clock.clearTimeout(place);
    this.placeTimers.delete(peer);
    this.stopCatchUp(peer);
    this.setMismatch(peer, []);
    // A member already known to be away has had its `peerLeft`.
    if (!told) this.events.emit('peerLeft', peer);
    if (tell) this.resendAck();
  }

  /** A17: what HELLO_ACK says in a lobby beyond a match's lobby of before. */
  private lobbyFacts(): Pick<PayloadOf<'HELLO_ACK'>, 'stances' | 'away' | 'noCopy' | 'ownGame' | 'otherTable' | 'tableChange' | 'tablePickedBy' | 'ballsPerGame' | 'starter' | 'match' | 'start' | 'startOff'> {
    const ids = this.lobby.map((p) => p.playerId);
    const off = this.startOffNote;
    this.startOffNote = null;
    if (this.pending) this.pending.announced = true;
    return {
      stances: ids.map((playerId) => ({ playerId, stance: this.stances.get(playerId) ?? 'play' })),
      away: ids.filter((id) => this.away(id)),
      noCopy: ids.filter((id) => this.withoutCopy.has(id)),
      ownGame: ids.filter((id) => this.inOwnGame.has(id)),
      otherTable: this.otherTableIds(),
      tableChange: this.tableChanges(),
      tablePickedBy: this.pickedBy,
      ballsPerGame: this.ballsPerGameInit,
      starter: this.starter(),
      match: this.openMatch(),
      start: this.announcedStart(),
      ...(off !== null ? { startOff: off } : {}),
      ...(this.keptMs !== null ? { hostQuit: { keptMs: this.keptMs } } : {}),
    };
  }

  private nameOf(id: PlayerId): string {
    return this.lobby.find((p) => p.playerId === id)?.displayName ?? id;
  }

  private namesOf(ids: readonly PlayerId[]): string {
    const names = ids.map((id) => this.nameOf(id));
    return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  }

  // ------------------------------------------------------------------------------------------
  // A17 step 6: a start, asked for by anyone (design 11.4)
  // ------------------------------------------------------------------------------------------

  /**
   * A17 step 6: ask for a start, as `by` (default: this PC's owner; a member's START_REQUEST comes here too).
   * Returns null when the request was taken (a start is announced now, or was already, or nothing had to change),
   * or the sentence the asker is shown when it was not.
   *
   * - `fromTable`: the asker's own game began on their table. Taken from the starter only; it makes the asker's
   *   game the first of the match (they go first, and it holds nothing up). Arriving while somebody else's start is
   *   announced, it puts the starter first in that start.
   * - With a match open the start is its next game, with its own players who are set to Play and here; `newMatch`
   *   ends that match and starts one with everyone set to Play. With none open every start is a new match.
   * - `anyway`: the asker confirmed a start with a table that cannot report ball ends.
   * - `now`: a second press while a start waits: without the people it waits for (if two are left), and without
   *   the 3D connections. A press without it while a start is announced changes nothing.
   */
  requestStart(ask: StartAsk = {}, by: PlayerId = this.localId): string | null {
    this.assertActive();
    if (!this.lobbyOn) return 'this match has no lobby';
    if (this.ended) return 'The lobby is closed.';
    if (!this.isMember(by)) return `${by} is not in the lobby`;
    const st = this.s.state;
    const fromTable = ask.fromTable === true;
    if (fromTable && ask.newMatch === true) return 'A game started on a table is the next game, never a new match: press Start a new match.';
    if (st.phase === 'running') return 'A game is being played.';
    const starter = this.starter();
    const notStarter = `${starter === null ? 'Nobody' : `Only ${this.nameOf(starter)}`} starts a match from the table. To start it yourself, use Start in the menu.`;
    const p = this.pending;
    if (p) {
      if (fromTable) {
        if (by !== starter) return notStarter;
        // The starter, but not one of this start's players (they set themselves to Play after it was asked): their
        // game is not the match's, and their PC has to hear it.
        if (!p.players.includes(by)) return 'A match is starting without you: the game on your table is your own.';
        // The starter's own game began in the moment before the announced start's lock reached their PC: theirs is
        // the one table that can have begun a game, so it is the match's first and they go first.
        if (p.tableOf !== by) {
          p.players = [by, ...p.players.filter((id) => id !== by)];
          p.tableOf = by;
          this.resendAck();
        }
        return null;
      }
      if (ask.now === true && p.waitsFor !== null) return this.startWithout();
      return null;
    }
    if (fromTable && by !== starter) return notStarter;
    const open = st.phase === 'ended';
    const newMatch = !open || ask.newMatch === true;
    const players = this.startPlayers(newMatch, by);
    const few = this.tooFew(players, newMatch);
    if (few !== null) return few;
    if (players.length > 4) return `A match has at most four players: ${players.length} are set to Play.`;
    this.pending = {
      by,
      byName: this.nameOf(by),
      players,
      newMatch,
      tableOf: fromTable ? by : null,
      anyway: ask.anyway === true,
      no3d: false,
      waitsFor: null,
      waitsOn: [],
      endsAt: null,
      timer: null,
      due: false,
      capTimer: null,
      capAt: null,
      announced: false,
    };
    // The checks, now: it counts down, waits, or is refused with the sentence of the check that failed.
    this.judgeStart();
    if (!this.pending) {
      const why = this.startOffNote ?? 'The start is off.';
      this.startOffNote = null;
      return why;
    }
    this.resendAck();
    return null;
  }

  /**
   * A17 step 6: take back the start that counts down or waits (`by`: who; a member's START_CANCEL comes here).
   * Anybody in the lobby may. Null when it is off now, or the sentence when there was none.
   */
  cancelStart(by: PlayerId = this.localId): string | null {
    this.assertActive();
    if (!this.lobbyOn) return 'this match has no lobby';
    if (!this.pending) return 'No start is under way.';
    this.dropStart(`${this.nameOf(by)} cancelled the start.`);
    this.resendAck();
    return null;
  }

  /**
   * A17 step 6: end the open match (`by`: who; a member's END_REQUEST comes here). Between games anyone may: the
   * tally is final and everyone is back in the lobby. During a game only this PC's owner may, and it is "End match
   * for everyone": the game being played has no result. Null when the match is ended, or the sentence why not.
   */
  requestEnd(by: PlayerId = this.localId): string | null {
    this.assertActive();
    if (!this.lobbyOn) return 'this match has no lobby';
    if (this.ended) return 'The lobby is closed.';
    const st = this.s.state;
    if (st.phase === 'lobby') return 'No match is open.';
    if (st.phase === 'running' && by !== this.localId) return "Only the lobby's PC ends a match while a game is being played.";
    if (st.phase === 'ended' && !this.resultSent && by !== this.localId) return "The last game's result is on its way: end the match in a moment.";
    this.endOpenMatch(st.phase === 'running' ? `${this.nameOf(by)} ended the match for everyone` : `${this.nameOf(by)} ended the match`);
    return null;
  }

  /**
   * A17 step 6: the open match ends now, whatever its state. Between games: MATCH_END. A game whose last ball has
   * ended and whose RESULT is still waiting for signatures: the RESULT goes out as it is, then MATCH_END. A game
   * that is being played: ended for everyone, a win for nobody: no FORFEIT, no RESULT, `abandoned` names it.
   */
  private endOpenMatch(reason: string): void {
    const st = this.s.state;
    if (st.phase === 'lobby') return;
    if (st.phase === 'ended' && !this.resultSent) {
      if (!this.finalHead) this.finalHead = this.s.log.head();
      this.sendResult();
    }
    this.closeMatch(reason, st.phase === 'running' ? Math.max(1, st.gameNumber) : null);
  }

  /** Why the lobby's table cannot be picked now, or null when it can (design 11.5). */
  pickBlocker(): string | null {
    const st = this.s.state;
    if (!this.lobbyOn) return 'this match has no lobby';
    if (this.ended) return 'The lobby is closed.';
    if (st.phase === 'running') return 'A game is being played: the table changes after it.';
    if (this.pending) return 'A match is starting: cancel the start to change the table.';
    if (st.phase === 'ended' && !this.resultSent) return "The last game's result is on its way: pick the table in a moment.";
    return null;
  }

  /**
   * A17 step 6: pick the lobby's table (`by`: who; a member's TABLE_PICK comes here). Only the table's identity is
   * kept (`pickOf`). Every member's own table is compared with it again; an open match ends at that moment ("the
   * table changed": a tally is for one table). What each PC then does about its own VPX is the shell's. Null when
   * the pick stands (also when it is the table the lobby had), or the sentence why not.
   */
  pickTable(game: GameFingerprint, by: PlayerId = this.localId, objects: { editables: number; hash: string } | null = null): string | null {
    this.assertActive();
    const why = this.pickBlocker();
    if (why !== null) return why;
    if (!this.isMember(by)) return `${by} is not in the lobby`;
    // Step 10: the name is kept clean (it is shown and logged on every PC), and a pick has to name a table.
    const next = pickOf({ ...game, tableName: pickName(game.tableName) });
    if (next.tableName === '' || !this.tableOpen(next)) return 'That is not a table: pick one from the list.';
    if (this.pickFixed && samePick(next, this.hostGame)) {
      // The table it already is: nothing changes. What is now known of it is kept (a pick made by default says none).
      if (objects && !this.pickObjects && this.tableObjects() === null) {
        this.pickObjects = { editables: objects.editables, hash: objects.hash };
        this.resendAck();
      }
      return null;
    }
    // Step 10: limits on how often the lobby's table can change.
    const now = this.s.clock.now();
    const left = (since: number | null | undefined, gap: number): number => (since === null || since === undefined ? 0 : Math.ceil((since + gap - now) / 1000));
    const mine = left(this.lastPickBy.get(by), this.pickMemberGapMs);
    if (mine > 0) return `You changed the lobby's table a moment ago: you can change it again in ${mine} s.`;
    const anyone = left(this.lastPickAt, this.pickGapMs);
    if (anyone > 0) return `The lobby's table was changed a moment ago: it can be changed again in ${anyone} s.`;
    this.lastPickAt = now;
    // (A member's own time runs on whether they are in the lobby or not, and is forgotten once it is over.)
    for (const [id, at] of this.lastPickBy) if (at + this.pickMemberGapMs <= now) this.lastPickBy.delete(id);
    this.lastPickBy.set(by, now);
    this.hostGame = next;
    this.pickFixed = true;
    this.pickDefault = false;
    this.pickObjects = objects ? { editables: objects.editables, hash: objects.hash } : null;
    this.pickedBy = by;
    // (Where each PC stands is each PC's own word, and stays until that PC says otherwise: a PC that was closing
    // its table for the pick before is still closing it, and says nothing new.)
    this.recompareAll();
    this.events.emit('tablePicked', { by, game: { ...next } });
    if (this.s.state.phase === 'ended') this.closeMatch('the table changed');
    else this.resendAck();
    return null;
  }

  /** Who a start asked now would be played by, the asker first when they are one of them. */
  private startPlayers(newMatch: boolean, by: PlayerId): PlayerId[] {
    const st = this.s.state;
    let ids: PlayerId[];
    if (newMatch) {
      ids = this.playSet();
    } else {
      // The open match's own players: as in the game just played, then the ones who sat it out.
      const roster = st.participants.map((x) => x.playerId);
      ids = [...st.playerOrder, ...roster.filter((id) => !st.playerOrder.includes(id))].filter((id) => this.canPlay(id));
    }
    return ids.includes(by) ? [by, ...ids.filter((id) => id !== by)] : ids;
  }

  /** The sentence for a start that fewer than two would play, or null. */
  private tooFew(players: readonly PlayerId[], newMatch: boolean): string | null {
    if (players.length >= 2) return null;
    const who = players.length === 1 ? `Only ${this.nameOf(players[0] as PlayerId)}` : 'Nobody';
    if (newMatch) return `${who} is set to Play: a match needs two.`;
    const st = this.s.state;
    const outside = this.playSet().filter((id) => !st.participants.some((x) => x.playerId === id));
    if (outside.length > 0) return `${who} of this match is set to Play. Press Start a new match to play with ${this.namesOf(outside)}.`;
    return `${who} of this match is set to Play: a game needs two.`;
  }

  /**
   * The checks of a start, in the design's order (11.4), on the players it has now. `go`: nothing is in the way;
   * `wait`: it waits, for what and for whom; `refuse`: it cannot be, with the sentence.
   */
  private checkStart(p: PendingStart): { kind: 'go' } | { kind: 'wait'; waitsFor: StartWait; on: PlayerId[] } | { kind: 'refuse'; message: string } {
    const st = this.s.state;
    if (st.phase === 'ended' && !this.resultSent) return { kind: 'wait', waitsFor: 'result', on: [] };
    const few = this.tooFew(p.players, p.newMatch);
    if (few !== null) return { kind: 'refuse', message: few };
    const loading = p.players.filter((id) => !this.tableIsOpen(id));
    if (loading.length > 0) return { kind: 'wait', waitsFor: 'tables', on: loading };
    const elsewhere = this.otherTableIds();
    const other = p.players.filter((id) => elsewhere.includes(id));
    if (other.length > 0) return { kind: 'wait', waitsFor: 'other_tables', on: other };
    const own = p.players.filter((id) => this.inOwnGame.has(id) && id !== p.tableOf);
    if (own.length > 0) return { kind: 'wait', waitsFor: 'own_games', on: own };
    const unreadable = p.players.filter((id) => this.ballEndReady.get(id) === false);
    if (unreadable.length > 0 && !p.anyway) {
      return {
        kind: 'refuse',
        message: `${this.namesOf(unreadable)}'s table cannot report ball ends (not patched, an original table, or a machine whose ball ends cannot be read). Start anyway: each of their balls is then ended with End my ball.`,
      };
    }
    if (!p.no3d) {
      const making = this.stream3dWaiting()
        .map((x) => x.playerId)
        .filter((id) => p.players.includes(id));
      if (making.length > 0) return { kind: 'wait', waitsFor: '3d', on: making };
    }
    return { kind: 'go' };
  }

  /**
   * The announced start, looked at again: after the request, on every change of the lobby (`resendAck` calls it),
   * and when its countdown runs out. People who can no longer play it are taken out; it is dropped when it belongs
   * to nobody any more or fewer than two are left; while it counts down nothing else is checked (the checks run
   * again when the countdown runs out); a start that waits begins its countdown when nothing is in the way. Sends
   * nothing: the caller says the lobby again.
   */
  private judgeStart(): void {
    const p = this.pending;
    if (!p || this.ended) return;
    const st = this.s.state;
    if (st.phase === 'running') return this.dropStart(null);
    if (!this.isMember(p.by)) return this.dropStart(`${p.byName} left the lobby: the start is off.`);
    if (!p.newMatch && st.phase !== 'ended') return this.dropStart('The match was ended: the start is off.');
    const out = p.players.filter((id) => !this.canPlay(id));
    if (out.length > 0) {
      const first = out[0] as PlayerId;
      const why = !this.isMember(first) ? 'left the lobby' : this.away(first) ? 'is away' : this.stances.get(first) === 'watch' ? 'is set to Watch now' : 'has no copy of the table';
      const words = `${this.isMember(first) ? this.nameOf(first) : first} ${why}: the start is off.`;
      p.players = p.players.filter((id) => this.canPlay(id));
      if (p.tableOf !== null && !p.players.includes(p.tableOf)) p.tableOf = null;
      // A start that waits belongs to the person who asked: without them as a player it is off. One that counts
      // down goes on without whoever stepped out, while two are left.
      if (p.players.length < 2 || (p.endsAt === null && out.includes(p.by))) return this.dropStart(words);
    }
    // A start that waits belongs to the person who asked, whether or not they play it: away, it is off.
    if (p.endsAt === null && this.away(p.by)) return this.dropStart(`${p.byName} is away: the start is off.`);
    // Counting down: nothing is checked until it runs out.
    if (p.endsAt !== null && !p.due) return;
    // Run out, and one of its players is inside A18's grace, or this PC is itself cut off: it stays due, and is
    // judged again when the grace settles (their return, or the end of the grace, both say the lobby again).
    if (p.due && (this.cutOff || p.players.some((id) => this.grace.has(id)))) return;
    const v = this.checkStart(p);
    if (v.kind === 'refuse') return this.dropStart(v.message);
    if (v.kind === 'wait') {
      p.due = false;
      p.endsAt = null;
      p.waitsFor = v.waitsFor;
      p.waitsOn = v.on;
      // The 3D wait has one limit, counted from the first time this start was held for it.
      if (v.waitsFor === '3d' && p.capAt === null) {
        p.capAt = this.s.clock.now() + this.start3dMaxMs;
        p.capTimer = this.s.clock.setTimeout(this.guarded('the limit of the 3D wait', () => {
          p.capTimer = null;
          if (this.pending !== p || this.detached) return;
          p.no3d = true;
          this.resendAck();
        }), this.start3dMaxMs);
      }
      return;
    }
    p.waitsFor = null;
    p.waitsOn = [];
    if (p.due) {
      // The countdown ran out and the checks pass: it starts.
      this.pending = null;
      if (p.capTimer !== null) this.s.clock.clearTimeout(p.capTimer);
      if (p.newMatch) {
        if (st.phase === 'ended') this.closeMatch('a new match was started');
        this.beginMatch(p.players);
      } else {
        this.startNextGame(p.players);
      }
      return;
    }
    p.endsAt = this.s.clock.now() + this.countdownMs;
    p.timer = this.s.clock.setTimeout(this.guarded('the end of a countdown', () => {
      p.timer = null;
      if (this.pending !== p || this.detached) return;
      // Due from here on (`endsAt` stays where it was: the start reads "counting down, nothing left" while it is held).
      p.due = true;
      this.judgeStart();
      // Started: MATCH_READY or NEXT_GAME said it. Not started: it is held, waits again, or is off; the lobby hears which.
      if (this.s.state.phase !== 'running') this.resendAck();
    }), this.countdownMs);
    this.events.emit('countdown', { startsInMs: this.countdownMs });
  }

  /** A second press while a start waits (`now`): without the 3D connections, and without the people it waits for. */
  private startWithout(): string | null {
    const p = this.pending;
    if (!p || p.waitsFor === null || p.waitsFor === 'result') return null;
    if (p.waitsFor !== '3d') {
      const rest = p.players.filter((id) => !p.waitsOn.includes(id));
      if (rest.length < 2) return `Without ${this.namesOf(p.waitsOn)} ${rest.length === 1 ? `only ${this.nameOf(rest[0] as PlayerId)} is` : 'nobody is'} left: a match needs two.`;
      p.players = rest;
      if (p.tableOf !== null && !rest.includes(p.tableOf)) p.tableOf = null;
    }
    p.no3d = true;
    this.resendAck();
    return null;
  }

  /** The announced start is off. `reason`: the sentence for every panel (null: something else started; nothing to say). */
  private dropStart(reason: string | null): void {
    const p = this.pending;
    if (!p) return;
    this.clearPending();
    if (reason === null) return;
    // Cut to what HELLO_ACK takes: a sentence with two long names in it must not be what stops the lobby being said.
    const words = reason.slice(0, SENTENCE_MAX);
    this.startOffNote = words;
    if (p.announced) this.events.emit('startOff', { reason: words });
  }

  private clearPending(): void {
    const p = this.pending;
    if (!p) return;
    if (p.timer !== null) this.s.clock.clearTimeout(p.timer);
    if (p.capTimer !== null) this.s.clock.clearTimeout(p.capTimer);
    this.pending = null;
  }

  // ------------------------------------------------------------------------------------------
  // A17 step 6: away, and the two clocks (design 11.8)
  // ------------------------------------------------------------------------------------------

  /**
   * The clocks, set to what the lobby is now. Called after everything that can change who is away, who the game
   * needs, or what it is paused for. The place clock runs for a member who is away and whom no game needs (a
   * watcher; anyone while no game is played; a player whose own game is over); the turn clock runs for the player
   * the game is paused for at their own turn. Neither runs while this PC is cut off.
   */
  private reviewClocks(): void {
    if (!this.lobbyOn || this.detached) return;
    const st = this.s.state;
    if (this.ended || this.cutOff) return this.clearClocks();
    // Step 7: a member who has been back since this PC's return is as any other from then on.
    for (const id of [...this.returning]) if (!this.gone.has(id)) this.returning.delete(id);
    const needs = (id: PlayerId): boolean => st.phase === 'running' && st.players[id]?.status === 'playing';
    for (const p of this.lobby) {
      const id = p.playerId;
      const running = this.placeTimers.get(id);
      if (id !== this.localId && this.away(id) && !needs(id)) {
        if (running === undefined) {
          this.placeTimers.set(
            id,
            this.s.clock.setTimeout(this.guarded('the end of a place', () => {
              this.placeTimers.delete(id);
              if (this.detached || !this.away(id)) return;
              this.events.emit('memberRemoved', id);
              this.dropMember(id, true);
            }), this.placeMs + this.returnLeft(id)),
          );
        }
      } else if (running !== undefined) {
        this.s.clock.clearTimeout(running);
        this.placeTimers.delete(id);
      }
    }
    const paused = st.phase === 'running' ? st.paused : null;
    const waited = paused?.reason === 'disconnect' && paused.player !== null && this.away(paused.player) && needs(paused.player) ? paused.player : null;
    if (this.turnClock && this.turnClock.player !== waited) this.stopTurnClock();
    if (waited !== null && !this.turnClock) {
      this.turnClock = { player: waited, timer: null, since: this.s.clock.now(), asked: false };
      this.armTurnClock();
    }
  }

  /** The turn clock is over without having done anything; a question that was open about that player is withdrawn. */
  private stopTurnClock(): void {
    const t = this.turnClock;
    if (!t) return;
    if (t.timer !== null) this.s.clock.clearTimeout(t.timer);
    this.turnClock = null;
    if (t.asked) this.events.emit('awayQuestionOff', { player: t.player });
  }

  private armTurnClock(): void {
    const t = this.turnClock;
    if (!t) return;
    t.asked = false;
    t.timer = this.s.clock.setTimeout(this.guarded('the end of a turn clock', () => {
      t.timer = null;
      if (this.turnClock !== t || this.detached) return;
      // A player who holds the grant and is still seen playing is never forfeited by a clock: this PC's owner is asked.
      if (this.s.state.currentGrant?.grant.player === t.player && this.stillSeen(t.player)) {
        t.asked = true;
        this.events.emit('awayQuestion', { player: t.player, waitedMs: this.s.clock.now() - t.since });
        return;
      }
      this.playOnWithout(t.player);
    }), this.turnMs + this.returnLeft(t.player));
  }

  /**
   * Step 7: what is left of the time a member has to find the lobby again after this PC's own return
   * (`returnAllowMs`): added to a clock that is armed for them meanwhile. 0 for anybody who was here at the return,
   * or has been back since.
   */
  private returnLeft(id: PlayerId): number {
    if (this.returnedAt === null || !this.returning.has(id)) return 0;
    return Math.max(0, this.returnedAt + this.returnAllowMs - this.s.clock.now());
  }

  private clearClocks(): void {
    for (const t of this.placeTimers.values()) this.s.clock.clearTimeout(t);
    this.placeTimers.clear();
    this.stopTurnClock();
  }

  /**
   * A17 step 8 (the review of PR 138): this PC's Castcade is being closed by its owner and the lobby is kept for
   * `keptMs`: said to every member that can be reached, as the lobby's last word (`HELLO_ACK.hostQuit`), so that
   * they read what happened and not the line of a PC that is away for no known reason. The caller closes the engine
   * right after. False when there is no lobby, or it is over.
   */
  sayKept(keptMs: number): boolean {
    if (!this.lobbyOn || this.detached || this.ended) return false;
    this.keptMs = Math.max(0, Math.min(3_600_000, Math.round(keptMs)));
    this.resendAck();
    return true;
  }

  /** A17 step 6: the player the game is paused for at their own turn, and since when (this PC's clock); null: nobody is waited for. */
  waitedFor(): { player: PlayerId; since: number; asked: boolean } | null {
    const t = this.turnClock;
    return t ? { player: t.player, since: t.since, asked: t.asked } : null;
  }

  /**
   * A17 step 6: "Play on without Krobs": the player the game is paused for is forfeited now (the engine's own
   * FORFEIT; `disconnected` in the RESULT) and the game goes on. What the turn clock does by itself when it runs
   * out. False when the game is not paused for that player's disconnect.
   */
  playOnWithout(player: PlayerId): boolean {
    this.assertActive();
    const st = this.s.state;
    if (st.phase !== 'running' || st.paused?.reason !== 'disconnect' || st.paused.player !== player || st.players[player]?.status !== 'playing') return false;
    this.forfeit(player, 'did not come back');
    if (this.s.state.phase === 'running' && this.s.state.paused) this.resume();
    return true;
  }

  /**
   * A17 step 6: the owner's answer to `awayQuestion`. `wait`: keep waiting (asked again after another turn clock);
   * `end_ball`: their ball ends by hand (Pass the turn) at `score`, the score as it stands, which the shell knows
   * from that player's last STATE (without it: their last logged score, the end of their ball before), and the game
   * goes on (it pauses again when the turn next reaches them and they are still away); `play_on`: `playOnWithout`.
   * False when nobody is asked about.
   */
  answerAway(player: PlayerId, answer: 'wait' | 'end_ball' | 'play_on', score?: number): boolean {
    this.assertActive();
    const t = this.turnClock;
    if (!t || t.player !== player || !t.asked) return false;
    // Answered: whatever ends this clock now is the answer, not the question going stale.
    t.asked = false;
    if (answer === 'play_on') return this.playOnWithout(player);
    if (answer === 'wait') {
      this.armTurnClock();
      return true;
    }
    if (!this.passTurn(score)) return false;
    if (this.s.state.phase === 'running' && this.s.state.paused) this.resume();
    return true;
  }

  /**
   * A17 step 6 (design 11.8, 11.8a): this PC lost (true) or has back (false) its own connection to the relay. While
   * it is cut off every member who came through the relay drops at once and none of them is at fault: no leave is
   * confirmed, nobody is paused for, both clocks stand still, and a ball that ends finds the game waiting. When it
   * is back the members get A18's grace again from zero, then whoever is still gone is away and the clocks start.
   */
  setCutOff(cutOff: boolean, o: { returning?: boolean } = {}): void {
    if (!this.lobbyOn || this.detached || this.ended || this.cutOff === cutOff) return;
    this.cutOff = cutOff;
    if (cutOff) {
      this.awayBefore.clear();
      for (const id of this.gone) if (!this.grace.has(id)) this.awayBefore.add(id);
      // Every grace that is running is held where it is, with no timer: what it counted was this PC's own absence.
      for (const [id, t] of [...this.grace]) {
        if (t != null) this.s.clock.clearTimeout(t);
        this.grace.set(id, null);
      }
      this.clearClocks();
      this.returning.clear();
      this.returnedAt = null;
      // The two timeouts that count against a player stand still as well: nobody can hear the player now.
      this.clearBallEndTimer();
      if (this.logSignTimer !== null) this.s.clock.clearTimeout(this.logSignTimer);
      this.logSignTimer = null;
      return;
    }
    // Back. Step 7: whoever is gone at this moment has `returnAllowMs` from now to find the lobby again before a
    // clock counts against them (`returnLeft`).
    // The review of PR 138: not for a member who was away by themselves before this PC went (their clocks go on as
    // they would have), and for nobody when the caller says none of them can come back (`returning: false`: the room
    // they came through is closed for good).
    this.returnedAt = this.s.clock.now();
    if (o.returning !== false) for (const id of this.gone) if (!this.awayBefore.has(id)) this.returning.add(id);
    this.awayBefore.clear();
    // Every member whose link is down and whose leave was told to nobody gets the grace from zero.
    for (const id of [...this.grace.keys()]) {
      if (!this.gone.has(id)) {
        this.grace.delete(id);
      } else if (this.graceMs <= 0) {
        this.grace.delete(id);
        this.confirmLeave(id);
      } else {
        this.startGrace(id);
      }
    }
    const st = this.s.state;
    if (st.phase === 'running' && st.currentGrant && !st.paused && !st.pendingTransfer) this.armBallEndTimer(st.currentGrant.grant.grantSeq);
    if (st.phase === 'ended' && this.finalHead && !this.resultSent && !this.maybeSendResult()) this.armLogSignTimer();
    this.advance();
    // The lobby again (to this PC's own shell at least): the clocks from zero, and a start that was held.
    this.resendAck();
  }

  // ------------------------------------------------------------------------------------------
  // A17 step 6: RECONNECT in every phase (design 11.7)
  // ------------------------------------------------------------------------------------------

  /**
   * A member comes back. Checked against the member's key as the LOBBY holds it (a watcher is in no match's
   * roster): the envelope and the signed body carry the lobby's code, the body also the id of the lobby's PC the
   * frame is addressed to (this one), the match the member holds a log of and the envelope's own `seq`. It is taken
   * once, in `admit`, after the signature: only there is the `seq` recorded and the link the frame came on made the
   * member's (2026-11-25); until then nothing is marked and nothing is sent to the member. The answer:
   * - the same match is open and the head is known: the entries after it, the first page in the answer (`more`),
   *   the rest in MATCH_LOG;
   * - anything else (another match, none, a head this log does not have): `restart`: the member drops its log, and
   *   the open match's whole log follows in MATCH_LOG (nothing follows when none is open).
   * Every answer names the head of the log it carries. Then the lobby as it is now, to everyone, and the RESULTs.
   */
  private onLobbyReconnect(linkFrom: PlayerId, msg: Message<'RECONNECT'>): void {
    const p = msg.payload;
    const st = this.s.state;
    const member = this.lobby.find((x) => x.playerId === msg.from);
    if (!member || p.player !== msg.from || msg.from === this.localId) return this.refuseReconnect(linkFrom, msg, 'unknown_player');
    const held = p.match ?? null;
    if (
      msg.matchId !== this.code ||
      !verifyCanonical(lobbyReconnectSignBody(this.code, this.localId, p.player, held, p.logHash, p.logLength, msg.seq), p.signature, member.publicKey)
    ) {
      return this.refuseReconnect(linkFrom, msg, 'bad_signature');
    }
    // Its own, then: and good for one use. The `seq` is taken only now, and only when it is above the last taken
    // from this member; the same frame sent a second time stops here. From `admit` on the link is the member's.
    if (!this.admit(msg)) {
      // A link that is gone by now gets no answer, and nothing changed.
      if (this.candidateOf(msg)?.state === 'refused') return;
      return this.refuseReconnect(linkFrom, msg, 'stale_seq');
    }
    // Back on a link. A18: inside the grace (or while this PC was cut off) nobody was told it had left.
    const quiet = this.grace.has(msg.from);
    const timer: TimerHandle | null | undefined = this.grace.get(msg.from);
    if (timer != null) this.s.clock.clearTimeout(timer);
    this.grace.delete(msg.from);
    this.gone.delete(msg.from);
    this.stopCatchUp(msg.from);
    const open = st.phase === 'lobby' ? null : st.matchId;
    const known = p.logLength === 0 ? p.logHash === GENESIS_HASH : this.s.log.at(p.logLength - 1)?.hash === p.logHash;
    if (open !== null && held === open && known) {
      const entries = this.s.log.entries().slice(p.logLength);
      const first = entries.slice(0, this.logPageSize);
      const upTo = p.logLength + first.length;
      const more = first.length < entries.length;
      this.s.transport.send(
        linkFrom,
        this.s.build('RECONNECT_ACK', { accept: true, code: null, entries: first.map((e) => ({ ...e })), logHash: this.hashAt(upTo), logLength: upTo, match: open, ...(more ? { more: true } : {}) }, this.code),
      );
      this.events.emit('reconnected', { playerId: msg.from, entries: entries.length, quiet });
      if (more) this.sendLog(msg.from, upTo, false);
      else this.sendResults(msg.from);
    } else {
      const last = this.lastMatch;
      const knownThere = last !== null && held === last.matchId && (p.logLength === 0 ? p.logHash === GENESIS_HASH : last.log.at(p.logLength - 1)?.hash === p.logHash);
      if (last !== null && knownThere) {
        // The match this member holds was closed while they were away, and is the last one closed: they get what
        // everyone else got. Its log to the end (the first page here, the rest in MATCH_LOG), then its RESULTs and
        // its MATCH_END as they were sent, so that every member ends that match with the same tally.
        const entries = last.log.entries().slice(p.logLength);
        const head = (length: number): string => (length <= 0 ? GENESIS_HASH : (last.log.at(length - 1)?.hash ?? GENESIS_HASH));
        let upTo = p.logLength + Math.min(entries.length, this.logPageSize);
        const more = upTo < last.log.length;
        this.s.transport.send(
          linkFrom,
          this.s.build(
            'RECONNECT_ACK',
            { accept: true, code: null, entries: entries.slice(0, this.logPageSize).map((e) => ({ ...e })), logHash: head(upTo), logLength: upTo, match: open, closed: true, ...(more ? { more: true } : {}) },
            this.code,
          ),
        );
        while (upTo < last.log.length) {
          const page = last.log.entries().slice(upTo, upTo + this.logPageSize);
          upTo += page.length;
          this.s.transport.send(
            linkFrom,
            this.s.build('MATCH_LOG', { match: last.matchId, restart: false, entries: page.map((e) => ({ ...e })), logHash: head(upTo), logLength: upTo, more: upTo < last.log.length }, this.code),
          );
        }
        for (const r of last.results) this.s.transport.send(linkFrom, this.s.build('RESULT', r, last.matchId));
        this.s.transport.send(linkFrom, this.s.build('MATCH_END', last.end, last.matchId));
        this.events.emit('reconnected', { playerId: msg.from, entries: entries.length, quiet });
      } else {
        this.s.transport.send(linkFrom, this.s.build('RECONNECT_ACK', { accept: true, code: null, entries: [], logHash: GENESIS_HASH, logLength: 0, match: open, restart: true }, this.code));
        if (open !== null && held === open && p.logLength > 0) this.events.emit('memberAhead', { playerId: msg.from, entries: p.logLength });
        this.events.emit('reconnected', { playerId: msg.from, entries: 0, quiet });
      }
      if (open !== null) this.sendLog(msg.from, 0, true);
    }
    // The lobby as it is now, to everyone, AFTER what the answer carries (a start that waited for this member's
    // grace to settle may begin in here, and must not come between an answer and its pages).
    this.resendAck();
    // A grant, or a next game, that waited for this member goes out now, after the answer it follows in the log.
    this.advance();
    this.settleNextGame();
    this.reviewClocks();
  }

  /**
   * A17 step 6 (review, 2026-11-25): a HELLO from somebody the lobby holds a place for. It is that member's own
   * return, and taken, when it carries `proof`: a signature with the row's key over the lobby's code, the player and
   * the envelope's `seq`, and that `seq` is above the last taken from them. It is the signature that says whose
   * HELLO it is; the key in it only says which row is meant. The row stays theirs, with what this HELLO says; the
   * member holds no log, so an open match's log follows whole. False: not such a HELLO; the caller refuses it.
   */
  private returnsByHello(msg: Message<'HELLO'>, row: ParticipantInfo): boolean {
    const p = msg.payload;
    const id = row.playerId;
    if (id === this.localId || p.proof === undefined || p.participant.publicKey !== row.publicKey) return false;
    if (!verifyCanonical(helloProofBody(this.code, id, msg.seq), p.proof, row.publicKey)) return false;
    // 2026-11-25: taken here, and only here: the count goes on (the proof is good once, for a `seq` above the last
    // taken from this member), and the link this HELLO came on is the member's from now.
    if (!this.admit(msg, { keepCount: true })) return false;
    const quiet = this.grace.has(id);
    const timer: TimerHandle | null | undefined = this.grace.get(id);
    if (timer != null) this.s.clock.clearTimeout(timer);
    this.grace.delete(id);
    this.gone.delete(id);
    this.stopCatchUp(id);
    // What the new run of that PC says about itself replaces what the row held; what it has not said yet is not known.
    const i = this.lobby.findIndex((x) => x.playerId === id);
    this.lobby[i] = { ...p.participant };
    this.lobbyGames.set(id, { ...p.game });
    if (p.ballEndReady !== undefined) this.ballEndReady.set(id, p.ballEndReady);
    else this.ballEndReady.delete(id);
    this.stances.set(id, p.stance ?? 'play');
    this.withoutCopy.delete(id);
    this.inOwnGame.delete(id);
    this.changing.delete(id);
    this.setMismatch(id, compareWithPick(this.hostGame, p.game, this.localId));
    this.events.emit('reconnected', { playerId: id, entries: 0, quiet });
    // HELLO_ACK first (it is this member's answer), then the open match's log from entry 0.
    this.resendAck();
    if (this.s.state.phase !== 'lobby') this.sendLog(id, 0, true);
    this.advance();
    this.settleNextGame();
    this.reviewClocks();
    return true;
  }

  /**
   * A17 step 6 (review, 2026-11-25): Leave lobby. The member is out at once: a game they are still playing they give
   * up first (a FORFEIT from this PC in their name; the others carry on), then the row goes, the place is free, and
   * a start they were in is looked at again.
   */
  private memberLeaves(id: PlayerId): void {
    if (!this.isMember(id) || id === this.localId) return;
    const st = this.s.state;
    if (st.phase === 'running' && st.players[id]?.status === 'playing' && !st.pendingTransfer) {
      this.forfeit(id, 'left the lobby');
      const paused = this.s.state.phase === 'running' ? this.s.state.paused : null;
      if (paused?.reason === 'disconnect' && paused.player === id) this.resume();
    }
    this.events.emit('memberLeft', id);
    this.dropMember(id, true);
  }

  /** The hash of the log's head when it is `length` entries long. */
  private hashAt(length: number): string {
    return length <= 0 ? GENESIS_HASH : (this.s.log.at(length - 1)?.hash ?? GENESIS_HASH);
  }

  /**
   * A RECONNECT that is not taken. Nothing this lobby holds about the member it names changes: not the row, not
   * the place, not the counter, not the stance, not the link. The answer goes to the link the frame came on
   * (2026-11-25). When that link is nobody's yet it is closed with the answer, whatever the code: after
   * `unknown_player` (the place is gone) the sender opens a link again with a HELLO and is a newcomer. A link that is
   * the member's own already is closed only when this lobby holds that member as away, and never for
   * `unknown_player`.
   */
  private refuseReconnect(linkFrom: PlayerId, msg: Message<'RECONNECT'>, code: ReconnectCode): void {
    // `stale_seq` says where the counter stands: the member's next RECONNECT is signed over a `seq` above it. The
    // counter is not moved, and nobody without the member's key can use the number.
    const floor = code === 'stale_seq' ? { seqAbove: this.s.lastSeqFrom(msg.from) ?? 0 } : {};
    const no = this.s.build('RECONNECT_ACK', { accept: false, code, entries: [], logHash: GENESIS_HASH, logLength: 0, ...floor }, this.code);
    const candidate = this.candidateOf(msg);
    if (candidate) candidate.refuse(no);
    else this.s.transport.send(linkFrom, no);
    this.events.emit('reconnectRejected', { playerId: msg.from, code });
    if (!candidate && code !== 'unknown_player' && (!this.isMember(msg.from) || this.gone.has(msg.from))) this.s.transport.closePeer?.(linkFrom);
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
      // Each page names the head of the log as it stands at the page's end: what the receiver's head is after it.
      this.s.transport.send(
        member,
        this.s.build('MATCH_LOG', { match: matchId, restart: c.restart, entries: page.map((e) => ({ ...e })), logHash: this.hashAt(c.next), logLength: c.next, more }, this.code),
      );
      c.restart = false;
      if (!more) break;
      if (this.logPageGapMs > 0) {
        c.timer = this.s.clock.setTimeout(this.guarded('a page of the log', () => this.pumpLog(member)), this.logPageGapMs);
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
    // A17 step 6: every change of the lobby is a reason to look at the announced start and at the clocks again.
    if (this.lobbyOn && !this.ended) {
      this.judgeStart();
      this.reviewClocks();
    }
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
        hostTableObjects: this.tableObjects(),
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
    // A17 step 6: this PC is cut off and the player is among those it cannot reach: nobody is paused for it; the
    // game waits here until this PC is back (`setCutOff`).
    if (this.lobbyOn && this.cutOff && this.gone.has(target.player)) return;
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
    this.armBallEndTimer(body.grantSeq);
    // Listeners may act on the grant (e.g. start a transfer), so arm the timer before telling them.
    this.events.emit('grant', body);
  }

  /**
   * The ball-end timeout of the outstanding grant, from now. A17 step 6 (review): not while this PC is cut off: a
   * player whom nobody can hear must not be timed out for it; it is armed again, in full, when this PC is back.
   */
  private armBallEndTimer(grantSeq: number): void {
    this.clearBallEndTimer();
    if (this.lobbyOn && this.cutOff) return;
    this.ballEndTimer = this.s.clock.setTimeout(this.guarded('the ball-end timeout', () => this.onBallEndTimeout(grantSeq)), this.ballEndTimeoutMs);
  }

  /** The wait for LOG_SIGNs before the RESULT goes without them. A17 step 6 (review): not while this PC is cut off. */
  private armLogSignTimer(): void {
    if (this.logSignTimer !== null) this.s.clock.clearTimeout(this.logSignTimer);
    this.logSignTimer = null;
    if (this.lobbyOn && this.cutOff) return;
    this.logSignTimer = this.s.clock.setTimeout(
      this.guarded('the log-sign timeout', () => {
        this.logSignTimer = null;
        this.sendResult();
      }),
      this.logSignTimeoutMs,
    );
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
    this.reviewClocks();
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
    this.reviewClocks();
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
    this.reviewClocks();
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
    this.reviewClocks();
  }

  // ------------------------------------------------------------------------------------------
  // Finishing
  // ------------------------------------------------------------------------------------------

  private finish(): void {
    if (this.finalHead) return;
    this.clearBallEndTimer();
    this.finalHead = this.s.log.head();
    this.events.emit('allGamesEnded', this.finalHead);
    if (!this.maybeSendResult()) this.armLogSignTimer();
  }

  /** A18: a player inside the grace still signs (it is not a disconnect yet); one who is away does not. */
  private expectedSigners(): PlayerId[] {
    // A17 (review): in a lobby a player whose row is gone (the place ran out, or they left) signs nothing more.
    return this.s.state.playerOrder.filter((id) => id !== this.localId && !this.away(id) && this.s.state.players[id]?.connected && (!this.lobbyOn || this.isMember(id)));
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
    const refusal = this.checkReconnect(msg);
    const matchId = this.s.state.matchId ?? this.matchId;
    if (refusal !== null) {
      const code = refusal.code;
      const head = this.s.log.head();
      const no = this.s.build('RECONNECT_ACK', { accept: false, code, entries: [], logHash: head.hash, logLength: head.length }, matchId);
      // 2026-11-25: a RECONNECT that is refused on a link that is nobody's yet changes nothing about the player it
      // names: the answer goes to that link, the link is closed, and the player keeps the link, the count and the
      // state they have (one whose own link did drop is told so by the transport, and the grace runs as for any drop).
      // The one thing that follows is for a frame that carried the player's own signature (`presumeAway`).
      const candidate = this.candidateOf(msg);
      if (candidate) {
        candidate.refuse(no);
        this.events.emit('reconnectRejected', { playerId: msg.from, code });
        if (refusal.itsOwnWord) this.presumeAway(msg.from);
        return;
      }
      this.s.transport.send(linkFrom, no);
      this.events.emit('reconnectRejected', { playerId: msg.from, code });
      this.s.transport.closePeer?.(linkFrom);
      // A participant that cannot resume is disconnected: the usual pause rules apply (A3). A18: with no grace: it
      // will not be back on this log.
      if (this.isParticipant(linkFrom)) this.onPeerLeave(linkFrom, true);
      return;
    }
    // 2026-11-25: the signature is the player's and the head is one this log holds. Only now is the frame's `seq`
    // looked at, and recorded when it is above the last taken from this player; and only now is the link it came on
    // this player's link, in place of the one they had.
    if (!this.admit(msg)) {
      // A candidate that is gone by now gets no answer and changed nothing; a `seq` that is not above the count is
      // answered as for any frame (and a candidate it came on is closed).
      const candidate = this.candidateOf(msg);
      if (candidate?.state === 'refused') return;
      this.reject(msg, 'unexpected_state', `seq ${msg.seq} is not greater than the last accepted from ${msg.from}`);
      if (candidate) this.presumeAway(msg.from);
      return;
    }
    // The head this player is at: a later RECONNECT of theirs does not name a shorter one (`checkReconnect`).
    this.lastHead.set(msg.from, Math.max(this.lastHead.get(msg.from) ?? 0, msg.payload.logLength));
    this.presumed.delete(msg.from);
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
    this.s.transport.send(
      linkFrom,
      this.s.build('RECONNECT_ACK', { accept: true, code: null, entries: entries.map((e) => ({ ...e })), logHash: head.hash, logLength: head.length }, matchId),
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
    // A fresh envelope for each: the receiver drops a frame whose seq is not above the last it took from this host,
    // and the RECONNECT_ACK just went out with a newer one (A10: the payload, signatures and all, is the same).
    for (const r of this.resultMsgs) this.s.transport.send(linkFrom, this.s.build('RESULT', r.payload, matchId));
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

  /**
   * Why a RECONNECT is not taken, or null when it is. `itsOwnWord`: the frame carries the named player's signature
   * over a head that player can be at now, so it is that player's own account of where it is (`presumeAway`).
   *
   * 2026-11-25, on top of the roster, the signature and the head: a RECONNECT never names this host (a host is not a
   * client of itself); and the head it names is not shorter than one the player is known to have been at already,
   * because a participant's log only grows (it is saved at every entry, so a log restored after a restart is not
   * shorter either). Two things say where a player has been: the log itself (`headFloor`: it holds the grant of
   * every ball end that player reported), which a host that took the match over or started again has as well; and
   * the head of that player's last accepted RECONNECT, which this host remembers while it runs (`lastHead`). The
   * same head again is taken: nothing may have been logged between two drops.
   */
  private checkReconnect(msg: Message<'RECONNECT'>): { code: ReconnectCode; itsOwnWord: boolean } | null {
    const st = this.s.state;
    const p = msg.payload;
    const no = (code: ReconnectCode, itsOwnWord = false): { code: ReconnectCode; itsOwnWord: boolean } => ({ code, itsOwnWord });
    if (st.phase === 'lobby' || !st.matchId) return no('match_not_started');
    if (msg.from === this.localId) return no('unknown_player');
    const who = st.participants.find((x) => x.playerId === msg.from);
    if (!who || p.player !== msg.from) return no('unknown_player');
    // A17 step 7 (protocol 7): one signed body for every RECONNECT (`reconnectSignBody`): this host's own id and the
    // envelope's `seq` are under the signature, so a frame written for another PC, or the same payload under another
    // `seq`, does not verify. The body of protocol 2 to 6 is not taken.
    if (!verifyCanonical(reconnectSignBody(st.matchId, this.localId, p.player, st.matchId, p.logHash, p.logLength, msg.seq), p.signature, who.publicKey)) return no('bad_signature');
    // A head the player is past is not where the player is: refused like a head this log does not hold, and it says
    // nothing about the player now.
    if (p.logLength < Math.max(this.headFloor(msg.from), this.lastHead.get(msg.from) ?? 0)) return no('unknown_log_hash');
    const known = p.logLength === 0 ? p.logHash === GENESIS_HASH : this.s.log.at(p.logLength - 1)?.hash === p.logHash;
    return known ? null : no('unknown_log_hash', true);
  }

  /** 2026-11-25: the head each player named in its last accepted RECONNECT, as a log length (`checkReconnect`). */
  private readonly lastHead = new Map<PlayerId, number>();

  /**
   * 2026-11-25: the shortest log `player` can hold, read from the log: the length that takes in the TURN_GRANT of the
   * last ball end that player reported. A client reports a ball end only for a grant it holds in its own log, so its
   * head is never before that entry. 0 for a player who has reported none.
   */
  private headFloor(player: PlayerId): number {
    const grantAt = new Map<number, number>();
    let floor = 0;
    for (const e of this.s.log.entries()) {
      const m = e.message;
      if (!m) continue;
      if (m.type === 'TURN_GRANT') grantAt.set(m.payload.grant.grantSeq, e.index);
      else if (m.type === 'BALL_END' && m.from === player) {
        const at = grantAt.get(m.payload.grantSeq);
        if (at !== undefined) floor = Math.max(floor, at + 1);
      }
    }
    return floor;
  }

  /** 2026-11-25: the players this host took for away on their own word, while their own link has not said otherwise. */
  private readonly presumed = new Set<PlayerId>();

  /**
   * 2026-11-25: a RECONNECT that carried the player's own signature was refused on a new link (a head this log does
   * not hold, or a number that is not above the count). The player has said it is no longer on the link this host
   * holds for it, and its return did not succeed: the ordinary grace starts for it, exactly as for a link the
   * transport reported dropped, so the others are told after the grace even when the old link's close never comes.
   * Only a frame that verified reaches this; a frame that did not changes nothing. Nothing happens for a player who
   * is away already.
   */
  private presumeAway(player: PlayerId): void {
    if (this.gone.has(player)) return;
    this.onPeerLeave(player);
    if (this.gone.has(player)) this.presumed.add(player);
  }

  /**
   * 2026-11-25: a player taken for away by `presumeAway` whose own link then brought a frame under its next number:
   * the link is alive, so the player is not away. Inside the grace nobody was told and nothing is to be undone;
   * after it the player is back as after a return.
   */
  private backOnOwnLink(player: PlayerId): void {
    this.presumed.delete(player);
    if (!this.gone.has(player)) return;
    const timer = this.grace.get(player);
    if (timer !== undefined) {
      this.s.clock.clearTimeout(timer);
      this.grace.delete(player);
    }
    this.gone.delete(player);
    if (timer === undefined) {
      this.events.emit('reconnected', { playerId: player, entries: 0, quiet: false });
      return;
    }
    // A grant, or a next game, that waited for this player's grace goes out now.
    this.advance();
    this.settleNextGame();
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
