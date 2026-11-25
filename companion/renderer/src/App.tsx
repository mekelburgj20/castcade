import { useEffect, useRef, useState } from 'react';
import { Lamp, PageTitle } from './parts/PageTitle.js';
import { Screen, TabBar } from './parts/Screen.js';
import { ToastProvider, useToaster } from './parts/Toast.js';
import { useCastcade } from './useCastcade.js';
import { Match } from './views/Match.js';
import { Pairing } from './views/Pairing.js';
import { Settings } from './views/Settings.js';
import { Status } from './views/Status.js';
import { Stream } from './views/Stream.js';
import { UpdateBanner } from './views/UpdateBanner.js';

type View = 'pairing' | 'status' | 'stream' | 'match' | 'settings';

const TABS: ReadonlyArray<{ id: View; label: string }> = [
  { id: 'pairing', label: 'Pairing' },
  { id: 'status', label: 'Status' },
  { id: 'stream', label: 'Stream' },
  { id: 'match', label: 'Match' },
  { id: 'settings', label: 'Settings' },
];

/** E10: the Witness edition (Castcade-Witness-Setup) has no streaming and no matches: these tabs only. */
const WITNESS_TABS: ReadonlySet<View> = new Set<View>(['pairing', 'status', 'settings']);

export function App() {
  const state = useCastcade();
  const [view, setView] = useState<View | null>(null);
  const { bridge } = state;
  const witness = bridge?.edition === 'witness';
  const tabs = witness ? TABS.filter((t) => WITNESS_TABS.has(t.id)) : TABS;

  // First paint: land on Status when already paired, Pairing otherwise. Only decided once.
  useEffect(() => {
    if (view === null && state.status) setView(state.status.paired ? 'status' : 'pairing');
  }, [view, state.status]);

  const current: View = view !== null && tabs.some((t) => t.id === view) ? view : 'pairing';

  // A14 (2026-11-12): a `castcade://` join link brings up the Match tab (main counts them in `attention`; one that
  // came with a cold start is already waiting when this mounts). Main is told when the Match tab is showing: a link
  // from outside acts without a click only then. E10: not in the Witness edition (no matches, no link).
  const seen = useRef<number | null>(null);
  useEffect(() => {
    if (!bridge || witness) return;
    const note = (s: OneStepStatus) => {
      if (seen.current === null ? s.pending !== null || s.notice !== null : s.attention !== seen.current) setView('match');
      seen.current = s.attention;
    };
    void bridge.launch.status().then(note, () => undefined);
    return bridge.launch.onStatus(note);
  }, [bridge, witness]);
  useEffect(() => {
    if (!bridge || witness) return;
    void bridge.launch.viewing(current === 'match').catch(() => undefined);
  }, [bridge, witness, current]);
  // The witness's state in the title row: the lamp and its word (it was a dot in colour only). Watching is fine
  // (cyan); not watching is a problem (the kit's red: aw-theme-ext.css names "not watching" as one).
  const lamp = state.status ? (
    <Lamp tone={state.status.running ? 'ok' : 'problem'}>{state.status.running ? 'Watching' : 'Paused'}</Lamp>
  ) : undefined;
  const toaster = useToaster();

  return (
    <ToastProvider api={toaster.api}>
      <Screen
        title={<PageTitle name="Castcade" sub={witness ? 'Witness edition' : undefined} end={lamp} />}
        tabs={<TabBar items={tabs} current={current} onSelect={setView} />}
        overlays={toaster.overlay}
      >
        <UpdateBanner bridge={bridge} />
        {current === 'pairing' && <Pairing state={state} />}
        {current === 'status' && <Status state={state} />}
        {current === 'stream' && <Stream state={state} />}
        {current === 'match' && <Match state={state} />}
        {current === 'settings' && <Settings state={state} />}
      </Screen>
    </ToastProvider>
  );
}
