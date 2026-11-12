/**
 * D10.8 gate (2026-11-12): a whole match through the relay. The host owns a relay room, three clients join it by code,
 * and the engines run a 4-player 5-ball match over the in-process fake relay (the ArcAid contract). Mid-match the
 * host's socket to the relay is cut from the server side: the host's links close, it takes its room back, tells the
 * clients to relink, each resumes with RECONNECT from its log head, and the match ends with the same hash chain
 * everywhere. The fake applies the contract's limits (256 KB, 200 per 10 s): nothing may be dropped by them.
 */
import { describe, expect, it } from 'vitest';
import { RelayClientTransport, RelayHostTransport, type Transport } from '@castcade/companion';
import { startFakeRelay } from '../../companion/src/match/relay-fake.test-support.js';
import { collapseReissues, expectedRotation, FakePlayer } from './lib.js';
import { generateScenario } from './scenario.js';

describe('D10.8: a match through the relay', () => {
  it('4 players, 5 balls, the host loses the relay for a moment mid-match: everyone resumes by RECONNECT and the logs agree', async () => {
    const scenario = generateScenario({ players: 4, ballsPerGame: 5, matchId: 'RELAYB' });
    scenario.hostPolicy = { onDisconnect: 'wait' };
    const ids = scenario.players.map((p) => p.playerId);
    const devices = Object.fromEntries(ids.map((id) => [`dev-${id}`, `tok-${id}`]));
    const relay = await startFakeRelay({ devices, hostGraceMs: 5000 });
    const optsFor = (id: string) => ({ localId: id, baseUrl: relay.url, auth: { deviceId: `dev-${id}`, deviceToken: `tok-${id}` }, connectTimeoutMs: 2000, ackTimeoutMs: 2000 });
    const host = new RelayHostTransport(optsFor('p1'));
    const clients = new Map(ids.slice(1).map((id) => [id, new RelayClientTransport(optsFor(id))]));
    const errors: string[] = [];
    host.onError((e) => errors.push(`p1: ${e.message}`));
    for (const [id, c] of clients) c.onError((e) => errors.push(`${id}: ${e.message}`));
    const seen: { player: string; event: string; payload: unknown }[] = [];
    let dropped = false;
    try {
      await host.host('RELAYB');
      for (const c of clients.values()) await c.connect('RELAYB');
      const fakes = scenario.players.map((script) => {
        const transport: Transport | undefined = script.playerId === 'p1' ? host : clients.get(script.playerId);
        if (!transport) throw new Error('no transport');
        return new FakePlayer({
          role: script.playerId === 'p1' ? 'host' : 'client',
          transport,
          script,
          scenario,
          expectedJoins: ids.length - 1,
          reconnect: { delayMs: 100, attempts: 40 },
          hooks: {
            onEvent: (player, event, payload) => seen.push({ player, event, payload }),
            onGrant: (grant) => {
              // On the host's own ball: a scripted client whose grant crosses its drop plays that ball inside the pause.
              if (dropped || grant.player !== 'p1' || grant.ballNumber !== 3) return;
              dropped = true;
              relay.dropDevice('dev-p1');
            },
          },
        });
      });
      for (const f of fakes) f.start();
      let timer: ReturnType<typeof setTimeout> | null = null;
      const guard = new Promise<never>((_, reject) => {
        const trace = (): string =>
          seen
            .filter((e) => !['state', 'grant', 'ballEnd', 'ballEndAccepted'].includes(e.event))
            .slice(-40)
            .map((e) => `${e.player} ${e.event} ${(JSON.stringify(e.payload) ?? '').slice(0, 90)}`)
            .join('\n');
        // The whole scripted match is inside one rate window; with a bucket per destination the host stays under it.
        timer = setTimeout(() => reject(new Error(`timed out\n${trace()}\n${errors.join('\n')}`)), 25_000);
      });
      const list = await Promise.race([Promise.all(fakes.map((f) => f.done)), guard]).finally(() => timer && clearTimeout(timer));
      const outcomes = Object.fromEntries(list.map((o) => [o.playerId, o]));

      expect(dropped).toBe(true);
      // Every client came back by RECONNECT, none by a fresh HELLO, none rejected.
      for (const id of ids.slice(1)) {
        expect(outcomes[id]?.reconnects.length, `${id} reconnects`).toBeGreaterThanOrEqual(1);
        expect(outcomes[id]?.reconnectRejected).toBeNull();
      }
      expect(seen.filter((e) => e.event === 'refused')).toEqual([]);
      expect(seen.filter((e) => e.event === 'desync')).toEqual([]);

      // Same chain everywhere, same RESULT, everyone finished, the rotation unchanged.
      const result = outcomes['p1']?.result;
      if (!result) throw new Error('no RESULT');
      for (const id of ids) {
        expect(outcomes[id]?.result).toEqual(result);
        expect(outcomes[id]?.logHead).toEqual({ hash: result.logHash, length: result.logLength });
        expect(outcomes[id]?.log.verifyChain()).toEqual({ ok: true });
        expect(outcomes[id]?.resultInfo).toEqual({ logMatches: true, signatureValid: true });
      }
      expect(result.entries.map((e) => e.status)).toEqual(['finished', 'finished', 'finished', 'finished']);
      expect(collapseReissues(outcomes['p1']?.issuedGrants ?? [])).toEqual(expectedRotation(ids, 5));

      // The contract's limits were never met: nothing over 256 KB, nothing dropped for rate.
      expect(relay.dropped.size).toBe(0);
      expect(relay.dropped.rate).toBe(0);
      // The whole log of this match as one frame (the worst RECONNECT_ACK there could be) is far under the cap.
      const wholeLog = Buffer.byteLength(JSON.stringify(outcomes['p1']?.log.entries() ?? []), 'utf8');
      expect(wholeLog).toBeLessThan(128 * 1024);
      expect(relay.largest()).toBeLessThan(64 * 1024);
      console.info(`relay gate: ${result.logLength} log entries, whole log ${wholeLog} bytes, largest frame ${relay.largest()} bytes, relayed per device ${JSON.stringify([...relay.relayed])}`);
    } finally {
      host.close();
      for (const c of clients.values()) c.close();
      await relay.close();
    }
  }, 40_000);
});
