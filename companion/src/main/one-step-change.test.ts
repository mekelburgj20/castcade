/**
 * A17 step 3 over two real match hosts (Electron stubbed, real WebSockets on localhost), each with a witness the test
 * drives and a one-step with a closer that records. What it holds is where the step meets the lobby as it is built:
 *
 * - the lobby's table is a pick since step 6 (`MatchHost.lobbyTable`: on the lobby's PC the engine's, on a joined PC
 *   the last HELLO_ACK's), and that, not `hostGame()`, is what one-step follows;
 * - nothing that happens in a lobby today changes it once it is made: a table opened by hand on the lobby's PC is
 *   never a pick, and a match's own table (`hostGame()` from MATCH_READY on: the open table of its first player,
 *   under whatever file name) is not the lobby's. So nobody's table is closed for either.
 *
 * The change itself (a pick by a member: closed, then started, and every case in which nothing may close) is in
 * `one-step.test.ts`; the shell gets a way to pick in step 10 (TABLE_PICK), and this is the path it then runs.
 * The scaffolding is the one of `match-host-orderings.test.ts`, which stays as it is.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CloseOutcome } from '../launch/vpx-close.js';

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
const { createOneStep } = await import('./one-step.js');
type MatchHost = ReturnType<typeof createMatchHost>;
type WitnessHost = Parameters<typeof createMatchHost>[0]['witness'];
type Logger = Parameters<typeof createMatchHost>[0]['log'];
type WStatus = ReturnType<WitnessHost['status']>;
type Feed = Parameters<Parameters<WitnessHost['onEvent']>[0]>[0];
type KnownTable = Awaited<ReturnType<Parameters<typeof createOneStep>[0]['tables']>>[number];

const MB_SHA = 'ab'.repeat(32);
const AFM_SHA = 'cd'.repeat(32);

/** A rig's witness: a table opens and closes, a game starts; live mode whenever a table is open. */
function rig(start: { name: string; sha: string } | null = null) {
  const statusCbs = new Set<(s: WStatus) => void>();
  const eventCbs = new Set<(e: Feed) => void>();
  let table = start;
  let inGame = false;
  const status = (): WStatus => ({ paired: false, currentTable: table?.name ?? null, currentIdentity: table ? { sha256: table.sha, tableInfo: null } : null, currentAttestation: null, captureMode: table ? 'live' : null, note: null }) as unknown as WStatus;
  const say = (): void => statusCbs.forEach((cb) => cb(status()));
  const feed = (ev: Feed): void => {
    if (ev.kind === 'game_start') inGame = true;
    if (ev.kind === 'game_end' || ev.kind === 'table_exit') inGame = false;
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
    open(name: string, sha: string) {
      table = { name, sha };
      say();
    },
    close() {
      table = null;
      feed({ kind: 'table_exit' });
      say();
    },
  };
}

const dirs: string[] = [];
const hosts: MatchHost[] = [];
const steps: Array<{ stop(): void }> = [];
afterEach(async () => {
  for (const s of steps.splice(0)) s.stop();
  for (const h of hosts.splice(0)) await h.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function make(name: string, w: WitnessHost): MatchHost {
  const dir = mkdtempSync(join(tmpdir(), `castcade-change-${name}-`));
  dirs.push(dir);
  const logger = { info: () => undefined, warn: () => undefined, error: () => undefined, file: '' } as unknown as Logger;
  const mh = createMatchHost({
    file: join(dir, 'match.json'),
    keysFile: join(dir, 'match-keys.json'),
    witness: w,
    device: () => ({ deviceId: `dev-${name}`, deviceLabel: name }),
    appVersion: '0.2.50',
    log: logger,
    publicIp: () => Promise.resolve('127.0.0.1'),
    lockFile: join(dir, 'lock', 'turn.lock'),
    listenAddress: '127.0.0.1',
    ephemeralPort: true,
    lobby: { countdownMs: 20 },
    openPort: null,
  });
  hosts.push(mh);
  return mh;
}

const until = async (cond: () => boolean, ms = 4000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const known = (tableId: string, sha: string | null): KnownTable => ({ tableId, vpxPath: `C:\\vpx\\tables\\${tableId}.vpx`, infoName: null, rom: null, sha256: sha, imported: true, lastPlayedAt: null, patchedAt: null });

/** One-step on a rig, with a launcher that records and a closer that records (and never answers: nothing may reach it here). */
function oneStepOn(mh: MatchHost, r: ReturnType<typeof rig>, tables: KnownTable[]) {
  const launched: string[] = [];
  const closes: string[] = [];
  const logs: string[] = [];
  const one = createOneStep({
    match: mh,
    witness: r.w as unknown as Parameters<typeof createOneStep>[0]['witness'],
    launcher: {
      async launch(path) {
        launched.push(path);
        return { ok: true, pid: 1 };
      },
    },
    closer: { close: (table) => new Promise<CloseOutcome>(() => void closes.push(table)) },
    clipboard: { writeText: () => undefined },
    tables: async () => tables,
    hostHashWaitMs: 0,
    log: { info: (l) => void logs.push(l), warn: (l) => void logs.push(l) },
  });
  steps.push(one);
  return { one, launched, closes, logs };
}

/**
 * A lobby of two on Monster Bash, both tables open: the friend joined with the link while their own copy stood open.
 * The friend's file has another name and the same bytes.
 */
async function lobby() {
  const hr = rig({ name: 'Monster Bash', sha: MB_SHA });
  const cr = rig({ name: 'mb_vpw_1.1', sha: MB_SHA });
  const H = make('host', hr.w);
  const C = make('client', cr.w);
  const ho = oneStepOn(H, hr, [known('Monster Bash', MB_SHA), known('Attack from Mars', AFM_SHA)]);
  const co = oneStepOn(C, cr, [known('mb_vpw_1.1', MB_SHA), known('Attack from Mars', AFM_SHA)]);
  await ho.one.host({ tablePath: null, startTable: false, port: 0, ballsPerGame: 3, displayName: 'Owner' });
  const s = await co.one.openLink(ho.one.status().link!, { trusted: true });
  expect(s.notice).toBeNull();
  await until(() => C.lobbyTable()?.tableName === 'Monster Bash');
  await until(() => co.one.status().launch.state === 'running');
  return { hr, cr, H, C, ho, co };
}

describe("the lobby's table over real match hosts: what one-step follows is the pick (A17 step 3)", () => {
  it("the pick is the first table the lobby's PC has open, on both PCs; a table open at the join is kept", async () => {
    const { H, C, ho, co } = await lobby();
    expect(H.lobbyTable()).toMatchObject({ tableName: 'Monster Bash', tableHash: MB_SHA });
    expect(C.lobbyTable()).toMatchObject({ tableName: 'Monster Bash', tableHash: MB_SHA });
    expect(co.one.status().launch.detail).toBe('Using the table that is already open: mb_vpw_1.1');
    expect(co.launched).toEqual([]);
    expect([...ho.closes, ...co.closes]).toEqual([]);
    // No finished game's initials are being entered: the match host holds no table.
    expect(H.tableHeld()).toBe(false);
    expect(C.tableHeld()).toBe(false);
    // With no lobby there is no table to follow.
    await C.leave();
    expect(C.lobbyTable()).toBeNull();
  });

  it("the lobby's PC opens another table by hand: that is no pick, and nobody's table is closed", async () => {
    const { hr, H, C, ho, co } = await lobby();
    hr.close();
    hr.open('Attack from Mars', AFM_SHA);
    // The lobby hears of the other table (the row of the lobby's PC), and the pick stands.
    await until(() => H.hostGame()?.tableName === 'Attack from Mars');
    await sleep(200);
    expect(H.lobbyTable()?.tableName).toBe('Monster Bash');
    expect(C.lobbyTable()?.tableName).toBe('Monster Bash');
    expect([...ho.closes, ...co.closes]).toEqual([]);
    expect(co.launched).toEqual([]);
    expect(co.one.status().change).toBeNull();
    expect(ho.one.status().change).toBeNull();
    expect(co.logs.filter((l) => /the lobby's table changed/.test(l))).toEqual([]);
  });

  it("a match starts with the friend first: hostGame() becomes the match's own table under the friend's file name, the pick stands, nothing closes", async () => {
    const { H, C, ho, co } = await lobby();
    await C.start({ anyway: true });
    await until(() => C.status().phase === 'playing' && H.status().phase === 'playing');
    // The match's table is its first player's open one (MATCH_READY.game): the friend's file name.
    expect(C.hostGame()?.tableName).toBe('mb_vpw_1.1');
    expect(C.lobbyTable()?.tableName).toBe('Monster Bash');
    expect(H.lobbyTable()?.tableName).toBe('Monster Bash');
    await sleep(200);
    expect([...ho.closes, ...co.closes]).toEqual([]);
    expect([...ho.launched, ...co.launched]).toEqual([]);
    expect(co.one.status().change).toBeNull();
    expect(ho.one.status().change).toBeNull();
    expect(co.one.status().launch.state).toBe('running');
  });
});
