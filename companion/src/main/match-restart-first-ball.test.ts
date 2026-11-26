/**
 * A15, found 2026-11-24: Castcade closed during a player's FIRST ball, and the table closed and opened again meanwhile.
 *
 * `match-restart.test.ts` has the same story for a later ball ("the table was closed and opened again while Castcade
 * was closed"), and that test timed out in CI's Windows job and in most full runs on a busy PC. Why: it closes the
 * guest's Castcade the moment the HOST shows its next turn, and on a busy PC the guest had not yet read the host's
 * answer to its own ball end. Its saved record then ended at its own grant, and the journal mark in it was null: the
 * mark is taken when the log grows, and at that grant the guest's table had not said anything yet. With no mark the
 * restarted Castcade could not tell that the table was another load, took the fresh game for the match's, and the
 * forfeit the test waits for never came.
 *
 * That is not only a test's order of events. The log does not grow during a ball, so for the whole first ball of a
 * player the record named no table load. Here that case is played in a fixed order, no timing in it: the guest is
 * in its first ball when its Castcade closes. `match-host.ts` now names the table load at the first event after such
 * a log entry (the `witness.onEvent` handler).
 *
 * The rig and the seats are those of `match-restart.test.ts` (which another change was editing on this day, so
 * nothing is shared with it yet); the hosts listen on a port the system picks.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => {
  class BrowserWindow {
    webContents = { once: (_e: string, cb: () => void) => cb(), send: () => undefined };
    isDestroyed(): boolean {
      return false;
    }
    loadFile(): Promise<void> {
      return Promise.resolve();
    }
    destroy(): void {}
  }
  return { BrowserWindow, ipcMain: { on: () => undefined } };
});

const { createMatchHost } = await import('./match-host.js');
const { RESUME_FILE } = await import('./match-resume.js');
type MatchHost = ReturnType<typeof createMatchHost>;
type Options = Parameters<typeof createMatchHost>[0];
type WitnessHost = Options['witness'];
type Logger = Options['log'];
type WStatus = ReturnType<WitnessHost['status']>;
type Listener = Parameters<WitnessHost['onEvent']>[0];
type Feed = Parameters<Listener>[0];
type Mark = NonNullable<NonNullable<Parameters<Listener>[1]>['mark']>;

const SHA = 'ab'.repeat(32);
const JOURNAL = '/journal/table.jsonl';
/** The end of the `table_loaded` line of the rig's journal: every game event is past it. */
const LOADED = 50;

/**
 * A rig: VPX with a table open and the hook journaling. `say` is the hook writing an event, whether Castcade runs or
 * not; `castcadeStarts` is a fresh witness reading the journal from the top (every event again, marked as backlog).
 * As the real witness, it has no mark before it delivered a first game event.
 */
function rig() {
  const eventCbs = new Set<Listener>();
  const journal: { ev: Feed; offset: number }[] = [];
  let offset = 100;
  let delivered: Mark | null = null;
  let session = 's1';
  const markAt = (o: number): Mark => ({ path: JOURNAL, session, loaded: LOADED, offset: o });
  const emit = (ev: Feed, o: number, backlog: boolean): void => {
    delivered = markAt(o);
    for (const cb of [...eventCbs]) cb(ev, { backlog, mark: markAt(o) });
  };
  const say = (ev: Feed): void => {
    offset += 10;
    journal.push({ ev, offset });
    emit(ev, offset, false);
  };
  const w = {
    status: () => ({ paired: false, currentTable: 'Test Table', currentIdentity: { sha256: SHA, tableInfo: null }, currentAttestation: null, captureMode: 'live', note: null }) as unknown as WStatus,
    sampleVr: async () => null,
    liveGame: () => ({ table: 'Test Table', inGame: false, scores: [], player: null, ball: null }),
    onEvent: (cb: Listener) => (eventCbs.add(cb), () => eventCbs.delete(cb)),
    onStatus: () => () => undefined,
    journalMark: () => delivered,
  } as unknown as WitnessHost;
  return {
    w,
    gameStart: () => say({ kind: 'game_start', t: 0, players: 1 } as Feed),
    score: (ball: number, score: number) => say({ kind: 'current_scores', t: 0, scores: [score], player: 1, ball } as Feed),
    ballEnd: (ball: number) => say({ kind: 'ball_end', t: 0, player: 1, ball, extraBalls: 0 } as Feed),
    /** One ball played to its end at `score`. */
    ball(ball: number, score: number) {
      this.score(ball, score);
      this.ballEnd(ball);
      this.score(ball, score);
    },
    castcadeStarts() {
      delivered = null;
      for (const j of journal) emit(j.ev, j.offset, true);
    },
    /** VPX was closed and the table opened again: another journal session, nothing of the old game in it. */
    reopenTable() {
      journal.length = 0;
      session = 's2';
    },
  };
}

const dirs: string[] = [];
const hosts: MatchHost[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Seat {
  mh: MatchHost;
  dir: string;
  lock: string;
  record: string;
  logs: string[];
}

/** A Castcade on a rig; `dir`: the user data of an earlier one (the same PC after a restart). */
function castcade(name: string, w: WitnessHost, dir?: string): Seat {
  const d = dir ?? mkdtempSync(join(tmpdir(), `castcade-first-ball-${name}-`));
  if (!dir) dirs.push(d);
  const lock = join(d, 'lock', 'turn.lock');
  const logs: string[] = [];
  const logger = { info: (l: string) => void logs.push(l), warn: (l: string) => void logs.push(l), error: (l: string) => void logs.push(l), file: '' } as unknown as Logger;
  const mh = createMatchHost({
    file: join(d, 'match.json'),
    keysFile: join(d, 'match-keys.json'),
    witness: w,
    device: () => ({ deviceId: `dev-${name}`, deviceLabel: name }),
    appVersion: '0.2.50',
    log: logger,
    publicIp: () => Promise.resolve('127.0.0.1'),
    lockFile: lock,
    listenAddress: '127.0.0.1',
    openPort: null,
    // A port the system picks (`host({ port: 0 })`), never a number picked here: `free-port.test-support.ts`.
    ephemeralPort: true,
    // A17 step 7: every match is in a lobby, and every start of a lobby counts down (5 s in the app); here it is short.
    lobby: { countdownMs: 20 },
  });
  hosts.push(mh);
  return { mh, dir: d, lock, record: join(d, RESUME_FILE), logs };
}

/** Castcade closes without leaving the match (a crash, as the others see it). */
const closes = (s: Seat): Promise<void> => s.mh.stop({ keepForRestart: true });
/** The saved record as a crash leaves it: seen alive 5 s ago, not marked as an update restart. */
function crashed(s: Seat): void {
  const rec = JSON.parse(readFileSync(s.record, 'utf8')) as { aliveAt: number; restart: string | null };
  rec.aliveAt = Date.now() - 5_000;
  rec.restart = null;
  writeFileSync(s.record, JSON.stringify(rec));
}

const until = async (cond: () => boolean, ms = 8000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};
const scoreOf = (mh: MatchHost, name: string): number | null | undefined => mh.status().panel?.players.find((p) => p.name === name)?.score;
const up = (mh: MatchHost, ball: number): boolean => mh.status().panel?.myTurn === true && mh.status().panel?.ball === ball;
const savedMark = (s: Seat): unknown => (JSON.parse(readFileSync(s.record, 'utf8')) as { mark: unknown }).mark;

/** A started two-player match, 3 balls, the host's ball 1 played: the guest is up on its first ball, its table silent so far. */
async function guestUp() {
  const hr = rig();
  const cr = rig();
  const H = castcade('host', hr.w);
  const C = castcade('guest', cr.w);
  const hs = await H.mh.host({ port: 0, ballsPerGame: 3, displayName: 'Host' });
  await C.mh.join(hs.invite!, 'Guest');
  await until(() => H.mh.status().participants.length === 2);
  await H.mh.start();
  await until(() => up(H.mh, 1) && C.mh.status().phase === 'playing');
  hr.gameStart();
  hr.ball(1, 500);
  await until(() => up(C.mh, 1));
  return { hr, cr, H, C };
}

describe("a client restarted during its first ball (A15): the saved record names the table load although the log has not grown since the table's first event", () => {
  it('the table closed and opened again while Castcade was closed: the game cannot be picked up, and the player forfeits it as at any table close', async () => {
    const { cr, H, C } = await guestUp();
    // The log last grew at this grant, before the guest's table said anything: the witness had no mark to give.
    expect(savedMark(C)).toBeNull();
    cr.gameStart();
    // The table's first event names its load in the record at once, with none of its events answered.
    expect(savedMark(C)).toEqual({ path: JOURNAL, session: 's1', loaded: LOADED, offset: LOADED });
    cr.score(1, 100);
    await until(() => scoreOf(H.mh, 'Guest') === 100);
    expect(savedMark(C)).toEqual({ path: JOURNAL, session: 's1', loaded: LOADED, offset: LOADED });

    await closes(C);
    crashed(C);
    cr.reopenTable();
    cr.gameStart();
    cr.score(1, 10);
    const C2 = castcade('guest', cr.w, C.dir);
    cr.castcadeStarts();
    await C2.mh.rejoin();
    await until(() => C2.logs.some((l) => l.includes('FORFEIT (table closed)')));
    expect(C2.logs).toContain('match: the table was closed while Castcade was closed');
    // The fresh game on the reopened table is nobody's ball: nothing of it was reported.
    expect(C2.logs.some((l) => l.includes('BALL_END ball'))).toBe(false);
    expect(existsSync(C2.lock)).toBe(true);
  }, 40_000);

  it('the same table still open: the ball goes on, and its end, missed while Castcade was closed, is reported once', async () => {
    const { cr, H, C } = await guestUp();
    cr.gameStart();
    cr.score(1, 100);
    await until(() => scoreOf(H.mh, 'Guest') === 100);
    await closes(C);
    crashed(C);
    // The ball drains while nobody listens.
    cr.score(1, 300);
    cr.ballEnd(1);
    cr.score(1, 340);
    const C2 = castcade('guest', cr.w, C.dir);
    cr.castcadeStarts();
    await C2.mh.rejoin();
    await until(() => up(H.mh, 2));
    expect(scoreOf(H.mh, 'Guest')).toBe(340);
    expect(C2.logs.filter((l) => l.includes('BALL_END ball'))).toEqual(['match: BALL_END ball 1 score 340']);
    expect(C2.logs.some((l) => l.includes('FORFEIT') || l.includes('the table was closed'))).toBe(false);
  }, 40_000);
});
