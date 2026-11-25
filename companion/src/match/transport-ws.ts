/**
 * WebSocket transports: `WsHostTransport` (one `ws` server, one socket per client, socket ->
 * playerId once the engine has accepted the socket's first HELLO: 2026-11-25, `LinkCandidate` in
 * transport.ts, for the inbound sockets of `WsPeerTransport` too) and `WsClientTransport` (one socket to the host), the
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
import { openCandidate, refusedOpening, ReportGate, undecodedFrames, verdictClock, type MessageHandler, type OpenedCandidate, type PeerHandler, type Transport } from './transport.js';

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

/**
 * The sentence the PC that asked is shown ("The host refused: …"); it names what that PC, or the host, has to do.
 * `theirs` is the asker's version as a whole number, or null when its `v` is anything else: the sentence is never
 * built from the frame's own text (review of PR 127: `String(v)` of a long `v` broke the REFUSE schema's 500
 * characters, inside a socket handler, for anybody who reached the port).
 */
function refusalSentence(theirs: number | null): string {
  if (theirs !== null && theirs > PROTOCOL_VERSION) {
    return `The host's Castcade is older than this PC's (it speaks protocol ${PROTOCOL_VERSION}, this PC ${theirs}). The host updates Castcade (Settings, Check for updates); then join again.`;
  }
  return `This match needs Castcade ${PROTOCOL_SINCE_RELEASE} or newer (protocol ${PROTOCOL_VERSION}; this PC sent ${theirs === null ? 'another version' : theirs}). Update Castcade on this PC (Settings, Check for updates) and join again.`;
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
 *
 * It never throws, whatever the text is (review of PR 127): it runs in the `message` handler of a socket nobody has
 * vouched for, where a throw is an uncaught error in the main process. Nothing of the frame goes into the answer but
 * its whole-number version and, for a RECONNECT, a match id of the plain kind; anything it cannot answer is null.
 */
export function foreignVersionRefusal(text: string, from: PlayerId, seq: number): string | null {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const v = (value as { v?: unknown }).v;
    const type = (value as { type?: unknown }).type;
    if ((type !== 'HELLO' && type !== 'RECONNECT') || v === PROTOCOL_VERSION) return null;
    const theirs = foreignVersionOf(text);
    let answer: AnyMessage;
    if (type === 'HELLO') {
      answer = buildMessage('REFUSE', { code: 'protocol_version', message: refusalSentence(theirs) }, { matchId: null, seq, from });
    } else {
      const asked = (value as { matchId?: unknown }).matchId;
      const matchId = typeof asked === 'string' && /^[\w.:-]{1,64}$/.test(asked) ? asked : null;
      answer = buildMessage('RECONNECT_ACK', { accept: false, code: 'unknown_player', entries: [], logHash: ZERO_HASH, logLength: 0 }, { matchId, seq: Math.max(seq, Date.now()), from });
    }
    // A version that is not a whole number is nobody's: the answer stays in ours.
    return JSON.stringify({ ...answer, v: theirs ?? PROTOCOL_VERSION });
  } catch {
    return null;
  }
}

/** Answer a foreign-version HELLO or RECONNECT and close. True when it answered. Never throws (a socket that is closing). */
function refuseForeignVersion(socket: WebSocket, text: string, from: PlayerId, seq: number): boolean {
  const refuse = foreignVersionRefusal(text, from, seq);
  if (!refuse) return false;
  try {
    socket.send(refuse, () => socket.close());
  } catch {
    return false;
  }
  return true;
}

/**
 * Review of PR 127: a frame from a socket that is not linked yet (nobody has said HELLO or RECONNECT on it: anybody
 * who reaches the port) must never throw out of the `message` handler, where a throw is an uncaught error in the main
 * process and Electron's error box over the host's game. Whatever goes wrong while such a frame is handled is
 * reported through `onError` and the socket is closed. A linked peer's frame is handled as it always was.
 */
function guardUnlinked(unlinked: boolean, run: () => void, report: (e: unknown) => void, socket: WebSocket): void {
  if (!unlinked) return run();
  try {
    run();
  } catch (e) {
    try {
      report(e);
      socket.close();
    } catch {
      /* nothing more to do for a socket nobody knows */
    }
  }
}

export interface WsHostOptions {
  localId: PlayerId;
  /** 0 picks an ephemeral port; read it back from `listen()`. */
  port: number;
  host?: string;
  /** Test seam: how long a socket's first frame may wait for the engine's verdict (`CANDIDATE_VERDICT_MS`). */
  verdictMs?: number;
}

export class WsHostTransport implements Transport {
  readonly localId: PlayerId;
  private server: WebSocketServer | null = null;
  private readonly sockets = new Map<PlayerId, WebSocket>();
  /** 2026-11-25: the sockets that are nobody's yet, so that `close()` ends them too. */
  private readonly waiting = new Set<WebSocket>();
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
    // 2026-11-25: `peer` stays null until the engine has accepted this socket's first frame (`LinkCandidate`).
    // `judged`: the first frame was handed over (a verdict is awaited, or it was refused): nothing more is read.
    let judged: OpenedCandidate | null = null;
    // The time for a verdict runs from the connection: a socket that says nothing is closed as well.
    const clock = verdictClock(() => {
      this.fail(new Error('a connection that sent no opening frame in time was closed'), null);
      socket.close();
    }, this.opts.verdictMs);
    const undecoded = new ReportGate();
    this.waiting.add(socket);
    /** The socket closed while it was nobody's: no leave, and no verdict can bind it any more. */
    const closedUnbound = (): void => {
      this.waiting.delete(socket);
      clock.stop();
      judged?.gone();
    };
    let peer: PlayerId | null = null;
    const onFrame = (data: RawData): void => {
      const text = rawToString(data);
      let msg: AnyMessage;
      try {
        msg = decodeFrame(text);
      } catch (e) {
        this.refuseForeignVersion(socket, text);
        // 2026-11-25: one line for the first, then at most one in ten seconds with how many there were.
        const times = undecoded.pass();
        if (times !== null) this.fail(undecodedFrames(e, times), peer);
        return;
      }
      if (peer === null) {
        if (judged !== null) return;
        if (msg.type !== 'HELLO') {
          this.fail(new Error(`first frame from a new socket was ${msg.type}, not HELLO`), null);
          socket.close();
          return;
        }
        const player = msg.from;
        judged = openCandidate(
          player,
          {
            send: (m) => {
              if (socket.readyState === WebSocket.OPEN) socket.send(encodeFrame(m));
            },
            bind: () => {
              peer = player;
              this.waiting.delete(socket);
              const previous = this.sockets.get(player);
              if (previous && previous !== socket) previous.close();
              this.sockets.set(player, socket);
              for (const cb of [...this.joinHandlers]) cb(player);
            },
            close: () => socket.close(),
            // One line per connection: a refused socket is closed and reads nothing more.
            refused: (code) => this.fail(refusedOpening(msg.type, player, code, 1), null),
          },
          clock.spoke(),
        );
        for (const cb of [...this.messageHandlers]) cb(player, msg, judged);
        return;
      }
      for (const cb of [...this.messageHandlers]) cb(peer, msg);
    };
    socket.on('message', (data: RawData) => guardUnlinked(peer === null, () => onFrame(data), (e) => this.fail(e, null), socket));
    socket.on('close', () => {
      if (peer === null) return closedUnbound();
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
    // 2026-11-25: and the sockets that are nobody's yet (no first frame, or no verdict on it).
    for (const s of [...this.waiting]) s.terminate();
    this.waiting.clear();
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
  /** Test seam: how long an inbound socket's first frame may wait for the engine's verdict (`CANDIDATE_VERDICT_MS`). */
  verdictMs?: number;
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
  /**
   * 2026-11-25, inbound only: the first frame was handed to the engine. While `peer` is null the link is a candidate
   * (a verdict is awaited, or it was refused and the socket is closing); it is `peer`'s link from the accept on.
   */
  judged: OpenedCandidate | null;
  /** 2026-11-25, inbound only: the time for a verdict, which runs from the connection (`verdictClock`). */
  clock?: { spoke(): number; stop(): void };
  /** 2026-11-25, inbound only: frames that did not decode are reported at most once in ten seconds, with a count. */
  undecoded?: ReportGate;
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
  private readonly verdictMs: number | undefined;

  constructor(opts: WsPeerOptions) {
    this.localId = opts.localId;
    this.verdictMs = opts.verdictMs;
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
      const link: PeerLink = { socket, dir: 'out', peer, ready: first === null, silent: false, judged: null };
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
    const link: PeerLink = { socket, dir: 'in', peer: null, ready: false, silent: false, judged: null, undecoded: new ReportGate() };
    // 2026-11-25: the time for a verdict runs from the connection: a socket that says nothing is closed as well.
    link.clock = verdictClock(() => {
      this.fail(new Error('a connection that sent no opening frame in time was closed'), null);
      socket.close();
    }, this.verdictMs);
    this.links.push(link);
    const onFrame = (data: RawData): void => {
      const text = rawToString(data);
      let msg: AnyMessage;
      try {
        msg = decodeFrame(text);
      } catch (e) {
        if (link.peer === null && refuseForeignVersion(socket, text, this.localId, this.seqForRefuse + 1)) this.seqForRefuse += 1;
        // 2026-11-25: one line for the first, then at most one in ten seconds with how many there were.
        const times = link.undecoded ? link.undecoded.pass() : 1;
        if (times !== null) this.fail(undecodedFrames(e, times), link.peer);
        return;
      }
      if (link.peer === null) {
        // 2026-11-25: once the first frame was handed over nothing more is read until, and unless, it is accepted.
        if (link.judged !== null) return;
        if (msg.type !== 'HELLO' && msg.type !== 'RECONNECT') {
          this.fail(new Error(`first frame from a new socket was ${msg.type}, not HELLO or RECONNECT`), null);
          socket.close();
          return;
        }
        const player = msg.from;
        link.judged = openCandidate(
          player,
          {
            send: (m) => {
              if (socket.readyState === WebSocket.OPEN) socket.send(encodeFrame(m));
            },
            // The player's other links, if any, stay as they are: frames go on the newest (the class comment).
            bind: () => {
              link.peer = player;
              link.ready = true;
              this.noteJoin(link);
            },
            // Never anybody's link: its close is not a leave (`peer` is still null).
            close: () => socket.close(),
            // One line per connection: a refused socket is closed and reads nothing more.
            refused: (code) => this.fail(refusedOpening(msg.type, player, code, 1), null),
          },
          link.clock?.spoke(),
        );
        for (const cb of [...this.messageHandlers]) cb(player, msg, link.judged);
        return;
      }
      this.dispatch(link.peer, msg);
    };
    socket.on('message', (data: RawData) => guardUnlinked(link.peer === null, () => onFrame(data), (e) => this.fail(e, null), socket));
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
    // A socket that closes before its verdict was never anybody's: no verdict can bind it any more.
    link.clock?.stop();
    link.judged?.gone();
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
