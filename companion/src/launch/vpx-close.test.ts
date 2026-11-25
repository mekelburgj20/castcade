/**
 * A17 step 3: closing the open table (`vpx-close.ts`), with nothing real closed: the Castcade VPX build is a scripted
 * control client on loopback against the real control listener of `main/stream3d-host.ts`, the window is a fake that
 * records what it was asked, and the witness's word on the table is a flag the test moves. The three rungs: `quit` on
 * the control connection; the window asked to close; the person asked. Never a forced end: there is no call here
 * that could make one.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { QUIT_COMMAND, createStream3dHost, type ForkQuit, type Stream3dHost } from '../main/stream3d-host.js';
import { ScriptedFork, TunnelHub, until } from '../main/stream3d.test-support.js';
import { CLOSE_WAIT_MS, FORK_QUIT_WAIT_MS, askVpxWindowToClose, createVpxCloser, pickCloseTarget, type VpxProcessWindow, type WindowAsk, type WindowScript } from './vpx-close.js';

const VPX = String.raw`C:\vpx\VPinballX_GL64.exe`;
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
    freePort: async () => 50_301,
    ports: { read: () => null, write: () => undefined },
  });
  hosts.push(host);
  return { host, logs };
}

/** A Castcade VPX build on the control connection, as after a table start: it has said hello. */
async function forkOn(c: { host: Stream3dHost }): Promise<ScriptedFork> {
  const f = await ScriptedFork.connect(await c.host.controlPort());
  forks.push(f);
  f.hello();
  await sleep(30);
  return f;
}

/** The world of one close: the table (open until the test closes it), the window that is asked, and what was asked of whom. */
function rig(o: { quitFork?: () => boolean; pid?: number | null; window?: (pid: number) => Promise<WindowAsk>; forkQuitWaitMs?: number; closeWaitMs?: number } = {}) {
  let open = true;
  const cbs = new Set<() => void>();
  const asked: number[] = [];
  const logs: string[] = [];
  const closer = createVpxCloser({
    quitFork: o.quitFork ?? (() => false),
    askWindow: async (pid) => {
      asked.push(pid);
      return o.window ? o.window(pid) : { asked: true, kind: 'main' };
    },
    pid: () => (o.pid === undefined ? 4242 : o.pid),
    open: () => open,
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
    /** The witness sees the table go (VPX exited). */
    exit() {
      open = false;
      for (const cb of [...cbs]) cb();
    },
  };
}

describe('closing the open table: which window is asked (A17 step 3)', () => {
  it("the VPX main window is asked when the process has one: it closes the player and then the program", () => {
    expect(pickCloseTarget([DMD, PLAYER, MAIN, DIALOG])).toEqual({ window: MAIN, kind: 'main' });
  });

  it('without a main window the player window is asked; a DMD, a backglass or a dialog never is', () => {
    expect(pickCloseTarget([DMD, PLAYER, DIALOG])).toEqual({ window: PLAYER, kind: 'player' });
    expect(pickCloseTarget([win('7', 'Win32++', 'Visual Pinball X Player')])?.kind).toBe('player');
    expect(pickCloseTarget([DMD, DIALOG])).toBeNull();
    expect(pickCloseTarget([])).toBeNull();
  });

  it('a fake window: the message goes to the main window of that process, and only what the script lists is ever asked', async () => {
    const posted: Array<[number, string]> = [];
    const script: WindowScript = {
      list: async () => ({ vpx: true, windows: [PLAYER, MAIN, DMD] }),
      close: async (pid, hwnd) => {
        posted.push([pid, hwnd]);
        return { posted: true };
      },
    };
    expect(await askVpxWindowToClose(4242, script)).toEqual({ asked: true, kind: 'main' });
    expect(posted).toEqual([[4242, '1001']]);
  });

  it('nothing is asked of a process that is gone or is not VPX, of one with no window to ask, or when the script fails; it never throws', async () => {
    const posted: string[] = [];
    const close = async (_pid: number, hwnd: string): Promise<{ posted: boolean; why?: string }> => {
      posted.push(hwnd);
      return { posted: true };
    };
    expect(await askVpxWindowToClose(4242, { list: async () => ({ vpx: false, windows: [] }), close })).toEqual({ asked: false, reason: 'that process is gone, or is not VPX' });
    expect(await askVpxWindowToClose(4242, { list: async () => ({ vpx: true, windows: [DMD, DIALOG] }), close })).toMatchObject({ asked: false, reason: expect.stringContaining('no window to ask') as unknown });
    expect(
      await askVpxWindowToClose(4242, {
        list: async () => {
          throw new Error('the window script timed out');
        },
        close,
      }),
    ).toEqual({ asked: false, reason: 'the window script timed out' });
    expect(posted).toEqual([]);
    // The window went between the listing and the message: said, not thrown.
    expect(await askVpxWindowToClose(4242, { list: async () => ({ vpx: true, windows: [MAIN] }), close: async () => ({ posted: false, why: 'gone' }) })).toEqual({ asked: false, reason: 'gone' });
  });
});

describe('closing the open table: the three rungs (A17 step 3)', () => {
  it('the design times: quit has 6 s, the person is asked 15 s after the first request', () => {
    expect(FORK_QUIT_WAIT_MS).toBe(6_000);
    expect(CLOSE_WAIT_MS).toBe(15_000);
    expect(QUIT_COMMAND).toBe('quit');
  });

  it('rung 1: the Castcade VPX build gets the line quit on its control connection, leaves, and no window is asked', async () => {
    const c = control();
    const fork = await forkOn(c);
    const r = rig({ quitFork: () => c.host.quitFork() });
    const closing = r.closer.close('Monster Bash');
    await fork.next('quit');
    expect(fork.got).toEqual(['quit']);
    // The build closes its table and exits: its control connection goes, the witness sees the table go.
    fork.close();
    r.exit();
    expect(await closing).toEqual({ state: 'closed', rung: 1 });
    expect(r.asked).toEqual([]);
    expect(c.logs.some((l) => /quit sent to the Castcade VPX build/.test(l))).toBe(true);
    expect(r.listeners()).toBe(0);
  });

  it('rung 1 to rung 2: a build from before the line ignores it and stays open; its window is asked next, and it closes', async () => {
    const c = control();
    const fork = await forkOn(c);
    const r = rig({ quitFork: () => c.host.quitFork(), forkQuitWaitMs: 40, closeWaitMs: 2_000 });
    const closing = r.closer.close('Monster Bash');
    await fork.next('quit');
    expect(r.asked).toEqual([]);
    // Rule 13: an unknown line is ignored. Nothing happens on the fork's side.
    await until(() => r.asked.length === 1, 2_000, 'the window to be asked');
    expect(r.asked).toEqual([4242]);
    r.exit();
    expect(await closing).toEqual({ state: 'closed', rung: 2 });
    // One quit, one window request: nothing is repeated, nothing else is done to the process.
    expect(fork.count('play') + fork.count('watch')).toBe(0);
    expect(fork.got).toEqual(['quit']);
  });

  it('rung 2: any other VPX (no build on the control connection): its window is asked at once, and it closes', async () => {
    const c = control();
    await c.host.controlPort();
    expect(c.host.quitFork()).toBe(false);
    const r = rig({ quitFork: () => c.host.quitFork() });
    const closing = r.closer.close('Monster Bash');
    await until(() => r.asked.length === 1, 2_000, 'the window to be asked');
    r.exit();
    expect(await closing).toEqual({ state: 'closed', rung: 2 });
    expect(r.logs.some((l) => /asked the VPX window of Monster Bash to close \(WM_CLOSE, pid 4242\)/.test(l))).toBe(true);
  });

  it('rung 3: still open after the wait: the person is asked; the window was asked once and nothing is ended by force', async () => {
    const r = rig({ closeWaitMs: 80 });
    const out = await r.closer.close('Monster Bash');
    expect(out).toMatchObject({ state: 'ask' });
    expect(r.asked).toEqual([4242]);
    expect(r.logs.at(-1)).toMatch(/WARN close: Monster Bash is still open .*the person is asked to close it; nothing is ended by force/);
    expect(r.listeners()).toBe(0);
    // A table that closes later is the wish's to see (the witness), not this closer's: a new close finds it closed.
    r.exit();
    expect(await r.closer.close('Monster Bash')).toEqual({ state: 'closed', rung: 1 });
  });

  it('rung 3 at once when nothing can be asked: no process known, or a window that could not be asked', async () => {
    const noPid = rig({ pid: null, closeWaitMs: 5_000 });
    expect(await noPid.closer.close('Monster Bash')).toMatchObject({ state: 'ask', why: expect.stringContaining('does not know which VPX process') as unknown });
    expect(noPid.asked).toEqual([]);
    const noWindow = rig({ window: async () => ({ asked: false, reason: 'VPX has no window to ask' }), closeWaitMs: 5_000 });
    expect(await noWindow.closer.close('Monster Bash')).toMatchObject({ state: 'ask', why: expect.stringContaining('no window to ask') as unknown });
    expect(noWindow.asked).toEqual([4242]);
  });

  it('a game that begins before a request: nothing (more) is asked', async () => {
    // Before anything: not even quit.
    let quits = 0;
    const first = rig({ quitFork: () => (quits++, true) });
    expect(await first.closer.close('Monster Bash', () => false)).toEqual({ state: 'held', asked: false });
    expect(quits).toBe(0);
    expect(first.asked).toEqual([]);
    // After quit, before the window: the build ignored quit, a game began, the window is left alone.
    let may = true;
    const second = rig({ quitFork: () => true, forkQuitWaitMs: 30, closeWaitMs: 2_000 });
    const closing = second.closer.close('Monster Bash', () => may);
    may = false;
    expect(await closing).toEqual({ state: 'held', asked: true });
    expect(second.asked).toEqual([]);
  });

  it('one close at a time: a second call while one runs gets the same answer and asks nothing twice', async () => {
    const r = rig({ closeWaitMs: 2_000 });
    const a = r.closer.close('Monster Bash');
    const b = r.closer.close('Monster Bash');
    await until(() => r.asked.length >= 1, 2_000, 'the window to be asked');
    r.exit();
    expect(await a).toEqual({ state: 'closed', rung: 2 });
    expect(await b).toEqual({ state: 'closed', rung: 2 });
    expect(r.asked).toEqual([4242]);
  });

  it('the control connection: quit goes to the build that is connected, and to nobody once Castcade stops', async () => {
    const c = control();
    const fork = await forkOn(c);
    expect(c.host.quitFork()).toBe(true);
    await fork.next('quit');
    await c.host.stop();
    expect(c.host.quitFork()).toBe(false);
  });
});
