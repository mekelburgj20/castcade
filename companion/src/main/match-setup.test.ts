import { describe, expect, it } from 'vitest';
import type { NetworkInterfaceInfo } from 'node:os';
import type { GameFingerprint, ParticipantInfo } from '@castcade/protocol';
import { ClientMatch } from '../match/client.js';
import { HostMatch } from '../match/host.js';
import { generateKeys, signCanonical, verifyCanonical, type KeyPair } from '../match/keys.js';
import { MemoryBus } from '../match/transport.js';
import type { MediaSignal } from '../media/match-media-types.js';
import type { WitnessStatus } from '../witness/types.js';
import {
  DEFAULT_MATCH_SETTINGS,
  decideRig,
  formatInvite,
  gameFingerprintFrom,
  lockPathFrom,
  matchSignalling,
  newMatchCode,
  newMatchIdentity,
  parseInvite,
  parseMatchIdentity,
  patchMatchSettings,
  pickLanAddress,
  readMatchSettings,
  rigFrom,
  rigFromStatus,
  serializeMatchIdentity,
  writeMatchSettings,
  ZERO_SHA256,
} from './match-setup.js';

const status = (over: Partial<WitnessStatus> = {}): WitnessStatus =>
  ({ paired: true, running: true, currentTable: null, currentIdentity: null, currentAttestation: null, ...over }) as WitnessStatus;

describe('match setup (A6)', () => {
  it('invites round-trip, tolerate the wrapping a chat adds, and refuse anything else', () => {
    const inv = formatInvite('203.0.113.7', 27401, 'ABCDEF');
    expect(inv).toBe('castcade:ws://203.0.113.7:27401#ABCDEF');
    expect(parseInvite(inv)).toEqual({ url: 'ws://203.0.113.7:27401', host: '203.0.113.7', port: 27401, code: 'ABCDEF' });
    expect(parseInvite(` \`${inv}\` `).code).toBe('ABCDEF');
    expect(parseInvite('castcade:ws://192.168.1.20:27401#abcdef').code).toBe('ABCDEF');
    for (const bad of ['', 'ws://1.2.3.4:27401#ABCDEF', 'castcade:ws://1.2.3.4#ABCDEF', 'castcade:ws://1.2.3.4:27401#ABC', 'castcade:ws://1.2.3.4:99999#ABCDEF', 'castcade:http://1.2.3.4:1#ABCDEF']) {
      expect(() => parseInvite(bad), bad).toThrow(/not a Castcade invite/);
    }
  });

  it('match codes are six letters from the alphabet without I and O', () => {
    for (let i = 0; i < 50; i++) expect(newMatchCode()).toMatch(/^[A-HJ-NP-Z]{6}$/);
    expect(newMatchCode(() => 0)).toBe('AAAAAA');
  });

  it('settings default, clamp and round-trip', () => {
    expect(readMatchSettings(null)).toEqual(DEFAULT_MATCH_SETTINGS);
    expect(readMatchSettings('not json')).toEqual(DEFAULT_MATCH_SETTINGS);
    const s = patchMatchSettings(DEFAULT_MATCH_SETTINGS, { port: '28000', ballsPerGame: 5, displayName: '  Krobs  ', cueVolume: 140 });
    expect(s).toEqual({ port: 28000, ballsPerGame: 5, displayName: 'Krobs', cueVolume: 100, theaterDuringMyTurn: 'hidden', spectate: 'theater' });
    expect(patchMatchSettings(s, { port: 80, ballsPerGame: 4, displayName: '' })).toEqual({ ...s, displayName: null });
    expect(readMatchSettings(writeMatchSettings(s))).toEqual(s);
  });

  it('D7.4: the headset settings default to hidden on my ball and theater on theirs; only their values patch; they round-trip', () => {
    expect(DEFAULT_MATCH_SETTINGS).toMatchObject({ theaterDuringMyTurn: 'hidden', spectate: 'theater' });
    const s = patchMatchSettings(DEFAULT_MATCH_SETTINGS, { theaterDuringMyTurn: 'panel', spectate: 'panel' });
    expect(s).toMatchObject({ theaterDuringMyTurn: 'panel', spectate: 'panel' });
    expect(patchMatchSettings(s, { theaterDuringMyTurn: 'theater', spectate: 'hidden' })).toEqual(s);
    expect(readMatchSettings(writeMatchSettings(s))).toEqual(s);
    // A match.json from before D7.4 reads with the defaults.
    expect(readMatchSettings('{"v":1,"port":27401,"ballsPerGame":3,"displayName":null,"cueVolume":80}')).toEqual(DEFAULT_MATCH_SETTINGS);
  });

  it('match keys survive a save and still sign', () => {
    const id = newMatchIdentity();
    const back = parseMatchIdentity(serializeMatchIdentity(id));
    expect(back?.installId).toBe(id.installId);
    expect(back?.keys.publicKeyB64).toBe(id.keys.publicKeyB64);
    const sig = signCanonical({ a: 1 }, back!.keys.privateKey);
    expect(verifyCanonical({ a: 1 }, sig, id.keys.publicKeyB64)).toBe(true);
    expect(parseMatchIdentity('{"installId":"x","privateKey":"junk"}')).toBeNull();
    expect(parseMatchIdentity(null)).toBeNull();
  });

  it('the fingerprint uses the table file facts, zeros when no table is known', () => {
    expect(gameFingerprintFrom(status(), '0.3.1')).toEqual({
      kind: 'vpx',
      tableName: 'no table open',
      tableHash: ZERO_SHA256,
      romName: null,
      romHash: null,
      physicsHash: null,
      recipeVersion: '0.3.1',
      sidecarHash: null,
      emulatorVersion: 'unknown',
    });
    const fp = gameFingerprintFrom(
      status({
        currentTable: 'Monster Bash (Williams 1998)',
        currentIdentity: { sha256: 'AB'.repeat(32), tableInfo: { tableName: 'Monster Bash' } } as WitnessStatus['currentIdentity'],
        currentAttestation: { build: { vpx: { version: { fileVersionText: '10.8.0.2051' } } }, vr: { inVr: true } } as unknown as WitnessStatus['currentAttestation'],
      }),
      '0.3.1',
    );
    expect(fp).toMatchObject({ tableName: 'Monster Bash', tableHash: 'ab'.repeat(32), emulatorVersion: '10.8.0.2051' });
  });

  it('B22 (2026-10-31): the rig decision carries the VR runtime; a sample from before B22 reads SteamVR', async () => {
    const vd = { inVr: true, runtime: 'virtual-desktop', runtimeLoaded: false, compositorRunning: false, vrCapableBuild: true, activeOpenXrRuntime: null, sampledAt: 't' } as const;
    const w = (now: unknown, vr: unknown = null) => ({ status: () => status({ currentAttestation: (vr ? { vr } : null) as WitnessStatus['currentAttestation'] }), sampleVr: async () => now as never });
    expect(await decideRig(w(vd))).toMatchObject({ rig: 'vr_headset', runtime: 'virtual-desktop' });
    expect(await decideRig(w({ ...vd, inVr: false, runtime: null }))).toMatchObject({ rig: 'pc', runtime: null });
    expect(await decideRig(w(null, { inVr: true, runtimeLoaded: true, compositorRunning: true, sampledAt: 't' }))).toMatchObject({ rig: 'vr_headset', runtime: 'steamvr' });
    expect(rigFromStatus(status())).toEqual({ rig: 'pc', reason: 'no VPX table open to probe; monitor assumed', runtime: null });
  });

  it('rig, LAN address and lock path', () => {
    expect(rigFrom(status())).toBe('pc');
    expect(rigFrom(status({ currentAttestation: { vr: { inVr: true } } as unknown as WitnessStatus['currentAttestation'] }))).toBe('vr_headset');
    const nic = (address: string, internal = false, family: 'IPv4' | 'IPv6' = 'IPv4'): NetworkInterfaceInfo =>
      ({ address, internal, family, netmask: '', mac: '', cidr: null }) as NetworkInterfaceInfo;
    expect(pickLanAddress({ lo: [nic('127.0.0.1', true)], wifi: [nic('fe80::1', false, 'IPv6'), nic('169.254.3.4'), nic('192.168.1.20')] })).toBe('192.168.1.20');
    expect(pickLanAddress({ lo: [nic('127.0.0.1', true)] })).toBeNull();
    expect(lockPathFrom({ LOCALAPPDATA: 'C:\\Users\\p\\AppData\\Local' })).toBe('C:\\Users\\p\\AppData\\Local\\Castcade\\lock\\turn.lock');
    expect(lockPathFrom({ TEMP: 'C:\\Temp' })).toBe('C:\\Temp\\Castcade\\lock\\turn.lock');
    expect(lockPathFrom({})).toBe('C:\\Castcade\\Castcade\\lock\\turn.lock');
  });

  it('signalling: holds what lands before the media layer listens, then delivers live, without the envelope (D2)', async () => {
    const flush = async (): Promise<void> => {
      for (let i = 0; i < 6; i++) await new Promise<void>((r) => setTimeout(r, 0));
    };
    const game: GameFingerprint = gameFingerprintFrom(status(), '0.3.1');
    const who = (id: string, keys: KeyPair): ParticipantInfo => ({ playerId: id, displayName: id, publicKey: keys.publicKeyB64, rig: 'pc' });
    const bus = new MemoryBus();
    const hk = generateKeys();
    const ck = generateKeys();
    const host = new HostMatch({ transport: bus.transport('h'), keys: hk, matchId: 'M', ballsPerGame: 1, hostParticipant: who('h', hk), hostGame: game });
    const client = new ClientMatch({ transport: bus.transport('c'), keys: ck, participant: who('c', ck), game, throwdownCode: 'M', hostId: 'h' });
    const hs = matchSignalling(host, 'h');
    const cs = matchSignalling(client, 'c');
    client.join();
    await flush();
    host.start();
    await flush();
    const offer: MediaSignal = { kind: 'offer', sdp: 'v=0' };
    const ice: MediaSignal = { kind: 'ice', candidate: { candidate: 'candidate:1 1 udp 1 10.0.0.2 5 typ host', sdpMid: '0', sdpMLineIndex: 0 } };
    hs.send('c', offer);
    hs.send('c', ice);
    await flush();
    const got: Array<[string, MediaSignal]> = [];
    const off = cs.onSignal((from, s) => got.push([from, s]));
    expect(got).toEqual([
      ['h', offer],
      ['h', ice],
    ]);
    const atHost: Array<[string, MediaSignal]> = [];
    hs.onSignal((from, s) => atHost.push([from, s]));
    cs.send('h', { kind: 'answer', sdp: 'v=0 answer' });
    await flush();
    expect(atHost).toEqual([['c', { kind: 'answer', sdp: 'v=0 answer' }]]);
    off();
    hs.send('c', offer);
    await flush();
    expect(got).toHaveLength(2);
    cs.onSignal((from, s) => got.push([from, s]));
    expect(got).toHaveLength(3);
    client.close();
    host.close();
  });
});
