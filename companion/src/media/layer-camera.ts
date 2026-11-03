/**
 * D7.5 (2026-11-02): the layer camera's policy (vr-layer/README.md "The camera"; docs/design/alpha-match.md §5a): whether
 * a VR sender's picture comes from the Castcade OpenXR layer (its copy of the two eye views VPX submits) or from the
 * screen capture of VPX's preview window, what size and rate to ask the layer for, and when to give the layer up and
 * fall back. Pure: `rtc-host.ts` / `match-host.ts` call these and act (the lead wires that; §5a).
 *
 * Rules:
 *   - the screen capture is the default (`match.json` `cameraSource: 'screen'`); the layer is asked only when the
 *     player chose it, the rig is a headset on an OpenXR runtime that is not SteamVR (the layer is in VPX only there;
 *     on SteamVR the OpenVR helper draws and no layer loads) and the layer on the pipe speaks protocol 3 or more;
 *   - the request is a per-eye BOX, portrait 1:2 (the shape the runbook recommends for the preview window, and what
 *     the receiver's stereo window expects: VPX's own both-eyes preview centre-crops each eye the same way), as tall as
 *     the receiver's side-by-side feed box allows (`LAYER_CAMERA_EYE_HEIGHT`, D7.4.9) and never taller than the eye
 *     render, at the match video's 30 fps;
 *   - fall back to the screen capture, and say why, when the layer refuses, when it stops the camera on its own, when
 *     nothing arrives within `LAYER_CAMERA_FALLBACK_MS` of asking, or when frames stop for `LAYER_CAMERA_STALL_MS`
 *     while sending (the capture watch's rule, D7.4.4). Never silently: every fallback is one log line and a status.
 */
import type { LayerCameraRequest, LayerCameraStatus } from './match-media-types.js';

export type CameraSourceSetting = 'screen' | 'layer';
export type CameraSource = 'screen' | 'layer';

/** The receiver's side-by-side feed box is 1440 high (D7.4.9): a taller eye would be scaled down there anyway. */
export const LAYER_CAMERA_EYE_HEIGHT = 1440;
/** Portrait 1:2 per eye (720x1440 by default): the preview window's recommended shape, tall like pinball. */
export const LAYER_CAMERA_EYE_ASPECT = 0.5;
export const LAYER_CAMERA_FPS = 30;
/** Asked and nothing came: a layer that cannot answer (no projection layer yet, VPX not in VR, a stuck worker). */
export const LAYER_CAMERA_FALLBACK_MS = 8000;
/** Frames were flowing and stopped while sending: the capture watch's limit (panel-page.ts CAPTURE_STALL_MS). */
export const LAYER_CAMERA_STALL_MS = 3000;
/** The first protocol with the camera (vr-layer.ts VR_LAYER_CAMERA_PROTOCOL). */
export const LAYER_CAMERA_MIN_PROTOCOL = 3;

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
 * The box to ask for per eye: 1:2 portrait, `eyeHeight` tall (default 1440) but never taller than the eye render when
 * that is known (the layer never scales up anyway; asking for less keeps the JPEG small), even sides, at 30 fps.
 */
export function cameraRequestFor(opts: { eyeHeight?: number; fps?: number; sourceEye?: { width: number; height: number } | null } = {}): LayerCameraRequest {
  let height = Math.max(2, Math.floor(opts.eyeHeight ?? LAYER_CAMERA_EYE_HEIGHT));
  if (opts.sourceEye && opts.sourceEye.height >= 2) height = Math.min(height, Math.floor(opts.sourceEye.height));
  height &= ~1;
  let width = Math.round(height * LAYER_CAMERA_EYE_ASPECT) & ~1;
  if (width < 2) width = 2;
  const fps = Math.min(60, Math.max(1, Math.round(opts.fps ?? LAYER_CAMERA_FPS)));
  return { width, height, fps };
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
  if (s.state === 'off' && s.why) return { fallBack: true, reason: `the layer stopped the camera: ${s.why}` };
  if (s.state === 'asked' && askedAt !== null && now - askedAt >= LAYER_CAMERA_FALLBACK_MS) {
    return { fallBack: true, reason: `no frame from the layer within ${LAYER_CAMERA_FALLBACK_MS / 1000} s of asking` };
  }
  if (s.state === 'on' && sending && s.lastFrameAt !== null && now - s.lastFrameAt >= LAYER_CAMERA_STALL_MS) {
    return { fallBack: true, reason: `the layer camera stalled (no frame for ${LAYER_CAMERA_STALL_MS / 1000} s)` };
  }
  return { fallBack: false, reason: null };
}
