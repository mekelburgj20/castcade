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
}

main().catch((err) => {
  console.error(`ffmpeg-source: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
