/**
 * I11.4.1 (2026-11-16, ADR 0011): the VPX instances Castcade starts as 3D watch WATCHERS, which the witness must not
 * see. A watcher loads the player's table but runs no script, no physics and no VPinMAME: to the witness it looks like
 * a game being opened (a launch report to ArcAid, a "Patch now" balloon, a "skipped" capture and a close report at
 * exit, the remembered VPX exe overwritten). The process watch asks `hides` the first time a VPX pid appears
 * (`ProcessWatchOptions.hide`), before anything else in the witness acts on it, and a hidden pid stays invisible.
 *
 * The watch host knows the pid only once the spawn returned, and the process watch polls on its own: so the watcher is
 * EXPECTED before the spawn (its exe and its `-Play` table), and a VPX process that matches it (that exe, that table,
 * started no earlier than the expectation, give or take `START_SLACK_MS`) is claimed by it, whether the pid was bound
 * yet or not. Bound to a pid, it claims that pid alone. One expectation claims one process. An expectation no process
 * matched within `UNBOUND_TTL_MS` lapses (the spawn failed); `done()` ends one (the watcher closed).
 *
 * A 3D watch PLAYER is not expected here: it is an ordinary game (scored as any solo game), and only its exe is never
 * remembered (`isForkExe`, process-watch.ts).
 */
import { parsePlayArg, type ProcessInfo } from './process-watch.js';

/** An expectation no process matched for this long lapses. */
export const UNBOUND_TTL_MS = 30_000;
/** A process start this much before the expectation still matches it (clock steps, the query's own rounding). */
export const START_SLACK_MS = 5_000;

export interface ExpectedVpx {
  /** The exe the spawn starts, full path. */
  exe: string;
  /** The `.vpx` given to `-Play`. */
  tablePath: string;
}

export interface VpxExpectation {
  /** The spawn returned this pid (null: it did not say); from now on only this pid is claimed. */
  bind(pid: number | null): void;
  /** The process ended (or never started): forget the expectation. */
  done(): void;
}

interface Entry {
  exe: string;
  table: string;
  at: number;
  pid: number | null;
  /** The process watch claimed a process for it (bound by its pid or by the match). */
  claimed: boolean;
  /** That process's start: a later process that reuses the pid (Windows does) is not it. */
  claimedStart: number | null;
}

const norm = (p: string): string => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
const baseOf = (p: string): string => norm(p).split('\\').pop() ?? '';

/** Same exe: the same full path; a lister that gave only the process name matches the exe's file name. */
function sameExe(seen: string, expected: string): boolean {
  if (!/[\\/]/.test(seen)) return baseOf(seen) === baseOf(expected);
  return norm(seen) === norm(expected);
}

export class HiddenVpx {
  private entries: Entry[] = [];

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Before the spawn: the next process of this exe on this table is a watcher. */
  expect(e: ExpectedVpx): VpxExpectation {
    const entry: Entry = { exe: e.exe, table: e.tablePath, at: this.now(), pid: null, claimed: false, claimedStart: null };
    this.entries.push(entry);
    return {
      bind: (pid) => {
        if (pid !== null && Number.isInteger(pid) && pid > 0) entry.pid = pid;
      },
      done: () => {
        this.entries = this.entries.filter((x) => x !== entry);
      },
    };
  }

  /** The process watch's question, asked once per new VPX pid: is this one of the watchers Castcade started? */
  hides(p: ProcessInfo): boolean {
    const now = this.now();
    // Lapsed: expected, never seen, never bound (the spawn failed).
    this.entries = this.entries.filter((x) => x.pid !== null || x.claimed || now - x.at <= UNBOUND_TTL_MS);
    for (const x of this.entries) {
      if (x.pid !== null) {
        if (x.pid !== p.pid) continue;
        // The pid again, but another process (the watcher ended without `done`, and Windows gave its pid away).
        if (x.claimed && x.claimedStart !== null && p.startedAt !== null && p.startedAt !== x.claimedStart) continue;
        this.claim(x, p);
        return true;
      }
      if (x.claimed) continue;
      if (!sameExe(p.exe, x.exe)) continue;
      const table = parsePlayArg(p.commandLine);
      if (table === null || norm(table) !== norm(x.table)) continue;
      if (p.startedAt !== null && p.startedAt < x.at - START_SLACK_MS) continue;
      x.pid = p.pid;
      this.claim(x, p);
      return true;
    }
    return false;
  }

  private claim(x: Entry, p: ProcessInfo): void {
    if (!x.claimed) x.claimedStart = p.startedAt;
    x.claimed = true;
  }

  /** Expectations held now (tests, the log). */
  get size(): number {
    return this.entries.length;
  }
}
