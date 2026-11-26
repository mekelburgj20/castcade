/**
 * A17 step 5 (2026-11-25): the lobby scenarios. Scripted members play whole evenings in one lobby with the engines'
 * lobby option on: two matches in sequence, a watcher, a lobby's PC that only watches, a join in the middle of a
 * game, a series and then a new match, and a log too long for one relay frame, sent in pages through the relay
 * double. What every one of them must show is in `checkLobby`: each match's log is one hash chain from its own
 * entry 0, the same on every PC that was in the lobby for it, and every RESULT verifies everywhere.
 */
import { describe, expect, it } from 'vitest';
import { GENESIS_HASH, RELAY_MAX_BYTES, RelayClientTransport, RelayHostTransport, logSignBody, verifyCanonical, type Transport } from '@castcade/companion';
import { startFakeRelay } from '../../companion/src/match/relay-fake.test-support.js';
import { runLobbyScenario, type LobbyRun } from './lobby.js';
import { loadScenario, LOBBY_SCENARIO_NAMES, validateScenario } from './scenario.js';

/** What a player's engine sends and a watcher's never does. */
const PLAYER_TYPES = ['STATE', 'DMD_FRAME', 'BALL_END', 'GAME_OVER', 'FORFEIT', 'PAUSE', 'RESUME', 'LOG_SIGN'];

function checkLobby(run: LobbyRun): void {
  const { scenario, outcomes } = run;
  const host = outcomes[scenario.host];
  if (!host) throw new Error('no lobby PC outcome');
  expect(host.matches.length).toBe(scenario.matches?.length);
  for (const o of Object.values(outcomes)) {
    expect(o.error, `${o.playerId} error`).toBeNull();
    expect(o.refused, `${o.playerId} refused`).toBeNull();
    expect(o.closed, `${o.playerId} was told the lobby closed`).toEqual({ reason: 'the scenario is over' });
    expect(o.desyncs, `${o.playerId} desyncs`).toEqual([]);
    expect(o.dropped, `${o.playerId} dropped frames`).toEqual([]);
    expect(o.rejects, `${o.playerId} rejects`).toEqual([]);
    // The envelope's seq is the connection's: it never starts over at a match.
    expect(o.hostSeqs.every((s, i) => i === 0 || s > (o.hostSeqs[i - 1] as number)), `${o.playerId}: the lobby PC's seq only goes up`).toBe(true);
  }
  for (const [i, m] of host.matches.entries()) {
    const id = `${scenario.matchId}-${i + 1}`;
    expect(m.matchId).toBe(id);
    expect(m.ready.hostPlayerId).toBe(scenario.host);
    expect(m.end, `${id} was ended`).not.toBeNull();
    const log = m.log;
    if (!log || !m.head) throw new Error(`${id}: the lobby PC has no log`);
    // A log of its own, from nothing: nothing chains one match to the next.
    expect(log.verifyChain()).toEqual({ ok: true });
    expect(log.at(0)?.prevHash).toBe(GENESIS_HASH);
    expect(log.at(0)?.message?.type).toBe('MATCH_READY');
    for (const e of log.entries()) expect(e.message?.matchId, `${id} entry ${e.index}`).toBe(id);
    const grants = log.entries().flatMap((e) => (e.message?.type === 'TURN_GRANT' ? [e.message.payload.grant] : []));
    expect(grants.map((g) => g.grantSeq)).toEqual(grants.map((_, k) => k + 1));
    // Only its players are in it: nobody else wrote an entry, and nobody else is in a roster or a RESULT.
    const players = new Set(m.ready.playerOrder);
    expect(m.ready.participants.map((p) => p.playerId)).toEqual(m.ready.playerOrder);
    for (const e of log.entries()) expect(players.has(e.from) || e.from === scenario.host, `${id} entry ${e.index} from ${e.from}`).toBe(true);
    expect(m.end?.games).toBe(m.results.length);
    for (const r of m.results) {
      expect(r.result.matchId).toBe(id);
      expect(log.at(r.result.logLength - 1)?.hash).toBe(r.result.logHash);
      expect(verifyCanonical(logSignBody(id, r.result.logHash, r.result.logLength), r.result.hostSignature, host.publicKey)).toBe(true);
      for (const e of r.result.entries) expect(players.has(e.playerId)).toBe(true);
      for (const s of r.result.signatures) {
        expect(players.has(s.playerId)).toBe(true);
        expect([s.logHash, s.logLength]).toEqual([r.result.logHash, r.result.logLength]);
        expect(verifyCanonical(logSignBody(id, s.logHash, s.logLength), s.signature, outcomes[s.playerId]?.publicKey ?? '')).toBe(true);
      }
    }
    // Every member who was in the lobby for this match holds the same log and the same RESULTs, the watchers too.
    for (const o of Object.values(outcomes)) {
      const mine = o.matches.find((x) => x.matchId === id);
      if (!mine) continue;
      expect(mine.head, `${o.playerId} head of ${id}`).toEqual(m.head);
      expect(mine.log?.verifyChain(), `${o.playerId} chain of ${id}`).toEqual({ ok: true });
      expect(mine.end, `${o.playerId} MATCH_END of ${id}`).toEqual(m.end);
      expect(mine.results.map((r) => r.result), `${o.playerId} results of ${id}`).toEqual(m.results.map((r) => r.result));
      for (const r of mine.results) expect([r.logMatches, r.signatureValid], `${o.playerId} checks of ${id}`).toEqual([true, true]);
    }
  }
}

describe('lobby scenario files (A17 step 5)', () => {
  it('all bundled lobby scenarios load and validate, and the loader refuses the keys where they do not belong', () => {
    for (const name of LOBBY_SCENARIO_NAMES) {
      const s = loadScenario(name);
      expect(s.name).toBe(name);
      expect(s.lobby).toBeTruthy();
      expect(s.matches?.length).toBeGreaterThanOrEqual(1);
      for (const p of s.players) expect(['play', 'watch']).toContain(p.stance);
    }
    const base = { name: 'x', matchId: 'X', ballsPerGame: 1, host: 'p1', players: [{ playerId: 'p1', scores: [1] }, { playerId: 'p2', scores: [1] }] };
    expect(() => validateScenario({ ...base, matches: [{}] })).toThrow(/matches needs lobby/);
    expect(() => validateScenario({ ...base, lobby: true })).toThrow(/needs matches/);
    expect(() => validateScenario({ ...base, lobby: true, matches: [{ players: ['p9'] }] })).toThrow(/p9 is not a player/);
    expect(() => validateScenario({ ...base, lobby: true, matches: [{ stances: { p1: 'sleep' } }] })).toThrow(/play or watch/);
    expect(() => validateScenario({ ...base, players: [{ playerId: 'p1', scores: [1] }, { playerId: 'p2', scores: [1], joinsAt: { match: 1, afterGrants: 1 } }] })).toThrow(/joinsAt needs a lobby/);
    expect(validateScenario({ ...base, lobby: true, matches: [{}] }).matches).toHaveLength(1);
  });
});

describe('lobby-two-matches', () => {
  it('two matches in one lobby: an id and a log each, from genesis, and nobody leaves in between', async () => {
    const run = await runLobbyScenario(loadScenario('lobby-two-matches'));
    checkLobby(run);
    for (const id of ['p1', 'p2']) {
      const o = run.outcomes[id];
      expect(o?.matches.map((m) => [m.matchId, m.ready.playerOrder, m.results.length, m.end?.games])).toEqual([
        ['TWOMAT-1', ['p1', 'p2'], 1, 1],
        ['TWOMAT-2', ['p1', 'p2'], 1, 1],
      ]);
      expect(o?.matches.map((m) => m.results[0]?.result.winner)).toEqual(['p2', 'p2']);
      // The second match knows nothing of the first: its tally is its own.
      expect(o?.matches[1]?.results[0]?.result.series.map((s) => [s.playerId, s.games, s.wins])).toEqual([
        ['p1', 1, 0],
        ['p2', 1, 1],
      ]);
    }
    const [m1, m2] = run.outcomes['p1']?.matches ?? [];
    expect(m1?.head?.hash).not.toBe(m2?.head?.hash);
    expect(m1?.head?.length).toBe(m2?.head?.length);
    // One HELLO for the evening, and no second lobby: the same two members from the first frame to the last.
    expect(run.outcomes['p2']?.sent['HELLO']).toBe(1);
    expect(run.outcomes['p2']?.sent['RECONNECT']).toBeUndefined();
    expect(run.outcomes['p2']?.lobby?.participants.map((p) => p.playerId)).toEqual(['p1', 'p2']);
    expect(run.outcomes['p2']?.lobby?.match).toBeNull();
  });
});

describe('lobby-watcher', () => {
  it('a watcher gets what the players get, keeps the same log, and sends nothing of a player`s', async () => {
    const run = await runLobbyScenario(loadScenario('lobby-watcher'));
    checkLobby(run);
    const w = run.outcomes['p3'];
    const m = run.outcomes['p1']?.matches[0];
    expect(m?.ready.playerOrder).toEqual(['p1', 'p2']);
    expect(m?.results[0]?.result.entries.map((e) => [e.playerId, e.score])).toEqual([
      ['p1', 3000],
      ['p2', 4500],
    ]);
    expect(m?.results[0]?.result.signatures.map((s) => s.playerId)).toEqual(['p2']);
    expect(w?.matches).toHaveLength(1);
    expect(w?.matches[0]?.head).toEqual(m?.head);
    for (const t of PLAYER_TYPES) expect(w?.sent[t], `the watcher sent ${t}`).toBeUndefined();
    expect(Object.keys(w?.sent ?? {})).toEqual(['HELLO']);
    // The players did send them (so the list above is not empty by accident).
    expect(run.outcomes['p2']?.sent['BALL_END']).toBe(3);
    expect(run.outcomes['p2']?.sent['LOG_SIGN']).toBe(1);
    expect(run.outcomes['p2']?.sent['STATE']).toBe(3);
    expect(w?.lobby?.stances).toEqual([
      { playerId: 'p1', stance: 'play' },
      { playerId: 'p2', stance: 'play' },
      { playerId: 'p3', stance: 'watch' },
    ]);
  });
});

describe('lobby-host-watches', () => {
  it('the lobby`s PC arbitrates a match it is not in, then plays the next one', async () => {
    const run = await runLobbyScenario(loadScenario('lobby-host-watches'));
    checkLobby(run);
    const h = run.outcomes['p1'];
    const [m1, m2] = h?.matches ?? [];
    expect(m1?.ready.playerOrder).toEqual(['p2', 'p3']);
    expect(m1?.ready.hostPlayerId).toBe('p1');
    expect(m1?.ready.participants.map((p) => p.playerId)).toEqual(['p2', 'p3']);
    // Every grant is the lobby PC's, none is for it; every other entry is a player's.
    const entries = m1?.log?.entries() ?? [];
    expect(entries.filter((e) => e.kind === 'grant').every((e) => e.from === 'p1' && e.message?.type === 'TURN_GRANT' && e.message.payload.grant.player !== 'p1')).toBe(true);
    expect(entries.filter((e) => e.kind === 'msg' && e.index > 0).every((e) => e.from !== 'p1')).toBe(true);
    const r1 = m1?.results[0]?.result;
    expect(r1?.entries.map((e) => [e.playerId, e.score, e.status])).toEqual([
      ['p2', 3000, 'finished'],
      ['p3', 2500, 'finished'],
    ]);
    expect(r1?.signatures.map((s) => s.playerId).sort()).toEqual(['p2', 'p3']);
    // In match 1 the lobby's PC sent nothing a player sends (STATE is the one its engine would have mirrored).
    expect(m2?.ready.playerOrder).toEqual(['p1', 'p2', 'p3']);
    expect(m2?.results[0]?.result.entries.map((e) => e.playerId)).toEqual(['p1', 'p2', 'p3']);
    expect(m2?.results[0]?.result.signatures.map((s) => s.playerId).sort()).toEqual(['p2', 'p3']);
    expect(run.outcomes['p3']?.lobby?.stances?.find((s) => s.playerId === 'p1')?.stance).toBe('play');
  });
});

describe('lobby-join-mid-game', () => {
  it('a join while a ball is in play: the log in pages, ball ends between the HELLO_ACK and the last page, one head at the end', async () => {
    const run = await runLobbyScenario(loadScenario('lobby-join-mid-game'));
    checkLobby(run);
    const h = run.outcomes['p1'];
    const n = run.outcomes['p3'];
    // The lobby's PC sent the newcomer the log in pages, and entries were committed while they went out.
    expect(h?.sentLogs).toHaveLength(1);
    const sent = h?.sentLogs[0];
    expect(sent?.playerId).toBe('p3');
    expect(sent?.pages).toBeGreaterThan(3);
    expect(sent?.during, 'log entries committed between the HELLO_ACK and the last page').toBeGreaterThan(0);
    // The newcomer: one catch-up, then live; set to Play, and still only a watcher of the match it joined into.
    expect(n?.caughtUp).toEqual([{ match: 'JOINMD-1', entries: sent?.entries }]);
    expect(n?.matches).toHaveLength(1);
    expect(n?.matches[0]?.ready.playerOrder).toEqual(['p1', 'p2']);
    expect(n?.matches[0]?.head).toEqual(h?.matches[0]?.head);
    expect(n?.matches[0]?.results.map((r) => [r.logMatches, r.signatureValid])).toEqual([[true, true]]);
    for (const t of PLAYER_TYPES) expect(n?.sent[t], `the newcomer sent ${t}`).toBeUndefined();
    expect(h?.matches[0]?.results[0]?.result.entries.map((e) => e.playerId)).toEqual(['p1', 'p2']);
  });
});

describe('lobby-series-then-new-match', () => {
  it('a newcomer set to Play is not pulled into the series; Start a new match ends it and brings them in', async () => {
    const run = await runLobbyScenario(loadScenario('lobby-series-then-new-match'));
    checkLobby(run);
    const h = run.outcomes['p1'];
    const [m1, m2] = h?.matches ?? [];
    // Match 1: a series of two by the two who started it. The third was in the lobby, on Play, for game 2.
    const next = m1?.log?.entries().flatMap((e) => (e.message?.type === 'NEXT_GAME' ? [e.message.payload] : [])) ?? [];
    expect(next).toEqual([{ game: 2, playerOrder: ['p1', 'p2'] }]);
    expect(m1?.results.map((r) => [r.result.game, r.result.winner, r.result.entries.map((e) => e.playerId)])).toEqual([
      [1, 'p2', ['p1', 'p2']],
      [2, 'p1', ['p1', 'p2']],
    ]);
    expect(m1?.results[1]?.result.series).toEqual([
      { playerId: 'p1', games: 2, wins: 1, totalScore: 8000, rank: 1 },
      { playerId: 'p2', games: 2, wins: 1, totalScore: 5500, rank: 2 },
    ]);
    // The new match's start is what ended the series, and its tally stands at two games.
    expect(m1?.end).toEqual({ games: 2, reason: 'a new match was started' });
    expect(m2?.matchId).toBe('SERNEW-2');
    expect(m2?.ready.playerOrder).toEqual(['p1', 'p2', 'p3']);
    expect(m2?.results[0]?.result.winner).toBe('p3');
    expect(m2?.results[0]?.result.series.map((s) => [s.playerId, s.games])).toEqual([
      ['p1', 1],
      ['p2', 1],
      ['p3', 1],
    ]);
    // The third person: a watcher's log of match 1 (sent in MATCH_LOG), a player's of match 2.
    const third = run.outcomes['p3'];
    expect(third?.caughtUp.map((c) => c.match)).toEqual(['SERNEW-1']);
    expect(third?.matches.map((m) => m.matchId)).toEqual(['SERNEW-1', 'SERNEW-2']);
    expect(third?.sent['LOG_SIGN']).toBe(1);
    expect(third?.sent['BALL_END']).toBe(2);
  });
});

describe('lobby-long-log', () => {
  it('a log of more than 600 entries reaches a newcomer in pages through the relay double, each far under 256 KB, and ends at the same head', async () => {
    const scenario = loadScenario('lobby-long-log');
    const ids = scenario.players.map((p) => p.playerId);
    const devices = Object.fromEntries(ids.map((id) => [`dev-${id}`, `tok-${id}`]));
    // The server's size limit as it is (256 KB a frame); its rate limit is lifted here and in the transports'
    // pacers, because the test plays 330 balls in a few seconds to make the log, which no real match does.
    const fast = { limit: 1_000_000, windowMs: 10_000 };
    const relay = await startFakeRelay({ devices, hostGraceMs: 5000, rate: fast });
    const optsFor = (id: string) => ({ localId: id, baseUrl: relay.url, auth: { deviceId: `dev-${id}`, deviceToken: `tok-${id}` }, connectTimeoutMs: 2000, ackTimeoutMs: 2000, pace: { ...fast, reserve: 0 } });
    const host = new RelayHostTransport(optsFor('p1'));
    const clients = new Map(ids.slice(1).map((id) => [id, new RelayClientTransport(optsFor(id))]));
    const errors: string[] = [];
    host.onError((e) => errors.push(`p1: ${e.message}`));
    for (const [id, c] of clients) c.onError((e) => errors.push(`${id}: ${e.message}`));
    try {
      await host.host('LONGLG');
      for (const c of clients.values()) await c.connect('LONGLG');
      const transportOf = (id: string): Transport => {
        const t: Transport | undefined = id === 'p1' ? host : clients.get(id);
        if (!t) throw new Error(`no transport for ${id}`);
        return t;
      };
      const run = await runLobbyScenario(scenario, { ballMs: 0, transportOf, timeoutMs: 50_000 });
      checkLobby(run);
      expect(errors).toEqual([]);
      const h = run.outcomes['p1'];
      const late = run.outcomes['p4'];
      const log = h?.matches[0]?.log;
      if (!log) throw new Error('no log');
      expect(log.length).toBeGreaterThan(660);
      // The whole log, sent in pages of 100 to the member who joined near its end.
      const sent = h?.sentLogs[0];
      expect(sent?.playerId).toBe('p4');
      expect(sent?.entries).toBeGreaterThan(600);
      expect(sent?.pages).toBe(Math.ceil((sent?.entries ?? 0) / 100));
      expect(sent?.pages).toBeGreaterThanOrEqual(7);
      expect(late?.caughtUp).toEqual([{ match: 'LONGLG-1', entries: sent?.entries }]);
      expect(late?.matches[0]?.head).toEqual(h?.matches[0]?.head);
      expect(late?.matches[0]?.log?.verifyChain()).toEqual({ ok: true });
      expect(late?.matches[0]?.results.every((r) => r.logMatches && r.signatureValid)).toBe(true);
      // Every RESULT of the series reached the newcomer after the log, the ten that were out before the join among them.
      expect(late?.matches[0]?.results.map((r) => r.result.game)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
      // Nothing was over the relay's limit, and the largest frame (a page) is a quarter of it at most. As ONE frame
      // the same log would not have passed: that is what a RECONNECT_ACK of today is for a log this long.
      expect(relay.dropped.size).toBe(0);
      expect(relay.dropped.rate).toBe(0);
      expect(relay.largest()).toBeLessThan(RELAY_MAX_BYTES / 4);
      const whole = Buffer.byteLength(JSON.stringify(log.entries().slice(0, sent?.entries)), 'utf8');
      expect(whole).toBeGreaterThan(RELAY_MAX_BYTES);
      console.info(`lobby long log: ${sent?.entries} entries in ${sent?.pages} pages, largest frame ${relay.largest()} bytes; as one frame ${whole} bytes (the relay takes ${RELAY_MAX_BYTES})`);
    } finally {
      host.close();
      for (const c of clients.values()) c.close();
      await relay.close();
    }
  }, 60_000);
});
