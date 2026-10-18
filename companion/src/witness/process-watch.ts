/**
 * Watch for Visual Pinball X. Every `intervalMs` (2 s) an injectable `ProcessLister` is asked for
 * the running processes; a `VPinballX*.exe` pid that was not there before is a launch, one that
 * disappeared is an exit. The table comes from `-Play "<path>.vpx"` on the command line (null for
 * the editor). The real lister runs one PowerShell `Get-CimInstance Win32_Process` query; tests
 * drive a fake lister and a `ManualClock`.
 */
import { execFile } from 'node:child_process';
import { basename, parse as parsePath } from 'node:path';
import { Emitter } from '../match/events.js';
import { realClock, type Clock, type TimerHandle } from '../match/clock.js';
import type { ExecFileLike } from './nvram-dir.js';

export interface ProcessInfo {
  pid: number;
  /** Full exe path when the lister knows it, else the process name. */
  exe: string;
  commandLine: string;
  /** Process start, epoch ms, when the lister knows it. */
  startedAt: number | null;
}

export interface ProcessLister {
  /** Running processes; may be pre-filtered to VPX, the watch filters again. */
  list(): Promise<ProcessInfo[]>;
}

export const VPX_EXE = /^VPinballX.*\.exe$/i;

export function isVpxExe(exe: string): boolean {
  return VPX_EXE.test(basename(exe.replace(/\\/g, '/')));
}

// ------------------------------------------------------------------------------ command line --

/** Split a Win32 command line into arguments: double quotes group, everything else is whitespace. */
export function splitCommandLine(commandLine: string): string[] {
  const args: string[] = [];
  let current = '';
  let inQuotes = false;
  let hadToken = false;
  for (const ch of commandLine) {
    if (ch === '"') {
      inQuotes = !inQuotes;
      hadToken = true;
    } else if (!inQuotes && /\s/.test(ch)) {
      if (hadToken) {
        args.push(current);
        current = '';
        hadToken = false;
      }
    } else {
      current += ch;
      hadToken = true;
    }
  }
  if (hadToken) args.push(current);
  return args;
}

/**
 * The table file given to `-Play` / `/Play` (case-insensitive). A quoted path is taken whole; an
 * unquoted one runs to the next switch (`-Minimized`, `/Primary` ...). Null when VPX was started
 * without a table (the editor).
 */
export function parsePlayArg(commandLine: string): string | null {
  const args = splitCommandLine(commandLine);
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === undefined || !/^[-/]play$/i.test(a)) continue;
    const parts: string[] = [];
    for (let j = i + 1; j < args.length; j++) {
      const next = args[j];
      if (next === undefined) break;
      if (parts.length > 0 && /^[-/][A-Za-z]/.test(next)) break;
      parts.push(next);
      if (/\.vpx$/i.test(next)) break;
    }
    const path = parts.join(' ').trim();
    return path.length > 0 ? path : null;
  }
  return null;
}

/** `C:\tables\Medieval Madness (Williams 1997).vpx` → `Medieval Madness (Williams 1997)`. */
export function tableNameFromPath(path: string): string {
  return parsePath(path.replace(/\\/g, '/')).name;
}

// ------------------------------------------------------------------------------- real lister --

export const VPX_PROCESS_QUERY =
  "Get-CimInstance Win32_Process -Filter \"Name LIKE 'VPinballX%'\" | " +
  'Select-Object ProcessId,ExecutablePath,CommandLine,Name,CreationDate | ConvertTo-Json -Compress';

interface CimProcess {
  ProcessId?: unknown;
  ExecutablePath?: unknown;
  CommandLine?: unknown;
  Name?: unknown;
  CreationDate?: unknown;
}

/**
 * CIM dates as ConvertTo-Json emits them: PowerShell 7 writes ISO 8601, Windows PowerShell 5.1
 * writes `\/Date(1697555555000)\/`, and WMI's own DMTF form is `20261017180842.123456-300`.
 */
export function parseCimDate(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const s = value.trim();
  const dotnet = /^\\?\/?Date\((-?\d+)\)\\?\/?$/.exec(s);
  if (dotnet) return Number(dotnet[1]);
  const dmtf = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{6})([+-])(\d{3})$/.exec(s);
  if (dmtf) {
    const [, y, mo, d, h, mi, sec, micro, sign, offMin] = dmtf;
    const utc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(sec), Math.floor(Number(micro) / 1000));
    const offset = Number(offMin) * 60_000 * (sign === '+' ? 1 : -1);
    return utc - offset;
  }
  const iso = Date.parse(s);
  return Number.isFinite(iso) ? iso : null;
}

/** Parse the JSON ConvertTo-Json produced: nothing, one object, or an array. */
export function parseCimProcesses(stdout: string): ProcessInfo[] {
  const text = stdout.trim();
  if (!text) return [];
  const parsed = JSON.parse(text) as CimProcess | CimProcess[] | null;
  const list = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  const out: ProcessInfo[] = [];
  for (const p of list) {
    const pid = Number(p.ProcessId);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const exe = typeof p.ExecutablePath === 'string' && p.ExecutablePath ? p.ExecutablePath : typeof p.Name === 'string' ? p.Name : '';
    out.push({
      pid,
      exe,
      commandLine: typeof p.CommandLine === 'string' ? p.CommandLine : '',
      startedAt: parseCimDate(p.CreationDate),
    });
  }
  return out;
}

export function createPowershellLister(exec: ExecFileLike = execFile as unknown as ExecFileLike): ProcessLister {
  return {
    list() {
      return new Promise((resolve, reject) => {
        try {
          exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', VPX_PROCESS_QUERY], (error, stdout) => {
            if (error) {
              reject(error);
              return;
            }
            try {
              resolve(parseCimProcesses(stdout ?? ''));
            } catch (err) {
              reject(err);
            }
          });
        } catch (err) {
          reject(err);
        }
      });
    },
  };
}

// ------------------------------------------------------------------------------------- watch --

export interface VpxLaunch {
  pid: number;
  exe: string;
  /** Table file from `-Play`, or null for the editor. */
  tablePath: string | null;
  /** Basename without extension, or null for the editor. */
  table: string | null;
  /** When the watch first saw it (clock ms), not the process creation time. */
  seenAt: number;
  startedAt: number | null;
}

export interface VpxExit {
  launch: VpxLaunch;
  /** When the watch first noticed it gone (clock ms). */
  exitedAt: number;
}

export interface ProcessWatchEvents extends Record<string, unknown> {
  launch: VpxLaunch;
  exit: VpxExit;
  error: Error;
}

export interface ProcessWatchOptions {
  lister: ProcessLister;
  clock?: Clock;
  intervalMs?: number;
}

export const DEFAULT_POLL_INTERVAL_MS = 2_000;

export class ProcessWatch {
  private readonly emitter = new Emitter<ProcessWatchEvents>();
  private readonly lister: ProcessLister;
  private readonly clock: Clock;
  private readonly intervalMs: number;
  private readonly known = new Map<number, VpxLaunch>();
  private timer: TimerHandle | null = null;
  private running = false;
  private polling: Promise<void> | null = null;

  constructor(opts: ProcessWatchOptions) {
    this.lister = opts.lister;
    this.clock = opts.clock ?? realClock;
    this.intervalMs = opts.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  on<K extends keyof ProcessWatchEvents>(event: K, cb: (payload: ProcessWatchEvents[K]) => void): () => void {
    return this.emitter.on(event, cb);
  }

  /** The VPX processes currently believed to be running. */
  current(): VpxLaunch[] {
    return [...this.known.values()];
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.pollOnce().finally(() => this.schedule());
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    if (!this.running) return;
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      void this.pollOnce().finally(() => this.schedule());
    }, this.intervalMs);
  }

  /** One poll: diff the lister against the known set and emit launches/exits. Safe to call directly. */
  pollOnce(): Promise<void> {
    if (this.polling) return this.polling;
    this.polling = this.doPoll().finally(() => {
      this.polling = null;
    });
    return this.polling;
  }

  private async doPoll(): Promise<void> {
    // Stamp the poll when it starts: the lister answers for that instant, however long it takes.
    const now = this.clock.now();
    let procs: ProcessInfo[];
    try {
      procs = await this.lister.list();
    } catch (err) {
      this.emitter.emit('error', err instanceof Error ? err : new Error(String(err)));
      return;
    }
    const seen = new Set<number>();
    for (const p of procs) {
      if (!isVpxExe(p.exe)) continue;
      seen.add(p.pid);
      if (this.known.has(p.pid)) continue;
      const tablePath = parsePlayArg(p.commandLine);
      const launch: VpxLaunch = {
        pid: p.pid,
        exe: p.exe,
        tablePath,
        table: tablePath ? tableNameFromPath(tablePath) : null,
        seenAt: now,
        startedAt: p.startedAt,
      };
      this.known.set(p.pid, launch);
      this.emitter.emit('launch', launch);
    }
    for (const [pid, launch] of [...this.known]) {
      if (seen.has(pid)) continue;
      this.known.delete(pid);
      this.emitter.emit('exit', { launch, exitedAt: now });
    }
  }
}
