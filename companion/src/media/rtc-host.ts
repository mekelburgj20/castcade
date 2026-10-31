/**
 * D2 (alpha-match.md §4, 2026-10-30): `MatchMedia` in the main process. One window holds the panel page
 * (`panel-page.ts`: the WebRTC mesh and the panel UI). In VR it is offscreen: never shown, painted at 20 fps, and every
 * paint becomes a `PanelFrame` for the OpenVR overlay helper (D7). On the desktop it is a normal always-on-top window
 * the controller shows with `showPanel()`. The page talks to main over the `castcade-panel:*` channels; this file
 * bridges them to the controller's `MediaSignalling` and keeps `MediaStatus`.
 *
 * Capture: a `desktopCapturer` window source id handed to the page (the stream-host audio page's pattern, with its own
 * session partition; `setDisplayMediaRequestHandler` answers the page's getDisplayMedia fallback with the same window,
 * no picker). Nothing here throws out of `attach`: a missing window or microphone leaves the match running without
 * that medium and says so in `lastError`.
 */
import { BrowserWindow, desktopCapturer, ipcMain, session, type DesktopCapturerSource, type IpcMainEvent, type NativeImage, type Session } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../main/log.js';
import type { MatchMedia, MatchPlayerId, MediaSignal, MediaSignalling, MediaStatus, PanelFrame, PanelFrameSource, PanelState } from './match-media-types.js';
import { describeIce, iceServers, type MediaSettingsStore } from './media-settings.js';
import { PANEL_CHANNELS, panelPageHtml, type MicDevice, type PanelAttach, type PanelCapture, type PanelPageStatus } from './panel-page.js';
import { pickPlayfield, type VpxWindow, type WindowProbe } from './window-geometry.js';

export interface RtcHostOptions {
  userData: string;
  log: Pick<Logger, 'info' | 'warn'>;
  probe: () => Promise<WindowProbe>;
  settings: MediaSettingsStore;
}

/** `MatchMedia` plus the microphone picker the Match tab needs (the panel page lists the devices). */
export interface RtcHost extends MatchMedia {
  microphones(): MicDevice[];
  onMicrophones(cb: (mics: MicDevice[]) => void): () => void;
  /** Saves the choice and, while attached, switches the live microphone (no renegotiation: the sender is kept). */
  setMicrophone(deviceId: string | null): void;
  /**
   * A6 (2026-10-31): the rig the match host decided (VR: an offscreen panel for the overlay helper; else a desktop
   * window). Before `attach` it sets the next panel's kind. While attached on the desktop, `true` moves the panel
   * offscreen: a new window, re-attached with the current peers, panel state, sending flag, microphone and mute
   * (the peers renegotiate through the page's offer resend), so `frames()` has a source for the overlay once it
   * resolves. VR → desktop while attached is not supported: logged and ignored until the match ends.
   */
  setVr(on: boolean): Promise<void>;
}

const PARTITION = 'castcade-panel';
const PAGE_FILE = 'match-panel.html';
/** The headset panel: 3:2, wide enough for a 16:9 picture plus the header and strip at 0.55 m (alpha-match.md §5). */
export const VR_PANEL_SIZE = { width: 960, height: 640 } as const;
export const DESKTOP_PANEL_SIZE = { width: 480, height: 720 } as const;
export const PANEL_FPS = 20;
const READY_TIMEOUT_MS = 15_000;
const PLAYER_TITLE = 'Visual Pinball Player';

// ---- pure parts ----

export interface CapturePick {
  window: VpxWindow;
  /** True when no window is titled "Visual Pinball Player" and the largest other VPX window was taken (VR only). */
  fallback: boolean;
}

/** VPX's editor: "Visual Pinball" or "Visual Pinball - [table]" (process-watch.ts title parsing). */
const EDITOR_TITLE = /^visual pinball(\s*-\s*\[.*\])?\s*\*?$/i;

/**
 * The window to send. In VPX 10.8 VR with `VRPreview` on, the preview IS the "Visual Pinball Player" window: the D1
 * rig runs 2–5 (2026-10-25, solo-streaming-and-recording.md) captured exactly that window in VR and got the eye image;
 * with `VRPreview = 0` the same window is a black 640x480. So both modes take `pickPlayfield`. In VR only, when no
 * window has that title (another VR build may name it differently), the largest VPX window that is not the editor is
 * taken and flagged; on the desktop the editor-only case sends nothing (rig run 2 filmed the editor that way).
 */
export function pickCaptureWindow(windows: VpxWindow[], vr: boolean): CapturePick | null {
  const player = pickPlayfield(windows);
  if (player) return { window: player, fallback: false };
  if (!vr) return null;
  const others = windows.filter((w) => !EDITOR_TITLE.test(w.title.trim()));
  const largest = [...others].sort((a, b) => b.client.width * b.client.height - a.client.width * a.client.height)[0];
  return largest ? { window: largest, fallback: true } : null;
}

/** `MediaStatus.captureSource`: the window title and its size (the runbook wants the VR preview at 1280x720). */
export function captureLabel(p: CapturePick): string {
  const size = `${p.window.client.width}x${p.window.client.height}`;
  if (!p.fallback) return `${p.window.title} (${size})`;
  return `${p.window.title || 'untitled VPX window'} (${size}; the largest VPX window, none is titled "${PLAYER_TITLE}")`;
}

/** The capturer's source for a window title: exact first, then ignoring case and surrounding space. */
export function matchSource<S extends { id: string; name: string }>(sources: S[], title: string): S | null {
  const want = title.trim().toLowerCase();
  return sources.find((s) => s.name === title) ?? sources.find((s) => s.name.trim().toLowerCase() === want) ?? null;
}

/**
 * An offscreen paint as a `PanelFrame`. `getSize()` is in DIPs; on a scaled display the bitmap can be larger by the
 * scale factor, so the size is taken from the byte count when the two disagree. Null when they cannot be reconciled.
 */
export function frameFromBitmap(bgra: Uint8Array, size: { width: number; height: number }): PanelFrame | null {
  const { width, height } = size;
  if (width <= 0 || height <= 0 || bgra.length === 0 || bgra.length % 4 !== 0) return null;
  if (bgra.length === width * height * 4) return { width, height, bgra };
  const scale = Math.sqrt(bgra.length / 4 / (width * height));
  const w = Math.round(width * scale);
  const h = Math.round(height * scale);
  return w * h * 4 === bgra.length ? { width: w, height: h, bgra } : null;
}

/**
 * Fan-out of panel frames. A listener that returns a promise is busy until it settles and misses the frames painted
 * meanwhile (the overlay pipe is the slow side); `wanted()` lets the paint handler skip the bitmap copy when nobody
 * would take it.
 */
export function createFrameHub(): { source: PanelFrameSource; wanted(): boolean; push(frame: PanelFrame): void } {
  const listeners = new Map<(f: PanelFrame) => void, { busy: boolean }>();
  return {
    source: {
      onFrame(cb) {
        listeners.set(cb, { busy: false });
        return () => {
          listeners.delete(cb);
        };
      },
    },
    wanted: () => [...listeners.values()].some((l) => !l.busy),
    push(frame) {
      for (const [cb, st] of listeners) {
        if (st.busy) continue;
        let r: unknown;
        try {
          r = (cb as (f: PanelFrame) => unknown)(frame);
        } catch {
          continue;
        }
        if (r && typeof (r as { then?: unknown }).then === 'function') {
          st.busy = true;
          void (r as Promise<unknown>).then(
            () => (st.busy = false),
            () => (st.busy = false),
          );
        }
      }
    },
  };
}

/** The controller's view: the page's report plus what only main knows. Main's own error wins (it is the cause). */
export function mergeStatus(page: PanelPageStatus | null, main: { attached: boolean; sending: boolean; captureLabel: string | null; error: string | null }): MediaStatus {
  return {
    attached: main.attached,
    sending: main.attached && main.sending,
    peers: main.attached && page ? page.peers : {},
    mic: main.attached && page ? page.mic : 'unavailable',
    captureSource: main.attached && page?.capturing ? main.captureLabel : null,
    lastError: main.error ?? (main.attached ? (page?.error ?? null) : null),
  };
}

function isSignal(v: unknown): v is { to: MatchPlayerId; signal: MediaSignal } {
  if (typeof v !== 'object' || v === null) return false;
  const m = v as { to?: unknown; signal?: { kind?: unknown } };
  return typeof m.to === 'string' && typeof m.signal === 'object' && m.signal !== null && (m.signal.kind === 'offer' || m.signal.kind === 'answer' || m.signal.kind === 'ice');
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// ---- the Electron side ----

export function createRtcHost(opts: RtcHostOptions): RtcHost {
  const { log } = opts;
  let win: BrowserWindow | null = null;
  /** The panel kind the match host decided (`setVr`): the next attach opens this. */
  let wantVr = false;
  /** The kind of the panel window open now. */
  let vr = false;
  let ready = false;
  let attached = false;
  let attachMsg: PanelAttach | null = null;
  let attachSent = false;
  let queue: Array<[string, unknown]> = [];
  let signalling: MediaSignalling | null = null;
  let offSignal: (() => void) | null = null;
  let sending = false;
  /** The peers the page holds (attach's list, then addPeer / removePeer), and the last panel state: a re-attach replays both. */
  const peers = new Set<MatchPlayerId>();
  let lastState: PanelState | null = null;
  let capture: PanelCapture | null = null;
  let captureSrc: DesktopCapturerSource | null = null;
  /** The panel window itself failed (it did not open, load or start, or its renderer died). */
  let panelError: string | null = null;
  /** No window to send, or the capturer does not offer it; cleared by a later pick that finds one. */
  let captureError: string | null = null;
  let page: PanelPageStatus | null = null;
  let mics: MicDevice[] = [];
  let generation = 0;
  let picking: { gen: number; done: Promise<void> } | null = null;
  let readyTimer: ReturnType<typeof setTimeout> | null = null;
  const statusListeners = new Set<(s: MediaStatus) => void>();
  const micListeners = new Set<(m: MicDevice[]) => void>();
  const hub = createFrameHub();

  const status = (): MediaStatus => mergeStatus(page, { attached, sending, captureLabel: capture?.label ?? null, error: panelError ?? captureError });
  const emitStatus = (): void => {
    const s = status();
    for (const l of statusListeners) l(s);
  };
  const setPanelError = (msg: string): void => {
    log.warn(`media: ${msg}`);
    panelError = msg;
    emitStatus();
  };
  const setCaptureError = (msg: string): void => {
    log.warn(`media: ${msg}`);
    captureError = msg;
    emitStatus();
  };

  // ---- page channels ----
  const fromPanel = (e: IpcMainEvent): boolean => !!win && !win.isDestroyed() && e.sender === win.webContents;
  const post = (channel: string, payload?: unknown): void => {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };
  /** Latest-wins channels: an older queued value is useless once a newer one is queued. */
  const LATEST = new Set<string>([PANEL_CHANNELS.state, PANEL_CHANNELS.sending, PANEL_CHANNELS.muted, PANEL_CHANNELS.capture, PANEL_CHANNELS.microphone]);
  const toPage = (channel: string, payload?: unknown): void => {
    if (win && ready && attachSent) return post(channel, payload);
    if (LATEST.has(channel)) queue = queue.filter(([c]) => c !== channel);
    queue.push([channel, payload]);
  };
  /** The page gets `attach` first, then everything said before it was ready, in order. */
  const flush = (): void => {
    if (!win || !ready || !attachMsg) return;
    if (!attachSent) {
      post(PANEL_CHANNELS.attach, attachMsg);
      attachSent = true;
    }
    const q = queue;
    queue = [];
    for (const [c, p] of q) post(c, p);
  };

  ipcMain.on(PANEL_CHANNELS.ready, (e) => {
    if (!fromPanel(e)) return;
    ready = true;
    if (readyTimer) clearTimeout(readyTimer);
    readyTimer = null;
    flush();
  });
  ipcMain.on(PANEL_CHANNELS.send, (e, m: unknown) => {
    if (!fromPanel(e) || !signalling || !isSignal(m)) return;
    // Never logged (SDP and candidates carry addresses); the engine validates the shape.
    signalling.send(m.to, m.signal);
  });
  ipcMain.on(PANEL_CHANNELS.status, (e, s: PanelPageStatus) => {
    if (!fromPanel(e)) return;
    if (page?.error !== s.error && s.error) log.warn(`media: panel: ${s.error}`);
    page = s;
    emitStatus();
  });
  ipcMain.on(PANEL_CHANNELS.devices, (e, d: unknown) => {
    if (!fromPanel(e) || !Array.isArray(d)) return;
    mics = d.filter((x): x is MicDevice => typeof x === 'object' && x !== null && typeof (x as MicDevice).deviceId === 'string' && typeof (x as MicDevice).label === 'string');
    for (const l of micListeners) l(mics);
  });

  // ---- session: media permission only, and the getDisplayMedia fallback answered with the chosen window ----
  let sessionReady = false;
  const panelSession = (): Session => {
    const ses = session.fromPartition(PARTITION);
    if (!sessionReady) {
      sessionReady = true;
      ses.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'media'));
      ses.setPermissionCheckHandler((_wc, permission) => permission === 'media');
      ses.setDisplayMediaRequestHandler((_req, cb) => {
        if (captureSrc) cb({ video: captureSrc });
        else cb({});
      });
    }
    return ses;
  };

  const createWindow = (inVr: boolean): BrowserWindow => {
    panelSession();
    const webPreferences = {
      partition: PARTITION,
      // Local content only (a page written here); node for ipcRenderer, as the stream-host audio page.
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required' as const,
      offscreen: inVr,
    };
    const w = inVr
      ? new BrowserWindow({ show: false, frame: false, useContentSize: true, ...VR_PANEL_SIZE, webPreferences })
      : new BrowserWindow({
          show: false,
          useContentSize: true,
          ...DESKTOP_PANEL_SIZE,
          alwaysOnTop: true,
          autoHideMenuBar: true,
          title: 'Castcade match',
          backgroundColor: '#000000',
          webPreferences,
        });
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    w.webContents.on('will-navigate', (e) => e.preventDefault());
    w.webContents.on('render-process-gone', (_e, d) => {
      if (win === w) setPanelError(`the match panel stopped (${d.reason}); video and voice are off`);
    });
    if (inVr) {
      w.webContents.setFrameRate(PANEL_FPS);
      w.webContents.on('paint', (_e, _dirty, image: NativeImage) => {
        if (!hub.wanted()) return;
        const f = frameFromBitmap(image.toBitmap(), image.getSize());
        if (f) hub.push(f);
      });
    } else {
      // The page holds the connections: closing the window hides it; the match ends them with detach().
      w.on('close', (e) => {
        e.preventDefault();
        w.hide();
      });
    }
    return w;
  };

  /** Finds the window to send and its capturer source; never throws. A newer attach or detach discards the result. */
  const pickCapture = (gen: number): Promise<void> => {
    if (picking?.gen === gen) return picking.done;
    const done = (async () => {
      try {
        const probe = await opts.probe();
        const pick = pickCaptureWindow(probe.windows, vr);
        if (gen !== generation) return;
        if (!pick) {
          setCaptureError(vr ? 'no VPX window to send: open the table in VR with VRPreview on' : `no "${PLAYER_TITLE}" window to send: start the table`);
          return;
        }
        const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } });
        if (gen !== generation) return;
        const src = matchSource(sources, pick.window.title);
        if (!src) {
          setCaptureError(`the window "${pick.window.title}" is not offered for capture`);
          return;
        }
        captureSrc = src;
        capture = { sourceId: src.id, label: captureLabel(pick) };
        captureError = null;
        if (pick.fallback) log.warn(`media: no "${PLAYER_TITLE}" window; sending the largest VPX window instead: ${capture.label}`);
      } catch (e) {
        if (gen === generation) setCaptureError(`the VPX window could not be found (${errText(e)})`);
      } finally {
        if (picking?.gen === gen) picking = null;
      }
    })();
    picking = { gen, done };
    return done;
  };

  const detach = async (quiet = false): Promise<void> => {
    generation++;
    offSignal?.();
    offSignal = null;
    signalling = null;
    if (readyTimer) clearTimeout(readyTimer);
    readyTimer = null;
    const w = win;
    win = null;
    if (w && !w.isDestroyed()) {
      if (ready) w.webContents.send(PANEL_CHANNELS.detach);
      // destroy(), not close(): no close event (the desktop window turns close into hide), the page's connections end.
      w.destroy();
    }
    const was = attached;
    ready = false;
    attached = false;
    attachMsg = null;
    attachSent = false;
    queue = [];
    capture = null;
    captureSrc = null;
    page = null;
    sending = false;
    peers.clear();
    lastState = null;
    panelError = null;
    captureError = null;
    if (was && !quiet) log.info('media: detached');
    emitStatus();
  };

  /** `restore`: what a re-attach (`setVr`) carries over, applied before the first await so newer calls win over it. */
  const attach = async (sig: MediaSignalling, initialPeers: MatchPlayerId[], restore: { state: PanelState | null; sending: boolean } | null = null): Promise<void> => {
    if (attached || win) await detach(restore !== null);
    const gen = ++generation;
    attached = true;
    signalling = sig;
    vr = wantVr;
    for (const p of initialPeers) if (p !== sig.localId) peers.add(p);
    if (restore) {
      sending = restore.sending;
      if (restore.state) {
        lastState = restore.state;
        toPage(PANEL_CHANNELS.state, restore.state);
      }
    }
    offSignal = sig.onSignal((from, signal) => toPage(PANEL_CHANNELS.signal, { from, signal }));
    try {
      const file = join(opts.userData, PAGE_FILE);
      mkdirSync(opts.userData, { recursive: true });
      writeFileSync(file, panelPageHtml({ vr }));
      win = createWindow(vr);
      void win.loadFile(file).catch((e: unknown) => {
        if (gen === generation) setPanelError(`the match panel did not load (${errText(e)})`);
      });
      readyTimer = setTimeout(() => {
        if (gen === generation && !ready) setPanelError('the match panel did not start; video and voice are off');
      }, READY_TIMEOUT_MS);
    } catch (e) {
      setPanelError(`the match panel could not open (${errText(e)}); video and voice are off`);
      return;
    }
    await pickCapture(gen);
    if (gen !== generation) return;
    const s = opts.settings.get();
    attachMsg = { localId: sig.localId, peers: [...peers], ice: iceServers(s), capture, micDeviceId: s.micDeviceId, muted: s.muted, sending };
    log.info(`media: attach (${vr ? 'VR, offscreen panel' : 'desktop panel'}), ${attachMsg.peers.length} peer(s), ${describeIce(s)}, capture ${capture?.label ?? 'none'}`);
    flush();
    emitStatus();
  };

  const setSending = (on: boolean): void => {
    if (sending === on) return;
    sending = on;
    if (attachMsg && !attachSent) attachMsg.sending = on;
    toPage(PANEL_CHANNELS.sending, on);
    // VPX may not have been up at attach: look again when this rig's turn starts.
    if (on && attached && !capture) {
      const gen = generation;
      void pickCapture(gen).then(() => {
        if (gen !== generation || !capture) return;
        log.info(`media: capture ${capture.label}`);
        toPage(PANEL_CHANNELS.capture, capture);
        emitStatus();
      });
    }
    emitStatus();
  };

  const setPanelState = (state: PanelState): void => {
    if (!attached) return;
    lastState = state;
    toPage(PANEL_CHANNELS.state, state);
  };

  return {
    attach: (sig, initial) => attach(sig, initial),
    addPeer(peer) {
      if (!attached || !signalling || peer === signalling.localId) return;
      peers.add(peer);
      toPage(PANEL_CHANNELS.addPeer, peer);
    },
    removePeer(peer) {
      if (!attached) return;
      peers.delete(peer);
      toPage(PANEL_CHANNELS.removePeer, peer);
    },
    setSending,
    setPanelState,
    setMuted(muted) {
      opts.settings.patch({ muted });
      if (attached) toPage(PANEL_CHANNELS.muted, muted);
    },
    status,
    onStatus(cb) {
      statusListeners.add(cb);
      return () => {
        statusListeners.delete(cb);
      };
    },
    frames: () => (attached && vr ? hub.source : null),
    showPanel() {
      if (vr || !win || win.isDestroyed()) return;
      // showInactive: focus stays with VPX, whose window takes the player's keys.
      win.showInactive();
    },
    detach: () => detach(),
    async setVr(on) {
      wantVr = on;
      if (!attached || on === vr) return;
      if (!on) {
        log.info('media: the rig reads the monitor now; the panel stays in the headset until the match ends');
        return;
      }
      const sig = signalling;
      if (!sig) return;
      // The page holds the connections and the UI: a new offscreen window gets everything the old one was told
      // (the microphone and the mute come from media.json, as at any attach).
      const keep = [...peers];
      log.info(`media: moving the panel into the headset (offscreen window; ${keep.length} peer(s) reconnect)`);
      await attach(sig, keep, { state: lastState, sending });
    },
    microphones: () => mics,
    onMicrophones(cb) {
      micListeners.add(cb);
      return () => {
        micListeners.delete(cb);
      };
    },
    setMicrophone(deviceId) {
      opts.settings.patch({ micDeviceId: deviceId });
      if (attached) toPage(PANEL_CHANNELS.microphone, deviceId);
    },
  };
}
