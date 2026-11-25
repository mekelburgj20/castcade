/**
 * I11.4.18: the one-shot window helper that hands the foreground from Castcade to VPX, with a faked process: what it
 * is started with, what each of its answers becomes, and that every way it can fail is a "could not" with a reason,
 * never a rejection. (The script itself needs a desktop with VPX on it; it was run once by hand for a process that
 * owns no window, which it answered with "another program is in front" in under half a second.)
 */
import { EventEmitter } from 'node:events';
import type { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { createVpxForeground, FOCUS_IN_FIELD_JS, FOREGROUND_WHY, giveForegroundToVpx, parseForegroundLine, TYPING_QUIET_MS, typingReason } from './vpx-foreground.js';

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
    expect(ps.calls[0]?.env?.CASTCADE_VPX_PID).toBe('0'); // no VPX named: any player window
    expect(ps.calls[0]?.windowsHide).toBe(true);
    // The script: it looks at who owns the foreground before it touches anything, and only ever hands it to VPX's player window.
    const script = Buffer.from(String(ps.calls[0]?.args[5]), 'base64').toString('utf16le');
    expect(script.indexOf('if (fgPid != ownerPid) return')).toBeGreaterThan(-1);
    expect(script.indexOf('if (fgPid != ownerPid) return')).toBeLessThan(script.indexOf('SetForegroundWindow(found)'));
    expect(script).toContain('"Visual Pinball Player"');
    expect(script).toContain('StartsWith("VPinballX"');
  });

  it("with the match's own VPX named, its window is preferred: another VPX's player window is taken only when that one has none", async () => {
    const ps = fakeSpawn('{"ok":true,"title":"Visual Pinball Player","why":""}\n', 0);
    await giveForegroundToVpx(4242, { spawn: ps.run, vpxPid: 61584 });
    expect(ps.calls[0]?.env?.CASTCADE_VPX_PID).toBe('61584');
    const script = Buffer.from(String(ps.calls[0]?.args[5]), 'base64').toString('utf16le');
    expect(script).toContain('if (preferPid == 0 || pid == preferPid) { found = h; return false; }');
    expect(script).toContain('if (found == IntPtr.Zero) found = other;');
    expect(script).toContain('[uint32]$env:CASTCADE_VPX_PID');
    // Anything that is not a pid names no VPX.
    for (const bad of [null, -3, 1.5, Number.NaN]) {
      const again = fakeSpawn('{"ok":false,"title":"","why":"no_window"}\n', 0);
      await giveForegroundToVpx(1, { spawn: again.run, vpxPid: bad });
      expect(again.calls[0]?.env?.CASTCADE_VPX_PID).toBe('0');
    }
  });

  it('a grant does not take the keyboard from a player who is typing in Castcade: a field has it, or a key went down in the last 3 s', () => {
    expect(TYPING_QUIET_MS).toBe(3000);
    expect(typingReason({ inField: false, lastKeyAgoMs: null })).toBeNull();
    expect(typingReason({ inField: false, lastKeyAgoMs: 3000 })).toBeNull();
    expect(typingReason({ inField: false, lastKeyAgoMs: 2999 })).toBe('a key was pressed in the Castcade window 3 s ago');
    expect(typingReason({ inField: false, lastKeyAgoMs: 400 })).toBe('a key was pressed in the Castcade window 0.4 s ago');
    expect(typingReason({ inField: true, lastKeyAgoMs: null })).toBe('a field in the Castcade window has the keyboard');
    // Not known is not "free": nothing is handed on.
    expect(typingReason({ inField: null, lastKeyAgoMs: null })).toBe('what has the keyboard in the Castcade window could not be read');
    expect(typingReason(null)).toBe('what has the keyboard in the Castcade window could not be read');
    // What counts as a field: what would take the keys typed next. A button does not (the click that left it focused is over).
    const at = (el: Record<string, unknown> | null): unknown => new Function('document', `return ${FOCUS_IN_FIELD_JS};`)({ activeElement: el });
    expect(at(null)).toBe(false);
    expect(at({ tagName: 'BODY' })).toBe(false);
    expect(at({ tagName: 'BUTTON' })).toBe(false);
    expect(at({ tagName: 'INPUT', type: 'text' })).toBe(true);
    expect(at({ tagName: 'INPUT', type: 'password' })).toBe(true);
    expect(at({ tagName: 'INPUT', type: 'number' })).toBe(true);
    expect(at({ tagName: 'INPUT', type: 'range' })).toBe(true);
    expect(at({ tagName: 'INPUT' })).toBe(true);
    expect(at({ tagName: 'INPUT', type: 'checkbox' })).toBe(false);
    expect(at({ tagName: 'INPUT', type: 'button' })).toBe(false);
    expect(at({ tagName: 'SELECT' })).toBe(true);
    expect(at({ tagName: 'TEXTAREA' })).toBe(true);
    expect(at({ tagName: 'DIV', isContentEditable: true })).toBe(true);
  });

  it('the window interface of the app: active while one of its pages has the focus; keys are timed, the focused page is asked, and a page that cannot say reads as not known', async () => {
    let t = 100_000;
    let page: { executeJavaScript(code: string): Promise<unknown> } | null = null;
    const asked: string[] = [];
    const given: Array<{ owner: number; vpxPid: number | null | undefined }> = [];
    const fg = createVpxForeground({
      focusedPage: () => page,
      ownerPid: 99,
      now: () => t,
      askMs: 40,
      give: async (owner, o) => {
        given.push({ owner, vpxPid: o.vpxPid });
        return { ok: true, title: 'Visual Pinball Player', why: null };
      },
    });
    // No Castcade window in front.
    expect(fg.castcadeActive()).toBe(false);
    await expect(fg.typing!()).resolves.toEqual({ inField: null, lastKeyAgoMs: null });
    // In front, nothing typed yet, the focus on a button.
    page = { executeJavaScript: async (code) => (asked.push(code), false) };
    expect(fg.castcadeActive()).toBe(true);
    await expect(fg.typing!()).resolves.toEqual({ inField: false, lastKeyAgoMs: null });
    expect(asked).toEqual([FOCUS_IN_FIELD_JS]);
    // A key goes down; 1.5 s later the focus is in a field.
    fg.keyPressed();
    t += 1500;
    page = { executeJavaScript: async () => true };
    await expect(fg.typing!()).resolves.toEqual({ inField: true, lastKeyAgoMs: 1500 });
    // A page that throws, answers something else, or never answers: not known.
    page = { executeJavaScript: () => Promise.reject(new Error('the page is gone')) };
    await expect(fg.typing!()).resolves.toEqual({ inField: null, lastKeyAgoMs: 1500 });
    page = { executeJavaScript: async () => 'yes' };
    await expect(fg.typing!()).resolves.toMatchObject({ inField: null });
    page = { executeJavaScript: () => new Promise(() => undefined) };
    await expect(fg.typing!()).resolves.toMatchObject({ inField: null });
    // The handover is asked for this process's windows and the VPX it is told.
    await fg.give(61584);
    await fg.give();
    expect(given).toEqual([{ owner: 99, vpxPid: 61584 }, { owner: 99, vpxPid: null }]);
  });

  it('another program in front, no VPX window, Windows saying no: each is a "could not" with its reason', async () => {
    for (const [word, why] of Object.entries(FOREGROUND_WHY)) {
      const ps = fakeSpawn(`{"ok":false,"title":"","why":"${word}"}\n`, 0);
      await expect(giveForegroundToVpx(1, { spawn: ps.run })).resolves.toMatchObject({ ok: false, why });
    }
  });

  it('a helper that says nothing, cannot start or never ends is a "could not" too: it never rejects', async () => {
    const silent = fakeSpawn('', 1, 'Add-Type : (0) : error CS1002\nmore');
    // The exit code and our own words only: what PowerShell writes to its error stream (a serialized error, which can
    // hold a path under the user's profile) never reaches the log (review 2 of PR 126, G).
    await expect(giveForegroundToVpx(1, { spawn: silent.run })).resolves.toEqual({ ok: false, title: null, why: 'the window helper ended without an answer (exit 1)' });
    const broken = (() => {
      throw new Error('spawn powershell.exe ENOENT');
    }) as unknown as Spawn;
    await expect(giveForegroundToVpx(1, { spawn: broken })).resolves.toEqual({ ok: false, title: null, why: 'the window helper did not start (spawn powershell.exe ENOENT)' });
    const stuck = fakeSpawn('', null);
    await expect(giveForegroundToVpx(1, { spawn: stuck.run, timeoutMs: 30 })).resolves.toEqual({ ok: false, title: null, why: 'the window helper did not answer in 30 ms' });
    expect(stuck.killed()).toBe(1);
  });
});
