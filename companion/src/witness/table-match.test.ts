import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { GameMatchEvidence, VpsGameEntry } from './identity-types.js';
import { matchGame, matchTable, namePrefixes, parseTableFileName, versionForms, versionFromName } from './table-match.js';
import { createVpsIndex } from './vps-index.js';

const repo = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const index = createVpsIndex(repo('fixtures/vps'));

const game = async (id: string): Promise<VpsGameEntry> => {
  const g = await index.game(id);
  if (!g) throw new Error(`fixture lacks game ${id}`);
  return g;
};

const evidence = (over: Partial<GameMatchEvidence>): GameMatchEvidence => ({ rom: null, romName: null, fileName: null, tableInfo: null, ...over });

/** The owner's three files (TableInfo as read from them, or as presumed where noted in the task). */
const MB_FILE = 'Monster Bash (Williams 1998) VPWmod v1.0';
const MB_INFO = { tableName: 'Monster Bash VPW Mod', authorName: 'VPW', tableVersion: '1.0' };
const MM_FILE = 'Medieval Madness (Williams 1997) VPW v1.0.1';
const MM_INFO = { tableName: 'Medieval Madness', authorName: 'VPW', tableVersion: '1.0.1' };
const TFTC_FILE = 'Tales from the Crypt (Data East 1993) VPW v1.22';
const TFTC_INFO = { tableName: 'Tales from the Crypt', authorName: 'VPW', tableVersion: '1.22' };

describe('parseTableFileName', () => {
  it('splits name, manufacturer, year and the suffix', () => {
    expect(parseTableFileName(MB_FILE)).toEqual({ name: 'Monster Bash', manufacturer: 'Williams', year: 1998, suffix: 'VPWmod v1.0', hasParenthetical: true });
    expect(parseTableFileName(TFTC_FILE)).toEqual({
      name: 'Tales from the Crypt',
      manufacturer: 'Data East',
      year: 1993,
      suffix: 'VPW v1.22',
      hasParenthetical: true,
    });
    expect(parseTableFileName('Iron Maiden LOTB (Original 2020)')).toMatchObject({ name: 'Iron Maiden LOTB', manufacturer: 'Original', year: 2020, suffix: '' });
  });
  it('falls back to the catalogue name without a parenthetical', () => {
    expect(parseTableFileName("Sittin' Pretty 1.0")).toEqual({ name: "Sittin' Pretty", manufacturer: null, year: null, suffix: '1.0', hasParenthetical: false });
    expect(parseTableFileName('Blood Machines')).toMatchObject({ name: 'Blood Machines', hasParenthetical: false });
  });
});

describe('name and version helpers', () => {
  it('namePrefixes never goes below half the words', () => {
    expect(namePrefixes('Monster Bash VPW Mod')).toEqual(['monster bash vpw mod', 'monster bash vpw', 'monster bash']);
    expect(namePrefixes('Elvis VPW')).toEqual(['elvis vpw', 'elvis']);
    expect(namePrefixes('Tales from the Crypt VPW MOD')).toEqual(['tales from the crypt vpw mod', 'tales from the crypt vpw', 'tales from the crypt']);
  });
  it('versionFromName takes the last version-like token', () => {
    expect(versionFromName('VPWmod v1.0')).toBe('1.0');
    expect(versionFromName('VPW v1.0.1')).toBe('1.0.1');
    expect(versionFromName('Bigus MOD 3.0 [4k]')).toBe('3.0');
    expect(versionFromName('VPW')).toBeNull();
    expect(versionFromName('4k')).toBeNull();
  });
  it('versionForms normalises v-prefix, zero padding and trailing .0', () => {
    expect(versionForms('v1.0').exact).toEqual(['1.0']);
    expect(versionForms('1.00').exact).toEqual(['1.0']);
    expect(versionForms('1.0.0').near).toEqual(['1']);
    expect(versionForms('1.21-2.6').exact).toEqual(['1.21-2.6', '1.21']);
  });
});

describe('matchGame', () => {
  it('owner files: one exact ROM hit', async () => {
    const mb = await matchGame(index, evidence({ rom: 'mb_106b', romName: 'Monster Bash', fileName: MB_FILE, tableInfo: { tableName: MB_INFO.tableName, manufacturer: null, year: null } }));
    expect(mb).toMatchObject({ confidence: 'exact', source: 'rom' });
    expect(mb.game?.id).toBe('F1Skyh5h');

    const mm = await matchGame(index, evidence({ rom: 'mm_109c', romName: 'Medieval Madness', fileName: MM_FILE }));
    expect(mm).toMatchObject({ confidence: 'exact', source: 'rom' });
    expect(mm.game?.id).toBe('-5yMpqSy');

    const tftc = await matchGame(index, evidence({ rom: 'tftc_400', romName: 'Tales from the Crypt', fileName: TFTC_FILE }));
    expect(tftc).toMatchObject({ confidence: 'exact', source: 'rom' });
    expect(tftc.game?.id).toBe('fXaQ33KC');
  });

  it('an unlisted ROM revision resolves through its family as likely', async () => {
    const mm = await matchGame(index, evidence({ rom: 'mm_109x' }));
    expect(mm).toMatchObject({ confidence: 'likely', source: 'rom' });
    expect(mm.game?.id).toBe('-5yMpqSy');
  });

  it('a ROM shared by several games is ambiguous without more evidence, and narrowed by names', async () => {
    const bare = await matchGame(index, evidence({ rom: 'rollstob' }));
    expect(bare.game).toBeNull();
    expect(bare.confidence).toBe('ambiguous');
    expect(bare.source).toBe('rom');
    expect(bare.candidates.map((g) => g.name)).toEqual(['Conan', 'Conan the Barbarian', 'Rolling Stones', 'Stray Cats', 'Tiger King']);

    // The file says which re-theme was loaded.
    const conan = await matchGame(index, evidence({ rom: 'rollstob', romName: 'Rolling Stones', fileName: 'Conan (Rowamet 1983) 1.0' }));
    expect(conan).toMatchObject({ confidence: 'exact', source: 'rom' });
    expect(conan.game?.id).toBe('oImbzGjd');
    expect(conan.candidates).toHaveLength(5);

    // Only the ROM's catalogue name: the original.
    const stones = await matchGame(index, evidence({ rom: 'rollstob', romName: 'Rolling Stones' }));
    expect(stones).toMatchObject({ confidence: 'exact', source: 'rom' });
    expect(stones.game?.id).toBe('-bG4P570');

    // A TableInfo name with mod words still reaches the game through its prefixes.
    const cats = await matchGame(index, evidence({ rom: 'rollstob', tableInfo: { tableName: 'Stray Cats VR Mod', manufacturer: null, year: null } }));
    expect(cats.game?.id).toBe('jaxFOgue1X');
    expect(cats.confidence).toBe('exact');

    // Manufacturer/year alone are weaker: likely.
    const tiger = await matchGame(index, evidence({ rom: 'rollstob', tableInfo: { tableName: null, manufacturer: 'Original', year: 2020 } }));
    expect(tiger.game?.id).toBe('PUEPHDxC');
    expect(tiger.confidence).toBe('likely');
  });

  it('same-name games are separated by the parenthetical or TableInfo manufacturer/year', async () => {
    const stern = await matchGame(index, evidence({ fileName: 'Deadpool (Stern 2018)' }));
    expect(stern).toMatchObject({ confidence: 'exact', source: 'filename' });
    expect(stern.game?.id).toBe('K3qwGUCAYu');

    const zen = await matchGame(index, evidence({ fileName: 'Deadpool (Zen 2014) v1.0' }));
    expect(zen.game?.id).toBe('-bv6-HSX');
    expect(zen.confidence).toBe('exact');

    const tie = await matchGame(index, evidence({ tableInfo: { tableName: 'Deadpool', manufacturer: null, year: null } }));
    expect(tie.game).toBeNull();
    expect(tie.confidence).toBe('ambiguous');
    expect(tie.source).toBe('tableinfo');
    expect(tie.candidates.map((g) => g.id).sort()).toEqual(['-bv6-HSX', 'K3qwGUCAYu'].sort());

    // Same year, different manufacturer; no parenthetical to confirm, so likely.
    const bally = await matchGame(index, evidence({ tableInfo: { tableName: 'Black Belt', manufacturer: 'Bally', year: 1986 } }));
    expect(bally.game?.id).toBe('atmZ8zPG');
    expect(bally.confidence).toBe('likely');
  });

  it('a file name without a parenthetical is likely; TableInfo-only and file-only evidence work', async () => {
    const pretty = await matchGame(index, evidence({ fileName: "Sittin' Pretty 1.0" }));
    expect(pretty).toMatchObject({ confidence: 'likely', source: 'filename' });
    expect(pretty.game?.id).toBe('-5vpyFdfos');

    // TableInfo name with mod words, the file's parenthetical agreeing: exact.
    const info = await matchGame(index, evidence({ fileName: MB_FILE, tableInfo: { tableName: MB_INFO.tableName, manufacturer: null, year: null } }));
    expect(info).toMatchObject({ confidence: 'exact', source: 'tableinfo' });
    expect(info.game?.id).toBe('F1Skyh5h');

    // No TableInfo at all: the file name alone, parenthetical agreeing.
    const file = await matchGame(index, evidence({ fileName: MB_FILE }));
    expect(file).toMatchObject({ confidence: 'exact', source: 'filename' });
    expect(file.game?.id).toBe('F1Skyh5h');

    // Wrong manufacturer in the file name still finds the only game of that name, but only likely.
    const wrong = await matchGame(index, evidence({ fileName: 'Monster Bash (Bally 1998)' }));
    expect(wrong).toMatchObject({ confidence: 'likely', source: 'filename' });
    expect(wrong.game?.id).toBe('F1Skyh5h');
  });

  it('a ROM that VPS does not list falls back to the ROM name, then to nothing', async () => {
    const byRomName = await matchGame(index, evidence({ rom: 'bb_l1', romName: 'Black Belt' }));
    expect(byRomName.confidence).toBe('ambiguous');
    expect(byRomName.source).toBe('rom');
    expect(byRomName.candidates).toHaveLength(2);

    const none = await matchGame(index, evidence({ rom: 'zz_1', romName: 'Nothing Here', fileName: 'Nothing Here (Nobody 2001)' }));
    expect(none).toEqual({ game: null, confidence: 'none', source: 'none', candidates: [] });
    expect(await matchGame(index, evidence({}))).toMatchObject({ confidence: 'none', source: 'none' });
  });
});

describe('matchTable', () => {
  it('Monster Bash VPW mod 1.0 → rxmbAdBi, exact', async () => {
    const m = matchTable(await game('F1Skyh5h'), { fileName: MB_FILE, tableInfo: MB_INFO });
    expect(m.confidence).toBe('exact');
    expect(m.table?.id).toBe('rxmbAdBi');
    expect(m.candidates).toHaveLength(11); // the FX / FX3 entries are not offered
    const best = m.candidates[0];
    expect(best?.table.id).toBe('rxmbAdBi');
    expect(best?.reasons).toEqual(expect.arrayContaining(['author VPW (lead)', 'version 1.0 matches', 'MOD in name']));
    expect(best?.reasons.some((r) => r.startsWith('comment "VPW MOD"'))).toBe(true);
    // Runner-up is the other 1.0 table on version alone, well behind.
    expect((best?.score ?? 0) - (m.candidates[1]?.score ?? 0)).toBeGreaterThanOrEqual(3);
  });

  it('Medieval Madness VPW 1.0.1 → zbyQ01wi3L, exact', async () => {
    const m = matchTable(await game('-5yMpqSy'), { fileName: MM_FILE, tableInfo: MM_INFO });
    expect(m.confidence).toBe('exact');
    expect(m.table?.id).toBe('zbyQ01wi3L');
    expect(m.candidates[0]?.reasons).toEqual(expect.arrayContaining(['author VPW (lead)', 'version 1.0.1 matches']));
  });

  it('Tales from the Crypt VPW 1.22 → uVgZUZdK, exact, ahead of the VPU-patch VPW table on version', async () => {
    const m = matchTable(await game('fXaQ33KC'), { fileName: TFTC_FILE, tableInfo: TFTC_INFO });
    expect(m.confidence).toBe('exact');
    expect(m.table?.id).toBe('uVgZUZdK');
    expect(m.candidates[1]?.table.id).toBe('TJMo9ycfSP');
    expect(m.candidates[1]?.reasons).toContain('author VPW');
    expect(m.candidates[1]?.reasons).not.toContain('author VPW (lead)');
  });

  it('works from the file name alone (no TableInfo)', async () => {
    const mb = matchTable(await game('F1Skyh5h'), { fileName: MB_FILE, tableInfo: null });
    expect(mb.confidence).toBe('exact');
    expect(mb.table?.id).toBe('rxmbAdBi');
    const tftc = matchTable(await game('fXaQ33KC'), { fileName: TFTC_FILE, tableInfo: null });
    expect(tftc.confidence).toBe('exact');
    expect(tftc.table?.id).toBe('uVgZUZdK');
  });

  it('a Skitso file picks the Skitso MOD; a VR hint helps', async () => {
    const mb = await game('F1Skyh5h');
    const skitso = matchTable(mb, { fileName: 'Monster Bash (Williams 1998) Skitso MOD 1.02', tableInfo: null });
    expect(skitso.confidence).toBe('exact');
    expect(skitso.table?.id).toBe('82XXV-Tc');
    // "VR 1.0" is the VPW table (VR, 1.0) ahead of Arvid's VR 1.0.0 on the exact version.
    const vr = matchTable(mb, { fileName: 'Monster Bash (Williams 1998) VR 1.0', tableInfo: null });
    expect(vr.table?.id).toBe('rxmbAdBi');
    // "VR 1.0.0" is Arvid's: exact version beats the VPW table's near match, but by less than the strong margin.
    const arvid = matchTable(mb, { fileName: 'Monster Bash (Williams 1998) VR 1.0.0', tableInfo: null });
    expect(arvid.confidence).toBe('likely');
    expect(arvid.table?.id).toBe('G7Df7_IH');
    expect(arvid.candidates[0]?.reasons).toEqual(expect.arrayContaining(['VR in name', 'version 1.0.0 matches']));
    expect(arvid.candidates[1]?.table.id).toBe('rxmbAdBi');
    expect(arvid.candidates[1]?.reasons).toContain('version 1.0.0 ≈ 1.0');
  });

  it('no evidence → ambiguous with every VPX table listed, no pick', async () => {
    const m = matchTable(await game('-5yMpqSy'), { fileName: null, tableInfo: null });
    expect(m.confidence).toBe('ambiguous');
    expect(m.table).toBeNull();
    expect(m.candidates).toHaveLength(17);
    expect(m.candidates.every((c) => c.score === 0)).toBe(true);
  });

  it('a version shared by several tables is a tie: ambiguous', async () => {
    const m = matchTable(await game('-5yMpqSy'), { fileName: 'Medieval Madness (Williams 1997) 1.0.0', tableInfo: null });
    expect(m.confidence).toBe('ambiguous');
    expect(m.table).toBeNull();
    expect(m.candidates.filter((c) => c.score > 0).length).toBeGreaterThan(1);
  });

  it('one VPX table → exact by elimination; no VPX tables → none', async () => {
    const pretty = matchTable(await game('-5vpyFdfos'), { fileName: "Sittin' Pretty 1.0", tableInfo: null });
    expect(pretty.confidence).toBe('exact');
    expect(pretty.table?.id).toBe('OqImqNXjYO');
    expect(pretty.candidates[0]?.reasons).toContain('only VPX table of the game');

    const zen = matchTable(await game('-bv6-HSX'), { fileName: 'Deadpool (Zen 2014)', tableInfo: null });
    expect(zen).toEqual({ table: null, confidence: 'none', candidates: [] });
  });
});
