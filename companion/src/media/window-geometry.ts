/**
 * Where the VPX player window is, in the terms ffmpeg's `ddagrab` needs (D1, `docs/design/solo-streaming-and-recording.md`
 * §3): the DXGI output index on the default adapter, and the window's client area relative to that output, in physical
 * pixels. Two monitors of the same size (the owner's rig: two 2560x1440) cannot be told apart by size, so the outputs
 * come from DXGI itself with their desktop coordinates and HMONITOR, and the window's monitor is matched by handle.
 *
 * The probe is a short PowerShell script (Windows PowerShell 5.1 is always present) compiling a little C#: user32 for the
 * window, `CreateDXGIFactory1` → adapter 0 → `EnumOutputs` for the outputs, which is the list `ddagrab`'s `output_idx`
 * indexes (it opens the default D3D11 device and enumerates that adapter's outputs). The thread is made per-monitor DPI
 * aware first, so a 125 % display gives physical coordinates, not scaled ones.
 */
import { spawn } from 'node:child_process';

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface DxgiOutput {
  index: number;
  device: string;
  desktop: Rect;
  monitor: string;
}

export interface VpxWindow {
  pid: number;
  title: string;
  /** Client area in virtual-desktop physical pixels. */
  client: Rect;
  monitor: string;
}

export interface WindowProbe {
  outputs: DxgiOutput[];
  windows: VpxWindow[];
}

export interface DdagrabCrop {
  outputIdx: number;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
}

const PS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public static class CastcadeProbe {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct DXGI_OUTPUT_DESC {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName;
    public RECT DesktopCoordinates;
    public int AttachedToDesktop;
    public int Rotation;
    public IntPtr Monitor;
  }

  [ComImport, Guid("7b7166ec-21c7-44ae-b21a-c9ae321ae369"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IDXGIFactory {
    void SetPrivateData(); void SetPrivateDataInterface(); void GetPrivateData(); void GetParent();
    [PreserveSig] int EnumAdapters(uint index, out IntPtr adapter);
  }
  [ComImport, Guid("2411e7e1-12ac-4ccf-bd14-9798e8534dc0"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IDXGIAdapter {
    void SetPrivateData(); void SetPrivateDataInterface(); void GetPrivateData(); void GetParent();
    [PreserveSig] int EnumOutputs(uint index, out IntPtr output);
  }
  [ComImport, Guid("ae02eedb-c735-4690-8d52-5a8dc20213aa"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IDXGIOutput {
    void SetPrivateData(); void SetPrivateDataInterface(); void GetPrivateData(); void GetParent();
    [PreserveSig] int GetDesc(out DXGI_OUTPUT_DESC desc);
  }

  [DllImport("dxgi.dll")] static extern int CreateDXGIFactory1(ref Guid riid, out IntPtr factory);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr ctx);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);

  static string J(string s) { return "\"" + (s ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"") + "\""; }
  static string R(int l, int t, int w, int h) { return string.Format("{{\"left\":{0},\"top\":{1},\"width\":{2},\"height\":{3}}}", l, t, w, h); }

  public static string Run() {
    SetThreadDpiAwarenessContext(new IntPtr(-4)); // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
    var outs = new List<string>();
    Guid iid = new Guid("770aae78-f26f-4dba-a829-253c83d1b387"); // IDXGIFactory1
    IntPtr pf;
    if (CreateDXGIFactory1(ref iid, out pf) == 0) {
      var factory = (IDXGIFactory)Marshal.GetObjectForIUnknown(pf);
      IntPtr pa;
      if (factory.EnumAdapters(0, out pa) == 0) {
        var adapter = (IDXGIAdapter)Marshal.GetObjectForIUnknown(pa);
        for (uint i = 0; i < 16; i++) {
          IntPtr po;
          if (adapter.EnumOutputs(i, out po) != 0) break;
          var output = (IDXGIOutput)Marshal.GetObjectForIUnknown(po);
          DXGI_OUTPUT_DESC d;
          output.GetDesc(out d);
          var c = d.DesktopCoordinates;
          outs.Add(string.Format("{{\"index\":{0},\"device\":{1},\"desktop\":{2},\"monitor\":\"{3}\"}}", i, J(d.DeviceName), R(c.Left, c.Top, c.Right - c.Left, c.Bottom - c.Top), d.Monitor.ToInt64()));
        }
      }
    }
    var pids = new HashSet<uint>();
    foreach (var p in Process.GetProcesses()) {
      if (p.ProcessName.StartsWith("VPinballX", StringComparison.OrdinalIgnoreCase)) pids.Add((uint)p.Id);
    }
    var wins = new List<string>();
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      if (!pids.Contains(pid) || !IsWindowVisible(h)) return true;
      RECT r;
      if (!GetClientRect(h, out r) || r.Right - r.Left < 64 || r.Bottom - r.Top < 64) return true;
      var pt = new POINT();
      ClientToScreen(h, ref pt);
      var sb = new StringBuilder(256);
      GetWindowText(h, sb, sb.Capacity);
      wins.Add(string.Format("{{\"pid\":{0},\"title\":{1},\"client\":{2},\"monitor\":\"{3}\"}}", pid, J(sb.ToString()), R(pt.X, pt.Y, r.Right - r.Left, r.Bottom - r.Top), MonitorFromWindow(h, 2).ToInt64()));
      return true;
    }, IntPtr.Zero);
    return "{\"outputs\":[" + string.Join(",", outs.ToArray()) + "],\"windows\":[" + string.Join(",", wins.ToArray()) + "]}";
  }
}
'@
[CastcadeProbe]::Run()
`;

/** Run the probe (Windows only). Resolves with the DXGI outputs and every visible VPX window. */
export function probeWindows(timeoutMs = 20_000): Promise<WindowProbe> {
  return new Promise((resolve, reject) => {
    // -EncodedCommand (UTF-16LE base64): `-Command -` would run stdin line by line and break the here-string.
    const encoded = Buffer.from(PS_SCRIPT, 'utf16le').toString('base64');
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      ps.kill();
      reject(new Error('window probe timed out'));
    }, timeoutMs);
    ps.stdout.on('data', (b: Buffer) => (out += b.toString('utf8')));
    ps.stderr.on('data', (b: Buffer) => (err += b.toString('utf8')));
    ps.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    ps.on('close', (code) => {
      clearTimeout(timer);
      const line = out.trim().split(/\r?\n/).filter((l) => l.startsWith('{')).pop();
      if (code !== 0 || !line) return reject(new Error(`window probe failed (exit ${code}): ${err.trim() || out.trim()}`));
      try {
        resolve(JSON.parse(line) as WindowProbe);
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
    ps.stdin.end();
  });
}

/** The VPX playfield window: the one titled like VPX's player, else the largest visible VPX window. */
export function pickPlayfield(windows: VpxWindow[]): VpxWindow | null {
  if (windows.length === 0) return null;
  const titled = windows.filter((w) => /visual pinball player/i.test(w.title));
  const pool = titled.length > 0 ? titled : windows;
  return [...pool].sort((a, b) => b.client.width * b.client.height - a.client.width * a.client.height)[0] ?? null;
}

/**
 * The `ddagrab` crop for a window: the output whose monitor holds it, the client area relative to that output, clipped
 * to it, sizes rounded down to even numbers (4:2:0 encoders need them). Null when no output holds the window.
 */
export function cropFor(win: VpxWindow, outputs: DxgiOutput[]): DdagrabCrop | null {
  const out = outputs.find((o) => o.monitor === win.monitor)
    ?? outputs.find((o) => win.client.left >= o.desktop.left && win.client.left < o.desktop.left + o.desktop.width && win.client.top >= o.desktop.top && win.client.top < o.desktop.top + o.desktop.height);
  if (!out) return null;
  const x0 = Math.max(win.client.left, out.desktop.left);
  const y0 = Math.max(win.client.top, out.desktop.top);
  const x1 = Math.min(win.client.left + win.client.width, out.desktop.left + out.desktop.width);
  const y1 = Math.min(win.client.top + win.client.height, out.desktop.top + out.desktop.height);
  const width = (x1 - x0) & ~1;
  const height = (y1 - y0) & ~1;
  if (width < 64 || height < 64) return null;
  return { outputIdx: out.index, offsetX: x0 - out.desktop.left, offsetY: y0 - out.desktop.top, width, height };
}
