/**
 * Table identity, step two and three of F1: which VPS *game* a capture belongs to (`matchGame`), and
 * which of that game's VPS *table files* the `.vpx` on disk is (`matchTable`). Both are pure
 * functions over the evidence the companion already has (the ROM that changed, the file name, the
 * TableInfo strings) and the index; neither reads files or the network.
 *
 * The result is a badge, never a gate: an `ambiguous` or `none` outcome carries no pick and lists
 * the candidates for the player to choose from once; a wrong id would be worse than no id.
 */
import type {
  GameMatch,
  GameMatchEvidence,
  MatchConfidence,
  TableMatch,
  TableMatchCandidate,
  TableMatchEvidence,
  VpsGameEntry,
  VpsIndex,
  VpsTableEntry,
} from './identity-types.js';
import { catalogueTableName } from './table-name.js';
import { normalizeVpsName, sameManufacturer } from './vps-index.js';

// --------------------------------------------------------------------------------- file names --

/** What a VPX file name says: `Monster Bash (Williams 1998) VPWmod v1.0` → name, manufacturer, year, suffix. */
export interface ParsedTableFileName {
  /** The catalogue name before the parenthetical (or the whole name minus a trailing version). */
  name: string;
  manufacturer: string | null;
  year: number | null;
  /** Whatever follows the parenthetical: author, mod, version tokens (`VPWmod v1.0`). */
  suffix: string;
  hasParenthetical: boolean;
}

const PARENTHETICAL = /^(.*?)\s*\(([^)]*)\)\s*(.*)$/;

export function parseTableFileName(fileName: string): ParsedTableFileName {
  const catalogue = catalogueTableName(fileName);
  const m = PARENTHETICAL.exec(catalogue);
  if (m && /\d{4}/.test(m[2] ?? '')) {
    const inside = m[2] ?? '';
    const yearMatch = /(?:^|\D)((?:18|19|20)\d{2})(?!\d)/.exec(inside);
    const year = yearMatch?.[1] ? Number(yearMatch[1]) : null;
    const manufacturer = inside.replace(yearMatch?.[1] ?? '', '').replace(/[\s,\-–]+$/, '').trim() || null;
    return {
      name: (m[1] ?? '').trim(),
      manufacturer,
      year,
      suffix: fileName.trim().slice(catalogue.length).trim(),
      hasParenthetical: true,
    };
  }
  const trimmed = fileName.trim();
  return {
    name: catalogue,
    manufacturer: null,
    year: null,
    suffix: trimmed.startsWith(catalogue) ? trimmed.slice(catalogue.length).trim() : '',
    hasParenthetical: false,
  };
}

/**
 * A TableInfo name is often the game name plus author or mod words (`Monster Bash VPW Mod`). Try the
 * whole name first, then shorter prefixes, never below half the words (so `Monster` alone is not
 * tried for a four-word name, while `Elvis VPW` still reaches `Elvis`) and never one that ends on
 * an article or preposition, which no game is called.
 */
export function namePrefixes(name: string): string[] {
  const words = normalizeVpsName(name).split(' ').filter(Boolean);
  const min = Math.max(1, Math.ceil(words.length / 2));
  const out: string[] = [];
  for (let n = words.length; n >= min; n--) {
    if (n < words.length && PREFIX_STOP_WORDS.has(words[n - 1] as string)) continue;
    out.push(words.slice(0, n).join(' '));
  }
  return out;
}

const PREFIX_STOP_WORDS = new Set(['the', 'a', 'an', 'of', 'and', 'from', 'in', 'on', 'at', 'to', 'for', 'with']);

// --------------------------------------------------------------------------------- the game --

const byName = (a: VpsGameEntry, b: VpsGameEntry): number => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

/** Keep applying narrowing steps while they leave at least one game; stop at one. */
function narrow(
  games: VpsGameEntry[],
  steps: { strong: boolean; keep: (g: VpsGameEntry) => boolean }[],
): { games: VpsGameEntry[]; strong: boolean } {
  let current = games;
  let strong = false;
  for (const step of steps) {
    if (current.length <= 1) break;
    const next = current.filter(step.keep);
    if (next.length > 0 && next.length < current.length) {
      current = next;
      strong = strong || step.strong;
    }
  }
  return { games: current, strong };
}

function nameEquals(game: VpsGameEntry, name: string | null | undefined): boolean {
  return !!name && normalizeVpsName(game.name) === normalizeVpsName(name);
}

function nameHasPrefix(game: VpsGameEntry, name: string | null | undefined): boolean {
  return !!name && namePrefixes(name).includes(normalizeVpsName(game.name));
}

/** True when the game agrees with both halves of a `(Manufacturer Year)` parenthetical. */
function parentheticalAgrees(game: VpsGameEntry, file: ParsedTableFileName | null): boolean {
  return (
    !!file && file.hasParenthetical && file.year !== null && game.year === file.year && sameManufacturer(game.manufacturer, file.manufacturer)
  );
}

async function firstNameHit(
  index: VpsIndex,
  names: string[],
  hint: { manufacturer: string | null; year: number | null },
): Promise<VpsGameEntry[]> {
  for (const name of names) {
    const hits = await index.gamesByName(name, hint);
    if (hits.length > 0) return hits;
  }
  return [];
}

/**
 * Which VPS game is being played. The ROM is the strongest evidence (it is what the score came
 * from); a ROM shared by several games (re-themes, `rollstob`) is narrowed by what the file calls
 * itself, then by the ROM's own catalogue name, then by manufacturer/year. Without a usable ROM the
 * TableInfo name and the file name's catalogue part are looked up by name; the file's
 * `(Manufacturer Year)` agreeing with the hit lifts `likely` to `exact`.
 */
export async function matchGame(index: VpsIndex, evidence: GameMatchEvidence): Promise<GameMatch> {
  const file = evidence.fileName ? parseTableFileName(evidence.fileName) : null;
  const info = evidence.tableInfo;
  const hint = {
    manufacturer: info?.manufacturer ?? file?.manufacturer ?? null,
    year: info?.year ?? file?.year ?? null,
  };
  const done = (game: VpsGameEntry, confidence: MatchConfidence, source: GameMatch['source'], candidates = [game]): GameMatch => ({
    game,
    confidence,
    source,
    candidates,
  });
  const ambiguous = (candidates: VpsGameEntry[], source: GameMatch['source']): GameMatch => ({
    game: null,
    confidence: 'ambiguous',
    source,
    candidates: [...candidates].sort(byName),
  });

  const rom = evidence.rom?.trim().toLowerCase() ?? '';
  if (rom) {
    const hits = await index.gamesForRom(rom);
    if (hits.length === 1) {
      const game = hits[0] as VpsGameEntry;
      // A family hit (an unlisted revision of a listed ROM) is one step less certain than the id itself.
      return done(game, game.roms.includes(rom) ? 'exact' : 'likely', 'rom');
    }
    if (hits.length > 1) {
      const narrowed = narrow(hits, [
        { strong: true, keep: (g) => nameEquals(g, file?.name) },
        { strong: true, keep: (g) => nameHasPrefix(g, info?.tableName) },
        { strong: true, keep: (g) => nameEquals(g, evidence.romName) },
        { strong: false, keep: (g) => sameManufacturer(g.manufacturer, hint.manufacturer) },
        { strong: false, keep: (g) => hint.year !== null && g.year === hint.year },
      ]);
      if (narrowed.games.length === 1) return done(narrowed.games[0] as VpsGameEntry, narrowed.strong ? 'exact' : 'likely', 'rom', hits);
      return ambiguous(narrowed.games, 'rom');
    }
  }

  let tie: { games: VpsGameEntry[]; source: GameMatch['source'] } | null = null;

  if (info?.tableName) {
    const hits = await firstNameHit(index, namePrefixes(info.tableName), hint);
    if (hits.length === 1) {
      const game = hits[0] as VpsGameEntry;
      return done(game, parentheticalAgrees(game, file) ? 'exact' : 'likely', 'tableinfo');
    }
    if (hits.length > 1) tie = { games: hits, source: 'tableinfo' };
  }

  if (file?.name) {
    const names = file.hasParenthetical ? [file.name] : namePrefixes(file.name);
    const hits = await firstNameHit(index, names, hint);
    if (hits.length === 1) {
      const game = hits[0] as VpsGameEntry;
      return done(game, parentheticalAgrees(game, file) ? 'exact' : 'likely', 'filename');
    }
    if (hits.length > 1 && !tie) tie = { games: hits, source: 'filename' };
  }

  if (evidence.romName) {
    const hits = await index.gamesByName(evidence.romName, hint);
    if (hits.length === 1) return done(hits[0] as VpsGameEntry, 'likely', 'rom');
    if (hits.length > 1 && !tie) tie = { games: hits, source: 'rom' };
  }

  if (tie) return ambiguous(tie.games, tie.source);
  return { game: null, confidence: 'none', source: 'none', candidates: [] };
}

// -------------------------------------------------------------------------------- the table --

/** Score weights. Author and version are "strong" evidence; features and comment words are hints. */
export const TABLE_SCORES = {
  /** The file names the table's first-listed author (`VPW` for a VPW table). */
  leadAuthor: 4,
  /** The file names another of the table's authors. */
  author: 2,
  authorCap: 6,
  /** Versions equal after normalising (`v1.0` = `1.0` = `1.00`). */
  version: 3,
  /** Versions equal once trailing `.0` segments go (`1.0` ≈ `1.0.0`). */
  versionNear: 1.5,
  /** A feature word in the file name (`VR`, `mod`, `FSS`, `4k`) that the table lists. */
  feature: 1,
  featureCap: 3,
  /** A hinted feature the table's (non-empty) feature list does not have. */
  featureMissing: -0.5,
  /** A word of the TableInfo name or file suffix that appears in the table's VPS comment. */
  commentWord: 0.5,
  commentCap: 1.5,
} as const;

/** Lead ahead of the runner-up for `exact` (with author or version evidence) and for `likely`. */
export const TABLE_MARGIN = { strong: 3, weak: 1 } as const;

/** File-name / TableInfo words that stand for a VPS feature tag. */
const FEATURE_HINTS: Record<string, string> = {
  vr: 'VR',
  mod: 'MOD',
  fss: 'FSS',
  ssf: 'SSF',
  '4k': '4k',
  nfozzy: 'nFozzy',
  fleep: 'Fleep',
  hybrid: 'Hybrid',
  fizx: 'FizX',
  bam: 'BAM',
  retheme: 'Retheme',
  lut: 'LUT',
  vlm: 'VLM',
  pup: 'incl. PuP',
  b2s: 'incl. B2S',
};

const alnumTokens = (s: string): string[] => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/**
 * Words of the evidence that can name an author, a feature or a comment: file suffix and TableInfo
 * name/author, lower-cased, minus the game's own name words. `VPWmod` is also split into `vpw` +
 * `mod`, the way players glue an author to "mod" in file names.
 */
function evidenceTokens(game: VpsGameEntry, file: ParsedTableFileName | null, evidence: TableMatchEvidence): string[] {
  const gameWords = new Set(normalizeVpsName(game.name).split(' '));
  const raw = [file?.suffix ?? '', evidence.tableInfo?.tableName ?? '', evidence.tableInfo?.authorName ?? ''].join(' ');
  const out = new Set<string>();
  for (const t of alnumTokens(raw)) {
    if (gameWords.has(t)) continue;
    out.add(t);
    if (t.length > 3 && t.endsWith('mod')) {
      out.add(t.slice(0, -3));
      out.add('mod');
    }
  }
  return [...out];
}

/** Normalised forms of a version string for comparison: whole, and before a `-` (VPS `1.21-2.6`). */
export function versionForms(v: string): { exact: string[]; near: string[] } {
  const base = v.trim().toLowerCase().replace(/^v(?=\d)/, '');
  const variants = new Set([base]);
  const dash = base.indexOf('-');
  if (dash > 0) variants.add(base.slice(0, dash));
  const exact: string[] = [];
  const near: string[] = [];
  for (const variant of variants) {
    const segs = variant.split(/[.\s_]+/).filter(Boolean).map((s) => (/^\d+$/.test(s) ? String(Number(s)) : s));
    if (segs.length === 0) continue;
    exact.push(segs.join('.'));
    const trimmed = [...segs];
    while (trimmed.length > 1 && trimmed[trimmed.length - 1] === '0') trimmed.pop();
    near.push(trimmed.join('.'));
  }
  return { exact, near };
}

function compareVersions(a: string, b: string): 'exact' | 'near' | null {
  const fa = versionForms(a);
  const fb = versionForms(b);
  if (fa.exact.some((x) => fb.exact.includes(x))) return 'exact';
  if (fa.near.some((x) => fb.near.includes(x))) return 'near';
  return null;
}

/** The last version-looking token of a file suffix: `VPWmod v1.0` → `1.0`; `1.0-2.5` → `1.0-2.5`. */
export function versionFromName(s: string): string | null {
  const re = /(?:^|[\s_\-[\]])v?(\d+(?:\.\d+)+[a-z]?(?:-\d+(?:\.\d+)*)?|v\d+[a-z]?)(?=$|[\s_\-[\]])/gi;
  let last: string | null = null;
  for (const m of s.matchAll(re)) last = (m[1] ?? '').replace(/^v/i, '');
  return last;
}

const normAuthor = (a: string): string => a.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/** True when the evidence names this author (`vpw` = `VPW`, `vpwmod` starts with `vpw`, `bigus` for `Bigus1`). */
function authorNamed(author: string, tokens: string[], joined: string): boolean {
  const a = normAuthor(author);
  if (!a) return false;
  if (a.includes(' ')) return joined.includes(a);
  return tokens.some(
    (t) =>
      t === a ||
      (a.length >= 3 && t.startsWith(a) && t.length - a.length <= 4) ||
      (t.length >= 4 && a.startsWith(t) && a.length - t.length <= 2),
  );
}

function scoreTable(table: VpsTableEntry, game: VpsGameEntry, file: ParsedTableFileName | null, evidence: TableMatchEvidence): TableMatchCandidate & { strong: boolean } {
  const tokens = evidenceTokens(game, file, evidence);
  const joined = tokens.join(' ');
  const reasons: string[] = [];
  let score = 0;
  let strong = false;

  // Authors: the lead author is what players put in the file name, so it weighs double.
  let authorScore = 0;
  table.authors.forEach((author, i) => {
    if (!authorNamed(author, tokens, joined)) return;
    authorScore += i === 0 ? TABLE_SCORES.leadAuthor : TABLE_SCORES.author;
    reasons.push(i === 0 ? `author ${author} (lead)` : `author ${author}`);
  });
  if (authorScore > 0) {
    score += Math.min(authorScore, TABLE_SCORES.authorCap);
    strong = true;
  }

  // Version: TableInfo's is authoritative; the file name's is the fallback.
  const claimed = evidence.tableInfo?.tableVersion?.trim() || (file ? versionFromName(file.suffix) : null) || (evidence.fileName && !file?.hasParenthetical ? versionFromName(evidence.fileName) : null);
  if (claimed && table.version) {
    const cmp = compareVersions(claimed, table.version);
    if (cmp === 'exact') {
      score += TABLE_SCORES.version;
      strong = true;
      reasons.push(`version ${table.version} matches`);
    } else if (cmp === 'near') {
      score += TABLE_SCORES.versionNear;
      reasons.push(`version ${claimed} ≈ ${table.version}`);
    }
  }

  // Features hinted by the name.
  let featureScore = 0;
  const tableFeatures = table.features.map((f) => f.toLowerCase());
  for (const token of tokens) {
    const feature = FEATURE_HINTS[token];
    if (!feature) continue;
    if (tableFeatures.includes(feature.toLowerCase())) {
      featureScore += TABLE_SCORES.feature;
      reasons.push(`${feature} in name`);
    } else if (tableFeatures.length > 0) {
      featureScore += TABLE_SCORES.featureMissing;
      reasons.push(`${feature} in name but not listed`);
    }
  }
  score += Math.min(featureScore, TABLE_SCORES.featureCap);

  // Comment words ("VPW MOD", "Bigus MOD", "VR Room").
  if (table.comment) {
    const commentWords = new Set(normalizeVpsName(table.comment).split(' ').filter(Boolean));
    const hits = tokens.filter((t) => t.length >= 2 && !/^\d+$/.test(t) && commentWords.has(t));
    if (hits.length > 0) {
      score += Math.min(hits.length * TABLE_SCORES.commentWord, TABLE_SCORES.commentCap);
      reasons.push(`comment "${table.comment}" has ${hits.join(', ')}`);
    }
  }

  return { table, score, reasons, strong };
}

/**
 * Which of the game's VPX table files the `.vpx` is. Candidates are the game's `VPX` (and
 * format-less) tables, each scored on author overlap, version equality, feature words and comment
 * words against the file name and TableInfo. One candidate is `exact` by elimination; otherwise the
 * best must lead the runner-up by `TABLE_MARGIN.strong` on author or version evidence for `exact`,
 * by `TABLE_MARGIN.weak` for `likely`, and anything closer is `ambiguous` with no pick.
 */
export function matchTable(game: VpsGameEntry, evidence: TableMatchEvidence): TableMatch {
  const file = evidence.fileName ? parseTableFileName(evidence.fileName) : null;
  const scored = game.tables
    .filter((t) => t.format === null || t.format.toUpperCase() === 'VPX')
    .map((t) => scoreTable(t, game, file, evidence))
    .sort((a, b) => b.score - a.score || (b.table.updatedAt ?? 0) - (a.table.updatedAt ?? 0) || a.table.id.localeCompare(b.table.id));
  const candidates: TableMatchCandidate[] = scored.map(({ table, score, reasons }) => ({ table, score, reasons }));

  if (scored.length === 0) return { table: null, confidence: 'none', candidates };
  const best = scored[0] as (typeof scored)[number];
  if (scored.length === 1) {
    (candidates[0] as TableMatchCandidate).reasons.push('only VPX table of the game');
    return { table: best.table, confidence: 'exact', candidates };
  }
  const gap = best.score - (scored[1] as (typeof scored)[number]).score;
  let confidence: MatchConfidence;
  if (gap >= TABLE_MARGIN.strong && best.strong) confidence = 'exact';
  else if (gap >= TABLE_MARGIN.weak && best.score > 0) confidence = 'likely';
  else confidence = 'ambiguous';
  return { table: confidence === 'ambiguous' ? null : best.table, confidence, candidates };
}
