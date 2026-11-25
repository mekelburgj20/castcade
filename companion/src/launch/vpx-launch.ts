/**
 * A14 (2026-11-12): start VPX on a table the way a player or a front end does: `"<VPinballX exe>" -Play "<table.vpx>"`
 * from the exe's folder (the switch `companion/scripts/validate-original.ts` uses and the witness's process watch
 * reads back; no other switch, so the player's own ini, display and VR settings apply). The exe is the one the witness
 * last saw running (`vpxExe` in settings.json), which on a rig with several builds is the one the player plays.
 *
 * The process is started directly (no shell, the arguments as an array) and let go: Castcade does not own VPX, and the
 * witness finds it like any other launch. The spawner and the file check are injected, so tests start nothing.
 *
 * I11.4.1 (2026-11-16, ADR 0011): the 3D watch session starts the VPX fork instead (`FORK_EXE_NAME`, installed beside
 * the player's own VPinballX_GL64.exe: `forkExeFor`), with the stream's environment (`forkStreamEnv`): additive
 * options of `launch`, so a launch without them is the A14 one, byte for byte. The child's environment is this
 * process's without any `CASTCADE_STREAM*` / `CASTCADE_TEST_*` it may carry, plus the stream's. Its exit is heard.
 */
import { win32 } from 'node:path';
import { FORK_EXE_NAME, isVpxExe } from '../witness/process-watch.js';

export interface SpawnedProcess {
  pid?: number | undefined;
  unref(): void;
  on(event: 'error', cb: (err: Error) => void): unknown;
  /** I11.4.1: heard only by a launch that asks (`onExit`). */
  on(event: 'exit', cb: (code: number | null) => void): unknown;
}

export interface SpawnOptions {
  cwd: string;
  detached: true;
  stdio: 'ignore';
  shell: false;
  windowsHide: false;
  /** I11.4.1: the whole environment of the child; absent: this process's, as before. */
  env?: Record<string, string | undefined>;
}

export type SpawnLike = (command: string, args: readonly string[], options: SpawnOptions) => SpawnedProcess;

export interface LaunchPlan {
  command: string;
  args: readonly ['-Play', string];
  cwd: string;
  /** I11.4.1: variables added to the child's environment (the fork's stream). */
  env?: Readonly<Record<string, string>>;
}

/** The command for a table, or the sentence that says why there is none. Pure. */
export function planLaunch(exe: string | null, vpxPath: string, env?: Readonly<Record<string, string>>): { ok: true; plan: LaunchPlan } | { ok: false; reason: string } {
  if (!exe) return { ok: false, reason: 'Castcade does not know where VPX is yet: open any table in VPX once, then try again' };
  if (!win32.isAbsolute(exe) || !isVpxExe(exe)) return { ok: false, reason: 'the VPX program Castcade remembers is not a VPinballX exe: open any table in VPX once, then try again' };
  if (!win32.isAbsolute(vpxPath) || !/\.vpx$/i.test(vpxPath) || /["\r\n\0]/.test(vpxPath)) return { ok: false, reason: 'that is not a table file' };
  const plan: LaunchPlan = { command: exe, args: ['-Play', vpxPath], cwd: win32.dirname(exe) };
  if (env) plan.env = { ...env };
  return { ok: true, plan };
}

// ----------------------------------------------------------------------------- I11.4.1: the fork --

/** The VPX fork's exe (ADR 0011): it goes beside VPinballX_GL64.exe. Defined beside `isVpxExe`, where the witness reads it. */
export { FORK_EXE_NAME };
/** How far behind the newest frame a watcher renders, as the fork's own Watch launcher sets it (ms). */
export const FORK_WATCH_DELAY_MS = 100;

/** Where the fork goes for this VPX exe (the same folder), or null without one. Pure. */
export function forkExeFor(vpxExe: string | null): string | null {
  if (!vpxExe || !win32.isAbsolute(vpxExe)) return null;
  return win32.join(win32.dirname(vpxExe), FORK_EXE_NAME);
}

/** The fork's stream variables: a player listens on loopback, a watcher connects to the companion on loopback. Pure. */
export function forkStreamEnv(role: 'play' | 'watch', port: number, logFile: string): Record<string, string> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`not a port: ${port}`);
  if (role === 'play') return { CASTCADE_STREAM: 'play', CASTCADE_STREAM_ADDR: `listen:127.0.0.1:${port}`, CASTCADE_STREAM_LOG: logFile };
  return {
    CASTCADE_STREAM: 'watch',
    CASTCADE_STREAM_ADDR: `connect:127.0.0.1:${port}`,
    CASTCADE_STREAM_DELAY_MS: String(FORK_WATCH_DELAY_MS),
    CASTCADE_STREAM_SOUND: '1',
    CASTCADE_STREAM_LOG: logFile,
  };
}

/**
 * I11.4.2 (2026-11-19, docs/design/state-stream-in-match.md §4.4): the fork's variables for a match table: role `match`
 * (a play session that can be sent to watch and called back), its stream on a loopback port for the tunnel, the
 * control connection to this companion, sound replay off (the companion already carries the player's table sound and
 * mutes this PC's VPX while another player is up), the watcher's delay. Pure.
 */
export function forkMatchEnv(streamPort: number, controlPort: number, logFile: string): Record<string, string> {
  for (const port of [streamPort, controlPort]) if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`not a port: ${port}`);
  return {
    CASTCADE_STREAM: 'match',
    CASTCADE_STREAM_ADDR: `listen:127.0.0.1:${streamPort}`,
    CASTCADE_STREAM_CONTROL: `connect:127.0.0.1:${controlPort}`,
    CASTCADE_STREAM_SOUND: '0',
    CASTCADE_STREAM_DELAY_MS: String(FORK_WATCH_DELAY_MS),
    CASTCADE_STREAM_LOG: logFile,
  };
}

/**
 * I11.4.2 (§4.4): a match table's start in the fork: the options for `VpxLauncher.launch`, and whether that start
 * took. `launch` answers ok as soon as the process is spawned; a start that fails after that (the `error` event:
 * EACCES, a file that is not a program) or an exe that ends at once is only known later: `didNotStart` resolves true
 * then, and false once the fork's VPX is up (it said `hello` on the control connection, or it outlived the first
 * seconds). The caller starts the table in the player's own VPX on true.
 */
export interface ForkLaunch {
  options: LaunchOptions;
  didNotStart: Promise<boolean>;
  /**
   * I11.4.9: the caller's word that `launch` itself answered `ok: false` with these options (the exe or the table file
   * is gone, the spawn threw): no process was made, so `options.onExit` never comes. Nothing is expected of this start
   * any more, at once.
   */
  notStarted?(): void;
  /**
   * I11.4.15: the table objects this start's VPX reported (`hello`'s `<editables> <table hash>`), once it has said
   * `hello` with the stream port this start asked for, so it is this table's word and no other VPX's; null when it
   * never did (it closed, did not start, or another start came first). The caller keeps it for the file it started.
   */
  objects?: Promise<{ editables: number; hash: string } | null>;
}

/** `base` without the fork's own variables (case-insensitive, as Windows reads them), then `add`. Pure. */
export function launchEnv(base: Readonly<Record<string, string | undefined>>, add: Readonly<Record<string, string>>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(base)) if (!/^CASTCADE_(STREAM|TEST_)/i.test(k)) out[k] = v;
  return { ...out, ...add };
}

export type LaunchResult = { ok: true; pid: number | null } | { ok: false; reason: string };

/** I11.4.1: what a 3D watch launch adds; none of it: the A14 launch. */
export interface LaunchOptions {
  /** Another VPinballX exe than the remembered one (the fork). */
  exe?: string;
  /** Added to the child's environment. */
  env?: Readonly<Record<string, string>>;
  /** The process ended (its exit code; null when a signal ended it). */
  onExit?(code: number | null): void;
  /** For the log line: `as the 3D watch player`. */
  what?: string;
}

export interface VpxLauncher {
  launch(vpxPath: string, opts?: LaunchOptions): Promise<LaunchResult>;
}

export interface VpxLauncherOptions {
  spawn: SpawnLike;
  /** Does this file exist (the exe and the table are both checked before anything starts). */
  exists(path: string): Promise<boolean>;
  /** The VPX exe: the one seen this run, else the one remembered. */
  exe(): string | null;
  log(line: string): void;
  /** I11.4.1: the environment a launch with `env` starts from. Default: this process's. */
  baseEnv?(): Readonly<Record<string, string | undefined>>;
}

export function createVpxLauncher(o: VpxLauncherOptions): VpxLauncher {
  return {
    async launch(vpxPath, opts = {}) {
      const p = planLaunch(opts.exe ?? o.exe(), vpxPath, opts.env);
      if (!p.ok) return p;
      const { plan } = p;
      if (!(await o.exists(plan.command))) {
        if (opts.exe) return { ok: false, reason: `${win32.basename(plan.command)} is not in ${win32.dirname(plan.command)}` };
        return { ok: false, reason: 'the VPX program Castcade remembers is no longer there: open any table in VPX once, then try again' };
      }
      if (!(await o.exists(vpxPath))) return { ok: false, reason: 'the table file is no longer there' };
      try {
        const options: SpawnOptions = { cwd: plan.cwd, detached: true, stdio: 'ignore', shell: false, windowsHide: false };
        if (plan.env) options.env = launchEnv(o.baseEnv?.() ?? process.env, plan.env);
        const child = o.spawn(plan.command, plan.args, options);
        // A spawn error arrives as an event after the call returns: it must have a listener, or it ends the app.
        // I11.4.1: `onExit` once, whether the process ended or never started (an error may come without an exit).
        let exited = false;
        const ended = (code: number | null): void => {
          if (exited || !opts.onExit) return;
          exited = true;
          opts.onExit(code);
        };
        child.on('error', (err) => {
          o.log(`launch: VPX did not start: ${err.message}`);
          ended(null);
        });
        if (opts.onExit) child.on('exit', (code) => ended(code));
        child.unref();
        o.log(`launch: started VPX on ${win32.basename(vpxPath)} (${win32.basename(plan.command)} -Play, pid ${child.pid ?? 'unknown'})${opts.what ? ` ${opts.what}` : ''}`);
        return { ok: true, pid: child.pid ?? null };
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        o.log(`launch: VPX did not start: ${reason}`);
        return { ok: false, reason: `VPX did not start (${reason})` };
      }
    },
  };
}
