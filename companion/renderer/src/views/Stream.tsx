import { useEffect, useState } from 'react';
import { Field, Note, Skeleton } from '../parts/Bits.js';
import { Button } from '../parts/Button.js';
import { Panel, PanelGroup } from '../parts/Panel.js';
import { describe, type CastcadeState } from '../useCastcade.js';

/**
 * D1.5: the Stream page. Go live and / or record, the framing preview (an ffplay window on the stream's own picture
 * chain, `media/preview.ts`), the capture's health and every stream setting. Replaced the D1.3 StreamCard in Settings
 * (2026-10-30); the OBS overlay card moved here with it, being a streaming thing.
 */

/** Mirrors `media/ffmpeg-args.ts` PRESETS (the renderer cannot import it); `fps` is what health is read against. */
const QUALITY = [
  { id: '720p30', label: '720p 30 fps (4.5 Mbps)', fps: 30 },
  { id: '1080p30', label: '1080p 30 fps (6 Mbps)', fps: 30 },
  { id: '1080p60', label: '1080p 60 fps (6 Mbps)', fps: 60 },
] as const;

/** Health below these reads as trouble: speed under 1x means the grab falls behind the clock. */
const SLOW_SPEED = 0.95;
const LOW_FPS_SHARE = 0.8;

export function Stream({ state }: { state: CastcadeState }) {
  const { bridge } = state;
  const [st, setSt] = useState<StreamStatus | null>(null);
  const [cfg, setCfg] = useState<StreamSettingsView | null>(null);
  const [pv, setPv] = useState<PreviewStatus | null>(null);
  const [pvBusy, setPvBusy] = useState(false);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [volume, setVolume] = useState<number | null>(null);

  useEffect(() => {
    if (!bridge) return;
    let alive = true;
    void bridge.stream.status().then((s) => alive && setSt(s));
    void bridge.stream.settings().then((s) => alive && setCfg(s));
    void bridge.stream.preview.status().then((p) => alive && setPv(p));
    const off = bridge.stream.onStatus((s) => setSt(s));
    const offPv = bridge.stream.preview.onStatus((p) => setPv(p));
    return () => {
      alive = false;
      off();
      offPv();
    };
  }, [bridge]);

  // The Arcaid look: no blank tab while the settings are on their way (a skeleton in the tab's shape), and a tab
  // outside Castcade says why it is empty (the sentence Pairing says).
  if (!bridge) {
    return (
      <PanelGroup id="stream" tone="pink" title="Stream">
        <Note state="problem">Bridge unavailable: this page is not running inside Castcade.</Note>
      </PanelGroup>
    );
  }
  if (!cfg) return <StreamLoading />;
  const running = !!st && st.state !== 'idle';
  const preset = QUALITY.find((q) => q.id === cfg.preset) ?? QUALITY[0];
  const inVr = state.status?.currentAttestation?.vr?.inVr === true;

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
  // Not through `run`: a busy flag would disable the fieldset and take the focus out of a field being typed in.
  const patch = (p: Partial<StreamSettings>) =>
    void bridge.stream.setSettings(p).then(
      (next) => {
        setCfg(next);
        setError(null);
      },
      (e: unknown) => setError(describe(e)),
    );
  const togglePreview = () => {
    setPvBusy(true);
    void (pv?.previewing ? bridge.stream.preview.stop() : bridge.stream.preview.start())
      .then(setPv, (e: unknown) => setPv({ previewing: false, picture: null, warning: null, error: describe(e) }))
      .finally(() => setPvBusy(false));
  };
  const commitVolume = () => {
    if (volume !== null && volume !== cfg.gameVolume) patch({ gameVolume: volume });
  };
  const folder = cfg.recordingsDir ?? cfg.defaultRecordingsDir;

  return (
    <PanelGroup id="stream" tone="pink" title="Stream">
      <Panel wide title="Stream and record">
        <p className="cc-text">{describeStream(st)}</p>
        {inVr && <Note state="attention">VR: turn on VRPreview in VPX (Preferences → VR) so there is a window to capture; the stream is only as sharp as that window.</Note>}
        <div className="cc-row">
          {running ? (
            <Button disabled={busy} onClick={() => void run(() => bridge.stream.stop())}>
              {st?.wantsLive ? 'Stop streaming' : 'Stop recording'}
            </Button>
          ) : (
            <>
              <Button disabled={busy || !cfg.hasKey} onClick={() => void run(() => bridge.stream.start({ record: true, live: true }))}>
                Go live and record
              </Button>
              <Button variant="secondary" disabled={busy} onClick={() => void run(() => bridge.stream.start({ record: true, live: false }))}>
                Record only
              </Button>
              <Button variant="secondary" disabled={busy || !cfg.hasKey} onClick={() => void run(() => bridge.stream.start({ record: false, live: true }))}>
                Go live only
              </Button>
            </>
          )}
          <Button variant="secondary" disabled={pvBusy} onClick={togglePreview}>
            {pvBusy && !pv?.previewing ? 'Opening…' : pv?.previewing ? 'Close preview' : 'Preview'}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => void bridge.stream.openRecordings()}>
            Open recordings
          </Button>
        </div>
        {error && (
          <Note state="problem" role="alert">
            {error}
          </Note>
        )}
        {st?.lastError && running && st.state !== 'capturing' && <p className="cc-help">Last problem: {st.lastError}</p>}
        {pv?.previewing && pv.picture && (
          <p className="cc-help">
            Preview: {pv.picture.width}x{pv.picture.height}. Close it with Q or its window's X.
          </p>
        )}
        {pv?.warning && <Note state="attention">{pv.warning}</Note>}
        {pv?.error && <Note state="problem">{pv.error}</Note>}
        <small className="cc-help">The preview shows exactly what viewers will see, and a change to the settings below updates it live.</small>

        {st?.state === 'capturing' && <Health st={st} fps={preset.fps} folder={folder} />}
        {st?.state === 'slate' && <p className="cc-help">The "back in a moment" slate is up: viewers see it until a table opens, and nothing is recorded meanwhile.</p>}
      </Panel>

      <Panel title={<label htmlFor="stream-service">Service</label>}>
        <fieldset disabled={running || busy}>
          <select id="stream-service" className="cc-input" value={cfg.service} onChange={(e) => patch({ service: e.target.value as StreamSettings['service'] })}>
            <option value="twitch">Twitch</option>
            <option value="youtube">YouTube</option>
            <option value="custom">Other (RTMP URL)</option>
          </select>
          {cfg.service === 'custom' && (
            <Field label="Ingest URL (without the key)" htmlFor="stream-ingest">
              <input id="stream-ingest" type="text" className="cc-input cc-input--mono" defaultValue={cfg.customIngest ?? ''} placeholder="rtmp://example.com/live/" onBlur={(e) => patch({ customIngest: e.target.value.trim() || null })} />
            </Field>
          )}
          <Field label={`Stream key ${cfg.hasKey ? '(saved)' : '(not set)'}`} htmlFor="stream-key" help="Stored encrypted on this PC. Castcade never shows it again and never sends it to ArcAid.">
            <input
              id="stream-key"
              type="password"
              className="cc-input"
              value={key}
              autoComplete="off"
              placeholder={cfg.hasKey ? '••••••••  (enter a new one to replace it)' : 'From your Twitch or YouTube dashboard'}
              onChange={(e) => setKey(e.target.value)}
            />
          </Field>
          <div className="cc-row">
            <Button
              disabled={!key.trim()}
              onClick={() =>
                void run(async () => {
                  setCfg(await bridge.stream.setKey(key));
                  setKey('');
                })
              }
            >
              Save key
            </Button>
            {cfg.hasKey && (
              <Button variant="danger" onClick={() => void run(async () => setCfg(await bridge.stream.setKey(null)))}>
                Clear key
              </Button>
            )}
          </div>
        </fieldset>
      </Panel>

      <Panel title="Picture">
        <fieldset disabled={running || busy}>
          <div className="cc-fields">
            <Field label="Shape" htmlFor="stream-shape">
              <select id="stream-shape" className="cc-input" value={cfg.orientation} onChange={(e) => patch({ orientation: e.target.value as StreamSettings['orientation'] })}>
                <option value="portrait">Vertical (9:16)</option>
                <option value="landscape">Horizontal (the whole window)</option>
              </select>
            </Field>
            <Field label="Rotate" htmlFor="stream-rotate">
              <select id="stream-rotate" className="cc-input" value={cfg.rotate} onChange={(e) => patch({ rotate: Number(e.target.value) as StreamSettings['rotate'] })}>
                <option value={0}>None</option>
                <option value={90}>90° clockwise</option>
                <option value={180}>180°</option>
                <option value={270}>90° counter-clockwise</option>
              </select>
            </Field>
            <Field label="Quality" htmlFor="stream-quality">
              <select id="stream-quality" className="cc-input" value={cfg.preset} onChange={(e) => patch({ preset: e.target.value })}>
                {QUALITY.map((q) => (
                  <option key={q.id} value={q.id}>
                    {q.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <small className="cc-help">
            Rotate is for VPX in cabinet mode on a monitor that stands upright: VPX draws the table on its side and the stream turns it back (usually 90°
            clockwise). Check it with the preview.
            {cfg.orientation === 'portrait' && ' A vertical stream is a 9:16 slice of the game window; the slice shift moves it sideways.'}
          </small>
          {cfg.orientation === 'portrait' && (
            <Field label="Slice shift (% of the window width, + = right)" htmlFor="stream-shift">
              <input
                id="stream-shift"
                type="number"
                className="cc-input cc-input--number"
                min={-50}
                max={50}
                defaultValue={cfg.shiftPercent}
                onChange={(e) => {
                  // Every valid value goes through, so a running preview follows the arrows (the host debounces its restart).
                  const v = e.target.value.trim();
                  if (v !== '' && Number.isFinite(Number(v))) patch({ shiftPercent: Number(v) });
                }}
              />
            </Field>
          )}
          <div className="cc-field">
            <label className="cc-check">
              <input type="checkbox" checked={cfg.overlay} onChange={(e) => patch({ overlay: e.target.checked })} />
              <span>Overlay in the stream and recording</span>
            </label>
            <small className="cc-help cc-check__help">Table, score, ball and the Witness badge, drawn on the picture. Turn it off if OBS shows the overlay page instead.</small>
          </div>
        </fieldset>
      </Panel>

      <Panel title="Sound">
        <fieldset disabled={running || busy}>
          <Field label={`Game volume: ${volume ?? cfg.gameVolume} %`} htmlFor="stream-volume" help="The sound is everything Windows plays (game, voice chat, music), turned down or up by this much.">
            <input
              id="stream-volume"
              type="range"
              className="cc-range"
              min={0}
              max={200}
              step={5}
              value={volume ?? cfg.gameVolume}
              onChange={(e) => setVolume(Number(e.target.value))}
              onPointerUp={commitVolume}
              onKeyUp={commitVolume}
              onBlur={commitVolume}
            />
          </Field>
          <p className="cc-help">Microphone: not yet; the sound is everything Windows plays.</p>
          <details className="cc-more">
            <summary>Advanced</summary>
            <Field label="Audio delay correction (ms)" htmlFor="stream-audio-late" help="How far the captured audio trails the picture: a positive value is cut from the audio's start, a negative one delays it.">
              <input id="stream-audio-late" type="number" className="cc-input cc-input--number" min={-1000} max={2000} defaultValue={cfg.audioLateMs} onBlur={(e) => patch({ audioLateMs: Number(e.target.value) })} />
            </Field>
          </details>
        </fieldset>
      </Panel>

      <Panel title="Recordings">
        <fieldset disabled={running || busy}>
          <Field label="Folder" help="One folder per session, with a manifest tying each posted score to its video.">
            <div className="cc-mono" title={folder}>
              {folder}
              {cfg.recordingsDir === null && ' (default)'}
            </div>
            <div className="cc-row">
              <Button variant="secondary" size="sm" onClick={() => void bridge.app.pickFolder(folder).then((p) => p && patch({ recordingsDir: p }))}>
                Choose…
              </Button>
              {cfg.recordingsDir !== null && (
                <Button variant="secondary" size="sm" onClick={() => patch({ recordingsDir: null })}>
                  Use default
                </Button>
              )}
            </div>
          </Field>
          <Field label="Keep the last N sessions" htmlFor="stream-keep">
            <input id="stream-keep" type="number" className="cc-input cc-input--number" min={0} max={1000} defaultValue={cfg.keepSessions} onBlur={(e) => patch({ keepSessions: Number(e.target.value) })} />
          </Field>
          <Field label="At most N recordings in all (blank = no cap)" htmlFor="stream-max" help="Each video counts; the oldest sessions go first. Recordings of Sanctioned scores count toward neither limit.">
            <input
              id="stream-max"
              type="number"
              className="cc-input cc-input--number"
              min={1}
              placeholder="no cap"
              defaultValue={cfg.maxRecordings ?? ''}
              onBlur={(e) => {
                const v = e.target.value.trim();
                patch({ maxRecordings: v === '' ? null : Number(v) });
              }}
            />
          </Field>
        </fieldset>
      </Panel>

      <OverlayCard state={state} />
    </PanelGroup>
  );
}

/** The tab before its settings have arrived: its first panels, in their shape. */
function StreamLoading() {
  return (
    <PanelGroup id="stream" tone="pink" title="Stream">
      <Panel wide title="Stream and record">
        <div className="cc-stack" aria-busy="true">
          <Skeleton width="70%" />
          <div className="cc-row">
            <Skeleton kind="button" width="150px" />
            <Skeleton kind="button" width="110px" />
            <Skeleton kind="button" width="110px" />
          </div>
          <Skeleton width="90%" />
        </div>
      </Panel>
      {['Service', 'Picture'].map((t) => (
        <Panel key={t} title={t}>
          <div className="cc-stack" aria-hidden="true">
            <Skeleton kind="field" />
            <Skeleton kind="label" />
            <Skeleton kind="field" />
          </div>
        </Panel>
      ))}
    </PanelGroup>
  );
}

/** The running capture, read against its preset: the numbers to look at when viewers say it stutters. */
function Health({ st, fps, folder }: { st: StreamStatus; fps: number; folder: string }) {
  const h = st.health;
  const lowFps = !!h && h.fps < LOW_FPS_SHARE * fps;
  const slow = !!h && h.speed < SLOW_SPEED;
  return (
    <dl className="cc-facts cc-facts--sub">
      <dt>Picture</dt>
      <dd>{st.picture ? `${st.picture.width}x${st.picture.height}` : '—'}</dd>
      <dt>Frame rate</dt>
      <dd className={lowFps ? 'cc-attention' : undefined}>{h ? `${Math.round(h.fps)} of ${fps} fps` : '—'}</dd>
      <dt>Speed</dt>
      <dd className={slow ? 'cc-attention' : undefined}>{h ? `${h.speed.toFixed(2)}x` : '—'}</dd>
      <dt>Frames</dt>
      <dd>{h ? h.frames : '—'}</dd>
      <dt>Restarts</dt>
      <dd>{st.restarts}</dd>
      <dt>Segment</dt>
      <dd className={st.segment ? 'cc-mono' : undefined}>{st.segment ?? 'not recording'}</dd>
      <dt>Session folder</dt>
      <dd className={st.session ? 'cc-mono' : undefined} title={st.session ? `${folder}\\${st.session}` : ''}>
        {st.session ? `${folder}\\${st.session}` : '—'}
      </dd>
      <dt>Covered</dt>
      <dd className={st.covered ? 'cc-attention' : undefined}>{st.covered ? 'yes: VPX is not the window in front' : 'no'}</dd>
      <dt>Last problem</dt>
      <dd>{st.lastError ?? 'none'}</dd>
    </dl>
  );
}

function describeStream(st: StreamStatus | null): string {
  if (!st || st.state === 'idle') return 'Not streaming or recording.';
  const what = [st.wantsLive && 'live', st.wantsRecording && 'recording'].filter(Boolean).join(' and ');
  switch (st.state) {
    case 'waiting':
      return `Ready (${what}): start a table in VPX.`;
    case 'slate':
      return `Live: no table open, showing "back in a moment". Start a table to go back on.`;
    case 'capturing': {
      if (st.covered) return `${st.wantsLive ? 'Live' : 'Recording'}, covered: VPX is not the window in front, so viewers see "Paused: back in a moment". Click the table to go back on.`;
      const pic = st.picture ? `${st.picture.width}x${st.picture.height}` : '';
      const h = st.health ? `, ${Math.round(st.health.fps)} fps, speed ${st.health.speed.toFixed(2)}x` : '';
      return `${st.wantsLive ? 'Live' : 'Recording'}: ${st.table ?? 'the table'} ${pic}${h}${st.recording && st.segment ? ` → ${st.segment}` : ''}.`;
    }
  }
}

/**
 * D1.1: the OBS overlay. The URL a streamer pastes into OBS as a Browser source; fetched when the card shows, because
 * the server starts after the window does.
 */
function OverlayCard({ state }: { state: CastcadeState }) {
  const { bridge } = state;
  const [url, setUrl] = useState<string | null | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!bridge) return;
    let alive = true;
    void bridge.app.overlayUrl().then((u) => alive && setUrl(u));
    return () => {
      alive = false;
    };
  }, [bridge]);
  const copy = () => {
    if (!url) return;
    void navigator.clipboard.writeText(url).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => setCopied(false),
    );
  };
  return (
    <Panel title="OBS overlay">
      {url ? (
        <>
          <div className="cc-field__line">
            <span className="cc-mono cc-grow">{url}</span>
            <Button variant="secondary" size="sm" onClick={copy}>
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
          <small className="cc-help">
            In OBS: Sources → + → Browser, paste the address, width 1920, height 1080. It shows the live score, ball, player and the Witness badge
            while a patched table is open. Add <span className="cc-mono">?scale=1.5</span> to make it bigger or <span className="cc-mono">?side=right</span> to move it.
          </small>
        </>
      ) : url === undefined ? (
        // Loading: the address's line and the help under it, in their shape.
        <div className="cc-stack" aria-busy="true">
          <p className="cc-help">Checking…</p>
          <div className="cc-field__line">
            <Skeleton width="70%" />
            <Skeleton kind="button" width="64px" />
          </div>
          <Skeleton width="95%" />
          <Skeleton width="80%" />
        </div>
      ) : (
        <p className="cc-help">Not running: its port was taken when Castcade started (see the log).</p>
      )}
    </Panel>
  );
}
