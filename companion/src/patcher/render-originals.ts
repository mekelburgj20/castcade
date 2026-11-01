/**
 * Recipes B, C and D (WORK C1.1, `docs/design/table-import-and-patching.md` §5): sidecars for ORIGINAL tables, the
 * ones with no ROM, whose score lives in the table's own variables. An original leaves no NVRAM, so the journal
 * events come from the table's script: block 0 and the key wrappers as recipe A renders them, plus one call line at
 * each anchor sub and a block of `Castcade_<recipe>_*` subs after the wrappers that read the table's variables and
 * call the library (`Castcade_GameStart` / `Castcade_Scores` / `Castcade_BallEnd` / `Castcade_GameEnd`, lib 0.5.0).
 *
 * - **B** (JPSalas pattern): `Castcade_<R>_GameStart` at the end of `ResetForNewGame`, `_Scores` at the end of
 *   `AddScore` and in front of each of its early `Exit Sub`, `_BallEnd` at the TOP of `EndOfBall` (the ball that
 *   just drained, before anything advances; `EndOfBall` often hands over to a timer) or else in front of the
 *   `BallsRemaining` decrement, `_GameEnd` at the end of `EndOfGame`. Scores come from `Score()`, 0- or 1-based as
 *   the table counts `CurrentPlayer`; the ball from the table's `Balls` (the JPSalas ball-number function).
 * - **C** (Scorbit-anchored): the expressions the table passes to `Scorbit.SendUpdate` (4 scores, ball, player,
 *   players) are what the anchors journal; `Scorbit.StartSession` / `StopSession` place the game start and end at
 *   the end of the sub that calls them. Those calls sit behind the table's Scorbit guards, so a call inside a
 *   Scorbit-named helper is followed one level up to its caller, and the line goes at the end of that sub, outside
 *   the guard. Live scores ride `AddScore` when the table has one.
 * - **D** (ScoreServer-integrated): every `CreateObject("VPinball.ScoreServer")` becomes `Castcade_D_ScoreServer()`,
 *   which hands the table the library's shim (journals, forwards to the real object when there is one). Refused,
 *   with the reason, when the table calls a method the shim does not have or with another argument count.
 *
 * Early `Exit Sub`: only the scores call is put in front of one (it repeats harmlessly); a game start or end on an
 * early-exit path is not journaled, and the warning says so instead of inventing control flow. Everything injected
 * runs under `On Error Resume Next` in our own subs, so a missing variable silences one event and never stops the
 * table. Pure: text in, bytes out; `unpatchSidecar` (render.ts) undoes it exactly.
 */
import { createHash } from 'node:crypto';
import type { ClassifyResult, ScriptClass } from './classify.js';
import {
  SCORE_SERVER_CREATE,
  SCORE_SERVER_SHIM_CALL,
  block0,
  formatLocalStamp,
  originalsBlockEnd,
  originalsBlockStart,
  renameHandler,
  renderRecipeA,
  wrappers,
  type Recipe,
  type RenderOptions,
  type Rendered,
} from './render.js';
import { encodeScript, escapeRegExp, findLine, findSub, hasIdent, joinScript, splitScript, stripComment } from './script-text.js';

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
  readonly inserts: Insert[] = [];
  readonly warnings: string[] = [];
  readonly partial: string[] = [];
  readonly anchors: Record<string, string> = {};

  constructor(
    readonly recipe: OriginalRecipe,
    readonly lines: readonly string[],
  ) {
    this.out = [...lines];
  }

  call(fn: string): string {
    return `Castcade_${this.recipe}_${fn}`;
  }

  insert(idx: number, line: string): void {
    this.inserts.push({ idx, line, seq: this.inserts.length });
  }

  private anchorLine(fn: string, what: string): string {
    return `    ${this.call(fn)}   ' Castcade: ${what}`;
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
}

function renderOriginal(recipe: OriginalRecipe, scriptText: string, cls: ClassifyResult, opts: RenderOptions): Rendered {
  const fn = `renderRecipe${recipe}`;
  if (cls.cls !== recipe) throw new Error(`${fn}: class ${cls.cls} is not class ${recipe}`);
  if (cls.facts.alreadyPatched) throw new Error(`${fn}: script already contains Castcade_Init (already patched); refusing`);
  const f = cls.facts;
  const T = f.tableObject;
  if (!T || !f.keyDownLine) throw new Error(`${fn}: no _KeyDown handler`);

  const split = splitScript(scriptText);
  const r = new Render(recipe, split.lines);

  // block 0, the handler renames and the wrappers: exactly recipe A's
  const oe = f.optionExplicitLine ?? 0;
  r.anchors['block0'] = oe > 0 ? `after Option Explicit (line ${oe})` : 'top of script';
  r.anchors['guard'] = `block 0: ${Math.floor(opts.originalSize)} bytes, ${formatLocalStamp(opts.originalMtimeMs)}`;
  renameHandler(r.out, T, 'KeyDown', f.keyDownLine - 1);
  r.anchors['keyDown'] = `Sub ${T}_KeyDown renamed Castcade_Orig_KeyDown (line ${f.keyDownLine})`;
  if (f.keyUpLine) {
    renameHandler(r.out, T, 'KeyUp', f.keyUpLine - 1);
    r.anchors['keyUp'] = `Sub ${T}_KeyUp renamed Castcade_Orig_KeyUp (line ${f.keyUpLine})`;
  }
  if (f.exitLine) {
    renameHandler(r.out, T, 'Exit', f.exitLine - 1);
    r.anchors['exit'] = `Sub ${T}_Exit renamed Castcade_Orig_Exit (line ${f.exitLine})`;
  }

  let tail: string[];
  if (recipe === 'B') tail = recipeB(r);
  else if (recipe === 'C') tail = recipeC(r);
  else tail = recipeD(r);

  // Bottom-up so earlier indexes stay valid; at one index the first-placed line stays first. Every anchor is in a sub,
  // so below Option Explicit: block 0 goes in last.
  for (const ins of [...r.inserts].sort((a, b) => b.idx - a.idx || b.seq - a.seq)) r.out.splice(ins.idx, 0, ins.line);
  r.out.splice(oe > 0 ? oe : 0, 0, ...block0(recipe, opts));
  const w = wrappers(T, Boolean(f.keyUpLine), Boolean(f.exitLine));
  r.out.push(...w, '', originalsBlockStart(recipe), ...tail, originalsBlockEnd(recipe));
  r.anchors['wrappers'] = `appended (${w.length} lines)`;
  r.anchors['recipe'] = `recipe ${recipe} block appended (${tail.length + 2} lines)`;

  const bytes = encodeScript(joinScript({ lines: r.out, newline: split.newline, trailingNewline: true }));
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex'), warnings: r.warnings, anchors: r.anchors, partial: r.partial };
}

/** The `Castcade_<R>_*` subs the anchor lines call (B and C): every one, whatever was anchored, so the block's shape is fixed. */
function anchorSubs(r: Render, x: Exprs): string[] {
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
    ...sub('GameStart', [`Castcade_${R}_Players = 1`, `Castcade_GameStart ${count}`]),
    ...sub('Scores', x.scores === null ? [] : [`Castcade_Scores ${list}, ${x.player}, ${x.ball}`]),
    ...sub('BallEnd', [`Castcade_BallEnd ${x.player}, ${x.ball}, ${x.extra}`]),
    ...sub('GameEnd', [`Castcade_GameEnd ${list}, ${count}`]),
  ];
}

/** `CurrentPlayer = 0` or `= 1` as a statement: in `ResetForNewGame` first, else anywhere. */
function playerBase(lines: readonly string[], reset: SubRange | null): 0 | 1 | null {
  const rx = /(?:^|:|\bThen)\s*CurrentPlayer\s*=\s*([01])\s*(?::|$)/i;
  const scan = (from: number, to: number): 0 | 1 | null => {
    for (let i = from; i < to; i++) {
      const m = rx.exec(code(lines, i));
      if (m) return m[1] === '0' ? 0 : 1;
    }
    return null;
  };
  return (reset ? scan(reset.start + 1, reset.end) : null) ?? scan(0, lines.length);
}

/** The table's ball number: its `Balls` function or variable, else computed from `BallsPerGame` / `BallsRemaining`. */
function ballExpr(lines: readonly string[]): string | null {
  if (findSub(lines, 'Balls')[0] >= 0) return 'Balls';
  if (findLine(lines, /^\s*(Dim|Public|Private)\s+(\w+(\(\s*\d*\s*\))?\s*,\s*)*Balls\s*(,|:|$)/) >= 0) return 'Balls';
  if (hasIdent(lines, 'BallsPerGame') && hasIdent(lines, 'BallsRemaining')) return 'BallsPerGame - BallsRemaining(CurrentPlayer) + 1';
  return null;
}

function recipeB(r: Render): string[] {
  const L = r.lines;
  const sub = (name: string): SubRange | null => {
    const s = subRange(L, name);
    return typeof s === 'string' ? null : s;
  };
  const reason = (name: string): string => {
    const s = subRange(L, name);
    return typeof s === 'string' ? s : '';
  };
  const reset = sub('ResetForNewGame');
  const base = playerBase(L, reset);
  if (base === null) r.warnings.push('no "CurrentPlayer = 0" or "= 1" found; player 1 is taken as Score(1)');
  const b: 0 | 1 = base ?? 1;
  const havePlayer = hasIdent(L, 'CurrentPlayer');
  if (!havePlayer) r.warnings.push('no CurrentPlayer variable; every event names player 1');
  const player = havePlayer ? (b === 1 ? 'CurrentPlayer' : 'CurrentPlayer + 1') : '1';
  const players = hasIdent(L, 'PlayersPlayingGame') ? 'PlayersPlayingGame' : '1';
  if (players === '1') r.warnings.push('no PlayersPlayingGame variable; games are journaled as 1 player');
  const ball = ballExpr(L);
  if (ball === null) r.warnings.push('no ball number (Balls, BallsPerGame / BallsRemaining); ball fields are 0');
  const haveScores = findLine(L, /^\s*(Dim|Public|Private)\s+(\w+(\(\s*\d*\s*\))?\s*,\s*)*Score\s*\(/) >= 0;
  if (!haveScores) r.miss('no Dim Score( array; scores are not journaled', true);
  const x: Exprs = {
    scores: haveScores ? 'Score' : null,
    base: b,
    player,
    ball: ball ?? '0',
    players,
    extra: hasIdent(L, 'ExtraBallsAwards') ? 'ExtraBallsAwards(CurrentPlayer)' : '0',
  };
  r.anchors['vars'] = `Score base ${b}, player ${player}, ball ${x.ball}, players ${players}`;

  const add = sub('AddScore');
  if (add && haveScores) r.atEnd('scores', add, 'Scores', 'current scores', true);
  else if (!add) r.miss(`${reason('AddScore')}; live scores are not journaled`, false);
  if (reset) r.atEnd('gameStart', reset, 'GameStart', 'game start', false);
  else r.miss(`${reason('ResetForNewGame')}; no game start is journaled`, true);
  const eog = sub('EndOfGame');
  if (eog) r.atEnd('gameEnd', eog, 'GameEnd', 'game end', false);
  else r.miss(`${reason('EndOfGame')}; no game end is journaled`, true);
  const eob = sub('EndOfBall');
  if (eob) r.atTop('ballEnd', eob, 'BallEnd', 'ball end');
  else {
    const dec = findLine(L, /^\s*BallsRemaining\s*\(\s*CurrentPlayer\s*\)\s*=\s*BallsRemaining\s*\(\s*CurrentPlayer\s*\)\s*-/);
    if (dec >= 0) r.before('ballEnd', dec, 'BallEnd', 'ball end', `before the BallsRemaining decrement (line ${dec + 1})`);
    else r.miss('no EndOfBall sub and no BallsRemaining(CurrentPlayer) decrement; no ball end is journaled', false);
  }
  return anchorSubs(r, x);
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
