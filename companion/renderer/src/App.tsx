import { useEffect, useState } from 'react';
import { useCastcade } from './useCastcade.js';
import { Pairing } from './views/Pairing.js';
import { Settings } from './views/Settings.js';
import { Status } from './views/Status.js';

type View = 'pairing' | 'status' | 'settings';

const TABS: ReadonlyArray<{ id: View; label: string }> = [
  { id: 'pairing', label: 'Pairing' },
  { id: 'status', label: 'Status' },
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
      {current === 'settings' && <Settings state={state} />}
    </main>
  );
}
