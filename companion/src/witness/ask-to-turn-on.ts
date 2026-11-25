/**
 * A6.3 (2026-11-25): `[PlayerVR] AskToTurnOn = 1` on a rig whose OpenVR is OpenComposite. VPX 10.8.0 reads the key at
 * player start (`player.cpp`, `vrDetectionMode`: 0 VR whenever OpenVR has a runtime, the default; 1 ask; 2 off). At 1
 * it first opens OpenVR as a background application (`RenderDevice::isVRturnedOn`,
 * `VR_Init(…, VRApplication_Background)`, application type 3) to see whether a headset is on. OpenComposite refuses that
 * type ("OpenComposite DLLMain ERROR: Cannot init VR: unsupported apptype 3", a dialog at every table start), and the
 * table then opens on the desktop (ChuckRibbits 2026-11-24). 0 skips the check; both testers' rigs need it.
 *
 * Castcade says so before a table starts (Status, the Match tab, the log at each VPX start) and never writes the ini:
 * it is VPX's file, and VPX writes its own settings back over it.
 *
 * What says "OpenComposite", strongest first:
 *   1. the `openvr_api` dll beside the exe (`openvr_api64.dll`, else `openvr_api.dll`; OpenComposite's per-game install
 *      puts its own dll there under that name) carries OpenComposite's name: its own error text is in it;
 *   2. the dll is Valve's (or could not be read) and a VR sample of this PC (`vr-detect.ts`) saw VPX's OpenVR reach a
 *      runtime that is not SteamVR: VPX 10.8.0 speaks only OpenVR, so a translator sat between them (OpenComposite's
 *      system-wide install, behind Valve's dll). vr-detect only knows what it sampled from a running VPX, so this
 *      needs a game played in VR in this run: on a rig that has the problem none ever is.
 * No openvr dll beside the exe: this VPX does not open OpenVR, nothing to say.
 *
 * The value is the one VPX uses (`Settings::LoadValue`): the table's own ini over the main one, an empty value falls
 * through to the next, a non-empty one is read as `atoll` reads it; nothing set at all is VPX's default 0.
 * Reads only, through `WitnessFs`; no Electron import.
 */
import { win32 } from 'node:path';
import { isNotFound, type WitnessFs } from './fs.js';
import { defaultTableIni, iniGet, locateMainIni, MAIN_INI_NAME, parseIni } from './ini-attestation.js';
import type { VrRuntime } from './vr-detect.js';

/** VPX's `vrDetectionMode` 1, "VR Autodetect => ask to turn on". */
export const ASK_TO_TURN_ON_ASK = 1;
/** The OpenVR dll a VPX VR build loads beside its exe: the 64-bit build's name first. */
export const OPENVR_DLL_NAMES = ['openvr_api64.dll', 'openvr_api.dll'] as const;
/** No openvr_api dll is anywhere near this size; a bigger file is not read. */
export const OPENVR_DLL_MAX_BYTES = 64 * 1024 * 1024;
/** Lower-cased; found in OpenComposite's dll as ASCII or UTF-16 (its error text, its `opencomposite.ini`). */
const OPENCOMPOSITE_MARK = 'opencomposite';
const OPENCOMPOSITE_MARK_UTF16 = [...OPENCOMPOSITE_MARK].join('\0');

export type OpenVrDllKind = 'opencomposite' | 'valve' | 'none' | 'unknown';
/** Which file set the value: `-Ini`, the main ini beside the exe, the per-user one, or the table's own. */
export type AskIniKind = 'override' | 'beside-exe' | 'appdata' | 'table';

export interface AskToTurnOnFacts {
  /** The value VPX will use, or null when no file sets it (VPX's default, 0). */
  value: number | null;
  /** The file that set it; null with `value`. */
  ini: { kind: AskIniKind; path: string } | null;
  /** The openvr_api dll beside the exe and whose it is. */
  openvr: { kind: OpenVrDllKind; path: string | null };
  /** The runtime a VR sample of this PC reached (`vrRuntimeOf`), or null when none was taken or it was the monitor. */
  seenRuntime: VrRuntime | null;
}

export type AskToTurnOnReason = 'opencomposite-dll' | 'non-steamvr-runtime';

/** VPX's reading of one ini value: null when absent or empty (the next file decides), else `atoll`. */
export function vpxIniInt(value: string | null): number | null {
  if (value === null) return null;
  const v = value.trim();
  if (v === '') return null;
  const m = /^[+-]?\d+/.exec(v);
  return m ? Number.parseInt(m[0], 10) : 0;
}

/** Does this file carry OpenComposite's name (ASCII or UTF-16, any case)? Valve's openvr_api never does. */
export function hasOpenCompositeMark(bytes: Uint8Array): boolean {
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1').toLowerCase();
  return text.includes(OPENCOMPOSITE_MARK) || text.includes(OPENCOMPOSITE_MARK_UTF16);
}

/** The decision: why this start will fail in the headset, or null when it will not (or Castcade cannot tell). */
export function askToTurnOnRisk(f: Pick<AskToTurnOnFacts, 'value' | 'openvr' | 'seenRuntime'>): AskToTurnOnReason | null {
  if (f.value !== ASK_TO_TURN_ON_ASK) return null;
  if (f.openvr.kind === 'opencomposite') return 'opencomposite-dll';
  if (f.openvr.kind === 'none') return null;
  if (f.seenRuntime !== null && f.seenRuntime !== 'steamvr') return 'non-steamvr-runtime';
  return null;
}

/** Where the player changes it, in words: the file that set the 1. */
function iniWhere(ini: AskToTurnOnFacts['ini'], exe: string): string {
  const exeName = win32.basename(exe);
  switch (ini?.kind) {
    case 'appdata':
      return `${MAIN_INI_NAME} in %APPDATA%\\VPinballX`;
    case 'override':
      return `${ini.path} (the -Ini file VPX is started with)`;
    case 'table':
      return `${win32.basename(ini.path)} (this table's own settings, beside the table file)`;
    default:
      return `${MAIN_INI_NAME} (the file beside ${exeName})`;
  }
}

/** The one sentence for Status, the Match tab and the log; null when there is nothing to say. */
export function askToTurnOnWarning(f: AskToTurnOnFacts, exe: string): string | null {
  const reason = askToTurnOnRisk(f);
  if (!reason) return null;
  const will = reason === 'opencomposite-dll' ? 'will' : 'is likely to';
  return `VPX ${will} show an OpenComposite error and start on the desktop: set AskToTurnOn = 0 under [PlayerVR] in ${iniWhere(f.ini, exe)}, with VPX closed.`;
}

/** The evidence, for the log line after the sentence. */
export function describeAskToTurnOn(f: AskToTurnOnFacts): string {
  const ini = f.ini ? `AskToTurnOn ${f.value} from ${f.ini.path}` : 'AskToTurnOn not set (VPX: 0)';
  const dll = f.openvr.path ? `${f.openvr.path} is ${f.openvr.kind === 'opencomposite' ? "OpenComposite's" : f.openvr.kind === 'valve' ? "Valve's" : 'unreadable'}` : 'no openvr_api dll beside the exe';
  const seen = f.seenRuntime ? `, VR last seen through ${f.seenRuntime}` : '';
  return `${ini}; ${dll}${seen}`;
}

/** What the dll classification remembers per file, so a start reads the dll again only when it changed. */
export type OpenVrDllCache = Map<string, { size: number; mtimeMs: number; kind: 'opencomposite' | 'valve' }>;

/** The openvr_api dll beside the exe, and whose it is. Never throws. */
export async function classifyOpenVrDll(fs: WitnessFs, exe: string, cache?: OpenVrDllCache): Promise<AskToTurnOnFacts['openvr']> {
  const dir = win32.dirname(exe);
  for (const name of OPENVR_DLL_NAMES) {
    const path = win32.join(dir, name);
    let st: { size: number; mtimeMs: number };
    try {
      st = await fs.stat(path);
    } catch (e) {
      if (isNotFound(e)) continue;
      return { kind: 'unknown', path };
    }
    const hit = cache?.get(path.toLowerCase());
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return { kind: hit.kind, path };
    if (st.size > OPENVR_DLL_MAX_BYTES) return { kind: 'unknown', path };
    try {
      const kind = hasOpenCompositeMark(await fs.readFile(path)) ? 'opencomposite' : 'valve';
      cache?.set(path.toLowerCase(), { size: st.size, mtimeMs: st.mtimeMs, kind });
      return { kind, path };
    } catch {
      return { kind: 'unknown', path };
    }
  }
  return { kind: 'none', path: null };
}

async function readText(fs: WitnessFs, path: string): Promise<string | null> {
  try {
    return new TextDecoder().decode(await fs.readFile(path));
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

export interface ReadAskToTurnOnInput {
  fs: WitnessFs;
  exe: string;
  /** `-Ini <path>` from VPX's command line, when known. */
  iniPath?: string | null;
  /** The table about to play, when known: its own ini is read over the main one. */
  tablePath?: string | null;
  /** `-TableIni <path>` from VPX's command line, when known. */
  tableIniPath?: string | null;
  env?: NodeJS.ProcessEnv;
  seenRuntime?: VrRuntime | null;
  cache?: OpenVrDllCache;
}

/** The facts for one exe (and table). A file that cannot be read counts as one that does not set the key. */
export async function readAskToTurnOn(input: ReadAskToTurnOnInput): Promise<AskToTurnOnFacts> {
  const { fs, exe } = input;
  const openvr = await classifyOpenVrDll(fs, exe, input.cache);
  const seenRuntime = input.seenRuntime ?? null;

  const tableCandidates = [input.tableIniPath ?? null, input.tablePath ? defaultTableIni(input.tablePath) : null].filter((p): p is string => p !== null);
  for (const path of tableCandidates) {
    const text = await readText(fs, path).catch(() => null);
    if (text === null) continue;
    const value = vpxIniInt(iniGet(parseIni(text), 'PlayerVR', 'AskToTurnOn'));
    if (value !== null) return { value, ini: { kind: 'table', path }, openvr, seenRuntime };
    break; // VPX reads one table ini: the first that exists
  }

  const main = await locateMainIni({ fs, exe, override: input.iniPath ?? null, env: input.env }).catch(() => null);
  if (main) {
    const text = await readText(fs, main).catch(() => null);
    const value = text === null ? null : vpxIniInt(iniGet(parseIni(text), 'PlayerVR', 'AskToTurnOn'));
    if (value !== null) {
      const kind: AskIniKind =
        input.iniPath && main === input.iniPath ? 'override' : main.toLowerCase() === win32.join(win32.dirname(exe), MAIN_INI_NAME).toLowerCase() ? 'beside-exe' : 'appdata';
      return { value, ini: { kind, path: main }, openvr, seenRuntime };
    }
  }
  return { value: null, ini: null, openvr, seenRuntime };
}
