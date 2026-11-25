/**
 * A17 step 3: closing the open table (`vpx-close.ts`), with nothing real closed: the Castcade VPX build is a scripted
 * control client on loopback against the real control listener of `main/stream3d-host.ts`, the window script is a fake
 * that records what it was asked, and the witness's word on the process is a flag the test moves. The three rungs:
 * `quit` on the control connection; the window asked to close; the person asked. Never a forced end: there is no call
 * here that could make one.
 *
 * Review of PR 137: `quit` only to a build proven to be the process (finding 4); `mayClose` asked again at the moment
 * the message is posted (finding 3); closed means the process has ended (finding 6); what the script prints (finding 10).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { QUIT_COMMAND, createStream3dHost, type ForkQuit, type Stream3dHost } from '../main/stream3d-host.js';
import { ScriptedFork, TunnelHub, until } from '../main/stream3d.test-support.js';
import { CLOSE_WAIT_MS, FORK_QUIT_WAIT_MS, askVpxWindowToClose, createVpxCloser, pickCloseTarget, windowScript, type VpxProcessWindow, type WindowAsk, type WindowScript } from './vpx-close.js';

const VPX = String.raw`C:\vpx\VPinballX_GL64.exe`;
const PID = 4242;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const win = (hwnd: string, className: string, title: string, visible = true): VpxProcessWindow => ({ hwnd, className, title, visible });
/** The windows of a VPX that plays a table started with -Play: the editor's main window behind the player, a DMD, a dialog class. */
const MAIN = win('1001', 'VPinball', 'Visual Pinball - [Monster Bash (Williams 1998)]', false);
const PLAYER = win('1002', 'VPPlayer', 'Visual Pinball Player 10.8.0');
const DMD = win('1003', 'Win32++', 'Virtual DMD');
const DIALOG = win('1004', '#32770', 'Visual Pinball');

const hosts: Stream3dHost[] = [];
const forks: ScriptedFork[] = [];
afterEach(async () => {
  for (const f of forks.splice(0)) f.close();
  for (const h of hosts.splice(0)) await h.stop();
});

/** The stream port a start in the fork is given here (the one its `hello` must name to be known as that start). */
const STREAM_PORT = 50_301;

/** The control port of a Castcade on this PC (the real listener), with its log. */
function control(): { host: Stream3dHost & ForkQuit; logs: string[] } {
  const logs: string[] = [];
  const hub = new TunnelHub();
  const host = createStream3dHost({
    log: { info: (l) => void logs.push(l), warn: (l) => void logs.push(`WARN ${l}`) },
    logsDir: String.raw`C:\logs`,
    pageDir: String.raw`C:\userData`,
    vpxExe: () => VPX,
    exists: async () => true,
    iceServers: () => [],
    tunnel: (t) => hub.make(t),
    freePort: async () => STREAM_PORT,
    ports: { read: () => null, write: () => undefined },
  });
  hosts.push(host);
  return { host, logs };
}

/** A build that says hello on the control connection, naming `streamPort` as the port its stream listens on. */
async function forkOn(c: { host: Stream3dHost }, streamPort = STREAM_PORT): Promise<ScriptedFork> {
  const f = await ScriptedFork.connect(await c.host.controlPort());
  forks.push(f);
  f.hello(undefined, undefined, streamPort);
  await sleep(30);
  return f;
}

/** Castcade starts a match table in the build: the launch it plans, and the process that start made. */
async function started(c: { host: Stream3dHost & ForkQuit }, pid = PID): Promise<ScriptedFork> {
  const l = await c.host.launch('auto');
  if (!l) throw new Error('no fork launch');
  l.spawned?.(pid);
  return forkOn(c);
}

/** The world of one close: the process (alive until the test ends it), the window that is asked, and what was asked of whom. */
function rig(o: { quitFork?: (pid: number) => boolean; window?: (pid: number, mayClose: () => boolean) => Promise<WindowAsk>; forkQuitWaitMs?: number; closeWaitMs?: number } = {}) {
  let alive = true;
  const cbs = new Set<() => void>();
  const asked: number[] = [];
  const logs: string[] = [];
  const closer = createVpxCloser({
    quitFork: o.quitFork ?? (() => false),
    askWindow: async (pid, mayClose) => {
      asked.push(pid);
      return o.window ? o.window(pid, mayClose) : { asked: true, kind: 'main' };
    },
    alive: () => alive,
    onChange: (cb) => (cbs.add(cb), () => void cbs.delete(cb)),
    log: { info: (l) => void logs.push(l), warn: (l) => void logs.push(`WARN ${l}`) },
    forkQuitWaitMs: o.forkQuitWaitMs ?? 40,
    closeWaitMs: o.closeWaitMs ?? 150,
  });
  return {
    closer,
    asked,
    logs,
    listeners: () => cbs.size,
    /** The process ends, and the witness says so. */
    exit() {
      alive = false;
      for (const cb of [...cbs]) cb();
    },
    /** The process ends and nobody says so yet (the process watch polls every 2 s). */
    endsQuietly() {
      alive = false;
    },
  };
}

/** A window script that records: what it listed for, what it posted to, how many runs were ended with nothing posted. */
function fakeScript(o: { vpx?: boolean; windows?: VpxProcessWindow[]; openMs?: number; posted?: { posted: boolean; why?: string }; fail?: string } = {}) {
  const opened: number[] = [];
  const posted: Array<[number, string]> = [];
  let cancelled = 0;
  const windows: WindowScript = {
    async open(pid) {
      opened.push(pid);
      if (o.openMs) await sleep(o.openMs);
      if (o.fail) throw new Error(o.fail);
      return {
        vpx: o.vpx ?? true,
        windows: o.windows ?? [PLAYER, MAIN, DMD],
        post: async (hwnd) => {
          posted.push([pid, hwnd]);
          return o.posted ?? { posted: true };
        },
        cancel: () => void (cancelled += 1),
      };
    },
  };
  return { windows, opened, posted, cancelled: () => cancelled };
}

describe('closing the open table: which window is asked (A17 step 3)', () => {
  it('the VPX main window is asked when the process has one: it closes the player and then the program', () => {
    expect(pickCloseTarget([DMD, PLAYER, MAIN, DIALOG])).toEqual({ window: MAIN, kind: 'main' });
  });

  it('without a main window the player window is asked; a DMD, a backglass or a dialog never is', () => {
    expect(pickCloseTarget([DMD, PLAYER, DIALOG])).toEqual({ window: PLAYER, kind: 'player' });
    expect(pickCloseTarget([win('7', 'Win32++', 'Visual Pinball X Player')])?.kind).toBe('player');
    expect(pickCloseTarget([DMD, DIALOG])).toBeNull();
    expect(pickCloseTarget([])).toBeNull();
  });

  it('a fake window: the message goes to the main window of that process, and only what the script lists is ever asked', async () => {
    const s = fakeScript();
    expect(await askVpxWindowToClose(PID, () => true, s.windows)).toEqual({ asked: true, kind: 'main' });
    expect(s.opened).toEqual([PID]);
    expect(s.posted).toEqual([[PID, '1001']]);
    expect(s.cancelled()).toBe(0);
  });

  it('nothing is asked of a process that is gone or is not VPX, of one with no window to ask, or when the script fails; the run is ended and it never throws', async () => {
    const gone = fakeScript({ vpx: false, windows: [] });
    expect(await askVpxWindowToClose(PID, () => true, gone.windows)).toEqual({ asked: false, reason: 'that process is gone, or is not VPX' });
    const none = fakeScript({ windows: [DMD, DIALOG] });
    expect(await askVpxWindowToClose(PID, () => true, none.windows)).toMatchObject({ asked: false, reason: expect.stringContaining('no window to ask') as unknown });
    const broken = fakeScript({ fail: 'the window script timed out' });
    expect(await askVpxWindowToClose(PID, () => true, broken.windows)).toEqual({ asked: false, reason: 'the window script timed out' });
    expect([...gone.posted, ...none.posted, ...broken.posted]).toEqual([]);
    expect([gone.cancelled(), none.cancelled()]).toEqual([1, 1]);
    // The window went between the listing and the message: said, not thrown.
    const late = fakeScript({ windows: [MAIN], posted: { posted: false, why: 'gone' } });
    expect(await askVpxWindowToClose(PID, () => true, late.windows)).toEqual({ asked: false, reason: 'gone' });
  });

  it('a game that begins while the script starts is not closed: the caller is asked before the script starts and again when it has listed, and the message only follows that second answer (finding 3)', async () => {
    // The script takes its time to compile and list (a second or more on a busy PC; 40 ms here). 10 ms in, a game begins.
    let may = true;
    const s = fakeScript({ openMs: 40 });
    const asking = askVpxWindowToClose(PID, () => may, s.windows);
    setTimeout(() => (may = false), 10);
    expect(await asking).toEqual({ asked: false, held: true });
    expect(s.opened).toEqual([PID]);
    expect(s.posted).toEqual([]);
    // The run was ended with nothing posted.
    expect(s.cancelled()).toBe(1);
    // A no before anything: the script is not even started.
    const never = fakeScript();
    expect(await askVpxWindowToClose(PID, () => false, never.windows)).toEqual({ asked: false, held: true });
    expect(never.opened).toEqual([]);
  });

  it('the script: one run that lists, waits for a word on its input and posts only then; its output is ASCII whatever a window is titled (finding 10)', () => {
    const text = windowScript(PID);
    // Nothing of the script itself is outside ASCII, and the console writes UTF-8 without a mark.
    expect([...text].every((c) => [9, 10, 13].includes(c.charCodeAt(0)) || (c.charCodeAt(0) >= 32 && c.charCodeAt(0) <= 126))).toBe(true);
    expect(text).toContain('[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)');
    // A title's control characters, quotes, backslashes and everything above ASCII go out as \uXXXX.
    expect(text).toContain(String.raw`if (c < 0x20 || c > 0x7e || c == '"' || c == '\\') b.Append("\\u").Append(((int)c).ToString("x4"));`);
    // The listing comes first, then the wait for the word, and the message is posted only on `close <hwnd>`.
    const list = text.indexOf(`[CastcadeClose]::List(${PID})`);
    const read = text.indexOf('[Console]::In.ReadLine()');
    const close = text.indexOf(`[CastcadeClose]::Close(${PID}, [long]$Matches[1])`);
    expect(list).toBeGreaterThan(0);
    expect(read).toBeGreaterThan(list);
    expect(close).toBeGreaterThan(read);
    expect(text).toContain("if ($word -match '^close (-?[0-9]{1,20})$')");
    // The pid is the only thing put into it, and it must be one.
    expect(() => windowScript(Number.NaN)).toThrow('not a process id');
    expect(() => windowScript(-1)).toThrow('not a process id');
  });
});

describe('closing the open table: the three rungs (A17 step 3)', () => {
  it('the design times: quit has 6 s, the person is asked 15 s after the first request', () => {
    expect(FORK_QUIT_WAIT_MS).toBe(6_000);
    expect(CLOSE_WAIT_MS).toBe(15_000);
    expect(QUIT_COMMAND).toBe('quit');
  });

  it('rung 1: the Castcade VPX build that Castcade started gets the line quit on its control connection, leaves, and no window is asked', async () => {
    const c = control();
    const fork = await started(c);
    const r = rig({ quitFork: (pid) => c.host.quitFork(pid) });
    const closing = r.closer.close('Monster Bash', PID);
    await fork.next('quit');
    expect(fork.got).toEqual(['quit']);
    // The build closes its table and exits: its control connection goes, the process watch sees the process end.
    fork.close();
    r.exit();
    expect(await closing).toEqual({ state: 'closed', rung: 1 });
    expect(r.asked).toEqual([]);
    expect(c.logs.some((l) => /quit sent to the Castcade VPX build on the control port \(pid 4242/.test(l))).toBe(true);
    expect(r.listeners()).toBe(0);
  });

  it('quit only goes to a build that is proven to be the process asked about: not to another process, not to a build started by hand (finding 4)', async () => {
    // Castcade started pid 4242 in the build; the VPX asked to close is pid 999 (another VPX is the one with the table).
    const c = control();
    const fork = await started(c, PID);
    expect(c.host.quitFork(999)).toBe(false);
    // A build somebody started from its own launcher: on the control connection, and no start of Castcade's is known for it.
    const d = control();
    const byHand = await forkOn(d, 47_800);
    expect(d.host.quitFork(PID)).toBe(false);
    // A build Castcade started whose hello names another stream port than that start asked for: not known to be it.
    const e = control();
    const l = await e.host.launch('auto');
    l?.spawned?.(PID);
    const other = await forkOn(e, STREAM_PORT + 1);
    expect(e.host.quitFork(PID)).toBe(false);
    // A start that ended: its process is forgotten.
    const g = control();
    const gl = await g.host.launch('auto');
    gl?.spawned?.(PID);
    const late = await forkOn(g);
    gl?.options.onExit?.(0);
    expect(g.host.quitFork(PID)).toBe(false);
    await sleep(30);
    for (const f of [fork, byHand, other, late]) expect(f.got).toEqual([]);
    expect(c.logs.some((line) => /quit is not sent: the Castcade VPX build on the control port is not known to be the VPX that is asked to close \(pid 999\)/.test(line))).toBe(true);
    // In the closer that is rung 2 at once: the window of the process asked about.
    const r = rig({ quitFork: (pid) => c.host.quitFork(pid) });
    const closing = r.closer.close('Monster Bash', 999);
    await until(() => r.asked.length === 1, 2_000, 'the window to be asked');
    expect(r.asked).toEqual([999]);
    r.exit();
    expect(await closing).toEqual({ state: 'closed', rung: 2 });
    expect(fork.got).toEqual([]);
  });

  it('rung 1 to rung 2: a build from before the line ignores it and stays open; its window is asked next, and it closes', async () => {
    const c = control();
    const fork = await started(c);
    const r = rig({ quitFork: (pid) => c.host.quitFork(pid), forkQuitWaitMs: 40, closeWaitMs: 2_000 });
    const closing = r.closer.close('Monster Bash', PID);
    await fork.next('quit');
    expect(r.asked).toEqual([]);
    // Rule 13: an unknown line is ignored. Nothing happens on the fork's side.
    await until(() => r.asked.length === 1, 2_000, 'the window to be asked');
    expect(r.asked).toEqual([PID]);
    r.exit();
    expect(await closing).toEqual({ state: 'closed', rung: 2 });
    // One quit, one window request: nothing is repeated, nothing else is done to the process.
    expect(fork.count('play') + fork.count('watch')).toBe(0);
    expect(fork.got).toEqual(['quit']);
  });

  it('rung 2: any other VPX (no build on the control connection): its window is asked at once, and it closes', async () => {
    const c = control();
    await c.host.controlPort();
    expect(c.host.quitFork(PID)).toBe(false);
    const r = rig({ quitFork: (pid) => c.host.quitFork(pid) });
    const closing = r.closer.close('Monster Bash', PID);
    await until(() => r.asked.length === 1, 2_000, 'the window to be asked');
    r.exit();
    expect(await closing).toEqual({ state: 'closed', rung: 2 });
    expect(r.logs.some((l) => /asked the VPX window of Monster Bash to close \(WM_CLOSE, pid 4242\)/.test(l))).toBe(true);
  });

  it('closed means the process has ended, whatever the witness still says of its table: a build that left on quit is not answered with "ask" (finding 6)', async () => {
    // The build obeys quit and is gone within the 6 s; the process watch has not said so when the next rung comes up.
    const r = rig({ quitFork: () => true, forkQuitWaitMs: 60, closeWaitMs: 2_000 });
    const closing = r.closer.close('Monster Bash', PID);
    setTimeout(() => r.endsQuietly(), 20);
    expect(await closing).toEqual({ state: 'closed', rung: 1 });
    // No window was asked, and nobody was told to close a table that is closed.
    expect(r.asked).toEqual([]);
    expect(r.logs.filter((l) => l.startsWith('WARN'))).toEqual([]);
    expect(r.logs.at(-1)).toBe('close: Monster Bash is closed: its VPX (pid 4242) has ended (the Castcade VPX build left on quit)');
    // The same at the last moment: the 15 s are up and the process has just gone.
    const late = rig({ closeWaitMs: 60 });
    const closingLate = late.closer.close('Monster Bash', PID);
    setTimeout(() => late.endsQuietly(), 30);
    expect(await closingLate).toEqual({ state: 'closed', rung: 2 });
    // A process that is gone before anything was asked is closed too.
    const before = rig();
    before.endsQuietly();
    expect(await before.closer.close('Monster Bash', PID)).toEqual({ state: 'closed', rung: 1 });
    expect(before.asked).toEqual([]);
  });

  it('rung 3: still running after the wait: the person is asked; the window was asked once and nothing is ended by force', async () => {
    const r = rig({ closeWaitMs: 80 });
    const out = await r.closer.close('Monster Bash', PID);
    // `asked`: a request is out all the same, and may still be obeyed.
    expect(out).toMatchObject({ state: 'ask', asked: true });
    expect(r.asked).toEqual([PID]);
    expect(r.logs.at(-1)).toMatch(/WARN close: Monster Bash is still open .*the person is asked to close it; nothing is ended by force/);
    expect(r.listeners()).toBe(0);
  });

  it('rung 3 at once when the window could not be asked: nothing is out', async () => {
    const noWindow = rig({ window: async () => ({ asked: false, reason: 'VPX has no window to ask' }), closeWaitMs: 5_000 });
    expect(await noWindow.closer.close('Monster Bash', PID)).toMatchObject({ state: 'ask', asked: false, why: expect.stringContaining('no window to ask') as unknown });
    expect(noWindow.asked).toEqual([PID]);
  });

  it('a game that begins before a request, or while the window script starts: nothing (more) is asked', async () => {
    // Before anything: not even quit.
    let quits = 0;
    const first = rig({ quitFork: () => (quits++, true) });
    expect(await first.closer.close('Monster Bash', PID, () => false)).toEqual({ state: 'held', asked: false });
    expect(quits).toBe(0);
    expect(first.asked).toEqual([]);
    // After quit, before the window: the build ignored quit, a game began, the window is left alone.
    let may = true;
    const second = rig({ quitFork: () => true, forkQuitWaitMs: 30, closeWaitMs: 2_000 });
    const closing = second.closer.close('Monster Bash', PID, () => may);
    may = false;
    expect(await closing).toEqual({ state: 'held', asked: true });
    expect(second.asked).toEqual([]);
    // While the window script starts (the real second rung, with a script that takes 40 ms to list): the message is not posted.
    let go = true;
    const s = fakeScript({ openMs: 40 });
    const third = rig({ window: (pid, mayClose) => askVpxWindowToClose(pid, mayClose, s.windows), closeWaitMs: 2_000 });
    const closing3 = third.closer.close('Monster Bash', PID, () => go);
    setTimeout(() => (go = false), 10);
    expect(await closing3).toEqual({ state: 'held', asked: false });
    expect(s.posted).toEqual([]);
  });

  it('one close per process at a time: a second call while one runs gets the same answer and asks nothing twice', async () => {
    const r = rig({ closeWaitMs: 2_000 });
    const a = r.closer.close('Monster Bash', PID);
    const b = r.closer.close('Monster Bash', PID);
    await until(() => r.asked.length >= 1, 2_000, 'the window to be asked');
    r.exit();
    expect(await a).toEqual({ state: 'closed', rung: 2 });
    expect(await b).toEqual({ state: 'closed', rung: 2 });
    expect(r.asked).toEqual([PID]);
  });

  it('the control connection: quit goes to nobody once Castcade stops', async () => {
    const c = control();
    const fork = await started(c);
    expect(c.host.quitFork(PID)).toBe(true);
    await fork.next('quit');
    await c.host.stop();
    expect(c.host.quitFork(PID)).toBe(false);
  });
});
