/**
 * D10.8: the relay transports against the in-process fake relay (relay-fake.test-support.ts), which implements the
 * ArcAid contract: joins and leaves, ordered delivery both ways, the refusals by name, a host socket that drops and
 * takes its room back (RELINK, then the client's opening frame), `match:closed`, and the pacer under the rate limit.
 */
import { createServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
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

const DEVICES = { 'dev-h': 'tok-h', 'dev-a': 'tok-a', 'dev-b': 'tok-b' };
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
    h.close();
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
