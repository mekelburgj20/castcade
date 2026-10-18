import { describe, expect, it } from 'vitest';
import { ManualClock, verifyCanonical, logSignBody, type ManualClock as ManualClockType } from '@castcade/companion';
import { collapseReissues, expectedRotation, runLocalScenario, type LocalRun } from './lib.js';
import { loadScenario, SCENARIO_NAMES, type Scenario } from './scenario.js';

function checkExpectations(run: LocalRun): void {
  const { scenario, outcomes } = run;
  const finished = Object.values(outcomes).filter((o) => !o.left && !o.refused);
  expect(finished.length).toBeGreaterThan(0);
  const results = finished.map((o) => o.result);
  for (const r of results) expect(r, 'every participant received RESULT').not.toBeNull();
  const first = results[0];
  if (!first) throw new Error('no result');
  for (const r of results) expect(r).toEqual(first);
  const heads = finished.map((o) => o.logHead);
  for (const h of heads) {
    expect(h.hash).toBe(first.logHash);
    expect(h.length).toBe(first.logLength);
  }
  for (const o of finished) {
    expect(o.resultInfo?.logMatches, `${o.playerId} log matches`).toBe(true);
    expect(o.resultInfo?.signatureValid, `${o.playerId} host signature`).toBe(true);
    expect(o.log.verifyChain()).toEqual({ ok: true });
  }
  const ex = scenario.expect;
  if (ex?.winner !== undefined) expect(first.winner).toBe(ex.winner);
  if (ex?.ranks) for (const [id, rank] of Object.entries(ex.ranks)) expect(first.entries.find((e) => e.playerId === id)?.rank, `rank of ${id}`).toBe(rank);
  if (ex?.statuses) for (const [id, st] of Object.entries(ex.statuses)) expect(first.entries.find((e) => e.playerId === id)?.status, `status of ${id}`).toBe(st);
  if (ex?.hostTransfers !== undefined) expect(first.hostTransfers).toBe(ex.hostTransfers);
  // Every LOG_SIGN verifies against the signer's key over the final head.
  for (const sig of first.signatures) {
    const key = outcomes[sig.playerId]?.publicKey;
    expect(key, `key of ${sig.playerId}`).toBeTruthy();
    expect(sig.logHash).toBe(first.logHash);
    expect(sig.logLength).toBe(first.logLength);
    expect(verifyCanonical(logSignBody(first.matchId, sig.logHash, sig.logLength), sig.signature, key ?? '')).toBe(true);
  }
}

function hostOf(run: LocalRun): string {
  const o = Object.values(run.outcomes).find((x) => x.result && x.rolesHeld[x.rolesHeld.length - 1] === 'host');
  if (!o) throw new Error('no final host');
  return o.playerId;
}

describe('scenario files', () => {
  it('all bundled scenarios load and validate', () => {
    for (const name of SCENARIO_NAMES) {
      const s = loadScenario(name);
      expect(s.name).toBe(name);
    }
  });
});

describe('(a) two-player three-ball', () => {
  it('completes with the plain rotation and p2 winning', async () => {
    const run = await runLocalScenario(loadScenario('two-player-three-ball'));
    checkExpectations(run);
    const grants = run.outcomes['p1']?.issuedGrants ?? [];
    expect(collapseReissues(grants)).toEqual(expectedRotation(['p1', 'p2'], 3));
    expect(grants.map((g) => g.grantSeq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(run.outcomes['p2']?.signed).toBe(true);
    const result = run.outcomes['p1']?.result;
    expect(result?.signatures.map((s) => s.playerId)).toEqual(['p2']);
    expect(result?.entries.map((e) => [e.playerId, e.score, e.ballsPlayed, e.status])).toEqual([
      ['p1', 4000, 3, 'finished'],
      ['p2', 5500, 3, 'finished'],
    ]);
  });
});

describe('(b) four-player with a host transfer', () => {
  it('host_requested: p1 hands over to p2 after its ball 2; grants continue from the handoff', async () => {
    const run = await runLocalScenario(loadScenario('four-player-transfer-requested'));
    checkExpectations(run);
    expect(hostOf(run)).toBe('p2');
    const p1 = run.outcomes['p1'];
    const p2 = run.outcomes['p2'];
    expect(p1?.rolesHeld).toEqual(['host', 'client']);
    expect(p2?.rolesHeld).toEqual(['client', 'host']);
    const all = [...(p1?.issuedGrants ?? []), ...(p2?.issuedGrants ?? [])];
    expect(collapseReissues(all)).toEqual(expectedRotation(['p1', 'p2', 'p3', 'p4'], 3));
    expect(all.length).toBe(13);
    expect(p1?.issuedGrants.map((g) => `${g.player}b${g.ballNumber}`)).toEqual(['p1b1', 'p2b1', 'p3b1', 'p4b1', 'p1b2', 'p2b2']);
    expect(p2?.issuedGrants[0]).toMatchObject({ player: 'p2', ballNumber: 2, grantSeq: 7 });
    expect(p1?.signed).toBe(true); // the old host signs as a client
  });

  it('host_left: p1 drops, p2 proposes itself, is accepted, re-issues the grant and later forfeits p1', async () => {
    const run = await runLocalScenario(loadScenario('four-player-transfer-host-left'));
    checkExpectations(run);
    expect(hostOf(run)).toBe('p2');
    expect(run.outcomes['p1']?.left).toBe(true);
    expect(run.outcomes['p1']?.result).toBeNull();
    const p2 = run.outcomes['p2'];
    expect(p2?.issuedGrants[0]).toMatchObject({ player: 'p2', ballNumber: 2 });
    expect(collapseReissues(p2?.issuedGrants ?? [])).toEqual([
      { player: 'p2', ballNumber: 2 },
      { player: 'p3', ballNumber: 2 },
      { player: 'p4', ballNumber: 2 },
      { player: 'p2', ballNumber: 3 },
      { player: 'p3', ballNumber: 3 },
      { player: 'p4', ballNumber: 3 },
    ]);
    expect(p2?.pauses.some((p) => p.reason === 'disconnect' && p.player === 'p1')).toBe(true);
    const result = p2?.result;
    expect(result?.entries.find((e) => e.playerId === 'p1')).toMatchObject({ status: 'disconnected', ballsPlayed: 2, score: 2000, rank: 4 });
    expect(result?.signatures.map((s) => s.playerId).sort()).toEqual(['p3', 'p4']);
  });
});

describe('(c) fingerprint mismatch', () => {
  it('refuses p2 naming tableHash and both values; the others play on', async () => {
    const run = await runLocalScenario(loadScenario('fingerprint-mismatch'));
    const refused = run.outcomes['p2']?.refused;
    expect(refused?.code).toBe('fingerprint_mismatch');
    expect(refused?.mismatches).toEqual([{ field: 'tableHash', expected: 'ab'.repeat(32), received: 'ff'.repeat(32), expectedFrom: 'p1' }]);
    expect(run.outcomes['p2']?.result).toBeNull();
    checkExpectations(run);
    expect(run.outcomes['p1']?.result?.entries.map((e) => e.playerId)).toEqual(['p1', 'p3']);
  });
});

describe('(d) BALL_END from a non-holder', () => {
  it('is rejected (not_grant_holder / stale_grant) and changes nothing', async () => {
    const run = await runLocalScenario(loadScenario('rogue-ball-end'));
    checkExpectations(run);
    const codes = run.outcomes['p3']?.rejects.map((r) => r.code).sort();
    expect(codes).toEqual(['not_grant_holder', 'stale_grant']);
    for (const r of run.outcomes['p3']?.rejects ?? []) expect(r.refType).toBe('BALL_END');
    const grants = run.outcomes['p1']?.issuedGrants ?? [];
    expect(collapseReissues(grants)).toEqual(expectedRotation(['p1', 'p2', 'p3'], 2));
    expect(grants.length).toBe(6);
  });
});

describe('(e) silent client', () => {
  it('triggers PAUSE(ball_end_timeout) on the fake clock; RESUME re-grants the same ball with a new seq', async () => {
    const clock = new ManualClock();
    const scenario: Scenario = loadScenario('silent-client-pause');
    let silentSeen = 0;
    const run = await runLocalScenario(scenario, {
      clock,
      hooks: {
        onSilent: () => {
          silentSeen += 1;
          setTimeout(() => (clock as ManualClockType).advance(scenario.ballEndTimeoutMs ?? 0), 0);
        },
      },
    });
    checkExpectations(run);
    expect(silentSeen).toBe(1);
    const host = run.outcomes['p1'];
    expect(host?.pauses).toEqual([{ reason: 'ball_end_timeout', player: 'p2' }]);
    const grants = host?.issuedGrants ?? [];
    expect(grants.map((g) => `${g.player}b${g.ballNumber}#${g.grantSeq}`)).toEqual(['p1b1#1', 'p2b1#2', 'p2b1#3', 'p1b2#4', 'p2b2#5']);
    // PAUSE and RESUME are in every log.
    const types = host?.log.entries().map((e) => e.message?.type ?? e.event?.type);
    expect(types).toContain('PAUSE');
    expect(types).toContain('RESUME');
  });
});

describe('(f) extra ball', () => {
  it('re-grants the same player and ball after shootAgain', async () => {
    const run = await runLocalScenario(loadScenario('extra-ball'));
    checkExpectations(run);
    const grants = run.outcomes['p1']?.issuedGrants ?? [];
    expect(grants.map((g) => `${g.player}b${g.ballNumber}`)).toEqual(['p1b1', 'p2b1', 'p1b2', 'p1b2', 'p2b2', 'p1b3', 'p2b3']);
    const ballEnds = run.outcomes['p1']?.log.entries().filter((e) => e.message?.type === 'BALL_END') ?? [];
    const p1b2 = ballEnds.filter((e) => e.from === 'p1' && e.message?.type === 'BALL_END' && e.message.payload.ballNumber === 2);
    expect(p1b2.map((e) => (e.message?.type === 'BALL_END' ? e.message.payload.shootAgain : null))).toEqual([true, false]);
    expect(run.outcomes['p1']?.result?.entries.find((e) => e.playerId === 'p1')?.score).toBe(6000);
  });
});

describe('GAME_OVER before the last ball', () => {
  it('ends that game early, the rotation skips it, and a tie yields winner null', async () => {
    const run = await runLocalScenario(loadScenario('game-over-early'));
    checkExpectations(run);
    const grants = run.outcomes['p1']?.issuedGrants ?? [];
    expect(grants.map((g) => `${g.player}b${g.ballNumber}`)).toEqual(['p1b1', 'p2b1', 'p1b2', 'p1b3']);
    expect(run.outcomes['p1']?.result?.entries.find((e) => e.playerId === 'p2')).toMatchObject({ score: 3000, ballsPlayed: 1, status: 'finished', rank: 1 });
  });
});
