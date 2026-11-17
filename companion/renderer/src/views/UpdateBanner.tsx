import { useEffect, useState } from 'react';
import { describe } from '../useCastcade.js';

/**
 * E9 (2026-11-16): a downloaded update, above every tab. Restart and update closes Castcade in order; the installer shows
 * its progress and starts Castcade again. It waits (and says why) while a table is open, during a match, a 3D watch
 * session or a recording. Quitting never installs: the next start does, before anything else.
 */
export function UpdateBanner({ bridge }: { bridge: CastcadeBridge | null }) {
  const [st, setSt] = useState<UpdateStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!bridge?.app.update) return;
    let alive = true;
    const off = bridge.app.update.onStatus((s) => alive && setSt(s));
    void bridge.app.update.status().then((s) => alive && setSt(s), () => undefined);
    return () => {
      alive = false;
      off();
    };
  }, [bridge]);

  if (!bridge || !st?.ready) return null;

  async function install() {
    if (!bridge) return;
    setError(null);
    try {
      setSt(await bridge.app.update.install());
    } catch (e) {
      setError(describe(e));
    }
  }

  if (st.installing) {
    return (
      <div className="banner update-banner" role="status">
        <strong>Installing Castcade {st.ready}.</strong> Castcade is closing; the installer opens, shows its progress and starts Castcade again when it is done.
      </div>
    );
  }
  return (
    <div className="banner update-banner" role="status">
      <div className="row">
        <span>
          <strong>Castcade {st.ready} is ready to install.</strong>
        </span>
        <button type="button" className="small" disabled={st.waiting !== null} onClick={() => void install()}>
          Restart and update
        </button>
      </div>
      {st.lastAttempt === 'not_started' && <p className="warn">Castcade could not start the installer of {st.ready} last time.</p>}
      {st.lastAttempt === 'not_finished' && <p className="warn">The install of {st.ready} did not finish last time (the installer was closed or failed).</p>}
      <p className="muted">
        {st.waiting
          ? `It waits ${st.waiting}: Castcade never restarts during a game, a match or a 3D watch session.`
          : 'Castcade closes, the installer shows its progress for about a minute, then Castcade starts again.'}{' '}
        Quitting does not install it; the next start does.
      </p>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
