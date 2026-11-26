import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AnyMessage } from '@castcade/protocol';
import { MatchLog, type LogEntry } from '../match/log.js';
import type { JournalMark } from '../witness/types.js';
import { AUTO_RESUME_MS, CLIENT_RESUME_MAX_MS, HOST_WAIT_MS, TableBacklog, createResumeStore, oldRecordOf, oldRecordSentence, parseResume, resumeCheck, resumeFreshness, turnEndSeqsOf, turnEndsOf, type ResumeRecord, type SavedLobbyPart } from './match-resume.js';

/** A log entry carrying just what `turnEndsOf` reads. */
const msg = (type: string, from: string, payload: Record<string, unknown> = {}): AnyMessage => ({ type, from, payload }) as unknown as AnyMessage;
function logOf(...messages: AnyMessage[]): LogEntry[] {
  const log = new MatchLog();
  messages.forEach((m, i) => log.append({ ts: 1000 + i, kind: 'msg', from: m.from, message: m }));
  return log.toJSON();
}

const record = (patch: Partial<ResumeRecord> = {}): ResumeRecord => ({
  version: 2,
  role: 'client',
  code: 'ABCDEF',
  invite: 'ABCDEF',
  port: null,
  relay: true,
  playerId: 'p1',
  displayName: 'Guest',
  publicKey: 'cHVibGljLWtleS1vZi1wMQ==',
  stance: 'play',
  names: ['Host'],
  matchId: 'ABCDEF-1',
  log: logOf(msg('MATCH_READY', 'h')),
  lobby: null,
  mark: { path: '/journal/t.jsonl', session: 's1', loaded: 50, offset: 120 },
  aliveAt: 1_000_000,
  restart: null,
  owed: [],
  ...patch,
});

/** What only the lobby's PC saves. */
const lobbyPart = (patch: Partial<SavedLobbyPart> = {}): SavedLobbyPart => ({
  code: 'ABCDEF',
  members: [
    { participant: { playerId: 'p1', displayName: 'Krobs', publicKey: 'a2V5LW9mLWtyb2Jz', rig: 'vr_headset' }, stance: 'play' },
    { participant: { playerId: 'p2', displayName: 'Chuck', publicKey: 'a2V5LW9mLWNodWNr', rig: 'pc' }, stance: 'watch' },
  ],
  table: { game: { kind: 'vpx', tableName: 'Monster Bash', tableHash: 'ab'.repeat(32), romName: 'mb_106b', romHash: null, physicsHash: null, recipeVersion: '0.5.0', sidecarHash: null, emulatorVersion: '10.8.0' }, fixed: true, pickedBy: 'h' },
  tableObjects: { editables: 412, hash: 'cd'.repeat(32) },
  nextMatch: 2,
  ballsPerGame: 3,
  match: { matchId: 'ABCDEF-1', results: [] },
  seq: { taken: { p1: 1_795_000_000_500, p2: 1_795_000_000_900 }, sent: 1_795_000_001_024 },
  ...patch,
});
const hostRecord = (patch: Partial<ResumeRecord> = {}): ResumeRecord => record({ role: 'host', invite: null, port: 47100, playerId: 'h', displayName: 'Owner', names: ['Krobs', 'Chuck'], lobby: lobbyPart(), ...patch });

/** The file's text for a record, as the store writes it: with its own check. */
const text = (rec: object): string => {
  const body = JSON.parse(JSON.stringify(rec)) as Record<string, unknown>;
  return JSON.stringify({ ...body, check: resumeCheck(body) });
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('the saved lobby record (A15; version 2 since A17 step 8)', () => {
  it('round-trips through the file, written whole, for a member and for the lobby\'s PC, with a match open and with none; remove leaves nothing; no private key and no pairing token is in it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'castcade-resume-'));
    dirs.push(dir);
    const file = join(dir, 'sub', 'match-resume.json');
    const store = createResumeStore(file, () => undefined);
    expect(store.read()).toBeNull();
    for (const rec of [record(), record({ matchId: null, log: [], stance: 'watch' }), hostRecord(), hostRecord({ matchId: null, log: [], lobby: lobbyPart({ match: null }) })]) {
      expect(store.write(rec)).toBe(true);
      expect(store.read()).toEqual(rec);
      expect(store.readOld()).toBeNull();
      const written = readFileSync(file, 'utf8');
      expect(written).not.toMatch(/privateKey|private_key|token|secret/i);
      // What a record is made of, key by key: nothing else is written.
      expect(Object.keys(JSON.parse(written) as object).sort()).toEqual(
        ['aliveAt', 'check', 'code', 'displayName', 'invite', 'lobby', 'log', 'mark', 'matchId', 'names', 'owed', 'playerId', 'port', 'publicKey', 'relay', 'restart', 'role', 'stance', 'version'].sort(),
      );
    }
    const part = (JSON.parse(readFileSync(file, 'utf8')) as { lobby: Record<string, unknown> }).lobby;
    expect(Object.keys(part).sort()).toEqual(['ballsPerGame', 'code', 'match', 'members', 'nextMatch', 'seq', 'table', 'tableObjects']);
    store.remove();
    expect(store.read()).toBeNull();
  });

  it('refuses what is not a record: torn text, another version, a bad code, a log whose chain is broken, a log with no match named or a match with no log, a member without an invite, no key', () => {
    expect(parseResume(text(record()))).toEqual(record());
    expect(parseResume(null)).toBeNull();
    const ok = text(record());
    expect(parseResume(ok.slice(0, ok.length - 20))).toBeNull();
    expect(parseResume(text({ ...record(), version: 3 }))).toBeNull();
    expect(parseResume(text({ ...record(), version: 1 }))).toBeNull();
    expect(parseResume(text({ ...record(), code: 'abc' }))).toBeNull();
    expect(parseResume(text({ ...record(), log: [] }))).toBeNull();
    expect(parseResume(text({ ...record(), matchId: null }))).toBeNull();
    expect(parseResume(text({ ...record(), invite: null }))).toBeNull();
    expect(parseResume(text({ ...record(), port: 70000 }))).toBeNull();
    expect(parseResume(text({ ...record(), publicKey: '' }))).toBeNull();
    const broken = record();
    broken.log = [{ ...broken.log[0]!, ts: 5 }];
    expect(parseResume(text(broken))).toBeNull();
    // A mark that does not read is dropped, not the record; a choice that does not read is Play.
    expect(parseResume(text({ ...record(), mark: { path: 1 } }))?.mark).toBeNull();
    expect(parseResume(text({ ...record(), stance: 'spectate' }))?.stance).toBe('play');
    const dir = mkdtempSync(join(tmpdir(), 'castcade-resume-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'r.json'), '{');
    expect(createResumeStore(join(dir, 'r.json'), () => undefined).read()).toBeNull();
  });

  it("A17 step 8: a record that does not agree with its own check, or whose lobby part does not read, is still a record (the code, the port, the names) and is marked: the lobby cannot be restored from it, only opened again", () => {
    const whole = hostRecord();
    expect(parseResume(text(whole))).toEqual(whole);
    // One character of the file changed after it was written: the check no longer agrees.
    const edited = text(whole).replace('"nextMatch":2', '"nextMatch":7');
    expect(parseResume(edited)).toMatchObject({ role: 'host', code: 'ABCDEF', port: 47100, names: ['Krobs', 'Chuck'], lobby: null, damaged: true });
    // No check at all (a file written by hand): the same.
    expect(parseResume(JSON.stringify(whole))).toMatchObject({ lobby: null, damaged: true });
    // The check agrees and the part itself does not read.
    const bad = (part: unknown): ResumeRecord | null => parseResume(text({ ...whole, lobby: part }));
    for (const part of [
      null,
      'x',
      { ...lobbyPart(), code: 'OTHERX' },
      { ...lobbyPart(), members: [{ participant: { playerId: 'p1', displayName: 'Krobs', publicKey: '', rig: 'pc' }, stance: 'play' }] },
      { ...lobbyPart(), members: [{ participant: { playerId: 'p1', displayName: 'Krobs', publicKey: 'a2V5', rig: 'pc' }, stance: 'maybe' }] },
      { ...lobbyPart(), nextMatch: 0 },
      { ...lobbyPart(), ballsPerGame: 0 },
      { ...lobbyPart(), table: { game: null, fixed: true, pickedBy: null } },
      { ...lobbyPart(), match: { matchId: 'ABCDEF-1', results: [{ matchId: 'OTHERX-1' }] } },
      { ...lobbyPart(), seq: { taken: { p1: -4 }, sent: 1 } },
      { ...lobbyPart(), seq: { taken: {}, sent: 'many' } },
    ]) {
      expect(bad(part)).toMatchObject({ role: 'host', code: 'ABCDEF', lobby: null, damaged: true });
    }
    // A member's record has no such part, and is not marked for it; one that fails its check is marked.
    expect(parseResume(text(record()))?.damaged).toBeUndefined();
    expect(parseResume(JSON.stringify(record()))).toMatchObject({ role: 'client', lobby: null, damaged: true });
    // `damaged` is never written.
    const dir = mkdtempSync(join(tmpdir(), 'castcade-resume-'));
    dirs.push(dir);
    const store = createResumeStore(join(dir, 'r.json'), () => undefined);
    store.write({ ...whole, damaged: true });
    expect(store.read()).toEqual(whole);
  });

  it('A17 step 8: a file of version 1 (Castcade 0.2.50 or older) is no record of this version and is known for what it is: a match on protocol 6, said in a sentence', () => {
    const v1 = { version: 1, role: 'client', code: 'JHDFEF', invite: 'JHDFEF', port: null, relay: true, playerId: 'p1', displayName: 'Guest', names: ['Krobs', 'Chuck'], log: logOf(msg('MATCH_READY', 'h')), mark: null, aliveAt: 1_000_000, restart: null, owed: [] };
    expect(parseResume(JSON.stringify(v1))).toBeNull();
    expect(oldRecordOf(JSON.stringify(v1))).toEqual({ version: 1, code: 'JHDFEF', role: 'client', names: ['Krobs', 'Chuck'], aliveAt: 1_000_000 });
    expect(oldRecordSentence(oldRecordOf(JSON.stringify(v1))!)).toBe(
      'Castcade closed during the match JHDFEF with Krobs and Chuck, which was played on an older Castcade (protocol 6). This version cannot go back into it: open a lobby, or join one, and play on from there.',
    );
    // Whatever else is in such a file, nothing of it is trusted, and nothing throws.
    expect(oldRecordOf(JSON.stringify({ version: 1, code: 7, role: 'king', names: 'x' }))).toEqual({ version: 1, code: null, role: null, names: [], aliveAt: null });
    expect(oldRecordSentence({ version: 1, code: null, role: null, names: [], aliveAt: null })).toMatch(/^Castcade closed during the match, which was played on an older Castcade \(protocol 6\)\./);
    for (const not of [null, '', '{', '[]', JSON.stringify(record()), JSON.stringify({ version: 0 })]) expect(oldRecordOf(not)).toBeNull();
    const dir = mkdtempSync(join(tmpdir(), 'castcade-resume-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'r.json'), JSON.stringify(v1));
    const store = createResumeStore(join(dir, 'r.json'), () => undefined);
    expect(store.read()).toBeNull();
    expect(store.readOld()).toMatchObject({ version: 1, code: 'JHDFEF' });
  });

  it('is rejoined without asking for a minute (or after an update restart), offered after that, and dropped when nobody can be waiting', () => {
    const at = 1_000_000;
    const c = record({ aliveAt: at });
    expect(resumeFreshness(c, at + 10_000)).toBe('auto');
    expect(resumeFreshness(c, at + AUTO_RESUME_MS)).toBe('auto');
    expect(resumeFreshness(c, at + AUTO_RESUME_MS + 1)).toBe('offer');
    expect(resumeFreshness(c, at + CLIENT_RESUME_MAX_MS)).toBe('offer');
    expect(resumeFreshness(c, at + CLIENT_RESUME_MAX_MS + 1)).toBe('stale');
    expect(resumeFreshness({ ...c, restart: 'update' }, at + 10 * 60_000)).toBe('auto');
    expect(resumeFreshness({ ...c, restart: 'update' }, at + CLIENT_RESUME_MAX_MS + 1)).toBe('stale');
    // A17 step 7: the members of a lobby wait twenty minutes for its PC (it was three); after that there is nobody to open it for.
    expect(HOST_WAIT_MS).toBe(20 * 60_000);
    const h = record({ role: 'host', aliveAt: at });
    expect(resumeFreshness(h, at + HOST_WAIT_MS)).toBe('offer');
    expect(resumeFreshness(h, at + HOST_WAIT_MS + 1)).toBe('stale');
    // A clock that went backwards.
    expect(resumeFreshness(c, at - 1)).toBe('stale');
    // A17 step 8 (the review of PR 138): Castcade was closed by its owner on the lobby's PC and the lobby kept: it is
    // offered, however fresh, and never gone back into by itself; and it goes stale like any other.
    const quit = record({ role: 'host', aliveAt: at, restart: 'quit' });
    expect(resumeFreshness(quit, at + 1000)).toBe('offer');
    expect(resumeFreshness(quit, at + HOST_WAIT_MS)).toBe('offer');
    expect(resumeFreshness(quit, at + HOST_WAIT_MS + 1)).toBe('stale');
  });

  it("counts this player's turn ends in the current game: its ball ends and the host's passes, from the last game start", () => {
    const log = logOf(
      msg('MATCH_READY', 'h'),
      msg('BALL_END', 'h'),
      msg('BALL_END', 'p1'),
      msg('TURN_PASS', 'h', { player: 'p1' }),
      msg('TURN_PASS', 'h', { player: 'p2' }),
      msg('GAME_OVER', 'p1'),
    );
    expect(turnEndsOf(log, 'p1')).toBe(2);
    expect(turnEndsOf(log, 'h')).toBe(1);
    expect(turnEndsOf([...log, ...logOf(msg('NEXT_GAME', 'h'), msg('BALL_END', 'p1')).slice(0)], 'p1')).toBe(1);
  });

  it('A17 step 4 (the review of PR 131): the table ball ends still owed are kept with the record; one from before has none, and anything that is not a grant number is dropped', () => {
    const withOwed = (owed: unknown): string => text({ ...record(), owed });
    expect(parseResume(withOwed([7, 12]))?.owed).toEqual([7, 12]);
    expect(parseResume(withOwed([7, 'x', -1, 2.5, null, 9]))?.owed).toEqual([7, 9]);
    expect(parseResume(withOwed('7'))?.owed).toEqual([]);
    const before = { ...record() } as Partial<ResumeRecord>;
    delete before.owed;
    expect(parseResume(text(before))?.owed).toEqual([]);
  });

  it("A17 step 4 (the review of PR 131): the grants of this player's turn ends in the current game, as `turnEndsOf` counts them", () => {
    const log = logOf(
      msg('MATCH_READY', 'h'),
      msg('BALL_END', 'h', { grantSeq: 1 }),
      msg('BALL_END', 'p1', { grantSeq: 2 }),
      msg('TURN_PASS', 'h', { player: 'p1', grantSeq: 4 }),
      msg('TURN_PASS', 'h', { player: 'p2', grantSeq: 5 }),
    );
    expect(turnEndSeqsOf(log, 'p1')).toEqual([2, 4]);
    expect(turnEndSeqsOf(log, 'h')).toEqual([1]);
    expect(turnEndSeqsOf(logOf(msg('MATCH_READY', 'h'), msg('BALL_END', 'p1', { grantSeq: 2 }), msg('NEXT_GAME', 'h'), msg('BALL_END', 'p1', { grantSeq: 9 })), 'p1')).toEqual([9]);
  });
});

describe('TableBacklog: what of the table is news to the match (A15)', () => {
  type Ev = { kind: string; ball?: number | null; score?: number };
  const mark = (offset: number, session = 's1'): JournalMark => ({ path: '/journal/t.jsonl', session, loaded: 50, offset });
  const backlog = (offset: number, session = 's1') => ({ backlog: true, mark: mark(offset, session) });
  const live = (offset: number) => ({ backlog: false, mark: mark(offset) });

  it('a running match: everything is taken, scores collapse to the last, and a commit answers what was held', () => {
    const b = new TableBacklog<Ev>(null, false);
    expect(b.take({ kind: 'game_start' }, live(10))).toBe(true);
    expect(b.take({ kind: 'current_scores', score: 1 }, live(20))).toBe(true);
    expect(b.take({ kind: 'current_scores', score: 2 }, live(30))).toBe(true);
    expect(b.take({ kind: 'ball_end', ball: 1 }, undefined)).toBe(true);
    expect(b.pending()).toEqual([{ kind: 'game_start' }, { kind: 'current_scores', score: 2 }, { kind: 'ball_end', ball: 1 }]);
    expect(b.holdsEnd()).toBe(true);
    // Asked again (a second reconnect), the same list: it stays until the log answers it.
    expect(b.pending()).toHaveLength(3);
    b.clear();
    expect(b.pending()).toEqual([]);
    expect(b.holdsEnd()).toBe(false);
  });

  it('A17 step 4 (the review of PR 131): an end the match will never take is forgotten, that one alone; the rest stays for the log to answer', () => {
    const b = new TableBacklog<Ev>(null, false);
    const drain: Ev = { kind: 'ball_end', ball: 1 };
    const real: Ev = { kind: 'ball_end', ball: 2 };
    b.take({ kind: 'current_scores', score: 1 }, live(10));
    b.take(drain, live(20));
    expect(b.holdsEnd()).toBe(true);
    b.forget(drain);
    expect(b.holdsEnd()).toBe(false);
    expect(b.pending()).toEqual([{ kind: 'current_scores', score: 1 }]);
    b.take(drain, live(30));
    b.take(real, live(40));
    b.forget(drain);
    expect(b.pending()).toEqual([{ kind: 'current_scores', score: 1 }, real]);
    // Something it never held: nothing happens.
    b.forget({ kind: 'ball_end', ball: 2 });
    expect(b.pending()).toHaveLength(2);
  });

  it('after a restart: nothing at or before the saved mark, everything after it', () => {
    const b = new TableBacklog<Ev>(mark(120), true);
    expect(b.take({ kind: 'game_start' }, backlog(100))).toBe(false);
    expect(b.take({ kind: 'ball_end', ball: 1 }, backlog(120))).toBe(false);
    expect(b.take({ kind: 'current_scores', score: 5 }, backlog(130))).toBe(true);
    expect(b.take({ kind: 'ball_end', ball: 2 }, backlog(140))).toBe(true);
    expect(b.pending().map((e) => e.kind)).toEqual(['current_scores', 'ball_end']);
    expect(b.tableReopened()).toBe(false);
  });

  it('ball ends the host already had are skipped, the first ones of the backlog, held or still to come; a live one never', () => {
    const b = new TableBacklog<Ev>(mark(100), true);
    b.take({ kind: 'ball_end', ball: 1 }, backlog(110));
    b.take({ kind: 'current_scores', score: 9 }, backlog(120));
    b.skipEnds(2);
    expect(b.pending()).toEqual([{ kind: 'current_scores', score: 9 }]);
    // The witness is still reading the backlog: the second one the host had.
    expect(b.take({ kind: 'ball_end', ball: 2 }, backlog(130))).toBe(false);
    expect(b.take({ kind: 'ball_end', ball: 3 }, backlog(140))).toBe(true);

    const c = new TableBacklog<Ev>(mark(100), true);
    c.skipEnds(1);
    expect(c.take({ kind: 'ball_end', ball: 1 }, live(110))).toBe(true);
    // And once the table speaks live, nothing later is skipped either.
    expect(c.take({ kind: 'ball_end', ball: 2 }, backlog(120))).toBe(true);
  });

  it('no mark saved: only the game being played now can be the match\'s; another load of the table says the table was reopened, once', () => {
    const b = new TableBacklog<Ev>(null, true);
    b.take({ kind: 'game_start' }, backlog(10));
    b.take({ kind: 'ball_end', ball: 1 }, backlog(20));
    b.take({ kind: 'game_end' }, backlog(30));
    b.take({ kind: 'game_start' }, backlog(40));
    b.take({ kind: 'current_scores', score: 3 }, backlog(50));
    expect(b.pending().map((e) => e.kind)).toEqual(['game_start', 'current_scores']);

    const r = new TableBacklog<Ev>(mark(120, 's1'), true);
    expect(r.take({ kind: 'game_start' }, backlog(10, 's2'))).toBe(true);
    expect(r.tableReopened()).toBe(true);
    expect(r.tableReopened()).toBe(false);
  });
});
