/**
 * Recipe A renderer (`docs/design/table-import-and-patching.md` §5): the original script with block 0
 * (library load, `Castcade_Init`, the 0.2.0 stale guard), `UseVPMNVRAM` before `LoadVPM`,
 * `Castcade_RegisterNVRAM` after it, and the `_KeyDown` / `_KeyUp` / `_Exit` wrappers (block L).
 * Port of `block0()`, `wrappers()`, `rename_handler()` and the recipe-A branch of `render()` in
 * `vpx-hook/spike/render-sidecar.py`. Pure: text in, bytes out; everything inserted is ASCII.
 * Block 0, the wrappers and the exact undo are shared with the originals' recipes B/C/D (`render-originals.ts`).
 */
import { createHash } from 'node:crypto';
import type { ClassifyResult } from './classify.js';
import { encodeScript, escapeRegExp, splitScript, joinScript, vbStringLiteral } from './script-text.js';

/** Must equal `Castcade_LibVersion` in `vpx-hook/castcade.vbs` (a test checks the file). */
export const LIB_VERSION = '0.5.0';
/**
 * Recipe A's version. 0.3.1: watch-list offsets count from the platform's NVRAM start (B10); bumping it re-makes
 * every recipe-A sidecar at the next look. The originals' recipes carry their own (`RECIPE_VERSIONS`, C1.1).
 */
export const RECIPE_VERSION = '0.3.1';

/**
 * Each recipe's version, written into its sidecar's marker and `Castcade_Init`; a bump re-makes only that recipe's sidecars.
 * B 0.3.0 (C1.4): anchor overrides (GLF, the Burger template, Rattlecan), a game end after every game-flag clear, the
 * score store named `Score` ahead of any other `...score...`; B 0.3.0 and C 0.2.0: a game end is journaled once per
 * journaled game start. B 0.3.1 (C1.6): an end sub that clears the score store journals the game end in front of the
 * clear (The Matrix (Original) journaled a final score of 0).
 */
export const RECIPE_VERSIONS = { A: RECIPE_VERSION, B: '0.3.1', C: '0.2.0', D: '0.1.0' } as const;
export type Recipe = keyof typeof RECIPE_VERSIONS;

export function isRecipe(r: string): r is Recipe {
  return Object.prototype.hasOwnProperty.call(RECIPE_VERSIONS, r);
}

/** The version this build renders `recipe` at, or `null` for a recipe it does not render. */
export function recipeVersionFor(recipe: string): string | null {
  return isRecipe(recipe) ? RECIPE_VERSIONS[recipe] : null;
}

/** `Castcade_Guard`'s mtime tolerance in seconds: DST and FILETIME conversions shift it by a whole hour. */
export const GUARD_MTIME_TOLERANCE_SEC = 3601;

export interface RenderOptions {
  /** What `Castcade_Init` receives and what the journal is named after (`tableIdFor(vpxPath)`). */
  tableId: string;
  rom: string | null;
  /** The `.vpx` as the sidecar will see it at load time (absolute Windows path). */
  originalPath: string;
  originalSize: number;
  originalMtimeMs: number;
  /** The sidecar's own path, which `Castcade_Guard` renames to `.stale` on a mismatch. */
  sidecarPath: string;
  /** Extra key constant names to lock (e.g. staged flippers): `Castcade_AddPlayKeys Array(...)`. */
  extraKeys?: string[];
  /**
   * NVRAM offsets the hook should journal (the map's `game_state` bytes, lib 0.3.0). `undefined` =
   * no watch list (the hook journals every changed byte, the 0.1.0 behaviour); `[]` = a ROM with no
   * map, so the hook journals no deltas at all (nothing could decode them).
   */
  watchOffsets?: number[] | null;
}

export interface Rendered {
  bytes: Uint8Array;
  sha256: string;
  warnings: string[];
  /** Where each block went, in terms of the ORIGINAL script's 1-based line numbers. */
  anchors: Record<string, string>;
  /**
   * C1.1: the warnings that mean a game cannot be journaled whole (no scores, no game start or no game end
   * anchor); the import report shows the recipe as partial with these. Recipe A leaves it out.
   */
  partial?: string[];
}

/** The marker on the sidecar's first block-0 line; `isOurSidecar` looks for it. */
export const SIDECAR_MARKER = /^' --- Castcade \(recipe ([A-Z]) v([\d.]+), lib ([\d.]+)\) ---/m;

/** True when `text` is a Castcade sidecar (any recipe or version). */
export function isOurSidecar(text: string): boolean {
  return SIDECAR_MARKER.test(text);
}

export interface SidecarMarker {
  recipe: string;
  recipeVersion: string;
  libVersion: string;
}

export function parseSidecarMarker(text: string): SidecarMarker | null {
  const m = SIDECAR_MARKER.exec(text);
  if (!m || m[1] === undefined || m[2] === undefined || m[3] === undefined) return null;
  return { recipe: m[1], recipeVersion: m[2], libVersion: m[3] };
}

/** `yyyy-mm-dd hh:nn:ss` in LOCAL time, what `Castcade_Guard` compares with `DateLastModified`. */
export function formatLocalStamp(ms: number): string {
  const d = new Date(ms);
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

/**
 * No-op stand-ins for every library entry point a sidecar may call, installed when `castcade.vbs`
 * is missing so the table still runs. One statement per sub, colon-separated, no double quotes.
 */
export const STUB =
  'Sub Castcade_Init(a,b,c,d):End Sub:Sub Castcade_Guard(a,b,c,d):End Sub:Sub Castcade_WatchBytes(a):End Sub:Sub Castcade_RegisterNVRAM():End Sub:' +
  'Function Castcade_KeyDownBlocked(k):Castcade_KeyDownBlocked=False:End Function:' +
  'Function Castcade_KeyUpBlocked(k):Castcade_KeyUpBlocked=False:End Function:' +
  'Sub Castcade_GameStart(p):End Sub:Sub Castcade_Scores(s,p,b):End Sub:' +
  'Sub Castcade_BallEnd(p,b,e):End Sub:Sub Castcade_GameEnd(s,p):End Sub:' +
  'Sub Castcade_Event(n,j):End Sub:Sub Castcade_Exit():End Sub:Sub Castcade_AddPlayKeys(a):End Sub';

export function block0(recipe: string, opts: RenderOptions): string[] {
  const id = vbStringLiteral(opts.tableId);
  const version = recipeVersionFor(recipe) ?? RECIPE_VERSION;
  const b = [
    `' --- Castcade (recipe ${recipe} v${version}, lib ${LIB_VERSION}) --- do not edit; delete this .vbs to revert to the embedded script`,
    'On Error Resume Next',
    'ExecuteGlobal GetTextFile("castcade.vbs")',
    'Dim Castcade_Probe : Castcade_Probe = Empty : Err.Clear : Castcade_Probe = Eval("Castcade_LibVersion")',
    'If Err.Number <> 0 Or IsEmpty(Castcade_Probe) Then',
    "    ' library missing: install no-op stubs so the table still runs, and leave a breadcrumb",
    `    ExecuteGlobal "${STUB}"`,
    `    CreateObject("Scripting.FileSystemObject").OpenTextFile(CreateObject("WScript.Shell").ExpandEnvironmentStrings("%TEMP%") & "\\castcade-sidecar-ran-but-no-library.txt", 8, True).WriteLine Now & "  " & ${id}`,
    'End If',
    `Castcade_Init ${id}, "${recipe}", "${version}", ${vbStringLiteral(opts.rom ?? '')}`,
    // The stale guard: original path, byte size and local mtime as they are now; the lib renames the
    // sidecar .stale and tells the player when they no longer match (lib 0.2.0; a 0.1.0 lib lacks
    // the sub and this line is a silent no-op under On Error Resume Next).
    `Castcade_Guard ${vbStringLiteral(opts.originalPath)}, ${Math.floor(opts.originalSize)}, "${formatLocalStamp(opts.originalMtimeMs)}", ${vbStringLiteral(opts.sidecarPath)}`,
  ];
  // The watch list (lib 0.3.0): only these NVRAM offsets are journaled, coalesced. Without it a WPC
  // table writes ~100 lines a second and stutters; a 0.2.0 lib ignores the line (Resume Next).
  if (opts.watchOffsets !== undefined && opts.watchOffsets !== null) {
    const offs = [...new Set(opts.watchOffsets.filter((o) => Number.isInteger(o) && o >= 0))].sort((a, b) => a - b);
    b.push(`Castcade_WatchBytes Array(${offs.join(', ')})`);
  }
  const keys = (opts.extraKeys ?? []).filter((k) => k.trim() !== '');
  if (keys.length > 0) b.push(`Castcade_AddPlayKeys Array(${keys.map((k) => vbStringLiteral(k.trim())).join(', ')})`);
  b.push('On Error Goto 0');
  b.push("' --- end Castcade block 0 ---");
  return b;
}

/** The table's own spelling of each handler name (`table1_Exit` beside `Table1_KeyDown`); absent = no such handler. */
export interface HandlerNames {
  keyDown: string;
  keyUp?: string | null;
  exit?: string | null;
}

/**
 * The wrapper tail. Each wrapper carries its handler's name exactly as the table spelled it, so the undo puts every
 * `Sub` line back byte for byte (GotG and Batman 66 write `Sub table1_Exit` beside `Sub Table1_KeyDown`; before
 * 2026-11-12 the undo gave all three the KeyDown spelling). With no `_Exit` in the table, ours takes the KeyDown
 * prefix. The wrappers are the last thing in the file that defines these names, so they are the handlers VPX calls.
 */
export function wrappers(names: HandlerNames): string[] {
  const prefix = names.keyDown.replace(/_KeyDown$/i, '');
  const w = [
    '',
    "' --- Castcade turn lock + exit hook (renamed originals: Castcade_Orig_KeyDown / _KeyUp / _Exit) ---",
    `Sub ${names.keyDown}(ByVal KeyCode)`,
    '    If Castcade_KeyDownBlocked(KeyCode) Then Exit Sub',
    '    Castcade_Orig_KeyDown KeyCode',
    'End Sub',
  ];
  if (names.keyUp) {
    w.push(`Sub ${names.keyUp}(ByVal KeyCode)`, '    If Castcade_KeyUpBlocked(KeyCode) Then Exit Sub', '    Castcade_Orig_KeyUp KeyCode', 'End Sub');
  }
  w.push(`Sub ${names.exit ?? `${prefix}_Exit`}()`, '    Castcade_Exit');
  if (names.exit) w.push('    Castcade_Orig_Exit');
  w.push('End Sub', "' --- end Castcade ---");
  return w;
}

/**
 * Rename `Sub <T>_<suffix>(...)` on line `idx` to `Sub Castcade_Orig_<suffix>(...)`; returns the name as the table
 * spelled it (`table1_Exit`), which the wrapper then takes, or `null` when the line is not that handler.
 */
export function renameHandler(lines: string[], tableObject: string, suffix: string, idx: number): string | null {
  const rx = new RegExp(`(\\bSub\\s+)(${escapeRegExp(tableObject)}_${suffix})\\b`, 'i');
  const line = lines[idx];
  const m = line === undefined ? null : rx.exec(line);
  if (line === undefined || !m) return null;
  lines[idx] = line.replace(rx, `$1Castcade_Orig_${suffix}`);
  return m[2] ?? null;
}

/**
 * Render the recipe-A sidecar for `scriptText` (the script exactly as `decodeScript` gave it).
 * Throws when the class is not A or the script already carries `Castcade_Init`.
 */
export function renderRecipeA(scriptText: string, cls: ClassifyResult, opts: RenderOptions): Rendered {
  if (cls.cls !== 'A') throw new Error(`renderRecipeA: class ${cls.cls} is not a VPM table (recipe A)`);
  if (cls.facts.alreadyPatched) throw new Error('renderRecipeA: script already contains Castcade_Init (already patched); refusing');
  const f = cls.facts;
  const T = f.tableObject;
  if (!T || !f.keyDownLine) throw new Error('renderRecipeA: no _KeyDown handler');

  const split = splitScript(scriptText);
  const out = [...split.lines];
  const endings = [...split.endings];
  const warnings: string[] = [];
  const anchors: Record<string, string> = {};
  const inserts: { idx: number; block: string[] }[] = [];

  // block 0
  const oe = f.optionExplicitLine ?? 0;
  inserts.push({ idx: oe > 0 ? oe : 0, block: block0('A', opts) });
  anchors['block0'] = oe > 0 ? `after Option Explicit (line ${oe})` : 'top of script';
  anchors['guard'] = `block 0: ${Math.floor(opts.originalSize)} bytes, ${formatLocalStamp(opts.originalMtimeMs)}`;

  // handlers
  const names = renameHandlers(out, f, anchors);

  // recipe A
  const lv = f.loadVpmLine ?? 0;
  if (lv <= 0) {
    warnings.push('no LoadVPM call line; NVRAM registration anchor missing (recipe A partial)');
  } else {
    if (f.useVpmNvramDeclared) {
      warnings.push('UseVPMNVRAM already declared by the table; forcing it True before LoadVPM without a Dim');
      inserts.push({ idx: lv - 1, block: ["UseVPMNVRAM = True   ' Castcade: enable Controller.ChangedNVRAM delivery (core.vbs line 37)"] });
    } else {
      inserts.push({ idx: lv - 1, block: ["Dim UseVPMNVRAM : UseVPMNVRAM = True   ' Castcade: enable Controller.ChangedNVRAM delivery (core.vbs line 37)"] });
    }
    inserts.push({ idx: lv, block: ["Castcade_RegisterNVRAM   ' Castcade: the one place NVRAMCallback is set (chains any existing callback)"] });
    anchors['useVpmNvram'] = `before LoadVPM (line ${lv})`;
    anchors['registerNvram'] = `after LoadVPM (line ${lv})`;
    if (f.nvramCallbackAlreadySet) warnings.push('table already sets NVRAMCallback; Castcade_RegisterNVRAM will chain it');
  }
  if (!opts.rom) warnings.push('cGameName not found; journal rom field empty');

  // apply inserts bottom-up so earlier indexes stay valid
  inserts.sort((a, b) => b.idx - a.idx);
  for (const { idx, block } of inserts) {
    out.splice(idx, 0, ...block);
    endings.splice(idx, 0, ...block.map(() => split.newline));
  }

  const tail = wrappers(names);
  out.push(...tail);
  endings.push(...tail.map(() => split.newline));
  anchors['wrappers'] = `appended (${tail.length} lines)`;

  // The table's own lines keep their own endings (C13); every inserted line gets the dominant one. The sidecar ends
  // as the script did (with or without a final newline), which is how the undo knows what the last line had.
  const bytes = encodeScript(joinScript({ lines: out, endings, newline: split.newline, trailingNewline: endsWithNewline(split) }));
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex'), warnings, anchors };
}

/** Rename the table's key and exit handlers (block L) and record them in `anchors`; the names go to `wrappers`. */
export function renameHandlers(out: string[], f: ClassifyResult['facts'], anchors: Record<string, string>): HandlerNames {
  const T = f.tableObject ?? 'Table1';
  const names: HandlerNames = { keyDown: renameHandler(out, T, 'KeyDown', (f.keyDownLine ?? 0) - 1) ?? `${T}_KeyDown` };
  anchors['keyDown'] = `Sub ${T}_KeyDown renamed Castcade_Orig_KeyDown (line ${f.keyDownLine})`;
  if (f.keyUpLine) {
    names.keyUp = renameHandler(out, T, 'KeyUp', f.keyUpLine - 1) ?? `${T}_KeyUp`;
    anchors['keyUp'] = `Sub ${T}_KeyUp renamed Castcade_Orig_KeyUp (line ${f.keyUpLine})`;
  }
  if (f.exitLine) {
    names.exit = renameHandler(out, T, 'Exit', f.exitLine - 1) ?? `${T}_Exit`;
    anchors['exit'] = `Sub ${T}_Exit renamed Castcade_Orig_Exit (line ${f.exitLine})`;
  }
  return names;
}

/**
 * Whether the sidecar ends with a newline: as the script did. An empty script counts as ending with one. The undo
 * reads it back from the sidecar's own end, so a script without a final newline comes back without one.
 */
export function endsWithNewline(split: { lines: readonly string[]; trailingNewline: boolean }): boolean {
  return split.trailingNewline || split.lines.every((l) => l === '');
}

/** The single lines recipe A inserts around `LoadVPM` (exact templates; see `renderRecipeA`). */
const RECIPE_A_LINE_INSERTS = [
  /^Dim UseVPMNVRAM : UseVPMNVRAM = True {3}' Castcade: /,
  /^UseVPMNVRAM = True {3}' Castcade: /,
  /^Castcade_RegisterNVRAM {3}' Castcade: /,
];

/**
 * What recipes B/C/D put into the table's own lines (`render-originals.ts`): the single line inserted at an anchor
 * (always this indent and this comment), the call put in front of an early `Exit Sub`, and recipe D's replacement
 * for the ScoreServer `CreateObject`. The undo below takes out exactly these.
 */
export const ORIGINAL_LINE_INSERT = /^ {4}Castcade_[BCD]_[A-Za-z]+(?: [A-Za-z_][\w.]*)? {3}' Castcade: /;
export const ORIGINAL_EXIT_INSERT = /Castcade_[BCD]_[A-Za-z]+ : (?=Exit\s+(Sub|Function)\b)/gi;
export const SCORE_SERVER_CREATE = 'CreateObject("VPinball.ScoreServer")';
export const SCORE_SERVER_SHIM_CALL = 'Castcade_D_ScoreServer()';
/** The first and last line of the block recipes B/C/D append after the wrappers. */
export const originalsBlockStart = (recipe: string): string =>
  `' --- Castcade recipe ${recipe} anchors (the table's own variables; called from the lines marked ' Castcade: in its subs) ---`;
export const originalsBlockEnd = (recipe: string): string => `' --- end Castcade recipe ${recipe} ---`;

/**
 * Undo a Castcade sidecar of any recipe this build renders (A–D) exactly: drop block 0, the wrapper tail and the
 * originals' anchor block by their markers, drop the lines inserted at anchors by their templates (recipe A's two
 * `LoadVPM` lines, B/C/D's anchor calls), take out the calls put in front of an early `Exit Sub`, put back recipe D's
 * `CreateObject("VPinball.ScoreServer")`, and rename `Castcade_Orig_<handler>` back to `<table>_<handler>`. What is
 * left is the table's own script plus anything a person changed in the sidecar, so a diff against the embedded
 * script shows only their edits (F5: Castcade's own patch is exempt by content, not by name). Null when `text` is
 * not ours, or is a recipe this build does not render (it refuses rather than guess).
 */
export function unpatchSidecar(text: string): string | null {
  const marker = parseSidecarMarker(text);
  if (!marker || !isRecipe(marker.recipe)) return null;
  const recipe = marker.recipe;
  const split = splitScript(text);
  const lines = split.lines;
  const start0 = lines.findIndex((l) => SIDECAR_MARKER.test(l));
  const end0 = lines.findIndex((l, i) => i > start0 && l === "' --- end Castcade block 0 ---");
  if (start0 < 0 || end0 < 0) return null;
  const wrapStart = lines.findIndex((l) => l.startsWith("' --- Castcade turn lock + exit hook"));
  const wrapEnd = lines.findIndex((l, i) => i > wrapStart && l === "' --- end Castcade ---");
  // Each wrapper carries its handler's own spelling (`Sub table1_Exit()`); a sidecar from before that was rendered
  // has the KeyDown prefix on all three, which is what its undo always gave.
  const spelled: Record<string, string> = {};
  if (wrapStart >= 0 && wrapEnd > wrapStart) {
    for (const l of lines.slice(wrapStart, wrapEnd)) {
      const m = /^Sub (\w+_(KeyDown|KeyUp|Exit))\((?:ByVal KeyCode)?\)$/i.exec(l);
      if (m?.[1] && m[2]) spelled[m[2].toLowerCase()] = m[1];
    }
  }
  const drop = new Set<number>();
  for (let i = start0; i <= end0; i++) drop.add(i);
  if (wrapStart >= 0 && wrapEnd > wrapStart) {
    // `wrappers()` starts with one blank line.
    const from = wrapStart > 0 && lines[wrapStart - 1] === '' ? wrapStart - 1 : wrapStart;
    for (let i = from; i <= wrapEnd; i++) drop.add(i);
  }
  if (recipe !== 'A') {
    const startB = lines.indexOf(originalsBlockStart(recipe));
    const endB = lines.findIndex((l, i) => i > startB && l === originalsBlockEnd(recipe));
    if (startB < 0 || endB < 0) return null;
    // `renderOriginal` puts one blank line before it.
    const from = startB > 0 && lines[startB - 1] === '' && !drop.has(startB - 1) ? startB - 1 : startB;
    for (let i = from; i <= endB; i++) drop.add(i);
  }
  lines.forEach((l, i) => {
    if (recipe === 'A' ? RECIPE_A_LINE_INSERTS.some((rx) => rx.test(l)) : ORIGINAL_LINE_INSERT.test(l)) drop.add(i);
  });
  const kept = lines
    .filter((_, i) => !drop.has(i))
    .map((l) => l.replace(/(\bSub\s+)Castcade_Orig_(KeyDown|KeyUp|Exit)\b/i, (whole: string, sub: string, suffix: string) => (spelled[suffix.toLowerCase()] ? `${sub}${spelled[suffix.toLowerCase()]}` : whole)))
    .map((l) => (recipe === 'A' ? l : l.replace(ORIGINAL_EXIT_INSERT, '').split(SCORE_SERVER_SHIM_CALL).join(SCORE_SERVER_CREATE)));
  const endings = split.endings.filter((_, i) => !drop.has(i));
  return joinScript({ lines: kept, endings, newline: split.newline, trailingNewline: split.trailingNewline });
}

/** The historical name (recipe A was the only recipe): undoes every recipe now, see `unpatchSidecar`. */
export const unpatchRecipeA = unpatchSidecar;
