/**
 * Runner hints for the originals' live validation (`validate-original.ts`): what `autoplay.py` has to do on one table
 * beyond credit, Start and plunging, as DATA. One record per table family, matched by its file name; each says why,
 * with the evidence. Nothing here changes a patch: a hint only teaches the unattended runner to drive a game the way
 * a player would. The same hints apply in a `--all` run and a single-table run.
 *
 * What needs NO hint (the runner does it for every table):
 * - a Start press the table ignored (a boot or intro sequence still running): Start is pressed again until the
 *   journal holds the game start;
 * - a FlexDMD / UltraDMD project folder beside the table: staged with the copy (`resourceFolders` in
 *   `src/patcher/validate.ts`). `folders` below is for a folder that rule cannot see.
 */

/** A key `autoplay.py` knows by name (its scancode comes from the ini copy the runner writes). */
export type RunnerKey = 'start' | 'plunge' | 'credit' | 'lflip' | 'rflip';

export interface RunnerHint {
  /** Case-insensitive part of the table's file name (without `.vpx`). */
  match: string;
  /** The evidence: what the table does and where it was seen. */
  why: string;
  /** Keys pressed after Start, in order, each `seconds` after the step before it (a menu the table opens on Start). */
  afterStart?: readonly { seconds: number; key: RunnerKey }[];
  /** A longer time budget for one game, in minutes (the larger of this and `--minutes` is used). */
  minutes?: number;
  /** Seconds to wait after `table_loaded` before the first key (default 8). */
  settleSeconds?: number;
  /** Folders beside the original to stage beside the copy, by name. */
  folders?: readonly string[];
}

export const RUNNER_HINTS: readonly RunnerHint[] = [
  {
    match: 'diablo 2',
    why:
      'Start opens a difficulty / lobby screen (StartGame sets DifficultySelectActive) and the ball is served only by a second Start (the key handler\'s "ElseIf keycode = StartGameKey" branch calls LaunchNextBall). 2026-11-12, both versions: game_start at 9 s, then 71 plunges into the menu and no ball; the table\'s own trace shows one "down 2" and no LaunchNextBall.',
    afterStart: [{ seconds: 4, key: 'start' }],
  },
  {
    match: 'smgp',
    why:
      'Start opens a character select (ResetForNewGame ends with PlayerSelectActive = True; every key then goes to SelectPlayerStart) and a second Start picks the character shown and schedules ResetForNewGame2, which serves the ball. 2026-11-12: game_start at 10 s, no score and no ball end in 8 minutes.',
    afterStart: [{ seconds: 4, key: 'start' }],
  },
];

/** The hints for a table, merged in list order (a later record's value wins; `afterStart` and `folders` add up). */
export function hintFor(tableName: string, hints: readonly RunnerHint[] = RUNNER_HINTS): Omit<RunnerHint, 'match' | 'why'> & { why: string[] } {
  const name = tableName.toLowerCase();
  const hit = hints.filter((h) => name.includes(h.match.toLowerCase()));
  const minutes = hit.map((h) => h.minutes).filter((m): m is number => m !== undefined);
  const settle = hit.map((h) => h.settleSeconds).filter((m): m is number => m !== undefined);
  return {
    why: hit.map((h) => h.why),
    afterStart: hit.flatMap((h) => h.afterStart ?? []),
    folders: [...new Set(hit.flatMap((h) => h.folders ?? []))],
    ...(minutes.length > 0 ? { minutes: Math.max(...minutes) } : {}),
    ...(settle.length > 0 ? { settleSeconds: settle[settle.length - 1] as number } : {}),
  };
}

/** `afterStart` as `autoplay.py --after-start` takes it: `4:start,1.5:plunge`. */
export function afterStartArg(steps: readonly { seconds: number; key: RunnerKey }[]): string {
  return steps.map((s) => `${s.seconds}:${s.key}`).join(',');
}
