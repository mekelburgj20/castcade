/**
 * I11.4.2 (2026-11-19, ADR 0011, docs/design/state-stream-in-match.md §4): the state stream inside a match, in the
 * shell. One per app run. It owns
 *
 * - the loopback control server the VPX fork connects to (`CASTCADE_STREAM_CONTROL=connect:127.0.0.1:<port>`, §3):
 *   lines in, lines out, one fork at a time. A connection counts for nothing until it has said a `hello` this Castcade
 *   reads: the fork that is on the control connection keeps it until then, and then the newcomer wins (it is the VPX
 *   that started last). The fork it replaced retries every 2 s; it is known by the stream port its `hello` names and
 *   is turned away while the newer one lives, so two tables left open do not take the connection from each other for
 *   ever. The server is opened the first time it is needed and kept for the run: Castcade does not own the VPX it
 *   starts, so a table left open after a match is still on the control connection for the next one. The control port
 *   is kept in a small file, so a Castcade that restarts under an open table (an update, A15's rejoin) listens on the
 *   same port again and the fork comes back, saying its own stream port in its `hello`;
 * - the machine (`match/stream3d.ts`), which decides: who this PC watches in 3D, what the fork is told, when it falls
 *   back to the 2D video;
 * - per match (`open`): one tunnel end (`watch/tunnel-end.ts`, as the 3D watch session uses it; the page, the bridge
 *   and the loopback sockets are unchanged), signalled over the match's MEDIA_SIGNAL channel `stream` instead of a
 *   watch session, and the capability exchange over the tunnel's own INFO frame (tunnel version 2). The tunnel (a
 *   hidden page, a peer connection per other player and their signalling) is opened only on a PC that can use it:
 *   `watch3d` is `auto`, or a fork is on the control connection (the others may watch it). On a PC with the setting
 *   off and no fork it opens when either changes, and tells the others to start their side over (`reset`);
 * - the launch (`launch`, §4.4): a match table starts in the fork with role `match` when the fork is beside the VPX
 *   exe Castcade knows and the setting is `auto`; otherwise the caller starts it exactly as before. A fork that
 *   reports a start error, or ends within `FORK_START_MS` without its VPX ever saying `hello`, did not start
 *   (`ForkLaunch.didNotStart`): the caller then starts the table in the player's own VPX.
 *
 * Every socket here is on 127.0.0.1 (no firewall prompt). Nothing here imports Electron: the tunnel factory, the file
 * check and the port picker are handed in, and the control listener can be replaced, so the tests run the real
 * listener against a scripted fork on loopback and a tunnel of their own.
 *
 * The match host hears of a change (`onChange`) only when what it reads changed (the view, the fork being away, the
 * wait of the first start): the tunnel's own reports (a round-trip time every 2 s per peer) never reach it. Of those
 * reports the machine is told two things, when they change: that the tunnel's page is broken for good, and the players
 * it found no path to (I11.4.9: the match's first start does not wait for a connection that is not coming).
 *
 * The witness is not told anything: a match table in the fork is an ordinary game, scored as any (only its exe is
 * never remembered: `isForkExe`).
 */
import { createServer, type Socket } from 'node:net';
import { win32 } from 'node:path';
import { forkExeFor, forkMatchEnv, type ForkLaunch } from '../launch/vpx-launch.js';
import { CONTROL_VERSION, QUIET_LOG_MS, Stream3d, parseControlLine, viewWords, type StartWait, type Stream3dStatus, type Watch3dSetting, type Why2d } from '../match/stream3d.js';
import type { MediaSignal } from '../media/match-media-types.js';
import type { IceServer } from '../media/media-settings.js';
import type { TunnelEnd, TunnelEndOptions } from '../watch/tunnel-end.js';
import { signalFrom } from '../watch/watch-session.js';

const LOOPBACK = '127.0.0.1';
/** Bytes of a control line before its newline; more closes the connection (the fork connects again). */
export const CONTROL_BYTES_MAX = 2048;
/** A connection to the control port that has not said `hello` after this long is closed. */
export const HELLO_WAIT_MS = 10_000;
/** Connections that have not said `hello` yet, at most; one more closes the oldest. */
export const PENDING_MAX = 4;
/** A fork that ends this soon after its start, with no `hello` from its VPX, did not start. */
export const FORK_START_MS = 5_000;
export const MATCH_LOG = 'vpx-stream-match.log';
/** I11.4.12: a fork whose control connection dropped is given this long to be back (it retries every 2 s) before anything is said of it. */
export const FORK_RECONNECT_GRACE_MS = 5_000;
const PAGE_FILE = 'stream3d-tunnel.html';
const PARTITION = 'castcade-stream3d';

// ------------------------------------------------------------------------- the control server --

export interface ControlConnection {
  /** One line (no newline in it); false when the connection is gone. */
  send(line: string): boolean;
  close(): void;
}

export interface ControlHandlers {
  open(c: ControlConnection): void;
  line(c: ControlConnection, text: string): void;
  close(c: ControlConnection, why: string): void;
}

export interface ControlListener {
  readonly port: number;
  close(): Promise<void>;
}

/** Listen for the fork on 127.0.0.1: `port` when it is free, else (and for 0 / null) a port the OS picks. */
export type ControlListen = (h: ControlHandlers, port: number | null) => Promise<ControlListener>;

function serve(h: ControlHandlers, port: number): Promise<ControlListener> {
  const sockets = new Set<Socket>();
  const server = createServer({ noDelay: true }, (sock) => {
    sockets.add(sock);
    let held: Buffer = Buffer.alloc(0);
    let open = true;
    const conn: ControlConnection = {
      send(line) {
        if (!open || sock.destroyed || /[\r\n]/.test(line)) return false;
        sock.write(`${line}\n`);
        return true;
      },
      close() {
        end('closed by Castcade');
      },
    };
    const end = (why: string): void => {
      if (!open) return;
      open = false;
      sockets.delete(sock);
      sock.destroy();
      h.close(conn, why);
    };
    sock.on('data', (d: Buffer) => {
      if (!open) return;
      held = held.length === 0 ? d : Buffer.concat([held, d]);
      for (let nl = held.indexOf(0x0a); nl >= 0 && open; nl = held.indexOf(0x0a)) {
        const text = held.subarray(0, nl).toString('utf8');
        held = held.subarray(nl + 1);
        h.line(conn, text);
      }
      if (open && held.length > CONTROL_BYTES_MAX) end(`a line over ${CONTROL_BYTES_MAX} bytes`);
    });
    sock.on('error', (e) => end(`socket error ${(e as NodeJS.ErrnoException).code ?? 'unknown'}`));
    sock.on('close', () => end('VPX closed it'));
    h.open(conn);
  });
  return new Promise<ControlListener>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: LOOPBACK, port }, () => {
      server.off('error', reject);
      // A listener error after it is up must not reach the process.
      server.on('error', () => undefined);
      const a = server.address();
      const got = typeof a === 'object' && a ? a.port : 0;
      resolve({
        port: got,
        close: () =>
          new Promise<void>((done) => {
            for (const s of [...sockets]) s.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

export const listenControl: ControlListen = async (h, port) => {
  if (port !== null && port > 0) {
    try {
      return await serve(h, port);
    } catch {
      // In use, or not allowed: any free port will do (a fork started for the old one is not coming back then).
    }
  }
  return serve(h, 0);
};

// ----------------------------------------------------------------------------------- the host --

/** What the Match tab shows of the state stream while a match is on. */
export interface Stream3dView {
  setting: Watch3dSetting;
  /** This PC's VPX on the control connection (`match/stream3d.ts` `Stream3dStatus.fork`), and its build. */
  fork: Stream3dStatus['fork'];
  build: string | null;
  /** The player shown in 3D now (the fork is aimed at them), or null. */
  watching: string | null;
  /** I11.4.12: a match table was started in the Castcade VPX build and its VPX has not connected yet (it may still be loading). */
  expecting: boolean;
  /** I11.4.12: the Castcade VPX build is beside the VPX exe Castcade knows; null while that is not known yet. */
  forkInstalled: boolean | null;
  /** I11.4.13: the build that was started for a match table this run never connected (one from before the 3D watch in a match). */
  forkSilent: boolean;
  /** I11.4.12: Castcade tried the Castcade VPX build for this match's table and it did not start (it ended at once, the launch failed, no loopback port). */
  forkFailed: boolean;
  /** I11.4.12: the VPX that was on the control connection left it less than `FORK_RECONNECT_GRACE_MS` ago (it reconnects every 2 s by itself). */
  reconnecting: boolean;
  /** One line per other player: what this PC shows of them while they are up, and why when it is the 2D video. */
  players: Array<{ id: string; name: string; mode: '3d' | '2d'; why: Why2d | null; line: string }>;
}

export interface MatchStream3d {
  /** A MEDIA_SIGNAL `channel: 'stream'` from `from`, for its data connection. */
  signal(from: string, s: MediaSignal): void;
  /** The other players of the match, with their names for the lines and the log. */
  setPeers(peers: ReadonlyArray<{ id: string; name: string }>): void;
  /**
   * §4.3: the player up, while this PC waits with its table locked; else null. `turn` names the grant they play
   * under: a new grant to the same player is a new turn, and a watch that failed in the last one is tried again.
   */
  setTarget(peer: string | null, turn?: string | null): void;
  setSetting(s: Watch3dSetting): void;
  /** The headset shows no theater picture: this PC's VPX is aimed at the player up. */
  showing3d(): boolean;
  /** The fork is away from its own table: the turn lock waits for it. */
  away(): boolean;
  /** §4.3: `cb` once the fork says `state playing`, at once when it is not away, after 2 s whatever it says (`late`). */
  whenPlaying(cb: (late: boolean) => void): () => void;
  /** I11.4.9: the match has not started yet (the lobby before game 1): only then is the first start made to wait. */
  setStartGate(on: boolean): void;
  /** I11.4.9: whether a table is open on this PC (the witness's reading). */
  setTableOpen(open: boolean): void;
  /** I11.4.9: whether the match's first start should wait for this PC's 3D connection, and until when at most. */
  startWait(): StartWait;
  status(): Stream3dView;
  /** What `status()`, `showing3d()`, `away()` or `startWait()` answer changed. */
  onChange(cb: () => void): () => void;
  close(): Promise<void>;
}

export interface Stream3dHostOptions {
  log: { info(line: string): void; warn(line: string): void };
  /** Where the fork's stream log goes (companion.log's folder). */
  logsDir: string;
  /** Where the tunnel's page file goes (userData). */
  pageDir: string;
  /** The VPX exe Castcade knows (the witness's, else the remembered one). */
  vpxExe(): string | null;
  exists(path: string): Promise<boolean>;
  iceServers(): IceServer[];
  tunnel(o: TunnelEndOptions): TunnelEnd;
  freePort(): Promise<number>;
  /** The control port of the last run, kept across a restart of Castcade. Absent: not kept. */
  ports?: { read(): string | null; write(text: string): void };
  /** Test seams. */
  listen?: ControlListen;
  watchTimeoutMs?: number;
  playWaitMs?: number;
  helloWaitMs?: number;
  forkStartMs?: number;
  /** I11.4.12: `FORK_RECONNECT_GRACE_MS` for the tests. */
  forkReconnectGraceMs?: number;
  /** I11.4.9: `START_WAIT_MS` and `FORK_HELLO_WAIT_MS` (match/stream3d.ts) for the tests and the harness. */
  startWaitMs?: number;
  forkHelloWaitMs?: number;
  /** The machine's clock (the tests'); default `Date.now`. */
  now?(): number;
}

export interface Stream3dHost {
  /**
   * §4.4: how a match table is started now: in the fork, with role `match` and the two loopback addresses, and the
   * word on whether that start took; or null (the setting is off, Castcade knows no VPX, the fork is not beside it):
   * the caller starts the table as it always did.
   */
  launch(setting: Watch3dSetting): Promise<ForkLaunch | null>;
  /** A match begins on this PC; its data connections are signalled by `sendSignal` (MEDIA_SIGNAL, channel `stream`). */
  open(o: { localId: string; setting: Watch3dSetting; sendSignal(to: string, s: MediaSignal): void }): MatchStream3d;
  /** The control port once the server is up (the tests' scripted fork connects to it). */
  controlPort(): Promise<number>;
  stop(): Promise<void>;
}

const describe = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The control port a ports file names (the file of an earlier build also named a stream port: not read any more). */
function savedControlPort(text: string | null): number | null {
  if (!text) return null;
  try {
    const n = (JSON.parse(text) as { controlPort?: unknown }).controlPort;
    return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
  } catch {
    return null;
  }
}

export function createStream3dHost(o: Stream3dHostOptions): Stream3dHost {
  const info = (line: string): void => o.log.info(line);
  /** The fork on the control connection (it said `hello`), and the stream port that `hello` named. */
  let conn: ControlConnection | null = null;
  let connPort: number | null = null;
  /** Connections that have not said `hello` yet, with the timer that closes a silent one. */
  const pending = new Map<ControlConnection, ReturnType<typeof setTimeout>>();
  /** The stream ports of the forks the one on the connection replaced: turned away while it lives. */
  const displaced = new Set<number>();
  let tunnel: TunnelEnd | null = null;
  let current: MatchStream3d | null = null;
  /** The current match's look at whether its tunnel should open now. */
  let check: (() => void) | null = null;
  let stopped = false;
  /** I11.4.12: whether the fork is beside the known VPX exe, as last looked (at a match's opening and at a launch). */
  let installed: boolean | null = null;
  /**
   * I11.4.13: the fork exe whose VPX did not connect within its limit this run (a build from before the 3D watch in a
   * match), and the exe started last. A start in that exe is not waited for again; its first `hello` forgets it.
   */
  let silentExe: string | null = null;
  let lastExe: string | null = null;
  /** I11.4.12: the fork was tried for the current match's table and did not start; when the fork last left the control connection. */
  let forkFailed = false;
  let lostAt: number | null = null;
  const names = new Map<string, string>();
  const listeners = new Set<() => void>();
  let queued = false;
  let told = '';
  /**
   * The match host is told once per turn of the loop, never from inside its own call, and only when what it reads
   * from here changed.
   */
  const notify = (): void => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      const now = current ? JSON.stringify([current.status(), current.away(), current.startWait()]) : '';
      if (now === told) return;
      told = now;
      for (const cb of [...listeners]) cb();
    });
  };

  /** A line a local process can cause at will: once, then counted. */
  const quiet = new Map<string, { at: number; n: number }>();
  const quietly = (key: string, line: string): void => {
    const now = Date.now();
    const q = quiet.get(key);
    if (q && now - q.at < QUIET_LOG_MS) {
      q.n += 1;
      return;
    }
    quiet.set(key, { at: now, n: 0 });
    info(`${line}${q && q.n > 0 ? ` (and ${q.n} more like it since the last line)` : ''}`);
  };

  const machine = new Stream3d({
    log: info,
    send: (line) => conn?.send(line) ?? false,
    aim: (peer) => (tunnel ? tunnel.watch(peer) : Promise.reject(new Error('no data connections are open on this PC'))),
    setPlayerPort: (port) => tunnel?.setPlayerPort(port),
    setCaps: (caps) => tunnel?.setInfo(caps),
    onChange: () => {
      if (lastExe !== null && silentExe !== lastExe && machine.forkSilent()) {
        silentExe = lastExe;
        info('stream3d: the Castcade VPX build that was started has not connected; for the rest of this run a match start does not wait for it (it counts again the moment it connects)');
      }
      check?.();
      notify();
    },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    name: (peer) => names.get(peer) ?? peer,
    ...(o.watchTimeoutMs !== undefined ? { watchTimeoutMs: o.watchTimeoutMs } : {}),
    ...(o.playWaitMs !== undefined ? { playWaitMs: o.playWaitMs } : {}),
    ...(o.startWaitMs !== undefined ? { startWaitMs: o.startWaitMs } : {}),
    ...(o.forkHelloWaitMs !== undefined ? { forkHelloWaitMs: o.forkHelloWaitMs } : {}),
    ...(o.now ? { now: o.now } : {}),
  });

  // ---- §4.4: did the fork Castcade just started come up? ----
  const starts = new Set<(failed: boolean) => void>();
  const watchStart = (): { didNotStart: Promise<boolean>; ended(): void } => {
    let done = false;
    let resolve: (failed: boolean) => void = () => undefined;
    const didNotStart = new Promise<boolean>((r) => (resolve = r));
    const settle = (failed: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      starts.delete(settle);
      resolve(failed);
    };
    // A VPX that is still there after this long started (its table may take a minute more to load).
    const timer = setTimeout(() => settle(false), o.forkStartMs ?? FORK_START_MS);
    (timer as { unref?: () => void }).unref?.();
    starts.add(settle);
    return { didNotStart, ended: () => settle(true) };
  };

  // ---- the control server: opened once, at the first need ----
  const dropPending = (c: ControlConnection): boolean => {
    const t = pending.get(c);
    if (t === undefined) return false;
    clearTimeout(t);
    pending.delete(c);
    return true;
  };
  const handlers: ControlHandlers = {
    open(c) {
      // Nothing yet: whoever is on the control connection stays until this one has said hello.
      if (pending.size >= PENDING_MAX) {
        const oldest = pending.keys().next().value as ControlConnection;
        dropPending(oldest);
        oldest.close();
      }
      const t = setTimeout(() => {
        if (!pending.delete(c)) return;
        quietly('silent', `stream3d: a connection to the control port said nothing for ${(o.helloWaitMs ?? HELLO_WAIT_MS) / 1000} s and was closed`);
        c.close();
      }, o.helloWaitMs ?? HELLO_WAIT_MS);
      (t as { unref?: () => void }).unref?.();
      pending.set(c, t);
    },
    line(c, text) {
      if (c === conn) return machine.forkLine(text);
      if (!dropPending(c)) return;
      const l = parseControlLine(text);
      if (!l || l.kind !== 'hello') {
        quietly('nohello', 'stream3d: a connection to the control port did not begin with hello and was closed');
        c.close();
        return;
      }
      if (conn) {
        // A fork is on the connection. One this Castcade cannot talk to does not take its place; nor does the fork
        // it replaced, which keeps trying.
        if (l.version !== CONTROL_VERSION) {
          quietly('version', `stream3d: a second VPX on the control port speaks version ${l.version} of it; the one that is connected stays`);
          c.close();
          return;
        }
        // The same VPX again (its hello names the stream port of the one that is connected): it reconnected, and its
        // new connection was read before the close of its old one. It takes over; nothing is turned away for it.
        const same = connPort !== null && l.streamPort === connPort;
        if (!same && l.streamPort > 0 && displaced.has(l.streamPort)) {
          quietly('displaced', `stream3d: the VPX that was replaced on the control port (stream port ${l.streamPort}) tried again; the newer one stays`);
          c.close();
          return;
        }
        info(same ? `stream3d: the VPX on the control port connected again (stream port ${l.streamPort}); its new connection takes over` : `stream3d: another VPX said hello on the control port (stream port ${l.streamPort}); it takes over from the one that was connected${connPort !== null ? ` (stream port ${connPort})` : ''}`);
        if (!same && connPort !== null) displaced.add(connPort);
        const old = conn;
        conn = c;
        old.close();
      }
      conn = c;
      connPort = l.version === CONTROL_VERSION && l.streamPort > 0 ? l.streamPort : null;
      // The VPX of a start that was being watched is up, and a build that was taken for silent is not.
      silentExe = null;
      for (const settle of [...starts]) settle(false);
      machine.forkConnected();
      machine.forkLine(text);
    },
    close(c, why) {
      if (dropPending(c) || c !== conn) return;
      conn = null;
      connPort = null;
      // I11.4.12: it reconnects by itself in a moment; what is said of a table without the fork waits that long.
      lostAt = Date.now();
      const t = setTimeout(() => notify(), (o.forkReconnectGraceMs ?? FORK_RECONNECT_GRACE_MS) + 50);
      (t as { unref?: () => void }).unref?.();
      // Whoever it replaced may come back now.
      displaced.clear();
      machine.forkDisconnected(why);
    },
  };
  let control: Promise<ControlListener> | null = null;
  const ensureControl = (): Promise<ControlListener> => {
    if (control) return control;
    const opening = (async (): Promise<ControlListener> => {
      let saved: number | null = null;
      try {
        saved = savedControlPort(o.ports?.read() ?? null);
      } catch (e) {
        o.log.warn(`stream3d: the saved control port could not be read (${describe(e)}); a new one is picked`);
      }
      const l = await (o.listen ?? listenControl)(handlers, saved);
      info(`stream3d: the control port for the Castcade VPX build is 127.0.0.1:${l.port}${saved !== null && l.port === saved ? ' (the same as in the last run: a table still open comes back)' : ''}`);
      return l;
    })();
    control = opening;
    opening.catch((e: unknown) => {
      o.log.warn(`stream3d: the control port could not be opened (${describe(e)}); no 3D in a match this run`);
    });
    return opening;
  };

  const closeMatch = async (m: MatchStream3d): Promise<void> => {
    if (current !== m) return;
    current = null;
    check = null;
    const t = tunnel;
    // The fork is called back before the tunnel goes (the `play` travels on the control connection, not the tunnel).
    machine.reset();
    tunnel = null;
    names.clear();
    listeners.clear();
    told = '';
    await t?.close().catch(() => undefined);
    info(`stream3d: the match is over on this PC${t ? '; its data connections are closed' : ''} (a table left open stays on the control port)`);
  };

  return {
    async launch(setting) {
      if (stopped) return null;
      if (setting !== 'auto') {
        info('stream3d: 3D watch is turned off on this PC: the match table starts in your own VPX (the 2D video)');
        return null;
      }
      const exe = forkExeFor(o.vpxExe());
      if (!exe) return null; // Castcade knows no VPX yet: the plain launch says so
      const there = await o.exists(exe).catch(() => false);
      if (installed !== there) {
        installed = there;
        notify();
      }
      if (!there) {
        info(`stream3d: the Castcade VPX build (${win32.basename(exe)}) is not in ${win32.dirname(exe)}: the match table starts in your own VPX (the 2D video)`);
        return null;
      }
      let controlPort: number;
      let streamPort: number;
      try {
        controlPort = (await ensureControl()).port;
        streamPort = await o.freePort();
      } catch (e) {
        o.log.warn(`stream3d: no loopback port for the Castcade VPX build (${describe(e)}): the match table starts in your own VPX (the 2D video)`);
        forkFailed = true;
        notify();
        return null;
      }
      try {
        o.ports?.write(`${JSON.stringify({ controlPort })}\n`);
      } catch (e) {
        o.log.warn(`stream3d: could not save the control port (${describe(e)}); a restart of Castcade under the open table loses 3D until the table is started again`);
      }
      // The stream port is only what the fork is asked to listen on: the port offered to the others is the one its
      // hello names (rule 9), so nothing is known of this table until its VPX says so.
      info(`stream3d: the match table starts in the Castcade VPX build (${exe}): asked to stream on 127.0.0.1:${streamPort}, control on 127.0.0.1:${controlPort}`);
      const start = watchStart();
      // I11.4.9: this VPX is expected on the control connection: until it is there (or is known not to come), the
      // match's first start waits for this PC. I11.4.13: not for a build that never connected this run.
      lastExe = exe;
      if (silentExe === exe) info('stream3d: this Castcade VPX build did not connect the last time it was started in this run (a build from before the 3D watch in a match): the start does not wait for it');
      else machine.forkLaunched();
      void start.didNotStart.then((failed) => {
        if (!failed) return;
        machine.forkGone();
        // I11.4.12: Castcade tried the fork for this table and it did not start: said as that, not as a table opened by hand.
        forkFailed = true;
        notify();
      });
      return {
        options: {
          exe,
          env: forkMatchEnv(streamPort, controlPort, win32.join(o.logsDir, MATCH_LOG)),
          what: 'for the match, in the Castcade VPX build',
          onExit: (code) => {
            info(`stream3d: the match table's VPX closed (exit ${code ?? 'unknown'})`);
            start.ended();
            machine.forkGone();
          },
        },
        didNotStart: start.didNotStart,
        notStarted: () => {
          start.ended();
          machine.forkGone();
        },
      };
    },

    open(m) {
      if (current) void closeMatch(current);
      names.clear();
      let setting = m.setting;
      let roster: string[] = [];
      /** This match's tunnel end, once this PC can use one. */
      let end: TunnelEnd | null = null;
      let broken = false;
      const mine = (): boolean => current === self;
      const openTunnel = (late: boolean): void => {
        if (end || broken || !mine()) return;
        let t: TunnelEnd | null = null;
        try {
          t = o.tunnel({
            dir: o.pageDir,
            pageFile: PAGE_FILE,
            partition: PARTITION,
            localId: m.localId,
            iceServers: o.iceServers(),
            // Never logged: SDP and candidates carry addresses.
            sendSignal: (to, s) => m.sendSignal(to, s),
            log: info,
            logTag: 'stream3d',
            onPeerInfo: (peer, text) => {
              if (tunnel === t) machine.peerCaps(peer, text);
            },
            // Of the tunnel's own reports only two things go on: its page is broken for good, and who it found no path to.
            onChange: () => {
              if (tunnel !== t || !t) return;
              const st = t.status();
              machine.setTunnel({ broken: st.pageError !== null, noPath: Object.entries(st.peers).filter(([, v]) => v.path === 'no_path').map(([id]) => id) });
            },
          });
          end = t;
          tunnel = t;
          info(`stream3d: the data connections to the other players open${late ? ' now (this PC can use them from here on)' : ' in the lobby'}`);
          // What this PC's VPX is goes out on the new connections; the time each PC takes to be heard from counts from here.
          machine.tunnelOpened();
          if (roster.length > 0) {
            // The others offered long ago, to nobody: each is told to start its side over, before anything of this
            // end's reaches it (the order `dropPeer` of tunnel-end.ts keeps).
            if (late) for (const id of roster) m.sendSignal(id, { kind: 'reset' });
            t.setPeers(roster);
          }
        } catch (e) {
          // No half-open end is left behind (its hidden page and its ipc listeners).
          broken = true;
          if (t) {
            end = null;
            if (tunnel === t) tunnel = null;
            void t.close().catch(() => undefined);
          }
          machine.setTunnel({ broken: true, noPath: [] });
          o.log.warn(`stream3d: the data connections could not be opened (${describe(e)}); the 2D video serves this match`);
        }
      };
      /** A PC with the setting off and no fork has no use for the tunnel: nobody watches from it, nobody can watch it. */
      const wanted = (): boolean => setting === 'auto' || machine.status().fork !== 'none';
      const self: MatchStream3d = {
        signal(from, s) {
          // The tunnel's page is the 3D watch page: it takes a plain signal, no channel. With no tunnel yet the
          // signal is let go: when one opens here, the others are told to start over.
          const clean = signalFrom(s);
          if (clean && mine() && end) end.signal(from, clean);
        },
        setPeers(peers) {
          if (!mine()) return;
          for (const p of peers) names.set(p.id, p.name);
          const ids = peers.map((p) => p.id);
          // Only a new roster goes on: the tunnel's end reports a change on every call, and the match host calls
          // this from its own change handler.
          if (ids.length === roster.length && ids.every((id, i) => id === roster[i])) return;
          roster = ids;
          end?.setPeers(ids);
          machine.setPeers(ids);
        },
        setTarget: (peer, turn = null) => void (mine() && machine.setTarget(peer, turn)),
        setSetting(s) {
          if (!mine()) return;
          setting = s;
          machine.setSetting(s);
          if (wanted()) openTunnel(true);
        },
        showing3d: () => mine() && machine.showing3d(),
        away: () => mine() && machine.away(),
        whenPlaying: (cb) => {
          if (!mine()) {
            cb(false);
            return () => undefined;
          }
          return machine.whenPlaying(cb);
        },
        setStartGate: (on) => void (mine() && machine.setStartGate(on)),
        setTableOpen: (open) => void (mine() && machine.setTableOpen(open)),
        startWait: () => (mine() ? machine.startWait() : { pending: false, until: null, why: null, waitingFor: [] }),
        status() {
          const st = machine.status();
          return {
            setting: st.setting,
            fork: st.fork,
            build: st.build,
            watching: st.showing3d ? st.target : null,
            expecting: machine.expectingFork(),
            forkInstalled: installed,
            forkSilent: silentExe !== null,
            forkFailed,
            reconnecting: lostAt !== null && st.fork === 'none' && Date.now() - lostAt < (o.forkReconnectGraceMs ?? FORK_RECONNECT_GRACE_MS),
            players: Object.entries(st.peers).map(([id, v]) => ({ id, name: names.get(id) ?? id, mode: v.mode, why: v.mode === '2d' ? v.why : null, line: `${names.get(id) ?? id}: ${viewWords(v)}` })),
          };
        },
        onChange(cb) {
          listeners.add(cb);
          return () => void listeners.delete(cb);
        },
        close: () => closeMatch(self),
      };
      current = self;
      told = '';
      forkFailed = false;
      // A fresh match: nothing known of anyone.
      machine.reset();
      machine.setSetting(setting);
      check = () => {
        if (wanted()) openTunnel(true);
      };
      void ensureControl().catch(() => undefined);
      // I11.4.12: is the Castcade VPX build beside the VPX exe at all (a table opened by hand is only worth a word then).
      const forkExe = forkExeFor(o.vpxExe());
      if (!forkExe) installed = false;
      else {
        void o.exists(forkExe).then(
          (v) => {
            if (installed === v) return;
            installed = v;
            notify();
          },
          () => undefined,
        );
      }
      info(`stream3d: on for this match (${setting === 'auto' ? '3D whenever both PCs can' : 'turned off on this PC: the 2D video'})`);
      if (wanted()) openTunnel(false);
      else info('stream3d: no data connections are opened on this PC: 3D watch is off and no Castcade VPX build is on the control port (they open if either changes)');
      return self;
    },

    controlPort: async () => (await ensureControl()).port,

    async stop() {
      stopped = true;
      if (current) await closeMatch(current);
      for (const c of [...pending.keys()]) {
        dropPending(c);
        c.close();
      }
      for (const settle of [...starts]) settle(false);
      const c = control;
      control = null;
      // The fork falls back to its own table when the control connection goes (§2 fail-safe).
      if (c) await c.then((l) => l.close()).catch(() => undefined);
    },
  };
}
