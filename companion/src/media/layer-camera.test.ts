import { describe, expect, it } from 'vitest';
import {
  cameraFallback,
  cameraRequestFor,
  cameraViewWords,
  cameraWatch,
  createFrameSlot,
  decideCamera,
  LAYER_CAMERA_DEFAULT_REQUEST,
  LAYER_CAMERA_FALLBACK_MS,
  LAYER_CAMERA_PIPE_WAIT_MS,
  LAYER_CAMERA_STALL_MS,
  type CameraDecisionInput,
  type CameraWatchInput,
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

  it('D7.5.9: the whole view: a square box with whole: true, never taller than the eye render; the window view is the 1:2 crop', () => {
    expect(cameraRequestFor({ view: 'whole' })).toEqual({ width: 1440, height: 1440, fps: 30, whole: true });
    expect(cameraRequestFor({ view: 'whole', sourceEye: { width: 2064, height: 1100 } })).toEqual({ width: 1100, height: 1100, fps: 30, whole: true });
    expect(cameraRequestFor({ view: 'whole', eyeHeight: 1081 })).toEqual({ width: 1080, height: 1080, fps: 30, whole: true });
    expect(cameraRequestFor({ view: 'window' })).toEqual({ width: 720, height: 1440, fps: 30 });
    expect(cameraViewWords(cameraRequestFor({ view: 'whole' }))).toBe('whole view');
    expect(cameraViewWords(cameraRequestFor({ view: 'window' }))).toBe('window view');
    expect(cameraViewWords('whole')).toBe('whole view');
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

describe('cameraWatch (D7.5.1)', () => {
  const st = (p: Partial<LayerCameraStatus>): LayerCameraStatus => ({ state: 'asked', why: null, lastFrameAt: null, frames: 0, ...p });
  const base: CameraWatchInput = { status: st({}), now: 0, askedAt: 0, connectedAt: null, sending: false, layerProtocol: null, overlay: { state: 'starting', reason: null } };

  it('no layer on the pipe yet: wait up to 20 s from the ask, then the screen; a pipe that had been there and closed: the screen at once', () => {
    expect(LAYER_CAMERA_PIPE_WAIT_MS).toBe(20_000);
    expect(cameraWatch({ ...base, now: 19_999 }).fallBack).toBe(false);
    expect(cameraWatch({ ...base, now: 20_000 })).toEqual({ fallBack: true, reason: 'the layer did not answer on the pipe within 20 s' });
    expect(cameraWatch({ ...base, now: 1, connectedAt: 0 })).toEqual({ fallBack: true, reason: 'the pipe to the layer closed (VPX exited or left VR)' });
  });

  it('a protocol-2 layer, or an overlay that cannot run: the screen, with the reason', () => {
    expect(cameraWatch({ ...base, layerProtocol: 2 }).reason).toBe('the layer in VPX speaks pipe protocol 2, before the layer camera (restart VPX with the new layer)');
    expect(cameraWatch({ ...base, overlay: { state: 'unavailable', reason: 'layer_missing' } })).toEqual({ fallBack: true, reason: 'the OpenXR layer is not available (layer_missing)' });
  });

  it('the 8 s clock runs from when the layer came on the pipe; stopped by the layer while asked; on but frameless', () => {
    const on = { ...base, layerProtocol: 3, askedAt: 0, connectedAt: 15_000 };
    expect(cameraWatch({ ...on, now: 15_000 + LAYER_CAMERA_FALLBACK_MS - 1 }).fallBack).toBe(false);
    expect(cameraWatch({ ...on, now: 15_000 + LAYER_CAMERA_FALLBACK_MS }).reason).toBe('no frame from the layer within 8 s of asking');
    expect(cameraWatch({ ...on, now: 15_001, status: st({ why: 'xrEndFrame saw no projection layer' }) })).toEqual({ fallBack: true, reason: 'the layer stopped the camera: xrEndFrame saw no projection layer' });
    expect(cameraWatch({ ...on, now: 15_000 + LAYER_CAMERA_FALLBACK_MS, status: st({ state: 'on' }) }).reason).toBe('the layer said the camera is on but sent no frame within 8 s');
    expect(cameraWatch({ ...on, now: 16_000, status: st({ state: 'refused', why: 'GL 3.1' }) }).reason).toBe('the layer refused the camera: GL 3.1');
  });

  it('frames flowing: fine; stopped for 3 s while up: the screen', () => {
    const flowing = { ...base, layerProtocol: 3, connectedAt: 0, status: st({ state: 'on', lastFrameAt: 10_000, frames: 200 }) };
    expect(cameraWatch({ ...flowing, now: 12_000, sending: true }).fallBack).toBe(false);
    expect(cameraWatch({ ...flowing, now: 13_000, sending: true }).reason).toBe('the layer camera stalled (no frame for 3 s)');
    expect(cameraWatch({ ...flowing, now: 60_000, sending: false }).fallBack).toBe(false);
  });
});

describe('createFrameSlot (D7.5.1)', () => {
  it('one in flight, the newest waits (older ones dropped and counted), sent at the ack; a lost ack is given up after 1 s', () => {
    const slot = createFrameSlot<number>();
    expect(slot.offer(1, 0)).toBe(1);
    expect(slot.offer(2, 10)).toBeNull();
    expect(slot.offer(3, 20)).toBeNull();
    expect(slot.takeDropped()).toBe(1);
    expect(slot.ack(30)).toBe(3);
    expect(slot.ack(40)).toBeNull();
    expect(slot.offer(4, 50)).toBe(4);
    expect(slot.offer(5, 60)).toBeNull();
    expect(slot.offer(6, 1050)).toBe(6); // 4's ack never came: 5 is dropped, 6 goes
    expect(slot.takeDropped()).toBe(1);
    expect(slot.takeDropped()).toBe(0);
    slot.reset();
    expect(slot.ack(2000)).toBeNull();
    expect(slot.offer(7, 2000)).toBe(7);
  });
});
