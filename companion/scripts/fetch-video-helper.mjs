#!/usr/bin/env node
/**
 * fetch-video-helper.mjs — fetch the native spectator-video helper for bundling (D10.1; video-helper/, docs/design/spectator-video-native.md §6.2).
 *
 *   node companion/scripts/fetch-video-helper.mjs [--out companion/resources/video-helper] [--force]
 *   node companion/scripts/fetch-video-helper.mjs --from video-helper/build/Release      (a local CMake build; canonical form: relative to the repo root)
 *
 * Downloads castcade-video-<TAG>-win-x64.zip, which .github/workflows/video-helper.yml attaches to the castcade GitHub
 * release on every `v*` tag, checks its sha256 against the pin below, and copies castcade-video.exe, the FFmpeg DLLs
 * beside it (every *.dll in the zip) and THIRD-PARTY.md into the out dir, plus a VERSION file. A matching VERSION
 * already there skips the download (--force re-fetches). `--from <dir>` copies the same files from a local build
 * instead (always; no download); a relative path is tried against the repo root first, then the companion folder, then
 * the current directory, so it works both from the root and under `npm run ... -w companion`. The out dir is wiped
 * first. Windows only: extraction uses Windows' own tar.exe (bsdtar reads zip).
 *
 * No release carries the zip yet (TAG = null): the script says so and exits 0 without touching the out dir, so
 * packaging still works; the app then reports the native video path as unavailable. release.yml builds the helper
 * from its own tag and uses `--from`, so installers carry it regardless.
 *
 * To move the pin: set TAG to a release that carries the zip, run this once with SHA256 = null, and paste the hash it
 * prints into SHA256.
 */
/* global fetch */ // Node 22's built-in fetch
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

// A release's own installer cannot carry its own tag's zip (both workflows run at once), so TAG names an earlier release.
const TAG = 'v0.2.37';
// null means "not pinned yet" (the download is used, with a warning and the hash to pin printed).
const SHA256 = '0f78ed1a29453ee1dcbf3afbc4946a3ff817c604890a9aab422eb0091a654a6e';
/** Always required; every *.dll beside the exe (the FFmpeg shared libraries) is copied too. */
const REQUIRED = ['castcade-video.exe', 'THIRD-PARTY.md'];

const companionDir = resolve(fileURLToPath(new URL('..', import.meta.url)));
const repoRoot = resolve(companionDir, '..');

function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** A --from path → the first existing directory among: as given if absolute, else repo root, companion folder, cwd. */
function resolveFrom(p) {
  const candidates = isAbsolute(p) ? [p] : [resolve(repoRoot, p), resolve(companionDir, p), resolve(p)];
  const hit = candidates.find(isDir);
  if (!hit) throw new Error(`--from ${p}: no such directory (tried ${[...new Set(candidates)].join(' ; ')})`);
  return hit;
}

function parseArgs(argv) {
  const opts = { out: join(companionDir, 'resources', 'video-helper'), force: false, from: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      opts.out = resolve(v);
    } else if (a === '--from') {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      opts.from = resolveFrom(v);
    } else if (a === '--force') opts.force = true;
    else if (a === '-h' || a === '--help') {
      console.log('usage: fetch-video-helper.mjs [--out <dir>] [--force] | --from <local build dir, relative to the repo root, e.g. video-helper/build/Release> [--out <dir>]');
      process.exit(0);
    } else throw new Error(`unknown argument ${a}`);
  }
  return opts;
}

function install(srcDir, out, stamp) {
  const missing = REQUIRED.filter((f) => !existsSync(join(srcDir, f)));
  if (missing.length) throw new Error(`${srcDir} lacks ${missing.join(', ')} (build the helper first: see video-helper/ and .github/workflows/video-helper.yml)`);
  const dlls = readdirSync(srcDir).filter((f) => f.toLowerCase().endsWith('.dll'));
  if (dlls.length === 0) throw new Error(`${srcDir} has no FFmpeg *.dll files beside castcade-video.exe`);
  const keep = [...REQUIRED, ...dlls];
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  for (const f of keep) copyFileSync(join(srcDir, f), join(out, f));
  writeFileSync(join(out, 'VERSION'), stamp);
  console.log(`wrote ${keep.join(', ')} + VERSION (${stamp.split(/\s+/)[0]}) to ${out}`);
}

async function main() {
  if (process.platform !== 'win32') throw new Error('Windows only (the helper is a Windows binary; extraction uses the system tar)');
  const opts = parseArgs(process.argv.slice(2));
  if (opts.from) {
    install(opts.from, opts.out, `local ${opts.from}\n`);
    return;
  }
  if (TAG === null) {
    console.log(
      'fetch-video-helper: no release carries castcade-video yet (TAG is not pinned in scripts/fetch-video-helper.mjs); nothing fetched. ' +
        'Build it (pwsh video-helper/fetch-webrtc.ps1, node video-helper/fetch-ffmpeg.mjs, cmake -S video-helper -B video-helper/build -A x64, ' +
        'cmake --build video-helper/build --config Release) and run this with --from video-helper/build/Release, or package without it: ' +
        'the native spectator video path is then unavailable.',
    );
    return;
  }
  const name = `castcade-video-${TAG}-win-x64`;
  const url = `https://github.com/mekelburgj20/castcade/releases/download/${TAG}/${name}.zip`;
  /** What VERSION holds; only its first line is compared (an unpinned fetch adds the hash it got on a second line). */
  const stampHead = `${name} sha256:${SHA256 ?? 'unpinned'} ${url}`;
  const stampFile = join(opts.out, 'VERSION');
  if (!opts.force && existsSync(stampFile) && readFileSync(stampFile, 'utf8').split('\n')[0] === stampHead && REQUIRED.every((f) => existsSync(join(opts.out, f)))) {
    console.log(`video-helper ${name} already in ${opts.out}`);
    return;
  }
  const work = mkdtempSync(join(tmpdir(), 'castcade-video-'));
  try {
    console.log(`fetching ${url}`);
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status} (does release ${TAG} carry ${name}.zip yet?)`);
    const zip = Buffer.from(await res.arrayBuffer());
    const got = createHash('sha256').update(zip).digest('hex');
    if (SHA256 === null) console.warn(`fetch-video-helper: WARNING ${name}.zip is not pinned yet; pin it with SHA256 = '${got}'`);
    else if (got !== SHA256) throw new Error(`sha256 mismatch: got ${got}, pinned ${SHA256}`);
    writeFileSync(join(work, `${name}.zip`), zip);
    // Windows' own bsdtar reads zip; a GNU tar earlier on PATH (Git Bash) does not, so name it.
    const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
    const unpacked = join(work, 'unpacked');
    mkdirSync(unpacked);
    execFileSync(tar, ['-xf', join(work, `${name}.zip`), '-C', unpacked], { stdio: ['ignore', 'inherit', 'inherit'] });
    install(unpacked, opts.out, SHA256 === null ? `${stampHead}\ngot sha256:${got}\n` : `${stampHead}\n`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`fetch-video-helper: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1; // not process.exit(): with fetch handles still closing, Node 22 on Windows can abort on a libuv assert
});
