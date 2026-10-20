/**
 * Build attestation (F2): which Visual Pinball executable and which VPinMAME DLL ran, by SHA-256 and
 * by the version strings in their `VS_VERSIONINFO` resource, compared with the hashes of the official
 * release builds; plus VPinMAME's per-ROM `cheat` option from the registry.
 *
 * An unknown hash is reported, never refused (people compile their own and run community VR builds);
 * ArcAid item 11 can extend the known list from consensus across devices.
 */
import { createHash } from 'node:crypto';
import { win32 as winPath } from 'node:path';
import type { BinaryAttestation, BuildAttestation, KnownBuild, PeVersion } from './attestation-types.js';
import { isNotFound, type WitnessFs } from './fs.js';
import type { RegistryReader } from './nvram-dir.js';

/**
 * Official release builds, hashed on 2026-10-19 from the GitHub release assets
 * (`vpinball/vpinball` v10.8.0-2051-28dd6c3 `Developer.VPinballX*-Release-win-*.zip`,
 * `vpinball/pinmame` v3.6.0-1227-ecd032e `VPinMAME*-win-*.zip`). Lower-case hex.
 */
export const KNOWN_BUILDS: Readonly<Record<string, KnownBuild>> = Object.freeze({
  b4155890501729e04bce840c03b125e78c3146c13a607b352b4604e6b6a44f28: { id: 'vpx-10.8.0-2051-dx-x64', label: 'Visual Pinball X 10.8.0 release (DirectX, x64)', kind: 'official' },
  b8c47fe7bcf83c2b417636e16dafd6699a46061442796746215f246a2f26e845: { id: 'vpx-10.8.0-2051-gl-x64', label: 'Visual Pinball X 10.8.0 release (OpenGL/VR, x64)', kind: 'official' },
  a745b28a2d5c9d45a412f164d4918582d1ab4c62d3a65eea672eff3a72e4eeca: { id: 'vpx-10.8.0-2051-dx-x86', label: 'Visual Pinball X 10.8.0 release (DirectX, x86)', kind: 'official' },
  bd2e07facca5c59306ea8d6e44f57b3e95847b9d887ef9a0edbc779e11696400: { id: 'vpx-10.8.0-2051-gl-x86', label: 'Visual Pinball X 10.8.0 release (OpenGL/VR, x86)', kind: 'official' },
  '0cd80bca2df4a499fe832772a3d638513c2ffb2da531dad6a618d9df49cc65fc': { id: 'vpinmame-3.6.0-1227-x64', label: 'VPinMAME 3.6.0 release (x64)', kind: 'official' },
  de79c95545452915762c956402180366b65ec558f31e41bb33432fa16b3f0e30: { id: 'vpinmame-3.6.0-1227-x86', label: 'VPinMAME 3.6.0 release (x86)', kind: 'official' },
  '69ebacabdb7e1af0533142a8456341f06e9d4b6cb3dc4649f18794be456ea8c1': { id: 'vpinmame-3.6.0-1227-sc-x64', label: 'VPinMAME 3.6.0 release (x64, -sc variant)', kind: 'official' },
});

export function knownBuildFor(sha256: string): KnownBuild | null {
  return KNOWN_BUILDS[sha256.toLowerCase()] ?? null;
}

// ------------------------------------------------------------------------------- PE version --

const utf16 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'utf16le'));

function indexOfBytes(hay: Uint8Array, needle: Uint8Array, from = 0, to = hay.length): number {
  outer: for (let i = from; i <= Math.min(to, hay.length) - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

const VS_VERSION_INFO = utf16('VS_VERSION_INFO\0');
const FIXED_FILE_INFO_SIGNATURE = 0xfeef04bd;

function readUtf16(bytes: Uint8Array, start: number, maxChars: number): string {
  let s = '';
  for (let i = 0; i < maxChars && start + 2 * i + 1 < bytes.length; i++) {
    const c = bytes[start + 2 * i]! | (bytes[start + 2 * i + 1]! << 8);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

/**
 * The version strings of a Windows PE file, found by locating its `VS_VERSIONINFO` block (the
 * `VS_VERSION_INFO` key, then `VS_FIXEDFILEINFO` and the `StringFileInfo` entries) without walking
 * the PE headers: resources are stored uncompressed, so the block is a plain byte pattern. Null when
 * the file has no version resource.
 */
export function parsePeVersion(bytes: Uint8Array): PeVersion | null {
  const key = indexOfBytes(bytes, VS_VERSION_INFO);
  if (key < 6) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const blockStart = key - 6;
  const blockLen = view.getUint16(blockStart, true);
  const blockEnd = Math.min(bytes.length, blockStart + Math.max(blockLen, 64));

  let fileVersion: string | null = null;
  for (let p = key + VS_VERSION_INFO.length; p + 16 <= blockEnd && p < key + 64; p += 2) {
    if (view.getUint32(p, true) === FIXED_FILE_INFO_SIGNATURE) {
      const ms = view.getUint32(p + 8, true);
      const ls = view.getUint32(p + 12, true);
      fileVersion = `${ms >>> 16}.${ms & 0xffff}.${ls >>> 16}.${ls & 0xffff}`;
      break;
    }
  }

  const str = (name: string): string | null => {
    const needle = utf16(name + '\0');
    let at = indexOfBytes(bytes, needle, key, blockEnd);
    while (at >= 6) {
      // Each String is `[wLength][wValueLength][wType=1][szKey][pad to 4][Value]`.
      const type = view.getUint16(at - 2, true);
      const valueChars = view.getUint16(at - 4, true);
      // The key must start a String record, not sit inside another key (e.g. "FileVersion" inside "ProductVersion" is impossible, but be strict).
      if (type === 1) {
        // Values are DWORD-aligned relative to the block, which rc.exe lays out from an aligned origin.
        const valueStart = blockStart + ((at - blockStart + needle.length + 3) & ~3);
        if (valueStart < blockEnd) return readUtf16(bytes, valueStart, Math.max(valueChars, 1)).trim() || null;
      }
      at = indexOfBytes(bytes, needle, at + 2, blockEnd);
    }
    return null;
  };

  if (fileVersion === null && indexOfBytes(bytes, utf16('StringFileInfo'), key, blockEnd) < 0) return null;
  return {
    fileVersion,
    fileVersionText: str('FileVersion'),
    productVersionText: str('ProductVersion'),
    description: str('FileDescription'),
  };
}

// ------------------------------------------------------------------------------------ files --

/** Hash and version a binary. Null when the file is missing; other errors propagate. */
export async function attestBinary(fs: WitnessFs, path: string): Promise<BinaryAttestation | null> {
  let bytes: Uint8Array;
  try {
    bytes = await fs.readFile(path);
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return { path, size: bytes.length, sha256, version: parsePeVersion(bytes), known: knownBuildFor(sha256) };
}

export const VPM_CONTROLLER_CLSID_KEY = 'HKCR\\VPinMAME.Controller\\CLSID';
export const VPM_SETTINGS_KEY = 'HKCU\\Software\\Freeware\\Visual PinMame';

/**
 * The VPinMAME DLL VPX will load: the COM registration (`VPinMAME.Controller` → CLSID →
 * `InprocServer32`), else `VPinMAME\VPinMAME64.dll` / `VPinMAME.dll` beside the exe (the usual
 * portable layout; the 64-bit exe needs the 64-bit DLL).
 */
export async function locateVpinmameDll(fs: WitnessFs, registry: RegistryReader, exe: string): Promise<string | null> {
  const clsid = await registry.queryDefault(VPM_CONTROLLER_CLSID_KEY);
  if (clsid) {
    const server = await registry.queryDefault(`HKCR\\CLSID\\${clsid}\\InprocServer32`);
    if (server) {
      try {
        await fs.stat(server);
        return server;
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
    }
  }
  const root = winPath.dirname(exe);
  const sixtyFour = /64/.test(winPath.basename(exe));
  const names = sixtyFour ? ['VPinMAME64.dll', 'VPinMAME.dll'] : ['VPinMAME.dll', 'VPinMAME64.dll'];
  for (const dir of ['VPinMAME', 'vpinmame']) {
    for (const name of names) {
      const p = winPath.join(root, dir, name);
      try {
        await fs.stat(p);
        return p;
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
    }
  }
  return null;
}

/** VPinMAME's `cheat` option for a ROM: the ROM's own key, else the `default` key; null when neither exists. */
export async function vpmCheatFlag(registry: RegistryReader, rom: string): Promise<boolean | null> {
  const own = await registry.queryNumber(`${VPM_SETTINGS_KEY}\\${rom}`, 'cheat');
  if (own !== null) return own !== 0;
  const dflt = await registry.queryNumber(`${VPM_SETTINGS_KEY}\\default`, 'cheat');
  return dflt === null ? null : dflt !== 0;
}

export interface BuildAttesterDeps {
  fs: WitnessFs;
  registry: RegistryReader;
  log?: (line: string) => void;
}

export interface BuildAttester {
  /** The exe and its DLL, hashed once per (path, size, mtime). */
  forExe(exe: string): Promise<BuildAttestation>;
}

export function createBuildAttester(deps: BuildAttesterDeps): BuildAttester {
  const cache = new Map<string, Promise<BinaryAttestation | null>>();
  const log = deps.log ?? (() => {});

  const cached = async (path: string): Promise<BinaryAttestation | null> => {
    let st: { size: number; mtimeMs: number };
    try {
      st = await deps.fs.stat(path);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
    const key = `${path.toLowerCase()}|${st.size}|${Math.floor(st.mtimeMs)}`;
    let p = cache.get(key);
    if (!p) {
      p = attestBinary(deps.fs, path);
      cache.set(key, p);
      p.catch(() => cache.delete(key));
      if (cache.size > 16) cache.delete(cache.keys().next().value as string);
    }
    return p;
  };

  return {
    async forExe(exe) {
      const notes: string[] = [];
      let vpx: BinaryAttestation | null = null;
      let vpinmame: BinaryAttestation | null = null;
      try {
        vpx = await cached(exe);
        if (!vpx) notes.push('VPX exe not readable');
      } catch (err) {
        notes.push(`VPX exe: ${err instanceof Error ? err.message : String(err)}`);
      }
      try {
        const dll = await locateVpinmameDll(deps.fs, deps.registry, exe);
        if (dll) vpinmame = await cached(dll);
        else notes.push('VPinMAME DLL not found (COM registration and VPinMAME folder beside the exe)');
      } catch (err) {
        notes.push(`VPinMAME DLL: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (vpx && !vpx.known) notes.push('VPX build is not an official 10.8.0 release build');
      if (vpinmame && !vpinmame.known) notes.push('VPinMAME build is not the official 3.6.0 release');
      log(`witness: build ${vpx?.version?.fileVersionText ?? vpx?.sha256.slice(0, 12) ?? '?'} / VPinMAME ${vpinmame?.version?.fileVersionText ?? vpinmame?.sha256.slice(0, 12) ?? '?'}`);
      return { vpx, vpinmame, notes };
    },
  };
}

export function describeBuild(b: BuildAttestation | null, cheat: boolean | null): string {
  if (!b) return 'build unknown';
  const v = b.vpx ? `VPX ${b.vpx.version?.fileVersionText ?? b.vpx.version?.fileVersion ?? b.vpx.sha256.slice(0, 12)}${b.vpx.known ? ' (official)' : ' (not an official release build)'}` : 'VPX exe unread';
  const m = b.vpinmame ? `VPinMAME ${b.vpinmame.version?.fileVersion ?? b.vpinmame.sha256.slice(0, 12)}${b.vpinmame.known ? ' (official)' : ' (not the official release)'}` : 'VPinMAME DLL not found';
  const c = cheat === null ? '' : cheat ? ', cheat ON' : ', cheat off';
  return `${v}; ${m}${c}`;
}
