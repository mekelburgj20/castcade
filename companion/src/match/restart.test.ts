/**
 * A15 (2026-11-12): the engine after a restart of one participant's process, over real WebSockets on localhost: a
 * client rebuilt from its saved log reconnects (and why its `seq` must start high), a host rebuilt from its saved log
 * takes its players back and issues the outstanding grant again, a client that loses its host for good does not make
 * itself host, and the log is handed to `onCommit` entry by entry.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { GameFingerprint, ParticipantInfo } from '@castcade/protocol';
import { ClientMatch } from './client.js';
import { HostMatch } from './host.js';
import { generateKeys, type KeyPair } from './keys.js';
import { MatchLog, type LogEntry } from './log.js';
import { Session } from './session.js';
import { WsPeerTransport } from './transport-ws.js';

const game: GameFingerprint = { kind: 'vpx', tableName: 'Test Table', tableHash: 'ab'.repeat(32), romName: null, romHash: null, physicsHash: null, recipeVersion: '0.5.0', sidecarHash: null, emulatorVersion: '10.8.0' };
const participant = (id: string, keys: KeyPair): ParticipantInfo => ({ playerId: id, displayName: id === 'h' ? 'Host' : 'Guest', publicKey: keys.publicKeyB64, rig: 'pc' });

const until = async (cond: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const copy = (log: MatchLog): LogEntry[] => JSON.parse(JSON.stringify(log.toJSON())) as LogEntry[];

const open: { close(): void }[] = [];
afterEach(() => {
  for (const x of open.splice(0)) x.close();
});

/** A started two-player match over WebSockets, 2 balls: the host played ball 1 (100), the client holds ball 1. */
async function match(clientOpts: Partial<ConstructorParameters<typeof ClientMatch>[0]> = {}) {
  const hk = generateKeys();
  const ck = generateKeys();
  const ht = new WsPeerTransport({ localId: 'h' });
  const endpoint = await ht.listen(0, '127.0.0.1');
  const host = new HostMatch({ transport: ht, keys: hk, matchId: 'ABCDEF', ballsPerGame: 2, hostParticipant: participant('h', hk), hostGame: game });
  const ct = new WsPeerTransport({ localId: 'a' });
  await ct.connect(endpoint);
  const client = new ClientMatch({ transport: ct, keys: ck, participant: participant('a', ck), game, throwdownCode: 'ABCDEF', ...clientOpts });
  open.push(ht, ct, host, client);
  client.join();
  await until(() => client.isJoined && host.roster().length === 2);
  host.start();
  host.localBallEnd(100, 'nvram');
  await until(() => client.myGrant?.ballNumber === 1);
  return { hk, ck, ht, ct, host, client, endpoint };
}

describe('a client rebuilt from its saved log (A15)', () => {
  it('reconnects with RECONNECT from the saved head when its seq starts above the last run; with a counter that starts over the host rejects it', async () => {
    const m = await match();
    for (let i = 0; i < 5; i++) m.client.reportState({ ballNumber: 1, score: 10 * i, ballInPlay: true, tilt: false });
    const saved = copy(m.client.log);
    const before = m.client.myGrant!.grantSeq;
    // The client's process dies: the socket closes, nothing is said.
    m.ct.close();
    m.client.close();
    await until(() => m.host.state.paused?.reason === 'disconnect');

    // A new process, the counter at zero: the host has seen higher numbers from this player and rejects the frame.
    const rejected: string[] = [];
    m.host.on('reject', (r) => rejected.push(`${r.refType}:${r.code}`));
    const t2 = new WsPeerTransport({ localId: 'a' });
    const naive = ClientMatch.adopt(new Session({ transport: t2, keys: m.ck, log: MatchLog.fromJSON(saved) }), { participant: participant('a', m.ck), game, throwdownCode: 'ABCDEF', reconnect: { attempts: 1 }, hostLeftTransfer: false });
    open.push(t2, naive);
    let back = false;
    naive.on('reconnected', () => (back = true));
    naive.relinkTo('h', { endpoint: m.endpoint });
    await until(() => rejected.includes('RECONNECT:unexpected_state'));
    expect(back).toBe(false);
    naive.close();
    t2.close();

    // The same with the counter started from the clock.
    const t3 = new WsPeerTransport({ localId: 'a' });
    const session = new Session({ transport: t3, keys: m.ck, log: MatchLog.fromJSON(saved), seqStart: Date.now() });
    const again = ClientMatch.adopt(session, { participant: participant('a', m.ck), game, throwdownCode: 'ABCDEF', hostLeftTransfer: false });
    open.push(t3, again);
    const turns: number[] = [];
    again.on('myTurn', (g) => turns.push(g.grantSeq));
    let entries = -1;
    again.on('reconnected', (r) => (entries = r.entries));
    again.relinkTo('h', { endpoint: m.endpoint });
    await until(() => entries >= 0);
    // The host's PAUSE came with the answer; the grant in the log is this player's and its table is released at once.
    expect(entries).toBe(1);
    expect(again.state.paused).toMatchObject({ reason: 'disconnect', player: 'a' });
    expect(turns).toEqual([before]);
    expect(again.inputUnlocked).toBe(true);
    expect(again.log.head()).toEqual(m.host.log.head());

    // RESUME: the grant comes again under a new number, and the ball end is taken for it.
    again.resume();
    await until(() => (again.myGrant?.grantSeq ?? 0) > before);
    again.reportBallEnd(250, 'nvram');
    await until(() => m.host.state.players.a?.score === 250 && m.host.state.currentGrant?.grant.player === 'h');
    expect(m.host.state.players.a).toMatchObject({ ballsPlayed: 1, connected: true });
  });

  it('a saved log that was altered does not load; one the host does not hold is refused and the client hears it', async () => {
    const m = await match();
    const saved = copy(m.client.log);
    const altered = copy(m.client.log);
    altered[altered.length - 1] = { ...altered[altered.length - 1]!, ts: altered[altered.length - 1]!.ts + 1 };
    expect(() => MatchLog.fromJSON(altered)).toThrow(/log chain broken/);

    // Another match under the same code and keys: this host never held that head.
    const other = await match();
    const t = new WsPeerTransport({ localId: 'a' });
    const stray = ClientMatch.adopt(new Session({ transport: t, keys: m.ck, log: MatchLog.fromJSON(saved), seqStart: Date.now() }), { participant: participant('a', m.ck), game, throwdownCode: 'ABCDEF', hostLeftTransfer: false });
    open.push(t, stray);
    let code: string | null | undefined;
    stray.on('reconnectRejected', (r) => (code = r.code));
    stray.relinkTo('h', { endpoint: other.endpoint });
    await until(() => code !== undefined);
    expect(['unknown_log_hash', 'bad_signature']).toContain(code);
  });
});

describe('a client whose host is gone for good (A15)', () => {
  it('by default it proposes itself (a full mesh can reach it); with hostLeftTransfer off it only says the host is lost', async () => {
    const m = await match({ reconnect: { attempts: 2, delayMs: 20 }, hostLeftTransfer: false });
    const seen: string[] = [];
    m.client.on('hostLost', () => seen.push('hostLost'));
    m.client.on('becameHost', () => seen.push('becameHost'));
    m.client.on('transferProposed', () => seen.push('transferProposed'));
    m.ht.close();
    m.host.close();
    await until(() => seen.includes('hostLost'));
    await sleep(50);
    expect(seen).toEqual(['hostLost']);

    const d = await match({ reconnect: { attempts: 2, delayMs: 20 } });
    const seen2: string[] = [];
    d.client.on('hostLost', () => seen2.push('hostLost'));
    d.client.on('becameHost', () => seen2.push('becameHost'));
    d.ht.close();
    d.host.close();
    await until(() => seen2.includes('becameHost'));
    expect(seen2[0]).toBe('hostLost');
  });

  it('the wait ends by the clock (`maxMs`) however many attempts are left', async () => {
    const m = await match({ reconnect: { attempts: 1_000_000, delayMs: 20, maxMs: 200 }, hostLeftTransfer: false });
    let lost = 0;
    let failed = 0;
    m.client.on('hostLost', () => (lost = Date.now()));
    m.client.on('reconnectFailed', () => failed++);
    const t0 = Date.now();
    m.ht.close();
    m.host.close();
    await until(() => lost > 0);
    expect(lost - t0).toBeGreaterThanOrEqual(200);
    expect(lost - t0).toBeLessThan(3000);
    expect(failed).toBeGreaterThan(1);
  });
});

describe('a host rebuilt from its saved log (A15)', () => {
  it("during a client's ball: the client's own retry finds it again, the pause for the client is cleared by the client, and the grant comes again", async () => {
    const m = await match({ reconnect: { attempts: 200, delayMs: 50 }, hostLeftTransfer: false });
    const saved = copy(m.host.log);
    const before = m.client.myGrant!.grantSeq;
    const port = Number(new URL(m.endpoint).port);
    m.ht.close();
    m.host.close();
    // The client reports its ball end into the dead link: lost.
    m.client.reportBallEnd(300, 'nvram');
    expect(m.client.myGrant).toBeNull();

    const ht2 = new WsPeerTransport({ localId: 'h' });
    const log = MatchLog.fromJSON(saved);
    const session = new Session({ transport: ht2, keys: m.hk, log, seqStart: Date.now() });
    const host2 = HostMatch.resumeFromLog(log, { transport: ht2, keys: m.hk, session, gone: ['a'] });
    open.push(ht2, host2);
    await ht2.listen(port, '127.0.0.1');
    host2.runAfterRestart();
    // Nobody to grant to: the usual pause for the player who is not there.
    expect(host2.state.paused).toMatchObject({ reason: 'disconnect', player: 'a' });
    await until(() => m.client.state.paused?.player === 'a');
    expect(m.client.log.head()).toEqual(host2.log.head());
    m.client.resume();
    await until(() => (m.client.myGrant?.grantSeq ?? 0) > before);
    m.client.reportBallEnd(300, 'nvram');
    await until(() => host2.state.players.a?.score === 300);
    expect(host2.state.currentGrant?.grant).toMatchObject({ player: 'h', ballNumber: 2 });
  });

  it('during its own ball: the grant is issued again at once under a new number and the ball end is taken; between games the result goes out again', async () => {
    const m = await match({ reconnect: { attempts: 200, delayMs: 50 }, hostLeftTransfer: false });
    m.client.reportBallEnd(50, 'nvram');
    await until(() => m.host.state.currentGrant?.grant.player === 'h' && m.host.state.currentGrant.grant.ballNumber === 2);
    const before = m.host.state.currentGrant!.grant.grantSeq;
    const saved = copy(m.host.log);
    const port = Number(new URL(m.endpoint).port);
    m.ht.close();
    m.host.close();

    const ht2 = new WsPeerTransport({ localId: 'h' });
    const log = MatchLog.fromJSON(saved);
    const session = new Session({ transport: ht2, keys: m.hk, log, seqStart: Date.now() });
    const host2 = HostMatch.resumeFromLog(log, { transport: ht2, keys: m.hk, session, gone: ['a'], logSignTimeoutMs: 100 });
    open.push(ht2, host2);
    await ht2.listen(port, '127.0.0.1');
    host2.runAfterRestart();
    expect(host2.state.currentGrant?.grant).toMatchObject({ player: 'h', ballNumber: 2 });
    expect(host2.state.currentGrant!.grant.grantSeq).toBeGreaterThan(before);
    host2.localBallEnd(400, 'nvram');
    // The client is still away: the rotation pauses for it; it comes back, resumes, plays its last ball.
    await until(() => m.client.state.paused?.player === 'a');
    m.client.resume();
    await until(() => m.client.myGrant?.ballNumber === 2);
    m.client.reportBallEnd(90, 'nvram');
    await until(() => host2.state.phase === 'ended' && host2.resultOut);
    const savedEnded = copy(host2.log);
    ht2.close();
    host2.close();

    // Between games: no grant to issue; the result goes out again so the next game can start.
    const ht3 = new WsPeerTransport({ localId: 'h' });
    const log3 = MatchLog.fromJSON(savedEnded);
    const host3 = HostMatch.resumeFromLog(log3, { transport: ht3, keys: m.hk, session: new Session({ transport: ht3, keys: m.hk, log: log3, seqStart: Date.now() }), gone: ['a'] });
    open.push(ht3, host3);
    const results: number[] = [];
    host3.on('result', (r) => results.push(r.result.game));
    await ht3.listen(port, '127.0.0.1');
    expect(host3.nextGameBlocker()).toBe("the last game's result has not gone out yet");
    host3.runAfterRestart();
    expect(results).toEqual([1]);
    await until(() => host3.nextGameBlocker() === null);
    expect(host3.nextGame()).toBe(true);
    await until(() => m.client.state.gameNumber === 2);
  });
});

describe('Session (A15)', () => {
  it('onCommit sees every entry as it is made, and seqStart only ever raises the counter', async () => {
    const m = await match();
    const seen: number[] = [];
    m.host.session.onCommit = (e) => seen.push(e.index);
    const from = m.host.log.length;
    m.client.reportBallEnd(70, 'nvram');
    await until(() => m.host.state.currentGrant?.grant.player === 'h');
    expect(seen).toEqual(Array.from({ length: m.host.log.length - from }, (_, i) => from + i));
    expect(seen.length).toBeGreaterThanOrEqual(2);

    const t = new WsPeerTransport({ localId: 'x' });
    open.push(t);
    const k = generateKeys();
    expect(new Session({ transport: t, keys: k, seqStart: 5000 }).nextSeq()).toBe(5001);
    expect(new Session({ transport: t, keys: k }).nextSeq()).toBe(1);
    expect(new Session({ transport: t, keys: k, seqStart: -3 }).nextSeq()).toBe(1);
  });
});
