/**
 * A14 (2026-11-12): one step to a match. The owner, about hosting: "start VPX, launch the table, switch views back to
 * desktop, Host session, copy code, paste code in Discord, wait … then switch view back to VR table, then play. It's
 * really clunky … and if any of that is out of order, things seem to fail." This module sits beside the match host
 * (`match-host.ts`), which it only calls:
 *
 * - **Host**: `host({ tablePath })` hosts the match, copies the join link (`castcade://join/<invite>`) to the
 *   clipboard and starts VPX on the picked table. A table that is already open is used as it is and nothing is started.
 * - **A link** (`openLink`, from the command line of a first or second instance; `joinLink`, pasted on the Match tab):
 *   joins that match with the saved name and starts the host's table on this PC. The table is looked up here
 *   (`launch/find-table.ts`) from what the host announced (`HELLO_ACK.hostGame`); none here → the Match tab says which
 *   table is needed and the player stays joined. A link that came from outside while the Match tab was not showing
 *   waits for one click (`confirm`): a web page must not join a match (the microphone goes live) or start a game by
 *   itself.
 * - **Any order**: what is still to be started is a wish (`want`), settled by `reconcile` on every match and witness
 *   status: the host's table may open after the join (the wish waits for the host's fingerprint), a table may already
 *   be open (nothing is started), VPX may take a minute (the wish is not repeated), the match may end first (dropped).
 *
 * Everything that touches the outside (the process spawner, the clipboard, the table lists) is injected; nothing here
 * imports Electron.
 */
import type { GameFingerprint } from '@castcade/protocol';
import { findLocalTable } from '../launch/find-table.js';
import type { KnownTable } from '../launch/known-tables.js';
import type { VpxLauncher } from '../launch/vpx-launch.js';
import { formatJoinLink, inviteMessage, looksLikeLink, parseJoinLink, type JoinLink } from './deep-link.js';
import type { MatchStatus } from './match-host.js';
import { isTableOpen } from './match-setup.js';

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

export interface OneStepStatus {
  /** While hosting: the join link and the line for a chat. Null otherwise. */
  link: string | null;
  message: string | null;
  /** The link of this match was put on the clipboard (at Host, or by Copy). */
  copied: boolean;
  /** A link from outside that waits for the player's click. */
  pending: { code: string; address: string | null } | null;
  launch: { state: LaunchState; table: string | null; detail: string | null };
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
  };
  witness: {
    status(): { currentTable: string | null };
    onStatus(cb: (s: { currentTable: string | null }) => void): () => void;
  };
  launcher: VpxLauncher;
  clipboard: { writeText(text: string): void };
  /** The imported tables, most recent first (`launch/known-tables.ts`). */
  tables(): Promise<KnownTable[]>;
  /** Other `.vpx` files in the tables folder, for a joining rig. Default: none. */
  tableFiles?(known: readonly KnownTable[]): Promise<KnownTable[]>;
  log: { info(line: string): void; warn(line: string): void };
  /** How long a started VPX may take to show its table before the Match tab says it did not. Default 2 minutes. */
  launchWaitMs?: number;
  setTimeout?(fn: () => void, ms: number): unknown;
  clearTimeout?(handle: unknown): void;
}

export const DEFAULT_LAUNCH_WAIT_MS = 120_000;

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
  let want: { code: string; path: string | null } | null = null;
  let launchTimer: unknown = null;
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

  const linkOf = (m: MatchStatus): string | null => (m.role === 'host' && m.invite ? formatJoinLink(m.invite) : null);

  const status = (): OneStepStatus => {
    const m = match.status();
    const link = linkOf(m);
    return {
      link,
      message: link ? inviteMessage(link, tableOpen() ?? hostTable) : null,
      copied: link !== null && copiedFor !== null && copiedFor === m.code,
      pending: pending ? { code: pending.code, address: pending.address } : null,
      launch: { ...launch },
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
  };

  const start = async (table: { vpxPath: string; tableId: string }, why: string): Promise<void> => {
    setLaunch({ state: 'starting', table: table.tableId, detail: `Starting VPX on ${table.tableId}` });
    emit();
    const r = await o.launcher.launch(table.vpxPath);
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
    if (open !== null && (launch.state === 'starting' || launch.state === 'needed' || launch.state === 'failed')) setLaunch({ state: 'running', table: open, detail: null });
    else if (open === null && launch.state === 'running') setLaunch(IDLE);
    // No match any more: nothing is waited for, and what the last match left on the tab goes with it.
    if (m.role === 'none' && m.phase !== 'connecting') {
      if (want) log.info('launch: the match ended before the table was started; nothing to start');
      want = null;
      copiedFor = null;
      hostTable = null;
      if (launch.state !== 'idle' && launch.state !== 'starting') setLaunch(IDLE);
      return;
    }
    // The link goes on the clipboard once per hosted match, when the invite exists (it comes after the listener is up).
    const link = linkOf(m);
    if (link && m.code && copiedFor === null) copyNow(link, m.code, 'the join link');
    const w = want;
    if (!w) return;
    if (m.code !== w.code) {
      want = null;
      return;
    }
    if (launch.state === 'starting') return;
    if (open !== null) {
      // Any order: the table is open already (the player opened it, or it never closed). Nothing is started.
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
    // A joining rig: the table is the host's game, known once the host's table is open.
    const game = match.hostGame();
    if (!game || !isTableOpen(game)) {
      setLaunch({ state: 'waiting_host', table: null, detail: "Waiting for the host's table to open; Castcade then starts the same table here" });
      return;
    }
    const known = await o.tables().catch(() => [] as KnownTable[]);
    const files = o.tableFiles ? await o.tableFiles(known).catch(() => [] as KnownTable[]) : [];
    // The world may have moved while the lists were read.
    if (want !== w || tableOpen() !== null || match.status().code !== w.code) {
      settleAgain = true;
      return;
    }
    const found = findLocalTable(game, [...known, ...files]);
    want = null;
    if (!found) {
      log.info(`launch: no local table for the host's ${game.tableName}`);
      setLaunch({ state: 'needed', table: game.tableName, detail: `The host plays ${game.tableName}. Castcade found no copy of it on this PC: open it in VPX if you have it under another name. You stay in the match.` });
      return;
    }
    await start(found.table, `the host plays ${game.tableName}: ${found.how.replace('_', ' ')}${found.table.imported ? '' : ', not imported'}`);
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
      // A game in progress sends many statuses; none of them matters here unless a table is still to be started.
      if ((s.phase === 'playing' || s.phase === 'paused') && !want && launch.state !== 'starting') return;
      void reconcile();
    }),
    witness.onStatus(() => void reconcile()),
  ];

  /** Join by a checked link; throws what the match host threw. The table is then the wish `settle` works on. */
  const join = async (link: JoinLink, displayName = ''): Promise<MatchStatus> => {
    const m = match.status();
    if (m.role !== 'none') {
      if (m.code === link.code) throw new Error('You are already in this match.');
      throw new Error('Leave the current match first, then open the link again.');
    }
    notice = null;
    setLaunch(IDLE);
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
      hostTable = pick?.tableId ?? null;
      const st = await match.host({ port: h.port, ballsPerGame: h.ballsPerGame, displayName: h.displayName });
      if (st.code) want = pick ? { code: st.code, path: pick.vpxPath } : null;
      await reconcile();
      return match.status();
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
      const link = looksLikeLink(text) ? parseJoinLink(text) : null;
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
      for (const off of offs) off();
      listeners.clear();
    },
  };
}
