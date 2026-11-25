/**
 * I11.4.1 (2026-11-16): one PC's end of the 3D watch tunnel in the main process: the hidden page (`watch-page.ts`,
 * the data connections), the bridge (`tunnel.ts`) and the loopback sockets, wired together. `main/watch-host.ts` uses
 * one per session; the end-to-end harness (`companion/scripts/watch-tunnel-harness.mjs`) runs two in one process.
 *
 * Every socket this file opens is on 127.0.0.1: the listener a watcher's VPX connects to, and the connections to this
 * PC's player VPX. A listener on all interfaces raises a Windows Firewall prompt on the player's PC, which is the thing
 * this feature removes. Ports are picked free when they are needed (`freeLoopbackPort`, the OS's choice).
 *
 * The page runs in its own partition. Its permission CHECK answers yes for `media` (no request is ever granted, and the
 * page opens no device) so Chromium gathers this PC's own addresses as host candidates, as it does for the voice page,
 * which has the microphone: the data connections take the same paths as voice. Frames for one peer are batched per
 * microtask into one IPC message; each frame that arrives is handed to the bridge as it comes.
 */
import { BrowserWindow, ipcMain, session, type IpcMainEvent } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import type { MediaSignal } from '../media/match-media-types.js';
import type { IceServer } from '../media/media-settings.js';
import { pageLogLine } from '../media/panel-page.js';
import { TunnelBridge, type TunnelChannel, type TunnelStats } from './tunnel.js';
import { WATCH_CHANNELS as C, firstRestartMs, pathOf, watchPageHtml, type WatchPageConfig, type WatchPagePeer, type WatchPageStatus, type WatchPath } from './watch-page.js';
import { signalFrom } from './watch-session.js';

const LOOPBACK = '127.0.0.1';
const PAGE_RESTART_MS = 1_000;
const PAGE_RESTARTS_MAX = 5;
const HELD_MAX = 256;

/** A port the OS says is free on 127.0.0.1 now (bound, read, released). */
export function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen({ host: LOOPBACK, port: 0 }, () => {
      const a = s.address();
      const port = typeof a === 'object' && a ? a.port : 0;
      s.close(() => (port > 0 ? resolve(port) : reject(new Error('no port'))));
    });
  });
}

export interface TunnelEndOptions {
  /** Where the page file is written (userData; the harness's own folder). */
  dir: string;
  pageFile?: string;
  partition?: string;
  localId: string;
  iceServers: IceServer[];
  /** A signal for `to`'s data connection: into the session (or the harness's in-memory pair). */
  sendSignal(to: string, s: MediaSignal): void;
  log(line: string): void;
  /** Something the status shows changed (the page's report, a channel, a stream). */
  onChange?(): void;
  /**
   * I11.4.2: what `peer`'s end said last with `setInfo` (tunnel version 2), or null when the channel to it closed. The
   * 3D watch session passes none.
   */
  onPeerInfo?(peer: string, info: string | null): void;
  /** I11.4.2: the word every log line of this end starts with. Default `watch` (the 3D watch session); a match's is `stream3d`. */
  logTag?: string;
  /**
   * I11.4.2: the port of the loopback listener a watcher VPX connects to. Default: one the OS picks. A harness that
   * must stay inside a port range names it (companion/scripts/match-stream-harness.mjs); the app never does.
   */
  watchPort?: number;
}

export interface TunnelPeerView {
  path: WatchPath;
  ice: string;
  /** `srflx -> srflx udp` (types only), or null before a pair works. */
  pair: string | null;
  rttMs: number | null;
  restarts: number;
  channelOpen: boolean;
}

export interface TunnelEndStatus {
  peers: Record<string, TunnelPeerView>;
  /** The loopback listener a watcher VPX connects to, and whose table it streams. */
  watchPort: number | null;
  watchPeer: string | null;
  playerPort: number | null;
  stats: TunnelStats;
  pageError: string | null;
}

export interface TunnelEnd {
  /** The members to hold a data connection with (everyone else in the session). */
  setPeers(ids: readonly string[]): void;
  /** A signal from `from` for its data connection. */
  signal(from: string, s: MediaSignal): void;
  /** This PC's player VPX listens on `port` (127.0.0.1); null: nothing plays here. */
  setPlayerPort(port: number | null): void;
  /** The loopback listener whose connections stream to `peer`'s table (opened once, re-aimed after); its port. */
  watch(peer: string): Promise<number>;
  stopWatching(): void;
  status(): TunnelEndStatus;
  /**
   * I11.4.2: a short text every other end is told over the tunnel's own channel (INFO, tunnel version 2), now and
   * whenever a channel opens; it arrives at their `onPeerInfo`. Null: nothing is told on channels that open later.
   */
  setInfo(info: string | null): void;
  /** Test seam (the harness): drop the data connection to `peer` as if the network did; the mesh opens it again. */
  dropPeer(peer: string): void;
  close(): Promise<void>;
}

class PagePort implements TunnelChannel {
  busy = false;
  private queue: Uint8Array[] = [];
  private scheduled = false;
  constructor(
    private readonly peer: string,
    private readonly post: (peer: string, frames: Uint8Array[]) => void,
  ) {}
  send(frame: Uint8Array): void {
    this.queue.push(frame);
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      const frames = this.queue;
      this.queue = [];
      if (frames.length > 0) this.post(this.peer, frames);
    });
  }
}

export function createTunnelEnd(o: TunnelEndOptions): TunnelEnd {
  const partition = o.partition ?? 'castcade-watch';
  const pageFile = join(o.dir, o.pageFile ?? 'watch-tunnel.html');
  let win: BrowserWindow | null = null;
  let ready = false;
  let closed = false;
  let pageError: string | null = null;
  let restarts = 0;
  let page: WatchPageStatus = { peers: {} };
  const wanted = new Set<string>();
  const ports = new Map<string, PagePort>();
  let playerPort: number | null = null;
  let server: Server | null = null;
  let watchPort: number | null = null;
  let watchPeer: string | null = null;
  /** Signals that arrive before the page listens: kept (at most `HELD_MAX`, oldest dropped) and handed over at `ready`. */
  const held: Array<[string, MediaSignal]> = [];
  const changed = (): void => o.onChange?.();
  const tag = o.logTag ?? 'watch';
  // I11.12: an experiment for a two-router night (watch-page.ts `firstRestartMs`); nothing changes without the variable.
  const asked = process.env.CASTCADE_ICE_FIRST_RESTART_MS;
  const early = firstRestartMs(asked);
  // eslint-disable-next-line no-control-regex -- what is logged of a value from the environment has no control characters
  if (asked !== undefined && early === null) o.log(`${tag}: CASTCADE_ICE_FIRST_RESTART_MS is set to "${asked.replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, 24)}", which is not a whole number of ms from 500 to 9000: ignored, nothing changes`);
  if (early !== null) o.log(`${tag}: experiment (CASTCADE_ICE_FIRST_RESTART_MS): a data connection that is stuck gets one more ICE restart, after ${early} ms, before the usual six (3, 3, 6, 6, 12 and 12 s apart since I11.12)`);

  const bridge = new TunnelBridge({
    connect: (port) => {
      const s: Socket = connect({ host: LOOPBACK, port });
      return s;
    },
    log: (line) => o.log(`${tag}: ${line}`),
    onInfo: (peer, payload) => o.onPeerInfo?.(peer, payload ? Buffer.from(payload).toString('utf8') : null),
  });

  const post = (peer: string, frames: Uint8Array[]): void => {
    if (win && !win.isDestroyed() && ready) win.webContents.send(C.send, { peer, frames });
  };
  const fromPage = (e: IpcMainEvent): boolean => !!win && !win.isDestroyed() && e.sender === win.webContents;

  const handlers: Array<[string, (e: IpcMainEvent, m: unknown) => void]> = [
    [
      C.ready,
      (e) => {
        if (!fromPage(e)) return;
        ready = true;
        const cfg: WatchPageConfig = { localId: o.localId, ice: o.iceServers, reset: restarts > 0, peers: [...wanted], firstRestartMs: early };
        win?.webContents.send(C.config, cfg);
        for (const p of wanted) win?.webContents.send(C.addPeer, p);
        // Signals that came while the page loaded (a peer's first offer and its candidates), in order.
        for (const [from, signal] of held.splice(0)) win?.webContents.send(C.signalIn, { from, signal });
      },
    ],
    [
      C.signalOut,
      (e, m) => {
        const v = m as { to?: unknown; signal?: unknown } | null;
        const sig = signalFrom(v?.signal);
        if (!fromPage(e) || typeof v?.to !== 'string' || !sig) return;
        // Never logged: SDP and candidates carry addresses.
        o.sendSignal(v.to, sig);
      },
    ],
    [
      C.recv,
      (e, m) => {
        const v = m as { peer?: unknown; frame?: unknown } | null;
        if (!fromPage(e) || typeof v?.peer !== 'string' || !(v.frame instanceof Uint8Array)) return;
        bridge.receive(v.peer, v.frame);
      },
    ],
    [
      C.channel,
      (e, m) => {
        const v = m as { peer?: unknown; open?: unknown; why?: unknown } | null;
        if (!fromPage(e) || typeof v?.peer !== 'string') return;
        const peer = v.peer;
        if (v.open === true) {
          if (!wanted.has(peer)) return;
          const port = new PagePort(peer, post);
          ports.set(peer, port);
          bridge.channelUp(peer, port);
          o.log(`${tag}: data channel to ${peer} open`);
        } else {
          ports.delete(peer);
          bridge.channelDown(peer, typeof v.why === 'string' ? v.why.slice(0, 120) : 'it closed');
        }
        changed();
      },
    ],
    [
      C.flow,
      (e, m) => {
        const v = m as { peer?: unknown; busy?: unknown } | null;
        if (!fromPage(e) || typeof v?.peer !== 'string') return;
        const port = ports.get(v.peer);
        if (!port) return;
        port.busy = v.busy === true;
        if (port.busy) bridge.channelBusy(v.peer);
        else bridge.channelWritable(v.peer);
      },
    ],
    [
      C.status,
      (e, m) => {
        if (!fromPage(e)) return;
        const peers = (m as WatchPageStatus | null)?.peers;
        if (typeof peers !== 'object' || peers === null) return;
        const before = JSON.stringify(viewPeers(page));
        page = { peers };
        if (JSON.stringify(viewPeers(page)) !== before) changed();
      },
    ],
    [
      C.log,
      (e, line) => {
        if (!fromPage(e) || typeof line !== 'string') return;
        o.log(`${tag}: ${pageLogLine(line)}`);
      },
    ],
  ];
  for (const [ch, fn] of handlers) ipcMain.on(ch, fn);

  const openPage = (): void => {
    const ses = session.fromPartition(partition);
    ses.setPermissionCheckHandler((_wc, permission) => permission === 'media');
    ses.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
    mkdirSync(o.dir, { recursive: true });
    writeFileSync(pageFile, watchPageHtml());
    ready = false;
    const w = new BrowserWindow({
      show: false,
      width: 320,
      height: 120,
      // Local content only (a page written here); node for ipcRenderer, as the match panel page.
      webPreferences: { partition, nodeIntegration: true, contextIsolation: false, backgroundThrottling: false },
    });
    win = w;
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    w.webContents.on('will-navigate', (e) => e.preventDefault());
    w.webContents.on('render-process-gone', (_e, d) => {
      if (win !== w || closed) return;
      o.log(`${tag}: the 3D watch page stopped (${d.reason}); every stream closes`);
      dropAll('the page stopped');
      win = null;
      ready = false;
      if (restarts >= PAGE_RESTARTS_MAX) {
        pageError = `the 3D watch connection page stopped ${restarts + 1} times (${d.reason}): leave the session and host or join again`;
        changed();
        return;
      }
      restarts += 1;
      setTimeout(() => {
        if (!closed) openPage();
      }, PAGE_RESTART_MS);
      changed();
    });
    void w.loadFile(pageFile).catch((e: unknown) => {
      if (win !== w) return;
      pageError = `the 3D watch connection page did not load (${e instanceof Error ? e.message : String(e)})`;
      o.log(`${tag}: ${pageError}`);
      changed();
    });
  };

  const dropAll = (why: string): void => {
    for (const peer of [...ports.keys()]) bridge.channelDown(peer, why);
    ports.clear();
    page = { peers: {} };
  };

  function viewPeers(p: WatchPageStatus): Record<string, TunnelPeerView> {
    const out: Record<string, TunnelPeerView> = {};
    for (const id of wanted) {
      const s: WatchPagePeer | undefined = p.peers[id];
      out[id] = {
        path: pathOf(s),
        ice: s?.ice ?? 'new',
        pair: s?.pair ? `${s.pair.local} -> ${s.pair.remote} ${s.pair.protocol}` : null,
        rttMs: s?.pair?.rttMs ?? null,
        restarts: s?.restarts ?? 0,
        channelOpen: s?.channel === 'open',
      };
    }
    return out;
  }

  openPage();

  return {
    setPeers(ids) {
      const next = new Set(ids.filter((id) => id !== o.localId));
      for (const id of [...wanted]) {
        if (next.has(id)) continue;
        wanted.delete(id);
        if (win && ready) win.webContents.send(C.removePeer, id);
        ports.delete(id);
        bridge.channelDown(id, 'the member left');
      }
      for (const id of next) {
        if (wanted.has(id)) continue;
        wanted.add(id);
        if (win && ready) win.webContents.send(C.addPeer, id);
      }
      changed();
    },
    signal(from, s) {
      if (win && !win.isDestroyed() && ready) {
        win.webContents.send(C.signalIn, { from, signal: s });
        return;
      }
      held.push([from, s]);
      if (held.length > HELD_MAX) held.shift();
    },
    setPlayerPort(port) {
      playerPort = port;
      bridge.setPlayerPort(port);
      changed();
    },
    async watch(peer) {
      watchPeer = peer;
      if (server && watchPort !== null) return watchPort;
      const s = createServer({ noDelay: true }, (sock) => {
        // A socket error after the bridge let go of it must not reach the process.
        sock.on('error', () => undefined);
        if (!watchPeer || closed) return sock.destroy();
        bridge.attachWatcher(sock, watchPeer);
        changed();
      });
      await new Promise<void>((resolve, reject) => {
        s.once('error', reject);
        s.listen({ host: LOOPBACK, port: o.watchPort ?? 0 }, () => {
          s.off('error', reject);
          resolve();
        });
      });
      s.on('error', (e) => o.log(`${tag}: the watcher listener failed (${e.message})`));
      const a = s.address();
      server = s;
      watchPort = typeof a === 'object' && a ? a.port : null;
      o.log(`${tag}: a watcher VPX on this PC connects to 127.0.0.1:${watchPort ?? '?'}`);
      changed();
      if (watchPort === null) throw new Error('the watcher listener has no port');
      return watchPort;
    },
    stopWatching() {
      watchPeer = null;
      const s = server;
      server = null;
      watchPort = null;
      s?.close();
      changed();
    },
    status() {
      return { peers: viewPeers(page), watchPort, watchPeer, playerPort, stats: bridge.stats(), pageError };
    },
    setInfo(info) {
      bridge.setInfo(info === null ? null : Buffer.from(info, 'utf8'));
    },
    dropPeer(peer) {
      if (!win || !ready || !wanted.has(peer)) return;
      // As a rebuilt page does (D2.7): the peer is told to open its side again, this side closes and opens its own.
      o.log(`${tag}: dropping the data connection to ${peer} on purpose (test)`);
      o.sendSignal(peer, { kind: 'reset' });
      win.webContents.send(C.removePeer, peer);
      setTimeout(() => {
        if (win && ready && wanted.has(peer)) win.webContents.send(C.addPeer, peer);
      }, 50);
    },
    async close() {
      closed = true;
      for (const [ch, fn] of handlers) ipcMain.removeListener(ch, fn);
      bridge.close();
      ports.clear();
      const s = server;
      server = null;
      watchPort = null;
      if (s) await new Promise<void>((r) => s.close(() => r()));
      const w = win;
      win = null;
      if (w && !w.isDestroyed()) w.destroy();
    },
  };
}
