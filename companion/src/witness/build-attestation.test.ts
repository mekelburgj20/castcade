import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildWire } from './attestation-types.js';
import { attestBinary, createBuildAttester, describeBuild, KNOWN_BUILDS, knownBuildFor, locateVpinmameDll, parsePeVersion, vpmCheatFlag } from './build-attestation.js';
import { MemoryFs } from './fs.js';
import { createStaticRegistry } from './nvram-dir.js';

const u16 = (n: number) => Uint8Array.from([n & 0xff, (n >> 8) & 0xff]);
const u32 = (n: number) => Uint8Array.from([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff]);
const utf16 = (s: string) => new Uint8Array(Buffer.from(s, 'utf16le'));
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const pad4 = (b: Uint8Array) => (b.length % 4 === 0 ? b : cat(b, new Uint8Array(4 - (b.length % 4))));

/** A `String` record of a `StringTable`: `[wLength][wValueLength (chars)][wType=1][szKey][pad][Value]`. */
function stringRecord(key: string, value: string): Uint8Array {
  const k = pad4(cat(u16(0), u16(0), u16(1), utf16(key + '\0')));
  const v = pad4(utf16(value + '\0'));
  const rec = cat(k, v);
  rec.set(u16(rec.length), 0);
  rec.set(u16(value.length + 1), 2);
  return rec;
}

/**
 * A `VS_VERSIONINFO` block the way rc.exe lays it out, dropped into a fake exe between random bytes.
 * The parser scans for it, so no PE headers are needed.
 */
function fakeExe(fileVersion: [number, number, number, number], strings: Record<string, string>): Uint8Array {
  const [a, b, c, d] = fileVersion;
  const fixed = cat(u32(0xfeef04bd), u32(0x00010000), u32((a << 16) | b), u32((c << 16) | d), u32((a << 16) | b), u32((c << 16) | d), new Uint8Array(28));
  const header = pad4(cat(u16(0), u16(fixed.length), u16(0), utf16('VS_VERSION_INFO\0')));
  const table = cat(...Object.entries(strings).map(([k, v]) => stringRecord(k, v)));
  const stringTable = cat(pad4(cat(u16(0), u16(0), u16(1), utf16('040904b0\0'))), table);
  const stringFileInfo = cat(pad4(cat(u16(0), u16(0), u16(1), utf16('StringFileInfo\0'))), stringTable);
  const block = cat(header, fixed, stringFileInfo);
  block.set(u16(block.length), 0);
  const noise = (n: number, seed: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 0xff);
  return cat(noise(777, 3), block, noise(513, 9));
}

const OWNER_VPX = fakeExe([10, 8, 0, 2079], { CompanyName: 'Visual Pinball', FileDescription: 'Visual Pinball 10.8.0', FileVersion: '10.8.0.2079.Panasony', ProductVersion: '10.8.0.2079.Panasony' });
const OWNER_VPM = fakeExe([3, 7, 0, 222], { FileDescription: 'COM class for PinMAME', FileVersion: '3, 7, 0, 222', ProductVersion: '3.7.0.222.8133307' });
const EXE = 'C:\\VPX\\VPinballX_GL64.exe';

describe('PE version strings', () => {
  it("reads the fixed file version and the StringFileInfo entries of the owner's builds", () => {
    expect(parsePeVersion(OWNER_VPX)).toEqual({ fileVersion: '10.8.0.2079', fileVersionText: '10.8.0.2079.Panasony', productVersionText: '10.8.0.2079.Panasony', description: 'Visual Pinball 10.8.0' });
    expect(parsePeVersion(OWNER_VPM)).toEqual({ fileVersion: '3.7.0.222', fileVersionText: '3, 7, 0, 222', productVersionText: '3.7.0.222.8133307', description: 'COM class for PinMAME' });
  });

  it('a file without a version resource yields null', () => {
    expect(parsePeVersion(new Uint8Array(4096))).toBeNull();
    expect(parsePeVersion(new TextEncoder().encode('not a PE file at all, VS_VERSION_INFO as ascii does not count'))).toBeNull();
  });
});

describe('known builds', () => {
  it('lists the official VPX 10.8.0 and VPinMAME 3.6.0 Windows builds, lower-case hex, 64 chars each', () => {
    const ids = Object.values(KNOWN_BUILDS).map((k) => k.id);
    expect(ids).toEqual(expect.arrayContaining(['vpx-10.8.0-2051-dx-x64', 'vpx-10.8.0-2051-gl-x64', 'vpx-10.8.0-2051-dx-x86', 'vpx-10.8.0-2051-gl-x86', 'vpinmame-3.6.0-1227-x64', 'vpinmame-3.6.0-1227-x86']));
    for (const h of Object.keys(KNOWN_BUILDS)) expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(knownBuildFor('B8C47FE7BCF83C2B417636E16DAFD6699A46061442796746215F246A2F26E845')?.id).toBe('vpx-10.8.0-2051-gl-x64');
    expect(knownBuildFor('00'.repeat(32))).toBeNull();
  });

  it("the owner's community build hashes clean, versions, and is reported as not an official build", async () => {
    const fs = new MemoryFs();
    fs.put(EXE, OWNER_VPX);
    const a = await attestBinary(fs, EXE);
    expect(a).toMatchObject({ path: EXE, size: OWNER_VPX.length, sha256: createHash('sha256').update(OWNER_VPX).digest('hex'), known: null });
    expect(a?.version?.fileVersionText).toBe('10.8.0.2079.Panasony');
    expect(await attestBinary(fs, 'C:\\nowhere.exe')).toBeNull();
  });
});

describe('VPinMAME DLL and cheat flag', () => {
  const registry = createStaticRegistry({
    'HKCR\\VPinMAME.Controller\\CLSID\\(Default)': '{F389C8B7-144F-4C63-A2E3-246D168F9D39}',
    'HKCR\\CLSID\\{F389C8B7-144F-4C63-A2E3-246D168F9D39}\\InprocServer32\\(Default)': 'C:\\VPX\\vpinmame\\VPinMAME64.dll',
    'HKCU\\Software\\Freeware\\Visual PinMame\\mm_109c\\cheat': '0x1',
    'HKCU\\Software\\Freeware\\Visual PinMame\\default\\cheat': '0x0',
  });

  it('finds the DLL through the COM registration, else beside the exe (64-bit first for a 64-bit exe)', async () => {
    const fs = new MemoryFs();
    expect(await locateVpinmameDll(fs, registry, EXE)).toBeNull();
    fs.put('C:\\VPX\\VPinMAME\\VPinMAME.dll', OWNER_VPM);
    expect(await locateVpinmameDll(fs, registry, EXE)).toBe('C:\\VPX\\VPinMAME\\VPinMAME.dll');
    fs.put('C:\\VPX\\VPinMAME\\VPinMAME64.dll', OWNER_VPM);
    expect(await locateVpinmameDll(fs, registry, EXE)).toBe('C:\\VPX\\VPinMAME\\VPinMAME64.dll');
    fs.put('C:\\VPX\\vpinmame\\VPinMAME64.dll', OWNER_VPM); // the registered one wins once it exists
    expect(await locateVpinmameDll(fs, registry, EXE)).toBe('C:\\VPX\\vpinmame\\VPinMAME64.dll');
  });

  it("the ROM's own cheat value, else the default key, else unknown", async () => {
    expect(await vpmCheatFlag(registry, 'mm_109c')).toBe(true);
    expect(await vpmCheatFlag(registry, 'mb_106b')).toBe(false);
    expect(await vpmCheatFlag(createStaticRegistry({}), 'mm_109c')).toBeNull();
  });

  it('the attester hashes exe and DLL once per file version and words the result', async () => {
    const fs = new MemoryFs();
    fs.put(EXE, OWNER_VPX);
    fs.put('C:\\VPX\\vpinmame\\VPinMAME64.dll', OWNER_VPM);
    const lines: string[] = [];
    const attester = createBuildAttester({ fs, registry, log: (l) => lines.push(l) });
    const b = await attester.forExe(EXE);
    expect(b.vpx?.version?.fileVersion).toBe('10.8.0.2079');
    expect(b.vpinmame?.version?.fileVersion).toBe('3.7.0.222');
    expect(b.notes).toEqual(['VPX build is not an official 10.8.0 release build', 'VPinMAME build is not the official 3.6.0 release']);
    expect(describeBuild(b, false)).toBe('VPX 10.8.0.2079.Panasony (not an official release build); VPinMAME 3.7.0.222 (not the official release), cheat off');
    expect(lines).toEqual(['witness: build 10.8.0.2079.Panasony / VPinMAME 3, 7, 0, 222']);
    const again = await attester.forExe(EXE);
    expect(again.vpx).toBe(b.vpx); // cached promise result, same object
    const wire = JSON.parse(buildWire(b, true) ?? 'null') as { vpx: { version: string; known: null }; vpinmame: { version: string }; cheat: boolean };
    expect(wire.vpx).toMatchObject({ version: '10.8.0.2079.Panasony', known: null });
    expect(wire.cheat).toBe(true);
    expect(describeBuild(null, null)).toBe('build unknown');
    expect(buildWire(null, null)).toBeNull();
  });
});
