import { describe, expect, it } from 'vitest';
import {
  buildMessage,
  decodeFrame,
  encodeFrame,
  MESSAGE_DIRECTION,
  MESSAGE_TYPES,
  parseMessage,
  ProtocolError,
  PROTOCOL_VERSION,
  type GameFingerprint,
  type ParticipantInfo,
} from '../src/index.js';

const hex64 = 'ab'.repeat(32);
const b64key = Buffer.alloc(32, 7).toString('base64');
const b64sig = Buffer.alloc(64, 9).toString('base64');

export const fingerprint: GameFingerprint = {
  kind: 'vpx',
  tableName: 'Medieval Madness (Williams 1997) VPW v1.0.1',
  tableHash: hex64,
  romName: 'mm_109c',
  romHash: hex64,
  physicsHash: null,
  recipeVersion: '0.1.0',
  sidecarHash: hex64,
  emulatorVersion: '10.8.0',
};

export const participant: ParticipantInfo = {
  playerId: 'p1',
  displayName: 'Player One',
  publicKey: b64key,
  rig: 'pc',
};

describe('envelope', () => {
  it('round-trips a HELLO', () => {
    const msg = buildMessage(
      'HELLO',
      { protocolVersion: PROTOCOL_VERSION, companionVersion: '0.1.0', throwdownCode: 'TD-1', participant, game: fingerprint },
      { matchId: null, seq: 0, from: 'p1', ts: 1 },
    );
    const back = decodeFrame(encodeFrame(msg));
    expect(back).toEqual(msg);
  });

  it('applies payload defaults', () => {
    const msg = buildMessage('STATE', { ballNumber: 1, score: 10, ballInPlay: true, tilt: false }, { matchId: 'TD-1', seq: 3, from: 'p1' });
    expect(msg.payload.extraBalls).toBe(0);
    const refuse = buildMessage('REFUSE', { code: 'match_full', message: 'full' }, { matchId: null, seq: 1, from: 'host' });
    expect(refuse.payload.mismatches).toEqual([]);
  });

  it('rejects a wrong protocol version, an unknown type and a bad payload', () => {
    const good = buildMessage('RESUME', {}, { matchId: 'TD-1', seq: 1, from: 'p1', ts: 1 });
    expect(() => parseMessage({ ...good, v: 99 })).toThrow(ProtocolError);
    expect(() => parseMessage({ ...good, type: 'NOPE' })).toThrow(ProtocolError);
    expect(() => parseMessage({ ...good, type: 'BALL_END' })).toThrow(ProtocolError);
    expect(() => decodeFrame('{not json')).toThrow(ProtocolError);
  });

  it('validates a TURN_GRANT and a BALL_END', () => {
    const grant = buildMessage(
      'TURN_GRANT',
      { grant: { matchId: 'TD-1', player: 'p2', ballNumber: 1, grantSeq: 1, issuedAt: 1, logHash: hex64 }, grantSig: b64sig },
      { matchId: 'TD-1', seq: 1, from: 'host' },
    );
    expect(grant.payload.grant.player).toBe('p2');
    expect(() =>
      buildMessage(
        'BALL_END',
        { grantSeq: 1, ballNumber: 0, finalScore: 1, detectorReason: 'nvram', shootAgain: false },
        { matchId: 'TD-1', seq: 2, from: 'p2' },
      ),
    ).toThrow(ProtocolError);
    expect(() =>
      buildMessage(
        'BALL_END',
        { grantSeq: 1, ballNumber: 1, finalScore: 1.5, detectorReason: 'nvram', shootAgain: false },
        { matchId: 'TD-1', seq: 2, from: 'p2' },
      ),
    ).toThrow(ProtocolError);
  });

  it('validates both DMD_FRAME variants', () => {
    const text = buildMessage('DMD_FRAME', { kind: 'text', lines: ['PLAYER 1', 'BALL 2'] }, { matchId: 'TD-1', seq: 1, from: 'p1' });
    expect(text.payload.kind).toBe('text');
    const bmp = buildMessage(
      'DMD_FRAME',
      { kind: 'bitmap', width: 128, height: 32, bitsPerPixel: 4, encoding: 'rle8-base64', data: 'AAEC' },
      { matchId: 'TD-1', seq: 2, from: 'p1' },
    );
    expect(bmp.payload.kind).toBe('bitmap');
  });

  it('defaults HOST_TRANSFER.newHostEndpoint to null and accepts only ws:// or wss:// (A2)', () => {
    const base = { proposer: 'p1', newHost: 'p2', reason: 'host_requested' as const, logHash: hex64, logLength: 3, currentGrant: null, newHostPublicKey: b64key };
    const plain = buildMessage('HOST_TRANSFER', base, { matchId: 'TD-1', seq: 1, from: 'p1' });
    expect(plain.payload.newHostEndpoint).toBeNull();
    const ws = buildMessage('HOST_TRANSFER', { ...base, newHostEndpoint: 'ws://127.0.0.1:47891' }, { matchId: 'TD-1', seq: 2, from: 'p1' });
    expect(ws.payload.newHostEndpoint).toBe('ws://127.0.0.1:47891');
    expect(() => buildMessage('HOST_TRANSFER', { ...base, newHostEndpoint: 'http://x' }, { matchId: 'TD-1', seq: 3, from: 'p1' })).toThrow(ProtocolError);
  });

  it('round-trips RECONNECT and a RECONNECT_ACK carrying log entries verbatim (A2)', () => {
    const reconnect = buildMessage('RECONNECT', { player: 'p2', logHash: hex64, logLength: 4, signature: b64sig }, { matchId: 'TD-1', seq: 9, from: 'p2', ts: 1 });
    expect(decodeFrame(encodeFrame(reconnect))).toEqual(reconnect);
    const logged = buildMessage('RESUME', {}, { matchId: 'TD-1', seq: 3, from: 'p1', ts: 5 });
    const entries = [
      { index: 4, prevHash: hex64, ts: 5, kind: 'msg' as const, from: 'p1', message: logged as unknown as Record<string, unknown>, hash: 'cd'.repeat(32) },
      {
        index: 5,
        prevHash: 'cd'.repeat(32),
        ts: 6,
        kind: 'event' as const,
        from: 'p1',
        event: { type: 'host_transfer' as const, reason: 'host_requested' as const, proposer: 'p1', from: 'p1', to: 'p2', newHostPublicKey: b64key },
        hash: 'ef'.repeat(32),
      },
    ];
    const ack = buildMessage('RECONNECT_ACK', { accept: true, code: null, entries, logHash: 'ef'.repeat(32), logLength: 6 }, { matchId: 'TD-1', seq: 4, from: 'p1', ts: 7 });
    const back = decodeFrame(encodeFrame(ack));
    expect(back).toEqual(ack);
    if (back.type === 'RECONNECT_ACK') expect(back.payload.entries[0]?.message).toEqual(logged);
  });

  it('MEDIA_SIGNAL: offer and answer carry sdp, ice carries a candidate, any direction (D2)', () => {
    const offer = buildMessage('MEDIA_SIGNAL', { to: 'p2', kind: 'offer', sdp: 'v=0\r\n' }, { matchId: 'TD-1', seq: 5, from: 'p1', ts: 1 });
    expect(decodeFrame(encodeFrame(offer))).toEqual(offer);
    const ice = buildMessage(
      'MEDIA_SIGNAL',
      { to: 'p1', kind: 'ice', candidate: { candidate: 'candidate:1 1 udp 2122260223 192.168.1.2 54321 typ host', sdpMid: '0', sdpMLineIndex: 0 } },
      { matchId: 'TD-1', seq: 6, from: 'p2' },
    );
    expect(ice.payload.candidate?.sdpMid).toBe('0');
    const end = buildMessage('MEDIA_SIGNAL', { to: 'p1', kind: 'ice', candidate: { candidate: '', sdpMid: null, sdpMLineIndex: null } }, { matchId: 'TD-1', seq: 7, from: 'p2' });
    expect(end.payload.candidate?.candidate).toBe('');
    expect(() => buildMessage('MEDIA_SIGNAL', { to: 'p2', kind: 'answer' }, { matchId: 'TD-1', seq: 8, from: 'p1' })).toThrow(ProtocolError);
    expect(() => buildMessage('MEDIA_SIGNAL', { to: 'p2', kind: 'ice', sdp: 'v=0' }, { matchId: 'TD-1', seq: 9, from: 'p1' })).toThrow(ProtocolError);
    expect(() => buildMessage('MEDIA_SIGNAL', { to: 'not a player id', kind: 'offer', sdp: 'v=0' }, { matchId: 'TD-1', seq: 10, from: 'p1' })).toThrow(ProtocolError);
    expect(MESSAGE_DIRECTION.MEDIA_SIGNAL).toBe('any');
  });

  it('PARTICIPANT_UPDATE: rig and game both optional, client -> host (A6, 2026-10-31)', () => {
    const rigOnly = buildMessage('PARTICIPANT_UPDATE', { rig: 'vr_headset' }, { matchId: 'TD-1', seq: 3, from: 'p2', ts: 1 });
    expect(decodeFrame(encodeFrame(rigOnly))).toEqual(rigOnly);
    expect(buildMessage('PARTICIPANT_UPDATE', {}, { matchId: 'TD-1', seq: 4, from: 'p2' }).payload).toEqual({});
    expect(() => buildMessage('PARTICIPANT_UPDATE', { rig: 'quest' as never }, { matchId: 'TD-1', seq: 5, from: 'p2' })).toThrow(ProtocolError);
    expect(() => buildMessage('PARTICIPANT_UPDATE', { game: { kind: 'vpx' } as never }, { matchId: 'TD-1', seq: 6, from: 'p2' })).toThrow(ProtocolError);
    expect(MESSAGE_DIRECTION.PARTICIPANT_UPDATE).toBe('client->host');
  });

  it('has a direction for every message type', () => {
    for (const t of MESSAGE_TYPES) expect(MESSAGE_DIRECTION[t]).toBeTruthy();
  });
});
