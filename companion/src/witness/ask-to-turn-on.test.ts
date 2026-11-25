import { describe, expect, it } from 'vitest';
import {
  askToTurnOnRisk,
  askToTurnOnWarning,
  classifyOpenVrDll,
  describeAskToTurnOn,
  hasOpenCompositeMark,
  readAskToTurnOn,
  vpxIniInt,
  type AskToTurnOnFacts,
  type OpenVrDllCache,
  type OpenVrDllKind,
} from './ask-to-turn-on.js';
import { MemoryFs, type WitnessFs } from './fs.js';
import type { VrRuntime } from './vr-detect.js';

const EXE = 'C:\\VPX\\VPinballX_GL64.exe';
const BESIDE = 'C:\\VPX\\VPinballX.ini';
const APPDATA = 'C:\\Users\\p\\AppData\\Roaming';
const PER_USER = `${APPDATA}\\VPinballX\\VPinballX.ini`;
const TABLE = 'C:\\Tables\\No Fear (Williams 1995).vpx';
const TABLE_INI = 'C:\\Tables\\No Fear (Williams 1995).ini';
const DLL64 = 'C:\\VPX\\openvr_api64.dll';
const DLL32 = 'C:\\VPX\\openvr_api.dll';
const env = { APPDATA };

/** Stand-ins for the two dlls: OpenComposite's carries its own error text, Valve's never names it. */
const ocDll = (): Uint8Array => new TextEncoder().encode('MZ\0\0 ... OpenComposite DLLMain ERROR: Cannot init VR: unsupported apptype %d ...');
const valveDll = (): Uint8Array => new TextEncoder().encode('MZ\0\0 ... VR_InitInternal2 VR_IsHmdPresent vrclient_x64.dll SteamVR ...');
const utf16 = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, 'utf16le'));

const SENTENCE_BESIDE =
  'VPX will show an OpenComposite error and start on the desktop: set AskToTurnOn = 0 under [PlayerVR] in VPinballX.ini (the file beside VPinballX_GL64.exe), with VPX closed.';

describe('A6.3: AskToTurnOn = 1 on an OpenComposite rig', () => {
  it('reads a value the way VPX does: empty or absent falls through, a number is its integer part, anything else is 0', () => {
    expect(vpxIniInt(null)).toBeNull();
    expect(vpxIniInt('')).toBeNull();
    expect(vpxIniInt('  ')).toBeNull();
    expect(vpxIniInt('1')).toBe(1);
    expect(vpxIniInt('1.000000')).toBe(1);
    expect(vpxIniInt('2')).toBe(2);
    expect(vpxIniInt('+1')).toBe(1);
    expect(vpxIniInt('yes')).toBe(0);
  });

  it("tells OpenComposite's dll from Valve's by OpenComposite's name inside it, ASCII or UTF-16, any case", () => {
    expect(hasOpenCompositeMark(ocDll())).toBe(true);
    expect(hasOpenCompositeMark(new TextEncoder().encode('xx opencomposite.ini xx'))).toBe(true);
    expect(hasOpenCompositeMark(utf16('Software\\OpenComposite'))).toBe(true);
    expect(hasOpenCompositeMark(valveDll())).toBe(false);
    expect(hasOpenCompositeMark(new Uint8Array())).toBe(false);
  });

  const cases: Array<[number | null, OpenVrDllKind, VrRuntime | null, ReturnType<typeof askToTurnOnRisk>]> = [
    // OpenComposite's dll beside the exe: only 1 fails; 0 (and unset, VPX's 0) and 2 (VR off) do not.
    [1, 'opencomposite', null, 'opencomposite-dll'],
    [1, 'opencomposite', 'steamvr', 'opencomposite-dll'],
    [0, 'opencomposite', null, null],
    [null, 'opencomposite', null, null],
    [2, 'opencomposite', 'virtual-desktop', null],
    // Valve's dll (or one that could not be read): OpenVR goes to the registered runtime; only a VR sample says which.
    [1, 'valve', null, null],
    [1, 'valve', 'steamvr', null],
    [1, 'valve', 'virtual-desktop', 'non-steamvr-runtime'],
    [1, 'valve', 'oculus', 'non-steamvr-runtime'],
    [1, 'valve', 'openxr-other', 'non-steamvr-runtime'],
    [0, 'valve', 'virtual-desktop', null],
    [1, 'unknown', null, null],
    [1, 'unknown', 'virtual-desktop', 'non-steamvr-runtime'],
    // No openvr dll beside the exe: this VPX never opens OpenVR.
    [1, 'none', 'virtual-desktop', null],
  ];
  it.each(cases)('AskToTurnOn %s, openvr dll %s, VR seen through %s → %s', (value, kind, seenRuntime, want) => {
    expect(askToTurnOnRisk({ value, openvr: { kind, path: kind === 'none' ? null : DLL64 }, seenRuntime })).toBe(want);
  });

  it('the sentence names the fix and the file that set the 1', () => {
    const facts = (ini: AskToTurnOnFacts['ini'], kind: OpenVrDllKind = 'opencomposite', seenRuntime: VrRuntime | null = null): AskToTurnOnFacts => ({ value: 1, ini, openvr: { kind, path: DLL64 }, seenRuntime });
    expect(askToTurnOnWarning(facts({ kind: 'beside-exe', path: BESIDE }), EXE)).toBe(SENTENCE_BESIDE);
    expect(askToTurnOnWarning(facts({ kind: 'appdata', path: PER_USER }), EXE)).toBe(
      'VPX will show an OpenComposite error and start on the desktop: set AskToTurnOn = 0 under [PlayerVR] in VPinballX.ini in %APPDATA%\\VPinballX, with VPX closed.',
    );
    expect(askToTurnOnWarning(facts({ kind: 'override', path: 'D:\\Cab\\vr.ini' }), EXE)).toBe(
      'VPX will show an OpenComposite error and start on the desktop: set AskToTurnOn = 0 under [PlayerVR] in D:\\Cab\\vr.ini (the -Ini file VPX is started with), with VPX closed.',
    );
    expect(askToTurnOnWarning(facts({ kind: 'table', path: TABLE_INI }), EXE)).toBe(
      "VPX will show an OpenComposite error and start on the desktop: set AskToTurnOn = 0 under [PlayerVR] in No Fear (Williams 1995).ini (this table's own settings, beside the table file), with VPX closed.",
    );
    // Inferred from the runtime VPX reached, not read from the dll: "is likely to".
    expect(askToTurnOnWarning(facts({ kind: 'beside-exe', path: BESIDE }, 'valve', 'virtual-desktop'), EXE)).toBe(
      'VPX is likely to show an OpenComposite error and start on the desktop: set AskToTurnOn = 0 under [PlayerVR] in VPinballX.ini (the file beside VPinballX_GL64.exe), with VPX closed.',
    );
    expect(askToTurnOnWarning({ value: 0, ini: { kind: 'beside-exe', path: BESIDE }, openvr: { kind: 'opencomposite', path: DLL64 }, seenRuntime: null }, EXE)).toBeNull();
    expect(describeAskToTurnOn(facts({ kind: 'beside-exe', path: BESIDE }))).toBe(`AskToTurnOn 1 from ${BESIDE}; ${DLL64} is OpenComposite's`);
  });

  it("reads the rig: OpenComposite's dll and the ini beside the exe, which wins over the per-user one", async () => {
    const fs = new MemoryFs();
    fs.put(DLL64, ocDll());
    fs.put(PER_USER, '[PlayerVR]\nAskToTurnOn = 0\n');
    let f = await readAskToTurnOn({ fs, exe: EXE, env });
    expect(f).toEqual({ value: 0, ini: { kind: 'appdata', path: PER_USER }, openvr: { kind: 'opencomposite', path: DLL64 }, seenRuntime: null });
    expect(askToTurnOnWarning(f, EXE)).toBeNull();

    fs.put(BESIDE, '[Player]\nStereo3D = 0\n[PlayerVR]\r\nAskToTurnOn = 1\r\nVRPreview = 1\r\n');
    f = await readAskToTurnOn({ fs, exe: EXE, env });
    expect(f.ini).toEqual({ kind: 'beside-exe', path: BESIDE });
    expect(askToTurnOnWarning(f, EXE)).toBe(SENTENCE_BESIDE);

    // VPX's shipped ini leaves the key empty: VPX's default 0, nothing to say.
    fs.put(BESIDE, '[PlayerVR]\nAskToTurnOn = \n');
    f = await readAskToTurnOn({ fs, exe: EXE, env });
    expect(f).toMatchObject({ value: null, ini: null });
    expect(askToTurnOnWarning(f, EXE)).toBeNull();
  });

  it("-Ini on the command line, and a table's own ini over the main one, as VPX layers them", async () => {
    const fs = new MemoryFs();
    fs.put(DLL64, ocDll());
    fs.put(BESIDE, '[PlayerVR]\nAskToTurnOn = 0\n');
    fs.put('D:\\Cab\\vr.ini', '[PlayerVR]\nAskToTurnOn = 1\n');
    expect((await readAskToTurnOn({ fs, exe: EXE, env, iniPath: 'D:\\Cab\\vr.ini' })).ini).toEqual({ kind: 'override', path: 'D:\\Cab\\vr.ini' });

    // The table's 1 over the main 0.
    fs.put(TABLE_INI, '[PlayerVR]\nAskToTurnOn = 1\n');
    let f = await readAskToTurnOn({ fs, exe: EXE, env, tablePath: TABLE });
    expect(f).toMatchObject({ value: 1, ini: { kind: 'table', path: TABLE_INI } });
    // An empty value in the table's ini falls through to the main one.
    fs.put(TABLE_INI, '[PlayerVR]\nAskToTurnOn =\n[TableOverride]\nDifficulty = 0.5\n');
    f = await readAskToTurnOn({ fs, exe: EXE, env, tablePath: TABLE });
    expect(f).toMatchObject({ value: 0, ini: { kind: 'beside-exe', path: BESIDE } });
    // The table's 0 over the main 1.
    fs.put(BESIDE, '[PlayerVR]\nAskToTurnOn = 1\n');
    fs.put(TABLE_INI, '[PlayerVR]\nAskToTurnOn = 0\n');
    expect(askToTurnOnWarning(await readAskToTurnOn({ fs, exe: EXE, env, tablePath: TABLE }), EXE)).toBeNull();
    expect(askToTurnOnWarning(await readAskToTurnOn({ fs, exe: EXE, env }), EXE)).toBe(SENTENCE_BESIDE);
  });

  it('finds the dll a VR build loads beside the exe: openvr_api64.dll first, else openvr_api.dll, else none', async () => {
    const fs = new MemoryFs();
    expect(await classifyOpenVrDll(fs, EXE)).toEqual({ kind: 'none', path: null });
    fs.put(DLL32, ocDll());
    expect(await classifyOpenVrDll(fs, EXE)).toEqual({ kind: 'opencomposite', path: DLL32 });
    fs.put(DLL64, valveDll());
    expect(await classifyOpenVrDll(fs, EXE)).toEqual({ kind: 'valve', path: DLL64 });
  });

  it('reads a dll once per version of the file; one it cannot read, or far too big, is unknown', async () => {
    const mem = new MemoryFs();
    let reads = 0;
    let statError: Error | null = null;
    let size: number | null = null;
    const fs: WitnessFs = {
      readFile: (p) => {
        reads++;
        return mem.readFile(p);
      },
      stat: async (p) => {
        if (statError) throw statError;
        const st = await mem.stat(p);
        return size === null ? st : { ...st, size };
      },
      writeFile: (p, d) => mem.writeFile(p, d),
      readdir: (d) => mem.readdir(d),
      mkdir: (d) => mem.mkdir(d),
      rename: (a, b) => mem.rename(a, b),
      unlink: (p) => mem.unlink(p),
      open: (p) => mem.open(p),
    };
    const cache: OpenVrDllCache = new Map();
    mem.put(DLL64, ocDll(), 1000);
    expect((await classifyOpenVrDll(fs, EXE, cache)).kind).toBe('opencomposite');
    expect((await classifyOpenVrDll(fs, EXE, cache)).kind).toBe('opencomposite');
    expect(reads).toBe(1);
    mem.put(DLL64, valveDll(), 2000); // the player put Valve's back
    expect((await classifyOpenVrDll(fs, EXE, cache)).kind).toBe('valve');
    expect(reads).toBe(2);

    statError = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    expect(await classifyOpenVrDll(fs, EXE, cache)).toEqual({ kind: 'unknown', path: DLL64 });
    statError = null;
    size = 200 * 1024 * 1024;
    expect(await classifyOpenVrDll(fs, EXE)).toEqual({ kind: 'unknown', path: DLL64 });
  });
});
