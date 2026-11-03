import { describe, expect, it } from 'vitest';
import {
  cameraFallback,
  cameraRequestFor,
  decideCamera,
  LAYER_CAMERA_DEFAULT_REQUEST,
  LAYER_CAMERA_FALLBACK_MS,
  LAYER_CAMERA_STALL_MS,
  type CameraDecisionInput,
} from './layer-camera.js';
import type { LayerCameraStatus } from './match-media-types.js';

const vr: CameraDecisionInput = { setting: 'layer', rig: 'vr_headset', runtime: 'virtual-desktop', layerProtocol: 3 };

describe('decideCamera (D7.5)', () => {
  it('the screen capture by default, whatever the rig', () => {
    expect(decideCamera({ ...vr, setting: 'screen' })).toEqual({ source: 'screen', reason: 'the Match tab says screen capture' });
  });

  it('the layer only on a headset: a PC rig has no eye views to read', () => {
    expect(decideCamera({ ...vr, rig: 'pc' }).source).toBe('screen');
    expect(decideCamera({ ...vr, rig: 'real_cabinet' }).source).toBe('screen');
  });

  it('not on SteamVR (or an unknown runtime): the layer is not in VPX there', () => {
    expect(decideCamera({ ...vr, runtime: 'steamvr' }).reason).toMatch(/SteamVR/);
    expect(decideCamera({ ...vr, runtime: null }).source).toBe('screen');
  });

  it('a protocol-2 layer cannot be the camera; no layer yet means the layer once it answers', () => {
    expect(decideCamera({ ...vr, layerProtocol: 2 })).toEqual({ source: 'screen', reason: 'the layer in VPX speaks pipe protocol 2, before the layer camera (restart VPX with the new layer)' });
    expect(decideCamera({ ...vr, layerProtocol: null })).toEqual({ source: 'layer', reason: 'the VR layer, once it is on the pipe' });
    for (const runtime of ['virtual-desktop', 'oculus', 'openxr-other'] as const) expect(decideCamera({ ...vr, runtime })).toEqual({ source: 'layer', reason: 'the VR layer' });
  });
});

describe('cameraRequestFor (D7.5)', () => {
  it('defaults to a 720x1440 box per eye at 30 fps', () => {
    expect(cameraRequestFor()).toEqual(LAYER_CAMERA_DEFAULT_REQUEST);
    expect(LAYER_CAMERA_DEFAULT_REQUEST).toEqual({ width: 720, height: 1440, fps: 30 });
  });

  it('never taller than the eye render; sides even; 1:2 kept', () => {
    expect(cameraRequestFor({ sourceEye: { width: 2064, height: 1100 } })).toEqual({ width: 550, height: 1100, fps: 30 });
    expect(cameraRequestFor({ sourceEye: { width: 3072, height: 3264 } })).toEqual({ width: 720, height: 1440, fps: 30 });
    expect(cameraRequestFor({ eyeHeight: 1081 })).toEqual({ width: 540, height: 1080, fps: 30 });
    expect(cameraRequestFor({ eyeHeight: 3 })).toEqual({ width: 2, height: 2, fps: 30 });
  });

  it('fps clamped to 1..60', () => {
    expect(cameraRequestFor({ fps: 0 }).fps).toBe(1);
    expect(cameraRequestFor({ fps: 144 }).fps).toBe(60);
    expect(cameraRequestFor({ fps: 24.4 }).fps).toBe(24);
  });
});

describe('cameraFallback (D7.5)', () => {
  const st = (p: Partial<LayerCameraStatus>): LayerCameraStatus => ({ state: 'off', why: null, lastFrameAt: null, frames: 0, ...p });

  it('refused, or stopped by the layer with a reason: fall back now', () => {
    expect(cameraFallback(st({ state: 'refused', why: 'swapchain format 0x881a' }), 0, 0, true)).toEqual({ fallBack: true, reason: 'the layer refused the camera: swapchain format 0x881a' });
    expect(cameraFallback(st({ state: 'off', why: 'the session ended' }), 0, 0, false)).toEqual({ fallBack: true, reason: 'the layer stopped the camera: the session ended' });
    expect(cameraFallback(st({ state: 'off' }), 0, 0, false).fallBack).toBe(false);
  });

  it('asked with no answer: after the fallback time, not before', () => {
    expect(cameraFallback(st({ state: 'asked' }), LAYER_CAMERA_FALLBACK_MS - 1, 0, true).fallBack).toBe(false);
    expect(cameraFallback(st({ state: 'asked' }), LAYER_CAMERA_FALLBACK_MS, 0, true)).toEqual({ fallBack: true, reason: 'no frame from the layer within 8 s of asking' });
    expect(cameraFallback(st({ state: 'asked' }), 1e9, null, true).fallBack).toBe(false); // never asked on this connection: nothing to time
  });

  it('on and stalled while sending: fall back; not sending, a still camera is no fault', () => {
    const on = st({ state: 'on', lastFrameAt: 1000, frames: 40 });
    expect(cameraFallback(on, 1000 + LAYER_CAMERA_STALL_MS - 1, 0, true).fallBack).toBe(false);
    expect(cameraFallback(on, 1000 + LAYER_CAMERA_STALL_MS, 0, true)).toEqual({ fallBack: true, reason: 'the layer camera stalled (no frame for 3 s)' });
    expect(cameraFallback(on, 1000 + 60_000, 0, false).fallBack).toBe(false);
  });
});
