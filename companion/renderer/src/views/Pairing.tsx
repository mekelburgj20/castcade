import { useState, type FormEvent } from 'react';
import { describe, type CastcadeState } from '../useCastcade.js';

export function Pairing({ state }: { state: CastcadeState }) {
  const { bridge, status, settings } = state;
  const [code, setCode] = useState('');
  const [label, setLabel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const paired = status?.paired ?? settings?.hasToken ?? false;
  const accountUrl = `${settings?.arcaidBaseUrl ?? 'https://arcaid.app'}/account`;
  const shownLabel = label ?? settings?.deviceLabel ?? '';

  async function onPair(e: FormEvent) {
    e.preventDefault();
    if (!bridge) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (label !== null && label.trim() !== settings?.deviceLabel) {
        await state.setSettings({ deviceLabel: label });
        setLabel(null);
      }
      state.applyStatus(await bridge.witness.pair(code.trim().toUpperCase()));
      setCode('');
      setNotice('Paired. Play a game; the score shows on your ArcAid board with the Witness badge.');
      await state.refreshSettings();
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }

  async function onUnpair() {
    if (!bridge) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      state.applyStatus(await bridge.witness.unpair());
      await state.refreshSettings();
      setNotice('Unpaired on this PC. Revoke the device in ArcAid Account Settings too.');
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }

  async function onLabelBlur() {
    if (label === null) return;
    const next = label.trim();
    if (next === '' || next === settings?.deviceLabel) {
      setLabel(null);
      return;
    }
    try {
      await state.setSettings({ deviceLabel: next });
      setLabel(null);
    } catch (err) {
      setError(describe(err));
    }
  }

  return (
    <section className="view">
      <h2>Pairing</h2>
      <p className="muted">
        Castcade reports your last-game VPX scores to ArcAid as a <em>witness device</em>. Pair it once with a code
        from your ArcAid account.
      </p>

      <label className="field">
        <span>Device label</span>
        <input
          type="text"
          value={shownLabel}
          maxLength={64}
          placeholder="This PC"
          onChange={(e) => setLabel(e.target.value)}
          onBlur={() => void onLabelBlur()}
          disabled={!bridge || busy}
        />
        <small>Shown in ArcAid's device list. Defaults to the machine name.</small>
      </label>

      {paired ? (
        <div className="card">
          <p className="ok">Paired with {settings?.arcaidBaseUrl ?? 'ArcAid'}</p>
          <button type="button" onClick={() => void onUnpair()} disabled={!bridge || busy}>
            Unpair
          </button>
        </div>
      ) : (
        <form className="card" onSubmit={(e) => void onPair(e)}>
          <label className="field">
            <span>Pairing code</span>
            <input
              type="text"
              className="code"
              value={code}
              inputMode="text"
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              maxLength={6}
              placeholder="ABC123"
              onChange={(e) => setCode(e.target.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase())}
              disabled={!bridge || busy}
            />
          </label>
          <button
            type="button"
            disabled={!bridge || busy}
            onClick={() =>
              void bridge?.app.clipboardText().then(
                (t) => setCode(t.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 6)),
                (e: unknown) => setError(describe(e)),
              )
            }
          >
            Paste
          </button>{' '}
          <button type="submit" disabled={!bridge || busy || code.length !== 6}>
            {busy ? 'Pairing…' : 'Pair'}
          </button>
          <p className="muted">
            Get a code at{' '}
            <a
              href={accountUrl}
              onClick={(e) => {
                e.preventDefault();
                void bridge?.app.openExternal(accountUrl);
              }}
            >
              {accountUrl}
            </a>{' '}
            (Account Settings → Witness pairing code).
          </p>
        </form>
      )}

      {error && <p className="error">{error}</p>}
      {notice && <p className="ok">{notice}</p>}
      {!bridge && <p className="error">Bridge unavailable: this page is not running inside Castcade.</p>}
    </section>
  );
}
