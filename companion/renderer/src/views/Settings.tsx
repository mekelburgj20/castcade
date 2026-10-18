import { useEffect, useState, type MouseEvent } from 'react';
import { describe, type CastcadeState } from '../useCastcade.js';

const PRESETS = [
  { label: 'Production', url: 'https://arcaid.app' },
  { label: 'Local', url: 'http://localhost:3001' },
] as const;

const PROJECT_URL = 'https://github.com/mekelburgj20/castcade';

export function Settings({ state }: { state: CastcadeState }) {
  const { bridge, settings, versions, loginItem, status, logPath } = state;
  const [url, setUrl] = useState('');
  const [nvram, setNvram] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    if (settings) {
      setUrl(settings.arcaidBaseUrl);
      setNvram(settings.nvramDir ?? '');
    }
  }, [settings]);

  async function save(patch: SettingsPatch, what: string) {
    setError(null);
    setSaved(null);
    try {
      await state.setSettings(patch);
      setSaved(`${what} saved`);
    } catch (e) {
      setError(describe(e));
    }
  }

  const urlDirty = settings !== null && url.trim().replace(/\/+$/, '') !== settings.arcaidBaseUrl;
  const nvramDirty = settings !== null && nvram.trim() !== (settings.nvramDir ?? '');

  const open = (href: string) => (e: MouseEvent) => {
    e.preventDefault();
    void bridge?.app.openExternal(href);
  };

  return (
    <section className="view">
      <h2>Settings</h2>

      <div className="card">
        <label className="field">
          <span>ArcAid URL</span>
          <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} disabled={!bridge} spellCheck={false} />
          <small>
            Presets:{' '}
            {PRESETS.map((p) => (
              <button type="button" className="link" key={p.url} onClick={() => setUrl(p.url)}>
                {p.label}
              </button>
            ))}
            — the pairing token only works on the server that issued it.
          </small>
        </label>
        <button type="button" disabled={!bridge || !urlDirty} onClick={() => void save({ arcaidBaseUrl: url }, 'ArcAid URL')}>
          Save URL
        </button>
      </div>

      <div className="card">
        <label className="field">
          <span>VPinMAME NVRAM folder (override)</span>
          <input
            type="text"
            value={nvram}
            placeholder="auto-detect from the registry"
            onChange={(e) => setNvram(e.target.value)}
            disabled={!bridge}
            spellCheck={false}
          />
          <small>Leave empty to auto-detect. Set it only if Status shows "NVRAM dir: not found".</small>
        </label>
        <button
          type="button"
          disabled={!bridge || !nvramDirty}
          onClick={() => void save({ nvramDir: nvram.trim() === '' ? null : nvram.trim() }, 'NVRAM folder')}
        >
          Save folder
        </button>
      </div>

      <div className="card">
        <label className="check">
          <input
            type="checkbox"
            checked={loginItem?.openAtLogin ?? false}
            disabled={!bridge || !loginItem?.supported}
            onChange={(e) => void state.setLoginItem(e.target.checked)}
          />
          <span>Start with Windows (hidden in the tray)</span>
        </label>
        {loginItem && !loginItem.supported && <small className="muted">Available in the installed app only.</small>}
      </div>

      {error && <p className="error">{error}</p>}
      {saved && <p className="ok">{saved}</p>}

      <h3>About</h3>
      <dl className="facts">
        <dt>Castcade</dt>
        <dd>
          {versions?.app ?? bridge?.appVersion ?? '?'} ·{' '}
          <a href={PROJECT_URL} onClick={open(PROJECT_URL)}>
            source
          </a>
        </dd>
        <dt>Protocol</dt>
        <dd>v{versions?.protocol ?? bridge?.protocolVersion ?? '?'}</dd>
        <dt>Runtime</dt>
        <dd>
          Electron {versions?.electron ?? '?'} · Chrome {versions?.chrome ?? '?'} · Node {versions?.node ?? '?'}
        </dd>
        <dt>License</dt>
        <dd>GNU GPL v3 (GPL-3.0-only). Nothing from VPX, VPinMAME, ROMs or tables is bundled.</dd>
        <dt>Device id</dt>
        <dd className="mono">{settings?.deviceId ?? '?'}</dd>
        <dt>Log file</dt>
        <dd className="mono" title={logPath ?? ''}>
          {logPath ?? '?'}
        </dd>
        <dt>Maps</dt>
        <dd className="mono" title={settings?.mapsDir ?? ''}>
          {settings?.mapsDir ?? '?'}
        </dd>
      </dl>
      <p className="attribution">
        ROM memory maps © tomlogic/pinmame-nvram-maps contributors, Open Database License (ODbL) v1.0. Maps
        version: {status?.mapsVersion ?? 'unknown'}.
      </p>
    </section>
  );
}
