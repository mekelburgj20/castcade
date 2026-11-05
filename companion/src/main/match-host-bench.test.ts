/**
 * D7.6 (2026-11-03): the VR test bench in the match host: refused while a match is on, theater through the OpenXR
 * layer on a VR rig (Theater size live, the direct view to compare), the desktop panel on a PC, Stop gives VPX its
 * own view back and detaches; a match hosted stops it. Electron stubbed (the cue window only); the media layer and
 * the layer are fakes.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => {
  class BrowserWindow {
    webContents = { once: (_e: string, cb: () => void) => cb(), send: () => undefined };
    isDestroyed(): boolean {
      return false;
    }
    loadFile(): Promise<void> {
      return Promise.resolve();
    }
    destroy(): void {}
  }
  return { BrowserWindow, ipcMain: { on: () => undefined } };
});

const { createMatchHost } = await import('./match-host.js');
const { createFrameSaver } = await import('../media/frame-clip.js');
type Opts = Parameters<typeof createMatchHost>[0];
type MatchHost = ReturnType<typeof createMatchHost>;

const lines: string[] = [];
const push = (l: string): number => lines.push(l);
const log = { info: push, warn: push, error: push, file: '' } as unknown as Opts['log'];

const witness = {
  status: () => ({ paired: false, currentTable: 'Monster Bash', currentIdentity: { sha256: 'ab'.repeat(32), tableInfo: null }, currentAttestation: null }),
  sampleVr: async () => null,
  onEvent: () => () => undefined,
  onStatus: () => () => undefined,
} as unknown as Opts['witness'];

function fakeMedia() {
  const calls: string[] = [];
  let bench: { source: string; path: string; headsetPanel: boolean; bitrate?: number | null } | null = null;
  const source = { onFrame: () => () => undefined };
  const video = { onFrame: () => () => undefined, setWanted: () => undefined };
  const media = {
    attach: async () => void calls.push('attach'),
    addPeer: () => undefined,
    removePeer: () => undefined,
    setSending: () => undefined,
    setPanelState: () => undefined,
    setMuted: () => undefined,
    status: () => ({ attached: false, sending: false, peers: {}, mic: 'open', captureSource: null, lastError: null }),
    onStatus: () => () => undefined,
    frames: () => (bench?.headsetPanel ? source : null),
    videoFrames: () => (bench?.headsetPanel ? video : null),
    showPanel: () => void calls.push('showPanel'),
    detach: async () => void calls.push('detach'),
    setVr: async () => undefined,
    setCameraView: (v: string) => void calls.push(`setCameraView ${v}`),
    async startBench(o: { source: string; path: string; headsetPanel: boolean; clip: { frames: unknown[] } | null; clipName: string | null; bitrate: number | null }) {
      calls.push(`startBench ${o.source} ${o.path} ${o.headsetPanel ? 'headset' : 'desktop'}${o.clip ? ` ${o.clipName} ${o.clip.frames.length}` : ''}${o.bitrate ? ` cap ${o.bitrate}` : ''}`);
      bench = o;
    },
    async stopBench() {
      calls.push('stopBench');
      bench = null;
    },
    benchStatus: () => (bench ? { source: bench.source, path: bench.path, headset: bench.headsetPanel, report: null, camera: null, readout: '30 fps drawn' } : null),
    onBenchStatus: () => () => undefined,
  };
  return { media: media as unknown as NonNullable<Opts['media']>, calls, source, video };
}

function fakeLayer() {
  const modes: string[] = [];
  const scales: number[] = [];
  /** D7.6.10: the window tuning and soft edge pushed, as words (depth / left / right / feather). */
  const tunes: string[] = [];
  const started: unknown[] = [];
  let stops = 0;
  const overlay = {
    async start(src: unknown, v?: unknown) {
      started.push([src, v]);
      return { state: 'showing', reason: null };
    },
    async stop() {
      stops++;
    },
    status: () => ({ state: 'showing', reason: null }),
    onStatus: () => () => undefined,
    setMode: (m: string) => void modes.push(m),
    setTheaterScale: (s: number) => void scales.push(s),
    setWindowTune: (t: { depthM: number | null; dyDeg: [number, number] }) => void tunes.push(`tune ${t.depthM ?? 'inf'} ${t.dyDeg[0]} ${t.dyDeg[1]}`),
    setSoftEdge: (f: number) => void tunes.push(`feather ${f}`),
  };
  return { overlay: overlay as unknown as NonNullable<Opts['vrLayer']>, modes, scales, tunes, started, stops: () => stops };
}

const dirs: string[] = [];
const hosts: MatchHost[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  lines.length = 0;
});

function make(extra: Partial<Opts>): { mh: MatchHost; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'castcade-bench-host-'));
  dirs.push(dir);
  const mh = createMatchHost({
    file: join(dir, 'match.json'),
    keysFile: join(dir, 'match-keys.json'),
    witness,
    device: () => ({ deviceId: 'dev-owner', deviceLabel: 'owner' }),
    appVersion: '0.2.33',
    log,
    publicIp: () => Promise.resolve('127.0.0.1'),
    lockFile: join(dir, 'lock', 'turn.lock'),
    listenAddress: '127.0.0.1',
    ...extra,
  });
  hosts.push(mh);
  return { mh, dir };
}

const VD_RIG = async () => ({ rig: 'vr_headset' as const, reason: 'test: VPX in VR on Virtual Desktop', runtime: 'virtual-desktop' as const });
const PC_RIG = async () => ({ rig: 'pc' as const, reason: 'test: the monitor', runtime: null });
const port = (): number => 45000 + Math.floor(Math.random() * 2000);

describe('the VR test bench in the match host (D7.6)', () => {
  it('own table live on a VR rig: theater through the layer, Theater size live, the direct view to compare; Stop gives VPX its view back and detaches', async () => {
    const m = fakeMedia();
    const layer = fakeLayer();
    const { mh } = make({ media: m.media, vrLayer: layer.overlay, rig: VD_RIG });
    const st = await mh.startBench({ source: 'live', path: 'loop' });
    expect(m.calls).toEqual(['setCameraView whole', 'startBench live loop headset']);
    expect(layer.started).toEqual([[m.source, m.video]]);
    expect(layer.modes).toEqual(['theater']);
    expect(layer.scales[0]).toBe(1);
    expect(st.bench).toMatchObject({ state: 'running', source: 'live', path: 'loop', headset: true, view: 'theater', readout: '30 fps drawn' });
    expect(st.bench!.hint).toBe('In the headset: a single window straight ahead, life size at Theater size 1; the picture should fuse without effort; compare detail with the direct view.');
    expect(lines).toContain('bench: running (vr_headset via virtual-desktop; theater in the headset; whole view, soft edge 3%)');
    // D7.6.10: the window's tuning went with Theater size at the start (the defaults: infinity, no offset, 3 % soft edge).
    expect(layer.tunes.slice(0, 2)).toEqual(['tune inf 0 0', 'feather 0.03']);
    // Theater size applies at once.
    mh.setSettings({ theaterScale: 0.8 });
    expect(layer.scales.at(-1)).toBe(0.8);
    // D7.6.10: so do the window depth, the eye offsets and the soft edge, each pushed on every settings change.
    layer.tunes.length = 0;
    mh.setSettings({ windowDepthM: 2.6, eyeOffsetDeg: [0.5, -0.5], softEdge: 0.06 });
    expect(layer.tunes).toEqual(['tune 2.6 0.5 -0.5', 'feather 0.06']);
    expect(lines).toContain('match: stereo window, window depth 2.6 m, vertical offset L +0.5 R -0.5 deg, soft edge 6% on the Match tab');
    mh.setSettings({ windowDepthM: null, eyeOffsetDeg: [0, 0], softEdge: 0 });
    expect(lines).toContain('match: stereo window: depth infinity, no vertical offset, hard edges on the Match tab');
    // D7.5.9: the camera view reaches the media layer, live.
    mh.setSettings({ cameraView: 'window' });
    expect(m.calls.at(-1)).toBe('setCameraView window');
    expect(lines).toContain('match: camera view set to the 1:2 window crop on the Match tab');
    // VPX's own view to compare, and back.
    expect(mh.setBenchView('direct').bench).toMatchObject({ view: 'direct' });
    mh.setBenchView('theater');
    expect(layer.modes).toEqual(['theater', 'hidden', 'theater']);
    // A second start is refused while it runs.
    await expect(mh.startBench({ source: 'live' })).rejects.toThrow(/running already/);
    const off = await mh.stopBench();
    expect(off.bench).toBeNull();
    expect(layer.modes.at(-1)).toBe('hidden');
    expect(layer.stops()).toBe(1);
    expect(m.calls.at(-1)).toBe('stopBench');
    expect(lines).toContain("bench: stopped (Stop on the Match tab); VPX's own view is back");
  });

  it('a saved clip on a PC: the desktop panel; own table live is refused there; a bad request is refused', async () => {
    const m = fakeMedia();
    const layer = fakeLayer();
    const { mh, dir } = make({ media: m.media, vrLayer: layer.overlay, rig: PC_RIG });
    await expect(mh.startBench({ source: 'live' })).rejects.toThrow(/needs VPX running in VR/);
    await expect(mh.startBench({ source: 'clip', clip: { name: '2026-11-03-101500' } })).rejects.toThrow(/has no eye frames to play/);
    await expect(mh.startBench({ source: 'nothing' })).rejects.toThrow(/Pick a source/);
    // D7.6.9: the loop's bitrate cap is null (the match's rule) or a whole number of bits per second, 1 to 100 Mbps.
    await expect(mh.startBench({ source: 'live', path: 'loop', bitrate: 500_000 })).rejects.toThrow("The bitrate cap must be between 1 and 100 Mbps, or the match's rule");
    await expect(mh.startBench({ source: 'live', path: 'loop', bitrate: 200_000_000 })).rejects.toThrow(/bitrate cap/);
    await expect(mh.startBench({ source: 'live', path: 'loop', bitrate: '16000000' })).rejects.toThrow(/bitrate cap/);
    expect(mh.status().bench).toBeNull();
    const s = createFrameSaver({ dir: join(dir, 'logs', 'frames', '2026-11-03-101500'), folder: '2026-11-03-101500', settings: {} });
    s.receiverFrame({ jpeg: new Uint8Array([0xff, 0xd8]), width: 1440, height: 1440, stereo: 'sbs', eyes: null, at: Date.now(), source: 'peer krobs', skipped: 0 });
    await s.finish();
    expect(mh.benchClips()).toMatchObject([{ name: '2026-11-03-101500', sender: null, receiver: { count: 1 } }]);
    const st = await mh.startBench({ source: 'clip', path: 'direct', clip: { name: '2026-11-03-101500', side: 'receiver' } });
    expect(m.calls).toEqual(['setCameraView whole', 'startBench clip direct desktop 2026-11-03-101500 1', 'showPanel']);
    expect(layer.started).toEqual([]);
    expect(st.bench).toMatchObject({ state: 'running', headset: false, clip: '2026-11-03-101500 (received frames)' });
    expect(st.bench!.hint).toMatch(/desktop panel window/);
    await mh.stopBench();
    expect(layer.modes).toEqual([]);
    expect(lines).toContain('bench: stopped (Stop on the Match tab)');
  });

  it('the loop’s bitrate cap override reaches the media layer; null is the match’s rule (D7.6.9)', async () => {
    const m = fakeMedia();
    const layer = fakeLayer();
    const { mh } = make({ media: m.media, vrLayer: layer.overlay, rig: VD_RIG });
    await mh.startBench({ source: 'live', path: 'loop', bitrate: 16_000_000 });
    expect(m.calls).toEqual(['setCameraView whole', 'startBench live loop headset cap 16000000']);
    await mh.stopBench();
    await mh.startBench({ source: 'live', path: 'loop', bitrate: null });
    expect(m.calls.at(-1)).toBe('startBench live loop headset');
    await mh.stopBench();
  });

  it('refused while a match is on; a match hosted stops a running bench first', async () => {
    const m = fakeMedia();
    const layer = fakeLayer();
    const { mh } = make({ media: m.media, vrLayer: layer.overlay, rig: VD_RIG });
    await mh.startBench({ source: 'live' });
    await mh.host({ port: port(), ballsPerGame: 3, displayName: 'Owner' });
    expect(m.calls.slice(0, 4)).toEqual(['setCameraView whole', 'startBench live direct headset', 'stopBench', 'attach']);
    expect(lines).toContain("bench: stopped (a match is hosted); VPX's own view is back");
    expect(mh.status().bench).toBeNull();
    await expect(mh.startBench({ source: 'live' })).rejects.toThrow('A match is on: the VR test bench runs only without a match. Leave the match first.');
    await mh.leave();
  });
});
