/**
 * A3 gate (2026-10-30): a client's socket is killed mid-match over real WebSockets on localhost.
 * It reconnects to the host with RECONNECT from its log head (never a fresh HELLO), receives the
 * entries it missed, RESUMEs the pause its drop caused, and the match runs to a RESULT with the
 * same hash chain everywhere. A client whose log head the host does not hold is rejected, and its
 * fresh HELLO is then refused because the roster is final.
 */
import { describe, expect, it } from 'vitest';
import { ClientMatch, generateKeys, HostMatch, WsPeerTransport } from '@castcade/companion';
import type { PayloadOf } from '@castcade/protocol';
import { collapseReissues, expectedRotation, runWsScenario, type FakePlayer } from './lib.js';
import { defaultFingerprint, generateScenario } from './scenario.js';

describe('A3: client reconnect after a drop', () => {
  it('p3 loses its socket while p2 plays ball 2, resumes from its log head, gets the missed entries, the match finishes', async () => {
    const started = Date.now();
    const scenario = generateScenario({ players: 3, ballsPerGame: 3, matchId: 'WS-RECON-1' });
    scenario.hostPolicy = { onDisconnect: 'wait' };
    const ids = scenario.players.map((p) => p.playerId);
    const transports = new Map(ids.map((id) => [id, new WsPeerTransport({ localId: id })]));
    const seen: { player: string; event: string; payload: unknown }[] = [];
    let dropped = false;
    try {
      const run = await runWsScenario(scenario, transports, {
        reconnect: { delayMs: 100, attempts: 20 },
        hooks: {
          onEvent: (player, event, payload) => seen.push({ player, event, payload }),
          onGrant: (grant) => {
            if (dropped || grant.player !== 'p2' || grant.ballNumber !== 2) return;
            dropped = true;
            transports.get('p3')?.dropLinks('p1');
          },
        },
      });
      const { outcomes } = run;
      expect(dropped).toBe(true);

      // p3 came back once, by RECONNECT, and was sent the entries it missed (at least the pause).
      const p3 = outcomes['p3'];
      expect(p3?.reconnects).toHaveLength(1);
      expect(p3?.reconnects[0]).toBeGreaterThan(0);
      expect(p3?.reconnectRejected).toBeNull();
      expect(seen.filter((e) => e.event === 'refused')).toEqual([]); // no fresh HELLO reached the host
      expect(seen.filter((e) => e.player === 'p1' && e.event === 'reconnected').map((e) => (e.payload as { playerId: string }).playerId)).toEqual(['p3']);
      expect(seen.filter((e) => e.event === 'desync')).toEqual([]);

      // The drop paused the match; p3 resumed it itself.
      const types = (outcomes['p1']?.log.entries() ?? []).map((e) => (e.message ? `${e.message.type}:${e.message.from}` : e.event?.type));
      expect(types).toContain('PAUSE:p1');
      expect(types).toContain('RESUME:p3');
      const pause = outcomes['p1']?.log.entries().find((e) => e.message?.type === 'PAUSE')?.message;
      expect(pause?.payload).toEqual({ reason: 'disconnect', player: 'p3' });

      // Same chain everywhere, same RESULT, everyone finished, rotation unchanged.
      const result = outcomes['p1']?.result;
      if (!result) throw new Error('no RESULT');
      for (const id of ids) {
        expect(outcomes[id]?.result).toEqual(result);
        expect(outcomes[id]?.logHead).toEqual({ hash: result.logHash, length: result.logLength });
        expect(outcomes[id]?.log.verifyChain()).toEqual({ ok: true });
        expect(outcomes[id]?.resultInfo).toEqual({ logMatches: true, signatureValid: true });
      }
      expect(result.entries.map((e) => e.status)).toEqual(['finished', 'finished', 'finished']);
      expect(result.winner).toBe('p3');
      expect(result.signatures.map((s) => s.playerId).sort()).toEqual(['p2', 'p3']);
      expect(collapseReissues(outcomes['p1']?.issuedGrants ?? [])).toEqual(expectedRotation(ids, 3));
      expect([...new Set(transports.get('p1')?.inboundPeers())].sort()).toEqual(['p2', 'p3']);
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      for (const t of transports.values()) t.close();
    }
  });

  it('an unknown log hash is rejected; the fresh HELLO that would follow is refused (match_started)', async () => {
    const scenario = generateScenario({ players: 3, ballsPerGame: 2, matchId: 'WS-RECON-2' });
    const ids = scenario.players.map((p) => p.playerId);
    const transports = new Map(ids.map((id) => [id, new WsPeerTransport({ localId: id })]));
    let fakes: FakePlayer[] = [];
    let dropped = false;
    const rejectedAtHost: unknown[] = [];
    const extra = new WsPeerTransport({ localId: 'p3' });
    try {
      const run = await runWsScenario(scenario, transports, {
        reconnect: { delayMs: 50, attempts: 20 },
        players: (list) => {
          fakes = list;
          // Listen on the host engine itself, not the FakePlayer trace: with p3 forfeited the match
          // can reach RESULT before p3's first RECONNECT (one delayMs after the drop) lands, and a
          // finished FakePlayer detaches its listeners, while the host still answers that RECONNECT.
          const host = list.find((f) => f.playerId === 'p1')?.engine;
          if (!(host instanceof HostMatch)) throw new Error('p1 is not the host');
          host.on('reconnectRejected', (payload) => rejectedAtHost.push(payload));
        },
        hooks: {
          onGrant: (grant) => {
            if (dropped || grant.player !== 'p2' || grant.ballNumber !== 1) return;
            dropped = true;
            transports.get('p3')?.dropLinks('p1');
            // Fork p3's log while it is away: its head is now a hash the host never held.
            const log = fakes.find((f) => f.playerId === 'p3')?.engine?.log;
            log?.append({ ts: 1, kind: 'event', from: 'p3', event: { type: 'host_transfer', reason: 'host_left', proposer: 'p3', from: 'p1', to: 'p3', newHostPublicKey: generateKeys().publicKeyB64 } });
          },
        },
      });
      const { outcomes } = run;
      expect(outcomes['p3']?.reconnectRejected).toBe('unknown_log_hash');
      expect(outcomes['p3']?.reconnects).toEqual([]);
      expect(outcomes['p3']?.result).toBeNull();
      expect(rejectedAtHost).toEqual([{ playerId: 'p3', code: 'unknown_log_hash' }]);

      // The others finish without p3 (forfeited while disconnected), with agreeing logs.
      const result = outcomes['p1']?.result;
      if (!result) throw new Error('no RESULT');
      expect(outcomes['p2']?.result).toEqual(result);
      expect(outcomes['p2']?.logHead).toEqual(outcomes['p1']?.logHead);
      expect(result.entries.find((e) => e.playerId === 'p3')?.status).toBe('disconnected');

      // Re-joining takes a fresh HELLO; the roster is final, so it is refused.
      const endpoint = run.endpoints.get('p1');
      if (!endpoint) throw new Error('no host endpoint');
      await extra.connect(endpoint);
      const keys = generateKeys();
      const fresh = new ClientMatch({
        transport: extra,
        keys,
        participant: { playerId: 'p3', displayName: 'Player 3', publicKey: keys.publicKeyB64, rig: 'pc' },
        game: defaultFingerprint,
        throwdownCode: scenario.matchId,
      });
      const refused = new Promise<PayloadOf<'REFUSE'>>((resolve) => fresh.on('refused', resolve));
      fresh.join();
      expect((await refused).code).toBe('match_started');
    } finally {
      extra.close();
      for (const t of transports.values()) t.close();
    }
  });
});
