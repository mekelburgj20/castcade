import { useState, type FormEvent } from 'react';
import { Field, Note } from '../parts/Bits.js';
import { Button } from '../parts/Button.js';
import { Panel, PanelGroup } from '../parts/Panel.js';
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
    <PanelGroup
      id="pairing"
      title="Pairing"
      sub={
        <>
          Castcade reports your last-game VPX scores to ArcAid as a <em>witness device</em>. Pair it once with a code
          from your ArcAid account.
        </>
      }
    >
      <Panel title={<label htmlFor="pair-label">Device label</label>}>
        <Field help="Shown in ArcAid's device list. Defaults to the machine name.">
          <input
            id="pair-label"
            type="text"
            className="cc-input"
            value={shownLabel}
            maxLength={64}
            placeholder="This PC"
            onChange={(e) => setLabel(e.target.value)}
            onBlur={() => void onLabelBlur()}
            disabled={!bridge || busy}
          />
        </Field>
      </Panel>

      {paired ? (
        <Panel>
          <Note state="ok">Paired with {settings?.arcaidBaseUrl ?? 'ArcAid'}</Note>
          <div className="cc-row">
            <Button variant="danger" onClick={() => void onUnpair()} disabled={!bridge || busy}>
              Unpair
            </Button>
          </div>
        </Panel>
      ) : (
        <Panel title={<label htmlFor="pair-code">Pairing code</label>}>
          <form className="cc-stack" onSubmit={(e) => void onPair(e)}>
            <input
              id="pair-code"
              type="text"
              className="cc-input cc-input--code"
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
            <div className="cc-row">
              <Button
                variant="secondary"
                disabled={!bridge || busy}
                onClick={() =>
                  void bridge?.app.clipboardText().then(
                    (t) => setCode(t.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 6)),
                    (e: unknown) => setError(describe(e)),
                  )
                }
              >
                Paste
              </Button>
              <Button type="submit" disabled={!bridge || busy || code.length !== 6}>
                {busy ? 'Pairing…' : 'Pair'}
              </Button>
            </div>
            <p className="cc-help">
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
        </Panel>
      )}

      {(error || notice || !bridge) && (
        <div className="cc-stack cc-panel--wide">
          {error && (
            <Note state="problem" role="alert">
              {error}
            </Note>
          )}
          {notice && <Note state="ok">{notice}</Note>}
          {!bridge && <Note state="problem">Bridge unavailable: this page is not running inside Castcade.</Note>}
        </div>
      )}
    </PanelGroup>
  );
}
