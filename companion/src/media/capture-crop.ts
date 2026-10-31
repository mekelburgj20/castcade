/**
 * D2.5 (2026-10-31, the second two-player match): the match video is a crop of a SCREEN capture, not a window capture.
 * Both players were in VR (Virtual Desktop, OpenComposite); the other player's picture reached the host while VPX did
 * not have focus on his PC and froze on its last frame, with some strobe flashing, the moment he Alt-Tabbed into VPX to
 * play. Chromium's window capture loses a window that VPX drives that way; the solo stream engine never did, because it
 * films the MONITOR with Desktop Duplication and crops to the player window (`window-geometry.ts` `cropFor`). This file
 * is the same idea for `desktopCapturer`: which display holds the player window, which screen source films it, and the
 * window's region of that display's frame. Pure: `rtc-host.ts` hands it Electron's displays and the window probe.
 */
import type { DxgiOutput, Rect, VpxWindow } from './window-geometry.js';

/** An Electron display, reduced to what the crop needs. */
export interface ScreenDisplay {
  id: number;
  /** In DIPs (Electron's `Display.bounds`). */
  bounds: { x: number; y: number; width: number; height: number };
  scaleFactor: number;
  /**
   * The display in physical virtual-desktop pixels (the probe's coordinates), from `screen.dipToScreenRect` on Windows.
   * Absent: `bounds` times `scaleFactor`, exact for a display at the origin and for a single DPI across displays.
   */
  physical?: Rect;
}

/** A region in a display's own frame, physical pixels from its top-left corner. */
export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ScreenTarget {
  display: ScreenDisplay;
  /** Position in the display list (for "screen <n>"). */
  index: number;
  /** How the display was found: the DXGI output with the window's monitor handle, or where the window's centre lies. */
  matchedBy: 'monitor' | 'centre';
  /** The display's frame size in physical pixels: what Chromium's screen capture delivers. */
  screen: { width: number; height: number };
  crop: CropRect;
  /** The size the page draws the crop at (and sends). */
  out: { width: number; height: number };
}

/** The match video's largest size; the crop keeps its aspect inside it (PANEL_VIDEO is 1280x720, alpha-match.md §4). */
export const MAX_OUT = { width: 1280, height: 720 } as const;
/** Two rects that differ by this much or less are the same display (rounding between DIPs and pixels). */
const SAME_RECT_PX = 2;

/** The display's rect in physical pixels: Windows' own figure when main has it, else the DIP bounds scaled. */
export function physicalRect(d: ScreenDisplay): Rect {
  if (d.physical) return d.physical;
  const s = d.scaleFactor > 0 ? d.scaleFactor : 1;
  return { left: Math.round(d.bounds.x * s), top: Math.round(d.bounds.y * s), width: Math.round(d.bounds.width * s), height: Math.round(d.bounds.height * s) };
}

const near = (a: Rect, b: Rect): boolean =>
  Math.abs(a.left - b.left) <= SAME_RECT_PX && Math.abs(a.top - b.top) <= SAME_RECT_PX && Math.abs(a.width - b.width) <= SAME_RECT_PX && Math.abs(a.height - b.height) <= SAME_RECT_PX;

const overlap = (a: Rect, b: Rect): number => {
  const w = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
  const h = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
  return w > 0 && h > 0 ? w * h : 0;
};

/**
 * The display that holds the window. Electron does not expose HMONITOR, so the probe's DXGI output for the window's
 * monitor handle (the solo engine's rule, `cropFor`) is matched to the display with the same physical rect. When that
 * fails (no output for that handle: another adapter, or a display Electron rounds differently) the display containing
 * the window's centre is taken, then the one it overlaps most.
 */
export function pickDisplay(win: VpxWindow, outputs: DxgiOutput[], displays: ScreenDisplay[]): { display: ScreenDisplay; index: number; matchedBy: 'monitor' | 'centre' } | null {
  const rects = displays.map(physicalRect);
  const out = outputs.find((o) => o.monitor === win.monitor);
  if (out) {
    const i = rects.findIndex((r) => near(r, out.desktop));
    if (i >= 0) return { display: displays[i]!, index: i, matchedBy: 'monitor' };
  }
  const cx = win.client.left + win.client.width / 2;
  const cy = win.client.top + win.client.height / 2;
  let i = rects.findIndex((r) => cx >= r.left && cx < r.left + r.width && cy >= r.top && cy < r.top + r.height);
  if (i < 0) {
    let best = 0;
    rects.forEach((r, k) => {
      const a = overlap(r, win.client);
      if (a > best) {
        best = a;
        i = k;
      }
    });
  }
  return i >= 0 ? { display: displays[i]!, index: i, matchedBy: 'centre' } : null;
}

/** Fits a crop inside `max` (never upscaled), keeping its aspect; even sizes, as the encoders want. */
export function outSize(crop: { width: number; height: number }, max: { width: number; height: number } = MAX_OUT): { width: number; height: number } {
  const k = Math.min(1, max.width / crop.width, max.height / crop.height);
  return { width: Math.max(2, Math.round(crop.width * k) & ~1), height: Math.max(2, Math.round(crop.height * k) & ~1) };
}

/**
 * The window's client area in its display's frame, clipped to the display (a window hanging over the edge sends only
 * the part on that display), sizes even. Null when no display holds it or under 64 pixels remain.
 *
 * Rotation: Chromium's screen capture delivers the display as the user sees it (upright, rotation applied), and the
 * probe's rects and Electron's bounds are desktop coordinates, so the crop is plain desktop maths. That differs from
 * `ffmpeg-args.ts` `ddagrabRegion`, where Desktop Duplication hands over the panel's own unrotated frame and the region
 * must be turned. The owner's rig has a portrait-rotated display: a player window on it is one of the rig checks.
 */
export function screenCropFor(win: VpxWindow, outputs: DxgiOutput[], displays: ScreenDisplay[]): ScreenTarget | null {
  const hit = pickDisplay(win, outputs, displays);
  if (!hit) return null;
  const r = physicalRect(hit.display);
  const x0 = Math.max(win.client.left, r.left);
  const y0 = Math.max(win.client.top, r.top);
  const x1 = Math.min(win.client.left + win.client.width, r.left + r.width);
  const y1 = Math.min(win.client.top + win.client.height, r.top + r.height);
  const width = (x1 - x0) & ~1;
  const height = (y1 - y0) & ~1;
  if (width < 64 || height < 64) return null;
  const crop = { x: x0 - r.left, y: y0 - r.top, width, height };
  return { ...hit, screen: { width: r.width, height: r.height }, crop, out: outSize(crop) };
}

/**
 * The capturer's screen source for a display: by `display_id` (Electron's `Display.id` as a string); the only screen
 * when there is one. Null otherwise: a guess could film the wrong monitor.
 */
export function matchScreenSource<S extends { id: string; display_id?: string }>(sources: S[], displayId: number): S | null {
  const screens = sources.filter((s) => s.id.startsWith('screen:'));
  return screens.find((s) => s.display_id === String(displayId)) ?? (screens.length === 1 ? screens[0]! : null);
}

export const sameCrop = (a: CropRect, b: CropRect): boolean => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/**
 * D1.9 for the match video: covered at once when VPX loses the foreground (the screen capture films whatever is on top
 * of the window then), uncovered `uncoverMs` after VPX is back in front (re-entering full screen flickers). `null`
 * means focus is unknown (the watcher died): never covered then, as the stream engine. Timers are injected for tests.
 */
export class CoverGate {
  covered = false;
  private timer: unknown = null;
  constructor(
    private readonly onChange: (covered: boolean, why: string | null) => void,
    private readonly uncoverMs: number,
    private readonly timers: { setTimeout(cb: () => void, ms: number): unknown; clearTimeout(t: unknown): void } = {
      setTimeout: (cb, ms) => setTimeout(cb, ms),
      clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    },
  ) {}

  note(vpxInFront: boolean | null, exe: string | null = null): void {
    if (vpxInFront === false) {
      this.clear();
      this.set(true, `${exe || 'another window'} in front`);
    } else if (vpxInFront === null) {
      this.clear();
      this.set(false, null);
    } else if (this.covered && this.timer === null) {
      this.timer = this.timers.setTimeout(() => {
        this.timer = null;
        this.set(false, null);
      }, this.uncoverMs);
    }
  }

  /** Back to uncovered without a callback (the capture is gone). */
  reset(): void {
    this.clear();
    this.covered = false;
  }

  private clear(): void {
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
  }

  private set(on: boolean, why: string | null): void {
    if (on === this.covered) return;
    this.covered = on;
    this.onChange(on, why);
  }
}
