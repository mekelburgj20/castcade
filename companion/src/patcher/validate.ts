/**
 * Static and live validation of a rendered sidecar (WORK C1.4).
 *
 * `lintSidecar` is what can be checked without running VPX: the undo is exact, every line we put into the table's
 * own subs sits where a statement is legal and calls a sub our block defines, the block structure of the script is
 * what it was plus our own balanced blocks, and no handler or `Castcade_*` name is defined twice. It is not a
 * VBScript parser: it compares the rendered script with the original, so whatever the scanner misreads in a table's
 * own code is misread the same way on both sides and only our lines can make a difference.
 *
 * `checkGameJournal` judges the journal of one played game (the live-validation runner,
 * `companion/scripts/validate-original.ts`): `table_loaded`, `game_start`, the ball ends in order, `game_end` with a
 * score that is not below the last live one. `resourceFolders` names the folders beside a table that its script loads
 * from (a FlexDMD / UltraDMD project), which a staged copy needs beside it too.
 */
import { ORIGINAL_EXIT_INSERT, ORIGINAL_LINE_INSERT, parseSidecarMarker, unpatchSidecar } from './render.js';
import { lineContexts, splitScript, stripComment } from './script-text.js';

/** The statements of one line's code part: split at `:` outside string literals. */
function statements(codePart: string): string[] {
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

const BLOCKS: readonly { kind: string; open: RegExp; close: RegExp }[] = [
  { kind: 'Sub', open: /^(?:Public\s+|Private\s+)?(?:Default\s+)?Sub\b/i, close: /^End\s+Sub\b/i },
  { kind: 'Function', open: /^(?:Public\s+|Private\s+)?(?:Default\s+)?Function\b/i, close: /^End\s+Function\b/i },
  { kind: 'Property', open: /^(?:Public\s+|Private\s+)?(?:Default\s+)?Property\s+(?:Get|Let|Set)\b/i, close: /^End\s+Property\b/i },
  { kind: 'Class', open: /^Class\s+\w+/i, close: /^End\s+Class\b/i },
  { kind: 'Select', open: /^Select\s+Case\b/i, close: /^End\s+Select\b/i },
  { kind: 'With', open: /^With\b/i, close: /^End\s+With\b/i },
  { kind: 'For', open: /^For\b/i, close: /^Next\b/i },
  { kind: 'Do', open: /^Do\b/i, close: /^Loop\b/i },
  { kind: 'While', open: /^While\b/i, close: /^Wend\b/i },
];

/** Opens minus closes per block kind over a whole script (a block `If` is one whose `Then` ends its statement). */
export function blockBalance(lines: readonly string[]): Record<string, number> {
  const bal: Record<string, number> = { If: 0 };
  for (const b of BLOCKS) bal[b.kind] = 0;
  let joined = '';
  for (const raw of lines) {
    const c = stripComment(raw);
    // a statement continued with " _" is one statement
    if (/(?:^|\s)_\s*$/.test(c)) {
      joined += c.replace(/_\s*$/, ' ');
      continue;
    }
    const sts = statements(joined + c);
    joined = '';
    for (let i = 0; i < sts.length; i++) {
      const st = sts[i] ?? '';
      if (/^End\s+If\b/i.test(st)) bal['If'] = (bal['If'] ?? 0) - 1;
      // `If x Then` closing its statement is a block If only when nothing follows it on the line
      else if (/^If\b.*\bThen$/i.test(st) && i === sts.length - 1) bal['If'] = (bal['If'] ?? 0) + 1;
      for (const b of BLOCKS) {
        if (b.close.test(st)) bal[b.kind] = (bal[b.kind] ?? 0) - 1;
        else if (b.open.test(st)) bal[b.kind] = (bal[b.kind] ?? 0) + 1;
      }
    }
  }
  return bal;
}

const PROC_DEF = /^\s*(?:Public\s+|Private\s+)?(?:Sub|Function)\s+(\w+)/i;

/**
 * Problems with `rendered` as a patch of `original` (both as `decodeScript` gives them); empty = nothing found.
 * See the file header for what is and is not checked.
 */
export function lintSidecar(original: string, rendered: string): string[] {
  const problems: string[] = [];
  const undone = unpatchSidecar(rendered);
  if (undone === null) problems.push('not a Castcade sidecar this build can undo');
  else if (undone !== original) {
    let i = 0;
    while (i < undone.length && i < original.length && undone[i] === original[i]) i++;
    problems.push(`the undo is not exact: first difference at byte ${i} of ${original.length} (undone ${undone.length} bytes)`);
  }

  const L = splitScript(rendered).lines;
  const ctx = lineContexts(L);
  const code = (i: number): string => stripComment(L[i] ?? '');
  // every Sub / Function, by lower-cased name: how often it is defined (one-line procedures included) and where last
  const definitions = (lines: readonly string[]): Map<string, { n: number; last: number }> => {
    const out = new Map<string, { n: number; last: number }>();
    for (let i = 0; i < lines.length; i++) {
      for (const st of statements(stripComment(lines[i] ?? ''))) {
        const m = PROC_DEF.exec(st);
        if (m?.[1]) out.set(m[1].toLowerCase(), { n: (out.get(m[1].toLowerCase())?.n ?? 0) + 1, last: i });
      }
    }
    return out;
  };
  const defined = definitions(L);
  const was = definitions(splitScript(original).lines);
  const wrapAt = L.findIndex((l) => l.startsWith("' --- Castcade turn lock + exit hook"));
  for (const [name, d] of defined) {
    if (/^castcade_/.test(name) && d.n > 1) problems.push(`${name} is defined ${d.n} times`);
    // A handler we wrap: the table's own definitions are as many as before (one of them renamed, ours added), and
    // ours is the last one in the file, the one VBScript keeps.
    if (wrapAt >= 0 && d.last > wrapAt && /_(keydown|keyup|exit)$/.test(name) && d.n > Math.max(1, was.get(name)?.n ?? 0)) problems.push(`${name} is defined ${d.n} times`);
  }
  // The definition we renamed must be the table's LAST one of that handler: an earlier one is dead code in VBScript,
  // and wrapping it would leave the handler that really ran uncalled.
  for (let i = 0; i < (wrapAt < 0 ? 0 : wrapAt); i++) {
    for (const st of statements(code(i))) {
      const name = PROC_DEF.exec(st)?.[1]?.toLowerCase() ?? '';
      const suffix = /_(keydown|keyup|exit)$/.exec(name)?.[1];
      const ours = suffix ? defined.get(name) : undefined;
      const renamed = suffix ? defined.get(`castcade_orig_${suffix}`) : undefined;
      if (ours && renamed && ours.last > wrapAt && !name.startsWith('castcade_') && i > renamed.last) problems.push(`line ${i + 1} defines ${name} after the definition that was renamed: the handler the table really runs is not the one wrapped`);
    }
  }
  const calls = (name: string, at: number): void => {
    if (!defined.has(name.toLowerCase())) problems.push(`line ${at + 1} calls ${name}, which the sidecar does not define`);
  };

  let anchors = 0;
  for (let i = 0; i < L.length; i++) {
    const line = L[i] ?? '';
    for (const m of line.matchAll(new RegExp(ORIGINAL_EXIT_INSERT.source, 'gi'))) calls(m[0].replace(/\s*:\s*$/, ''), i);
    if (!ORIGINAL_LINE_INSERT.test(line)) continue;
    anchors++;
    const name = /Castcade_[A-Z]_[A-Za-z]+/.exec(line)?.[0] ?? '';
    calls(name, i);
    const c = ctx[i];
    if (!c || c.proc < 0) problems.push(`line ${i + 1} (${name}) is outside any Sub or Function`);
    else if (c.proc === i) problems.push(`line ${i + 1} (${name}) is on a procedure's head line`);
    else if (c.inClass) problems.push(`line ${i + 1} (${name}) is inside a Class member (${c.procName}), which cannot see the anchor subs' scope reliably`);
    if (/(?:^|\s)_\s*$/.test(code(i - 1))) problems.push(`line ${i + 1} (${name}) follows a line continuation`);
    for (let j = i - 1; j >= 0; j--) {
      const prev = code(j).trim();
      if (prev === '') continue;
      const last = statements(prev).at(-1) ?? '';
      if (/^Select\s+Case\b/i.test(last)) problems.push(`line ${i + 1} (${name}) sits between Select Case and its first Case`);
      break;
    }
  }
  const recipe = parseSidecarMarker(rendered)?.recipe;
  if ((recipe === 'B' || recipe === 'C') && anchors === 0) problems.push("no anchor line was placed in any of the table's subs");

  const before = blockBalance(splitScript(original).lines);
  const after = blockBalance(L);
  for (const kind of Object.keys(after)) {
    // block 0 is one balanced If; the wrappers and the anchor block are whole procedures
    if ((after[kind] ?? 0) !== (before[kind] ?? 0)) problems.push(`${kind} blocks: the script was off by ${before[kind] ?? 0}, the sidecar is off by ${after[kind] ?? 0}`);
  }
  return problems;
}

// ----------------------------------------------------------------------------------------- the live check

export interface JournalCheckOptions {
  /** Ball ends the game must journal before its game end (default 3; a 5-ball table passes with more). */
  balls?: number;
}

export interface JournalCheck {
  ok: boolean;
  problems: string[];
  /** Worth a look, not a failure (a game that never scored journals no score line). */
  notes: string[];
  /** What the session held, for the report. */
  summary: {
    tableLoaded: boolean;
    recipe: string | null;
    recipeVersion: string | null;
    lib: string | null;
    gameStarts: number;
    ballEnds: { player: number | null; ball: number | null; extraBalls: number | null }[];
    gameEnds: { scores: unknown; players: number | null }[];
    scoreLines: number;
    /** A key-down reached the sidecar's wrapper (the hook journals the lock state, a `lock` line, at the first one). */
    keysSeen: boolean;
    warns: string[];
    tableExit: boolean;
  };
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Judge the LAST session in a journal (from its last `table_loaded`): the first game in it must read `game_start`,
 * then at least `balls` ball ends whose ball numbers never go down and start at 1, then `game_end` with a score.
 * A ball end with `extra_balls` above 0 is a shoot-again and does not count towards `balls`.
 */
export function checkGameJournal(journalLines: readonly string[], opts: JournalCheckOptions = {}): JournalCheck {
  const want = opts.balls ?? 3;
  const events: Record<string, unknown>[] = [];
  let unparsed = 0;
  for (const l of journalLines) {
    if (l.trim() === '') continue;
    try {
      const o: unknown = JSON.parse(l);
      if (o && typeof o === 'object') events.push(o as Record<string, unknown>);
    } catch {
      unparsed++;
    }
  }
  let from = -1;
  events.forEach((e, i) => {
    if (e['event'] === 'table_loaded') from = i;
  });
  const session = from < 0 ? [] : events.slice(from);
  const loaded = session[0];
  const s: JournalCheck['summary'] = {
    tableLoaded: from >= 0,
    recipe: typeof loaded?.['recipe'] === 'string' ? loaded['recipe'] : null,
    recipeVersion: typeof loaded?.['recipe_version'] === 'string' ? loaded['recipe_version'] : null,
    lib: typeof loaded?.['lib'] === 'string' ? loaded['lib'] : null,
    gameStarts: 0,
    ballEnds: [],
    gameEnds: [],
    scoreLines: 0,
    keysSeen: false,
    warns: [],
    tableExit: false,
  };
  const problems: string[] = [];
  if (unparsed > 0) problems.push(`${unparsed} journal line${unparsed === 1 ? ' is' : 's are'} not JSON`);
  if (from < 0) {
    problems.push('no table_loaded: the sidecar did not load (VPX ran the table\'s own script, or the script failed to compile)');
    return { ok: false, problems, notes: [], summary: s };
  }
  // the first game of the session: from its game_start to its game_end
  let state: 'idle' | 'playing' | 'over' = 'idle';
  let counted = 0;
  let lastBall = 0;
  let live: number[] | null = null;
  for (const e of session) {
    const ev = e['event'];
    if (ev === 'warn') s.warns.push(String(e['msg'] ?? ''));
    else if (ev === 'table_exit') s.tableExit = true;
    else if (ev === 'lock' || ev === 'key_blocked') s.keysSeen = true;
    else if (ev === 'current_scores') {
      s.scoreLines++;
      const sc = e['scores'];
      if (state === 'playing' && Array.isArray(sc) && sc.every((v) => typeof v === 'number')) live = sc as number[];
    } else if (ev === 'game_start') {
      s.gameStarts++;
      if (state === 'playing') problems.push('a second game_start before the game ended');
      if (state === 'idle') state = 'playing';
    } else if (ev === 'ball_end') {
      const b = { player: num(e['player']), ball: num(e['ball']), extraBalls: num(e['extra_balls']) };
      s.ballEnds.push(b);
      if (state === 'idle') problems.push(`ball_end (ball ${b.ball ?? '?'}) before any game_start`);
      if (state !== 'playing') continue;
      if (b.ball === null || b.ball < 1) problems.push(`ball_end carries ball ${b.ball ?? 'null'}; the ball number was not read`);
      else {
        if (b.ball < lastBall) problems.push(`ball_end ball ${b.ball} after ball ${lastBall}: the ball number went down`);
        if (counted === 0 && b.ball !== 1) problems.push(`the first ball_end is ball ${b.ball}, not ball 1`);
        lastBall = b.ball;
      }
      if (b.player === null || b.player < 1) problems.push(`ball_end carries player ${b.player ?? 'null'}`);
      if ((b.extraBalls ?? 0) <= 0) counted++;
    } else if (ev === 'game_end') {
      s.gameEnds.push({ scores: e['scores'], players: num(e['players']) });
      if (state === 'idle') problems.push('game_end before any game_start');
      if (state === 'playing') {
        state = 'over';
        const scores = e['scores'];
        if (!Array.isArray(scores) || scores.length === 0 || scores.some((v) => typeof v !== 'number')) problems.push(`game_end carries scores ${JSON.stringify(scores)}`);
        // The Matrix (Original) 0.99.0, 2026-11-12: three ball ends and a final score of 0 after 1461760 live.
        else if (live !== null && live.some((v, i) => v > ((scores as number[])[i] ?? 0))) problems.push(`game_end carries scores ${JSON.stringify(scores)}, below the last live scores ${JSON.stringify(live)}: the table cleared its scores before the game end was journaled`);
        if (counted < want) problems.push(`game_end after ${counted} ball end${counted === 1 ? '' : 's'}; expected ${want}`);
      }
    }
  }
  if (s.gameStarts === 0) problems.push('no game_start');
  if (state === 'playing') problems.push(`no game_end (the game journaled ${counted} ball end${counted === 1 ? '' : 's'})`);
  const notes: string[] = [];
  if (!s.keysSeen && s.gameStarts === 0) notes.push('no key press reached the table: a dialog was open over the player (a file or folder the table asks for is missing?), or the window never had the keyboard');
  if (s.scoreLines === 0 && s.gameStarts > 0) notes.push('no current_scores line: either nothing scored, or the live score is not journaled');
  if (s.warns.length > 0) notes.push(`${s.warns.length} warn line${s.warns.length === 1 ? '' : 's'} from the hook: ${s.warns.slice(0, 3).join(' | ')}`);
  if (!s.tableExit) notes.push('no table_exit: VPX did not close the table cleanly (or the journal was read before it did)');
  return { ok: problems.length === 0, problems, notes, summary: s };
}

// ----------------------------------------------------------------------------------------- the staged copy

/**
 * Of the folders beside a table (`dirNames`), the ones its script loads files from. A table staged in another folder
 * without them stops at a dialog before any key reaches it: 2026-11-12, Game of Thrones ("FlexDMD directory
 * gameofthrones.FlexDMD appears to be missing"), Sonic and Thundercats ("UltraDMD userfiles directory ... does not
 * exist"), The Goonies (`./TheGooniesDMD/`). A folder is taken when its name ends in `DMD` and
 * - a string literal of the script holds the whole name (`"./TheGooniesDMD/"`, `"./Diablo 2.FlexDMD/"`), or
 * - it is `<stem>.UltraDMD` / `<stem>.FlexDMD`, the script has the literal `"<stem>"` (`Const TableName = "Sonic"`)
 *   and a literal that starts with that suffix (`TableName & ".UltraDMD"`).
 */
export function resourceFolders(scriptText: string, dirNames: readonly string[]): string[] {
  const lits = splitScript(scriptText).lines.flatMap((l) => [...stripComment(l).matchAll(/"([^"]*)"/g)].map((m) => (m[1] ?? '').toLowerCase()));
  return dirNames.filter((dir) => {
    const d = dir.toLowerCase();
    if (!d.endsWith('dmd')) return false;
    if (lits.some((l) => l.includes(d))) return true;
    const m = /^(.+)(\.(?:ultradmd|flexdmd))$/.exec(d);
    return m !== null && lits.includes(m[1] ?? '') && lits.some((l) => l.startsWith(m[2] ?? '\0'));
  });
}
