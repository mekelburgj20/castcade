/**
 * A15 (2026-11-12): the witness rebuilt in the middle of a match (the ArcAid address or the NVRAM folder setting
 * changed) must not replay the game in progress into the match. Two match hosts on localhost over real WebSockets
 * (Electron stubbed, as in `match-host-orderings.test.ts`); the host's witness is the real one, over a memory file
 * system and a journal the test writes line by line like the hook does, behind the real witness host that rebuilds it.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
const { createWitnessHost } = await import('./witness-host.js');
const { MemoryFs, createStaticRegistry } = await import('../witness/index.js');
const { buildOwnerStyleVpx } = await import('../witness/synth-vpx.test-support.js');
type MatchHost = ReturnType<typeof createMatchHost>;
type WitnessHost = Parameters<typeof createMatchHost>[0]['witness'];
type Logger = Parameters<typeof createMatchHost>[0]['log'];
type WStatus = ReturnType<WitnessHost['status']>;
type Feed = Parameters<Parameters<WitnessHost['onEvent']>[0]>[0];
type Store = Parameters<typeof createWitnessHost>[0];

const repo = (p: string): string => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const TABLE = 'Test Table (Original 2026)';
/** Both rigs play the same table file. */
const VPX = buildOwnerStyleVpx({ tableName: TABLE, author: 'Test', version: '1.0' });
const SHA = createHash('sha256').update(VPX).digest('hex');
const TABLE_PATH = `C:\\Tables\\${TABLE}.vpx`;
const JOURNAL = '/journal/Test_Table_Original_2026.jsonl';
const EXE = 'C:\\VPX\\VPinballX64.exe';

/** The hook's local-time stamp for an instant (`Castcade_Stamp`). */
function hookStamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const until = async (cond: () => boolean, ms = 6000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const witnessHosts: Array<ReturnType<typeof createWitnessHost>> = [];
const dirs: string[] = [];
const hosts: MatchHost[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.stop();
  for (const w of witnessHosts.splice(0)) await w.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * A rig with the real witness: VPX is running a patched original table whose hook writes script events to the journal
 * (`say` appends lines as the hook would). `wh` is the shell's witness host, `restart` what a settings change does.
 */
function realRig() {
  const fs = new MemoryFs();
  fs.put(TABLE_PATH, VPX);
  fs.put(TABLE_PATH.replace(/\.vpx$/, '.vbs'), `' --- Castcade ---\r\nOn Error Resume Next\r\nExecuteGlobal GetTextFile("castcade.vbs")\r\nCastcade_Init "${TABLE}", "B", "0.5.0", ""\r\n`);
  const startedAt = Date.now() - 60_000;
  const settings = {
    arcaidBaseUrl: 'https://arcaid.test',
    deviceId: 'dev-real',
    deviceLabel: 'TEST-PC',
    token: null,
    mapsDir: repo('fixtures/maps'),
    nvramDir: '/nv',
    dataDir: '/data',
    vpsDir: repo('fixtures/vps'),
    tablesDir: null,
  };
  const store = {
    file: '',
    get: () => ({ ...settings }),
    set: async (patch: Partial<typeof settings>) => void Object.assign(settings, patch),
    onChange: () => () => undefined,
  } as unknown as Store;
  const logs: string[] = [];
  const log = { info: (l: string) => void logs.push(l), warn: (l: string) => void logs.push(l), error: (l: string) => void logs.push(l), file: '' } as unknown as Logger;
  const wh = createWitnessHost(store, log, {
    fs,
    lister: { list: async () => [{ pid: 4242, exe: EXE, commandLine: `"${EXE}" -Play "${TABLE_PATH}"`, startedAt, windowTitle: null }] },
    vrProbe: null,
    registry: createStaticRegistry({}),
    fetch: async () => {
      throw new Error('no network in this test');
    },
    journalDir: '/journal',
    journalPollMs: 10,
    pollIntervalMs: 25,
    romMapRefreshMs: null,
    vpsRefreshMs: null,
  });
  witnessHosts.push(wh);
  const lines = [`{"event":"table_loaded","t":0.008,"table":"${TABLE}","recipe":"B","recipe_version":"0.5.0","rom":"","lib":"0.5.0","session":"${hookStamp(startedAt + 20_000)}","locked":false}`];
  let t = 1;
  const write = (): void => fs.put(JOURNAL, lines.join('\n') + '\n');
  write();
  const say = (event: string, body: Record<string, unknown>): void => {
    lines.push(JSON.stringify({ event, t: t++, ...body }));
    write();
  };
  return {
    wh,
    logs,
    gameStart: () => say('game_start', { players: 1 }),
    score: (ball: number, score: number) => say('current_scores', { scores: [score], player: 1, ball }),
    ballEnd: (ball: number) => say('ball_end', { player: 1, ball, extra_balls: 0 }),
    gameEnd: (score: number) => say('game_end', { scores: [score], players: 1 }),
    /** The witness has read the journal this far: the score on its live game. */
    reads: (score: number): boolean => wh.liveGame()?.scores[0] === score,
    /** The table is open, followed live and hashed (what the lobby compares). */
    ready: (): boolean => wh.status().captureMode === 'live' && wh.status().currentIdentity?.sha256 === SHA,
  };
}

/** The other rig: a witness the test drives directly (the orderings test's). */
function fakeRig() {
  const statusCbs = new Set<(s: WStatus) => void>();
  const eventCbs = new Set<(e: Feed) => void>();
  const status = (): WStatus => ({ paired: false, currentTable: TABLE, currentIdentity: { sha256: SHA, tableInfo: null }, currentAttestation: null, captureMode: 'live', note: null }) as unknown as WStatus;
  const feed = (ev: Feed): void => eventCbs.forEach((cb) => cb(ev));
  const w = {
    status,
    sampleVr: async () => null,
    liveGame: () => ({ table: TABLE, inGame: false, scores: [], player: null, ball: null }),
    onEvent: (cb: (e: Feed) => void) => (eventCbs.add(cb), () => eventCbs.delete(cb)),
    onStatus: (cb: (s: WStatus) => void) => (statusCbs.add(cb), () => statusCbs.delete(cb)),
  } as unknown as WitnessHost;
  return {
    w,
    ball(ball: number, score: number) {
      feed({ kind: 'current_scores', t: 0, scores: [score], player: 1, ball } as Feed);
      feed({ kind: 'ball_end', t: 0, player: 1, ball, extraBalls: 0 } as Feed);
      feed({ kind: 'current_scores', t: 0, scores: [score], player: 1, ball } as Feed);
    },
  };
}

function make(name: string, w: WitnessHost): { mh: MatchHost; lock: string; logs: string[] } {
  const dir = mkdtempSync(join(tmpdir(), `castcade-restart-${name}-`));
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

const port = (): number => 49000 + Math.floor(Math.random() * 2000);
const scoreOf = (mh: MatchHost, name: string): number | null | undefined => mh.status().panel?.players.find((p) => p.name === name)?.score;

describe('the witness rebuilt during a match (A15)', () => {
  it("on this player's second ball: the first ball's end is not reported again, the turn stays, and the real ball end passes it once", async () => {
    const hr = realRig();
    const cr = fakeRig();
    await hr.wh.start();
    await until(() => hr.ready());
    const H = make('ball-host', hr.wh);
    const C = make('ball-guest', cr.w);
    const hs = await H.mh.host({ port: port(), ballsPerGame: 3, displayName: 'Host' });
    await C.mh.join(hs.invite!, 'Guest');
    await until(() => H.mh.status().participants.length === 2);
    await H.mh.start();
    await until(() => H.mh.status().panel?.myTurn === true && C.mh.status().phase === 'playing');

    // Ball 1 on the host's table, then the guest's ball 1.
    hr.gameStart();
    hr.score(1, 500);
    hr.ballEnd(1);
    hr.score(1, 750);
    await until(() => C.mh.status().panel?.myTurn === true);
    cr.ball(1, 300);
    await until(() => H.mh.status().panel?.myTurn === true && H.mh.status().panel?.ball === 2);

    // The host is in the middle of ball 2 when a setting rebuilds the witness.
    hr.score(2, 900);
    await until(() => hr.reads(900) && scoreOf(C.mh, 'Host') === 900);
    await hr.wh.restart('settings changed');
    await until(() => hr.ready() && hr.reads(900));
    await sleep(300);
    expect(H.mh.status().panel).toMatchObject({ myTurn: true, ball: 2 });
    expect(C.mh.status().panel?.myTurn).toBe(false);
    expect(existsSync(H.lock)).toBe(false);
    expect(existsSync(C.lock)).toBe(true);
    expect(scoreOf(C.mh, 'Host')).toBe(900);
    expect(H.logs.filter((l) => l.includes('ball 2 ended on the table'))).toHaveLength(0);

    // The ball really ends: the turn passes once, with the score of that moment.
    hr.score(2, 1400);
    hr.ballEnd(2);
    hr.score(2, 1650);
    await until(() => C.mh.status().panel?.myTurn === true && C.mh.status().panel?.ball === 2);
    expect(scoreOf(C.mh, 'Host')).toBe(1650);
    expect(H.logs.filter((l) => l.includes('ball 2 ended on the table'))).toHaveLength(1);
  }, 30_000);

  it("in the lobby while the host finishes a game (free play): the running game's start is not taken as a new one, and the match does not start", async () => {
    const hr = realRig();
    const cr = fakeRig();
    hr.gameStart();
    hr.score(1, 200);
    await hr.wh.start();
    await until(() => hr.ready() && hr.reads(200));
    const H = make('lobby-host', hr.wh);
    const C = make('lobby-guest', cr.w);
    const hs = await H.mh.host({ port: port(), ballsPerGame: 3, displayName: 'Host' });
    await C.mh.join(hs.invite!, 'Guest');
    const waiting = 'Everyone is in: finish the game on your table, then press Start on it to start the match';
    await until(() => H.mh.status().panel?.message === waiting);

    await hr.wh.restart('settings changed');
    await until(() => hr.ready() && hr.reads(200));
    await until(() => H.mh.status().panel?.message === waiting);
    await sleep(300);
    expect(H.mh.status().phase).toBe('lobby');
    expect(H.mh.status().panel?.countdown ?? null).toBeNull();
    expect(H.logs.some((l) => l.includes('taking it as the start'))).toBe(false);

    // The game ends and the next Start on the table starts the match, as without a restart.
    hr.gameEnd(200);
    await until(() => H.mh.status().panel?.message === 'Everyone in? Start a game on your table (or press Start match)');
    hr.gameStart();
    await until(() => H.mh.status().phase === 'playing' && C.mh.status().phase === 'playing', 9000);
  }, 30_000);
});
