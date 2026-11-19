/**
 * I11.4.2 (2026-11-19, ADR 0011, docs/design/state-stream-in-match.md §4): the state stream inside a match, in the
 * shell. One per app run. It owns
 *
 * - the loopback control server the VPX fork connects to (`CASTCADE_STREAM_CONTROL=connect:127.0.0.1:<port>`, §3):
 *   lines in, lines out, one fork at a time (a newer connection replaces the older). The server is opened the first
 *   time it is needed and kept for the run: Castcade does not own the VPX it starts, so a table left open after a match
 *   is still on the control connection for the next one. The two ports of the last table started (control, stream) are
 *   kept in a small file, so a Castcade that restarts under an open table (an update, A15's rejoin) listens on the
 *   same control port again and the fork, which retries every 2 s, comes back;
 * - the machine (`match/stream3d.ts`), which decides: who this PC watches in 3D, what the fork is told, when it falls
 *   back to the 2D video;
 * - per match (`open`): one tunnel end (`watch/tunnel-end.ts`, as the 3D watch session uses it; the page, the bridge
 *   and the loopback sockets are unchanged), signalled over the match's MEDIA_SIGNAL channel `stream` instead of a
 *   watch session, and the capability exchange over the tunnel's own INFO frame (tunnel version 2);
 * - the launch (`launchOptions`, §4.4): a match table starts in the fork with role `match` when the fork is beside the
 *   VPX exe Castcade knows and the setting is `auto`; otherwise the caller starts it exactly as before.
 *
 * Every socket here is on 127.0.0.1 (no firewall prompt). Nothing here imports Electron: the tunnel factory, the file
 * check and the port picker are handed in, and the control listener can be replaced, so the tests run the real
 * listener against a scripted fork on loopback and a fake tunnel.
 *
 * The witness is not told anything: a match table in the fork is an ordinary game, scored as any (only its exe is
 * never remembered: `isForkExe`).
 */
import { createServer, type Socket } from 'node:net';
import { win32 } from 'node:path';
import { forkExeFor, forkMatchEnv, type LaunchOptions } from '../launch/vpx-launch.js';
import { Stream3d, viewWords, type Stream3dStatus, type Watch3dSetting } from '../match/stream3d.js';
import type { MediaSignal } from '../media/match-media-types.js';
import type { IceServer } from '../media/media-settings.js';
import type { TunnelEnd, TunnelEndOptions } from '../watch/tunnel-end.js';
import { signalFrom } from '../watch/watch-session.js';

const LOOPBACK = '127.0.0.1';
/** Bytes of a control line before its newline; more closes the connection (the fork connects again). */
export const CONTROL_BYTES_MAX = 2048;
export const MATCH_LOG = 'vpx-stream-match.log';
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
    sock.on('error', (e) => end(`socket error ${(e as NodeJS.ErrnoException).code ?? e.message}`));
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
  /** One line per other player: what this PC shows of them while they are up, and why when it is the 2D video. */
  players: Array<{ id: string; name: string; mode: '3d' | '2d'; line: string }>;
}

export interface MatchStream3d {
  /** A MEDIA_SIGNAL `channel: 'stream'` from `from`, for its data connection. */
  signal(from: string, s: MediaSignal): void;
  /** The other players of the match, with their names for the lines and the log. */
  setPeers(peers: ReadonlyArray<{ id: string; name: string }>): void;
  /** §4.3: the player up, while this PC waits with its table locked; else null. */
  setTarget(peer: string | null): void;
  setSetting(s: Watch3dSetting): void;
  /** The headset shows no theater picture: this PC's VPX is aimed at the player up. */
  showing3d(): boolean;
  /** The fork is away from its own table: the turn lock waits for it. */
  away(): boolean;
  /** §4.3: `cb` once the fork says `state playing`, at once when it is not away, after 2 s whatever it says (`late`). */
  whenPlaying(cb: (late: boolean) => void): () => void;
  status(): Stream3dView;
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
  /** The ports of the last table started, kept across a restart of Castcade. Absent: not kept. */
  ports?: { read(): string | null; write(text: string): void };
  /** Test seams. */
  listen?: ControlListen;
  watchTimeoutMs?: number;
  playWaitMs?: number;
}

export interface Stream3dHost {
  /**
   * §4.4: how a match table is started now: in the fork, with role `match` and the two loopback addresses; or null
   * (the setting is off, Castcade knows no VPX, the fork is not beside it): the caller starts it as it always did.
   */
  launchOptions(setting: Watch3dSetting): Promise<LaunchOptions | null>;
  /** A match begins on this PC: its tunnel end, signalled by `sendSignal` (MEDIA_SIGNAL, channel `stream`). */
  open(o: { localId: string; setting: Watch3dSetting; sendSignal(to: string, s: MediaSignal): void }): MatchStream3d;
  /** The control port once the server is up (the tests' scripted fork connects to it). */
  controlPort(): Promise<number>;
  stop(): Promise<void>;
}

const describe = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function savedPorts(text: string | null): { controlPort: number; streamPort: number } | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text) as { controlPort?: unknown; streamPort?: unknown };
    const ok = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 65535;
    return ok(v.controlPort) && ok(v.streamPort) ? { controlPort: v.controlPort, streamPort: v.streamPort } : null;
  } catch {
    return null;
  }
}

export function createStream3dHost(o: Stream3dHostOptions): Stream3dHost {
  const info = (line: string): void => o.log.info(line);
  let conn: ControlConnection | null = null;
  let tunnel: TunnelEnd | null = null;
  let current: MatchStream3d | null = null;
  let stopped = false;
  const names = new Map<string, string>();
  const listeners = new Set<() => void>();
  let queued = false;
  /** Status changes reach the match host once per turn of the loop, never from inside its own call. */
  const notify = (): void => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      for (const cb of [...listeners]) cb();
    });
  };

  const machine = new Stream3d({
    log: info,
    send: (line) => conn?.send(line) ?? false,
    aim: (peer) => (tunnel ? tunnel.watch(peer) : Promise.reject(new Error('no match is on'))),
    setPlayerPort: (port) => tunnel?.setPlayerPort(port),
    setCaps: (caps) => tunnel?.setInfo(caps),
    onChange: notify,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    name: (peer) => names.get(peer) ?? peer,
    ...(o.watchTimeoutMs !== undefined ? { watchTimeoutMs: o.watchTimeoutMs } : {}),
    ...(o.playWaitMs !== undefined ? { playWaitMs: o.playWaitMs } : {}),
  });

  // ---- the control server: opened once, at the first need ----
  let control: Promise<ControlListener> | null = null;
  const ensureControl = (): Promise<ControlListener> => {
    if (control) return control;
    const saved = savedPorts(o.ports?.read() ?? null);
    const handlers: ControlHandlers = {
      open(c) {
        const old = conn;
        conn = c;
        // One fork at a time: the newer connection is the VPX that is running now.
        if (old) {
          info('stream3d: another VPX connected to the control port; the earlier connection is closed');
          old.close();
        }
        machine.forkConnected();
      },
      line(c, text) {
        if (c === conn) machine.forkLine(text);
      },
      close(c, why) {
        if (c !== conn) return;
        conn = null;
        machine.forkDisconnected(why);
      },
    };
    control = (o.listen ?? listenControl)(handlers, saved?.controlPort ?? null).then((l) => {
      // The fork of the last run (if its table is still open) streams where it was told then.
      if (saved && l.port === saved.controlPort) machine.setStreamPort(saved.streamPort);
      info(`stream3d: the control port for the Castcade VPX build is 127.0.0.1:${l.port}${saved && l.port === saved.controlPort ? ' (the same as in the last run: a table still open comes back)' : ''}`);
      return l;
    });
    control.catch((e: unknown) => {
      o.log.warn(`stream3d: the control port could not be opened (${describe(e)}); no 3D in a match this run`);
    });
    return control;
  };

  const closeMatch = async (m: MatchStream3d): Promise<void> => {
    if (current !== m) return;
    current = null;
    const t = tunnel;
    // The fork is called back before the tunnel goes (the `play` travels on the control connection, not the tunnel).
    machine.reset();
    tunnel = null;
    names.clear();
    listeners.clear();
    await t?.close().catch(() => undefined);
    info('stream3d: the match is over on this PC; its data connections are closed (a table left open stays on the control port)');
  };

  return {
    async launchOptions(setting) {
      if (stopped) return null;
      if (setting !== 'auto') {
        info('stream3d: 3D watch is turned off on this PC: the match table starts in your own VPX (the 2D video)');
        return null;
      }
      const exe = forkExeFor(o.vpxExe());
      if (!exe) return null; // Castcade knows no VPX yet: the plain launch says so
      if (!(await o.exists(exe).catch(() => false))) {
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
        return null;
      }
      machine.setStreamPort(streamPort);
      try {
        o.ports?.write(`${JSON.stringify({ controlPort, streamPort })}\n`);
      } catch (e) {
        o.log.warn(`stream3d: could not save the ports of this table (${describe(e)}); a restart of Castcade under the open table loses 3D until the table is started again`);
      }
      info(`stream3d: the match table starts in the Castcade VPX build (${exe}): stream on 127.0.0.1:${streamPort}, control on 127.0.0.1:${controlPort}`);
      return {
        exe,
        env: forkMatchEnv(streamPort, controlPort, win32.join(o.logsDir, MATCH_LOG)),
        what: 'for the match, in the Castcade VPX build',
        onExit: (code) => info(`stream3d: the match table's VPX closed (exit ${code ?? 'unknown'})`),
      };
    },

    open(m) {
      if (current) void closeMatch(current);
      names.clear();
      const end = o.tunnel({
        dir: o.pageDir,
        pageFile: PAGE_FILE,
        partition: PARTITION,
        localId: m.localId,
        iceServers: o.iceServers(),
        // Never logged: SDP and candidates carry addresses.
        sendSignal: (to, s) => m.sendSignal(to, s),
        log: info,
        logTag: 'stream3d',
        onChange: notify,
        onPeerInfo: (peer, text) => {
          if (tunnel === end) machine.peerCaps(peer, text);
        },
      });
      tunnel = end;
      // A fresh match: nothing known of anyone, and this PC's VPX is said again on the new connections.
      machine.reset();
      machine.setSetting(m.setting);
      void ensureControl().catch(() => undefined);
      info(`stream3d: on for this match (${m.setting === 'auto' ? '3D whenever both PCs can' : 'turned off on this PC: the 2D video'}); data connections to the other players open in the lobby`);
      /** The roster the tunnel was last given. */
      let roster = '[]';
      const self: MatchStream3d = {
        signal(from, s) {
          // The tunnel's page is the 3D watch page: it takes a plain signal, no channel.
          const clean = signalFrom(s);
          if (clean && tunnel === end) end.signal(from, clean);
        },
        setPeers(peers) {
          if (tunnel !== end) return;
          for (const p of peers) names.set(p.id, p.name);
          const ids = peers.map((p) => p.id);
          // Only a new roster goes to the tunnel: its end reports a change on every call, and the match host calls
          // this from its own change handler.
          const key = JSON.stringify(ids);
          if (key === roster) return;
          roster = key;
          end.setPeers(ids);
          machine.setPeers(ids);
        },
        setTarget: (peer) => void (tunnel === end && machine.setTarget(peer)),
        setSetting: (s) => void (tunnel === end && machine.setSetting(s)),
        showing3d: () => tunnel === end && machine.showing3d(),
        away: () => tunnel === end && machine.away(),
        whenPlaying: (cb) => {
          if (tunnel !== end) {
            cb(false);
            return () => undefined;
          }
          return machine.whenPlaying(cb);
        },
        status() {
          const st = machine.status();
          return {
            setting: st.setting,
            fork: st.fork,
            build: st.build,
            watching: st.showing3d ? st.target : null,
            players: Object.entries(st.peers).map(([id, v]) => ({ id, name: names.get(id) ?? id, mode: v.mode, line: `${names.get(id) ?? id}: ${viewWords(v)}` })),
          };
        },
        onChange(cb) {
          listeners.add(cb);
          return () => void listeners.delete(cb);
        },
        close: () => closeMatch(self),
      };
      current = self;
      return self;
    },

    controlPort: async () => (await ensureControl()).port,

    async stop() {
      stopped = true;
      if (current) await closeMatch(current);
      const c = control;
      control = null;
      // The fork falls back to its own table when the control connection goes (§2 fail-safe).
      if (c) await c.then((l) => l.close()).catch(() => undefined);
    },
  };
}
