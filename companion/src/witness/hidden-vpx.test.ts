/**
 * I11.4.1: the watchers Castcade starts for a 3D watch session are invisible to the process watch. The registry
 * (expected before the spawn, matched by exe, `-Play` table and start time until the pid is bound, by pid after; one
 * process each; a lapse when nothing came) and the process watch's `hide` (asked once per new pid; a hidden pid gets
 * no launch, title or exit; an ordinary process beside it is watched as ever).
 */
import { describe, expect, it } from 'vitest';
import { ManualClock } from '../match/clock.js';
import { HiddenVpx, START_SLACK_MS, UNBOUND_TTL_MS } from './hidden-vpx.js';
import { FORK_EXE_NAME, ProcessWatch, isForkExe, type ProcessInfo, type VpxExit, type VpxLaunch, type VpxTitle } from './process-watch.js';

const FORK = String.raw`C:\VPX\VPinballX_GL64_castcade.exe`;
const STOCK = String.raw`C:\VPX\VPinballX_GL64.exe`;
const TABLE = String.raw`C:\VPX\tables\Nudge Test and Calibration.vpx`;
const T0 = 1_760_000_000_000;
const proc = (pid: number, o: Partial<ProcessInfo> = {}): ProcessInfo => ({ pid, exe: FORK, commandLine: `"${FORK}" -Play "${TABLE}"`, startedAt: T0, windowTitle: null, ...o });

describe('isForkExe', () => {
  it("is the fork's file name, in any case and either slash, and nothing else", () => {
    expect(FORK_EXE_NAME).toBe('VPinballX_GL64_castcade.exe');
    expect(isForkExe(FORK)).toBe(true);
    expect(isForkExe('c:/vpx/vpinballx_gl64_CASTCADE.EXE')).toBe(true);
    expect(isForkExe('VPinballX_GL64_castcade.exe')).toBe(true);
    expect(isForkExe(STOCK)).toBe(false);
    expect(isForkExe(String.raw`C:\VPinballX_GL64_castcade.exe.bak\VPinballX64.exe`)).toBe(false);
    expect(isForkExe(null)).toBe(false);
  });
});

describe('HiddenVpx', () => {
  it('claims the expected watcher before its pid is known, by exe, table and start time, and only that one', () => {
    let now = T0;
    const h = new HiddenVpx(() => now);
    const e = h.expect({ exe: FORK, tablePath: TABLE });
    now += 800;
    // The process watch sees it before the spawn returned the pid.
    expect(h.hides(proc(100, { startedAt: T0 + 300 }))).toBe(true);
    // One expectation, one process: a second fork on the same table is not this watcher.
    expect(h.hides(proc(101, { startedAt: T0 + 500 }))).toBe(false);
    // The pid the spawn returns is the one it claimed; after the watcher closes, the pid is free again.
    e.bind(100);
    expect(h.hides(proc(100, { startedAt: T0 + 300 }))).toBe(true);
    // Another process on that pid (it started later) is not the watcher.
    expect(h.hides(proc(100, { startedAt: T0 + 90_000 }))).toBe(false);
    e.done();
    expect(h.size).toBe(0);
    expect(h.hides(proc(100, { startedAt: T0 + 300 }))).toBe(false);
  });

  it('bound first, claims the pid alone whatever its command line', () => {
    const h = new HiddenVpx(() => T0);
    h.expect({ exe: FORK, tablePath: TABLE }).bind(200);
    expect(h.hides(proc(201))).toBe(false);
    expect(h.hides(proc(200, { commandLine: '' }))).toBe(true);
  });

  it('never claims another exe, another table, the editor, or a process that started before it was expected', () => {
    const h = new HiddenVpx(() => T0);
    h.expect({ exe: FORK, tablePath: TABLE });
    expect(h.hides(proc(1, { exe: STOCK, commandLine: `"${STOCK}" -Play "${TABLE}"` }))).toBe(false);
    expect(h.hides(proc(2, { commandLine: `"${FORK}" -Play "C:\\VPX\\tables\\Other.vpx"` }))).toBe(false);
    expect(h.hides(proc(3, { commandLine: `"${FORK}"` }))).toBe(false);
    expect(h.hides(proc(4, { startedAt: T0 - START_SLACK_MS - 1 }))).toBe(false);
    // Case and slashes do not matter; an unknown start time does not stop a match.
    expect(h.hides(proc(5, { exe: FORK.toLowerCase().replace(/\\/g, '/'), commandLine: `"${FORK}" -play "${TABLE.toUpperCase()}"`, startedAt: null }))).toBe(true);
  });

  it('matches a lister that gave the process name only by the file name', () => {
    const h = new HiddenVpx(() => T0);
    h.expect({ exe: FORK, tablePath: TABLE });
    expect(h.hides(proc(7, { exe: 'VPinballX_GL64_castcade.exe' }))).toBe(true);
  });

  it('lets an expectation no process matched lapse (the spawn failed), but keeps a bound one', () => {
    let now = T0;
    const h = new HiddenVpx(() => now);
    h.expect({ exe: FORK, tablePath: TABLE });
    h.expect({ exe: FORK, tablePath: TABLE }).bind(300);
    now += UNBOUND_TTL_MS + 1;
    expect(h.hides(proc(9, { startedAt: now }))).toBe(false);
    expect(h.size).toBe(1);
    expect(h.hides(proc(300))).toBe(true);
  });
});

describe('ProcessWatch with hide', () => {
  const flush = async () => {
    for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r));
  };

  it('a hidden pid gets no launch, title or exit; an ordinary process beside it is watched as ever; hide is asked once per pid', async () => {
    const clock = new ManualClock(T0);
    let procs: ProcessInfo[] = [];
    const asked: number[] = [];
    const registry = new HiddenVpx(() => clock.now());
    registry.expect({ exe: FORK, tablePath: TABLE });
    const watch = new ProcessWatch({
      lister: { list: async () => procs.map((p) => ({ ...p })) },
      clock,
      intervalMs: 2000,
      hide: (p) => {
        asked.push(p.pid);
        return registry.hides(p);
      },
    });
    const launches: VpxLaunch[] = [];
    const exits: VpxExit[] = [];
    const titles: VpxTitle[] = [];
    watch.on('launch', (l) => launches.push(l));
    watch.on('exit', (e) => exits.push(e));
    watch.on('title', (t) => titles.push(t));
    const game = proc(50, { exe: STOCK, commandLine: `"${STOCK}" -Play "${TABLE}"` });
    const watcher = proc(60, { startedAt: T0 + 100 });
    procs = [watcher, game];
    await watch.pollOnce();
    await flush();
    expect(launches.map((l) => l.pid)).toEqual([50]);
    // Its title changes, it keeps running: still nothing; hide is not asked again.
    procs = [{ ...watcher, windowTitle: 'Visual Pinball Player' }, { ...game, windowTitle: 'Visual Pinball Player' }];
    await watch.pollOnce();
    expect(titles.map((t) => t.launch.pid)).toEqual([50]);
    expect(asked).toEqual([60, 50]);
    expect(watch.current().map((l) => l.pid)).toEqual([50]);
    // The watcher closes: no exit. The game closes: its exit.
    procs = [game];
    await watch.pollOnce();
    expect(exits).toEqual([]);
    procs = [];
    await watch.pollOnce();
    expect(exits.map((e) => e.launch.pid)).toEqual([50]);
    // The watcher's pid comes back later as an ordinary process (Windows reuses pids), even with no `done` heard: it
    // is asked again, and seen.
    procs = [proc(60, { exe: STOCK, commandLine: `"${STOCK}"`, startedAt: T0 + 60_000 })];
    await watch.pollOnce();
    expect(launches.map((l) => l.pid)).toEqual([50, 60]);
  });

  it('a hide that throws hides nothing', async () => {
    const watch = new ProcessWatch({
      lister: { list: async () => [proc(70)] },
      clock: new ManualClock(T0),
      hide: () => {
        throw new Error('broken');
      },
    });
    const launches: VpxLaunch[] = [];
    watch.on('launch', (l) => launches.push(l));
    await watch.pollOnce();
    expect(launches.map((l) => l.pid)).toEqual([70]);
  });
});
