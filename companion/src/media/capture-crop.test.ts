import { describe, expect, it } from 'vitest';
import { CoverGate, matchScreenSource, outSize, physicalRect, pickDisplay, screenCropFor, type ScreenDisplay } from './capture-crop.js';
import type { DxgiOutput, VpxWindow } from './window-geometry.js';

const win = (left: number, top: number, width: number, height: number, monitor = '0'): VpxWindow => ({ pid: 7, title: 'Visual Pinball Player', client: { left, top, width, height }, monitor });

/** The owner's rig shape: two 2560x1440 side by side. Electron's DIP bounds; `physical` as dipToScreenRect gives it. */
const LEFT: ScreenDisplay = { id: 11, bounds: { x: 0, y: 0, width: 2560, height: 1440 }, scaleFactor: 1 };
const RIGHT: ScreenDisplay = { id: 22, bounds: { x: 2560, y: 0, width: 2560, height: 1440 }, scaleFactor: 1 };
const OUTPUTS: DxgiOutput[] = [
  { index: 0, device: '\\\\.\\DISPLAY1', desktop: { left: 0, top: 0, width: 2560, height: 1440 }, monitor: '111', rotation: 1 },
  { index: 1, device: '\\\\.\\DISPLAY2', desktop: { left: 2560, top: 0, width: 2560, height: 1440 }, monitor: '222', rotation: 1 },
];

describe('the display that holds the player window (D2.5)', () => {
  it('by the window\'s monitor handle: its DXGI output, then the display with the same physical rect', () => {
    expect(pickDisplay(win(2700, 100, 1280, 720, '222'), OUTPUTS, [LEFT, RIGHT])).toMatchObject({ display: RIGHT, index: 1, matchedBy: 'monitor' });
    // The handle wins over the centre (MonitorFromWindow: the monitor it overlaps most, as `cropFor`).
    expect(pickDisplay(win(2000, 0, 1280, 720, '111'), OUTPUTS, [LEFT, RIGHT])).toMatchObject({ display: LEFT, matchedBy: 'monitor' });
  });

  it('no output for the handle: the display holding the centre, then the one it overlaps most; none → null', () => {
    expect(pickDisplay(win(2000, 0, 1280, 720, '999'), OUTPUTS, [LEFT, RIGHT])).toMatchObject({ display: RIGHT, matchedBy: 'centre' });
    expect(pickDisplay(win(100, 100, 1280, 720), [], [LEFT, RIGHT])).toMatchObject({ display: LEFT, matchedBy: 'centre' });
    expect(pickDisplay(win(-1000, 100, 1280, 720), [], [LEFT, RIGHT])).toMatchObject({ display: LEFT, matchedBy: 'centre' });
    expect(pickDisplay(win(9000, 100, 1280, 720), [], [LEFT, RIGHT])).toBeNull();
  });

  it('scale factor 1.0 and 1.25: the frame is in physical pixels, as the probe is', () => {
    expect(physicalRect(LEFT)).toEqual({ left: 0, top: 0, width: 2560, height: 1440 });
    // 125 %: Electron says 2048x1152 DIPs; the capture delivers 2560x1440.
    const scaled: ScreenDisplay = { id: 5, bounds: { x: 0, y: 0, width: 2048, height: 1152 }, scaleFactor: 1.25 };
    expect(physicalRect(scaled)).toEqual({ left: 0, top: 0, width: 2560, height: 1440 });
    const t = screenCropFor(win(100, 100, 1280, 720), [], [scaled]);
    expect(t).toMatchObject({ screen: { width: 2560, height: 1440 }, crop: { x: 100, y: 100, width: 1280, height: 720 }, out: { width: 1280, height: 720 } });
    // A 125 % display right of a 100 % one: DIP origins are Chromium's layout, so main passes Windows' own rect.
    const right125: ScreenDisplay = { id: 6, bounds: { x: 2560, y: 0, width: 2048, height: 1152 }, scaleFactor: 1.25, physical: { left: 2560, top: 0, width: 2560, height: 1440 } };
    const t2 = screenCropFor(win(2660, 200, 1920, 1080, '222'), OUTPUTS, [LEFT, right125]);
    expect(t2).toMatchObject({ index: 1, matchedBy: 'monitor', crop: { x: 100, y: 200, width: 1920, height: 1080 }, out: { width: 1280, height: 720 } });
  });

  it('a window over the display edge sends only its part on that display, sizes even; under 64 px left → null', () => {
    expect(screenCropFor(win(2000, -21, 1281, 721, '111'), OUTPUTS, [LEFT, RIGHT])).toMatchObject({ index: 0, crop: { x: 2000, y: 0, width: 560, height: 700 } });
    expect(screenCropFor(win(2530, 0, 1280, 720, '111'), OUTPUTS, [LEFT, RIGHT])).toBeNull();
  });

  it('the output size: at most 1280x720 with the crop\'s aspect, never upscaled, even', () => {
    expect(outSize({ width: 1920, height: 1080 })).toEqual({ width: 1280, height: 720 });
    expect(outSize({ width: 1280, height: 720 })).toEqual({ width: 1280, height: 720 });
    expect(outSize({ width: 800, height: 600 })).toEqual({ width: 800, height: 600 });
    // A portrait playfield (the owner's rotated display): the height is the limit.
    expect(outSize({ width: 1440, height: 2560 })).toEqual({ width: 404, height: 720 });
    // D7.4: a side-by-side stereo preview (VPX VRPreview = 3, 3:1 or wider) keeps 720 rows per eye.
    expect(outSize({ width: 2560, height: 720 })).toEqual({ width: 2560, height: 720 });
    expect(outSize({ width: 3840, height: 1080 })).toEqual({ width: 2560, height: 720 });
    expect(outSize({ width: 2560, height: 1080 })).toEqual({ width: 1280, height: 540 });
  });

  it('the screen source: by display_id; the only screen when there is one; never a guess', () => {
    const one = [{ id: 'window:1:0' }, { id: 'screen:0:0', display_id: '' }];
    expect(matchScreenSource(one, 11)?.id).toBe('screen:0:0');
    const two = [{ id: 'screen:0:0', display_id: '11' }, { id: 'screen:1:0', display_id: '22' }];
    expect(matchScreenSource(two, 22)?.id).toBe('screen:1:0');
    expect(matchScreenSource([{ id: 'screen:0:0' }, { id: 'screen:1:0' }], 22)).toBeNull();
    expect(matchScreenSource([{ id: 'window:1:0', display_id: '22' }], 22)).toBeNull();
  });
});

describe('the cover (D2.5, D1.9 for the match video)', () => {
  const timers = () => {
    let next: (() => void) | null = null;
    return {
      t: { setTimeout: (cb: () => void) => ((next = cb), 1), clearTimeout: () => void (next = null) },
      fire: () => {
        const cb = next;
        next = null;
        cb?.();
      },
      pending: () => next !== null,
    };
  };

  it('covered at once when VPX loses the front; uncovered only after the delay; unknown focus never covers', () => {
    const seen: Array<[boolean, string | null]> = [];
    const tm = timers();
    const g = new CoverGate((on, why) => seen.push([on, why]), 750, tm.t);
    g.note(true);
    expect(seen).toEqual([]);
    g.note(false, 'explorer');
    g.note(false, 'explorer');
    expect(seen).toEqual([[true, 'explorer in front']]);
    g.note(true);
    expect(tm.pending()).toBe(true);
    // Lost again before the delay: stays covered, the uncover is dropped.
    g.note(false, '');
    expect(tm.pending()).toBe(false);
    expect(seen).toHaveLength(1);
    g.note(true);
    tm.fire();
    expect(seen.at(-1)).toEqual([false, null]);
    g.note(false, null);
    g.note(null);
    expect(seen.slice(-2)).toEqual([
      [true, 'another window in front'],
      [false, null],
    ]);
    g.note(false, 'x');
    g.reset();
    expect(g.covered).toBe(false);
    expect(seen).toHaveLength(5);
  });
});
