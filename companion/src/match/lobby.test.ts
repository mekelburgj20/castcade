/**
 * A17 step 5 (2026-11-25): the lobby in the engine, with `HostOptions.lobby` / `ClientOptions.lobby` on, over the
 * in-memory bus: the members and their choices, a match with chosen players (the lobby's PC among them or not),
 * matches in sequence with a log each, watchers, a join while a match is open (the log unasked, in pages, and the
 * logged stream held back until it is whole), the paged RECONNECT_ACK, and what is refused. What the option leaves
 * alone when it is off is `lobby-off.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { buildMessage, type AnyMessage, type GameFingerprint, type ParticipantInfo, type PayloadOf, type PlayerId, type Stance } from '@castcade/protocol';
import { ClientMatch, type DroppedInfo, type ResultInfo } from './client.js';
import { ManualClock } from './clock.js';
import { HostMatch, type LobbyOptions, type RejectInfo } from './host.js';
import { generateKeys, signCanonical, verifyCanonical, type KeyPair } from './keys.js';
import { GENESIS_HASH, type MatchLog } from './log.js';
import { fixedKeys, TapTransport, type RecordedFrame } from './lobby-off.test-support.js';
import { logSignBody } from './result.js';
import { MemoryBus, type Transport } from './transport.js';

const flush = async (n = 8): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setTimeout(r, 0));
};

const hex = 'ab'.repeat(32);
const game: GameFingerprint = { kind: 'vpx', tableName: 'MM', tableHash: hex, romName: 'mm_109c', romHash: hex, physicsHash: null, recipeVersion: '0.1.0', sidecarHash: hex, emulatorVersion: '10.8.0' };
const who = (id: string, keys: KeyPair): ParticipantInfo => ({ playerId: id, displayName: id, publicKey: keys.publicKeyB64, rig: 'pc' });

interface Rig {
  bus: MemoryBus;
  clock: ManualClock;
  host: HostMatch;
  hostKeys: KeyPair;
  clients: Record<string, ClientMatch>;
  keys: Record<string, KeyPair>;
  rejects: RejectInfo[];
  dropped: Record<string, DroppedInfo[]>;
  results: Record<string, ResultInfo[]>;
  /** Join one more member now (also while a match is open). */
  join(id: string, stance?: Stance): ClientMatch;
}

interface RigOptions {
  balls?: number;
  /** Each member's choice at the join; not named = play. `h` is the lobby's PC. */
  stances?: Record<string, Stance>;
  lobby?: LobbyOptions;
  grace?: number;
}

async function lobby(clientIds: string[], opts: RigOptions = {}): Promise<Rig> {
  const bus = new MemoryBus();
  const clock = new ManualClock();
  const hostKeys = generateKeys();
  const host = new HostMatch({
    disconnectGraceMs: opts.grace ?? 0,
    transport: bus.transport('h'),
    keys: hostKeys,
    matchId: 'JHDFEF',
    ballsPerGame: opts.balls ?? 1,
    hostParticipant: who('h', hostKeys),
    hostGame: game,
    clock,
    lobby: { ...(opts.lobby ?? {}), stance: opts.stances?.['h'] ?? 'play' },
  });
  const r: Rig = {
    bus,
    clock,
    host,
    hostKeys,
    clients: {},
    keys: {},
    rejects: [],
    dropped: {},
    results: {},
    join(id, stance) {
      const k = generateKeys();
      r.keys[id] = k;
      const c = new ClientMatch({
        disconnectGraceMs: opts.grace ?? 0,
        transport: bus.transport(id),
        keys: k,
        participant: who(id, k),
        game,
        throwdownCode: 'JHDFEF',
        hostId: 'h',
        clock,
        lobby: { stance: stance ?? opts.stances?.[id] ?? 'play' },
      });
      r.clients[id] = c;
      r.dropped[id] = [];
      r.results[id] = [];
      c.on('dropped', (d) => r.dropped[id]?.push(d));
      c.on('result', (x) => r.results[id]?.push(x));
      c.join();
      return c;
    },
  };
  host.on('reject', (x) => r.rejects.push(x));
  for (const id of clientIds) r.join(id);
  await flush();
  return r;
}

/** Whoever holds the grant ends their ball, until the game is over and its RESULT is out. Scores count up from `base`. */
async function playGame(r: Rig, base = 100): Promise<void> {
  let n = 0;
  for (let guard = 0; guard < 200 && r.host.state.phase === 'running'; guard++) {
    const g = r.host.state.currentGrant?.grant;
    if (!g) throw new Error('no grant is outstanding');
    n += 1;
    if (g.player === 'h') r.host.localBallEnd(base + n, 'nvram');
    else (r.clients[g.player] as ClientMatch).reportBallEnd(base + n, 'script');
    await flush(4);
  }
  await flush();
  if (!r.host.resultOut) throw new Error('the game ended and no RESULT went out');
}

/** A log that is one match from its first entry: MATCH_READY at index 0 on 64 zeros, an unbroken chain, grants from 1. */
function expectOwnLog(log: MatchLog, matchId: string): void {
  const first = log.at(0);
  expect(first?.index).toBe(0);
  expect(first?.prevHash).toBe(GENESIS_HASH);
  expect(first?.message?.type).toBe('MATCH_READY');
  expect(first?.message?.matchId).toBe(matchId);
  expect(log.verifyChain()).toEqual({ ok: true });
  const grants = log.entries().flatMap((e) => (e.message?.type === 'TURN_GRANT' ? [e.message.payload.grant] : []));
  expect(grants.map((g) => g.grantSeq)).toEqual(grants.map((_, i) => i + 1));
  for (const g of grants) expect(g.matchId).toBe(matchId);
  for (const e of log.entries()) expect(e.message?.matchId ?? matchId).toBe(matchId);
}

describe('A17 step 5: the lobby and its members', () => {
  it('HELLO says Play or Watch, HELLO_ACK is the lobby as it is, and the lobby`s PC is a row like any other', async () => {
    const r = await lobby(['a', 'b'], { stances: { b: 'watch' } });
    const acks: PayloadOf<'HELLO_ACK'>[] = [];
    r.host.on('lobby', (x) => acks.push(x));
    expect(r.host.isLobby).toBe(true);
    expect(r.host.lobbyCode).toBe('JHDFEF');
    expect(r.host.members().map((p) => p.playerId)).toEqual(['h', 'a', 'b']);
    expect(['h', 'a', 'b'].map((id) => r.host.stanceOf(id))).toEqual(['play', 'play', 'watch']);
    expect(r.host.stanceOf('nobody')).toBeNull();
    expect(r.host.playSet()).toEqual(['h', 'a']);
    const seen = r.clients['a']?.lobby();
    expect(seen?.participants.map((p) => p.playerId)).toEqual(['h', 'a', 'b']);
    expect(seen?.stances).toEqual([
      { playerId: 'h', stance: 'play' },
      { playerId: 'a', stance: 'play' },
      { playerId: 'b', stance: 'watch' },
    ]);
    expect(seen?.match).toBeNull();
    expect(seen?.away).toEqual([]);
    expect(seen?.ballsPerGame).toBe(1);
    // Step 6: who may start from their own table (the first set to Play), and that no start is announced.
    expect(seen?.starter).toBe('h');
    expect(seen?.start).toBeNull();
    expect(seen?.tablePickedBy).toBe('h');
    expect(seen?.otherTable).toEqual([]);

    // Each member changes their own choice; the lobby's PC its own, the same way.
    expect(r.clients['b']?.setStance('play')).toBe(true);
    expect(r.clients['b']?.setStance('play')).toBe(false);
    expect(r.host.updateLocal({ stance: 'watch' })).toBe(true);
    expect(r.host.updateLocal({ stance: 'watch' })).toBe(false);
    await flush();
    expect(r.host.playSet()).toEqual(['a', 'b']);
    expect(r.clients['a']?.lobby()?.stances?.map((s) => s.stance)).toEqual(['watch', 'play', 'play']);
    expect(acks.length).toBe(2);
    // The table facts a member's PC says about itself.
    r.clients['a']?.updateParticipant({ noCopy: true, ownGame: true });
    await flush();
    expect(r.clients['b']?.lobby()?.noCopy).toEqual(['a']);
    expect(r.clients['b']?.lobby()?.ownGame).toEqual(['a']);
    expect(r.host.playSet()).toEqual(['b']);
    expect(r.rejects).toEqual([]);
  });

  it('a fifth person is told the lobby is full, in every phase; nobody is told the match has started', async () => {
    const r = await lobby(['a', 'b', 'c']);
    const codes: string[] = [];
    r.host.on('refused', (x) => codes.push(`${x.refuse.code}: ${x.refuse.message}`));
    const fifth = r.join('e');
    await flush();
    expect(fifth.refused?.code).toBe('match_full');
    expect(codes).toEqual(['match_full: This lobby is full (four people).']);
    r.host.start();
    await flush();
    const sixth = r.join('f');
    await flush();
    expect(sixth.refused?.code).toBe('match_full');
    // A lobby of two takes a third while a match is being played.
    const small = await lobby(['a']);
    small.host.start();
    await flush();
    const late = small.join('late');
    await flush();
    expect(late.refused).toBeNull();
    expect(late.isJoined).toBe(true);
    expect(small.host.members().map((p) => p.playerId)).toEqual(['h', 'a', 'late']);
  });

  it('a lobby does not change hands: transferHost refuses, a proposal is dropped, a client never proposes itself', async () => {
    const r = await lobby(['a', 'b']);
    r.host.start();
    await flush();
    expect(() => r.host.transferHost('a')).toThrow(/does not change hands/);
    const proposed: unknown[] = [];
    r.clients['b']?.on('transferProposed', (p) => proposed.push(p));
    const head = r.host.log.head();
    // A proposal as a 0.2.50 host would send one: a lobby's client leaves it alone.
    r.host.session.transport.send(
      'b',
      r.host.session.build('HOST_TRANSFER', { proposer: 'h', newHost: 'a', reason: 'host_requested', logHash: head.hash, logLength: head.length, currentGrant: null, newHostPublicKey: (r.keys['a'] as KeyPair).publicKeyB64 }, 'JHDFEF-1'),
    );
    await flush();
    expect(proposed).toEqual([]);
    expect(r.dropped['b']?.map((d) => `${d.type}:${d.reason}`)).toEqual(['HOST_TRANSFER:unexpected']);
    expect(r.clients['b']?.log.head()).toEqual(head);
    // The lobby's PC is gone: its clients say so and wait; none makes itself the host.
    const lost: string[] = [];
    r.clients['a']?.on('hostLost', (p) => lost.push(p));
    r.clients['a']?.on('transferProposed', (p) => proposed.push(p));
    r.bus.disconnect('h');
    await flush();
    expect(lost).toEqual(['h']);
    expect(proposed).toEqual([]);
  });

});

describe('A17 step 5: matches in sequence, players by choice, watchers', () => {
  it('one evening: two play and two watch (the lobby`s PC among the watchers), then the watchers play a new match', async () => {
    const r = await lobby(['a', 'b', 'c'], { balls: 2, stances: { h: 'watch', c: 'watch' } });
    const ended: PayloadOf<'MATCH_END'>[] = [];
    r.clients['c']?.on('matchEnded', (x) => ended.push(x));
    const hostSeqs: number[] = [];
    r.clients['a']?.session.transport.onMessage((_from, m) => void (m.from === 'h' && hostSeqs.push(m.seq)));

    // Match 1: the people set to Play, and the lobby's PC is not one of them.
    r.host.start();
    await flush();
    expect(r.host.state.matchId).toBe('JHDFEF-1');
    expect(r.host.state.playerOrder).toEqual(['a', 'b']);
    expect(r.host.state.participants.map((p) => p.playerId)).toEqual(['a', 'b']);
    expect(r.host.state.hostId).toBe('h');
    expect(r.host.openMatch()).toEqual({ matchId: 'JHDFEF-1', players: ['a', 'b'], game: 1, state: 'game' });
    expect(r.clients['c']?.lobby()?.match).toEqual({ matchId: 'JHDFEF-1', players: ['a', 'b'], game: 1, state: 'game' });
    // The lobby's own table reports nothing into a game it is not in.
    r.host.localState({ ballNumber: 1, score: 5, ballInPlay: true, tilt: false });
    r.host.localBallEnd(999, 'nvram');
    r.host.localGameOver(999, 1);
    await flush();
    expect(r.rejects).toEqual([]);
    expect(r.bus.trace.filter((f) => f.type === 'STATE')).toEqual([]);
    await playGame(r);
    expect(r.clients['a']?.lobby()?.match?.state).toBe('between');

    // Everyone holds the same log: the two players, the watcher, the lobby's PC that only arbitrated.
    const head1 = r.host.log.head();
    for (const id of ['a', 'b', 'c']) expect(r.clients[id]?.log.head(), id).toEqual(head1);
    expectOwnLog(r.host.log, 'JHDFEF-1');
    expect(r.host.log.entries().every((e) => e.from !== 'c' && (e.kind === 'msg' ? true : e.from === 'h'))).toBe(true);
    // The RESULT: the players and nobody else; signed by them and by the lobby's PC; the watcher verifies it too.
    for (const id of ['a', 'b', 'c']) {
      const res = r.results[id]?.[0];
      expect(res?.logMatches, id).toBe(true);
      expect(res?.signatureValid, id).toBe(true);
      expect(res?.result.entries.map((e) => e.playerId)).toEqual(['a', 'b']);
      expect(res?.result.signatures.map((s) => s.playerId).sort()).toEqual(['a', 'b']);
      expect(res?.result.matchId).toBe('JHDFEF-1');
    }
    const res1 = r.results['c']?.[0]?.result as PayloadOf<'RESULT'>;
    expect(verifyCanonical(logSignBody('JHDFEF-1', res1.logHash, res1.logLength), res1.hostSignature, r.hostKeys.publicKeyB64)).toBe(true);
    for (const s of res1.signatures) expect(verifyCanonical(logSignBody('JHDFEF-1', s.logHash, s.logLength), s.signature, (r.keys[s.playerId] as KeyPair).publicKeyB64)).toBe(true);
    expect(r.clients['c']?.snapshot().signed).toBe(false);

    // The four swap: the two who watched play a new match. Starting it ends the open one for everyone.
    r.clients['a']?.setStance('watch');
    r.clients['b']?.setStance('watch');
    r.clients['c']?.setStance('play');
    r.host.updateLocal({ stance: 'play' });
    await flush();
    expect(r.host.playSet()).toEqual(['h', 'c']);
    // The next game of the open match is for its own players, and neither wants one.
    expect(r.host.nextGameBlocker()).toMatch(/fewer than two players of this match/);
    expect(r.host.nextGame()).toBe(false);
    const seqBefore = Math.max(...hostSeqs);
    expect(r.host.startMatch()).toBe(true);
    await flush();
    expect(ended).toEqual([{ games: 1, reason: 'a new match was started' }]);
    expect(r.host.state.matchId).toBe('JHDFEF-2');
    expect(r.host.state.playerOrder).toEqual(['h', 'c']);
    // Match 1's log was put away as it stood, on every PC; match 2's starts from nothing.
    expect(r.host.previousMatch()?.matchId).toBe('JHDFEF-1');
    expect(r.host.previousMatch()?.log.head()).toEqual(head1);
    for (const id of ['a', 'b', 'c']) expect(r.clients[id]?.previousMatch()?.log.head(), id).toEqual(head1);
    await playGame(r, 500);
    const head2 = r.host.log.head();
    expectOwnLog(r.host.log, 'JHDFEF-2');
    for (const id of ['a', 'b', 'c']) {
      expect(r.clients[id]?.log.head(), id).toEqual(head2);
      expectOwnLog((r.clients[id] as ClientMatch).log, 'JHDFEF-2');
      const res = r.results[id]?.[1];
      expect([res?.logMatches, res?.signatureValid, res?.result.matchId, res?.result.game]).toEqual([true, true, 'JHDFEF-2', 1]);
      expect(res?.result.entries.map((e) => e.playerId)).toEqual(['h', 'c']);
      // The lobby's PC signs as the host; the one client who played signs the log.
      expect(res?.result.signatures.map((s) => s.playerId)).toEqual(['c']);
    }
    // A tally is one match's: match 2's RESULT knows nothing of match 1.
    expect(r.results['a']?.[1]?.result.series.map((s) => [s.playerId, s.games])).toEqual([
      ['h', 1],
      ['c', 1],
    ]);
    // The envelope's seq is the connection's, and never started over.
    expect(hostSeqs.every((s, i) => i === 0 || s > (hostSeqs[i - 1] as number))).toBe(true);
    expect(Math.max(...hostSeqs)).toBeGreaterThan(seqBefore);

    // End match: back to the lobby, everyone still there, and a third match can follow.
    expect(r.host.endMatch('enough for tonight')).toBe(true);
    await flush();
    expect(ended[1]).toEqual({ games: 1, reason: 'enough for tonight' });
    expect(r.host.state.phase).toBe('lobby');
    expect(r.host.openMatch()).toBeNull();
    expect(r.host.matchEnded).toBe(false);
    expect(r.host.members().map((p) => p.playerId)).toEqual(['h', 'a', 'b', 'c']);
    for (const id of ['a', 'b', 'c']) {
      expect(r.clients[id]?.state.phase, id).toBe('lobby');
      expect(r.clients[id]?.matchEnded, id).toBe(false);
      expect(r.clients[id]?.lobby()?.match, id).toBeNull();
      expect(r.clients[id]?.log.length, id).toBe(0);
    }
    r.host.start();
    await flush();
    expect(r.host.state.matchId).toBe('JHDFEF-3');
    expect(r.rejects).toEqual([]);
    for (const id of ['a', 'b', 'c']) expect(r.dropped[id], id).toEqual([]);
  });

  it('a watcher reports nothing, and nothing is taken from one: every report of theirs is rejected and the log does not move', async () => {
    const r = await lobby(['a', 'b'], { stances: { b: 'watch' } });
    r.host.start();
    await flush();
    const b = r.clients['b'] as ClientMatch;
    const before = r.host.log.head();
    const sentBefore = r.bus.trace.filter((f) => f.from === 'b').length;
    // Through the engine: a watcher's own table has nothing to say.
    b.reportState({ ballNumber: 1, score: 7, ballInPlay: true, tilt: false });
    b.reportDmd({ kind: 'text', lines: ['x'] });
    b.reportGameOver(7, 1);
    b.forfeit('closed the table');
    b.pause();
    b.resume();
    expect(() => b.reportBallEnd(7, 'script')).toThrow(/no grant held/);
    await flush();
    expect(r.bus.trace.filter((f) => f.from === 'b').length).toBe(sentBefore);
    // Past the engine (another build, a bug): the lobby's PC takes none of it.
    const s = b.session;
    const mid = 'JHDFEF-1';
    const grantSeq = r.host.state.lastGrantSeq;
    const frames: AnyMessage[] = [
      s.build('BALL_END', { grantSeq, ballNumber: 1, finalScore: 1, detectorReason: 'manual', shootAgain: false }, mid),
      s.build('GAME_OVER', { finalScore: 1, ballsPlayed: 1 }, mid),
      s.build('FORFEIT', { player: 'b', reason: 'x' }, mid),
      s.build('PAUSE', { reason: 'requested', player: 'b' }, mid),
      s.build('RESUME', {}, mid),
      s.build('LOG_SIGN', { logHash: before.hash, logLength: before.length, signature: signCanonical(logSignBody(mid, before.hash, before.length), (r.keys['b'] as KeyPair).privateKey) }, mid),
      s.build('STATE', { ballNumber: 1, score: 9, ballInPlay: true, tilt: false }, mid),
    ];
    for (const f of frames) s.transport.send('h', f);
    await flush();
    expect(r.rejects.map((x) => `${x.refType}:${x.code}:${x.message}`)).toEqual(['BALL_END', 'GAME_OVER', 'FORFEIT', 'PAUSE', 'RESUME', 'LOG_SIGN'].map((t) => `${t}:unexpected_state:b is not a player of this game`));
    expect(r.host.log.head()).toEqual(before);
    expect(r.host.state.paused).toBeNull();
    expect(r.bus.trace.filter((f) => f.type === 'STATE' && f.from === 'h')).toEqual([]);
    // The match goes on as if nothing had been said, and the watcher gets every bit of it.
    const states: number[] = [];
    b.on('state', (m) => states.push(m.payload.score));
    r.host.localState({ ballNumber: 1, score: 40, ballInPlay: true, tilt: false });
    await flush();
    expect(states).toEqual([40]);
    await playGame(r);
    expect(b.log.head()).toEqual(r.host.log.head());
    expect(r.results['b']?.[0]?.logMatches).toBe(true);
    expect(r.results['b']?.[0]?.result.signatures.map((x) => x.playerId)).toEqual(['a']);
    expect(b.inputUnlocked).toBe(false);
    expect(b.myGrant).toBeNull();
  });

  it('the next game is for the open match`s players; anyone else takes a new match (rule 2.5)', async () => {
    const r = await lobby(['a'], { balls: 1 });
    r.host.start();
    await flush();
    // c joins set to Play while the series runs: a watcher until somebody starts a new match.
    const c = r.join('c');
    await playGame(r);
    expect(c.log.head()).toEqual(r.host.log.head());
    expect(r.host.playSet()).toEqual(['h', 'a', 'c']);
    // A start with the match open is its next game, with its own players: c is not pulled in.
    expect(r.host.nextGameBlocker(['h', 'c'])).toBe('c is not a player of this match: that takes a new match');
    expect(r.host.nextGame(['h', 'c'])).toBe(false);
    expect(r.host.start.bind(r.host)).toThrow(/already started/);
    expect(r.host.nextGame()).toBe(true);
    await flush();
    expect(r.host.state.gameNumber).toBe(2);
    expect(r.host.state.playerOrder).toEqual(['h', 'a']);
    expect(c.lobby()?.match).toEqual({ matchId: 'JHDFEF-1', players: ['h', 'a'], game: 2, state: 'game' });
    // Not in the middle of a game.
    expect(r.host.startMatchBlocker()).toBe('a game is being played');
    expect(r.host.startMatch()).toBe(false);
    await playGame(r, 300);
    // A player who switched to Watch sits the next game out; with one left there is none.
    r.clients['a']?.setStance('watch');
    await flush();
    expect(r.host.nextGameBlocker()).toMatch(/fewer than two players of this match/);
    // The asker names the order when it wants one: a subset of the match's players, the first to go first.
    r.clients['a']?.setStance('play');
    await flush();
    expect(r.host.nextGame(['a', 'h'])).toBe(true);
    await flush();
    expect(r.host.state.playerOrder).toEqual(['a', 'h']);
    expect(r.host.state.currentGrant?.grant.player).toBe('a');
    await playGame(r, 600);
    // The explicit new match: the tally of the open one is final (three games), and c is in.
    const ended: PayloadOf<'MATCH_END'>[] = [];
    c.on('matchEnded', (x) => ended.push(x));
    expect(r.host.startMatchBlocker(['h', 'a', 'c', 'x'])).toBe('x is not in the lobby');
    expect(r.host.startMatchBlocker(['c'])).toBe('a match needs two people set to Play');
    expect(r.host.startMatch(['c', 'h', 'a'])).toBe(true);
    await flush();
    expect(ended).toEqual([{ games: 3, reason: 'a new match was started' }]);
    expect(r.host.state.matchId).toBe('JHDFEF-2');
    expect(r.host.state.playerOrder).toEqual(['c', 'h', 'a']);
    expect(r.host.state.currentGrant?.grant).toMatchObject({ player: 'c', grantSeq: 1, matchId: 'JHDFEF-2', game: 1 });
    expect(c.myGrant?.grantSeq).toBe(1);
    expect(c.inputUnlocked).toBe(true);
    expect(r.rejects).toEqual([]);
  });

  it('what is counted per match starts over on a client: grant 1 of the next match is taken, an old grant is not', async () => {
    const r = await lobby(['a']);
    const a = r.clients['a'] as ClientMatch;
    const grants: AnyMessage[] = [];
    a.session.transport.onMessage((_f, m) => void (m.type === 'TURN_GRANT' && grants.push(m)));
    r.host.start();
    await flush();
    await playGame(r);
    expect(a.snapshot().signed).toBe(true);
    r.host.endMatch();
    await flush();
    expect(a.snapshot().signed).toBe(false);
    r.host.start();
    await flush();
    await flush();
    // Match 2: grant 1 again, for the lobby's PC; then grant 2 for a.
    r.host.localBallEnd(10, 'nvram');
    await flush();
    expect(a.myGrant).toMatchObject({ matchId: 'JHDFEF-2', grantSeq: 2 });
    // A grant of match 1 sent again (grantSeq 2, for a, with the host's good signature): refused twice over. In its
    // own envelope it is a frame of a match that is not the open one; in an envelope of the open match its signed
    // body still names the old one.
    const old = grants.find((g) => g.type === 'TURN_GRANT' && g.payload.grant.matchId === 'JHDFEF-1' && g.payload.grant.player === 'a');
    if (!old || old.type !== 'TURN_GRANT') throw new Error('no grant of match 1 for a');
    const again = r.host.session.build('TURN_GRANT', old.payload, 'JHDFEF-1');
    const disguised = r.host.session.build('TURN_GRANT', old.payload, 'JHDFEF-2');
    const head = a.log.head();
    r.host.session.transport.send('a', again);
    r.host.session.transport.send('a', disguised);
    await flush();
    expect(r.dropped['a']?.map((d) => `${d.type}:${d.reason}`)).toEqual(['TURN_GRANT:no_log', 'TURN_GRANT:stale_grant']);
    expect(a.log.head()).toEqual(head);
    expect(a.myGrant).toMatchObject({ matchId: 'JHDFEF-2', grantSeq: 2 });
    a.reportBallEnd(20, 'script');
    await flush();
    await flush();
    expect(r.results['a']?.map((x) => [x.result.matchId, x.logMatches, x.signatureValid])).toEqual([
      ['JHDFEF-1', true, true],
      ['JHDFEF-2', true, true],
    ]);
    // A frame of the match that is over reaches the lobby's PC late: it is told so, and nothing moves.
    r.host.endMatch();
    await flush();
    a.session.transport.send('h', a.session.build('GAME_OVER', { finalScore: 1, ballsPlayed: 1 }, 'JHDFEF-2'));
    await flush();
    expect(r.rejects.map((x) => `${x.refType}:${x.message}`)).toEqual(['GAME_OVER:no match is open']);
    expect(r.host.log.length).toBe(0);
  });

  it('Close lobby: a match between games is ended, every member is told, and the lobby takes nobody after it', async () => {
    const r = await lobby(['a', 'b'], { stances: { b: 'watch' } });
    const seen: string[] = [];
    for (const id of ['a', 'b']) {
      r.clients[id]?.on('matchEnded', (x) => seen.push(`${id} MATCH_END ${x.games}`));
      r.clients[id]?.on('lobbyClosed', (x) => seen.push(`${id} LOBBY_CLOSED ${x.reason}`));
    }
    r.host.start();
    await flush();
    await playGame(r);
    expect(r.host.closeLobby('good night')).toBe(true);
    expect(r.host.closeLobby('again')).toBe(false);
    await flush();
    expect(seen.sort()).toEqual(['a LOBBY_CLOSED good night', 'a MATCH_END 1', 'b LOBBY_CLOSED good night', 'b MATCH_END 1']);
    expect(r.clients['a']?.matchEnded).toBe(true);
    expect(r.host.matchEnded).toBe(true);
    expect(r.host.startMatchBlocker()).toBe('the lobby is closed');
    const late = r.join('late');
    await flush();
    expect(late.refused).toMatchObject({ code: 'other', message: 'this lobby is closed' });
  });
});

describe('A17 step 5: the log for a member who does not hold it', () => {
  it('a member who joins while a match is open is sent HELLO_ACK and then the whole log, unasked, in pages', async () => {
    const r = await lobby(['a'], { balls: 3, lobby: { logPageSize: 4 } });
    r.host.start();
    await flush();
    r.host.localBallEnd(10, 'nvram');
    await flush();
    r.clients['a']?.reportBallEnd(20, 'script');
    await flush();
    r.host.localBallEnd(30, 'nvram');
    await flush();
    // MATCH_READY, three grants and three ball ends, and the fourth grant: 8 entries, two pages of 4.
    expect(r.host.log.length).toBe(8);
    const caught: { playerId: PlayerId; entries: number; pages: number; during: number }[] = [];
    r.host.on('caughtUp', (x) => caught.push(x));
    const at = r.bus.trace.length;
    const c = r.join('c');
    const events: string[] = [];
    c.on('joined', (ack) => events.push(`joined match=${ack.match?.matchId} holds=${c.holdsOpenLog}`));
    c.on('ready', (p) => events.push(`ready ${p.matchId}`));
    c.on('caughtUp', (x) => events.push(`caughtUp ${x.match} ${x.entries}`));
    await flush();
    expect(r.bus.trace.slice(at).filter((f) => f.to === 'c').map((f) => f.type)).toEqual(['HELLO_ACK', 'MATCH_LOG', 'MATCH_LOG']);
    expect(events).toEqual(['joined match=JHDFEF-1 holds=false', 'ready JHDFEF-1', 'caughtUp JHDFEF-1 8']);
    expect(caught).toEqual([{ playerId: 'c', entries: 8, pages: 2, during: 0 }]);
    expect(c.holdsOpenLog).toBe(true);
    expect(c.log.head()).toEqual(r.host.log.head());
    expect(c.log.verifyChain()).toEqual({ ok: true });
    expect(c.state.currentGrant?.grant.player).toBe('a');
    expect(c.inputUnlocked).toBe(false);
    // From here the newcomer is on the live stream, and ends where everyone ends.
    await playGame(r);
    expect(c.log.head()).toEqual(r.host.log.head());
    expect(r.results['c']?.map((x) => [x.logMatches, x.signatureValid])).toEqual([[true, true]]);
    expect(r.results['c']?.[0]?.result.signatures.map((s) => s.playerId)).toEqual(['a']);
    expect(r.dropped['c']).toEqual([]);

    // Between games: the log, then the RESULT that is out (it is in no log).
    const d = r.join('d');
    await flush();
    expect(d.log.head()).toEqual(r.host.log.head());
    expect(r.results['d']?.map((x) => [x.result.game, x.logMatches, x.signatureValid])).toEqual([[1, true, true]]);
    // With no match open there is nothing to send.
    r.host.endMatch();
    await flush();
    const before = r.bus.trace.length;
    const s2 = await lobby([]);
    const e = s2.join('e');
    await flush();
    expect(e.holdsOpenLog).toBe(true);
    expect(s2.bus.trace.filter((f) => f.type === 'MATCH_LOG')).toEqual([]);
    expect(r.bus.trace.slice(before).filter((f) => f.type === 'MATCH_LOG')).toEqual([]);
  });

  it('a BALL_END that lands between the HELLO_ACK and the last page: held back from the newcomer, and in a later page', async () => {
    const r = await lobby(['a'], { balls: 3, lobby: { logPageSize: 2, logPageGapMs: 100 } });
    r.host.start();
    await flush();
    r.host.localBallEnd(10, 'nvram');
    await flush();
    r.clients['a']?.reportBallEnd(20, 'script');
    await flush();
    // 6 entries: three pages of 2, 100 ms apart.
    expect(r.host.log.length).toBe(6);
    const caught: { playerId: PlayerId; entries: number; pages: number; during: number }[] = [];
    r.host.on('caughtUp', (x) => caught.push(x));
    const c = r.join('c');
    const toC = (): string[] => r.bus.trace.filter((f) => f.to === 'c').map((f) => f.type);
    await flush();
    expect(toC()).toEqual(['HELLO_ACK', 'MATCH_LOG']);
    expect(c.holdsOpenLog).toBe(false);
    expect(c.log.length).toBe(2);
    // The lobby's PC ends its ball now: the BALL_END and the next grant go to a at once, and not to c.
    r.host.localBallEnd(30, 'nvram');
    r.host.localState({ ballNumber: 2, score: 31, ballInPlay: false, tilt: false });
    await flush();
    expect(r.host.log.length).toBe(8);
    expect(r.clients['a']?.log.length).toBe(8);
    // (What is not logged does reach a member who is catching up: the scores move for them too.)
    expect(toC()).toEqual(['HELLO_ACK', 'MATCH_LOG', 'STATE']);
    expect(c.log.length).toBe(2);
    r.clock.advance(100);
    await flush();
    r.clients['a']?.reportBallEnd(40, 'script');
    await flush();
    r.clock.advance(100);
    await flush();
    r.clock.advance(100);
    await flush();
    r.clock.advance(100);
    await flush();
    expect(c.holdsOpenLog).toBe(true);
    expect(caught).toEqual([{ playerId: 'c', entries: 10, pages: 5, during: 4 }]);
    expect(toC().filter((t) => t !== 'MATCH_LOG')).toEqual(['HELLO_ACK', 'STATE']);
    expect(c.log.head()).toEqual(r.host.log.head());
    expect(c.log.verifyChain()).toEqual({ ok: true });
    // And the stream is live for them from the entry after the last page.
    r.host.localBallEnd(50, 'nvram');
    await flush();
    expect(toC().slice(-2)).toEqual(['BALL_END', 'TURN_GRANT']);
    expect(c.log.head()).toEqual(r.host.log.head());
    expect(r.dropped['c']).toEqual([]);
  });

  it('a client takes a logged message only into a log it holds in full: one that arrives early is dropped, not entry 0', async () => {
    const r = await lobby(['a'], { balls: 3, lobby: { logPageSize: 2, logPageGapMs: 100 } });
    r.host.start();
    await flush();
    r.host.localBallEnd(10, 'nvram');
    await flush();
    const c = r.join('c');
    const desync: unknown[] = [];
    c.on('desync', (x) => desync.push(x));
    await flush();
    expect(c.holdsOpenLog).toBe(false);
    // What a host that did not hold the stream back would have sent: the next BALL_END, live, in the middle of the pages.
    const early = buildMessage('BALL_END', { grantSeq: 2, ballNumber: 1, finalScore: 20, detectorReason: 'script', shootAgain: false }, { matchId: 'JHDFEF-1', seq: 9_000, from: 'a', ts: r.clock.now() });
    r.host.session.transport.send('c', early);
    await flush();
    expect(r.dropped['c']?.map((d) => `${d.type}:${d.reason}`)).toEqual(['BALL_END:no_log']);
    expect(c.log.length).toBe(2);
    r.clock.advance(100);
    await flush();
    expect(c.holdsOpenLog).toBe(true);
    expect(c.log.head()).toEqual(r.host.log.head());
    expect(desync).toEqual([]);
    // A page that does not chain onto the log is refused whole, and the client says so.
    const bad = r.host.session.build('MATCH_LOG', { match: 'JHDFEF-1', restart: true, entries: [{ ...(r.host.log.at(1) as object) } as never], logHash: r.host.log.head().hash, logLength: 1, more: false }, 'JHDFEF');
    r.host.session.transport.send('c', bad);
    await flush();
    expect(desync).toHaveLength(1);
    expect(c.holdsOpenLog).toBe(false);
    expect(c.log.length).toBe(0);
  });

  it('a RECONNECT_ACK of more than one page says `more` and the rest follows in MATCH_LOG: one head, one `reconnected`', async () => {
    const frames: RecordedFrame[] = [];
    const bus = new MemoryBus();
    const taps = new Map<PlayerId, TapTransport>();
    const clock = new ManualClock();
    const tap = (id: PlayerId): TapTransport => new TapTransport(bus.transport(id), bus, taps, frames);
    const hKeys = fixedKeys(1);
    const aKeys = fixedKeys(2);
    const bKeys = fixedKeys(3);
    const host = new HostMatch({ transport: tap('h'), keys: hKeys, matchId: 'JHDFEF', ballsPerGame: 5, hostParticipant: who('h', hKeys), hostGame: game, clock, lobby: { logPageSize: 2 } });
    const mk = (id: string, keys: KeyPair, t: Transport): ClientMatch => new ClientMatch({ transport: t, keys, participant: who(id, keys), game, throwdownCode: 'JHDFEF', hostId: 'h', clock, lobby: true, reconnect: { delayMs: 1000, attempts: 5 } });
    const a = mk('a', aKeys, tap('a'));
    const b = mk('b', bKeys, tap('b'));
    a.join();
    b.join();
    await flush();
    host.start();
    await flush();
    // b's link drops while the lobby's PC is up; the match goes on for a round and a half without b's turn coming.
    const back: { entries: number; quiet: boolean }[] = [];
    b.on('reconnected', (x) => back.push({ entries: x.entries, quiet: x.quiet }));
    const dropped: DroppedInfo[] = [];
    b.on('dropped', (d) => dropped.push(d));
    (taps.get('b') as TapTransport).unreachable = true;
    (taps.get('b') as TapTransport).cut('h');
    await flush();
    const held = b.log.length;
    host.localBallEnd(10, 'nvram');
    await flush();
    a.reportBallEnd(20, 'script');
    await flush();
    // The grant is b's now, and b is inside the grace: nothing is paused, nothing is granted.
    clock.advance(1000);
    await flush();
    const missing = host.log.length - held;
    expect(missing).toBe(3);
    (taps.get('b') as TapTransport).unreachable = false;
    const from = frames.length;
    clock.advance(1000);
    await flush();
    const sent = frames.slice(from).filter((f) => f.by === 'h' && f.to === 'b').map((f) => JSON.parse(f.frame) as AnyMessage);
    const ack = sent[0];
    if (ack?.type !== 'RECONNECT_ACK') throw new Error('no RECONNECT_ACK');
    expect(ack.payload.accept).toBe(true);
    expect(ack.payload.more).toBe(true);
    expect(ack.payload.entries).toHaveLength(2);
    const pages = sent.filter((m) => m.type === 'MATCH_LOG');
    expect(pages.length).toBeGreaterThanOrEqual(1);
    expect(pages.every((m) => m.type === 'MATCH_LOG' && !m.payload.restart && m.payload.match === 'JHDFEF-1' && m.payload.entries.length <= 2)).toBe(true);
    expect(pages.map((m) => (m.type === 'MATCH_LOG' ? m.payload.more : null)).slice(-1)).toEqual([false]);
    expect(b.holdsOpenLog).toBe(true);
    expect(b.log.head()).toEqual(host.log.head());
    expect(b.log.verifyChain()).toEqual({ ok: true });
    expect(back).toHaveLength(1);
    // What the answer and its pages brought; the grant that had waited for b came live, right after the last page.
    expect(back[0]?.entries).toBe(missing);
    expect(b.log.length - held).toBe(missing + 1);
    expect(sent.map((m) => m.type).slice(-1)).toEqual(['TURN_GRANT']);
    expect(dropped).toEqual([]);
    // b is up and plays: the grant that waited for it came with the log or right after it.
    expect(b.myGrant?.player).toBe('b');
    b.reportBallEnd(30, 'script');
    await flush();
    expect(host.state.players['b']?.ballsPlayed).toBe(1);
    expect(a.log.head()).toEqual(host.log.head());
    expect(b.log.head()).toEqual(host.log.head());
  });
});

describe('A17 step 5: a member`s facts while a match is played', () => {
  it('PARTICIPANT_UPDATE counts in every phase: HELLO_ACK says it to everyone, and the match`s logged roster stays what it was', async () => {
    const r = await lobby(['a', 'b'], { stances: { b: 'watch' } });
    r.host.start();
    await flush();
    const head = r.host.log.head();
    const rigs: string[] = [];
    const modes: string[] = [];
    r.clients['a']?.on('rigUpdated', (x) => rigs.push(`a hears ${x.playerId} ${x.rig}`));
    r.clients['a']?.on('midnightMode', (x) => modes.push(`a hears ${x.playerId} ${x.mode.enabled}`));
    r.host.on('rigUpdated', (x) => rigs.push(`h hears ${x.playerId} ${x.rig}`));
    const acks = r.bus.trace.filter((f) => f.type === 'HELLO_ACK').length;
    // The watcher's headset came up, the lobby's PC read its table's setting, a player's table can report ball ends.
    r.clients['b']?.updateParticipant({ rig: 'vr_headset' });
    await flush();
    r.host.localMidnightMode({ enabled: true, adjustment: 'A.2 14 Special Mode' });
    r.host.updateLocal({ rig: 'vr_headset' });
    r.clients['a']?.updateParticipant({ ballEndReady: true, ownGame: false });
    await flush();
    const seen = r.clients['a']?.lobby();
    expect(seen?.participants.map((p) => [p.playerId, p.rig])).toEqual([
      ['h', 'vr_headset'],
      ['a', 'pc'],
      ['b', 'vr_headset'],
    ]);
    expect(seen?.midnightModes).toEqual([{ playerId: 'h', enabled: true, adjustment: 'A.2 14 Special Mode' }]);
    expect(seen?.ballEndReady).toEqual([{ playerId: 'a', ready: true }]);
    expect(seen?.match?.state).toBe('game');
    expect(rigs.sort()).toEqual(['a hears b vr_headset', 'a hears h vr_headset', 'h hears b vr_headset', 'h hears h vr_headset']);
    expect(modes).toEqual(['a hears h true']);
    // Each change went out as a HELLO_ACK to both members; no PARTICIPANT_UPDATE was passed on.
    expect(r.bus.trace.filter((f) => f.type === 'HELLO_ACK').length - acks).toBe(8);
    expect(r.bus.trace.filter((f) => f.type === 'PARTICIPANT_UPDATE' && f.from === 'h')).toEqual([]);
    // The match itself: the same log, the roster of its MATCH_READY.
    expect(r.host.log.head()).toEqual(head);
    expect(r.host.roster().map((p) => [p.playerId, p.rig])).toEqual([
      ['h', 'pc'],
      ['a', 'pc'],
    ]);
    // A player's flag about one of its own balls is still passed on as it came; a watcher has no ball to flag.
    const flags: string[] = [];
    r.clients['b']?.on('advisory', (x) => flags.push(`b hears ${x.playerId}`));
    expect(r.clients['a']?.reportAdvisory({ kind: 'midnight', game: 1, ballNumber: 1 })).toBe(true);
    await flush();
    expect(flags).toEqual(['b hears a']);
    expect(r.rejects).toEqual([]);
  });

  it('after LOBBY_CLOSED the lobby reads nothing more: a late report moves nothing and no timer acts', async () => {
    const r = await lobby(['a'], { grace: 5000 });
    r.host.start();
    await flush();
    // Closed in the middle of a game: that game is ended for everyone first (step 6: MATCH_END with `abandoned`).
    const head = r.host.log.head();
    const ends: PayloadOf<'MATCH_END'>[] = [];
    r.clients['a']?.on('matchEnded', (x) => ends.push(x));
    expect(r.host.closeLobby('the PC is shutting down')).toBe(true);
    await flush();
    expect(ends).toEqual([{ games: 0, reason: 'the lobby was closed', abandoned: 1 }]);
    expect(r.clients['a']?.matchEnded).toBe(true);
    const sent = r.bus.trace.filter((f) => f.from === 'h').length;
    (r.clients['a'] as ClientMatch).session.transport.send('h', (r.clients['a'] as ClientMatch).session.build('GAME_OVER', { finalScore: 1, ballsPlayed: 1 }, 'JHDFEF-1'));
    r.bus.disconnect('a');
    await flush();
    r.clock.advance(30 * 60 * 1000);
    await flush();
    expect(r.host.previousMatch()?.log.head()).toEqual(head);
    expect(r.host.log.length).toBe(0);
    expect(r.host.members().map((m) => m.playerId)).toEqual(['h', 'a']);
    expect(r.bus.trace.filter((f) => f.from === 'h').length).toBe(sent);
    expect(r.rejects).toEqual([]);
  });
});
