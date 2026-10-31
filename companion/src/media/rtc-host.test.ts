import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaSignal, MediaSignalling, MediaStatus, PanelFrame } from './match-media-types.js';
import { DEFAULT_MEDIA_SETTINGS, patchMediaSettings, type MediaSettings, type MediaSettingsStore } from './media-settings.js';
import { MIC_LIST_CHANNEL, PANEL_CHANNELS, type PanelPageStatus } from './panel-page.js';
import type { VpxWindow, WindowProbe } from './window-geometry.js';

// ---- Electron, faked: windows record what they were built with and what they were sent ----

const fake = vi.hoisted(() => {
  class FakeWebContents {
    sent: Array<[string, unknown]> = [];
    handlers = new Map<string, (...a: unknown[]) => void>();
    frameRate: number | null = null;
    send(ch: string, payload?: unknown): void {
      this.sent.push([ch, payload]);
    }
    on(ev: string, cb: (...a: unknown[]) => void): void {
      this.handlers.set(ev, cb);
    }
    setFrameRate(n: number): void {
      this.frameRate = n;
    }
    setWindowOpenHandler(): void {}
  }
  class FakeWindow {
    static all: FakeWindow[] = [];
    webContents = new FakeWebContents();
    handlers = new Map<string, (e: { preventDefault(): void }) => void>();
    loaded: string | null = null;
    destroyed = false;
    shown = 0;
    hidden = 0;
    contentProtected = false;
    setContentProtection(on: boolean): void {
      this.contentProtected = on;
    }
    constructor(readonly opts: Record<string, unknown>) {
      FakeWindow.all.push(this);
    }
    async loadFile(f: string): Promise<void> {
      this.loaded = f;
    }
    on(ev: string, cb: (e: { preventDefault(): void }) => void): void {
      this.handlers.set(ev, cb);
    }
    isDestroyed(): boolean {
      return this.destroyed;
    }
    destroy(): void {
      this.destroyed = true;
    }
    showInactive(): void {
      this.shown++;
    }
    hide(): void {
      this.hidden++;
    }
  }
  const ipc = new Map<string, (e: { sender: unknown }, arg?: unknown) => void>();
  const ses = {
    displayHandler: null as null | ((req: unknown, cb: (s: unknown) => void) => void),
    permission: null as null | ((wc: unknown, p: string, cb: (ok: boolean) => void) => void),
    setPermissionRequestHandler(h: (wc: unknown, p: string, cb: (ok: boolean) => void) => void) {
      this.permission = h;
    },
    setPermissionCheckHandler() {},
    setDisplayMediaRequestHandler(h: (req: unknown, cb: (s: unknown) => void) => void) {
      this.displayHandler = h;
    },
  };
  const sources = { list: [{ id: 'screen:0:0', name: 'Screen 1', display_id: '1' }] as Array<{ id: string; name: string; display_id?: string }> };
  const displays = { list: [{ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }] };
  return { FakeWindow, ipc, ses, sources, displays };
});

vi.mock('electron', () => ({
  BrowserWindow: fake.FakeWindow,
  ipcMain: { on: (ch: string, cb: (e: { sender: unknown }, arg?: unknown) => void) => fake.ipc.set(ch, cb) },
  session: { fromPartition: () => fake.ses },
  desktopCapturer: { getSources: async () => fake.sources.list },
  screen: {
    getAllDisplays: () => fake.displays.list,
    dipToScreenRect: (_w: unknown, r: { x: number; y: number; width: number; height: number }) => r,
  },
}));

const { NO_PLAYFIELD_TO_SEND, captureLabel, createFrameHub, createRtcHost, frameFromBitmap, mergeStatus, noCaptureReason, pickCaptureWindow } = await import('./rtc-host.js');

const win = (title: string, width: number, height: number, pid = 7): VpxWindow => ({ pid, title, client: { left: 0, top: 0, width, height }, monitor: '1' });
const PLAYER = win('Visual Pinball Player', 1280, 720);
const EDITOR = win('Visual Pinball - [Monster Bash (Williams 1998)]', 1920, 1040);
const DMD = win('PUPDMD', 512, 128);
/** D2.5: what the page gets for PLAYER on the fake 1920x1080 display: its screen, and the window's crop of it. */
const LABEL = 'screen 1, crop 1280x720 of Visual Pinball Player';
const CAPTURE = { sourceId: 'screen:0:0', label: LABEL, screen: { width: 1920, height: 1080 }, crop: { x: 0, y: 0, width: 1280, height: 720 }, out: { width: 1280, height: 720 } };

/** In VR on SteamVR: the offscreen panel for the overlay helper. */
const VR_STEAM = { inVr: true, headsetPanel: true } as const;

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

describe('capture window choice (D2)', () => {
  it('the "Visual Pinball Player" window in both modes (in VR it IS the preview); never the editor', () => {
    expect(pickCaptureWindow([EDITOR, PLAYER, DMD], true)).toEqual({ window: PLAYER, fallback: false });
    expect(pickCaptureWindow([EDITOR, PLAYER, DMD], false)).toEqual({ window: PLAYER, fallback: false });
    expect(pickCaptureWindow([EDITOR], true)).toBeNull();
    expect(pickCaptureWindow([win('Visual Pinball', 800, 600)], true)).toBeNull();
  });

  it('VR without a player-titled window: the largest non-editor VPX window, flagged; the desktop sends nothing', () => {
    const vrWin = win('VPX VR Preview', 1280, 720);
    expect(pickCaptureWindow([EDITOR, DMD, vrWin], true)).toEqual({ window: vrWin, fallback: true });
    expect(pickCaptureWindow([EDITOR, DMD, vrWin], false)).toBeNull();
  });

  it('D2 (2026-10-31): never a DMD, backglass or PinUP window, nor one under 640x360; every player / DMD / editor combination', () => {
    // Krobs' rig in the first two-player match: VRPreview off, so VPX showed only the editor and the VPinMAME DMD.
    const PINMAME = win('Visual PinMAME', 1280, 720);
    const all = [PLAYER, PINMAME, EDITOR] as const;
    for (let mask = 0; mask < 8; mask++) {
      const list = all.filter((_, i) => mask & (1 << i));
      const hasPlayer = list.includes(PLAYER);
      for (const vr of [true, false]) {
        const pick = pickCaptureWindow(list, vr);
        const label = `${list.map((w) => w.title).join(' + ') || 'none'} (${vr ? 'VR' : 'desktop'})`;
        expect(pick, label).toEqual(hasPlayer ? { window: PLAYER, fallback: false } : null);
        if (hasPlayer) continue;
        const why = noCaptureReason(list, vr);
        if (!vr) expect(why, label).toBe('no "Visual Pinball Player" window to send: start the table');
        else if (list.includes(PINMAME)) expect(why, label).toBe(NO_PLAYFIELD_TO_SEND);
        else expect(why, label).toBe('no VPX window to send: open the table in VR with VRPreview on');
      }
    }
    expect(NO_PLAYFIELD_TO_SEND).toBe('no playfield window to send: turn on VRPreview in VPX (Preferences → VR) so there is a window to capture');
    // Every excluded title, however large; a small untitled-ish window too; a large other window still goes.
    for (const title of ['FlexDMD', 'Virtual DMD', 'PUPDMD', 'PinUP Player', 'B2S Backglass Server', 'Backglass', 'PinMAME DMD']) {
      expect(pickCaptureWindow([EDITOR, win(title, 1920, 1080)], true), title).toBeNull();
    }
    expect(pickCaptureWindow([win('Some VPX window', 639, 720), win('Other', 1280, 359)], true)).toBeNull();
    const preview = win('VPX VR Preview', 640, 360);
    expect(pickCaptureWindow([EDITOR, PINMAME, DMD, preview], true)).toEqual({ window: preview, fallback: true });
  });

  it('D2.5 labels: the screen, the crop size and the window; a fallback says so', () => {
    const t = { index: 1, crop: { x: 10, y: 20, width: 1280, height: 720 } };
    expect(captureLabel({ window: PLAYER, fallback: false }, t)).toBe('screen 2, crop 1280x720 of Visual Pinball Player');
    expect(captureLabel({ window: win('VPX VR Preview', 1280, 720), fallback: true }, t)).toBe('screen 2, crop 1280x720 of VPX VR Preview (the largest VPX window, none is titled "Visual Pinball Player")');
  });
});

describe('panel frames (D2)', () => {
  it('a bitmap the size says, or scaled by the display factor; anything else is dropped', () => {
    expect(frameFromBitmap(new Uint8Array(4 * 4 * 2), { width: 4, height: 2 })).toMatchObject({ width: 4, height: 2 });
    // 125 %: 960x640 DIPs painted as 1200x800
    expect(frameFromBitmap(new Uint8Array(1200 * 800 * 4), { width: 960, height: 640 })).toMatchObject({ width: 1200, height: 800 });
    expect(frameFromBitmap(new Uint8Array(30), { width: 4, height: 2 })).toBeNull();
    expect(frameFromBitmap(new Uint8Array(0), { width: 0, height: 0 })).toBeNull();
  });

  it('a busy listener misses frames until its promise settles; others still get every frame', async () => {
    const hub = createFrameHub();
    expect(hub.wanted()).toBe(false);
    const slow: number[] = [];
    const fast: number[] = [];
    let release: () => void = () => undefined;
    hub.source.onFrame((f) => {
      slow.push(f.width);
      return new Promise<void>((r) => (release = r)) as unknown as void;
    });
    const off = hub.source.onFrame((f) => fast.push(f.width));
    const frame = (w: number): PanelFrame => ({ width: w, height: 1, bgra: new Uint8Array(w * 4) });
    hub.push(frame(1));
    hub.push(frame(2));
    expect(hub.wanted()).toBe(true); // the fast one is free
    release();
    await settle();
    hub.push(frame(3));
    expect(slow).toEqual([1, 3]);
    expect(fast).toEqual([1, 2, 3]);
    off();
  });
});

describe('status (D2)', () => {
  const page: PanelPageStatus = { sending: true, peers: { krobs: { ice: 'connected', receivingVideo: true, receivingAudio: true } }, mic: 'open', capturing: true, error: 'page says' };
  it("merges the page's report with main's capture label; main's error wins; nothing while detached", () => {
    expect(mergeStatus(page, { attached: true, sending: true, captureLabel: 'Visual Pinball Player (1280x720)', error: null })).toEqual({
      attached: true,
      sending: true,
      peers: page.peers,
      mic: 'open',
      captureSource: 'Visual Pinball Player (1280x720)',
      lastError: 'page says',
    });
    expect(mergeStatus({ ...page, capturing: false }, { attached: true, sending: false, captureLabel: 'x', error: 'main says' })).toMatchObject({ captureSource: null, lastError: 'main says' });
    expect(mergeStatus(page, { attached: false, sending: true, captureLabel: 'x', error: null })).toEqual({ attached: false, sending: false, peers: {}, mic: 'unavailable', captureSource: null, lastError: null });
  });
});

// ---- createRtcHost over the fakes ----

function store(initial: Partial<MediaSettings> = {}): MediaSettingsStore {
  let s: MediaSettings = { ...DEFAULT_MEDIA_SETTINGS, ...initial };
  return { get: () => s, patch: (p) => (s = patchMediaSettings(s, p)) };
}

function signalling(localId: string) {
  const sent: Array<[string, MediaSignal]> = [];
  const listeners = new Set<(from: string, s: MediaSignal) => void>();
  const sig: MediaSignalling = {
    localId,
    send: (to, s) => sent.push([to, s]),
    onSignal: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
  return { sig, sent, deliver: (from: string, s: MediaSignal) => listeners.forEach((l) => l(from, s)), listeners };
}

describe('createRtcHost (D2)', () => {
  let dir: string;
  const logs: string[] = [];
  const log = { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(`WARN ${m}`) };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'castcade-rtc-'));
    fake.FakeWindow.all = [];
    fake.ipc.clear();
    fake.sources.list = [{ id: 'screen:0:0', name: 'Screen 1', display_id: '1' }];
    logs.length = 0;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const fromPage = (w: InstanceType<typeof fake.FakeWindow>, ch: string, arg?: unknown): void => fake.ipc.get(ch)?.({ sender: w.webContents }, arg);

  it('VR: an offscreen window at 20 fps; attach first, then what was said before the page was ready; signals both ways', async () => {
    let windows: VpxWindow[] = [win('Visual Pinball - [MB]', 800, 600), PLAYER];
    const probe = async (): Promise<WindowProbe> => ({ outputs: [], windows });
    const host = createRtcHost({ userData: dir, log, probe, settings: store({ micDeviceId: 'headset' }) });
    await host.setVr(VR_STEAM);
    const net = signalling('owner');
    const statuses: MediaStatus[] = [];
    host.onStatus((s) => statuses.push(s));
    await host.attach(net.sig, ['owner', 'krobs']);
    const w = fake.FakeWindow.all[0]!;
    expect(w.opts).toMatchObject({ show: false, width: 960, height: 640, webPreferences: { offscreen: true, partition: 'castcade-panel', autoplayPolicy: 'no-user-gesture-required' } });
    expect(w.webContents.frameRate).toBe(20);
    expect(w.loaded).toBe(join(dir, 'match-panel.html'));
    expect(readFileSync(join(dir, 'match-panel.html'), 'utf8')).toContain('<body class="vr">');

    // said before the page is ready: held
    host.setPanelState({ playerUp: null, myTurn: false, ball: null, ballsPerGame: 3, players: [], phase: 'idle', result: null, message: null, mic: 'open' });
    net.deliver('krobs', { kind: 'offer', sdp: 'v=0 krobs' });
    expect(w.webContents.sent).toEqual([]);
    fromPage(w, PANEL_CHANNELS.ready);
    expect(w.webContents.sent.map(([c]) => c)).toEqual([PANEL_CHANNELS.attach, PANEL_CHANNELS.state, PANEL_CHANNELS.signal]);
    expect(w.webContents.sent[0]?.[1]).toEqual({
      localId: 'owner',
      peers: ['krobs'],
      ice: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }],
      capture: CAPTURE,
      micDeviceId: 'headset',
      muted: false,
      sending: false,
    });
    expect(w.webContents.sent[2]?.[1]).toEqual({ from: 'krobs', signal: { kind: 'offer', sdp: 'v=0 krobs' } });

    // page -> controller; a frame from another webContents is ignored; a malformed one too
    fromPage(w, PANEL_CHANNELS.send, { to: 'krobs', signal: { kind: 'answer', sdp: 'v=0 owner' } });
    fake.ipc.get(PANEL_CHANNELS.send)?.({ sender: {} }, { to: 'krobs', signal: { kind: 'answer', sdp: 'x' } });
    fromPage(w, PANEL_CHANNELS.send, { to: 'krobs', signal: { kind: 'bogus' } });
    expect(net.sent).toEqual([['krobs', { kind: 'answer', sdp: 'v=0 owner' }]]);

    // status: from the page, with main's capture label
    fromPage(w, PANEL_CHANNELS.status, { sending: false, peers: { krobs: { ice: 'connected', receivingVideo: false, receivingAudio: true } }, mic: 'open', capturing: true, error: null });
    expect(host.status()).toMatchObject({ attached: true, mic: 'open', captureSource: LABEL, lastError: null, peers: { krobs: { ice: 'connected' } } });
    expect(statuses.length).toBeGreaterThan(0);

    // frames: paint -> PanelFrame
    const frames: PanelFrame[] = [];
    host.frames()?.onFrame((f) => frames.push(f));
    const bgra = Buffer.alloc(960 * 640 * 4, 1);
    w.webContents.handlers.get('paint')?.({}, {}, { toBitmap: () => bgra, getSize: () => ({ width: 960, height: 640 }) });
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ width: 960, height: 640 });
    host.showPanel();
    expect(w.shown).toBe(0); // VR: the overlay helper shows it

    // controller -> page after ready: straight through
    host.setSending(true);
    host.setMuted(true);
    host.addPeer('third');
    host.addPeer('owner'); // never to oneself
    host.removePeer('third');
    expect(w.webContents.sent.slice(3).map(([c, p]) => [c, p])).toEqual([
      [PANEL_CHANNELS.sending, true],
      [PANEL_CHANNELS.muted, true],
      [PANEL_CHANNELS.addPeer, 'third'],
      [PANEL_CHANNELS.removePeer, 'third'],
    ]);
    expect(host.status().sending).toBe(true);

    // microphones from the page; a switch reaches the page and the settings
    fromPage(w, PANEL_CHANNELS.devices, [{ deviceId: 'headset', label: 'Index HMD' }, { nope: 1 }]);
    expect(host.microphones()).toEqual([{ deviceId: 'headset', label: 'Index HMD' }]);
    host.setMicrophone('desk');
    expect(w.webContents.sent.at(-1)).toEqual([PANEL_CHANNELS.microphone, 'desk']);

    // detach: unsubscribed, window gone, status reset
    await host.detach();
    expect(net.listeners.size).toBe(0);
    expect(w.destroyed).toBe(true);
    expect(w.webContents.sent.at(-1)?.[0]).toBe(PANEL_CHANNELS.detach);
    expect(host.status()).toMatchObject({ attached: false, sending: false, captureSource: null });
    expect(host.frames()).toBeNull();
    windows = [];
  });

  it('desktop: always-on-top window shown without focus, closing hides it; no VPX window yet → lastError, found again at my turn', async () => {
    let windows: VpxWindow[] = [EDITOR];
    const host = createRtcHost({ userData: dir, log, probe: async () => ({ outputs: [], windows }), settings: store() });
    const net = signalling('krobs');
    await host.attach(net.sig, ['owner']);
    const w = fake.FakeWindow.all[0]!;
    expect(w.opts).toMatchObject({ show: false, width: 480, height: 720, alwaysOnTop: true, webPreferences: { offscreen: false } });
    // D2.5: the match video films the screen; the panel over the player window must not be in it.
    expect(w.contentProtected).toBe(true);
    expect(host.frames()).toBeNull();
    host.showPanel();
    expect(w.shown).toBe(1);
    let prevented = false;
    w.handlers.get('close')?.({ preventDefault: () => (prevented = true) });
    expect(prevented).toBe(true);
    expect(w.hidden).toBe(1);

    expect(host.status().lastError).toBe('no "Visual Pinball Player" window to send: start the table');
    fromPage(w, PANEL_CHANNELS.ready);
    expect(w.webContents.sent[0]?.[1]).toMatchObject({ capture: null });

    windows = [EDITOR, PLAYER];
    host.setSending(true);
    await settle();
    expect(w.webContents.sent.slice(1)).toEqual([
      [PANEL_CHANNELS.sending, true],
      [PANEL_CHANNELS.capture, CAPTURE],
    ]);
    expect(host.status().lastError).toBeNull();
    // the getDisplayMedia fallback is answered with the same screen
    let answered: unknown = null;
    fake.ses.displayHandler?.({}, (s) => (answered = s));
    expect(answered).toEqual({ video: { id: 'screen:0:0', name: 'Screen 1', display_id: '1' } });
    let allowed: boolean | null = null;
    fake.ses.permission?.({}, 'geolocation', (ok) => (allowed = ok));
    expect(allowed).toBe(false);
    await host.detach();
  });

  it('a probe that fails or a window the capturer does not offer leaves the match running with lastError; attach never throws', async () => {
    const host = createRtcHost({
      userData: dir,
      log,
      probe: async () => {
        throw new Error('powershell missing');
      },
      settings: store(),
    });
    await host.setVr(VR_STEAM);
    await expect(host.attach(signalling('owner').sig, ['krobs'])).resolves.toBeUndefined();
    expect(host.status()).toMatchObject({ attached: true, lastError: 'the VPX window could not be found (powershell missing)' });
    await host.detach();

    fake.sources.list = [];
    const host2 = createRtcHost({ userData: dir, log, probe: async () => ({ outputs: [], windows: [PLAYER] }), settings: store() });
    await host2.setVr(VR_STEAM);
    await host2.attach(signalling('owner').sig, ['krobs']);
    expect(host2.status().lastError).toBe('screen 1, which shows "Visual Pinball Player", is not offered for capture');
    // a second attach replaces the first window
    await host2.attach(signalling('owner').sig, ['krobs']);
    expect(fake.FakeWindow.all.filter((x) => !x.destroyed)).toHaveLength(1);
    await host2.detach();
    expect(logs.some((l) => l.includes('v=0'))).toBe(false); // SDP never logged
  });
  it('A6 (2026-10-31): a late VR decision moves the desktop panel offscreen with the peers, panel state, sending, mic and mute; frames() then has a source', async () => {
    const host = createRtcHost({ userData: dir, log, probe: async () => ({ outputs: [], windows: [PLAYER] }), settings: store({ micDeviceId: 'headset', muted: true }) });
    const net = signalling('owner');
    await host.attach(net.sig, ['krobs']);
    const desk = fake.FakeWindow.all[0]!;
    expect(desk.opts).toMatchObject({ alwaysOnTop: true, webPreferences: { offscreen: false } });
    expect(host.frames()).toBeNull();
    fromPage(desk, PANEL_CHANNELS.ready);
    const state = { playerUp: 'owner', myTurn: true, ball: 2, ballsPerGame: 3, players: [], phase: 'playing' as const, result: null, message: null, mic: 'muted' as const };
    host.setPanelState(state);
    host.addPeer('third');
    host.removePeer('krobs');
    host.addPeer('fourth');
    host.setSending(true);

    await host.setVr(VR_STEAM);
    expect(desk.destroyed).toBe(true);
    const vrWin = fake.FakeWindow.all[1]!;
    expect(vrWin.opts).toMatchObject({ show: false, width: 960, height: 640, webPreferences: { offscreen: true } });
    expect(readFileSync(join(dir, 'match-panel.html'), 'utf8')).toContain('<body class="vr">');
    expect(host.frames()).not.toBeNull();
    host.showPanel();
    expect(vrWin.shown).toBe(0); // the overlay helper shows it
    // Still attached the whole time: the controller never saw a detach.
    expect(host.status()).toMatchObject({ attached: true, sending: true });
    expect(logs.filter((l) => l === 'media: detached')).toEqual([]);

    // The new page gets the current peers, sending and the saved mic / mute, then the last panel state.
    fromPage(vrWin, PANEL_CHANNELS.ready);
    expect(vrWin.webContents.sent[0]).toEqual([
      PANEL_CHANNELS.attach,
      expect.objectContaining({ localId: 'owner', peers: ['third', 'fourth'], micDeviceId: 'headset', muted: true, sending: true }),
    ]);
    expect(vrWin.webContents.sent.slice(1)).toEqual([[PANEL_CHANNELS.state, state]]);
    // Signals still reach the (new) page; frames reach the overlay.
    net.deliver('third', { kind: 'offer', sdp: 'v=0 third' });
    expect(vrWin.webContents.sent.at(-1)).toEqual([PANEL_CHANNELS.signal, { from: 'third', signal: { kind: 'offer', sdp: 'v=0 third' } }]);
    const frames: PanelFrame[] = [];
    host.frames()?.onFrame((f) => frames.push(f));
    vrWin.webContents.handlers.get('paint')?.({}, {}, { toBitmap: () => Buffer.alloc(960 * 640 * 4), getSize: () => ({ width: 960, height: 640 }) });
    expect(frames).toHaveLength(1);

    // VR -> desktop while attached is not supported: logged, the headset panel stays.
    await host.setVr({ inVr: false, headsetPanel: false });
    expect(fake.FakeWindow.all).toHaveLength(2);
    expect(host.frames()).not.toBeNull();
    expect(logs).toContain('media: the rig reads the monitor now; the panel stays in the headset until the match ends');

    // detach closes whichever window exists; the next attach opens the kind decided last (the monitor).
    await host.detach();
    expect(vrWin.destroyed).toBe(true);
    expect(host.frames()).toBeNull();
    await host.attach(net.sig, ['krobs']);
    expect(fake.FakeWindow.all[2]?.opts).toMatchObject({ alwaysOnTop: true });
    await host.detach();
  });

  it('B22 (2026-10-31): in VR off SteamVR a visible desktop panel and no frames, while the capture still picks as in VR', async () => {
    const preview = win('VR Preview', 1280, 720);
    const host = createRtcHost({ userData: dir, log, probe: async () => ({ outputs: [], windows: [EDITOR, DMD, preview] }), settings: store() });
    await host.setVr({ inVr: true, headsetPanel: false });
    await host.attach(signalling('owner').sig, ['krobs']);
    const w = fake.FakeWindow.all[0]!;
    expect(w.opts).toMatchObject({ width: 480, height: 720, alwaysOnTop: true, webPreferences: { offscreen: false } });
    expect(readFileSync(join(dir, 'match-panel.html'), 'utf8')).toContain('<body class="desktop">');
    expect(host.frames()).toBeNull();
    host.showPanel();
    expect(w.shown).toBe(1);
    // No "Visual Pinball Player" window: the desktop rule would send nothing; in VR the largest VPX window goes.
    expect(host.status().lastError).toBeNull();
    fromPage(w, PANEL_CHANNELS.ready);
    expect(w.webContents.sent[0]?.[1]).toMatchObject({ capture: { sourceId: 'screen:0:0', label: 'screen 1, crop 1280x720 of VR Preview (the largest VPX window, none is titled "Visual Pinball Player")' } });
    expect(logs.some((l) => l.startsWith('media: attach (VR, desktop panel)'))).toBe(true);
    await host.detach();
  });

  it('D2 (2026-10-31): no window at attach → a look every 3 s until found; the capture goes to the page before the turn, once; again after it ends', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let windows: VpxWindow[] = [EDITOR];
      let probes = 0;
      const probe = async (): Promise<WindowProbe> => {
        probes++;
        return { outputs: [], windows };
      };
      const host = createRtcHost({ userData: dir, log, probe, settings: store() });
      await host.attach(signalling('owner').sig, []);
      const w = fake.FakeWindow.all[0]!;
      fromPage(w, PANEL_CHANNELS.ready);
      expect(w.webContents.sent).toEqual([[PANEL_CHANNELS.attach, expect.objectContaining({ capture: null, sending: false })]]);
      expect(probes).toBe(1);

      vi.advanceTimersByTime(2_999);
      await settle();
      expect(probes).toBe(1);
      vi.advanceTimersByTime(1);
      await settle();
      expect(probes).toBe(2);
      // The reason is said once, not at every look.
      expect(logs.filter((l) => l.includes('no "Visual Pinball Player" window to send'))).toHaveLength(1);

      // The table starts in the lobby: the next look finds it and the page gets it at once, still not sending.
      windows = [EDITOR, PLAYER];
      vi.advanceTimersByTime(3_000);
      await settle();
      expect(probes).toBe(3);
      expect(w.webContents.sent.slice(1)).toEqual([[PANEL_CHANNELS.capture, CAPTURE]]);
      expect(logs.filter((l) => l.startsWith('media: capture '))).toEqual([`media: capture ${LABEL} ready`]);
      expect(host.status()).toMatchObject({ sending: false, lastError: null });

      // Found: no more 3 s looks, only the 5 s re-probe (D2.5), which says nothing while the window stays put.
      vi.advanceTimersByTime(4_999);
      await settle();
      expect(probes).toBe(3);
      vi.advanceTimersByTime(1);
      await settle();
      expect(probes).toBe(4);
      expect(w.webContents.sent).toHaveLength(2);
      // The turn only flips the flag.
      host.setSending(true);
      await settle();
      expect(w.webContents.sent.slice(2)).toEqual([[PANEL_CHANNELS.sending, true]]);
      expect(probes).toBe(4);

      // The page's capture ends (VPX restarted): looking again, and the new window is announced.
      const st = (capturing: boolean): PanelPageStatus => ({ sending: true, peers: {}, mic: 'open', capturing, error: null });
      fromPage(w, PANEL_CHANNELS.status, st(true));
      fromPage(w, PANEL_CHANNELS.status, st(false));
      expect(logs).toContain(`media: the capture of ${LABEL} ended; looking for the VPX window again`);
      fake.sources.list = [{ id: 'screen:7:0', name: 'Screen 1', display_id: '1' }];
      vi.advanceTimersByTime(3_000);
      await settle();
      expect(probes).toBe(5);
      expect(w.webContents.sent.at(-1)).toEqual([PANEL_CHANNELS.capture, { ...CAPTURE, sourceId: 'screen:7:0' }]);

      // Detached: no looks.
      fromPage(w, PANEL_CHANNELS.status, st(true));
      fromPage(w, PANEL_CHANNELS.status, st(false));
      await host.detach();
      vi.advanceTimersByTime(10_000);
      await settle();
      expect(probes).toBe(5);

      // Found before the page is ready: it rides in `attach` itself, no separate capture message.
      windows = [EDITOR];
      probes = 0;
      await host.attach(signalling('owner').sig, []);
      const w2 = fake.FakeWindow.all.at(-1)!;
      windows = [PLAYER];
      vi.advanceTimersByTime(3_000);
      await settle();
      fromPage(w2, PANEL_CHANNELS.ready);
      expect(w2.webContents.sent).toEqual([[PANEL_CHANNELS.attach, expect.objectContaining({ capture: { ...CAPTURE, sourceId: 'screen:7:0' } })]]);
      await host.detach();
    } finally {
      vi.useRealTimers();
    }
  });

  it('D2 (2026-10-31): in VR with only the editor and a DMD on the desktop, nothing is sent and the Match tab says to turn VRPreview on', async () => {
    const host = createRtcHost({ userData: dir, log, probe: async () => ({ outputs: [], windows: [EDITOR, win('FlexDMD', 1280, 720)] }), settings: store() });
    await host.setVr({ inVr: true, headsetPanel: false });
    await host.attach(signalling('krobs').sig, ['owner']);
    expect(host.status().lastError).toBe(NO_PLAYFIELD_TO_SEND);
    fromPage(fake.FakeWindow.all[0]!, PANEL_CHANNELS.ready);
    expect(fake.FakeWindow.all[0]!.webContents.sent[0]?.[1]).toMatchObject({ capture: null });
    expect(logs).toContain(`WARN media: ${NO_PLAYFIELD_TO_SEND}`);
    await host.detach();
  });

  it('B22 (2026-10-31): the microphones before a match, from a hidden page in the panel partition; one listing at a time; none while attached', async () => {
    const host = createRtcHost({ userData: dir, log, probe: async () => ({ outputs: [], windows: [PLAYER] }), settings: store() });
    const seen: number[] = [];
    host.onMicrophones((m) => seen.push(m.length));
    const p = host.refreshMicrophones();
    expect(host.refreshMicrophones()).toBe(p);
    await settle();
    expect(fake.FakeWindow.all).toHaveLength(1);
    const w = fake.FakeWindow.all[0]!;
    expect(w.opts).toMatchObject({ show: false, webPreferences: { partition: 'castcade-panel', nodeIntegration: true } });
    expect(w.loaded).toBe(join(dir, 'match-mics.html'));
    const page = readFileSync(join(dir, 'match-mics.html'), 'utf8');
    expect(page).toContain(MIC_LIST_CHANNEL);
    expect(page).toContain('t.stop()');
    // Another webContents is not the listing page.
    fake.ipc.get(MIC_LIST_CHANNEL)?.({ sender: {} }, { mics: [{ deviceId: 'x', label: 'X' }], error: null });
    fromPage(w, MIC_LIST_CHANNEL, { mics: [{ deviceId: 'headset-1', label: 'Headset' }, { nope: 1 }], error: null });
    await p;
    expect(host.microphones()).toEqual([{ deviceId: 'headset-1', label: 'Headset' }]);
    expect(seen).toEqual([1]);
    expect(w.destroyed).toBe(true);
    expect(logs).toContain('media: 1 microphone(s) listed before the match');

    // A failure keeps the last list and says why.
    const p2 = host.refreshMicrophones();
    await settle();
    fromPage(fake.FakeWindow.all[1]!, MIC_LIST_CHANNEL, { mics: null, error: 'NotAllowedError' });
    await p2;
    expect(host.microphones()).toHaveLength(1);
    expect(logs).toContain('WARN media: could not list the microphones before the match (NotAllowedError)');

    // Attached: the panel page lists them; no hidden page.
    await host.attach(signalling('owner').sig, []);
    const before = fake.FakeWindow.all.length;
    await host.refreshMicrophones();
    expect(fake.FakeWindow.all).toHaveLength(before);
    await host.detach();
  });

  it('D2.5: while the capture is live the window is re-probed every 5 s: moved → a new crop once; probe failure → kept; gone → stopped, looked for again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let windows: VpxWindow[] = [PLAYER];
      let fail = false;
      const probe = async (): Promise<WindowProbe> => {
        if (fail) throw new Error('probe timed out');
        return { outputs: [], windows };
      };
      const host = createRtcHost({ userData: dir, log, probe, settings: store() });
      await host.attach(signalling('owner').sig, []);
      const w = fake.FakeWindow.all[0]!;
      fromPage(w, PANEL_CHANNELS.ready);
      expect(w.webContents.sent).toEqual([[PANEL_CHANNELS.attach, expect.objectContaining({ capture: CAPTURE })]]);

      // Moved and resized: the page gets the same screen with the new crop, logged once.
      windows = [{ ...PLAYER, client: { left: 100, top: 50, width: 1600, height: 900 } }];
      vi.advanceTimersByTime(5_000);
      await settle();
      const moved = { ...CAPTURE, label: 'screen 1, crop 1600x900 of Visual Pinball Player', crop: { x: 100, y: 50, width: 1600, height: 900 }, out: { width: 1280, height: 720 } };
      expect(w.webContents.sent.slice(1)).toEqual([[PANEL_CHANNELS.capture, moved]]);
      vi.advanceTimersByTime(5_000);
      await settle();
      expect(w.webContents.sent).toHaveLength(2);
      expect(logs.filter((l) => l.startsWith('media: the VPX window moved'))).toEqual(['media: the VPX window moved or resized: screen 1, crop 1600x900 of Visual Pinball Player at 100,50']);
      expect(host.status()).toMatchObject({ lastError: null });

      // A probe that fails says nothing about the window: the capture stays.
      fail = true;
      vi.advanceTimersByTime(5_000);
      await settle();
      expect(w.webContents.sent).toHaveLength(2);
      fail = false;

      // The table closed: the page stops the capture, the Match tab says why, the 3 s looks find the next window.
      windows = [EDITOR];
      vi.advanceTimersByTime(5_000);
      await settle();
      expect(w.webContents.sent.at(-1)).toEqual([PANEL_CHANNELS.capture, null]);
      expect(host.status().lastError).toBe('no "Visual Pinball Player" window to send: start the table');
      windows = [PLAYER];
      vi.advanceTimersByTime(3_000);
      await settle();
      expect(w.webContents.sent.at(-1)).toEqual([PANEL_CHANNELS.capture, CAPTURE]);
      expect(host.status().lastError).toBeNull();
      await host.detach();
    } finally {
      vi.useRealTimers();
    }
  });

  it('D2.5: the focus is watched while the capture is live; VPX losing it covers the video at once, back in front uncovers after 750 ms', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let windows: VpxWindow[] = [EDITOR];
      const watch = { started: 0, stopped: 0, change: (_c: { pid: number; exe: string }) => {}, end: (_why: string) => {} };
      const watchFocus = (onChange: (c: { pid: number; exe: string }) => void, onEnd: (why: string) => void) => {
        watch.started++;
        watch.change = onChange;
        watch.end = onEnd;
        return { stop: () => void watch.stopped++ };
      };
      const host = createRtcHost({ userData: dir, log, probe: async () => ({ outputs: [], windows }), settings: store(), watchFocus });
      await host.attach(signalling('owner').sig, []);
      const w = fake.FakeWindow.all[0]!;
      fromPage(w, PANEL_CHANNELS.ready);
      // No capture, no watch.
      expect(watch.started).toBe(0);
      windows = [PLAYER];
      vi.advanceTimersByTime(3_000);
      await settle();
      expect(watch.started).toBe(1);
      const covers = (): unknown[] => w.webContents.sent.filter(([c]) => c === PANEL_CHANNELS.cover).map(([, p]) => p);

      watch.change({ pid: 9, exe: 'explorer' });
      expect(covers()).toEqual([true]);
      expect(logs).toContain('media: match video covered (explorer in front)');
      watch.change({ pid: 7, exe: 'VPinballX64' });
      vi.advanceTimersByTime(749);
      expect(covers()).toEqual([true]);
      vi.advanceTimersByTime(1);
      expect(covers()).toEqual([true, false]);
      watch.change({ pid: 7, exe: 'VPinballX64' });
      expect(covers()).toEqual([true, false]);

      // The watcher died: focus unknown, never covered.
      watch.change({ pid: 9, exe: 'electron' });
      watch.end('exit 1');
      expect(covers()).toEqual([true, false, true, false]);
      expect(logs).toContain('WARN media: the focus watch stopped (exit 1); the match video is not covered when VPX loses focus');

      await host.detach();
      // It died on its own: nothing left to stop. A new capture starts a new watch, and detach stops it.
      expect(watch.stopped).toBe(0);
      await host.attach(signalling('owner').sig, []);
      expect(watch.started).toBe(2);
      await host.detach();
      expect(watch.stopped).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
