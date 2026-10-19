#!/usr/bin/env node
/**
 * fetch-vps.mjs — build the compact VPS index (`resources/vps/index.json`) from the Virtual
 * Pinball Spreadsheet database at a pinned commit.
 *
 *   node companion/scripts/fetch-vps.mjs [--commit <sha>] [--out companion/resources/vps]
 *                                        [--from <vpsdb.json>] [--subset <gameId,gameId,...>]
 *
 * Downloads `db/vpsdb.json` of VirtualPinballSpreadsheet/vps-db at exactly the pinned commit (a raw
 * GitHub URL, so no git is needed), or reads a local copy with `--from`, and writes the
 * `VpsIndexFile` shape of `companion/src/witness/identity-types.ts`: one entry per game that has a
 * name, with its PinMAME ROM ids and its table files reduced to id / authors / version / features /
 * format / comment / updatedAt. Download URLs, images and the rest of the sheet are dropped on
 * purpose: the repo declares no licence, so we keep only the identifiers and attribution the matcher
 * needs. `--subset` keeps only the listed game ids (and pretty-prints), which is how the committed
 * test fixture `fixtures/vps/index.json` is produced. The out dir is wiped first and gets a VERSION
 * file holding the commit, like fetch-maps.mjs. Node built-ins only.
 *
 * The downloaded file is untrusted data: it is parsed as JSON and every field is type-checked
 * before it is copied; nothing from it is executed or used as a path.
 */
/* global fetch */ // Node 22+ (the engines field) has fetch built in.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const DEFAULT_COMMIT = 'cce9160b30110ee174786239fdfb30a6e4caaab7';
const RAW_BASE = 'https://raw.githubusercontent.com/VirtualPinballSpreadsheet/vps-db';
const DB_PATH = 'db/vpsdb.json';

const companionDir = resolve(fileURLToPath(new URL('..', import.meta.url)));

function parseArgs(argv) {
  const opts = { commit: DEFAULT_COMMIT, out: join(companionDir, 'resources', 'vps'), from: null, subset: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--commit') opts.commit = next();
    else if (a === '--out') opts.out = resolve(next());
    else if (a === '--from') opts.from = resolve(next());
    else if (a === '--subset') opts.subset = new Set(next().split(',').map((s) => s.trim()).filter(Boolean));
    else if (a === '-h' || a === '--help') {
      console.log('usage: fetch-vps.mjs [--commit <sha>] [--out <dir>] [--from <vpsdb.json>] [--subset <id,id,...>]');
      process.exit(0);
    } else throw new Error(`unknown argument ${a}`);
  }
  if (!/^[0-9a-f]{7,40}$/i.test(opts.commit)) throw new Error(`--commit must be a git sha, got ${opts.commit}`);
  return opts;
}

const str = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const strList = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === 'string' && s.trim() !== '').map((s) => s.trim()) : []);

/** One `tableFiles[]` record → `VpsTableEntry`, or null when it has no id. */
function tableEntry(t) {
  if (typeof t !== 'object' || t === null) return null;
  const id = str(t.id);
  if (!id) return null;
  return {
    id,
    authors: strList(t.authors),
    version: str(t.version),
    features: strList(t.features),
    format: str(t.tableFormat),
    comment: str(t.comment),
    updatedAt: num(t.updatedAt),
  };
}

/** One game record → `VpsGameEntry`, or null when it has no id or name. */
function gameEntry(g) {
  if (typeof g !== 'object' || g === null) return null;
  const id = str(g.id);
  const name = str(g.name);
  if (!id || !name) return null;
  const roms = [];
  for (const r of Array.isArray(g.romFiles) ? g.romFiles : []) {
    const rom = typeof r === 'object' && r !== null ? str(r.version) : null;
    if (rom && !roms.includes(rom.toLowerCase())) roms.push(rom.toLowerCase());
  }
  const tables = (Array.isArray(g.tableFiles) ? g.tableFiles : []).map(tableEntry).filter((t) => t !== null);
  return {
    id,
    name,
    manufacturer: str(g.manufacturer),
    year: num(g.year),
    type: str(g.type),
    roms,
    tables,
  };
}

/** The whole database → `VpsIndexFile` (`games` in source order, optionally limited to `subset`). */
function buildIndex(db, { version, subset = null, generatedAt = new Date().toISOString() }) {
  if (!Array.isArray(db)) throw new Error('vpsdb.json: expected a top-level array of games');
  const games = [];
  for (const raw of db) {
    const game = gameEntry(raw);
    if (!game) continue;
    if (subset && !subset.has(game.id)) continue;
    games.push(game);
  }
  if (subset) {
    for (const id of subset) if (!games.some((g) => g.id === id)) console.warn(`  (subset id not in the database: ${id})`);
  }
  return { version, generatedAt, games };
}

async function load(opts) {
  if (opts.from) {
    console.log(`reading ${opts.from}`);
    return JSON.parse(readFileSync(opts.from, 'utf8'));
  }
  const url = `${RAW_BASE}/${opts.commit}/${DB_PATH}`;
  console.log(`fetching ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return JSON.parse(await res.text());
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const db = await load(opts);
  const index = buildIndex(db, { version: opts.commit, subset: opts.subset });
  const tables = index.games.reduce((n, g) => n + g.tables.length, 0);

  rmSync(opts.out, { recursive: true, force: true });
  mkdirSync(opts.out, { recursive: true });
  // The full index is compact (it ships in the installer); a subset is a committed fixture, so it is
  // pretty-printed for readable diffs.
  const text = opts.subset ? JSON.stringify(index, null, 2) : JSON.stringify(index);
  writeFileSync(join(opts.out, 'index.json'), `${text}\n`);
  writeFileSync(join(opts.out, 'VERSION'), `${opts.commit}\n`);
  console.log(`wrote index.json (${index.games.length} games, ${tables} table files, ${(text.length / 1024).toFixed(0)} KB) + VERSION (${opts.commit}) to ${opts.out}`);
}

main().catch((err) => {
  console.error(`fetch-vps: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
