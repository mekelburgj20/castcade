// Where the companion finds ffmpeg and ffplay (D1.6). The installer carries a pinned build in
// resources/ffmpeg (scripts/fetch-ffmpeg.mjs); a dev checkout uses companion/resources/ffmpeg when it was
// fetched, else whatever `ffmpeg` is on PATH.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface FfmpegLocation {
  ffmpeg: string;
  ffplay: string;
  /** 'bundled' = the build fetch-ffmpeg pinned (installer or a fetched dev checkout); 'path' = the system's. */
  source: 'bundled' | 'path';
  /** First field of resources/ffmpeg/VERSION, e.g. `ffmpeg-8.1.1-essentials_build`; null on PATH. */
  build: string | null;
}

export interface FfmpegPathInput {
  packaged: boolean;
  /** process.resourcesPath when packaged. */
  resourcesPath: string;
  /** The companion package directory (dev runs). */
  companionDir: string;
}

export function ffmpegDir(i: FfmpegPathInput): string {
  return i.packaged ? join(i.resourcesPath, 'ffmpeg') : resolve(i.companionDir, 'resources', 'ffmpeg');
}

export function resolveFfmpeg(i: FfmpegPathInput, exists: (p: string) => boolean = existsSync, read: (p: string) => string = (p) => readFileSync(p, 'utf8')): FfmpegLocation {
  const dir = ffmpegDir(i);
  const ffmpeg = join(dir, 'ffmpeg.exe');
  const ffplay = join(dir, 'ffplay.exe');
  if (exists(ffmpeg) && exists(ffplay)) {
    let build: string | null;
    try {
      build = read(join(dir, 'VERSION')).trim().split(/\s+/)[0] || null;
    } catch {
      build = null;
    }
    return { ffmpeg, ffplay, source: 'bundled', build };
  }
  return { ffmpeg: 'ffmpeg', ffplay: 'ffplay', source: 'path', build: null };
}
