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
 *   and never `hostGame()`, which is a match's own table once one has started. As the code stands nothing changes a
 *   pick once it is made (a table opened by hand, on the lobby's PC too, is never one): A17 step 10 wires TABLE_PICK
 *   into the shell, and this path is what then runs on every PC.
 *
 * Everything that touches the outside (the process spawner, the clipboard, the table lists) is injected; nothing here
 * imports Electron.
 */
import type { GameFingerprint } from '@castcade/protocol';
import { HASH_CANDIDATES_MAX, OBJECTS_CANDIDATES_MAX, findLocalTable, hostHash, identicalFileNote, objectsCandidates, sameObjectsNote, unhashedCandidates, type ObjectsEvidence } from '../launch/find-table.js';
import { forkIdentityText, sameForkIdentity, type ForkIdentity } from '../launch/fork-identity.js';
import type { KnownTable } from '../launch/known-tables.js';
import { objectsDisagreeLine } from '../launch/table-objects.js';
import type { VpxCloser } from '../launch/vpx-close.js';
import type { ForkLaunch, LaunchResult, VpxLauncher } from '../launch/vpx-launch.js';
import { formatJoinLink, formatWebJoinLink, inviteMessage, looksLikePastedLink, parseJoinLink, type JoinLink } from './deep-link.js';
import type { MatchStatus } from './match-host.js';
import { NO_TABLE_NAME, isTableOpen } from './match-setup.js';

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
     * A17 step 3: the lobby's table, a pick (`MatchHost.lobbyTable`): a change of its name is what this PC follows.
     * Absent: nothing is followed (the table of a join is still found from `hostGame`).
     */
    lobbyTable?(): GameFingerprint | null;
  };
  witness: {
    /**
     * `captureMode` (A17 step 3): `live` when Castcade follows the open table through the hook's journal; anything
     * else (basic mode, or not said) is a table it cannot follow, which it never closes.
     */
    status(): { currentTable: string | null; captureMode?: 'live' | 'basic' | null };
    onStatus(cb: (s: { currentTable: string | null }) => void): () => void;
    /** A17 step 3: the game on the open table as live mode reads it, and every change of it. Absent: no game is ever seen. */
    liveGame?(): { inGame: boolean; scores: (number | null)[] } | null;
    onGame?(cb: (g: { inGame: boolean; scores: (number | null)[] } | null) => void): () => void;
    /** A17 step 3: a finished game's score has a place on the open table's high-score list (`Witness.highScoreQualifies`). Absent: never. */
    highScoreQualifies?(score: number): boolean;
  };
  /**
   * A17 step 3: asks the open table's VPX to close (`launch/vpx-close.ts`). Absent: Castcade closes nothing, and the
   * person is asked to.
   */
  closer?: VpxCloser;
  /** A17 step 3: "Change tables for me" (`match.json` `changeTablesForMe`). Absent: on. */
  changeTablesForMe?(): boolean;
  /** A17 step 3: `AFTER_GAME_MS` and `INITIALS_WAIT_MS` for the tests. */
  afterGameMs?: number;
  initialsWaitMs?: number;
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
 * A17 step 3: how long after the end of a game whose score has a place on the machine's high-score list the table is
 * left alone for the initials (the cap of the controller's own hold, `INITIALS_HOLD_CAP_MS`). A game of the match has
 * the controller's hold, which ends with the initials; a game of one's own has only this.
 */
export const INITIALS_WAIT_MS = 90_000;

/** Lower-case letters and digits only: how two names of one table file are compared. */
const squash = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, '');
const sameName = (a: string, b: string): boolean => squash(a) === squash(b);
/** The name of a table file as the witness names an open table (`tableNameFromPath`). */
const fileName = (vpxPath: string): string => (vpxPath.split(/[\\/]/).pop() ?? vpxPath).replace(/\.vpx$/i, '');

/** A17 step 3: what the Match tab says of a change that waits (alpha-match.md sections 11.5 and 11.9). */
export function changeWords(state: ChangeState, table: string, open: string | null, why: 'game' | 'initials' | null = null): string {
  const now = `The lobby's table is now ${table}.`;
  switch (state) {
    case 'offered':
      return open === null ? now : `${now} Open it: Castcade closes ${open} and opens ${table}.`;
    case 'own_game':
      return why === 'initials'
        ? `${now} The high-score initials of the last game can still be entered on ${open ?? 'this table'}: Castcade opens ${table} after that, or as soon as you close the table.`
        : `${now} A game is being played on this PC's table: Castcade opens ${table} after it.`;
    case 'closing':
      return `${now} Closing ${open ?? 'the open table'}; ${table} opens next.`;
    case 'close_it':
      return `Close the table on this PC: Castcade opens ${table} when it is closed.`;
  }
}

const IDLE: OneStepStatus['launch'] = { state: 'idle', table: null, detail: null };

const describe = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** What a failed join by link says: a match that is gone says so. */
export function linkJoinFailure(raw: string): string {
  // A socket error can carry its stack: only the sentences are for the player.
  const detail = raw.replace(/\n\s+at [^\n]*/g, '').replace(/^Error: /, '');
  if (/The host refused/.test(detail)) return `Could not join that match. ${detail}`;
  // Sentences that already say what to do (D10.8's relay answers: not paired or no longer paired, full, held back,
  // a match that has started and is locked to its players; a request under way).
  if (/still working|Leave the current match|not paired|no longer paired|pair it (again )?(with ArcAid|in Settings)|is full\.|holding this PC back|has already started/i.test(detail)) return detail;
  return `That match is gone or cannot be reached: ask the host for a new link. (${detail})`;
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
}

/** A17 step 3: what is left of a change once this PC's copy of the new table is known (`OneStepStatus.change`). */
interface Swap {
  code: string;
  /** The table open on this PC; null: none (the setting is off and the new table waits for Open it). */
  open: string | null;
  /** The lobby's table, as it is named. */
  table: string;
  state: ChangeState;
  why: 'game' | 'initials' | null;
  /** Open it was pressed: with the setting off, Castcade may close the open table all the same. */
  asked: boolean;
  /** The closer is at work. */
  closing: boolean;
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
  /** A17 step 3: the lobby's table as it was last named, for the lobby with this code. Its first sighting is no change. */
  let lobbyTable: { code: string; name: string } | null = null;
  /** A17 step 3: this PC's copy of the lobby's new table was found while another table stood open: what is left of the change. */
  let swap: Swap | null = null;
  let swapTimer: unknown = null;
  /** A17 step 3: a table open on this PC that is known not to be the lobby's (no copy of the lobby's table is here): it is not taken for one. */
  let stale: { code: string; open: string } | null = null;
  /** A17 step 3: when the last game on this PC's table ended, with its scores; null while one is on, and before any. */
  let gameEnded: { at: number; scores: number[]; qualifies: boolean | null } | null = null;
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
  let settling = false;
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

  /** The link of the match being hosted: the clickable web form when ArcAid carries the match (A14.2), else `castcade://`. */
  const linkOf = (m: MatchStatus): string | null =>
    m.role === 'host' && m.invite ? (formatWebJoinLink(m.invite, o.arcaidBaseUrl?.() ?? null) ?? formatJoinLink(m.invite)) : null;

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
      change: swap !== null && swap.code === m.code ? { state: swap.state, table: swap.table, open: swap.open, detail: changeWords(swap.state, swap.table, swap.open, swap.why) } : null,
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
              setLaunch({ state: 'failed', table: table.tableId, detail: `Castcade could not start ${table.tableId}: ${again.reason}. Open it in VPX yourself; the match waits.` });
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
  /** The lobby's table (the pick) as it is named now; null with no lobby, and while no table is named. */
  const lobbyTableNow = (m: MatchStatus): string | null => {
    if (m.role === 'none') return null;
    const game = match.lobbyTable?.() ?? null;
    return game && isTableOpen(game) && game.tableName !== NO_TABLE_NAME ? game.tableName : null;
  };
  /** The lobby's table has another name than the one this PC last heard. */
  const lobbyTableMoved = (m: MatchStatus): boolean => {
    const named = lobbyTableNow(m);
    return named !== null && lobbyTable !== null && lobbyTable.code === m.code && !sameName(lobbyTable.name, named);
  };
  const AFTER_GAME = o.afterGameMs ?? AFTER_GAME_MS;
  const INITIALS_WAIT = o.initialsWaitMs ?? INITIALS_WAIT_MS;
  const clearSwapTimer = (): void => {
    if (swapTimer !== null) cancel(swapTimer);
    swapTimer = null;
  };
  const dropSwap = (): void => {
    clearSwapTimer();
    swap = null;
  };
  /**
   * Nothing is closed that might be a game: a game on the open table (the A16 window of a finished match game is one:
   * the table's own game still runs), the controller's initials hold, the moment after a game's end, and the time
   * for the initials of a game whose score made the machine's list. `until`: when the last two end by themselves.
   */
  const busy = (): { why: 'game' | 'initials'; until: number | null } | null => {
    if (witness.liveGame?.()?.inGame) return { why: 'game', until: null };
    if (match.tableHeld?.()) return { why: 'initials', until: null };
    const e = gameEnded;
    if (!e) return null;
    const since = now() - e.at;
    if (since < AFTER_GAME) return { why: 'game', until: e.at + AFTER_GAME };
    if (since >= INITIALS_WAIT) return null;
    // Asked once per game, and only when a change waits for the answer (the witness logs each one).
    if (e.qualifies === null) e.qualifies = e.scores.some((score) => witness.highScoreQualifies?.(score) ?? false);
    return e.qualifies ? { why: 'initials', until: e.at + INITIALS_WAIT } : null;
  };
  /** Castcade follows the open table (the hook's journal is read): only then can it know that no game is on. */
  const follows = (): boolean => witness.status().captureMode === 'live';
  const moveSwap = (s: Swap, state: ChangeState, why: 'game' | 'initials' | null, line: string): void => {
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
    if (s.open === null) {
      // Nothing was open: the new table waits for Open it. A table opened by hand meanwhile is the one that is used.
      if (open !== null) dropSwap();
      return false;
    }
    if (open === null) {
      // The table is closed: by Castcade's request, or by the person.
      const waits = !s.asked && !(o.changeTablesForMe?.() ?? true);
      if (waits) {
        // The setting is off and nobody asked: nothing opens by itself either.
        s.open = null;
        moveSwap(s, 'offered', null, `${s.table} still waits for Open it (Change tables for me is off)`);
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
    if (s.person) {
      moveSwap(s, 'close_it', null, `${s.open} is the person's to close; ${s.table} opens when it is closed`);
      return false;
    }
    clearSwapTimer();
    if (!s.asked && !(o.changeTablesForMe?.() ?? true)) {
      moveSwap(s, 'offered', null, `Change tables for me is off: ${s.table} waits for Open it, and ${s.open} stays open`);
      return false;
    }
    if (!follows() || !o.closer) {
      moveSwap(s, 'close_it', null, `${s.open} is a table Castcade cannot follow (no hook journal: it cannot know whether a game is on): Castcade does not close it; ${s.table} opens when the person has closed it`);
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
    moveSwap(s, 'closing', null, `${s.open} is asked to close: the lobby's table is now ${s.table}`);
    s.closing = true;
    const closing = s.open;
    void o.closer
      .close(closing, () => swap === s && follows() && busy() === null && sameName(tableOpen() ?? '', closing))
      .then(
        (r) => r,
        (e: unknown) => ({ state: 'ask' as const, why: describe(e) }),
      )
      .then((r) => {
        s.closing = false;
        if (swap !== s || stopped) return;
        // A request that was not answered in time is not repeated: from here the person closes the table. `held` (a
        // game began before the next request): the rules above are gone through again, and the game is waited for.
        if (r.state === 'ask') s.person = true;
        void reconcile();
      });
    return false;
  };

  const start = async (table: { vpxPath: string; tableId: string }, why: string): Promise<void> => {
    setLaunch({ state: 'starting', table: table.tableId, detail: `Starting VPX on ${table.tableId}` });
    emit();
    const r = await launchTable(table);
    if (stopped) return;
    if (!r.ok) {
      log.warn(`launch: ${table.tableId} not started (${why}): ${r.reason}`);
      setLaunch({ state: 'failed', table: table.tableId, detail: `Castcade could not start ${table.tableId}: ${r.reason}. Open it in VPX yourself; the match waits.` });
      return;
    }
    log.info(`launch: ${table.tableId} started (${why})`);
    clearLaunchTimer();
    launchTimer = later(() => {
      launchTimer = null;
      if (launch.state !== 'starting') return;
      log.warn(`launch: VPX did not show ${table.tableId} within ${Math.round(waitMs / 1000)} s`);
      setLaunch({ state: 'failed', table: table.tableId, detail: `VPX did not open ${table.tableId} yet. Open it in VPX yourself if it does not appear; the match waits.` });
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
    // A game that ended on a table that is closed protects nothing any more.
    if (open === null) gameEnded = null;
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
      dropSwap();
      clearHashTimer();
      abortHashing();
      match.setLaunchNote?.(null);
      if (launch.state !== 'idle' && launch.state !== 'starting') setLaunch(IDLE);
      return;
    }
    // The link goes on the clipboard once per hosted match, when the invite exists (it comes after the listener is up).
    const link = linkOf(m);
    if (link && m.code && copiedFor === null) copyNow(link, m.code, 'the join link');
    // A14.7: a held table is for this match only, and a table the player opened meanwhile is the one that is used.
    if (held && (m.code !== held.code || open !== null)) held = null;
    // A17 step 3: the lobby's table (the pick). Its first naming is the table of the join (a table that is open here
    // then is kept); a later, other name is a change, and this PC follows it, whoever's PC it is.
    const named = lobbyTableNow(m);
    if (named !== null && m.code !== null) {
      if (lobbyTable === null || lobbyTable.code !== m.code) lobbyTable = { code: m.code, name: named };
      else if (!sameName(lobbyTable.name, named)) {
        const replace = open ?? (launch.state === 'starting' ? launch.table : null);
        log.info(`launch: the lobby's table changed from ${lobbyTable.name} to ${named}${replace !== null ? `; ${replace} is ${open !== null ? 'open' : 'starting'} on this PC` : ''}`);
        lobbyTable.name = named;
        // What was being read, waited for or offered was for the table before.
        nameOnly = null;
        hostSeen = null;
        clearHashTimer();
        abortHashing();
        dropSwap();
        stale = null;
        match.setLaunchNote?.(null);
        want = { code: m.code, path: null, change: { replace } };
      }
    }
    // The open table of a change is gone: the lobby's table is found again and started, as at a join.
    if (settleSwap(m.code, open) && m.code !== null) want = { code: m.code, path: null };
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
      setLaunch({ state: 'running', table: open, detail: `Using the table that is already open: ${open}` });
      return;
    }
    if (w.path !== null) {
      // The host's pick. The path was checked against the known tables when it was picked.
      want = null;
      const t = (await pickable()).find((k) => k.vpxPath === w.path);
      if (!t) {
        setLaunch({ state: 'failed', table: null, detail: 'That table is no longer in the list. Open it in VPX yourself; the match waits.' });
        return;
      }
      await start(t, 'the host picked it');
      return;
    }
    // A joining rig: the table is the host's game, known once the host's table is open. A17 step 3: after a change
    // of the lobby's table it is the pick itself (a match that is open still names the table before).
    const game = (w.change ? match.lobbyTable?.() : null) ?? match.hostGame();
    if (!game || !isTableOpen(game)) {
      setLaunch({ state: 'waiting_host', table: null, detail: "Waiting for the host's table to open; Castcade then starts the same table here" });
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
        setLaunch({ state: 'waiting_host', table: null, detail: "The host's table is open; waiting a moment for its file's fingerprint, to start the identical file here" });
        clearHashTimer();
        hashTimer = later(() => {
          hashTimer = null;
          void reconcile();
        }, left + 20);
        return;
      }
      log.info(`launch: the host's ${game.tableName} came with no file hash in ${HOST_HASH_WAIT_MS / 1000} s; the table is looked for by name`);
    }
    nameOnly = null;
    clearHashTimer();
    const known = await o.tables().catch(() => [] as KnownTable[]);
    const files = o.tableFiles ? await o.tableFiles(known).catch(() => [] as KnownTable[]) : [];
    let all = [...known, ...files];
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
    } else if (o.hashTable && want0 !== null && (match.wants3d?.() ?? false)) {
      const every = unhashedCandidates(game, all);
      const some = every.slice(0, HASH_CANDIDATES_MAX);
      if (some.length > 0) {
        const run = { key, ctl: new AbortController(), done: false, hashes: new Map<string, string>() };
        hashRun = run;
        const hashTable = o.hashTable;
        setLaunch({ state: 'waiting_host', table: null, detail: `Looking for the host's file among ${some.length} ${some.length === 1 ? 'copy' : 'copies'} of ${game.tableName} on this PC` });
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
            `launch: hashed ${run.hashes.size} of ${some.length} ${some.length === 1 ? 'copy' : 'copies'} of the host's ${game.tableName} that had no hash: ${found ? 'one is the identical file' : 'none is the identical file'}${!found && every.length > some.length ? `; ${every.length - some.length} more ${every.length - some.length === 1 ? 'copy was' : 'copies were'} not looked at (${HASH_CANDIDATES_MAX} at most)` : ''}`,
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
    if (byBytes && byBytes.how !== 'same_file' && readObjects && (match.wants3d?.() ?? false)) {
      const hostObjects = match.hostTableObjects?.() ?? null;
      if (hostObjects === null) {
        const choice = objectsCandidates(game, all).length > 1;
        const left = choice ? HOST_HASH_WAIT_MS - (now() - seenAt) : 0;
        if (left > 0) {
          setLaunch({ state: 'waiting_host', table: null, detail: "The host's table is open; waiting a moment for what it holds, to start a copy here that 3D works with" });
          clearHashTimer();
          hashTimer = later(() => {
            hashTimer = null;
            void reconcile();
          }, left + 20);
          return;
        }
        if (match.hostTableObjects && choice) log.info(`launch: the host's ${game.tableName} came with no table objects in ${HOST_HASH_WAIT_MS / 1000} s (an older Castcade there, or a file they cannot be told from); the table is picked by its file and name`);
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
          setLaunch({ state: 'waiting_host', table: null, detail: `Looking at ${copies(some.length)} of ${game.tableName} on this PC: which holds the same table objects as the host's` });
          /** The pick goes on with what is known: every copy was looked at, or the time for it is over. */
          const finish = (late: boolean): void => {
            if (objectsRun !== run || run.done || run.ctl.signal.aborted || stopped) return;
            run.done = true;
            if (run.timer !== null) cancel(run.timer);
            run.timer = null;
            const same = [...run.ids.values()].filter((id) => sameForkIdentity(id, hostObjects)).length;
            const unread = every.length - run.looked;
            log.info(
              `launch: the table objects of ${copies(run.looked)} of the host's ${game.tableName} (table ${forkIdentityText(hostObjects)}): ${same} the same, ${run.ids.size - same} other, ${run.looked - run.ids.size} not to be told${
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
    const found = findLocalTable(game, all, evidence);
    want = null;
    if (!found) {
      log.info(`launch: no local table for the host's ${game.tableName}${open !== null ? `; ${open} stays open (nothing is closed)` : ''}`);
      // A17 step 3: no copy, so nothing closes: the table that is open stays, and is not taken for the lobby's.
      if (open !== null) stale = { code: w.code, open };
      setLaunch({
        state: 'needed',
        table: game.tableName,
        detail:
          open !== null
            ? `The lobby's table is now ${game.tableName}. Castcade found no copy of it on this PC: you can watch, or open it in VPX if you have it under another name. ${open} stays open.`
            : `The host plays ${game.tableName}. Castcade found no copy of it on this PC: open it in VPX if you have it under another name. You stay in the match.`,
      });
      return;
    }
    if (w.change) {
      if (open !== null) {
        // A17 step 3: another table is open. One that is itself a copy of the lobby's new game is kept, as a table
        // open at the join is (the lobby says how it differs). Any other waits to be closed: `swap`.
        const mine = all.filter((t) => sameName(open, t.tableId) || sameName(open, fileName(t.vpxPath)));
        const stub: KnownTable = { tableId: open, vpxPath: '', infoName: null, rom: null, sha256: null, imported: false, lastPlayedAt: null, patchedAt: null };
        const kept = mine.some((t) => t.vpxPath === found.table.vpxPath) || findLocalTable(game, mine.length > 0 ? mine : [stub]) !== null;
        setLaunch({ state: 'running', table: open, detail: kept ? `Using the table that is already open: ${open}` : null });
        if (kept) {
          log.info(`launch: ${open} is open and is a copy of the lobby's ${game.tableName}; nothing is closed or started`);
          return;
        }
        log.info(`launch: this PC's copy of the lobby's ${game.tableName} is ${found.table.tableId}; ${open} is open in its place`);
        swap = { code: w.code, open, table: game.tableName, state: 'offered', why: null, asked: false, closing: false, person: false, said: false };
        // (The table may have gone while the lists were read: then the copy is started in the next pass.)
        if (settleSwap(w.code, tableOpen())) {
          want = { code: w.code, path: null };
          settleAgain = true;
        }
        return;
      }
      if (!(o.changeTablesForMe?.() ?? true)) {
        // The setting is off: nothing opens by itself either; the tab offers the table.
        log.info(`launch: the lobby's table is now ${game.tableName} and Change tables for me is off: it waits for Open it`);
        swap = { code: w.code, open: null, table: game.tableName, state: 'offered', why: null, asked: false, closing: false, person: false, said: true };
        return;
      }
    }
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
            : `No copy of ${game.tableName} on this PC that Castcade looked at holds them`
        }`,
      );
      if (found.sameObjects) note = sameObjectsNote(found.sameObjects.tableId);
    } else if (found.how !== 'same_file' && hostHash(game) !== null) log.warn(`launch: no copy of ${game.tableName} on this PC is the host's file; ${found.table.tableId} is started by its name (the lobby says the files differ)`);
    if (note !== null || not3d) match.setLaunchNote?.(note, not3d);
    const objectsWord = found.how === 'same_file' ? '' : found.objects === 'same' ? ', the same table objects' : not3d ? ', other table objects' : '';
    await start(found.table, `the host plays ${game.tableName}: ${found.how.replace('_', ' ')}${objectsWord}${found.table.imported ? '' : ', not imported'}`);
    if (note !== null && launch.state !== 'failed') setLaunch({ ...launch, detail: `${launch.detail ?? ''}${launch.detail ? ' · ' : ''}${note}` });
  };
  const reconcile = async (): Promise<void> => {
    if (stopped) return;
    if (settling) {
      settleAgain = true;
      return;
    }
    settling = true;
    try {
      do {
        settleAgain = false;
        await settle();
      } while (settleAgain && !stopped);
    } catch (e) {
      log.warn(`launch: ${describe(e)}`);
    } finally {
      settling = false;
    }
    emit();
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
      if ((s.phase === 'playing' || s.phase === 'paused') && !want && !swap && launch.state !== 'starting' && !lobbyTableMoved(s)) return;
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
      gameEnded = on ? null : { at: now(), scores: (g?.scores ?? []).filter((n): n is number => typeof n === 'number' && n > 0), qualifies: null };
      if (swap) void reconcile();
    }) ?? ((): void => undefined),
  ];

  /** Join by a checked link; throws what the match host threw. The table is then the wish `settle` works on. */
  const join = async (link: JoinLink, displayName = ''): Promise<MatchStatus> => {
    // I11.4.11: a new join: what was being read for the last match is given up at once.
    abortHashing();
    const m = match.status();
    if (m.role !== 'none') {
      if (m.code === link.code) throw new Error('You are already in this match.');
      throw new Error('Leave the current match first, then open the link again.');
    }
    notice = null;
    setLaunch(IDLE);
    lobbyTable = null;
    stale = null;
    dropSwap();
    // An empty name is the saved one (`MatchHost.join`).
    const st = await match.join(link.invite, displayName);
    log.info(`launch: joined ${link.code} by link`);
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
      dropSwap();
      hostTable = pick?.tableId ?? null;
      const st = await match.host({ port: h.port, ballsPerGame: h.ballsPerGame, displayName: h.displayName });
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

    async openPick() {
      const s = swap;
      if (!s || match.status().code !== s.code) return status();
      log.info(`launch: Open it: ${s.table} is asked for on this PC${s.open !== null ? ` (${s.open} is open)` : ''}`);
      s.asked = true;
      if (s.open === null) {
        // Nothing is open: the lobby's table is found and started, as at a join.
        dropSwap();
        want = { code: s.code, path: null };
      }
      await reconcile();
      return status();
    },

    async openLink(text, ctx) {
      attention++;
      const link = parseJoinLink(text);
      if (!link) {
        log.warn('launch: a castcade:// link that is not a join link was ignored');
        notice = 'That link is not a Castcade match link.';
        emit();
        return status();
      }
      const m = match.status();
      if (m.role !== 'none') {
        notice = m.code === link.code ? 'You are already in this match.' : 'That link is for another match: leave this one first, then open the link again.';
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
      if (!link) throw new Error('That is not a Castcade match link. It looks like castcade://join/ABCDEF: ask the host to copy it again.');
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
      for (const off of offs) off();
      listeners.clear();
    },
  };
}
