/**
 * I11.4.1: the shell's witness host and the 3D watch VPX instances, over the real witness with a scripted process list
 * (real timers, a short poll). The remembered VPX exe (settings `vpxExe`, what A14 starts tables with) is never the
 * fork's, whoever started it; a watcher Castcade announced leaves the running game's pid, its start and the
 * `table_exit` feed alone; the stock path remembers the exe as before.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createStaticRegistry, MemoryFs } from '../witness/index.js';
import { HiddenVpx } from '../witness/hidden-vpx.js';
import type { ProcessInfo } from '../witness/process-watch.js';
import type { Logger } from './log.js';
import type { SettingsStore } from './settings.js';
import { createWitnessHost, type WitnessHost } from './witness-host.js';

const repo = (p: string): string => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const OLD = String.raw`C:\Old\VPinballX64.exe`;
const STOCK = String.raw`C:\VPX\VPinballX_GL64.exe`;
const FORK = String.raw`C:\VPX\VPinballX_GL64_castcade.exe`;
const TABLE = String.raw`C:\VPX\tables\Nudge Test and Calibration.vpx`;
const until = async (cond: () => boolean, ms = 4000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const hosts: WitnessHost[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.stop();
});

function rig() {
  const settings = {
    arcaidBaseUrl: 'https://arcaid.test',
    deviceId: 'dev-1',
    deviceLabel: 'TEST-PC',
    token: null,
    mapsDir: repo('fixtures/maps'),
    nvramDir: '/nv',
    dataDir: '/data',
    vpsDir: repo('fixtures/vps'),
    tablesDir: null,
    vpxExe: OLD as string | null,
  };
  const store = {
    file: '',
    get: () => ({ ...settings }),
    set: async (patch: Partial<typeof settings>) => void Object.assign(settings, patch),
    onChange: () => () => undefined,
  } as unknown as SettingsStore;
  const logs: string[] = [];
  const log = { info: (l: string) => void logs.push(l), warn: (l: string) => void logs.push(l), error: (l: string) => void logs.push(l), file: '' } as unknown as Logger;
  let procs: ProcessInfo[] = [];
  const hidden = new HiddenVpx();
  const wh = createWitnessHost(store, log, {
    fs: new MemoryFs(),
    lister: { list: async () => procs.map((p) => ({ ...p })) },
    hideProcess: (p) => hidden.hides(p),
    vrProbe: null,
    registry: createStaticRegistry({}),
    fetch: async () => {
      throw new Error('no network in this test');
    },
    journalDir: null,
    pollIntervalMs: 20,
    // The close-time wait for VPinMAME's write: short, so the next launch is not queued behind it.
    nvSettleMs: 50,
    nvPollMs: 10,
    romMapRefreshMs: null,
    vpsRefreshMs: null,
  });
  hosts.push(wh);
  const feed: string[] = [];
  wh.onEvent((e) => feed.push(e.kind));
  return {
    wh,
    settings,
    logs,
    hidden,
    feed,
    run: (list: ProcessInfo[]) => {
      procs = list;
    },
  };
}

const vpx = (pid: number, exe: string, startedAt = Date.now()): ProcessInfo => ({ pid, exe, commandLine: `"${exe}" -Play "${TABLE}"`, startedAt, windowTitle: null });

describe('the witness host and the VPX fork (I11.4.1)', () => {
  it("never remembers the fork's exe, whoever started it; the stock VPX is remembered as before", async () => {
    const r = rig();
    await r.wh.start();
    // The fork from its own .bat launcher (Castcade did not start it): witnessed as a game, its exe not remembered.
    r.run([vpx(40, FORK)]);
    await until(() => r.wh.vpxPid?.() === 40);
    await sleep(80);
    expect(r.settings.vpxExe).toBe(OLD);
    expect(r.wh.status().vpxExe).toBeNull();
    expect(r.logs.some((l) => l.startsWith('witness: launch') && l.includes('VPinballX_GL64_castcade.exe'))).toBe(true);
    r.run([]);
    await until(() => r.wh.vpxPid?.() === null);
    expect(r.feed).toEqual(['table_exit']);
    // The stock VPX: remembered, as ever.
    r.run([vpx(41, STOCK)]);
    await until(() => r.settings.vpxExe === STOCK);
    expect(r.wh.status().vpxExe).toBe(STOCK);
  });

  it("a watcher Castcade announced leaves the running game's pid, start and table_exit feed alone", async () => {
    const r = rig();
    await r.wh.start();
    const gameStart = Date.now() - 60_000;
    const game = vpx(41, STOCK, gameStart);
    r.run([game]);
    await until(() => r.wh.vpxPid?.() === 41);
    // The watch host announces the watcher before the spawn; the poll sees it before the pid is bound.
    const expected = r.hidden.expect({ exe: FORK, tablePath: TABLE });
    const watcher = vpx(42, FORK);
    r.run([game, watcher]);
    await sleep(100);
    expected.bind(42);
    await sleep(60);
    expect(r.wh.vpxPid?.()).toBe(41);
    expect(r.wh.vpxStartedAt?.()).toBe(gameStart);
    expect(r.logs.filter((l) => l.startsWith('witness: launch'))).toHaveLength(1);
    // The watcher closes: no table_exit, the game's pid stays.
    r.run([game]);
    expected.done();
    await sleep(100);
    expect(r.feed).toEqual([]);
    expect(r.wh.vpxPid?.()).toBe(41);
    expect(r.logs.some((l) => l.startsWith('witness: exit'))).toBe(false);
    expect(r.settings.vpxExe).toBe(STOCK);
    // The game closes: its table_exit, as ever.
    r.run([]);
    await until(() => r.feed.length === 1);
    expect(r.feed).toEqual(['table_exit']);
    expect(r.wh.vpxPid?.()).toBeNull();
  });
});
