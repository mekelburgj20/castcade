/**
 * D7.6.3 (saved frames) and D7.6 (the VR test bench) in rtc-host, on a faked Electron (the same fakes as
 * rtc-host.test.ts, kept in this file so each feature's tests stand alone).
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LayerCameraFrame, LayerCameraRequest, LayerCameraStatus, MediaSignal, MediaSignalling, VrOverlay } from './match-media-types.js';
import { DEFAULT_MEDIA_SETTINGS, patchMediaSettings, type MediaSettings, type MediaSettingsStore } from './media-settings.js';
import { PANEL_CHANNELS } from './panel-page.js';
import { createFrameSaver, loadClip, type Playback } from './frame-clip.js';
import type { VpxWindow } from './window-geometry.js';

const fake = vi.hoisted(() => {
  class FakeWebContents {
    sent: Array<[string, unknown]> = [];
    handlers = new Map<string, (...a: unknown[]) => void>();
    send(ch: string, payload?: unknown): void {
      this.sent.push([ch, payload]);
    }
    on(ev: string, cb: (...a: unknown[]) => void): void {
      this.handlers.set(ev, cb);
    }
    setFrameRate(): void {}
    setWindowOpenHandler(): void {}
  }
  class FakeWindow {
    static all: FakeWindow[] = [];
    webContents = new FakeWebContents();
    destroyed = false;
    visible = false;
    shown = 0;
    constructor(readonly opts: Record<string, unknown>) {
      FakeWindow.all.push(this);
    }
    setPosition(): void {}
    getBounds() {
      return { x: 0, y: 0, width: 480, height: 720 };
    }
    isVisible(): boolean {
      return this.visible;
    }
    setContentProtection(): void {}
    async loadFile(): Promise<void> {}
    on(): void {}
    isDestroyed(): boolean {
      return this.destroyed;
    }
    destroy(): void {
      this.destroyed = true;
    }
    showInactive(): void {
      this.shown++;
      this.visible = true;
    }
    hide(): void {
      this.visible = false;
    }
  }
  const ipc = new Map<string, (e: { sender: unknown }, arg?: unknown) => void>();
  const ses = { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, setDisplayMediaRequestHandler() {} };
  return { FakeWindow, ipc, ses };
});

vi.mock('electron', () => ({
  BrowserWindow: fake.FakeWindow,
  powerSaveBlocker: { start: () => 7, stop: () => undefined },
  ipcMain: { on: (ch: string, cb: (e: { sender: unknown }, arg?: unknown) => void) => fake.ipc.set(ch, cb) },
  session: { fromPartition: () => fake.ses },
  desktopCapturer: { getSources: async () => [{ id: 'screen:0:0', name: 'Screen 1', display_id: '1' }] },
  screen: {
    getAllDisplays: () => [{ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }],
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }),
    getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }),
    dipToScreenRect: (_w: unknown, r: { x: number; y: number; width: number; height: number }) => r,
  },
}));

const { createRtcHost } = await import('./rtc-host.js');

const PLAYER: VpxWindow = { pid: 7, title: 'Visual Pinball Player', client: { left: 0, top: 0, width: 1280, height: 720 }, monitor: '1' };
const VD = { inVr: true, headsetPanel: true, runtime: 'virtual-desktop' } as const;

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

function store(initial: Partial<MediaSettings> = {}): MediaSettingsStore {
  let s: MediaSettings = { ...DEFAULT_MEDIA_SETTINGS, ...initial };
  return { get: () => s, patch: (p) => (s = patchMediaSettings(s, p)) };
}

function signalling(localId: string): MediaSignalling {
  return { localId, send: (_to: string, _s: MediaSignal) => undefined, onSignal: () => () => undefined };
}

function fakeLayer() {
  const frameCbs = new Set<(f: LayerCameraFrame) => void>();
  let st: LayerCameraStatus = { state: 'off', why: null, lastFrameAt: null, frames: 0 };
  const asks: Array<LayerCameraRequest | null> = [];
  const layer: VrOverlay = {
    start: async () => ({ state: 'showing', reason: null }),
    setMode: () => undefined,
    stop: async () => undefined,
    status: () => ({ state: 'showing', reason: null }),
    onStatus: () => () => undefined,
    setCamera(r) {
      asks.push(r);
      st = r ? { state: 'asked', why: null, lastFrameAt: null, frames: 0 } : { state: 'off', why: null, lastFrameAt: null, frames: 0 };
    },
    onCameraFrame(cb) {
      frameCbs.add(cb);
      return () => void frameCbs.delete(cb);
    },
    cameraStatus: () => st,
    onCameraStatus: () => () => undefined,
    layerProtocol: () => 3,
  };
  const eye = (b: number) => ({
    fov: [-0.9, 0.8, 0.9, -0.95] as [number, number, number, number],
    rect: [450, 0, 900, 1800] as [number, number, number, number],
    render: [1800, 1800] as [number, number],
    data: new Uint8Array([0xff, 0xd8, b]),
  });
  return {
    layer,
    asks,
    listening: () => frameCbs.size,
    frame(n: number): void {
      st = { ...st, state: 'on', lastFrameAt: Date.now(), frames: st.frames + 1 };
      const f: LayerCameraFrame = { n, t: n * 33_333, encoding: 'jpeg', width: 720, height: 1440, eyes: [eye(1), eye(2)], us: null };
      frameCbs.forEach((cb) => cb(f));
    },
  };
}

let dir: string;
const logs: string[] = [];
const log = { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(`WARN ${m}`) };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'castcade-bench-'));
  fake.FakeWindow.all = [];
  fake.ipc.clear();
  logs.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});
const fromPage = (w: InstanceType<typeof fake.FakeWindow>, ch: string, arg?: unknown): void => fake.ipc.get(ch)?.({ sender: w.webContents }, arg);
const sentOn = (w: InstanceType<typeof fake.FakeWindow>, ch: string) => w.webContents.sent.filter(([c]) => c === ch).map(([, p]) => p);

describe('save frames in rtc-host (D7.6.3)', () => {
  it('a match with the layer camera and theater on: the camera frames and the page’s saved theater frames are written, with clip.json', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const cam = fakeLayer();
    const host = createRtcHost({ userData: dir, log, probe: async () => ({ outputs: [], windows: [PLAYER] }), settings: store() });
    host.setCameraLayer(cam.layer);
    host.setCameraSource('layer');
    await host.setVr(VD);
    await host.attach(signalling('owner'), ['krobs']);
    const w = fake.FakeWindow.all.at(-1)!;
    fromPage(w, PANEL_CHANNELS.ready);
    await settle();
    host.videoFrames()!.setWanted(true); // the layer wants the theater feed
    const out = join(dir, 'logs', 'frames', '2026-11-03-101500');
    const done = host.saveFrames({ dir: out, folder: '2026-11-03-101500', settings: { match: { theaterScale: 0.8 } } });
    await expect(host.saveFrames({ dir: out, folder: 'x', settings: {} })).rejects.toThrow(/being saved already/);
    expect(sentOn(w, PANEL_CHANNELS.saveFrames)).toEqual([{ ms: 2000, max: 120 }]);
    cam.frame(1);
    cam.frame(2);
    fromPage(w, PANEL_CHANNELS.savedFrame, { i: 0, jpeg: new Uint8Array([0xff, 0xd8, 9]), width: 1440, height: 1440, stereo: 'sbs', eyes: null, at: Date.now(), source: 'peer krobs', skipped: 0 });
    fromPage(w, PANEL_CHANNELS.savedFrame, { jpeg: 'nope' });
    await vi.advanceTimersByTimeAsync(3600);
    const r = await done;
    expect(r).toMatchObject({ dir: out, sender: 2, receiver: 1, notes: [] });
    expect(readdirSync(out).sort()).toEqual(['0000-L.jpg', '0000-R.jpg', '0000.json', '0001-L.jpg', '0001-R.jpg', '0001.json', 'clip.json', 'in-0000.jpg', 'in-0000.json']);
    const clip = JSON.parse(readFileSync(join(out, 'clip.json'), 'utf8')) as { settings: Record<string, unknown> };
    expect(clip.settings).toMatchObject({ match: { theaterScale: 0.8 }, cameraRequest: { width: 720, height: 1440, fps: 30 }, cameraSetting: 'layer', capture: { label: 'VR layer camera' } });
    expect(logs).toContain(`media: frames: saving 2 s to ${out} (layer camera on, theater feed on)`);
    expect(logs.some((l) => l.startsWith('media: frames: saved 2 sender frame(s) (720x1440 per eye, 30 fps) and 1 received frame(s) (1440x1440 sbs)'))).toBe(true);
    // A frame after the save is not kept, and the camera listener of the save is gone (the match's own stays).
    expect(cam.listening()).toBe(1);
    await host.detach();
  });

  it('nothing running (screen capture, no theater): nothing written, and the notes say why', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const host = createRtcHost({ userData: dir, log, probe: async () => ({ outputs: [], windows: [PLAYER] }), settings: store() });
    const out = join(dir, 'frames', 'x');
    const done = host.saveFrames({ dir: out, folder: 'x', settings: {} });
    await vi.advanceTimersByTimeAsync(2200);
    const r = await done;
    expect(r.dir).toBeNull();
    expect(r.notes).toEqual([
      'sender: the layer camera is not running (Camera = VR layer in a match, or the VR test bench on "my own table, live")',
      'receiver: no theater feed is being handed to the layer (another player up in theater, or the VR test bench in the headset)',
    ]);
    expect(existsSync(out)).toBe(false);
    expect(logs).toContain('media: frames: nothing saved (no layer camera frame and no theater frame in 2 s)');
  });
});

describe('the VR test bench in rtc-host (D7.6)', () => {
  async function savedClip(): Promise<{ clipDir: string; clip: Playback }> {
    const clipDir = join(dir, 'logs', 'frames', '2026-11-03-101500');
    const s = createFrameSaver({ dir: clipDir, folder: '2026-11-03-101500', settings: {} });
    const geo = { fov: [-0.9, 0.8, 0.9, -0.95] as [number, number, number, number], rect: [0, 0, 720, 1440] as [number, number, number, number], render: [720, 1440] as [number, number] };
    for (let n = 0; n < 3; n++) s.senderFrame({ n, t: n * 33_333, encoding: 'jpeg', width: 720, height: 1440, eyes: [{ ...geo, data: new Uint8Array([0xff, 0xd8, n, 1]) }, { ...geo, data: new Uint8Array([0xff, 0xd8, n, 2]) }], us: null });
    await s.finish();
    return { clipDir, clip: loadClip(clipDir, 'sender')! };
  }

  it('refused while a match is attached; a match attach ends a running bench', async () => {
    const host = createRtcHost({ userData: dir, log, probe: async () => ({ outputs: [], windows: [PLAYER] }), settings: store() });
    await host.attach(signalling('owner'), ['krobs']);
    await expect(host.startBench({ source: 'live', path: 'direct', clip: null, clipDir: null, clipName: null, inVr: true, headsetPanel: true })).rejects.toThrow(/A match is on/);
    await host.detach();
    const { clipDir, clip } = await savedClip();
    await host.startBench({ source: 'clip', path: 'direct', clip, clipDir, clipName: '2026-11-03-101500', inVr: false, headsetPanel: false });
    expect(host.benchStatus()).toMatchObject({ source: 'clip', path: 'direct', headset: false });
    await host.attach(signalling('owner'), []);
    expect(logs).toContain('media: bench: ended (a match attaches)');
    expect(host.benchStatus()).toBeNull();
    await host.detach();
  });

  it('a saved clip on a PC: the desktop panel shows, the page gets the bench, frames loop at the clip’s fps one in flight; Stop closes it', async () => {
    const { clipDir, clip } = await savedClip();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const host = createRtcHost({ userData: dir, log, probe: async () => ({ outputs: [], windows: [PLAYER] }), settings: store() });
    const statuses: unknown[] = [];
    host.onBenchStatus((s) => statuses.push(s));
    await host.startBench({ source: 'clip', path: 'loop', clip, clipDir, clipName: '2026-11-03-101500', inVr: false, headsetPanel: false });
    const w = fake.FakeWindow.all.at(-1)!;
    expect(w.opts.show).toBe(false);
    expect(w.shown).toBe(1); // the desktop panel, shown at once
    expect(host.frames()).toBeNull(); // no headset panel on a PC
    expect(logs).toContain('media: bench: started: clip 2026-11-03-101500 (sender side, 3 frames at 30 fps), through a local WebRTC loop, the desktop panel');
    fromPage(w, PANEL_CHANNELS.ready);
    expect(sentOn(w, PANEL_CHANNELS.bench)).toEqual([{ path: 'loop', source: 'clip' }]);
    expect(sentOn(w, PANEL_CHANNELS.attach)).toEqual([]);
    const frames = () => sentOn(w, PANEL_CHANNELS.benchFrame) as Array<{ n: number; width: number; height: number; left: Uint8Array; right: Uint8Array | null; stereo: string }>;
    vi.advanceTimersByTime(20);
    expect(frames()).toHaveLength(1);
    expect(frames()[0]).toMatchObject({ n: 0, width: 720, height: 1440, stereo: 'sbs' });
    expect([...frames()[0]!.left]).toEqual([0xff, 0xd8, 0, 1]);
    expect([...frames()[0]!.right!]).toEqual([0xff, 0xd8, 0, 2]);
    vi.advanceTimersByTime(40); // the next clip frame is due, but the first is not acked: it waits
    expect(frames()).toHaveLength(1);
    fromPage(w, PANEL_CHANNELS.benchAck);
    expect(frames()).toHaveLength(2);
    expect([...frames()[1]!.left]).toEqual([0xff, 0xd8, 1, 1]);
    // the readout: kept, emitted, logged every 10 s
    fromPage(w, PANEL_CHANNELS.benchStatus, { path: 'loop', drawn: 30, fed: null, sent: { width: 1440, height: 1440, kbps: 7900, fps: 30, limit: 'none' }, bitrate: 8e6, loopUp: true });
    expect(host.benchStatus()!.readout).toBe('30 fps drawn · no headset layer: the picture is in the desktop panel · encoder sent 1440x1440 at 7.9 Mbps (cap 8.0 Mbps), 30 fps, limited by none');
    expect(statuses.length).toBeGreaterThan(1);
    vi.advanceTimersByTime(10_000);
    fromPage(w, PANEL_CHANNELS.benchStatus, { path: 'loop', drawn: 30, fed: null, sent: null, loopUp: true });
    expect(logs).toContain('media: bench: 30 fps drawn · no headset layer: the picture is in the desktop panel · encoder: no stats yet');
    await host.stopBench();
    expect(w.destroyed).toBe(true);
    expect(sentOn(w, PANEL_CHANNELS.detach)).toHaveLength(1);
    expect(host.benchStatus()).toBeNull();
    expect(statuses.at(-1)).toBeNull();
    expect(logs).toContain('media: bench: stopped, the panel closed');
    const n = frames().length;
    vi.advanceTimersByTime(1000);
    expect(frames()).toHaveLength(n); // the clip timer is gone
  });

  it('own table live in the headset: the layer camera is asked, its frames go to the page, the theater sources serve the bench; Stop stops the camera', async () => {
    const cam = fakeLayer();
    const host = createRtcHost({ userData: dir, log, probe: async () => ({ outputs: [], windows: [PLAYER] }), settings: store() });
    host.setCameraLayer(cam.layer);
    await host.startBench({ source: 'live', path: 'direct', clip: null, clipDir: null, clipName: null, inVr: true, headsetPanel: true });
    const w = fake.FakeWindow.all.at(-1)!;
    expect((w.opts.webPreferences as { offscreen: boolean }).offscreen).toBe(true);
    expect(cam.asks).toEqual([{ width: 720, height: 1440, fps: 30 }]);
    expect(host.frames()).not.toBeNull();
    host.videoFrames()!.setWanted(true); // the layer in theater wants the feed: queued until the page is ready
    cam.frame(1); // before ready: not sent
    fromPage(w, PANEL_CHANNELS.ready);
    expect(sentOn(w, PANEL_CHANNELS.bench)).toEqual([{ path: 'direct', source: 'live' }]);
    expect(sentOn(w, PANEL_CHANNELS.videoWant)).toEqual([true]);
    cam.frame(2);
    expect(sentOn(w, PANEL_CHANNELS.benchFrame)).toMatchObject([{ n: 2, width: 720, height: 1440, stereo: 'sbs' }]);
    expect(host.benchStatus()).toMatchObject({ source: 'live', headset: true, camera: { state: 'on' } });
    await host.stopBench();
    expect(cam.asks.at(-1)).toBeNull();
    expect(cam.listening()).toBe(0);
    expect(host.frames()).toBeNull();
  });
});
