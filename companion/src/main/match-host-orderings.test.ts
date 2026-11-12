/**
 * A14 step 3 (2026-11-12): any order works. Two match hosts on localhost over real WebSockets (Electron stubbed), each
 * with a witness the test drives like a rig: a table opens, closes, a game starts and ends. One test per ordering of
 * the audit in docs/design/alpha-match.md §9; the launch and link side of the same orderings is `one-step.test.ts`.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
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
const { isTableOpen } = await import('./match-setup.js');
type MatchHost = ReturnType<typeof createMatchHost>;
type WitnessHost = Parameters<typeof createMatchHost>[0]['witness'];
type Logger = Parameters<typeof createMatchHost>[0]['log'];
type WStatus = ReturnType<WitnessHost['status']>;
type Feed = Parameters<Parameters<WitnessHost['onEvent']>[0]>[0];

const SHA = 'ab'.repeat(32);

/** A rig's witness: no table until `open`; `feed` is the detector; `close` is VPX exiting. */
function rig(start: { table?: boolean; inGame?: boolean } = {}) {
  const statusCbs = new Set<(s: WStatus) => void>();
  const eventCbs = new Set<(e: Feed) => void>();
  let table: { name: string; sha: string } | null = start.table ? { name: 'Monster Bash', sha: SHA } : null;
  let inGame = start.inGame === true;
  const status = (): WStatus =>
    ({
      paired: false,
      currentTable: table?.name ?? null,
      currentIdentity: table ? { sha256: table.sha, tableInfo: null } : null,
      currentAttestation: null,
      captureMode: table ? 'live' : null,
      note: null,
    }) as unknown as WStatus;
  const say = (): void => statusCbs.forEach((cb) => cb(status()));
  const feed = (ev: Feed): void => {
    if (ev.kind === 'game_start') inGame = true;
    if (ev.kind === 'game_end' || ev.kind === 'game_abandoned' || ev.kind === 'table_exit') inGame = false;
    eventCbs.forEach((cb) => cb(ev));
  };
  const w = {
    status,
    sampleVr: async () => null,
    liveGame: () => (table ? { table: table.name, inGame, scores: [], player: null, ball: null } : null),
    onEvent: (cb: (e: Feed) => void) => (eventCbs.add(cb), () => eventCbs.delete(cb)),
    onStatus: (cb: (s: WStatus) => void) => (statusCbs.add(cb), () => statusCbs.delete(cb)),
  } as unknown as WitnessHost;
  return {
    w,
    feed,
    open(name = 'Monster Bash', sha = SHA) {
      table = { name, sha };
      say();
    },
    close() {
      table = null;
      feed({ kind: 'table_exit' });
      say();
    },
    gameStart: () => feed({ kind: 'game_start', t: 0, players: 1 } as Feed),
    gameEnd: (score: number) => feed({ kind: 'game_end', t: 0, scores: [score], players: 1 } as Feed),
    /** One ball played to its end at `score`. */
    ball(ball: number, score: number) {
      feed({ kind: 'current_scores', t: 0, scores: [score], player: 1, ball } as Feed);
      feed({ kind: 'ball_end', t: 0, player: 1, ball, extraBalls: 0 } as Feed);
      feed({ kind: 'current_scores', t: 0, scores: [score], player: 1, ball } as Feed);
    },
  };
}

const dirs: string[] = [];
const hosts: MatchHost[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function make(name: string, w: WitnessHost): { mh: MatchHost; lock: string; logs: string[] } {
  const dir = mkdtempSync(join(tmpdir(), `castcade-order-${name}-`));
  dirs.push(dir);
  const lock = join(dir, 'lock', 'turn.lock');
  const logs: string[] = [];
  const logger = { info: (l: string) => void logs.push(l), warn: (l: string) => void logs.push(l), error: (l: string) => void logs.push(l), file: '' } as unknown as Logger;
  const mh = createMatchHost({
    file: join(dir, 'match.json'),
    keysFile: join(dir, 'match-keys.json'),
    witness: w,
    device: () => ({ deviceId: `dev-${name}`, deviceLabel: name }),
    appVersion: '0.2.39',
    log: logger,
    publicIp: () => Promise.resolve('127.0.0.1'),
    lockFile: lock,
    listenAddress: '127.0.0.1',
  });
  hosts.push(mh);
  return { mh, lock, logs };
}

const until = async (cond: () => boolean, ms = 4000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};
const port = (): number => 47000 + Math.floor(Math.random() * 2000);
const row = (mh: MatchHost, name: string) => mh.status().participants.find((p) => p.name === name);
const message = (mh: MatchHost): string | null => mh.status().panel?.message ?? null;

describe('any order works (A14 step 3)', () => {
  it("Host before any table, Join before the host's table: each table opens later, in either order, and the host's first Start on the table starts the match", async () => {
    const hr = rig();
    const cr = rig();
    const H = make('late-tables-host', hr.w);
    const C = make('late-tables-client', cr.w);
    const hs = await H.mh.host({ port: port(), ballsPerGame: 3, displayName: 'Owner' });
    // Hosted with no VPX at all: the host's game says so, and a client can read that it is not open yet.
    expect(isTableOpen(H.mh.hostGame()!)).toBe(false);
    await C.mh.join(hs.invite!, 'Krobs');
    await until(() => H.mh.status().participants.length === 2);
    expect(isTableOpen(C.mh.hostGame()!)).toBe(false);
    expect(H.mh.status().panel?.players.map((p) => p.flags.includes('loading'))).toEqual([true, true]);

    // The client's table first, then the host's.
    cr.open();
    await until(() => !H.mh.status().panel?.players.find((p) => p.name === 'Krobs')?.flags.includes('loading'));
    hr.open();
    await until(() => C.mh.hostGame()?.tableHash === SHA);
    await until(() => row(C.mh, 'Krobs')?.tableMatch === true && row(H.mh, 'Krobs')?.tableMatch === true);
    await until(() => message(H.mh) === 'Everyone in? Start a game on your table (or press Start match)');

    hr.gameStart();
    await until(() => H.mh.status().phase === 'playing' && C.mh.status().phase === 'playing', 9000);
    expect(H.mh.status().panel).toMatchObject({ myTurn: true, ball: 1 });
    expect(existsSync(C.lock)).toBe(true);
    expect(existsSync(H.lock)).toBe(false);
  }, 20_000);

  it("the host's Start pressed while the other table is still loading: the start is armed and fires when that table opens", async () => {
    const hr = rig({ table: true });
    const cr = rig();
    const H = make('armed-host', hr.w);
    const C = make('armed-client', cr.w);
    const hs = await H.mh.host({ port: port(), ballsPerGame: 3, displayName: 'Owner' });
    await C.mh.join(hs.invite!, 'Krobs');
    await until(() => H.mh.status().participants.length === 2);
    hr.gameStart();
    await until(() => H.logs.some((l) => l.includes("the match starts once Krobs's table is open")));
    expect(H.mh.status().phase).toBe('lobby');
    cr.open();
    await until(() => H.mh.status().phase === 'playing' && C.mh.status().phase === 'playing', 9000);
  }, 20_000);

  it('Host while a game is already running on the table (free play): the join waits for that game, and the next Start starts the match', async () => {
    const hr = rig({ table: true, inGame: true });
    const cr = rig({ table: true });
    const H = make('ingame-host', hr.w);
    const C = make('ingame-client', cr.w);
    const hs = await H.mh.host({ port: port(), ballsPerGame: 3, displayName: 'Owner' });
    await C.mh.join(hs.invite!, 'Krobs');
    await until(() => message(H.mh) === 'Everyone is in: finish the game on your table, then press Start on it to start the match');
    expect(existsSync(H.lock)).toBe(false);
    hr.gameEnd(1200);
    await until(() => message(H.mh) === 'Everyone in? Start a game on your table (or press Start match)');
    hr.gameStart();
    await until(() => H.mh.status().phase === 'playing' && C.mh.status().phase === 'playing', 9000);
  }, 20_000);

  it('Host while a game is running, with "Table locked until someone joins": the running game keeps its flippers; the lock goes on when it ends and off when the lobby is complete', async () => {
    const hr = rig({ table: true, inGame: true });
    const cr = rig({ table: true });
    const H = make('locked-host', hr.w);
    const C = make('locked-client', cr.w);
    H.mh.setSettings({ preMatchPlay: 'locked' });
    const hs = await H.mh.host({ port: port(), ballsPerGame: 3, displayName: 'Owner' });
    // Before A14 the lock went on here, in the middle of the ball.
    expect(H.mh.status().locked).toBe(false);
    expect(existsSync(H.lock)).toBe(false);
    hr.gameEnd(900);
    expect(H.mh.status().locked).toBe(true);
    expect(existsSync(H.lock)).toBe(true);
    await C.mh.join(hs.invite!, 'Krobs');
    await until(() => H.mh.status().participants.length === 2 && !H.mh.status().locked);
    expect(existsSync(H.lock)).toBe(false);
  }, 15_000);

  it('the table closed and reopened in the lobby: the row reads loading and then open again, and the match still starts from the table', async () => {
    const hr = rig({ table: true });
    const cr = rig({ table: true });
    const H = make('reopen-lobby-host', hr.w);
    const C = make('reopen-lobby-client', cr.w);
    const hs = await H.mh.host({ port: port(), ballsPerGame: 3, displayName: 'Owner' });
    await C.mh.join(hs.invite!, 'Krobs');
    await until(() => H.mh.status().participants.length === 2);
    const loading = (mh: MatchHost, name: string): boolean => mh.status().panel?.players.find((p) => p.name === name)?.flags.includes('loading') === true;
    cr.close();
    await until(() => loading(H.mh, 'Krobs') && loading(C.mh, 'Krobs'));
    hr.close();
    await until(() => loading(C.mh, 'Owner'));
    hr.open();
    cr.open();
    await until(() => !loading(H.mh, 'Krobs') && !loading(C.mh, 'Owner') && row(H.mh, 'Krobs')?.tableMatch === true);
    hr.gameStart();
    await until(() => H.mh.status().phase === 'playing' && C.mh.status().phase === 'playing', 9000);
  }, 20_000);

  it('the table closed and reopened between games, on both rigs: the series goes on, the next game starts from the reopened host table, the client stays locked until its ball', async () => {
    const hr = rig({ table: true });
    const cr = rig({ table: true });
    const H = make('reopen-host', hr.w);
    const C = make('reopen-client', cr.w);
    const hs = await H.mh.host({ port: port(), ballsPerGame: 3, displayName: 'Owner' });
    await C.mh.join(hs.invite!, 'Krobs');
    await until(() => H.mh.status().participants.length === 2);
    await H.mh.start();
    for (let ball = 1; ball <= 3; ball++) {
      for (const [mh, seat] of [
        [H.mh, hr],
        [C.mh, cr],
      ] as const) {
        await until(() => mh.status().panel?.myTurn === true && mh.status().panel?.ball === ball);
        seat.ball(ball, 1000 * ball);
        await until(() => mh.status().panel?.myTurn !== true || mh.status().phase === 'over');
      }
    }
    await until(() => H.mh.status().phase === 'over' && C.mh.status().phase === 'over');

    // Both close VPX between games and open the table again.
    hr.close();
    cr.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(H.mh.status()).toMatchObject({ role: 'host', phase: 'over', series: { game: 1, over: false, nextGameBlocker: null } });
    expect(C.mh.status()).toMatchObject({ role: 'client', phase: 'over', locked: true });
    hr.open();
    cr.open();
    // A client's Start starts nothing (its table is locked anyway); the host's starts game 2 for everyone.
    cr.gameStart();
    await new Promise((r) => setTimeout(r, 50));
    expect(H.mh.status().series?.game).toBe(1);
    hr.gameStart();
    await until(() => H.mh.status().series?.game === 2 && C.mh.status().series?.game === 2 && C.mh.status().phase === 'playing');
    expect(H.mh.status().panel).toMatchObject({ myTurn: true, ball: 1 });
    expect(existsSync(C.lock)).toBe(true);
    hr.ball(1, 500);
    await until(() => C.mh.status().panel?.myTurn === true);
    expect(existsSync(C.lock)).toBe(false);
  }, 25_000);
});

// ---- A14 steps 1 and 2 over two real match hosts: Host with a table, a join link, the tables started by a fake launcher ----

const { createOneStep } = await import('./one-step.js');
type KnownTable = Awaited<ReturnType<Parameters<typeof createOneStep>[0]['tables']>>[number];

/** One-step on a rig: the fake launcher "starts VPX" by recording the path; the test then opens the table on the rig's witness. */
function oneStepOn(mh: MatchHost, r: ReturnType<typeof rig>, tables: KnownTable[]) {
  const launched: string[] = [];
  const clips: string[] = [];
  const one = createOneStep({
    match: mh,
    witness: r.w,
    launcher: {
      async launch(path) {
        launched.push(path);
        return { ok: true, pid: 1 };
      },
    },
    clipboard: { writeText: (t) => void clips.push(t) },
    tables: async () => tables,
    log: { info: () => undefined, warn: () => undefined },
  });
  return { one, launched, clips };
}

const known = (tableId: string, sha: string | null): KnownTable => ({ tableId, vpxPath: `C:\\vpx\\tables\\${tableId}.vpx`, infoName: null, rom: null, sha256: sha, imported: true, lastPlayedAt: null, patchedAt: null });

describe('one step to a match over real match hosts (A14 steps 1 and 2)', () => {
  it("Host with a table, the friend opens the link before the host's VPX is up: the link joins, waits for the host's table, starts the same file here, and the host's first Start starts the match", async () => {
    const hr = rig();
    const cr = rig();
    const H = make('one-host', hr.w);
    const C = make('one-client', cr.w);
    const hostTables = [known('Monster Bash (Williams 1998)', SHA)];
    // The friend's copy has another file name and the same bytes; a second table is there to be passed over.
    const friendTables = [known('Attack from Mars', 'cd'.repeat(32)), known('mb_vpw_1.1', SHA)];
    const ho = oneStepOn(H.mh, hr, hostTables);
    const co = oneStepOn(C.mh, cr, friendTables);

    // Host: one press. The match is hosted, the link is on the clipboard, VPX is asked for the picked table.
    const hs = await ho.one.host({ tablePath: hostTables[0]!.vpxPath, port: port(), ballsPerGame: 3, displayName: 'Owner' });
    expect(hs).toMatchObject({ role: 'host', phase: 'lobby' });
    const link = ho.one.status().link!;
    expect(link).toMatch(/^castcade:\/\/join\/castcade%3Aws%3A%2F%2F127\.0\.0\.1%3A\d+%23[A-Z]{6}$/);
    expect(ho.clips).toEqual([link]);
    expect(ho.launched).toEqual([hostTables[0]!.vpxPath]);
    expect(ho.one.status().launch.state).toBe('starting');

    // The friend clicks the link while the host's VPX is still loading: joined, nothing started yet.
    const cs = await co.one.openLink(link, { trusted: true });
    expect(cs.notice).toBeNull();
    expect(C.mh.status()).toMatchObject({ role: 'client', phase: 'lobby' });
    expect(co.launched).toEqual([]);
    expect(co.one.status().launch.state).toBe('waiting_host');

    // The host's table opens: the friend's Castcade learns the game from the lobby and starts the same file.
    hr.open('Monster Bash', SHA);
    await until(() => co.launched.length === 1);
    expect(co.launched).toEqual([friendTables[1]!.vpxPath]);
    expect(ho.one.status().launch.state).toBe('running');
    cr.open('Monster Bash', SHA);
    await until(() => co.one.status().launch.state === 'running');
    await until(() => row(H.mh, 'one-client')?.tableMatch === true);

    // Headsets on: the host's first Start on the table starts the match (A11).
    hr.gameStart();
    await until(() => H.mh.status().phase === 'playing' && C.mh.status().phase === 'playing', 9000);
    expect(ho.launched).toHaveLength(1);
    expect(co.launched).toHaveLength(1);
    ho.one.stop();
    co.one.stop();
  }, 25_000);

  it('a link for a match that ended while it waited for the click says the match is gone, joins nothing and starts nothing', async () => {
    const hr = rig({ table: true });
    const cr = rig();
    const H = make('gone-host', hr.w);
    const C = make('gone-client', cr.w);
    const ho = oneStepOn(H.mh, hr, []);
    const co = oneStepOn(C.mh, cr, [known('Monster Bash', SHA)]);
    await ho.one.host({ tablePath: null, port: port(), ballsPerGame: 3, displayName: 'Owner' });
    const link = ho.one.status().link!;
    // It waits for the click (the app was not showing the Match tab); meanwhile the host leaves.
    await co.one.openLink(link, { trusted: false });
    expect(co.one.status().pending).not.toBeNull();
    await H.mh.leave();
    const after = await co.one.confirm();
    expect(after.notice).toMatch(/^That match is gone or cannot be reached: ask the host for a new link\./);
    expect(C.mh.status().role).toBe('none');
    expect(co.launched).toEqual([]);
    ho.one.stop();
    co.one.stop();
  }, 25_000);
});
