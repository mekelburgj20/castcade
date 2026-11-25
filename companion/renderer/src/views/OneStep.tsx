import { useEffect, useState } from 'react';
import { Note, Skeleton } from '../parts/Bits.js';
import { Button } from '../parts/Button.js';
import { Panel } from '../parts/Panel.js';
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

export function TablePicker({
  bridge,
  value,
  onChange,
  tableOpen,
  startOnHost,
  pick = false,
  onChoice,
}: {
  bridge: CastcadeBridge;
  value: string | null;
  onChange: (path: string | null) => void;
  tableOpen: string | null;
  /** A14.7: Host starts the picked table too (the setting); false: Start the table does, after the invite. */
  startOnHost: boolean;
  /** A17 step 10: the picker changes the lobby's table (not what Host starts): its own words, and `onChoice` hears the table. */
  pick?: boolean;
  onChoice?: (choice: TableChoice | null) => void;
}) {
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

  if (tableOpen && !pick) {
    return <p className="cc-help">Open now: {tableOpen}. Open lobby uses this table and starts nothing.</p>;
  }
  // The Arcaid look: while the list is on its way, the picker in its shape (it was nothing, and the card jumped).
  if (tables === null) {
    return (
      <div className="cc-field" aria-busy="true">
        <Skeleton kind="label" />
        <Skeleton kind="field" />
        <Skeleton kind="field" width="100%" />
      </div>
    );
  }
  const all = [...tables, ...(others ?? [])];
  if (all.length === 0) {
    return (
      <div className="cc-stack">
        <p className="cc-help">
          {others === null ? 'Castcade knows no table yet (Settings → Import tables). ' : 'No table file found in your tables folder. '}
          {pick
            ? "So there is no table to pick here. To make a table the lobby's, open it in VPX yourself: this card then offers to make it the lobby's table."
            : 'Open lobby still works: open the table in VPX yourself, before or after.'}
        </p>
        {others === null && (
          <div className="cc-row">
            <Button size="sm" variant="secondary" disabled={browsing} onClick={browse}>
              Browse…
            </Button>
          </div>
        )}
      </div>
    );
  }
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = all.filter((t) => words.every((w) => t.name.toLowerCase().includes(w) || (t.rom ?? '').toLowerCase().includes(w)));
  const picked = all.find((t) => t.path === value) ?? null;
  const id = pick ? 'pick-table' : 'host-table';
  return (
    <div className="cc-field">
      <label className="cc-field__label" htmlFor={id}>
        {pick ? "The lobby's new table" : 'Table to start'}
      </label>
      <input type="search" className="cc-input" aria-label="Search the tables" value={search} placeholder={`Search ${all.length} tables`} onChange={(e) => setSearch(e.target.value)} />
      <select
        id={id}
        className="cc-listbox"
        size={Math.min(SHOWN, Math.max(2, hits.length + 1))}
        value={value ?? ''}
        onChange={(e) => {
          const next = e.target.value === '' ? null : e.target.value;
          onChange(next);
          onChoice?.(all.find((t) => t.path === next) ?? null);
        }}
      >
        <option value="">{pick ? 'Pick a table' : 'No table: I open it myself'}</option>
        {hits.map((t) => (
          <option key={t.path} value={t.path}>
            {t.name}
            {t.lastPlayedAt ? ' · played here' : ''}
            {t.imported ? '' : ' · not imported'}
          </option>
        ))}
      </select>
      <small className="cc-help">
        {pick
          ? picked
            ? `${picked.name} becomes the lobby's table.${picked.imported ? '' : ' Castcade has not patched this table on this PC: if it cannot report ball ends, the lobby says so and Start asks to confirm.'}`
            : 'Pick the table everyone plays next. Each PC opens its own copy of it.'
          : picked
            ? `${startOnHost ? `Open lobby starts VPX on ${picked.name} and copies the invite link.` : `Open lobby copies the invite link. Send it, then press Start the table to open ${picked.name} in VPX.`}${picked.imported ? '' : ' Castcade has not patched this table: if it cannot report ball ends, the lobby says so and Start asks you to confirm.'}`
            : 'Pick a table and Castcade starts it in VPX for you.'}
      </small>
      {others === null ? (
        <div className="cc-row">
          <Button size="sm" variant="secondary" disabled={browsing} onClick={browse}>
            Browse… (tables Castcade has not imported)
          </Button>
        </div>
      ) : (
        <small className="cc-help">{others.length === 0 ? 'No other table file in your tables folder.' : `${others.length} more from your tables folder, marked "not imported".`}</small>
      )}
    </div>
  );
}

export function OneStepCard({ bridge, one, role, phase, lobby = false }: { bridge: CastcadeBridge; one: OneStepStatus | null; role: MatchStatus['role']; phase: MatchStatus['phase']; /** A17 step 9: in a lobby the link is in the lobby's own card (Match.tsx `LobbyInvite`), on every member's tab. */ lobby?: boolean }) {
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
  const showLink = !lobby && role === 'host' && phase !== 'none' && phase !== 'connecting' && one.link !== null;
  const showLaunch = launch.state !== 'idle' && launch.detail !== null;
  // A14.7: the picked table waits here until the invite is sent.
  const toStart = role === 'host' ? one.tableToStart : null;
  // A17 step 3: the lobby's table changed and this PC has not followed yet.
  const change = one.change;
  if (!pending && !one.notice && !showLink && !showLaunch && !toStart && !change && !error) return null;
  // The Arcaid look: a card that asks for a press (a link to confirm, the table to start, a table to open) wears pink.
  const asks = pending !== null || toStart !== null || change?.state === 'offered';
  return (
    <Panel wide attention={asks} title={pending ? 'Join this lobby?' : showLink ? 'Join link' : undefined}>
      {pending && (
        <>
          <p className="cc-text">
            A link asks Castcade to join the lobby {pending.code}
            {pending.address ? ` at ${pending.address}` : ' through ArcAid'}. Joining turns your microphone on for the people in it and opens the lobby&apos;s table in VPX if
            it has one. Only join a lobby someone you know sent you.
          </p>
          <div className="cc-row">
            <Button onClick={() => call(bridge.launch.confirm())}>Join the lobby</Button>
            <Button variant="secondary" onClick={() => call(bridge.launch.dismiss())}>
              Not now
            </Button>
          </div>
        </>
      )}
      {one.notice && <Note state="attention">{one.notice}</Note>}
      {showLink && (
        <>
          <div className="cc-field__line">
            <code className="cc-mono cc-grow">{one.link}</code>
            <Button size="sm" variant="secondary" onClick={() => copy('link')}>
              {copied === 'link' ? 'Copied' : 'Copy'}
            </Button>
          </div>
          <p className="cc-help">{one.copied ? 'Invite link copied. ' : ''}Anyone with Castcade opens it and lands in this lobby with the table started.</p>
          <div className="cc-field__line">
            <code className="cc-mono cc-grow">{one.message}</code>
            <Button size="sm" variant="secondary" onClick={() => copy('message')}>
              {copied === 'message' ? 'Copied' : 'Copy for chat'}
            </Button>
          </div>
          <p className="cc-help">
            {one.link?.startsWith('https://')
              ? 'Discord makes this link clickable: it opens a page with an Open in Castcade button and the code.'
              : 'Discord shows a castcade:// link as plain text, so this line says what to do with it.'}
          </p>
        </>
      )}
      {toStart && (
        <>
          <p className="cc-text">
            <strong className="cc-strong">Next: start the table.</strong> Send the invite first, then start {toStart}. If you play in VR, this is when you put the headset on.
          </p>
          <div className="cc-row">
            <Button onClick={() => call(bridge.launch.startTable())}>Start the table</Button>
          </div>
        </>
      )}
      {showLaunch && (launch.state === 'failed' || launch.state === 'needed' ? <Note state="attention">{launch.detail}</Note> : <p className="cc-help">{launch.detail}</p>)}
      {change && (
        <>
          {change.state === 'close_it' ? <Note state="attention">{change.detail}</Note> : <p className="cc-text">{change.detail}</p>}
          {change.state === 'offered' && (
            <div className="cc-row">
              <Button onClick={() => call(bridge.launch.openPick())}>Open it</Button>
            </div>
          )}
        </>
      )}
      {error && <Note state="attention">{error}</Note>}
    </Panel>
  );
}

/**
 * A17 step 10 (2026-11-26, alpha-match.md sections 11.5 and 11.9): the lobby's table on the Match tab, and its change
 * by anyone in the lobby: `Table: <name> · picked by <who>`, **Change table…** (the picker over this PC's own
 * tables, then a question that says what the press does), and, when another table is open on this PC than the
 * lobby's, **Make <table> the lobby's table**. The lobby's PC judges every pick; what it refuses comes back as a
 * sentence. The Arcaid look: a part of the lobby's panel under a line, not a card in it.
 */
export function LobbyTable({ bridge, st, tableOpen }: { bridge: CastcadeBridge; st: MatchStatus; tableOpen: string | null }) {
  const [picking, setPicking] = useState(false);
  const [choice, setChoice] = useState<TableChoice | null>(null);
  // What the question was asked about: the table (null: the one that is open here) and the lobby as it was then.
  const [asking, setAsking] = useState<{ path: string | null; name: string; about: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const l = st.lobby;
  if (!l || l.over) return null;
  const me = l.members.find((m) => m.me);
  const off = l.table.off;
  // The question stands only while the lobby is what it was when it was asked (a game that began meanwhile takes it
  // away), and one about the table that is open here only while that table is the one that is open.
  const question = asking !== null && asking.about === l.gameKey && off === null && (asking.path !== null || asking.name === tableOpen) ? asking : null;
  // The table that is open here can be made the lobby's in one press: when it is another game than the lobby's (the
  // row then says so, or says that the lobby's table is on offer here, or that this table is the person's to close),
  // and while the lobby has no table at all.
  const another = (me?.flags ?? []).some((f) => f === 'other_table' || f === 'asked' || f === 'close_table');
  const offerOpen = tableOpen !== null && (another || l.table.name === null);
  const go = (q: { path: string | null; name: string; about: string }) => {
    setBusy(true);
    // The open table is picked by the name the question had: main refuses when another one is open by now.
    void (q.path === null ? bridge.launch.pickOpen(q.about, q.name) : bridge.launch.pick(q.path, q.about))
      .then(
        () => {
          setError(null);
          setPicking(false);
          setChoice(null);
        },
        (e: unknown) => setError(describe(e)),
      )
      .finally(() => {
        setBusy(false);
        setAsking(null);
      });
  };
  return (
    <div className="cc-lobby__table">
      <div className="cc-line">
        <span className="cc-text">
          <strong className="cc-strong">Table:</strong> {l.table.name ? <span className="cc-display">{l.table.name}</span> : "none yet (the first table opened on the lobby's PC)"}
          {l.table.pickedByName ? ` · picked by ${l.table.pickedByName}` : ''}
          {l.table.changing ? ' · tables are being changed' : ''}
        </span>
        {(!picking || offerOpen) && !question && (
          <span className="cc-row">
            {!picking && (
              <Button size="sm" variant="secondary" disabled={busy || off !== null} title={off ?? undefined} onClick={() => setPicking(true)}>
                Change table…
              </Button>
            )}
            {offerOpen && (
              <Button size="sm" variant="secondary" disabled={busy || off !== null} title={off ?? undefined} onClick={() => setAsking({ path: null, name: tableOpen ?? '', about: l.gameKey })}>
                Make {tableOpen} the lobby&apos;s table
              </Button>
            )}
          </span>
        )}
      </div>
      {off !== null && (picking || offerOpen) && <p className="cc-help">{off}</p>}
      {picking && !question && (
        <>
          <TablePicker bridge={bridge} value={choice?.path ?? null} onChange={() => undefined} onChoice={setChoice} tableOpen={tableOpen} startOnHost={false} pick />
          {/* A17 step 9: one lit button, the next thing to press; Cancel is the quiet one, and the two stand together. */}
          <div className="cc-row cc-row--end">
            <Button size="sm" disabled={busy || choice === null || off !== null} onClick={() => choice && setAsking({ path: choice.path, name: choice.name, about: l.gameKey })}>
              Change table
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setPicking(false);
                setChoice(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </>
      )}
      {/* A17 step 9: the question has the shape of every question on this tab: its words, then its answers together. */}
      {question && (
        <div className="cc-ask">
          <p>
            {/* The Arcaid-look pass: true of every PC. One set to ask first is offered the table; it closes nothing by itself. */}
            {l.table.name === null
              ? `${question.name} becomes the lobby's table: Castcade opens it on this PC and on every PC with no table open; a PC with another table open is asked first.`
              : `Castcade closes the table on each PC and opens ${question.name} there; a PC set to ask first is offered it.`}
            {l.table.endsMatch ? ' The match that is open ends.' : ''}
          </p>
          <div className="cc-row">
            <Button size="sm" disabled={busy} onClick={() => go(question)}>
              Change table
            </Button>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => setAsking(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {/* The final review: on a joined PC the pick is the lobby PC's to take: said while its answer is on the way. */}
      {busy && st.role === 'client' && <p className="cc-help">Asking the lobby&apos;s PC…</p>}
      {error && <Note state="attention">{error}</Note>}
    </div>
  );
}
