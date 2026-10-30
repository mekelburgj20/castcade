/**
 * WebSocket loopback: a host and one client over `ws` on an ephemeral port complete a
 * 2-player 1-ball match. Host transfer over WebSocket is `ws-transfer.test.ts` (A2).
 */
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { decodeFrame, encodeFrame } from '@castcade/protocol';
import { WsClientTransport, WsHostTransport } from '@castcade/companion';
import { FakePlayer } from './lib.js';
import { generateScenario } from './scenario.js';

describe('WebSocket loopback', () => {
  it('host + 1 client complete a 2-player 1-ball match', async () => {
    const scenario = generateScenario({ players: 2, ballsPerGame: 1, matchId: 'WS-1' });
    const hostTransport = new WsHostTransport({ localId: 'p1', port: 0 });
    const port = await hostTransport.listen();
    const clientTransport = new WsClientTransport({ localId: 'p2', url: `ws://127.0.0.1:${port}` });
    try {
      const [hostScript, clientScript] = scenario.players;
      if (!hostScript || !clientScript) throw new Error('scenario');
      const host = new FakePlayer({ role: 'host', transport: hostTransport, script: hostScript, scenario, expectedJoins: 1 });
      await clientTransport.connect();
      const client = new FakePlayer({ role: 'client', transport: clientTransport, script: clientScript, scenario });
      client.start();
      const [h, c] = await Promise.all([host.done, client.done]);
      expect(h.result).not.toBeNull();
      expect(c.result).toEqual(h.result);
      expect(c.logHead).toEqual(h.logHead);
      expect(c.resultInfo).toEqual({ logMatches: true, signatureValid: true });
      expect(h.result?.winner).toBe('p2');
      expect(h.result?.signatures.map((s) => s.playerId)).toEqual(['p2']);
      expect(h.issuedGrants.map((g) => `${g.player}b${g.ballNumber}`)).toEqual(['p1b1', 'p2b1']);
    } finally {
      clientTransport.close();
      hostTransport.close();
    }
  });

  it('answers a HELLO with a foreign protocol version with REFUSE(protocol_version)', async () => {
    const hostTransport = new WsHostTransport({ localId: 'p1', port: 0 });
    const port = await hostTransport.listen();
    const errors: string[] = [];
    hostTransport.onError((e) => errors.push(e.message));
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('open', () => resolve());
        socket.once('error', reject);
      });
      const reply = new Promise<string>((resolve) => socket.once('message', (d) => resolve(d.toString())));
      const hello = { v: 99, type: 'HELLO', matchId: null, seq: 1, ts: 1, from: 'p9', payload: { protocolVersion: 99 } };
      socket.send(encodeFrame(hello as unknown as Parameters<typeof encodeFrame>[0]));
      const msg = decodeFrame(await reply);
      expect(msg.type).toBe('REFUSE');
      if (msg.type === 'REFUSE') expect(msg.payload.code).toBe('protocol_version');
      expect(errors.length).toBe(1);
    } finally {
      socket.close();
      hostTransport.close();
    }
  });
});
