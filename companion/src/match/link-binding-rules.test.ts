/**
 * 2026-11-25: the rules around the one in link-binding.test.ts (a link belongs to a player once the engine has
 * accepted that link's first frame), with the real engines on the real transports wherever a transport matters:
 * - where a RECONNECT that verifies may point: never at this host, and never at a head shorter than one its player
 *   is known to have been at (the log's own floor, and the head of that player's last accepted RECONNECT);
 * - an answer goes to the link its frame came on, also for a frame in another player's name;
 * - a RECONNECT held for a host transfer is judged against the count as it stood when it was held, and what a
 *   pending new host holds is bounded;
 * - a RECONNECT with the player's own signature that is refused on a new link starts that player's ordinary grace;
 *   one without it starts nothing;
 * - a refused opening frame in every state the named player can be in, on the composite host, around a relay room
 *   that is opened again, and with a candidate that is waiting when the relay's side changes;
 * - what the host's log is told, and how often;
 * - the frames a client that does not say `resends` sends, written out, are taken by this host (until protocol 7
 *   these were the frames of 0.2.50, which this host now refuses by their version, with a sentence).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { buildMessage, PROTOCOL_VERSION, type AnyMessage, type Message } from '@castcade/protocol';
import { ClientMatch } from './client.js';
import { ManualClock } from './clock.js';
import { HostMatch } from './host.js';
import { generateKeys, signCanonical, type KeyPair } from './keys.js';
import { startFakeRelay } from './relay-fake.test-support.js';
import { MemoryBus, openCandidate, ReportGate, type LinkCandidate } from './transport.js';
import { CompositeTransport, RelayHostTransport } from './transport-relay.js';
import { WsPeerTransport } from './transport-ws.js';
import {
  aIsUp,
  ballEndAs,
  cleanup,
  CODE,
  DEVICES,
  flush,
  game,
  helloAs,
  HIGH,
  note,
  optsFor,
  participant,
  rawSocket,
  signedReconnect,
  reconnectAs,
  relayRig,
  relaySeat,
  sleep,
  TRANSPORTS,
  types,
  until,
  world,
} from './link-binding.test-support.js';

afterEach(cleanup);

const refusedAs = (code: string): { type: string; payload: { accept: boolean; code: string } } => ({ type: 'RECONNECT_ACK', payload: { accept: false, code } });

for (const [transport, makeRig] of TRANSPORTS) {
  describe(`where a RECONNECT that verifies may point (${transport})`, () => {
    it('a RECONNECT that names this host is refused and the host\'s link list does not gain its own id', async () => {
      const rig = await makeRig();
      const grant = await aIsUp(rig);
      const head = rig.host.log.head();
      const second = await rig.second();
      second.send(reconnectAs(rig, rig.hk, HIGH, { player: 'h', head, resends: false }), ballEndAs('h', grant, HIGH + 1));
      await until(() => second.frames().length >= 1 && second.shut());
      await sleep(40);
      expect(second.frames()).toHaveLength(1);
      expect(second.frames()[0]).toMatchObject(refusedAs('unknown_player'));
      expect(rig.linked()).toEqual(['a']);
      expect(rig.host.log.head()).toEqual(head);
      expect(rig.host.state.paused).toBeNull();
      expect(rig.seen).toEqual(['h:reconnectRejected:unknown_player']);
    });

    it('a RECONNECT whose head is older than the player\'s last answered grant is refused; one at that grant is taken', async () => {
      const rig = await makeRig();
      await aIsUp(rig);
      // The heads `a` has been at: the one that takes in its grant, and the one before it.
      const entries = rig.host.log.entries();
      const atGrant = rig.host.log.head();
      const beforeGrant = { hash: entries[entries.length - 2]!.hash, length: entries.length - 1 };
      rig.a.reportBallEnd(4321, 'nvram');
      await until(() => rig.host.state.currentGrant?.grant.player === 'h' && rig.a.log.head().hash === rig.host.log.head().hash);
      const head = rig.host.log.head();

      const older = await rig.second();
      older.send(reconnectAs(rig, rig.ak, HIGH, { head: beforeGrant }));
      await until(() => older.frames().length >= 1);
      await sleep(60);
      expect(older.frames()[0]).toMatchObject(refusedAs('unknown_log_hash'));
      // Nothing about the player changed, and no grace began (these engines have none: it would show at once).
      expect(rig.linked()).toEqual(['a']);
      expect(rig.host.log.head()).toEqual(head);
      expect(rig.host.snapshot().gone).toEqual([]);
      expect(rig.seen).toEqual(['h:reconnectRejected:unknown_log_hash']);

      // The head with the grant in it is what a client holds whose ball end went into a link that had dropped.
      const same = await rig.second();
      same.send(signedReconnect(CODE, 'h', 'a', atGrant, rig.ak, rig.a.session.nextSeq()));
      await until(() => same.frames().length >= 1);
      expect(same.frames()[0]).toMatchObject({ type: 'RECONNECT_ACK', payload: { accept: true, logHash: head.hash, logLength: head.length } });
      expect(rig.seen).toEqual(['h:reconnectRejected:unknown_log_hash', 'h:reconnected:a']);
    });

    it('a RECONNECT that names a shorter head than that player\'s last accepted one is refused; the same head again is taken', async () => {
      const rig = await makeRig();
      await aIsUp(rig);
      const entries = rig.host.log.entries();
      const now = rig.host.log.head();
      const shorter = { hash: entries[entries.length - 2]!.hash, length: entries.length - 1 };
      const own = (head: { hash: string; length: number }): AnyMessage => signedReconnect(CODE, 'h', 'a', head, rig.ak, rig.a.session.nextSeq());

      const first = await rig.second();
      first.send(own(now));
      await until(() => first.frames().length >= 1);
      expect(first.frames()[0]).toMatchObject({ type: 'RECONNECT_ACK', payload: { accept: true } });

      const back = await rig.second();
      back.send(own(shorter));
      await until(() => back.frames().length >= 1);
      await sleep(60);
      expect(back.frames()[0]).toMatchObject(refusedAs('unknown_log_hash'));
      expect([...new Set(rig.linked())]).toEqual(['a']);
      expect(rig.host.snapshot().gone).toEqual([]);
      expect(rig.host.state.paused).toBeNull();

      const again = await rig.second();
      again.send(own(now));
      await until(() => again.frames().length >= 1);
      expect(again.frames()[0]).toMatchObject({ type: 'RECONNECT_ACK', payload: { accept: true } });
      expect(rig.seen).toEqual(['h:reconnected:a', 'h:reconnectRejected:unknown_log_hash', 'h:reconnected:a']);
    });
  });

  describe(`an answer goes to the link its frame came on (${transport})`, () => {
    it('a frame in another player\'s name from an accepted link: the named player is sent nothing', async () => {
      const rig = await makeRig({ third: true });
      const grant = await aIsUp(rig);
      const head = rig.host.log.head();
      const b = rig.b as ClientMatch;
      const toB: string[] = [];
      b.on('reject', (x) => toB.push(`${x.refType}:${x.code}`));
      const raisedFor: string[] = [];
      rig.host.on('reject', (x) => raisedFor.push(x.to));
      const bt = b.session.transport;
      bt.send('h', ballEndAs('a', grant, HIGH));
      bt.send('h', helloAs('a', HIGH + 1));
      await until(() => toB.length === 2);
      await sleep(40);
      expect(toB).toEqual(['BALL_END:unknown_player', 'HELLO:unknown_player']);
      expect(raisedFor).toEqual(['b', 'b']);
      expect(rig.seen.filter((x) => x.startsWith('a:'))).toEqual([]);
      expect(rig.host.log.head()).toEqual(head);
      // The named player's count is where it was: its own ball end is taken.
      rig.a.reportBallEnd(4321, 'nvram');
      await until(() => rig.host.state.currentGrant?.grant.player === 'b');
      expect(rig.seen.filter((x) => x.startsWith('a:'))).toEqual([]);
    });
  });

  describe(`a RECONNECT with the player's own signature that is refused on a new link (${transport})`, () => {
    it('an unknown head, the old link still held: the player is away after the grace; when its own link then speaks it is back', async () => {
      const rig = await makeRig({ graceMs: 300 });
      const grant = await aIsUp(rig);
      const second = await rig.second();
      second.send(reconnectAs(rig, rig.ak, HIGH, { head: { hash: 'cd'.repeat(32), length: rig.host.log.length } }));
      await until(() => second.frames().length >= 1);
      expect(second.frames()[0]).toMatchObject(refusedAs('unknown_log_hash'));
      // The link is not the player's, and the grace runs as for a link that dropped: nobody is told yet.
      expect(rig.linked()).toEqual(['a']);
      expect(rig.host.snapshot().gone).toEqual(['a']);
      expect(rig.seen).toEqual(['h:reconnectRejected:unknown_log_hash']);
      await until(() => rig.seen.includes('h:peerLeft:a'));
      expect(rig.host.state.paused).toEqual({ reason: 'disconnect', player: 'a' });

      rig.a.resume();
      await until(() => (rig.a.myGrant?.grantSeq ?? 0) > grant.grantSeq);
      expect(rig.host.snapshot().gone).toEqual([]);
      expect(rig.host.state.paused).toBeNull();
      expect(rig.seen).toContain('h:reconnected:a');
    });

    it('the same frame without the player\'s signature starts nothing', async () => {
      const rig = await makeRig({ graceMs: 300 });
      await aIsUp(rig);
      const head = rig.host.log.head();
      const second = await rig.second();
      second.send(reconnectAs(rig, generateKeys(), HIGH, { head: { hash: 'cd'.repeat(32), length: rig.host.log.length } }));
      await until(() => second.frames().length >= 1);
      expect(second.frames()[0]).toMatchObject(refusedAs('bad_signature'));
      expect(rig.host.snapshot().gone).toEqual([]);
      await sleep(700);
      expect(rig.host.snapshot().gone).toEqual([]);
      expect(rig.host.state.paused).toBeNull();
      expect(rig.host.log.head()).toEqual(head);
      expect(rig.seen).toEqual(['h:reconnectRejected:bad_signature']);
    });

    it('a number that is not above the count: the grace starts; the player\'s own link speaks inside it, and nobody is ever told', async () => {
      const rig = await makeRig({ graceMs: 300 });
      await aIsUp(rig);
      const head = rig.host.log.head();
      const second = await rig.second();
      second.send(reconnectAs(rig, rig.ak, 1));
      await until(() => second.frames().length >= 1 && rig.host.snapshot().gone.length === 1);
      expect(second.frames()[0]).toMatchObject({ type: 'REJECT', payload: { refType: 'RECONNECT', code: 'unexpected_state' } });
      expect(rig.linked()).toEqual(['a']);
      rig.a.reportState({ ballNumber: 1, score: 10, ballInPlay: true, tilt: false });
      await until(() => rig.host.snapshot().gone.length === 0);
      await sleep(700);
      expect(rig.seen).toEqual(['h:reject:RECONNECT:unexpected_state']);
      expect(rig.host.state.paused).toBeNull();
      expect(rig.host.log.head()).toEqual(head);
      expect(second.frames()).toHaveLength(1);
    });
  });

  describe(`a refused opening frame, whatever state the player it names is in (${transport})`, () => {
    it('inside that player\'s grace it neither ends the grace early nor clears it; while the match is paused for that player it changes nothing either', async () => {
      const clock = new ManualClock();
      const rig = await makeRig({ graceMs: 5000, clock, retryMs: 60_000 });
      await aIsUp(rig);
      rig.dropA();
      await until(() => rig.host.snapshot().gone.includes('a'));
      const head = rig.host.log.head();
      const knock = async (): Promise<void> => {
        for (const first of [reconnectAs(rig, generateKeys(), HIGH), helloAs('a', HIGH)]) {
          const s = await rig.second();
          s.send(first);
          await until(() => s.frames().length >= 1);
        }
      };
      const refusals = ['h:reconnectRejected:bad_signature', 'h:refused:match_started'];

      await knock();
      expect(rig.host.snapshot().gone).toEqual(['a']);
      expect(rig.seen).toEqual(refusals);
      clock.advance(4999);
      expect(rig.seen).toEqual(refusals);
      clock.advance(1);
      expect(rig.seen).toEqual([...refusals, 'h:peerLeft:a', 'h:pause:a']);

      const paused = rig.host.state.paused;
      const pausedHead = rig.host.log.head();
      expect(pausedHead.length).toBe(head.length + 1);
      await knock();
      expect(rig.host.state.paused).toEqual(paused);
      expect(rig.host.log.head()).toEqual(pausedHead);
      expect(rig.host.snapshot().gone).toEqual(['a']);
      expect(rig.seen).toEqual([...refusals, 'h:peerLeft:a', 'h:pause:a', ...refusals]);
      expect(rig.linked()).toEqual([]);
    });
  });
}

describe('the composite host: a refused opening frame on one part, the named player on the other', () => {
  it('the player stays on its part and plays on; the other part gains no link; a RECONNECT of its own on the other part is taken', async () => {
    const r = (world.relay = await startFakeRelay({ devices: DEVICES }));
    const hk = generateKeys();
    const ak = generateKeys();
    const ws = new WsPeerTransport({ localId: 'h' });
    const rh = new RelayHostTransport(optsFor(r, 'h'));
    const transport = new CompositeTransport([ws, rh]);
    world.open.push(transport);
    const endpoint = await ws.listen(0, '127.0.0.1');
    await rh.host(CODE);
    const host = new HostMatch({ transport, keys: hk, matchId: CODE, ballsPerGame: 2, hostParticipant: participant('h', hk), hostGame: game, disconnectGraceMs: 0 });
    const at = new WsPeerTransport({ localId: 'a' });
    await at.connect(endpoint);
    const a = new ClientMatch({ transport: at, keys: ak, participant: participant('a', ak), game, throwdownCode: CODE, disconnectGraceMs: 0 });
    world.open.push(at, host, a);
    const seen = note(host, a);
    a.join();
    await until(() => a.isJoined && host.roster().length === 2);
    const grant = await aIsUp({ host, a });
    const head = host.log.head();

    const second = await relaySeat(r);
    second.send(reconnectAs({ a }, generateKeys(), HIGH), ballEndAs('a', grant, HIGH + 1));
    await until(() => second.frames().length >= 1 && second.shut());
    expect(second.frames()[0]).toMatchObject(refusedAs('bad_signature'));
    expect(ws.inboundPeers()).toEqual(['a']);
    expect(rh.peers()).toEqual([]);
    expect(host.log.head()).toEqual(head);
    expect(host.snapshot().gone).toEqual([]);
    expect(seen).toEqual(['h:reconnectRejected:bad_signature']);
    a.reportBallEnd(4321, 'nvram');
    await until(() => host.state.currentGrant?.grant.player === 'h' && a.log.head().hash === host.log.head().hash);
    expect(second.frames()).toHaveLength(1);

    // The player's own RECONNECT through the relay: that part holds its link from the accept on.
    const now = host.log.head();
    const own = await relaySeat(r, 'c');
    own.send(signedReconnect(CODE, 'h', 'a', now, ak, a.session.nextSeq()));
    await until(() => own.frames().length >= 1);
    expect(own.frames()[0]).toMatchObject({ type: 'RECONNECT_ACK', payload: { accept: true } });
    expect(rh.peers()).toEqual(['a']);
    host.pause('requested', null);
    await until(() => own.frames().some((m) => m.type === 'PAUSE'));
  });
});

describe('the relay: a room that had to be opened again is locked when its players are back, not before', () => {
  it('a refused opening frame in the name of an awaited player does not lock the room; that player\'s own return does', async () => {
    const rig = await relayRig({ graceMs: 3000, retryMs: 700 });
    await aIsUp(rig);
    const r = world.relay!;
    const rh = rig.relayHost as RelayHostTransport;
    await rh.lock();
    expect(r.locked(CODE)).toBe(true);
    r.closeRooms('server_restart');
    await until(() => rh.state === 'registered' && r.rooms().includes(CODE) && rig.host.snapshot().gone.includes('a'));
    expect(r.locked(CODE)).toBe(false);

    const second = await rig.second();
    second.send(reconnectAs(rig, generateKeys(), HIGH));
    await until(() => second.frames().length >= 1);
    await sleep(60);
    expect(second.frames()[0]).toMatchObject(refusedAs('bad_signature'));
    expect(r.locked(CODE)).toBe(false);
    expect(rig.linked()).toEqual([]);

    await until(() => rig.seen.includes('h:reconnected:a'));
    await until(() => r.locked(CODE));
    expect(rig.linked()).toEqual(['a']);
  });
});

describe('the relay: a candidate that is waiting when the relay\'s side changes', () => {
  it('the host\'s socket drops, or the peer leaves: no later verdict binds it, nothing is reported for it, and a peer that is still there is told to open again', async () => {
    const r = (world.relay = await startFakeRelay({ devices: DEVICES, hostGraceMs: 5000 }));
    const t = new RelayHostTransport(optsFor(r, 'h', { verdictMs: 30_000 }));
    world.open.push(t);
    await t.host(CODE);
    const candidates: LinkCandidate[] = [];
    const errors: string[] = [];
    t.onMessage((_f, _m, c) => void (c && candidates.push(c)));
    t.onError((e) => errors.push(e.message));

    const stays = await relaySeat(r, 'a');
    stays.send(helloAs('a', 1));
    await until(() => candidates.length === 1);
    expect(candidates[0]?.state).toBe('open');
    r.dropDevice('dev-h');
    await until(() => candidates[0]?.state === 'refused');
    expect(candidates[0]?.accept()).toBe(false);
    expect(t.peers()).toEqual([]);
    await until(() => t.state === 'registered' && stays.shut());

    const goes = await relaySeat(r, 'b');
    goes.send(helloAs('b', 1));
    await until(() => candidates.length === 2);
    goes.leave();
    await until(() => candidates[1]?.state === 'refused');
    expect(candidates[1]?.accept()).toBe(false);
    expect(t.peers()).toEqual([]);
    expect(errors.filter((e) => e.includes('opening frame'))).toEqual([]);
  });
});

describe('a host transfer: what a pending new host holds', () => {
  /** h, a, b, c on a MemoryBus, started; `h` has proposed `a` as the new host and `a` has no majority yet. */
  async function transferPending() {
    const bus = new MemoryBus();
    const hk = generateKeys();
    const host = new HostMatch({ transport: bus.transport('h'), keys: hk, matchId: 'M', ballsPerGame: 2, hostParticipant: participant('h', hk), hostGame: game, disconnectGraceMs: 0 });
    const keys: Record<string, KeyPair> = {};
    const clients: Record<string, ClientMatch> = {};
    for (const id of ['a', 'b', 'c']) {
      const k = (keys[id] = generateKeys());
      clients[id] = new ClientMatch({ transport: bus.transport(id), keys: k, participant: participant(id, k), game, throwdownCode: 'M', hostId: 'h', disconnectGraceMs: 0 });
      clients[id]!.join();
    }
    await flush();
    host.start();
    await flush();
    // `b` and `c` take no part by themselves from here on: what comes from them is written out below.
    clients['b']!.close();
    clients['c']!.close();
    const before = host.log.head();
    host.transferHost('a');
    await flush();
    const a = clients['a']!;
    expect(a.state.pendingTransfer?.newHost).toBe('a');
    const bt = clients['b']!.session.transport;
    const toB: AnyMessage[] = [];
    bt.onMessage((_f, m) => toB.push(m));
    // Protocol 7: written for the host to be (`a`), which is who holds it and who judges it at the commit.
    const reconnect = (seq: number, key: KeyPair = keys['b'] as KeyPair): Message<'RECONNECT'> => signedReconnect('M', 'a', 'b', before, key, seq, false);
    const ackOfB = (seq: number): AnyMessage => buildMessage('HOST_TRANSFER_ACK', { proposer: 'h', accept: true, logHash: before.hash }, { matchId: 'M', seq, from: 'b' });
    return { host, a, bt, toB, reconnect, ackOfB };
  }

  it('a RECONNECT it holds is judged at the commit against that player\'s count as it stood when it was held', async () => {
    const m = await transferPending();
    m.bt.send('a', m.reconnect(100));
    await flush();
    // A frame of the same player, under its next number, that the old host passes on meanwhile.
    m.host.session.transport.send('a', buildMessage('STATE', { ballNumber: 1, score: 10, ballInPlay: true, tilt: false }, { matchId: 'M', seq: 101, from: 'b' }));
    await flush();
    // The ack that gives the new host its majority.
    m.bt.send('all', m.ackOfB(102));
    await flush();
    expect(m.toB.filter((x) => x.type === 'REJECT')).toEqual([]);
    expect(m.toB.find((x) => x.type === 'RECONNECT_ACK')).toMatchObject({ from: 'a', payload: { accept: true } });
  });

  it('it keeps only what carries the signature of the roster player it names, lets go of entries whose link is closed, and keeps no more than sixteen', async () => {
    const m = await transferPending();
    const dropped: string[] = [];
    m.a.on('dropped', (d) => dropped.push(`${d.type}:${d.reason}`));
    const link = (): ReturnType<typeof openCandidate> => openCandidate('b', { send: () => undefined, bind: () => undefined, close: () => undefined }, 60_000);

    const unsigned = link();
    m.a.handle('b', m.reconnect(99, generateKeys()), { candidate: unsigned });
    expect(unsigned.state).toBe('refused');
    expect(dropped).toEqual(['RECONNECT:bad_signature']);

    const held = Array.from({ length: 16 }, link);
    held.forEach((c, i) => m.a.handle('b', m.reconnect(100 + i), { candidate: c }));
    expect(held.map((c) => c.state)).toEqual(Array.from({ length: 16 }, () => 'open'));
    const over = link();
    m.a.handle('b', m.reconnect(200), { candidate: over });
    expect(over.state).toBe('refused');

    // One of the links closes by itself: there is room for one more.
    held[0]!.gone();
    const next = link();
    m.a.handle('b', m.reconnect(201), { candidate: next });
    expect(next.state).toBe('open');

    // At the commit every one of them gets its verdict.
    m.bt.send('all', m.ackOfB(300));
    await flush();
    expect([...held, next].map((c) => c.state).includes('open')).toBe(false);
    expect(held[1]!.state).toBe('accepted');
  });
});

describe('what the host\'s log is told, and how often', () => {
  it('ReportGate: one report at once, then none for the gap, then one that says how many there were', async () => {
    const gate = new ReportGate(40);
    expect(gate.pass()).toBe(1);
    expect(gate.pass()).toBeNull();
    expect(gate.pass()).toBeNull();
    await sleep(60);
    expect(gate.pass()).toBe(3);
    expect(gate.pass()).toBeNull();
  });

  it('the relay: opening frames from one peer that are refused one after the other are one line', async () => {
    const rig = await relayRig();
    await aIsUp(rig);
    const second = await rig.second();
    for (const n of [1, 2, 3]) second.send(reconnectAs(rig, generateKeys(), HIGH + n));
    await until(() => second.frames().length === 3);
    expect(rig.seen).toEqual(['h:reconnectRejected:bad_signature', 'h:reconnectRejected:bad_signature', 'h:reconnectRejected:bad_signature']);
    expect(rig.errors).toEqual(['an opening frame was refused (RECONNECT for a: bad_signature)']);
  });

  for (const [transport, makeRig] of TRANSPORTS) {
    it(`frames from one connection that do not decode are one line (${transport})`, async () => {
      const rig = await makeRig();
      await aIsUp(rig);
      const second = await rig.second();
      for (const text of ['not a frame', '{"v":', '[]']) second.sendText(text);
      // One more behind them that is read, so that the three before it have been.
      second.send(reconnectAs(rig, generateKeys(), HIGH));
      await until(() => second.frames().length >= 1);
      expect(rig.errors.filter((e) => !e.includes('opening frame'))).toHaveLength(1);
      expect(rig.linked()).toEqual(['a']);
    });
  }
});

// A17 step 7 (2026-11-25): until protocol 7 this was "the frames a 0.2.50 client sends": written out with `"v":6` and
// the four-key signed body, and taken by this host. A protocol 7 host refuses a frame of version 6 before any engine
// sees it (the first test), so what is left to pin is the other thing these frames were: the frames of a client that
// does not say `resends`, which the engine still answers with the pause (A18), now in protocol 7's envelope and under
// protocol 7's signed body (the second test).
describe('the frames of a client that does not say `resends`, written out; and what a 0.2.50 client is told', () => {
  it('a 0.2.50 client (protocol 6): its HELLO is refused in its own version with the sentence, its RECONNECT with a RECONNECT_ACK that does not accept; no engine sees either', async () => {
    const hk = generateKeys();
    const ck = generateKeys();
    const ht = new WsPeerTransport({ localId: 'h' });
    const endpoint = await ht.listen(0, '127.0.0.1');
    ht.onError(() => undefined);
    const host = new HostMatch({ transport: ht, keys: hk, matchId: CODE, ballsPerGame: 2, hostParticipant: participant('h', hk), hostGame: game });
    world.open.push(ht, host);
    const raised: string[] = [];
    host.on('refused', () => raised.push('refused'));
    host.on('reconnectRejected', () => raised.push('rejected'));
    host.on('joined', () => raised.push('joined'));
    // v0.2.50 `ClientMatch.join()` and `buildReconnect()`, as that build writes them.
    const hello =
      `{"v":6,"type":"HELLO","matchId":null,"seq":1,"ts":1763900000000,"from":"c","payload":{"protocolVersion":6,"companionVersion":"0.2.50","throwdownCode":"${CODE}",` +
      `"participant":{"playerId":"c","displayName":"Player C","publicKey":"${ck.publicKeyB64}","rig":"pc"},` +
      `"game":{"kind":"vpx","tableName":"Test Table","tableHash":"${'ab'.repeat(32)}","romName":null,"romHash":null,"physicsHash":null,"recipeVersion":"0.5.0","sidecarHash":null,"emulatorVersion":"10.8.0"},"ballEndReady":true}}`;
    const head = host.log.head();
    const reconnect =
      `{"v":6,"type":"RECONNECT","matchId":"${CODE}","seq":2,"ts":1763900005000,"from":"c","payload":{"player":"c","logHash":"${head.hash}","logLength":${head.length},` +
      `"signature":"${signCanonical({ matchId: CODE, player: 'c', logHash: head.hash, logLength: head.length }, ck.privateKey)}"}}`;
    const answerTo = async (text: string): Promise<{ v: number; type: string; payload: Record<string, unknown> }> => {
      const s = new WebSocket(endpoint);
      await new Promise<void>((resolve, reject) => {
        s.once('open', () => resolve());
        s.once('error', reject);
      });
      const reply = new Promise<string>((resolve) => s.once('message', (d) => resolve(String(d))));
      s.send(text);
      const got = JSON.parse(await reply) as { v: number; type: string; payload: Record<string, unknown> };
      s.close();
      return got;
    };
    expect(await answerTo(hello)).toMatchObject({
      v: 6,
      type: 'REFUSE',
      payload: { code: 'protocol_version', message: 'This lobby needs Castcade 0.2.51 or newer (protocol 7; this PC sent 6). Update Castcade on this PC (Settings, Check for updates) and join again.' },
    });
    expect(await answerTo(reconnect)).toMatchObject({ v: 6, type: 'RECONNECT_ACK', payload: { accept: false, code: 'unknown_player' } });
    expect(raised).toEqual([]);
    expect(host.roster().map((p) => p.playerId)).toEqual(['h']);
  });

  it('its HELLO is taken into the lobby and its RECONNECT (no `resends`) brings it back; when it holds the grant the pause comes with the answer', async () => {
    const hk = generateKeys();
    const ck = generateKeys();
    const ht = new WsPeerTransport({ localId: 'h' });
    const endpoint = await ht.listen(0, '127.0.0.1');
    const host = new HostMatch({ transport: ht, keys: hk, matchId: CODE, ballsPerGame: 2, hostParticipant: participant('h', hk), hostGame: game, disconnectGraceMs: 3000 });
    world.open.push(ht, host);
    const raised: string[] = [];
    host.on('reconnected', (x) => raised.push(`reconnected:${x.playerId}:${x.quiet ? 'quiet' : 'told'}`));
    host.on('reconnectRejected', (x) => raised.push(`rejected:${x.code}`));
    host.on('refused', (x) => raised.push(`refused:${x.refuse.code}`));

    // `ClientMatch.join()` without a lobby: the envelope keys in `buildMessage`'s order, the payload in the schema's.
    const hello =
      `{"v":${PROTOCOL_VERSION},"type":"HELLO","matchId":null,"seq":1,"ts":1763900000000,"from":"c","payload":{"protocolVersion":${PROTOCOL_VERSION},"companionVersion":"0.2.51","throwdownCode":"${CODE}",` +
      `"participant":{"playerId":"c","displayName":"Player C","publicKey":"${ck.publicKeyB64}","rig":"pc"},` +
      `"game":{"kind":"vpx","tableName":"Test Table","tableHash":"${'ab'.repeat(32)}","romName":null,"romHash":null,"physicsHash":null,"recipeVersion":"0.5.0","sidecarHash":null,"emulatorVersion":"10.8.0"},"ballEndReady":true}}`;
    // A RECONNECT with four payload keys (no `resends`), the signature over protocol 7's one body, written out:
    // {lobby, host, player, match, logHash, logLength, seq}, the match's id standing for both `lobby` and `match`.
    const reconnect = (seq: number, head: { hash: string; length: number }): string =>
      `{"v":${PROTOCOL_VERSION},"type":"RECONNECT","matchId":"${CODE}","seq":${seq},"ts":1763900005000,"from":"c","payload":{"player":"c","logHash":"${head.hash}","logLength":${head.length},` +
      `"signature":"${signCanonical({ lobby: CODE, host: 'h', player: 'c', match: CODE, logHash: head.hash, logLength: head.length, seq }, ck.privateKey)}"}}`;

    const first = await rawSocket(endpoint);
    first.sendText(hello);
    await until(() => first.frames().length >= 1);
    expect(first.frames()[0]).toMatchObject({ type: 'HELLO_ACK', payload: { hostPlayerId: 'h' } });
    expect(host.roster().map((p) => p.playerId)).toEqual(['h', 'c']);
    expect(ht.inboundPeers()).toEqual(['c']);
    host.start();
    await until(() => first.frames().some((m) => m.type === 'TURN_GRANT'));

    // Its link drops while it waits; it comes back from the head it holds.
    const waiting = host.log.head();
    first.socket.terminate();
    await until(() => host.snapshot().gone.includes('c'));
    const second = await rawSocket(endpoint);
    second.sendText(reconnect(2, waiting));
    await until(() => second.frames().length >= 1);
    expect(second.frames()[0]).toMatchObject({ type: 'RECONNECT_ACK', payload: { accept: true, entries: [], logHash: waiting.hash, logLength: waiting.length } });
    expect(ht.inboundPeers()).toEqual(['c']);
    expect(host.snapshot().gone).toEqual([]);

    // Now it holds the grant: a client that does not say `resends` gets the pause with its answer (A18).
    host.localBallEnd(100, 'nvram');
    await until(() => second.frames().filter((m) => m.type === 'TURN_GRANT').length === 1);
    const up = host.log.head();
    second.socket.terminate();
    await until(() => host.snapshot().gone.includes('c'));
    const third = await rawSocket(endpoint);
    third.sendText(reconnect(3, up));
    await until(() => third.frames().length >= 1);
    const ack = third.frames()[0] as Message<'RECONNECT_ACK'>;
    expect(ack).toMatchObject({ type: 'RECONNECT_ACK', payload: { accept: true } });
    expect(ack.payload.entries.map((e) => e.message?.type)).toEqual(['PAUSE']);
    expect(ack.payload.logLength).toBe(up.length + 1);
    expect(raised).toEqual(['reconnected:c:quiet', 'reconnected:c:told']);
    expect(types(host).filter((t) => t.startsWith('PAUSE'))).toEqual(['PAUSE:h']);
  });
});

describe('`admit`: the one place a frame that opens a link is taken', () => {
  class Probe extends HostMatch {
    take(msg: Message<'HELLO'>, opts?: { keepCount?: boolean }): boolean {
      return this.admit(msg, opts);
    }
  }

  it('a HELLO starts its player\'s count over; with `keepCount` it must be above the count, so the same frame is taken once', async () => {
    const bus = new MemoryBus();
    const hk = generateKeys();
    const host = new Probe({ transport: bus.transport('h'), keys: hk, matchId: 'M', ballsPerGame: 1, hostParticipant: participant('h', hk), hostGame: game });
    const k = generateKeys();
    const hello = (seq: number): Message<'HELLO'> =>
      buildMessage('HELLO', { protocolVersion: PROTOCOL_VERSION, companionVersion: 'test', throwdownCode: 'M', participant: participant('a', k), game }, { matchId: null, seq, from: 'a' });
    expect(host.take(hello(10))).toBe(true);
    expect(host.session.lastSeqFrom('a')).toBe(10);
    // A plain HELLO opens a new connection: a lower number is the first of a new count.
    expect(host.take(hello(5))).toBe(true);
    expect(host.session.lastSeqFrom('a')).toBe(5);
    // One that keeps the count is held to it.
    expect(host.take(hello(5), { keepCount: true })).toBe(false);
    expect(host.take(hello(4), { keepCount: true })).toBe(false);
    expect(host.session.lastSeqFrom('a')).toBe(5);
    const once = hello(6);
    expect(host.take(once, { keepCount: true })).toBe(true);
    expect(host.take(once, { keepCount: true })).toBe(false);
    expect(host.session.lastSeqFrom('a')).toBe(6);
    host.close();
  });
});
