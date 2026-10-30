#!/usr/bin/env node
/**
 * fetch-ffmpeg.mjs — fetch the pinned ffmpeg build for bundling (D1.6; docs/design/solo-streaming-and-recording.md §2).
 *
 *   node companion/scripts/fetch-ffmpeg.mjs [--out companion/resources/ffmpeg] [--force]
 *
 * Downloads Gyan's "essentials" Windows build (GPLv3, static, no --enable-nonfree) from its GitHub release, checks
 * the zip's sha256 against the pin below, and copies ffmpeg.exe (capture, encode, stream, record), ffplay.exe (the
 * framing preview), LICENSE and README.txt (the build's configuration and source commit) into the out dir, plus a
 * SOURCE-OFFER.txt (GPLv3 written offer, E5; the source itself is `npm run ffmpeg-source -w companion`) and a VERSION file the companion reports. A matching VERSION already there skips the download (--force re-fetches).
 * The out dir is wiped first. Windows only: extraction uses Windows' own tar.exe (bsdtar reads zip).
 *
 * To move the pin: change VERSION + SHA256, run it, check the README's library list still has ddagrab, drawtext,
 * h264_nvenc / h264_amf / h264_qsv, tee and rtmp, and run the D1.0 spike against the new build.
 */
/* global fetch */ // Node 22's built-in fetch
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const VERSION = '8.1.1';
const FLAVOUR = 'essentials_build';
const SHA256 = '6f58ce889f59c311410f7d2b18895b33c03456463486f3b1ebc93d97a0f54541';
const NAME = `ffmpeg-${VERSION}-${FLAVOUR}`;
const URL_ = `https://github.com/GyanD/codexffmpeg/releases/download/${VERSION}/${NAME}.zip`;
const KEEP = [
  ['bin/ffmpeg.exe', 'ffmpeg.exe'],
  ['bin/ffplay.exe', 'ffplay.exe'],
  ['LICENSE', 'LICENSE'],
  ['README.txt', 'README.txt'],
];
/** Written by this script, not taken from the zip: the GPLv3 section 6(b) written offer that ships beside the binaries (E5). */
const GENERATED = ['SOURCE-OFFER.txt'];
const SOURCE_OFFER = [
  'This folder holds ffmpeg and ffplay, built by Gyan Doshi (www.gyan.dev) under the GNU GPL version 3 (see LICENSE).',
  'Written offer (GPLv3 section 6(b)): for three years from the date of the Castcade release you installed, anyone who',
  'holds this installer may obtain the Corresponding Source of these binaries, free of charge beyond the cost of transfer.',
  'Place 1: the assets ffmpeg-<version>-source.tar.gz and ffmpeg-<version>-SOURCES.txt on that release,',
  '  https://github.com/mekelburgj20/castcade/releases',
  'Place 2: docs/ffmpeg-source.md in https://github.com/mekelburgj20/castcade (or open an issue there to ask).',
  '',
].join('\n');
/** What VERSION holds; the companion reads its first line. */
const STAMP = `${NAME} sha256:${SHA256} ${URL_}\n`;

const companionDir = resolve(fileURLToPath(new URL('..', import.meta.url)));

function parseArgs(argv) {
  const opts = { out: join(companionDir, 'resources', 'ffmpeg'), force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') {
      const v = argv[++i];
      if (v === undefined) throw new Error('--out needs a value');
      opts.out = resolve(v);
    } else if (a === '--force') opts.force = true;
    else if (a === '-h' || a === '--help') {
      console.log('usage: fetch-ffmpeg.mjs [--out <dir>] [--force]');
      process.exit(0);
    } else throw new Error(`unknown argument ${a}`);
  }
  return opts;
}

async function main() {
  if (process.platform !== 'win32') throw new Error('Windows only (the bundle is Windows binaries; extraction uses the system tar)');
  const opts = parseArgs(process.argv.slice(2));
  const stampFile = join(opts.out, 'VERSION');
  if (!opts.force && existsSync(stampFile) && readFileSync(stampFile, 'utf8') === STAMP && [...KEEP.map(([, to]) => to), ...GENERATED].every((f) => existsSync(join(opts.out, f)))) {
    console.log(`ffmpeg ${NAME} already in ${opts.out}`);
    return;
  }
  const work = mkdtempSync(join(tmpdir(), 'castcade-ffmpeg-'));
  try {
    console.log(`fetching ${URL_}`);
    const res = await fetch(URL_, { redirect: 'follow' });
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    const zip = Buffer.from(await res.arrayBuffer());
    const got = createHash('sha256').update(zip).digest('hex');
    if (got !== SHA256) throw new Error(`sha256 mismatch: got ${got}, pinned ${SHA256}`);
    const zipPath = join(work, `${NAME}.zip`);
    writeFileSync(zipPath, zip);
    const members = KEEP.map(([from]) => `${NAME}/${from}`);
    // Windows' own bsdtar reads zip; a GNU tar earlier on PATH (Git Bash) does not, so name it.
    const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
    execFileSync(tar, ['-xf', `${NAME}.zip`, ...members], { cwd: work, stdio: ['ignore', 'inherit', 'inherit'] });

    rmSync(opts.out, { recursive: true, force: true });
    mkdirSync(opts.out, { recursive: true });
    for (const [from, to] of KEEP) copyFileSync(join(work, NAME, from), join(opts.out, to));
    writeFileSync(join(opts.out, 'SOURCE-OFFER.txt'), SOURCE_OFFER);
    writeFileSync(stampFile, STAMP);
    console.log(`wrote ${[...KEEP.map(([, to]) => to), ...GENERATED].join(', ')} + VERSION (${NAME}, sha256 ok) to ${opts.out}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`fetch-ffmpeg: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
