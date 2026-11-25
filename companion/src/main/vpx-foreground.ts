/**
 * I11.4.18 (2026-11-24): VPX gets the foreground back from Castcade. VPX holds a table still while its player window
 * is not the active one, so after a click in the Castcade window (Start match, the invite, a setting) the player's
 * own ball does not move until they click in VPX. On 2026-11-23 the owner's first ball stood still for 39 s, and
 * about 70 s after `launch: the chat line is on the clipboard` and `match: Start match was pressed`.
 *
 * The match host (`match-host.ts`) asks for this at two moments: Start match pressed on the Match tab, and a grant
 * reaching this PC. Both only while a Castcade window is the active one, and never while the in-game menu is open.
 *
 * How: Windows lets the process that owns the foreground window hand the foreground on, and a process it started may
 * do it for it. So this is one short PowerShell run (Windows PowerShell 5.1 is always present; the same means as
 * `media/focus-watch.ts` and `media/window-geometry.ts`, no helper of our own), started by the Electron main process,
 * which owns Castcade's windows:
 *   1. the foreground window must belong to Castcade (`ownerPid`). If the player has switched to a third program
 *      since, nothing is touched: the foreground is theirs.
 *   2. VPX's player window is looked for: a visible top-level window of a `VPinballX*` process titled
 *      "Visual Pinball Player" (on a VR rig that is the preview window; it takes the keys there too).
 *   3. `SetForegroundWindow`, then a look at whether it took.
 * The answer is one JSON line. Nothing is typed, clicked or moved, and a minimized window is only brought back.
 */
import { spawn } from 'node:child_process';

export interface ForegroundResult {
  ok: boolean;
  /** The title of the window that got the foreground (or would have). */
  title: string | null;
  /** Why not, in plain words; null when it worked. */
  why: string | null;
}

/** What the match host needs (`MatchHostOptions.foreground`); the tests pass a fake. */
export interface VpxForeground {
  /** A window of this Castcade is the active one right now. */
  castcadeActive(): boolean;
  /** Hand the foreground from Castcade to VPX's player window. Never rejects. */
  give(): Promise<ForegroundResult>;
}

/** The script's words for each way it can end. */
export const FOREGROUND_WHY = {
  not_ours: 'another program is in front now, and its window was left alone',
  no_window: 'no "Visual Pinball Player" window was found',
  refused: 'Windows did not hand the foreground to VPX',
} as const;

/** One line of the script's output, or null for anything else. */
export function parseForegroundLine(line: string): ForegroundResult | null {
  const t = line.trim();
  if (!t.startsWith('{')) return null;
  try {
    const v = JSON.parse(t) as { ok?: unknown; title?: unknown; why?: unknown };
    if (typeof v.ok !== 'boolean') return null;
    const title = typeof v.title === 'string' && v.title ? v.title.slice(0, 120) : null;
    if (v.ok) return { ok: true, title, why: null };
    const key = typeof v.why === 'string' ? v.why : '';
    return { ok: false, title, why: (FOREGROUND_WHY as Record<string, string>)[key] ?? 'the window helper gave no reason' };
  } catch {
    return null;
  }
}

const PS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class CastcadeForeground {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);

  static string J(string s) { return "\"" + (s ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"") + "\""; }
  static string Out(bool ok, string title, string why) {
    return "{\"ok\":" + (ok ? "true" : "false") + ",\"title\":" + J(title) + ",\"why\":" + J(why) + "}";
  }

  public static string Run(uint ownerPid) {
    uint fgPid = 0;
    IntPtr fg = GetForegroundWindow();
    if (fg != IntPtr.Zero) GetWindowThreadProcessId(fg, out fgPid);
    if (fgPid != ownerPid) return Out(false, "", "not_ours");
    var pids = new HashSet<uint>();
    foreach (var p in Process.GetProcesses()) {
      if (p.ProcessName.StartsWith("VPinballX", StringComparison.OrdinalIgnoreCase)) pids.Add((uint)p.Id);
    }
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      if (!pids.Contains(pid) || !IsWindowVisible(h)) return true;
      var sb = new StringBuilder(256);
      GetWindowText(h, sb, sb.Capacity);
      if (sb.ToString() != "Visual Pinball Player") return true;
      found = h;
      return false;
    }, IntPtr.Zero);
    if (found == IntPtr.Zero) return Out(false, "", "no_window");
    if (IsIconic(found)) ShowWindow(found, 9);
    SetForegroundWindow(found);
    Thread.Sleep(60);
    return GetForegroundWindow() == found ? Out(true, "Visual Pinball Player", "") : Out(false, "Visual Pinball Player", "refused");
  }
}
'@
[Console]::Out.WriteLine([CastcadeForeground]::Run([uint32]$env:CASTCADE_OWNER_PID))
`;

type SpawnFn = typeof spawn;

/**
 * Run the script once for `ownerPid` (the process that owns Castcade's windows: the Electron main process). Resolves
 * with what it said; a script that does not start, says nothing or takes longer than `timeoutMs` is a "could not",
 * with the reason. Never rejects.
 */
export function giveForegroundToVpx(ownerPid: number, o: { spawn?: SpawnFn; timeoutMs?: number } = {}): Promise<ForegroundResult> {
  const run = o.spawn ?? spawn;
  const timeoutMs = o.timeoutMs ?? 6000;
  return new Promise<ForegroundResult>((resolve) => {
    let done = false;
    const finish = (r: ForegroundResult): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    const fail = (why: string): void => finish({ ok: false, title: null, why });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      fail(`the window helper did not answer in ${timeoutMs} ms`);
      try {
        ps.kill();
      } catch {
        /* gone already */
      }
    }, timeoutMs);
    const encoded = Buffer.from(PS_SCRIPT, 'utf16le').toString('base64');
    let ps: ReturnType<SpawnFn>;
    try {
      ps = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, CASTCADE_OWNER_PID: String(ownerPid) },
      });
    } catch (e) {
      fail(`the window helper did not start (${e instanceof Error ? e.message : String(e)})`);
      return;
    }
    ps.stdout?.on('data', (b: Buffer) => (out = (out + b.toString('utf8')).slice(-2000)));
    ps.stderr?.on('data', (b: Buffer) => (err = (err + b.toString('utf8')).slice(-300)));
    ps.on('error', (e) => fail(`the window helper did not start (${e.message})`));
    ps.on('close', (code) => {
      const said = out
        .split(/\r?\n/)
        .map(parseForegroundLine)
        .find((x): x is ForegroundResult => x !== null);
      if (said) finish(said);
      else fail(`the window helper ended without an answer (exit ${String(code)}${err.trim() ? `: ${err.trim().split(/\r?\n/)[0]?.slice(0, 120) ?? ''}` : ''})`);
    });
  });
}
