import { useState } from 'react';
import { Chip, Note, Skeleton, SkeletonFacts } from '../parts/Bits.js';
import { Button } from '../parts/Button.js';
import { Panel, PanelGroup } from '../parts/Panel.js';
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

  /** The Patch now button, or what it answered: on a line of its own under the sentence that offers it. */
  function patchAction(vpxPath: string) {
    const r = patched[vpxPath];
    if (r) return <span className={`cc-fact-action ${r.ok ? 'cc-ok' : 'cc-problem'}`}>{r.text}</span>;
    return (
      <span className="cc-fact-action">
        <Button size="sm" onClick={() => void patchNow(vpxPath)} disabled={!bridge || patching}>
          Patch now
        </Button>
      </span>
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
    // Loading: the tab's own shape (the two chips and the button, the facts), not a spinner.
    return (
      <PanelGroup id="status" title="Status">
        <Panel wide>
          <div className="cc-stack" aria-busy="true">
            <p className="cc-help">Waiting for the witness module…</p>
            <div className="cc-row">
              <Skeleton kind="chip" />
              <Skeleton kind="chip" />
              <span className="cc-row__push">
                <Skeleton kind="button" width="72px" />
              </span>
            </div>
            <SkeletonFacts rows={8} />
          </div>
        </Panel>
      </PanelGroup>
    );
  }

  const c = status.lastCapture;
  const attemptState = (a: AttemptStatus): string => (a.state === 'counted' && !a.late ? 'cc-ok' : a.needsStart ? 'cc-attention' : 'cc-problem');
  return (
    <>
      <PanelGroup id="status" title="Status">
        <Panel>
          <div className="cc-row">
            <Chip state={status.running ? 'ok' : 'problem'}>{status.running ? 'Watching' : 'Paused'}</Chip>
            <Chip state={status.paired ? 'ok' : 'problem'}>{status.paired ? 'Paired' : 'Not paired'}</Chip>
            <Button variant={status.running ? 'secondary' : 'primary'} size="sm" className="cc-row__push" onClick={() => void togglePaused()} disabled={!bridge || busy}>
              {status.running ? 'Pause' : 'Resume'}
            </Button>
          </div>

          <dl className="cc-facts">
            <dt>VPX exe seen</dt>
            <dd className={status.vpxExe ? 'cc-mono' : undefined} title={status.vpxExe ?? ''}>{status.vpxExe ?? 'not yet (launch a table)'}</dd>
            {status.vrSetupWarning && (
              <>
                <dt>VR setup</dt>
                <dd className="cc-attention">{status.vrSetupWarning}</dd>
              </>
            )}
            <dt>NVRAM dir</dt>
            <dd className={status.nvramDir ? 'cc-mono' : undefined} title={status.nvramDir ?? ''}>{status.nvramDir ?? 'not found'}</dd>
            <dt>Maps version</dt>
            <dd>{status.mapsVersion ?? 'unknown'}</dd>
            <dt>VPS index</dt>
            <dd title={status.vpsIndex?.version ? `${status.vpsIndex.tables.toLocaleString()} table files · ${status.vpsIndex.version}` : ''}>{describeVpsIndex(status.vpsIndex)}</dd>
            <dt>Current table</dt>
            <dd className={status.currentTable ? 'cc-display' : undefined}>{status.currentTable ?? '—'}</dd>
            {status.captureMode && (
              <>
                <dt>Capture</dt>
                <dd className={status.captureMode === 'basic' || status.note ? 'cc-attention' : ''}>
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
                <dd className="cc-attention" title={`rung ${status.lastClose.rung} (${status.lastClose.kind}) · ${formatTime(status.lastClose.at)}`}>
                  {status.lastClose.text}
                  {status.lastClose.vpxPath && patchAction(status.lastClose.vpxPath)}
                </dd>
              </>
            )}
            {status.attempt && status.attempt.text && (
              <>
                <dt>Attempt</dt>
                <dd className={attemptState(status.attempt)} title="This tournament limits attempts per table; every game start counts (ArcAid ADR 0029)">
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
        </Panel>

        <Panel>
          <div className="cc-row">
            <Button size="sm" onClick={() => void startAttempts()} disabled={!bridge || !status.paired || starting}>
              Start attempts
            </Button>
          </div>
          <p className="cc-help">For tournaments that require Start attempts: press once, then play; every game from then on counts.</p>
          {status.attemptStart && (
            <Note state={status.attemptStart.status === 'started' ? 'ok' : undefined}>
              {status.attemptStart.text} · {formatTime(status.attemptStart.at)}
            </Note>
          )}
        </Panel>

        {(status.lastError || error) && (
          <div className="cc-stack cc-panel--wide">
            {status.lastError && <Note state="problem">Last error: {status.lastError}</Note>}
            {error && (
              <Note state="problem" role="alert">
                {error}
              </Note>
            )}
          </div>
        )}
      </PanelGroup>

      <PanelGroup id="last-capture" tone="violet" title="Last capture">
        <Panel wide>
          {c ? (
            <dl className="cc-facts">
              <dt>Table</dt>
              <dd className="cc-display">{c.table}</dd>
              <dt>ROM</dt>
              <dd>{c.rom ?? '— (no ROM)'}</dd>
              <dt>Players</dt>
              <dd>{c.players}</dd>
              <dt>Score</dt>
              <dd className="cc-score">{c.score === null ? '—' : c.score.toLocaleString()}</dd>
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
              <dd className={c.outcome === 'ingested' ? 'cc-ok' : c.outcome === 'rejected' ? 'cc-problem' : ''}>{OUTCOME_LABEL[c.outcome]}</dd>
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
                  <dd className="cc-facts__block">
                    <Identity state={state} identity={c.identity} compact />
                  </dd>
                </>
              )}
              {c.attestation && (
                <>
                  <dt>Conditions</dt>
                  <dd className="cc-facts__block">
                    <AttestationView a={c.attestation} compact />
                  </dd>
                </>
              )}
            </dl>
          ) : (
            // The empty state: what goes here, and what to do for it to come.
            <p className="cc-text cc-quiet">No game captured yet. Play one one-player game on a ROM table and quit VPX normally.</p>
          )}
        </Panel>
      </PanelGroup>
    </>
  );
}
