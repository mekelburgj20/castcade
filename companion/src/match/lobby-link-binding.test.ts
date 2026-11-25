/**
 * A17 step 6 (2026-11-25): a lobby on the real transports, through the relay double and over real WebSockets, where
 * a link belongs to a member only once the lobby's PC has accepted that link's first frame.
 *
 * The property, for every way a lobby refuses a first frame: the answer goes to the link the frame came on, that
 * link is closed, and the member the frame names keeps the row, the place, the counter, the link and the stance it
 * had; the member's own next frame is taken. And the ways a member does come back (RECONNECT on a new link, a HELLO
 * after the place was gone, the signed HELLO of a Castcade that started again, the answer of a lobby that closed
 * meanwhile) each reach the link they were asked on.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { buildMessage, PROTOCOL_VERSION, type AnyMessage } from '@castcade/protocol';
import { ClientMatch, type ClientOptions } from './client.js';
import { HostMatch, type LobbyOptions } from './host.js';
import { generateKeys, signCanonical, type KeyPair } from './keys.js';
import { cleanup, CODE, DEVICES, game, HIGH, optsFor, participant, rawSocket, relaySeat, sleep, until, world, type Second } from './link-binding.test-support.js';
import { startFakeRelay } from './relay-fake.test-support.js';
import { helloProofBody, lobbyReconnectSignBody } from './result.js';
import { Session } from './session.js';
import { RelayClientTransport, RelayHostTransport } from './transport-relay.js';
import { WsPeerTransport } from './transport-ws.js';
import type { Transport } from './transport.js';

afterEach(cleanup);

interface RigOptions {
  /** Both engines' grace. Default 5 s, as shipped. */
  graceMs?: number;
  /** The grace of the lobby's PC alone, when it is not the members'. */
  hostGraceMs?: number;
  /** How long `a` waits between its attempts to get back. Default 40 ms. */
  retryMs?: number;
  /** A second member, `b`, joins too. */
  third?: boolean;
  lobby?: LobbyOptions;
}

interface Rig {
  kind: 'relay' | 'ws';
  host: HostMatch;
  hk: KeyPair;
  a: ClientMatch;
  ak: KeyPair;
  at: Transport;
  b: ClientMatch | null;
  bt: Transport | null;
  /** What the engines raised that is not the plain course of a lobby, from the moment everyone was in. */
  seen: string[];
  /** What the transport of the lobby's PC reported (the shell writes these to its log). */
  errors: string[];
  /** The members the transport of the lobby's PC holds a link for. */
  linked(): string[];
  /** Another link to the lobby's PC that has said nothing yet. */
  second(): Promise<Second>;
  /** `a`'s link goes, as a network drop would take it. */
  dropA(): void;
  /** `a`'s Castcade starts again: the engine and its link are gone, and a new link is connected with nothing said. */
  again(): Promise<Transport>;
  aOptions(transport: Transport): ClientOptions;
}

function note(rig: Pick<Rig, 'host' | 'a' | 'b' | 'seen'>): void {
  const { host, a, b, seen } = rig;
  host.on('peerLeft', (id) => seen.push(`h:peerLeft:${id}`));
  host.on('pause', (p) => seen.push(`h:pause:${String(p.player)}`));
  host.on('memberRemoved', (id) => seen.push(`h:memberRemoved:${id}`));
  host.on('reconnected', (x) => seen.push(`h:reconnected:${x.playerId}`));
  host.on('reconnectRejected', (x) => seen.push(`h:reconnectRejected:${x.code}`));
  host.on('refused', (x) => seen.push(`h:refused:${x.refuse.code}`));
  host.on('reject', (x) => seen.push(`h:reject:${x.refType}:${x.code}:${x.to}`));
  noteClient('a', a, seen);
  if (b) noteClient('b', b, seen);
}

function noteClient(id: string, c: ClientMatch, seen: string[]): void {
  c.on('peerLeft', (p) => seen.push(`${id}:peerLeft:${p}`));
  c.on('hostGone', () => seen.push(`${id}:hostGone`));
  c.on('reject', (x) => seen.push(`${id}:reject:${x.refType}`));
  c.on('joined', () => seen.push(`${id}:joined`));
  c.on('reconnected', () => seen.push(`${id}:reconnected`));
  c.on('reconnectRejected', (x) => seen.push(`${id}:reconnectRejected:${String(x.code)}`));
  c.on('rejoining', () => seen.push(`${id}:rejoining`));
  c.on('refused', (x) => seen.push(`${id}:refused:${x.code}`));
  c.on('lobbyClosed', (x) => seen.push(`${id}:lobbyClosed:${x.reason}`));
  c.on('desync', (x) => seen.push(`${id}:desync:${x.context}`));
}

async function makeRig(kind: 'relay' | 'ws', o: RigOptions = {}): Promise<Rig> {
  const graceMs = o.graceMs ?? 5000;
  const hk = generateKeys();
  const ak = generateKeys();
  const bk = generateKeys();
  const errors: string[] = [];
  let ht: RelayHostTransport | WsPeerTransport;
  let connect: (id: string, device: string) => Promise<Transport & { close(): void }>;
  let second: () => Promise<Second>;
  let dropA: () => void;
  let linked: () => string[];
  if (kind === 'relay') {
    const r = (world.relay = await startFakeRelay({ devices: DEVICES }));
    const rh = new RelayHostTransport(optsFor(r, 'h'));
    await rh.host(CODE);
    ht = rh;
    connect = async (id, device) => {
      const t = new RelayClientTransport(optsFor(r, device, { localId: id }));
      world.open.push(t);
      await t.connect(CODE);
      return t;
    };
    second = () => relaySeat(r, 'b');
    dropA = () => r.dropDevice('dev-a');
    linked = () => rh.peers();
  } else {
    const wh = new WsPeerTransport({ localId: 'h' });
    const endpoint = await wh.listen(0, '127.0.0.1');
    ht = wh;
    const links = new Map<string, WsPeerTransport>();
    connect = async (id) => {
      const t = new WsPeerTransport({ localId: id });
      world.open.push(t);
      await t.connect(endpoint);
      links.set(id, t);
      return t;
    };
    second = () => rawSocket(endpoint);
    dropA = () => links.get('a')?.dropLinks('h');
    linked = () => wh.inboundPeers();
  }
  ht.onError((e) => errors.push(e.message));
  world.open.push(ht);
  const host = new HostMatch({ transport: ht, keys: hk, matchId: CODE, ballsPerGame: 2, hostParticipant: participant('h', hk), hostGame: game, disconnectGraceMs: o.hostGraceMs ?? graceMs, lobby: { ...(o.lobby ?? {}) } });
  const aOptions = (transport: Transport): ClientOptions => ({ transport, keys: ak, participant: participant('a', ak), game, throwdownCode: CODE, reconnect: { delayMs: o.retryMs ?? 40 }, disconnectGraceMs: graceMs, lobby: true });
  let at = await connect('a', 'a');
  let a = new ClientMatch(aOptions(at));
  world.open.push(host, a);
  a.join();
  await until(() => a.isJoined && host.members().length === 2);
  let b: ClientMatch | null = null;
  let bt: Transport | null = null;
  if (o.third) {
    bt = await connect('b', 'c');
    b = new ClientMatch({ transport: bt, keys: bk, participant: participant('b', bk), game, throwdownCode: CODE, disconnectGraceMs: graceMs, lobby: true });
    world.open.push(b);
    b.join();
    await until(() => b!.isJoined && host.members().length === 3);
  }
  // What a joiner says about itself after HELLO_ACK has landed too.
  await sleep(40);
  const seen: string[] = [];
  const rig: Rig = {
    kind,
    host,
    hk,
    get a() {
      return a;
    },
    ak,
    get at() {
      return at;
    },
    b,
    bt,
    seen,
    errors,
    linked,
    second,
    dropA,
    aOptions,
    async again() {
      a.close();
      at.close();
      at = await connect('a', 'a');
      return at;
    },
  };
  note(rig);
  // The engine of a Castcade that started again takes the place of the old one in the rig.
  const again = rig.again.bind(rig);
  rig.again = async () => {
    const t = await again();
    a = new ClientMatch(aOptions(t), new Session({ transport: t, keys: ak, seqStart: Date.now() }));
    world.open.push(a);
    noteClient('a', a, seen);
    return t;
  };
  return rig;
}

const TRANSPORTS = [
  ['through the relay', 'relay'],
  ['over WebSocket', 'ws'],
] as const;

/** A lobby's RECONNECT in the name of `player`, from `a`'s log head, signed with `key` for the PC `to`, under the number `seq`. */
function reconnectAs(rig: Rig, key: KeyPair, seq: number, o: { player?: string; to?: string } = {}): AnyMessage {
  const player = o.player ?? 'a';
  const head = rig.a.log.head();
  const held = rig.a.state.matchId;
  const signature = signCanonical(lobbyReconnectSignBody(CODE, o.to ?? 'h', player, held, head.hash, head.length, seq), key.privateKey);
  return buildMessage('RECONNECT', { player, logHash: head.hash, logLength: head.length, signature, resends: true, match: held }, { matchId: CODE, seq, from: player });
}

/** A lobby's HELLO in the name of `a`, with the key of `a`'s row; `signer`: who signs its proof (null: it carries none). */
function helloAs(rig: Rig, seq: number, signer: KeyPair | null): AnyMessage {
  return buildMessage(
    'HELLO',
    {
      protocolVersion: PROTOCOL_VERSION,
      companionVersion: 'test',
      throwdownCode: CODE,
      participant: participant('a', rig.ak),
      game,
      stance: 'watch',
      ...(signer ? { proof: signCanonical(helloProofBody(CODE, 'a', seq), signer.privateKey) } : {}),
    },
    { matchId: null, seq, from: 'a' },
  );
}

/** What the lobby's PC holds about `a`. */
const held = (rig: Rig): unknown => ({
  row: rig.host.members().find((p) => p.playerId === 'a'),
  members: rig.host.members().map((p) => p.playerId),
  stance: rig.host.stanceOf('a'),
  count: rig.host.session.lastSeqFrom('a'),
  away: rig.host.snapshot().gone,
  linked: [...new Set(rig.linked())].sort(),
});

/** Each way a lobby refuses a first frame in a member's name: the frame, and the answer it gets. */
const REFUSALS: Array<{ what: string; frame: (rig: Rig) => AnyMessage; answer: Record<string, unknown>; event: string; line: string }> = [
  {
    what: 'a RECONNECT refused as `bad_signature`',
    frame: (rig) => reconnectAs(rig, generateKeys(), HIGH),
    answer: { type: 'RECONNECT_ACK', matchId: CODE, payload: { accept: false, code: 'bad_signature', entries: [] } },
    event: 'h:reconnectRejected:bad_signature',
    line: 'an opening frame was refused (RECONNECT for a: bad_signature)',
  },
  {
    what: 'a RECONNECT that was not written for this PC, refused as `bad_signature`',
    frame: (rig) => reconnectAs(rig, rig.ak, HIGH, { to: 'x' }),
    answer: { type: 'RECONNECT_ACK', payload: { accept: false, code: 'bad_signature' } },
    event: 'h:reconnectRejected:bad_signature',
    line: 'an opening frame was refused (RECONNECT for a: bad_signature)',
  },
  {
    what: 'a RECONNECT refused as `stale_seq`',
    frame: (rig) => reconnectAs(rig, rig.ak, 1),
    answer: { type: 'RECONNECT_ACK', payload: { accept: false, code: 'stale_seq' } },
    event: 'h:reconnectRejected:stale_seq',
    line: 'an opening frame was refused (RECONNECT for a: stale_seq)',
  },
  {
    what: 'a HELLO with no proof, refused as `duplicate_player`',
    frame: (rig) => helloAs(rig, HIGH, null),
    answer: { type: 'REFUSE', payload: { code: 'duplicate_player' } },
    event: 'h:refused:duplicate_player',
    line: 'an opening frame was refused (HELLO for a: duplicate_player)',
  },
  {
    what: 'a HELLO whose proof does not verify, refused as `duplicate_player`',
    frame: (rig) => helloAs(rig, HIGH, generateKeys()),
    answer: { type: 'REFUSE', payload: { code: 'duplicate_player' } },
    event: 'h:refused:duplicate_player',
    line: 'an opening frame was refused (HELLO for a: duplicate_player)',
  },
  {
    what: 'a HELLO whose proof is not above the count, refused as `duplicate_player`',
    frame: (rig) => helloAs(rig, 1, rig.ak),
    answer: { type: 'REFUSE', payload: { code: 'duplicate_player' } },
    event: 'h:refused:duplicate_player',
    line: 'an opening frame was refused (HELLO for a: duplicate_player)',
  },
];

for (const [how, kind] of TRANSPORTS) {
  describe(`A17 step 6, a lobby ${how}: a first frame in a member's name that the lobby refuses changes nothing about that member`, () => {
    for (const c of REFUSALS) {
      it(`${c.what}: answered on its own link, which is closed; the member's row, place, counter, link and stance are as they were, and the member's own next frame is taken`, async () => {
        const rig = await makeRig(kind, { third: true });
        const before = held(rig);
        const second = await rig.second();
        // The first frame, and one more behind it, which is never read.
        second.send(c.frame(rig), buildMessage('PARTICIPANT_UPDATE', { stance: 'watch' }, { matchId: CODE, seq: HIGH + 1, from: 'a' }));
        await until(() => second.frames().length >= 1 && second.shut());
        expect(second.frames()).toHaveLength(1);
        expect(second.frames()[0]).toMatchObject({ from: 'h', ...c.answer });
        expect(rig.seen).toEqual([c.event]);
        expect(rig.errors).toEqual([c.line]);
        expect(held(rig)).toEqual(before);
        expect(rig.host.stanceOf('a')).toBe('play');
        // The member's own next frame, on the member's own link.
        expect(rig.a.setStance('watch')).toBe(true);
        await until(() => rig.host.stanceOf('a') === 'watch' && rig.b?.lobby()?.stances?.find((x) => x.playerId === 'a')?.stance === 'watch');
        expect(rig.seen).toEqual([c.event]);
        expect([...new Set(rig.linked())].sort()).toEqual(['a', 'b']);
        // The link that was refused is sent nothing of the lobby.
        await sleep(40);
        expect(second.frames()).toHaveLength(1);
      });
    }

    it('a RECONNECT that names the lobby`s PC itself, or nobody in the lobby, is refused as `unknown_player` on its own link, which is closed', async () => {
      const rig = await makeRig(kind);
      const before = held(rig);
      for (const [player, key] of [
        ['h', rig.hk],
        ['zed', generateKeys()],
      ] as const) {
        const second = await rig.second();
        second.send(reconnectAs(rig, key, HIGH, { player }), buildMessage('PARTICIPANT_UPDATE', { stance: 'watch' }, { matchId: CODE, seq: HIGH + 1, from: player }));
        await until(() => second.frames().length >= 1 && second.shut());
        expect(second.frames()).toHaveLength(1);
        expect(second.frames()[0]).toMatchObject({ type: 'RECONNECT_ACK', payload: { accept: false, code: 'unknown_player' } });
        second.leave();
      }
      expect(rig.seen).toEqual(['h:reconnectRejected:unknown_player', 'h:reconnectRejected:unknown_player']);
      // The lobby's PC holds no link in its own name, and none for somebody who is not in.
      expect(held(rig)).toEqual(before);
      expect(rig.host.members().map((p) => p.playerId)).toEqual(['h', 'a']);
      expect(rig.host.stanceOf('h')).toBe('play');
    });

    it('a frame in another member`s name from a member`s own link is answered on the link it came on, and is not read', async () => {
      const rig = await makeRig(kind, { third: true });
      const before = held(rig);
      if (!rig.bt) throw new Error('no second member');
      rig.bt.send('h', buildMessage('LEAVE_LOBBY', {}, { matchId: CODE, seq: HIGH, from: 'a' }));
      rig.bt.send('h', buildMessage('START_REQUEST', { fromTable: false }, { matchId: CODE, seq: HIGH + 1, from: 'a' }));
      await until(() => rig.seen.filter((x) => x.startsWith('b:reject')).length === 2);
      expect(rig.seen.sort()).toEqual(['b:reject:LEAVE_LOBBY', 'b:reject:START_REQUEST', 'h:reject:LEAVE_LOBBY:unknown_player:b', 'h:reject:START_REQUEST:unknown_player:b']);
      expect(held(rig)).toEqual(before);
      expect(rig.host.announcedStart()).toBeNull();
      // Both members go on as they were.
      expect(rig.a.setStance('watch')).toBe(true);
      expect(rig.b?.setStance('watch')).toBe(true);
      await until(() => rig.host.stanceOf('a') === 'watch' && rig.host.stanceOf('b') === 'watch');
    });

    it('a lobby that is closed: a first frame gets the answer on its own link, which is closed, and the members are told nothing more', async () => {
      const rig = await makeRig(kind);
      rig.host.closeLobby('good night');
      await until(() => rig.seen.includes('a:lobbyClosed:good night'));
      const before = rig.seen.length;
      const one = await rig.second();
      one.send(reconnectAs(rig, generateKeys(), HIGH), buildMessage('PARTICIPANT_UPDATE', { stance: 'watch' }, { matchId: CODE, seq: HIGH + 1, from: 'a' }));
      await until(() => one.frames().length >= 1 && one.shut());
      expect(one.frames()).toHaveLength(1);
      expect(one.frames()[0]).toMatchObject({ type: 'LOBBY_CLOSED', from: 'h', matchId: CODE, payload: { reason: 'good night' } });
      one.leave();
      const two = await rig.second();
      two.send(helloAs(rig, HIGH, null));
      await until(() => two.frames().length >= 1);
      expect(two.frames()[0]).toMatchObject({ type: 'REFUSE', payload: { code: 'other' } });
      await sleep(40);
      expect(rig.seen.slice(before).filter((x) => x.startsWith('a:'))).toEqual([]);
      expect(rig.errors).toContain('an opening frame was refused (RECONNECT for a: LOBBY_CLOSED)');
    });
  });

  describe(`A17 step 6, a lobby ${how}: a member comes back on a link of its own`, () => {
    it('by RECONNECT, with no match open and in the middle of its ball: the answer reaches the new link, and what the member says next is taken', async () => {
      const rig = await makeRig(kind);
      rig.dropA();
      await until(() => rig.seen.includes('a:reconnected') && rig.seen.includes('h:reconnected:a'));
      expect(rig.seen.sort()).toEqual(['a:reconnected', 'h:reconnected:a']);
      expect(rig.linked()).toEqual(['a']);
      expect(rig.host.snapshot().gone).toEqual([]);
      expect(rig.a.setStance('watch')).toBe(true);
      await until(() => rig.host.stanceOf('a') === 'watch');
      expect(rig.a.setStance('play')).toBe(true);
      await until(() => rig.host.stanceOf('a') === 'play');
      // A match, and the same in the middle of the member's ball.
      rig.host.start();
      await until(() => rig.a.state.currentGrant?.grant.player === 'h');
      rig.host.localBallEnd(100, 'nvram');
      await until(() => rig.a.myGrant !== null);
      rig.seen.length = 0;
      rig.dropA();
      await until(() => rig.seen.includes('a:reconnected') && rig.seen.includes('h:reconnected:a'));
      expect(rig.seen.sort()).toEqual(['a:reconnected', 'h:reconnected:a']);
      rig.a.reportBallEnd(4321, 'nvram');
      await until(() => rig.host.state.currentGrant?.grant.player === 'h' && rig.a.log.head().hash === rig.host.log.head().hash);
      expect(rig.host.state.paused).toBeNull();
      expect(rig.linked()).toEqual(['a']);
      expect(rig.errors).toEqual([]);
    });

    it('a counter that fell behind: `stale_seq` on the link it asked on, and the member is back above it on the next', async () => {
      const rig = await makeRig(kind);
      const floor = 5_000_000_000_000;
      expect(rig.host.session.checkSeq('a', floor)).toBe(true);
      rig.dropA();
      await until(() => rig.seen.includes('a:reconnected'));
      expect(rig.seen.filter((x) => x.startsWith('a:') || x.startsWith('h:reconnect'))).toEqual(['h:reconnectRejected:stale_seq', 'a:reconnectRejected:stale_seq', 'h:reconnected:a', 'a:reconnected']);
      expect(rig.host.session.lastSeqFrom('a')).toBeGreaterThan(floor);
      expect(rig.linked()).toEqual(['a']);
      expect(rig.a.setStance('watch')).toBe(true);
      await until(() => rig.host.stanceOf('a') === 'watch');
    });

    it('after the lobby closed: the member is told so on the link it came back on, once', async () => {
      const rig = await makeRig(kind, { retryMs: 700 });
      rig.dropA();
      await until(() => rig.host.snapshot().gone.includes('a'));
      rig.host.closeLobby('good night');
      await until(() => rig.seen.some((x) => x.startsWith('a:lobbyClosed')), 8000);
      expect(rig.seen.filter((x) => x.startsWith('a:lobbyClosed'))).toEqual(['a:lobbyClosed:good night']);
      expect(rig.a.hostAway()).toBeNull();
      expect(rig.a.matchEnded).toBe(true);
      await sleep(100);
      expect(rig.seen.filter((x) => x.startsWith('a:lobbyClosed') || x.startsWith('a:reconnect') || x === 'a:rejoining')).toEqual(['a:lobbyClosed:good night']);
    });

    it('after its place was gone: `unknown_player` on the link it asked on, then a HELLO on a link of its own, and it is in again as a newcomer', async () => {
      // This member's place runs out before its first attempt to get back: a grace and a place of a moment each.
      const rig = await makeRig(kind, { retryMs: 1200, hostGraceMs: 30, lobby: { placeMs: 150 } });
      rig.dropA();
      await until(() => rig.seen.includes('h:memberRemoved:a'), 3000);
      expect(rig.host.members().map((p) => p.playerId)).toEqual(['h']);
      await until(() => rig.seen.includes('a:joined'), 8000);
      expect(rig.seen.filter((x) => x.startsWith('a:'))).toEqual(['a:reconnectRejected:unknown_player', 'a:rejoining', 'a:joined']);
      expect(rig.host.members().map((p) => p.playerId)).toEqual(['h', 'a']);
      expect(rig.linked()).toEqual(['a']);
      expect(rig.a.hostAway()).toBeNull();
      expect(rig.a.setStance('watch')).toBe(true);
      await until(() => rig.host.stanceOf('a') === 'watch');
      // The link the RECONNECT came on was closed by the lobby's PC: that is not the lobby's PC going away.
      await sleep(100);
      expect(rig.seen.filter((x) => x.startsWith('a:'))).toEqual(['a:reconnectRejected:unknown_player', 'a:rejoining', 'a:joined']);
    });

    it('a Castcade that started again while its place is kept: its signed HELLO is its return, on the link it came on, and the count goes on', async () => {
      const rig = await makeRig(kind, { graceMs: 200 });
      const row = rig.host.members().find((p) => p.playerId === 'a');
      const count = rig.host.session.lastSeqFrom('a') ?? 0;
      await rig.again();
      await until(() => rig.host.snapshot().gone.includes('a'));
      rig.a.join();
      await until(() => rig.a.isJoined && rig.seen.includes('h:reconnected:a'));
      expect(rig.seen.filter((x) => x.startsWith('h:re') || x.startsWith('a:'))).toEqual(['h:reconnected:a', 'a:joined']);
      expect(rig.host.members().map((p) => p.playerId)).toEqual(['h', 'a']);
      expect(rig.host.members().find((p) => p.playerId === 'a')).toEqual(row);
      expect(rig.host.snapshot().gone).toEqual([]);
      expect(rig.linked()).toEqual(['a']);
      // The count was not started over: it stands at the new HELLO's number, above where it stood.
      expect(rig.host.session.lastSeqFrom('a')).toBeGreaterThan(count);
      expect(rig.host.session.lastSeqFrom('a')).toBeGreaterThan(1_000_000);
      expect(rig.a.setStance('watch')).toBe(true);
      await until(() => rig.host.stanceOf('a') === 'watch');
    });
  });
}
