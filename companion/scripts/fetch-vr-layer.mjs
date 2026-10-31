#!/usr/bin/env node
/**
 * fetch-vr-layer.mjs — fetch the OpenXR panel layer for bundling (D7.3; vr-layer/README.md).
 *
 *   node companion/scripts/fetch-vr-layer.mjs [--out companion/resources/vr-layer] [--force]
 *   node companion/scripts/fetch-vr-layer.mjs --from vr-layer/build/Release      (a local CMake build)
 *
 * Downloads castcade-vr-layer-<TAG>-win-x64.zip, which .github/workflows/vr-layer.yml attaches to the castcade GitHub
 * release on every `v*` tag, checks its sha256 against the pin below, and copies XrApiLayer_castcade_panel.dll, its
 * manifest XrApiLayer_castcade_panel.json and THIRD-PARTY.md into the out dir, plus a VERSION file. A matching VERSION
 * already there skips the download (--force re-fetches). `--from <dir>` copies those three files from a local build
 * instead (always; no download). The out dir is wiped first. Windows only: extraction uses Windows' own tar.exe
 * (bsdtar reads zip). The release workflow builds the layer from its own tag and uses `--from`.
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

// The first zip appears with the first release tagged after D7.3 lands (the vr-layer workflow attaches it when that tag
// is pushed); a release's own installer cannot carry its own tag's zip (both workflows run at once), so TAG names an
// earlier release. Until then a download fails with "does release … carry …": use --from with a local or CI build.
const TAG = 'v0.2.27';
// sha256 pinning starts at the first pinned zip: null means "not pinned yet" (the download is used, with a warning
// and the hash to pin printed). Set it as soon as the zip exists.
const SHA256 = '7cadf9284eaf950f4292929fe981c166d1d2d460c9d8fb4e15dc0c81683622cd';
const NAME = `castcade-vr-layer-${TAG}-win-x64`;
const URL_ = `https://github.com/mekelburgj20/castcade/releases/download/${TAG}/${NAME}.zip`;
const KEEP = ['XrApiLayer_castcade_panel.dll', 'XrApiLayer_castcade_panel.json', 'THIRD-PARTY.md'];

const companionDir = resolve(fileURLToPath(new URL('..', import.meta.url)));

function parseArgs(argv) {
  const opts = { out: join(companionDir, 'resources', 'vr-layer'), force: false, from: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out' || a === '--from') {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      opts[a.slice(2)] = resolve(v);
    } else if (a === '--force') opts.force = true;
    else if (a === '-h' || a === '--help') {
      console.log('usage: fetch-vr-layer.mjs [--out <dir>] [--force] | --from <local build dir> [--out <dir>]');
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
  if (process.platform !== 'win32') throw new Error('Windows only (the layer is a Windows binary; extraction uses the system tar)');
  const opts = parseArgs(process.argv.slice(2));
  if (opts.from) {
    install(opts.from, opts.out, `local ${opts.from}\n`);
    return;
  }
  /** What VERSION holds; only its first line is compared (an unpinned fetch adds the hash it got on a second line). */
  const stampHead = `${NAME} sha256:${SHA256 ?? 'unpinned'} ${URL_}`;
  const stampFile = join(opts.out, 'VERSION');
  if (!opts.force && existsSync(stampFile) && readFileSync(stampFile, 'utf8').split('\n')[0] === stampHead && KEEP.every((f) => existsSync(join(opts.out, f)))) {
    console.log(`vr-layer ${NAME} already in ${opts.out}`);
    return;
  }
  const work = mkdtempSync(join(tmpdir(), 'castcade-vr-layer-'));
  try {
    console.log(`fetching ${URL_}`);
    const res = await fetch(URL_, { redirect: 'follow' });
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status} (does release ${TAG} carry ${NAME}.zip yet?)`);
    const zip = Buffer.from(await res.arrayBuffer());
    const got = createHash('sha256').update(zip).digest('hex');
    if (SHA256 === null) console.warn(`fetch-vr-layer: WARNING ${NAME}.zip is not pinned yet; pin it with SHA256 = '${got}'`);
    else if (got !== SHA256) throw new Error(`sha256 mismatch: got ${got}, pinned ${SHA256}`);
    writeFileSync(join(work, `${NAME}.zip`), zip);
    // Windows' own bsdtar reads zip; a GNU tar earlier on PATH (Git Bash) does not, so name it.
    const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
    const unpacked = join(work, 'unpacked');
    mkdirSync(unpacked);
    execFileSync(tar, ['-xf', join(work, `${NAME}.zip`), '-C', unpacked, ...KEEP], { stdio: ['ignore', 'inherit', 'inherit'] });
    install(unpacked, opts.out, SHA256 === null ? `${stampHead}\ngot sha256:${got}\n` : `${stampHead}\n`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`fetch-vr-layer: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1; // not process.exit(): with fetch handles still closing, Node 22 on Windows can abort on a libuv assert
});
