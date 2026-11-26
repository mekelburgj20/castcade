import { useEffect, useState } from 'react';
import { Button } from '../parts/Button.js';
import { describe, type CastcadeState } from '../useCastcade.js';

const CONFIDENCE_LABEL: Record<MatchConfidence, string> = {
  exact: '',
  likely: ' (likely)',
  ambiguous: ' (unsure, please confirm)',
  none: '',
};

function shortHash(h: string | null): string {
  return h ? `${h.slice(0, 12)}…` : '—';
}

/**
 * The identity block shown under the current table and under the last capture: which VPS game and
 * table the companion believes the file is, how sure it is, and the one-time picker when it is not.
 */
export function Identity({ state, identity, compact = false }: { state: CastcadeState; identity: TableIdentity; compact?: boolean }) {
  const { bridge } = state;
  const [choice, setChoice] = useState<string>(identity.vpsTable?.id ?? '');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setChoice(identity.vpsTable?.id ?? '');
    setEditing(false);
  }, [identity.filePath, identity.vpsTable?.id]);

  const askNow = identity.tableConfidence === 'ambiguous' && !identity.confirmed;
  const canPick = identity.filePath !== null && identity.tableChoices.length > 0;

  async function confirm(id: string | null) {
    if (!bridge || !identity.filePath) return;
    setBusy(true);
    setError(null);
    try {
      state.applyStatus(await bridge.witness.confirmTable(identity.filePath, id));
      setEditing(false);
    } catch (e) {
      setError(describe(e));
    } finally {
      setBusy(false);
    }
  }

  const game = identity.vpsGame;
  const slope = identity.physics?.slopeMin !== null && identity.physics?.slopeMin !== undefined ? (identity.physics.slopeMin === identity.physics.slopeMax ? `${identity.physics.slopeMin}°` : `${identity.physics.slopeMin}°–${identity.physics.slopeMax}°`) : null;

  return (
    <dl className="cc-facts cc-facts--sub">
      <dt>VPS game</dt>
      <dd>
        {game ? <span className="cc-display">{`${game.name}${game.manufacturer || game.year ? ` (${[game.manufacturer, game.year].filter(Boolean).join(' ')})` : ''}`}</span> : 'not matched'}
        {game && <span className="cc-quiet"> · {game.id}{CONFIDENCE_LABEL[identity.gameConfidence]}</span>}
      </dd>
      <dt>VPS table</dt>
      <dd>
        {identity.vpsTable ? identity.vpsTable.label : identity.tableChoices.length > 0 ? 'not decided' : 'none known'}
        {identity.vpsTable && (
          <span className="cc-quiet">
            {' '}
            · {identity.vpsTable.id}
            {identity.confirmed ? ' (confirmed by you)' : CONFIDENCE_LABEL[identity.tableConfidence]}
          </span>
        )}
        {canPick && !editing && !askNow && (
          <>
            {' '}
            <button type="button" className="cc-link" onClick={() => setEditing(true)} disabled={!bridge}>
              change
            </button>
          </>
        )}
        {canPick && (editing || askNow) && (
          <div className="cc-picker">
            <select id="vps-table-choice" className="cc-input" aria-label="Which table is this file?" value={choice} onChange={(e) => setChoice(e.target.value)} disabled={busy}>
              <option value="">— which table is this file? —</option>
              {identity.tableChoices.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label} · {t.id}
                </option>
              ))}
            </select>
            <Button size="sm" disabled={busy || !choice} onClick={() => void confirm(choice)}>
              Confirm
            </Button>
            {identity.confirmed && (
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => void confirm(null)}>
                Forget
              </Button>
            )}
            {editing && (
              <button type="button" className="cc-link" disabled={busy} onClick={() => setEditing(false)}>
                cancel
              </button>
            )}
          </div>
        )}
      </dd>
      {!compact && (
        <>
          <dt>File</dt>
          <dd className={identity.filePath ? 'cc-mono' : undefined} title={identity.filePath ?? ''}>
            {identity.filePath ?? 'not found (set the tables folder in Settings)'}
          </dd>
          <dt>Table info</dt>
          <dd>
            {identity.tableInfo
              ? [identity.tableInfo.tableName, identity.tableInfo.authorName, identity.tableInfo.tableVersion].filter(Boolean).join(' · ') || '—'
              : '—'}
            {identity.saveRev !== null && <span className="cc-quiet"> · save rev {identity.saveRev}</span>}
          </dd>
          <dt>SHA-256</dt>
          <dd className={identity.sha256 ? 'cc-mono' : undefined} title={identity.sha256 ?? ''}>
            {identity.sha256 ? shortHash(identity.sha256) : identity.filePath ? 'computing…' : '—'}
          </dd>
          {slope && (
            <>
              <dt>Slope</dt>
              <dd>{slope}</dd>
            </>
          )}
        </>
      )}
      {identity.notes.length > 0 && !compact && (
        <>
          <dt>Notes</dt>
          <dd className="cc-quiet">{identity.notes.join('; ')}</dd>
        </>
      )}
      {error && (
        <>
          <dt />
          <dd className="cc-problem" role="alert">
            {error}
          </dd>
        </>
      )}
    </dl>
  );
}
