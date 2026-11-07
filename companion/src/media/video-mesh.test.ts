import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { MediaSignal, NativeVideoStatus } from './match-media-types.js';
import { createVideoHelper, type VideoHelper, type VideoHelperCommand, type VideoHelperEvent, type VideoHelperStatus } from './video-helper.js';
import { clampMaxKbps, clampPin, createVideoMesh, headsetVideoLine, helperIceServers, initiates, ladderFor, pairWords, rungGeometry, rungReadout, type VideoMesh } from './video-mesh.js';

const FAKE = fileURLToPath(new URL('./__fixtures__/fake-video-helper.mjs', import.meta.url));

const until = async (cond: () => boolean, ms = 8000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('video mesh rules (D10.3)', () => {
  it('the lower id offers (the same answer on both rigs), the other waits', () => {
    expect(initiates('alice', 'bob')).toBe(true);
    expect(initiates('bob', 'alice')).toBe(false);
    expect(initiates('p1', 'p10')).toBe(true);
  });

  it('the candidate pair in words, from a string or an object; ICE servers with urls always a list', () => {
    expect(pairWords('srflx<->host')).toBe('srflx↔host');
    expect(pairWords('relay->host')).toBe('relay↔host');
    expect(pairWords({ local: 'srflx', remote: { type: 'host' } })).toBe('srflx↔host');
    expect(pairWords({ local: 'srflx' })).toBeNull();
    expect(pairWords('')).toBeNull();
    expect(pairWords(null)).toBeNull();
    expect(helperIceServers([{ urls: ['stun:a', 'stun:b'] }, { urls: 'turn:t', username: 'u', credential: 'c' }])).toEqual([{ urls: ['stun:a', 'stun:b'] }, { urls: ['turn:t'], username: 'u', credential: 'c' }]);
  });

  it('D10.5: the ladder as the helper computes it (fractions of the source box, even sizes), the design box before a source is known, the clamps', () => {
    expect(ladderFor(1354, 1440)).toEqual([
      { rung: 1, width: 1354, height: 1440, fps: 60, kbps: 20_000 },
      { rung: 2, width: 1354, height: 1440, fps: 30, kbps: 10_000 },
      { rung: 3, width: 1016, height: 1080, fps: 60, kbps: 8000 },
      { rung: 4, width: 1016, height: 1080, fps: 30, kbps: 5000 },
      { rung: 5, width: 678, height: 720, fps: 60, kbps: 4000 },
      { rung: 6, width: 678, height: 720, fps: 30, kbps: 2000 },
    ]);
    expect(rungGeometry(3, 1920, 1080)).toEqual({ rung: 3, width: 1440, height: 810, fps: 60, kbps: 8000 });
    expect(rungGeometry(5, 1920, 1080)).toEqual({ rung: 5, width: 960, height: 540, fps: 60, kbps: 4000 });
    expect(rungGeometry(9, 100, 100).rung).toBe(6);
    expect(ladderFor(0, 0)).toEqual(ladderFor(1354, 1440));
    expect(clampMaxKbps(8000.4)).toBe(8000);
    expect(clampMaxKbps(10)).toBe(500);
    expect(clampMaxKbps('x')).toBe(20_000);
    expect(clampPin(2)).toBe(2);
    expect(clampPin(7)).toBeNull();
    expect(clampPin(null)).toBeNull();
  });

  it('D10.5: the Match tab readout and the headset line from the status', () => {
    const ladder = ladderFor(1354, 1440);
    const rung = { rung: 3, width: 1016, height: 1080, fps: 60, kbps: 8000, reason: 'probe' };
    const send = { fps: 59, kbps: 7812, width: 1016, height: 1080, rttMs: 41.2 };
    const recv = { fps: 60, kbps: 7700, width: 1016, height: 1080 };
    expect(rungReadout({ pin: null, sending: false, ladder, peers: {} })).toBe('Auto (rung 3 to start: 1016x1080 at 60 fps)');
    expect(rungReadout({ pin: 2, sending: false, ladder, peers: {} })).toBe('Pinned to rung 2 (rung 2 to start)');
    expect(rungReadout({ pin: null, sending: false, ladder, peers: { k: { ice: 'connected', pair: null, send: null, recv: null, rung } } })).toBe('Auto (rung 3: 1016x1080 at 60 fps, up to 8.0 Mbps)');
    expect(rungReadout({ pin: null, sending: true, ladder, peers: { k: { ice: 'connected', pair: null, send, recv: null, rung } } })).toBe('Auto (rung 3: 1016x1080 at 59 fps, 7.8 Mbps)');
    expect(rungReadout({ pin: null, sending: true, ladder, peers: { k: { ice: 'connected', pair: null, send, recv: null, rung: { ...rung, reason: 'down:loss' } } } })).toBe('Auto (rung 3: 1016x1080 at 59 fps, 7.8 Mbps, stepped down on loss)');
    expect(rungReadout({ pin: 3, sending: true, ladder, peers: { k: { ice: 'connected', pair: null, send, recv: null, rung: { ...rung, reason: 'pin' } } } })).toBe('Pinned to rung 3 (rung 3: 1016x1080 at 59 fps, 7.8 Mbps)');
    expect(headsetVideoLine({ helper: 'starting', sending: true, peers: {} })).toBeNull();
    expect(headsetVideoLine({ helper: 'ready', sending: true, peers: {} })).toBe('video: starting');
    expect(headsetVideoLine({ helper: 'ready', sending: true, peers: { k: { ice: 'connected', pair: null, send, recv: null, rung } } })).toBe('video: rung 3 · 1016x1080@59 · 7.8 Mbps · rtt 41 ms');
    expect(headsetVideoLine({ helper: 'ready', sending: true, peers: { k: { ice: 'connected', pair: null, send: null, recv: null, rung } } })).toBe('video: rung 3 · 1016x1080@60');
    expect(headsetVideoLine({ helper: 'ready', sending: false, peers: { k: { ice: 'connected', pair: null, send: null, recv, rung: null } } })).toBe('video: in 1016x1080 · 60 fps · 7.7 Mbps');
    expect(headsetVideoLine({ helper: 'ready', sending: false, peers: { k: { ice: 'connected', pair: null, send: null, recv: null, rung: null } } })).toBeNull();
  });
});

// ---- two meshes over two real fake helpers, signals through a function pair ----

interface Rig {
  id: string;
  helper: VideoHelper;
  mesh: VideoMesh;
  log: string[];
  events: VideoHelperEvent[];
  statuses: NativeVideoStatus[];
  out: Array<{ to: string; signal: MediaSignal }>;
}

const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) {
    r.mesh.close();
    await r.helper.stop();
  }
  delete process.env.FAKE_VIDEO_STATS_MS;
  delete process.env.FAKE_VIDEO_ICE_FAIL;
});

function rig(id: string, others: () => Rig[]): Rig {
  const log: string[] = [];
  const events: VideoHelperEvent[] = [];
  const statuses: NativeVideoStatus[] = [];
  const out: Array<{ to: string; signal: MediaSignal }> = [];
  const helper = createVideoHelper({ exe: process.execPath, args: [FAKE], log: (l) => log.push(l) });
  helper.onEvent((e) => events.push(e));
  const r: Rig = { id, helper, log, events, statuses, out, mesh: null as never };
  r.mesh = createVideoMesh({
    helper,
    localId: id,
    log: (l) => log.push(l),
    // What `splitSignalling`'s video side does: the frame goes out marked `channel: 'video'` and lands on the other rig's video side.
    sendSignal: (to, signal) => {
      out.push({ to, signal });
      const marked: MediaSignal = { ...signal, channel: 'video' };
      setImmediate(() => others().find((o) => o.id === to)?.mesh.onSignal(id, marked));
    },
  });
  r.mesh.onStatus((s) => statuses.push(s));
  rigs.push(r);
  helper.start();
  return r;
}

const peer = (r: Rig, id: string) => r.mesh.status().peers[id];
const fakeLogs = (r: Rig): string[] => r.events.filter((e): e is Extract<VideoHelperEvent, { event: 'log' }> => e.event === 'log').map((e) => e.text);

describe('two meshes over two fake helpers (D10.3 §6.4)', () => {
  it('reach `peer connected` on both sides; the lower id offered; stats land per peer and per direction; the turn, source, sink, ICE and rungs reach the helper', async () => {
    process.env.FAKE_VIDEO_STATS_MS = '40';
    const a = rig('aaa', () => rigs);
    const b = rig('bbb', () => rigs);
    a.mesh.setPeers(['aaa', 'bbb']);
    b.mesh.setPeers(['bbb', 'aaa']);
    // Before the helpers are ready, the peers are wanted and shown, not told.
    expect(a.mesh.status().peers).toEqual({ bbb: { ice: 'new', pair: null, send: null, recv: null, rung: null, failed: false } });
    await until(() => peer(a, 'bbb')?.ice === 'connected' && peer(b, 'aaa')?.ice === 'connected');
    expect(peer(a, 'bbb')?.pair).toBe('srflx↔host');
    // The lower id made the offer; the other answered.
    expect(a.out.map((o) => o.signal.kind)).toEqual(['offer']);
    expect(b.out.map((o) => o.signal.kind)).toEqual(['answer', 'ice']);
    expect(a.out[0]).toEqual({ to: 'bbb', signal: { kind: 'offer', sdp: 'v=0 offer from fake to bbb' } });
    expect(b.out[1]?.signal.candidate).toEqual({ candidate: 'candidate:1 1 udp 1 10.0.0.1 1 typ host fake', sdpMid: '0', sdpMLineIndex: 0 });
    expect(a.log).toContain('video: peer bbb: offering');
    expect(b.log).toContain('video: peer aaa: waiting for their offer');
    expect(a.log).toContain('video: peer bbb: ice connected (srflx↔host)');
    await until(() => !!peer(a, 'bbb')?.send && !!peer(a, 'bbb')?.recv);
    expect(peer(a, 'bbb')?.send).toEqual({ fps: 60, kbps: 18200, width: 1354, height: 1440, rttMs: 31, lossPct: 0, bweKbps: 24000 });
    expect(peer(a, 'bbb')?.recv).toEqual({ fps: 60, kbps: 17900, width: 1354, height: 1440 });
    expect(a.mesh.status()).toMatchObject({ helper: 'ready', encoder: 'libx264', decoder: 'h264', sending: false, sink: 'none', fallback: false, source: { kind: 'none', state: 'ok', fpsIn: 0 } });
    // D10.3.4: the helper's `ready` event followed its ready status (the mesh saw both): one `peer` command, one sync.
    expect(fakeLogs(a).filter((t) => t === 'ice 0 server(s)')).toHaveLength(1);
    expect(a.log.filter((l) => l === 'video: peer bbb: offering')).toHaveLength(1);
    // The rig's wiring: the turn, the ring source, the sink, the ICE list and the ladder, each a helper command once.
    a.mesh.setSource({ kind: 'ring', token: 'tok_send_0123456', width: 1354, height: 1440, fps: 60 });
    a.mesh.setSending(true);
    a.mesh.setSending(true);
    a.mesh.setSink({ kind: 'ring', token: 'tok_recv_0123456' });
    b.mesh.setSink({ kind: 'window' });
    a.mesh.setIce([{ urls: ['stun:stun.l.google.com:19302'] }, { urls: 'turn:relay.example.org:3478', username: 'u', credential: 'c' }]);
    // D10.5: the rung in force came with the connection (the helper starts at rung 3) and the status carries the ladder for the source box.
    expect(peer(a, 'bbb')?.rung).toEqual({ rung: 3, width: 1016, height: 1080, fps: 60, kbps: 8000, reason: 'start' });
    expect(a.mesh.status()).toMatchObject({ maxKbps: 20_000, pin: null });
    expect(a.mesh.status().ladder[0]).toEqual({ rung: 1, width: 1354, height: 1440, fps: 60, kbps: 20_000 });
    a.mesh.setRungs({ max_kbps: 8000, pin: 2 });
    await until(() => fakeLogs(a).some((t) => t.startsWith('rungs max 8000')));
    // The first ready told it the whole (empty) state; then each change once, in the helper's order.
    expect(fakeLogs(a)).toEqual(['ice 0 server(s)', 'sink none', 'rungs max 20000 kbps', 'send off (none)', 'send on (ring)', 'sink ring tok_recv_0123456', 'ice 2 server(s)', 'rungs max 8000 kbps, pinned 2']);
    await until(() => peer(a, 'bbb')?.rung?.reason === 'pin');
    expect(peer(a, 'bbb')?.rung).toEqual({ rung: 2, width: 1354, height: 1440, fps: 30, kbps: 10_000, reason: 'pin' });
    expect(a.mesh.status()).toMatchObject({ maxKbps: 8000, pin: 2 });
    expect(a.log).toContain('video: rungs: ceiling 8000 kbps, pinned to rung 2');
    expect(a.log).toContain('video: peer bbb: rung 2 (1354x1440 at 30 fps, 10.0 Mbps): pin');
    await until(() => a.mesh.status().source.state === 'ok');
    expect(a.mesh.status()).toMatchObject({ sending: true, sink: 'ring', source: { kind: 'ring', width: 1354, height: 1440, fps: 60, state: 'ok', fpsIn: 60 } });
    expect(a.log).toContain('video: source ring 1354x1440 at 60 fps');
    await until(() => fakeLogs(b).includes('sink window'));
    // A player leaves: their peer is closed and gone from the status.
    a.mesh.setPeers(['aaa']);
    await until(() => a.events.some((e) => e.event === 'peer' && e.id === 'bbb' && e.ice === 'closed'));
    expect(a.mesh.status().peers).toEqual({});
    // The end of the match: everything off.
    a.mesh.close();
    await until(() => fakeLogs(a).filter((t) => t === 'send off (none)').length === 2 && fakeLogs(a).filter((t) => t === 'sink none').length === 2);
    expect(a.events.filter((e) => e.event === 'source' && e.kind === 'none')).toHaveLength(2);
  }, 20_000);

  it('an offer that lands before the roster names its sender is held and replayed once the peer is added; a stranger is dropped', async () => {
    const a = rig('aaa', () => rigs);
    const b = rig('bbb', () => rigs);
    a.mesh.setPeers(['bbb']);
    // a offers as soon as its helper is ready; b has no peers yet: the offer waits.
    await until(() => a.out.length === 1);
    await new Promise((r) => setTimeout(r, 50));
    expect(b.out).toEqual([]);
    expect(peer(a, 'bbb')?.ice).not.toBe('connected');
    b.mesh.setPeers(['aaa']);
    await until(() => peer(a, 'bbb')?.ice === 'connected' && peer(b, 'aaa')?.ice === 'connected');
    expect(b.out[0]?.signal.kind).toBe('answer');
    // A signal from someone not in the roster goes nowhere (no peer_unknown from the helper).
    b.mesh.onSignal('zzz', { kind: 'offer', sdp: 'v=0 stranger', channel: 'video' });
    await new Promise((r) => setTimeout(r, 50));
    expect(b.events.some((e) => e.event === 'error')).toBe(false);
  }, 20_000);

  it('D10.3.6 (2026-11-07): the helper gives a peer up (ice failed, restarts exhausted): the peer reads failed, the mesh falls back for the match, said once; the Electron path is told nothing here', async () => {
    process.env.FAKE_VIDEO_ICE_FAIL = '3';
    const a = rig('aaa', () => rigs);
    const b = rig('bbb', () => rigs);
    a.mesh.setPeers(['bbb']);
    b.mesh.setPeers(['aaa']);
    await until(() => a.mesh.status().fallback && b.mesh.status().fallback);
    expect(peer(a, 'bbb')).toMatchObject({ ice: 'failed', failed: true });
    expect(peer(b, 'aaa')).toMatchObject({ ice: 'failed', failed: true });
    expect(a.log).toContain('video: peer bbb: ice failed');
    expect(a.log.filter((l) => l.startsWith('media: native video failed'))).toEqual(['media: native video failed to connect (peer bbb, 3 restarts); the Electron video serves this match']);
    expect(b.log.filter((l) => l.startsWith('media: native video failed'))).toEqual(['media: native video failed to connect (peer aaa, 3 restarts); the Electron video serves this match']);
    // The mesh goes on (the status, the turn): nothing takes the picture back mid-match; the flag holds to the end.
    a.mesh.setSending(true);
    expect(a.mesh.status()).toMatchObject({ helper: 'ready', sending: true, fallback: true });
    expect(headsetVideoLine(a.mesh.status())).toBeNull();
    a.mesh.close();
    expect(a.mesh.status().fallback).toBe(true);
  }, 20_000);
});

// ---- the helper faked in place: what is said, and said again after a restart ----

function stubHelper() {
  const sent: VideoHelperCommand[] = [];
  const eventCbs = new Set<(e: VideoHelperEvent) => void>();
  const statusCbs = new Set<(s: VideoHelperStatus) => void>();
  let status: VideoHelperStatus = { helper: 'stopped', reason: null, version: null, encoder: null, decoder: null, generation: 0 };
  const helper: VideoHelper = {
    start: () => undefined,
    stop: async () => undefined,
    send(cmd) {
      if (status.helper !== 'ready') return false;
      sent.push(cmd);
      return true;
    },
    onEvent(cb) {
      eventCbs.add(cb);
      return () => void eventCbs.delete(cb);
    },
    status: () => status,
    onStatus(cb) {
      statusCbs.add(cb);
      return () => void statusCbs.delete(cb);
    },
  };
  const set = (s: Partial<VideoHelperStatus>): void => {
    status = { ...status, ...s };
    statusCbs.forEach((cb) => cb(status));
  };
  /** A spawn: the status says ready for a new generation (as the real manager's does before the event fans out). */
  const readyStatus = (): void => set({ helper: 'ready', reason: null, version: '1', encoder: 'h264_nvenc', decoder: 'nvdec', generation: status.generation + 1 });
  const readyEvent = (): void => eventCbs.forEach((cb) => cb({ event: 'ready', version: '1', encoder: 'h264_nvenc', decoder: 'nvdec' }));
  const ready = (): void => {
    readyStatus();
    readyEvent();
  };
  const say = (e: VideoHelperEvent): void => eventCbs.forEach((cb) => cb(e));
  return { helper, sent, set, ready, readyStatus, readyEvent, say };
}

describe('the wgc source (D10.6, 2026-11-07)', () => {
  it('the VPX window goes to the helper as `source wgc`; the helper names the window it captures and `missing` reads as no window', () => {
    const h = stubHelper();
    const log: string[] = [];
    const mesh = createVideoMesh({ helper: h.helper, localId: 'bbb', sendSignal: () => undefined, log: (l) => log.push(l) });
    h.ready();
    mesh.setSource({ kind: 'wgc', pid: 4242, title: 'Visual Pinball Player', width: 1280, height: 720, fps: 30 });
    expect(h.sent.at(-1)).toEqual({ cmd: 'source', kind: 'wgc', pid: 4242, title: 'Visual Pinball Player', width: 1280, height: 720, fps: 30 });
    expect(log).toContain('video: source wgc "Visual Pinball Player" (pid 4242) in a 1280x720 box at 30 fps');
    expect(mesh.status().source).toEqual({ kind: 'wgc', width: 1280, height: 720, fps: 30, state: null, fpsIn: null, window: null });
    h.say({ event: 'source', kind: 'wgc', state: 'missing', fps_in: 0 });
    expect(log).toContain('video: source wgc: missing (no VPX window to capture)');
    h.say({ event: 'source', kind: 'wgc', state: 'ok', fps_in: 29.9, window: '"Visual Pinball Player" 1920x1080 (pid 4242)' });
    expect(mesh.status().source).toMatchObject({ kind: 'wgc', state: 'ok', fpsIn: 29.9, window: '"Visual Pinball Player" 1920x1080 (pid 4242)' });
    expect(log).toContain('video: source wgc: ok ("Visual Pinball Player" 1920x1080 (pid 4242))');
    // The same event again says nothing; the window gone says so once.
    const n = log.length;
    h.say({ event: 'source', kind: 'wgc', state: 'ok', fps_in: 30.2, window: '"Visual Pinball Player" 1920x1080 (pid 4242)' });
    expect(log).toHaveLength(n);
    h.say({ event: 'source', kind: 'wgc', state: 'missing', fps_in: 12 });
    expect(mesh.status().source).toMatchObject({ state: 'missing', window: null });
    mesh.setSource({ kind: 'none' });
    expect(h.sent.at(-1)).toEqual({ cmd: 'source', kind: 'none' });
    expect(mesh.status().source).toEqual({ kind: 'none', width: 0, height: 0, fps: 0, state: null, fpsIn: null, window: null });
  });
});

describe('the mesh and a helper that restarts', () => {
  it('tells a fresh helper everything again, in order: ice, source, sink, rungs, send, then the peers; held signals follow the peer', () => {
    const h = stubHelper();
    const out: Array<{ to: string; signal: MediaSignal }> = [];
    const log: string[] = [];
    const mesh = createVideoMesh({ helper: h.helper, localId: 'bbb', sendSignal: (to, signal) => void out.push({ to, signal }), log: (l) => log.push(l) });
    mesh.setIce([{ urls: ['stun:s'] }]);
    mesh.setSource({ kind: 'ring', token: 'send-token-000000', width: 1016, height: 1080, fps: 60 });
    mesh.setSink({ kind: 'window' });
    mesh.setSending(true);
    mesh.setPeers(['aaa', 'ccc']);
    // The offer from aaa arrives before the helper is up: held.
    mesh.onSignal('aaa', { kind: 'offer', sdp: 'v=0 from aaa', channel: 'video' });
    mesh.onSignal('aaa', { kind: 'ice', candidate: { candidate: 'c1', sdpMid: '0', sdpMLineIndex: 0 }, channel: 'video' });
    expect(h.sent).toEqual([]);
    expect(mesh.status()).toMatchObject({ helper: 'stopped', peers: { aaa: { ice: 'new' }, ccc: { ice: 'new' } } });
    h.set({ helper: 'starting' });
    h.ready();
    expect(h.sent).toEqual([
      { cmd: 'ice', servers: [{ urls: ['stun:s'] }] },
      { cmd: 'source', kind: 'ring', token: 'send-token-000000', width: 1016, height: 1080, fps: 60 },
      { cmd: 'sink', kind: 'window' },
      { cmd: 'rungs', max_kbps: 20_000 },
      { cmd: 'send', on: true },
      { cmd: 'peer', id: 'aaa', initiator: false },
      { cmd: 'signal', id: 'aaa', kind: 'offer', sdp: 'v=0 from aaa' },
      { cmd: 'signal', id: 'aaa', kind: 'ice', candidate: { candidate: 'c1', sdpMid: '0', sdpMLineIndex: 0 } },
      { cmd: 'peer', id: 'ccc', initiator: true },
    ]);
    // The helper's answer goes out to aaa; a signal for a peer the helper has not been told is not relayed.
    h.say({ event: 'signal', id: 'aaa', kind: 'answer', sdp: 'v=0 ans' });
    h.say({ event: 'signal', id: 'zzz', kind: 'offer', sdp: 'v=0 who' });
    expect(out).toEqual([{ to: 'aaa', signal: { kind: 'answer', sdp: 'v=0 ans' } }]);
    h.say({ event: 'peer', id: 'aaa', ice: 'connected', pair: { local: 'srflx', remote: 'relay' } });
    h.say({ event: 'stats', id: 'aaa', dir: 'recv', fps: 30, kbps: 5000, width: 1016, height: 1080 });
    h.say({ event: 'source', kind: 'ring', state: 'missing', fps_in: 0 });
    expect(mesh.status().peers.aaa).toEqual({ ice: 'connected', pair: 'srflx↔relay', send: null, recv: { fps: 30, kbps: 5000, width: 1016, height: 1080 }, rung: null, failed: false });
    expect(mesh.status().source).toMatchObject({ state: 'missing', fpsIn: 0 });
    expect(log).toContain('video: source ring: missing (the ring is not being filled)');
    // Nothing changed: nothing more is said.
    const n = h.sent.length;
    mesh.setPeers(['ccc', 'aaa']);
    mesh.setSending(true);
    mesh.setIce([{ urls: ['stun:s'] }]);
    expect(h.sent).toHaveLength(n);
    // D10.3.4: the same generation's `ready` event again (the manager fans every one): nothing is said twice.
    h.readyEvent();
    expect(h.sent).toHaveLength(n);
    expect(mesh.status().peers.aaa?.ice).toBe('connected');
    // The helper dies and comes back (generation + 1): everything again, peers included; its old views are gone meanwhile.
    h.set({ helper: 'starting', reason: 'restarting' });
    expect(mesh.status()).toMatchObject({ helper: 'starting', reason: 'restarting', fallback: false, peers: { aaa: { ice: 'new', pair: null, send: null, recv: null } } });
    h.sent.length = 0;
    h.ready();
    expect(h.sent.map((c) => c.cmd)).toEqual(['ice', 'source', 'sink', 'rungs', 'send', 'peer', 'peer']);
    // Its `ready` event once more (or a status re-emit): still the same generation, nothing more.
    h.readyEvent();
    h.set({});
    expect(h.sent.map((c) => c.cmd)).toEqual(['ice', 'source', 'sink', 'rungs', 'send', 'peer', 'peer']);
    // Close: peers closed, send off, source and sink none; the helper itself is left running.
    h.sent.length = 0;
    mesh.close();
    expect(h.sent).toEqual([
      { cmd: 'source', kind: 'none' },
      { cmd: 'sink', kind: 'none' },
      { cmd: 'send', on: false },
      { cmd: 'close', id: 'aaa' },
      { cmd: 'close', id: 'ccc' },
    ]);
    expect(mesh.status().peers).toEqual({});
  });

  it('a helper that is unavailable: the status says why, nothing is sent and the mesh is in fallback (D10.3.6); a helper that is ready already is told at once', () => {
    const h = stubHelper();
    h.set({ helper: 'unavailable', reason: 'helper_missing' });
    const mesh = createVideoMesh({ helper: h.helper, localId: 'bbb', sendSignal: () => undefined, log: () => undefined });
    mesh.setPeers(['aaa']);
    mesh.setSending(true);
    expect(h.sent).toEqual([]);
    expect(mesh.status()).toMatchObject({ helper: 'unavailable', reason: 'helper_missing', sending: true, fallback: true, peers: { aaa: { ice: 'new' } } });
    const g = stubHelper();
    g.ready();
    const second = createVideoMesh({ helper: g.helper, localId: 'bbb', sendSignal: () => undefined, log: () => undefined });
    // The whole (empty) state at creation, then each setting as a single command.
    expect(g.sent).toEqual([{ cmd: 'ice', servers: [] }, { cmd: 'source', kind: 'none' }, { cmd: 'sink', kind: 'none' }, { cmd: 'rungs', max_kbps: 20_000 }, { cmd: 'send', on: false }]);
    second.setPeers(['aaa']);
    second.setSink({ kind: 'window' });
    expect(g.sent.slice(5)).toEqual([{ cmd: 'peer', id: 'aaa', initiator: false }, { cmd: 'sink', kind: 'window' }]);
    expect(second.status().fallback).toBe(false);
  });

  it("D10.3.4 (2026-11-07): the first 0.2.37 match's order: the helper's status is ready, the mesh is made and synced, then the same generation's `ready` event lands: one `peer` command, nothing said twice", () => {
    const h = stubHelper();
    h.readyStatus(); // generation 1, ready; its `ready` event is still in the pipe
    const log: string[] = [];
    const mesh = createVideoMesh({ helper: h.helper, localId: 'bbb', sendSignal: () => undefined, log: (l) => log.push(l) });
    mesh.setIce([{ urls: ['stun:s'] }]);
    mesh.setSink({ kind: 'window' });
    mesh.setPeers(['aaa']);
    expect(h.sent.map((c) => c.cmd)).toEqual(['ice', 'source', 'sink', 'rungs', 'send', 'ice', 'sink', 'peer']);
    h.say({ event: 'signal', id: 'aaa', kind: 'offer', sdp: 'v=0 from aaa' });
    const n = h.sent.length;
    // 200 ms later, tonight's second sync: now a no-op (the generation is synced); the peer that answered stands.
    h.readyEvent();
    expect(h.sent).toHaveLength(n);
    expect(h.sent.filter((c) => c.cmd === 'peer')).toEqual([{ cmd: 'peer', id: 'aaa', initiator: false }]);
    h.say({ event: 'peer', id: 'aaa', ice: 'connected', pair: 'srflx<->host' });
    expect(mesh.status().peers.aaa).toMatchObject({ ice: 'connected', pair: 'srflx↔host', failed: false });
    // A real restart (generation 2): everything again, the peer included.
    h.set({ helper: 'starting', reason: 'restarting' });
    h.sent.length = 0;
    h.ready();
    expect(h.sent).toEqual([
      { cmd: 'ice', servers: [{ urls: ['stun:s'] }] },
      { cmd: 'source', kind: 'none' },
      { cmd: 'sink', kind: 'window' },
      { cmd: 'rungs', max_kbps: 20_000 },
      { cmd: 'send', on: false },
      { cmd: 'peer', id: 'aaa', initiator: false },
    ]);
    expect(mesh.status().peers.aaa?.ice).toBe('new');
  });

  it('D10.3.6: a peer failed with the restarts exhausted sets `failed` and the fallback once, logged once; a plain failed (a restart coming) does not; a helper that goes unavailable mid-match falls back too', () => {
    const h = stubHelper();
    h.ready();
    const log: string[] = [];
    const statuses: NativeVideoStatus[] = [];
    const mesh = createVideoMesh({ helper: h.helper, localId: 'bbb', sendSignal: () => undefined, log: (l) => log.push(l) });
    mesh.onStatus((s) => statuses.push(s));
    mesh.setPeers(['aaa', 'ccc']);
    h.say({ event: 'peer', id: 'aaa', ice: 'checking' });
    h.say({ event: 'peer', id: 'aaa', ice: 'failed' });
    expect(mesh.status()).toMatchObject({ fallback: false, peers: { aaa: { ice: 'failed', failed: false } } });
    h.say({ event: 'peer', id: 'aaa', ice: 'connected', pair: 'relay<->host', restarts: 1 });
    expect(log).toContain('video: peer aaa: ice connected (relay↔host) after 1 restart');
    h.say({ event: 'peer', id: 'ccc', ice: 'failed', restarts: 3, restarts_exhausted: true });
    expect(mesh.status()).toMatchObject({ fallback: true, peers: { aaa: { ice: 'connected', failed: false }, ccc: { ice: 'failed', failed: true } } });
    expect(statuses.at(-1)?.fallback).toBe(true);
    const line = 'media: native video failed to connect (peer ccc, 3 restarts); the Electron video serves this match';
    expect(log.filter((l) => l === line)).toHaveLength(1);
    // Said once: a second peer failing, or the same one again, adds nothing; a connection later clears the peer's mark, not the fallback.
    h.say({ event: 'peer', id: 'ccc', ice: 'failed', restarts: 3, restarts_exhausted: true });
    h.say({ event: 'peer', id: 'aaa', ice: 'failed', restarts: 3, restarts_exhausted: true });
    expect(log.filter((l) => l.startsWith('media: native video failed'))).toHaveLength(1);
    h.say({ event: 'peer', id: 'ccc', ice: 'connected', pair: 'host<->host', restarts: 4 });
    expect(mesh.status()).toMatchObject({ fallback: true, peers: { ccc: { ice: 'connected', failed: false } } });
    expect(headsetVideoLine(mesh.status())).toBeNull();
    // Another match (another mesh) on a helper that is gone for good: fallback at once, no line (the helper said its own).
    const g = stubHelper();
    g.ready();
    const glog: string[] = [];
    const second = createVideoMesh({ helper: g.helper, localId: 'bbb', sendSignal: () => undefined, log: (l) => glog.push(l) });
    second.setPeers(['aaa']);
    expect(second.status().fallback).toBe(false);
    g.set({ helper: 'unavailable', reason: 'helper_failed:2' });
    expect(second.status()).toMatchObject({ helper: 'unavailable', reason: 'helper_failed:2', fallback: true, peers: { aaa: { ice: 'new' } } });
    expect(glog.filter((l) => l.startsWith('media:'))).toEqual([]);
  });
});
