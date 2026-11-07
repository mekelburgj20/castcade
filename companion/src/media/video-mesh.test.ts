import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { MediaSignal, NativeVideoStatus } from './match-media-types.js';
import { createVideoHelper, type VideoHelper, type VideoHelperCommand, type VideoHelperEvent, type VideoHelperStatus } from './video-helper.js';
import { createVideoMesh, helperIceServers, initiates, pairWords, type VideoMesh } from './video-mesh.js';

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
    expect(a.mesh.status().peers).toEqual({ bbb: { ice: 'new', pair: null, send: null, recv: null } });
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
    expect(a.mesh.status()).toMatchObject({ helper: 'ready', encoder: 'libx264', decoder: 'h264', sending: false, sink: 'none', source: { kind: 'none', state: 'ok', fpsIn: 0 } });
    // The rig's wiring: the turn, the ring source, the sink, the ICE list and the ladder, each a helper command once.
    a.mesh.setSource({ kind: 'ring', token: 'tok_send_0123456', width: 1354, height: 1440, fps: 60 });
    a.mesh.setSending(true);
    a.mesh.setSending(true);
    a.mesh.setSink({ kind: 'ring', token: 'tok_recv_0123456' });
    b.mesh.setSink({ kind: 'window' });
    a.mesh.setIce([{ urls: ['stun:stun.l.google.com:19302'] }, { urls: 'turn:relay.example.org:3478', username: 'u', credential: 'c' }]);
    a.mesh.setRungs({ max_kbps: 8000, pin: 2 });
    await until(() => fakeLogs(a).some((t) => t.startsWith('rungs max 8000')));
    // The first ready told it the whole (empty) state; then each change once, in the helper's order.
    expect(fakeLogs(a)).toEqual(['ice 0 server(s)', 'sink none', 'rungs max 20000 kbps', 'send off (none)', 'send on (ring)', 'sink ring tok_recv_0123456', 'ice 2 server(s)', 'rungs max 8000 kbps, pinned 2']);
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
});

// ---- the helper faked in place: what is said, and said again after a restart ----

function stubHelper() {
  const sent: VideoHelperCommand[] = [];
  const eventCbs = new Set<(e: VideoHelperEvent) => void>();
  const statusCbs = new Set<(s: VideoHelperStatus) => void>();
  let status: VideoHelperStatus = { helper: 'stopped', reason: null, version: null, encoder: null, decoder: null };
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
  const ready = (): void => {
    set({ helper: 'ready', reason: null, version: '1', encoder: 'h264_nvenc', decoder: 'nvdec' });
    eventCbs.forEach((cb) => cb({ event: 'ready', version: '1', encoder: 'h264_nvenc', decoder: 'nvdec' }));
  };
  const say = (e: VideoHelperEvent): void => eventCbs.forEach((cb) => cb(e));
  return { helper, sent, set, ready, say };
}

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
    expect(mesh.status().peers.aaa).toEqual({ ice: 'connected', pair: 'srflx↔relay', send: null, recv: { fps: 30, kbps: 5000, width: 1016, height: 1080 } });
    expect(mesh.status().source).toMatchObject({ state: 'missing', fpsIn: 0 });
    expect(log).toContain('video: source ring: missing (the ring is not being filled)');
    // Nothing changed: nothing more is said.
    const n = h.sent.length;
    mesh.setPeers(['ccc', 'aaa']);
    mesh.setSending(true);
    mesh.setIce([{ urls: ['stun:s'] }]);
    expect(h.sent).toHaveLength(n);
    // The helper dies and comes back: everything again, peers included; its old views are gone meanwhile.
    h.set({ helper: 'starting', reason: 'restarting' });
    expect(mesh.status()).toMatchObject({ helper: 'starting', reason: 'restarting', peers: { aaa: { ice: 'new', pair: null, send: null, recv: null } } });
    h.sent.length = 0;
    h.ready();
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

  it('a helper that is unavailable: the status says why and nothing is sent; a helper that is ready already is told at once', () => {
    const h = stubHelper();
    h.set({ helper: 'unavailable', reason: 'helper_missing' });
    const mesh = createVideoMesh({ helper: h.helper, localId: 'bbb', sendSignal: () => undefined, log: () => undefined });
    mesh.setPeers(['aaa']);
    mesh.setSending(true);
    expect(h.sent).toEqual([]);
    expect(mesh.status()).toMatchObject({ helper: 'unavailable', reason: 'helper_missing', sending: true, peers: { aaa: { ice: 'new' } } });
    const g = stubHelper();
    g.ready();
    const second = createVideoMesh({ helper: g.helper, localId: 'bbb', sendSignal: () => undefined, log: () => undefined });
    // The whole (empty) state at creation, then each setting as a single command.
    expect(g.sent).toEqual([{ cmd: 'ice', servers: [] }, { cmd: 'source', kind: 'none' }, { cmd: 'sink', kind: 'none' }, { cmd: 'rungs', max_kbps: 20_000 }, { cmd: 'send', on: false }]);
    second.setPeers(['aaa']);
    second.setSink({ kind: 'window' });
    expect(g.sent.slice(5)).toEqual([{ cmd: 'peer', id: 'aaa', initiator: false }, { cmd: 'sink', kind: 'window' }]);
  });
});
