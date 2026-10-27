import { useEffect, useState } from 'react';
import { describe, type CastcadeState } from '../useCastcade.js';

const ACTION_LABEL: Record<TablesPlanAction, string> = {
  patch: 'will be patched',
  repatch: 'will be re-patched (table changed or older patch)',
  already: 'already patched',
  skip: 'skipped for now',
  foreign: 'left alone (another script sits beside the table)',
  unsupported: 'unsupported',
  unreadable: "not patched: this machine's live score can't be read yet",
};

const ACTION_ORDER: TablesPlanAction[] = ['patch', 'repatch', 'already', 'unreadable', 'skip', 'foreign', 'unsupported'];

/**
 * The folder import for live scores (WORK C7, C8): one button patches the folder (it plans and applies
 * in one go, with progress); "Preview" is the dry run for anyone who wants to see the list first.
 * Every table with a ROM whose live score Castcade can read (B12) gets a same-basename sidecar `.vbs` and the shared library goes into the VPX
 * `scripts\` folder. Originals are skipped until their recipes exist; a foreign `.vbs` is never touched.
 */
export function ImportTables({ state }: { state: CastcadeState }) {
  const { bridge, settings } = state;
  const [defaults, setDefaults] = useState<TablesDefaults | null>(null);
  const [dir, setDir] = useState('');
  const [plan, setPlan] = useState<TablesPlan | null>(null);
  const [applied, setApplied] = useState<TablesApplyResult | null>(null);
  const [removed, setRemoved] = useState<TablesRemoveResult | null>(null);
  const [busy, setBusy] = useState<'plan' | 'apply' | 'remove' | null>(null);
  const [progress, setProgress] = useState<TablesProgress | null>(null);
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

  useEffect(() => {
    if (!bridge) return;
    return bridge.tables.onProgress((p) => setProgress(p));
  }, [bridge]);

  const folder = dir.trim() === '' ? null : dir.trim();

  function clear() {
    setPlan(null);
    setApplied(null);
    setRemoved(null);
    setError(null);
  }

  async function run<T>(what: 'plan' | 'apply' | 'remove', fn: () => Promise<T>, done: (r: T) => void) {
    if (!bridge) return;
    setBusy(what);
    setProgress(null);
    setError(null);
    try {
      done(await fn());
    } catch (e) {
      setError(describe(e));
    } finally {
      setBusy(null);
      setProgress(null);
    }
  }

  const canRun = !!bridge && busy === null && (folder !== null || !!defaults?.tablesDir);
  const toPatch = plan ? plan.counts.patch + plan.counts.repatch : 0;
  const listed = plan ? (showAll ? plan.items : plan.items.filter((i) => i.action !== 'already')) : [];

  return (
    <div className="card">
      {error && (
        <p className="error banner" role="alert">
          {error}
        </p>
      )}
      <label className="field">
        <span>Import tables for live scores</span>
        <input
          type="text"
          value={dir}
          placeholder={defaults?.tablesDir ?? 'your Visual Pinball "tables" folder'}
          onChange={(e) => {
            setDir(e.target.value);
            clear();
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
                clear();
              }
            })
          }
        >
          Browse…
        </button>
        <small>
          One click patches every ROM table in this folder so every game posts its own score instead of one score when
          the table closes. The .vpx files are never changed: a Castcade script is written beside each one (delete it to
          revert), and the shared library
          {defaults?.scriptsDir ? <> goes into <span className="mono">{defaults.scriptsDir}</span></> : ' goes into the VPX scripts folder beside the tables folder'}
          {defaults?.hookVersion ? ` (hook ${defaults.hookVersion})` : ''}. Originals are skipped until their recipes exist.
        </small>
      </label>
      <div className="row">
        <button type="button" className="primary" disabled={!canRun} onClick={() => void run('apply', () => bridge!.tables.apply(folder), (r) => { setApplied(r); setPlan(null); setRemoved(null); })}>
          {busy === 'apply' ? (progress ? `Patching ${progress.done} of ${progress.total}…` : 'Patching…') : 'Patch my tables'}
        </button>
        <button type="button" className="small" disabled={!canRun} onClick={() => void run('plan', () => bridge!.tables.plan(folder), (p) => { setPlan(p); setApplied(null); setRemoved(null); })}>
          {busy === 'plan' ? 'Checking…' : 'Preview what will change'}
        </button>
        <button type="button" className="small" disabled={!canRun} onClick={() => void run('remove', () => bridge!.tables.removeAll(folder), (r) => { setRemoved(r); setPlan(null); setApplied(null); })}>
          {busy === 'remove' ? 'Removing…' : 'Remove all Castcade patches'}
        </button>
      </div>
      {busy === 'apply' && progress && (
        <p className="muted">
          {progress.done} of {progress.total}: <span className="mono">{progress.tableId}</span>
        </p>
      )}

      {applied && (
        <div className={`import-result ${applied.failed.length === 0 ? 'ok banner' : 'banner'}`}>
          <p>
            <strong>Done.</strong> Patched {applied.patched.length} table{applied.patched.length === 1 ? '' : 's'}
            {applied.already > 0 ? `, ${applied.already} already current` : ''}
            {applied.skipped > 0 ? `, ${applied.skipped} left as they were (originals, unsupported, or a machine whose live score can't be read yet)` : ''}
            {applied.unpatched > 0 ? `; removed Castcade's earlier patch from ${applied.unpatched} of those (their live score can't be read yet)` : ''}; library {applied.libInstalled} in{' '}
            <span className="mono">{applied.scriptsDir}</span>.
          </p>
          <p>
            {applied.patched.length + applied.already > 0
              ? 'Now launch a table and play: the Status page shows "Capture: live" and every game posts as it ends. A table that was open while you patched needs to be closed and reopened.'
              : 'No ROM table was found to patch in this folder. Check that it is the folder holding your .vpx files ("Preview what will change" lists what Castcade sees).'}
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

      {plan && (
        <div className="import-result">
          <p>
            <span className="mono">{plan.dir}</span>:{' '}
            {ACTION_ORDER.filter((a) => plan.counts[a] > 0)
              .map((a) => `${plan.counts[a]} ${ACTION_LABEL[a]}`)
              .join(' · ') || 'no .vpx files found'}
            . Nothing has been written yet{toPatch > 0 ? '; "Patch my tables" writes it' : ''}.
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

      {removed && (
        <p className="import-result">
          Removed {removed.removed.length} Castcade patch{removed.removed.length === 1 ? '' : 'es'} under <span className="mono">{removed.dir}</span>
          {removed.keptForeign.length > 0 ? `; ${removed.keptForeign.length} other script${removed.keptForeign.length === 1 ? '' : 's'} left alone` : ''}.
        </p>
      )}
    </div>
  );
}
