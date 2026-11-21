/**
 * The journal detector: a pure state machine over the lines the in-VPX hook (`vpx-hook/castcade.vbs`)
 * appends to `%LOCALAPPDATA%\Castcade\journal\<table-id>.jsonl`. It is the TypeScript port of the
 * Phase 0 tailer (`vpx-hook/spike/tail-journal.py`, which stays as the oracle behind
 * `fixtures/check.py`); the three recorded fixtures must yield the same balls and games here.
 *
 * Two kinds of table feed it:
 *
 * - **Recipe A (VPM / ROM tables).** The hook journals the live `Controller.NVRAM` as one
 *   `nvram_full` baseline plus a stream of `nvram_delta` triples. The detector keeps the shadow
 *   buffer, decodes the ROM's `game_state` with the maps corpus after every delta, and DERIVES
 *   `game_start` / `ball_end` / `game_end` / `current_scores` from successive states
 *   (`detectTransition`, the rules Phase 0 settled on, `docs/phase-0-spike.md` §8).
 * - **Recipes B/C/D/E (originals).** The sidecar emits those events itself; the detector passes
 *   them through in the same shape, so a consumer never cares which path produced a game.
 *
 * - **Stern SAM (recipe A, no ball or game-over field in reach).** SAM keeps those in CPU RAM, which
 *   `ChangedNVRAM` never reports. `samTransition` derives the game from what NVRAM does hold: the
 *   scores resetting to 0 starts a game, the last-game record's counter (`samEndCounter`) ends it,
 *   and there are no ball ends (`liveSupport().ballEnds` is false, and a match is told so: C18). An audit record
 *   that counts drained balls exists in NVRAM, at an address of its own per ROM, off the watch list; what it would
 *   take to use it is in `fixtures/README.md`, "Stern SAM ball ends".
 * - **Bally AS-2518-17/-35 and Stern M100 (recipe A, ball and player in CPU RAM).** `ballyTransition`
 *   reads the game-over lamp and the last-game scores the ROM writes into NVRAM at game over
 *   (`ballyLiveInputs`); no ball ends either (B10.2, inferred from the map notes, unverified on a rig).
 *
 * Either way `table_exit` while a game is open becomes `game_abandoned` (finding 8: a match or a
 * live capture must never wait on a player who quit the table).
 *
 * No I/O here: `feed()` takes one line and returns the events it implies. The map for a ROM is
 * attached by the owner (`setMap`), because the corpus loads lazily and asynchronously; deltas
 * that arrive before the map still patch the shadow buffer, decoding starts when the map lands.
 */
import { ballyLiveInputs, decodeFinalScores, decodeGameState, decodeHighScores, highScoreOffsets, samEndCounter, type CompiledMap, type GameState, type HighScore } from './maps.js';
import { midnightCount, midnightEnabled, midnightEvidence, type MidnightEvidence, type MidnightSettingReport } from './midnight.js';

/** Events every consumer understands, whichever recipe produced them. */
export type GameEvent =
  | { kind: 'game_start'; t: number; players: number | null }
  | { kind: 'current_scores'; t: number; scores: (number | null)[]; player: number | null; ball: number | null }
  | { kind: 'ball_end'; t: number; player: number | null; ball: number | null; extraBalls: number | null }
  | { kind: 'game_end'; t: number; scores: (number | null)[]; players: number | null }
  | { kind: 'game_abandoned'; t: number; scores: (number | null)[]; player: number | null; ball: number | null };

/** The hook's own housekeeping lines, normalised. */
export type HookEvent =
  | {
      kind: 'table_loaded';
      t: number;
      table: string | null;
      recipe: string | null;
      recipeVersion: string | null;
      rom: string | null;
      lib: string | null;
      session: string | null;
      locked: boolean | null;
    }
  | { kind: 'nvram_hook'; t: number; chained: boolean | null; useNvram: string | null }
  | { kind: 'lock'; t: number; locked: boolean | null }
  | { kind: 'key_blocked'; t: number; key: number | null }
  | { kind: 'warn'; t: number; msg: string | null; err: string | null }
  | { kind: 'stale_sidecar'; t: number; detail: string | null }
  /** Hook 0.4.1 (C10): the patch runs from the table's own script, not a sidecar; nothing is stale. */
  | { kind: 'embedded_patch'; t: number; original: string | null }
  | { kind: 'engine'; t: number; sample: EngineSample }
  | { kind: 'table_exit'; t: number; lines: number | null; nvramCallbacks: number | null; blockedKeys: number | null };

/**
 * What VPX had in force when the hook sampled it (hook 0.4.0 `engine` line: at hook time and at every
 * key-down, written only on change). `reason` is `init` or `key`. Every field is null when that read failed.
 */
export interface EngineSample {
  t: number;
  reason: string | null;
  /**
   * Difficulty 0–1, like the table file's `TDFT` and the ini: the live slope sits at min + difficulty × (max − min).
   * VPX's script property `GlobalDifficulty` is 0–100 (Medieval Madness: file 0.5, live 50, 2026-10-25); the
   * journal keeps VPX's number and the detector divides by 100.
   */
  difficulty: number | null;
  slopeMin: number | null;
  slopeMax: number | null;
  /** `OverridePhysics`: 0 = the table's own physics, 1–8 = a global physics set. */
  physicsSet: number | null;
  gravity: number | null;
  friction: number | null;
  elasticity: number | null;
  elasticityFalloff: number | null;
  scatter: number | null;
  nudgeTime: number | null;
  /** `NudgeGetCalibration`: the in-memory nudge gains, maxima, dead zone and tilt sensitivity. */
  nudge: { xmax: number | null; ymax: number | null; xgain: number | null; ygain: number | null; deadZone: number | null; tilt: number | null } | null;
}

/**
 * A16.2 (recipe A): a byte of the map's `high_scores` block changed in the journal (the machine wrote its high-score
 * list: a new entry, its initials). `entries` is the list as it reads now. Companion-internal: the journal carries
 * only `nvram_delta` / `nvram_full` lines, and only a sidecar whose watch list holds those bytes (recipe A 0.3.2)
 * journals them. Not a game event: it starts, ends and counts nothing.
 */
export interface HighScoreEvent {
  kind: 'high_scores_changed';
  t: number;
  entries: HighScore[];
}

/** A16.2: what `JournalDetector.highScoreCheck` answers about a finished game's score. */
export interface HighScoreCheck {
  /** The score has a place on the table's high-score list. */
  qualifies: boolean;
  /** The list already holds this score (the machine wrote the entry before the question was asked). */
  listed: boolean;
  /** The lowest score still on the list, the earlier games of this sitting counted in; null when no entry has a score. */
  lowest: number | null;
}

/**
 * B26.4 (recipe A): the ROM's own count of Midnight Madness (a feature audit, `midnightEvidence`) went UP while a game
 * was in play: the mode started. `player` / `ball`: where the table's game stood. Companion-internal, like
 * `high_scores_changed`: only a sidecar whose watch list holds the audit's bytes journals them. Never raised for the
 * first sighting of the counter (the baseline), a decrease (an audit reset, a boot's RAM test), or a change with no
 * game in play. Not a game event: it starts, ends and counts nothing.
 */
export interface MidnightEvent {
  kind: 'midnight_madness';
  t: number;
  /** `B.4 31 SPECIAL MODES`. */
  audit: string;
  from: number;
  to: number;
  player: number | null;
  ball: number | null;
}

/**
 * B26.4 (recipe A): the adjustment that enables Midnight Madness reads differently now: at the first NVRAM of the
 * session, and whenever its bytes change after (a boot's RAM test, the operator's menu). `setting` null: it cannot be
 * read right now. Companion-internal.
 */
export interface MidnightSettingEvent {
  kind: 'midnight_setting';
  t: number;
  setting: MidnightSettingReport | null;
}

export type JournalEvent = GameEvent | HookEvent | HighScoreEvent | MidnightEvent | MidnightSettingEvent;

export type GameEventKind = GameEvent['kind'];

/** Where a session stands; what `summary()` reports and what the fixture tests assert on. */
export interface SessionSummary {
  table: string | null;
  recipe: string | null;
  rom: string | null;
  /** Derived or script-emitted game events, by kind. */
  counts: Record<GameEventKind, number>;
  /** Hook lines seen, by event name (`nvram_delta`, `lock`, …). */
  lines: Record<string, number>;
  /** Distinct `ball` values that ended (recipe A: derived; others: as emitted). */
  ballsSeen: number[];
  maxBall: number;
  /** The last game state decoded (recipe A) or the last `current_scores` (others). */
  scores: (number | null)[] | null;
  /** A game is open: started and neither ended nor abandoned. */
  inGame: boolean;
  exited: boolean;
  /** Lines that were not JSON (a torn last line when VPX was killed is normal). */
  torn: number;
  /** Deltas that arrived before any `nvram_full` and could not be applied. */
  orphanDeltas: number;
}

// ------------------------------------------------------------------------------- transition --

const MAX_SCORE = 10 ** 12;

/**
 * Reject decoded states that cannot be a real game: player or ball out of range, scores that are
 * not small non-negative integers. Seen on the owner's rig 2026-10-17: Medieval Madness boots with
 * NVRAM filled 0x55 then 0xAA for ~10 s (`current_player` = 85 / 170), which produced a fake
 * `game_start` / `ball_end` / `game_end` until this guard existed.
 */
export function plausible(st: GameState | null): st is GameState {
  if (!st) return false;
  const p = st.currentPlayer;
  const b = st.currentBall;
  if (p !== null && !(p >= 0 && p <= 4)) return false;
  const ballCount = st.ballCount ?? 5;
  if (b !== null && !(b >= 0 && b <= Math.max(ballCount, 5) + 4)) return false;
  if (st.playerCount !== null && !(st.playerCount >= 0 && st.playerCount <= 4)) return false;
  for (const sc of st.scores) {
    if (sc !== null && (!Number.isInteger(sc) || sc < 0 || sc > MAX_SCORE)) return false;
  }
  return true;
}

function sameScores(a: (number | null)[], b: (number | null)[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Events implied by going from game state `prev` to `cur` (pure):
 *
 * - `game_over` true → false: `game_start`.
 * - a game in progress and the ball went up or the player changed: `ball_end` for the previous
 *   (player, ball). Ball 0 (Data East / WPC between games) never ends.
 * - `game_over` false → true with a ball in play: `ball_end` for the last ball, then `game_end`.
 *   A game that never had a ball in play (ROM boot settling) did not end.
 * - scores changed: `current_scores`.
 *
 * An extra ball (`extra_balls` decrements, ball and player unchanged) fires nothing: the turn goes
 * on. A `cur` that is not `plausible()` fires nothing, and the caller must not keep it as `prev`.
 * Bonus is counted after the drain on both platforms (finding 3), so a ball's final score is
 * never the score at its `ball_end`; take it at the next event.
 */
/** The last (player, ball) seen in play while a game was open: what ends when game over arrives with the ball byte already cleared. */
export interface LastInPlay {
  player: number | null;
  ball: number | null;
  extraBalls: number | null;
}

/**
 * `lastInPlay` (optional): Gottlieb System 3 clears the ball byte about 3.5 s BEFORE it clears the player count
 * the map reads as game over (owner's rig, Cue Ball Wizard, 2026-11-01, `fixtures/nvram/cueball`), so at the game-over
 * step `prev` already shows ball 0 and the old rule ("a ball in play in `prev`") derived neither the last ball end nor
 * the game end; the game then ended as `game_abandoned` at table exit and posted at close (Krobs' Freddy, 2026-10-31).
 * With the caller's last ball in play the end is derived from it. WPC keeps the ball byte at 3 across game over and
 * Data East clears both in one step, so neither path changes for them.
 */
export function detectTransition(prev: GameState | null, cur: GameState, t: number, lastInPlay: LastInPlay | null = null): GameEvent[] {
  const ev: GameEvent[] = [];
  if (!prev || !plausible(cur)) return ev;
  const pgo = prev.gameOver;
  const cgo = cur.gameOver;
  if (pgo === true && cgo === false) ev.push({ kind: 'game_start', t, players: cur.playerCount });
  if (pgo === false) {
    const pb = prev.currentBall;
    const cb = cur.currentBall;
    const pp = prev.currentPlayer;
    const cp = cur.currentPlayer;
    const hadBall = pb !== null && pb >= 1;
    const ballEnd = (): GameEvent => ({ kind: 'ball_end', t, player: pp, ball: pb, extraBalls: prev.extraBalls });
    if (cgo === false && hadBall && ((cb !== null && pb !== null && cb > pb) || (cp !== null && pp !== null && cp !== pp))) {
      ev.push(ballEnd());
    }
    if (cgo === true && hadBall) {
      ev.push(ballEnd());
      ev.push({ kind: 'game_end', t, scores: cur.scores, players: prev.playerCount });
    } else if (cgo === true && lastInPlay && lastInPlay.ball !== null && lastInPlay.ball >= 1) {
      // The ball byte was cleared before game over (System 3): the last ball in play is the one that ended.
      ev.push({ kind: 'ball_end', t, player: lastInPlay.player, ball: lastInPlay.ball, extraBalls: lastInPlay.extraBalls });
      ev.push({ kind: 'game_end', t, scores: cur.scores, players: prev.playerCount });
    }
  }
  if (!sameScores(prev.scores, cur.scores)) {
    ev.push({ kind: 'current_scores', t, scores: cur.scores, player: cur.currentPlayer, ball: cur.currentBall });
  }
  return ev;
}

const allZero = (scores: (number | null)[]): boolean => scores.length > 0 && scores.every((x) => x === 0);
const anyAboveZero = (scores: (number | null)[]): boolean => scores.some((x) => x !== null && x > 0);

/**
 * Stern SAM events from `prev` to `cur` (pure; `docs/design` finding, B10, owner's rig 2026-10-25/26):
 *
 * - every score back to 0 from a game's scores: `game_start` (the attempt). A game still open then was
 *   restarted from the start button: it is `game_abandoned` first.
 * - every score was 0 and one rises with no game open (a fresh NVRAM with no last game): a late
 *   `game_start` at the first points.
 * - the end counter went up by 1–4 with a game open: `game_end` with the scores at that moment and
 *   the rise as the player count (a 2-player game adds 2). The final scores are already written.
 *
 * `prevCount` / `curCount` are the counter before and after; null when its bytes are not in the shadow.
 */
export function samTransition(prev: GameState, cur: GameState, prevCount: number | null, curCount: number | null, open: boolean, t: number): GameEvent[] {
  const ev: GameEvent[] = [];
  if (!plausible(cur)) return ev;
  if (open && prevCount !== null && curCount !== null && curCount !== prevCount) {
    const rise = (curCount - prevCount) >>> 0;
    if (rise >= 1 && rise <= 4) {
      ev.push({ kind: 'game_end', t, scores: cur.scores, players: rise });
      open = false;
    }
  }
  if (allZero(cur.scores) && anyAboveZero(prev.scores)) {
    if (open) ev.push({ kind: 'game_abandoned', t, scores: prev.scores, player: null, ball: null });
    ev.push({ kind: 'game_start', t, players: cur.playerCount });
  } else if (!open && allZero(prev.scores) && anyAboveZero(cur.scores)) {
    ev.push({ kind: 'game_start', t, players: cur.playerCount });
  }
  return ev;
}

/** One Bally / Stern M100 sample: the decoded state (scores = the displays, game over = the lamp) and the last-game scores. */
export interface BallyFrame {
  state: GameState;
  finals: (number | null)[];
}

/**
 * Bally AS-2518-17/-35 and Stern M100 events from `prev` to `cur` (pure; B10.2). Ball, player and player
 * count are CPU RAM there, so the rules use what NVRAM holds: the GAME OVER lamp (`state.gameOver`), the
 * score displays (`state.scores`) and the last-game scores the ROM keeps for attract (`finals`).
 *
 * - **Start**: the lamp is off and every display reads 0 (a new game shows `00` for player 1 and blanks,
 *   which decode as 0, for the rest), and the step got there from the lamp on or from a game's scores.
 *   The two writes may land in either order. A lamp that flickers off during an attract show while the
 *   displays still show the last game, or the high score, starts nothing: the score context is required.
 * - **End**, with a game open: the lamp is on, the last-game scores equal the displays, at least one is
 *   above 0, and they differ from the last-game scores at the start (`finalsAtStart`), first true in this
 *   step. The equality waits out a copy spread over several callbacks; the difference keeps a reset machine
 *   showing the previous game in attract from posting that game again. `players` = final scores above 0
 *   (a player who scored 0 is not counted; there is no player count in reach).
 * - **Quit**: with a game open, the lamp goes off with every display at 0 again (the machine was reset and
 *   a new game started): `game_abandoned` with the last scores, then `game_start`. With the lamp off all
 *   along, displays at 0 mid-game are not a restart (a blanked display must not end a game); leaving the
 *   table is the usual quit and `table_exit` abandons the game.
 *
 * If a ROM never satisfies the end rule, live mode posts nothing for the game and the `.nv` at close does, as
 * before B10.2.
 */
export function ballyTransition(prev: BallyFrame, cur: BallyFrame, open: boolean, finalsAtStart: (number | null)[] | null, t: number): GameEvent[] {
  const ev: GameEvent[] = [];
  if (!plausible(cur.state)) return ev;
  const ended = (f: BallyFrame): boolean =>
    f.state.gameOver === true && anyAboveZero(f.finals) && sameScores(f.finals, f.state.scores) && (finalsAtStart === null || !sameScores(f.finals, finalsAtStart));
  if (open && ended(cur) && !ended(prev)) {
    const players = Math.max(1, cur.finals.filter((x) => x !== null && x > 0).length);
    ev.push({ kind: 'game_end', t, scores: cur.finals, players });
    open = false;
  }
  if (cur.state.gameOver === false && allZero(cur.state.scores)) {
    if (open && prev.state.gameOver === true) {
      ev.push({ kind: 'game_abandoned', t, scores: prev.state.scores, player: null, ball: null });
      ev.push({ kind: 'game_start', t, players: cur.state.playerCount });
    } else if (!open && (prev.state.gameOver === true || anyAboveZero(prev.state.scores))) {
      ev.push({ kind: 'game_start', t, players: cur.state.playerCount });
    }
  }
  return ev;
}

// ---------------------------------------------------------------------------------- detector --

interface RawLine {
  event?: unknown;
  t?: unknown;
  [key: string]: unknown;
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
/** `GlobalDifficulty` (0–100) as the 0–1 fraction everything else uses; four decimals, as the hook writes. */
const percentToFraction = (v: number | null): number | null => (v === null ? null : Math.round(v * 100) / 10000);
const numArray = (v: unknown): (number | null)[] | null => (Array.isArray(v) ? v.map((x) => num(x)) : null);

const GAME_EVENT_KINDS: GameEventKind[] = ['game_start', 'current_scores', 'ball_end', 'game_end', 'game_abandoned'];

function emptyCounts(): Record<GameEventKind, number> {
  return { game_start: 0, current_scores: 0, ball_end: 0, game_end: 0, game_abandoned: 0 };
}

interface Session {
  summary: SessionSummary;
  recipeA: boolean;
  shadow: Uint8Array | null;
  map: CompiledMap | null;
  /** Last plausible decoded state (recipe A). */
  state: GameState | null;
  /** Last `current_scores` with its player and ball (script recipes), for `game_abandoned`. */
  lastPlayer: number | null;
  lastBall: number | null;
  balls: Set<number>;
  /**
   * Recipe A: a `game_start` was seen this session and its game has not ended. A ball or game end
   * needs one. On the owner's rig 2026-10-23 Monster Bash's boot wrote player 1 / ball 1 and then,
   * 59 ms later in a separate callback, game over; without this the stale last game "ended" again.
   */
  started: boolean;
  /** Stern SAM: the end counter's NVRAM offset (`samEndCounter`), null on every other platform. */
  samCounter: number | null;
  /** Stern SAM: the counter's value in the last plausible state. */
  samCount: number | null;
  /** Bally / Stern M100: the map feeds `ballyTransition` (`ballyLiveInputs`); false on every other platform. */
  bally: boolean;
  /** Bally / Stern M100: the last-game scores in the last plausible state. */
  finals: (number | null)[];
  /** Bally / Stern M100: the last-game scores when the open game started (the previous game's). */
  finalsAtStart: (number | null)[] | null;
  /** Recipe A: the last plausible in-game state with a ball in play (`detectTransition`'s `lastInPlay`); null between games. */
  lastInPlay: LastInPlay | null;
  /** A16.2: the NVRAM offsets of the map's `high_scores` block (`highScoreOffsets`); empty without a map or a block. */
  highScoreBytes: Set<number>;
  /**
   * A16.2: the scores of the games that ended in this session, in order. An older sidecar does not journal the
   * high-score bytes, so the shadow keeps the list as it was at table load; these stand in for what the machine
   * wrote since (`highScoreCheck`).
   */
  finished: number[];
  /** B26.4: what this ROM offers about Midnight Madness (`midnightEvidence`); null without a map. */
  midnight: MidnightEvidence | null;
  /** B26.4: the counter's last value; null until its first sighting (the baseline, never an event). */
  midnightCount: number | null;
  /** B26.4: the setting as last announced (`midnight_setting`): on, off, or null (unreadable / not announced yet). */
  midnightOn: boolean | null;
}

export interface JournalDetectorOptions {
  /**
   * Synchronous map lookup used when a recipe-A `table_loaded` names a ROM. Omit it and attach
   * the map with `setMap()` once the (async) corpus has answered.
   */
  mapFor?: (rom: string) => CompiledMap | null;
}

export class JournalDetector {
  private session: Session | null = null;
  private tornBeforeSession = 0;

  constructor(private readonly opts: JournalDetectorOptions = {}) {}

  /** The ROM the current session runs, when it is a recipe-A table that still has no map. */
  get wantsMapFor(): string | null {
    const s = this.session;
    return s && s.recipeA && !s.map && s.summary.rom ? s.summary.rom : null;
  }

  /** The live NVRAM as the journal describes it right now (recipe A), or null. The bytes a live score came from. */
  get shadow(): Uint8Array | null {
    return this.session?.shadow ?? null;
  }

  /** Attach (or clear) the compiled map for the current session's ROM. Decoding starts at once. */
  setMap(map: CompiledMap | null): void {
    const s = this.session;
    if (!s) return;
    s.map = map;
    s.samCounter = map ? samEndCounter(map) : null;
    s.bally = map ? ballyLiveInputs(map) !== null : false;
    s.highScoreBytes = new Set(map ? highScoreOffsets(map) : []);
    s.midnight = map ? midnightEvidence(map, s.summary.rom) : null;
    s.midnightCount = map && s.shadow && s.midnight ? midnightCount(map, s.midnight, s.shadow) : null;
    s.midnightOn = null;
    if (map && s.shadow) {
      s.samCount = this.counterValue(s);
      s.finals = this.finalsValue(s);
      const st = decodeGameState(map, s.shadow);
      s.state = plausible(st) ? st : null;
      s.summary.scores = s.state ? s.state.scores : null;
    }
  }

  /**
   * A16.2: does `score`, the final score of a game on this table, have a place on the machine's high-score list?
   * The list is the map's `high_scores` read from the shadow (as of table load with an older sidecar, live with one
   * that journals those bytes), with the scores of this session's earlier games put in where the shadow does not
   * show them and the list cut back to its length. Null: no way to tell (not a ROM table, no map, no `high_scores`,
   * no NVRAM yet), which the caller takes as "does not qualify". A tie does not qualify.
   */
  highScoreCheck(score: number): HighScoreCheck | null {
    const s = this.session;
    if (!s || !s.recipeA || !s.map || !s.shadow || s.map.highScores.length === 0) return null;
    const listed = decodeHighScores(s.map, s.shadow)
      .map((h) => h.score)
      .filter((x): x is number => x !== null);
    if (listed.length === 0) return null;
    const sorted = [...listed].sort((a, b) => b - a);
    if (!(Number.isFinite(score) && score > 0)) return { qualifies: false, listed: false, lowest: sorted[sorted.length - 1] ?? null };
    if (listed.includes(score)) return { qualifies: true, listed: true, lowest: sorted[sorted.length - 1] ?? null };
    // The game asked about may already be among the finished ones (its `game_end` came with its last ball): leave one out.
    const earlier = [...s.finished];
    const own = earlier.lastIndexOf(score);
    if (own >= 0) earlier.splice(own, 1);
    const merged = [...listed, ...earlier.filter((x) => !listed.includes(x))].sort((a, b) => b - a).slice(0, listed.length);
    const lowest = merged[merged.length - 1] ?? null;
    return { qualifies: lowest !== null && score > lowest, listed: false, lowest };
  }

  /**
   * B26.4: the Midnight Madness setting on this table as the journal's NVRAM reads right now; null when it cannot be
   * told (not a ROM table, no map, a ROM with no known setting, no NVRAM yet, or bytes that are neither YES nor NO).
   */
  get midnightSetting(): MidnightSettingReport | null {
    const s = this.session;
    if (!s || !s.recipeA || !s.map || !s.shadow || !s.midnight?.setting) return null;
    const enabled = midnightEnabled(s.map, s.midnight, s.shadow);
    return enabled === null ? null : { enabled, adjustment: s.midnight.setting.name };
  }

  /** B26.4: the audit that counts Midnight Madness on this session's ROM (`B.4 31 SPECIAL MODES`); null = not monitored. */
  get midnightCounter(): string | null {
    return this.session?.midnight?.counter?.name ?? null;
  }

  summary(): SessionSummary | null {
    return this.session ? { ...this.session.summary, counts: { ...this.session.summary.counts }, lines: { ...this.session.summary.lines }, ballsSeen: [...this.session.balls].sort((a, b) => a - b) } : null;
  }

  /** One journal line in, the events it implies out. Blank and torn lines yield nothing. */
  feed(raw: string): JournalEvent[] {
    const line = raw.trim();
    if (!line) return [];
    let e: RawLine;
    try {
      e = JSON.parse(line) as RawLine;
    } catch {
      if (this.session) this.session.summary.torn++;
      else this.tornBeforeSession++;
      return [];
    }
    if (typeof e !== 'object' || e === null) return [];
    const event = str(e.event);
    const t = num(e.t) ?? 0;
    if (event === 'table_loaded') return this.startSession(e, t);
    const s = this.session;
    if (!s || !event) return [];
    s.summary.lines[event] = (s.summary.lines[event] ?? 0) + 1;

    switch (event) {
      case 'nvram_hook':
        return [{ kind: 'nvram_hook', t, chained: bool(e.chained), useNvram: e.use_nvram === undefined ? null : String(e.use_nvram) }];
      case 'nvram_full':
        return this.onFull(s, e, t);
      case 'nvram_delta':
        return this.onDelta(s, e, t);
      case 'game_start':
      case 'current_scores':
      case 'ball_end':
      case 'game_end':
        return this.onScriptEvent(s, event, e, t);
      case 'lock':
        return [{ kind: 'lock', t, locked: bool(e.locked) }];
      case 'key_blocked':
        return [{ kind: 'key_blocked', t, key: num(e.key) }];
      case 'warn':
        return [{ kind: 'warn', t, msg: str(e.msg), err: str(e.err) }];
      case 'stale_sidecar':
        return [{ kind: 'stale_sidecar', t, detail: str(e.detail) ?? str(e.msg) }];
      case 'embedded_patch':
        return [{ kind: 'embedded_patch', t, original: str(e.original) }];
      case 'engine': {
        const n = typeof e.nudge === 'object' && e.nudge !== null ? (e.nudge as Record<string, unknown>) : null;
        return [{
          kind: 'engine',
          t,
          sample: {
            t,
            reason: str(e.reason),
            difficulty: percentToFraction(num(e.difficulty)),
            slopeMin: num(e.slope_min),
            slopeMax: num(e.slope_max),
            physicsSet: num(e.physics_set),
            gravity: num(e.gravity),
            friction: num(e.friction),
            elasticity: num(e.elasticity),
            elasticityFalloff: num(e.elasticity_falloff),
            scatter: num(e.scatter),
            nudgeTime: num(e.nudge_time),
            nudge: n ? { xmax: num(n['xmax']), ymax: num(n['ymax']), xgain: num(n['xgain']), ygain: num(n['ygain']), deadZone: num(n['dead_zone']), tilt: num(n['tilt']) } : null,
          },
        }];
      }
      case 'table_exit':
        return this.onExit(s, e, t);
      default:
        return [];
    }
  }

  private startSession(e: RawLine, t: number): JournalEvent[] {
    const rom = str(e.rom);
    const recipe = str(e.recipe);
    const summary: SessionSummary = {
      table: str(e.table),
      recipe,
      rom: rom && rom.length > 0 ? rom : null,
      counts: emptyCounts(),
      lines: { table_loaded: 1 },
      ballsSeen: [],
      maxBall: 0,
      scores: null,
      inGame: false,
      exited: false,
      torn: this.tornBeforeSession,
      orphanDeltas: 0,
    };
    this.tornBeforeSession = 0;
    const recipeA = recipe === 'A';
    const map = recipeA && summary.rom && this.opts.mapFor ? this.opts.mapFor(summary.rom) : null;
    this.session = { summary, recipeA, shadow: null, map, state: null, lastPlayer: null, lastBall: null, balls: new Set(), started: false, samCounter: map ? samEndCounter(map) : null, samCount: null, bally: map ? ballyLiveInputs(map) !== null : false, finals: [], finalsAtStart: null, lastInPlay: null, highScoreBytes: new Set(map ? highScoreOffsets(map) : []), finished: [], midnight: map ? midnightEvidence(map, summary.rom) : null, midnightCount: null, midnightOn: null };
    return [
      {
        kind: 'table_loaded',
        t,
        table: summary.table,
        recipe,
        recipeVersion: str(e.recipe_version),
        rom: summary.rom,
        lib: str(e.lib),
        session: str(e.session),
        locked: bool(e.locked),
      },
    ];
  }

  private onFull(s: Session, e: RawLine, t: number): JournalEvent[] {
    if (!Array.isArray(e.bytes)) return [];
    const before = s.shadow;
    s.shadow = Uint8Array.from(e.bytes, (x) => Number(x) & 0xff);
    if (!s.map) return [];
    const cur = decodeGameState(s.map, s.shadow);
    // The FIRST state is a baseline, never an event: a game already in progress when the hook
    // attached has no observed start, and the boot pattern is simply ignored. A later periodic
    // snapshot is ground truth and goes through the same transition as a delta would, so a change
    // that a dropped delta hid is still seen.
    const wasInGame = s.summary.inGame;
    const game = this.observed(s, s.state ? this.transition(s, s.state, cur, t) : []);
    for (const ev of game) this.record(s, ev);
    const events: JournalEvent[] = [...game];
    // A16.2: a later snapshot that differs in the high-score block (never the first one: that is the baseline).
    if (before) {
      const shadow = s.shadow;
      let changed = false;
      for (const off of s.highScoreBytes) if (before[off] !== shadow[off]) changed = true;
      if (changed) events.push(this.highScoresChanged(s, t));
    }
    events.push(...this.midnightEvents(s, t, wasInGame));
    if (plausible(cur)) {
      s.state = cur;
      s.samCount = this.counterValue(s);
      s.finals = this.finalsValue(s);
      s.summary.scores = cur.scores;
      this.noteInPlay(s, cur);
    }
    return events;
  }

  private onDelta(s: Session, e: RawLine, t: number): JournalEvent[] {
    if (!s.shadow) {
      s.summary.orphanDeltas++;
      return [];
    }
    let highScores = false;
    if (Array.isArray(e.d)) {
      for (const triple of e.d) {
        if (!Array.isArray(triple)) continue;
        const index = Number(triple[0]);
        if (index >= 0 && index < s.shadow.length) {
          const value = Number(triple[1]) & 0xff;
          if (s.shadow[index] !== value && s.highScoreBytes.has(index)) highScores = true;
          s.shadow[index] = value;
        }
      }
    }
    if (!s.map) return [];
    const cur = decodeGameState(s.map, s.shadow);
    const wasInGame = s.summary.inGame;
    const game = this.observed(s, s.state ? this.transition(s, s.state, cur, t) : []);
    for (const ev of game) this.record(s, ev);
    const events: JournalEvent[] = [...game];
    // A16.2: after the game events of the same line, so a game end that comes with the write is heard first.
    if (highScores) events.push(this.highScoresChanged(s, t));
    events.push(...this.midnightEvents(s, t, wasInGame));
    if (!plausible(cur)) return events;
    if (cur.currentBall !== null && cur.currentBall > s.summary.maxBall) s.summary.maxBall = cur.currentBall;
    s.state = cur;
    s.samCount = this.counterValue(s);
    s.finals = this.finalsValue(s);
    s.summary.scores = cur.scores;
    this.noteInPlay(s, cur);
    return events;
  }

  /** A16.2: the high-score list as the shadow reads now (only called with a map and a shadow). */
  private highScoresChanged(s: Session, t: number): HighScoreEvent {
    return { kind: 'high_scores_changed', t, entries: s.map && s.shadow ? decodeHighScores(s.map, s.shadow) : [] };
  }

  /**
   * B26.4: what the NVRAM as it stands after this line says about Midnight Madness (only called with a map and a
   * shadow). The counter: its first sighting is the baseline; after that a higher value while a game is in play
   * (open before this line or after it) is the mode starting; a lower one (an audit reset, the 0x55 / 0xAA fill of a
   * boot's RAM test, which happens with no game open) and any change between games only move the baseline. The
   * setting: announced when its reading changes.
   */
  private midnightEvents(s: Session, t: number, wasInGame: boolean): JournalEvent[] {
    const m = s.midnight;
    if (!m || !s.map || !s.shadow) return [];
    const out: JournalEvent[] = [];
    if (m.counter) {
      const now = midnightCount(s.map, m, s.shadow);
      const was = s.midnightCount;
      if (now !== null) {
        if (was !== null && now > was && (wasInGame || s.summary.inGame)) {
          const at = s.lastInPlay ?? { player: s.state?.currentPlayer ?? null, ball: s.state?.currentBall ?? null };
          out.push({ kind: 'midnight_madness', t, audit: m.counter.name, from: was, to: now, player: at.player, ball: at.ball });
        }
        s.midnightCount = now;
      }
    }
    if (m.setting) {
      const on = midnightEnabled(s.map, m, s.shadow);
      if (on !== s.midnightOn) {
        s.midnightOn = on;
        out.push({ kind: 'midnight_setting', t, setting: on === null ? null : { enabled: on, adjustment: m.setting.name } });
      }
    }
    return out;
  }

  /** Remember the ball in play while the game is open, so a game over that arrives after the ball byte was cleared still ends it. */
  private noteInPlay(s: Session, cur: GameState): void {
    if (s.started && cur.gameOver === false && cur.currentBall !== null && cur.currentBall >= 1) {
      s.lastInPlay = { player: cur.currentPlayer, ball: cur.currentBall, extraBalls: cur.extraBalls };
    }
  }

  /**
   * Recipe A events from one state to the next: the shared rules; on Stern SAM the NVRAM-only ones first; on
   * Bally / Stern M100 the lamp rules, with only `current_scores` kept from the shared ones (their lamp-driven
   * `game_start` would fire on every attract flicker).
   */
  private transition(s: Session, prev: GameState, cur: GameState, t: number): GameEvent[] {
    const generic = detectTransition(prev, cur, t, s.lastInPlay);
    if (s.bally) {
      const finals = this.finalsValue(s);
      const ev = ballyTransition({ state: prev, finals: s.finals }, { state: cur, finals }, s.started, s.finalsAtStart, t);
      if (ev.some((e) => e.kind === 'game_start')) s.finalsAtStart = finals;
      return [...ev, ...generic.filter((e) => e.kind === 'current_scores')];
    }
    if (s.samCounter === null) return generic;
    return [...samTransition(prev, cur, s.samCount, this.counterValue(s), s.started, t), ...generic];
  }

  /** Stern SAM: the end counter as a u32 little-endian from the shadow, or null. */
  private counterValue(s: Session): number | null {
    const o = s.samCounter;
    const b = s.shadow;
    if (o === null || !b || o + 4 > b.length) return null;
    return ((b[o] as number) | ((b[o + 1] as number) << 8) | ((b[o + 2] as number) << 16) | ((b[o + 3] as number) << 24)) >>> 0;
  }

  /** Bally / Stern M100: the last-game scores from the shadow, or none. */
  private finalsValue(s: Session): (number | null)[] {
    return s.bally && s.map && s.shadow ? (decodeFinalScores(s.map, s.shadow) ?? []) : [];
  }

  /** Recipe A: drop a ball or game end from a game whose start this session never saw (see `Session.started`). */
  private observed(s: Session, events: GameEvent[]): GameEvent[] {
    const out: GameEvent[] = [];
    for (const ev of events) {
      if ((ev.kind === 'ball_end' || ev.kind === 'game_end') && !s.started) continue;
      if (ev.kind === 'game_start') {
        s.started = true;
        s.lastInPlay = null;
      }
      if (ev.kind === 'game_end' || ev.kind === 'game_abandoned') {
        s.started = false;
        s.lastInPlay = null;
      }
      out.push(ev);
    }
    return out;
  }

  private onScriptEvent(s: Session, event: 'game_start' | 'current_scores' | 'ball_end' | 'game_end', e: RawLine, t: number): JournalEvent[] {
    let ev: GameEvent;
    switch (event) {
      case 'game_start':
        ev = { kind: 'game_start', t, players: num(e.players) };
        break;
      case 'current_scores':
        ev = { kind: 'current_scores', t, scores: numArray(e.scores) ?? [], player: num(e.player), ball: num(e.ball) };
        s.lastPlayer = ev.player;
        s.lastBall = ev.ball;
        break;
      case 'ball_end':
        ev = { kind: 'ball_end', t, player: num(e.player), ball: num(e.ball), extraBalls: num(e.extra_balls) };
        break;
      case 'game_end':
        ev = { kind: 'game_end', t, scores: numArray(e.scores) ?? [], players: num(e.players) };
        break;
    }
    this.record(s, ev);
    return [ev];
  }

  private onExit(s: Session, e: RawLine, t: number): JournalEvent[] {
    const out: JournalEvent[] = [];
    if (s.summary.inGame) {
      const abandoned: GameEvent = s.recipeA
        ? { kind: 'game_abandoned', t, scores: s.state?.scores ?? [], player: s.state?.currentPlayer ?? null, ball: s.state?.currentBall ?? null }
        : { kind: 'game_abandoned', t, scores: s.summary.scores ?? [], player: s.lastPlayer, ball: s.lastBall };
      this.record(s, abandoned);
      out.push(abandoned);
    }
    s.summary.exited = true;
    out.push({ kind: 'table_exit', t, lines: num(e.lines), nvramCallbacks: num(e.nvram_callbacks), blockedKeys: num(e.blocked_keys) });
    return out;
  }

  private record(s: Session, ev: GameEvent): void {
    s.summary.counts[ev.kind]++;
    switch (ev.kind) {
      case 'game_start':
        s.summary.inGame = true;
        break;
      case 'current_scores':
        s.summary.scores = ev.scores;
        break;
      case 'ball_end':
        if (ev.ball !== null) {
          s.balls.add(ev.ball);
          if (ev.ball > s.summary.maxBall) s.summary.maxBall = ev.ball;
        }
        break;
      case 'game_end':
        s.summary.scores = ev.scores;
        s.summary.inGame = false;
        // A16.2: what this sitting's finished games put on the machine's high-score list (`highScoreCheck`).
        for (const x of ev.scores) if (x !== null && x > 0) s.finished.push(x);
        break;
      case 'game_abandoned':
        s.summary.inGame = false;
        break;
    }
  }
}

/** Replay whole journals (tests, tooling, `--check`): every event from every line, in order. */
export function replayDetector(lines: Iterable<string>, opts: JournalDetectorOptions = {}): { events: JournalEvent[]; detector: JournalDetector } {
  const detector = new JournalDetector(opts);
  const events: JournalEvent[] = [];
  for (const line of lines) events.push(...detector.feed(line));
  return { events, detector };
}

export { GAME_EVENT_KINDS };
