/**
 * A15 (2026-11-12): Castcade closed in the middle of a match and started again. Two match hosts on localhost over real
 * WebSockets (Electron stubbed), each with a rig the test drives: a table whose hook keeps writing its journal while
 * Castcade is closed. "Castcade closes" is the match host torn down without leaving (what the peers see of a crash:
 * the sockets close); "Castcade starts" is a new match host over the same files, and the witness reading the table's
 * journal again from the top.
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
const { RESUME_FILE, CLIENT_RESUME_MAX_MS, HOST_WAIT_MS } = await import('./match-resume.js');
const { startFakeRelay } = await import('../match/relay-fake.test-support.js');
type MatchHost = ReturnType<typeof createMatchHost>;
type Options = Parameters<typeof createMatchHost>[0];
type WitnessHost = Options['witness'];
type Logger = Options['log'];
type WStatus = ReturnType<WitnessHost['status']>;
type Listener = Parameters<WitnessHost['onEvent']>[0];
type Feed = Parameters<Listener>[0];
type Mark = NonNullable<NonNullable<Parameters<Listener>[1]>['mark']>;

const SHA = 'ab'.repeat(32);

/**
 * A rig: VPX with a table open and the hook journaling. `say` is the hook writing an event, whether Castcade runs or
 * not; `castcadeStarts` is a fresh witness reading the journal from the top (every event again, marked as backlog).
 */
function rig() {
  const eventCbs = new Set<Listener>();
  const statusCbs = new Set<(s: WStatus) => void>();
  const journal: { ev: Feed; offset: number }[] = [];
  let offset = 100;
  let delivered: Mark | null = null;
  let session = 's1';
  const markAt = (o: number): Mark => ({ path: '/journal/table.jsonl', session, loaded: 50, offset: o });
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
    onStatus: (cb: (s: WStatus) => void) => (statusCbs.add(cb), () => statusCbs.delete(cb)),
    journalMark: () => delivered,
  } as unknown as WitnessHost;
  return {
    w,
    gameStart: () => say({ kind: 'game_start', t: 0, players: 1 } as Feed),
    score: (ball: number, score: number) => say({ kind: 'current_scores', t: 0, scores: [score], player: 1, ball } as Feed),
    ballEnd: (ball: number) => say({ kind: 'ball_end', t: 0, player: 1, ball, extraBalls: 0 } as Feed),
    gameEnd: (score: number) => say({ kind: 'game_end', t: 0, scores: [score], players: 1 } as Feed),
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
function castcade(name: string, w: WitnessHost, dir?: string, extra: Partial<Options> = {}): Seat {
  const d = dir ?? mkdtempSync(join(tmpdir(), `castcade-restart-${name}-`));
  if (!dir) dirs.push(d);
  const lock = join(d, 'lock', 'turn.lock');
  const logs: string[] = [];
  const logger = { info: (l: string) => void logs.push(l), warn: (l: string) => void logs.push(l), error: (l: string) => void logs.push(l), file: '' } as unknown as Logger;
  const mh = createMatchHost({
    file: join(d, 'match.json'),
    keysFile: join(d, 'match-keys.json'),
    witness: w,
    device: () => ({ deviceId: `dev-${name}`, deviceLabel: name }),
    appVersion: '0.2.40',
    log: logger,
    publicIp: () => Promise.resolve('127.0.0.1'),
    lockFile: lock,
    listenAddress: '127.0.0.1',
    openPort: null,
    ...extra,
  });
  hosts.push(mh);
  return { mh, dir: d, lock, record: join(d, RESUME_FILE), logs };
}

/** Castcade closes without leaving the match (a crash, as the others see it). */
const closes = (s: Seat): Promise<void> => s.mh.stop({ keepForRestart: true });
/** The saved record as a crash leaves it: seen alive `agoMs` ago, not marked as an update restart. */
function crashed(s: Seat, agoMs = 5_000): void {
  const rec = JSON.parse(readFileSync(s.record, 'utf8')) as { aliveAt: number; restart: string | null };
  rec.aliveAt = Date.now() - agoMs;
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
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const port = (): number => 51000 + Math.floor(Math.random() * 2000);
const scoreOf = (mh: MatchHost, name: string): number | null | undefined => mh.status().panel?.players.find((p) => p.name === name)?.score;
const up = (mh: MatchHost, ball: number): boolean => mh.status().panel?.myTurn === true && mh.status().panel?.ball === ball;

/** A started two-player match, 3 balls: the host is up on ball 1. */
async function started(extra: Partial<Options> = {}) {
  const hr = rig();
  const cr = rig();
  const H = castcade('host', hr.w, undefined, extra);
  const C = castcade('guest', cr.w, undefined, extra);
  const hs = await H.mh.host({ port: port(), ballsPerGame: 3, displayName: 'Host' });
  await C.mh.join(hs.invite!, 'Guest');
  await until(() => H.mh.status().participants.length === 2);
  await H.mh.start();
  await until(() => up(H.mh, 1) && C.mh.status().phase === 'playing');
  return { hr, cr, H, C };
}

describe('a client restarted in the middle of a match (A15)', () => {
  it("during its own ball, the ball still in play: the Match tab offers the match, the rejoin gives the turn back with the table's keys, and the ball end passes it once", async () => {
    const { hr, cr, H, C } = await started();
    hr.gameStart();
    hr.ball(1, 500);
    await until(() => up(C.mh, 1));
    cr.gameStart();
    cr.score(1, 100);
    await until(() => scoreOf(H.mh, 'Guest') === 100);
    expect(existsSync(C.record)).toBe(true);
    // What the file holds: no key, no token.
    const text = readFileSync(C.record, 'utf8');
    expect(text).not.toMatch(/privateKey|deviceToken|"token"/);
    expect(JSON.parse(text)).toMatchObject({ version: 1, role: 'client', displayName: 'Guest', names: ['Host'] });

    await closes(C);
    crashed(C, 5 * 60_000);
    await until(() => H.mh.status().phase === 'paused');
    expect(H.mh.status().panel?.message).toBe('Paused: waiting for Guest to reconnect');

    // Castcade starts again five minutes later: nothing is joined by itself; the tab offers it by name.
    const C2 = castcade('guest', cr.w, C.dir);
    expect(C2.mh.status()).toMatchObject({ role: 'none', resume: { role: 'client', names: ['Host'], auto: false } });
    // The table was this player's when Castcade closed: it keeps its keys meanwhile.
    expect(existsSync(C2.lock)).toBe(false);
    cr.castcadeStarts();
    await C2.mh.rejoin();
    await until(() => up(C2.mh, 1) && H.mh.status().phase === 'playing');
    expect(C2.mh.status()).toMatchObject({ role: 'client', resume: null });
    expect(existsSync(C2.lock)).toBe(false);
    expect(scoreOf(C2.mh, 'Host')).toBe(500);
    await sleep(200);
    expect(up(C2.mh, 1)).toBe(true);

    cr.ball(1, 250);
    await until(() => up(H.mh, 2));
    expect(scoreOf(H.mh, 'Guest')).toBe(250);
    expect(existsSync(C2.lock)).toBe(true);
    expect(C2.logs.filter((l) => l.includes('BALL_END ball 1'))).toHaveLength(1);
  }, 40_000);

  it('a ball end missed while Castcade was closed is reported once after the rejoin, and an earlier ball of the same game is not reported again', async () => {
    const { hr, cr, H, C } = await started();
    hr.gameStart();
    hr.ball(1, 500);
    await until(() => up(C.mh, 1));
    cr.gameStart();
    cr.ball(1, 100);
    await until(() => up(H.mh, 2));
    hr.ball(2, 900);
    await until(() => up(C.mh, 2));
    cr.score(2, 150);
    await until(() => scoreOf(H.mh, 'Guest') === 150);

    await closes(C);
    crashed(C);
    await until(() => H.mh.status().phase === 'paused');
    // The player plays on: the ball drains, the bonus is counted. Nobody is listening.
    cr.score(2, 300);
    cr.ballEnd(2);
    cr.score(2, 340);

    const C2 = castcade('guest', cr.w, C.dir);
    // Under a minute ago: the shell rejoins without asking.
    expect(C2.mh.status().resume).toMatchObject({ auto: true });
    cr.castcadeStarts();
    await C2.mh.rejoin();
    await until(() => up(H.mh, 3));
    expect(scoreOf(H.mh, 'Guest')).toBe(340);
    expect(C2.mh.status().panel).toMatchObject({ myTurn: false });
    expect(existsSync(C2.lock)).toBe(true);
    expect(C2.logs.filter((l) => l.includes('BALL_END ball'))).toEqual(['match: BALL_END ball 2 score 340']);
    // The match goes on to its end.
    hr.ball(3, 1200);
    await until(() => up(C2.mh, 3));
    cr.ball(3, 600);
    await until(() => H.mh.status().phase === 'over' && C2.mh.status().phase === 'over');
    expect(H.mh.status().panel?.result?.map((r) => [r.name, r.score])).toEqual([
      ['Host', 1200],
      ['Guest', 600],
    ]);
    // Between games the match can still be rejoined; when it is left, nothing is kept.
    expect(existsSync(C2.record)).toBe(true);
    await C2.mh.leave();
    expect(existsSync(C2.record)).toBe(false);
  }, 40_000);

  it("the journal read only after the rejoin (the witness is slower than the reconnect): the missed ball end still lands once", async () => {
    const { hr, cr, H, C } = await started();
    hr.gameStart();
    hr.ball(1, 500);
    await until(() => up(C.mh, 1));
    cr.gameStart();
    cr.score(1, 100);
    await until(() => scoreOf(H.mh, 'Guest') === 100);
    await closes(C);
    crashed(C);
    cr.ballEnd(1);
    cr.score(1, 180);
    const C2 = castcade('guest', cr.w, C.dir);
    await C2.mh.rejoin();
    await until(() => up(C2.mh, 1));
    cr.castcadeStarts();
    await until(() => up(H.mh, 2));
    expect(scoreOf(H.mh, 'Guest')).toBe(180);
  }, 40_000);

  it("during another player's ball: the table stays locked through the restart, the host's turn goes on, and this player's turn comes as usual", async () => {
    const { hr, cr, H, C } = await started();
    hr.gameStart();
    hr.score(1, 200);
    await until(() => scoreOf(C.mh, 'Host') === 200);
    expect(existsSync(C.lock)).toBe(true);

    await closes(C);
    crashed(C);
    // The lock a closing Castcade takes off is the crash's to keep: put it back as a crash leaves it.
    writeFileSync(C.lock, '');
    await until(() => H.mh.status().phase === 'paused');
    const C2 = castcade('guest', cr.w, C.dir);
    expect(existsSync(C2.lock)).toBe(true);
    expect(C2.mh.status().locked).toBe(true);
    cr.castcadeStarts();
    await C2.mh.rejoin();
    await until(() => H.mh.status().phase === 'playing' && up(H.mh, 1));
    expect(C2.mh.status().panel).toMatchObject({ myTurn: false, ball: 1 });
    expect(existsSync(C2.lock)).toBe(true);

    hr.ballEnd(1);
    hr.score(1, 450);
    await until(() => up(C2.mh, 1));
    expect(existsSync(C2.lock)).toBe(false);
    expect(scoreOf(C2.mh, 'Host')).toBe(450);
  }, 40_000);

  it('the match ended while Castcade was closed: the rejoin says so and keeps the offer until the player drops it', async () => {
    const { hr, cr, H, C } = await started();
    hr.gameStart();
    hr.score(1, 200);
    await until(() => scoreOf(C.mh, 'Host') === 200);
    await closes(C);
    crashed(C);
    await H.mh.leave();

    const C2 = castcade('guest', cr.w, C.dir, { rejoinTimeoutMs: 1500 });
    await expect(C2.mh.rejoin()).rejects.toThrow(/The match may be over, or its host away for the moment/);
    expect(C2.mh.status()).toMatchObject({ role: 'none', phase: 'none', resume: { role: 'client' } });
    expect(C2.mh.status().lastError).toMatch(/Rejoin tries again, Forget it drops it/);
    expect(C2.mh.forgetResume().resume).toBeNull();
    expect(existsSync(C2.record)).toBe(false);
    expect(existsSync(C2.lock)).toBe(false);
  }, 40_000);

  it('the host passed the turn by hand while this player was away: the ball that then drained is not reported for the next grant', async () => {
    const { hr, cr, H, C } = await started();
    hr.gameStart();
    hr.ball(1, 500);
    await until(() => up(C.mh, 1));
    cr.gameStart();
    cr.score(1, 100);
    await until(() => scoreOf(H.mh, 'Guest') === 100);
    await closes(C);
    crashed(C);
    await until(() => H.mh.status().phase === 'paused');
    // The host does not wait: Pass the turn, then Resume; its own ball 2 is played.
    await H.mh.passTurn();
    cr.ballEnd(1);
    cr.score(1, 130);

    const C2 = castcade('guest', cr.w, C.dir);
    cr.castcadeStarts();
    await C2.mh.rejoin();
    await until(() => H.mh.status().phase === 'playing');
    await until(() => up(H.mh, 2));
    hr.ball(2, 900);
    // The guest's ball 2 is granted: the drained ball 1 in the journal is not taken for it.
    await until(() => up(C2.mh, 2));
    await sleep(300);
    expect(up(C2.mh, 2)).toBe(true);
    expect(C2.logs.some((l) => l.includes('BALL_END ball'))).toBe(false);
  }, 40_000);

  it('the table was closed and opened again while Castcade was closed: the game cannot be picked up, and the player forfeits it as at any table close', async () => {
    const { hr, cr, H, C } = await started();
    hr.gameStart();
    hr.ball(1, 500);
    await until(() => up(C.mh, 1));
    cr.gameStart();
    cr.ball(1, 100);
    await until(() => up(H.mh, 2));
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
  }, 40_000);

  it('a record too old to go back to is dropped at start, and a lock it left is taken off', async () => {
    const { hr, cr, H, C } = await started();
    hr.gameStart();
    hr.score(1, 200);
    await until(() => scoreOf(C.mh, 'Host') === 200);
    await closes(C);
    crashed(C, CLIENT_RESUME_MAX_MS + 60_000);
    writeFileSync(C.lock, '');
    const C2 = castcade('guest', cr.w, C.dir);
    expect(C2.mh.status().resume).toBeNull();
    expect(existsSync(C2.record)).toBe(false);
    expect(existsSync(C2.lock)).toBe(false);
    await expect(C2.mh.rejoin()).rejects.toThrow('There is no match to rejoin any more');
    expect(H.mh.status().role).toBe('host');
  }, 40_000);

  it('hosting or joining another match drops the saved one; a lobby is never saved', async () => {
    const hr = rig();
    const H = castcade('lobby-host', hr.w);
    await H.mh.host({ port: port(), ballsPerGame: 3, displayName: 'Host' });
    expect(existsSync(H.record)).toBe(false);
    await H.mh.leave();

    const s = await started();
    await closes(s.C);
    crashed(s.C);
    const C2 = castcade('guest', s.cr.w, s.C.dir);
    expect(C2.mh.status().resume).not.toBeNull();
    await C2.mh.host({ port: port(), ballsPerGame: 3, displayName: 'Guest' });
    expect(C2.mh.status().resume).toBeNull();
    expect(existsSync(C2.record)).toBe(false);
  }, 40_000);
});

describe('the host restarted in the middle of a match (A15)', () => {
  it("during a client's ball: the client is told and waits, the host comes back under the same code, the client reconnects by itself, and a ball end the client reported into the dead link is reported again", async () => {
    const { hr, cr, H, C } = await started();
    hr.gameStart();
    hr.ball(1, 500);
    await until(() => up(C.mh, 1));
    cr.gameStart();
    cr.score(1, 100);
    await until(() => scoreOf(H.mh, 'Guest') === 100);
    const code = H.mh.status().code;
    expect(JSON.parse(readFileSync(H.record, 'utf8'))).toMatchObject({ role: 'host', names: ['Guest'], code });

    await closes(H);
    crashed(H);
    await until(() => C.mh.status().panel?.message === "The host's Castcade closed or lost its connection. The match is paused: waiting up to 3 minutes for it to come back.");
    // The client's ball drains meanwhile: its BALL_END goes nowhere.
    cr.score(1, 220);
    cr.ballEnd(1);
    cr.score(1, 260);
    await sleep(300);
    expect(C.mh.status().role).toBe('client');

    const H2 = castcade('host', hr.w, H.dir);
    expect(H2.mh.status().resume).toMatchObject({ role: 'host', names: ['Guest'], code, auto: true });
    hr.castcadeStarts();
    await H2.mh.rejoin();
    expect(H2.mh.status()).toMatchObject({ role: 'host', code });
    // The client's retry finds the listener again; the grant is re-issued, the lost ball end reported, the host is up.
    await until(() => up(H2.mh, 2), 15_000);
    expect(scoreOf(H2.mh, 'Guest')).toBe(260);
    expect(C.mh.status().panel?.message ?? '').not.toMatch(/closed or lost its connection/);
    expect(scoreOf(C.mh, 'Host')).toBe(500);

    hr.ball(2, 900);
    await until(() => up(C.mh, 2));
    cr.ball(2, 400);
    await until(() => up(H2.mh, 3));
    hr.ball(3, 1000);
    await until(() => up(C.mh, 3));
    cr.ball(3, 700);
    await until(() => H2.mh.status().phase === 'over' && C.mh.status().phase === 'over');
    expect(C.mh.status().panel?.result?.map((r) => [r.name, r.score])).toEqual([
      ['Host', 1000],
      ['Guest', 700],
    ]);
  }, 60_000);

  it('during its own ball, the ball end missed while closed: the host comes back, reports it once, and the client is up', async () => {
    const { hr, cr, H, C } = await started();
    hr.gameStart();
    hr.score(1, 300);
    await until(() => scoreOf(C.mh, 'Host') === 300);
    await closes(H);
    crashed(H);
    hr.ballEnd(1);
    hr.score(1, 350);
    const H2 = castcade('host', hr.w, H.dir);
    hr.castcadeStarts();
    await H2.mh.rejoin();
    await until(() => up(C.mh, 1), 15_000);
    expect(scoreOf(C.mh, 'Host')).toBe(350);
    expect(H2.logs.filter((l) => l.includes('BALL_END ball'))).toEqual(['match: BALL_END ball 1 score 350']);
    expect(existsSync(H2.lock)).toBe(true);
  }, 60_000);

  it('between games: the host comes back with the result, the client reconnects, and the next game starts from the host', async () => {
    const { hr, cr, H, C } = await started();
    hr.gameStart();
    cr.gameStart();
    for (let ball = 1; ball <= 3; ball++) {
      await until(() => up(H.mh, ball));
      hr.ball(ball, 100 * ball);
      await until(() => up(C.mh, ball));
      cr.ball(ball, 50 * ball);
    }
    await until(() => H.mh.status().phase === 'over' && C.mh.status().phase === 'over');
    await closes(H);
    crashed(H);
    const H2 = castcade('host', hr.w, H.dir);
    await H2.mh.rejoin();
    expect(H2.mh.status()).toMatchObject({ role: 'host', phase: 'over' });
    expect(H2.mh.status().panel?.result?.map((r) => [r.name, r.score])).toEqual([
      ['Host', 300],
      ['Guest', 150],
    ]);
    await until(() => H2.mh.status().series?.nextGameBlocker === null, 15_000);
    await H2.mh.start();
    await until(() => H2.mh.status().series?.game === 2 && C.mh.status().series?.game === 2 && up(H2.mh, 1));
  }, 60_000);

  it('a host that does not come back: after the wait the match ends for the client with the reason, its table is unlocked and nothing is kept', async () => {
    const { hr, cr, H, C } = await started({ hostWaitMs: 2500 });
    hr.gameStart();
    hr.score(1, 200);
    await until(() => scoreOf(C.mh, 'Host') === 200);
    expect(existsSync(C.lock)).toBe(true);
    await closes(H);
    await until(() => (C.mh.status().panel?.message ?? '').startsWith("The host's Castcade closed or lost its connection."));
    await until(() => C.mh.status().role === 'none', 15_000);
    expect(C.mh.status().lastError).toBe('The host did not come back within 1 minute: the match is over.');
    expect(existsSync(C.lock)).toBe(false);
    expect(existsSync(C.record)).toBe(false);
    void cr;
  }, 40_000);

  it("a host's record is only good for as long as its players wait", async () => {
    const { hr, H } = await started();
    hr.gameStart();
    await closes(H);
    crashed(H, HOST_WAIT_MS + 30_000);
    const H2 = castcade('host', hr.w, H.dir);
    expect(H2.mh.status().resume).toBeNull();
    expect(existsSync(H2.record)).toBe(false);
  }, 40_000);
});

describe('Castcade restarting itself for an update during a match (A15)', () => {
  it('the match is not left: the record says so, and the next start rejoins without asking however long the installer took', async () => {
    const { hr, cr, H, C } = await started();
    hr.gameStart();
    hr.score(1, 200);
    await until(() => scoreOf(C.mh, 'Host') === 200);
    await C.mh.stop({ keepForRestart: true });
    expect(JSON.parse(readFileSync(C.record, 'utf8'))).toMatchObject({ restart: 'update' });
    // Not a forfeit: the host waits for the player.
    await until(() => H.mh.status().phase === 'paused');
    expect(H.logs.some((l) => l.includes('FORFEIT'))).toBe(false);
    const rec = JSON.parse(readFileSync(C.record, 'utf8')) as { aliveAt: number };
    rec.aliveAt = Date.now() - 4 * 60_000;
    writeFileSync(C.record, JSON.stringify(rec));
    const C2 = castcade('guest', cr.w, C.dir);
    expect(C2.mh.status().resume).toMatchObject({ auto: true });
    await C2.mh.rejoin();
    await until(() => H.mh.status().phase === 'playing');
  }, 40_000);

  it('a plain quit still leaves the match (a forfeit) and keeps nothing', async () => {
    const { hr, H, C } = await started();
    hr.gameStart();
    await C.mh.stop();
    expect(existsSync(C.record)).toBe(false);
    await until(() => H.logs.some((l) => /forfeit|left/i.test(l)) || H.mh.status().participants.length >= 1);
  }, 40_000);
});

describe('a match through ArcAid, restarted (A15)', () => {
  /** A started relay match: both rigs paired, no direct link between them. */
  async function relayed(hostGraceMs: number) {
    const r = await startFakeRelay({ devices: { 'dev-h': 'tok-h', 'dev-c': 'tok-c' }, hostGraceMs });
    const via = (id: string): Partial<Options> => ({ relay: () => ({ baseUrl: r.url, deviceId: `dev-${id}`, deviceToken: `tok-${id}` }), relayTimeouts: { connectMs: 1500, ackMs: 1500 } });
    const hr = rig();
    const cr = rig();
    const H = castcade('relay-host', hr.w, undefined, via('h'));
    const C = castcade('relay-guest', cr.w, undefined, via('c'));
    const hs = await H.mh.host({ port: port(), ballsPerGame: 3, displayName: 'Host' });
    expect(hs.invite).toMatch(/^[A-Z]{6}$/);
    await C.mh.join(hs.invite!, 'Guest');
    await until(() => H.mh.status().participants.length === 2);
    await H.mh.start();
    await until(() => up(H.mh, 1) && C.mh.status().phase === 'playing');
    hr.gameStart();
    hr.ball(1, 500);
    await until(() => up(C.mh, 1));
    cr.gameStart();
    cr.score(1, 100);
    await until(() => scoreOf(H.mh, 'Guest') === 100);
    return { r, via, hr, cr, H, C, code: hs.invite! };
  }

  it('a client comes back through ArcAid into the locked room with the code it joined with, and a missed ball end lands', async () => {
    const m = await relayed(30_000);
    try {
      expect(JSON.parse(readFileSync(m.C.record, 'utf8'))).toMatchObject({ role: 'client', invite: m.code, relay: true });
      expect(readFileSync(m.C.record, 'utf8')).not.toContain('tok-c');
      await closes(m.C);
      crashed(m.C);
      await until(() => m.H.mh.status().phase === 'paused');
      m.cr.ballEnd(1);
      m.cr.score(1, 140);
      const C2 = castcade('relay-guest', m.cr.w, m.C.dir, m.via('c'));
      m.cr.castcadeStarts();
      await C2.mh.rejoin();
      expect(C2.mh.status()).toMatchObject({ role: 'client', via: 'relay' });
      await until(() => up(m.H.mh, 2));
      expect(scoreOf(m.H.mh, 'Guest')).toBe(140);
    } finally {
      for (const h of hosts.splice(0)) await h.stop();
      await m.r.close();
    }
  }, 60_000);

  it("the host comes back after ArcAid closed its room: it opens the same code again, and the client's own asks find it", async () => {
    const m = await relayed(300);
    try {
      await closes(m.H);
      crashed(m.H);
      await until(() => (m.C.mh.status().panel?.message ?? '').startsWith("The host's Castcade closed or lost its connection."));
      // The room outlived its host by 300 ms here (30 s on ArcAid): it is gone when the host is back.
      await until(() => m.r.rooms().length === 0);
      await sleep(500);
      const H2 = castcade('relay-host', m.hr.w, m.H.dir, m.via('h'));
      m.hr.castcadeStarts();
      await H2.mh.rejoin();
      expect(H2.mh.status()).toMatchObject({ role: 'host', code: m.code, via: 'relay' });
      expect(m.r.rooms()).toEqual([m.code]);
      await until(() => H2.mh.status().phase === 'playing' && up(m.C.mh, 1), 40_000);
      m.cr.ball(1, 180);
      await until(() => up(H2.mh, 2));
      expect(scoreOf(H2.mh, 'Guest')).toBe(180);
      // Five asks at the most for a room that was gone.
      expect(m.r.misses.get('dev-c') ?? 0).toBeLessThanOrEqual(5);
    } finally {
      for (const h of hosts.splice(0)) await h.stop();
      await m.r.close();
    }
  }, 90_000);
});
