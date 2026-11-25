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
 * The change itself, case by case (every case in which nothing may close), is in `one-step.test.ts`. A17 step 10:
 * the shell can pick (`OneStep.pick`, TABLE_PICK), and the last cases here run the whole of it over the real lobby: a
 * member picks, both PCs close their table and open the picked one, and the lobby's PC that starts again after
 * that is the same lobby with the same pick, for which nothing closes (step 8's restore).
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
function rig(start: { name: string; sha: string; info?: string; path?: string } | null = null) {
  const statusCbs = new Set<(s: WStatus) => void>();
  const eventCbs = new Set<(e: Feed) => void>();
  let table = start;
  let inGame = false;
  const status = (): WStatus => ({ paired: false, currentTable: table?.name ?? null, currentIdentity: table ? { sha256: table.sha, filePath: table.path ?? null, tableInfo: table.info ? { tableName: table.info } : null } : null, currentAttestation: null, captureMode: table ? 'live' : null, gamesSeen: table ? true : null, currentPid: table ? 4242 : null, vpxOpen: table ? 1 : 0, note: null }) as unknown as WStatus;
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
    /** `more`: the table's own name as its file says it (the row then names the table by it), and the file's path. */
    open(name: string, sha: string, more: { info?: string; path?: string } = {}) {
      table = { name, sha, ...more };
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
/** The user data folder of each Castcade made in a test, by its name. */
const folders = new Map<string, string>();
const hosts: MatchHost[] = [];
const steps: Array<{ stop(): void }> = [];
afterEach(async () => {
  for (const s of steps.splice(0)) s.stop();
  for (const h of hosts.splice(0)) await h.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A Castcade on a rig; `at`: the user data folder of an earlier one (the same PC after a restart). */
function make(name: string, w: WitnessHost, at?: string): MatchHost {
  const dir = at ?? mkdtempSync(join(tmpdir(), `castcade-change-${name}-`));
  if (!at) dirs.push(dir);
  folders.set(name, dir);
  const logger = { info: () => undefined, warn: () => undefined, error: () => undefined, file: '' } as unknown as Logger;
  const mh = createMatchHost({
    file: join(dir, 'match.json'),
    keysFile: join(dir, 'match-keys.json'),
    witness: w,
    device: () => ({ deviceId: `dev-${name}`, deviceLabel: name }),
    appVersion: '0.2.50',
    log: logger,
    // A18: no grace: a dropped link counts at once (the restart case below).
    disconnectGraceMs: 0,
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

/** What the Castcade VPX build says of every table file in these tests (the pick carries it). */
const OBJECTS = { editables: 1203, hash: '00aa11bb22cc33dd' };

/** One-step on a rig, with a launcher that records and a closer that records; `answer` is the closer's word on the last request. */
function oneStepOn(mh: MatchHost, r: ReturnType<typeof rig>, tables: KnownTable[], o: { word?: boolean } = {}) {
  const launched: string[] = [];
  const closes: string[] = [];
  const answers: Array<(o: CloseOutcome) => void> = [];
  const logs: string[] = [];
  const one = createOneStep({
    // `word: false`: a one-step that never says "this is my copy of the lobby's table" (as before the review of PR 139).
    match: o.word === false ? { ...mh, setPickCopy: undefined } : mh,
    witness: r.w as unknown as Parameters<typeof createOneStep>[0]['witness'],
    launcher: {
      async launch(path) {
        launched.push(path);
        return { ok: true, pid: 1 };
      },
    },
    closer: {
      close: (table, _pid) =>
        new Promise<CloseOutcome>((answer) => {
          closes.push(table);
          answers.push(answer);
        }),
    },
    tableObjects: async () => OBJECTS,
    clipboard: { writeText: () => undefined },
    tables: async () => tables,
    hostHashWaitMs: 0,
    log: { info: (l) => void logs.push(l), warn: (l) => void logs.push(l) },
  });
  steps.push(one);
  return { one, launched, closes, logs, answer: (o: CloseOutcome): void => answers.at(-1)?.(o) };
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
  await until(() => C.lobbyTable()?.game.tableName === 'Monster Bash');
  await until(() => co.one.status().launch.state === 'running');
  return { hr, cr, H, C, ho, co };
}

describe("the lobby's table over real match hosts: what one-step follows is the pick (A17 step 3)", () => {
  it("the pick is the first table the lobby's PC has open, on both PCs; a table open at the join is kept", async () => {
    const { H, C, ho, co } = await lobby();
    expect(H.lobbyTable()).toMatchObject({ game: { tableName: 'Monster Bash', tableHash: MB_SHA } });
    expect(C.lobbyTable()).toMatchObject({ game: { tableName: 'Monster Bash', tableHash: MB_SHA } });
    // Each PC's stay in the lobby has a name of its own, which stands while nothing is joined again.
    const stay = C.lobbyTable()?.joined;
    expect(typeof stay).toBe('string');
    expect(C.lobbyTable()?.joined).toBe(stay);
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
    expect(H.lobbyTable()?.game.tableName).toBe('Monster Bash');
    expect(C.lobbyTable()?.game.tableName).toBe('Monster Bash');
    expect([...ho.closes, ...co.closes]).toEqual([]);
    expect(co.launched).toEqual([]);
    expect(co.one.status().change).toBeNull();
    // (The final review: the owner's own table is not the lobby's any more, so the lobby's table is on offer there.)
    await until(() => ho.one.status().change?.state === 'offered');
    expect(ho.one.status().change?.detail).toBe("The lobby's table is Monster Bash, and Attack from Mars is open on this PC. Open it: Castcade closes Attack from Mars and opens Monster Bash.");
    expect([...ho.closes, ...co.closes]).toEqual([]);
    expect(co.logs.filter((l) => /the lobby's table changed/.test(l))).toEqual([]);
  });

  it("a match starts with the friend first: hostGame() becomes the match's own table under the friend's file name, the pick stands, nothing closes", async () => {
    const { H, C, ho, co } = await lobby();
    await C.start({ anyway: true });
    await until(() => C.status().phase === 'playing' && H.status().phase === 'playing');
    // The match's table is its first player's open one (MATCH_READY.game): the friend's file name.
    expect(C.hostGame()?.tableName).toBe('mb_vpw_1.1');
    expect(C.lobbyTable()?.game.tableName).toBe('Monster Bash');
    expect(H.lobbyTable()?.game.tableName).toBe('Monster Bash');
    await sleep(200);
    expect([...ho.closes, ...co.closes]).toEqual([]);
    expect([...ho.launched, ...co.launched]).toEqual([]);
    expect(co.one.status().change).toBeNull();
    expect(ho.one.status().change).toBeNull();
    expect(co.one.status().launch.state).toBe('running');
  });

  it("the lobby's PC starts again with another table open (review of PR 137, finding 1; A17 step 8: the lobby is restored with its pick): the friend comes back by itself, nobody picked anything, and the friend's table is not closed", async () => {
    const { hr, H, C, co } = await lobby();
    const stayBefore = C.lobbyTable()?.joined;
    // A match is open, so the lobby's PC has a record to come back with.
    await C.start({ anyway: true });
    await until(() => C.status().phase === 'playing' && H.status().phase === 'playing');
    const code = H.status().code;
    // Castcade on the lobby's PC closes (a crash, an update), and its owner opens another table meanwhile.
    await H.stop({ keepForRestart: true });
    hr.close();
    hr.open('Attack from Mars', AFM_SHA);
    const H2 = make('host', hr.w, folders.get('host'));
    await H2.rejoin();
    expect(H2.status()).toMatchObject({ role: 'host', code });
    // The lobby is the one it was: its table is still the pick, whatever its PC has open now.
    expect(H2.lobbyTable()).toMatchObject({ game: { tableName: 'Monster Bash' } });
    // The friend finds the lobby again by itself.
    await until(() => H2.status().participants.length === 2 && C.status().lobby?.hostAway === null && C.lobbyTable()?.joined !== stayBefore, 20_000);
    await sleep(300);
    expect(C.lobbyTable()).toMatchObject({ game: { tableName: 'Monster Bash' } });
    // A rejoin is a join: the table that is open is kept.
    expect(co.closes).toEqual([]);
    expect(co.launched).toEqual([]);
    expect(co.one.status().change).toBeNull();
    expect(co.logs.filter((l) => /the lobby's table changed/.test(l))).toEqual([]);
    expect(co.logs.some((l) => /this PC joined the lobby again/.test(l))).toBe(true);
  }, 60_000);

  it("A17 step 10: a member picks another table from their own list: every PC hears it, both close the table they have and open their copy of the picked one, and each row says where its PC stands; then the lobby's PC starts again: the same lobby, the same pick with who made it and what is known of it, and nothing closes (step 8's restore)", async () => {
    const { hr, cr, H, C, ho, co } = await lobby();
    const afm = known('Attack from Mars', AFM_SHA).vpxPath;
    const picker = C.status().lobby?.members.find((m) => m.me)?.name ?? '';
    // The friend picks, on their Match tab.
    await co.one.pick(afm, C.status().lobby?.gameKey ?? null);
    await until(() => H.lobbyTable()?.game.tableName === 'Attack from Mars' && C.lobbyTable()?.game.tableName === 'Attack from Mars');
    expect(H.status().lobby?.table).toMatchObject({ name: 'Attack from Mars', pickedByName: picker });
    // The picked table's identity for the 3D view is the picker's copy's, on the lobby's PC too.
    expect(H.hostTableObjects()).toEqual(OBJECTS);
    expect(C.hostTableObjects()).toEqual(OBJECTS);
    // Both PCs follow: the table each has open is asked to close, the picker's own too.
    await until(() => ho.closes.length === 1 && co.closes.length === 1);
    expect([ho.closes, co.closes]).toEqual([['Monster Bash'], ['mb_vpw_1.1']]);
    expect([ho.launched, co.launched]).toEqual([[], []]);
    await until(() => (C.status().lobby?.members ?? []).every((m) => m.flags.includes('changing')) && (H.status().lobby?.members ?? []).every((m) => m.flags.includes('changing')));
    expect(C.status().lobby?.table.changing).toBe(true);
    expect(H.status().panel?.changingTable).toBe('Attack from Mars');
    // VPX closes on both PCs: each starts its copy of the picked table.
    hr.close();
    ho.answer({ state: 'closed', rung: 2 });
    cr.close();
    co.answer({ state: 'closed', rung: 2 });
    await until(() => ho.launched.length === 1 && co.launched.length === 1);
    expect([ho.launched, co.launched]).toEqual([[afm], [afm]]);
    hr.open('Attack from Mars', AFM_SHA);
    cr.open('Attack from Mars', AFM_SHA);
    await until(() => (H.status().lobby?.members ?? []).every((m) => m.flags.length === 0) && (C.status().lobby?.members ?? []).every((m) => m.flags.length === 0));
    expect([H.status().lobby?.table.changing, C.status().lobby?.table.changing]).toEqual([false, false]);
    expect(H.status().participants.map((x) => x.tableNote)).toEqual([null, null]);
    expect([ho.one.status().change, co.one.status().change]).toEqual([null, null]);

    // A match on the picked table is open when Castcade on the lobby's PC closes and starts again.
    const stayBefore = C.lobbyTable()?.joined;
    await C.start({ anyway: true });
    await until(() => C.status().phase === 'playing' && H.status().phase === 'playing');
    await H.stop({ keepForRestart: true });
    const H2 = make('host', hr.w, folders.get('host'));
    const ho2 = oneStepOn(H2, hr, [known('Monster Bash', MB_SHA), known('Attack from Mars', AFM_SHA)]);
    await H2.rejoin();
    // The lobby as it was: the pick, who made it, and what the Castcade VPX build says of it.
    expect(H2.lobbyTable()?.game).toMatchObject({ tableName: 'Attack from Mars', tableHash: AFM_SHA });
    expect(H2.status().lobby?.table).toMatchObject({ name: 'Attack from Mars', pickedByName: picker });
    expect(H2.hostTableObjects()).toEqual(OBJECTS);
    await until(() => H2.status().participants.length === 2 && C.status().lobby?.hostAway === null && C.lobbyTable()?.joined !== stayBefore, 20_000);
    await sleep(300);
    // A restart and a rejoin are joins: nobody's table is asked to close, on either PC.
    expect(C.lobbyTable()?.game.tableName).toBe('Attack from Mars');
    expect(co.closes).toHaveLength(1);
    expect(co.launched).toHaveLength(1);
    expect(ho2.closes).toEqual([]);
    expect(ho2.launched).toEqual([]);
    expect([co.one.status().change, ho2.one.status().change]).toEqual([null, null]);
    expect(co.logs.filter((l) => /the lobby's table changed/.test(l))).toHaveLength(1);
  }, 60_000);
});

describe("review of PR 139, finding 1: this PC's copy of the picked game is found by its ROM, and the lobby takes it for the lobby's table", () => {
  const OTHER_SHA = 'ef'.repeat(32);
  /**
   * The owner's list has Attack from Mars with its ROM. The friend's copy is another file of that game: other bytes,
   * a file name (`AFM_VPW_v1.2`) and a table name of its own (`JPs Martians`) that share nothing with the title. Only
   * the ROM the friend's own list knows says it is the same game, and a row carries no ROM.
   */
  const setUp = async (word: boolean) => {
    const hr = rig({ name: 'Monster Bash', sha: MB_SHA });
    const cr = rig({ name: 'mb_vpw_1.1', sha: MB_SHA });
    const H = make('host', hr.w);
    const C = make('client', cr.w);
    const afm = { ...known('Attack from Mars', AFM_SHA), rom: 'afm_113b' };
    const copy = { ...known('AFM_VPW_v1.2', OTHER_SHA), rom: 'afm_113b' };
    const ho = oneStepOn(H, hr, [known('Monster Bash', MB_SHA), afm]);
    const co = oneStepOn(C, cr, [known('mb_vpw_1.1', MB_SHA), copy], { word });
    await ho.one.host({ tablePath: null, startTable: false, port: 0, ballsPerGame: 3, displayName: 'Owner' });
    await co.one.openLink(ho.one.status().link!, { trusted: true });
    await until(() => C.lobbyTable()?.game.tableName === 'Monster Bash' && co.one.status().launch.state === 'running');
    // The owner picks Attack from Mars from the list; both PCs close their table and open their copy of it.
    await ho.one.pick(afm.vpxPath, H.status().lobby?.gameKey ?? null);
    await until(() => C.lobbyTable()?.game.tableName === 'Attack from Mars');
    expect(C.lobbyTable()?.game).toMatchObject({ tableHash: AFM_SHA, romName: 'afm_113b' });
    await until(() => ho.closes.length === 1 && co.closes.length === 1);
    hr.close();
    ho.answer({ state: 'closed', rung: 2 });
    cr.close();
    co.answer({ state: 'closed', rung: 2 });
    await until(() => ho.launched.length === 1 && co.launched.length === 1);
    // What `find-table.ts` decided on each PC: the picked file on the owner's, the copy with that ROM on the friend's.
    expect([ho.launched, co.launched]).toEqual([[afm.vpxPath], [copy.vpxPath]]);
    hr.open('Attack from Mars', AFM_SHA);
    // (The table's own name comes from that file as it is: with a line break and two spaces in it here. Every PC
    // cleans a name from another PC before it shows it.)
    cr.open('AFM_VPW_v1.2', OTHER_SHA, { info: 'JPs\r\n  Martians', path: copy.vpxPath });
    await until(() => H.status().participants.find((x) => x.name !== 'Owner')?.tableNote === 'different table file' && !(H.status().lobby?.members.find((x) => !x.opener)?.flags ?? ['loading']).includes('loading'));
    const friend = (s: MatchHost) => s.status().lobby?.members.find((x) => !x.opener);
    return { hr, cr, H, C, ho, co, friend };
  };

  it("without the PC's word (what the review found): the copy reads OTHER TABLE, and a start waits for that person for ever", async () => {
    const { H, C, friend } = await setUp(false);
    await sleep(300);
    expect(friend(H)?.flags).toEqual(['other_table']);
    expect(friend(C)?.flags).toEqual(['other_table']);
    await H.start({ anyway: true });
    await until(() => H.status().lobby?.start?.waitsFor === 'other_tables');
    expect(H.status().lobby?.start?.line).toBe('You start the match once client has Attack from Mars open (JPs Martians is open there)');
    await sleep(300);
    expect(H.status().phase).not.toBe('playing');
  }, 30_000);

  it("the PC that followed the pick says that the table it opened is its copy: no OTHER TABLE on any PC, the lobby still says that the file differs, and the match starts", async () => {
    const { cr, H, C, co, friend } = await setUp(true);
    await until(() => (friend(H)?.flags ?? ['?']).length === 0 && (friend(C)?.flags ?? ['?']).length === 0);
    // The advisory of a different file stands (it is one), and nobody is waited for.
    expect(H.status().participants.find((x) => x.name !== 'Owner')?.tableNote).toBe('different table file');
    expect(co.one.status().change).toBeNull();
    await H.start({ anyway: true });
    await until(() => H.status().phase === 'playing' && C.status().phase === 'playing');
    expect(H.status().lobby?.match?.players).toHaveLength(2);

    // The word is about that table: the friend opens something else by hand, and that is another table again.
    await H.endMatch({ everyone: true });
    await until(() => H.status().phase !== 'playing' && C.status().lobby?.match === null);
    cr.close();
    cr.open('mb_vpw_1.1', MB_SHA);
    // (The lobby's table is then on offer on the friend's PC, and its row says so: the final review.)
    await until(() => (friend(H)?.flags ?? []).includes('asked') && co.one.status().change?.state === 'offered');
    await H.start({ anyway: true });
    await until(() => H.status().lobby?.start?.waitsFor === 'other_tables');
  }, 30_000);
});

describe("the final review, finding 1: in a lobby that has a table, a PC whose open table is not its copy of it has the table on offer", () => {
  const AFM_PATH = known('Attack from Mars', AFM_SHA).vpxPath;
  const MB_PATH = known('Monster Bash', MB_SHA).vpxPath;
  const LISTS = (): KnownTable[] => [known('Monster Bash', MB_SHA), known('Attack from Mars', AFM_SHA)];
  const HERE = (table: string, open: string): string => `The lobby's table is ${table}, and ${open} is open on this PC. Open it: Castcade closes ${open} and opens ${table}.`;
  const NOTHING = (table: string): string => `The lobby's table is ${table}, and no table is open on this PC. Open it: Castcade opens ${table}.`;
  const flagsOf = (s: MatchHost, name: string): string[] => s.status().lobby?.members.find((x) => x.name === name)?.flags ?? ['?'];

  it("a lobby opened with no table, then a table is picked (three PCs): the picker's own PC opens the file it picked, a PC that joined by link with nothing open starts it, a PC with another table open is offered it and closes nothing until Open it; no row stays LOADING for a table nobody is opening, and the match starts", async () => {
    const hr = rig();
    const cr = rig();
    const dr = rig({ name: 'Monster Bash', sha: MB_SHA });
    const H = make('host', hr.w);
    const C = make('c', cr.w);
    const D = make('d', dr.w);
    const ho = oneStepOn(H, hr, LISTS());
    const co = oneStepOn(C, cr, LISTS());
    const dd = oneStepOn(D, dr, LISTS());
    // "No table: I open it myself", and nothing open in VPX.
    await ho.one.host({ tablePath: null, startTable: false, port: 0, ballsPerGame: 3, displayName: 'Owner' });
    await C.setSettings({ displayName: 'Chuck' });
    await D.setSettings({ displayName: 'Dana' });
    await co.one.openLink(ho.one.status().link!, { trusted: true });
    await dd.one.openLink(ho.one.status().link!, { trusted: true });
    await until(() => H.status().participants.length === 3 && C.status().participants.length === 3 && D.status().participants.length === 3);
    expect(H.status().lobby?.table.name).toBeNull();
    expect([ho.launched, co.launched, dd.launched]).toEqual([[], [], []]);
    // The owner presses Change table…, picks Attack from Mars and confirms.
    await ho.one.pick(AFM_PATH, H.status().lobby?.gameKey ?? null);
    await until(() => C.lobbyTable()?.game.tableName === 'Attack from Mars' && D.lobbyTable()?.game.tableName === 'Attack from Mars');
    // The picker's own PC opens the file it picked; the PC that came by link with nothing open starts its copy.
    await until(() => ho.launched.length === 1 && co.launched.length === 1);
    expect([ho.launched, co.launched]).toEqual([[AFM_PATH], [AFM_PATH]]);
    // The PC with Monster Bash open: nothing closes, nothing opens, and the table is on offer with a sentence that says both.
    await until(() => dd.one.status().change?.state === 'offered');
    expect(dd.one.status().change).toMatchObject({ state: 'offered', table: 'Attack from Mars', open: 'Monster Bash', detail: HERE('Attack from Mars', 'Monster Bash') });
    expect([dd.closes, dd.launched]).toEqual([[], []]);
    // Every row says why its table is not open: two PCs are opening it, one asks its person. None is a bare LOADING.
    await until(() => flagsOf(H, 'Dana').includes('asked') && flagsOf(H, 'Owner').includes('changing') && flagsOf(H, 'Chuck').includes('loading'));
    hr.open('Attack from Mars', AFM_SHA);
    cr.open('Attack from Mars', AFM_SHA);
    await until(() => flagsOf(H, 'Owner').length === 0 && flagsOf(H, 'Chuck').length === 0);
    await sleep(200);
    expect([dd.closes, dd.launched]).toEqual([[], []]);
    // Open it: by the rules of any change (the table is followed, no game is on): asked to close, then the copy is started.
    await dd.one.openPick();
    await until(() => dd.closes.length === 1);
    expect(dd.closes).toEqual(['Monster Bash']);
    dr.close();
    dd.answer({ state: 'closed', rung: 2 });
    await until(() => dd.launched.length === 1);
    expect(dd.launched).toEqual([AFM_PATH]);
    dr.open('Attack from Mars', AFM_SHA);
    await until(() => flagsOf(H, 'Dana').length === 0 && dd.one.status().change === null);
    await H.start({ anyway: true });
    await until(() => H.status().phase === 'playing' && C.status().phase === 'playing' && D.status().phase === 'playing');
    expect(H.status().lobby?.match?.players).toHaveLength(3);
  }, 60_000);

  it('a join by typed code: with nothing open the lobby`s table is offered and Open it starts it; with another table open it is offered and nothing closes', async () => {
    const hr = rig({ name: 'Monster Bash', sha: MB_SHA });
    const H = make('host', hr.w);
    const ho = oneStepOn(H, hr, LISTS());
    await ho.one.host({ tablePath: null, startTable: false, port: 0, ballsPerGame: 3, displayName: 'Owner' });
    const invite = H.status().invite!;
    // Nothing open: typed code, no link.
    const cr = rig();
    const C = make('c', cr.w);
    const co = oneStepOn(C, cr, LISTS());
    await C.join(invite, 'Chuck');
    await until(() => co.one.status().change?.state === 'offered');
    expect(co.one.status().change).toMatchObject({ table: 'Monster Bash', open: null, detail: NOTHING('Monster Bash') });
    expect(co.launched).toEqual([]);
    await co.one.openPick();
    await until(() => co.launched.length === 1);
    expect(co.launched).toEqual([MB_PATH]);
    // Another table open.
    const dr = rig({ name: 'Attack from Mars', sha: AFM_SHA });
    const D = make('d', dr.w);
    const dd = oneStepOn(D, dr, LISTS());
    await D.join(invite, 'Dana');
    await until(() => dd.one.status().change?.state === 'offered');
    expect(dd.one.status().change).toMatchObject({ table: 'Monster Bash', open: 'Attack from Mars', detail: HERE('Monster Bash', 'Attack from Mars') });
    await sleep(200);
    expect([dd.closes, dd.launched]).toEqual([[], []]);
  }, 30_000);

  it('a join by link with another table open: the table is kept, and the lobby`s table is offered (it no longer reads "Using the table that is already open")', async () => {
    const hr = rig({ name: 'Monster Bash', sha: MB_SHA });
    const cr = rig({ name: 'Attack from Mars', sha: AFM_SHA });
    const H = make('host', hr.w);
    const C = make('c', cr.w);
    const ho = oneStepOn(H, hr, LISTS());
    const co = oneStepOn(C, cr, LISTS());
    await ho.one.host({ tablePath: null, startTable: false, port: 0, ballsPerGame: 3, displayName: 'Owner' });
    await co.one.openLink(ho.one.status().link!, { trusted: true });
    await until(() => co.one.status().change?.state === 'offered');
    expect(co.one.status().change?.detail).toBe(HERE('Monster Bash', 'Attack from Mars'));
    expect(co.one.status().launch.detail ?? '').not.toMatch(/Using the table that is already open/);
    await sleep(200);
    expect([co.closes, co.launched]).toEqual([[], []]);
    // A PC with no copy of the lobby's table: the no-copy sentence, and nothing to offer.
    const dr = rig({ name: 'Attack from Mars', sha: AFM_SHA });
    const D = make('d', dr.w);
    const dd = oneStepOn(D, dr, [known('Attack from Mars', AFM_SHA)]);
    await dd.one.openLink(ho.one.status().link!, { trusted: true });
    await until(() => dd.one.status().launch.state === 'needed');
    expect(dd.one.status().change).toBeNull();
    expect(dd.one.status().launch.detail).toBe("The lobby's table is Monster Bash. Castcade found no copy of it on this PC, and Attack from Mars stays open: you can watch, or pick another table.");
  }, 30_000);

  it("Castcade starts again inside the lobby beside another table than the lobby's: the lobby's table is on offer again", async () => {
    const { cr, H, C, co } = await lobby();
    // The friend opens another table by hand; the offer is there.
    cr.close();
    cr.open('Attack from Mars', AFM_SHA);
    await until(() => co.one.status().change?.state === 'offered');
    expect(co.one.status().change?.detail).toBe(HERE('Monster Bash', 'Attack from Mars'));
    // Their Castcade closes (a crash, an update) and starts again: it comes back into the lobby, and offers again.
    co.one.stop();
    await C.stop({ keepForRestart: true });
    const C2 = make('client', cr.w, folders.get('client'));
    const co2 = oneStepOn(C2, cr, [known('mb_vpw_1.1', MB_SHA), known('Attack from Mars', AFM_SHA)]);
    await C2.rejoin();
    await until(() => H.status().participants.length === 2 && C2.status().lobby?.hostAway === null && C2.lobbyTable()?.game.tableName === 'Monster Bash', 20_000);
    await until(() => co2.one.status().change?.state === 'offered');
    expect(co2.one.status().change?.detail).toBe(HERE('Monster Bash', 'Attack from Mars'));
    expect([co2.closes, co2.launched]).toEqual([[], []]);
    await co2.one.openPick();
    await until(() => co2.closes.length === 1);
    expect(co2.closes).toEqual(['Attack from Mars']);
  }, 60_000);
});
