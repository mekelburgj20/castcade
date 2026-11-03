/**
 * A10 + A11 (2026-11-02): a match is a series of games in one hash-chained log, and the match can start from the host's
 * table. Engine level (HostMatch + ClientMatch over a MemoryBus, or real WebSockets for the reconnect): NEXT_GAME, one
 * RESULT per game with `game` and the series, MATCH_END, a player who left before the next game, a host transfer
 * mid-series, a reconnect mid-series with game 1's RESULT reaching the late peer, and the lobby start countdown.
 */
import { describe, expect, it } from 'vitest';
import type { GameFingerprint, GrantBody, ParticipantInfo, PayloadOf } from '@castcade/protocol';
import { ClientMatch, type ResultInfo } from './client.js';
import { ManualClock } from './clock.js';
import { HostMatch } from './host.js';
import { generateKeys, verifyCanonical, type KeyPair } from './keys.js';
import { logSignBody, seriesStandings } from './result.js';
import { MemoryBus } from './transport.js';
import { WsPeerTransport } from './transport-ws.js';

const flush = async (n = 8): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setTimeout(r, 0));
};

const until = async (cond: () => boolean, ms = 4000): Promise<void> => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await new Promise<void>((r) => setTimeout(r, 10));
  }
};

const hex = 'ab'.repeat(32);
const game: GameFingerprint = { kind: 'vpx', tableName: 'MM', tableHash: hex, romName: null, romHash: null, physicsHash: null, recipeVersion: '0.5.0', sidecarHash: null, emulatorVersion: '10.8.0' };
const noTable: GameFingerprint = { ...game, tableName: 'no table open', tableHash: '0'.repeat(64) };

function participant(id: string, keys: KeyPair): ParticipantInfo {
  return { playerId: id, displayName: id, publicKey: keys.publicKeyB64, rig: 'pc' };
}

interface Rig {
  bus: MemoryBus;
  clock: ManualClock;
  host: HostMatch;
  clients: Record<string, ClientMatch>;
  hostResults: PayloadOf<'RESULT'>[];
  clientResults: Record<string, ResultInfo[]>;
}

async function rig(ids: string[], balls = 1, clientGames: Record<string, GameFingerprint> = {}): Promise<Rig> {
  const bus = new MemoryBus();
  const clock = new ManualClock();
  const hk = generateKeys();
  const host = new HostMatch({ transport: bus.transport('h'), keys: hk, matchId: 'S', ballsPerGame: balls, hostParticipant: participant('h', hk), hostGame: game, fingerprintPolicy: 'advise', clock });
  const hostResults: PayloadOf<'RESULT'>[] = [];
  host.on('result', (r) => hostResults.push(r.result));
  const clients: Record<string, ClientMatch> = {};
  const clientResults: Record<string, ResultInfo[]> = {};
  for (const id of ids) {
    const k = generateKeys();
    const c = new ClientMatch({ transport: bus.transport(id), keys: k, participant: participant(id, k), game: clientGames[id] ?? game, throwdownCode: 'S', hostId: 'h', clock });
    clients[id] = c;
    clientResults[id] = [];
    c.on('result', (r) => clientResults[id]?.push(r));
    c.join();
  }
  await flush();
  return { bus, clock, host, clients, hostResults, clientResults };
}

/** The player the outstanding grant names answers it with `score` (the host locally, a client over the bus). */
async function ballEnd(r: Rig, score: number, host: HostMatch = r.host): Promise<GrantBody> {
  const g = host.state.currentGrant?.grant;
  if (!g) throw new Error('no grant outstanding');
  if (g.player === host.localId) host.localBallEnd(score, 'script');
  else {
    const c = r.clients[g.player];
    if (!c) throw new Error(`no client ${g.player}`);
    c.reportBallEnd(score, 'script');
  }
  await flush();
  return g;
}

describe('A10: a series of games in one match', () => {
  it('two games back to back: NEXT_GAME from grant 1, one RESULT per game with `game` and the series, one log, MATCH_END', async () => {
    const r = await rig(['a']);
    const { host } = r;
    const a = r.clients['a'];
    if (!a) throw new Error('no client');
    // A game_start on the host's table before the RESULT went out starts nothing (the host waits for a's LOG_SIGN).
    const early: (boolean | string | null)[] = [];
    host.on('allGamesEnded', () => {
      early.push(host.nextGameBlocker());
      early.push(host.nextGame());
    });
    host.start();
    await flush();
    expect(host.state.currentGrant?.grant).toMatchObject({ player: 'h', ballNumber: 1, game: 1, grantSeq: 1 });
    await ballEnd(r, 100);
    await ballEnd(r, 200);
    expect(early).toEqual(["the last game's result has not gone out yet", false]);
    expect(host.state.phase).toBe('ended');
    expect(r.hostResults).toHaveLength(1);
    const r1 = r.hostResults[0]!;
    expect(r1).toMatchObject({ game: 1, winner: 'a' });
    expect(r1.series).toEqual([
      { playerId: 'h', games: 1, wins: 0, totalScore: 100, rank: 2 },
      { playerId: 'a', games: 1, wins: 1, totalScore: 200, rank: 1 },
    ]);
    expect(r.clientResults['a']?.[0]).toMatchObject({ logMatches: true, signatureValid: true });
    // End match is between games only; during game 2 it is refused.
    const nextSeen: PayloadOf<'NEXT_GAME'>[] = [];
    a.on('nextGame', (p) => nextSeen.push(p));
    const aGrants: GrantBody[] = [];
    a.on('grant', (g) => aGrants.push(g));

    expect(host.nextGameBlocker()).toBeNull();
    expect(host.nextGame()).toBe(true);
    await flush();
    expect(nextSeen).toEqual([{ game: 2, playerOrder: ['h', 'a'] }]);
    expect(host.state).toMatchObject({ phase: 'running', gameNumber: 2 });
    expect(a.state).toMatchObject({ phase: 'running', gameNumber: 2 });
    expect(a.state.players['a']).toMatchObject({ ballsPlayed: 0, score: 0, status: 'playing' });
    // Grant 1 of game 2 goes to the host (its table started the game); grantSeq keeps counting.
    expect(aGrants[0]).toMatchObject({ player: 'h', ballNumber: 1, game: 2, grantSeq: 3 });
    expect(host.endMatch()).toBe(false);
    expect(host.nextGame()).toBe(false);
    await ballEnd(r, 300);
    await ballEnd(r, 50);

    expect(r.hostResults).toHaveLength(2);
    const r2 = r.hostResults[1]!;
    expect(r2).toMatchObject({ game: 2, winner: 'h' });
    expect(r2.entries.map((e) => [e.playerId, e.score, e.rank])).toEqual([
      ['h', 300, 1],
      ['a', 50, 2],
    ]);
    // 1 win each; h leads on total score (400 to 250).
    expect(r2.series).toEqual([
      { playerId: 'h', games: 2, wins: 1, totalScore: 400, rank: 1 },
      { playerId: 'a', games: 2, wins: 1, totalScore: 250, rank: 2 },
    ]);
    // Each RESULT signs the log head at its game's end; the log runs on across games and agrees everywhere.
    expect(r2.logLength).toBeGreaterThan(r1.logLength);
    expect(host.log.head()).toEqual({ hash: r2.logHash, length: r2.logLength });
    expect(a.log.head()).toEqual(host.log.head());
    expect(host.log.at(r1.logLength - 1)?.hash).toBe(r1.logHash);
    expect(a.log.verifyChain()).toEqual({ ok: true });
    expect(r2.signatures.map((s) => [s.playerId, s.logLength])).toEqual([['a', r2.logLength]]);
    expect(verifyCanonical(logSignBody('S', r2.logHash, r2.logLength), r2.signatures[0]!.signature, a.publicKey)).toBe(true);
    expect(r.clientResults['a']?.map((x) => [x.result.game, x.logMatches, x.signatureValid])).toEqual([
      [1, true, true],
      [2, true, true],
    ]);
    const types = host.log.entries().map((e) => e.message?.type);
    expect(types.filter((t) => t === 'NEXT_GAME')).toHaveLength(1);
    expect(types).not.toContain('MATCH_END');

    const ended: PayloadOf<'MATCH_END'>[] = [];
    a.on('matchEnded', (p) => ended.push(p));
    expect(host.endMatch()).toBe(true);
    expect(host.endMatch()).toBe(false);
    await flush();
    expect(ended).toEqual([{ games: 2, reason: 'the host ended the match' }]);
    expect(a.matchEnded).toBe(true);
    expect(host.nextGameBlocker()).toBe('the match has ended');
    // MATCH_END is not logged: the last RESULT still signs the head.
    expect(host.log.head().length).toBe(r2.logLength);
  });

  it('a player who left before game 2 is out of its order and its standings, and stays in the series', async () => {
    const r = await rig(['a', 'b']);
    const { host, bus } = r;
    host.start();
    await flush();
    await ballEnd(r, 100);
    await ballEnd(r, 200);
    await ballEnd(r, 300);
    expect(r.hostResults[0]).toMatchObject({ game: 1, winner: 'b' });
    bus.disconnect('b');
    await flush();
    expect(host.nextGame()).toBe(true);
    await flush();
    expect(host.state.playerOrder).toEqual(['h', 'a']);
    expect(r.clients['a']?.state.playerOrder).toEqual(['h', 'a']);
    await ballEnd(r, 400);
    await ballEnd(r, 500);
    const r2 = r.hostResults[1];
    expect(r2?.entries.map((e) => e.playerId)).toEqual(['h', 'a']);
    expect(r2?.series).toEqual([
      { playerId: 'h', games: 2, wins: 0, totalScore: 500, rank: 3 },
      { playerId: 'a', games: 2, wins: 1, totalScore: 700, rank: 1 },
      { playerId: 'b', games: 1, wins: 1, totalScore: 300, rank: 2 },
    ]);
    // With b gone and a gone too, nobody is left to play game 3.
    bus.disconnect('a');
    await flush();
    expect(host.nextGameBlocker()).toBe('fewer than two players are still connected');
    expect(host.nextGame()).toBe(false);
  });

  it('a host transfer mid-series keeps the series: the new host finishes game 2 and starts game 3', async () => {
    const r = await rig(['a']);
    const { host } = r;
    const a = r.clients['a']!;
    let newHost: HostMatch | null = null;
    a.on('becameHost', (h) => {
      newHost = h;
    });
    let oldHostClient: ClientMatch | null = null;
    host.on('hostTransfer', (t) => {
      oldHostClient = t.client;
    });
    host.start();
    await flush();
    await ballEnd(r, 100);
    await ballEnd(r, 200);
    expect(host.nextGame()).toBe(true);
    await flush();
    await ballEnd(r, 300); // h's ball of game 2; a is up now
    host.transferHost('a');
    await flush();
    const nh = newHost as HostMatch | null;
    if (!nh) throw new Error('a did not become host');
    const results: PayloadOf<'RESULT'>[] = [];
    nh.on('result', (x) => results.push(x.result));
    const oldResults: ResultInfo[] = [];
    (oldHostClient as ClientMatch | null)?.on('result', (x) => oldResults.push(x));
    expect(nh.state).toMatchObject({ gameNumber: 2, hostId: 'a', hostTransfers: 1 });
    // The re-issued grant is a's, in game 2.
    expect(nh.state.currentGrant?.grant).toMatchObject({ player: 'a', ballNumber: 1, game: 2 });
    nh.localBallEnd(250, 'script');
    await flush();
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ game: 2, winner: 'h', hostTransfers: 1 });
    expect(results[0]?.series.map((s) => [s.playerId, s.games, s.wins, s.totalScore])).toEqual([
      ['h', 2, 1, 400],
      ['a', 2, 1, 450],
    ]);
    expect(oldResults[0]).toMatchObject({ logMatches: true, signatureValid: true });
    expect(nh.nextGame()).toBe(true);
    await flush();
    expect(nh.state).toMatchObject({ gameNumber: 3, playerOrder: ['a', 'h'] });
    expect(nh.state.currentGrant?.grant).toMatchObject({ player: 'a', game: 3, ballNumber: 1 });
    expect((oldHostClient as ClientMatch | null)?.state.gameNumber).toBe(3);
    expect((oldHostClient as ClientMatch | null)?.log.head()).toEqual(nh.log.head());
  });

  it('a client drops a NEXT_GAME that is not the next number, and one before the game ended', async () => {
    const r = await rig(['a']);
    const { host } = r;
    const a = r.clients['a']!;
    const dropped: string[] = [];
    a.on('dropped', (d) => dropped.push(`${d.type}:${d.reason}`));
    host.start();
    await flush();
    // Hand-built NEXT_GAME from the host while game 1 still runs: the client keeps it out of its log.
    host.session.transport.send('a', host.session.build('NEXT_GAME', { game: 2, playerOrder: ['h', 'a'] }, 'S'));
    await flush();
    expect(dropped).toEqual(['NEXT_GAME:unexpected']);
    expect(a.state.gameNumber).toBe(1);
    expect(a.log.head()).toEqual(host.log.head());
  });

  it('seriesStandings: a tie for first wins nobody the game; ties in the series share a rank', () => {
    const standings = seriesStandings([
      {
        entries: [
          { playerId: 'h', score: 100, ballsPlayed: 3, status: 'finished', rank: 1 },
          { playerId: 'a', score: 100, ballsPlayed: 3, status: 'finished', rank: 1 },
        ],
      },
    ]);
    expect(standings).toEqual([
      { playerId: 'h', games: 1, wins: 0, totalScore: 100, rank: 1 },
      { playerId: 'a', games: 1, wins: 0, totalScore: 100, rank: 1 },
    ]);
  });
});

describe('A10: reconnect mid-series over WebSockets', () => {
  it("a client that dropped at game 1's end resumes in game 2 (the game number with it) and gets game 1's RESULT late, checked against its log", async () => {
    const ids = ['h', 'a', 'b'];
    const transports = new Map(ids.map((id) => [id, new WsPeerTransport({ localId: id })]));
    try {
      const keys = new Map(ids.map((id) => [id, generateKeys()]));
      const endpoint = await transports.get('h')!.listen();
      const host = new HostMatch({ transport: transports.get('h')!, keys: keys.get('h')!, matchId: 'WS-S', ballsPerGame: 1, hostParticipant: participant('h', keys.get('h')!), hostGame: game });
      const hostResults: PayloadOf<'RESULT'>[] = [];
      const clients = new Map<string, ClientMatch>();
      const results = new Map<string, ResultInfo[]>();
      for (const id of ['a', 'b']) {
        await transports.get(id)!.connect(endpoint);
        const c = new ClientMatch({
          transport: transports.get(id)!,
          keys: keys.get(id)!,
          participant: participant(id, keys.get(id)!),
          game,
          throwdownCode: 'WS-S',
          reconnect: { delayMs: 150, attempts: 20 },
        });
        clients.set(id, c);
        results.set(id, []);
        c.on('result', (x) => results.get(id)?.push(x));
        c.join();
      }
      await until(() => host.roster().length === 3);
      const a = clients.get('a')!;
      const b = clients.get('b')!;
      // Game 1: h, a, b one ball each. a drops its socket once b is up (a's game is over by then), so it misses b's
      // ball end, game 1's RESULT and the NEXT_GAME the host sends at once.
      let dropped = false;
      host.on('grant', (g) => {
        if (g.player === 'b' && g.game === 1 && !dropped) {
          dropped = true;
          transports.get('a')!.dropLinks('h');
        }
      });
      host.on('result', (x) => {
        hostResults.push(x.result);
        if (x.result.game === 1) host.nextGame();
      });
      a.on('myTurn', () => a.reportBallEnd(200, 'script'));
      b.on('myTurn', () => b.reportBallEnd(300, 'script'));
      host.on('grant', (g) => {
        if (g.player === 'h') queueMicrotask(() => host.localBallEnd(g.game === 1 ? 100 : 400, 'script'));
      });
      let reconnected = 0;
      a.on('reconnected', () => {
        reconnected += 1;
      });
      host.start();
      await until(() => hostResults.length === 2 && reconnected === 1 && (results.get('a')?.length ?? 0) >= 2);

      // Game 2 ran without a (it was gone at the NEXT_GAME); a came back into game 2 and holds the same log.
      expect(hostResults.map((x) => x.game)).toEqual([1, 2]);
      expect(hostResults[1]?.entries.map((e) => e.playerId)).toEqual(['h', 'b']);
      expect(a.state.gameNumber).toBe(2);
      expect(a.log.head()).toEqual(host.log.head());
      expect(b.log.head()).toEqual(host.log.head());
      // Game 1's RESULT reached a after it was already in game 2: checked against its log at game 1's end, not its head.
      const aRes = results.get('a') ?? [];
      expect(aRes.map((x) => [x.result.game, x.logMatches, x.signatureValid])).toEqual([
        [1, true, true],
        [2, true, true],
      ]);
      expect(results.get('b')?.map((x) => x.result.game)).toEqual([1, 2]);
      // a is not in game 2, so it does not sign it.
      expect(hostResults[1]?.signatures.map((s) => s.playerId)).toEqual(['b']);
    } finally {
      for (const t of transports.values()) t.close();
    }
  });
});

describe('A11: the start from the host table', () => {
  it('startIn: the lobby sees the countdown, a second call changes nothing, MATCH_READY at the end; start() during it starts at once', async () => {
    const r = await rig(['a']);
    const { host, clock } = r;
    const a = r.clients['a']!;
    const acks: PayloadOf<'HELLO_ACK'>[] = [];
    a.on('roster', (x) => acks.push(x));
    expect(host.startIn(5000)).toBe(true);
    await flush();
    expect(acks[acks.length - 1]).toMatchObject({ startsInMs: 5000, loading: [] });
    clock.advance(2000);
    expect(host.startIn(5000)).toBe(false);
    expect(host.countdownRemaining()).toBe(3000);
    expect(host.state.phase).toBe('lobby');
    clock.advance(3000);
    await flush();
    expect(host.state.phase).toBe('running');
    expect(a.state.phase).toBe('running');
    expect(host.countdownRemaining()).toBeNull();

    const r2 = await rig(['a']);
    expect(r2.host.startIn(5000)).toBe(true);
    r2.host.start();
    expect(r2.clock.pending()).toBe(1); // only the grant's ball-end timer; the countdown is gone
    r2.clock.advance(5000);
    expect(r2.host.log.entries().filter((e) => e.message?.type === 'MATCH_READY')).toHaveLength(1);
  });

  it('loading: a client with no table open is named in HELLO_ACK until its update; a countdown with one player left starts nothing', async () => {
    const r = await rig(['a'], 1, { a: noTable });
    const { host, clock, bus } = r;
    const a = r.clients['a']!;
    const acks: PayloadOf<'HELLO_ACK'>[] = [];
    a.on('roster', (x) => acks.push(x));
    expect(host.loading()).toEqual(['a']);
    a.updateParticipant({ game });
    await flush();
    expect(host.loading()).toEqual([]);
    expect(acks[acks.length - 1]?.loading).toEqual([]);
    const cancelled: string[] = [];
    host.on('countdownCancelled', (c) => cancelled.push(c.reason));
    expect(host.startIn(5000)).toBe(true);
    bus.disconnect('a');
    await flush();
    clock.advance(5000);
    expect(host.state.phase).toBe('lobby');
    expect(cancelled).toEqual(['fewer than two players are in']);
  });
});
