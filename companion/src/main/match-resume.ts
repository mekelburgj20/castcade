/**
 * A15 (2026-11-12): what a restart of Castcade needs to pick a match up again, kept in `<userData>/match-resume.json`
 * while a started match is on. Written whole and atomically (tmp + rename) at every entry of the match log, and every
 * 15 s as a sign of life; removed when the match ends or is left on purpose.
 *
 * What is in the file: the match code; for a client the invite it joined with (the code, or the host's address and
 * port for a direct match); for a host the port it listened on and whether ArcAid carried the match; this player's id
 * and name; the other players' names; the match log so far (the roster with names, ids and public keys, the table
 * fingerprints, grants, ball ends and scores, each as it went over the wire); where in the table's journal the match
 * had read to. What is not: no private key (that stays in `match-keys.json`, as before), no pairing token, nothing
 * of the voice or video. The file alone lets nobody back into the match: a RECONNECT is signed with the private key.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { MatchLog, type LogEntry } from '../match/log.js';
import type { JournalMark } from '../witness/types.js';

export const RESUME_FILE = 'match-resume.json';
/** The record is rewritten this often while a match is on, so its `aliveAt` says when Castcade was last running. */
export const RESUME_HEARTBEAT_MS = 15_000;
/**
 * How long a client waits for a host that is gone before the match ends for it, and so how old a host's record may be:
 * after it nobody is waiting. Three minutes covers a crash and a relaunch by hand with a headset on; the wait is also
 * what ArcAid's relay allows a client to ask for a room that is gone (`HOST_WAIT_REJOIN`).
 */
export const HOST_WAIT_MS = 3 * 60_000;
/**
 * How old a client's record may be. The host pauses the match for a player who dropped and waits until someone acts;
 * the protocol's own limit for one ball is 20 minutes, so a player gone for longer than that is beyond what a match
 * waits for by itself.
 */
export const CLIENT_RESUME_MAX_MS = 20 * 60_000;
/**
 * Castcade was running in the match less than this ago: it crashed or was restarted, and the player did not leave, so
 * the match is rejoined without asking (the microphone was already on in it a moment ago). A minute, plus one
 * heartbeat of slack. Older: the Match tab asks.
 */
export const AUTO_RESUME_MS = 60_000 + RESUME_HEARTBEAT_MS;

export interface ResumeRecord {
  version: 1;
  role: 'host' | 'client';
  code: string;
  /** A client: the invite it joined with. */
  invite: string | null;
  /** A host: the port it listened on (null: ArcAid only), and whether ArcAid carried the match. */
  port: number | null;
  relay: boolean;
  playerId: string;
  displayName: string;
  /** The other players, for "Rejoin the match with …". */
  names: string[];
  log: LogEntry[];
  /** Where the witness had read to in the table's journal when the log last grew (`Witness.journalMark`). */
  mark: JournalMark | null;
  /** Epoch ms of the last write. */
  aliveAt: number;
  /** Castcade closed itself to install an update: rejoined without asking at the next start. */
  restart: 'update' | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function parseMark(v: unknown): JournalMark | null {
  if (!isObj(v)) return null;
  const { path, session, loaded, offset } = v;
  if (typeof path !== 'string' || (session !== null && typeof session !== 'string')) return null;
  if (typeof loaded !== 'number' || typeof offset !== 'number' || !Number.isFinite(loaded) || !Number.isFinite(offset)) return null;
  return { path, session, loaded, offset };
}

/** The record from the file's text; null for anything that is not one (a torn file, another version, a broken log chain). */
export function parseResume(text: string | null): ResumeRecord | null {
  if (text === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(raw) || raw.version !== 1) return null;
  if (raw.role !== 'host' && raw.role !== 'client') return null;
  const { code, invite, port, playerId, displayName, names, log, aliveAt } = raw;
  if (typeof code !== 'string' || !/^[A-Z]{6}$/.test(code)) return null;
  if (typeof playerId !== 'string' || !playerId || typeof displayName !== 'string') return null;
  if (typeof aliveAt !== 'number' || !Number.isFinite(aliveAt)) return null;
  if (!Array.isArray(log) || log.length === 0) return null;
  if (raw.role === 'client' && typeof invite !== 'string') return null;
  if (port !== null && (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535)) return null;
  try {
    MatchLog.fromJSON(log as LogEntry[]);
  } catch {
    return null;
  }
  return {
    version: 1,
    role: raw.role,
    code,
    invite: typeof invite === 'string' ? invite : null,
    port: port as number | null,
    relay: raw.relay === true,
    playerId,
    displayName,
    names: Array.isArray(names) ? names.filter((n): n is string => typeof n === 'string').slice(0, 8) : [],
    log: log as LogEntry[],
    mark: parseMark(raw.mark),
    aliveAt,
    restart: raw.restart === 'update' ? 'update' : null,
  };
}

/**
 * What to do with a record found at start: rejoin without asking (`auto`), offer it on the Match tab (`offer`), or
 * drop it (`stale`). A clock that went backwards reads as stale.
 */
export function resumeFreshness(rec: Pick<ResumeRecord, 'role' | 'aliveAt' | 'restart'>, now: number): 'auto' | 'offer' | 'stale' {
  const age = now - rec.aliveAt;
  if (age < 0 || age > (rec.role === 'host' ? HOST_WAIT_MS : CLIENT_RESUME_MAX_MS)) return 'stale';
  return rec.restart === 'update' || age <= AUTO_RESUME_MS ? 'auto' : 'offer';
}

export interface ResumeStore {
  read(): ResumeRecord | null;
  /** Never throws: a record that cannot be written only means no rejoin after a crash. Returns false then. */
  write(rec: ResumeRecord): boolean;
  remove(): void;
}

export function createResumeStore(file: string, warn: (line: string) => void): ResumeStore {
  return {
    read() {
      try {
        return parseResume(readFileSync(file, 'utf8'));
      } catch {
        return null;
      }
    },
    write(rec) {
      try {
        mkdirSync(dirname(file), { recursive: true });
        const tmp = `${file}.tmp`;
        writeFileSync(tmp, JSON.stringify(rec));
        renameSync(tmp, file);
        return true;
      } catch (e) {
        warn(`match: could not save ${file}: ${e instanceof Error ? e.message : String(e)}`);
        return false;
      }
    },
    remove() {
      try {
        rmSync(file, { force: true });
        rmSync(`${file}.tmp`, { force: true });
      } catch (e) {
        warn(`match: could not remove ${file}: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
}

/** This player's turns that ended in the log's current game: its own BALL_ENDs and the host's TURN_PASS for it. */
export function turnEndsOf(log: readonly LogEntry[], player: string): number {
  let n = 0;
  for (const e of log) {
    const m = e.message;
    if (!m) continue;
    if (m.type === 'MATCH_READY' || m.type === 'NEXT_GAME') n = 0;
    else if (m.type === 'BALL_END' && m.from === player) n += 1;
    else if (m.type === 'TURN_PASS' && m.payload.player === player) n += 1;
  }
  return n;
}

export type TableEvent = { kind: string; ball?: number | null };

/**
 * The table's game events a match has not answered yet, between the witness and the match controller. In a running
 * match it only remembers what arrived since the log last grew, so a ball end reported into a link that had dropped
 * can be reported again after the reconnect. After a restart it also decides what of the journal's backlog is news:
 * nothing at or before the saved mark, and not the ball ends the host turned out to have already (`skipEnds`).
 */
export class TableBacklog<E extends TableEvent> {
  private held: E[] = [];
  private skip = 0;
  /** The load of the table the saved mark names is not the one being read: the table was closed and opened again. */
  private reopened = false;

  constructor(
    private readonly saved: JournalMark | null,
    private readonly resumed: boolean,
  ) {}

  /** False: the match already had this event (at or before the saved mark, or a ball end the host had) and it is dropped. */
  take(ev: E, meta: { backlog: boolean; mark: JournalMark | null } | undefined): boolean {
    const m = meta?.mark ?? null;
    if (!meta?.backlog) this.skip = 0;
    else if (ev.kind === 'ball_end' && this.skip > 0 && this.settled) {
      this.skip -= 1;
      return false;
    }
    if (this.resumed && meta?.backlog && m !== null) {
      const s = this.saved;
      if (s !== null && s.path === m.path && s.session === m.session && s.loaded === m.loaded) {
        if (m.offset <= s.offset) return false;
      } else if (s !== null) {
        this.reopened = true;
      } else if (ev.kind === 'game_start') {
        // No mark to go by: only the game being played now can be this match's.
        this.held = [];
      }
    }
    const last = this.held[this.held.length - 1];
    if (ev.kind === 'current_scores' && last?.kind === 'current_scores') this.held[this.held.length - 1] = ev;
    else this.held.push(ev);
    if (this.held.length > 500) this.held.splice(0, this.held.length - 500);
    return true;
  }

  /** The table the match was being played on is not the one open now (found while reading the backlog); asked once. */
  tableReopened(): boolean {
    const r = this.reopened;
    this.reopened = false;
    return r;
  }

  /**
   * After the reconnect: this many of the journal's ball ends past the mark are already in the log (the host had
   * them). They are the first ones: of those held now, then of the backlog still being read; never a live one.
   */
  skipEnds(n: number): void {
    this.skip = Math.max(0, n);
    this.settled = true;
    this.held = this.held.filter((e) => {
      if (e.kind !== 'ball_end' || this.skip === 0) return true;
      this.skip -= 1;
      return false;
    });
  }
  private settled = false;

  /** The log grew: what the table said before is answered. */
  clear(): void {
    this.held = [];
  }

  /** A ball or game end is held that the log has not answered. */
  holdsEnd(): boolean {
    return this.held.some((e) => e.kind === 'ball_end' || e.kind === 'game_end' || e.kind === 'game_abandoned');
  }

  /** What to feed the controller now, in order; the held list stays until the log answers it. */
  pending(): E[] {
    return [...this.held];
  }
}
