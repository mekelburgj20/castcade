import { useEffect, useState } from 'react';
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

  if (!bridge || !cfg) return null;
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
    <section className="view">
      <h2>Stream</h2>

      <div className="card">
        <strong>Stream and record</strong>
        <p>{describeStream(st)}</p>
        {inVr && (
          <p className="warn">
            VR: turn on VRPreview in VPX (Preferences → VR) so there is a window to capture; the stream is only as sharp as that window.
          </p>
        )}
        <div className="row">
          {running ? (
            <button type="button" disabled={busy} onClick={() => void run(() => bridge.stream.stop())}>
              {st?.wantsLive ? 'Stop streaming' : 'Stop recording'}
            </button>
          ) : (
            <>
              <button type="button" className="primary" disabled={busy || !cfg.hasKey} onClick={() => void run(() => bridge.stream.start({ record: true, live: true }))}>
                Go live and record
              </button>
              <button type="button" disabled={busy} onClick={() => void run(() => bridge.stream.start({ record: true, live: false }))}>
                Record only
              </button>
              <button type="button" disabled={busy || !cfg.hasKey} onClick={() => void run(() => bridge.stream.start({ record: false, live: true }))}>
                Go live only
              </button>
            </>
          )}
          <button type="button" disabled={pvBusy} onClick={togglePreview}>
            {pvBusy && !pv?.previewing ? 'Opening…' : pv?.previewing ? 'Close preview' : 'Preview'}
          </button>
          <button type="button" className="small" onClick={() => void bridge.stream.openRecordings()}>
            Open recordings
          </button>
        </div>
        {error && <p className="error">{error}</p>}
        {st?.lastError && running && st.state !== 'capturing' && <p className="muted">Last problem: {st.lastError}</p>}
        {pv?.previewing && pv.picture && (
          <p className="muted">
            Preview: {pv.picture.width}x{pv.picture.height}. Close it with Q or its window's X.
          </p>
        )}
        {pv?.warning && <p className="warn">{pv.warning}</p>}
        {pv?.error && <p className="error">{pv.error}</p>}
        <small className="muted">The preview shows exactly what viewers will see, and a change to the settings below updates it live.</small>

        {st?.state === 'capturing' && <Health st={st} fps={preset.fps} folder={folder} />}
        {st?.state === 'slate' && <p className="muted">The "back in a moment" slate is up: viewers see it until a table opens, and nothing is recorded meanwhile.</p>}
      </div>

      <div className="card">
        <fieldset disabled={running || busy}>
          <label className="field">
            <span>Service</span>
            <select value={cfg.service} onChange={(e) => patch({ service: e.target.value as StreamSettings['service'] })}>
              <option value="twitch">Twitch</option>
              <option value="youtube">YouTube</option>
              <option value="custom">Other (RTMP URL)</option>
            </select>
          </label>
          {cfg.service === 'custom' && (
            <label className="field">
              <span>Ingest URL (without the key)</span>
              <input type="text" defaultValue={cfg.customIngest ?? ''} placeholder="rtmp://example.com/live/" onBlur={(e) => patch({ customIngest: e.target.value.trim() || null })} />
            </label>
          )}
          <label className="field">
            <span>Stream key {cfg.hasKey ? '(saved)' : '(not set)'}</span>
            <input type="password" value={key} autoComplete="off" placeholder={cfg.hasKey ? '••••••••  (enter a new one to replace it)' : 'From your Twitch or YouTube dashboard'} onChange={(e) => setKey(e.target.value)} />
            <small>Stored encrypted on this PC. Castcade never shows it again and never sends it to ArcAid.</small>
          </label>
          <div className="row">
            <button
              type="button"
              disabled={!key.trim()}
              onClick={() =>
                void run(async () => {
                  setCfg(await bridge.stream.setKey(key));
                  setKey('');
                })
              }
            >
              Save key
            </button>
            {cfg.hasKey && (
              <button type="button" onClick={() => void run(async () => setCfg(await bridge.stream.setKey(null)))}>
                Clear key
              </button>
            )}
          </div>
        </fieldset>
      </div>

      <div className="card">
        <strong>Picture</strong>
        <fieldset disabled={running || busy}>
          <div className="row">
            <label className="field">
              <span>Shape</span>
              <select value={cfg.orientation} onChange={(e) => patch({ orientation: e.target.value as StreamSettings['orientation'] })}>
                <option value="portrait">Vertical (9:16)</option>
                <option value="landscape">Horizontal (the whole window)</option>
              </select>
            </label>
            <label className="field">
              <span>Rotate</span>
              <select value={cfg.rotate} onChange={(e) => patch({ rotate: Number(e.target.value) as StreamSettings['rotate'] })}>
                <option value={0}>None</option>
                <option value={90}>90° clockwise</option>
                <option value={180}>180°</option>
                <option value={270}>90° counter-clockwise</option>
              </select>
            </label>
            <label className="field">
              <span>Quality</span>
              <select value={cfg.preset} onChange={(e) => patch({ preset: e.target.value })}>
                {QUALITY.map((q) => (
                  <option key={q.id} value={q.id}>
                    {q.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <small className="muted">
            Rotate is for VPX in cabinet mode on a monitor that stands upright: VPX draws the table on its side and the stream turns it back (usually 90°
            clockwise). Check it with the preview.
            {cfg.orientation === 'portrait' && ' A vertical stream is a 9:16 slice of the game window; the slice shift moves it sideways.'}
          </small>
          {cfg.orientation === 'portrait' && (
            <label className="field">
              <span>Slice shift (% of the window width, + = right)</span>
              <input
                type="number"
                min={-50}
                max={50}
                defaultValue={cfg.shiftPercent}
                onChange={(e) => {
                  // Every valid value goes through, so a running preview follows the arrows (the host debounces its restart).
                  const v = e.target.value.trim();
                  if (v !== '' && Number.isFinite(Number(v))) patch({ shiftPercent: Number(v) });
                }}
              />
            </label>
          )}
          <label className="check">
            <input type="checkbox" checked={cfg.overlay} onChange={(e) => patch({ overlay: e.target.checked })} />
            Overlay in the stream and recording
          </label>
          <small>Table, score, ball and the Witness badge, drawn on the picture. Turn it off if OBS shows the overlay page instead.</small>
        </fieldset>
      </div>

      <div className="card">
        <strong>Sound</strong>
        <fieldset disabled={running || busy}>
          <label className="field">
            <span>Game volume: {volume ?? cfg.gameVolume} %</span>
            <input
              type="range"
              min={0}
              max={200}
              step={5}
              value={volume ?? cfg.gameVolume}
              onChange={(e) => setVolume(Number(e.target.value))}
              onPointerUp={commitVolume}
              onKeyUp={commitVolume}
              onBlur={commitVolume}
            />
            <small>The sound is everything Windows plays (game, voice chat, music), turned down or up by this much.</small>
          </label>
          <p className="muted">Microphone: not yet; the sound is everything Windows plays.</p>
          <details>
            <summary className="muted">Advanced</summary>
            <label className="field">
              <span>Audio delay correction (ms)</span>
              <input type="number" min={-1000} max={2000} defaultValue={cfg.audioLateMs} onBlur={(e) => patch({ audioLateMs: Number(e.target.value) })} />
              <small>How far the captured audio trails the picture: a positive value is cut from the audio's start, a negative one delays it.</small>
            </label>
          </details>
        </fieldset>
      </div>

      <div className="card">
        <strong>Recordings</strong>
        <fieldset disabled={running || busy}>
          <div className="field">
            <span>Folder</span>
            <div className="mono" title={folder}>
              {folder}
              {cfg.recordingsDir === null && ' (default)'}
            </div>
            <div className="row">
              <button type="button" className="small" onClick={() => void bridge.app.pickFolder(folder).then((p) => p && patch({ recordingsDir: p }))}>
                Choose…
              </button>
              {cfg.recordingsDir !== null && (
                <button type="button" className="small" onClick={() => patch({ recordingsDir: null })}>
                  Use default
                </button>
              )}
            </div>
            <small>One folder per session, with a manifest tying each posted score to its video.</small>
          </div>
          <label className="field">
            <span>Keep the last N sessions</span>
            <input type="number" min={0} max={1000} defaultValue={cfg.keepSessions} onBlur={(e) => patch({ keepSessions: Number(e.target.value) })} />
          </label>
          <label className="field">
            <span>At most N recordings in all (blank = no cap)</span>
            <input
              type="number"
              min={1}
              placeholder="no cap"
              defaultValue={cfg.maxRecordings ?? ''}
              onBlur={(e) => {
                const v = e.target.value.trim();
                patch({ maxRecordings: v === '' ? null : Number(v) });
              }}
            />
            <small>Each video counts; the oldest sessions go first. Recordings of Sanctioned scores count toward neither limit.</small>
          </label>
        </fieldset>
      </div>

      <OverlayCard state={state} />
    </section>
  );
}

/** The running capture, read against its preset: the numbers to look at when viewers say it stutters. */
function Health({ st, fps, folder }: { st: StreamStatus; fps: number; folder: string }) {
  const h = st.health;
  const lowFps = !!h && h.fps < LOW_FPS_SHARE * fps;
  const slow = !!h && h.speed < SLOW_SPEED;
  return (
    <dl className="facts">
      <dt>Picture</dt>
      <dd>{st.picture ? `${st.picture.width}x${st.picture.height}` : '—'}</dd>
      <dt>Frame rate</dt>
      <dd className={lowFps ? 'warn' : undefined}>{h ? `${Math.round(h.fps)} of ${fps} fps` : '—'}</dd>
      <dt>Speed</dt>
      <dd className={slow ? 'warn' : undefined}>{h ? `${h.speed.toFixed(2)}x` : '—'}</dd>
      <dt>Frames</dt>
      <dd>{h ? h.frames : '—'}</dd>
      <dt>Restarts</dt>
      <dd>{st.restarts}</dd>
      <dt>Segment</dt>
      <dd className="mono">{st.segment ?? 'not recording'}</dd>
      <dt>Session folder</dt>
      <dd className="mono" title={st.session ? `${folder}\\${st.session}` : ''}>
        {st.session ? `${folder}\\${st.session}` : '—'}
      </dd>
      <dt>Covered</dt>
      <dd className={st.covered ? 'warn' : undefined}>{st.covered ? 'yes: VPX is not the window in front' : 'no'}</dd>
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
    <div className="card">
      <strong>OBS overlay</strong>
      {url ? (
        <>
          <p>
            <span className="mono">{url}</span>{' '}
            <button type="button" onClick={copy}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          </p>
          <small className="muted">
            In OBS: Sources → + → Browser, paste the address, width 1920, height 1080. It shows the live score, ball, player and the Witness badge
            while a patched table is open. Add <span className="mono">?scale=1.5</span> to make it bigger or <span className="mono">?side=right</span> to move it.
          </small>
        </>
      ) : (
        <small className="muted">{url === undefined ? 'Checking…' : 'Not running: its port was taken when Castcade started (see the log).'}</small>
      )}
    </div>
  );
}
