import { useState } from 'react';
import { describe, formatTime, type CastcadeState } from '../useCastcade.js';
import { AttestationView } from './Attestation.js';
import { Identity } from './Identity.js';

const OUTCOME_LABEL: Record<CaptureOutcome, string> = {
  ingested: 'posted to ArcAid',
  duplicate: 'already on ArcAid',
  queued: 'queued (offline, will retry)',
  rejected: 'rejected by ArcAid',
  skipped: 'skipped',
};

/**
 * B24: `2,643 games · bundled 2026-10-19` (the installer's index, by the date its pin was fetched) or
 * `2,702 games · refreshed 2026-11-02 04:10` (rebuilt from vps-db today), plus when upstream was last confirmed unchanged.
 */
function describeVpsIndex(v: WitnessStatus['vpsIndex']): string {
  if (!v || v.source === 'none') return 'not bundled';
  const games = `${v.games.toLocaleString()} games`;
  if (v.source === 'bundled') return `${games} · bundled ${v.builtAt?.slice(0, 10) ?? 'unknown date'}`;
  const checked = v.checkedAt && v.checkedAt !== v.builtAt ? ` · checked ${formatTime(v.checkedAt)}` : '';
  return `${games} · refreshed ${formatTime(v.builtAt)}${checked}`;
}

export function Status({ state }: { state: CastcadeState }) {
  const { bridge, status } = state;
  const [busy, setBusy] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** C11: Patch now in flight, and its answer per table file. */
  const [patching, setPatching] = useState(false);
  const [patched, setPatched] = useState<Record<string, TablesPatchNowResult>>({});

  async function patchNow(vpxPath: string) {
    setPatching(true);
    setError(null);
    try {
      const r = await state.patchNow(vpxPath);
      setPatched((p) => ({ ...p, [vpxPath]: r }));
    } catch (e) {
      setError(describe(e));
    } finally {
      setPatching(false);
    }
  }

  /** The Patch now button, or what it answered. */
  function patchAction(vpxPath: string) {
    const r = patched[vpxPath];
    if (r) return <span className={r.ok ? 'ok' : 'error'}> {r.text}</span>;
    return (
      <>
        {' '}
        <button type="button" className="small" onClick={() => void patchNow(vpxPath)} disabled={!bridge || patching}>
          Patch now
        </button>
      </>
    );
  }

  async function togglePaused() {
    if (!bridge || !status) return;
    setBusy(true);
    setError(null);
    try {
      state.applyStatus(await bridge.witness.setPaused(status.running));
    } catch (e) {
      setError(describe(e));
    } finally {
      setBusy(false);
    }
  }

  /** B21: press Start attempts on ArcAid (W45); the answer comes back as `status.attemptStart`. */
  async function startAttempts() {
    if (!bridge) return;
    setStarting(true);
    setError(null);
    try {
      state.applyStatus(await bridge.witness.startAttempts());
    } catch (e) {
      setError(describe(e));
    } finally {
      setStarting(false);
    }
  }

  if (!status) {
    return (
      <section className="view">
        <h2>Status</h2>
        <p className="muted">Waiting for the witness module…</p>
      </section>
    );
  }

  const c = status.lastCapture;
  return (
    <section className="view">
      <h2>Status</h2>
      <div className="card row">
        <span className={status.running ? 'pill on' : 'pill off'}>{status.running ? 'Watching' : 'Paused'}</span>
        <span className={status.paired ? 'pill on' : 'pill off'}>{status.paired ? 'Paired' : 'Not paired'}</span>
        <button type="button" className="small" onClick={() => void togglePaused()} disabled={!bridge || busy}>
          {status.running ? 'Pause' : 'Resume'}
        </button>
      </div>

      <dl className="facts">
        <dt>VPX exe seen</dt>
        <dd title={status.vpxExe ?? ''}>{status.vpxExe ?? 'not yet (launch a table)'}</dd>
        <dt>NVRAM dir</dt>
        <dd title={status.nvramDir ?? ''}>{status.nvramDir ?? 'not found'}</dd>
        <dt>Maps version</dt>
        <dd>{status.mapsVersion ?? 'unknown'}</dd>
        <dt>VPS index</dt>
        <dd title={status.vpsIndex?.version ? `${status.vpsIndex.tables.toLocaleString()} table files · ${status.vpsIndex.version}` : ''}>{describeVpsIndex(status.vpsIndex)}</dd>
        <dt>Current table</dt>
        <dd>{status.currentTable ?? '—'}</dd>
        {status.captureMode && (
          <>
            <dt>Capture</dt>
            <dd className={status.captureMode === 'basic' || status.note ? 'warn' : ''}>
              {status.captureMode === 'live'
                ? status.note ?? 'live — every game, from the Castcade patch inside the table'
                : status.note ?? 'basic — one score when the table closes (Settings → Import tables → Patch my tables for every game)'}
              {status.captureMode === 'basic' && status.patchNow && patchAction(status.patchNow.vpxPath)}
            </dd>
          </>
        )}
        {!status.currentTable && status.lastClose && (
          <>
            <dt>Last close</dt>
            <dd className="warn" title={`rung ${status.lastClose.rung} (${status.lastClose.kind}) · ${formatTime(status.lastClose.at)}`}>
              {status.lastClose.text}
              {status.lastClose.vpxPath && patchAction(status.lastClose.vpxPath)}
            </dd>
          </>
        )}
        {status.attempt && status.attempt.text && (
          <>
            <dt>Attempt</dt>
            <dd className={status.attempt.state === 'counted' && !status.attempt.late ? 'ok' : status.attempt.needsStart ? 'warn' : 'error'} title="This tournament limits attempts per table; every game start counts (ArcAid ADR 0029)">
              {status.attempt.text}
              {status.attempt.game ? ` · ${status.attempt.game}` : ''}
            </dd>
          </>
        )}
        {status.currentIdentity && (
          <>
            <dt />
            <dd>
              <Identity state={state} identity={status.currentIdentity} />
            </dd>
          </>
        )}
        {status.currentAttestation && (
          <>
            <dt />
            <dd>
              <AttestationView a={status.currentAttestation} />
            </dd>
          </>
        )}
        <dt>Queued posts</dt>
        <dd>{status.queued}</dd>
        <dt>Last heartbeat</dt>
        <dd>{formatTime(status.lastHeartbeatAt)}</dd>
        <dt>Last check-in</dt>
        <dd>{formatTime(status.lastCheckinAt)}</dd>
        <dt>Sending to</dt>
        <dd title="Where ArcAid routes this device's scores (Account Settings → Arcaid Witness → this device)">
          {status.sendingTo ?? (status.paired ? 'not yet reported by ArcAid' : '—')}
        </dd>
      </dl>

      <div className="card">
        <button type="button" className="small" onClick={() => void startAttempts()} disabled={!bridge || !status.paired || starting}>
          Start attempts
        </button>
        <p className="muted">For tournaments that require Start attempts: press once, then play; every game from then on counts.</p>
        {status.attemptStart && (
          <p className={status.attemptStart.status === 'started' ? 'ok' : ''}>
            {status.attemptStart.text} · {formatTime(status.attemptStart.at)}
          </p>
        )}
      </div>

      <h3>Last capture</h3>
      {c ? (
        <dl className="facts card">
          <dt>Table</dt>
          <dd>{c.table}</dd>
          <dt>ROM</dt>
          <dd>{c.rom ?? '— (no ROM)'}</dd>
          <dt>Players</dt>
          <dd>{c.players}</dd>
          <dt>Score</dt>
          <dd className="score">{c.score === null ? '—' : c.score.toLocaleString()}</dd>
          {c.mode && (
            <>
              <dt>Captured</dt>
              <dd>{c.mode === 'live' ? 'live, from the game itself' : 'when the table closed'}</dd>
            </>
          )}
          {c.attempt && (
            <>
              <dt>Attempt</dt>
              <dd>
                {c.attempt.n} of {c.attempt.of}
                {c.attempt.remaining > 0 ? ` (${c.attempt.remaining} left)` : ' (none left)'}
              </dd>
            </>
          )}
          <dt>Outcome</dt>
          <dd className={c.outcome === 'ingested' ? 'ok' : c.outcome === 'rejected' ? 'error' : ''}>
            {OUTCOME_LABEL[c.outcome]}
          </dd>
          {c.detail && (
            <>
              <dt>Detail</dt>
              <dd>{c.detail}</dd>
            </>
          )}
          <dt>Played</dt>
          <dd>
            {formatTime(c.launchedAt)} → {formatTime(c.exitedAt)}
          </dd>
          {c.identity && (
            <>
              <dt>Identity</dt>
              <dd>
                <Identity state={state} identity={c.identity} compact />
              </dd>
            </>
          )}
          {c.attestation && (
            <>
              <dt>Conditions</dt>
              <dd>
                <AttestationView a={c.attestation} compact />
              </dd>
            </>
          )}
        </dl>
      ) : (
        <p className="muted card">No game captured yet. Play one one-player game on a ROM table and quit VPX normally.</p>
      )}

      {status.lastError && (
        <p className="error">
          Last error: {status.lastError}
        </p>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  );
}
