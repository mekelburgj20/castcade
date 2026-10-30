import { useEffect, useState } from 'react';
import type { CastcadeState } from '../useCastcade.js';

/**
 * D1.2 / D1.3: record and stream from Castcade alone. The Stream page (D1.5) replaces this card with the preview,
 * health and the rest of the settings; this is the minimum to go live: key, framing, start / stop, status.
 */
export function StreamCard({ state }: { state: CastcadeState }) {
  const { bridge } = state;
  const [st, setSt] = useState<StreamStatus | null>(null);
  const [cfg, setCfg] = useState<StreamSettingsView | null>(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!bridge) return;
    let alive = true;
    void bridge.stream.status().then((s) => alive && setSt(s));
    void bridge.stream.settings().then((s) => alive && setCfg(s));
    const off = bridge.stream.onStatus((s) => setSt(s));
    return () => {
      alive = false;
      off();
    };
  }, [bridge]);

  if (!bridge || !cfg) return null;
  const running = !!st && st.state !== 'idle';

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e));
    } finally {
      setBusy(false);
    }
  };
  const patch = (p: Partial<StreamSettings>) => void run(async () => setCfg(await bridge.stream.setSettings(p)));

  return (
    <div className="card">
      <strong>Stream and record</strong>
      <p>{describeStream(st)}</p>
      {st?.lastError && running && <p className="muted">Last problem: {st.lastError}</p>}
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
        <button type="button" className="small" onClick={() => void bridge.stream.openRecordings()}>
          Open recordings
        </button>
      </div>
      {error && <p className="error">{error}</p>}

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
              <option value="720p30">720p 30 fps (4.5 Mbps)</option>
              <option value="1080p30">1080p 30 fps (6 Mbps)</option>
              <option value="1080p60">1080p 60 fps (6 Mbps)</option>
            </select>
          </label>
        </div>
        <small className="muted">
          Rotate is for VPX in cabinet mode on a monitor that stands upright: VPX draws the table on its side and the stream turns it back (usually 90°
          clockwise). Check it with the preview: <span className="mono">npm run spike:stream -w companion -- --preview</span> until the Stream page has one.
          {cfg.orientation === 'portrait' && ' A vertical stream is a 9:16 slice of the game window; '}
        </small>
        {cfg.orientation === 'portrait' && (
          <label className="field">
            <span>Slice shift (% of the window width, + = right)</span>
            <input type="number" min={-50} max={50} defaultValue={cfg.shiftPercent} onBlur={(e) => patch({ shiftPercent: Number(e.target.value) })} />
          </label>
        )}
        <label className="field">
          <span>Keep the last N sessions</span>
          <input type="number" min={0} max={1000} defaultValue={cfg.keepSessions} onBlur={(e) => patch({ keepSessions: Number(e.target.value) })} />
          <small>
            Recordings go to <span className="mono">{cfg.recordingsDir ?? cfg.defaultRecordingsDir}</span>, one folder per session with a manifest tying each
            posted score to its video.
          </small>
        </label>
        <label className="check">
          <input type="checkbox" checked={cfg.overlay} onChange={(e) => patch({ overlay: e.target.checked })} />
          Overlay in the stream and recording
        </label>
        <small>Table, score, ball and the Witness badge, drawn on the picture. Turn it off if OBS shows the overlay page instead.</small>
      </fieldset>
      <small className="muted">The sound is everything Windows plays (game, voice chat, music). Between tables a live stream shows a "back in a moment" screen.</small>
    </div>
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
