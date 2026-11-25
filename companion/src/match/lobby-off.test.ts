/**
 * A17 step 5 (2026-11-25): the lobby is behind an option, and with the option off the engine is the engine it was.
 * The proof is not "the old tests still pass" alone: `lobby-off.frames.json` holds every frame of one scripted match
 * (`lobby-off.test-support.ts`: 108 frames, 22 message types, a reconnect inside the grace and one after it) as the
 * engine built them on commit 55ff0a0, the commit this step started from, before any of its changes. This test plays
 * the same script on the tree as it is and compares the text of every frame. A new key that is sent without a lobby,
 * a default that is filled in, a frame more or less, a different order: any of them fails it.
 *
 * So a build with the lobby off still plays with 0.2.46 to 0.2.50, which is why the protocol version did not change.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MESSAGE_TYPES, PROTOCOL_VERSION, buildMessage, parseMessage } from '@castcade/protocol';
import { recordOptionOffMatch } from './lobby-off.test-support.js';

interface Recorded {
  by: string;
  to: string;
  msg: { type: string; payload: Record<string, unknown> };
}

const recorded = JSON.parse(readFileSync(new URL('./lobby-off.frames.json', import.meta.url), 'utf8')) as Recorded[];
/** What step 5 added to the protocol: none of it may be on the wire of a match played without a lobby. */
const LOBBY_TYPES = ['START_REQUEST', 'START_CANCEL', 'END_REQUEST', 'TABLE_PICK', 'LOBBY_CLOSED', 'MATCH_LOG'];
const LOBBY_KEYS: Record<string, string[]> = {
  HELLO: ['stance'],
  PARTICIPANT_UPDATE: ['stance', 'noCopy', 'ownGame'],
  HELLO_ACK: ['stances', 'away', 'noCopy', 'ownGame', 'otherTable', 'tablePickedBy', 'ballsPerGame', 'starter', 'match', 'start'],
  MATCH_END: ['abandoned'],
  RECONNECT: ['match'],
  RECONNECT_ACK: ['match', 'restart', 'more'],
};

describe('A17 step 5: with the lobby off, every frame is the frame it was', () => {
  it('a whole scripted match sends, byte for byte, the frames recorded before the lobby was built', async () => {
    const now = await recordOptionOffMatch();
    expect(recorded.length).toBe(108);
    expect(now.length).toBe(recorded.length);
    for (let i = 0; i < recorded.length; i++) {
      const was = recorded[i] as Recorded;
      const is = now[i];
      expect(`${i}: ${is?.by} -> ${is?.to}`).toBe(`${i}: ${was.by} -> ${was.to}`);
      expect(is?.frame, `frame ${i} (${was.msg.type}, ${was.by} -> ${was.to})`).toBe(JSON.stringify(was.msg));
    }
  });

  it('the recording is a match worth comparing: it holds every message type there was before the lobby', () => {
    const seen = new Set(recorded.map((f) => f.msg.type));
    const before = MESSAGE_TYPES.filter((t) => !LOBBY_TYPES.includes(t));
    // HOST_TRANSFER and its ack need a transfer, which the four-player transfer scenarios play (untouched by this step).
    expect(before.filter((t) => !seen.has(t)).sort()).toEqual(['HOST_TRANSFER', 'HOST_TRANSFER_ACK']);
    expect(PROTOCOL_VERSION).toBe(6);
  });

  it('none of the new message types and none of the new keys is in it, and none appears when it is played now', async () => {
    const now = await recordOptionOffMatch();
    for (const f of now) {
      const msg = JSON.parse(f.frame) as { type: string; payload: Record<string, unknown> };
      expect(LOBBY_TYPES).not.toContain(msg.type);
      for (const key of LOBBY_KEYS[msg.type] ?? []) expect(Object.keys(msg.payload), `${msg.type}.${key}`).not.toContain(key);
    }
  });

  it('a peer that builds a frame without the new keys gets none of them back from the schema (nothing is defaulted in)', () => {
    // What a 0.2.50 host sends, parsed by this build and written again, is the same text: no key is added on the way.
    for (const f of recorded) {
      const text = JSON.stringify(f.msg);
      expect(JSON.stringify(parseMessage(JSON.parse(text))), f.msg.type).toBe(text);
    }
    // And built here from the smallest input, the six messages that gained keys carry none of them.
    const hex = 'ab'.repeat(32);
    const end = buildMessage('MATCH_END', { games: 1, reason: 'x' }, { matchId: 'M', seq: 1, from: 'h', ts: 1 });
    expect(Object.keys(end.payload)).toEqual(['games', 'reason']);
    const ack = buildMessage('RECONNECT_ACK', { accept: true, code: null, entries: [], logHash: hex, logLength: 0 }, { matchId: 'M', seq: 1, from: 'h', ts: 1 });
    expect(Object.keys(ack.payload)).toEqual(['accept', 'code', 'entries', 'logHash', 'logLength']);
    const helloAck = buildMessage('HELLO_ACK', { hostPlayerId: 'h', hostPublicKey: Buffer.alloc(32, 1).toString('base64'), participants: [] }, { matchId: null, seq: 1, from: 'h', ts: 1 });
    for (const key of LOBBY_KEYS['HELLO_ACK'] ?? []) expect(Object.keys(helloAck.payload)).not.toContain(key);
  });
});
