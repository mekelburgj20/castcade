/**
 * Where VPinMAME keeps its `.nv` files. Resolution order: the settings override, the registry
 * (`HKCU\Software\Freeware\Visual PinMame\globals` → `nvram_directory`), then `VPinMAME\nvram`
 * beside the running VPX exe. The registry is read through an injectable `RegistryReader`; the
 * real one shells out to `reg query` so nothing here needs a native module, and tests use a fake.
 */
import { execFile } from 'node:child_process';
import { win32 as winPath } from 'node:path';
import { isNotFound, type WitnessFs } from './fs.js';

export const VPM_GLOBALS_KEY = 'HKCU\\Software\\Freeware\\Visual PinMame\\globals';
export const NVRAM_DIRECTORY_VALUE = 'nvram_directory';

export interface RegistryReader {
  /** The string data of `value` under `key`, or null when the key/value is absent or unreadable. */
  queryValue(key: string, value: string): Promise<string | null>;
  /** Numeric data (`REG_DWORD` / `REG_QWORD`, or a string holding a number), or null. */
  queryNumber(key: string, value: string): Promise<number | null>;
  /** The key's `(Default)` string value (`reg query <key> /ve`), or null. */
  queryDefault(key: string): Promise<string | null>;
}

export interface RegValue {
  name: string;
  type: string;
  data: string;
}

/** Every `    <name>    REG_TYPE    <data>` line of `reg query` output. */
export function parseRegValues(stdout: string): RegValue[] {
  const out: RegValue[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    const m = /^(\S.*?)\s{2,}(REG_[A-Z_]+)\s{2,}(.*)$/.exec(line) ?? /^(\S.*?)\s{2,}(REG_[A-Z_]+)\s*$/.exec(line) ?? /^(\S+)\s+(REG_[A-Z_]+)\s+(.*)$/.exec(line);
    if (!m) continue;
    out.push({ name: m[1] ?? '', type: m[2] ?? '', data: (m[3] ?? '').trim() });
  }
  return out;
}

/** `0x1f` or `31` → 31; anything else null. */
export function regNumber(data: string | null | undefined): number | null {
  if (data === null || data === undefined) return null;
  const s = data.trim();
  if (!s) return null;
  const n = /^0x[0-9a-f]+$/i.test(s) ? Number.parseInt(s, 16) : /^-?\d+$/.test(s) ? Number.parseInt(s, 10) : Number.NaN;
  return Number.isFinite(n) ? n : null;
}

export const REG_DEFAULT_NAME = '(Default)';

export type ExecFileLike = (
  file: string,
  args: string[],
  callback: (error: Error | null, stdout: string, stderr: string) => void,
) => void;

/**
 * Parse `reg query <key> /v <value>` output. Each value line is
 * `    <name>    REG_SZ    <data>`; the data may contain spaces, so split on the type token only.
 */
export function parseRegQuery(stdout: string, value: string): string | null {
  const wanted = value.toLowerCase();
  for (const v of parseRegValues(stdout)) {
    if (v.name.toLowerCase() !== wanted) continue;
    if (v.type !== 'REG_SZ' && v.type !== 'REG_EXPAND_SZ') continue;
    return v.data.length > 0 ? v.data : null;
  }
  return null;
}

/** The numeric data of `value` in `reg query` output (`REG_DWORD`, `REG_QWORD`, or a numeric string). */
export function parseRegNumber(stdout: string, value: string): number | null {
  const wanted = value.toLowerCase();
  for (const v of parseRegValues(stdout)) {
    if (v.name.toLowerCase() !== wanted) continue;
    if (v.type === 'REG_DWORD' || v.type === 'REG_QWORD' || v.type === 'REG_SZ') return regNumber(v.data);
  }
  return null;
}

/** Real reader: `reg.exe query`. Never throws; any failure reads as "not found". */
export function createRegQueryReader(exec: ExecFileLike = execFile as unknown as ExecFileLike): RegistryReader {
  const run = (args: string[]): Promise<string | null> =>
    new Promise((resolve) => {
      try {
        exec('reg', ['query', ...args], (error, stdout) => resolve(error ? null : (stdout ?? '')));
      } catch {
        resolve(null);
      }
    });
  return {
    async queryValue(key, value) {
      const out = await run([key, '/v', value]);
      return out === null ? null : parseRegQuery(out, value);
    },
    async queryNumber(key, value) {
      const out = await run([key, '/v', value]);
      return out === null ? null : parseRegNumber(out, value);
    },
    async queryDefault(key) {
      const out = await run([key, '/ve']);
      return out === null ? null : parseRegQuery(out, REG_DEFAULT_NAME);
    },
  };
}

/** A reader for tests and for platforms without a registry. */
export function createStaticRegistry(values: Record<string, string>): RegistryReader {
  const lookup = (key: string, value: string): string | null => {
    for (const [k, v] of Object.entries(values)) if (k.toLowerCase() === `${key}\\${value}`.toLowerCase()) return v;
    return null;
  };
  return {
    async queryValue(key, value) {
      return lookup(key, value);
    },
    async queryNumber(key, value) {
      return regNumber(lookup(key, value));
    },
    async queryDefault(key) {
      return lookup(key, REG_DEFAULT_NAME);
    },
  };
}

/** The VPX installation root for a running exe: the exe's directory. */
export function vpxRootFromExe(exe: string): string {
  // Windows paths even when the tests run on Linux CI: use the win32 flavour explicitly.
  return winPath.dirname(exe);
}

export function expandEnvVars(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(/%([^%]+)%/g, (whole, name: string) => env[name] ?? env[name.toUpperCase()] ?? whole);
}

export interface ResolveNvramDirOptions {
  override: string | null;
  registry: RegistryReader;
  /** The running VPX exe, when one is known, for the `<root>\VPinMAME\nvram` fallback. */
  vpxExe: string | null;
  fs: WitnessFs;
  env?: NodeJS.ProcessEnv;
}

export type NvramDirSource = 'override' | 'registry' | 'exe' | 'none';

export interface ResolvedNvramDir {
  dir: string | null;
  source: NvramDirSource;
}

async function isDir(fs: WitnessFs, path: string): Promise<boolean> {
  try {
    await fs.readdir(path);
    return true;
  } catch (err) {
    if (isNotFound(err)) return false;
    // ENOTDIR and friends: not a usable directory either.
    return false;
  }
}

/** Resolve the nvram directory. The override is trusted as given; the other two must exist. */
export async function resolveNvramDir(opts: ResolveNvramDirOptions): Promise<ResolvedNvramDir> {
  if (opts.override && opts.override.trim()) return { dir: opts.override.trim(), source: 'override' };

  const fromRegistry = await opts.registry.queryValue(VPM_GLOBALS_KEY, NVRAM_DIRECTORY_VALUE);
  if (fromRegistry) {
    const expanded = expandEnvVars(fromRegistry, opts.env);
    if (await isDir(opts.fs, expanded)) return { dir: expanded, source: 'registry' };
  }

  if (opts.vpxExe) {
    const candidate = winPath.join(vpxRootFromExe(opts.vpxExe), 'VPinMAME', 'nvram');
    if (await isDir(opts.fs, candidate)) return { dir: candidate, source: 'exe' };
  }

  return { dir: null, source: 'none' };
}
