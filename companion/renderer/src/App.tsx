import { useEffect, useRef, useState } from 'react';
import { useCastcade } from './useCastcade.js';
import { Match } from './views/Match.js';
import { Pairing } from './views/Pairing.js';
import { Settings } from './views/Settings.js';
import { Status } from './views/Status.js';
import { Stream } from './views/Stream.js';

type View = 'pairing' | 'status' | 'stream' | 'match' | 'settings';

const TABS: ReadonlyArray<{ id: View; label: string }> = [
  { id: 'pairing', label: 'Pairing' },
  { id: 'status', label: 'Status' },
  { id: 'stream', label: 'Stream' },
  { id: 'match', label: 'Match' },
  { id: 'settings', label: 'Settings' },
];

export function App() {
  const state = useCastcade();
  const [view, setView] = useState<View | null>(null);

  // First paint: land on Status when already paired, Pairing otherwise. Only decided once.
  useEffect(() => {
    if (view === null && state.status) setView(state.status.paired ? 'status' : 'pairing');
  }, [view, state.status]);

  const current: View = view ?? 'pairing';

  // A14 (2026-11-12): a `castcade://` join link brings up the Match tab (main counts them in `attention`; one that
  // came with a cold start is already waiting when this mounts). Main is told when the Match tab is showing: a link
  // from outside acts without a click only then.
  const { bridge } = state;
  const seen = useRef<number | null>(null);
  useEffect(() => {
    if (!bridge) return;
    const note = (s: OneStepStatus) => {
      if (seen.current === null ? s.pending !== null || s.notice !== null : s.attention !== seen.current) setView('match');
      seen.current = s.attention;
    };
    void bridge.launch.status().then(note, () => undefined);
    return bridge.launch.onStatus(note);
  }, [bridge]);
  useEffect(() => {
    if (!bridge) return;
    void bridge.launch.viewing(current === 'match').catch(() => undefined);
  }, [bridge, current]);
  const dot = state.status ? (state.status.running ? 'dot on' : 'dot off') : 'dot';

  return (
    <main className="shell">
      <header className="top">
        <h1>
          <span className={dot} aria-hidden="true" /> Castcade
        </h1>
        <nav className="tabs" aria-label="Views">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={t.id === current ? 'tab active' : 'tab'}
              onClick={() => setView(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </header>
      {current === 'pairing' && <Pairing state={state} />}
      {current === 'status' && <Status state={state} />}
      {current === 'stream' && <Stream state={state} />}
      {current === 'match' && <Match state={state} />}
      {current === 'settings' && <Settings state={state} />}
    </main>
  );
}
