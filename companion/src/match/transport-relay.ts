/**
 * D10.8 (2026-11-12): match control through ArcAid, so a host needs no port forward. `RelayHostTransport` owns a relay
 * room named by the invite code; `RelayClientTransport` joins it. Both speak socket.io v4 to the ArcAid server and
 * carry exactly the text frames the WebSocket transports send (`encodeFrame` / `decodeFrame`); the server neither
 * reads nor stores them. `CompositeTransport` lets a host serve the relay room and its WebSocket listener at once.
 *
 * The contract (docs/design/alpha-match.md §3a, docs/arcaid-side-changes.md §4):
 *   connect   auth { deviceId, deviceToken }                      (a paired Witness device)
 *   host      emit match:host { code }      ack { ok: true } | { ok: false, error }
 *   client    emit match:join { code }      ack { ok: true, peer } | { ok: false, error }
 *   server    -> host    match:peer  { peer, state: 'joined' | 'left' }
 *   client    -> server  match:relay { data }          delivered to the host as   match:relay { from: peer, data }
 *   host      -> server  match:relay { to: peer, data } delivered to that client as match:relay { data }
 *   server    -> client  match:closed { reason }       (the host socket gone for more than 30 s)
 *   limits    256 KB per message, 200 messages per 10 s per socket, 8 sockets per room, 12 h per room
 *
 * A link here behaves like a socket of `WsPeerTransport`:
 * - host: a relay peer becomes a link with its first frame, which must be HELLO or RECONNECT (`match:peer joined` is
 *   not needed and not relied on); `match:peer left` closes it (a leave).
 * - client: the host's id is learned from its first frame; the link closes (a leave) when this socket drops, on
 *   `match:closed`, and when the host says so (below). `connectTo` re-joins the room if the socket changed and sends
 *   RECONNECT as the opening frame, so the engine resumes from the log head as it does over WebSocket.
 * - a dropped socket.io connection closes every link on that side. socket.io reconnects by itself; the host then
 *   emits `match:host` again with the same code.
 *
 * One thing the contract does not give a client: word that the host's socket dropped and came back (frames sent in
 * between are lost, so the client must RECONNECT). The host therefore sends `RELINK`, a transport-private string that
 * is not a protocol frame, in `data`: to every peer it had before the drop once it is registered again, and to any
 * peer whose frame arrives on no link. The server relays it like any other string.
 *
 * The 200-per-10-s limit counts every `match:relay` this socket emits, and a host's `send('all')` is one emit per
 * client, so a host that is the player up (STATE at 10 Hz) reaches it with three clients. `RelayPacer` keeps this side
 * under the limit: STATE and DMD_FRAME (latest wins, never logged) are shed first, everything else waits in order.
 */
import { io, type Socket } from 'socket.io-client';
import { decodeFrame, encodeFrame, type AnyMessage, type PlayerId } from '@castcade/protocol';
import type { MessageHandler, PeerHandler, Transport } from './transport.js';
import { foreignVersionRefusal, type ErrorHandler } from './transport-ws.js';

/** Host -> client, in `data`: "your link to me is gone; open it again with RECONNECT". Never a protocol frame. */
export const RELINK = 'castcade-relay:relink';
/** The server's cap on one `data` string, in bytes (UTF-8). */
export const RELAY_MAX_BYTES = 256 * 1024;
/** The server's rate limit: messages per window per socket. */
export const RELAY_RATE = { limit: 200, windowMs: 10_000 } as const;

export type RelayErrorCode =
  /** No connection to ArcAid (network, DNS, the server down, or a server without the relay: no ack). */
  | 'unreachable'
  /** ArcAid refused the device credentials (handshake or ack). */
  | 'unauthorized'
  | 'no_such_match'
  | 'full'
  | 'rate_limited'
  /** `match:host` refused: the code is in use. */
  | 'code_in_use'
  /** `match:closed`: the host has been gone too long. */
  | 'closed'
  /** Any other `error` string the server sent. */
  | 'refused';

export class RelayError extends Error {
  constructor(
    readonly code: RelayErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RelayError';
  }
}

export interface RelayOptions {
  localId: PlayerId;
  /** The ArcAid base URL (the `arcaidBaseUrl` setting). A path in it becomes the socket.io path prefix. */
  baseUrl: string;
  auth: { deviceId: string; deviceToken: string };
  /** How long `connect` / `connectTo` wait for the socket. Default 5 s. */
  connectTimeoutMs?: number;
  /** How long a `match:host` / `match:join` ack may take. Default 4 s (a server without the relay never acks). */
  ackTimeoutMs?: number;
  /** Test seam: the pacer's budget. Default: 180 per 10 s, the last 60 kept for frames that must arrive. */
  pace?: Partial<PacerOptions>;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_ACK_TIMEOUT_MS = 4_000;
/** After a reconnect, `match:host` is tried again this often until it is accepted. */
const REHOST_RETRY_MS = 3_000;
/** A second RELINK to the same peer waits this long (its frames keep arriving until it acts on the first). */
const RELINK_GAP_MS = 2_000;

// ------------------------------------------------------------------------------------------ pacer --

export interface PacerOptions {
  /** Emits allowed per window on this side (below the server's 200, for clock skew and what it may count besides). */
  limit: number;
  windowMs: number;
  /** Sheddable frames are dropped once fewer than this many emits are left in the window. */
  reserve: number;
  now: () => number;
}

const DEFAULT_PACE: PacerOptions = { limit: 180, windowMs: RELAY_RATE.windowMs, reserve: 60, now: () => Date.now() };

/** Frames that may be dropped under rate pressure: the next one replaces them and the match log never holds them. */
const SHEDDABLE: ReadonlySet<string> = new Set(['STATE', 'DMD_FRAME']);

/**
 * Keeps one socket under the relay's rate limit. `send` emits at once while the window has room; a sheddable item is
 * dropped when the room left is inside the reserve; anything else queues in order and goes out as the window frees.
 */
export class RelayPacer<T> {
  private readonly o: PacerOptions;
  private stamps: number[] = [];
  private queue: T[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Sheddable items dropped since the start, for the log and the tests. */
  shed = 0;

  constructor(
    private readonly emit: (item: T) => void,
    opts: Partial<PacerOptions> = {},
  ) {
    this.o = { ...DEFAULT_PACE, ...opts };
  }

  private used(): number {
    const cutoff = this.o.now() - this.o.windowMs;
    while (this.stamps.length > 0 && (this.stamps[0] as number) <= cutoff) this.stamps.shift();
    return this.stamps.length;
  }

  send(item: T, sheddable: boolean): void {
    const used = this.used();
    if (sheddable && (this.queue.length > 0 || used >= this.o.limit - this.o.reserve)) {
      this.shed += 1;
      return;
    }
    if (this.queue.length === 0 && used < this.o.limit) {
      this.stamps.push(this.o.now());
      this.emit(item);
      return;
    }
    this.queue.push(item);
    this.schedule();
  }

  private schedule(): void {
    if (this.timer || this.queue.length === 0) return;
    const oldest = this.stamps[0];
    const wait = oldest === undefined ? 0 : Math.max(1, oldest + this.o.windowMs - this.o.now() + 1);
    this.timer = setTimeout(() => {
      this.timer = null;
      while (this.queue.length > 0 && this.used() < this.o.limit) {
        this.stamps.push(this.o.now());
        this.emit(this.queue.shift() as T);
      }
      this.schedule();
    }, wait);
  }

  /** Frames waiting for room. */
  get waiting(): number {
    return this.queue.length;
  }

  /** Forget what is queued (the links it was for are gone). The window's history stays: the server's does too. */
  clear(): void {
    this.queue = [];
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

// ------------------------------------------------------------------------------------------- base --

const seconds = (ms: number): number => Math.round(ms / 100) / 10;

type Ack = { ok: true; peer?: unknown } | { ok: false; error?: unknown };

function errorFromAck(event: 'match:host' | 'match:join', code: string, error: unknown): RelayError {
  const e = typeof error === 'string' ? error : 'refused';
  if (e === 'no_such_match') return new RelayError('no_such_match', `no match with the code ${code}`);
  if (e === 'full') return new RelayError('full', `the match ${code} is full`);
  if (e === 'unauthorized') return new RelayError('unauthorized', 'ArcAid did not accept this device');
  if (e === 'rate_limited') return new RelayError('rate_limited', 'ArcAid is rate limiting this device');
  if (event === 'match:host' && /in.?use|exists|taken/i.test(e)) return new RelayError('code_in_use', `the code ${code} is in use`);
  return new RelayError('refused', `ArcAid refused ${event}: ${e.slice(0, 200)}`);
}

/** socket.io's own URL for a base URL: the origin, with a path in the base as the prefix of `/socket.io`. */
export function relayEndpoint(baseUrl: string): { origin: string; path: string } {
  const u = new URL(baseUrl);
  const prefix = u.pathname.replace(/\/+$/, '');
  return { origin: u.origin, path: `${prefix}/socket.io` };
}

abstract class RelayBase {
  readonly localId: PlayerId;
  readonly topology = 'star' as const;
  protected socket: Socket | null = null;
  protected closed = false;
  protected readonly connectTimeoutMs: number;
  protected readonly ackTimeoutMs: number;
  protected readonly messageHandlers = new Set<MessageHandler>();
  protected readonly joinHandlers = new Set<PeerHandler>();
  protected readonly leaveHandlers = new Set<PeerHandler>();
  protected readonly errorHandlers = new Set<ErrorHandler>();
  /** The handshake was refused by the server (bad credentials): socket.io does not retry that. */
  private refusal: RelayError | null = null;

  constructor(protected readonly opts: RelayOptions) {
    this.localId = opts.localId;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.ackTimeoutMs = opts.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;
  }

  protected abstract onSocketUp(socket: Socket): void;
  protected abstract onSocketDown(reason: string): void;
  protected abstract wire(socket: Socket): void;

  /** The socket, created on first use. Events are wired once; socket.io reconnects it by itself. */
  protected ensureSocket(): Socket {
    if (this.socket) return this.socket;
    const { origin, path } = relayEndpoint(this.opts.baseUrl);
    const socket = io(origin, {
      path,
      auth: { deviceId: this.opts.auth.deviceId, deviceToken: this.opts.auth.deviceToken },
      // WebSocket first (one ordered stream, no sticky-session need); long polling only where WebSocket cannot open.
      transports: ['websocket', 'polling'],
      forceNew: true,
      autoConnect: false,
      reconnection: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 5_000,
      timeout: this.connectTimeoutMs,
    });
    this.socket = socket;
    socket.on('connect', () => {
      this.refusal = null;
      this.onSocketUp(socket);
    });
    socket.on('disconnect', (reason) => {
      this.onSocketDown(reason);
      // The server closed it (a restart, a kick): socket.io leaves that one to us.
      if (reason === 'io server disconnect' && !this.closed) socket.connect();
    });
    socket.on('connect_error', (err) => {
      // `active` false: the server's middleware refused the handshake; nothing will retry.
      if (!socket.active) this.refusal = new RelayError('unauthorized', `ArcAid refused this device (${err.message.slice(0, 120)})`);
    });
    this.wire(socket);
    socket.connect();
    return socket;
  }

  /** Resolves once the socket is connected; rejects with `unauthorized` or, after the timeout, `unreachable`. */
  protected whenConnected(): Promise<Socket> {
    if (this.closed) return Promise.reject(new RelayError('unreachable', 'this relay transport is closed'));
    const socket = this.ensureSocket();
    if (socket.connected) return Promise.resolve(socket);
    if (!socket.active && this.refusal) {
      // A refused handshake stays refused until someone tries again (new credentials after a re-pair).
      this.refusal = null;
      socket.connect();
    }
    return new Promise<Socket>((resolve, reject) => {
      let last: string | null = null;
      const done = (fn: () => void): void => {
        clearTimeout(timer);
        socket.off('connect', onConnect);
        socket.off('connect_error', onError);
        fn();
      };
      const onConnect = (): void => done(() => resolve(socket));
      const onError = (err: Error): void => {
        last = err.message;
        if (!socket.active) done(() => reject(this.refusal ?? new RelayError('unauthorized', `ArcAid refused this device (${err.message.slice(0, 120)})`)));
      };
      const timer = setTimeout(
        () => done(() => reject(new RelayError('unreachable', `ArcAid did not answer in ${seconds(this.connectTimeoutMs)} s${last ? ` (${last.slice(0, 120)})` : ''}`))),
        this.connectTimeoutMs,
      );
      socket.on('connect', onConnect);
      socket.on('connect_error', onError);
    });
  }

  /** One `match:host` / `match:join` with its ack. No ack in time reads as a server without the relay. */
  protected request(socket: Socket, event: 'match:host' | 'match:join', code: string): Promise<Ack & { ok: true }> {
    return new Promise((resolve, reject) => {
      socket.timeout(this.ackTimeoutMs).emit(event, { code }, (err: Error | null, ack: Ack | undefined) => {
        if (err) return reject(new RelayError('unreachable', `ArcAid did not answer ${event} in ${seconds(this.ackTimeoutMs)} s`));
        if (ack && ack.ok === true) return resolve(ack);
        reject(errorFromAck(event, code, ack && ack.ok === false ? ack.error : undefined));
      });
    });
  }

  protected fail(e: unknown, peer: PlayerId | null): void {
    const err = e instanceof Error ? e : new Error(String(e));
    for (const cb of [...this.errorHandlers]) cb(err, peer);
  }

  /** The frame for `msg`, or null (reported) when it is over the relay's size cap. */
  protected frameOf(msg: AnyMessage, peer: PlayerId | null): string | null {
    const frame = encodeFrame(msg);
    const bytes = Buffer.byteLength(frame, 'utf8');
    if (bytes > RELAY_MAX_BYTES) {
      this.fail(new Error(`${msg.type} is ${bytes} bytes, over the relay's ${RELAY_MAX_BYTES}: not sent`), peer);
      return null;
    }
    return frame;
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

  protected dropSocket(): void {
    const s = this.socket;
    this.socket = null;
    if (!s) return;
    s.removeAllListeners();
    s.disconnect();
  }
}

// ------------------------------------------------------------------------------------------- host --

export type RelayHostState = 'off' | 'registered' | 'reconnecting';

interface HostLink {
  /** The server's id for the client socket. */
  relayPeer: string;
  player: PlayerId;
}

export class RelayHostTransport extends RelayBase implements Transport {
  private code: string | null = null;
  private current: RelayHostState = 'off';
  private readonly links = new Map<string, HostLink>();
  /** The newest relay peer of each player (a player that re-joined has a new one). */
  private readonly byPlayer = new Map<PlayerId, string>();
  /** Relay peers that had a link when the socket dropped: told to RELINK once the room is ours again. */
  private stale = new Set<string>();
  private readonly relinkAt = new Map<string, number>();
  private readonly stateHandlers = new Set<(s: RelayHostState) => void>();
  private rehostTimer: ReturnType<typeof setTimeout> | null = null;
  private seqForRefuse = 0;
  private readonly pacer: RelayPacer<{ to: string; data: string }>;

  constructor(opts: RelayOptions) {
    super(opts);
    this.pacer = new RelayPacer((p) => {
      if (this.socket?.connected) this.socket.emit('match:relay', p);
    }, opts.pace);
  }

  /** Open the connection to ArcAid (no room yet). Rejects with a `RelayError`. */
  async connect(): Promise<void> {
    await this.whenConnected();
  }

  /** Register the room `match:<code>` as this socket's. Rejects with a `RelayError` (`code_in_use`: pick another). */
  async host(code: string): Promise<void> {
    const socket = await this.whenConnected();
    await this.request(socket, 'match:host', code);
    this.code = code;
    this.setState('registered');
  }

  get state(): RelayHostState {
    return this.current;
  }

  onState(cb: (s: RelayHostState) => void): () => void {
    this.stateHandlers.add(cb);
    return () => this.stateHandlers.delete(cb);
  }

  /** Sheddable frames dropped to stay under the rate limit, for the log. */
  get shed(): number {
    return this.pacer.shed;
  }

  private setState(s: RelayHostState): void {
    if (this.current === s) return;
    this.current = s;
    for (const cb of [...this.stateHandlers]) cb(s);
  }

  protected wire(socket: Socket): void {
    socket.on('match:relay', (p: { from?: unknown; data?: unknown }) => {
      if (typeof p?.from !== 'string' || typeof p.data !== 'string') return;
      this.onFrame(p.from, p.data);
    });
    socket.on('match:peer', (p: { peer?: unknown; state?: unknown }) => {
      if (typeof p?.peer !== 'string' || p.state !== 'left') return;
      this.stale.delete(p.peer);
      this.closeLink(p.peer, true);
    });
  }

  protected onSocketUp(socket: Socket): void {
    // The first connection is `host()`'s to use; a later one is a reconnect: take the room back.
    if (this.code !== null && this.current === 'reconnecting') this.rehost(socket);
  }

  protected onSocketDown(): void {
    if (this.code === null) return;
    for (const peer of this.links.keys()) this.stale.add(peer);
    this.pacer.clear();
    for (const peer of [...this.links.keys()]) this.closeLink(peer, true);
    this.setState('reconnecting');
  }

  private rehost(socket: Socket): void {
    const code = this.code;
    if (code === null || this.closed) return;
    if (this.rehostTimer) clearTimeout(this.rehostTimer);
    this.rehostTimer = null;
    this.request(socket, 'match:host', code).then(
      () => {
        if (this.closed || this.socket !== socket || !socket.connected) return;
        this.setState('registered');
        // The clients that were linked lost whatever crossed while we were away: they resume with RECONNECT.
        for (const peer of this.stale) this.relink(peer);
        this.stale = new Set();
      },
      (e: unknown) => {
        if (this.closed || this.socket !== socket) return;
        this.fail(e, null);
        if (socket.connected) this.rehostTimer = setTimeout(() => this.rehost(socket), REHOST_RETRY_MS);
      },
    );
  }

  private relink(relayPeer: string): void {
    const now = Date.now();
    if (now - (this.relinkAt.get(relayPeer) ?? -Infinity) < RELINK_GAP_MS) return;
    this.relinkAt.set(relayPeer, now);
    this.pacer.send({ to: relayPeer, data: RELINK }, false);
  }

  private onFrame(relayPeer: string, text: string): void {
    let link = this.links.get(relayPeer) ?? null;
    let msg: AnyMessage;
    try {
      msg = decodeFrame(text);
    } catch (e) {
      if (!link) {
        const refuse = foreignVersionRefusal(text, this.localId, this.seqForRefuse + 1);
        if (refuse) {
          this.seqForRefuse += 1;
          this.pacer.send({ to: relayPeer, data: encodeFrame(refuse) }, false);
        }
      }
      this.fail(e, link?.player ?? null);
      return;
    }
    if (!link) {
      if (msg.type !== 'HELLO' && msg.type !== 'RECONNECT') {
        // A client that does not know its link closed (this socket dropped and came back): it must resume.
        this.relink(relayPeer);
        return;
      }
      link = { relayPeer, player: msg.from };
      this.links.set(relayPeer, link);
      const previous = this.byPlayer.get(link.player);
      this.byPlayer.set(link.player, relayPeer);
      if (previous !== undefined && previous !== relayPeer) this.links.delete(previous);
      else for (const cb of [...this.joinHandlers]) cb(link.player);
    }
    for (const cb of [...this.messageHandlers]) cb(link.player, msg);
  }

  private closeLink(relayPeer: string, report: boolean): void {
    const link = this.links.get(relayPeer);
    if (!link) return;
    this.links.delete(relayPeer);
    if (this.byPlayer.get(link.player) !== relayPeer) return;
    this.byPlayer.delete(link.player);
    if (report) for (const cb of [...this.leaveHandlers]) cb(link.player);
  }

  send(to: PlayerId | 'all', msg: AnyMessage): void {
    const targets = to === 'all' ? [...this.byPlayer.values()] : [this.byPlayer.get(to)];
    if (targets.every((t) => t === undefined)) return;
    const frame = this.frameOf(msg, to === 'all' ? null : to);
    if (frame === null) return;
    const sheddable = SHEDDABLE.has(msg.type);
    for (const t of targets) if (t !== undefined) this.pacer.send({ to: t, data: frame }, sheddable);
  }

  /** Forget `peer`'s link on purpose (after REFUSE or a rejected RECONNECT): no leave. The relay has no kick. */
  closePeer(peer: PlayerId): void {
    const relayPeer = this.byPlayer.get(peer);
    if (relayPeer !== undefined) this.closeLink(relayPeer, false);
  }

  /** Stop serving the room without reporting leaves (the old host after a transfer). */
  closeListener(): void {
    this.shutdown();
  }

  peers(): PlayerId[] {
    return [...this.byPlayer.keys()];
  }

  close(): void {
    this.shutdown();
  }

  private shutdown(): void {
    this.closed = true;
    if (this.rehostTimer) clearTimeout(this.rehostTimer);
    this.rehostTimer = null;
    this.pacer.clear();
    this.links.clear();
    this.byPlayer.clear();
    this.stale.clear();
    this.code = null;
    this.dropSocket();
    this.setState('off');
  }
}

// ----------------------------------------------------------------------------------------- client --

export class RelayClientTransport extends RelayBase implements Transport {
  private code: string | null = null;
  /** This socket is in the room (false again after every disconnect and after `match:closed`). */
  private joined = false;
  /** The host's player id, learned from its first frame or given to `connectTo`. */
  private hostId: PlayerId | null = null;
  /** A join was reported for the host and no leave since. */
  private linkUp = false;
  /** Frames may go out: after `connect`, and again once `connectTo` sent its opening frame. */
  private ready = false;
  /** The id the server gave this socket in the room, for diagnostics. */
  private relayPeer: string | null = null;
  private readonly pacer: RelayPacer<{ data: string }>;

  constructor(opts: RelayOptions) {
    super(opts);
    this.pacer = new RelayPacer((p) => {
      if (this.socket?.connected && this.joined) this.socket.emit('match:relay', p);
    }, opts.pace);
  }

  /** Connect to ArcAid and join the room of `code`. Rejects with a `RelayError`. HELLO then goes out through `send`. */
  async connect(code: string): Promise<void> {
    this.code = code.toUpperCase();
    await this.join();
    this.ready = true;
  }

  private async join(): Promise<void> {
    const code = this.code;
    if (code === null) throw new RelayError('refused', 'no match code to join');
    const socket = await this.whenConnected();
    if (this.joined) return;
    const ack = await this.request(socket, 'match:join', code);
    if (this.socket !== socket || !socket.connected) throw new RelayError('unreachable', 'the connection to ArcAid dropped while joining');
    this.joined = true;
    this.relayPeer = typeof ack.peer === 'string' ? ack.peer : null;
  }

  /** The server's id for this socket in the room, once joined. */
  get peerId(): string | null {
    return this.relayPeer;
  }

  /**
   * Resume the link to the host: join the room again if this socket is not in it, then send `first()` (RECONNECT) as
   * the opening frame. An `endpoint` is a WebSocket listener, which a relay link cannot move to (a host transfer to
   * another rig is not carried by the relay): rejected.
   */
  async connectTo(peer: PlayerId, first: () => AnyMessage, opts: { endpoint?: string; replacing?: PlayerId } = {}): Promise<void> {
    if (opts.endpoint !== undefined) throw new Error(`a match joined through ArcAid cannot move to ${opts.endpoint}`);
    this.ready = false;
    this.pacer.clear();
    await this.join();
    const frame = this.frameOf(first(), peer);
    if (frame === null) throw new Error('the opening frame is too large for the relay');
    this.pacer.send({ data: frame }, false);
    this.hostId = peer;
    this.ready = true;
    if (!this.linkUp) {
      this.linkUp = true;
      for (const cb of [...this.joinHandlers]) cb(peer);
    }
  }

  protected wire(socket: Socket): void {
    socket.on('match:relay', (p: { data?: unknown }) => {
      if (typeof p?.data !== 'string') return;
      if (p.data === RELINK) {
        this.linkDown();
        return;
      }
      let msg: AnyMessage;
      try {
        msg = decodeFrame(p.data);
      } catch (e) {
        this.fail(e, this.hostId);
        return;
      }
      if (this.hostId === null) this.hostId = msg.from;
      if (!this.linkUp) {
        this.linkUp = true;
        for (const cb of [...this.joinHandlers]) cb(this.hostId);
      }
      for (const cb of [...this.messageHandlers]) cb(this.hostId, msg);
    });
    socket.on('match:closed', (p: { reason?: unknown }) => {
      this.joined = false;
      this.fail(new RelayError('closed', `ArcAid closed the match${typeof p?.reason === 'string' ? ` (${p.reason.slice(0, 120)})` : ''}`), this.hostId);
      this.linkDown();
    });
  }

  protected onSocketUp(): void {
    /* `join` re-joins when the engine asks for the link again (connectTo). */
  }

  protected onSocketDown(): void {
    this.joined = false;
    this.relayPeer = null;
    this.linkDown();
  }

  /** The link to the host is gone: nothing more goes out until `connectTo`, and the engine sees a leave. */
  private linkDown(): void {
    this.ready = false;
    this.pacer.clear();
    if (!this.linkUp || this.hostId === null) return;
    this.linkUp = false;
    for (const cb of [...this.leaveHandlers]) cb(this.hostId);
  }

  /** Everything goes to the host; `to` is informational on this transport. */
  send(_to: PlayerId | 'all', msg: AnyMessage): void {
    if (!this.ready || !this.joined || !this.socket?.connected) return;
    const frame = this.frameOf(msg, this.hostId);
    if (frame === null) return;
    this.pacer.send({ data: frame }, SHEDDABLE.has(msg.type));
  }

  /** Sheddable frames dropped to stay under the rate limit, for the log. */
  get shed(): number {
    return this.pacer.shed;
  }

  peers(): PlayerId[] {
    return this.linkUp && this.hostId !== null ? [this.hostId] : [];
  }

  close(): void {
    this.closed = true;
    this.ready = false;
    this.joined = false;
    this.linkUp = false;
    this.pacer.clear();
    this.dropSocket();
  }
}

// -------------------------------------------------------------------------------------- composite --

type Part = Transport & { onError?(cb: ErrorHandler): () => void };

/**
 * Several star transports as one (a host on its WebSocket listener and its relay room at once). A peer belongs to the
 * part it last joined on; a leave counts only from that part; `send('all')` reaches every part; `connectTo` goes to
 * the first part that has it (the WebSocket one, for a move to another host's listener).
 */
export class CompositeTransport implements Transport {
  readonly localId: PlayerId;
  readonly topology = 'star' as const;
  private readonly where = new Map<PlayerId, Part>();
  private readonly joinHandlers = new Set<PeerHandler>();
  private readonly leaveHandlers = new Set<PeerHandler>();
  private readonly offs: (() => void)[] = [];

  constructor(private readonly parts: Part[]) {
    const first = parts[0];
    if (!first) throw new Error('CompositeTransport needs at least one transport');
    this.localId = first.localId;
    for (const part of parts) {
      this.offs.push(
        part.onPeerJoin((peer) => {
          const had = this.where.has(peer);
          this.where.set(peer, part);
          if (!had) for (const cb of [...this.joinHandlers]) cb(peer);
        }),
        part.onPeerLeave((peer) => {
          if (this.where.get(peer) !== part) return;
          this.where.delete(peer);
          for (const cb of [...this.leaveHandlers]) cb(peer);
        }),
      );
    }
  }

  send(to: PlayerId | 'all', msg: AnyMessage): void {
    if (to === 'all') {
      for (const part of this.parts) part.send('all', msg);
      return;
    }
    const part = this.where.get(to);
    if (part) part.send(to, msg);
    else for (const p of this.parts) p.send(to, msg);
  }

  onMessage(cb: MessageHandler): () => void {
    const offs = this.parts.map((p) => p.onMessage(cb));
    return () => offs.forEach((off) => off());
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
    const offs = this.parts.map((p) => p.onError?.(cb));
    return () => offs.forEach((off) => off?.());
  }

  closePeer(peer: PlayerId): void {
    for (const p of this.parts) p.closePeer?.(peer);
    this.where.delete(peer);
  }

  connectTo(peer: PlayerId, first: () => AnyMessage, opts?: { endpoint?: string; replacing?: PlayerId }): Promise<void> {
    const part = this.parts.find((p) => p.connectTo !== undefined);
    if (!part?.connectTo) return Promise.reject(new Error(`no transport can connect to ${peer}`));
    return part.connectTo(peer, first, opts);
  }

  closeListener(): void {
    for (const p of this.parts) p.closeListener?.();
  }

  close(): void {
    for (const off of this.offs.splice(0)) off();
    for (const p of this.parts) p.close();
    this.where.clear();
  }
}
