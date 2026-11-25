/**
 * D10.8 (2026-11-12): match control through ArcAid, so a host needs no port forward. `RelayHostTransport` owns a relay
 * room named by the invite code; `RelayClientTransport` joins it. Both speak socket.io v4 to the ArcAid server and
 * carry exactly the text frames the WebSocket transports send (`encodeFrame` / `decodeFrame`); the server neither
 * reads nor stores them. `CompositeTransport` lets a host serve the relay room and its WebSocket listener at once.
 *
 * The contract, as the server has it (ArcAid `src/api/matchRelay.ts`; docs/arcaid-side-changes.md §4a):
 *   connect   auth { deviceId, deviceToken } in the handshake. The server does NOT check it at connect: any socket
 *             connects, and `match:host` / `match:join` ack `unauthorized` for a device that is not paired.
 *   host      emit match:host { code }      ack { ok: true, peers } | { ok: false, error }   error: bad_code,
 *             code_in_use, rate_limited, unauthorized, server_busy. One room per device.
 *   client    emit match:join { code }      ack { ok: true, peer } | { ok: false, error }    error: no_such_match,
 *             full, locked, rate_limited, unauthorized
 *   host      emit match:lock {}            ack { ok: true }: from then on only devices that held a seat may join
 *   either    emit match:leave {}           ack { ok: true }; a host leaving closes the room
 *   server    -> host    match:peer  { peer, state: 'joined' | 'left' }
 *   client    -> server  match:relay { data }          delivered to the host as   match:relay { from: peer, data }
 *   host      -> server  match:relay { to: peer, data } delivered to that client as match:relay { data }
 *   server    -> sender  match:error { error }         rate_limited (once per window per bucket), too_large,
 *             invalid_message, no_such_peer, not_in_match: the frame was dropped. unauthorized: a socket in no room,
 *             or a seated device whose pairing was revoked (checked again at most once a minute): it loses its seat
 *             (the host sees `match:peer left`; a revoked host's room closes with `host_gone`). Final for a client.
 *   server    -> all     match:closed { reason }       host_gone (away more than 30 s), expired, host_left, replaced,
 *             server_restart; the host socket gets it too when it is there
 *   limits    256 KB per message; 200 `match:relay` per fixed 10 s window per client socket, and for the host socket
 *             per destination (`to`), each with its own bucket; 8 sockets per room; 12 h per room; eight
 *             `no_such_match` answers in ten minutes lock a device (not its address) out for fifteen
 *   also      a client frame while the host socket is away is dropped silently; `match:join` from a socket already
 *             in the room answers ok with the same `peer`; a host that registers again is told who is in the room
 *             (`peers`, and `match:peer joined` again for each)
 *
 * A link here behaves like a socket of `WsPeerTransport`:
 * - host: a relay peer becomes a link once the engine has accepted its first frame, which must be HELLO or RECONNECT
 *   (2026-11-25, `LinkCandidate` in transport.ts: until that verdict the peer is nobody's link, and the player its
 *   frame names keeps the link they have; `match:peer joined`, also the one re-sent after a host resume, is not
 *   needed: a socket in the room is not yet a player); `match:peer left` closes it (a leave).
 * - client: the host's id is learned from its first frame; the link closes (a leave) when this socket drops, on
 *   `match:closed`, and when the host says so (below). `connectTo` re-joins the room if the socket changed and sends
 *   RECONNECT as the opening frame, so the engine resumes from the log head as it does over WebSocket.
 * - a dropped socket.io connection closes every link on that side. socket.io reconnects by itself; the host then
 *   emits `match:host` again with the same code.
 * - the room is in the server's memory: an ArcAid deploy loses it, and so does `match:closed` with `expired` or
 *   `server_restart`. The host then registers the same code again (a new room) and the clients come back by the
 *   relink path; a client that asks before the host did gets `no_such_match` and asks again, a bounded number of
 *   times and further apart each time (`RejoinPolicy`: the server locks out a device that misses eight times).
 * - `match:error { no_such_peer }` does not say which peer. The host asks who is in the room (`match:host` again, which
 *   is idempotent) and closes the links of the peers that are not.
 *
 * One thing the contract does not give a client: word that the host's socket dropped and came back (frames sent in
 * between are lost, so the client must RECONNECT). The host therefore sends `RELINK`, a transport-private string that
 * is not a protocol frame, in `data`: to every peer it had before the drop once it is registered again, and to any
 * peer whose frame arrives on no link. The server relays it like any other string.
 *
 * `RelayPacer` keeps this side under the rate limit: STATE and DMD_FRAME (latest wins, never logged) are shed first,
 * everything else waits in order. A client has one pacer; the host has one per destination, as the server has one
 * bucket per `to` (amended 2026-11-12: the first contract counted the host's socket as a whole, which a host that is
 * the player up reached with three clients). STATE at 10 Hz is half a bucket, so nothing is shed in a normal match
 * at any size; the pacer is there for a burst of signalling.
 *
 * A18 (2026-11-24): a dropped socket is still what it was here (every link closes, the engine sees a leave for each);
 * that a short one is no disconnect is the engines' rule (`host.ts` / `client.ts`, a grace of 5 s), so it holds for the
 * WebSocket transport too. Two things here: every drop says why (`dropWords`: socket.io's reason, the WebSocket close
 * code, how long the connection had been up and when ArcAid's last ping came), because on 2026-11-23 three drops of
 * one PC's socket left nothing in either log to tell a network cut from a proxy closing the connection; and the first
 * reconnect is tried after about a quarter of a second, not half a second (`RECONNECT_FIRST_MS`).
 */
import { io, type Socket } from 'socket.io-client';
import { decodeFrame, encodeFrame, type AnyMessage, type PlayerId } from '@castcade/protocol';
import { openCandidate, refusedOpening, ReportGate, undecodedFrames, type OpenedCandidate } from './transport.js';
import type { MessageHandler, PeerHandler, Transport } from './transport.js';
import { foreignVersionRefusal, undecodable, type ErrorHandler } from './transport-ws.js';

/** Host -> client, in `data`: "your link to me is gone; open it again with RECONNECT". Never a protocol frame. */
export const RELINK = 'castcade-relay:relink';
/** The server's cap on one `data` string, in bytes (UTF-8). */
export const RELAY_MAX_BYTES = 256 * 1024;
/** The server's rate limit: messages per window per socket. */
export const RELAY_RATE = { limit: 200, windowMs: 10_000 } as const;

const seconds = (ms: number): number => Math.round(ms / 100) / 10;

export type RelayErrorCode =
  /** No connection to ArcAid (network, DNS, the server down, or a server without the relay: no ack). */
  | 'unreachable'
  /** ArcAid refused the device credentials (the ack of `match:host` / `match:join`). */
  | 'unauthorized'
  | 'no_such_match'
  | 'full'
  /** `match:join` refused: the host locked the room (the match started) and this device never had a seat in it. */
  | 'locked'
  | 'rate_limited'
  /** `match:host` refused: the code is in use. */
  | 'code_in_use'
  /** `match:host` refused: the server holds as many rooms as it allows. */
  | 'server_busy'
  /** `match:closed`: the room is gone (the host left or has been gone too long, the server restarted). */
  | 'closed'
  /** `match:error`: the server dropped a frame (the message says why). */
  | 'dropped'
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
  /** Test seam: the pacer's budget (per destination on a host). Default: 180 per 10 s, the last 60 kept for frames that must arrive. */
  pace?: Partial<PacerOptions>;
  /** Test seam: how a client asks again for a room that is not there (`DEFAULT_REJOIN`). */
  rejoin?: Partial<RejoinPolicy>;
  /**
   * A17 step 7 (the review of PR 136): the times ArcAid answered this DEVICE `no_such_match`, whichever transport
   * asked (a mistyped code is a miss of the device as much as an ask for a room that is gone). A client transport
   * that is given the list writes its own misses into it, a first join's too, and holds its asks back by all of
   * them (`RejoinPolicy.maxMisses`), not only by its own. The shell keeps one list for all the transports it makes.
   */
  missLog?: number[];
  /** Test seam: how long a host that had to open its room again waits for its players before it locks it again. Default 60 s. */
  relockWaitMs?: number;
  /** Test seam: how long a relay peer's opening frame may wait for the engine's verdict (`CANDIDATE_VERDICT_MS`). */
  verdictMs?: number;
}

/**
 * A client whose room is gone (the server restarted, or the room expired) asks for it again while the host opens it
 * anew. Every `no_such_match` counts against the device on the server (eight in ten minutes lock it out for fifteen),
 * so the asks are few and further apart each time: after the n-th miss the next ask waits `gapsMs[n-1]` (the last gap
 * repeats), and after `maxMisses` inside `windowMs` this transport stops asking and answers `no_such_match` itself.
 */
export interface RejoinPolicy {
  gapsMs: readonly number[];
  maxMisses: number;
  windowMs: number;
}

/** Five asks over about 18 s from the first miss; three misses are left for the player's own tries. */
export const DEFAULT_REJOIN: RejoinPolicy = { gapsMs: [1_500, 3_000, 5_000, 8_000], maxMisses: 5, windowMs: 10 * 60_000 };

/**
 * A17 step 7 (2026-11-25, alpha-match.md section 11.8a; it replaces the shell's `HOST_WAIT_REJOIN` of A15, five asks
 * in 88 s and then none): how a member of a lobby asks for a room that is gone, while it waits for the lobby's PC
 * (twenty minutes, `LOBBY_HOST_WAIT_MS` in client.ts): at once, 5 s after the first miss, 25 s after the second
 * (half a minute in: a lobby's PC whose connection blinked, or an ArcAid that restarted, is back by then more often
 * than not), and then every 150 s for as long as the engine goes on trying. That is six asks in the first ten
 * minutes and four in every ten after, two under the server's lockout (eight misses in ten minutes); `maxMisses`
 * is the cap that keeps it under whatever else this device was answered (`RelayOptions.missLog`). A lobby's PC
 * that comes back is found within two and a half minutes at the worst; that this costs a member nothing of the
 * three minutes of a clock is the lobby PC's doing (`LOBBY_RETURN_ALLOW_MS`).
 */
export const LOBBY_REJOIN: RejoinPolicy = { gapsMs: [5_000, 25_000, 150_000], maxMisses: 7, windowMs: 10 * 60_000 };

/**
 * A17 step 7 (the review of PR 136): the longest a member who follows `LOBBY_REJOIN` can take to be back after the
 * lobby's PC has registered its room again, one failed ask included: the longest gap between two asks (150 s: the
 * ask before may have missed a moment before the return), then an ask that fails for another reason (the socket,
 * 5 s; the acknowledgement, 4 s), then the engine's own longest gap before it tries again (30 s,
 * `LOBBY_RECONNECT_GAP_MAX_MS` in client.ts), then an ask that is answered. The lobby's PC is given this number
 * (`LobbyOptions.returnAllowMs`): until it has passed since its return, neither clock counts against a member who
 * was away at that moment. `transport-relay.test.ts` holds the two numbers together.
 */
export const LOBBY_RETURN_ALLOW_MS = 200_000;

/**
 * How long the next ask for a room waits after a miss, when `misses` of them (this one included) fall inside the
 * policy's window: `gapsMs[misses - 1]`, the last gap repeating. A17 step 7: on its own so that a policy can be
 * checked against ArcAid's lockout without ten minutes of real time (`transport-relay.test.ts`: a lobby's slow asks).
 */
export function rejoinGapAfter(policy: RejoinPolicy, misses: number): number {
  const gaps = policy.gapsMs;
  return gaps[Math.min(Math.max(1, misses), gaps.length) - 1] ?? 0;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_ACK_TIMEOUT_MS = 4_000;
/** After a reconnect, `match:host` is tried again until it is accepted: after this long, then twice as long each time. */
const REHOST_RETRY_MS = 3_000;
/**
 * A17 step 8 (2026-11-26): how often in a row a host is answered that its device is not accepted (`unauthorized`)
 * before it stops asking for its room. One such answer can be the server failing to read the device just then, so
 * it is asked again; three in a row, over about ten seconds (the first at once, then 3 s and 6 s later), is a
 * pairing that is gone. Until this step it asked for ever, and a lobby whose PC was unpaired never ended.
 */
export const REHOST_UNAUTHORIZED_MAX = 3;
/** ... up to this (the server allows a device 20 `match:host` / `match:join` a minute). */
const REHOST_RETRY_MAX_MS = 30_000;
const DEFAULT_RELOCK_WAIT_MS = 60_000;
/** A client told `rate_limited` on a resume waits this long before it asks again. */
const REJOIN_HELD_BACK_MS = 15_000;
/** `match:leave` is given this long to be acked before the socket is closed anyway. */
const LEAVE_FLUSH_MS = 1_000;
/** The same `match:error` word is reported once in this long. */
const ERROR_REPORT_GAP_MS = 10_000;
/** The host asks who is in the room (after `no_such_peer`) at most this often. */
const RECONCILE_GAP_MS = 5_000;
/** `match:closed` reasons after which the room may be opened again under the same code. */
const REOPENABLE: ReadonlySet<string> = new Set(['expired', 'server_restart']);
/** `match:closed` reasons after which a client does not ask for the room again: its host ended it. */
const FINAL_FOR_CLIENT: ReadonlySet<string> = new Set(['host_left', 'replaced']);
/** What a device whose pairing was revoked mid-match is told (the Match tab shows it). */
export const RELAY_UNPAIRED = 'This PC is no longer paired with ArcAid';
/** A second RELINK to the same peer waits this long (its frames keep arriving until it acts on the first). */
const RELINK_GAP_MS = 2_000;
/**
 * A18: socket.io's first reconnect after a drop, before its jitter (half to one and a half times this) and doubling:
 * what crosses while the socket is away is lost and must be resumed, so the gap is kept short. The later tries back
 * off as before, up to 5 s (an ArcAid restart takes about 8 s).
 */
const RECONNECT_FIRST_MS = 250;

/**
 * A18: why socket.io says the connection closed, for the log. `transport close`: the WebSocket was closed under it (the
 * network, a proxy on the way, ArcAid going down); `ping timeout`: nothing came from ArcAid for its ping interval and
 * timeout; `transport error`: the socket failed; `io server disconnect`: ArcAid closed it on purpose. No address and no
 * error text of the system's is taken, only socket.io's own words and the close code.
 */
export function dropWords(reason: string, details: unknown, upMs: number | null, pingAgoMs: number | null): string {
  const d = typeof details === 'object' && details !== null ? (details as { description?: unknown; context?: unknown }) : {};
  const ctx = typeof d.context === 'object' && d.context !== null ? (d.context as { code?: unknown }) : {};
  const parts = [reason.replace(/[^A-Za-z ]/g, '').slice(0, 40)];
  // Letters and spaces only ("websocket connection closed", "websocket error"): an error text with a number or a
  // slash in it could be an address or a path.
  if (typeof d.description === 'string' && /^[A-Za-z ]{1,60}$/.test(d.description)) parts.push(d.description);
  if (typeof ctx.code === 'number') parts.push(`close code ${ctx.code}`);
  const up = upMs === null ? '' : ` after ${seconds(upMs)} s`;
  const ping = pingAgoMs === null ? 'no ping from ArcAid on this connection yet' : `ArcAid's last ping came ${seconds(pingAgoMs)} s before`;
  return `the connection to ArcAid closed (${parts.join('; ')})${up}; ${ping}`;
}

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

type RelayEvent = 'match:host' | 'match:join' | 'match:lock';
type Ack = { ok: true; peer?: unknown; peers?: unknown } | { ok: false; error?: unknown };

function errorFromAck(event: RelayEvent, code: string, error: unknown): RelayError {
  const e = typeof error === 'string' ? error : 'refused';
  if (e === 'no_such_match') return new RelayError('no_such_match', `no match with the code ${code}`);
  if (e === 'full') return new RelayError('full', `the match ${code} is full`);
  if (e === 'locked') return new RelayError('locked', `the match ${code} has already started`);
  if (e === 'unauthorized') return new RelayError('unauthorized', 'ArcAid did not accept this device');
  if (e === 'rate_limited') return new RelayError('rate_limited', 'ArcAid is holding this device back after too many tries');
  if (e === 'code_in_use') return new RelayError('code_in_use', `the code ${code} is in use`);
  if (e === 'server_busy') return new RelayError('server_busy', 'ArcAid is carrying as many matches as it allows');
  return new RelayError('refused', `ArcAid refused ${event}: ${e.slice(0, 200)}`);
}

/** What a `match:error` word means, for the log. The frame it answers was dropped by the server. */
function droppedText(word: string): string {
  switch (word) {
    case 'rate_limited':
      return `ArcAid dropped messages from this PC: more than ${RELAY_RATE.limit} in ${RELAY_RATE.windowMs / 1000} s`;
    case 'too_large':
      return `ArcAid dropped a message over its ${RELAY_MAX_BYTES} bytes`;
    case 'invalid_message':
      return 'ArcAid dropped a message it could not read';
    case 'no_such_peer':
      return 'ArcAid dropped a message for a player who is not in the room';
    case 'not_in_match':
      return 'ArcAid dropped a message: this PC is not in the room any more';
    case 'unauthorized':
      return 'ArcAid dropped a message: it does not accept this device';
    default:
      return `ArcAid dropped a message (${word.slice(0, 80)})`;
  }
}

const peerList = (v: unknown): string[] | null => (Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string') : null);

/** socket.io's own URL for a base URL: the origin, with a path in the base as the prefix of `/socket.io`. */
export function relayEndpoint(baseUrl: string): { origin: string; path: string } {
  const u = new URL(baseUrl);
  const prefix = u.pathname.replace(/\/+$/, '');
  return { origin: u.origin, path: `${prefix}/socket.io` };
}

/** The socket, the ack'd requests and the error reports the relay transports share; I11.4.1's watch session extends it too. */
export abstract class RelayBase {
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
  /**
   * The handshake itself was refused (a server middleware said no): socket.io does not retry that. ArcAid's relay
   * never does this (the device is checked at `match:host` / `match:join`), so it is not a verdict on the device.
   */
  private refusal: RelayError | null = null;
  private readonly reportedAt = new Map<string, number>();
  /** A18: when the connection came up and when ArcAid last pinged it, for the line a drop leaves in the log. */
  private upAt: number | null = null;
  private pingAt: number | null = null;

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
      reconnectionDelay: RECONNECT_FIRST_MS,
      reconnectionDelayMax: 5_000,
      timeout: this.connectTimeoutMs,
    });
    this.socket = socket;
    socket.on('connect', () => {
      this.refusal = null;
      this.upAt = Date.now();
      this.pingAt = null;
      this.onSocketUp(socket);
    });
    socket.io.on('ping', () => {
      this.pingAt = Date.now();
    });
    socket.on('disconnect', (reason, details) => {
      // A18: why, for the log (not for a close of our own).
      if (!this.closed && reason !== 'io client disconnect') {
        const now = Date.now();
        this.fail(new RelayError('unreachable', dropWords(reason, details, this.upAt === null ? null : now - this.upAt, this.pingAt === null ? null : now - this.pingAt)), null);
      }
      this.upAt = null;
      this.onSocketDown(reason);
      // The server closed it (a restart, a kick): socket.io leaves that one to us.
      if (reason === 'io server disconnect' && !this.closed) socket.connect();
    });
    socket.on('connect_error', (err) => {
      // `active` false: the server's middleware refused the handshake; nothing will retry.
      if (!socket.active) this.refusal = new RelayError('unreachable', `ArcAid refused the connection (${err.message.slice(0, 120)})`);
    });
    this.wire(socket);
    socket.connect();
    return socket;
  }

  /** Resolves once the socket is connected; rejects with `unreachable` (after the timeout, or a refused handshake). */
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
        if (!socket.active) done(() => reject(this.refusal ?? new RelayError('unreachable', `ArcAid refused the connection (${err.message.slice(0, 120)})`)));
      };
      const timer = setTimeout(
        () => done(() => reject(new RelayError('unreachable', `ArcAid did not answer in ${seconds(this.connectTimeoutMs)} s${last ? ` (${last.slice(0, 120)})` : ''}`))),
        this.connectTimeoutMs,
      );
      socket.on('connect', onConnect);
      socket.on('connect_error', onError);
    });
  }

  /** One `match:host` / `match:join` / `match:lock` with its ack. No ack in time reads as a server without it. */
  protected request(socket: Socket, event: RelayEvent, code: string): Promise<Ack & { ok: true }> {
    return new Promise((resolve, reject) => {
      socket.timeout(this.ackTimeoutMs).emit(event, { code }, (err: Error | null, ack: Ack | undefined) => {
        if (err) return reject(new RelayError('unreachable', `ArcAid did not answer ${event} in ${seconds(this.ackTimeoutMs)} s`));
        if (ack && ack.ok === true) return resolve(ack);
        reject(errorFromAck(event, code, ack && ack.ok === false ? ack.error : undefined));
      });
    });
  }

  /** A `match:error` word for the log, the same word once in ten seconds (the server may send one per frame). */
  protected reportDropped(word: string, peer: PlayerId | null): void {
    const now = Date.now();
    if (now - (this.reportedAt.get(word) ?? -Infinity) < ERROR_REPORT_GAP_MS) return;
    this.reportedAt.set(word, now);
    this.fail(new RelayError(word === 'rate_limited' ? 'rate_limited' : word === 'unauthorized' ? 'unauthorized' : 'dropped', droppedText(word)), peer);
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

  /**
   * Let go of the socket. `leave`: this side is in a room and is going on purpose, so the server is told
   * (`match:leave`: a host's room closes at once instead of after the grace) before the socket closes.
   */
  protected dropSocket(leave: boolean): void {
    const s = this.socket;
    this.socket = null;
    if (!s) return;
    s.removeAllListeners();
    if (leave && s.connected) s.timeout(LEAVE_FLUSH_MS).emit('match:leave', {}, () => s.disconnect());
    else s.disconnect();
  }
}

// ------------------------------------------------------------------------------------------- host --

/**
 * `reconnecting`: the room is being taken back or opened again (the socket dropped, the server lost the room).
 * `closed`: the server closed the room and it is not opened again (another socket of this device replaced it, or
 * `match:host` was refused for good); the transport carries nothing more.
 */
export type RelayHostState = 'off' | 'registered' | 'reconnecting' | 'closed';

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
  /** 2026-11-25: relay peers whose opening frame is with the engine and has no verdict yet. Not links. */
  private readonly candidates = new Map<string, OpenedCandidate>();
  /**
   * 2026-11-25: what is reported about one relay peer at most once in ten seconds: an opening frame of its that was
   * refused, and frames of its that did not decode. Kept while the peer has a seat (`forgetPeer`).
   */
  private readonly gates = new Map<string, { refused: ReportGate; undecoded: ReportGate }>();
  /** Relay peers that had a link when the socket dropped: told to RELINK once the room is ours again. */
  private stale = new Set<string>();
  private readonly relinkAt = new Map<string, number>();
  private readonly stateHandlers = new Set<(s: RelayHostState) => void>();
  private rehostTimer: ReturnType<typeof setTimeout> | null = null;
  private rehostDelayMs = REHOST_RETRY_MS;
  /** A17 step 8: `unauthorized` answers to `match:host` in a row since the room was last held. */
  private unauthorizedAsks = 0;
  /** A17 step 8: why this transport gave its room up for good (`closedWhy`); null while it has not. */
  private gaveUpFor: string | null = null;
  private seqForRefuse = 0;
  /** `lock()` was called: the room is locked again whenever it had to be opened anew. */
  private wantLocked = false;
  /** Players that had a link when the room was lost: a new room is locked only once they are back (or the wait ran out). */
  private readonly awaited = new Set<PlayerId>();
  private relockTimer: ReturnType<typeof setTimeout> | null = null;
  private reconcileAt = -Infinity;
  /** One pacer per destination: the server keeps a rate bucket for each `to`. */
  private readonly pacers = new Map<string, RelayPacer<string>>();
  private shedGone = 0;

  private pacerFor(relayPeer: string): RelayPacer<string> {
    let p = this.pacers.get(relayPeer);
    if (!p) {
      p = new RelayPacer<string>((data) => {
        if (this.socket?.connected) this.socket.emit('match:relay', { to: relayPeer, data });
      }, this.opts.pace);
      this.pacers.set(relayPeer, p);
    }
    return p;
  }

  private emitTo(relayPeer: string, data: string, sheddable: boolean): void {
    this.pacerFor(relayPeer).send(data, sheddable);
  }

  /** What waits for the destinations is dropped (their links are gone); the windows' history stays, as the server's does. */
  private clearPacers(): void {
    for (const p of this.pacers.values()) p.clear();
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

  /**
   * The match started: from now on ArcAid refuses a device that never had a seat in the room (`locked`); a player who
   * drops may still come back. Kept across a room that had to be opened again. Rejects with a `RelayError` when the
   * server did not take it (one without `match:lock` never answers: `unreachable`); the match is not affected.
   */
  async lock(): Promise<void> {
    this.wantLocked = true;
    await this.sendLock();
  }

  private async sendLock(): Promise<void> {
    const socket = this.socket;
    const code = this.code;
    if (!socket?.connected || code === null || this.current !== 'registered') return;
    await this.request(socket, 'match:lock', code);
  }

  /** After the room was registered again: lock it again, once the players it had are back in it. */
  private relock(): void {
    if (this.relockTimer) clearTimeout(this.relockTimer);
    this.relockTimer = null;
    if (!this.wantLocked || this.closed || this.current !== 'registered') return;
    if (this.awaited.size > 0) {
      // A new room knows no one: locked now, it would refuse the players this match already has.
      this.relockTimer = setTimeout(() => {
        this.relockTimer = null;
        this.awaited.clear();
        this.relock();
      }, this.opts.relockWaitMs ?? DEFAULT_RELOCK_WAIT_MS);
      return;
    }
    this.sendLock().catch((e: unknown) => this.fail(e, null));
  }

  get state(): RelayHostState {
    return this.current;
  }

  /**
   * A17 step 8: once `closed`: why the room was given up: `unauthorized` (this device is no longer paired with
   * ArcAid), the server's reason for closing the room for good (`replaced`, `host_left`), or the refusal of the ask
   * for it (`code_in_use`, `refused`). Null while the room is held or being taken back.
   */
  get closedWhy(): string | null {
    return this.gaveUpFor;
  }

  onState(cb: (s: RelayHostState) => void): () => void {
    this.stateHandlers.add(cb);
    return () => this.stateHandlers.delete(cb);
  }

  /** Sheddable frames dropped to stay under the rate limit, for the log. */
  get shed(): number {
    let n = this.shedGone;
    for (const p of this.pacers.values()) n += p.shed;
    return n;
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
      // `joined` (the first, and the ones sent again when the room is registered again) is not used: a socket in the
      // room is a link only from its first frame.
      if (typeof p?.peer !== 'string' || p.state !== 'left') return;
      this.stale.delete(p.peer);
      this.dropCandidate(p.peer);
      this.closeLink(p.peer, true);
      this.forgetPeer(p.peer);
    });
    socket.on('match:closed', (p: { reason?: unknown }) => {
      this.onRoomClosed(socket, typeof p?.reason === 'string' ? p.reason.slice(0, 80) : 'no reason given');
    });
    socket.on('match:error', (p: { error?: unknown }) => {
      const word = typeof p?.error === 'string' ? p.error : 'unknown';
      if (word === 'unauthorized' && this.code !== null && this.current === 'registered') {
        // This device's pairing was revoked mid-match: ArcAid closes the room (`host_gone` follows). Not opened again.
        this.fail(new RelayError('unauthorized', RELAY_UNPAIRED), null);
        this.dropLinks();
        return this.giveUp('unauthorized');
      }
      this.reportDropped(word, null);
      if (this.code === null || this.current !== 'registered') return;
      // The server does not name the peer: ask who is in the room and close the links of those who are not.
      if (word === 'no_such_peer' && this.links.size > 0) this.reconcile(socket);
      // This socket lost its seat without a `match:closed` (the room is gone, or was never ours): take it back.
      if (word === 'not_in_match') {
        this.dropLinks();
        this.setState('reconnecting');
        this.rehost(socket);
      }
    });
  }

  /** That peer id is gone for good (a client that comes back has a new one): its pacer goes with it. */
  private forgetPeer(relayPeer: string): void {
    this.gates.delete(relayPeer);
    const pacer = this.pacers.get(relayPeer);
    if (!pacer) return;
    this.shedGone += pacer.shed;
    pacer.clear();
    this.pacers.delete(relayPeer);
  }

  /** Every link closes (a leave each); the peers are remembered so they can be told to relink. */
  private dropLinks(): void {
    for (const [peer, link] of this.links) {
      this.stale.add(peer);
      if (this.wantLocked) this.awaited.add(link.player);
    }
    // A peer whose opening frame had no verdict yet is told to relink like the others: its answer may be lost.
    for (const peer of [...this.candidates.keys()]) {
      this.stale.add(peer);
      this.dropCandidate(peer);
    }
    this.clearPacers();
    for (const peer of [...this.links.keys()]) this.closeLink(peer, true);
  }

  /**
   * `match:closed` on the host socket. `expired` / `server_restart`: the room is opened again under the same code and
   * the clients, who were told too, come back by the relink path. Anything else (`replaced`: another socket of this
   * device hosts now; `host_left`): the room stays closed.
   */
  private onRoomClosed(socket: Socket, reason: string): void {
    if (this.code === null || this.closed || this.current === 'closed') return;
    this.dropLinks();
    if (REOPENABLE.has(reason)) {
      this.fail(new RelayError('closed', `ArcAid closed the room (${reason}); opening it again`), null);
      this.setState('reconnecting');
      if (socket.connected) this.rehost(socket);
      return;
    }
    this.fail(new RelayError('closed', `ArcAid closed the room (${reason})`), null);
    this.giveUp(reason);
  }

  private giveUp(why: string): void {
    this.gaveUpFor = why;
    if (this.rehostTimer) clearTimeout(this.rehostTimer);
    this.rehostTimer = null;
    if (this.relockTimer) clearTimeout(this.relockTimer);
    this.relockTimer = null;
    this.stale.clear();
    this.awaited.clear();
    this.setState('closed');
  }

  private reconcile(socket: Socket): void {
    const code = this.code;
    const now = Date.now();
    if (code === null || now - this.reconcileAt < RECONCILE_GAP_MS) return;
    this.reconcileAt = now;
    this.request(socket, 'match:host', code).then(
      (ack) => {
        const present = peerList(ack.peers);
        if (!present || this.closed || this.socket !== socket || this.current !== 'registered') return;
        for (const peer of [...this.links.keys(), ...this.candidates.keys()]) {
          if (present.includes(peer)) continue;
          this.dropCandidate(peer);
          this.closeLink(peer, true);
          this.forgetPeer(peer);
        }
      },
      (e: unknown) => this.fail(e, null),
    );
  }

  protected onSocketUp(socket: Socket): void {
    // The first connection is `host()`'s to use; a later one is a reconnect: take the room back.
    if (this.code !== null && this.current === 'reconnecting') this.rehost(socket);
  }

  protected onSocketDown(): void {
    if (this.code === null || this.current === 'closed') return;
    this.dropLinks();
    this.setState('reconnecting');
  }

  private rehost(socket: Socket): void {
    const code = this.code;
    if (code === null || this.closed) return;
    if (this.rehostTimer) clearTimeout(this.rehostTimer);
    this.rehostTimer = null;
    this.request(socket, 'match:host', code).then(
      (ack) => {
        if (this.closed || this.socket !== socket || !socket.connected || this.current !== 'reconnecting') return;
        this.rehostDelayMs = REHOST_RETRY_MS;
        this.unauthorizedAsks = 0;
        this.setState('registered');
        // The clients that were linked lost whatever crossed while we were away: they resume with RECONNECT. A room
        // that had to be opened anew holds none of them (`peers` says who is there): those come back by themselves.
        const present = peerList(ack.peers);
        for (const peer of this.stale) {
          if (!present || present.includes(peer)) this.relink(peer);
          else this.forgetPeer(peer);
        }
        this.stale = new Set();
        this.relock();
      },
      (e: unknown) => {
        if (this.closed || this.socket !== socket || this.current !== 'reconnecting') return;
        this.fail(e, null);
        // Another device has the code now: asking again changes nothing. (`unauthorized` is asked again: the server
        // also answers it when it could not read the device just now. A17 step 8: a few times, not for ever.)
        if (e instanceof RelayError && (e.code === 'code_in_use' || e.code === 'refused')) return this.giveUp(e.code);
        if (e instanceof RelayError && e.code === 'unauthorized') {
          this.unauthorizedAsks += 1;
          if (this.unauthorizedAsks >= REHOST_UNAUTHORIZED_MAX) return this.giveUp('unauthorized');
        } else this.unauthorizedAsks = 0;
        if (!socket.connected) return;
        this.rehostTimer = setTimeout(() => this.rehost(socket), this.rehostDelayMs);
        this.rehostDelayMs = Math.min(this.rehostDelayMs * 2, REHOST_RETRY_MAX_MS);
      },
    );
  }

  private relink(relayPeer: string): void {
    const now = Date.now();
    if (now - (this.relinkAt.get(relayPeer) ?? -Infinity) < RELINK_GAP_MS) return;
    this.relinkAt.set(relayPeer, now);
    this.emitTo(relayPeer, RELINK, false);
  }

  /**
   * Review of PR 127: a frame from a relay peer that is not linked (it has a seat in the room and has not said HELLO
   * or RECONNECT) never throws out of the socket's handler: whatever goes wrong is reported through `onError`.
   */
  private onFrame(relayPeer: string, text: string): void {
    if (this.links.has(relayPeer)) return this.takeFrame(relayPeer, text);
    try {
      this.takeFrame(relayPeer, text);
    } catch (e) {
      try {
        this.fail(e, null);
      } catch {
        /* nothing more to do for a peer nobody knows */
      }
    }
  }

  private takeFrame(relayPeer: string, text: string): void {
    const link = this.links.get(relayPeer) ?? null;
    let msg: AnyMessage;
    try {
      msg = decodeFrame(text);
    } catch (e) {
      if (!link) {
        // A17 (2026-11-24): a frame already, written in the asker's version (a HELLO's REFUSE, a RECONNECT's RECONNECT_ACK).
        // Null for anything else, and it never throws. The answer is a REFUSE or a RECONNECT_ACK, which nobody answers.
        const refuse = foreignVersionRefusal(text, this.localId, this.seqForRefuse + 1);
        if (refuse) {
          this.seqForRefuse += 1;
          this.emitTo(relayPeer, refuse, false);
        }
      }
      // 2026-11-25: one line for the first, then at most one in ten seconds per relay peer, with how many there were.
      const times = this.gateOf(relayPeer).undecoded.pass();
      if (times !== null) this.fail(undecodedFrames(e, times), link?.player ?? null);
      return;
    }
    if (!link) {
      // 2026-11-25: its opening frame is with the engine: nothing more is read from this peer until the verdict.
      if (this.candidates.has(relayPeer)) return;
      if (msg.type !== 'HELLO' && msg.type !== 'RECONNECT') {
        // A client that does not know its link closed (this socket dropped and came back): it must resume.
        this.relink(relayPeer);
        return;
      }
      // 2026-11-25: a relay peer is a player's link only once the engine has accepted its opening frame
      // (`LinkCandidate`). Until then the player it names keeps the link it has, and the answer goes to this peer.
      const player = msg.from;
      const candidate = openCandidate(
        player,
        {
          send: (m) => {
            const frame = this.frameOf(m, player);
            if (frame !== null) this.emitTo(relayPeer, frame, false);
          },
          bind: () => this.bind(relayPeer, player),
          // The relay has no kick: a peer that was refused is simply nobody's link. What it sends next is read as
          // any unlinked peer's is: an opening frame is judged on its own, anything else is answered with RELINK.
          close: () => void this.candidates.delete(relayPeer),
          // The peer keeps its seat and may open again: at most one line in ten seconds, with how many there were.
          refused: (code) => {
            const times = this.gateOf(relayPeer).refused.pass();
            if (times !== null) this.fail(refusedOpening(msg.type, player, code, times), null);
          },
        },
        this.opts.verdictMs,
      );
      this.candidates.set(relayPeer, candidate);
      for (const cb of [...this.messageHandlers]) cb(player, msg, candidate);
      return;
    }
    for (const cb of [...this.messageHandlers]) cb(link.player, msg);
  }

  /** The engine accepted `relayPeer`'s opening frame: it is `player`'s link now, in place of the one that player had. */
  private bind(relayPeer: string, player: PlayerId): void {
    this.candidates.delete(relayPeer);
    this.links.set(relayPeer, { relayPeer, player });
    const previous = this.byPlayer.get(player);
    this.byPlayer.set(player, relayPeer);
    if (previous !== undefined && previous !== relayPeer) this.links.delete(previous);
    else for (const cb of [...this.joinHandlers]) cb(player);
    // The last of the players a re-opened room was waiting for: it is locked again now.
    if (this.awaited.delete(player) && this.awaited.size === 0 && this.relockTimer) this.relock();
  }

  /** A relay peer that is gone, or whose room is: a verdict that comes later binds nothing. */
  private dropCandidate(relayPeer: string): void {
    this.candidates.get(relayPeer)?.gone();
  }

  private gateOf(relayPeer: string): { refused: ReportGate; undecoded: ReportGate } {
    let g = this.gates.get(relayPeer);
    if (!g) {
      g = { refused: new ReportGate(), undecoded: new ReportGate() };
      this.gates.set(relayPeer, g);
    }
    return g;
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
    for (const t of targets) if (t !== undefined) this.emitTo(t, frame, sheddable);
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

  /**
   * A15: let go of the room without leaving it (Castcade restarts itself and hosts the same code again): the socket
   * just closes, as in a crash, so the room outlives it by the server's grace and the clients are told `host_gone`,
   * after which they ask for the room again, never `host_left`, which ends the match for them.
   */
  abandon(): void {
    this.shutdown(false);
  }

  private shutdown(leave = true): void {
    this.closed = true;
    if (this.rehostTimer) clearTimeout(this.rehostTimer);
    this.rehostTimer = null;
    if (this.relockTimer) clearTimeout(this.relockTimer);
    this.relockTimer = null;
    for (const peer of [...this.candidates.keys()]) this.dropCandidate(peer);
    this.gates.clear();
    this.clearPacers();
    this.pacers.clear();
    this.links.clear();
    this.byPlayer.clear();
    this.stale.clear();
    this.awaited.clear();
    // Going on purpose: the room closes now (the clients are told `host_left`) instead of after the 30 s grace.
    this.dropSocket(leave && this.code !== null && this.current !== 'closed');
    this.code = null;
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
  private readonly rejoin: RejoinPolicy;
  /** When this transport was answered `no_such_match` (inside the policy's window). */
  private misses: number[] = [];
  /** `RelayOptions.missLog`: every miss of this device the shell knows of; null: this transport counts its own alone. */
  private readonly missLog: number[] | null;
  /** No `match:join` before this (the gap after a miss). */
  private nextJoinAt = 0;
  /** Why the room is not asked for again: a final `match:closed` reason, `unauthorized` (the pairing was revoked), or a resume answered `locked`. */
  private ended: string | null = null;
  private readonly sleepers = new Set<() => void>();

  constructor(opts: RelayOptions) {
    super(opts);
    this.rejoin = { ...DEFAULT_REJOIN, ...opts.rejoin };
    this.missLog = opts.missLog ?? null;
    this.pacer = new RelayPacer((p) => {
      if (this.socket?.connected && this.joined) this.socket.emit('match:relay', p);
    }, opts.pace);
  }

  /** Connect to ArcAid and join the room of `code`. Rejects with a `RelayError`. HELLO then goes out through `send`. */
  async connect(code: string): Promise<void> {
    this.code = code.toUpperCase();
    await this.join(false);
    this.ready = true;
  }

  /** `again`: this transport was in the room before (a resume), so a room that is not there may be on its way back. */
  private async join(again: boolean): Promise<void> {
    const code = this.code;
    if (code === null) throw new RelayError('refused', 'no match code to join');
    const socket = await this.whenConnected();
    if (this.joined) return;
    if (again) await this.beforeRejoin(code, socket);
    let ack: Ack & { ok: true };
    try {
      ack = await this.request(socket, 'match:join', code);
    } catch (e) {
      // Every miss of the device is written down where the shell keeps them, a first join's (a mistyped code) too.
      if (e instanceof RelayError && e.code === 'no_such_match' && this.missLog) {
        this.missLog.push(Date.now());
        if (this.missLog.length > 64) this.missLog.splice(0, this.missLog.length - 64);
      }
      if (again && e instanceof RelayError && e.code === 'no_such_match') {
        const now = Date.now();
        this.misses.push(now);
        this.nextJoinAt = now + rejoinGapAfter(this.rejoin, this.misses.length);
      }
      if (again && e instanceof RelayError) {
        // A lock is never lifted, and a device ArcAid no longer accepts mid-match is out: the engine's remaining
        // attempts are answered here, not by ArcAid (no reconnect loop against the server).
        if (e.code === 'locked' || e.code === 'unauthorized') this.ended = e.code;
        // Held back: the server's window is a minute, and every ask inside it counts again.
        if (e.code === 'rate_limited') this.nextJoinAt = Date.now() + REJOIN_HELD_BACK_MS;
      }
      throw e;
    }
    if (this.socket !== socket || !socket.connected) throw new RelayError('unreachable', 'the connection to ArcAid dropped while joining');
    this.joined = true;
    this.ended = null;
    this.nextJoinAt = 0;
    this.relayPeer = typeof ack.peer === 'string' ? ack.peer : null;
  }

  /** The gate of a resume's `match:join` (`RejoinPolicy`): not after the host ended the match, not too often, not too soon. */
  private async beforeRejoin(code: string, socket: Socket): Promise<void> {
    if (this.ended === 'unauthorized') throw new RelayError('unauthorized', RELAY_UNPAIRED);
    if (this.ended === 'locked') throw new RelayError('locked', `the match ${code} has already started, and ArcAid does not know this PC as one of its players`);
    if (this.ended !== null) throw new RelayError('closed', `the match ${code} was closed (${this.ended})`);
    const now = Date.now();
    this.misses = this.misses.filter((t) => now - t < this.rejoin.windowMs);
    // The device's misses, not this transport's alone, where the shell keeps them: ArcAid counts the device.
    const counted = this.missLog ? this.missLog.filter((t) => now - t < this.rejoin.windowMs).length : this.misses.length;
    if (counted >= this.rejoin.maxMisses) {
      throw new RelayError('no_such_match', `no match with the code ${code} (ArcAid said so ${counted} times; not asking again)`);
    }
    const wait = this.nextJoinAt - now;
    if (wait > 0) {
      await new Promise<void>((resolve) => {
        const done = (): void => {
          clearTimeout(timer);
          this.sleepers.delete(done);
          resolve();
        };
        const timer = setTimeout(done, wait);
        this.sleepers.add(done);
      });
    }
    if (this.closed || this.socket !== socket || !socket.connected) throw new RelayError('unreachable', 'the connection to ArcAid dropped while joining');
  }

  /** The server's id for this socket in the room, once joined. */
  get peerId(): string | null {
    return this.relayPeer;
  }

  /**
   * A17 step 7 (the handoff's item 13): why this transport does not ask for the room again, when ArcAid said the
   * room is gone for good (`host_left`: its host closed it; `replaced`: another device hosts the code now); null
   * while the room may come back. The shell ends a lobby's wait for its PC on it (`ClientMatch.hostLeft`).
   */
  get roomEnded(): string | null {
    return this.ended !== null && FINAL_FOR_CLIENT.has(this.ended) ? this.ended : null;
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
    await this.join(true);
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
        // A17 (2026-11-24): an answer in another protocol version (a host up to 0.2.50) is said as that.
        this.fail(undecodable(p.data, e), this.hostId);
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
      const reason = typeof p?.reason === 'string' ? p.reason.slice(0, 80) : null;
      this.joined = false;
      this.relayPeer = null;
      // The host ended it: no asking for the room again. Any other reason, the host may open it again (a restart).
      this.ended = reason !== null && FINAL_FOR_CLIENT.has(reason) ? reason : null;
      this.fail(new RelayError('closed', `ArcAid closed the match${reason !== null ? ` (${reason})` : ''}`), this.hostId);
      this.linkDown();
    });
    socket.on('match:error', (p: { error?: unknown }) => {
      const word = typeof p?.error === 'string' ? p.error : 'unknown';
      if (word === 'unauthorized') {
        // The pairing was revoked while seated: ArcAid took the seat. Final: the room is not asked for again.
        const first = this.ended !== 'unauthorized';
        this.ended = 'unauthorized';
        this.joined = false;
        this.relayPeer = null;
        if (first) this.fail(new RelayError('unauthorized', RELAY_UNPAIRED), this.hostId);
        this.linkDown();
        return;
      }
      this.reportDropped(word, this.hostId);
      // The server does not have this socket in the room (it lost the room): the link is gone; resume joins again.
      if (word === 'not_in_match' && this.joined) {
        this.joined = false;
        this.relayPeer = null;
        this.linkDown();
      }
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
    const wasIn = this.joined;
    this.joined = false;
    this.linkUp = false;
    this.pacer.clear();
    for (const wake of [...this.sleepers]) wake();
    this.dropSocket(wasIn);
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
