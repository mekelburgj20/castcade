/**
 * D2 (alpha-match.md §4, 2026-10-30): `MatchMedia` in the main process. One window holds the panel page
 * (`panel-page.ts`: the WebRTC mesh and the panel UI). In VR on SteamVR it is offscreen: never shown, painted at 20 fps,
 * and every paint becomes a `PanelFrame` for the OpenVR overlay helper (D7). On the desktop, and in VR on any other
 * runtime (B22, 2026-10-31: no SteamVR compositor for the helper to draw into), it is a normal always-on-top window
 * the controller shows with `showPanel()`. The page talks to main over the `castcade-panel:*` channels; this file
 * bridges them to the controller's `MediaSignalling` and keeps `MediaStatus`.
 *
 * Capture (D2.5, 2026-10-31): the `desktopCapturer` SCREEN source of the display that holds the player window, and the
 * window's region of it (`capture-crop.ts`), handed to the page, which draws the crop onto a canvas and sends that
 * (the stream-host audio page's pattern, with its own session partition; `setDisplayMediaRequestHandler` answers the
 * page's getDisplayMedia fallback with the same screen, no picker). A window capture froze the moment the player
 * Alt-Tabbed into VPX in VR; the solo engine's monitor capture never did. While the capture is live the window is
 * probed every 5 s (it moved, resized, or closed) and the focus is watched: the page sends a "Paused" frame while VPX
 * is not in front (D1.9). Nothing here throws out of `attach`: a missing window or microphone leaves the match running
 * without that medium and says so in `lastError`. A window missing at `attach` is looked for every 3 s until one is
 * found, and again after the capture ends (D2, 2026-10-31), so the track is on the connections before this rig's turn.
 *
 * VR rigs (2026-10-31, the owner's 0.2.26 log): no cover on focus. In VR the preview window renders whatever has focus,
 * and the cover fired mid-match for 30 s while a browser, then Castcade itself, were in front: the other player saw
 * the "Paused" card instead of the playfield. Monitor rigs keep it.
 *
 * Theater (D7.4, 2026-10-31): `videoFrames()` hands the OpenXR layer the up player's video. While someone wants it the
 * page draws the stage <video> into a canvas and sends its pixels (RGBA) on `castcade-panel:video`, one frame in flight
 * (main acks each), at most 30 a second.
 */
import { BrowserWindow, desktopCapturer, ipcMain, screen, session, type DesktopCapturerSource, type IpcMainEvent, type NativeImage, type Session } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../main/log.js';
import { CoverGate, matchScreenSource, sameCrop, screenCropFor, type ScreenDisplay, type ScreenTarget } from './capture-crop.js';
import { isVpxExe, type FocusChange, type FocusWatch } from './focus-watch.js';
import type { MatchMedia, MatchPlayerId, MediaSignal, MediaSignalling, MediaStatus, PanelFrame, PanelFrameSource, PanelState, VideoFrame, VideoFrameSource } from './match-media-types.js';
import { describeIce, iceServers, type MediaSettingsStore } from './media-settings.js';
import { MIC_LIST_CHANNEL, PANEL_CHANNELS, VIDEO_FEED_MAX, micListPageHtml, panelPageHtml, type MicDevice, type PanelAttach, type PanelCapture, type PanelPageStatus } from './panel-page.js';
import { UNCOVER_MS } from './stream-engine.js';
import { pickPlayfield, type VpxWindow, type WindowProbe } from './window-geometry.js';

export interface RtcHostOptions {
  userData: string;
  log: Pick<Logger, 'info' | 'warn'>;
  probe: () => Promise<WindowProbe>;
  settings: MediaSettingsStore;
  /**
   * D2.5: `focus-watch.ts` `watchFocus`, run while the capture is live so the match video is covered while VPX is not
   * in front. Absent (tests), nothing is covered.
   */
  watchFocus?: (onChange: (c: FocusChange) => void, onEnd: (why: string) => void) => FocusWatch;
}

/** `MatchMedia` plus the microphone picker the Match tab needs (the panel page lists the devices). */
export interface RtcHost extends MatchMedia {
  microphones(): MicDevice[];
  onMicrophones(cb: (mics: MicDevice[]) => void): () => void;
  /** Saves the choice and, while attached, switches the live microphone (no renegotiation: the sender is kept). */
  setMicrophone(deviceId: string | null): void;
  /**
   * A6 (2026-10-31): the rig the match host decided. B22 (2026-10-31) split it in two, because a headset on a runtime
   * other than SteamVR has no place for the panel: `inVr` is the rig (it picks the window to send: in VR, the largest
   * VPX window when none is titled "Visual Pinball Player"); `headsetPanel` is the panel window (true: an offscreen
   * panel for the OpenVR overlay helper, SteamVR only; false: a visible desktop window, also in VR on another runtime).
   * Before `attach` it sets the next panel. While attached on the desktop, `headsetPanel: true` moves the panel
   * offscreen: a new window, re-attached with the current peers, panel state, sending flag, microphone and mute
   * (the peers renegotiate through the page's offer resend), so `frames()` has a source for the overlay once it
   * resolves. Headset → desktop while attached is not supported: logged and ignored until the match ends.
   */
  setVr(rig: { inVr: boolean; headsetPanel: boolean }): Promise<void>;
  /**
   * B22 (2026-10-31): list the microphones before a match (the panel page lists them only once it opens, so a tester
   * saw "Windows default" alone at Host / Join). A hidden page in the panel's partition enumerates them, opening the
   * microphone once and stopping it when the labels are hidden; `onMicrophones` gets the list. A no-op while attached
   * (the panel page keeps the list current) and while a listing runs.
   */
  refreshMicrophones(): Promise<void>;
}

const PARTITION = 'castcade-panel';
const PAGE_FILE = 'match-panel.html';
const MIC_PAGE_FILE = 'match-mics.html';
/** The hidden microphone page answers in well under a second; a stuck one is closed after this. */
const MIC_LIST_TIMEOUT_MS = 10_000;
/** The headset panel: 3:2, wide enough for a 16:9 picture plus the header and strip at 0.55 m (alpha-match.md §5). */
export const VR_PANEL_SIZE = { width: 960, height: 640 } as const;
export const DESKTOP_PANEL_SIZE = { width: 480, height: 720 } as const;
export const PANEL_FPS = 20;
const READY_TIMEOUT_MS = 15_000;
/**
 * D2 (2026-10-31, the first two-player match): while attached with no capture, the VPX windows are probed this often.
 * The host pressed Host before its table was up and the capture was looked for again only at its first turn, so the
 * whole of ball 1 went on acquiring it, adding the track and renegotiating: no picture for the others.
 */
export const CAPTURE_RETRY_MS = 3_000;
/** D2.5: while the capture is live, the window is probed this often: a move or a resize re-crops, a closed window stops it. */
export const RECROP_MS = 5_000;
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
 * D2 (2026-10-31, the first two-player match): windows of the VPX process that are never the playfield. Krobs had
 * `VRPreview` off, so there was no player window, and the VR fallback sent his VPinMAME / FlexDMD DMD window for the
 * whole match. DMDs, backglasses (B2S) and PinUP Player screens all belong to the VPX process.
 */
const NOT_PLAYFIELD_TITLE = /dmd|pinmame|flexdmd|backglass|b2s|pup|pinup/i;
/** The VR fallback takes no window smaller than this (a DMD or a backglass, whatever its title). */
export const MIN_FALLBACK_SIZE = { width: 640, height: 360 } as const;
export const NO_PLAYFIELD_TO_SEND = 'no playfield window to send: turn on VRPreview in VPX (Preferences → VR) so there is a window to capture';

const fallbackCandidate = (w: VpxWindow): boolean => {
  const t = w.title.trim();
  return !EDITOR_TITLE.test(t) && !NOT_PLAYFIELD_TITLE.test(t) && w.client.width >= MIN_FALLBACK_SIZE.width && w.client.height >= MIN_FALLBACK_SIZE.height;
};

/**
 * The window to send. In VPX 10.8 VR with `VRPreview` on, the preview IS the "Visual Pinball Player" window: the D1
 * rig runs 2–5 (2026-10-25, solo-streaming-and-recording.md) captured exactly that window in VR and got the eye image;
 * with `VRPreview = 0` the same window is a black 640x480. So both modes take `pickPlayfield`. In VR only, when no
 * window has that title (another VR build may name it differently), the largest VPX window that is not the editor, a
 * DMD, a backglass or a PinUP screen, and is at least 640x360, is taken and flagged (D2, 2026-10-31); when only those
 * exist nothing is sent and `noCaptureReason` says to turn VRPreview on. On the desktop the editor-only case sends
 * nothing (rig run 2 filmed the editor that way).
 */
export function pickCaptureWindow(windows: VpxWindow[], vr: boolean): CapturePick | null {
  const player = pickPlayfield(windows);
  if (player) return { window: player, fallback: false };
  if (!vr) return null;
  const others = windows.filter(fallbackCandidate);
  const largest = [...others].sort((a, b) => b.client.width * b.client.height - a.client.width * a.client.height)[0];
  return largest ? { window: largest, fallback: true } : null;
}

/** Why `pickCaptureWindow` found nothing, for `lastError` (the Match tab's media line and the panel's message line). */
export function noCaptureReason(windows: VpxWindow[], vr: boolean): string {
  if (!vr) return `no "${PLAYER_TITLE}" window to send: start the table`;
  // VPX windows besides the editor: the table runs, but only its DMD / backglass is on the desktop (VRPreview off).
  if (windows.some((w) => !EDITOR_TITLE.test(w.title.trim()))) return NO_PLAYFIELD_TO_SEND;
  return 'no VPX window to send: open the table in VR with VRPreview on';
}

/**
 * `MediaStatus.captureSource` (D2.5): which screen and the size of the crop sent from it (the runbook wants the VR
 * preview at 1280x720), e.g. `screen 2, crop 1280x720 of Visual Pinball Player`.
 */
export function captureLabel(p: CapturePick, t: Pick<ScreenTarget, 'index' | 'crop'>): string {
  const what = `screen ${t.index + 1}, crop ${t.crop.width}x${t.crop.height} of`;
  if (!p.fallback) return `${what} ${p.window.title}`;
  return `${what} ${p.window.title || 'untitled VPX window'} (the largest VPX window, none is titled "${PLAYER_TITLE}")`;
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

/**
 * D7.4: the up player's video for the headset. `setWanted` is passed to the page (it costs a copy per frame there);
 * frames are fanned out only while wanted.
 */
export function createVideoHub(onWanted: (on: boolean) => void): { source: VideoFrameSource; wanted(): boolean; push(frame: VideoFrame): void } {
  const listeners = new Set<(f: VideoFrame) => void>();
  let wanted = false;
  return {
    source: {
      onFrame(cb) {
        listeners.add(cb);
        return () => {
          listeners.delete(cb);
        };
      },
      setWanted(on) {
        if (on === wanted) return;
        wanted = on;
        onWanted(on);
      },
    },
    wanted: () => wanted,
    push(frame) {
      if (!wanted) return;
      for (const cb of [...listeners]) {
        try {
          cb(frame);
        } catch {
          // a listener's fault is its own
        }
      }
    },
  };
}

/** A video frame from the page, checked: whole, RGBA-sized, inside the feed's limits. Null otherwise. */
export function videoFrameFrom(m: unknown): VideoFrame | null {
  if (typeof m !== 'object' || m === null) return null;
  const v = m as { width?: unknown; height?: unknown; rgba?: unknown; stereo?: unknown };
  const { width, height, rgba } = v;
  if (typeof width !== 'number' || typeof height !== 'number' || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) return null;
  const stereo = v.stereo === 'sbs' ? 'sbs' : 'mono';
  const max = stereo === 'sbs' ? VIDEO_FEED_MAX.sbs : VIDEO_FEED_MAX.mono;
  if (width > max.width || height > max.height) return null;
  if (!(rgba instanceof Uint8Array) || rgba.length !== width * height * 4) return null;
  return { width, height, rgba, stereo };
}

/** The controller's view: the page's report plus what only main knows. Main's own error wins (it is the cause). */
export function mergeStatus(
  page: PanelPageStatus | null,
  main: { attached: boolean; sending: boolean; captureLabel: string | null; error: string | null; captureCrop?: { width: number; height: number } | null },
): MediaStatus {
  const live = main.attached && !!page?.capturing;
  return {
    attached: main.attached,
    sending: main.attached && main.sending,
    peers: main.attached && page ? page.peers : {},
    mic: main.attached && page ? page.mic : 'unavailable',
    captureSource: live ? main.captureLabel : null,
    captureCrop: live && main.captureCrop ? { width: main.captureCrop.width, height: main.captureCrop.height } : null,
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
  /** The panel kind the match host decided (`setVr`'s `headsetPanel`): the next attach opens this. */
  let wantHeadset = false;
  /** The kind of the panel window open now: offscreen for the headset overlay, or a desktop window. */
  let headset = false;
  /** The rig is in VR (`setVr`'s `inVr`), whatever the panel window: the capture pick reads this. */
  let inVr = false;
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
  /** The capture the page was given (in `attach` or on the capture channel): each one is announced once. */
  let announced: PanelCapture | null = null;
  let captureTimer: ReturnType<typeof setTimeout> | null = null;
  /** D2.5: the re-probe while the capture is live, and the focus watch that covers it. */
  let recropTimer: ReturnType<typeof setTimeout> | null = null;
  let focus: FocusWatch | null = null;
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
  // D7.4: the wish follows the page across re-attaches (`attach` replays it); a latest-wins channel.
  const videoHub = createVideoHub((on) => {
    log.info(`media: theater video ${on ? 'wanted from the panel page' : 'no longer wanted'}`);
    toPage(PANEL_CHANNELS.videoWant, on);
  });
  /** VR rigs never cover on focus (see the header); said once per attach. */
  let coverOffSaid = false;

  const status = (): MediaStatus =>
    mergeStatus(page, { attached, sending, captureLabel: capture?.label ?? null, captureCrop: capture?.crop ?? null, error: panelError ?? captureError });
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
    // The capture is looked for every 3 s until found (D2, 2026-10-31): say each reason once, not at every look.
    if (captureError === msg) return;
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
  const LATEST = new Set<string>([
    PANEL_CHANNELS.state,
    PANEL_CHANNELS.sending,
    PANEL_CHANNELS.muted,
    PANEL_CHANNELS.capture,
    PANEL_CHANNELS.cover,
    PANEL_CHANNELS.microphone,
    PANEL_CHANNELS.videoWant,
  ]);
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
    const ended = page?.capturing === true && !s.capturing;
    page = s;
    // The page's capture track ended (the table closed, VPX restarted): look for the window again (D2, 2026-10-31).
    if (ended && capture && attached) {
      log.info(`media: the capture of ${capture.label} ended; looking for the VPX window again`);
      dropCapture(false);
      scheduleCapture(generation);
    }
    emitStatus();
  });
  const setMics = (d: unknown[]): void => {
    mics = d.filter((x): x is MicDevice => typeof x === 'object' && x !== null && typeof (x as MicDevice).deviceId === 'string' && typeof (x as MicDevice).label === 'string');
    for (const l of micListeners) l(mics);
  };
  ipcMain.on(PANEL_CHANNELS.video, (e, m: unknown) => {
    if (!fromPanel(e)) return;
    // The ack first: the page sends the next frame only after it, so at most one frame is ever queued on the IPC.
    post(PANEL_CHANNELS.videoAck);
    const f = videoFrameFrom(m);
    if (f) videoHub.push(f);
  });
  ipcMain.on(PANEL_CHANNELS.devices, (e, d: unknown) => {
    if (!fromPanel(e) || !Array.isArray(d)) return;
    setMics(d);
  });

  // ---- B22 (2026-10-31): the microphones before a match, from a hidden page in the same partition ----
  let micWin: BrowserWindow | null = null;
  let micAnswer: ((r: unknown) => void) | null = null;
  let listing: Promise<void> | null = null;
  ipcMain.on(MIC_LIST_CHANNEL, (e, r: unknown) => {
    if (!micWin || micWin.isDestroyed() || e.sender !== micWin.webContents) return;
    micAnswer?.(r);
  });
  const listMicrophones = async (): Promise<void> => {
    let w: BrowserWindow | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      panelSession();
      const file = join(opts.userData, MIC_PAGE_FILE);
      mkdirSync(opts.userData, { recursive: true });
      writeFileSync(file, micListPageHtml());
      const answer = new Promise<unknown>((resolve) => {
        micAnswer = resolve;
      });
      timer = setTimeout(() => micAnswer?.({ mics: null, error: 'no answer in time' }), MIC_LIST_TIMEOUT_MS);
      w = new BrowserWindow({
        show: false,
        width: 320,
        height: 120,
        webPreferences: { partition: PARTITION, nodeIntegration: true, contextIsolation: false, backgroundThrottling: false },
      });
      micWin = w;
      w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      w.webContents.on('will-navigate', (e) => e.preventDefault());
      void w.loadFile(file).catch((e: unknown) => micAnswer?.({ mics: null, error: `the page did not load (${errText(e)})` }));
      const r = (await answer) as { mics?: unknown; error?: unknown } | null;
      // A match opened meanwhile: its panel page lists them now, and its list wins.
      if (attached) return;
      if (r && Array.isArray(r.mics)) {
        setMics(r.mics);
        log.info(`media: ${mics.length} microphone(s) listed before the match`);
      } else {
        log.warn(`media: could not list the microphones before the match (${typeof r?.error === 'string' ? r.error : 'no answer'})`);
      }
    } catch (e) {
      log.warn(`media: could not list the microphones before the match (${errText(e)})`);
    } finally {
      clearTimeout(timer);
      micAnswer = null;
      micWin = null;
      if (w && !w.isDestroyed()) w.destroy();
    }
  };
  const refreshMicrophones = (): Promise<void> => {
    if (attached) return Promise.resolve();
    listing ??= listMicrophones().finally(() => {
      listing = null;
    });
    return listing;
  };

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

  const createWindow = (offscreen: boolean): BrowserWindow => {
    panelSession();
    const webPreferences = {
      partition: PARTITION,
      // Local content only (a page written here); node for ipcRenderer, as the stream-host audio page.
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required' as const,
      offscreen,
    };
    const w = offscreen
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
    if (offscreen) {
      w.webContents.setFrameRate(PANEL_FPS);
      w.webContents.on('paint', (_e, _dirty, image: NativeImage) => {
        if (!hub.wanted()) return;
        const f = frameFromBitmap(image.toBitmap(), image.getSize());
        if (f) hub.push(f);
      });
    } else {
      // D2.5: the match video films the screen now, and this always-on-top window may sit over the player window (it
      // shows the sent picture itself while this rig is up: a hall of mirrors). Kept out of every screen capture.
      w.setContentProtection(true);
      // The page holds the connections: closing the window hides it; the match ends them with detach().
      w.on('close', (e) => {
        e.preventDefault();
        w.hide();
      });
    }
    return w;
  };

  /**
   * D2.5: Electron's displays with their physical rects (`dipToScreenRect`, Windows: a display's own bounds map to its
   * pixels exactly, mixed DPI included); without it `capture-crop.ts` scales the DIP bounds.
   */
  const displays = (): ScreenDisplay[] =>
    screen.getAllDisplays().map((d) => {
      let physical: ScreenDisplay['physical'];
      try {
        const r = screen.dipToScreenRect(null, d.bounds);
        physical = { left: r.x, top: r.y, width: r.width, height: r.height };
      } catch {
        physical = undefined;
      }
      return { id: d.id, bounds: d.bounds, scaleFactor: d.scaleFactor, physical };
    });

  type Resolved = { capture: PanelCapture; src: DesktopCapturerSource; pick: CapturePick } | { error: string };
  /** The window to send, the screen that holds it and its crop. Throws only when the probe or the capturer does. */
  const resolveCapture = async (): Promise<Resolved> => {
    const probe = await opts.probe();
    const pick = pickCaptureWindow(probe.windows, inVr);
    if (!pick) return { error: noCaptureReason(probe.windows, inVr) };
    const target = screenCropFor(pick.window, probe.outputs, displays());
    if (!target) return { error: `the window "${pick.window.title}" is on no display` };
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
    const src = matchScreenSource(sources, target.display.id);
    if (!src) return { error: `screen ${target.index + 1}, which shows "${pick.window.title}", is not offered for capture` };
    return { capture: { sourceId: src.id, label: captureLabel(pick, target), screen: target.screen, crop: target.crop, out: target.out }, src, pick };
  };

  /** Finds the window to send and its capturer source; never throws. A newer attach or detach discards the result. */
  const pickCapture = (gen: number): Promise<void> => {
    if (picking?.gen === gen) return picking.done;
    const done = (async () => {
      try {
        const r = await resolveCapture();
        if (gen !== generation) return;
        if ('error' in r) {
          setCaptureError(r.error);
          return;
        }
        captureSrc = r.src;
        capture = r.capture;
        captureError = null;
        if (r.pick.fallback) log.warn(`media: no "${PLAYER_TITLE}" window; sending the largest VPX window instead: ${capture.label}`);
      } catch (e) {
        if (gen === generation) setCaptureError(`the VPX window could not be found (${errText(e)})`);
      } finally {
        if (picking?.gen === gen) picking = null;
      }
    })();
    picking = { gen, done };
    return done;
  };

  // ---- D2.5: while the capture is live: the cover (D1.9) and the re-crop ----
  const gate = new CoverGate((on, why) => {
    log.info(on ? `media: match video covered (${why})` : 'media: match video uncovered (VPX in front)');
    toPage(PANEL_CHANNELS.cover, on);
  }, UNCOVER_MS);
  const startFocus = (): void => {
    if (focus || !opts.watchFocus) return;
    if (inVr) {
      if (!coverOffSaid) {
        coverOffSaid = true;
        log.info('media: match video cover off (VR rig: the preview renders without focus)');
      }
      return;
    }
    focus = opts.watchFocus(
      (c) => gate.note(isVpxExe(c.exe), c.exe || null),
      (why) => {
        focus = null;
        log.warn(`media: the focus watch stopped (${why}); the match video is not covered when VPX loses focus`);
        gate.note(null);
      },
    );
  };
  const stopLive = (): void => {
    focus?.stop();
    focus = null;
    if (recropTimer) clearTimeout(recropTimer);
    recropTimer = null;
    if (gate.covered) toPage(PANEL_CHANNELS.cover, false);
    gate.reset();
  };
  /** The capture is gone (no window any more, or the page's capture ended); `tellPage`: main noticed it first. */
  function dropCapture(tellPage: boolean): void {
    capture = null;
    captureSrc = null;
    announced = null;
    stopLive();
    if (tellPage) toPage(PANEL_CHANNELS.capture, null);
  }
  function scheduleRecrop(gen: number): void {
    if (recropTimer || gen !== generation || !attached || !capture) return;
    recropTimer = setTimeout(() => {
      recropTimer = null;
      void recrop(gen);
    }, RECROP_MS);
  }
  /** One re-probe of a live capture: same crop → nothing; moved or resized → the page re-crops; gone → dropped. */
  const recrop = async (gen: number): Promise<void> => {
    if (gen !== generation || !attached || !capture) return;
    let r: Resolved;
    try {
      r = await resolveCapture();
    } catch {
      // A probe that failed says nothing about the window: keep sending, look again next time.
      scheduleRecrop(gen);
      return;
    }
    const cur = capture;
    if (gen !== generation || !attached || !cur) return;
    if ('error' in r) {
      log.info(`media: stopped sending ${cur.label}: ${r.error}`);
      dropCapture(true);
      setCaptureError(r.error);
      scheduleCapture(gen);
      emitStatus();
      return;
    }
    if (r.capture.sourceId !== cur.sourceId || !sameCrop(r.capture.crop, cur.crop) || r.capture.label !== cur.label) {
      // Logged once per change: an unchanged window says nothing.
      const c = r.capture.crop;
      log.info(`media: the VPX window moved or resized: ${r.capture.label} at ${c.x},${c.y}`);
      captureSrc = r.src;
      capture = r.capture;
      announced = capture;
      toPage(PANEL_CHANNELS.capture, capture);
      emitStatus();
    }
    scheduleRecrop(gen);
  };
  /** A capture went to the page: watch the focus and the window while it lives. */
  const captureLive = (gen: number): void => {
    startFocus();
    scheduleRecrop(gen);
  };

  /**
   * D2 (2026-10-31): a capture found after `attach` goes to the page at once, not at this rig's first turn. The page
   * adds the track to every connection disabled (`enabled = sending`), so the negotiation happens before the turn
   * and `setSending(true)` only flips the flag. Each capture is announced and logged once.
   */
  const announceCapture = (gen: number): void => {
    if (gen !== generation || !attached || !capture || capture === announced) return;
    announced = capture;
    log.info(`media: capture ${capture.label} ready`);
    if (attachMsg && !attachSent) attachMsg.capture = capture;
    else toPage(PANEL_CHANNELS.capture, capture);
    captureLive(gen);
    emitStatus();
  };
  /** One look now: found → announced; not found → another look in `CAPTURE_RETRY_MS`. */
  const lookForCapture = (gen: number): Promise<void> =>
    pickCapture(gen).then(() => {
      if (gen !== generation || !attached) return;
      if (capture) announceCapture(gen);
      else scheduleCapture(gen);
    });
  function scheduleCapture(gen: number): void {
    if (captureTimer || gen !== generation || !attached || capture) return;
    captureTimer = setTimeout(() => {
      captureTimer = null;
      if (gen !== generation || !attached || capture) return;
      void lookForCapture(gen);
    }, CAPTURE_RETRY_MS);
  }
  const stopCaptureTimer = (): void => {
    if (captureTimer) clearTimeout(captureTimer);
    captureTimer = null;
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
    announced = null;
    stopCaptureTimer();
    stopLive();
    page = null;
    sending = false;
    coverOffSaid = false;
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
    headset = wantHeadset;
    for (const p of initialPeers) if (p !== sig.localId) peers.add(p);
    if (restore) {
      sending = restore.sending;
      if (restore.state) {
        lastState = restore.state;
        toPage(PANEL_CHANNELS.state, restore.state);
      }
    }
    offSignal = sig.onSignal((from, signal) => toPage(PANEL_CHANNELS.signal, { from, signal }));
    if (videoHub.wanted()) toPage(PANEL_CHANNELS.videoWant, true);
    try {
      const file = join(opts.userData, PAGE_FILE);
      mkdirSync(opts.userData, { recursive: true });
      writeFileSync(file, panelPageHtml({ vr: headset }));
      win = createWindow(headset);
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
    log.info(`media: attach (${headset ? 'VR, offscreen panel' : inVr ? 'VR, desktop panel' : 'desktop panel'}),${attachMsg.peers.length} peer(s), ${describeIce(s)}, capture ${capture?.label ?? 'none'}`);
    if (capture) {
      announced = capture;
      log.info(`media: capture ${capture.label} ready`);
      captureLive(gen);
    } else scheduleCapture(gen);
    flush();
    emitStatus();
  };

  const setSending = (on: boolean): void => {
    if (sending === on) return;
    sending = on;
    if (attachMsg && !attachSent) attachMsg.sending = on;
    toPage(PANEL_CHANNELS.sending, on);
    // Still no window at this rig's turn (the 3 s looks found none yet): look once more now, not at the next tick.
    if (on && attached && !capture) {
      stopCaptureTimer();
      void lookForCapture(generation);
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
    frames: () => (attached && headset ? hub.source : null),
    videoFrames: () => (attached && headset ? videoHub.source : null),
    showPanel() {
      if (headset || !win || win.isDestroyed()) return;
      // showInactive: focus stays with VPX, whose window takes the player's keys.
      win.showInactive();
    },
    detach: () => detach(),
    async setVr(rig) {
      // The capture pick follows the rig at once (the next pick reads it); the window kind needs a re-attach.
      inVr = rig.inVr;
      wantHeadset = rig.headsetPanel;
      // A rig found to be in VR mid-capture: the focus watch goes, and a cover it put up comes down.
      if (inVr && focus) {
        focus.stop();
        focus = null;
        gate.note(null);
        startFocus();
      }
      if (!attached || rig.headsetPanel === headset) return;
      if (!rig.headsetPanel) {
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
    refreshMicrophones,
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
