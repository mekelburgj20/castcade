/**
 * D7.5 (2026-11-02): the layer camera's policy (vr-layer/README.md "The camera"; docs/design/alpha-match.md §5a): whether
 * a VR sender's picture comes from the Castcade OpenXR layer (its copy of the two eye views VPX submits) or from the
 * screen capture of VPX's preview window, what size and rate to ask the layer for, and when to give the layer up and
 * fall back. Pure: `rtc-host.ts` calls these and acts (D7.5.1, §5a): `decideCamera` at each attach, `cameraWatch` on a
 * 1 s tick and on every camera status, `createFrameSlot` for the frames it hands the panel page.
 *
 * Rules:
 *   - the layer is the default since D8.1 (`match.json` `cameraSource: 'layer'`; `screen` before); it is asked only
 *     when the setting says so, the rig is a headset on an OpenXR runtime that is not SteamVR (the layer is in VPX only there;
 *     on SteamVR the OpenVR helper draws and no layer loads) and the layer on the pipe speaks protocol 3 or more;
 *   - the request is a per-eye BOX, as tall as the receiver's side-by-side feed box allows (`LAYER_CAMERA_EYE_HEIGHT`,
 *     D7.4.9) and never taller than the eye render, at the match video's 30 fps. D7.5.9 (2026-11-04): its shape follows
 *     the Match tab's Camera view: `whole` (the default) is a square box with `whole: true`, each eye's whole render
 *     scaled into it, so the window's frame lands at the lens edges in the receiver's headset (the 0.2.34 finding: a
 *     1:2 crop's frame sat at infinity and doubled while the eyes converged on the table); `window` is the 0.2.34
 *     portrait 1:2 centre crop (the shape the runbook recommends for the preview window; VPX's own both-eyes preview
 *     centre-crops each eye the same way). A 1440x1440 eye makes a 2880x1440 side-by-side picture, inside the
 *     receiver's 3840x1440 feed box (panel-page.ts VIDEO_FEED_MAX);
 *   - fall back to the screen capture, and say why, when the layer refuses, when it stops the camera on its own, when
 *     nothing arrives within `LAYER_CAMERA_FALLBACK_MS` of asking, or when frames stop for `LAYER_CAMERA_STALL_MS`
 *     while sending (the capture watch's rule, D7.4.4). Never silently: every fallback is one log line and a status.
 *
 * D8.1 (2026-11-05, ADR 0009: spectating is 2D): the layer camera is the default on VR rigs (`cameraSource: 'layer'`)
 * and asks for ONE eye (`cameraEyes: 'one'`: the request's `eye`, the left one), sent as a flat picture; a one-eye
 * frame from the layer, or the asked eye out of a two-eye frame from a layer that predates `eye`. The two-eye path
 * (`cameraEyes: 'both'`, the stereo window) stays as shipped in 0.2.35. The rules above are unchanged.
 *
 * D10.3.7 (2026-11-07, the second 0.2.38 match): a changed request (a new box, eye, fps or ring) makes the layer stop
 * and restart the camera on its own: an `off` status whose `why` is `a new request` (`vr-layer/src/camera.cpp`), then
 * `on` a few ms later. That `off` is never the layer giving up (`LAYER_CAMERA_RESTART_WHY`), and any other stop falls
 * back only when no `on` follows within `LAYER_CAMERA_STOP_GRACE_MS` (the caller says when it first saw the stop,
 * `CameraWatchInput.stoppedSince`). The owner's rig fell back to the screen capture on its own re-ask with the ring,
 * 5 ms after the layer had logged `camera: on`, and sent the preview window for the whole match.
 */
import type { LayerCameraEyeSide, LayerCameraRequest, LayerCameraStatus } from './match-media-types.js';

export type CameraSourceSetting = 'screen' | 'layer';
export type CameraSource = 'screen' | 'layer';
/** D7.5.9: the Match tab's Camera view (match settings `cameraView`): each eye's whole render, or the 1:2 centre crop. */
export type CameraViewSetting = 'whole' | 'window';
/** D8.1: the Match tab's Camera eyes (match settings `cameraEyes`): one eye as a flat picture (the default), or both side by side. */
export type CameraEyesSetting = 'one' | 'both';

/** The receiver's side-by-side feed box is 1440 high (D7.4.9): a taller eye would be scaled down there anyway. */
export const LAYER_CAMERA_EYE_HEIGHT = 1440;
/** D8.1: the eye a one-eye camera sends. */
export const LAYER_CAMERA_DEFAULT_EYE: LayerCameraEyeSide = 'left';

/** D8.1: the request's `eye` for a Camera eyes setting: the left eye for `one`, none (both eyes) for `both`. */
export function cameraEyeFor(setting: CameraEyesSetting): LayerCameraEyeSide | null {
  return setting === 'one' ? LAYER_CAMERA_DEFAULT_EYE : null;
}
/** Portrait 1:2 per eye (720x1440 by default): the preview window's recommended shape, tall like pinball. */
export const LAYER_CAMERA_EYE_ASPECT = 0.5;
export const LAYER_CAMERA_FPS = 30;
/** Asked and nothing came: a layer that cannot answer (no projection layer yet, VPX not in VR, a stuck worker). */
export const LAYER_CAMERA_FALLBACK_MS = 8000;
/** Frames were flowing and stopped while sending: the capture watch's limit (panel-page.ts CAPTURE_STALL_MS). */
export const LAYER_CAMERA_STALL_MS = 3000;
/** The first protocol with the camera (vr-layer.ts VR_LAYER_CAMERA_PROTOCOL). */
export const LAYER_CAMERA_MIN_PROTOCOL = 3;
/**
 * D10.3.7: the `why` of the `off` the layer sends when it restarts the camera for a changed request
 * (`vr-layer/src/camera.cpp`: `I.stop("a new request", …)`, then `on`): the camera comes back by itself; never a fallback.
 */
export const LAYER_CAMERA_RESTART_WHY = 'a new request';
/** D10.3.7: a stop with any other reason falls back only when no `on` follows within this long. */
export const LAYER_CAMERA_STOP_GRACE_MS = 1000;

/**
 * D10.3.7: the layer stopped the camera on its own word while it was asked (`vr-layer.ts` keeps the state `asked`
 * with the layer's `why`; `off` with a `why` once nothing is asked): the reason, or null for any other state.
 */
export function cameraStopReason(s: Pick<LayerCameraStatus, 'state' | 'why'>): string | null {
  return (s.state === 'asked' || s.state === 'off') && s.why ? s.why : null;
}

export const LAYER_CAMERA_DEFAULT_REQUEST: LayerCameraRequest = { width: 720, height: 1440, fps: LAYER_CAMERA_FPS };

export interface CameraDecisionInput {
  setting: CameraSourceSetting;
  rig: 'pc' | 'vr_headset' | 'real_cabinet';
  /** The VR runtime behind the rig (`RigDecision.runtime`); null = unknown (a sample from before B22: SteamVR). */
  runtime: 'steamvr' | 'virtual-desktop' | 'oculus' | 'openxr-other' | null;
  /** The protocol of the layer on the pipe, or null while none is connected. */
  layerProtocol: number | null;
}

export interface CameraDecision {
  source: CameraSource;
  /** One clause for the log and the Match tab: why this source. */
  reason: string;
}

/** Which source a VR sender uses now. The screen capture whenever the layer cannot be the camera, with the reason. */
export function decideCamera(i: CameraDecisionInput): CameraDecision {
  if (i.setting !== 'layer') return { source: 'screen', reason: 'the Match tab says screen capture' };
  if (i.rig !== 'vr_headset') return { source: 'screen', reason: 'not a VR rig: there is no headset frame to read' };
  if (i.runtime === null || i.runtime === 'steamvr') return { source: 'screen', reason: 'a SteamVR rig: the OpenVR helper draws the panel and the OpenXR layer is not in VPX' };
  if (i.layerProtocol !== null && i.layerProtocol < LAYER_CAMERA_MIN_PROTOCOL) {
    return { source: 'screen', reason: `the layer in VPX speaks pipe protocol ${i.layerProtocol}, before the layer camera (restart VPX with the new layer)` };
  }
  return { source: 'layer', reason: i.layerProtocol === null ? 'the VR layer, once it is on the pipe' : 'the VR layer' };
}

/**
 * The box to ask for per eye: `eyeHeight` tall (default 1440) but never taller than the eye render when that is known
 * (the layer never scales up anyway; asking for less keeps the JPEG small), even sides, at 30 fps. The shape is the
 * view's (D7.5.9): `window` (the default here, so the 0.2.34 callers and tests read as before) a 1:2 portrait crop;
 * `whole` a square box with `whole: true`, each eye's whole render scaled into it (the layer fits the render's aspect
 * inside the box; a square wastes nothing on a 2064x2208 eye and keeps the side-by-side picture inside the feed box).
 * D8.1 (2026-11-05): `eye` asks for that one eye (the request carries it; a layer before 0.5.3 ignores it and sends
 * both). The box is the same per eye whatever the count: `eyeHeight` is the one knob a quality preset (D8.2) turns.
 */
export function cameraRequestFor(opts: { eyeHeight?: number; fps?: number; sourceEye?: { width: number; height: number } | null; view?: CameraViewSetting; eye?: LayerCameraEyeSide | null } = {}): LayerCameraRequest {
  let height = Math.max(2, Math.floor(opts.eyeHeight ?? LAYER_CAMERA_EYE_HEIGHT));
  if (opts.sourceEye && opts.sourceEye.height >= 2) height = Math.min(height, Math.floor(opts.sourceEye.height));
  height &= ~1;
  const whole = opts.view === 'whole';
  let width = whole ? height : Math.round(height * LAYER_CAMERA_EYE_ASPECT) & ~1;
  if (width < 2) width = 2;
  const fps = Math.min(60, Math.max(1, Math.round(opts.fps ?? LAYER_CAMERA_FPS)));
  const req: LayerCameraRequest = whole ? { width, height, fps, whole: true } : { width, height, fps };
  if (opts.eye === 'left' || opts.eye === 'right') req.eye = opts.eye;
  return req;
}

/** D7.5.9: the request's view in a word, for log lines ("whole view" / "window view"). */
export function cameraViewWords(req: Pick<LayerCameraRequest, 'whole'> | CameraViewSetting): string {
  const whole = typeof req === 'string' ? req === 'whole' : req.whole === true;
  return whole ? 'whole view' : 'window view';
}

/** D8.1: the request's eyes in words, for log lines: `one eye (left)` or `both eyes`. */
export function cameraEyesWords(req: Pick<LayerCameraRequest, 'eye'> | LayerCameraEyeSide | null | undefined): string {
  const eye = typeof req === 'string' ? req : req?.eye;
  return eye === 'left' || eye === 'right' ? `one eye (${eye})` : 'both eyes';
}

/**
 * D8.1: the eye(s) the page gets out of a layer frame, for the request's `eye`: both wanted → the frame's two eyes
 * (null when it has not got two); one wanted → that eye out of a two-eye frame (left is `eyes[0]`, right `eyes[1]`),
 * or the single entry of a one-eye frame (the layer sent what was asked; it cannot be told apart from the other eye, so
 * it is taken as asked). Null when the frame has neither.
 */
export function cameraFrameEyes<E>(eyes: readonly E[], eye: LayerCameraEyeSide | null): { left: E | null; right: E | null } | null {
  if (eye === null) {
    const [l, r] = eyes;
    return l && r && eyes.length === 2 ? { left: l, right: r } : null;
  }
  const one = eyes.length === 2 ? eyes[eye === 'left' ? 0 : 1] : eyes.length === 1 ? eyes[0] : undefined;
  if (!one) return null;
  return eye === 'left' ? { left: one, right: null } : { left: null, right: one };
}

export interface CameraFallback {
  fallBack: boolean;
  reason: string | null;
}

/**
 * Whether to give the layer up now and use the screen capture. `askedAt`: when the camera was asked (ms clock);
 * `sending`: this rig is the player up (a stall only counts then: while not sending, no frame is no fault).
 */
export function cameraFallback(s: LayerCameraStatus, now: number, askedAt: number | null, sending: boolean): CameraFallback {
  if (s.state === 'refused') return { fallBack: true, reason: `the layer refused the camera: ${s.why ?? 'no reason given'}` };
  // D10.3.7: the layer's own restart for a changed request is not a stop.
  if (s.state === 'off' && s.why && s.why !== LAYER_CAMERA_RESTART_WHY) return { fallBack: true, reason: `the layer stopped the camera: ${s.why}` };
  if (s.state === 'asked' && askedAt !== null && now - askedAt >= LAYER_CAMERA_FALLBACK_MS) {
    return { fallBack: true, reason: `no frame from the layer within ${LAYER_CAMERA_FALLBACK_MS / 1000} s of asking` };
  }
  if (s.state === 'on' && sending && s.lastFrameAt !== null && now - s.lastFrameAt >= LAYER_CAMERA_STALL_MS) {
    return { fallBack: true, reason: `the layer camera stalled (no frame for ${LAYER_CAMERA_STALL_MS / 1000} s)` };
  }
  return { fallBack: false, reason: null };
}

/**
 * D7.5.1 (2026-11-02): asked and the layer never came on the pipe at all (a layer that is missing, disabled, or older
 * than the hello, which never says anything): the screen capture after this long. Longer than the 8 s an answering
 * layer gets, because at host / join the overlay starts only after the panel has opened.
 */
export const LAYER_CAMERA_PIPE_WAIT_MS = 20_000;
/**
 * D10.3.10 (2026-11-13, the owner + Krobs on 0.2.40): the layer is on the pipe but VPX has rendered no VR frame yet
 * (the layer loads with VPX, seconds before a table finishes loading: Game of Thrones took 9.2 s and the 8 s clock gave
 * the camera up 150 ms before the first frame, for the whole match). While the layer has sent no session report on
 * this connection the camera waits this long, not `LAYER_CAMERA_FALLBACK_MS`; the 8 s run from the report.
 */
export const LAYER_CAMERA_SESSION_WAIT_MS = 120_000;

export interface CameraWatchInput {
  status: LayerCameraStatus;
  now: number;
  /** When this rig asked the layer for the camera (ms clock). */
  askedAt: number;
  /** When the layer on the pipe first said who it is during this ask (its protocol became known); null: not yet. */
  connectedAt: number | null;
  /** This rig is the player up. */
  sending: boolean;
  /** The protocol of the layer on the pipe now (`VrOverlay.layerProtocol`), null while none has spoken. */
  layerProtocol: number | null;
  /** The overlay's own state (`VrOverlay.status()`), when known. */
  overlay?: { state: string; reason: string | null } | null;
  /**
   * D10.3 (2026-11-07): the camera was asked with a frame ring (`LayerCameraRequest.ring`): the layer writes the eye
   * into shared memory for the video helper and sends no JPEG frame on the pipe, so "on but no frame" is no fault.
   * The layer's own answers (refused, stopped, protocol 2, pipe closed) still count.
   */
  ring?: boolean;
  /**
   * D10.3.7: when the caller first saw the stop `cameraStopReason(status)` names (ms clock): the fallback waits
   * `LAYER_CAMERA_STOP_GRACE_MS` from then for the layer's `on`. Absent: no grace (a stop falls back at once).
   */
  stoppedSince?: number;
  /**
   * D10.3.10: when the layer last sent a session report on this connection (`VrOverlay.sessionSeenAt`: VPX's first VR
   * frame, the earliest the camera can answer), null while none came. Absent (an overlay that cannot say): the clock
   * runs from the pipe as before.
   */
  sessionAt?: number | null;
}

/**
 * D7.5.1: the whole watch over an asked camera, run on a 1 s tick and on every camera status (alpha-match.md §5a item
 * 4): `cameraFallback` plus what only the pipe tells: a layer that turns out to speak protocol 2, an overlay that
 * cannot run, a pipe that never opened (`LAYER_CAMERA_PIPE_WAIT_MS`) or closed after it had (VPX exited or left VR), a
 * layer that stopped the camera on its own while still asked (`vr-layer.ts` then keeps the state `asked` with the
 * layer's `why`; D10.3.7: never for its own restart, `LAYER_CAMERA_RESTART_WHY`, and otherwise only once no `on`
 * followed within `LAYER_CAMERA_STOP_GRACE_MS` of `stoppedSince`), and a layer that said `on` and sent nothing. The 8 s
 * "no frame" clock runs from when the layer came on the pipe, not from the ask; D10.3.10: and not before the layer's
 * session report on this connection (`sessionAt`), with `LAYER_CAMERA_SESSION_WAIT_MS` for a VPX that never renders.
 */
export function cameraWatch(i: CameraWatchInput): CameraFallback {
  if (i.layerProtocol !== null && i.layerProtocol < LAYER_CAMERA_MIN_PROTOCOL) {
    return { fallBack: true, reason: `the layer in VPX speaks pipe protocol ${i.layerProtocol}, before the layer camera (restart VPX with the new layer)` };
  }
  if (i.overlay?.state === 'unavailable') return { fallBack: true, reason: `the OpenXR layer is not available (${i.overlay.reason ?? 'no reason given'})` };
  if (i.layerProtocol === null) {
    if (i.connectedAt !== null) return { fallBack: true, reason: 'the pipe to the layer closed (VPX exited or left VR)' };
    if (i.now - i.askedAt >= LAYER_CAMERA_PIPE_WAIT_MS) return { fallBack: true, reason: `the layer did not answer on the pipe within ${LAYER_CAMERA_PIPE_WAIT_MS / 1000} s` };
    return { fallBack: false, reason: null };
  }
  const piped = Math.max(i.askedAt, i.connectedAt ?? i.askedAt);
  // D10.3.10: no VR frame from VPX yet (the table is loading): nothing to time against but the long wait.
  if (i.sessionAt === null && i.status.state === 'asked' && cameraStopReason(i.status) === null) {
    if (i.now - piped >= LAYER_CAMERA_SESSION_WAIT_MS) {
      return { fallBack: true, reason: `VPX rendered no VR frame within ${LAYER_CAMERA_SESSION_WAIT_MS / 1000} s of the layer coming on the pipe` };
    }
    return { fallBack: false, reason: null };
  }
  const since = Math.max(piped, i.sessionAt ?? piped);
  const stop = cameraStopReason(i.status);
  if (stop !== null) {
    if (stop === LAYER_CAMERA_RESTART_WHY) return { fallBack: false, reason: null };
    if (i.stoppedSince !== undefined && i.now - i.stoppedSince < LAYER_CAMERA_STOP_GRACE_MS) return { fallBack: false, reason: null };
    return { fallBack: true, reason: `the layer stopped the camera: ${stop}` };
  }
  if (i.ring) {
    // The frames go to the ring, not the pipe: only the layer's own word counts (the two frame clocks below never run).
    return cameraFallback(i.status, i.now, since, false);
  }
  if (i.status.state === 'on' && i.status.frames === 0 && i.now - since >= LAYER_CAMERA_FALLBACK_MS) {
    return { fallBack: true, reason: `the layer said the camera is on but sent no frame within ${LAYER_CAMERA_FALLBACK_MS / 1000} s` };
  }
  return cameraFallback(i.status, i.now, since, i.sending);
}

/**
 * D7.5.1: main's side of the camera frames going to the panel page: one frame in flight (the page acks each one once it
 * has drawn it), the newest waiting, older ones dropped and counted. An ack lost for `lostAckMs` (a page that reloaded)
 * is given up and the next frame goes.
 */
export interface FrameSlot<T> {
  /** A new frame: the one to send now, or null (one is in flight; this one waits, replacing any that waited). */
  offer(frame: T, now: number): T | null;
  /** The page drew the frame in flight: the waiting one to send now, or null. */
  ack(now: number): T | null;
  /** Frames replaced before they could be sent, since the last call. */
  takeDropped(): number;
  reset(): void;
}

export function createFrameSlot<T>(lostAckMs = 1000): FrameSlot<T> {
  let inFlight = false;
  let sentAt = 0;
  let waiting: T | null = null;
  let dropped = 0;
  const send = (f: T, now: number): T => {
    inFlight = true;
    sentAt = now;
    return f;
  };
  return {
    offer(frame, now) {
      if (!inFlight || now - sentAt >= lostAckMs) {
        if (waiting !== null) dropped++;
        waiting = null;
        return send(frame, now);
      }
      if (waiting !== null) dropped++;
      waiting = frame;
      return null;
    },
    ack(now) {
      inFlight = false;
      if (waiting === null) return null;
      const f = waiting;
      waiting = null;
      return send(f, now);
    },
    takeDropped() {
      const d = dropped;
      dropped = 0;
      return d;
    },
    reset() {
      inFlight = false;
      sentAt = 0;
      waiting = null;
      dropped = 0;
    },
  };
}
