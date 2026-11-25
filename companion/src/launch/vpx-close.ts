/**
 * A17 step 3 (2026-11-25, docs/design/alpha-match.md section 11.5): closing the table that is open on this PC, so that
 * another one can be opened. Castcade has never closed VPX before, and it must be a clean exit: a ROM table writes its
 * NVRAM when the game stops, so a process that is ended by force can lose a high score. Three rungs, each a request:
 *
 * 1. **The Castcade VPX build**: the line `quit` on its control connection (docs/design/state-stream-in-match.md §3).
 *    The build closes its table and exits the way its held exit button does. A build from before the line ignores it
 *    (rule 13), stays open, and gets the next rung.
 * 2. **Any other VPX**: its window is asked to close (`WM_CLOSE`, which is what the window's own close button and
 *    Alt+F4 send). The message goes to VPX's main window when the process has one: read in the 10.8.0 source, that
 *    handler closes a running player first (the table's Exit event fires, VPinMAME stops) and then the program, whereas
 *    the player window by itself only goes back to the editor when VPX was started with `-Play` alone, which is how
 *    Castcade and most players start it, and the table would stay open there. A process with no main window gets the
 *    message on its player window.
 * 3. **The person**: when VPX is still open `CLOSE_WAIT_MS` after the first request, or nothing could be asked, the
 *    answer is `ask`: the caller says "Close the table on this PC" and waits for the witness to see the table go.
 *
 * **Never a forced end of the process**: nothing here ends, kills or signals a process. A VPX that shows a dialog
 * (a table with unsaved changes) simply stays open and the third rung says so.
 *
 * Everything that touches the outside is handed in (the control connection, the window messages, the witness's word
 * on whether the table is still open, the timers), so the tests close nothing. `askVpxWindowToClose` is the real
 * second rung: a short PowerShell script, the route `media/window-geometry.ts` already uses.
 */
import { spawn } from 'node:child_process';

/** How long the Castcade VPX build has to leave after `quit` before its window is asked as any VPX's is. */
export const FORK_QUIT_WAIT_MS = 6_000;
/** How long after the first request a VPX that is still open is the person's to close (the design's 15 s). */
export const CLOSE_WAIT_MS = 15_000;

/** A top-level window of the VPX process, as the script lists it. */
export interface VpxProcessWindow {
  /** The window handle, as a decimal string (a 64-bit number). */
  hwnd: string;
  className: string;
  title: string;
  visible: boolean;
}

/** VPX's main (editor) window: its window class is `VPinball` in every Windows build. */
const MAIN_CLASS = /^VPinball$/i;
/** The player window's title (10.7: "Visual Pinball Player", 10.8: the same, with the build behind it). */
const PLAYER_TITLE = /^Visual Pinball(?: X)? Player\b/i;

/**
 * Which window of the process is asked to close: the main window (it closes the player and then the program), else
 * the player window, else none. Never a dialog, a DMD or a backglass window.
 */
export function pickCloseTarget(windows: readonly VpxProcessWindow[]): { window: VpxProcessWindow; kind: 'main' | 'player' } | null {
  const main = windows.find((w) => MAIN_CLASS.test(w.className));
  if (main) return { window: main, kind: 'main' };
  const player = windows.find((w) => PLAYER_TITLE.test(w.title));
  return player ? { window: player, kind: 'player' } : null;
}

/** What the second rung did. */
export type WindowAsk =
  /** `WM_CLOSE` was posted to that window of the process. */
  | { asked: true; kind: 'main' | 'player' }
  /** Nothing was posted: the process is gone or is not VPX, it has no window to ask, or the script failed. */
  | { asked: false; reason: string };

const PS_HEAD = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public static class CastcadeClose {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", SetLastError = true)] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);

  static string J(string s) { return "\"" + (s ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"") + "\""; }

  // Only ever a process whose program is a VPinballX exe: a process id that Windows gave to another program meanwhile is left alone.
  static bool IsVpx(uint pid) {
    try { return Process.GetProcessById((int)pid).ProcessName.StartsWith("VPinballX", StringComparison.OrdinalIgnoreCase); }
    catch { return false; }
  }

  public static string List(uint pid) {
    if (!IsVpx(pid)) return "{\"vpx\":false,\"windows\":[]}";
    var wins = new List<string>();
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      uint owner;
      GetWindowThreadProcessId(h, out owner);
      if (owner != pid) return true;
      var title = new StringBuilder(256);
      GetWindowText(h, title, title.Capacity);
      var cls = new StringBuilder(256);
      GetClassName(h, cls, cls.Capacity);
      wins.Add(string.Format("{{\"hwnd\":\"{0}\",\"className\":{1},\"title\":{2},\"visible\":{3}}}", h.ToInt64(), J(cls.ToString()), J(title.ToString()), IsWindowVisible(h) ? "true" : "false"));
      return true;
    }, IntPtr.Zero);
    return "{\"vpx\":true,\"windows\":[" + string.Join(",", wins.ToArray()) + "]}";
  }

  // WM_CLOSE (0x0010), posted: the window's own close request, handled by VPX in its own time. Nothing is ended.
  public static string Close(uint pid, long hwnd) {
    var h = new IntPtr(hwnd);
    uint owner;
    if (!IsVpx(pid) || !IsWindow(h)) return "{\"posted\":false,\"why\":\"gone\"}";
    GetWindowThreadProcessId(h, out owner);
    if (owner != pid) return "{\"posted\":false,\"why\":\"not that process\"}";
    return PostMessage(h, 0x0010, IntPtr.Zero, IntPtr.Zero) ? "{\"posted\":true}" : "{\"posted\":false,\"why\":\"the message was not taken\"}";
  }
}
'@
`;

/** Runs one call of the script and answers its JSON line. The arguments are integers checked by the caller. */
function runScript(call: string, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    // -EncodedCommand (UTF-16LE base64): `-Command -` would run stdin line by line and break the here-string.
    const encoded = Buffer.from(`${PS_HEAD}\n${call}\n`, 'utf16le').toString('base64');
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      // The script, never VPX.
      ps.kill();
      reject(new Error('the window script timed out'));
    }, timeoutMs);
    ps.stdout.on('data', (b: Buffer) => (out += b.toString('utf8')));
    ps.stderr.on('data', (b: Buffer) => (err += b.toString('utf8')));
    ps.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    ps.on('close', (code) => {
      clearTimeout(timer);
      const line = out
        .trim()
        .split(/\r?\n/)
        .filter((l) => l.startsWith('{'))
        .pop();
      if (code !== 0 || !line) return reject(new Error(`the window script failed (exit ${code}): ${(err.trim() || out.trim()).slice(0, 300)}`));
      try {
        resolve(JSON.parse(line));
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
    ps.stdin.end();
  });
}

const isPid = (n: number): boolean => Number.isInteger(n) && n > 0 && n <= 0xffff_ffff;

/** The script's two calls; the tests hand in their own. */
export interface WindowScript {
  list(pid: number): Promise<{ vpx: boolean; windows: VpxProcessWindow[] }>;
  close(pid: number, hwnd: string): Promise<{ posted: boolean; why?: string }>;
}

export const powershellWindows: WindowScript = {
  async list(pid) {
    if (!isPid(pid)) throw new Error('not a process id');
    const r = (await runScript(`[CastcadeClose]::List(${pid})`, 20_000)) as { vpx?: unknown; windows?: unknown };
    const windows = Array.isArray(r.windows) ? (r.windows as VpxProcessWindow[]).filter((w) => typeof w?.hwnd === 'string' && /^-?\d{1,20}$/.test(w.hwnd)) : [];
    return { vpx: r.vpx === true, windows: windows.map((w) => ({ hwnd: w.hwnd, className: String(w.className ?? ''), title: String(w.title ?? ''), visible: w.visible === true })) };
  },
  async close(pid, hwnd) {
    if (!isPid(pid) || !/^-?\d{1,20}$/.test(hwnd)) throw new Error('not a window of a process');
    const r = (await runScript(`[CastcadeClose]::Close(${pid}, ${hwnd})`, 20_000)) as { posted?: unknown; why?: unknown };
    return r.posted === true ? { posted: true } : { posted: false, why: typeof r.why === 'string' ? r.why : 'unknown' };
  },
};

/**
 * The second rung: ask the window of the VPX process `pid` to close. Windows only; never throws (what went wrong is
 * the reason). The process is only ever asked, and only when it is a VPinballX program.
 */
export async function askVpxWindowToClose(pid: number, script: WindowScript = powershellWindows): Promise<WindowAsk> {
  try {
    const listed = await script.list(pid);
    if (!listed.vpx) return { asked: false, reason: 'that process is gone, or is not VPX' };
    const target = pickCloseTarget(listed.windows);
    if (!target) return { asked: false, reason: `VPX has no window to ask (${listed.windows.length} windows, none its main or player window)` };
    const r = await script.close(pid, target.window.hwnd);
    return r.posted ? { asked: true, kind: target.kind } : { asked: false, reason: r.why ?? 'unknown' };
  } catch (e) {
    return { asked: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

// ------------------------------------------------------------------------------------ the rungs --

export type CloseOutcome =
  /** The table is closed; `rung` is the request that was out when it went (1: `quit`, 2: the window). */
  | { state: 'closed'; rung: 1 | 2 }
  /** The third rung: the person closes it. `why` is for the log. */
  | { state: 'ask'; why: string }
  /** Nothing more was asked because the caller said the table may not be closed any more (a game started); `asked`: a request is already out. */
  | { state: 'held'; asked: boolean };

export interface VpxCloserOptions {
  /**
   * Rung 1: say `quit` to the Castcade VPX build that runs this table; false when the open table's VPX is not that
   * build, or none is on the control connection.
   */
  quitFork(): boolean;
  /** Rung 2: ask the window of that process to close (`askVpxWindowToClose`). */
  askWindow(pid: number): Promise<WindowAsk>;
  /** The pid of the VPX whose table is open, as the witness knows it; null: not known. */
  pid(): number | null;
  /** Whether the table is still open (the witness's word). */
  open(): boolean;
  /** Called when the witness says something new, so `open()` is asked again. */
  onChange(cb: () => void): () => void;
  log: { info(line: string): void; warn(line: string): void };
  forkQuitWaitMs?: number;
  closeWaitMs?: number;
  setTimeout?(fn: () => void, ms: number): unknown;
  clearTimeout?(handle: unknown): void;
}

export interface VpxCloser {
  /**
   * Ask the open table's VPX to close, rung by rung, and say how it ended. `mayClose` is asked before every request:
   * false (a game started meanwhile) and nothing more is asked. One close at a time: a second call while one runs
   * gets the same answer. Never throws.
   */
  close(table: string, mayClose?: () => boolean): Promise<CloseOutcome>;
}

export function createVpxCloser(o: VpxCloserOptions): VpxCloser {
  const later = o.setTimeout ?? ((fn: () => void, ms: number): unknown => setTimeout(fn, ms));
  const cancel = o.clearTimeout ?? ((h: unknown): void => clearTimeout(h as ReturnType<typeof setTimeout>));
  const quitWait = o.forkQuitWaitMs ?? FORK_QUIT_WAIT_MS;
  const closeWait = o.closeWaitMs ?? CLOSE_WAIT_MS;
  let running: Promise<CloseOutcome> | null = null;

  const run = (table: string, mayClose: () => boolean): Promise<CloseOutcome> =>
    new Promise<CloseOutcome>((resolve) => {
      let done = false;
      let rung: 1 | 2 = 1;
      let asked = false;
      const timers: unknown[] = [];
      const finish = (r: CloseOutcome): void => {
        if (done) return;
        done = true;
        off();
        for (const t of timers) cancel(t);
        resolve(r);
      };
      const check = (): void => {
        if (done || o.open()) return;
        o.log.info(`close: ${table} is closed (${rung === 1 ? 'the Castcade VPX build left on quit' : 'VPX closed when its window was asked'})`);
        finish({ state: 'closed', rung });
      };
      const off = o.onChange(check);
      if (!o.open()) return finish({ state: 'closed', rung: 1 });

      /** Rung 3: from here it is the person's. */
      const ask = (why: string): void => {
        if (done) return;
        o.log.warn(`close: ${table} is still open (${why}): the person is asked to close it; nothing is ended by force`);
        finish({ state: 'ask', why });
      };
      const window = async (): Promise<void> => {
        if (done) return;
        if (!o.open()) return check();
        if (!mayClose()) return finish({ state: 'held', asked });
        const pid = o.pid();
        if (pid === null) return ask('Castcade does not know which VPX process it is');
        rung = 2;
        const r = await o.askWindow(pid);
        if (done) return;
        if (!r.asked) return ask(`its window could not be asked: ${r.reason}`);
        asked = true;
        o.log.info(`close: asked the ${r.kind === 'main' ? 'VPX window' : 'player window'} of ${table} to close (WM_CLOSE, pid ${pid})`);
        check();
      };

      if (!mayClose()) return finish({ state: 'held', asked: false });
      // The whole wait counts from the first request, whichever it is.
      timers.push(later(() => ask(`${Math.round(closeWait / 1000)} s after it was asked to close`), closeWait));
      if (o.quitFork()) {
        asked = true;
        o.log.info(`close: quit sent to the Castcade VPX build that runs ${table}`);
        timers.push(
          later(() => {
            if (done) return;
            o.log.info(`close: the Castcade VPX build is still open ${Math.round(quitWait / 1000)} s after quit (a build from before the line ignores it): its window is asked`);
            void window();
          }, quitWait),
        );
      } else void window();
    });

  return {
    close(table, mayClose = () => true) {
      if (running) return running;
      const mine = run(table, mayClose).finally(() => {
        if (running === mine) running = null;
      });
      running = mine;
      return mine;
    },
  };
}
