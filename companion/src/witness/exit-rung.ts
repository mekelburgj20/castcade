/**
 * C11 (2026-10-31): why a score was read only when the table closed (`reason=exit_sample`, basic mode) instead of
 * game by game from the hook's journal. Krobs' Freddy posted at VPX exit and the companion could not say why; every
 * such case falls on one rung of this ladder, and this module names it in one vocabulary for the capture detail,
 * the log, Status and the balloon:
 *
 * - (a) `not_patched`: no Castcade patch beside the table, and the import would patch it (a table added after the
 *   last "Patch my tables", or one an older build skipped for lack of a recipe). Patch now fixes it.
 * - (b) `unreadable` / `no_map`: the machine's live score is out of the hook's reach (`liveSupport` says no: fields in
 *   CPU RAM, or no map for the ROM). Patched or not, at most one score posts, at close (B12).
 * - (c) `no_recipe`: an original whose script has no recipe yet (class E), or a script the classifier refuses (X).
 * - (d) `partial`: a recipe B/C/D patch rendered partial on this script (no score, game start or game end anchor;
 *   the manifest's `partial`), so the journal cannot carry a whole game.
 * - (e) identity not pinned (ROM / VPS): never a cause of posting at close; the `witness: identity …` log lines cover it.
 * - (f1) `hook_silent`: a patch sits beside the table (or inside it, C10) but no `table_loaded` of this VPX process
 *   arrived: VPX ran the table's own script (a copy launched from elsewhere, or the sidecar was not picked up).
 * - (f2) `no_game_end`: the hook reported in, the map was attached, and the detector saw no game end; the detail
 *   carries the journal counts and the last decoded state so a tester's `companion.log` alone answers it.
 * - `no_table_file` / `script_unread`: Castcade could not find the table file, or read its script, to tell.
 *
 * Pure: the witness gathers the facts (it keeps `liveSupport` the single truth about readability) and this only words them.
 */
import { describeClass, type ScriptClass } from '../patcher/classify.js';
import type { SessionSummary } from './journal-detector.js';
import type { GameState } from './maps.js';

export type ExitRungKind = 'not_patched' | 'unreadable' | 'no_map' | 'no_recipe' | 'partial' | 'hook_silent' | 'no_game_end' | 'no_table_file' | 'script_unread';

/** The ladder's letter for each kind (`?` = Castcade could not tell). */
export const EXIT_RUNG_LETTER: Record<ExitRungKind, 'a' | 'b' | 'c' | 'd' | 'f1' | 'f2' | '?'> = {
  not_patched: 'a',
  unreadable: 'b',
  no_map: 'b',
  no_recipe: 'c',
  partial: 'd',
  hook_silent: 'f1',
  no_game_end: 'f2',
  no_table_file: '?',
  script_unread: '?',
};

/** What the witness learned of a table opened with no Castcade patch (basic mode), when the table was known. */
export interface UnpatchedFacts {
  /** The script's class; null when the script could not be read. */
  cls: ScriptClass | null;
  /** The classifier's reason for class X, when it gave one. */
  clsReason: string | null;
  rom: string | null;
  /** The import would patch this table (a recipe exists and, for a ROM table, `liveSupport` says readable). */
  patchable: boolean;
  /** `liveSupport` for a ROM table's map; null when not asked (no ROM, or an original). */
  support: { readable: boolean; reason: string } | null;
  /** The corpus has no map for `rom`. */
  noMap: boolean;
  /** A manifest exists for the table (it was patched once and the sidecar is gone or disabled). */
  hadManifest: boolean;
  /**
   * C11.2: the manifest's sidecar is missing, no `.stale` copy sits beside the table, and the table file is as the
   * manifest recorded it: another program removed the patch (the owner's rig 2026-11-01: Windows Defender quarantined
   * one rendered `.vbs`). Patch now writes it again, and it will be removed again until the player allows it.
   */
  patchRemoved: boolean;
}

/** What live mode saw: the hook's journal followed while the table was open. */
export interface LiveFacts {
  /** False when the patch is the table's own script (C10) rather than a sidecar beside it. */
  sidecar: boolean;
  /** A `table_loaded` of this VPX process arrived. */
  loaded: boolean;
  lib: string | null;
  recipe: string | null;
  recipeVersion: string | null;
  rom: string | null;
  /** `liveSupport`'s reason when the machine cannot be read live; null when it can. */
  unreadable: string | null;
  noMap: boolean;
  /** The manifest's partial-recipe warnings (d); empty when whole or unknown. */
  partial: string[];
  summary: SessionSummary | null;
  /** The last decoded game state of the journal's shadow NVRAM (recipe A with a map), or null. */
  state: GameState | null;
}

export interface ExitRungInput {
  table: string;
  live: LiveFacts | null;
  unpatched: UnpatchedFacts | null;
}

export interface ExitRung {
  kind: ExitRungKind;
  rung: (typeof EXIT_RUNG_LETTER)[ExitRungKind];
  /** The why, for the capture detail and the log (after `exit_sample: `). */
  detail: string;
  /** One sentence for the player (Status): what happened and what to do. */
  note: string;
  /** True when Patch now (or Patch my tables) fixes it. */
  patchable: boolean;
}

/** `gottlieb-system80: scores in CPU RAM` → `live score not readable on gottlieb-system80 (scores in CPU RAM)`. */
function unreadableDetail(reason: string): string {
  const i = reason.indexOf(': ');
  return i > 0 ? `live score not readable on ${reason.slice(0, i)} (${reason.slice(i + 2)})` : `live score not readable (${reason})`;
}

const num = (v: number | null | undefined): string => (v === null || v === undefined ? '?' : String(v));

function stateText(state: GameState | null, summary: SessionSummary | null): string {
  if (state) {
    const over = state.gameOver === true ? 'game over' : state.gameOver === false ? 'in game' : 'game over unknown';
    return `last state scores [${state.scores.map(num).join(',')}] ball ${num(state.currentBall)} player ${num(state.currentPlayer)} ${over}`;
  }
  if (summary?.scores) return `last scores [${summary.scores.map(num).join(',')}]`;
  return 'no state decoded';
}

/** The (f2) detail: what the journal held, in counts, and where the game stood when the table closed. */
export function journalFacts(live: LiveFacts): string {
  const s = live.summary;
  const lines = s?.lines ?? {};
  const parts = [`hook ${live.lib ?? '?'}`, `recipe ${live.recipe ?? '?'}${live.recipeVersion ? ` ${live.recipeVersion}` : ''}`];
  if (live.recipe === 'A') parts.push(`${lines['nvram_full'] ?? 0} nvram_full`, `${lines['nvram_delta'] ?? 0} nvram_delta`, `${s?.orphanDeltas ?? 0} orphan`);
  else {
    const total = Object.values(lines).reduce((a, b) => a + b, 0);
    parts.push(`${total} journal lines`, `${s?.counts.current_scores ?? 0} current_scores`);
  }
  const tail = [`game_start seen: ${(s?.counts.game_start ?? 0) > 0 ? 'yes' : 'no'}`];
  if ((s?.counts.ball_end ?? 0) > 0) tail.push(`${s?.counts.ball_end} ball_end`);
  tail.push(stateText(live.state, s));
  return `${parts.join(', ')}; ${tail.join('; ')}`;
}

/** Name the rung a close-time capture fell on, from what the session knew. */
export function exitRungFor(input: ExitRungInput): ExitRung {
  const { table, live, unpatched } = input;
  const make = (kind: ExitRungKind, detail: string, todo: string, patchable = false): ExitRung => ({
    kind,
    rung: EXIT_RUNG_LETTER[kind],
    detail,
    note: `${table}: only the score at close was read, not every game, because ${todo}`,
    patchable,
  });
  if (live) {
    if (!live.loaded) {
      return live.sidecar
        ? make('hook_silent', "sidecar present but the hook never reported in (VPX ran the table's own script?)", 'the Castcade patch beside it never reported in. Open the table from the folder Castcade patched (not a copy elsewhere), then reopen it.')
        : make('hook_silent', 'the patch inside the table never reported in', 'the Castcade patch inside it never reported in. Reopen the table; if it happens again, send companion.log.');
    }
    if (live.unreadable !== null) {
      return live.noMap
        ? make('no_map', `no map for ROM ${live.rom ?? '?'}`, `Castcade has no NVRAM map for ROM ${live.rom ?? '?'} yet. Nothing to do yet.`)
        : make('unreadable', unreadableDetail(live.unreadable), `this machine's live score can't be read yet (${live.unreadable}). Nothing to do yet.`);
    }
    if (live.partial.length > 0) {
      return make('partial', `the Castcade patch is partial on this script (${live.partial.join('; ')})`, `Castcade's patch for this table is partial (${live.partial.join('; ')}). Nothing to do yet; companion.log has the detail.`);
    }
    return make('no_game_end', `live mode followed the journal (${journalFacts(live)}) and saw no game end`, 'live mode saw no game end in the journal. Reopen the table and play again; if it happens again, send companion.log.');
  }
  if (!unpatched) return make('no_table_file', 'table file not found, so its patch could not be checked', 'Castcade could not find the table file to check its patch. Set the tables folder in Settings.');
  const { cls, rom } = unpatched;
  if (cls === null) return make('script_unread', "table not patched; its script could not be read", "Castcade could not read the table's script.");
  if (unpatched.patchable) {
    const what = `${describeClass(cls)}${cls === 'A' ? `, ROM ${rom ?? '?'}` : ''}`;
    if (unpatched.patchRemoved) {
      return make(
        'not_patched',
        `table not patched (its earlier patch was removed from disk by another program, most likely an antivirus quarantine of the .vbs; the import would patch it: ${what})`,
        'its Castcade patch was removed from disk after it was written, most likely by an antivirus quarantine of the .vbs beside the table. Allow it in Windows Security → Protection history, then press Patch now and reopen the table.',
        true,
      );
    }
    return make(
      'not_patched',
      `table not patched (${unpatched.hadManifest ? 'its earlier patch is gone' : 'new file'}; the import would patch it: ${what})`,
      'it is not patched. Press Patch now, then reopen the table so every game posts live.',
      true,
    );
  }
  if (unpatched.support && !unpatched.support.readable) {
    return unpatched.noMap
      ? make('no_map', `no map for ROM ${rom ?? '?'}`, `Castcade has no NVRAM map for ROM ${rom ?? '?'} yet. Nothing to do yet.`)
      : make('unreadable', unreadableDetail(unpatched.support.reason), `this machine's live score can't be read yet (${unpatched.support.reason}). Nothing to do yet.`);
  }
  return make(
    'no_recipe',
    `not patched; no recipe for this script (class ${cls}${cls === 'X' && unpatched.clsReason ? `: ${unpatched.clsReason}` : ''})`,
    `its script type has no recipe yet (class ${cls}). Nothing to do yet.`,
  );
}
