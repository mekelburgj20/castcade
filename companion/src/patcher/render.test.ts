import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { classifyScript } from './classify.js';
import { libraryVersionOf } from './import.js';
import { LIB_VERSION, RECIPE_VERSION, STUB, formatLocalStamp, isOurSidecar, parseSidecarMarker, renderRecipeA, type RenderOptions } from './render.js';
import { decodeScript, encodeScript, splitScript } from './script-text.js';
import { ORIGINAL_B_SCRIPT, PATCHED_VPM_SCRIPT, VPM_DECLARED_SCRIPT, VPM_NO_LOADVPM_SCRIPT, VPM_SCRIPT, crlf, lf } from './test-scripts.test-support.js';

const MTIME = new Date(2026, 9, 21, 13, 5, 9).getTime(); // local 2026-10-21 13:05:09

const OPTS: RenderOptions = {
  tableId: 'Monster Bash (Williams 1998) VPW 1.0',
  rom: 'mb_106b',
  originalPath: 'C:\\VPX\\tables\\Monster Bash (Williams 1998) VPW 1.0.vpx',
  originalSize: 123_456_789,
  originalMtimeMs: MTIME,
  sidecarPath: 'C:\\VPX\\tables\\Monster Bash (Williams 1998) VPW 1.0.vbs',
};

const renderLines = (text: string, opts: RenderOptions = OPTS) => {
  const r = renderRecipeA(text, classifyScript(text), opts);
  return { r, out: splitScript(decodeScript(r.bytes)) };
};

describe('formatLocalStamp', () => {
  it('formats a known local timestamp as yyyy-mm-dd hh:nn:ss', () => {
    expect(formatLocalStamp(MTIME)).toBe('2026-10-21 13:05:09');
    expect(formatLocalStamp(new Date(2026, 0, 1, 0, 0, 0).getTime())).toBe('2026-01-01 00:00:00');
  });
});

describe('versions', () => {
  it('LIB_VERSION equals Castcade_LibVersion in vpx-hook/castcade.vbs, and the STUB covers Castcade_Guard', () => {
    const lib = readFileSync(new URL('../../../vpx-hook/castcade.vbs', import.meta.url), 'latin1');
    expect(libraryVersionOf(lib)).toBe(LIB_VERSION);
    expect(lib).toContain('Sub Castcade_Guard(originalPath, originalSize, originalMtime, sidecarPath)');
    expect(STUB).toContain('Sub Castcade_Guard(a,b,c,d):End Sub');
    expect(RECIPE_VERSION).toBe('0.3.0');
  });
});

describe('renderRecipeA', () => {
  it('places every block at its anchor (CRLF script)', () => {
    const { r, out } = renderLines(crlf(VPM_SCRIPT));
    expect(out.newline).toBe('\r\n');
    const L = out.lines;
    // block 0 right after Option Explicit
    expect(L[0]).toBe('Option Explicit');
    expect(L[1]).toBe(`' --- Castcade (recipe A v${RECIPE_VERSION}, lib ${LIB_VERSION}) --- do not edit; delete this .vbs to revert to the embedded script`);
    expect(L[2]).toBe('On Error Resume Next');
    expect(L[3]).toBe('ExecuteGlobal GetTextFile("castcade.vbs")');
    const init = L.indexOf(`Castcade_Init "Monster Bash (Williams 1998) VPW 1.0", "A", "${RECIPE_VERSION}", "mb_106b"`);
    expect(init).toBeGreaterThan(3);
    expect(L[init + 1]).toBe(
      'Castcade_Guard "C:\\VPX\\tables\\Monster Bash (Williams 1998) VPW 1.0.vpx", 123456789, "2026-10-21 13:05:09", "C:\\VPX\\tables\\Monster Bash (Williams 1998) VPW 1.0.vbs"',
    );
    expect(L[init + 2]).toBe('On Error Goto 0');
    expect(L[init + 3]).toBe("' --- end Castcade block 0 ---");
    expect(L.slice(0, init + 4).filter((l) => l.includes('ExecuteGlobal "Sub Castcade_Init(a,b,c,d):End Sub:Sub Castcade_Guard(a,b,c,d):End Sub'))).toHaveLength(1);
    expect(L.some((l) => l.includes('castcade-sidecar-ran-but-no-library.txt'))).toBe(true);
    // UseVPMNVRAM before LoadVPM, RegisterNVRAM after
    const lv = L.findIndex((l) => l.startsWith('LoadVPM '));
    expect(L[lv - 1]).toMatch(/^Dim UseVPMNVRAM : UseVPMNVRAM = True\s+' Castcade/);
    expect(L[lv + 1]).toMatch(/^Castcade_RegisterNVRAM\s+' Castcade/);
    // handlers renamed, originals' bodies kept, wrappers appended
    expect(L).toContain('Sub Castcade_Orig_KeyDown(ByVal keycode)');
    expect(L).toContain('Sub Castcade_Orig_KeyUp(ByVal keycode)');
    expect(L).toContain('Sub Castcade_Orig_Exit()');
    expect(L).toContain('    If keycode = LeftFlipperKey Then Controller.Switch(swLLFlip) = True');
    const tail = L.slice(L.indexOf("' --- Castcade turn lock + exit hook (renamed originals: Castcade_Orig_KeyDown / _KeyUp / _Exit) ---"));
    expect(tail).toEqual([
      "' --- Castcade turn lock + exit hook (renamed originals: Castcade_Orig_KeyDown / _KeyUp / _Exit) ---",
      'Sub Table1_KeyDown(ByVal KeyCode)',
      '    If Castcade_KeyDownBlocked(KeyCode) Then Exit Sub',
      '    Castcade_Orig_KeyDown KeyCode',
      'End Sub',
      'Sub Table1_KeyUp(ByVal KeyCode)',
      '    If Castcade_KeyUpBlocked(KeyCode) Then Exit Sub',
      '    Castcade_Orig_KeyUp KeyCode',
      'End Sub',
      'Sub Table1_Exit()',
      '    Castcade_Exit',
      '    Castcade_Orig_Exit',
      'End Sub',
      "' --- end Castcade ---",
    ]);
    expect(L.filter((l) => /^Sub Table1_KeyDown\b/.test(l))).toHaveLength(1);
    expect(r.warnings).toEqual([]);
    expect(r.anchors).toMatchObject({
      block0: 'after Option Explicit (line 1)',
      useVpmNvram: 'before LoadVPM (line 8)',
      registerNvram: 'after LoadVPM (line 8)',
      keyDown: 'Sub Table1_KeyDown renamed Castcade_Orig_KeyDown (line 21)',
      keyUp: 'Sub Table1_KeyUp renamed Castcade_Orig_KeyUp (line 26)',
      exit: 'Sub Table1_Exit renamed Castcade_Orig_Exit (line 30)',
    });
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(isOurSidecar(decodeScript(r.bytes))).toBe(true);
    expect(parseSidecarMarker(decodeScript(r.bytes))).toEqual({ recipe: 'A', recipeVersion: RECIPE_VERSION, libVersion: LIB_VERSION });
  });

  it('is deterministic: same input, same bytes', () => {
    const a = renderRecipeA(crlf(VPM_SCRIPT), classifyScript(crlf(VPM_SCRIPT)), OPTS);
    const b = renderRecipeA(crlf(VPM_SCRIPT), classifyScript(crlf(VPM_SCRIPT)), OPTS);
    expect(a.sha256).toBe(b.sha256);
  });

  it('keeps LF scripts LF, puts block 0 at the top without Option Explicit, and no KeyUp wrapper when there is none', () => {
    const { r, out } = renderLines(lf(VPM_DECLARED_SCRIPT), { ...OPTS, rom: 'afm_113b' });
    expect(out.newline).toBe('\n');
    expect(out.lines[0]).toMatch(/^' --- Castcade \(recipe A/);
    expect(r.anchors['block0']).toBe('top of script');
    const lv = out.lines.findIndex((l) => l.startsWith('LoadVPM '));
    expect(out.lines[lv - 1]).toMatch(/^UseVPMNVRAM = True\s+' Castcade/); // no Dim: the table declared it
    expect(out.lines.some((l) => l.startsWith('Sub MyTable_KeyUp'))).toBe(false);
    expect(out.lines.some((l) => l === 'Sub MyTable_Exit()')).toBe(true); // Exit wrapper always, without Castcade_Orig_Exit
    expect(out.lines).not.toContain('    Castcade_Orig_Exit');
    expect(r.warnings).toEqual([
      'UseVPMNVRAM already declared by the table; forcing it True before LoadVPM without a Dim',
      'table already sets NVRAMCallback; Castcade_RegisterNVRAM will chain it',
    ]);
  });

  it('warns when there is no LoadVPM line and no ROM', () => {
    const { r, out } = renderLines(lf(VPM_NO_LOADVPM_SCRIPT), { ...OPTS, rom: null });
    expect(r.warnings).toEqual(['no LoadVPM call line; NVRAM registration anchor missing (recipe A partial)', 'cGameName not found; journal rom field empty']);
    expect(out.lines.some((l) => l.startsWith('Castcade_RegisterNVRAM'))).toBe(false);
    expect(out.lines).toContain(`Castcade_Init "Monster Bash (Williams 1998) VPW 1.0", "A", "${RECIPE_VERSION}", ""`);
  });

  it('round-trips non-ASCII bytes and renders non-ASCII arguments as ChrW', () => {
    const text = decodeScript(encodeScript(crlf(["' Pok\u00e9mon \u00df table", ...VPM_SCRIPT])));
    const { r } = renderLines(text, { ...OPTS, tableId: 'Caf\u00e9 \u00e0 la "mode"', sidecarPath: 'C:\\t\\Caf\u00e9.vbs' });
    const bytes = r.bytes;
    const idx = decodeScript(bytes).indexOf("' Pok");
    expect(Array.from(bytes.subarray(idx + 5, idx + 8))).toEqual([0xe9, 0x6d, 0x6f]);
    expect(bytes.every((b) => b <= 0xff)).toBe(true);
    const out = decodeScript(bytes);
    expect(out).toContain('Castcade_Init "Caf" & ChrW(233) & " " & ChrW(224) & " la ""mode""", "A"');
    expect(out).toContain(', "C:\\t\\Caf" & ChrW(233) & ".vbs"');
  });

  it('adds Castcade_AddPlayKeys for extra keys', () => {
    const { out } = renderLines(crlf(VPM_SCRIPT), { ...OPTS, extraKeys: ['KeyUpperLeft', ' KeyUpperRight ', ''] });
    expect(out.lines).toContain('Castcade_AddPlayKeys Array("KeyUpperLeft", "KeyUpperRight")');
  });

  it('refuses an already-patched script and a non-A class', () => {
    expect(() => renderRecipeA(lf(PATCHED_VPM_SCRIPT), classifyScript(lf(PATCHED_VPM_SCRIPT)), OPTS)).toThrow(/already patched/);
    expect(() => renderRecipeA(crlf(ORIGINAL_B_SCRIPT), classifyScript(crlf(ORIGINAL_B_SCRIPT)), OPTS)).toThrow(/class B/);
  });

  it('isOurSidecar recognises 0.1.0 sidecars and not a foreign .vbs', () => {
    expect(isOurSidecar(lf(PATCHED_VPM_SCRIPT))).toBe(true);
    expect(isOurSidecar(lf(VPM_SCRIPT))).toBe(false);
    expect(isOurSidecar("' Castcade mentioned but no marker\nCastcade_Init")).toBe(false);
  });
});

describe('watch list (lib 0.3.0)', () => {
  it('renders Castcade_WatchBytes with the sorted, unique offsets inside block 0, after Castcade_Guard', () => {
    const { out } = renderLines(crlf(VPM_SCRIPT), { ...OPTS, watchOffsets: [30, 10, 20, 10, -1, 2.5] });
    const i = out.lines.findIndex((l) => l.startsWith('Castcade_WatchBytes'));
    expect(out.lines[i]).toBe('Castcade_WatchBytes Array(10, 20, 30)');
    expect(out.lines[i - 1]).toMatch(/^Castcade_Guard /);
    expect(out.lines[i + 1]).toBe('On Error Goto 0');
  });

  it('an empty watch list renders an empty Array (no deltas); no option renders no line', () => {
    expect(renderLines(crlf(VPM_SCRIPT), { ...OPTS, watchOffsets: [] }).out.lines).toContain('Castcade_WatchBytes Array()');
    expect(renderLines(crlf(VPM_SCRIPT)).out.lines.some((l) => l.startsWith('Castcade_WatchBytes'))).toBe(false);
    expect(STUB).toContain('Castcade_WatchBytes');
  });
});
