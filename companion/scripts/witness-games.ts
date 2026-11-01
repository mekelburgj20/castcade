/**
 * B14: write the platform-wide list of witness-supported games, docs/witness-games.json (for ArcAid)
 * and docs/witness-games.md (for tournament directors). Run from the repo root:
 *   npm run witness-games -w companion -- [--vps <index.json>] [--maps <dir>] [--fixtures <dir>] [--out <dir>]
 *   (or: npx tsx companion/scripts/witness-games.ts ...)
 * Defaults: companion/resources/vps/index.json and companion/resources/maps (both fetched, gitignored:
 * `npm run fetch-vps` / `fetch-maps`), fixtures/nvram (its folder names are the verified ROMs), docs.
 * Relative paths resolve against the directory npm was started from. Rerun after a corpus or VPS
 * pin moves, or a new fixture lands; the output only changes then (and in `generatedAt`).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { VpsIndexFile } from '../src/witness/identity-types.js';
import { createMapCorpus } from '../src/witness/maps.js';
import { buildSupportList, compactJson, preloadMaps, renderMarkdown } from '../src/witness/support-list.js';

const companionDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = resolve(companionDir, '..');
// `npm run -w companion` starts in companion/; INIT_CWD is where the user typed the command.
const cwd = process.env['INIT_CWD'] ?? process.cwd();

function parseArgs(argv: string[]): { vps: string; maps: string; fixtures: string; out: string } {
  const opts = {
    vps: join(companionDir, 'resources', 'vps', 'index.json'),
    maps: join(companionDir, 'resources', 'maps'),
    fixtures: join(repoDir, 'fixtures', 'nvram'),
    out: join(repoDir, 'docs'),
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i] ?? '';
    const key = flag.replace(/^--/, '');
    const value = argv[++i];
    if (!(key in opts) || !flag.startsWith('--') || value === undefined) {
      console.error('usage: witness-games [--vps <index.json>] [--maps <dir>] [--fixtures <dir>] [--out <dir>]');
      process.exit(2);
    }
    opts[key as keyof typeof opts] = resolve(cwd, value);
  }
  return opts;
}

const firstLine = (path: string): string | null => (existsSync(path) ? (readFileSync(path, 'utf8').split(/\r?\n/)[0]?.trim() ?? '') || null : null);

const opts = parseArgs(process.argv.slice(2));
const vps = JSON.parse(readFileSync(opts.vps, 'utf8')) as VpsIndexFile;
const corpus = createMapCorpus(opts.maps);
const { mapFor, mapFile, corpusRoms } = await preloadMaps(corpus, vps.games);
const verifiedRoms = new Set(
  readdirSync(opts.fixtures, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name.toLowerCase()),
);
const app = (JSON.parse(readFileSync(join(companionDir, 'package.json'), 'utf8')) as { version: string }).version;
const versions = {
  vps: firstLine(join(dirname(opts.vps), 'VERSION')) ?? vps.version ?? 'unknown',
  maps: firstLine(join(opts.maps, 'VERSION')) ?? 'unknown',
  app,
};
const list = buildSupportList({ vps, mapFor, mapFile, corpusRoms, verifiedRoms, versions, generatedAt: new Date().toISOString() });

mkdirSync(opts.out, { recursive: true });
writeFileSync(join(opts.out, 'witness-games.json'), JSON.stringify(compactJson(list), null, 2) + '\n');
writeFileSync(join(opts.out, 'witness-games.md'), renderMarkdown(list));
const { counts } = list;
console.log(`wrote ${join(opts.out, 'witness-games.json')} and witness-games.md: ${counts.games} games, ${counts.verified} verified, ${counts.supported} supported, ${counts.unsupported} unsupported, ${counts.romsFromCorpus} with ROMs from the corpus (VPS lists none), ${counts.romsAmbiguous} ambiguous`);
for (const n of counts.romsAmbiguousGames) console.log(`ambiguous (left as no ROM): ${n}`);
