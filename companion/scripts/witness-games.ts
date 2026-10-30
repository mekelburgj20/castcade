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
import { buildSupportList, NO_PLATFORM, preloadMaps, type GameSupport, type SupportList, type SupportStatus } from '../src/witness/support-list.js';

const JSON_URL = 'https://raw.githubusercontent.com/mekelburgj20/castcade/main/docs/witness-games.json';

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

const STATUS_ORDER: Record<SupportStatus, number> = { verified: 0, supported: 1, unsupported: 2 };
const cell = (v: string | number | null): string => (v === null ? '' : String(v).replace(/\|/g, '\\|'));
const readable = (c: { verified: number; supported: number }): number => c.verified + c.supported;

function markdown(list: SupportList): string {
  const { counts, versions } = list;
  const lines: string[] = [
    '# Witness-supported games',
    '',
    'Which VPX tables the Castcade desktop companion can score for Arcaid Witness on its own. A game is **supported** when the companion reads its machine\'s live score, game over, current ball and current player from NVRAM (a Stern SAM machine: its scores and the end-of-game record it writes), so every game played on it posts by itself as it ends. **Verified** means supported, and a real game was recorded on that ROM and replays in CI. **Unsupported** means the companion cannot follow a game on it, and the Reason column says why: no ROM (an original or electro-mechanical table, which needs a table-script recipe), no map for the ROM in pinmame-nvram-maps, or which live fields the map leaves out or keeps in CPU RAM, where the companion cannot see them.',
    '',
    `This list is about Witness scoring of VPX tables by the desktop companion, not Castcade matches. Each row is one game of the Virtual Pinball Spreadsheet that has a VPX table; its status is the best of the ROMs VPS lists for it, so a table that runs another ROM revision can differ. The JSON next to this page is the same list for ArcAid: ${JSON_URL}. Regenerate both with \`npm run witness-games -w companion\` (WORK item B14).`,
    '',
    '## Versions',
    '',
    `- Generated: ${list.generatedAt}`,
    `- VPS database (vps-db commit): \`${versions.vps}\``,
    `- NVRAM maps (pinmame-nvram-maps commit): \`${versions.maps}\``,
    `- Castcade companion: ${versions.app}`,
    '',
    '## Counts',
    '',
    '| Platform | Verified | Supported | Unsupported | Games |',
    '|---|---:|---:|---:|---:|',
  ];
  const platforms = Object.entries(counts.byPlatform).sort(
    ([a, x], [b, y]) => Number(a === NO_PLATFORM) - Number(b === NO_PLATFORM) || readable(y) - readable(x) || a.localeCompare(b, 'en'),
  );
  for (const [name, c] of platforms) {
    lines.push(`| ${name === NO_PLATFORM ? 'no map' : name} | ${c.verified} | ${c.supported} | ${c.unsupported} | ${c.verified + c.supported + c.unsupported} |`);
  }
  lines.push(`| **All** | **${counts.verified}** | **${counts.supported}** | **${counts.unsupported}** | **${counts.games}** |`, '');
  lines.push('### Why unsupported', '', '| Reason | Games |', '|---|---:|');
  for (const [reason, n] of Object.entries(counts.byReason).sort(([a, x], [b, y]) => y - x || a.localeCompare(b, 'en'))) {
    lines.push(`| ${cell(reason)} | ${n} |`);
  }
  lines.push('');

  const byPlatform = new Map<string, GameSupport[]>();
  for (const g of list.games) {
    const key = g.platform ?? NO_PLATFORM;
    byPlatform.set(key, [...(byPlatform.get(key) ?? []), g]);
  }
  for (const [name, c] of platforms) {
    const games = [...(byPlatform.get(name) ?? [])].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
    const title = name === NO_PLATFORM ? 'No map (no ROM, or no map for its ROMs)' : name;
    lines.push(`## ${title}`, '', `${c.verified} verified, ${c.supported} supported, ${c.unsupported} unsupported.`, '');
    lines.push('| Game | Manufacturer | Year | ROMs | Status | Reason |', '|---|---|---:|---|---|---|');
    for (const g of games) {
      lines.push(`| ${cell(g.name)} | ${cell(g.manufacturer)} | ${cell(g.year)} | ${cell(g.roms.map((r) => r.rom).join(', '))} | ${g.status} | ${cell(g.reason)} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

const opts = parseArgs(process.argv.slice(2));
const vps = JSON.parse(readFileSync(opts.vps, 'utf8')) as VpsIndexFile;
const corpus = createMapCorpus(opts.maps);
const { mapFor, mapFile } = await preloadMaps(corpus, vps.games);
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
const list = buildSupportList({ vps, mapFor, mapFile, verifiedRoms, versions, generatedAt: new Date().toISOString() });

mkdirSync(opts.out, { recursive: true });
writeFileSync(join(opts.out, 'witness-games.json'), JSON.stringify(list, null, 2) + '\n');
writeFileSync(join(opts.out, 'witness-games.md'), markdown(list));
const { counts } = list;
console.log(`wrote ${join(opts.out, 'witness-games.json')} and witness-games.md: ${counts.games} games, ${counts.verified} verified, ${counts.supported} supported, ${counts.unsupported} unsupported`);
