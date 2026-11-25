/**
 * A6 + C3 in the shell (docs/design/alpha-match.md §1–§3, 2026-10-30): one match at a time, hosted or joined over
 * `WsPeerTransport`, invite by text (no ArcAid lobby yet, F6). Owns the match keys (`<userData>/match-keys.json`),
 * the match settings (`<userData>/match.json`), the turn lock file the hook reads, the audio cue (a hidden window
 * that synthesises three cues with WebAudio, like `stream-host.ts`'s audio page) and the `MatchController`, which it
 * feeds with the witness's detector events. `media` (D2), `vrOverlay` (D7, SteamVR) and `vrLayer` (D7.3, OpenXR
 * runtimes) are optional: the app runs without them, and the lead wires the real ones. The panel goes up as soon as a player hosts or joins (coordinator
 * 2026-10-30), so the headset overlay can be checked before the match: the media layer is attached then with no
 * peers, and MATCH_READY adds them.
 *
 * A8 (2026-10-31): hosting opens the listener LAST, once the panel is up and the public-IP lookup has answered (or
 * failed), so the first client to connect meets a host that can show it and an invite that exists; the invite is
 * published only once the listener is up. A listener that cannot open tears the half-built match down again.
 *
 * D2.8 (2026-11-01): table sound. `tableAudio` (the helper, `media/audio-helper.ts`) mutes this rig's VPX while another
 * player is up and taps its sound while this rig is up; the panel page sends the tap as the table track and plays the
 * up player's. `table-audio-policy.ts` decides from the panel state and the three settings, at every status change
 * (`syncTableAudio`, beside `syncVrMode`); no match, the lobby and the result mute and tap nothing.
 *
 * A10 + A11 (2026-11-02): a match is a series, started and continued from the host's table (the controller follows
 * its `game_start`). The Match tab's buttons stay on the same IPC channels: `start()` is Start match in the lobby and
 * Next game between games; the host's `leave()` between games is End match (MATCH_END first, then the teardown). A
 * client whose series is over (MATCH_END, or the host gone between games) keeps the final standings up for
 * `SERIES_OVER_LINGER_MS` and then tears down by itself, so the headset does not keep a dead panel.
 *
 * D2.10 (2026-11-05): voice over the game. Three volume settings: the others' voices and the up player's table go to
 * the panel page (`media.setVolume`, live), my own table while I am up goes to the helper (`level`, through
 * `syncTableAudio`). While a match is on, `Control+Alt+Up` / `Down` step the voice and `Control+Alt+Left` / `Right`
 * my table (`VOLUME_SHORTCUTS`, global shortcuts registered at `openPanel`, released at `teardown` and on quit); a press
 * saves the setting, pushes it live, ticks the cue and shows the new level on the panel for a moment.
 *
 * A13 (2026-11-12, three matches stuck at grant 1 on an unpatched original table): whether this rig's open table can
 * report ball ends is the witness's `captureMode` (`ballEndsFrom`: `live` = it follows the table's hook journal). It
 * goes out in HELLO / the host's own roster facts and again on every lobby change (`announceLobby`), and the
 * controller gets it with the witness's reason for the lobby line. `start()` in the lobby refuses while any player's
 * table cannot report ball ends unless the host confirmed (`{ anyway: true }`, the Match tab's Start anyway);
 * `passTurn()` is the host's Pass the turn during a game (TURN_PASS, logged).
 *
 * D10.8 (2026-11-12, a tester's host had no port forward: "Could not reach the host ... (no answer in 10 s)"): match
 * control through ArcAid. A paired host registers a relay room named by the match code (`RelayHostTransport`) beside
 * its listener (`CompositeTransport`), and the invite is the code alone; a join by code goes through the relay
 * (`RelayClientTransport`), an address invite goes direct as before. With no relay (not paired, ArcAid unreachable, a
 * server without it) the host publishes the address invite and asks the router for the port in the background
 * (`port-mapping.ts`, UPnP, 3 s; removed at teardown, renewed at half its lease). `MatchStatus.path` says which path
 * is in use; `portMapping` what the router said.
 *
 * I11.4.2 (2026-11-19, ADR 0011, docs/design/state-stream-in-match.md §4): the state stream inside a match. With
 * `stream3d` (main/stream3d-host.ts) a match opens one more data connection per other player (MEDIA_SIGNAL channel
 * `stream`), and a player who waits with a locked table sees the player up on their own VPX table when both PCs can
 * (`syncStream`, from the same panel state that picks theater): the headset then shows no theater picture
 * (`syncVrMode`), the 2D video keeps flowing underneath and comes back the moment 3D does not work. At the grant the
 * turn lock is lifted once the fork is back on its own table (`lock.unlock`, 2 s at most). `tableLaunch()` is how a
 * match table is started (`one-step.ts`): in the fork when it is there and `watch3d` is `auto`.
 *
 * A18 (2026-11-24, the owner: "We never want another player's disconnect to cause the active player to have a messed
 * up session"; match ECVYGP, 2026-11-23: ArcAid dropped the match for one second in the owner's ball; the match paused
 * for 2.3 s, the native video stopped and its encoder started again, the other player's 3D watch closed and opened
 * again, and the voice connection was closed and made again). The engines do most of it (`match/host.ts`: a grace
 * before a dropped link is a disconnect, and no pause for a player who is not up; `match/client.ts`; the controller
 * keeps a media connection that never dropped). Here: the native video of the player whose ball is live goes on
 * through a pause (`syncNativeVideo`: the others may be told to wait, the picture is not cut), and a client says its
 * link to the host is down only once the engine does, after the grace (`watchHost`).
 */
import { BrowserWindow, ipcMain } from 'electron';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import type { GameFingerprint, ParticipantInfo, PayloadOf } from '@castcade/protocol';
import { ClientMatch } from '../match/client.js';
import { MatchController, TABLE_BY_HAND_NOTE, TABLE_FORK_FAILED_NOTE, lobbyLineKey, mismatchWords, vrViewMode, type ControllerStatus, type CueKind } from '../match/controller.js';
import { MENU_CLOSED, menuItems, menuPress, menuView, readMenuKey, shortcutWords, type MenuEffect, type MenuFacts, type MenuKey, type MenuState } from '../match/match-menu.js';
import { HostMatch, STREAM3D_WAIT_MAX_MS } from '../match/host.js';
import { MatchLog } from '../match/log.js';
import { Session } from '../match/session.js';
import { replayLog, type MatchState } from '../match/state.js';
import type { ForkLaunch } from '../launch/vpx-launch.js';
import type { GameEvent } from '../witness/journal-detector.js';
import type { JournalMark } from '../witness/types.js';
import { HOST_WAIT_MS, RESUME_FILE, RESUME_HEARTBEAT_MS, TableBacklog, createResumeStore, resumeFreshness, turnEndsOf, type ResumeRecord } from './match-resume.js';
import type { Transport } from '../match/transport.js';
import { CompositeTransport, RelayClientTransport, RelayError, RelayHostTransport, type RejoinPolicy } from '../match/transport-relay.js';
import { ForeignVersionError, WsPeerTransport, type ErrorHandler } from '../match/transport-ws.js';
import type { MatchMedia, MediaSignalling, MediaStatus, PanelState, PanelVolume, VrOverlay, VrOverlayStatus, VrViewMode } from '../media/match-media-types.js';
import { DEFAULT_MEDIA_SETTINGS, iceServers, type MediaSettingsStore, type TurnServer, type VideoPath } from '../media/media-settings.js';
import type { MicDevice } from '../media/panel-page.js';
import { scoreboardWanted } from '../media/scoreboard-page.js';
import { previewAdvice } from '../media/preview-stereo.js';
import type { NativeVideoHook, RtcHost } from '../media/rtc-host.js';
import { splitSignalling } from '../media/rtc-signaling.js';
import type { VideoHelper, VideoSink } from '../media/video-helper.js';
import { clampMaxKbps, clampPin, createVideoMesh, headsetVideoLine, THEATER_ON_RING, THEATER_RING_BACK_MS, THEATER_RING_EMPTY_MS, theaterPathStep, type TheaterPathState, type VideoMesh, type VideoRungs } from '../media/video-mesh.js';
import { clipFolderName, listClips, loadClip, type ClipSummary, type SaveFramesResult } from '../media/frame-clip.js';
import { benchHint, benchRequestFrom, benchStep, liveRefusal, type BenchState, type BenchStatus, type BenchView } from '../media/bench.js';
import { tuneWords, VR_LAYER_SCOREBOARD_ROOM_PROTOCOL } from '../media/vr-layer.js';
import type { TableAudioHelper } from '../media/audio-helper.js';
import { tableAudioPid, tableAudioPlan } from '../media/table-audio-policy.js';
import { RECIPE_VERSION } from '../patcher/render.js';
import { openPort, portMappingLine, type PortMapping, type PortMapResult } from './port-mapping.js';
import type { MatchStream3d, Stream3dHost, Stream3dView } from './stream3d-host.js';
import type { Logger } from './log.js';
import { describeError } from './log.js';
import { typingReason, type VpxForeground } from './vpx-foreground.js';

/** I11.4.18: the panel's and the Match tab's line while this PC's turn waits for VPX to be the active window. */
export const CLICK_TABLE_HINT = 'Your turn: click the table to play (VPX holds the table still while another window is the active one)';
import {
  cleanName,
  cleanPort,
  decideRig,
  formatInvite,
  gameFingerprintFrom,
  isIpv4,
  isTableOpen,
  lockPathFrom,
  newMatchCode,
  newMatchIdentity,
  parseInvite,
  parseMatchIdentity,
  pathLine,
  patchMatchSettings,
  loadMatchSettings,
  pickLanAddress,
  RELAY_NOT_PAIRED,
  relayHostNote,
  relayJoinFailure,
  rigFrom,
  rigFromStatus,
  serializeMatchIdentity,
  writeMatchSettings,
  ZERO_SHA256,
  type Invite,
  type MatchIdentity,
  type MatchSettings,
  type Rig,
  type RigDecision,
} from './match-setup.js';
import type { WitnessStatus } from '../witness/types.js';
import type { VrRuntime } from '../witness/vr-detect.js';
import type { WitnessHost } from './witness-host.js';

export type MatchPhase = 'none' | 'connecting' | 'lobby' | 'playing' | 'paused' | 'over';

export interface MatchStatus {
  role: 'none' | 'host' | 'client';
  phase: MatchPhase;
  /** This companion's listener (host), e.g. `ws://0.0.0.0:27401`. */
  endpoint: string | null;
  /** D10.8: the code alone when the match goes through ArcAid, else the address invite. */
  invite: string | null;
  /**
   * D10.8: the address invite of a host whose invite is the code (its listener still serves LAN players, forwarded
   * ports and players who are not paired); null when `invite` already is the address one, and for a client.
   */
  directInvite: string | null;
  /** Where the address invite's address came from: `public` (api.ipify.org) or `lan` (replace it with the public one). */
  ipSource: 'public' | 'lan' | null;
  /**
   * D10.8 (2026-11-12): how the match control travels, in one plain line: "Through ArcAid" or "Direct to <host>"
   * (`via` is the same fact for the code). Null with no match.
   */
  via: 'relay' | 'direct' | null;
  path: string | null;
  /** D10.8: a host on the direct path: why ArcAid is not carrying the match (not paired, unreachable). Else null. */
  relayNote: string | null;
  /**
   * D10.8: a host on the direct path: what the router said about opening the port (UPnP). `trying` for up to 3 s after
   * the invite is out. Null when the relay carries the match, for a client, and with no match.
   */
  portMapping: { state: 'trying' | 'opened' | 'failed'; line: string } | null;
  port: number | null;
  code: string | null;
  localId: string | null;
  hostId: string | null;
  /**
   * `tableNote` (D2.5, 2026-10-31): how the player's table differs from the host's (`mismatchWords`), null when it does
   * not; `buildMatch`: false when their VPX build differs (shown muted; the table may still be the same).
   */
  participants: Array<{
    id: string;
    name: string;
    rig: ParticipantInfo['rig'];
    tableMatch: boolean | null;
    tableNote: string | null;
    buildMatch: boolean | null;
    /** A13: whether this player's table can report ball ends (false: its turn never ends by itself); null = unknown. */
    ballEnds: boolean | null;
  }>;
  /**
   * A13 (2026-11-12): in the lobby, one line per player whose table cannot report ball ends. Not empty: the host's
   * Start match needs `start({ anyway: true })` (the tab's Start anyway).
   */
  startWarnings: string[];
  /**
   * I11.4.9 (2026-11-20): in the lobby, the players whose PC is still making its 3D connection, the seconds after which
   * the last of them is no longer waited for, and whether this host's start is held for it: `table` (a game started
   * on its table; the countdown follows by itself) or `tab` (Start match was pressed once; the match starts when
   * `players` is empty, and a second press starts it now). The lobby line (`panel.message`) says the same in words.
   */
  wait3d: { players: string[]; seconds: number; armed: 'table' | 'tab' | null };
  /**
   * B26 (2026-11-16): the Midnight Madness lines. First, from the lobby on, the setting when it is ON on a table
   * that could be read ("Midnight Madness is ON on Krobs' table (adjustment A.2 14 Special Mode)", B26.4); then one
   * line per ball of the current game the mode ran on (this player's own and the others'), oldest first: a fact, the
   * ROM's own audit went up. A flag only; the same players are marked in `panel.players[].flags` and `panel.result`.
   */
  advisories: string[];
  /** A13: for the host while a turn is held: whose ball Pass the turn would end, and at what score. Else null. */
  pass: { name: string; ball: number; score: number } | null;
  /** A8 (2026-10-31): a host transfer under way (proposed, not committed yet), with names; the engine acks it by itself. */
  transfer: { proposer: string; newHost: string | null; reason: 'host_left' | 'host_requested' } | null;
  /**
   * A10 (2026-11-02): the series: the game being played or just played, whether it is over for good, and, for the host
   * between games, why Next game cannot start now (null: it can). Null with no match.
   */
  series: ControllerStatus['series'] | null;
  panel: PanelState | null;
  media: MediaStatus | null;
  /**
   * D7.4.3 (2026-11-01): one line for a VR player about the picture sent (`preview-stereo.ts` previewAdvice): both eyes
   * in a 16:9 window, one eye only, or a setting Castcade could not read. Null when there is nothing to say.
   */
  previewAdvice: string | null;
  vrOverlay: VrOverlayStatus | null;
  /**
   * D7.6 (2026-11-03): the VR test bench: whether the OpenXR layer's pipe is connected, its protocol (the pattern needs
   * 3) and whether the calibration pattern is asked (D7.6.1). Null when this build has no layer.
   */
  vrBench: { connected: boolean; protocol: number; pattern: boolean } | null;
  /**
   * A6 (2026-10-31): where this rig's panel goes, decided at host / join (and switched to the headset when the witness
   * later reads VR), with the evidence. With no match, the witness's last sample. The Match tab shows both.
   */
  rig: Rig;
  rigReason: string;
  /**
   * B22 (2026-10-31): the VR runtime behind `rig: 'vr_headset'`, else null. D7.3: `steamvr` puts the panel in the
   * headset through the OpenVR overlay helper, any other runtime through the Castcade OpenXR layer (`vrOverlay` is then
   * the layer's status).
   */
  vrRuntime: VrRuntime | null;
  /**
   * The microphones (the panel page lists them during a match; before one, `refreshMicrophones` does, B22), the saved
   * choice and the mute.
   */
  microphones: MicDevice[];
  /** Null: the Windows default device. */
  micDeviceId: string | null;
  muted: boolean;
  /**
   * D2.9 (2026-11-02): the player's own TURN relay from media.json (url and username; the credential only as "set"),
   * used from the next match on. Null: none (STUN only).
   */
  turn: { url: string; username: string; credentialSet: boolean } | null;
  /**
   * D10.3 (2026-11-07): which path carries the spectator video (media.json `videoPath`): the native helper
   * (`castcade-video.exe`, the default) or the 0.2.36 Electron path; used from the next match on.
   */
  videoPath: VideoPath;
  /**
   * D10.5 (2026-11-07): the native video ladder's controls: this rig's ceiling (media.json `videoMaxKbps`, kbps) and
   * the manual pin (1..6, or null = the helper's controller chooses; a session knob, not saved). Applied live to the
   * running mesh and at the next match's start.
   */
  videoMaxKbps: number;
  videoPin: number | null;
  locked: boolean;
  /**
   * I11.4.2: the state stream of this match: this PC's VPX on the control connection, who is shown in 3D now, and one
   * line per other player saying what this PC shows of them (3D, or the 2D video and why). Null with no match, and in
   * a build without it.
   */
  stream3d: Stream3dView | null;
  settings: MatchSettings;
  /** The name the Host / Join cards prefill: the setting, else the pairing label. */
  defaultName: string;
  lastError: string | null;
  /** D8.10 (2026-11-14): why a menu key does nothing this match (another program holds it), else null. */
  menuKeyProblem: string | null;
  /** D7.6 (2026-11-03): the VR test bench while it runs (media/bench.ts), else null. */
  bench: BenchStatus | null;
  /**
   * A15: a match this PC was in when Castcade last closed, still worth going back to (`match-resume.ts`); null with
   * none, or while a match is on. `auto`: Castcade was in it under a minute ago or restarted itself for an update, so
   * the shell rejoins without asking.
   */
  resume: { code: string; role: 'host' | 'client'; names: string[]; auto: boolean } | null;
}

export interface MatchHost {
  host(opts: { port?: number; ballsPerGame: 3 | 5; displayName: string }): Promise<MatchStatus>;
  join(invite: string, displayName: string): Promise<MatchStatus>;
  /**
   * Host only: Start match in the lobby; A10: Next game between games (the same as a game started on the host's table).
   * A13: in the lobby, while `startWarnings` is not empty, it throws unless `anyway` is true (the host confirmed).
   * I11.4.9: in the lobby, while a PC's 3D connection is still being made (`wait3d.players`), the first call holds the
   * start (the status comes back still in the lobby, `wait3d.armed: 'tab'`) and the match starts by itself once
   * nobody is waited for (or 45 s have passed); a second call, or `anyway`, starts it now. `held` is the shell's own
   * call when a held start comes due: a start like any other, never held again.
   */
  start(opts?: { anyway?: boolean; held?: boolean }): Promise<MatchStatus>;
  /**
   * A13 (2026-11-12): host only, during a game: end the turn holder's ball at its last known score and grant the next
   * turn, as if its BALL_END had arrived (TURN_PASS in the match log). The Match tab confirms first.
   */
  passTurn(): Promise<MatchStatus>;
  /** A8 (2026-10-31): host only: end a pause nobody resumed (a dropped player that is not coming back reconnects never). */
  resume(): Promise<MatchStatus>;
  /** Leave the match; A10: the host's leave between games is End match (MATCH_END to everyone first). */
  leave(): Promise<MatchStatus>;
  setSettings(patch: Partial<MatchSettings>): MatchStatus;
  /** Null: the Windows default. Saved in media.json, and switched live while a match runs. */
  setMicrophone(deviceId: string | null): MatchStatus;
  setMuted(muted: boolean): MatchStatus;
  /**
   * D2.9 (2026-11-02): the TURN relay (saved in media.json, used from the next match on). Null or an empty url clears
   * it; a null credential keeps the saved one. Throws on a url that is not `turn:` / `turns:`.
   */
  setTurn(turn: { url: string; username: string; credential: string | null } | null): MatchStatus;
  /** D10.3 (2026-11-07): the spectator video path (saved in media.json, used from the next match on). */
  setVideoPath(path: VideoPath): MatchStatus;
  /**
   * D10.5 (2026-11-07): the Match tab's quality controls: the ceiling (saved in media.json, 500..50000 kbps) and the
   * manual pin (1..6 or null for auto; kept in memory for this run). Either may be absent; both reach a running mesh at once.
   */
  setVideoRungs(rungs: { maxKbps?: number; pin?: number | null }): MatchStatus;
  /** D2.6 (2026-11-01): the Match tab's Show panel / Hide panel for the desktop panel window; a no-op without one. */
  showPanel(): MatchStatus;
  hidePanel(): MatchStatus;
  /**
   * D7.6.1 (2026-11-03): the Match tab's "Show calibration pattern": the OpenXR layer shows its stereo test grid in
   * theater instead of any picture (null stops it). A no-op without the layer; the tab enables it only while
   * `vrBench` says a protocol-3 layer is connected.
   */
  setVrTest(test: 'pattern' | null): MatchStatus;
  /** B22 (2026-10-31): the Match tab opened: list the microphones if no match lists them; a status follows. Never throws. */
  refreshMicrophones(): void;
  status(): MatchStatus;
  onStatus(cb: (s: MatchStatus) => void): () => void;
  /**
   * A14 (2026-11-12): the host's game as this rig knows it: a client's from HELLO_ACK (`isTableOpen` says whether the
   * host's table is open yet), the host's own as last announced; null with no match. `one-step.ts` finds the table from it.
   */
  hostGame(): GameFingerprint | null;
  /**
   * I11.4.2 (§4.4): how a match table is started on this PC now: in the Castcade VPX build with the state stream's
   * variables (the options for `VpxLauncher.launch`, and the word on whether that start took), or null: as it always
   * was (no match, the setting off, no fork beside the VPX exe).
   */
  tableLaunch(): Promise<ForkLaunch | null>;
  /** I11.4.11: 3D can run on this PC: the Castcade VPX build is beside VPX and 3D watch is on. */
  wants3d(): boolean;
  /** I11.4.11: the launch's word for this match's lobby line (the host's identical file is on this PC, not imported); null takes it away. */
  setLaunchNote(note: string | null): void;
  /**
   * D7.6.3 (2026-11-03): the Match tab's Save 2 s of frames: the layer camera's frames and the theater frames handed to
   * the layer, into `<logs>/frames/<yyyy-mm-dd-hhmmss>/` (media/frame-clip.ts). Throws without the media layer.
   */
  saveFrames(): Promise<SaveFramesResult>;
  /**
   * D7.6 (2026-11-03): the VR test bench: theater alone in the headset, no second player (media/bench.ts). Refused
   * while a match is on; a match hosted or joined stops it. `req` comes from the renderer and is checked here.
   */
  startBench(req: unknown): Promise<MatchStatus>;
  /** D7.6: Stop: VPX's own view back (theater off), the layer and the panel detached. */
  stopBench(): Promise<MatchStatus>;
  /** D7.6: while it runs, theater (the bench picture) or VPX's own view, to compare. */
  setBenchView(view: BenchView): MatchStatus;
  /** D7.6: the saved clips under the frames folder, newest first (D7.6.3 makes them). */
  benchClips(): ClipSummary[];
  /**
   * A15: go back into the match of `status().resume`: a client reconnects to the host from its saved log; a host
   * opens the match again under the same code and waits for its players. Throws with a sentence when it cannot.
   */
  rejoin(): Promise<MatchStatus>;
  /** A15: drop the saved match (the Match tab's "Forget it"); the table is unlocked. */
  forgetResume(): MatchStatus;
  /**
   * On quit: leave any match and close the cue window. A15: `keepForRestart` (Castcade restarts to install an update):
   * a started match is not left; it is closed here and rejoined at the next start.
   */
  stop(opts?: { keepForRestart?: boolean }): Promise<void>;
}

export interface MatchHostOptions {
  file: string;
  keysFile: string;
  witness: WitnessHost;
  /** The pairing facts: the device id is the player id while paired (§3); the label is the default name. */
  device: () => { deviceId: string; deviceLabel: string };
  /** `RtcHost` (D2) in the app; the microphone picker and `setVr` are optional so tests can pass a bare `MatchMedia`. */
  media?: MatchMedia & Partial<Pick<RtcHost, 'microphones' | 'onMicrophones' | 'setMicrophone' | 'setVr' | 'refreshMicrophones' | 'setPreviewStereo' | 'setCameraLayer' | 'setCameraSource' | 'setCameraView' | 'setCameraEyes' | 'setNativeVideo' | 'saveFrames' | 'startBench' | 'stopBench' | 'benchStatus' | 'onBenchStatus'>>;
  /** `<userData>/media.json`: the microphone and mute choices, kept even when the media layer did not start. */
  mediaSettings?: MediaSettingsStore;
  /** The SteamVR overlay helper (`media/vr-overlay.ts`, D7): the panel in the headset when VPX runs on SteamVR. */
  vrOverlay?: VrOverlay;
  /** D7.3 (2026-10-31): the Castcade OpenXR layer (`media/vr-layer.ts`): the panel in the headset on any other runtime. */
  vrLayer?: VrOverlay;
  /** D2.8 (2026-11-01): the table-sound helper (`media/audio-helper.ts`); absent → every rig hears its own table. */
  tableAudio?: TableAudioHelper;
  /** MEDIA_SIGNAL over the match transport (D2); absent → the media layer gets a mute signalling. */
  signalling?: (role: HostMatch | ClientMatch, localId: string) => MediaSignalling;
  /**
   * D10.3 (2026-11-07, spectator-video-native.md §6.4): the native spectator-video helper (`media/video-helper.ts`)
   * and the two frame-ring tokens of this companion run (`send`: the layer camera → the helper; `recv`: the helper →
   * the layer's theater), one pair per start. Absent → the Electron video path only.
   */
  nativeVideo?: { helper: VideoHelper; sendRing: string; recvRing: string };
  /**
   * I11.4.2: the state stream inside a match (`main/stream3d-host.ts`): the control server the VPX fork connects to,
   * the tunnel and the 3D-or-2D decision. Absent → every match is 2D, as before.
   */
  stream3d?: Stream3dHost;
  appVersion: string;
  log: Logger;
  /**
   * D10.8: what the ArcAid relay needs: the base URL and the paired device's credentials; null while not paired.
   * Absent: no relay (every match is direct). The token never reaches a log.
   */
  relay?: () => { baseUrl: string; deviceId: string; deviceToken: string } | null;
  /** Test seam: the relay's connect and ack timeouts (ms). */
  relayTimeouts?: { connectMs?: number; ackMs?: number };
  /**
   * D10.8: the router port mapping tried when a host has no relay. Default `openPort` (UPnP, 3 s); null turns it off
   * (the tests, which must not search the network they run on).
   */
  openPort?: ((port: number) => Promise<PortMapResult>) | null;
  /** Test seam: the public IPv4, or null. Default: one GET to api.ipify.org, 4 s. */
  publicIp?: () => Promise<string | null>;
  /** Test seam: the lock file. Default: where the hook looks (`lockPathFrom(process.env)`). */
  lockFile?: string;
  /** Test seam: the address the host listens on. Default `0.0.0.0` (the other player comes in through the router). */
  listenAddress?: string;
  /**
   * Test seam: `host({ port: 0 })` listens on a port the OS picks (read back into the status and the invite), so a
   * test never picks a port and binds it later (a picked port can sit in a range Windows has reserved).
   */
  ephemeralPort?: boolean;
  /** Test seam: the rig decision at host / join. Default `decideRig(witness)`: the running VPX probed now (A6, 2026-10-31). */
  rig?: () => Promise<RigDecision>;
  /** D7.6.3: where saved frames go. Default `<userData>/logs/frames` (beside companion.log; `file`'s folder is userData). */
  framesDir?: string;
  /** D2.10 (2026-11-05): Electron's `globalShortcut` in the app (the in-game volume keys); absent → no keys (tests pass a fake). */
  shortcuts?: ShortcutRegistrar;
  /** D8.10: the clock the menu key's double press and the lobby's quiet time are read by; `Date.now` when absent. */
  now?: () => number;
  /** A15: the saved match. Default `match-resume.json` beside `file`. */
  resumeFile?: string;
  /** Test seam: `SERIES_OVER_LINGER_MS`, how long a client's panel stays after the series, or the lobby, is over. */
  seriesOverLingerMs?: number;
  /** A15 test seams: how long a client waits for a host that is gone, and how long a rejoin waits for the host's answer. */
  hostWaitMs?: number;
  rejoinTimeoutMs?: number;
  /** A15 test seam: how a relay client asks again for a room that is gone. Default `HOST_WAIT_REJOIN`. */
  relayRejoin?: Partial<RejoinPolicy>;
  /** A18 test seam: the engines' grace before a dropped link is a disconnect (ms). Default: theirs (5 s). */
  disconnectGraceMs?: number;
  /**
   * I11.4.18 (2026-11-24): how VPX gets the foreground back from a Castcade window (`vpx-foreground.ts`); absent: it is
   * never tried (the tests that are not about it, a build without it).
   */
  foreground?: VpxForeground;
}

/**
 * A15: a relay client's asks for a room that is gone, while it waits for its host (`HOST_WAIT_MS`): five asks, the
 * first two soon (ArcAid restarted and the host opened the room again within seconds), the last 88 s after the first
 * miss (a host whose Castcade restarted). Five misses stay under the server's lockout (eight in ten minutes).
 */
export const HOST_WAIT_REJOIN: RejoinPolicy = { gapsMs: [2_000, 6_000, 20_000, 60_000], maxMisses: 5, windowMs: 10 * 60_000 };
/** A15: how long a rejoin waits for the host's RECONNECT_ACK before it gives up (the saved match is kept). */
const REJOIN_TIMEOUT_MS = 20_000;
/** A15: a host that opened its relay room again lets its players back in for this long before it locks the room again. */
const REHOST_LOCK_MS = 60_000;

/** D2.10: what `globalShortcut` offers: `register` is false when another app holds the key. */
export interface ShortcutRegistrar {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
}

/** D2.10: the in-game volume keys (Electron accelerators), registered only while a match is on. */
export const VOLUME_SHORTCUTS = {
  voiceUp: 'Control+Alt+Up',
  voiceDown: 'Control+Alt+Down',
  tableDown: 'Control+Alt+Left',
  tableUp: 'Control+Alt+Right',
} as const;
/** D2.10: one press moves a volume by this many percent. */
export const VOLUME_STEP = 10;
/** D8.9: how long the headset shows the lobby panel after the lobby changed, before it gets out of the way again. */
export const LOBBY_PEEK_MS = 8000;
/** D8.10: the in-game menu closes by itself this long after the last key. */
export const MENU_IDLE_MS = 12_000;
/** D8.10: the arrows, held only while the menu is open. */
const MENU_ARROWS: Record<string, MenuKey> = { Up: 'up', Down: 'down', Left: 'left', Right: 'right' };

const CUE_CHANNEL = 'castcade-cue:play';
const CUE_STATUS_CHANNEL = 'castcade-cue:status';
const CONNECT_TIMEOUT_MS = 10_000;
const JOIN_TIMEOUT_MS = 10_000;
/** Lets a FORFEIT frame leave the socket before the transport is torn down. */
const LEAVE_FLUSH_MS = 300;
/** A10: how long a client shows the final standings after the series ended before it closes the match by itself. */
const SERIES_OVER_LINGER_MS = 20_000;
/** D7.6: after the bench's theater-off control, before the pipe closes (the layer reads the control first). */
const BENCH_HIDE_MS = 300;
/** D10.3.8: the theater-path watch's own tick (the helper's stats come once a second too, but not when nothing arrives). */
const THEATER_WATCH_MS = 1_000;
/** D10.8: how long teardown waits for the router to drop the port mapping. */
const UNMAP_TIMEOUT_MS = 2_000;
/** D10.8: a code the relay says is in use is replaced this many times before the match goes direct. */
const RELAY_CODE_TRIES = 3;

/** D10.8: what the shell needs of a match transport, whichever path it takes. */
type MatchTransport = Transport & { onError(cb: ErrorHandler): () => void };

interface Active {
  role: 'host' | 'client';
  transport: MatchTransport;
  /** The listener's endpoint (a host that listens), for the status. */
  ws: WsPeerTransport | null;
  /** D10.8: the path, and for `direct` the other end (a client: the host's address; a host: its own invite address). */
  via: 'relay' | 'direct';
  where: string | null;
  /** D10.8: a host's relay room, for its state on the path line. */
  relay: RelayHostTransport | null;
  relayNote: string | null;
  directInvite: string | null;
  /** D10.8: the router mapping of a direct host: what the tab shows, the mapping to remove, its renewal clock. */
  portMapping: MatchStatus['portMapping'];
  mapping: PortMapping | null;
  renewTimer: ReturnType<typeof setInterval> | null;
  engine: HostMatch | ClientMatch;
  controller: MatchController;
  code: string;
  port: number | null;
  invite: string | null;
  ipSource: 'public' | 'lan' | null;
  /** The overlay started for this match (the SteamVR helper or, D7.3, the OpenXR layer); null until one is. */
  overlay: VrOverlay | null;
  /** D7.4: the headset mode last given to `overlay` (and to which one), so each change goes out once. */
  vrMode: { mode: VrViewMode; to: VrOverlay } | null;
  /** A6 (2026-10-31): the rig decided at host / join; `pc` turns into `vr_headset` when the witness reads VR later. */
  rig: Rig;
  rigReason: string;
  /** B22 (2026-10-31): the runtime behind a `vr_headset` rig; it picks the overlay (D7.3). */
  runtime: VrRuntime | null;
  /** The witness's own reading at the last status, so a VR -> monitor change is logged once, not at every status. */
  witnessRig: Rig;
  /** A switch to the headset is under way (status events keep coming meanwhile). */
  switching: boolean;
  /**
   * A6 (2026-10-31, the first two-player match): the rig and fingerprint the others were last told (HELLO / the
   * host's own roster entry, then lobby updates), the witness reading they came from (`lobbyKey`), and a refresh
   * under way. Krobs joined before his table loaded and read "PC · different table file" for the whole match.
   */
  sent: { rig: Rig; game: GameFingerprint; ballEnds: boolean | null };
  lobbyKey: string;
  refreshing: boolean;
  refreshAgain: boolean;
  /** A10: a client's teardown after the series ended, once scheduled. */
  endTimer: ReturnType<typeof setTimeout> | null;
  offs: (() => void)[];
  /** D10.3: the native video mesh of this match (`openVideo`), null on the Electron path or without the helper. */
  video: VideoMesh | null;
  /** D10.3.8: theater's picture source while the sink is the layer's ring (`syncNativeVideo`), and its 1 s clock. */
  theater: TheaterPathState;
  theaterTimer: ReturnType<typeof setInterval> | null;
  /** I11.4.2: the state stream of this match (`openStream`), null without `stream3d`. */
  stream: MatchStream3d | null;
  /**
   * I11.4.9: what the host was last told about this PC's 3D connection (`announceWait3d`): not waited for (null), or
   * waited for until `until` (null: no limit runs yet). Undefined: nothing told yet.
   */
  wait3dSent?: { until: number | null } | null;
  /** I11.4.9: a Start match that was held for the 3D connections is being started now that they are settled. */
  heldStartQueued?: boolean;
  /** I11.4.12: the lobby says that this PC's table was not started by Castcade (logged when it begins and ends). */
  byHandSaid?: boolean;
  /** I11.4.11: the launch's word for the lobby line (the host's identical file is on this PC, not imported), or null. */
  launchNote?: string | null;
  /** I11.4.18: this PC held the turn at the last look (`emit`), so the next look knows a turn that has just come. */
  turnSeen?: boolean;
  /** A15: the invite a client joined with (saved for a rejoin); null on a host. */
  joinInvite: string | null;
  /** A15: the table's events the log has not answered yet (`TableBacklog`), and the witness's mark when it last was. */
  backlog: TableBacklog<GameEvent>;
  mark: JournalMark | null;
  /** A15: picked up after a restart: the table's events wait until the host's answer is merged (`tryReconcile`). */
  hold: boolean;
  /** A15: a reconnect happened: what the table said since the log last grew is fed (again) once the grant is settled. */
  reconcileDue: boolean;
  /** A15: this player's turn ends in the saved log, and VPX closed while the saved match waited. */
  savedTurnEnds: number;
  pendingExit: boolean;
  heartbeat: ReturnType<typeof setInterval> | null;
  /** A15: no (more) record for this match: it ended, or it changed hands. */
  recordOff: boolean;
}

/** A6 (2026-10-31): the witness facts a lobby refresh follows: the table's fingerprint and the VR sample. */
/** D2.9: the saved TURN relay as the Match tab sees it: never the credential itself. */
export function turnView(t: TurnServer | null): MatchStatus['turn'] {
  return t ? { url: t.url, username: t.username, credentialSet: t.credential !== '' } : null;
}

function lobbyKey(s: WitnessStatus): string {
  const vr = s.currentAttestation?.vr;
  return JSON.stringify([gameFingerprintFrom(s, RECIPE_VERSION), vr?.sampledAt ?? null, vr?.inVr ?? null, ballEndsFrom(s).ready]);
}

/**
 * A13 (2026-11-12): whether this rig's open table can report ball ends, from the witness: `live` = it follows the
 * table's hook journal (true); `basic` = a table is open and it does not (false, with the witness's own sentence
 * when it has one: not patched, an original table, a machine it cannot read); no table = unknown (null).
 */
export function ballEndsFrom(s: Pick<WitnessStatus, 'captureMode' | 'note' | 'ballEnds' | 'ballEndsNote'>): { ready: boolean | null; reason: string | null } {
  // C18: a table that is followed is not thereby one whose ball ends are read (Stern SAM, Bally / Stern M100: the
  // scores and the game end, no ball end). The witness says which (`ballEnds`); null there = not known yet.
  if (s.captureMode === 'live' && s.ballEnds === false) return { ready: false, reason: s.ballEndsNote?.trim() || null };
  if (s.captureMode === 'live' && s.ballEnds === null) return { ready: null, reason: null };
  if (s.captureMode === 'live') return { ready: true, reason: null };
  if (s.captureMode === 'basic') return { ready: false, reason: s.note?.trim() || null };
  return { ready: null, reason: null };
}

async function ipifyPublicIp(): Promise<string | null> {
  try {
    const r = await fetch('https://api.ipify.org', { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return null;
    const t = (await r.text()).trim();
    return isIpv4(t) ? t : null;
  } catch {
    return null;
  }
}

/** D7.5.10 / D7.5.11: the stereo window's tuning in words for the log (empty at the defaults), as the layer control's line says it. */
export function windowTuneWords(s: Pick<MatchSettings, 'windowDepthM' | 'eyeOffsetDeg' | 'softEdge'>): string {
  return tuneWords({ depthM: s.windowDepthM, dyDeg: s.eyeOffsetDeg }, s.softEdge);
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} (no answer in ${Math.round(ms / 1000)} s)`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/**
 * A17 step 2 (2026-11-24): the match half of a teardown by itself (`endMatchHalf`), for the tests that pin which half
 * closes what. Kept off `MatchHost` on purpose: nothing in the app may end a match and keep its lobby before step 7
 * gives that a meaning. Null for a `MatchHost` this module did not make.
 */
const MATCH_HALF = new WeakMap<MatchHost, () => void>();
export function matchHalfOf(mh: MatchHost): (() => void) | null {
  return MATCH_HALF.get(mh) ?? null;
}

export function createMatchHost(opts: MatchHostOptions): MatchHost {
  const { log, witness } = opts;
  const listeners = new Set<(s: MatchStatus) => void>();
  // D8.1 (2026-11-05): a match.json from before 0.2.36 is migrated once (the layer camera, one eye) and saved below.
  const loaded = loadMatchSettings(readText(opts.file));
  let settings = loaded.settings;
  // D7.4.3 (2026-11-01): the media layer declares the preview's stereo from this setting (and the ini on `auto`).
  opts.media?.setPreviewStereo?.(settings.previewStereo);
  // D7.5.1 (2026-11-02): the layer camera's layer and the Match tab's Camera (decided at each attach, alpha-match.md §5a).
  opts.media?.setCameraLayer?.(opts.vrLayer ?? null);
  opts.media?.setCameraSource?.(settings.cameraSource);
  // D7.5.9 (2026-11-04): the camera's view (whole render or the 1:2 crop); applied live to a running camera.
  opts.media?.setCameraView?.(settings.cameraView);
  // D8.1: the camera's eyes (one as a flat picture, or both side by side); applied live to a running camera.
  opts.media?.setCameraEyes?.(settings.cameraEyes);
  // D2.10: the page's playback volumes (the media layer keeps them for its next attach; a page that is up gets them now).
  const pushVolume = (note: string | null = null): void => {
    opts.media?.setVolume?.({ voice: settings.voiceVolume, table: settings.othersTableVolume, note } satisfies PanelVolume);
  };
  pushVolume();
  /**
   * D7.5.10 / D7.5.11 (2026-11-04): the stereo window's tuning and soft edge go to an overlay with Theater size: the
   * match's and the bench's, on every settings change (each setter is idempotent and the control dedups).
   */
  const syncWindowTune = (to: VrOverlay | null | undefined): void => {
    if (!to) return;
    to.setTheaterScale?.(settings.theaterScale);
    to.setWindowTune?.({ depthM: settings.windowDepthM, dyDeg: settings.eyeOffsetDeg });
    to.setSoftEdge?.(settings.softEdge);
  };
  let active: Active | null = null;
  let connecting = false;
  /** D7.6: the VR test bench (null: off). `overlay`: the OpenXR layer it put in theater, else the desktop panel shows it. */
  type Bench = { state: BenchState; source: 'clip' | 'live'; path: 'direct' | 'loop'; clip: string | null; overlay: VrOverlay | null; view: BenchView };
  let bench: Bench | null = null;
  const framesRoot = (): string => opts.framesDir ?? join(dirname(opts.file), 'logs', 'frames');
  let lastError: string | null = null;
  let busy = false;

  // ---- the turn lock (the hook checks it at each key press) ----
  const lockFile = opts.lockFile ?? lockPathFrom(process.env);
  let locked = false;
  /** I11.4.2: an unlock that waits for the fork to be back on its own table (its cancel), else null. */
  let unlockWait: (() => void) | null = null;
  const lock = {
    lock(): void {
      // A lock asked while an unlock still waits: the unlock is off.
      unlockWait?.();
      unlockWait = null;
      mkdirSync(dirname(lockFile), { recursive: true });
      writeFileSync(lockFile, '');
      locked = true;
    },
    /**
     * I11.4.2 (§4.3): while this PC's VPX shows another player's table (or is on its way there or back), the lock is
     * lifted only once it says `state playing`, 2 s at most (`MatchStream3d.whenPlaying`): a key pressed before then
     * would reach a table the player cannot see. Everywhere else: at once, as before.
     */
    unlock(): void {
      const s = active?.stream ?? null;
      if (s?.away()) {
        if (unlockWait) return;
        log.info('stream3d: the table is to be unlocked; waiting for VPX to be back on its own table (2 s at most)');
        // `whenPlaying` may answer before it returns (the fork came back meanwhile): the handle is kept only while
        // the answer is still to come.
        let answered = false;
        const cancel = s.whenPlaying((late) => {
          answered = true;
          unlockWait = null;
          try {
            rmSync(lockFile, { force: true });
            locked = false;
            log.info(`stream3d: the table is unlocked (${late ? 'VPX did not answer within 2 s' : 'VPX is back on its own table'})`);
          } catch (e) {
            log.warn(`match: could not unlock the table: ${describeError(e)}`);
          }
          if (active) emit();
        });
        if (!answered) unlockWait = cancel;
        return;
      }
      unlockWait?.();
      unlockWait = null;
      rmSync(lockFile, { force: true });
      locked = false;
    },
  };
  // ---- A15: the match Castcade was in when it last closed (match-resume.ts) ----
  const resumeStore = createResumeStore(opts.resumeFile ?? join(dirname(opts.file), RESUME_FILE), (l) => log.warn(l));
  const hostWaitMs = opts.hostWaitMs ?? HOST_WAIT_MS;
  const waitWords = `${Math.max(1, Math.round(hostWaitMs / 60_000))} minute${Math.round(hostWaitMs / 60_000) > 1 ? 's' : ''}`;
  let pendingResume: ResumeRecord | null = resumeStore.read();
  if (pendingResume && resumeFreshness(pendingResume, Date.now()) === 'stale') {
    log.info(`match: the saved match ${pendingResume.code} is too old to go back to (last seen ${new Date(pendingResume.aliveAt).toISOString()}); dropped`);
    pendingResume = null;
  }
  if (!pendingResume) resumeStore.remove();
  else log.info(`match: Castcade closed during the match ${pendingResume.code} (${pendingResume.role}); it can be rejoined`);
  /** The table's events while the saved match waits for its rejoin, and whether VPX closed meanwhile. */
  let pendingBacklog: TableBacklog<GameEvent> | null = pendingResume ? new TableBacklog<GameEvent>(pendingResume.mark, true) : null;
  let pendingExit = false;
  const forget = (why: string): void => {
    if (!pendingResume) return;
    log.info(`match: the saved match ${pendingResume.code} is dropped: ${why}`);
    pendingResume = null;
    pendingBacklog = null;
    pendingExit = false;
    resumeStore.remove();
    if (!active) lock.unlock();
  };

  // A lock left by a crash would keep every solo game dead: no match is running at startup. A15: unless a match can
  // be rejoined: then the table stays as the last run left it (locked while another player was up).
  if (pendingResume) locked = existsSync(lockFile);
  else if (existsSync(lockFile)) {
    try {
      rmSync(lockFile, { force: true });
      log.warn(`match: removed a turn lock left from an earlier run (${lockFile})`);
    } catch (e) {
      log.error(`match: could not remove the stale turn lock ${lockFile}: ${describeError(e)}`);
    }
  }

  // ---- the cue ----
  const cue = createCue(join(dirname(opts.file), 'match-cue.html'), () => settings.cueVolume, log);

  // ---- identity ----
  let identity: MatchIdentity | null = null;
  const matchIdentity = (): MatchIdentity => {
    if (identity) return identity;
    const loaded = parseMatchIdentity(readText(opts.keysFile));
    if (loaded) {
      identity = loaded;
      return loaded;
    }
    const fresh = newMatchIdentity();
    mkdirSync(dirname(opts.keysFile), { recursive: true });
    const tmp = `${opts.keysFile}.tmp`;
    writeFileSync(tmp, serializeMatchIdentity(fresh));
    renameSync(tmp, opts.keysFile);
    log.info(`match: generated match keys (${opts.keysFile})`);
    identity = fresh;
    return fresh;
  };
  const playerId = (): string => (witness.status().paired ? opts.device().deviceId : matchIdentity().installId);
  const defaultName = (): string => settings.displayName ?? cleanName(opts.device().deviceLabel) ?? 'Player';

  const saveSettings = (next: MatchSettings): void => {
    settings = next;
    try {
      mkdirSync(dirname(opts.file), { recursive: true });
      const tmp = `${opts.file}.tmp`;
      writeFileSync(tmp, writeMatchSettings(settings));
      renameSync(tmp, opts.file);
    } catch (e) {
      log.warn(`match: could not save ${opts.file}: ${describeError(e)}`);
    }
  };
  if (loaded.migrated) {
    log.info(`match: ${loaded.migrated}`);
    saveSettings(settings);
  }

  // ---- status ----
  const idleRig = (): RigDecision => {
    const d = rigFromStatus(witness.status());
    return { rig: d.rig, reason: `no match; decided again when you host or join (${d.reason})`, runtime: d.runtime };
  };
  /** `RigDecision` names it `reason`; the status calls it `rigReason`. */
  const rigOf = (d: RigDecision): { rig: Rig; rigReason: string; runtime: VrRuntime | null } => ({ rig: d.rig, rigReason: d.reason, runtime: d.runtime });
  /**
   * D7.3 (2026-10-31): in VR the panel goes in the headset on every runtime. SteamVR: the OpenVR overlay helper draws
   * into its compositor. Any other (Virtual Desktop, Oculus, another OpenXR runtime; B22 told them apart): the Castcade
   * OpenXR layer draws inside VPX. A VR rig with no runtime is a sample from before B22, which only SteamVR produced.
   */
  type RigRuntime = Pick<Active, 'rig' | 'runtime'>;
  const usesLayer = (a: RigRuntime): boolean => a.rig === 'vr_headset' && a.runtime !== null && a.runtime !== 'steamvr';
  const overlayFor = (a: RigRuntime): VrOverlay | undefined => (usesLayer(a) ? opts.vrLayer : opts.vrOverlay);
  const headsetPanel = (a: RigRuntime): boolean => a.rig === 'vr_headset';
  const mediaRig = (a: Pick<Active, 'rig' | 'runtime'>): { inVr: boolean; headsetPanel: boolean; runtime: VrRuntime | null } => ({ inVr: a.rig === 'vr_headset', headsetPanel: headsetPanel(a), runtime: a.runtime });
  /** D7.6.1 / D7.6.2: the OpenXR layer's pipe as the Match tab's test-bench card needs it (the pattern toggle, the report). */
  const layerBenchView = (): MatchStatus['vrBench'] => {
    const b = opts.vrLayer?.bench?.();
    return b ? { connected: b.connected, protocol: b.protocol, pattern: b.test === 'pattern' } : null;
  };
  const nameIn = (c: ControllerStatus, id: string): string => c.participants.find((p) => p.playerId === id)?.displayName ?? id;
  const status = (): MatchStatus => {
    const a = active;
    const c: ControllerStatus | null = a ? a.controller.status() : null;
    const phase: MatchPhase = connecting ? 'connecting' : c ? c.phase : 'none';
    const r = a ? { rig: a.rig, rigReason: a.rigReason, runtime: a.runtime } : rigOf(idleRig());
    const rawMedia = a && opts.media ? opts.media.status() : null;
    const withAudio = rawMedia && opts.tableAudio ? { ...rawMedia, tableAudio: opts.tableAudio.status() } : rawMedia;
    // D10.3: the native video block, like table sound: only while this match runs it. D10.3.8: with theater's path.
    const media = withAudio && a?.video ? { ...withAudio, nativeVideo: { ...a.video.status(), theaterPath: theaterOnRing(a) ? a.theater.path : null } } : withAudio;
    return {
      role: a ? a.role : 'none',
      phase,
      endpoint: a?.ws?.endpoint ?? null,
      invite: a?.invite ?? null,
      directInvite: a?.directInvite ?? null,
      ipSource: a?.ipSource ?? null,
      via: a?.via ?? null,
      path: a ? pathLine(a.via, a.where, a.relay?.state ?? null) : null,
      relayNote: a?.relayNote ?? null,
      portMapping: a?.portMapping ?? null,
      port: a?.port ?? null,
      code: a?.code ?? null,
      localId: a ? a.engine.localId : null,
      hostId: c?.hostId ?? null,
      participants: (c?.participants ?? []).map((p) => {
        const words = c ? mismatchWords(c.mismatches[p.playerId] ?? []) : null;
        return {
          id: p.playerId,
          name: p.displayName,
          rig: p.rig,
          tableMatch: c ? !c.tableMismatch.includes(p.playerId) : null,
          tableNote: words?.table ?? null,
          buildMatch: words ? words.build === null : null,
          ballEnds: c?.ballEnds[p.playerId] ?? null,
        };
      }),
      startWarnings: c?.startWarnings ?? [],
      wait3d: c?.wait3d ?? { players: [], seconds: 0, armed: null },
      advisories: c?.advisories ?? [],
      pass: c?.pass ? { name: c.pass.name, ball: c.pass.ball, score: c.pass.score } : null,
      transfer: c?.transfer
        ? {
            proposer: nameIn(c, c.transfer.proposer),
            newHost: c.transfer.newHost === null ? null : nameIn(c, c.transfer.newHost),
            reason: c.transfer.reason,
          }
        : null,
      series: c?.series ?? null,
      panel: c?.panel ?? null,
      media,
      previewAdvice: previewAdvice({ inVr: r.rig === 'vr_headset', declared: media?.captureStereo, crop: media?.captureCrop }),
      vrOverlay: a ? ((a.overlay ?? overlayFor(a))?.status() ?? null) : null,
      vrBench: layerBenchView(),
      rig: r.rig,
      rigReason: r.rigReason,
      vrRuntime: r.runtime,
      microphones: opts.media?.microphones?.() ?? [],
      micDeviceId: opts.mediaSettings?.get().micDeviceId ?? null,
      muted: opts.mediaSettings?.get().muted ?? false,
      turn: turnView(opts.mediaSettings?.get().turn ?? null),
      videoPath: videoPath(),
      videoMaxKbps: videoMaxKbps(),
      videoPin,
      locked,
      stream3d: a?.stream?.status() ?? null,
      settings: { ...settings },
      defaultName: defaultName(),
      lastError,
      menuKeyProblem,
      bench: benchView(),
      resume: resumeView(),
    };
  };
  const resumeView = (): MatchStatus['resume'] => {
    const rec = pendingResume;
    if (!rec || active) return null;
    const fresh = resumeFreshness(rec, Date.now());
    return fresh === 'stale' ? null : { code: rec.code, role: rec.role, names: [...rec.names], auto: fresh === 'auto' };
  };
  /** D7.6: the bench for the Match tab: the media layer's readout, plus the layer's own state while it is not showing. */
  const benchView = (): BenchStatus | null => {
    const b = bench;
    if (!b) return null;
    const m = opts.media?.benchStatus?.() ?? null;
    const o = b.overlay?.status() ?? null;
    const layer = o && o.state !== 'showing' ? ` · the layer is ${o.state}${o.reason ? ` (${o.reason})` : ''}` : '';
    const headset = !!b.overlay;
    return { state: b.state === 'running' ? 'running' : 'starting', source: b.source, path: b.path, clip: b.clip, headset, view: b.view, readout: (m?.readout ?? 'starting') + layer, hint: benchHint(headset, b.view) };
  };
  /**
   * D7.4 (2026-10-31): the headset follows the turn: hidden on this player's ball, theater while another is up, the
   * panel otherwise (`vrViewMode`, with the Match tab's two settings). Given to the overlay running now, once per change.
   */
  // ---- D8.9 (2026-11-14): the lobby panel stays out of the way of a table that is free to play ----
  const clock = opts.now ?? Date.now;
  let peekKey = '';
  let peekUntil = 0;
  let peekTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * True while the headset should show nothing in the lobby: this table is not locked (free play before the match, and
   * every client's table), no start is counting down or held for the 3D connections, and the lobby last changed (someone joined, left, loaded a
   * table; the panel's one line changed) more than `LOBBY_PEEK_MS` ago. Each change shows the panel for that long; the
   * menu key brings it up at any time.
   */
  const lobbyQuiet = (p: PanelState): boolean => {
    // I11.4.9: a start held for the 3D connections keeps the panel up, as the countdown that follows it does.
    const w = active?.controller.status().wait3d;
    const held = !!w && w.armed !== null && w.players.length > 0;
    if (p.phase !== 'idle' || locked || typeof p.countdown === 'number' || held) {
      peekKey = '';
      return false;
    }
    // The line without the seconds of a held start: a number that counts down is not a change of the lobby.
    const key = JSON.stringify([p.players.map((x) => [x.id, x.flags]), lobbyLineKey(p.message)]);
    const now = clock();
    if (key !== peekKey) {
      peekKey = key;
      peekUntil = now + LOBBY_PEEK_MS;
      if (peekTimer) clearTimeout(peekTimer);
      peekTimer = setTimeout(() => {
        peekTimer = null;
        if (active) emit();
      }, LOBBY_PEEK_MS + 20);
    }
    return now >= peekUntil;
  };
  const syncVrMode = (a: Active): void => {
    const to = a.overlay;
    if (!to) return;
    syncWindowTune(to);
    const p = a.controller.panel();
    // A16.2: while this player enters high-score initials the headset stays on their own table.
    const turn = vrViewMode(p, settings, { menuOpen: menu.open, lobbyQuiet: lobbyQuiet(p), initialsHold: a.controller.status().initialsHold });
    // I11.4.2 (§4.3): while this PC's VPX shows the player up on its own table there is no theater picture: nothing
    // over the table (the corner scoreboard stays: `syncScoreboard`). The panel (the setting, the menu) is untouched.
    const in3d = turn === 'theater' && (a.stream?.showing3d() ?? false);
    const mode: VrViewMode = in3d ? 'hidden' : turn;
    if (a.vrMode?.mode === mode && a.vrMode.to === to) return;
    a.vrMode = { mode, to };
    log.info(`match: headset mode ${mode}${in3d ? ' (the player up is on this table in 3D: no theater picture)' : ''}`);
    to.setMode(mode);
  };
  /**
   * I11.4.2 (§4.3): the state stream follows the match: a data connection per other player from the lobby on, the
   * setting, and who this PC should be watching: the player up while this PC waits with its table locked. Whenever
   * this PC's table is its own (it is up; the lobby, a pause, between games; the initials hold and the window in which
   * a finished game ends on the machine, both of which leave the table unlocked) the answer is nobody, and the fork is
   * on its own table.
   */
  const syncStream = (a: Active): void => {
    const s = a.stream;
    if (!s) return;
    const c = a.controller.status();
    const me = a.engine.localId;
    s.setSetting(settings.watch3d);
    s.setPeers(c.participants.filter((x) => x.playerId !== me).map((x) => ({ id: x.playerId, name: x.displayName })));
    const p = c.panel;
    const waiting = p.phase === 'playing' && !p.myTurn && p.playerUp !== null && p.playerUp !== me && c.locked && !c.initialsHold;
    // The turn is the grant: a new one to the same player (shoot again, the last player with balls left) is a new
    // turn, and a watch that failed in the last one is tried again.
    const grant = (a.controller.currentRole as HostMatch | ClientMatch).state.currentGrant?.grant ?? null;
    s.setTarget(waiting ? p.playerUp : null, waiting && grant ? String(grant.grantSeq) : null);
    // I11.4.9: only the match's first start waits for the 3D connections: the lobby before game 1 (a next game and a
    // rejoin are never in that phase).
    s.setStartGate(c.phase === 'lobby');
    const tableOpen = isTableOpen(gameFingerprintFrom(witness.status(), RECIPE_VERSION));
    s.setTableOpen(tableOpen);
    announceWait3d(a);
    // I11.4.11: the lobby's table line says what a different file costs only where the identical file would give 3D:
    // this PC's VPX is ready in the Castcade build, and some other PC is not known to have none.
    const v = s.status();
    a.controller.set3dInPlay(settings.watch3d === 'auto' && v.fork === 'ready' && v.players.some((x) => x.why !== 'no_fork_there'));
    // I11.4.12: the Castcade VPX build is here and 3D is wanted, and the table that is open was not started in it by
    // Castcade (opened by hand, or open before the match): said in the lobby, where the player looks, for as long as
    // it is so. Not while a table Castcade started is still loading, and not for a build that never connects.
    // Nor for the moment a fork that dropped off the control connection takes to be back (it retries by itself).
    const byHand = c.phase === 'lobby' && settings.watch3d === 'auto' && v.forkInstalled === true && v.fork === 'none' && !v.expecting && !v.forkSilent && !v.reconnecting && tableOpen;
    if (byHand !== (a.byHandSaid ?? false)) {
      a.byHandSaid = byHand;
      log.info(
        byHand
          ? `stream3d: the table open on this PC is not running in the Castcade VPX build (${v.forkFailed ? 'Castcade tried that build for this match and it did not start' : 'opened by hand, open before the match, or started while 3D watch was off'}): this PC shows and is shown in the 2D video; the lobby says so`
          : 'stream3d: the lobby no longer says that the table is not running in the Castcade VPX build (it does not apply any more)',
      );
    }
    // What is true in each case: the table is not in the build. When Castcade itself tried the build for this match
    // and it did not start, starting the table again would only go round the same loop: that is said instead.
    // I11.4.11: and the word of the launch (the host's identical file is on this PC, not imported), while 3D is wanted.
    const notes = [byHand ? (v.forkFailed ? TABLE_FORK_FAILED_NOTE : TABLE_BY_HAND_NOTE) : null, c.phase === 'lobby' && settings.watch3d === 'auto' && v.forkInstalled === true ? (a.launchNote ?? null) : null].filter((x): x is string => x !== null);
    a.controller.setLobbyNote(notes.length > 0 ? notes.join(' · ') : null);
  };
  /**
   * I11.4.9: the host is told whether this PC's 3D connection is still being made (PARTICIPANT_UPDATE
   * `stream3dWaitMs`; the host's own through `updateLocal`), when that changed: it holds the match's first start for
   * it and lists it for every lobby. Lobby only. A client that has not joined yet says it at the next change.
   */
  const announceWait3d = (a: Active): void => {
    const s = a.stream;
    const role = a.controller.currentRole as HostMatch | ClientMatch;
    if (!s || role.state.phase !== 'lobby') return;
    const w = s.startWait();
    const next = w.pending ? { until: w.until } : null;
    const was = a.wait3dSent;
    const same = was !== undefined && (next === null ? was === null : was !== null && (next.until === null ? was.until === null : was.until !== null && Math.abs(was.until - next.until) <= 1000));
    // Nothing was ever said and nothing is waited for: the host assumes that already.
    if (same || (was === undefined && next === null)) return;
    // While no limit runs yet (this PC's table is still loading) the host is asked for the longest wait it takes.
    const ms = next === null ? 0 : next.until === null ? STREAM3D_WAIT_MAX_MS : Math.max(1, Math.min(STREAM3D_WAIT_MAX_MS, Math.round(next.until - Date.now())));
    // Noted before it is said: the host's own update comes back here through the controller's change, at once.
    a.wait3dSent = next;
    try {
      const said = role instanceof HostMatch ? (role.updateLocal({ stream3dWaitMs: ms }), true) : role.updateParticipant({ stream3dWaitMs: ms });
      if (!said) {
        a.wait3dSent = was;
        return;
      }
    } catch (e) {
      a.wait3dSent = was;
      log.warn(`stream3d: the host was not told about this PC's 3D connection: ${describeError(e)}`);
      return;
    }
    // What was sent, not what the other end does with it (a host on 0.2.46 drops the key and waits for nobody).
    const to = role instanceof HostMatch ? 'the players' : 'the host';
    log.info(
      next === null
        ? `stream3d: sent to ${to}: this PC's 3D connection is settled (stream3dWaitMs 0)`
        : `stream3d: sent to ${to}: this PC's 3D connection is still being made, ${next.until === null ? 'its table not open yet' : `${Math.ceil(ms / 1000)} s at most`} (stream3dWaitMs ${ms})`,
    );
  };
  /**
   * I11.4.9: a Start match that was held for the 3D connections (`MatchController.holdTabStart`) comes due once nobody
   * is waited for any more (they settled, or the hold's limit is reached). It then goes the way of a press of Start
   * match now, and no further: with a table that cannot report ball ends, or one that is still loading (somebody
   * joined during the hold), the hold is dropped and the host is told what Start match would have told them; a start
   * that fails drops it too. Never `anyway`: nothing here is the host's confirmation. Not from inside `emit`: the
   * start emits.
   */
  const startHeld = (a: Active): void => {
    const w = a.controller.status().wait3d;
    if (a.heldStartQueued || w.armed !== 'tab' || w.players.length > 0) return;
    a.heldStartQueued = true;
    setTimeout(() => {
      a.heldStartQueued = false;
      if (active !== a) return;
      const st = a.controller.status();
      if (st.wait3d.armed !== 'tab' || st.wait3d.players.length > 0) return;
      const loading = st.panel.players.filter((x) => x.flags.includes('loading')).map((x) => x.name);
      if (st.startWarnings.length > 0 || loading.length > 0) {
        const why = st.startWarnings.length > 0 ? st.startWarnings.join(' · ') : `${loading.join(', ')} ${loading.length > 1 ? 'have' : 'has'} no table open yet`;
        a.controller.dropTabHold(why);
        // The next press is not held again (the controller's word); with a warning it asks for the usual confirmation.
        lastError = `The match did not start by itself: ${why}. Press Start match to start it now${st.startWarnings.length > 0 ? ' (it asks you to confirm)' : ''}.`;
        log.warn(`match: the held Start match came due and was not started: ${why}`);
        emit();
        return;
      }
      log.info('match: the held Start match comes due: the match starts now');
      void api.start({ held: true }).catch((e: unknown) => {
        a.controller.dropTabHold(`the start failed (${describeError(e)})`);
        log.warn(`match: the held start did not happen: ${describeError(e)}`);
        emit();
      });
    }, 0);
  };
  /**
   * D2.8: the table sound the panel state calls for (`tableAudioPlan`), on the VPX the match uses (the capture's window,
   * else the witness's launch). The helper and the page each act only on a change. A16.2.2: an initials hold keeps
   * this rig's own table audible (the controller's status change reaches here through `emit`).
   */
  let tableLogged = '';
  const syncTableAudio = (): void => {
    const a = active;
    const panel = a ? a.controller.panel() : null;
    const hold = a ? a.controller.status().initialsHold : false;
    const plan = tableAudioPlan(panel, settings, { initialsHold: hold });
    // For the log: the hold is what keeps this table unmuted right now.
    const heldOpen = hold && !plan.muteMine && tableAudioPlan(panel, settings).muteMine;
    const pid = a ? tableAudioPid(opts.media?.capturePid?.(), witness.vpxPid?.()) : null;
    opts.tableAudio?.apply({ mutePid: plan.muteMine ? pid : null, tapPid: plan.tapMine ? pid : null });
    // D2.10: my table under my voice while I am up; back to its own volume the moment I am not.
    if (plan.levelMine !== null && pid !== null) opts.tableAudio?.level(pid, plan.levelMine);
    else opts.tableAudio?.unlevel();
    opts.media?.setTableAudio?.({ send: plan.tapMine && pid !== null, hear: plan.playTableOf !== null });
    const words = `mute ${plan.muteMine ? 'on' : heldOpen ? 'off (initials hold)' : 'off'}, send ${plan.tapMine ? 'on' : 'off'}, play ${plan.playTableOf ?? 'nobody'}, mine at ${plan.levelMine ?? 100} %, VPX pid ${pid ?? 'unknown'}`;
    if (opts.tableAudio && a && words !== tableLogged) {
      tableLogged = words;
      log.info(`match: table sound: ${words}`);
    }
  };
  /**
   * D8.12 (2026-11-15): the corner scoreboard follows the match and the Match tab's setting: its page beside a
   * headset panel on a layer rig, and the corner on the layer's control while a match is on (`scoreboardWanted`: not
   * in the lobby; the layer leaves it out while the full panel is up). Every call is idempotent. D8.12.3: where it is
   * held (fixed in the room, or on the head) is the Match tab's setting too, and applies live like the corner.
   */
  const syncScoreboard = (a: Active): void => {
    const to = a.overlay?.setScoreboard ? a.overlay : null;
    opts.media?.setScoreboard?.(settings.scoreboard && to !== null);
    to?.setScoreboard?.({
      frames: opts.media?.scoreboardFrames?.() ?? null,
      corner: scoreboardWanted(a.controller.panel(), settings.scoreboard) ? settings.scoreboardCorner : null,
      place: settings.scoreboardPlace,
      anchor: settings.scoreboardAnchor,
    });
  };
  /**
   * D8.12.3: the in-game menu's "Put the scoreboard where I look" line (`MenuFacts.scoreboardPlace`): there while this
   * match has a scoreboard in the headset that is held in the room (the rule of `syncScoreboard`, on an overlay that
   * can place it: the OpenXR layer), and ready once the layer in VPX is one that does it.
   */
  const scoreboardPlaceFact = (a: Active): MenuFacts['scoreboardPlace'] => {
    const to = a.overlay?.setScoreboard && a.overlay.placeScoreboard ? a.overlay : null;
    if (!to || settings.scoreboardAnchor !== 'room' || !scoreboardWanted(a.controller.panel(), settings.scoreboard) || !opts.media?.scoreboardFrames?.()) return null;
    const protocol = to.layerProtocol?.() ?? null;
    return protocol === null ? 'not_connected' : protocol < VR_LAYER_SCOREBOARD_ROOM_PROTOCOL ? 'old_layer' : 'ready';
  };
  /** A10: a client whose series is over closes the match after the linger (the host's End match tears down at once). */
  const scheduleSeriesEnd = (a: Active): void => {
    const st = a.controller.status();
    if (a.endTimer || active !== a || a.controller.currentRole instanceof HostMatch || !st.series.over) return;
    const lingerMs = opts.seriesOverLingerMs ?? SERIES_OVER_LINGER_MS;
    // A17 step 1 (the review of PR 127): a client that lost its host in the lobby (`MatchController.onLobbyLost`): the
    // voice is let go already; the panel says the lobby is over for the same linger, then everything of it closes
    // here (the page with the microphone, the video mesh, the tunnels, the link), and the Match tab keeps the reason.
    const lobbyLost = st.phase === 'lobby' ? (st.panel.message ?? 'The lobby is over: the host is gone.') : null;
    log.info(lobbyLost !== null ? `match: the lobby is over on this PC (the host is gone); closing it in ${Math.round(lingerMs / 1000)} s` : `match: the series is over; closing the match in ${Math.round(lingerMs / 1000)} s`);
    a.endTimer = setTimeout(() => {
      if (active !== a) return;
      void teardown(a).then(() => {
        if (lobbyLost !== null) lastError = lobbyLost;
        log.info(lobbyLost !== null ? `match: closed the lobby ${a.code}: its host is gone` : `match: closed ${a.code} after the series ended`);
        emit();
      });
    }, lingerMs);
  };
  /**
   * I11.4.18 (2026-11-24): VPX holds a table still while its window is not the active one. When this PC's table is the
   * one to play (Start match was pressed here; a grant reached this PC) and a Castcade window is the active one, the
   * foreground is handed on to VPX, so the ball moves without a click in VPX first. Never from a third program the
   * player has switched to (`castcadeActive` is false then, and the helper looks again before it acts), and never
   * while the in-game menu is open. One log line when it was done, one when it could not be.
   */
  let givingFocus = false;
  /** A handover that was skipped because the in-game menu was open on a Castcade window: tried again when it closes. */
  let focusOwed = false;
  /** The match whose panel line carries `CLICK_TABLE_HINT` now (it comes off when the turn or the window changes). */
  let hintOn: Active | null = null;
  const castcadeInFront = (): boolean => {
    try {
      return opts.foreground?.castcadeActive() ?? false;
    } catch {
      return false;
    }
  };
  /**
   * VPX did not get the foreground and it is this PC's turn: the Match tab and the panel say what to do. It is the
   * player's only word of it, so a line that is already up (ball 1's "Press Start on the table", a table-file note)
   * keeps its place and the hint follows it.
   */
  let hintText: string | null = null;
  const showClickHint = (): void => {
    const a = active;
    if (!a || !a.controller.status().myTurn) return;
    const line = a.controller.status().panel.message;
    if (line !== null && line.includes(CLICK_TABLE_HINT)) return;
    hintOn = a;
    hintText = line === null ? CLICK_TABLE_HINT : `${line} · ${CLICK_TABLE_HINT}`;
    a.controller.setMessage(hintText);
  };
  /**
   * `atGrant` (review 2 of PR 126, A): nobody clicked for this one, so it must not take the keyboard from a player who
   * is typing in Castcade: asked first (`VpxForeground.typing`), and left alone, with one log line, when they are.
   */
  const giveVpxFocus = (why: string, atGrant = false): void => {
    const fg = opts.foreground;
    if (!fg || givingFocus) return;
    // VPX itself, or a third program the player switched to, is in front: nothing to hand on, nothing touched.
    if (!castcadeInFront()) return;
    if (menu.open) {
      focusOwed = true;
      return;
    }
    givingFocus = true;
    void (async () => {
      if (atGrant && fg.typing) {
        const busy = typingReason(await fg.typing().catch(() => null));
        if (busy !== null) {
          log.info(`match: VPX was not given the foreground (${why}): ${busy}, and what the player types must not go to the table. Click the table to play`);
          showClickHint();
          return;
        }
      }
      // The match's own VPX, when it is known (the pid its table sound goes by): with two VPX open, not the other one.
      const pid = tableAudioPid(opts.media?.capturePid?.(), witness.vpxPid?.());
      const r = await fg.give(pid).catch(() => ({ ok: false, title: null, why: 'the window helper failed' }));
      if (r.ok) log.info(`match: gave VPX the foreground (${why}; a Castcade window was the active one, and VPX holds the table still while its own window is not)`);
      else {
        log.warn(`match: could not give VPX the foreground (${why}): ${r.why ?? 'no reason given'}. Click the table to play`);
        showClickHint();
      }
    })().finally(() => {
      givingFocus = false;
    });
  };
  const emit = (): void => {
    if (active) {
      // A15: a match that is over for good leaves nothing to go back to; a reconnect's replay runs once the grant is settled.
      if (!active.recordOff && active.controller.status().series.over) dropRecord(active);
      tryReconcile(active);
    }
    if (active) {
      // I11.4.18: a grant has just reached this PC: its table is the one to play now.
      const mine = active.controller.status().myTurn;
      if (mine && !active.turnSeen) giveVpxFocus('the turn came to this PC', true);
      else if (mine && focusOwed && !menu.open) {
        // The in-game menu was open on a Castcade window when the turn came, and has closed since.
        focusOwed = false;
        giveVpxFocus('the in-game menu closed on this PC\'s turn', true);
      }
      if (!mine) focusOwed = false;
      active.turnSeen = mine;
      // The hint comes off when it is no longer true: the turn is over, or the Castcade window is not in front any more.
      if (hintOn === active && (!mine || !castcadeInFront())) {
        const a = hintOn;
        hintOn = null;
        if (a.controller.status().panel.message === hintText) queueMicrotask(() => a.controller.setMessage(null));
        hintText = null;
      }
    }
    if (active) {
      // I11.4.2: the fork follows the turn first: the headset mode reads whether the player up is shown in 3D.
      syncStream(active);
      startHeld(active);
      syncVrMode(active);
      // D10.3: the native sender follows the turn beside the headset mode.
      syncNativeVideo(active);
      syncScoreboard(active); // D8.12
      scheduleSeriesEnd(active);
    }
    // D8.10: the menu's lines follow the match (Start match goes at the start, the volumes as they move).
    pushMenu();
    // D7.6: Theater size applies to the bench live, as in a match; D7.5.10 / D7.5.11: the window's tuning and soft edge too.
    syncWindowTune(bench?.overlay);
    syncTableAudio();
    const s = status();
    for (const l of [...listeners]) l(s);
  };
  const fail = (e: unknown): never => {
    lastError = describeError(e);
    emit();
    throw e instanceof Error ? e : new Error(lastError);
  };

  opts.media?.onStatus(() => {
    if (!active) return;
    active.controller.refresh();
    emit();
  });
  opts.vrOverlay?.onStatus(() => {
    if (active) emit();
  });
  // D7.6: the bench's facts (connected, protocol, the pattern) reach the Match tab as they change.
  opts.vrLayer?.onBench?.(() => {
    if (active) emit();
  });
  opts.vrLayer?.onStatus(() => {
    if (active || bench) emit();
  });
  opts.media?.onBenchStatus?.(() => {
    if (bench) emit();
  });
  opts.tableAudio?.onStatus(() => {
    if (active) emit();
  });
  opts.media?.onMicrophones?.(() => emit());
  witness.onEvent((ev, meta) => {
    const a = active;
    if (!a) {
      // A15: a saved match waits for its rejoin: what the table says meanwhile is kept for it.
      if (ev.kind === 'table_exit') pendingExit = pendingBacklog !== null;
      else pendingBacklog?.take(ev, meta);
      return;
    }
    if (ev.kind === 'table_exit') {
      a.controller.feed(ev);
      return;
    }
    if (!a.backlog.take(ev, meta)) return;
    if (a.hold) return;
    if (a.backlog.tableReopened()) a.controller.feed({ kind: 'table_exit' });
    a.controller.feed(ev);
  });
  // A16.2: the machine wrote its high-score list: the end of an initials hold. Not a game event (no backlog).
  witness.onHighScores?.((ev) => active?.controller.feed(ev));
  // B26.4: the ROM on this player's table counted a Midnight Madness: the ball being played is flagged. Not a game event.
  witness.onMidnightMadness?.((ev) => active?.controller.feed(ev));

  // ---- A15: the saved match while one is on ----
  const dropRecord = (a: Active): void => {
    if (a.recordOff) return;
    a.recordOff = true;
    resumeStore.remove();
  };
  const saveResume = (a: Active, restart: 'update' | null = null): void => {
    if (a.recordOff || active !== a) return;
    const role = a.controller.currentRole as HostMatch | ClientMatch;
    const st = role.state;
    if (st.phase === 'lobby') return;
    // A match that changed hands (a host transfer) is not one this file can bring back.
    if (role instanceof HostMatch !== (a.role === 'host')) return dropRecord(a);
    const me = role.localId;
    resumeStore.write({
      version: 1,
      role: a.role,
      code: a.code,
      invite: a.joinInvite,
      port: a.role === 'host' ? a.port : null,
      relay: a.role === 'host' ? a.relay !== null : a.via === 'relay',
      playerId: me,
      displayName: st.participants.find((p) => p.playerId === me)?.displayName ?? defaultName(),
      names: st.participants.filter((p) => p.playerId !== me).map((p) => p.displayName),
      log: role.log.toJSON(),
      mark: a.mark,
      aliveAt: Date.now(),
      restart,
    });
  };
  /** Every entry of the match log is saved as it is made (before anything is sent), and the record is touched every 15 s. */
  const followLog = (a: Active): void => {
    const me = a.engine.localId;
    a.engine.session.onCommit = (entry) => {
      if (active !== a) return;
      const m = entry.message;
      const mine =
        m !== undefined &&
        (m.type === 'MATCH_READY' ||
          m.type === 'NEXT_GAME' ||
          ((m.type === 'BALL_END' || m.type === 'GAME_OVER') && m.from === me) ||
          ((m.type === 'TURN_PASS' || m.type === 'FORFEIT') && m.payload.player === me));
      // The table's events up to here are answered, unless one of them is an end the log has not taken yet (it stays
      // to be reported again after a reconnect or a restart).
      if (!a.hold && (mine || !a.backlog.holdsEnd())) {
        a.backlog.clear();
        a.mark = witness.journalMark?.() ?? null;
      }
      saveResume(a);
      // A grant re-issued for the same ball changes nothing on the panel, so no status follows it: look here, once the
      // engine's own listeners (the controller) have had the entry.
      if (a.reconcileDue) queueMicrotask(() => tryReconcile(a));
    };
    a.heartbeat = setInterval(() => saveResume(a), RESUME_HEARTBEAT_MS);
    (a.heartbeat as { unref?: () => void }).unref?.();
    saveResume(a);
  };
  /**
   * After a reconnect (and once after a rejoin): what the table said since the log last grew goes to the controller,
   * again if it had it already: a ball end reported into a dropped link, or one that happened while Castcade was
   * closed, is reported now. It waits while the log names this player as up and the engine has not confirmed the
   * grant yet (the host re-issues it after RESUME).
   */
  const tryReconcile = (a: Active): void => {
    if (!a.reconcileDue || active !== a) return;
    const role = a.controller.currentRole as HostMatch | ClientMatch;
    const st = role.state;
    const me = role.localId;
    // Not during a pause either: a RESUME re-issues the grant under a new number, and a ball end reported for the old
    // one just before it would be refused.
    if (st.phase === 'running' && (st.paused !== null || st.pendingReissue !== null)) return;
    if (st.phase === 'running' && st.currentGrant?.grant.player === me && !a.controller.status().myTurn) return;
    a.reconcileDue = false;
    if (a.hold) {
      a.hold = false;
      // Ball ends the host already had (reported just before Castcade closed, or passed by the host meanwhile).
      a.backlog.skipEnds(turnEndsOf(role.log.entries(), me) - a.savedTurnEnds);
      if (a.pendingExit || a.backlog.tableReopened()) {
        a.pendingExit = false;
        log.warn('match: the table was closed while Castcade was closed');
        a.controller.feed({ kind: 'table_exit' });
      }
    }
    const events = a.backlog.pending();
    if (events.length > 0) log.info(`match: ${events.length} table event(s) since the log last grew go to the match now (${events.filter((e) => e.kind === 'ball_end').length} ball end(s))`);
    for (const ev of events) a.controller.feed(ev);
  };
  /** A fresh match's share of `Active`; `rec`: one picked up from the saved record. */
  const tracking = (invite: string | null, rec: ResumeRecord | null): Pick<Active, 'joinInvite' | 'backlog' | 'mark' | 'hold' | 'reconcileDue' | 'savedTurnEnds' | 'pendingExit' | 'heartbeat' | 'recordOff' | 'stream'> => ({
    stream: null,
    joinInvite: invite,
    backlog: rec ? (pendingBacklog ?? new TableBacklog<GameEvent>(rec.mark, true)) : new TableBacklog<GameEvent>(null, false),
    mark: rec?.mark ?? null,
    hold: rec !== null,
    reconcileDue: rec !== null,
    savedTurnEnds: rec ? turnEndsOf(rec.log, rec.playerId) : 0,
    pendingExit: rec !== null && pendingExit,
    heartbeat: null,
    recordOff: false,
  });
  /** The match is over for this PC without its doing: closed, with the reason on the Match tab. */
  const endMatch = async (a: Active, why: string): Promise<void> => {
    if (active !== a) return;
    await teardown(a);
    lastError = why;
    log.warn(`match: ${why}`);
    emit();
  };
  /**
   * A client and its host's link. While the host is gone the panel says so and for how long it is waited for; when the
   * wait runs out the match ends here (a client has no listener the others could come to, so it never takes over).
   */
  const watchHost = (a: Active, engine: ClientMatch): void => {
    a.offs.push(
      engine.on('peerLeft', (peer) => {
        if (active !== a || peer !== engine.hostId || engine.state.phase === 'lobby' || engine.matchEnded) return;
        // A18: said only once the engine's grace is over (a link that is back sooner raises nothing). A ball in play on
        // this PC goes on: the table stays as it is, and its end is reported when the link is back.
        log.warn(`match: the link to the host dropped; waiting up to ${waitWords} for it`);
        a.controller.setMessage(`The link to the host's Castcade is down: waiting up to ${waitWords} for it to come back. A ball in play goes on.`);
      }),
    );
    a.offs.push(
      engine.on('reconnected', (r) => {
        if (active !== a) return;
        // A18: a drop the player never saw still leaves one line here, for whoever reads the log afterwards.
        if (r.quiet) log.info(`match: the link to the host was away for a moment and is back (${r.entries} entr${r.entries === 1 ? 'y' : 'ies'} of the match log missed and caught up); nothing was shown`);
        a.controller.setMessage(null);
        a.reconcileDue = true;
        tryReconcile(a);
      }),
    );
    a.offs.push(engine.on('hostLost', () => void endMatch(a, `The host did not come back within ${waitWords}: the match is over.`)));
    a.offs.push(engine.on('reconnectRejected', (r) => void endMatch(a, `The host did not take this PC back into the match ${a.code}${r.code ? ` (${r.code.replace(/_/g, ' ')})` : ''}: the match is over for this PC.`)));
  };
  /**
   * A18: a host and its players' links: the log's lines for a player who is away and one who is back. What follows
   * from either is the engine's and the controller's; these lines are for whoever reads the log afterwards.
   */
  const watchPlayers = (a: Active, engine: HostMatch): void => {
    const name = (id: string): string => nameIn(a.controller.status(), id);
    a.offs.push(
      engine.on('peerLeft', (id) => {
        if (active !== a || engine.state.phase === 'lobby') return;
        const up = engine.state.currentGrant?.grant.player ?? null;
        log.warn(`match: ${name(id)} is away (its link to this host dropped and did not come back within the grace); ${up === id ? 'it holds the turn, so the match waits for it' : 'nothing is paused for it: the match waits for it when its own turn comes'}`);
      }),
    );
    // A held next game that is called off (nobody left to play it) is said where the host pressed for it, at once.
    a.offs.push(
      engine.on('nextGameOff', (x) => {
        if (active !== a) return;
        lastError = `The next game did not start: ${x.reason}.`;
        emit();
      }),
    );
    a.offs.push(
      engine.on('reconnected', (r) => {
        if (active !== a) return;
        log.info(r.quiet ? `match: ${name(r.playerId)}'s link to this host was away for a moment and is back; nothing was paused or shown` : `match: ${name(r.playerId)} is back on the match (${r.entries} entr${r.entries === 1 ? 'y' : 'ies'} of the match log sent)`);
      }),
    );
  };
  /** A15: a client's reconnect budget: by the clock, and never a take-over. */
  const clientLink = { reconnect: { attempts: 1_000_000, delayMs: 1000, maxMs: hostWaitMs }, hostLeftTransfer: false, disconnectGraceMs: opts.disconnectGraceMs } as const;
  // A6 (2026-10-31): the witness samples VR when a table opens and again when its player starts (`table_loaded`). A
  // player who hosted on the monitor reading (before opening the table, or before the player started) is switched
  // to the headset then: the panel moves offscreen and the overlay starts. The reverse is logged and ignored. D7.3
  // (2026-10-31): a VR reading whose runtime needs the other overlay (SteamVR <-> an OpenXR runtime: VPX restarted on
  // another runtime) stops the one running and starts the other.
  witness.onStatus((s) => {
    const a = active;
    if (!a) return;
    // A13: this rig's own line about its table's ball ends follows the witness in every phase.
    noteBallEnds(a.controller, s);
    // B26.4: and how the Midnight Madness setting reads on it (the witness sends a status update when that changes).
    noteMidnightMode(a.controller);
    checkLobby(a, s);
    const d = rigFromStatus(s);
    const now = d.rig;
    const was = a.witnessRig;
    a.witnessRig = now;
    if (now === 'vr_headset') {
      if (a.rig === 'pc' || overlayChanges(a, d)) void switchToVr(a, d);
      else if (headsetPanel(a) && !a.overlay && !a.switching && overlayFor(a) && opts.media?.frames()) void startOverlay(a);
    } else if (was === 'vr_headset' && a.rig === 'vr_headset') {
      log.info('match: the witness reads the monitor now; the panel stays in the headset for this match');
    }
  });

  /** A13: the controller's own-table facts (ready or not, and the witness's reason) for the lobby line. */
  const noteBallEnds = (controller: MatchController, s: WitnessStatus): void => {
    const be = ballEndsFrom(s);
    controller.setLocalBallEnds(be.ready, be.reason);
  };

  /** B26.4: this rig's own table: whether Midnight Madness is enabled on it, when the witness can read that. */
  const noteMidnightMode = (controller: MatchController): void => {
    let mode: ReturnType<NonNullable<WitnessHost['midnightSetting']>> = null;
    try {
      mode = witness.midnightSetting?.() ?? null;
    } catch (e) {
      log.warn(`match: the Midnight Madness setting could not be read: ${describeError(e)}`);
    }
    controller.setLocalMidnightMode(mode);
  };

  const makeController = (engine: HostMatch | ClientMatch, ballsPerGame?: number, resumed = false): MatchController => {
    // D10.3: the match signalling split by channel: the panel page's mesh gets `rtc`, the native video mesh `video`.
    const sig = opts.signalling?.(engine, engine.localId);
    const split = sig ? splitSignalling(sig) : null;
    const controller = new MatchController({
      role: engine,
      localId: engine.localId,
      lock,
      cue: { play: (k) => cue.play(k) },
      media: opts.media,
      signalling: split?.rtc,
      now: () => Date.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      log: (line) => log.info(line),
      ballsPerGame,
      // A12 (2026-11-05): the host's table before the match, and whether a game is already running on it.
      preMatchPlay: settings.preMatchPlay,
      tableGameRunning: liveGameRunning(),
      resumed,
      // A16.2: the witness knows the machine's high-score list (a test witness may not).
      highScoreQualifies: (score) => witness.highScoreQualifies?.(score) ?? false,
    });
    controller.onChange(() => emit());
    noteBallEnds(controller, witness.status());
    noteMidnightMode(controller);
    if (split) videoSides.set(controller, split.video);
    if (split) streamSides.set(controller, split.stream);
    return controller;
  };

  // ---- I11.4.2: the state stream inside a match ----
  /** The `stream` side of each controller's signalling, for the tunnel `openStream` makes once the match is up. */
  const streamSides = new WeakMap<MatchController, MediaSignalling>();
  /** At host / join: this match's data connections for the state stream, signalled on the `stream` channel. */
  const openStream = (a: Active): void => {
    const host3d = opts.stream3d;
    const side = streamSides.get(a.controller);
    if (!host3d || !side || a.stream) return;
    try {
      const s = host3d.open({ localId: a.engine.localId, setting: settings.watch3d, sendSignal: (to, sig) => side.send(to, sig) });
      a.stream = s;
      a.offs.push(side.onSignal((from, sig) => s.signal(from, sig)));
      a.offs.push(s.onChange(() => void (active === a && emit())));
    } catch (e) {
      log.warn(`stream3d: could not be set up for this match (${describeError(e)}); the 2D video serves`);
    }
  };

  // ---- D10.3: the native spectator video (spectator-video-native.md §6.4) ----
  /** The `video` side of each controller's signalling, for the mesh `openVideo` makes once the panel is up. */
  const videoSides = new WeakMap<MatchController, MediaSignalling>();
  const videoPath = (): VideoPath => opts.mediaSettings?.get().videoPath ?? DEFAULT_MEDIA_SETTINGS.videoPath;
  // D10.5: the ladder's controls: the ceiling from media.json, the pin for this run only (never saved).
  const videoMaxKbps = (): number => opts.mediaSettings?.get().videoMaxKbps ?? DEFAULT_MEDIA_SETTINGS.videoMaxKbps;
  let videoPin: number | null = null;
  const videoRungs = (): VideoRungs => ({ max_kbps: videoMaxKbps(), ...(videoPin !== null ? { pin: videoPin } : {}) });
  /** D10.5: the headset panel's one line about the native video, from the mesh status; null clears it. */
  const syncVideoLine = (a: Active): void => {
    opts.media?.setVideoLine?.(a.video ? headsetVideoLine(a.video.status()) : null);
  };
  /** Where decoded frames go on this rig: the layer's `recv` ring on an OpenXR rig (theater draws it), the helper's own window elsewhere. */
  const videoSink = (a: RigRuntime): VideoSink => (usesLayer(a) && opts.nativeVideo ? { kind: 'ring', token: opts.nativeVideo.recvRing } : { kind: 'window' });
  /**
   * At host / join with the setting on `native` and a helper in the build: start the helper (its availability shows
   * on the Match tab before the first ball), one mesh for the match on the `video` signalling, the media layer told
   * the send ring (it asks the layer camera with it and points the helper at the box the camera fills), the ICE list
   * from media.json. `syncNativeVideo` then follows the roster, the turn and the rig on every emit.
   */
  const openVideo = (a: Active): void => {
    const nv = opts.nativeVideo;
    if (!nv || a.video || videoPath() !== 'native') return;
    const side = videoSides.get(a.controller);
    if (!side) return;
    nv.helper.start();
    const mesh = createVideoMesh({ helper: nv.helper, localId: a.engine.localId, sendSignal: (to, s) => side.send(to, s), log: (l) => log.info(l) });
    a.video = mesh;
    a.offs.push(side.onSignal((from, s) => mesh.onSignal(from, s)));
    const hook: NativeVideoHook = {
      ring: nv.sendRing,
      onSource: (box) => mesh.setSource(box ? { kind: 'ring', token: nv.sendRing, ...box } : { kind: 'none' }),
      // D10.6: the screen capture's pick (a desktop rig, SteamVR, the Match tab on screen capture, a camera fallback):
      // the helper captures that window itself (`source wgc`) in the box and at the fps the Electron capture would use.
      onWindow: (w) => mesh.setSource(w ? { kind: 'wgc', ...w } : { kind: 'none' }),
    };
    // The hook (the camera asked with the ring, the window handed over, the page's video track held back) goes on now,
    // before the media attaches and whatever the helper's state (D10.3.7, 2026-11-07): the ring tokens exist at
    // companion start, the layer creates and fills the ring whether or not a helper reads it yet, and the helper opens
    // it when it is ready. 0.2.38 set the hook only once the helper was ready, which on the owner's rig was 0.5 s after
    // the camera had started without the ring: the re-ask made the layer restart the camera (`off (a new request)`),
    // the watch took that for the layer giving up and the preview window was sent for the whole match.
    // D10.3.6: once the mesh falls back (a peer failed with the helper's restarts exhausted, the helper gone for good,
    // or a peer that never connected) the hook comes off for the rest of the match: the media layer re-asks the camera
    // without the ring (the layer's JPEG frames feed the page again), hands the window back (`source none` to the
    // helper) and lets the page's video track send, as 0.2.36 did; a native connection that comes later does not take
    // the picture over.
    let hooked = false;
    let fellBack = mesh.status().fallback;
    const syncHook = (): void => {
      const want = !fellBack;
      if (want === hooked) return;
      hooked = want;
      opts.media?.setNativeVideo?.(want ? hook : null);
      if (!want) log.info('match: native video: the Electron video serves the rest of this match');
    };
    a.offs.push(
      mesh.onStatus((s) => {
        if (active !== a) return;
        if (s.fallback && !fellBack) {
          fellBack = true;
          syncHook();
        }
        syncVideoLine(a);
        emit();
      }),
    );
    mesh.setIce(iceServers(opts.mediaSettings?.get() ?? DEFAULT_MEDIA_SETTINGS));
    mesh.setRungs(videoRungs());
    syncHook();
    const h = nv.helper.status();
    log.info(`match: native video: on for this match (helper ${h.helper}${h.reason ? `, ${h.reason}` : ''}; send ring ${nv.sendRing}, recv ring ${nv.recvRing})`);
    // D10.3.8: the theater-path watch needs a clock of its own: with no native frames there may be no stats to emit on.
    a.theaterTimer = setInterval(() => void (active === a && a.video === mesh && syncNativeVideo(a)), THEATER_WATCH_MS);
    syncNativeVideo(a);
  };
  /** D10.3.8: this rig is in theater with the layer's ring as the sink: the only place the theater path means anything. */
  const theaterOnRing = (a: Active): boolean =>
    a.video !== null && videoSink(a).kind === 'ring' && vrViewMode(a.controller.panel(), settings) === 'theater' && !(a.stream?.showing3d() ?? false); // I11.4.2: not while the player up is shown in 3D
  /**
   * The mesh follows the match: a helper peer per other participant; `send` on exactly when the headset would be
   * hidden for this rig's own ball (the same panel state `syncVrMode` reads: playing and my turn); the sink and the
   * layer's `video.ring` from the rig as it is now (a desktop rig that moves into the headset switches to the ring).
   *
   * D10.3.8 (2026-11-07): the safety net under the ring. While this rig is in theater on the ring and the mesh's recv
   * stats for the player up show no frames (fps 0, or no recv stats) for `THEATER_RING_EMPTY_MS`, the ring is un-named
   * (`setVideoRing(null)`) so the layer draws the panel page's CVO2 frames, which the Electron path keeps delivering;
   * frames on the ring for `THEATER_RING_BACK_MS` name it again. One log line per switch; nothing switches outside
   * theater (the state resets to the ring when theater ends, so each episode starts on the native frames).
   */
  const syncNativeVideo = (a: Active): void => {
    const mesh = a.video;
    if (!mesh) return;
    const c = a.controller.status();
    mesh.setPeers(c.participants.map((p) => p.playerId).filter((id) => id !== a.engine.localId));
    const panel = a.controller.panel();
    // A18: a pause does not stop the picture of a ball that is live (`ball`: the grant's, until its end is logged), as
    // it does not put the panel over that player's table (D8.14): on 2026-11-23 a pause of 2.3 s for the other player
    // stopped the sender and started the encoder again in the owner's ball.
    mesh.setSending(panel.myTurn && (panel.phase === 'playing' || (panel.phase === 'paused' && panel.ball !== null)));
    // I11.4.2: a rig whose picture is the helper's own window (a desktop PC, a SteamVR rig) gets no window while its
    // VPX shows the player up in 3D: it would sit over the table. The window is back the moment 3D is not shown.
    const where = videoSink(a);
    const sink: VideoSink = where.kind === 'window' && (a.stream?.showing3d() ?? false) ? { kind: 'none' } : where;
    mesh.setSink(sink);
    const theater = theaterOnRing(a);
    const up = theater ? panel.playerUp : null;
    const recv = up !== null ? mesh.status().peers[up]?.recv : undefined;
    const step = theaterPathStep(a.theater, { theater, fps: recv ? recv.fps : null, now: Date.now() });
    a.theater = step.state;
    if (step.switched && up !== null) {
      const who = nameIn(c, up);
      log.info(step.state.path === 'pipe' ? `media: theater: no native frames from ${who} for ${THEATER_RING_EMPTY_MS / 1000} s; drawing the Electron frames` : `media: theater: native frames from ${who} for ${THEATER_RING_BACK_MS / 1000} s; drawing the frame ring again`);
    }
    opts.vrLayer?.setVideoRing?.(sink.kind === 'ring' && a.theater.path === 'ring' ? sink.token : null);
  };
  const closeVideo = (a: Active): void => {
    if (a.theaterTimer) clearInterval(a.theaterTimer);
    a.theaterTimer = null;
    a.theater = THEATER_ON_RING;
    if (!a.video) return;
    a.video.close();
    a.video = null;
    opts.media?.setVideoLine?.(null);
    opts.media?.setNativeVideo?.(null);
    opts.vrLayer?.setVideoRing?.(null);
  };

  /** A12: the witness's live game says a game is on this rig's table now (a test witness may not have `liveGame`). */
  const liveGameRunning = (): boolean => {
    try {
      return witness.liveGame()?.inGame ?? false;
    } catch {
      return false;
    }
  };

  /** D7.3: the overlay the panel needs is not the one this rig has been using (VPX moved between SteamVR and OpenXR). */
  const overlayChanges = (a: Active, d: RigDecision): boolean =>
    a.rig === 'vr_headset' && d.runtime !== null && usesLayer({ rig: 'vr_headset', runtime: d.runtime }) !== usesLayer(a);

  const startOverlay = async (a: Active): Promise<void> => {
    const { media } = opts;
    const overlay = overlayFor(a);
    const frames = media?.frames() ?? null;
    if (!overlay || !frames) {
      const none = usesLayer(a) ? 'no OpenXR layer' : 'no overlay helper';
      if (a.rig === 'vr_headset') log.info(`match: in VR but ${overlay ? 'the panel has no frames yet' : none}; showing the desktop panel`);
      media?.showPanel();
      return;
    }
    a.overlay = overlay;
    syncVrMode(a);
    const via = usesLayer(a) ? ` via the OpenXR layer (${a.runtime})` : '';
    try {
      const st = await overlay.start(frames, media?.videoFrames?.() ?? null);
      log.info(`match: VR overlay ${st.state}${st.reason ? ` (${st.reason})` : ''}${via}`);
    } catch (e) {
      log.warn(`match: the VR overlay${via} did not start: ${describeError(e)}`);
    }
    emit();
  };

  // ---- D2.10: the in-game volume keys ----
  let keysHeld = false;
  /** One press: the setting moves a step (clamped by `patchMatchSettings`), is saved, pushed live, ticked and shown. */
  const nudge = (key: 'voiceVolume' | 'myTableWhileUp', delta: number, accelerator: string): void => {
    const before = settings[key];
    saveSettings(patchMatchSettings(settings, { [key]: before + delta }));
    const now = settings[key];
    const what = key === 'voiceVolume' ? 'voice volume' : 'my table while I play';
    log.info(`match: ${what} ${now} % (${accelerator}${now === before ? ', at the limit' : ''})`);
    pushVolume(key === 'voiceVolume' ? `Voice ${now} %` : `My table ${now} %`);
    cue.play('tick');
    // The Match tab's sliders follow; for my table, `syncTableAudio` levels the helper.
    emit();
  };
  /** One global shortcut; false when it could not be taken (logged with `what` it was for). */
  const bind = (acc: string, what: string, fn: () => void): boolean => {
    const reg = opts.shortcuts;
    if (!reg) return false;
    let ok: boolean;
    try {
      ok = reg.register(acc, fn);
    } catch (e) {
      log.warn(`match: ${acc} could not be registered: ${describeError(e)}`);
      return false;
    }
    if (!ok) log.warn(`match: ${acc} is held by another app; ${what} is off this match`);
    return ok;
  };
  const unbind = (acc: string): void => {
    try {
      opts.shortcuts?.unregister(acc);
    } catch {
      /* already gone */
    }
  };
  /** D8.10: the menu's two keys as they were registered (the settings may change under a match). */
  let menuKeysHeld: string[] = [];
  let menuKeyProblem: string | null = null;
  const registerMenuKeys = (): void => {
    const taken: string[] = [];
    if (bind(settings.menuKey, 'the menu key', () => onMenuKey())) menuKeysHeld.push(settings.menuKey);
    else taken.push(shortcutWords(settings.menuKey));
    const choose = settings.menuChooseKey;
    if (choose !== null) {
      if (bind(choose, 'the choose key', () => pressMenu('choose'))) menuKeysHeld.push(choose);
      else taken.push(shortcutWords(choose));
    }
    menuKeyProblem = taken.length > 0 ? `${taken.join(' and ')} could not be taken (another program holds ${taken.length > 1 ? 'them' : 'it'}): choose another key` : null;
    log.info(`match: menu key ${shortcutWords(settings.menuKey)}${choose !== null ? `, choose key ${shortcutWords(choose)}` : ''}${menuKeyProblem ? ` (${menuKeyProblem})` : ''}`);
  };
  const unregisterMenuKeys = (): void => {
    for (const acc of menuKeysHeld) unbind(acc);
    menuKeysHeld = [];
    menuKeyProblem = null;
  };
  const registerKeys = (): void => {
    if (!opts.shortcuts || keysHeld) return;
    keysHeld = true;
    bind(VOLUME_SHORTCUTS.voiceUp, 'that volume key', () => nudge('voiceVolume', VOLUME_STEP, VOLUME_SHORTCUTS.voiceUp));
    bind(VOLUME_SHORTCUTS.voiceDown, 'that volume key', () => nudge('voiceVolume', -VOLUME_STEP, VOLUME_SHORTCUTS.voiceDown));
    bind(VOLUME_SHORTCUTS.tableUp, 'that volume key', () => nudge('myTableWhileUp', VOLUME_STEP, VOLUME_SHORTCUTS.tableUp));
    bind(VOLUME_SHORTCUTS.tableDown, 'that volume key', () => nudge('myTableWhileUp', -VOLUME_STEP, VOLUME_SHORTCUTS.tableDown));
    log.info('match: volume keys on while the match runs: Ctrl+Alt+Up / Down the voice, Ctrl+Alt+Left / Right my table while I play');
    registerMenuKeys();
  };
  const unregisterKeys = (): void => {
    if (!keysHeld) return;
    keysHeld = false;
    for (const acc of Object.values(VOLUME_SHORTCUTS)) unbind(acc);
    unregisterMenuKeys();
    holdArrows(false);
  };

  // ---- D8.10 (2026-11-14): the in-game menu (match/match-menu.ts) ----
  let menu: MenuState = MENU_CLOSED;
  /** The menu key's last press, and the menu as it was before that press moved it (a quick second press chooses there). */
  let menuKeyAt: number | null = null;
  let menuBefore: MenuState | null = null;
  let menuTimer: ReturnType<typeof setTimeout> | null = null;
  let arrowsHeld = false;
  let menuSent = 'null';
  const menuFacts = (a: Active): MenuFacts => {
    const st = a.controller.status();
    return {
      role: a.controller.currentRole instanceof HostMatch ? 'host' : 'client',
      phase: st.phase,
      players: st.participants.length,
      startWarnings: st.startWarnings,
      seriesOver: st.series.over,
      nextGameBlocker: st.series.nextGameBlocker,
      voice: settings.voiceVolume,
      theirTable: settings.othersTableVolume,
      myTable: settings.myTableWhileUp,
      mic: st.panel.mic,
      scoreboardPlace: scoreboardPlaceFact(a),
    };
  };
  const menuHint = (): string => {
    const key = shortcutWords(settings.menuKey);
    const choose = settings.menuChooseKey !== null ? `${shortcutWords(settings.menuChooseKey)}, or ${key} twice quickly` : `${key} twice quickly`;
    return `${key}: next line · ${choose}: choose · the arrow keys work too`;
  };
  /** The menu as it is now to the panel page; only when it changed (a status emit calls this often). */
  const pushMenu = (): void => {
    const view = active ? menuView(menu, menuItems(menuFacts(active)), menuHint()) : null;
    const text = JSON.stringify(view);
    if (text === menuSent) return;
    menuSent = text;
    opts.media?.setMenu?.(view);
  };
  const holdArrows = (on: boolean): void => {
    if (on === arrowsHeld) return;
    arrowsHeld = on;
    for (const [acc, key] of Object.entries(MENU_ARROWS)) {
      if (on) bind(acc, 'that arrow in the menu', () => pressMenu(key));
      else unbind(acc);
    }
  };
  const closeMenu = (): void => {
    if (menuTimer) clearTimeout(menuTimer);
    menuTimer = null;
    menu = MENU_CLOSED;
    menuKeyAt = null;
    menuBefore = null;
    holdArrows(false);
  };
  const armMenuTimer = (): void => {
    if (menuTimer) clearTimeout(menuTimer);
    menuTimer = setTimeout(() => {
      menuTimer = null;
      if (!menu.open) return;
      closeMenu();
      log.info('match: menu closed (no key for a while)');
      emit();
    }, MENU_IDLE_MS);
  };
  const runMenuEffect = (effect: MenuEffect): void => {
    // A refusal (the lobby is not complete, no next game yet) comes back onto the menu, on the line that asked.
    const refused =
      (at: 'start' | 'next') =>
      (e: unknown): void => {
        if (!active) return;
        menu = { open: true, at, confirming: null, note: describeError(e) };
        holdArrows(true);
        armMenuTimer();
        emit();
      };
    switch (effect.kind) {
      case 'start':
        log.info(`match: Start match chosen in the menu${effect.anyway ? ' (anyway)' : ''}`);
        void api.start({ anyway: effect.anyway }).catch(refused('start'));
        return;
      case 'next':
        log.info('match: Next game chosen in the menu');
        void api.start().catch(refused('next'));
        return;
      case 'volume': {
        const key = effect.which === 'voice' ? 'voiceVolume' : effect.which === 'theirTable' ? 'othersTableVolume' : 'myTableWhileUp';
        saveSettings(patchMatchSettings(settings, { [key]: effect.to }));
        log.info(`match: ${effect.which === 'voice' ? 'voice volume' : effect.which === 'theirTable' ? 'their table sound' : 'my table while I play'} ${settings[key]} % (menu)`);
        pushVolume();
        return;
      }
      case 'mic':
        log.info(`match: microphone ${effect.muted ? 'muted' : 'on'} (menu)`);
        api.setMuted(effect.muted);
        return;
      case 'placeScoreboard': {
        // D8.12.3: the layer captures the place from the head's pose at its next frame.
        const did = active?.overlay?.placeScoreboard?.() ?? 'not_connected';
        if (did === 'placed') log.info('match: the scoreboard is placed again where the player looks (menu)');
        else log.warn(`match: the scoreboard was not placed again from the menu (${did})`);
        return;
      }
      case 'leave':
        log.info('match: Leave chosen in the menu');
        void api.leave().catch((e: unknown) => log.warn(`match: leave from the menu: ${describeError(e)}`));
        return;
    }
  };
  const pressMenu = (key: MenuKey): void => {
    const a = active;
    if (!a) return;
    const facts = menuFacts(a);
    const wasOpen = menu.open;
    const r = menuPress(menu, menuItems(facts), facts, key);
    if (r.state === menu && r.effect === null) return;
    menu = r.state;
    if (menu.open) {
      if (!wasOpen) {
        log.info('match: menu opened');
        // A desktop rig: the panel window comes up if it was put away (focus stays with VPX).
        if (!headsetPanel(a)) opts.media?.showPanel();
      }
      holdArrows(true);
      armMenuTimer();
    } else {
      closeMenu();
      if (wasOpen) log.info('match: menu closed');
    }
    cue.play('tick');
    if (r.effect) runMenuEffect(r.effect);
    emit();
  };
  /** The menu key: open, then next line; twice quickly: choose the line the first press left (`readMenuKey`). */
  const onMenuKey = (): void => {
    const now = clock();
    const read = readMenuKey(menuKeyAt === null ? null : now - menuKeyAt);
    menuKeyAt = now;
    if (read === 'repeat') return;
    if (read === 'double' && menuBefore?.open && menu.open) {
      menu = menuBefore;
      menuBefore = null;
      menuKeyAt = null;
      pressMenu('choose');
      return;
    }
    menuBefore = menu;
    pressMenu('menu');
  };

  /** §3 / coordinator 2026-10-30: the panel goes up at host / join, before the match starts, of the kind decided then. */
  const openPanel = async (a: Active): Promise<void> => {
    // D2.8: the helper starts with the match, so "table sound unavailable" shows before the first ball.
    opts.tableAudio?.start();
    // D10.3: the native video helper and this match's mesh, before the media attaches (it asks the camera with the ring).
    openVideo(a);
    // I11.4.2: the state stream's data connections open now, in the lobby (a connect took 10 to 70 s on 2026-11-18).
    openStream(a);
    // D2.10: the volume keys live as long as the match.
    registerKeys();
    await opts.media?.setVr?.(mediaRig(a));
    await a.controller.open();
    if (headsetPanel(a)) await startOverlay(a);
    else opts.media?.showPanel();
  };

  /**
   * A6 (2026-10-31): the desktop panel moves into the headset when the witness reads VR after host / join. D7.3: on any
   * runtime (the OpenXR layer off SteamVR), and a later reading on a runtime that needs the other overlay swaps them.
   */
  const switchToVr = async (a: Active, d: RigDecision): Promise<void> => {
    if (a.switching) return;
    if (a.rig === 'vr_headset' && !overlayChanges(a, d)) return;
    a.switching = true;
    const was = a.overlay;
    a.rig = 'vr_headset';
    a.runtime = d.runtime;
    a.rigReason = `switched after ${a.role === 'host' ? 'hosting' : 'joining'}: ${d.reason}`;
    log.info(`match: rig vr_headset (${a.rigReason})`);
    // A6.1 (2026-11-01): the others are told in any phase, before the panel moves (the owner's rig read VR 7 s after
    // Start, and the roster said pc all match). The table is the lobby refresh's to announce, not this.
    if (active === a) announceLobby(a, a.rig, a.sent.game);
    emit();
    if (was) {
      a.overlay = null;
      log.info(`match: VPX's VR runtime is ${d.runtime ?? 'unknown'} now; the panel moves to ${usesLayer(a) ? 'the OpenXR layer' : 'the SteamVR overlay'}`);
      await was.stop().catch((e: unknown) => log.warn(`match: overlay stop: ${describeError(e)}`));
    }
    try {
      await opts.media?.setVr?.(mediaRig(a));
    } catch (e) {
      log.warn(`match: the panel did not move into the headset: ${describeError(e)}`);
    }
    a.switching = false;
    if (active !== a) return;
    await startOverlay(a);
    emit();
  };

  /** The rig at host / join, logged with its evidence; a failing probe never stops a match (the monitor is assumed). */
  const decide = async (): Promise<RigDecision> => {
    const d = await (opts.rig ?? (() => decideRig(witness)))().catch((e: unknown): RigDecision => ({ rig: 'pc', reason: `the VR probe failed (${describeError(e)}); monitor assumed`, runtime: null }));
    log.info(`match: rig ${d.rig}${d.runtime ? ` via ${d.runtime}` : ''} (${d.reason})`);
    return d;
  };

  // ---- A6 (2026-10-31): the lobby refresh of the rig and the table ----
  // The rig and fingerprint go out once in HELLO (or the host's roster entry). A player who joins or hosts before its
  // table loads says `pc` and no table; until MATCH_READY, a table load or a new VR sample re-decides both and tells
  // the others (PARTICIPANT_UPDATE from a client, a re-sent HELLO_ACK from the host). The rig only moves towards the
  // headset, as the A6 switch does: a monitor reading after a VR one keeps the headset (`switchToVr` is one-way).
  const inLobby = (a: Active): boolean => active === a && a.engine.state.phase === 'lobby';
  const checkLobby = (a: Active, s: WitnessStatus): void => {
    if (!inLobby(a)) return;
    const k = lobbyKey(s);
    if (k === a.lobbyKey) return;
    a.lobbyKey = k;
    void refreshLobby(a);
  };
  const refreshLobby = async (a: Active): Promise<void> => {
    if (a.refreshing) {
      a.refreshAgain = true;
      return;
    }
    a.refreshing = true;
    try {
      do {
        a.refreshAgain = false;
        const d = await decide();
        if (!inLobby(a)) return;
        // Only the first move into VR: a runtime swap (SteamVR <-> an OpenXR runtime) is the status listener's job, and
        // re-deciding here could swap it straight back (merge of D2.4 + D7.3, 2026-10-31: the media layer was told twice).
        if (d.rig === 'vr_headset' && a.rig === 'pc') await switchToVr(a, d);
        if (!inLobby(a)) return;
        announceLobby(a, a.rig, gameFingerprintFrom(witness.status(), RECIPE_VERSION));
      } while (a.refreshAgain);
    } catch (e) {
      log.warn(`match: the lobby update failed: ${describeError(e)}`);
    } finally {
      a.refreshing = false;
    }
  };
  /**
   * Tells the others what changed since they were last told. A6.1 (2026-11-01): in any phase; after MATCH_READY the
   * engines carry only the rig (a table change then is not sent, and `sent.game` keeps what was). The role in charge
   * now (`currentRole`): after a host transfer `a.engine` is the role that stepped down.
   */
  const announceLobby = (a: Active, rig: Rig, game: GameFingerprint): void => {
    const role = a.controller.currentRole as HostMatch | ClientMatch;
    const lobby = role.state.phase === 'lobby';
    const rigChanged = rig !== a.sent.rig;
    const gameChanged = lobby && JSON.stringify(game) !== JSON.stringify(a.sent.game);
    // A13: whether this table can report ball ends, when the witness knows (no table open: nothing new to say).
    const ballEnds = ballEndsFrom(witness.status()).ready;
    const readyChanged = lobby && ballEnds !== null && ballEnds !== a.sent.ballEnds;
    if (!rigChanged && !gameChanged && !readyChanged) return;
    const u = { ...(rigChanged ? { rig } : {}), ...(gameChanged ? { game } : {}), ...(readyChanged ? { ballEndReady: ballEnds } : {}) };
    let done: boolean;
    try {
      done = role instanceof HostMatch ? role.updateLocal(u) : role.updateParticipant(u);
    } catch (e) {
      log.warn(`match: the rig update did not go out: ${describeError(e)}`);
      return;
    }
    a.sent = { rig, game: gameChanged ? game : a.sent.game, ballEnds: readyChanged ? ballEnds : a.sent.ballEnds };
    if (!done) return;
    const what = [
      rigChanged ? `rig ${rig}` : null,
      gameChanged ? `table ${game.tableName} (${game.tableHash === ZERO_SHA256 ? 'no hash' : game.tableHash.slice(0, 12)})` : null,
      readyChanged ? (ballEnds ? 'the table can report ball ends' : 'the table cannot report ball ends') : null,
    ]
      .filter(Boolean)
      .join(', ');
    log.info(`match: ${lobby ? 'lobby' : 'match'} update: ${what}; ${role instanceof HostMatch ? 'the players were told' : 'the host was told'}`);
    emit();
  };

  const participant = (id: string, name: string, rig: Rig): ParticipantInfo => ({
    playerId: id,
    displayName: name,
    publicKey: matchIdentity().keys.publicKeyB64,
    rig,
  });

  const guard = async (fn: () => Promise<MatchStatus>): Promise<MatchStatus> => {
    if (busy) throw new Error('Castcade is still working on the last match request');
    busy = true;
    try {
      return await fn();
    } finally {
      busy = false;
    }
  };

  /**
   * D7.6: ends the bench (Stop, a match starting, quit): VPX's own view first (theater off, the control given a moment
   * to reach the layer), then the layer's pipe and the panel. Never throws.
   */
  const endBench = async (why: string): Promise<void> => {
    const b = bench;
    if (!b) return;
    bench = null;
    if (b.overlay) {
      b.overlay.setMode('hidden');
      await new Promise<void>((r) => setTimeout(r, BENCH_HIDE_MS));
      await b.overlay.stop().catch((e: unknown) => log.warn(`bench: layer stop: ${describeError(e)}`));
    }
    await opts.media?.stopBench?.().catch((e: unknown) => log.warn(`bench: media stop: ${describeError(e)}`));
    log.info(`bench: stopped (${why})${b.overlay ? "; VPX's own view is back" : ''}`);
    emit();
  };
  const startBench = (raw: unknown): Promise<MatchStatus> =>
    guard(async () => {
      const step = benchStep(bench ? bench.state : 'off', { kind: 'start', matchOn: !!active || connecting });
      if (step.refuse) return fail(new Error(step.refuse));
      const media = opts.media;
      if (!media?.startBench || !media.stopBench) return fail(new Error('The media layer is not running in this build: no test bench'));
      const req = benchRequestFrom(raw);
      if (typeof req === 'string') return fail(new Error(req));
      lastError = null;
      const d = await decide();
      const layer = usesLayer(d) && opts.vrLayer ? opts.vrLayer : null;
      if (req.source === 'live') {
        const why = liveRefusal(d.rig, d.runtime, !!opts.vrLayer);
        if (why) return fail(new Error(why));
      }
      const clipDir = req.clip ? join(framesRoot(), req.clip.name) : null;
      const clip = req.clip && clipDir ? loadClip(clipDir, req.clip.side) : null;
      if (req.source === 'clip' && !clip) return fail(new Error(`The saved clip ${req.clip?.name ?? ''} has no ${req.clip?.side === 'receiver' ? 'received' : 'eye'} frames to play`));
      const b: Bench = { state: 'starting', source: req.source, path: req.path, clip: req.clip ? `${req.clip.name} (${req.clip.side === 'receiver' ? 'received frames' : 'eye frames'})` : null, overlay: null, view: 'theater' };
      bench = b;
      emit();
      try {
        await media.startBench({ source: req.source, path: req.path, clip, clipDir, clipName: req.clip?.name ?? null, inVr: d.rig === 'vr_headset', headsetPanel: !!layer, bitrate: req.bitrate });
      } catch (e) {
        bench = null;
        return fail(e);
      }
      if (layer) {
        const frames = media.frames();
        if (frames) {
          b.overlay = layer;
          syncWindowTune(layer);
          layer.setMode('theater');
          try {
            const st = await layer.start(frames, media.videoFrames?.() ?? null);
            log.info(`bench: the OpenXR layer ${st.state}${st.reason ? ` (${st.reason})` : ''}, theater at Theater size ${settings.theaterScale}${windowTuneWords(settings)}`);
          } catch (e) {
            log.warn(`bench: the OpenXR layer did not start: ${describeError(e)}`);
          }
        }
      } else media.showPanel();
      if (bench !== b) return status();
      b.state = benchStep(b.state, { kind: 'started' }).state;
      // D7.5.9: the camera's view when the source is the layer camera; D7.5.10 / D7.5.11: the tuning when not the defaults.
      const view = b.source === 'live' ? `; ${settings.cameraView} view` : '';
      log.info(`bench: running (${d.rig}${d.runtime ? ` via ${d.runtime}` : ''}; ${b.overlay ? 'theater in the headset' : 'the desktop panel'}${view}${windowTuneWords(settings)})`);
      emit();
      return status();
    });

  const host = (o: { port?: number; ballsPerGame: 3 | 5; displayName: string }): Promise<MatchStatus> =>
    guard(async () => {
      if (active) return fail(new Error('Leave the current match first'));
      forget('another match is hosted');
      await endBench('a match is hosted');
      lastError = null;
      const asked = o.port === 0 && opts.ephemeralPort ? 0 : o.port === undefined ? settings.port : cleanPort(o.port);
      if (asked === null) return fail(new Error('The port must be a number from 1024 to 65535'));
      let port = asked;
      const ballsPerGame = o.ballsPerGame === 5 ? 5 : 3;
      const name = cleanName(o.displayName) ?? defaultName();
      saveSettings(patchMatchSettings(settings, { port, ballsPerGame, displayName: name }));
      const me = playerId();
      // D10.8: paired → the connection to ArcAid opens beside the rig probe and the address lookup, so it adds no wait.
      const creds = opts.relay?.() ?? null;
      let relay = creds ? relayHost(me, creds) : null;
      let relayNote: string | null = opts.relay && !creds ? 'This PC is not paired with ArcAid' : null;
      const relayUp: Promise<unknown> = relay ? relay.connect().then(() => null, (e: unknown) => e) : Promise.resolve(null);
      // A8 (2026-10-31): the rig and the public address first, the listener last (module header).
      const [rig, pub, relayDown] = await Promise.all([decide(), (opts.publicIp ?? ipifyPublicIp)().catch(() => null), relayUp]);
      let code = newMatchCode();
      // The room is registered before the engine exists (the match id is the code, and a code in use is replaced);
      // nobody can join it yet: the invite is published last.
      let relayError: unknown = relayDown;
      for (let k = 1; relay && relayError === null; k++) {
        try {
          await relay.host(code);
          break;
        } catch (e) {
          if (e instanceof RelayError && e.code === 'code_in_use' && k < RELAY_CODE_TRIES) code = newMatchCode();
          else relayError = e;
        }
      }
      if (relay && relayError !== null) {
        relay.close();
        relay = null;
        // The refusal comes from the ack of `match:host` (ArcAid checks the device there, not at connect).
        relayNote = relayHostNote(relayError instanceof RelayError ? relayError.code : null);
        log.warn(`match: ArcAid is not carrying this match (${relayError instanceof Error ? relayError.message : String(relayError)}); hosting on the listener only`);
      }
      const listener = new WsPeerTransport({ localId: me });
      const transport = new CompositeTransport(relay ? [listener, relay] : [listener]);
      const ws = witness.status();
      const game = gameFingerprintFrom(ws, RECIPE_VERSION);
      const ballEnds = ballEndsFrom(ws).ready;
      const engine = new HostMatch({
        transport,
        keys: matchIdentity().keys,
        matchId: code,
        ballsPerGame,
        hostParticipant: participant(me, name, rig.rig),
        hostGame: game,
        // §3: a different table file is shown on both panels, never refused (the client learns it from HELLO_ACK).
        fingerprintPolicy: 'advise',
        companionVersion: opts.appVersion.slice(0, 32),
        // A11: who is still loading, and whether the start from this host's table may go.
        tableOpen: isTableOpen,
        // A13: whether this host's own table can report ball ends, when a table is open.
        ...(ballEnds !== null ? { ballEndReady: ballEnds } : {}),
        disconnectGraceMs: opts.disconnectGraceMs,
      });
      const controller = makeController(engine, ballsPerGame);
      const a: Active = {
        role: 'host',
        transport,
        ws: listener,
        via: relay ? 'relay' : 'direct',
        where: null,
        relay,
        relayNote,
        directInvite: null,
        portMapping: null,
        mapping: null,
        renewTimer: null,
        engine,
        controller,
        code,
        port,
        invite: null,
        ipSource: null,
        overlay: null,
        vrMode: null,
        ...rigOf(rig),
        witnessRig: rigFrom(witness.status()),
        switching: false,
        sent: { rig: rig.rig, game, ballEnds },
        lobbyKey: lobbyKey(ws),
        refreshing: false,
        refreshAgain: false,
        endTimer: null,
        offs: [],
        video: null,
        theater: THEATER_ON_RING,
        theaterTimer: null,
        ...tracking(null, null),
      };
      a.offs.push(transport.onError((err, peer) => log.warn(`match: socket ${peer ?? '(new)'}: ${err.message}`)));
      watchPlayers(a, engine);
      if (relay) {
        a.offs.push(
          relay.onState((st) => {
            if (active !== a) return;
            if (st === 'reconnecting') log.warn('match: ArcAid is not carrying this match for the moment (the connection dropped, or ArcAid restarted); taking it back (players who came through ArcAid resume when it is back)');
            else if (st === 'registered') log.info(`match: ArcAid carries ${code} again`);
            else if (st === 'closed') log.warn(`match: ArcAid closed ${code} and it cannot be opened again; players who came through ArcAid are out`);
            emit();
          }),
        );
      }
      active = a;
      followLog(a);
      await openPanel(a);
      let listening = true;
      try {
        const endpoint = await listener.listen(port, opts.listenAddress ?? '0.0.0.0');
        if (port === 0) {
          port = Number(new URL(endpoint).port);
          a.port = port;
        }
      } catch (e) {
        const errno = (e as NodeJS.ErrnoException).code;
        const why = errno === 'EADDRINUSE' ? `Port ${port} is already in use on this PC` : `Could not listen on port ${port}: ${describeError(e)}`;
        if (!relay) {
          await teardown(a);
          return fail(new Error(errno === 'EADDRINUSE' ? `${why}: pick another port` : why));
        }
        // D10.8: the relay room is up; the match needs no listener.
        listening = false;
        a.port = null;
        log.warn(`match: ${why}; this match goes through ArcAid only`);
      }
      const ip = pub ?? pickLanAddress(networkInterfaces()) ?? '127.0.0.1';
      const address = listening ? formatInvite(ip, port, code) : null;
      a.ipSource = listening ? (pub ? 'public' : 'lan') : null;
      if (relay) {
        a.invite = code;
        a.directInvite = address;
        log.info(`match: hosting ${code} through ArcAid${listening ? ` and on ${listener.endpoint ?? `port ${port}`}` : ''} (${ballsPerGame} balls); the invite is the code`);
      } else {
        a.invite = address;
        a.where = `${ip.includes(':') ? `[${ip}]` : ip}:${port}`;
        log.info(`match: hosting ${code} on ${listener.endpoint ?? `port ${port}`} (${ballsPerGame} balls); invite ${a.invite} (${a.ipSource} address)${relayNote ? `; ${relayNote}` : ''}`);
        // D10.8: the router is asked for the port in the background; the invite does not wait for it.
        mapPort(a, port, pub, creds !== null);
      }
      // The table may have loaded while hosting (A6, 2026-10-31).
      checkLobby(a, witness.status());
      emit();
      return status();
    });

  // ---- D10.8: the relay and the router port ----
  const relayHost = (me: string, c: { baseUrl: string; deviceId: string; deviceToken: string }): RelayHostTransport =>
    new RelayHostTransport({ localId: me, baseUrl: c.baseUrl, auth: { deviceId: c.deviceId, deviceToken: c.deviceToken }, connectTimeoutMs: opts.relayTimeouts?.connectMs, ackTimeoutMs: opts.relayTimeouts?.ackMs });

  /**
   * A direct host with no relay: ask the router to forward the port (UPnP, 3 s inside `openPort`), in the background.
   * The Match tab shows `trying`, then what came of it; a mapping is renewed at half its lease and removed in
   * `teardown`. One that arrives after the match is gone is removed at once.
   */
  const mapPort = (a: Active, port: number, publicIp: string | null, paired: boolean): void => {
    const run = opts.openPort === undefined ? (p: number) => openPort({ port: p }) : opts.openPort;
    if (!run) return;
    a.portMapping = { state: 'trying', line: 'Asking your router to open the port…' };
    void run(port)
      .catch((e: unknown): PortMapResult => ({ ok: false, reason: describeError(e) }))
      .then((r) => {
        if (active !== a) {
          if (r.ok) void r.mapping.remove();
          return;
        }
        a.portMapping = portMappingLine(r, port, publicIp, paired);
        if (r.ok) {
          const m = r.mapping;
          a.mapping = m;
          const lease = m.leaseSeconds > 0 ? `leased ${m.leaseSeconds} s, renewed while hosting` : 'the router only takes permanent mappings; removed when the match ends';
          log.info(`match: the router at ${m.gateway} forwards TCP ${port} to this PC (${lease})${a.portMapping.state === 'opened' ? '' : '; but the router is behind another NAT, so the port is not reachable from outside'}`);
          if (m.leaseSeconds > 0) {
            a.renewTimer = setInterval(
              () => {
                void m.renew().then((ok) => {
                  if (!ok) log.warn(`match: the router did not renew the mapping of TCP ${port}`);
                });
              },
              (m.leaseSeconds * 1000) / 2,
            );
          }
        } else {
          log.info(`match: the router did not open TCP ${port}: ${r.reason}`);
        }
        emit();
      });
  };

  /** D10.8: the transport of a join and how it connects, by the kind of invite. Throws on a code invite while not paired. */
  const linkFor = (invite: Invite, me: string): { transport: MatchTransport; connect: () => Promise<void>; failure: (e: unknown) => Error } => {
    if (invite.via === 'direct') {
      const t = new WsPeerTransport({ localId: me });
      return {
        transport: t,
        connect: () => withTimeout(t.connect(invite.url), CONNECT_TIMEOUT_MS, `Could not reach the host at ${invite.host}:${invite.port}`),
        failure: (e) => new Error(`${describeError(e)}. Check the invite, and that the host forwarded the TCP port to their PC (a host paired with ArcAid needs no port forward: its invite is six letters).`, { cause: e }),
      };
    }
    const c = opts.relay?.() ?? null;
    if (!c) throw new Error(RELAY_NOT_PAIRED);
    const t = new RelayClientTransport({ localId: me, baseUrl: c.baseUrl, auth: { deviceId: c.deviceId, deviceToken: c.deviceToken }, connectTimeoutMs: opts.relayTimeouts?.connectMs, ackTimeoutMs: opts.relayTimeouts?.ackMs, rejoin: opts.relayRejoin ?? HOST_WAIT_REJOIN });
    return {
      transport: t,
      connect: () => t.connect(invite.code),
      failure: (e) => new Error(relayJoinFailure(e instanceof RelayError ? e.code : null, invite.code, e instanceof Error ? e.message : String(e)), { cause: e }),
    };
  };

  type JoinOutcome = { kind: 'joined'; transport: MatchTransport; engine: ClientMatch; controller: MatchController } | { kind: 'refused'; refuse: PayloadOf<'REFUSE'> };

  const tryJoin = async (invite: Invite, me: string, name: string, rig: Rig, game: ReturnType<typeof gameFingerprintFrom>, ballEnds: boolean | null): Promise<JoinOutcome> => {
    const code = invite.code;
    const { transport, connect, failure } = linkFor(invite, me);
    const engine = new ClientMatch({
      transport,
      keys: matchIdentity().keys,
      participant: participant(me, name, rig),
      game,
      throwdownCode: code,
      companionVersion: opts.appVersion.slice(0, 32),
      // A13: whether this table can report ball ends, when a table is open (HELLO.ballEndReady).
      ...(ballEnds !== null ? { ballEndReady: ballEnds } : {}),
      ...clientLink,
    });
    // Built before HELLO so it sees HELLO_ACK's roster.
    const controller = makeController(engine);
    const offs: (() => void)[] = [];
    const answer = new Promise<'joined' | PayloadOf<'REFUSE'>>((resolve) => {
      offs.push(engine.on('joined', () => resolve('joined')));
      offs.push(engine.on('refused', (r) => resolve(r)));
      // A17 (2026-11-24): a host on another protocol version, whose answer this PC cannot decode (a host up to 0.2.50
      // answers in its own version): the sentence now, in place of "The host did not answer" ten seconds later.
      offs.push(transport.onError((e) => void (e instanceof ForeignVersionError && resolve({ code: 'protocol_version', message: e.message, mismatches: [] }))));
    });
    const cleanup = async (): Promise<void> => {
      await controller.close();
      engine.close();
      transport.close();
    };
    try {
      await connect();
      engine.join();
      const r = await withTimeout(answer, JOIN_TIMEOUT_MS, 'The host did not answer');
      if (r !== 'joined') {
        await cleanup();
        return { kind: 'refused', refuse: r };
      }
      return { kind: 'joined', transport, engine, controller };
    } catch (e) {
      await cleanup();
      throw failure(e);
    } finally {
      for (const off of offs) off();
    }
  };

  const joinMatch = (invite: string, displayName: string): Promise<MatchStatus> =>
    guard(async () => {
      if (active) return fail(new Error('Leave the current match first'));
      forget('another match is joined');
      await endBench('a match is joined');
      lastError = null;
      let parsed: Invite;
      try {
        parsed = parseInvite(invite);
      } catch (e) {
        return fail(e);
      }
      const name = cleanName(displayName) ?? defaultName();
      saveSettings(patchMatchSettings(settings, { displayName: name }));
      const me = playerId();
      connecting = true;
      emit();
      try {
        const rig = await decide();
        const ws = witness.status();
        const game = gameFingerprintFrom(ws, RECIPE_VERSION);
        const ballEnds = ballEndsFrom(ws).ready;
        const out = await tryJoin(parsed, me, name, rig.rig, game, ballEnds);
        if (out.kind === 'refused') throw new Error(`The host refused: ${out.refuse.message}`);
        const differs = out.controller.status().tableMismatch.includes(me);
        if (differs) log.warn("match: the host's table file differs from this one; joined anyway, flagged on both panels");
        const a = clientActive(parsed, out, rig, game, ballEnds, ws, invite.trim(), null);
        active = a;
        connecting = false;
        followLog(a);
        watchHost(a, out.engine);
        log.info(`match: joined ${parsed.code} ${parsed.via === 'relay' ? 'through ArcAid' : `at ${parsed.url}`}`);
        await openPanel(a);
        // The table may have loaded while joining (A6, 2026-10-31).
        checkLobby(a, witness.status());
        emit();
        return status();
      } catch (e) {
        connecting = false;
        return fail(e);
      }
    });

  /** A client's `Active`, from a join or (A15, `rec`) a rejoin. */
  const clientActive = (
    parsed: Invite,
    out: { transport: MatchTransport; engine: ClientMatch; controller: MatchController },
    rig: RigDecision,
    game: GameFingerprint,
    ballEnds: boolean | null,
    ws: WitnessStatus,
    invite: string,
    rec: ResumeRecord | null,
  ): Active => {
    const a: Active = {
      role: 'client',
      transport: out.transport,
      ws: null,
      via: parsed.via,
      where: parsed.via === 'direct' ? `${parsed.host}:${parsed.port}` : null,
      relay: null,
      relayNote: null,
      directInvite: null,
      portMapping: null,
      mapping: null,
      renewTimer: null,
      engine: out.engine,
      controller: out.controller,
      code: parsed.code,
      port: parsed.via === 'direct' ? parsed.port : null,
      invite: null,
      ipSource: null,
      overlay: null,
      vrMode: null,
      ...rigOf(rig),
      witnessRig: rigFrom(witness.status()),
      switching: false,
      sent: { rig: rig.rig, game, ballEnds },
      lobbyKey: lobbyKey(ws),
      refreshing: false,
      refreshAgain: false,
      endTimer: null,
      offs: [],
      video: null,
      theater: THEATER_ON_RING,
      theaterTimer: null,
      ...tracking(invite, rec),
    };
    a.offs.push(
      out.transport.onError((err) => {
        log.warn(`match: socket: ${err.message}`);
        // D10.8: a pairing revoked mid-match is final (ArcAid took the seat): the tab says so, in those words.
        if (err instanceof RelayError && err.code === 'unauthorized' && active === a) {
          lastError = `${err.message}: pair it again in Settings. This match cannot be resumed through ArcAid.`;
          emit();
        }
      }),
    );
    return a;
  };

  // ---- A15: back into the saved match ----
  const rejoinClient = async (rec: ResumeRecord, saved: MatchLog, st0: MatchState, meInfo: ParticipantInfo, rig: RigDecision): Promise<Active> => {
    const parsed = parseInvite(rec.invite ?? '');
    const hostId = st0.hostId;
    if (!hostId) throw new Error('The saved match names no host');
    const { transport, connect, failure } = linkFor(parsed, rec.playerId);
    const ws = witness.status();
    const game = gameFingerprintFrom(ws, RECIPE_VERSION);
    // The counter of the last run is lost; the wall clock is above anything it reached (Session.seqStart).
    const session = new Session({ transport, keys: matchIdentity().keys, log: saved, seqStart: Date.now() });
    const engine = ClientMatch.adopt(session, { participant: meInfo, game, throwdownCode: rec.code, companionVersion: opts.appVersion.slice(0, 32), ...clientLink });
    const controller = makeController(engine, undefined, true);
    const offs: (() => void)[] = [];
    const answer = new Promise<{ ok: true } | { ok: false; code: string | null }>((resolve, reject) => {
      offs.push(engine.on('reconnected', () => resolve({ ok: true })));
      offs.push(engine.on('reconnectRejected', (r) => resolve({ ok: false, code: r.code })));
      // A17 (2026-11-24): the host answers in another protocol version: said at once, and the saved match is kept
      // (the same version on both PCs, and Rejoin works again).
      offs.push(transport.onError((e) => void (e instanceof ForeignVersionError && reject(e))));
    });
    const cleanup = async (): Promise<void> => {
      await controller.close();
      engine.close();
      transport.close();
    };
    let r: Awaited<typeof answer>;
    try {
      // Through ArcAid the room is joined first; either way the first frame is RECONNECT from the saved log's head.
      if (parsed.via === 'relay') await connect().catch((e: unknown) => Promise.reject(failure(e)));
      engine.relinkTo(hostId, parsed.via === 'direct' ? { endpoint: parsed.url } : {});
      r = await withTimeout(answer, opts.rejoinTimeoutMs ?? REJOIN_TIMEOUT_MS, `The host of ${rec.code} did not answer`);
    } catch (e) {
      await cleanup();
      if (e instanceof ForeignVersionError) throw e;
      throw new Error(`${describeError(e)}. The match may be over, or its host away for the moment: Rejoin tries again, Forget it drops it.`, { cause: e });
    } finally {
      for (const off of offs) off();
    }
    if (!r.ok) {
      await cleanup();
      forget(`the host refused the reconnect (${r.code ?? '?'})`);
      throw new Error(`The host did not take this PC back into the match ${rec.code}${r.code ? ` (${r.code.replace(/_/g, ' ')})` : ''}.`);
    }
    const a = clientActive(parsed, { transport, engine, controller }, rig, game, ballEndsFrom(ws).ready, ws, rec.invite ?? '', rec);
    return a;
  };

  const rejoinHost = async (rec: ResumeRecord, saved: MatchLog, st0: MatchState, rig: RigDecision): Promise<Active> => {
    const me = rec.playerId;
    const code = rec.code;
    const creds = rec.relay ? (opts.relay?.() ?? null) : null;
    let relay = creds ? relayHost(me, creds) : null;
    let relayNote: string | null = rec.relay && !creds ? 'This PC is not paired with ArcAid' : null;
    if (relay) {
      try {
        await relay.connect();
        await relay.host(code);
      } catch (e) {
        relay.close();
        relay = null;
        relayNote = relayHostNote(e instanceof RelayError ? e.code : null);
        log.warn(`match: ArcAid is not carrying ${code} again (${describeError(e)})`);
      }
    }
    if (!relay && rec.port === null) throw new Error(`ArcAid is not carrying the match ${code} again, and it had no port of its own: the other players cannot come back to it`);
    const listener = new WsPeerTransport({ localId: me });
    const transport = new CompositeTransport(relay ? [listener, relay] : [listener]);
    const session = new Session({ transport, keys: matchIdentity().keys, log: saved, seqStart: Date.now() });
    const others = st0.participants.map((p) => p.playerId).filter((id) => id !== me);
    let engine: HostMatch;
    try {
      // Nobody is on a link yet: each player comes back with RECONNECT, as after any drop.
      engine = HostMatch.resumeFromLog(saved, { transport, keys: session.keys, session, gone: others, disconnectGraceMs: opts.disconnectGraceMs });
    } catch (e) {
      transport.close();
      throw e;
    }
    const controller = makeController(engine, st0.ballsPerGame, true);
    const ws = witness.status();
    const game = gameFingerprintFrom(ws, RECIPE_VERSION);
    const a: Active = {
      role: 'host',
      transport,
      ws: listener,
      via: relay ? 'relay' : 'direct',
      where: null,
      relay,
      relayNote,
      directInvite: null,
      portMapping: null,
      mapping: null,
      renewTimer: null,
      engine,
      controller,
      code,
      port: rec.port,
      invite: relay ? code : null,
      ipSource: null,
      overlay: null,
      vrMode: null,
      ...rigOf(rig),
      witnessRig: rigFrom(ws),
      switching: false,
      sent: { rig: rig.rig, game, ballEnds: ballEndsFrom(ws).ready },
      lobbyKey: lobbyKey(ws),
      refreshing: false,
      refreshAgain: false,
      endTimer: null,
      offs: [],
      video: null,
      theater: THEATER_ON_RING,
      theaterTimer: null,
      ...tracking(null, rec),
    };
    a.offs.push(transport.onError((err, peer) => log.warn(`match: socket ${peer ?? '(new)'}: ${err.message}`)));
    watchPlayers(a, engine);
    if (relay) {
      const room = relay;
      a.offs.push(room.onState(() => (active === a ? emit() : undefined)));
      // The room may be a new one, which knows no seats yet: the players get a minute to come back before it is locked again.
      const t = setTimeout(() => void room.lock().catch((e: unknown) => log.warn(`match: ArcAid did not lock ${code} against new joins: ${describeError(e)}`)), REHOST_LOCK_MS);
      (t as { unref?: () => void }).unref?.();
      a.offs.push(() => clearTimeout(t));
    }
    if (rec.port !== null) {
      try {
        await listener.listen(rec.port, opts.listenAddress ?? '0.0.0.0');
      } catch (e) {
        if (!relay) {
          await controller.close();
          engine.close();
          transport.close();
          throw new Error(`Could not listen on port ${rec.port} again (${describeError(e)}): the other players cannot come back`, { cause: e });
        }
        a.port = null;
        log.warn(`match: could not listen on port ${rec.port} again (${describeError(e)}); ${code} goes through ArcAid only`);
      }
    }
    return a;
  };

  const rejoin = (): Promise<MatchStatus> =>
    guard(async () => {
      if (active) return fail(new Error('Leave the current match first'));
      const rec = pendingResume;
      if (!rec || resumeFreshness(rec, Date.now()) === 'stale') {
        forget('it is too old to go back to');
        return fail(new Error('There is no match to rejoin any more'));
      }
      await endBench('a match is rejoined');
      lastError = null;
      let saved: MatchLog;
      let st0: MatchState;
      try {
        saved = MatchLog.fromJSON(rec.log);
        st0 = replayLog(saved);
      } catch (e) {
        forget('its saved log does not read');
        return fail(e);
      }
      const meInfo = st0.participants.find((p) => p.playerId === rec.playerId);
      if (!meInfo || meInfo.publicKey !== matchIdentity().keys.publicKeyB64 || st0.phase === 'lobby') {
        forget("it was not played with this PC's match keys");
        return fail(new Error("The saved match was not played with this PC's match keys: it cannot be rejoined"));
      }
      connecting = true;
      emit();
      try {
        const rig = await decide();
        const a = rec.role === 'client' ? await rejoinClient(rec, saved, st0, meInfo, rig) : await rejoinHost(rec, saved, st0, rig);
        pendingResume = null;
        pendingBacklog = null;
        pendingExit = false;
        active = a;
        connecting = false;
        followLog(a);
        if (a.engine instanceof ClientMatch) watchHost(a, a.engine);
        log.info(`match: back in ${rec.code} as ${rec.role === 'host' ? 'its host; waiting for the players to come back' : 'a player'} (${saved.length} log entries saved, ${a.engine.log.length} now)`);
        await openPanel(a);
        // A host: the outstanding grant goes out again (or the result, between games), as after a transfer.
        if (a.engine instanceof HostMatch) a.engine.runAfterRestart();
        tryReconcile(a);
        emit();
        return status();
      } catch (e) {
        connecting = false;
        return fail(e);
      }
    });

  /**
   * A17 step 2 (2026-11-24, alpha-match.md §11.6): **what ends with a match.** The saved match (A15: its record, the
   * hook that saves every log entry, the record's heartbeat; `keep`: the record stays for a restart), a client's
   * linger after the series (A10), what the table said that this match's log never answered and the journal mark
   * that goes with it (`TableBacklog`), this rig's table sound put back (D2.8, D2.10), and the controller's share
   * (`releaseMatch`: the ball end that waits for its score, an initials hold, the turn lock, "this rig sends").
   *
   * Nothing the lobby holds is touched: the panel page and its voice peers, the native video mesh, the state stream's
   * tunnels, the overlay, the in-game menu and its global keys, the lobby's peek timer, the engine and its listeners,
   * the transport, the ArcAid room, the router port. Synchronous, and a second call changes nothing.
   *
   * Until the lobby outlives a match (step 7) it never runs alone: `teardown` is its one caller, with `closeLobbyHalf`
   * right behind it. Against the one function this was, two things happen a moment sooner, with no `await` in
   * between: the table sound is put back, and the lock goes, before the video mesh and the tunnels are closed and
   * not after. With `active` already null the unlock is the plain one either way (`lock.unlock`).
   */
  const endMatchHalf = (a: Active, keep = false): void => {
    if (a.heartbeat) clearInterval(a.heartbeat);
    a.heartbeat = null;
    a.engine.session.onCommit = null;
    if (keep) a.recordOff = true;
    else dropRecord(a);
    if (a.endTimer) clearTimeout(a.endTimer);
    a.endTimer = null;
    // A15: the table's events of this match, and where its journal stood, are no other match's.
    a.backlog = new TableBacklog<GameEvent>(null, false);
    a.mark = null;
    a.hold = false;
    a.reconcileDue = false;
    a.savedTurnEnds = 0;
    a.pendingExit = false;
    // D2.8: this rig's table sounds again at once (the emit that follows would do it too, a moment later).
    opts.tableAudio?.apply({ mutePid: null, tapPid: null });
    opts.tableAudio?.unlevel();
    tableLogged = '';
    a.controller.releaseMatch();
  };

  /**
   * A17 step 2 (2026-11-24, alpha-match.md §11.6): **what ends with the lobby**, which until step 7 is every time a
   * match ends: the listeners on the engine and the transport, the in-game menu and its global keys, the lobby's peek
   * timer, the native video mesh, the state stream's tunnels, the overlay, the controller (its `close()` detaches the
   * media: the panel page and every voice connection), the engine(s), the transport, the ArcAid room and the router
   * port. A15: `keep`: a host that closes to come straight back does not tell ArcAid it left.
   */
  const closeLobbyHalf = async (a: Active, keep = false): Promise<void> => {
    for (const off of a.offs) off();
    unregisterKeys();
    closeMenu();
    pushMenu();
    if (peekTimer) clearTimeout(peekTimer);
    peekTimer = null;
    peekKey = '';
    // D10.3: the helper's peers are closed and the rings let go; the helper itself stays for the next match.
    closeVideo(a);
    // I11.4.2: the fork is called back to its own table and the stream's data connections close; an unlock that
    // waited for it happens now.
    const stream = a.stream;
    a.stream = null;
    await stream?.close().catch((e: unknown) => log.warn(`stream3d: close: ${describeError(e)}`));
    if (a.overlay) await a.overlay.stop().catch((e: unknown) => log.warn(`match: overlay stop: ${describeError(e)}`));
    const roles = new Set<{ close(): void }>([a.engine, a.controller.currentRole as HostMatch | ClientMatch]);
    await a.controller.close();
    for (const r of roles) r.close();
    // A15: a host that closes to come straight back does not tell ArcAid it left: the room would end for its players.
    if (keep) a.relay?.abandon();
    a.transport.close();
    // D10.8: the router gets its port back (a lease would drop it within the hour anyway).
    if (a.renewTimer) clearInterval(a.renewTimer);
    a.renewTimer = null;
    const mapping = a.mapping;
    a.mapping = null;
    if (mapping) {
      const ok = await withTimeout(mapping.remove(), UNMAP_TIMEOUT_MS, 'the router did not answer').catch(() => false);
      log.info(`match: the router's mapping of TCP ${mapping.externalPort} ${ok ? 'was removed' : `could not be removed${mapping.leaseSeconds > 0 ? ` (its lease ends within ${mapping.leaseSeconds} s)` : ': remove it in the router'}`}`);
    }
  };

  /**
   * Close everything a match holds: the overlay, the controller (the panel, the media), the engine(s), the sockets. A15:
   * `keep`: its saved record stays. A17 step 2: in two halves, what ends with a match and what ends with the lobby;
   * every caller still means both (Leave, the end of a client's series, a refused reconnect, a host that cannot
   * listen, quit), so both run, one behind the other.
   */
  const teardown = async (a: Active, keep = false): Promise<void> => {
    if (active === a) active = null;
    endMatchHalf(a, keep);
    await closeLobbyHalf(a, keep);
  };

  const leave = (): Promise<MatchStatus> =>
    guard(async () => {
      const a = active;
      if (!a) return status();
      a.controller.leave('left the match');
      // A10: the host leaving between games ends the series for everyone (MATCH_END), rather than leaving them to find
      // out from a dead socket.
      if (a.controller.currentRole instanceof HostMatch && a.controller.endMatch()) log.info(`match: ${a.code} ended by the host after ${a.controller.status().series.game} game(s)`);
      await new Promise<void>((r) => setTimeout(r, LEAVE_FLUSH_MS));
      await teardown(a);
      lastError = null;
      log.info(`match: left ${a.code}`);
      emit();
      return status();
    });

  const api: MatchHost = {
    host,
    join: joinMatch,
    async start(o) {
      const a = active;
      if (!a) return fail(new Error('No match: host one first'));
      const r = a.controller.currentRole;
      if (!(r instanceof HostMatch)) return fail(new Error('Only the host starts the match'));
      if (r.state.phase !== 'lobby') {
        // A10: between games this is Next game.
        const why = a.controller.status().series.nextGameBlocker;
        if (why !== null || !a.controller.nextGame()) return fail(new Error(`No next game now: ${why ?? 'the host could not start it'}`));
        lastError = null;
        // A18: held for a player whose link dropped a moment ago: not started yet, and the panel's line says so.
        if (r.nextGamePending) log.info(`match: ${a.code} the next game was asked for from the Match tab and is held for a few seconds: a player's link dropped a moment ago, and it starts when that player is back or counted as away`);
        else log.info(`match: ${a.code} game ${r.state.gameNumber} started from the Match tab`);
        emit();
        return status();
      }
      // A13: a table that cannot report ball ends holds its first turn for ever: the host confirms such a start.
      const warnings = a.controller.status().startWarnings;
      if (warnings.length > 0 && o?.anyway !== true) {
        return fail(new Error(`${warnings.join(' · ')}. Start anyway to play it by hand: Pass the turn ends such a ball.`));
      }
      // I11.4.9: the first turn starts in 3D: while a PC's 3D connection is still being made the first press holds the
      // start until it is settled (each PC stops waiting by itself after its own limit); a second press starts now.
      if (o?.anyway !== true && o?.held !== true && a.controller.holdTabStart()) {
        lastError = null;
        // I11.4.18: the press was a click in Castcade's window: the table gets the foreground back while the start waits.
        giveVpxFocus('Start match was pressed');
        emit();
        return status();
      }
      // I11.4.18: a press on the Match tab left Castcade's window the active one, and the host's first ball is on its
      // table. Asked for BEFORE the start: the start issues this host's grant inside it, and the request a grant makes
      // (which is not handed on while the player types) would take the one flight; a Start match pressed with Enter or
      // Space, or just after typing, would then hand nothing on. The press is the player's own: never asked.
      if (r.roster().length >= 2) giveVpxFocus('Start match was pressed');
      try {
        r.start();
      } catch (e) {
        return fail(e);
      }
      lastError = null;
      // D10.8: the first game is on: ArcAid now refuses a device that was never in the room (the players may come back).
      a.relay?.lock().catch((e: unknown) => log.warn(`match: ArcAid did not lock ${a.code} against new joins: ${describeError(e)}`));
      log.info(`match: ${a.code} started with ${r.state.participants.map((p) => p.displayName).join(', ')}`);
      if (warnings.length > 0) log.warn(`match: started anyway (the host confirmed): ${warnings.join(' · ')}`);
      emit();
      return status();
    },
    async passTurn() {
      const a = active;
      if (!a) return fail(new Error('No match'));
      const r = a.controller.currentRole;
      if (!(r instanceof HostMatch)) return fail(new Error('Only the host passes the turn'));
      const p = a.controller.status().pass;
      if (!p || !a.controller.passTurn()) return fail(new Error(`The turn cannot be passed now: ${r.passTurnBlocker() ?? 'the host could not pass it'}`));
      lastError = null;
      log.info(`match: ${a.code} turn passed from the Match tab: ${p.name}'s ball ${p.ball} ended at ${p.score}`);
      emit();
      return status();
    },
    async resume() {
      const a = active;
      if (!a) return fail(new Error('No match'));
      const r = a.controller.currentRole;
      if (!(r instanceof HostMatch)) return fail(new Error('Only the host resumes a pause from here'));
      if (r.state.phase !== 'running' || !r.state.paused) return fail(new Error('The match is not paused'));
      if (r.state.pendingTransfer) return fail(new Error('A host transfer is under way: wait for it to finish'));
      try {
        r.resume();
      } catch (e) {
        return fail(e);
      }
      lastError = null;
      log.info(`match: ${a.code} resumed from the Match tab`);
      emit();
      return status();
    },
    leave,
    rejoin,
    forgetResume() {
      forget('the player dropped it');
      emit();
      return status();
    },
    setSettings(patch) {
      const before = settings.previewStereo;
      const cameraBefore = settings.cameraSource;
      const viewBefore = settings.cameraView;
      const eyesBefore = settings.cameraEyes;
      const tuneBefore = windowTuneWords(settings);
      const preMatchBefore = settings.preMatchPlay;
      const volumeBefore = `${settings.voiceVolume}/${settings.othersTableVolume}/${settings.myTableWhileUp}`;
      const menuKeysBefore = `${settings.menuKey}/${settings.menuChooseKey}`;
      const watch3dBefore = settings.watch3d;
      saveSettings(patchMatchSettings(settings, patch));
      // I11.4.2: the setting reaches a running match in `emit` (syncStream); a table already started stays in the VPX it is in.
      if (settings.watch3d !== watch3dBefore) {
        log.info(`stream3d: 3D watch set to ${settings.watch3d === 'auto' ? 'auto (3D whenever both PCs can)' : 'off (the 2D video)'} on the Match tab${active ? '' : '; from the next match table Castcade starts'}`);
      }
      // D8.10: new menu keys are taken at once when a match holds the old ones.
      if (`${settings.menuKey}/${settings.menuChooseKey}` !== menuKeysBefore) {
        log.info(`match: menu key ${shortcutWords(settings.menuKey)}, choose key ${settings.menuChooseKey !== null ? shortcutWords(settings.menuChooseKey) : 'none'} (Match tab)`);
        if (keysHeld) {
          unregisterMenuKeys();
          registerMenuKeys();
        }
      }
      // A12 (2026-11-05): the host's table before the match; a lobby under way follows the new choice at once.
      if (settings.preMatchPlay !== preMatchBefore) {
        log.info(`match: before the match: ${settings.preMatchPlay === 'locked' ? 'the table is locked until someone joins' : 'free play until someone joins'} (Match tab)`);
        active?.controller.setPreMatchPlay(settings.preMatchPlay);
      }
      // D2.10: the page's volumes go live at once; my table while I play reaches the helper in `emit` (syncTableAudio).
      if (`${settings.voiceVolume}/${settings.othersTableVolume}/${settings.myTableWhileUp}` !== volumeBefore) {
        pushVolume();
        log.info(`match: volumes on the Match tab: voice ${settings.voiceVolume} %, their table ${settings.othersTableVolume} %, my table while I play ${settings.myTableWhileUp} %`);
      }
      if (settings.previewStereo !== before) {
        opts.media?.setPreviewStereo?.(settings.previewStereo);
        log.info(`match: preview stereo set to ${settings.previewStereo} on the Match tab`);
      }
      // D7.5.1: the media layer reads it at its next attach, and while attached switches between balls (§5a).
      if (settings.cameraSource !== cameraBefore) {
        log.info(`match: camera set to ${settings.cameraSource === 'layer' ? 'the VR layer' : 'the screen capture'} on the Match tab (${active ? 'takes effect between balls' : 'takes effect at the next match'})`);
        opts.media?.setCameraSource?.(settings.cameraSource);
      }
      // D7.5.9: the view applies to a running camera at once (the media layer asks the layer again).
      if (settings.cameraView !== viewBefore) {
        log.info(`match: camera view set to ${settings.cameraView === 'whole' ? "each eye's whole render" : 'the 1:2 window crop'} on the Match tab`);
        opts.media?.setCameraView?.(settings.cameraView);
      }
      // D8.1: the eyes apply to a running camera at once too (the media layer asks the layer again, the capture follows).
      if (settings.cameraEyes !== eyesBefore) {
        log.info(`match: camera eyes set to ${settings.cameraEyes === 'one' ? 'one eye (a flat picture)' : 'both eyes (side by side)'} on the Match tab`);
        opts.media?.setCameraEyes?.(settings.cameraEyes);
      }
      // D7.5.10 / D7.5.11: the window's tuning reaches the overlays in `emit` (syncWindowTune); one line when it changed.
      if (windowTuneWords(settings) !== tuneBefore) log.info(`match: stereo window${windowTuneWords(settings) || ': depth infinity, no vertical offset, hard edges'} on the Match tab`);
      emit();
      return status();
    },
    setMicrophone(deviceId) {
      const id = typeof deviceId === 'string' && deviceId.trim() !== '' ? deviceId : null;
      // The media layer saves it and switches the live track; without one the choice is still kept for next time.
      if (opts.media?.setMicrophone) opts.media.setMicrophone(id);
      else opts.mediaSettings?.patch({ micDeviceId: id });
      log.info(`match: microphone ${id === null ? 'set to the Windows default' : 'chosen on the Match tab'}`);
      emit();
      return status();
    },
    setTurn(turn) {
      const store = opts.mediaSettings;
      if (!store) throw new Error('media settings are not available in this build');
      const url = turn?.url.trim() ?? '';
      if (!turn || url === '') {
        store.patch({ turn: null });
        log.info('match: TURN relay cleared on the Match tab (STUN only from the next match)');
      } else {
        const saved = store.get().turn;
        const next: TurnServer = { url, username: turn.username.trim(), credential: turn.credential ?? saved?.credential ?? '' };
        const got = store.patch({ turn: next }).turn;
        if (!got || got.url !== next.url || got.username !== next.username || got.credential !== next.credential) {
          throw new Error('The TURN relay needs a turn: or turns: address (for example turn:relay.example.org:3478), a username and a credential, each under 512 characters.');
        }
        // Never the credential (media-settings.ts).
        log.info(`match: TURN relay set to ${got.url} on the Match tab (used from the next match)`);
      }
      // D10.3: the helper takes the list for every peer made after this (a running match's peers keep theirs).
      active?.video?.setIce(iceServers(store.get()));
      emit();
      return status();
    },
    setVideoPath(path) {
      const store = opts.mediaSettings;
      if (!store) throw new Error('media settings are not available in this build');
      const next: VideoPath = path === 'electron' ? 'electron' : 'native';
      if (store.get().videoPath !== next) {
        store.patch({ videoPath: next });
        log.info(`match: spectator video set to ${next === 'native' ? 'the native helper' : 'the Electron path (0.2.36)'} on the Match tab (used from the next match)`);
      }
      emit();
      return status();
    },
    setVideoRungs(rungs) {
      if (rungs.maxKbps !== undefined) {
        const next = clampMaxKbps(rungs.maxKbps);
        const store = opts.mediaSettings;
        if (store && store.get().videoMaxKbps !== next) {
          store.patch({ videoMaxKbps: next });
          log.info(`match: native video ceiling set to ${next} kbps on the Match tab`);
        }
      }
      if (rungs.pin !== undefined) {
        const next = clampPin(rungs.pin);
        if (next !== videoPin) {
          videoPin = next;
          log.info(`match: native video ${next === null ? 'back to auto (the controller chooses the rung)' : `pinned to rung ${next}`} on the Match tab`);
        }
      }
      active?.video?.setRungs(videoRungs());
      emit();
      return status();
    },
    setMuted(muted) {
      if (opts.media) opts.media.setMuted(muted);
      else opts.mediaSettings?.patch({ muted });
      active?.controller.refresh();
      emit();
      return status();
    },
    showPanel() {
      opts.media?.showPanel();
      emit();
      return status();
    },
    hidePanel() {
      opts.media?.hidePanel?.();
      emit();
      return status();
    },
    setVrTest(test) {
      if (opts.vrLayer?.setTest) {
        log.info(`match: calibration pattern ${test ? 'on' : 'off'} (Match tab)`);
        opts.vrLayer.setTest(test);
      }
      emit();
      return status();
    },
    refreshMicrophones() {
      // During a match the panel page keeps the list; the new list reaches the tab through onMicrophones -> emit.
      if (active || !opts.media?.refreshMicrophones) return;
      void opts.media.refreshMicrophones().catch((e: unknown) => log.warn(`match: microphone list: ${describeError(e)}`));
    },
    status,
    onStatus(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    hostGame() {
      const a = active;
      if (!a) return null;
      const role = a.controller.currentRole;
      return role instanceof ClientMatch ? role.hostGame() : { ...a.sent.game };
    },
    async tableLaunch() {
      if (!active || !opts.stream3d) return null;
      return opts.stream3d.launch(settings.watch3d);
    },
    wants3d() {
      return !!active?.stream && settings.watch3d === 'auto' && active.stream.status().forkInstalled === true;
    },
    setLaunchNote(note) {
      const a = active;
      if (!a || (a.launchNote ?? null) === note) return;
      a.launchNote = note;
      emit();
    },
    async saveFrames() {
      const media = opts.media;
      if (!media?.saveFrames) throw new Error('The media layer is not running in this build: no frames to save');
      const root = framesRoot();
      const base = clipFolderName(new Date());
      let folder = base;
      for (let k = 2; existsSync(join(root, folder)); k++) folder = `${base}-${k}`;
      const a = active;
      return media.saveFrames({
        dir: join(root, folder),
        folder,
        settings: { match: { ...settings }, phase: a ? a.controller.status().phase : 'none', rig: a ? a.rig : null, runtime: a ? a.runtime : null, headsetMode: a?.vrMode?.mode ?? null },
      });
    },
    startBench,
    async stopBench() {
      await endBench('Stop on the Match tab');
      return status();
    },
    setBenchView(view) {
      const b = bench;
      if (!b || b.state !== 'running') return status();
      const next: BenchView = view === 'direct' ? 'direct' : 'theater';
      if (next !== b.view) {
        b.view = next;
        b.overlay?.setMode(next === 'theater' ? 'theater' : 'hidden');
        log.info(`bench: ${next === 'theater' ? 'the bench picture (theater)' : "VPX's own view"} on the Match tab`);
      }
      emit();
      return status();
    },
    benchClips: () => listClips(framesRoot()),
    async stop(o) {
      await endBench('Castcade quits');
      const a = active;
      if (o?.keepForRestart && a && !a.recordOff && a.engine.state.phase !== 'lobby') {
        // A15: Castcade restarts itself (an update): the match is not left; the others see a drop, and the next start rejoins.
        saveResume(a, 'update');
        await teardown(a, true);
        log.info(`match: ${a.code} is kept for the restart; Castcade rejoins it when it is back`);
      } else await leave().catch((e: unknown) => log.warn(`match: leave on quit: ${describeError(e)}`));
      unregisterKeys();
      closeMenu();
      if (peekTimer) clearTimeout(peekTimer);
      peekTimer = null;
      cue.destroy();
    },
  };
  MATCH_HALF.set(api, () => {
    if (active) endMatchHalf(active);
  });
  return api;
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------- cue --

/**
 * §3: a hidden window synthesises the cues (no asset): two rising tones for "your ball", one low tone for "opponent
 * up", a chord for "match over"; D2.10: a short `tick` for a volume key press. It plays on the default output, which
 * in VR is the headset. A file page with node integration, like `stream-host.ts`'s audio page; autoplay allowed so
 * the first cue sounds without a click.
 */
function createCue(page: string, volume: () => number, log: Logger): { play(kind: CueKind | 'tick'): void; destroy(): void } {
  let win: BrowserWindow | null = null;
  let ready: Promise<void> | null = null;
  ipcMain.on(CUE_STATUS_CHANNEL, (e, s: unknown) => {
    if (win && !win.isDestroyed() && e.sender === win.webContents) log.warn(`match: cue ${JSON.stringify(s)}`);
  });
  const ensure = (): Promise<void> => {
    if (win && !win.isDestroyed() && ready) return ready;
    writeFileSync(page, cuePage());
    const w = new BrowserWindow({
      show: false,
      width: 120,
      height: 80,
      webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' },
    });
    win = w;
    ready = new Promise<void>((resolve) => {
      w.webContents.once('did-finish-load', () => resolve());
    });
    void w.loadFile(page);
    return ready;
  };
  return {
    play(kind) {
      try {
        void ensure().then(() => {
          if (win && !win.isDestroyed()) win.webContents.send(CUE_CHANNEL, kind, volume() / 100);
        });
      } catch (e) {
        log.warn(`match: cue ${kind} failed: ${describeError(e)}`);
      }
    },
    destroy() {
      if (win && !win.isDestroyed()) win.destroy();
      win = null;
      ready = null;
    },
  };
}

function cuePage(): string {
  return `<!doctype html><meta charset="utf-8"><title>Castcade cue</title><script>
const { ipcRenderer } = require('electron');
let ctx = null;
function tone(freq, start, dur, gain, type) {
  const o = new OscillatorNode(ctx, { type, frequency: freq });
  const g = new GainNode(ctx, { gain: 0 });
  o.connect(g).connect(ctx.destination);
  const t = ctx.currentTime + start;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.start(t);
  o.stop(t + dur + 0.05);
}
ipcRenderer.on('${CUE_CHANNEL}', async (_e, kind, volume) => {
  try {
    if (!ctx) ctx = new AudioContext();
    if (ctx.state !== 'running') await ctx.resume();
    const v = Math.max(0, Math.min(1, Number(volume) || 0)) * 0.6;
    if (v <= 0) return;
    if (kind === 'your_turn') { tone(660, 0, 0.18, v, 'triangle'); tone(990, 0.2, 0.32, v, 'triangle'); }
    else if (kind === 'opponent_turn') { tone(262, 0, 0.4, v * 0.8, 'sine'); }
    else if (kind === 'match_over') { for (const f of [523.25, 659.25, 783.99]) tone(f, 0, 1.3, v * 0.45, 'triangle'); tone(1046.5, 0.12, 1.1, v * 0.3, 'sine'); }
    else if (kind === 'tick') { tone(880, 0, 0.06, v * 0.7, 'triangle'); }
  } catch (e) { ipcRenderer.send('${CUE_STATUS_CHANNEL}', { error: String(e) }); }
});
</script>`;
}
