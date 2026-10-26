#!/usr/bin/env node
/**
 * fetch-maps.mjs — fetch the pinned tomlogic/pinmame-nvram-maps corpus for bundling.
 *
 *   node companion/scripts/fetch-maps.mjs [--commit <sha>] [--out companion/resources/maps]
 *
 * Does a shallow `git fetch` of exactly one commit (default: the commit CI pins in
 * .github/workflows/ci.yml), copies what the companion needs into the out dir (index.json,
 * romnames.json, maps/, platforms/, LICENSE-ODbL.md, LICENSE-DbCL, README.md) and writes a
 * VERSION file holding the commit, which the witness module reports as `mapsVersion`.
 * The out dir is wiped first. Node built-ins only; needs `git` on PATH.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const DEFAULT_COMMIT = 'f0c422099f0b50b69bfdf6d071a6653a8b25a6fd';
const REPO_URL = 'https://github.com/tomlogic/pinmame-nvram-maps';
const KEEP = ['index.json', 'romnames.json', 'maps', 'platforms', 'LICENSE-ODbL.md', 'LICENSE-DbCL', 'README.md'];

const companionDir = resolve(fileURLToPath(new URL('..', import.meta.url)));

function parseArgs(argv) {
  const opts = { commit: DEFAULT_COMMIT, out: join(companionDir, 'resources', 'maps'), url: REPO_URL };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--commit') opts.commit = next();
    else if (a === '--out') opts.out = resolve(next());
    else if (a === '--url') opts.url = next();
    else if (a === '-h' || a === '--help') {
      console.log('usage: fetch-maps.mjs [--commit <sha>] [--out <dir>] [--url <git url>]');
      process.exit(0);
    } else throw new Error(`unknown argument ${a}`);
  }
  if (!/^[0-9a-f]{7,40}$/i.test(opts.commit)) throw new Error(`--commit must be a git sha, got ${opts.commit}`);
  return opts;
}

function git(cwd, ...args) {
  // The corpus is LF; keep it that way regardless of the machine's autocrlf setting.
  return execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' }).trim();
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const work = mkdtempSync(join(tmpdir(), 'castcade-maps-'));
  try {
    console.log(`fetching ${opts.url} @ ${opts.commit}`);
    git(work, 'init', '-q');
    git(work, 'remote', 'add', 'origin', opts.url);
    git(work, 'fetch', '-q', '--depth', '1', 'origin', opts.commit);
    git(work, 'checkout', '-q', 'FETCH_HEAD');
    const head = git(work, 'rev-parse', 'HEAD');

    rmSync(opts.out, { recursive: true, force: true });
    mkdirSync(opts.out, { recursive: true });
    let copied = 0;
    for (const name of KEEP) {
      const src = join(work, name);
      if (!existsSync(src)) {
        console.warn(`  (missing in corpus: ${name})`);
        continue;
      }
      cpSync(src, join(opts.out, name), { recursive: true });
      copied++;
    }
    writeFileSync(join(opts.out, 'VERSION'), `${head}\n`);
    console.log(`wrote ${copied} entries + VERSION (${head}) to ${opts.out}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

try {
  main();
} catch (err) {
  console.error(`fetch-maps: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
