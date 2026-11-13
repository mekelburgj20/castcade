/**
 * A14 (2026-11-12): start VPX on a table the way a player or a front end does: `"<VPinballX exe>" -Play "<table.vpx>"`
 * from the exe's folder (the switch `companion/scripts/validate-original.ts` uses and the witness's process watch
 * reads back; no other switch, so the player's own ini, display and VR settings apply). The exe is the one the witness
 * last saw running (`vpxExe` in settings.json), which on a rig with several builds is the one the player plays.
 *
 * The process is started directly (no shell, the arguments as an array) and let go: Castcade does not own VPX, and the
 * witness finds it like any other launch. The spawner and the file check are injected, so tests start nothing.
 */
import { win32 } from 'node:path';
import { isVpxExe } from '../witness/process-watch.js';

export interface SpawnedProcess {
  pid?: number | undefined;
  unref(): void;
  on(event: 'error', cb: (err: Error) => void): unknown;
}

export interface SpawnOptions {
  cwd: string;
  detached: true;
  stdio: 'ignore';
  shell: false;
  windowsHide: false;
}

export type SpawnLike = (command: string, args: readonly string[], options: SpawnOptions) => SpawnedProcess;

export interface LaunchPlan {
  command: string;
  args: readonly ['-Play', string];
  cwd: string;
}

/** The command for a table, or the sentence that says why there is none. Pure. */
export function planLaunch(exe: string | null, vpxPath: string): { ok: true; plan: LaunchPlan } | { ok: false; reason: string } {
  if (!exe) return { ok: false, reason: 'Castcade does not know where VPX is yet: open any table in VPX once, then try again' };
  if (!win32.isAbsolute(exe) || !isVpxExe(exe)) return { ok: false, reason: 'the VPX program Castcade remembers is not a VPinballX exe: open any table in VPX once, then try again' };
  if (!win32.isAbsolute(vpxPath) || !/\.vpx$/i.test(vpxPath) || /["\r\n\0]/.test(vpxPath)) return { ok: false, reason: 'that is not a table file' };
  return { ok: true, plan: { command: exe, args: ['-Play', vpxPath], cwd: win32.dirname(exe) } };
}

export type LaunchResult = { ok: true; pid: number | null } | { ok: false; reason: string };

export interface VpxLauncher {
  launch(vpxPath: string): Promise<LaunchResult>;
}

export interface VpxLauncherOptions {
  spawn: SpawnLike;
  /** Does this file exist (the exe and the table are both checked before anything starts). */
  exists(path: string): Promise<boolean>;
  /** The VPX exe: the one seen this run, else the one remembered. */
  exe(): string | null;
  log(line: string): void;
}

export function createVpxLauncher(o: VpxLauncherOptions): VpxLauncher {
  return {
    async launch(vpxPath) {
      const p = planLaunch(o.exe(), vpxPath);
      if (!p.ok) return p;
      const { plan } = p;
      if (!(await o.exists(plan.command))) return { ok: false, reason: 'the VPX program Castcade remembers is no longer there: open any table in VPX once, then try again' };
      if (!(await o.exists(vpxPath))) return { ok: false, reason: 'the table file is no longer there' };
      try {
        const child = o.spawn(plan.command, plan.args, { cwd: plan.cwd, detached: true, stdio: 'ignore', shell: false, windowsHide: false });
        // A spawn error arrives as an event after the call returns: it must have a listener, or it ends the app.
        child.on('error', (err) => o.log(`launch: VPX did not start: ${err.message}`));
        child.unref();
        o.log(`launch: started VPX on ${win32.basename(vpxPath)} (${win32.basename(plan.command)} -Play, pid ${child.pid ?? 'unknown'})`);
        return { ok: true, pid: child.pid ?? null };
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        o.log(`launch: VPX did not start: ${reason}`);
        return { ok: false, reason: `VPX did not start (${reason})` };
      }
    },
  };
}
