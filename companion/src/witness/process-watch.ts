/**
 * Watch for Visual Pinball X. Every `intervalMs` (2 s) an injectable `ProcessLister` is asked for
 * the running processes; a `VPinballX*.exe` pid that was not there before is a launch, one that
 * disappeared is an exit, and a changed main window title is a `title` event. The table comes from
 * `-Play "<path>.vpx"` or a positional `<path>.vpx` (file association) on the command line, else
 * from the editor's window title `Visual Pinball - [<table>]` once it shows one (null until then).
 * The real lister runs one PowerShell query joining `Get-CimInstance Win32_Process` with
 * `Get-Process` for the title; tests drive a fake lister and a `ManualClock`.
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
  /** Main window title (`Get-Process.MainWindowTitle`), null when there is no window yet. */
  windowTitle: string | null;
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

/** How the table name of a session was established, strongest first. */
export type TableSource = 'play' | 'arg' | 'title' | 'romname' | 'rom';

/**
 * The path argument of a switch such as `-Ini` / `-TableIni` (case-insensitive): a quoted path is
 * taken whole; an unquoted one runs to the next switch or to the first `.ini`. Null when absent.
 */
export function parseSwitchPath(commandLine: string, switchName: string): string | null {
  const args = splitCommandLine(commandLine);
  const re = new RegExp(`^[-/]${switchName}$`, 'i');
  for (let i = 1; i < args.length; i++) {
    if (!re.test(args[i] ?? '')) continue;
    const parts: string[] = [];
    for (let j = i + 1; j < args.length; j++) {
      const next = args[j];
      if (next === undefined) break;
      if (parts.length > 0 && /^[-/][A-Za-z]/.test(next)) break;
      parts.push(next);
      if (/\.ini$/i.test(next)) break;
    }
    const path = parts.join(' ').trim();
    return path.length > 0 ? path : null;
  }
  return null;
}

/**
 * The table file given to `-Play` / `/Play` (case-insensitive). A quoted path is taken whole; an
 * unquoted one runs to the next switch (`-Minimized`, `/Primary` ...). Null when VPX was started
 * without `-Play`.
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

/**
 * A positional `<path>.vpx` argument: what a file-association launch (`"<exe>" "<table>.vpx"`) or
 * `-Edit <table>.vpx` carries. Null when there is none.
 */
export function parsePositionalVpx(commandLine: string): string | null {
  const args = splitCommandLine(commandLine);
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a !== undefined && /\.vpx$/i.test(a) && !/^[-/]/.test(a)) return a;
  }
  return null;
}

/** Table path from the command line: `-Play` first, then a positional `.vpx`. */
export function parseTableArg(commandLine: string): { path: string; source: 'play' | 'arg' } | null {
  const play = parsePlayArg(commandLine);
  if (play) return { path: play, source: 'play' };
  const positional = parsePositionalVpx(commandLine);
  return positional ? { path: positional, source: 'arg' } : null;
}

export interface ParsedTitle {
  /** `editor` = the editor window (table null until one is loaded); `player` = the player is up. */
  kind: 'editor' | 'player' | 'unknown';
  table: string | null;
}

/**
 * VPX main window titles: `Visual Pinball - [<table>]` (editor with a table; `.vpx` and a modified
 * marker stripped), `Visual Pinball` (editor, nothing loaded), `Visual Pinball Player` (the
 * in-process player is up).
 */
export function parseWindowTitle(title: string | null): ParsedTitle {
  const t = (title ?? '').trim();
  if (!t) return { kind: 'unknown', table: null };
  if (/^Visual Pinball(?: X)? Player\b/i.test(t)) return { kind: 'player', table: null };
  const m = /^Visual Pinball(?: X)?(?:\s*-\s*\[(.+)\])?\s*$/i.exec(t);
  if (!m) return { kind: 'unknown', table: null };
  const inner = (m[1] ?? '').replace(/\s*\*$/, '').replace(/\.vpx$/i, '').trim();
  return { kind: 'editor', table: inner.length > 0 ? inner : null };
}

/** `C:\tables\Medieval Madness (Williams 1997).vpx` → `Medieval Madness (Williams 1997)`. */
export function tableNameFromPath(path: string): string {
  return parsePath(path.replace(/\\/g, '/')).name;
}

// ------------------------------------------------------------------------------- real lister --

/**
 * One PowerShell invocation: Win32_Process for the command line and start time, joined with
 * Get-Process for the main window title (which CIM does not have). Works on Windows PowerShell 5.1
 * (dates as `\/Date(ms)\/`) and PowerShell 7 (ISO dates).
 */
export const VPX_PROCESS_QUERY =
  "Get-CimInstance Win32_Process -Filter \"Name LIKE 'VPinballX%'\" | ForEach-Object { " +
  '$p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue; ' +
  '[pscustomobject]@{ ProcessId=$_.ProcessId; Name=$_.Name; ExecutablePath=$_.ExecutablePath; ' +
  'CommandLine=$_.CommandLine; CreationDate=$_.CreationDate; MainWindowTitle=$p.MainWindowTitle } } | ' +
  'ConvertTo-Json -Compress';

interface CimProcess {
  ProcessId?: unknown;
  ExecutablePath?: unknown;
  CommandLine?: unknown;
  Name?: unknown;
  CreationDate?: unknown;
  MainWindowTitle?: unknown;
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
      windowTitle: typeof p.MainWindowTitle === 'string' && p.MainWindowTitle.trim() ? p.MainWindowTitle : null,
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
  /** Table file from the command line (`-Play` or positional), or null. */
  tablePath: string | null;
  /** `-Ini <path>` from the command line (a settings file other than the default), or null. */
  iniPath: string | null;
  /** `-TableIni <path>` from the command line, or null. */
  tableIniPath: string | null;
  /** Table name: from the command line at launch, later from the editor title; null until known. */
  table: string | null;
  tableSource: TableSource | null;
  /** When the watch first saw it (clock ms), not the process creation time. */
  seenAt: number;
  startedAt: number | null;
  /** Latest main window title seen. */
  title: string | null;
}

export interface VpxExit {
  launch: VpxLaunch;
  /** When the watch first noticed it gone (clock ms). */
  exitedAt: number;
}

export interface VpxTitle {
  launch: VpxLaunch;
  title: string | null;
  parsed: ParsedTitle;
  at: number;
}

export interface ProcessWatchEvents extends Record<string, unknown> {
  launch: VpxLaunch;
  exit: VpxExit;
  /** The main window title changed (editor table loaded, player up/down). */
  title: VpxTitle;
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

  /** One poll: diff the lister against the known set and emit launches/exits/titles. Safe to call directly. */
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
      const title = p.windowTitle && p.windowTitle.trim() ? p.windowTitle : null;
      const existing = this.known.get(p.pid);
      if (existing) {
        if (existing.title !== title) this.applyTitle(existing, title, now);
        continue;
      }
      const arg = parseTableArg(p.commandLine);
      const launch: VpxLaunch = {
        pid: p.pid,
        exe: p.exe,
        tablePath: arg?.path ?? null,
        iniPath: parseSwitchPath(p.commandLine, 'ini'),
        tableIniPath: parseSwitchPath(p.commandLine, 'tableini'),
        table: arg ? tableNameFromPath(arg.path) : null,
        tableSource: arg?.source ?? null,
        seenAt: now,
        startedAt: p.startedAt,
        title: null,
      };
      this.known.set(p.pid, launch);
      this.emitter.emit('launch', launch);
      if (title !== null) this.applyTitle(launch, title, now);
    }
    for (const [pid, launch] of [...this.known]) {
      if (seen.has(pid)) continue;
      this.known.delete(pid);
      this.emitter.emit('exit', { launch, exitedAt: now });
    }
  }

  private applyTitle(launch: VpxLaunch, title: string | null, at: number): void {
    launch.title = title;
    const parsed = parseWindowTitle(title);
    // The command line is the stronger claim; the title fills in when it said nothing.
    if (parsed.kind === 'editor' && parsed.table && launch.tableSource !== 'play' && launch.tableSource !== 'arg') {
      launch.table = parsed.table;
      launch.tableSource = 'title';
    }
    this.emitter.emit('title', { launch, title, parsed, at });
  }
}
