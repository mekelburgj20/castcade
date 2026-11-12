/**
 * Anchor overrides (WORK C1.4): what recipe B's vocabulary cannot read from a script, shipped as data. One record
 * names a script family by its SIGNATURE (regular expressions that must each match a code line) and says, per role,
 * where the anchor line goes and which of the table's own expressions the anchor subs journal. Everything a record
 * leaves out still comes from the vocabulary in `classify.ts` / `render-originals.ts`.
 *
 * Keyed by the script, not by TableInfo: the patcher and the witness both classify from the script text alone, and
 * the tables that need this most carry no usable TableInfo (Diablo 2, Rattlecan and SMGP are all "Visual Pinball
 * Demo Table" with no author). A signature also follows a table through a mod or a re-release, which a name does not.
 *
 * A record is data: no code runs per table. Adding one = a new entry here, an excerpt of the script's shape in
 * `test-scripts.test-support.ts` and a case in `anchor-overrides.test.ts`. A script that matches an override is class
 * B whatever else it has (first match wins, in the order below).
 */
import { findSub, stripComment, type LineContext } from './script-text.js';

export type AnchorRole = 'gameStart' | 'scores' | 'ballEnd' | 'gameEnd';

/** Where one anchor line goes. */
export type AnchorPlace =
  /** First line of / last line before the end of the multi-line Sub or Function `sub`. */
  | { at: 'top' | 'end'; sub: string; pass?: string }
  /**
   * Before / after the first code line matching `line` (a case-insensitive regular expression), optionally only
   * inside `sub`; `every` anchors at each match instead of the first.
   */
  | { at: 'before' | 'after'; line: string; sub?: string; every?: boolean; pass?: string };

export interface AnchorOverride {
  /** Short id, written into the sidecar's anchors and the plan reason. */
  id: string;
  /** What it is, for the plan reason. */
  title: string;
  /** Case-insensitive regular expressions; each must match the code part of some line. */
  signature: readonly string[];
  /** Per role, every place its anchor line goes (a ball can end in more than one sub). Absent = the vocabulary. */
  anchors?: Partial<Record<AnchorRole, readonly AnchorPlace[]>>;
  /**
   * The table's own expressions, evaluated inside our anchor subs under `On Error Resume Next`. Absent = the
   * vocabulary. `scores` is an array expression with player 1 at index `base`; `player` and `ball` are 1-based;
   * `extra` must be above 0 exactly when the same player shoots again after this ball end (the match keeps the turn).
   */
  exprs?: { scores?: string; base?: 0 | 1; player?: string; ball?: string; players?: string; extra?: string };
  /**
   * With a `scores` place that has `pass`: the scores are journaled only when the passed value equals this VBScript
   * literal (GLF's `SetPlayerState key, value` runs for every player variable; only `"score"` matters).
   */
  scoresOnly?: string;
  /** Known limits, added to the render's warnings so the plan and the manifest state them. */
  notes?: readonly string[];
}

export const ANCHOR_OVERRIDES: readonly AnchorOverride[] = [
  {
    // Dark Chaos (apophis 2025) and any other table built on the VPX Game Logic Framework: no AddScore, no start
    // or end sub; the game is a set of pin events handled by Glf_* functions and the score is a player-state entry.
    id: 'glf',
    title: 'VPX Game Logic Framework (GLF)',
    signature: [
      '^\\s*(?:Public\\s+)?Function\\s+Glf_EndOfBall\\b',
      '^\\s*(?:Public\\s+)?Function\\s+Glf_EndGame\\b',
      '^\\s*(?:Public\\s+)?Function\\s+Glf_DispatchGameStarted\\b',
      '^\\s*(?:Public\\s+)?Function\\s+SetPlayerState\\s*\\(\\s*key\\b',
      '^\\s*(?:Public\\s+)?Function\\s+GetPlayerStateForPlayer\\b',
      '^\\s*(?:Public\\s+)?Function\\s+Getglf_currentPlayerNumber\\b',
      '\\bglf_playerState\\b',
    ],
    anchors: {
      // Glf_StartGame runs for every Start press; the game it starts dispatches game_started once, 50 ms later.
      gameStart: [{ at: 'top', sub: 'Glf_DispatchGameStarted' }],
      scores: [{ at: 'end', sub: 'SetPlayerState', pass: 'key' }],
      // The listener of ball_ended, before it spends an extra ball or advances the ball and the player.
      ballEnd: [{ at: 'top', sub: 'Glf_EndOfBall' }],
      // Before Glf_EndGame empties glf_playerState.
      gameEnd: [{ at: 'top', sub: 'Glf_EndGame' }],
    },
    exprs: {
      scores: 'Array(GetPlayerStateForPlayer(0, "score"), GetPlayerStateForPlayer(1, "score"), GetPlayerStateForPlayer(2, "score"), GetPlayerStateForPlayer(3, "score"))',
      base: 0,
      player: 'Getglf_currentPlayerNumber() + 1',
      ball: 'GetPlayerState("ball")',
      players: 'UBound(glf_playerState.Keys()) + 1',
      extra: 'GetPlayerState("extra_balls")',
    },
    scoresOnly: '"score"',
  },
  {
    // 2001: A Space Odyssey and Star Wars (burgereater289): the ball ends where the drain handler (or its timer)
    // switches on the ball counter text; DMDballnum is the ball shown to the player; an extra ball is the counter
    // text set one behind (999 on ball 1), so the same Case runs again.
    id: 'burger',
    title: 'the Burger template (2001: A Space Odyssey, Star Wars)',
    signature: ['^\\s*Select\\s+Case\\s+ballstext\\.text\\b', '\\bDMDballnum\\b', '\\bnumplay\\b', '^\\s*(?:Public\\s+|Private\\s+)?Sub\\s+SetScore\\b'],
    anchors: { ballEnd: [{ at: 'before', line: '^\\s*Select\\s+Case\\s+ballstext\\.text\\b' }] },
    exprs: { ball: 'DMDballnum', extra: 'Abs(CLng(ballstext.text) = 999 Or CLng(ballstext.text) < CLng(DMDballnum))' },
    notes: ['Burger template: the extra-ball flag is read from the ball counter text (one behind the ball shown, or 999)'],
  },
  {
    // Rattlecan: a drained ball enables one of two timers (a normal drain, a drain after a tilt); each advances
    // BallInPlay, spends an extra ball or sets GameOver.
    id: 'rattlecan',
    title: 'Rattlecan',
    signature: ['^\\s*Sub\\s+ShootAgain_Timer\\b', '^\\s*Sub\\s+ShootAgainAfterTilt_Timer\\b', '\\bBallInPlay\\b', '\\bExtraBalls\\b'],
    anchors: { ballEnd: [{ at: 'top', sub: 'ShootAgain_Timer' }, { at: 'top', sub: 'ShootAgainAfterTilt_Timer' }] },
    exprs: { ball: 'BallInPlay', extra: 'ExtraBalls' },
  },
];

/** The first override whose whole signature the script matches, or `null`. */
export function findOverride(lines: readonly string[], overrides: readonly AnchorOverride[] = ANCHOR_OVERRIDES): AnchorOverride | null {
  if (overrides.length === 0) return null;
  const code = lines.map(stripComment);
  for (const o of overrides) {
    if (o.signature.every((s) => {
      const rx = new RegExp(s, 'i');
      return code.some((c) => rx.test(c));
    })) return o;
  }
  return null;
}

export function overrideById(id: string | null | undefined, overrides: readonly AnchorOverride[] = ANCHOR_OVERRIDES): AnchorOverride | null {
  return (id && overrides.find((o) => o.id === id)) || null;
}

/** One resolved insert point: the 0-based index the anchor line is spliced in at, and how the report words it. */
export interface ResolvedPlace {
  idx: number;
  where: string;
}

/**
 * Resolve a place against the script, or say why it cannot be anchored. A place is only taken inside a multi-line
 * procedure outside any Class, never straight after a line continuation, and never between `Select Case` and its
 * first `Case` (the one spot a statement is a syntax error).
 */
export function resolvePlace(lines: readonly string[], ctx: readonly LineContext[], place: AnchorPlace): ResolvedPlace[] | string {
  const code = (i: number): string => stripComment(lines[i] ?? '');
  const legal = (idx: number): string | null => {
    if (/(?:^|\s)_\s*$/.test(code(idx - 1))) return `line ${idx} continues on the next line`;
    for (let j = idx - 1; j >= 0; j--) {
      const c = code(j).trim();
      if (c === '') continue;
      return /^Select\s+Case\b/i.test(c) && !/:\s*Case\b/i.test(c) ? `line ${j + 1} is a Select Case with no Case before the anchor` : null;
    }
    return null;
  };
  if (!('line' in place)) {
    const [s, e] = findSub(lines, place.sub);
    if (s < 0) return `no Sub ${place.sub}`;
    const head = code(s);
    if (/\bEnd\s+(Sub|Function)\b/i.test(head)) return `Sub ${place.sub} is written on one line`;
    if (/_\s*$/.test(head)) return `Sub ${place.sub}'s parameter list continues on the next line`;
    if (e < 0) return `Sub ${place.sub} has no End Sub`;
    if (ctx[s]?.inClass) return `Sub ${place.sub} is a Class member`;
    const idx = place.at === 'top' ? s + 1 : e;
    const bad = legal(idx);
    if (bad) return `Sub ${place.sub}: ${bad}`;
    return [{ idx, where: `${place.at === 'top' ? 'top' : 'end'} of Sub ${place.sub} (line ${(place.at === 'top' ? s : e) + 1})` }];
  }
  const linePlace = place;
  const rx = new RegExp(linePlace.line, 'i');
  const want = linePlace.sub?.toLowerCase();
  const out: ResolvedPlace[] = [];
  const why: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const c = ctx[i];
    if (!c || c.proc < 0 || c.proc === i || c.inClass) continue;
    if (want !== undefined && c.procName.toLowerCase() !== want) continue;
    if (!rx.test(code(i))) continue;
    const idx = linePlace.at === 'before' ? i : i + 1;
    const bad = legal(idx) ?? (linePlace.at === 'after' && /(?:^|\s)_\s*$/.test(code(i)) ? `line ${i + 1} continues on the next line` : null);
    if (bad) {
      why.push(bad);
      continue;
    }
    out.push({ idx, where: `${linePlace.at} "${code(i).trim()}" in Sub ${c.procName} (line ${i + 1})` });
    if (!linePlace.every) break;
  }
  if (out.length > 0) return out;
  const scope = linePlace.sub ? ` in Sub ${linePlace.sub}` : ' inside a Sub';
  return why.length > 0 ? `no usable line matching /${linePlace.line}/${scope} (${why.join('; ')})` : `no line matching /${linePlace.line}/${scope}`;
}

/** `Castcade_<R>_<fn>` followed by the passed expression, when the place passes one. */
export function passSuffix(place: AnchorPlace): string {
  return place.pass ? ` ${place.pass}` : '';
}

/** A passed expression is one identifier (optionally dotted): what the undo's line template accepts. */
export function validPass(pass: string): boolean {
  return /^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*$/.test(pass);
}

/** Every override's `pass` and regular expressions are well-formed (a test runs this over the shipped data). */
export function checkOverride(o: AnchorOverride): string[] {
  const bad: string[] = [];
  const rx = (s: string, what: string): void => {
    try {
      new RegExp(s, 'i');
    } catch (err) {
      bad.push(`${o.id}: ${what} /${s}/ is not a regular expression (${err instanceof Error ? err.message : String(err)})`);
    }
  };
  if (!/^[a-z][a-z0-9-]*$/.test(o.id)) bad.push(`${o.id}: the id is lower-case letters, digits and dashes`);
  if (o.signature.length === 0) bad.push(`${o.id}: an empty signature would match every script`);
  o.signature.forEach((sig) => rx(sig, 'signature'));
  for (const [role, places] of Object.entries(o.anchors ?? {})) {
    for (const p of places ?? []) {
      if ('line' in p) rx(p.line, `${role} line`);
      else if (!/^\w+$/.test(p.sub)) bad.push(`${o.id}: ${role} sub "${p.sub}" is not a name`);
      if (p.pass !== undefined && !validPass(p.pass)) bad.push(`${o.id}: ${role} passes "${p.pass}", which is not a plain identifier`);
      if (p.pass !== undefined && role !== 'scores') bad.push(`${o.id}: only a scores place can pass a value`);
    }
  }
  if (o.scoresOnly !== undefined && !(o.anchors?.scores ?? []).some((p) => p.pass !== undefined)) bad.push(`${o.id}: scoresOnly needs a scores place with pass`);
  if ((o.anchors?.scores ?? []).some((p) => p.pass !== undefined) && o.scoresOnly === undefined) bad.push(`${o.id}: a scores place with pass needs scoresOnly`);
  for (const [k, v] of Object.entries(o.exprs ?? {})) if (typeof v === 'string' && (/[\r\n]/.test(v) || v.trim() === '')) bad.push(`${o.id}: expression ${k} is empty or spans lines`);
  return bad;
}
