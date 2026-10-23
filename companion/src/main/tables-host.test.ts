import { describe, expect, it } from 'vitest';
import { MemoryFs } from '../witness/fs.js';
import type { WitnessSettings, WitnessStatus } from '../witness/types.js';
import type { Logger } from './log.js';
import { createTablesHost } from './tables-host.js';

const LIB_SRC = 'C:/app/resources/hook/castcade.vbs';
const silent: Logger = { file: '', debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function host(settings: Partial<WitnessSettings>, vpxExeSeen: string | null, fs: MemoryFs) {
  const s: WitnessSettings = {
    arcaidBaseUrl: 'https://arcaid.test',
    deviceId: 'd',
    deviceLabel: 'L',
    token: null,
    mapsDir: 'C:/maps',
    nvramDir: null,
    dataDir: 'C:/data',
    vpsDir: 'C:/vps',
    tablesDir: null,
    vpxExe: null,
    ...settings,
  };
  const store = { get: () => s, set: async (p: Partial<WitnessSettings>) => void Object.assign(s, p) };
  return createTablesHost({ store, witnessStatus: () => ({ vpxExe: vpxExeSeen }) as WitnessStatus, libSource: LIB_SRC, manifestDir: 'C:/data/tables', fs, log: silent });
}

describe('createTablesHost: where VPX lives (0.2.12)', () => {
  it('uses the exe seen this run, else the one remembered in settings', async () => {
    const fs = new MemoryFs();
    fs.put(LIB_SRC, new TextEncoder().encode('Dim Castcade_LibVersion : Castcade_LibVersion = "0.4.0"\n'));
    expect((await host({}, 'C:\\VPX\\VPinballX64.exe', fs).defaults())).toMatchObject({ tablesDir: 'C:\\VPX\\tables', scriptsDir: 'C:\\VPX\\scripts', vpxExe: 'C:\\VPX\\VPinballX64.exe' });
    expect((await host({ vpxExe: 'D:\\Pin\\VPinballX_GL64.exe' }, null, fs).defaults())).toMatchObject({ tablesDir: 'D:\\Pin\\tables', scriptsDir: 'D:\\Pin\\scripts' });
  });

  it('with no exe known, finds the scripts folder beside the tables folder, and says what to do when there is none', async () => {
    const fs = new MemoryFs();
    fs.put(LIB_SRC, new TextEncoder().encode('Dim Castcade_LibVersion : Castcade_LibVersion = "0.4.0"\n'));
    await fs.mkdir('C:/Games/VPX/tables');
    await fs.mkdir('C:/Games/VPX/scripts');
    const h = host({ tablesDir: 'C:/Games/VPX/tables' }, null, fs);
    expect(await h.defaults()).toMatchObject({ tablesDir: 'C:/Games/VPX/tables', scriptsDir: 'C:/Games/VPX/scripts', vpxExe: null });
    const r = await h.apply(null);
    expect(r.scriptsDir).toBe('C:/Games/VPX/scripts');
    expect(r.patched).toEqual([]); // an empty folder: nothing to patch, and the library is left alone until there is

    await fs.mkdir('C:/Elsewhere/tables');
    await expect(host({ tablesDir: 'C:/Elsewhere/tables' }, null, fs).apply(null)).rejects.toThrow(/no "scripts" folder beside C:\/Elsewhere\/tables and no VPX has run yet/);
  });
});
