/**
 * D1.9: which process owns the foreground window, reported on every change. Desktop Duplication films the monitor, so
 * the moment VPX is not in front the stream would show the desktop; the engine covers the capture on `false`.
 *
 * One long-lived PowerShell (Windows PowerShell 5.1 is always present) compiling a little C#: `GetForegroundWindow`
 * every 25 ms (one cheap call), and on a change the owning process's name as one JSON line. It reads its stdin and
 * exits when that closes, so it never outlives the companion.
 */
import { spawn } from 'node:child_process';

/** VPX's executables: VPinballX.exe, VPinballX64.exe, VPinballX_GL64.exe … (the window probe's rule). */
export function isVpxExe(name: string): boolean {
  return /^vpinballx/i.test(name);
}

export interface FocusChange {
  pid: number;
  /** Process name without `.exe`; empty when there is no foreground window (a lock screen, a UAC prompt). */
  exe: string;
}

/** One line of the watcher's output, or null for anything else. */
export function parseFocusLine(line: string): FocusChange | null {
  const t = line.trim();
  if (!t.startsWith('{')) return null;
  try {
    const v = JSON.parse(t) as Partial<FocusChange>;
    return typeof v.pid === 'number' && typeof v.exe === 'string' ? { pid: v.pid, exe: v.exe } : null;
  } catch {
    return null;
  }
}

const PS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

public static class CastcadeFocus {
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);

  static string J(string s) { return "\"" + (s ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"") + "\""; }

  public static void Run() {
    // The companion closes our stdin when it stops the watch or exits: leave then.
    var reader = new Thread(() => { try { while (Console.In.ReadLine() != null) { } } catch { } Environment.Exit(0); });
    reader.IsBackground = true;
    reader.Start();
    IntPtr last = new IntPtr(-1);
    while (true) {
      IntPtr h = GetForegroundWindow();
      if (h != last) {
        last = h;
        uint pid = 0;
        if (h != IntPtr.Zero) GetWindowThreadProcessId(h, out pid);
        string name = "";
        try { if (pid != 0) name = Process.GetProcessById((int)pid).ProcessName; } catch { }
        Console.Out.WriteLine("{\"pid\":" + pid + ",\"exe\":" + J(name) + "}");
        Console.Out.Flush();
      }
      Thread.Sleep(25);
    }
  }
}
'@
[CastcadeFocus]::Run()
`;

export interface FocusWatch {
  stop(): void;
}

/**
 * Start watching (Windows only). `onChange` gets every foreground change; `onEnd` fires if the watcher dies on its
 * own (the caller then treats focus as unknown).
 */
export function watchFocus(onChange: (c: FocusChange) => void, onEnd: (why: string) => void): FocusWatch {
  const encoded = Buffer.from(PS_SCRIPT, 'utf16le').toString('base64');
  const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stopped = false;
  let carry = '';
  let err = '';
  ps.stdout.on('data', (b: Buffer) => {
    const parts = (carry + b.toString('utf8')).split(/\r?\n/);
    carry = parts.pop() ?? '';
    for (const p of parts) {
      const c = parseFocusLine(p);
      if (c) onChange(c);
    }
  });
  ps.stderr.on('data', (b: Buffer) => (err = (err + b.toString('utf8')).slice(-500)));
  ps.stdin.on('error', () => {});
  ps.on('error', (e) => {
    if (!stopped) onEnd(e.message);
    stopped = true;
  });
  ps.on('close', (code) => {
    if (!stopped) onEnd(`exit ${code}${err.trim() ? `: ${err.trim()}` : ''}`);
    stopped = true;
  });
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      ps.stdin.end();
      setTimeout(() => {
        if (ps.exitCode === null) ps.kill();
      }, 2000).unref();
    },
  };
}
