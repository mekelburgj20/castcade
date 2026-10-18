/**
 * WebSocket transports: `WsHostTransport` (one `ws` server, one socket per client, socket ->
 * playerId learned from the first HELLO) and `WsClientTransport` (one socket to the host).
 * Frames are `encodeFrame`/`decodeFrame`; undecodable frames are dropped and reported through
 * `onError`. A HELLO with a foreign protocol version is answered with REFUSE(protocol_version)
 * here, because such a frame never parses into a typed message. Host transfer over WebSocket
 * (clients reconnecting to a new host) is out of scope for Phase 1.
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

  /** A HELLO whose `v` differs never decodes; answer it per SPEC and close. */
  private refuseForeignVersion(socket: WebSocket, text: string): void {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof value !== 'object' || value === null) return;
    const v = (value as { v?: unknown }).v;
    const type = (value as { type?: unknown }).type;
    if (type !== 'HELLO' || v === PROTOCOL_VERSION) return;
    const refuse = buildMessage(
      'REFUSE',
      { code: 'protocol_version', message: `host speaks protocol ${PROTOCOL_VERSION}, client sent ${String(v)}` },
      { matchId: null, seq: ++this.seqForRefuse, from: this.localId },
    );
    socket.send(encodeFrame(refuse), () => socket.close());
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
