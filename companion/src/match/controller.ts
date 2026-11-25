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
 *   added at MATCH_READY. Video only from the player up. A18 (2026-11-24): the match's control link and the media are
 *   different connections (the first goes through the host, and for most matches through ArcAid; voice and video go
 *   straight between the two PCs), so a peer whose control link drops keeps its media connection for as long as that
 *   connection is itself up, and a peer that comes back gets a new one only when the old one is not connected any
 *   more. (Until 0.2.50 the connection was closed at the drop and made again at the return: one second without
 *   ArcAid cost the voice for one to ten seconds, match ECVYGP 2026-11-23.)
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
 *   I11.4.9 (2026-11-20, the first turn starts in 3D): the armed start also waits for the PCs whose 3D connection is
 *   still being made (the host's `stream3dWaiting()`, a client's HELLO_ACK `stream3dWait`; each PC stops waiting by
 *   itself after its own limit, `match/stream3d.ts`), and the lobby line says for whom and for how many seconds at
 *   most. Start match (`holdTabStart`) is held the same way at its first press; a second press starts now. Only the
 *   match's first start: a next game never waits.
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
 * - A16 (2026-11-15, the owner's match LPHDUW of 2026-11-14): the table's own game outlives this player's last ball
 *   (the bonus, the match animation, the high-score initials). The owner's third ball ended at 82,347,460, the table
 *   locked, and the machine's initials prompt could not be answered; his first turn of game 2 unlocked it, he entered
 *   the initials, and that old game's `game_end` was reported as GAME_OVER of game 2 at 93,465,460 after one ball. So:
 *   when this player's last ball of a game is reported while the table's game is still running, that table game is
 *   `spent`: the table stays unlocked until it ends (at most `SPENT_UNLOCK_MS`), whoever is up and across the RESULT
 *   and a NEXT_GAME, and until it ends (its `game_end`, or the next `game_start`) nothing it says is reported:
 *   scores, ball ends and its end belong to the game already finished.
 * - A16.2 (2026-11-15, match NQYJGN on Congo, ROM congo_21, WPC): on that machine the detector's `game_end` comes with
 *   the last ball's end, BEFORE the initials entry, so the A16 window closed at once: the table locked, the headset went
 *   to the other player's picture, and the owner's Grand Champion score was stored with blank initials. So, whenever the
 *   game end arrives: when this player's last ball of a game is reported and the final score has a place on the
 *   machine's high-score list (`highScoreQualifies`, the witness's answer from the ROM's map; no map, no list, not a
 *   ROM table: never), an **initials hold** begins. While it is on the table is unlocked whatever the turn lock says,
 *   `status().initialsHold` keeps the headset on this player's own table (`vrViewMode`), the panel's line asks for the
 *   initials, and the match goes on for everyone else (the next grant is not delayed). It ends when the machine has
 *   written its high-score list and the list has been quiet for `INITIALS_QUIET_MS` (`high_scores_changed`, from a
 *   table whose patch journals those bytes; an entry with this score and no initials yet keeps it on), at a new
 *   `game_start` on the table (handled as ever), when the table closes or the match ends, and at the latest after
 *   `INITIALS_HOLD_CAP_MS`. A16's window runs beside it unchanged on a machine whose game ends after the initials.
 * - A18 (2026-11-24, the owner: "We never want another player's disconnect to cause the active player to have a messed
 *   up session"): the engine no longer pauses for a player who is not up (`host.ts`), and tells of no drop that is over
 *   within its grace. What is left for this controller: a player who is away is flagged on its row (`disconnected`) on
 *   the PCs that know it (the host at once; the others when the match pauses for that player at its own turn), and a
 *   pause never locks, covers or silences the table of the player whose ball is live (the lock was never touched;
 *   D8.14 for the headset; the shell keeps the picture and the table sound going, `main/match-host.ts`).
 * - B26 (2026-11-16, the owner: "a midnight madness happened for Krobs which is a really unfair advantage"; B26.4: "I'd
 *   rather not guess based on clock time. I'd rather check the actual setting where it is enabled and check for the
 *   signal during live play that it actually occurred"): some WPC ROMs start a bonus multiball when the machine's
 *   clock, which VPinMAME takes from the PC, passes midnight during a ball: each player's own LOCAL midnight.
 *   - The flag is a fact: the witness feeds `midnight_madness` when the ROM's own audit of the mode goes up on this
 *     player's table (`witness/midnight.ts`); the ball being played then is flagged: logged, told to every player
 *     (`localAdvisory` / `reportAdvisory`: a PARTICIPANT_UPDATE the host passes on, never logged), shown as a line on
 *     the panel for `MIDNIGHT_LINE_MS` and on the Match tab for the rest of the game (`status().advisories`), and as
 *     a flag on the player's row and result row. A game whose ROM has no such audit is not monitored: no flag, and
 *     nothing is guessed from the clock. A flag only: no score, turn, lock or result reads it.
 *   - The setting: each rig says how the adjustment that enables the mode reads on its own table
 *     (`setLocalMidnightMode`, from the witness; `localMidnightMode` / `reportMidnightMode`), and when it is ON
 *     anywhere every player sees one line (`midnightSettingLine`): on the Match tab from the lobby on, and on the
 *     panel for `MIDNIGHT_LINE_MS` at each game's start. A rig that said nothing is left out, never guessed. Nothing
 *     is written to anyone's NVRAM.
 * - A17 step 7 (2026-11-25, docs/design/alpha-match.md section 11: "a lobby that outlives a match"). When the role is
 *   a lobby's (`HostMatch` / `ClientMatch` made with the `lobby` option, which the companion's shell always sets from
 *   protocol 7 on) this controller lives from Open lobby / Join lobby to Leave / Close, across any number of matches.
 *   With a role whose option is off nothing here behaves differently (every rule above is that mode's). In a lobby:
 *   - **the one source is the lobby as its PC last said it** (`HELLO_ACK`, in every phase: the host's `lobby` event,
 *     a client's `joined` / `roster`): the members with their choices (Play or Watch), who is away, the starter,
 *     the open match, the start that is announced. `participants()` is the members in every phase; the panel's
 *     `players` are the open match's players (the members while none is open).
 *   - **a match's end is "back to the lobby"** (`onMatchEnded`): the scores, the result and what was counted per
 *     game go, the series stays on the panel until the next start, the voice and every connection stay. `seriesOver`
 *     means the LOBBY is over for this PC (it was closed, or its PC did not come back): only then is the voice let
 *     go and every table unlocked for good.
 *   - **a start is asked for, by anyone** (`requestStart`, section 11.4): from the Match tab or the menu, or by a
 *     game the STARTER begins on their own table (`fromTable`). That game is the match's first only when the lobby's
 *     PC announces a start with this player first; anybody else's game on a table, and the starter's when it is
 *     refused, is a game of their own, which the lobby is told (`ownGame`) and a start waits for. What the table
 *     says while the start counts down is kept for the first grant (A18's `heldFeed`).
 *   - **the lock outside a turn** (`lobbyLockWanted`, the table of section 11.2): in the lobby every table is its
 *     owner's; while a start counts down the tables of the people in it are locked, unless a game runs on one;
 *     between games the players of the open match are locked but the starter; during a game a member who is not in
 *     it (a watcher, the lobby's PC that only watches) is locked while it is played, unless a game of their own is
 *     running, and never gets a grant. A player's lock follows the turn as it always did.
 *   - **a member who is not in the game reports nothing** (`myGameOver` from MATCH_READY / NEXT_GAME on): no
 *     GAME_OVER at their table's game end, no FORFEIT when their table closes or they leave.
 *   - **away is not gone** (A18's rule in every phase): a member whose link dropped keeps the voice while that
 *     connection is itself up; the lobby's PC away is said on a client's panel, and nothing closes.
 */
import { tableWords, type PickCopyWord } from './table-identity.js';
import type { GameFingerprint, GrantBody, MidnightMode, ParticipantInfo, PayloadOf, PlayerAdvisory, PlayerId, Stance, TableChange } from '@castcade/protocol';
import type { MatchMedia, MediaSignal, MediaSignalling, PanelState, VrViewMode } from '../media/match-media-types.js';
import type { GameEvent, HighScoreEvent, MidnightEvent } from '../witness/journal-detector.js';
import { midnightLine, midnightSettingLine, possessive } from '../witness/midnight.js';
import type { ClientMatch } from './client.js';
import type { HostMatch, StartAsk } from './host.js';
import type { MatchState } from './state.js';
import { START_WAIT_MS } from './stream3d.js';

/** What a host-side role must offer (structurally a HostMatch; tests may pass the real one). */
export type HostRole = Pick<
  HostMatch,
  'localId' | 'state' | 'log' | 'roster' | 'on' | 'localBallEnd' | 'localState' | 'localGameOver' | 'forfeit' | 'nextGame' | 'nextGameBlocker' | 'nextGamePending' | 'endMatch' | 'startIn' | 'loading' | 'stream3dWaiting' | 'ballEndReadiness' | 'passTurn' | 'passTurnBlocker' | 'localAdvisory' | 'localMidnightMode' | 'midnightModes'
>;
/** What a client-side role must offer (structurally a ClientMatch). */
export type ClientRole = Pick<ClientMatch, 'localId' | 'state' | 'log' | 'on' | 'reportBallEnd' | 'reportState' | 'reportGameOver' | 'forfeit' | 'resume' | 'reportAdvisory' | 'reportMidnightMode'>;
export type MatchRole = HostRole | ClientRole;

/** A17 step 7: what a lobby's role offers beyond a match's (the engines made with the `lobby` option). */
export type LobbyHostRole = HostRole &
  Pick<HostMatch, 'isLobby' | 'requestStart' | 'cancelStart' | 'requestEnd' | 'updateLocal' | 'announcedStart' | 'waitedFor' | 'members' | 'stanceOf' | 'starter' | 'openMatch' | 'table' | 'publicKey' | 'pickTable' | 'tableChanges' | 'tableObjects'>;
export type LobbyClientRole = ClientRole & Pick<ClientMatch, 'isLobby' | 'isJoined' | 'requestStart' | 'cancelStart' | 'requestEnd' | 'updateParticipant' | 'holdsOpenLog' | 'hostAway' | 'pickTable'>;
/** A17 step 7: the role is a lobby's (its engine was made with the `lobby` option). */
export function isLobbyRole(role: MatchRole): boolean {
  return (role as { isLobby?: boolean }).isLobby === true;
}

/** A17 step 7: what is wrong, or special, about a member's row (the Match tab's roster; design section 11.3). */
/**
 * A17 step 10: three more, from where a member's PC says it stands on its way to the lobby's table
 * (`HELLO_ACK.tableChange`): `close_table` (its person has to close the open table), `asked` (it changes tables only
 * when its person says so), `changing` (the open table was asked to close, or the lobby's table is being opened).
 * A PC that waits for a game or its initials says `own_game`.
 */
/** A17 step 10: picks of one member that change nothing are logged this far apart at most (the ones between are counted). */
export const PICK_LOG_GAP_MS = 2_000;

export type LobbyFlag = 'away' | 'loading' | 'no_table' | 'other_table' | 'own_game' | 'close_table' | 'asked' | 'changing';

/** A17 step 7: the lobby as this controller knows it, for the Match tab and the in-game menu. Null without a lobby. */
export interface LobbyStatus {
  /** This member's own choice, as the lobby's PC holds it. */
  stance: Stance;
  /** The one member whose Start on their own table asks for a game; null: nobody can. */
  starter: PlayerId | null;
  /** Every member, the lobby's PC first, then in the order they joined. */
  members: Array<{ id: PlayerId; name: string; rig: ParticipantInfo['rig']; stance: Stance; opener: boolean; me: boolean; starter: boolean; inMatch: boolean; flags: LobbyFlag[]; awaySince: number | null }>;
  /** The match that is open: its id, the game, whether one is being played, and its players. Null: none. */
  match: { id: string; game: number; state: 'game' | 'between'; players: PlayerId[] } | null;
  /**
   * A17 step 10: the lobby's table: its name (null: none is named yet), who picked it, why it cannot be changed now
   * (`off`; null: it can), and whether a change ends the open match (`endsMatch`: asked before the press).
   * `changing`: some member's PC is closing its table or opening the lobby's (the header says CHANGING TABLE); a PC
   *   that waits for its person or for a game says so on its own row, and is not counted here.
   */
  table: { name: string | null; pickedBy: PlayerId | null; pickedByName: string | null; off: string | null; endsMatch: boolean; changing: boolean };
  /**
   * The review of PR 136: what a press about the match is made against: the open match, its game and whether that
   * game is being played ("JHDFEF-2/3/game"; empty: no match). A press carries it, and the main process refuses a
   * press whose subject is not this any more (End match as a game begins must not end that game for everyone).
   */
  gameKey: string;
  /** The start that is announced: counting down (`seconds`) or waiting (`waitsFor`), in one line. Null: none. */
  start: { by: PlayerId; players: PlayerId[]; newMatch: boolean; waitsFor: 'result' | 'tables' | 'other_tables' | 'own_games' | '3d' | null; waitsOn: PlayerId[]; seconds: number | null; line: string } | null;
  /** The start button: its words, the line that says what a press does, and why it cannot be pressed now (null: it can). */
  startButton: { label: 'Start match' | 'Next game'; line: string; off: string | null };
  /** "Start a new match": there while a match is open between games and somebody outside it is set to Play. */
  newMatch: { line: string; warnings: string[] } | null;
  /** While a start waits for people or for 3D: the words of the second press ("Start without Dana"). Null: none. */
  startWithout: string | null;
  /** What End match would end: the open match between games (anyone), or the game being played, for everyone (the lobby's PC only). */
  end: 'match' | 'everyone' | null;
  /** A player of the game being played may give it up. */
  giveUp: boolean;
  /** A client: the lobby's PC is away, since when, and until when this PC goes on trying (null: no limit by time). */
  hostAway: { since: number; until: number | null } | null;
  /** The lobby is over for this PC (it was closed, or its PC did not come back): nothing follows. */
  over: boolean;
}

/** A HostMatch plays through `local*`; a ClientMatch through `report*` (host.ts / client.ts). */
/**
 * A17 step 7: how long after a start's countdown ran out, with the start still announced, the line says it is held.
 * A start that is on its way reaches a member within this (the lobby PC's own timer and one frame).
 */
export const COUNTDOWN_HELD_MS = 1000;

export function isHostRole(role: MatchRole): role is HostRole {
  return typeof (role as Partial<HostRole>).localBallEnd === 'function';
}

export type CueKind = 'your_turn' | 'opponent_turn' | 'match_over';

/**
 * What the witness feeds in: every detector game event, plus `table_exit` when VPX closes, plus (A16.2) the machine
 * writing its high-score list, plus (B26.4) the ROM counting a Midnight Madness.
 */
export type ControllerFeed = GameEvent | { kind: 'table_exit' } | HighScoreEvent | MidnightEvent;

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
  /**
   * A17 step 4 (2026-11-24): for the player who is up, while their ball can be ended by hand (End my ball): the ball
   * and the score it would end at (the last one this table reported, else what the log has for this player). Else null.
   * `grantSeq` (the review of PR 131): the grant the question is about; a confirmation is good for that grant only.
   * `tableBall`: the ball on this table would still be in play (a table Castcade reads the ball ends of, its game
   * running, not this game's last ball): the table then owes that ball's end, see `owedTableEnds`.
   */
  endBall: { grantSeq: number; ball: number; score: number; tableBall: boolean } | null;
  /**
   * A17 step 4 (the review of PR 131): the table ball ends this player's table still owes the match, as the grant of
   * each ball that was ended by hand (End my ball, or the host's Pass the turn) while the table's ball was in play.
   * The shell saves it with the match (`match-resume.json`), so a restart of Castcade does not forget it.
   */
  owedTableEnds: number[];
  /**
   * I11.4.9: in the lobby, the players a start waits for: their PC is still making its 3D connection (the host's
   * list) and their table is open. `armed`: this host's start is held for them (`table`: a game started on its table,
   * and the countdown follows by itself; `tab`: Start match was pressed once: a second press starts now, and the shell
   * starts the match when `players` is empty). `seconds`: what is left of a held start's one limit (0 while none is
   * held): `players` is empty from then on, whatever the PCs say.
   */
  wait3d: { players: PlayerId[]; seconds: number; armed: 'table' | 'tab' | null };
  /**
   * A16.2: this player's finished game made the machine's high-score list and the table is held for the initials:
   * unlocked, and the headset stays on this player's own table (`vrViewMode`'s `initialsHold`).
   */
  initialsHold: boolean;
  /**
   * B26: the Midnight Madness lines, for the Match tab. First, in any phase, the setting when it is ON on a table
   * (`midnightSettingLine`; B26.4); then one line per ball of the current game the mode ran on (`midnightLine`),
   * oldest first, this player's own and the others'. The panel shows the setting for `MIDNIGHT_LINE_MS` at each
   * game's start, the newest flagged ball for as long, and keeps the flag on the player's row.
   */
  advisories: string[];
  /** A17 step 7: the lobby (members, choices, the starter, the open match, the announced start); null when the role is no lobby's. */
  lobby: LobbyStatus | null;
  /**
   * A17 step 7: a game the match does not own is running on this player's table, as the lobby was told (design
   * 11.3). While a game of the match is played the shell leaves this PC its own table, view and sound until it ends.
   */
  ownGame: boolean;
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
  /** I11.4.9: the longest a start is held for the 3D connections, in all. Default `START_WAIT_MS` (45 s). */
  start3dHoldMs?: number;
  /** A12 (2026-11-05): the host's table in the lobby: free play (default) or locked until the lobby is complete. */
  preMatchPlay?: PreMatchPlay;
  /** A12: a game is already running on this player's table when the controller is made (the witness's live game). */
  tableGameRunning?: boolean;
  /**
   * A15: the role was rebuilt from a saved log in the middle of a match (Castcade restarted): the controller takes
   * the phase, the roster, the scores and who is up from the role's state instead of waiting for MATCH_READY.
   */
  resumed?: boolean;
  /** A17 step 4 (the review of PR 131): with `resumed`: `owedTableEnds` as the saved match had it. */
  owedTableEnds?: readonly number[];
  /**
   * A16.2: does this final score have a place on the high-score list of the machine on this player's table (the
   * witness: the ROM's map over the journal's NVRAM)? Asked once, when this player's last ball of a game is reported.
   * Absent, or false: no initials hold.
   */
  highScoreQualifies?: (score: number) => boolean;
  /**
   * A17 step 7: a sentence of the lobby's for this player (the answer to something they asked: a start that was
   * refused, a start that was taken away). It is on the panel's line for a while; the shell keeps it for the Match tab.
   */
  onNotice?: (sentence: string) => void;
  /** A17 step 7: this player's choice when the controller is made (match.json `stance`); the lobby's word replaces it. */
  stance?: Stance;
}

/**
 * I11.4.9: the lobby line without the seconds of a held start ("..., or in 31 s (Start match ..."): what the headset's
 * lobby peek compares (D8.9), so the number alone never counts as a change of the line.
 */
export function lobbyLineKey(message: string | null): string | null {
  return message === null ? null : message.replace(/, or in \d+ s \(/, ' (');
}

/**
 * I11.4.15 (2026-11-24; it replaces I11.4.11's `FILES_DIFFER_COST`, which said "not in 3D" whenever the bytes
 * differed): what the lobby's table line adds, before the start, to "same table, different file" / "different table
 * file" on a PC that shows every other player in 3D: the 3D view needs the same table objects, not the same bytes.
 */
export const FILES_GIVE_3D = '3D works all the same: the files hold the same table objects';
/**
 * I11.4.15: the lobby's note on a PC whose table and another player's are known not to hold the same table objects
 * (both run the Castcade VPX build and name different tables, or the host said its table's objects and this PC's copy
 * has others): said before the start, with who it is about (`who`: their names, or null for the host of a joining PC).
 */
export const tableObjectsNote = (who: readonly string[] | null): string =>
  `Not in 3D with ${who && who.length > 0 ? who.join(', ') : 'the host'}: the two table files do not hold the same table objects, so their turns are shown as the flat video`;
/**
 * I11.4.12 (2026-11-21): the lobby's note on a PC that has the Castcade VPX build, with a table open that is not
 * running in it: opened by hand, open before the match, left from a 3D watch session, started while 3D watch was
 * off. What it says is true in each of those.
 */
export const TABLE_BY_HAND_NOTE = 'Not in 3D: this table is not running in the Castcade VPX build. For 3D it has to be started again by Castcade: close VPX, then host or join again';
/** I11.4.12: Castcade itself tried the Castcade VPX build for this match's table and it did not start: nothing the player can do by starting it again. */
export const TABLE_FORK_FAILED_NOTE = 'Not in 3D on this PC for this match: the Castcade VPX build did not start (the log has the reason)';

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

/** A16: how long a table whose game outlives this player's last ball stays unlocked for the machine's own ending. */
export const SPENT_UNLOCK_MS = 180_000;
/** A16.2: the longest an initials hold lasts (a table whose patch does not journal the high-score bytes has only this). */
export const INITIALS_HOLD_CAP_MS = 90_000;
/** A16.2: how long the machine's high-score list must stay unchanged after a write before the hold ends. */
export const INITIALS_QUIET_MS = 5_000;
/** A16.2: the panel / Match tab line during an initials hold. */
export const INITIALS_HOLD_MESSAGE = "Your score is on this table's high-score list: enter your initials on the table";
/**
 * B26: how long the panel's line shows a new Midnight Madness flag (the row's flag and the Match tab's line stay), and
 * (B26.4) the setting line at each game's start.
 */
export const MIDNIGHT_LINE_MS = 20_000;
/** B26: at most this many flagged balls are kept (a match is 2–4 players, a few balls each, a few games). */
const MIDNIGHT_KEEP = 64;
/** A17 step 7: how long a sentence of the lobby's stays on the panel's line (`flash`). */
export const NOTICE_MS = 12_000;
/** A17 step 7 (design 11.9): how long the lobby's line says how the last match ended. */
export const MATCH_OVER_LINE_MS = 20_000;
/** A17 step 7: how long a client's game started on its table waits for the lobby's word before it counts as a game of one's own. */
export const TABLE_ASK_WAIT_MS = 5_000;
/** A10: the prompt for the player whose first ball of a game it is. */
const PRESS_START_MESSAGE = 'Press Start on the table to begin your game';
/**
 * A17 step 8 (2026-11-26, the review of PR 138): the game this player gave up (or was counted out of) is still
 * running on their table. Its balls count for nothing; the table is theirs to play it out; and a new game on the
 * table begins only when it is over. What to do, said on that PC: in a turn of the next game (`GIVEN_UP_AT_TURN`),
 * and before it (`GIVEN_UP_WAIT`).
 */
export const GIVEN_UP_AT_TURN = 'The game you gave up is still on your table: play it out (it counts for nothing) or restart the table, then press Start: your ball begins with the new game';
export const GIVEN_UP_WAIT = 'The game you gave up is still on your table, which is yours meanwhile: play it out (it counts for nothing) or restart the table. The next game waits for it';
/** A17 step 7: what a member asks the lobby's PC for; its REJECT carries a sentence for the asker. */
const LOBBY_REQUESTS: ReadonlySet<string> = new Set(['START_REQUEST', 'START_CANCEL', 'END_REQUEST', 'TABLE_PICK', 'LEAVE_LOBBY']);
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
 * the lobby, a pause (someone dropped: the panel says why; not over this player's own live ball, D8.14 below), the gap
 * between grants and the result → the panel.
 * D8.9 / D8.10 (2026-11-14): `now.menuOpen` → the panel (the menu is drawn on it); `now.lobbyQuiet` (the match host:
 * this table is free to play and the lobby has said nothing new for a few seconds) → nothing over the table.
 * A16.2 (2026-11-15): `now.initialsHold` (this player is entering high-score initials on their own table) → what they
 * see on their own ball, whoever is up and in any phase (the result included): never the other player's picture.
 * D8.14 (2026-11-23, the owner in match ECVYGP: ArcAid dropped the match for one second during his ball, the host
 * paused for Krobs, and the panel stood over his playfield for 2.3 s): a pause while this player's own ball is in play
 * (`ball` not null: the table stays unlocked through a pause, so the ball is live) changes nothing over the table. The
 * scoreboard beside it says `PAUSED` (`scoreboard-page.ts`); the panel and its reason come when the ball has ended.
 * A17 step 4 (2026-11-24, alpha-match.md §11.6): the same for the people watching. `now.upAway`: the match is paused
 * for the player who is up (their link to the host dropped past the grace; `pausedFor`), their ball is still in play
 * and their picture still arrives on this PC (the shell reads that: the native video's frames, the page's video
 * track, a 3D watch that runs). Then a watcher keeps what `spectate` says, as while playing: that player is playing
 * on, and the media never crossed the host. The scoreboard says who is away. When the picture stops, the panel comes.
 */
export function vrViewMode(
  p: Pick<PanelState, 'phase' | 'myTurn' | 'playerUp'> & { ball?: number | null; pausedFor?: PlayerId | null },
  settings: VrViewSettings = DEFAULT_VR_VIEW,
  now: { menuOpen?: boolean; lobbyQuiet?: boolean; initialsHold?: boolean; upAway?: boolean } = {},
): VrViewMode {
  // D8.10: the in-game menu is on the panel, whatever the turn. D8.9: a lobby with nothing new to say stays out of
  // the way of a player whose table is free to play.
  if (now.menuOpen) return 'panel';
  if (now.initialsHold) return settings.theaterDuringMyTurn;
  if (p.phase === 'idle' && now.lobbyQuiet) return 'hidden';
  // D8.14: a caller that gives no `ball` (undefined) is read as a ball in play.
  if (p.phase === 'paused' && p.myTurn && p.ball !== null) return settings.theaterDuringMyTurn;
  if (now.upAway && pausedForPlayerUp(p)) return settings.spectate;
  if (p.phase !== 'playing') return 'panel';
  if (p.myTurn) return settings.theaterDuringMyTurn;
  return p.playerUp !== null ? settings.spectate : 'panel';
}

/**
 * A17 step 4: this PC watches, and the match is paused for the player who is up while their ball is in play: the one
 * pause that says nothing about what this PC is shown (`vrViewMode`'s `upAway`, the shell's 3D watch).
 */
export function pausedForPlayerUp(p: Pick<PanelState, 'phase' | 'myTurn' | 'playerUp'> & { ball?: number | null; pausedFor?: PlayerId | null }): boolean {
  return p.phase === 'paused' && !p.myTurn && p.playerUp !== null && p.pausedFor === p.playerUp && p.ball !== null;
}

/**
 * A17 step 4 (the review of PR 131): the panel's line at this player's turn while a ball they ended by hand (or the
 * host passed) is still on their table: it is played out first, its points count, and its end reports nothing.
 */
export function owedBallLine(owed: number, ball: number): string {
  return owed === 1 ? `Your last ball is still on the table: play it out, then ball ${ball} begins` : `Your last ${owed} balls are still on the table: play them out, then ball ${ball} begins`;
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
  /** What the lock rules ask for; `locked` is that, minus the A16 window (`spentUnlock`) and the A16.2 initials hold. */
  private wantLocked = false;
  /** A16.2: the table is held for this player's high-score initials (unlocked, the headset on their own table). */
  private initialsHold = false;
  /** A16.2: the score the hold is for, its cap timer, and the quiet timer after the machine's last high-score write. */
  private holdScore = 0;
  private holdCapTimer: unknown = null;
  private holdQuietTimer: unknown = null;
  private holdEntries: HighScoreEvent['entries'] = [];
  private holdWaitLogged = false;
  /** A16: the table's running game is the one this player already finished; nothing it says is reported. */
  private spentTableGame = false;
  /** A17 step 8: the spent table game is one this player gave up (or was counted out of), not one they finished; and they let a start go on with it still running. */
  private givenUp = false;
  private givenUpReleased = false;
  /** A16: the table is held unlocked for that game's ending (initials); ends with the game or the timer. */
  private spentUnlock = false;
  private spentTimer: unknown = null;
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
  /** A17 step 7 (design 11.9, "AWAY 0:42"): since when this PC has known each member who is away to be away (its own clock). */
  private readonly awayAt = new Map<PlayerId, number>();
  /** A18: players in `left` whose media connection was closed too, because it was not up any more: made again at their return. */
  private readonly mediaClosed = new Set<PlayerId>();
  /**
   * A17 (2026-11-24): the voice from the join on. `voiceWanted`: the players this PC should hold a media connection
   * to (the lobby's roster while there is a lobby; the match's players after); `voiceHeld`: the ones the media layer
   * was told to open. Only the difference is ever sent (`syncVoice`), so naming a player again at MATCH_READY, at the
   * next game or at a reconnect opens and closes nothing.
   */
  /**
   * A17 step 4 (the review of PR 131; the lead's rule: the table's game and the match stay in step, and the player
   * plays every table ball exactly once). A ball ended by hand while the table's ball is still in play leaves the
   * table one ball end behind the match. Each such end is noted here by its grant; the table's next ball end is that
   * old ball's and is swallowed (nothing reported, whenever it comes: during another player's turn or after this
   * player's next grant), and only the one after it ends the player's next ball. Two ends by hand with no drain
   * between owe two. An old ball that ends with an extra ball is still the old ball: swallowed, and still owed.
   * Nothing is owed on a table whose ball ends Castcade cannot read (none will ever come: the witness's word,
   * `localBallEnds`), with no game running on the table, or on the game's last ball (A16: the rest of that table
   * game is not the match's). Cleared with the table's game (`game_start`, `game_end`, `game_abandoned`,
   * `table_exit`) and at the next game.
   */
  private owedSeqs: number[] = [];
  /** `owedSeqs` came from a saved match and has not been checked against the log yet (`settleOwed`). */
  private owedFromRecord = false;
  /**
   * The review of PR 131: the ball end this client reported and the host has not answered yet (no echo in the log,
   * no pass, no refusal). Two things hang on it. Finding 5: when it was made by hand and the grant for that same ball
   * comes again under a new number (the report went into a dead link and the host issued the grant again), it is sent
   * for the new grant, once; a table-made end is recovered by the table's own events, one made by hand has none
   * behind it. And a Pass the turn for that ball owes nothing new: this PC had ended the ball already.
   */
  private unansweredEnd: { grantSeq: number; game: number; ball: number; score: number; byHand: boolean; again: boolean } | null = null;
  /** `feed`'s answer for the event being fed: a ball end the match will never take (see `feed`). */
  private droppedEnd = false;
  private voiceWanted = new Set<PlayerId>();
  private readonly voiceHeld = new Set<PlayerId>();
  /** A17: the media layer has attached (or failed to): peers can be given to it. */
  private mediaReady = false;
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
  /**
   * A18: the host's `game_start` asked for the next game and the engine holds it for a player whose link dropped a
   * moment ago (`HostMatch.nextGame`): when it starts, this host's own game is the one already running on its table.
   */
  private heldTableStart = false;
  /**
   * A18: what the host's table said of that game while its start was held (scores, a ball end): fed again at the
   * game's first grant, so a ball that drained inside those seconds is this host's ball 1 and not a ball the match
   * never heard of (the table would be one ball ahead of the match for the rest of the game).
   */
  private heldFeed: ControllerFeed[] = [];
  /** A11: the lobby start countdown (local deadline and tick timer), and a start from the table waiting for a table. */
  private countdownEnd: number | null = null;
  private countdownTimer: unknown = null;
  private startArmed = false;
  /** A11: lobby players whose table is not open (the host's `loading()`, a client's last HELLO_ACK). */
  private loadingIds: PlayerId[] = [];
  /**
   * I11.4.9: lobby players whose 3D connection is still being made (the host's `stream3dWaiting()`, a client's last
   * HELLO_ACK), and the timer that keeps a held start's seconds on the panel.
   */
  private wait3d: PlayerId[] = [];
  private wait3dTimer: unknown = null;
  /**
   * I11.4.9: when a start was first held for the 3D connections, plus the one limit: from then on nobody is waited
   * for, whatever any PC says (a late joiner, a PC that keeps asking for more). Null: no start is held.
   */
  private holdUntil: number | null = null;
  private holdTimer: unknown = null;
  /** I11.4.9: a held Start match was given up in this lobby (`dropTabHold`): the host has waited once, the next press starts. */
  private tabHoldSpent = false;
  /** I11.4.12: one more thing the lobby line says (the shell's: a table that Castcade did not start gets no 3D); null: nothing. */
  private lobbyNote: string | null = null;
  /** I11.4.15: 3D works on this PC with every other player (the shell's word): the lobby's table line then says a different file costs nothing there. */
  private files3d = false;
  /** I11.4.9: what the armed start from the table was last said to wait for (one log line per reason). */
  private armedFor: 'tables' | '3d' | null = null;
  /** I11.4.9: Start match was pressed while a 3D connection was being made: the shell starts when it settles. */
  private tabArmed = false;
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
  /** B26: the balls Midnight Madness ran on, by this player's own table (the ROM's audit) and the others' advisories. */
  private midnight: Array<{ player: PlayerId; game: number; ball: number }> = [];
  /** B26: the newest flag's line on the panel until `until` (`MIDNIGHT_LINE_MS`), and the timer that takes it off. */
  private midnightShown: { line: string; until: number } | null = null;
  private midnightTimer: unknown = null;
  /** B26.4: how the Midnight Madness setting reads on the other players' tables (the host's engine, HELLO_ACK, an update). */
  private midnightModes = new Map<PlayerId, MidnightMode>();
  /** B26.4: this player's own table, from the witness; null until it could be read. What was last sent of it. */
  private localMidnightMode: MidnightMode | null = null;
  private midnightModeSent: string | null = null;
  /** B26.4: the setting line is on the panel until then (each game's start), and the timer that takes it off. */
  private midnightSettingUntil = 0;
  private midnightSettingTimer: unknown = null;
  // ---- A17 step 7: the lobby (the file header) ----
  /** The role is a lobby's: this controller lives across matches. */
  private readonly lobbyOn: boolean;
  /** The lobby as its PC last said it (HELLO_ACK); null before the first one. */
  private ack: PayloadOf<'HELLO_ACK'> | null = null;
  /** This member's choice until the lobby's PC says what it holds. */
  private myStance: Stance;
  /**
   * A game began on this table and asked for a start (`fromTable`): `asked` while the lobby's word is waited for,
   * `match` once a start is announced with this player first (the game is the match's first), `none` otherwise.
   */
  private tableAsk: 'none' | 'asked' | 'match' = 'none';
  private tableAskTimer: unknown = null;
  /** The lobby was told that a game the match does not own runs on this table (`ownGame`). */
  private ownGameSaid = false;
  /** A17 step 10: where this PC stands on its way to the lobby's table, as the lobby was last told, and the sentence for its own panel. */
  private tableChangeSaid: TableChange | null = null;
  private tableChangeLine: string | null = null;
  /** A17 step 10: what the lobby was last told about this PC's open table being its copy of the lobby's table; undefined: nothing yet. */
  private pickCopySaid: string | undefined;
  /** A17 step 10: when a pick by each member was last logged on the lobby's PC, and how many since were not (`PICK_LOG_GAP_MS`). */
  private readonly pickLogged = new Map<PlayerId, { at: number; more: number }>();
  /** A client: its link to the lobby's PC has been down for longer than the grace. */
  private hostIsAway = false;
  private hostAwayTimer: unknown = null;
  /** How the last match ended, on the lobby's line until `until`. */
  private matchOver: { line: string; until: number } | null = null;
  private matchOverTimer: unknown = null;
  /** The sentence on the panel's line (`flash`) and the timer that takes it off. */
  private notice: string | null = null;
  private noticeTimer: unknown = null;
  /** The lock file may not be what this controller believes (a Castcade that started again): the next word is written whatever it is. */
  private lockStale = false;

  constructor(opts: MatchControllerOptions) {
    this.opts = opts;
    this.role = opts.role;
    this.localId = opts.localId;
    this.settleMs = opts.ballEndSettleMs ?? DEFAULT_SETTLE_MS;
    this.stateIntervalMs = opts.stateIntervalMs ?? DEFAULT_STATE_INTERVAL_MS;
    this.tableGameRunning = opts.tableGameRunning ?? false;
    this.preMatchPlay = opts.preMatchPlay ?? 'free';
    this.lobbyOn = isLobbyRole(opts.role);
    this.myStance = opts.stance ?? 'play';
    // A17 step 7: a Castcade that started again finds the lock file as the last run left it.
    this.lockStale = this.lobbyOn && opts.resumed === true;
    this.bind(opts.role);
    if (opts.resumed && opts.role.state.phase !== 'lobby') this.restore();
  }

  /**
   * A15: a match picked up again after a restart. Everything the log knows is taken from it. The table keeps its keys
   * only while the outstanding grant is this player's (locking in the middle of a ball would drain it): the engine
   * confirms that grant after the reconnect (`myTurn`, or the host's own re-issue), and any other answer locks.
   */
  private restore(): void {
    const st = this.role.state;
    this.hostId = st.hostId ?? this.hostId;
    // A17 step 8: in a lobby the people are its members (the lobby's own word, which `bind` has taken already), not
    // the roster of the match that is picked up.
    if (!this.lobbyOn) this.lobby = st.participants.map((p) => ({ ...p }));
    for (const p of Object.values(st.players)) if (p.score > 0 || p.ballsPlayed > 0) this.scores.set(p.playerId, p.score);
    const me = st.players[this.localId];
    this.myBallsDone = me?.ballsPlayed ?? 0;
    this.myScore = me && (me.score > 0 || me.ballsPlayed > 0) ? me.score : null;
    this.myGameOver = me === undefined || me.status !== 'playing';
    this.tableStarted = true;
    const g = st.currentGrant?.grant ?? null;
    this.upPlayer = g?.player ?? null;
    this.upBall = g?.ballNumber ?? null;
    const mine = st.phase === 'running' && g?.player === this.localId;
    if (st.phase === 'ended') this.phase = 'over';
    else this.phase = st.paused ? 'paused' : 'playing';
    // Forced either way: the lock file is whatever the last run left.
    this.locked = mine;
    // A17 step 8: in a lobby the table of anybody who is not on their own ball is what the lobby's rule says (a
    // watcher, the starter between games, a game of one's own), as after any return (`relock`).
    const lobbyWants = this.lobbyOn ? this.lobbyLockWanted() : null;
    this.setLocked(lobbyWants ?? (!mine && !(st.phase === 'ended' && isHostRole(this.role))));
    // The review of PR 131: what the table still owed when Castcade closed; checked against the log at its first use,
    // which is after the host's answer has been merged (`settleOwed`).
    this.owedSeqs = [...(this.opts.owedTableEnds ?? [])].filter((n) => Number.isSafeInteger(n) && n > 0).slice(0, 16);
    this.owedFromRecord = this.owedSeqs.length > 0;
    // A17: this process is new, so every connection is (the others take its offer on a fresh one, D2.7).
    this.wantVoice((this.lobbyOn ? this.lobby : st.participants).map((p) => p.playerId));
    void this.ensureAttached();
    this.opts.log(`match: picked up again from the saved log: game ${this.gameNumber()}, ${this.phase}${g ? `, ${g.player === this.localId ? 'my' : `${this.nameOf(g.player)}'s`} ball ${g.ballNumber}` : ''}`);
  }

  /**
   * I11.4.12: a note of the shell's for the lobby line, on the Match tab and the panel alike (null takes it away). It
   * does not change by itself, so the headset's lobby panel shows it once, for its peek (D8.9).
   */
  setLobbyNote(note: string | null): void {
    if (this.closed || note === this.lobbyNote) return;
    this.lobbyNote = note;
    this.push();
  }

  /**
   * I11.4.15 (it was I11.4.11's `set3dInPlay`): whether this PC shows every other player in 3D (its VPX and theirs
   * are the Castcade build and name the same table objects). The lobby's table line then says, beside "different
   * file", that 3D is not lost by it. A PC that is known not to get 3D for its table is told by the shell's lobby note
   * (`tableObjectsNote`), and while nothing is known the line says nothing of 3D: I11.4.11 warned whenever the bytes
   * differed, and on the match night of 2026-11-23 it was wrong for two tables of two.
   */
  setFilesGive3d(on: boolean): void {
    if (this.closed || on === this.files3d) return;
    this.files3d = on;
    this.push();
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
      // A17 step 7: in a lobby every start is checked, the next game's too.
      startWarnings: this.phase === 'lobby' || (this.lobbyOn && this.phase === 'over') ? this.unreadableLines() : [],
      pass: this.passInfo(),
      endBall: this.endBallInfo(),
      owedTableEnds: [...this.owedSeqs],
      wait3d: this.wait3dStatus(),
      initialsHold: this.initialsHold,
      advisories: this.advisoryLines(),
      lobby: this.lobbyStatus(),
      ownGame: this.ownGameSaid,
      panel: this.panel(),
    };
  }

  // ------------------------------------------------------------------------------------------
  // I11.4.9: the first start waits for the 3D connections
  // ------------------------------------------------------------------------------------------

  private holdMs(): number {
    return this.opts.start3dHoldMs ?? START_WAIT_MS;
  }

  /**
   * Who a start waits for now: the players the host lists, still in the lobby, whose table is open (one that is still
   * loading is the table wait's to hold a start from the table, and never holds a press of Start match). Nobody once a
   * held start has reached its limit. `seconds`: what is left of that limit while a start is held, else 0.
   */
  private wait3dNow(): { ids: PlayerId[]; seconds: number } {
    if (this.phase !== 'lobby') return { ids: [], seconds: 0 };
    const now = this.opts.now();
    if (this.holdUntil !== null && now >= this.holdUntil) return { ids: [], seconds: 0 };
    const ids = this.wait3d.filter((id) => this.participants().some((p) => p.playerId === id) && !this.loadingIds.includes(id));
    return { ids, seconds: this.holdUntil !== null && ids.length > 0 ? Math.max(0, Math.ceil((this.holdUntil - now) / 1000)) : 0 };
  }

  private wait3dStatus(): ControllerStatus['wait3d'] {
    // A17 step 7: in a lobby the start waits inside the engine (`HELLO_ACK.start`, `waitsFor: '3d'`) and begins by
    // itself: nothing is armed here for the shell to start. Who is waited for, and for how long, is still said.
    if (this.lobbyOn) {
      const s = this.ack?.start ?? null;
      const held = s !== null && s.waitsFor === '3d';
      const noGame = this.phase === 'lobby' || this.phase === 'over';
      const making = noGame ? this.wait3d.filter((id) => this.lobby.some((m) => m.playerId === id) && !this.loadingIds.includes(id)) : [];
      return { players: making, seconds: held && s.leftMs !== null ? Math.ceil(s.leftMs / 1000) : 0, armed: null };
    }
    const w = this.wait3dNow();
    const host = isHostRole(this.role);
    return { players: w.ids, seconds: w.seconds, armed: !host || this.phase !== 'lobby' ? null : this.tabArmed ? 'tab' : this.startArmed && this.armedFor === '3d' ? 'table' : null };
  }

  /** "the 3D connection to Krobs" (the others that are waited for), or this PC's own when it is the only one. */
  private wait3dWords(ids: readonly PlayerId[]): string {
    const others = ids.filter((id) => id !== this.localId).map((id) => this.nameOf(id));
    return others.length > 0 ? `the 3D connection to ${others.join(', ')}` : "this PC's 3D connection";
  }

  /** The host's list, or a client's last HELLO_ACK: whose 3D connection is still being made. */
  private noteWait3d(list: ReadonlyArray<{ playerId: PlayerId }>): void {
    this.wait3d = list.map((x) => x.playerId);
  }

  /**
   * A start is held for the 3D connections from now (nothing new when one is held already: a second kind of start,
   * a PC that joins or asks again, all count toward the same moment). At the limit the start goes on by itself.
   */
  private beginHold(): void {
    if (this.holdUntil !== null) return;
    this.holdUntil = this.opts.now() + this.holdMs();
    this.holdTimer = this.opts.setTimeout(() => this.holdDue(), this.holdMs());
    if (this.wait3dTimer === null) this.wait3dTimer = this.opts.setTimeout(() => this.tickWait3d(), 1000);
  }

  private holdDue(): void {
    this.holdTimer = null;
    const r = this.role;
    if (this.closed || this.phase !== 'lobby' || this.holdUntil === null || !isHostRole(r)) return;
    const still = this.wait3d.filter((id) => this.participants().some((p) => p.playerId === id)).map((id) => (id === this.localId ? 'this PC' : this.nameOf(id)));
    // What happens now, said as it is: a start from the table goes on, unless a table stands in its way; a held Start
    // match comes due, and the shell starts it or gives it up (it logs which).
    this.noteLoading(r.loading());
    const loading = this.loadingIds.map((id) => (id === this.localId ? 'your' : `${this.nameOf(id)}'s`));
    const what: string[] = [];
    if (this.startArmed) {
      what.push(
        loading.length > 0
          ? `the start from the table now waits for ${loading.join(', ')} table${loading.length > 1 ? 's' : ''} to open`
          : this.unreadableIds().length > 0
            ? 'the start from the table does not go on: a table cannot report ball ends'
            : 'the start from the table goes on, and the first turn may be the 2D video',
      );
    }
    if (this.tabArmed) what.push('the held Start match comes due');
    this.opts.log(`match: ${Math.round(this.holdMs() / 1000)} s passed since the start was held for the 3D connections${still.length > 0 ? ` (still being made: ${still.join(', ')})` : ''}; ${what.join('; ') || 'nothing is held any more'}`);
    if (this.startArmed) this.tryStartFromTable(r, false);
    this.push();
  }

  private endHold(): void {
    if (this.holdTimer !== null) this.opts.clearTimeout(this.holdTimer);
    this.holdTimer = null;
    this.holdUntil = null;
    if (this.wait3dTimer !== null) this.opts.clearTimeout(this.wait3dTimer);
    this.wait3dTimer = null;
  }

  /** The seconds of a held start count down on the lobby line (nothing ticks while no start is held). */
  private tickWait3d(): void {
    this.wait3dTimer = null;
    if (this.closed || this.phase !== 'lobby' || this.holdUntil === null || this.opts.now() >= this.holdUntil) return;
    this.push();
    this.wait3dTimer = this.opts.setTimeout(() => this.tickWait3d(), 1000);
  }

  private clearWait3d(): void {
    this.endHold();
    this.wait3d = [];
    this.tabArmed = false;
    this.tabHoldSpent = false;
    this.armedFor = null;
  }

  /**
   * I11.4.9: the host pressed Start match (the Match tab, the in-game menu). True: a 3D connection is still being
   * made and this is the first press: the start is held until it settles or the limit is reached (the shell then
   * starts; `status().wait3d`), and the lobby line says a second press starts now. False: the caller starts the match
   * now: nothing to wait for, or this is that second press, or a start from the table is already held for the 3D
   * connections (its lobby line says Start match starts it now), or somebody's table is still loading (a press then
   * is what it was before this wait existed), or a held press was already given up in this lobby (`dropTabHold`).
   */
  holdTabStart(): boolean {
    const r = this.role;
    if (this.closed || !isHostRole(r) || this.phase !== 'lobby' || this.tabArmed) return false;
    if (this.startArmed && this.armedFor === '3d') {
      this.opts.log('match: Start match was pressed while the start from the table waited for the 3D connections; the match starts now');
      return false;
    }
    this.noteLoading(r.loading());
    // A press while somebody's table is still loading is never held: it goes the way it went before there was a wait
    // (with three or more players the hold would sit there with nothing on the panel saying so, then end in an error).
    if (this.loadingIds.length > 0) return false;
    // A hold that was given up in this lobby is not taken again: the host has waited once.
    if (this.tabHoldSpent) return false;
    this.noteWait3d(r.stream3dWaiting());
    const w = this.wait3dNow();
    if (w.ids.length === 0 || this.participants().length < 2) return false;
    this.tabArmed = true;
    this.beginHold();
    this.opts.log(`match: Start match was pressed; the match starts once ${this.wait3dWords(w.ids)} is up, ${this.wait3dNow().seconds} s at most (Start match again starts it now)`);
    this.push();
    return true;
  }

  /**
   * I11.4.9: the shell gives up a held Start match (it came due and the start cannot simply go on: a table that cannot
   * report ball ends, a table still loading, a start that failed). The host has waited once: the next press in this
   * lobby is not held again (it starts, or asks for the confirmation a press asks for).
   */
  dropTabHold(why: string): void {
    if (!this.tabArmed) return;
    this.tabArmed = false;
    this.tabHoldSpent = true;
    if (!this.startArmed) this.endHold();
    this.opts.log(`match: the held Start match is off: ${why}; the next press of Start match is not held`);
    this.push();
  }

  private gameNumber(): number {
    return Math.max(1, this.role.state.gameNumber);
  }

  /** A10: for the host's Next game button: why not now, or null. A client is never the one to start it. */
  private nextGameBlocker(): string | null {
    const r = this.role;
    // A17 step 7: in a lobby anyone asks, and the lobby's PC answers with the start or with a sentence.
    if (this.lobbyOn) return this.seriesOver ? 'the lobby is closed' : null;
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
    // A18: held for a player inside the engine's grace: the panel says so until it starts or is called off.
    if (ok && r.nextGamePending) this.push();
    return ok;
  }

  /** A18: this host asked for the next game and the engine holds it for a player whose link dropped a moment ago. */
  get nextGameHeld(): boolean {
    const r = this.role;
    return !this.closed && isHostRole(r) && r.nextGamePending;
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
    // The review of PR 131: a table whose ball ends are not read owes none: none will ever come.
    if (ready === false) this.clearOwed();
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
    // A17 step 7: in a lobby a start is checked for the people who would play it; a watcher's table holds nothing up.
    const ids = this.lobbyOn ? this.wouldPlay(this.ack?.match?.state === 'between') : this.participants().map((p) => p.playerId);
    return this.unreadableAmong(ids);
  }

  private unreadableAmong(ids: readonly PlayerId[]): PlayerId[] {
    return ids.filter((id) => this.readyOf(id) === false && !((this.phase === 'lobby' || this.lobbyOn) && this.loadingIds.includes(id)));
  }

  /** `ids`: the review of PR 136: the players of a start other than the next game's (a new match: everyone set to Play). */
  private unreadableLines(ids: readonly PlayerId[] = this.unreadableIds()): string[] {
    return ids.map((id) =>
      id === this.localId
        ? `Your table cannot report ball ends: ${this.localBallEndsReason ?? 'Castcade is not reading its score (not patched, or an original table)'}`
        : `${this.nameOf(id)}'s table cannot report ball ends: it is not patched, an original table, or a machine whose ball ends cannot be read`,
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

  /** A17 step 4: what End my ball would end now, or null: this player holds the grant, the match is not paused, no transfer waits. */
  private endBallInfo(): ControllerStatus['endBall'] {
    const g = this.holding;
    if (this.closed || !g || this.phase !== 'playing' || this.role.state.pendingTransfer) return null;
    return { grantSeq: g.grantSeq, ball: g.ballNumber, score: this.myScore ?? this.role.state.players[this.localId]?.score ?? 0, tableBall: !this.pending && this.tableOwesAfter(g.ballNumber) };
  }

  /**
   * The review of PR 131: would the table still have this ball in play after it is ended by hand, and its end still
   * to come? Only on a table whose ball ends Castcade reads (the witness's word: on any other none will ever come), with
   * a game running on it, and not for the game's last ball (after it the table's game is spent, A16).
   */
  private tableOwesAfter(ballNumber: number): boolean {
    const balls = this.role.state.ballsPerGame;
    return this.tableGameRunning && this.localBallEnds !== false && !(balls > 0 && ballNumber >= balls);
  }

  /** A saved owed mark counts only for a ball end that is in the log (a press that never reached the host is no end). */
  private settleOwed(): void {
    if (!this.owedFromRecord) return;
    this.owedFromRecord = false;
    const mine = new Set<number>();
    for (const e of this.role.log.entries()) {
      const m = e.message;
      if (!m) continue;
      if (m.type === 'MATCH_READY' || m.type === 'NEXT_GAME') mine.clear();
      else if (m.type === 'BALL_END' && m.from === this.localId) mine.add(m.payload.grantSeq);
      else if (m.type === 'TURN_PASS' && m.payload.player === this.localId) mine.add(m.payload.grantSeq);
    }
    const kept = this.owedSeqs.filter((seq) => mine.has(seq));
    if (kept.length !== this.owedSeqs.length) this.opts.log(`match: ${this.owedSeqs.length - kept.length} ball end(s) made by hand before Castcade closed never reached the host: the table owes nothing for them`);
    this.owedSeqs = kept;
  }

  /**
   * The table ball ends still owed, checked against the log (for the shell after a restart, `tryReconcile`: it must
   * know which of the turn ends the host made while Castcade was closed the controller takes care of).
   */
  settledOwed(): number[] {
    this.settleOwed();
    return [...this.owedSeqs];
  }

  private clearOwed(): void {
    this.owedSeqs = [];
    this.owedFromRecord = false;
  }

  /**
   * A17 step 4 (2026-11-24, alpha-match.md §11.2): End my ball. The player who is up ends their own ball by hand, at
   * the score as it stands: their BALL_END with `detectorReason: 'manual'` and no shoot-again, which the schema has
   * had since protocol 1 and every host takes as an ordinary ball end. It is for a table whose ball ends Castcade
   * cannot read and for a ball that is stuck: until now only the host could move such a turn on (Pass the turn). A
   * ball the table has already ended (its bonus score is being waited for) is reported now, as the table said it.
   * False, with the reason in the log, when this player has no ball to end.
   *
   * The review of PR 131: `grantSeq` is the grant the player was asked about (the menu's first choose, the Match
   * tab's question). Another grant by now (the table ended the ball with an extra ball meanwhile, the turn went
   * round) is another ball at another score: refused, and the question is asked again. And when the table's ball is
   * still in play, the table owes its end (`owedSeqs`): the player plays it out at the next turn.
   */
  endMyBall(grantSeq?: number): boolean {
    const g = this.holding;
    if (!g || this.endBallInfo() === null) {
      this.opts.log(`match: End my ball: nothing to end (${!g ? 'this player does not hold the turn' : this.phase === 'paused' ? 'the match is paused' : 'a host transfer is under way'})`);
      return false;
    }
    if (grantSeq !== undefined && grantSeq !== g.grantSeq) {
      this.opts.log(`match: End my ball: the question was about another grant (${grantSeq}; this ball is played under ${g.grantSeq}): nothing ended`);
      return false;
    }
    if (this.pending) {
      this.opts.log('match: End my ball: the table has ended this ball already; reported now, without waiting for the bonus score');
      this.flushBallEnd();
      return true;
    }
    if (this.tableOwesAfter(g.ballNumber)) {
      this.settleOwed();
      this.owedSeqs.push(g.grantSeq);
      this.opts.log(`match: End my ball with the table's ball still in play: the table owes the match ${this.owedSeqs.length === 1 ? 'that ball end' : `${this.owedSeqs.length} ball ends`}; the ball is played out at this player's next turn, and its end reports nothing`);
    }
    this.sendBallEnd(g, false, 'manual');
    return true;
  }

  /**
   * A13: a TURN_PASS was logged (this host's own, or the host's as a client sees it). For the passed player it is the
   * end of the ball it was playing: nothing more is reported for it and the table locks until the next grant (which,
   * on a host, arrives right after this inside `passTurn`).
   */
  private onTurnPassed(p: PayloadOf<'TURN_PASS'>): void {
    if (p.player === this.localId) {
      // The review of PR 131: a pass is an end by hand too (since 0.2.40), and on a table whose ball was still in
      // play its drain was taken for the end of this player's next ball. The same rule as End my ball, on this PC
      // alone (nothing on the wire). Not when the table had already ended the ball for good: its bonus was being
      // waited for, or this PC had reported that end into a link that had dropped. (An end with an extra ball is not
      // that: the machine serves the same ball again, and the pass leaves it on the table.) And a ball this PC had
      // itself ended by hand, unanswered, is noted already: it is owed under the pass's grant from now on.
      this.settleOwed();
      const sent = this.unansweredEnd?.ball === p.ballNumber && this.unansweredEnd.game === this.gameNumber() ? this.unansweredEnd : null;
      const tableEnded = (this.pending !== null && !this.pending.shootAgain) || (sent !== null && !sent.byHand && !sent.again);
      if (sent?.byHand) {
        this.owedSeqs = this.owedSeqs.map((seq) => (seq === sent.grantSeq ? p.grantSeq : seq));
      } else if (this.replaying()) {
        // A17 step 7: the log of a match this PC joined, or came back into, in the middle of is being played to it:
        // a pass from before says nothing about the table as it is now. What this table owes after a restart is the
        // shell's to say, from its saved record and the passes made while Castcade was closed (`takeOwed`, `passedWhileAway`).
      } else if (!tableEnded && !this.owedSeqs.includes(p.grantSeq) && this.tableOwesAfter(p.ballNumber)) {
        this.owedSeqs.push(p.grantSeq);
        this.opts.log("match: the turn was passed with this table's ball still in play: the table owes the match that ball end; the ball is played out at this player's next turn, and its end reports nothing");
      }
      this.unansweredEnd = null;
      this.clearPending();
      this.clearStateTimer();
      this.holding = null;
      this.myBallsDone = Math.max(this.myBallsDone, p.ballNumber);
      this.opts.media?.setSending(false);
      this.noteMyGameDone();
      // This player's game is over with this ball: the rest of the table's game is not the match's (A16).
      if (this.myGameDone()) this.clearOwed();
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

  /** Re-push the panel (the media layer's mic state changed). A18: and look again at the media of the players who are away. */
  refresh(): void {
    if (this.closed) return;
    for (const id of this.left) this.closeDeadMedia(id);
    this.push();
  }

  /**
   * One event of this player's table (the witness's). True (the review of PR 131, finding 2): the event is a ball end
   * the match will never take: swallowed as owed, or arrived with no grant held, or of a table game this player has
   * already finished. The shell must not keep such an end for a later replay (after a reconnect or a restart it would
   * end the ball the player is on by then).
   *
   * `replay`: the event is not news of this moment: the shell feeds it again after a reconnect, or reads it from the
   * journal after a restart of Castcade. It is handled as ever, with one exception: a `game_start` that is fed again
   * is the start of the game the table has been in all along, and does not clear what the table owes.
   */
  feed(ev: ControllerFeed, replay = false): boolean {
    this.droppedEnd = false;
    this.take(ev, replay);
    return this.droppedEnd;
  }

  private take(ev: ControllerFeed, replay = false): void {
    if (this.closed) return;
    // A16.2: the machine wrote its high-score list; it only matters to an initials hold.
    if (ev.kind === 'high_scores_changed') {
      this.onHighScoresChanged(ev);
      return;
    }
    // B26.4: the ROM on this player's table counted a Midnight Madness; a flag only, no game event.
    if (ev.kind === 'midnight_madness') {
      this.onMidnightMadness(ev);
      return;
    }
    // A12: this player's own table game, any phase (the lobby rules read it).
    if (ev.kind === 'game_start') this.tableGameRunning = true;
    else if (ev.kind === 'game_end' || ev.kind === 'game_abandoned' || ev.kind === 'table_exit') this.tableGameRunning = false;
    // A17 step 7: in a lobby the game that ended may have been one the match did not own, or the one a start from
    // the table was asked with: the lobby hears it, and the lock follows (`afterTableGameEnd`, once this event is handled).
    const ended = this.lobbyOn && (ev.kind === 'game_end' || ev.kind === 'game_abandoned' || ev.kind === 'table_exit');
    if (ended) this.opts.setTimeout(() => this.afterTableGameEnd(), 0);
    // The review of PR 131: what the table owed was a ball of the game that has just begun anew, ended or gone. Not
    // at a `game_start` that is fed again: the ball was ended by hand after it, in that same game.
    if ((ev.kind === 'game_start' && !replay) || ev.kind === 'game_end' || ev.kind === 'game_abandoned' || ev.kind === 'table_exit') this.clearOwed();
    // A16.2: an initials hold ends with a new game on the table and with the table; the event itself is then handled
    // as ever. Not with a `game_end`: where that falls (before or after the initials) differs by machine.
    if (this.initialsHold) {
      if (ev.kind === 'game_start') this.endInitialsHold('a new game started on the table');
      else if (ev.kind === 'table_exit') this.endInitialsHold('the table closed');
    }
    // A16: the table game this player already finished: its scores, ball ends and end are not this turn's.
    if (this.spentTableGame) {
      if (ev.kind === 'ball_end') this.droppedEnd = true;
      if (ev.kind === 'current_scores' || ev.kind === 'ball_end') return;
      if (ev.kind === 'game_end' || ev.kind === 'game_abandoned') {
        this.endSpentGame("the table's finished game ended; nothing reported for it");
        return;
      }
      this.endSpentGame(ev.kind === 'game_start' ? "a new game started on the table; the finished one's end was not seen" : 'the table closed');
    }
    // A18: the table's game is running and the match's next game, which it will be, is held for a moment: what it
    // says meanwhile is kept for that game's first grant. If it ends first, it was no game of the match.
    if (this.heldTableStart) {
      // A second start with no end between (the host started the table's game again): what was kept is the first
      // game's, and would count as ball 1 of this one.
      if (ev.kind === 'game_start') this.heldFeed = [];
      if (ev.kind === 'current_scores' || ev.kind === 'ball_end') {
        this.heldFeed.push(ev);
        if (this.heldFeed.length > 200) this.heldFeed.splice(0, this.heldFeed.length - 200);
        return;
      }
      if (ev.kind === 'game_end' || ev.kind === 'game_abandoned' || ev.kind === 'table_exit') {
        this.heldTableStart = false;
        this.heldFeed = [];
      }
    }
    switch (ev.kind) {
      case 'game_start':
        this.onTableGameStart(replay);
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
        // The same end twice while the first waits for its bonus score.
        if (this.holding && this.pending) return;
        // The review of PR 131: the end of a ball that was ended by hand. It reports nothing, with or without a grant
        // held. With an extra ball the old ball goes on (the machine serves it again): still owed, and nothing is
        // granted for it.
        this.settleOwed();
        if (this.owedSeqs.length > 0) {
          const again = (ev.extraBalls ?? 0) > 0;
          if (!again) this.owedSeqs.shift();
          const left = this.owedSeqs.length;
          this.opts.log(
            again
              ? 'match: the ball that was ended by hand has ended on the table with an extra ball: it is still that ball, nothing is reported and nothing granted for it'
              : `match: the ball that was ended by hand has ended on the table: nothing is reported for it${left > 0 ? ` (${left} more still to be played out)` : this.holding ? `; ball ${this.holding.ballNumber} begins now` : ''}`,
          );
          this.droppedEnd = true;
          this.push();
          return;
        }
        // No grant held: an end of nothing the match knows (free play in the lobby, a ball the host passed long ago).
        if (!this.holding) {
          this.droppedEnd = true;
          return;
        }
        const grant = this.holding;
        const shootAgain = (ev.extraBalls ?? 0) > 0;
        this.pending = { grant, shootAgain, timer: this.opts.setTimeout(() => this.flushBallEnd(), this.settleMs) };
        this.opts.log(`match: ball ${grant.ballNumber} ended on the table${shootAgain ? ' (shoot again)' : ''}; reporting once the bonus is in`);
        return;
      }
      case 'game_end': {
        if (this.phase === 'lobby' && !this.lobbyOn) {
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
        if (this.phase === 'lobby' && !this.lobbyOn) {
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

  /**
   * A17 step 2 (2026-11-24, alpha-match.md §11.6): what this controller holds for a MATCH, let go: the ball end that
   * waits for its bonus score, the STATE timer, a spent table game's unlock and an initials hold, the Midnight Madness
   * lines' timers, the turn lock, and "this rig sends its picture". Nothing of the lobby: the media stays attached with
   * its peers (the voice), the role is still listened to, the start countdown and the 3D wait are left alone. Until
   * the lobby outlives a match (step 7) the only caller is the shell's teardown, with `close()` right behind it.
   * Twice in a row does nothing the second time: every part is a no-op once done, and the media layer is told "not
   * sending" once (`sendingOffSaid`).
   */
  releaseMatch(): void {
    this.clearPending();
    this.clearStateTimer();
    if (this.spentTimer !== null) this.opts.clearTimeout(this.spentTimer);
    this.spentTimer = null;
    this.spentUnlock = false;
    this.clearInitialsHold();
    if (this.midnightTimer !== null) this.opts.clearTimeout(this.midnightTimer);
    this.midnightTimer = null;
    if (this.midnightSettingTimer !== null) this.opts.clearTimeout(this.midnightSettingTimer);
    this.midnightSettingTimer = null;
    // A17 step 7 (the review of PR 136): in a lobby that goes on, the table is what the lobby's rule says at this
    // moment (a start may be counting down already when the shell's match half runs), never unlocked in between.
    const want = this.lobbyOn && !this.closed ? this.lobbyLockWanted() : null;
    this.setLocked(want ?? false);
    if (this.opts.media && this.attached && !this.sendingOffSaid) {
      this.sendingOffSaid = true;
      this.opts.media.setSending(false);
    }
  }
  /** A17 step 2: `releaseMatch` told the media layer "not sending", and no grant of this player's has turned it on since. */
  private sendingOffSaid = false;

  /** Unlock, stop sending, detach media, stop listening to the role. The caller closes the role and transport. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // A17 step 2: the match's share first (done already when the shell's match half ran), then the lobby's: the start
    // countdown and the 3D wait, the role's events, and the media with its peers.
    this.releaseMatch();
    this.clearCountdown();
    this.clearWait3d();
    this.clearLobbyTimers();
    for (const off of this.offs) off();
    this.offs = [];
    // The lobby's own lock (A12: the host's table before anyone joined) goes here at the latest.
    this.setLocked(false);
    this.listeners.clear();
    const media = this.opts.media;
    if (media && this.attached) {
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
  private onTableGameStart(replay = false): void {
    const r = this.role;
    // A17 step 7: in a lobby a game on a table is the starter's request, or a game of one's own (`onLobbyTableStart`).
    if (this.lobbyOn) {
      if ((this.phase === 'playing' || this.phase === 'paused') && this.holding) {
        if (!this.tableStarted) {
          this.tableStarted = true;
          this.push();
        }
        return;
      }
      this.onLobbyTableStart(replay);
      return;
    }
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
      // A18: held for a player inside the engine's grace: the same is noted for when it does start.
      if (ok && r.nextGamePending) {
        this.heldTableStart = true;
        this.opts.log("match: the next game waits a few seconds: a player's link dropped a moment ago, and who plays it is decided when that player is back or away");
        this.push();
      } else if (ok) {
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
      if (!this.startArmed || this.armedFor !== 'tables') {
        this.startArmed = true;
        this.armedFor = 'tables';
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
      this.armedFor = null;
      if (!this.tabArmed) this.endHold();
      this.opts.log(
        `match: a game started on the table, but ${unreadable.map((id) => (id === this.localId ? 'your' : `${this.nameOf(id)}'s`)).join(', ')} table cannot report ball ends; the match does not start from the table (Start match on the Match tab starts it anyway)`,
      );
      this.push();
      return;
    }
    // I11.4.9: the first turn starts in 3D: the countdown waits until every PC's 3D connection is settled (each PC
    // stops waiting by itself after its own limit), as it waits for a table to open.
    this.noteWait3d(h.stream3dWaiting());
    const w = this.wait3dNow();
    if (w.ids.length > 0) {
      if (!this.startArmed || this.armedFor !== '3d') {
        this.startArmed = true;
        this.armedFor = '3d';
        this.beginHold();
        this.opts.log(`match: a game started on the table; the match starts once ${this.wait3dWords(w.ids)} is up, ${this.wait3dNow().seconds} s at most (Start match on the Match tab starts it now)`);
        this.push();
      }
      return;
    }
    // A hold that reached its limit stays as it is until the match starts: nobody is waited for from then on.
    const due = this.holdUntil !== null && this.opts.now() >= this.holdUntil;
    if (this.startArmed && this.armedFor === '3d' && !due) this.opts.log('match: the 3D connections are settled; the start from the table goes on');
    this.startArmed = false;
    this.armedFor = null;
    if (!this.tabArmed && !due) this.endHold();
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
    this.armedFor = null;
    if (!this.tabArmed) this.endHold();
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
    // A countdown that ran out and is held: the lobby's word says "nothing left" again and again; when it ran out stays.
    if (ms <= 0 && this.countdownEnd !== null && this.countdownEnd <= this.opts.now()) return;
    this.clearCountdown();
    this.countdownEnd = end;
    this.tickCountdown();
  }

  private tickCountdown(): void {
    this.countdownTimer = null;
    if (this.closed || this.countdownEnd === null) return;
    this.push();
    const left = this.countdownEnd - this.opts.now();
    // One more look a second after it ran out: a start that is still announced then is being held (`countdownHeld`).
    if (left <= 0) {
      if (this.lobbyOn && left > -COUNTDOWN_HELD_MS) this.countdownTimer = this.opts.setTimeout(() => this.tickCountdown(), COUNTDOWN_HELD_MS + left);
      return;
    }
    const step = left % 1000 || 1000;
    this.countdownTimer = this.opts.setTimeout(() => this.tickCountdown(), step);
  }

  private clearCountdown(): void {
    if (this.countdownTimer !== null) this.opts.clearTimeout(this.countdownTimer);
    this.countdownTimer = null;
    this.countdownEnd = null;
  }

  /** A start's countdown ran out a second ago or more and no game has begun: it is held (a player's grace). */
  private countdownHeld(): boolean {
    return this.lobbyOn && this.countdownEnd !== null && this.opts.now() >= this.countdownEnd + COUNTDOWN_HELD_MS;
  }

  private countdownSeconds(): number | null {
    // A17 step 7: in a lobby the next game counts down too.
    if (this.countdownEnd === null || !(this.phase === 'lobby' || (this.lobbyOn && this.phase === 'over'))) return null;
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
    this.noteWait3d(h.stream3dWaiting());
    if (h.state.phase === 'lobby') this.noteBallEndReady(h.ballEndReadiness());
    for (const [id, mode] of Object.entries(h.midnightModes())) if (id !== this.localId) this.midnightModes.set(id, mode);
    if (!this.lobbyOn) this.syncLobby(h);
    // A17 step 7: the lobby's PC knows its lobby before it has said it to anyone (its `lobby` event comes with the
    // first change): what the first HELLO_ACK would say is read from the engine, so the panel has it from Open lobby.
    else this.ack = this.lobbyOf(h as LobbyHostRole);
    const offs = this.offs;
    offs.push(
      h.on('joined', (p) => {
        // A18: a player who left this lobby and joined again is here: no longer away, whatever an earlier leave said
        // (`left` was only ever emptied by a reconnect, which a fresh join is not).
        this.left.delete(p.playerId);
        this.mediaClosed.delete(p.playerId);
        // A17 step 7: in a lobby the `lobby` event says every change, this one too.
        if (!this.lobbyOn) this.onHostLobby(h);
      }),
    );
    // A6 (2026-10-31): a lobby rig / table correction (a client's PARTICIPANT_UPDATE, or this host's own).
    offs.push(h.on('participantUpdated', () => void (this.lobbyOn || this.onHostLobby(h))));
    offs.push(h.on('countdown', (c) => void (this.lobbyOn || this.setCountdown(c.startsInMs))));
    offs.push(
      h.on('countdownCancelled', (c) => {
        if (this.lobbyOn) return;
        this.opts.log(`match: the start from the table did not happen: ${c.reason}`);
        // I11.4.9: a start that is asked for again later is held anew.
        if (!this.tabArmed) this.endHold();
        this.setCountdown(null);
      }),
    );
    // A17 step 7: the lobby as every member was just told, this PC's own row included: the one source in a lobby.
    offs.push(h.on('lobby', (ack) => this.onLobbyAck(ack)));
    offs.push(h.on('lobbyClosed', (x) => this.onLobbyOver(`The lobby is closed: ${x.reason}`)));
    offs.push(h.on('nextGame', (p) => this.onNextGame(p)));
    offs.push(
      h.on('nextGameOff', (x) => {
        this.heldTableStart = false;
        this.heldFeed = [];
        this.opts.log(`match: the next game does not start: ${x.reason}`);
        this.push();
      }),
    );
    offs.push(h.on('matchEnded', (p) => (this.lobbyOn ? this.onMatchEnded(p) : this.onSeriesOver(`Match over after ${p.games} game${p.games === 1 ? '' : 's'}`))));
    offs.push(h.on('rigUpdated', (r) => this.onRigUpdated(r.playerId, r.rig)));
    offs.push(h.on('advisory', (a) => this.onAdvisory(a.playerId, a.advisory)));
    offs.push(h.on('midnightMode', (m) => this.onMidnightMode(m.playerId, m.mode)));
    // A host in `advise` mode accepted a different table file (§3): flagged, never refused.
    offs.push(h.on('tableMismatch', (m) => this.noteTableMismatch(m.playerId, m.mismatches.map((x) => x.field))));
    // A17 step 10 (review of PR 139): the lobby's PC logs every pick that reached it, taken or not, and by whom.
    offs.push(
      h.on('tablePickJudged', (j) => {
        const who = `${j.byName} (${j.by})`;
        // A pick that changed nothing is logged once in `PICK_LOG_GAP_MS` per member, with the number left out, so
        // that a member who keeps asking does not fill the log. A pick that was taken is always logged.
        const taken = j.outcome === 'changed' || j.outcome === 'added';
        let more = '';
        if (!taken) {
          const now = this.opts.now();
          const last = this.pickLogged.get(j.by);
          if (last && now - last.at < PICK_LOG_GAP_MS) {
            last.more += 1;
            return;
          }
          if (last && last.more > 0) more = ` (${last.more} more from them before this were not logged)`;
          if (this.pickLogged.size > 32) for (const [id, l] of this.pickLogged) if (now - l.at > 60_000) this.pickLogged.delete(id);
          this.pickLogged.set(j.by, { at: now, more: 0 });
        }
        if (j.outcome === 'refused') this.opts.log(`match: a pick of the lobby's table by ${who} was refused: ${j.table}: ${j.why ?? ''}${more}`);
        else if (j.outcome === 'changed') this.opts.log(`match: the lobby's table was picked by ${who}: ${j.table}${more}`);
        else if (j.outcome === 'added') this.opts.log(`match: ${who} picked the table the lobby has (${j.table}): what was not known of it is added; nothing else changes${more}`);
        else this.opts.log(`match: ${who} picked the table the lobby already has (${j.table}): nothing changes${more}`);
      }),
    );
    offs.push(h.on('ready', (p) => this.onReady(p)));
    offs.push(h.on('grant', (g) => this.onGrant(g, g.player === this.localId)));
    offs.push(h.on('ballEnd', (m) => this.onBallEndMsg(m.from, m.payload.finalScore)));
    offs.push(h.on('turnPassed', (m) => this.onTurnPassed(m.payload)));
    offs.push(h.on('gameOver', (m) => this.onScoreMsg(m.from, m.payload.finalScore)));
    offs.push(h.on('forfeit', (m) => this.onForfeitMsg(m.payload.player)));
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
        // A17 step 7: in a lobby a dropped link is "away", and who is away is in the lobby's own word (`onLobbyAck`).
        if (this.lobbyOn) return;
        this.onPeerLeft(id);
        if (h.state.phase === 'lobby') this.onHostLobby(h);
      }),
    );
    offs.push(h.on('reconnected', (r) => void (this.lobbyOn || this.onPeerBack(r.playerId, r.quiet))));
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
    // A17 step 7: in a lobby it comes in every phase, and is the lobby as it is now.
    offs.push(c.on('roster', (ack) => this.onClientAck(ack)));
    offs.push(c.on('nextGame', (p) => this.onNextGame(p)));
    offs.push(c.on('matchEnded', (p) => (this.lobbyOn ? this.onMatchEnded(p) : this.onSeriesOver(`The host ended the match after ${p.games} game${p.games === 1 ? '' : 's'}`))));
    offs.push(
      c.on('hostGone', () => {
        // A17 step 7: in a lobby `lobbyClosed` follows at once and says it.
        if (!this.lobbyOn && this.phase === 'over') this.onSeriesOver('The host left; the match is over');
      }),
    );
    // A17 step 7: the lobby is over for this PC: its PC closed it, did not come back in time, or the shell ended the wait.
    offs.push(
      c.on('lobbyClosed', (x) => {
        // Design 11.8a: "The lobby is closed: MekelburgJ's PC did not come back"; the shell's own reasons are whole sentences.
        const why = x.reason === "the lobby's PC did not come back" ? `${possessive(this.nameOf(this.hostId))} PC did not come back` : x.reason;
        this.onLobbyOver(why.startsWith('The lobby') ? why : `The lobby is closed: ${why}`);
      }),
    );
    // This PC's place was gone when it came back: what it held of a match is put away, and it joins again as a newcomer.
    offs.push(c.on('rejoining', () => this.onRejoining()));
    // A member who joined, or came back, while a match is open holds its whole log now.
    offs.push(c.on('caughtUp', () => this.onCaughtUp()));
    offs.push(c.on('wentBack', () => this.onWentBack()));
    offs.push(c.on('rigUpdated', (r) => this.onRigUpdated(r.playerId, r.rig)));
    offs.push(c.on('advisory', (a) => this.onAdvisory(a.playerId, a.advisory)));
    offs.push(c.on('midnightMode', (m) => this.onMidnightMode(m.playerId, m.mode)));
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
    offs.push(c.on('forfeit', (m) => this.onForfeitMsg(m.payload.player)));
    offs.push(c.on('state', (m) => this.onScoreMsg(m.from, m.payload.score)));
    offs.push(
      c.on('pause', () => {
        this.onPause();
        // D10.8: a pause for my own drop that reaches me on a live link (several players dropped at once, and the host
        // paused for me again after I was back): I am here, so I resume. Deferred: a pause merged from RECONNECT_ACK
        // is the `reconnected` handler's, which runs first.
        this.opts.setTimeout(() => {
          if (this.role === c) this.resumeAfterMyDrop(c);
        }, 0);
      }),
    );
    offs.push(
      c.on('resume', () => {
        this.resumeSent = false;
        this.onResume();
      }),
    );
    offs.push(c.on('reject', (r) => this.onReject(r)));
    offs.push(
      c.on('peerLeft', (id) => {
        // A RESUME sent into a link that then dropped is lost: the next reconnect sends its own.
        this.resumeSent = false;
        // A17 step 7: in a lobby the lobby's PC is away, and nothing closes for it.
        if (this.lobbyOn) this.onHostAway(id);
        else this.onPeerLeft(id);
      }),
    );
    offs.push(
      c.on('reconnected', (r) => {
        this.resumeSent = false;
        if (this.lobbyOn) {
          // A17 step 7: the lobby's PC is back. The table is what the lobby and the turn say now (`relock`).
          this.onHostBack();
          this.relock();
          this.resumeAfterMyDrop(c);
          return;
        }
        this.onPeerBack(r.host, r.quiet);
        // A15: a match picked up after a restart left the table as it was for a grant the log said was this player's;
        // the host's answer is in now, and without that grant the table locks.
        if (!this.holding && (this.phase === 'playing' || this.phase === 'paused')) this.setLocked(true);
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
    // A17 (2026-11-24): the voice follows the lobby's roster: a player who joins is connected at once, one who is no
    // longer listed is let go. (Until 0.2.50 nobody was connected before MATCH_READY.)
    if (this.phase === 'lobby' && !this.seriesOver) this.followLobbyVoice(participants.map((p) => p.playerId));
    this.push();
  }

  /** A host's lobby changed (a join, a leave, a table loaded): the roster, who is loading, and an armed start (A11). */
  private onHostLobby(h: HostRole): void {
    this.noteLoading(h.loading());
    this.noteWait3d(h.stream3dWaiting());
    this.noteBallEndReady(h.ballEndReadiness());
    // I11.4.9: a start held from the Match tab is off when the lobby falls below two (the shell starts it otherwise).
    // The lobby below two: a start that was held for a 3D connection, of either kind, is off, and its limit with it
    // (a hold that ran out with one player in the lobby would leave the next player who joins not waited for). The
    // next start is held anew.
    if (h.roster().length < 2) {
      const tab = this.tabArmed;
      this.tabArmed = false;
      this.tabHoldSpent = false;
      if (this.startArmed && this.armedFor === '3d') this.disarmStart('the lobby fell below two players while it waited for the 3D connections (start a game on the table again once somebody has joined)');
      this.endHold();
      if (tab) this.opts.log('match: the held Start match is off: the lobby fell below two players');
    }
    if (this.startArmed) this.tryStartFromTable(h, false);
    this.syncLobby(h);
    this.onLobby(h.roster());
  }

  private onClientAck(ack: PayloadOf<'HELLO_ACK'>): void {
    // B26.4 and the rest below are the same in a lobby; what differs is in `onLobbyAck`.
    if (this.lobbyOn) {
      const said = new Set(ack.midnightModes.map((x) => x.playerId));
      for (const id of [...this.midnightModes.keys()]) if (!said.has(id)) this.midnightModes.delete(id);
      for (const x of ack.midnightModes) this.onMidnightMode(x.playerId, { enabled: x.enabled, adjustment: x.adjustment });
      this.sendMidnightMode();
      this.onLobbyAck(ack);
      return;
    }
    this.noteLoading(ack.loading);
    this.noteWait3d(ack.stream3dWait);
    this.noteBallEndReady(Object.fromEntries(ack.ballEndReady.map((x) => [x.playerId, x.ready])));
    // B26.4: what every player said about the Midnight Madness setting; this player's own goes out once it has joined.
    const said = new Set(ack.midnightModes.map((x) => x.playerId));
    for (const id of [...this.midnightModes.keys()]) if (!said.has(id)) this.midnightModes.delete(id);
    for (const x of ack.midnightModes) this.onMidnightMode(x.playerId, { enabled: x.enabled, adjustment: x.adjustment });
    this.sendMidnightMode();
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
    this.clearOwed();
    this.unansweredEnd = null;
    this.tableStarted = this.heldTableStart;
    this.heldTableStart = false;
    this.scores.clear();
    this.result = null;
    this.message = null;
    if (this.lobbyOn) this.beginLobbyGame(p.playerOrder);
    else this.setLocked(true);
    this.opts.log(`match: game ${p.game} begins: ${p.playerOrder.map((id) => this.nameOf(id)).join(', ')}`);
    this.showMidnightSetting();
    this.push();
  }

  /**
   * A10: no next game follows. Every table is unlocked (solo play works again); the panel keeps the standings.
   * A17 step 1 (the review of PR 127): and every voice connection is let go at once. Nothing follows in this lobby
   * (the host ended the match or is gone), and the players in it must not go on hearing each other through the
   * seconds the panel lingers, or for ever in a lobby that never started: nobody's microphone is sent to a person
   * once the lobby they shared is over. (When a match's end stops being the lobby's end, step 7, this goes with it.)
   */
  private onSeriesOver(line: string): void {
    if (this.seriesOver) return;
    this.seriesOver = true;
    this.seriesOverLine = line;
    this.syncVoice();
    this.endInitialsHold('the match ended');
    this.setLocked(false);
    this.opts.log(`match: ${line}`);
    this.push();
  }

  /**
   * A17 step 1 (the review of PR 127): a client has lost the host in the lobby: the host left or quit, its Castcade
   * died, ArcAid closed or lost the room, or this PC's own link to the host dropped. In the lobby nobody comes back
   * from that (a drop there is a leave, and the host has taken this PC off its roster), and no roster will ever say
   * again who is in the lobby. Until 0.2.50 that dead lobby was silent; with the voice connected from the join on,
   * two clients went on hearing each other in it until each pressed Leave. So the lobby is over for this PC: every
   * voice connection is let go at once, the panel and the Match tab say so, and the shell closes the match after its
   * usual linger (`scheduleSeriesEnd`).
   */
  private onLobbyLost(): void {
    if (this.seriesOver) return;
    this.clearCountdown();
    this.onSeriesOver(
      `The lobby is over: the link to ${this.nameOf(this.hostId)}'s Castcade is gone (they left or closed Castcade, or the connection dropped). Nobody hears your microphone any more. Join again to play.`,
    );
  }

  private onRigUpdated(id: PlayerId, rig: ParticipantInfo['rig']): void {
    if (this.liveRigs.get(id) === rig) return;
    this.liveRigs.set(id, rig);
    this.opts.log(`match: ${this.nameOf(id)}'s rig is ${rig} now`);
    this.push();
  }

  private onReady(p: PayloadOf<'MATCH_READY'>): void {
    if (this.lobbyOn) {
      this.onLobbyReady(p);
      return;
    }
    this.clearCountdown();
    this.clearWait3d();
    this.startArmed = false;
    this.waitingForHostGame = false;
    this.lobbyLocked = false;
    this.loadingIds = [];
    this.phase = 'playing';
    this.hostId = p.hostPlayerId;
    this.lobby = p.participants.map((x) => ({ ...x }));
    this.message = null;
    this.clearOwed();
    this.unansweredEnd = null;
    // A18: MATCH_READY's roster is who is here now: nobody in it is away, whatever the lobby saw come and go.
    this.left.clear();
    this.mediaClosed.clear();
    // Locked from the start: each player begins their own game when their first grant arrives (§1 step 4).
    this.setLocked(true);
    // A17 (2026-11-24): the players are connected since the lobby, so naming them here opens nothing; it only covers
    // a player this controller did not see in a lobby roster. (A PC on 0.2.50 or older opens its side at this moment,
    // and answers the offer it has held since the join.)
    this.wantVoice(p.playerOrder);
    void this.ensureAttached();
    this.showMidnightSetting();
    this.push();
  }

  private onGrant(g: GrantBody, mine: boolean): void {
    const changed = this.upPlayer !== g.player;
    this.upPlayer = g.player;
    this.upBall = g.ballNumber;
    if (this.phase === 'lobby' || this.phase === 'paused') this.phase = 'playing';
    if (mine) {
      // The review of PR 131, finding 5: this ball was ended by hand and the host never answered: the grant is here
      // again under a new number (the report went into a dead link, and the host issued the grant again). The ball
      // end goes out for the new grant, once; the table stays locked.
      const lost = this.unansweredEnd;
      if (lost && lost.byHand && lost.grantSeq !== g.grantSeq && lost.ball === g.ballNumber && lost.game === (g.game ?? this.gameNumber())) {
        this.unansweredEnd = null;
        // What the table owes for that ball is owed for this grant now (the one the log will have the ball end under).
        this.owedSeqs = this.owedSeqs.map((seq) => (seq === lost.grantSeq ? g.grantSeq : seq));
        this.opts.log(`match: grant ${g.grantSeq}: ball ${g.ballNumber} again, which this player had ended by hand (that report never reached the host): sent for this grant`);
        this.holding = g;
        // Not from inside this call: a grant merged from a reconnect's answer is raised before the engine sends its own
        // unanswered reports again (`ClientMatch.resendUnanswered`), and that would send this one a second time.
        this.opts.setTimeout(() => {
          if (this.closed || this.holding !== g) return;
          this.sendBallEnd(g, false, 'manual', lost.score);
        }, 0);
        this.push();
        return;
      }
      const was = this.holding;
      this.holding = g;
      this.setLocked(false);
      if (!was) {
        if (!this.replaying()) this.opts.cue.play('your_turn');
        this.sendingOffSaid = false;
        this.opts.media?.setSending(true);
        this.settleOwed();
        this.opts.log(`match: grant ${g.grantSeq}: my ball ${g.ballNumber}${this.owedSeqs.length > 0 ? ` (the table still has ${this.owedSeqs.length === 1 ? 'the ball' : `${this.owedSeqs.length} balls`} this player ended by hand: played out first, reporting nothing)` : ''}`);
      }
    } else {
      if (this.holding) {
        // A grant for someone else while this player still held one (a re-issue after a transfer): stop playing.
        this.holding = null;
        this.clearPending();
        this.opts.media?.setSending(false);
      }
      // A17 step 7: a member who is not in this game is locked while it is played, unless a game of their own runs.
      if (this.lobbyOn && !this.inThisGame()) this.syncLobbyLock();
      else this.setLocked(true);
      if (changed && !this.replaying()) this.opts.cue.play('opponent_turn');
    }
    this.push();
    // A18: the first grant of a game whose start from this table was held: what the table said meanwhile, now.
    if (mine && this.heldFeed.length > 0) {
      const kept = this.heldFeed.splice(0);
      this.opts.log(`match: ${kept.length} table event(s) from the seconds the game's start was held go to the match now (${kept.filter((e) => e.kind === 'ball_end').length} ball end(s))`);
      for (const ev of kept) this.take(ev);
    }
  }

  private onBallEndMsg(from: PlayerId, finalScore: number): void {
    // The host answered this player's ball end (its echo is in the log): nothing is left to send again.
    if (from === this.localId) this.unansweredEnd = null;
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
    // The review of PR 131: a ball end made by hand that the host refused ended nothing: the table owes nothing for it,
    // and it is not sent again.
    const lost = this.unansweredEnd;
    if (r.refType === 'BALL_END' && lost) {
      if (lost.byHand) this.owedSeqs = this.owedSeqs.filter((seq) => seq !== lost.grantSeq);
      this.unansweredEnd = null;
    }
    // A17 step 7: the lobby's answer to something this player asked is a sentence written to be shown as it is.
    if (this.lobbyOn && LOBBY_REQUESTS.has(r.refType)) {
      this.opts.log(`match: the lobby's PC did not take ${r.refType}: ${r.message}`);
      if (r.refType === 'START_REQUEST' && this.tableAsk === 'asked') this.settleTableAsk('own', r.message);
      else this.flash(r.message);
      return;
    }
    this.message = `The host rejected ${r.refType}: ${r.message}`;
    this.opts.log(`match: ${this.message} (${r.code})`);
    this.push();
  }

  private onPeerLeft(id: PlayerId): void {
    this.left.add(id);
    // A drop in the lobby is a leave (the host takes the player off the roster): the voice to them goes with it. For
    // a client the one link it has is the host's: without it the lobby is over, and everybody is let go.
    if (this.phase === 'lobby') {
      if (!isHostRole(this.role) && id === this.hostId) this.onLobbyLost();
      else this.dropVoice(id);
    } else this.closeDeadMedia(id);
    if (isHostRole(this.role)) this.lobby = this.role.state.phase === 'lobby' ? this.role.roster() : this.lobby;
    this.push();
  }

  /** A18: the media layer's own word on its connection to `id`: up, whatever the match's control link says. */
  private mediaUp(id: PlayerId): boolean {
    const ice = this.opts.media?.status().peers?.[id]?.ice;
    return ice === 'connected' || ice === 'completed';
  }

  /**
   * A18: a player who is away keeps the media connection while that connection is up (ArcAid dropped the match's
   * control link; the two PCs still reach each other). One that is not up belongs to a player who is really gone: it is
   * closed, as every dropped player's was before, and made again when that player is back.
   */
  private closeDeadMedia(id: PlayerId): void {
    if ((this.phase === 'lobby' && !this.lobbyOn) || this.mediaClosed.has(id) || this.mediaUp(id)) return;
    this.mediaClosed.add(id);
    this.dropVoice(id);
  }

  // ------------------------------------------------------------------------------------------
  // A17 (2026-11-24): the voice from the join on
  // ------------------------------------------------------------------------------------------

  /** These players should be connected (this player's own id is skipped). Nobody is taken off by it. */
  private wantVoice(ids: Iterable<PlayerId>): void {
    for (const id of ids) if (id !== this.localId) this.voiceWanted.add(id);
    this.syncVoice();
  }

  /** This player's connection is closed, if there is one, and not wanted until somebody names the player again. */
  private dropVoice(id: PlayerId): void {
    this.voiceWanted.delete(id);
    this.syncVoice();
  }

  /** In the lobby the roster is the whole list: a player who is no longer in it is let go. */
  private followLobbyVoice(ids: PlayerId[]): void {
    // A17 step 7: a member who is away and whose connection was closed because it was not up (A18) is made again at
    // their return, not by the next word of the lobby.
    this.voiceWanted = new Set(ids.filter((id) => id !== this.localId && !this.mediaClosed.has(id)));
    this.syncVoice();
  }

  /**
   * A18's case, said in so many words now that `addPeer` no longer rebuilds: the connection to a player who is back
   * is not up any more, so it is closed and made again.
   */
  private remakeVoice(id: PlayerId): void {
    if (this.mediaReady && !this.closed && this.voiceHeld.delete(id)) this.opts.media?.removePeer(id);
    this.wantVoice([id]);
  }

  /**
   * The one place that opens and closes media connections: what is wanted against what the media layer holds. Before
   * the media layer has attached nothing is sent (it would drop the call); `ensureAttached` runs this when it has.
   */
  private syncVoice(): void {
    // Nothing follows in this lobby (`onSeriesOver`): nobody is wanted any more, whoever names them.
    if (this.seriesOver) this.voiceWanted.clear();
    const media = this.opts.media;
    if (!media || this.closed || !this.mediaReady) return;
    for (const id of [...this.voiceHeld]) {
      if (this.voiceWanted.has(id)) continue;
      this.voiceHeld.delete(id);
      media.removePeer(id);
    }
    for (const id of this.voiceWanted) {
      if (this.voiceHeld.has(id)) continue;
      this.voiceHeld.add(id);
      media.addPeer(id);
      if (this.phase === 'lobby') this.opts.log(`match: voice with ${this.nameOf(id)} is being connected now, in the lobby; the start of a match does not make it again`);
    }
  }

  /** `quiet` (A18): the link was back inside the engine's grace and nobody was told it had dropped: nothing to undo. */
  private onPeerBack(id: PlayerId, quiet = false): void {
    const was = this.left.delete(id);
    if (this.phase !== 'lobby' && (was || !quiet)) {
      // A18: a connection that is still up is left alone: making it again is what the other players heard as a glitch.
      // One that was closed while the player was away is opened; one that was kept and is not up any more is made
      // again (A17: by closing it first, since naming a held peer no longer rebuilds it).
      if (this.mediaClosed.delete(id)) this.wantVoice([id]);
      else if (!this.mediaUp(id)) this.remakeVoice(id);
      else if (was) this.opts.log(`match: ${this.nameOf(id)} is back on the match's control link; the voice and video connection to them never dropped and is kept`);
    }
    this.push();
  }

  /**
   * A8 (2026-10-31): back on a link after a drop. The host paused the match for it and waits for a RESUME from
   * anyone (A3); the player who dropped is the one who knows it is back, so it sends it. Only for its own drop: a
   * pause for someone else stays theirs (or the host's Resume button). D10.8: one RESUME per pause (`resumeSent`,
   * cleared by the RESUME coming back, a new reconnect or a dropped link); it is also called when a pause for this
   * player arrives on a live link.
   */
  private resumeSent = false;
  private resumeAfterMyDrop(c: ClientRole): void {
    const p = c.state.paused;
    if (c.state.phase !== 'running' || !p || p.reason !== 'disconnect' || p.player !== this.localId || c.state.pendingTransfer) return;
    if (this.resumeSent) return;
    this.resumeSent = true;
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
    // A15: a match picked up between games is `over` with no result on the panel until the host sends it again.
    if (this.phase === 'over' && this.result !== null) return;
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
    // A17 step 7: between games the lock is the lobby's (the players of the open match but the starter).
    if (this.lobbyOn) {
      this.syncLobbyLock();
      this.syncOwnGame();
    } else this.setLocked(!isHostRole(this.role) && !this.seriesOver);
    if (!this.replaying()) this.opts.cue.play('match_over');
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
    this.sendBallEnd(p.grant, p.shootAgain, 'nvram');
  }

  /**
   * This player's ball is over: the table said so (`nvram`), or the player did (A17 step 4: `manual`, End my ball; the
   * score is then the last one the table reported, else what the log has for this player).
   */
  private sendBallEnd(grant: GrantBody, shootAgain: boolean, reason: 'nvram' | 'manual', score?: number): void {
    this.clearPending();
    this.clearStateTimer();
    const finalScore = score ?? this.myScore ?? (reason === 'manual' ? (this.role.state.players[this.localId]?.score ?? 0) : 0);
    // The review of PR 131: a client remembers it until the host's echo (a host's own end is in its log at once).
    this.unansweredEnd = isHostRole(this.role) ? null : { grantSeq: grant.grantSeq, game: grant.game ?? this.gameNumber(), ball: grant.ballNumber, score: finalScore, byHand: reason === 'manual', again: shootAgain };
    if (!shootAgain) this.myBallsDone = Math.max(this.myBallsDone, grant.ballNumber);
    this.scores.set(this.localId, finalScore);
    // Bookkeeping first: a HostMatch issues the next grant inside localBallEnd.
    this.holding = null;
    this.opts.media?.setSending(false);
    this.noteMyGameDone();
    // This player's game is over with this ball: the rest of the table's game is not the match's (A16).
    if (this.myGameDone()) this.clearOwed();
    this.noteInitialsHold(finalScore);
    this.setLocked(true);
    this.opts.log(`match: BALL_END ball ${grant.ballNumber} score ${finalScore}${shootAgain ? ' (shoot again)' : ''}${reason === 'manual' ? ' (ended by hand: End my ball)' : ''}`);
    this.call(() => {
      const r = this.role;
      if (isHostRole(r)) r.localBallEnd(finalScore, reason, shootAgain);
      else r.reportBallEnd(finalScore, reason, shootAgain);
    }, 'BALL_END');
    this.push();
  }

  private reportGameOver(): void {
    const finalScore = this.myScore ?? 0;
    const balls = Math.max(this.myBallsDone, this.holding?.ballNumber ?? 0);
    this.myGameOver = true;
    this.clearOwed();
    this.unansweredEnd = null;
    this.holding = null;
    this.clearStateTimer();
    this.opts.media?.setSending(false);
    this.noteInitialsHold(finalScore);
    this.setLocked(true);
    this.opts.log(`match: GAME_OVER score ${finalScore} after ${balls} ball(s)`);
    this.call(() => {
      const r = this.role;
      if (isHostRole(r)) r.localGameOver(finalScore, balls);
      else r.reportGameOver(finalScore, balls);
    }, 'GAME_OVER');
    this.push();
  }

  /** A FORFEIT in the log. This player's own, when it was not their press (Play on without them, a clock): their table game is spent. */
  private onForfeitMsg(player: PlayerId): void {
    if (player === this.localId && !this.replaying()) {
      this.spendForfeitedGame();
      // The lobby hears of the game that is still on this table now, not at its next word.
      this.syncOwnGame();
    }
    this.push();
  }

  private forfeit(reason: string): void {
    this.myGameOver = true;
    this.spendForfeitedGame();
    this.clearOwed();
    this.unansweredEnd = null;
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
    // Step 8: the game that is still on this table is said to the lobby now (the next start waits for it).
    this.syncOwnGame();
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

  /**
   * A17 step 7 (2026-11-25, the review of PR 136): this player's game of the match ended otherwise than by its last
   * ball (Give up this game; counted out by the lobby's PC or by a clock) while the game on the table, which was the
   * match's, is still running. That table game is spent, as A16 has it for a finished one: nothing it says is
   * reported, it is never a game of this player's own (the lobby is not told `ownGame`, so no start waits for a game
   * on a table that is locked), and it ends with its own end or with a new game on the table. No unlock window (A16's
   * is for a bonus count and initials): the table of someone who is out of the game follows the lock rule.
   */
  private spendForfeitedGame(): void {
    if (!this.lobbyOn || this.spentTableGame || !this.tableGameRunning) return;
    this.spentTableGame = true;
    // Step 8 (the review of PR 138): and it is said to the lobby as long as it runs (`syncOwnGame`): the table is
    // this player's to play it out, the next start waits for it (everyone is told why, and Start without them works
    // where enough players are left), and this player can let the start go on with them (`requestStart` with `now`).
    this.givenUp = true;
    this.givenUpReleased = false;
    this.opts.log("match: my game of the match is over and the table's own game is still on: nothing it says is reported; the table is mine to play it out, and the next start waits for it");
    this.syncLobbyLock();
  }

  /** The given-up game is still running on this table (`spendForfeitedGame`). */
  private givenUpRuns(): boolean {
    return this.givenUp && this.spentTableGame && this.tableGameRunning;
  }

  /**
   * A16: this player's last ball of the game has just been reported. If the table's own game is still running, it is
   * spent, and the table stays unlocked for its ending.
   */
  private noteMyGameDone(): void {
    if (this.spentTableGame || !this.tableGameRunning || !this.myGameDone()) return;
    this.spentTableGame = true;
    this.spentUnlock = true;
    if (this.spentTimer !== null) this.opts.clearTimeout(this.spentTimer);
    this.spentTimer = this.opts.setTimeout(() => {
      this.spentTimer = null;
      if (!this.spentUnlock) return;
      this.spentUnlock = false;
      this.opts.log(`match: the table's finished game has not ended after ${Math.round(SPENT_UNLOCK_MS / 1000)} s; the table follows the turn lock again`);
      this.setLocked(this.wantLocked);
    }, SPENT_UNLOCK_MS);
    this.opts.log("match: my game is done and the table's own game is still on (bonus, initials): the table stays unlocked until it ends");
  }

  /** A16: the spent table game is over (its end, or a new game started): the turn lock rules again. */
  private endSpentGame(why: string): void {
    if (!this.spentTableGame) return;
    this.givenUp = false;
    this.givenUpReleased = false;
    this.spentTableGame = false;
    this.spentUnlock = false;
    if (this.spentTimer !== null) this.opts.clearTimeout(this.spentTimer);
    this.spentTimer = null;
    this.opts.log(`match: ${why}`);
    this.setLocked(this.wantLocked);
  }

  // ------------------------------------------------------------------------------------------
  // A16.2: the high-score initials hold
  // ------------------------------------------------------------------------------------------

  /**
   * This player's game has just finished at `score` (the last ball reported, or the table's game over). If the score
   * has a place on the machine's high-score list the hold begins: called before the lock, so the table never locks.
   */
  private noteInitialsHold(score: number): void {
    if (this.initialsHold || !this.myGameDone() || !(score > 0) || !this.opts.highScoreQualifies) return;
    let qualifies = false;
    try {
      qualifies = this.opts.highScoreQualifies(score);
    } catch (e) {
      this.opts.log(`match: could not compare the score with the table's high-score list: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!qualifies) return;
    this.initialsHold = true;
    this.holdScore = score;
    this.holdEntries = [];
    this.holdWaitLogged = false;
    this.holdCapTimer = this.opts.setTimeout(() => {
      this.holdCapTimer = null;
      this.endInitialsHold(`no high-score entry seen after ${Math.round(INITIALS_HOLD_CAP_MS / 1000)} s`);
    }, INITIALS_HOLD_CAP_MS);
    this.opts.log(
      `match: initials hold on: my score ${score} is on the table's high-score list; the table stays unlocked and the headset stays on it (at most ${Math.round(INITIALS_HOLD_CAP_MS / 1000)} s)`,
    );
  }

  /** The machine wrote its high-score list during a hold: the hold ends once the list has been quiet for a while. */
  private onHighScoresChanged(ev: HighScoreEvent): void {
    if (!this.initialsHold) return;
    this.holdEntries = ev.entries;
    if (this.holdQuietTimer !== null) this.opts.clearTimeout(this.holdQuietTimer);
    this.holdQuietTimer = this.opts.setTimeout(() => {
      this.holdQuietTimer = null;
      if (!this.initialsHold) return;
      // The machine may put the score on the list first and the initials after the entry: an entry with this score
      // and no initials is still being entered (or was left blank: the cap ends the hold then).
      const mine = this.holdEntries.find((h) => h.score === this.holdScore);
      if (mine && (mine.initials ?? '').trim() === '') {
        if (!this.holdWaitLogged) this.opts.log(`match: initials hold: the table's high-score list has my score ${this.holdScore} with no initials yet; waiting for them`);
        this.holdWaitLogged = true;
        return;
      }
      this.endInitialsHold(`the table wrote its high-score list${mine ? ` (${(mine.initials ?? '').trim()} ${this.holdScore})` : ''} and it has been quiet for ${Math.round(INITIALS_QUIET_MS / 1000)} s`);
    }, INITIALS_QUIET_MS);
  }

  private clearInitialsHold(): void {
    this.initialsHold = false;
    if (this.holdCapTimer !== null) this.opts.clearTimeout(this.holdCapTimer);
    this.holdCapTimer = null;
    if (this.holdQuietTimer !== null) this.opts.clearTimeout(this.holdQuietTimer);
    this.holdQuietTimer = null;
    this.holdEntries = [];
  }

  /** The hold is over: the turn lock rules again and the headset follows the turn. */
  private endInitialsHold(why: string): void {
    if (!this.initialsHold) return;
    this.clearInitialsHold();
    this.opts.log(`match: initials hold over: ${why}`);
    this.setLocked(this.wantLocked);
    this.push();
  }

  // ------------------------------------------------------------------------------------------
  // B26: the Midnight Madness flag
  // ------------------------------------------------------------------------------------------

  /**
   * B26.4: the ROM on this player's table counted a Midnight Madness (its audit went up while the table's game was in
   * play). The ball it ran on is the one this player holds; with no grant held but this player's match game open on
   * the table (its turn is over, or not yet here), it is the ball this player plays next, where the mode will run.
   * Outside this player's match game (the lobby, between games, a game already finished) nothing is flagged. Flagged
   * here and for every other player at once. Never throws; never touches a score, the lock or the turn.
   */
  private onMidnightMadness(ev: MidnightEvent): void {
    const counted = `the ROM's audit ${ev.audit} went from ${ev.from} to ${ev.to}`;
    if (!this.inPlay() || this.spentTableGame || this.myGameDone() || (!this.holding && !this.tableStarted)) {
      this.opts.log(`match: ${counted} on my table outside my game of this match; nothing flagged`);
      return;
    }
    const ballNumber = this.holding?.ballNumber ?? this.myBallsDone + 1;
    const advisory: PlayerAdvisory = { kind: 'midnight', game: this.gameNumber(), ballNumber };
    if (!this.addMidnight(this.localId, advisory, counted)) return;
    try {
      const r = this.role;
      const sent = isHostRole(r) ? r.localAdvisory(advisory) : r.reportAdvisory(advisory);
      if (!sent) this.opts.log('match: the Midnight Madness flag was not sent to the other players (no match running)');
    } catch (e) {
      this.opts.log(`match: the Midnight Madness flag could not be sent to the other players: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.push();
  }

  /** A flag from the engine: another player's (passed on by the host), or this player's own coming back (a duplicate). */
  private onAdvisory(player: PlayerId, advisory: PlayerAdvisory): void {
    if (this.closed || advisory.kind !== 'midnight') return;
    if (!this.role.state.participants.some((p) => p.playerId === player)) return;
    if (this.addMidnight(player, advisory)) this.push();
  }

  /** Records a flagged ball, logs it and puts its line on the panel for a while. False when it was known already. */
  private addMidnight(player: PlayerId, a: PlayerAdvisory, counted: string | null = null): boolean {
    if (this.midnight.some((x) => x.player === player && x.game === a.game && x.ball === a.ballNumber)) return false;
    this.midnight.push({ player, game: a.game, ball: a.ballNumber });
    if (this.midnight.length > MIDNIGHT_KEEP) this.midnight.splice(0, this.midnight.length - MIDNIGHT_KEEP);
    const mine = player === this.localId;
    this.opts.log(
      mine
        ? `match: Midnight Madness ran on my ball ${a.ballNumber} of game ${a.game}: ${counted ?? "the ROM's audit of it went up"} during the game; flagged for every player (a flag only: no score or result changes)`
        : `match: Midnight Madness ran on ${possessive(this.nameOf(player))} ball ${a.ballNumber} of game ${a.game}: the ROM on that table counted it (flagged by that player's Castcade; a flag only: no score or result changes)`,
    );
    if (a.game === this.gameNumber()) {
      this.midnightShown = { line: midnightLine(mine ? null : this.nameOf(player), a.ballNumber), until: this.opts.now() + MIDNIGHT_LINE_MS };
      if (this.midnightTimer !== null) this.opts.clearTimeout(this.midnightTimer);
      this.midnightTimer = this.opts.setTimeout(() => {
        this.midnightTimer = null;
        this.midnightShown = null;
        this.push();
      }, MIDNIGHT_LINE_MS);
    }
    return true;
  }

  /** The flagged balls of the game being played (or just played), per player. */
  private midnightBalls(player: PlayerId): number[] {
    const game = this.gameNumber();
    return this.midnight.filter((x) => x.game === game && x.player === player).map((x) => x.ball);
  }

  private advisoryLines(): string[] {
    const setting = this.midnightSetting();
    const lines = setting ? [setting] : [];
    if (this.phase === 'lobby') return lines;
    const game = this.gameNumber();
    return [...lines, ...this.midnight.filter((x) => x.game === game).map((x) => midnightLine(x.player === this.localId ? null : this.nameOf(x.player), x.ball))];
  }

  // ------------------------------------------------------------------------------------------
  // B26.4: the Midnight Madness setting on each table
  // ------------------------------------------------------------------------------------------

  /**
   * B26.4: how the adjustment that enables Midnight Madness reads on this player's own table, from the witness (the
   * journal's NVRAM of the open table); null when it cannot be read (no table open, a game with no known setting),
   * which changes nothing: what was read last stands, and a rig that never read it says nothing. The others are told
   * through the engine, now or as soon as this player has joined.
   */
  setLocalMidnightMode(mode: MidnightMode | null): void {
    if (this.closed || mode === null) return;
    const was = this.localMidnightMode;
    if (was && was.enabled === mode.enabled && was.adjustment === mode.adjustment) return;
    this.localMidnightMode = { enabled: mode.enabled, adjustment: mode.adjustment };
    this.opts.log(`match: Midnight Madness is ${mode.enabled ? 'ON' : 'OFF'} on my table (adjustment ${mode.adjustment})`);
    this.sendMidnightMode();
    this.push();
  }

  /** Tells the others this player's setting when they have not heard it (a client can only after its join). */
  private sendMidnightMode(): void {
    const mode = this.localMidnightMode;
    if (this.closed || !mode) return;
    const key = JSON.stringify(mode);
    if (key === this.midnightModeSent) return;
    try {
      const r = this.role;
      if (isHostRole(r)) r.localMidnightMode(mode);
      else if (!r.reportMidnightMode(mode)) return;
      this.midnightModeSent = key;
    } catch (e) {
      this.opts.log(`match: the Midnight Madness setting could not be sent to the other players: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Another player's setting (the host's engine, or an update the host passed on). */
  private onMidnightMode(player: PlayerId, mode: MidnightMode): void {
    if (this.closed || player === this.localId) return;
    const was = this.midnightModes.get(player);
    if (was && was.enabled === mode.enabled && was.adjustment === mode.adjustment) return;
    this.midnightModes.set(player, { enabled: mode.enabled, adjustment: mode.adjustment });
    this.opts.log(`match: Midnight Madness is ${mode.enabled ? 'ON' : 'OFF'} on ${possessive(this.nameOf(player))} table (adjustment ${mode.adjustment}; read by that player's Castcade)`);
    this.push();
  }

  /** The one line about the setting (`midnightSettingLine`), or null: ON on no table that could be read. */
  private midnightSetting(): string | null {
    return midnightSettingLine(
      this.participants().map((p) => ({
        name: p.playerId === this.localId ? null : p.displayName,
        setting: p.playerId === this.localId ? this.localMidnightMode : (this.midnightModes.get(p.playerId) ?? null),
      })),
    );
  }

  /** A game of the match starts: the setting line goes on the panel for `MIDNIGHT_LINE_MS` (when there is one). */
  private showMidnightSetting(): void {
    this.midnightSettingUntil = this.opts.now() + MIDNIGHT_LINE_MS;
    if (this.midnightSettingTimer !== null) this.opts.clearTimeout(this.midnightSettingTimer);
    this.midnightSettingTimer = this.opts.setTimeout(() => {
      this.midnightSettingTimer = null;
      this.push();
    }, MIDNIGHT_LINE_MS);
  }

  private setLocked(want: boolean): void {
    this.wantLocked = want;
    // Step 8 (the review of PR 138): the game this player gave up is still on their table: the table is theirs to
    // play it out, whatever the turn says (it reports nothing); the lock rules again when that game has ended.
    const on = want && !this.spentUnlock && !this.initialsHold && !(this.lobbyOn && this.givenUpRuns());
    if (this.locked === on && !this.lockStale) return;
    this.lockStale = false;
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
      this.attached = media
        .attach(signalling, [])
        .catch((e: unknown) => {
          this.opts.log(`match: media attach failed: ${e instanceof Error ? e.message : String(e)}`);
        })
        .then(() => {
          // A17: whoever is wanted by now (the lobby's roster came before the panel was up) is connected.
          this.mediaReady = true;
          this.syncVoice();
        });
    }
    return this.attached;
  }

  // ------------------------------------------------------------------------------------------
  // A17 step 7 (2026-11-25): the lobby
  // ------------------------------------------------------------------------------------------

  /**
   * The lobby as its PC just said it (HELLO_ACK: the host's own `lobby` event, a client's `joined` / `roster`), in
   * every phase: the members, who is away, the voice (it follows the members), the announced start and its
   * countdown, the word on a game this table asked a start with, and the lock outside a turn.
   */
  private onLobbyAck(ack: PayloadOf<'HELLO_ACK'>): void {
    const me = this.localId;
    this.ack = ack;
    this.hostId = ack.hostPlayerId;
    this.lobby = ack.participants.map((p) => ({ ...p }));
    this.noteLoading(ack.loading);
    this.noteWait3d(ack.stream3dWait);
    this.noteBallEndReady(Object.fromEntries(ack.ballEndReady.map((x) => [x.playerId, x.ready])));
    const mine = ack.stances?.find((x) => x.playerId === me)?.stance;
    if (mine) this.myStance = mine;
    // Away is not gone (A18, in every phase): the row stays; the voice stays while its own connection is up.
    const members = new Set(ack.participants.map((p) => p.playerId));
    const away = new Set((ack.away ?? []).filter((id) => id !== me));
    if (this.hostIsAway && this.hostId !== null) away.add(this.hostId);
    for (const id of away) {
      if (!this.awayAt.has(id)) this.awayAt.set(id, this.opts.now());
      if (this.left.has(id)) continue;
      this.left.add(id);
      this.closeDeadMedia(id);
    }
    for (const id of [...this.awayAt.keys()]) if (!away.has(id)) this.awayAt.delete(id);
    for (const id of [...this.left]) {
      if (away.has(id)) continue;
      this.left.delete(id);
      if (members.has(id)) this.mediaBack(id);
    }
    for (const id of [...this.mediaClosed]) if (!members.has(id)) this.mediaClosed.delete(id);
    // The voice is the lobby's: everyone in it, from the join to the leave, whatever is played.
    if (!this.seriesOver) this.followLobbyVoice([...members]);
    const s = ack.start ?? null;
    this.setCountdown(s !== null && s.waitsFor === null ? (s.leftMs ?? ack.startsInMs ?? 0) : null);
    if (ack.startOff) this.flash(ack.startOff);
    // A game on this table that asked for a start: it is the match's first once a start names this player first; a
    // start that was taken away again leaves it a game of this player's own (A12's rule).
    if (this.tableAsk === 'asked' && s !== null && s.players[0] === me) this.settleTableAsk('match', null);
    else if (this.tableAsk === 'match' && s === null && (this.phase === 'lobby' || this.phase === 'over')) this.settleTableAsk('own', null);
    this.syncOwnGame();
    this.syncLobbyLock();
    this.push();
  }

  /** The lobby as its PC would say it now, read from the engine (before its first `lobby` event). */
  private lobbyOf(h: LobbyHostRole): PayloadOf<'HELLO_ACK'> {
    const members = h.members();
    const table = h.table();
    return {
      hostPlayerId: h.localId,
      hostPublicKey: h.publicKey,
      participants: members,
      hostGame: table.game,
      tableMismatches: [],
      startsInMs: null,
      loading: h.loading(),
      ballEndReady: Object.entries(h.ballEndReadiness()).map(([playerId, ready]) => ({ playerId, ready })),
      midnightModes: [],
      stream3dWait: h.stream3dWaiting(),
      hostTableObjects: null,
      stances: members.map((m) => ({ playerId: m.playerId, stance: h.stanceOf(m.playerId) ?? 'play' })),
      away: [],
      noCopy: [],
      ownGame: [],
      otherTable: [],
      tableChange: h.tableChanges(),
      tablePickedBy: table.pickedBy,
      ballsPerGame: this.opts.ballsPerGame ?? null,
      starter: h.starter(),
      match: h.openMatch(),
      start: h.announcedStart(),
    };
  }

  /** A member is here again: a connection that was closed while they were away is opened, one that is not up is made again. */
  private mediaBack(id: PlayerId): void {
    if (this.mediaClosed.delete(id)) this.wantVoice([id]);
    else if (this.voiceHeld.has(id) && !this.mediaUp(id)) this.remakeVoice(id);
  }

  /** This PC plays the game that is being played (it is in its order). A watcher, and the lobby's PC that only watches, is not. */
  private inThisGame(): boolean {
    return this.role.state.playerOrder.includes(this.localId);
  }

  /** A client that is being sent the log of a match it joined in the middle of: the events are old news, and make no sound. */
  private replaying(): boolean {
    const r = this.role;
    return this.lobbyOn && !isHostRole(r) && (r as LobbyClientRole).holdsOpenLog === false;
  }

  /** MATCH_READY of a match of the lobby: a new log, new scores, a new series; the members and their voice stay as they are. */
  private onLobbyReady(p: PayloadOf<'MATCH_READY'>): void {
    this.clearCountdown();
    this.clearMatchOver();
    this.clearPending();
    this.clearStateTimer();
    this.phase = 'playing';
    this.hostId = p.hostPlayerId;
    this.message = null;
    this.holding = null;
    this.upPlayer = null;
    this.upBall = null;
    this.myBallsDone = 0;
    this.myScore = null;
    this.clearOwed();
    this.unansweredEnd = null;
    this.scores.clear();
    this.result = null;
    this.series = null;
    this.resultGame = 0;
    // A match that begins while another is open (Start a new match) is told by MATCH_END first; a member who joined in
    // the middle of things may hear only this. Either way nothing flagged in an earlier match is this one's.
    this.clearMidnightFlags();
    // The game this table asked the start with is the match's first: it is running already (as A10's next game).
    this.tableStarted = this.heldTableStart;
    this.heldTableStart = false;
    this.beginLobbyGame(p.playerOrder);
    // Not while the log of a match that is already being played is replayed to this PC: the shell attaches the
    // media once its panel is up (`open`).
    if (!this.replaying()) void this.ensureAttached();
    this.showMidnightSetting();
    this.opts.log(`match: ${p.matchId} begins: ${p.playerOrder.map((id) => this.nameOf(id)).join(', ')}${this.inThisGame() ? '' : ' (this PC watches)'}`);
    this.push();
  }

  /**
   * A game of the lobby begins (MATCH_READY or NEXT_GAME), played by `order`. A member who is not in it reports
   * nothing from its table and is locked while it is played, unless a game of their own is running (design 11.3). Of
   * its players only the first keeps the table: their grant follows at once, and a game they began on it is this
   * game's first (a lock for the moment in between would swallow a flipper press).
   */
  private beginLobbyGame(order: readonly PlayerId[]): void {
    const me = this.localId;
    const inGame = order.includes(me);
    const first = order[0] === me;
    if (!first) {
      this.tableStarted = false;
      this.heldFeed = [];
    }
    this.tableAsk = 'none';
    if (this.tableAskTimer !== null) this.opts.clearTimeout(this.tableAskTimer);
    this.tableAskTimer = null;
    this.myGameOver = !inGame;
    // (A given-up game still on this table: the table stays this player's until their own ball: `lobbyLockWanted`.)
    if (inGame) this.setLocked(!first && !this.givenUpRuns());
    else this.syncLobbyLock();
    this.syncOwnGame();
  }

  /** What was counted for a match is forgotten; the members, the voice and the series on the panel are not. */
  private backToLobby(): void {
    this.clearCountdown();
    this.phase = 'lobby';
    this.holding = null;
    this.upPlayer = null;
    this.upBall = null;
    this.myBallsDone = 0;
    this.myScore = null;
    this.myGameOver = false;
    this.clearOwed();
    this.unansweredEnd = null;
    this.tableStarted = false;
    this.scores.clear();
    this.result = null;
    this.message = null;
    this.clearMidnightFlags();
    // The match's share (a ball end waiting for its bonus, an initials hold, the lock, "this rig sends").
    this.releaseMatch();
  }

  /**
   * A17 step 7 (the review of PR 136): the balls Midnight Madness ran on are a match's (they are keyed by game and
   * ball, and every match counts its games from 1): they go with the match, and so does the line that says one.
   */
  private clearMidnightFlags(): void {
    this.midnight = [];
    this.midnightShown = null;
    if (this.midnightTimer !== null) this.opts.clearTimeout(this.midnightTimer);
    this.midnightTimer = null;
  }

  /**
   * MATCH_END in a lobby (design 11.2, 11.6): the match is over and everyone is back in the lobby. Nobody leaves and
   * no connection closes. `abandoned`: the game that was being played was ended for everyone and has no result.
   */
  private onMatchEnded(p: PayloadOf<'MATCH_END'>): void {
    const abandoned = p.abandoned ?? null;
    const line = abandoned !== null ? `Match ended · game ${abandoned} not finished` : `Match over after ${p.games} game${p.games === 1 ? '' : 's'}`;
    this.opts.log(`match: ${line} (${p.reason}); everyone is back in the lobby`);
    this.backToLobby();
    this.clearMatchOver();
    this.matchOver = { line, until: this.opts.now() + MATCH_OVER_LINE_MS };
    this.matchOverTimer = this.opts.setTimeout(() => {
      this.matchOverTimer = null;
      this.matchOver = null;
      this.push();
    }, MATCH_OVER_LINE_MS);
    this.syncLobbyLock();
    this.syncOwnGame();
    this.push();
  }

  private clearMatchOver(): void {
    if (this.matchOverTimer !== null) this.opts.clearTimeout(this.matchOverTimer);
    this.matchOverTimer = null;
    this.matchOver = null;
  }

  /**
   * The lobby is over for this PC: its PC closed it, or did not come back, or the shell ended the wait. Nothing
   * follows: every voice connection is let go at once (nobody's microphone is sent to a person once the lobby they
   * shared is over), every table is its owner's, and a game that was being played reports nothing more.
   */
  private onLobbyOver(line: string): void {
    if (this.seriesOver) return;
    this.clearCountdown();
    this.clearLobbyTimers();
    this.hostIsAway = false;
    this.tableAsk = 'none';
    this.heldTableStart = false;
    this.heldFeed = [];
    this.clearPending();
    this.clearStateTimer();
    this.holding = null;
    this.myGameOver = true;
    this.opts.media?.setSending(false);
    this.onSeriesOver(line);
  }

  /** This PC's place in the lobby was gone when it came back: what it held of a match is put away, and `joined` follows. */
  private onRejoining(): void {
    this.opts.log("match: this PC's place in the lobby was gone when it came back; it joins again as a newcomer");
    if (this.phase !== 'lobby') this.backToLobby();
    this.hostIsAway = false;
    this.push();
  }

  /**
   * A client holds the whole log of the open match now (it joined, or came back, in the middle of it). The events
   * of the log have been played to this controller as they would have come live; what a player's own reports would
   * have counted is taken from the log.
   */
  /**
   * A17 step 8 (the review of PR 138): the lobby's PC came back with an earlier state of this match and this PC's
   * log of it was put away. What this controller counted for the match (its own balls done, its score, the grant it
   * held, a ball end it kept) is of a log that no longer exists: it is all taken from the lobby's log when that has
   * arrived (`onCaughtUp`), never the larger of the two.
   */
  private onWentBack(): void {
    this.holding = null;
    this.clearPending();
    this.clearStateTimer();
    this.unansweredEnd = null;
    this.clearOwed();
    this.myBallsDone = 0;
    this.myScore = null;
    this.myGameOver = false;
    this.scores.clear();
    this.result = null;
    this.upPlayer = null;
    this.upBall = null;
    this.opts.log("match: the lobby's PC came back with an earlier state of this match: this PC's log of it is put away, and the match goes on from the lobby's");
  }

  private onCaughtUp(): void {
    const st = this.role.state;
    const me = st.players[this.localId];
    if (me) {
      this.myBallsDone = Math.max(this.myBallsDone, me.ballsPlayed);
      if (this.myScore === null && (me.score > 0 || me.ballsPlayed > 0)) this.myScore = me.score;
      if (me.status !== 'playing') this.myGameOver = true;
      // Out of the game it came back into (counted out while away, or its last ball reported): what still runs on the
      // table is that game's rest, never a game of this player's own.
      if (me.status !== 'playing' && this.inThisGame()) this.spendForfeitedGame();
      if (me.ballsPlayed > 0 || this.tableGameRunning) this.tableStarted = true;
    }
    for (const x of Object.values(st.players)) if (!this.scores.has(x.playerId) && (x.score > 0 || x.ballsPlayed > 0)) this.scores.set(x.playerId, x.score);
    this.relock();
    this.syncOwnGame();
    this.push();
  }

  /** A client: the link to the lobby's PC has been down for longer than the grace. Nothing closes; a ball in play goes on. */
  private onHostAway(id: PlayerId): void {
    if (id !== this.hostId || this.seriesOver || this.hostIsAway) return;
    this.hostIsAway = true;
    if (!this.awayAt.has(id)) this.awayAt.set(id, this.opts.now());
    if (!this.left.has(id)) {
      this.left.add(id);
      this.closeDeadMedia(id);
    }
    this.opts.log("match: the lobby's PC is away (the link to it dropped and did not come back within the grace); waiting for it. A ball in play goes on, and its end is reported when the lobby's PC is back");
    this.tickHostAway();
    this.push();
  }

  /** The minutes left on the "away" line move by themselves. */
  private tickHostAway(): void {
    if (this.hostAwayTimer !== null) this.opts.clearTimeout(this.hostAwayTimer);
    this.hostAwayTimer = this.opts.setTimeout(() => {
      this.hostAwayTimer = null;
      if (this.closed || !this.hostIsAway) return;
      this.push();
      this.tickHostAway();
    }, 30_000);
  }

  private onHostBack(): void {
    const id = this.hostId;
    if (this.hostAwayTimer !== null) this.opts.clearTimeout(this.hostAwayTimer);
    this.hostAwayTimer = null;
    if (this.hostIsAway) this.opts.log("match: the lobby's PC is back");
    this.hostIsAway = false;
    if (id !== null) this.awayAt.delete(id);
    if (id !== null && this.left.delete(id)) this.mediaBack(id);
    this.push();
  }

  /** Design 11.8a: the one line every panel shows while the lobby's PC is away. */
  private hostAwayLine(): string {
    const r = this.role;
    const a = isHostRole(r) ? null : (r as LobbyClientRole).hostAway();
    const whole = a?.until != null ? Math.max(1, Math.round((a.until - a.since) / 60_000)) : null;
    const left = a?.until != null ? Math.max(1, Math.ceil((a.until - this.opts.now()) / 60_000)) : null;
    const what = this.phase === 'playing' || this.phase === 'paused' ? 'The match goes on when it is back' : 'The lobby goes on when it is back';
    // Step 8 (the review of PR 138): the lobby's last word was that its owner closed Castcade and keeps the lobby
    // (`HELLO_ACK.hostQuit`): said as that, not as a PC that is away for no known reason.
    if (this.ack?.hostQuit) {
      const name = this.nameOf(this.hostId);
      const kept = Math.max(1, Math.round(this.ack.hostQuit.keptMs / 60_000));
      const mins = left ?? kept;
      return `${name} closed Castcade and kept the lobby: it goes on if ${name} opens Castcade again within ${kept} minute${kept === 1 ? '' : 's'} (${mins} min left). You can wait and keep talking; Leave lobby frees your table now.`;
    }
    return `${possessive(this.nameOf(this.hostId))} PC is away. ${what}${whole !== null ? `: waiting up to ${whole} minute${whole === 1 ? '' : 's'} (${left} min left)` : ''}. You can keep talking; Leave lobby ends the wait for you.`;
  }

  /** After a return: the table is what the lobby and the turn say now. */
  private relock(): void {
    const want = this.lobbyLockWanted();
    if (want !== null) this.setLocked(want);
    else if (!this.holding) this.setLocked(true);
  }

  /**
   * The lock outside a turn (design 11.2, the table "whose table is whose"). Null: this PC plays the game that is
   * being played, and its lock follows the turn as it always did.
   * - no game is played, and a start counts down that this player is in: locked, unless a game runs on the table
   *   (the starter's own, which asked for the start; or a game of one's own, which the lobby is told);
   * - between games: the players of the open match are locked but the starter, who starts the next game on theirs;
   * - a game is played that this PC is not in (a watcher; the lobby's PC that only watches; a player who sits this
   *   game out): locked while it is played, unless a game of their own is running;
   * - anything else: the table is its owner's.
   */
  private lobbyLockWanted(): boolean | null {
    if (this.seriesOver) return false;
    const a = this.ack;
    const me = this.localId;
    const ownRunning = this.tableGameRunning && !this.spentTableGame;
    // Step 8 (the review of PR 138): the game this player gave up is still on their table: the table is theirs to
    // play it out, in every phase, whenever they are not on a ball of the match.
    if (this.givenUpRuns() && !this.holding) return false;
    if (this.phase === 'playing' || this.phase === 'paused') return this.inThisGame() ? null : !ownRunning;
    // Before the countdown's rule: this table stays locked through a countdown too, whatever runs on it.
    if (this.tableKept()) return true;
    const s = a?.start ?? null;
    if (s !== null && s.waitsFor === null && s.players.includes(me)) return !ownRunning;
    return false;
  }

  /**
   * The review of PR 136: the lobby's rule keeps this table locked whatever runs on it: between games, a player of
   * the open match who does not start the next game; during a game, a player of it whose own game is over. A game
   * on such a table is never said to the lobby as a game of its owner's (they cannot play it out, so no start may
   * wait for it), and one answer serves the lock and that word, so that the two cannot push each other back and forth.
   */
  private tableKept(): boolean {
    if (this.seriesOver) return false;
    const me = this.localId;
    if (this.phase === 'over') return this.ack?.match?.players.includes(me) === true && (this.ack.starter ?? null) !== me;
    if (this.phase === 'playing' || this.phase === 'paused') return this.inThisGame() && this.myGameDone();
    return false;
  }

  private syncLobbyLock(): void {
    if (!this.lobbyOn || this.closed) return;
    const want = this.lobbyLockWanted();
    if (want !== null) this.setLocked(want);
  }

  /**
   * A game began on this table while no grant is held (design 11.4; the handoff's item 6). The starter's, while no
   * game is played, asks for a start (`fromTable`); it is the match's first only when the lobby's PC then announces
   * a start with this player first. Anybody else's, and the starter's that is refused, is a game of their own.
   */
  private onLobbyTableStart(replay = false): void {
    const me = this.localId;
    const r = this.role;
    const noGame = this.phase === 'lobby' || this.phase === 'over';
    // A `game_start` that is not news of this moment (the witness read the journal again: Castcade or the witness
    // started in the middle of a game) is the start of a game the table has been in all along: never a request.
    if (replay || !noGame || this.seriesOver || this.tableAsk !== 'none' || (this.ack?.starter ?? null) !== me) {
      this.syncOwnGame();
      this.syncLobbyLock();
      return;
    }
    this.tableAsk = 'asked';
    // What the table says while the start counts down is this player's first ball: kept for the first grant (A18).
    this.heldTableStart = true;
    this.heldFeed = [];
    this.opts.log('match: a game started on this table, and this player is the starter: asking the lobby for a start');
    if (isHostRole(r)) {
      let no: string | null = 'the start could not be asked for';
      this.call(() => {
        no = (r as LobbyHostRole).requestStart({ fromTable: true });
      }, 'the start');
      const first = no === null && (r as LobbyHostRole).announcedStart()?.players[0] === me;
      this.settleTableAsk(first ? 'match' : 'own', no);
      return;
    }
    let sent = false;
    this.call(() => {
      sent = (r as LobbyClientRole).requestStart({ fromTable: true });
    }, 'the start');
    if (!sent) {
      this.settleTableAsk('own', null);
      return;
    }
    this.tableAskTimer = this.opts.setTimeout(() => {
      this.tableAskTimer = null;
      if (this.tableAsk === 'asked') this.settleTableAsk('own', null);
    }, TABLE_ASK_WAIT_MS);
  }

  /** The lobby's word on the game this table asked a start with: the match's first (`match`), or this player's own. */
  private settleTableAsk(verdict: 'match' | 'own', sentence: string | null): void {
    if (this.tableAskTimer !== null) this.opts.clearTimeout(this.tableAskTimer);
    this.tableAskTimer = null;
    if (verdict === 'match') {
      if (this.tableAsk === 'match') return;
      this.tableAsk = 'match';
      this.opts.log("match: the start is announced with this player first: the game on this table is the match's");
    } else {
      if (this.tableAsk === 'none') return;
      this.tableAsk = 'none';
      this.heldTableStart = false;
      this.heldFeed = [];
      this.opts.log(`match: the game on this table is this player's own, not the match's${sentence ? ` (${sentence})` : ''}`);
      if (sentence) this.flash(sentence);
      this.syncOwnGame();
    }
    this.syncLobbyLock();
    this.push();
  }

  /** A game on this table ended, or the table closed (once the event itself has been handled). */
  private afterTableGameEnd(): void {
    if (this.closed) return;
    if (this.tableAsk !== 'none') {
      // The game a start was asked with is over before the start came to anything: the start is off (A12: the next
      // Start asks again). The lobby's PC takes it away when it hears `ownGame: false` for that table.
      this.tableAsk = 'none';
      if (this.tableAskTimer !== null) this.opts.clearTimeout(this.tableAskTimer);
      this.tableAskTimer = null;
      this.heldTableStart = false;
      this.heldFeed = [];
      const r = this.role;
      try {
        if (isHostRole(r)) (r as LobbyHostRole).updateLocal({ ownGame: false });
        else if (!(r as LobbyClientRole).updateParticipant({ ownGame: false }) && this.ack?.start?.players[0] === this.localId) (r as LobbyClientRole).cancelStart();
      } catch (e) {
        this.opts.log(`match: the lobby was not told that the game on this table ended: ${e instanceof Error ? e.message : String(e)}`);
      }
      this.ownGameSaid = false;
      this.opts.log('match: the game on this table that asked for the start has ended: the start is off');
    }
    this.syncOwnGame();
    this.syncLobbyLock();
    this.push();
  }

  /**
   * The lobby is told when a game the match does not own runs on this table, and when it is over (`ownGame`): a
   * start waits for it, and the roster says OWN GAME. Not the game this player plays in the match, not the game that
   * asked for a start, and not the rest of a table game this player already finished (A16: a start never waited for it).
   */
  private syncOwnGame(): void {
    if (!this.lobbyOn || this.closed) return;
    const r = this.role;
    const playing = (this.phase === 'playing' || this.phase === 'paused') && !this.myGameOver;
    // The review of PR 136: nor a game on a table the lobby's own rule keeps locked whatever runs on it (a player of
    // the open match between games who does not start the next one; a player of this game whose game is over). Its
    // owner cannot play it out, so a start must not wait for it; the next game takes the table as it finds it.
    // Step 8: a given-up game that still runs is said too, until it ends or this player lets a start go on with it.
    const givenUp = this.givenUpRuns() && !this.givenUpReleased && !this.holding;
    const own = this.tableGameRunning && this.tableAsk === 'none' && !this.seriesOver && (givenUp || (!this.spentTableGame && !playing && !this.tableKept()));
    if (own === this.ownGameSaid) return;
    try {
      if (isHostRole(r)) (r as LobbyHostRole).updateLocal({ ownGame: own });
      else {
        // Not in yet: said at the lobby's first word.
        if (!(r as LobbyClientRole).isJoined) return;
        (r as LobbyClientRole).updateParticipant({ ownGame: own });
      }
    } catch (e) {
      this.opts.log(`match: the lobby was not told about the game on this table: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    this.ownGameSaid = own;
    this.opts.log(own ? "match: a game of this player's own is running on this table: the lobby is told, and a start waits for it to end" : "match: no game of this player's own is running on this table any more: the lobby is told");
  }

  /** A sentence of the lobby's for this player, on the panel's line for a while, and to the shell for the Match tab. */
  private flash(sentence: string): void {
    if (this.noticeTimer !== null) this.opts.clearTimeout(this.noticeTimer);
    this.notice = sentence;
    this.message = sentence;
    this.noticeTimer = this.opts.setTimeout(() => {
      this.noticeTimer = null;
      if (this.message === this.notice) this.message = null;
      this.notice = null;
      this.push();
    }, NOTICE_MS);
    try {
      this.opts.onNotice?.(sentence);
    } catch {
      /* the shell's own business */
    }
    this.push();
  }

  private clearLobbyTimers(): void {
    for (const t of [this.tableAskTimer, this.hostAwayTimer, this.matchOverTimer, this.noticeTimer]) if (t !== null) this.opts.clearTimeout(t);
    this.tableAskTimer = null;
    this.hostAwayTimer = null;
    this.matchOverTimer = null;
    this.noticeTimer = null;
  }

  /**
   * Who a start asked now would be played by, as this PC can tell from the lobby's word: the members set to Play who
   * are here and have the table; `next`: with a match open, its own players only (its next game).
   */
  private wouldPlay(next: boolean): PlayerId[] {
    const a = this.ack;
    if (!a) return [];
    const stance = new Map((a.stances ?? []).map((x) => [x.playerId, x.stance]));
    const out = new Set([...(a.away ?? []), ...(a.noCopy ?? [])]);
    const ids = a.participants.map((x) => x.playerId).filter((id) => stance.get(id) !== 'watch' && !out.has(id));
    const match = a.match ?? null;
    return next && match ? ids.filter((id) => match.players.includes(id)) : ids;
  }

  private namesOf(ids: readonly PlayerId[], me = 'you'): string {
    const names = ids.map((id) => (id === this.localId ? me : this.nameOf(id)));
    return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  }

  /** "MekelburgJ 1 win, Krobs 1": the open match's tally, or '' before its first result. */
  private tallyWords(plain = false): string {
    const s = this.series;
    if (!s || s.length === 0) return '';
    return [...s]
      .sort((a, b) => a.rank - b.rank || b.wins - a.wins)
      .map((x, i) => `${this.nameOf(x.playerId)} ${x.wins}${i === 0 && !plain ? (x.wins === 1 ? ' win' : ' wins') : ''}`)
      .join(', ');
  }

  /** The announced start in one line (design 11.9): who starts what with whom, or what it waits for. Null: none. */
  private startLine(): string | null {
    const s = this.ack?.start ?? null;
    if (!s) return null;
    const me = this.localId;
    const by = s.by === me ? 'You start' : `${this.nameOf(s.by)} starts`;
    const what = s.newMatch ? 'the match' : 'the next game';
    // The review of PR 136: the countdown has run out and the start is still announced: the lobby's PC holds it while
    // a player of it is inside the grace of a dropped link (A18). Said, as it was before the lobby, so that nobody
    // looks at a countdown standing at 0.
    if (s.waitsFor === null && this.countdownHeld()) return `${by} ${what} in a few seconds (a player's link dropped a moment ago: waiting to see whether they are back)`;
    if (s.waitsFor === null) return `${by} ${what}: ${s.players.map((id) => (id === me ? 'you' : this.nameOf(id))).join(', ')}`;
    const on = s.waitsOn;
    const whose = on.map((id) => (id === me ? 'your' : possessive(this.nameOf(id)))).join(', ');
    const many = on.length > 1;
    switch (s.waitsFor) {
      case 'result':
        return `${by} ${what} once the last game's result is out`;
      case 'tables':
        return `${by} ${what} once ${whose} table${many ? 's are' : ' is'} open`;
      case 'other_tables': {
        // Design 11.4: "…once Krobs has Monster Bash open (he has Congo open)": by name where this PC was told both
        // names (one person, and the lobby said which table differs); never a guess at "he" or "she".
        // (Both names come from other PCs: cleaned before they are shown.)
        const clean = (name: string | null | undefined): string | null => (name ? tableWords(name) || null : null);
        const wanted = clean(this.ack?.hostGame?.tableName);
        const open = !many && on[0] !== undefined ? clean(this.ack?.tableMismatches.find((x) => x.playerId === on[0])?.mismatches.find((x) => x.field === 'tableName')?.received) : null;
        if (wanted !== null && open !== null && open !== wanted) return `${by} ${what} once ${this.namesOf(on)} ${on[0] === me ? 'have' : 'has'} ${wanted} open (${open} is open there)`;
        return `${by} ${what} once ${this.namesOf(on)} ${many || on[0] === me ? 'have' : 'has'} the lobby's table open (another table is open there)`;
      }
      case 'own_games':
        return `${by} ${what} once the game on ${whose} table${many ? 's' : ''} has ended`;
      default:
        // I11.4.9's words: for whose connection, for how long at most, and what a second press costs.
        return `${by} ${what} once ${this.wait3dWords(on)} is up (${Math.round(this.holdMs() / 1000)} s at most; started without it, the first turn may be the 2D video)`;
    }
  }

  /** The lobby's line while no game is played and no start counts down (design 11.9): who starts, and how. */
  private lobbyLine(): string {
    const a = this.ack;
    const me = this.localId;
    const over = this.matchOver !== null && this.opts.now() < this.matchOver.until ? `${this.matchOver.line} · ` : '';
    if (!a) return 'Joining the lobby';
    const waiting = this.startLine();
    if (waiting !== null) return `${over}${waiting}`;
    const between = this.phase === 'over' && (a.match ?? null) !== null;
    const players = this.wouldPlay(between);
    const warn = this.unreadableLines();
    const warned = warn.length > 0 ? ` · ${warn.join(' · ')}` : '';
    const loading = players.filter((id) => this.loadingIds.includes(id)).map((id) => (id === me ? 'your' : possessive(this.nameOf(id))));
    const loads = loading.length > 0 ? ` · ${loading.join(', ')} table${loading.length > 1 ? 's are' : ' is'} not open yet` : '';
    if (players.length < 2) {
      const only = players.length === 1 ? (players[0] === me ? 'only you are' : `only ${this.nameOf(players[0] as PlayerId)} is`) : 'nobody is';
      return `${over}Waiting for a second player: ${only} set to Play${between ? ' in this match' : ''}${warned}`;
    }
    if (this.myStance === 'watch') return `${over}You are set to Watch: the ${between ? 'next game' : 'match'} starts without you${loads}`;
    if (!players.includes(me)) {
      const why = (a.noCopy ?? []).includes(me) ? "Castcade found no copy of the lobby's table on this PC: you can watch" : between ? 'You are watching this match: you are in when somebody starts a new match' : 'You are not in the next match';
      return `${over}${why}${loads}`;
    }
    const starter = a.starter ?? null;
    const word = between ? 'Next game' : 'Start match';
    // A12's rule, for the starter: a game that is running on their table is their own; the next Start on it asks.
    if (starter === me && this.ownGameSaid) return `${over}${between ? 'Next game' : 'Everyone in?'}${between ? ':' : ''} Finish the game on your table, then start a game on it (or ${word} in the menu)${loads}${warned}`;
    if (starter === me) return `${over}${between ? 'Next game: start a game on your table' : 'Everyone in? Start a game on your table'} (or ${word} in the menu)${loads}${warned}`;
    if (starter !== null) {
      const who = this.nameOf(starter);
      return `${over}${between ? `Next game: ${who} starts a game on their table` : `${who} starts the match from their table`}. To start it yourself: ${word} in the menu${loads}${warned}`;
    }
    return `${over}${word} in the menu starts it${loads}${warned}`;
  }

  /** The lobby for the Match tab and the menu (`ControllerStatus.lobby`); null when the role is no lobby's. */
  private lobbyStatus(): LobbyStatus | null {
    if (!this.lobbyOn) return null;
    const a = this.ack;
    const me = this.localId;
    const r = this.role;
    const stanceOf = new Map((a?.stances ?? []).map((x) => [x.playerId, x.stance]));
    const has = (list: readonly PlayerId[] | undefined, id: PlayerId): boolean => (list ?? []).includes(id);
    const match = a?.match ?? null;
    const starter = a?.starter ?? null;
    const members = this.lobby.map((p) => {
      const id = p.playerId;
      const flags: LobbyFlag[] = [];
      if (this.left.has(id) || has(a?.away, id)) flags.push('away');
      if (has(a?.noCopy, id)) flags.push('no_table');
      else if (has(a?.otherTable, id)) flags.push('other_table');
      else if (this.loadingIds.includes(id)) flags.push('loading');
      // Step 10: where their PC stands on its way to the lobby's table.
      const way = (a?.tableChange ?? []).find((x) => x.playerId === id)?.state ?? null;
      if (has(a?.ownGame, id) || way === 'waits_game') flags.push('own_game');
      if (way === 'waits_person') flags.push('close_table');
      else if (way === 'offered') flags.push('asked');
      else if (way === 'closing' || way === 'opening') flags.push('changing');
      return { id, name: p.displayName, rig: p.rig, stance: id === me ? this.myStance : (stanceOf.get(id) ?? 'play'), opener: id === this.hostId, me: id === me, starter: starter === id, inMatch: match?.players.includes(id) ?? false, flags, awaySince: flags.includes('away') ? (this.awayAt.get(id) ?? null) : null };
    });
    const game = this.phase === 'playing' || this.phase === 'paused';
    const between = this.phase === 'over' && match !== null;
    const s = a?.start ?? null;
    const players = this.wouldPlay(between);
    const everyone = this.wouldPlay(false);
    const watchers = this.lobby.map((p) => p.playerId).filter((id) => !players.includes(id));
    const outside = between && match ? everyone.filter((id) => !match.players.includes(id)) : [];
    const tally = this.tallyWords();
    // Design 11.9: the two lines under the start button name everyone, this person too ("MekelburgJ and Krobs play.
    // ChuckRibbits watches.", "Dana plays too."): they stand beside the roster, which says who "(you)" is.
    const own = this.nameOf(me);
    // Design 11.9: "The match that is open ends at MekelburgJ 2, Krobs 1." (the numbers alone).
    const endsAt = this.tallyWords(true);
    let off: string | null = null;
    if (this.seriesOver) off = 'The lobby is closed.';
    else if (this.hostIsAway) off = "The lobby's PC is away.";
    else if (!a) off = 'Joining the lobby.';
    else if (game) off = 'A game is being played.';
    else if (s !== null) off = 'A start is under way.';
    else if (players.length < 2) off = between ? 'Two players of this match have to be set to Play.' : 'Two people have to be set to Play.';
    const line = between && match ? `Game ${match.game + 1} of this match.${tally ? ` ${tally}.` : ''}` : players.length >= 2 ? `${this.namesOf(players, own)} play.${watchers.length > 0 ? ` ${this.namesOf(watchers, own)} ${watchers.length === 1 ? 'watches' : 'watch'}.` : ''}` : '';
    // Step 10: the lobby's table, and why it cannot be changed now (the lobby's PC judges a pick by the same rules).
    // (While nobody has picked, `hostGame` is whatever the lobby's PC says of a table it has not open: no table.)
    const pick = a?.hostGame ?? null;
    const pickedBy = a?.tablePickedBy ?? null;
    const named = pick !== null && pickedBy !== null && pick.tableName.trim() !== '' ? tableWords(pick.tableName) : null;
    let pickOff: string | null = null;
    if (this.seriesOver) pickOff = 'The lobby is closed.';
    else if (this.hostIsAway) pickOff = "The lobby's PC is away.";
    else if (!a) pickOff = 'Joining the lobby.';
    else if (game) pickOff = 'A game is being played: the table changes after it.';
    else if (s !== null) pickOff = 'A match is starting: cancel the start to change the table.';
    return {
      stance: this.myStance,
      starter,
      members,
      match: match ? { id: match.matchId, game: match.game, state: match.state, players: [...match.players] } : null,
      table: { name: named, pickedBy, pickedByName: pickedBy !== null && this.lobby.some((p) => p.playerId === pickedBy) ? this.nameOf(pickedBy) : null, off: pickOff, endsMatch: between, changing: !game && (a?.tableChange ?? []).some((x) => x.state === 'closing' || x.state === 'opening') },
      gameKey: match ? `${match.matchId}/${match.game}/${match.state}` : '',
      start: s ? { by: s.by, players: [...s.players], newMatch: s.newMatch, waitsFor: s.waitsFor, waitsOn: [...s.waitsOn], seconds: s.waitsFor === null ? this.countdownSeconds() : null, line: this.startLine() ?? '' } : null,
      startButton: { label: between ? 'Next game' : 'Start match', line, off },
      newMatch:
        outside.length > 0 && everyone.length >= 2 && s === null && !this.seriesOver && !this.hostIsAway
          ? { line: `${this.namesOf(outside, own)} ${outside.length === 1 ? 'plays' : 'play'} too. The match that is open ends${endsAt ? ` at ${endsAt}` : ''}.`, warnings: this.unreadableLines(this.unreadableAmong(everyone)) }
          : null,
      startWithout:
        s !== null && s.waitsFor !== null && s.waitsFor !== 'result'
          ? s.waitsFor === '3d'
            ? 'Start without 3D'
            : s.waitsFor === 'own_games' && s.waitsOn.length === 1 && s.waitsOn[0] === me && this.givenUpRuns()
              ? 'Start now: I play that game out at my turn'
              : `Start without ${this.namesOf(s.waitsOn)}`
          : null,
      end: this.seriesOver || this.hostIsAway ? null : between ? 'match' : game && isHostRole(r) ? 'everyone' : null,
      giveUp: game && this.inPlay() && !this.myGameDone(),
      hostAway: this.hostIsAway && !isHostRole(r) ? (r as LobbyClientRole).hostAway() : null,
      over: this.seriesOver,
    };
  }

  /** The lobby's rows, the starter and this player's own choice on the panel (nothing without a lobby). */
  private panelLobby(): Pick<PanelState, 'members' | 'starter' | 'stance' | 'changingTable'> {
    const l = this.lobbyStatus();
    if (!l) return {};
    return {
      members: l.members.map((m) => ({ id: m.id, name: m.name, stance: m.stance, flags: [...m.flags], inMatch: m.inMatch })),
      starter: l.starter,
      stance: l.stance,
      // Step 10: tables are being changed: the header names the lobby's table (the key is absent otherwise).
      ...(l.table.changing && l.table.name !== null ? { changingTable: l.table.name } : {}),
    };
  }

  /**
   * A17 step 7 (design 11.4): ask for a start (the Match tab's button, the menu's line): the match, the next game
   * of the open match, a new match (`newMatch`), with a table that cannot report ball ends (`anyway`), or without
   * what an announced start waits for (`now`). Null: asked (the lobby's PC announces the start, or answers with a
   * sentence that comes as a notice); a sentence: not taken, and why (the lobby's PC knows at once).
   */
  requestStart(ask: StartAsk = {}): string | null {
    if (!this.lobbyOn || this.closed) return 'There is no lobby';
    if (this.seriesOver) return 'The lobby is closed.';
    const r = this.role;
    // Step 8: the start waits for the game this player gave up, and this player says "go on": the lobby is no longer
    // told of that game, so the start counts down with them in it; at their turn they are told what to do on the table.
    const s = this.ack?.start ?? null;
    if (ask.now && this.givenUpRuns() && !this.givenUpReleased && s?.waitsFor === 'own_games' && s.waitsOn.includes(this.localId)) {
      this.givenUpReleased = true;
      this.opts.log('match: the start waited for the game I gave up, which is still on my table; I let it go on: I play that game out at my turn');
      this.syncOwnGame();
      this.push();
      return null;
    }
    let no: string | null = 'The start could not be asked for';
    this.call(() => {
      if (isHostRole(r)) no = (r as LobbyHostRole).requestStart(ask);
      else no = (r as LobbyClientRole).requestStart(ask) ? null : 'This PC is not in the lobby yet';
    }, 'the start');
    if (no !== null) this.opts.log(`match: the start was not taken: ${no}`);
    return no;
  }

  /** A17 step 7: take back the start that counts down or waits (anybody may). Null: asked; a sentence: there was none. */
  cancelStart(): string | null {
    if (!this.lobbyOn || this.closed || this.seriesOver) return 'There is no lobby';
    const r = this.role;
    let no: string | null = 'The start could not be cancelled';
    this.call(() => {
      if (isHostRole(r)) no = (r as LobbyHostRole).cancelStart();
      else no = (r as LobbyClientRole).cancelStart() ? null : 'This PC is not in the lobby yet';
    }, 'the cancel');
    return no;
  }

  /**
   * A17 step 7 (design 11.2): End match. Between games anyone may: the tally is final and everyone stays in the
   * lobby. During a game only the lobby's PC, and it is End match for everyone: that game has no result (the shell
   * confirms the press). Null: asked; a sentence: why not.
   */
  requestEnd(): string | null {
    if (!this.lobbyOn || this.closed || this.seriesOver) return 'There is no lobby';
    const r = this.role;
    let no: string | null = 'The match could not be ended';
    this.call(() => {
      if (isHostRole(r)) no = (r as LobbyHostRole).requestEnd();
      else no = (r as LobbyClientRole).requestEnd() ? null : 'This PC is not in the lobby yet';
    }, 'the end of the match');
    return no;
  }

  /**
   * A17 step 10 (design 11.5): pick the lobby's table: its identity keys, and the Castcade VPX build's identity of
   * this PC's copy when it is known. Anyone may, outside a game and while no start is announced; between games the
   * open match ends at its tally (the shell asked first). Null: asked (the lobby's PC announces it, or answers with
   * a sentence that comes as a notice); a sentence: not taken, and why (the lobby's PC knows at once).
   */
  pickTable(game: GameFingerprint, objects: { editables: number; hash: string } | null): string | null {
    if (!this.lobbyOn || this.closed || this.seriesOver) return 'There is no lobby';
    const r = this.role;
    let no: string | null = "The lobby's table could not be changed";
    this.call(() => {
      if (isHostRole(r)) no = (r as LobbyHostRole).pickTable(game, r.localId, objects);
      else no = (r as LobbyClientRole).pickTable(game, objects) ? null : 'This PC is not in the lobby yet';
    }, 'the table pick');
    if (no !== null) this.opts.log(`match: the lobby's table was not changed: ${no}`);
    return no;
  }

  /**
   * A17 step 10: where this PC stands on its way to the lobby's table after a change of it (the shell knows: it is
   * the one that closes and opens tables), and the sentence for this PC's own panel while it waits (null: none). The
   * lobby is told when the state changed, so every row and every header says it. A client that is not in yet is not
   * recorded as having said it: the shell says it again at its next look.
   */
  setTableChange(state: TableChange | null, line: string | null): void {
    if (!this.lobbyOn || this.closed) return;
    let changed = line !== this.tableChangeLine;
    this.tableChangeLine = line;
    if (state !== this.tableChangeSaid && !this.seriesOver) {
      const r = this.role;
      let said = false;
      this.call(() => {
        if (isHostRole(r)) {
          (r as LobbyHostRole).updateLocal({ tableChange: state });
          said = true;
        } else if ((r as LobbyClientRole).isJoined) {
          (r as LobbyClientRole).updateParticipant({ tableChange: state });
          said = true;
        }
      }, 'the table change');
      if (said) {
        this.tableChangeSaid = state;
        changed = true;
        this.opts.log(state === null ? "match: this PC has nothing more to say about the change of the lobby's table: the lobby is told" : `match: this PC's way to the lobby's table: ${state.replace('_', ' ')}: the lobby is told`);
      }
    }
    if (changed) this.push();
  }

  /**
   * A17 step 10 (review of PR 139, finding 1): this PC's open table is its own copy of the lobby's table (`word`: the
   * lobby's table by its name, and this PC's table as its row names it), or is not (null). The shell knows: it finds
   * the copy, by rules a row cannot carry (a ROM its lists know). The lobby is told when the word changed; a client
   * that is not in yet is not recorded as having said it, and the shell says it again at its next look.
   */
  setPickCopy(word: PickCopyWord | null): void {
    if (!this.lobbyOn || this.closed || this.seriesOver) return;
    const text = JSON.stringify(word);
    if (text === this.pickCopySaid || (word === null && this.pickCopySaid === undefined)) return;
    const r = this.role;
    let said = false;
    this.call(() => {
      if (isHostRole(r)) {
        (r as LobbyHostRole).updateLocal({ pickCopy: word });
        said = true;
      } else if ((r as LobbyClientRole).isJoined) {
        (r as LobbyClientRole).updateParticipant({ pickCopy: word });
        said = true;
      }
    }, 'the copy of the table');
    if (!said) return;
    this.pickCopySaid = text;
    this.opts.log(word === null ? "match: this PC's open table is no longer said to be its copy of the lobby's table" : `match: the lobby is told that this PC's open table (${tableWords(word.tableName)}) is its copy of ${tableWords(word.pick)}`);
  }

  /** A17 step 7 (design 11.3): this player's own choice, Play or Watch; it counts from the next start. */
  setStance(stance: Stance): void {
    if (!this.lobbyOn || this.closed || this.seriesOver || stance === this.myStance) return;
    const r = this.role;
    this.call(() => {
      if (isHostRole(r)) (r as LobbyHostRole).updateLocal({ stance });
      else (r as LobbyClientRole).updateParticipant({ stance });
    }, 'Play / Watch');
    this.myStance = stance;
    this.opts.log(`match: this player is set to ${stance === 'play' ? 'Play' : 'Watch'}; it counts from the next start`);
    this.push();
  }

  /** A17 step 7: a sentence of the shell's for this player, on the panel's line for a while (as the lobby's own sentences are). */
  notify(sentence: string): void {
    if (this.closed) return;
    this.flash(sentence);
  }

  /**
   * A17 step 7: a Castcade that started again is back in the match it was in (the shell checked that it is the same
   * match): what its table still owed that match (`owedTableEnds` of the saved record) counts again, checked against
   * the log at its first use, as after `restore`.
   */
  takeOwed(seqs: readonly number[]): void {
    if (this.closed) return;
    this.owedSeqs = [...seqs].filter((n) => Number.isSafeInteger(n) && n > 0).slice(0, 16);
    this.owedFromRecord = this.owedSeqs.length > 0;
  }

  /**
   * A17 step 7: the lobby's PC passed this player's turn while Castcade was closed (a TURN_PASS the saved log did
   * not hold yet). The same rule as for a pass that arrives live (`onTurnPassed`): with this table's ball still in
   * play, the table owes the match that ball's end, and its drain reports nothing.
   */
  passedWhileAway(p: { grantSeq: number; ballNumber: number }): void {
    if (this.closed || this.owedSeqs.includes(p.grantSeq) || !this.tableOwesAfter(p.ballNumber)) return;
    this.owedSeqs.push(p.grantSeq);
    this.opts.log("match: the turn was passed with this table's ball still in play, while Castcade was closed: the table owes the match that ball end; the ball is played out at this player's next turn, and its end reports nothing");
    this.push();
  }

  /** A17 step 7 (design 11.2): Give up this game: this player's own game ends with a FORFEIT; they stay in the lobby and watch. */
  giveUp(): boolean {
    if (this.closed || !this.inPlay() || this.myGameDone()) return false;
    this.forfeit('gave up the game');
    return true;
  }

  // ------------------------------------------------------------------------------------------
  // Panel
  // ------------------------------------------------------------------------------------------

  private participants(): ParticipantInfo[] {
    const st = this.role.state;
    // A17 step 7: in a lobby the people are the members, in every phase (the lobby's own word has their rigs as they are).
    if (st.phase === 'lobby' || this.lobbyOn) return this.lobby;
    if (this.liveRigs.size === 0) return st.participants;
    return st.participants.map((p) => {
      const rig = this.liveRigs.get(p.playerId);
      return rig && rig !== p.rig ? { ...p, rig } : p;
    });
  }

  private nameOf(id: PlayerId | null): string {
    if (id === null) return '?';
    // A17 step 7: a player of the open match who has left the lobby is still named in its roster.
    return this.participants().find((p) => p.playerId === id)?.displayName ?? this.role.state.participants.find((p) => p.playerId === id)?.displayName ?? id;
  }

  /** The panel's rows: the players of the open match (A17 step 7: a lobby's members while no match is open). */
  private panelRows(): ParticipantInfo[] {
    const st = this.role.state;
    if (!this.lobbyOn || st.phase === 'lobby') return this.participants();
    return st.participants.map((p) => this.lobby.find((m) => m.playerId === p.playerId) ?? p);
  }

  panel(): PanelState {
    const st = this.role.state;
    const players = this.panelRows().map((p) => {
      const prog = st.players[p.playerId];
      const flags: PanelState['players'][number]['flags'] = [];
      const words = mismatchWords(this.mismatch.get(p.playerId) ?? []);
      if (words.table) flags.push('table_mismatch');
      if (words.build) flags.push('build_mismatch');
      if (this.left.has(p.playerId) || prog?.connected === false) flags.push('disconnected');
      if (this.phase === 'lobby' && this.loadingIds.includes(p.playerId)) flags.push('loading');
      // B26: Midnight Madness ran on one of this player's balls of this game.
      if (this.phase !== 'lobby' && this.midnightBalls(p.playerId).length > 0) flags.push('midnight');
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
      ballsPerGame: st.ballsPerGame || (this.opts.ballsPerGame ?? this.ack?.ballsPerGame ?? 0),
      players,
      phase,
      // B26: the result row of a player with a flagged ball is marked (the key is absent otherwise).
      result: this.result ? this.result.map((r) => (this.midnightBalls(r.id).length > 0 ? { ...r, flags: ['midnight' as const] } : r)) : null,
      message: this.panelMessage(),
      mic: this.opts.media?.status().mic ?? 'unavailable',
      // A17 step 4: who a disconnect pause waits for (the key is absent otherwise).
      ...(this.phase === 'paused' && st.paused?.reason === 'disconnect' && st.paused.player ? { pausedFor: st.paused.player } : {}),
      // A17 step 7: the lobby's rows, the starter and this player's own choice (the keys are absent without a lobby).
      ...this.panelLobby(),
    };
  }

  private panelMessage(): string | null {
    // A17 step 1: a lobby this PC has lost says so, over anything else (`onLobbyLost`).
    if (this.phase === 'lobby' && this.seriesOver) return this.seriesOverLine;
    // A17 step 7: a lobby that is over says so in every phase; and the lobby's PC away is the line that matters.
    if (this.lobbyOn && this.seriesOver) return this.seriesOverLine;
    if (this.lobbyOn && this.hostIsAway) return this.hostAwayLine();
    if (this.message) return this.message;
    // Step 8 (the review of PR 138): the game this player gave up is still on their table: what to do about it, in
    // place of "Press Start on the table" (which cannot work while it runs) and of the line of somebody who waits.
    if (this.lobbyOn && this.givenUpRuns() && !this.initialsHold) {
      if (this.phase === 'playing' && this.holding) return GIVEN_UP_AT_TURN;
      if (!this.givenUpReleased) return GIVEN_UP_WAIT;
    }
    // A16.2: the one thing to do right now, over the turn and result lines.
    if (this.initialsHold) return INITIALS_HOLD_MESSAGE;
    // A17 step 10: what this PC is waiting for before it opens the lobby's table (its person may have to act).
    if (this.lobbyOn && this.tableChangeLine && (this.phase === 'lobby' || this.phase === 'over') && this.countdownSeconds() === null) return this.tableChangeLine;
    // The review of PR 131: this player's turn, and the ball they ended by hand is still on the table.
    if (this.phase === 'playing' && this.holding && this.owedSeqs.length > 0 && !this.owedFromRecord) return owedBallLine(this.owedSeqs.length, this.holding.ballNumber);
    // B26: a ball just flagged for Midnight Madness, for a while (over the table note, which stays all match).
    if (this.midnightShown && this.opts.now() < this.midnightShown.until && this.phase !== 'lobby') return this.midnightShown.line;
    // B26.4: at a game's start, for a while: the mode is ON on a table. Beside the prompt of the player who starts, never over it.
    const pressStart = this.phase === 'playing' && !!this.holding && this.holding.ballNumber === 1 && this.myScore === null && !this.tableStarted;
    const setting = this.phase === 'playing' && this.opts.now() < this.midnightSettingUntil ? this.midnightSetting() : null;
    if (setting) return pressStart ? `${PRESS_START_MESSAGE} · ${setting}` : setting;
    // The table line, grouped by what differs. A VPX build difference alone is a muted flag on the player's row, not
    // this line: it would hold the line for the whole match and hide the turn prompts (D2.5, 2026-10-31).
    const byWhat = new Map<string, string[]>();
    for (const [id, fields] of this.mismatch) {
      // A17 step 7: a member whose table is not open has no table that could differ: their row says LOADING.
      if (this.lobbyOn && this.loadingIds.includes(id)) continue;
      const what = mismatchWords(fields).table;
      if (what) byWhat.set(what, [...(byWhat.get(what) ?? []), id === this.localId ? 'you' : this.nameOf(id)]);
    }
    const st = this.role.state;
    // I11.4.12: the shell's note rides on whatever the lobby says (not on the countdown).
    const note = this.phase === 'lobby' && this.lobbyNote ? ` · ${this.lobbyNote}` : '';
    // A11: the countdown is the one line that matters in the lobby, over a table note.
    const count = this.countdownSeconds();
    if (count !== null && this.lobbyOn) return this.startLine() ?? 'A match is starting';
    if (count !== null) return `Starting the match: ${this.participants().map((p) => (p.playerId === this.localId ? 'you' : p.displayName)).join(', ')}`;
    // A17 step 7: outside a game a lobby's line says who starts and how; a table that differs is said after it.
    if (this.lobbyOn && (this.phase === 'lobby' || this.phase === 'over')) {
      const tables = [...byWhat].map(([what, who]) => `${what}: ${who.join(', ')}`).join(' · ');
      return `${this.lobbyLine()}${tables ? ` · ${tables}${this.phase === 'lobby' && this.files3d ? ` · ${FILES_GIVE_3D}` : ''}` : ''}${this.lobbyNote ? ` · ${this.lobbyNote}` : ''}`;
    }
    // A13: in the lobby a table that cannot report ball ends is the line that matters (the lobby line names it).
    if (byWhat.size > 0 && this.phase !== 'over' && !(this.phase === 'lobby' && (this.loadingIds.length > 0 || this.unreadableIds().length > 0 || (this.wait3dStatus().armed !== null && this.wait3dNow().ids.length > 0)))) {
      const line = [...byWhat].map(([what, who]) => `${what}: ${who.join(', ')}`).join(' · ');
      // I11.4.15: before the start, where the files differ and 3D runs all the same: said where the player looks.
      return this.phase === 'lobby' ? `${line}${this.files3d ? ` · ${FILES_GIVE_3D}` : ''}${note}` : line;
    }
    if (this.phase === 'lobby') return `${this.lobbyMessage()}${note}`;
    if (this.phase === 'over') {
      if (this.seriesOver) return this.seriesOverLine;
      // A18: asked for, and held for a player whose link dropped a moment ago.
      if (this.nextGameHeld) return "Next game: starting in a few seconds (a player's link dropped a moment ago: waiting to see whether they are back)";
      return isHostRole(this.role) ? 'Next game: start a game on your table (or press Next game)' : `Next game: ${this.nameOf(this.hostId)} starts a game on the table`;
    }
    if (this.phase === 'paused') {
      const who = st.paused?.player ?? null;
      // A17 step 7 (design 11.8): the words of a lobby; the place is kept, and the game waits at their own turn.
      if (this.lobbyOn && st.paused?.reason === 'disconnect' && who) return who === this.localId ? 'The game waits for you: this PC was away from the lobby' : `Waiting for ${this.nameOf(who)} to come back`;
      return st.paused?.reason === 'disconnect' && who ? `Paused: waiting for ${this.nameOf(who)} to reconnect` : 'Paused';
    }
    if (pressStart) return PRESS_START_MESSAGE;
    if (this.phase === 'playing' && this.lobbyOn && !this.inThisGame()) return null;
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
    // I11.4.9: the start is held for a 3D connection: say for whose, for how long at most, and how to start now.
    const w = this.wait3dNow();
    const armed = this.wait3dStatus().armed;
    if (w.ids.length > 0 && armed !== null) {
      return `The match starts once ${this.wait3dWords(w.ids)} is up, or in ${w.seconds} s (${armed === 'tab' ? 'Start match again' : 'Start match on the Match tab'} starts it now; the first turn may then be the 2D video)${warned}`;
    }
    if (warn.length > 0) return `${warn.join(' · ')}${host ? ' · Start match on the Match tab starts anyway; Pass the turn then ends such a ball by hand' : ''}`;
    if (host && this.waitingForHostGame) return 'Everyone is in: finish the game on your table, then press Start on it to start the match';
    // No start is held: the line says what a start would wait for and does not change by itself (D8.9: a line that
    // counted seconds would keep the headset's lobby panel up).
    const making = w.ids.length > 0 ? ` · ${this.wait3dWords(w.ids)} is still being made (${host ? 'a start' : 'the start'} waits for it, ${Math.round(this.holdMs() / 1000)} s at most)` : '';
    return host ? `Everyone in? Start a game on your table (or press Start match)${making}` : `Waiting for ${this.nameOf(this.hostId)} to start a game on the table${making}`;
  }

  private push(force = false): void {
    if (this.closed && !force) return;
    const panel = this.panel();
    const text = JSON.stringify(panel);
    // A8: a transfer proposal is on the Match tab only, not the panel; the tab hears of it all the same. A13: so are
    // the ball-end readiness of each player and the turn the host may pass.
    const transfer = JSON.stringify([this.transfer(), this.ballEnds(), this.passInfo(), this.initialsHold, this.advisoryLines(), this.wait3dStatus(), this.endBallInfo(), this.owedSeqs, this.lobbyOn ? this.lobbyStatus() : null, this.ownGameSaid]);
    if (!force && text === this.lastPanel && transfer === this.lastTransfer) return;
    this.lastTransfer = transfer;
    if (force || text !== this.lastPanel) this.opts.media?.setPanelState(panel);
    this.lastPanel = text;
    const s = this.status();
    for (const l of [...this.listeners]) l(s);
  }
}
