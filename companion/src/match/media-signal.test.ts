/**
 * D2 (2026-10-30): MEDIA_SIGNAL over the engine. The host forwards a client's signal to its `to` and nobody else,
 * consumes one addressed to itself, sends its own straight to `to`, and none of it reaches the match log.
 */
import { describe, expect, it } from 'vitest';
import { buildMessage, type AnyMessage, type GameFingerprint, type ParticipantInfo, type PayloadOf, type PlayerId } from '@castcade/protocol';
import { ClientMatch } from './client.js';
import { ManualClock } from './clock.js';
import { HostMatch, type RejectInfo } from './host.js';
import { generateKeys, type KeyPair } from './keys.js';
import { MemoryBus } from './transport.js';

const flush = async (n = 6): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setTimeout(r, 0));
};

const hex = 'ab'.repeat(32);
const game: GameFingerprint = { kind: 'vpx', tableName: 'MM', tableHash: hex, romName: 'mm_109c', romHash: hex, physicsHash: null, recipeVersion: '0.1.0', sidecarHash: hex, emulatorVersion: '10.8.0' };
const participant = (id: string, keys: KeyPair): ParticipantInfo => ({ playerId: id, displayName: id, publicKey: keys.publicKeyB64, rig: 'vr_headset' });

type Got = { from: PlayerId; signal: PayloadOf<'MEDIA_SIGNAL'> };

async function rig(ids: string[]): Promise<{ bus: MemoryBus; host: HostMatch; clients: Record<string, ClientMatch>; got: Record<string, Got[]>; wire: Record<string, AnyMessage[]>; rejects: RejectInfo[] }> {
  const bus = new MemoryBus();
  const clock = new ManualClock();
  const hostKeys = generateKeys();
  const host = new HostMatch({ transport: bus.transport('h'), keys: hostKeys, matchId: 'M', ballsPerGame: 1, hostParticipant: participant('h', hostKeys), hostGame: game, clock });
  const got: Record<string, Got[]> = { h: [] };
  const wire: Record<string, AnyMessage[]> = {};
  const rejects: RejectInfo[] = [];
  host.on('mediaSignal', (x) => got['h']?.push(x));
  host.on('reject', (x) => rejects.push(x));
  const clients: Record<string, ClientMatch> = {};
  for (const id of ids) {
    const k = generateKeys();
    const t = bus.transport(id);
    wire[id] = [];
    t.onMessage((_from, msg) => wire[id]?.push(msg));
    const c = new ClientMatch({ transport: t, keys: k, participant: participant(id, k), game, throwdownCode: 'M', hostId: 'h', clock });
    got[id] = [];
    c.on('mediaSignal', (x) => got[id]?.push(x));
    clients[id] = c;
    c.join();
  }
  await flush();
  host.start();
  await flush();
  return { bus, host, clients, got, wire, rejects };
}

const offer = { kind: 'offer' as const, sdp: 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n' };
const ice = { kind: 'ice' as const, candidate: { candidate: 'candidate:1 1 udp 2122260223 10.0.0.2 50000 typ host', sdpMid: '0', sdpMLineIndex: 0 } };
const signalsOn = (msgs: AnyMessage[] | undefined): AnyMessage[] => (msgs ?? []).filter((m) => m.type === 'MEDIA_SIGNAL');

describe('MEDIA_SIGNAL relay (D2)', () => {
  it('two clients exchange a signal through the host; a third client never sees it; nothing is logged', async () => {
    const r = await rig(['a', 'b', 'c']);
    const logLengths = [r.host.log.length, r.clients['a']?.log.length];
    expect(r.clients['a']?.sendMediaSignal('b', offer)).toBe(true);
    await flush();
    expect(r.clients['b']?.sendMediaSignal('a', { kind: 'answer', sdp: 'v=0\r\n' })).toBe(true);
    r.clients['b']?.sendMediaSignal('a', ice);
    await flush();

    expect(r.got['b']).toEqual([{ from: 'a', signal: { to: 'b', ...offer } }]);
    expect(r.got['a']?.map((g) => [g.from, g.signal.kind])).toEqual([
      ['b', 'answer'],
      ['b', 'ice'],
    ]);
    expect(r.got['a']?.[1]?.signal.candidate).toEqual(ice.candidate);
    // c's wire carried no MEDIA_SIGNAL at all, and the host did not consume what was not its own.
    expect(signalsOn(r.wire['c'])).toEqual([]);
    expect(r.got['c']).toEqual([]);
    expect(r.got['h']).toEqual([]);
    expect([r.host.log.length, r.clients['a']?.log.length]).toEqual(logLengths);
    expect(r.rejects).toEqual([]);
  });

  it('the host consumes a signal addressed to it and sends its own straight to the one peer', async () => {
    const r = await rig(['a', 'b']);
    r.clients['a']?.sendMediaSignal('h', offer);
    await flush();
    expect(r.got['h']).toEqual([{ from: 'a', signal: { to: 'h', ...offer } }]);
    expect(signalsOn(r.wire['b'])).toEqual([]);

    expect(r.host.sendMediaSignal('a', { kind: 'answer', sdp: 'v=0\r\n' })).toBe(true);
    await flush();
    expect(r.got['a']).toEqual([{ from: 'h', signal: { to: 'a', kind: 'answer', sdp: 'v=0\r\n' } }]);
    expect(signalsOn(r.wire['b'])).toEqual([]);
    // to oneself: nothing sent
    expect(r.host.sendMediaSignal('h', offer)).toBe(false);
    expect(r.clients['a']?.sendMediaSignal('a', offer)).toBe(false);
  });

  it('a signal for a peer that dropped is not sent; one for a stranger is rejected; a misrouted one is dropped', async () => {
    const r = await rig(['a', 'b']);
    r.bus.disconnect('b');
    await flush();
    expect(r.host.sendMediaSignal('b', offer)).toBe(false);
    r.clients['a']?.sendMediaSignal('b', offer);
    r.clients['a']?.sendMediaSignal('zz', offer);
    await flush();
    expect(r.rejects.map((x) => [x.refType, x.code])).toEqual([['MEDIA_SIGNAL', 'unknown_player']]);

    // A frame naming someone else that does reach a client (a host bug) is dropped, not surfaced.
    const dropped: string[] = [];
    r.clients['a']?.on('dropped', (d) => dropped.push(`${d.type}:${d.reason}`));
    r.host.session.transport.send('a', buildMessage('MEDIA_SIGNAL', { to: 'b', ...offer }, { matchId: 'M', seq: 900, from: 'h' }));
    await flush();
    expect(dropped).toEqual(['MEDIA_SIGNAL:unexpected']);
    expect(r.got['a']).toEqual([]);
  });
});
