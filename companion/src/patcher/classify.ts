/**
 * Table-script classifier: `docs/design/table-import-and-patching.md` §4, first match wins. A port of
 * `classify()` in `vpx-hook/spike/render-sidecar.py` (the Phase 0 renderer). Regex + anchors over the
 * code part of each line (comments stripped, string literals kept); no VBScript parser.
 */
import { escapeRegExp, findLine, findSub, hasIdent, splitScript, stripComment } from './script-text.js';

export type ScriptClass = 'A' | 'B' | 'C' | 'D' | 'E' | 'X';

export type ScorbitAnchor = 'StartSession' | 'SendUpdate' | 'StopSession';
export type OriginalSub = 'AddScore' | 'ResetForNewGame' | 'EndOfGame' | 'EndOfBall';

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
  subs?: Record<OriginalSub, number | null>;
  scoreArray?: boolean;
  /** `Castcade_Init` appears outside a comment: the script is already a Castcade sidecar. */
  alreadyPatched?: boolean;
};

export interface ClassifyResult {
  cls: ScriptClass;
  facts: ScriptFacts;
}

const lineNo = (idx: number): number | null => (idx < 0 ? null : idx + 1);

export function classifyScript(text: string): ClassifyResult {
  return classifyLines(splitScript(text).lines);
}

export function classifyLines(lines: readonly string[]): ClassifyResult {
  const facts: ScriptFacts = {};
  facts.alreadyPatched = lines.some((l) => stripComment(l).includes('Castcade_Init'));

  const kd = findLine(lines, /^\s*(Public\s+|Private\s+)?Sub\s+(\w+)_KeyDown\s*\(/);
  if (kd < 0) return { cls: 'X', facts: { ...facts, reason: 'no _KeyDown handler' } };
  const m = /Sub\s+(\w+)_KeyDown/i.exec(stripComment(lines[kd] ?? ''));
  const t = m?.[1] ?? 'Table1';
  const T = escapeRegExp(t);
  facts.tableObject = t;
  facts.keyDownLine = kd + 1;
  facts.keyUpLine = lineNo(findLine(lines, new RegExp(`^\\s*(Public\\s+|Private\\s+)?Sub\\s+${T}_KeyUp\\s*\\(`)));
  facts.exitLine = lineNo(findLine(lines, new RegExp(`^\\s*(Public\\s+|Private\\s+)?Sub\\s+${T}_Exit\\b`)));
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

  const sub = (name: OriginalSub) => lineNo(findSub(lines, name)[0]);
  facts.subs = { AddScore: sub('AddScore'), ResetForNewGame: sub('ResetForNewGame'), EndOfGame: sub('EndOfGame'), EndOfBall: sub('EndOfBall') };
  facts.scoreArray = findLine(lines, /^\s*Dim\s+Score\s*\(/) >= 0;
  if (facts.subs.AddScore && facts.subs.ResetForNewGame && facts.subs.EndOfGame) return { cls: 'B', facts };
  if (facts.scorbitAnchors.StartSession && facts.scorbitAnchors.SendUpdate && facts.scorbitAnchors.StopSession) return { cls: 'C', facts };
  if (facts.scoreServer) return { cls: 'D', facts };
  if (hasIdent(lines, 'Score') || hasIdent(lines, 'AddScore') || hasIdent(lines, 'Points')) return { cls: 'E', facts };
  return { cls: 'X', facts: { ...facts, reason: 'no scoring identifiers' } };
}

/** One line for the import report: what a class means for the player. */
export function describeClass(cls: ScriptClass): string {
  switch (cls) {
    case 'A':
      return 'VPM / ROM table';
    case 'B':
      return 'original table (JPSalas pattern)';
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
