/**
 * Phase 1 gate: four fake clients complete a 3-ball match with correct rotation, one forced host
 * transfer, and matching log hashes (fakeclient/README.md).
 */
import { describe, expect, it } from 'vitest';
import { logSignBody, verifyCanonical } from '@castcade/companion';
import { collapseReissues, expectedRotation, runLocalScenario } from './lib.js';
import { loadScenario } from './scenario.js';

describe('Phase 1 gate', () => {
  it('4 players, 3 balls, one host_requested transfer, identical logs, verified signatures, correct ranks', async () => {
    const started = Date.now();
    const scenario = loadScenario('four-player-transfer-requested');
    const run = await runLocalScenario(scenario, { ballMs: 5, timeoutMs: 10_000 });
    const elapsed = Date.now() - started;
    const { outcomes } = run;
    const ids = ['p1', 'p2', 'p3', 'p4'];

    // (1) Rotation: p1b1, p2b1, p3b1, p4b1, p1b2, ..., p4b3; 12 distinct grants plus one re-issue.
    const issued = [...(outcomes['p1']?.issuedGrants ?? []), ...(outcomes['p2']?.issuedGrants ?? [])];
    expect(collapseReissues(issued)).toEqual(expectedRotation(ids, 3));
    expect(issued).toHaveLength(13);
    const reissue = issued.filter((g, i) => i > 0 && issued[i - 1]?.player === g.player && issued[i - 1]?.ballNumber === g.ballNumber);
    expect(reissue).toHaveLength(1);
    expect(reissue[0]).toMatchObject({ player: 'p2', ballNumber: 2 });
    for (let i = 1; i < issued.length; i++) expect(issued[i]?.grantSeq).toBeGreaterThan(issued[i - 1]?.grantSeq ?? Infinity);
    // The re-issued grant was signed by the new host, the earlier ones by the old host.
    const oldHostGrants = outcomes['p1']?.issuedGrants ?? [];
    expect(oldHostGrants).toHaveLength(6);
    expect(outcomes['p2']?.issuedGrants).toHaveLength(7);

    // (2) Every participant's final log head agrees.
    const heads = ids.map((id) => outcomes[id]?.logHead);
    for (const h of heads) {
      expect(h?.hash).toBe(heads[0]?.hash);
      expect(h?.length).toBe(heads[0]?.length);
    }
    for (const id of ids) expect(outcomes[id]?.log.verifyChain()).toEqual({ ok: true });
    const transferEvents = outcomes['p3']?.log.entries().filter((e) => e.kind === 'event') ?? [];
    expect(transferEvents).toHaveLength(1);
    expect(transferEvents[0]?.event).toMatchObject({ type: 'host_transfer', reason: 'host_requested', from: 'p1', to: 'p2' });

    // (3) RESULT: one transfer, every signature verifies, ranks follow the scripted scores.
    const result = outcomes['p2']?.result;
    expect(result).not.toBeNull();
    if (!result) throw new Error('no result');
    for (const id of ids) expect(outcomes[id]?.result).toEqual(result);
    expect(result.hostTransfers).toBe(1);
    expect(result.logHash).toBe(heads[0]?.hash);
    expect(result.logLength).toBe(heads[0]?.length);
    const body = logSignBody(result.matchId, result.logHash, result.logLength);
    expect(verifyCanonical(body, result.hostSignature, outcomes['p2']?.publicKey ?? '')).toBe(true);
    expect(verifyCanonical(body, result.hostSignature, outcomes['p1']?.publicKey ?? '')).toBe(false);
    expect(result.signatures.map((s) => s.playerId).sort()).toEqual(['p1', 'p3', 'p4']);
    for (const s of result.signatures) expect(verifyCanonical(body, s.signature, outcomes[s.playerId]?.publicKey ?? '')).toBe(true);
    const byId = Object.fromEntries(result.entries.map((e) => [e.playerId, e]));
    expect(byId['p3']).toMatchObject({ score: 12000, rank: 1, ballsPlayed: 3, status: 'finished' });
    expect(byId['p4']).toMatchObject({ score: 8000, rank: 2 });
    expect(byId['p1']).toMatchObject({ score: 3000, rank: 3 });
    expect(byId['p2']).toMatchObject({ score: 3000, rank: 3 });
    expect(result.winner).toBe('p3');
    for (const id of ids) expect(outcomes[id]?.resultInfo).toEqual({ logMatches: true, signatureValid: true });

    // (4) Fast.
    expect(elapsed).toBeLessThan(5_000);
  });
});
