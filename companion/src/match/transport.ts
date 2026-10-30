/**
 * The Transport interface the match engine speaks through, plus `MemoryBus`: a full-mesh
 * in-memory transport for N participants with deterministic FIFO delivery, optional latency,
 * and `disconnect()` to simulate a dropped peer. The engine never touches sockets directly.
 */
import type { AnyMessage, PlayerId } from '@castcade/protocol';

export type MessageHandler = (from: PlayerId, msg: AnyMessage) => void;
export type PeerHandler = (peer: PlayerId) => void;

export interface Transport {
  readonly localId: PlayerId;
  /** `to: 'all'` delivers to every connected peer except the sender. */
  send(to: PlayerId | 'all', msg: AnyMessage): void;
  /** `from` is the link peer that delivered the frame; `msg.from` is the original sender. */
  onMessage(cb: MessageHandler): () => void;
  onPeerJoin(cb: PeerHandler): () => void;
  onPeerLeave(cb: PeerHandler): () => void;
  /** Drop one peer's link (host side: after REFUSE). Optional for transports without per-peer links. */
  closePeer?(peer: PlayerId): void;
  close(): void;
  /**
   * `star` (WebSocket): clients reach each other only through the host, so the host relays
   * HOST_TRANSFER_ACK. Absent means a full mesh (MemoryBus). A2, 2026-10-30.
   */
  readonly topology?: 'mesh' | 'star';
  /**
   * Star transports only: open a link to `peer` at `endpoint` (default: where `peer` was last
   * reached) and send `first()` as its opening frame, before any other frame can use the link.
   * `replacing` names a peer whose existing links stop counting as that peer's connection: their
   * close is not reported as a leave (the old host after a transfer). Resolves once `first` is sent.
   */
  connectTo?(peer: PlayerId, first: () => AnyMessage, opts?: { endpoint?: string; replacing?: PlayerId }): Promise<void>;
  /** Star transports only: stop listening and close every inbound link without reporting leaves (the old host). */
  closeListener?(): void;
}

interface Queued {
  run: () => void;
}

class MemoryTransport implements Transport {
  readonly messageHandlers = new Set<MessageHandler>();
  readonly joinHandlers = new Set<PeerHandler>();
  readonly leaveHandlers = new Set<PeerHandler>();
  connected = true;

  constructor(
    readonly localId: PlayerId,
    private readonly bus: MemoryBus,
  ) {}

  send(to: PlayerId | 'all', msg: AnyMessage): void {
    if (!this.connected) return;
    this.bus.route(this.localId, to, msg);
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

  closePeer(peer: PlayerId): void {
    this.bus.disconnect(peer);
  }

  close(): void {
    this.bus.disconnect(this.localId);
  }
}

export interface MemoryBusOptions {
  /** Delivery delay per message in ms. 0 (default) delivers on the microtask queue. */
  latencyMs?: number;
}

export class MemoryBus {
  private readonly peers = new Map<PlayerId, MemoryTransport>();
  private readonly queue: Queued[] = [];
  private draining = false;
  private readonly latencyMs: number;
  /** Every frame routed through the bus, for diagnostics in tests. */
  readonly trace: { from: PlayerId; to: PlayerId; type: string }[] = [];

  constructor(opts: MemoryBusOptions = {}) {
    this.latencyMs = opts.latencyMs ?? 0;
  }

  /** Create (and connect) the transport for one participant. */
  transport(id: PlayerId): Transport {
    if (this.peers.has(id)) throw new Error(`MemoryBus: ${id} already exists`);
    const t = new MemoryTransport(id, this);
    const existing = [...this.peers.values()].filter((p) => p.connected);
    this.peers.set(id, t);
    for (const other of existing) {
      this.enqueue(() => {
        if (!other.connected || !t.connected) return;
        for (const cb of [...other.joinHandlers]) cb(id);
        for (const cb of [...t.joinHandlers]) cb(other.localId);
      });
    }
    return t;
  }

  connectedPeers(): PlayerId[] {
    return [...this.peers.values()].filter((p) => p.connected).map((p) => p.localId);
  }

  isConnected(id: PlayerId): boolean {
    return this.peers.get(id)?.connected ?? false;
  }

  /** Simulate a dropped connection: `id` sends and receives nothing more; others see onPeerLeave. */
  disconnect(id: PlayerId): void {
    const t = this.peers.get(id);
    if (!t || !t.connected) return;
    t.connected = false;
    for (const other of this.peers.values()) {
      if (other === t || !other.connected) continue;
      this.enqueue(() => {
        if (!other.connected) return;
        for (const cb of [...other.leaveHandlers]) cb(id);
      });
    }
  }

  route(from: PlayerId, to: PlayerId | 'all', msg: AnyMessage): void {
    const targets = to === 'all' ? [...this.peers.values()].filter((p) => p.connected && p.localId !== from) : [this.peers.get(to)];
    for (const target of targets) {
      if (!target || !target.connected) continue;
      this.trace.push({ from, to: target.localId, type: msg.type });
      // Connectivity is checked when a frame is sent, not when it is delivered: frames already in
      // flight when either side drops still arrive (send-then-close delivers on a real socket too).
      this.enqueue(() => {
        for (const cb of [...target.messageHandlers]) cb(from, msg);
      });
    }
  }

  private enqueue(run: () => void): void {
    if (this.latencyMs > 0) {
      setTimeout(run, this.latencyMs);
      return;
    }
    this.queue.push({ run });
    if (!this.draining) {
      this.draining = true;
      queueMicrotask(() => this.drain());
    }
  }

  private drain(): void {
    // One item per microtask keeps interleaving fair between participants and lets
    // promise-based players (fakeclient) run between deliveries.
    const item = this.queue.shift();
    if (item) item.run();
    if (this.queue.length > 0) queueMicrotask(() => this.drain());
    else this.draining = false;
  }
}
