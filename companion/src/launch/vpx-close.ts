/**
 * A17 step 3 (2026-11-25, docs/design/alpha-match.md section 11.5): closing the table that is open on this PC, so that
 * another one can be opened. Castcade has never closed VPX before, and it must be a clean exit: a ROM table writes its
 * NVRAM when the game stops, so a process that is ended by force can lose a high score. Three rungs, each a request:
 *
 * 1. **The Castcade VPX build**: the line `quit` on its control connection (docs/design/state-stream-in-match.md §3).
 *    The build closes its table and exits the way its held exit button does. A build from before the line ignores it
 *    (rule 13), stays open, and gets the next rung. The line only goes to a build that is proven to be the process
 *    asked about (`quitFork(pid)`).
 * 2. **Any other VPX**: its window is asked to close (`WM_CLOSE`, which is what the window's own close button and
 *    Alt+F4 send). The message goes to VPX's main window when the process has one: read in the 10.8.0 source, that
 *    handler closes a running player first (the table's Exit event fires, VPinMAME stops) and then the program, whereas
 *    the player window by itself only goes back to the editor when VPX was started with `-Play` alone, which is how
 *    Castcade and most players start it, and the table would stay open there. A process with no main window gets the
 *    message on its player window.
 * 3. **The person**: when VPX is still running `CLOSE_WAIT_MS` after the first request, or nothing could be asked, the
 *    answer is `ask`: the caller says "Close the table on this PC" and waits for the witness to see the table go.
 *
 * **Never a forced end of the process**: nothing here ends, kills or signals a process. A VPX that shows a dialog
 * (a table with unsaved changes) simply stays open and the third rung says so.
 *
 * Review of PR 137:
 * - the process is named by the caller for the whole request (`close(table, pid, …)`): the VPX that holds the table,
 *   as the witness has it, never "the VPX launched last";
 * - **closed means the process has ended** (`alive(pid)` false), not that the witness has let go of the table: the
 *   witness's status follows seconds later, after its close-time capture;
 * - `mayClose` (no game began, the setting still allows it) is asked before every request, before the window script
 *   starts, and again at the moment the message is posted: the script is one run that compiles and lists first (the
 *   slow part, a second or more) and then waits for a line on its input; the message follows that line by milliseconds.
 *
 * Everything that touches the outside is handed in (the control connection, the window script, the witness's word on
 * the process, the timers), so the tests close nothing. `powershellWindows` is the real second rung: a short
 * PowerShell script, the route `media/window-geometry.ts` already uses.
 */
import { spawn } from 'node:child_process';

/** How long the Castcade VPX build has to leave after `quit` before its window is asked as any VPX's is. */
export const FORK_QUIT_WAIT_MS = 6_000;
/** How long after the first request a VPX that is still running is the person's to close (the design's 15 s). */
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
  /** Nothing was posted because the caller said no at the last moment (a game began, the setting was switched off). */
  | { asked: false; held: true }
  /** Nothing was posted: the process is gone or is not VPX, it has no window to ask, or the script failed. */
  | { asked: false; held?: false; reason: string };

const isPid = (n: number): boolean => Number.isInteger(n) && n > 0 && n <= 0xffff_ffff;

/**
 * One run of the window script for one process: it has compiled and listed (`vpx`, `windows`) and now waits. `post`
 * sends `WM_CLOSE` to one of the listed windows and ends the run; `cancel` ends it with nothing posted.
 */
export interface WindowRun {
  vpx: boolean;
  windows: VpxProcessWindow[];
  post(hwnd: string): Promise<{ posted: boolean; why?: string }>;
  cancel(): void;
}

/** The window script; the tests hand in their own. */
export interface WindowScript {
  open(pid: number): Promise<WindowRun>;
}

/**
 * The script. Its output is ASCII only (every other character of a window title or class is written as \uXXXX, and
 * the console's output encoding is set to UTF-8 without a mark first), so neither a control character in a title nor
 * the PC's OEM code page can break the line. It lists, waits for one line on its input, and posts only on
 * `close <hwnd>`; any other line, or the end of the input, posts nothing. The process id is the one thing put into the
 * text, and it must be one.
 */
export function windowScript(pid: number): string {
  if (!isPid(pid)) throw new Error('not a process id');
  return windowScriptText(pid);
}

const windowScriptText = (pid: number): string => String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
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

  // A JSON string in ASCII: a quote, a backslash, a control character and anything above 0x7e go out as \uXXXX.
  static string J(string s) {
    var b = new StringBuilder("\"");
    foreach (char c in (s ?? "")) {
      if (c < 0x20 || c > 0x7e || c == '"' || c == '\\') b.Append("\\u").Append(((int)c).ToString("x4"));
      else b.Append(c);
    }
    return b.Append("\"").ToString();
  }

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
[Console]::Out.WriteLine([CastcadeClose]::List(${pid}))
[Console]::Out.Flush()
$word = [Console]::In.ReadLine()
if ($word -match '^close (-?[0-9]{1,20})$') {
  [Console]::Out.WriteLine([CastcadeClose]::Close(${pid}, [long]$Matches[1]))
  [Console]::Out.Flush()
}
`;

const isHwnd = (s: unknown): s is string => typeof s === 'string' && /^-?\d{1,20}$/.test(s);
/** How long the script may take to compile and list, and then to answer the word it was given. */
const LIST_TIMEOUT_MS = 20_000;
const POST_TIMEOUT_MS = 5_000;

/** One line of the script's output as JSON; the mark some consoles put first is let go. */
function parseLine(line: string): unknown {
  const at = line.indexOf('{');
  return JSON.parse(at > 0 ? line.slice(at) : line);
}

/** The real window script: one `powershell.exe` per request. The pid and the window handle are integers, checked here. */
export const powershellWindows: WindowScript = {
  open(pid) {
    return new Promise<WindowRun>((resolve, reject) => {
      if (!isPid(pid)) return reject(new Error('not a process id'));
      // -EncodedCommand (UTF-16LE base64): `-Command -` would run stdin line by line, and stdin is the script's own here.
      const encoded = Buffer.from(windowScript(pid), 'utf16le').toString('base64');
      const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true });
      let out = '';
      let err = '';
      let listed = false;
      let ended = false;
      let onLine: ((line: string | null) => void) | null = null;
      const end = (): void => {
        if (ended) return;
        ended = true;
        ps.stdin.end();
      };
      // The script, never VPX.
      let timer = setTimeout(() => {
        ps.kill();
        reject(new Error('the window script timed out'));
      }, LIST_TIMEOUT_MS);
      const take = (): void => {
        for (let nl = out.indexOf('\n'); nl >= 0; nl = out.indexOf('\n')) {
          const line = out.slice(0, nl).trim();
          out = out.slice(nl + 1);
          if (!line.includes('{')) continue;
          if (!listed) {
            listed = true;
            clearTimeout(timer);
            let r: { vpx?: unknown; windows?: unknown };
            try {
              r = parseLine(line) as { vpx?: unknown; windows?: unknown };
            } catch (e) {
              end();
              reject(e instanceof Error ? e : new Error(String(e)));
              return;
            }
            const windows = (Array.isArray(r.windows) ? (r.windows as Array<Partial<VpxProcessWindow>>) : []).filter((w) => isHwnd(w?.hwnd));
            resolve({
              vpx: r.vpx === true,
              windows: windows.map((w) => ({ hwnd: w.hwnd as string, className: String(w.className ?? ''), title: String(w.title ?? ''), visible: w.visible === true })),
              post: (hwnd) =>
                new Promise((done) => {
                  if (ended || !isHwnd(hwnd)) return done({ posted: false, why: 'the window script had ended' });
                  timer = setTimeout(() => {
                    onLine = null;
                    ps.kill();
                    done({ posted: false, why: 'the window script did not answer' });
                  }, POST_TIMEOUT_MS);
                  onLine = (answer) => {
                    clearTimeout(timer);
                    onLine = null;
                    if (answer === null) return done({ posted: false, why: 'the window script ended without an answer' });
                    try {
                      const a = parseLine(answer) as { posted?: unknown; why?: unknown };
                      done(a.posted === true ? { posted: true } : { posted: false, why: typeof a.why === 'string' ? a.why : 'unknown' });
                    } catch {
                      done({ posted: false, why: 'the window script answered something else' });
                    }
                  };
                  ended = true;
                  ps.stdin.end(`close ${hwnd}\n`);
                }),
              cancel: end,
            });
          } else if (onLine) onLine(line);
        }
      };
      ps.stdout.on('data', (b: Buffer) => {
        out += b.toString('utf8');
        take();
      });
      ps.stderr.on('data', (b: Buffer) => (err += b.toString('utf8')));
      ps.stdin.on('error', () => undefined);
      ps.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      ps.on('close', (code) => {
        clearTimeout(timer);
        if (!listed) reject(new Error(`the window script failed (exit ${code}): ${err.trim().slice(0, 300)}`));
        else if (onLine) onLine(null);
      });
    });
  },
};

/**
 * The second rung: ask the window of the VPX process `pid` to close. `mayClose` is asked before the script starts and
 * again when it has listed and waits: the message follows that second answer at once. Windows only; never throws
 * (what went wrong is the reason). The process is only ever asked, and only when it is a VPinballX program.
 */
export async function askVpxWindowToClose(pid: number, mayClose: () => boolean = () => true, windows: WindowScript = powershellWindows): Promise<WindowAsk> {
  if (!mayClose()) return { asked: false, held: true };
  let run: WindowRun | null = null;
  try {
    run = await windows.open(pid);
    if (!run.vpx) return { asked: false, reason: 'that process is gone, or is not VPX' };
    const target = pickCloseTarget(run.windows);
    if (!target) return { asked: false, reason: `VPX has no window to ask (${run.windows.length} windows, none its main or player window)` };
    // The script took its time to start; the answer that counts is the one of this moment.
    if (!mayClose()) return { asked: false, held: true };
    const posting = run.post(target.window.hwnd);
    run = null;
    const r = await posting;
    return r.posted ? { asked: true, kind: target.kind } : { asked: false, reason: r.why ?? 'unknown' };
  } catch (e) {
    return { asked: false, reason: e instanceof Error ? e.message : String(e) };
  } finally {
    run?.cancel();
  }
}

// ------------------------------------------------------------------------------------ the rungs --

export type CloseOutcome =
  /** The process has ended; `rung` is the request that was out when it went (1: `quit`, 2: the window). */
  | { state: 'closed'; rung: 1 | 2 }
  /** The third rung: the person closes it. `asked`: a request is out all the same (it may still be obeyed). `why` is for the log. */
  | { state: 'ask'; why: string; asked: boolean }
  /** Nothing more was asked because the caller said the table may not be closed any more (a game started); `asked`: a request is already out. */
  | { state: 'held'; asked: boolean };

export interface VpxCloserOptions {
  /**
   * Rung 1: say `quit` to the Castcade VPX build that is the process `pid`; false when that process is not proven to
   * be the build on the control connection (then nothing was sent).
   */
  quitFork(pid: number): boolean;
  /** Rung 2: ask the window of that process to close (`askVpxWindowToClose`); `mayClose` is asked again just before the message. */
  askWindow(pid: number, mayClose: () => boolean): Promise<WindowAsk>;
  /** Whether the process is still running, as the witness's process watch has it. */
  alive(pid: number): boolean;
  /** Called when the witness says something new (a process ended), so `alive` is asked again. */
  onChange(cb: () => void): () => void;
  log: { info(line: string): void; warn(line: string): void };
  forkQuitWaitMs?: number;
  closeWaitMs?: number;
  setTimeout?(fn: () => void, ms: number): unknown;
  clearTimeout?(handle: unknown): void;
}

export interface VpxCloser {
  /**
   * Ask the VPX process `pid`, which holds `table`, to close, rung by rung, and say how it ended. `mayClose` is asked
   * before every request: false (a game started meanwhile, the setting was switched off) and nothing more is asked.
   * One close per process at a time: a second call while one runs gets the same answer, and from then on it is the
   * second caller's `mayClose` that is asked (the first caller's reason to close may be gone, the second's stands).
   * Never throws.
   */
  close(table: string, pid: number, mayClose?: () => boolean): Promise<CloseOutcome>;
}

export function createVpxCloser(o: VpxCloserOptions): VpxCloser {
  const later = o.setTimeout ?? ((fn: () => void, ms: number): unknown => setTimeout(fn, ms));
  const cancel = o.clearTimeout ?? ((h: unknown): void => clearTimeout(h as ReturnType<typeof setTimeout>));
  const quitWait = o.forkQuitWaitMs ?? FORK_QUIT_WAIT_MS;
  const closeWait = o.closeWaitMs ?? CLOSE_WAIT_MS;
  const running = new Map<number, { answer: Promise<CloseOutcome>; mayClose: () => boolean }>();

  const run = (table: string, pid: number, mayClose: () => boolean): Promise<CloseOutcome> =>
    new Promise<CloseOutcome>((resolve) => {
      let done = false;
      let rung: 1 | 2 = 1;
      let asked = false;
      const timers: unknown[] = [];
      let off: () => void = () => undefined;
      const finish = (r: CloseOutcome): void => {
        if (done) return;
        done = true;
        off();
        for (const t of timers) cancel(t);
        resolve(r);
      };
      /** The process is gone: closed, whatever the witness still says of its table. */
      const check = (): boolean => {
        if (done) return true;
        if (o.alive(pid)) return false;
        o.log.info(asked ? `close: ${table} is closed: its VPX (pid ${pid}) has ended (${rung === 1 ? 'the Castcade VPX build left on quit' : 'it closed when its window was asked'})` : `close: the VPX that held ${table} (pid ${pid}) has ended by itself`);
        finish({ state: 'closed', rung });
        return true;
      };
      off = o.onChange(() => void check());
      if (check()) return;

      /** Rung 3: from here it is the person's. */
      const ask = (why: string): void => {
        if (done || check()) return;
        o.log.warn(`close: ${table} is still open (${why}): the person is asked to close it; nothing is ended by force`);
        finish({ state: 'ask', why, asked });
      };
      const window = async (): Promise<void> => {
        if (done || check()) return;
        if (!mayClose()) return finish({ state: 'held', asked });
        rung = 2;
        const r = await o.askWindow(pid, mayClose);
        if (done || check()) return;
        if (!r.asked && r.held) return finish({ state: 'held', asked });
        if (!r.asked) return ask(`its window could not be asked: ${r.reason}`);
        asked = true;
        o.log.info(`close: asked the ${r.kind === 'main' ? 'VPX window' : 'player window'} of ${table} to close (WM_CLOSE, pid ${pid})`);
      };

      if (!mayClose()) return finish({ state: 'held', asked: false });
      // The whole wait counts from the first request, whichever it is.
      timers.push(later(() => ask(`${Math.round(closeWait / 1000)} s after it was asked to close`), closeWait));
      if (o.quitFork(pid)) {
        asked = true;
        o.log.info(`close: quit sent to the Castcade VPX build that runs ${table} (pid ${pid})`);
        timers.push(
          later(() => {
            if (done || check()) return;
            o.log.info(`close: the Castcade VPX build is still running ${Math.round(quitWait / 1000)} s after quit (a build from before the line ignores it): its window is asked`);
            void window();
          }, quitWait),
        );
      } else void window();
    });

  return {
    close(table, pid, mayClose = () => true) {
      const now = running.get(pid);
      if (now) {
        now.mayClose = mayClose;
        return now.answer;
      }
      const mine: { answer: Promise<CloseOutcome>; mayClose: () => boolean } = { answer: Promise.resolve<CloseOutcome>({ state: 'held', asked: false }), mayClose };
      running.set(pid, mine);
      mine.answer = run(table, pid, () => mine.mayClose()).finally(() => {
        if (running.get(pid) === mine) running.delete(pid);
      });
      return mine.answer;
    },
  };
}
