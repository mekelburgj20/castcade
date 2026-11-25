import { useEffect, useState } from 'react';
import { Note } from '../parts/Bits.js';
import { Button } from '../parts/Button.js';
import { Panel } from '../parts/Panel.js';
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

  // The Arcaid look: a panel that wears pink (attention) above the tab, whatever tab it is.
  if (st.installing) {
    return (
      <Panel attention role="status">
        <p className="cc-text">
          <strong className="cc-strong">Installing Castcade {st.ready}.</strong> Castcade is closing; the installer opens, shows its progress and starts Castcade
          again when it is done.
        </p>
      </Panel>
    );
  }
  return (
    <Panel attention role="status">
      <div className="cc-row">
        <span className="cc-text">
          <strong className="cc-strong">Castcade {st.ready} is ready to install.</strong>
        </span>
        <Button size="sm" className="cc-row__push" disabled={st.waiting !== null} onClick={() => void install()}>
          Restart and update
        </Button>
      </div>
      {st.lastAttempt === 'not_started' && <Note state="attention">Castcade could not start the installer of {st.ready} last time.</Note>}
      {st.lastAttempt === 'not_finished' && <Note state="attention">The install of {st.ready} did not finish last time (the installer was closed or failed).</Note>}
      <p className="cc-help">
        {st.waiting
          ? `It waits ${st.waiting}: Castcade never restarts during a game${bridge.edition === 'witness' ? '' : ', a match or a 3D watch session'}.`
          : 'Castcade closes, the installer shows its progress for about a minute, then Castcade starts again.'}{' '}
        Quitting does not install it; the next start does.
      </p>
      {error && (
        <Note state="problem" role="alert">
          {error}
        </Note>
      )}
    </Panel>
  );
}
