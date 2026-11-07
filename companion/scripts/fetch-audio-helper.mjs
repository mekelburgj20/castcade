#!/usr/bin/env node
/**
 * fetch-audio-helper.mjs — fetch the table-sound helper for bundling (D2.8; audio-helper/README.md).
 *
 *   node companion/scripts/fetch-audio-helper.mjs [--out companion/resources/audio-helper] [--force]
 *   node companion/scripts/fetch-audio-helper.mjs --from audio-helper/build/Release      (a local CMake build)
 *
 * Downloads castcade-audio-<TAG>-win-x64.zip, which .github/workflows/audio-helper.yml attaches to the castcade GitHub
 * release on every `v*` tag, checks its sha256 against the pin below, and copies castcade-audio.exe into the out dir,
 * plus a VERSION file. A matching VERSION already there skips the download (--force re-fetches). `--from <dir>` copies
 * the exe from a local build instead (always; no download). The out dir is wiped first. Windows only: extraction uses
 * Windows' own tar.exe (bsdtar reads zip).
 *
 * No release carries the zip yet (TAG = null): the script says so and exits 0 without touching the out dir, so
 * packaging still works; the app then reports table sound as unavailable (`helper_missing`). release.yml builds the
 * helper from its own tag and uses `--from`, so installers carry it regardless.
 *
 * To move the pin: set TAG to a release that carries the zip, run this once with SHA256 = null, and paste the hash it
 * prints into SHA256.
 */
/* global fetch */ // Node 22's built-in fetch
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

// The first zip appears with the first release tagged after D2.8 lands; set TAG to it then (a release's own installer
// cannot carry its own tag's zip, both workflows run at once, so TAG names an earlier release).
const TAG = 'v0.2.38';
// null means "not pinned yet" (the download is used, with a warning and the hash to pin printed).
const SHA256 = '97aa9360aa4a5b273401d0ebc1d463d8e338b89aba83ccb6a7e8171aacf3d12c';
const KEEP = ['castcade-audio.exe'];

const companionDir = resolve(fileURLToPath(new URL('..', import.meta.url)));

function parseArgs(argv) {
  const opts = { out: join(companionDir, 'resources', 'audio-helper'), force: false, from: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out' || a === '--from') {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      opts[a.slice(2)] = resolve(v);
    } else if (a === '--force') opts.force = true;
    else if (a === '-h' || a === '--help') {
      console.log('usage: fetch-audio-helper.mjs [--out <dir>] [--force] | --from <local build dir> [--out <dir>]');
      process.exit(0);
    } else throw new Error(`unknown argument ${a}`);
  }
  return opts;
}

function install(srcDir, out, stamp) {
  const missing = KEEP.filter((f) => !existsSync(join(srcDir, f)));
  if (missing.length) throw new Error(`${srcDir} lacks ${missing.join(', ')}`);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  for (const f of KEEP) copyFileSync(join(srcDir, f), join(out, f));
  writeFileSync(join(out, 'VERSION'), stamp);
  console.log(`wrote ${KEEP.join(', ')} + VERSION (${stamp.split(/\s+/)[0]}) to ${out}`);
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
      'fetch-audio-helper: no release carries castcade-audio yet (TAG is not pinned in scripts/fetch-audio-helper.mjs); nothing fetched. ' +
        'Build it (cmake -S audio-helper -B audio-helper/build -A x64, then cmake --build audio-helper/build --config Release) and run this with ' +
        '--from audio-helper/build/Release, or package without it: table sound then reads "unavailable".',
    );
    return;
  }
  const name = `castcade-audio-${TAG}-win-x64`;
  const url = `https://github.com/mekelburgj20/castcade/releases/download/${TAG}/${name}.zip`;
  /** What VERSION holds; only its first line is compared (an unpinned fetch adds the hash it got on a second line). */
  const stampHead = `${name} sha256:${SHA256 ?? 'unpinned'} ${url}`;
  const stampFile = join(opts.out, 'VERSION');
  if (!opts.force && existsSync(stampFile) && readFileSync(stampFile, 'utf8').split('\n')[0] === stampHead && KEEP.every((f) => existsSync(join(opts.out, f)))) {
    console.log(`audio-helper ${name} already in ${opts.out}`);
    return;
  }
  const work = mkdtempSync(join(tmpdir(), 'castcade-audio-'));
  try {
    console.log(`fetching ${url}`);
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status} (does release ${TAG} carry ${name}.zip yet?)`);
    const zip = Buffer.from(await res.arrayBuffer());
    const got = createHash('sha256').update(zip).digest('hex');
    if (SHA256 === null) console.warn(`fetch-audio-helper: WARNING ${name}.zip is not pinned yet; pin it with SHA256 = '${got}'`);
    else if (got !== SHA256) throw new Error(`sha256 mismatch: got ${got}, pinned ${SHA256}`);
    writeFileSync(join(work, `${name}.zip`), zip);
    // Windows' own bsdtar reads zip; a GNU tar earlier on PATH (Git Bash) does not, so name it.
    const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
    const unpacked = join(work, 'unpacked');
    mkdirSync(unpacked);
    execFileSync(tar, ['-xf', join(work, `${name}.zip`), '-C', unpacked, ...KEEP], { stdio: ['ignore', 'inherit', 'inherit'] });
    install(unpacked, opts.out, SHA256 === null ? `${stampHead}\ngot sha256:${got}\n` : `${stampHead}\n`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`fetch-audio-helper: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1; // not process.exit(): with fetch handles still closing, Node 22 on Windows can abort on a libuv assert
});
