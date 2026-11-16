/**
 * I11.4.1 (2026-11-16, ADR 0011): the 3D watch session in the shell. One session at a time, hosted or joined by a
 * six-letter code through ArcAid (`watch/watch-session.ts`); one tunnel end for it (`watch/tunnel-end.ts`: the data
 * connections to the other members and the loopback sockets); and the VPX fork, started here:
 *
 * - Play: this PC takes the player role for a table, a free loopback port is picked, the fork starts with
 *   `CASTCADE_STREAM=play` listening on 127.0.0.1 there, and the tunnel feeds the other members' watchers from it. The
 *   fork's exit frees the role (the testers swap without a new session).
 * - Watch: the player's table is looked for here by its file name (the imported tables, then the tables folder) and
 *   its size compared (a different size is said, and allowed: the fork refuses a table whose parts differ); not found,
 *   the player picks the file. The tunnel listens on 127.0.0.1 and the fork starts with `CASTCADE_STREAM=watch`
 *   connecting to it.
 *
 * Not a match: a PC that is in a match (or joining one) cannot host or join a session, and the other way round (one
 * ArcAid room per device; index.ts refuses the match side). No voice here: the testers use Discord. The fork exe goes
 * beside the VPX exe Castcade knows (`forkExeFor`); absent, the card says where. Castcade does not own the VPX it
 * starts: leaving the session leaves the table open, as a match does.
 *
 * The witness: a watcher this host starts is announced to it before the spawn (`expectVpx`, `witness/hidden-vpx.ts`),
 * so it never takes the watcher for a game (no launch report, no patch notice, no capture, no remembered exe). A player
 * is an ordinary game, scored as any; only its exe, the fork's, is never remembered (`isForkExe`).
 *
 * Nothing here imports Electron: the tunnel factory, the launcher and the file checks are handed in, so a test drives
 * it with fakes and the real session over the relay double.
 */
// win32 by name, as vpx-launch.ts does: every path here is a Windows path, and the tests also run on Linux.
import { win32 } from 'node:path';
import type { KnownTable } from '../launch/known-tables.js';
import { forkExeFor, forkStreamEnv, type VpxLauncher } from '../launch/vpx-launch.js';
import type { IceServer } from '../media/media-settings.js';
import type { ExpectedVpx, VpxExpectation } from '../witness/hidden-vpx.js';
import type { TunnelEnd, TunnelEndOptions } from '../watch/tunnel-end.js';
import type { WatchPath } from '../watch/watch-page.js';
import { WatchSession, type WatchSessionOptions, type WatchSessionState, type WatchTableInfo } from '../watch/watch-session.js';

export interface WatchMemberView {
  id: string;
  name: string;
  me: boolean;
  host: boolean;
  /** `self` for this PC; `away` while its connection to ArcAid is down. */
  path: 'self' | 'away' | WatchPath;
  /** The path in words: "connected directly", "no direct path between your routers". */
  line: string;
}

export interface WatchStatus {
  state: 'off' | 'connecting' | 'on' | 'ended';
  role: 'host' | 'client' | null;
  code: string | null;
  members: WatchMemberView[];
  player: { id: string; name: string; me: boolean; table: string; size: number } | null;
  /** This PC's VPX in the session. */
  local: { vpx: 'none' | 'playing' | 'watching'; table: string | null; pid: number | null };
  /** The table Watch would open here (looked for when someone else plays). */
  watchTable: { path: string | null; line: string; warn: boolean } | null;
  /** The VPX fork beside the VPX exe. */
  fork: { present: boolean; path: string | null; line: string | null };
  /** The session's link to ArcAid when it is not plain ("reconnecting to ArcAid"). */
  relayLine: string | null;
  /** The last thing that went wrong, in a sentence. */
  error: string | null;
  /** Why the session ended for this PC (`state` ended). */
  ended: string | null;
}

export interface WatchHostOptions {
  relay(): { baseUrl: string; deviceId: string; deviceToken: string } | null;
  me(): { id: string; name: string };
  appVersion: string;
  log: { info(line: string): void; warn(line: string): void };
  /** Where the fork's stream logs go (companion.log's folder). */
  logsDir: string;
  /** The VPX exe Castcade knows (the witness's, else the remembered one). */
  vpxExe(): string | null;
  exists(path: string): Promise<boolean>;
  /** A file's size in bytes, or null when it is not there. */
  size(path: string): Promise<number | null>;
  launcher: VpxLauncher;
  /**
   * The witness's registry of the watchers Castcade starts (`witness/hidden-vpx.ts`): told BEFORE the spawn, bound to
   * the pid after it, ended at the exit, so the witness never takes a watcher for a game. A player is not told: it is
   * an ordinary game. Absent (tests that do not look at it): nothing is told.
   */
  expectVpx?(e: ExpectedVpx): VpxExpectation;
  /** The tables Castcade knows on this PC: imported ones, then the tables folder's files. */
  tables(): Promise<KnownTable[]>;
  iceServers(): IceServer[];
  tunnel(o: TunnelEndOptions): TunnelEnd;
  freePort(): Promise<number>;
  /** Why a match keeps this PC out of a session (it hosts, plays in or is joining one); null: no match. */
  matchBusy(): string | null;
  /** Where the tunnel's page file goes (userData). */
  pageDir: string;
  /** Test seams for the session (timeouts, the relay's). */
  session?: Partial<Pick<WatchSessionOptions, 'welcomeTimeoutMs' | 'playTimeoutMs' | 'awayGraceMs' | 'relayOptions' | 'max'>>;
  /** Status pushes are at most this often (ms). Default 250. */
  emitGapMs?: number;
}

export interface WatchHost {
  status(): WatchStatus;
  onStatus(cb: (s: WatchStatus) => void): () => void;
  /** True while a session is on (or being set up): the match side refuses then. */
  active(): boolean;
  host(): Promise<WatchStatus>;
  join(code: string): Promise<WatchStatus>;
  leave(): Promise<WatchStatus>;
  /** Play `tablePath` (a `.vpx` on this PC) in the fork, as the session's player. */
  play(tablePath: string): Promise<WatchStatus>;
  /** Watch the player's table in the fork: `tablePath` null uses the one found here (`status().watchTable`). */
  watch(tablePath: string | null): Promise<WatchStatus>;
  stop(): Promise<void>;
}

/** The card's words for one member's path. */
export function pathWords(path: WatchMemberView['path']): string {
  switch (path) {
    case 'self':
      return 'this PC';
    case 'away':
      return 'reconnecting to ArcAid…';
    case 'connecting':
      return 'connecting…';
    case 'direct':
      return 'connected directly';
    case 'relay':
      return 'connected through your TURN relay';
    case 'no_path':
      return 'no direct path between your routers';
  }
}

/** The player's table on this PC: the same file name (any case); the same size first. */
export async function findWatchTable(want: WatchTableInfo, tables: readonly KnownTable[], size: (p: string) => Promise<number | null>): Promise<{ path: string; size: number } | null> {
  const name = want.name.toLowerCase();
  const seen = new Set<string>();
  let fallback: { path: string; size: number } | null = null;
  for (const t of tables) {
    const key = t.vpxPath.toLowerCase();
    if (seen.has(key) || win32.basename(t.vpxPath).toLowerCase() !== name) continue;
    seen.add(key);
    const s = await size(t.vpxPath);
    if (s === null) continue;
    if (s === want.size) return { path: t.vpxPath, size: s };
    fallback ??= { path: t.vpxPath, size: s };
  }
  return fallback;
}

/** The line under Watch for the table found (or not). */
export function watchTableLine(want: WatchTableInfo, found: { path: string; size: number } | null): { line: string; warn: boolean } {
  if (!found) return { line: `${want.name} is not in your tables: pick your copy of the file to watch.`, warn: true };
  if (found.size !== want.size)
    return {
      line: `Your ${want.name} is not the same size as the player's (${found.size.toLocaleString('en-US')} bytes here, ${want.size.toLocaleString('en-US')} there). If it is another version, VPX says "not the same table" when you watch.`,
      warn: true,
    };
  return { line: `Your copy of ${want.name} matches the player's in size.`, warn: false };
}

const describe = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const PLAY_LOG = 'vpx-stream-play.log';
const WATCH_LOG = 'vpx-stream-watch.log';

export function createWatchHost(o: WatchHostOptions): WatchHost {
  let session: WatchSession | null = null;
  let tunnel: TunnelEnd | null = null;
  let connecting = false;
  let error: string | null = null;
  let ended: string | null = null;
  let lastState: WatchSessionState | null = null;
  let local: WatchStatus['local'] = { vpx: 'none', table: null, pid: null };
  /** The run of the local VPX the exit handler belongs to (a later run is not ended by an earlier one's exit). */
  let run = 0;
  let watchTable: WatchStatus['watchTable'] = null;
  /** The player and table `watchTable` was looked for. */
  let lookedFor: string | null = null;
  let fork: WatchStatus['fork'] = { present: false, path: null, line: null };
  const listeners = new Set<(s: WatchStatus) => void>();
  let emitTimer: ReturnType<typeof setTimeout> | null = null;
  let lastEmit = 0;
  const gap = o.emitGapMs ?? 250;

  const nameOf = (st: WatchSessionState, id: string): string => st.members.find((m) => m.id === id)?.name ?? id;

  const status = (): WatchStatus => {
    const st = session?.state() ?? lastState;
    const tun = tunnel?.status() ?? null;
    const members: WatchMemberView[] = (st?.members ?? []).map((m) => {
      const me = m.id === st?.me;
      const path: WatchMemberView['path'] = me ? 'self' : m.away ? 'away' : (tun?.peers[m.id]?.path ?? 'connecting');
      return { id: m.id, name: m.name, me, host: m.id === st?.hostId, path, line: pathWords(path) };
    });
    const p = st?.player ?? null;
    return {
      state: connecting ? 'connecting' : session ? 'on' : ended ? 'ended' : 'off',
      role: session?.role ?? (connecting ? null : (lastState?.role ?? null)),
      code: st?.code ?? null,
      members: session || ended ? members : [],
      player: p && st ? { id: p.id, name: nameOf(st, p.id), me: p.id === st.me, table: p.table.name, size: p.table.size } : null,
      local: { ...local },
      watchTable,
      fork: { ...fork },
      relayLine: st?.relay === 'reconnecting' ? 'Reconnecting to ArcAid… (the table stream does not go through ArcAid and keeps going)' : st?.relay === 'closed' && session ? 'ArcAid closed the session room: nobody new can join; who is in stays connected.' : null,
      error,
      ended,
    };
  };

  const emitNow = (): void => {
    lastEmit = Date.now();
    const s = status();
    for (const cb of [...listeners]) cb(s);
  };
  const emit = (): void => {
    if (emitTimer) return;
    const wait = Math.max(0, gap - (Date.now() - lastEmit));
    emitTimer = setTimeout(() => {
      emitTimer = null;
      emitNow();
    }, wait);
  };

  const checkFork = async (): Promise<WatchStatus['fork']> => {
    const exe = o.vpxExe();
    const path = forkExeFor(exe);
    if (!path) fork = { present: false, path: null, line: 'Castcade does not know where VPX is yet: open any table in VPX once, then come back.' };
    else if (await o.exists(path)) fork = { present: true, path, line: null };
    else fork = { present: false, path, line: `The Castcade VPX build (VPinballX_GL64_castcade.exe) is not beside your VPX: copy it into ${win32.dirname(path)}, next to VPinballX_GL64.exe.` };
    return fork;
  };

  /** The player's table looked for here, once per player and table; Watch waits for a look under way. */
  let lookup: Promise<void> = Promise.resolve();
  const lookForTable = (): Promise<void> => {
    const st = session?.state();
    const p = st?.player ?? null;
    if (!st || !p || p.id === st.me) {
      watchTable = null;
      lookedFor = null;
      return Promise.resolve();
    }
    const key = `${p.id}\u0000${p.table.name}\u0000${p.table.size}`;
    if (key === lookedFor) return lookup;
    lookedFor = key;
    watchTable = null;
    lookup = (async () => {
      const found = await findWatchTable(p.table, await o.tables().catch(() => []), o.size).catch(() => null);
      if (lookedFor !== key) return;
      watchTable = { path: found?.path ?? null, ...watchTableLine(p.table, found) };
      emit();
    })();
    return lookup;
  };

  const onSession = (st: WatchSessionState): void => {
    lastState = st;
    tunnel?.setPeers(session?.peers() ?? []);
    // A watcher here follows the player: re-aimed at a new player of the same table (the fork connects again).
    const p = st.player;
    if (local.vpx === 'watching' && tunnel && p && p.id !== st.me && p.table.name.toLowerCase() === (local.table ?? '').toLowerCase()) void tunnel.watch(p.id).catch(() => undefined);
    void lookForTable();
    emit();
  };

  const teardown = async (why: string | null): Promise<void> => {
    const s = session;
    const t = tunnel;
    session = null;
    tunnel = null;
    watchTable = null;
    lookedFor = null;
    if (why) ended = why;
    await t?.close().catch(() => undefined);
    if (s && !s.state().ended) await s.leave().catch(() => undefined);
    if (local.vpx !== 'none') o.log.info(`watch: the session is over; the ${local.vpx === 'playing' ? 'playing' : 'watching'} VPX (pid ${local.pid ?? '?'}) is left open`);
  };

  const start = async (make: (opts: WatchSessionOptions) => Promise<WatchSession>): Promise<WatchStatus> => {
    if (session || connecting) throw new Error('Leave this 3D watch session first.');
    const busy = o.matchBusy();
    if (busy) throw new Error(`${busy}: leave it first (a PC is in one ArcAid room at a time).`);
    const relay = o.relay();
    if (!relay) throw new Error('3D watch goes through ArcAid: pair this PC with ArcAid first (Settings).');
    connecting = true;
    error = null;
    ended = null;
    lastState = null;
    emitNow();
    const me = o.me();
    try {
      await checkFork();
      const s = await make({ relay, me, appVersion: o.appVersion, log: (l) => o.log.info(l), ...o.session });
      session = s;
      tunnel = o.tunnel({
        dir: o.pageDir,
        localId: me.id,
        iceServers: o.iceServers(),
        sendSignal: (to, sig) => session?.sendSignal(to, sig),
        log: (l) => o.log.info(l),
        onChange: emit,
      });
      s.onSignal((from, sig) => tunnel?.signal(from, sig));
      s.onChange(onSession);
      s.onEnded((why) => {
        if (session !== s) return;
        o.log.info(`watch: ${why}`);
        void teardown(why).then(emitNow);
      });
      tunnel.setPeers(s.peers());
      onSession(s.state());
      connecting = false;
      return status();
    } catch (e) {
      error = describe(e);
      o.log.warn(`watch: ${error}`);
      throw e instanceof Error ? e : new Error(error);
    } finally {
      connecting = false;
      emitNow();
    }
  };

  const localVpx = async (role: 'playing' | 'watching', tablePath: string, port: number): Promise<void> => {
    const f = await checkFork();
    if (!f.present || !f.path) throw new Error(f.line ?? 'The Castcade VPX build is missing.');
    const mine = ++run;
    const logFile = win32.join(o.logsDir, role === 'playing' ? PLAY_LOG : WATCH_LOG);
    // A watcher is not a game: the witness is told before the spawn, so no poll of its can see the process first.
    const expected = role === 'watching' ? (o.expectVpx?.({ exe: f.path, tablePath }) ?? null) : null;
    const r = await o.launcher.launch(tablePath, {
      exe: f.path,
      env: forkStreamEnv(role === 'playing' ? 'play' : 'watch', port, logFile),
      what: role === 'playing' ? 'as the 3D watch player' : 'as a 3D watch watcher',
      onExit: (code) => {
        expected?.done();
        if (run !== mine) return;
        o.log.info(`watch: the ${role === 'playing' ? 'playing' : 'watching'} VPX closed (exit ${code ?? 'unknown'})`);
        local = { vpx: 'none', table: null, pid: null };
        if (role === 'playing') {
          tunnel?.setPlayerPort(null);
          session?.stopPlaying();
        } else tunnel?.stopWatching();
        emit();
      },
    });
    if (!r.ok) {
      expected?.done();
      throw new Error(`VPX did not start: ${r.reason}`);
    }
    expected?.bind(r.pid);
    local = { vpx: role, table: win32.basename(tablePath), pid: r.pid };
  };

  return {
    status,
    onStatus(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    active: () => session !== null || connecting,

    host: () => start((opts) => WatchSession.host(opts)),
    join: (code) => start((opts) => WatchSession.join(opts, code)),

    async leave() {
      error = null;
      await teardown(null);
      ended = null;
      lastState = null;
      emitNow();
      return status();
    },

    async play(tablePath) {
      const s = session;
      if (!s || !tunnel) throw new Error('Host or join a 3D watch session first.');
      if (local.vpx !== 'none') throw new Error(local.vpx === 'watching' ? 'Close the table you are watching first: a VPX plays or watches, not both.' : 'This PC is already playing a table.');
      error = null;
      const size = await o.size(tablePath);
      if (size === null || !/\.vpx$/i.test(tablePath)) throw new Error('That table file is not there.');
      const table = { name: win32.basename(tablePath), size };
      try {
        await s.play(table);
        const port = await o.freePort();
        tunnel.setPlayerPort(port);
        await localVpx('playing', tablePath, port);
        emitNow();
        return status();
      } catch (e) {
        error = describe(e);
        o.log.warn(`watch: could not play ${table.name}: ${error}`);
        if (local.vpx === 'none') {
          tunnel?.setPlayerPort(null);
          s.stopPlaying();
        }
        emitNow();
        throw e instanceof Error ? e : new Error(error);
      }
    },

    async watch(tablePath) {
      const s = session;
      const st = s?.state();
      if (!s || !st || !tunnel) throw new Error('Host or join a 3D watch session first.');
      const p = st.player;
      if (!p) throw new Error('Nobody is playing a table yet.');
      if (p.id === st.me) throw new Error('This PC is the one playing.');
      if (local.vpx !== 'none') throw new Error(local.vpx === 'playing' ? 'Close the table you are playing first: a VPX plays or watches, not both.' : 'This PC is already watching.');
      error = null;
      if (tablePath === null) await lookForTable();
      const path = tablePath ?? watchTable?.path ?? null;
      try {
        if (!path) throw new Error(`${p.table.name} is not in your tables: pick your copy of the file.`);
        if ((await o.size(path)) === null) throw new Error('That table file is not there.');
        const port = await tunnel.watch(p.id);
        await localVpx('watching', path, port);
        emitNow();
        return status();
      } catch (e) {
        error = describe(e);
        o.log.warn(`watch: could not watch: ${error}`);
        if (local.vpx === 'none') tunnel?.stopWatching();
        emitNow();
        throw e instanceof Error ? e : new Error(error);
      }
    },

    async stop() {
      if (emitTimer) clearTimeout(emitTimer);
      emitTimer = null;
      await teardown(null);
    },
  };
}
