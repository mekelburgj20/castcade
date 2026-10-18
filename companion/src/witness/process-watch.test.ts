import { describe, expect, it } from 'vitest';
import { ManualClock } from '../match/clock.js';
import {
  isVpxExe,
  parseCimDate,
  parseCimProcesses,
  parsePlayArg,
  ProcessWatch,
  splitCommandLine,
  tableNameFromPath,
  type ProcessInfo,
  type VpxExit,
  type VpxLaunch,
} from './process-watch.js';

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r));
};

describe('command line parsing', () => {
  const exe = 'C:\\VPX\\VPinballX64.exe';

  it('splits quoted and unquoted arguments', () => {
    expect(splitCommandLine(`"${exe}" -Play "C:\\t\\a b.vpx" -Minimized`)).toEqual([exe, '-Play', 'C:\\t\\a b.vpx', '-Minimized']);
    expect(splitCommandLine(`${exe}  -play C:\\t\\a.vpx`)).toEqual([exe, '-play', 'C:\\t\\a.vpx']);
    expect(splitCommandLine('')).toEqual([]);
  });

  it('finds the table for -Play, /Play and -play, quoted or not, and ignores other switches', () => {
    expect(parsePlayArg(`"${exe}" -Play "C:\\Tables\\Medieval Madness (Williams 1997) VPW v1.0.1.vpx"`)).toBe(
      'C:\\Tables\\Medieval Madness (Williams 1997) VPW v1.0.1.vpx',
    );
    expect(parsePlayArg(`"${exe}" -Minimized /Play "C:\\t\\x.vpx" -ExtMinimized`)).toBe('C:\\t\\x.vpx');
    expect(parsePlayArg(`"${exe}" -play C:\\t\\x.vpx`)).toBe('C:\\t\\x.vpx');
    expect(parsePlayArg(`"${exe}" -PLAY C:\\t\\with space.vpx -Minimized`)).toBe('C:\\t\\with space.vpx');
    expect(parsePlayArg(`"${exe}" -Play C:\\t\\no-ext -Minimized`)).toBe('C:\\t\\no-ext');
  });

  it('returns null for the editor and for a -Play without a path', () => {
    expect(parsePlayArg(`"${exe}"`)).toBeNull();
    expect(parsePlayArg(`"${exe}" -Edit "C:\\t\\x.vpx"`)).toBeNull();
    expect(parsePlayArg(`"${exe}" -Play`)).toBeNull();
  });

  it('derives the table name and recognises VPX exes', () => {
    expect(tableNameFromPath('C:\\Tables\\Tales from the Crypt (Data East 1993) VPW v1.22.vpx')).toBe('Tales from the Crypt (Data East 1993) VPW v1.22');
    expect(tableNameFromPath('/tables/x.VPX')).toBe('x');
    expect(isVpxExe('C:\\VPX\\VPinballX64.exe')).toBe(true);
    expect(isVpxExe('D:\\x\\vpinballx_gl64.exe')).toBe(true);
    expect(isVpxExe('VPinballX_BGFX.exe')).toBe(true);
    expect(isVpxExe('C:\\VPX\\VPinMAME\\Setup64.exe')).toBe(false);
    expect(isVpxExe('C:\\x\\VPinballXLauncher.dll')).toBe(false);
  });
});

describe('CIM output parsing', () => {
  it('accepts one object, an array, or nothing, with the three date shapes', () => {
    expect(parseCimProcesses('')).toEqual([]);
    expect(parseCimProcesses('\r\n')).toEqual([]);
    const one = parseCimProcesses(
      JSON.stringify({ ProcessId: 4242, ExecutablePath: 'C:\\VPX\\VPinballX64.exe', CommandLine: '"C:\\VPX\\VPinballX64.exe" -Play "C:\\t\\x.vpx"', Name: 'VPinballX64.exe', CreationDate: '2026-10-17T18:08:42.123-05:00' }),
    );
    expect(one).toEqual([
      { pid: 4242, exe: 'C:\\VPX\\VPinballX64.exe', commandLine: '"C:\\VPX\\VPinballX64.exe" -Play "C:\\t\\x.vpx"', startedAt: Date.parse('2026-10-17T18:08:42.123-05:00') },
    ]);
    const many = parseCimProcesses(
      JSON.stringify([
        { ProcessId: 1, ExecutablePath: null, Name: 'VPinballX64.exe', CommandLine: null, CreationDate: '\\/Date(1697555555000)\\/' },
        { ProcessId: 'x' },
        { ProcessId: 2, ExecutablePath: 'C:\\a\\VPinballX_GL64.exe', CommandLine: '', CreationDate: '20261017180842.123456-300' },
      ]),
    );
    expect(many.map((p) => p.pid)).toEqual([1, 2]);
    expect(many[0]?.exe).toBe('VPinballX64.exe');
    expect(many[0]?.startedAt).toBe(1697555555000);
    expect(many[1]?.startedAt).toBe(Date.UTC(2026, 9, 17, 18, 8, 42, 123) + 300 * 60_000);
  });

  it('parseCimDate rejects junk', () => {
    expect(parseCimDate(null)).toBeNull();
    expect(parseCimDate('yesterday')).toBeNull();
    expect(parseCimDate(12)).toBe(12);
  });
});

describe('ProcessWatch', () => {
  const vpx = (pid: number, cmd: string, exe = 'C:\\VPX\\VPinballX64.exe'): ProcessInfo => ({ pid, exe, commandLine: cmd, startedAt: null });

  it('emits launch for a new pid and exit when it disappears, on the poll interval', async () => {
    const clock = new ManualClock();
    let procs: ProcessInfo[] = [];
    const watch = new ProcessWatch({ lister: { list: async () => procs }, clock, intervalMs: 2000 });
    const launches: VpxLaunch[] = [];
    const exits: VpxExit[] = [];
    watch.on('launch', (l) => launches.push(l));
    watch.on('exit', (e) => exits.push(e));

    watch.start();
    await flush();
    expect(launches).toHaveLength(0);

    procs = [vpx(10, '"C:\\VPX\\VPinballX64.exe" -Play "C:\\t\\Medieval Madness.vpx" -Minimized'), { pid: 11, exe: 'C:\\Windows\\explorer.exe', commandLine: '', startedAt: null }];
    clock.advance(1999);
    await flush();
    expect(launches).toHaveLength(0);
    clock.advance(1);
    await flush();
    expect(launches).toHaveLength(1);
    expect(launches[0]).toMatchObject({ pid: 10, table: 'Medieval Madness', tablePath: 'C:\\t\\Medieval Madness.vpx', seenAt: clock.now() });
    expect(watch.current()).toHaveLength(1);

    clock.advance(2000);
    await flush();
    expect(launches).toHaveLength(1); // same pid, no second launch

    procs = [];
    clock.advance(2000);
    await flush();
    expect(exits).toHaveLength(1);
    expect(exits[0]?.launch.pid).toBe(10);
    expect(exits[0]?.exitedAt).toBe(clock.now());
    expect(watch.current()).toHaveLength(0);

    watch.stop();
    procs = [vpx(12, '"C:\\VPX\\VPinballX64.exe"')];
    clock.advance(10_000);
    await flush();
    expect(launches).toHaveLength(1); // stopped: no more polls
    expect(clock.pending()).toBe(0);
  });

  it('reports the editor as a launch with a null table, and lister failures as errors', async () => {
    const clock = new ManualClock();
    let fail = false;
    const watch = new ProcessWatch({
      lister: {
        list: async () => {
          if (fail) throw new Error('powershell missing');
          return [vpx(5, '"C:\\VPX\\VPinballX64.exe"')];
        },
      },
      clock,
    });
    const launches: VpxLaunch[] = [];
    const errors: Error[] = [];
    watch.on('launch', (l) => launches.push(l));
    watch.on('error', (e) => errors.push(e));
    await watch.pollOnce();
    expect(launches).toEqual([{ pid: 5, exe: 'C:\\VPX\\VPinballX64.exe', tablePath: null, table: null, seenAt: clock.now(), startedAt: null }]);
    fail = true;
    await watch.pollOnce();
    expect(errors.map((e) => e.message)).toEqual(['powershell missing']);
    expect(watch.current()).toHaveLength(1); // a failed poll is not an exit
  });
});
