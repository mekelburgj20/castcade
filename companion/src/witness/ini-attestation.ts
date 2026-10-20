/**
 * Settings attestation (F2): what VPX 10.8.0 will apply to a table from its ini files, read the way
 * VPX itself resolves them (verified against `main.cpp`, `pintable.cpp`/`pintable.h` and
 * `Settings.cpp` at v10.8.0-2051):
 *
 * - the global ini is `-Ini <path>` when given, else `<exe dir>\VPinballX.ini` when that file exists
 *   (portable install), else `%APPDATA%\VPinballX\VPinballX.ini`;
 * - the per-table ini is `-TableIni <path>` when given and present, else `<table>.ini` beside the
 *   `.vpx`; its values sit on top of the global ini (a lookup falls through to the parent);
 * - the physics-set override is a property of the *table file* (`ORRP`, flippers `ORPF`), not an ini
 *   key: the ini only holds the eight sets' values (`TablePhysics*N`, `FlipperPhysics*N`,
 *   `PhysicsSetName N`, 0-based);
 * - the player's difficulty override is `[TableOverride] Difficulty` (0–1), written by the tweak menu;
 * - the 10.8 table options the author exposed live in `[TableOption]` under the author's names.
 *
 * Pure parsing plus a few file reads through `WitnessFs`; nothing here writes.
 */
import { win32 as winPath } from 'node:path';
import type { IniAttestation, NudgeSettings, PhysicsSetValues } from './attestation-types.js';
import { isNotFound, type WitnessFs } from './fs.js';
import type { VpxTablePhysics } from './identity-types.js';

export const MAIN_INI_NAME = 'VPinballX.ini';

/** Parsed ini: section (lower-cased) → entries in file order, keys with their original spelling. */
export type IniData = Map<string, { key: string; value: string }[]>;

export function parseIni(text: string): IniData {
  const data: IniData = new Map();
  let section = '';
  // Strip a UTF-8 BOM (U+FEFF) if the editor left one.
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const sec = /^\[(.+)\]$/.exec(line);
    if (sec) {
      section = (sec[1] ?? '').trim().toLowerCase();
      if (!data.has(section)) data.set(section, []);
      continue;
    }
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (!data.has(section)) data.set(section, []);
    data.get(section)!.push({ key, value });
  }
  return data;
}

/** Case-insensitive lookup; the last occurrence wins, as it does for VPX's own reader. */
export function iniGet(data: IniData | null, section: string, key: string): string | null {
  const entries = data?.get(section.toLowerCase());
  if (!entries) return null;
  const k = key.toLowerCase();
  let found: string | null = null;
  for (const e of entries) if (e.key.toLowerCase() === k) found = e.value;
  return found;
}

export function iniEntries(data: IniData | null, section: string): { key: string; value: string }[] {
  return data?.get(section.toLowerCase()) ?? [];
}

export function iniNumber(data: IniData | null, section: string, key: string): number | null {
  const v = iniGet(data, section, key);
  if (v === null) return null;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

export function iniBool(data: IniData | null, section: string, key: string): boolean | null {
  const v = iniGet(data, section, key);
  if (v === null) return null;
  const t = v.toLowerCase();
  if (t === '1' || t === 'true' || t === 'yes') return true;
  if (t === '0' || t === 'false' || t === 'no') return false;
  const n = Number.parseFloat(t);
  return Number.isFinite(n) ? n !== 0 : null;
}

// -------------------------------------------------------------------------------- locations --

async function fileExists(fs: WitnessFs, path: string): Promise<boolean> {
  try {
    await fs.stat(path);
    return true;
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
}

async function readText(fs: WitnessFs, path: string): Promise<string | null> {
  try {
    return new TextDecoder().decode(await fs.readFile(path));
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

export interface LocateMainIniOptions {
  fs: WitnessFs;
  exe: string;
  /** `-Ini <path>` from the command line, if any. */
  override?: string | null;
  env?: NodeJS.ProcessEnv;
}

/** The global ini VPX uses for this exe, or null when none exists anywhere. */
export async function locateMainIni(opts: LocateMainIniOptions): Promise<string | null> {
  const { fs, exe } = opts;
  if (opts.override && (await fileExists(fs, opts.override))) return opts.override;
  const portable = winPath.join(winPath.dirname(exe), MAIN_INI_NAME);
  if (await fileExists(fs, portable)) return portable;
  const appData = (opts.env ?? process.env)['APPDATA'];
  if (appData) {
    const perUser = winPath.join(appData, 'VPinballX', MAIN_INI_NAME);
    if (await fileExists(fs, perUser)) return perUser;
  }
  return null;
}

/** `<table>.ini` beside the table file (VPX's `GetSettingsFileName`). */
export function defaultTableIni(tablePath: string): string {
  return tablePath.replace(/\.[^\\/.]+$/, '') + '.ini';
}

// ------------------------------------------------------------------------------- attestation --

const TABLE_SET_KEYS: Record<keyof PhysicsSetValues, string> = {
  gravity: 'TablePhysicsGravityConstant',
  contactFriction: 'TablePhysicsContactFriction',
  elasticity: 'TablePhysicsElasticity',
  elasticityFalloff: 'TablePhysicsElasticityFalloff',
  scatterAngle: 'TablePhysicsScatterAngle',
  contactScatterAngle: 'TablePhysicsContactScatterAngle',
  minSlope: 'TablePhysicsMinSlope',
  maxSlope: 'TablePhysicsMaxSlope',
};

const FLIPPER_SET_KEYS = ['Mass', 'Strength', 'Elasticity', 'Scatter', 'EOSTorque', 'EOSTorqueAngle', 'ReturnStrength', 'ElasticityFalloff', 'Friction', 'CoilRampUp'];

/** A value as VPX's layered settings see it: the table ini first, then the global ini. */
function layered(table: IniData | null, main: IniData | null, section: string, key: string): string | null {
  return iniGet(table, section, key) ?? iniGet(main, section, key);
}

function layeredNumber(table: IniData | null, main: IniData | null, section: string, key: string): number | null {
  const v = layered(table, main, section, key);
  if (v === null) return null;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function layeredBool(table: IniData | null, main: IniData | null, section: string, key: string): boolean | null {
  const v = layered(table, main, section, key);
  if (v === null) return null;
  const t = v.toLowerCase();
  if (t === '1' || t === 'true') return true;
  if (t === '0' || t === 'false') return false;
  const n = Number.parseFloat(t);
  return Number.isFinite(n) ? n !== 0 : null;
}

export function physicsSetFrom(table: IniData | null, main: IniData | null, set: number): PhysicsSetValues {
  const idx = String(set - 1);
  const out = {} as PhysicsSetValues;
  for (const [field, key] of Object.entries(TABLE_SET_KEYS) as [keyof PhysicsSetValues, string][]) {
    out[field] = layeredNumber(table, main, 'Player', key + idx);
  }
  return out;
}

export function flipperSetFrom(table: IniData | null, main: IniData | null, set: number): Record<string, number> {
  const idx = String(set - 1);
  const out: Record<string, number> = {};
  for (const k of FLIPPER_SET_KEYS) {
    const v = layeredNumber(table, main, 'Player', `FlipperPhysics${k}${idx}`);
    if (v !== null) out[k] = v;
  }
  return out;
}

export interface IniAttestationInput {
  fs: WitnessFs;
  exe: string;
  /** `-Ini <path>` from the command line, if any. */
  iniPath?: string | null;
  /** The table file; null when the companion never found it (then only the global ini is read). */
  tablePath: string | null;
  /** `-TableIni <path>` from the command line, if any. */
  tableIniPath?: string | null;
  /** The table file's own physics (slope, difficulty, override set), when read. */
  physics: VpxTablePhysics | null;
  env?: NodeJS.ProcessEnv;
}

/** Read the settings in force for a table. Never throws for missing files; other errors become notes. */
export async function readIniAttestation(input: IniAttestationInput): Promise<IniAttestation> {
  const { fs } = input;
  const notes: string[] = [];

  let mainPath: string | null = null;
  let main: IniData | null = null;
  try {
    mainPath = await locateMainIni({ fs, exe: input.exe, override: input.iniPath ?? null, env: input.env });
    if (mainPath) {
      const text = await readText(fs, mainPath);
      main = text === null ? null : parseIni(text);
    } else notes.push('no VPinballX.ini found beside the exe or under %APPDATA%');
  } catch (err) {
    notes.push(`could not read VPinballX.ini: ${err instanceof Error ? err.message : String(err)}`);
  }

  let tablePath: string | null = null;
  let table: IniData | null = null;
  try {
    const candidates = [input.tableIniPath ?? null, input.tablePath ? defaultTableIni(input.tablePath) : null].filter((p): p is string => p !== null);
    for (const c of candidates) {
      const text = await readText(fs, c);
      if (text !== null) {
        tablePath = c;
        table = parseIni(text);
        break;
      }
    }
  } catch (err) {
    notes.push(`could not read the table ini: ${err instanceof Error ? err.message : String(err)}`);
  }

  const physics = input.physics;
  const set = physics?.overridePhysicsSet ?? null;
  const flippers = physics?.overridePhysicsFlippers ?? null;
  const setActive = set !== null && set > 0;
  const setValues = setActive ? physicsSetFrom(table, main, set) : null;
  const setName = setActive ? layered(table, main, 'Player', `PhysicsSetName${set - 1}`) : null;
  const flipperValues = setActive && flippers ? flipperSetFrom(table, main, set) : null;
  if (physics === null) notes.push('table file not read: physics override and difficulty unknown');

  const tableDifficulty = physics?.difficulty ?? null;
  const difficultyOverride = layeredNumber(table, main, 'TableOverride', 'Difficulty');
  const effectiveDifficulty = difficultyOverride ?? tableDifficulty;

  const min = setActive ? (setValues?.minSlope ?? null) : (physics?.slopeMin ?? null);
  const max = setActive ? (setValues?.maxSlope ?? null) : (physics?.slopeMax ?? null);
  const slope =
    min !== null && max !== null
      ? { min, max, effective: effectiveDifficulty === null ? null : min + Math.min(1, Math.max(0, effectiveDifficulty)) * (max - min) }
      : null;

  const nudge: NudgeSettings = {
    strength: layeredNumber(table, main, 'Player', 'NudgeStrength'),
    sensitivity: layeredNumber(table, main, 'Player', 'NudgeSensitivity'),
    legacy: layeredBool(table, main, 'Player', 'EnableLegacyNudge'),
    legacyStrength: layeredNumber(table, main, 'Player', 'LegacyNudgeStrength'),
    analogGainX: layeredNumber(table, main, 'Player', 'AnalogNudgeGainX'),
    analogGainY: layeredNumber(table, main, 'Player', 'AnalogNudgeGainY'),
    filter: layeredBool(table, main, 'Player', 'EnableNudgeFilter'),
    accelEnabled: layeredBool(table, main, 'Player', 'PBWEnabled'),
    accelGainX: layeredNumber(table, main, 'Player', 'PBWAccelGainX'),
    accelGainY: layeredNumber(table, main, 'Player', 'PBWAccelGainY'),
    accelMaxX: layeredNumber(table, main, 'Player', 'PBWAccelMaxX'),
    accelMaxY: layeredNumber(table, main, 'Player', 'PBWAccelMaxY'),
    accelVelocityInput: layeredBool(table, main, 'Player', 'AccelVelocityInput'),
    tiltSensitivity: layeredNumber(table, main, 'Player', 'TiltSensitivity'),
    tiltSensitivityEffective: layeredNumber(table, main, 'Player', 'TiltSensitivity') ?? VPX_DEFAULT_TILT_SENSITIVITY,
  };

  const tableOptions: Record<string, number> = {};
  for (const e of iniEntries(table, 'TableOption')) {
    const n = Number.parseFloat(e.value);
    if (Number.isFinite(n)) tableOptions[e.key] = n;
  }
  const tableOverrides: Record<string, string> = {};
  for (const e of iniEntries(table, 'TableOverride')) if (e.key.toLowerCase() !== 'difficulty') tableOverrides[e.key] = e.value;
  const playerOverrides = iniEntries(table, 'Player').map((e) => e.key);

  return {
    mainIni: mainPath,
    tableIni: tablePath,
    physicsSet: set,
    physicsSetName: setName,
    physicsSetValues: setValues,
    physicsFlippersOverridden: flippers,
    flipperSetValues: flipperValues,
    stockPhysics: set === null ? null : set === 0 && flippers !== true,
    tableDifficulty,
    difficultyOverride,
    effectiveDifficulty,
    slope,
    nudge,
    tableOptions,
    tableOverrides,
    playerOverrides,
    notes,
  };
}

/** A one-line human summary for Status and the capture detail. */
/** `PinTable::ReadAccelerometerCalibration` loads `TiltSensitivity` with this default (10.8.0 source). */
export const VPX_DEFAULT_TILT_SENSITIVITY = 400;

export function describeIni(ini: IniAttestation): string {
  const parts: string[] = [];
  if (ini.physicsSet === null) parts.push('physics unknown');
  else if (ini.physicsSet === 0) parts.push('stock physics');
  else parts.push(`physics set ${ini.physicsSet}${ini.physicsSetName ? ` "${ini.physicsSetName}"` : ''}${ini.physicsFlippersOverridden ? ' incl. flippers' : ''}`);
  if (ini.difficultyOverride !== null) parts.push(`difficulty override ${Math.round(ini.difficultyOverride * 100)}%`);
  if (ini.slope?.effective !== null && ini.slope?.effective !== undefined) parts.push(`slope ${Math.round(ini.slope.effective * 100) / 100}°`);
  const opts = Object.keys(ini.tableOptions).length;
  if (opts > 0) parts.push(`${opts} table option${opts === 1 ? '' : 's'}`);
  if (ini.nudge.tiltSensitivity !== null) parts.push(ini.nudge.tiltSensitivity === 0 ? 'analog tilt off' : `tilt sensitivity ${ini.nudge.tiltSensitivity}`);
  return parts.join(', ');
}
