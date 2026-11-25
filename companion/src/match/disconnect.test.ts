/**
 * A18 (2026-11-24, the owner: "We never want another player's disconnect to cause the active player to have a messed
 * up session"): what the engines do with a peer whose link drops after MATCH_READY.
 *
 * The host's two rules on a MemoryBus with a manual clock (nothing here waits): the grace before a dropped link is a
 * disconnect, and no pause for a player who is not up. Then the same over real WebSockets on localhost, where a link
 * can come back: a drop shorter than the grace is seen by nobody, a grant that came due inside it waits and goes out
 * at the RECONNECT, and a ball end reported into the dead link is sent again.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { parseMessage, type GameFingerprint, type Message, type ParticipantInfo, type PayloadOf } from '@castcade/protocol';
import { ClientMatch } from './client.js';
import { ManualClock } from './clock.js';
import { DEFAULT_DISCONNECT_GRACE_MS, HostMatch } from './host.js';
import { generateKeys, type KeyPair } from './keys.js';
import { hashEntry, MatchLog, type LogEntry, type LogEntryBody } from './log.js';
import { MemoryBus } from './transport.js';
import { WsPeerTransport } from './transport-ws.js';

const game: GameFingerprint = { kind: 'vpx', tableName: 'Test Table', tableHash: 'ab'.repeat(32), romName: null, romHash: null, physicsHash: null, recipeVersion: '0.5.0', sidecarHash: null, emulatorVersion: '10.8.0' };
const participant = (id: string, keys: KeyPair): ParticipantInfo => ({ playerId: id, displayName: id, publicKey: keys.publicKeyB64, rig: 'pc' });
const flush = async (n = 6): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setTimeout(r, 0));
};
const until = async (cond: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const types = (m: HostMatch | ClientMatch): string[] => m.log.entries().map((e) => (e.message ? `${e.message.type}:${e.message.from}` : (e.event?.type ?? '?')));

const open: { close(): void }[] = [];
afterEach(() => {
  for (const x of open.splice(0)) x.close();
});

/** h, a, b on a MemoryBus, started, with the engines' own grace on a manual clock. `hostEvents`: what the host raised. */
async function mesh(ids: string[], opts: { balls?: number; graceMs?: number } = {}) {
  const bus = new MemoryBus();
  const clock = new ManualClock();
  const hk = generateKeys();
  const host = new HostMatch({ transport: bus.transport('h'), keys: hk, matchId: 'M', ballsPerGame: opts.balls ?? 2, hostParticipant: participant('h', hk), hostGame: game, clock, disconnectGraceMs: opts.graceMs });
  const clients: Record<string, ClientMatch> = {};
  for (const id of ids) {
    const k = generateKeys();
    clients[id] = new ClientMatch({ transport: bus.transport(id), keys: k, participant: participant(id, k), game, throwdownCode: 'M', hostId: 'h', clock, disconnectGraceMs: opts.graceMs });
    clients[id]!.join();
  }
  await flush();
  const hostEvents: string[] = [];
  host.on('pause', (p) => hostEvents.push(`pause:${p.reason}:${String(p.player)}`));
  host.on('peerLeft', (id) => hostEvents.push(`peerLeft:${id}`));
  host.on('grant', (g) => hostEvents.push(`grant:${g.player}:${g.ballNumber}:${g.grantSeq}`));
  host.start();
  await flush();
  /** Frames the bus carried to `to` since `from` (an index into its trace). */
  const framesTo = (to: string, from: number): string[] => bus.trace.slice(from).filter((f) => f.to === to).map((f) => f.type);
  return { bus, clock, host, clients, hostEvents, framesTo };
}

describe('A18: the host and a player whose link drops (MemoryBus, manual clock)', () => {
  it('the grace is five seconds', () => {
    expect(DEFAULT_DISCONNECT_GRACE_MS).toBe(5000);
  });

  it('client up, another client drops: the player who is up is sent nothing, its grant stands, and the turn passes on to whoever is there', async () => {
    const r = await mesh(['a', 'b'], { balls: 2 });
    r.host.localBallEnd(100, 'nvram');
    await flush();
    const a = r.clients['a']!;
    const aEvents: string[] = [];
    a.on('pause', (p) => aEvents.push(`pause:${String(p.player)}`));
    a.on('myTurn', (g) => aEvents.push(`myTurn:${g.grantSeq}`));
    expect(a.myGrant).toMatchObject({ player: 'a', ballNumber: 1, grantSeq: 2 });
    const at = r.bus.trace.length;
    const head = r.host.log.head();
    r.hostEvents.length = 0;

    r.bus.disconnect('b');
    await flush();
    // Inside the grace nobody is told anything.
    expect(r.hostEvents).toEqual([]);
    r.clock.advance(DEFAULT_DISCONNECT_GRACE_MS);
    await flush();
    // After it the host knows b is away, and that is all: no PAUSE, nothing in the log, nothing sent to the player up.
    expect(r.hostEvents).toEqual(['peerLeft:b']);
    expect(r.host.state.paused).toBeNull();
    expect(r.host.log.head()).toEqual(head);
    expect(r.host.state.currentGrant?.grant.grantSeq).toBe(2);
    expect(r.framesTo('a', at).filter((t) => t !== 'STATE')).toEqual([]);
    expect(aEvents).toEqual([]);
    expect(a.inputUnlocked).toBe(true);
    expect(r.host.snapshot().gone).toEqual(['b']);

    // a's ball ends: b's turn is next and b is not there, so now, and only now, the match waits for b.
    a.reportBallEnd(250, 'nvram');
    await flush();
    expect(r.hostEvents).toEqual(['peerLeft:b', 'pause:disconnect:b']);
    expect(types(r.host).slice(-2)).toEqual(['BALL_END:a', 'PAUSE:h']);
    expect(a.state.paused).toEqual({ reason: 'disconnect', player: 'b' });
    // The existing limit for a player who never comes back is the host's: forfeit, then the rotation goes on.
    r.host.forfeit('b', 'gone');
    r.host.resume();
    await flush();
    expect(r.host.state.currentGrant?.grant).toMatchObject({ player: 'h', ballNumber: 2 });
  });

  it('host up, a client drops: no pause in the host\'s ball; with a third player the next grant goes out as if nothing happened', async () => {
    const r = await mesh(['a', 'b'], { balls: 1 });
    expect(r.host.state.currentGrant?.grant.player).toBe('h');
    r.hostEvents.length = 0;
    r.bus.disconnect('b');
    await flush();
    r.clock.advance(DEFAULT_DISCONNECT_GRACE_MS);
    await flush();
    expect(r.hostEvents).toEqual(['peerLeft:b']);
    expect(r.host.state.paused).toBeNull();
    r.host.localBallEnd(100, 'nvram');
    await flush();
    expect(r.hostEvents).toEqual(['peerLeft:b', 'grant:a:1:2']);
    expect(types(r.host)).not.toContain('PAUSE:h');
  });

  it('the player who is up drops: after the grace the others are told to wait (the existing pause), and the grant is issued again at RESUME', async () => {
    const r = await mesh(['a', 'b'], { balls: 2 });
    r.host.localBallEnd(100, 'nvram');
    await flush();
    r.hostEvents.length = 0;
    r.bus.disconnect('a');
    await flush();
    r.clock.advance(DEFAULT_DISCONNECT_GRACE_MS - 1);
    await flush();
    expect(r.hostEvents).toEqual([]);
    expect(r.host.state.paused).toBeNull();
    r.clock.advance(1);
    await flush();
    expect(r.hostEvents).toEqual(['peerLeft:a', 'pause:disconnect:a']);
    expect(r.clients['b']!.state.paused).toEqual({ reason: 'disconnect', player: 'a' });
    // Still gone at RESUME: the match waits again rather than grant to a player who is not there.
    r.host.resume();
    await flush();
    expect(r.host.state.paused).toEqual({ reason: 'disconnect', player: 'a' });
  });

  it('a grant that comes due for a player inside its grace is held, and the pause comes when the grace runs out', async () => {
    const r = await mesh(['a'], { balls: 2 });
    r.hostEvents.length = 0;
    r.bus.disconnect('a');
    await flush();
    r.host.localBallEnd(100, 'nvram');
    await flush();
    // The host's ball ended; a's grant is due, and a dropped a moment ago: neither a grant nor a pause yet.
    expect(r.hostEvents).toEqual([]);
    expect(r.host.state.currentGrant).toBeNull();
    expect(r.host.state.paused).toBeNull();
    r.clock.advance(DEFAULT_DISCONNECT_GRACE_MS);
    await flush();
    expect(r.hostEvents).toEqual(['peerLeft:a', 'pause:disconnect:a']);
  });

  it('with no grace a drop is a disconnect at once, and still pauses only for the player who is up', async () => {
    const r = await mesh(['a', 'b'], { balls: 1, graceMs: 0 });
    r.hostEvents.length = 0;
    r.bus.disconnect('b');
    await flush();
    expect(r.hostEvents).toEqual(['peerLeft:b']);
    r.host.localBallEnd(100, 'nvram');
    await flush();
    r.bus.disconnect('a');
    await flush();
    expect(r.hostEvents).toEqual(['peerLeft:b', 'grant:a:1:2', 'peerLeft:a', 'pause:disconnect:a']);
  });
});

/** A started two-player match over WebSockets, 2 balls, the host up. `graceMs` for both engines; the client retries every `retryMs`. */
async function wsMatch(graceMs: number, retryMs: number, extra: { balls?: number; logSignTimeoutMs?: number } = {}) {
  const hk = generateKeys();
  const ck = generateKeys();
  const ht = new WsPeerTransport({ localId: 'h' });
  const endpoint = await ht.listen(0, '127.0.0.1');
  const host = new HostMatch({ transport: ht, keys: hk, matchId: 'ABCDEF', ballsPerGame: extra.balls ?? 2, hostParticipant: participant('h', hk), hostGame: game, disconnectGraceMs: graceMs, logSignTimeoutMs: extra.logSignTimeoutMs });
  const ct = new WsPeerTransport({ localId: 'c' });
  await ct.connect(endpoint);
  const client = new ClientMatch({ transport: ct, keys: ck, participant: participant('c', ck), game, throwdownCode: 'ABCDEF', reconnect: { delayMs: retryMs, attempts: 50 }, disconnectGraceMs: graceMs });
  open.push(ht, ct, host, client);
  const seen: string[] = [];
  host.on('pause', (p) => seen.push(`h:pause:${String(p.player)}`));
  host.on('peerLeft', (id) => seen.push(`h:peerLeft:${id}`));
  host.on('reconnected', (x) => seen.push(`h:reconnected:${x.quiet ? 'quiet' : 'told'}`));
  client.on('pause', (p) => seen.push(`c:pause:${String(p.player)}`));
  client.on('peerLeft', (id) => seen.push(`c:peerLeft:${id}`));
  client.on('reconnected', (x) => seen.push(`c:reconnected:${x.quiet ? 'quiet' : 'told'}`));
  client.join();
  await until(() => client.isJoined && host.roster().length === 2);
  host.start();
  await until(() => client.state.currentGrant?.grant.player === 'h');
  return { ht, ct, host, client, seen };
}

describe('A18: a link that comes back (real WebSockets)', () => {
  it('a drop shorter than the grace is seen by nobody: no PAUSE, no leave, the log as it was, the grant as it was', async () => {
    const m = await wsMatch(2000, 30);
    const head = m.host.log.head();
    const grant = m.host.state.currentGrant?.grant.grantSeq;
    m.ct.dropLinks('h');
    await until(() => m.seen.includes('c:reconnected:quiet') && m.seen.includes('h:reconnected:quiet'));
    await sleep(50);
    expect(m.seen.sort()).toEqual(['c:reconnected:quiet', 'h:reconnected:quiet']);
    expect(m.host.log.head()).toEqual(head);
    expect(m.client.log.head()).toEqual(head);
    expect(m.host.state.currentGrant?.grant.grantSeq).toBe(grant);
    expect(m.host.snapshot().gone).toEqual([]);
  });

  it('a grant that came due inside the grace goes out at the RECONNECT: the turn passes on with no pause in between', async () => {
    const m = await wsMatch(2000, 60);
    const turns: PayloadOf<'TURN_GRANT'>['grant'][] = [];
    m.client.on('myTurn', (g) => turns.push(g));
    m.ct.dropLinks('h');
    await until(() => m.host.snapshot().gone.includes('c'));
    m.host.localBallEnd(100, 'nvram');
    expect(m.host.state.currentGrant).toBeNull();
    await until(() => turns.length === 1);
    expect(turns[0]).toMatchObject({ player: 'c', ballNumber: 1 });
    expect(m.seen.filter((x) => !x.includes('reconnected'))).toEqual([]);
    expect(types(m.host)).toEqual(['MATCH_READY:h', 'TURN_GRANT:h', 'BALL_END:h', 'TURN_GRANT:h']);
    expect(m.client.log.head()).toEqual(m.host.log.head());
  });

  it('a ball end reported into a link that had just dropped is sent again after the reconnect, once, for the same grant', async () => {
    const m = await wsMatch(2000, 60);
    m.host.localBallEnd(100, 'nvram');
    await until(() => m.client.myGrant?.ballNumber === 1);
    const grant = m.client.myGrant!.grantSeq;
    m.ct.dropLinks('h');
    await until(() => m.host.snapshot().gone.includes('c'));
    // The table's ball ended while the link was away: this frame goes nowhere.
    m.client.reportBallEnd(4200, 'nvram');
    await until(() => m.host.state.players.c?.score === 4200);
    await until(() => m.client.state.currentGrant?.grant.player === 'h');
    const ends = m.host.log.entries().filter((e) => e.message?.type === 'BALL_END' && e.from === 'c');
    expect(ends).toHaveLength(1);
    expect(ends[0]?.message).toMatchObject({ payload: { grantSeq: grant, ballNumber: 1, finalScore: 4200 } });
    expect(types(m.host)).not.toContain('PAUSE:h');
    expect(m.seen.filter((x) => !x.includes('reconnected'))).toEqual([]);
    expect(m.client.log.head()).toEqual(m.host.log.head());
  });

  it('the player up is away for longer than the grace: the others see the pause, its ball end still counts, and its RESUME moves the match on instead of granting the finished ball again', async () => {
    const m = await wsMatch(40, 300);
    m.host.localBallEnd(100, 'nvram');
    await until(() => m.client.myGrant?.ballNumber === 1);
    m.ct.dropLinks('h');
    await until(() => m.host.state.paused !== null);
    expect(m.host.state.paused).toEqual({ reason: 'disconnect', player: 'c' });
    // On the client's own PC nothing locked: the grant is still its own, and the ball ends there meanwhile.
    expect(m.client.inputUnlocked).toBe(true);
    m.client.reportBallEnd(900, 'nvram');
    await until(() => m.seen.includes('c:reconnected:told'));
    // What the companion's controller does on `reconnected` for a pause of its own drop.
    expect(m.client.state.paused).toEqual({ reason: 'disconnect', player: 'c' });
    m.client.resume();
    await until(() => m.host.state.currentGrant?.grant.player === 'h' && m.host.state.currentGrant.grant.ballNumber === 2);
    // The pause reaches the client with its RECONNECT_ACK (it is in the entries it missed), before `reconnected`.
    expect(m.seen).toEqual(['h:peerLeft:c', 'h:pause:c', 'c:peerLeft:h', 'h:reconnected:told', 'c:pause:c', 'c:reconnected:told']);
    expect(types(m.host).slice(-5)).toEqual(['TURN_GRANT:h', 'PAUSE:h', 'BALL_END:c', 'RESUME:c', 'TURN_GRANT:h']);
    expect(m.host.state.players.c).toMatchObject({ score: 900, ballsPlayed: 1 });
    await until(() => m.client.log.head().hash === m.host.log.head().hash);
  });

  it('a client that says `resends` and holds the grant is not paused for when it is back inside the grace: the same grant, nothing in the log', async () => {
    const m = await wsMatch(2000, 30);
    m.host.localBallEnd(100, 'nvram');
    await until(() => m.client.myGrant?.ballNumber === 1);
    const grant = m.client.myGrant!.grantSeq;
    const head = m.host.log.head();
    m.ct.dropLinks('h');
    await until(() => m.seen.includes('h:reconnected:quiet') && m.seen.includes('c:reconnected:quiet'));
    await sleep(50);
    expect(m.seen.sort()).toEqual(['c:reconnected:quiet', 'h:reconnected:quiet']);
    expect(m.host.log.head()).toEqual(head);
    expect(m.client.myGrant?.grantSeq).toBe(grant);
    expect(m.client.inputUnlocked).toBe(true);
  });
});

/**
 * A client as 0.2.46 to 0.2.50 are: its RECONNECT has no `resends`, and it sends nothing again by itself. (Those
 * builds report a ball that ended while the link was away only for a grant the host issues again: their shell's
 * `tryReconcile` waits for `myTurn`.)
 */
function asBefore(client: ClientMatch): void {
  const c = client as unknown as { resendUnanswered(): void; buildReconnect(): Message<'RECONNECT'> };
  const build = c.buildReconnect.bind(client);
  c.resendUnanswered = () => undefined;
  c.buildReconnect = () => {
    const msg = build();
    delete (msg.payload as { resends?: boolean }).resends;
    return msg;
  };
}

describe('A18: what follows from "inside the grace it is not a disconnect" (review of PR 126)', () => {
  it('a client from before A18 holds the grant and its ball ends inside the grace: the pause it always got comes with its answer, its RESUME has the grant issued again, and the ball is in the log', async () => {
    const m = await wsMatch(2000, 60);
    asBefore(m.client);
    m.host.localBallEnd(100, 'nvram');
    await until(() => m.client.myGrant?.ballNumber === 1);
    const grant = m.client.myGrant!.grantSeq;
    // Every frame the host sends this client from here on, as its link delivers them.
    const frames: string[] = [];
    m.ct.onMessage((_from, msg) => frames.push(msg.type));
    m.ct.dropLinks('h');
    await until(() => m.host.snapshot().gone.includes('c'));
    // The ball drains while the link is away: this frame goes nowhere, and this client will not send it again.
    m.client.reportBallEnd(4200, 'nvram');
    // The host commits the pause before the RECONNECT_ACK, so the client finds it in what it missed. (The client's own
    // side raised no leave, its grace had not run out: its `reconnected` says quiet; the host's does not. And the host
    // tells nobody the client "left": it did not.)
    await until(() => m.seen.includes('c:reconnected:quiet'));
    expect(m.client.state.paused).toEqual({ reason: 'disconnect', player: 'c' });
    expect(m.seen).toEqual(['h:pause:c', 'h:reconnected:told', 'c:pause:c', 'c:reconnected:quiet']);
    // The pause reached this client in the answer's entries and nowhere else: sent live as well it would arrive ahead
    // of the RECONNECT_ACK, and the client's controller would resume twice (review 2 of PR 126, B).
    await sleep(30);
    expect(frames).toEqual(['RECONNECT_ACK']);
    // What that client's controller does: RESUME for its own drop; the grant comes again under a new number, and its
    // shell reports the table's ball end for it (`tryReconcile`).
    m.client.resume();
    await until(() => (m.client.myGrant?.grantSeq ?? 0) > grant);
    m.client.reportBallEnd(4200, 'nvram');
    await until(() => m.host.state.players.c?.ballsPlayed === 1 && m.host.state.currentGrant?.grant.player === 'h');
    expect(m.host.state.players.c?.score).toBe(4200);
    expect(types(m.host).slice(-6)).toEqual(['TURN_GRANT:h', 'PAUSE:h', 'RESUME:c', 'TURN_GRANT:h', 'BALL_END:c', 'TURN_GRANT:h']);
    await until(() => m.client.log.head().hash === m.host.log.head().hash);
  });

  it('a client from before A18 that holds the grant and reconnects with no drop ever noted here (its relay peer was replaced with no leave) is paused for all the same; one that says `resends` is not', async () => {
    const m = await wsMatch(DEFAULT_DISCONNECT_GRACE_MS, 60);
    asBefore(m.client);
    m.host.localBallEnd(100, 'nvram');
    await until(() => m.client.myGrant?.ballNumber === 1);
    const grant = m.client.myGrant!.grantSeq;
    expect(m.host.snapshot().gone).toEqual([]);
    // A second link from the same player, RECONNECT first, while the host has seen no leave.
    m.client.relinkTo('h');
    await until(() => m.seen.some((x) => x.startsWith('c:reconnected')));
    expect(m.host.state.paused).toEqual({ reason: 'disconnect', player: 'c' });
    expect(m.client.state.paused).toEqual({ reason: 'disconnect', player: 'c' });
    m.client.resume();
    await until(() => (m.client.myGrant?.grantSeq ?? 0) > grant);
    expect(m.host.state.paused).toBeNull();

    const n = await wsMatch(DEFAULT_DISCONNECT_GRACE_MS, 60);
    n.host.localBallEnd(100, 'nvram');
    await until(() => n.client.myGrant?.ballNumber === 1);
    const head = n.host.log.head();
    n.client.relinkTo('h');
    await until(() => n.seen.some((x) => x.startsWith('c:reconnected')));
    expect(n.host.log.head()).toEqual(head);
    expect(n.seen.filter((x) => x.includes('pause'))).toEqual([]);
  });

  it('a reconnect with no drop noted (a rejoin after a restart, a relink) is not a quiet return of a link that blinked: `quiet` is false on both ends, at the default grace', async () => {
    const m = await wsMatch(DEFAULT_DISCONNECT_GRACE_MS, 60);
    m.client.relinkTo('h');
    await until(() => m.seen.some((x) => x.startsWith('c:reconnected')) && m.seen.some((x) => x.startsWith('h:reconnected')));
    expect(m.seen.filter((x) => x.includes('reconnected')).sort()).toEqual(['c:reconnected:told', 'h:reconnected:told']);
    expect(m.seen.filter((x) => x.includes('peerLeft') || x.includes('pause'))).toEqual([]);
  });

  it('a client from before A18 that is only waiting is not paused for, inside the grace or after it', async () => {
    const m = await wsMatch(2000, 60);
    asBefore(m.client);
    const head = m.host.log.head();
    m.ct.dropLinks('h');
    await until(() => m.seen.includes('h:reconnected:quiet'));
    expect(m.seen.filter((x) => x.includes('pause'))).toEqual([]);
    expect(m.host.log.head()).toEqual(head);
  });

  it('a game that ends while a player is inside the grace waits for that player\'s signature: the RESULT carries it', async () => {
    const m = await wsMatch(2000, 150, { balls: 1, logSignTimeoutMs: 5000 });
    const results: PayloadOf<'RESULT'>[] = [];
    m.host.on('result', (x) => results.push(x.result));
    // The client's own game is over (its table's game ended early); the host has the last ball.
    m.client.reportGameOver(0, 0);
    await until(() => m.host.state.players.c?.status === 'finished');
    m.ct.dropLinks('h');
    await until(() => m.host.snapshot().gone.includes('c'));
    m.host.localBallEnd(100, 'nvram');
    expect(m.host.state.phase).toBe('ended');
    // The client's link dropped a moment ago: the RESULT does not go out without it.
    await sleep(40);
    expect(results).toEqual([]);
    // Back inside the grace: the game's end is in what it missed, it signs, and the RESULT has its signature.
    await until(() => results.length === 1);
    expect(results[0]?.signatures.map((s) => s.playerId)).toEqual(['c']);
    expect(results[0]?.signatures[0]).toMatchObject({ logHash: m.host.log.head().hash, logLength: m.host.log.length });
    expect(m.seen.filter((x) => !x.includes('reconnected'))).toEqual([]);
  });

  it('a LOG_SIGN that went into the dropped link is sent again after the reconnect, and the RESULT carries it', async () => {
    const m = await wsMatch(2000, 60, { balls: 1, logSignTimeoutMs: 5000 });
    const results: PayloadOf<'RESULT'>[] = [];
    m.host.on('result', (x) => results.push(x.result));
    // The link eats the client's first LOG_SIGN (it was on its way when the link dropped).
    let eaten = 0;
    const send = m.ct.send.bind(m.ct);
    m.ct.send = (to, msg) => {
      if (msg.type === 'LOG_SIGN' && eaten === 0) {
        eaten += 1;
        m.ct.dropLinks('h');
        return;
      }
      send(to, msg);
    };
    m.host.localBallEnd(100, 'nvram');
    await until(() => m.client.myGrant?.ballNumber === 1);
    m.client.reportBallEnd(250, 'nvram');
    await until(() => results.length === 1);
    expect(eaten).toBe(1);
    expect(results[0]?.signatures.map((s) => s.playerId)).toEqual(['c']);
    expect(m.seen.filter((x) => !x.includes('reconnected'))).toEqual([]);
  });

  it('the grace is carried through a host transfer: a host that took over from an engine made with none has none', async () => {
    const r = await mesh(['a', 'b'], { balls: 2, graceMs: 0 });
    let taken: HostMatch | null = null;
    r.clients['a']!.on('becameHost', (h) => (taken = h));
    r.host.transferHost('a');
    await flush();
    const host = taken as HostMatch | null;
    if (!host) throw new Error('a did not become host');
    const left: string[] = [];
    host.on('peerLeft', (id) => left.push(id));
    r.bus.disconnect('b');
    await flush();
    // With the default five seconds on this manual clock nothing would have been raised.
    expect(left).toEqual(['b']);
  });
});

/**
 * What a 0.2.46 to 0.2.50 client does with an accepted RECONNECT_ACK, written out from the v0.2.50 tag
 * (`client.ts` `onReconnectAck` and `mergeEntries`; `log.ts` is unchanged since) and run here on the frame as the host
 * sent it, on a copy of the log that client held when it sent its RECONNECT. It appends the entries after its head,
 * checking each `prevHash` and `hash`, then compares the head it ends at with the `logHash` the ACK names, and raises
 * `desync` (`reconnect.entries`) when they differ. Returns that desync, or null when the ACK describes the log it
 * carries. (The ACK's `logLength` is not looked at by that client; it is asserted beside this.)
 */
function ackAsZeroTwoFifty(held: LogEntry[], ack: PayloadOf<'RECONNECT_ACK'>): { expected: string; actual: string } | null {
  const log = MatchLog.fromJSON(held);
  let chained = true;
  for (const raw of ack.entries) {
    if (raw.index < log.length) {
      if (log.at(raw.index)?.hash !== raw.hash) {
        chained = false;
        break;
      }
      continue;
    }
    if (raw.index !== log.length || raw.prevHash !== log.head().hash) {
      chained = false;
      break;
    }
    const message = raw.message === undefined ? undefined : parseMessage(raw.message);
    const body: LogEntryBody = { index: raw.index, prevHash: raw.prevHash, ts: raw.ts, kind: raw.kind, from: raw.from };
    if (message !== undefined) body.message = message;
    if (raw.event !== undefined) body.event = raw.event;
    if (hashEntry(body) !== raw.hash) {
      chained = false;
      break;
    }
    log.append({ ts: raw.ts, kind: raw.kind, from: raw.from, message, event: raw.event });
  }
  const head = log.head();
  return !chained || head.hash !== ack.logHash ? { expected: ack.logHash, actual: head.hash } : null;
}

describe('A18: the RECONNECT_ACK that carries the pause for an older grant holder names the head of the log it carries', () => {
  /**
   * An older client holds the grant and reconnects (`how`); the ACK the host sends it is taken off the wire and put
   * through 0.2.50's check. Before the fix the host read the head for the ACK first and committed the pause after:
   * `logHash` was one entry behind `entries`, and that client raised `desync` at the very reconnect the pause is for.
   */
  async function ackFor(how: 'a drop inside the grace' | 'no drop noted') {
    const m = await wsMatch(DEFAULT_DISCONNECT_GRACE_MS, 60);
    asBefore(m.client);
    m.host.localBallEnd(100, 'nvram');
    await until(() => m.client.myGrant?.ballNumber === 1);
    const acks: PayloadOf<'RECONNECT_ACK'>[] = [];
    m.ct.onMessage((_from, msg) => {
      if (msg.type === 'RECONNECT_ACK') acks.push(msg.payload);
    });
    const desyncs: string[] = [];
    m.client.on('desync', (d) => desyncs.push(d.context));
    // The log this client holds when its RECONNECT goes out (nothing reaches it between here and the answer).
    const held = JSON.parse(JSON.stringify(m.client.log.toJSON())) as LogEntry[];
    if (how === 'a drop inside the grace') m.ct.dropLinks('h');
    else m.client.relinkTo('h');
    await until(() => acks.length === 1 && m.seen.some((x) => x.startsWith('c:reconnected')));
    return { m, ack: acks[0]!, held, desyncs };
  }

  it.each(['a drop inside the grace', 'no drop noted'] as const)('%s: one entry, the PAUSE; the head the ACK names is the head after it, and a 0.2.50 client raises no desync', async (how) => {
    const { m, ack, held, desyncs } = await ackFor(how);
    expect(ack.accept).toBe(true);
    expect(ack.entries.map((e) => e.message?.type)).toEqual(['PAUSE']);
    expect(ack.entries[0]?.message).toMatchObject({ payload: { reason: 'disconnect', player: 'c' } });
    // The ACK describes the log it carries: its head is the host's head, which is the PAUSE's hash and position.
    expect({ hash: ack.logHash, length: ack.logLength }).toEqual(m.host.log.head());
    expect(ack.logHash).toBe(ack.entries[0]?.hash);
    expect(ack.logLength).toBe(held.length + 1);
    // 0.2.50's own check on that frame, and the same check as this build's client made it.
    expect(ackAsZeroTwoFifty(held, ack)).toBeNull();
    expect(desyncs).toEqual([]);
    expect(m.client.log.head()).toEqual(m.host.log.head());
  });

  it('the check itself: an ACK whose `logHash` is one entry behind its entries is a desync for a 0.2.50 client', async () => {
    const { ack, held } = await ackFor('no drop noted');
    const before = held[held.length - 1]!.hash;
    expect(ackAsZeroTwoFifty(held, { ...ack, logHash: before, logLength: held.length })).toEqual({ expected: before, actual: ack.entries[0]!.hash });
  });
});
