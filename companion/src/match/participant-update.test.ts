/**
 * A6 (2026-10-31, the first two-player match): a client that joined before its table loaded said `pc` and no table in
 * HELLO. PARTICIPANT_UPDATE corrects both in the lobby: the host re-compares the fingerprint, re-sends HELLO_ACK to
 * every client, and both sides' flags follow. The host's own correction (`updateLocal`) does the same. After
 * MATCH_READY nothing changes, and none of it is logged.
 */
import { describe, expect, it } from 'vitest';
import type { GameFingerprint, PayloadOf, PlayerId, ParticipantInfo } from '@castcade/protocol';
import { ClientMatch } from './client.js';
import { ManualClock } from './clock.js';
import { HostMatch, type RejectInfo } from './host.js';
import { generateKeys, type KeyPair } from './keys.js';
import { MemoryBus } from './transport.js';

const flush = async (n = 6): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setTimeout(r, 0));
};

const MB: GameFingerprint = { kind: 'vpx', tableName: 'Monster Bash', tableHash: 'ab'.repeat(32), romName: null, romHash: null, physicsHash: null, recipeVersion: '0.4.0', sidecarHash: null, emulatorVersion: '10.8.0' };
const OTHER: GameFingerprint = { ...MB, tableHash: 'cd'.repeat(32) };
/** What `gameFingerprintFrom` gives with no table open (match-setup.ts). */
const NO_TABLE: GameFingerprint = { ...MB, tableName: 'no table open', tableHash: '0'.repeat(64) };
const participant = (id: string, keys: KeyPair, rig: ParticipantInfo['rig']): ParticipantInfo => ({ playerId: id, displayName: id, publicKey: keys.publicKeyB64, rig });

type Seen = { mismatch: Array<{ playerId: PlayerId; fields: string[] }>; rosters: Array<PayloadOf<'HELLO_ACK'>> };

async function lobby(opts: { hostGame?: GameFingerprint; policy?: 'refuse' | 'advise'; clients: Array<{ id: string; game: GameFingerprint; rig?: ParticipantInfo['rig'] }> }) {
  const bus = new MemoryBus();
  const clock = new ManualClock();
  const hostKeys = generateKeys();
  const host = new HostMatch({
    transport: bus.transport('h'),
    keys: hostKeys,
    matchId: 'M',
    ballsPerGame: 1,
    hostParticipant: participant('h', hostKeys, 'pc'),
    hostGame: opts.hostGame ?? MB,
    fingerprintPolicy: opts.policy ?? 'advise',
    clock,
  });
  const hostSeen: Seen = { mismatch: [], rosters: [] };
  const updated: ParticipantInfo[] = [];
  const rejects: RejectInfo[] = [];
  host.on('tableMismatch', (m) => hostSeen.mismatch.push({ playerId: m.playerId, fields: m.mismatches.map((x) => x.field) }));
  host.on('participantUpdated', (p) => updated.push(p));
  host.on('reject', (r) => rejects.push(r));
  const clients: Record<string, ClientMatch> = {};
  const seen: Record<string, Seen> = {};
  for (const c of opts.clients) {
    const k = generateKeys();
    const cm = new ClientMatch({ transport: bus.transport(c.id), keys: k, participant: participant(c.id, k, c.rig ?? 'pc'), game: c.game, throwdownCode: 'M', hostId: 'h', clock });
    const s: Seen = { mismatch: [], rosters: [] };
    cm.on('tableMismatch', (m) => s.mismatch.push({ playerId: m.playerId, fields: m.mismatches.map((x) => x.field) }));
    cm.on('roster', (r) => s.rosters.push(r));
    clients[c.id] = cm;
    seen[c.id] = s;
    cm.join();
    await flush();
  }
  return { host, clients, seen, hostSeen, updated, rejects };
}

const rigOf = (roster: ParticipantInfo[], id: string): string | undefined => roster.find((p) => p.playerId === id)?.rig;

describe('PARTICIPANT_UPDATE (A6, 2026-10-31)', () => {
  it("a client whose table loads after HELLO: the right rig on every roster, and the false mismatch clears on both sides", async () => {
    const r = await lobby({ clients: [{ id: 'krobs', game: NO_TABLE }] });
    const krobs = r.clients['krobs']!;
    expect(Object.keys(r.host.tableMismatches())).toEqual(['krobs']);
    expect(r.seen['krobs']!.mismatch).toEqual([{ playerId: 'krobs', fields: ['tableName', 'tableHash'] }]);

    expect(krobs.updateParticipant({ rig: 'vr_headset', game: MB })).toBe(true);
    await flush();
    expect(rigOf(r.host.roster(), 'krobs')).toBe('vr_headset');
    expect(r.host.tableMismatches()).toEqual({});
    expect(r.hostSeen.mismatch.at(-1)).toEqual({ playerId: 'krobs', fields: [] });
    expect(r.updated.map((p) => [p.playerId, p.rig])).toEqual([['krobs', 'vr_headset']]);
    // The client re-read the roster and re-compared hostGame: no difference now.
    expect(r.seen['krobs']!.rosters).toHaveLength(1);
    expect(rigOf(r.seen['krobs']!.rosters[0]!.participants, 'krobs')).toBe('vr_headset');
    expect(r.seen['krobs']!.mismatch.at(-1)).toEqual({ playerId: 'krobs', fields: [] });
    // Nothing changed: nothing sent. Nothing logged on either side.
    expect(krobs.updateParticipant({ rig: 'vr_headset', game: { ...MB } })).toBe(false);
    expect(r.host.log.length).toBe(0);
    expect(krobs.log.length).toBe(0);

    // MATCH_READY carries the corrected roster.
    r.host.start();
    await flush();
    expect(rigOf(krobs.state.participants, 'krobs')).toBe('vr_headset');
  });

  it('a real mismatch still flags, and re-flags after agreeing; every client gets the re-sent roster', async () => {
    const r = await lobby({ clients: [{ id: 'a', game: NO_TABLE }, { id: 'b', game: MB }] });
    const a = r.clients['a']!;
    a.updateParticipant({ game: OTHER });
    await flush();
    expect(r.host.tableMismatches()['a']?.map((m) => m.field)).toEqual(['tableHash']);
    expect(r.seen['a']!.mismatch.at(-1)).toEqual({ playerId: 'a', fields: ['tableHash'] });
    expect(r.seen['b']!.rosters).toHaveLength(1);
    expect(r.seen['b']!.mismatch).toEqual([]);

    a.updateParticipant({ game: MB });
    await flush();
    expect(r.host.tableMismatches()).toEqual({});
    a.updateParticipant({ game: OTHER });
    await flush();
    expect(Object.keys(r.host.tableMismatches())).toEqual(['a']);
    expect(r.seen['a']!.mismatch.map((m) => m.fields)).toEqual([['tableName', 'tableHash'], ['tableHash'], [], ['tableHash']]);
    expect(r.rejects).toEqual([]);
  });

  it("the host's own table loads after hosting: every client re-compares, the flags clear on both sides", async () => {
    const r = await lobby({ hostGame: NO_TABLE, clients: [{ id: 'krobs', game: MB, rig: 'vr_headset' }] });
    expect(Object.keys(r.host.tableMismatches())).toEqual(['krobs']);
    expect(r.host.updateLocal({ rig: 'vr_headset', game: MB })).toBe(true);
    await flush();
    expect(r.host.tableMismatches()).toEqual({});
    expect(r.hostSeen.mismatch.at(-1)).toEqual({ playerId: 'krobs', fields: [] });
    expect(r.seen['krobs']!.mismatch.at(-1)).toEqual({ playerId: 'krobs', fields: [] });
    expect(rigOf(r.seen['krobs']!.rosters.at(-1)!.participants, 'h')).toBe('vr_headset');
    expect(r.host.updateLocal({ rig: 'vr_headset', game: MB })).toBe(false);
    r.host.start();
    await flush();
    expect(r.clients['krobs']!.state.game).toEqual(MB);
  });

  it('after MATCH_READY: the client sends nothing, the host ignores one sent anyway, the host keeps its own', async () => {
    const r = await lobby({ clients: [{ id: 'krobs', game: NO_TABLE }] });
    const krobs = r.clients['krobs']!;
    r.host.start();
    await flush();
    const before = { roster: r.host.roster(), mismatch: r.host.tableMismatches(), log: r.host.log.length, events: r.hostSeen.mismatch.length };
    expect(krobs.updateParticipant({ rig: 'vr_headset', game: MB })).toBe(false);
    // A client that sends it anyway (an older or a racing one).
    krobs.session.transport.send('h', krobs.session.build('PARTICIPANT_UPDATE', { rig: 'vr_headset', game: MB }, 'M'));
    await flush();
    expect(r.host.roster()).toEqual(before.roster);
    expect(r.host.tableMismatches()).toEqual(before.mismatch);
    expect(r.host.log.length).toBe(before.log);
    expect(r.hostSeen.mismatch).toHaveLength(before.events);
    expect(r.updated).toEqual([]);
    expect(r.rejects).toEqual([]);
    expect(r.seen['krobs']!.rosters).toEqual([]);
    expect(r.host.updateLocal({ rig: 'vr_headset' })).toBe(false);
  });

  it('a refusing host rejects an update whose fingerprint differs and keeps the old one; a rig-only update goes through', async () => {
    const r = await lobby({ policy: 'refuse', clients: [{ id: 'krobs', game: MB }] });
    const krobs = r.clients['krobs']!;
    krobs.updateParticipant({ game: OTHER });
    await flush();
    expect(r.rejects.map((x) => [x.to, x.refType, x.code])).toEqual([['krobs', 'PARTICIPANT_UPDATE', 'unexpected_state']]);
    expect(r.host.tableMismatches()).toEqual({});
    krobs.updateParticipant({ rig: 'vr_headset' });
    await flush();
    expect(rigOf(r.host.roster(), 'krobs')).toBe('vr_headset');
  });
});
