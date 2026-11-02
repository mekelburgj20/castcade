/**
 * fetch-vps.ts — build the compact VPS index (`resources/vps/index.json`) from the Virtual
 * Pinball Spreadsheet database at a pinned commit.
 *
 *   npm run fetch-vps -w companion -- [--commit <sha>] [--out companion/resources/vps]
 *                                     [--from <vpsdb.json>] [--subset <gameId,gameId,...>]
 *   (or: npx tsx companion/scripts/fetch-vps.ts ...)
 *
 * Downloads `db/vpsdb.json` of VirtualPinballSpreadsheet/vps-db at exactly the pinned commit (a raw
 * GitHub URL, so no git is needed), or reads a local copy with `--from`, and writes the
 * `VpsIndexFile` shape of `companion/src/witness/identity-types.ts` through the one builder in
 * `companion/src/witness/vps-build.ts` (the same code the running app uses when it refreshes the
 * index from vps-db `main`, B24). `--subset` keeps only the listed game ids (and pretty-prints),
 * which is how the committed test fixture `fixtures/vps/index.json` is produced. The out dir is wiped
 * first and gets a VERSION file holding the commit, like fetch-maps.mjs. Runs under tsx (a root
 * devDependency) so it needs no build: release.yml runs it before `npm run build`.
 *
 * The pin is the installer's starting point only: the app refreshes daily from `main` into its
 * userData, so bump it at a release to shorten the first day's gap, not to pick up a new table.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIndex, countTables } from '../src/witness/vps-build.js';

/** vps-db `main` HEAD of 2026-11-02T02:48:26Z ("UPDATE DB: (263b45a) update"). */
const DEFAULT_COMMIT = '70e1ff8e35117c12fc63d7e43673e42f77849a81';
const RAW_BASE = 'https://raw.githubusercontent.com/VirtualPinballSpreadsheet/vps-db';
const DB_PATH = 'db/vpsdb.json';

const companionDir = resolve(fileURLToPath(new URL('..', import.meta.url)));
// `npm run -w companion` starts in companion/; INIT_CWD is where the user typed the command.
const cwd = process.env['INIT_CWD'] ?? process.cwd();

interface Options {
  commit: string;
  out: string;
  from: string | null;
  subset: Set<string> | null;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { commit: DEFAULT_COMMIT, out: join(companionDir, 'resources', 'vps'), from: null, subset: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--commit') opts.commit = next();
    else if (a === '--out') opts.out = resolve(cwd, next());
    else if (a === '--from') opts.from = resolve(cwd, next());
    else if (a === '--subset') opts.subset = new Set(next().split(',').map((s) => s.trim()).filter(Boolean));
    else if (a === '-h' || a === '--help') {
      console.log('usage: fetch-vps [--commit <sha>] [--out <dir>] [--from <vpsdb.json>] [--subset <id,id,...>]');
      process.exit(0);
    } else throw new Error(`unknown argument ${a}`);
  }
  if (!/^[0-9a-f]{7,40}$/i.test(opts.commit)) throw new Error(`--commit must be a git sha, got ${opts.commit}`);
  return opts;
}

async function load(opts: Options): Promise<unknown> {
  if (opts.from) {
    console.log(`reading ${opts.from}`);
    return JSON.parse(readFileSync(opts.from, 'utf8')) as unknown;
  }
  const url = `${RAW_BASE}/${opts.commit}/${DB_PATH}`;
  console.log(`fetching ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return JSON.parse(await res.text()) as unknown;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const db = await load(opts);
  const index = buildIndex(db, { version: opts.commit, subset: opts.subset, onMissing: (id) => console.warn(`  (subset id not in the database: ${id})`) });
  const tables = countTables(index);

  rmSync(opts.out, { recursive: true, force: true });
  mkdirSync(opts.out, { recursive: true });
  // The full index is compact (it ships in the installer); a subset is a committed fixture, so it is
  // pretty-printed for readable diffs.
  const text = opts.subset ? JSON.stringify(index, null, 2) : JSON.stringify(index);
  writeFileSync(join(opts.out, 'index.json'), `${text}\n`);
  writeFileSync(join(opts.out, 'VERSION'), `${opts.commit}\n`);
  console.log(`wrote index.json (${index.games.length} games, ${tables} table files, ${(text.length / 1024).toFixed(0)} KB) + VERSION (${opts.commit}) to ${opts.out}`);
}

main().catch((err: unknown) => {
  console.error(`fetch-vps: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
