/**
 * A17 step 4 (2026-11-24): End my ball on the wire. A player ends a ball by hand with a BALL_END whose
 * `detectorReason` is `manual`. The value has been in the schema since protocol 1, and neither a host nor a client
 * reads the reason: the host checks the sender, the grant and the ball, logs the frame as it came and grants the next
 * turn; a client folds the score and the ball. The scripted player here stands for any other implementation of the
 * protocol (a companion up to 0.2.50 among them: its `onBallEnd` is this one, line for line): it plays whole matches
 * over real WebSockets against a player who ends every ball by hand, as the host and as the client, and comes to the
 * result it comes to when every ball ends by itself.
 */
import { describe, expect, it } from 'vitest';
import { WsClientTransport, WsHostTransport } from '@castcade/companion';
import { FakePlayer } from './lib.js';
import { generateScenario } from './scenario.js';

/** One 2-player 3-ball match over loopback; `byHand` names the players who end every ball by hand. */
async function play(byHand: string[]) {
  const scenario = generateScenario({ players: 2, ballsPerGame: 3, matchId: 'ENDBALL' });
  for (const p of scenario.players) if (byHand.includes(p.playerId)) p.endsByHand = true;
  const hostTransport = new WsHostTransport({ localId: 'p1', port: 0 });
  const port = await hostTransport.listen();
  const clientTransport = new WsClientTransport({ localId: 'p2', url: `ws://127.0.0.1:${port}` });
  // Every BALL_END as each end of the socket was handed it: the client's own at the host, the host's echo of every
  // accepted one at the client.
  const atHost: string[] = [];
  const atClient: string[] = [];
  hostTransport.onMessage((_from, m) => void (m.type === 'BALL_END' && atHost.push(`${m.from}:${m.payload.detectorReason}`)));
  clientTransport.onMessage((_from, m) => void (m.type === 'BALL_END' && atClient.push(`${m.from}:${m.payload.detectorReason}`)));
  try {
    const [hostScript, clientScript] = scenario.players;
    if (!hostScript || !clientScript) throw new Error('scenario');
    const host = new FakePlayer({ role: 'host', transport: hostTransport, script: hostScript, scenario, expectedJoins: 1 });
    await clientTransport.connect();
    const client = new FakePlayer({ role: 'client', transport: clientTransport, script: clientScript, scenario });
    client.start();
    const [h, c] = await Promise.all([host.done, client.done]);
    return { h, c, atHost, atClient };
  } finally {
    clientTransport.close();
    hostTransport.close();
  }
}

describe('End my ball over WebSocket (A17 step 4)', () => {
  it('a client that ends every ball by hand, with a host that knows nothing of it: the match is the match it would have been', async () => {
    const plain = await play([]);
    const hand = await play(['p2']);
    expect(hand.atHost).toEqual(['p2:manual', 'p2:manual', 'p2:manual']);
    // The host took each as an ordinary ball end: nothing rejected, the same grants in the same order, the same result.
    expect(hand.h.rejects).toEqual([]);
    expect(hand.c.rejects).toEqual([]);
    expect(hand.h.issuedGrants.map((g) => `${g.player}b${g.ballNumber}`)).toEqual(plain.h.issuedGrants.map((g) => `${g.player}b${g.ballNumber}`));
    expect(hand.h.result?.entries).toEqual(plain.h.result?.entries);
    expect(hand.h.result?.winner).toBe(plain.h.result?.winner);
    // One log on both PCs, signed by the client and by the host.
    expect(hand.c.logHead).toEqual(hand.h.logHead);
    expect(hand.c.result).toEqual(hand.h.result);
    expect(hand.c.resultInfo).toEqual({ logMatches: true, signatureValid: true });
    expect(hand.h.result?.signatures.map((s) => s.playerId)).toEqual(['p2']);
  });

  it('a host that ends every ball by hand, with a client that knows nothing of it: the client folds each one, takes its turns and signs the same log', async () => {
    const plain = await play([]);
    const hand = await play(['p1']);
    // What the client was sent: the host's ball ends say `manual`, its own come back as it sent them.
    expect(hand.atClient.filter((x) => x.startsWith('p1:'))).toEqual(['p1:manual', 'p1:manual', 'p1:manual']);
    expect(hand.atClient.filter((x) => x.startsWith('p2:'))).toEqual(['p2:script', 'p2:script', 'p2:script']);
    expect(hand.c.rejects).toEqual([]);
    expect(hand.c.grantsSeen.map((g) => `${g.player}b${g.ballNumber}`)).toEqual(plain.c.grantsSeen.map((g) => `${g.player}b${g.ballNumber}`));
    expect(hand.c.result?.entries).toEqual(plain.c.result?.entries);
    expect(hand.c.logHead).toEqual(hand.h.logHead);
    expect(hand.c.resultInfo).toEqual({ logMatches: true, signatureValid: true });
    expect(hand.h.result?.signatures.map((s) => s.playerId)).toEqual(['p2']);
  });

  it('both end every ball by hand (two tables Castcade cannot read): still one log and one result', async () => {
    const hand = await play(['p1', 'p2']);
    expect(hand.atHost).toEqual(['p2:manual', 'p2:manual', 'p2:manual']);
    expect(hand.c.logHead).toEqual(hand.h.logHead);
    expect(hand.c.result).toEqual(hand.h.result);
    expect(hand.h.result?.entries.map((e) => e.status)).toEqual(['finished', 'finished']);
  });
});
