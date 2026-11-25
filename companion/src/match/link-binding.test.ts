/**
 * 2026-11-25: a link belongs to a player only once the engine has accepted that link's first frame (`LinkCandidate`,
 * transport.ts), and a first frame that is refused changes nothing about the player it names: not their link, not
 * their `seq` count, not whether they count as connected. Tested with the real engines on the real transports:
 * through the relay double (relay-fake.test-support.ts) and over real WebSockets, from both sides (what the host
 * holds, and what each link is sent). Then the paths that bind a link as before: a player's own RECONNECT on a new
 * link, with the old one gone or still held; and the transports' own rule for a first frame nobody judged.
 * The rules a RECONNECT that verifies is held to are in link-binding-rules.test.ts.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { buildMessage, PROTOCOL_VERSION, type AnyMessage } from '@castcade/protocol';
import { ClientMatch } from './client.js';
import { HostMatch } from './host.js';
import { generateKeys, signCanonical, type KeyPair } from './keys.js';
import { startFakeRelay } from './relay-fake.test-support.js';
import { MemoryBus, openCandidate, type LinkCandidate, type Transport } from './transport.js';
import { RelayClientTransport, RelayHostTransport } from './transport-relay.js';
import { WsClientTransport, WsHostTransport, WsPeerTransport } from './transport-ws.js';
import {
  aIsUp,
  ballEndAs,
  cleanup,
  CODE,
  flush,
  game,
  helloAs,
  HIGH,
  note,
  optsFor,
  DEVICES,
  participant,
  rawSocket,
  signedReconnect,
  reconnectAs,
  relayRig,
  sleep,
  TRANSPORTS,
  types,
  until,
  world,
  wsRig,
  type Rig,
  type Second,
} from './link-binding.test-support.js';

afterEach(cleanup);

/** The refusals of a first frame that names the seated player `a`: what is sent, the answer, what the host raises. */
const REFUSED: { name: string; firsts: (rig: Rig) => AnyMessage[]; answer: (m: AnyMessage) => void; raised: string; line: string }[] = [
  {
    name: 'a RECONNECT refused as `bad_signature`, under two numbers',
    firsts: (rig) => [reconnectAs(rig, generateKeys(), 1), reconnectAs(rig, generateKeys(), HIGH)],
    answer: (m) => expect(m).toMatchObject({ type: 'RECONNECT_ACK', payload: { accept: false, code: 'bad_signature' } }),
    raised: 'h:reconnectRejected:bad_signature',
    line: 'an opening frame was refused (RECONNECT for a: bad_signature)',
  },
  {
    name: 'a HELLO refused as `match_started`',
    firsts: () => [helloAs('a', HIGH)],
    answer: (m) => expect(m).toMatchObject({ type: 'REFUSE', payload: { code: 'match_started' } }),
    raised: 'h:refused:match_started',
    line: 'an opening frame was refused (HELLO for a: match_started)',
  },
];

for (const [transport, makeRig] of TRANSPORTS) {
  describe(`a first frame that is refused changes nothing about the player it names (${transport})`, () => {
    for (const c of REFUSED) {
      it(`${c.name}: the player's link, count and state are as they were, the link the frame came on is closed and nothing more is read from it, and the player's next frame is taken`, async () => {
        const rig = await makeRig();
        const grant = await aIsUp(rig);
        const head = rig.host.log.head();
        const firsts = c.firsts(rig);
        const seconds: Second[] = [];
        for (const first of firsts) {
          const second = await rig.second();
          seconds.push(second);
          // The first frame and one more behind it: only a first frame is ever read from a link that is nobody's.
          second.send(first, ballEndAs('a', grant, HIGH + 1));
          await until(() => second.frames().length >= 1 && second.shut());
          c.answer(second.frames()[0] as AnyMessage);
        }
        await sleep(60);

        // The host: the link it holds for `a` is the one it held, the log has not moved, the grant stands, nobody
        // counts as away and nothing is paused. It raised the refusal and nothing else, and reported one line for each.
        const raised = firsts.map(() => c.raised);
        expect(rig.linked()).toEqual(['a']);
        expect(rig.host.log.head()).toEqual(head);
        expect(rig.host.state.currentGrant?.grant.grantSeq).toBe(grant.grantSeq);
        expect(rig.host.state.paused).toBeNull();
        expect(rig.host.snapshot().gone).toEqual([]);
        expect(rig.seen).toEqual(raised);
        expect(rig.errors).toEqual(firsts.map(() => c.line));

        // The player: still on its link, and its own next frame, under its own next number, is taken.
        rig.a.reportBallEnd(4321, 'nvram');
        await until(() => rig.host.state.currentGrant?.grant.player === 'h' && rig.a.log.head().hash === rig.host.log.head().hash);
        const last = rig.host.log.entries().filter((e) => e.message?.type === 'BALL_END').pop()?.message;
        expect(last).toMatchObject({ from: 'a', payload: { finalScore: 4321, grantSeq: grant.grantSeq } });
        expect(rig.a.state.currentGrant?.grant.player).toBe('h');

        // The other links: each was sent its answer and nothing of the match, before or after.
        await sleep(60);
        for (const second of seconds) expect(second.frames()).toHaveLength(1);
        expect(rig.seen).toEqual(raised);
        expect(rig.linked()).toEqual(['a']);
      });
    }

    it('before the start: a HELLO in the name of a player who is in the lobby is refused on its own link; that player stays in the roster and on their link, and starts with the others', async () => {
      const rig = await makeRig();
      const second = await rig.second();
      second.send(helloAs('a', HIGH));
      await until(() => second.frames().length >= 1);
      await sleep(40);
      expect(second.frames()[0]).toMatchObject({ type: 'REFUSE', payload: { code: 'duplicate_player' } });
      expect(rig.seen).toEqual(['h:refused:duplicate_player']);
      expect(rig.linked()).toEqual(['a']);
      expect(rig.host.roster().map((p) => p.playerId)).toEqual(['h', 'a']);
      rig.host.start();
      await until(() => rig.a.state.currentGrant?.grant.player === 'h');
      rig.host.localBallEnd(100, 'nvram');
      await until(() => rig.a.myGrant !== null);
      await sleep(40);
      expect(second.frames()).toHaveLength(1);
      expect(rig.seen).toEqual(['h:refused:duplicate_player']);
    });

    it('before the start: a RECONNECT in the name of a player who is in the lobby is refused on its own link, and that player stays on theirs', async () => {
      const rig = await makeRig();
      const second = await rig.second();
      second.send(reconnectAs(rig, rig.ak, HIGH));
      await until(() => second.frames().length >= 1);
      await sleep(40);
      expect(second.frames()[0]).toMatchObject({ type: 'RECONNECT_ACK', payload: { accept: false, code: 'match_not_started' } });
      expect(rig.seen).toEqual(['h:reconnectRejected:match_not_started']);
      expect(rig.linked()).toEqual(['a']);
      expect(rig.host.roster().map((p) => p.playerId)).toEqual(['h', 'a']);
      await aIsUp(rig);
      expect(second.frames()).toHaveLength(1);
    });
  });

  describe(`a player's own RECONNECT still makes a new link theirs (${transport})`, () => {
    it('while the host still holds their old link: the new link is theirs from the accepted RECONNECT on, and the old one carries nothing more', async () => {
      const rig = await makeRig();
      await aIsUp(rig);
      const head = rig.host.log.head();
      const second = await rig.second();
      // The same player on another link: its own key, its own log head, its own next number.
      second.send(signedReconnect(CODE, 'h', 'a', head, rig.ak, rig.a.session.nextSeq()));
      await until(() => second.frames().length >= 1);
      expect(second.frames()[0]).toMatchObject({ type: 'RECONNECT_ACK', payload: { accept: true, logHash: head.hash } });
      expect(rig.seen).toEqual(['h:reconnected:a']);
      expect(rig.errors).toEqual([]);
      expect([...new Set(rig.linked())]).toEqual(['a']);
      // What the host sends that player now goes to the new link.
      rig.host.pause('requested', null);
      await until(() => second.frames().some((m) => m.type === 'PAUSE'));
      expect(rig.host.snapshot().gone).toEqual([]);
    });

    it('after their link dropped: they are back on a new link by RECONNECT, inside the grace, and nobody was paused', async () => {
      const rig = await makeRig({ graceMs: 3000 });
      await aIsUp(rig);
      const head = rig.host.log.head();
      rig.dropA();
      await until(() => rig.seen.includes('a:reconnected') && rig.seen.includes('h:reconnected:a'));
      expect(rig.seen.sort()).toEqual(['a:reconnected', 'h:reconnected:a']);
      expect(rig.linked()).toEqual(['a']);
      expect(rig.host.log.head()).toEqual(head);
      rig.a.reportBallEnd(4321, 'nvram');
      await until(() => rig.host.state.currentGrant?.grant.player === 'h' && rig.a.log.head().hash === rig.host.log.head().hash);
      expect(types(rig.host).filter((t) => t.startsWith('PAUSE'))).toEqual([]);
    });
  });
}

describe('the relay: a player whose link was replaced is told to open it again, and is back by its own RECONNECT', () => {
  it('RELINK reaches the link that is no longer the player\'s, and the engine behind it resumes from its log head', async () => {
    const rig = await relayRig({ graceMs: 3000 });
    await aIsUp(rig);
    const head = rig.host.log.head();
    const second = await rig.second();
    second.send(signedReconnect(CODE, 'h', 'a', head, rig.ak, rig.a.session.nextSeq()));
    await until(() => second.frames().length >= 1);
    // The engine's own transport is on no link now; its next frame is answered with RELINK and it comes back.
    rig.a.reportState({ ballNumber: 1, score: 10, ballInPlay: true, tilt: false });
    await until(() => rig.seen.includes('a:reconnected'));
    expect(rig.seen.filter((x) => x.startsWith('h:reconnected'))).toEqual(['h:reconnected:a', 'h:reconnected:a']);
    expect(rig.linked()).toEqual(['a']);
    rig.a.reportBallEnd(4321, 'nvram');
    await until(() => rig.host.state.currentGrant?.grant.player === 'h' && rig.a.log.head().hash === rig.host.log.head().hash);
    // The link it took the place of is sent nothing of that.
    const before = second.frames().length;
    await sleep(60);
    expect(second.frames()).toHaveLength(before);
    expect(second.frames().some((m) => m.type === 'TURN_GRANT')).toBe(false);
  });
});

describe('the fixed-role WebSocket host: a socket is a player\'s once its HELLO is accepted', () => {
  it('a second socket\'s HELLO in the name of a player who is in is refused and closed; the first socket stays open and plays', async () => {
    const hk = generateKeys();
    const ak = generateKeys();
    const ht = new WsHostTransport({ localId: 'h', port: 0 });
    const port = await ht.listen();
    const host = new HostMatch({ transport: ht, keys: hk, matchId: CODE, ballsPerGame: 1, hostParticipant: participant('h', hk), hostGame: game, disconnectGraceMs: 0 });
    const at = new WsClientTransport({ localId: 'a', url: `ws://127.0.0.1:${port}` });
    await at.connect();
    const a = new ClientMatch({ transport: at, keys: ak, participant: participant('a', ak), game, throwdownCode: CODE, disconnectGraceMs: 0 });
    world.open.push(ht, at, host, a);
    const seen = note(host, a);
    a.join();
    await until(() => a.isJoined && host.roster().length === 2);

    const second = await rawSocket(`ws://127.0.0.1:${port}`);
    second.send(helloAs('a', HIGH), helloAs('a', HIGH + 1));
    await until(() => second.shut());
    expect(second.frames()).toHaveLength(1);
    expect(second.frames()[0]).toMatchObject({ type: 'REFUSE', payload: { code: 'duplicate_player' } });
    expect(seen).toEqual(['h:refused:duplicate_player']);
    expect(ht.peers()).toEqual(['a']);

    host.start();
    await until(() => a.state.currentGrant?.grant.player === 'h');
    host.localBallEnd(100, 'nvram');
    await until(() => a.myGrant !== null);
    a.reportBallEnd(200, 'nvram');
    await until(() => host.state.phase === 'ended' && a.log.head().hash === host.log.head().hash);
    expect(seen).toEqual(['h:refused:duplicate_player']);
  });
});

describe('a link that is nobody\'s is closed when its time is up, counted from the connection; it was never anybody\'s', () => {
  const hello = helloAs('x', 1);
  const more = buildMessage('RESUME', {}, { matchId: CODE, seq: 2, from: 'x' });
  /** Every frame a transport handed over, the candidate it came with, and what the transport reported. */
  const listen = (t: Transport & { onError(cb: (e: Error) => void): () => void }): { got: string[]; candidates: LinkCandidate[]; joins: string[]; leaves: string[]; errors: string[] } => {
    const out = { got: [] as string[], candidates: [] as LinkCandidate[], joins: [] as string[], leaves: [] as string[], errors: [] as string[] };
    t.onMessage((from, m, candidate) => {
      out.got.push(`${from}:${m.type}:${candidate ? 'candidate' : 'link'}`);
      if (candidate) out.candidates.push(candidate);
    });
    t.onPeerJoin((p) => out.joins.push(p));
    t.onPeerLeave((p) => out.leaves.push(p));
    t.onError((e) => out.errors.push(e.message));
    return out;
  };

  it('WsPeerTransport: the first frame is handed over once, nothing after it is read, and the socket is closed when the time is up', async () => {
    const t = new WsPeerTransport({ localId: 'h', verdictMs: 200 });
    world.open.push(t);
    const endpoint = await t.listen(0, '127.0.0.1');
    const seen = listen(t);
    const s = await rawSocket(endpoint);
    s.send(hello, more);
    await until(() => seen.got.length === 1);
    expect(seen.candidates[0]?.state).toBe('open');
    expect(t.peers()).toEqual([]);
    await until(() => s.shut());
    expect(seen.got).toEqual(['x:HELLO:candidate']);
    expect(seen.candidates[0]?.state).toBe('refused');
    // A verdict that comes too late binds nothing.
    expect(seen.candidates[0]?.accept()).toBe(false);
    expect(t.peers()).toEqual([]);
    expect(seen.joins).toEqual([]);
    expect(seen.leaves).toEqual([]);
    expect(seen.errors).toEqual(['an opening frame was refused (HELLO for x: no verdict in time)']);
  });

  it('WsHostTransport: the same', async () => {
    const t = new WsHostTransport({ localId: 'h', port: 0, verdictMs: 200 });
    world.open.push(t);
    const port = await t.listen();
    const seen = listen(t);
    const s = await rawSocket(`ws://127.0.0.1:${port}`);
    s.send(hello, more);
    await until(() => s.shut());
    expect(seen.got).toEqual(['x:HELLO:candidate']);
    expect(seen.candidates[0]?.accept()).toBe(false);
    expect(t.peers()).toEqual([]);
    expect(seen.joins).toEqual([]);
    expect(seen.leaves).toEqual([]);
  });

  for (const kind of ['WsPeerTransport', 'WsHostTransport'] as const) {
    it(`${kind}: a socket that connects and says nothing is closed when the time is up; one that speaks late has only what is left of it`, async () => {
      const VERDICT = 400;
      let t: WsPeerTransport | WsHostTransport;
      let endpoint: string;
      if (kind === 'WsPeerTransport') {
        t = new WsPeerTransport({ localId: 'h', verdictMs: VERDICT });
        endpoint = await t.listen(0, '127.0.0.1');
      } else {
        t = new WsHostTransport({ localId: 'h', port: 0, verdictMs: VERDICT });
        endpoint = `ws://127.0.0.1:${await t.listen()}`;
      }
      world.open.push(t);
      const seen = listen(t);
      const started = Date.now();
      const silent = await rawSocket(endpoint);
      const late = await rawSocket(endpoint);
      await sleep(VERDICT * 0.6);
      late.send(hello);
      await until(() => silent.shut() && late.shut());
      // Both are closed about one time after they connected: the late one did not get a time of its own.
      expect(Date.now() - started).toBeLessThan(VERDICT * 1.5);
      expect(seen.got).toEqual(['x:HELLO:candidate']);
      expect(seen.errors.sort()).toEqual(['a connection that sent no opening frame in time was closed', 'an opening frame was refused (HELLO for x: no verdict in time)']);
      expect(t.peers()).toEqual([]);
      expect(seen.joins).toEqual([]);
      expect(seen.leaves).toEqual([]);
    });
  }

  it('WsHostTransport: `close()` also ends the sockets that are nobody\'s yet', async () => {
    const t = new WsHostTransport({ localId: 'h', port: 0 });
    const port = await t.listen();
    const seen = listen(t);
    const silent = await rawSocket(`ws://127.0.0.1:${port}`);
    const waiting = await rawSocket(`ws://127.0.0.1:${port}`);
    waiting.send(hello);
    await until(() => seen.got.length === 1);
    t.close();
    await until(() => silent.shut() && waiting.shut());
    expect(seen.candidates[0]?.accept()).toBe(false);
    // Closed with the transport, not refused: nothing is reported for them.
    expect(seen.errors).toEqual([]);
  });

  it('RelayHostTransport: a first frame nobody judged is let go when the time is up, and an accepted first frame is what makes a relay peer a link', async () => {
    const r = (world.relay = await startFakeRelay({ devices: DEVICES }));
    const t = new RelayHostTransport(optsFor(r, 'h', { verdictMs: 200 }));
    world.open.push(t);
    await t.host(CODE);
    const seen = listen(t);
    const c = new RelayClientTransport(optsFor(r, 'a'));
    world.open.push(c);
    const heard: string[] = [];
    c.onMessage((_f, m) => heard.push(m.type));
    await c.connect(CODE);
    c.send('all', helloAs('a', 1));
    c.send('all', buildMessage('RESUME', {}, { matchId: CODE, seq: 2, from: 'a' }));
    await until(() => seen.got.length === 1);
    await until(() => seen.candidates[0]?.state === 'refused');
    expect(seen.got).toEqual(['a:HELLO:candidate']);
    expect(seen.candidates[0]?.accept()).toBe(false);
    expect(t.peers()).toEqual([]);
    expect(seen.joins).toEqual([]);

    // The same relay peer opens again; this time the frame is taken: a link from the accept on, and only then.
    c.send('all', helloAs('a', 3));
    await until(() => seen.candidates.length === 2);
    expect(t.peers()).toEqual([]);
    t.send('a', buildMessage('RESUME', {}, { matchId: CODE, seq: 1, from: 'h' }));
    expect(seen.candidates[1]?.accept()).toBe(true);
    expect(t.peers()).toEqual(['a']);
    expect(seen.joins).toEqual(['a']);
    t.send('a', buildMessage('PAUSE', { reason: 'requested', player: null }, { matchId: CODE, seq: 2, from: 'h' }));
    await until(() => heard.includes('PAUSE'));
    // What was sent to the player's name before the accept went to nobody.
    expect(heard).toEqual(['PAUSE']);
    c.send('all', buildMessage('RESUME', {}, { matchId: CODE, seq: 4, from: 'a' }));
    await until(() => seen.got.length === 3);
    expect(seen.got[2]).toBe('a:RESUME:link');
    expect(seen.leaves).toEqual([]);
  });
});

describe('the engines: the number of a frame that opens a link is recorded only when the frame is taken', () => {
  /** h, a, b on a MemoryBus (every link is its player's from the start), started; `a` and `b` joined by HELLO. */
  async function mesh() {
    const bus = new MemoryBus();
    const hk = generateKeys();
    const host = new HostMatch({ transport: bus.transport('h'), keys: hk, matchId: 'M', ballsPerGame: 2, hostParticipant: participant('h', hk), hostGame: game, disconnectGraceMs: 0 });
    const keys: Record<string, KeyPair> = {};
    const clients: Record<string, ClientMatch> = {};
    for (const id of ['a', 'b']) {
      const k = (keys[id] = generateKeys());
      clients[id] = new ClientMatch({ transport: bus.transport(id), keys: k, participant: participant(id, k), game, throwdownCode: 'M', hostId: 'h', disconnectGraceMs: 0 });
      clients[id]!.join();
    }
    await flush();
    host.start();
    await flush();
    const rejects: string[] = [];
    host.on('reject', (x) => rejects.push(`${x.to}:${x.refType}:${x.code}`));
    return { bus, host, a: clients['a']!, b: clients['b']!, keys, rejects };
  }
  const state = (from: string, seq: number): AnyMessage => buildMessage('STATE', { ballNumber: 1, score: 10, ballInPlay: true, tilt: false }, { matchId: 'M', seq, from });

  it('a HELLO from a participant\'s own link is refused and that is all: the link stays, and the count is not started over', async () => {
    const m = await mesh();
    const refused: string[] = [];
    m.host.on('refused', (x) => refused.push(x.refuse.code));
    const t = m.a.session.transport;
    t.send('h', state('a', 5000));
    t.send('h', buildMessage('HELLO', { protocolVersion: PROTOCOL_VERSION, companionVersion: 'test', throwdownCode: 'M', participant: participant('a', m.keys['a'] as KeyPair), game }, { matchId: null, seq: 1, from: 'a' }));
    // Below the count: taken only if the HELLO had started the count over.
    t.send('h', state('a', 4000));
    await flush();
    expect(refused).toEqual(['match_started']);
    expect(m.rejects).toEqual(['a:STATE:unexpected_state']);
    expect(m.bus.isConnected('a')).toBe(true);
    expect(m.host.snapshot().gone).toEqual([]);
  });

  it('a RECONNECT that verifies, on a link that is gone before the verdict: nothing is recorded and nothing changes', async () => {
    const m = await mesh();
    const raised: string[] = [];
    m.host.on('reconnected', () => raised.push('reconnected'));
    m.host.on('reconnectRejected', () => raised.push('rejected'));
    const head = m.a.log.head();
    const frame = signedReconnect('M', 'h', 'a', head, m.keys['a'] as KeyPair, HIGH);
    const sent: AnyMessage[] = [];
    let bound = false;
    const gone = openCandidate('a', { send: (x) => sent.push(x), bind: () => (bound = true), close: () => undefined });
    gone.gone();
    m.host.handle('a', frame, { candidate: gone });
    expect(raised).toEqual([]);
    expect(sent).toEqual([]);
    expect(bound).toBe(false);
    expect(m.host.snapshot().gone).toEqual([]);
    // The count of `a` is where it was: its own next frame, far below that number, is taken.
    m.host.localBallEnd(100, 'nvram');
    await flush();
    m.a.reportBallEnd(200, 'nvram');
    await flush();
    expect(m.rejects).toEqual([]);
    expect(types(m.host).filter((t) => t.startsWith('BALL_END'))).toEqual(['BALL_END:h', 'BALL_END:a']);
  });

  it('a first frame handed to the host engine always leaves with a verdict: one it does not read as an opening frame is refused', async () => {
    const m = await mesh();
    let closed = 0;
    const c = openCandidate('a', { send: () => undefined, bind: () => undefined, close: () => (closed += 1) });
    m.host.handle('a', state('a', HIGH), { candidate: c });
    expect(c.state).toBe('refused');
    expect(closed).toBe(1);
    // And its number was not recorded.
    m.a.reportState({ ballNumber: 1, score: 1, ballInPlay: true, tilt: false });
    await flush();
    expect(m.rejects).toEqual([]);
  });

  it('a client takes a frame in somebody else\'s name from the host\'s link only: from another link it is dropped before its number is looked at', async () => {
    const m = await mesh();
    const dropped: string[] = [];
    m.a.on('dropped', (d) => dropped.push(`${d.from}:${d.type}:${d.reason}`));
    m.b.session.transport.send('a', state('h', HIGH));
    await flush();
    expect(dropped).toEqual(['h:STATE:not_host']);
    // The host's own frames, under its own numbers, are still taken.
    m.host.localBallEnd(100, 'nvram');
    await flush();
    expect(m.a.myGrant).not.toBeNull();
    expect(dropped).toEqual(['h:STATE:not_host']);
  });

  it('a client with a listener: an inbound first frame is refused and its socket closed, whatever name and number it carries, and the host\'s frames are still taken', async () => {
    const rig = await wsRig();
    const at = rig.a.session.transport as WsPeerTransport;
    const endpoint = await at.listen(0, '127.0.0.1');
    rig.host.start();
    await until(() => rig.a.state.currentGrant?.grant.player === 'h');
    const head = rig.a.log.head();
    const s = await rawSocket(endpoint);
    s.send(buildMessage('RECONNECT', { player: 'h', logHash: head.hash, logLength: head.length, signature: signCanonical({}, generateKeys().privateKey) }, { matchId: CODE, seq: HIGH, from: 'h' }));
    await until(() => s.shut());
    expect(s.frames()).toEqual([]);
    expect(at.inboundPeers()).toEqual([]);
    rig.host.localBallEnd(100, 'nvram');
    await until(() => rig.a.myGrant !== null);
    expect(rig.seen).toEqual([]);
  });
});
