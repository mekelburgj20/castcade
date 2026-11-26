/**
 * The Transport interface the match engine speaks through, plus `MemoryBus`: a full-mesh
 * in-memory transport for N participants with deterministic FIFO delivery, optional latency,
 * and `disconnect()` to simulate a dropped peer. The engine never touches sockets directly.
 */
import type { AnyMessage, PlayerId } from '@castcade/protocol';

/**
 * 2026-11-25: a link whose first frame has not been judged yet. A link belongs to a player only once the engine has
 * accepted that link's first frame (a HELLO taken into the lobby, a RECONNECT that verified). Until then the link is a
 * candidate: the transport hands its first frame to the message handlers together with this object, reads nothing
 * more from it, sends it nothing but what is sent through `send`, and leaves the link the named player already has,
 * if any, exactly as it is. Every transport with per-peer links makes its candidates with `openCandidate`, so the
 * rule is one piece of code.
 */
export interface LinkCandidate {
  /** The player the first frame names. A claim and nothing more until `accept`. */
  readonly player: PlayerId;
  /** `open` until a verdict; `refused` also when no verdict came in time, or the link closed by itself. */
  readonly state: 'open' | 'accepted' | 'refused';
  /** One frame to this link only (the answer to its first frame). Nothing is sent once a verdict is in. */
  send(msg: AnyMessage): void;
  /**
   * The first frame is taken: from here on this link is `player`'s, in place of the one that player had. False, with
   * nothing done, when the candidate is no longer open.
   */
  accept(): boolean;
  /** The first frame is not taken: `answer`, when given, goes to this link, which is then closed. It was never anybody's. */
  refuse(answer?: AnyMessage): void;
}

/**
 * `candidate` is given with the first frame of a link that is nobody's yet (`from` is then the player that frame
 * names); every other frame comes from a link that is `from`'s.
 */
export type MessageHandler = (from: PlayerId, msg: AnyMessage, candidate?: LinkCandidate) => void;
export type PeerHandler = (peer: PlayerId) => void;

/** How long a candidate may wait for its verdict before the transport closes it. */
export const CANDIDATE_VERDICT_MS = 10_000;
/** The same thing is reported (to `onError`, which the shell writes to its log) at most once in this long per connection. */
export const REPORT_GAP_MS = 10_000;

/** What a transport gives `openCandidate`: how to reach the link, how to make it the player's, how to close it. */
export interface CandidateLink {
  send(msg: AnyMessage): void;
  bind(): void;
  close(): void;
  /**
   * The candidate was refused, by the engine or because no verdict came in time: `code` is the code of the answer it
   * was sent, or says that there was none. For the transport's one line in the log; not called when the link went
   * away by itself (`gone`).
   */
  refused?(code: string): void;
}

/** A candidate as the transport that made it holds it. */
export interface OpenedCandidate extends LinkCandidate {
  /**
   * The link went away by itself (its socket closed, its relay peer left, the room is gone): no verdict can bind it
   * any more. Nothing is sent and nothing is reported.
   */
  gone(): void;
}

/** The word a refusal is known by: the code of the answer, or that there was none. */
function refusalCode(answer: AnyMessage | undefined): string {
  if (answer === undefined) return 'no answer';
  if (answer.type === 'REFUSE' || answer.type === 'REJECT') return answer.payload.code;
  if (answer.type === 'RECONNECT_ACK') return answer.payload.code ?? 'not accepted';
  return answer.type;
}

/**
 * 2026-11-25: the one place a candidate's verdict is kept. `accept` binds, `refuse` answers and closes, and a
 * candidate nobody judged within `verdictMs` is closed: an engine cannot leave a link half-open by forgetting it.
 * The first verdict stands; whatever is asked of the candidate after it does nothing.
 */
export function openCandidate(player: PlayerId, link: CandidateLink, verdictMs: number = CANDIDATE_VERDICT_MS): OpenedCandidate {
  let state: LinkCandidate['state'] = 'open';
  const timer = setTimeout(() => {
    if (state !== 'open') return;
    state = 'refused';
    link.refused?.('no verdict in time');
    link.close();
  }, verdictMs);
  // A candidate waiting for its verdict never keeps the process alive.
  (timer as { unref?: () => void }).unref?.();
  return {
    player,
    get state() {
      return state;
    },
    send(msg) {
      if (state === 'open') link.send(msg);
    },
    accept() {
      if (state !== 'open') return false;
      clearTimeout(timer);
      state = 'accepted';
      link.bind();
      return true;
    },
    refuse(answer) {
      if (state !== 'open') return;
      clearTimeout(timer);
      state = 'refused';
      if (answer !== undefined) link.send(answer);
      link.refused?.(refusalCode(answer));
      link.close();
    },
    gone() {
      if (state !== 'open') return;
      clearTimeout(timer);
      state = 'refused';
      link.close();
    },
  };
}

/**
 * 2026-11-25: the time a connection has to bring a first frame to a verdict, counted from the moment it connected
 * (not from its first frame: a connection that says nothing is closed too). `spoke()`: the first frame is here; it
 * returns what is left of the time, for `openCandidate`. `stop()`: the connection is gone.
 */
export function verdictClock(silent: () => void, verdictMs: number = CANDIDATE_VERDICT_MS): { spoke(): number; stop(): void } {
  const until = Date.now() + verdictMs;
  let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    timer = null;
    silent();
  }, verdictMs);
  (timer as { unref?: () => void }).unref?.();
  const stop = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  return {
    spoke() {
      stop();
      return Math.max(1, until - Date.now());
    },
    stop,
  };
}

/**
 * 2026-11-25: at most one report per `gapMs`. `pass()` is null while one was made less than that long ago (the event
 * is counted), and otherwise the number of events this report stands for: itself and those held back since the last.
 */
export class ReportGate {
  private at = -Infinity;
  private held = 0;

  constructor(private readonly gapMs: number = REPORT_GAP_MS) {}

  pass(): number | null {
    const now = Date.now();
    if (now - this.at < this.gapMs) {
      this.held += 1;
      return null;
    }
    this.at = now;
    const n = this.held + 1;
    this.held = 0;
    return n;
  }
}

/** What a transport reports for an opening frame that was refused: its type, the player id it gave, the refusal's code. */
export function refusedOpening(type: string, player: PlayerId, code: string, times: number): Error {
  return new Error(`an opening frame was refused (${type} for ${player}: ${code})${times > 1 ? `; ${times} since the last line` : ''}`);
}

/** What a transport reports for frames that did not decode: the first as it is, later ones as a count with the last one's reason. */
export function undecodedFrames(e: unknown, times: number): Error {
  const err = e instanceof Error ? e : new Error(String(e));
  return times > 1 ? new Error(`${times} frames that did not decode (the last: ${err.message.slice(0, 160)})`) : err;
}

export interface Transport {
  readonly localId: PlayerId;
  /** `to: 'all'` delivers to every connected peer except the sender. */
  send(to: PlayerId | 'all', msg: AnyMessage): void;
  /**
   * `from` is the link peer that delivered the frame; `msg.from` is the original sender. The first frame of a link
   * that is nobody's yet comes with a `LinkCandidate` (2026-11-25), on the transports that have per-peer links.
   */
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
