/**
 * I11.4.18: the one-shot window helper that hands the foreground from Castcade to VPX, with a faked process: what it
 * is started with, what each of its answers becomes, and that every way it can fail is a "could not" with a reason,
 * never a rejection. (The script itself needs a desktop with VPX on it; it was run once by hand for a process that
 * owns no window, which it answered with "another program is in front" in under half a second.)
 */
import { EventEmitter } from 'node:events';
import type { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { FOREGROUND_WHY, giveForegroundToVpx, parseForegroundLine } from './vpx-foreground.js';

type Spawn = typeof spawn;

/** A child process that says `stdout` and exits with `code` on the next turn (or never, when `code` is null). */
function fakeSpawn(stdout: string, code: number | null, stderr = '') {
  const calls: Array<{ command: string; args: readonly string[]; env: NodeJS.ProcessEnv | undefined; windowsHide: boolean | undefined }> = [];
  let killed = 0;
  const run = ((command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv; windowsHide?: boolean }) => {
    calls.push({ command, args, env: options.env, windowsHide: options.windowsHide });
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill(): void };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => void killed++;
    if (code !== null) {
      setImmediate(() => {
        if (stdout) child.stdout.emit('data', Buffer.from(stdout));
        if (stderr) child.stderr.emit('data', Buffer.from(stderr));
        child.emit('close', code);
      });
    }
    return child;
  }) as unknown as Spawn;
  return { run, calls, killed: () => killed };
}

describe('I11.4.18: handing the foreground to VPX', () => {
  it('reads the helper\'s one line: done, or why not, in plain words', () => {
    expect(parseForegroundLine('{"ok":true,"title":"Visual Pinball Player","why":""}')).toEqual({ ok: true, title: 'Visual Pinball Player', why: null });
    expect(parseForegroundLine('{"ok":false,"title":"","why":"not_ours"}')).toEqual({ ok: false, title: null, why: FOREGROUND_WHY.not_ours });
    expect(parseForegroundLine('{"ok":false,"title":"","why":"no_window"}')).toEqual({ ok: false, title: null, why: FOREGROUND_WHY.no_window });
    expect(parseForegroundLine('{"ok":false,"title":"Visual Pinball Player","why":"refused"}')).toEqual({ ok: false, title: 'Visual Pinball Player', why: FOREGROUND_WHY.refused });
    expect(parseForegroundLine('{"ok":false,"why":"something new"}')?.why).toBe('the window helper gave no reason');
    expect(parseForegroundLine('Add-Type : cannot compile')).toBeNull();
    expect(parseForegroundLine('{"title":"x"}')).toBeNull();
  });

  it('starts one hidden PowerShell with the pid of the process that owns Castcade\'s windows, and passes on what it says', async () => {
    const ps = fakeSpawn('{"ok":true,"title":"Visual Pinball Player","why":""}\r\n', 0);
    await expect(giveForegroundToVpx(4242, { spawn: ps.run })).resolves.toEqual({ ok: true, title: 'Visual Pinball Player', why: null });
    expect(ps.calls).toHaveLength(1);
    expect(ps.calls[0]?.command).toBe('powershell.exe');
    expect(ps.calls[0]?.args.slice(0, 5)).toEqual(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand']);
    expect(ps.calls[0]?.env?.CASTCADE_OWNER_PID).toBe('4242');
    expect(ps.calls[0]?.windowsHide).toBe(true);
    // The script: it looks at who owns the foreground before it touches anything, and only ever hands it to VPX's player window.
    const script = Buffer.from(String(ps.calls[0]?.args[5]), 'base64').toString('utf16le');
    expect(script.indexOf('if (fgPid != ownerPid) return')).toBeGreaterThan(-1);
    expect(script.indexOf('if (fgPid != ownerPid) return')).toBeLessThan(script.indexOf('SetForegroundWindow(found)'));
    expect(script).toContain('"Visual Pinball Player"');
    expect(script).toContain('StartsWith("VPinballX"');
  });

  it('another program in front, no VPX window, Windows saying no: each is a "could not" with its reason', async () => {
    for (const [word, why] of Object.entries(FOREGROUND_WHY)) {
      const ps = fakeSpawn(`{"ok":false,"title":"","why":"${word}"}\n`, 0);
      await expect(giveForegroundToVpx(1, { spawn: ps.run })).resolves.toMatchObject({ ok: false, why });
    }
  });

  it('a helper that says nothing, cannot start or never ends is a "could not" too: it never rejects', async () => {
    const silent = fakeSpawn('', 1, 'Add-Type : (0) : error CS1002\nmore');
    await expect(giveForegroundToVpx(1, { spawn: silent.run })).resolves.toEqual({ ok: false, title: null, why: 'the window helper ended without an answer (exit 1: Add-Type : (0) : error CS1002)' });
    const broken = (() => {
      throw new Error('spawn powershell.exe ENOENT');
    }) as unknown as Spawn;
    await expect(giveForegroundToVpx(1, { spawn: broken })).resolves.toEqual({ ok: false, title: null, why: 'the window helper did not start (spawn powershell.exe ENOENT)' });
    const stuck = fakeSpawn('', null);
    await expect(giveForegroundToVpx(1, { spawn: stuck.run, timeoutMs: 30 })).resolves.toEqual({ ok: false, title: null, why: 'the window helper did not answer in 30 ms' });
    expect(stuck.killed()).toBe(1);
  });
});
