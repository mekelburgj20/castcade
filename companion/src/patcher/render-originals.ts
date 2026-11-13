/**
 * Recipes B, C and D (WORK C1.1, `docs/design/table-import-and-patching.md` §5): sidecars for ORIGINAL tables, the
 * ones with no ROM, whose score lives in the table's own variables. An original leaves no NVRAM, so the journal
 * events come from the table's script: block 0 and the key wrappers as recipe A renders them, plus one call line at
 * each anchor sub and a block of `Castcade_<recipe>_*` subs after the wrappers that read the table's variables and
 * call the library (`Castcade_GameStart` / `Castcade_Scores` / `Castcade_BallEnd` / `Castcade_GameEnd`, lib 0.5.0).
 *
 * - **B** (script anchors; 0.2.0 = C1.3, the original-table vocabulary in `classify.ts`): `Castcade_<R>_GameStart`
 *   at the end of the start sub (`ResetForNewGame` / `StartGame` / `StartNewGame` / `NewGame` / `InitGame`),
 *   `_Scores` at the end of `AddScore` and in front of each of its early `Exit Sub`, `_BallEnd` at the TOP of the
 *   ball-end sub (`EndOfBall` / `EndBall` / `EndPlayerTurn` / `BallDrained`: the ball that just drained, before
 *   anything advances; JPSalas' `EndOfBall` hands over to a timer) or else in front of the `BallsRemaining`
 *   decrement, `_GameEnd` at the end of the end sub (`EndOfGame` / `GameOver` / `EndGame`), or in front of the
 *   statement in it that clears the score store (0.3.1: The Matrix (Original) zeroes `Score(i)` there) or, with none, right after
 *   the first plain statement that clears the game flag (`gameon = 0`, `GameActive = False`, `GameOver = 1`, ...).
 *   The score store is read from `AddScore`'s body (the first `X = X + ...`; a `score`-named one first; one call
 *   level down when `AddScore` only calls a helper): an array `X(I)` journals `X` with `I` as the player, 0- or
 *   1-based as the table sets `I`; a scalar `X` journals `Array(X)` with the current-player variable, or a family
 *   `p1score, p2score, ...` as one array. The ball, player count and extra balls come from the table's variables
 *   by the same vocabulary (`recipeB` below), each with a warning when absent.
 * - **C** (Scorbit-anchored): the expressions the table passes to `Scorbit.SendUpdate` (4 scores, ball, player,
 *   players) are what the anchors journal; `Scorbit.StartSession` / `StopSession` place the game start and end at
 *   the end of the sub that calls them. Those calls sit behind the table's Scorbit guards, so a call inside a
 *   Scorbit-named helper is followed one level up to its caller, and the line goes at the end of that sub, outside
 *   the guard. Live scores ride `AddScore` when the table has one.
 * - **D** (ScoreServer-integrated): every `CreateObject("VPinball.ScoreServer")` becomes `Castcade_D_ScoreServer()`,
 *   which hands the table the library's shim (journals, forwards to the real object when there is one). Refused,
 *   with the reason, when the table calls a method the shim does not have or with another argument count.
 *
 * **Anchor overrides (C1.4, B 0.3.0):** a script that matches a record in `anchor-overrides.ts` (the VPX Game Logic
 * Framework, the Burger template, Rattlecan) takes the anchor places and the expressions the record names; whatever
 * the record leaves out comes from the vocabulary. A game end is journaled once per journaled game start, so an
 * anchor after every game-flag clear cannot report a game that never began.
 *
 * Early `Exit Sub`: only the scores call is put in front of one (it repeats harmlessly); a game start or end on an
 * early-exit path is not journaled, and the warning says so instead of inventing control flow. Everything injected
 * runs under `On Error Resume Next` in our own subs, so a missing variable silences one event and never stops the
 * table. Pure: text in, bytes out; `unpatchSidecar` (render.ts) undoes it exactly.
 */
import { createHash } from 'node:crypto';
import { findOverride, passSuffix, resolvePlace, type AnchorOverride, type AnchorRole } from './anchor-overrides.js';
import { BALL_END_SUBS, END_SUBS, START_SUBS, findFirstSub, findGameFlagClears, type ClassifyResult, type FoundSub, type ScriptClass } from './classify.js';
import {
  SCORE_SERVER_CREATE,
  SCORE_SERVER_SHIM_CALL,
  block0,
  endsWithNewline,
  formatLocalStamp,
  originalsBlockEnd,
  originalsBlockStart,
  renameHandlers,
  renderRecipeA,
  wrappers,
  type Recipe,
  type RenderOptions,
  type Rendered,
} from './render.js';
import { encodeScript, escapeRegExp, findLine, findSub, hasIdent, joinScript, lineContexts, splitScript, stripComment, type LineContext } from './script-text.js';

type OriginalRecipe = 'B' | 'C' | 'D';

/** The recipe a class renders with, or `null` (E needs a guided pick in the app; X is never patched). */
export function recipeFor(cls: ScriptClass): Recipe | null {
  return cls === 'A' || cls === 'B' || cls === 'C' || cls === 'D' ? cls : null;
}

/** Render the sidecar for any class this build has a recipe for; throws for E and X. */
export function renderSidecar(scriptText: string, cls: ClassifyResult, opts: RenderOptions): Rendered {
  switch (cls.cls) {
    case 'A':
      return renderRecipeA(scriptText, cls, opts);
    case 'B':
    case 'C':
    case 'D':
      return renderOriginal(cls.cls, scriptText, cls, opts);
    default:
      throw new Error(`renderSidecar: class ${cls.cls} has no recipe`);
  }
}

export const renderRecipeB = (text: string, cls: ClassifyResult, opts: RenderOptions): Rendered => renderOriginal('B', text, cls, opts);
export const renderRecipeC = (text: string, cls: ClassifyResult, opts: RenderOptions): Rendered => renderOriginal('C', text, cls, opts);
export const renderRecipeD = (text: string, cls: ClassifyResult, opts: RenderOptions): Rendered => renderOriginal('D', text, cls, opts);

// ------------------------------------------------------------------------------------------- script reading

interface SubRange {
  /** The name as the table spells it. */
  name: string;
  /** 0-based index of the `Sub` line and of its `End Sub` line. */
  start: number;
  end: number;
}

const SUB_HEAD = /^\s*(?:Public\s+|Private\s+)?(?:Default\s+)?(Sub|Function)\s+(\w+)/i;
const END_PROC = /^\s*End\s+(Sub|Function|Property)\b/i;

function code(lines: readonly string[], i: number): string {
  return stripComment(lines[i] ?? '');
}

/** The sub `name` as a range, or why no line can be anchored in it. */
function subRange(lines: readonly string[], name: string): SubRange | string {
  const [s, e] = findSub(lines, name);
  if (s < 0) return `no Sub ${name}`;
  const head = code(lines, s);
  const spelled = SUB_HEAD.exec(head)?.[2] ?? name;
  if (/\bEnd\s+(Sub|Function)\b/i.test(head)) return `Sub ${spelled} is written on one line`;
  if (/_\s*$/.test(head)) return `Sub ${spelled}'s parameter list continues on the next line`;
  if (e < 0) return `Sub ${spelled} has no End Sub`;
  return { name: spelled, start: s, end: e };
}

/** The sub whose body holds line `idx`, with whether it is a class member; `null` for top-level code or a one-line sub. */
function enclosingSub(lines: readonly string[], idx: number): (SubRange & { inClass: boolean }) | null {
  for (let i = idx; i >= 0; i--) {
    const c = code(lines, i);
    if (i < idx && END_PROC.test(c)) return null;
    if (/^\s*(?:Public\s+|Private\s+)?Property\s+(Get|Let|Set)\b/i.test(c)) return null;
    const m = SUB_HEAD.exec(c);
    if (!m) continue;
    if (/\bEnd\s+(Sub|Function)\b/i.test(c) || /_\s*$/.test(c)) return null;
    const end = findLine(lines, /^\s*End\s+(Sub|Function)\b/, i + 1);
    if (end < idx) return null;
    let inClass = false;
    for (let j = i - 1; j >= 0; j--) {
      const cj = code(lines, j);
      if (/^\s*End\s+Class\b/i.test(cj)) break;
      if (/^\s*Class\s+\w+/i.test(cj)) {
        inClass = true;
        break;
      }
    }
    return { name: m[2] ?? '?', start: i, end, inClass };
  }
  return null;
}

/** Columns of `Exit Sub` / `Exit Function` in the code part of `line`, outside string literals. */
function exitColumns(line: string): number[] {
  const c = stripComment(line);
  const out: number[] = [];
  let inStr = false;
  for (let i = 0; i < c.length; i++) {
    const ch = c[i];
    if (ch === '"') inStr = !inStr;
    else if (!inStr && (i === 0 || !/\w/.test(c[i - 1] ?? '')) && /^Exit\s+(Sub|Function)\b/i.test(c.slice(i))) out.push(i);
  }
  return out;
}

/**
 * The arguments of the call whose name ends at column `pos` of line `idx`: the rest of the statement (lines ending
 * in ` _` joined), cut at a `:` or `Else` outside strings and brackets, one pair of whole-list brackets removed,
 * split at top-level commas. `[]` for a call with none.
 */
export function callArgs(lines: readonly string[], idx: number, pos: number): string[] {
  let text = code(lines, idx).slice(pos);
  let j = idx;
  while (/\s_\s*$/.test(text) && j + 1 < lines.length) text = text.replace(/_\s*$/, ' ') + code(lines, ++j);
  let depth = 0;
  let inStr = false;
  let end = text.length;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') inStr = !inStr;
    if (inStr || ch === '"') continue;
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth < 0) {
        end = i;
        break;
      }
    } else if (depth === 0 && (ch === ':' || (/^Else\b/i.test(text.slice(i)) && /\W/.test(text[i - 1] ?? ' ')))) {
      end = i;
      break;
    }
  }
  let a = text.slice(0, end).trim();
  if (a.startsWith('(') && closingParen(a, 0) === a.length - 1) a = a.slice(1, -1).trim();
  if (a === '') return [];
  const parts: string[] = [];
  depth = 0;
  inStr = false;
  let from = 0;
  for (let i = 0; i < a.length; i++) {
    const ch = a[i];
    if (ch === '"') inStr = !inStr;
    else if (!inStr && ch === '(') depth++;
    else if (!inStr && ch === ')') depth--;
    else if (!inStr && depth === 0 && ch === ',') {
      parts.push(a.slice(from, i).trim());
      from = i + 1;
    }
  }
  parts.push(a.slice(from).trim());
  return parts;
}

function closingParen(s: string, open: number): number {
  let depth = 0;
  let inStr = false;
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') inStr = !inStr;
    else if (!inStr && ch === '(') depth++;
    else if (!inStr && ch === ')' && --depth === 0) return i;
  }
  return -1;
}

/** Every call site of `<obj>.<method>` in code: line index and the column just after the method name. */
function callSites(lines: readonly string[], obj: string, method: string): { idx: number; pos: number }[] {
  const rx = new RegExp(`\\b${escapeRegExp(obj)}\\.${escapeRegExp(method)}\\b`, 'gi');
  const out: { idx: number; pos: number }[] = [];
  lines.forEach((_, i) => {
    const c = code(lines, i);
    for (const m of c.matchAll(rx)) out.push({ idx: i, pos: (m.index ?? 0) + m[0].length });
  });
  return out;
}

// ------------------------------------------------------------------------------------------- the render

/** What the anchor subs pass to the library, as VBScript expressions over the table's own variables. */
interface Exprs {
  /** The table's score array (`Score`, or `Array(a, b, c, d)` from Scorbit's arguments); `null` = none found. */
  scores: string | null;
  /** Index of player 1 in `scores`. */
  base: 0 | 1;
  /** Current player, 1-based. */
  player: string;
  ball: string;
  players: string;
  extra: string;
}

interface Insert {
  idx: number;
  line: string;
  seq: number;
}

class Render {
  readonly out: string[];
  /** `out[i]`'s line ending: the table's own for its lines, the dominant newline for ours (C13). */
  readonly endings: string[];
  readonly inserts: Insert[] = [];
  readonly warnings: string[] = [];
  readonly partial: string[] = [];
  readonly anchors: Record<string, string> = {};

  constructor(
    readonly recipe: OriginalRecipe,
    readonly lines: readonly string[],
    endings: readonly string[] = [],
    readonly newline: string = '\r\n',
  ) {
    this.out = [...lines];
    this.endings = lines.map((_, i) => endings[i] ?? '');
  }

  /** Put `block` into `out` at `idx` with the dominant newline on each line. */
  splice(idx: number, block: readonly string[]): void {
    this.out.splice(idx, 0, ...block);
    this.endings.splice(idx, 0, ...block.map(() => this.newline));
  }

  call(fn: string): string {
    return `Castcade_${this.recipe}_${fn}`;
  }

  insert(idx: number, line: string): void {
    this.inserts.push({ idx, line, seq: this.inserts.length });
  }

  /** The one line put at an anchor; `pass` is ` <expr>` when the place hands our sub a value. */
  anchorLine(fn: string, what: string, pass = ''): string {
    return `    ${this.call(fn)}${pass}   ' Castcade: ${what}`;
  }

  /** A missing piece: a warning, and `partial` when a game cannot be journaled whole without it. */
  miss(text: string, partial: boolean): void {
    this.warnings.push(text);
    if (partial) this.partial.push(text);
  }

  /** The call line before `End Sub`; `beforeExits` also puts the call in front of each early `Exit Sub`. */
  atEnd(key: string, sub: SubRange, fn: string, what: string, beforeExits: boolean): void {
    this.insert(sub.end, this.anchorLine(fn, what));
    let exits = 0;
    for (let i = sub.start + 1; i < sub.end; i++) {
      const cols = exitColumns(this.out[i] ?? '');
      if (cols.length === 0) continue;
      exits += cols.length;
      if (!beforeExits) continue;
      let l = this.out[i] ?? '';
      for (const col of [...cols].reverse()) l = `${l.slice(0, col)}${this.call(fn)} : ${l.slice(col)}`;
      this.out[i] = l;
    }
    let where = `end of Sub ${sub.name} (line ${sub.end + 1})`;
    if (exits > 0 && beforeExits) where += ` and before its ${exits} early Exit Sub`;
    if (exits > 0 && !beforeExits) this.warnings.push(`Sub ${sub.name} has ${exits} early Exit Sub; no ${what} is journaled on ${exits === 1 ? 'that path' : 'those paths'}`);
    this.anchors[key] = where;
  }

  atTop(key: string, sub: SubRange, fn: string, what: string): void {
    this.insert(sub.start + 1, this.anchorLine(fn, what));
    this.anchors[key] = `top of Sub ${sub.name} (line ${sub.start + 1})`;
  }

  before(key: string, idx: number, fn: string, what: string, where: string): void {
    this.insert(idx, this.anchorLine(fn, what));
    this.anchors[key] = where;
  }

  /** The call line right after line `idx` (recipe B's game end after the game-flag clear). */
  after(key: string, idx: number, fn: string, what: string, where: string): void {
    this.insert(idx + 1, this.anchorLine(fn, what));
    this.anchors[key] = where;
  }
}

function renderOriginal(recipe: OriginalRecipe, scriptText: string, cls: ClassifyResult, opts: RenderOptions): Rendered {
  const fn = `renderRecipe${recipe}`;
  if (cls.cls !== recipe) throw new Error(`${fn}: class ${cls.cls} is not class ${recipe}`);
  if (cls.facts.alreadyPatched) throw new Error(`${fn}: script already contains Castcade_Init (already patched); refusing`);
  const f = cls.facts;
  const T = f.tableObject;
  if (!T || !f.keyDownLine) throw new Error(`${fn}: no _KeyDown handler`);

  const split = splitScript(scriptText);
  const r = new Render(recipe, split.lines, split.endings, split.newline);

  // block 0, the handler renames and the wrappers: exactly recipe A's
  const oe = f.optionExplicitLine ?? 0;
  r.anchors['block0'] = oe > 0 ? `after Option Explicit (line ${oe})` : 'top of script';
  r.anchors['guard'] = `block 0: ${Math.floor(opts.originalSize)} bytes, ${formatLocalStamp(opts.originalMtimeMs)}`;
  const names = renameHandlers(r.out, f, r.anchors);

  let tail: string[];
  if (recipe === 'B') tail = recipeB(r);
  else if (recipe === 'C') tail = recipeC(r);
  else tail = recipeD(r);

  // Bottom-up so earlier indexes stay valid; at one index the first-placed line stays first. Every anchor is in a sub,
  // so below Option Explicit: block 0 goes in last.
  for (const ins of [...r.inserts].sort((a, b) => b.idx - a.idx || b.seq - a.seq)) r.splice(ins.idx, [ins.line]);
  r.splice(oe > 0 ? oe : 0, block0(recipe, opts));
  const w = wrappers(names);
  r.splice(r.out.length, [...w, '', originalsBlockStart(recipe), ...tail, originalsBlockEnd(recipe)]);
  r.anchors['wrappers'] = `appended (${w.length} lines)`;
  r.anchors['recipe'] = `recipe ${recipe} block appended (${tail.length + 2} lines)`;

  // The sidecar ends as the script did (with or without a final newline): that is how the undo is exact.
  const bytes = encodeScript(joinScript({ lines: r.out, endings: r.endings, newline: split.newline, trailingNewline: endsWithNewline(split) }));
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex'), warnings: r.warnings, anchors: r.anchors, partial: r.partial };
}

/**
 * The `Castcade_<R>_*` subs the anchor lines call (B and C): every one, whatever was anchored. With a game start
 * anchored, a game end is journaled once per game start (`Castcade_<R>_InGame`): recipe B anchors the end after every
 * game-flag clear, and a framework's end function also runs when a game is cancelled before it began. `scoresOnly`
 * adds `Castcade_<R>_ScoresFor(a)`, the scores call for a place that passes the table's own value (C1.4).
 */
function anchorSubs(r: Render, x: Exprs, scoresOnly?: string): string[] {
  const R = r.recipe;
  const count = `Castcade_${R}_Count()`;
  const list = x.scores === null ? 'Array()' : `Castcade_PlayerScores(${x.scores}, ${x.base}, ${count})`;
  const sub = (name: string, body: string[]): string[] => [`Sub Castcade_${R}_${name}()`, '    On Error Resume Next', ...body.map((b) => `    ${b}`), 'End Sub'];
  return [
    // The player count, kept from the last time the table's own was above 0 (some tables zero it at game over).
    `Dim Castcade_${R}_Players : Castcade_${R}_Players = 1`,
    `Function Castcade_${R}_Count()`,
    '    On Error Resume Next',
    '    Dim n',
    '    n = 0',
    `    n = CLng(${x.players})`,
    `    If n > 0 Then Castcade_${R}_Players = n`,
    `    Castcade_${R}_Count = Castcade_${R}_Players`,
    'End Function',
    `Dim Castcade_${R}_InGame : Castcade_${R}_InGame = False`,
    ...sub('GameStart', [`Castcade_${R}_Players = 1`, `Castcade_${R}_InGame = True`, `Castcade_GameStart ${count}`]),
    ...sub('Scores', x.scores === null ? [] : [`Castcade_Scores ${list}, ${x.player}, ${x.ball}`]),
    ...(scoresOnly === undefined ? [] : [`Sub Castcade_${R}_ScoresFor(a)`, '    On Error Resume Next', `    If a = ${scoresOnly} Then Castcade_${R}_Scores`, 'End Sub']),
    ...sub('BallEnd', [`Castcade_BallEnd ${x.player}, ${x.ball}, ${x.extra}`]),
    ...sub('GameEnd', [...(r.anchors['gameStart'] === undefined ? [] : [`If Not Castcade_${R}_InGame Then Exit Sub`, `Castcade_${R}_InGame = False`]), `Castcade_GameEnd ${list}, ${count}`]),
  ];
}

// ------------------------------------------------------------------------------------------- recipe B

/** The variable names recipe B knows for each value, in the order tried (C1.3). */
const CURRENT_PLAYER_VARS = ['CurrentPlayer', 'CurrentPlayerIdx', 'nPlayer', 'cp', 'Player'];
const PLAYERS_VARS = ['PlayersPlayingGame', 'PlayersPlaying', 'nPlayersInGame', 'NumPlayers', 'numplay'];
const BALL_VARS = ['BallNumber', 'CurrentBall', 'nBall', 'BallInPlay'];
const EXTRA_BALL_VARS = ['ExtraBallPending', 'nExtraBalls', 'ExtraBalls'];

/** How the script uses a name: declared at module level, declared inside a procedure (a local), assigned as a statement. */
interface IdentUse {
  declaredTop: boolean;
  declaredLocal: boolean;
  assigned: boolean;
  assignedInProc: boolean;
}

function identUse(lines: readonly string[], ctx: readonly LineContext[], name: string): IdentUse {
  const N = escapeRegExp(name);
  const word = new RegExp(`\\b${N}\\b`, 'i');
  const assign = new RegExp(`(?:^|:|\\bThen\\b|\\bElse\\b)\\s*${N}\\s*(?:\\([^)]*\\))?\\s*=`, 'i');
  const u: IdentUse = { declaredTop: false, declaredLocal: false, assigned: false, assignedInProc: false };
  for (let i = 0; i < lines.length; i++) {
    const c = code(lines, i);
    const top = (ctx[i]?.proc ?? -1) < 0 && !ctx[i]?.inClass;
    const d = /^\s*(?:Dim|Public|Private|Const)\s+([^:]*)/i.exec(c);
    if (d && word.test(d[1] ?? '')) {
      if (top) u.declaredTop = true;
      else u.declaredLocal = true;
    }
    if (assign.test(c)) {
      u.assigned = true;
      if (!top) u.assignedInProc = true;
    }
  }
  return u;
}

/**
 * The first of `names` the table really uses, so a stray word is never taken: a name assigned inside a procedure (a
 * value that moves during play) wins over one only set at module level (Star Wars (Burger 2025) declares
 * `PlayersPlayingGame = 1` once and counts in `numplay`); a name that is only a procedure's local (`Dim extraBalls`
 * inside a sub) is never used, as our anchor subs could not see it. `needAssigned` also refuses a bare declaration.
 */
function pickVar(lines: readonly string[], ctx: readonly LineContext[], names: readonly string[], needAssigned = false): string | null {
  const uses = names.map((n) => ({ n, u: identUse(lines, ctx, n) }));
  const ok = ({ u }: { u: IdentUse }): boolean => (u.declaredTop || u.assigned) && !(u.declaredLocal && !u.declaredTop) && (!needAssigned || u.assigned);
  return uses.find((x) => ok(x) && x.u.assignedInProc)?.n ?? uses.find(ok)?.n ?? null;
}

/** Where the table keeps the score: an array indexed by the player, one scalar, or a family of per-player scalars. */
type ScoreStore = { kind: 'array'; name: string; index: string } | { kind: 'scalar'; name: string } | { kind: 'numbered'; names: string[] };

interface Accumulation {
  store: ScoreStore & { kind: 'array' | 'scalar' };
  /** 0-based line of the statement. */
  idx: number;
  text: string;
}

/** `X = X + ...` or `X(I) = X(I) + ...` as a statement (the whitespace may vary). */
const ACCUMULATE = /(?:^|:|\bThen\b|\bElse\b)\s*(\w+)\s*(?:\(\s*([^()]*?)\s*\))?\s*=\s*(\w+)\s*(?:\(\s*([^()]*?)\s*\))?\s*\+/i;

/** Every accumulation in the body of `s`, in order. */
function accumulations(lines: readonly string[], s: SubRange): Accumulation[] {
  const out: Accumulation[] = [];
  const norm = (e: string | undefined): string => (e ?? '').replace(/\s+/g, '').toLowerCase();
  for (let i = s.start + 1; i < s.end; i++) {
    const c = code(lines, i);
    const m = ACCUMULATE.exec(c);
    if (!m || (m[1] ?? '').toLowerCase() !== (m[3] ?? '').toLowerCase() || norm(m[2]) !== norm(m[4])) continue;
    if ((m[2] === undefined) !== (m[4] === undefined)) continue;
    const name = m[1] ?? '';
    const text = c.trim().replace(/\s*:.*$/, '');
    out.push({ store: m[2] === undefined ? { kind: 'scalar', name } : { kind: 'array', name, index: (m[2] ?? '').trim() }, idx: i, text });
  }
  return out;
}

/** The family `p1score, p2score, ...` when `name` is its first member and the others accumulate in the same sub. */
function numberedFamily(name: string, all: readonly Accumulation[]): string[] | null {
  const m = /^([A-Za-z_]*?)1([A-Za-z_]\w*)?$/.exec(name);
  if (!m) return null;
  const names = [name];
  for (let n = 2; n <= 8; n++) {
    const sib = `${m[1] ?? ''}${n}${m[2] ?? ''}`;
    if (!all.some((a) => a.store.kind === 'scalar' && a.store.name.toLowerCase() === sib.toLowerCase())) break;
    names.push(sib);
  }
  return names.length >= 2 ? names : null;
}

interface ScoreStoreFound {
  store: ScoreStore;
  /** The statement it was read from and where; absent for the `Dim Score(` fallback. */
  at?: { sub: string; line: number; text: string };
}

/**
 * The score store, from `AddScore`'s body: the first accumulation whose name says `score`, else the first; with none
 * there, the same one call level down (the first helper `AddScore` calls as a statement that accumulates: the Burger
 * template's `AddScore` calls `SetScore`); else today's `Dim Score(` array with `CurrentPlayer`.
 */
function findScoreStore(lines: readonly string[], add: SubRange | null): ScoreStoreFound | null {
  const best = (s: SubRange): ScoreStoreFound | null => {
    const all = accumulations(lines, s);
    // `Score` itself first (JP's Foo Fighters adds into `CurrentCityScore(CurrentPlayer, ModeActive)` before
    // `Score(CurrentPlayer)`), then a `...score...` with a plain index or none, then any `...score...`, then the first.
    const plain = (x: Accumulation): boolean => x.store.kind === 'scalar' || /^\w+$/.test(x.store.index);
    const a =
      all.find((x) => /^score$/i.test(x.store.name) && plain(x)) ??
      all.find((x) => /score/i.test(x.store.name) && plain(x)) ??
      all.find((x) => /score/i.test(x.store.name)) ??
      all[0];
    if (!a) return null;
    const at = { sub: s.name, line: a.idx + 1, text: a.text };
    if (a.store.kind === 'scalar') {
      const family = numberedFamily(a.store.name, all);
      if (family) return { store: { kind: 'numbered', names: family }, at };
    }
    return { store: a.store, at };
  };
  if (add) {
    const own = best(add);
    if (own) return own;
    for (let i = add.start + 1; i < add.end; i++) {
      const callee = /^\s*(?:Call\s+)?(\w+)\b/i.exec(code(lines, i))?.[1];
      if (!callee || callee.toLowerCase() === add.name.toLowerCase()) continue;
      const s = subRange(lines, callee);
      if (typeof s === 'string') continue;
      const down = best(s);
      if (down) return down;
    }
  }
  if (findLine(lines, /^\s*(Dim|Public|Private)\s+(\w+(\(\s*\d*\s*\))?\s*,\s*)*Score\s*\(/) >= 0) return { store: { kind: 'array', name: 'Score', index: 'CurrentPlayer' } };
  return null;
}

/** The statements of a line's code part: split at `:` outside string literals. */
function lineStatements(codePart: string): string[] {
  const out: string[] = [];
  let inStr = false;
  let from = 0;
  for (let i = 0; i < codePart.length; i++) {
    const ch = codePart[i];
    if (ch === '"') inStr = !inStr;
    else if (ch === ':' && !inStr) {
      out.push(codePart.slice(from, i));
      from = i + 1;
    }
  }
  out.push(codePart.slice(from));
  return out.map((s) => s.trim()).filter((s) => s !== '');
}

interface ScoreClear {
  /** 0-based line the game-end call goes in front of: the clear's own line, or the outermost loop that holds it. */
  idx: number;
  /** 0-based line of the clear and the statement as written. */
  at: number;
  text: string;
  /** Early `Exit Sub` in front of `idx`: paths that leave before the game end is journaled. */
  exitsBefore: number;
}

/**
 * The first statement in the end sub that sets the score store to 0 (B 0.3.1). The Matrix (Original) 0.99.0 clears
 * `Score(i)` for every player in a loop near the end of `EndOfGame`, so a game end journaled at the end of the sub
 * carried `[0]` (live validation, 2026-11-12: three ball ends, final score 0, last live score 1461760). The call goes
 * in front of the clear, outside any `For` / `Do` / `While` that holds it. `null` when the sub has no such statement,
 * or the line cannot take a statement in front of it (it follows a line continuation).
 */
function scoreClearIn(lines: readonly string[], s: SubRange, store: ScoreStore): ScoreClear | null {
  const names = store.kind === 'numbered' ? store.names : [store.name];
  const target = store.kind === 'array' ? '\\s*\\([^()]*\\)' : '';
  const rx = new RegExp(`^(?:(?:Else)?If\\b.*\\bThen\\s+|Else\\s+)?(?:${names.map(escapeRegExp).join('|')})${target}\\s*=\\s*0$`, 'i');
  const loops: number[] = [];
  for (let i = s.start + 1; i < s.end; i++) {
    for (const st of lineStatements(code(lines, i))) {
      if (/^(For|Do|While)\b/i.test(st)) loops.push(i);
      else if (/^(Next|Loop|Wend)\b/i.test(st)) loops.pop();
      else if (rx.test(st)) {
        // a loop opened on this same line is closed on it too (`For i = 0 To 3 : Score(i) = 0 : Next`)
        const idx = loops.find((l) => l < i) ?? i;
        // not after a line continuation, and not in front of a `Case` line (the call would join the Case above it,
        // or sit between `Select Case` and its first `Case`, which does not compile)
        if (/(?:^|\s)_\s*$/.test(code(lines, idx - 1)) || /^\s*Case\b/i.test(code(lines, idx))) return null;
        let exitsBefore = 0;
        for (let j = s.start + 1; j < idx; j++) exitsBefore += exitColumns(lines[j] ?? '').length;
        return { idx, at: i, text: st.replace(/^.*\bThen\s+|^Else\s+/i, ''), exitsBefore };
      }
    }
  }
  return null;
}

/** `If <game flag> [= True] Then Exit Sub` as a whole line: an end sub's guard against running once a new game began. */
const REENTRY_GUARD = /^\s*If\s+\(?\s*(gameon|GameActive|bGameInPlay|GameInProgress|GameStarted)\s*(?:=\s*(?:True|1)\s*)?\)?\s*Then\s+Exit\s+Sub\s*$/i;

/**
 * The re-entry guard of an end sub (B 0.3.2): the flag it tests, its 1-based line, how many early `Exit Sub` the sub
 * has, and whether the guard is the only one. `null` when the sub has no such line.
 */
function reentryGuard(lines: readonly string[], s: SubRange): { flag: string; line: number; exits: number; only: boolean } | null {
  let flag: string | null = null;
  let line = 0;
  let exits = 0;
  for (let i = s.start + 1; i < s.end; i++) {
    exits += exitColumns(lines[i] ?? '').length;
    if (flag !== null) continue;
    const m: RegExpExecArray | null = REENTRY_GUARD.exec(code(lines, i));
    if (m?.[1]) {
      flag = m[1];
      line = i + 1;
    }
  }
  return flag === null ? null : { flag, line, exits, only: exits === 1 };
}

/** `<v> = 0` or `= 1` as a statement: in the start sub first, else anywhere. */
function playerBase(lines: readonly string[], start: SubRange | null, v: string): 0 | 1 | null {
  const rx = new RegExp(`(?:^|:|\\bThen\\b)\\s*${escapeRegExp(v)}\\s*=\\s*([01])\\s*(?::|$)`, 'i');
  const scan = (from: number, to: number): 0 | 1 | null => {
    for (let i = from; i < to; i++) {
      const m = rx.exec(code(lines, i));
      if (m) return m[1] === '0' ? 0 : 1;
    }
    return null;
  };
  return (start ? scan(start.start + 1, start.end) : null) ?? scan(0, lines.length);
}

/**
 * The table's ball number: its `Balls` function or module-level variable, else the first ball variable it uses, else
 * computed from `BallsPerGame` / `BallsRemaining` (indexed by the table's own player index when it is an array).
 */
function ballExpr(lines: readonly string[], ctx: readonly LineContext[], index: string | null): string | null {
  if (findSub(lines, 'Balls')[0] >= 0) return 'Balls';
  const dim = /^\s*(Dim|Public|Private)\s+(\w+(\(\s*\d*\s*\))?\s*,\s*)*Balls\s*(,|:|$)/i;
  for (let i = 0; i < lines.length; i++) if ((ctx[i]?.proc ?? -1) < 0 && !ctx[i]?.inClass && dim.test(code(lines, i))) return 'Balls';
  const v = pickVar(lines, ctx, BALL_VARS);
  if (v) return v;
  if (hasIdent(lines, 'BallsPerGame') && hasIdent(lines, 'BallsRemaining')) {
    return findLine(lines, /\bBallsRemaining\s*\(/) >= 0 ? `BallsPerGame - BallsRemaining(${index ?? 'CurrentPlayer'}) + 1` : 'BallsPerGame - BallsRemaining + 1';
  }
  return null;
}

function recipeB(r: Render): string[] {
  const L = r.lines;
  const ctx = lineContexts(L);
  const found = (names: readonly string[]): [FoundSub | null, SubRange | string] => {
    const f = findFirstSub(L, names);
    return [f, f ? subRange(L, f.name) : `no Sub ${names.join(' / ')}`];
  };
  const ok = (s: SubRange | string): SubRange | null => (typeof s === 'string' ? null : s);
  const [addF, add] = found(['AddScore']);
  const [startF, start] = found(START_SUBS);
  const [endF, end] = found(END_SUBS);
  const [eobF, eob] = found(BALL_END_SUBS);
  const flags = endF ? [] : findGameFlagClears(L, ctx, startF);
  // C1.4: what an override names is taken from it; the vocabulary's warning about that value is then not raised.
  const ov: AnchorOverride | null = findOverride(L);
  const oe = ov?.exprs ?? {};
  const warn = (overridden: boolean, text: string): void => {
    if (!overridden) r.warnings.push(text);
  };
  if (ov) r.anchors['override'] = `${ov.id}: ${ov.title}`;

  // The score store, and from it the player: an array's index is the player as the table counts it.
  const store = oe.scores === undefined ? findScoreStore(L, ok(add)) : null;
  let index: string | null = null;
  let player = '1';
  let base: 0 | 1 = 0;
  if (store?.store.kind === 'array') {
    const { name, index: ix } = store.store;
    index = ix;
    if (/^\w+$/.test(ix)) {
      const b = playerBase(L, ok(start), ix);
      if (b === null) r.warnings.push(`no "${ix} = 0" or "= 1" found; player 1 is taken as ${name}(1)`);
      base = b ?? 1;
      player = base === 1 ? ix : `${ix} + 1`;
    } else {
      base = 1;
      player = `(${ix})`;
      r.warnings.push(`the score index "${ix}" is not a variable; player 1 is taken as ${name}(1)`);
    }
  } else {
    const p = pickVar(L, ctx, CURRENT_PLAYER_VARS, true);
    if (p) {
      index = p;
      const b = playerBase(L, ok(start), p);
      if (b === null) warn(oe.player !== undefined, `no "${p} = 0" or "= 1" found; ${p} is taken as 1-based`);
      player = b === 0 ? `${p} + 1` : p;
    } else warn(oe.player !== undefined, `no current-player variable (${CURRENT_PLAYER_VARS.join(', ')}); every event names player 1`);
    if (store?.store.kind === 'scalar') r.warnings.push('scalar score: in a multi-player game only the player up is journaled');
  }
  const playersVar = oe.players === undefined ? pickVar(L, ctx, PLAYERS_VARS) : null;
  warn(oe.players !== undefined || playersVar !== null, `no players-in-game variable (${PLAYERS_VARS.join(', ')}); games are journaled as 1 player`);
  // The Burger template (2001, Star Wars) keeps `numplay` one above the player count: it starts at 2, the game starts
  // only when `numplay > 1`, and `If cp = numplay` is the end of a round (verified on the owner's three, 2026-11-06).
  const players = oe.players ?? (playersVar?.toLowerCase() === 'numplay' ? `${playersVar} - 1` : playersVar);
  const ball = oe.ball ?? ballExpr(L, ctx, index);
  if (ball === null) r.warnings.push(`no ball number (Balls, ${BALL_VARS.join(', ')}, BallsPerGame / BallsRemaining); ball fields are 0`);
  const extra = oe.extra ?? (hasIdent(L, 'ExtraBallsAwards') ? `ExtraBallsAwards(${index ?? 'CurrentPlayer'})` : (pickVar(L, ctx, EXTRA_BALL_VARS) ?? '0'));
  const s = store?.store ?? null;
  const scores = oe.scores ?? (s === null ? null : s.kind === 'array' ? s.name : s.kind === 'scalar' ? `Array(${s.name})` : `Array(${s.names.join(', ')})`);
  if (oe.scores !== undefined) base = oe.base ?? 0;
  const x: Exprs = { scores, base, player: oe.player ?? player, ball: ball ?? '0', players: players ?? '1', extra };
  r.anchors['vars'] = `${scores ?? 'no scores'} base ${base}, player ${x.player}, ball ${x.ball}, players ${x.players}, extra balls ${x.extra}`;
  if (store?.at) r.anchors['scoreStore'] = `${store.at.text} (Sub ${store.at.sub}, line ${store.at.line})`;
  const named = (f: FoundSub | null): string => (f ? `${f.name} (line ${f.line})` : 'none');
  const flag = flags[0];
  const endNamed = endF ? named(endF) : flag ? `"${flag.text}" in Sub ${flag.sub} (line ${flag.line})${flags.length > 1 ? ` and ${flags.length - 1} more` : ''}` : 'none';
  r.anchors['subs'] = `AddScore ${named(addF)}, start ${named(startF)}, end ${endNamed}, ball end ${named(eobF)}`;

  // An override's places for a role, when it names any: true = the role is settled here (anchored, or reported).
  const placed = (role: AnchorRole, fnName: string, what: string, partial: boolean): boolean => {
    const places = ov?.anchors?.[role];
    if (!ov || !places || places.length === 0) return false;
    const where: string[] = [];
    const why: string[] = [];
    for (const p of places) {
      const res = resolvePlace(L, ctx, p);
      if (typeof res === 'string') {
        why.push(res);
        continue;
      }
      const fn = p.pass ? `${fnName}For` : fnName;
      for (const at of res) {
        r.insert(at.idx, r.anchorLine(fn, what, passSuffix(p)));
        where.push(at.where);
      }
    }
    if (where.length > 0) {
      r.anchors[role] = `${where.join('; ')} (override ${ov.id})`;
      for (const w of why) r.warnings.push(`override ${ov.id}: ${w}; no ${what} is journaled there`);
    } else r.miss(`override ${ov.id}: ${why.join('; ')}; no ${what} is journaled`, partial);
    return true;
  };

  if (scores === null) r.miss(`no score store (no "X = X + ..." in Sub ${addF?.name ?? 'AddScore'} or a sub it calls, no Dim Score( array); scores are not journaled`, true);
  else if (placed('scores', 'Scores', 'current scores', false)) {
    // settled by the override
  } else if (typeof add === 'string') r.miss(`${add}; live scores are not journaled (the game end carries the final scores)`, false);
  else r.atEnd('scores', add, 'Scores', 'current scores', true);
  if (placed('gameStart', 'GameStart', 'game start', true)) {
    // settled by the override
  } else if (typeof start !== 'string') r.atEnd('gameStart', start, 'GameStart', 'game start', false);
  else r.miss(`${start}; no game start is journaled`, true);
  if (placed('gameEnd', 'GameEnd', 'game end', true)) {
    // settled by the override
  } else if (typeof end !== 'string') {
    // B 0.3.1: an end sub that clears the score store journals the game end in front of the clear, not at its end.
    const clear = s === null ? null : scoreClearIn(L, end, s);
    if (clear) {
      r.before('gameEnd', clear.idx, 'GameEnd', 'game end', `before "${clear.text}" in Sub ${end.name} (line ${clear.at + 1}), where the table clears its scores`);
      if (clear.exitsBefore > 0) r.warnings.push(`Sub ${end.name} has ${clear.exitsBefore} early Exit Sub; no game end is journaled on ${clear.exitsBefore === 1 ? 'that path' : 'those paths'}`);
    } else r.atEnd('gameEnd', end, 'GameEnd', 'game end', false);
    // B 0.3.2: an end sub that leaves early while the game flag is SET was called late (Game of Thrones: 5 s after the
    // game over, behind the match sequence; a Start in between begins the next game and the end sub then does nothing).
    // The game is over where the flag was cleared before that call: the game end is anchored there too. Whichever
    // comes first journals it; `Castcade_B_GameEnd` says it once per game start.
    const guard = reentryGuard(L, end);
    const early = guard === null ? [] : findGameFlagClears(L, ctx, startF).filter((c) => (c.line - 1 < end.start || c.line - 1 > end.end) && c.text.toLowerCase().startsWith(guard.flag.toLowerCase()));
    if (guard !== null && early.length > 0) {
      for (const c of early) r.insert(c.line, r.anchorLine('GameEnd', 'game end'));
      const where = early.map((c) => `after "${c.text}" in Sub ${c.sub} (line ${c.line})`).join('; ');
      r.anchors['gameEnd'] = `${r.anchors['gameEnd']}; ${where}`;
      // the guard's exit is now a path whose game end was journaled where the flag was cleared
      const stale = new RegExp(`^Sub ${escapeRegExp(end.name)} has ${guard.exits} early Exit Sub; no game end is journaled on `);
      const at = guard.only ? r.warnings.findIndex((w) => stale.test(w)) : -1;
      if (at >= 0) r.warnings.splice(at, 1);
      r.warnings.push(`Sub ${end.name} leaves early while ${guard.flag} is set (line ${guard.line}): it runs after the game is over; the game end is also anchored ${where}`);
    }
  } else if (flag) {
    // After every clear of the game flag (0.3.0): a game can end on more than one path (Rattlecan: a normal drain and
    // a drain after a tilt). `Castcade_B_GameEnd` journals one game end per game start, so a clear outside a game is quiet.
    const where = flags.map((c) => `after "${c.text}" in Sub ${c.sub} (line ${c.line})`);
    for (const c of flags) r.insert(c.line, r.anchorLine('GameEnd', 'game end'));
    r.anchors['gameEnd'] = where.join('; ');
    const more = flags.length > 1 ? `, and after ${flags.length - 1} more such statement${flags.length > 2 ? 's' : ''} (${flags.slice(1).map((c) => `Sub ${c.sub} line ${c.line}`).join(', ')})` : '';
    r.warnings.push(`${end}; the game end is anchored after "${flag.text}" in Sub ${flag.sub} (line ${flag.line}), the first place the game flag is cleared${more}`);
  } else r.miss(`${end}${endF ? '' : ' and no game-flag clear (gameon = 0, GameActive = False, GameOver = 1, ...)'}; no game end is journaled`, true);
  if (placed('ballEnd', 'BallEnd', 'ball end', false)) {
    // settled by the override
  } else if (typeof eob !== 'string') r.atTop('ballEnd', eob, 'BallEnd', 'ball end');
  else {
    const dec = findLine(L, /^\s*BallsRemaining\s*(\([^)]*\))?\s*=\s*BallsRemaining\s*(\([^)]*\))?\s*-/);
    if (dec >= 0) r.before('ballEnd', dec, 'BallEnd', 'ball end', `before the BallsRemaining decrement (line ${dec + 1})`);
    else r.miss(`${eob}${eobF ? '' : ' and no BallsRemaining decrement'}; no ball end is journaled`, false);
  }
  for (const n of ov?.notes ?? []) r.warnings.push(n);
  return anchorSubs(r, x, ov?.scoresOnly !== undefined && (ov.anchors?.scores ?? []).some((p) => p.pass) ? ov.scoresOnly : undefined);
}

const EVENT_HANDLER = /_(KeyDown|KeyUp|Timer|Hit|UnHit|Exit|Init|Spin|Slingshot|Dropped|Raised|Collide|Animate|Paused|UnPaused|MusicDone|OptionEvent)$/i;

/** The sub a Scorbit call site's line goes in: its own sub, or the caller of a Scorbit-named helper. */
function scorbitAnchorSub(lines: readonly string[], idx: number, depth = 0): { sub: SubRange; via?: string } | string {
  const s = enclosingSub(lines, idx);
  if (!s) return `the call on line ${idx + 1} is not inside a multi-line Sub`;
  if (s.inClass) return `the call on line ${idx + 1} is inside a Class (${s.name})`;
  if (EVENT_HANDLER.test(s.name)) return `the call on line ${idx + 1} is in the event handler ${s.name}`;
  if (/scorbit/i.test(s.name)) {
    if (depth > 0) return `the call on line ${idx + 1} is in Scorbit's ${s.name}`;
    const rx = new RegExp(`\\b${escapeRegExp(s.name)}\\b`, 'i');
    for (let i = 0; i < lines.length; i++) {
      if (i >= s.start && i <= s.end) continue;
      if (!rx.test(code(lines, i))) continue;
      const up = scorbitAnchorSub(lines, i, 1);
      if (typeof up !== 'string') return { sub: up.sub, via: s.name };
    }
    return `the call on line ${idx + 1} is in Scorbit's ${s.name}, and no caller of it outside a Scorbit sub was found`;
  }
  return { sub: s };
}

function recipeC(r: Render): string[] {
  const L = r.lines;
  // What Scorbit is told: SendUpdate P1, P2, P3, P4, CurrentBall, CurrentPlayer (1-based), NumberPlayers.
  let args: string[] | null = null;
  for (const site of callSites(L, 'Scorbit', 'SendUpdate')) {
    const a = callArgs(L, site.idx, site.pos);
    if (a.length === 7 && a.every((s) => s !== '')) {
      args = a;
      r.anchors['vars'] = `Scorbit.SendUpdate arguments (line ${site.idx + 1})`;
      break;
    }
  }
  if (!args) r.miss('no Scorbit.SendUpdate call with its 7 arguments; scores are not journaled', true);
  const [p1, p2, p3, p4, ball, player, players] = args ?? ['0', '0', '0', '0', '0', '1', '1'];
  const x: Exprs = { scores: args ? `Array(${p1}, ${p2}, ${p3}, ${p4})` : null, base: 0, player: player ?? '1', ball: ball ?? '0', players: players ?? '1', extra: '0' };

  const place = (key: string, method: string, fnName: string, what: string, partial: boolean): void => {
    const why: string[] = [];
    for (const site of callSites(L, 'Scorbit', method)) {
      const a = scorbitAnchorSub(L, site.idx);
      if (typeof a === 'string') {
        why.push(a);
        continue;
      }
      r.atEnd(key, a.sub, fnName, what, false);
      if (a.via) r.anchors[key] = `${r.anchors[key]} (the caller of ${a.via}, which calls Scorbit.${method})`;
      return;
    }
    r.miss(`no anchor for Scorbit.${method} (${why.length > 0 ? why.join('; ') : 'no call'}); no ${what} is journaled`, partial);
  };
  place('gameStart', 'StartSession', 'GameStart', 'game start', true);
  place('gameEnd', 'StopSession', 'GameEnd', 'game end', true);

  const add = subRange(L, 'AddScore');
  if (typeof add !== 'string' && args) r.atEnd('scores', add, 'Scores', 'current scores', true);
  else if (args) r.warnings.push(`${typeof add === 'string' ? add : ''}; live scores are not journaled (the game end carries the final scores)`);
  let eob: SubRange | string = 'no EndOfBall / EndBall / BallDrained sub';
  for (const name of ['EndOfBall', 'EndBall', 'BallDrained']) {
    const s = subRange(L, name);
    if (typeof s !== 'string') {
      eob = s;
      break;
    }
  }
  if (typeof eob !== 'string') r.atTop('ballEnd', eob, 'BallEnd', 'ball end');
  else r.miss(`${eob}; no ball end is journaled`, false);
  return anchorSubs(r, x);
}

/** The ScoreServer methods the library's shim has, with their argument counts (superhac's API, LU's build). */
export const SCORE_SERVER_METHODS: Readonly<Record<string, number>> = {
  setgamename: 1,
  setgamestate: 4,
  setscoresarray: 2,
  sethighscoresarray: 3,
  awardbadge: 3,
  clearstate: 0,
};

function recipeD(r: Render): string[] {
  const L = r.lines;
  const exact: number[] = [];
  const other: number[] = [];
  const anyCreate = /CreateObject\s*\(\s*"VPinball\.ScoreServer"\s*\)/i;
  L.forEach((_, i) => {
    const c = code(L, i);
    if (c.includes(SCORE_SERVER_CREATE)) exact.push(i);
    else if (anyCreate.test(c)) other.push(i);
  });
  for (const i of other) r.warnings.push(`line ${i + 1} creates the ScoreServer in another spelling; left as it is`);
  // The variables the table keeps the object in, and every method it calls on them.
  const vars = new Set<string>();
  for (const i of [...exact, ...other]) for (const m of code(L, i).matchAll(/\bSet\s+(\w+)\s*=\s*CreateObject\s*\(\s*"VPinball\.ScoreServer"/gi)) if (m[1]) vars.add(m[1]);
  const refuse: string[] = [];
  let scoresCalled = false;
  for (const v of vars) {
    const rx = new RegExp(`\\b${escapeRegExp(v)}\\.(\\w+)`, 'gi');
    L.forEach((_, i) => {
      for (const m of code(L, i).matchAll(rx)) {
        const method = (m[1] ?? '').toLowerCase();
        const want = SCORE_SERVER_METHODS[method];
        if (want === undefined) {
          refuse.push(`${v}.${m[1]} (line ${i + 1}) is not a ScoreServer method the shim has`);
          continue;
        }
        if (method === 'setscoresarray') scoresCalled = true;
        const got = callArgs(L, i, (m.index ?? 0) + m[0].length).length;
        if (got !== want) refuse.push(`${v}.${m[1]} (line ${i + 1}) passes ${got} argument${got === 1 ? '' : 's'}, the API takes ${want}`);
      }
    });
  }
  if (exact.length === 0) {
    r.miss(`no ${SCORE_SERVER_CREATE} to redirect; nothing the table reports is journaled`, true);
  } else if (refuse.length > 0) {
    r.miss(`ScoreServer left unredirected, the shim could stop the table: ${refuse.join('; ')}`, true);
  } else {
    for (const i of exact) r.out[i] = (r.out[i] ?? '').split(SCORE_SERVER_CREATE).join(SCORE_SERVER_SHIM_CALL);
    r.anchors['scoreServer'] = `${SCORE_SERVER_CREATE} redirected to the library's shim (line${exact.length === 1 ? '' : 's'} ${exact.map((i) => i + 1).join(', ')})`;
    if (vars.size === 0) r.warnings.push('the ScoreServer object is not kept in a Set variable; its method calls were not checked');
    if (!scoresCalled && vars.size > 0) r.miss('the table never calls SetScoresArray; no scores are journaled', true);
    r.warnings.push('ScoreServer has no ball-end call; no ball end is journaled (game start / scores / game end come from SetGameState and SetScoresArray)');
  }
  return [
    // Hands the table the library's shim; with no library, the real object, or the error CreateObject would have raised.
    'Function Castcade_D_ScoreServer()',
    '    Dim o',
    '    On Error Resume Next',
    '    Set o = Nothing',
    '    Set o = Castcade_ScoreServer()',
    `    If o Is Nothing Then Set o = ${SCORE_SERVER_CREATE}`,
    '    If o Is Nothing Then',
    '        On Error Goto 0',
    '        Err.Raise 429, "Castcade", "ActiveX component can\'t create object: VPinball.ScoreServer"',
    '    End If',
    '    Set Castcade_D_ScoreServer = o',
    'End Function',
  ];
}
