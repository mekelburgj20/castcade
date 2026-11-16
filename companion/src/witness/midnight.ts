/**
 * B26 step 1 (2026-11-16): flag Midnight Madness. The owner: "a midnight madness happened for Krobs which is a really
 * unfair advantage. We need to monitor for this somehow and either disable it or flag it."
 *
 * Williams / Bally WPC games (from about 1994) start a bonus multiball when the machine's real-time clock passes
 * midnight with a ball in play. VPinMAME takes that clock from the PC, so it happens at each player's own LOCAL
 * midnight: in a match one player may get it and the other not. Stock VPX cannot hold the clock, so this step only
 * flags: a ball (a match) or a game (a solo score) whose play time contains a local midnight on a WPC machine "may
 * have run" it. Never more than "may": which WPC titles have the mode is not in the maps corpus (a midnight audit
 * exists for a handful of ROMs only, and FunHouse's "MIDNIGHT GAMES" counts its in-game clock, not this), and the
 * hook does not journal those bytes. A flag only: it never changes a score, a turn or a result.
 *
 * Pure: the clock and the PC's UTC offset are passed in (`localUtcOffsetMinutes` is what the shell passes).
 */
import type { CompiledMap } from './maps.js';

const DAY_MS = 86_400_000;

/** The PC's offset from UTC, in minutes east (local = UTC + offset), fixed or as it stands at an instant (DST). */
export type UtcOffset = number | ((epochMs: number) => number);

/**
 * The scope rule: the ROM's map is on a WPC platform (the corpus's `platforms/williams-wpc-*.json`, by the map's
 * `_metadata.platform`). No list of titles: a ROM with no map, or a map on any other platform, is out of scope.
 */
export const MIDNIGHT_PLATFORM = /^williams-wpc(-|$)/;

export function midnightInScope(map: Pick<CompiledMap, 'platform'> | null | undefined): boolean {
  return !!map && MIDNIGHT_PLATFORM.test(map.platform.name);
}

const offsetAt = (offset: UtcOffset, epochMs: number): number => {
  const m = typeof offset === 'function' ? offset(epochMs) : offset;
  return Number.isFinite(m) ? m : 0;
};

/** The local calendar day an instant falls on, as a day count (only differences mean anything). */
function localDay(epochMs: number, offset: UtcOffset): number {
  return Math.floor((epochMs + offsetAt(offset, epochMs) * 60_000) / DAY_MS);
}

/**
 * Does the local wall clock pass a midnight during [startMs, endMs] (epoch ms)? True when the interval ends on a later
 * local day than it starts on: a midnight M with start < M <= end. An interval that starts exactly at 00:00:00.000 has
 * not passed that midnight; one that ends exactly there has. Zero-length, reversed and non-finite intervals: false.
 * `offset` is read at each end, so a DST change inside the interval is the caller's function's business.
 */
export function spansLocalMidnight(startMs: number, endMs: number, offset: UtcOffset): boolean {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return false;
  return localDay(endMs, offset) > localDay(startMs, offset);
}

/** This PC's offset from UTC at an instant, minutes east (what VPinMAME's clock follows). The shell's `UtcOffset`. */
export function localUtcOffsetMinutes(epochMs: number): number {
  return -new Date(epochMs).getTimezoneOffset();
}

/** The witness's capture detail and log wording for a solo game. */
export const MIDNIGHT_GAME_NOTE = 'Midnight Madness may have run (local midnight passed during the game)';
