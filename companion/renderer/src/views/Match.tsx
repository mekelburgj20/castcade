import { useEffect, useState } from 'react';
import { describe, type CastcadeState } from '../useCastcade.js';
import { TestBench } from './TestBench.js';

/**
 * A6 + C3 (docs/design/alpha-match.md §1, §3, 2026-10-30): the Match page. Host a match (the invite string to send the
 * other player) or join one by pasting it; then the roster, whose ball it is, the scores and, at the end, the result.
 * The turn lock, the cue and the media all run in the main process; this page only shows them and sends the
 * player's choices.
 *
 * A10 + A11 (2026-11-02): a match is a series of games, started from the host's table (a game started there starts the
 * match, then each next game). The host also gets Next game and End match here between games (the same IPC calls as
 * Start match and Leave: main decides by the phase), and the result card shows the series standings.
 */

const RIG_LABEL: Record<MatchStatus['participants'][number]['rig'], string> = { pc: 'PC', vr_headset: 'VR headset', real_cabinet: 'cabinet' };

/*
 * D7.4 (2026-10-31): VPX's VR preview "Both Eyes" (`[PlayerVR] VRPreview = 3`: the VRPreviewMode enum in
 * src/core/player.h, combo labels in dialogs/VROptionsDialog.cpp, vpinball v10.8.0-2051-28dd6c3) draws the left eye in
 * the window's left half and the right eye in its right half, each centre-cropped to its half's aspect. D7.4.3
 * (2026-11-01): this rig declares it to the others (media/preview-stereo.ts) and main words the advice
 * (`previewAdvice`); the "Your preview" setting overrides the ini.
 * D8.7 (2026-11-05, ADR 0009): spectating is 2D. The other player's table is a flat screen in the headset; the stereo
 * window's controls (Camera view, window depth, the eye offsets, the soft edge, the calibration pattern) are withdrawn
 * from this tab but their settings, IPC and layer protocol stay as 0.2.35 shipped them. One eye is the right preview.
 */

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
  // D2.10 (2026-11-05): the three volume sliders while being dragged; null shows the saved setting (a key press moves it too).
  const [voice, setVoice] = useState<number | null>(null);
  const [theirTable, setTheirTable] = useState<number | null>(null);
  const [myTable, setMyTable] = useState<number | null>(null);

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
  const setView = (
    patch: Partial<Pick<MatchSettings, 'theaterDuringMyTurn' | 'spectate' | 'previewStereo' | 'theaterScale' | 'cameraSource' | 'tableMuteMine' | 'tableSendMine' | 'tableHearOthers' | 'preMatchPlay'>>,
  ) => {
    void bridge.match.setSettings(patch).then(setSt, (e: unknown) => setError(describe(e)));
  };
  const commitVolume = () => {
    if (volume !== null && volume !== st.settings.cueVolume) void bridge.match.setSettings({ cueVolume: volume }).then(setSt, (e: unknown) => setError(describe(e)));
  };
  // D2.10: on release, what moved is saved; the sliders then show the setting again, so a Ctrl+Alt press shows too.
  const commitLevels = () => {
    const patch: Partial<MatchSettings> = {};
    if (voice !== null && voice !== st.settings.voiceVolume) patch.voiceVolume = voice;
    if (theirTable !== null && theirTable !== st.settings.othersTableVolume) patch.othersTableVolume = theirTable;
    if (myTable !== null && myTable !== st.settings.myTableWhileUp) patch.myTableWhileUp = myTable;
    const done = (s: MatchStatus) => {
      setSt(s);
      setVoice(null);
      setTheirTable(null);
      setMyTable(null);
    };
    if (Object.keys(patch).length === 0) done(st);
    else void bridge.match.setSettings(patch).then(done, (e: unknown) => setError(describe(e)));
  };
  const pickMic = (deviceId: string) => {
    void bridge.match.setMicrophone(deviceId === '' ? null : deviceId).then(setSt, (e: unknown) => setError(describe(e)));
  };
  // D2.6 (2026-11-01): the desktop panel is its own window; the button brings it back (or puts it away) at any time.
  const panelWin = st.media?.attached ? (st.media.panelWindow ?? null) : null;
  const togglePanel = () => {
    const call = panelWin?.visible ? bridge.match.hidePanel() : bridge.match.showPanel();
    void call.then(setSt, (e: unknown) => setError(describe(e)));
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
                {/* A12 (2026-11-05): the host's table before the match (saved at once; the lobby follows it live). */}
                <label className="field">
                  <span>Before the match</span>
                  <select value={st.settings.preMatchPlay} onChange={(e) => setView({ preMatchPlay: e.target.value === 'locked' ? 'locked' : 'free' })}>
                    <option value="free">Free play until someone joins</option>
                    <option value="locked">Table locked until someone joins</option>
                  </select>
                  <small>Free play: a game running when the others join must end first; your next Start on the table then starts the match.</small>
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
            {st.transfer && <p className="warn">{transferLine(st.transfer)}</p>}
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
              {st.role === 'host' && st.phase === 'over' && !st.series?.over && (
                <button
                  type="button"
                  className="primary"
                  disabled={busy || (st.series?.nextGameBlocker ?? null) !== null}
                  title={st.series?.nextGameBlocker ?? 'Or start a game on your table'}
                  onClick={() => void run(() => bridge.match.start())}
                >
                  Next game
                </button>
              )}
              {st.role === 'host' && st.phase === 'paused' && !st.transfer && (
                <button type="button" className="primary" disabled={busy} onClick={() => void run(() => bridge.match.resume())}>
                  Resume
                </button>
              )}
              <button type="button" className="small" disabled={busy} onClick={() => void run(() => bridge.match.leave())}>
                {st.phase === 'over' ? (st.role === 'host' && !st.series?.over ? 'End match' : 'Close match') : 'Leave'}
              </button>
            </div>
            {st.phase === 'playing' && st.locked && <small className="muted">Your table is locked until your ball comes up.</small>}
            {st.phase === 'lobby' && st.role === 'host' && st.participants.length >= 2 && (
              <small className="muted">Starting a game on your table starts the match too (after a 5 s countdown in every headset).</small>
            )}
            {st.phase === 'over' && st.role === 'client' && !st.series?.over && st.locked && (
              <small className="muted">Your table is locked until the next game reaches your ball.</small>
            )}
          </div>

          {panel?.result && (
            <div className="card">
              <strong>{panel.game && panel.game > 1 ? `Game ${panel.game}` : 'Result'}</strong>
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

          {panel?.series && panel.series.some((s) => s.games > 1) && (
            <div className="card">
              <strong>Series</strong>
              <table className="match-table">
                <thead>
                  <tr>
                    <th />
                    <th>Player</th>
                    <th className="num">Wins</th>
                    <th className="num">Games</th>
                    <th className="num">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {panel.series.map((s) => (
                    <tr key={s.id}>
                      <td>{s.place}.</td>
                      <td>{s.name}</td>
                      <td className="num">{s.wins}</td>
                      <td className="num">{s.games}</td>
                      <td className="num">{s.total.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="card">
            <p className="muted">{mediaLine(st.media)}</p>
            {st.media?.nativeVideo && <p className="muted">{nativeVideoLine(st.media.nativeVideo, st.participants)}</p>}
            {st.media?.nativeVideo?.helper === 'ready' && !st.media.nativeVideo.fallback && <VideoQualityRow st={st} video={st.media.nativeVideo} apply={(r) => bridge.match.setVideoRungs(r).then(setSt, (e: unknown) => setError(describe(e)))} />}
            {panelWin && (
              <div className="row">
                <p className="muted">{panelLine(panelWin)}</p>
                <button type="button" className="small" onClick={togglePanel}>
                  {panelWin.visible ? 'Hide panel' : 'Show panel'}
                </button>
              </div>
            )}
            <p className="muted" title={st.rigReason}>
              {rigLine(st)} <small>{st.rigReason}</small>
            </p>
            <p className="muted">{overlayLine(st.vrOverlay)}</p>
            {st.previewAdvice && <p>{st.previewAdvice}</p>}
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

      <TurnCard turn={st.turn} save={(t) => bridge.match.setTurn(t).then(setSt)} />

      <div className="card">
        <div className="row">
          <label className="field">
            <span>Spectator video</span>
            <select value={st.videoPath} onChange={(e) => bridge.match.setVideoPath(e.target.value === 'electron' ? 'electron' : 'native').then(setSt, () => undefined)}>
              <option value="native">Native helper (recommended)</option>
              <option value="electron">Electron (0.2.36 path)</option>
            </select>
            <small>
              Native: the castcade-video helper encodes your eye on the GPU (H.264, up to 60 fps) and the headset draws what arrives; voice stays as it was.
              Electron: the 0.2.36 picture through the match panel. Used from the next match.
            </small>
          </label>
        </div>
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
            <small>Theater: their table as a flat screen in front of you, where yours was; the view around it goes dark. Needs the Castcade OpenXR layer (not SteamVR).</small>
          </label>
          <label className="field">
            <span>Theater size</span>
            <select value={String(st.settings.theaterScale)} onChange={(e) => setView({ theaterScale: Number(e.target.value) })}>
              <option value="1">Life size</option>
              <option value="0.8">80 %</option>
              <option value="0.6">60 %</option>
            </select>
            <small>How big the screen is. Life size is the default; smaller puts the same picture over less of your view, so it looks sharper. Takes effect at once.</small>
          </label>
          <label className="field">
            <span>Your preview</span>
            <select
              value={st.settings.previewStereo}
              onChange={(e) => setView({ previewStereo: e.target.value === 'mono' ? 'mono' : e.target.value === 'sbs' ? 'sbs' : 'auto' })}
            >
              <option value="auto">As VPX is set (VR preview setting)</option>
              <option value="mono">One eye</option>
              <option value="sbs">Both eyes</option>
            </select>
            <small>
              Only used when the camera is the screen capture: what your VR preview window shows, told to the other players. One eye is right for 2D (VPX's
              default, Left Eye); Auto reads VPX's setting and this tab says so when it is Both Eyes.
            </small>
          </label>
          <label className="field">
            <span>Camera</span>
            <select value={st.settings.cameraSource} onChange={(e) => setView({ cameraSource: e.target.value === 'layer' ? 'layer' : 'screen' })}>
              <option value="layer">VR layer (the default: no preview window needed)</option>
              <option value="screen">Screen capture of the VR preview window</option>
            </select>
            <small>
              VR layer: Castcade reads the picture from VPX's headset view, no preview window needed (it needs the layer from this Castcade version in VPX:
              restart VPX after updating; PC and SteamVR rigs fall back to the screen capture). Screen capture: VPX's preview window on your desktop (keep
              other windows off it).
            </small>
          </label>
        </div>
      </div>

      <VrBenchCard bridge={bridge} onStatus={setSt} st={st} />

      <div className="card">
        <strong>Table sound</strong>
        <label className="check">
          <input type="checkbox" checked={st.settings.tableMuteMine} onChange={(e) => setView({ tableMuteMine: e.target.checked })} />
          Mute my table while others play
        </label>
        <label className="check">
          <input type="checkbox" checked={st.settings.tableSendMine} onChange={(e) => setView({ tableSendMine: e.target.checked })} />
          Send my table's sound
        </label>
        <label className="check">
          <input type="checkbox" checked={st.settings.tableHearOthers} onChange={(e) => setView({ tableHearOthers: e.target.checked })} />
          Hear the other table
        </label>
        <small>
          On your ball the others hear your table; on theirs you hear the player up, and your own VPX stays quiet (its backglass and PinUP too).
          {tableSoundLine(st)}
        </small>
      </div>

      <div className="card">
        <strong>Voice and table sound</strong>
        <label className="field">
          <span>Voice volume ({voice ?? st.settings.voiceVolume} %)</span>
          <input
            type="range"
            min={0}
            max={300}
            step={10}
            value={voice ?? st.settings.voiceVolume}
            onChange={(e) => setVoice(Number(e.target.value))}
            onMouseUp={commitLevels}
            onKeyUp={commitLevels}
            onBlur={commitLevels}
          />
          <small>The other players' voices; above 100 % is a boost. Ctrl+Alt+Up / Down changes the voice volume while you play.</small>
        </label>
        <label className="field">
          <span>Their table sound ({theirTable ?? st.settings.othersTableVolume} %)</span>
          <input
            type="range"
            min={0}
            max={100}
            step={10}
            value={theirTable ?? st.settings.othersTableVolume}
            onChange={(e) => setTheirTable(Number(e.target.value))}
            onMouseUp={commitLevels}
            onKeyUp={commitLevels}
            onBlur={commitLevels}
          />
          <small>The player up's table as you hear it, under their voice.</small>
        </label>
        <label className="field">
          <span>My table while I play ({myTable ?? st.settings.myTableWhileUp} %)</span>
          <input
            type="range"
            min={10}
            max={100}
            step={10}
            value={myTable ?? st.settings.myTableWhileUp}
            onChange={(e) => setMyTable(Number(e.target.value))}
            onMouseUp={commitLevels}
            onKeyUp={commitLevels}
            onBlur={commitLevels}
          />
          <small>Your own VPX's volume on your ball (its own volume again after it); needs the table-sound helper. Ctrl+Alt+Left / Right changes it while you play.</small>
        </label>
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

/**
 * D7.6 (2026-11-03): the VR test bench: checks a player can run alone in the headset. D7.6.2: "Write VR report" writes
 * the whole picture of how VPX reaches the headset (the layer's session report, the settings, the counters, the
 * preview window) beside companion.log and shows where. D7.6.1's calibration pattern (the layer's own stereo grid) is
 * withdrawn from the tab under ADR 0009; `setVrTest` and `vrBench.pattern` stay in the IPC and main.
 */
function VrBenchCard({ bridge, onStatus, st }: { bridge: CastcadeBridge; onStatus: (s: MatchStatus) => void; st: MatchStatus }) {
  const [busy, setBusy] = useState(false);
  const [written, setWritten] = useState<{ md: string; json: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const writeReport = () => {
    setBusy(true);
    setError(null);
    void bridge.match
      .vrReport()
      .then(setWritten, (e: unknown) => setError(describe(e)))
      .finally(() => setBusy(false));
  };
  return (
    <div className="card">
      <strong>VR test bench</strong>
      {/* D7.6: theater alone (a clip or my own table, straight to the layer or through a local WebRTC loop), Save 2 s of frames. */}
      <TestBench bridge={bridge} st={st} onStatus={onStatus} bare />
      {/* D7.6.2: the VR report. */}
      <div className="row">
        <button type="button" className="small" disabled={busy} onClick={writeReport}>
          {busy ? 'Writing the VR report…' : 'Write VR report'}
        </button>
      </div>
      <small>
        Writes what the headset, the runtime and VPX say about the picture (and this app's settings and counters) to a file to send. VPX should be running in VR for
        the headset part; it takes a few seconds.
      </small>
      {written && (
        <p className="muted">
          Written: <code>{written.md}</code> (and <code>.json</code> beside it)
        </p>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

/** D2.8: the table-sound state in one line (appended to the card's note), or nothing when all is well and idle. */
function tableSoundLine(st: MatchStatus): string {
  const t = st.media?.tableAudio;
  if (!t) return '';
  if (t.helper === 'unavailable') {
    const why = t.reason === 'helper_missing' ? 'this build has no table-sound helper' : `the helper did not start (${t.reason ?? 'unknown'})`;
    return ` Table sound unavailable: ${why}; every player hears their own table.`;
  }
  const notes: string[] = [];
  if (t.reason?.startsWith('tap_unavailable:')) notes.push('sending your table needs Windows 10 2004 or newer (muting still works)');
  if (t.muted) notes.push('your table is muted now');
  if (t.tapping) notes.push('your table is being sent now');
  return notes.length ? ` Table sound: ${notes.join('; ')}.` : '';
}

function nameOf(st: MatchStatus, id: string | null): string {
  return st.participants.find((p) => p.id === id)?.name ?? 'the host';
}

function turnLine(st: MatchStatus): string {
  const panel = st.panel;
  switch (st.phase) {
    case 'lobby':
      if (typeof panel?.countdown === 'number') return `STARTING IN ${panel.countdown}`;
      return st.role === 'host' ? (st.participants.length < 2 ? 'Waiting for players' : 'Everyone in? Start the match') : `Waiting for ${nameOf(st, st.hostId)} to start`;
    case 'playing': {
      const game = panel?.game && panel.game > 1 ? `GAME ${panel.game} · ` : '';
      if (!panel?.playerUp) return `${game}Next ball coming up`;
      return game + (panel.myTurn ? `YOUR BALL ${panel.ball ?? ''}`.trim() : `${nameOf(st, panel.playerUp).toUpperCase()} IS UP`);
    }
    case 'paused':
      return 'PAUSED';
    case 'over':
      return st.series && !st.series.over ? `GAME ${st.series.game} OVER` : 'MATCH OVER';
    default:
      return '';
  }
}

/** A8 (2026-10-31): the companions agree to a transfer by themselves (same log, they ack); the player only sees it. */
function transferLine(t: NonNullable<MatchStatus['transfer']>): string {
  const to = t.newHost ?? 'another player';
  return t.reason === 'host_left' ? `The host left: ${to} is taking over as host…` : `${t.proposer} is handing the host over to ${to}…`;
}

/**
 * D2.9 (2026-11-02): the TURN relay (media.json). Two players behind routers that block a direct connection (EFUKTZ)
 * need one; it is used from the next match on. The credential is never shown back: blank keeps the saved one.
 */
function TurnCard({ turn, save }: { turn: MatchStatus['turn']; save: (t: { url: string; username: string; credential: string | null } | null) => Promise<void> }) {
  const [url, setUrl] = useState<string | null>(null);
  const [username, setUsername] = useState<string | null>(null);
  const [credential, setCredential] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const urlText = url ?? turn?.url ?? '';
  const userText = username ?? turn?.username ?? '';
  const dirty = url !== null || username !== null || credential !== '';
  const submit = (clear: boolean) => {
    setNote(null);
    const t = clear || urlText.trim() === '' ? null : { url: urlText, username: userText, credential: credential === '' ? null : credential };
    save(t).then(
      () => {
        setUrl(null);
        setUsername(null);
        setCredential('');
        setNote(t ? 'Saved: used from the next match.' : 'Cleared: STUN only from the next match.');
      },
      (e: unknown) => setNote(describe(e)),
    );
  };
  return (
    <div className="card">
      <div className="row">
        <label className="field">
          <span>TURN relay</span>
          <input type="text" value={urlText} placeholder="turn:relay.example.org:3478" onChange={(e) => setUrl(e.target.value)} />
        </label>
        <label className="field">
          <span>Username</span>
          <input type="text" value={userText} onChange={(e) => setUsername(e.target.value)} />
        </label>
        <label className="field">
          <span>Credential</span>
          <input type="password" value={credential} placeholder={turn?.credentialSet ? 'saved (blank keeps it)' : ''} onChange={(e) => setCredential(e.target.value)} />
        </label>
        <button type="button" className="small" disabled={!dirty} onClick={() => submit(false)}>
          Save
        </button>
        {turn && (
          <button type="button" className="small" onClick={() => submit(true)}>
            Clear
          </button>
        )}
      </div>
      <small>
        Only if video and voice never connect (&quot;no path to …&quot;): a relay carries them when both routers block a direct connection. Used from the next match.
        {note ? ` ${note}` : ''}
      </small>
    </div>
  );
}

function mediaLine(m: MatchStatus['media']): string {
  if (!m) return 'Video and voice: not in this build yet.';
  if (!m.attached) return `Video and voice: not connected${m.lastError ? ` (${m.lastError})` : ''}.`;
  const peers = Object.entries(m.peers).map(([id, p]) => `${id} ${p.ice}`);
  return `Video and voice: ${m.sending ? 'sending your table' : 'not sending'} · mic ${m.mic}${m.captureSource ? ` · ${m.captureSource}` : ''}${m.captureWarning ? ` · ${m.captureWarning}` : ''}${peers.length ? ` · ${peers.join(', ')}` : ''}${m.lastError ? ` · ${m.lastError}` : ''}.`;
}

/**
 * D10.3 (2026-11-07): the native spectator video in one line, from the mesh status: the encoder, what this rig sends
 * (size, fps, Mbps), what arrives from each peer, and each peer's ICE state and candidate pair; or why the helper is
 * not running. D10.3.6 (2026-11-07): once the mesh fell back (a peer's connection failed with the helper's restarts
 * exhausted, or the helper went away), the line says the Electron video serves this match, and keeps the encoder.
 */
function nativeVideoLine(v: NonNullable<NonNullable<MatchStatus['media']>['nativeVideo']>, participants: MatchStatus['participants']): string {
  if (v.helper === 'unavailable') {
    const why = v.reason === 'helper_missing' ? 'this build has no video helper' : `the helper ${v.encoder ? 'is gone' : 'did not start'} (${v.reason ?? 'unknown'})`;
    return `Native video unavailable: ${why}; the Electron video serves this match.`;
  }
  if (v.helper !== 'ready') return `Native video: helper ${v.helper}${v.reason ? ` (${v.reason})` : ''}${v.fallback ? '; the Electron video serves this match' : ''}.`;
  if (v.fallback) return `Native video failed to connect; the Electron video serves this match${v.encoder ? ` (encoder ${v.encoder})` : ''}.`;
  const name = (id: string) => participants.find((p) => p.id === id)?.name ?? id;
  const mbps = (kbps: number) => `${(kbps / 1000).toFixed(1)} Mbps`;
  const parts: string[] = [v.encoder ?? 'encoder unknown'];
  const peers = Object.entries(v.peers);
  const sent = peers.map(([, p]) => p.send).find((s) => s && s.width > 0);
  // D10.6: `wgc` = the helper captures the VPX window itself (desktop rigs); `ring` = the OpenXR layer's camera.
  const src =
    v.source.kind === 'wgc'
      ? v.source.state === 'ok'
        ? 'capturing the VPX window natively'
        : 'no VPX window to capture yet'
      : v.source.kind === 'none'
        ? 'no source on this rig yet'
        : v.source.state && v.source.state !== 'ok'
          ? `ring ${v.source.state}`
          : null;
  if (v.sending) parts.push(`${sent ? `sending ${sent.width}x${sent.height} at ${sent.fps} fps, ${mbps(sent.kbps)}` : 'sending'}${src ? ` (${src})` : ''}`);
  else parts.push('not sending');
  for (const [id, p] of peers) {
    if (p.recv && p.recv.width > 0) parts.push(`from ${name(id)}: ${p.recv.fps} fps, ${mbps(p.recv.kbps)}`);
    parts.push(`${peers.length > 1 ? `${name(id)} ` : ''}ice ${p.ice}${p.pair ? ` (${p.pair})` : ''}`);
  }
  // D10.3.8: theater fell back to the panel page's frames (no native frame from the player up for 5 s).
  if (v.theaterPath === 'pipe') parts.push('theater from the Electron frames');
  return `Native video: ${parts.join(' · ')}.`;
}

type NativeVideo = NonNullable<NonNullable<MatchStatus['media']>['nativeVideo']>;

const mbps = (kbps: number): string => `${(kbps / 1000).toFixed(1)} Mbps`;

/**
 * D10.5 (2026-11-07): the readout of the rung in force (mirrors `rungReadout` in media/video-mesh.ts): the mode, the
 * rung the helper applies to the peer we send to, its size and fps, the sent Mbps while sending (else the rung's).
 */
function rungReadout(v: NativeVideo, pin: number | null): string {
  const mode = pin === null ? 'Auto' : `Pinned to rung ${pin}`;
  const peers = Object.values(v.peers);
  const inForce = peers.map((p) => p.rung).find((r) => r !== null) ?? null;
  const sent = v.sending ? (peers.map((p) => p.send).find((s) => s && s.width > 0) ?? null) : null;
  if (!inForce) {
    const g = v.ladder[2];
    return `${mode} (rung ${pin ?? 3} to start${g && pin === null ? `: ${g.width}x${g.height} at ${g.fps} fps` : ''})`;
  }
  const rate = sent ? mbps(sent.kbps) : `up to ${mbps(inForce.kbps)}`;
  const why = inForce.reason.startsWith('down:') ? `, stepped down on ${inForce.reason.slice(5)}` : inForce.reason === 'ceiling' ? ', at the ceiling' : '';
  return `${mode} (rung ${inForce.rung}: ${inForce.width}x${inForce.height} at ${sent ? sent.fps : inForce.fps} fps, ${rate}${why})`;
}

/**
 * D10.5: the quality controls of the native video (absorbs D8.2): the readout of the rung in force, the pin (Auto or
 * one of the six rungs, sized for this rig's source), and this rig's ceiling in kbps (saved; the host-wide ceiling is
 * D10.5.1). The pin applies at once to a running match and lasts for this run of the app.
 */
function VideoQualityRow({ st, video, apply }: { st: MatchStatus; video: NativeVideo; apply: (r: { maxKbps?: number; pin?: number | null }) => void }) {
  const [ceiling, setCeiling] = useState<string | null>(null);
  const shown = ceiling ?? String(st.videoMaxKbps);
  const commit = (): void => {
    if (ceiling === null) return;
    const n = Number(ceiling);
    setCeiling(null);
    if (Number.isFinite(n) && Math.round(n) !== st.videoMaxKbps) apply({ maxKbps: Math.round(n) });
  };
  return (
    <div className="row">
      <label className="field">
        <span>Spectator video: {rungReadout(video, st.videoPin)}</span>
        <select value={st.videoPin === null ? 'auto' : String(st.videoPin)} onChange={(e) => apply({ pin: e.target.value === 'auto' ? null : Number(e.target.value) })}>
          <option value="auto">Auto (the controller picks the rung)</option>
          {video.ladder.map((r) => (
            <option key={r.rung} value={String(r.rung)}>
              {`${r.rung}: ${r.width}x${r.height} at ${r.fps} fps, ${mbps(r.kbps)}`}
            </option>
          ))}
        </select>
        <small>Auto steps down a rung after 3 s of trouble and up after 30 s clean; a pin holds one rung. Full size at 30 fps comes before a smaller picture at 60: smoothness first.</small>
      </label>
      <label className="field">
        <span>Ceiling (kbps)</span>
        <input
          type="number"
          min={500}
          max={50000}
          step={500}
          value={shown}
          onChange={(e) => setCeiling(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
        />
        <small>The most this rig sends (default 20000: rung 1). Saved.</small>
      </label>
    </div>
  );
}

/** D2.6 (2026-11-01): the match panel is a second window; say so, and where it is. */
function panelLine(p: NonNullable<NonNullable<MatchStatus['media']>['panelWindow']>): string {
  if (!p.visible) return 'The match panel is a separate window ("Castcade match"), hidden now.';
  const where = { right: 'to the right of this window', left: 'to the left of this window', below: 'below this window', edge: "at the screen's right edge, over part of this window" }[p.side];
  return `The match panel is a separate window ("Castcade match"), ${where}. It is not in the picture you send.`;
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
  // D7.3.3 (2026-11-02): the VPX running started before this layer was registered (an update while VPX ran): it runs
  // an older layer, or none, until it restarts.
  const restart = o?.vpxBeforeLayer
    ? ' VPX started before this layer was registered: restart VPX for the latest theater.'
    : o?.reason === 'restart_vpx'
      ? ' VPX was started before Castcade registered its layer: close VPX and start the table again, and the panel appears in the headset.'
      : '';
  return `Rig: VR headset via ${RUNTIME_LABEL[rt]}. In-headset panel: via the Castcade OpenXR layer (${state}).${restart}`;
}

function overlayLine(o: MatchStatus['vrOverlay']): string {
  if (!o) return 'Headset panel: not in this build yet (the panel shows on the desktop).';
  return `Headset panel: ${o.state}${o.reason ? ` (${o.reason})` : ''}.`;
}
