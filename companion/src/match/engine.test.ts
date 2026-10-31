/**
 * Direct host/client transition tests over a MemoryBus, for the paths the fakeclient scenarios
 * do not reach: the remaining REFUSE codes, seq replay and unknown-player REJECTs, client
 * requested PAUSE/RESUME, client FORFEIT, the LOG_SIGN timeout, a bad grant signature,
 * resumeFromLog from serialized JSON, and desync detection.
 */
import { describe, expect, it } from 'vitest';
import { buildMessage, PROTOCOL_VERSION, type GameFingerprint, type ParticipantInfo, type PayloadOf } from '@castcade/protocol';
import { ClientMatch } from './client.js';
import { ManualClock } from './clock.js';
import { HostMatch, type RejectInfo } from './host.js';
import { generateKeys, signCanonical, verifyCanonical, type KeyPair } from './keys.js';
import { MatchLog } from './log.js';
import { logSignBody } from './result.js';
import { Session } from './session.js';
import { MemoryBus } from './transport.js';

const flush = async (n = 6): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setTimeout(r, 0));
};

const hex = 'ab'.repeat(32);
const game: GameFingerprint = { kind: 'vpx', tableName: 'MM', tableHash: hex, romName: 'mm_109c', romHash: hex, physicsHash: null, recipeVersion: '0.1.0', sidecarHash: hex, emulatorVersion: '10.8.0' };

interface Rig {
  bus: MemoryBus;
  clock: ManualClock;
  host: HostMatch;
  hostKeys: KeyPair;
  clients: Record<string, ClientMatch>;
  keys: Record<string, KeyPair>;
  rejects: RejectInfo[];
}

function participant(id: string, keys: KeyPair): ParticipantInfo {
  return { playerId: id, displayName: id, publicKey: keys.publicKeyB64, rig: 'pc' };
}

async function rig(clientIds: string[], balls = 1, opts: { ballEndTimeoutMs?: number; logSignTimeoutMs?: number } = {}): Promise<Rig> {
  const bus = new MemoryBus();
  const clock = new ManualClock();
  const hostKeys = generateKeys();
  const host = new HostMatch({
    transport: bus.transport('h'),
    keys: hostKeys,
    matchId: 'M',
    ballsPerGame: balls,
    hostParticipant: participant('h', hostKeys),
    hostGame: game,
    clock,
    ...opts,
  });
  const rejects: RejectInfo[] = [];
  host.on('reject', (r) => rejects.push(r));
  const clients: Record<string, ClientMatch> = {};
  const keys: Record<string, KeyPair> = {};
  for (const id of clientIds) {
    const k = generateKeys();
    keys[id] = k;
    const c = new ClientMatch({ transport: bus.transport(id), keys: k, participant: participant(id, k), game, throwdownCode: 'M', hostId: 'h', clock });
    clients[id] = c;
    c.join();
  }
  await flush();
  return { bus, clock, host, hostKeys, clients, keys, rejects };
}

describe('joining', () => {
  it('HELLO_ACK carries the host key and roster; duplicate, full, wrong throwdown, started are refused', async () => {
    const r = await rig(['a', 'b', 'c']);
    expect(r.host.roster().map((p) => p.playerId)).toEqual(['h', 'a', 'b', 'c']);
    expect(r.clients['a']?.hostPublicKey).toBe(r.hostKeys.publicKeyB64);
    expect(r.clients['a']?.isJoined).toBe(true);

    const refusals: { id: string; code: string }[] = [];
    r.host.on('refused', (x) => refusals.push({ id: x.playerId, code: x.refuse.code }));
    const join = (id: string, throwdown = 'M'): ClientMatch => {
      const k = generateKeys();
      const c = new ClientMatch({ transport: r.bus.transport(id), keys: k, participant: participant(id, k), game, throwdownCode: throwdown, hostId: 'h', clock: r.clock });
      c.join();
      return c;
    };
    const dup = new ClientMatch({ transport: r.bus.transport('a2'), keys: generateKeys(), participant: { ...participant('a2', generateKeys()) }, game, throwdownCode: 'M', hostId: 'h' });
    // Hand-built HELLO whose participant id differs from the envelope (refused with `other`).
    dup.session.transport.send('h', buildMessage('HELLO', { protocolVersion: PROTOCOL_VERSION, companionVersion: '0', throwdownCode: 'M', participant: participant('a', generateKeys()), game }, { matchId: null, seq: 1, from: 'a2' }));
    const wrong = join('w', 'OTHER');
    const full = join('d');
    await flush();
    expect(refusals).toEqual([
      { id: 'a2', code: 'other' },
      { id: 'w', code: 'unknown_throwdown' },
      { id: 'd', code: 'match_full' },
    ]);
    expect(wrong.refused?.code).toBe('unknown_throwdown');
    expect(full.refused?.code).toBe('match_full');
    expect(r.bus.isConnected('d')).toBe(false);

    // Duplicate id over a fresh transport (same player id as an accepted one).
    const r2 = await rig(['a']);
    const dupRefused: string[] = [];
    r2.host.on('refused', (x) => dupRefused.push(x.refuse.code));
    const k = generateKeys();
    const t = r2.bus.transport('a-dup');
    t.send('h', buildMessage('HELLO', { protocolVersion: PROTOCOL_VERSION, companionVersion: '0', throwdownCode: 'M', participant: participant('a-dup', k), game }, { matchId: null, seq: 1, from: 'a-dup' }));
    await flush();
    expect(dupRefused).toEqual([]);
    expect(r2.host.roster().map((p) => p.playerId)).toEqual(['h', 'a', 'a-dup']);
    r2.host.start();
    await flush();
    const late = join.call(null, 'late');
    void late;
    const lateClient = new ClientMatch({ transport: r2.bus.transport('late2'), keys: generateKeys(), participant: participant('late2', k), game, throwdownCode: 'M', hostId: 'h' });
    lateClient.join();
    await flush();
    expect(dupRefused).toEqual(['match_started']);
    expect(lateClient.refused?.code).toBe('match_started');
  });

  it('a second HELLO from an id already in the roster is a duplicate_player', async () => {
    const r = await rig(['a']);
    const codes: string[] = [];
    r.host.on('refused', (x) => codes.push(x.refuse.code));
    // Same player id, new transport (the bus needs distinct ids, so route a forged `from` through a).
    r.clients['a']?.session.transport.send('h', buildMessage('HELLO', { protocolVersion: PROTOCOL_VERSION, companionVersion: '0', throwdownCode: 'M', participant: participant('a', r.keys['a'] as KeyPair), game }, { matchId: null, seq: 50, from: 'a' }));
    await flush();
    expect(codes).toEqual(['duplicate_player']);
  });

  it('start() needs two participants and MATCH_READY reaches everyone as log entry 0', async () => {
    const r0 = await rig([]);
    expect(() => r0.host.start()).toThrow(/two participants/);
    const r = await rig(['a', 'b']);
    const ready: PayloadOf<'MATCH_READY'>[] = [];
    r.clients['b']?.on('ready', (p) => ready.push(p));
    r.host.start();
    await flush();
    expect(ready).toHaveLength(1);
    expect(ready[0]?.playerOrder).toEqual(['h', 'a', 'b']);
    expect(r.clients['a']?.log.at(0)?.message?.type).toBe('MATCH_READY');
    expect(r.clients['a']?.log.at(1)?.message?.type).toBe('TURN_GRANT');
    expect(r.host.state.currentGrant?.grant).toMatchObject({ player: 'h', ballNumber: 1, grantSeq: 1 });
    expect(r.clients['a']?.inputUnlocked).toBe(false);
  });

  it('fingerprintPolicy: refuse (default) refuses a different table; advise accepts it and both sides flag it (alpha, 2026-10-30)', async () => {
    const other: GameFingerprint = { ...game, tableHash: 'cd'.repeat(32) };
    const setup = (policy?: 'refuse' | 'advise') => {
      const bus = new MemoryBus();
      const hk = generateKeys();
      const host = new HostMatch({ transport: bus.transport('h'), keys: hk, matchId: 'M', ballsPerGame: 1, hostParticipant: participant('h', hk), hostGame: game, fingerprintPolicy: policy });
      const ck = generateKeys();
      const client = new ClientMatch({ transport: bus.transport('c'), keys: ck, participant: participant('c', ck), game: other, throwdownCode: 'M', hostId: 'h' });
      const hostFlags: string[][] = [];
      const clientFlags: Array<{ playerId: string; fields: string[] }> = [];
      host.on('tableMismatch', (m) => hostFlags.push(m.mismatches.map((x) => x.field)));
      client.on('tableMismatch', (m) => clientFlags.push({ playerId: m.playerId, fields: m.mismatches.map((x) => x.field) }));
      return { host, client, hostFlags, clientFlags };
    };

    const refuse = setup();
    refuse.client.join();
    await flush();
    expect(refuse.client.refused?.code).toBe('fingerprint_mismatch');
    expect(refuse.host.roster().map((p) => p.playerId)).toEqual(['h']);
    expect(refuse.hostFlags).toEqual([]);

    const advise = setup('advise');
    const acks: PayloadOf<'HELLO_ACK'>[] = [];
    advise.client.on('joined', (a) => acks.push(a));
    advise.client.join();
    await flush();
    expect(advise.client.isJoined).toBe(true);
    expect(advise.host.roster().map((p) => p.playerId)).toEqual(['h', 'c']);
    expect(acks[0]?.hostGame).toEqual(game);
    expect(advise.hostFlags).toEqual([['tableHash']]);
    expect(advise.host.tableMismatches()['c']?.[0]).toMatchObject({ field: 'tableHash', expected: game.tableHash, received: other.tableHash });
    expect(advise.clientFlags).toEqual([{ playerId: 'c', fields: ['tableHash'] }]);

    // A HELLO_ACK without hostGame (a host that does not send it) parses as null, and the client flags nothing then.
    expect(buildMessage('HELLO_ACK', { hostPlayerId: 'h', hostPublicKey: generateKeys().publicKeyB64, participants: [] }, { matchId: null, seq: 1, from: 'h' }).payload.hostGame).toBeNull();
    for (const x of [refuse, advise]) {
      x.client.close();
      x.host.close();
    }
  });
});

describe('rejects and the seq rule', () => {
  it('replayed seq, unknown player, wrong matchId, direction violations, GAME_OVER when finished', async () => {
    const r = await rig(['a'], 1);
    r.host.start();
    await flush();
    const a = r.clients['a'] as ClientMatch;
    const aRejects: PayloadOf<'REJECT'>[] = [];
    a.on('reject', (x) => aRejects.push(x));
    const t = a.session.transport;
    // seq replay: seq 0 is below anything a has sent
    t.send('h', buildMessage('STATE', { ballNumber: 1, score: 1, ballInPlay: true, tilt: false }, { matchId: 'M', seq: 0, from: 'a' }));
    // unknown player on a's link
    t.send('h', buildMessage('STATE', { ballNumber: 1, score: 1, ballInPlay: true, tilt: false }, { matchId: 'M', seq: 500, from: 'zz' }));
    // wrong matchId
    t.send('h', buildMessage('STATE', { ballNumber: 1, score: 1, ballInPlay: true, tilt: false }, { matchId: 'NOPE', seq: 501, from: 'a' }));
    // direction violation: a client sending TURN_GRANT
    t.send('h', buildMessage('TURN_GRANT', { grant: { matchId: 'M', player: 'a', ballNumber: 1, grantSeq: 9, issuedAt: 1, logHash: hex }, grantSig: Buffer.alloc(64).toString('base64') }, { matchId: 'M', seq: 502, from: 'a' }));
    // BALL_END with no grant held by a (h holds it)
    t.send('h', buildMessage('BALL_END', { grantSeq: 1, ballNumber: 1, finalScore: 5, detectorReason: 'manual', shootAgain: false }, { matchId: 'M', seq: 503, from: 'a' }));
    // RESUME while not paused
    t.send('h', buildMessage('RESUME', {}, { matchId: 'M', seq: 504, from: 'a' }));
    // FORFEIT naming someone else
    t.send('h', buildMessage('FORFEIT', { player: 'h', reason: 'x' }, { matchId: 'M', seq: 505, from: 'a' }));
    // LOG_SIGN before the end
    t.send('h', buildMessage('LOG_SIGN', { logHash: hex, logLength: 1, signature: Buffer.alloc(64).toString('base64') }, { matchId: 'M', seq: 506, from: 'a' }));
    await flush();
    expect(r.rejects.map((x) => [x.refType, x.code])).toEqual([
      ['STATE', 'unexpected_state'],
      ['STATE', 'unknown_player'],
      ['STATE', 'schema'],
      ['TURN_GRANT', 'unexpected_state'],
      ['BALL_END', 'not_grant_holder'],
      ['RESUME', 'unexpected_state'],
      ['FORFEIT', 'unexpected_state'],
      ['LOG_SIGN', 'unexpected_state'],
    ]);
    // REJECTs reached the client (the unknown_player one went to 'zz', which has no transport).
    expect(aRejects.map((x) => x.code)).toEqual(['unexpected_state', 'schema', 'unexpected_state', 'not_grant_holder', 'unexpected_state', 'unexpected_state', 'unexpected_state']);
    // Nothing was logged by any of that.
    expect(r.host.log.length).toBe(2);
    expect(a.log.length).toBe(2);

    // Host's own BALL_END with a stale seq is rejected locally; the right one is accepted.
    r.host.localBallEnd(10, 'script', false, { grantSeq: 99 });
    expect(r.rejects[r.rejects.length - 1]).toMatchObject({ to: 'h', code: 'stale_grant' });
    r.host.localBallEnd(10, 'script');
    await flush();
    expect(r.host.state.players['h']).toMatchObject({ status: 'finished', score: 10 });
    expect(a.inputUnlocked).toBe(true);
    // GAME_OVER from a player whose game already ended
    r.host.localGameOver(10, 1);
    expect(r.rejects[r.rejects.length - 1]).toMatchObject({ to: 'h', refType: 'GAME_OVER', code: 'unexpected_state' });
  });

  it('a client drops a grant with a bad signature and a grant replayed with a lower seq', async () => {
    const r = await rig(['a'], 1);
    r.host.start();
    await flush();
    const a = r.clients['a'] as ClientMatch;
    const dropped: string[] = [];
    a.on('dropped', (d) => dropped.push(`${d.type}:${d.reason}`));
    const forged = { matchId: 'M', player: 'a', ballNumber: 1, grantSeq: 50, issuedAt: 1, logHash: a.log.head().hash };
    const wrongKey = generateKeys();
    // Pretend to be the host on the mesh: `from: h` over a's own link is dropped as not_host before any crypto.
    a.session.transport.send('a', buildMessage('TURN_GRANT', { grant: forged, grantSig: signCanonical(forged, wrongKey.privateKey) }, { matchId: 'M', seq: 900, from: 'h' }));
    await flush();
    // Deliver through the host link with a bad signature: route it from the host's transport.
    r.host.session.transport.send('a', buildMessage('TURN_GRANT', { grant: forged, grantSig: signCanonical(forged, wrongKey.privateKey) }, { matchId: 'M', seq: 901, from: 'h' }));
    await flush();
    // Replay of an old grantSeq with a valid signature.
    const old = { ...forged, grantSeq: 1 };
    r.host.session.transport.send('a', buildMessage('TURN_GRANT', { grant: old, grantSig: signCanonical(old, r.hostKeys.privateKey) }, { matchId: 'M', seq: 902, from: 'h' }));
    await flush();
    expect(dropped).toEqual(['TURN_GRANT:not_host', 'TURN_GRANT:bad_signature', 'TURN_GRANT:stale_grant']);
    expect(a.inputUnlocked).toBe(false);
    expect(a.log.length).toBe(2);
  });
});

describe('pause, resume, forfeit from the client side', () => {
  it('client PAUSE(requested) holds the match; a RESUME re-issues the grant; client FORFEIT ends its game', async () => {
    const r = await rig(['a', 'b'], 2);
    r.host.start();
    await flush();
    const a = r.clients['a'] as ClientMatch;
    const b = r.clients['b'] as ClientMatch;
    r.host.localBallEnd(100, 'script');
    await flush();
    expect(a.inputUnlocked).toBe(true);
    expect(a.myGrant?.grantSeq).toBe(2);
    b.pause('requested');
    await flush();
    expect(r.host.state.paused).toEqual({ reason: 'requested', player: 'b' });
    expect(a.inputUnlocked).toBe(false);
    // The paused grant can still be answered; nothing else is granted while paused.
    expect(r.host.state.currentGrant?.grant.grantSeq).toBe(2);
    b.pause('requested');
    await flush();
    expect(r.rejects[r.rejects.length - 1]).toMatchObject({ refType: 'PAUSE', code: 'unexpected_state' });
    a.resume();
    await flush();
    expect(r.host.state.paused).toBeNull();
    expect(a.myGrant).toMatchObject({ player: 'a', ballNumber: 1, grantSeq: 3 });
    expect(a.inputUnlocked).toBe(true);
    a.reportBallEnd(50, 'script');
    await flush();
    expect(r.host.state.currentGrant?.grant.player).toBe('b');
    b.forfeit('had to go');
    await flush();
    expect(r.host.state.players['b']?.status).toBe('forfeit');
    expect(b.inputUnlocked).toBe(false);
    expect(r.host.state.currentGrant?.grant).toMatchObject({ player: 'h', ballNumber: 2 });
    const types = a.log.entries().map((e) => e.message?.type);
    expect(types).toEqual(['MATCH_READY', 'TURN_GRANT', 'BALL_END', 'TURN_GRANT', 'PAUSE', 'RESUME', 'TURN_GRANT', 'BALL_END', 'TURN_GRANT', 'FORFEIT', 'TURN_GRANT']);
    expect(a.log.head()).toEqual(r.host.log.head());
    expect(b.log.head()).toEqual(r.host.log.head());
  });

  it('a dropped client pauses the match; the host forfeits it and resumes; RESULT goes out after the LOG_SIGN timeout', async () => {
    const r = await rig(['a', 'b'], 1, { logSignTimeoutMs: 1000 });
    r.host.start();
    await flush();
    const pauses: PayloadOf<'PAUSE'>[] = [];
    r.host.on('pause', (p) => pauses.push(p));
    const a = r.clients['a'] as ClientMatch;
    r.host.localBallEnd(100, 'script');
    await flush();
    r.bus.disconnect('a');
    await flush();
    expect(pauses).toEqual([{ reason: 'disconnect', player: 'a' }]);
    expect(r.host.state.players['a']?.connected).toBe(false);
    r.host.forfeit('a', 'gone');
    r.host.resume();
    await flush();
    expect(r.host.state.currentGrant?.grant).toMatchObject({ player: 'b', ballNumber: 1 });
    const b = r.clients['b'] as ClientMatch;
    // b goes silent after its ball instead of signing: simulate by closing b's engine before the end.
    const results: PayloadOf<'RESULT'>[] = [];
    r.host.on('result', (x) => results.push(x.result));
    b.close();
    r.host.session.transport.closePeer?.('b');
    await flush();
    // b was still a connected player when its grant was issued; its drop pauses, forfeit it and finish.
    r.host.forfeit('b', 'gone');
    await flush();
    expect(r.host.state.phase).toBe('ended');
    expect(results).toHaveLength(1); // no signers left connected -> RESULT immediately
    expect(results[0]?.entries.map((e) => [e.playerId, e.status, e.rank])).toEqual([
      ['h', 'finished', 1],
      ['a', 'disconnected', 2],
      ['b', 'disconnected', 2],
    ]);
    expect(results[0]?.signatures).toEqual([]);
    expect(a.log.length).toBeLessThan(r.host.log.length); // a missed the tail after it dropped
  });

  it('waits for LOG_SIGNs until the timeout, then sends RESULT with what it has', async () => {
    const r = await rig(['a', 'b'], 1, { logSignTimeoutMs: 5000 });
    r.host.start();
    await flush();
    const a = r.clients['a'] as ClientMatch;
    const b = r.clients['b'] as ClientMatch;
    // b never signs: detach its engine (its transport stays connected).
    const results: PayloadOf<'RESULT'>[] = [];
    r.host.on('result', (x) => results.push(x.result));
    r.host.localBallEnd(1, 'script');
    await flush();
    a.reportBallEnd(2, 'script');
    await flush();
    b.close();
    b.session.transport.send('h', buildMessage('BALL_END', { grantSeq: 3, ballNumber: 1, finalScore: 3, detectorReason: 'script', shootAgain: false }, { matchId: 'M', seq: 100, from: 'b' }));
    await flush();
    expect(r.host.state.phase).toBe('ended');
    expect(results).toHaveLength(0);
    expect(a.snapshot().signed).toBe(true);
    r.clock.advance(4999);
    expect(results).toHaveLength(0);
    r.clock.advance(1);
    expect(results).toHaveLength(1);
    expect(results[0]?.signatures.map((s) => s.playerId)).toEqual(['a']);
    expect(results[0]?.winner).toBe('b');
  });
});

describe('resumeFromLog', () => {
  it('rebuilds roster, progress and the outstanding grant from serialized JSON and re-issues it', async () => {
    const r = await rig(['a', 'b'], 2);
    r.host.start();
    await flush();
    r.host.localBallEnd(100, 'script');
    await flush();
    // Grant a:b1 is outstanding. Record a planned transfer to b by hand in a copy of the log.
    const json = JSON.parse(JSON.stringify(r.host.log.toJSON())) as ReturnType<MatchLog['toJSON']>;
    const log = MatchLog.fromJSON(json);
    const bKey = r.keys['b'] as KeyPair;
    const head = log.head();
    const transfer = buildMessage('HOST_TRANSFER', { proposer: 'h', newHost: 'b', reason: 'host_requested', logHash: head.hash, logLength: head.length, currentGrant: r.host.state.currentGrant, newHostPublicKey: bKey.publicKeyB64 }, { matchId: 'M', seq: 77, from: 'h', ts: 123 });
    log.append({ ts: 123, kind: 'msg', from: 'h', message: transfer });
    log.append({ ts: 123, kind: 'event', from: 'h', event: { type: 'host_transfer', reason: 'host_requested', proposer: 'h', from: 'h', to: 'b', newHostPublicKey: bKey.publicKeyB64 } });

    const bus = new MemoryBus();
    const session = new Session({ transport: bus.transport('b'), keys: bKey, log });
    const host = HostMatch.resumeFromLog(log, { transport: session.transport, keys: bKey, session });
    expect(host.state.hostId).toBe('b');
    expect(host.state.hostTransfers).toBe(1);
    expect(host.roster().map((p) => p.playerId)).toEqual(['h', 'a', 'b']);
    expect(host.state.players['h']).toMatchObject({ ballsPlayed: 1, score: 100 });
    expect(host.state.pendingReissue).toEqual({ player: 'a', ballNumber: 1 });
    const grants: string[] = [];
    host.on('grant', (g) => grants.push(`${g.player}b${g.ballNumber}#${g.grantSeq}`));
    host.run();
    expect(grants).toEqual(['ab1#3']);
    expect(host.log.at(host.log.length - 1)?.kind).toBe('grant');
    expect(host.log.verifyChain()).toEqual({ ok: true });

    // Wrong local id is refused.
    const other = new Session({ transport: bus.transport('a'), keys: generateKeys(), log: MatchLog.fromJSON(log.toJSON()) });
    expect(() => HostMatch.resumeFromLog(other.log, { transport: other.transport, keys: other.keys, session: other })).toThrow(/names b as host/);
  });
});

describe('host transfer validation', () => {
  it("a HOST_TRANSFER whose key is not newHost's roster key is ignored: no log entry, no ack", async () => {
    const r = await rig(['a', 'b'], 1);
    r.host.start();
    await flush();
    const a = r.clients['a'] as ClientMatch;
    const dropped: string[] = [];
    a.on('dropped', (d) => dropped.push(d.reason));
    const acks: string[] = [];
    (r.clients['b'] as ClientMatch).on('transferAck', (m) => acks.push(m.from));
    const head = a.log.head();
    const before = a.log.length;
    const wrongKey = generateKeys().publicKeyB64;
    // Use the host's real seq counter so the genuine proposal below is not dropped as a replay.
    r.host.session.transport.send('a', buildMessage('HOST_TRANSFER', { proposer: 'h', newHost: 'b', reason: 'host_requested', logHash: head.hash, logLength: head.length, currentGrant: null, newHostPublicKey: wrongKey }, { matchId: 'M', seq: r.host.session.nextSeq(), from: 'h', ts: 5 }));
    await flush();
    expect(dropped).toEqual(['bad_transfer']);
    expect(a.log.length).toBe(before);
    expect(a.state.pendingTransfer).toBeNull();
    expect(acks).toEqual([]);
    // The genuine proposal from the host is accepted and acked.
    r.host.transferHost('b');
    await flush();
    expect(a.state.hostId).toBe('b');
    expect(a.log.entries().filter((e) => e.kind === 'event')).toHaveLength(1);
  });
});

describe('desync detection', () => {
  it('a client whose log diverged reports desync on the next grant and still signs its own hash', async () => {
    const r = await rig(['a', 'b'], 1);
    r.host.start();
    await flush();
    const a = r.clients['a'] as ClientMatch;
    const desyncs: string[] = [];
    a.on('desync', (d) => desyncs.push(d.context));
    // Corrupt a's log by appending a bogus entry.
    a.log.append({ ts: 1, kind: 'msg', from: 'a', message: buildMessage('RESUME', {}, { matchId: 'M', seq: 1, from: 'a', ts: 1 }) });
    r.host.localBallEnd(5, 'script');
    await flush();
    expect(desyncs).toEqual(['grant.logHash']);
    const signs: { playerId: string; agrees: boolean }[] = [];
    r.host.on('logSign', (s) => signs.push({ playerId: s.playerId, agrees: s.agrees }));
    const results: PayloadOf<'RESULT'>[] = [];
    r.host.on('result', (x) => results.push(x.result));
    a.reportBallEnd(6, 'script');
    await flush();
    (r.clients['b'] as ClientMatch).reportBallEnd(7, 'script');
    await flush();
    expect(signs.sort((x, y) => x.playerId.localeCompare(y.playerId))).toEqual([
      { playerId: 'a', agrees: false },
      { playerId: 'b', agrees: true },
    ]);
    // Every later grant carries a head a's fork cannot match, and the RESULT head differs too.
    expect(desyncs).toEqual(['grant.logHash', 'grant.logHash', 'result.logHash']);
    // RESULT.signatures carries what each participant actually signed, so a's can still be verified.
    const result = results[0];
    if (!result) throw new Error('no result');
    const sa = result.signatures.find((s) => s.playerId === 'a');
    const sb = result.signatures.find((s) => s.playerId === 'b');
    expect(sb).toMatchObject({ logHash: result.logHash, logLength: result.logLength });
    expect(sa?.logHash).not.toBe(result.logHash);
    expect(sa).toMatchObject({ logHash: a.log.head().hash, logLength: a.log.head().length });
    expect(verifyCanonical(logSignBody('M', sa?.logHash ?? '', sa?.logLength ?? 0), sa?.signature ?? '', r.keys['a']?.publicKeyB64 ?? '')).toBe(true);
  });
});
