import { useEffect, useState } from 'react';
import { describe, type CastcadeState } from '../useCastcade.js';

const ACTION_LABEL: Record<TablesPlanAction, string> = {
  patch: 'will be patched',
  repatch: 'will be re-patched (table changed or older patch)',
  already: 'already patched',
  skip: 'skipped for now',
  foreign: 'left alone (another script sits beside the table)',
  unsupported: 'unsupported',
};

const ACTION_ORDER: TablesPlanAction[] = ['patch', 'repatch', 'already', 'skip', 'foreign', 'unsupported'];

/**
 * The folder import for live scores (WORK C7): dry run first, then patch. Every table with a ROM
 * gets a same-basename sidecar `.vbs` and the shared library goes into the VPX `scripts\` folder.
 * Originals are skipped until their recipes exist; a foreign `.vbs` is never touched.
 */
export function ImportTables({ state }: { state: CastcadeState }) {
  const { bridge, settings } = state;
  const [defaults, setDefaults] = useState<TablesDefaults | null>(null);
  const [dir, setDir] = useState('');
  const [plan, setPlan] = useState<TablesPlan | null>(null);
  const [applied, setApplied] = useState<TablesApplyResult | null>(null);
  const [removed, setRemoved] = useState<TablesRemoveResult | null>(null);
  const [busy, setBusy] = useState<'plan' | 'apply' | 'remove' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    if (!bridge) return;
    let alive = true;
    void bridge.tables
      .defaults()
      .then((d) => {
        if (!alive) return;
        setDefaults(d);
        setDir((cur) => cur || settings?.tablesDir || d.tablesDir || '');
      })
      .catch((e: unknown) => alive && setError(describe(e)));
    return () => {
      alive = false;
    };
  }, [bridge, settings?.tablesDir]);

  const folder = dir.trim() === '' ? null : dir.trim();

  async function run<T>(what: 'plan' | 'apply' | 'remove', fn: () => Promise<T>, done: (r: T) => void) {
    if (!bridge) return;
    setBusy(what);
    setError(null);
    try {
      done(await fn());
    } catch (e) {
      setError(describe(e));
    } finally {
      setBusy(null);
    }
  }

  const toPatch = plan ? plan.counts.patch + plan.counts.repatch : 0;
  const listed = plan ? (showAll ? plan.items : plan.items.filter((i) => i.action !== 'already')) : [];

  return (
    <div className="card">
      <label className="field">
        <span>Import tables for live scores</span>
        <input
          type="text"
          value={dir}
          placeholder={defaults?.tablesDir ?? 'launch a table once, or type the folder'}
          onChange={(e) => {
            setDir(e.target.value);
            setPlan(null);
            setApplied(null);
            setRemoved(null);
          }}
          disabled={!bridge || busy !== null}
          spellCheck={false}
        />
        <button
          type="button"
          className="small"
          disabled={!bridge || busy !== null}
          onClick={() =>
            void bridge?.app.pickFolder(folder ?? defaults?.tablesDir ?? null).then((picked) => {
              if (picked) {
                setDir(picked);
                setPlan(null);
                setApplied(null);
                setRemoved(null);
              }
            })
          }
        >
          Browse…
        </button>
        <small>
          Every ROM table in this folder gets a Castcade script beside it (the .vpx is never changed; delete the .vbs to
          revert) so every game posts its own score instead of one score when the table closes. The shared library
          {defaults?.scriptsDir ? <> goes into <span className="mono">{defaults.scriptsDir}</span></> : ' goes into the VPX scripts folder'}
          {defaults?.hookVersion ? ` (hook ${defaults.hookVersion})` : ''}. Originals are skipped until their recipes exist.
        </small>
      </label>
      <div className="row">
        <button type="button" disabled={!bridge || busy !== null} onClick={() => void run('plan', () => bridge!.tables.plan(folder), (p) => { setPlan(p); setApplied(null); setRemoved(null); })}>
          {busy === 'plan' ? 'Checking…' : 'Check folder'}
        </button>
        <button type="button" disabled={!bridge || busy !== null || !plan || toPatch === 0} onClick={() => void run('apply', () => bridge!.tables.apply(folder), (r) => { setApplied(r); setPlan(null); })}>
          {busy === 'apply' ? 'Patching…' : toPatch > 0 ? `Patch ${toPatch} table${toPatch === 1 ? '' : 's'}` : 'Patch'}
        </button>
        <button type="button" className="small" disabled={!bridge || busy !== null} onClick={() => void run('remove', () => bridge!.tables.removeAll(folder), (r) => { setRemoved(r); setPlan(null); setApplied(null); })}>
          {busy === 'remove' ? 'Removing…' : 'Remove all Castcade patches'}
        </button>
      </div>

      {plan && (
        <div className="import-result">
          <p>
            <span className="mono">{plan.dir}</span>:{' '}
            {ACTION_ORDER.filter((a) => plan.counts[a] > 0)
              .map((a) => `${plan.counts[a]} ${ACTION_LABEL[a]}`)
              .join(' · ') || 'no .vpx files found'}
            . Nothing has been written yet.
          </p>
          {listed.length > 0 && (
            <ul className="import-list">
              {listed.map((i) => (
                <li key={i.vpxPath} className={`act-${i.action}`}>
                  <span className="mono" title={i.vpxPath}>{i.tableId}</span>
                  <span className="muted">
                    {' '}— {ACTION_LABEL[i.action]}
                    {i.rom ? ` · ROM ${i.rom}` : ''}
                    {i.action !== 'patch' && i.action !== 'repatch' && i.action !== 'already' && i.reason ? ` · ${i.reason}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {plan.counts.already > 0 && (
            <button type="button" className="link" onClick={() => setShowAll((v) => !v)}>
              {showAll ? 'hide the already-patched tables' : `show the ${plan.counts.already} already-patched table${plan.counts.already === 1 ? '' : 's'}`}
            </button>
          )}
        </div>
      )}

      {applied && (
        <div className="import-result">
          <p className={applied.failed.length === 0 ? 'ok' : ''}>
            Patched {applied.patched.length} table{applied.patched.length === 1 ? '' : 's'}
            {applied.skipped > 0 ? `, ${applied.skipped} left as they were` : ''}; library {applied.libInstalled} in{' '}
            <span className="mono">{applied.scriptsDir}</span>. Launch a table and play: Status shows "Capture: live".
          </p>
          {applied.failed.length > 0 && (
            <ul className="import-list">
              {applied.failed.map((f) => (
                <li key={f.tableId} className="error">
                  <span className="mono">{f.tableId}</span> — {f.error}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {removed && (
        <p className="import-result">
          Removed {removed.removed.length} Castcade patch{removed.removed.length === 1 ? '' : 'es'} under <span className="mono">{removed.dir}</span>
          {removed.keptForeign.length > 0 ? `; ${removed.keptForeign.length} other script${removed.keptForeign.length === 1 ? '' : 's'} left alone` : ''}.
        </p>
      )}

      {error && <p className="error">{error}</p>}
    </div>
  );
}
