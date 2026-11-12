/**
 * A13 (2026-11-12, three matches stuck at `grant 1: my ball 1` on an unpatched original table): whether a player's
 * table can report ball ends reaches the host and every lobby (HELLO / PARTICIPANT_UPDATE -> HELLO_ACK), the lobby
 * names the players whose table cannot, and the host passes a turn by hand (TURN_PASS, logged) for its own ball and
 * for a client's. Engine tests on the real HostMatch / ClientMatch over a MemoryBus; controller tests on top of them.
 */
import { describe, expect, it } from 'vitest';
import type { GameFingerprint, ParticipantInfo, PayloadOf } from '@castcade/protocol';
import type { MatchMedia, MediaStatus, PanelState } from '../media/match-media-types.js';
import { ClientMatch, type ResultInfo } from './client.js';
import { ManualClock } from './clock.js';
import { MatchController, type ControllerFeed } from './controller.js';
import { HostMatch, type RejectInfo } from './host.js';
import { generateKeys, type KeyPair } from './keys.js';
import { MemoryBus } from './transport.js';

const flush = async (n = 12): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setTimeout(r, 0));
};

const game: GameFingerprint = { kind: 'vpx', tableName: 'Dark Chaos', tableHash: 'ab'.repeat(32), romName: null, romHash: null, physicsHash: null, recipeVersion: '0.5.0', sidecarHash: null, emulatorVersion: '10.8.0' };
const NAMES: Record<string, string> = { h: 'Owner', a: 'Krobs', b: 'Chuck' };
const participant = (id: string, keys: KeyPair): ParticipantInfo => ({ playerId: id, displayName: NAMES[id] ?? id, publicKey: keys.publicKeyB64, rig: 'pc' });

interface ClientSpec {
  id: string;
  ballEndReady?: boolean;
}

async function engines(opts: { balls?: number; hostReady?: boolean; clients: ClientSpec[] }) {
  const bus = new MemoryBus();
  const clock = new ManualClock();
  const hk = generateKeys();
  const host = new HostMatch({
    transport: bus.transport('h'),
    keys: hk,
    matchId: 'M',
    ballsPerGame: opts.balls ?? 2,
    hostParticipant: participant('h', hk),
    hostGame: game,
    clock,
    ...(opts.hostReady !== undefined ? { ballEndReady: opts.hostReady } : {}),
  });
  const hostRejects: RejectInfo[] = [];
  host.on('reject', (r) => hostRejects.push(r));
  const clients: Record<string, ClientMatch> = {};
  const acks: Record<string, PayloadOf<'HELLO_ACK'>[]> = {};
  const rejects: Record<string, PayloadOf<'REJECT'>[]> = {};
  const results: Record<string, ResultInfo[]> = {};
  for (const c of opts.clients) {
    const k = generateKeys();
    const cm = new ClientMatch({
      transport: bus.transport(c.id),
      keys: k,
      participant: participant(c.id, k),
      game,
      throwdownCode: 'M',
      hostId: 'h',
      clock,
      ...(c.ballEndReady !== undefined ? { ballEndReady: c.ballEndReady } : {}),
    });
    const seen: PayloadOf<'HELLO_ACK'>[] = [];
    const rj: PayloadOf<'REJECT'>[] = [];
    const rs: ResultInfo[] = [];
    cm.on('joined', (ack) => seen.push(ack));
    cm.on('roster', (ack) => seen.push(ack));
    cm.on('reject', (r) => rj.push(r));
    cm.on('result', (r) => rs.push(r));
    clients[c.id] = cm;
    acks[c.id] = seen;
    rejects[c.id] = rj;
    results[c.id] = rs;
    cm.join();
    await flush();
  }
  const lastAck = (id: string): PayloadOf<'HELLO_ACK'> => {
    const list = acks[id] ?? [];
    const ack = list[list.length - 1];
    if (!ack) throw new Error(`${id} has no HELLO_ACK`);
    return ack;
  };
  return { bus, clock, host, clients, lastAck, hostRejects, rejects, results };
}

const readyList = (ack: PayloadOf<'HELLO_ACK'>): Record<string, boolean> => Object.fromEntries(ack.ballEndReady.map((x) => [x.playerId, x.ready]));

describe('A13: ball-end readiness in the lobby (engine)', () => {
  it('HELLO and the host say it; HELLO_ACK carries everyone to every client; absent stays unknown', async () => {
    const r = await engines({ hostReady: false, clients: [{ id: 'a', ballEndReady: true }, { id: 'b' }] });
    expect(r.host.ballEndReadiness()).toEqual({ h: false, a: true });
    // b said nothing (no table open, or a companion from before A13): not listed, which is unknown, not unreadable.
    expect(readyList(r.lastAck('a'))).toEqual({ h: false, a: true });
    expect(readyList(r.lastAck('b'))).toEqual({ h: false, a: true });
  });

  it('it follows the table: a PARTICIPANT_UPDATE and the host own update reach everyone; no change sends nothing', async () => {
    const r = await engines({ clients: [{ id: 'a', ballEndReady: true }, { id: 'b' }] });
    const b = r.clients['b']!;
    expect(r.host.ballEndReadiness()).toEqual({ a: true });

    // b opens an unpatched table.
    expect(b.updateParticipant({ ballEndReady: false })).toBe(true);
    await flush();
    expect(r.host.ballEndReadiness()).toEqual({ a: true, b: false });
    expect(readyList(r.lastAck('a'))).toEqual({ a: true, b: false });
    expect(b.updateParticipant({ ballEndReady: false })).toBe(false);

    // b opens the patched one instead; the host's own table turns out unreadable.
    expect(b.updateParticipant({ ballEndReady: true })).toBe(true);
    expect(r.host.updateLocal({ ballEndReady: false })).toBe(true);
    expect(r.host.updateLocal({ ballEndReady: false })).toBe(false);
    await flush();
    expect(readyList(r.lastAck('a'))).toEqual({ h: false, a: true, b: true });
    expect(readyList(r.lastAck('b'))).toEqual({ h: false, a: true, b: true });

    // The engine does not gate the start on it (the shell asks the host to confirm).
    r.host.start();
    await flush();
    expect(r.clients['a']!.state.phase).toBe('running');
  });
});

describe('A13: the host passes the turn (engine)', () => {
  it('for its own ball and for a client: folded like a BALL_END, logged as the host TURN_PASS, the same log everywhere', async () => {
    const r = await engines({ balls: 2, clients: [{ id: 'a' }, { id: 'b' }] });
    const a = r.clients['a']!;
    const b = r.clients['b']!;
    expect(r.host.passTurnBlocker()).toBe('no game is being played');
    expect(r.host.passTurn()).toBe(false);
    r.host.start();
    await flush();
    expect(r.host.state.currentGrant?.grant).toMatchObject({ player: 'h', ballNumber: 1, grantSeq: 1 });

    // The host's own ball.
    expect(r.host.passTurn(1234)).toBe(true);
    await flush();
    expect(r.host.state.players['h']).toMatchObject({ ballsPlayed: 1, score: 1234, status: 'playing' });
    expect(r.host.state.currentGrant?.grant).toMatchObject({ player: 'a', ballNumber: 1, grantSeq: 2 });
    expect(a.inputUnlocked).toBe(true);

    // A client's ball: the client is locked again and the next player is up.
    const passedAtA: PayloadOf<'TURN_PASS'>[] = [];
    a.on('turnPassed', (m) => passedAtA.push(m.payload));
    expect(r.host.passTurn(500)).toBe(true);
    await flush();
    expect(passedAtA).toEqual([{ grantSeq: 2, player: 'a', ballNumber: 1, score: 500 }]);
    expect(a.inputUnlocked).toBe(false);
    expect(a.myGrant).toBeNull();
    expect(b.inputUnlocked).toBe(true);
    for (const st of [r.host.state, a.state, b.state]) {
      expect(st.players['a']).toMatchObject({ ballsPlayed: 1, score: 500 });
      expect(st.currentGrant?.grant).toMatchObject({ player: 'b', ballNumber: 1, grantSeq: 3 });
    }

    // The log: the passes are the host's own entries, in the chain, identical on every side.
    const passes = r.host.log.entries().filter((e) => e.message?.type === 'TURN_PASS');
    expect(passes.map((e) => [e.kind, e.from, (e.message as { payload: PayloadOf<'TURN_PASS'> }).payload.player])).toEqual([
      ['msg', 'h', 'h'],
      ['msg', 'h', 'a'],
    ]);
    expect(a.log.head()).toEqual(r.host.log.head());
    expect(b.log.head()).toEqual(r.host.log.head());
  });

  it('a late real BALL_END for a passed ball is rejected and changes nothing (the host own, and a client)', async () => {
    const r = await engines({ balls: 2, clients: [{ id: 'a' }] });
    const a = r.clients['a']!;
    r.host.start();
    await flush();

    // The host passes its own ball 1 (grant 1), then its table reports that ball after all.
    r.host.passTurn(100);
    await flush();
    const before = r.host.log.head();
    r.host.localBallEnd(9999, 'nvram', false, { grantSeq: 1, ballNumber: 1 });
    expect(r.hostRejects[r.hostRejects.length - 1]).toMatchObject({ to: 'h', refType: 'BALL_END', code: 'not_grant_holder' });
    expect(r.host.log.head()).toEqual(before);
    expect(r.host.state.players['h']).toMatchObject({ ballsPlayed: 1, score: 100 });

    // The client's ball 1 (grant 2) is passed; its BALL_END for that grant was already on the way.
    r.host.passTurn(200);
    await flush();
    const head = r.host.log.head();
    a.reportBallEnd(7777, 'nvram', false, { grantSeq: 2, ballNumber: 1 });
    await flush();
    expect(r.rejects['a']!.map((x) => [x.refType, x.code])).toEqual([['BALL_END', 'not_grant_holder']]);
    expect(r.host.log.head()).toEqual(head);
    expect(a.log.head()).toEqual(head);
    expect(r.host.state.players['a']).toMatchObject({ ballsPlayed: 1, score: 200 });

    // When the passed player holds the next grant too (the host finished), the old grantSeq is a stale grant.
    r.host.passTurn(300); // the host's ball 2: its game is over
    await flush();
    expect(r.host.state.players['h']).toMatchObject({ ballsPlayed: 2, status: 'finished' });
    expect(r.host.state.currentGrant?.grant).toMatchObject({ player: 'a', ballNumber: 2, grantSeq: 4 });
    a.reportBallEnd(8888, 'nvram', false, { grantSeq: 2, ballNumber: 1 });
    await flush();
    expect(r.rejects['a']!.map((x) => x.code)).toEqual(['not_grant_holder', 'stale_grant']);
    expect(r.host.state.players['a']).toMatchObject({ ballsPlayed: 1, score: 200 });
    expect(a.inputUnlocked).toBe(true);
  });

  it('a pass of the last ball ends the game: every side signs the same log and the RESULT stands', async () => {
    const r = await engines({ balls: 1, clients: [{ id: 'a' }] });
    const a = r.clients['a']!;
    const hostResults: PayloadOf<'RESULT'>[] = [];
    r.host.on('result', (x) => hostResults.push(x.result));
    r.host.start();
    await flush();
    r.host.localBallEnd(4000, 'nvram');
    await flush();
    expect(r.host.passTurn(2500)).toBe(true);
    await flush();
    expect(r.host.state.phase).toBe('ended');
    expect(r.host.passTurn()).toBe(false);
    expect(hostResults).toHaveLength(1);
    expect(hostResults[0]!.entries.map((e) => [e.playerId, e.score, e.ballsPlayed, e.status, e.rank])).toEqual([
      ['h', 4000, 1, 'finished', 1],
      ['a', 2500, 1, 'finished', 2],
    ]);
    expect(hostResults[0]!.signatures.map((s) => [s.playerId, s.logHash === hostResults[0]!.logHash])).toEqual([['a', true]]);
    expect(r.results['a']).toHaveLength(1);
    expect(r.results['a']![0]).toMatchObject({ logMatches: true, signatureValid: true });
    expect(a.log.head()).toEqual(r.host.log.head());
  });

  it('a client cannot pass the turn, and a TURN_PASS that does not name the outstanding grant is dropped by a client', async () => {
    const r = await engines({ balls: 2, clients: [{ id: 'a' }] });
    const a = r.clients['a']!;
    r.host.start();
    await flush();
    const head = r.host.log.head();
    // From a client: not a client -> host message.
    a.session.transport.send('h', a.session.build('TURN_PASS', { grantSeq: 1, player: 'h', ballNumber: 1, score: 1 }, 'M'));
    await flush();
    expect(r.rejects['a']!.map((x) => [x.refType, x.code])).toEqual([['TURN_PASS', 'unexpected_state']]);
    expect(r.host.log.head()).toEqual(head);
    // From the host, but for a grant that is not outstanding: the client does not log it.
    const dropped: string[] = [];
    a.on('dropped', (d) => dropped.push(`${d.type}:${d.reason}`));
    r.host.session.transport.send('a', r.host.session.build('TURN_PASS', { grantSeq: 7, player: 'h', ballNumber: 1, score: 1 }, 'M'));
    await flush();
    expect(dropped).toEqual(['TURN_PASS:unexpected']);
    expect(a.log.head()).toEqual(head);
  });
});

// ---------------------------------------------------------------------------------------------
// The controller
// ---------------------------------------------------------------------------------------------

class FakeMedia implements MatchMedia {
  sending: boolean[] = [];
  panels: PanelState[] = [];
  attach(): Promise<void> {
    return Promise.resolve();
  }
  addPeer(): void {}
  removePeer(): void {}
  setSending(on: boolean): void {
    if (this.sending[this.sending.length - 1] !== on) this.sending.push(on);
  }
  setPanelState(s: PanelState): void {
    this.panels.push(s);
  }
  setMuted(): void {}
  status(): MediaStatus {
    return { attached: true, sending: this.sending[this.sending.length - 1] ?? false, peers: {}, mic: 'open', captureSource: null, lastError: null };
  }
  onStatus(): () => void {
    return () => undefined;
  }
  frames(): null {
    return null;
  }
  showPanel(): void {}
  detach(): Promise<void> {
    return Promise.resolve();
  }
}

function seat(role: HostMatch | ClientMatch, clock: ManualClock) {
  const locks: ('lock' | 'unlock')[] = [];
  const media = new FakeMedia();
  const logs: string[] = [];
  const ctl = new MatchController({
    role,
    localId: role.localId,
    lock: { lock: () => locks.push('lock'), unlock: () => locks.push('unlock') },
    cue: { play: () => undefined },
    media,
    now: () => clock.now(),
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeout: (h) => clock.clearTimeout(h),
    log: (l) => logs.push(l),
    ballsPerGame: 2,
  });
  return { ctl, locks, media, logs };
}

async function seats(balls = 2) {
  const bus = new MemoryBus();
  const clock = new ManualClock();
  const hk = generateKeys();
  const ck = generateKeys();
  const host = new HostMatch({ transport: bus.transport('h'), keys: hk, matchId: 'M', ballsPerGame: balls, hostParticipant: participant('h', hk), hostGame: game, clock });
  const client = new ClientMatch({ transport: bus.transport('a'), keys: ck, participant: participant('a', ck), game, throwdownCode: 'M', hostId: 'h', clock });
  const H = seat(host, clock);
  const C = seat(client, clock);
  await H.ctl.open();
  await C.ctl.open();
  client.join();
  await flush();
  return { clock, host, client, H, C };
}

const scores = (s: number): ControllerFeed => ({ kind: 'current_scores', t: 0, scores: [s], player: 1, ball: 1 });
const ballEnd = (ball: number): ControllerFeed => ({ kind: 'ball_end', t: 0, player: 1, ball, extraBalls: 0 });
const gameStart: ControllerFeed = { kind: 'game_start', t: 0, players: 1 } as ControllerFeed;
const UNREAD = 'its score is not being read (not patched, or an original table)';
const DARK = "Dark Chaos is an original table (no ROM). Castcade can't read an original's score yet.";

describe('A13: the lobby names a table that cannot report ball ends (controller)', () => {
  it('a client on an unpatched original: both lobby lines say so, the start from the table does not go, and it clears when the table is readable', async () => {
    const r = await seats();
    // Nothing known: nothing is warned (unknown is not unreadable).
    expect(r.H.ctl.status()).toMatchObject({ ballEnds: {}, startWarnings: [] });
    expect(r.H.ctl.status().panel.message).toBe('Everyone in? Start a game on your table (or press Start match)');

    // Krobs opens Dark Chaos, unpatched: his witness says why, his companion tells the host.
    r.C.ctl.setLocalBallEnds(false, DARK);
    r.client.updateParticipant({ ballEndReady: false });
    r.H.ctl.setLocalBallEnds(true, null);
    r.host.updateLocal({ ballEndReady: true });
    await flush();
    expect(r.H.ctl.status().ballEnds).toEqual({ h: true, a: false });
    expect(r.H.ctl.status().startWarnings).toEqual([`Krobs's table cannot report ball ends: ${UNREAD}`]);
    expect(r.H.ctl.status().panel.message).toBe(`Krobs's table cannot report ball ends: ${UNREAD} · Start match on the Match tab starts anyway; Pass the turn then ends such a ball by hand`);
    expect(r.C.ctl.status().ballEnds).toEqual({ h: true, a: false });
    expect(r.C.ctl.status().startWarnings).toEqual([`Your table cannot report ball ends: ${DARK}`]);
    expect(r.C.ctl.status().panel.message).toBe(`Your table cannot report ball ends: ${DARK}`);

    // A11: the host presses Start on its table: no countdown, and the log says why.
    r.H.ctl.feed(gameStart);
    await flush();
    expect(r.host.countdownRemaining()).toBeNull();
    expect(r.host.state.phase).toBe('lobby');
    expect(r.H.logs.some((l) => l.includes("Krobs's table cannot report ball ends; the match does not start from the table"))).toBe(true);

    // Krobs opens a patched table instead: the warning goes, and the table start works again.
    r.C.ctl.setLocalBallEnds(true, null);
    r.client.updateParticipant({ ballEndReady: true });
    await flush();
    expect(r.H.ctl.status()).toMatchObject({ ballEnds: { h: true, a: true }, startWarnings: [] });
    expect(r.C.ctl.status().startWarnings).toEqual([]);
    expect(r.H.ctl.status().panel.message).not.toContain('cannot report ball ends');
    r.H.ctl.feed({ kind: 'game_end', t: 0, scores: [0], players: 1 });
    r.H.ctl.feed(gameStart);
    await flush();
    expect(r.host.countdownRemaining()).not.toBeNull();
  });

  it("the host's own unreadable table is named on both sides, with the witness's reason on the host's", async () => {
    const r = await seats();
    r.H.ctl.setLocalBallEnds(false, DARK);
    r.host.updateLocal({ ballEndReady: false });
    await flush();
    expect(r.H.ctl.status().startWarnings).toEqual([`Your table cannot report ball ends: ${DARK}`]);
    expect(r.C.ctl.status().startWarnings).toEqual([`Owner's table cannot report ball ends: ${UNREAD}`]);
    // After the start the lobby warning is gone; the roster facts stay.
    r.host.start();
    await flush();
    expect(r.H.ctl.status()).toMatchObject({ startWarnings: [], ballEnds: { h: false } });
  });
});

describe('A13: Pass the turn (controller)', () => {
  it("the host's own ball, then the client's: the passed table locks, the last known score stands, nothing more is reported for that ball", async () => {
    const r = await seats(2);
    expect(r.H.ctl.status().pass).toBeNull();
    r.host.start();
    await flush();
    // A client is never offered the pass.
    expect(r.C.ctl.status().pass).toBeNull();
    expect(r.C.ctl.passTurn()).toBe(false);

    // The host is up, its table reports a score but never a ball end.
    r.H.ctl.feed(scores(1500));
    await flush();
    expect(r.H.ctl.status().pass).toEqual({ player: 'h', name: 'Owner', ball: 1, score: 1500 });
    expect(r.H.ctl.passTurn()).toBe(true);
    await flush();
    expect(r.H.ctl.status()).toMatchObject({ myTurn: false, locked: true });
    expect(r.H.media.sending[r.H.media.sending.length - 1]).toBe(false);
    expect(r.H.logs.some((l) => l.includes('passed the turn: my ball 1 ended by hand at 1500'))).toBe(true);
    const hostRow = (s: PanelState) => s.players.find((p) => p.id === 'h');
    expect(hostRow(r.H.ctl.status().panel)).toMatchObject({ score: 1500, ballsDone: 1, isUp: false });
    expect(hostRow(r.C.ctl.status().panel)).toMatchObject({ score: 1500, ballsDone: 1, isUp: false });
    expect(r.C.ctl.status()).toMatchObject({ myTurn: true, locked: false });
    // The host's table reports that ball after all: nothing goes out.
    const head = r.host.log.head();
    r.H.ctl.feed(ballEnd(1));
    r.H.ctl.feed(scores(1600));
    r.clock.advance(3000);
    await flush();
    expect(r.host.log.head()).toEqual(head);

    // The client is up: its last STATE is the score the pass ends at.
    r.C.ctl.feed(scores(700));
    await flush();
    expect(r.H.ctl.status().pass).toEqual({ player: 'a', name: 'Krobs', ball: 1, score: 700 });
    expect(r.H.ctl.passTurn()).toBe(true);
    await flush();
    expect(r.C.ctl.status()).toMatchObject({ myTurn: false, locked: true });
    expect(r.C.media.sending[r.C.media.sending.length - 1]).toBe(false);
    expect(r.C.logs.some((l) => l.includes('Owner (host) passed the turn: my ball 1 ended by hand at 700'))).toBe(true);
    expect(r.client.state.players['a']).toMatchObject({ ballsPlayed: 1, score: 700 });
    // The host holds ball 2 now; the client's table ends the passed ball late: no BALL_END, no reject, the same log.
    expect(r.H.ctl.status()).toMatchObject({ myTurn: true, locked: false });
    expect(r.H.ctl.status().panel).toMatchObject({ playerUp: 'h', ball: 2 });
    const head2 = r.host.log.head();
    r.C.ctl.feed(ballEnd(1));
    r.C.ctl.feed(scores(900));
    r.clock.advance(3000);
    await flush();
    expect(r.host.log.head()).toEqual(head2);
    expect(r.client.log.head()).toEqual(head2);
    expect(r.C.ctl.status().panel.message ?? '').not.toContain('rejected');
  });

  it('a ball end the table reported is waiting for its bonus when the host passes: the pass wins, one entry', async () => {
    const r = await seats(2);
    r.host.start();
    await flush();
    r.H.ctl.feed(scores(1000));
    r.H.ctl.feed(ballEnd(1)); // pending: the controller waits for the bonus
    expect(r.H.ctl.passTurn()).toBe(true);
    r.clock.advance(3000);
    await flush();
    const types = r.host.log.entries().map((e) => e.message?.type);
    expect(types.filter((t) => t === 'TURN_PASS')).toHaveLength(1);
    expect(types.filter((t) => t === 'BALL_END')).toHaveLength(0);
    expect(r.host.state.currentGrant?.grant).toMatchObject({ player: 'a', ballNumber: 1 });
  });
});
