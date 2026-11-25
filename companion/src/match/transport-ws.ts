/**
 * WebSocket transports: `WsHostTransport` (one `ws` server, one socket per client, socket ->
 * playerId learned from the first HELLO) and `WsClientTransport` (one socket to the host), the
 * fixed-role pair from Phase 1; and `WsPeerTransport` (A2, 2026-10-30), one participant that can
 * hold either role and change it mid-match: an optional listener plus outbound links, so a client
 * can become host, the old host can become its client, and a dropped client can reconnect.
 * Frames are `encodeFrame`/`decodeFrame`; undecodable frames are dropped and reported through
 * `onError`. A HELLO with a foreign protocol version is answered with REFUSE(protocol_version)
 * here, because such a frame never parses into a typed message; A17 (2026-11-24): in the asker's own version,
 * and a RECONNECT of a foreign version is answered as well (`foreignVersionRefusal`).
 */
import { WebSocket, WebSocketServer } from 'ws';
import { buildMessage, decodeFrame, encodeFrame, PROTOCOL_VERSION, type AnyMessage, type PlayerId } from '@castcade/protocol';
import type { MessageHandler, PeerHandler, Transport } from './transport.js';

export type ErrorHandler = (err: Error, peer: PlayerId | null) => void;

type RawData = Parameters<Parameters<WebSocket['on']>[1]>[0];

function rawToString(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return Buffer.from(data as Uint8Array).toString('utf8');
}

/**
 * A17 (2026-11-24): the first Castcade release that speaks `PROTOCOL_VERSION`, for the sentence a PC on an older
 * version is shown. Changed together with the version (`transport-relay.test.ts` holds the two side by side).
 */
export const PROTOCOL_SINCE_RELEASE = '0.2.46';

const ZERO_HASH = '0'.repeat(64);

/** The `v` of a frame that is JSON with a whole-number version other than ours; null for anything else. */
export function foreignVersionOf(text: string): number | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const v = (value as { v?: unknown }).v;
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v !== PROTOCOL_VERSION ? v : null;
}

/**
 * A17 (2026-11-24): what a joining PC shows when the host's answer does not decode because the host speaks another
 * protocol version (a host up to 0.2.50 answers in its own version, see `foreignVersionRefusal`): the sentence in
 * place of "The host did not answer" ten seconds later. Raised through a client transport's `onError`.
 */
export class ForeignVersionError extends Error {
  constructor(readonly theirs: number) {
    super(
      `The host's PC runs another version of Castcade (protocol ${theirs}; this PC has ${PROTOCOL_VERSION}). Both need the same: ${
        theirs > PROTOCOL_VERSION ? 'update Castcade on this PC (Settings, Check for updates)' : 'the host updates Castcade (Settings, Check for updates)'
      }, then join again.`,
    );
    this.name = 'ForeignVersionError';
  }
}

/** What a client transport reports for a frame that does not decode: the sentence when the frame is of another version. */
export function undecodable(text: string, e: unknown): unknown {
  const theirs = foreignVersionOf(text);
  return theirs !== null ? new ForeignVersionError(theirs) : e;
}

/** The sentence the PC that asked is shown ("The host refused: …"); it names what that PC, or the host, has to do. */
function refusalSentence(theirs: unknown): string {
  if (typeof theirs === 'number' && theirs > PROTOCOL_VERSION) {
    return `The host's Castcade is older than this PC's (it speaks protocol ${PROTOCOL_VERSION}, this PC ${theirs}). The host updates Castcade (Settings, Check for updates); then join again.`;
  }
  return `This match needs Castcade ${PROTOCOL_SINCE_RELEASE} or newer (protocol ${PROTOCOL_VERSION}; this PC sent ${String(theirs)}). Update Castcade on this PC (Settings, Check for updates) and join again.`;
}

/**
 * A HELLO or a RECONNECT whose `v` differs never decodes: the frame that answers it, or null when the text is
 * anything else. Shared with the relay transport (D10.8), which has no socket to close.
 *
 * A17 (2026-11-24): the answer is written **in the asker's version** (its `v` on the envelope). Until 0.2.50 it went
 * out in the host's own, and the envelope's `v` is a literal, so the PC that asked could not decode it and reported a
 * host that did not answer. `REFUSE` and `RECONNECT_ACK` have had the same shape since protocol 2, so the asker reads
 * the frame and shows the sentence. And a RECONNECT is answered too (it got nothing: its sender waited out the whole
 * host wait): with a `RECONNECT_ACK` that does not accept, `unknown_player` being the nearest code every version
 * knows; the asker then says at once that the host did not take it back. Its `seq` is the wall clock, because the
 * asker drops a frame whose `seq` is not above the last it took from this host, in an earlier run or version (A15's
 * rule for a restarted sender); a HELLO opens a new connection, so its REFUSE keeps the caller's counter.
 */
export function foreignVersionRefusal(text: string, from: PlayerId, seq: number): string | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const v = (value as { v?: unknown }).v;
  const type = (value as { type?: unknown }).type;
  if ((type !== 'HELLO' && type !== 'RECONNECT') || v === PROTOCOL_VERSION) return null;
  let answer: AnyMessage;
  if (type === 'HELLO') {
    answer = buildMessage('REFUSE', { code: 'protocol_version', message: refusalSentence(v) }, { matchId: null, seq, from });
  } else {
    const asked = (value as { matchId?: unknown }).matchId;
    const matchId = typeof asked === 'string' && asked.length > 0 && asked.length <= 64 ? asked : null;
    answer = buildMessage('RECONNECT_ACK', { accept: false, code: 'unknown_player', entries: [], logHash: ZERO_HASH, logLength: 0 }, { matchId, seq: Math.max(seq, Date.now()), from });
  }
  // A version that is not a whole number is nobody's: the answer stays in ours.
  return JSON.stringify({ ...answer, v: foreignVersionOf(text) ?? PROTOCOL_VERSION });
}

/** Answer a foreign-version HELLO or RECONNECT and close. True when it answered. */
function refuseForeignVersion(socket: WebSocket, text: string, from: PlayerId, seq: number): boolean {
  const refuse = foreignVersionRefusal(text, from, seq);
  if (!refuse) return false;
  socket.send(refuse, () => socket.close());
  return true;
}

export interface WsHostOptions {
  localId: PlayerId;
  /** 0 picks an ephemeral port; read it back from `listen()`. */
  port: number;
  host?: string;
}

export class WsHostTransport implements Transport {
  readonly localId: PlayerId;
  private server: WebSocketServer | null = null;
  private readonly sockets = new Map<PlayerId, WebSocket>();
  private readonly messageHandlers = new Set<MessageHandler>();
  private readonly joinHandlers = new Set<PeerHandler>();
  private readonly leaveHandlers = new Set<PeerHandler>();
  private readonly errorHandlers = new Set<ErrorHandler>();
  private seqForRefuse = 0;

  constructor(private readonly opts: WsHostOptions) {
    this.localId = opts.localId;
  }

  /** Start listening; resolves with the bound port. */
  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = new WebSocketServer({ port: this.opts.port, host: this.opts.host ?? '127.0.0.1' });
      this.server = server;
      server.once('error', reject);
      server.on('listening', () => {
        const addr = server.address();
        resolve(typeof addr === 'object' && addr ? addr.port : this.opts.port);
      });
      server.on('connection', (socket) => this.attach(socket));
    });
  }

  private attach(socket: WebSocket): void {
    let peer: PlayerId | null = null;
    socket.on('message', (data: RawData) => {
      const text = rawToString(data);
      let msg: AnyMessage;
      try {
        msg = decodeFrame(text);
      } catch (e) {
        this.refuseForeignVersion(socket, text);
        this.fail(e, peer);
        return;
      }
      if (peer === null) {
        if (msg.type !== 'HELLO') {
          this.fail(new Error(`first frame from a new socket was ${msg.type}, not HELLO`), null);
          socket.close();
          return;
        }
        peer = msg.from;
        const previous = this.sockets.get(peer);
        if (previous && previous !== socket) previous.close();
        this.sockets.set(peer, socket);
        for (const cb of [...this.joinHandlers]) cb(peer);
      }
      for (const cb of [...this.messageHandlers]) cb(peer, msg);
    });
    socket.on('close', () => {
      if (peer === null) return;
      if (this.sockets.get(peer) === socket) {
        this.sockets.delete(peer);
        for (const cb of [...this.leaveHandlers]) cb(peer);
      }
    });
    socket.on('error', (err) => this.fail(err, peer));
  }

  private refuseForeignVersion(socket: WebSocket, text: string): void {
    if (refuseForeignVersion(socket, text, this.localId, this.seqForRefuse + 1)) this.seqForRefuse += 1;
  }

  private fail(e: unknown, peer: PlayerId | null): void {
    const err = e instanceof Error ? e : new Error(String(e));
    for (const cb of [...this.errorHandlers]) cb(err, peer);
  }

  send(to: PlayerId | 'all', msg: AnyMessage): void {
    const frame = encodeFrame(msg);
    const targets = to === 'all' ? [...this.sockets.values()] : [this.sockets.get(to)];
    for (const s of targets) {
      if (s && s.readyState === WebSocket.OPEN) s.send(frame);
    }
  }

  onMessage(cb: MessageHandler): () => void {
    this.messageHandlers.add(cb);
    return () => this.messageHandlers.delete(cb);
  }

  onPeerJoin(cb: PeerHandler): () => void {
    this.joinHandlers.add(cb);
    return () => this.joinHandlers.delete(cb);
  }

  onPeerLeave(cb: PeerHandler): () => void {
    this.leaveHandlers.add(cb);
    return () => this.leaveHandlers.delete(cb);
  }

  onError(cb: ErrorHandler): () => void {
    this.errorHandlers.add(cb);
    return () => this.errorHandlers.delete(cb);
  }

  closePeer(peer: PlayerId): void {
    const s = this.sockets.get(peer);
    if (!s) return;
    this.sockets.delete(peer);
    s.close();
  }

  peers(): PlayerId[] {
    return [...this.sockets.keys()];
  }

  close(): void {
    for (const s of this.sockets.values()) s.terminate();
    this.sockets.clear();
    this.server?.close();
    this.server = null;
  }
}

export interface WsClientOptions {
  localId: PlayerId;
  url: string;
}

export class WsClientTransport implements Transport {
  readonly localId: PlayerId;
  private socket: WebSocket | null = null;
  /** The host's player id, learned from the first frame it sends (HELLO_ACK or REFUSE). */
  private peer: PlayerId | null = null;
  private readonly messageHandlers = new Set<MessageHandler>();
  private readonly joinHandlers = new Set<PeerHandler>();
  private readonly leaveHandlers = new Set<PeerHandler>();
  private readonly errorHandlers = new Set<ErrorHandler>();

  constructor(private readonly opts: WsClientOptions) {
    this.localId = opts.localId;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.opts.url);
      this.socket = socket;
      socket.once('error', reject);
      socket.once('open', () => {
        socket.on('error', (err) => this.fail(err));
        resolve();
      });
      socket.on('message', (data: RawData) => {
        const text = rawToString(data);
        let msg: AnyMessage;
        try {
          msg = decodeFrame(text);
        } catch (e) {
          this.fail(undecodable(text, e));
          return;
        }
        if (this.peer === null) {
          this.peer = msg.from;
          for (const cb of [...this.joinHandlers]) cb(msg.from);
        }
        for (const cb of [...this.messageHandlers]) cb(this.peer, msg);
      });
      socket.on('close', () => {
        const peer = this.peer;
        if (peer !== null) for (const cb of [...this.leaveHandlers]) cb(peer);
      });
    });
  }

  private fail(e: unknown): void {
    const err = e instanceof Error ? e : new Error(String(e));
    for (const cb of [...this.errorHandlers]) cb(err, this.peer);
  }

  /** Everything goes to the host; `to` is informational on this transport. */
  send(_to: PlayerId | 'all', msg: AnyMessage): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) this.socket.send(encodeFrame(msg));
  }

  onMessage(cb: MessageHandler): () => void {
    this.messageHandlers.add(cb);
    return () => this.messageHandlers.delete(cb);
  }

  onPeerJoin(cb: PeerHandler): () => void {
    this.joinHandlers.add(cb);
    return () => this.joinHandlers.delete(cb);
  }

  onPeerLeave(cb: PeerHandler): () => void {
    this.leaveHandlers.add(cb);
    return () => this.leaveHandlers.delete(cb);
  }

  onError(cb: ErrorHandler): () => void {
    this.errorHandlers.add(cb);
    return () => this.errorHandlers.delete(cb);
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
  }
}

export interface WsPeerOptions {
  localId: PlayerId;
}

interface PeerLink {
  socket: WebSocket;
  dir: 'in' | 'out';
  /** Learned from the first frame when not known up front. */
  peer: PlayerId | null;
  /** False until the opening frame went out (connectTo) or came in (inbound): no other frame may use the link before. */
  ready: boolean;
  /** Closing this link is deliberate (a move to a new host, a refusal): never reported as a leave. */
  silent: boolean;
}

/**
 * One participant over WebSocket in either role (A2, 2026-10-30). `listen()` opens the listener a
 * host (or a host-to-be) serves; `connect()` opens the first link to a host; `connectTo()` opens a
 * link to a known peer with a fixed opening frame (RECONNECT). Several links to one peer may exist
 * while a match moves between hosts: frames go on the newest, and a leave is reported only when the
 * last one closes and it was not closed on purpose.
 */
export class WsPeerTransport implements Transport {
  readonly localId: PlayerId;
  readonly topology = 'star' as const;
  private server: WebSocketServer | null = null;
  private listenEndpoint: string | null = null;
  private links: PeerLink[] = [];
  /** Where each peer we connected out to was reached, for a later reconnect. */
  private readonly endpoints = new Map<PlayerId, string>();
  private readonly messageHandlers = new Set<MessageHandler>();
  private readonly joinHandlers = new Set<PeerHandler>();
  private readonly leaveHandlers = new Set<PeerHandler>();
  private readonly errorHandlers = new Set<ErrorHandler>();
  private seqForRefuse = 0;

  constructor(opts: WsPeerOptions) {
    this.localId = opts.localId;
  }

  /** This participant's listener once `listen()` resolved: what goes in HOST_TRANSFER.newHostEndpoint. */
  get endpoint(): string | null {
    return this.listenEndpoint;
  }

  /** Start the listener; resolves with its `ws://` endpoint. Port 0 picks an ephemeral one. */
  listen(port = 0, host = '127.0.0.1'): Promise<string> {
    return new Promise((resolve, reject) => {
      const server = new WebSocketServer({ port, host });
      this.server = server;
      server.once('error', reject);
      server.on('listening', () => {
        const addr = server.address();
        this.listenEndpoint = `ws://${host}:${typeof addr === 'object' && addr ? addr.port : port}`;
        resolve(this.listenEndpoint);
      });
      server.on('connection', (socket) => this.attachInbound(socket));
    });
  }

  /** The first link to a host whose id is learned from its first frame (HELLO_ACK or REFUSE). */
  connect(url: string): Promise<void> {
    return this.open(url, null, null);
  }

  connectTo(peer: PlayerId, first: () => AnyMessage, opts: { endpoint?: string; replacing?: PlayerId } = {}): Promise<void> {
    const url = opts.endpoint ?? this.endpoints.get(peer);
    if (!url) return Promise.reject(new Error(`no endpoint known for ${peer}`));
    if (opts.replacing !== undefined) for (const l of this.links) if (l.peer === opts.replacing) l.silent = true;
    return this.open(url, peer, first);
  }

  private open(url: string, peer: PlayerId | null, first: (() => AnyMessage) | null): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      // A link to a not-yet-known host is usable at once: HELLO goes out on it through send('all').
      const link: PeerLink = { socket, dir: 'out', peer, ready: first === null, silent: false };
      this.links.push(link);
      socket.once('error', reject);
      socket.once('open', () => {
        socket.on('error', (err) => this.fail(err, link.peer));
        if (peer !== null) this.endpoints.set(peer, url);
        if (first) {
          socket.send(encodeFrame(first()));
          link.ready = true;
        }
        if (link.peer !== null) this.noteJoin(link);
        resolve();
      });
      socket.on('message', (data: RawData) => {
        const text = rawToString(data);
        let msg: AnyMessage;
        try {
          msg = decodeFrame(text);
        } catch (e) {
          this.fail(undecodable(text, e), link.peer);
          return;
        }
        if (link.peer === null) {
          link.peer = msg.from;
          this.endpoints.set(msg.from, url);
          this.noteJoin(link);
        }
        this.dispatch(link.peer, msg);
      });
      socket.on('close', () => this.onLinkClosed(link));
    });
  }

  private attachInbound(socket: WebSocket): void {
    const link: PeerLink = { socket, dir: 'in', peer: null, ready: false, silent: false };
    this.links.push(link);
    socket.on('message', (data: RawData) => {
      const text = rawToString(data);
      let msg: AnyMessage;
      try {
        msg = decodeFrame(text);
      } catch (e) {
        if (link.peer === null && refuseForeignVersion(socket, text, this.localId, this.seqForRefuse + 1)) this.seqForRefuse += 1;
        this.fail(e, link.peer);
        return;
      }
      if (link.peer === null) {
        if (msg.type !== 'HELLO' && msg.type !== 'RECONNECT') {
          this.fail(new Error(`first frame from a new socket was ${msg.type}, not HELLO or RECONNECT`), null);
          socket.close();
          return;
        }
        link.peer = msg.from;
        link.ready = true;
        this.noteJoin(link);
      }
      this.dispatch(link.peer, msg);
    });
    socket.on('close', () => this.onLinkClosed(link));
    socket.on('error', (err) => this.fail(err, link.peer));
  }

  private dispatch(peer: PlayerId, msg: AnyMessage): void {
    for (const cb of [...this.messageHandlers]) cb(peer, msg);
  }

  private noteJoin(link: PeerLink): void {
    const peer = link.peer;
    if (peer === null) return;
    if (this.links.some((l) => l !== link && l.peer === peer && l.ready)) return;
    for (const cb of [...this.joinHandlers]) cb(peer);
  }

  private onLinkClosed(link: PeerLink): void {
    this.links = this.links.filter((l) => l !== link);
    const peer = link.peer;
    if (link.silent || !link.ready || peer === null) return;
    if (this.links.some((l) => l.peer === peer && l.ready)) return;
    for (const cb of [...this.leaveHandlers]) cb(peer);
  }

  private fail(e: unknown, peer: PlayerId | null): void {
    const err = e instanceof Error ? e : new Error(String(e));
    for (const cb of [...this.errorHandlers]) cb(err, peer);
  }

  /** `to: 'all'` reaches every peer once, on its newest link; a named peer gets its newest link. */
  send(to: PlayerId | 'all', msg: AnyMessage): void {
    const open = this.links.filter((l) => l.ready && l.socket.readyState === WebSocket.OPEN);
    let targets: PeerLink[];
    if (to === 'all') {
      const byPeer = new Map<PlayerId, PeerLink>();
      const unknown: PeerLink[] = [];
      for (const l of open) {
        if (l.peer === null) unknown.push(l);
        else byPeer.set(l.peer, l);
      }
      targets = [...byPeer.values(), ...unknown];
    } else {
      const newest = open.filter((l) => l.peer === to).pop();
      targets = newest ? [newest] : [];
    }
    const frame = encodeFrame(msg);
    for (const l of targets) l.socket.send(frame);
  }

  onMessage(cb: MessageHandler): () => void {
    this.messageHandlers.add(cb);
    return () => this.messageHandlers.delete(cb);
  }

  onPeerJoin(cb: PeerHandler): () => void {
    this.joinHandlers.add(cb);
    return () => this.joinHandlers.delete(cb);
  }

  onPeerLeave(cb: PeerHandler): () => void {
    this.leaveHandlers.add(cb);
    return () => this.leaveHandlers.delete(cb);
  }

  onError(cb: ErrorHandler): () => void {
    this.errorHandlers.add(cb);
    return () => this.errorHandlers.delete(cb);
  }

  /** Close every link to `peer` on purpose (after REFUSE or a rejected RECONNECT): no leave. */
  closePeer(peer: PlayerId): void {
    for (const l of this.links) {
      if (l.peer !== peer) continue;
      l.silent = true;
      l.socket.close();
    }
  }

  closeListener(): void {
    for (const l of this.links) {
      if (l.dir !== 'in') continue;
      l.silent = true;
      l.socket.close();
    }
    this.server?.close();
    this.server = null;
    this.listenEndpoint = null;
  }

  /** Simulate a network drop: kill every link to `peer` (or every link); both ends see a leave. */
  dropLinks(peer?: PlayerId): void {
    for (const l of this.links) if (peer === undefined || l.peer === peer) l.socket.terminate();
  }

  /** Peers with at least one usable link. */
  peers(): PlayerId[] {
    return [...new Set(this.links.filter((l) => l.ready && l.peer !== null).map((l) => l.peer as PlayerId))];
  }

  /** Peers linked in through the listener, for tests and diagnostics. */
  inboundPeers(): PlayerId[] {
    return this.links.filter((l) => l.dir === 'in' && l.peer !== null).map((l) => l.peer as PlayerId);
  }

  close(): void {
    for (const l of this.links) {
      l.silent = true;
      l.socket.terminate();
    }
    this.links = [];
    this.server?.close();
    this.server = null;
    this.listenEndpoint = null;
  }
}
