/**
 * Recipe A renderer (`docs/design/table-import-and-patching.md` §5): the original script with block 0
 * (library load, `Castcade_Init`, the 0.2.0 stale guard), `UseVPMNVRAM` before `LoadVPM`,
 * `Castcade_RegisterNVRAM` after it, and the `_KeyDown` / `_KeyUp` / `_Exit` wrappers (block L).
 * Port of `block0()`, `wrappers()`, `rename_handler()` and the recipe-A branch of `render()` in
 * `vpx-hook/spike/render-sidecar.py`. Pure: text in, bytes out; everything inserted is ASCII.
 */
import { createHash } from 'node:crypto';
import type { ClassifyResult } from './classify.js';
import { encodeScript, escapeRegExp, splitScript, joinScript, vbStringLiteral } from './script-text.js';

/** Must equal `Castcade_LibVersion` in `vpx-hook/castcade.vbs` (a test checks the file). */
export const LIB_VERSION = '0.2.0';
export const RECIPE_VERSION = '0.2.0';

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
}

export interface Rendered {
  bytes: Uint8Array;
  sha256: string;
  warnings: string[];
  /** Where each block went, in terms of the ORIGINAL script's 1-based line numbers. */
  anchors: Record<string, string>;
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
  'Sub Castcade_Init(a,b,c,d):End Sub:Sub Castcade_Guard(a,b,c,d):End Sub:Sub Castcade_RegisterNVRAM():End Sub:' +
  'Function Castcade_KeyDownBlocked(k):Castcade_KeyDownBlocked=False:End Function:' +
  'Function Castcade_KeyUpBlocked(k):Castcade_KeyUpBlocked=False:End Function:' +
  'Sub Castcade_GameStart(p):End Sub:Sub Castcade_Scores(s,p,b):End Sub:' +
  'Sub Castcade_BallEnd(p,b,e):End Sub:Sub Castcade_GameEnd(s,p):End Sub:' +
  'Sub Castcade_Event(n,j):End Sub:Sub Castcade_Exit():End Sub:Sub Castcade_AddPlayKeys(a):End Sub';

export function block0(recipe: string, opts: RenderOptions): string[] {
  const id = vbStringLiteral(opts.tableId);
  const b = [
    `' --- Castcade (recipe ${recipe} v${RECIPE_VERSION}, lib ${LIB_VERSION}) --- do not edit; delete this .vbs to revert to the embedded script`,
    'On Error Resume Next',
    'ExecuteGlobal GetTextFile("castcade.vbs")',
    'Dim Castcade_Probe : Castcade_Probe = Empty : Err.Clear : Castcade_Probe = Eval("Castcade_LibVersion")',
    'If Err.Number <> 0 Or IsEmpty(Castcade_Probe) Then',
    "    ' library missing: install no-op stubs so the table still runs, and leave a breadcrumb",
    `    ExecuteGlobal "${STUB}"`,
    `    CreateObject("Scripting.FileSystemObject").OpenTextFile(CreateObject("WScript.Shell").ExpandEnvironmentStrings("%TEMP%") & "\\castcade-sidecar-ran-but-no-library.txt", 8, True).WriteLine Now & "  " & ${id}`,
    'End If',
    `Castcade_Init ${id}, "${recipe}", "${RECIPE_VERSION}", ${vbStringLiteral(opts.rom ?? '')}`,
    // The stale guard: original path, byte size and local mtime as they are now; the lib renames the
    // sidecar .stale and tells the player when they no longer match (lib 0.2.0; a 0.1.0 lib lacks
    // the sub and this line is a silent no-op under On Error Resume Next).
    `Castcade_Guard ${vbStringLiteral(opts.originalPath)}, ${Math.floor(opts.originalSize)}, "${formatLocalStamp(opts.originalMtimeMs)}", ${vbStringLiteral(opts.sidecarPath)}`,
  ];
  const keys = (opts.extraKeys ?? []).filter((k) => k.trim() !== '');
  if (keys.length > 0) b.push(`Castcade_AddPlayKeys Array(${keys.map((k) => vbStringLiteral(k.trim())).join(', ')})`);
  b.push('On Error Goto 0');
  b.push("' --- end Castcade block 0 ---");
  return b;
}

export function wrappers(tableObject: string, haveKeyUp: boolean, haveExit: boolean): string[] {
  const w = [
    '',
    "' --- Castcade turn lock + exit hook (renamed originals: Castcade_Orig_KeyDown / _KeyUp / _Exit) ---",
    `Sub ${tableObject}_KeyDown(ByVal KeyCode)`,
    '    If Castcade_KeyDownBlocked(KeyCode) Then Exit Sub',
    '    Castcade_Orig_KeyDown KeyCode',
    'End Sub',
  ];
  if (haveKeyUp) {
    w.push(`Sub ${tableObject}_KeyUp(ByVal KeyCode)`, '    If Castcade_KeyUpBlocked(KeyCode) Then Exit Sub', '    Castcade_Orig_KeyUp KeyCode', 'End Sub');
  }
  w.push(`Sub ${tableObject}_Exit()`, '    Castcade_Exit');
  if (haveExit) w.push('    Castcade_Orig_Exit');
  w.push('End Sub', "' --- end Castcade ---");
  return w;
}

/** Rename `Sub <T>_<suffix>(...)` on line `idx` to `Sub Castcade_Orig_<suffix>(...)`. */
function renameHandler(lines: string[], tableObject: string, suffix: string, idx: number): void {
  const rx = new RegExp(`(\\bSub\\s+)${escapeRegExp(tableObject)}_${suffix}\\b`, 'i');
  const line = lines[idx];
  if (line !== undefined) lines[idx] = line.replace(rx, `$1Castcade_Orig_${suffix}`);
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
  const warnings: string[] = [];
  const anchors: Record<string, string> = {};
  const inserts: { idx: number; block: string[] }[] = [];

  // block 0
  const oe = f.optionExplicitLine ?? 0;
  inserts.push({ idx: oe > 0 ? oe : 0, block: block0('A', opts) });
  anchors['block0'] = oe > 0 ? `after Option Explicit (line ${oe})` : 'top of script';
  anchors['guard'] = `block 0: ${Math.floor(opts.originalSize)} bytes, ${formatLocalStamp(opts.originalMtimeMs)}`;

  // handlers
  renameHandler(out, T, 'KeyDown', f.keyDownLine - 1);
  anchors['keyDown'] = `Sub ${T}_KeyDown renamed Castcade_Orig_KeyDown (line ${f.keyDownLine})`;
  if (f.keyUpLine) {
    renameHandler(out, T, 'KeyUp', f.keyUpLine - 1);
    anchors['keyUp'] = `Sub ${T}_KeyUp renamed Castcade_Orig_KeyUp (line ${f.keyUpLine})`;
  }
  if (f.exitLine) {
    renameHandler(out, T, 'Exit', f.exitLine - 1);
    anchors['exit'] = `Sub ${T}_Exit renamed Castcade_Orig_Exit (line ${f.exitLine})`;
  }

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
  for (const { idx, block } of inserts) out.splice(idx, 0, ...block);

  const tail = wrappers(T, Boolean(f.keyUpLine), Boolean(f.exitLine));
  out.push(...tail);
  anchors['wrappers'] = `appended (${tail.length} lines)`;

  const bytes = encodeScript(joinScript({ lines: out, newline: split.newline, trailingNewline: true }));
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex'), warnings, anchors };
}
