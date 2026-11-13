import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AnyMessage } from '@castcade/protocol';
import { MatchLog, type LogEntry } from '../match/log.js';
import type { JournalMark } from '../witness/types.js';
import { AUTO_RESUME_MS, CLIENT_RESUME_MAX_MS, HOST_WAIT_MS, TableBacklog, createResumeStore, parseResume, resumeFreshness, turnEndsOf, type ResumeRecord } from './match-resume.js';

/** A log entry carrying just what `turnEndsOf` reads. */
const msg = (type: string, from: string, payload: Record<string, unknown> = {}): AnyMessage => ({ type, from, payload }) as unknown as AnyMessage;
function logOf(...messages: AnyMessage[]): LogEntry[] {
  const log = new MatchLog();
  messages.forEach((m, i) => log.append({ ts: 1000 + i, kind: 'msg', from: m.from, message: m }));
  return log.toJSON();
}

const record = (patch: Partial<ResumeRecord> = {}): ResumeRecord => ({
  version: 1,
  role: 'client',
  code: 'ABCDEF',
  invite: 'ABCDEF',
  port: null,
  relay: true,
  playerId: 'p1',
  displayName: 'Guest',
  names: ['Host'],
  log: logOf(msg('MATCH_READY', 'h')),
  mark: { path: '/journal/t.jsonl', session: 's1', loaded: 50, offset: 120 },
  aliveAt: 1_000_000,
  restart: null,
  ...patch,
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('the saved match record (A15)', () => {
  it('round-trips through the file, written whole; remove leaves nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'castcade-resume-'));
    dirs.push(dir);
    const file = join(dir, 'sub', 'match-resume.json');
    const store = createResumeStore(file, () => undefined);
    expect(store.read()).toBeNull();
    expect(store.write(record())).toBe(true);
    expect(store.read()).toEqual(record());
    expect(readFileSync(file, 'utf8')).not.toMatch(/privateKey|token/i);
    store.remove();
    expect(store.read()).toBeNull();
  });

  it('refuses what is not a record: torn text, another version, a bad code, no log, a log whose chain is broken, a client without an invite', () => {
    const ok = JSON.stringify(record());
    expect(parseResume(ok)).not.toBeNull();
    expect(parseResume(null)).toBeNull();
    expect(parseResume(ok.slice(0, ok.length - 20))).toBeNull();
    expect(parseResume(JSON.stringify({ ...record(), version: 2 }))).toBeNull();
    expect(parseResume(JSON.stringify({ ...record(), code: 'abc' }))).toBeNull();
    expect(parseResume(JSON.stringify({ ...record(), log: [] }))).toBeNull();
    expect(parseResume(JSON.stringify({ ...record(), invite: null }))).toBeNull();
    expect(parseResume(JSON.stringify({ ...record(), port: 70000 }))).toBeNull();
    const broken = record();
    broken.log = [{ ...broken.log[0]!, ts: 5 }];
    expect(parseResume(JSON.stringify(broken))).toBeNull();
    // A mark that does not read is dropped, not the record.
    expect(parseResume(JSON.stringify({ ...record(), mark: { path: 1 } }))?.mark).toBeNull();
    const dir = mkdtempSync(join(tmpdir(), 'castcade-resume-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'r.json'), '{');
    expect(createResumeStore(join(dir, 'r.json'), () => undefined).read()).toBeNull();
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
    // A host's players wait three minutes; after that there is nobody to host for.
    const h = record({ role: 'host', aliveAt: at });
    expect(resumeFreshness(h, at + HOST_WAIT_MS)).toBe('offer');
    expect(resumeFreshness(h, at + HOST_WAIT_MS + 1)).toBe('stale');
    // A clock that went backwards.
    expect(resumeFreshness(c, at - 1)).toBe('stale');
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
