/**
 * Table-script classifier: `docs/design/table-import-and-patching.md` §4, first match wins. A port of
 * `classify()` in `vpx-hook/spike/render-sidecar.py` (the Phase 0 renderer). Regex + anchors over the
 * code part of each line (comments stripped, string literals kept); no VBScript parser.
 *
 * C1.3: class B is any original whose script has the four anchors by role, not only JPSalas' names: `AddScore`, a
 * start sub, an end sub (or a plain statement clearing the game flag, when the table has no end sub) and, optionally,
 * a ball-end sub. The vocabulary (`START_SUBS` etc.) is shared with recipe B in `render-originals.ts`.
 *
 * C1.4: a script that matches an anchor override (`anchor-overrides.ts`: a known framework or template the vocabulary
 * cannot read, e.g. the VPX Game Logic Framework) is class B ahead of everything but A; recipe B takes the anchors
 * and expressions the override names and the vocabulary for the rest.
 */
import { findOverride } from './anchor-overrides.js';
import { PROC_HEAD, escapeRegExp, findLine, findSub, hasIdent, lineContexts, looksUtf16, splitScript, stripComment, type LineContext } from './script-text.js';

export type ScriptClass = 'A' | 'B' | 'C' | 'D' | 'E' | 'X';

export type ScorbitAnchor = 'StartSession' | 'SendUpdate' | 'StopSession';
/** The four anchor roles recipe B fills from an original table's own subs (C1.3: by role, the names vary). */
export type OriginalSub = 'AddScore' | 'start' | 'end' | 'ballEnd';
/** A sub found for a role: its name as the table spells it and its 1-based `Sub` line. */
export interface FoundSub {
  name: string;
  line: number;
}
/** The statement that clears the table's game flag, standing in for a game-end sub (recipe B's fallback). */
export interface GameFlagClear {
  /** 1-based line of the statement. */
  line: number;
  /** The sub it is in. */
  sub: string;
  /** The statement as written, e.g. `gameon = 0`. */
  text: string;
}

// The original-table vocabulary (C1.3): for each role, the names in the order tried; the first that exists wins.
export const START_SUBS: readonly string[] = ['ResetForNewGame', 'StartGame', 'StartNewGame', 'NewGame', 'InitGame'];
export const END_SUBS: readonly string[] = ['EndOfGame', 'GameOver', 'EndGame'];
export const BALL_END_SUBS: readonly string[] = ['EndOfBall', 'EndBall', 'EndPlayerTurn', 'BallDrained'];
/**
 * A plain statement that clears the game flag (`gameon = 0`, `GameActive = False`, `GameOver = 1`, ...), the whole
 * statement at the start of the line (so not the `x` of a one-line `If ... Then x`), optionally followed by `:`.
 */
export const GAME_FLAG_CLEAR = /^\s*(?:(gameon|GameActive|bGameInPlay|GameInProgress|GameStarted)\s*=\s*(?:0|False)|(GameOver)\s*=\s*(?:1|True))\s*(?::|$)/i;
/** Event handlers a game-flag clear never counts in (table load / unload and the key handlers). */
const FLAG_CLEAR_HANDLER = /_(Init|Exit|KeyDown|KeyUp)$/i;

/** The first of `names` that exists as a Sub / Function, with its spelling and line. */
export function findFirstSub(lines: readonly string[], names: readonly string[]): FoundSub | null {
  for (const name of names) {
    const [s] = findSub(lines, name);
    if (s < 0) continue;
    return { name: PROC_HEAD.exec(stripComment(lines[s] ?? ''))?.[2] ?? name, line: s + 1 };
  }
  return null;
}

/**
 * The first game-flag clear that can stand in for a game end: inside a multi-line sub that is not the start sub, not a
 * class member and not a load / unload / key handler (`Table1_Init` clears the flag at load; `StartGame` resets it).
 */
export function findGameFlagClear(lines: readonly string[], ctx: readonly LineContext[], start: FoundSub | null): GameFlagClear | null {
  return findGameFlagClears(lines, ctx, start)[0] ?? null;
}

/**
 * Every such clear, in script order (recipe B 0.3.0 anchors the game end after each: Rattlecan sets `GameOver=1` in
 * the timer of a normal drain and again in the timer of a drain after a tilt). A clear whose line ends in a line
 * continuation is left out.
 */
export function findGameFlagClears(lines: readonly string[], ctx: readonly LineContext[], start: FoundSub | null): GameFlagClear[] {
  const out: GameFlagClear[] = [];
  for (let i = 0; i < lines.length; i++) {
    const c = ctx[i];
    if (!c || c.proc < 0 || c.proc === i || c.inClass || FLAG_CLEAR_HANDLER.test(c.procName)) continue;
    if (start && c.proc === start.line - 1) continue;
    const code = stripComment(lines[i] ?? '');
    if (!GAME_FLAG_CLEAR.test(code) || /(?:^|\s)_\s*$/.test(code)) continue;
    out.push({ line: i + 1, sub: c.procName, text: code.trim().replace(/\s*:.*$/, '') });
  }
  return out;
}

/**
 * What the classifier found. Line numbers are 1-based into the script as `splitScript` splits it;
 * `null` means the anchor is absent. Only `tableObject`, `rom` and `reason` are part of the module
 * contract; the rest is what a recipe needs and what the import report shows.
 */
export type ScriptFacts = {
  /** Why the script is class X (or why it is not a full class), when applicable. */
  reason?: string;
  /** The table object name taken from `Sub <T>_KeyDown`. */
  tableObject?: string;
  /** `cGameName = "..."` (class A); `null` when a VPM table never names its ROM. */
  rom?: string | null;
  keyDownLine?: number;
  keyUpLine?: number | null;
  exitLine?: number | null;
  optionExplicitLine?: number | null;
  /** `LoadVPM` call line (class A); `null` when the table creates the controller itself. */
  loadVpmLine?: number | null;
  nvramCallbackAlreadySet?: boolean;
  useVpmNvramDeclared?: boolean;
  scorbitAnchors?: Record<ScorbitAnchor, number | null>;
  scoreServer?: boolean;
  /** The sub found for each recipe-B role (`null` = none of that role's names exists). */
  subs?: Record<OriginalSub, FoundSub | null>;
  /** With no end sub: the game-flag clear that stands in for it; `null` when there is none (or an end sub exists). */
  gameEndFlag?: GameFlagClear | null;
  scoreArray?: boolean;
  /** C1.4: the id of the anchor override the script matches (`anchor-overrides.ts`); `null` when none does. */
  override?: string | null;
  /** `Castcade_Init` appears outside a comment: the script is already a Castcade sidecar. */
  alreadyPatched?: boolean;
};

export interface ClassifyResult {
  cls: ScriptClass;
  facts: ScriptFacts;
}

const lineNo = (idx: number): number | null => (idx < 0 ? null : idx + 1);

/**
 * The LAST line matching `rx`. VBScript keeps the last definition of a name, so when a table defines a handler twice
 * (Congo and Hook define `Table1_Exit` twice, the second one saving the LUT) the last one is the handler that runs,
 * and it is the one the wrapper must rename and call.
 */
function findLastLine(lines: readonly string[], rx: RegExp): number {
  let at = -1;
  for (let i = findLine(lines, rx); i >= 0; i = findLine(lines, rx, i + 1)) at = i;
  return at;
}

export function classifyScript(text: string): ClassifyResult {
  if (looksUtf16(text)) {
    return { cls: 'X', facts: { reason: 'script is UTF-16 text, not the ANSI VPX writes; re-save the table from the VPX editor' } };
  }
  return classifyLines(splitScript(text).lines);
}

export function classifyLines(lines: readonly string[]): ClassifyResult {
  const facts: ScriptFacts = {};
  facts.alreadyPatched = lines.some((l) => stripComment(l).includes('Castcade_Init'));

  // The table object is named by the FIRST `Sub <T>_KeyDown(` (a framework's own `Glf_KeyDown` comes later in the
  // script); of that handler, the LAST definition is the one that runs.
  const first = findLine(lines, /^\s*(Public\s+|Private\s+)?Sub\s+(\w+)_KeyDown\s*\(/);
  if (first < 0) return { cls: 'X', facts: { ...facts, reason: 'no _KeyDown handler' } };
  const m = /Sub\s+(\w+)_KeyDown/i.exec(stripComment(lines[first] ?? ''));
  const t = m?.[1] ?? 'Table1';
  const T = escapeRegExp(t);
  const kd = findLastLine(lines, new RegExp(`^\\s*(Public\\s+|Private\\s+)?Sub\\s+${T}_KeyDown\\s*\\(`));
  facts.tableObject = t;
  facts.keyDownLine = kd + 1;
  facts.keyUpLine = lineNo(findLastLine(lines, new RegExp(`^\\s*(Public\\s+|Private\\s+)?Sub\\s+${T}_KeyUp\\s*\\(`)));
  facts.exitLine = lineNo(findLastLine(lines, new RegExp(`^\\s*(Public\\s+|Private\\s+)?Sub\\s+${T}_Exit\\b`)));
  facts.optionExplicitLine = lineNo(findLine(lines, /^\s*Option\s+Explicit\b/));
  facts.nvramCallbackAlreadySet = findLine(lines, /\bSet\s+NVRAMCallback\b/) >= 0;
  facts.useVpmNvramDeclared = findLine(lines, /^\s*(Dim|Const)\s+UseVPMNVRAM\b/) >= 0;
  facts.scorbitAnchors = {
    StartSession: lineNo(findLine(lines, /\bScorbit\.StartSession\b/)),
    SendUpdate: lineNo(findLine(lines, /\bScorbit\.SendUpdate\b/)),
    StopSession: lineNo(findLine(lines, /\bScorbit\.StopSession\b/)),
  };
  facts.scoreServer = findLine(lines, /CreateObject\s*\(\s*"VPinball\.ScoreServer"/) >= 0 || hasIdent(lines, 'SetScoresArray');

  const loadVpm = findLine(lines, /^\s*LoadVPM\b/);
  const vpmCtrl = findLine(lines, /CreateObject\s*\(\s*"VPinMAME\.Controller"\s*\)/) >= 0;
  if (loadVpm >= 0 || vpmCtrl) {
    facts.loadVpmLine = lineNo(loadVpm);
    let rom: string | null = null;
    const rx = /\bcGameName\s*=\s*"([^"]+)"/i;
    for (const l of lines) {
      const mm = rx.exec(stripComment(l));
      if (mm?.[1] !== undefined) {
        rom = mm[1];
        break;
      }
    }
    facts.rom = rom;
    return { cls: 'A', facts };
  }

  const ctx = lineContexts(lines);
  const start = findFirstSub(lines, START_SUBS);
  const end = findFirstSub(lines, END_SUBS);
  facts.subs = { AddScore: findFirstSub(lines, ['AddScore']), start, end, ballEnd: findFirstSub(lines, BALL_END_SUBS) };
  facts.gameEndFlag = end ? null : findGameFlagClear(lines, ctx, start);
  facts.scoreArray = findLine(lines, /^\s*Dim\s+Score\s*\(/) >= 0;
  // C1.4: a script an override knows is class B whatever else it has; the override says where its anchors are.
  facts.override = findOverride(lines)?.id ?? null;
  if (facts.override) return { cls: 'B', facts };
  // The JPSalas trio is class B ahead of everything, as before C1.3. A table that reaches B only through the wider
  // vocabulary yields to C and D first: Scorbit's SendUpdate arguments and the ScoreServer API say exactly what the
  // game thinks, where the vocabulary guesses at variables.
  const jpsalas = facts.subs.AddScore && findSub(lines, 'ResetForNewGame')[0] >= 0 && findSub(lines, 'EndOfGame')[0] >= 0;
  if (jpsalas) return { cls: 'B', facts };
  if (facts.scorbitAnchors.StartSession && facts.scorbitAnchors.SendUpdate && facts.scorbitAnchors.StopSession) return { cls: 'C', facts };
  if (facts.scoreServer) return { cls: 'D', facts };
  if (facts.subs.AddScore && start && (end || facts.gameEndFlag)) return { cls: 'B', facts };
  if (hasIdent(lines, 'Score') || hasIdent(lines, 'AddScore') || hasIdent(lines, 'Points')) return { cls: 'E', facts };
  return { cls: 'X', facts: { ...facts, reason: 'no scoring identifiers' } };
}

/** One line for the import report: what a class means for the player. */
export function describeClass(cls: ScriptClass): string {
  switch (cls) {
    case 'A':
      return 'VPM / ROM table';
    case 'B':
      return 'original table (script anchors)';
    case 'C':
      return 'original table (Scorbit-anchored)';
    case 'D':
      return 'original table (ScoreServer-integrated)';
    case 'E':
      return 'original table (generic)';
    case 'X':
      return 'unsupported';
  }
}
