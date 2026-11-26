/**
 * A17 step 5 (2026-11-25): the lobby's shapes (alpha-match.md §11.7). Two things are pinned here: what each new
 * message and key takes and refuses, and that nothing new is ever put into a frame by the schema itself: every new
 * key is optional with no default, so a frame built without a lobby is the frame a 0.2.50 peer builds, and the
 * protocol version can stay 6 until the lobby is turned on.
 */
import { describe, expect, it } from 'vitest';
import {
  buildMessage,
  decodeFrame,
  encodeFrame,
  MATCH_LOG_PAGE_SIZE,
  MESSAGE_DIRECTION,
  MESSAGE_TYPES,
  parseMessage,
  ProtocolError,
  PROTOCOL_VERSION,
  Stance,
  type GameFingerprint,
  type ParticipantInfo,
} from '../src/index.js';

const hex64 = 'ab'.repeat(32);
const b64key = Buffer.alloc(32, 7).toString('base64');
const b64sig = Buffer.alloc(64, 9).toString('base64');
const fingerprint: GameFingerprint = { kind: 'vpx', tableName: 'Monster Bash (Williams 1998)', tableHash: hex64, romName: 'mb_106b', romHash: hex64, physicsHash: null, recipeVersion: '0.5.0', sidecarHash: hex64, emulatorVersion: '10.8.0' };
const participant: ParticipantInfo = { playerId: 'p1', displayName: 'Player One', publicKey: b64key, rig: 'pc' };
const at = { matchId: 'JHDFEF', seq: 1, from: 'p1', ts: 1 };
const entry = (index: number) => ({ index, prevHash: hex64, ts: 5, kind: 'msg' as const, from: 'p1', message: buildMessage('RESUME', {}, { ...at, matchId: 'JHDFEF-1' }) as unknown as Record<string, unknown>, hash: hex64 });

describe('A17: the lobby in the schemas (protocol 7 since step 7, when the shell turned the lobby on)', () => {
  it('the version is 7, and the seven new types have a direction', () => {
    expect(PROTOCOL_VERSION).toBe(7);
    const added = ['START_REQUEST', 'START_CANCEL', 'END_REQUEST', 'TABLE_PICK', 'LOBBY_CLOSED', 'MATCH_LOG', 'LEAVE_LOBBY'] as const;
    for (const t of added) expect(MESSAGE_TYPES).toContain(t);
    expect(added.map((t) => MESSAGE_DIRECTION[t])).toEqual(['client->host', 'client->host', 'client->host', 'client->host', 'host->all', 'host->client', 'client->host']);
    expect(Stance.options).toEqual(['play', 'watch']);
  });

  it('every new key is optional and none is defaulted: a frame built without them does not carry them', () => {
    const hello = buildMessage('HELLO', { protocolVersion: PROTOCOL_VERSION, companionVersion: '0.2.50', throwdownCode: 'JHDFEF', participant, game: fingerprint }, { ...at, matchId: null });
    expect(Object.keys(hello.payload)).toEqual(['protocolVersion', 'companionVersion', 'throwdownCode', 'participant', 'game']);
    const update = buildMessage('PARTICIPANT_UPDATE', { rig: 'vr_headset' }, at);
    expect(Object.keys(update.payload)).toEqual(['rig']);
    const ack = buildMessage('HELLO_ACK', { hostPlayerId: 'p1', hostPublicKey: b64key, participants: [participant] }, { ...at, matchId: null });
    for (const key of ['stances', 'away', 'noCopy', 'ownGame', 'otherTable', 'tablePickedBy', 'ballsPerGame', 'starter', 'match', 'start']) expect(Object.keys(ack.payload)).not.toContain(key);
    const end = buildMessage('MATCH_END', { games: 2, reason: 'done' }, at);
    expect(Object.keys(end.payload)).toEqual(['games', 'reason']);
    const reconnect = buildMessage('RECONNECT', { player: 'p1', logHash: hex64, logLength: 0, signature: b64sig }, at);
    expect(Object.keys(reconnect.payload)).toEqual(['player', 'logHash', 'logLength', 'signature']);
    expect(Object.keys(hello.payload)).not.toContain('proof');
    const back = buildMessage('RECONNECT_ACK', { accept: true, code: null, entries: [], logHash: hex64, logLength: 0 }, at);
    expect(Object.keys(back.payload)).toEqual(['accept', 'code', 'entries', 'logHash', 'logLength']);
    // And each of those, on the wire and back, is the same text.
    for (const m of [hello, update, ack, end, reconnect, back]) expect(encodeFrame(decodeFrame(encodeFrame(m)))).toBe(encodeFrame(m));
  });

  it('HELLO and PARTICIPANT_UPDATE: Play or Watch, and the two facts about a member`s table', () => {
    const hello = buildMessage('HELLO', { protocolVersion: PROTOCOL_VERSION, companionVersion: '0.2.51', throwdownCode: 'JHDFEF', participant, game: fingerprint, stance: 'watch' }, { ...at, matchId: null });
    expect(decodeFrame(encodeFrame(hello))).toEqual(hello);
    expect(hello.payload.stance).toBe('watch');
    expect(() => buildMessage('HELLO', { protocolVersion: PROTOCOL_VERSION, companionVersion: '0.2.51', throwdownCode: 'JHDFEF', participant, game: fingerprint, stance: 'alone' as never }, { ...at, matchId: null })).toThrow(ProtocolError);
    const update = buildMessage('PARTICIPANT_UPDATE', { stance: 'play', noCopy: true, ownGame: false }, at);
    expect(update.payload).toEqual({ stance: 'play', noCopy: true, ownGame: false });
    expect(decodeFrame(encodeFrame(update))).toEqual(update);
  });

  it('HELLO_ACK: the lobby as it is, with the open match and an announced start', () => {
    const ack = buildMessage(
      'HELLO_ACK',
      {
        hostPlayerId: 'p1',
        hostPublicKey: b64key,
        participants: [participant, { ...participant, playerId: 'p2' }, { ...participant, playerId: 'p3' }],
        stances: [
          { playerId: 'p1', stance: 'watch' },
          { playerId: 'p2', stance: 'play' },
          { playerId: 'p3', stance: 'play' },
        ],
        away: ['p3'],
        noCopy: [],
        ownGame: ['p2'],
        otherTable: [],
        tablePickedBy: 'p2',
        ballsPerGame: 3,
        starter: 'p2',
        match: { matchId: 'JHDFEF-2', players: ['p2', 'p3'], game: 1, state: 'between' },
        start: { by: 'p2', players: ['p2', 'p3'], newMatch: false, waitsFor: 'tables', waitsOn: ['p3'], leftMs: null },
      },
      { ...at, matchId: null },
    );
    expect(decodeFrame(encodeFrame(ack))).toEqual(ack);
    expect(ack.payload.match?.state).toBe('between');
    // No match open and no start announced are said with null.
    const quiet = buildMessage('HELLO_ACK', { hostPlayerId: 'p1', hostPublicKey: b64key, participants: [participant], stances: [], match: null, start: null, starter: null }, { ...at, matchId: null });
    expect([quiet.payload.match, quiet.payload.start, quiet.payload.starter]).toEqual([null, null, null]);
    // A match has two to four players, a countdown at most two minutes.
    const base = { hostPlayerId: 'p1', hostPublicKey: b64key, participants: [participant] };
    expect(() => buildMessage('HELLO_ACK', { ...base, match: { matchId: 'JHDFEF-1', players: ['p1'], game: 1, state: 'game' } }, { ...at, matchId: null })).toThrow(ProtocolError);
    expect(() => buildMessage('HELLO_ACK', { ...base, match: { matchId: 'JHDFEF-1', players: ['p1', 'p2'], game: 1, state: 'lobby' as never } }, { ...at, matchId: null })).toThrow(ProtocolError);
    expect(() => buildMessage('HELLO_ACK', { ...base, start: { by: 'p1', players: ['p1', 'p2'], newMatch: true, waitsFor: null, leftMs: 120_001 } }, { ...at, matchId: null })).toThrow(ProtocolError);
    const counting = buildMessage('HELLO_ACK', { ...base, start: { by: 'p1', players: ['p1', 'p2'], newMatch: true, waitsFor: null, leftMs: 5000 } }, { ...at, matchId: null });
    expect(counting.payload.start?.waitsOn).toEqual([]);
  });

  it('MATCH_END: a match with no finished game says 0, and the game that was ended for everyone', () => {
    const end = buildMessage('MATCH_END', { games: 0, reason: 'ended for everyone', abandoned: 1 }, { ...at, matchId: 'JHDFEF-1' });
    expect(decodeFrame(encodeFrame(end))).toEqual(end);
    expect(end.payload.abandoned).toBe(1);
    expect(() => buildMessage('MATCH_END', { games: -1, reason: 'x' }, at)).toThrow(ProtocolError);
    expect(() => buildMessage('MATCH_END', { games: 1, reason: 'x', abandoned: 0 }, at)).toThrow(ProtocolError);
  });

  it('MATCH_LOG: a page of at most 100 entries, verbatim, with the head and whether more follows', () => {
    expect(MATCH_LOG_PAGE_SIZE).toBe(100);
    const page = buildMessage('MATCH_LOG', { match: 'JHDFEF-1', restart: true, entries: [entry(0), entry(1)], logHash: hex64, logLength: 2, more: false }, at);
    const back = decodeFrame(encodeFrame(page));
    expect(back).toEqual(page);
    if (back.type === 'MATCH_LOG') expect(back.payload.entries[1]?.message).toEqual(entry(1).message);
    const full = Array.from({ length: 100 }, (_, i) => entry(i));
    expect(buildMessage('MATCH_LOG', { match: 'JHDFEF-1', restart: false, entries: full, logHash: hex64, logLength: 250, more: true }, at).payload.entries).toHaveLength(100);
    expect(() => buildMessage('MATCH_LOG', { match: 'JHDFEF-1', restart: false, entries: [...full, entry(100)], logHash: hex64, logLength: 250, more: true }, at)).toThrow(ProtocolError);
    expect(() => buildMessage('MATCH_LOG', { match: 'JHDFEF-1', entries: [], logHash: hex64, logLength: 0, more: false } as never, at)).toThrow(ProtocolError);
    // A page of 100 ordinary entries is far under the relay's 256 KB a frame.
    expect(Buffer.byteLength(encodeFrame(buildMessage('MATCH_LOG', { match: 'JHDFEF-1', restart: true, entries: full, logHash: hex64, logLength: 100, more: false }, at)), 'utf8')).toBeLessThan(64 * 1024);
  });

  it('RECONNECT and RECONNECT_ACK: the match a member holds, and an answer that is only the first page', () => {
    const reconnect = buildMessage('RECONNECT', { player: 'p1', logHash: hex64, logLength: 4, signature: b64sig, resends: true, match: 'JHDFEF-1' }, at);
    expect(decodeFrame(encodeFrame(reconnect))).toEqual(reconnect);
    expect(buildMessage('RECONNECT', { player: 'p1', logHash: hex64, logLength: 0, signature: b64sig, match: null }, at).payload.match).toBeNull();
    const ack = buildMessage('RECONNECT_ACK', { accept: true, code: null, entries: [entry(4)], logHash: hex64, logLength: 250, match: 'JHDFEF-1', restart: false, more: true }, at);
    expect(decodeFrame(encodeFrame(ack))).toEqual(ack);
    expect([ack.payload.match, ack.payload.restart, ack.payload.more]).toEqual(['JHDFEF-1', false, true]);
  });

  it('step 6: a start that was taken away says why, once; and the two codes only a lobby answers a RECONNECT with', () => {
    const base = { hostPlayerId: 'p1', hostPublicKey: b64key, participants: [participant] };
    const off = buildMessage('HELLO_ACK', { ...base, start: null, startOff: 'Krobs cancelled the start.' }, { ...at, matchId: null });
    expect(decodeFrame(encodeFrame(off))).toEqual(off);
    expect(off.payload.startOff).toBe('Krobs cancelled the start.');
    expect(Object.keys(buildMessage('HELLO_ACK', base, { ...at, matchId: null }).payload)).not.toContain('startOff');
    // As long as a REJECT's sentence may be (500): the refusal of a start names people, and names can be long.
    expect(buildMessage('HELLO_ACK', { ...base, startOff: 'x'.repeat(500) }, { ...at, matchId: null }).payload.startOff).toHaveLength(500);
    expect(() => buildMessage('HELLO_ACK', { ...base, startOff: 'x'.repeat(501) }, { ...at, matchId: null })).toThrow(ProtocolError);
    for (const code of ['stale_seq', 'protocol_version'] as const) {
      const no = buildMessage('RECONNECT_ACK', { accept: false, code, entries: [], logHash: '0'.repeat(64), logLength: 0 }, at);
      expect(decodeFrame(encodeFrame(no))).toEqual(no);
    }
    expect(() => buildMessage('RECONNECT_ACK', { accept: false, code: 'replayed' as never, entries: [], logHash: hex64, logLength: 0 }, at)).toThrow(ProtocolError);
    // The lobby's answer that puts a member's log away: no match, or another one, and no log in the answer itself.
    const restart = buildMessage('RECONNECT_ACK', { accept: true, code: null, entries: [], logHash: '0'.repeat(64), logLength: 0, match: null, restart: true }, at);
    expect([restart.payload.restart, restart.payload.match]).toEqual([true, null]);
  });

  it('the review of step 6: Leave lobby, a signed HELLO, and the two keys of a lobby`s RECONNECT_ACK', () => {
    const leave = buildMessage('LEAVE_LOBBY', {}, at);
    expect(decodeFrame(encodeFrame(leave))).toEqual(leave);
    expect(leave.payload).toEqual({});
    const hello = buildMessage('HELLO', { protocolVersion: PROTOCOL_VERSION, companionVersion: '0.2.51', throwdownCode: 'JHDFEF', participant, game: fingerprint, stance: 'play', proof: b64sig }, { ...at, matchId: null });
    expect(decodeFrame(encodeFrame(hello))).toEqual(hello);
    expect(() => buildMessage('HELLO', { protocolVersion: PROTOCOL_VERSION, companionVersion: '0.2.51', throwdownCode: 'JHDFEF', participant, game: fingerprint, proof: 'not base64 !' }, { ...at, matchId: null })).toThrow(ProtocolError);
    // The match the member held is over: the answer brings it to its end, and says so.
    const closed = buildMessage('RECONNECT_ACK', { accept: true, code: null, entries: [entry(4)], logHash: hex64, logLength: 5, match: null, closed: true }, at);
    expect(decodeFrame(encodeFrame(closed))).toEqual(closed);
    // A counter that fell behind: where the lobby's stands.
    const stale = buildMessage('RECONNECT_ACK', { accept: false, code: 'stale_seq', entries: [], logHash: '0'.repeat(64), logLength: 0, seqAbove: 1_795_000_000_123 }, at);
    expect(decodeFrame(encodeFrame(stale))).toEqual(stale);
    expect(() => buildMessage('RECONNECT_ACK', { accept: false, code: 'stale_seq', entries: [], logHash: hex64, logLength: 0, seqAbove: -1 }, at)).toThrow(ProtocolError);
  });

  it('what a member asks of the lobby, and its end: START_REQUEST, START_CANCEL, END_REQUEST, TABLE_PICK, LOBBY_CLOSED', () => {
    const start = buildMessage('START_REQUEST', { fromTable: true }, at);
    expect(start.payload).toEqual({ fromTable: true, newMatch: false, anyway: false, now: false });
    expect(decodeFrame(encodeFrame(buildMessage('START_REQUEST', { fromTable: false, newMatch: true, anyway: true, now: true }, at))).payload).toEqual({ fromTable: false, newMatch: true, anyway: true, now: true });
    expect(() => buildMessage('START_REQUEST', {} as never, at)).toThrow(ProtocolError);
    expect(buildMessage('START_CANCEL', {}, at).payload).toEqual({});
    expect(buildMessage('END_REQUEST', {}, at).payload).toEqual({});
    // A pick is the table's identity; the facts of one PC's copy are null or empty in it.
    const pick = buildMessage('TABLE_PICK', { game: { ...fingerprint, romHash: null, recipeVersion: null, sidecarHash: null, emulatorVersion: '' } }, at);
    expect(decodeFrame(encodeFrame(pick))).toEqual(pick);
    expect(() => buildMessage('TABLE_PICK', {} as never, at)).toThrow(ProtocolError);
    const closed = buildMessage('LOBBY_CLOSED', { reason: 'good night' }, at);
    expect(decodeFrame(encodeFrame(closed))).toEqual(closed);
    expect(() => buildMessage('LOBBY_CLOSED', { reason: 'x'.repeat(201) }, at)).toThrow(ProtocolError);
  });

  it('a frame of a type this version does not know still does not decode (why none of the six is sent while the lobby is off)', () => {
    const closed = buildMessage('LOBBY_CLOSED', { reason: 'x' }, at);
    expect(() => parseMessage({ ...closed, type: 'LOBBY_OPENED' })).toThrow(ProtocolError);
  });
});
