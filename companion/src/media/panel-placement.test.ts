import { describe, expect, it } from 'vitest';
import { overlaps, PANEL_GAP, placePanel, usableBounds, type Rect } from './panel-placement.js';

const WORK: Rect = { x: 0, y: 0, width: 1920, height: 1040 };
const PANEL = { width: 480, height: 720 };
const MAIN: Rect = { x: 750, y: 200, width: 420, height: 640 };

describe('placePanel (D2.6, 2026-11-01)', () => {
  it('to the right of the main window, level with its top', () => {
    const p = placePanel(MAIN, PANEL, WORK);
    expect(p).toEqual({ x: 750 + 420 + PANEL_GAP, y: 200, side: 'right' });
    expect(overlaps({ x: p.x, y: p.y, ...PANEL }, MAIN)).toBe(false);
  });

  it('the main window centred on the owner\'s 1920x1080 screen (the bug): the panel lands beside it, not over it', () => {
    const centred: Rect = { x: 750, y: 220, width: 420, height: 640 };
    const p = placePanel(centred, PANEL, { x: 0, y: 0, width: 1920, height: 1080 });
    expect(p.side).toBe('right');
    expect(overlaps({ x: p.x, y: p.y, ...PANEL }, centred)).toBe(false);
  });

  it('to the left when the right side does not fit', () => {
    const main: Rect = { x: 1450, y: 100, width: 420, height: 640 };
    const p = placePanel(main, PANEL, WORK);
    expect(p).toEqual({ x: 1450 - PANEL_GAP - 480, y: 100, side: 'left' });
    expect(overlaps({ x: p.x, y: p.y, ...PANEL }, main)).toBe(false);
  });

  it('below when neither side fits (a narrow work area), x clamped into the work area', () => {
    const narrow: Rect = { x: 0, y: 0, width: 700, height: 1600 };
    const main: Rect = { x: 150, y: 50, width: 420, height: 640 };
    const p = placePanel(main, PANEL, narrow);
    expect(p).toEqual({ x: 150, y: 50 + 640 + PANEL_GAP, side: 'below' });
    // Near the right edge the x is pulled back so the panel stays whole on screen.
    const q = placePanel({ ...main, x: 270 }, PANEL, narrow);
    expect(q).toEqual({ x: 220, y: 698, side: 'below' });
    expect(overlaps({ x: q.x, y: q.y, ...PANEL }, { ...main, x: 270 })).toBe(false);
  });

  it('clamps the vertical position into the work area', () => {
    const low: Rect = { x: 100, y: 700, width: 420, height: 300 };
    const p = placePanel(low, PANEL, WORK);
    expect(p.side).toBe('right');
    expect(p.y).toBe(1040 - 720);
    const high: Rect = { x: 100, y: -200, width: 420, height: 300 };
    expect(placePanel(high, PANEL, WORK).y).toBe(0);
  });

  it('respects a work area that does not start at the origin (a second monitor, a taskbar on the left)', () => {
    const work: Rect = { x: -1920, y: 40, width: 1920, height: 1040 };
    const main: Rect = { x: -1200, y: 100, width: 420, height: 640 };
    const p = placePanel(main, PANEL, work);
    expect(p).toEqual({ x: -1200 + 420 + PANEL_GAP, y: 100, side: 'right' });
    expect(p.x + 480).toBeLessThanOrEqual(0);
    const left = placePanel({ ...main, x: -500 }, PANEL, work);
    expect(left.side).toBe('left');
    expect(left.x).toBeGreaterThanOrEqual(-1920);
  });

  it('no main window: the right edge of the work area; a main window as big as the screen: also the edge (it cannot avoid it)', () => {
    expect(placePanel(null, PANEL, WORK)).toEqual({ x: 1440, y: 0, side: 'edge' });
    expect(placePanel({ x: 0, y: 0, width: 1920, height: 1040 }, PANEL, WORK)).toEqual({ x: 1440, y: 0, side: 'edge' });
  });
});

describe('usableBounds (D2.6)', () => {
  const displays: Rect[] = [{ x: 0, y: 0, width: 1920, height: 1040 }];
  it('a remembered rectangle that is on a display comes back whole', () => {
    expect(usableBounds({ x: 100.4, y: 50, width: 420, height: 640 }, displays)).toEqual({ x: 100, y: 50, width: 420, height: 640 });
  });
  it('one on a monitor that is gone, or with a sliver showing, is not used', () => {
    expect(usableBounds({ x: 2500, y: 50, width: 420, height: 640 }, displays)).toBeNull();
    expect(usableBounds({ x: 1850, y: 50, width: 420, height: 640 }, displays)).toBeNull();
    expect(usableBounds({ x: 1800, y: 50, width: 420, height: 640 }, displays)).not.toBeNull();
    expect(usableBounds({ x: 100, y: 1020, width: 420, height: 640 }, displays)).toBeNull();
  });
  it('junk is not used', () => {
    for (const bad of [null, undefined, 'x', 3, {}, { x: 'a', y: 0, width: 400, height: 400 }, { x: 0, y: 0, width: 50, height: 400 }, { x: 0, y: 0, width: 400, height: 99999 }, { x: NaN, y: 0, width: 400, height: 400 }]) {
      expect(usableBounds(bad, displays)).toBeNull();
    }
  });
});
