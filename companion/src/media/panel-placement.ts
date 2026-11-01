/**
 * D2.6 (2026-11-01): where the desktop match panel goes. Electron centres a new window on the primary display and so
 * did the main window, so the panel (always on top) landed exactly over it and swallowed every click. The panel now
 * sits beside the main window: to its right, else to its left, else below, clamped to the display's work area. No
 * Electron import, so it unit-tests.
 */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type PanelSide = 'right' | 'left' | 'below' | 'edge';

/** The gap between the main window and the panel, in DIPs. */
export const PANEL_GAP = 8;

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(v, Math.max(lo, hi)));

/**
 * The panel's top-left. `main` null (no main window): the work area's right edge. A side is taken when the panel fits
 * there whole inside the work area; the other axis is clamped. When no side fits (a window as big as the screen) the
 * panel goes to the right edge and may overlap, and `side` says `edge`.
 */
export function placePanel(main: Rect | null, panel: { width: number; height: number }, work: Rect): { x: number; y: number; side: PanelSide } {
  const right = work.x + work.width;
  const bottom = work.y + work.height;
  const edge = { x: clamp(right - panel.width, work.x, right), y: clamp(work.y, work.y, bottom - panel.height), side: 'edge' as const };
  if (!main) return edge;
  const yBeside = clamp(main.y, work.y, bottom - panel.height);
  const rx = main.x + main.width + PANEL_GAP;
  if (rx + panel.width <= right) return { x: rx, y: yBeside, side: 'right' };
  const lx = main.x - PANEL_GAP - panel.width;
  if (lx >= work.x) return { x: lx, y: yBeside, side: 'left' };
  const by = main.y + main.height + PANEL_GAP;
  if (by + panel.height <= bottom) return { x: clamp(main.x, work.x, right - panel.width), y: by, side: 'below' };
  return edge;
}

/** True when the rectangles share any area. */
export function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/**
 * A remembered window rectangle, checked: whole numbers, a sane size, and at least a 100x50 strip on some current
 * display's work area (a monitor unplugged since the last run must not strand the window off screen). Else null.
 */
export function usableBounds(saved: unknown, workAreas: Rect[]): Rect | null {
  if (typeof saved !== 'object' || saved === null) return null;
  const s = saved as Record<string, unknown>;
  const { x, y, width, height } = s;
  if (![x, y, width, height].every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  const r = { x: Math.round(x as number), y: Math.round(y as number), width: Math.round(width as number), height: Math.round(height as number) };
  if (r.width < 200 || r.height < 200 || r.width > 10_000 || r.height > 10_000) return null;
  const seen = workAreas.some((w) => {
    const ix = Math.min(r.x + r.width, w.x + w.width) - Math.max(r.x, w.x);
    const iy = Math.min(r.y + r.height, w.y + w.height) - Math.max(r.y, w.y);
    return ix >= 100 && iy >= 50;
  });
  return seen ? r : null;
}
