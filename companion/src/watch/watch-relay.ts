/**
 * I11.4.1 (2026-11-16): the 3D watch session's room on the ArcAid relay. The same room, contract and pairing rule as a
 * match (`match/transport-relay.ts` header: `match:host` / `match:join` / `match:relay`, 256 KB a message, 200 a
 * 10 s window, 8 sockets a room, one room per device), and the same socket handling (`RelayBase`); what travels in
 * `data` is the session's own strings (`watch-session.ts`), never protocol frames, so nothing changes on the server.
 *
 * Kept from the match relay because they cost something to learn: the host takes its room back after a dropped
 * socket and after the server lost it (`expired`, `server_restart`), with growing gaps; a client asks for the room
 * again a bounded number of times, further apart each time (eight `no_such_match` in ten minutes lock a device out);
 * every send goes through a `RelayPacer` (per destination on the host, as the server counts). Left out: RELINK, the
 * lock, the composite with a WebSocket listener (a watch session has no direct path).
 */
import type { Socket } from 'socket.io-client';
import { RelayBase, RelayError, RelayPacer, type RelayOptions } from '../match/transport-relay.js';

/** Room reasons after which the host opens the same code again (the server lost the room, not the host). */
const REOPENABLE: ReadonlySet<string> = new Set(['expired', 'server_restart']);
/** Room reasons after which a client stops asking for the room: its host ended it. */
const FINAL_FOR_CLIENT: ReadonlySet<string> = new Set(['host_left', 'replaced']);
const REHOST_RETRY_MS = 3_000;
const REHOST_RETRY_MAX_MS = 30_000;
/** A client asks for a room that is gone this many times, after these gaps (the last repeats), then gives up. */
export const WATCH_REJOIN = { gapsMs: [2_000, 6_000, 20_000, 60_000] as readonly number[], maxMisses: 5 };

export type WatchRoomState = 'off' | 'registered' | 'reconnecting' | 'closed';

/** The host's side: the room named by the session code. */
export class WatchRelayHost extends RelayBase {
  private code: string | null = null;
  private current: WatchRoomState = 'off';
  private readonly pacers = new Map<string, RelayPacer<string>>();
  private readonly dataHandlers = new Set<(from: string, data: string) => void>();
  private readonly leftHandlers = new Set<(peer: string) => void>();
  private readonly stateHandlers = new Set<(s: WatchRoomState, why: string | null, present: string[] | null) => void>();
  private rehostTimer: ReturnType<typeof setTimeout> | null = null;
  private rehostDelayMs = REHOST_RETRY_MS;

  constructor(opts: RelayOptions) {
    super(opts);
  }

  /** Register the room. Rejects with a `RelayError` (`code_in_use`: pick another code). */
  async host(code: string): Promise<void> {
    const socket = await this.whenConnected();
    await this.request(socket, 'match:host', code);
    this.code = code;
    this.setState('registered', null, null);
  }

  get state(): WatchRoomState {
    return this.current;
  }

  /** `data` to one client (its relay peer id), paced. Dropped while the room is not ours. */
  sendTo(peer: string, data: string): void {
    let p = this.pacers.get(peer);
    if (!p) {
      p = new RelayPacer<string>((d) => {
        if (this.socket?.connected && this.current === 'registered') this.socket.emit('match:relay', { to: peer, data: d });
      }, this.opts.pace);
      this.pacers.set(peer, p);
    }
    p.send(data, false);
  }

  onData(cb: (from: string, data: string) => void): () => void {
    this.dataHandlers.add(cb);
    return () => this.dataHandlers.delete(cb);
  }

  /** A client's socket left the room (it went, dropped, or was replaced by a new socket of the same PC). */
  onLeft(cb: (peer: string) => void): () => void {
    this.leftHandlers.add(cb);
    return () => this.leftHandlers.delete(cb);
  }

  /** The room's state; `present` (on `registered` after a reconnect): the clients the server still has in it. */
  onState(cb: (s: WatchRoomState, why: string | null, present: string[] | null) => void): () => void {
    this.stateHandlers.add(cb);
    return () => this.stateHandlers.delete(cb);
  }

  private setState(s: WatchRoomState, why: string | null, present: string[] | null): void {
    if (this.current === s && present === null) return;
    this.current = s;
    for (const cb of [...this.stateHandlers]) cb(s, why, present);
  }

  protected wire(socket: Socket): void {
    socket.on('match:relay', (p: { from?: unknown; data?: unknown }) => {
      if (typeof p?.from !== 'string' || typeof p.data !== 'string') return;
      for (const cb of [...this.dataHandlers]) cb(p.from, p.data);
    });
    socket.on('match:peer', (p: { peer?: unknown; state?: unknown }) => {
      if (typeof p?.peer !== 'string' || p.state !== 'left') return;
      this.pacers.get(p.peer)?.clear();
      this.pacers.delete(p.peer);
      for (const cb of [...this.leftHandlers]) cb(p.peer);
    });
    socket.on('match:closed', (p: { reason?: unknown }) => {
      const reason = typeof p?.reason === 'string' ? p.reason.slice(0, 80) : 'no reason given';
      if (this.code === null || this.closed || this.current === 'closed') return;
      if (REOPENABLE.has(reason)) {
        this.setState('reconnecting', `ArcAid closed the room (${reason}); opening it again`, null);
        if (socket.connected) this.rehost(socket);
        return;
      }
      this.giveUp(`ArcAid closed the room (${reason})`);
    });
    socket.on('match:error', (p: { error?: unknown }) => {
      const word = typeof p?.error === 'string' ? p.error : 'unknown';
      if (word === 'unauthorized' && this.current === 'registered') return this.giveUp('This PC is no longer paired with ArcAid');
      this.reportDropped(word, null);
      if (word === 'not_in_match' && this.code !== null && this.current === 'registered') {
        this.setState('reconnecting', 'ArcAid no longer had the room; opening it again', null);
        this.rehost(socket);
      }
    });
  }

  protected onSocketUp(socket: Socket): void {
    if (this.code !== null && this.current === 'reconnecting') this.rehost(socket);
  }

  protected onSocketDown(): void {
    if (this.code === null || this.current === 'closed' || this.closed) return;
    this.setState('reconnecting', 'the connection to ArcAid dropped', null);
  }

  private rehost(socket: Socket): void {
    const code = this.code;
    if (code === null || this.closed) return;
    if (this.rehostTimer) clearTimeout(this.rehostTimer);
    this.rehostTimer = null;
    this.request(socket, 'match:host', code).then(
      (ack) => {
        if (this.closed || this.socket !== socket || this.current !== 'reconnecting') return;
        this.rehostDelayMs = REHOST_RETRY_MS;
        const present = Array.isArray(ack.peers) ? ack.peers.filter((x): x is string => typeof x === 'string') : [];
        this.setState('registered', null, present);
      },
      (e: unknown) => {
        if (this.closed || this.socket !== socket || this.current !== 'reconnecting') return;
        this.fail(e, null);
        if (e instanceof RelayError && (e.code === 'code_in_use' || e.code === 'refused')) return this.giveUp(e.message);
        if (!socket.connected) return;
        this.rehostTimer = setTimeout(() => this.rehost(socket), this.rehostDelayMs);
        this.rehostDelayMs = Math.min(this.rehostDelayMs * 2, REHOST_RETRY_MAX_MS);
      },
    );
  }

  private giveUp(why: string): void {
    if (this.rehostTimer) clearTimeout(this.rehostTimer);
    this.rehostTimer = null;
    for (const p of this.pacers.values()) p.clear();
    this.setState('closed', why, null);
  }

  close(): void {
    this.closed = true;
    if (this.rehostTimer) clearTimeout(this.rehostTimer);
    this.rehostTimer = null;
    for (const p of this.pacers.values()) p.clear();
    this.pacers.clear();
    // Going on purpose: the room closes now (the clients are told `host_left`), not after the server's grace.
    this.dropSocket(this.code !== null && this.current !== 'closed');
    this.code = null;
    this.setState('off', null, null);
  }
}

/** The client's side: a seat in the host's room. */
export class WatchRelayClient extends RelayBase {
  private code: string | null = null;
  private joined = false;
  /** Why the room is not asked for again (the host ended it, the pairing was revoked, too many misses). */
  private ended: string | null = null;
  private misses = 0;
  private rejoinTimer: ReturnType<typeof setTimeout> | null = null;
  private rejoining = false;
  private readonly pacer: RelayPacer<{ data: string }>;
  private readonly dataHandlers = new Set<(data: string) => void>();
  private readonly downHandlers = new Set<(why: string, final: boolean) => void>();
  private readonly upHandlers = new Set<() => void>();
  private readonly gaps: readonly number[];
  private readonly maxMisses: number;

  constructor(opts: RelayOptions & { rejoinGapsMs?: readonly number[]; rejoinMaxMisses?: number }) {
    super(opts);
    this.gaps = opts.rejoinGapsMs ?? WATCH_REJOIN.gapsMs;
    this.maxMisses = opts.rejoinMaxMisses ?? WATCH_REJOIN.maxMisses;
    this.pacer = new RelayPacer((p) => {
      if (this.socket?.connected && this.joined) this.socket.emit('match:relay', p);
    }, opts.pace);
  }

  /** Join the room of `code`. Rejects with a `RelayError` (`no_such_match`, `locked`, `full`, `unauthorized`, …). */
  async join(code: string): Promise<void> {
    this.code = code;
    const socket = await this.whenConnected();
    await this.request(socket, 'match:join', code);
    if (this.socket !== socket || !socket.connected) throw new RelayError('unreachable', 'the connection to ArcAid dropped while joining');
    this.joined = true;
  }

  get inRoom(): boolean {
    return this.joined;
  }

  send(data: string): void {
    if (!this.joined || !this.socket?.connected) return;
    this.pacer.send({ data }, false);
  }

  onData(cb: (data: string) => void): () => void {
    this.dataHandlers.add(cb);
    return () => this.dataHandlers.delete(cb);
  }

  /** Out of the room. `final`: it is not asked for again (the host ended the session, or it stayed gone). */
  onDown(cb: (why: string, final: boolean) => void): () => void {
    this.downHandlers.add(cb);
    return () => this.downHandlers.delete(cb);
  }

  /** Back in the room after it was lost (the session says hello again). */
  onUp(cb: () => void): () => void {
    this.upHandlers.add(cb);
    return () => this.upHandlers.delete(cb);
  }

  private down(why: string, final: boolean): void {
    this.joined = false;
    this.pacer.clear();
    if (final) {
      this.ended = why;
      if (this.rejoinTimer) clearTimeout(this.rejoinTimer);
      this.rejoinTimer = null;
    }
    for (const cb of [...this.downHandlers]) cb(why, final);
  }

  protected wire(socket: Socket): void {
    socket.on('match:relay', (p: { data?: unknown }) => {
      if (typeof p?.data !== 'string') return;
      for (const cb of [...this.dataHandlers]) cb(p.data);
    });
    socket.on('match:closed', (p: { reason?: unknown }) => {
      const reason = typeof p?.reason === 'string' ? p.reason.slice(0, 80) : 'no reason given';
      if (this.closed || this.ended !== null) return;
      if (FINAL_FOR_CLIENT.has(reason)) return this.down(reason === 'host_left' ? 'the host ended the session' : 'the host started another session', true);
      this.down(`ArcAid closed the room (${reason})`, false);
      this.scheduleRejoin(0);
    });
    socket.on('match:error', (p: { error?: unknown }) => {
      const word = typeof p?.error === 'string' ? p.error : 'unknown';
      if (word === 'unauthorized') return this.down('This PC is no longer paired with ArcAid', true);
      this.reportDropped(word, null);
      if (word === 'not_in_match' && this.joined) {
        this.down('ArcAid no longer had this PC in the room', false);
        this.scheduleRejoin(0);
      }
    });
  }

  protected onSocketUp(): void {
    if (this.code !== null && !this.joined && this.ended === null && !this.closed) this.scheduleRejoin(0);
  }

  protected onSocketDown(): void {
    if (this.ended !== null || this.closed || !this.joined) return;
    this.down('the connection to ArcAid dropped', false);
  }

  private scheduleRejoin(ms: number): void {
    if (this.rejoinTimer || this.rejoining || this.closed || this.ended !== null) return;
    this.rejoinTimer = setTimeout(() => {
      this.rejoinTimer = null;
      void this.rejoin();
    }, ms);
  }

  private async rejoin(): Promise<void> {
    const code = this.code;
    if (code === null || this.closed || this.ended !== null || this.joined) return;
    this.rejoining = true;
    try {
      await this.join(code);
      this.misses = 0;
      for (const cb of [...this.upHandlers]) cb();
    } catch (e) {
      if (this.closed) return;
      const word = e instanceof RelayError ? e.code : 'unreachable';
      if (word === 'unauthorized') return this.down('This PC is no longer paired with ArcAid', true);
      if (word === 'locked' || word === 'full') return this.down(e instanceof Error ? e.message : String(e), true);
      if (word === 'no_such_match') {
        this.misses += 1;
        if (this.misses >= this.maxMisses) return this.down(`the session ${code} is gone (its host left or has been away too long)`, true);
      }
      // A dropped socket is socket.io's to fix (it reconnects and `onSocketUp` asks again); a miss waits a little longer
      // each time; a device held back waits out the server's minute.
      const gap = word === 'rate_limited' ? 15_000 : (this.gaps[Math.max(0, Math.min(this.misses, this.gaps.length) - 1)] ?? 2_000);
      if (word !== 'unreachable' || this.socket?.connected) this.scheduleRejoin(gap);
    } finally {
      this.rejoining = false;
    }
  }

  close(): void {
    this.closed = true;
    if (this.rejoinTimer) clearTimeout(this.rejoinTimer);
    this.rejoinTimer = null;
    const wasIn = this.joined;
    this.joined = false;
    this.pacer.clear();
    this.dropSocket(wasIn);
  }
}
