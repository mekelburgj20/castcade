/**
 * D1.5: the framing preview on the Stream page. ffplay shows exactly what viewers would see (same crop, slice, turn,
 * scale and overlay; `ffplayPreviewArgs`) with nothing encoded, recorded or sent, so the streamer checks the framing
 * before going live (owner ask 2026-10-27; the spike's `--preview` did this from a terminal). Pure, so vitest covers
 * it: the host (`main/stream-host.ts`) probes the windows, writes the overlay text and spawns ffplay.
 *
 * The crop is computed as the engine's `step()` does (`pickPlayfield` → `cropFor` → `portraitSlice` when vertical),
 * and the picture as its `startCapture()` does (`outputSize`): a preview that framed differently from the stream would
 * be worse than none.
 */
import { ffplayPreviewArgs, outputSize, type QualityPreset } from './ffmpeg-args.js';
import type { StreamSettings } from './stream-settings.js';
import { cropFor, pickPlayfield, portraitSlice, previewPlacement, type WindowProbe } from './window-geometry.js';

export const PREVIEW_NO_WINDOW = 'Start a table in VPX first: the preview shows the player window.';
export const PREVIEW_OFF_SCREEN = 'The player window is on no monitor Castcade can capture.';

export interface PreviewInput {
  probe: WindowProbe;
  settings: StreamSettings;
  preset: QualityPreset;
  /** The overlay goes in only with both (a missing font crashes ffmpeg's drawtext), and only when `settings.overlay`. */
  fontFile: string | null;
  overlayTextFile: string | null;
  title?: string;
}

export type PreviewCommand = { args: string[]; picture: { width: number; height: number }; overlapsCapture: boolean } | { error: string };

export function previewCommand(input: PreviewInput): PreviewCommand {
  const { probe, settings: s, preset } = input;
  const pf = pickPlayfield(probe.windows);
  if (!pf) return { error: PREVIEW_NO_WINDOW };
  let crop = cropFor(pf, probe.outputs);
  if (!crop) return { error: PREVIEW_OFF_SCREEN };
  if (s.orientation === 'portrait') crop = portraitSlice(crop, s.shiftPercent / 100, s.rotate);
  const overlay = s.overlay && input.fontFile && input.overlayTextFile ? { textFile: input.overlayTextFile, fontFile: input.fontFile } : null;
  const picture = outputSize({ crop, rotate: s.rotate, preset });
  const { overlapsCapture, ...window } = previewPlacement(crop, probe.outputs, picture);
  const args = ffplayPreviewArgs({ crop, rotate: s.rotate, preset, overlay, window, ...(input.title ? { title: input.title } : {}) });
  return { args, picture, overlapsCapture };
}
