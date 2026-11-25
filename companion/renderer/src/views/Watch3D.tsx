import { useEffect, useState } from 'react';
import { Field, Note } from '../parts/Bits.js';
import { Button } from '../parts/Button.js';
import { Panel } from '../parts/Panel.js';
import { describe } from '../useCastcade.js';

/**
 * I11.4.1 (2026-11-16, ADR 0011): the 3D watch card on the Match page, apart from any match. One PC hosts and sends
 * the code; the other joins with it. Then either one plays a table in the Castcade VPX build and the other watches it
 * in its own VPX, from its own view. Who is connected and how (directly, or no direct path between the routers), who
 * plays, Watch, Leave. No voice: the testers use Discord.
 */

export function useWatch(bridge: CastcadeBridge | null): WatchStatus | null {
  const [st, setSt] = useState<WatchStatus | null>(null);
  useEffect(() => {
    if (!bridge?.watch) return;
    let alive = true;
    void bridge.watch.status().then(
      (s) => alive && setSt(s),
      () => undefined,
    );
    const off = bridge.watch.onStatus((s) => setSt(s));
    return () => {
      alive = false;
      off();
    };
  }, [bridge]);
  return st;
}

/** True while the session holds this PC's ArcAid room: the match's Host and Join wait. */
export const watchHoldsRoom = (w: WatchStatus | null): boolean => w?.state === 'on' || w?.state === 'connecting';

export function WatchCard({ bridge, st }: { bridge: CastcadeBridge; st: WatchStatus | null }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  if (!st) return null;

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(describe(e));
    } finally {
      setBusy(false);
    }
  };
  const shownError = error ?? st.error;
  const pickAnd = (then: (path: string) => Promise<WatchStatus>) =>
    void run(async () => {
      const path = await bridge.watch.pickTable();
      if (path) await then(path);
    });

  if (st.state === 'connecting') {
    return (
      <Panel title="3D watch">
        <p className="cc-text">Connecting to ArcAid…</p>
      </Panel>
    );
  }

  if (st.state !== 'on') {
    const paste = () =>
      void bridge.app.clipboardText().then((t) => {
        const v = t.trim();
        if (/^[A-Za-z]{6}$/.test(v)) {
          setError(null);
          setCode(v.toUpperCase());
        } else setError('The clipboard does not hold a session code (six letters).');
      }, (e: unknown) => setError(describe(e)));
    return (
      <Panel title="3D watch (test)">
        <p className="cc-help">
          Watch the other player&apos;s table in your own VPX, from your own view (in VR, with your own head). Both PCs need the Castcade VPX build (VPinballX_GL64_castcade.exe, beside your
          VPinballX_GL64.exe) and the same table file. No voice here: use Discord.
        </p>
        {st.ended && <Note state="attention">The 3D watch session ended: {st.ended}.</Note>}
        {st.fork.line && <Note state="attention">{st.fork.line}</Note>}
        <fieldset disabled={busy}>
          <div className="cc-row">
            <Button onClick={() => void run(() => bridge.watch.host())}>Host a session</Button>
          </div>
          <Field label="Or join one: the code from the host" htmlFor="watch-join-code" line>
            <input id="watch-join-code" type="text" className="cc-input" maxLength={16} value={code} placeholder="The six letters, like JHDFEF" onChange={(e) => setCode(e.target.value.toUpperCase())} />
            <Button variant="secondary" size="sm" onClick={paste}>
              Paste
            </Button>
          </Field>
          <div className="cc-row">
            <Button disabled={!code.trim()} onClick={() => void run(() => bridge.watch.join(code))}>
              Join
            </Button>
          </div>
        </fieldset>
        {shownError && shownError !== st.fork.line && <Note state="attention">{shownError}</Note>}
      </Panel>
    );
  }

  const p = st.player;
  const others = st.members.filter((m) => !m.me);
  const tableName = (file: string) => file.replace(/\.vpx$/i, '');
  const copyCode = () => {
    if (!st.code) return;
    void navigator.clipboard.writeText(st.code).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      },
      (e: unknown) => setError(describe(e)),
    );
  };
  const found = st.watchTable?.path ?? null;
  return (
    <Panel title="3D watch session">
      <div className="cc-field__line">
        <code className="cc-code cc-grow">{st.code}</code>
        <Button variant="secondary" size="sm" onClick={copyCode}>
          {copied ? 'Copied' : 'Copy code'}
        </Button>
      </div>
      {others.length === 0 && <p className="cc-help">Nobody has joined yet. Send the code to the other player: they join it on their Match tab, under 3D watch.</p>}
      {others.map((m) => {
        const words = (
          <>
            <span className="cc-display">{m.name}</span>
            {m.host ? ' (host)' : ''}: {m.line}
          </>
        );
        return m.path === 'no_path' ? (
          <Note key={m.id} state="attention">
            {words}
          </Note>
        ) : (
          <p key={m.id} className="cc-text">
            {words}
          </p>
        );
      })}
      {others.some((m) => m.path === 'no_path') && <p className="cc-help">Your two routers block a direct connection, so the table cannot stream between you. Castcade cannot get around that yet.</p>}
      {st.relayLine && <p className="cc-help">{st.relayLine}</p>}

      <p className="cc-text">
        <strong className="cc-strong">{!p ? 'Nobody is playing a table yet.' : p.me ? `You are playing ${tableName(p.table)}.` : `${p.name} is playing ${tableName(p.table)}.`}</strong>
      </p>
      {!p && st.local.vpx === 'none' && <p className="cc-help">Either of you can play: the others then watch. Close the table to let someone else play.</p>}
      {st.local.vpx === 'watching' && <p className="cc-help">You are watching in VPX. Close that table to stop watching.</p>}
      {st.local.vpx === 'playing' && <p className="cc-help">Close the table in VPX when you are done: then someone else can play.</p>}
      {st.fork.line && <Note state="attention">{st.fork.line}</Note>}
      {p && !p.me && st.local.vpx === 'none' && st.watchTable && (st.watchTable.warn ? <Note state="attention">{st.watchTable.line}</Note> : <p className="cc-help">{st.watchTable.line}</p>)}

      <fieldset disabled={busy}>
        <div className="cc-row">
          {!p && st.local.vpx === 'none' && <Button onClick={() => pickAnd((path) => bridge.watch.play(path))}>Play a table…</Button>}
          {p && !p.me && st.local.vpx === 'none' && found && <Button onClick={() => void run(() => bridge.watch.watch(null))}>Watch</Button>}
          {/* Not found, or not the same size: the player picks the copy to open. */}
          {p && !p.me && st.local.vpx === 'none' && (!found || st.watchTable?.warn) && (
            <Button variant={found ? 'secondary' : 'primary'} onClick={() => pickAnd((path) => bridge.watch.watch(path))}>
              {found ? 'Pick another copy…' : 'Pick your copy and watch…'}
            </Button>
          )}
          <Button variant="secondary" size="sm" className="cc-row__push" onClick={() => void run(() => bridge.watch.leave())}>
            Leave
          </Button>
        </div>
      </fieldset>
      {shownError && shownError !== st.fork.line && <Note state="attention">{shownError}</Note>}
      <p className="cc-help">No voice in this session: use Discord.</p>
    </Panel>
  );
}
