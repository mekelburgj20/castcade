#!/usr/bin/env node
/**
 * fetch-ffmpeg.mjs — fetch the pinned FFmpeg shared build castcade-video.exe links against (D10.1).
 *
 *   node video-helper/fetch-ffmpeg.mjs [--force]
 *
 * Downloads BtbN's ffmpeg-n8.1.3-34-ga35157abb9-win64-gpl-shared-8.1.zip (GPL, shared: avcodec/avutil/swscale dlls +
 * import libs + headers) from the dated autobuild release (the same FFmpeg commit the D10.0.1 spike used from the
 * rolling `latest`, whose assets are replaced daily; a dated release keeps its zip) into video-helper/deps/ffmpeg
 * (gitignored). The sha256 is pinned in video-helper/ffmpeg.sha256 (tracked); every run checks the download against
 * it, so everyone building the helper links the same bytes (the GPL offer E5 names this build). To move the pin,
 * change TAG and NAME, delete ffmpeg.sha256 and rerun (the first run writes the sha it saw). Windows only (extraction uses Windows' own tar.exe, which reads zip).
 * No dependencies.
 */
/* global fetch */
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const NAME = 'ffmpeg-n8.1.3-34-ga35157abb9-win64-gpl-shared-8.1';
const TAG = 'autobuild-2026-11-06-12-50'; // a dated autobuild release: its assets never change, unlike `latest`
const URL_ = `https://github.com/BtbN/FFmpeg-Builds/releases/download/${TAG}/${NAME}.zip`;
const helperDir = resolve(fileURLToPath(new URL('.', import.meta.url)));
const depsDir = resolve(helperDir, 'deps');
const outDir = join(depsDir, 'ffmpeg');
const pinFile = join(helperDir, 'ffmpeg.sha256');
const force = process.argv.includes('--force');

async function main() {
  if (process.platform !== 'win32') throw new Error('Windows only');
  const pinned = existsSync(pinFile) ? readFileSync(pinFile, 'utf8').trim().split(/\s+/)[0] : null;
  const stamp = join(outDir, 'SHA256');
  if (!force && pinned && existsSync(stamp) && readFileSync(stamp, 'utf8').trim() === pinned && existsSync(join(outDir, 'include', 'libavcodec', 'avcodec.h'))) {
    console.log(`ffmpeg ${NAME} already in ${outDir} (sha256 ${pinned.slice(0, 12)}...)`);
    return;
  }
  mkdirSync(depsDir, { recursive: true });
  console.log(`fetching ${URL_}`);
  const res = await fetch(URL_, { redirect: 'follow' });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const zip = Buffer.from(await res.arrayBuffer());
  const got = createHash('sha256').update(zip).digest('hex');
  if (pinned && got !== pinned) throw new Error(`sha256 mismatch: got ${got}, pinned ${pinned} (delete ${pinFile} to move the pin)`);
  if (!pinned) {
    writeFileSync(pinFile, `${got}  ${NAME}.zip\n`);
    console.log(`pinned sha256 ${got} in ${pinFile}`);
  }
  const zipPath = join(depsDir, `${NAME}.zip`);
  writeFileSync(zipPath, zip);
  const work = join(depsDir, 'ffmpeg-extract');
  rmSync(work, { recursive: true, force: true });
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  execFileSync(tar, ['-xf', zipPath, '-C', work], { stdio: ['ignore', 'inherit', 'inherit'] });
  const top = readdirSync(work).find((d) => d.startsWith('ffmpeg'));
  if (!top) throw new Error('unexpected zip layout');
  renameSync(join(work, top), outDir);
  rmSync(work, { recursive: true, force: true });
  rmSync(zipPath, { force: true });
  writeFileSync(stamp, `${got}\n`);
  console.log(`wrote ${outDir} (bin/, include/, lib/; sha256 ok)`);
}

main().catch((err) => {
  console.error(`fetch-ffmpeg: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
