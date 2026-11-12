/**
 * D10.8: the relay transports against the in-process fake relay (relay-fake.test-support.ts), which implements the
 * ArcAid contract: joins and leaves, ordered delivery both ways, the refusals by name, a host socket that drops and
 * takes its room back (RELINK, then the client's opening frame), `match:closed`, and the pacer under the rate limit.
 * Then the server as built (2026-11-12): the device refused in the ack, `match:error`, a room the server lost (a
 * restart, `expired`), `match:leave`, `match:lock`; and, with bare sockets, the fake's own answers that the transports
 * do not exercise, so the fake stays the server's double.
 */
import { createServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { buildMessage, PROTOCOL_VERSION, type AnyMessage } from '@castcade/protocol';
import { startFakeRelay, type FakeRelay } from './relay-fake.test-support.js';
import { CompositeTransport, RelayClientTransport, RelayError, RelayHostTransport, RelayPacer, relayEndpoint, RELINK, type RelayOptions } from './transport-relay.js';
import { WsPeerTransport } from './transport-ws.js';

const ZERO = '0'.repeat(64);
const KEY = Buffer.alloc(32, 7).toString('base64');
const hello = (from: string, code = 'RELAYA'): AnyMessage =>
  buildMessage(
    'HELLO',
    {
      protocolVersion: PROTOCOL_VERSION,
      companionVersion: 'test',
      throwdownCode: code,
      participant: { playerId: from, displayName: from, publicKey: KEY, rig: 'pc' },
      game: { kind: 'vpx', tableName: 'T', tableHash: ZERO, romName: null, romHash: null, physicsHash: null, recipeVersion: null, sidecarHash: null, emulatorVersion: 'x' },
    },
    { matchId: null, seq: 1, from },
  );
const resume = (from: string, seq: number): AnyMessage => buildMessage('RESUME', {}, { matchId: 'M', seq, from, ts: seq });
const state = (from: string, seq: number): AnyMessage => buildMessage('STATE', { ballNumber: 1, score: seq, ballInPlay: true, tilt: false }, { matchId: 'M', seq, from, ts: seq });

const until = async (cond: () => boolean, ms = 4000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

const DEVICES = { 'dev-h': 'tok-h', 'dev-a': 'tok-a', 'dev-b': 'tok-b', 'dev-c': 'tok-c' };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
let relay: FakeRelay | null = null;
const open: { close(): void }[] = [];
afterEach(async () => {
  for (const t of open.splice(0)) t.close();
  await relay?.close();
  relay = null;
});

const optsFor = (r: FakeRelay, id: string, extra: Partial<RelayOptions> = {}): RelayOptions => ({
  localId: id,
  baseUrl: r.url,
  auth: { deviceId: `dev-${id}`, deviceToken: `tok-${id}` },
  connectTimeoutMs: 1500,
  ackTimeoutMs: 1500,
  ...extra,
});
const hostOn = (r: FakeRelay, extra: Partial<RelayOptions> = {}): RelayHostTransport => {
  const t = new RelayHostTransport(optsFor(r, 'h', extra));
  open.push(t);
  return t;
};
const clientOn = (r: FakeRelay, id: 'a' | 'b' | 'c', extra: Partial<RelayOptions> = {}): RelayClientTransport => {
  const t = new RelayClientTransport(optsFor(r, id, extra));
  open.push(t);
  return t;
};

/** What the engine does after a leave: ask for the link again until it is there (HELLO stands in for RECONNECT here). */
const comeBack = async (c: RelayClientTransport, id: string, host = 'h'): Promise<void> => {
  for (let k = 0; ; k++) {
    try {
      await c.connectTo(host, () => hello(id));
      return;
    } catch (e) {
      if (k >= 60) throw e;
      await sleep(100);
    }
  }
};
/** Asks further apart than the test's restart is long, and enough of them: the host may come back a moment after a client. */
const PATIENT = { rejoin: { gapsMs: [300, 600, 1200, 2400] } } as const;

/** A bare socket.io client, for what the transports never send. */
const bare = async (r: FakeRelay, id: string, token = `tok-${id}`): Promise<ClientSocket> => {
  const s = ioClient(r.url, { auth: { deviceId: `dev-${id}`, deviceToken: token }, transports: ['websocket'], forceNew: true, reconnection: false });
  open.push({ close: () => s.disconnect() });
  await new Promise<void>((res, rej) => {
    s.once('connect', () => res());
    s.once('connect_error', rej);
  });
  return s;
};
const ask = (s: ClientSocket, event: string, payload: unknown = {}): Promise<Record<string, unknown>> =>
  new Promise((res, rej) => s.timeout(1500).emit(event, payload, (err: Error | null, ack: Record<string, unknown>) => (err ? rej(err) : res(ack))));
/** Every `event` a bare socket got, as its payloads. */
const heard = (s: ClientSocket, event: string): Record<string, unknown>[] => {
  const got: Record<string, unknown>[] = [];
  s.on(event, (p: Record<string, unknown>) => got.push(p));
  return got;
};

/** What a transport saw, as strings in arrival order. */
const watch = (t: { onMessage: RelayHostTransport['onMessage']; onPeerJoin: RelayHostTransport['onPeerJoin']; onPeerLeave: RelayHostTransport['onPeerLeave'] }): string[] => {
  const seen: string[] = [];
  t.onPeerJoin((p) => seen.push(`join ${p}`));
  t.onPeerLeave((p) => seen.push(`leave ${p}`));
  t.onMessage((from, m) => seen.push(`${from}:${m.type}:${m.seq}`));
  return seen;
};

describe('relay transports (D10.8)', () => {
  it('host and two clients: a link opens with HELLO, frames arrive in order both ways, a client that goes is a leave', async () => {
    const r = (relay = await startFakeRelay({ devices: DEVICES }));
    const h = hostOn(r);
    const hSeen = watch(h);
    await h.host('RELAYA');
    expect(h.state).toBe('registered');
    expect(r.rooms()).toEqual(['RELAYA']);

    const a = clientOn(r, 'a');
    const b = clientOn(r, 'b');
    const aSeen = watch(a);
    const bSeen = watch(b);
    await a.connect('relaya');
    await b.connect('RELAYA');
    expect(a.peerId).toMatch(/.+/);
    expect(a.peerId).not.toBe(b.peerId);
    // Joined the room, but no link at the host until the opening frame.
    expect(h.peers()).toEqual([]);
    a.send('all', hello('a'));
    for (let i = 2; i <= 40; i++) a.send('all', resume('a', i));
    b.send('all', hello('b'));
    await until(() => hSeen.includes('a:RESUME:40') && hSeen.includes('b:HELLO:1'));
    // The two clients are two sockets: their frames interleave at the host as the network has them, so each client's
    // are checked on their own. Order is per link.
    const ofA = hSeen.filter((s) => s === 'join a' || s.startsWith('a:'));
    expect(ofA).toEqual(['join a', 'a:HELLO:1', ...Array.from({ length: 39 }, (_, i) => `a:RESUME:${i + 2}`)]);
    expect(hSeen.filter((s) => s === 'join b' || s.startsWith('b:'))).toEqual(['join b', 'b:HELLO:1']);
    expect(hSeen).toHaveLength(43);
    expect(h.peers().sort()).toEqual(['a', 'b']);

    // Host -> one client, then -> all; the client learns the host's id from the first frame.
    h.send('a', resume('h', 1));
    for (let i = 2; i <= 30; i++) h.send('all', resume('h', i));
    await until(() => aSeen.includes('h:RESUME:30') && bSeen.includes('h:RESUME:30'));
    expect(aSeen).toEqual(['join h', ...Array.from({ length: 30 }, (_, i) => `h:RESUME:${i + 1}`)]);
    expect(bSeen).toEqual(['join h', ...Array.from({ length: 29 }, (_, i) => `h:RESUME:${i + 2}`)]);
    expect(a.peers()).toEqual(['h']);

    // closePeer forgets the link on purpose: no leave, and nothing more goes to that player. `a` gets 31 and then
    // 32; had 31 gone to `b` too it would have been sent before 32 was, so `a` holding 32 means `b` was skipped.
    h.closePeer('b');
    h.send('all', resume('h', 31));
    h.send('a', resume('h', 32));
    await until(() => aSeen.includes('h:RESUME:32'));
    await new Promise((res) => setTimeout(res, 50));
    expect(bSeen).toHaveLength(30);
    expect(hSeen.filter((s) => s.startsWith('leave'))).toEqual([]);

    a.close();
    await until(() => hSeen.includes('leave a'));
    expect(h.peers()).toEqual([]);
    expect(r.dropped).toEqual({ size: 0, rate: 0, noHost: 0 });
  });

  it('refusals by name: bad credentials, no such match, a code in use, a full room, ArcAid unreachable, a server without the relay', async () => {
    const r = (relay = await startFakeRelay({ devices: DEVICES, maxSockets: 2 }));
    const bad = new RelayClientTransport({ ...optsFor(r, 'a'), auth: { deviceId: 'dev-a', deviceToken: 'wrong' } });
    open.push(bad);
    await expect(bad.connect('RELAYA')).rejects.toMatchObject({ name: 'RelayError', code: 'unauthorized' });
    // ArcAid checks the device at `match:host` / `match:join`, not at connect: the socket connects, the ack refuses.
    const badHost = new RelayHostTransport({ ...optsFor(r, 'h'), auth: { deviceId: 'dev-h', deviceToken: 'wrong' } });
    open.push(badHost);
    await badHost.connect();
    await expect(badHost.host('RELAYA')).rejects.toMatchObject({ name: 'RelayError', code: 'unauthorized', message: 'ArcAid did not accept this device' });
    expect(badHost.state).toBe('off');
    expect(r.rooms()).toEqual([]);

    const a = clientOn(r, 'a');
    await expect(a.connect('NOSUCH')).rejects.toMatchObject({ code: 'no_such_match' });

    const h = hostOn(r);
    await h.host('RELAYA');
    // Another device cannot take the code; the owner can register it again (a reconnect).
    const other = new RelayHostTransport(optsFor(r, 'b'));
    open.push(other);
    await expect(other.host('RELAYA')).rejects.toMatchObject({ code: 'code_in_use' });
    await h.host('RELAYA');

    await a.connect('RELAYA');
    const b = clientOn(r, 'b');
    await expect(b.connect('RELAYA')).rejects.toMatchObject({ code: 'full' });

    // Nothing listens here.
    const dead = createServer();
    await new Promise<void>((res) => dead.listen(0, '127.0.0.1', () => res()));
    const port = (dead.address() as { port: number }).port;
    await new Promise<void>((res) => dead.close(() => res()));
    const lost = new RelayClientTransport({ ...optsFor(r, 'a'), baseUrl: `http://127.0.0.1:${port}`, connectTimeoutMs: 400 });
    open.push(lost);
    const err = await lost.connect('RELAYA').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RelayError);
    expect((err as RelayError).code).toBe('unreachable');
    // The token is never part of an error text.
    expect(String((err as Error).message)).not.toContain('tok-');
  });

  it('a server that connects but has no relay (no ack) reads as unreachable, within the ack timeout', async () => {
    const { Server } = await import('socket.io');
    const { createServer: http } = await import('node:http');
    const srv = http();
    const io = new Server(srv);
    await new Promise<void>((res) => srv.listen(0, '127.0.0.1', () => res()));
    try {
      const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
      const h = new RelayHostTransport({ localId: 'h', baseUrl: url, auth: { deviceId: 'd', deviceToken: 't' }, connectTimeoutMs: 1500, ackTimeoutMs: 300 });
      open.push(h);
      await h.connect();
      const t0 = Date.now();
      await expect(h.host('RELAYA')).rejects.toMatchObject({ code: 'unreachable' });
      expect(Date.now() - t0).toBeLessThan(1500);
      expect(h.state).toBe('off');
    } finally {
      await io.close();
    }
  });

  it('the host socket drops and comes back: its links close, the room is taken back, the clients are told to relink and resume with their opening frame', async () => {
    const r = (relay = await startFakeRelay({ devices: DEVICES, hostGraceMs: 5000 }));
    const h = hostOn(r);
    const hSeen = watch(h);
    const states: string[] = [];
    h.onState((s) => states.push(s));
    await h.host('RELAYA');
    const a = clientOn(r, 'a');
    const aSeen = watch(a);
    await a.connect('RELAYA');
    a.send('all', hello('a'));
    await until(() => hSeen.includes('a:HELLO:1'));
    h.send('a', resume('h', 1));
    await until(() => aSeen.includes('h:RESUME:1'));

    r.dropDevice('dev-h');
    await until(() => hSeen.includes('leave a'));
    // The client does not know yet: what it sends meanwhile is lost at the server.
    a.send('all', resume('a', 2));
    await until(() => states.join() === 'registered,reconnecting,registered');
    await until(() => aSeen.includes('leave h'));
    expect(r.rooms()).toEqual(['RELAYA']);
    // Until it relinks nothing goes out.
    a.send('all', resume('a', 3));
    await a.connectTo('h', () => hello('a'));
    a.send('all', resume('a', 4));
    await until(() => hSeen.includes('a:RESUME:4'));
    expect(hSeen).toEqual(['join a', 'a:HELLO:1', 'leave a', 'join a', 'a:HELLO:1', 'a:RESUME:4']);
    expect(aSeen.filter((s) => s.startsWith('join') || s.startsWith('leave'))).toEqual(['join h', 'leave h', 'join h']);
    h.send('a', resume('h', 2));
    await until(() => aSeen.includes('h:RESUME:2'));
  });

  it('a frame on no link (a host that forgot the peer) is answered with RELINK, not delivered', async () => {
    const r = (relay = await startFakeRelay({ devices: DEVICES }));
    const h = hostOn(r);
    const hSeen = watch(h);
    await h.host('RELAYA');
    const a = clientOn(r, 'a');
    const aSeen = watch(a);
    await a.connect('RELAYA');
    a.send('all', hello('a'));
    await until(() => hSeen.includes('a:HELLO:1'));
    h.send('a', resume('h', 1));
    await until(() => aSeen.includes('h:RESUME:1'));
    h.closePeer('a');
    a.send('all', resume('a', 2));
    await until(() => aSeen.includes('leave h'));
    expect(hSeen).toEqual(['join a', 'a:HELLO:1']);
    expect(RELINK).not.toMatch(/^\{/);
  });

  it('the client socket drops: both ends see a leave; connectTo joins the room again and the link is back', async () => {
    const r = (relay = await startFakeRelay({ devices: DEVICES }));
    const h = hostOn(r);
    const hSeen = watch(h);
    await h.host('RELAYA');
    const a = clientOn(r, 'a');
    const aSeen = watch(a);
    await a.connect('RELAYA');
    a.send('all', hello('a'));
    h.onMessage((_f, m) => m.type === 'HELLO' && h.send('a', resume('h', m.seq)));
    await until(() => aSeen.includes('h:RESUME:1'));
    const first = a.peerId;
    r.dropDevice('dev-a');
    await until(() => hSeen.includes('leave a') && aSeen.includes('leave h'));
    await a.connectTo('h', () => hello('a'));
    await until(() => hSeen.filter((s) => s === 'join a').length === 2);
    expect(a.peerId).not.toBe(first);
    await until(() => aSeen.filter((s) => s === 'h:RESUME:1').length === 2);
    // A relay link cannot move to a WebSocket listener.
    await expect(a.connectTo('h', () => hello('a'), { endpoint: 'ws://127.0.0.1:1' })).rejects.toThrow(/cannot move/);
  });

  it('the host gone past the grace: match:closed is a leave, and a new try says no such match', async () => {
    const r = (relay = await startFakeRelay({ devices: DEVICES, hostGraceMs: 80 }));
    const h = hostOn(r);
    await h.host('RELAYA');
    const a = clientOn(r, 'a');
    const aSeen = watch(a);
    const errors: string[] = [];
    a.onError((e) => errors.push(e.message));
    await a.connect('RELAYA');
    a.send('all', hello('a'));
    h.onMessage(() => h.send('a', resume('h', 1)));
    await until(() => aSeen.includes('h:RESUME:1'));
    // The host's socket goes without a word (`close()` would say `match:leave`).
    (h as unknown as { socket: { disconnect(): void } }).socket.disconnect();
    await until(() => aSeen.includes('leave h'));
    expect(errors.join()).toMatch(/ArcAid closed the match \(host_gone\)/);
    await expect(a.connectTo('h', () => hello('a'))).rejects.toMatchObject({ code: 'no_such_match' });
  });

  it('a frame over 256 KB is not sent and is reported; a HELLO of another protocol version is refused by name', async () => {
    const r = (relay = await startFakeRelay({ devices: DEVICES }));
    const h = hostOn(r);
    await h.host('RELAYA');
    const a = clientOn(r, 'a');
    const errors: string[] = [];
    a.onError((e) => errors.push(e.message));
    const aSeen = watch(a);
    await a.connect('RELAYA');
    const big = buildMessage('RECONNECT_ACK', { accept: false, code: 'unknown_log_hash', entries: [], logHash: ZERO, logLength: 0 }, { matchId: 'M', seq: 9, from: 'a' });
    (big.payload as { pad?: string }).pad = 'x'.repeat(300 * 1024);
    a.send('all', big);
    expect(errors.join()).toMatch(/RECONNECT_ACK is \d+ bytes, over the relay's 262144: not sent/);
    expect(r.dropped.size).toBe(0);

    // A foreign-version HELLO never decodes; the host answers REFUSE(protocol_version) as the WebSocket host does.
    const foreign = JSON.parse(JSON.stringify(hello('a'))) as { v: number };
    foreign.v = PROTOCOL_VERSION + 1;
    const raw = a as unknown as { socket: { emit(ev: string, p: unknown): void } };
    raw.socket.emit('match:relay', { data: JSON.stringify(foreign) });
    await until(() => aSeen.some((s) => s.includes(':REFUSE:')));
  });

  it('relayEndpoint: the origin, and a path in the base URL as the socket.io path prefix', () => {
    expect(relayEndpoint('https://arcaid.app')).toEqual({ origin: 'https://arcaid.app', path: '/socket.io' });
    expect(relayEndpoint('https://arcaid.app/')).toEqual({ origin: 'https://arcaid.app', path: '/socket.io' });
    expect(relayEndpoint('http://localhost:3001/arcaid/')).toEqual({ origin: 'http://localhost:3001', path: '/arcaid/socket.io' });
  });
});

describe('relay transports against the server as built (D10.8, 2026-11-12)', () => {
  /** A host with `ids` linked, each having had one frame from the host. */
  const matchOf = async (r: FakeRelay, ids: ('a' | 'b' | 'c')[], extra: { host?: Partial<RelayOptions>; client?: Partial<RelayOptions> } = {}) => {
    const h = hostOn(r, extra.host);
    const hSeen = watch(h);
    const states: string[] = [];
    const hErrors: string[] = [];
    h.onState((s) => states.push(s));
    h.onError((e) => hErrors.push(e.message));
    await h.host('RELAYA');
    const clients: Record<string, { t: RelayClientTransport; seen: string[]; errors: string[] }> = {};
    let seq = 0;
    for (const id of ids) {
      const t = clientOn(r, id, extra.client);
      const errors: string[] = [];
      t.onError((e) => errors.push(e.message));
      const seen = watch(t);
      await t.connect('RELAYA');
      t.send('all', hello(id));
      await until(() => hSeen.includes(`${id}:HELLO:1`));
      seq += 1;
      const n = seq;
      h.send(id, resume('h', n));
      await until(() => seen.includes(`h:RESUME:${n}`));
      clients[id] = { t, seen, errors };
    }
    return { h, hSeen, states, hErrors, clients };
  };
  const count = (seen: string[], what: string): number => seen.filter((s) => s === what).length;

  it('match:error is logged in plain words, once per word: a burst over the rate limit', async () => {
    const r = (relay = await startFakeRelay({ devices: DEVICES, rate: { limit: 5, windowMs: 5000 } }));
    const { hSeen, clients } = await matchOf(r, ['a']);
    const a = clients['a']!;
    // HELLO was the window's first; 10 more at once: 4 pass, 6 are dropped, and the server says so once.
    for (let i = 2; i <= 11; i++) a.t.send('all', resume('a', i));
    await until(() => a.errors.length === 1);
    expect(a.errors).toEqual(['ArcAid dropped messages from this PC: more than 200 in 10 s']);
    await sleep(50);
    expect(hSeen.filter((s) => s.startsWith('a:RESUME'))).toEqual(['a:RESUME:2', 'a:RESUME:3', 'a:RESUME:4', 'a:RESUME:5']);
    expect(r.errors).toEqual(['rate_limited']);
    expect(r.dropped.rate).toBe(6);
  });

  it('no_such_peer for a peer the host still holds: the host asks who is in the room and that link closes (a leave); the client, told it is not in the match, joins again', async () => {
    const r = (relay = await startFakeRelay({ devices: DEVICES }));
    const { h, hSeen, hErrors, clients } = await matchOf(r, ['a', 'b']);
    const a = clients['a']!;
    const b = clients['b']!;
    // The server loses `a` without a word (the test hook): the host still holds its link.
    r.forget('RELAYA', a.t.peerId!);
    h.send('a', resume('h', 10));
    await until(() => hSeen.includes('leave a'));
    expect(hErrors).toEqual(['ArcAid dropped a message for a player who is not in the room']);
    expect(h.peers()).toEqual(['b']);
    expect(hSeen).not.toContain('leave b');
    // The `match:peer joined` sent again for `b` made no second link.
    expect(count(hSeen, 'join b')).toBe(1);
    h.send('all', resume('h', 11));
    await until(() => b.seen.includes('h:RESUME:11'));

    // `a` finds out with its next frame, and comes back as a new peer.
    a.t.send('all', resume('a', 2));
    await until(() => a.seen.includes('leave h'));
    expect(a.errors).toEqual(['ArcAid dropped a message: this PC is not in the room any more']);
    await comeBack(a.t, 'a');
    await until(() => count(hSeen, 'join a') === 2);
    h.send('a', resume('h', 12));
    await until(() => a.seen.includes('h:RESUME:12'));
    expect(a.seen).not.toContain('h:RESUME:10');
  });

  it('the server restarts mid-match (a deploy): the host opens the same code again, the clients ask until it is there and resume; nobody is locked out', async () => {
    const r = (relay = await startFakeRelay({ devices: DEVICES }));
    const { h, hSeen, states, clients } = await matchOf(r, ['a', 'b'], { client: PATIENT });
    const a = clients['a']!;
    const b = clients['b']!;
    const before = [a.t.peerId, b.t.peerId];
    await r.restart(200);
    await until(() => hSeen.includes('leave a') && hSeen.includes('leave b') && a.seen.includes('leave h') && b.seen.includes('leave h'));
    await Promise.all([comeBack(a.t, 'a'), comeBack(b.t, 'b')]);
    await until(() => count(hSeen, 'join a') === 2 && count(hSeen, 'join b') === 2, 8000);
    expect(states).toEqual(['registered', 'reconnecting', 'registered']);
    expect(r.rooms()).toEqual(['RELAYA']);
    expect(r.peers('RELAYA').sort()).toEqual([a.t.peerId, b.t.peerId].sort());
    expect(before).not.toContain(a.t.peerId);
    h.send('all', resume('h', 20));
    a.t.send('all', resume('a', 20));
    await until(() => a.seen.includes('h:RESUME:20') && b.seen.includes('h:RESUME:20') && hSeen.includes('a:RESUME:20'));
    // Asking before the host was back is a miss on the server (eight lock a device out): it stayed under.
    expect(r.misses.get('dev-a') ?? 0).toBeLessThanOrEqual(5);
    expect(r.misses.get('dev-b') ?? 0).toBeLessThanOrEqual(5);
    // The old peers went with the old room: nothing was sent to them (`no_such_peer` would say so).
    expect(r.errors).toEqual([]);
  }, 30_000);

  it('match:closed reaches the host socket: `expired` and `server_restart` open the same code again and the clients relink', async () => {
    const r = (relay = await startFakeRelay({ devices: DEVICES }));
    const { h, hSeen, states, hErrors, clients } = await matchOf(r, ['a'], { client: { rejoin: { gapsMs: [100] } } });
    const a = clients['a']!;
    for (const [n, reason] of [
      [1, 'expired'],
      [2, 'server_restart'],
    ] as const) {
      r.closeRooms(reason);
      await until(() => count(hSeen, 'leave a') === n && count(a.seen, 'leave h') === n);
      await comeBack(a.t, 'a');
      await until(() => count(hSeen, 'join a') === n + 1);
      expect(r.rooms()).toEqual(['RELAYA']);
      h.send('a', resume('h', 30 + n));
      await until(() => a.seen.includes(`h:RESUME:${30 + n}`));
    }
    expect(states).toEqual(['registered', 'reconnecting', 'registered', 'reconnecting', 'registered']);
    expect(hErrors).toEqual(['ArcAid closed the room (expired); opening it again', 'ArcAid closed the room (server_restart); opening it again']);
    expect(a.errors).toEqual(['ArcAid closed the match (expired)', 'ArcAid closed the match (server_restart)']);
  }, 15_000);

  it('`replaced` (this device hosts another code from another socket) is not fought over: the first room stays closed, and its clients do not ask for it again', async () => {
    const r = (relay = await startFakeRelay({ devices: DEVICES }));
    const { hSeen, states, hErrors, clients } = await matchOf(r, ['a']);
    const a = clients['a']!;
    const second = hostOn(r);
    await second.host('RELAYB');
    await until(() => states.at(-1) === 'closed' && a.seen.includes('leave h'));
    expect(hSeen.at(-1)).toBe('leave a');
    expect(hErrors).toEqual(['ArcAid closed the room (replaced)']);
    await expect(a.t.connectTo('h', () => hello('a'))).rejects.toMatchObject({ code: 'closed', message: 'the match RELAYA was closed (replaced)' });
    await sleep(150);
    expect(r.rooms()).toEqual(['RELAYB']);
    expect(second.state).toBe('registered');
    expect(r.misses.get('dev-a') ?? 0).toBe(0);
  });

  it('a room that does not come back: the client asks a bounded number of times, further apart, then answers by itself', async () => {
    const r = (relay = await startFakeRelay({ devices: DEVICES, hostGraceMs: 50 }));
    const { h, clients } = await matchOf(r, ['a'], { client: { rejoin: { gapsMs: [80, 160], maxMisses: 3 } } });
    const a = clients['a']!;
    (h as unknown as { socket: { disconnect(): void } }).socket.disconnect();
    await until(() => a.seen.includes('leave h') && r.rooms().length === 0);
    const t0 = Date.now();
    const said: string[] = [];
    for (let k = 0; k < 8; k++) {
      said.push(
        await a.t.connectTo('h', () => hello('a')).then(
          () => 'ok',
          (e: Error) => e.message,
        ),
      );
    }
    expect(said.slice(0, 3)).toEqual(Array(3).fill('no match with the code RELAYA'));
    expect(said.slice(3)).toEqual(Array(5).fill('no match with the code RELAYA (ArcAid said so 3 times; not asking again)'));
    expect(r.misses.get('dev-a')).toBe(3);
    // The second ask waited 80 ms after the first miss, the third 160 ms after the second.
    expect(Date.now() - t0).toBeGreaterThanOrEqual(230);
  });

  it('a pairing revoked mid-match: the client is told once, in plain words, and never asks ArcAid again; the host sees a leave; a revoked host is closed for good', async () => {
    const r = (relay = await startFakeRelay({ devices: DEVICES, reverifyMs: 0 }));
    const { h, hSeen, states, hErrors, clients } = await matchOf(r, ['a', 'b']);
    const a = clients['a']!;
    const b = clients['b']!;
    r.revoke('dev-a');
    a.t.send('all', resume('a', 2));
    await until(() => a.seen.includes('leave h') && hSeen.includes('leave a'));
    expect(a.errors).toEqual(['This PC is no longer paired with ArcAid']);
    expect(r.peers('RELAYA')).toEqual([b.t.peerId]);
    for (let k = 0; k < 3; k++) {
      await expect(a.t.connectTo('h', () => hello('a'))).rejects.toMatchObject({ name: 'RelayError', code: 'unauthorized', message: 'This PC is no longer paired with ArcAid' });
    }
    // Nothing more went to the server: no join, no frame.
    a.t.send('all', resume('a', 3));
    await sleep(50);
    expect(r.errors).toEqual(['unauthorized']);
    expect(h.peers()).toEqual(['b']);

    r.revoke('dev-h');
    h.send('b', resume('h', 40));
    await until(() => states.at(-1) === 'closed' && b.seen.includes('leave h'));
    expect(hErrors).toEqual(['This PC is no longer paired with ArcAid']);
    expect(b.errors).toEqual(['ArcAid closed the match (host_gone)']);
    await sleep(150);
    expect(r.rooms()).toEqual([]);
    expect(h.state).toBe('closed');
  });

  it('match:leave: a host that closes ends the room at once (the clients are told host_left and do not ask again); a client that closes is a leave at the host', async () => {
    const r = (relay = await startFakeRelay({ devices: DEVICES }));
    const { h, hSeen, clients } = await matchOf(r, ['a', 'b']);
    const a = clients['a']!;
    const b = clients['b']!;
    b.t.close();
    await until(() => hSeen.includes('leave b'));
    expect(r.peers('RELAYA')).toEqual([a.t.peerId]);
    h.close();
    // The grace is 30 s here: the room going within a second is the leave.
    await until(() => r.rooms().length === 0 && a.seen.includes('leave h'), 1000);
    expect(a.errors).toEqual(['ArcAid closed the match (host_left)']);
    await expect(a.t.connectTo('h', () => hello('a'))).rejects.toMatchObject({ code: 'closed' });
    expect(r.misses.get('dev-a') ?? 0).toBe(0);
  });

  it('match:lock: once the host locked the room a device that was never in it is refused by name; a player who dropped comes back; a room opened again is locked again once its players are back', async () => {
    const r = (relay = await startFakeRelay({ devices: DEVICES }));
    const { h, hSeen, clients } = await matchOf(r, ['a'], { client: PATIENT });
    const a = clients['a']!;
    expect(r.locked('RELAYA')).toBe(false);
    await h.lock();
    expect(r.locked('RELAYA')).toBe(true);
    const c = clientOn(r, 'c');
    await expect(c.connect('RELAYA')).rejects.toMatchObject({ name: 'RelayError', code: 'locked', message: 'the match RELAYA has already started' });
    r.dropDevice('dev-a');
    await until(() => hSeen.includes('leave a') && a.seen.includes('leave h'));
    await comeBack(a.t, 'a');
    await until(() => count(hSeen, 'join a') === 2);

    // The server restarts: the new room knows nobody, so it is not locked until `a` is back in it.
    await r.restart(100);
    await until(() => count(hSeen, 'leave a') === 2 && count(a.seen, 'leave h') === 2);
    await until(() => h.state === 'registered' && r.rooms().length === 1, 8000);
    await sleep(100);
    expect(r.locked('RELAYA')).toBe(false);
    await comeBack(a.t, 'a');
    await until(() => count(hSeen, 'join a') === 3 && r.locked('RELAYA'), 8000);
    const again = clientOn(r, 'c');
    await expect(again.connect('RELAYA')).rejects.toMatchObject({ code: 'locked' });
  }, 30_000);

  it('match:lock after a restart does not wait for ever for a player who stays away; a server without match:lock is an error for the caller, not for the match', async () => {
    const r = (relay = await startFakeRelay({ devices: DEVICES }));
    const { h } = await matchOf(r, ['a'], { host: { relockWaitMs: 150 } });
    await h.lock();
    // `a` has no engine here: it never asks for the link again.
    await r.restart();
    await until(() => h.state === 'registered' && r.rooms().length === 1 && r.locked('RELAYA'), 8000);

    const { Server } = await import('socket.io');
    const { createServer: http } = await import('node:http');
    const srv = http();
    const io = new Server(srv);
    io.on('connection', (s) => s.on('match:host', (_p: unknown, ack: (a: unknown) => void) => ack({ ok: true })));
    await new Promise<void>((res) => srv.listen(0, '127.0.0.1', () => res()));
    try {
      const old = new RelayHostTransport({ localId: 'h', baseUrl: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, auth: { deviceId: 'd', deviceToken: 't' }, connectTimeoutMs: 1500, ackTimeoutMs: 200 });
      open.push(old);
      // An ack without `peers` (the first contract) is taken too.
      await old.host('RELAYA');
      await expect(old.lock()).rejects.toMatchObject({ code: 'unreachable' });
      expect(old.state).toBe('registered');
      old.close();
    } finally {
      await io.close();
    }
  }, 20_000);
});

describe('the fake relay answers as the ArcAid server does (D10.8): what the transports never send', () => {
  it('the device is checked at match:host / match:join, not at connect; a frame from a socket in no room is answered by name', async () => {
    const r = (relay = await startFakeRelay({ devices: DEVICES }));
    const stranger = await bare(r, 'a', 'wrong');
    expect(stranger.connected).toBe(true);
    expect(await ask(stranger, 'match:host', { code: 'RELAYA' })).toEqual({ ok: false, error: 'unauthorized' });
    expect(await ask(stranger, 'match:join', { code: 'RELAYA' })).toEqual({ ok: false, error: 'unauthorized' });
    const errs = heard(stranger, 'match:error');
    stranger.emit('match:relay', { data: 'x' });
    const paired = await bare(r, 'a');
    const errs2 = heard(paired, 'match:error');
    paired.emit('match:relay', { data: 'x' });
    await until(() => errs.length === 1 && errs2.length === 1);
    expect([errs[0], errs2[0]]).toEqual([{ error: 'unauthorized' }, { error: 'not_in_match' }]);
  });

  it('match:host acks { ok, peers }; peer ids are 12 base64url characters; join is idempotent; the host socket cannot join its own room; a host that registers again is told who is there', async () => {
    const r = (relay = await startFakeRelay({ devices: DEVICES }));
    const h = await bare(r, 'h');
    const peerEvents = heard(h, 'match:peer');
    expect(await ask(h, 'match:host', { code: 'relaya' })).toEqual({ ok: false, error: 'bad_code' });
    expect(await ask(h, 'match:host', { code: 'RELAYA' })).toEqual({ ok: true, peers: [] });
    expect(await ask(h, 'match:join', { code: 'RELAYA' })).toEqual({ ok: false, error: 'unauthorized' });
    const a = await bare(r, 'a');
    const joined = await ask(a, 'match:join', { code: 'RELAYA' });
    expect(joined).toEqual({ ok: true, peer: expect.stringMatching(/^[A-Za-z0-9_-]{12}$/) });
    expect(await ask(a, 'match:join', { code: 'RELAYA' })).toEqual(joined);
    // A malformed code is a miss like any other.
    expect(await ask(await bare(r, 'b'), 'match:join', { code: 'nope' })).toEqual({ ok: false, error: 'no_such_match' });
    expect(await ask(await bare(r, 'b'), 'match:host', { code: 'RELAYA' })).toEqual({ ok: false, error: 'code_in_use' });
    expect(await ask(h, 'match:host', { code: 'RELAYA' })).toEqual({ ok: true, peers: [joined['peer']] });
    await until(() => peerEvents.length === 2);
    expect(peerEvents).toEqual([
      { peer: joined['peer'], state: 'joined' },
      { peer: joined['peer'], state: 'joined' },
    ]);
  });

  it('one room per device: a second code from the same socket closes the first (host_left, the host is not told); from another socket it is `replaced`, and the old host socket is told', async () => {
    const r = (relay = await startFakeRelay({ devices: DEVICES }));
    const h = await bare(r, 'h');
    const hClosed = heard(h, 'match:closed');
    await ask(h, 'match:host', { code: 'RELAYA' });
    const a = await bare(r, 'a');
    const aClosed = heard(a, 'match:closed');
    await ask(a, 'match:join', { code: 'RELAYA' });
    await ask(h, 'match:host', { code: 'RELAYB' });
    await until(() => aClosed.length === 1);
    expect(aClosed).toEqual([{ reason: 'host_left' }]);
    expect(r.rooms()).toEqual(['RELAYB']);

    await ask(a, 'match:join', { code: 'RELAYB' });
    const h2 = await bare(r, 'h');
    expect(await ask(h2, 'match:host', { code: 'RELAYC' })).toEqual({ ok: true, peers: [] });
    await until(() => aClosed.length === 2 && hClosed.length === 1);
    expect(aClosed[1]).toEqual({ reason: 'replaced' });
    expect(hClosed).toEqual([{ reason: 'replaced' }]);
    expect(r.rooms()).toEqual(['RELAYC']);
  });

  it("match:leave acks ok (with or without a payload) and a host leaving closes the room; match:lock is the host's alone, and lets a seated device back in", async () => {
    const r = (relay = await startFakeRelay({ devices: DEVICES }));
    const h = await bare(r, 'h');
    await ask(h, 'match:host', { code: 'RELAYA' });
    const a = await bare(r, 'a');
    const aClosed = heard(a, 'match:closed');
    expect(await ask(a, 'match:lock')).toEqual({ ok: false, error: 'unauthorized' });
    const first = await ask(a, 'match:join', { code: 'RELAYA' });
    expect(await ask(a, 'match:lock')).toEqual({ ok: false, error: 'unauthorized' });
    expect(await ask(h, 'match:lock')).toEqual({ ok: true });
    expect(await ask(h, 'match:lock')).toEqual({ ok: true });
    expect(await ask(await bare(r, 'b'), 'match:join', { code: 'RELAYA' })).toEqual({ ok: false, error: 'locked' });
    // The seated device leaves and joins again, from a new socket too.
    expect(await ask(a, 'match:leave')).toEqual({ ok: true });
    expect(r.peers('RELAYA')).toEqual([]);
    expect(await ask(await bare(r, 'a'), 'match:join', { code: 'RELAYA' })).toMatchObject({ ok: true });
    const back = await ask(a, 'match:join', { code: 'RELAYA' });
    expect(back).toMatchObject({ ok: true });
    expect(back['peer']).not.toBe(first['peer']);
    // The lock survives the host registering again.
    await ask(h, 'match:host', { code: 'RELAYA' });
    expect(r.locked('RELAYA')).toBe(true);
    expect(await new Promise((res) => h.timeout(1500).emit('match:leave', (_e: unknown, ack: unknown) => res(ack)))).toEqual({ ok: true });
    await until(() => aClosed.length === 1);
    expect(aClosed).toEqual([{ reason: 'host_left' }]);
    expect(r.rooms()).toEqual([]);
  });

  it('the rate window: every frame counts, an oversize one too; over the limit is dropped with one rate_limited per window; the host has a window per destination', async () => {
    const r = (relay = await startFakeRelay({ devices: DEVICES, rate: { limit: 5, windowMs: 5000 }, maxBytes: 100 }));
    const h = await bare(r, 'h');
    const got = heard(h, 'match:relay');
    const hErrors = heard(h, 'match:error');
    await ask(h, 'match:host', { code: 'RELAYA' });
    const a = await bare(r, 'a');
    const b = await bare(r, 'b');
    const aErrors = heard(a, 'match:error');
    const aGot = heard(a, 'match:relay');
    const bGot = heard(b, 'match:relay');
    const pa = (await ask(a, 'match:join', { code: 'RELAYA' }))['peer'] as string;
    const pb = (await ask(b, 'match:join', { code: 'RELAYA' }))['peer'] as string;
    // Five in the window: two frames, one too large, one that is not a string, one frame. Then four more: dropped.
    a.emit('match:relay', { data: '1' });
    a.emit('match:relay', { data: '2' });
    a.emit('match:relay', { data: 'x'.repeat(101) });
    a.emit('match:relay', { data: 7 });
    a.emit('match:relay', { data: '3' });
    for (const d of ['4', '5', '6', '7']) a.emit('match:relay', { data: d });
    await until(() => aErrors.length === 3 && got.length === 3);
    await sleep(50);
    expect(got).toEqual([
      { from: pa, data: '1' },
      { from: pa, data: '2' },
      { from: pa, data: '3' },
    ]);
    expect(aErrors).toEqual([{ error: 'too_large' }, { error: 'invalid_message' }, { error: 'rate_limited' }]);

    // The host: six to `a` (one over), five to `b` (none over), one to nobody (its own window, by name).
    for (let i = 1; i <= 6; i++) h.emit('match:relay', { to: pa, data: `a${i}` });
    for (let i = 1; i <= 5; i++) h.emit('match:relay', { to: pb, data: `b${i}` });
    h.emit('match:relay', { to: 'nobody', data: 'x' });
    await until(() => hErrors.length === 2 && bGot.length === 5);
    expect(aGot.map((p) => p['data'])).toEqual(['a1', 'a2', 'a3', 'a4', 'a5']);
    expect(hErrors).toEqual([{ error: 'rate_limited' }, { error: 'no_such_peer' }]);
  });

  it('the limits on asking: server_busy, rate_limited after too many asks, and a lockout after too many wrong codes', async () => {
    const r = (relay = await startFakeRelay({ devices: DEVICES, maxRooms: 1, attemptsPerMinute: 4, missLimit: 2 }));
    const h = await bare(r, 'h');
    expect(await ask(h, 'match:host', { code: 'RELAYA' })).toEqual({ ok: true, peers: [] });
    expect(await ask(await bare(r, 'b'), 'match:host', { code: 'RELAYB' })).toEqual({ ok: false, error: 'server_busy' });
    const a = await bare(r, 'a');
    expect(await ask(a, 'match:join', { code: 'NOSUCH' })).toEqual({ ok: false, error: 'no_such_match' });
    expect(await ask(a, 'match:join', { code: 'NOSUCH' })).toEqual({ ok: false, error: 'no_such_match' });
    // Two misses: the device is locked out, for the right code too, from a new socket too; its address is not.
    expect(await ask(a, 'match:join', { code: 'RELAYA' })).toEqual({ ok: false, error: 'rate_limited' });
    expect(await ask(await bare(r, 'a'), 'match:join', { code: 'RELAYA' })).toEqual({ ok: false, error: 'rate_limited' });
    expect(await ask(await bare(r, 'c'), 'match:join', { code: 'RELAYA' })).toMatchObject({ ok: true });

    const r2 = await startFakeRelay({ devices: DEVICES, attemptsPerMinute: 3 });
    try {
      const c = await bare(r2, 'c');
      for (let k = 0; k < 3; k++) expect(await ask(c, 'match:host', { code: 'RELAYA' })).toMatchObject({ ok: true });
      expect(await ask(c, 'match:host', { code: 'RELAYA' })).toEqual({ ok: false, error: 'rate_limited' });
    } finally {
      await r2.close();
    }
  });
});

describe('RelayPacer (D10.8): under the relay rate limit', () => {
  it('emits at once while the window has room, sheds STATE inside the reserve, queues the rest in order and drains as the window frees', async () => {
    let now = 0;
    const out: number[] = [];
    const p = new RelayPacer<number>((n) => out.push(n), { limit: 10, reserve: 4, windowMs: 60, now: () => now });
    for (let i = 0; i < 6; i++) p.send(i, true);
    expect(out).toEqual([0, 1, 2, 3, 4, 5]);
    // 6 of 10 used: the last 4 are for frames that must arrive.
    p.send(100, true);
    expect(p.shed).toBe(1);
    for (let i = 6; i < 13; i++) p.send(i, false);
    expect(out).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(p.waiting).toBe(3);
    // A sheddable frame never jumps the queue.
    p.send(101, true);
    expect(p.shed).toBe(2);
    now = 61;
    await until(() => out.length === 13);
    expect(out.slice(10)).toEqual([10, 11, 12]);
    expect(p.waiting).toBe(0);
    p.send(13, false);
    p.clear();
    expect(out.at(-1)).toBe(13);
  });

  it('the host paces each destination on its own (the server has a bucket per `to`): a host up with three clients sheds nothing; one flooded destination thins out alone', async () => {
    // The fake counts like the contract (200 per 10 s, per destination for the host), scaled down: 14 per 300 ms.
    const windowMs = 300;
    const r = (relay = await startFakeRelay({ devices: { ...DEVICES, 'dev-c': 'tok-c' }, rate: { limit: 14, windowMs } }));
    // STATE is shed once 8 of a destination's 12 are used.
    const h = hostOn(r, { pace: { limit: 12, reserve: 4, windowMs } });
    await h.host('RELAYA');
    const got: Record<string, string[]> = { a: [], b: [], c: [] };
    for (const id of ['a', 'b', 'c'] as const) {
      const c = clientOn(r, id);
      c.onMessage((_f, m) => got[id]?.push(`${m.type}:${m.seq}`));
      await c.connect('RELAYA');
      c.send('all', hello(id));
    }
    await until(() => h.peers().length === 3);
    const states = (id: string): number[] => (got[id] ?? []).filter((s) => s.startsWith('STATE')).map((s) => Number(s.split(':')[1]));

    // 7 STATE to all at once: 21 emits on the socket (over 14, had the socket been one bucket), 7 per destination.
    for (let i = 1; i <= 7; i++) h.send('all', state('h', i));
    await until(() => ['a', 'b', 'c'].every((id) => states(id).length === 7));
    for (const id of ['a', 'b', 'c']) expect(states(id), id).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(h.shed).toBe(0);
    expect(r.dropped.rate).toBe(0);

    // Two windows later every bucket is empty (a timer never fires early). 30 STATE at once to `a` alone, then a
    // frame that must arrive: `a`'s STATE thins out, the frame arrives, the server drops nothing; `b` is not touched.
    await new Promise((res) => setTimeout(res, 2 * windowMs));
    for (let i = 101; i <= 130; i++) h.send('a', state('h', i));
    h.send('a', resume('h', 1000));
    for (let i = 201; i <= 205; i++) h.send('b', state('h', i));
    await until(() => got['a']?.includes('RESUME:1000') === true && states('b').length === 12);
    expect(states('a').slice(7)).toEqual([101, 102, 103, 104, 105, 106, 107, 108]);
    expect(h.shed).toBe(22);
    expect(states('b').slice(7)).toEqual([201, 202, 203, 204, 205]);
    expect(r.dropped.rate).toBe(0);
  }, 15_000);
});

describe('CompositeTransport (D10.8): a host on its listener and its relay room at once', () => {
  it('a WebSocket client and a relay client are both peers; each gets its own frames and all; leaves come from the part that holds the peer', async () => {
    const r = (relay = await startFakeRelay({ devices: DEVICES }));
    const ws = new WsPeerTransport({ localId: 'h' });
    const rh = hostOn(r);
    const host = new CompositeTransport([ws, rh]);
    open.push(host);
    const seen = watch(host);
    const endpoint = await ws.listen();
    await rh.host('RELAYA');

    const viaWs = new WsPeerTransport({ localId: 'b' });
    open.push(viaWs);
    const bSeen = watch(viaWs);
    await viaWs.connect(endpoint);
    viaWs.send('all', hello('b'));
    const a = clientOn(r, 'a');
    const aSeen = watch(a);
    await a.connect('RELAYA');
    a.send('all', hello('a'));
    await until(() => seen.includes('a:HELLO:1') && seen.includes('b:HELLO:1'));
    expect(seen.filter((s) => s.startsWith('join')).sort()).toEqual(['join a', 'join b']);

    host.send('a', resume('h', 1));
    host.send('b', resume('h', 2));
    host.send('all', resume('h', 3));
    await until(() => aSeen.includes('h:RESUME:3') && bSeen.includes('h:RESUME:3'));
    expect(aSeen.filter((s) => s.includes('RESUME'))).toEqual(['h:RESUME:1', 'h:RESUME:3']);
    expect(bSeen.filter((s) => s.includes('RESUME'))).toEqual(['h:RESUME:2', 'h:RESUME:3']);

    viaWs.close();
    await until(() => seen.includes('leave b'));
    a.close();
    await until(() => seen.includes('leave a'));
    expect(seen.filter((s) => s.startsWith('leave'))).toEqual(['leave b', 'leave a']);
  });
});
