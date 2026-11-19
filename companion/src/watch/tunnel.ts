/**
 * I11.4.1 (2026-11-16, ADR 0011): the 3D watch tunnel's core. The VPX fork streams a table's state over plain TCP
 * (`CASTCADE_STREAM_ADDR`); across two PCs that needed a listening port, a Windows Firewall prompt and a router
 * forward. Here each VPX talks only to the companion on its own PC, over loopback, and the companions carry the bytes
 * between them over one reliable ordered WebRTC data channel per peer (`tunnel-end.ts` owns the channel and the
 * sockets; this file decides what goes where, and is pure so vitest drives it with fake sockets and channels).
 *
 * - A watcher's VPX connects to this companion's loopback listener: `attachWatcher` opens a stream to the peer whose
 *   table it watches (OPEN). That peer's companion connects to its own player's VPX on loopback (`setPlayerPort`) and
 *   splices bytes both ways (ACCEPT), or answers REFUSE when nothing listens there. Every watcher is its own stream: a
 *   player's VPX accepts any number of watchers, and so does this bridge.
 * - Refused, or closed on either end, closes the other end's local socket: the fork's own recovery does the rest (a
 *   watcher reconnects every 2 s and gets a fresh keyframe; a player drops a watcher whose socket closed). The channel
 *   going down closes every stream on it the same way. Nothing here retries.
 * - The fork's bytes are opaque: never parsed, never logged.
 *
 * Frames: one data-channel message each, at most `FRAME_MAX` bytes (16 KB, what every SCTP stack takes). A 5-byte
 * header, then the payload: `[kind | 0x80 when the frame's sender accepted the stream][stream id, uint32 BE]`. Ids are
 * chosen by the side that opens a stream; the flag keeps the two sides' ids apart, so both may open streams at once.
 * HELLO (id 0) carries the tunnel version, once per channel; a different one is logged and the streams go on.
 *
 * Version 2 (I11.4.2, 2026-11-19): INFO (id 0), a frame of the channel itself like HELLO: a short payload this side's
 * owner wants the peer's owner to have (`setInfo`; the match's 3D capability, main/stream3d-host.ts), opaque here. It is
 * sent when the peer's HELLO has said 2 or later (a version 1 bridge would log every one as malformed, so it gets
 * none) and again whenever it changes; what a peer sent last is handed to `onInfo`, and null when its channel closes.
 * The 3D watch session sets none, so its frames are version 1's, byte for byte, but for the number in HELLO.
 *
 * Backpressure, both ways: a channel whose send buffer is over its high mark (`channelBusy`, the page's
 * `bufferedAmount`) stops the reads of every local socket that feeds it until `channelWritable`; a local socket whose
 * write buffer is full (`write` false) sends PAUSE so the far end stops reading its socket for that stream, and RESUME
 * at `drain`. What is already on the way when either happens is a few frames, held in memory.
 */

export const TUNNEL_VERSION = 2;
/** The first version whose bridge takes INFO. */
export const INFO_SINCE_VERSION = 2;
/** An INFO payload is at most this long (bytes). */
export const INFO_MAX = 1024;
/** One data-channel message, header included: the size SCTP implementations all accept. */
export const FRAME_MAX = 16 * 1024;
export const HEADER_BYTES = 5;
/** Payload bytes per DATA frame. */
export const CHUNK_BYTES = FRAME_MAX - HEADER_BYTES;
/** Bytes held for a stream whose local connection is not up yet (a VPX's hello and the first frames); more refuses it. */
export const PENDING_MAX = 4 * 1024 * 1024;
/** A local socket told to end after CLOSE is destroyed after this, if the fork does not close it first. */
export const END_GRACE_MS = 2_000;
/** Refusals and streams that end before they open are logged at most this often (the fork retries every 2 s). */
export const REFUSAL_LOG_MS = 30_000;

export const FRAME = { HELLO: 0, OPEN: 1, ACCEPT: 2, REFUSE: 3, DATA: 4, CLOSE: 5, PAUSE: 6, RESUME: 7, INFO: 8 } as const;
export type FrameKind = (typeof FRAME)[keyof typeof FRAME];
const KIND_NAMES = ['HELLO', 'OPEN', 'ACCEPT', 'REFUSE', 'DATA', 'CLOSE', 'PAUSE', 'RESUME', 'INFO'] as const;
const ACCEPTOR_FLAG = 0x80;
const MAX_ID = 0xffff_ffff;

export interface Frame {
  kind: FrameKind;
  id: number;
  /** The frame's sender is the side that accepted the stream (not the one that opened it). */
  fromAcceptor: boolean;
  payload: Uint8Array;
}

export function packFrame(kind: FrameKind, id: number, fromAcceptor: boolean, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  if (payload.length > CHUNK_BYTES) throw new Error(`a tunnel frame holds at most ${CHUNK_BYTES} bytes, not ${payload.length}`);
  const out = new Uint8Array(HEADER_BYTES + payload.length);
  out[0] = kind | (fromAcceptor ? ACCEPTOR_FLAG : 0);
  new DataView(out.buffer).setUint32(1, id >>> 0, false);
  out.set(payload, HEADER_BYTES);
  return out;
}

/** The frame in `buf`, or null for anything that is not one (too short, too long, an unknown kind). */
export function unpackFrame(buf: Uint8Array): Frame | null {
  if (buf.length < HEADER_BYTES || buf.length > FRAME_MAX) return null;
  const b0 = buf[0] as number;
  const kind = b0 & 0x7f;
  if (kind > FRAME.INFO) return null;
  const id = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(1, false);
  return { kind: kind as FrameKind, id, fromAcceptor: (b0 & ACCEPTOR_FLAG) !== 0, payload: buf.subarray(HEADER_BYTES) };
}

export const frameName = (kind: number): string => KIND_NAMES[kind] ?? `kind ${kind}`;

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();
/** A reason on REFUSE / CLOSE: short, one line. */
const reasonBytes = (why: string): Uint8Array => utf8.encode(why.replace(/[\r\n]+/g, ' ').slice(0, 200));

/** The part of `net.Socket` the bridge uses (fakes in the tests). */
export interface TunnelSocket {
  write(data: Uint8Array): boolean;
  end(): void;
  destroy(): void;
  pause(): void;
  resume(): void;
  setNoDelay?(noDelay?: boolean): unknown;
  on(event: 'data', cb: (data: Uint8Array) => void): unknown;
  on(event: 'connect' | 'drain' | 'close', cb: () => void): unknown;
  on(event: 'error', cb: (err: Error) => void): unknown;
}

/** One peer's data channel as the bridge sees it: frames go out with `send`; `busy` while its buffer is over the high mark. */
export interface TunnelChannel {
  send(frame: Uint8Array): void;
  readonly busy: boolean;
}

export interface TunnelOptions {
  /** A connection to this PC's player VPX (127.0.0.1 only: the caller's rule). */
  connect(port: number): TunnelSocket;
  log(line: string): void;
  /** Version 2: what `peer`'s owner said last with INFO (a copy), or null when the channel to it closed. */
  onInfo?(peer: string, payload: Uint8Array | null): void;
  /** Test seams. */
  pendingMax?: number;
  endGraceMs?: number;
  now?: () => number;
}

export interface TunnelStreamInfo {
  peer: string;
  id: number;
  /** `watch`: a watcher VPX of this PC, streamed to `peer`'s player. `play`: `peer`'s watcher, fed by this PC's player. */
  role: 'watch' | 'play';
  state: 'opening' | 'open';
  /** Bytes from the local VPX to the channel, and from the channel to the local VPX. */
  up: number;
  down: number;
  since: number;
}

export interface TunnelStats {
  streams: TunnelStreamInfo[];
  /** Streams opened since the start, and how many of them were refused or failed before opening. */
  opened: number;
  refused: number;
  /** Frames and bytes over the channels since the start (bytes are payload bytes). */
  framesOut: number;
  framesIn: number;
  bytesOut: number;
  bytesIn: number;
  /** Times a channel's buffer passed its high mark, and times a local socket's write buffer filled. */
  channelStalls: number;
  socketStalls: number;
}

interface Stream {
  key: string;
  peer: string;
  id: number;
  /** This side opened it (a local watcher); false: the peer did (this side's player feeds it). */
  opener: boolean;
  socket: TunnelSocket | null;
  connected: boolean;
  /** The opener: ACCEPT arrived. */
  accepted: boolean;
  /** Bytes from the channel before the local socket connected. */
  pending: Uint8Array[];
  pendingBytes: number;
  /** The peer asked this side to stop reading the local socket (its own socket's buffer is full). */
  remotePaused: boolean;
  /** This side asked the peer to stop (PAUSE sent, no RESUME yet). */
  pausedPeer: boolean;
  /** The local socket's reads are paused now. */
  readPaused: boolean;
  done: boolean;
  up: number;
  down: number;
  since: number;
  endTimer: ReturnType<typeof setTimeout> | null;
}

interface Peer {
  channel: TunnelChannel;
  busy: boolean;
  helloed: boolean;
  /** The version its HELLO said (0 before it). */
  version: number;
}

const keyOf = (peer: string, opener: boolean, id: number): string => `${peer}\u0000${opener ? 'o' : 'a'}${id}`;
const errWord = (e: Error): string => (e as Error & { code?: unknown }).code?.toString() ?? e.message;

export class TunnelBridge {
  private readonly peers = new Map<string, Peer>();
  private readonly streams = new Map<string, Stream>();
  private playerPort: number | null = null;
  private nextId = 1;
  private closed = false;
  /** Version 2: what this side says with INFO, or null: nothing is sent. */
  private info: Uint8Array | null = null;
  private readonly pendingMax: number;
  private readonly endGraceMs: number;
  private readonly now: () => number;
  private readonly counters = { opened: 0, refused: 0, framesOut: 0, framesIn: 0, bytesOut: 0, bytesIn: 0, channelStalls: 0, socketStalls: 0 };
  /** Refusals repeat every 2 s while a watcher waits for a table to start: one line, then a count at most every `REFUSAL_LOG_MS`. */
  private refusalLog = { at: -Infinity, quiet: 0 };

  constructor(private readonly o: TunnelOptions) {
    this.pendingMax = o.pendingMax ?? PENDING_MAX;
    this.endGraceMs = o.endGraceMs ?? END_GRACE_MS;
    this.now = o.now ?? (() => Date.now());
  }

  /** The port this PC's player VPX listens on (127.0.0.1), or null: a peer's watcher is then refused. */
  setPlayerPort(port: number | null): void {
    this.playerPort = port;
  }

  /**
   * Version 2: what every peer's owner is told with INFO (at most `INFO_MAX` bytes), now and on every channel that
   * opens later; null stops telling new channels (what a peer already has stays until the next one). Unchanged: nothing
   * is sent.
   */
  setInfo(payload: Uint8Array | null): void {
    if (payload && payload.length > INFO_MAX) throw new Error(`a tunnel INFO holds at most ${INFO_MAX} bytes, not ${payload.length}`);
    const same = payload === null ? this.info === null : this.info !== null && payload.length === this.info.length && payload.every((b, i) => b === (this.info as Uint8Array)[i]);
    if (same) return;
    this.info = payload ? payload.slice() : null;
    if (!this.info) return;
    for (const [peer, p] of this.peers) if (p.version >= INFO_SINCE_VERSION) this.emit(peer, p, packFrame(FRAME.INFO, 0, false, this.info));
  }

  /** The peer's channel is open. */
  channelUp(peer: string, channel: TunnelChannel): void {
    if (this.closed) return;
    if (this.peers.has(peer)) this.channelDown(peer, 'its channel was replaced');
    const p: Peer = { channel, busy: false, helloed: false, version: 0 };
    this.peers.set(peer, p);
    this.emit(peer, p, packFrame(FRAME.HELLO, 0, false, new Uint8Array([TUNNEL_VERSION])));
  }

  /** The peer's channel closed (the peer left, its connection failed or was replaced): every stream on it closes. */
  channelDown(peer: string, why: string): void {
    if (!this.peers.delete(peer)) return;
    this.o.onInfo?.(peer, null);
    const gone = [...this.streams.values()].filter((s) => s.peer === peer);
    if (gone.length > 0) this.o.log(`tunnel: the channel to ${peer} closed (${why}); closing ${gone.length} stream(s)`);
    for (const s of gone) this.finish(s, false, 'the channel closed', true);
  }

  /** The peer's channel is over its high mark: the local sockets that feed it stop reading. */
  channelBusy(peer: string): void {
    const p = this.peers.get(peer);
    if (!p || p.busy) return;
    p.busy = true;
    this.counters.channelStalls += 1;
    for (const s of this.streams.values()) if (s.peer === peer) this.syncRead(s);
  }

  /** The peer's channel drained below its low mark: reading resumes. */
  channelWritable(peer: string): void {
    const p = this.peers.get(peer);
    if (!p || !p.busy) return;
    p.busy = false;
    for (const s of this.streams.values()) if (s.peer === peer) this.syncRead(s);
  }

  /**
   * A watcher VPX on this PC connected to the loopback listener: stream it to `peer`'s player. No channel to the peer
   * yet: the socket is closed at once (the fork connects again in 2 s).
   */
  attachWatcher(socket: TunnelSocket, peer: string): void {
    const p = this.peers.get(peer);
    if (this.closed || !p) {
      this.counters.refused += 1;
      this.logRefusal(`a watcher connected, but there is no channel to ${peer} yet; closed it (the watcher tries again)`);
      socket.destroy();
      return;
    }
    const id = this.takeId(peer);
    const s = this.newStream(peer, id, true, socket);
    s.connected = true;
    socket.setNoDelay?.(true);
    this.wire(s, socket);
    this.counters.opened += 1;
    this.o.log(`tunnel: stream ${id} open: this PC's watcher to ${peer}'s table`);
    this.send(s, FRAME.OPEN);
    this.syncRead(s);
  }

  /** A frame from `peer`'s channel. */
  receive(peer: string, buf: Uint8Array): void {
    const p = this.peers.get(peer);
    if (!p || this.closed) return;
    const f = unpackFrame(buf);
    if (!f) {
      this.o.log(`tunnel: dropped a malformed frame from ${peer} (${buf.length} bytes)`);
      return;
    }
    this.counters.framesIn += 1;
    if (f.kind === FRAME.HELLO) {
      const v = f.payload[0];
      if (!p.helloed && v !== TUNNEL_VERSION) this.o.log(`tunnel: ${peer} speaks tunnel version ${v ?? '?'}, this PC ${TUNNEL_VERSION}; carrying on`);
      const first = !p.helloed;
      p.helloed = true;
      if (first) {
        p.version = v ?? 0;
        if (this.info && p.version >= INFO_SINCE_VERSION) this.emit(peer, p, packFrame(FRAME.INFO, 0, false, this.info));
      }
      return;
    }
    if (f.kind === FRAME.INFO) {
      // The payload is a view of the channel's message: handed on as a copy.
      if (f.payload.length <= INFO_MAX) this.o.onInfo?.(peer, f.payload.slice());
      return;
    }
    // The flag is the sender's view: a frame from the acceptor is about a stream this side opened.
    const opener = f.fromAcceptor;
    const s = this.streams.get(keyOf(peer, opener, f.id));
    if (f.kind === FRAME.OPEN) {
      if (opener) return;
      if (s) return this.finish(s, true, 'the peer opened it twice', false);
      return this.acceptStream(peer, f.id);
    }
    if (!s) {
      // A stream this side no longer has (closed meanwhile): say so once, never in answer to an ending.
      if (f.kind !== FRAME.CLOSE && f.kind !== FRAME.REFUSE) this.emitFrame(peer, packFrame(FRAME.CLOSE, f.id, !opener, reasonBytes('no such stream')));
      return;
    }
    switch (f.kind) {
      case FRAME.ACCEPT:
        if (s.opener && !s.accepted) {
          s.accepted = true;
          this.o.log(`tunnel: stream ${s.id} accepted: ${peer}'s table is streaming to this PC's watcher`);
        }
        return;
      case FRAME.REFUSE:
        this.counters.refused += 1;
        return this.finish(s, false, `refused by ${peer}: ${fromUtf8.decode(f.payload) || 'no reason'}`, true);
      case FRAME.CLOSE:
        return this.finish(s, false, `${peer} closed it${f.payload.length ? ` (${fromUtf8.decode(f.payload)})` : ''}`, false);
      case FRAME.PAUSE:
        s.remotePaused = true;
        return this.syncRead(s);
      case FRAME.RESUME:
        s.remotePaused = false;
        return this.syncRead(s);
      case FRAME.DATA:
        return this.deliver(s, f.payload);
    }
  }

  stats(): TunnelStats {
    return {
      ...this.counters,
      streams: [...this.streams.values()].map((s) => ({
        peer: s.peer,
        id: s.id,
        role: s.opener ? 'watch' : 'play',
        state: s.connected && (s.accepted || !s.opener) ? 'open' : 'opening',
        up: s.up,
        down: s.down,
        since: s.since,
      })),
    };
  }

  /** Close every stream and forget every channel. */
  close(): void {
    this.closed = true;
    for (const s of [...this.streams.values()]) this.finish(s, true, 'the tunnel closed', true);
    this.peers.clear();
  }

  // ---- inside ----

  private logRefusal(line: string): void {
    const now = this.now();
    if (now - this.refusalLog.at < REFUSAL_LOG_MS) {
      this.refusalLog.quiet += 1;
      return;
    }
    const quiet = this.refusalLog.quiet;
    this.refusalLog = { at: now, quiet: 0 };
    this.o.log(`tunnel: ${line}${quiet > 0 ? ` (and ${quiet} more like it since the last line)` : ''}`);
  }

  private takeId(peer: string): number {
    for (let k = 0; k < 1000; k++) {
      const id = this.nextId;
      this.nextId = this.nextId >= MAX_ID ? 1 : this.nextId + 1;
      if (!this.streams.has(keyOf(peer, true, id))) return id;
    }
    throw new Error('no free tunnel stream id');
  }

  private newStream(peer: string, id: number, opener: boolean, socket: TunnelSocket | null): Stream {
    const s: Stream = {
      key: keyOf(peer, opener, id),
      peer,
      id,
      opener,
      socket,
      connected: false,
      accepted: false,
      pending: [],
      pendingBytes: 0,
      remotePaused: false,
      pausedPeer: false,
      readPaused: false,
      done: false,
      up: 0,
      down: 0,
      since: this.now(),
      endTimer: null,
    };
    this.streams.set(s.key, s);
    return s;
  }

  /** A peer's watcher wants this PC's player: connect to it on loopback. */
  private acceptStream(peer: string, id: number): void {
    const port = this.playerPort;
    if (port === null) {
      this.counters.refused += 1;
      this.logRefusal(`${peer}'s watcher asked for this PC's table, but no table is playing here; refused stream ${id}`);
      this.emitFrame(peer, packFrame(FRAME.REFUSE, id, true, reasonBytes('no table is playing on that PC')));
      return;
    }
    let socket: TunnelSocket;
    try {
      socket = this.o.connect(port);
    } catch (e) {
      this.counters.refused += 1;
      this.emitFrame(peer, packFrame(FRAME.REFUSE, id, true, reasonBytes(`could not reach the table (${errWord(e as Error)})`)));
      return;
    }
    const s = this.newStream(peer, id, false, socket);
    this.counters.opened += 1;
    socket.on('connect', () => {
      if (s.done) return;
      s.connected = true;
      socket.setNoDelay?.(true);
      for (const chunk of s.pending.splice(0)) this.writeLocal(s, chunk);
      s.pendingBytes = 0;
      this.o.log(`tunnel: stream ${id} open: ${peer}'s watcher on this PC's table`);
      this.send(s, FRAME.ACCEPT);
      this.syncRead(s);
    });
    this.wire(s, socket);
  }

  private wire(s: Stream, socket: TunnelSocket): void {
    socket.on('data', (d) => this.fromLocal(s, d));
    socket.on('drain', () => {
      if (s.done || !s.pausedPeer) return;
      s.pausedPeer = false;
      this.send(s, FRAME.RESUME);
    });
    socket.on('error', (e) => {
      if (s.done) return;
      if (!s.connected) {
        this.counters.refused += 1;
        this.logRefusal(`stream ${s.id}: this PC's table did not answer on its port (${errWord(e)}); refused`);
        this.emitFrame(s.peer, packFrame(FRAME.REFUSE, s.id, true, reasonBytes(`the table is not streaming (${errWord(e)})`)));
        return this.finish(s, false, 'refused', true);
      }
      this.finish(s, true, `the local connection failed (${errWord(e)})`, true);
    });
    socket.on('close', () => {
      if (s.done) return;
      if (!s.connected) {
        this.counters.refused += 1;
        this.emitFrame(s.peer, packFrame(FRAME.REFUSE, s.id, true, reasonBytes('the table is not streaming')));
        return this.finish(s, false, 'refused', true);
      }
      this.finish(s, true, 'the local VPX closed it', true);
    });
  }

  /** Bytes from the local VPX: to the channel in frames of at most `FRAME_MAX`. */
  private fromLocal(s: Stream, d: Uint8Array): void {
    if (s.done) return;
    const p = this.peers.get(s.peer);
    if (!p) return;
    for (let off = 0; off < d.length; off += CHUNK_BYTES) {
      const part = d.subarray(off, Math.min(d.length, off + CHUNK_BYTES));
      this.emit(s.peer, p, packFrame(FRAME.DATA, s.id, !s.opener, part));
      this.counters.bytesOut += part.length;
    }
    s.up += d.length;
    if (p.channel.busy && !p.busy) this.channelBusy(s.peer);
  }

  /** Bytes from the channel: to the local VPX (held until its connection is up). */
  private deliver(s: Stream, payload: Uint8Array): void {
    this.counters.bytesIn += payload.length;
    s.down += payload.length;
    if (!s.connected) {
      s.pendingBytes += payload.length;
      if (s.pendingBytes > this.pendingMax) {
        this.counters.refused += 1;
        this.emitFrame(s.peer, packFrame(FRAME.REFUSE, s.id, true, reasonBytes('the table took too long to answer')));
        return this.finish(s, false, `more than ${this.pendingMax} bytes waited for the local connection`, true);
      }
      // The payload is a view of the channel's message: kept as a copy.
      s.pending.push(payload.slice());
      return;
    }
    this.writeLocal(s, payload);
  }

  private writeLocal(s: Stream, chunk: Uint8Array): void {
    if (!s.socket || s.done) return;
    const ok = s.socket.write(chunk);
    if (!ok && !s.pausedPeer) {
      s.pausedPeer = true;
      this.counters.socketStalls += 1;
      this.send(s, FRAME.PAUSE);
    }
  }

  /** The local socket reads while the channel has room, the peer has not asked for a pause, and the stream is up. */
  private syncRead(s: Stream): void {
    if (!s.socket || s.done) return;
    const p = this.peers.get(s.peer);
    const want = !s.connected || s.remotePaused || !p || p.busy;
    if (want === s.readPaused) return;
    s.readPaused = want;
    if (want) s.socket.pause();
    else s.socket.resume();
  }

  private send(s: Stream, kind: FrameKind): void {
    this.emitFrame(s.peer, packFrame(kind, s.id, !s.opener));
  }

  private emitFrame(peer: string, frame: Uint8Array): void {
    const p = this.peers.get(peer);
    if (p) this.emit(peer, p, frame);
  }

  private emit(peer: string, p: Peer, frame: Uint8Array): void {
    try {
      p.channel.send(frame);
      this.counters.framesOut += 1;
    } catch (e) {
      // The channel is closing: its close event follows and ends the streams.
      this.o.log(`tunnel: could not send to ${peer} (${(e as Error).message})`);
    }
  }

  /**
   * The stream is over. `tellPeer`: the far end does not know yet (CLOSE goes out). `hard`: the local socket is
   * destroyed now; otherwise it is ended (what was written still reaches the VPX) and destroyed after the grace.
   */
  private finish(s: Stream, tellPeer: boolean, why: string, hard: boolean): void {
    if (s.done) return;
    s.done = true;
    this.streams.delete(s.key);
    if (tellPeer) this.emitFrame(s.peer, packFrame(FRAME.CLOSE, s.id, !s.opener, reasonBytes(why)));
    const secs = Math.round((this.now() - s.since) / 100) / 10;
    const what = `stream ${s.id} (${s.opener ? 'watching' : 'feeding'} ${s.peer})`;
    if (s.opener ? s.accepted : s.connected) this.o.log(`tunnel: ${what} closed: ${why}; ${s.up} bytes up, ${s.down} down in ${secs} s`);
    else if (why !== 'refused') this.logRefusal(`${what} ended before it opened: ${why}`);
    s.pending = [];
    const sock = s.socket;
    if (!sock) return;
    if (hard || !s.connected) {
      sock.destroy();
      return;
    }
    sock.end();
    s.endTimer = setTimeout(() => sock.destroy(), this.endGraceMs);
    // The timer must not keep a process alive (tests, the harness).
    (s.endTimer as { unref?: () => void }).unref?.();
  }
}
