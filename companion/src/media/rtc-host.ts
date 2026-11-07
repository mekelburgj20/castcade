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
 *
 * The layer camera (D7.5.1, 2026-11-02; docs/design/alpha-match.md §5a): with the Match tab's Camera on `VR layer`, a
 * VR rig on an OpenXR runtime other than SteamVR sends what the Castcade OpenXR layer copies out of VPX's own frame
 * instead of a screen capture. Each attach decides (`layer-camera.ts` decideCamera); for the layer, the camera is asked
 * (`setCamera(cameraRequestFor({ view }))`, the Match tab's Camera view: each eye's whole render by default, D7.5.9,
 * 2026-11-04, or the 1:2 crop; `setCameraView` re-asks live), no screen capture is opened, and the page is given a synthetic capture
 * (`cameraCapture`, `sourceId: 'layer-camera'`) and the frames (both eyes' JPEGs, one in flight, newest wins; one a
 * second while another player is up). A 1 s tick and every camera status run `cameraWatch`; on a fallback the camera
 * is stopped, logged (`media: camera: back to the screen capture: <reason>`) and the screen capture picked as usual.
 * Nothing falls forward to the layer again within the match, except the player choosing it again on the Match tab
 * (taken between balls). D8.1 (2026-11-05, ADR 0009): the layer is the default on VR rigs and asks for ONE eye
 * (`setCameraEyes`, match settings `cameraEyes`, `one` by default: the request's `eye: 'left'`); the capture is then
 * mono (`cameraCapture(w, h, 'mono')`), each frame carries that eye alone (`cameraPageFrame` keeps the asked eye out
 * of a two-eye frame from a layer that predates `eye`), and the receivers show it as the flat screen. `both` is the
 * 0.2.35 side-by-side path, untouched. With the setting on `screen` none of this runs: the capture path, its log lines
 * and its page messages are those of 0.2.32.
 *
 * The VR test bench and saved frames (D7.6, D7.6.3, 2026-11-03; alpha-match.md §5b): `startBench` opens the panel page
 * without a match (the page gets `castcade-panel:bench` instead of an attach) and feeds it a saved clip or this rig's
 * layer camera, one frame in flight; `frames()` / `videoFrames()` serve it as in a match, so the OpenXR layer's
 * theater takes it by the receiver's own path. `saveFrames` writes 2 s of layer-camera frames and of the theater
 * frames the page hands to the layer (`frame-clip.ts`).
 */
import { BrowserWindow, desktopCapturer, ipcMain, powerSaveBlocker, screen, session, type DesktopCapturerSource, type IpcMainEvent, type NativeImage, type Session } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../main/log.js';
import { CoverGate, fitWarning, matchScreenSource, sameCrop, screenCropFor, type ScreenDisplay, type ScreenTarget } from './capture-crop.js';
import { isVpxExe, type FocusChange, type FocusWatch } from './focus-watch.js';
import { cameraEyeFor, cameraEyesWords, cameraFrameEyes, cameraRequestFor, cameraViewWords, cameraWatch, createFrameSlot, decideCamera, LAYER_CAMERA_EYE_HEIGHT, type CameraDecision, type CameraDecisionInput, type CameraEyesSetting, type CameraSourceSetting, type CameraViewSetting } from './layer-camera.js';
import type { LayerCameraEyeGeometry, LayerCameraEyeSide, LayerCameraFrame, LayerCameraRequest, MatchMedia, MatchPlayerId, MediaSignal, MediaSignalling, MediaStatus, PanelFrame, PanelFrameSource, PanelState, PanelVolume, TableAudioFlags, VideoFrame, VideoFrameSource, VrOverlay, VrStereo } from './match-media-types.js';
import { describeIce, iceServers, type MediaSettingsStore } from './media-settings.js';
import { placePanel, type PanelSide, type Rect } from './panel-placement.js';
import { MIC_LIST_CHANNEL, PANEL_CHANNELS, PANEL_VIDEO, VIDEO_FEED_MAX, cameraCapture, isCameraCapture, micListPageHtml, panelPageHtml, videoBitrateFor, type MicDevice, type PanelAttach, type PanelBench, type PanelBenchFrame, type PanelCameraFrame, type PanelCapture, type PanelPageStatus } from './panel-page.js';
import { FRAME_SAVE_GRACE_MS, FRAME_SAVE_MAX, FRAME_SAVE_MS, createFrameSaver, playbackIndex, receivedFrameFrom, savedLine, type FrameSaver, type Playback, type SaveFramesResult } from './frame-clip.js';
import { benchReadout, benchReportFrom, benchWords, type BenchPageReport, type BenchPath, type BenchSource } from './bench.js';
import { UNCOVER_MS } from './stream-engine.js';
import { declaredStereo, type PreviewStereoSetting } from './preview-stereo.js';
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
  /**
   * D2.6 (2026-11-01): the main window's bounds while it is on screen (null: hidden, minimized or gone). The desktop
   * panel is placed beside them, never over them. Absent (tests), the panel goes to the display's right edge.
   */
  mainBounds?: () => Rect | null;
  /**
   * D7.4.3 (2026-11-01): `[PlayerVR] VRPreview` of the running VPX's active ini (`preview-stereo.ts` readIniStereo),
   * read at each capture pick of a VR rig whose setting is `auto`. Absent (tests), not known.
   */
  iniStereo?: () => Promise<VrStereo | null>;
}

/**
 * D10.6 (2026-11-07): the VPX window the screen capture picked, for the helper's own Windows Graphics Capture of it:
 * the pid and the title words `pickCaptureWindow` matched ("Visual Pinball Player", or the fallback window's own
 * title), the box the Electron capture would have sent (`PanelCapture.out`) and its frame rate.
 */
export interface NativeVideoWindow {
  pid: number;
  title: string;
  width: number;
  height: number;
  fps: number;
}

/**
 * D10.3: see `RtcHost.setNativeVideo`. `ring`: the `send` ring's token (one per companion start). D10.6: `onWindow`,
 * when the match host gives it, hears the VPX window whenever the screen capture (not the layer camera) is the capture
 * and it was picked, changed or lost (null): the helper captures that window itself, and the page's video track is
 * held back meanwhile. Without `onWindow` the screen capture flows through Electron as in 0.2.36.
 */
export interface NativeVideoHook {
  ring: string;
  onSource(box: { width: number; height: number; fps: number } | null): void;
  onWindow?(win: NativeVideoWindow | null): void;
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
  setVr(rig: { inVr: boolean; headsetPanel: boolean; runtime?: CameraDecisionInput['runtime'] }): Promise<void>;
  /**
   * D7.5.1 (2026-11-02): the OpenXR layer whose camera a VR sender may use (`media/vr-layer.ts`; the match host passes
   * its `vrLayer`); null or one without `setCamera`: the screen capture only.
   */
  setCameraLayer(layer: VrOverlay | null): void;
  /**
   * D10.3 (2026-11-07, spectator-video-native.md §6.4): the native spectator video is on for this match. With a hook,
   * the layer camera is asked with `ring` (the layer fills the helper's `send` ring instead of sending JPEG frames) and
   * `onSource` is told the box the camera was asked for whenever a camera run starts, changes or stops (null), so the
   * match host can point the helper at the ring; and while the camera is the capture, the panel page's VIDEO track is
   * held back (the page is told `sending` false on this rig's turn; voice and table sound are untouched). With the
   * screen capture (a desktop rig, SteamVR, the Match tab on screen capture, a camera fallback) and a hook with
   * `onWindow` (D10.6), the picked VPX window goes to the hook for the helper's own capture of it and the page's video
   * track is held back the same way; without `onWindow` the Electron video keeps flowing as in 0.2.36. Null: the
   * 0.2.36 path.
   */
  setNativeVideo(hook: NativeVideoHook | null): void;
  /**
   * D7.5.1: the Match tab's Camera (match settings `cameraSource`). Read at each attach; while attached a change takes
   * effect at once between balls, or when this rig's ball ends.
   */
  setCameraSource(setting: CameraSourceSetting): void;
  /**
   * D7.5.9 (2026-11-04): the Match tab's Camera view (match settings `cameraView`): each eye's whole render, or the
   * 1:2 centre crop. Applied live: a running match camera and a running bench on "my own table, live" are asked
   * again with the new box (the layer switches between frames; the capture's size follows the next frame).
   */
  setCameraView(view: CameraViewSetting): void;
  /**
   * D8.1 (2026-11-05): the Match tab's Camera eyes (match settings `cameraEyes`): one eye as a flat picture (the
   * default) or both side by side. Applied live like the view: a running match camera and a running bench are asked
   * again; a running match capture is replaced (its shape and declaration change) and the page told.
   */
  setCameraEyes(setting: CameraEyesSetting): void;
  /**
   * B22 (2026-10-31): list the microphones before a match (the panel page lists them only once it opens, so a tester
   * saw "Windows default" alone at Host / Join). A hidden page in the panel's partition enumerates them, opening the
   * microphone once and stopping it when the labels are hidden; `onMicrophones` gets the list. A no-op while attached
   * (the panel page keeps the list current) and while a listing runs.
   */
  refreshMicrophones(): Promise<void>;
  /**
   * D2.6 (2026-11-01): the Match tab's Show panel / Hide panel. Hiding keeps the connections (as closing the window
   * does); both are no-ops for the headset panel.
   */
  hidePanel(): void;
  /**
   * D7.4.3 (2026-11-01): the Match tab's preview setting (match settings `previewStereo`). Read at each capture pick;
   * while a capture is live the next look (at once) tells the page, which tells the peers.
   */
  setPreviewStereo(setting: PreviewStereoSetting): void;
  /** D2.8 (2026-11-01): table sound on the page (MatchMedia); here always present. */
  setTableAudio(flags: TableAudioFlags): void;
  pushTableAudio(pcm: Uint8Array): void;
  capturePid(): number | null;
  /** D2.10 (2026-11-05): the playback volumes (MatchMedia); kept for a new page, sent live to one that is up, the note only live. */
  setVolume(volume: PanelVolume): void;
  /**
   * D7.6.3 (2026-11-03): save the next 2 s of frames into `dir` (`frame-clip.ts`): every layer-camera frame while the
   * camera runs (the sender side), and every theater frame the panel page hands to the layer while it does (the receiver
   * side). Resolves once the files and `clip.json` are written; one save at a time.
   */
  saveFrames(o: { dir: string; folder: string; settings: Record<string, unknown> }): Promise<SaveFramesResult>;
  /**
   * D7.6 (2026-11-03): the VR test bench (media/bench.ts): the panel page without a match (no mesh, no microphone, no
   * capture), showing a saved clip or this rig's layer camera on its stage and, while the layer wants it, handing it to
   * the layer as the theater feed by the chosen path. Refused while attached; `frames()` and `videoFrames()` serve it
   * like a match. `stopBench` (or a match's attach) detaches it.
   */
  startBench(o: RtcBenchStart): Promise<void>;
  stopBench(): Promise<void>;
  benchStatus(): RtcBenchStatus | null;
  onBenchStatus(cb: (s: RtcBenchStatus | null) => void): () => void;
}

/** D7.6: what the match host asks of the bench. `clip` (source clip): the frames to loop, read from `clipDir`. */
export interface RtcBenchStart {
  source: BenchSource;
  path: BenchPath;
  clip: Playback | null;
  clipDir: string | null;
  clipName: string | null;
  inVr: boolean;
  /** The offscreen panel for the headset (the OpenXR layer takes its frames); false: the desktop window, shown. */
  headsetPanel: boolean;
  /** D7.6.9 (2026-11-03): path `loop`'s bitrate cap in bits per second; null: the match's rule (`videoBitrateFor`). */
  bitrate: number | null;
}

/** D7.6: the bench now: what runs, the page's last readout, the layer camera's state (source live), the readout line. */
export interface RtcBenchStatus {
  source: BenchSource;
  path: BenchPath;
  headset: boolean;
  report: BenchPageReport | null;
  camera: { state: string; why: string | null } | null;
  readout: string;
}

/** D7.6: the bench's readout goes to companion.log this often while it runs. */
export const BENCH_LOG_MS = 10_000;

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
/** D7.4.4: a stalled capture is re-picked at most this often (the page reports every 2 s while it stays stalled). */
export const REPICK_MIN_MS = 10_000;
/** D7.5.1: the camera watch's tick (alpha-match.md §5a), and the frames a second the page gets while another player is up. */
export const CAMERA_WATCH_MS = 1_000;
export const CAMERA_IDLE_FRAME_MS = 1_000;
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

/**
 * D7.5.2: the `eyes` on a page's video frame (two of fov[4], rect[4], render[2], all finite numbers), or null for
 * anything else (the layer checks the geometry itself before placing a window from it).
 */
export function eyeGeometryFrom(x: unknown): LayerCameraEyeGeometry[] | null {
  if (!Array.isArray(x) || x.length !== 2) return null;
  const nums = (a: unknown, n: number): number[] | null =>
    Array.isArray(a) && a.length === n && a.every((v) => typeof v === 'number' && Number.isFinite(v)) ? (a as number[]) : null;
  const out: LayerCameraEyeGeometry[] = [];
  for (const e of x as Array<{ fov?: unknown; rect?: unknown; render?: unknown } | null>) {
    const fov = nums(e?.fov, 4);
    const rect = nums(e?.rect, 4);
    const render = nums(e?.render, 2);
    if (!fov || !rect || !render) return null;
    out.push({ fov: [fov[0]!, fov[1]!, fov[2]!, fov[3]!], rect: [rect[0]!, rect[1]!, rect[2]!, rect[3]!], render: [render[0]!, render[1]!] });
  }
  return out;
}

/** A video frame from the page, checked: whole, RGBA-sized, inside the feed's limits (D7.5.2: with its eyes when it has them). Null otherwise. */
export function videoFrameFrom(m: unknown): VideoFrame | null {
  if (typeof m !== 'object' || m === null) return null;
  const v = m as { width?: unknown; height?: unknown; rgba?: unknown; stereo?: unknown; eyes?: unknown };
  const { width, height, rgba } = v;
  if (typeof width !== 'number' || typeof height !== 'number' || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) return null;
  const stereo = v.stereo === 'sbs' ? 'sbs' : 'mono';
  const max = stereo === 'sbs' ? VIDEO_FEED_MAX.sbs : VIDEO_FEED_MAX.mono;
  if (width > max.width || height > max.height) return null;
  if (!(rgba instanceof Uint8Array) || rgba.length !== width * height * 4) return null;
  const eyes = stereo === 'sbs' ? eyeGeometryFrom(v.eyes) : null;
  return eyes ? { width, height, rgba, stereo, eyes } : { width, height, rgba, stereo };
}

/**
 * D2.7 (2026-11-01): one line per peer whose connection changed (ICE state, signalling state, or a reopen), for
 * companion.log: the page reports every 2 s, and an unchanged peer says nothing. Empty when nothing changed.
 */
export function peerChanges(before: PanelPageStatus['peers'] | null | undefined, after: PanelPageStatus['peers']): string[] {
  const out: string[] = [];
  for (const [id, p] of Object.entries(after)) {
    const b = before?.[id];
    if (b && b.ice === p.ice && b.signaling === p.signaling && (b.reopens ?? 0) === (p.reopens ?? 0)) continue;
    const reopened = (p.reopens ?? 0) > (b?.reopens ?? 0) ? `, connection replaced (${p.reopens} so far)` : '';
    out.push(`media: peer ${id}: ice ${p.ice}, signalling ${p.signaling ?? '?'}${reopened}`);
  }
  for (const id of Object.keys(before ?? {})) if (!(id in after)) out.push(`media: peer ${id}: connection closed`);
  return out;
}

/** D2.9: a line the page sent for companion.log: one line of text, at most 400 characters, prefixed `media: `; else null. */
export function panelLogLine(line: unknown): string | null {
  if (typeof line !== 'string') return null;
  const one = line.replace(/[\r\n]+/g, ' ').trim();
  return one ? `media: ${one.slice(0, 400)}` : null;
}

/** The controller's view: the page's report plus what only main knows. Main's own error wins (it is the cause). */
export function mergeStatus(
  page: PanelPageStatus | null,
  main: {
    attached: boolean;
    sending: boolean;
    captureLabel: string | null;
    error: string | null;
    captureCrop?: { width: number; height: number } | null;
    panelWindow?: { visible: boolean; side: PanelSide } | null;
    captureStereo?: VrStereo | null;
    captureWarning?: string | null;
  },
): MediaStatus {
  const live = main.attached && !!page?.capturing;
  const stereo = live && main.captureStereo !== undefined ? { captureStereo: main.captureStereo } : {};
  return {
    ...(main.attached && main.panelWindow ? { panelWindow: main.panelWindow } : {}),
    attached: main.attached,
    sending: main.attached && main.sending,
    peers: main.attached && page ? page.peers : {},
    mic: main.attached && page ? page.mic : 'unavailable',
    captureSource: live ? main.captureLabel : null,
    captureCrop: live && main.captureCrop ? { width: main.captureCrop.width, height: main.captureCrop.height } : null,
    ...stereo,
    ...(live && main.captureWarning ? { captureWarning: main.captureWarning } : {}),
    lastError: main.error ?? (main.attached ? (page?.error ?? null) : null),
  };
}

function isSignal(v: unknown): v is { to: MatchPlayerId; signal: MediaSignal } {
  if (typeof v !== 'object' || v === null) return false;
  const m = v as { to?: unknown; signal?: { kind?: unknown } };
  return typeof m.to === 'string' && typeof m.signal === 'object' && m.signal !== null && ['offer', 'answer', 'ice', 'reset', 'stereo'].includes(String(m.signal.kind));
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * D7.5.1: a layer camera frame as the page gets it: the two JPEG views (no copy here) and the eyes' geometry. D8.1
 * (2026-11-05): with `eye`, that one view only (out of a one-eye frame, or picked from a two-eye frame: the other eye
 * is dropped here, before the IPC copy), the other null.
 */
export function cameraPageFrame(f: LayerCameraFrame, eye: LayerCameraEyeSide | null = null): PanelCameraFrame | null {
  const picked = cameraFrameEyes(f.eyes, eye);
  if (!picked) return null;
  const geometry = (e: LayerCameraFrame['eyes'][number]) => ({ fov: e.fov, rect: e.rect, render: e.render });
  const eyes = [picked.left, picked.right].filter((e) => e !== null).map(geometry);
  return { n: f.n, width: f.width, height: f.height, left: picked.left?.data ?? null, right: picked.right?.data ?? null, eyes };
}

/** D7.5.1: what the `capture:` lines say about a layer camera capture: `from the VR layer camera, 1440x1440 (sbs)`; D8.1: `(mono)` for one eye. */
export const cameraWords = (c: Pick<PanelCapture, 'out' | 'stereo'>): string => `from the VR layer camera, ${c.out.width}x${c.out.height} (${c.stereo === 'mono' ? 'mono' : 'sbs'})`;

/** D7.4.3: the declared stereo for the log. */
export const stereoWords = (s: VrStereo | null | undefined): string =>
  s === 'sbs' ? 'both eyes side by side' : s === 'mono' ? 'one picture' : 'stereo not known (the others guess from its shape)';

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
  /**
   * D7.4.8 (2026-11-02): Windows turns the display off after its idle time while a player is in the headset (VR
   * controllers are not desktop input), and the screen capture then delivers nothing: Krobs' rig sent 0–1 frames per
   * 10 s for whole balls late in the night after 21 fps earlier. The display is kept awake while attached.
   */
  let displayHold: number | null = null;
  const holdDisplay = (): void => {
    if (displayHold !== null) return;
    try {
      displayHold = powerSaveBlocker.start('prevent-display-sleep');
      log.info('media: keeping the display awake while attached (the screen capture needs a lit desktop)');
    } catch (e) {
      log.warn(`media: could not keep the display awake: ${(e as Error).message}`);
    }
  };
  const releaseDisplay = (): void => {
    if (displayHold === null) return;
    try {
      powerSaveBlocker.stop(displayHold);
    } catch {
      /* already gone */
    }
    displayHold = null;
  };
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
  /** D7.4.3: the Match tab's preview setting (`setPreviewStereo`). */
  let previewSetting: PreviewStereoSetting = 'auto';
  /** D2.8: the table-sound flags the match host gave (replayed to a new page), and the pid of the window being sent. */
  let tableFlags: TableAudioFlags | null = null;
  let capturePidNow: number | null = null;
  /** D10.6: the title words the capture pick matched (`PLAYER_TITLE`, or the fallback window's own title). */
  let captureTitleNow: string | null = null;
  /** D2.10: the volumes the match host gave (replayed to a new page without the note). */
  let volume: { voice: number; table: number } | null = null;
  /** D10.5: the native video's footer line (`setVideoLine`); null = none shown. */
  let videoLine: string | null = null;

  /** D2.6: where the desktop panel went at its last `showPanel` (the Match tab says so). */
  let panelSide: PanelSide = 'edge';
  /** D7.4.4: one log line per stall episode, and the re-pick throttle. */
  let stallLogged = false;
  let lastRepickAt = 0;
  /** D7.4.10: the fit warning, logged once per wording. */
  let fitWarned: string | null = null;
  // ---- D7.5.1: the layer camera ----
  let cameraLayer: VrOverlay | null = null;
  let cameraSetting: CameraSourceSetting = 'screen';
  /** D7.5.9: the box's shape (`window` here until the match host says, so a bare RtcHost asks as 0.2.34 did). */
  let cameraView: CameraViewSetting = 'window';
  /** D8.1: one eye (the default, as the setting's) or both; the match host says at start and on every change. */
  let cameraEyes: CameraEyesSetting = 'one';
  /** D8.1: the box's height per eye: the one knob a quality preset (D8.2) will turn; the request path reads only this. */
  const cameraEyeHeight = LAYER_CAMERA_EYE_HEIGHT;
  /** D10.3: the native video hook (`setNativeVideo`); null = the 0.2.36 path. */
  let native: NativeVideoHook | null = null;
  /** D8.1: the request for the settings in force (view, eyes, height): the match camera, the bench and the frames saver all ask with it. D10.3: with the send ring while the native video is on. */
  const cameraRequest = (): LayerCameraRequest => {
    const req = cameraRequestFor({ view: cameraView, eye: cameraEyeFor(cameraEyes), eyeHeight: cameraEyeHeight });
    if (native) req.ring = native.ring;
    return req;
  };
  const boxOf = (req: LayerCameraRequest): { width: number; height: number; fps: number } => ({ width: req.width, height: req.height, fps: req.fps });
  /** D8.1: what a camera capture declares for the eyes setting: one eye is a flat picture, both are side by side. */
  const cameraStereo = (): VrStereo => (cameraEyeFor(cameraEyes) ? 'mono' : 'sbs');
  let vrRuntime: CameraDecisionInput['runtime'] = null;
  /** The camera feeding this attach (null: the screen capture path, as before D7.5.1). */
  type CameraRun = { gen: number; askedAt: number; connectedAt: number | null; off: Array<() => void>; timer: ReturnType<typeof setInterval>; lastPostAt: number };
  let cam: CameraRun | null = null;
  const camSlot = createFrameSlot<PanelCameraFrame>();
  /** Why the camera was given up in this match (never asked again within it, unless the Match tab says layer again). */
  let cameraGaveUp: string | null = null;
  /** A Camera change made during this rig's ball: applied when the ball ends. */
  let cameraSwitchPending = false;
  /** D7.6.3: the save under way, if any. */
  let saving: FrameSaver | null = null;
  // ---- D7.6: the VR test bench ----
  type BenchRun = { cfg: RtcBenchStart; timer: ReturnType<typeof setInterval> | null; off: Array<() => void>; startedAt: number; lastIdx: number; n: number; report: BenchPageReport | null; loggedAt: number };
  let benchRun: BenchRun | null = null;
  /** The bench page was given the bench (the bench's `attachSent`). */
  let benchSent = false;
  const benchSlot = createFrameSlot<PanelBenchFrame>();
  const benchListeners = new Set<(s: RtcBenchStatus | null) => void>();
  const panelWindow = (): { visible: boolean; side: PanelSide } | null =>
    !headset && win && !win.isDestroyed() ? { visible: win.isVisible(), side: panelSide } : null;
  const status = (): MediaStatus =>
    mergeStatus(page, { attached, sending, captureLabel: capture?.label ?? null, captureCrop: capture?.crop ?? null, captureStereo: capture ? (capture.stereo ?? null) : undefined, captureWarning: capture?.warning ?? null, error: panelError ?? captureError, panelWindow: panelWindow() });
  const emitStatus = (): void => {
    syncNativeWindow();
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
    PANEL_CHANNELS.tableAudio,
    PANEL_CHANNELS.volume,
  ]);
  const toPage = (channel: string, payload?: unknown): void => {
    if (win && ready && (attachSent || benchSent)) return post(channel, payload);
    if (LATEST.has(channel)) queue = queue.filter(([c]) => c !== channel);
    queue.push([channel, payload]);
  };
  /** The page gets `attach` first, then everything said before it was ready, in order. */
  const flush = (): void => {
    if (!win || !ready) return;
    // D7.6: a bench page gets the bench instead of an attach.
    if (benchRun) {
      if (!benchSent) {
        post(PANEL_CHANNELS.bench, { path: benchRun.cfg.path, source: benchRun.cfg.source, bitrate: benchRun.cfg.bitrate ?? null } satisfies PanelBench);
        benchSent = true;
      }
    } else if (!attachMsg) return;
    else if (!attachSent) {
      post(PANEL_CHANNELS.attach, attachMsg);
      attachSent = true;
    }
    const q = queue;
    queue = [];
    for (const [c, p] of q) post(c, p);
  };

  /**
   * D10.3: what the page is told about sending: this rig is up, unless the native helper carries the picture (the
   * layer camera feeds its ring, or, D10.6, the helper captures the picked VPX window itself): then the page's video
   * track stays disabled and the helper's sender runs instead.
   */
  const pageSending = (): boolean => sending && !(native !== null && (cam !== null || nativeWindowTold !== null));
  /** D10.6: the window the hook was last given (null: none); only a change is said. */
  let nativeWindowTold: NativeVideoWindow | null = null;
  /** The VPX window the helper should capture now: the screen capture's pick (never the layer camera's), while attached. */
  const wantNativeWindow = (): NativeVideoWindow | null => {
    if (!native?.onWindow || !attached || cam || !capture || !captureSrc || capturePidNow === null || captureTitleNow === null) return null;
    return { pid: capturePidNow, title: captureTitleNow, width: capture.out.width, height: capture.out.height, fps: PANEL_VIDEO.fps };
  };
  function syncNativeWindow(): void {
    const want = wantNativeWindow();
    if (JSON.stringify(want) === JSON.stringify(nativeWindowTold)) return;
    nativeWindowTold = want;
    log.info(want ? `media: native video: the helper captures "${want.title}" (pid ${want.pid}) into a ${want.width}x${want.height} box at ${want.fps} fps; the panel's video track is held back` : 'media: native video: no VPX window for the helper to capture');
    native?.onWindow?.(want);
    syncPageSending();
  }
  /**
   * The page's `sending` follows the turn and the native path; said only when it changes (queued latest-wins before
   * the page is up, as 0.2.36 did). Before the attach message exists it is that message's field; nothing is posted.
   */
  let pageSendingTold: boolean | null = null;
  const syncPageSending = (): void => {
    if (!attached || !attachMsg) return;
    const on = pageSending();
    if (!attachSent) attachMsg.sending = on;
    if (pageSendingTold === on) return;
    pageSendingTold = on;
    toPage(PANEL_CHANNELS.sending, on);
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
  // D2.9: the page's own lines (ICE restarts and their outcome, the candidate pair: types and protocol, no address).
  ipcMain.on(PANEL_CHANNELS.log, (e, line: unknown) => {
    const l = fromPanel(e) ? panelLogLine(line) : null;
    if (l) log.info(l);
  });
  ipcMain.on(PANEL_CHANNELS.status, (e, s: PanelPageStatus) => {
    if (!fromPanel(e)) return;
    if (page?.error !== s.error && s.error) log.warn(`media: panel: ${s.error}`);
    for (const line of peerChanges(page?.peers, s.peers ?? {})) log.info(line);
    const ended = page?.capturing === true && !s.capturing;
    // D7.4.4: counters, said once per report of theirs (the page repeats the last one in every report).
    if (s.stats && s.stats.seq !== page?.stats?.seq) {
      const st = s.stats;
      if (st.capture !== null) {
        const o = st.sent;
        // D8.3: the codec and encoder ("H264 via MediaFoundationVideoEncodeAccelerator") once the page's stats name them.
        const enc = o?.codec ? `, ${o.codec}${o.encoder ? ` via ${o.encoder}` : ''}` : '';
        const out = o && o.width > 0 ? `, sent ${o.width}x${o.height}${o.kbps !== null ? ` at ${(o.kbps / 1000).toFixed(1)} Mbps` : ''}, limited by ${o.limit}${enc}` : '';
        // D7.5.1: where the picture comes from, when it is the layer camera (the screen capture's line is unchanged).
        const from = capture && isCameraCapture(capture) ? ` ${cameraWords(capture)}${st.camera?.unreadable ? `, ${st.camera.unreadable} unreadable` : ''}${cameraDropped(true)}` : '';
        log.info(`media: capture: ${st.capture} frames in 10 s${from}${out}`);
      }
      if (st.decoded !== null) {
        const d = st.decodedSize;
        log.info(`media: theater: ${st.decoded} frames decoded${d ? ` at ${d.width}x${d.height}` : ''}, ${st.toLayer ?? 0} sent to the layer in 10 s`);
      }
      if ((st.capture ?? 0) > 0) stallLogged = false;
    }
    page = s;
    if (s.captureStalled === true && capture && attached) stalledCapture(generation);
    // D7.5.1: the canvas track of a camera capture ended: nothing left to draw on; back to the screen.
    if (ended && cam && attached) cameraBack(generation, 'the panel lost its video track');
    // The page's capture track ended (the table closed, VPX restarted): look for the window again (D2, 2026-10-31).
    else if (ended && capture && attached) {
      log.info(`media: the capture of ${capture.label} ended; looking for the VPX window again`);
      dropCapture(false);
      scheduleCapture(generation);
    }
    emitStatus();
  });
  /**
   * D7.4.4 (2026-11-01): the page's capture delivered no new frame for 3 s while this rig was sending (the screen
   * capture of the player window stalls once VPX has focus under Virtual Desktop). Logged once per episode; the
   * capture is picked again and handed to the page afresh (`restart`: same screen, a new stream), at most every
   * `REPICK_MIN_MS`. The page has already taken its track off the connections.
   */
  function stalledCapture(gen: number): void {
    // D7.5.1: a stalled layer camera goes through the camera's fallback, not a re-pick.
    if (cam) {
      log.info('media: capture stalled (no new frame from the VR layer camera for 3 s)');
      cameraBack(gen, 'the layer camera stalled (no new frame on the panel for 3 s)');
      return;
    }
    if (!stallLogged) {
      stallLogged = true;
      log.info(`media: capture stalled (no new frame for 3 s); re-picking${capture?.warning ? ` (${capture.warning})` : ''}`);
    }
    const now = Date.now();
    if (now - lastRepickAt < REPICK_MIN_MS) return;
    lastRepickAt = now;
    void repick(gen);
  }
  async function repick(gen: number): Promise<void> {
    await pickCapture(gen);
    if (gen !== generation || !attached) return;
    // A failed pick leaves the old capture in place with `captureError` set: the window is gone.
    if (capture && !captureError) {
      announced = capture;
      toPage(PANEL_CHANNELS.capture, { ...capture, restart: true });
    } else {
      dropCapture(true);
      scheduleCapture(gen);
    }
    emitStatus();
  }
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
  // D7.5.1: the page drew the camera frame in flight; the newest waiting one goes now.
  ipcMain.on(PANEL_CHANNELS.cameraAck, (e) => {
    if (!fromPanel(e)) return;
    const next = camSlot.ack(Date.now());
    if (next && cam) postCameraFrame(cam, next);
  });
  // D7.6: the page drew the bench frame in flight; the newest waiting one goes now. Its readout every second.
  ipcMain.on(PANEL_CHANNELS.benchAck, (e) => {
    if (!fromPanel(e) || !benchRun) return;
    const next = benchSlot.ack(Date.now());
    if (next) postBench(next);
  });
  ipcMain.on(PANEL_CHANNELS.benchStatus, (e, m: unknown) => {
    const run = benchRun;
    if (!fromPanel(e) || !run) return;
    run.report = benchReportFrom(m);
    const s = benchStatusNow();
    const now = Date.now();
    if (s && now - run.loggedAt >= BENCH_LOG_MS) {
      run.loggedAt = now;
      log.info(`media: bench: ${s.readout}`);
    }
    emitBench();
  });
  // D7.6.3: a theater frame the page saved, while a save runs.
  ipcMain.on(PANEL_CHANNELS.savedFrame, (e, m: unknown) => {
    if (!fromPanel(e) || !saving) return;
    const f = receivedFrameFrom(m);
    if (f) saving.receiverFrame(f);
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

  /**
   * D2.6 (2026-11-01): beside the main window (right, else left, else below), on its display's work area; the
   * display's right edge when there is no main window. Run at creation and at every `showPanel`.
   */
  const placeDesktopPanel = (w: BrowserWindow): void => {
    try {
      const main = opts.mainBounds?.() ?? null;
      const display = main ? screen.getDisplayMatching(main) : screen.getPrimaryDisplay();
      const size = w.getBounds();
      const p = placePanel(main, { width: size.width, height: size.height }, display.workArea);
      panelSide = p.side;
      w.setPosition(Math.round(p.x), Math.round(p.y));
    } catch (e) {
      log.warn(`media: could not place the match panel (${errText(e)}); it opens where the system puts it`);
    }
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
      // D2.6: the Match tab says whether the panel is up.
      w.on('show', () => emitStatus());
      w.on('hide', () => emitStatus());
      placeDesktopPanel(w);
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
    // D7.4.3: what the picture is, declared to the peers (the ini is read only for a VR rig on `auto`).
    const ini = inVr && previewSetting === 'auto' && opts.iniStereo ? await opts.iniStereo().catch(() => null) : null;
    const stereo = declaredStereo(previewSetting, inVr, ini);
    // D7.4.10: the fit warning only when there is one (the capture object reaches the page and the tests as is).
    const warning = fitWarning(target.fit, target.screen);
    return { capture: { sourceId: src.id, label: captureLabel(pick, target), screen: target.screen, crop: target.crop, out: target.out, stereo, ...(warning ? { warning } : {}) }, src, pick };
  };

  /** Finds the window to send and its capturer source; never throws. A newer attach or detach discards the result. */
  const pickCapture = (gen: number): Promise<void> => {
    if (picking?.gen === gen) return picking.done;
    const done = (async () => {
      try {
        const r = await resolveCapture();
        // D7.5.1: the layer camera took over meanwhile: this pick is not wanted.
        if (gen !== generation || cam) return;
        if ('error' in r) {
          setCaptureError(r.error);
          return;
        }
        captureSrc = r.src;
        capture = r.capture;
        capturePidNow = r.pick.window.pid;
        captureTitleNow = r.pick.fallback ? r.pick.window.title : PLAYER_TITLE;
        captureError = null;
        if (r.pick.fallback) log.warn(`media: no "${PLAYER_TITLE}" window; sending the largest VPX window instead: ${capture.label}`);
        if (capture.warning && capture.warning !== fitWarned) {
          fitWarned = capture.warning;
          log.warn(`media: ${capture.warning}`);
        }
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
    capturePidNow = null;
    captureTitleNow = null;
    captureSrc = null;
    announced = null;
    stopLive();
    if (tellPage) toPage(PANEL_CHANNELS.capture, null);
  }
  function scheduleRecrop(gen: number): void {
    // D7.5.1: the layer camera has no window to re-crop.
    if (recropTimer || gen !== generation || !attached || !capture || cam) return;
    recropTimer = setTimeout(() => {
      recropTimer = null;
      void recrop(gen);
    }, RECROP_MS);
  }
  /** One re-probe of a live capture: same crop → nothing; moved or resized → the page re-crops; gone → dropped. */
  const recrop = async (gen: number): Promise<void> => {
    if (gen !== generation || !attached || !capture || cam) return;
    let r: Resolved;
    try {
      r = await resolveCapture();
    } catch {
      // A probe that failed says nothing about the window: keep sending, look again next time.
      scheduleRecrop(gen);
      return;
    }
    const cur = capture;
    if (gen !== generation || !attached || !cur || cam) return;
    if ('error' in r) {
      log.info(`media: stopped sending ${cur.label}: ${r.error}`);
      dropCapture(true);
      setCaptureError(r.error);
      scheduleCapture(gen);
      emitStatus();
      return;
    }
    const moved = r.capture.sourceId !== cur.sourceId || !sameCrop(r.capture.crop, cur.crop) || r.capture.label !== cur.label;
    const restereo = (r.capture.stereo ?? null) !== (cur.stereo ?? null);
    if (moved || restereo) {
      // Logged once per change: an unchanged window says nothing.
      const c = r.capture.crop;
      if (moved) log.info(`media: the VPX window moved or resized: ${r.capture.label} at ${c.x},${c.y}`);
      if (restereo) log.info(`media: the match video is ${stereoWords(r.capture.stereo)} now (${previewSetting === 'auto' ? "VPX's VR preview setting" : 'the Match tab'})`);
      captureSrc = r.src;
      capture = r.capture;
      capturePidNow = r.pick.window.pid;
      captureTitleNow = r.pick.fallback ? r.pick.window.title : PLAYER_TITLE;
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
  const sendingLine = (c: PanelCapture): string =>
    `media: sending ${c.out.width}x${c.out.height} ${c.stereo === 'sbs' ? 'sbs' : 'mono'} at ${(videoBitrateFor({ ...c.out, stereo: c.stereo }) / 1e6).toFixed(1)} Mbps`;
  const announceCapture = (gen: number): void => {
    if (gen !== generation || !attached || !capture || capture === announced) return;
    announced = capture;
    log.info(`media: capture ${capture.label} ready, ${stereoWords(capture.stereo)}`);
    log.info(sendingLine(capture));
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

  // ---- D7.5.1: the layer camera (alpha-match.md §5a) ----
  const cameraUsable = (l: VrOverlay | null): l is VrOverlay & Required<Pick<VrOverlay, 'setCamera' | 'onCameraFrame' | 'cameraStatus' | 'onCameraStatus'>> =>
    !!l && !!l.setCamera && !!l.onCameraFrame && !!l.cameraStatus && !!l.onCameraStatus;
  /**
   * D8.1: what the `media: camera:` lines say was asked: `one eye (left), its whole render in a 1440x1440 box at 30 fps`
   * or `both eyes, each eye's whole render in a 1440x1440 box at 30 fps` (`in a 720x1440 box` for the window view).
   */
  const cameraAskWords = (req: ReturnType<typeof cameraRequest>): string =>
    `${cameraEyesWords(req)}, ${req.eye ? 'its' : "each eye's"}${req.whole ? ' whole render' : ' view'} in a ${req.width}x${req.height} box at ${req.fps} fps`;
  /**
   * The source for this attach: null with the setting on `screen` (nothing said: the 0.2.32 path), else the decision,
   * logged. The screen whenever the layer cannot be the camera, or already failed in this match.
   */
  const chooseCamera = (): CameraDecision | null => {
    if (cameraSetting !== 'layer') return null;
    let d: CameraDecision;
    if (cameraGaveUp) d = { source: 'screen', reason: `the layer camera failed earlier in this match: ${cameraGaveUp}` };
    else if (!cameraUsable(cameraLayer)) d = { source: 'screen', reason: 'there is no OpenXR layer camera in this build' };
    else d = decideCamera({ setting: cameraSetting, rig: inVr ? 'vr_headset' : 'pc', runtime: vrRuntime, layerProtocol: cameraLayer.layerProtocol?.() ?? null });
    if (d.source === 'screen') log.info(`media: camera: the screen capture (${d.reason})`);
    return d;
  };
  const cameraDropped = (take: boolean): string => {
    const n = take ? camSlot.takeDropped() : 0;
    return n ? `, ${n} dropped before the panel (newest wins)` : '';
  };
  const postCameraFrame = (c: CameraRun, f: PanelCameraFrame): void => {
    c.lastPostAt = Date.now();
    // Structured clone, no JSON: the two views share the frame's one buffer, which is copied once.
    post(PANEL_CHANNELS.cameraFrame, f);
  };
  /** The camera's size changed (or its first frame came): the capture main holds follows, logged once per change. */
  const cameraSize = (width: number, height: number): void => {
    if (!capture || !isCameraCapture(capture)) return;
    // D8.1: the capture keeps its declaration (mono for one eye, sbs for both); only the box follows the frame.
    const stereo: VrStereo = capture.stereo === 'mono' ? 'mono' : 'sbs';
    if (capture.out.width === width * (stereo === 'mono' ? 1 : 2) && capture.out.height === height) return;
    capture = cameraCapture(width, height, stereo);
    announced = capture;
    log.info(`media: capture: ${cameraWords(capture)}`);
    log.info(sendingLine(capture));
    emitStatus();
  };
  const cameraFrame = (c: CameraRun, f: LayerCameraFrame): void => {
    if (cam !== c || !attached) return;
    // D8.1: one eye wanted: that eye only goes to the page (a two-eye frame from an older layer loses the other here).
    const pf = cameraPageFrame(f, cameraEyeFor(cameraEyes));
    if (!pf) return;
    cameraSize(f.width, f.height);
    if (!ready || !attachSent) return;
    const now = Date.now();
    // Another player is up: the track is disabled, one frame a second keeps the canvas (and the self view) fresh.
    if (!sending && now - c.lastPostAt < CAMERA_IDLE_FRAME_MS) return;
    const out = camSlot.offer(pf, now);
    if (out) postCameraFrame(c, out);
  };
  const checkCamera = (c: CameraRun): void => {
    if (cam !== c || !cameraUsable(cameraLayer)) return;
    const now = Date.now();
    const layerProtocol = cameraLayer.layerProtocol?.() ?? null;
    if (layerProtocol !== null && c.connectedAt === null) c.connectedAt = now;
    // D10.3: asked with a ring, the layer sends no JPEG frame on the pipe: only its own answers count.
    const w = cameraWatch({ status: cameraLayer.cameraStatus(), now, askedAt: c.askedAt, connectedAt: c.connectedAt, sending, layerProtocol, overlay: cameraLayer.status(), ring: native !== null });
    if (w.fallBack) cameraBack(c.gen, w.reason ?? 'no reason given');
  };
  /** Ask the layer and hold the synthetic capture; the screen capture is not opened. The pid is probed for table sound. */
  const startCamera = (gen: number, reason: string): void => {
    if (!cameraUsable(cameraLayer)) return;
    const layer = cameraLayer;
    const req = cameraRequest();
    log.info(`media: camera: the VR layer (${reason}): ${cameraAskWords(req)}; no screen capture`);
    camSlot.reset();
    const run: CameraRun = { gen, askedAt: Date.now(), connectedAt: null, off: [], timer: setInterval(() => checkCamera(run), CAMERA_WATCH_MS), lastPostAt: 0 };
    cam = run;
    run.off.push(layer.onCameraFrame((f) => cameraFrame(run, f)));
    run.off.push(layer.onCameraStatus(() => checkCamera(run)));
    captureSrc = null;
    captureError = null;
    capture = cameraCapture(req.width, req.height, cameraStereo());
    layer.setCamera(req);
    // D10.3: the helper reads this box from the send ring; the page's video track is held back meanwhile.
    native?.onSource(boxOf(req));
    syncPageSending();
    void (async () => {
      try {
        const probe = await opts.probe();
        if (cam !== run) return;
        capturePidNow = pickCaptureWindow(probe.windows, inVr)?.window.pid ?? null;
      } catch {
        /* table sound falls back to the witness's pid */
      }
    })();
  };
  /** Stop asking; frames still on their way are ignored. */
  const stopCamera = (): void => {
    const run = cam;
    if (!run) return;
    cam = null;
    clearInterval(run.timer);
    for (const off of run.off) off();
    camSlot.reset();
    cameraLayer?.setCamera?.(null);
    // D10.3: nothing fills the send ring now; the page's video track (if any capture follows) is this rig's again.
    native?.onSource(null);
    syncPageSending();
  };
  /** D7.5.1: give the layer up for this match and pick the screen capture as today (`pickCapture`). */
  function cameraBack(gen: number, reason: string): void {
    if (!cam || gen !== generation || !attached) return;
    log.info(`media: camera: back to the screen capture: ${reason}`);
    cameraGaveUp = reason;
    stopCamera();
    capture = null;
    announced = null;
    captureSrc = null;
    void pickCapture(gen).then(() => {
      if (gen !== generation || !attached || cam) return;
      if (capture) announceCapture(gen);
      else {
        toPage(PANEL_CHANNELS.capture, null);
        scheduleCapture(gen);
      }
      emitStatus();
    });
    emitStatus();
  }
  /** D7.5.1: a Camera change while attached, between balls: to the screen at once; to the layer if it can be. */
  const switchCamera = (gen: number): void => {
    cameraSwitchPending = false;
    if (gen !== generation || !attached) return;
    if (cameraSetting === 'screen') {
      if (cam) cameraBack(gen, 'the Match tab says screen capture');
      return;
    }
    if (cam) return;
    cameraGaveUp = null; // the player asked for it again
    const d = chooseCamera();
    if (!d || d.source !== 'layer') return;
    stopLive();
    stopCaptureTimer();
    startCamera(gen, d.reason);
    if (!capture) return;
    announced = capture;
    log.info(`media: capture ${capture.label} ready, ${stereoWords(capture.stereo)}`);
    log.info(sendingLine(capture));
    toPage(PANEL_CHANNELS.capture, capture);
    emitStatus();
  };

  // ---- D7.6: the VR test bench ----
  const benchStatusNow = (): RtcBenchStatus | null => {
    const r = benchRun;
    if (!r) return null;
    const cs = r.cfg.source === 'live' && cameraUsable(cameraLayer) ? cameraLayer.cameraStatus() : null;
    const camera = cs ? { state: cs.state, why: cs.why } : null;
    return { source: r.cfg.source, path: r.cfg.path, headset, report: r.report, camera, readout: benchReadout({ report: r.report, headset, path: r.cfg.path, source: r.cfg.source, camera }) };
  };
  const emitBench = (): void => {
    const s = benchStatusNow();
    for (const l of [...benchListeners]) l(s);
  };
  const postBench = (f: PanelBenchFrame): void => {
    if (win && !win.isDestroyed() && ready && benchSent) post(PANEL_CHANNELS.benchFrame, f);
  };
  const offerBench = (f: PanelBenchFrame): void => {
    if (!ready || !benchSent) return;
    const out = benchSlot.offer(f, Date.now());
    if (out) postBench(out);
  };
  /** D8.1: a camera page frame as a bench frame: two eyes side by side, or the one eye (whichever it is) as a mono picture. */
  const benchFrameOf = (pf: PanelCameraFrame): PanelBenchFrame => {
    const both = !!pf.left && !!pf.right;
    return { n: pf.n, width: pf.width, height: pf.height, left: (pf.left ?? pf.right)!, right: both ? pf.right : null, stereo: both ? 'sbs' : 'mono', eyes: both ? pf.eyes : null };
  };
  /** One saved frame read from the clip folder (null when a file went missing: that frame is skipped). */
  const clipFrame = (run: BenchRun, i: number): PanelBenchFrame | null => {
    const p = run.cfg.clip?.frames[i];
    const dir = run.cfg.clipDir;
    if (!p || !dir) return null;
    try {
      const left = readFileSync(join(dir, p.left));
      const right = p.right ? readFileSync(join(dir, p.right)) : null;
      return { n: run.n++, width: p.width, height: p.height, left, right, stereo: p.stereo, eyes: p.eyes };
    } catch {
      return null;
    }
  };
  /** The bench's feed ends (its timer, the camera); the page goes with the window (`detach`). */
  const endBenchRun = (): void => {
    const run = benchRun;
    if (!run) return;
    benchRun = null;
    benchSent = false;
    if (run.timer) clearInterval(run.timer);
    for (const off of run.off) off();
    if (run.cfg.source === 'live') cameraLayer?.setCamera?.(null);
    benchSlot.reset();
    emitBench();
  };
  const startBench = async (o: RtcBenchStart): Promise<void> => {
    if (attached) throw new Error('A match is on: the VR test bench runs only without a match');
    if (benchRun) throw new Error('The VR test bench is running already');
    if (o.source === 'clip' && (!o.clip || !o.clip.frames.length || !o.clipDir)) throw new Error('That saved clip has no frames to play');
    if (o.source === 'live' && !cameraUsable(cameraLayer)) throw new Error('There is no OpenXR layer camera in this build');
    if (win) await detach(true);
    generation++;
    inVr = o.inVr;
    wantHeadset = o.headsetPanel;
    headset = o.headsetPanel;
    const run: BenchRun = { cfg: o, timer: null, off: [], startedAt: Date.now(), lastIdx: -1, n: 0, report: null, loggedAt: Date.now() };
    benchRun = run;
    benchSent = false;
    benchSlot.reset();
    try {
      const file = join(opts.userData, PAGE_FILE);
      mkdirSync(opts.userData, { recursive: true });
      writeFileSync(file, panelPageHtml({ vr: headset }));
      win = createWindow(headset);
      const gen = generation;
      void win.loadFile(file).catch((e: unknown) => {
        if (gen === generation) setPanelError(`the bench panel did not load (${errText(e)})`);
      });
    } catch (e) {
      endBenchRun();
      throw new Error(`The bench panel could not open (${errText(e)})`, { cause: e });
    }
    if (!headset) {
      placeDesktopPanel(win);
      win.showInactive();
    }
    if (videoHub.wanted()) toPage(PANEL_CHANNELS.videoWant, true);
    if (o.source === 'live' && cameraUsable(cameraLayer)) {
      const req = cameraRequest();
      run.off.push(
        cameraLayer.onCameraFrame((f) => {
          // D8.1: the bench follows the eyes setting too: one eye plays as a mono frame (the flat screen), both as before.
          const pf = benchRun === run ? cameraPageFrame(f, cameraEyeFor(cameraEyes)) : null;
          if (pf) offerBench(benchFrameOf(pf));
        }),
      );
      cameraLayer.setCamera(req);
    } else if (o.clip) {
      const clip = o.clip;
      run.timer = setInterval(() => {
        if (benchRun !== run || !ready || !benchSent) return;
        const i = playbackIndex(clip.frames.length, run.startedAt, Date.now(), clip.fps);
        if (i === run.lastIdx) return;
        run.lastIdx = i;
        const f = clipFrame(run, i);
        if (f) offerBench(f);
      }, Math.max(10, Math.round(1000 / clip.fps / 2)));
    }
    const clipWords = o.clip && o.clipName ? { name: o.clipName, side: o.clip.side, frames: o.clip.frames.length, fps: o.clip.fps } : null;
    log.info(`media: bench: started: ${benchWords({ source: o.source, path: o.path, clip: clipWords, headset, bitrate: o.bitrate ?? null, view: o.source === 'live' ? cameraView : null })}`);
    emitBench();
  };

  const detach = async (quiet = false): Promise<void> => {
    generation++;
    endBenchRun();
    stopCamera();
    cameraSwitchPending = false;
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
    capturePidNow = null;
    captureTitleNow = null;
    captureSrc = null;
    announced = null;
    stopCaptureTimer();
    stopLive();
    releaseDisplay();
    page = null;
    sending = false;
    pageSendingTold = null;
    coverOffSaid = false;
    peers.clear();
    lastState = null;
    panelError = null;
    captureError = null;
    stallLogged = false;
    lastRepickAt = 0;
    if (was && !quiet) log.info('media: detached');
    emitStatus();
  };

  /** `restore`: what a re-attach (`setVr`) carries over, applied before the first await so newer calls win over it. */
  const attach = async (sig: MediaSignalling, initialPeers: MatchPlayerId[], restore: { state: PanelState | null; sending: boolean } | null = null): Promise<void> => {
    if (benchRun) log.info('media: bench: ended (a match attaches)');
    if (attached || win) await detach(restore !== null);
    const gen = ++generation;
    // D7.5.1: a new match may try the layer camera again; a re-attach within one (setVr) keeps what it learnt.
    if (restore === null) cameraGaveUp = null;
    attached = true;
    holdDisplay();
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
    if (tableFlags) toPage(PANEL_CHANNELS.tableAudio, tableFlags);
    if (volume) toPage(PANEL_CHANNELS.volume, { ...volume, note: null } satisfies PanelVolume);
    if (videoLine !== null) toPage(PANEL_CHANNELS.videoLine, videoLine);
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
    // D7.5.1: the layer camera, when this attach decides so; else the screen capture as before.
    const camera = chooseCamera();
    if (camera?.source === 'layer') startCamera(gen, camera.reason);
    else await pickCapture(gen);
    if (gen !== generation) return;
    const s = opts.settings.get();
    // D2.7 (2026-11-01): a re-attach (`setVr`) replaces a page whose connections still stand on the peers' side.
    attachMsg = { localId: sig.localId, peers: [...peers], ice: iceServers(s), capture, micDeviceId: s.micDeviceId, muted: s.muted, sending: pageSending(), reset: restore !== null };
    pageSendingTold = attachMsg.sending;
    log.info(`media: attach (${headset ? 'VR, offscreen panel' : inVr ? 'VR, desktop panel' : 'desktop panel'}),${attachMsg.peers.length} peer(s), ${describeIce(s)}, capture ${capture?.label ?? 'none'}`);
    if (capture) {
      announced = capture;
      log.info(`media: capture ${capture.label} ready, ${stereoWords(capture.stereo)}`);
    log.info(sendingLine(capture));
      captureLive(gen);
    } else scheduleCapture(gen);
    flush();
    emitStatus();
  };

  const setSending = (on: boolean): void => {
    if (sending === on) return;
    sending = on;
    syncPageSending();
    // D7.5.1: a Camera change made during this ball, now that it is over.
    if (!on && cameraSwitchPending) switchCamera(generation);
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
    frames: () => ((attached || benchRun) && headset ? hub.source : null),
    videoFrames: () => ((attached || benchRun) && headset ? videoHub.source : null),
    showPanel() {
      if (headset || !win || win.isDestroyed()) return;
      // D2.6: placed again each time, beside the main window as it is now (it may have moved since).
      placeDesktopPanel(win);
      // showInactive: focus stays with VPX, whose window takes the player's keys.
      win.showInactive();
      emitStatus();
    },
    hidePanel() {
      if (headset || !win || win.isDestroyed()) return;
      win.hide();
      emitStatus();
    },
    detach: () => detach(),
    async setVr(rig) {
      // The capture pick follows the rig at once (the next pick reads it); the window kind needs a re-attach.
      inVr = rig.inVr;
      wantHeadset = rig.headsetPanel;
      if (rig.runtime !== undefined) vrRuntime = rig.runtime;
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
      log.info(`media: moving the panel into the headset (offscreen window; ${keep.length} peer(s) reset and reconnect)`);
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
    setTableAudio(flags) {
      if (tableFlags && tableFlags.send === flags.send && tableFlags.hear === flags.hear) return;
      tableFlags = { send: flags.send, hear: flags.hear };
      if (attached) toPage(PANEL_CHANNELS.tableAudio, tableFlags);
    },
    pushTableAudio(pcm) {
      // Straight to a ready page, never queued: a frame that cannot go now is useless later (100 a second).
      if (!tableFlags?.send || !attached || !ready || !attachSent) return;
      post(PANEL_CHANNELS.tablePcm, pcm);
    },
    capturePid: () => (attached ? capturePidNow : null),
    setVolume(v) {
      const note = typeof v.note === 'string' && v.note ? v.note : null;
      if (volume && volume.voice === v.voice && volume.table === v.table && !note) return;
      volume = { voice: v.voice, table: v.table };
      if (attached) toPage(PANEL_CHANNELS.volume, { ...volume, note } satisfies PanelVolume);
    },
    // D10.5: the native video's one footer line (kept for the next attach, cleared by null).
    setVideoLine(line) {
      if (line === videoLine) return;
      videoLine = line;
      if (attached) toPage(PANEL_CHANNELS.videoLine, line);
    },
    startBench,
    async stopBench() {
      if (!benchRun) return;
      await detach(true);
      log.info('media: bench: stopped, the panel closed');
    },
    benchStatus: benchStatusNow,
    onBenchStatus(cb) {
      benchListeners.add(cb);
      return () => {
        benchListeners.delete(cb);
      };
    },
    async saveFrames(o) {
      if (saving) throw new Error('Frames are being saved already: wait for that save to finish');
      const notes: string[] = [];
      const camState = cameraUsable(cameraLayer) ? cameraLayer.cameraStatus().state : null;
      const camOn = camState === 'on' || camState === 'asked';
      const feeding = !!win && !win.isDestroyed() && ready && videoHub.wanted();
      const saver = createFrameSaver({
        dir: o.dir,
        folder: o.folder,
        settings: { ...o.settings, cameraRequest: cam || camOn ? cameraRequest() : null, cameraEyes, feedMax: VIDEO_FEED_MAX, previewStereo: previewSetting, cameraSetting, capture: capture ? { label: capture.label, out: capture.out, stereo: capture.stereo ?? null } : null },
      });
      saving = saver;
      const off = camOn && cameraUsable(cameraLayer) ? cameraLayer.onCameraFrame((f) => saver.senderFrame(f)) : null;
      if (!camOn) notes.push('sender: the layer camera is not running (Camera = VR layer in a match, or the VR test bench on "my own table, live")');
      if (feeding) post(PANEL_CHANNELS.saveFrames, { ms: FRAME_SAVE_MS, max: FRAME_SAVE_MAX });
      else notes.push('receiver: no theater feed is being handed to the layer (another player up in theater, or the VR test bench in the headset)');
      log.info(`media: frames: saving ${FRAME_SAVE_MS / 1000} s to ${o.dir} (layer camera ${camOn ? 'on' : 'not running'}, theater feed ${feeding ? 'on' : 'not running'})`);
      try {
        await new Promise((r) => setTimeout(r, FRAME_SAVE_MS + (feeding ? FRAME_SAVE_GRACE_MS : 100)));
      } finally {
        off?.();
        saving = null;
      }
      const index = await saver.finish(notes);
      const line = savedLine(o.dir, index);
      log.info(line);
      for (const n of index?.notes ?? notes) log.info(`media: frames: ${n}`);
      const c = saver.counts();
      return { dir: index ? o.dir : null, sender: c.sender, receiver: c.receiver, notes: index?.notes ?? notes, line };
    },
    setCameraLayer(layer) {
      cameraLayer = layer;
    },
    // D10.3: the native video on or off for the match; a running camera is asked again with (or without) the ring.
    setNativeVideo(hook) {
      if (hook === native || (hook && native && hook.ring === native.ring && hook.onSource === native.onSource)) return;
      const was = native;
      native = hook;
      log.info(`media: native video ${hook ? `on (send ring ${hook.ring})` : 'off (the Electron video path)'}`);
      // D10.6: the old hook loses the window it had; the new one hears the current pick (syncNativeWindow).
      if (was && was !== hook && nativeWindowTold) {
        was.onWindow?.(null);
        nativeWindowTold = null;
      }
      if (cam && attached && cameraUsable(cameraLayer)) {
        const req = cameraRequest();
        cameraLayer.setCamera(req);
        if (was && was !== hook) was.onSource(null);
        hook?.onSource(boxOf(req));
      } else if (was && was !== hook) was.onSource(null);
      syncNativeWindow();
      syncPageSending();
    },
    // D7.5.9: the view changes the box, live: the match camera (while asked) and the bench's camera are asked again.
    setCameraView(view) {
      if (view === cameraView) return;
      cameraView = view;
      if (!cameraUsable(cameraLayer)) return;
      const live = cam !== null || benchRun?.cfg.source === 'live';
      if (!live) return;
      const req = cameraRequest();
      log.info(`media: camera: ${cameraViewWords(req)} on the Match tab: ${cameraAskWords(req)}`);
      cameraLayer.setCamera(req);
      if (cam) native?.onSource(boxOf(req));
    },
    // D8.1: the eyes change the request and the capture's shape and declaration, live: the layer is asked again and a
    // running match capture is replaced (the page reopens its camera mode on the new capture; the canvas track stays).
    setCameraEyes(setting) {
      if (setting === cameraEyes) return;
      cameraEyes = setting;
      if (!cameraUsable(cameraLayer)) return;
      const live = cam !== null || benchRun?.cfg.source === 'live';
      if (!live) return;
      const req = cameraRequest();
      log.info(`media: camera: ${cameraEyesWords(req)} on the Match tab: ${cameraAskWords(req)}`);
      cameraLayer.setCamera(req);
      if (cam) native?.onSource(boxOf(req));
      if (!cam || !attached || !capture || !isCameraCapture(capture)) return;
      camSlot.reset();
      capture = cameraCapture(req.width, req.height, cameraStereo());
      announced = capture;
      log.info(`media: capture ${capture.label} ready, ${stereoWords(capture.stereo)}`);
      log.info(sendingLine(capture));
      toPage(PANEL_CHANNELS.capture, capture);
      emitStatus();
    },
    setCameraSource(setting) {
      if (setting === cameraSetting) return;
      cameraSetting = setting;
      if (!attached) return;
      if (sending) {
        cameraSwitchPending = true;
        log.info('media: camera: the change takes effect when this ball ends');
        return;
      }
      switchCamera(generation);
    },
    setPreviewStereo(setting) {
      if (setting === previewSetting) return;
      previewSetting = setting;
      // A live capture is looked at again now: a changed declaration reaches the page (and the peers) at once.
      if (attached && capture) void recrop(generation);
    },
  };
}
