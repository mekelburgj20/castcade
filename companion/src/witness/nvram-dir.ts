/**
 * Where VPinMAME keeps its `.nv` files. Resolution order: the settings override, the registry
 * (`HKCU\Software\Freeware\Visual PinMame\globals` → `nvram_directory`), then `VPinMAME\nvram`
 * beside the running VPX exe. The registry is read through an injectable `RegistryReader`; the
 * real one shells out to `reg query` so nothing here needs a native module, and tests use a fake.
 */
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { isNotFound, type WitnessFs } from './fs.js';

export const VPM_GLOBALS_KEY = 'HKCU\\Software\\Freeware\\Visual PinMame\\globals';
export const NVRAM_DIRECTORY_VALUE = 'nvram_directory';

export interface RegistryReader {
  /** The string data of `value` under `key`, or null when the key/value is absent or unreadable. */
  queryValue(key: string, value: string): Promise<string | null>;
}

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
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    const m = /^(\S.*?)\s{2,}(REG_[A-Z_]+)\s{2,}(.*)$/.exec(line) ?? /^(\S+)\s+(REG_[A-Z_]+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const [, name, type, data] = m;
    if (!name || name.toLowerCase() !== wanted) continue;
    if (type !== 'REG_SZ' && type !== 'REG_EXPAND_SZ') continue;
    const text = (data ?? '').trim();
    return text.length > 0 ? text : null;
  }
  return null;
}

/** Real reader: `reg.exe query`. Never throws; any failure reads as "not found". */
export function createRegQueryReader(exec: ExecFileLike = execFile as unknown as ExecFileLike): RegistryReader {
  return {
    queryValue(key, value) {
      return new Promise((resolve) => {
        try {
          exec('reg', ['query', key, '/v', value], (error, stdout) => {
            resolve(error ? null : parseRegQuery(stdout ?? '', value));
          });
        } catch {
          resolve(null);
        }
      });
    },
  };
}

/** A reader for tests and for platforms without a registry. */
export function createStaticRegistry(values: Record<string, string>): RegistryReader {
  return {
    async queryValue(key, value) {
      return values[`${key}\\${value}`.toLowerCase()] ?? null;
    },
  };
}

/** The VPX installation root for a running exe: the exe's directory. */
export function vpxRootFromExe(exe: string): string {
  return dirname(exe);
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
    const candidate = join(vpxRootFromExe(opts.vpxExe), 'VPinMAME', 'nvram');
    if (await isDir(opts.fs, candidate)) return { dir: candidate, source: 'exe' };
  }

  return { dir: null, source: 'none' };
}
