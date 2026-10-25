/**
 * Script inspection (F5, `docs/design/fairness-and-table-identity.md` §4): diff the script that ran against a baseline
 * and classify each change, instead of hashing the script (a hash fails every honest VR or volume edit).
 *
 * 1. Normalise both scripts into statements: comments (`'` and `Rem`) and blank lines dropped, `_` continuations
 *    joined, `:` separated statements split, whitespace collapsed, everything outside string literals lower-cased
 *    (VBScript is case-insensitive; string contents are data and keep their case).
 * 2. Diff the statement lists (Myers, after trimming the common head and tail).
 * 3. Classify each hunk:
 *    - restricted: it touches a name that changes play (physics, difficulty, outlanes, ball size or mass, ball saver,
 *      balls per game, extra balls, tilt, the ROM name), or it ADDS a ball, a switch write or code built from text
 *      (`Execute`, `ExecuteGlobal`, `Eval`, `GetRef`) that the baseline side did not have;
 *    - allowed: every changed statement is a literal assignment to a cosmetic name (VR, cabinet, desktop, DMD, sound,
 *      lights, reflections, shadows) and nothing restricted;
 *    - unknown: the rest, for the runner to judge.
 *    Restricted wins. The name lists come from real options blocks (VPW's Monster Bash keeps `OutLaneDifficulty`,
 *    `Rubberizer`, `FlipperCoilRampupMode` and `TargetBouncer*` beside `VRRoom` and `VolumeDial`, so "the options
 *    block" is not a safe allow-list by position).
 *
 * Only the report leaves the machine: the changed statements (capped), never the whole script.
 */
import { createHash } from 'node:crypto';

export type HunkClass = 'allowed' | 'restricted' | 'unknown';

export interface Hunk {
  /** 1-based index of the first baseline statement the hunk replaces (or follows, for a pure insertion). */
  at: number;
  del: string[];
  add: string[];
}

export interface ClassifiedHunk extends Hunk {
  cls: HunkClass;
  why: string;
}

export interface ScriptDiffReport {
  /** Report format version. */
  v: number;
  /** What ran: the table's own script, Castcade's untouched patch of it, Castcade's patch edited by hand, or someone else's sidecar. */
  ran: 'embedded' | 'castcade' | 'castcade_edited' | 'foreign';
  /** What it was compared with. */
  baseline: 'embedded' | 'runner';
  /** sha256 of the normalised baseline and of the normalised script that ran (equal = no change). */
  baselineSha256: string;
  ranSha256: string;
  counts: Record<HunkClass, number>;
  hunks: ClassifiedHunk[];
  /** True when the diff was too large to compute or report in full. */
  truncated: boolean;
}

export const SCRIPT_DIFF_VERSION = 1;

// ------------------------------------------------------------------------------------- normalise --

/**
 * Split one physical line into its code and comment parts: everything after a `'` outside a string is a comment.
 * Strings are `"..."` with `""` as the escaped quote.
 */
function stripComment(line: string): string {
  let inStr = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inStr && line[i + 1] === '"') {
        i++;
        continue;
      }
      inStr = !inStr;
    } else if (c === "'" && !inStr) {
      return line.slice(0, i);
    }
  }
  return line;
}

/** Split on `:` outside strings (VBScript's statement separator). */
function splitStatements(code: string): string[] {
  const out: string[] = [];
  let inStr = false;
  let start = 0;
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === '"') {
      if (inStr && code[i + 1] === '"') {
        i++;
        continue;
      }
      inStr = !inStr;
    } else if (c === ':' && !inStr) {
      out.push(code.slice(start, i));
      start = i + 1;
    }
  }
  out.push(code.slice(start));
  return out;
}

/** Lower-case and collapse whitespace outside string literals; keep string contents exactly. */
function canonicalStatement(s: string): string {
  let out = '';
  let inStr = false;
  let space = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '"') {
      if (inStr && s[i + 1] === '"') {
        out += '""';
        i++;
        continue;
      }
      if (!inStr && space && out.length > 0) out += ' ';
      space = false;
      inStr = !inStr;
      out += c;
      continue;
    }
    if (inStr) {
      out += c;
      continue;
    }
    if (c === ' ' || c === '\t') {
      space = true;
      continue;
    }
    if (space && out.length > 0) out += ' ';
    space = false;
    out += c.toLowerCase();
  }
  return out.trim();
}

/** The script as a list of canonical statements (see the module comment). */
export function normalizeScript(text: string): string[] {
  const physical = text.replace(/\r\n?/g, '\n').split('\n');
  const logical: string[] = [];
  let pending = '';
  for (const raw of physical) {
    const code = stripComment(raw);
    // A trailing ` _` continues the statement on the next line.
    const m = /\s_\s*$/.exec(code);
    if (m) {
      pending += code.slice(0, m.index) + ' ';
      continue;
    }
    logical.push(pending + code);
    pending = '';
  }
  if (pending) logical.push(pending);
  const out: string[] = [];
  for (const line of logical) {
    for (const st of splitStatements(line)) {
      const c = canonicalStatement(st);
      if (c === '' || /^rem(\s|$)/.test(c)) continue;
      out.push(c);
    }
  }
  return out;
}

export const sha256OfStatements = (st: string[]): string => createHash('sha256').update(st.join('\n')).digest('hex');

// ------------------------------------------------------------------------------------------ diff --

/** Beyond this many edits the scripts are not variants of one another; the report says so instead. */
export const MAX_EDIT_DISTANCE = 4000;

/**
 * Hunks turning `a` into `b`: Myers' O((N+M)D) diff on the part left after the common head and tail.
 * Returns null when the edit distance passes `maxD`.
 */
export function diffStatements(a: string[], b: string[], maxD = MAX_EDIT_DISTANCE): Hunk[] | null {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const A = a.slice(head, a.length - tail);
  const B = b.slice(head, b.length - tail);
  const N = A.length;
  const M = B.length;
  if (N === 0 && M === 0) return [];
  if (N === 0 || M === 0) return [{ at: head + 1, del: A, add: B }];

  const max = Math.min(N + M, maxD);
  const offset = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    const next = v.slice();
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) x = v[offset + k + 1]!;
      else x = v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < N && y < M && A[x] === B[y]) {
        x++;
        y++;
      }
      next[offset + k] = x;
      if (x >= N && y >= M) {
        found = d;
        break;
      }
    }
    v = next;
    if (found >= 0) {
      trace.push(v.slice());
      break;
    }
  }
  if (found < 0) return null;

  // Walk back through the trace into a list of edit operations.
  type Op = { kind: 'eq' | 'del' | 'add'; ai: number; bi: number };
  const ops: Op[] = [];
  let x = N;
  let y = M;
  for (let d = found; d > 0; d--) {
    const vd = trace[d]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && vd[offset + k - 1]! < vd[offset + k + 1]!) ? k + 1 : k - 1;
    const prevX = vd[offset + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ kind: 'eq', ai: --x, bi: --y });
    }
    if (x === prevX) ops.push({ kind: 'add', ai: x, bi: --y });
    else ops.push({ kind: 'del', ai: --x, bi: y });
  }
  while (x > 0 && y > 0) ops.push({ kind: 'eq', ai: --x, bi: --y });
  ops.reverse();

  const hunks: Hunk[] = [];
  let cur: Hunk | null = null;
  for (const op of ops) {
    if (op.kind === 'eq') {
      cur = null;
      continue;
    }
    if (!cur) {
      cur = { at: head + op.ai + 1, del: [], add: [] };
      hunks.push(cur);
    }
    if (op.kind === 'del') cur.del.push(A[op.ai]!);
    else cur.add.push(B[op.bi]!);
  }
  return hunks;
}

// -------------------------------------------------------------------------------------- classify --

/** Names that change how the table plays, matched inside identifiers (`outlanedifficulty`, `ballsavertime`). */
const RESTRICTED_NAME = /(difficulty|outlane|rampup|strength|eostorque|torque|gravity|slope|friction|elastic|bounce|rubberizer|ballsize|ballmass|ballsave|ballspergame|extraball|tilt|nudge|scatter|damping|physics|cgamename)/;
/** Calls that, when a hunk adds more of them than it removes, are restricted (string-built code hides from a scan). */
const RESTRICTED_CALL = /\b(createball|destroyball|execute|executeglobal|eval|getref|pulsesw)\b|\.switch\s*\(|controller\.switch/g;
/** Cosmetic names: an allowed hunk only assigns literals to these. */
const COSMETIC_NAME = /(vr|cabinet|desktop|dmd|volume|vol|sound|sfx|music|amp|light|flash|bright|glow|intensity|reflect|shadow|fps|render|ambient|lut|colou?r|blend|room|backglass|cinematic)/;
/** `[const|dim|public|private] name = literal` (number, string, True / False). */
const LITERAL_ASSIGNMENT = /^(?:(?:const|dim|public|private)\s+)?([a-z_][a-z0-9_]*)\s*=\s*(-?[0-9.]+(?:e-?[0-9]+)?|"(?:[^"]|"")*"|true|false)$/;

/** Identifier-ish tokens of a statement, outside string literals. */
function identifiers(st: string): string[] {
  return st.replace(/"(?:[^"]|"")*"/g, ' ').match(/[a-z_][a-z0-9_]*/g) ?? [];
}

function countCalls(lines: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of lines) {
    for (const hit of l.replace(/"(?:[^"]|"")*"/g, ' ').matchAll(RESTRICTED_CALL)) {
      const k = (hit[1] ?? (hit[0].includes('controller') ? 'controller.switch' : '.switch(')).replace(/\s/g, '');
      m.set(k, (m.get(k) ?? 0) + 1);
    }
  }
  return m;
}

export function classifyHunk(h: Hunk): { cls: HunkClass; why: string } {
  const changed = [...h.del, ...h.add];
  for (const st of changed) {
    const hit = identifiers(st).find((id) => RESTRICTED_NAME.test(id));
    if (hit) return { cls: 'restricted', why: `touches ${hit}` };
  }
  const before = countCalls(h.del);
  const after = countCalls(h.add);
  for (const [call, n] of after) {
    if (n > (before.get(call) ?? 0)) return { cls: 'restricted', why: `adds ${call === '.switch(' || call === 'controller.switch' ? 'a switch write' : call}` };
  }
  const allCosmetic = changed.length > 0 && changed.every((st) => {
    const m = LITERAL_ASSIGNMENT.exec(st);
    return m !== null && COSMETIC_NAME.test(m[1]!);
  });
  if (allCosmetic) {
    const names = [...new Set(changed.map((st) => LITERAL_ASSIGNMENT.exec(st)![1]!))];
    return { cls: 'allowed', why: `cosmetic option${names.length === 1 ? '' : 's'} ${names.join(', ')}` };
  }
  return { cls: 'unknown', why: 'not a recognised option or rule change' };
}

// ---------------------------------------------------------------------------------------- report --

export function scriptDiffReport(
  baselineText: string,
  ranText: string,
  meta: { ran: ScriptDiffReport['ran']; baseline: ScriptDiffReport['baseline'] },
): ScriptDiffReport {
  const a = normalizeScript(baselineText);
  const b = normalizeScript(ranText);
  const hunks = diffStatements(a, b);
  const classified = (hunks ?? []).map((h) => ({ ...h, ...classifyHunk(h) }));
  const counts: Record<HunkClass, number> = { allowed: 0, restricted: 0, unknown: 0 };
  for (const h of classified) counts[h.cls]++;
  return {
    v: SCRIPT_DIFF_VERSION,
    ran: meta.ran,
    baseline: meta.baseline,
    baselineSha256: sha256OfStatements(a),
    ranSha256: sha256OfStatements(b),
    counts,
    hunks: classified,
    truncated: hunks === null,
  };
}

/** The score is a GET: the report is capped (restricted first, then unknown, then allowed), counts always whole. */
export const MAX_SCRIPT_DIFF_WIRE = 3000;
const MAX_STATEMENT_CHARS = 160;

/** Compact `script_diff` JSON for the score, or null when nothing changed. */
export function scriptDiffWire(r: ScriptDiffReport | null, maxChars = MAX_SCRIPT_DIFF_WIRE): string | null {
  if (!r || (r.hunks.length === 0 && !r.truncated)) return null;
  const clip = (s: string) => (s.length > MAX_STATEMENT_CHARS ? s.slice(0, MAX_STATEMENT_CHARS - 1) + '…' : s);
  const order: Record<HunkClass, number> = { restricted: 0, unknown: 1, allowed: 2 };
  const ranked = [...r.hunks].sort((x, y) => order[x.cls] - order[y.cls] || x.at - y.at);
  const head = { v: r.v, ran: r.ran, baseline: r.baseline, baseline_sha256: r.baselineSha256, ran_sha256: r.ranSha256, counts: r.counts };
  const hunks: unknown[] = [];
  let truncated = r.truncated;
  for (const h of ranked) {
    const one = { at: h.at, cls: h.cls, why: h.why, del: h.del.slice(0, 6).map(clip), add: h.add.slice(0, 6).map(clip) };
    if (JSON.stringify({ ...head, hunks: [...hunks, one], truncated: true }).length > maxChars) {
      truncated = true;
      break;
    }
    if (h.del.length > 6 || h.add.length > 6) truncated = true;
    hunks.push(one);
  }
  return JSON.stringify({ ...head, hunks, truncated });
}

/** One line for the capture detail and the log. */
export function describeScriptDiff(r: ScriptDiffReport | null): string {
  if (!r) return 'script: not inspected';
  const what = r.ran === 'embedded' ? "the table's own script" : r.ran === 'castcade' ? "the table's own script with Castcade's hook" : r.ran === 'castcade_edited' ? "Castcade's sidecar, edited by hand" : 'a sidecar .vbs that is not Castcade\'s';
  if (r.truncated && r.hunks.length === 0) return `script: ${what}; too different from the ${r.baseline} script to diff`;
  if (r.hunks.length === 0) return `script: ${what}, no change from the ${r.baseline} script`;
  const c = r.counts;
  const parts = [c.restricted ? `${c.restricted} restricted` : '', c.unknown ? `${c.unknown} unknown` : '', c.allowed ? `${c.allowed} allowed` : ''].filter(Boolean).join(', ');
  const first = r.hunks.find((h) => h.cls === 'restricted');
  return `script: ${what}; ${parts} vs the ${r.baseline} script${first ? ` (first restricted: ${first.why})` : ''}`;
}
