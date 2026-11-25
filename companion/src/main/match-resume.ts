/**
 * A15 (2026-11-12): what a restart of Castcade needs to pick a match up again, kept in `<userData>/match-resume.json`.
 * A17 step 8 (2026-11-26, alpha-match.md section 11.8): **version 2**, the record of a lobby. It is written from the
 * moment a lobby is opened or joined until the lobby ends for this PC (Leave lobby, Close lobby, the lobby's PC did
 * not come back, a way back that was refused for good), whole and atomically (tmp + rename): at every entry of the
 * open match's log, at every word of the lobby (somebody joined or left, Play / Watch, the table, a match begun or
 * ended, a result), every 15 s as a sign of life, and, on the lobby's PC, before a frame's number passes the last
 * one written (`SeqGuard`).
 *
 * What is in the file, for everybody: the lobby's code; for a member the invite it joined with (the code, or the
 * address and port of the lobby's PC for a direct lobby); for the lobby's PC the port it listened on and whether
 * ArcAid carried the lobby; this person's id, name, choice (Play or Watch) and PUBLIC match key; the names of the
 * others; the open match's id and its log so far when one is open and this PC holds it (the roster with names, ids
 * and public keys, the table fingerprints, grants, ball ends and scores, each as it went over the wire); where in
 * the table's journal the match had read to; the ball ends the table still owes.
 *
 * And what only the lobby's PC knows (`lobby`): every member's row as HELLO_ACK says it (id, name, rig, PUBLIC key)
 * with their choice; the picked table and who picked it; the number of the next match; the balls per game; the
 * RESULTs of the open match's games; and the counters' ceilings (the last number that may have been taken from each
 * member, and that this PC may have used).
 *
 * What is not: no private key (that stays in `match-keys.json`, as before), no pairing token, no network address
 * but the one in a direct invite (which the person typed or was sent), nothing of the voice or video. The file alone
 * lets nobody into the lobby as this person or as the lobby's PC: a HELLO back, a RECONNECT and every grant are
 * signed with the private key.
 *
 * `check` is a SHA-256 of the rest of the file: a record that does not agree with its own check is not trusted for
 * what cannot be checked another way (the lobby PC's part); the log carries its own chain.
 *
 * A version 1 file (Castcade 0.2.50 or older) is of a match on protocol 6, which this build cannot go back into: it
 * is recognised (`oldRecordOf`), said in a sentence, and removed.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { GameFingerprint, ParticipantInfo, PayloadOf, Stance } from '@castcade/protocol';
import type { SavedLobby } from '../match/host.js';
import { MatchLog, type LogEntry } from '../match/log.js';
import type { SeqCeilings } from '../match/session.js';
import type { JournalMark } from '../witness/types.js';

export const RESUME_FILE = 'match-resume.json';
/** The record is rewritten this often while a match is on, so its `aliveAt` says when Castcade was last running. */
export const RESUME_HEARTBEAT_MS = 15_000;
/**
 * How long a client waits for a host that is gone before the match ends for it, and so how old a host's record may be:
 * after it nobody is waiting. A17 step 7 (2026-11-25, alpha-match.md section 11.8a): twenty minutes, the wait of a
 * lobby's member for the lobby's PC (`LOBBY_HOST_WAIT_MS` in match/client.ts; it was three minutes for a match's
 * host), and how a member asks ArcAid for a room that is gone meanwhile is `LOBBY_REJOIN` (match/transport-relay.ts).
 */
export const HOST_WAIT_MS = 20 * 60_000;
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

/** A17 step 8: what only the lobby's PC knows, beside the open match's log (`HostMatch.savedLobby`, `Session.seqCeilings`). */
export interface SavedLobbyPart extends SavedLobby {
  seq: SeqCeilings;
}

export interface ResumeRecord {
  version: 2;
  role: 'host' | 'client';
  code: string;
  /** A client: the invite it joined with. */
  invite: string | null;
  /** A host: the port it listened on (null: ArcAid only), and whether ArcAid carried the match. */
  port: number | null;
  relay: boolean;
  playerId: string;
  displayName: string;
  /** A17 step 8: this PC's PUBLIC match key when the record was written: a record is this PC's when it is still the key. */
  publicKey: string;
  /** A17 step 8: this person's choice, Play or Watch. */
  stance: Stance;
  /** The others in the lobby, for "You were in a lobby with …". */
  names: string[];
  /** A17 step 8: the open match's id; null: no match is open (or this PC holds no log of it). */
  matchId: string | null;
  /** The open match's log; empty when `matchId` is null. */
  log: LogEntry[];
  /**
   * A17 step 8: the lobby PC's own part. Null on a member's record; null on the lobby PC's record when that part
   * did not read or the record failed its own check (`damaged`): the lobby can then only be opened again empty.
   */
  lobby: SavedLobbyPart | null;
  /** A17 step 8: the record failed its own check, or its lobby part did not read. Never written; set by `parseResume`. */
  damaged?: boolean;
  /** Where the witness had read to in the table's journal when the log last grew (`Witness.journalMark`). */
  mark: JournalMark | null;
  /** Epoch ms of the last write. */
  aliveAt: number;
  /**
   * `update`: Castcade closed itself to install an update: gone back into without asking at the next start. `quit`
   * (A17 step 8, the review of PR 138): Castcade was closed by its owner on the lobby's PC and the lobby kept: only
   * ever offered at the next start, never gone back into by itself (the microphone would go on without a click).
   * Null: the record was not written at a stop: Castcade crashed, or was ended from outside.
   */
  restart: 'update' | 'quit' | null;
  /**
   * A17 step 4 (the review of PR 131): the table ball ends this player's table still owes the match (a ball ended by
   * hand while it was still in play), as the grant of each such end (`MatchController.owedTableEnds`). Without it a
   * restart of Castcade would take the old ball's drain for the end of the ball the player is on by then. Absent in a
   * record from before: nothing owed.
   */
  owed?: number[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function parseMark(v: unknown): JournalMark | null {
  if (!isObj(v)) return null;
  const { path, session, loaded, offset } = v;
  if (typeof path !== 'string' || (session !== null && typeof session !== 'string')) return null;
  if (typeof loaded !== 'number' || typeof offset !== 'number' || !Number.isFinite(loaded) || !Number.isFinite(offset)) return null;
  return { path, session, loaded, offset };
}

const isStr = (v: unknown, max = 200): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/** The SHA-256 a record carries over the rest of itself (`check`): the JSON as written, without that key. */
export function resumeCheck(rec: object): string {
  const rest = { ...(rec as Record<string, unknown>) };
  delete rest['check'];
  delete rest['damaged'];
  return createHash('sha256').update(JSON.stringify(rest)).digest('hex');
}

function parseParticipant(v: unknown): ParticipantInfo | null {
  if (!isObj(v)) return null;
  const { playerId, displayName, publicKey, rig } = v;
  if (!isStr(playerId, 64) || typeof displayName !== 'string' || displayName.length > 64 || !isStr(publicKey, 128)) return null;
  if (rig !== 'vr_headset' && rig !== 'real_cabinet' && rig !== 'pc') return null;
  return { playerId, displayName, publicKey, rig };
}

/** The lobby PC's part of a record; null when anything in it does not read (the lobby is then not restored from it). */
function parseLobbyPart(v: unknown, code: string): SavedLobbyPart | null {
  if (!isObj(v) || v.code !== code) return null;
  const { members, table, nextMatch, match, ballsPerGame, seq } = v;
  if (!Array.isArray(members) || members.length > 15) return null;
  const rows: SavedLobbyPart['members'] = [];
  for (const m of members) {
    const participant = isObj(m) ? parseParticipant(m.participant) : null;
    if (!isObj(m) || !participant || (m.stance !== 'play' && m.stance !== 'watch')) return null;
    rows.push({ participant, stance: m.stance });
  }
  if (!isObj(table) || !isObj(table.game) || !isStr(table.game.tableHash, 64) || typeof table.game.tableName !== 'string' || typeof table.fixed !== 'boolean') return null;
  if (table.pickedBy !== null && !isStr(table.pickedBy, 64)) return null;
  if (!isCount(nextMatch) || nextMatch < 1 || !isCount(ballsPerGame) || ballsPerGame < 1 || ballsPerGame > 10) return null;
  let open: SavedLobbyPart['match'] = null;
  if (match !== null) {
    if (!isObj(match) || !isStr(match.matchId, 64) || !Array.isArray(match.results) || match.results.length > 200) return null;
    if (!match.results.every((r) => isObj(r) && r.matchId === match.matchId && isCount(r.game) && Array.isArray(r.entries) && isStr(r.logHash, 64) && isCount(r.logLength))) return null;
    open = { matchId: match.matchId, results: match.results as PayloadOf<'RESULT'>[] };
  }
  if (!isObj(seq) || !isObj(seq.taken) || !isCount(seq.sent)) return null;
  const taken: Record<string, number> = {};
  for (const [id, n] of Object.entries(seq.taken)) {
    if (!isCount(n)) return null;
    taken[id] = n;
  }
  const objects = isObj(v.tableObjects) && isCount(v.tableObjects.editables) && isStr(v.tableObjects.hash, 128) ? { editables: v.tableObjects.editables, hash: v.tableObjects.hash } : null;
  return {
    code,
    members: rows,
    // A17 step 10: whether the pick is the lobby PC's own table by default, and what the Castcade VPX build says of
    // the picked table; a record from before has neither (read as a person's pick with nothing known of it).
    table: {
      game: table.game as unknown as GameFingerprint,
      fixed: table.fixed,
      pickedBy: table.pickedBy as string | null,
      ...(typeof table.byDefault === 'boolean' ? { byDefault: table.byDefault } : {}),
      ...(isObj(table.objects) && isCount(table.objects.editables) && typeof table.objects.hash === 'string' && /^[0-9a-f]{16}$/.test(table.objects.hash) ? { objects: { editables: table.objects.editables, hash: table.objects.hash } } : {}),
    },
    tableObjects: objects,
    nextMatch,
    match: open,
    ballsPerGame,
    seq: { taken, sent: seq.sent },
  };
}

/**
 * The record from the file's text; null for anything that is not one (a torn file, another version, a broken log
 * chain, a log that is not the match the record names). A record of the lobby's PC whose own part does not read, or
 * that does not agree with its own check, is still a record (the code, the port, the others' names), marked
 * `damaged` and with `lobby` null: the lobby can be opened again under its code, empty.
 */
export function parseResume(text: string | null): ResumeRecord | null {
  if (text === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(raw) || raw.version !== 2) return null;
  if (raw.role !== 'host' && raw.role !== 'client') return null;
  const { code, invite, port, playerId, displayName, publicKey, names, log, aliveAt, matchId } = raw;
  if (typeof code !== 'string' || !/^[A-Z]{6}$/.test(code)) return null;
  if (typeof playerId !== 'string' || !playerId || typeof displayName !== 'string' || !isStr(publicKey, 128)) return null;
  if (typeof aliveAt !== 'number' || !Number.isFinite(aliveAt)) return null;
  if (!Array.isArray(log)) return null;
  if (matchId !== null && !isStr(matchId, 64)) return null;
  if ((matchId === null) !== (log.length === 0)) return null;
  if (raw.role === 'client' && typeof invite !== 'string') return null;
  if (port !== null && (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535)) return null;
  try {
    MatchLog.fromJSON(log as LogEntry[]);
  } catch {
    return null;
  }
  const checked = raw.check === resumeCheck(raw);
  const lobby = raw.role === 'host' && checked ? parseLobbyPart(raw.lobby, code) : null;
  const rec: ResumeRecord = {
    version: 2,
    role: raw.role,
    code,
    invite: typeof invite === 'string' ? invite : null,
    port: port as number | null,
    relay: raw.relay === true,
    playerId,
    displayName,
    publicKey,
    stance: raw.stance === 'watch' ? 'watch' : 'play',
    names: Array.isArray(names) ? names.filter((n): n is string => typeof n === 'string').slice(0, 16) : [],
    matchId: matchId as string | null,
    log: log as LogEntry[],
    lobby,
    mark: parseMark(raw.mark),
    aliveAt,
    restart: raw.restart === 'update' ? 'update' : raw.restart === 'quit' ? 'quit' : null,
    owed: Array.isArray(raw.owed) ? raw.owed.filter((n): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0).slice(0, 16) : [],
  };
  if (!checked || (raw.role === 'host' && lobby === null)) rec.damaged = true;
  return rec;
}

/** A17 step 8: what a file of version 1 (Castcade 0.2.50 or older, protocol 6) says of itself, for the sentence about it. */
export interface OldRecord {
  version: 1;
  code: string | null;
  role: 'host' | 'client' | null;
  names: string[];
  /** When the file was last written (ms), when it says so. */
  aliveAt: number | null;
}

/** The file is a record of version 1: a match on protocol 6, which this build cannot go back into. Null: it is not one. */
export function oldRecordOf(text: string | null): OldRecord | null {
  if (text === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(raw) || raw.version !== 1) return null;
  return {
    version: 1,
    code: typeof raw.code === 'string' && /^[A-Z]{6}$/.test(raw.code) ? raw.code : null,
    role: raw.role === 'host' || raw.role === 'client' ? raw.role : null,
    names: Array.isArray(raw.names) ? raw.names.filter((n): n is string => typeof n === 'string' && n.length <= 64).slice(0, 8) : [],
    aliveAt: typeof raw.aliveAt === 'number' && Number.isFinite(raw.aliveAt) ? raw.aliveAt : null,
  };
}

/** The sentence for a version 1 record: what it was, and that this build cannot go back into it. */
export function oldRecordSentence(old: OldRecord): string {
  const withWhom = old.names.length > 0 ? ` with ${old.names.length <= 1 ? old.names[0] : `${old.names.slice(0, -1).join(', ')} and ${old.names[old.names.length - 1]}`}` : '';
  return `Castcade closed during the match${old.code ? ` ${old.code}` : ''}${withWhom}, which was played on an older Castcade (protocol 6). This version cannot go back into it: open a lobby, or join one, and play on from there.`;
}

/**
 * What to do with a record found at start: rejoin without asking (`auto`), offer it on the Match tab (`offer`), or
 * drop it (`stale`). A clock that went backwards reads as stale.
 */
export function resumeFreshness(rec: Pick<ResumeRecord, 'role' | 'aliveAt' | 'restart'>, now: number): 'auto' | 'offer' | 'stale' {
  const age = now - rec.aliveAt;
  if (age < 0 || age > (rec.role === 'host' ? HOST_WAIT_MS : CLIENT_RESUME_MAX_MS)) return 'stale';
  // A deliberate quit is offered, however fresh: nobody's microphone goes on in a lobby they just closed Castcade on.
  if (rec.restart === 'quit') return 'offer';
  return rec.restart === 'update' || age <= AUTO_RESUME_MS ? 'auto' : 'offer';
}

export interface ResumeStore {
  read(): ResumeRecord | null;
  /** A17 step 8: the file is a record of version 1 (`oldRecordOf`); null when it is not, or there is none. */
  readOld(): OldRecord | null;
  /**
   * Never throws. False: the record could not be written, and `writeError()` says why (the system's own words). The
   * caller says so on that PC (A17 step 8, the review of PR 138: a record that is behind is worse than none) and
   * tries again at the next change.
   */
  write(rec: ResumeRecord): boolean;
  /** The system's error text of the last write that failed; null after one that worked. */
  writeError(): string | null;
  remove(): void;
}

export function createResumeStore(file: string, warn: (line: string) => void): ResumeStore {
  let writeError: string | null = null;
  return {
    writeError: () => writeError,
    read() {
      try {
        return parseResume(readFileSync(file, 'utf8'));
      } catch {
        return null;
      }
    },
    readOld() {
      try {
        return oldRecordOf(readFileSync(file, 'utf8'));
      } catch {
        return null;
      }
    },
    write(rec) {
      try {
        mkdirSync(dirname(file), { recursive: true });
        const tmp = `${file}.tmp`;
        // The check is over the record as it is written (the JSON of everything but the check itself).
        const { damaged: _damaged, ...plain } = rec;
        const body = JSON.parse(JSON.stringify(plain)) as Record<string, unknown>;
        writeFileSync(tmp, JSON.stringify({ ...body, check: resumeCheck(body) }));
        renameSync(tmp, file);
        writeError = null;
        return true;
      } catch (e) {
        writeError = e instanceof Error ? e.message : String(e);
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

/** A17 step 4 (the review of PR 131): the grants of this player's turns that ended in the log's current game (as `turnEndsOf` counts them). */
export function turnEndSeqsOf(log: readonly LogEntry[], player: string): number[] {
  let seqs: number[] = [];
  for (const e of log) {
    const m = e.message;
    if (!m) continue;
    if (m.type === 'MATCH_READY' || m.type === 'NEXT_GAME') seqs = [];
    else if (m.type === 'BALL_END' && m.from === player) seqs.push(m.payload.grantSeq);
    else if (m.type === 'TURN_PASS' && m.payload.player === player) seqs.push(m.payload.grantSeq);
  }
  return seqs;
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

  /**
   * A17 step 4 (the review of PR 131): the match will never take this event (a ball end the controller swallowed as
   * owed, or one that came with no grant held): it is not kept for a replay. Until then it stayed here as "an end the
   * log has not taken", and the next reconnect or restart fed it again, into the ball the player was on by then.
   */
  forget(ev: E): void {
    const i = this.held.lastIndexOf(ev);
    if (i >= 0) this.held.splice(i, 1);
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
