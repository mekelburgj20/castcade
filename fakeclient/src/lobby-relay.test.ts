/**
 * A17 step 6 (2026-11-25): a lobby through the relay, and the relay gone for a moment (design §11.8: "ArcAid for a
 * moment, which is the lobby's PC losing it"). The lobby's PC owns a relay room, two clients join it by code, a
 * client asks for the match, and in the middle of a ball the socket of the lobby's PC is cut from the server side:
 * every member's link to it closes at once. Nobody is at fault and nobody is paused: the lobby's PC says it is cut
 * off (`setCutOff`, wired here to the transport's state as the shell will wire it), takes its room back, the
 * members return by RECONNECT in the lobby's form, and the match is played out with one log on every PC.
 */
import { describe, expect, it } from 'vitest';
import { RelayClientTransport, RelayHostTransport, type Transport } from '@castcade/companion';
import { startFakeRelay } from '../../companion/src/match/relay-fake.test-support.js';
import { lobbyProblems, runLobbyScenario } from './lobby.js';
import { loadScenario } from './scenario.js';

describe('A17 step 6: a lobby through the relay', () => {
  it('in a lobby a relay drop during a ball pauses nobody: the members come back by RECONNECT and the logs agree', async () => {
    const scenario = { ...loadScenario('lobby-start-by-client'), matchId: 'RELAYL' };
    const ids = scenario.players.map((p) => p.playerId);
    const devices = Object.fromEntries(ids.map((id) => [`dev-${id}`, `tok-${id}`]));
    const relay = await startFakeRelay({ devices, hostGraceMs: 5000 });
    const optsFor = (id: string) => ({ localId: id, baseUrl: relay.url, auth: { deviceId: `dev-${id}`, deviceToken: `tok-${id}` }, connectTimeoutMs: 2000, ackTimeoutMs: 2000 });
    const host = new RelayHostTransport(optsFor('p1'));
    const clients = new Map(ids.slice(1).map((id) => [id, new RelayClientTransport(optsFor(id))]));
    const errors: string[] = [];
    host.onError((e) => errors.push(`p1: ${e.message}`));
    for (const [id, c] of clients) c.onError((e) => errors.push(`${id}: ${e.message}`));
    const seen: string[] = [];
    let dropped = false;
    let cutOffs = 0;
    try {
      await host.host('RELAYL');
      for (const c of clients.values()) await c.connect('RELAYL');
      const run = await runLobbyScenario(scenario, {
        transportOf: (id): Transport => {
          const t: Transport | undefined = id === 'p1' ? host : clients.get(id);
          if (!t) throw new Error(`no transport for ${id}`);
          return t;
        },
        reconnect: { delayMs: 100 },
        timeoutMs: 30_000,
        onPlayers: (players) => {
          const engine = players.find((p) => p.playerId === 'p1')?.host;
          // What the shell does with `relay.onState`: while the lobby's PC is off ArcAid, the drops are its own.
          host.onState((s) => {
            if (s === 'reconnecting') cutOffs += 1;
            engine?.setCutOff(s === 'reconnecting');
          });
        },
        onEvent: (player, event, payload) => {
          if (['peerLeft', 'pause', 'forfeit', 'reconnected', 'reconnectRejected', 'rejoining', 'refused'].includes(event)) seen.push(`${player} ${event}`);
          // In the middle of the first game, on the asker's own ball.
          if (player === 'p1' && event === 'ready' && !dropped) {
            dropped = true;
            setTimeout(() => relay.dropDevice('dev-p1'), 1);
          }
          if (process.env['LOBBY_DEBUG']) console.info(player, event, JSON.stringify(payload)?.slice(0, 200));
        },
      });
      expect(dropped).toBe(true);
      expect(cutOffs).toBeGreaterThanOrEqual(1);
      expect(lobbyProblems(run)).toEqual([]);
      expect(errors.filter((e) => !/closed|connection to ArcAid/.test(e))).toEqual([]);
      // Nobody was paused, forfeited, refused or made to join again; on the lobby's PC nobody was ever told to have left.
      for (const id of ids) expect(run.outcomes[id]?.pauses, id).toEqual([]);
      expect(seen.filter((e) => /pause|forfeit|refused|rejoining|reconnectRejected/.test(e))).toEqual([]);
      expect(seen.filter((e) => e === 'p1 peerLeft')).toEqual([]);
      // Both members came back by RECONNECT, quietly, into the same match.
      expect([...(run.outcomes['p1']?.reconnects ?? [])].sort()).toEqual(['p2 quiet', 'p3 quiet']);
      expect(run.outcomes['p2']?.reconnects.length).toBe(1);
      expect(run.outcomes['p3']?.reconnects.length).toBe(1);
      const m = run.outcomes['p1']?.matches[0];
      expect(m?.ready.playerOrder).toEqual(['p2', 'p1']);
      expect(m?.results.map((r) => r.result.entries.map((e) => e.status))).toEqual([
        ['finished', 'finished'],
        ['finished', 'finished'],
      ]);
      expect(m?.log?.entries().filter((e) => e.message?.type === 'PAUSE')).toEqual([]);
      expect(relay.dropped.size).toBe(0);
      expect(relay.dropped.rate).toBe(0);
    } finally {
      host.close();
      for (const c of clients.values()) c.close();
      await relay.close();
    }
  }, 40_000);
});
