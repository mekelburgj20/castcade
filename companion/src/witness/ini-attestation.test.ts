import { describe, expect, it } from 'vitest';
import { MemoryFs } from './fs.js';
import type { VpxTablePhysics } from './identity-types.js';
import { iniWire } from './attestation-types.js';
import { defaultTableIni, describeIni, iniGet, locateMainIni, parseIni, readIniAttestation, VPX_DEFAULT_TILT_SENSITIVITY } from './ini-attestation.js';
import { parseSwitchPath } from './process-watch.js';

const EXE = 'C:\\VPX\\VPinballX_GL64.exe';
const TABLE = 'C:\\VPX\\tables\\Monster Bash (Williams 1998) VPWmod v1.0.vpx';

/** The relevant lines of the owner's portable ini: no override key exists, set 1 is "Mousing Around". */
const MAIN_INI = `[Player]
AnalogNudgeGainX = 1965.000000
NudgeTime = 0
NudgeStrength = 0.000800
EnableLegacyNudge = 0
LegacyNudgeStrength = 0.650000
EnableNudgeFilter = 0
FlipperPhysicsStrength0 = 3100
FlipperPhysicsMass0 = 1
TablePhysicsGravityConstant0 = 0.9700001
TablePhysicsContactFriction0 = 0.35
TablePhysicsElasticity0 = 0.15
TablePhysicsElasticityFalloff0 = 0
TablePhysicsScatterAngle0 = 0
TablePhysicsContactScatterAngle0 = 2
TablePhysicsMinSlope0 = 5.5
TablePhysicsMaxSlope0 = 6
PhysicsSetName0 = Mousing Around

[TableOverride]
OverrideEmissionScale = 0
`;

const physics = (over: Partial<VpxTablePhysics> = {}): VpxTablePhysics => ({
  gravity: 1.76,
  friction: 0.2,
  elasticity: 0.25,
  elasticityFalloff: null,
  playfieldScatter: null,
  defaultScatter: null,
  nudgeTime: null,
  slopeMin: 6,
  slopeMax: 7,
  difficulty: 0.2,
  overridePhysicsSet: 0,
  overridePhysicsFlippers: false,
  ...over,
});

describe('ini parsing', () => {
  it('reads sections, keys with spaces and the last duplicate; ignores comments and a BOM', () => {
    const d = parseIni('\uFEFF; comment\n[Player]\nA = 1\n[TableOption]\nOutlane Difficulty = 1.000000\nA = 2\n# also a comment\nbroken line\n[player]\nA = 3\n');
    expect(iniGet(d, 'Player', 'a')).toBe('3');
    expect(iniGet(d, 'tableoption', 'Outlane Difficulty')).toBe('1.000000');
    expect(iniGet(d, 'TableOption', 'A')).toBe('2');
    expect(iniGet(d, 'Nope', 'A')).toBeNull();
  });

  it('finds the -Ini and -TableIni switches like -Play (quoted or running to the next switch)', () => {
    expect(parseSwitchPath(`"${EXE}" -Ini "C:\\x y\\mine.ini" -Play "${TABLE}"`, 'ini')).toBe('C:\\x y\\mine.ini');
    expect(parseSwitchPath(`"${EXE}" /tableini C:\\t\\a b.ini -Play x.vpx`, 'tableini')).toBe('C:\\t\\a b.ini');
    expect(parseSwitchPath(`"${EXE}" -Play "${TABLE}"`, 'ini')).toBeNull();
  });

  it('names the per-table ini beside the table file', () => {
    expect(defaultTableIni(TABLE)).toBe('C:\\VPX\\tables\\Monster Bash (Williams 1998) VPWmod v1.0.ini');
    expect(defaultTableIni('C:\\t\\x.VPX')).toBe('C:\\t\\x.ini');
  });
});

describe('locating VPinballX.ini', () => {
  it('prefers -Ini, then the portable ini beside the exe, then %APPDATA%', async () => {
    const fs = new MemoryFs();
    const env = { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' };
    expect(await locateMainIni({ fs, exe: EXE, env })).toBeNull();
    fs.put('C:\\Users\\me\\AppData\\Roaming\\VPinballX\\VPinballX.ini', new TextEncoder().encode('[Player]\n'));
    expect(await locateMainIni({ fs, exe: EXE, env })).toBe('C:\\Users\\me\\AppData\\Roaming\\VPinballX\\VPinballX.ini');
    fs.put('C:\\VPX\\VPinballX.ini', new TextEncoder().encode(MAIN_INI));
    expect(await locateMainIni({ fs, exe: EXE, env })).toBe('C:\\VPX\\VPinballX.ini');
    fs.put('C:\\other.ini', new TextEncoder().encode('[Player]\n'));
    expect(await locateMainIni({ fs, exe: EXE, env, override: 'C:\\other.ini' })).toBe('C:\\other.ini');
    expect(await locateMainIni({ fs, exe: EXE, env, override: 'C:\\missing.ini' })).toBe('C:\\VPX\\VPinballX.ini');
  });
});

describe('settings attestation', () => {
  it("the owner's case: portable ini, no override, table ini with only visual keys → stock physics, table difficulty", async () => {
    const fs = new MemoryFs();
    fs.put('C:\\VPX\\VPinballX.ini', new TextEncoder().encode(MAIN_INI));
    fs.put(defaultTableIni(TABLE), new TextEncoder().encode('[Player]\nBallTrailStrength = 0.490196\nOverrideTableEmissionScale = 0\n'));
    const a = await readIniAttestation({ fs, exe: EXE, tablePath: TABLE, physics: physics(), env: {} });
    expect(a).toMatchObject({
      mainIni: 'C:\\VPX\\VPinballX.ini',
      tableIni: defaultTableIni(TABLE),
      physicsSet: 0,
      physicsSetName: null,
      physicsSetValues: null,
      physicsFlippersOverridden: false,
      stockPhysics: true,
      tableDifficulty: 0.2,
      difficultyOverride: null,
      effectiveDifficulty: 0.2,
      slope: { min: 6, max: 7, effective: 6.2 },
      tableOptions: {},
      tableOverrides: {},
      playerOverrides: ['BallTrailStrength', 'OverrideTableEmissionScale'],
      notes: [],
    });
    expect(a.nudge).toMatchObject({ strength: 0.0008, legacy: false, legacyStrength: 0.65, analogGainX: 1965, filter: false, sensitivity: null });
    expect(a.nudge).toMatchObject({ accelEnabled: null, accelGainX: null, tiltSensitivity: null, tiltSensitivityEffective: VPX_DEFAULT_TILT_SENSITIVITY });
    expect(describeIni(a)).toBe('stock physics, slope 6.2°');
  });

  it('reads the accelerometer and analog-tilt keys; TiltSensitivity falls back to the VPX default when the key is absent', async () => {
    const fs = new MemoryFs();
    const ini = (tilt: string) =>
      new TextEncoder().encode(`[Player]\nPBWEnabled = 1\nPBWAccelGainX = 115\nPBWAccelGainY = 200\nPBWAccelMaxX = 100\nPBWAccelMaxY = 100\nAccelVelocityInput = 0\nEnableNudgeFilter = 1\nTiltSensCB = 1\nTiltSensValue = 500\n${tilt}`);
    fs.put('C:\\VPX\\VPinballX.ini', ini('TiltSensitivity = 250\n'));
    const a = await readIniAttestation({ fs, exe: EXE, tablePath: TABLE, physics: physics() });
    expect(a.nudge).toMatchObject({ accelEnabled: true, accelGainX: 115, accelGainY: 200, accelMaxX: 100, accelMaxY: 100, accelVelocityInput: false, filter: true, tiltSensitivity: 250, tiltSensitivityEffective: 250 });
    expect(JSON.parse(iniWire(a) ?? 'null')).toMatchObject({ accel: true, accel_gain_x: 115, accel_gain_y: 200, accel_max_x: 100, accel_max_y: 100, accel_velocity: false, nudge_filter: true, tilt_sens: 250, tilt_sens_set: true });
    expect(describeIni(a)).toBe('stock physics, slope 6.2°, tilt sensitivity 250');

    // Dialog box ticked and 500 remembered, but no TiltSensitivity key: VPX runs its default of 400 (the owner's rig does have the key, at 500).
    fs.put('C:\\VPX\\VPinballX.ini', ini(''));
    const b = await readIniAttestation({ fs, exe: EXE, tablePath: TABLE, physics: physics() });
    expect(b.nudge).toMatchObject({ tiltSensitivity: null, tiltSensitivityEffective: 400 });
    expect(JSON.parse(iniWire(b) ?? 'null')).toMatchObject({ tilt_sens: 400, tilt_sens_set: false });
    expect(describeIni(b)).toBe('stock physics, slope 6.2°');

    // 0 = analog tilt off, which Sanctioned play's minimum catches.
    fs.put('C:\\VPX\\VPinballX.ini', ini('TiltSensitivity = 0\n'));
    const c = await readIniAttestation({ fs, exe: EXE, tablePath: TABLE, physics: physics() });
    expect(c.nudge.tiltSensitivityEffective).toBe(0);
    expect(describeIni(c)).toBe('stock physics, slope 6.2°, analog tilt off');
  });

  it('a table that asks for physics set 1 takes its slope and values from the ini; a tweak-menu difficulty override wins over the table', async () => {
    const fs = new MemoryFs();
    fs.put('C:\\VPX\\VPinballX.ini', new TextEncoder().encode(MAIN_INI));
    fs.put(
      defaultTableIni(TABLE),
      new TextEncoder().encode('[TableOverride]\nDifficulty = 0.750000\nViewCabMode = 1\n[TableOption]\nOutlane Difficulty = 1.000000\nFlipperbats = 0.000000\n'),
    );
    const a = await readIniAttestation({ fs, exe: EXE, tablePath: TABLE, physics: physics({ overridePhysicsSet: 1, overridePhysicsFlippers: true, difficulty: 0.5 }), env: {} });
    expect(a).toMatchObject({
      physicsSet: 1,
      physicsSetName: 'Mousing Around',
      physicsSetValues: { gravity: 0.9700001, contactFriction: 0.35, elasticity: 0.15, elasticityFalloff: 0, scatterAngle: 0, contactScatterAngle: 2, minSlope: 5.5, maxSlope: 6 },
      physicsFlippersOverridden: true,
      flipperSetValues: { Strength: 3100, Mass: 1 },
      stockPhysics: false,
      tableDifficulty: 0.5,
      difficultyOverride: 0.75,
      effectiveDifficulty: 0.75,
      slope: { min: 5.5, max: 6, effective: 5.875 },
      tableOptions: { 'Outlane Difficulty': 1, Flipperbats: 0 },
      tableOverrides: { ViewCabMode: '1' },
    });
    expect(describeIni(a)).toBe('physics set 1 "Mousing Around" incl. flippers, difficulty override 75%, slope 5.88°, 2 table options');
  });

  it('a table ini may override the set values and a missing ini is a note, never a throw', async () => {
    const fs = new MemoryFs();
    fs.put('C:\\VPX\\VPinballX.ini', new TextEncoder().encode(MAIN_INI));
    fs.put(defaultTableIni(TABLE), new TextEncoder().encode('[Player]\nTablePhysicsMinSlope0 = 4\nTablePhysicsMaxSlope0 = 4\n'));
    const layered = await readIniAttestation({ fs, exe: EXE, tablePath: TABLE, physics: physics({ overridePhysicsSet: 1 }), env: {} });
    expect(layered.slope).toEqual({ min: 4, max: 4, effective: 4 });

    const none = await readIniAttestation({ fs: new MemoryFs(), exe: EXE, tablePath: null, physics: null, env: {} });
    expect(none.mainIni).toBeNull();
    expect(none.tableIni).toBeNull();
    expect(none.physicsSet).toBeNull();
    expect(none.stockPhysics).toBeNull();
    expect(none.slope).toBeNull();
    expect(none.notes).toEqual(['no VPinballX.ini found beside the exe or under %APPDATA%', 'table file not read: physics override and difficulty unknown']);
    expect(describeIni(none)).toBe('physics unknown');
  });
});
