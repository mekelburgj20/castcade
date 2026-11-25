/**
 * WebSocket loopback: a host and one client over `ws` on an ephemeral port complete a
 * 2-player 1-ball match. Host transfer over WebSocket is `ws-transfer.test.ts` (A2).
 */
import { describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { decodeFrame, encodeFrame, PROTOCOL_VERSION } from '@castcade/protocol';
import { WsClientTransport, WsHostTransport, WsPeerTransport } from '@castcade/companion';
import { FakePlayer } from './lib.js';
import { generateScenario } from './scenario.js';


/**
 * Review of PR 127: frames of every shape, as anybody who reaches the port (or holds a seat in the room) can send
 * them. `answer`: what comes back, if anything: only a HELLO or a RECONNECT of another version is answered.
 */
const X600 = 'x'.repeat(600);
const GARBAGE: Array<{ what: string; text: string; answer: 'REFUSE' | 'RECONNECT_ACK' | null }> = [
  { what: 'a HELLO whose v is 600 characters', text: JSON.stringify({ v: X600, type: 'HELLO' }), answer: 'REFUSE' },
  { what: 'a RECONNECT whose v and match id are 20 KB each', text: JSON.stringify({ v: 'x'.repeat(20_000), type: 'RECONNECT', matchId: 'x'.repeat(20_000) }), answer: 'RECONNECT_ACK' },
  { what: 'v an object', text: JSON.stringify({ v: { a: X600 }, type: 'HELLO' }), answer: 'REFUSE' },
  { what: 'v an array', text: JSON.stringify({ v: [1, 2, 3], type: 'HELLO' }), answer: 'REFUSE' },
  { what: 'v negative', text: JSON.stringify({ v: -3, type: 'HELLO' }), answer: 'REFUSE' },
  { what: 'v a fraction', text: JSON.stringify({ v: 6.5, type: 'HELLO' }), answer: 'REFUSE' },
  { what: 'v beyond a number', text: '{"v":1e400,"type":"HELLO"}', answer: 'REFUSE' },
  { what: 'v null', text: JSON.stringify({ v: null, type: 'HELLO' }), answer: 'REFUSE' },
  { what: 'no v at all', text: JSON.stringify({ type: 'HELLO' }), answer: 'REFUSE' },
  { what: 'a RECONNECT whose match id is an object', text: JSON.stringify({ v: 5, type: 'RECONNECT', matchId: { x: X600 } }), answer: 'RECONNECT_ACK' },
  { what: 'a RECONNECT whose match id has a line break and quotes', text: JSON.stringify({ v: 5, type: 'RECONNECT', matchId: 'M"\n<x>' }), answer: 'RECONNECT_ACK' },
  { what: 'type an object', text: JSON.stringify({ v: 5, type: { toString: 'HELLO' } }), answer: null },
  { what: 'a REFUSE of another version (an answer is never answered)', text: JSON.stringify({ v: 5, type: 'REFUSE', matchId: null, seq: 1, ts: 1, from: 'x', payload: { code: 'protocol_version', message: 'm', mismatches: [] } }), answer: null },
  { what: 'a RECONNECT_ACK of another version', text: JSON.stringify({ v: 5, type: 'RECONNECT_ACK', matchId: 'M', seq: 1, ts: 1, from: 'x', payload: {} }), answer: null },
  { what: 'our own version with nothing in it', text: JSON.stringify({ v: PROTOCOL_VERSION, type: 'HELLO' }), answer: null },
  { what: 'not JSON', text: 'HELLO', answer: null },
  { what: 'nothing', text: '', answer: null },
  { what: 'a number', text: '7', answer: null },
  { what: 'null', text: 'null', answer: null },
  { what: 'an array', text: '[{"v":5,"type":"HELLO"}]', answer: null },
  { what: 'a string', text: '"HELLO"', answer: null },
  { what: 'ten thousand open brackets', text: '['.repeat(10_000), answer: null },
  { what: 'two hundred thousand of one letter', text: 'a'.repeat(200_000), answer: null },
];
/** An answer holds nothing of the frame it answers but its whole-number version and a plain match id. */
const checkAnswer = (text: string, want: 'REFUSE' | 'RECONNECT_ACK'): void => {
  expect(text.length).toBeLessThan(1000);
  expect(text).not.toContain('xxxx');
  expect(text).not.toContain('<x>');
  const f = JSON.parse(text) as { v: unknown; type: string; matchId: unknown; payload: { message?: string } };
  expect(f.type).toBe(want);
  expect(Number.isSafeInteger(f.v)).toBe(true);
  expect(f.matchId).toBeNull();
  if (want === 'REFUSE') expect(f.payload.message).toMatch(/^This match needs Castcade 0\.2\.46 or newer \(protocol 6; this PC sent (another version|\d+)\)\. /);
};

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
      // A17 step 1 (2026-11-24): the answer is written in the asker's version (99 here), so the asker can read it.
      const frame = JSON.parse(await reply) as { v: number };
      expect(frame.v).toBe(99);
      const msg = decodeFrame(JSON.stringify({ ...frame, v: PROTOCOL_VERSION }));
      expect(msg.type).toBe('REFUSE');
      if (msg.type === 'REFUSE') {
        expect(msg.payload.code).toBe('protocol_version');
        expect(msg.payload.message).toBe("The host's Castcade is older than this PC's (it speaks protocol 6, this PC 99). The host updates Castcade (Settings, Check for updates); then join again.");
      }
      expect(errors.length).toBe(1);
    } finally {
      socket.close();
      hostTransport.close();
    }
  });

  it('protocol 6 (I11.4.2): a HELLO from a protocol 5 build (0.2.40 to 0.2.45) is refused with protocol_version, as 4 refused 3', async () => {
    expect(PROTOCOL_VERSION).toBe(6);
    const hostTransport = new WsHostTransport({ localId: 'p1', port: 0 });
    const port = await hostTransport.listen();
    hostTransport.onError(() => undefined);
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('open', () => resolve());
        socket.once('error', reject);
      });
      const reply = new Promise<string>((resolve) => socket.once('message', (d) => resolve(d.toString())));
      const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
      // What a 0.2.45 client sends: the envelope and the HELLO both say 5.
      const hello = { v: 5, type: 'HELLO', matchId: null, seq: 1, ts: 1, from: 'p9', payload: { protocolVersion: 5, companionVersion: '0.2.45', throwdownCode: 'ABCDEF' } };
      socket.send(JSON.stringify(hello));
      // A17 step 1 (2026-11-24): in the asker's version. Until 0.2.50 this REFUSE said `v: 6`, which a protocol 5
      // client cannot decode: it showed "The host did not answer" after ten seconds instead of the sentence.
      const frame = JSON.parse(await reply) as { v: number };
      expect(frame.v).toBe(5);
      const msg = decodeFrame(JSON.stringify({ ...frame, v: PROTOCOL_VERSION }));
      expect(msg.type).toBe('REFUSE');
      if (msg.type === 'REFUSE') {
        expect(msg.payload.code).toBe('protocol_version');
        expect(msg.payload.message).toBe('This match needs Castcade 0.2.46 or newer (protocol 6; this PC sent 5). Update Castcade on this PC (Settings, Check for updates) and join again.');
      }
      await closed;
    } finally {
      socket.close();
      hostTransport.close();
    }
  });

  /** A PC on another version, as a bare socket: it sends one frame to the companion's own transport and reads the answer as text. */
  const ask = async (frame: Record<string, unknown>): Promise<{ answer: Record<string, unknown> & { payload: Record<string, unknown> }; errors: string[]; delivered: string[] }> => {
    const host = new WsPeerTransport({ localId: 'p1' });
    const url = await host.listen(0, '127.0.0.1');
    const errors: string[] = [];
    const delivered: string[] = [];
    host.onError((e) => errors.push(e.message));
    host.onMessage((_from, m) => delivered.push(m.type));
    const socket = new WebSocket(url);
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('open', () => resolve());
        socket.once('error', reject);
      });
      const reply = new Promise<string>((resolve) => socket.once('message', (d) => resolve(d.toString())));
      const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
      socket.send(JSON.stringify(frame));
      const answer = JSON.parse(await reply) as Record<string, unknown> & { payload: Record<string, unknown> };
      // The host closes the link after its answer, as after any refusal.
      await closed;
      return { answer, errors, delivered };
    } finally {
      socket.close();
      host.close();
    }
  };

  it('A17 step 1 (2026-11-24): a HELLO, and a RECONNECT, of another version are answered in that version', async () => {
    expect(PROTOCOL_VERSION).toBe(6);
    // A HELLO from 0.2.45 (protocol 5), and one from a build that is newer than this host.
    const older = await ask({ v: 5, type: 'HELLO', matchId: null, seq: 1, ts: 1, from: 'p9', payload: { protocolVersion: 5, companionVersion: '0.2.45', throwdownCode: 'ABCDEF' } });
    expect(older.answer).toMatchObject({ v: 5, type: 'REFUSE', matchId: null, from: 'p1', payload: { code: 'protocol_version' } });
    expect(older.answer.payload.message).toMatch(/^This match needs Castcade 0\.2\.46 or newer .* Update Castcade on this PC \(Settings, Check for updates\) and join again\.$/);
    const newer = await ask({ v: 7, type: 'HELLO', matchId: null, seq: 1, ts: 1, from: 'p9', payload: { protocolVersion: 7 } });
    expect(newer.answer).toMatchObject({ v: 7, type: 'REFUSE', payload: { code: 'protocol_version' } });
    expect(newer.answer.payload.message).toMatch(/^The host's Castcade is older than this PC's .* The host updates Castcade/);

    // A RECONNECT: the PC was in the match, and this host restarted into another version (the evening an update
    // arrives). Until 0.2.50 it got no answer and waited out the whole host wait. Now it is told at once, with the one
    // code every version knows, and a `seq` that PC will not drop (above anything an earlier run of this host sent it).
    const before = Date.now();
    const back = await ask({ v: 7, type: 'RECONNECT', matchId: 'ABCDEF', seq: 4711, ts: 1, from: 'p9', payload: { player: 'p9', logHash: '0'.repeat(64), logLength: 0, signature: 'c2ln' } });
    expect(back.answer).toMatchObject({ v: 7, type: 'RECONNECT_ACK', matchId: 'ABCDEF', from: 'p1', payload: { accept: false, code: 'unknown_player', entries: [], logLength: 0 } });
    expect(back.answer.seq as number).toBeGreaterThanOrEqual(before);
    // In its own version it is a RECONNECT_ACK as every version since protocol 2 writes one.
    expect(decodeFrame(JSON.stringify({ ...back.answer, v: PROTOCOL_VERSION })).type).toBe('RECONNECT_ACK');
    // Nothing of another version reaches the engine; each undecodable frame is reported once.
    for (const x of [older, newer, back]) {
      expect(x.delivered).toEqual([]);
      expect(x.errors).toHaveLength(1);
    }
  });

  it('review of PR 127: no frame of any shape from a socket that has not joined throws in the host\'s process; only a HELLO or a RECONNECT of another version is answered, in a few hundred bytes, and the socket is closed', async () => {
    const uncaught: string[] = [];
    const onUncaught = (e: unknown): void => void uncaught.push(String(e));
    process.on('uncaughtException', onUncaught);
    const peer = new WsPeerTransport({ localId: 'p1' });
    const fixed = new WsHostTransport({ localId: 'p1', port: 0 });
    const errors = { peer: 0, fixed: 0 };
    const delivered: string[] = [];
    peer.onError(() => void errors.peer++);
    fixed.onError(() => void errors.fixed++);
    peer.onMessage((_f, m) => void delivered.push(m.type));
    fixed.onMessage((_f, m) => void delivered.push(m.type));
    const urls = { peer: await peer.listen(0, '127.0.0.1'), fixed: `ws://127.0.0.1:${await fixed.listen()}` };
    /** One frame on a socket of its own; what came back before the host closed it, or within a moment. */
    const send = async (url: string, text: string): Promise<string[]> => {
      const socket = new WebSocket(url);
      const got: string[] = [];
      socket.on('message', (d) => void got.push(d.toString()));
      socket.on('error', () => undefined);
      await new Promise<void>((resolve) => socket.once('open', () => resolve()));
      const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
      socket.send(text);
      await Promise.race([closed, new Promise((r) => setTimeout(r, 120))]);
      socket.terminate();
      return got;
    };
    try {
      for (const which of ['peer', 'fixed'] as const) {
        for (const g of GARBAGE) {
          const got = await send(urls[which], g.text);
          expect([which, g.what, got.length]).toEqual([which, g.what, g.answer === null ? 0 : 1]);
          if (g.answer !== null) checkAnswer(got[0]!, g.answer);
        }
        // Each frame was reported once to whoever listens for errors; none reached an engine.
        expect(errors[which]).toBe(GARBAGE.length);
      }
      expect(delivered).toEqual([]);
      expect(uncaught).toEqual([]);

      // And a first frame that does decode, on which a listener of ours throws (a fault of this program): reported
      // and the socket closed, not an error box over the host's game.
      const off = peer.onMessage(() => {
        throw new Error('a listener threw');
      });
      const seen: string[] = [];
      peer.onError((e) => void seen.push(e.message));
      const hello = { v: PROTOCOL_VERSION, type: 'RESUME', matchId: 'M', seq: 1, ts: 1, from: 'p9', payload: {} };
      await send(urls.peer, JSON.stringify({ ...hello, type: 'RECONNECT', payload: { player: 'p9', logHash: '0'.repeat(64), logLength: 0, signature: 'c2ln' } }));
      off();
      expect(seen).toContain('a listener threw');
      expect(uncaught).toEqual([]);
    } finally {
      process.off('uncaughtException', onUncaught);
      peer.close();
      fixed.close();
    }
  }, 30_000);

  it('A17 step 1: a host that answers in its own, other version (every host up to 0.2.50): the joining PC says which versions the two have instead of waiting for an answer', async () => {
    // The host of an older build: whatever comes, it answers REFUSE with its own `v`.
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    server.on('connection', (socket) => {
      socket.on('message', () => {
        socket.send(JSON.stringify({ v: 5, type: 'REFUSE', matchId: null, seq: 1, ts: 1, from: 'p1', payload: { code: 'protocol_version', message: 'host speaks protocol 5, client sent 6', mismatches: [] } }), () => socket.close());
      });
    });
    const port = (server.address() as { port: number }).port;
    const client = new WsPeerTransport({ localId: 'p2' });
    const errors: Error[] = [];
    const delivered: string[] = [];
    client.onError((e) => errors.push(e));
    client.onMessage((_from, m) => delivered.push(m.type));
    try {
      await client.connect(`ws://127.0.0.1:${port}`);
      // Any frame of this version stands in for the HELLO: the old host does not decode it either.
      client.send('all', decodeFrame(JSON.stringify({ v: PROTOCOL_VERSION, type: 'RESUME', matchId: 'M', seq: 1, ts: 1, from: 'p2', payload: {} })));
      const end = Date.now() + 4000;
      while (errors.length === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
      expect(errors.map((e) => e.name)).toEqual(['ForeignVersionError']);
      expect(errors[0]?.message).toBe("The host's PC runs another version of Castcade (protocol 5; this PC has 6). Both need the same: the host updates Castcade (Settings, Check for updates), then join again.");
      expect(delivered).toEqual([]);
    } finally {
      client.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
