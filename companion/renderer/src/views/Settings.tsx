import { Fragment, useEffect, useState, type MouseEvent } from 'react';
import { Field, Note } from '../parts/Bits.js';
import { Button } from '../parts/Button.js';
import { Panel, PanelGroup } from '../parts/Panel.js';
import { useToast } from '../parts/Toast.js';
import { describe, type CastcadeState } from '../useCastcade.js';
import { ImportTables } from './ImportTables.js';

const PRESETS = [
  { label: 'Production', url: 'https://arcaid.app' },
  { label: 'Local', url: 'http://localhost:3001' },
] as const;

const PROJECT_URL = 'https://github.com/mekelburgj20/castcade';

export function Settings({ state }: { state: CastcadeState }) {
  const { bridge, settings, versions, loginItem, status, logPath } = state;
  const { toast } = useToast();
  const [url, setUrl] = useState('');
  const [nvram, setNvram] = useState('');
  const [tables, setTables] = useState('');
  const [sendingLogs, setSendingLogs] = useState(false);
  const [logsSent, setLogsSent] = useState<SendLogsResult | null>(null);

  useEffect(() => {
    if (settings) {
      setUrl(settings.arcaidBaseUrl);
      setNvram(settings.nvramDir ?? '');
      setTables(settings.tablesDir ?? '');
    }
  }, [settings]);

  /**
   * The Arcaid look: what a Save says comes as a toast. It was a line at the foot of this long tab, out of sight of the
   * Save pressed at its top; the toast shows where the window is. A failure stays until Dismiss.
   */
  async function save(patch: SettingsPatch, what: string) {
    try {
      await state.setSettings(patch);
      toast(`${what} saved`, 'success');
    } catch (e) {
      toast(describe(e), 'error');
    }
  }

  /** E8.3: this PC's logs to Arcaid support in one press; main answers with the sentence to show, whatever happened. */
  async function sendLogs() {
    if (!bridge) return;
    setSendingLogs(true);
    setLogsSent(null);
    try {
      setLogsSent(await bridge.witness.sendLogs());
    } catch (e) {
      setLogsSent({ ok: false, text: `Logs not sent: ${describe(e)}` });
    } finally {
      setSendingLogs(false);
    }
  }

  const urlDirty = settings !== null && url.trim().replace(/\/+$/, '') !== settings.arcaidBaseUrl;
  const nvramDirty = settings !== null && nvram.trim() !== (settings.nvramDir ?? '');
  const tablesDirty = settings !== null && tables.trim() !== (settings.tablesDir ?? '');

  const open = (href: string) => (e: MouseEvent) => {
    e.preventDefault();
    void bridge?.app.openExternal(href);
  };

  return (
    <>
      <PanelGroup id="settings" tone="violet" title="Settings">
        <Panel title={<label htmlFor="set-url">ArcAid URL</label>}>
          <Field
            help={
              <>
                Presets:{' '}
                {PRESETS.map((p, i) => (
                  <Fragment key={p.url}>
                    {i > 0 && ' '}
                    <button type="button" className="cc-link" onClick={() => setUrl(p.url)}>
                      {p.label}
                    </button>
                  </Fragment>
                ))}{' '}
                — the pairing token only works on the server that issued it.
              </>
            }
          >
            <input id="set-url" type="url" className="cc-input" value={url} onChange={(e) => setUrl(e.target.value)} disabled={!bridge} spellCheck={false} />
          </Field>
          <div className="cc-row">
            <Button disabled={!bridge || !urlDirty} onClick={() => void save({ arcaidBaseUrl: url }, 'ArcAid URL')}>
              Save URL
            </Button>
          </div>
        </Panel>

        <Panel title={<label htmlFor="set-nvram">VPinMAME NVRAM folder (override)</label>}>
          <Field line help='Leave empty to auto-detect. Set it only if Status shows "NVRAM dir: not found".'>
            <input id="set-nvram" type="text" className="cc-input" value={nvram} placeholder="auto-detect from the registry" onChange={(e) => setNvram(e.target.value)} disabled={!bridge} spellCheck={false} />
            <Button variant="secondary" size="sm" disabled={!bridge} onClick={() => void bridge?.app.pickFolder(nvram || status?.nvramDir || null).then((p) => p && setNvram(p))}>
              Browse…
            </Button>
          </Field>
          <div className="cc-row">
            <Button disabled={!bridge || !nvramDirty} onClick={() => void save({ nvramDir: nvram.trim() === '' ? null : nvram.trim() }, 'NVRAM folder')}>
              Save folder
            </Button>
          </div>
        </Panel>

        <Panel title={<label htmlFor="set-tables">Tables folder (extra)</label>}>
          <Field
            line
            help={
              <>
                Where Castcade looks for a table's .vpx when you opened it from the editor (to read its VPS identity). The folder beside your VPX exe is always
                searched; add one more here if your tables live elsewhere.
              </>
            }
          >
            <input id="set-tables" type="text" className="cc-input" value={tables} placeholder="only <VPX folder>\tables is searched" onChange={(e) => setTables(e.target.value)} disabled={!bridge} spellCheck={false} />
            <Button variant="secondary" size="sm" disabled={!bridge} onClick={() => void bridge?.app.pickFolder(tables || null).then((p) => p && setTables(p))}>
              Browse…
            </Button>
          </Field>
          <div className="cc-row">
            <Button disabled={!bridge || !tablesDirty} onClick={() => void save({ tablesDir: tables.trim() === '' ? null : tables.trim() }, 'Tables folder')}>
              Save folder
            </Button>
          </div>
        </Panel>

        <ImportTables state={state} />

        <Panel>
          <label className="cc-check">
            <input type="checkbox" checked={loginItem?.openAtLogin ?? false} disabled={!bridge || !loginItem?.supported} onChange={(e) => void state.setLoginItem(e.target.checked)} />
            <span>Start with Windows (hidden in the tray)</span>
          </label>
          {loginItem && !loginItem.supported && <small className="cc-help cc-check__help">Available in the installed app only.</small>}
        </Panel>

        <Panel>
          <div className="cc-row">
            <Button disabled={!bridge || !status?.paired || sendingLogs} onClick={() => void sendLogs()}>
              {sendingLogs ? 'Sending logs…' : 'Send logs to Arcaid support'}
            </Button>
          </div>
          <p className="cc-help">
            {status && !status.paired ? 'Pair this PC first (Pairing tab): the logs go through its pairing. ' : ''}
            Sends this PC's Castcade logs to Arcaid support: the app log, the VR layer log, the newest VR report and the newest table journals (up to 12 MB, so
            best between games). Never your pairing, settings, tables or ROMs.
          </p>
          {logsSent && (
            <Note state={logsSent.ok ? 'ok' : 'problem'} role={logsSent.ok ? 'status' : 'alert'}>
              {logsSent.text}
            </Note>
          )}
        </Panel>
      </PanelGroup>

      <PanelGroup id="about" tone="ice" title="About">
        <Panel wide>
          <dl className="cc-facts">
            <dt>Castcade</dt>
            <dd>
              {versions?.app ?? bridge?.appVersion ?? '?'}
              {bridge?.edition === 'witness' ? ' · Witness edition' : ''} ·{' '}
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
            <dd className="cc-mono">{settings?.deviceId ?? '?'}</dd>
            <dt>Log file</dt>
            <dd className="cc-mono" title={logPath ?? ''}>
              {logPath ?? '?'}
            </dd>
            <dt>Maps</dt>
            <dd className="cc-mono" title={settings?.mapsDir ?? ''}>
              {settings?.mapsDir ?? '?'}
            </dd>
          </dl>
          <p className="cc-help cc-attribution">
            ROM memory maps © tomlogic/pinmame-nvram-maps contributors, Open Database License (ODbL) v1.0. Maps version: {status?.mapsVersion ?? 'unknown'}. Table
            and game identities from the Virtual Pinball Spreadsheet (vps-db) community database, version: {status?.vpsVersion ?? 'not bundled'}.
          </p>
        </Panel>
      </PanelGroup>
    </>
  );
}
