/**
 * Was the game played in a headset?
 *
 * VPX 10.8.0's VR-capable builds decide VR at player start (`player.cpp`): with the
 * `[PlayerVR] AskToTurnOn` key at its default 0 the game goes to the headset whenever OpenVR
 * reports one present, so neither the exe name nor the ini (`[Player] Stereo3D` stays 0 on the
 * owner's rig) says how a given game was displayed. What does: the VR runtime VPX reached is loaded
 * into the VPX process, and that runtime's server runs beside it. Each runtime is recognised by its
 * own pair (`runtimeFrom`); a VR build on a monitor, or a runtime left open while VPX ran flat, has
 * one half only and reads as the monitor.
 *
 * B22 (2026-10-31): SteamVR is not the only runtime. The owner's rig (VPinballX_GL64 10.8.0.2078
 * Panasony) renders through OpenXR on Virtual Desktop's runtime: `openvr_api64.dll`,
 * `virtualdesktop-openxr.dll`, `openxr-oculus-compatibility.dll` and `VirtualDesktop.LibOVRRT64_1.dll`
 * in the process, no `vrclient_x64.dll`, no SteamVR process, the Khronos `ActiveRuntime` naming
 * Virtual Desktop's json. The SteamVR-only rule read that rig as "monitor" since day one, so its
 * scores went out as `play_device=pc`. The active OpenXR runtime is read in the same PowerShell call.
 *
 * Sampled once the table is known, again when the hook reports `table_loaded` (the player has started,
 * so OpenVR is up: A6, 2026-10-31, the table-known sample on the owner's rig came from the editor and
 * read "monitor" while the game ran in the headset), and again at capture while the process is still
 * there. Sent to ArcAid as `play_device=vr_headset` (ArcAid 2.166.0),
 * which puts the VR headset badge on the score instead of PC. Evidence, same trust as the rest of
 * what the companion reports.
 */
import { execFile } from 'node:child_process';

/**
 * The VR runtime VPX rendered through. Only `steamvr` has a compositor the OpenVR overlay helper (D7) can draw
 * into (B22, 2026-10-31); on the others the panel goes in through the Castcade OpenXR layer inside VPX (D7.3).
 */
export type VrRuntime = 'steamvr' | 'virtual-desktop' | 'oculus' | 'openxr-other';

export interface VrObservation {
  /** The decision: a VR runtime is loaded in the VPX process and its server runs (`runtime !== null`). */
  inVr: boolean;
  /** Which runtime, when `inVr`; null on the monitor. Absent in samples taken before B22 (those were SteamVR's rule). */
  runtime: VrRuntime | null;
  /** `vrclient_x64.dll` (SteamVR's runtime client) is loaded in the VPX process: VPX called into OpenVR. */
  runtimeLoaded: boolean;
  /** SteamVR's compositor or server is running on this machine. */
  compositorRunning: boolean;
  /** `openvr_api*.dll` is in the process: the exe is a VR-capable build (true for the Panasony VR build). */
  vrCapableBuild: boolean;
  /** `HKLM\SOFTWARE\Khronos\OpenXR\1` `ActiveRuntime`: the runtime json OpenXR apps load; null when unset or unreadable. */
  activeOpenXrRuntime: string | null;
  sampledAt: string; // ISO
}

export interface VrProbe {
  /** Null when the process is gone or the probe could not run; the caller keeps its earlier sample. */
  sample(pid: number): Promise<VrObservation | null>;
}

export type PlayDevice = 'pc' | 'vr_headset';

export const VR_RUNTIME_MODULE = /^vrclient(_x64)?\.dll$/i;
export const VR_API_MODULE = /^openvr_api(64)?\.dll$/i;
export const VR_COMPOSITOR_PROCESSES = ['vrcompositor', 'vrserver'] as const;
/** Virtual Desktop's OpenXR runtime (`C:\Program Files\Virtual Desktop Streamer\OpenXR\virtualdesktop-openxr.dll`). */
export const VD_OPENXR_MODULE = /^virtualdesktop[-_.]openxr.*\.dll$/i;
/**
 * The Oculus / Meta runtime itself (`LibOVRRT64_1.dll`, also what `oculus_openxr_64.json` loads). Anchored so Virtual
 * Desktop's `VirtualDesktop.LibOVRRT64_1.dll` and `openxr-oculus-compatibility.dll` (both on the owner's rig) do not match.
 */
export const OCULUS_RUNTIME_MODULE = /^LibOVRRT(32|64)?_\d+\.dll$/i;
/** Any OpenXR loader or runtime dll by name (`openxr_loader.dll`, `virtualdesktop-openxr.dll`, `openxr-oculus-compatibility.dll`). */
export const OPENXR_MODULE = /openxr/i;
/** The servers beside each non-SteamVR runtime: Virtual Desktop's streamer server, the Oculus service. */
export const VR_SERVER_PROCESSES = { virtualDesktop: 'VirtualDesktop.Server', oculus: 'OVRServer_x64' } as const;
export const OPENXR_ACTIVE_RUNTIME_KEY = 'HKLM:\\SOFTWARE\\Khronos\\OpenXR\\1';

/** A probe that never answers: tests, and platforms without PowerShell. */
export const NO_VR_PROBE: VrProbe = { sample: async () => null };

/**
 * One PowerShell invocation: the VR-related modules of the VPX process (an empty list when the
 * process is gone), the SteamVR processes, the other runtimes' servers, and the active OpenXR runtime
 * (B22). `$pid` is PowerShell's own variable, hence `$vpxPid`. The module filter is unanchored and
 * case-insensitive (`-match`), so it keeps `VirtualDesktop.LibOVRRT64_1.dll` and every `*openxr*` dll.
 */
export function vrProbeQuery(pid: number): string {
  const id = Math.floor(pid);
  if (!Number.isFinite(id) || id <= 0) throw new Error(`bad pid ${pid}`);
  const servers = Object.values(VR_SERVER_PROCESSES)
    .map((n) => `'${n}'`)
    .join(',');
  return (
    `$vpxPid = ${id}; $m = @(); $alive = $false; $rt = $null; ` +
    'try { $p = Get-Process -Id $vpxPid -ErrorAction Stop; $alive = $true; ' +
    "$m = @($p.Modules | ForEach-Object { $_.ModuleName } | Where-Object { $_ -match 'vrclient|openvr_api|openxr|libovrrt' }) } catch {} " +
    `$c = @(Get-Process -Name ${VR_COMPOSITOR_PROCESSES.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { $_.Name }); ` +
    `$s = @(Get-Process -Name ${servers} -ErrorAction SilentlyContinue | ForEach-Object { $_.Name }); ` +
    `try { $rt = (Get-ItemProperty -LiteralPath '${OPENXR_ACTIVE_RUNTIME_KEY}' -Name ActiveRuntime -ErrorAction Stop).ActiveRuntime } catch {} ` +
    '[pscustomobject]@{ Alive = $alive; Modules = $m; Compositor = $c; Servers = $s; ActiveRuntime = $rt } | ConvertTo-Json -Compress'
  );
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' ? [v] : [];

/**
 * The runtime from the probe's facts, first match wins. Each non-SteamVR rule wants VR evidence inside the VPX process
 * (a runtime or OpenXR dll), never the registry and a running server alone: Virtual Desktop streams the desktop too,
 * and a player on a virtual monitor with VPX flat must stay "monitor" (B22, 2026-10-31).
 */
export function runtimeFrom(f: { modules: string[]; compositor: string[]; servers: string[]; activeRuntime: string | null }): VrRuntime | null {
  const has = (re: RegExp): boolean => f.modules.some((m) => re.test(m));
  const running = (name: string): boolean => f.servers.some((s) => s.toLowerCase() === name.toLowerCase());
  const xrInProcess = has(OPENXR_MODULE) || has(OCULUS_RUNTIME_MODULE);
  const active = f.activeRuntime ?? '';
  if (has(VR_RUNTIME_MODULE) && f.compositor.length > 0) return 'steamvr';
  if (has(VD_OPENXR_MODULE)) return 'virtual-desktop';
  if (xrInProcess && /virtual desktop/i.test(active) && running(VR_SERVER_PROCESSES.virtualDesktop)) return 'virtual-desktop';
  if ((has(OCULUS_RUNTIME_MODULE) || (xrInProcess && /oculus_openxr/i.test(active))) && running(VR_SERVER_PROCESSES.oculus)) return 'oculus';
  if (has(OPENXR_MODULE) && active.trim() !== '') return 'openxr-other';
  return null;
}

/** Parse the query's JSON. Null when the process was gone (nothing to say about a finished game). */
export function parseVrProbe(stdout: string, now: () => number = Date.now): VrObservation | null {
  const text = stdout.trim();
  if (!text) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const o = parsed as Record<string, unknown>;
  if (o['Alive'] === false) return null;
  const modules = strings(o['Modules']);
  const compositor = strings(o['Compositor']);
  const servers = strings(o['Servers']);
  const rt = o['ActiveRuntime'];
  const activeOpenXrRuntime = typeof rt === 'string' && rt.trim() !== '' ? rt.trim() : null;
  const runtime = runtimeFrom({ modules, compositor, servers, activeRuntime: activeOpenXrRuntime });
  return {
    inVr: runtime !== null,
    runtime,
    runtimeLoaded: modules.some((m) => VR_RUNTIME_MODULE.test(m)),
    compositorRunning: compositor.length > 0,
    vrCapableBuild: modules.some((m) => VR_API_MODULE.test(m)),
    activeOpenXrRuntime,
    sampledAt: new Date(now()).toISOString(),
  };
}

/** The wire value; null when no sample was taken (ArcAid then reads the score as played on the monitor). */
export function playDeviceFor(vr: VrObservation | null | undefined): PlayDevice | null {
  if (!vr) return null;
  return vr.inVr ? 'vr_headset' : 'pc';
}

/** The runtime of a sample; one taken before B22 has none, and its `inVr` was SteamVR's rule. */
export function vrRuntimeOf(vr: VrObservation | null | undefined): VrRuntime | null {
  if (!vr) return null;
  return vr.runtime ?? (vr.inVr ? 'steamvr' : null);
}

export const VR_RUNTIME_LABEL: Record<VrRuntime, string> = {
  steamvr: 'SteamVR',
  'virtual-desktop': 'Virtual Desktop (OpenXR)',
  oculus: 'the Oculus / Meta runtime (OpenXR)',
  'openxr-other': 'an OpenXR runtime',
};

/** Short wording for Status and capture details. */
export function describeVr(vr: VrObservation): string {
  const runtime = vrRuntimeOf(vr);
  if (vr.inVr && runtime) return `played in a VR headset via ${VR_RUNTIME_LABEL[runtime]}`;
  if (vr.runtimeLoaded) return 'played on the monitor (OpenVR loaded, no SteamVR compositor)';
  return 'played on the monitor';
}

/**
 * The facts behind the decision, for the log and the Match tab's rig line ("vrclient loaded, compositor running").
 * A6 (2026-10-31): the owner's first alpha match picked the desktop panel in VR, and the log could not say why; this
 * wording names which half of the evidence was missing. B22: the runtime first, and the active OpenXR runtime when set.
 */
export function describeVrEvidence(vr: VrObservation): string {
  const runtime = vrRuntimeOf(vr);
  const steam = `vrclient ${vr.runtimeLoaded ? 'loaded' : 'not loaded'}, compositor ${vr.compositorRunning ? 'running' : 'not running'}`;
  const xr = vr.activeOpenXrRuntime ? `, active OpenXR runtime ${vr.activeOpenXrRuntime}` : '';
  if (runtime === 'steamvr' || (!runtime && !vr.activeOpenXrRuntime)) return steam;
  return `${runtime ? `${VR_RUNTIME_LABEL[runtime]}, ` : ''}${steam}${xr}`;
}

type ExecFileLike = (
  file: string,
  args: string[],
  callback: (error: Error | null, stdout?: string) => void,
) => unknown;

export function createPowershellVrProbe(exec: ExecFileLike = execFile as unknown as ExecFileLike, now: () => number = Date.now): VrProbe {
  return {
    sample(pid) {
      return new Promise((resolve, reject) => {
        let query: string;
        try {
          query = vrProbeQuery(pid);
        } catch (err) {
          reject(err);
          return;
        }
        try {
          exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', query], (error, stdout) => {
            if (error) {
              reject(error);
              return;
            }
            resolve(parseVrProbe(stdout ?? '', now));
          });
        } catch (err) {
          reject(err);
        }
      });
    },
  };
}
