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
  cleanPercent,
  DEFAULT_MATCH_SETTINGS,
  decideRig,
  formatInvite,
  gameFingerprintFrom,
  loadMatchSettings,
  lockPathFrom,
  MATCH_SETTINGS_VERSION,
  matchSignalling,
  newMatchCode,
  newMatchIdentity,
  parseInvite,
  parseMatchIdentity,
  patchMatchSettings,
  pathLine,
  pickLanAddress,
  readMatchSettings,
  RELAY_NOT_PAIRED,
  relayHostNote,
  relayJoinFailure,
  rigFrom,
  rigFromStatus,
  serializeMatchIdentity,
  VOLUME_RANGE,
  writeMatchSettings,
  ZERO_SHA256,
} from './match-setup.js';

const status = (over: Partial<WitnessStatus> = {}): WitnessStatus =>
  ({ paired: true, running: true, currentTable: null, currentIdentity: null, currentAttestation: null, ...over }) as WitnessStatus;

describe('match settings: voice over the game (D2.10)', () => {
  it('the three volumes: whole percents clamped to their ranges; defaults 150 / 100 / 100', () => {
    expect(DEFAULT_MATCH_SETTINGS).toMatchObject({ voiceVolume: 150, othersTableVolume: 100, myTableWhileUp: 100 });
    expect(VOLUME_RANGE).toEqual({ voiceVolume: [0, 300], othersTableVolume: [0, 100], myTableWhileUp: [10, 100] });
    const s = patchMatchSettings(DEFAULT_MATCH_SETTINGS, { voiceVolume: 160.4, othersTableVolume: 55, myTableWhileUp: 80 });
    expect(s).toMatchObject({ voiceVolume: 160, othersTableVolume: 55, myTableWhileUp: 80 });
    expect(patchMatchSettings(DEFAULT_MATCH_SETTINGS, { voiceVolume: 999 }).voiceVolume).toBe(300);
    expect(patchMatchSettings(DEFAULT_MATCH_SETTINGS, { voiceVolume: -5 }).voiceVolume).toBe(0);
    expect(patchMatchSettings(DEFAULT_MATCH_SETTINGS, { othersTableVolume: 140 }).othersTableVolume).toBe(100);
    expect(patchMatchSettings(DEFAULT_MATCH_SETTINGS, { myTableWhileUp: 0 }).myTableWhileUp).toBe(10);
    expect(patchMatchSettings(DEFAULT_MATCH_SETTINGS, { myTableWhileUp: 250 }).myTableWhileUp).toBe(100);
    // Not a number: the current value stays.
    expect(patchMatchSettings(s, { voiceVolume: 'loud', othersTableVolume: null, myTableWhileUp: Number.NaN } as never)).toMatchObject({ voiceVolume: 160, othersTableVolume: 55, myTableWhileUp: 80 });
    expect(cleanPercent(49.5, 0, 100)).toBe(50);
    expect(cleanPercent(Number.POSITIVE_INFINITY, 0, 100)).toBeNull();
    expect(cleanPercent('50', 0, 100)).toBeNull();
    // A match.json from before D2.10 reads with the defaults; one with a value keeps it.
    expect(readMatchSettings('{"v":1,"port":27401,"cueVolume":80}')).toEqual({ ...DEFAULT_MATCH_SETTINGS, cueVolume: 80 });
    expect(readMatchSettings('{"v":1,"voiceVolume":200,"myTableWhileUp":40}')).toEqual({ ...DEFAULT_MATCH_SETTINGS, voiceVolume: 200, myTableWhileUp: 40 });
    expect(readMatchSettings(writeMatchSettings(s))).toEqual(s);
  });
});

describe('match setup (A6)', () => {
  it('invites round-trip, tolerate the wrapping a chat adds, and refuse anything else', () => {
    const inv = formatInvite('203.0.113.7', 27401, 'ABCDEF');
    expect(inv).toBe('castcade:ws://203.0.113.7:27401#ABCDEF');
    expect(parseInvite(inv)).toEqual({ via: 'direct', url: 'ws://203.0.113.7:27401', host: '203.0.113.7', port: 27401, code: 'ABCDEF' });
    expect(parseInvite(` \`${inv}\` `).code).toBe('ABCDEF');
    expect(parseInvite('castcade:ws://192.168.1.20:27401#abcdef').code).toBe('ABCDEF');
    for (const bad of ['', 'ws://1.2.3.4:27401#ABCDEF', 'castcade:ws://1.2.3.4#ABCDEF', 'castcade:ws://1.2.3.4:27401#ABC', 'castcade:ws://1.2.3.4:99999#ABCDEF', 'castcade:http://1.2.3.4:1#ABCDEF']) {
      expect(() => parseInvite(bad), bad).toThrow(/not a Castcade invite/);
    }
  });

  it('D10.8: a relay invite is the code alone, in any case and wrapping; the old address invite still parses as direct', () => {
    expect(parseInvite('JHDFEF')).toEqual({ via: 'relay', code: 'JHDFEF' });
    expect(parseInvite(' `jhdfef` ')).toEqual({ via: 'relay', code: 'JHDFEF' });
    expect(parseInvite('castcade:JHDFEF')).toEqual({ via: 'relay', code: 'JHDFEF' });
    expect(parseInvite('castcade:ws://[2001:db8::1]:27401#JHDFEF')).toMatchObject({ via: 'direct', host: '[2001:db8::1]', port: 27401 });
    for (const bad of ['JHDFE', 'JHDFEFG', 'JHDF3F', 'JHD FEF']) expect(() => parseInvite(bad), bad).toThrow(/six letters \(JHDFEF\), or looks like castcade:ws:/);
  });

  it('D10.8: a relay join failure names the real cause, and the path line is one plain line', () => {
    expect(relayJoinFailure('no_such_match', 'JHDFEF', 'x')).toMatch(/^No match with the code JHDFEF/);
    expect(relayJoinFailure('full', 'JHDFEF', 'x')).toBe('The match JHDFEF is full.');
    expect(relayJoinFailure('unauthorized', 'JHDFEF', 'x')).toMatch(/pair it with ArcAid again in Settings/);
    // The server's lockout is fifteen minutes: "wait a few minutes", never "try again".
    expect(relayJoinFailure('rate_limited', 'JHDFEF', 'x')).toBe('ArcAid is holding this PC back after too many tries: wait a few minutes, then join again.');
    expect(relayJoinFailure('locked', 'JHDFEF', 'x')).toMatch(/^That match has already started \(JHDFEF\)/);
    // A host ArcAid does not carry: the note names why (the Match tab adds ": a paired host needs no port forward").
    expect(relayHostNote('unauthorized')).toMatch(/^ArcAid did not accept this PC: pair it again in Settings/);
    expect(relayHostNote('rate_limited')).toMatch(/holding this PC back .*a few minutes/);
    expect(relayHostNote('server_busy')).toMatch(/as many matches as it can/);
    expect(relayHostNote('code_in_use')).toBe('ArcAid did not take this match');
    expect(relayHostNote('unreachable')).toBe('ArcAid could not be reached');
    expect(relayHostNote(null)).toBe('ArcAid could not be reached');
    expect(pathLine('relay', null, 'closed')).toMatch(/^Through ArcAid \(ArcAid closed this match/);
    expect(relayJoinFailure('unreachable', 'JHDFEF', 'ArcAid did not answer in 5 s')).toMatch(/^ArcAid could not be reached \(ArcAid did not answer in 5 s\)/);
    expect(relayJoinFailure('closed', 'JHDFEF', 'x')).toMatch(/was closed/);
    expect(relayJoinFailure(null, 'JHDFEF', 'The host did not answer (no answer in 10 s)')).toBe('Could not join JHDFEF through ArcAid: The host did not answer (no answer in 10 s)');
    expect(RELAY_NOT_PAIRED).toMatch(/not paired with ArcAid yet/);
    expect(pathLine('relay', null, 'registered')).toBe('Through ArcAid');
    expect(pathLine('relay', null)).toBe('Through ArcAid');
    expect(pathLine('relay', null, 'reconnecting')).toBe('Through ArcAid (reconnecting to ArcAid…)');
    expect(pathLine('direct', '203.0.113.7:27401')).toBe('Direct to 203.0.113.7:27401');
  });

  it('match codes are six letters from the alphabet without I and O', () => {
    for (let i = 0; i < 50; i++) expect(newMatchCode()).toMatch(/^[A-HJ-NP-Z]{6}$/);
    expect(newMatchCode(() => 0)).toBe('AAAAAA');
  });

  it('settings default, clamp and round-trip', () => {
    expect(readMatchSettings(null)).toEqual(DEFAULT_MATCH_SETTINGS);
    expect(readMatchSettings('not json')).toEqual(DEFAULT_MATCH_SETTINGS);
    const s = patchMatchSettings(DEFAULT_MATCH_SETTINGS, { port: '28000', ballsPerGame: 5, displayName: '  Krobs  ', cueVolume: 140 });
    expect(s).toEqual({ port: 28000, ballsPerGame: 5, displayName: 'Krobs', cueVolume: 100, theaterDuringMyTurn: 'hidden', spectate: 'theater', previewStereo: 'auto', tableMuteMine: true, tableSendMine: true, tableHearOthers: true, theaterScale: 1, cameraSource: 'layer', cameraEyes: 'one', settingsVersion: 2, cameraView: 'whole', windowDepthM: null, eyeOffsetDeg: [0, 0], softEdge: 0.03, preMatchPlay: 'free', voiceVolume: 150, othersTableVolume: 100, myTableWhileUp: 100 });
    expect(patchMatchSettings(s, { port: 80, ballsPerGame: 4, displayName: '' })).toEqual({ ...s, displayName: null });
    // A12 (2026-11-05): the host's table before the match: free by default, locked on request, anything else ignored.
    expect(patchMatchSettings(s, { preMatchPlay: 'locked' }).preMatchPlay).toBe('locked');
    expect(patchMatchSettings(s, { preMatchPlay: 'open' }).preMatchPlay).toBe('free');
    // D7.5: the camera source: the layer by default (D8.1; the screen before), the screen on request, anything else ignored.
    expect(patchMatchSettings(s, { cameraSource: 'screen' }).cameraSource).toBe('screen');
    expect(patchMatchSettings(s, { cameraSource: 'webcam' }).cameraSource).toBe('layer');
    expect(readMatchSettings(writeMatchSettings(s))).toEqual(s);
  });

  it('D8.1 (ADR 0009): cameraEyes defaults to one, takes one or both; settingsVersion is 2 and never patched; a match.json without it is migrated once to the layer camera, one eye', () => {
    expect(DEFAULT_MATCH_SETTINGS).toMatchObject({ cameraSource: 'layer', cameraEyes: 'one', settingsVersion: 2 });
    expect(MATCH_SETTINGS_VERSION).toBe(2);
    expect(patchMatchSettings(DEFAULT_MATCH_SETTINGS, { cameraEyes: 'both' }).cameraEyes).toBe('both');
    const both = patchMatchSettings(DEFAULT_MATCH_SETTINGS, { cameraEyes: 'both' });
    expect(patchMatchSettings(both, { cameraEyes: 'three' } as never).cameraEyes).toBe('both');
    expect(patchMatchSettings(both, { settingsVersion: 1 }).settingsVersion).toBe(2);
    expect(readMatchSettings(writeMatchSettings(both))).toEqual(both);
    expect(writeMatchSettings(both)).toContain('"settingsVersion": 2');
    // No file, or not JSON: the defaults, nothing to migrate.
    expect(loadMatchSettings(null)).toEqual({ settings: DEFAULT_MATCH_SETTINGS, migrated: null });
    expect(loadMatchSettings('{').migrated).toBeNull();
    // A 0.2.35 file (no settingsVersion) that says screen capture: the layer, one eye, version 2, said once.
    const old = '{"v":1,"port":27401,"ballsPerGame":3,"displayName":null,"cueVolume":80,"theaterScale":0.8,"cameraSource":"screen","cameraView":"window"}';
    const m = loadMatchSettings(old);
    expect(m.settings).toEqual({ ...DEFAULT_MATCH_SETTINGS, theaterScale: 0.8, cameraView: 'window', cameraSource: 'layer', cameraEyes: 'one', settingsVersion: 2 });
    expect(m.migrated).toBe('match.json from before 0.2.36 (settings version 1): camera set to the VR layer, one eye (ADR 0009); saved as version 2');
    expect(loadMatchSettings('{"v":1,"settingsVersion":1,"cameraSource":"screen"}').settings.cameraSource).toBe('layer');
    // Saved back at version 2: read again, nothing is migrated and the player's later choices stand.
    const saved = patchMatchSettings(m.settings, { cameraSource: 'screen', cameraEyes: 'both' });
    expect(loadMatchSettings(writeMatchSettings(saved))).toEqual({ settings: saved, migrated: null });
    expect(loadMatchSettings('{"v":1,"settingsVersion":2,"cameraSource":"screen","cameraEyes":"both"}').settings).toMatchObject({ cameraSource: 'screen', cameraEyes: 'both' });
    // A version from the future reads as current (never migrated down).
    expect(loadMatchSettings('{"v":1,"settingsVersion":9,"cameraSource":"screen"}')).toMatchObject({ settings: { cameraSource: 'screen', settingsVersion: 2 }, migrated: null });
  });

  it('D7.4: the headset settings default to hidden on my ball and theater on theirs; only their values patch; they round-trip', () => {
    expect(DEFAULT_MATCH_SETTINGS).toMatchObject({ theaterDuringMyTurn: 'hidden', spectate: 'theater' });
    const s = patchMatchSettings(DEFAULT_MATCH_SETTINGS, { theaterDuringMyTurn: 'panel', spectate: 'panel' });
    expect(s).toMatchObject({ theaterDuringMyTurn: 'panel', spectate: 'panel' });
    expect(patchMatchSettings(s, { theaterDuringMyTurn: 'theater', spectate: 'hidden' })).toEqual(s);
    // D7.4.3: the preview override; an unknown word keeps the current one
    expect(DEFAULT_MATCH_SETTINGS.previewStereo).toBe('auto');
    const both = patchMatchSettings(s, { previewStereo: 'sbs' });
    expect(both.previewStereo).toBe('sbs');
    expect(patchMatchSettings(both, { previewStereo: 'tab' } as never).previewStereo).toBe('sbs');
    expect(readMatchSettings(writeMatchSettings(s))).toEqual(s);
    // A match.json from before D7.4 reads with the defaults.
    expect(readMatchSettings('{"v":1,"port":27401,"ballsPerGame":3,"displayName":null,"cueVolume":80}')).toEqual(DEFAULT_MATCH_SETTINGS);
  });

  it('D7.4.9: theaterScale defaults to 1, clamps to 0.25-4, ignores non-numbers, saves and reads back', () => {
    expect(DEFAULT_MATCH_SETTINGS.theaterScale).toBe(1);
    const s = patchMatchSettings(DEFAULT_MATCH_SETTINGS, { theaterScale: 0.8 });
    expect(s.theaterScale).toBe(0.8);
    expect(patchMatchSettings(s, { theaterScale: 0.01 }).theaterScale).toBe(0.25);
    expect(patchMatchSettings(s, { theaterScale: 99 }).theaterScale).toBe(4);
    expect(patchMatchSettings(s, { theaterScale: 'big' } as never).theaterScale).toBe(0.8);
    expect(patchMatchSettings(s, { theaterScale: NaN }).theaterScale).toBe(0.8);
    expect(readMatchSettings(writeMatchSettings(s)).theaterScale).toBe(0.8);
  });

  it('D7.5.9-D7.5.11: camera view, window depth, eye offsets and soft edge default, clean, round-trip; an old match.json gets the defaults', () => {
    expect(DEFAULT_MATCH_SETTINGS).toMatchObject({ cameraView: 'whole', windowDepthM: null, eyeOffsetDeg: [0, 0], softEdge: 0.03 });
    // The view: two words, anything else keeps the current one.
    expect(patchMatchSettings(DEFAULT_MATCH_SETTINGS, { cameraView: 'window' }).cameraView).toBe('window');
    expect(patchMatchSettings(DEFAULT_MATCH_SETTINGS, { cameraView: 'crop' } as never).cameraView).toBe('whole');
    // The depth: 0.3-100 m to two decimals; out of range, null or not a number is infinity.
    expect(patchMatchSettings(DEFAULT_MATCH_SETTINGS, { windowDepthM: 2.6 }).windowDepthM).toBe(2.6);
    expect(patchMatchSettings(DEFAULT_MATCH_SETTINGS, { windowDepthM: 1.23456 }).windowDepthM).toBe(1.23);
    const near = patchMatchSettings(DEFAULT_MATCH_SETTINGS, { windowDepthM: 0.7 });
    expect(patchMatchSettings(near, { windowDepthM: null }).windowDepthM).toBeNull();
    expect(patchMatchSettings(near, { windowDepthM: 0.1 }).windowDepthM).toBeNull();
    expect(patchMatchSettings(near, { windowDepthM: 500 }).windowDepthM).toBeNull();
    expect(patchMatchSettings(near, { windowDepthM: 'far' } as never).windowDepthM).toBeNull();
    expect(patchMatchSettings(near, {}).windowDepthM).toBe(0.7);
    // The offsets: a pair of degrees, clamped to ±10, a tenth; a bad pair keeps the current one.
    expect(patchMatchSettings(DEFAULT_MATCH_SETTINGS, { eyeOffsetDeg: [0.55, -12] }).eyeOffsetDeg).toEqual([0.6, -10]);
    const off = patchMatchSettings(DEFAULT_MATCH_SETTINGS, { eyeOffsetDeg: [0.5, -0.5] });
    expect(patchMatchSettings(off, { eyeOffsetDeg: [1] } as never).eyeOffsetDeg).toEqual([0.5, -0.5]);
    expect(patchMatchSettings(off, { eyeOffsetDeg: ['up', 0] } as never).eyeOffsetDeg).toEqual([0.5, -0.5]);
    expect(patchMatchSettings(off, { eyeOffsetDeg: [NaN, 0] }).eyeOffsetDeg).toEqual([0.5, -0.5]);
    expect(Object.is(patchMatchSettings(off, { eyeOffsetDeg: [-0.01, 0] }).eyeOffsetDeg[0], 0)).toBe(true); // never -0
    // The soft edge: 0-0.25 to three decimals; not a number keeps the current one.
    expect(patchMatchSettings(DEFAULT_MATCH_SETTINGS, { softEdge: 0.1 }).softEdge).toBe(0.1);
    expect(patchMatchSettings(DEFAULT_MATCH_SETTINGS, { softEdge: 0.9 }).softEdge).toBe(0.25);
    expect(patchMatchSettings(DEFAULT_MATCH_SETTINGS, { softEdge: -1 }).softEdge).toBe(0);
    expect(patchMatchSettings(DEFAULT_MATCH_SETTINGS, { softEdge: 0.03333 }).softEdge).toBe(0.033);
    expect(patchMatchSettings(DEFAULT_MATCH_SETTINGS, { softEdge: 'soft' } as never).softEdge).toBe(0.03);
    const all = patchMatchSettings(DEFAULT_MATCH_SETTINGS, { cameraView: 'window', windowDepthM: 2.6, eyeOffsetDeg: [0.5, -0.5], softEdge: 0.06 });
    expect(readMatchSettings(writeMatchSettings(all))).toEqual(all);
    // A match.json from 0.2.34 (no window keys) reads with the defaults.
    expect(readMatchSettings('{"v":1,"port":27401,"ballsPerGame":3,"displayName":null,"cueVolume":80,"theaterScale":0.8,"cameraSource":"layer"}')).toEqual({ ...DEFAULT_MATCH_SETTINGS, theaterScale: 0.8, cameraSource: 'layer' });
  });

  it('D2.8: the three table-sound settings, on by default, booleans only, saved and read back', () => {
    expect(DEFAULT_MATCH_SETTINGS).toMatchObject({ tableMuteMine: true, tableSendMine: true, tableHearOthers: true });
    const off = patchMatchSettings(DEFAULT_MATCH_SETTINGS, { tableMuteMine: false, tableSendMine: false, tableHearOthers: false });
    expect(off).toMatchObject({ tableMuteMine: false, tableSendMine: false, tableHearOthers: false });
    expect(patchMatchSettings(off, { tableMuteMine: 'yes', tableSendMine: 1 } as never)).toEqual(off);
    expect(readMatchSettings(writeMatchSettings(off))).toEqual(off);
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
