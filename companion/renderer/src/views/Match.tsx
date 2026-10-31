import { useEffect, useState } from 'react';
import { describe, type CastcadeState } from '../useCastcade.js';

/**
 * A6 + C3 (docs/design/alpha-match.md §1, §3, 2026-10-30): the Match page. Host a match (the invite string to send the
 * other player) or join one by pasting it; then the roster, whose ball it is, the scores and, at the end, the result.
 * The turn lock, the cue and the media all run in the main process; this page only shows them and sends the
 * player's choices.
 */

const RIG_LABEL: Record<MatchStatus['participants'][number]['rig'], string> = { pc: 'PC', vr_headset: 'VR headset', real_cabinet: 'cabinet' };

/**
 * D7.4 (2026-10-31): a VR rig sending one eye. VPX's VR preview "Both Eyes" (`[PlayerVR] VRPreview = 3`: the
 * VRPreviewMode enum in src/core/player.h, combo labels in dialogs/VROptionsDialog.cpp, vpinball v10.8.0-2051-28dd6c3)
 * draws the left eye in the window's left half and the right eye in its right half (src/core/player.cpp, the
 * "VR Preview" blit); the other headset shows it in stereo when the picture is 3:1 or wider (panel-page.ts stereoOf).
 */
const SBS_MIN_ASPECT = 3;
function singleEyePreview(st: MatchStatus): boolean {
  const c = st.media?.captureCrop;
  return st.rig === 'vr_headset' && !!c && c.height > 0 && c.width / c.height < SBS_MIN_ASPECT;
}

export function Match({ state }: { state: CastcadeState }) {
  const { bridge } = state;
  const [st, setSt] = useState<MatchStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [port, setPort] = useState<string | null>(null);
  const [balls, setBalls] = useState<3 | 5 | null>(null);
  const [invite, setInvite] = useState('');
  const [copied, setCopied] = useState(false);
  const [volume, setVolume] = useState<number | null>(null);

  useEffect(() => {
    if (!bridge) return;
    let alive = true;
    void bridge.match.status().then((s) => alive && setSt(s));
    const off = bridge.match.onStatus((s) => setSt(s));
    return () => {
      alive = false;
      off();
    };
  }, [bridge]);

  if (!bridge || !st) return null;

  const run = async (fn: () => Promise<MatchStatus>) => {
    setBusy(true);
    setError(null);
    try {
      setSt(await fn());
    } catch (e) {
      setError(describe(e));
    } finally {
      setBusy(false);
    }
  };
  const displayName = name ?? st.settings.displayName ?? st.defaultName;
  const portText = port ?? String(st.settings.port);
  const ballsPerGame = balls ?? st.settings.ballsPerGame;
  const inMatch = st.role !== 'none';
  const shownError = error ?? st.lastError;
  const panel = st.panel;
  const tableOpen = state.status?.currentTable ?? null;

  const copyInvite = () => {
    if (!st.invite) return;
    void navigator.clipboard.writeText(st.invite).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      },
      (e: unknown) => setError(describe(e)),
    );
  };
  const setView = (patch: Partial<Pick<MatchSettings, 'theaterDuringMyTurn' | 'spectate'>>) => {
    void bridge.match.setSettings(patch).then(setSt, (e: unknown) => setError(describe(e)));
  };
  const commitVolume = () => {
    if (volume !== null && volume !== st.settings.cueVolume) void bridge.match.setSettings({ cueVolume: volume }).then(setSt, (e: unknown) => setError(describe(e)));
  };
  const pickMic = (deviceId: string) => {
    void bridge.match.setMicrophone(deviceId === '' ? null : deviceId).then(setSt, (e: unknown) => setError(describe(e)));
  };
  const toggleMute = () => {
    void bridge.match.setMuted(!st.muted).then(setSt, (e: unknown) => setError(describe(e)));
  };
  // The saved choice may not be listed yet: the list comes from a hidden page when this tab opens (B22), or the panel page in a match.
  const savedMicMissing = st.micDeviceId !== null && !st.microphones.some((m) => m.deviceId === st.micDeviceId);

  return (
    <section className="view">
      <h2>Match</h2>

      {!inMatch && st.phase !== 'connecting' && (
        <>
          <p className="muted">
            Two to four players on the same table, one ball each in turn. Open the table in VPX first (with the Castcade patch): the table file is compared when you
            join.{tableOpen ? ` Open now: ${tableOpen}.` : ' No table is open right now.'}
          </p>
          <div className="card">
            <label className="field">
              <span>Your name in the match</span>
              <input type="text" maxLength={64} value={displayName} onChange={(e) => setName(e.target.value)} />
            </label>
          </div>

          <div className="card">
            <strong>Host a match</strong>
            <fieldset disabled={busy}>
              <div className="row">
                <label className="field">
                  <span>TCP port</span>
                  <input type="text" inputMode="numeric" className="port" value={portText} onChange={(e) => setPort(e.target.value)} />
                </label>
                <label className="field">
                  <span>Balls per game</span>
                  <select value={ballsPerGame} onChange={(e) => setBalls(e.target.value === '5' ? 5 : 3)}>
                    <option value={3}>3</option>
                    <option value={5}>5</option>
                  </select>
                </label>
              </div>
              <button type="button" className="primary" onClick={() => void run(() => bridge.match.host({ port: Number(portText), ballsPerGame, displayName }))}>
                Host
              </button>
            </fieldset>
          </div>

          <div className="card">
            <strong>Join a match</strong>
            <fieldset disabled={busy}>
              <label className="field">
                <span>Invite from the host</span>
                <input type="text" value={invite} placeholder="castcade:ws://203.0.113.7:27401#ABCDEF" onChange={(e) => setInvite(e.target.value)} />
              </label>
              <button
                type="button"
                onClick={() =>
                  void bridge.app.clipboardText().then((t) => {
                    const v = t.trim();
                    if (v.startsWith('castcade:')) {
                      setError(null);
                      setInvite(v);
                    } else setError('The clipboard does not hold a Castcade invite (it starts with castcade:ws://…).');
                  }, (e: unknown) => setError(describe(e)))
                }
              >
                Paste
              </button>{' '}
              <button type="button" className="primary" disabled={!invite.trim()} onClick={() => void run(() => bridge.match.join(invite, displayName))}>
                Join
              </button>
            </fieldset>
          </div>
        </>
      )}

      {st.phase === 'connecting' && (
        <div className="card">
          <p>Connecting to the host…</p>
        </div>
      )}

      {inMatch && (
        <>
          {st.role === 'host' && st.invite && st.phase === 'lobby' && (
            <div className="card">
              <strong>Invite</strong>
              <div className="row">
                <code className="mono invite">{st.invite}</code>
                <button type="button" className="small" onClick={copyInvite}>
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
              <p>Forward TCP {st.port} to this PC on your router, then send the invite to the other player.</p>
              {st.ipSource === 'lan' && (
                <p className="warn">Castcade could not look up your public address, so this is your home-network address. For a player outside your network, replace it with your public IP.</p>
              )}
            </div>
          )}

          <div className="card">
            <p className={panel?.myTurn ? 'turn-line mine' : 'turn-line'}>{turnLine(st)}</p>
            {panel?.message && <p className={panel.message.startsWith('different') ? 'warn' : 'muted'}>{panel.message}</p>}
            <table className="match-table">
              <thead>
                <tr>
                  <th>Player</th>
                  <th>Rig</th>
                  <th>Balls</th>
                  <th className="num">Score</th>
                </tr>
              </thead>
              <tbody>
                {st.participants.map((p) => {
                  const row = panel?.players.find((x) => x.id === p.id);
                  return (
                    <tr key={p.id} className={row?.isUp ? 'up' : ''}>
                      <td>
                        {p.name}
                        {p.id === st.localId ? ' (you)' : ''}
                        {p.id === st.hostId ? ' · host' : ''}
                        {p.tableMatch === false && <span className="warn"> · {p.tableNote ?? 'different table file'}</span>}
                        {p.buildMatch === false && <span className="muted"> · different VPX build</span>}
                        {row?.flags.includes('disconnected') && <span className="warn"> · disconnected</span>}
                      </td>
                      <td>{RIG_LABEL[p.rig]}</td>
                      <td>
                        {row?.ballsDone ?? 0}/{panel?.ballsPerGame || '—'}
                      </td>
                      <td className="num">{row?.score === null || row?.score === undefined ? '—' : row.score.toLocaleString()}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="row">
              {st.role === 'host' && st.phase === 'lobby' && (
                <button type="button" className="primary" disabled={busy || st.participants.length < 2} onClick={() => void run(() => bridge.match.start())}>
                  Start match
                </button>
              )}
              <button type="button" className="small" disabled={busy} onClick={() => void run(() => bridge.match.leave())}>
                {st.phase === 'over' ? 'Close match' : 'Leave'}
              </button>
            </div>
            {st.phase === 'playing' && st.locked && <small className="muted">Your table is locked until your ball comes up.</small>}
          </div>

          {panel?.result && (
            <div className="card">
              <strong>Result</strong>
              <table className="match-table">
                <tbody>
                  {panel.result.map((r) => (
                    <tr key={r.id}>
                      <td>{r.place}.</td>
                      <td>{r.name}</td>
                      <td className="num">{r.score.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <small className="muted">Each game also posted to ArcAid as a normal score.</small>
            </div>
          )}

          <div className="card">
            <p className="muted">{mediaLine(st.media)}</p>
            <p className="muted" title={st.rigReason}>
              {rigLine(st)} <small>{st.rigReason}</small>
            </p>
            <p className="muted">{overlayLine(st.vrOverlay)}</p>
            {singleEyePreview(st) && (
              <p>
                Set VPX's VR preview to "both eyes" so the other player sees your table in stereo: Preferences → VR → Preview: Both Eyes, with the preview window
                twice as wide as 16:9 (Preview width 2560, height 720).
              </p>
            )}
          </div>
        </>
      )}

      {shownError && <p className="error">{shownError}</p>}

      <div className="card">
        <div className="row">
          <label className="field">
            <span>Microphone</span>
            <select value={st.micDeviceId ?? ''} onChange={(e) => pickMic(e.target.value)}>
              <option value="">Windows default</option>
              {savedMicMissing && <option value={st.micDeviceId ?? ''}>The microphone you picked last time</option>}
              {st.microphones.map((m) => (
                <option key={m.deviceId} value={m.deviceId}>
                  {m.label || 'Unnamed microphone'}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="small" onClick={toggleMute}>
            {st.muted ? 'Unmute' : 'Mute'}
          </button>
        </div>
        <small>
          Pick your headset microphone: in VR the Windows default is often a virtual device.
          {st.microphones.length === 0 ? ' No microphone listed yet: plug one in, then open this tab again.' : ''}
        </small>
      </div>

      <div className="card">
        <div className="row">
          <label className="field">
            <span>In the headset on your ball</span>
            <select value={st.settings.theaterDuringMyTurn} onChange={(e) => setView({ theaterDuringMyTurn: e.target.value === 'panel' ? 'panel' : 'hidden' })}>
              <option value="hidden">Nothing over your table</option>
              <option value="panel">The match panel, low in view</option>
            </select>
            <small>What you see while you play your ball: just your table, or the scores panel below it.</small>
          </label>
          <label className="field">
            <span>In the headset on their ball</span>
            <select value={st.settings.spectate} onChange={(e) => setView({ spectate: e.target.value === 'panel' ? 'panel' : 'theater' })}>
              <option value="theater">Their table where yours was (theater)</option>
              <option value="panel">The match panel, low in view</option>
            </select>
            <small>Theater replaces your view with the other player's table on a big screen; it needs the Castcade OpenXR layer (not SteamVR).</small>
          </label>
        </div>
      </div>

      <div className="card">
        <label className="field">
          <span>Turn sound volume ({volume ?? st.settings.cueVolume})</span>
          <input
            type="range"
            min={0}
            max={100}
            value={volume ?? st.settings.cueVolume}
            onChange={(e) => setVolume(Number(e.target.value))}
            onMouseUp={commitVolume}
            onKeyUp={commitVolume}
            onBlur={commitVolume}
          />
          <small>Plays on the default sound device (the headset in VR) when your ball comes up, when another player's does, and at the end.</small>
        </label>
      </div>
    </section>
  );
}

function nameOf(st: MatchStatus, id: string | null): string {
  return st.participants.find((p) => p.id === id)?.name ?? 'the host';
}

function turnLine(st: MatchStatus): string {
  const panel = st.panel;
  switch (st.phase) {
    case 'lobby':
      return st.role === 'host' ? (st.participants.length < 2 ? 'Waiting for players' : 'Everyone in? Start the match') : `Waiting for ${nameOf(st, st.hostId)} to start`;
    case 'playing':
      if (!panel?.playerUp) return 'Next ball coming up';
      return panel.myTurn ? `YOUR BALL ${panel.ball ?? ''}`.trim() : `${nameOf(st, panel.playerUp).toUpperCase()} IS UP`;
    case 'paused':
      return 'PAUSED';
    case 'over':
      return 'MATCH OVER';
    default:
      return '';
  }
}

function mediaLine(m: MatchStatus['media']): string {
  if (!m) return 'Video and voice: not in this build yet.';
  if (!m.attached) return `Video and voice: not connected${m.lastError ? ` (${m.lastError})` : ''}.`;
  const peers = Object.entries(m.peers).map(([id, p]) => `${id} ${p.ice}`);
  return `Video and voice: ${m.sending ? 'sending your table' : 'not sending'} · mic ${m.mic}${m.captureSource ? ` · ${m.captureSource}` : ''}${peers.length ? ` · ${peers.join(', ')}` : ''}${m.lastError ? ` · ${m.lastError}` : ''}.`;
}

/** B22 (mirrors witness/vr-detect.ts VR_RUNTIME_LABEL). */
const RUNTIME_LABEL: Record<NonNullable<MatchStatus['vrRuntime']>, string> = {
  steamvr: 'SteamVR',
  'virtual-desktop': 'Virtual Desktop (OpenXR)',
  oculus: 'the Oculus / Meta runtime (OpenXR)',
  'openxr-other': 'an OpenXR runtime',
};

/** A6 (2026-10-31): the panel's place as the match host decided it, so the player sees it without the log. */
function rigLine(st: MatchStatus): string {
  if (st.rig === 'pc') return 'Rig: monitor (desktop panel).';
  const o = st.vrOverlay;
  const rt = st.vrRuntime ?? 'steamvr';
  const state = o ? `${o.state}${o.reason ? `, ${o.reason}` : ''}` : 'not in this build';
  if (rt === 'steamvr') return `Rig: VR headset via SteamVR (overlay: ${o ? state : 'no helper in this build'}).`;
  // D7.3 (2026-10-31): off SteamVR the Castcade OpenXR layer draws the panel inside VPX. The loader reads the layer list
  // when VPX starts VR, so a VPX started before Castcade first registered the layer has to be restarted once.
  const restart =
    o?.reason === 'restart_vpx'
      ? ' VPX was started before Castcade registered its layer: close VPX and start the table again, and the panel appears in the headset.'
      : '';
  return `Rig: VR headset via ${RUNTIME_LABEL[rt]}. In-headset panel: via the Castcade OpenXR layer (${state}).${restart}`;
}

function overlayLine(o: MatchStatus['vrOverlay']): string {
  if (!o) return 'Headset panel: not in this build yet (the panel shows on the desktop).';
  return `Headset panel: ${o.state}${o.reason ? ` (${o.reason})` : ''}.`;
}
