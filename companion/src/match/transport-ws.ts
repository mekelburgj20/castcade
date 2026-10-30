/**
 * WebSocket transports: `WsHostTransport` (one `ws` server, one socket per client, socket ->
 * playerId learned from the first HELLO) and `WsClientTransport` (one socket to the host), the
 * fixed-role pair from Phase 1; and `WsPeerTransport` (A2, 2026-10-30), one participant that can
 * hold either role and change it mid-match: an optional listener plus outbound links, so a client
 * can become host, the old host can become its client, and a dropped client can reconnect.
 * Frames are `encodeFrame`/`decodeFrame`; undecodable frames are dropped and reported through
 * `onError`. A HELLO with a foreign protocol version is answered with REFUSE(protocol_version)
 * here, because such a frame never parses into a typed message.
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

/** A HELLO whose `v` differs never decodes; answer it per SPEC and close. True when it answered. */
function refuseForeignVersion(socket: WebSocket, text: string, from: PlayerId, seq: number): boolean {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return false;
  }
  if (typeof value !== 'object' || value === null) return false;
  const v = (value as { v?: unknown }).v;
  const type = (value as { type?: unknown }).type;
  if (type !== 'HELLO' || v === PROTOCOL_VERSION) return false;
  const refuse = buildMessage(
    'REFUSE',
    { code: 'protocol_version', message: `host speaks protocol ${PROTOCOL_VERSION}, client sent ${String(v)}` },
    { matchId: null, seq, from },
  );
  socket.send(encodeFrame(refuse), () => socket.close());
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
        let msg: AnyMessage;
        try {
          msg = decodeFrame(rawToString(data));
        } catch (e) {
          this.fail(e);
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
        let msg: AnyMessage;
        try {
          msg = decodeFrame(rawToString(data));
        } catch (e) {
          this.fail(e, link.peer);
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
