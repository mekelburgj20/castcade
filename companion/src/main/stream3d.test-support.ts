/**
 * I11.4.2: what the state-stream tests share: a scripted control client standing in for the VPX fork (a real socket on
 * loopback, speaking the lines of docs/design/state-stream-in-match.md §3), and fake tunnel ends joined by a hub that
 * behaves as the real ones do towards their owner: a "data channel" between two ends opens once an offer and an answer
 * crossed through the owner's signalling, what each end says with `setInfo` reaches the other's `onPeerInfo` over an
 * open channel, and a closed end says null to everyone it was connected to.
 *
 * `BridgeTunnel` is the other kind of end: the real `TunnelBridge` and real loopback sockets, as `tunnel-end.ts` wires
 * them, with an in-memory channel between two ends in place of the WebRTC page (the one part that needs Electron). A
 * `StreamListener` stands in for a fork's stream listener (the port its `hello` names).
 */
import { connect, createServer, type Server, type Socket } from 'node:net';
import type { MediaSignal } from '../media/match-media-types.js';
import type { TunnelEnd, TunnelEndOptions, TunnelEndStatus } from '../watch/tunnel-end.js';
import { TunnelBridge, type TunnelChannel } from '../watch/tunnel.js';

export const until = async (cond: () => boolean, ms = 5000, what = 'the condition'): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
};

/** The VPX fork's end of the control connection, scripted by the test. */
export class ScriptedFork {
  /** Every line the companion sent, in order. */
  readonly got: string[] = [];
  closed = false;
  private held = '';
  private obeying = false;

  private constructor(private readonly socket: Socket) {
    socket.setEncoding('utf8');
    socket.on('data', (d: string) => {
      this.held += d;
      for (let nl = this.held.indexOf('\n'); nl >= 0; nl = this.held.indexOf('\n')) {
        const line = this.held.slice(0, nl);
        this.got.push(line);
        this.held = this.held.slice(nl + 1);
        if (!this.obeying) continue;
        // A fork that keeps to §3: every watch is answered, every play too (rules 2 and 4).
        if (line.startsWith('watch ')) this.say('state watching');
        else if (line === 'play') this.say('state playing');
      }
    });
    socket.on('error', () => undefined);
    socket.on('close', () => (this.closed = true));
  }

  static connect(port: number): Promise<ScriptedFork> {
    return new Promise((resolve, reject) => {
      const s = connect({ host: '127.0.0.1', port });
      s.once('error', reject);
      s.once('connect', () => {
        s.off('error', reject);
        s.setNoDelay(true);
        resolve(new ScriptedFork(s));
      });
    });
  }

  /** From here on the fork answers by itself: `state watching` to every `watch`, `state playing` to every `play`. */
  obey(): this {
    this.obeying = true;
    return this;
  }

  /** How many of the companion's lines so far were a `watch` / a `play`. */
  count(what: 'watch' | 'play'): number {
    return this.got.filter((l) => (what === 'play' ? l === 'play' : l.startsWith('watch '))).length;
  }

  /** Whole lines, each ended with `\n`. */
  say(...lines: string[]): void {
    for (const l of lines) this.socket.write(`${l}\n`);
  }

  /** Bytes as given (a line in pieces, two lines in one write, no newline at all). */
  raw(text: string): void {
    this.socket.write(text);
  }

  /** A table start as the fork does it: hello (with the port its stream listener is bound to), then its first `state playing`. */
  hello(table = '617 9f3a61c2d4e5b701', build = '10.8.0.2078.castcade', streamPort = 50_001): void {
    this.say(`hello 1 ${build} ${table} ${streamPort}`, 'state playing');
  }

  async next(line: string | RegExp, from = 0, ms = 5000): Promise<string> {
    const hit = (): string | undefined => this.got.slice(from).find((l) => (typeof line === 'string' ? l === line : line.test(l)));
    await until(() => hit() !== undefined, ms, `the line ${String(line)} from the companion (got ${JSON.stringify(this.got)})`);
    return hit() as string;
  }

  close(): void {
    this.socket.destroy();
  }
}

/** The ends of one test's tunnels, by player id. */
export class TunnelHub {
  readonly ends = new Map<string, FakeTunnel>();
  /** Every end ever made (a second match on one PC makes a second end with the same id). */
  readonly all: FakeTunnel[] = [];

  make(o: TunnelEndOptions): FakeTunnel {
    const t = new FakeTunnel(this, o);
    const again = this.all.some((x) => x.id === o.localId);
    this.ends.set(o.localId, t);
    this.all.push(t);
    // A PC that comes back (Castcade restarted, a tunnel opened anew): the others' connections to its old end failed,
    // and the side that leads the pair offers again (the page mesh's ICE restart; the lower id here).
    if (again) {
      for (const other of this.ends.values()) {
        if (other !== t && other.id < t.id && other.peers.includes(t.id)) setTimeout(() => other.reoffer(t.id), 5);
      }
    }
    return t;
  }

  /** The channel between two ends is open: each has seen the other's offer or answer, and neither is closed. */
  open(a: string, b: string): boolean {
    const x = this.ends.get(a);
    const y = this.ends.get(b);
    return !!x && !!y && !x.closed && !y.closed && x.opened.has(b) && y.opened.has(a);
  }
}

export class FakeTunnel implements TunnelEnd {
  readonly id: string;
  peers: string[] = [];
  readonly opened = new Set<string>();
  /** Signals handed in by the owner (from the match's `stream` channel), as they came. */
  readonly signalsIn: Array<[string, MediaSignal]> = [];
  info: string | null = null;
  playerPort: number | null = null;
  watchPeer: string | null = null;
  /** Every `watch(peer)` in order. */
  readonly watched: string[] = [];
  closed = false;
  /** How often the owner called `setPeers` (the real end reports a change on every call: an owner that calls it from its own change handler would never stop). */
  setPeersCalls = 0;
  readonly watchPort: number;
  private static nextPort = 50_100;

  constructor(
    private readonly hub: TunnelHub,
    readonly o: TunnelEndOptions,
  ) {
    this.id = o.localId;
    this.watchPort = FakeTunnel.nextPort++;
  }

  setPeers(ids: readonly string[]): void {
    const next = ids.filter((id) => id !== this.id);
    for (const id of this.peers) {
      if (next.includes(id)) continue;
      this.opened.delete(id);
      this.o.onPeerInfo?.(id, null);
    }
    for (const id of next) {
      if (this.peers.includes(id)) continue;
      // The lower id offers, as the page's mesh does.
      if (this.id < id) this.o.sendSignal(id, { kind: 'offer', sdp: `v=0 data ${this.id}->${id}` });
    }
    this.peers = [...next];
    // As the real end: every call says "something changed", whether or not anything did.
    this.setPeersCalls += 1;
    this.o.onChange?.();
  }

  signal(from: string, s: MediaSignal): void {
    if (this.closed) return;
    this.signalsIn.push([from, s]);
    if (s.kind === 'reset') {
      // As the page's mesh: the sender's connections are new, so this side's is closed and opened again (the lower id offers).
      const had = this.hub.open(this.id, from);
      this.opened.delete(from);
      if (had) this.o.onPeerInfo?.(from, null);
      if (this.peers.includes(from) && this.id < from) this.o.sendSignal(from, { kind: 'offer', sdp: `v=0 data ${this.id}->${from} again` });
      return;
    }
    if (s.kind === 'offer') {
      this.o.sendSignal(from, { kind: 'answer', sdp: `v=0 data ${this.id}->${from}` });
      this.up(from);
    } else if (s.kind === 'answer') this.up(from);
  }

  /** The connection to `peer` failed and this side leads the pair: a new offer. */
  reoffer(peer: string): void {
    if (this.closed || !this.peers.includes(peer)) return;
    this.opened.delete(peer);
    this.o.sendSignal(peer, { kind: 'offer', sdp: `v=0 data ${this.id}->${peer} restart` });
  }

  private up(peer: string): void {
    const had = this.hub.open(this.id, peer);
    this.opened.add(peer);
    if (had || !this.hub.open(this.id, peer)) return;
    // The channel opened: each end is told what the other said last (tunnel version 2's INFO after HELLO).
    const other = this.hub.ends.get(peer) as FakeTunnel;
    if (other.info !== null) this.o.onPeerInfo?.(peer, other.info);
    if (this.info !== null) other.o.onPeerInfo?.(this.id, this.info);
    this.o.onChange?.();
    other.o.onChange?.();
  }

  /** The page's status report changed (a round-trip time: about every 2 s per peer on the real end). */
  report(): void {
    this.o.onChange?.();
  }

  setInfo(info: string | null): void {
    if (info === this.info) return;
    this.info = info;
    if (info === null) return;
    for (const peer of this.opened) if (this.hub.open(this.id, peer)) this.hub.ends.get(peer)?.o.onPeerInfo?.(this.id, info);
  }

  setPlayerPort(port: number | null): void {
    this.playerPort = port;
    this.o.onChange?.();
  }

  async watch(peer: string): Promise<number> {
    this.watchPeer = peer;
    this.watched.push(peer);
    this.o.onChange?.();
    // The real end opens (or re-aims) a listener here: the port comes back a little later, never in the same turn.
    // A test that reads the fork's lines the moment the decision shows is reading too early, and this makes it fail
    // on every machine rather than on a slow one.
    await new Promise((r) => setTimeout(r, FakeTunnel.watchDelayMs));
    return this.watchPort;
  }
  /** How long `watch` takes to answer (ms). */
  static watchDelayMs = Number(process.env.CASTCADE_TEST_WATCH_DELAY_MS ?? 20);

  stopWatching(): void {
    this.watchPeer = null;
  }

  status(): TunnelEndStatus {
    const peers: TunnelEndStatus['peers'] = {};
    for (const p of this.peers) {
      const open = this.hub.open(this.id, p);
      peers[p] = { path: open ? 'direct' : 'connecting', ice: open ? 'connected' : 'new', pair: open ? 'host -> host udp' : null, rttMs: open ? 1 : null, restarts: 0, channelOpen: open };
    }
    return { peers, watchPort: this.watchPeer ? this.watchPort : null, watchPeer: this.watchPeer, playerPort: this.playerPort, stats: { streams: [], opened: 0, refused: 0, framesOut: 0, framesIn: 0, bytesOut: 0, bytesIn: 0, channelStalls: 0, socketStalls: 0 }, pageError: null };
  }

  dropPeer(): void {}

  async close(): Promise<void> {
    if (this.closed) return;
    const open = [...this.opened].filter((p) => this.hub.open(this.id, p));
    this.closed = true;
    if (this.hub.ends.get(this.id) === this) this.hub.ends.delete(this.id);
    // The channel closing is seen on the other end: nothing is known of this PC any more.
    for (const p of open) {
      const other = this.hub.ends.get(p);
      other?.opened.delete(this.id);
      other?.o.onPeerInfo?.(this.id, null);
    }
  }
}

// ------------------------------------------------------------------- the real bridge, no page --

/** A fork's stream listener on loopback: it takes watchers and keeps what each sent. */
export class StreamListener {
  readonly sockets: Socket[] = [];
  /** What each connection sent, as text, by its index in `sockets`. */
  readonly got: string[] = [];
  private constructor(
    private readonly server: Server,
    readonly port: number,
  ) {}

  static open(): Promise<StreamListener> {
    return new Promise((resolve, reject) => {
      const server = createServer({ noDelay: true });
      server.once('error', reject);
      server.listen({ host: '127.0.0.1', port: 0 }, () => {
        const a = server.address();
        const l = new StreamListener(server, typeof a === 'object' && a ? a.port : 0);
        server.on('connection', (sock) => {
          const i = l.sockets.push(sock) - 1;
          l.got.push('');
          sock.on('data', (d: Buffer) => (l.got[i] += d.toString('utf8')));
          sock.on('error', () => undefined);
        });
        resolve(l);
      });
    });
  }

  /** Connections that are still open. */
  live(): Socket[] {
    return this.sockets.filter((x) => !x.destroyed && !x.readableEnded);
  }

  close(): Promise<void> {
    for (const x of this.sockets) x.destroy();
    return new Promise((r) => this.server.close(() => r()));
  }
}

/** The ends of one test's real-bridge tunnels, by player id. */
export class BridgeHub {
  readonly ends = new Map<string, BridgeTunnel>();
  make(o: TunnelEndOptions): BridgeTunnel {
    const t = new BridgeTunnel(this, o);
    this.ends.set(o.localId, t);
    return t;
  }
  open(a: string, b: string): boolean {
    const x = this.ends.get(a);
    const y = this.ends.get(b);
    return !!x && !!y && x.channels.has(b) && y.channels.has(a);
  }
}

/**
 * One PC's end of the tunnel as `tunnel-end.ts` builds it, without the page: the real `TunnelBridge`, a real loopback
 * listener for this PC's watcher VPX, real loopback connections to this PC's player VPX. Frames go to the other end's
 * bridge in order, a turn of the loop later (a data channel is reliable and ordered).
 */
export class BridgeTunnel implements TunnelEnd {
  readonly id: string;
  readonly bridge: TunnelBridge;
  readonly channels = new Map<string, TunnelChannel>();
  readonly logs: string[] = [];
  private peers: string[] = [];
  private readonly opened = new Set<string>();
  private server: Server | null = null;
  private port: number | null = null;
  private watchPeer: string | null = null;
  private playerPort: number | null = null;
  private closed = false;

  constructor(
    private readonly hub: BridgeHub,
    private readonly o: TunnelEndOptions,
  ) {
    this.id = o.localId;
    this.bridge = new TunnelBridge({
      connect: (port) => connect({ host: '127.0.0.1', port }),
      log: (line) => {
        this.logs.push(line);
        o.log(`${o.logTag ?? 'watch'}: ${line}`);
      },
      onInfo: (peer, payload) => o.onPeerInfo?.(peer, payload ? Buffer.from(payload).toString('utf8') : null),
      endGraceMs: 20,
    });
  }

  setPeers(ids: readonly string[]): void {
    const next = ids.filter((id) => id !== this.id);
    for (const id of next) if (!this.peers.includes(id) && this.id < id) this.o.sendSignal(id, { kind: 'offer', sdp: `v=0 data ${this.id}->${id}` });
    this.peers = [...next];
  }

  signal(from: string, s: MediaSignal): void {
    if (this.closed) return;
    if (s.kind === 'offer') {
      this.o.sendSignal(from, { kind: 'answer', sdp: `v=0 data ${this.id}->${from}` });
      this.up(from);
    } else if (s.kind === 'answer') this.up(from);
  }

  private up(peer: string): void {
    this.opened.add(peer);
    const other = this.hub.ends.get(peer);
    if (!other || !other.opened.has(this.id) || this.channels.has(peer)) return;
    const link = (from: BridgeTunnel, to: BridgeTunnel): TunnelChannel => ({
      busy: false,
      // A copy, delivered later and in order, as a message of a data channel is.
      send: (frame) => {
        const copy = Uint8Array.from(frame);
        setImmediate(() => {
          if (!to.closed && !from.closed) to.bridge.receive(from.id, copy);
        });
      },
    });
    const mine = link(this, other);
    const theirs = link(other, this);
    this.channels.set(peer, mine);
    other.channels.set(this.id, theirs);
    this.bridge.channelUp(peer, mine);
    other.bridge.channelUp(this.id, theirs);
  }

  setInfo(info: string | null): void {
    this.bridge.setInfo(info === null ? null : Buffer.from(info, 'utf8'));
  }

  setPlayerPort(port: number | null): void {
    this.playerPort = port;
    this.bridge.setPlayerPort(port);
  }

  /** As `tunnel-end.ts`: one listener for the match, opened once and re-aimed after. */
  async watch(peer: string): Promise<number> {
    this.watchPeer = peer;
    if (this.server && this.port !== null) return this.port;
    const server = createServer({ noDelay: true }, (sock) => {
      sock.on('error', () => undefined);
      if (!this.watchPeer || this.closed) return void sock.destroy();
      this.bridge.attachWatcher(sock, this.watchPeer);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: '127.0.0.1', port: 0 }, () => resolve());
    });
    const a = server.address();
    this.server = server;
    this.port = typeof a === 'object' && a ? a.port : null;
    if (this.port === null) throw new Error('the watcher listener has no port');
    return this.port;
  }

  stopWatching(): void {
    this.watchPeer = null;
  }

  status(): TunnelEndStatus {
    const peers: TunnelEndStatus['peers'] = {};
    for (const p of this.peers) {
      const open = this.channels.has(p);
      peers[p] = { path: open ? 'direct' : 'connecting', ice: open ? 'connected' : 'new', pair: null, rttMs: null, restarts: 0, channelOpen: open };
    }
    return { peers, watchPort: this.port, watchPeer: this.watchPeer, playerPort: this.playerPort, stats: this.bridge.stats(), pageError: null };
  }

  dropPeer(): void {}

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.bridge.close();
    for (const p of [...this.channels.keys()]) {
      const other = this.hub.ends.get(p);
      other?.channels.delete(this.id);
      other?.opened.delete(this.id);
      other?.bridge.channelDown(this.id, 'the peer closed');
    }
    this.channels.clear();
    if (this.hub.ends.get(this.id) === this) this.hub.ends.delete(this.id);
    const s = this.server;
    this.server = null;
    if (s) await new Promise<void>((r) => s.close(() => r()));
  }
}
