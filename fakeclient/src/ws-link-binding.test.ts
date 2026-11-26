/**
 * 2026-11-25: a link belongs to a player only once the engine has accepted that link's first frame, and a first
 * frame that is refused changes nothing about the player it names. Three scripted players play a whole match over
 * real WebSockets twice: once with nothing else on the host's listener, and once while, at every grant, another
 * socket opens there with a first frame the engine refuses. The two matches are the same match: the same grants in
 * the same order, the same scores, no pause, nobody rejected; and each of those sockets got its answer and was
 * closed.
 */
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { buildMessage, decodeFrame, encodeFrame, PROTOCOL_VERSION, type AnyMessage, type GrantBody } from '@castcade/protocol';
import { generateKeys, signCanonical, WsPeerTransport } from '@castcade/companion';
import { collapseReissues, expectedRotation, runWsScenario, type FakeHooks, type FakePlayerOutcome } from './lib.js';
import { defaultFingerprint, generateScenario } from './scenario.js';

const HIGH = 1_000_000_000_000_000;
const until = async (cond: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

interface Opened {
  answers: string[];
  closed: boolean;
}

async function play(matchId: string, hooks: (transports: Map<string, WsPeerTransport>) => FakeHooks): Promise<Record<string, FakePlayerOutcome>> {
  const scenario = generateScenario({ players: 3, ballsPerGame: 3, matchId });
  const ids = scenario.players.map((p) => p.playerId);
  const transports = new Map(ids.map((id) => [id, new WsPeerTransport({ localId: id })]));
  try {
    // A ball long enough for another socket to open and be answered while it is being played; no grace, so that a
    // leave noted for any reason would pause at once.
    const run = await runWsScenario(scenario, transports, { ballMs: 40, disconnectGraceMs: 0, hooks: hooks(transports), timeoutMs: 20_000 });
    return run.outcomes;
  } finally {
    for (const t of transports.values()) t.close();
  }
}

describe('a link is a player\'s once its first frame is accepted (three scripted players over WebSocket)', () => {
  it('a match during which other sockets open with first frames that are refused, at every grant, is the same match as one without them', async () => {
    const plain = await play('WS-BIND-0', () => ({}));

    const opened: Opened[] = [];
    let n = 0;
    const withOthers = await play('WS-BIND-1', (transports) => ({
      onGrant: (grant: GrantBody) => {
        const endpoint = transports.get('p1')?.endpoint;
        if (!endpoint) throw new Error('no host endpoint');
        const o: Opened = { answers: [], closed: false };
        opened.push(o);
        const hello = (n += 1) % 2 === 0;
        const first: AnyMessage = hello
          ? buildMessage(
              'HELLO',
              {
                protocolVersion: PROTOCOL_VERSION,
                companionVersion: 'test',
                throwdownCode: 'WS-BIND-1',
                participant: { playerId: grant.player, displayName: grant.player, publicKey: generateKeys().publicKeyB64, rig: 'pc' },
                game: defaultFingerprint,
              },
              { matchId: null, seq: HIGH, from: grant.player },
            )
          : buildMessage(
              'RECONNECT',
              { player: grant.player, logHash: grant.logHash, logLength: 1, signature: signCanonical({ not: 'the body' }, generateKeys().privateKey) },
              { matchId: 'WS-BIND-1', seq: HIGH, from: grant.player },
            );
        const ballEnd = buildMessage(
          'BALL_END',
          { grantSeq: grant.grantSeq, ballNumber: grant.ballNumber, finalScore: 7300, detectorReason: 'nvram', shootAgain: false },
          { matchId: 'WS-BIND-1', seq: HIGH + 1, from: grant.player },
        );
        const socket = new WebSocket(endpoint);
        socket.on('open', () => {
          socket.send(encodeFrame(first));
          socket.send(encodeFrame(ballEnd));
        });
        socket.on('message', (d) => o.answers.push(decodeFrame(d.toString()).type));
        socket.on('close', () => (o.closed = true));
        socket.on('error', () => (o.closed = true));
      },
    }));

    const ids = ['p1', 'p2', 'p3'];
    // Every such socket was answered once, in kind, and closed.
    expect(opened).toHaveLength(9);
    await until(() => opened.every((o) => o.closed));
    expect(opened.map((o) => o.answers.join())).toEqual(['RECONNECT_ACK', 'REFUSE', 'RECONNECT_ACK', 'REFUSE', 'RECONNECT_ACK', 'REFUSE', 'RECONNECT_ACK', 'REFUSE', 'RECONNECT_ACK']);

    // The match they were opened into ran exactly as the one without them.
    for (const outcomes of [plain, withOthers]) {
      const result = outcomes['p1']?.result;
      if (!result) throw new Error('no RESULT');
      for (const id of ids) {
        expect(outcomes[id]?.result).toEqual(result);
        expect(outcomes[id]?.logHead).toEqual({ hash: result.logHash, length: result.logLength });
        expect(outcomes[id]?.resultInfo).toEqual({ logMatches: true, signatureValid: true });
        expect(outcomes[id]?.rejects).toEqual([]);
        expect(outcomes[id]?.pauses).toEqual([]);
        expect(outcomes[id]?.reconnects).toEqual([]);
      }
      expect(result.entries.map((e) => e.status)).toEqual(['finished', 'finished', 'finished']);
      const grants = outcomes['p1']?.issuedGrants ?? [];
      expect(grants).toHaveLength(9);
      expect(collapseReissues(grants)).toEqual(expectedRotation(ids, 3));
    }
    const scores = (o: Record<string, FakePlayerOutcome>): unknown => o['p1']?.result?.entries.map((e) => [e.playerId, e.score, e.status]);
    expect(scores(withOthers)).toEqual(scores(plain));
    expect(withOthers['p1']?.result?.winner).toBe(plain['p1']?.result?.winner);
    expect(withOthers['p1']?.log.length).toBe(plain['p1']?.log.length);
  }, 40_000);
});
