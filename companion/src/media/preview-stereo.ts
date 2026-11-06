/**
 * D7.4.3 (2026-11-01, rig test BCBSLU / LBWNUP): the SENDER says whether its match video is VPX's VR preview on both
 * eyes. The receivers guessed from the picture's shape (3:1 or wider, VR senders only), and both eyes in a 16:9 or a
 * square window were shown flat: VPX 10.8.0 (`Player::PrepareVideoBuffers`, v10.8.0-2051-28dd6c3), with
 * `ShrinkPreview` off, centre-crops each eye to its half of the window, never stretches it, and clamps the window to
 * the monitor. So both eyes in a window as tall as the monitor and about as wide (1080x1080 on a 1080p monitor, the
 * owner's 1440x1392) are two portrait eyes, the view pinball wants; a 2560x720 window never fits a 1080p monitor.
 *
 * The declaration: the Match tab's setting (`previewStereo`) when it names one; on `auto`, a rig on the monitor sends
 * one picture, and a VR rig reads `[PlayerVR] VRPreview` from the active `VPinballX.ini` (the one beside the exe wins,
 * else `%APPDATA%\VPinballX\VPinballX.ini`, as `locateMainIni` resolves it; `-Ini` on VPX's command line is not
 * seen here): 3 is both eyes. No Electron import.
 *
 * D8.7 (2026-11-05, ADR 0009): spectating is 2D, so one eye is the right preview and `auto` resolves to it: a VR rig
 * whose ini cannot be found declares one eye (VPX's default, the left) instead of leaving the receivers to guess, and
 * the advice now runs the other way (both eyes on: set VPX to one eye; one eye: nothing to say). The declaration still
 * follows the ini when it plainly says both eyes: Castcade never writes VPX's ini, and a receiver places what it is
 * told, so a both-eyes picture declared as one would show two pictures side by side on the screen. This only concerns
 * the screen capture: the layer camera says what it sends with each frame (rtc-host.ts `videoFrameFrom`).
 */
import { iniNumber, locateMainIni, parseIni } from '../witness/ini-attestation.js';
import { isNotFound, type WitnessFs } from '../witness/fs.js';
import type { VrStereo } from './match-media-types.js';

/** The Match tab's override: `auto` (the ini), `mono` (one eye), `sbs` (both eyes). */
export type PreviewStereoSetting = 'auto' | 'mono' | 'sbs';
export const PREVIEW_STEREO_SETTINGS: readonly PreviewStereoSetting[] = ['auto', 'mono', 'sbs'];

/** VPX's `VRPreviewMode` (src/core/player.h): 0 disabled, 1 left eye, 2 right eye, 3 both eyes. */
export const VR_PREVIEW_BOTH = 3;

/**
 * The preview kind an ini says. A missing key is VPX's default, the left eye (`VRPREVIEW_LEFT`), so one picture;
 * null only when there is no ini text at all.
 */
export function stereoFromIni(text: string | null): VrStereo | null {
  if (text === null) return null;
  const v = iniNumber(parseIni(text), 'PlayerVR', 'VRPreview');
  return v !== null && Math.round(v) === VR_PREVIEW_BOTH ? 'sbs' : 'mono';
}

/** The active ini's preview kind for the VPX at `exe`, and which file said it. Never throws. */
export async function readIniStereo(opts: { fs: WitnessFs; exe: string | null; env?: NodeJS.ProcessEnv }): Promise<{ stereo: VrStereo | null; ini: string | null }> {
  if (!opts.exe) return { stereo: null, ini: null };
  try {
    const ini = await locateMainIni({ fs: opts.fs, exe: opts.exe, env: opts.env });
    if (!ini) return { stereo: null, ini: null };
    let text: string | null;
    try {
      text = new TextDecoder().decode(await opts.fs.readFile(ini));
    } catch (e) {
      if (!isNotFound(e)) throw e;
      text = null;
    }
    return { stereo: stereoFromIni(text), ini: text === null ? null : ini };
  } catch {
    return { stereo: null, ini: null };
  }
}

/**
 * What this rig declares: the setting when it names a kind; on `auto`, one picture on the monitor, and in VR the ini
 * when it says both eyes, else one eye (VPX's default when the key, or the ini itself, is missing: ADR 0009).
 */
export function declaredStereo(setting: PreviewStereoSetting, inVr: boolean, ini: VrStereo | null): VrStereo {
  if (setting === 'mono' || setting === 'sbs') return setting;
  return inVr && ini === 'sbs' ? 'sbs' : 'mono';
}

/**
 * The Match tab's advice to a VR player about the picture it sends (null: nothing to say). `crop` is the window region
 * sent (`MediaStatus.captureCrop`), `declared` what this rig tells the others (`MediaStatus.captureStereo`). Under
 * ADR 0009 the only advice is to stop sending both eyes: the receivers then get the withdrawn stereo window of 0.2.35
 * instead of the flat screen.
 */
export function previewAdvice(o: { inVr: boolean; declared: VrStereo | null | undefined; crop: { width: number; height: number } | null | undefined }): string | null {
  const c = o.crop;
  if (!o.inVr || !c || !(c.width > 0 && c.height > 0)) return null;
  if (o.declared !== 'sbs') return null;
  return "You are sending both eyes side by side (VPX's VR preview is on Both Eyes), so the other players do not get the flat screen. Set it to one eye (Preferences → VR → Preview: Left Eye, or VRPreview = 1 under [PlayerVR] in VPinballX.ini) and restart the table, or switch Camera to the VR layer.";
}
