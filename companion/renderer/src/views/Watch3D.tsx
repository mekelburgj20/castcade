import { useEffect, useState } from 'react';
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
      <div className="card">
        <strong>3D watch</strong>
        <p>Connecting to ArcAid…</p>
      </div>
    );
  }

  if (st.state !== 'on') {
    return (
      <div className="card">
        <strong>3D watch (test)</strong>
        <p className="muted">
          Watch another player&apos;s table in your own VPX, from your own view (in VR, with your own head). Both PCs need the Castcade VPX build and the same table file. No voice here: use Discord.
        </p>
        {st.ended && <p className="warn">The 3D watch session ended: {st.ended}.</p>}
        {st.fork.line && <p className="warn">{st.fork.line}</p>}
        <fieldset disabled={busy}>
          <div className="row">
            <button type="button" className="primary" onClick={() => void run(() => bridge.watch.host())}>
              Host a 3D watch session
            </button>
          </div>
          <label className="field">
            <span>Or join one with its code</span>
            <input type="text" maxLength={16} value={code} placeholder="The six letters, like JHDFEF" onChange={(e) => setCode(e.target.value.toUpperCase())} />
          </label>
          <button type="button" disabled={!code.trim()} onClick={() => void run(() => bridge.watch.join(code))}>
            Join
          </button>
        </fieldset>
        {shownError && <p className="warn">{shownError}</p>}
      </div>
    );
  }

  const p = st.player;
  const others = st.members.filter((m) => !m.me);
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
  return (
    <div className="card">
      <strong>3D watch session</strong>
      <div className="row">
        <code className="mono invite">{st.code}</code>
        <button type="button" className="small" onClick={copyCode}>
          {copied ? 'Copied' : 'Copy code'}
        </button>
      </div>
      {st.role === 'host' && others.length === 0 && <p>Send the code to the other player: they join it here, under 3D watch.</p>}
      {st.members.map((m) => (
        <p key={m.id} className={m.path === 'no_path' ? 'warn' : m.me ? 'muted' : undefined}>
          {m.name}
          {m.host ? ' (host)' : ''}: {m.line}
        </p>
      ))}
      {st.relayLine && <p className="muted">{st.relayLine}</p>}
      {others.some((m) => m.path === 'no_path') && <p className="muted">Without a direct path there is no stream: a relay for that case is not built yet.</p>}

      <p className="turn-line">{!p ? 'Nobody is playing a table yet.' : p.me ? `You are playing ${p.table}.` : `${p.name} is playing ${p.table}.`}</p>
      {st.local.vpx === 'watching' && <p className="muted">You are watching in VPX ({st.local.table}). Close that table to stop watching.</p>}
      {st.local.vpx === 'playing' && <p className="muted">Close the table in VPX when you are done: then someone else can play.</p>}
      {st.fork.line && <p className="warn">{st.fork.line}</p>}
      {p && !p.me && st.local.vpx === 'none' && st.watchTable && <p className={st.watchTable.warn ? 'warn' : 'muted'}>{st.watchTable.line}</p>}

      <fieldset disabled={busy}>
        <div className="row">
          {!p && st.local.vpx === 'none' && (
            <button type="button" className="primary" onClick={() => pickAnd((path) => bridge.watch.play(path))}>
              Play a table…
            </button>
          )}
          {p && !p.me && st.local.vpx === 'none' && (
            <>
              <button type="button" className="primary" disabled={!st.watchTable?.path} onClick={() => void run(() => bridge.watch.watch(null))}>
                Watch
              </button>
              <button type="button" onClick={() => pickAnd((path) => bridge.watch.watch(path))}>
                {st.watchTable?.path ? 'Watch another copy…' : 'Pick your copy and watch…'}
              </button>
            </>
          )}
          <button type="button" className="small" onClick={() => void run(() => bridge.watch.leave())}>
            Leave
          </button>
        </div>
      </fieldset>
      {shownError && <p className="warn">{shownError}</p>}
      <p className="muted">No voice in this session: use Discord.</p>
    </div>
  );
}
