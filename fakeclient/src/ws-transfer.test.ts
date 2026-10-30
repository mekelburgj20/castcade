/**
 * A2 gate (2026-10-30): host transfer over real WebSockets on localhost. A host and its clients,
 * each a WsPeerTransport with its own ephemeral listener, play a 3-ball match; the host hands over
 * to p2 by force (host_requested after its own ball 2); everyone else, the old host included,
 * reconnects to p2's listener with RECONNECT from its log head, never a fresh HELLO; every log
 * agrees end to end and the match ends in a RESULT signed by the new host.
 */
import { describe, expect, it } from 'vitest';
import { logSignBody, verifyCanonical, WsPeerTransport } from '@castcade/companion';
import { collapseReissues, expectedRotation, runWsScenario } from './lib.js';
import { generateScenario } from './scenario.js';

describe('A2: host transfer over WebSocket', () => {
  for (const players of [3, 4]) {
    it(`${players} players: p1 hands over to p2 by force, everyone reconnects to p2, logs agree, signed RESULT`, async () => {
      const started = Date.now();
      const scenario = generateScenario({ players, ballsPerGame: 3, matchId: `WS-XFER-${players}`, transfer: 'host_requested' });
      const ids = scenario.players.map((p) => p.playerId);
      const transports = new Map(ids.map((id) => [id, new WsPeerTransport({ localId: id })]));
      try {
        const seen: { player: string; event: string; payload: unknown }[] = [];
        const run = await runWsScenario(scenario, transports, { hooks: { onEvent: (player, event, payload) => seen.push({ player, event, payload }) } });
        const { outcomes, endpoints } = run;
        const events = (name: string) => seen.filter((e) => e.event === name);

        // Everyone but the new host resumed with one accepted RECONNECT; nothing was rejected,
        // failed, forked or counted as a disconnect, and no match was paused.
        for (const id of ids) expect(outcomes[id]?.reconnects.length, `${id} reconnects`).toBe(id === 'p2' ? 0 : 1);
        for (const name of ['reconnectRejected', 'reconnectFailed', 'desync', 'peerLeft', 'pause']) expect(events(name), name).toEqual([]);
        // A client that was not linked to p2 when it committed got the commit event in its RECONNECT_ACK.
        for (const id of ids.filter((x) => x !== 'p1' && x !== 'p2')) expect(outcomes[id]?.reconnects[0], `${id} entries`).toBeGreaterThan(0);

        // Roles moved once, in both directions.
        expect(outcomes['p1']?.rolesHeld).toEqual(['host', 'client']);
        expect(outcomes['p2']?.rolesHeld).toEqual(['client', 'host']);

        // Topology after the move: the old host's listener is closed and every other participant
        // is linked in to the new host's listener.
        expect(transports.get('p1')?.endpoint).toBeNull();
        expect([...new Set(transports.get('p2')?.inboundPeers())].sort()).toEqual(ids.filter((id) => id !== 'p2'));

        // The hash chain is intact end to end and identical everywhere.
        const result = outcomes['p2']?.result;
        if (!result) throw new Error('no RESULT at the new host');
        for (const id of ids) {
          const o = outcomes[id];
          expect(o?.result, `${id} RESULT`).toEqual(result);
          expect(o?.logHead).toEqual({ hash: result.logHash, length: result.logLength });
          expect(o?.log.verifyChain()).toEqual({ ok: true });
          expect(o?.resultInfo).toEqual({ logMatches: true, signatureValid: true });
          // The transfer is one HOST_TRANSFER entry (carrying p2's listener) and one commit event.
          const entries = o?.log.entries() ?? [];
          const proposals = entries.filter((e) => e.message?.type === 'HOST_TRANSFER');
          expect(proposals).toHaveLength(1);
          const proposal = proposals[0]?.message;
          expect(proposal?.type === 'HOST_TRANSFER' ? proposal.payload.newHostEndpoint : null).toBe(endpoints.get('p2'));
          const commits = entries.filter((e) => e.kind === 'event');
          expect(commits).toHaveLength(1);
          expect(commits[0]?.event).toMatchObject({ type: 'host_transfer', reason: 'host_requested', from: 'p1', to: 'p2' });
          expect(commits[0]?.index).toBe((proposals[0]?.index ?? -2) + 1);
        }
        const p1Log = outcomes['p1']?.log.entries() ?? [];
        for (const id of ids) expect(outcomes[id]?.log.entries().map((e) => e.hash)).toEqual(p1Log.map((e) => e.hash));

        // Rotation continues from the handoff: one re-issued grant, signed by the new host.
        const issued = [...(outcomes['p1']?.issuedGrants ?? []), ...(outcomes['p2']?.issuedGrants ?? [])];
        expect(collapseReissues(issued)).toEqual(expectedRotation(ids, 3));
        expect(issued).toHaveLength(ids.length * 3 + 1);
        expect(outcomes['p2']?.issuedGrants[0]).toMatchObject({ player: 'p2', ballNumber: 2 });

        // RESULT: signed by the new host, every other participant's LOG_SIGN verifies.
        expect(result.hostTransfers).toBe(1);
        const body = logSignBody(result.matchId, result.logHash, result.logLength);
        expect(verifyCanonical(body, result.hostSignature, outcomes['p2']?.publicKey ?? '')).toBe(true);
        expect(result.signatures.map((s) => s.playerId).sort()).toEqual(ids.filter((id) => id !== 'p2'));
        for (const s of result.signatures) expect(verifyCanonical(body, s.signature, outcomes[s.playerId]?.publicKey ?? '')).toBe(true);
        expect(result.winner).toBe(ids[ids.length - 1]);

        expect(Date.now() - started).toBeLessThan(5_000);
      } finally {
        for (const t of transports.values()) t.close();
      }
    });
  }
});
