/**
 * A18 (2026-11-24, the owner: "We never want another player's disconnect to cause the active player to have a messed
 * up session"): the cases of a dropped link in a three-player match (p1 hosts; the order is p1, p2, p3) over real
 * WebSockets on localhost, each with scripted players. `ws-reconnect.test.ts` has the first two (a waiting client
 * drops while another client's ball is live, with no grace and inside it); here:
 *
 * - the host is up and a client drops;
 * - a client is up and the host's own links all drop, so every client looks dropped at once (what a relay drop on
 *   the host's side is), with no grace and inside it;
 * - the player who is up is the one who drops, with its ball still live when it is back, and with its ball over
 *   before it is back (the ball end it reported into the dead link).
 *
 * A scripted player has no table, lock or picture: "its turn is untouched" here means the engine sent it nothing for
 * the drop while its ball was live (no PAUSE, no second grant), it reported that ball once, and nothing was rejected.
 */
import { describe, expect, it } from 'vitest';
import { WsPeerTransport } from '@castcade/companion';
import type { GrantBody } from '@castcade/protocol';
import { collapseReissues, expectedRotation, runWsScenario, type FakePlayerOutcome } from './lib.js';
import { generateScenario } from './scenario.js';

interface Seen {
  player: string;
  event: string;
  payload: unknown;
}

/**
 * Three players, three balls. At the grant `at` names, `drop` kills links; every client then retries every `retryMs`.
 * `ballMs`: how long a scripted ball takes (60 ms: over before the player is back; 250 ms: still live when it is).
 */
async function run(o: {
  id: string;
  at: { player: string; ball: number };
  drop: (transports: Map<string, WsPeerTransport>) => void;
  graceMs: number;
  retryMs: number;
  ballMs: number;
}): Promise<{ outcomes: Record<string, FakePlayerOutcome>; seen: Seen[]; types: string[]; ids: string[]; grants: GrantBody[] }> {
  const scenario = generateScenario({ players: 3, ballsPerGame: 3, matchId: o.id });
  scenario.hostPolicy = { onDisconnect: 'wait' };
  const ids = scenario.players.map((p) => p.playerId);
  const transports = new Map(ids.map((id) => [id, new WsPeerTransport({ localId: id })]));
  const seen: Seen[] = [];
  let dropped = false;
  try {
    const r = await runWsScenario(scenario, transports, {
      reconnect: { delayMs: o.retryMs, attempts: 40 },
      disconnectGraceMs: o.graceMs,
      ballMs: o.ballMs,
      timeoutMs: 15_000,
      hooks: {
        onEvent: (player, event, payload) => seen.push({ player, event, payload }),
        onGrant: (grant) => {
          if (dropped || grant.player !== o.at.player || grant.ballNumber !== o.at.ball) return;
          dropped = true;
          // After the grant is on the wire: the drop falls inside that player's ball.
          setTimeout(() => o.drop(transports), 20);
        },
      },
    });
    expect(dropped).toBe(true);
    const outcomes = r.outcomes;
    const result = outcomes['p1']?.result;
    if (!result) throw new Error('no RESULT');
    // However the drop went: one chain everywhere, one RESULT, everyone finished, the rotation as scripted.
    for (const id of ids) {
      expect(outcomes[id]?.result, `${id} RESULT`).toEqual(result);
      expect(outcomes[id]?.logHead, `${id} log head`).toEqual({ hash: result.logHash, length: result.logLength });
      expect(outcomes[id]?.log.verifyChain()).toEqual({ ok: true });
      expect(outcomes[id]?.rejects, `${id} rejects`).toEqual([]);
    }
    expect(result.entries.map((e) => e.status)).toEqual(['finished', 'finished', 'finished']);
    expect(seen.filter((e) => e.event === 'desync' || e.event === 'reconnectRejected' || e.event === 'refused')).toEqual([]);
    const grants = outcomes['p1']?.issuedGrants ?? [];
    expect(collapseReissues(grants)).toEqual(expectedRotation(ids, 3));
    const types = (outcomes['p1']?.log.entries() ?? []).map((e) => (e.message ? `${e.message.type}:${e.message.from}` : (e.event?.type ?? '?')));
    return { outcomes, seen, types, ids, grants };
  } finally {
    for (const t of transports.values()) t.close();
  }
}

/** How often the host issued the grant for that player's ball (2 or more: it was issued again after a RESUME). */
const issued = (grants: GrantBody[], player: string, ball: number): number => grants.filter((g) => g.player === player && g.ballNumber === ball).length;
/** That player's BALL_ENDs for a ball in the host's log. */
const ballEnds = (o: Record<string, FakePlayerOutcome>, player: string, ball: number): number =>
  (o['p1']?.log.entries() ?? []).filter((e) => e.message?.type === 'BALL_END' && e.from === player && e.message.payload.ballNumber === ball).length;

describe('A18: a dropped link in a three-player match (real WebSockets, scripted players)', () => {
  it('host up, a client drops: nothing happens in the host\'s ball; the match waits for that client only when its own grant is due', async () => {
    // p2 drops in p1's ball 2 and is away for about 400 ms; p1's ball ends 80 ms after the drop, so p2's grant comes due meanwhile.
    const r = await run({ id: 'WS-A18-HOSTUP', at: { player: 'p1', ball: 2 }, drop: (t) => t.get('p2')?.dropLinks('p1'), graceMs: 0, retryMs: 400, ballMs: 100 });
    expect(r.types.filter((t) => t === 'PAUSE:p1')).toHaveLength(1);
    const at = r.types.indexOf('PAUSE:p1');
    // The host's own ball 2 ended first, untouched; then the pause at p2's grant, p2's own RESUME, p2's grant.
    expect(r.types.slice(at - 1, at + 3)).toEqual(['BALL_END:p1', 'PAUSE:p1', 'RESUME:p2', 'TURN_GRANT:p1']);
    expect(r.outcomes['p1']?.pauses).toEqual([{ reason: 'disconnect', player: 'p2' }]);
    expect(issued(r.grants, 'p1', 2)).toBe(1);
    expect(ballEnds(r.outcomes, 'p1', 2)).toBe(1);
  });

  it('client up, the host loses every link at once: the match waits for the player who is up and for nobody else; that player\'s ball goes on and is reported once', async () => {
    // p2's ball 2 takes 250 ms; the host's links die 20 ms into it and the clients are back about 100 ms later.
    const r = await run({ id: 'WS-A18-HOSTLINK', at: { player: 'p2', ball: 2 }, drop: (t) => t.get('p1')?.dropLinks(), graceMs: 0, retryMs: 100, ballMs: 250 });
    // One pause, for the player the host could not reach while it held the grant; none for p3, who was waiting.
    expect(r.outcomes['p1']?.pauses).toEqual([{ reason: 'disconnect', player: 'p2' }]);
    expect(r.types.filter((t) => t.startsWith('RESUME'))).toEqual(['RESUME:p2']);
    // p2 played its ball through: the grant was confirmed again at its return (a new number, the same ball), and
    // the one ball end it reported is the one in the log.
    expect(issued(r.grants, 'p2', 2)).toBe(2);
    expect(ballEnds(r.outcomes, 'p2', 2)).toBe(1);
    expect(r.seen.filter((e) => e.player === 'p2' && e.event === 'playError')).toEqual([]);
    // Both clients came back by RECONNECT.
    expect(r.seen.filter((e) => e.player === 'p1' && e.event === 'reconnected').map((e) => (e.payload as { playerId: string }).playerId).sort()).toEqual(['p2', 'p3']);
  });

  it('client up, the host loses every link for less than the grace: nobody is paused for, nothing is issued again, and nobody is told', async () => {
    const r = await run({ id: 'WS-A18-HOSTBLIP', at: { player: 'p2', ball: 2 }, drop: (t) => t.get('p1')?.dropLinks(), graceMs: 3000, retryMs: 60, ballMs: 250 });
    expect(r.types).not.toContain('PAUSE:p1');
    expect(r.seen.filter((e) => ['peerLeft', 'pause', 'resume'].includes(e.event))).toEqual([]);
    expect(r.grants).toHaveLength(9);
    expect(ballEnds(r.outcomes, 'p2', 2)).toBe(1);
    expect(r.seen.filter((e) => e.event === 'reconnected').map((e) => (e.payload as { quiet: boolean }).quiet)).toEqual([true, true, true, true]);
  });

  it('the player who is up drops and is back in its own ball: the others wait meanwhile, its ball goes on and is reported once', async () => {
    const r = await run({ id: 'WS-A18-UPDROP', at: { player: 'p3', ball: 2 }, drop: (t) => t.get('p3')?.dropLinks('p1'), graceMs: 0, retryMs: 100, ballMs: 250 });
    // The others are told to wait for p3 (the existing pause); p3's own RESUME ends it.
    expect(r.outcomes['p1']?.pauses).toEqual([{ reason: 'disconnect', player: 'p3' }]);
    expect(r.outcomes['p2']?.pauses).toEqual([{ reason: 'disconnect', player: 'p3' }]);
    expect(r.types.filter((t) => t.startsWith('RESUME'))).toEqual(['RESUME:p3']);
    expect(issued(r.grants, 'p3', 2)).toBe(2);
    expect(ballEnds(r.outcomes, 'p3', 2)).toBe(1);
    expect(r.seen.filter((e) => e.player === 'p3' && e.event === 'playError')).toEqual([]);
  });

  it('the player who is up drops and its ball ends before it is back: the ball end it reported into the dead link counts, and the turn passes on without that ball being granted again', async () => {
    const r = await run({ id: 'WS-A18-UPLOST', at: { player: 'p3', ball: 2 }, drop: (t) => t.get('p3')?.dropLinks('p1'), graceMs: 0, retryMs: 250, ballMs: 60 });
    expect(r.outcomes['p1']?.pauses).toEqual([{ reason: 'disconnect', player: 'p3' }]);
    const at = r.types.indexOf('PAUSE:p1');
    // The pause, p3's ball end (sent again at its return, taken during the pause), its RESUME, and the next
    // player's grant: p3's ball 2 was granted once.
    expect(r.types.slice(at, at + 4)).toEqual(['PAUSE:p1', 'BALL_END:p3', 'RESUME:p3', 'TURN_GRANT:p1']);
    expect(issued(r.grants, 'p3', 2)).toBe(1);
    expect(ballEnds(r.outcomes, 'p3', 2)).toBe(1);
  });
});
