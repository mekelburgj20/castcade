import { useEffect, useState } from 'react';
import { Field, Note, Skeleton } from '../parts/Bits.js';
import { Button } from '../parts/Button.js';
import { Panel } from '../parts/Panel.js';
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
    <Panel wide title={<label htmlFor="import-dir">Import tables for live scores</label>}>
      {error && (
        <Note state="problem" role="alert">
          {error}
        </Note>
      )}
      <Field
        line
        help={
          <>
            One click patches every ROM table in this folder so every game posts its own score instead of one score when the table closes. The .vpx files are
            never changed: a Castcade script is written beside each one (delete it to revert), and the shared library
            {defaults?.scriptsDir ? (
              <>
                {' '}
                goes into <span className="cc-mono">{defaults.scriptsDir}</span>
              </>
            ) : (
              ' goes into the VPX scripts folder beside the tables folder'
            )}
            {defaults?.hookVersion ? ` (hook ${defaults.hookVersion})` : ''}. Originals are skipped until their recipes exist. Saving a patched table in the VPX
            editor copies the Castcade script into the table itself; that still works, and Castcade puts a fresh script beside the table the next time it opens
            (or when you patch again).
          </>
        }
      >
        <input
          id="import-dir"
          type="text"
          className="cc-input"
          value={dir}
          placeholder={defaults?.tablesDir ?? 'your Visual Pinball "tables" folder'}
          onChange={(e) => {
            setDir(e.target.value);
            clear();
          }}
          disabled={!bridge || busy !== null}
          spellCheck={false}
        />
        <Button
          variant="secondary"
          size="sm"
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
        </Button>
      </Field>
      <div className="cc-row">
        <Button disabled={!canRun} onClick={() => void run('apply', () => bridge!.tables.apply(folder), (r) => { setApplied(r); setPlan(null); setRemoved(null); })}>
          {busy === 'apply' ? (progress ? `Patching ${progress.done} of ${progress.total}…` : 'Patching…') : 'Patch my tables'}
        </Button>
        <Button variant="secondary" size="sm" disabled={!canRun} onClick={() => void run('plan', () => bridge!.tables.plan(folder), (p) => { setPlan(p); setApplied(null); setRemoved(null); })}>
          {busy === 'plan' ? 'Checking…' : 'Preview what will change'}
        </Button>
        <Button variant="danger" size="sm" disabled={!canRun} onClick={() => void run('remove', () => bridge!.tables.removeAll(folder), (r) => { setRemoved(r); setPlan(null); setApplied(null); })}>
          {busy === 'remove' ? 'Removing…' : 'Remove all Castcade patches'}
        </Button>
      </div>
      {busy === 'apply' && progress && (
        <p className="cc-help">
          {progress.done} of {progress.total}: <span className="cc-mono">{progress.tableId}</span>
        </p>
      )}
      {/* Loading: the list as it will come (a line, then rows), not a spinner. */}
      {busy === 'plan' && (
        <div className="cc-result" aria-busy="true">
          <Skeleton width="85%" />
          <ul className="cc-list" aria-hidden="true">
            {[72, 58, 66, 49].map((w) => (
              <li key={w}>
                <Skeleton width={`${w}%`} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {applied && (
        <div className={`cc-result ${applied.failed.length === 0 ? 'cc-result--ok' : 'cc-result--attention'}`} role="status">
          <p>
            <strong className="cc-strong">Done.</strong> Patched {applied.patched.length} table{applied.patched.length === 1 ? '' : 's'}
            {applied.already > 0 ? `, ${applied.already} already current` : ''}
            {applied.skipped > 0 ? `, ${applied.skipped} left as they were (originals, unsupported, or a machine whose live score can't be read yet)` : ''}
            {applied.unpatched > 0 ? `; removed Castcade's earlier patch from ${applied.unpatched} of those (their live score can't be read yet)` : ''}; library {applied.libInstalled} in{' '}
            <span className="cc-mono">{applied.scriptsDir}</span>.
          </p>
          <p>
            {applied.patched.length + applied.already > 0
              ? 'Now launch a table and play: the Status page shows "Capture: live" and every game posts as it ends. A table that was open while you patched needs to be closed and reopened.'
              : 'No ROM table was found to patch in this folder. Check that it is the folder holding your .vpx files ("Preview what will change" lists what Castcade sees).'}
          </p>
          {applied.failed.length > 0 && (
            <ul className="cc-list">
              {applied.failed.map((f) => (
                <li key={f.tableId}>
                  <span className="cc-list__name">{f.tableId}</span> <span className="cc-problem">— {f.error}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {plan && (
        <div className="cc-result">
          <p>
            <span className="cc-mono">{plan.dir}</span>:{' '}
            {ACTION_ORDER.filter((a) => plan.counts[a] > 0)
              .map((a) => `${plan.counts[a]} ${ACTION_LABEL[a]}`)
              .join(' · ') || 'no .vpx files found'}
            . Nothing has been written yet{toPatch > 0 ? '; "Patch my tables" writes it' : ''}.
            {/* The Arcaid look: an empty result says what to do next (the words of the empty Patch my tables result). */}
            {plan.items.length === 0 && ' Check that it is the folder holding your .vpx files.'}
          </p>
          {listed.length > 0 && (
            <ul className="cc-list">
              {listed.map((i) => (
                <li key={i.vpxPath} className={`act-${i.action}`}>
                  <span className="cc-list__name" title={i.vpxPath}>
                    {i.tableId}
                  </span>
                  <span className="cc-quiet">
                    {' '}
                    — {ACTION_LABEL[i.action]}
                    {i.rom ? ` · ROM ${i.rom}` : ''}
                    {i.action !== 'patch' && i.action !== 'repatch' && i.action !== 'already' && i.reason ? ` · ${i.reason}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {plan.counts.already > 0 && (
            <button type="button" className="cc-link" onClick={() => setShowAll((v) => !v)}>
              {showAll ? 'hide the already-patched tables' : `show the ${plan.counts.already} already-patched table${plan.counts.already === 1 ? '' : 's'}`}
            </button>
          )}
        </div>
      )}

      {removed && (
        <p className="cc-result">
          Removed {removed.removed.length} Castcade patch{removed.removed.length === 1 ? '' : 'es'} under <span className="cc-mono">{removed.dir}</span>
          {removed.keptForeign.length > 0 ? `; ${removed.keptForeign.length} other script${removed.keptForeign.length === 1 ? '' : 's'} left alone` : ''}.
        </p>
      )}
    </Panel>
  );
}
