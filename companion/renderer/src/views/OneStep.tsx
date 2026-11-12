import { useEffect, useState } from 'react';
import { describe } from '../useCastcade.js';

/**
 * A14 (2026-11-12): one step to a match, on the Match tab. Three pieces, all fed by `bridge.launch` (main/one-step.ts):
 * `useOneStep` (the status), `TablePicker` (the host picks a table Castcade knows, most recent first, searchable) and
 * `OneStepCard` (a link that waits for a click, the join link with its chat line, and what the table start is doing).
 */

export function useOneStep(bridge: CastcadeBridge | null): OneStepStatus | null {
  const [st, setSt] = useState<OneStepStatus | null>(null);
  useEffect(() => {
    if (!bridge) return;
    let alive = true;
    void bridge.launch.status().then(
      (s) => alive && setSt(s),
      () => undefined,
    );
    const off = bridge.launch.onStatus((s) => setSt(s));
    return () => {
      alive = false;
      off();
    };
  }, [bridge]);
  return st;
}

/** How many tables the list shows at once; the search narrows it. */
const SHOWN = 8;

export function TablePicker({ bridge, value, onChange, tableOpen }: { bridge: CastcadeBridge; value: string | null; onChange: (path: string | null) => void; tableOpen: string | null }) {
  const [tables, setTables] = useState<TableChoice[] | null>(null);
  const [search, setSearch] = useState('');
  // Browse: the other .vpx files of the tables folder, loaded when asked for.
  const [others, setOthers] = useState<TableChoice[] | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const browse = () => {
    setBrowsing(true);
    void bridge.launch.browse().then(
      (t) => setOthers(t),
      () => setOthers([]),
    );
  };
  useEffect(() => {
    let alive = true;
    void bridge.launch.tables().then(
      (t) => alive && setTables(t),
      () => alive && setTables([]),
    );
    return () => {
      alive = false;
    };
  }, [bridge]);

  if (tableOpen) {
    return <p className="muted">Open now: {tableOpen}. Host uses this table and starts nothing.</p>;
  }
  if (tables === null) return null;
  const all = [...tables, ...(others ?? [])];
  if (all.length === 0) {
    return (
      <p className="muted">
        {others === null ? 'Castcade knows no table yet (Settings → Import tables). ' : 'No table file found in your tables folder. '}Host still works: open the table in VPX
        yourself, before or after.{' '}
        {others === null && (
          <button type="button" className="small" disabled={browsing} onClick={browse}>
            Browse…
          </button>
        )}
      </p>
    );
  }
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = all.filter((t) => words.every((w) => t.name.toLowerCase().includes(w) || (t.rom ?? '').toLowerCase().includes(w)));
  const picked = all.find((t) => t.path === value) ?? null;
  return (
    <div className="field">
      <span>Table to start</span>
      <input type="search" value={search} placeholder={`Search ${all.length} tables`} onChange={(e) => setSearch(e.target.value)} />
      <select size={Math.min(SHOWN, Math.max(2, hits.length + 1))} value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}>
        <option value="">No table: I open it myself</option>
        {hits.map((t) => (
          <option key={t.path} value={t.path}>
            {t.name}
            {t.lastPlayedAt ? ' · played here' : ''}
            {t.imported ? '' : ' · not imported'}
          </option>
        ))}
      </select>
      <small>
        {picked
          ? `Host starts VPX on ${picked.name} and copies the join link.${picked.imported ? '' : ' Castcade has not patched this table: if it cannot report ball ends, the lobby says so and Start asks you to confirm.'}`
          : 'Pick a table and Host starts it in VPX for you.'}
      </small>
      {others === null ? (
        <button type="button" className="small" disabled={browsing} onClick={browse}>
          Browse… (tables Castcade has not imported)
        </button>
      ) : (
        <small>{others.length === 0 ? 'No other table file in your tables folder.' : `${others.length} more from your tables folder, marked "not imported".`}</small>
      )}
    </div>
  );
}

export function OneStepCard({ bridge, one, role, phase }: { bridge: CastcadeBridge; one: OneStepStatus | null; role: MatchStatus['role']; phase: MatchStatus['phase'] }) {
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<'link' | 'message' | null>(null);
  if (!one) return null;
  const call = (p: Promise<unknown>) => void p.then(() => setError(null), (e: unknown) => setError(describe(e)));
  const copy = (what: 'link' | 'message') => {
    call(bridge.launch.copy(what));
    setCopied(what);
    setTimeout(() => setCopied(null), 2000);
  };
  const { pending, launch } = one;
  const showLink = role === 'host' && phase === 'lobby' && one.link !== null;
  const showLaunch = launch.state !== 'idle' && launch.detail !== null;
  if (!pending && !one.notice && !showLink && !showLaunch && !error) return null;
  return (
    <div className="card">
      {pending && (
        <>
          <strong>Join this match?</strong>
          <p>
            A link asks Castcade to join match {pending.code}
            {pending.address ? ` at ${pending.address}` : ' through ArcAid'}. Joining turns your microphone on for the other players and starts the host&apos;s table in VPX.
            Only join a match someone you know sent you.
          </p>
          <button type="button" className="primary" onClick={() => call(bridge.launch.confirm())}>
            Join and start the table
          </button>{' '}
          <button type="button" onClick={() => call(bridge.launch.dismiss())}>
            Not now
          </button>
        </>
      )}
      {one.notice && <p className="warn">{one.notice}</p>}
      {showLink && (
        <>
          <strong>Join link</strong>
          <div className="row">
            <code className="mono invite">{one.link}</code>
            <button type="button" className="small" onClick={() => copy('link')}>
              {copied === 'link' ? 'Copied' : 'Copy'}
            </button>
          </div>
          <p className="muted">{one.copied ? 'The link is on your clipboard. ' : ''}A player with Castcade opens it and lands in this match with the table started.</p>
          <div className="row">
            <code className="mono invite">{one.message}</code>
            <button type="button" className="small" onClick={() => copy('message')}>
              {copied === 'message' ? 'Copied' : 'Copy for chat'}
            </button>
          </div>
          <p className="muted">Discord shows a castcade:// link as plain text, so this line says what to do with it.</p>
        </>
      )}
      {showLaunch && <p className={launch.state === 'failed' || launch.state === 'needed' ? 'warn' : 'muted'}>{launch.detail}</p>}
      {error && <p className="warn">{error}</p>}
    </div>
  );
}
