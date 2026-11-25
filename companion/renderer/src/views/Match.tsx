import { useEffect, useState, type KeyboardEvent } from 'react';
import { Field, Note, Skeleton } from '../parts/Bits.js';
import { Button } from '../parts/Button.js';
import { Panel, PanelGroup } from '../parts/Panel.js';
import { describe, type CastcadeState } from '../useCastcade.js';
import { inviteFromText } from '../invite-text.js';
import { LobbyTable, OneStepCard, TablePicker, useOneStep } from './OneStep.js';
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
/** In a lobby's row, where the words stand in one line (design 11.9). */
const RIG_SHORT: Record<MatchStatus['participants'][number]['rig'], string> = { pc: 'PC', vr_headset: 'VR', real_cabinet: 'cabinet' };

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
    // A17 step 9 (the earlier second reader): a question about a player is also about the game it was asked in, as
    // the other questions are (`about`: the lobby's `gameKey`): a new game takes it away.
    | { what: 'playOn'; player: string; about: string }
    | { what: 'awayEnd'; player: string; about: string }
    | { what: 'awayPlayOn'; player: string; about: string }
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
  /*
   * The panel's line, as this tab shows it under its headline, or null where the tab does not. A17 step 9: a start
   * that is announced says its own line beside its buttons (below): the same sentence is not said twice. A line that
   * sends the reader to this tab (the headset's "see the Match tab") is not shown on it: what it points at is at the
   * top. Nor is this PC's own table change, which the card at the top of the tab says, with its Open it (on the panel
   * an offer's Open it says that it is on this tab: controller.ts `offerOnPanel`). The step 9 last pass: nor
   * "Castcade found no copy of the lobby's table" under the card at the top that says it, with what to do. (Under the
   * headline WAITING FOR CHUCK the line is where the game waits and the way on: controller.ts, not the same words.)
   */
  const message = panel?.message ?? null;
  const shownMessage =
    message !== null &&
    !st.advisories.some((line) => message.includes(line)) &&
    !(st.lobby?.start && message === st.lobby.start.line) &&
    !message.endsWith('see the Match tab') &&
    message.replaceAll(' on the Match tab', '') !== one?.change?.detail &&
    !(one?.launch.state === 'needed' && message.startsWith('Castcade found no copy'))
      ? message
      : null;
  // The step 9 last pass: the line beside Start match says the start waits for tables that are not open yet; where the
  // line above it says so already (with whose), it is not said twice.
  const startLine = st.lobby ? (shownMessage?.includes('A start waits for') ? st.lobby.startButton.line.replace(/ A start waits for the tables? that (is|are) not open yet\.$/, '') : st.lobby.startButton.line) : '';
  // The Arcaid-look pass (2026-11-25): beside this tab's own Start match (or Next game) button, the panel's way to the
  // same press in the menu ("To start it yourself: Start match in the menu", the starter's "(or Start match in the
  // menu)") is not said: the menu and the headset keep it.
  const tabMessage =
    shownMessage !== null && st.lobby && !st.lobby.start
      ? shownMessage.replace(/\. To start it yourself: (?:Start match|Next game) in the menu/, '').replace(/ \(or (?:Start match|Next game) in the menu\)/, '')
      : shownMessage;
  // The row of the game's own presses, drawn only when it holds one (it stood empty, a band of space, in a lobby).
  const hasControls =
    (st.role === 'host' && st.phase === 'paused' && !st.transfer && st.canResume) ||
    (st.role === 'host' && (st.phase === 'playing' || st.phase === 'paused') && !!st.pass) ||
    (st.phase === 'playing' && !!st.endBall) ||
    !!st.lobby?.giveUp ||
    st.lobby?.end === 'match' ||
    st.lobby?.end === 'everyone';

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
    patch: Partial<Pick<MatchSettings, 'theaterDuringMyTurn' | 'spectate' | 'previewStereo' | 'theaterScale' | 'cameraSource' | 'tableMuteMine' | 'tableSendMine' | 'tableHearOthers' | 'preMatchPlay' | 'startTableOnHost' | 'scoreboard' | 'scoreboardCorner' | 'scoreboardAnchor' | 'watch3d' | 'changeTablesForMe'>>,
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

  // A17 step 9: who is here. In a lobby with no match open a row is a person and their words; the columns for balls
  // and score come with a match (they stood there empty before one, and squeezed the names onto two lines).
  const scored = !st.lobby || st.lobby.match !== null;
  const roster = (
    <table className="cc-table cc-roster">
      {scored && (
        <thead>
          <tr>
            <th>{st.lobby ? 'In the lobby' : 'Player'}</th>
            {!st.lobby && <th>Rig</th>}
            <th>Balls</th>
            <th className="num">Score</th>
          </tr>
        </thead>
      )}
      <tbody>
        {st.participants.map((p) => {
          const row = panel?.players.find((x) => x.id === p.id);
          const words = memberWords(st, p.id, now);
          return (
            <tr key={p.id} className={row?.isUp ? 'up' : ''}>
              <td>
                <span className="cc-who">{p.name}</span>
                {p.id === st.localId ? ' (you)' : ''}
                {/* A17 step 9: in a lobby, who opened it is said in the lobby's first line: the row keeps to one line. */}
                {!st.lobby && p.id === st.hostId ? ' · host' : ''}
                {words.text}
                {words.flags.map((f) => (
                  <span key={f} className="cc-flag">
                    {' '}
                    · {f}
                  </span>
                ))}
                {p.tableMatch === false && <span className="cc-flag"> · {p.tableNote ?? 'different table file'}</span>}
                {p.buildMatch === false && <span className="cc-quiet"> · different VPX build</span>}
                {p.ballEnds === false && <span className="cc-flag"> · cannot report ball ends</span>}
                {/* In a lobby the row says AWAY, with the time (memberWords): not a second word for the same thing. */}
                {!st.lobby && row?.flags.includes('disconnected') && <span className="cc-flag"> · disconnected</span>}
                {row?.flags.includes('midnight') && <span className="cc-flag"> · Midnight Madness ran</span>}
              </td>
              {!st.lobby && <td>{RIG_LABEL[p.rig]}</td>}
              {/* Balls and score are a player's of the game on the panel: a member who only watches has neither. */}
              {scored && <td>{st.lobby && !row ? '' : `${row?.ballsDone ?? 0}/${panel?.ballsPerGame || '—'}`}</td>}
              {scored && <td className="num">{row?.score === null || row?.score === undefined ? (st.lobby && !row ? '' : '—') : row.score.toLocaleString()}</td>}
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
                  <span className="cc-who">{x.name}</span>
                  <span className="cc-quiet"> · left the lobby</span>
                </td>
                <td>
                  {x.ballsDone}/{panel?.ballsPerGame || '—'}
                </td>
                <td className="num">{x.score === null || x.score === undefined ? '—' : x.score.toLocaleString()}</td>
              </tr>
            ))}
      </tbody>
    </table>
  );

  /** A question's two answers: the press it asks about, and Cancel. `danger`: the press removes or cannot be undone. */
  const answer = (label: string, act: () => void, danger = false) => (
    <div className="cc-row">
      <Button size="sm" variant={danger ? 'danger' : 'primary'} disabled={busy} onClick={act}>
        {label}
      </Button>
      <Button size="sm" variant="secondary" disabled={busy} onClick={() => setConfirming(null)}>
        Cancel
      </Button>
    </div>
  );

  // The lobby's panel: what the lobby is (its code, how to bring somebody in, who is here, its table).
  const lobbyPanel = st.lobby && (
    <Panel wide title={`Lobby ${st.code ?? ''}`.trim()}>
      <p className="cc-help">
        {st.lobby.members.length} of 4 here · opened by {st.hostId === st.localId ? 'you' : nameOf(st, st.hostId)}
        {st.path ? ` · ${st.path}` : ''}
      </p>
      <LobbyInvite bridge={bridge} st={st} one={one} />
      {roster}
      {/* A17 step 10: the lobby's table, and its change by anyone. */}
      <LobbyTable bridge={bridge} st={st} tableOpen={tableOpen} />
    </Panel>
  );

  return (
    <>
      <PanelGroup id="match" title="Match">
        {/* A17 step 9 (2026-11-27): what went wrong is said first, in the same place in every state (it stood below the
            lobby, a screen further down, where nobody looked for it). */}
        {/* The final review (finding 9): a lobby that is open again as it was is good news, and was drawn in the error
            colour like everything that comes this way: said in the colour of what it is. */}
        {shownError && (
          <div className="cc-panel--wide">
            <Note state={NOTE_STATE[error === null && noticeKind(shownError) !== 'error' ? noticeKind(shownError) : 'error']} role={error !== null || noticeKind(shownError) === 'error' ? 'alert' : 'status'}>
              {shownError}
            </Note>
          </div>
        )}

        {/* A14: a link that waits for a click, the join link while hosting, and what the table start is doing. */}
        <OneStepCard bridge={bridge} one={one} role={st.role} phase={st.phase} lobby={st.lobby !== null} />

        {/* A15: Castcade closed in a lobby that is still worth going back to. A17 step 8 (2026-11-26): for everybody, with
            a match open or none. A member goes back into the lobby and, when the match is still open, into the match
            where it is now. The lobby's PC opens the same lobby again, with its match where it stood. Only when its
            record did not read in full is the lobby opened again empty, and a match that was open lost: the card says
            so before the button is pressed. */}
        {!inMatch && st.phase !== 'connecting' && st.resume && (
          <Panel wide attention title={`You were in a lobby${st.resume.names.length > 0 ? ` with ${listOf(st.resume.names.map((n) => short(n)))}` : ''}`}>
            <p className="cc-text">
              Castcade closed in the lobby {st.resume.code}
              {st.resume.match ? ' during a match' : ''}.{' '}
              {st.resume.role === 'host'
                ? st.resume.lost
                  ? `What Castcade saved of the lobby did not read in full: opening it again gives an empty lobby under the same code. The others come back as newcomers, if they are still waiting${st.resume.match ? ', and the match that was being played is lost' : ''}.`
                  : `Open it again and it is the lobby it was${st.resume.match ? ', with the match where it stood' : ''}: the others come back into it by themselves, if they are still waiting (they wait 20 minutes).`
                : `Rejoin and you are back in the lobby${st.resume.match ? ', and in the match where it is now if it is still open' : ''}. Your microphone goes on again for the others.`}
            </p>
            <div className="cc-row">
              <Button disabled={busy} onClick={() => void run(() => bridge.match.rejoin())}>
                {st.resume.role === 'host' ? 'Open it again' : 'Rejoin the lobby'}
              </Button>
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => void run(() => bridge.match.forgetResume())}>
                Forget it
              </Button>
            </div>
          </Panel>
        )}

        {!inMatch && st.phase !== 'connecting' && (
          <>
            <p className="cc-text cc-quiet cc-panel--wide">
              A lobby is joined once an evening: everyone in it can talk, play or watch, and you play as many matches as you like without leaving. A match is two to
              four players on the same table, one ball each in turn. Pick a table and press Open lobby: Castcade copies an invite link for the others. Send it, then
              press Start the table. Any order works: a table opened before or after is picked up.{tableOpen ? ` Open now: ${tableOpen}.` : ''}
            </p>
            <Panel wide title={<label htmlFor="match-name">Your name</label>}>
              <input id="match-name" type="text" className="cc-input" maxLength={64} value={displayName} onChange={(e) => setName(e.target.value)} />
            </Panel>

            {watchHoldsRoom(watch3d) && <p className="cc-help cc-panel--wide">Leave the 3D watch session below to open or join a lobby.</p>}
            {!watchHoldsRoom(watch3d) && (
              <>
                {/* A17 step 9 (2026-11-27): Join stands before Open. Open is the long card (the picker, the port, what it
                    does), and Join stood a screen below it, out of sight in the window as it opens. */}
                <Panel title="Join a lobby">
                  <fieldset disabled={busy}>
                    <Field label="Code or link" htmlFor="match-invite" help="Your microphone is on for the people in the lobby from the moment you join.">
                      <input id="match-invite" type="text" className="cc-input" value={invite} placeholder="The join link, or the code JHDFEF" onChange={(e) => setInvite(e.target.value)} />
                    </Field>
                    <div className="cc-row">
                      <Button
                        variant="secondary"
                        onClick={() =>
                          void bridge.app.clipboardText().then((t) => {
                            // The final review (finding 5): everything the invite's Copy buttons give (invite-text.ts).
                            const v = inviteFromText(t);
                            if (v !== null) {
                              setError(null);
                              setInvite(v);
                            } else setError('The clipboard does not hold a Castcade invite: the six-letter code, the join link, or the chat line with the link in it.');
                          }, (e: unknown) => setError(describe(e)))
                        }
                      >
                        Paste
                      </Button>
                      <Button disabled={!invite.trim()} onClick={() => void run(() => bridge.match.join(invite, displayName))}>
                        Join
                      </Button>
                    </div>
                  </fieldset>
                </Panel>

                <Panel title="Open a lobby">
                  <fieldset disabled={busy}>
                    <Field label="Balls per game" htmlFor="match-balls">
                      <select id="match-balls" className="cc-input cc-input--number" value={ballsPerGame} onChange={(e) => setBalls(e.target.value === '5' ? 5 : 3)}>
                        <option value={3}>3</option>
                        <option value={5}>5</option>
                      </select>
                    </Field>
                    {/* A17 step 7 (2026-11-25): A12's "Before the match" choice is not offered any more. In a lobby every
                        table is its owner's until a start counts down, and a game that runs on one is waited for; the
                        `preMatchPlay` key stays in match.json and is read by nothing in a lobby. */}
                    <TablePicker bridge={bridge} value={tablePath} onChange={setTablePath} tableOpen={tableOpen} startOnHost={st.settings.startTableOnHost} />
                    {/* A14.7 (2026-11-15): off, Open lobby gives the invite first and the table starts from its own button. */}
                    <div className="cc-field">
                      <label className="cc-check">
                        <input type="checkbox" checked={st.settings.startTableOnHost} onChange={(e) => setView({ startTableOnHost: e.target.checked })} />
                        <span>Start the table as soon as I open the lobby</span>
                      </label>
                      <small className="cc-help cc-check__help">Off: Open lobby shows the invite first, so you can send it before VPX starts. Then press Start the table.</small>
                    </div>
                    {/* A17 (2026-11-24): the voice is connected at the join, not at the match's start: said before the press. */}
                    <p className="cc-help">
                      You get a code to send. Everyone who joins can talk, play or watch. Play as many matches as you like without leaving. Your microphone is on for the
                      others from the moment you open it.
                    </p>
                    {/* The final review (finding 9): the port was the first field of this card, with no word on when it matters. */}
                    <details className="cc-more">
                      <summary>Advanced: the TCP port</summary>
                      <Field
                        label="TCP port"
                        htmlFor="match-port"
                        help="Only for a lobby that is reached at this PC's address: a PC that is not paired with ArcAid, or players on your home network. A PC paired with ArcAid needs nothing set here."
                      >
                        <input id="match-port" type="text" inputMode="numeric" className="cc-input cc-input--number" value={portText} onChange={(e) => setPort(e.target.value)} />
                      </Field>
                    </details>
                    <div className="cc-row">
                      <Button
                        onClick={() =>
                          void run(() => bridge.launch.host({ tablePath: tableOpen ? null : tablePath, startTable: st.settings.startTableOnHost, port: Number(portText), ballsPerGame, displayName }))
                        }
                      >
                        Open lobby
                      </Button>
                    </div>
                  </fieldset>
                </Panel>
              </>
            )}

            {/* I11.4.1: the 3D watch session, apart from any match. */}
            <WatchCard bridge={bridge} st={watch3d} />
          </>
        )}

        {st.phase === 'connecting' && (
          <Panel wide>
            <div className="cc-stack" aria-busy="true">
              <p className="cc-text">Connecting to the lobby…</p>
              {/* Loading: the lobby's first lines, in their shape. */}
              <Skeleton width="45%" />
              <Skeleton width="80%" />
              <Skeleton width="65%" />
            </div>
          </Panel>
        )}

        {inMatch && (
          <>
            {/* The invite of a match with no lobby. A lobby's invite is in the lobby's own card, on every member's tab (step 9). */}
            {!st.lobby && st.role === 'host' && st.invite && (
              <Panel wide title="Invite">
                <div className="cc-field__line">
                  <code className="cc-mono cc-grow">{st.invite}</code>
                  <Button size="sm" variant="secondary" onClick={copyInvite}>
                    {copied ? 'Copied' : st.via === 'relay' ? 'Copy code' : 'Copy'}
                  </Button>
                </div>
                {st.via === 'relay' ? (
                  <>
                    <p className="cc-text">Send the code to the others. The lobby goes through ArcAid: nothing to set up on your router. Each person needs Castcade paired with ArcAid.</p>
                    {/* The review of PR 136: this PC's own connection to ArcAid is away: said here, on the tab of the PC it is about. */}
                    {st.relayNote && <Note state="attention">{st.relayNote}.</Note>}
                    {st.directInvite && (
                      <p className="cc-help">
                        For a player on your home network or one who is not paired (needs TCP {st.port} forwarded for players outside): <code className="cc-mono">{st.directInvite}</code>
                      </p>
                    )}
                  </>
                ) : (
                  <>
                    {st.portMapping ? (
                      st.portMapping.state === 'failed' ? <Note state="attention">{st.portMapping.line}</Note> : <p className="cc-help">{st.portMapping.line}</p>
                    ) : (
                      <p className="cc-text">Forward TCP {st.port} to this PC on your router, then send the invite to the others.</p>
                    )}
                    {st.relayNote && <p className="cc-help">{st.relayNote}: a PC paired with ArcAid needs no port forward.</p>}
                    {st.ipSource === 'lan' && <Note state="attention">Castcade could not look up your public address, so this is your home-network address. For a player outside your network, replace it with your public IP.</Note>}
                  </>
                )}
              </Panel>
            )}

            {/* The Arcaid-look pass (2026-11-25): one order on this tab, the same in every state: what is happening now and
                what this person can do now, then what the lobby is (its code, how to bring somebody in, who is here, its
                table), then everything else. A17 step 9 put the lobby first; at the window's opening size that put the
                headline and its buttons below the fold (the away question on the lobby's PC, a member's turn). */}
            <Panel wide attention={panel?.myTurn === true} className="cc-now">
              <p className={panel?.myTurn ? 'cc-headline cc-headline--mine' : 'cc-headline'}>{turnLine(st)}</p>
              {st.transfer && <Note state="attention">{transferLine(st.transfer)}</Note>}
              {/* D10.8: which path the match control takes (a lobby says it in its own line). */}
              {!st.lobby && st.path && <p className="cc-help">{st.path}</p>}
              {/* The panel's line, where this tab shows it (`shownMessage`; beside the tab's Start, without the menu's way to it). */}
              {tabMessage !== null &&
                (tabMessage.startsWith('different') || tabMessage.includes('cannot report ball ends') || tabMessage.startsWith('The lobby is closed') || tabMessage.startsWith('The lobby is over') || st.lobby?.hostAway ? (
                  <Note state="attention">{awayClock(st, tabMessage, now)}</Note>
                ) : (
                  <p className="cc-text cc-quiet">{awayClock(st, tabMessage, now)}</p>
                ))}
              {/* B26: the Midnight Madness setting when it is ON on a table, and the balls of this game it ran on (a flag only). */}
              {st.advisories.map((line) => (
                <Note key={line} state="attention">
                  {line}
                </Note>
              ))}
              {!st.lobby && roster}
              {/* A17 step 7: the start, asked for by anyone: what a press does, the start that is announced, and how to take it back. */}
              {st.lobby && !st.lobby.over && (st.phase === 'lobby' || st.phase === 'over') && (
                <>
                  {st.lobby.start ? (
                    <div className="cc-line">
                      <span className="cc-text">
                        {st.lobby.start.line}
                        {st.lobby.start.seconds !== null && st.lobby.start.seconds > 0 ? ` · ${st.lobby.start.seconds}` : ''}
                      </span>
                      <span className="cc-row">
                        {st.lobby.startWithout && (
                          <Button size="sm" variant="secondary" disabled={busy || st.lobby.hostAway !== null} title={st.lobby.hostAway ? "The lobby's PC is away: this waits until it is back" : undefined} onClick={() => void run(() => bridge.match.start({ now: true, without: st.lobby?.startWithout ?? null }))}>
                            {st.lobby.startWithout}
                          </Button>
                        )}
                        <Button size="sm" variant="secondary" disabled={busy || st.lobby.hostAway !== null} title={st.lobby.hostAway ? "The lobby's PC is away: this waits until it is back" : undefined} onClick={() => void run(() => bridge.match.cancelStart())}>
                          Cancel the start
                        </Button>
                      </span>
                    </div>
                  ) : (
                    <div className="cc-row">
                      <Button
                        disabled={busy || st.lobby.startButton.off !== null || (confirming?.what === 'start' && st.startWarnings.length > 0)}
                        title={st.lobby.startButton.off ?? 'Or, for the starter, a game started on their own table'}
                        onClick={() => (st.startWarnings.length > 0 ? setConfirming({ what: 'start' }) : void run(() => bridge.match.start()))}
                      >
                        {st.lobby.startButton.label}
                      </Button>
                      <span className="cc-help">{st.lobby.startButton.off ?? startLine}</span>
                    </div>
                  )}
                  {/* The final review (finding 9): what Start a new match does stands beside it before the press (it was said only in the question after it). */}
                  {!st.lobby.start && st.lobby.newMatch && !(confirming?.what === 'newMatch' && confirming.about === st.lobby.gameKey) && (
                    <div className="cc-line">
                      <span className="cc-help">{st.lobby.newMatch.line}</span>
                      <span className="cc-row">
                        <Button size="sm" variant="secondary" disabled={busy} onClick={() => setConfirming({ what: 'newMatch', about: st.lobby?.gameKey ?? '' })}>
                          Start a new match
                        </Button>
                      </span>
                    </div>
                  )}
                </>
              )}
              {st.lobby && !st.lobby.over && (st.phase === 'lobby' || st.phase === 'over') && st.lobby.starter === st.localId && !st.lobby.start && st.lobby.startButton.off === null && !one?.change && (
                <small className="cc-help">Starting a game on your table asks for the start too (it counts down 5 s in every headset).</small>
              )}
              {st.lobby?.newMatch && confirming?.what === 'newMatch' && confirming.about === st.lobby.gameKey && (
                <div className="cc-ask">
                  <p>
                    {st.lobby.newMatch.line}
                    {/* The review of PR 136: a table of the new match's players that cannot report ball ends is said here, and this press starts anyway. */}
                    {st.lobby.newMatch.warnings.length > 0
                      ? ` ${st.lobby.newMatch.warnings.join(' · ')}. Such a turn never ends by itself: that player ends each of those balls with End my ball, or the lobby's PC ends it with Pass the turn.`
                      : ''}
                  </p>
                  {answer(st.lobby.newMatch.warnings.length > 0 ? 'Start a new match anyway' : 'Start a new match', () => {
                    const anyway = (st.lobby?.newMatch?.warnings.length ?? 0) > 0;
                    setConfirming(null);
                    void run(() => bridge.match.start({ newMatch: true, anyway }));
                  })}
                </div>
              )}
              {/* A17 step 7 (design 11.8): the lobby's PC, about a player the game waits for at their own turn. */}
              {st.lobby?.awayQuestion ? (
                <div className="cc-ask">
                  <p>
                    {short(st.lobby.awayQuestion.name)} has been out of the lobby&apos;s reach for {Math.max(1, st.lobby.awayQuestion.minutes)} minute{st.lobby.awayQuestion.minutes > 1 ? 's' : ''} and is still playing.
                  </p>
                  <div className="cc-row">
                    <Button size="sm" disabled={busy} onClick={() => void run(() => bridge.match.answerAway('wait', { player: st.lobby?.awayQuestion?.player ?? null }))}>
                      Keep waiting
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy || (confirming?.what === 'awayEnd' && confirming.player === st.lobby.awayQuestion.player && confirming.about === st.lobby.gameKey)}
                      title={`Their ball ends at ${st.lobby.awayQuestion.score.toLocaleString()} and the turn passes`}
                      onClick={() => setConfirming({ what: 'awayEnd', player: st.lobby?.awayQuestion?.player ?? '', about: st.lobby?.gameKey ?? '' })}
                    >
                      End {possessive(short(st.lobby.awayQuestion.name))} ball
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy || (confirming?.what === 'awayPlayOn' && confirming.player === st.lobby.awayQuestion.player && confirming.about === st.lobby.gameKey)}
                      onClick={() => setConfirming({ what: 'awayPlayOn', player: st.lobby?.awayQuestion?.player ?? '', about: st.lobby?.gameKey ?? '' })}
                    >
                      Play on without {short(st.lobby.awayQuestion.name)}
                    </Button>
                  </div>
                </div>
              ) : (
                st.lobby?.waitedFor && (
                  <div className="cc-line">
                    <span className="cc-help">{panel?.message?.includes(short(st.lobby.waitedFor.name)) ? '' : `Waiting for ${short(st.lobby.waitedFor.name)} to come back.`}</span>
                    <span className="cc-row">
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busy || (confirming?.what === 'playOn' && confirming.player === st.lobby.waitedFor.player && confirming.about === st.lobby.gameKey)}
                        onClick={() => setConfirming({ what: 'playOn', player: st.lobby?.waitedFor?.player ?? '', about: st.lobby?.gameKey ?? '' })}
                      >
                        Play on without {short(st.lobby.waitedFor.name)}
                      </Button>
                    </span>
                  </div>
                )
              )}
              {/* The review of PR 136: as the in-game menu asks a second choose for them. Each row is about one player, and is gone when the game no longer waits for that player. */}
              {confirming?.what === 'awayEnd' && st.lobby?.awayQuestion && confirming.player === st.lobby.awayQuestion.player && confirming.about === st.lobby.gameKey && (
                <div className="cc-ask">
                  <p>
                    End {possessive(short(st.lobby.awayQuestion.name))} ball at {st.lobby.awayQuestion.score.toLocaleString()}? The turn passes.
                  </p>
                  {answer(`End ${possessive(short(st.lobby.awayQuestion.name))} ball`, () => {
                    const player = confirming.player;
                    setConfirming(null);
                    void run(() => bridge.match.answerAway('end_ball', { player }));
                  })}
                </div>
              )}
              {confirming?.what === 'awayPlayOn' && st.lobby?.awayQuestion && confirming.player === st.lobby.awayQuestion.player && confirming.about === st.lobby.gameKey && (
                <div className="cc-ask">
                  <p>Play on without {short(st.lobby.awayQuestion.name)}? They are out of this game; they stay in the lobby.</p>
                  {answer(`Play on without ${short(st.lobby.awayQuestion.name)}`, () => {
                    const player = confirming.player;
                    setConfirming(null);
                    void run(() => bridge.match.answerAway('play_on', { player }));
                  })}
                </div>
              )}
              {confirming?.what === 'playOn' && st.lobby?.waitedFor && !st.lobby.awayQuestion && confirming.player === st.lobby.waitedFor.player && confirming.about === st.lobby.gameKey && (
                <div className="cc-ask">
                  <p>Play on without {short(st.lobby.waitedFor.name)}? They are out of this game; they stay in the lobby.</p>
                  {answer(`Play on without ${short(st.lobby.waitedFor.name)}`, () => {
                    const player = confirming.player;
                    setConfirming(null);
                    void run(() => bridge.match.playOnWithout({ player }));
                  })}
                </div>
              )}
              {hasControls && (
                <div className="cc-row">
                  {/* The final review (finding 3): only a pause that a press ends. While the game waits for a member who is away,
                      Resume did nothing, or took the turn of the player who is up: what helps then is on the row above. */}
                  {st.role === 'host' && st.phase === 'paused' && !st.transfer && st.canResume && (
                    <Button size="sm" disabled={busy} onClick={() => void run(() => bridge.match.resume())}>
                      Resume
                    </Button>
                  )}
                  {st.role === 'host' && (st.phase === 'playing' || st.phase === 'paused') && st.pass && (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy || (confirming?.what === 'pass' && confirming.turn === passTurnKey(st))}
                      title="End the ball of the player who is up at their last known score and give the next player the turn"
                      onClick={() => setConfirming({ what: 'pass', turn: passTurnKey(st) })}
                    >
                      Pass the turn
                    </Button>
                  )}
                  {/* A17 step 4 (2026-11-24): the player who is up ends their own ball by hand (an unreadable table, a stuck ball). */}
                  {st.phase === 'playing' && st.endBall && (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy || (confirming?.what === 'endBall' && confirming.turn === endBallKey(st))}
                      title="End your own ball now at the score as it stands; the turn passes to the next player"
                      onClick={() => setConfirming({ what: 'endBall', turn: endBallKey(st) })}
                    >
                      End my ball
                    </Button>
                  )}
                  {/* A17 step 7: a player gives up their own game; End match between games (anyone), or for everyone (the lobby's PC). */}
                  {st.lobby?.giveUp && (
                    <Button size="sm" variant="secondary" disabled={busy || (confirming?.what === 'giveUp' && confirming.about === st.lobby.gameKey)} onClick={() => setConfirming({ what: 'giveUp', about: st.lobby?.gameKey ?? '' })}>
                      Give up this game
                    </Button>
                  )}
                  {/* The review of PR 136: End match is the request "between games" and says which match it was pressed for:
                      pressed as a countdown runs out, it is refused; it never ends the game that has just begun. */}
                  {st.lobby?.end === 'match' && (
                    <Button size="sm" variant="secondary" disabled={busy} onClick={() => void run(() => bridge.match.endMatch({ everyone: false, about: st.lobby?.gameKey ?? null }))}>
                      End match
                    </Button>
                  )}
                  {st.lobby?.end === 'everyone' && (
                    <Button size="sm" variant="secondary" disabled={busy || (confirming?.what === 'endEveryone' && confirming.about === st.lobby.gameKey)} onClick={() => setConfirming({ what: 'endEveryone', about: st.lobby?.gameKey ?? '' })}>
                      End match for everyone
                    </Button>
                  )}
                </div>
              )}
              {confirming?.what === 'giveUp' && st.lobby?.giveUp && confirming.about === st.lobby.gameKey && (
                <div className="cc-ask">
                  <p>Give up this game? The others play on; you stay in the lobby and watch.</p>
                  {answer(
                    'Give up this game',
                    () => {
                      const about = confirming.about;
                      setConfirming(null);
                      void run(() => bridge.match.giveUp({ about }));
                    },
                    true,
                  )}
                </div>
              )}
              {confirming?.what === 'endEveryone' && st.lobby?.end === 'everyone' && confirming.about === st.lobby.gameKey && (
                <div className="cc-ask">
                  <p>End the match for everyone? The game being played gets no result.</p>
                  {answer(
                    'End match for everyone',
                    () => {
                      const about = confirming.about;
                      setConfirming(null);
                      void run(() => bridge.match.endMatch({ everyone: true, about }));
                    },
                    true,
                  )}
                </div>
              )}
              {(st.phase === 'lobby' || st.phase === 'over') && confirming?.what === 'start' && st.startWarnings.length > 0 && (
                <div className="cc-ask">
                  <p>
                    {st.startWarnings.join(' · ')}. Such a turn never ends by itself: that player ends each of those balls with End my ball (the in-game menu or this tab), or the lobby&apos;s PC ends it with Pass the turn.
                  </p>
                  {answer('Start anyway', () => {
                    setConfirming(null);
                    void run(() => bridge.match.start({ anyway: true }));
                  })}
                </div>
              )}
              {st.role === 'host' && confirming?.what === 'pass' && confirming.turn === passTurnKey(st) && st.pass && (st.phase === 'playing' || st.phase === 'paused') && (
                <div className="cc-ask">
                  <p>
                    End {possessive(short(st.pass.name))} ball {st.pass.ball} at {st.pass.score.toLocaleString()} and give the next player the turn? The match log records it as passed by the lobby&apos;s PC.
                  </p>
                  {answer('Pass the turn', () => {
                    setConfirming(null);
                    void run(() => bridge.match.passTurn());
                  })}
                </div>
              )}
              {confirming?.what === 'endBall' && confirming.turn === endBallKey(st) && st.endBall && st.phase === 'playing' && (
                <div className="cc-ask">
                  <p>
                    End your ball now at {st.endBall.score.toLocaleString()}? The turn passes.
                    {st.endBall.tableBall ? ' The ball on your table is not lost: you play it out first at your next turn, then your next ball.' : ''}
                  </p>
                  {answer('End my ball', () => {
                    // The grant the question was about: the main process ends no other ball with it.
                    const asked = st.endBall?.grantSeq ?? -1;
                    setConfirming(null);
                    void run(() => bridge.match.endMyBall(asked));
                  })}
                </div>
              )}
              {st.phase === 'playing' && st.locked && (
                <small className="cc-help">
                  {st.lobby && (!st.lobby.match?.players.includes(st.localId ?? '') || playsNoMore(st)) ? 'Your table is locked while this game is played: you are watching.' : 'Your table is locked until your ball comes up.'}
                </small>
              )}
              {st.phase === 'over' && !st.series?.over && st.locked && <small className="cc-help">Your table is locked until the next game reaches your ball.</small>}
              {/* The final review (finding 9): what End match does, in sight (it was a tooltip; the one press of that row with no question). */}
              {st.lobby?.end === 'match' && <small className="cc-help">End match closes the tally. Everyone stays in the lobby.</small>}
              {/* A17 step 7: this person's own choice for the next start. Step 9: the two stand side by side and do not move; the one that holds is the lit one. */}
              {st.lobby && !st.lobby.over && (
                <div className="cc-line">
                  <span className="cc-text">In the next match I</span>
                  <span className="cc-row">
                    <Button size="sm" variant="secondary" aria-pressed={st.lobby.stance === 'play'} disabled={busy} onClick={() => void run(() => bridge.match.setStance('play'))}>
                      Play
                    </Button>
                    <Button size="sm" variant="secondary" aria-pressed={st.lobby.stance === 'watch'} disabled={busy} onClick={() => void run(() => bridge.match.setStance('watch'))}>
                      Watch
                    </Button>
                  </span>
                </div>
              )}
              {st.lobby?.match && st.lobby.match.state === 'game' && st.lobby.stance === 'play' && !st.lobby.match.players.includes(st.localId ?? '') && (
                <small className="cc-help">You are watching this match. You are in when somebody starts a new match.</small>
              )}
              {st.lobby?.match && st.lobby.stance === 'watch' && st.lobby.match.players.includes(st.localId ?? '') && (
                <small className="cc-help">
                  {/* Someone who is out of the game that is being played (gave it up, or was counted out) is not told they play. */}
                  {st.lobby.match.state === 'game' && !st.lobby.giveUp && !panel?.myTurn && playsNoMore(st) ? 'You sit out from the next game.' : 'You play this match. You sit out from the next game.'}
                </small>
              )}
              {/* A17 step 9 (2026-11-27): the way out is the last line of this card in every state, and never the lit button. */}
              <div className="cc-line cc-leave">
                <span className="cc-help">{st.lobby?.over ? 'Castcade goes back to Open and Join by itself in a moment.' : st.role === 'host' && confirming?.what !== 'close' ? 'Close lobby ends it for everyone.' : ''}</span>
                <span className="cc-row">
                  {st.role === 'host' ? (
                    <Button size="sm" variant="secondary" disabled={busy || confirming?.what === 'close'} onClick={() => setConfirming({ what: 'close' })}>
                      Close lobby
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant={st.lobby?.over ? 'primary' : 'secondary'}
                      disabled={busy || (confirming?.what === 'leave' && confirming.about === (st.lobby?.gameKey ?? ''))}
                      onClick={() => {
                        // The review of PR 136: a player who leaves during their own game gives it up first (design 11.2):
                        // that is asked about, as Give up this game is. Anybody else leaves with one press.
                        if (st.lobby?.giveUp) setConfirming({ what: 'leave', about: st.lobby.gameKey });
                        else void run(() => bridge.match.leave());
                      }}
                    >
                      {/* The final review (finding 9): under LOBBY CLOSED the button says where it leads. */}
                      {st.lobby?.over ? 'Back to Open and Join' : 'Leave lobby'}
                    </Button>
                  )}
                </span>
              </div>
              {confirming?.what === 'leave' && st.lobby?.giveUp && confirming.about === st.lobby.gameKey && (
                <div className="cc-ask">
                  <p>Leave the lobby? You give up the game you are playing, and your microphone and your place go. Coming back is a new join.</p>
                  {answer(
                    'Leave lobby',
                    () => {
                      setConfirming(null);
                      void run(() => bridge.match.leave());
                    },
                    true,
                  )}
                </div>
              )}
              {confirming?.what === 'close' && st.role === 'host' && (
                <div className="cc-ask">
                  <p>This closes the lobby for everyone.{st.phase === 'playing' || st.phase === 'paused' ? ' The game being played gets no result.' : ''}</p>
                  {answer(
                    'Close lobby',
                    () => {
                      setConfirming(null);
                      void run(() => bridge.match.leave());
                    },
                    true,
                  )}
                </div>
              )}
            </Panel>

            {lobbyPanel}

            {st.lobby?.lastMatch && !st.lobby.match && (
              <Panel title={st.lobby.lastMatch.abandoned !== null ? `Match ended · game ${st.lobby.lastMatch.abandoned} not finished` : `Match over after ${st.lobby.lastMatch.games} game${st.lobby.lastMatch.games === 1 ? '' : 's'}`}>
                {st.lobby.lastMatch.standing.length > 0 ? (
                  <table className="cc-table cc-roster">
                    <thead>
                      <tr>
                        <th>Final standing</th>
                        <th className="num">Games won</th>
                        <th className="num">Total score</th>
                      </tr>
                    </thead>
                    <tbody>
                      {st.lobby.lastMatch.standing.map((x, i) => (
                        <tr key={x.id}>
                          <td className={placeClass(i + 1)}>
                            {i + 1}. <span className="cc-who">{x.name}</span>
                          </td>
                          <td className="num">{x.wins}</td>
                          <td className={`num ${placeClass(i + 1)}`}>{x.total.toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  // The empty state: what would stand here, and why it does not.
                  <p className="cc-text cc-quiet">No game of it was finished.</p>
                )}
              </Panel>
            )}
            {panel?.result && (
              <Panel title={st.lobby ? `Game ${panel.game ?? 1}` : panel.game && panel.game > 1 ? `Game ${panel.game}` : 'Result'}>
                <table className="cc-table cc-roster">
                  <tbody>
                    {panel.result.map((r) => (
                      <tr key={r.id}>
                        <td className={placeClass(r.place)}>
                          {r.place}. <span className="cc-who">{r.name}</span>
                          {r.flags?.includes('midnight') && <span className="cc-flag"> · Midnight Madness ran</span>}
                        </td>
                        <td className={`num ${placeClass(r.place)}`}>{r.score.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <small className="cc-help">Each game also posted to ArcAid as a normal score.</small>
              </Panel>
            )}

            {panel?.series && panel.series.some((s) => s.games > 1) && (
              <Panel title="Series">
                <table className="cc-table cc-roster">
                  <thead>
                    <tr>
                      <th>Player</th>
                      <th className="num">Wins</th>
                      <th className="num">Games</th>
                      <th className="num">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {panel.series.map((s) => (
                      <tr key={s.id}>
                        <td className={placeClass(s.place)}>
                          {s.place}. <span className="cc-who">{s.name}</span>
                        </td>
                        <td className="num">{s.wins}</td>
                        <td className="num">{s.games}</td>
                        <td className={`num ${placeClass(s.place)}`}>{s.total.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Panel>
            )}
          </>
        )}
      </PanelGroup>

      {/* A17 step 9: everything else (how the voice and the picture are doing, and the settings) under one heading, below the lobby. */}
      <PanelGroup id="match-settings" tone="violet" title="Sound, picture and keys">
        {inMatch && (
          <Panel wide>
            <p className="cc-help">{mediaLine(st.media)}</p>
            {st.media?.nativeVideo && <p className="cc-help">{nativeVideoLine(st.media.nativeVideo, st.participants)}</p>}
            {st.media?.nativeVideo?.helper === 'ready' && !st.media.nativeVideo.fallback && <VideoQualityRow st={st} video={st.media.nativeVideo} apply={(r) => bridge.match.setVideoRungs(r).then(setSt, (e: unknown) => setError(describe(e)))} />}
            {/* I11.4.2: what this PC shows of each other player while they are up: 3D on its own table, or the 2D video and why. */}
            {st.stream3d?.players.map((p) => (
              <p className="cc-help" key={p.id}>
                {p.line}
              </p>
            ))}
            {panelWin && (
              <div className="cc-line">
                <p className="cc-help">{panelLine(panelWin)}</p>
                <span className="cc-row">
                  <Button size="sm" variant="secondary" onClick={togglePanel}>
                    {panelWin.visible ? 'Hide panel' : 'Show panel'}
                  </Button>
                </span>
              </div>
            )}
            <p className="cc-help" title={st.rigReason}>
              {rigLine(st)} <span className="cc-quiet">{st.rigReason}</span>
            </p>
            <p className="cc-help">{overlayLine(st.vrOverlay)}</p>
            {st.previewAdvice && <p className="cc-text">{st.previewAdvice}</p>}
          </Panel>
        )}

        <Panel title={<label htmlFor="match-mic">Microphone</label>}>
          <div className="cc-field__line">
            <select id="match-mic" className="cc-input" value={st.micDeviceId ?? ''} onChange={(e) => pickMic(e.target.value)}>
              <option value="">Windows default</option>
              {savedMicMissing && <option value={st.micDeviceId ?? ''}>The microphone you picked last time</option>}
              {st.microphones.map((m) => (
                <option key={m.deviceId} value={m.deviceId}>
                  {m.label || 'Unnamed microphone'}
                </option>
              ))}
            </select>
            <Button size="sm" variant={st.muted ? 'primary' : 'secondary'} onClick={toggleMute}>
              {st.muted ? 'Unmute' : 'Mute'}
            </Button>
          </div>
          <small className="cc-help">
            Pick your headset microphone: in VR the Windows default is often a virtual device.
            {st.microphones.length === 0 ? ' No microphone listed yet: plug one in, then open this tab again.' : ''}
          </small>
        </Panel>

        <TurnCard turn={st.turn} save={(t) => bridge.match.setTurn(t).then(setSt)} />

        <Panel title={<label htmlFor="match-video-path">Spectator video</label>}>
          <Field
            help={
              <>
                Native: the castcade-video helper encodes your eye on the GPU (H.264, up to 60 fps) and the headset draws what arrives; voice stays as it was.
                Electron: the 0.2.36 picture through the match panel. Used from the next match.
              </>
            }
          >
            <select id="match-video-path" className="cc-input" value={st.videoPath} onChange={(e) => bridge.match.setVideoPath(e.target.value === 'electron' ? 'electron' : 'native').then(setSt, () => undefined)}>
              <option value="native">Native helper (recommended)</option>
              <option value="electron">Electron (0.2.36 path)</option>
            </select>
          </Field>
        </Panel>

        <Panel wide>
          <div className="cc-fields cc-fields--settings">
            <Field label="In the headset on your ball" htmlFor="match-my-ball" help="What you see while you play your ball: just your table, or the scores panel below it.">
              <select id="match-my-ball" className="cc-input" value={st.settings.theaterDuringMyTurn} onChange={(e) => setView({ theaterDuringMyTurn: e.target.value === 'panel' ? 'panel' : 'hidden' })}>
                <option value="hidden">Nothing over your table</option>
                <option value="panel">The match panel, low in view</option>
              </select>
            </Field>
            <Field
              label="In the headset on their ball"
              htmlFor="match-their-ball"
              help="Theater: their table as a flat screen in front of you, where yours was; the view around it goes dark. Needs the Castcade OpenXR layer (not SteamVR)."
            >
              <select id="match-their-ball" className="cc-input" value={st.settings.spectate} onChange={(e) => setView({ spectate: e.target.value === 'panel' ? 'panel' : 'theater' })}>
                <option value="theater">Their table where yours was (theater)</option>
                <option value="panel">The match panel, low in view</option>
              </select>
            </Field>
            {/* I11.4.2 (ADR 0011): the player up on this PC's own table, in 3D, when both PCs can; the 2D video otherwise. */}
            <Field
              label="3D watch in a match"
              htmlFor="match-watch3d"
              help={
                <>
                  Auto: while another player is up you see their game on your own table, from your own seat, when both PCs run the Castcade VPX build
                  (VPinballX_GL64_castcade.exe beside your VPX) on the identical table file; Castcade then starts match tables in that build. Anything else, and
                  any trouble, shows the 2D video as before. Applies to tables started from now on.
                </>
              }
            >
              <select id="match-watch3d" className="cc-input" value={st.settings.watch3d} onChange={(e) => setView({ watch3d: e.target.value === 'off' ? 'off' : 'auto' })}>
                <option value="auto">Auto: their game on your own table when both PCs can</option>
                <option value="off">Off: always the 2D video</option>
              </select>
            </Field>
            {/* A17 step 3 (2026-11-25): the lobby's table changed: Castcade closes the open table and opens the new one, or only offers it. */}
            <Field
              label="When the lobby's table changes"
              htmlFor="match-change-tables"
              help={
                <>
                  Change tables for me: Castcade closes the table that is open on this PC and opens your copy of the new one. Never during a game, and never
                  when it cannot be sure that no game is on (a table that is not imported, two VPX open): then you are asked to close the table yourself. Ask me
                  first: the Match tab shows the new table with an Open it button and nothing closes by itself.
                </>
              }
            >
              <select id="match-change-tables" className="cc-input" value={st.settings.changeTablesForMe ? 'on' : 'off'} onChange={(e) => setView({ changeTablesForMe: e.target.value !== 'off' })}>
                <option value="on">Change tables for me</option>
                <option value="off">Ask me first</option>
              </select>
            </Field>
            <Field label="Theater size" htmlFor="match-theater-size" help="How big the screen is. Life size is the default; smaller puts the same picture over less of your view, so it looks sharper. Takes effect at once.">
              <select id="match-theater-size" className="cc-input" value={String(st.settings.theaterScale)} onChange={(e) => setView({ theaterScale: Number(e.target.value) })}>
                <option value="1">Life size</option>
                <option value="0.8">80 %</option>
                <option value="0.6">60 %</option>
              </select>
            </Field>
            <Field
              label="Scoreboard in the headset"
              htmlFor="match-scoreboard"
              help={
                <>
                  A small scoreboard up and to that side while you play and while you watch: scores, ball, game, and the games played and wins this session.
                  Needs the Castcade OpenXR layer (not SteamVR); after an update, restart VPX once. Takes effect at once.
                </>
              }
            >
              <select
                id="match-scoreboard"
                className="cc-input"
                value={st.settings.scoreboard ? st.settings.scoreboardCorner : 'off'}
                onChange={(e) => setView(e.target.value === 'off' ? { scoreboard: false } : { scoreboard: true, scoreboardCorner: e.target.value === 'top-left' ? 'top-left' : 'top-right' })}
              >
                <option value="top-right">Top right</option>
                <option value="top-left">Top left</option>
                <option value="off">Off</option>
              </select>
            </Field>
            {/* D8.12.3: fixed in the room (the default) or on the head, as it was before. */}
            <Field
              label="Scoreboard stays"
              htmlFor="match-scoreboard-anchor"
              help={
                <>
                  Fixed in the room: it stays where it was put when the table opened, up and to the side of where you were facing, and you turn your head to
                  read it. To move it, look where you want it and choose &quot;Put the scoreboard where I look&quot; in the in-game menu. Follows my head: it sits in the
                  corner of your view and moves with it. Takes effect at once; after an update, restart VPX once (until then it follows your head).
                </>
              }
            >
              <select
                id="match-scoreboard-anchor"
                className="cc-input"
                value={st.settings.scoreboardAnchor}
                disabled={!st.settings.scoreboard}
                onChange={(e) => setView({ scoreboardAnchor: e.target.value === 'head' ? 'head' : 'room' })}
              >
                <option value="room">Fixed in the room</option>
                <option value="head">Follows my head</option>
              </select>
            </Field>
            <Field
              label="Your preview"
              htmlFor="match-preview"
              help={
                <>
                  Only used when the camera is the screen capture: what your VR preview window shows, told to the other players. One eye is right for 2D (VPX&apos;s
                  default, Left Eye); Auto reads VPX&apos;s setting and this tab says so when it is Both Eyes.
                </>
              }
            >
              <select
                id="match-preview"
                className="cc-input"
                value={st.settings.previewStereo}
                onChange={(e) => setView({ previewStereo: e.target.value === 'mono' ? 'mono' : e.target.value === 'sbs' ? 'sbs' : 'auto' })}
              >
                <option value="auto">As VPX is set (VR preview setting)</option>
                <option value="mono">One eye</option>
                <option value="sbs">Both eyes</option>
              </select>
            </Field>
            <Field
              label="Camera"
              htmlFor="match-camera"
              help={
                <>
                  VR layer: Castcade reads the picture from VPX&apos;s headset view, no preview window needed (it needs the layer from this Castcade version in VPX:
                  restart VPX after updating; PC and SteamVR rigs fall back to the screen capture). Screen capture: VPX&apos;s preview window on your desktop (keep
                  other windows off it).
                </>
              }
            >
              <select id="match-camera" className="cc-input" value={st.settings.cameraSource} onChange={(e) => setView({ cameraSource: e.target.value === 'layer' ? 'layer' : 'screen' })}>
                <option value="layer">VR layer (the default: no preview window needed)</option>
                <option value="screen">Screen capture of the VR preview window</option>
              </select>
            </Field>
          </div>
        </Panel>

        <VrBenchCard bridge={bridge} onStatus={setSt} st={st} />

        <Panel title="Table sound">
          <label className="cc-check">
            <input type="checkbox" checked={st.settings.tableMuteMine} onChange={(e) => setView({ tableMuteMine: e.target.checked })} />
            <span>Mute my table while others play</span>
          </label>
          <label className="cc-check">
            <input type="checkbox" checked={st.settings.tableSendMine} onChange={(e) => setView({ tableSendMine: e.target.checked })} />
            <span>Send my table&apos;s sound</span>
          </label>
          <label className="cc-check">
            <input type="checkbox" checked={st.settings.tableHearOthers} onChange={(e) => setView({ tableHearOthers: e.target.checked })} />
            <span>Hear the other table</span>
          </label>
          <small className="cc-help">
            On your ball the others hear your table; on theirs you hear the player up, and your own VPX stays quiet (its backglass and PinUP too).
            {tableSoundLine(st)}
          </small>
        </Panel>

        <Panel title="Voice and table sound">
          <Field label={`Voice volume (${voice ?? st.settings.voiceVolume} %)`} htmlFor="match-voice" help="The other players' voices; above 100 % is a boost. Ctrl+Alt+Up / Down changes the voice volume while you play.">
            <input
              id="match-voice"
              type="range"
              className="cc-range"
              min={0}
              max={300}
              step={10}
              value={voice ?? st.settings.voiceVolume}
              onChange={(e) => setVoice(Number(e.target.value))}
              onMouseUp={commitLevels}
              onKeyUp={commitLevels}
              onBlur={commitLevels}
            />
          </Field>
          <Field label={`Their table sound (${theirTable ?? st.settings.othersTableVolume} %)`} htmlFor="match-their-table" help="The player up's table as you hear it, under their voice.">
            <input
              id="match-their-table"
              type="range"
              className="cc-range"
              min={0}
              max={100}
              step={10}
              value={theirTable ?? st.settings.othersTableVolume}
              onChange={(e) => setTheirTable(Number(e.target.value))}
              onMouseUp={commitLevels}
              onKeyUp={commitLevels}
              onBlur={commitLevels}
            />
          </Field>
          <Field
            label={`My table while I play (${myTable ?? st.settings.myTableWhileUp} %)`}
            htmlFor="match-my-table"
            help="Your own VPX's volume on your ball (its own volume again after it); needs the table-sound helper. Ctrl+Alt+Left / Right changes it while you play."
          >
            <input
              id="match-my-table"
              type="range"
              className="cc-range"
              min={10}
              max={100}
              step={10}
              value={myTable ?? st.settings.myTableWhileUp}
              onChange={(e) => setMyTable(Number(e.target.value))}
              onMouseUp={commitLevels}
              onKeyUp={commitLevels}
              onBlur={commitLevels}
            />
          </Field>
        </Panel>

        <Panel title="In-game menu">
          <small className="cc-help">
            While you are in a lobby, the menu key brings up a menu on the panel (in the headset too): start a match or the next game, Play or watch, the three
            volumes, the microphone, End match, Leave lobby. Press the menu key again to move down; the choose key, or the menu key twice quickly, chooses. The arrow keys work while it is open.
            To use a controller button, map it to a key first (JoyToKey), then click a box and press the button.
          </small>
          <Field label="Menu key" htmlFor="match-menu-key">
            <input id="match-menu-key" type="text" readOnly className="cc-input cc-input--key" value={keyWords(st.settings.menuKey)} onKeyDown={captureKey('menuKey')} title="Click, then press the key" />
            {keyNote?.field === 'menuKey' && <Note state="attention">{keyNote.text}</Note>}
          </Field>
          <Field label="Choose key" htmlFor="match-choose-key">
            <div className="cc-row">
              <input
                id="match-choose-key"
                type="text"
                readOnly
                className="cc-input cc-input--key"
                value={st.settings.menuChooseKey === null ? 'none' : keyWords(st.settings.menuChooseKey)}
                onKeyDown={captureKey('menuChooseKey')}
                title="Click, then press the key"
              />
              <Button
                size="sm"
                variant="secondary"
                disabled={st.settings.menuChooseKey === null}
                onClick={() => void bridge.match.setSettings({ menuChooseKey: null }).then(setSt, (e: unknown) => setError(describe(e)))}
              >
                None
              </Button>
            </div>
            {keyNote?.field === 'menuChooseKey' && <Note state="attention">{keyNote.text}</Note>}
          </Field>
          {st.menuKeyProblem && <Note state="attention">{st.menuKeyProblem}</Note>}
        </Panel>

        <Panel>
          <Field label={`Turn sound volume (${volume ?? st.settings.cueVolume})`} htmlFor="match-cue" help="Plays on the default sound device (the headset in VR) when your ball comes up, when another player's does, and at the end.">
            <input
              id="match-cue"
              type="range"
              className="cc-range"
              min={0}
              max={100}
              value={volume ?? st.settings.cueVolume}
              onChange={(e) => setVolume(Number(e.target.value))}
              onMouseUp={commitVolume}
              onKeyUp={commitVolume}
              onBlur={commitVolume}
            />
          </Field>
        </Panel>
      </PanelGroup>
    </>
  );
}

/** The kit's board: first place pink, second cyan. */
function placeClass(place: number): string {
  return place === 1 ? 'cc-place-1' : place === 2 ? 'cc-place-2' : '';
}

/** The sentence at the top of the tab, in the colour of what it is (`noticeKind`). */
const NOTE_STATE: Record<'ok' | 'warn' | 'error', 'ok' | 'attention' | 'problem'> = { ok: 'ok', warn: 'attention', error: 'problem' };

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
    <Panel wide title="VR test bench">
      {/* D7.6: theater alone (a clip or my own table, straight to the layer or through a local WebRTC loop), Save 2 s of frames. */}
      <TestBench bridge={bridge} st={st} onStatus={onStatus} bare />
      {/* D7.6.2: the VR report. */}
      <div className="cc-row">
        <Button size="sm" variant="secondary" disabled={busy} onClick={writeReport}>
          {busy ? 'Writing the VR report…' : 'Write VR report'}
        </Button>
      </div>
      <small className="cc-help">
        Writes what the headset, the runtime and VPX say about the picture (and this app&apos;s settings and counters) to a file to send. VPX should be running in VR for
        the headset part; it takes a few seconds.
      </small>
      {written && (
        <p className="cc-help">
          Written: <code className="cc-mono">{written.md}</code> (and <code className="cc-mono">.json</code> beside it)
        </p>
      )}
      {error && (
        <Note state="problem" role="alert">
          {error}
        </Note>
      )}
    </Panel>
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
  return short(st.participants.find((p) => p.id === id)?.name ?? (st.lobby ? "the lobby's PC" : 'the host'));
}

function turnLine(st: MatchStatus): string {
  const panel = st.panel;
  switch (st.phase) {
    case 'lobby':
      // A17 step 1: a client that lost its host in the lobby: the lobby is over (the line under this one says why).
      if (st.series?.over || st.lobby?.over) return st.lobby ? 'LOBBY CLOSED' : 'LOBBY OVER';
      // A17 step 9: a countdown that has run out and is held (a player's link dropped a moment ago) reads STARTING, not "IN 0".
      if (typeof panel?.countdown === 'number') return panel.countdown > 0 ? `STARTING IN ${panel.countdown}` : 'STARTING';
      // A17 step 10 (design 11.9, the panel's header): tables are being opened.
      if (st.lobby?.table.changing) return 'CHANGING TABLE';
      // A17 step 7 (design 11.9, the panel's header): who starts, and how, is the line under this one (the lobby's own).
      if (st.lobby) return `LOBBY · ${st.lobby.members.length} HERE`;
      return st.role === 'host' ? (st.participants.length < 2 ? 'Waiting for players' : 'Everyone in? Start the match') : `Waiting for ${nameOf(st, st.hostId)} to start`;
    case 'playing': {
      // A lobby that was closed during a game: nobody is up any more.
      if (st.lobby?.over) return 'LOBBY CLOSED';
      const game = panel?.game && panel.game > 1 ? `GAME ${panel.game} · ` : '';
      if (!panel?.playerUp) return `${game}Next ball coming up`;
      return game + (panel.myTurn ? `YOUR BALL ${panel.ball ?? ''}`.trim() : `${short(nameOf(st, panel.playerUp), 16).toUpperCase()} IS UP`);
    }
    case 'paused':
      if (st.lobby?.over) return 'LOBBY CLOSED';
      // The final review (finding 4): a game that waits for somebody who is away says for whom, as the panel does.
      if (panel?.pausedFor && !(panel.myTurn && panel.playerUp === panel.pausedFor)) return `WAITING FOR ${short(nameOf(st, panel.pausedFor), 16).toUpperCase()}`;
      return 'PAUSED';
    case 'over':
      if (st.lobby?.over) return 'LOBBY CLOSED';
      if (st.lobby && typeof panel?.countdown === 'number') return panel.countdown > 0 ? `STARTING IN ${panel.countdown}` : 'STARTING';
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
    <Panel title={<label htmlFor="match-turn-url">TURN relay</label>}>
      <input id="match-turn-url" type="text" className="cc-input" value={urlText} placeholder="turn:relay.example.org:3478" onChange={(e) => setUrl(e.target.value)} />
      <div className="cc-fields">
        <Field label="Username" htmlFor="match-turn-user">
          <input id="match-turn-user" type="text" className="cc-input" value={userText} onChange={(e) => setUsername(e.target.value)} />
        </Field>
        <Field label="Credential" htmlFor="match-turn-credential">
          <input id="match-turn-credential" type="password" className="cc-input" value={credential} placeholder={turn?.credentialSet ? 'saved (blank keeps it)' : ''} onChange={(e) => setCredential(e.target.value)} />
        </Field>
      </div>
      <div className="cc-row">
        <Button size="sm" disabled={!dirty} onClick={() => submit(false)}>
          Save
        </Button>
        {turn && (
          <Button size="sm" variant="danger" onClick={() => submit(true)}>
            Clear
          </Button>
        )}
      </div>
      <small className="cc-help">
        Only if video and voice never connect (&quot;no path to …&quot;): a relay carries them when both routers block a direct connection. Used from the next match.
        {note ? ` ${note}` : ''}
      </small>
    </Panel>
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
/**
 * A17 step 9 (2026-11-27, design 11.9): how to bring somebody into the lobby, on every member's tab and not only
 * the opener's: the code, the link, and the line for a chat. A member of a lobby reached by address has none of
 * them (that invite is the address of the opener's PC, and stays the opener's to give), and is told so.
 */
function LobbyInvite({ bridge, st, one }: { bridge: CastcadeBridge; st: MatchStatus; one: OneStepStatus | null }) {
  const [copied, setCopied] = useState<'code' | 'link' | 'message' | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The Arcaid-look pass (2026-11-25): once somebody has joined, the invite is its Copy buttons (the link and how to
  // send it open under Invite); alone, it is open. What went wrong with it is said either way.
  const [open, setOpen] = useState<boolean | null>(null);
  if (!st.lobby || st.lobby.over) return null;
  const done = (what: 'code' | 'link' | 'message') => {
    setCopied(what);
    setError(null);
    setTimeout(() => setCopied(null), 2000);
  };
  const failed = (e: unknown) => setError(describe(e));
  const copy = (what: 'link' | 'message') => void bridge.launch.copy(what).then(() => done(what), failed);
  const invite = st.invite;
  if (!invite) {
    const opener = st.participants.find((x) => x.id === st.hostId)?.name ?? 'the person who opened it';
    return <p className="cc-help">To bring somebody in: ask {opener} for the invite (this lobby is reached at their PC&apos;s address).</p>;
  }
  const link = one?.link ?? null;
  const shown = open ?? st.lobby.members.length <= 1;
  return (
    <div className="cc-stack">
      <div className="cc-line cc-line--short">
        <span>
          <button type="button" className="cc-disclose" aria-expanded={shown} aria-controls="lobby-invite-more" onClick={() => setOpen(!shown)}>
            Invite
          </button>
        </span>
        <span className="cc-row">
          <Button size="xs" variant="secondary" onClick={() => void navigator.clipboard.writeText(invite).then(() => done('code'), failed)}>
            {copied === 'code' ? 'Copied' : st.via === 'relay' ? 'Copy code' : 'Copy invite'}
          </Button>
          {link && (
            <Button size="xs" variant="secondary" title={link} onClick={() => copy('link')}>
              {copied === 'link' ? 'Copied' : 'Copy link'}
            </Button>
          )}
          {link && one?.message && (
            <Button size="xs" variant="secondary" title={one.message} onClick={() => copy('message')}>
              {copied === 'message' ? 'Copied' : 'Copy for chat'}
            </Button>
          )}
        </span>
      </div>
      {st.via === 'relay' ? (
        <>
          {shown && (
            <div id="lobby-invite-more" className="cc-stack">
              {link && <code className="cc-mono">{link}</code>}
              <p className="cc-help">
                {/* The step 9 last pass: "with the table started" only while the lobby has a table to start. */}
                Send the code or the link{link?.startsWith('https://') ? (st.lobby?.table.name ? ' (it opens this lobby with the table started)' : ' (it opens this lobby)') : ''}. Everyone needs Castcade paired with ArcAid.
              </p>
              {st.directInvite && (
                <p className="cc-help">
                  For a player on your home network or one who is not paired (needs TCP {st.port} forwarded for players outside): <code className="cc-mono">{st.directInvite}</code>
                </p>
              )}
            </div>
          )}
          {/* The review of PR 136: this PC's own connection to ArcAid is away: said here, on the tab of the PC it is about. */}
          {/* Step 9: not when the sentence at the top of the tab already says it (Castcade started again and waits for ArcAid). */}
          {st.relayNote && !(st.lastError ?? '').includes('waiting for ArcAid') && <Note state="attention">{st.relayNote}.</Note>}
        </>
      ) : (
        <>
          {shown && (
            <div id="lobby-invite-more" className="cc-stack">
              <code className="cc-mono">{invite}</code>
              {st.portMapping ? st.portMapping.state !== 'failed' && <p className="cc-help">{st.portMapping.line}</p> : <p className="cc-help">Forward TCP {st.port} to this PC on your router, then send the invite to the others.</p>}
              {st.relayNote && <p className="cc-help">{st.relayNote}: a PC paired with ArcAid needs no port forward.</p>}
            </div>
          )}
          {st.portMapping?.state === 'failed' && <Note state="attention">{st.portMapping.line}</Note>}
          {st.ipSource === 'lan' && <Note state="attention">Castcade could not look up your public address, so this is your home-network address. For a player outside your network, replace it with your public address.</Note>}
        </>
      )}
      {error && <Note state="attention">{error}</Note>}
    </div>
  );
}

/**
 * A member's row after the name (design 11.9: "Krobs · VR · PLAY · LOADING"): the words, and apart from them what is
 * wrong or special about the row (drawn in the warning colour, so an AWAY or a NO TABLE is seen at a glance).
 */
function memberWords(st: MatchStatus, id: string, now: number): { text: string; flags: string[] } {
  const m = st.lobby?.members.find((x) => x.id === id);
  if (!m) return { text: '', flags: [] };
  // Design 11.9: "Dana · PC · PLAY · AWAY 0:42": for how long, as this PC has known it.
  const gone = m.awaySince === null ? null : Math.max(0, Math.floor((now - m.awaySince) / 1000));
  const flag: Record<(typeof m.flags)[number], string> = {
    away: gone === null ? 'AWAY' : `AWAY ${Math.floor(gone / 60)}:${String(gone % 60).padStart(2, '0')}`,
    loading: 'LOADING',
    no_table: 'NO TABLE',
    other_table: 'OTHER TABLE',
    own_game: 'OWN GAME',
    // A17 step 10: on the way to the lobby's new table.
    close_table: 'HAS TO CLOSE THEIR TABLE',
    asked: 'ASKED TO OPEN IT',
    changing: 'CHANGING TABLE',
  };
  // PLAY and WATCH are the choice for the NEXT start. While a match is open, somebody whose choice is not what they
  // do in it is said so (`inMatch`): set to Play and not in it (they joined during it), or set to Watch and still in it.
  const inIt = st.lobby?.match ? (m.inMatch && m.stance === 'watch' ? ' · plays this match' : !m.inMatch && m.stance === 'play' ? ' · watches this match' : '') : '';
  // The Arcaid-look pass: "starts from the table" only while the lobby has a table to start from.
  const starts = m.starter && st.phase !== 'playing' && st.phase !== 'paused' && (st.lobby?.table.name ?? null) !== null;
  const text = ` · ${RIG_SHORT[m.rig]} · ${m.stance === 'play' ? 'PLAY' : 'WATCH'}${inIt}${starts ? ' · starts from the table' : ''}`;
  return { text, flags: m.flags.map((f) => flag[f]) };
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

/**
 * The final review (finding 9): what kind of sentence stands at the top of the tab. The shell has one line for it
 * (`lastError`); a lobby that Castcade opened again as it was is good news (`ok`), and one that waits for ArcAid to
 * carry it again is something to know (`warn`). Everything else is what went wrong.
 */
function noticeKind(text: string): 'ok' | 'warn' | 'error' {
  if (!/^Castcade on this PC started again: the lobby \S+ is open again as it was/.test(text)) return 'error';
  return text.includes('waiting for ArcAid') ? 'warn' : 'ok';
}

/**
 * The final review (finding 10): a name inside a sentence or on a button, as the main process cuts it
 * (`match/short-name.ts`): 24 characters at most, the last an ellipsis. A row shows the name whole, cut in its own box.
 */
function short(name: string, max = 24): string {
  const chars = Array.from(name);
  return chars.length <= max ? name : `${chars.slice(0, max - 1).join('')}…`;
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
  return st.pass ? `${short(st.pass.name)}#${st.pass.ball}#${st.panel?.game ?? 1}#${st.lobby?.match?.id ?? ''}` : '';
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
    <div className="cc-fields">
      <Field
        label={`Spectator video: ${rungReadout(video, st.videoPin)}`}
        htmlFor="match-rung"
        help="Auto steps down a rung after 3 s of trouble and up after 30 s clean; a pin holds one rung. Full size at 30 fps comes before a smaller picture at 60: smoothness first."
      >
        <select id="match-rung" className="cc-input" value={st.videoPin === null ? 'auto' : String(st.videoPin)} onChange={(e) => apply({ pin: e.target.value === 'auto' ? null : Number(e.target.value) })}>
          <option value="auto">Auto (the controller picks the rung)</option>
          {video.ladder.map((r) => (
            <option key={r.rung} value={String(r.rung)}>
              {`${r.rung}: ${r.width}x${r.height} at ${r.fps} fps, ${mbps(r.kbps)}`}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Ceiling (kbps)" htmlFor="match-ceiling" help="The most this rig sends (default 20000: rung 1). Saved.">
        <input
          id="match-ceiling"
          type="number"
          className="cc-input cc-input--number"
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
      </Field>
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
