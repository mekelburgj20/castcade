/**
 * What the companion can attest about the *conditions* a game was played under (F2 of
 * `docs/design/fairness-and-table-identity.md`): the VPX settings in force (ini), the ROM's operator
 * adjustments (NVRAM), and the builds that ran (VPX exe, VPinMAME DLL, its per-ROM cheat flag).
 *
 * Everything here is measured and reported, never enforced on the companion: Open play ignores it,
 * Sanctioned play (ArcAid item 11) reads it. Nulls mean "could not measure", not "fine".
 */

/** One of the eight global physics sets from `VPinballX.ini` (`TablePhysics*N`, 0-based in the file). */
export interface PhysicsSetValues {
  gravity: number | null;
  contactFriction: number | null;
  elasticity: number | null;
  elasticityFalloff: number | null;
  scatterAngle: number | null;
  contactScatterAngle: number | null;
  minSlope: number | null;
  maxSlope: number | null;
}

export interface NudgeSettings {
  /** `[Player] NudgeStrength` (VPX default 0.02). */
  strength: number | null;
  /** `[Player] NudgeSensitivity` (VPX default 500). */
  sensitivity: number | null;
  legacy: boolean | null;
  legacyStrength: number | null;
  analogGainX: number | null;
  analogGainY: number | null;
  /** `[Player] EnableNudgeFilter`. In 10.8.0 the filter's sustained-tilt rejection is compiled out; what is left only damps. */
  filter: boolean | null;
  /** `[Player] PBWEnabled` (VPX default true): the analog accelerometer input is in use. */
  accelEnabled: boolean | null;
  /** `[Player] PBWAccelGainX/Y` in percent (VPX default 150): scales the push the ball receives from the accelerometer. */
  accelGainX: number | null;
  accelGainY: number | null;
  /** `[Player] PBWAccelMaxX/Y` in percent of the axis range (VPX default 100). */
  accelMaxX: number | null;
  accelMaxY: number | null;
  /** `[Player] AccelVelocityInput`: the axis is read as a velocity instead of an acceleration. */
  accelVelocityInput: boolean | null;
  /**
   * `[Player] TiltSensitivity` as stored (0–1000), or null when the key is absent. The virtual plumb bob
   * trips a tilt once its displacement passes `1 - value/1000` of its range, so **higher tilts sooner**;
   * 0 disables analog tilt. The bob reads the raw axis, before `accelGain`.
   */
  tiltSensitivity: number | null;
  /** What VPX 10.8.0 actually uses: the stored value, else its default of 400 (the key is absent even with the dialog box unticked). */
  tiltSensitivityEffective: number;
}

export interface IniAttestation {
  /** The `VPinballX.ini` that was read (beside the exe, or the per-user one), or null when none was found. */
  mainIni: string | null;
  /** The per-table `<table>.ini` that was read, or null when the table has none. */
  tableIni: string | null;
  /**
   * The physics-set override the *table file* asks for (its `ORRP` property): 0 = the table's own
   * physics, 1–8 = that global set from the ini. Null when the table file could not be read.
   */
  physicsSet: number | null;
  physicsSetName: string | null;
  /** The set's values as the ini defines them, when `physicsSet` > 0. */
  physicsSetValues: PhysicsSetValues | null;
  /** The table also takes flipper physics from the set (`ORPF`). */
  physicsFlippersOverridden: boolean | null;
  /** `[Player] FlipperPhysics*N` values when the flippers are overridden. */
  flipperSetValues: Record<string, number> | null;
  /** True when the ball sees the table author's physics: no set override, no flipper override. */
  stockPhysics: boolean | null;
  /** The table's own difficulty (`TDFT`, 0–1). */
  tableDifficulty: number | null;
  /** `[TableOverride] Difficulty` (0–1) from the table ini, else the main ini; null when not set. */
  difficultyOverride: number | null;
  effectiveDifficulty: number | null;
  /** Slope in degrees: the pair in force (override set or table) and `min + difficulty × (max − min)`. */
  slope: { min: number; max: number; effective: number | null } | null;
  nudge: NudgeSettings;
  /** `[TableOption]` of the table ini: the 10.8 table options the player chose, by the author's option name. */
  tableOptions: Record<string, number>;
  /** Other `[TableOverride]` keys of the table ini (view, tone mapper…), name → raw value. */
  tableOverrides: Record<string, string>;
  /** `[Player]` keys the table ini overrides (visual/performance toggles such as BallTrailStrength). */
  playerOverrides: string[];
  notes: string[];
}

/** One operator adjustment as the maps corpus describes it and as the `.nv` holds it. */
export interface AdjustmentReading {
  group: string;
  label: string;
  /** The stored value (an index for enums): the domain `min`/`max`/`default` describe. Null when the bytes are outside the memory. */
  value: number | null;
  /** The value after the map's `scale`/`offset` (what the operator menu shows), or the same number when there is none. */
  shown: number | null;
  /** The enum text or `special_values` text for the value, when the map gives one. */
  text: string | null;
  /** The factory default the map records (stored-value domain), null when the map has none for this entry. */
  factory: number | null;
  /** value === factory; null when either side is unknown. */
  isFactory: boolean | null;
}

export interface AdjustmentsReport {
  rom: string;
  /** Adjustments the map describes for this ROM. */
  total: number;
  /** The fairness-relevant subset the companion checked (balls per game, tilt warnings, extra balls, ball save, replay, pricing…). */
  checked: AdjustmentReading[];
  /** Labels of checked adjustments that differ from factory. */
  nonFactory: string[];
  /** Checked adjustments the map has no factory default for (reported, not judged). */
  unjudged: number;
}

/** Strings from a PE file's `VS_VERSIONINFO` resource. */
export interface PeVersion {
  /** `VS_FIXEDFILEINFO` file version as `a.b.c.d`. */
  fileVersion: string | null;
  /** `StringFileInfo` → `FileVersion` (often carries a build tag, e.g. `10.8.0.2079.Panasony`). */
  fileVersionText: string | null;
  productVersionText: string | null;
  description: string | null;
}

export type KnownBuildKind = 'official';

export interface KnownBuild {
  id: string;
  label: string;
  kind: KnownBuildKind;
}

/**
 * Who built the binary, as far as the companion can tell. `official` is proven by hash; the other
 * three are read from the version resource (a declaration anyone could edit, which Sanctioned play
 * accepts under the honest ceiling): `panasony` = the Panasony VR community builds (tag `.Panasony`
 * in `FileVersion`; allowed in Sanctioned play by default, owner ruling 2026-10-19), `nightly` = an
 * upstream-style build number that is not a release, `unknown` = none of the above.
 */
export type BuildFamily = 'official' | 'panasony' | 'nightly' | 'unknown';

export interface BinaryAttestation {
  path: string;
  size: number;
  sha256: string;
  version: PeVersion | null;
  /** The release build this hash belongs to, or null when the companion does not know it. */
  known: KnownBuild | null;
  family: BuildFamily;
}

export interface BuildAttestation {
  vpx: BinaryAttestation | null;
  vpinmame: BinaryAttestation | null;
  notes: string[];
}

export interface Attestation {
  measuredAt: string; // ISO
  ini: IniAttestation | null;
  build: BuildAttestation | null;
  /** From the `.nv` read at capture; null before capture or when the map has no adjustments. */
  adjustments: AdjustmentsReport | null;
  /** VPinMAME's per-ROM `cheat` option (registry), null when unreadable or before the ROM is known. */
  vpmCheat: boolean | null;
  /** The settings differed between launch and capture (the player used the tweak menu, or edited the ini). */
  iniChanged: boolean;
  notes: string[];
}

// ------------------------------------------------------------------------------------- wire --

const r4 = (n: number | null): number | null => (n === null ? null : Math.round(n * 10_000) / 10_000);

/** The compact `ini` JSON ArcAid item 11 reads: physics set, difficulty, slope, nudge, table options. */
export function iniWire(ini: IniAttestation | null): string | null {
  if (!ini) return null;
  return JSON.stringify({
    set: ini.physicsSet,
    set_name: ini.physicsSetName,
    flippers: ini.physicsFlippersOverridden,
    stock: ini.stockPhysics,
    difficulty: r4(ini.tableDifficulty),
    difficulty_override: r4(ini.difficultyOverride),
    slope: ini.slope ? r4(ini.slope.effective) : null,
    nudge: r4(ini.nudge.strength),
    legacy_nudge: ini.nudge.legacy,
    nudge_filter: ini.nudge.filter,
    nudge_sensitivity: ini.nudge.sensitivity,
    accel: ini.nudge.accelEnabled,
    accel_gain_x: ini.nudge.accelGainX,
    accel_gain_y: ini.nudge.accelGainY,
    accel_max_x: ini.nudge.accelMaxX,
    accel_max_y: ini.nudge.accelMaxY,
    accel_velocity: ini.nudge.accelVelocityInput,
    tilt_sens: ini.nudge.tiltSensitivityEffective,
    tilt_sens_set: ini.nudge.tiltSensitivity !== null,
    options: ini.tableOptions,
    overrides: Object.keys(ini.tableOverrides),
    table_ini: ini.tableIni !== null,
  });
}

/** The compact `adjustments` JSON: the checked subset as `{l, v, d}` plus the non-factory labels. */
export function adjustmentsWire(a: AdjustmentsReport | null): string | null {
  if (!a) return null;
  return JSON.stringify({
    total: a.total,
    items: a.checked.map((c) => ({ l: c.label, v: c.value, ...(c.text !== null ? { t: c.text } : {}), d: c.factory })),
    non_factory: a.nonFactory,
  });
}

/** The compact `build` JSON: exe and DLL hashes with version strings, the known-build id and the build family, plus the cheat flag. */
export function buildWire(b: BuildAttestation | null, cheat: boolean | null): string | null {
  if (!b && cheat === null) return null;
  const bin = (x: BinaryAttestation | null) =>
    x
      ? {
          sha256: x.sha256,
          version: x.version?.fileVersionText ?? x.version?.fileVersion ?? null,
          known: x.known?.id ?? null,
          family: x.family,
        }
      : null;
  return JSON.stringify({ vpx: bin(b?.vpx ?? null), vpinmame: bin(b?.vpinmame ?? null), cheat });
}
