/**
 * D10.8: an in-process relay that behaves like the ArcAid match relay as built (ArcAid `src/api/matchRelay.ts`; the
 * contract is docs/arcaid-side-changes.md §4a), for the companion's tests. socket.io v4, default namespace. Everything
 * is in memory; `data` is never read. Written from the contract, not copied: where the two differ the server is right.
 *
 * What it does, as the server does:
 * - **Auth is per event, not at connect.** Any socket connects. `match:host` / `match:join` read the handshake's
 *   `auth { deviceId, deviceToken }` and ack `{ ok: false, error: 'unauthorized' }` for a device that is not paired.
 * - **`match:host { code }`** acks `{ ok: true, peers }`. A code held by another device: `code_in_use`. The owning
 *   device again (a resume inside the grace, or a second socket taking over): the room is its again, `peers` lists the
 *   clients and `match:peer { state: 'joined' }` is sent again for each; the older host socket loses the seat and is
 *   told nothing. A device hosts one room: a new code closes its other room (`host_left` when it is the same socket,
 *   which is not told; `replaced` from another socket, and the old host socket is told). Also `bad_code`,
 *   `rate_limited`, `server_busy`.
 * - **`match:join { code }`** acks `{ ok: true, peer }` (12 base64url characters) or `no_such_match` (a malformed code
 *   too), `full`, `locked`, `rate_limited`, `unauthorized` (also the host socket joining its own room). Idempotent for
 *   a socket already in the room. Eight `no_such_match` in ten minutes lock the device (never the address) out for 15.
 * - **`match:lock`** (host only, idempotent, no unlock; anyone else: `unauthorized`) acks `{ ok: true }`; from then on
 *   a device that never held a seat in the room is refused with `locked`, one that did (the host's too) may join
 *   again and gets a new peer id. A new room on the same code starts unlocked and knows no one.
 * - **A seated device is checked again** at most once per `reverifyMs`, on its next `match:relay`: one that is no
 *   longer paired gets `match:error { error: 'unauthorized' }` and loses its seat (the host sees `match:peer left`);
 *   a host's room closes with `host_gone`. The frame that started the check is not held back.
 * - **`match:leave`** acks `{ ok: true }`; a host leaving closes the room (`host_left`).
 * - **`match:relay`**: a fixed window of `rate.windowMs` per client socket and, for the host, per destination. Every
 *   frame counts, before anything else is checked (an oversize one too). Over the limit: dropped, and one
 *   `match:error { error: 'rate_limited' }` per window per bucket. Then `not_in_match` / `unauthorized` (no seat),
 *   `invalid_message`, `too_large`, `no_such_peer` (the host naming a peer that is not in the room). A client frame
 *   while the host socket is away is dropped silently.
 * - **`match:closed { reason }`** goes to every client and to the host socket if it is there: `host_gone` (the grace
 *   ran out), `expired`, `host_left`, `replaced`, `server_restart`.
 */
import { randomBytes } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server, type Socket } from 'socket.io';

export interface FakeRelayOptions {
  /** deviceId -> deviceToken of the paired devices. */
  devices: Record<string, string>;
  /** How long a room outlives its host socket. Server: 30 s. */
  hostGraceMs?: number;
  /** Room lifetime from creation. Server: 12 h. */
  roomTtlMs?: number;
  /** Sockets per room, the host included. Server: 8. */
  maxSockets?: number;
  /** Rooms in the process. Server: 2000. */
  maxRooms?: number;
  /** Bytes per `data`. Server: 256 KB. */
  maxBytes?: number;
  /** `match:relay` per fixed window: per client socket, and per destination for the host socket. Server: 200 per 10 s. */
  rate?: { limit: number; windowMs: number };
  /** `match:host` / `match:join` per minute per device. Server: 20 (and 60 per address, three times this here). */
  attemptsPerMinute?: number;
  /** `no_such_match` answers inside ten minutes before the device is locked out. Server: 8. */
  missLimit?: number;
  /** How long a seated device's check is trusted. Server: 60 s. */
  reverifyMs?: number;
  /** socket.io path, for a base URL with a path. Default `/socket.io`. */
  path?: string;
}

interface Window {
  start: number;
  count: number;
  warned: boolean;
}

interface Room {
  code: string;
  owner: string;
  host: Socket | null;
  /** peer id -> client socket. */
  clients: Map<string, Socket>;
  /** peer id -> the host's send window to that peer. */
  hostWindows: Map<string, Window>;
  locked: boolean;
  /** Devices that have held a seat in this room. */
  seated: Set<string>;
  graceTimer: ReturnType<typeof setTimeout> | null;
  ttlTimer: ReturnType<typeof setTimeout>;
}

interface Seat {
  room: Room;
  role: 'host' | 'client';
  peer?: string;
  verifiedAt: number;
}

type Ack = (reply: Record<string, unknown>) => void;

export interface FakeRelay {
  /** `http://127.0.0.1:<port>`: what goes in `arcaidBaseUrl`. */
  url: string;
  /** Messages dropped, by cause. */
  dropped: { size: number; rate: number; noHost: number };
  /** `match:relay` events forwarded, per device. */
  relayed: Map<string, number>;
  /** `match:join` asked and answered `no_such_match`, per device. */
  misses: Map<string, number>;
  /** `match:error` words sent, in order. */
  errors: string[];
  /** The largest `data` forwarded, in bytes. */
  largest(): number;
  rooms(): string[];
  /** The peer ids in a room. */
  peers(code: string): string[];
  locked(code: string): boolean;
  /** Cut every socket of a device from the server side (a network blip: socket.io reconnects). */
  dropDevice(deviceId: string): void;
  /** The device's pairing is revoked: it no longer verifies. */
  revoke(deviceId: string): void;
  /** Close every room as the server does, the sockets staying up (`expired`, `server_restart`). */
  closeRooms(reason: string): void;
  /**
   * Test hook, not a server behaviour: take a client out of its room without telling anyone, so the host holds a peer
   * the server does not (what `no_such_peer` then answers).
   */
  forget(code: string, peer: string): void;
  /** The process restarts (an ArcAid deploy): every room and counter is lost, every socket cut, and nothing listens for `downMs`. */
  restart(downMs?: number): Promise<void>;
  close(): Promise<void>;
}

const CODE = /^[A-Z]{6}$/;
const MINUTE = 60_000;
const MISS_WINDOW_MS = 10 * MINUTE;
const LOCKOUT_MS = 15 * MINUTE;

export async function startFakeRelay(opts: FakeRelayOptions): Promise<FakeRelay> {
  const hostGraceMs = opts.hostGraceMs ?? 30_000;
  const roomTtlMs = opts.roomTtlMs ?? 12 * 3600_000;
  const maxSockets = opts.maxSockets ?? 8;
  const maxRooms = opts.maxRooms ?? 2000;
  const maxBytes = opts.maxBytes ?? 256 * 1024;
  const rate = opts.rate ?? { limit: 200, windowMs: 10_000 };
  const perDevice = opts.attemptsPerMinute ?? 20;
  const perAddress = perDevice * 3;
  const missLimit = opts.missLimit ?? 8;
  const reverifyMs = opts.reverifyMs ?? 60_000;
  const devices: Record<string, string> = { ...opts.devices };

  const rooms = new Map<string, Room>();
  const seats = new Map<string, Seat>();
  const hostedBy = new Map<string, Room>();
  const socketWindows = new Map<string, Window>();
  const attempts = new Map<string, { start: number; count: number }>();
  const missState = new Map<string, { start: number; count: number; lockedUntil: number }>();
  const dropped = { size: 0, rate: 0, noHost: 0 };
  const relayed = new Map<string, number>();
  const misses = new Map<string, number>();
  const errors: string[] = [];
  let largest = 0;

  const authOf = (s: Socket): { deviceId: string; deviceToken: string } => {
    const a = s.handshake.auth as { deviceId?: unknown; deviceToken?: unknown } | null | undefined;
    return { deviceId: typeof a?.deviceId === 'string' ? a.deviceId : '', deviceToken: typeof a?.deviceToken === 'string' ? a.deviceToken : '' };
  };
  /** The device check is a database read on the server: never in the same tick. */
  const deviceOf = async (s: Socket): Promise<string | null> => {
    await new Promise((r) => setImmediate(r));
    const { deviceId, deviceToken } = authOf(s);
    return deviceId !== '' && deviceToken !== '' && devices[deviceId] === deviceToken ? deviceId : null;
  };
  const sendError = (s: Socket, error: string): void => {
    errors.push(error);
    s.emit('match:error', { error });
  };

  const overAttempts = (key: string, max: number): boolean => {
    const now = Date.now();
    const w = attempts.get(key);
    if (!w || now - w.start >= MINUTE) {
      attempts.set(key, { start: now, count: 1 });
      return false;
    }
    w.count += 1;
    return w.count > max;
  };
  const lockedOut = (key: string): boolean => (missState.get(key)?.lockedUntil ?? 0) > Date.now();
  const recordMiss = (key: string): void => {
    const now = Date.now();
    let m = missState.get(key);
    if (!m || now - m.start >= MISS_WINDOW_MS) {
      m = { start: now, count: 0, lockedUntil: 0 };
      missState.set(key, m);
    }
    m.count += 1;
    if (m.count >= missLimit) m.lockedUntil = now + LOCKOUT_MS;
  };

  /** The front door of `match:host` and `match:join`: the address limit, the device check, the device limit. */
  const admit = async (s: Socket): Promise<{ device: string; deviceKey: string } | { error: string }> => {
    // The address has an attempt cap only: it is never locked out for the misses of the devices behind it.
    if (overAttempts(`ip:${s.handshake.address}`, perAddress)) return { error: 'rate_limited' };
    const device = await deviceOf(s);
    if (!device) return { error: 'unauthorized' };
    const deviceKey = `dev:${device}`;
    if (lockedOut(deviceKey) || overAttempts(deviceKey, perDevice)) return { error: 'rate_limited' };
    return { device, deviceKey };
  };

  const closeRoom = (room: Room, reason: string): void => {
    if (rooms.get(room.code) !== room) return;
    rooms.delete(room.code);
    if (hostedBy.get(room.owner) === room) hostedBy.delete(room.owner);
    if (room.graceTimer) clearTimeout(room.graceTimer);
    clearTimeout(room.ttlTimer);
    for (const client of room.clients.values()) {
      seats.delete(client.id);
      client.emit('match:closed', { reason });
    }
    room.clients.clear();
    room.hostWindows.clear();
    if (room.host) {
      seats.delete(room.host.id);
      room.host.emit('match:closed', { reason });
      room.host = null;
    }
  };

  /** Take a socket out of its seat. A host leaving on purpose closes its room at once (and is not told). */
  const vacate = (s: Socket, hostReason: string): void => {
    const seat = seats.get(s.id);
    if (!seat) return;
    seats.delete(s.id);
    if (seat.role === 'host') {
      if (seat.room.host?.id === s.id) {
        seat.room.host = null;
        closeRoom(seat.room, hostReason);
      }
      return;
    }
    if (seat.peer && seat.room.clients.get(seat.peer) === s) {
      seat.room.clients.delete(seat.peer);
      seat.room.hostWindows.delete(seat.peer);
      seat.room.host?.emit('match:peer', { peer: seat.peer, state: 'left' });
    }
  };

  const onHost = async (s: Socket, payload: unknown, ack: Ack): Promise<void> => {
    const gate = await admit(s);
    if ('error' in gate) return ack({ ok: false, error: gate.error });
    const { device } = gate;
    const code = (payload as { code?: unknown } | null)?.code;
    if (typeof code !== 'string' || !CODE.test(code)) return ack({ ok: false, error: 'bad_code' });

    const existing = rooms.get(code);
    if (existing) {
      if (existing.owner !== device) return ack({ ok: false, error: 'code_in_use' });
      if (existing.host && existing.host.id !== s.id) seats.delete(existing.host.id);
      const held = seats.get(s.id);
      if (held && !(held.room === existing && held.role === 'host')) vacate(s, 'host_left');
      if (existing.graceTimer) clearTimeout(existing.graceTimer);
      existing.graceTimer = null;
      existing.host = s;
      seats.set(s.id, { room: existing, role: 'host', verifiedAt: Date.now() });
      const peers = [...existing.clients.keys()];
      ack({ ok: true, peers });
      for (const peer of peers) s.emit('match:peer', { peer, state: 'joined' });
      return;
    }

    vacate(s, 'host_left');
    const previous = hostedBy.get(device);
    if (previous) closeRoom(previous, 'replaced');
    if (rooms.size >= maxRooms) return ack({ ok: false, error: 'server_busy' });
    const room: Room = {
      code,
      owner: device,
      host: s,
      clients: new Map(),
      hostWindows: new Map(),
      locked: false,
      seated: new Set([device]),
      graceTimer: null,
      ttlTimer: setTimeout(() => closeRoom(room, 'expired'), roomTtlMs),
    };
    rooms.set(code, room);
    hostedBy.set(device, room);
    seats.set(s.id, { room, role: 'host', verifiedAt: Date.now() });
    ack({ ok: true, peers: [] });
  };

  const onJoin = async (s: Socket, payload: unknown, ack: Ack): Promise<void> => {
    const gate = await admit(s);
    if ('error' in gate) return ack({ ok: false, error: gate.error });
    const { device, deviceKey } = gate;
    const code = (payload as { code?: unknown } | null)?.code;
    const room = typeof code === 'string' && CODE.test(code) ? rooms.get(code) : undefined;
    if (!room) {
      recordMiss(deviceKey);
      misses.set(device, (misses.get(device) ?? 0) + 1);
      return ack({ ok: false, error: 'no_such_match' });
    }
    // Not a miss: the code was right.
    if (room.locked && !room.seated.has(device)) return ack({ ok: false, error: 'locked' });
    const seat = seats.get(s.id);
    if (seat?.room === room && seat.role === 'client') {
      seat.verifiedAt = Date.now();
      return ack({ ok: true, peer: seat.peer });
    }
    if (seat?.room === room && seat.role === 'host') return ack({ ok: false, error: 'unauthorized' });
    if (room.clients.size + 1 >= maxSockets) return ack({ ok: false, error: 'full' });
    vacate(s, 'host_left');
    const peer = randomBytes(9).toString('base64url');
    room.clients.set(peer, s);
    room.seated.add(device);
    seats.set(s.id, { room, role: 'client', peer, verifiedAt: Date.now() });
    ack({ ok: true, peer });
    room.host?.emit('match:peer', { peer, state: 'joined' });
  };

  /** One fixed window; false when this frame is over the limit (one `rate_limited` per window). */
  const underRate = (s: Socket, windows: Map<string, Window>, key: string): boolean => {
    const now = Date.now();
    let w = windows.get(key);
    if (!w || now - w.start >= rate.windowMs) {
      w = { start: now, count: 0, warned: false };
      windows.set(key, w);
    }
    w.count += 1;
    if (w.count <= rate.limit) return true;
    dropped.rate += 1;
    if (!w.warned) {
      w.warned = true;
      sendError(s, 'rate_limited');
    }
    return false;
  };

  /** A seated device is read again once its last check is older than `reverifyMs`; the frame is not held back. */
  const reverify = (s: Socket, seat: Seat): void => {
    const now = Date.now();
    if (now - seat.verifiedAt < reverifyMs) return;
    seat.verifiedAt = now;
    void deviceOf(s).then((device) => {
      if (device || seats.get(s.id) !== seat) return;
      sendError(s, 'unauthorized');
      if (seat.role === 'host') closeRoom(seat.room, 'host_gone');
      else vacate(s, 'host_gone');
    });
  };

  const onRelay = (s: Socket, payload: unknown): void => {
    const seat = seats.get(s.id);
    const body = payload as { data?: unknown; to?: unknown } | null;
    const target = seat?.role === 'host' && typeof body?.to === 'string' ? seat.room.clients.get(body.to) : undefined;
    const allowed = target ? underRate(s, seat!.room.hostWindows, body!.to as string) : underRate(s, socketWindows, s.id);
    if (!allowed) return;
    if (!seat) {
      void deviceOf(s).then((device) => sendError(s, device ? 'not_in_match' : 'unauthorized'));
      return;
    }
    reverify(s, seat);
    const data = body?.data;
    if (typeof data !== 'string') return sendError(s, 'invalid_message');
    const bytes = Buffer.byteLength(data, 'utf8');
    if (bytes > maxBytes) {
      dropped.size += 1;
      return sendError(s, 'too_large');
    }
    const device = authOf(s).deviceId;
    if (seat.role === 'client') {
      if (!seat.room.host) {
        dropped.noHost += 1;
        return;
      }
      relayed.set(device, (relayed.get(device) ?? 0) + 1);
      largest = Math.max(largest, bytes);
      seat.room.host.emit('match:relay', { from: seat.peer, data });
      return;
    }
    if (!target) return sendError(s, 'no_such_peer');
    relayed.set(device, (relayed.get(device) ?? 0) + 1);
    largest = Math.max(largest, bytes);
    target.emit('match:relay', { data });
  };

  const onDisconnect = (s: Socket): void => {
    socketWindows.delete(s.id);
    const seat = seats.get(s.id);
    if (!seat) return;
    if (seat.role === 'client') return vacate(s, 'host_left');
    seats.delete(s.id);
    const room = seat.room;
    if (room.host?.id !== s.id) return;
    room.host = null;
    room.graceTimer = setTimeout(() => closeRoom(room, 'host_gone'), hostGraceMs);
  };

  const asAck = (v: unknown): Ack => (typeof v === 'function' ? (v as Ack) : () => undefined);

  let http: HttpServer;
  let io: Server;
  let port = 0;
  const boot = async (): Promise<void> => {
    http = createServer();
    io = new Server(http, { path: opts.path ?? '/socket.io', maxHttpBufferSize: 1e6 });
    io.on('connection', (socket) => {
      socket.on('match:host', (p: unknown, ack: unknown) => void onHost(socket, p, asAck(ack)));
      socket.on('match:join', (p: unknown, ack: unknown) => void onJoin(socket, p, asAck(ack)));
      socket.on('match:leave', (p: unknown, ack: unknown) => {
        vacate(socket, 'host_left');
        asAck(typeof p === 'function' ? p : ack)({ ok: true });
      });
      socket.on('match:lock', (p: unknown, ack: unknown) => {
        const reply = asAck(typeof p === 'function' ? p : ack);
        const seat = seats.get(socket.id);
        if (seat?.role !== 'host') return reply({ ok: false, error: 'unauthorized' });
        seat.room.locked = true;
        reply({ ok: true });
      });
      socket.on('match:relay', (p: unknown) => onRelay(socket, p));
      socket.on('disconnect', () => onDisconnect(socket));
    });
    // The port of the first boot is kept: a restarted server is at the same address.
    for (let k = 0; ; k++) {
      try {
        await new Promise<void>((resolve, reject) => {
          http.once('error', reject);
          http.listen(port, '127.0.0.1', () => {
            http.off('error', reject);
            resolve();
          });
        });
        break;
      } catch (e) {
        if (k >= 20) throw e;
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    port = (http.address() as AddressInfo).port;
  };

  const forgetAll = (): void => {
    for (const room of rooms.values()) {
      if (room.graceTimer) clearTimeout(room.graceTimer);
      clearTimeout(room.ttlTimer);
    }
    rooms.clear();
    seats.clear();
    hostedBy.clear();
    socketWindows.clear();
    attempts.clear();
    missState.clear();
  };

  await boot();
  let closed = false;

  return {
    url: `http://127.0.0.1:${port}`,
    dropped,
    relayed,
    misses,
    errors,
    largest: () => largest,
    rooms: () => [...rooms.keys()],
    peers: (code) => [...(rooms.get(code)?.clients.keys() ?? [])],
    locked: (code) => rooms.get(code)?.locked ?? false,
    dropDevice(deviceId) {
      for (const s of io.sockets.sockets.values()) if (authOf(s).deviceId === deviceId) s.disconnect(true);
    },
    revoke(deviceId) {
      delete devices[deviceId];
    },
    closeRooms(reason) {
      for (const room of [...rooms.values()]) closeRoom(room, reason);
    },
    forget(code, peer) {
      const room = rooms.get(code);
      const s = room?.clients.get(peer);
      if (!room || !s) return;
      room.clients.delete(peer);
      room.hostWindows.delete(peer);
      seats.delete(s.id);
    },
    async restart(downMs = 0) {
      forgetAll();
      await io.close();
      if (downMs > 0) await new Promise((r) => setTimeout(r, downMs));
      if (!closed) await boot();
    },
    async close() {
      closed = true;
      forgetAll();
      await io.close();
    },
  };
}
