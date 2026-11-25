import { useEffect, useState, type KeyboardEvent } from 'react';
import { describe, type CastcadeState } from '../useCastcade.js';
import { OneStepCard, TablePicker, useOneStep } from './OneStep.js';
import { TestBench } from './TestBench.js';
import { WatchCard, useWatch, watchHoldsRoom } from './Watch3D.js';

/**
 * A6 + C3 (docs/design/alpha-match.md §1, §3, 2026-10-30): the Match page. Host a match (the invite string to send the
 * other player) or join one by pasting it; then the roster, whose ball it is, the scores and, at the end, the result.
 * The turn lock, the cue and the media all run in the main process; this page only shows them and sends the
 * player's choices.
 *
 * A10 + A11 (2026-11-02): a match is a series of games, started from the host's table (a game started there starts the
 * match, then each next game). The host also gets Next game and End match here between games (the same IPC calls as
 * Start match and Leave: main decides by the phase), and the result card shows the series standings.
 *
 * A17 step 7 (2026-11-25, alpha-match.md section 11.9): a lobby that outlives a match. This step puts the MINIMUM
 * here so that the lobby can be used and tested; the real screens are step 9. Open a lobby / Join a lobby where Host
 * and Join were; in a lobby: who is in it and what each row says (PLAY or WATCH, AWAY, LOADING, NO TABLE, OTHER
 * TABLE, OWN GAME), the Play / Watch switch for one's own row, Start (anybody; it counts down, with who started it,
 * and Cancel), Start without <name>, Start anyway, Start a new match, End match, Give up this game, the lobby PC's
 * answers about a player who is away, and Leave lobby / Close lobby. The words are section 11.9's.
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
  // A14: the table Host starts in VPX (a path from Castcade's own list; null: the player opens one).
  const [tablePath, setTablePath] = useState<string | null>(null);
  const one = useOneStep(bridge);
  // I11.4.1: the 3D watch session holds this PC's ArcAid room while it is on: Host and Join a match wait for it.
  const watch3d = useWatch(bridge);
  const [copied, setCopied] = useState(false);
  // A13: the two host actions that ask first: a start with a table that cannot report ball ends, and Pass the turn.
  // `pass` remembers whose ball was asked about: if the turn moves on meanwhile, the question is withdrawn.
  // A17 step 7: and the lobby's: End match for everyone, Give up this game, Close lobby, Leave lobby during one's own
  // game, Start a new match, and what the lobby's PC does about a player who is away. The review of PR 136: each
  // remembers what it was asked about (`about`: the match and its game, `lobby.gameKey`; `player`: whom): the row is
  // gone when that is no longer what there is, it does not come up again in the next game, and the press carries it
  // to the main process, which does nothing for a subject that has changed.
  const [confirming, setConfirming] = useState<
    | { what: 'start' }
    | { what: 'pass'; turn: string }
    | { what: 'endBall'; turn: string }
    | { what: 'endEveryone'; about: string }
    | { what: 'giveUp'; about: string }
    | { what: 'close' }
    | { what: 'leave'; about: string }
    | { what: 'newMatch'; about: string }
    | { what: 'playOn'; player: string }
    | { what: 'awayEnd'; player: string }
    | { what: 'awayPlayOn'; player: string }
    | null
  >(null);
  // Design 11.9: a member who is away is "AWAY 0:42": the seconds are counted here, only while somebody is away.
  const [now, setNow] = useState(() => Date.now());
  const anyAway = (st?.lobby?.members.some((m) => m.awaySince !== null) ?? false) || (st?.lobby?.hostAway ?? null) !== null;
  useEffect(() => {
    if (!anyAway) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [anyAway]);
  const [volume, setVolume] = useState<number | null>(null);
  // D2.10 (2026-11-05): the three volume sliders while being dragged; null shows the saved setting (a key press moves it too).
  const [voice, setVoice] = useState<number | null>(null);
  const [theirTable, setTheirTable] = useState<number | null>(null);
  const [myTable, setMyTable] = useState<number | null>(null);
  // D8.10: what the last key pressed into a menu-key field came to ("that key cannot be used"), per field.
  const [keyNote, setKeyNote] = useState<{ field: 'menuKey' | 'menuChooseKey'; text: string } | null>(null);

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
    patch: Partial<Pick<MatchSettings, 'theaterDuringMyTurn' | 'spectate' | 'previewStereo' | 'theaterScale' | 'cameraSource' | 'tableMuteMine' | 'tableSendMine' | 'tableHearOthers' | 'preMatchPlay' | 'startTableOnHost' | 'scoreboard' | 'scoreboardCorner' | 'scoreboardAnchor' | 'watch3d'>>,
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
  // D8.10: a key pressed in a menu-key field becomes that key (a controller button mapped to a key works the same way).
  const captureKey = (field: 'menuKey' | 'menuChooseKey') => (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Tab') return;
    e.preventDefault();
    const acc = acceleratorOf(e);
    if (acc === null) return;
    void bridge.match.setSettings({ [field]: acc }).then(
      (s) => {
        setSt(s);
        setKeyNote(s.settings[field] === acc ? null : { field, text: `${keyWords(acc)} cannot be used here: try a function key, or a letter with Ctrl and Alt.` });
      },
      (err: unknown) => setError(describe(err)),
    );
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

      {/* A14: a link that waits for a click, the join link while hosting, and what the table start is doing. */}
      <OneStepCard bridge={bridge} one={one} role={st.role} phase={st.phase} />

      {/* A15: Castcade closed during a match that is still worth going back to. A17 step 7 (2026-11-25): the match was
          in a lobby. A member goes back into the lobby and, when the match is still open, into the match where it is
          now. The lobby's PC opens the lobby again under its code; the match that was open is lost (step 8 restores it),
          and the card says so before the button is pressed. */}
      {!inMatch && st.phase !== 'connecting' && st.resume && (
        <div className="card">
          <strong>
            You were in a lobby{st.resume.names.length > 0 ? ` with ${listOf(st.resume.names)}` : ''}
          </strong>
          <p>
            Castcade closed during a match in the lobby {st.resume.code}.{' '}
            {st.resume.role === 'host'
              ? 'Open it again and the others come back into it by themselves, if they are still waiting (they wait 20 minutes). The match that was being played is lost: start a new one when everyone is back.'
              : 'Rejoin and you are back in the lobby, and in the match where it is now if it is still open. Your microphone goes on again for the others.'}
          </p>
          <div className="row">
            <button type="button" className="primary" disabled={busy} onClick={() => void run(() => bridge.match.rejoin())}>
              {st.resume.role === 'host' ? 'Open it again' : 'Rejoin the lobby'}
            </button>
            <button type="button" className="small" disabled={busy} onClick={() => void run(() => bridge.match.forgetResume())}>
              Forget it
            </button>
          </div>
        </div>
      )}

      {!inMatch && st.phase !== 'connecting' && (
        <>
          <p className="muted">
            A lobby is joined once an evening: everyone in it can talk, play or watch, and you play as many matches as you like without leaving. A match is two to
            four players on the same table, one ball each in turn. Pick a table and press Open lobby: Castcade copies an invite link for the others. Send it, then
            press Start the table. Any order works: a table opened before or after is picked up.{tableOpen ? ` Open now: ${tableOpen}.` : ''}
          </p>
          <div className="card">
            <label className="field">
              <span>Your name</span>
              <input type="text" maxLength={64} value={displayName} onChange={(e) => setName(e.target.value)} />
            </label>
          </div>

          {watchHoldsRoom(watch3d) && <p className="muted">Leave the 3D watch session below to open or join a lobby.</p>}
          {!watchHoldsRoom(watch3d) && (
          <>
          <div className="card">
            <strong>Open a lobby</strong>
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
                {/* A17 step 7 (2026-11-25): A12's "Before the match" choice is not offered any more. In a lobby every
                    table is its owner's until a start counts down, and a game that runs on one is waited for; the
                    `preMatchPlay` key stays in match.json and is read by nothing in a lobby. */}
              </div>
              <TablePicker bridge={bridge} value={tablePath} onChange={setTablePath} tableOpen={tableOpen} startOnHost={st.settings.startTableOnHost} />
              {/* A14.7 (2026-11-15): off, Open lobby gives the invite first and the table starts from its own button. */}
              <label className="check">
                <input type="checkbox" checked={st.settings.startTableOnHost} onChange={(e) => setView({ startTableOnHost: e.target.checked })} />
                Start the table as soon as I open the lobby
              </label>
              <p className="muted">Off: Open lobby shows the invite first, so you can send it before VPX starts. Then press Start the table.</p>
              {/* A17 (2026-11-24): the voice is connected at the join, not at the match's start: said before the press. */}
              <p className="muted">
                You get a code to send. Everyone who joins can talk, play or watch. Play as many matches as you like without leaving. Your microphone is on for the
                others from the moment you open it.
              </p>
              <button
                type="button"
                className="primary"
                onClick={() =>
                  void run(() => bridge.launch.host({ tablePath: tableOpen ? null : tablePath, startTable: st.settings.startTableOnHost, port: Number(portText), ballsPerGame, displayName }))
                }
              >
                Open lobby
              </button>
            </fieldset>
          </div>

          <div className="card">
            <strong>Join a lobby</strong>
            <fieldset disabled={busy}>
              <label className="field">
                <span>Code or link</span>
                <input type="text" value={invite} placeholder="The join link, or the code JHDFEF" onChange={(e) => setInvite(e.target.value)} />
              </label>
              {/* A17 (2026-11-24): as on the Host card. */}
              <p className="muted">Your microphone is on for the people in the lobby from the moment you join.</p>
              <button
                type="button"
                onClick={() =>
                  void bridge.app.clipboardText().then((t) => {
                    const v = t.trim();
                    // D10.8: a relay invite is the six-letter code alone.
                    if (v.startsWith('castcade:') || /^[A-Za-z]{6}$/.test(v)) {
                      setError(null);
                      setInvite(v);
                    } else setError('The clipboard does not hold a Castcade link or invite (six letters, or one that starts with castcade:).');
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

          {/* I11.4.1: the 3D watch session, apart from any match. */}
          <WatchCard bridge={bridge} st={watch3d} />
        </>
      )}

      {st.phase === 'connecting' && (
        <div className="card">
          <p>Connecting to the lobby…</p>
        </div>
      )}

      {inMatch && (
        <>
          {/* A17 step 7: a lobby takes people in every phase, so the invite stays up (on every member's tab: step 9). */}
          {st.role === 'host' && st.invite && (
            <div className="card">
              <strong>Invite</strong>
              <div className="row">
                <code className="mono invite">{st.invite}</code>
                <button type="button" className="small" onClick={copyInvite}>
                  {copied ? 'Copied' : st.via === 'relay' ? 'Copy code' : 'Copy'}
                </button>
              </div>
              {st.via === 'relay' ? (
                <>
                  <p>Send the code to the others. The lobby goes through ArcAid: nothing to set up on your router. Each person needs Castcade paired with ArcAid.</p>
                  {/* The review of PR 136: this PC's own connection to ArcAid is away: said here, on the tab of the PC it is about. */}
                  {st.relayNote && <p className="warn">{st.relayNote}.</p>}
                  {st.directInvite && (
                    <p className="muted">
                      For a player on your home network or one who is not paired (needs TCP {st.port} forwarded for players outside): <code className="mono">{st.directInvite}</code>
                    </p>
                  )}
                </>
              ) : (
                <>
                  {st.portMapping ? (
                    <p className={st.portMapping.state === 'failed' ? 'warn' : 'muted'}>{st.portMapping.line}</p>
                  ) : (
                    <p>Forward TCP {st.port} to this PC on your router, then send the invite to the others.</p>
                  )}
                  {st.relayNote && <p className="muted">{st.relayNote}: a PC paired with ArcAid needs no port forward.</p>}
                  {st.ipSource === 'lan' && (
                    <p className="warn">Castcade could not look up your public address, so this is your home-network address. For a player outside your network, replace it with your public IP.</p>
                  )}
                </>
              )}
            </div>
          )}


          {/* A17 step 7: the lobby: its code, how it is reached, how many are here; and this person's own choice. */}
          {st.lobby && (
            <div className="card">
              <strong>
                Lobby {st.code}
                {st.path ? ` · ${st.path}` : ''} · {st.lobby.members.length} of 4 here
              </strong>
              <div className="row">
                <span>In the next match I</span>
                <button type="button" className={st.lobby.stance === 'play' ? 'primary' : 'small'} disabled={busy || st.lobby.over} onClick={() => void run(() => bridge.match.setStance('play'))}>
                  Play
                </button>
                <button type="button" className={st.lobby.stance === 'watch' ? 'primary' : 'small'} disabled={busy || st.lobby.over} onClick={() => void run(() => bridge.match.setStance('watch'))}>
                  Watch
                </button>
              </div>
              {st.lobby.match && st.lobby.stance === 'play' && !st.lobby.match.players.includes(st.localId ?? '') && (
                <small className="muted">You are watching this match. You are in when somebody starts a new match.</small>
              )}
              {st.lobby.match && st.lobby.stance === 'watch' && st.lobby.match.players.includes(st.localId ?? '') && (
                <small className="muted">
                  {/* Someone who is out of the game that is being played (gave it up, or was counted out) is not told they play. */}
                  {st.lobby.match.state === 'game' && !st.lobby.giveUp && !panel?.myTurn && playsNoMore(st) ? 'You sit out from the next game.' : 'You play this match. You sit out from the next game.'}
                </small>
              )}
            </div>
          )}

          <div className="card">
            <p className={panel?.myTurn ? 'turn-line mine' : 'turn-line'}>{turnLine(st)}</p>
            {st.transfer && <p className="warn">{transferLine(st.transfer)}</p>}
            {/* D10.8: which path the match control takes. */}
            {st.path && <p className="muted">{st.path}</p>}
            {panel?.message && !st.advisories.some((line) => panel.message?.includes(line)) && (
              <p className={panel.message.startsWith('different') || panel.message.includes('cannot report ball ends') || panel.message.startsWith('The lobby is closed') || panel.message.startsWith('The lobby is over') || st.lobby?.hostAway ? 'warn' : 'muted'}>{awayClock(st, panel.message, now)}</p>
            )}
            {/* B26: the Midnight Madness setting when it is ON on a table, and the balls of this game it ran on (a flag only). */}
            {st.advisories.map((line) => (
              <p key={line} className="warn">
                {line}
              </p>
            ))}
            <table className="match-table">
              <thead>
                <tr>
                  <th>{st.lobby ? 'In the lobby' : 'Player'}</th>
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
                        {p.id === st.hostId ? (st.lobby ? ' · opened the lobby' : ' · host') : ''}
                        {memberWords(st, p.id, now)}
                        {p.tableMatch === false && <span className="warn"> · {p.tableNote ?? 'different table file'}</span>}
                        {p.buildMatch === false && <span className="muted"> · different VPX build</span>}
                        {p.ballEnds === false && <span className="warn"> · cannot report ball ends</span>}
                        {/* In a lobby the row says AWAY, with the time (memberWords): not a second word for the same thing. */}
                        {!st.lobby && row?.flags.includes('disconnected') && <span className="warn"> · disconnected</span>}
                        {row?.flags.includes('midnight') && <span className="warn"> · Midnight Madness ran</span>}
                      </td>
                      <td>{RIG_LABEL[p.rig]}</td>
                      {/* Balls and score are a player's of the game on the panel: a member who only watches has neither. */}
                      <td>{st.lobby && !row ? '—' : `${row?.ballsDone ?? 0}/${panel?.ballsPerGame || '—'}`}</td>
                      <td className="num">{row?.score === null || row?.score === undefined ? '—' : row.score.toLocaleString()}</td>
                    </tr>
                  );
                })}
                {/* A player of the open match who has left the lobby keeps their row, and their score, until that match is over. */}
                {st.lobby &&
                  (panel?.players ?? [])
                    .filter((x) => !st.participants.some((p) => p.id === x.id))
                    .map((x) => (
                      <tr key={x.id} className={x.isUp ? 'up' : ''}>
                        <td>
                          {x.name}
                          <span className="muted"> · left the lobby</span>
                        </td>
                        <td>—</td>
                        <td>
                          {x.ballsDone}/{panel?.ballsPerGame || '—'}
                        </td>
                        <td className="num">{x.score === null || x.score === undefined ? '—' : x.score.toLocaleString()}</td>
                      </tr>
                    ))}
              </tbody>
            </table>
            {/* A17 step 7: the start, asked for by anyone: what a press does, the start that is announced, and how to take it back. */}
            {st.lobby && !st.lobby.over && (st.phase === 'lobby' || st.phase === 'over') && (
              <>
                {st.lobby.start ? (
                  <div className="row">
                    <span>
                      {st.lobby.start.line}
                      {st.lobby.start.seconds !== null ? ` · ${st.lobby.start.seconds}` : ''}
                    </span>
                    {st.lobby.startWithout && (
                      <button type="button" className="small" disabled={busy || st.lobby.hostAway !== null} title={st.lobby.hostAway ? "The lobby's PC is away: this waits until it is back" : undefined} onClick={() => void run(() => bridge.match.start({ now: true }))}>
                        {st.lobby.startWithout}
                      </button>
                    )}
                    <button type="button" className="small" disabled={busy || st.lobby.hostAway !== null} title={st.lobby.hostAway ? "The lobby's PC is away: this waits until it is back" : undefined} onClick={() => void run(() => bridge.match.cancelStart())}>
                      Cancel the start
                    </button>
                  </div>
                ) : (
                  <div className="row">
                    <button
                      type="button"
                      className="primary"
                      disabled={busy || st.lobby.startButton.off !== null || (confirming?.what === 'start' && st.startWarnings.length > 0)}
                      title={st.lobby.startButton.off ?? 'Or, for the starter, a game started on their own table'}
                      onClick={() => (st.startWarnings.length > 0 ? setConfirming({ what: 'start' }) : void run(() => bridge.match.start()))}
                    >
                      {st.lobby.startButton.label}
                    </button>
                    <span className="muted">{st.lobby.startButton.off ?? st.lobby.startButton.line}</span>
                    {st.lobby.newMatch && (
                      <button
                        type="button"
                        className="small"
                        disabled={busy || (confirming?.what === 'newMatch' && confirming.about === st.lobby.gameKey)}
                        onClick={() => setConfirming({ what: 'newMatch', about: st.lobby?.gameKey ?? '' })}
                      >
                        Start a new match
                      </button>
                    )}
                  </div>
                )}
              </>
            )}
            {st.lobby?.newMatch && confirming?.what === 'newMatch' && confirming.about === st.lobby.gameKey && (
              <div className="row">
                <span className="warn">
                  {st.lobby.newMatch.line}
                  {/* The review of PR 136: a table of the new match's players that cannot report ball ends is said here, and this press starts anyway. */}
                  {st.lobby.newMatch.warnings.length > 0
                    ? ` ${st.lobby.newMatch.warnings.join(' · ')}. Such a turn never ends by itself: that player ends each of those balls with End my ball, or the lobby's PC ends it with Pass the turn.`
                    : ''}
                </span>
                <button
                  type="button"
                  className="small"
                  disabled={busy}
                  onClick={() => {
                    const anyway = (st.lobby?.newMatch?.warnings.length ?? 0) > 0;
                    setConfirming(null);
                    void run(() => bridge.match.start({ newMatch: true, anyway }));
                  }}
                >
                  {st.lobby.newMatch.warnings.length > 0 ? 'Start a new match anyway' : 'Start a new match'}
                </button>
                <button type="button" className="small" disabled={busy} onClick={() => setConfirming(null)}>
                  Cancel
                </button>
              </div>
            )}
            {/* A17 step 7 (design 11.8): the lobby's PC, about a player the game waits for at their own turn. */}
            {st.lobby?.awayQuestion ? (
              <div className="row">
                <span className="warn">
                  {st.lobby.awayQuestion.name} has been out of the lobby's reach for {Math.max(1, st.lobby.awayQuestion.minutes)} minute{st.lobby.awayQuestion.minutes > 1 ? 's' : ''} and is still playing.
                </span>
                <button type="button" className="small" disabled={busy} onClick={() => void run(() => bridge.match.answerAway('wait', { player: st.lobby?.awayQuestion?.player ?? null }))}>
                  Keep waiting
                </button>
                <button
                  type="button"
                  className="small"
                  disabled={busy || (confirming?.what === 'awayEnd' && confirming.player === st.lobby.awayQuestion.player)}
                  title={`Their ball ends at ${st.lobby.awayQuestion.score.toLocaleString()} and the turn passes`}
                  onClick={() => setConfirming({ what: 'awayEnd', player: st.lobby?.awayQuestion?.player ?? '' })}
                >
                  End {possessive(st.lobby.awayQuestion.name)} ball
                </button>
                <button
                  type="button"
                  className="small"
                  disabled={busy || (confirming?.what === 'awayPlayOn' && confirming.player === st.lobby.awayQuestion.player)}
                  onClick={() => setConfirming({ what: 'awayPlayOn', player: st.lobby?.awayQuestion?.player ?? '' })}
                >
                  Play on without {st.lobby.awayQuestion.name}
                </button>
              </div>
            ) : (
              st.lobby?.waitedFor && (
                <div className="row">
                  <span className="muted">Waiting for {st.lobby.waitedFor.name} to come back.</span>
                  <button
                    type="button"
                    className="small"
                    disabled={busy || (confirming?.what === 'playOn' && confirming.player === st.lobby.waitedFor.player)}
                    onClick={() => setConfirming({ what: 'playOn', player: st.lobby?.waitedFor?.player ?? '' })}
                  >
                    Play on without {st.lobby.waitedFor.name}
                  </button>
                </div>
              )
            )}
            {/* The review of PR 136: as the in-game menu asks a second choose for them. Each row is about one player, and is gone when the game no longer waits for that player. */}
            {confirming?.what === 'awayEnd' && st.lobby?.awayQuestion && confirming.player === st.lobby.awayQuestion.player && (
              <div className="row">
                <span className="warn">
                  End {possessive(st.lobby.awayQuestion.name)} ball at {st.lobby.awayQuestion.score.toLocaleString()}? The turn passes.
                </span>
                <button
                  type="button"
                  className="small"
                  disabled={busy}
                  onClick={() => {
                    const player = confirming.player;
                    setConfirming(null);
                    void run(() => bridge.match.answerAway('end_ball', { player }));
                  }}
                >
                  End {possessive(st.lobby.awayQuestion.name)} ball
                </button>
                <button type="button" className="small" disabled={busy} onClick={() => setConfirming(null)}>
                  Cancel
                </button>
              </div>
            )}
            {confirming?.what === 'awayPlayOn' && st.lobby?.awayQuestion && confirming.player === st.lobby.awayQuestion.player && (
              <div className="row">
                <span className="warn">Play on without {st.lobby.awayQuestion.name}? They are out of this game; they stay in the lobby.</span>
                <button
                  type="button"
                  className="small"
                  disabled={busy}
                  onClick={() => {
                    const player = confirming.player;
                    setConfirming(null);
                    void run(() => bridge.match.answerAway('play_on', { player }));
                  }}
                >
                  Play on without {st.lobby.awayQuestion.name}
                </button>
                <button type="button" className="small" disabled={busy} onClick={() => setConfirming(null)}>
                  Cancel
                </button>
              </div>
            )}
            {confirming?.what === 'playOn' && st.lobby?.waitedFor && !st.lobby.awayQuestion && confirming.player === st.lobby.waitedFor.player && (
              <div className="row">
                <span className="warn">Play on without {st.lobby.waitedFor.name}? They are out of this game; they stay in the lobby.</span>
                <button
                  type="button"
                  className="small"
                  disabled={busy}
                  onClick={() => {
                    const player = confirming.player;
                    setConfirming(null);
                    void run(() => bridge.match.playOnWithout({ player }));
                  }}
                >
                  Play on without {st.lobby.waitedFor.name}
                </button>
                <button type="button" className="small" disabled={busy} onClick={() => setConfirming(null)}>
                  Cancel
                </button>
              </div>
            )}
            <div className="row">
              {st.role === 'host' && (st.phase === 'playing' || st.phase === 'paused') && st.pass && (
                <button
                  type="button"
                  className="small"
                  disabled={busy || (confirming?.what === 'pass' && confirming.turn === passTurnKey(st))}
                  title="End the ball of the player who is up at their last known score and give the next player the turn"
                  onClick={() => setConfirming({ what: 'pass', turn: passTurnKey(st) })}
                >
                  Pass the turn
                </button>
              )}
              {/* A17 step 4 (2026-11-24): the player who is up ends their own ball by hand (an unreadable table, a stuck ball). */}
              {st.phase === 'playing' && st.endBall && (
                <button
                  type="button"
                  className="small"
                  disabled={busy || (confirming?.what === 'endBall' && confirming.turn === endBallKey(st))}
                  title="End your own ball now at the score as it stands; the turn passes to the next player"
                  onClick={() => setConfirming({ what: 'endBall', turn: endBallKey(st) })}
                >
                  End my ball
                </button>
              )}
              {st.role === 'host' && st.phase === 'paused' && !st.transfer && (
                <button type="button" className="primary" disabled={busy} onClick={() => void run(() => bridge.match.resume())}>
                  Resume
                </button>
              )}
              {/* A17 step 7: a player gives up their own game; End match between games (anyone), or for everyone (the lobby's PC). */}
              {st.lobby?.giveUp && (
                <button
                  type="button"
                  className="small"
                  disabled={busy || (confirming?.what === 'giveUp' && confirming.about === st.lobby.gameKey)}
                  onClick={() => setConfirming({ what: 'giveUp', about: st.lobby?.gameKey ?? '' })}
                >
                  Give up this game
                </button>
              )}
              {/* The review of PR 136: End match is the request "between games" and says which match it was pressed for:
                  pressed as a countdown runs out, it is refused; it never ends the game that has just begun. */}
              {st.lobby?.end === 'match' && (
                <button
                  type="button"
                  className="small"
                  disabled={busy}
                  title="Closes the tally. Everyone stays in the lobby."
                  onClick={() => void run(() => bridge.match.endMatch({ everyone: false, about: st.lobby?.gameKey ?? null }))}
                >
                  End match
                </button>
              )}
              {st.lobby?.end === 'everyone' && (
                <button
                  type="button"
                  className="small"
                  disabled={busy || (confirming?.what === 'endEveryone' && confirming.about === st.lobby.gameKey)}
                  onClick={() => setConfirming({ what: 'endEveryone', about: st.lobby?.gameKey ?? '' })}
                >
                  End match for everyone
                </button>
              )}
              {st.role === 'host' ? (
                <button type="button" className="small" disabled={busy || confirming?.what === 'close'} onClick={() => setConfirming({ what: 'close' })}>
                  Close lobby
                </button>
              ) : (
                <button
                  type="button"
                  className="small"
                  disabled={busy || (confirming?.what === 'leave' && confirming.about === (st.lobby?.gameKey ?? ''))}
                  onClick={() => {
                    // The review of PR 136: a player who leaves during their own game gives it up first (design 11.2):
                    // that is asked about, as Give up this game is. Anybody else leaves with one press.
                    if (st.lobby?.giveUp) setConfirming({ what: 'leave', about: st.lobby.gameKey });
                    else void run(() => bridge.match.leave());
                  }}
                >
                  Leave lobby
                </button>
              )}
            </div>
            {confirming?.what === 'leave' && st.lobby?.giveUp && confirming.about === st.lobby.gameKey && (
              <div className="row">
                <span className="warn">Leave the lobby? You give up the game you are playing, and your microphone and your place go. Coming back is a new join.</span>
                <button
                  type="button"
                  className="small"
                  disabled={busy}
                  onClick={() => {
                    setConfirming(null);
                    void run(() => bridge.match.leave());
                  }}
                >
                  Leave lobby
                </button>
                <button type="button" className="small" disabled={busy} onClick={() => setConfirming(null)}>
                  Cancel
                </button>
              </div>
            )}
            {confirming?.what === 'giveUp' && st.lobby?.giveUp && confirming.about === st.lobby.gameKey && (
              <div className="row">
                <span className="warn">Give up this game? The others play on; you stay in the lobby and watch.</span>
                <button
                  type="button"
                  className="small"
                  disabled={busy}
                  onClick={() => {
                    const about = confirming.about;
                    setConfirming(null);
                    void run(() => bridge.match.giveUp({ about }));
                  }}
                >
                  Give up this game
                </button>
                <button type="button" className="small" disabled={busy} onClick={() => setConfirming(null)}>
                  Cancel
                </button>
              </div>
            )}
            {confirming?.what === 'endEveryone' && st.lobby?.end === 'everyone' && confirming.about === st.lobby.gameKey && (
              <div className="row">
                <span className="warn">End the match for everyone? The game being played gets no result.</span>
                <button
                  type="button"
                  className="small"
                  disabled={busy}
                  onClick={() => {
                    const about = confirming.about;
                    setConfirming(null);
                    void run(() => bridge.match.endMatch({ everyone: true, about }));
                  }}
                >
                  End match for everyone
                </button>
                <button type="button" className="small" disabled={busy} onClick={() => setConfirming(null)}>
                  Cancel
                </button>
              </div>
            )}
            {confirming?.what === 'close' && st.role === 'host' && (
              <div className="row">
                <span className="warn">This closes the lobby for everyone.{st.phase === 'playing' || st.phase === 'paused' ? ' The game being played gets no result.' : ''}</span>
                <button
                  type="button"
                  className="small"
                  disabled={busy}
                  onClick={() => {
                    setConfirming(null);
                    void run(() => bridge.match.leave());
                  }}
                >
                  Close lobby
                </button>
                <button type="button" className="small" disabled={busy} onClick={() => setConfirming(null)}>
                  Cancel
                </button>
              </div>
            )}
            {(st.phase === 'lobby' || st.phase === 'over') && confirming?.what === 'start' && st.startWarnings.length > 0 && (
              <div className="row">
                <span className="warn">
                  {st.startWarnings.join(' · ')}. Such a turn never ends by itself: that player ends each of those balls with End my ball (the in-game menu or this tab), or the lobby's PC ends it with Pass the turn.
                </span>
                <button
                  type="button"
                  className="small"
                  disabled={busy}
                  onClick={() => {
                    setConfirming(null);
                    void run(() => bridge.match.start({ anyway: true }));
                  }}
                >
                  Start anyway
                </button>
                <button type="button" className="small" disabled={busy} onClick={() => setConfirming(null)}>
                  Cancel
                </button>
              </div>
            )}
            {st.role === 'host' && confirming?.what === 'pass' && confirming.turn === passTurnKey(st) && st.pass && (st.phase === 'playing' || st.phase === 'paused') && (
              <div className="row">
                <span className="warn">
                  End {st.pass.name}'s ball {st.pass.ball} at {st.pass.score.toLocaleString()} and give the next player the turn? The match log records it as passed by the lobby's PC.
                </span>
                <button
                  type="button"
                  className="small"
                  disabled={busy}
                  onClick={() => {
                    setConfirming(null);
                    void run(() => bridge.match.passTurn());
                  }}
                >
                  Pass the turn
                </button>
                <button type="button" className="small" disabled={busy} onClick={() => setConfirming(null)}>
                  Cancel
                </button>
              </div>
            )}
            {confirming?.what === 'endBall' && confirming.turn === endBallKey(st) && st.endBall && st.phase === 'playing' && (
              <div className="row">
                <span className="warn">
                  End your ball now at {st.endBall.score.toLocaleString()}? The turn passes.
                  {st.endBall.tableBall ? ' The ball on your table is not lost: you play it out first at your next turn, then your next ball.' : ''}
                </span>
                <button
                  type="button"
                  className="small"
                  disabled={busy}
                  onClick={() => {
                    // The grant the question was about: the main process ends no other ball with it.
                    const asked = st.endBall?.grantSeq ?? -1;
                    setConfirming(null);
                    void run(() => bridge.match.endMyBall(asked));
                  }}
                >
                  End my ball
                </button>
                <button type="button" className="small" disabled={busy} onClick={() => setConfirming(null)}>
                  Cancel
                </button>
              </div>
            )}
            {st.phase === 'playing' && st.locked && (
              <small className="muted">
                {st.lobby && (!st.lobby.match?.players.includes(st.localId ?? '') || playsNoMore(st)) ? 'Your table is locked while this game is played: you are watching.' : 'Your table is locked until your ball comes up.'}
              </small>
            )}
            {st.lobby && !st.lobby.over && (st.phase === 'lobby' || st.phase === 'over') && st.lobby.starter === st.localId && !st.lobby.start && (
              <small className="muted">Starting a game on your table asks for the start too (it counts down 5 s in every headset).</small>
            )}
            {st.phase === 'over' && !st.series?.over && st.locked && <small className="muted">Your table is locked until the next game reaches your ball.</small>}
          </div>

          {panel?.result && (
            <div className="card">
              <strong>{panel.game && panel.game > 1 ? `Game ${panel.game}` : 'Result'}</strong>
              <table className="match-table">
                <tbody>
                  {panel.result.map((r) => (
                    <tr key={r.id}>
                      <td>{r.place}.</td>
                      <td>
                        {r.name}
                        {r.flags?.includes('midnight') && <span className="warn"> · Midnight Madness ran</span>}
                      </td>
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
            {/* I11.4.2: what this PC shows of each other player while they are up: 3D on its own table, or the 2D video and why. */}
            {st.stream3d?.players.map((p) => (
              <p className="muted" key={p.id}>
                {p.line}
              </p>
            ))}
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
          {/* I11.4.2 (ADR 0011): the player up on this PC's own table, in 3D, when both PCs can; the 2D video otherwise. */}
          <label className="field">
            <span>3D watch in a match</span>
            <select value={st.settings.watch3d} onChange={(e) => setView({ watch3d: e.target.value === 'off' ? 'off' : 'auto' })}>
              <option value="auto">Auto: their game on your own table when both PCs can</option>
              <option value="off">Off: always the 2D video</option>
            </select>
            <small>
              Auto: while another player is up you see their game on your own table, from your own seat, when both PCs run the Castcade VPX build
              (VPinballX_GL64_castcade.exe beside your VPX) on the identical table file; Castcade then starts match tables in that build. Anything else, and
              any trouble, shows the 2D video as before. Applies to tables started from now on.
            </small>
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
            <span>Scoreboard in the headset</span>
            <select
              value={st.settings.scoreboard ? st.settings.scoreboardCorner : 'off'}
              onChange={(e) => setView(e.target.value === 'off' ? { scoreboard: false } : { scoreboard: true, scoreboardCorner: e.target.value === 'top-left' ? 'top-left' : 'top-right' })}
            >
              <option value="top-right">Top right</option>
              <option value="top-left">Top left</option>
              <option value="off">Off</option>
            </select>
            <small>
              A small scoreboard up and to that side while you play and while you watch: scores, ball, game, and the games played and wins this session.
              Needs the Castcade OpenXR layer (not SteamVR); after an update, restart VPX once. Takes effect at once.
            </small>
          </label>
          {/* D8.12.3: fixed in the room (the default) or on the head, as it was before. */}
          <label className="field">
            <span>Scoreboard stays</span>
            <select
              value={st.settings.scoreboardAnchor}
              disabled={!st.settings.scoreboard}
              onChange={(e) => setView({ scoreboardAnchor: e.target.value === 'head' ? 'head' : 'room' })}
            >
              <option value="room">Fixed in the room</option>
              <option value="head">Follows my head</option>
            </select>
            <small>
              Fixed in the room: it stays where it was put when the table opened, up and to the side of where you were facing, and you turn your head to
              read it. To move it, look where you want it and choose "Put the scoreboard where I look" in the in-game menu. Follows my head: it sits in the
              corner of your view and moves with it. Takes effect at once; after an update, restart VPX once (until then it follows your head).
            </small>
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
        <strong>In-game menu</strong>
        <small>
          While you are in a lobby, the menu key brings up a menu on the panel (in the headset too): start a match or the next game, Play or watch, the three
          volumes, the microphone, End match, Leave lobby. Press the menu key again to move down; the choose key, or the menu key twice quickly, chooses. The arrow keys work while it is open.
          To use a controller button, map it to a key first (JoyToKey), then click a box and press the button.
        </small>
        <label className="field">
          <span>Menu key</span>
          <input type="text" readOnly className="port" value={keyWords(st.settings.menuKey)} onKeyDown={captureKey('menuKey')} title="Click, then press the key" />
          {keyNote?.field === 'menuKey' && <small className="warn">{keyNote.text}</small>}
        </label>
        <label className="field">
          <span>Choose key</span>
          <span className="row">
            <input
              type="text"
              readOnly
              className="port"
              value={st.settings.menuChooseKey === null ? 'none' : keyWords(st.settings.menuChooseKey)}
              onKeyDown={captureKey('menuChooseKey')}
              title="Click, then press the key"
            />
            <button
              type="button"
              className="small"
              disabled={st.settings.menuChooseKey === null}
              onClick={() => void bridge.match.setSettings({ menuChooseKey: null }).then(setSt, (e: unknown) => setError(describe(e)))}
            >
              None
            </button>
          </span>
          {keyNote?.field === 'menuChooseKey' && <small className="warn">{keyNote.text}</small>}
        </label>
        {st.menuKeyProblem && <small className="warn">{st.menuKeyProblem}</small>}
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
      // A17 step 1: a client that lost its host in the lobby: the lobby is over (the line under this one says why).
      if (st.series?.over) return st.lobby ? 'LOBBY CLOSED' : 'LOBBY OVER';
      if (typeof panel?.countdown === 'number') return `STARTING IN ${panel.countdown}`;
      // A17 step 7 (design 11.9, the panel's header): who starts, and how, is the line under this one (the lobby's own).
      if (st.lobby) return `LOBBY · ${st.lobby.members.length} HERE`;
      return st.role === 'host' ? (st.participants.length < 2 ? 'Waiting for players' : 'Everyone in? Start the match') : `Waiting for ${nameOf(st, st.hostId)} to start`;
    case 'playing': {
      // A lobby that was closed during a game: nobody is up any more.
      if (st.lobby?.over) return 'LOBBY CLOSED';
      const game = panel?.game && panel.game > 1 ? `GAME ${panel.game} · ` : '';
      if (!panel?.playerUp) return `${game}Next ball coming up`;
      return game + (panel.myTurn ? `YOUR BALL ${panel.ball ?? ''}`.trim() : `${nameOf(st, panel.playerUp).toUpperCase()} IS UP`);
    }
    case 'paused':
      return st.lobby?.over ? 'LOBBY CLOSED' : 'PAUSED';
    case 'over':
      if (st.lobby?.over) return 'LOBBY CLOSED';
      if (st.lobby && typeof panel?.countdown === 'number') return `STARTING IN ${panel.countdown}`;
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
/** A17 step 4: the ball End my ball was asked about, by its grant (the review of PR 131: a shoot-again grant is the same ball number), so a confirmation never lands on another ball. */
function endBallKey(st: MatchStatus): string {
  return st.endBall ? `${st.endBall.grantSeq}#${st.endBall.ball}#${st.panel?.game ?? 1}#${st.lobby?.match?.id ?? ''}` : '';
}

/** A13: the turn Pass the turn was asked about (who and which ball), so a confirmation never lands on a later turn. */
/** A17 step 7 (design 11.3, 11.9): what a member's row says beyond their name: PLAY or WATCH, the starter, and what is wrong. */
function memberWords(st: MatchStatus, id: string, now: number): string {
  const m = st.lobby?.members.find((x) => x.id === id);
  if (!m) return '';
  // Design 11.9: "Dana · PC · PLAY · AWAY 0:42": for how long, as this PC has known it.
  const gone = m.awaySince === null ? null : Math.max(0, Math.floor((now - m.awaySince) / 1000));
  const flag: Record<(typeof m.flags)[number], string> = {
    away: gone === null ? 'AWAY' : `AWAY ${Math.floor(gone / 60)}:${String(gone % 60).padStart(2, '0')}`,
    loading: 'LOADING',
    no_table: 'NO TABLE',
    other_table: 'OTHER TABLE',
    own_game: 'OWN GAME',
  };
  return ` · ${m.stance === 'play' ? 'PLAY' : 'WATCH'}${m.starter && st.phase !== 'playing' && st.phase !== 'paused' ? ' · starts from the table' : ''}${m.flags.map((f) => ` · ${flag[f]}`).join('')}`;
}

/**
 * Design 11.8a: "waiting up to 20 minutes (18:12 left)". The panel's own line counts in minutes (it is drawn in the
 * headset too, and is not drawn again every second for twenty minutes); this tab counts the seconds itself.
 */
function awayClock(st: MatchStatus, message: string, now: number): string {
  const until = st.lobby?.hostAway?.until ?? null;
  if (until === null) return message;
  const left = Math.max(0, Math.floor((until - now) / 1000));
  return message.replace(/\(\d+ min left\)/, `(${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} left)`);
}

/** "Krobs' ball", "Dana's ball" (as `possessive` in the main process words it). */
function possessive(name: string): string {
  return `${name}${/s$/i.test(name) ? "'" : "'s"}`;
}

function listOf(names: string[]): string {
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * A player of the open match who is out of the game that is being played: they gave it up, were counted out, or have
 * played all their balls. Their table is locked as a watcher's is, and nothing on this tab says their ball comes up.
 */
function playsNoMore(st: MatchStatus): boolean {
  const l = st.lobby;
  if (!l?.match || l.match.state !== 'game' || !l.match.players.includes(st.localId ?? '')) return false;
  return !l.giveUp;
}

function passTurnKey(st: MatchStatus): string {
  return st.pass ? `${st.pass.name}#${st.pass.ball}#${st.panel?.game ?? 1}#${st.lobby?.match?.id ?? ''}` : '';
}

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

/** D8.10: a shortcut in the words of a keyboard ("Ctrl+Alt+M"). */
function keyWords(acc: string): string {
  return acc.replace(/\bControl\b/g, 'Ctrl');
}

/**
 * D8.10: the key press as an Electron accelerator, or null for a modifier alone or a key the menu does not take (main
 * checks it again: `cleanShortcut`). The numeric pad goes by its position (`code`), everything else by the key.
 */
function acceleratorOf(e: { key: string; code: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }): string | null {
  const named: Record<string, string> = { ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert', Delete: 'Delete', Backspace: 'Backspace' };
  const pad: Record<string, string> = { NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummult', NumpadDivide: 'numdiv', NumpadDecimal: 'numdec' };
  let key: string | null;
  if (/^Numpad\d$/.test(e.code)) key = `num${e.code.slice(-1)}`;
  else if (pad[e.code]) key = pad[e.code]!;
  else if (/^F\d{1,2}$/.test(e.key)) key = e.key;
  else if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(-1);
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(-1);
  else key = named[e.key] ?? null;
  if (key === null) return null;
  return [e.ctrlKey ? 'Control' : null, e.altKey ? 'Alt' : null, e.shiftKey ? 'Shift' : null, key].filter((x) => x !== null).join('+');
}
