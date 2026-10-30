import { describe, expect, it } from 'vitest';
import { PRESETS } from './ffmpeg-args.js';
import { PREVIEW_NO_WINDOW, previewCommand, type PreviewInput } from './preview.js';
import { DEFAULT_STREAM_SETTINGS, type StreamSettings } from './stream-settings.js';
import type { DxgiOutput, VpxWindow, WindowProbe } from './window-geometry.js';

const OUTPUTS: DxgiOutput[] = [
  { index: 0, device: '\\\\.\\DISPLAY1', desktop: { left: 0, top: 0, width: 2560, height: 1440 }, monitor: '1', rotation: 1 },
  { index: 1, device: '\\\\.\\DISPLAY2', desktop: { left: 2560, top: 0, width: 2560, height: 1440 }, monitor: '2', rotation: 1 },
];
/** The owner's rig in cabinet mode (2026-10-27): the player fills display 2. */
const PLAYER: VpxWindow = { pid: 7, title: 'Visual Pinball Player', client: { left: 2560, top: 0, width: 2560, height: 1440 }, monitor: '2' };
const EDITOR: VpxWindow = { pid: 7, title: 'Visual Pinball - [Monster Bash]', client: { left: 700, top: 100, width: 1600, height: 1100 }, monitor: '1' };
const PROBE: WindowProbe = { outputs: OUTPUTS, windows: [EDITOR, PLAYER] };

const input = (s: Partial<StreamSettings> = {}, more: Partial<PreviewInput> = {}): PreviewInput => ({
  probe: PROBE,
  settings: { ...DEFAULT_STREAM_SETTINGS, ...s },
  preset: PRESETS['720p30']!,
  fontFile: 'C:\\Windows\\Fonts\\segoeui.ttf',
  overlayTextFile: 'C:\\Users\\p\\AppData\\Roaming\\Castcade\\stream-overlay.txt',
  ...more,
});

/** The lavfi graph ffplay plays (the argument after `-i`). */
const graph = (args: string[]): string => args[args.indexOf('-i') + 1]!;

function ok(r: ReturnType<typeof previewCommand>) {
  if ('error' in r) throw new Error(r.error);
  return r;
}

describe('previewCommand (D1.5)', () => {
  it('a vertical stream previews the 9:16 slice, shifted as the engine shifts it', () => {
    const r = ok(previewCommand(input({ orientation: 'portrait', shiftPercent: 10 })));
    // 1440 tall → an 810 wide slice, centred at (2560 - 810) / 2 = 875, then 10 % of 2560 to the right = 1131.
    expect(graph(r.args)).toContain('offset_x=1131:offset_y=0:video_size=810x1440');
    expect(r.picture).toEqual({ width: 720, height: 1280 });
  });

  it('passes rotate through: cabinet mode turns the picture upright, the slice runs along the height', () => {
    const r = ok(previewCommand(input({ orientation: 'portrait', rotate: 90 })));
    // Turned 90°, the picture is 1440 wide and 2560 tall: already 9:16, so the slice keeps the whole window.
    expect(graph(r.args)).toContain('offset_x=0:offset_y=0:video_size=2560x1440');
    expect(graph(r.args)).toContain('transpose=clock');
    expect(r.picture).toEqual({ width: 720, height: 1280 });
  });

  it('landscape previews the whole window, on the other monitor', () => {
    const r = ok(previewCommand(input({ orientation: 'landscape' })));
    expect(graph(r.args)).toContain('offset_x=0:offset_y=0:video_size=2560x1440');
    expect(graph(r.args)).not.toContain('transpose');
    expect(r.picture).toEqual({ width: 1280, height: 720 });
    expect(r.overlapsCapture).toBe(false);
    expect(Number(r.args[r.args.indexOf('-left') + 1])).toBeLessThan(2560);
  });

  it('draws the overlay only with a font and a text file, and only when the setting is on', () => {
    expect(graph(ok(previewCommand(input())).args)).toContain('drawtext=');
    expect(graph(ok(previewCommand(input({}, { fontFile: null }))).args)).not.toContain('drawtext=');
    expect(graph(ok(previewCommand(input({}, { overlayTextFile: null }))).args)).not.toContain('drawtext=');
    expect(graph(ok(previewCommand(input({ overlay: false }))).args)).not.toContain('drawtext=');
  });

  it('says to start a table when no player window is open (the editor is never the playfield)', () => {
    expect(previewCommand(input({}, { probe: { outputs: OUTPUTS, windows: [EDITOR] } }))).toEqual({ error: PREVIEW_NO_WINDOW });
  });

  it('flags a preview that must sit inside the captured area (one monitor, the window fills it)', () => {
    const one: WindowProbe = { outputs: [OUTPUTS[0]!], windows: [{ ...PLAYER, client: { left: 0, top: 0, width: 2560, height: 1440 }, monitor: '1' }] };
    expect(ok(previewCommand(input({ orientation: 'landscape' }, { probe: one }))).overlapsCapture).toBe(true);
  });
});
