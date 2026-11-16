/**
 * I11.4.1: the 3D watch session against the in-process ArcAid relay double (relay-fake.test-support.ts): host and join
 * by code, the roster, the signalling between two clients through the host, the player role and its hand-over, and
 * the wrong codes: an older companion that joins a watch code as a match is answered REFUSE; a watch client that types
 * a match's code ends with a sentence (a started match: `locked`; a lobby: no answer, then the timeout).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { buildMessage, PROTOCOL_VERSION, type AnyMessage } from '@castcade/protocol';
import { startFakeRelay, type FakeRelay } from '../match/relay-fake.test-support.js';
import { RelayClientTransport, RelayHostTransport } from '../match/transport-relay.js';
import type { MediaSignal } from '../media/match-media-types.js';
import { NOT_A_MATCH, NOT_A_WATCH_SESSION, WatchJoinError, WatchSession, decodeWatch, encodeWatch, looksLikeMatchFrame, signalFrom, tableFrom, type WatchSessionOptions } from './watch-session.js';

const DEVICES = { 'dev-h': 'tok-h', 'dev-a': 'tok-a', 'dev-b': 'tok-b', 'dev-c': 'tok-c', 'dev-m': 'tok-m' };
const ZERO = '0'.repeat(64);
const KEY = Buffer.alloc(32, 7).toString('base64');
const until = async (cond: () => boolean, ms = 4000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

let relay: FakeRelay | null = null;
const open: Array<{ close?(): void; leave?(): Promise<void> }> = [];
afterEach(async () => {
  for (const t of open.splice(0)) {
    if (t.leave) await t.leave().catch(() => undefined);
    else t.close?.();
  }
  await relay?.close();
  relay = null;
});

const logs: string[] = [];
const opts = (r: FakeRelay, id: string, extra: Partial<WatchSessionOptions> = {}): WatchSessionOptions => ({
  relay: { baseUrl: r.url, deviceId: `dev-${id}`, deviceToken: `tok-${id}` },
  me: { id, name: `Player ${id.toUpperCase()}` },
  appVersion: 'test',
  log: (l) => logs.push(`${id}: ${l}`),
  welcomeTimeoutMs: 1500,
  playTimeoutMs: 1500,
  relayOptions: { connectTimeoutMs: 1500, ackTimeoutMs: 1500, rejoinGapsMs: [100, 200] },
  ...extra,
});
const hostOn = async (r: FakeRelay, extra: Partial<WatchSessionOptions> = {}): Promise<WatchSession> => {
  const s = await WatchSession.host(opts(r, 'h', extra));
  open.push(s);
  return s;
};
const joinOn = async (r: FakeRelay, id: string, code: string, extra: Partial<WatchSessionOptions> = {}): Promise<WatchSession> => {
  const s = await WatchSession.join(opts(r, id, extra), code);
  open.push(s);
  return s;
};
const ids = (s: WatchSession): string[] => s.state().members.map((m) => m.id);
const offer = (n: number): MediaSignal => ({ kind: 'offer', sdp: `v=0 offer ${n}` });

describe('watch session messages', () => {
  it('encodes under its own prefix and reads back only its own', () => {
    const d = encodeWatch({ t: 'hello', id: 'x' });
    expect(d.startsWith('castcade-watch:1:')).toBe(true);
    expect(decodeWatch(d)).toEqual({ t: 'hello', id: 'x' });
    expect(decodeWatch('castcade-watch:2:{"t":"x"}')).toBeNull();
    expect(decodeWatch('castcade-relay:relink')).toBeNull();
    expect(decodeWatch('{"t":"hello"}')).toBeNull();
  });

  it('tells a match frame from anything else', () => {
    const hello = buildMessage(
      'HELLO',
      {
        protocolVersion: PROTOCOL_VERSION,
        companionVersion: 'old',
        throwdownCode: 'ABCDEF',
        participant: { playerId: 'm', displayName: 'm', publicKey: KEY, rig: 'pc' },
        game: { kind: 'vpx', tableName: 'T', tableHash: ZERO, romName: null, romHash: null, physicsHash: null, recipeVersion: null, sidecarHash: null, emulatorVersion: 'x' },
      },
      { matchId: null, seq: 1, from: 'm' },
    );
    expect(looksLikeMatchFrame(JSON.stringify(hello))).toBe('hello');
    expect(looksLikeMatchFrame('castcade-relay:relink')).toBe('other');
    expect(looksLikeMatchFrame(encodeWatch({ t: 'hello' }))).toBeNull();
    expect(looksLikeMatchFrame('not json')).toBeNull();
  });

  it('checks tables and signals from the other side', () => {
    expect(tableFrom({ name: 'Nudge Test.vpx', size: 123 })).toEqual({ name: 'Nudge Test.vpx', size: 123 });
    expect(tableFrom({ name: '..\\x.vpx', size: 1 })).toBeNull();
    expect(tableFrom({ name: 'x.vpx', size: -1 })).toBeNull();
    expect(signalFrom({ kind: 'ice', candidate: { candidate: 'c', sdpMid: '0', sdpMLineIndex: 0 } })).toEqual({ kind: 'ice', candidate: { candidate: 'c', sdpMid: '0', sdpMLineIndex: 0 } });
    expect(signalFrom({ kind: 'stereo' })).toBeNull();
    expect(signalFrom({ kind: 'offer' })).toBeNull();
  });
});

describe('WatchSession through the relay', () => {
  it('hosts with a code, lets a client join, and both see the roster', async () => {
    relay = await startFakeRelay({ devices: DEVICES });
    const h = await hostOn(relay);
    const code = h.state().code;
    expect(code).toMatch(/^[A-Z]{6}$/);
    const a = await joinOn(relay, 'a', code.toLowerCase());
    await until(() => ids(h).length === 2);
    expect(ids(h)).toEqual(['h', 'a']);
    expect(ids(a)).toEqual(['h', 'a']);
    expect(a.state()).toMatchObject({ role: 'client', hostId: 'h', me: 'a', player: null, relay: 'ok' });
    expect(h.peers()).toEqual(['a']);
    expect(a.peers()).toEqual(['h']);
  });

  it('carries the data-connection signalling both ways, and between two clients through the host', async () => {
    relay = await startFakeRelay({ devices: DEVICES });
    const h = await hostOn(relay);
    const a = await joinOn(relay, 'a', h.state().code);
    const b = await joinOn(relay, 'b', h.state().code);
    await until(() => ids(a).length === 3 && ids(b).length === 3);
    const got: Record<string, Array<[string, MediaSignal]>> = { h: [], a: [], b: [] };
    h.onSignal((f, s) => got.h!.push([f, s]));
    a.onSignal((f, s) => got.a!.push([f, s]));
    b.onSignal((f, s) => got.b!.push([f, s]));
    a.sendSignal('h', offer(1));
    h.sendSignal('a', offer(2));
    a.sendSignal('b', offer(3));
    b.sendSignal('a', { kind: 'ice', candidate: { candidate: 'candidate:1 1 udp 1 1.2.3.4 5 typ srflx', sdpMid: '0', sdpMLineIndex: 0 } });
    await until(() => got.h!.length === 1 && got.a!.length === 2 && got.b!.length === 1);
    expect(got.h).toEqual([['a', offer(1)]]);
    expect(got.b).toEqual([['a', offer(3)]]);
    expect(got.a!.map(([f]) => f).sort()).toEqual(['b', 'h']);
  });

  it('gives the player role to the first who asks, refuses a second, and frees it when the table closes', async () => {
    relay = await startFakeRelay({ devices: DEVICES });
    const h = await hostOn(relay);
    const a = await joinOn(relay, 'a', h.state().code);
    const b = await joinOn(relay, 'b', h.state().code);
    await until(() => ids(b).length === 3);
    await a.play({ name: 'Nudge Test.vpx', size: 1000 });
    expect(a.state().player).toEqual({ id: 'a', table: { name: 'Nudge Test.vpx', size: 1000 } });
    await until(() => h.state().player?.id === 'a' && b.state().player?.id === 'a');
    await expect(b.play({ name: 'Other.vpx', size: 5 })).rejects.toThrow(/Player A is playing a table now/);
    await expect(h.play({ name: 'Other.vpx', size: 5 })).rejects.toThrow(/Player A is playing/);
    a.stopPlaying();
    await until(() => h.state().player === null && b.state().player === null);
    // The testers swap: B plays now, in the same session.
    await b.play({ name: 'Nudge Test.vpx', size: 1000 });
    await until(() => a.state().player?.id === 'b');
    // The player leaving frees the role too.
    await b.leave();
    await until(() => h.state().player === null && ids(h).length === 2 && ids(a).length === 2);
    await h.play({ name: 'Nudge Test.vpx', size: 1000 });
    await until(() => a.state().player?.id === 'h');
  });

  it('answers an older companion that joins the watch code as a match with REFUSE, in words it shows', async () => {
    relay = await startFakeRelay({ devices: DEVICES });
    const h = await hostOn(relay);
    const old = new RelayClientTransport({ localId: 'm', baseUrl: relay.url, auth: { deviceId: 'dev-m', deviceToken: 'tok-m' }, connectTimeoutMs: 1500, ackTimeoutMs: 1500 });
    open.push(old);
    const got: AnyMessage[] = [];
    old.onMessage((_from, msg) => got.push(msg));
    await old.connect(h.state().code);
    const hello = buildMessage(
      'HELLO',
      {
        protocolVersion: PROTOCOL_VERSION,
        companionVersion: '0.2.43',
        throwdownCode: h.state().code,
        participant: { playerId: 'm', displayName: 'm', publicKey: KEY, rig: 'pc' },
        game: { kind: 'vpx', tableName: 'T', tableHash: ZERO, romName: null, romHash: null, physicsHash: null, recipeVersion: null, sidecarHash: null, emulatorVersion: 'x' },
      },
      { matchId: null, seq: 1, from: 'm' },
    );
    old.send('h', hello);
    await until(() => got.length === 1);
    expect(got[0]).toMatchObject({ type: 'REFUSE', payload: { code: 'other', message: NOT_A_MATCH } });
    // It never became a member.
    expect(ids(h)).toEqual(['h']);
  });

  it("ends a watch join on a match lobby's code with a sentence, after the welcome wait", async () => {
    relay = await startFakeRelay({ devices: DEVICES });
    const matchHost = new RelayHostTransport({ localId: 'm', baseUrl: relay.url, auth: { deviceId: 'dev-m', deviceToken: 'tok-m' }, connectTimeoutMs: 1500, ackTimeoutMs: 1500 });
    open.push(matchHost);
    const errors: string[] = [];
    matchHost.onError((e) => errors.push(e.message));
    await matchHost.host('MATCHA');
    const t0 = Date.now();
    const err = await WatchSession.join(opts(relay, 'a', { welcomeTimeoutMs: 600 }), 'MATCHA').then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(WatchJoinError);
    expect((err as Error).message).toBe(NOT_A_WATCH_SESSION('MATCHA'));
    expect(Date.now() - t0).toBeLessThan(3000);
    // The match host logged one frame it could not read, and gave the watch client no seat in the match.
    await until(() => errors.length > 0);
    expect(matchHost.peers()).toEqual([]);
    // The watch client left the room.
    await until(() => relay!.peers('MATCHA').length === 0);
  });

  it('says a started match is a match, a wrong code is wrong, and an unpaired PC is unpaired', async () => {
    relay = await startFakeRelay({ devices: DEVICES });
    const matchHost = new RelayHostTransport({ localId: 'm', baseUrl: relay.url, auth: { deviceId: 'dev-m', deviceToken: 'tok-m' }, connectTimeoutMs: 1500, ackTimeoutMs: 1500 });
    open.push(matchHost);
    await matchHost.host('MATCHB');
    await matchHost.lock();
    await expect(WatchSession.join(opts(relay, 'a'), 'MATCHB')).rejects.toThrow('MATCHB is a match that has started, not a 3D watch session.');
    await expect(WatchSession.join(opts(relay, 'a'), 'NOSUCH')).rejects.toThrow('Nothing is hosted on NOSUCH');
    await expect(WatchSession.join(opts(relay, 'a'), 'AB12')).rejects.toThrow('six letters');
    const stranger = { ...opts(relay, 'z'), relay: { baseUrl: relay.url, deviceId: 'dev-z', deviceToken: 'nope' } };
    await expect(WatchSession.join(stranger, 'MATCHB')).rejects.toThrow('pair it with ArcAid again');
    await expect(WatchSession.host(stranger)).rejects.toThrow('pair it with ArcAid again');
  });

  it('refuses a member over the cap, and the hosting PC joining its own session', async () => {
    relay = await startFakeRelay({ devices: DEVICES });
    const h = await hostOn(relay, { max: 2 });
    await joinOn(relay, 'a', h.state().code);
    await expect(WatchSession.join(opts(relay, 'b'), h.state().code)).rejects.toThrow('The session is full (2 PCs).');
    const self = { ...opts(relay, 'h') };
    await expect(WatchSession.join(self, h.state().code)).rejects.toThrow('This PC is hosting that session');
    expect(ids(h)).toEqual(['h', 'a']);
  });

  it("ends a client's session when the host leaves", async () => {
    relay = await startFakeRelay({ devices: DEVICES });
    const h = await hostOn(relay);
    const a = await joinOn(relay, 'a', h.state().code);
    const ended: string[] = [];
    a.onEnded((why) => ended.push(why));
    await h.leave();
    await until(() => ended.length === 1);
    expect(ended[0]).toBe('the host ended the session');
    expect(a.state().ended).toBe('the host ended the session');
  });

  it('keeps a member whose ArcAid connection drops, and takes it back when it returns', async () => {
    relay = await startFakeRelay({ devices: DEVICES });
    const h = await hostOn(relay, { awayGraceMs: 5000 });
    const a = await joinOn(relay, 'a', h.state().code);
    await until(() => ids(h).length === 2);
    const seen: boolean[] = [];
    h.onChange((st) => seen.push(st.members.find((m) => m.id === 'a')?.away ?? false));
    relay.dropDevice('dev-a');
    await until(() => seen.includes(true));
    expect(ids(h)).toEqual(['h', 'a']);
    await until(() => h.state().members.find((m) => m.id === 'a')?.away === false && a.state().relay === 'ok', 8000);
    // Signals flow again on the new socket.
    const got: MediaSignal[] = [];
    h.onSignal((_f, s) => got.push(s));
    a.sendSignal('h', offer(9));
    await until(() => got.length === 1);
  });

  it('drops a member that stays away past the grace, and frees its player role', async () => {
    relay = await startFakeRelay({ devices: DEVICES });
    const h = await hostOn(relay, { awayGraceMs: 300 });
    const a = await joinOn(relay, 'a', h.state().code, { relayOptions: { connectTimeoutMs: 1500, ackTimeoutMs: 1500, rejoinGapsMs: [100] } });
    await a.play({ name: 'Nudge Test.vpx', size: 1 });
    await until(() => h.state().player?.id === 'a');
    // The client vanishes for good (its process ended): no bye, its socket just closes.
    (a as unknown as { client: { close(): void } }).client.close();
    await until(() => ids(h).length === 1, 4000);
    expect(h.state().player).toBeNull();
  });

  it('opens the same code again after ArcAid lost the room, and asks the members for a hello', async () => {
    relay = await startFakeRelay({ devices: DEVICES });
    const h = await hostOn(relay, { awayGraceMs: 10_000 });
    const a = await joinOn(relay, 'a', h.state().code);
    await until(() => ids(h).length === 2);
    const code = h.state().code;
    relay.closeRooms('server_restart');
    await until(() => relay!.rooms().includes(code) && relay!.peers(code).length === 1, 8000);
    await until(() => h.state().members.every((m) => !m.away) && a.state().relay === 'ok', 8000);
    await a.play({ name: 'Nudge Test.vpx', size: 1 });
    await until(() => h.state().player?.id === 'a');
  });
});
