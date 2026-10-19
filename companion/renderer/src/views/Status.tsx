import { useState } from 'react';
import { describe, formatTime, type CastcadeState } from '../useCastcade.js';
import { Identity } from './Identity.js';

const OUTCOME_LABEL: Record<CaptureOutcome, string> = {
  ingested: 'posted to ArcAid',
  duplicate: 'already on ArcAid',
  queued: 'queued (offline, will retry)',
  rejected: 'rejected by ArcAid',
  skipped: 'skipped',
};

export function Status({ state }: { state: CastcadeState }) {
  const { bridge, status } = state;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        <dt>Current table</dt>
        <dd>{status.currentTable ?? '—'}</dd>
        {status.currentIdentity && (
          <>
            <dt />
            <dd>
              <Identity state={state} identity={status.currentIdentity} />
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
