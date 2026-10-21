/**
 * Was the game played in a headset?
 *
 * VPX 10.8.0's VR-capable builds decide VR at player start (`player.cpp`): with the
 * `[PlayerVR] AskToTurnOn` key at its default 0 the game goes to the headset whenever OpenVR
 * reports one present, so neither the exe name nor the ini (`[Player] Stereo3D` stays 0 on the
 * owner's rig) says how a given game was displayed. What does: when VPX initialises OpenVR, the
 * SteamVR runtime client `vrclient_x64.dll` is loaded into the VPX process and SteamVR's
 * compositor (`vrcompositor.exe`) runs beside it. Both together read as "in VR"; either alone does
 * not (a VR build on a monitor, or SteamVR left open while VPX ran flat).
 *
 * Sampled once the table is known (VR is initialised before the table loads) and again at capture
 * while the process is still there. Sent to ArcAid as `play_device=vr_headset` (ArcAid 2.166.0),
 * which puts the VR headset badge on the score instead of PC. Evidence, same trust as the rest of
 * what the companion reports.
 */
import { execFile } from 'node:child_process';

export interface VrObservation {
  /** The decision: OpenVR's runtime client is loaded in the VPX process and the SteamVR compositor is running. */
  inVr: boolean;
  /** `vrclient_x64.dll` (SteamVR's runtime client) is loaded in the VPX process: VPX called into OpenVR. */
  runtimeLoaded: boolean;
  /** SteamVR's compositor or server is running on this machine. */
  compositorRunning: boolean;
  /** `openvr_api*.dll` is in the process: the exe is a VR-capable build (true for the Panasony VR build). */
  vrCapableBuild: boolean;
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

/** A probe that never answers: tests, and platforms without PowerShell. */
export const NO_VR_PROBE: VrProbe = { sample: async () => null };

/**
 * One PowerShell invocation: the VR-related modules of the VPX process (an empty list when the
 * process is gone) and the SteamVR processes present. `$pid` is PowerShell's own variable, hence
 * `$vpxPid`.
 */
export function vrProbeQuery(pid: number): string {
  const id = Math.floor(pid);
  if (!Number.isFinite(id) || id <= 0) throw new Error(`bad pid ${pid}`);
  return (
    `$vpxPid = ${id}; $m = @(); $alive = $false; ` +
    'try { $p = Get-Process -Id $vpxPid -ErrorAction Stop; $alive = $true; ' +
    "$m = @($p.Modules | ForEach-Object { $_.ModuleName } | Where-Object { $_ -match '^(vrclient|openvr_api|openxr_loader)' }) } catch {} " +
    `$c = @(Get-Process -Name ${VR_COMPOSITOR_PROCESSES.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { $_.Name }); ` +
    '[pscustomobject]@{ Alive = $alive; Modules = $m; Compositor = $c } | ConvertTo-Json -Compress'
  );
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' ? [v] : [];

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
  const runtimeLoaded = modules.some((m) => VR_RUNTIME_MODULE.test(m));
  const compositorRunning = compositor.length > 0;
  return {
    inVr: runtimeLoaded && compositorRunning,
    runtimeLoaded,
    compositorRunning,
    vrCapableBuild: modules.some((m) => VR_API_MODULE.test(m)),
    sampledAt: new Date(now()).toISOString(),
  };
}

/** The wire value; null when no sample was taken (ArcAid then reads the score as played on the monitor). */
export function playDeviceFor(vr: VrObservation | null | undefined): PlayDevice | null {
  if (!vr) return null;
  return vr.inVr ? 'vr_headset' : 'pc';
}

/** Short wording for Status and capture details. */
export function describeVr(vr: VrObservation): string {
  if (vr.inVr) return 'played in a VR headset';
  if (vr.runtimeLoaded) return 'played on the monitor (OpenVR loaded, no SteamVR compositor)';
  return 'played on the monitor';
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
