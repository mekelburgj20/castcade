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
  /** D7.4.10: how the window sits on the display (full screen, or hanging off an edge). */
  fit: CropFit;
}

/** The match video's largest size; the crop keeps its aspect inside it (PANEL_VIDEO is 1280x720, alpha-match.md §4). */
export const MAX_OUT = { width: 1280, height: 720 } as const;
/**
 * D7.4 (2026-10-31): a side-by-side stereo preview (VPX `VRPreview = 3`, both eyes, 3:1 or wider) keeps 720 rows per eye
 * instead of being squeezed into 1280x360 (640x360 an eye in the headset's theater screen).
 */
export const MAX_OUT_SBS = { width: 2560, height: 720 } as const;
export const SBS_MIN_ASPECT = 3;
/**
 * D7.4.6 (2026-11-02): a portrait or near-square picture (under `TALL_MAX_ASPECT`) is sent at its own size: one portrait
 * picture up to 1080x1920, a side-by-side pair of portrait eyes (1280x1080, 1440x1392) as is. The landscape limit
 * would shrink a 1280x1080 window to 852x720, and the receiver's theater screen shows that life-size.
 */
export const MAX_OUT_TALL = { width: 1440, height: 1920 } as const;
export const TALL_MAX_ASPECT = 1.5;
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
  if (max === MAX_OUT && crop.width / crop.height >= SBS_MIN_ASPECT) max = MAX_OUT_SBS;
  else if (max === MAX_OUT && crop.width / crop.height < TALL_MAX_ASPECT) max = MAX_OUT_TALL;
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
  return { ...hit, screen: { width: r.width, height: r.height }, crop, out: outSize(crop), fit: cropFit(win, r) };
}

/**
 * D7.4.10 (2026-11-02, Krobs' rig, fourth run): how the window sits on its display. `fillsDisplay`: its client area
 * covers the whole display (`[PlayerVR] PreviewWidth / PreviewHeight` set to the monitor's size). Windows presents such
 * a window full screen once it has focus, past the desktop composition the screen capture films, and the capture then
 * delivers one frame per pick and nothing after: his counters read 216–295 frames per 10 s with a 1080x912 window and
 * 0–1 with 1920x1080 on his 1920x1080 display, with bursts only while he had alt-tabbed out (the third sighting of
 * "froze once VPX had focus": D2.5, D7.4.4). `cut`: rows / columns of the client area past the display's edges, which
 * the crop cannot send (his earlier window hung 168 rows below the display: the bottom of his table never left his PC).
 */
export interface CropFit {
  fillsDisplay: boolean;
  cut: { top: number; bottom: number; left: number; right: number };
}

export function cropFit(win: VpxWindow, display: { left: number; top: number; width: number; height: number }): CropFit {
  const c = win.client;
  const right = c.left + c.width;
  const bottom = c.top + c.height;
  const dRight = display.left + display.width;
  const dBottom = display.top + display.height;
  return {
    fillsDisplay: c.left <= display.left && c.top <= display.top && right >= dRight && bottom >= dBottom,
    cut: { top: Math.max(0, display.top - c.top), bottom: Math.max(0, bottom - dBottom), left: Math.max(0, display.left - c.left), right: Math.max(0, right - dRight) },
  };
}

/**
 * D7.4.10: the Match tab's and the log's warning for a fit that loses the picture, or null. A full-screen window is
 * the one that stops the capture, so it is named alone; otherwise the edges off the display, with the rows below
 * first (the bottom of the table). The size suggested leaves room for the title bar and the taskbar.
 */
export function fitWarning(fit: CropFit, screen: { width: number; height: number }): string | null {
  if (fit.fillsDisplay) {
    const side = Math.max(64, Math.floor((Math.min(screen.width, screen.height) - 120) / 8) * 8);
    return `the VPX preview window covers the whole ${screen.width}x${screen.height} display: a full-screen window stops the screen capture once VPX has focus (one frame per pick); set the preview size (Preferences → VR, or [PlayerVR] PreviewWidth / PreviewHeight) smaller than the display, e.g. ${side}x${side}`;
  }
  const parts: string[] = [];
  if (fit.cut.bottom > 0) parts.push(`${fit.cut.bottom} rows at the bottom`);
  if (fit.cut.top > 0) parts.push(`${fit.cut.top} rows at the top`);
  if (fit.cut.left > 0) parts.push(`${fit.cut.left} columns at the left`);
  if (fit.cut.right > 0) parts.push(`${fit.cut.right} columns at the right`);
  if (parts.length === 0) return null;
  return `${parts.join(', ')} of the VPX preview window are off the display and are not sent: move the window ([PlayerVR] WindowPosX / WindowPosY) or make it smaller (PreviewWidth / PreviewHeight)`;
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
