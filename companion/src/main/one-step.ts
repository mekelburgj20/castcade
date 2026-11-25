/**
 * A14 (2026-11-12): one step to a match. The owner, about hosting: "start VPX, launch the table, switch views back to
 * desktop, Host session, copy code, paste code in Discord, wait … then switch view back to VR table, then play. It's
 * really clunky … and if any of that is out of order, things seem to fail." This module sits beside the match host
 * (`match-host.ts`), which it only calls:
 *
 * - **Host**: `host({ tablePath })` hosts the match, copies the join link (`castcade://join/<invite>`) to the
 *   clipboard and starts VPX on the picked table. A table that is already open is used as it is and nothing is started.
 *   A14.7 (2026-11-15): the table start is its own step unless `startTable` is set. The owner: "when you click host,
 *   you are put in to VR view. You have to exit out of VR to copy the code and paste it in to Discord." So Host gives
 *   the invite and holds the picked table (`tableToStart`); `startTable()` starts it once the invite is sent.
 * - **A link** (`openLink`, from the command line of a first or second instance; `joinLink`, pasted on the Match tab):
 *   joins that match with the saved name and starts the host's table on this PC. The table is looked up here
 *   (`launch/find-table.ts`) from what the host announced (`HELLO_ACK.hostGame`); none here → the Match tab says which
 *   table is needed and the player stays joined. A link that came from outside while the Match tab was not showing
 *   waits for one click (`confirm`): a web page must not join a match (the microphone goes live) or start a game by
 *   itself.
 * - **Any order**: what is still to be started is a wish (`want`), settled by `reconcile` on every match and witness
 *   status: the host's table may open after the join (the wish waits for the host's fingerprint), a table may already
 *   be open (nothing is started), VPX may take a minute (the wish is not repeated), the match may end first (dropped).
 * - **A table that is open and wrong** (A17 step 3, 2026-11-25, alpha-match.md section 11.5): the wish also learns
 *   that the lobby's table can change while another table is open here. At the join nothing changes: a table that is
 *   already open is kept. When the lobby's table then changes from one named table to another, this PC's copy of the
 *   new one is found by the same rules as at a join, and then, in this order: no copy, nothing closes and the PC says
 *   so; the open table is itself a copy of the new game, it is kept; "Change tables for me" is off, the Match tab
 *   offers Open it; a table Castcade cannot follow (the witness in basic mode: no hook journal, so nobody knows
 *   whether a game is on) is never closed by Castcade, the person is asked to; a game on the open table, its ending or
 *   the entry of its high-score initials is waited for; otherwise the open table is asked to close
 *   (`launch/vpx-close.ts`: never by force) and the copy is started the way a match table is. What is left of a
 *   change while the open table stands is `swap`; `status().change` says it to the Match tab. What is followed is
 *   the lobby's table as the engine holds it since step 6: a pick (`MatchHost.lobbyTable`), the same on every PC,
 *   and never `hostGame()`, which is a match's own table once one has started.
 *
 *   The rule that decides every doubtful case (review of PR 137): **when Castcade is not sure, it asks the person and
 *   closes nothing.** So:
 *   - a change is only a table that somebody picked while this PC was in the lobby. Every join and every join again
 *     (a lobby its PC opened again under the same code, a place that ran out, a reconnect, a resume) takes the
 *     lobby's table as it finds it and keeps the table that is open (`lobbyTable().joined`). The lobby's default
 *     table (what its PC has open, or opens first) is never a change: in the engine a pick, once made, is only
 *     changed by `pickTable`, which a person's TABLE_PICK reaches (the shell sends one from step 10 on);
 *   - "Castcade follows the table" means the witness has evidence that a game on it would be seen
 *     (`WitnessStatus.gamesSeen`), not that a journal is read;
 *   - the process that is asked is the one VPX that is open, the one the witness names the table from; with two
 *     VPX open, or none it can name, the person is asked;
 *   - after a game whose score cannot be compared with a list, the table is left for the initials as long as after
 *     one whose score made the list;
 *   - a request that is out cannot be taken back: when its table closes after the change was taken back (the
 *     lobby's table changed again, the lobby was left), the lobby's table as it is then is opened, or, with no lobby,
 *     the tab says what happened (`out`).
 *   A table name that comes from another PC is cleaned before it is logged or shown.
 * - **Picking the lobby's table** (A17 step 10, 2026-11-26, alpha-match.md section 11.5): `pick(path)` makes a table
 *   of this PC's own lists the lobby's table, `pickOpen()` the table that is open here ("Make <table> the lobby's
 *   table"). The pick is the table's identity keys (its name, the SHA-256 of the file, hashed first when it never
 *   was, its ROM) and the Castcade VPX build's identity of this copy, so the 3D ranking of every PC's copies follows
 *   the picked table. The lobby's PC judges it (`MatchHost.pickTable`); every PC, this one included, then follows it
 *   by the path above. Step 10 also adds to that path: a VPX whose table the witness cannot name is not "no table
 *   open" (the new table is never started beside it; the person is asked to close it); where this PC stands is said
 *   to the lobby (`MatchHost.setTableChange`), so every row, header and this PC's own headset panel say it; and
 *   after `AUTO_CHANGES_MAX` changes that closed or opened a table by themselves within `AUTO_CHANGES_WINDOW_MS`,
 *   further changes are only offered (Open it) until the person acts.
 *
 *   The review of PR 139 added, by the same rule:
 *   - a pick this PC did not hear live (its link was down, a change was waiting when the link dropped, the lobby's
 *     own PC was cut off) closes nothing and is not lost: it stands as an offer, with a sentence that says so;
 *   - an offer stays an offer: once this PC asks first (`AUTO_CHANGES_MAX`), it asks until its person presses Open
 *     it, picks a table here, or joins anew. Time alone changes nothing;
 *   - a witness that is not watching (`WitnessStatus.watching`: paused, or made again a moment ago) knows neither what
 *     is open nor whether a game is on: nothing is closed, nothing is started, the person is asked;
 *   - with "Change tables for me" off nothing starts by itself, also not after a VPX it could not name has closed;
 *   - this PC says when its open table is its own copy of the lobby's table (`MatchHost.setPickCopy`): the lobby
 *     compares names and bytes, and a copy found by its ROM has neither in common with the pick;
 *   - the PC that made a pick opens the file it picked, whatever else it has of that game.
 *
 *   The final review before the testers (2026-11-28) made one rule of it: **whenever this PC is in a lobby that has
 *   a table, and the table open here is not this PC's copy of it (another game is open, or nothing is), the lobby's
 *   table is on offer here: Open it.** Castcade closes or opens a table by itself in two cases only, the two that
 *   always did: a change of the lobby's table heard live with "Change tables for me" on, and a join by link (or the
 *   start of Open lobby's own table) with nothing open. So a join by typed code, a join by link beside another table,
 *   a Castcade that started again beside another table, a table closed by hand, and the first table picked in a
 *   lobby that had none while another table stood open here all end in the offer (`judge`); with no copy on this PC
 *   it is the no-copy sentence. The press of the person who picks counts as their Open it on their own PC, and a
 *   pick is the person's act only once the lobby's PC has taken it (`pickFrom` waits for the answer).
 *
 * Everything that touches the outside (the process spawner, the clipboard, the table lists) is injected; nothing here
 * imports Electron.
 */
import type { GameFingerprint, TableChange } from '@castcade/protocol';
import { HASH_CANDIDATES_MAX, OBJECTS_CANDIDATES_MAX, findLocalTable, hostHash, identicalFileNote, objectsCandidates, sameObjectsNote, unhashedCandidates, type ObjectsEvidence } from '../launch/find-table.js';
import { forkIdentityText, sameForkIdentity, type ForkIdentity } from '../launch/fork-identity.js';
import type { KnownTable } from '../launch/known-tables.js';
import { objectsDisagreeLine } from '../launch/table-objects.js';
import type { VpxCloser } from '../launch/vpx-close.js';
import type { ForkLaunch, LaunchResult, VpxLauncher } from '../launch/vpx-launch.js';
import { formatJoinLink, formatWebJoinLink, inviteMessage, looksLikePastedLink, parseJoinLink, type JoinLink } from './deep-link.js';
import type { MatchStatus, PickAnswer } from './match-host.js';
import { NO_TABLE_NAME, ZERO_SHA256, isTableOpen } from './match-setup.js';
import { INITIALS_HOLD_CAP_MS } from '../match/controller.js';
import { TABLE_NAME_SHOWN, tableWords } from '../match/table-identity.js';

export type LaunchState =
  /** Nothing asked. */
  | 'idle'
  /** Joined; the host's table is not open yet, so Castcade does not know which table to start. */
  | 'waiting_host'
  /** VPX was started and has not shown the table yet. */
  | 'starting'
  /** A table is open (started here, or already open). */
  | 'running'
  /** This PC has no copy of the host's table. */
  | 'needed'
  | 'failed';

/**
 * A17 step 3: what is left of a change of the lobby's table on this PC. `offered`: "Change tables for me" is off, and
 * the Match tab has Open it. `own_game`: a game, its ending or its high-score initials on the open table: after it.
 * `closing`: the open table was asked to close. `close_it`: the person closes it (a table Castcade cannot follow, or
 * one that is still open 15 s after it was asked); Castcade opens the new table when it is closed.
 */
export type ChangeState = 'offered' | 'own_game' | 'closing' | 'close_it';

export interface OneStepStatus {
  /** While hosting: the join link and the line for a chat. Null otherwise. */
  link: string | null;
  message: string | null;
  /** The link of this match was put on the clipboard (at Host, or by Copy). */
  copied: boolean;
  /** A link from outside that waits for the player's click. */
  pending: { code: string; address: string | null } | null;
  launch: { state: LaunchState; table: string | null; detail: string | null };
  /** A14.7: hosting, and the picked table waits for "Start the table" (`startTable()`): its name. Null otherwise. */
  tableToStart: string | null;
  /**
   * A17 step 3: the lobby's table changed and this PC has not followed yet: the new table (`table`), the table open
   * here (`open`; null: none, and the new one waits for Open it), where it stands and the sentence for the tab.
   */
  change: { state: ChangeState; table: string; open: string | null; detail: string } | null;
  /** One line about the last link (gone, not a link, already in a match). */
  notice: string | null;
  /** Counts links that asked for the Match tab; the renderer switches to it when this moves. */
  attention: number;
}

/** A table as the picker shows it (the path is the key the renderer hands back; main checks it against the list). */
export interface TableChoice {
  path: string;
  name: string;
  rom: string | null;
  lastPlayedAt: string | null;
  /** False: a `.vpx` found in the tables folder that Castcade never patched (Browse). */
  imported: boolean;
}

export interface OneStepHostOptions {
  /** A path from `tables()` or `browse()`, or null: host only (a table already open, or the player opens one). */
  tablePath: string | null;
  /**
   * A14.7: true starts the picked table as part of Host (one press, as 0.2.40 did); false holds it until
   * `startTable()`, so the invite can be sent before VPX takes the headset.
   */
  startTable: boolean;
  port?: number;
  ballsPerGame: 3 | 5;
  displayName: string;
}

export interface OneStep {
  tables(): Promise<TableChoice[]>;
  /**
   * Browse: every other `.vpx` in the tables folder (and one level of sub-folders), by name. Such a table can be hosted;
   * if it cannot report ball ends, the lobby says so and Start asks the host to confirm (A13).
   */
  browse(): Promise<TableChoice[]>;
  host(o: OneStepHostOptions): Promise<MatchStatus>;
  /** A14.7: start the table Host held back (`status.tableToStart`). Nothing held: nothing happens. */
  startTable(): Promise<OneStepStatus>;
  /**
   * A17 step 3: Open it: the person asks for the lobby's new table on this PC (`status.change`, with "Change tables
   * for me" off). The open table is closed and the new one started by the same rules as with the setting on: not
   * during a game, never a table Castcade cannot follow. No change waiting: nothing happens.
   */
  openPick(): Promise<OneStepStatus>;
  /**
   * A17 step 10: make a table of this PC the lobby's table: `path` is one from `tables()` or `browse()`. `about`: the
   * lobby as the press saw it (`MatchStatus.lobby.gameKey`), so a pick that would end a match that began meanwhile
   * is not made. Throws the sentence the tab shows (not in a lobby, not in the list, the lobby's PC said no).
   */
  pick(path: string, about?: string | null): Promise<MatchStatus>;
  /**
   * A17 step 10: "Make <table> the lobby's table": the table that is open on this PC. `name`: the table the question
   * named; when another one is open at the answer, nothing is picked. Throws when none is open.
   */
  pickOpen(about?: string | null, name?: string | null): Promise<MatchStatus>;
  /** A link from outside the app. Never throws: what went wrong is the status's `notice`. */
  openLink(text: string, ctx: { trusted: boolean }): Promise<OneStepStatus>;
  /** A link pasted into the Match tab's Join box: joined at once; throws the sentence the tab shows. */
  joinLink(text: string, displayName?: string): Promise<MatchStatus>;
  confirm(): Promise<OneStepStatus>;
  dismiss(): OneStepStatus;
  /** Copy the link (`link`) or the chat line (`message`) of the match being hosted. */
  copy(what: 'link' | 'message'): OneStepStatus;
  status(): OneStepStatus;
  onStatus(cb: (s: OneStepStatus) => void): () => void;
  stop(): void;
}

export interface OneStepOptions {
  match: {
    host(o: { port?: number; ballsPerGame: 3 | 5; displayName: string }): Promise<MatchStatus>;
    join(invite: string, displayName: string): Promise<MatchStatus>;
    status(): MatchStatus;
    onStatus(cb: (s: MatchStatus) => void): () => void;
    /** The host's game as this rig knows it (a client: from HELLO_ACK), null with no match. */
    hostGame(): GameFingerprint | null;
    /** I11.4.11: 3D can run on this PC (the Castcade VPX build is beside VPX and 3D watch is on): only then is the host's identical file worth looking for. Absent: no. */
    wants3d?(): boolean;
    /**
     * I11.4.11: one more thing for the lobby line of this match (the host's file is here, not imported), or null.
     * I11.4.15: `not3d`: the copy that was started is known not to hold the host's table objects.
     */
    setLaunchNote?(note: string | null, not3d?: boolean): void;
    /** A17 step 7: this PC has no copy of the lobby's table (true), or has one after all (false): said to the lobby. Absent: never said. */
    setNoCopy?(noCopy: boolean): void;
    /** I11.4.15: the host's table objects as HELLO_ACK said them (`launch/fork-identity.ts`); null: not said. Absent: never known. */
    hostTableObjects?(): ForkIdentity | null;
    /**
     * I11.4.2: how a match table is started now: the launch options of the Castcade VPX build with the state stream,
     * and whether that start took (`MatchHost.tableLaunch`); or null / absent: the plain A14 launch.
     */
    tableLaunch?(): Promise<ForkLaunch | null>;
    /** A17 step 3: this PC's table is held for the high-score initials of a finished match game (`MatchHost.tableHeld`). Absent: never. */
    tableHeld?(): boolean;
    /**
     * A17 step 3: the lobby's table, a pick (`MatchHost.lobbyTable`), with this PC's stay in the lobby (`joined`:
     * another value after every join, join again, reconnect and resume). A change of its name under one `joined` is
     * what this PC follows. Absent: nothing is followed (the table of a join is still found from `hostGame`).
     */
    lobbyTable?(): { game: GameFingerprint; joined: string } | null;
    /**
     * A17 step 10: pick the lobby's table (`MatchHost.pickTable`), with the answer to this very request (the step 9
     * last pass): taken, refused with the sentence, or none within `waitMs`. Absent: this Castcade cannot.
     */
    pickTable?(o: { game: GameFingerprint; objects: ForkIdentity | null; about?: string | null; waitMs: number }): Promise<PickAnswer>;
    /** A17 step 10: this PC's own open table as it says it to the lobby (`MatchHost.ownTable`); null: none. */
    ownTable?(): GameFingerprint | null;
    /** A17 step 10: where this PC stands on its way to the lobby's table, and the sentence for its own panel (`MatchHost.setTableChange`). */
    setTableChange?(state: TableChange | null, line: string | null): void;
    /**
     * A17 step 10 (review of PR 139): the table open on this PC (`open`, as the witness names it) is this PC's own
     * copy of the lobby's table named `pick`, or is not (null) (`MatchHost.setPickCopy`). Absent: never said.
     */
    setPickCopy?(word: { pick: string; open: string } | null): void;
  };
  witness: {
    /**
     * A17 step 3 (`WitnessStatus`): `gamesSeen`: true when the witness has evidence that a game on the open table
     * would be seen; anything else (false, not said) is a table Castcade cannot follow, which it never closes.
     * `currentPid`: the VPX process the table is named from; `vpxOpen`: how many VPX processes are open. Only with
     * exactly one, and its pid known, does Castcade know which process to ask.
     */
    status(): {
      currentTable: string | null;
      gamesSeen?: boolean | null;
      currentPid?: number | null;
      vpxOpen?: number;
      /** Review of PR 139: false while the witness is not watching (`WitnessStatus.watching`): Castcade is then not sure of anything on this PC. */
      watching?: boolean;
      currentIdentity?: { filePath?: string | null; sha256?: string | null; tableInfo?: { tableName?: string | null } | null } | null;
    };
    onStatus(cb: (s: { currentTable: string | null }) => void): () => void;
    /** A17 step 3: the game on the open table as live mode reads it, and every change of it. Absent: no game is ever seen. */
    liveGame?(): { inGame: boolean; scores: (number | null)[] } | null;
    onGame?(cb: (g: { inGame: boolean; scores: (number | null)[] } | null) => void): () => void;
    /**
     * A17 step 3: a finished game's score against the open table's high-score list (`Witness.highScoreKnown`): true,
     * false, or null when there is no list to compare with. Absent: never known.
     */
    highScoreKnown?(score: number): boolean | null;
  };
  /**
   * A17 step 3: asks the open table's VPX to close (`launch/vpx-close.ts`). Absent: Castcade closes nothing, and the
   * person is asked to.
   */
  closer?: VpxCloser;
  /** A17 step 3: "Change tables for me" (`match.json` `changeTablesForMe`). Absent: on. */
  changeTablesForMe?(): boolean;
  /** A17 step 3: `AFTER_GAME_MS`, the wait for a finished game's initials (`INITIALS_HOLD_CAP_MS`) and `LATE_CLOSE_MS` for the tests. */
  afterGameMs?: number;
  initialsWaitMs?: number;
  lateCloseMs?: number;
  /** The final review: `PICK_ANSWER_MS` and `IDENTITY_WAIT_MS` for the tests. */
  pickAnswerMs?: number;
  identityWaitMs?: number;
  /** A17 step 10: `AUTO_CHANGES_MAX` and `AUTO_CHANGES_WINDOW_MS` for the tests. */
  autoChangesMax?: number;
  autoChangesWindowMs?: number;
  launcher: VpxLauncher;
  clipboard: { writeText(text: string): void };
  /** The imported tables, most recent first (`launch/known-tables.ts`). */
  tables(): Promise<KnownTable[]>;
  /** Other `.vpx` files in the tables folder, for a joining rig. Default: none. */
  tableFiles?(known: readonly KnownTable[]): Promise<KnownTable[]>;
  /**
   * I11.4.11: the SHA-256 of a table file nothing has hashed yet (`launch/table-hash.ts`: streamed, cached by path,
   * size and time), for finding the host's identical file among the copies of its title. Absent: none is hashed.
   */
  hashTable?(vpxPath: string, signal?: AbortSignal): Promise<string | null>;
  /**
   * I11.4.15: the table objects of a table file on this PC (`launch/table-objects.ts`: what the Castcade VPX build
   * reported for it, else computed from the file; kept by path, size and time), for ranking the copies of the host's
   * title by what the 3D view needs. Absent: the copies rank by file hash and name alone, as before.
   */
  tableObjects?(vpxPath: string, signal?: AbortSignal): Promise<ForkIdentity | null>;
  /**
   * A17 step 10 (review of PR 139): the table's own name as its file says it (`TableInfo`), for a pick of a file the
   * witness never read: a pick is named as every PC's row names that file. Absent, or null: the file's name.
   */
  tableInfoName?(vpxPath: string): Promise<string | null>;
  /**
   * I11.4.15: the Castcade VPX build said what the objects of the table Castcade just started in it are: kept for that
   * file. Answers the identity that had been computed for the file when it is another one (then said in the log).
   */
  learnObjects?(vpxPath: string, objects: ForkIdentity): Promise<{ computed: ForkIdentity } | null>;
  /**
   * I11.4.11: how long a join waits for the host's file hash once the host's table is named. Default 3 s. I11.4.15:
   * and as long again for the host's table objects, from when its table was named or its hash came, when the
   * identical file is not on this PC and 3D can run here.
   */
  hostHashWaitMs?: number;
  /** I11.4.15: how long the reads of the copies' table objects may hold a join in all. Default `DEFAULT_OBJECTS_READ_MS`. */
  objectsReadMs?: number;
  /** The clock of that wait; default `Date.now`. */
  now?(): number;
  /** A14.2: the ArcAid address this PC uses, for the clickable join link. Default: none (the `castcade://` link). */
  arcaidBaseUrl?(): string | null;
  log: { info(line: string): void; warn(line: string): void };
  /** How long a started VPX may take to show its table before the Match tab says it did not. Default 2 minutes. */
  launchWaitMs?: number;
  setTimeout?(fn: () => void, ms: number): unknown;
  clearTimeout?(handle: unknown): void;
}

export const DEFAULT_LAUNCH_WAIT_MS = 120_000;
/**
 * I11.4.15 (review of PR #125, finding 5): how long the reads of the table objects of this PC's copies may hold a
 * join, all of them together. A table reads in 0.2 to 2.4 s from a warm disk; a file that is only in the cloud, or on
 * a disk that sleeps, can take any time. After this the pick is made with what is known: a copy not looked at counts
 * as "not known", and the log says how many were not.
 */
export const DEFAULT_OBJECTS_READ_MS = 8_000;
/**
 * A17 step 3: how long after a game's end its table is still left alone whatever else is known: the machine's own
 * ending, and the moment in which the match controller raises its initials hold from the same event.
 */
export const AFTER_GAME_MS = 3_000;
/**
 * A17 step 3: how long a close request that was not obeyed in time is still remembered: a VPX that closes this long
 * after the closer gave up closed because it was asked to, and what follows is Castcade's to say.
 */
export const LATE_CLOSE_MS = 60_000;
/**
 * A17 step 10: how often this PC changes tables by itself. After this many changes of the lobby's table that closed
 * or opened a table here without its person doing anything, within this long, the next ones are only offered (Open
 * it) until the person acts.
 */
export const AUTO_CHANGES_MAX = 3;
export const AUTO_CHANGES_WINDOW_MS = 5 * 60_000;
/**
 * The final review: how long a pick made on a joined PC waits for the lobby's PC to take or refuse it before the tab
 * says that no answer came (the pick may still be taken: the lobby's table then changes as for anybody's pick).
 */
export const PICK_ANSWER_MS = 8_000;
/**
 * The final review: how long the offer of the lobby's table waits for the witness to have read the open table's file
 * (its hash, its own name) before the table is taken for another game on its launch name alone. A big file takes
 * seconds to hash, and the identical file under another name must not be offered away in that time.
 */
export const IDENTITY_WAIT_MS = 10_000;
/** A table name as it is logged and shown: no control characters, no line breaks, this long at most (`match/table-identity.ts` `tableWords`: the one place). */
export const TABLE_NAME_MAX = TABLE_NAME_SHOWN;

/** Lower-case letters and digits only: how two names of one table file are compared. */
const squash = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, '');
const sameName = (a: string, b: string): boolean => squash(a) === squash(b);
/** The name of a table file as the witness names an open table (`tableNameFromPath`). */
const fileName = (vpxPath: string): string => (vpxPath.split(/[\\/]/).pop() ?? vpxPath).replace(/\.vpx$/i, '');

/**
 * Why a change stands where it does, beyond its state: a game or its initials (`own_game`); a VPX whose table cannot
 * be named, and whether Castcade opens the table by itself once it is closed (`unnamed`, `unnamed_ask`); a witness that
 * is not watching (`unwatched`); and why it is only offered: this PC changed tables often (`often`), the table was
 * picked while this PC was away from the lobby (`away`), a change was waiting when this PC lost the lobby (`back`), or
 * nobody changed anything and the table open here is simply not this PC's copy of the lobby's table (`here`: a join
 * beside another table, a join by code, a Castcade that started again, a table closed by hand).
 */
export type ChangeWhy = 'game' | 'initials' | 'unnamed' | 'unnamed_ask' | 'unwatched' | 'often' | 'away' | 'back' | 'here' | null;

/**
 * A17 step 3: what the Match tab says of a change that waits (alpha-match.md sections 11.5 and 11.9). `by`: who
 * picked the table ("You", or a name), when this PC knows.
 */
export function changeWords(state: ChangeState, table: string, open: string | null, why: ChangeWhy = null, by: string | null = null): string {
  const changed = by === null ? null : `${by} changed the lobby's table to ${table}`;
  const now = changed === null ? `The lobby's table is now ${table}.` : `${changed}.`;
  switch (state) {
    case 'offered': {
      const openIt = open === null ? '' : ` Open it: Castcade closes ${open} and opens ${table}.`;
      // Nobody changed anything: what the lobby's table is, what is open here, and what Open it does.
      if (why === 'here') return open === null ? `The lobby's table is ${table}, and no table is open on this PC. Open it: Castcade opens ${table}.` : `The lobby's table is ${table}, and ${open} is open on this PC.${openIt}`;
      // A pick this PC did not hear live is never carried out by itself.
      if (why === 'away') return `${changed ?? `The lobby's table changed to ${table}`} while this PC was away from the lobby.${openIt}`;
      if (why === 'back') return `${now} This PC was away from the lobby for a moment, so Castcade asks before it changes tables.${openIt}`;
      // A17 step 10: after several changes in a few minutes this PC asks first, whatever its setting says.
      const often = why === 'often' ? ' The table has changed several times in a few minutes, so Castcade asks before it changes tables again.' : '';
      return `${now}${openIt}${often}`;
    }
    case 'own_game':
      return why === 'initials'
        ? `${now} The high-score initials of the last game can still be entered on ${open ?? 'this table'}: Castcade opens ${table} after that, or as soon as you close the table.`
        : `${now} A game is being played on this PC's table: Castcade opens ${table} after it.`;
    case 'closing':
      return `${now} Closing ${open ?? 'the open table'}; ${table} opens next.`;
    case 'close_it':
      // Review of PR 139: the witness is not watching, so Castcade knows neither what is open nor whether a game is on.
      if (why === 'unwatched') return `${now} Castcade is not watching VPX on this PC right now (watching is paused, or was started again a moment ago), so it closes and opens nothing. Open ${table} in VPX yourself, or turn watching back on.`;
      // A17 step 10: VPX is open and the witness cannot name its table (an editor, a VPX it cannot read).
      if (why === 'unnamed') return `${now} VPX is open on this PC and Castcade cannot tell which table it has: close VPX, and Castcade opens ${table}.`;
      if (why === 'unnamed_ask') return `${now} VPX is open on this PC and Castcade cannot tell which table it has: close VPX, and ${table} can be opened from here (Open it).`;
      return `Close the table on this PC: Castcade opens ${table} when it is closed.`;
  }
}

/**
 * What a PC says when it joined a lobby whose table it has no copy of. A17 step 9 (2026-11-27): "the lobby's table"
 * (it read "The host plays …" and "You stay in the match", from before there was a lobby).
 */
export function noCopyAtJoinWords(table: string): string {
  // The step 9 last pass: what is true. It read "open it in VPX if you have it under another name", a promise: a
  // file opened by hand is taken only when Castcade can tell it is the same game (`judge`: its bytes, the ROM its
  // lists know, or its own table name), so that is said; it ends with what always works.
  return `The lobby's table is ${table}. Castcade found no copy of it on this PC. If you have it under another name, open it in VPX: Castcade takes it when it can tell it is the same game. Otherwise you can watch, or pick another table.`;
}

const IDLE: OneStepStatus['launch'] = { state: 'idle', table: null, detail: null };

const describe = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** A pick that got no answer from the lobby's PC (it may still be taken). */
class PickUnanswered extends Error {}

/** What a failed join by link says: a match that is gone says so. */
export function linkJoinFailure(raw: string): string {
  // A socket error can carry its stack: only the sentences are for the player.
  const detail = raw.replace(/\n\s+at [^\n]*/g, '').replace(/^Error: /, '');
  if (/The host refused/.test(detail)) return `Could not join that lobby. ${detail}`;
  // Sentences that already say what to do (D10.8's relay answers: not paired or no longer paired, full, held back,
  // a match that has started and is locked to its players; a request under way).
  if (/still working|Leave the current (match|lobby)|not paired|no longer paired|pair it (again )?(with ArcAid|in Settings)|is full\.|holding this PC back|has already started/i.test(detail)) return detail;
  return `That lobby is gone or cannot be reached: ask for a new link. (${detail})`;
}

/**
 * A table still to be started for the lobby with this code: the host's pick (`path`), or the lobby's table (a joined
 * PC). A17 step 3: `change`: the wish was made because the lobby's table changed; `replace` names the table that was
 * open (or being started) on this PC at that moment, the one a copy of the new table may take the place of.
 */
interface Wish {
  code: string;
  path: string | null;
  change?: { replace: string | null };
  /** A17 step 3: the table to start is the lobby's as it is now (the pick), after a close Castcade asked for. */
  pick?: boolean;
  /**
   * Review of PR 139 (finding 2): the change is one this PC did not hear live: the table was picked while it was away
   * from the lobby (`away`), or a change was waiting when it lost the lobby (`back`). It is only ever offered.
   */
  away?: 'away' | 'back' | 'here';
  /**
   * The final review: the person asked for this themselves (Open it, or the pick was their own press): it is
   * carried out whatever the setting says, by the rules of any change, and that is not forgotten when the change
   * is looked at afresh.
   */
  asked?: boolean;
}

/** A17 step 3: what is left of a change once this PC's copy of the new table is known (`OneStepStatus.change`). */
interface Swap {
  code: string;
  /** The table open on this PC; null: none (the setting is off and the new table waits for Open it). */
  open: string | null;
  /** The lobby's table, as it is named. */
  table: string;
  state: ChangeState;
  why: ChangeWhy;
  /** A17 step 10: VPX is open and the witness names no table in it: nothing is started beside it. */
  unnamed: boolean;
  /**
   * Review of PR 139: this change is only ever offered: nothing but Open it carries it out, however long it stands.
   * `often`: this PC asks first (`AUTO_CHANGES_MAX`); `away` / `back`: a pick this PC did not hear live; `here`:
   * nobody changed anything, the table open here is not this PC's copy of the lobby's table.
   */
  only: 'often' | 'away' | 'back' | 'here' | null;
  /** Review of PR 139: the witness was not watching when this was looked at; once it watches again the change is looked at afresh. */
  blind: boolean;
  /** Review of PR 139: this change has been counted as one this PC made by itself (once, however often its close is asked). */
  counted: boolean;
  /** Open it was pressed: with the setting off, Castcade may close the open table all the same. */
  asked: boolean;
  /** The closer is at work. */
  closing: boolean;
  /** The VPX process has ended after it was asked; the witness still names its table (its close-time capture runs). */
  gone: boolean;
  /** A close request went out for this change (it may still be obeyed, whatever the closer answered). */
  sent: boolean;
  /** The third rung was reached: the person closes the table, and Castcade asks it no more. */
  person: boolean;
  /** The log has a line for the state it is in. */
  said: boolean;
}

export function createOneStep(o: OneStepOptions): OneStep {
  const { match, witness, log } = o;
  const listeners = new Set<(s: OneStepStatus) => void>();
  const later = o.setTimeout ?? ((fn: () => void, ms: number): unknown => setTimeout(fn, ms));
  const cancel = o.clearTimeout ?? ((h: unknown): void => clearTimeout(h as ReturnType<typeof setTimeout>));
  const waitMs = o.launchWaitMs ?? DEFAULT_LAUNCH_WAIT_MS;

  let pending: JoinLink | null = null;
  let launch: OneStepStatus['launch'] = IDLE;
  let notice: string | null = null;
  let attention = 0;
  /** The match code whose link is on the clipboard. */
  let copiedFor: string | null = null;
  /** The host's pick, for the chat line until the witness names the open table. */
  let hostTable: string | null = null;
  /** A table still to be started for the match with this code: the host's pick (`path`), or the host's game (a client). */
  let want: Wish | null = null;
  /** A14.7: the host's pick, held until "Start the table" (it becomes the wish then). */
  let held: { code: string; path: string; name: string } | null = null;
  let launchTimer: unknown = null;
  /**
   * A17 step 3: the lobby's table as it was last named, for the lobby with this code and this stay in it (`joined`).
   * Its first sighting is no change, and neither is its first sighting after this PC joined again.
   */
  let lobbyTable: { code: string; joined: string; name: string | null } | null = null;
  /** The final review: the lobby's table and the table open here (or none) for which the offer was last looked at (`judge`). */
  let judged: string | null = null;
  /** The final review: the table that is open here, and since when this Castcade has seen it (`IDENTITY_WAIT_MS`). */
  let openSeen: { open: string; at: number } | null = null;
  let identityTimer: unknown = null;
  /** The final review: a table that was open at a join and kept: "Using the table that is already open" is said once it is known to be this PC's copy. */
  let keptAtJoin: { code: string; open: string } | null = null;
  /** The final review: Open lobby or a join by link is under way: its own wish follows, and no offer is made meanwhile. */
  let entering = false;
  /**
   * A17 step 3 (review, finding 7): a close request that is out, for this lobby, table and process. It outlives the
   * change that made it: a request cannot be taken back, so what happens when its table closes is still Castcade's
   * to say. Forgotten when the table closes, when another table is seen open, or `LATE_CLOSE_MS` after the closer
   * gave up.
   */
  let out: { code: string; open: string; pid: number; table: string } | null = null;
  let outTimer: unknown = null;
  /** A17 step 10: when this PC last changed tables by itself for a change of the lobby's table (`AUTO_CHANGES_MAX`). */
  let autoChanges: number[] = [];
  /**
   * Review of PR 139: this PC changed tables by itself `AUTO_CHANGES_MAX` times within the window: from here it asks
   * first, until its person acts (Open it, a pick made here, a new join). Time alone never lifts it.
   */
  let asksFirst = false;
  /** Review of PR 139 (finding 11): the table file this PC's person picked as the lobby's table: this PC opens that file for it. */
  let myPick: { code: string | null; name: string; path: string } | null = null;
  /** Review of PR 139 (finding 1): whether the open table is this PC's copy of the lobby's table, as last worked out, and for what. */
  let copyVerdict: { key: string; detail: string; copy: boolean } | null = null;
  /** A17 step 10: the table that is being started is the lobby's new one (the lobby is told: opening). */
  let opening = false;
  /** A17 step 3: this PC's copy of the lobby's new table was found while another table stood open: what is left of the change. */
  let swap: Swap | null = null;
  let swapTimer: unknown = null;
  /** A17 step 3: a table open on this PC that is known not to be the lobby's (no copy of the lobby's table is here): it is not taken for one. */
  let stale: { code: string; open: string } | null = null;
  /** A17 step 3: when the last game on this PC's table ended, with its scores; null while one is on, and before any. */
  let gameEnded: { at: number; scores: number[]; qualifies: boolean | null | undefined; held: boolean } | null = null;
  let gameOn = witness.liveGame?.()?.inGame ?? false;
  /** I11.4.11: the host's table was first seen named and not yet hashed, for the match with this code, at this time. */
  let nameOnly: { code: string; at: number } | null = null;
  let hashTimer: unknown = null;
  /** I11.4.11: the reads of the copies with no hash, for one match and one host file; `done`: what they found is used. */
  let hashRun: { key: string; ctl: AbortController; done: boolean; hashes: Map<string, string> } | null = null;
  /** I11.4.15: when the host's open table was first seen for the match with this code, and when its file hash was: the wait for its table objects counts from the later one. */
  let hostSeen: { code: string; at: number; hashAt: number | null } | null = null;
  /** I11.4.15: the reads of the table objects of this PC's copies, for one match and one host table; `done`: what they found is used. */
  let objectsRun: { key: string; ctl: AbortController; done: boolean; ids: Map<string, ForkIdentity>; looked: number; timer: unknown } | null = null;
  const abortObjects = (): void => {
    if (objectsRun && !objectsRun.done) objectsRun.ctl.abort();
    if (objectsRun && objectsRun.timer !== null) cancel(objectsRun.timer);
    objectsRun = null;
  };
  /** Every read for the pick is given up: the hashes (I11.4.11) and the table objects (I11.4.15). */
  const abortHashing = (): void => {
    if (hashRun && !hashRun.done) hashRun.ctl.abort();
    hashRun = null;
    abortObjects();
  };
  const now = o.now ?? ((): number => Date.now());
  const HOST_HASH_WAIT_MS = o.hostHashWaitMs ?? 3000;
  const OBJECTS_READ_MS = o.objectsReadMs ?? DEFAULT_OBJECTS_READ_MS;
  const clearHashTimer = (): void => {
    if (hashTimer !== null) cancel(hashTimer);
    hashTimer = null;
  };
  let settling: Promise<void> | null = null;
  let settleAgain = false;
  let stopped = false;

  const tableOpen = (): string | null => witness.status().currentTable;
  const choice = (t: KnownTable): TableChoice => ({ path: t.vpxPath, name: t.tableId, rom: t.rom, lastPlayedAt: t.lastPlayedAt, imported: t.imported });
  /** The tables a host may pick: the imported ones, then the other files of the tables folder. Paths from this disk only. */
  const pickable = async (): Promise<KnownTable[]> => {
    const known = await o.tables().catch(() => [] as KnownTable[]);
    const files = o.tableFiles ? await o.tableFiles(known).catch(() => [] as KnownTable[]) : [];
    return [...known, ...files];
  };

  /**
   * The link of the lobby this PC is in: the clickable web form when ArcAid carries it (A14.2), else `castcade://`.
   * A17 step 9 (2026-11-27, design 11.9): every member has it, not only the PC that opened the lobby (`invite` is
   * the code for a member of a lobby through ArcAid, and null for a member of one reached by address).
   */
  const linkOf = (m: MatchStatus): string | null =>
    m.role !== 'none' && m.invite ? (formatWebJoinLink(m.invite, o.arcaidBaseUrl?.() ?? null) ?? formatJoinLink(m.invite)) : null;

  const status = (): OneStepStatus => {
    const m = match.status();
    const link = linkOf(m);
    return {
      link,
      message: link ? inviteMessage(link, tableOpen() ?? hostTable) : null,
      copied: link !== null && copiedFor !== null && copiedFor === m.code,
      pending: pending ? { code: pending.code, address: pending.address } : null,
      launch: { ...launch },
      tableToStart: held !== null && m.role === 'host' && held.code === m.code && tableOpen() === null ? held.name : null,
      change: swap !== null && swap.code === m.code ? { state: swap.state, table: swap.table, open: swap.open, detail: changeWords(swap.state, swap.table, swap.open, swap.why, pickerOf(m, swap.table)) } : null,
      notice,
      attention,
    };
  };
  let lastSent = '';
  const emit = (): void => {
    const s = status();
    const text = JSON.stringify(s);
    if (text === lastSent) return;
    lastSent = text;
    for (const l of [...listeners]) l(s);
  };

  const clearLaunchTimer = (): void => {
    if (launchTimer !== null) cancel(launchTimer);
    launchTimer = null;
  };
  const setLaunch = (next: OneStepStatus['launch']): void => {
    if (next.state !== 'starting') clearLaunchTimer();
    launch = next;
    // A17 step 7 (alpha-match.md section 11.3): the lobby is told when this PC has no copy of its table (the person
    // is then not counted for a start, and watches), and when it has one after all (a table is open or starting).
    if (next.state === 'needed') match.setNoCopy?.(true);
    else if (next.state === 'starting' || next.state === 'running') match.setNoCopy?.(false);
  };

  /**
   * I11.4.2 (§4.4): a match table starts in the Castcade VPX build when the match host says so (the fork is beside the
   * VPX exe and 3D watch is on `auto`); if that start fails, or there is nothing to say, exactly as A14 did. A start
   * can fail at once (`launch` says so), or a moment after the process was spawned: an `error` from the system
   * (EACCES, a file that is not a program), or an exe that ends within seconds without its VPX coming up
   * (`ForkLaunch.didNotStart`). Then the table is started again in the player's own VPX, unless the match is over or
   * a table opened meanwhile.
   */
  const launchTable = async (table: { vpxPath: string; tableId: string }): Promise<LaunchResult> => {
    const fork = (await match.tableLaunch?.().catch(() => null)) ?? null;
    if (fork) {
      const r = await o.launcher.launch(table.vpxPath, fork.options);
      if (r.ok) {
        // A17 step 3: which process this start made: `quit` only ever goes to a build that is known to be it.
        if (r.pid !== null) fork.spawned?.(r.pid);
        const code = match.status().code;
        // I11.4.15: what this table's VPX says its objects are is kept for the file: the build's own word comes
        // before anything computed, and a file the computation gets wrong shows in the log.
        void fork.objects?.then(
          async (said) => {
            if (!said || stopped || !o.learnObjects) return;
            const other = await o.learnObjects(table.vpxPath, said).catch(() => null);
            if (other) log.warn(objectsDisagreeLine(table.tableId, said, other.computed));
          },
          () => undefined,
        );
        void fork.didNotStart.then(
          (failed) => {
            if (!failed || stopped) return;
            if (match.status().code !== code || tableOpen() !== null) return;
            log.warn('launch: the Castcade VPX build did not start (it ended at once); starting the table in your own VPX');
            void o.launcher.launch(table.vpxPath).then((again) => {
              if (stopped || again.ok) return;
              log.warn(`launch: ${table.tableId} not started in your own VPX either: ${again.reason}`);
              setLaunch({ state: 'failed', table: table.tableId, detail: `Castcade could not start ${table.tableId}: ${again.reason}. Open it in VPX yourself; the lobby waits.` });
              emit();
            });
          },
          () => undefined,
        );
        return r;
      }
      // I11.4.9: no process, so no exit will ever say it: the match's start must not wait for this VPX.
      fork.notStarted?.();
      log.warn(`launch: the Castcade VPX build did not start (${r.reason}); starting the table in your own VPX`);
    }
    return o.launcher.launch(table.vpxPath);
  };

  // ---- A17 step 3: a table that is open and wrong ----
  /** The lobby's table (the pick) as it is now: its name for the log and the tab, the pick itself, and this PC's stay. Null with no lobby, and while no table is named. */
  const lobbyTableNow = (m: MatchStatus): { name: string; game: GameFingerprint; joined: string } | null => {
    if (m.role === 'none') return null;
    const t = match.lobbyTable?.() ?? null;
    if (!t || !isTableOpen(t.game) || t.game.tableName === NO_TABLE_NAME) return null;
    return { name: tableWords(t.game.tableName), game: t.game, joined: t.joined };
  };
  /** The lobby's table has another name than the one this PC last heard, or this PC joined again. */
  const lobbyTableMoved = (m: MatchStatus): boolean => {
    const t = lobbyTableNow(m);
    return t !== null && lobbyTable !== null && lobbyTable.code === m.code && (lobbyTable.joined !== t.joined || lobbyTable.name === null || !sameName(lobbyTable.name, t.name));
  };
  const AFTER_GAME = o.afterGameMs ?? AFTER_GAME_MS;
  /** One number with the controller's own hold: how long a finished game's initials are waited for. */
  const INITIALS_WAIT = o.initialsWaitMs ?? INITIALS_HOLD_CAP_MS;
  const LATE_CLOSE = o.lateCloseMs ?? LATE_CLOSE_MS;
  const AUTO_MAX = Math.max(1, o.autoChangesMax ?? AUTO_CHANGES_MAX);
  const AUTO_WINDOW = o.autoChangesWindowMs ?? AUTO_CHANGES_WINDOW_MS;
  /** "Change tables for me". */
  const settingOn = (): boolean => o.changeTablesForMe?.() ?? true;
  /**
   * A17 step 10: one more change this PC made by itself. At `AUTO_MAX` within the window it asks first from then on
   * (`asksFirst`), and that stands until its person acts: an offer never turns into a change by waiting.
   */
  const noteAutoChange = (table: string): void => {
    autoChanges = autoChanges.filter((at) => now() - at < AUTO_WINDOW);
    autoChanges.push(now());
    if (autoChanges.length < AUTO_MAX || asksFirst) return;
    asksFirst = true;
    log.info(`launch: this PC has changed tables by itself ${autoChanges.length} times in ${Math.round(AUTO_WINDOW / 60_000)} minutes (the last for ${table}): from here a change of the lobby's table is only offered, until the person acts (Open it, a pick made on this PC, a new join)`);
  };
  /** The person did something about the lobby's table on this PC: what this PC did by itself before counts no more. */
  const personActed = (): void => {
    autoChanges = [];
    asksFirst = false;
  };
  /** Why a change that nobody asked for is only offered now, or null when Castcade may carry it out by itself. */
  const offerOnly = (): 'often' | 'setting' | null => (!settingOn() ? 'setting' : asksFirst ? 'often' : null);
  /**
   * Castcade may carry this change out by itself: Open it was pressed, or nothing says it is only offered (the
   * change itself, the setting, this PC asking first). A change that is offered because this PC asks first stays so.
   */
  const mayAuto = (c: Swap): boolean => {
    if (c.asked) return true;
    if (c.only === null && offerOnly() === 'often') c.only = 'often';
    return c.only === null && settingOn();
  };
  const offerReason = (c: Swap): string =>
    c.only === 'often'
      ? 'this PC changed tables by itself several times lately, and asks first now'
      : c.only === 'away'
        ? 'the table was picked while this PC was away from the lobby'
        : c.only === 'back'
          ? 'this PC was away from the lobby while the change waited'
          : c.only === 'here'
            ? "nobody changed the lobby's table while this PC was in it: Castcade only offers it"
            : 'Change tables for me is off';
  /** Review of PR 139: the witness is not watching: Castcade knows neither what is open here nor whether a game is on. */
  const unsure = (): boolean => witness.status().watching === false;
  const vpxOpenNow = (): number => witness.status().vpxOpen ?? 0;
  const clearSwapTimer = (): void => {
    if (swapTimer !== null) cancel(swapTimer);
    swapTimer = null;
  };
  const dropSwap = (): void => {
    clearSwapTimer();
    swap = null;
  };
  const dropOut = (): void => {
    if (outTimer !== null) cancel(outTimer);
    outTimer = null;
    out = null;
  };
  /**
   * Nothing is closed that might be a game: a game on the open table (the A16 window of a finished match game is one:
   * the table's own game still runs), the controller's initials hold, the moment after a game's end, and the time
   * for the initials of the last game unless its score is known not to make the machine's list. With no list to
   * compare with (an original, a map without one) nobody can say, so the table is left as long as if it did. The
   * controller's hold, once it was on for that game and is over, is the better word: the initials are in.
   * `until`: when a wait ends by itself.
   */
  const busy = (): { why: 'game' | 'initials'; until: number | null } | null => {
    if (witness.liveGame?.()?.inGame) return { why: 'game', until: null };
    const e = gameEnded;
    if (match.tableHeld?.()) {
      if (e) e.held = true;
      return { why: 'initials', until: null };
    }
    if (!e) return null;
    const since = now() - e.at;
    if (since < AFTER_GAME) return { why: 'game', until: e.at + AFTER_GAME };
    if (e.held || since >= INITIALS_WAIT) return null;
    // Asked once per game, and only when a change waits for the answer.
    if (e.qualifies === undefined) {
      const known = e.scores.map((score) => witness.highScoreKnown?.(score) ?? null);
      e.qualifies = known.includes(true) ? true : known.length === 0 || known.includes(null) ? null : false;
    }
    return e.qualifies === false ? null : { why: 'initials', until: e.at + INITIALS_WAIT };
  };
  /** The witness has evidence that a game on the open table would be seen: only then can Castcade know that none is on. */
  const follows = (): boolean => !unsure() && witness.status().gamesSeen === true;
  /**
   * The process to ask: the one VPX that is open, when the witness names the table from it. Null (the person is
   * asked) with two VPX open, with none known, or when the table it names is not the one the change is about.
   */
  const processOf = (table: string): number | null => {
    const st = witness.status();
    if ((st.vpxOpen ?? 0) !== 1 || st.currentTable === null || !sameName(st.currentTable, table)) return null;
    const pid = st.currentPid ?? null;
    return pid !== null && Number.isInteger(pid) && pid > 0 ? pid : null;
  };
  const moveSwap = (s: Swap, state: ChangeState, why: Swap['why'], line: string): void => {
    if (s.said && s.state === state && s.why === why) return;
    s.state = state;
    s.why = why;
    s.said = true;
    log.info(`launch: ${line}`);
  };
  /**
   * What is left of a change, against the world as it is now. Cheap: no list is read here, so it runs on every status
   * of a game that is waited for. Answers true when the open table is gone and the new one is to be started.
   */
  const settleSwap = (code: string | null, open: string | null): boolean => {
    const s = swap;
    if (!s) return false;
    if (code !== s.code) {
      dropSwap();
      return false;
    }
    /** The change as a wish again: what is open is looked at afresh, and what made it an offer stays with it. */
    const again = (replace: string | null): Wish => ({ code: s.code, path: null, change: { replace }, ...(s.only === 'away' || s.only === 'back' || s.only === 'here' ? { away: s.only } : {}), ...(s.asked ? { asked: true } : {}) });
    if (unsure()) {
      // Review of PR 139: the witness is not watching (paused, or made again a moment ago). What it names is what was
      // open when it stopped looking, "no table" may be a table, and no game would be seen: nothing is closed, nothing
      // is started, and the person is asked. (A closer at work asks nothing more: `mayClose` says no.)
      s.blind = true;
      clearSwapTimer();
      moveSwap(s, 'close_it', 'unwatched', `Castcade is not watching VPX on this PC (watching is paused, or was started again a moment ago): it cannot tell what is open or whether a game is on, so nothing is closed and ${s.table} is not started; the person is asked`);
      return false;
    }
    if (s.blind) {
      log.info(`launch: Castcade is watching VPX again: the change to ${s.table} is looked at afresh${open !== null ? ` (${open} is open)` : ''}`);
      dropSwap();
      want = again(open);
      return false;
    }
    if (s.unnamed) {
      // Step 10: VPX is open with a table the witness cannot name. Once it has a name, the rules of a named table;
      // once VPX is closed, the new table is started. Until then the person is asked, and nothing is started beside it.
      if (open !== null) {
        log.info(`launch: the VPX that was open names its table now (${open}): the change to ${s.table} is looked at again`);
        dropSwap();
        want = again(open);
        return false;
      }
      if (vpxOpenNow() === 0) {
        // Review of PR 139 (finding 7): nothing starts by itself where the person is to be asked.
        if (!mayAuto(s)) {
          s.unnamed = false;
          moveSwap(s, 'offered', s.only, `VPX is closed; ${s.table} waits for Open it (${offerReason(s)})`);
          return false;
        }
        log.info(`launch: VPX is closed; ${s.table} is started`);
        dropSwap();
        return true;
      }
      const auto = mayAuto(s);
      moveSwap(s, 'close_it', auto ? 'unnamed' : 'unnamed_ask', `VPX is open on this PC and Castcade cannot tell which table it has: ${s.table} is not started beside it; ${auto ? 'it opens when VPX is closed' : 'it is offered when VPX is closed'}`);
      return false;
    }
    if (s.open === null) {
      // Nothing was open: the new table waits for Open it. A table opened by hand meanwhile is the one that is used.
      if (open !== null) dropSwap();
      return false;
    }
    if (open === null) {
      // The table is closed: by Castcade's request, or by the person.
      if (!s.gone && !s.closing && !s.sent && !mayAuto(s)) {
        // It is only offered, nobody asked and Castcade asked nothing: nothing opens by itself either.
        s.open = null;
        moveSwap(s, 'offered', s.only, `${s.table} still waits for Open it (${offerReason(s)})`);
        return false;
      }
      log.info(`launch: the table that was open is closed; ${s.table} is started`);
      dropSwap();
      return true;
    }
    if (!sameName(open, s.open)) {
      log.info(`launch: ${open} was opened by hand while ${s.table} waited; it is used as it is`);
      dropSwap();
      return false;
    }
    if (s.closing) return false;
    if (s.gone) {
      // Its VPX has ended; the witness lets go of the table when its close-time capture is done.
      moveSwap(s, 'closing', null, `${s.open} is closed (its VPX has ended); ${s.table} is started when the witness is done with it`);
      return false;
    }
    if (s.person) {
      moveSwap(s, 'close_it', null, `${s.open} is the person's to close; ${s.table} opens when it is closed`);
      return false;
    }
    clearSwapTimer();
    if (!mayAuto(s)) {
      // The final review: a close request of a change before may still be out for this very table (this PC lost the
      // lobby for a moment while it was closing): it is closing, and that is what is said, not an offer.
      if (out !== null && out.code === s.code && sameName(out.open, s.open)) {
        moveSwap(s, 'closing', null, `${s.open} was asked to close for the change before, and that cannot be taken back: it may close yet; ${s.table} is opened when it has`);
        return false;
      }
      moveSwap(s, 'offered', s.only, `${offerReason(s)}: ${s.table} waits for Open it, and ${s.open} stays open`);
      return false;
    }
    if (!follows() || !o.closer) {
      moveSwap(s, 'close_it', null, `${s.open} is a table Castcade cannot follow (it has no evidence that it would see a game on it): Castcade does not close it; ${s.table} opens when the person has closed it`);
      return false;
    }
    const pid = processOf(s.open);
    if (pid === null) {
      const n = witness.status().vpxOpen ?? 0;
      moveSwap(s, 'close_it', null, `${n > 1 ? `${n} VPX are open on this PC, and Castcade cannot tell which one a person plays on` : `Castcade does not know which VPX process holds ${s.open}`}: nothing is asked to close; ${s.table} opens when the person has closed the table`);
      return false;
    }
    const game = busy();
    if (game) {
      moveSwap(s, 'own_game', game.why, game.why === 'initials' ? `${s.open} is left open for the high-score initials of its last game; ${s.table} opens after that` : `a game is on ${s.open}: nothing is closed; ${s.table} opens after it`);
      if (game.until !== null) {
        swapTimer = later(() => {
          swapTimer = null;
          void reconcile();
        }, Math.max(0, game.until - now()) + 20);
      }
      return false;
    }
    moveSwap(s, 'closing', null, `${s.open} (pid ${pid}) is asked to close: the lobby's table is now ${s.table}`);
    // Step 10: a change this PC makes by itself counts towards the number after which it asks first: the change,
    // once, however often its close has to be asked (a game that began in between, a table that changed back).
    if (!s.asked && !s.counted) {
      s.counted = true;
      noteAutoChange(s.table);
    }
    s.closing = true;
    const closing = s.open;
    // From here a request may be out, whatever becomes of this change.
    dropOut();
    const mine = { code: s.code, open: closing, pid, table: s.table };
    out = mine;
    // Asked before every request, and again at the moment the window message is posted: the change still stands,
    // the setting still allows it (or Open it was pressed), the table is still followed, it is still the one VPX
    // that is open, and no game began.
    // (The setting itself, not the limit of step 10: that one was looked at before this close began, and counts it.)
    const mayClose = (): boolean => swap === s && (s.asked || settingOn()) && follows() && processOf(closing) === pid && busy() === null;
    void o.closer
      .close(closing, pid, mayClose)
      .then(
        (r) => r,
        (e: unknown) => ({ state: 'ask' as const, why: describe(e), asked: true }),
      )
      .then((r) => {
        s.closing = false;
        if (stopped) return;
        if (out === mine) {
          if (r.state !== 'closed' && !r.asked) dropOut(); // nothing was ever sent: nothing can still close it
          else if (r.state !== 'closed') {
            // Sent, and not obeyed in time: it may still be. Remembered a while longer.
            if (outTimer !== null) cancel(outTimer);
            outTimer = later(() => {
              outTimer = null;
              if (out === mine) out = null;
              // (The lobby may have been told that this table is closing: it is told that it is not.)
              void reconcile();
            }, LATE_CLOSE);
          }
        }
        if (r.state === 'closed' || r.asked) s.sent = true;
        if (swap === s) {
          if (r.state === 'closed') s.gone = true;
          // A request that was not answered in time is not repeated: from here the person closes the table. `held`
          // (a game began before the next request): the rules above are gone through again, and the game is waited for.
          else if (r.state === 'ask') s.person = true;
        }
        void reconcile();
      });
    return false;
  };
  /**
   * A close request is out and no change is left to follow it (review, finding 7): the lobby's table changed back,
   * this PC joined again, the lobby was left. When that table closes: in the lobby, the lobby's table as it is now is
   * opened; with no lobby, the tab says what happened. Never silence.
   */
  const settleOut = (m: MatchStatus, open: string | null): void => {
    const r = out;
    if (!r) return;
    if (open !== null) {
      // Still open (the request may yet be obeyed), or another table was opened by hand: then nothing is owed.
      if (!sameName(open, r.open)) dropOut();
      return;
    }
    dropOut();
    if ((swap !== null && swap.code === r.code) || (want !== null && want.code === r.code)) return; // a change, or a wish, takes it from here
    if (m.role !== 'none' && m.code === r.code) {
      log.info(`launch: ${r.open} closed because Castcade had asked it to, for a change to ${r.table} that was taken back meanwhile: the lobby's table as it is now is started`);
      want = { code: r.code, path: null, pick: true };
      return;
    }
    log.warn(`launch: ${r.open} closed because Castcade had asked it to, for a change to ${r.table}, and this PC is no longer in that lobby: nothing is started; the tab says so`);
    notice = `Castcade had asked ${r.open} to close, to open ${r.table} for the lobby. You have left that lobby since, and the request could not be taken back: the table is closed. Open it again in VPX if you want to go on playing.`;
  };

  const start = async (table: { vpxPath: string; tableId: string }, why: string): Promise<void> => {
    setLaunch({ state: 'starting', table: table.tableId, detail: `Starting VPX on ${table.tableId}` });
    emit();
    const r = await launchTable(table);
    if (stopped) return;
    if (!r.ok) {
      log.warn(`launch: ${table.tableId} not started (${why}): ${r.reason}`);
      setLaunch({ state: 'failed', table: table.tableId, detail: `Castcade could not start ${table.tableId}: ${r.reason}. Open it in VPX yourself; the lobby waits.` });
      return;
    }
    log.info(`launch: ${table.tableId} started (${why})`);
    clearLaunchTimer();
    launchTimer = later(() => {
      launchTimer = null;
      if (launch.state !== 'starting') return;
      log.warn(`launch: VPX did not show ${table.tableId} within ${Math.round(waitMs / 1000)} s`);
      setLaunch({ state: 'failed', table: table.tableId, detail: `VPX did not open ${table.tableId} yet. Open it in VPX yourself if it does not appear; the lobby waits.` });
      emit();
    }, waitMs);
  };

  /**
   * Settles the wish against the world as it is now. Called after Host and after a join, and on every match and
   * witness status; it never assumes what happened before it.
   */
  const settle = async (): Promise<void> => {
    const m = match.status();
    // A started VPX shows its table: the wait is over, whoever started it.
    const open = tableOpen();
    // A17 step 3: a table that is known not to be the lobby's (no copy of the lobby's table is on this PC) is not
    // taken for one while it stands; another table, or none, and the rule below is the old one.
    if (stale && (open === null || !sameName(open, stale.open) || stale.code !== m.code)) stale = null;
    // Review of PR 139: a witness that is not watching does not know that a table is closed.
    const blind = unsure();
    // A game that ended on a table that is closed protects nothing any more.
    if (open === null && !blind) gameEnded = null;
    if (open !== null && (launch.state === 'starting' || launch.state === 'needed' || launch.state === 'failed') && !(stale !== null && launch.state === 'needed')) setLaunch({ state: 'running', table: open, detail: null });
    else if (open === null && launch.state === 'running') setLaunch(IDLE);
    // No match any more: nothing is waited for, and what the last match left on the tab goes with it.
    if (m.role === 'none' && m.phase !== 'connecting') {
      if (want) log.info('launch: the match ended before the table was started; nothing to start');
      want = null;
      held = null;
      copiedFor = null;
      hostTable = null;
      nameOnly = null;
      hostSeen = null;
      lobbyTable = null;
      stale = null;
      myPick = null;
      copyVerdict = null;
      judged = null;
      keptAtJoin = null;
      dropSwap();
      // A request that is out is still followed to its end: the table it closes was this person's.
      if (!blind) settleOut(m, open);
      clearHashTimer();
      abortHashing();
      match.setLaunchNote?.(null);
      if (launch.state !== 'idle' && launch.state !== 'starting') setLaunch(IDLE);
      return;
    }
    // The link goes on the clipboard once per hosted match, when the invite exists (it comes after the listener is up).
    const link = linkOf(m);
    // A17 step 9: a member has the link too, and theirs is copied when they ask for it: joining a lobby leaves the clipboard alone.
    if (link && m.role === 'host' && m.code && copiedFor === null) copyNow(link, m.code, 'the join link');
    // A14.7: a held table is for this match only, and a table the player opened meanwhile is the one that is used.
    if (held && (m.code !== held.code || open !== null)) held = null;
    // A17 step 3: the lobby's table (the pick). Its first naming is the table of the join (a table that is open here
    // then is kept), and so is its first naming after this PC joined again (a lobby opened again under its code, a
    // place that ran out, a reconnect, a resume): nobody changed anything while this PC was there. Only another name
    // under the same stay is a change, and this PC follows it, whoever's PC it is.
    // The final review: a lobby can stand with no table (opened with "No table: I open it myself"). The first table
    // picked in it while this PC was there is somebody's press heard live: the picker's own PC opens the file it
    // picked, a PC with nothing open follows as for any change, and a PC with another table open is offered it.
    const pick = lobbyTableNow(m);
    const stay = m.role !== 'none' && m.code !== null ? (match.lobbyTable?.() ?? null) : null;
    /** The table this PC's own person picked is the lobby's table of that name: their press, taken by the lobby's PC. */
    const isMine = (name: string): boolean => myPick !== null && myPick.code === m.code && sameName(myPick.name, name);
    if (stay !== null && m.code !== null) {
      const named = pick?.name ?? null;
      const replace = open ?? (launch.state === 'starting' ? launch.table : null);
      if (lobbyTable === null || lobbyTable.code !== m.code) lobbyTable = { code: m.code, joined: stay.joined, name: named };
      else if (lobbyTable.joined !== stay.joined) {
        const was = lobbyTable.name;
        const other = named !== null && (was === null || !sameName(was, named));
        /** A change was waiting on this PC when it lost the lobby (a game, a table its person had to close, an offer). */
        const waited = swap !== null || want?.change !== undefined;
        /** That change was already one this PC had not heard live. */
        const unheard = swap?.only === 'away' || want?.away === 'away';
        /** Nobody changed anything: the table was only on offer here, and is again (`judge`). */
        const offer = (swap !== null && swap.only === 'here') || want?.away === 'here';
        /** Open it had been pressed for it: that press still stands. */
        const asked = swap?.asked === true || want?.asked === true;
        log.info(`launch: this PC joined the lobby again${other ? `; the lobby's table is ${named} (it was ${was ?? 'none'})` : ''}: as at any join, the table that is open here is kept and nothing is closed`);
        lobbyTable = { code: m.code, joined: stay.joined, name: named };
        dropSwap();
        if (want?.change) {
          want = null;
          // What that wish last said on the tab (a wait for the table's fingerprint) is over with it.
          if (launch.state === 'waiting_host') setLaunch(open !== null ? { state: 'running', table: open, detail: null } : IDLE);
        }
        if (other) {
          stale = null;
          if (myPick !== null && named !== null && !sameName(myPick.name, named)) myPick = null;
        }
        judged = null;
        // Review of PR 139 (finding 2): a pick this PC did not hear live closes nothing, and is not lost either: this
        // PC's copy is looked for as for any change, and the change then stands as an offer (Open it), whatever the
        // setting says. So does a change that was waiting when the link dropped.
        if (named !== null && (other || (waited && !offer))) {
          log.info(`launch: ${other ? `the lobby's table changed while this PC was away from the lobby` : 'a change of the lobby\'s table was waiting on this PC when it lost the lobby'}: ${named} is offered (Open it); Castcade does not change tables for it by itself`);
          nameOnly = null;
          hostSeen = null;
          clearHashTimer();
          abortHashing();
          match.setLaunchNote?.(null);
          want = { code: m.code, path: null, change: { replace }, away: other || unheard ? 'away' : 'back', ...(asked && !other ? { asked: true } : {}) };
        }
      } else if (named !== null && lobbyTable.name === null) {
        lobbyTable.name = named;
        const own = isMine(named);
        log.info(`launch: the lobby had no table, and ${named} was picked${own ? ' on this PC' : ''}${replace !== null ? `; ${replace} is ${open !== null ? 'open' : 'starting'} on this PC` : ''}`);
        judged = null;
        // A wish that stands (a join by link that waited for the lobby's table) starts it as a join does.
        if (want === null) {
          // The picker's own press: their PC opens the file they picked (and closes another table by the rules of any
          // change). Nothing open on another PC: as for any change. Another table open there: the offer (`judge`).
          if (own) want = { code: m.code, path: null, change: { replace }, asked: true };
          else if (replace === null) want = { code: m.code, path: null, change: { replace: null } };
        }
      } else if (named !== null && lobbyTable.name !== null && !sameName(lobbyTable.name, named)) {
        log.info(`launch: the lobby's table changed from ${lobbyTable.name} to ${named}${replace !== null ? `; ${replace} is ${open !== null ? 'open' : 'starting'} on this PC` : ''}`);
        lobbyTable.name = named;
        const own = isMine(named);
        if (myPick !== null && !own) myPick = null;
        // What was being read, waited for or offered was for the table before.
        nameOnly = null;
        hostSeen = null;
        clearHashTimer();
        abortHashing();
        dropSwap();
        stale = null;
        judged = null;
        match.setLaunchNote?.(null);
        // (The person who picked pressed for it: on their own PC that press is their Open it.)
        want = { code: m.code, path: null, change: { replace }, ...(own ? { asked: true } : {}) };
      }
    }
    // A request that is out, with no change left to follow it (it was taken back): its end is still Castcade's.
    if (!blind) settleOut(m, open);
    // The open table of a change is gone: the lobby's table is found again and started, as at a join.
    if (settleSwap(m.code, open) && m.code !== null) want = { code: m.code, path: null, pick: true };
    const w = want;
    if (!w) return;
    if (m.code !== w.code) {
      want = null;
      return;
    }
    if (launch.state === 'starting') return;
    /** A17 step 3: the table that is open is the one the lobby's new table may take the place of. */
    const replacing = open !== null && w.change !== undefined && w.change.replace !== null && sameName(open, w.change.replace);
    if (open !== null && !replacing) {
      // Any order: the table is open already (the player opened it, or it never closed). Nothing is started.
      abortHashing();
      want = null;
      log.info(`launch: ${open} is already open; nothing started`);
      // The final review: in a lobby that has a table, whether the open table is this PC's copy of it is looked at
      // next (`judge`): "Using the table that is already open" is said when it is, and the lobby's table is offered
      // when it is not.
      const inLobby = pick !== null && w.path === null;
      if (inLobby) keptAtJoin = { code: w.code, open };
      // (A wish that was taken over by this one may have been `judge`'s: it looks again.)
      judged = null;
      setLaunch({ state: 'running', table: open, detail: inLobby ? null : `Using the table that is already open: ${open}` });
      return;
    }
    if (w.path !== null) {
      // The host's pick. The path was checked against the known tables when it was picked.
      want = null;
      const t = (await pickable()).find((k) => k.vpxPath === w.path);
      if (!t) {
        setLaunch({ state: 'failed', table: null, detail: 'That table is no longer in the list. Open it in VPX yourself; the lobby waits.' });
        return;
      }
      await start(t, 'the host picked it');
      return;
    }
    // A joining rig: the table is the host's game, known once the host's table is open. A17 step 3: after a change
    // of the lobby's table it is the pick itself (a match that is open still names the table before).
    const game = (w.change || w.pick ? match.lobbyTable?.()?.game : null) ?? match.hostGame();
    if (!game || !isTableOpen(game)) {
      setLaunch({ state: 'waiting_host', table: null, detail: "Waiting for the lobby's table to open; Castcade then starts the same table here" });
      return;
    }
    // A table name from another PC is cleaned before it is logged or shown; the table is found from the name as it came.
    const gameName = tableWords(game.tableName);
    /** What is left of this change, as it starts out. */
    // (`sent`: a close request from a change before may still be out for the table that is open: when it closes, it
    // closed because Castcade asked, and the lobby's table is opened in its place whatever else holds.)
    const requested = out !== null && out.code === w.code && open !== null && sameName(out.open, open);
    const swapFor = (over: Partial<Swap>): Swap => ({ code: w.code, open, table: gameName, state: 'offered', why: null, unnamed: false, only: w.away ?? null, blind: false, counted: false, asked: w.asked === true, closing: false, gone: false, sent: requested, person: false, said: false, ...over });
    // Review of PR 139 (findings 4 and 5): the witness is not watching. Castcade then knows neither what is open here
    // nor whether a game is on: for a change it closes nothing and starts nothing, and asks the person.
    if ((w.change || w.pick) && blind) {
      want = null;
      abortHashing();
      // (A press that was made stays with it: `again` hands it on when the witness watches again.)
      swap = swapFor({ state: 'close_it', why: 'unwatched', blind: true });
      settleSwap(w.code, open);
      return;
    }
    // A17 step 10: after a change, a VPX whose table the witness cannot name is not "no table open": nothing is
    // started beside it. The person is asked to close it.
    if ((w.change || w.pick) && open === null && vpxOpenNow() > 0) {
      want = null;
      abortHashing();
      swap = swapFor({ open: null, state: 'close_it', why: 'unnamed', unnamed: true });
      if (settleSwap(w.code, open)) {
        want = { code: w.code, path: null, pick: true };
        settleAgain = true;
      }
      return;
    }
    // I11.4.15: the host's table objects are waited for from when its table was seen, or from when its file hash came
    // if that is later (the host reads both from the file at once, and either may land first).
    if (hostSeen === null || hostSeen.code !== w.code) hostSeen = { code: w.code, at: now(), hashAt: null };
    if (hostSeen.hashAt === null && hostHash(game) !== null) hostSeen.hashAt = now();
    const seenAt = hostSeen.hashAt ?? hostSeen.at;
    // I11.4.11: the host's table is named a moment before its file is hashed (its witness reads the name, then the
    // file). A table picked in that moment could only be picked by name: the hash is waited for, briefly.
    if (hostHash(game) === null) {
      if (nameOnly === null || nameOnly.code !== w.code) nameOnly = { code: w.code, at: now() };
      const left = HOST_HASH_WAIT_MS - (now() - nameOnly.at);
      if (left > 0) {
        setLaunch({ state: 'waiting_host', table: null, detail: "The lobby's table is open; waiting a moment for its file's fingerprint, to start the identical file here" });
        clearHashTimer();
        hashTimer = later(() => {
          hashTimer = null;
          void reconcile();
        }, left + 20);
        return;
      }
      log.info(`launch: the host's ${gameName} came with no file hash in ${HOST_HASH_WAIT_MS / 1000} s; the table is looked for by name`);
    }
    nameOnly = null;
    clearHashTimer();
    const known = await o.tables().catch(() => [] as KnownTable[]);
    const files = o.tableFiles ? await o.tableFiles(known).catch(() => [] as KnownTable[]) : [];
    let all = [...known, ...files];
    // Review of PR 139 (finding 11): the table this PC's own person picked: this PC opens the file that was picked
    // (the one whose table objects went out with the pick), whatever other copies of that game it has.
    const picked = myPick !== null && myPick.code === w.code && sameName(myPick.name, game.tableName) ? myPick.path : null;
    const own = picked !== null ? (all.find((t) => t.vpxPath === picked) ?? null) : null;
    // I11.4.11: the host's file is known by its hash and no table here has that hash: the copies of that title that
    // nothing has hashed yet are hashed (a few at most, one at a time, each kept for the next time), so the identical
    // file is found where there is one. Only on a PC where the identical file buys something (3D: the Castcade VPX
    // build is here and 3D watch is on). Not in the way of anything: the reads run beside this, the join has long
    // returned, and the match ending, a table opened by hand, a new Host or Join or `stop` end them at once.
    const want0 = hostHash(game);
    const key = `${w.code}|${want0 ?? ''}`;
    if (hashRun && hashRun.key !== key) abortHashing();
    if (hashRun && !hashRun.done) return;
    if (hashRun?.done) {
      const got = hashRun.hashes;
      all = all.map((t) => (got.has(t.vpxPath) ? { ...t, sha256: got.get(t.vpxPath) as string } : t));
    } else if (own === null && o.hashTable && want0 !== null && (match.wants3d?.() ?? false)) {
      const every = unhashedCandidates(game, all);
      const some = every.slice(0, HASH_CANDIDATES_MAX);
      if (some.length > 0) {
        const run = { key, ctl: new AbortController(), done: false, hashes: new Map<string, string>() };
        hashRun = run;
        const hashTable = o.hashTable;
        setLaunch({ state: 'waiting_host', table: null, detail: `Looking for the lobby's file among ${some.length} ${some.length === 1 ? 'copy' : 'copies'} of ${gameName} on this PC` });
        void (async (): Promise<void> => {
          for (const t of some) {
            if (run.ctl.signal.aborted) return;
            const sha = await hashTable(t.vpxPath, run.ctl.signal).catch(() => null);
            if (sha) run.hashes.set(t.vpxPath, sha.toLowerCase());
            if (sha && sha.toLowerCase() === want0) break;
          }
          if (hashRun !== run || run.ctl.signal.aborted || stopped) return;
          run.done = true;
          const found = [...run.hashes.values()].includes(want0);
          log.info(
            `launch: hashed ${run.hashes.size} of ${some.length} ${some.length === 1 ? 'copy' : 'copies'} of the host's ${gameName} that had no hash: ${found ? 'one is the identical file' : 'none is the identical file'}${!found && every.length > some.length ? `; ${every.length - some.length} more ${every.length - some.length === 1 ? 'copy was' : 'copies were'} not looked at (${HASH_CANDIDATES_MAX} at most)` : ''}`,
          );
          void reconcile();
        })();
        return;
      }
    }
    // The world may have moved while the lists were read.
    if (want !== w || tableOpen() !== open || match.status().code !== w.code) {
      settleAgain = true;
      return;
    }
    // I11.4.15: the identical file is not on this PC (or is passed over): the bytes say nothing more, and what the 3D
    // view needs is the same table objects in both VPX. The host says its table's (HELLO_ACK); this PC's copies of
    // that title are read for theirs (a few at most, one at a time, each kept for the next time; beside this, given
    // up as the hashing is), and the pick ranks by them. Only on a PC where 3D can run. A host that says nothing (an
    // older Castcade) is waited for from the moment its table was seen, as long as its file hash is, and no longer.
    // Review of PR #125 (finding 5): nothing holds a join where it cannot change the pick. With one copy of the title
    // on this PC no word of the host's does, so it is not waited for; and the reads have `OBJECTS_READ_MS` in all.
    let evidence: ObjectsEvidence | undefined;
    const readObjects = o.tableObjects;
    const byBytes = findLocalTable(game, all);
    if (own === null && byBytes && byBytes.how !== 'same_file' && readObjects && (match.wants3d?.() ?? false)) {
      const hostObjects = match.hostTableObjects?.() ?? null;
      if (hostObjects === null) {
        const choice = objectsCandidates(game, all).length > 1;
        const left = choice ? HOST_HASH_WAIT_MS - (now() - seenAt) : 0;
        if (left > 0) {
          setLaunch({ state: 'waiting_host', table: null, detail: "The lobby's table is open; waiting a moment for what it holds, to start a copy here that 3D works with" });
          clearHashTimer();
          hashTimer = later(() => {
            hashTimer = null;
            void reconcile();
          }, left + 20);
          return;
        }
        if (match.hostTableObjects && choice) log.info(`launch: the host's ${gameName} came with no table objects in ${HOST_HASH_WAIT_MS / 1000} s (an older Castcade there, or a file they cannot be told from); the table is picked by its file and name`);
        abortObjects();
      } else {
        const okey = `${w.code}|${forkIdentityText(hostObjects)}`;
        if (objectsRun && objectsRun.key !== okey) abortObjects();
        if (objectsRun && !objectsRun.done) return;
        if (!objectsRun) {
          const every = objectsCandidates(game, all);
          const some = every.slice(0, OBJECTS_CANDIDATES_MAX);
          const run = { key: okey, ctl: new AbortController(), done: false, ids: new Map<string, ForkIdentity>(), looked: 0, timer: null as unknown };
          objectsRun = run;
          const copies = (n: number): string => `${n} ${n === 1 ? 'copy' : 'copies'}`;
          setLaunch({ state: 'waiting_host', table: null, detail: `Looking at ${copies(some.length)} of ${gameName} on this PC: which holds the same table objects as the lobby's` });
          /** The pick goes on with what is known: every copy was looked at, or the time for it is over. */
          const finish = (late: boolean): void => {
            if (objectsRun !== run || run.done || run.ctl.signal.aborted || stopped) return;
            run.done = true;
            if (run.timer !== null) cancel(run.timer);
            run.timer = null;
            const same = [...run.ids.values()].filter((id) => sameForkIdentity(id, hostObjects)).length;
            const unread = every.length - run.looked;
            log.info(
              `launch: the table objects of ${copies(run.looked)} of the host's ${gameName} (table ${forkIdentityText(hostObjects)}): ${same} the same, ${run.ids.size - same} other, ${run.looked - run.ids.size} not to be told${
                unread > 0 ? `; ${copies(unread)} more not looked at (${late ? `the reads took longer than ${OBJECTS_READ_MS / 1000} s` : `${OBJECTS_CANDIDATES_MAX} at most`})` : ''
              }`,
            );
            void reconcile();
          };
          run.timer = later(() => {
            run.timer = null;
            finish(true);
          }, OBJECTS_READ_MS);
          void (async (): Promise<void> => {
            for (const t of some) {
              if (run.ctl.signal.aborted || run.done) return;
              const id = await readObjects(t.vpxPath, run.ctl.signal).catch(() => null);
              // Past the time: the read is not given up (what it found is kept for the next join), only not waited for.
              if (run.done) return;
              run.looked += 1;
              if (id) run.ids.set(t.vpxPath, id);
            }
            finish(false);
          })();
          return;
        }
        evidence = { host: hostObjects, local: objectsRun.ids };
      }
    }
    const found: ReturnType<typeof findLocalTable> = own !== null ? { table: own, how: hostHash(game) !== null && own.sha256 === hostHash(game) ? 'same_file' : 'same_name', objects: 'same' } : findLocalTable(game, all, evidence);
    want = null;
    // (What follows is the answer for this table of the lobby and this open table: `judge` does not ask again.)
    judged = `${w.code}|${gameName}|${open ?? ''}`;
    /** Who picked the lobby's table, for the sentences ("You", a name), when this PC knows. */
    const by = pickerOf(match.status(), gameName);
    const changedTo = w.away === 'here' ? `The lobby's table is ${gameName}.` : by === null ? `The lobby's table is now ${gameName}.` : `${by} changed the lobby's table to ${gameName}.`;
    /** The table that is open here is itself this PC's copy of the lobby's game (by the rules a copy is found with). */
    const openIsCopy = open !== null && isCopy(game, open, all);
    if (!found && !(w.change && openIsCopy)) {
      log.info(`launch: no local table for the host's ${gameName}${open !== null ? `; ${open} stays open (nothing is closed)` : ''}`);
      // A17 step 3: no copy, so nothing closes: the table that is open stays, and is not taken for the lobby's.
      if (open !== null) stale = { code: w.code, open };
      setLaunch({
        state: 'needed',
        table: gameName,
        detail:
          open !== null
            ? `${changedTo} Castcade found no copy of it on this PC, and ${open} stays open: you can watch, or pick another table.`
            : (w.change || w.pick) && w.away !== 'here'
              ? `${changedTo} Castcade found no copy of it on this PC: you can watch, or pick another table.`
              : noCopyAtJoinWords(gameName),
      });
      return;
    }
    if (w.change) {
      if (open !== null) {
        // A17 step 3: another table is open. One that is itself a copy of the lobby's new game is kept, as a table
        // open at the join is (the lobby says how it differs). Any other waits to be closed: `swap`.
        if (openIsCopy) {
          // Review of PR 139 (finding 6): a close request may be out for this very table (the lobby's table changed
          // away and back): then it is closing, and that is said; it is opened again when it has closed (`out`).
          const leaving = out !== null && out.code === w.code && sameName(out.open, open);
          setLaunch({
            state: 'running',
            table: open,
            detail: leaving ? `${open} is closing: Castcade had asked it to close before the lobby's table changed back to ${gameName}, and that cannot be taken back. Castcade opens it again when it has closed.` : `Using the table that is already open: ${open}`,
          });
          log.info(`launch: ${open} is open and is a copy of the lobby's ${gameName}; nothing is closed or started${leaving ? ' (it is closing: a request from before is out; it is started again when it has closed)' : ''}`);
          return;
        }
        if (!found) return;
        setLaunch({ state: 'running', table: open, detail: null });
        log.info(`launch: this PC's copy of the lobby's ${gameName} is ${found.table.tableId}; ${open} is open in its place`);
        swap = swapFor({});
        // (The table may have gone while the lists were read: then the copy is started in the next pass.)
        if (settleSwap(w.code, tableOpen())) {
          want = { code: w.code, path: null, pick: true };
          settleAgain = true;
        }
        return;
      }
      const only = w.away ?? (offerOnly() === 'often' ? 'often' : null);
      // (Asked for by the person themselves: Open it, or their own pick: started whatever else holds.)
      if (!w.asked && (only !== null || !settingOn())) {
        // It is only offered (the setting is off, this PC asks first, or it did not hear the pick live): nothing
        // opens by itself either; the tab offers the table.
        swap = swapFor({ open: null, why: only, only, said: true });
        log.info(`launch: the lobby's table is now ${gameName} and ${offerReason(swap)}: it waits for Open it`);
        return;
      }
      // Step 10: nothing was open, and the new table is started by itself: that counts as a change this PC made.
      if (!w.asked) noteAutoChange(gameName);
    }
    if (!found) return;
    // Step 10: the lobby is told that its table is being opened here.
    opening = w.change !== undefined || w.pick === true;
    // Not the host's file: said here for the log; the lobby says it to the player before the start.
    const theirs = evidence?.host ? forkIdentityText(evidence.host) : null;
    const mine = evidence?.local.get(found.table.vpxPath) ?? null;
    /** I11.4.15: this copy is known not to hold the host's table objects: no 3D with it. */
    const not3d = found.objects === 'differs';
    let note: string | null = null;
    if (found.identical) {
      // The host's file is here and is not imported: the imported copy is started all the same (it can report ball
      // ends, the other cannot: a match that takes turns comes before 3D), and the player is told how to get 3D.
      log.warn(`launch: the host's file is on this PC as ${found.identical.tableId}, not imported; ${found.table.tableId} (imported: it reports ball ends) is started. For 3D: import ${found.identical.tableId} in Castcade and rejoin`);
      note = identicalFileNote(found.identical.tableId);
    } else if (found.how !== 'same_file' && found.objects === 'same') {
      // I11.4.15: other bytes, the same objects: a re-save or another download of the host's table. 3D runs.
      log.info(`launch: ${found.table.tableId} is not the host's file and holds the same table objects (table ${theirs ?? ''}): 3D works with it`);
    } else if (not3d) {
      // I11.4.15: said plainly before the start, with the copy that would give 3D when this PC has one.
      log.warn(
        `launch: ${found.table.tableId} does not hold the host's table objects (table ${mine ? forkIdentityText(mine) : 'unknown'} here, ${theirs ?? 'unknown'} on the host's PC): the 2D video, not 3D. ${
          found.sameObjects
            ? `${found.sameObjects.tableId} on this PC holds them and is not imported (${found.table.tableId} is: it reports ball ends). For 3D: import ${found.sameObjects.tableId} in Castcade and rejoin`
            : `No copy of ${gameName} on this PC that Castcade looked at holds them`
        }`,
      );
      if (found.sameObjects) note = sameObjectsNote(found.sameObjects.tableId);
    } else if (found.how !== 'same_file' && hostHash(game) !== null) log.warn(`launch: no copy of ${gameName} on this PC is the host's file; ${found.table.tableId} is started by its name (the lobby says the files differ)`);
    if (note !== null || not3d) match.setLaunchNote?.(note, not3d);
    const objectsWord = found.how === 'same_file' ? '' : found.objects === 'same' ? ', the same table objects' : not3d ? ', other table objects' : '';
    await start(found.table, `the host plays ${gameName}: ${found.how.replace('_', ' ')}${objectsWord}${found.table.imported ? '' : ', not imported'}`);
    if (note !== null && launch.state !== 'failed') setLaunch({ ...launch, detail: `${launch.detail ?? ''}${launch.detail ? ' · ' : ''}${note}` });
  };
  /**
   * One look at a time. A call that comes while a look runs asks for one more pass and waits for the same end, so
   * whoever awaits `reconcile` has what its own change led to (a Host that set its wish while a status was settled).
   */
  const reconcile = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (settling !== null) {
      settleAgain = true;
      return settling;
    }
    settling = (async (): Promise<void> => {
      try {
        do {
          settleAgain = false;
          await settle();
          // What the look at the open table found (a copy after all, or a table to offer) is settled in the same go.
          if (!settleAgain && !stopped && (await judge())) settleAgain = true;
        } while (settleAgain && !stopped);
      } catch (e) {
        log.warn(`launch: ${describe(e)}`);
      } finally {
        settling = null;
      }
      reportChange();
      emit();
    })();
    return settling;
  };

  // ---- review of PR 139 (finding 1): "this is my copy of the lobby's table" ----
  const samePath = (a: string, b: string): boolean => a.replace(/\//g, '\\').toLowerCase() === b.replace(/\//g, '\\').toLowerCase();
  /**
   * The table that is open here, as this PC's lists know it: the file the witness names (else the tables of its
   * name), and what the witness itself read of the open file (its hash, its own name), which also covers a table
   * from a folder Castcade does not list.
   */
  const openAsKnown = (open: string, all: readonly KnownTable[]): KnownTable[] => {
    const id = witness.status().currentIdentity ?? null;
    const file = id?.filePath ?? null;
    const byPath = file ? all.filter((t) => samePath(t.vpxPath, file)) : [];
    const mine = byPath.length > 0 ? byPath : all.filter((t) => sameName(open, t.tableId) || sameName(open, fileName(t.vpxPath)));
    const sha = id?.sha256?.toLowerCase() ?? '';
    const seen: KnownTable = { tableId: open, vpxPath: file ?? '', infoName: id?.tableInfo?.tableName?.trim() || null, rom: null, sha256: /^[0-9a-f]{64}$/.test(sha) ? sha : null, imported: false, lastPlayedAt: null, patchedAt: null };
    return [...mine, seen];
  };
  /** The open table is a copy of `game` by the rules a copy is looked for with (`find-table.ts`): its file, its ROM, its name or title. */
  const isCopy = (game: GameFingerprint, open: string, all: readonly KnownTable[]): boolean => findLocalTable(game, openAsKnown(open, all)) !== null;
  /** Who picked the lobby's table, when it is `table` and this PC knows: "You", or their name. */
  const pickerOf = (m: MatchStatus, table: string): string | null => {
    const l = m.lobby ?? null;
    if (!l || l.table.name === null || l.table.pickedBy === null || !sameName(l.table.name, table)) return null;
    if (l.members.some((x) => x.me && x.id === l.table.pickedBy)) return 'You';
    return l.table.pickedByName;
  };
  /**
   * After every look: is the table open on this PC this PC's own copy of the lobby's table? The verdict is the one
   * `find-table.ts` gives here (its file, its ROM, its name or title), over the open table as this PC's lists and
   * its witness know it.
   *
   * - It is: the lobby is told (review of PR 139, finding 1: the lobby's own comparison has the names and the bytes,
   *   and a copy found by its ROM shares neither with the pick). A change that was only waiting for this table to be
   *   closed, and "no copy on this PC", are over: the witness has read the file since and it is the copy.
   * - It is not, or nothing is open (the final review): the lobby's table is on offer here, once per table that is
   *   open: a wish like any change's, which finds this PC's copy and stands as an offer (Open it), or says that
   *   there is no copy. Never while something else is under way (a wish, a change, a start, a table that is closing),
   *   and not before the witness has read the open file or `IDENTITY_WAIT_MS` have gone by.
   *
   * Answers true when it changed what `settle` works on.
   */
  const judge = async (): Promise<boolean> => {
    if (stopped) return false;
    const m = match.status();
    if (m.role === 'none') {
      copyVerdict = null;
      judged = null;
      return false;
    }
    const pick = lobbyTableNow(m);
    const open = tableOpen();
    if (open === null || openSeen === null || openSeen.open !== open) openSeen = open === null ? null : { open, at: now() };
    if (!pick || m.code === null) {
      match.setPickCopy?.(null);
      return false;
    }
    const leaving = out !== null && open !== null && sameName(out.open, open);
    const id = witness.status().currentIdentity ?? null;
    let copy = false;
    if (open !== null) {
      const key = [m.code, pick.game.kind, pick.game.tableName, pick.game.tableHash, pick.game.romName ?? '', open, id?.filePath ?? ''].join('|');
      const detail = `${id?.sha256 ?? ''}|${id?.tableInfo?.tableName ?? ''}`;
      let v = copyVerdict;
      // A table that was found to be a copy stays one while it stands open; one that was not is looked at again when
      // more is known of it (its hash, its own name).
      if (v === null || v.key !== key || (!v.copy && v.detail !== detail)) {
        const all = await pickable();
        if (stopped || tableOpen() !== open || match.status().code !== m.code) return false;
        v = copyVerdict = { key, detail, copy: isCopy(pick.game, open, all) };
      }
      copy = v.copy;
    }
    const s = swap !== null && swap.code === m.code ? swap : null;
    if (open !== null && copy) {
      let moved = false;
      // A change (or an offer) that stood because this table was taken for another game, with nothing asked of the
      // table yet: it is this PC's copy after all.
      if (s && !unsure() && !s.unnamed && s.open !== null && sameName(s.open, open) && !s.closing && !s.sent && !s.gone) {
        log.info(`launch: ${open} is this PC's copy of the lobby's ${s.table} after all (its file has been read since): nothing is closed or offered`);
        dropSwap();
        moved = true;
      }
      if (stale !== null && sameName(stale.open, open)) {
        stale = null;
        setLaunch({ state: 'running', table: open, detail: `Using the table that is already open: ${open}` });
        moved = true;
      }
      if (keptAtJoin !== null && keptAtJoin.code === m.code && sameName(keptAtJoin.open, open) && launch.state === 'running' && launch.detail === null) setLaunch({ state: 'running', table: open, detail: `Using the table that is already open: ${open}` });
      keptAtJoin = null;
      match.setPickCopy?.(!leaving && swap === null ? { pick: pick.game.tableName.slice(0, 200), open } : null);
      return moved;
    }
    match.setPickCopy?.(null);
    if (open === null) keptAtJoin = null;
    // The offer. Not while anything else is under way, and not from a witness that is not watching.
    if (s !== null || want !== null || launch.state === 'starting' || leaving || unsure() || held !== null || entering) return false;
    const key = `${m.code}|${pick.name}|${open ?? ''}`;
    if (judged === key) return false;
    if (open !== null && !id?.sha256) {
      // The witness names a table before it has read its file: the identical file under another name is not offered
      // away on its launch name alone.
      const left = (o.identityWaitMs ?? IDENTITY_WAIT_MS) - (now() - (openSeen?.at ?? now()));
      if (left > 0) {
        if (identityTimer !== null) cancel(identityTimer);
        identityTimer = later(() => {
          identityTimer = null;
          void reconcile();
        }, left + 20);
        return false;
      }
    }
    judged = key;
    keptAtJoin = null;
    log.info(`launch: the lobby's table is ${pick.name} and ${open !== null ? `${open}, open on this PC, is not this PC's copy of it` : 'no table is open on this PC'}: this PC's copy is looked for, to offer it (Open it); nothing is closed or opened by itself`);
    want = { code: m.code, path: null, change: { replace: open }, away: 'here' };
    return true;
  };

  /**
   * A17 step 10: where this PC stands on its way to the lobby's table, said to the lobby after every look (the match
   * host only passes on what changed), with the sentence for this PC's own panel while its person may have to act.
   */
  const reportChange = (): void => {
    if (launch.state !== 'starting') opening = false;
    if (!match.setTableChange || stopped) return;
    const m = match.status();
    if (m.role === 'none') return;
    const s = swap !== null && swap.code === m.code ? swap : null;
    // Review of PR 139 (finding 6): no change is left, and a close request from before is out for the table that is
    // open: it is closing, and the lobby hears that (a start does not count this PC in until it has a table again).
    const open = tableOpen();
    const leaving = s === null && out !== null && out.code === m.code && open !== null && sameName(out.open, open) ? out : null;
    const state: TableChange | null = s ? (s.state === 'own_game' ? 'waits_game' : s.state === 'close_it' ? 'waits_person' : s.state === 'offered' ? 'offered' : 'closing') : leaving ? 'closing' : opening ? 'opening' : null;
    try {
      match.setTableChange(state, s ? changeWords(s.state, s.table, s.open, s.why, pickerOf(m, s.table)) : leaving ? `${leaving.open} is closing (Castcade had asked it to close, and that cannot be taken back); the lobby's table opens when it has closed.` : null);
    } catch (e) {
      log.warn(`launch: the lobby was not told where this PC stands with its table: ${describe(e)}`);
    }
  };

  const copyNow = (text: string, code: string, what: string): void => {
    try {
      o.clipboard.writeText(text);
      copiedFor = code;
      log.info(`launch: ${what} is on the clipboard`);
    } catch (e) {
      log.warn(`launch: the clipboard did not take ${what}: ${describe(e)}`);
    }
  };

  const offs = [
    match.onStatus((s) => {
      // A game in progress sends many statuses; none of them matters here unless a table is still to be started, a
      // change of the lobby's table waits on this PC (A17 step 3), or the lobby's table has just changed.
      if ((s.phase === 'playing' || s.phase === 'paused') && !want && !swap && !out && launch.state !== 'starting' && !lobbyTableMoved(s)) return;
      void reconcile();
    }),
    witness.onStatus(() => void reconcile()),
    // A17 step 3: the game on this PC's table. Its scores come several times a second; only its start and its end
    // are kept, and only a change that waits is settled again.
    witness.onGame?.((g) => {
      const on = g?.inGame ?? false;
      if (on === gameOn) return;
      gameOn = on;
      // A game that is no longer read (the witness lost the table) counts as one that has just ended.
      gameEnded = on ? null : { at: now(), scores: (g?.scores ?? []).filter((n): n is number => typeof n === 'number' && n > 0), qualifies: undefined, held: false };
      // A request cannot be taken back. The closer asks before each one, down to the moment the message is posted; a
      // game that begins after that is closed with its table, and the log says that this is what happened.
      if (on && out !== null) log.warn(`launch: a game began on ${out.open} while Castcade was asking it to close: no further request is made, and one that is already out cannot be taken back (the table then closes under the game)`);
      if (swap) void reconcile();
    }) ?? ((): void => undefined),
  ];

  /**
   * A17 step 10: make `t`, a table of this PC's lists, the lobby's table. What goes into the pick: the name a PC's
   * own fingerprint gives that file (the table's own name: as the witness read it, else read from the file now, for
   * a few seconds at most; the file's name when it has none), the SHA-256 of the file (hashed now when it never was;
   * without one the pick is by name, and the tab says so), the ROM, and the Castcade VPX build's identity of this
   * copy (read now, for a few seconds at most). The lobby's PC judges it. This PC then opens this very file for it.
   */
  const pickFrom = async (t: KnownTable, about: string | null): Promise<MatchStatus> => {
    if (!match.pickTable) throw new Error("This Castcade cannot change the lobby's table.");
    if (match.status().role === 'none') throw new Error('You are not in a lobby.');
    /** A read of the file, given up after a few seconds (a file in the cloud, a disk that sleeps). */
    const timed = async <T>(read: Promise<T | null>): Promise<T | null> => {
      let timer: unknown = null;
      const got = await Promise.race([read.catch(() => null), new Promise<null>((resolve) => (timer = later(() => resolve(null), OBJECTS_READ_MS)))]);
      if (timer !== null) cancel(timer);
      return got;
    };
    let sha = t.sha256;
    if (!sha && o.hashTable) sha = await o.hashTable(t.vpxPath).catch(() => null);
    let info = t.infoName?.trim() || null;
    if (info === null && o.tableInfoName) info = (await timed(o.tableInfoName(t.vpxPath)))?.trim() || null;
    const objects = o.tableObjects ? await timed(o.tableObjects(t.vpxPath)) : null;
    const hash = sha?.toLowerCase() ?? '';
    const game: GameFingerprint = {
      kind: 'vpx',
      tableName: (info || t.tableId).slice(0, 200),
      tableHash: /^[0-9a-f]{64}$/.test(hash) ? hash : ZERO_SHA256,
      romName: t.rom?.trim() || null,
      romHash: null,
      physicsHash: null,
      recipeVersion: null,
      sidecarHash: null,
      emulatorVersion: '',
    };
    const unread = game.tableHash === ZERO_SHA256;
    log.info(`launch: ${t.tableId} is picked as the lobby's table${info ? ` (${tableWords(info)})` : ''}${objects ? ` (table objects ${forkIdentityText(objects)})` : ''}${unread ? ' (its file could not be read for its hash: by its name)' : ''}`);
    const st = await askPick(game, objects, about, t.vpxPath);
    // Review of PR 139 (finding 8): a pick by name alone is said where it was made.
    notice = unread ? `Castcade could not read the file of ${t.tableId}, so it is the lobby's table by its name alone: every PC opens its own table of that name, and Castcade cannot tell who has the identical file.` : null;
    emit();
    return st;
  };

  /**
   * The final review: a pick is sent, and is this person's act only once the lobby's PC has taken it. On the lobby's
   * own PC the answer is at once. On a joined PC it comes a moment later: the lobby's table is the picked one (taken),
   * or a sentence of the lobby's PC arrives (refused: thrown, for the tab), or nothing comes for `PICK_ANSWER_MS`.
   * Until then nothing on this PC counts the pick as made: "asks first" stands, and no table is closed or opened for
   * it (that follows the lobby's table, which a refused pick does not change). `path`: the file that was picked,
   * which this PC then opens for it (null: the table that is open here).
   *
   * The step 9 last pass: the answer is the match host's for this very request (`MatchHost.pickTable`). It was read
   * from the Match tab's one sentence (`lastError`), where another refusal arriving in the same moment (a start, an
   * End match) was taken for the pick's.
   */
  const askPick = async (game: GameFingerprint, objects: ForkIdentity | null, about: string | null, path: string | null): Promise<MatchStatus> => {
    if (!match.pickTable) throw new Error("This Castcade cannot change the lobby's table.");
    const code = match.status().code;
    const before = myPick;
    myPick = path !== null ? { code, name: game.tableName, path } : null;
    let st: MatchStatus;
    try {
      const a = await match.pickTable({ game, objects, about, waitMs: o.pickAnswerMs ?? PICK_ANSWER_MS });
      if (a.kind === 'refused') throw new Error(a.sentence);
      if (a.kind === 'none') {
        const m = match.status();
        throw new PickUnanswered(m.role === 'none' || m.code !== code ? 'You left the lobby before its PC answered.' : "The lobby's PC has not answered yet. If the lobby's table changes in a moment, it took the pick; if it does not, press again.");
      }
      st = a.status;
    } catch (e) {
      // Refused: this PC's pick of before is what stands. No answer: the pick may yet be taken, and is then this PC's.
      if (!(e instanceof PickUnanswered)) myPick = before;
      log.warn(`launch: the pick of ${tableWords(game.tableName)} was not taken: ${describe(e)}`);
      throw e;
    }
    // Taken. The person acted: what this PC did by itself before counts no more.
    personActed();
    return st;
  };

  /** Join by a checked link; throws what the match host threw. The table is then the wish `settle` works on. */
  const join = async (link: JoinLink, displayName = ''): Promise<MatchStatus> => {
    // I11.4.11: a new join: what was being read for the last match is given up at once.
    abortHashing();
    const m = match.status();
    if (m.role !== 'none') {
      if (m.code === link.code) throw new Error('You are already in this lobby.');
      throw new Error('Leave the current lobby first, then open the link again.');
    }
    notice = null;
    setLaunch(IDLE);
    lobbyTable = null;
    stale = null;
    myPick = null;
    copyVerdict = null;
    judged = null;
    keptAtJoin = null;
    dropSwap();
    personActed();
    // An empty name is the saved one (`MatchHost.join`). While the join is under way the lobby is already seen (its
    // statuses come before the join returns): the link's own wish is the one that counts, not an offer made meanwhile.
    let st: MatchStatus;
    entering = true;
    try {
      st = await match.join(link.invite, displayName);
    } finally {
      entering = false;
    }
    log.info(`launch: joined ${link.code} by link`);
    dropSwap();
    judged = null;
    want = { code: link.code, path: null };
    await reconcile();
    return st;
  };

  return {
    async tables() {
      return (await o.tables()).map(choice);
    },

    async browse() {
      if (!o.tableFiles) return [];
      return (await o.tableFiles(await o.tables().catch(() => [] as KnownTable[]))).map(choice);
    },

    async host(h) {
      abortHashing();
      let pick: KnownTable | null = null;
      if (h.tablePath !== null) {
        // Only a table from Castcade's own list: the renderer's string is a key into it, never a path to run.
        pick = (await pickable()).find((t) => t.vpxPath === h.tablePath) ?? null;
        if (!pick) throw new Error('That table is not in the list any more: pick it again');
      }
      notice = null;
      pending = null;
      setLaunch(IDLE);
      copiedFor = null;
      held = null;
      lobbyTable = null;
      stale = null;
      myPick = null;
      copyVerdict = null;
      judged = null;
      keptAtJoin = null;
      dropSwap();
      personActed();
      hostTable = pick?.tableId ?? null;
      let st: MatchStatus;
      entering = true;
      try {
        st = await match.host({ port: h.port, ballsPerGame: h.ballsPerGame, displayName: h.displayName });
      } finally {
        entering = false;
      }
      dropSwap();
      judged = null;
      if (st.code && pick) {
        if (h.startTable) want = { code: st.code, path: pick.vpxPath };
        else {
          want = null;
          held = { code: st.code, path: pick.vpxPath, name: pick.tableId };
          log.info(`launch: ${pick.tableId} waits for Start the table (the invite comes first)`);
        }
      } else if (st.code) want = null;
      await reconcile();
      return match.status();
    },

    async startTable() {
      const h = held;
      if (!h || match.status().code !== h.code) return status();
      held = null;
      want = { code: h.code, path: h.path };
      await reconcile();
      return status();
    },

    async pick(path, about = null) {
      const t = (await pickable()).find((k) => k.vpxPath === path);
      // Only a table from Castcade's own list: the renderer's string is a key into it.
      if (!t) throw new Error('That table is not in the list any more: pick it again');
      return pickFrom(t, about);
    },

    async pickOpen(about = null, name = null) {
      const open = tableOpen();
      if (open === null) throw new Error('No table is open on this PC.');
      // Review of PR 139 (finding 10): the question named a table; another one is open at the answer: nothing is picked.
      if (name !== null && !sameName(open, name)) throw new Error(`${tableWords(name)} was not made the lobby's table: ${open} is open on this PC now. Look again and press again.`);
      // The file the witness names, when it is one of this PC's lists; else a table of that name; else what this PC
      // says of its open table to the lobby (a table from a folder Castcade does not list).
      const file = witness.status().currentIdentity?.filePath ?? null;
      const all = await pickable();
      const t = (file !== null ? all.find((k) => k.vpxPath.toLowerCase() === file.toLowerCase()) : undefined) ?? all.find((k) => sameName(open, fileName(k.vpxPath)) || sameName(open, k.tableId));
      if (t) return pickFrom(t, about);
      const own = match.ownTable?.() ?? null;
      if (!match.pickTable || !own) throw new Error("Castcade cannot make this table the lobby's table yet: it is still reading it. Try again in a moment.");
      log.info(`launch: ${open} (open on this PC, in none of Castcade's lists) is picked as the lobby's table`);
      return askPick(own, null, about, null);
    },

    async openPick() {
      const s = swap;
      if (!s || match.status().code !== s.code) return status();
      log.info(`launch: Open it: ${s.table} is asked for on this PC${s.open !== null ? ` (${s.open} is open)` : ''}`);
      // The person acted: what this PC did by itself before counts no more.
      personActed();
      s.asked = true;
      if (s.open === null) {
        // Nothing is open: the lobby's table is found and started, as at a join.
        dropSwap();
        want = { code: s.code, path: null, pick: true, asked: true };
      }
      await reconcile();
      // The final review: a press that could not be carried out now is not lost without a word. With the witness not
      // watching it stands (the change says what to do), and is carried out when watching is back.
      return status();
    },

    async openLink(text, ctx) {
      attention++;
      const link = parseJoinLink(text);
      if (!link) {
        log.warn('launch: a castcade:// link that is not a join link was ignored');
        notice = 'That link is not a Castcade lobby link.';
        emit();
        return status();
      }
      const m = match.status();
      if (m.role !== 'none') {
        notice = m.code === link.code ? 'You are already in this lobby.' : 'That link is for another lobby: leave this one first, then open the link again.';
        emit();
        return status();
      }
      if (!ctx.trusted) {
        log.info(`launch: a link for ${link.code} waits for the player's click`);
        pending = link;
        notice = null;
        emit();
        return status();
      }
      pending = null;
      try {
        await join(link);
      } catch (e) {
        notice = linkJoinFailure(describe(e));
        log.warn(`launch: the link for ${link.code} did not join: ${describe(e)}`);
      }
      emit();
      return status();
    },

    async joinLink(text, displayName = '') {
      const link = looksLikePastedLink(text) ? parseJoinLink(text) : null;
      if (!link) throw new Error('That is not a Castcade lobby link. It looks like castcade://join/ABCDEF: ask for it to be copied again.');
      pending = null;
      try {
        return await join(link, displayName);
      } finally {
        emit();
      }
    },

    async confirm() {
      const link = pending;
      if (!link) return status();
      pending = null;
      try {
        await join(link);
      } catch (e) {
        notice = linkJoinFailure(describe(e));
        log.warn(`launch: the link for ${link.code} did not join: ${describe(e)}`);
      }
      emit();
      return status();
    },

    dismiss() {
      pending = null;
      notice = null;
      emit();
      return status();
    },

    copy(what) {
      const s = status();
      const m = match.status();
      const text = what === 'message' ? s.message : s.link;
      if (text && m.code) copyNow(text, m.code, what === 'message' ? 'the chat line' : 'the join link');
      emit();
      return status();
    },

    status,
    onStatus(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    stop() {
      stopped = true;
      clearLaunchTimer();
      clearHashTimer();
      abortHashing();
      dropSwap();
      dropOut();
      if (identityTimer !== null) cancel(identityTimer);
      identityTimer = null;
      for (const off of offs) off();
      listeners.clear();
    },
  };
}
