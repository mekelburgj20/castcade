/**
 * A15 (2026-11-12): Castcade closed in the middle of a match and started again. Two match hosts on localhost over real
 * WebSockets (Electron stubbed), each with a rig the test drives: a table whose hook keeps writing its journal while
 * Castcade is closed. "Castcade closes" is the match host torn down without leaving (what the peers see of a crash:
 * the sockets close); "Castcade starts" is a new match host over the same files, and the witness reading the table's
 * journal again from the top.
 *
 * A17 step 7 (2026-11-25): the match is a match in a lobby. A player of the open match whose Castcade started again
 * goes back by its own signed HELLO (a fresh engine; the lobby's PC sends the whole log), with the turn, the table's
 * keys and what the table said meanwhile, as A15 has it.
 *
 * A17 step 8 (2026-11-26): the record is the lobby's (version 2), written from the moment a lobby is opened or
 * joined. The lobby's PC whose Castcade started again is the same lobby: its members with their places kept, the
 * match where it stood, the ball of the player who was up taken when it is back. A watcher, and anybody while no
 * match is open, goes back by itself as a player does. Only a record that does not read in full opens the code
 * again empty (step 7's behaviour), with the match lost and said.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const { RESUME_FILE, CLIENT_RESUME_MAX_MS, HOST_WAIT_MS, resumeCheck } = await import('./match-resume.js');
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
  // A17 step 4: whether a game runs on the table right now, which a Castcade that starts in the middle of one reads.
  let inGame = false;
  const markAt = (o: number): Mark => ({ path: '/journal/table.jsonl', session, loaded: 50, offset: o });
  const emit = (ev: Feed, o: number, backlog: boolean): void => {
    delivered = markAt(o);
    for (const cb of [...eventCbs]) cb(ev, { backlog, mark: markAt(o) });
  };
  const say = (ev: Feed): void => {
    offset += 10;
    journal.push({ ev, offset });
    if (ev.kind === 'game_start') inGame = true;
    else if (ev.kind === 'game_end' || ev.kind === 'game_abandoned') inGame = false;
    emit(ev, offset, false);
  };
  const w = {
    status: () => ({ paired: false, currentTable: 'Test Table', currentIdentity: { sha256: SHA, tableInfo: null }, currentAttestation: null, captureMode: 'live', note: null }) as unknown as WStatus,
    sampleVr: async () => null,
    liveGame: () => ({ table: 'Test Table', inGame, scores: [], player: null, ball: null }),
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
      inGame = false;
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
    // A18: no grace: these tests are about what follows a dropped link, not the wait before it counts.
    disconnectGraceMs: 0,
    log: logger,
    publicIp: () => Promise.resolve('127.0.0.1'),
    lockFile: lock,
    listenAddress: '127.0.0.1',
    openPort: null,
    ephemeralPort: true,
    // A17 step 7: every match is in a lobby, and every start of a lobby counts down (5 s in the app); here it is short.
    lobby: { countdownMs: 20 },
    ...extra,
  });
  hosts.push(mh);
  return { mh, dir: d, lock, record: join(d, RESUME_FILE), logs };
}

/** Castcade closes without leaving the match (a crash, as the others see it). */
const closes = (s: Seat): Promise<void> => s.mh.stop({ keepForRestart: true });
/** The saved record as a crash leaves it: seen alive `agoMs` ago, not marked as an update restart. */
function crashed(s: Seat, agoMs = 5_000): void {
  rewrite(s.record, { aliveAt: Date.now() - agoMs, restart: null });
}
/** The record with some of its keys changed, written as the store writes it: with the check that goes with it (A17 step 8). */
function rewrite(file: string, patch: Record<string, unknown>): void {
  const rec = { ...(JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>), ...patch };
  delete rec['check'];
  writeFileSync(file, JSON.stringify({ ...rec, check: resumeCheck(rec) }));
}

/**
 * A real crash with a record that is BEHIND the engine (the review of PR 138): what was saved before `gap` is what
 * is on disk afterwards; the process is gone without the stop that saves (its sockets close, nothing more).
 */
async function crashBehind(s: Seat, gap: () => Promise<void>): Promise<void> {
  const before = readFileSync(s.record, 'utf8');
  await gap();
  await closes(s);
  writeFileSync(s.record, before);
  crashed(s);
}

/** A panel page whose closing takes time (`ms()` at that moment): what a real shutdown is made of. */
const slowMedia = (ms: () => number) =>
  ({
    async attach() {},
    addPeer: () => undefined,
    removePeer: () => undefined,
    setSending: () => undefined,
    setPanelState: () => undefined,
    setMuted: () => undefined,
    status: () => ({ attached: true, sending: false, peers: {}, mic: 'open', captureSource: null, lastError: null }),
    onStatus: () => () => undefined,
    frames: () => null,
    showPanel: () => undefined,
    async detach() {
      await new Promise((r) => setTimeout(r, ms()));
    },
  }) as never;

const until = async (cond: () => boolean, ms = 8000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
// The system picks the port (`free-port.test-support.ts`: `host({ port: 0 })` through the `ephemeralPort` seam that
// `castcade()` sets). A number picked here failed with EACCES inside the ranges Windows keeps for itself (A18 moved
// it below them; PR 129's helper ends the guessing). A restarted host comes back on the port its saved record holds.
const port = (): number => 0;
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
    expect(JSON.parse(text)).toMatchObject({ version: 2, role: 'client', displayName: 'Guest', names: ['Host'] });

    await closes(C);
    crashed(C, 5 * 60_000);
    await until(() => H.mh.status().phase === 'paused');
    // A17 step 7: the lobby's words (design 11.8): the place is kept, and the game waits at that player's own turn.
    expect(H.mh.status().panel?.message).toBe('Waiting for Guest to come back');

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
    // The host's grant for its own ball 3 reaches this rig a moment after the host has it.
    await until(() => C2.mh.status().panel?.myTurn === false);
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

  // A18: once with no grace (the host shows the guest as away before the rejoin) and once at the engines' own five
  // seconds, the way the app runs (the rejoin lands inside the host's grace, so nobody was told anything; and on the
  // guest's side a rejoin is not a drop: its log must not say its link "was away for a moment").
  it.each([
    ['with no grace', 0],
    ["at the engines' own grace", undefined],
  ] as const)("during another player's ball (%s): the table stays locked through the restart, the host's turn goes on, and this player's turn comes as usual", async (_name, graceMs) => {
    const { hr, cr, H, C } = await started({ disconnectGraceMs: graceMs });
    hr.gameStart();
    hr.score(1, 200);
    await until(() => scoreOf(C.mh, 'Host') === 200);
    expect(existsSync(C.lock)).toBe(true);

    await closes(C);
    crashed(C);
    // The lock a closing Castcade takes off is the crash's to keep: put it back as a crash leaves it.
    writeFileSync(C.lock, '');
    // A18: it is the host's ball: the guest is shown as away (once the grace is over) and nothing pauses for it.
    const guestAway = (): boolean => H.mh.status().panel?.players.find((p) => p.name === 'Guest')?.flags.includes('disconnected') === true;
    if (graceMs === 0) await until(() => guestAway());
    else await sleep(200);
    expect(H.mh.status()).toMatchObject({ phase: 'playing', locked: false });
    const C2 = castcade('guest', cr.w, C.dir, { disconnectGraceMs: graceMs });
    expect(existsSync(C2.lock)).toBe(true);
    expect(C2.mh.status().locked).toBe(true);
    cr.castcadeStarts();
    await C2.mh.rejoin();
    await until(() => H.mh.status().phase === 'playing' && up(H.mh, 1) && !guestAway());
    // The rejoin is the guest's own doing, not a link that blinked: its log does not call it one. The host, which saw
    // the link drop and come back inside its grace, does.
    expect(C2.logs.filter((l) => l.includes('was away for a moment'))).toEqual([]);
    if (graceMs !== 0) {
      expect(H.logs).toContain("match: Guest's link to this host was away for a moment and is back; nothing was paused or shown");
      expect(H.logs.filter((l) => l.includes('is away ('))).toEqual([]);
    }
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
    await expect(C2.mh.rejoin()).rejects.toThrow(/The lobby may be over, or its PC away for the moment/);
    expect(C2.mh.status()).toMatchObject({ role: 'none', phase: 'none', resume: { role: 'client' } });
    expect(C2.mh.status().lastError).toMatch(/Rejoin tries again, Forget it drops it/);
    expect(C2.mh.forgetResume().resume).toBeNull();
    expect(existsSync(C2.record)).toBe(false);
    expect(existsSync(C2.lock)).toBe(false);
  }, 40_000);

  it('the review of PR 127: a rejoin that is not taken back (the match ended while Castcade was closed): the panel page that came up for the attempt, with its microphone, is closed with it', async () => {
    const { hr, cr, H, C } = await started();
    hr.gameStart();
    hr.score(1, 200);
    await until(() => scoreOf(C.mh, 'Host') === 200);
    await closes(C);
    crashed(C);
    await H.mh.leave();

    // The page as the match host drives it: the attach, the peers it is given, the detach.
    const page = { attached: false, attaches: 0, detaches: 0, added: [] as string[] };
    const media = {
      async attach() {
        page.attached = true;
        page.attaches++;
      },
      addPeer: (p: string) => void page.added.push(p),
      removePeer: () => undefined,
      setSending: () => undefined,
      setPanelState: () => undefined,
      setMuted: () => undefined,
      status: () => ({ attached: page.attached, sending: false, peers: {}, mic: 'open', captureSource: null, lastError: null }),
      onStatus: () => () => undefined,
      frames: () => null,
      showPanel: () => undefined,
      async detach() {
        page.attached = false;
        page.detaches++;
      },
    };
    const C2 = castcade('guest', cr.w, C.dir, { rejoinTimeoutMs: 1500, media: media as never });
    await expect(C2.mh.rejoin()).rejects.toThrow(/The lobby may be over, or its PC away for the moment/);
    // A17 step 7: going back into a lobby is a join (the signed HELLO of a Castcade that started again), and the panel
    // page comes up only once the lobby's PC has answered. This attempt never got an answer, so the page never came
    // up at all: no microphone is opened for a lobby this PC is not in. (Until the lobby the attempt brought the
    // page up from the saved log and closed it again when it failed: one attach, one detach.)
    expect(page).toMatchObject({ attaches: 0, detaches: 0, attached: false });
    expect(C2.mh.status()).toMatchObject({ role: 'none', phase: 'none' });
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
    await expect(C2.mh.rejoin()).rejects.toThrow('There is no lobby to go back into any more');
    expect(H.mh.status().role).toBe('host');
  }, 40_000);

  it('opening or joining another lobby drops the saved one; a lobby is saved from the moment it is opened (A17 step 8), and Close lobby ends its record', async () => {
    const hr = rig();
    const H = castcade('lobby-host', hr.w);
    await H.mh.host({ port: port(), ballsPerGame: 3, displayName: 'Host' });
    expect(JSON.parse(readFileSync(H.record, 'utf8'))).toMatchObject({ version: 2, role: 'host', matchId: null, log: [], lobby: { members: [], nextMatch: 1, ballsPerGame: 3, match: null } });
    await H.mh.leave();
    expect(existsSync(H.record)).toBe(false);

    const s = await started();
    await closes(s.C);
    crashed(s.C);
    const C2 = castcade('guest', s.cr.w, s.C.dir);
    expect(C2.mh.status().resume).not.toBeNull();
    const opened = await C2.mh.host({ port: port(), ballsPerGame: 3, displayName: 'Guest' });
    expect(C2.mh.status().resume).toBeNull();
    // What is on disk now is the record of the lobby that was just opened, not of the one that was dropped.
    expect(JSON.parse(readFileSync(C2.record, 'utf8'))).toMatchObject({ role: 'host', code: opened.code, matchId: null });
  }, 40_000);
});

/**
 * A17 step 4 (2026-11-24, the review of PR 131): a ball ended by hand while the table's ball is still in play. The
 * table then owes the match that ball's end; it is swallowed when it comes, never kept for a replay, and what is
 * owed is in the saved record.
 */
describe('a ball ended by hand, and Castcade restarted (A17 step 4, the review of PR 131)', () => {
  const owedIn = (s: Seat): number[] => (JSON.parse(readFileSync(s.record, 'utf8')) as { owed?: number[] }).owed ?? [];
  /** The guest is up on ball 1 at 1200 with its ball in play, and ends it by hand: the host is up on ball 2. */
  async function endedByHand() {
    const s = await started();
    const { hr, cr, H, C } = s;
    hr.gameStart();
    hr.ball(1, 500);
    await until(() => up(C.mh, 1));
    cr.gameStart();
    cr.score(1, 1200);
    await until(() => C.mh.status().endBall?.score === 1200);
    const b = C.mh.status().endBall!;
    expect(b).toMatchObject({ ball: 1, score: 1200, tableBall: true });
    await C.mh.endMyBall(b.grantSeq);
    await until(() => up(H.mh, 2));
    // What the table owes is on disk before anything else happens.
    await until(() => owedIn(C)[0] === b.grantSeq);
    return { ...s, seq: b.grantSeq };
  }
  /** What a seat's log says of a ball end it took for the match: the table's, and the report. */
  const ballEndLines = (s: Seat): string[] => s.logs.filter((l) => l.includes('BALL_END ball') || l.includes('ended on the table; reporting'));
  /** The journal's backlog was fed to the match with a ball end in it (after a rejoin). */
  const replayed = (s: Seat): string[] => s.logs.filter((l) => / \([1-9]\d* ball end\(s\)\)/.test(l));

  it("the reviewer's sequence B: the ball drained during the other player's turn, and Castcade restarts on the next ball: the old drain is not read again from the journal, and the ball in play is not ended", async () => {
    const { hr, cr, H, C } = await endedByHand();
    cr.ballEnd(1);
    cr.score(1, 1250);
    await until(() => owedIn(C).length === 0);
    hr.ball(2, 900);
    await until(() => up(C.mh, 2));
    cr.score(2, 1500);
    await until(() => scoreOf(H.mh, 'Guest') === 1500);

    await closes(C);
    crashed(C);
    await until(() => H.mh.status().phase === 'paused');
    const C2 = castcade('guest', cr.w, C.dir);
    cr.castcadeStarts();
    await C2.mh.rejoin();
    await until(() => up(C2.mh, 2) && H.mh.status().phase === 'playing');
    await sleep(300);
    // Until this fix: "BALL_END ball 2 score 1500" here, with the ball in play.
    expect(up(C2.mh, 2)).toBe(true);
    expect(existsSync(C2.lock)).toBe(false);
    expect(ballEndLines(C2)).toEqual([]);
    expect(replayed(C2)).toEqual([]);
    cr.ball(2, 2000);
    await until(() => up(H.mh, 3));
    expect(scoreOf(H.mh, 'Guest')).toBe(2000);
    expect(ballEndLines(C2).filter((l) => l.includes('BALL_END'))).toEqual(['match: BALL_END ball 2 score 2000']);
  }, 40_000);

  it('Castcade restarts before the ball drained, and it drains while Castcade is closed: what the table owes came back from the record, the drain in the journal reports nothing, and the next ball end is the end of ball 2', async () => {
    const { hr, cr, H, C, seq } = await endedByHand();
    await closes(C);
    crashed(C);
    expect(owedIn(C)).toEqual([seq]);
    // Nobody is listening: the ball drains on the locked table.
    cr.ballEnd(1);
    cr.score(1, 1250);

    const C2 = castcade('guest', cr.w, C.dir);
    cr.castcadeStarts();
    await C2.mh.rejoin();
    await until(() => C2.mh.status().role === 'client' && C2.mh.status().phase === 'playing' && H.mh.status().phase === 'playing');
    await until(() => C2.logs.some((l) => l.startsWith('match: the ball that was ended by hand has ended on the table: nothing is reported for it')));
    await until(() => owedIn(C2).length === 0);
    hr.ball(2, 900);
    await until(() => up(C2.mh, 2));
    expect(C2.mh.status().panel?.message ?? '').not.toContain('still on the table');
    await sleep(300);
    expect(up(C2.mh, 2)).toBe(true);
    expect(ballEndLines(C2)).toEqual([]);
    cr.ball(2, 2000);
    await until(() => up(H.mh, 3));
    expect(scoreOf(H.mh, 'Guest')).toBe(2000);
    expect(ballEndLines(C2).filter((l) => l.includes('BALL_END'))).toEqual(['match: BALL_END ball 2 score 2000']);
  }, 40_000);

  it('Castcade restarts with the ball still on the table: at the next grant the panel says to play it out, its points count, its drain reports nothing, and the ball after it is ball 2', async () => {
    const { hr, cr, H, C, seq } = await endedByHand();
    await closes(C);
    crashed(C);
    const C2 = castcade('guest', cr.w, C.dir);
    cr.castcadeStarts();
    await C2.mh.rejoin();
    await until(() => C2.mh.status().role === 'client' && C2.mh.status().phase === 'playing' && H.mh.status().phase === 'playing');
    hr.ball(2, 900);
    await until(() => up(C2.mh, 2));
    expect(C2.mh.status().panel?.message).toBe('Your last ball is still on the table: play it out, then ball 2 begins');
    expect(owedIn(C2)).toEqual([seq]);
    cr.score(1, 1800);
    await until(() => scoreOf(H.mh, 'Guest') === 1800);
    cr.ballEnd(1);
    cr.score(1, 1900);
    await until(() => owedIn(C2).length === 0);
    await sleep(300);
    expect(up(C2.mh, 2)).toBe(true);
    expect(C2.mh.status().panel?.message ?? '').not.toContain('still on the table');
    expect(ballEndLines(C2)).toEqual([]);
    cr.ball(2, 2600);
    await until(() => up(H.mh, 3));
    expect(scoreOf(H.mh, 'Guest')).toBe(2600);
    expect(ballEndLines(C2).filter((l) => l.includes('BALL_END'))).toEqual(['match: BALL_END ball 2 score 2600']);
  }, 40_000);

  it('the host passed the turn while this player was away and the ball is still on the table at the rejoin (a game running on it): the pass is an end by hand, its drain after the rejoin reports nothing', async () => {
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
    await H.mh.passTurn();

    const C2 = castcade('guest', cr.w, C.dir);
    cr.castcadeStarts();
    await C2.mh.rejoin();
    await until(() => H.mh.status().phase === 'playing' && up(H.mh, 2));
    // The journal is read again from the start of this game (nothing was logged since): that start is not a new game.
    await until(() => owedIn(C2).length === 1);
    hr.ball(2, 900);
    await until(() => up(C2.mh, 2));
    expect(C2.mh.status().panel?.message).toBe('Your last ball is still on the table: play it out, then ball 2 begins');
    // The old ball drains only now, live, under the grant for ball 2.
    cr.ballEnd(1);
    cr.score(1, 130);
    await until(() => owedIn(C2).length === 0);
    await sleep(300);
    expect(up(C2.mh, 2)).toBe(true);
    expect(ballEndLines(C2)).toEqual([]);
    cr.ball(2, 700);
    await until(() => up(H.mh, 3));
    expect(ballEndLines(C2).filter((l) => l.includes('BALL_END'))).toEqual(['match: BALL_END ball 2 score 700']);
  }, 40_000);

  it("the host ends its own ball by hand and its Castcade restarts before the ball drained: what its table owes is in its record too, the drain while it was closed reports nothing, and its ball 2 ends with the table's next ball end", async () => {
    const { hr, cr, H, C } = await started();
    hr.gameStart();
    hr.score(1, 300);
    await until(() => H.mh.status().endBall?.score === 300);
    const seq = H.mh.status().endBall!.grantSeq;
    await H.mh.endMyBall(seq);
    await until(() => up(C.mh, 1));
    expect(owedIn(H)).toEqual([seq]);
    await closes(H);
    crashed(H);
    hr.ballEnd(1);
    hr.score(1, 350);
    const H2 = castcade('host', hr.w, H.dir);
    hr.castcadeStarts();
    await H2.mh.rejoin();
    await until(() => H2.mh.status().phase === 'playing' && up(C.mh, 1), 15_000);
    await until(() => owedIn(H2).length === 0, 15_000);
    cr.gameStart();
    cr.ball(1, 100);
    await until(() => up(H2.mh, 2), 15_000);
    await sleep(300);
    expect(up(H2.mh, 2)).toBe(true);
    expect(H2.mh.status().panel?.message ?? '').not.toContain('still on the table');
    expect(ballEndLines(H2)).toEqual([]);
    hr.ball(2, 900);
    await until(() => up(C.mh, 2), 15_000);
    expect(ballEndLines(H2).filter((l) => l.includes('BALL_END'))).toEqual(['match: BALL_END ball 2 score 900']);
  }, 60_000);
});

describe("the lobby's PC restarted (A15; A17 step 8: it is the same lobby again)", () => {
  const BACK = /^Castcade on this PC started again: the lobby [A-Z]{6} is open again as it was/;

  it("during a client's ball: the client is told the lobby's PC is away and waits, playing on; the lobby comes back under the same code with the match where it stood; the client is back by itself, and the ball end it could not report is taken, once; the match is played to its end", async () => {
    const { hr, cr, H, C } = await started();
    hr.gameStart();
    hr.ball(1, 500);
    await until(() => up(C.mh, 1));
    cr.gameStart();
    cr.score(1, 100);
    await until(() => scoreOf(H.mh, 'Guest') === 100);
    const code = H.mh.status().code;
    const rec = JSON.parse(readFileSync(H.record, 'utf8')) as { lobby: { members: { participant: { displayName: string } }[]; match: { matchId: string }; seq: { taken: Record<string, number>; sent: number } } };
    expect(rec).toMatchObject({ version: 2, role: 'host', names: ['Guest'], code, matchId: `${code}-1` });
    expect(rec.lobby.members.map((m) => m.participant.displayName)).toEqual(['Guest']);
    // The counters the lobby's PC must not fall behind are in the record: for the member, and its own (both are
    // numbers a process starts from its clock, so they are far above zero).
    const guest = C.mh.status().localId as string;
    expect(rec.lobby.seq.taken[guest]).toBeGreaterThan(1_700_000_000_000);
    expect(rec.lobby.seq.sent).toBeGreaterThan(1_700_000_000_000);
    // No private key in what is saved, and no token.
    expect(readFileSync(H.record, 'utf8')).not.toMatch(/privateKey|private_key|token|secret/i);

    await closes(H);
    crashed(H);
    await until(() => (C.mh.status().panel?.message ?? '').startsWith("Host's PC is away. The match goes on when it is back: waiting up to 20 minutes"));
    // The client's ball is its own meanwhile: it drains, the table locks at once, and the ball end is kept.
    expect(C.mh.status().locked).toBe(false);
    cr.score(1, 220);
    cr.ballEnd(1);
    cr.score(1, 260);
    await until(() => C.mh.status().locked === true);
    expect(C.mh.status().role).toBe('client');

    const H2 = castcade('host', hr.w, H.dir);
    expect(H2.mh.status().resume).toMatchObject({ role: 'host', names: ['Guest'], code, auto: true, match: true, lost: false });
    hr.castcadeStarts();
    await H2.mh.rejoin();
    // The same lobby, with its match: nothing is said to be lost.
    expect(H2.mh.status()).toMatchObject({ role: 'host', code, lobby: { match: { id: `${code}-1`, game: 1 } } });
    expect(H2.mh.status().lastError ?? '').toMatch(BACK);
    expect(H2.mh.status().lastError ?? '').not.toMatch(/lost/);
    // The client finds the listener again; the ball end it kept is reported, and the lobby's PC is up.
    await until(() => up(H2.mh, 2), 15_000);
    expect(scoreOf(H2.mh, 'Guest')).toBe(260);
    expect(C.logs.filter((l) => l.startsWith('match: BALL_END ball'))).toEqual(['match: BALL_END ball 1 score 260']);
    expect(C.logs.some((l) => l.includes('joining again as a newcomer'))).toBe(false);
    // After the restart the counts in the record stand at or above where they stood before it.
    const after = (JSON.parse(readFileSync(H2.record, 'utf8')) as typeof rec).lobby.seq;
    expect(after.taken[guest]).toBeGreaterThanOrEqual(rec.lobby.seq.taken[guest] as number);
    expect(after.sent).toBeGreaterThan(rec.lobby.seq.sent);
    expect(scoreOf(C.mh, 'Host')).toBe(500);
    expect([...H2.logs, ...C.logs].filter((l) => l.includes('FORFEIT'))).toEqual([]);

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
    expect(H2.mh.status().lobby?.match).toMatchObject({ id: `${code}-1`, game: 1, state: 'between' });
  }, 60_000);

  it('during its own ball, the ball end missed while closed: the lobby comes back, reports it once, and the client is up', async () => {
    const { hr, H, C } = await started();
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

  it('between games: the lobby comes back with the result and the tally, the client is back by itself, and the next game is the next game of the same match, started by either', async () => {
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
    hr.gameEnd(300);
    cr.gameEnd(150);
    const code = H.mh.status().code;
    await closes(H);
    crashed(H);
    const H2 = castcade('host', hr.w, H.dir);
    await H2.mh.rejoin();
    expect(H2.mh.status()).toMatchObject({ role: 'host', phase: 'over', lobby: { match: { id: `${code}-1`, game: 1, state: 'between' } } });
    expect(H2.mh.status().panel?.result?.map((r) => [r.name, r.score])).toEqual([
      ['Host', 300],
      ['Guest', 150],
    ]);
    await until(() => C.mh.status().lobby?.hostAway === null && H2.mh.status().lobby?.members.every((m) => !m.flags.includes('away')) === true, 15_000);
    expect(C.mh.status()).toMatchObject({ phase: 'over', lobby: { match: { id: `${code}-1`, state: 'between' } } });
    await C.mh.start();
    await until(() => H2.mh.status().series?.game === 2 && C.mh.status().series?.game === 2 && up(C.mh, 1), 15_000);
    expect(H2.mh.status().lobby?.match).toMatchObject({ id: `${code}-1`, game: 2, state: 'game' });
  }, 60_000);

  it("with no match open: the lobby comes back with every place kept and each member's choice; the members are back by themselves and nobody joined again as a newcomer; an update restart of the lobby's PC does not close the lobby", async () => {
    const hr = rig();
    const ar = rig();
    const br = rig();
    const H = castcade('host', hr.w);
    const A = castcade('guest', ar.w);
    const B = castcade('third', br.w);
    const hs = await H.mh.host({ port: port(), ballsPerGame: 3, displayName: 'Host' });
    await A.mh.join(hs.invite!, 'Guest');
    B.mh.setStance('watch');
    await B.mh.join(hs.invite!, 'Third');
    await until(() => H.mh.status().participants.length === 3);
    expect(JSON.parse(readFileSync(H.record, 'utf8'))).toMatchObject({ role: 'host', matchId: null, log: [], names: ['Guest', 'Third'] });
    // Castcade restarts itself for an update on the lobby's PC: nobody is told the lobby is closed.
    await H.mh.stop({ keepForRestart: true });
    expect(JSON.parse(readFileSync(H.record, 'utf8'))).toMatchObject({ restart: 'update' });
    await until(() => A.mh.status().lobby?.hostAway != null && B.mh.status().lobby?.hostAway != null);
    expect([A, B].map((x) => x.mh.status().role)).toEqual(['client', 'client']);
    expect(A.mh.status().panel?.message ?? '').toMatch(/^Host's PC is away\. The lobby goes on when it is back/);

    const H2 = castcade('host', hr.w, H.dir);
    expect(H2.mh.status().resume).toMatchObject({ role: 'host', auto: true, match: false, lost: false });
    await H2.mh.rejoin();
    expect(H2.mh.status()).toMatchObject({ role: 'host', phase: 'lobby', code: hs.code });
    expect(H2.mh.status().lobby?.members.map((m) => [m.name, m.stance])).toEqual([
      ['Host', 'play'],
      ['Guest', 'play'],
      ['Third', 'watch'],
    ]);
    await until(() => [A, B].every((x) => x.mh.status().lobby?.hostAway === null) && H2.mh.status().lobby?.members.every((m) => !m.flags.includes('away')) === true, 20_000);
    expect([...A.logs, ...B.logs].some((l) => l.includes('joining again as a newcomer'))).toBe(false);
    // A match starts in it as in any lobby, numbered as this lobby's first.
    await A.mh.start();
    await until(() => up(A.mh, 1) && H2.mh.status().phase === 'playing', 15_000);
    expect(H2.mh.status().lobby?.match?.id).toBe(`${hs.code}-1`);
    expect(B.mh.status().panel?.players.map((x) => x.name)).toEqual(['Guest', 'Host']);
  }, 60_000);

  it("the lobby's PC only watched the match: it comes back as the lobby's PC of that match, in no roster, and arbitrates on", async () => {
    const hr = rig();
    const ar = rig();
    const br = rig();
    const H = castcade('host', hr.w);
    const A = castcade('guest', ar.w);
    const B = castcade('third', br.w);
    const hs = await H.mh.host({ port: port(), ballsPerGame: 3, displayName: 'Host' });
    await A.mh.join(hs.invite!, 'Guest');
    await B.mh.join(hs.invite!, 'Third');
    await until(() => H.mh.status().participants.length === 3);
    H.mh.setStance('watch');
    await until(() => A.mh.status().lobby?.members.find((m) => m.name === 'Host')?.stance === 'watch');
    await A.mh.start();
    await until(() => up(A.mh, 1) && H.mh.status().phase === 'playing');
    ar.gameStart();
    ar.score(1, 40);
    await closes(H);
    crashed(H);
    const H2 = castcade('host', hr.w, H.dir);
    await H2.mh.rejoin();
    expect(H2.mh.status()).toMatchObject({ role: 'host', lobby: { stance: 'watch', match: { id: `${hs.code}-1`, state: 'game' } } });
    expect(H2.mh.status().panel?.players.map((x) => x.name)).toEqual(['Guest', 'Third']);
    // (No grace in these tests: until the player who is up is back on a link, the lobby's PC says it waits for them.)
    await until(() => H2.mh.status().phase === 'playing', 20_000);
    // The ball of the player who was up through all of it ends and is taken; the turn goes on to the other player.
    ar.ball(1, 90);
    await until(() => up(B.mh, 1), 20_000);
    expect(scoreOf(H2.mh, 'Guest')).toBe(90);
    expect(H2.mh.status().panel?.myTurn).toBe(false);
  }, 60_000);

  it('a record that does not read in full (its own check fails): the card says so before the press; the code is opened again as an empty lobby, the client joins it again as a newcomer, and the match that was open is lost, which both are told; the next match is numbered after it', async () => {
    const { hr, cr, H, C } = await started();
    hr.gameStart();
    hr.ball(1, 500);
    await until(() => up(C.mh, 1));
    const code = H.mh.status().code;
    await closes(H);
    crashed(H);
    // One figure of the saved lobby is changed on disk: the record no longer agrees with its own check.
    const text = readFileSync(H.record, 'utf8');
    expect(text).toContain('"nextMatch":2');
    writeFileSync(H.record, text.replace('"nextMatch":2', '"nextMatch":9'));
    const H2 = castcade('host', hr.w, H.dir);
    expect(H2.mh.status().resume).toMatchObject({ role: 'host', code, match: true, lost: true });
    await H2.mh.rejoin();
    expect(H2.mh.status()).toMatchObject({ role: 'host', code, phase: 'lobby', lobby: { match: null } });
    const LOST = new RegExp(`^Castcade on this PC started again, and the saved lobby did not read in full: the lobby ${code} is open again, empty, under its code\\. The others come back by themselves as newcomers; the match that was being played is lost\\.$`);
    expect(H2.mh.status().lastError ?? '').toMatch(LOST);
    expect(H2.mh.status().panel?.message ?? '').toMatch(LOST);
    await until(() => H2.mh.status().participants.length === 2 && C.mh.status().phase === 'lobby' && C.mh.status().lobby?.hostAway === null, 15_000);
    expect(C.logs.some((l) => l.includes("this PC's place in the lobby had run out while it was away; joining again as a newcomer"))).toBe(true);
    cr.gameEnd(0);
    hr.gameEnd(500);
    await until(() => H2.mh.status().lobby?.members.every((m) => !m.flags.includes('own_game')) === true);
    await H2.mh.start();
    await until(() => up(H2.mh, 1) && C.mh.status().phase === 'playing');
    expect(H2.mh.status().lobby?.match?.id).toBe(`${code}-2`);
  }, 60_000);

  it("a lobby's PC that does not come back: after the wait the lobby is closed for the client with the reason, its table is unlocked and nothing is kept", async () => {
    const { hr, cr, H, C } = await started({ hostWaitMs: 2500, seriesOverLingerMs: 300 });
    hr.gameStart();
    hr.score(1, 200);
    await until(() => scoreOf(C.mh, 'Host') === 200);
    expect(existsSync(C.lock)).toBe(true);
    await closes(H);
    await until(() => (C.mh.status().panel?.message ?? '').startsWith("Host's PC is away. The match goes on when it is back"));
    await until(() => C.mh.status().role === 'none', 15_000);
    expect(C.mh.status().lastError).toBe("The lobby is closed: Host's PC did not come back");
    expect(existsSync(C.lock)).toBe(false);
    expect(existsSync(C.record)).toBe(false);
    void cr;
  }, 40_000);

  it("the record of a lobby's PC is only good for as long as its members wait (twenty minutes)", async () => {
    const { hr, H } = await started();
    hr.gameStart();
    await closes(H);
    crashed(H, HOST_WAIT_MS + 30_000);
    const H2 = castcade('host', hr.w, H.dir);
    expect(H2.mh.status().resume).toBeNull();
    expect(existsSync(H2.record)).toBe(false);
  }, 40_000);

  it("the lobby's PC is quit with somebody present in its lobby (the review of PR 138): there is a question to ask; Keep: the others read that Castcade was closed there and that the lobby is kept, and at the next start the lobby is offered, never gone back into by itself; Close: everyone is told it is closed; with everybody else away, or alone, a quit closes it", async () => {
    const { hr, H, C } = await started();
    hr.gameStart();
    expect(H.mh.quitQuestion()).toEqual({ code: H.mh.status().code, names: ['Guest'], away: [] });
    expect(C.mh.quitQuestion()).toBeNull();
    await H.mh.stop({ lobby: 'keep' });
    expect(JSON.parse(readFileSync(H.record, 'utf8'))).toMatchObject({ role: 'host', restart: 'quit' });
    // The others were told before the link went: not the line of a PC that is away for no known reason.
    await until(() => C.mh.status().lobby?.hostAway != null);
    expect(C.mh.status().role).toBe('client');
    expect(C.mh.status().panel?.message).toMatch(/^Host closed Castcade and kept the lobby: it goes on if Host opens Castcade again within 20 minutes \(\d+ min left\)\. You can wait and keep talking; Leave lobby frees your table now\.$/);
    // The next start, a few seconds later: offered, not gone back into (the microphone stays off until the click).
    const H2 = castcade('host', hr.w, H.dir);
    expect(H2.mh.status().resume).toMatchObject({ role: 'host', auto: false, lost: false, match: true });
    expect(H2.mh.status().role).toBe('none');
    await H2.mh.rejoin();
    await until(() => C.mh.status().lobby?.hostAway === null, 15_000);
    // (The line is the ordinary one again when this PC is next away for no known reason: the word was the last word of that run.)
    expect(C.mh.status().panel?.message ?? '').not.toMatch(/closed Castcade/);
    // Close the lobby for everyone: told at once, and the record ends.
    expect(H2.mh.quitQuestion()).not.toBeNull();
    await H2.mh.stop({ lobby: 'close' });
    expect(existsSync(H2.record)).toBe(false);
    await until(() => (C.mh.status().panel?.message ?? C.mh.status().lastError ?? '').includes('closed the lobby'));

    // The final review (finding 2): the only other member is away at the moment of the quit (their PC is restarting).
    // They have a place: the question is asked about them, and Keep keeps the lobby. It closed the lobby for
    // everyone, with no question, because nobody was "present".
    const t = await started();
    await t.C.mh.stop({ keepForRestart: true });
    await until(() => t.H.mh.status().lobby?.members.find((m) => m.name === 'Guest')?.flags.includes('away') === true);
    expect(t.H.mh.quitQuestion()).toEqual({ code: t.H.mh.status().code, names: [], away: ['Guest'] });
    await t.H.mh.stop({ lobby: 'keep' });
    expect(JSON.parse(readFileSync(t.H.record, 'utf8'))).toMatchObject({ role: 'host', restart: 'quit' });
    // The lobby is offered at the next start, with its match; the member who was away can come back into it.
    const T2 = castcade('host', t.hr.w, t.H.dir);
    expect(T2.mh.status().resume).toMatchObject({ role: 'host', auto: false, lost: false, match: true });
    await T2.mh.stop();
    // The friend's link drops while the owner reads the question, and the owner answers Keep: kept all the same.
    const u = await started();
    expect(u.H.mh.quitQuestion()).toMatchObject({ names: ['Guest'], away: [] });
    await u.C.mh.stop({ keepForRestart: true });
    await until(() => u.H.mh.status().lobby?.members.find((m) => m.name === 'Guest')?.flags.includes('away') === true);
    await u.H.mh.stop({ lobby: 'keep' });
    expect(JSON.parse(readFileSync(u.H.record, 'utf8'))).toMatchObject({ role: 'host', restart: 'quit' });
    // Close the lobby for everyone closes it whoever is present.
    const v = await started();
    await v.C.mh.stop({ keepForRestart: true });
    await until(() => v.H.mh.status().lobby?.members.find((m) => m.name === 'Guest')?.flags.includes('away') === true);
    await v.H.mh.stop({ lobby: 'close' });
    expect(existsSync(v.H.record)).toBe(false);
    // Alone in a lobby: the same.
    const sr = rig();
    const S = castcade('solo', sr.w);
    await S.mh.host({ port: port(), ballsPerGame: 3, displayName: 'Solo' });
    expect(S.mh.quitQuestion()).toBeNull();
    await S.mh.stop();
    expect(existsSync(S.record)).toBe(false);
  }, 60_000);

  it("the final review: a kept quit whose record cannot be written is never gone back into by itself. The record on disk was the one of a minute before, with no word of the quit: a start within the minute went back into the lobby, microphone on. It is taken away, and the next start offers nothing", async () => {
    const { hr, H } = await started();
    expect(JSON.parse(readFileSync(H.record, 'utf8'))).toMatchObject({ role: 'host', restart: null });
    // The record cannot be written any more: a folder stands where its temporary file goes.
    mkdirSync(`${H.record}.tmp`);
    await H.mh.stop({ lobby: 'keep' });
    expect(H.logs.some((l) => l.includes('its record could not be written'))).toBe(true);
    expect(existsSync(H.record)).toBe(false);
    rmSync(`${H.record}.tmp`, { recursive: true, force: true });
    const H2 = castcade('host', hr.w, H.dir);
    expect(H2.mh.status().resume).toBeNull();
    expect(H2.mh.status().role).toBe('none');
  }, 60_000);

  it("the review of PR 138: a ball ends in the seconds Castcade takes to close on the lobby's PC (a kept quit, or an update): the engine had stopped taking frames before the last record was written, so that ball end is in nobody's log but its player's own PC, which kept it; after the start again it is taken, once, and the turn goes on. Nothing the lobby's PC acknowledged is missing from what it came back with", async () => {
    let slow = 0;
    const { hr, cr, H, C } = await started({ media: slowMedia(() => slow) });
    hr.gameStart();
    hr.ball(1, 500);
    await until(() => up(C.mh, 1));
    cr.gameStart();
    cr.score(1, 100);
    await until(() => scoreOf(H.mh, 'Guest') === 100);
    // Closing takes more than half a second from here on.
    slow = 700;
    const stopping = H.mh.stop({ keepForRestart: true });
    await sleep(150);
    // The guest's ball ends while the lobby PC's Castcade is still closing its panel and its connections.
    cr.ballEnd(1);
    cr.score(1, 260);
    await stopping;
    slow = 0;
    // What the lobby's PC saved is what it had taken: the guest's ball end is not in it, and was never acknowledged.
    const rec = JSON.parse(readFileSync(H.record, 'utf8')) as { log: { message?: { type: string; from: string } }[] };
    expect(rec.log.filter((e) => e.message?.type === 'BALL_END').map((e) => e.message?.from)).toHaveLength(1);
    const H2 = castcade('host', hr.w, H.dir);
    hr.castcadeStarts();
    await H2.mh.rejoin();
    await until(() => up(H2.mh, 2), 15_000);
    expect(scoreOf(H2.mh, 'Guest')).toBe(260);
    await until(() => C.mh.status().panel?.myTurn === false && C.mh.status().locked === true);
    // The guest was not sent back to a ball it had played, and nobody read that the match went back.
    expect(C.logs.filter((l) => l.includes('begins:'))).toHaveLength(1);
    expect([...C.logs, ...H2.logs].filter((l) => l.includes('earlier state'))).toEqual([]);
    expect(C.logs.filter((l) => l.startsWith('match: BALL_END ball'))).toEqual(['match: BALL_END ball 1 score 260']);
  }, 60_000);
});

describe("the lobby's PC comes back from a record that is behind what it had done (a real crash; the review of PR 138)", () => {
  const WENT_BACK_HOST = /^This PC came back with an earlier state of the match than Guest had \(Castcade closed before the last moves were saved\): the match goes on from what was saved, and what was played since does not count\.$/;
  const WENT_BACK_MEMBER = /^Host came back with an earlier state of this match \(its Castcade closed before the last moves were saved\): the match goes on from there, and what was played since does not count\.$/;

  it("a ball end in the gap: the guest's ball end was taken and the lobby's PC was up on its next ball when it crashed, with the record still at the guest's ball: the guest is given the lobby's log, is up on that ball again with its table unlocked, and both read that the match went back; the game is played on from there", async () => {
    const { hr, cr, H, C } = await started();
    hr.gameStart();
    hr.ball(1, 500);
    await until(() => up(C.mh, 1));
    cr.gameStart();
    cr.score(1, 100);
    await until(() => scoreOf(H.mh, 'Guest') === 100);
    await crashBehind(H, async () => {
      cr.ball(1, 260);
      await until(() => up(H.mh, 2));
      expect(existsSync(C.lock)).toBe(true);
    });
    const H2 = castcade('host', hr.w, H.dir);
    hr.castcadeStarts();
    await H2.mh.rejoin();
    await until(() => up(C.mh, 1) && C.mh.status().lobby?.hostAway === null, 15_000);
    // One state on both PCs, and a sentence that is true on each.
    expect(C.mh.status().locked).toBe(false);
    expect(existsSync(C.lock)).toBe(false);
    expect(C.mh.status().lastError ?? '').toMatch(WENT_BACK_MEMBER);
    await until(() => WENT_BACK_HOST.test(H2.mh.status().lastError ?? ''));
    expect(H2.mh.status().panel).toMatchObject({ myTurn: false, playerUp: C.mh.status().localId });
    expect(scoreOf(H2.mh, 'Host')).toBe(500);
    // The guest plays the ball that counts now; the turn goes on, and the two logs stay one.
    cr.ball(2, 400);
    await until(() => up(H2.mh, 2), 15_000);
    expect(scoreOf(H2.mh, 'Guest')).toBe(400);
    hr.ball(2, 900);
    await until(() => up(C.mh, 2));
    expect([...H2.logs, ...C.logs].filter((l) => l.includes('desync') || l.includes('FORFEIT'))).toEqual([]);
  }, 60_000);

  it("a grant in the gap: the lobby PC's own ball had ended and the guest was given the turn when it crashed, with the record still at its own ball: it comes back on its own ball, the end its table had is reported once, the guest (who was playing) is given the turn again and keeps its table, and reads that the match went back", async () => {
    const { hr, cr, H, C } = await started();
    hr.gameStart();
    hr.score(1, 300);
    await until(() => scoreOf(C.mh, 'Host') === 300);
    await crashBehind(H, async () => {
      hr.ball(1, 500);
      await until(() => up(C.mh, 1));
      cr.gameStart();
      cr.score(1, 100);
      await sleep(100);
    });
    const H2 = castcade('host', hr.w, H.dir);
    hr.castcadeStarts();
    await H2.mh.rejoin();
    // Its own ball 1 ended on its table while the record knew nothing of it: reported now, for the grant issued again.
    await until(() => WENT_BACK_MEMBER.test(C.mh.status().lastError ?? ''), 15_000);
    await until(() => up(C.mh, 1) && C.mh.status().lobby?.hostAway === null && scoreOf(C.mh, 'Host') === 500, 15_000);
    expect(H2.logs.filter((l) => l.startsWith('match: BALL_END ball'))).toEqual(['match: BALL_END ball 1 score 500']);
    expect(C.mh.status().locked).toBe(false);
    // The guest goes on with the ball it was on; its end counts, once.
    cr.ball(1, 250);
    await until(() => up(H2.mh, 2), 15_000);
    expect(scoreOf(H2.mh, 'Guest')).toBe(250);
    expect([...H2.logs, ...C.logs].filter((l) => l.includes('desync') || l.includes('FORFEIT'))).toEqual([]);
  }, 60_000);

  it('a choice in the gap (no match open): a member set itself to Watch after the last save; the lobby comes back with the older choice, the member says its row again at its return, and the lobby holds the choice it has now; nothing is said to be lost, because nothing is', async () => {
    const hr = rig();
    const cr = rig();
    const H = castcade('host', hr.w);
    const C = castcade('guest', cr.w);
    const hs = await H.mh.host({ port: port(), ballsPerGame: 3, displayName: 'Host' });
    await C.mh.join(hs.invite!, 'Guest');
    await until(() => H.mh.status().participants.length === 2);
    await crashBehind(H, async () => {
      C.mh.setStance('watch');
      await until(() => H.mh.status().lobby?.members.find((m) => m.name === 'Guest')?.stance === 'watch');
    });
    const H2 = castcade('host', hr.w, H.dir);
    await H2.mh.rejoin();
    expect(H2.mh.status().lobby?.members.find((m) => m.name === 'Guest')?.stance).toBe('play');
    await until(() => C.mh.status().lobby?.hostAway === null && H2.mh.status().lobby?.members.find((m) => m.name === 'Guest')?.stance === 'watch', 15_000);
    // (The member's own tab follows the lobby's word, which says Watch again one answer later.)
    await until(() => C.mh.status().lobby?.stance === 'watch');
    expect(H2.mh.status().lobby?.startButton.off).toBe('Two people have to be set to Play.');
    expect([...H2.logs, ...C.logs].filter((l) => l.includes('earlier state'))).toEqual([]);
    expect(H2.mh.status().lastError ?? '').toMatch(/^Castcade on this PC started again: the lobby [A-Z]{6} is open again as it was\. The others come back by themselves\.$/);
  }, 60_000);
});

describe('a member who is not playing restarts (A17 step 8)', () => {
  it('a watcher of the open match: a record is written from the join; after a crash they are offered the lobby and go back into it by themselves, watching the match where it is now; their choice is still Watch', async () => {
    const hr = rig();
    const ar = rig();
    const wr = rig();
    const H = castcade('host', hr.w);
    const A = castcade('guest', ar.w);
    const W = castcade('watcher', wr.w);
    const hs = await H.mh.host({ port: port(), ballsPerGame: 3, displayName: 'Host' });
    await A.mh.join(hs.invite!, 'Guest');
    W.mh.setStance('watch');
    await W.mh.join(hs.invite!, 'Third');
    await until(() => H.mh.status().participants.length === 3);
    expect(JSON.parse(readFileSync(W.record, 'utf8'))).toMatchObject({ version: 2, role: 'client', stance: 'watch', matchId: null, lobby: null, names: ['Host', 'Guest'] });
    await H.mh.start();
    await until(() => up(H.mh, 1) && W.mh.status().phase === 'playing');
    hr.gameStart();
    hr.score(1, 70);
    await until(() => scoreOf(W.mh, 'Host') === 70);
    const wid = W.mh.status().localId;
    const seen: string[] = [];
    const off = H.mh.onStatus((s) => void seen.push(`${s.phase}/${s.locked}`));
    await closes(W);
    crashed(W);
    const W2 = castcade('watcher', wr.w, W.dir);
    expect(W2.mh.status().resume).toMatchObject({ role: 'client', names: ['Host', 'Guest'], auto: true, match: true });
    await W2.mh.rejoin();
    await until(() => W2.mh.status().phase === 'playing' && H.mh.status().lobby?.members.find((m) => m.name === 'Third')?.flags.includes('away') === false, 15_000);
    expect(W2.mh.status()).toMatchObject({ role: 'client', localId: wid, locked: true, lobby: { stance: 'watch', match: { id: `${hs.code}-1` } } });
    expect(W2.mh.status().panel?.players.map((x) => x.name)).toEqual(['Host', 'Guest']);
    expect(H.mh.status().lobby?.members.map((m) => m.name)).toEqual(['Host', 'Guest', 'Third']);
    off();
    // The player who is up was not paused or locked for any of it.
    expect([...new Set(seen)]).toEqual(['playing/false']);
    expect(existsSync(W2.record)).toBe(true);
    // Leave lobby ends the record: no PC goes back into a lobby it left.
    await W2.mh.leave();
    expect(existsSync(W2.record)).toBe(false);
    const W3 = castcade('watcher', wr.w, W.dir);
    expect(W3.mh.status().resume).toBeNull();
  }, 60_000);

  it('with no match open: a member whose Castcade restarts for an update is back in the lobby by itself, in its place, and a match can start with them', async () => {
    const hr = rig();
    const ar = rig();
    const H = castcade('host', hr.w);
    const A = castcade('guest', ar.w);
    const hs = await H.mh.host({ port: port(), ballsPerGame: 3, displayName: 'Host' });
    await A.mh.join(hs.invite!, 'Guest');
    await until(() => H.mh.status().participants.length === 2);
    const aid = A.mh.status().localId;
    await A.mh.stop({ keepForRestart: true });
    expect(JSON.parse(readFileSync(A.record, 'utf8'))).toMatchObject({ role: 'client', matchId: null, restart: 'update' });
    // Not a leave: the place is kept.
    await until(() => H.mh.status().lobby?.members.find((m) => m.name === 'Guest')?.flags.includes('away') === true);
    const A2 = castcade('guest', ar.w, A.dir);
    expect(A2.mh.status().resume).toMatchObject({ role: 'client', auto: true, match: false });
    await A2.mh.rejoin();
    expect(A2.mh.status()).toMatchObject({ role: 'client', phase: 'lobby', localId: aid });
    await until(() => H.mh.status().lobby?.members.find((m) => m.name === 'Guest')?.flags.includes('away') === false);
    expect(H.mh.status().participants).toHaveLength(2);
    await H.mh.start();
    await until(() => up(H.mh, 1) && A2.mh.status().phase === 'playing', 15_000);
  }, 60_000);

  it("a record saved with another match key is not this PC's: it is dropped, and said", async () => {
    const hr = rig();
    const ar = rig();
    const H = castcade('host', hr.w);
    const A = castcade('guest', ar.w);
    const hs = await H.mh.host({ port: port(), ballsPerGame: 3, displayName: 'Host' });
    await A.mh.join(hs.invite!, 'Guest');
    await until(() => H.mh.status().participants.length === 2);
    await closes(A);
    crashed(A);
    // The keys of this PC are others now (match-keys.json was replaced).
    rmSync(join(A.dir, 'match-keys.json'), { force: true });
    const A2 = castcade('guest', ar.w, A.dir);
    await expect(A2.mh.rejoin()).rejects.toThrow("The saved lobby was not saved with this PC's match keys: it cannot be gone back into");
    expect(A2.mh.status().resume).toBeNull();
    expect(existsSync(A2.record)).toBe(false);
  }, 40_000);

  it("the review of PR 138: a record that cannot be written is said on that PC, once, with the folder and the system's own words, and tried again at every change; the lobby goes on; when it can be written again nothing more is said", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'castcade-restart-nowrite-'));
    dirs.push(dir);
    // The record's folder cannot be made: a file stands where it should be.
    writeFileSync(join(dir, 'blocked'), 'x');
    const hr = rig();
    const cr = rig();
    const H = castcade('host', hr.w, dir, { resumeFile: join(dir, 'blocked', RESUME_FILE) });
    const C = castcade('guest', cr.w);
    const hs = await H.mh.host({ port: port(), ballsPerGame: 3, displayName: 'Host' });
    const said = H.mh.status().lastError ?? '';
    expect(said).toMatch(/^Castcade cannot save this lobby \(the folder .*blocked: .+\)\. The lobby goes on\. If Castcade closes before it can be saved again, it comes back as it was last saved, or not at all\.$/);
    await C.mh.join(hs.invite!, 'Guest');
    await until(() => H.mh.status().participants.length === 2);
    await H.mh.start();
    await until(() => up(H.mh, 1) && C.mh.status().phase === 'playing');
    hr.gameStart();
    hr.ball(1, 100);
    await until(() => up(C.mh, 1));
    // Many changes later: said once, in the log too; the match was not touched by it.
    expect(H.logs.filter((l) => l.includes('Castcade cannot save this lobby'))).toHaveLength(1);
    expect(existsSync(join(dir, 'blocked', RESUME_FILE))).toBe(false);
    // The folder can be made now: the next change is saved, and that is logged, once.
    rmSync(join(dir, 'blocked'), { force: true });
    cr.gameStart();
    cr.ball(1, 50);
    await until(() => up(H.mh, 2));
    expect(existsSync(join(dir, 'blocked', RESUME_FILE))).toBe(true);
    expect(H.logs.filter((l) => l.includes('is saved again'))).toHaveLength(1);
  }, 40_000);

  it('a record of version 1 (a match on Castcade 0.2.50 or older): nothing is offered and nothing is tried; the Match tab and the log say what it was, and the file is removed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'castcade-restart-old-'));
    dirs.push(dir);
    const record = join(dir, RESUME_FILE);
    writeFileSync(record, JSON.stringify({ version: 1, role: 'client', code: 'JHDFEF', invite: 'JHDFEF', port: null, relay: true, playerId: 'p1', displayName: 'Guest', names: ['Krobs'], log: [{ nonsense: true }], mark: null, aliveAt: Date.now() - 5000, restart: 'update', owed: [] }));
    const r = rig();
    const C = castcade('guest', r.w, dir);
    const said = 'Castcade closed during the match JHDFEF with Krobs, which was played on an older Castcade (protocol 6). This version cannot go back into it: open a lobby, or join one, and play on from there.';
    expect(C.mh.status()).toMatchObject({ role: 'none', resume: null, lastError: said });
    expect(C.logs.some((l) => l.includes(said))).toBe(true);
    expect(existsSync(record)).toBe(false);
    await expect(C.mh.rejoin()).rejects.toThrow('There is no lobby to go back into any more');
  }, 20_000);
});

describe('Castcade restarting itself for an update during a match (A15)', () => {
  it('the match is not left: the record says so, and the next start rejoins without asking however long the installer took', async () => {
    const { hr, cr, H, C } = await started();
    hr.gameStart();
    hr.score(1, 200);
    await until(() => scoreOf(C.mh, 'Host') === 200);
    await C.mh.stop({ keepForRestart: true });
    expect(JSON.parse(readFileSync(C.record, 'utf8'))).toMatchObject({ restart: 'update' });
    // Not a forfeit: the player is away, and (A18) the host's own ball goes on meanwhile.
    await until(() => H.mh.status().panel?.players.find((p) => p.name === 'Guest')?.flags.includes('disconnected') === true);
    expect(H.mh.status().phase).toBe('playing');
    expect(H.logs.some((l) => l.includes('FORFEIT'))).toBe(false);
    rewrite(C.record, { aliveAt: Date.now() - 4 * 60_000 });
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
  async function relayed(hostGraceMs: number, clientExtra: Partial<Options> = {}) {
    const r = await startFakeRelay({ devices: { 'dev-h': 'tok-h', 'dev-c': 'tok-c' }, hostGraceMs });
    const via = (id: string): Partial<Options> => ({ relay: () => ({ baseUrl: r.url, deviceId: `dev-${id}`, deviceToken: `tok-${id}` }), relayTimeouts: { connectMs: 1500, ackMs: 1500 } });
    const hr = rig();
    const cr = rig();
    const H = castcade('relay-host', hr.w, undefined, via('h'));
    const C = castcade('relay-guest', cr.w, undefined, { ...via('c'), ...clientExtra });
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

  it('a client comes back through ArcAid into the room (A17 step 7: it is never locked) with the code it joined with, and a missed ball end lands', async () => {
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

  it("the review of PR 138: ArcAid does not answer in the moment the lobby's PC starts again (a deploy, the network not up yet): the lobby stays ArcAid's; its PC says it is waiting for ArcAid, counts nobody as away meanwhile, takes its room back when ArcAid answers, and the member returns into the match by itself; the record says `relay` all the while", async () => {
    const m = await relayed(300, { relayRejoin: { gapsMs: [300, 600, 2000], maxMisses: 60 } });
    try {
      await closes(m.H);
      crashed(m.H);
      await until(() => m.r.rooms().length === 0);
      const down = m.r.restart(3000);
      await sleep(200);
      const H2 = castcade('relay-host', m.hr.w, m.H.dir, m.via('h'));
      m.hr.castcadeStarts();
      await H2.mh.rejoin();
      // Still a lobby through ArcAid, and it says what is true: it waits for ArcAid.
      expect(H2.mh.status()).toMatchObject({ role: 'host', code: m.code, via: 'relay' });
      expect(H2.mh.status().lastError ?? '').toMatch(/is open again as it was, with the game where it stood\. Castcade is waiting for ArcAid to carry it again: the others can come back once it does\.$/);
      expect(H2.mh.status().relayNote ?? '').toMatch(/^ArcAid is not carrying this lobby yet/);
      expect(JSON.parse(readFileSync(H2.record, 'utf8'))).toMatchObject({ relay: true });
      // Nobody is away, paused for, or on a clock while ArcAid is: this PC is the one that cannot be reached.
      await sleep(1500);
      expect(H2.mh.status().lobby?.members.flatMap((x) => x.flags)).not.toContain('away');
      expect(H2.mh.status().phase).toBe('playing');
      await down;
      await until(() => m.r.rooms().includes(m.code), 20_000);
      await until(() => H2.mh.status().relayNote === null);
      await until(() => m.C.mh.status().lobby?.hostAway === null && up(m.C.mh, 1), 30_000);
      m.cr.ball(1, 180);
      await until(() => up(H2.mh, 2));
      expect(scoreOf(H2.mh, 'Guest')).toBe(180);
      expect(JSON.parse(readFileSync(H2.record, 'utf8'))).toMatchObject({ relay: true });
      expect([...H2.logs, ...m.C.logs].filter((l) => l.includes('FORFEIT'))).toEqual([]);
    } finally {
      for (const h of hosts.splice(0)) await h.stop();
      await m.r.close();
    }
  }, 90_000);

  it("the lobby's PC comes back after ArcAid closed its room: it opens the same code again, and the client's own asks find it: the same lobby, the match where it stood; the room is not locked", async () => {
    const m = await relayed(300);
    try {
      await closes(m.H);
      crashed(m.H);
      await until(() => (m.C.mh.status().panel?.message ?? '').startsWith("Host's PC is away. The match goes on when it is back"));
      // The room outlived its host by 300 ms here (30 s on ArcAid): it is gone when the host is back.
      await until(() => m.r.rooms().length === 0);
      await sleep(500);
      const H2 = castcade('relay-host', m.hr.w, m.H.dir, m.via('h'));
      m.hr.castcadeStarts();
      await H2.mh.rejoin();
      expect(H2.mh.status()).toMatchObject({ role: 'host', code: m.code, via: 'relay', lobby: { match: { id: `${m.code}-1`, state: 'game' } } });
      expect(m.r.rooms()).toEqual([m.code]);
      // The client asks for the room again (at once, 5 s and 30 s later, then every 150 s: `LOBBY_REJOIN`), finds
      // it, and is back in the match it never left: its ball is its own still.
      await until(() => m.C.mh.status().lobby?.hostAway === null && up(m.C.mh, 1), 40_000);
      expect(m.C.logs.some((l) => l.includes('joining again as a newcomer'))).toBe(false);
      m.cr.ball(1, 180);
      await until(() => up(H2.mh, 2));
      expect(scoreOf(H2.mh, 'Guest')).toBe(180);
      expect(m.r.locked(m.code)).toBe(false);
      // Few asks for a room that was gone: far under ArcAid's eight in ten minutes.
      expect(m.r.misses.get('dev-c') ?? 0).toBeLessThanOrEqual(5);
    } finally {
      for (const h of hosts.splice(0)) await h.stop();
      await m.r.close();
    }
  }, 90_000);

  it("A17 step 9: the lobby's PC is quit through ArcAid with somebody present: the question is there; Keep leaves the room without closing it, so ArcAid holds it for its own half minute and then closes it; the member, told that the lobby is kept, waits on past that; at its next start the lobby's PC is offered the lobby, opens it under the same code, and the member is back by themselves. Close ends the room at once", async () => {
    // ArcAid's 30 s after a host is gone are 400 ms here.
    const m = await relayed(400, { relayRejoin: { gapsMs: [300, 600, 2000], maxMisses: 60 } });
    try {
      expect(m.H.mh.quitQuestion()).toEqual({ code: m.code, names: ['Guest'], away: [] });
      expect(m.C.mh.quitQuestion()).toBeNull();
      await m.H.mh.stop({ lobby: 'keep' });
      expect(JSON.parse(readFileSync(m.H.record, 'utf8'))).toMatchObject({ role: 'host', restart: 'quit', relay: true, code: m.code });
      // Told before the link went: the sentence of a kept quit, not of a PC that is away for no known reason.
      await until(() => m.C.mh.status().lobby?.hostAway != null);
      expect(m.C.mh.status().panel?.message).toMatch(/^Host closed Castcade and kept the lobby: it goes on if Host opens Castcade again within 20 minutes/);
      // The room was left open (a closed room would have told the member "the lobby is closed"); ArcAid closes it
      // after its own wait, and the member goes on waiting: the lobby's 20 minutes are the companion's, not ArcAid's.
      await until(() => m.r.rooms().length === 0);
      await sleep(800);
      expect(m.C.mh.status()).toMatchObject({ role: 'client', code: m.code });
      expect(m.C.mh.status().lobby?.over).toBe(false);
      expect(m.C.mh.status().panel?.message).toMatch(/^Host closed Castcade and kept the lobby/);
      // The next start: offered, not gone back into; the click opens the same lobby under the same code.
      const H2 = castcade('relay-host', m.hr.w, m.H.dir, m.via('h'));
      m.hr.castcadeStarts();
      expect(H2.mh.status().resume).toMatchObject({ role: 'host', auto: false, lost: false });
      expect(H2.mh.status().role).toBe('none');
      expect(m.r.rooms()).toEqual([]);
      await H2.mh.rejoin();
      expect(H2.mh.status()).toMatchObject({ role: 'host', code: m.code, via: 'relay' });
      expect(m.r.rooms()).toEqual([m.code]);
      await until(() => m.C.mh.status().lobby?.hostAway === null, 40_000);
      expect(m.C.logs.some((l) => l.includes('joining again as a newcomer'))).toBe(false);
      // The sentence of the kept quit goes with the next thing the member's panel says.
      await until(() => !/closed Castcade/.test(m.C.mh.status().panel?.message ?? ''), 20_000);
      // Close the lobby for everyone: the room is closed by its host, the member is told, nothing is kept.
      await until(() => H2.mh.quitQuestion() !== null, 20_000);
      await H2.mh.stop({ lobby: 'close' });
      expect(existsSync(H2.record)).toBe(false);
      await until(() => m.r.rooms().length === 0);
      await until(() => (m.C.mh.status().panel?.message ?? m.C.mh.status().lastError ?? '').includes('closed the lobby'));
    } finally {
      for (const h of hosts.splice(0)) await h.stop();
      await m.r.close();
    }
  }, 120_000);
});
