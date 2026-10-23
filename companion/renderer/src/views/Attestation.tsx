const pct = (v: number | null | undefined): string => (v === null || v === undefined ? '—' : `${Math.round(v * 100)}%`);
const deg = (v: number | null | undefined): string => (v === null || v === undefined ? '—' : `${Math.round(v * 100) / 100}°`);

function physicsLine(ini: IniAttestation): { text: string; warn: boolean } {
  if (ini.physicsSet === null) return { text: 'unknown (table file not read)', warn: false };
  if (ini.physicsSet === 0) return { text: "stock (the table author's physics)", warn: false };
  const name = ini.physicsSetName ? ` "${ini.physicsSetName}"` : '';
  return { text: `override: global set ${ini.physicsSet}${name}${ini.physicsFlippersOverridden ? ', flippers too' : ''}`, warn: true };
}

/** Builds are described, never flagged: which family ran is evidence for the runner, not a verdict. */
function buildLine(b: BinaryAttestation | null, what: string, missing: string): string {
  if (!b) return missing;
  const ver = b.version?.fileVersionText ?? b.version?.fileVersion ?? `${b.sha256.slice(0, 12)}…`;
  switch (b.family) {
    case 'official':
      return `${ver} · ${b.known?.label ?? `official ${what} release`}`;
    case 'panasony':
      return `${ver} · Panasony VR community build`;
    case 'nightly':
      return `${ver} · ${what.split(' ')[0]} nightly build`;
    case 'unknown':
      return `${ver} · unrecognised build (not the official ${what} release)`;
  }
}

/**
 * The conditions block: settings in force (physics set, difficulty, slope, nudge, table options),
 * the ROM's machine adjustments against factory, and the builds that ran. Shown under the current
 * table and, compact, under the last capture. Informational in Open play; Sanctioned play reads it.
 */
export function AttestationView({ a, compact = false }: { a: Attestation; compact?: boolean }) {
  const ini = a.ini;
  const physics = ini ? physicsLine(ini) : null;
  const options = ini ? Object.entries(ini.tableOptions) : [];
  const vpx = buildLine(a.build?.vpx ?? null, 'VPX 10.8.0', 'VPX exe not read');
  const vpm = buildLine(a.build?.vpinmame ?? null, 'VPinMAME 3.6.0', 'VPinMAME DLL not found');
  const adj = a.adjustments;
  const eng = a.engine;
  const engStart = eng?.atStart ?? null;
  const engSlope = engStart && engStart.slopeMin !== null && engStart.slopeMax !== null && engStart.difficulty !== null ? engStart.slopeMin + engStart.difficulty * (engStart.slopeMax - engStart.slopeMin) : null;
  const engLast = eng && eng.changes.length > 0 ? eng.changes[eng.changes.length - 1]! : null;

  return (
    <dl className={compact ? 'facts attestation compact' : 'facts attestation'}>
      <dt>Physics</dt>
      <dd className={physics?.warn ? 'warn' : ''}>{physics ? physics.text : 'settings not read'}</dd>
      {engStart && (
        <>
          <dt>In the game</dt>
          <dd className={engLast ? 'warn' : ''} title="Read inside the table by the Castcade patch at game start and at every key press (hook 0.4.0)">
            difficulty {engStart.difficulty === null ? '?' : `${Math.round(engStart.difficulty * 100)}%`}
            {engSlope !== null ? ` · slope ${engSlope.toFixed(2)}°` : ''}
            {engStart.physicsSet !== null ? ` · physics set ${engStart.physicsSet}` : ''}
            {engStart.nudge?.tilt !== null && engStart.nudge?.tilt !== undefined ? ` · tilt sensitivity ${engStart.nudge.tilt}` : ''}
            {engLast && (
              <span>
                {' · '}
                <strong>changed during the game</strong>
                {engLast.difficulty !== engStart.difficulty ? ` (difficulty → ${engLast.difficulty === null ? '?' : `${Math.round(engLast.difficulty * 100)}%`})` : ''}
                {(engLast.nudge?.tilt ?? null) !== (engStart.nudge?.tilt ?? null) ? ` (tilt sensitivity → ${engLast.nudge?.tilt ?? '?'})` : ''}
              </span>
            )}
          </dd>
        </>
      )}
      {ini && (
        <>
          <dt>Difficulty</dt>
          <dd className={ini.difficultyOverride !== null ? 'warn' : ''}>
            {pct(ini.effectiveDifficulty)}
            {ini.difficultyOverride !== null && <span className="muted"> (table {pct(ini.tableDifficulty)}, overridden in the tweak menu)</span>}
            {ini.slope && <span className="muted"> · slope {deg(ini.slope.effective)}{ini.slope.min !== ini.slope.max ? ` (${deg(ini.slope.min)}–${deg(ini.slope.max)})` : ''}</span>}
          </dd>
          {!compact && (
            <>
              <dt>Nudge</dt>
              <dd>
                {ini.nudge.strength === null ? 'VPX default' : `strength ${ini.nudge.strength}`}
                {ini.nudge.legacy && <span className="muted"> · legacy nudge{ini.nudge.legacyStrength !== null ? ` ${ini.nudge.legacyStrength}` : ''}</span>}
                {ini.nudge.accelEnabled !== false && (ini.nudge.accelGainX !== null || ini.nudge.accelGainY !== null) && (
                  <span className="muted"> · accelerometer gain {ini.nudge.accelGainX ?? '—'}/{ini.nudge.accelGainY ?? '—'}%</span>
                )}
                {ini.nudge.accelEnabled !== false && (ini.nudge.analogGainX !== null || ini.nudge.analogGainY !== null) && (
                  <span className="muted"> · analog nudge gain {ini.nudge.analogGainX ?? '—'}/{ini.nudge.analogGainY ?? '—'} (community build key)</span>
                )}
                {ini.nudge.accelEnabled !== false && (
                  <span className={ini.nudge.tiltSensitivityEffective === 0 ? 'warn' : 'muted'}>
                    {' · '}
                    {ini.nudge.tiltSensitivityEffective === 0 ? 'analog tilt off' : `tilt sensitivity ${ini.nudge.tiltSensitivityEffective}${ini.nudge.tiltSensitivity === null ? ' (VPX default)' : ''}`}
                  </span>
                )}
              </dd>
              <dt>Table options</dt>
              <dd title={options.map(([k, v]) => `${k} = ${v}`).join('\n')}>
                {options.length === 0 ? 'none set' : `${options.length} set${ini.tableIni ? '' : ' (no table ini)'}`}
                {options.length > 0 && <span className="muted"> · {options.slice(0, 4).map(([k, v]) => `${k} ${v}`).join(', ')}{options.length > 4 ? ', …' : ''}</span>}
              </dd>
            </>
          )}
        </>
      )}
      <dt>Adjustments</dt>
      <dd className={adj && adj.nonFactory.length > 0 ? 'warn' : ''} title={adj ? adj.checked.map((c) => `${c.label}: ${c.text ?? c.shown ?? c.value}${c.factory !== null ? ` (factory ${c.factory})` : ''}`).join('\n') : ''}>
        {!adj
          ? a.vpmCheat === null && !a.adjustments
            ? 'measured at capture'
            : 'no adjustments map for this ROM'
          : adj.nonFactory.length > 0
            ? `non-factory: ${adj.nonFactory.join(', ')}`
            : `${adj.checked.length} checked, all factory${adj.unjudged > 0 ? ` (${adj.unjudged} without a known default)` : ''}`}
      </dd>
      <dt>VPX build</dt>
      <dd title={a.build?.vpx?.sha256 ?? ''}>
        {vpx}
        {a.vr && <span className="muted"> · {a.vr.inVr ? 'played in a VR headset' : 'played on the monitor'}</span>}
      </dd>
      <dt>VPinMAME</dt>
      <dd className={a.vpmCheat === true ? 'warn' : ''} title={a.build?.vpinmame?.sha256 ?? ''}>
        {vpm}
        {a.vpmCheat !== null && <span className={a.vpmCheat ? 'warn' : 'muted'}> · cheat {a.vpmCheat ? 'ON' : 'off'}</span>}
      </dd>
      {a.iniChanged && (
        <>
          <dt />
          <dd className="warn">settings changed during the session</dd>
        </>
      )}
      {!compact && (a.notes.length > 0 || (ini && ini.notes.length > 0) || (a.build && a.build.notes.length > 0)) && (
        <>
          <dt>Notes</dt>
          <dd className="muted">{[...a.notes, ...(ini?.notes ?? []), ...(a.build?.notes ?? [])].join('; ')}</dd>
        </>
      )}
    </dl>
  );
}
