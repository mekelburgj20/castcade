#!/usr/bin/env node
/**
 * ffmpeg-source.mjs — produce the GPL Corresponding Source for the bundled ffmpeg (E5; GPLv3 §6; docs/ffmpeg-source.md).
 *
 *   node companion/scripts/ffmpeg-source.mjs [--out companion/release] [--readme companion/resources/ffmpeg/README.txt]
 *
 * Reads the FFmpeg commit from the bundled build's README.txt (its `Source Code:` line), downloads FFmpeg at that
 * commit from GitHub, and writes ffmpeg-<version>-source.tar.gz plus ffmpeg-<version>-SOURCES.txt (the statically
 * linked libraries and their versions, verbatim from the same README.txt) into the out dir. release.yml uploads both
 * to the GitHub release on tag pushes. Run `npm run fetch-ffmpeg -w companion` first so README.txt exists.
 * It also writes ffmpeg-<version>-helper-source.tar.gz + ffmpeg-<version>-helper-SOURCES.txt for the FFmpeg DLLs of the
 * native video helper (HELPER_FFMPEG below; D10.1), a different build and version from the one above.
 */
/* global fetch */ // Node 22's built-in fetch
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const companionDir = resolve(fileURLToPath(new URL('..', import.meta.url)));
const LIBS_HEADER = /^release-\S+ external libraries' versions:/;

function parseArgs(argv) {
  const opts = {
    out: join(companionDir, 'release'),
    readme: join(companionDir, 'resources', 'ffmpeg', 'README.txt'),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out' || a === '--readme') {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      opts[a.slice(2)] = resolve(v);
    } else if (a === '-h' || a === '--help') {
      console.log('usage: ffmpeg-source.mjs [--out <dir>] [--readme <README.txt of the bundled build>]');
      process.exit(0);
    } else throw new Error(`unknown argument ${a}`);
  }
  return opts;
}

/** The build's README.txt → { commit, build, version, libs[] }; throws a message naming what is missing. */
function readBuildInfo(readmePath) {
  if (!existsSync(readmePath)) throw new Error(`${readmePath} not found (run: npm run fetch-ffmpeg -w companion)`);
  const lines = readFileSync(readmePath, 'utf8').split(/\r?\n/);
  const src = lines.map((l) => /^Source Code:\s*\S*\/commit\/([0-9a-f]{7,40})\s*$/i.exec(l)).find(Boolean);
  if (!src) throw new Error(`no "Source Code: .../commit/<sha>" line in ${readmePath}`);
  const ver = lines.map((l) => /^Version:\s*(\S+)/.exec(l)).find(Boolean);
  if (!ver) throw new Error(`no "Version:" line in ${readmePath}`);
  const at = lines.findIndex((l) => LIBS_HEADER.test(l));
  if (at < 0) throw new Error(`no "external libraries' versions:" section in ${readmePath}`);
  const libs = lines.slice(at + 1).filter((l) => l.trim() !== '');
  if (libs.length === 0) throw new Error(`the library list in ${readmePath} is empty`);
  return { commit: src[1], build: ver[1], version: ver[1].split('-')[0], libs };
}

/**
 * The FFmpeg shared build the native video helper bundles (D10.1; video-helper/fetch-ffmpeg.mjs): BtbN FFmpeg-Builds,
 * `ffmpeg-n8.1.3-34-ga35157abb9-win64-gpl-shared-8.1.zip` (dated release `autobuild-2026-11-06-12-50`). Its zip has no README, so the facts are pinned here, read from
 * `ffmpeg -version` of the pinned zip (sha256 in video-helper/ffmpeg.sha256). It differs from the Gyan build above
 * (8.1.1), hence a second tarball; the `-helper-` infix keeps the names apart and still matches release.yml's globs.
 * To move the pin: update these, the table in docs/ffmpeg-source.md, and video-helper/ffmpeg.sha256 together.
 */
const HELPER_FFMPEG = {
  version: '8.1.3',
  describe: 'n8.1.3-34-ga35157abb9-20261106',
  commit: 'a35157abb96167fd7308edc92b55408d5bb084b0',
  zip: 'ffmpeg-n8.1.3-34-ga35157abb9-win64-gpl-shared-8.1.zip', // release tag autobuild-2026-11-06-12-50
  zipSha256: '7fd8ec7024823185230e8989082be9f3af957ed300f5b8cd136d02ac139ddceb',
  // `--enable-*` flags of the build's configure line (minus gpl, version3, shared, pthreads, schannel, cuda-llvm).
  libs: `iconv zlib libxml2 libvmaf fontconfig libharfbuzz libfreetype libfribidi lcms2 vulkan libshaderc libdav1d libvorbis librav1e librsvg gmp lzma liblcevc-dec opencl amf libaom avisynth chromaprint libdavs2 libdvdread libdvdnav ffnvcodec frei0r libgme libkvazaar libaribb24 libaribcaption libass libbluray libjxl libmp3lame libopus libplacebo librist libssh libtheora libvpx libwebp libzmq lv2 libvpl openal liboapv libopencore-amrnb libopencore-amrwb libopenh264 libopenjpeg libopenmpt librubberband sdl2 libsnappy libsoxr libsrt libsvtav1 libtwolame libuavs3d vaapi vapoursynth libvidstab libvvenc libx264 libx265 libxavs2 libxvid libzimg libzvbi`.split(' '),
};

async function download(url) {
  console.log(`fetching ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** The second asset: FFmpeg at the helper build's commit + its library list. */
async function writeHelperSource(outDir) {
  const h = HELPER_FFMPEG;
  const pinFile = resolve(companionDir, '..', 'video-helper', 'ffmpeg.sha256');
  if (existsSync(pinFile)) {
    const pinned = readFileSync(pinFile, 'utf8').trim().split(/\s+/)[0];
    if (pinned !== h.zipSha256) {
      console.warn(`ffmpeg-source: WARNING video-helper/ffmpeg.sha256 (${pinned}) differs from HELPER_FFMPEG.zipSha256 (${h.zipSha256}); update HELPER_FFMPEG and docs/ffmpeg-source.md`);
    }
  }
  const tarPath = join(outDir, `ffmpeg-${h.version}-helper-source.tar.gz`);
  const listPath = join(outDir, `ffmpeg-${h.version}-helper-SOURCES.txt`);
  writeFileSync(tarPath, await download(`https://github.com/FFmpeg/FFmpeg/archive/${h.commit}.tar.gz`));
  writeFileSync(
    listPath,
    [
      'Corresponding Source for the FFmpeg libraries bundled with the Castcade native video helper (GPLv3 section 6).',
      `Build: BtbN FFmpeg-Builds, ${h.zip} (sha256 ${h.zipSha256}), FFmpeg ${h.describe}`,
      `FFmpeg commit: ${h.commit} (ffmpeg-${h.version}-helper-source.tar.gz is FFmpeg at that commit)`,
      'Bundled DLLs: avcodec, avutil, swscale, swresample. External libraries are linked into them; the build was configured with:',
      '',
      ...h.libs.map((l) => `--enable-${l}`),
      '',
      "Each library's source is the upstream release the FFmpeg-Builds scripts pinned at build time",
      '(https://github.com/BtbN/FFmpeg-Builds). See docs/ffmpeg-source.md in the repo.',
      '',
    ].join('\n'),
  );
  for (const p of [tarPath, listPath]) {
    const buf = readFileSync(p);
    console.log(`${p}\n  sha256 ${createHash('sha256').update(buf).digest('hex')}  ${buf.length} bytes`);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const info = readBuildInfo(opts.readme);
  const url = `https://github.com/FFmpeg/FFmpeg/archive/${info.commit}.tar.gz`;
  console.log(`fetching ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const tarball = Buffer.from(await res.arrayBuffer());

  mkdirSync(opts.out, { recursive: true });
  const tarPath = join(opts.out, `ffmpeg-${info.version}-source.tar.gz`);
  const listPath = join(opts.out, `ffmpeg-${info.version}-SOURCES.txt`);
  writeFileSync(tarPath, tarball);
  const header = [
    'Corresponding Source for the ffmpeg bundled with Castcade (GPLv3 section 6).',
    `Build: ${info.build}`,
    `FFmpeg commit: ${info.commit} (ffmpeg-${info.version}-source.tar.gz is FFmpeg at that commit)`,
    "The statically linked libraries and their versions follow, verbatim from the build's README.txt;",
    "each library's source is the upstream release at that version. See docs/ffmpeg-source.md in the repo.",
    '',
    "release-essentials external libraries' versions:",
    '',
  ];
  writeFileSync(listPath, [...header, ...info.libs, ''].join('\n'));

  for (const p of [tarPath, listPath]) {
    const buf = readFileSync(p);
    console.log(`${p}\n  sha256 ${createHash('sha256').update(buf).digest('hex')}  ${buf.length} bytes`);
  }
  await writeHelperSource(opts.out);
}

main().catch((err) => {
  console.error(`ffmpeg-source: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
