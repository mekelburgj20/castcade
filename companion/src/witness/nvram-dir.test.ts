import { describe, expect, it } from 'vitest';
import { MemoryFs } from './fs.js';
import { createRegQueryReader, createStaticRegistry, expandEnvVars, NVRAM_DIRECTORY_VALUE, parseRegQuery, resolveNvramDir, VPM_GLOBALS_KEY, vpxRootFromExe } from './nvram-dir.js';

const REG_OUT = `
HKEY_CURRENT_USER\\Software\\Freeware\\Visual PinMame\\globals
    nvram_directory    REG_SZ    C:\\Visual Pinball\\VPinMAME\\nvram
    rompath    REG_SZ    C:\\Visual Pinball\\VPinMAME\\roms

`;

describe('registry parsing', () => {
  it('extracts a REG_SZ value with spaces in its data', () => {
    expect(parseRegQuery(REG_OUT, 'nvram_directory')).toBe('C:\\Visual Pinball\\VPinMAME\\nvram');
    expect(parseRegQuery(REG_OUT, 'NVRAM_DIRECTORY')).toBe('C:\\Visual Pinball\\VPinMAME\\nvram');
    expect(parseRegQuery(REG_OUT, 'rompath')).toBe('C:\\Visual Pinball\\VPinMAME\\roms');
    expect(parseRegQuery(REG_OUT, 'cfg_directory')).toBeNull();
    expect(parseRegQuery('ERROR: The system was unable to find the specified registry key or value.', 'nvram_directory')).toBeNull();
    expect(parseRegQuery('    nvram_directory    REG_DWORD    0x1', 'nvram_directory')).toBeNull();
  });

  it('createRegQueryReader runs reg query and tolerates failure', async () => {
    const calls: string[][] = [];
    const ok = createRegQueryReader((file, args, cb) => {
      calls.push([file, ...args]);
      cb(null, REG_OUT, '');
    });
    expect(await ok.queryValue(VPM_GLOBALS_KEY, NVRAM_DIRECTORY_VALUE)).toBe('C:\\Visual Pinball\\VPinMAME\\nvram');
    expect(calls[0]).toEqual(['reg', 'query', VPM_GLOBALS_KEY, '/v', NVRAM_DIRECTORY_VALUE]);
    const failing = createRegQueryReader((_f, _a, cb) => cb(new Error('exit 1'), '', 'ERROR'));
    expect(await failing.queryValue(VPM_GLOBALS_KEY, NVRAM_DIRECTORY_VALUE)).toBeNull();
    const throwing = createRegQueryReader(() => {
      throw new Error('ENOENT reg');
    });
    expect(await throwing.queryValue(VPM_GLOBALS_KEY, NVRAM_DIRECTORY_VALUE)).toBeNull();
  });

  it('expands %VAR% references', () => {
    expect(expandEnvVars('%LOCALAPPDATA%\\VPinMAME\\nvram', { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' })).toBe('C:\\Users\\me\\AppData\\Local\\VPinMAME\\nvram');
    expect(expandEnvVars('%NOPE%\\x', {})).toBe('%NOPE%\\x');
  });
});

describe('resolveNvramDir', () => {
  const registry = createStaticRegistry({ [`${VPM_GLOBALS_KEY}\\${NVRAM_DIRECTORY_VALUE}`.toLowerCase()]: 'C:\\VPM\\nvram' });

  it('prefers the override, then the registry, then the exe-relative folder', async () => {
    const fs = new MemoryFs();
    await fs.mkdir('C:\\VPM\\nvram');
    await fs.mkdir('C:\\VPX\\VPinMAME\\nvram');
    expect(await resolveNvramDir({ override: 'D:\\mine ', registry, vpxExe: 'C:\\VPX\\VPinballX64.exe', fs })).toEqual({ dir: 'D:\\mine', source: 'override' });
    expect(await resolveNvramDir({ override: null, registry, vpxExe: 'C:\\VPX\\VPinballX64.exe', fs })).toEqual({ dir: 'C:\\VPM\\nvram', source: 'registry' });
    const noReg = createStaticRegistry({});
    const fromExe = await resolveNvramDir({ override: '', registry: noReg, vpxExe: 'C:\\VPX\\VPinballX64.exe', fs });
    expect(fromExe.source).toBe('exe');
    expect(fromExe.dir?.replace(/\//g, '\\')).toBe('C:\\VPX\\VPinMAME\\nvram');
    expect(await resolveNvramDir({ override: null, registry: noReg, vpxExe: null, fs })).toEqual({ dir: null, source: 'none' });
  });

  it('skips a registry directory that does not exist', async () => {
    const fs = new MemoryFs();
    await fs.mkdir('C:\\VPX\\VPinMAME\\nvram');
    const r = await resolveNvramDir({ override: null, registry, vpxExe: 'C:\\VPX\\VPinballX64.exe', fs });
    expect(r.source).toBe('exe');
  });

  it('vpxRootFromExe is the exe directory', () => {
    expect(vpxRootFromExe('C:\\Games\\VPX\\VPinballX64.exe').replace(/\//g, '\\')).toBe('C:\\Games\\VPX');
  });
});
