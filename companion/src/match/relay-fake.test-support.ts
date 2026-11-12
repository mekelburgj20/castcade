/**
 * D10.8: an in-process relay that implements the ArcAid match-relay contract (transport-relay.ts header,
 * docs/arcaid-side-changes.md §4), for the companion's tests and as a behavioural reference for the server:
 * socket.io v4, default namespace, handshake `auth { deviceId, deviceToken }`, the five events, the limits.
 * Everything is in memory; `data` is never read.
 *
 * As amended 2026-11-12:
 * - the host socket's rate limit is per destination: 200 `match:relay` per 10 s for each `to`, a bucket each; a
 *   client socket has one bucket of 200 per 10 s.
 * - a `match:relay` from a client while the host socket is away is dropped silently.
 * - `match:join` from a socket already in the room answers ok with the same peer id.
 * - `match:host` for a code whose room is held by another device answers `{ ok: false, error: 'code_in_use' }`.
 * - a host that re-registers is sent `match:peer { state: 'joined' }` again for every client in the room.
 *
 * Still open in the contract, chosen here: a message over the size cap or the rate limit is dropped and counted, and
 * the socket stays connected.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server, type Socket } from 'socket.io';

export interface FakeRelayOptions {
  /** deviceId -> deviceToken of the paired devices. */
  devices: Record<string, string>;
  /** How long a room outlives its host socket. Contract: 30 s. */
  hostGraceMs?: number;
  /** Room lifetime from creation. Contract: 12 h. */
  roomTtlMs?: number;
  /** Sockets per room, the host included. Contract: 8. */
  maxSockets?: number;
  /** Bytes per `data`. Contract: 256 KB. */
  maxBytes?: number;
  /** `match:relay` per window: per client socket, and per destination for the host socket. Contract: 200 per 10 s. */
  rate?: { limit: number; windowMs: number };
  /** Failed `match:join` per minute per socket before `rate_limited`. */
  joinFailuresPerMinute?: number;
  /** socket.io path, for a base URL with a path. Default `/socket.io`. */
  path?: string;
}

interface Room {
  code: string;
  hostDevice: string;
  host: Socket | null;
  /** client socket id -> peer id, and back. */
  peers: Map<string, { peer: string; socket: Socket }>;
  graceTimer: ReturnType<typeof setTimeout> | null;
  ttlTimer: ReturnType<typeof setTimeout>;
}

export interface FakeRelay {
  /** `http://127.0.0.1:<port>`: what goes in `arcaidBaseUrl`. */
  url: string;
  /** Messages dropped, by cause. */
  dropped: { size: number; rate: number; noHost: number };
  /** `match:relay` events accepted, per device. */
  relayed: Map<string, number>;
  /** The largest `data` accepted, in bytes. */
  largest(): number;
  rooms(): string[];
  /** Cut every socket of a device from the server side (a network blip: socket.io reconnects). */
  dropDevice(deviceId: string): void;
  /** Forget every room and cut every socket (a server restart). */
  restart(): void;
  close(): Promise<void>;
}

export async function startFakeRelay(opts: FakeRelayOptions): Promise<FakeRelay> {
  const hostGraceMs = opts.hostGraceMs ?? 30_000;
  const roomTtlMs = opts.roomTtlMs ?? 12 * 3600_000;
  const maxSockets = opts.maxSockets ?? 8;
  const maxBytes = opts.maxBytes ?? 256 * 1024;
  const rate = opts.rate ?? { limit: 200, windowMs: 10_000 };
  const joinFailures = opts.joinFailuresPerMinute ?? 10;

  const http: HttpServer = createServer();
  const io = new Server(http, { path: opts.path ?? '/socket.io', maxHttpBufferSize: 1024 * 1024 });
  const rooms = new Map<string, Room>();
  const dropped = { size: 0, rate: 0, noHost: 0 };
  const relayed = new Map<string, number>();
  let largest = 0;

  const deviceOf = (s: Socket): string => s.data.deviceId as string;
  const roomOf = (s: Socket): Room | null => rooms.get(s.data.room as string) ?? null;

  const closeRoom = (room: Room, reason: string): void => {
    if (rooms.get(room.code) !== room) return;
    rooms.delete(room.code);
    if (room.graceTimer) clearTimeout(room.graceTimer);
    clearTimeout(room.ttlTimer);
    for (const { socket } of room.peers.values()) {
      socket.emit('match:closed', { reason });
      socket.data.room = undefined;
    }
    if (room.host) room.host.data.room = undefined;
  };

  /** True when this `match:relay` is inside its rate window: the socket's own, or for a host the destination's. */
  const underRate = (s: Socket, to: string | null): boolean => {
    const now = Date.now();
    const buckets = (s.data.buckets as Map<string, number[]> | undefined) ?? new Map<string, number[]>();
    s.data.buckets = buckets;
    const key = to ?? '';
    const stamps = buckets.get(key) ?? [];
    buckets.set(key, stamps);
    while (stamps.length > 0 && (stamps[0] as number) <= now - rate.windowMs) stamps.shift();
    if (stamps.length >= rate.limit) return false;
    stamps.push(now);
    return true;
  };

  io.use((socket, next) => {
    const auth = socket.handshake.auth as { deviceId?: unknown; deviceToken?: unknown };
    if (typeof auth.deviceId !== 'string' || typeof auth.deviceToken !== 'string' || opts.devices[auth.deviceId] !== auth.deviceToken) {
      next(new Error('unauthorized'));
      return;
    }
    socket.data.deviceId = auth.deviceId;
    next();
  });

  io.on('connection', (socket) => {
    socket.on('match:host', (p: { code?: unknown }, ack?: (r: unknown) => void) => {
      const code = typeof p?.code === 'string' ? p.code : '';
      if (!/^[A-Z]{6}$/.test(code)) return ack?.({ ok: false, error: 'bad_code' });
      const existing = rooms.get(code);
      if (existing) {
        // The same device takes its room back inside the grace window (or replaces its own older socket).
        if (existing.hostDevice !== deviceOf(socket)) return ack?.({ ok: false, error: 'code_in_use' });
        if (existing.graceTimer) clearTimeout(existing.graceTimer);
        existing.graceTimer = null;
        if (existing.host && existing.host !== socket) existing.host.data.room = undefined;
        existing.host = socket;
        socket.data.room = code;
        socket.data.role = 'host';
        ack?.({ ok: true });
        // The host is back: it is told again who is in the room.
        for (const c of existing.peers.values()) socket.emit('match:peer', { peer: c.peer, state: 'joined' });
        return;
      }
      const room: Room = {
        code,
        hostDevice: deviceOf(socket),
        host: socket,
        peers: new Map(),
        graceTimer: null,
        ttlTimer: setTimeout(() => closeRoom(room, 'expired'), roomTtlMs),
      };
      rooms.set(code, room);
      socket.data.room = code;
      socket.data.role = 'host';
      ack?.({ ok: true });
    });

    socket.on('match:join', (p: { code?: unknown }, ack?: (r: unknown) => void) => {
      const now = Date.now();
      const fails = ((socket.data.joinFails as number[] | undefined) ?? []).filter((t) => t > now - 60_000);
      socket.data.joinFails = fails;
      if (fails.length >= joinFailures) return ack?.({ ok: false, error: 'rate_limited' });
      const code = typeof p?.code === 'string' ? p.code : '';
      const room = rooms.get(code);
      if (!room) {
        fails.push(now);
        return ack?.({ ok: false, error: 'no_such_match' });
      }
      const already = room.peers.get(socket.id);
      if (already) return ack?.({ ok: true, peer: already.peer });
      if (room.peers.size + 1 >= maxSockets) return ack?.({ ok: false, error: 'full' });
      const peer = randomUUID();
      room.peers.set(socket.id, { peer, socket });
      socket.data.room = code;
      socket.data.role = 'client';
      ack?.({ ok: true, peer });
      room.host?.emit('match:peer', { peer, state: 'joined' });
    });

    socket.on('match:relay', (p: { to?: unknown; data?: unknown }) => {
      const room = roomOf(socket);
      if (!room || typeof p?.data !== 'string') return;
      const bytes = Buffer.byteLength(p.data, 'utf8');
      if (bytes > maxBytes) {
        dropped.size += 1;
        return;
      }
      const fromHost = room.host === socket;
      if (fromHost && typeof p.to !== 'string') return;
      if (!underRate(socket, fromHost ? (p.to as string) : null)) {
        dropped.rate += 1;
        return;
      }
      relayed.set(deviceOf(socket), (relayed.get(deviceOf(socket)) ?? 0) + 1);
      largest = Math.max(largest, bytes);
      if (fromHost) {
        for (const c of room.peers.values()) {
          if (c.peer === p.to) c.socket.emit('match:relay', { data: p.data });
        }
        return;
      }
      const me = room.peers.get(socket.id);
      if (!me) return;
      if (!room.host) {
        dropped.noHost += 1;
        return;
      }
      room.host.emit('match:relay', { from: me.peer, data: p.data });
    });

    socket.on('disconnect', () => {
      const room = roomOf(socket);
      if (!room) return;
      if (room.host === socket) {
        room.host = null;
        room.graceTimer = setTimeout(() => closeRoom(room, 'host_gone'), hostGraceMs);
        return;
      }
      const me = room.peers.get(socket.id);
      if (!me) return;
      room.peers.delete(socket.id);
      room.host?.emit('match:peer', { peer: me.peer, state: 'left' });
    });
  });

  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const port = (http.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    dropped,
    relayed,
    largest: () => largest,
    rooms: () => [...rooms.keys()],
    dropDevice(deviceId) {
      for (const s of io.sockets.sockets.values()) if (deviceOf(s) === deviceId) s.disconnect(true);
    },
    restart() {
      for (const room of [...rooms.values()]) {
        rooms.delete(room.code);
        if (room.graceTimer) clearTimeout(room.graceTimer);
        clearTimeout(room.ttlTimer);
      }
      for (const s of io.sockets.sockets.values()) {
        s.data.room = undefined;
        s.disconnect(true);
      }
    },
    async close() {
      for (const room of rooms.values()) {
        if (room.graceTimer) clearTimeout(room.graceTimer);
        clearTimeout(room.ttlTimer);
      }
      rooms.clear();
      await io.close();
    },
  };
}
