/**
 * I11.4.2: what the state-stream tests share: a scripted control client standing in for the VPX fork (a real socket on
 * loopback, speaking the lines of docs/design/state-stream-in-match.md §3), and fake tunnel ends joined by a hub that
 * behaves as the real ones do towards their owner: a "data channel" between two ends opens once an offer and an answer
 * crossed through the owner's signalling, what each end says with `setInfo` reaches the other's `onPeerInfo` over an
 * open channel, and a closed end says null to everyone it was connected to.
 */
import { connect, type Socket } from 'node:net';
import type { MediaSignal } from '../media/match-media-types.js';
import type { TunnelEnd, TunnelEndOptions, TunnelEndStatus } from '../watch/tunnel-end.js';

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

  private constructor(private readonly socket: Socket) {
    socket.setEncoding('utf8');
    socket.on('data', (d: string) => {
      this.held += d;
      for (let nl = this.held.indexOf('\n'); nl >= 0; nl = this.held.indexOf('\n')) {
        this.got.push(this.held.slice(0, nl));
        this.held = this.held.slice(nl + 1);
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

  /** Whole lines, each ended with `\n`. */
  say(...lines: string[]): void {
    for (const l of lines) this.socket.write(`${l}\n`);
  }

  /** Bytes as given (a line in pieces, two lines in one write, no newline at all). */
  raw(text: string): void {
    this.socket.write(text);
  }

  /** A table start as the fork does it: hello, then its first `state playing`. */
  hello(table = '617 9f3a61c2d4e5b701', build = '10.8.0.2078.castcade'): void {
    this.say(`hello 1 ${build} ${table}`, 'state playing');
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
    this.ends.set(o.localId, t);
    this.all.push(t);
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
    if (s.kind === 'offer') {
      this.o.sendSignal(from, { kind: 'answer', sdp: `v=0 data ${this.id}->${from}` });
      this.up(from);
    } else if (s.kind === 'answer') this.up(from);
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
    return this.watchPort;
  }

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
