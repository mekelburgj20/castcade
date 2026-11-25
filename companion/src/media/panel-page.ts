/**
 * D2 (alpha-match.md §4, 2026-10-30): the match panel page. ONE page holds the WebRTC mesh (microphone to every peer,
 * the VR preview window's video to every peer, enabled only while this rig is up) AND the panel the player looks at
 * (the up player's video large, whose ball it is, the scores, the mic, one message line). `rtc-host.ts` writes it to
 * `<userData>/match-panel.html` and loads it as a file (getUserMedia needs a secure context; `data:` is not one, the
 * stream-host audio page found that on 2026-10-28); in VR the window is offscreen and its paint feeds the headset.
 *
 * Everything the page shows comes from `PanelState` (the match controller computes it); the page only formats. The
 * formatting helpers below are embedded into the page by their own source, like `rtc-signaling.ts`'s classes: they
 * must stay self-contained (no imports, no module constants, only each other). Remote players' names reach the DOM
 * through `textContent` only.
 */
import type { LayerCameraEyeGeometry, MatchPlayerId, MediaStatus, PanelState } from './match-media-types.js';
import type { IceServer } from './media-settings.js';
import type { PanelVolume } from './match-media-types.js';
import { tallyText } from './scoreboard-page.js';
import { IN_JPEG_QUALITY } from './frame-clip.js';
import { negotiationSource } from './rtc-signaling.js';

/** The IPC channels between the panel page and the main process (`rtc-host.ts`). */
export const PANEL_CHANNELS = {
  // main -> page
  attach: 'castcade-panel:attach',
  signal: 'castcade-panel:signal',
  addPeer: 'castcade-panel:add-peer',
  removePeer: 'castcade-panel:remove-peer',
  sending: 'castcade-panel:sending',
  state: 'castcade-panel:state',
  muted: 'castcade-panel:muted',
  capture: 'castcade-panel:capture',
  /** D2.5: `true` while VPX is not the foreground window; the page sends a "Paused" frame instead of the crop. */
  cover: 'castcade-panel:cover',
  microphone: 'castcade-panel:microphone',
  detach: 'castcade-panel:detach',
  /** D7.4: `true` while the headset's theater mode wants the up player's video; the page then sends it on `video`. */
  videoWant: 'castcade-panel:video-want',
  /** D7.4: main took a video frame; the page sends the next one only after this (one frame in flight). */
  videoAck: 'castcade-panel:video-ack',
  /** D2.8: `{ send, hear }` (`TableAudioFlags`): the table track carries this rig's VPX sound; the up player's plays. */
  tableAudio: 'castcade-panel:table-audio',
  /** D2.8: one 10 ms frame of this rig's VPX sound (float32 stereo 48 kHz, a Uint8Array), only while sending. */
  tablePcm: 'castcade-panel:table-pcm',
  /**
   * D2.10 (2026-11-05): `PanelVolume` (percent): the other players' voices and the up player's table as this page plays
   * them; applied at once to every connection (`volumeGains`). With a `note`, the footer shows it for `VOLUME_NOTE_MS`.
   */
  volume: 'castcade-panel:volume',
  /** D8.10 (2026-11-14): `PanelMenu` or null: the in-game menu, drawn over the stage and the score strip while it is open. */
  menu: 'castcade-panel:menu',
  /**
   * D10.5 (2026-11-07): one short line about the native spectator video for the footer (`video: rung 3 · 1016x1080@60 ·
   * 7.8 Mbps · rtt 41 ms`), or null to clear it; from the match host through `setVideoLine`.
   */
  videoLine: 'castcade-panel:video-line',
  /**
   * I11.12 (2026-11-24): the ids of the players the native video holds a direct candidate pair to (an array; empty
   * clears it), from the match host through `setVideoDirect`. For such a peer the page never says a TURN relay is
   * needed: the routers do let a direct connection through (`noPathText`). It chooses the words only; the restarts go
   * on for every peer.
   */
  videoDirect: 'castcade-panel:video-direct',
  /**
   * D7.5.1: one frame of the layer camera (`PanelCameraFrame`: both eyes' JPEGs), only while the capture is the
   * camera (`sourceId: 'layer-camera'`). One in flight: main sends the next only after `cameraAck`, newest wins.
   */
  cameraFrame: 'castcade-panel:camera-frame',
  /**
   * D7.6.3 (2026-11-03): `{ ms, max }`: JPEG-encode (quality 90) each frame the theater feed hands to the layer for the
   * next `ms`, at most `max`, one encode in flight; each goes back on `savedFrame`.
   */
  saveFrames: 'castcade-panel:save-frames',
  /**
   * D7.6 (2026-11-03): the VR test bench (`PanelBench`, or null to end it), instead of an attach: no mesh, no
   * microphone, no capture; the stage shows the bench canvas (path direct) or a local WebRTC loop's received track.
   */
  bench: 'castcade-panel:bench',
  /** D7.6: one bench frame (`PanelBenchFrame`), one in flight: main sends the next after `benchAck`. */
  benchFrame: 'castcade-panel:bench-frame',
  // page -> main
  ready: 'castcade-panel:ready',
  send: 'castcade-panel:send',
  status: 'castcade-panel:status',
  devices: 'castcade-panel:devices',
  /** D7.4: `{ width, height, rgba: Uint8Array, stereo: 'mono' | 'sbs' }`, the stage video's pixels. */
  video: 'castcade-panel:video',
  /** D2.9: one line for companion.log (ICE restarts and their outcome, the candidate pair); main prefixes `media: `. */
  log: 'castcade-panel:log',
  /** D7.5.1: the page drew (or gave up on) the camera frame main sent last; main may send the next. */
  cameraAck: 'castcade-panel:camera-ack',
  /** D7.6.3: one saved theater frame (`PanelSavedFrame`). */
  savedFrame: 'castcade-panel:saved-frame',
  /** D7.6: the page drew (or gave up on) the bench frame main sent last. */
  benchAck: 'castcade-panel:bench-ack',
  /** D7.6: the bench readout every second (`BenchPageReport`, media/bench.ts). */
  benchStatus: 'castcade-panel:bench-status',
} as const;

/** D7.6: the bench as the page runs it. `bitrate` (D7.6.9): path loop's cap override in bits per second, null for the match's rule. */
export interface PanelBench {
  path: 'direct' | 'loop';
  source: 'clip' | 'live';
  bitrate: number | null;
}

/**
 * D7.6: one bench frame, main -> page: two eye JPEGs side by side (`right` set; `width` x `height` per eye: a layer
 * camera frame or a saved sender frame) or one whole picture (`right` null: a saved received frame).
 */
export interface PanelBenchFrame {
  n: number;
  width: number;
  height: number;
  left: Uint8Array;
  right: Uint8Array | null;
  stereo: 'mono' | 'sbs';
  eyes: LayerCameraEyeGeometry[] | null;
}

/** The picture sent while this rig is up (alpha-match.md §4): the VR preview window is set to 1280x720. */
export const PANEL_VIDEO = { width: 1280, height: 720, fps: 30, maxBitrate: 2_500_000 } as const;

/**
 * D7.4 (2026-10-31): the video the headset's theater mode gets, at the received size up to these (a larger one is
 * scaled down, aspect kept): a mono picture up to 1920 wide and (D8.1, 2026-11-05) 1440 high, so the one-eye layer
 * camera's portrait picture (1354x1440 from a 3072x3264 eye in the 1440 box) reaches the flat screen unscaled; a
 * side-by-side one up to two 1080p halves. Each frame is a copy (getImageData, IPC, the pipe), so at most `fps` a
 * second and only when the video has a new frame.
 */
export const VIDEO_FEED_MAX = { mono: { width: 1920, height: 1440 }, sbs: { width: 3840, height: 1440 }, fps: 30 } as const;
/** Two 16:9 eyes side by side are 32:9; no single picture a player sends is 3:1 or wider. */
export const SBS_MIN_ASPECT = 3;

/**
 * D2.5 (2026-10-31): a screen source and the player window's region of it (`capture-crop.ts`). The page films the
 * whole display and draws the crop onto a canvas, whose track is what the peers get. A capture with the same `sourceId`
 * as the live one only moves the crop (the window moved or resized); `null` on the capture channel stops the capture.
 */
export interface PanelCapture {
  /** `desktopCapturer` source id, `screen:<n>:0`. */
  sourceId: string;
  /** What `MediaStatus.captureSource` says, also used in the page's error lines. */
  label: string;
  /** The display's frame size in physical pixels (what the capture should deliver). */
  screen: { width: number; height: number };
  /** The window's client area in that frame. */
  crop: { x: number; y: number; width: number; height: number };
  /** The size the crop is drawn at and sent: at most 1280x720, the crop's aspect. */
  out: { width: number; height: number };
  /** D7.4.4 (2026-11-01): open the capture afresh even when `sourceId` is the live one's (a stalled capture re-picked). */
  restart?: boolean;
  /**
   * D7.4.3 (2026-11-01): what this picture is, declared by this rig (`preview-stereo.ts`): `sbs` = VPX's VR preview on
   * both eyes (left | right), `mono` = one picture, null = not known (the receivers guess from its shape). The page
   * tells every peer on a `stereo` signal. Absent before D7.4.3 (treated as null).
   */
  stereo?: 'mono' | 'sbs' | null;
  /** D7.4.10 (2026-11-02): the window covers its display or hangs off it (`capture-crop.ts` fitWarning); for the Match tab and the log, the page ignores it. */
  warning?: string | null;
}

/**
 * D7.5.1 (2026-11-02): the capture is the VR layer camera (alpha-match.md §5a) when its `sourceId` is this: no screen is
 * opened, the page draws the two eyes main sends on `cameraFrame` side by side onto the same canvas. D8.1 (2026-11-05):
 * or the one eye main sends (a mono capture), drawn alone as a flat picture.
 */
export const LAYER_CAMERA_SOURCE_ID = 'layer-camera';

/**
 * D7.5.1: one camera frame, main -> page: each eye `width` x `height` as JPEG, left then right, and their geometry.
 * D8.1 (2026-11-05): one eye only (the other null) when the camera sends one eye; the page draws it alone at (0, 0).
 */
export interface PanelCameraFrame {
  n: number;
  width: number;
  height: number;
  left: Uint8Array | null;
  right: Uint8Array | null;
  /** Left then right: fov, crop, render (the stereo declaration carries them, D7.5.2); one entry for a one-eye frame. */
  eyes: LayerCameraEyeGeometry[];
}

/** D7.6.3: one theater frame the page saved, page -> main: the JPEG, its size and stereo, the eyes if known, when and from what. */
export interface PanelSavedFrame {
  i: number;
  jpeg: Uint8Array;
  width: number;
  height: number;
  stereo: 'mono' | 'sbs';
  eyes: LayerCameraEyeGeometry[] | null;
  at: number;
  source: string;
  /** Frames handed to the layer since the last saved one that were not saved (an encode was in flight). */
  skipped: number;
}

export interface PanelAttach {
  localId: MatchPlayerId;
  peers: MatchPlayerId[];
  ice: IceServer[];
  capture: PanelCapture | null;
  micDeviceId: string | null;
  muted: boolean;
  sending: boolean;
  /**
   * D2.7 (2026-11-01): this page replaces one whose connections to `peers` still stand on their side (the panel moved
   * into the headset): it sends each a `reset` before anything else, so they reopen before its fresh offer lands.
   */
  reset?: boolean;
}

/** What the page reports; `rtc-host.ts` adds `attached` and `captureSource`. */
export interface PanelPageStatus {
  sending: boolean;
  peers: MediaStatus['peers'];
  mic: MediaStatus['mic'];
  capturing: boolean;
  error: string | null;
  /**
   * D7.4.4 (2026-11-01): the screen capture delivered no new frame for `CAPTURE_STALL_MS` while this rig was sending.
   * Main re-picks the capture; the page has already taken its track off the connections so the receivers see
   * "waiting for <name>'s table" rather than a frozen picture.
   */
  captureStalled?: boolean;
  /** D7.4.4: the last 10 s counters (`seq` changes with each); absent until the first one. */
  stats?: PanelStats | null;
}

export interface PanelStats {
  seq: number;
  /** Frames the screen capture delivered in the window, while this rig was sending; else null. */
  capture: number | null;
  /** Frames the stage video decoded, and how many of them went to the layer, while theater wanted the feed; else null. */
  decoded: number | null;
  toLayer: number | null;
  /**
   * D7.4.6: the outbound video as the first peer's connection reports it (the tick before's reading); absent before one.
   * D8.3: `codec` is the codec stat's mimeType without "video/" ("H264", "VP8"), `encoder` Chromium's
   * `encoderImplementation` ("MediaFoundationVideoEncodeAccelerator", "libvpx", "OpenH264"...); null while not known.
   */
  sent?: { width: number; height: number; kbps: number | null; limit: string; codec?: string | null; encoder?: string | null };
  /** D7.4.6: the stage video's decoded frame size, while theater wanted the feed. */
  decodedSize?: { width: number; height: number };
  /** D7.5.1: `capture` counted layer camera frames drawn; `unreadable`: frames whose JPEGs did not decode, skipped. */
  camera?: { unreadable: number };
}

export interface MicDevice {
  deviceId: string;
  label: string;
}

export interface StripRow {
  id: MatchPlayerId;
  name: string;
  score: string;
  detail: string;
  up: boolean;
  /** Shown in red: a different table, offline. */
  flags: string[];
  /** Shown muted (D2.5, 2026-10-31): a different VPX build, which says nothing about the table. */
  notes: string[];
}

// ---- formatting helpers (embedded in the page; keep them self-contained) ----

/**
 * The final review (finding 10): a name as it is shown in a header or a sentence: cut to `max` characters, the last an
 * ellipsis. The page embeds its helpers by their source text, and a helper can only call what is defined in its own
 * file: this is `match/short-name.ts`, word for word (held equal by panel-page.test.ts).
 */
export function shortName(name: string, max = 24): string {
  const chars = Array.from(String(name));
  return chars.length <= max ? String(name) : chars.slice(0, Math.max(1, max - 1)).join('') + '…';
}


/**
 * `YOUR BALL 2` / `KROBS IS UP`, or the phase when nobody is. A10 (2026-11-02): from game 2 of a series the turn line
 * says the game (`GAME 2 · YOUR BALL 1`), and a game's result reads `GAME 1 OVER` until the series is over
 * (`MATCH OVER`). A11: `STARTING IN 5` while the start from the host's table counts down.
 */
export function headerText(s: PanelState): string {
  const game = typeof s.game === 'number' && s.game > 0 ? s.game : 1;
  if (s.phase === 'over') return s.seriesOver === false ? 'GAME ' + game + ' OVER' : 'MATCH OVER';
  // A17 step 1 (the review of PR 127): a lobby this PC has lost (its host is gone) is over, and says so.
  // Step 9: a lobby that was closed reads LOBBY CLOSED, as the Match tab says it.
  if (s.phase === 'idle' && s.seriesOver === true) return s.members ? 'LOBBY CLOSED' : 'LOBBY OVER';
  // A17 step 9 (2026-11-27): a countdown that has run out and is held (a player's link dropped a moment ago, see the
  // line under it) reads STARTING: "IN 0" looked stuck.
  if (s.phase === 'idle' && typeof s.countdown === 'number') return s.countdown > 0 ? 'STARTING IN ' + s.countdown : 'STARTING';
  // The final review (finding 7; design 11.9): a match ended a moment ago: MATCH OVER, and the line under it says the standing.
  if (s.phase === 'idle' && s.matchOver === true) return 'MATCH OVER';
  // A17 step 10: tables are being changed (a start does not count down meanwhile; one that does is the header).
  if (s.phase === 'idle' && typeof s.changingTable === 'string' && s.changingTable !== '') return 'CHANGING TABLE · ' + s.changingTable.toUpperCase();
  // A17 step 9 (design 11.9): in a lobby the header is the lobby (`LOBBY · 3 HERE`); who starts, and how, is the line.
  if (s.phase === 'idle') return s.members && s.members.length > 0 ? 'LOBBY · ' + s.members.length + ' HERE' : 'WAITING FOR THE START';
  // The final review (2026-11-28, finding 4): a game that waits for a player who is away says for whom: `PAUSED ·
  // WAITING FOR CHUCK`. It named whoever held the last turn (`PAUSED · KROBS IS UP`), which was untrue whenever the
  // drop came during somebody else's ball. A player's own panel keeps `YOUR BALL` only while the ball is theirs.
  const waited = s.phase === 'paused' && s.pausedFor ? s.players.find((p) => p.id === s.pausedFor) : null;
  if (waited && !(s.myTurn && s.playerUp === s.pausedFor)) return 'PAUSED · ' + (game > 1 ? 'GAME ' + game + ' · ' : '') + 'WAITING FOR ' + shortName(waited.name, 14).toUpperCase();
  const up = s.players.find((p) => p.id === s.playerUp);
  const ball = s.ball !== null ? ' ' + s.ball : '';
  const turn = (game > 1 ? 'GAME ' + game + ' · ' : '') + (s.myTurn ? 'YOUR BALL' + ball : up ? shortName(up.name, 14).toUpperCase() + ' IS UP' : 'WAITING');
  return s.phase === 'paused' ? 'PAUSED · ' + turn : turn;
}

export function scoreText(score: number | null): string {
  return score === null ? '–' : score.toLocaleString('en-US');
}

/**
 * The score strip: players in the controller's order while playing, the game's standings by place once it is over.
 * A10 (2026-11-02): once a series has two or more games, a result row says the series place and wins too (`#1 · SERIES
 * #2 · 1 WIN`), and from game 2 on a playing row carries the player's series wins as a muted note. A11: a lobby row
 * whose table is not open yet is flagged `LOADING`.
 */
export function stripRows(s: PanelState): StripRow[] {
  // A17 step 9 (2026-11-27, design 11.9): in the lobby the rows are the members, the lobby's PC first, each with their
  // choice for the next start (PLAY / WATCH) and what is wrong or special about their row. No score: there is none.
  if (s.phase === 'idle' && s.members && s.members.length > 0) {
    const words: Record<string, string> = { away: 'AWAY', loading: 'LOADING', no_table: 'NO TABLE', other_table: 'OTHER TABLE', own_game: 'OWN GAME', close_table: 'HAS TO CLOSE THEIR TABLE', asked: 'ASKED TO OPEN IT', changing: 'CHANGING TABLE' };
    return s.members.map((m) => ({ id: m.id, name: m.name, score: '', detail: m.stance === 'watch' ? 'WATCH' : 'PLAY', up: false, flags: m.flags.map((f) => words[f] || String(f).toUpperCase()), notes: [] }));
  }
  const series = s.series || [];
  const wins = (n: number): string => n + (n === 1 ? ' WIN' : ' WINS');
  const many = series.some((x) => x.games > 1);
  if (s.phase === 'over' && s.result) {
    return [...s.result]
      .sort((a, b) => a.place - b.place)
      .map((r) => {
        const sr = series.find((x) => x.id === r.id);
        const detail = '#' + r.place + (many && sr ? ' · SERIES #' + sr.place + ' · ' + wins(sr.wins) : '');
        // B26: a player with a ball on which Midnight Madness ran is marked on the result too.
        const flags = (r.flags || []).indexOf('midnight') >= 0 ? ['MIDNIGHT MADNESS'] : [];
        return { id: r.id, name: r.name, score: scoreText(r.score), detail, up: false, flags, notes: [] };
      });
  }
  return s.players.map((p) => {
    const detail = p.isUp && s.ball !== null ? 'BALL ' + s.ball : p.ballsDone >= s.ballsPerGame ? 'DONE' : p.ballsDone + '/' + s.ballsPerGame;
    // A18 (2026-11-24): `disconnected` reads AWAY (it read OFFLINE until 0.2.50): the player is not on the match's
    // control link, which says nothing about the voice and the picture: those go straight between the PCs and stay.
    const flags = p.flags
      .filter((f) => f !== 'build_mismatch')
      .map((f) => (f === 'table_mismatch' ? 'DIFFERENT TABLE' : f === 'disconnected' ? 'AWAY' : f === 'loading' ? 'LOADING' : f === 'midnight' ? 'MIDNIGHT MADNESS' : String(f).toUpperCase()));
    const notes = p.flags.includes('build_mismatch') ? ['DIFFERENT VPX BUILD'] : [];
    const sr = series.find((x) => x.id === p.id);
    if (sr && (s.game || 1) > 1) notes.push(wins(sr.wins));
    return { id: p.id, name: p.name, score: scoreText(p.score), detail, up: p.isUp, flags, notes };
  });
}

/**
 * A17 step 9 (2026-11-27, design 11.9): under the score strip of a game, who is in the lobby and not in the game:
 * `Watching: Chuck, Dana`. A member who is away is not watching. Empty outside a game, without a lobby, and when
 * everybody plays.
 */
export function watchingText(s: PanelState): string {
  if ((s.phase !== 'playing' && s.phase !== 'paused') || !s.members) return '';
  const names = s.members.filter((m) => !s.players.some((p) => p.id === m.id) && m.flags.indexOf('away') < 0).map((m) => shortName(m.name, 18));
  return names.length > 0 ? 'Watching: ' + names.join(', ') : '';
}

export function micText(mic: PanelState['mic']): string {
  return mic === 'open' ? 'MIC ON' : mic === 'muted' ? 'MIC MUTED' : 'NO MIC';
}

/** Whose picture fills the stage: `self` (my own preview while I am up), the up player's id, or nobody. */
export function videoPeer(s: PanelState): MatchPlayerId | 'self' | null {
  if (s.phase !== 'playing' && s.phase !== 'paused') return null;
  if (s.myTurn) return 'self';
  return s.playerUp;
}

/** The line over an empty stage. */
export function stageText(s: PanelState | null, hasVideo: boolean, voiceUp = false): string {
  if (!s || hasVideo) return '';
  // A17 (2026-11-24): the voice is connected from the join on. In the lobby, where the stage has nothing to show, it
  // says so in words as soon as a connection to another player is up (`voiceUp`) and the microphone is open: until
  // 0.2.50 nobody heard anybody before the match started.
  if (s.phase === 'idle') return voiceUp && s.mic === 'open' ? 'YOUR MICROPHONE IS ON · THE OTHERS HEAR YOU' : '';
  if (s.phase === 'over') return '';
  if (s.myTurn) return 'NO PICTURE FROM YOUR TABLE';
  const up = s.players.find((p) => p.id === s.playerUp);
  // A17 step 9: "KROBS' TABLE", as every sentence of the lobby writes a name that ends in s (it read KROBS'S here alone).
  return up ? 'WAITING FOR ' + shortName(up.name, 14).toUpperCase() + (/s$/i.test(up.name) ? "' TABLE" : "'S TABLE") : '';
}

/**
 * D2.5: the crop in the video's own pixels. Chromium may deliver the screen smaller than asked (a constraint, a GPU
 * limit), so the crop is scaled by the video's size against the display's, and clamped to the frame. Null before the
 * video has a frame.
 */
export function videoCropRect(cap: Pick<PanelCapture, 'screen' | 'crop'>, videoWidth: number, videoHeight: number): { sx: number; sy: number; sw: number; sh: number } | null {
  if (!(videoWidth > 0 && videoHeight > 0 && cap.screen.width > 0 && cap.screen.height > 0)) return null;
  const kx = videoWidth / cap.screen.width;
  const ky = videoHeight / cap.screen.height;
  const sx = Math.max(0, Math.min(videoWidth, Math.round(cap.crop.x * kx)));
  const sy = Math.max(0, Math.min(videoHeight, Math.round(cap.crop.y * ky)));
  const sw = Math.min(videoWidth - sx, Math.round(cap.crop.width * kx));
  const sh = Math.min(videoHeight - sy, Math.round(cap.crop.height * ky));
  return sw >= 2 && sh >= 2 ? { sx, sy, sw, sh } : null;
}

/** D7.4.4 (2026-11-01): no new frame from the screen capture for this long, while sending, is a stall. */
export const CAPTURE_STALL_MS = 3000;
/** D7.4.4: the counters are reported every this often. */
export const STATS_MS = 10_000;

/**
 * D7.4.4: one look at the capture's frame counter (`mark`: the hidden video's decoded-frame count, else its clock).
 * `at` is when the counter last moved; it follows `now` while this rig is not sending (a still screen is no fault
 * then). Stalled = sending and no movement for `limitMs`; a moved counter clears it at once.
 */
export function stallStep(w: { mark: number; at: number }, mark: number, now: number, sending: boolean, limitMs: number): { mark: number; at: number; stalled: boolean; moved: boolean } {
  const moved = mark !== w.mark;
  const at = moved || !sending ? now : w.at;
  return { mark, at, stalled: !moved && sending && now - at >= limitMs, moved };
}

/** The canvas calls `paintFrame` makes (a 2D context has them all). */
export interface Paint2D {
  fillStyle: string;
  font: string;
  textAlign: string;
  textBaseline: string;
  fillRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  drawImage(src: unknown, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number): void;
}

/**
 * D2.5: one frame of the match video. Covered (D1.9: VPX is not in front, so the screen shows something else): a flat
 * dark frame saying so. Else the window's crop of the screen, scaled to the output. `blank` (no video frame yet) leaves
 * the canvas as it was.
 */
export function paintFrame(ctx: Paint2D, video: { videoWidth: number; videoHeight: number }, cap: Pick<PanelCapture, 'screen' | 'crop' | 'out'>, covered: boolean): 'cover' | 'crop' | 'blank' {
  const w = cap.out.width;
  const h = cap.out.height;
  if (covered) {
    ctx.fillStyle = '#11141b';
    ctx.fillRect(0, 0, w, h);
    // 24 characters at about 0.55 em each fit in 90 % of a portrait crop's width too.
    ctx.font = '700 ' + Math.max(12, Math.round(Math.min(h / 12, w / 16))) + 'px "Segoe UI", system-ui, sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Paused: back in a moment', w / 2, h / 2);
    return 'cover';
  }
  const r = videoCropRect(cap, video.videoWidth, video.videoHeight);
  if (!r) return 'blank';
  ctx.drawImage(video, r.sx, r.sy, r.sw, r.sh, 0, 0, w, h);
  return 'crop';
}

/**
 * D7.5.1 (2026-11-02): the capture main and the page hold while the layer camera feeds (alpha-match.md §5a): no screen,
 * the two eyes side by side, `2 * eyeWidth` x `eyeHeight`, declared side by side. `report()`, the Match tab's capture
 * fields and the `capture:` counters read it as they read a screen capture's. (Inlined source id: embedded by source.)
 * D8.1 (2026-11-05): `mono` is the one-eye camera: `eyeWidth` x `eyeHeight`, declared mono (a flat picture on the
 * receiver's screen, never placed from the sender's eyes).
 */
export function cameraCapture(eyeWidth: number, eyeHeight: number, stereo: 'mono' | 'sbs' = 'sbs'): PanelCapture {
  const mono = stereo === 'mono';
  const w = Math.max(1, Math.round(eyeWidth)) * (mono ? 1 : 2);
  const h = Math.max(1, Math.round(eyeHeight));
  return { sourceId: 'layer-camera', label: 'VR layer camera', screen: { width: w, height: h }, crop: { x: 0, y: 0, width: w, height: h }, out: { width: w, height: h }, stereo: mono ? 'mono' : 'sbs' };
}

/** D7.5.1: the capture is the layer camera (`cameraCapture`), not a screen. */
export function isCameraCapture(c: { sourceId?: unknown } | null | undefined): boolean {
  return !!c && c.sourceId === 'layer-camera';
}

/**
 * D7.5.1: a camera frame from main, checked: each eye's size (1–4096, whole) and two non-empty JPEGs, `sbs`; D8.1:
 * or one non-empty JPEG (`left` or `right`, the other null or absent), `mono`. Null otherwise.
 */
export function cameraFrameSize(f: unknown): { width: number; height: number; stereo: 'mono' | 'sbs' } | null {
  if (typeof f !== 'object' || f === null) return null;
  const v = f as { width?: unknown; height?: unknown; left?: { byteLength?: unknown } | null; right?: { byteLength?: unknown } | null };
  const ok = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 4096;
  const bytes = (b: { byteLength?: unknown } | null | undefined): boolean => !!b && typeof b.byteLength === 'number' && b.byteLength > 0;
  const empty = (b: unknown): boolean => b === null || b === undefined;
  if (!ok(v.width) || !ok(v.height)) return null;
  const l = bytes(v.left);
  const r = bytes(v.right);
  if (l && r) return { width: v.width, height: v.height, stereo: 'sbs' };
  if ((l && empty(v.right)) || (r && empty(v.left))) return { width: v.width, height: v.height, stereo: 'mono' };
  return null;
}

/**
 * D7.5.1: the eyes' geometry as a comparable key (fov to 1e-4 rad, crop and render whole), so the stereo declaration
 * is re-sent only when it changes (at most once per VPX resolution change); null for none or a malformed list.
 */
export function eyesKey(eyes: ReadonlyArray<{ fov?: unknown; rect?: unknown; render?: unknown }> | null | undefined): string | null {
  if (!eyes || !Array.isArray(eyes) || eyes.length !== 2) return null;
  const nums = (a: unknown, n: number, k: number): string | null =>
    Array.isArray(a) && a.length === n && a.every((x) => typeof x === 'number' && isFinite(x)) ? a.map((x: number) => Math.round(x * k)).join(',') : null;
  const parts: string[] = [];
  for (const e of eyes) {
    const fov = nums(e && e.fov, 4, 10000);
    const rect = nums(e && e.rect, 4, 1);
    const render = nums(e && e.render, 2, 1);
    if (fov === null || rect === null || render === null) return null;
    parts.push(fov + '|' + rect + '|' + render);
  }
  return parts.join(';');
}

/**
 * D7.4.3 + D7.5.1: the `stereo` signal this rig sends. A screen capture's is `{ kind, stereo }` exactly as before; while
 * the layer camera feeds it is side by side with each eye's fov, crop and render (`eyes`, left then right).
 */
export function stereoSignal(stereo: 'mono' | 'sbs' | null, eyes: ReadonlyArray<{ fov: number[]; rect: number[]; render: number[] }> | null | undefined): { kind: 'stereo'; stereo: 'mono' | 'sbs' | null; eyes?: Array<{ fov: number[]; rect: number[]; render: number[] }> } {
  if (stereo !== 'sbs' || !eyes || eyes.length !== 2) return { kind: 'stereo', stereo: stereo };
  return { kind: 'stereo', stereo: 'sbs', eyes: eyes.map((e) => ({ fov: e.fov.slice(0, 4), rect: e.rect.slice(0, 4), render: e.render.slice(0, 2) })) };
}

/**
 * D7.4: whether the up player's picture is VPX's VR preview on "both eyes" (left | right). D7.4.3 (2026-11-01): the
 * sender says so (`declared`, its `stereo` signal), and that is trusted whatever the picture's shape and whatever its
 * rig: VPX centre-crops each eye to its half of the window, so both eyes in a 16:9 or a square window are two portrait
 * eyes, not a 3:1 picture. Only a sender that declared nothing (an older companion, or one that could not read its
 * ini) falls back to the D7.4 guess: a VR sender's picture 3:1 or wider (`SBS_MIN_ASPECT`, inlined: these helpers are
 * embedded in the page by their source).
 */
export function stereoOf(declared: string | null | undefined, rig: string | undefined, videoWidth: number, videoHeight: number): 'mono' | 'sbs' {
  if (declared === 'sbs' || declared === 'mono') return declared;
  return rig === 'vr_headset' && videoHeight > 0 && videoWidth / videoHeight >= 3 ? 'sbs' : 'mono';
}

/** D7.4: the size the theater feed is read at: the video's own, scaled down into the limit for its kind, even sides (VIDEO_FEED_MAX, inlined). */
export function feedSize(videoWidth: number, videoHeight: number, stereo: 'mono' | 'sbs'): { width: number; height: number } | null {
  if (!(videoWidth >= 2 && videoHeight >= 2)) return null;
  const max = stereo === 'sbs' ? { width: 3840, height: 1440 } : { width: 1920, height: 1440 };
  const k = Math.min(1, max.width / videoWidth, max.height / videoHeight);
  return { width: Math.max(2, Math.round(videoWidth * k) & ~1), height: Math.max(2, Math.round(videoHeight * k) & ~1) };
}

/**
 * D7.4.6 (2026-11-02): the bitrate cap for what is sent. A mono landscape picture up to 1280x720 keeps 2.5 Mbps; anything
 * larger, side by side, or portrait gets 0.13 bits a pixel a frame at 30 fps (1280x1080 about 5.4 Mbps, 2560x720 about
 * 7.2, 1440x1392 about 7.8), at most 8 Mbps. (Inlined constants: these helpers are embedded in the page by their source.)
 */
export function videoBitrateFor(shape: { width: number; height: number; stereo: 'mono' | 'sbs' | null | undefined }): number {
  const px = shape.width * shape.height;
  if (!(px > 0)) return 2500000;
  if (shape.stereo !== 'sbs' && shape.width >= shape.height && px <= 1280 * 720) return 2500000;
  const bits = Math.round((px * 30 * 0.13) / 100000) * 100000;
  return Math.min(8000000, Math.max(2500000, bits));
}

/**
 * D2.8 (2026-11-01): the table track's stream id as the receivers see it. A MediaStream's id cannot be chosen, so the
 * page renames its table stream's id to this in every SDP it sends (`outgoingSdp`); msid survives SDP, so `ontrack`'s
 * `streams[0].id` tells the table track from the voice. The helpers below spell it out (they are embedded by source).
 */
export const TABLE_AUDIO_STREAM_ID = 'castcade-table-audio';

/** D2.8: what a received track is: the sender's table sound (its own stream, `TABLE_AUDIO_STREAM_ID`), voice or video. */
export function trackRole(kind: string, streamIds: readonly string[]): 'table' | 'audio' | 'video' {
  if (kind === 'audio' && streamIds.indexOf('castcade-table-audio') >= 0) return 'table';
  return kind === 'video' ? 'video' : 'audio';
}

/** D2.8: a peer's table track plays only while that peer is the player up (whose video fills the stage) and `hear` is on. */
export function tablePlays(s: PanelState | null, peer: MatchPlayerId, hear: boolean): boolean {
  return !!hear && !!s && videoPeer(s) === peer;
}

/** D2.10: how long the footer shows a volume note ("Voice 160 %") after a shortcut press. */
export const VOLUME_NOTE_MS = 2000;

/**
 * D2.10: the page's gains from a `PanelVolume` in percent: the voice 0–3 (past 1 is a boost, the GainNode's range is
 * open) and the table 0–1 (an element's volume); the defaults (150 %, 100 %) for a field that is not a finite number.
 */
export function volumeGains(v: Partial<PanelVolume> | null | undefined): { voice: number; table: number } {
  const gain = (x: unknown, max: number, dflt: number): number => (typeof x === 'number' && Number.isFinite(x) ? Math.min(max, Math.max(0, x / 100)) : dflt);
  return { voice: gain(v ? v.voice : undefined, 3, 1.5), table: gain(v ? v.table : undefined, 1, 1) };
}

/**
 * D2.8: an SDP this page sends. The table stream's own id becomes `castcade-table-audio`; the m-section that carries
 * it asks for stereo Opus (`stereo=1;sprop-stereo=1` on its fmtp: a table is mixed in stereo, and the receiver's SDP is
 * what lets the other side send it so). Everything else is untouched; with no table stream in it, the SDP is as given.
 */
export function outgoingSdp(sdp: string, tableStreamId: string | null): string {
  if (!tableStreamId || sdp.indexOf(tableStreamId) < 0) return sdp;
  const named = sdp.split(tableStreamId).join('castcade-table-audio');
  return named
    .split(/(?=\r?\nm=)/)
    .map((sec) => {
      if (!/^\r?\nm=audio/.test(sec) || sec.indexOf('msid:castcade-table-audio') < 0) return sec;
      const opus = /a=rtpmap:(\d+) opus\/48000/i.exec(sec);
      if (!opus) return sec;
      return sec.replace(new RegExp('(a=fmtp:' + opus[1] + ' )([^\\r\\n]*)'), (_m: string, head: string, params: string) => {
        let p = params;
        if (!/(^|;)\s*stereo=/.test(p)) p += ';stereo=1';
        if (!/(^|;)\s*sprop-stereo=/.test(p)) p += ';sprop-stereo=1';
        return head + p;
      });
    })
    .join('');
}

/** D8.3: a codec as `RTCRtpSender.getCapabilities('video').codecs` lists it (the DOM's RTCRtpCodecCapability). */
export interface VideoCodecCapability {
  mimeType: string;
  clockRate?: number;
  channels?: number;
  sdpFmtpLine?: string;
}

/**
 * D8.3 (2026-11-05, the owner's 2026-11-04 log): the match video was Chromium's default, VP8 in software, too soft at
 * 5–7 Mbps to read lit rollovers at the top of the playfield. Both rigs have NVIDIA GPUs, and Chromium encodes H.264
 * in hardware through Media Foundation, so the video transceiver's codec preferences put H.264 first: packetization
 * mode 1 before 0; within a mode constrained baseline (`profile-level-id=42e01f`) first, then high level 5 (`640032`),
 * then the other high profiles, then the rest of H.264. Everything else (VP8, VP9, AV1, and the rtx / red / fec entries,
 * which `setCodecPreferences` wants kept) follows in the order given, so a peer without H.264 still negotiates. Pure:
 * the capability entries in, the same entries reordered out (Chromium needs the very objects it listed).
 */
export function preferH264<T extends VideoCodecCapability>(codecs: readonly T[]): T[] {
  const rank = (c: T): number => {
    if (!/^video\/h264$/i.test(c.mimeType)) return -1;
    const f = (c.sdpFmtpLine || '').toLowerCase();
    const mode1 = /(^|;)\s*packetization-mode=1\s*(;|$)/.test(f);
    const m = /(^|;)\s*profile-level-id=([0-9a-f]{6})/.exec(f);
    const profile = (m && m[2]) || '';
    const p = profile === '42e01f' ? 0 : profile === '640032' ? 1 : profile.slice(0, 2) === '64' ? 2 : 3;
    return (mode1 ? 0 : 4) + p;
  };
  const h264: Array<{ c: T; i: number; r: number }> = [];
  const rest: T[] = [];
  codecs.forEach((c, i) => {
    const r = rank(c);
    if (r < 0) rest.push(c);
    else h264.push({ c: c, i: i, r: r });
  });
  h264.sort((a, b) => a.r - b.r || a.i - b.i);
  return h264.map((x) => x.c).concat(rest);
}

/** D8.3: the fmtp hints for a sender capped at `bps` (`videoBitrateFor`): start at the cap, never below 40 % of it. */
export function bitrateHintsFor(bps: number): { startKbps: number; minKbps: number } {
  const kbps = Math.max(1, Math.round(bps / 1000));
  return { startKbps: kbps, minKbps: Math.max(1, Math.round(kbps * 0.4)) };
}

/**
 * D8.3: Chromium's bandwidth estimation starts a sender low and ramps (the loop test read 6.5 Mbps under a 50 Mbps cap
 * ten seconds in; the first ten seconds after every turn switch arrived at 9–25 fps). It reads `x-google-start-bitrate`,
 * `x-google-min-bitrate` and `x-google-max-bitrate` (kbps) from the fmtp line of the video codec in the REMOTE
 * description the sender applies, so the page hints the remote description before `setRemoteDescription`, offer and
 * answer alike (both sides run this code). Every codec of every m=video section gets the hints on its fmtp line (one is
 * added to a payload type that has none; rtx / red / fec payloads are not codecs and get none); audio and everything
 * else are untouched; hints already there are replaced, so hinting twice is the same as once. No other munging:
 * `outgoingSdp` is still the only change to what is sent.
 */
export function withBitrateHints(sdp: string, hints: { startKbps: number; minKbps?: number; maxKbps?: number }): string {
  const eol = sdp.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
  const add: string[] = ['x-google-start-bitrate=' + Math.round(hints.startKbps)];
  if (typeof hints.minKbps === 'number') add.push('x-google-min-bitrate=' + Math.round(hints.minKbps));
  if (typeof hints.maxKbps === 'number') add.push('x-google-max-bitrate=' + Math.round(hints.maxKbps));
  const isHint = (param: string): boolean => /^\s*x-google-(start|min|max)-bitrate=/i.test(param);
  return sdp
    .split(/(?=\r?\nm=)/)
    .map((sec) => {
      if (!/^\r?\nm=video/.test(sec)) return sec;
      const pts: string[] = [];
      const rtpmap = /a=rtpmap:(\d+) ([^/\r\n]+)\//g;
      let m: RegExpExecArray | null;
      while ((m = rtpmap.exec(sec)) !== null) {
        const pt = m[1] || '';
        if (pt && !/^(rtx|red|ulpfec|flexfec-03)$/i.test(m[2] || '')) pts.push(pt);
      }
      let out = sec;
      for (const pt of pts) {
        const fmtp = new RegExp('(^|\\n)(a=fmtp:' + pt + ' )([^\\r\\n]*)');
        if (fmtp.test(out)) {
          out = out.replace(fmtp, (_m: string, lead: string, head: string, params: string) => {
            const kept = params.split(';').filter((p) => p !== '' && !isHint(p));
            return lead + head + kept.concat(add).join(';');
          });
        } else {
          out = out.replace(new RegExp('(a=rtpmap:' + pt + ' [^\\r\\n]*)'), (line: string) => line + eol + 'a=fmtp:' + pt + ' ' + add.join(';'));
        }
      }
      return out;
    })
    .join('');
}

/**
 * D2.9 (2026-11-02, EFUKTZ: ICE sat in `checking` for ever on one rig and went `disconnected` after 15 s on the other;
 * `failed` never came while the players waited). The watchdog's timings: a connection stuck (`checking`, `disconnected`,
 * `failed`, or `new` once signalling is `stable`) restarts ICE after `backoffMs[0]`, again `backoffMs[1]` after that
 * restart, and so on; `backoffMs.length` restarts at most, then, `backoffMs` last after the last one, it gives up and says
 * so. The peer that does not lead the restart (`leadsIceRestart`, rtc-signaling.ts) waits `lagMs` longer each time, so
 * the lead's restart reaches it first and is counted as one of its own.
 *
 * I11.12 (2026-11-24; the owner and ChuckRibbits could not hear each other and had no 3D, while the native video
 * between the same two PCs connected in 0.3 s in every one of eight matches). What the logs of that night and of the
 * nights with Krobs show, and what they do not:
 * - First rounds, by who made the offer: with the owner's PC offering, 0 of 20 connected (the native helper with
 *   Krobs 0 of 10, these pages with ChuckRibbits 0 of 10); with it answering, 18 of 33 (the helper with ChuckRibbits
 *   8 of 8, the pages with Krobs 10 of 25). The helper and these pages pick the offering side by opposite rules.
 * - Restart rounds do not follow that. Led from the owner's PC they never connected with ChuckRibbits (0 of 21, these
 *   pages) and did connect with Krobs (10 of 13, the helper: its first round had failed every time, and its own
 *   restarts, from the same side, then got through). Led by Krobs: 15 of 16 (these pages).
 * - So the logs do not show that the direction of a restart is what decides. That a restart led from the other PC
 *   connects where the lead's did not is a hypothesis, and for the ChuckRibbits pair only: what speaks for it is the
 *   helper's 8 of 8 first rounds in that direction, and no restart round at all. No packet was captured either: that
 *   a router which sees the other PC's check before its own PC's first packet to that address then lets nothing
 *   through for that pair is a reading, not a finding.
 * - What a night on two PCs must show: with ChuckRibbits, `ICE restart 2 of 6` made on his PC (`our turn` in his log,
 *   `by the peer` in the owner's) and the round after it connecting, for the voice and for the tunnel; with Krobs,
 *   that restart 1, now his at 3 s, connects as it did at 10 s (every recorded success was 10 s or more into the
 *   trouble). If restart 2 does not connect with ChuckRibbits the turns have cost nothing (the lead's restarts go on
 *   as in 0.2.50, sooner) and the cause is somewhere else.
 * What was changed on that:
 * - the restarts take turns. Restart 1, 3, 5 is the usual lead's (`leadsIceRestart`), restart 2, 4, 6 the other
 *   side's, so that the other direction is tried at all: in 0.2.50 the other side restarted only when the lead had
 *   not. Both sides count every restart, their own and the peer's, so they agree on whose turn it is. Two that cross
 *   (both at the same moment: the negotiation lets the impolite side's offer stand) are one restart on both sides,
 *   and a restart of the peer's that this side answered while it still read the connection as up is the first of the
 *   spell that begins here within 20 s of it (`notePeerRestart` and `iceWatch` in the pages): a blip one side sees
 *   three or four seconds before the other would else leave the counts at 1 and 0, and with the counts one apart the
 *   same side makes every restart. What still parts them: a restart offer that is lost on the way, or one that takes
 *   more than 2 s to cross another. Nothing stops then (each side steps in after its wait), but the turns do, until
 *   the connection is up or replaced.
 * - they come sooner: `backoffMs` is 3, 3, 6, 6, 12, 12 s (it was 10, 20, 40). All 43 rounds that connected in those
 *   logs did so within 1.08 s of the round's start (the pages 0.42 to 1.08 s, the helper 0.25 to 0.32 s), and none of
 *   the 62 that had not connected by then did so later, however long they ran (10 to 41 s): a round is decided in its
 *   first second, 3 s is almost three times the slowest connect, and the later rounds are longer for a path whose
 *   signalling or round trip is slow. With the 1 s tick the six restarts come at about 3, 7, 14, 21, 34 and 47 s,
 *   where three took 70 s.
 * - the side whose turn it is not waits `lagMs` (3 s: the 1 s tick, the trip of the offer, and the two sides' clocks,
 *   which start up to a second apart) before it restarts in the other's place. For restart 1 and 2 it waits longer,
 *   `waitMs`, because a peer on 0.2.50 or older does not know about turns: it restarts 10 s after the trouble began
 *   when it is the lead (the restart that connected 15 of 16 times with Krobs must not be overtaken by one from the
 *   other end), and 25 s after a first restart when it is not (so against an old non-lead the other direction is still
 *   tried, at about 30 s). After those two an old peer has nothing left that is worth waiting for.
 * - it is never given up: after the sixth restart one more goes out every `lateMs` (30 s), turns alternating, for as
 *   long as the peer is wanted (`iceWatchStep`'s `persist`). A path that is away for a minute or two (a VPN that
 *   reconnects, a router that fails over) while the match's own link stays up was caught by 0.2.50's third restart at
 *   70 s; with the sixth at 47 s and a give-up that was final it would have been lost for the rest of the match.
 *   About 60 s in (12 s after the sixth; it was 110 s) the pages say there is no path so far, and go on.
 * The first round is left as it was (who makes the first offer is `PeerNegotiator`'s, D2.12, and is not changed here):
 * if the hypothesis holds, between two PCs where the lead's direction does not get through round 1 and restart 1 fail
 * and restart 2, the other side's, is the first that can work, about 7 s in. Restart 1 stays the lead's because that
 * is the step the logs have (15 of 16 with Krobs, at 10 s); the other side first would give the same 7 s the other way
 * round. What could make round 1 itself work, the answering side holding its checks back for one signalling trip so
 * that both first checks cross, needs the times the round lines now carry from both PCs before it is built.
 */
export const ICE_WATCH = { backoffMs: [3_000, 3_000, 6_000, 6_000, 12_000, 12_000], lagMs: 3_000, waitMs: [14_000, 28_000], lateMs: 30_000, tickMs: 1_000 } as const;

/** D2.9: the candidate pair a connection uses (or none yet), from `getStats()`; types and protocol only, no address. */
export interface IcePairInfo {
  pair: { state: string; local: string; remote: string; protocol: string; rttMs: number | null } | null;
  /** Candidate pairs the browser formed, and how many of them failed. */
  tried: number;
  failed: number;
  /** Candidate types gathered here and received from the peer (`host`, `srflx`, `prflx`, `relay`), each once, sorted. */
  local: string[];
  remote: string[];
}

/**
 * D2.9: the nominated pair from a `getStats()` report's entries (plain objects): the transport's selected pair, else a
 * nominated succeeded one, else any succeeded one; null when none has worked yet. Never reads an address.
 */
export function icePairInfo(entries: ReadonlyArray<Record<string, unknown>>): IcePairInfo {
  const byId: Record<string, Record<string, unknown>> = {};
  const pairs: Array<Record<string, unknown>> = [];
  const local: string[] = [];
  const remote: string[] = [];
  let selected: unknown = null;
  for (const e of entries) {
    if (typeof e.id === 'string') byId[e.id] = e;
    if (e.type === 'candidate-pair') pairs.push(e);
    else if (e.type === 'transport' && typeof e.selectedCandidatePairId === 'string') selected = e.selectedCandidatePairId;
    else if ((e.type === 'local-candidate' || e.type === 'remote-candidate') && typeof e.candidateType === 'string') {
      const list = e.type === 'local-candidate' ? local : remote;
      if (list.indexOf(e.candidateType) < 0) list.push(e.candidateType);
    }
  }
  let p: Record<string, unknown> | null = typeof selected === 'string' ? (byId[selected] ?? null) : null;
  if (!p) p = pairs.find((x) => x.nominated === true && x.state === 'succeeded') ?? null;
  if (!p) p = pairs.find((x) => x.state === 'succeeded') ?? null;
  let pair: IcePairInfo['pair'] = null;
  if (p) {
    const lc = typeof p.localCandidateId === 'string' ? byId[p.localCandidateId] : undefined;
    const rc = typeof p.remoteCandidateId === 'string' ? byId[p.remoteCandidateId] : undefined;
    const rtt = typeof p.currentRoundTripTime === 'number' && isFinite(p.currentRoundTripTime) ? Math.round(p.currentRoundTripTime * 1000) : null;
    pair = {
      state: typeof p.state === 'string' ? p.state : '?',
      local: lc && typeof lc.candidateType === 'string' ? lc.candidateType : '?',
      remote: rc && typeof rc.candidateType === 'string' ? rc.candidateType : '?',
      protocol: lc && typeof lc.protocol === 'string' ? lc.protocol : '?',
      rttMs: rtt,
    };
  }
  return { pair, tried: pairs.length, failed: pairs.filter((x) => x.state === 'failed').length, local: local.sort(), remote: remote.sort() };
}

/** D2.9: `icePairInfo` for the log: `pair srflx -> srflx udp succeeded, rtt 34 ms`, or `no pair yet (…)`. */
export function icePairText(info: IcePairInfo, withRtt: boolean): string {
  const p = info.pair;
  if (p) return 'pair ' + p.local + ' -> ' + p.remote + ' ' + p.protocol + ' ' + p.state + (withRtt && p.rttMs !== null ? ', rtt ' + p.rttMs + ' ms' : '');
  const types = (l: string[]) => (l.length ? l.join('+') : 'none');
  return 'no pair yet (' + info.tried + ' tried, ' + info.failed + ' failed; local ' + types(info.local) + ', remote ' + types(info.remote) + ')';
}

/** D2.9: the ICE username fragment of an SDP (the first one: bundled, every m-line has the same); it changes on a restart. */
export function iceUfrag(sdp: string | null | undefined): string | null {
  const m = /a=ice-ufrag:(\S+)/.exec(sdp || '');
  return m ? m[1]! : null;
}

/**
 * I11.12 (2026-11-20): what one ICE round did, for the log. Every connect between the owner's and Krobs' routers on
 * 2026-11-16 and 2026-11-18 sat in `checking` until the watchdog's first restart (10 s) and connected half a second
 * after it; voice, the native video and the 3D watch tunnel alike. The logs of those nights say that pairs were formed
 * and none failed, not whether a single check was ever answered or even received. A round is the time from a peer
 * connection's opening (round 1), or from the ICE restart that ended the round before, to the next restart, the
 * connect, or the watchdog giving up. When it ends, one line says, per kind of candidate pair, how many checks were
 * sent and answered and how many were received and answered, and when the round got its remote description, went to
 * `checking` and connected. Shared by the panel page (voice) and the 3D watch page (the tunnel), embedded by source.
 *
 * Never an address, a port, a ufrag or SDP: candidate types, the protocol, the pair's state and counts only. A
 * candidate's stats id (an opaque key of the browser's report) is kept in the page to tell which candidates were
 * already there before the round began (`(old)`: gathered or learned in an earlier round); it is never logged.
 *
 * I11.12 (2026-11-24): two things the lines of that night could not say. A round that ran past 16 s read `0 pairs`:
 * the browser had deleted every pair by then (all of them timed out unanswered), so the counters of each round after
 * the first were lost; they are now kept from the page's last look that still saw pairs (`iceRoundLook`, `kept`), and
 * the line says from when. And who sent first, which is what the reading above rests on: the line now has the time
 * this side's first server-reflexive candidate went to the peer and the peer's first one arrived (`iceRoundCandidate`),
 * and the time a check was first sent, and first received, on a pair with such a candidate (seen in the stats, which
 * the page reads every 50 ms for the first 3 s of a round: `ICE_ROUND_LOOK`).
 */
export interface IceRound {
  /** 1 for the first round of a peer connection. */
  n: number;
  /** When the round began (the page's clock). */
  at: number;
  /** The remote ICE username fragment when the round began (kept to notice the round's own remote description; never logged). */
  ufrag: string | null;
  /** ms from `at` to this round's remote description, and to the first `checking` after it; null: not (yet). */
  remoteMs: number | null;
  checkingMs: number | null;
  /** The candidates that existed before the round began (stats ids), null in round 1. */
  known: { local: string[]; remote: string[] } | null;
  /** The round before ended connected: this one begins when the connection is in trouble again. */
  idle: boolean;
  /**
   * I11.12 (2026-11-24): ms from `at` to this side's first server-reflexive candidate sent to the peer, to the peer's
   * first one received, and to the first look at the stats that showed a check sent, and one received, on a pair of
   * this round's candidates with a server-reflexive (or peer-reflexive) one; null: not (yet).
   */
  srflxOutMs: number | null;
  srflxInMs: number | null;
  checkOutMs: number | null;
  checkInMs: number | null;
}

export function iceRoundStart(n: number, now: number, ufrag: string | null, known: { local: string[]; remote: string[] } | null): IceRound {
  return { n: n, at: now, ufrag: ufrag, remoteMs: null, checkingMs: null, known: known, idle: false, srflxOutMs: null, srflxInMs: null, checkOutMs: null, checkInMs: null };
}

/** I11.12: a state change (or a look) during a round: when its remote description came, and its first `checking`. */
export function iceRoundSeen(round: IceRound, now: number, ice: string, remoteUfrag: string | null): void {
  if (round.idle) {
    if (ice === 'connected' || ice === 'completed') return;
    round.idle = false;
    round.at = now;
    round.ufrag = remoteUfrag;
    round.remoteMs = null;
    round.checkingMs = null;
    round.srflxOutMs = null;
    round.srflxInMs = null;
    round.checkOutMs = null;
    round.checkInMs = null;
  }
  if (round.remoteMs === null && remoteUfrag && remoteUfrag !== round.ufrag) round.remoteMs = now - round.at;
  if (round.checkingMs === null && ice === 'checking' && (round.remoteMs !== null || round.n === 1)) round.checkingMs = now - round.at;
}

/** I11.12: the stats ids of the candidates in a `getStats()` report (for `IceRound.known`; never logged). */
export function iceCandidateIds(entries: ReadonlyArray<Record<string, unknown>>): { local: string[]; remote: string[] } {
  const local: string[] = [];
  const remote: string[] = [];
  for (const e of entries) {
    if (typeof e.id !== 'string') continue;
    if (e.type === 'local-candidate') local.push(e.id);
    else if (e.type === 'remote-candidate') remote.push(e.id);
  }
  return { local: local, remote: remote };
}

/**
 * I11.12: the line for a round that ended (`why`: `connected`, `restart 1 of 3 decided here`, ...), from the report's
 * entries at that moment. Per kind of pair: `host>srflx udp in-progress sent 21 answered 0, received 0 answered 0`
 * (local type > remote type, protocol, the pair's state, then the STUN checks this side sent and the answers it got,
 * and the checks it received and the answers it sent), `(old)` after a candidate that was there before the round
 * began, `selected` / `nominated` where the browser says so; pairs that read the same are counted (`3x`). `only`: leave
 * out pairs whose candidates are not in it (a round's line is taken a moment after the next round began). `asOf`
 * (I11.12, 2026-11-24): the entries are the page's last look that still saw pairs, taken at that clock time, because
 * none were left when the round ended; the line says so (`16 pairs as of 14.02 s (none left at the end)`).
 */
export function iceRoundLine(round: IceRound, now: number, why: string, connected: boolean, ice: string, entries: ReadonlyArray<Record<string, unknown>>, only: { local: string[]; remote: string[] } | null, asOf?: number | null): string {
  const byId: Record<string, Record<string, unknown>> = {};
  let selected: unknown = null;
  for (const e of entries) {
    if (typeof e.id === 'string') byId[e.id] = e;
    if (e.type === 'transport' && typeof e.selectedCandidatePairId === 'string') selected = e.selectedCandidatePairId;
  }
  const num = (v: unknown): number => (typeof v === 'number' && isFinite(v) && v > 0 ? Math.round(v) : 0);
  const word = (v: unknown): string => (typeof v === 'string' && /^[a-z-]{1,16}$/.test(v) ? v : '?');
  const known = round.known;
  const texts: string[] = [];
  const counts: number[] = [];
  /** What a kind is worth in a line that cannot hold every kind: the selected pair, then a pair that worked, then one that carried anything. */
  const ranks: number[] = [];
  let total = 0;
  for (const e of entries) {
    if (e.type !== 'candidate-pair') continue;
    const li = typeof e.localCandidateId === 'string' ? e.localCandidateId : '';
    const ri = typeof e.remoteCandidateId === 'string' ? e.remoteCandidateId : '';
    if (only && (only.local.indexOf(li) < 0 || only.remote.indexOf(ri) < 0)) continue;
    const lc = byId[li];
    const rc = byId[ri];
    const text =
      word(lc && lc.candidateType) +
      (known && known.local.indexOf(li) >= 0 ? '(old)' : '') +
      '>' +
      word(rc && rc.candidateType) +
      (known && known.remote.indexOf(ri) >= 0 ? '(old)' : '') +
      ' ' +
      word(lc && lc.protocol) +
      ' ' +
      word(e.state) +
      (typeof e.id === 'string' && e.id === selected ? ' selected' : e.nominated === true ? ' nominated' : '') +
      ' sent ' +
      num(e.requestsSent) +
      ' answered ' +
      num(e.responsesReceived) +
      ', received ' +
      num(e.requestsReceived) +
      ' answered ' +
      num(e.responsesSent);
    total++;
    const i = texts.indexOf(text);
    if (i >= 0) counts[i] = (counts[i] as number) + 1;
    else {
      texts.push(text);
      counts.push(1);
      ranks.push(typeof e.id === 'string' && e.id === selected ? 0 : e.state === 'succeeded' ? 1 : num(e.requestsSent) + num(e.requestsReceived) > 0 ? 2 : 3);
    }
  }
  const secs = (ms: number): string => (Math.max(0, ms) / 1000).toFixed(2) + ' s';
  const max = 12;
  // The kinds that say most come first (a PC with several network adapters forms dozens of pairs that never send).
  const order = texts.map((_t, i) => i).sort((a, b) => (ranks[a] as number) - (ranks[b] as number) || a - b);
  const shown = order.slice(0, max).map((i) => ((counts[i] as number) > 1 ? counts[i] + 'x ' : '') + texts[i]);
  const at = (ms: number | null): string => (ms === null || ms === undefined ? 'not seen' : 'at ' + secs(ms));
  return (
    'ICE round ' +
    round.n +
    ': ' +
    why +
    ' after ' +
    secs(now - round.at) +
    ' (ice ' +
    word(ice) +
    '); remote description ' +
    at(round.remoteMs) +
    ', checking ' +
    at(round.checkingMs) +
    (connected ? ', connected at ' + secs(now - round.at) : ', not connected') +
    // I11.12 (2026-11-24): who sent first. Before the pairs, so a long list of them never cuts it off.
    '; srflx candidate sent ' +
    at(round.srflxOutMs) +
    ', received ' +
    at(round.srflxInMs) +
    '; first check on a srflx pair sent ' +
    at(round.checkOutMs) +
    ', received ' +
    at(round.checkInMs) +
    '; ' +
    total +
    (total === 1 ? ' pair' : ' pairs') +
    (typeof asOf === 'number' ? ' as of ' + secs(asOf - round.at) + ' (none left at the end)' : '') +
    (shown.length > 0 ? ': ' + shown.join('; ') : '') +
    (texts.length > max ? '; and ' + (texts.length - max) + ' more kinds' : '')
  );
}

/** The part of a page's per-peer record `iceRoundOver` reads and writes. */
export interface IceRoundPeer {
  pc: { iceConnectionState: string; remoteDescription: { sdp?: string } | null; localDescription?: { sdp?: string } | null; getStats?: () => Promise<{ values(): Iterable<unknown> }> };
  round: IceRound;
  /** The candidates at the page's last look at the stats (`iceCandidateIds`), null before the first. */
  ids: { local: string[]; remote: string[] } | null;
  /** When the last rounds ended that the peer ended (its restarts), for `ICE_PEER_ROUNDS`. */
  peerLedAt?: number[];
  /** I11.12 (2026-11-24): the last look at the stats that still saw candidate pairs (`iceRoundLook`): when, and what a round's line needs of it (no address). */
  kept?: { at: number; entries: Array<Record<string, unknown>> } | null;
  /** I11.12 (2026-11-24): when a server-reflexive candidate of the peer's NEXT round arrived (its restart offer is still being answered here); `iceRoundCandidate`. */
  srflxEarly?: number | null;
}

/**
 * I11.12: a peer can restart ICE as often as it likes (every offer with new credentials is one), and each restart
 * ends a round here: at most this many of those rounds are written per peer in this many ms; one line says so, and
 * the rest are counted in silence. Rounds this side ends are bounded by its own watchdog (six restarts, then none, or
 * one every 30 s while the caller says the peer can be reached: `ICE_WATCH`).
 */
export const ICE_PEER_ROUNDS = { max: 4, perMs: 60_000 } as const;

/**
 * I11.12 (2026-11-24): how a page reads the stats for a round's line. For the first `forMs` of a round, every
 * `everyMs`, until a check was seen sent and received on a pair with a server-reflexive candidate (so those two times
 * are right to 50 ms; in a round that fails the second never comes and the page reads for the whole 3 s, 60 reads);
 * after that the page's own look every 2 or 3 s does. A look that sees pairs is kept at most once every `keepMs`.
 */
export const ICE_ROUND_LOOK = { everyMs: 50, forMs: 3_000, keepMs: 1_000 } as const;

/**
 * I11.12 (2026-11-24): a look at the stats of `r` (a `getStats()` report's entries) during a round. It notes the
 * candidates there are (`ids`, as before), keeps what a round's line needs while there still are pairs (the browser
 * deletes them all about 16 s into a round nothing answered: 16.05 to 16.19 s after each restart on 2026-11-24, which
 * is why every later round's line read `0 pairs`), and notes the first look that showed a check sent, and one received,
 * on a pair of this round's own candidates with a server-reflexive or peer-reflexive one. Embedded by its source.
 */
export function iceRoundLook(r: IceRoundPeer, now: number, entries: ReadonlyArray<Record<string, unknown>>): void {
  const byId: Record<string, Record<string, unknown>> = {};
  const local: string[] = [];
  const remote: string[] = [];
  let pairs = 0;
  for (const e of entries) {
    if (typeof e.id !== 'string') continue;
    byId[e.id] = e;
    if (e.type === 'local-candidate') local.push(e.id);
    else if (e.type === 'remote-candidate') remote.push(e.id);
    else if (e.type === 'candidate-pair') pairs++;
  }
  r.ids = { local: local, remote: remote };
  const round = r.round;
  if (round.idle) return;
  if (pairs > 0 && (!r.kept || r.kept.at < round.at || now - r.kept.at >= 1000)) {
    // Only what `iceRoundLine` reads: types, states and counts. No address is ever kept.
    const keys = ['id', 'type', 'candidateType', 'protocol', 'state', 'nominated', 'localCandidateId', 'remoteCandidateId', 'requestsSent', 'responsesReceived', 'requestsReceived', 'responsesSent', 'selectedCandidatePairId'];
    const slim: Array<Record<string, unknown>> = [];
    for (const e of entries) {
      if (e.type !== 'candidate-pair' && e.type !== 'local-candidate' && e.type !== 'remote-candidate' && e.type !== 'transport') continue;
      const o: Record<string, unknown> = {};
      for (const k of keys) if (e[k] !== undefined) o[k] = e[k];
      slim.push(o);
    }
    r.kept = { at: now, entries: slim };
  }
  // Only while the page looks every 50 ms (`ICE_ROUND_LOOK.forMs`, with one look's slack): a first check that a look
  // two or three seconds apart happened to see would be a time that says nothing. `not seen` in a line: not in the first 3 s.
  if ((round.checkOutMs !== null && round.checkInMs !== null) || now - round.at > 3100) return;
  const known = round.known;
  const reflexive = (c: Record<string, unknown> | undefined): boolean => !!c && (c.candidateType === 'srflx' || c.candidateType === 'prflx');
  const count = (v: unknown): number => (typeof v === 'number' && isFinite(v) && v > 0 ? v : 0);
  for (const e of entries) {
    if (e.type !== 'candidate-pair') continue;
    const li = typeof e.localCandidateId === 'string' ? e.localCandidateId : '';
    const ri = typeof e.remoteCandidateId === 'string' ? e.remoteCandidateId : '';
    // A pair with a candidate of an earlier round is not this round's (after a restart the new ports check the old ones too).
    if (known && (known.local.indexOf(li) >= 0 || known.remote.indexOf(ri) >= 0)) continue;
    if (!reflexive(byId[li]) && !reflexive(byId[ri])) continue;
    if (round.checkOutMs === null && count(e.requestsSent) > 0) round.checkOutMs = Math.max(0, now - round.at);
    if (round.checkInMs === null && count(e.requestsReceived) > 0) round.checkInMs = Math.max(0, now - round.at);
  }
}

/**
 * I11.12 (2026-11-24): a candidate went to the peer (`outgoing`) or came from it, as the page's signalling saw it
 * (`candidate`: the candidate line). Only a server-reflexive one counts, and only its time is kept: when this round's
 * first one was sent, and when the peer's first one arrived. Which round a candidate belongs to is read from its
 * `ufrag` (Chromium writes it into the line) against the descriptions in force: one of ours for another description
 * than the current local one is not this round's; one of the peer's for the remote description in force counts once
 * this round has that description; one for a description not applied yet is this round's while the round still waits
 * for its remote description (round 1, a restart made here), and otherwise the peer's next round's, whose restart
 * offer is being answered at that moment (`srflxEarly`, taken over by `iceRoundOver`). Embedded by its source.
 */
export function iceRoundCandidate(r: IceRoundPeer, now: number, outgoing: boolean, candidate: unknown): void {
  if (typeof candidate !== 'string' || !/ typ srflx( |$)/.test(candidate)) return;
  const round = r.round;
  if (round.idle) return;
  const m = / ufrag (\S+)/.exec(candidate);
  const u = m ? m[1] : null;
  const ufragOf = (d: { sdp?: string } | null | undefined): string | null => {
    const x = /a=ice-ufrag:(\S+)/.exec((d && d.sdp) || '');
    return x ? (x[1] as string) : null;
  };
  const ms = Math.max(0, now - round.at);
  if (outgoing) {
    const cur = ufragOf(r.pc.localDescription);
    if (u && cur && u !== cur) return;
    if (round.srflxOutMs === null) round.srflxOutMs = ms;
    return;
  }
  const cur = ufragOf(r.pc.remoteDescription);
  if (u && u !== cur) {
    if (round.remoteMs === null) {
      if (round.srflxInMs === null) round.srflxInMs = ms;
    } else r.srflxEarly = now;
    return;
  }
  // For the remote description in force: this round's once the round has it; before that it is the round before's.
  if (u && round.remoteMs === null && round.n > 1) return;
  if (round.srflxInMs === null) round.srflxInMs = ms;
}

/**
 * A line a page sends for `companion.log`, as main writes it: one line, 400 characters at most; an ICE round's line
 * (`iceRoundLine`: up to twelve kinds of candidate pair) may be 1200.
 */
export function pageLogLine(line: string): string {
  const one = line.replace(/[\r\n]+/g, ' ').trim();
  return one.slice(0, /(^|: )ICE round \d+: /.test(one) ? 1200 : 400);
}

/**
 * I11.12: the round of `r` is over: its line goes to `log` once the stats are in, and the next round begins now.
 * `peerLed`: the round ended because the peer restarted ICE and this side has already answered (its remote description
 * is the new round's). The one function both pages call (the panel page for voice, the 3D watch page for the tunnel).
 */
export function iceRoundOver(r: IceRoundPeer, why: string, connected: boolean, peerLed: boolean, now: number, log: (line: string) => void, sparse?: boolean): void {
  const round = r.round;
  const ice = r.pc.iceConnectionState;
  const next = iceRoundStart(round.n + 1, now, iceUfrag(r.pc.remoteDescription && r.pc.remoteDescription.sdp), r.ids);
  if (peerLed) next.remoteMs = 0;
  // I11.12 (2026-11-24): the peer's first server-reflexive candidate of its restart can be here before its offer is
  // answered (the round changes at the answer): it is the new round's, at its start.
  if (peerLed && typeof r.srflxEarly === 'number' && now - r.srflxEarly < 2000) next.srflxInMs = 0;
  r.srflxEarly = null;
  // I11.12 (2026-11-24): this round's last look that still saw pairs, should none be left now.
  const kept = r.kept && r.kept.at >= round.at ? r.kept : null;
  r.kept = null;
  next.idle = connected;
  r.round = next;
  if (peerLed) {
    // `ICE_PEER_ROUNDS` (the numbers are written out: this function is embedded in the pages by its source).
    const seen = (r.peerLedAt || []).filter((t) => now - t < 60000);
    seen.push(now);
    r.peerLedAt = seen.slice(-5);
    if (seen.length > 4) {
      if (seen.length === 5) log('ICE round ' + round.n + ': the peer restarted ICE more than 4 times in 60 s; the rounds it ends are not written again until that time is up');
      return;
    }
  }
  // A round that did not connect is read a moment after the next one began: only the pairs of the last look count.
  const only = connected ? null : r.ids;
  // I11.12 (2026-11-24): `sparse` (a late round, `iceRoundSparse`): the line is written only if the round has something
  // new to say: a check of this side was answered, or one of the peer's arrived. Nothing answered, nothing received is
  // what every such round says, every 30 s for as long as the match lasts.
  const heard = (entries: ReadonlyArray<Record<string, unknown>>): boolean => entries.some((e) => e.type === 'candidate-pair' && ((typeof e.responsesReceived === 'number' && e.responsesReceived > 0) || (typeof e.requestsReceived === 'number' && e.requestsReceived > 0)));
  const none = (): void => {
    if (kept) {
      if (!sparse || heard(kept.entries)) log(iceRoundLine(round, now, why, connected, ice, kept.entries, null, kept.at));
    } else if (!sparse) log(iceRoundLine(round, now, why, connected, ice, [], null) + ' (no stats)');
  };
  let stats: Promise<{ values(): Iterable<unknown> }> | null;
  try {
    stats = typeof r.pc.getStats === 'function' ? r.pc.getStats() : null;
  } catch {
    stats = null;
  }
  if (!stats || typeof stats.then !== 'function') return none();
  stats.then((rep) => {
    const live = Array.from(rep.values()) as Array<Record<string, unknown>>;
    // I11.12 (2026-11-24): a round nothing answered has no pair left after about 16 s; its counters are the kept look's.
    const left = live.some((e) => e.type === 'candidate-pair' && (!only || (only.local.indexOf(e.localCandidateId as string) >= 0 && only.remote.indexOf(e.remoteCandidateId as string) >= 0)));
    const fromKept = !left && !!kept && !connected;
    const entries = fromKept && kept ? kept.entries : live;
    if (sparse && !connected && !heard(entries)) return;
    if (fromKept && kept) log(iceRoundLine(round, now, why, connected, ice, kept.entries, null, kept.at));
    else log(iceRoundLine(round, now, why, connected, ice, live, only));
  }, none);
}

/**
 * I11.12 (2026-11-24): the pages never give a connection up now: after the `n` scheduled restarts one more goes out
 * every `ICE_WATCH.lateMs` for as long as the peer is wanted (a path that is away for a minute or two comes back, and
 * 0.2.50's third restart at 70 s is the case in point: the sixth is now at about 47 s). Over a three-hour match with a
 * peer that never connects that is about 350 rounds per page, and a line of 600 to 1200 characters for each would be
 * most of `companion.log`'s megabyte. So of the rounds a late restart ends, the first is written (it has the counters
 * of the last scheduled round) and then every tenth, about one in five minutes; the others only when they have
 * something to say (`iceRoundOver`'s `sparse`). `k`: the number of the restart that ends the round. The one line per
 * late restart (`ICE late restart 7 (…)`) is always written.
 */
export function iceRoundSparse(k: number, n: number): boolean {
  return k > n && (k - n) % 10 !== 1;
}

/**
 * D2.9: the watchdog's decision for one connection. `elapsedMs`: since it got stuck, or since the last restart (ours
 * or the peer's) if later; `restarts`: in this stuck spell. `ok`: connected (the caller clears the spell); `wait`;
 * `restart`; `give_up` once `w.backoffMs.length` restarts have not helped. A `failed` connection restarts at once
 * (the browser gave up on every pair); the backoff still holds after a restart. `lead`: this side is the usual lead
 * (`leadsIceRestart`).
 *
 * I11.12 (2026-11-24, `ICE_WATCH` has the evidence): the restarts take turns. The next restart (number `restarts + 1`)
 * is the usual lead's when `restarts` is even and the other side's when it is odd; the side whose turn it is restarts
 * after `backoffMs[restarts]`, the other one only if that did not happen: `lagMs` later, and for the first two
 * restarts not before `waitMs[restarts]` (what a peer on 0.2.50 needs to make its own). `persist`: after the last
 * scheduled restart the answer is never `give_up`; one more restart every `lateMs`, the turns going on. Both pages
 * pass it for every peer (a path that is away for a minute comes back, and a give-up that is final loses it for the
 * rest of the match); without it `give_up` says when the scheduled restarts and their last wait are over, which is
 * the moment the pages say there is no path so far.
 */
export function iceWatchStep(
  ice: string,
  elapsedMs: number,
  restarts: number,
  lead: boolean,
  w: { backoffMs: readonly number[]; lagMs: number; waitMs?: readonly number[]; lateMs?: number },
  persist?: boolean,
): 'ok' | 'wait' | 'restart' | 'give_up' {
  if (ice === 'connected' || ice === 'completed') return 'ok';
  if (ice !== 'new' && ice !== 'checking' && ice !== 'disconnected' && ice !== 'failed') return 'wait';
  const mine = restarts % 2 === 0 ? lead : !lead;
  const lag = mine ? 0 : w.lagMs;
  const n = w.backoffMs.length;
  if (restarts >= n) {
    if (persist && typeof w.lateMs === 'number' && w.lateMs > 0) return elapsedMs >= w.lateMs + lag ? 'restart' : 'wait';
    return elapsedMs >= (w.backoffMs[n - 1] ?? 0) + lag ? 'give_up' : 'wait';
  }
  // The browser gave up on every pair before any restart: nothing is lost by restarting now (the other side `lagMs` later).
  if (ice === 'failed' && restarts === 0) return elapsedMs >= lag ? 'restart' : 'wait';
  const delay = w.backoffMs[restarts] ?? 0;
  const wait = mine ? delay : Math.max(delay + lag, (w.waitMs && w.waitMs[restarts]) || 0);
  return elapsedMs >= wait ? 'restart' : 'wait';
}

/**
 * I11.12 (2026-11-24): the words for restart number `k` of a schedule of `n`: `restart 2 of 6`, and past the schedule
 * (a peer that restarts more often, or the restarts that go on while the picture has a direct path) `late restart 7`.
 */
export function iceRestartName(k: number, n: number): string {
  return k <= n ? 'restart ' + k + ' of ' + n : 'late restart ' + k;
}

/**
 * D2.9: what the panel and the Match tab say once the watchdog gave up on a peer. I11.12 (2026-11-24): `videoDirect`:
 * the native video holds a direct pair to the same peer. Then the routers do let a direct connection through and a
 * TURN relay would change nothing: on 2026-11-24 the panel said "both routers blocked the direct connection; a TURN
 * relay is needed" for forty minutes while the picture went straight between the two PCs. It says what is true
 * instead. `trying`: the watchdog goes on restarting (it always does now: `iceWatchStep`'s `persist`), and the text
 * without a direct picture says so too.
 */
export function noPathText(name: string, ice: string, restarts: number, relay: boolean, videoDirect?: boolean, trying?: boolean): string {
  // D2.12: ICE still `new` never tried a path at all (GNBKHT 2026-11-15): that is the connection, not a router.
  if (ice === 'new') return 'Voice with ' + name + ' did not start (ICE new after ' + restarts + ' restarts): leave the match and join again.';
  if (videoDirect) return 'Voice with ' + name + ' is not connected yet (ICE ' + ice + ' after ' + restarts + ' restarts). The picture has a direct path to their PC, so no relay is needed: still trying.';
  const why = relay ? 'the TURN relay did not get through either' : 'both routers blocked the direct connection; a TURN relay is needed';
  return 'No path to ' + name + ' (ICE ' + ice + ' after ' + restarts + ' restarts): ' + why + '.' + (trying ? ' Still trying.' : '');
}

/**
 * D2.8: the table track's jitter buffer (in the AudioWorklet; samples are interleaved stereo). Starts playing once
 * `prime` samples are in; an underrun plays silence and primes again; more than `high` buffered (the helper's clock
 * runs ahead of the page's) drops the oldest down to `target`, so the delay stays bounded. Embedded by its source.
 */
export function createTableRing(capacity: number, high: number, target: number, prime: number) {
  const buf = new Float32Array(capacity);
  let r = 0;
  let w = 0;
  let n = 0;
  let primed = false;
  return {
    write(s: ArrayLike<number>): void {
      const len = s.length - (s.length % 2);
      for (let i = 0; i < len; i++) {
        buf[w] = s[i] ?? 0;
        w = (w + 1) % capacity;
      }
      n += len;
      if (n > capacity) {
        r = w;
        n = capacity;
      }
      if (n > high) {
        const drop = n - target - ((n - target) % 2);
        r = (r + drop) % capacity;
        n -= drop;
      }
    },
    read(left: Float32Array, right: Float32Array | null): void {
      if (!primed && n >= prime) primed = true;
      for (let i = 0; i < left.length; i++) {
        if (primed && n >= 2) {
          left[i] = buf[r] ?? 0;
          if (right) right[i] = buf[(r + 1) % capacity] ?? 0;
          r = (r + 2) % capacity;
          n -= 2;
        } else {
          left[i] = 0;
          if (right) right[i] = 0;
          primed = false;
        }
      }
    },
    flush(): void {
      r = 0;
      w = 0;
      n = 0;
      primed = false;
    },
    buffered: (): number => n,
  };
}

/** D2.8: the ring's sizes, in samples of interleaved stereo at 48 kHz: 1 s held at most, 150 ms high, 60 ms target, 40 ms to start. */
export const TABLE_RING = { capacity: 96_000, high: 14_400, target: 5_760, prime: 3_840 } as const;

/** D2.8: the AudioWorklet module the table track is played from (loaded from a Blob URL; the ring embedded by source). */
export function tableWorkletSource(): string {
  const ring = [TABLE_RING.capacity, TABLE_RING.high, TABLE_RING.target, TABLE_RING.prime].join(', ');
  return [
    createTableRing.toString(),
    'class CastcadeTableRing extends AudioWorkletProcessor {',
    '  constructor() {',
    '    super();',
    '    this.ring = createTableRing(' + ring + ');',
    "    this.port.onmessage = (e) => { if (e.data === 'flush') this.ring.flush(); else this.ring.write(new Float32Array(e.data)); };",
    '  }',
    '  process(inputs, outputs) {',
    '    const out = outputs[0];',
    '    if (out && out[0]) this.ring.read(out[0], out[1] || null);',
    '    return true;',
    '  }',
    '}',
    "registerProcessor('castcade-table-ring', CastcadeTableRing);",
  ].join('\n');
}

const HELPERS = [cameraCapture, isCameraCapture, cameraFrameSize, eyesKey, stereoSignal, videoBitrateFor, shortName, headerText, scoreText, stripRows, watchingText, tallyText, micText, videoPeer, stageText, videoCropRect, paintFrame, stereoOf, feedSize, stallStep, trackRole, tablePlays, volumeGains, outgoingSdp, preferH264, bitrateHintsFor, withBitrateHints, icePairInfo, icePairText, iceUfrag, iceWatchStep, iceRestartName, noPathText, iceRoundStart, iceRoundSeen, iceCandidateIds, iceRoundLine, iceRoundOver, iceRoundSparse, iceRoundLook, iceRoundCandidate];

/** The page. `vr`: drawn offscreen for the headset (960x640) rather than as a 480x720 desktop window; same layout. */
export function panelPageHtml(opts: { vr: boolean }): string {
  const helpers = HELPERS.map((f) => f.toString()).join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Castcade match</title>
<style>
  :root { --bg: #000; --panel: #11141b; --text: #fff; --dim: #b8c0cc; --mine: #ffd400; --up: #4fd1ff; --bad: #ff6b6b; }
  * { box-sizing: border-box; margin: 0; }
  html, body { height: 100%; background: var(--bg); color: var(--text); overflow: hidden;
    font-family: 'Segoe UI', system-ui, sans-serif; font-weight: 700; }
  /* A17 step 9 (2026-11-27): the one column is as wide as the page and no wider. Without this a long line in the
     footer (the lobby's sentences are long) made the column as wide as the sentence: the header slid off centre and
     the scores off the right edge. Seen in the first pictures ever taken of this page (renderer/story). */
  body { display: grid; grid-template-columns: minmax(0, 1fr); grid-template-rows: auto 1fr auto auto; gap: 1vmin; padding: 1.5vmin; }
  #head { font-size: 7.5vmin; line-height: 1.1; letter-spacing: 0.04em; text-align: center; padding: 1vmin 0; }
  #head { overflow: hidden; overflow-wrap: anywhere; }
  #head.mine { color: var(--mine); }
  #head .sub { font-size: 4vmin; letter-spacing: 0.02em; color: var(--dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #stage { position: relative; min-height: 0; background: var(--panel); border-radius: 1vmin; overflow: hidden; }
  #video { width: 100%; height: 100%; object-fit: contain; display: block; background: #000; }
  #idle { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; text-align: center;
    padding: 4vmin; font-size: 4.5vmin; color: var(--dim); }
  #strip { display: grid; gap: 0.6vmin; }
  .row { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 2vmin; align-items: baseline; padding: 0.6vmin 1.5vmin;
    background: var(--panel); border-radius: 0.8vmin; font-size: 4.8vmin; }
  .row.up { outline: 0.5vmin solid var(--up); }
  .row .name { display: flex; align-items: baseline; min-width: 0; white-space: nowrap; }
  .row .name .nm { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .row .name .flag, .row .name .note { flex: none; }
  .row .detail { color: var(--dim); font-size: 3.6vmin; }
  .row .score { font-variant-numeric: tabular-nums; }
  .row .flag { color: var(--bad); font-size: 3vmin; margin-left: 1.5vmin; }
  .row .note { color: var(--dim); font-size: 3vmin; font-weight: 400; margin-left: 1.5vmin; }
  .tally { padding: 0.2vmin 1.5vmin; color: var(--dim); font-size: 3.4vmin; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  footer { display: flex; gap: 2vmin; align-items: baseline; font-size: 3.8vmin; min-height: 4.5vmin; min-width: 0; }
  #mic { color: var(--dim); white-space: nowrap; }
  #mic.muted, #mic.none { color: var(--bad); }
  /* Step 9: the line is read to its end: it wraps (the stage gives the room; the longest lobby sentence is three
     lines in the headset and six in the desktop window), and is cut only past that. It was one line cut with "…",
     which dropped the half of a lobby sentence that says what to do. */
  #msg { flex: 1; min-width: 0; overflow: hidden; line-height: 1.15; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 6; }
  #vid { color: var(--dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #vid:empty { display: none; }
  /* D8.10: the in-game menu covers the stage and the score strip; the header and the footer stay. */
  #menu { display: none; grid-row: 2 / 4; grid-column: 1; position: relative; z-index: 2; background: var(--panel);
    border-radius: 1vmin; padding: 2vmin; flex-direction: column; gap: 0.8vmin; min-height: 0; overflow: hidden; }
  #menu.open { display: flex; }
  /* A17 step 9 (2026-11-27): the list is a window onto the lines, and keeps the chosen one in it. A lobby's menu has
     up to thirteen lines where a match's had seven: the lines past the seventh were cut off, and with them the
     question under the list and the keys (seen in the first pictures of this page, renderer/story). */
  #menuitems { display: grid; grid-template-columns: minmax(0, 1fr); gap: 0.8vmin; align-content: start; flex: 1 1 auto; min-height: 0; overflow: hidden; padding: 0.6vmin; margin: -0.6vmin; scroll-padding-block: 1.2vmin; }
  .more { flex: 0 0 auto; font-size: 2.6vmin; line-height: 1; text-align: center; color: var(--dim); visibility: hidden; }
  .more.on { visibility: visible; }
  #head { grid-row: 1; } #stage { grid-row: 2; grid-column: 1; } #strip { grid-row: 3; grid-column: 1; } footer { grid-row: 4; }
  .mi > span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .mi .val { flex: none; }
  .mi { display: flex; justify-content: space-between; gap: 2vmin; padding: 1vmin 2vmin; border-radius: 0.8vmin;
    font-size: 5vmin; background: #1b2029; }
  .mi.sel { outline: 0.6vmin solid var(--mine); color: var(--mine); }
  .mi.off { color: var(--dim); }
  .mi .val { font-variant-numeric: tabular-nums; }
  /* Step 9: the question and the keys keep their own height (a question of two lines ran into the keys under it); the list gives the room. */
  #menunote { flex: 0 0 auto; font-size: 3.8vmin; line-height: 1.15; color: var(--mine); min-height: 4.5vmin; }
  #menuhint { flex: 0 0 auto; font-size: 3vmin; font-weight: 400; color: var(--dim); }
</style></head>
<body class="${opts.vr ? 'vr' : 'desktop'}">
<div id="head">CASTCADE MATCH</div>
<div id="stage"><video id="video" autoplay playsinline muted></video><div id="idle"></div></div>
<video id="src" autoplay playsinline muted style="position: fixed; left: 0; top: 0; width: 2px; height: 2px; opacity: 0; pointer-events: none"></video>
<div id="strip"></div>
<div id="menu"><div id="menuup" class="more">▲ MORE</div><div id="menuitems"></div><div id="menudown" class="more">▼ MORE</div><div id="menunote"></div><div id="menuhint"></div></div>
<footer><span id="mic"></span><span id="vid"></span><span id="msg"></span></footer>
<script>
'use strict';
const { ipcRenderer } = require('electron');
const C = ${JSON.stringify(PANEL_CHANNELS)};
const VIDEO = ${JSON.stringify(PANEL_VIDEO)};
const FEED_FPS = ${VIDEO_FEED_MAX.fps};
const STALL_MS = ${CAPTURE_STALL_MS};
const STATS_MS = ${STATS_MS};
const ICE_WATCH = ${JSON.stringify(ICE_WATCH)};
const ICE_ROUND_LOOK = ${JSON.stringify(ICE_ROUND_LOOK)};
const TABLE_WORKLET = ${JSON.stringify(tableWorkletSource())};
const SAVE_QUALITY = ${IN_JPEG_QUALITY};
const VOLUME_NOTE_MS = ${VOLUME_NOTE_MS};
${helpers}
${negotiationSource()}
${PAGE_SCRIPT}
</script>
</body></html>
`;
}

/** page -> main: `{ mics: MicDevice[] | null, error: string | null }` from the microphone list page. */
export const MIC_LIST_CHANNEL = 'castcade-mics:list';

/**
 * B22 (2026-10-31): a hidden page in the panel's partition that lists the microphones before a match, so the Match
 * tab's picker is filled before Host / Join (tester Krobs saw "Windows default" alone). Chromium hides the labels
 * (and the ids) until the page has had the microphone once: then it opens it, stops the track at once and lists
 * again. Same mapping as the panel page's `sendDevices`.
 */
export function micListPageHtml(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Castcade microphones</title></head><body>
<script>
'use strict';
const { ipcRenderer } = require('electron');
const CH = ${JSON.stringify(MIC_LIST_CHANNEL)};
async function inputs() {
  const all = await navigator.mediaDevices.enumerateDevices();
  return all.filter((d) => d.kind === 'audioinput');
}
(async () => {
  try {
    let found = await inputs();
    if (found.length > 0 && found.some((d) => !d.label || !d.deviceId)) {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      for (const t of s.getTracks()) t.stop();
      found = await inputs();
    }
    const mics = found.filter((d) => d.deviceId).map((d) => ({ deviceId: d.deviceId, label: d.label || 'Microphone' }));
    ipcRenderer.send(CH, { mics, error: null });
  } catch (e) {
    ipcRenderer.send(CH, { mics: null, error: e && e.message ? String(e.message) : String(e) });
  }
})();
</script>
</body></html>
`;
}

/**
 * The page's own logic (plain JS; no template literals, so nothing here is interpolated by the TS template above).
 * Media: one local MediaStream (mic + capture), `addTrack` on every connection (addTrack transceivers are reused when
 * offers cross; addTransceiver ones are not), the video track enabled only while sending, `maxBitrate` set once the
 * sender has encodings, remote audio played through one GainNode per peer (D2.10; its <audio> stays attached but muted,
 * see routeVoice), the stage <video> muted.
 */
const PAGE_SCRIPT = String.raw`
let mesh = null;
let localId = null;
let ice = [];
let sending = false;
let muted = false;
let micTrack = null;
let micState = 'unavailable';
let videoTrack = null;
// D2.5: the screen capture (srcTrack, played into the hidden <video id="src">: a 2px transparent element rather than
// display:none, so Chromium keeps producing frames) and the live capture's crop; videoTrack is the canvas's track.
let srcTrack = null;
let cap = null;
let covered = false;
// D7.4.4: the capture watch (see srcTick) and the 10 s counters (see statsTick).
let watch = { mark: -1, at: Date.now() };
let stalled = false;
let capFrames = 0;
let statsSeq = 0;
let stats = null;
const canvas = document.createElement('canvas');
const ctx = canvas.getContext('2d', { alpha: false });
let panel = null;
let localError = null;
let stageKey = null;
const localStream = new MediaStream();
const remote = new Map();
// D2.7: how often each peer's connection was replaced (a reset, or an offer the old one refused); kept across reopens.
const reopens = new Map();
// D7.4.3: this rig's declared stereo (undefined until a capture says; null = not known) and each peer's.
let myStereo = undefined;
const peerStereo = new Map();
/** D7.5.2: a peer's eyes from its stereo signal (two of fov, rect, render) or null; handed to main with every theater frame. */
const peerEyes = new Map();
// D7.5.1: the capture is the VR layer camera (cap is cameraCapture(...)): main sends the eyes on C.cameraFrame and
// they are drawn side by side onto the canvas; camFrames is the stall watch's mark, camBad the frames that did not
// decode; myEyes / myEyesKey the eyes' geometry the stereo declaration carries.
let camMode = false;
let camFrames = 0;
let camBad = 0;
let myEyes = null;
let myEyesKey = null;
// D7.6: the VR test bench (startBench); null outside it. A page runs either a bench or an attach, never both.
let bench = null;
// D2.10: the playback gains (volumeGains, from main's C.volume) and the footer's short-lived note after a shortcut press.
let gains = volumeGains(null);
let volumeNote = null;
let volumeNoteTimer = null;
// D8.10: the in-game menu while it is open (PanelMenu), else null.
let menu = null;
const $ = (id) => document.getElementById(id);
const errText = (e) => (e && e.message ? e.message : String(e));

function report() {
  const peers = {};
  for (const [id, r] of remote) {
    const v = r.stream.getVideoTracks()[0];
    const a = r.stream.getAudioTracks()[0];
    const tt = r.tableStream.getAudioTracks()[0];
    peers[id] = {
      receivingTable: !!tt && tt.readyState === 'live' && !tt.muted,
      ice: r.pc.iceConnectionState,
      receivingVideo: !!v && v.readyState === 'live' && !v.muted,
      receivingAudio: !!a && a.readyState === 'live' && !a.muted,
      signaling: r.pc.signalingState,
      reopens: reopens.get(id) || 0,
    };
    // I11.12 (2026-11-24): the late restarts are on for this peer: main does not write each of its state changes.
    if (r.watch && lateSpell(r)) peers[id].quiet = true;
  }
  ipcRenderer.send(C.status, { sending: sending, peers: peers, mic: micState, capturing: !!videoTrack, error: noPathMessage() || localError, captureStalled: stalled, stats: stats });
}

/** A17: a connection to another player is up (the lobby's stage then says that the microphone is heard, stageText). */
function voiceUp() {
  for (const r of remote.values()) {
    const st = r.pc.iceConnectionState;
    if (st === 'connected' || st === 'completed') return true;
  }
  return false;
}

function fail(msg) {
  localError = msg;
  report();
  render();
}

function render() {
  const head = $('head');
  if (bench) {
    head.textContent = 'VR TEST BENCH';
    head.className = '';
  } else if (!panel) {
    head.textContent = 'CASTCADE MATCH';
    head.className = '';
  } else {
    // A17 step 9: a table change is two lines at most: CHANGING TABLE, and the table's name under it, smaller and cut
    // when it is long (in one line of the header's size a name of four words made three lines of it).
    const text = headerText(panel);
    const mark = 'CHANGING TABLE · ';
    const name = text.indexOf(mark) === 0 ? text.slice(mark.length) : '';
    head.textContent = name ? 'CHANGING TABLE' : text;
    if (name && head.appendChild) {
      const sub = document.createElement('div');
      sub.className = 'sub';
      sub.textContent = name;
      head.appendChild(sub);
    }
    head.className = panel.myTurn && panel.phase === 'playing' ? 'mine' : '';
  }
  // D7.6: the bench's stage is its canvas (path direct) or the local loop's received track (path loop).
  const who = !bench && panel ? videoPeer(panel) : null;
  let stream = null;
  if (bench) stream = bench.stageStream;
  else if (who === 'self') stream = videoTrack ? new MediaStream([videoTrack]) : null;
  else if (who && remote.has(who)) stream = remote.get(who).stream;
  const key = bench ? 'bench:' + bench.streamN : who === 'self' ? 'self:' + (videoTrack ? videoTrack.id : '') : who ? 'peer:' + who : '';
  const video = $('video');
  if (key !== stageKey) {
    stageKey = key;
    video.srcObject = stream;
  }
  const hasVideo = !!stream && stream.getVideoTracks().some((t) => t.readyState === 'live' && (who === 'self' || !t.muted));
  $('idle').textContent = bench ? (bench.drawn > 0 && stream ? '' : 'WAITING FOR FRAMES') : stageText(panel, hasVideo, voiceUp());
  const strip = $('strip');
  strip.replaceChildren();
  for (const row of panel ? stripRows(panel) : []) {
    const el = document.createElement('div');
    el.className = row.up ? 'row up' : 'row';
    const name = document.createElement('span');
    name.className = 'name';
    // The final review (finding 10): the name is cut in a box of its own, so that the flag beside it is never what goes.
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = row.name;
    name.appendChild(nm);
    for (const f of row.flags) {
      const flag = document.createElement('span');
      flag.className = 'flag';
      flag.textContent = f;
      name.appendChild(flag);
    }
    for (const n of row.notes) {
      const note = document.createElement('span');
      note.className = 'note';
      note.textContent = n;
      name.appendChild(note);
    }
    const detail = document.createElement('span');
    detail.className = 'detail';
    detail.textContent = row.detail;
    const score = document.createElement('span');
    score.className = 'score';
    score.textContent = row.score;
    el.append(name, detail, score);
    strip.appendChild(el);
  }
  // D8.12: the session tally under the scores once a game has been played (games played, each player's wins).
  if (panel && panel.series && panel.series.length > 0) {
    const tally = document.createElement('div');
    tally.className = 'tally';
    tally.textContent = tallyText(panel);
    strip.appendChild(tally);
  }
  // A17 step 9: who watches the game that is being played.
  const watching = panel ? watchingText(panel) : '';
  if (watching) {
    const line = document.createElement('div');
    line.className = 'tally';
    line.textContent = watching;
    strip.appendChild(line);
  }
  const mic = panel ? panel.mic : micState;
  $('mic').textContent = micText(mic);
  $('mic').className = mic === 'open' ? '' : mic === 'muted' ? 'muted' : 'none';
  renderMenu();
  $('vid').textContent = bench ? '' : videoLine;  // D10.5: the native video's rung and rate, one short line
  $('msg').textContent = volumeNote || (bench && bench.error) || noPathMessage() || (panel && panel.message) || localError || '';
  routeTable();
}

// D8.10: the in-game menu (main's C.menu): the lines, the chosen one outlined, a note and the keys under them.
function renderMenu() {
  $('menu').className = menu ? 'open' : '';
  // A17 step 9: the score strip is under the menu, and the outline of the row of the player who is up showed past the menu's edges.
  const under = $('strip');
  if (under && under.style) under.style.visibility = menu ? 'hidden' : '';
  const list = $('menuitems');
  list.replaceChildren();
  if (!menu) return;
  menu.items.forEach((it, i) => {
    const el = document.createElement('div');
    el.className = 'mi' + (i === menu.index ? ' sel' : '') + (it.off ? ' off' : '');
    const label = document.createElement('span');
    label.textContent = it.label;
    const val = document.createElement('span');
    val.className = 'val';
    val.textContent = it.value || '';
    el.append(label, val);
    list.appendChild(el);
  });
  $('menunote').textContent = menu.note || '';
  $('menuhint').textContent = menu.hint || '';
  // A17 step 9: the chosen line is in sight, and the list says when there are lines above or below what it shows.
  const sel = list.children[menu.index];
  if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: 'nearest' });
  const up = $('menuup');
  const down = $('menudown');
  if (up) up.className = list.scrollTop > 1 ? 'more on' : 'more';
  if (down) down.className = list.scrollTop + list.clientHeight < list.scrollHeight - 1 ? 'more on' : 'more';
}

async function sendDevices() {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    const mics = all.filter((d) => d.kind === 'audioinput').map((d) => ({ deviceId: d.deviceId, label: d.label || 'Microphone' }));
    ipcRenderer.send(C.devices, mics);
  } catch (e) {
    ipcRenderer.send(C.devices, []);
  }
}
navigator.mediaDevices.addEventListener('devicechange', () => void sendDevices());

async function getMic(deviceId) {
  const base = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  if (!deviceId) return navigator.mediaDevices.getUserMedia({ audio: base, video: false });
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: Object.assign({ deviceId: { exact: deviceId } }, base), video: false });
  } catch (e) {
    localError = 'The chosen microphone is not available; using the Windows default.';
    return navigator.mediaDevices.getUserMedia({ audio: base, video: false });
  }
}

/** The match goes on without voice from this rig when there is no microphone: never throw. */
async function openMic(deviceId) {
  try {
    const s = await getMic(deviceId);
    const t = s.getAudioTracks()[0];
    if (!t) throw new Error('no audio track');
    t.enabled = !muted;
    const old = micTrack;
    micTrack = t;
    if (old) {
      localStream.removeTrack(old);
      old.stop();
    }
    localStream.addTrack(t);
    for (const r of remote.values()) attachAudio(r);
    micState = muted ? 'muted' : 'open';
  } catch (e) {
    micState = 'unavailable';
    localError = 'No microphone (' + errText(e) + '); the others will not hear you.';
  }
  void sendDevices();
  report();
  render();
}

/** D2.5: one frame of the match video onto the canvas (the crop, or the cover). D7.5.1: the camera draws per frame. */
function paint() {
  if (!cap || !ctx || camMode) return;
  try { paintFrame(ctx, $('src'), cap, covered); } catch (e) { /* a frame lost; the next tick draws again */ }
}

/** A new crop for the live capture: the canvas takes the output size (a new size resets it, so it is drawn at once). */
function setCrop(c) {
  cap = c;
  for (const r of remote.values()) void applyBitrate(r);
  if (canvas.width !== c.out.width) canvas.width = c.out.width;
  if (canvas.height !== c.out.height) canvas.height = c.out.height;
  paint();
}

/** Stops the capture (main found no window any more, or the screen capture ended): the peers get no frames. */
function dropCapture() {
  const src = srcTrack;
  const out = videoTrack;
  srcTrack = null;
  videoTrack = null;
  cap = null;
  camMode = false;
  stalled = false;
  $('src').srcObject = null;
  if (src) src.stop();
  if (out) {
    localStream.removeTrack(out);
    out.stop();
  }
  report();
  render();
}

/**
 * D2.5: the capture is the whole display (legacy desktop getUserMedia with the screen source id, at the display's own
 * size so the crop stays sharp; getDisplayMedia, which main answers with the same source, if that fails), drawn cropped
 * onto the canvas. The canvas track outlives a change of display: the peers keep their sender and nothing renegotiates.
 */
/**
 * D7.4.3: a new declared stereo goes to every peer (a new connection gets it from openPeer); none given, nothing said.
 * D7.5.1: with the layer camera's eyes (side by side only), re-sent when their geometry changes too.
 */
function noteStereo(s, eyes) {
  if (s === undefined) return;
  const v = s === 'sbs' || s === 'mono' ? s : null;
  const e = v === 'sbs' && eyes ? eyes : null;
  const k = eyesKey(e);
  if (v === myStereo && k === myEyesKey) return;
  myStereo = v;
  myEyes = k === null ? null : e;
  myEyesKey = k;
  if (mesh) for (const id of remote.keys()) sendStereo(id);
}
function sendStereo(peer) {
  if (myStereo === undefined) return;
  ipcRenderer.send(C.send, { to: peer, signal: stereoSignal(myStereo, myEyes) });
}

/** The canvas's track, made once and kept (on every connection: the peers keep their sender, nothing renegotiates). */
function ensureVideoTrack(label) {
  if (videoTrack && videoTrack.readyState === 'live') return true;
  const out = canvas.captureStream(VIDEO.fps).getVideoTracks()[0];
  if (!out) {
    fail('Could not capture ' + label + ' (the canvas gave no track).');
    return false;
  }
  // D7.4.6: theater shows this life-size in a headset, so under a thin uplink keep the resolution and drop frames.
  try { out.contentHint = 'detail'; } catch (e) { /* older engines */ }
  out.enabled = sending && !stalled;
  videoTrack = out;
  localStream.addTrack(out);
  for (const r of remote.values()) attachVideo(r);
  return true;
}

/**
 * D7.5.1 (2026-11-02): the capture is the VR layer camera. No screen is opened (a live one is stopped); the canvas
 * keeps its track and takes the camera's size (2w x h), so the peers keep their sender; the declaration is side by
 * side whatever the preview setting says. Frames arrive on C.cameraFrame. D8.1 (2026-11-05): a mono camera capture
 * (one eye, w x h) declares mono with no eyes: the receivers show it as the flat screen.
 */
function openCamera(c) {
  const fresh = !camMode;
  camMode = true;
  if (srcTrack) {
    const s = srcTrack;
    srcTrack = null;
    $('src').srcObject = null;
    s.stop();
  }
  if (fresh) {
    camFrames = 0;
    watch = { mark: 0, at: Date.now() };
    applyStall(false);
  }
  if (c.stereo === 'mono') noteStereo('mono', null);
  else noteStereo('sbs', myEyes);
  setCrop(c);
  if (!ensureVideoTrack(c.label)) return;
  if (localError && localError.indexOf('Could not capture') === 0) localError = null;
  report();
  render();
}

/**
 * D7.5.1: one camera frame: both JPEGs decoded, drawn left | right, counted; the ack goes whatever happened. D8.1: a
 * one-eye frame (the other eye null) is drawn alone at (0, 0) on a w x h canvas and declared mono without eye geometry.
 */
async function drawCamera(f) {
  const size = cameraFrameSize(f);
  if (!camMode || !ctx || !size || typeof createImageBitmap !== 'function') {
    if (camMode && !size) camBad++;
    ipcRenderer.send(C.cameraAck);
    return;
  }
  const mono = size.stereo === 'mono';
  let l = null;
  let r = null;
  try {
    const both = await Promise.all([
      createImageBitmap(new Blob([mono ? f.left || f.right : f.left], { type: 'image/jpeg' })),
      mono ? Promise.resolve(null) : createImageBitmap(new Blob([f.right], { type: 'image/jpeg' })),
    ]);
    l = both[0];
    r = both[1];
    if (camMode) {
      const w = size.width;
      const h = size.height;
      const W = mono ? w : 2 * w;
      if (!cap || cap.out.width !== W || cap.out.height !== h || (cap.stereo === 'mono') !== mono) setCrop(cameraCapture(w, h, size.stereo));
      ctx.drawImage(l, 0, 0, l.width || w, l.height || h, 0, 0, w, h);
      if (r) ctx.drawImage(r, 0, 0, r.width || w, r.height || h, w, 0, w, h);
      camFrames++;
      if (mono) noteStereo('mono', null);
      else noteStereo('sbs', f.eyes || null);
    }
  } catch (e) {
    camBad++;
  } finally {
    if (l && typeof l.close === 'function') l.close();
    if (r && typeof r.close === 'function') r.close();
    ipcRenderer.send(C.cameraAck);
  }
}

async function openCapture(c) {
  if (!c) {
    if (srcTrack || videoTrack) dropCapture();
    return;
  }
  if (isCameraCapture(c)) {
    openCamera(c);
    return;
  }
  // D7.5.1: back from the layer camera to a screen: opened afresh; the canvas track stays.
  if (camMode) {
    camMode = false;
    cap = null;
    // The eyes go with the camera; a screen that declares nothing is not known (not the camera's side by side).
    noteStereo(c.stereo === undefined ? null : c.stereo);
  }
  noteStereo(c.stereo);
  if (!c.restart && cap && srcTrack && srcTrack.readyState === 'live' && cap.sourceId === c.sourceId) {
    setCrop(c);
    return;
  }
  let s = null;
  try {
    s = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: c.sourceId, maxWidth: c.screen.width, maxHeight: c.screen.height, maxFrameRate: VIDEO.fps } },
    });
  } catch (e1) {
    try {
      s = await navigator.mediaDevices.getDisplayMedia({ audio: false, video: { width: c.screen.width, height: c.screen.height, frameRate: VIDEO.fps } });
    } catch (e2) {
      fail('Could not capture ' + c.label + ' (' + errText(e1) + '); the others will not see your table.');
      return;
    }
  }
  const t = s.getVideoTracks()[0];
  if (!t) {
    fail('Could not capture ' + c.label + ' (no video track).');
    return;
  }
  const oldSrc = srcTrack;
  srcTrack = t;
  if (oldSrc) oldSrc.stop();
  const v = $('src');
  v.srcObject = new MediaStream([t]);
  void Promise.resolve(v.play()).catch(() => undefined);
  // D7.4.4: a fresh track starts a fresh watch; the senders get the canvas track back if a stall had taken it off.
  watch = { mark: -1, at: Date.now() };
  applyStall(false);
  setCrop(c);
  t.addEventListener('ended', () => {
    if (srcTrack !== t) return;
    dropCapture();
    fail('The capture of ' + c.label + ' ended (the display went away?).');
  });
  if (!ensureVideoTrack(c.label)) return;
  if (localError && localError.indexOf('Could not capture') === 0) localError = null;
  report();
  render();
}

/**
 * D2.5: the draw loop. A timer, not requestAnimationFrame: the headset panel is an offscreen window painted at 20 fps
 * (rAF would cap the video there) and the desktop panel is hidden until the match shows it (no rAF at all); the window
 * has backgroundThrottling off, so the timer keeps its rate. While this rig is not up the track is disabled and the
 * canvas is drawn once a second only.
 */
let tick = 0;
setInterval(() => {
  tick++;
  if (!videoTrack) return;
  if (!sending && tick % VIDEO.fps !== 0) return;
  paint();
}, Math.round(1000 / VIDEO.fps));

/**
 * D7.4.4 (2026-11-01): the draw loop above keeps the canvas track producing frames whatever the screen does, so a
 * capture that stopped delivering (the owner's theater showed a still picture while frames kept arriving; Krobs' feed
 * froze once VPX had focus) looks alive to the receivers. This watches the hidden video's own frame counter instead.
 * Stalled while sending: the canvas track comes off the connections (the receivers' video mutes: "waiting for <name>'s
 * table", not a frozen frame) and main is told through the report to re-pick the capture.
 */
function applyStall(on) {
  if (stalled === on) return;
  stalled = on;
  if (videoTrack) videoTrack.enabled = sending && !stalled;
  for (const r of remote.values()) {
    if (r.videoSender && videoTrack) void Promise.resolve(r.videoSender.replaceTrack(on ? null : videoTrack)).catch(() => undefined);
  }
  report();
  render();
}
function srcTick() {
  // D7.5.1: the layer camera's mark is the count of frames drawn; a stall goes through main's fallback.
  if (camMode) {
    const cw = stallStep(watch, camFrames, Date.now(), sending, STALL_MS);
    if (cw.moved) capFrames += Math.max(1, camFrames - watch.mark);
    watch = { mark: cw.mark, at: cw.at };
    applyStall(cw.stalled);
    return;
  }
  if (!srcTrack) {
    watch = { mark: -1, at: Date.now() };
    applyStall(false);
    return;
  }
  const v = $('src');
  const q = typeof v.getVideoPlaybackQuality === 'function' ? v.getVideoPlaybackQuality() : null;
  const counted = !!q && q.totalVideoFrames > 0;
  const mark = counted ? q.totalVideoFrames : typeof v.currentTime === 'number' ? v.currentTime : -1;
  const w = stallStep(watch, mark, Date.now(), sending, STALL_MS);
  if (w.moved) capFrames += counted && watch.mark >= 0 ? Math.max(1, mark - watch.mark) : 1;
  watch = { mark: w.mark, at: w.at };
  applyStall(w.stalled);
}
setInterval(srcTick, 400);

/** D7.4.4: every 10 s, while relevant: what the capture delivered (sending) and what theater decoded / sent on. */
let decodedLast = -1;
let feedSent = 0;
function statsTick() {
  let capture = null;
  let decoded = null;
  let toLayer = null;
  if (sending && (srcTrack || camMode)) capture = capFrames;
  capFrames = 0;
  const unreadable = camBad;
  camBad = 0;
  const who = panel ? videoPeer(panel) : null;
  if (feedWanted && who && who !== 'self') {
    const v = $('video');
    const q = typeof v.getVideoPlaybackQuality === 'function' ? v.getVideoPlaybackQuality() : null;
    if (q) {
      decoded = decodedLast >= 0 && q.totalVideoFrames >= decodedLast ? q.totalVideoFrames - decodedLast : q.totalVideoFrames;
      decodedLast = q.totalVideoFrames;
    } else decoded = feedSent;
    toLayer = feedSent;
  } else decodedLast = -1;
  feedSent = 0;
  void probePairs(true);
  if (capture === null && decoded === null) return;
  statsSeq++;
  stats = { seq: statsSeq, capture: capture, decoded: decoded, toLayer: toLayer };
  // D7.4.6: sizes and rates, from the probe of the tick before (getStats is async); keys absent until there is one.
  if (capture !== null && outInfo) stats.sent = outInfo;
  if (capture !== null && camMode) stats.camera = { unreadable: unreadable };
  if (decoded !== null) {
    const v = $('video');
    if (v.videoWidth > 0) stats.decodedSize = { width: v.videoWidth, height: v.videoHeight };
  }
  report();
  void probeStats();
}
let outInfo = null;
let outBytes = -1;
async function probeStats() {
  try {
    const r = sending && videoTrack ? [...remote.values()].find((x) => x.videoSender) : null;
    if (!r) { outInfo = null; outBytes = -1; return; }
    const rep = await r.pc.getStats();
    for (const s of rep.values()) {
      if (s.type !== 'outbound-rtp' || s.kind !== 'video') continue;
      const kbps = outBytes >= 0 && s.bytesSent >= outBytes ? Math.round(((s.bytesSent - outBytes) * 8) / (STATS_MS / 1000) / 1000) : null;
      outBytes = s.bytesSent;
      // D8.3: the codec (its stat, by codecId) and Chromium's encoder implementation ('unknown' until a frame is encoded).
      const codecStat = s.codecId && typeof rep.get === 'function' ? rep.get(s.codecId) : null;
      const mime = codecStat && typeof codecStat.mimeType === 'string' ? codecStat.mimeType : '';
      const codec = mime ? mime.replace(/^video\//i, '') : null;
      const impl = typeof s.encoderImplementation === 'string' ? s.encoderImplementation : '';
      const encoder = impl && impl !== 'unknown' ? impl : null;
      outInfo = { width: s.frameWidth || 0, height: s.frameHeight || 0, kbps: kbps, limit: s.qualityLimitationReason || 'none', codec: codec, encoder: encoder };
      noteEncoder(codec, encoder);
      return;
    }
  } catch (e) { /* no stats yet */ }
}
// D8.3: one line in companion.log when the match's codec and encoder become known or change (the item's gate:
// "media: encoder: H264 via MediaFoundationVideoEncodeAccelerator" on both rigs); again after the next attach.
let encoderKey = null;
function noteEncoder(codec, encoder) {
  if (!codec) return;
  const text = codec + (encoder ? ' via ' + encoder : '');
  if (text === encoderKey) return;
  encoderKey = text;
  logLine('encoder: ' + text);
}
setInterval(statsTick, STATS_MS);

/**
 * D2.9: the ICE watchdog and the candidate pair, per peer (r.watch). A spell starts when the connection is stuck
 * (iceWatchStep's states; 'new' only once signalling is stable with a remote description) and ends when it connects.
 * A restart the peer made (its offer brought new ICE credentials while the spell lasted) counts as one of ours.
 * I11.12 (2026-11-24, ICE_WATCH): the restarts take turns, the usual lead's (leadsIceRestart) first, 3, 3, 6, 6, 12 and
 * 12 s apart; the side whose turn it is not steps in 3 s later (for the first two: after 14 s and 28 s, for a peer on
 * 0.2.50). After the sixth, 12 s more and the panel and the Match tab say there is no path so far (w.gaveUp: what is
 * said, no longer an end): the restarts go on, one every 30 s, turns alternating, for as long as the peer is in the
 * match. A path that is away for a minute or two (a VPN that reconnects, a router that fails over) comes back, and a
 * give-up that is final would leave the players without voice for the rest of the match: 0.2.50's third restart, at
 * 70 s, caught such a path, and the sixth is now at about 47 s. Whether the native video holds a direct pair to the
 * peer (videoDirect, from main) only chooses the words: with one, no relay is asked for. The lines of the late
 * restarts are kept few (iceRoundSparse; no pair and state lines while nothing changes). Every step is logged.
 */
/** I11.12 (2026-11-24): the peers the native video holds a direct pair to (C.videoDirect, from the match host through main). */
let videoDirect = [];
function hasVideoDirect(peer) {
  return videoDirect.indexOf(peer) >= 0;
}
/**
 * I11.12 (2026-11-24): how long after a restart of the peer's, answered here while this side still saw the connection
 * up, a spell that begins here is the same trouble: that restart is then its restart 1 (iceWatch).
 */
const PEER_RESTART_BEFORE_MS = 20000;
function newWatch(peer) {
  return { since: null, lastAt: 0, restarts: 0, gaveUp: false, said: null, ownAt: 0, peerAt: 0, ufrag: null, lead: leadsIceRestart(localId, peer) };
}
/** I11.12 (2026-11-24): the scheduled restarts of this peer's spell are used up: the late ones are on, and its lines are kept few. */
function lateSpell(r) {
  return r.watch.since !== null && r.watch.restarts >= ICE_WATCH.backoffMs.length;
}
function logLine(line) {
  ipcRenderer.send(C.log, line);
}
function peerName(peer) {
  const p = panel && panel.players ? panel.players.find((x) => x.id === peer) : null;
  return p && p.name ? p.name : peer;
}
function hasRelay() {
  return ice.some((s) => [].concat(s.urls || []).some((u) => /^turns?:/i.test(String(u))));
}
function current(peer, r) {
  const n = mesh && mesh.get(peer);
  return !!n && n.pc === r.pc && remote.get(peer) === r;
}
function stuckFor(r, now) {
  return now - Math.max(r.watch.since, r.watch.lastAt);
}
/**
 * I11.12: one line per ICE round of a peer (iceRoundOver, shared with the other page): what each kind of candidate
 * pair sent and received, and when the round got its remote description, went to checking and connected.
 */
function roundSeen(peer, r) {
  const st = r.pc.iceConnectionState;
  iceRoundSeen(r.round, Date.now(), st, iceUfrag(r.pc.remoteDescription && r.pc.remoteDescription.sdp));
  if ((st === 'connected' || st === 'completed') && !r.round.idle && current(peer, r)) roundOver(peer, r, 'connected', true, false);
}
function roundOver(peer, r, why, connected, peerLed, sparse) {
  const lead = r.watch.lead;
  // I11.12 (2026-11-24): restart 1, 3, 5 is the usual lead's turn, 2, 4, 6 the other side's.
  iceRoundOver(r, why, connected, peerLed, Date.now(), (line) => logLine('peer ' + peer + ': ' + line + (lead ? '; this side leads restarts 1, 3, 5' : '; the peer leads restarts 1, 3, 5')), sparse);
}
function iceWatch(peer, r) {
  if (!current(peer, r)) return;
  const pc = r.pc;
  const w = r.watch;
  const st = pc.iceConnectionState;
  const now = Date.now();
  if (st === 'connected' || st === 'completed') {
    if (w.since !== null && w.restarts > 0) logLine('peer ' + peer + ': ICE ' + st + ' after ' + w.restarts + ' restart(s), ' + Math.round((now - w.since) / 1000) + ' s stuck' + (r.pairText ? '; ' + r.pairText : ''));
    const said = w.gaveUp;
    r.watch = newWatch(peer);
    r.watch.ufrag = w.ufrag;
    r.watch.peerAt = w.peerAt;
    if (said) { report(); render(); }
    return;
  }
  const counting = st === 'checking' || st === 'disconnected' || st === 'failed' || (st === 'new' && pc.signalingState === 'stable' && !!pc.remoteDescription);
  if (!counting) return;
  const total = ICE_WATCH.backoffMs.length;
  if (w.since === null) {
    w.since = now;
    // I11.12 (2026-11-24): the peer saw this trouble first (a blip the two sides notice seconds apart) and has already
    // restarted, which this side answered while it still read the connection as up, and so did not count. Without
    // this the counts are 1 there and 0 here from the start, and from then on one side makes every restart: the turns
    // are gone for the whole spell. That restart is this spell's first.
    if (w.peerAt && now - w.peerAt < PEER_RESTART_BEFORE_MS) {
      w.restarts = 1;
      w.lastAt = w.peerAt;
      logLine('peer ' + peer + ': the peer restarted ICE ' + Math.round((now - w.peerAt) / 1000) + ' s before this side saw the trouble: that was ' + iceRestartName(1, total) + ', the next is ' + (w.lead ? "the peer's" : 'our') + ' turn');
    }
    w.peerAt = 0;
  }
  // I11.12 (2026-11-24): never the end (persist): after the scheduled restarts, one every ICE_WATCH.lateMs.
  const action = iceWatchStep(st, stuckFor(r, now), w.restarts, w.lead, ICE_WATCH, true);
  if (action === 'restart') {
    const secs = Math.round(stuckFor(r, now) / 1000);
    const n = mesh.get(peer);
    if (!n || n.closed || typeof pc.restartIce !== 'function') return;
    // I11.12 (2026-11-24): whose turn this restart is (even count: the usual lead's).
    const mine = w.restarts % 2 === 0 ? w.lead : !w.lead;
    // I11.12: the round's stats are asked for before the restart changes them (a late round's line: iceRoundSparse).
    roundOver(peer, r, iceRestartName(w.restarts + 1, total) + ' decided here', false, false, iceRoundSparse(w.restarts + 1, total));
    if (!n.restartIce()) return;
    w.restarts++;
    w.lastAt = now;
    w.ownAt = now;
    logLine('peer ' + peer + ': ICE ' + iceRestartName(w.restarts, total) + ' (' + st + ' for ' + secs + ' s, ' + (mine ? 'our turn' : 'the peer did not take its turn') + '; ' + (r.pairText || 'no pair yet') + ')');
  } else if (!w.gaveUp && iceWatchStep(st, stuckFor(r, now), w.restarts, w.lead, ICE_WATCH, false) === 'give_up') {
    // I11.12 (2026-11-24): where 0.2.50 gave up: the scheduled restarts and their last wait are over. It is said (once,
    // with the state and the count of this moment: the words must not change with every late restart), and the
    // restarts go on. With a direct picture to the same peer no relay is asked for (noPathText).
    w.gaveUp = true;
    w.said = { ice: st, restarts: w.restarts };
    const every = '; still trying: an ICE restart every ' + Math.round(ICE_WATCH.lateMs / 1000) + ' s';
    const stuck = st + ' for ' + Math.round((now - w.since) / 1000) + ' s; ' + (r.pairText || 'no pair yet');
    if (hasVideoDirect(peer)) logLine('peer ' + peer + ': not connected after ' + w.restarts + ' ICE restart(s), ' + stuck + '; the native video holds a direct pair to this peer' + every);
    else logLine('peer ' + peer + ': no path after ' + w.restarts + ' ICE restart(s), ' + stuck + (hasRelay() ? '; the TURN relay did not get through' : '; no TURN relay is set') + every);
    report();
    render();
  }
}
/** D2.9: signalling back to stable with new remote ICE credentials while stuck, and we answered: the peer restarted. */
function notePeerRestart(peer, r) {
  const pc = r.pc;
  const u = iceUfrag(pc.remoteDescription && pc.remoteDescription.sdp);
  const w = r.watch;
  const was = w.ufrag;
  w.ufrag = u;
  if (!was || !u || u === was || !pc.localDescription || pc.localDescription.type !== 'answer') return;
  if (!current(peer, r)) return;
  // I11.12 (2026-11-24): answered while this side reads the connection as up: remembered, for a spell that begins
  // here within PEER_RESTART_BEFORE_MS (iceWatch counts it as that spell's first restart, as the peer has).
  if (w.since === null) {
    w.peerAt = Date.now();
    return;
  }
  // I11.12 (2026-11-24): both sides restarted at the same moment and the negotiation let the peer's offer stand (ours
  // was rolled back to answer it): that is one restart, already counted and its round already begun here, not two. The
  // two counts must stay the same, or the sides no longer agree on whose turn the next one is.
  if (w.ownAt && Date.now() - w.ownAt < 2000) {
    w.ownAt = 0;
    w.lastAt = Date.now();
    logLine('peer ' + peer + ': ICE ' + iceRestartName(w.restarts, ICE_WATCH.backoffMs.length) + ': the peer restarted at the same moment and its offer stands (one restart, counted once)');
    return;
  }
  // I11.12 (2026-11-24): counted after "no path" too: the late restarts take turns as the scheduled ones do.
  w.restarts++;
  w.lastAt = Date.now();
  roundOver(peer, r, iceRestartName(w.restarts, ICE_WATCH.backoffMs.length) + ' by the peer', false, true, iceRoundSparse(w.restarts, ICE_WATCH.backoffMs.length));
  logLine('peer ' + peer + ': ICE ' + iceRestartName(w.restarts, ICE_WATCH.backoffMs.length) + ' by the peer (' + pc.iceConnectionState + ')');
}
function iceWatchTick() {
  for (const [peer, r] of remote) iceWatch(peer, r);
}
setInterval(iceWatchTick, ICE_WATCH.tickMs);
/**
 * D2.9: the first peer the watchdog found no path to, as the panel and the Match tab say it; null otherwise. I11.12
 * (2026-11-24): never "a TURN relay is needed" for a peer the native video holds a direct pair to: for that peer,
 * that the voice is still being tried and the picture has a direct path. The state and the count are those of the
 * moment it was first said (w.said), so the words stay the same while the restarts go on.
 */
function noPathMessage() {
  for (const [peer, r] of remote) {
    const w = r.watch;
    if (!w || !w.gaveUp) continue;
    const said = w.said || { ice: r.pc.iceConnectionState, restarts: w.restarts };
    return noPathText(peerName(peer), said.ice, said.restarts, hasRelay(), hasVideoDirect(peer), true);
  }
  return null;
}
/**
 * I11.12 (2026-11-24): the candidates a peer's signalling carries (iceRoundCandidate keeps the time of the round's
 * first server-reflexive one each way, nothing else of it).
 */
function noteCandidate(peer, signal, outgoing) {
  const r = remote.get(peer);
  if (!r || !signal || signal.kind !== 'ice' || !signal.candidate) return;
  iceRoundCandidate(r, Date.now(), outgoing, signal.candidate.candidate);
}
/**
 * I11.12 (2026-11-24): the stats of a round's first seconds, read every 50 ms until a check was seen sent and received
 * on a pair with a server-reflexive candidate, 3 s at most (ICE_ROUND_LOOK): the times a round's line gives for them.
 */
function roundLook() {
  const now = Date.now();
  for (const [peer, r] of [...remote]) {
    const round = r.round;
    if (round.idle || now - round.at >= ICE_ROUND_LOOK.forMs || (round.checkOutMs !== null && round.checkInMs !== null)) continue;
    if (r.looking || typeof r.pc.getStats !== 'function') continue;
    r.looking = true;
    let stats;
    try { stats = r.pc.getStats(); } catch (e) { stats = null; }
    if (!stats || typeof stats.then !== 'function') { r.looking = false; continue; }
    stats.then((rep) => {
      r.looking = false;
      // The look belongs to the round it was asked in.
      if (remote.get(peer) === r && r.round === round) iceRoundLook(r, Date.now(), [...rep.values()]);
    }, () => { r.looking = false; });
  }
}
setInterval(roundLook, ICE_ROUND_LOOK.everyMs);
/** D2.9: each peer's candidate pair, logged when it changes (a look every 3 s) and on every 10 s counter tick. */
async function probePairs(tick) {
  for (const [peer, r] of [...remote]) {
    if (typeof r.pc.getStats !== 'function') continue;
    let info;
    try {
      const rep = await r.pc.getStats();
      const entries = [...rep.values()];
      info = icePairInfo(entries);
      // I11.12 (2026-11-24): the candidates there are, and the counters kept while there still are pairs.
      iceRoundLook(r, Date.now(), entries);
    } catch (e) {
      continue;
    }
    if (remote.get(peer) !== r) continue;
    const key = icePairText(info, false);
    r.pairText = icePairText(info, true);
    const changed = key !== r.pairKey;
    r.pairKey = key;
    // I11.12 (2026-11-24): not while the late restarts run and there is still no pair: the same three or four lines
    // every 30 s (16 tried, 2 tried, 0 tried) for as long as the match lasts. A pair that works is always said.
    if ((changed || tick) && !(lateSpell(r) && !info.pair)) logLine('peer ' + peer + ': ' + r.pairText + ', ice ' + r.pc.iceConnectionState + (r.watch.restarts ? ', ' + r.watch.restarts + ' restart(s)' : ''));
  }
}
setInterval(() => void probePairs(false), 3000);

function attachAudio(r) {
  if (!micTrack) return;
  if (r.audioSender) void r.audioSender.replaceTrack(micTrack);
  else r.audioSender = r.pc.addTrack(micTrack, localStream);
}

function attachVideo(r) {
  if (!videoTrack) return;
  if (r.videoSender) void r.videoSender.replaceTrack(videoTrack);
  else {
    r.videoSender = r.pc.addTrack(videoTrack, localStream);
    preferVideoCodecs(r.pc, r.videoSender);
  }
  void applyBitrate(r);
}

/**
 * D8.3: H.264 first on the video transceiver (preferH264), set once when the sender is added, before the offer the
 * browser asks for. Codec preferences belong to the transceiver, so every renegotiation on it (an ICE restart, a
 * crossed offer, an answer to the peer's offer, which reuses the addTrack transceiver) keeps them; a connection the
 * mesh reopens (a reset, a stale offer) comes back through attachVideo and gets them again. A browser without
 * setCodecPreferences, or a peer without H.264, negotiates as before (VP8 stays in the list, after H.264).
 */
function preferVideoCodecs(pc, sender) {
  try {
    if (typeof RTCRtpSender === 'undefined' || typeof RTCRtpSender.getCapabilities !== 'function' || typeof pc.getTransceivers !== 'function') return;
    const caps = RTCRtpSender.getCapabilities('video');
    const tr = pc.getTransceivers().find((t) => t.sender === sender);
    if (!caps || !caps.codecs || !tr || typeof tr.setCodecPreferences !== 'function') return;
    tr.setCodecPreferences(preferH264(caps.codecs));
  } catch (e) {
    /* the browser's own order then */
  }
}

/**
 * D7.4.6 / D8.3: the cap (bits a second) on what this rig sends: the rule from the crop actually sent (it changes when
 * the window does); VIDEO.maxBitrate before the capture is known (the rule's own floor, so the hints match the cap).
 */
function wantedBitrate() {
  return cap ? videoBitrateFor({ width: cap.out.width, height: cap.out.height, stereo: myStereo }) : VIDEO.maxBitrate;
}

async function applyBitrate(r) {
  const sender = r.videoSender;
  if (!sender) return;
  try {
    const p = sender.getParameters();
    if (!p.encodings || !p.encodings.length) return;
    const want = wantedBitrate();
    if (p.encodings[0].maxBitrate === want) return;
    p.encodings[0].maxBitrate = want;
    p.encodings[0].maxFramerate = VIDEO.fps;
    await sender.setParameters(p);
  } catch (e) {
    /* before negotiation there may be no encodings yet; the next stable state retries */
  }
}

function closeRemote(peer) {
  const r = remote.get(peer);
  if (!r) return;
  remote.delete(peer);
  clearInterval(r.retry);
  r.audio.srcObject = null;
  r.tableAudio.srcObject = null;
  // D2.10: the voice graph of this peer goes with it (the AudioContext stays: one per page).
  try { if (r.voiceSource) r.voiceSource.disconnect(); } catch (e) { /* gone */ }
  try { if (r.voiceGain) r.voiceGain.disconnect(); } catch (e) { /* gone */ }
  r.voiceSource = null;
  r.voiceGain = null;
  r.voiceTrack = null;
  try { r.pc.close(); } catch (e) { /* closed */ }
  if (stageKey === 'peer:' + peer) stageKey = null;
}

/** The mesh's factory: a connection to one peer with our tracks on it. */
function openPeer(peer) {
  closeRemote(peer);
  const pc = new RTCPeerConnection({ iceServers: ice, bundlePolicy: 'max-bundle' });
  // D8.3: every remote description this connection applies (the negotiator's offer and answer paths both land here, on
  // every renegotiation) carries the start / min bitrate hints for the cap of the moment (withBitrateHints), so the
  // encoder starts at the cap instead of ramping from a low guess. The cap itself stays with setParameters (applyBitrate).
  const setRemote = pc.setRemoteDescription.bind(pc);
  pc.setRemoteDescription = (d) => setRemote(d && typeof d.sdp === 'string' ? Object.assign({}, d, { sdp: withBitrateHints(d.sdp, bitrateHintsFor(wantedBitrate())) }) : d);
  const r = { pc: pc, stream: new MediaStream(), audio: new Audio(), audioSender: null, videoSender: null, retry: null, tableStream: new MediaStream(), tableAudio: new Audio(), tableSender: null, watch: newWatch(peer), round: iceRoundStart(1, Date.now(), null, null), ids: null, pairKey: null, pairText: null, voiceSource: null, voiceGain: null, voiceTrack: null };
  r.audio.autoplay = true;
  r.audio.srcObject = r.stream;
  // D2.10: the voice plays through a GainNode (routeVoice, once its track is here) so it can go past 100 %; the element
  // keeps the stream but is muted then: Chromium feeds a remote track into Web Audio only while a media element also
  // consumes it (crbug.com/121673), and an unmuted element would play it a second time. Without Web Audio the element
  // plays it at the voice volume, capped at 100 %.
  r.audio.muted = true;
  // D2.8: the peer's table sound plays from its own element, muted unless that peer is up (routeTable).
  r.tableAudio.autoplay = true;
  r.tableAudio.muted = true;
  r.tableAudio.srcObject = r.tableStream;
  r.tableAudio.volume = gains.table;
  pc.addEventListener('track', (e) => {
    const t = e.track;
    if (trackRole(t.kind, (e.streams || []).map((s) => s.id)) === 'table') {
      for (const old of r.tableStream.getTracks()) if (old !== t) r.tableStream.removeTrack(old);
      r.tableStream.addTrack(t);
      t.addEventListener('mute', () => report());
      t.addEventListener('unmute', () => report());
      routeTable();
      report();
      return;
    }
    for (const old of r.stream.getTracks()) if (old.kind === t.kind && old !== t) r.stream.removeTrack(old);
    r.stream.addTrack(t);
    t.addEventListener('mute', () => { report(); render(); });
    t.addEventListener('unmute', () => { report(); render(); });
    if (t.kind === 'audio') routeVoice(r);
    void r.audio.play().catch(() => undefined);
    if (stageKey === 'peer:' + peer) stageKey = null;
    report();
    render();
  });
  // D2.9: the watchdog (iceWatchTick) restarts a stuck connection; a state change is looked at at once.
  pc.addEventListener('iceconnectionstatechange', () => {
    roundSeen(peer, r);
    iceWatch(peer, r);
    report();
    // A17: the lobby's stage says whether the others hear this player (stageText).
    if (panel && panel.phase === 'idle') render();
  });
  pc.addEventListener('signalingstatechange', () => {
    roundSeen(peer, r);
    if (pc.signalingState === 'stable') {
      void applyBitrate(r);
      notePeerRestart(peer, r);
    }
    report();
  });
  remote.set(peer, r);
  attachAudio(r);
  attachVideo(r);
  attachTable(r);
  // An offer lost on the way (the peer attached late, a reconnect) is sent again until the connection is up.
  // A18: and on a connection that is up, an offer that has waited for its answer since the last look (one made while
  // the match's link was away: this connection is kept through that now, so nothing else would ever send it again).
  r.retry = setInterval(() => {
    const n = mesh && mesh.get(peer);
    const st = pc.iceConnectionState;
    if (!n || n.pc !== pc) return;
    // A17: less and less often while the peer has never answered (a PC on 0.2.50 answers at its MATCH_READY).
    if (st !== 'connected' && st !== 'completed') n.resendWaitingOffer();
    else if (n.resendStuckOffer(Date.now())) logLine('peer ' + peer + ': an offer had no answer for ' + Math.round(PeerNegotiator.STUCK_OFFER_MS / 1000) + ' s or more on a connected link: sent again');
  }, 5000);
  sendStereo(peer);
  return pc;
}

/** A17: the peers to add once attach() has the microphone and the capture (its own list, and any named meanwhile); null outside that wait. */
let waitingPeers = null;
async function attach(a) {
  detach();
  localId = a.localId;
  ice = a.ice || [];
  muted = !!a.muted;
  sending = !!a.sending;
  localError = null;
  // The mesh exists at once so early signals are held for their peer; peers are added once our tracks are ready,
  // so the first offer already carries them.
  mesh = new SignalingMesh(
    localId,
    openPeer,
    (to, signal) => { noteCandidate(to, signal, true); ipcRenderer.send(C.send, { to: to, signal: tableSdp(signal) }); },
    (peer, e, where) => { localError = 'Media with ' + peer + ' (' + where + '): ' + errText(e); report(); },
  );
  // D2.7: openPeer has already replaced the connection; count it, so the report (and companion.log) shows it.
  mesh.onReopen = (peer) => {
    reopens.set(peer, (reopens.get(peer) || 0) + 1);
    report();
    render();
  };
  // D2.7: this page replaces one whose connections still stand on the peers' side: they reopen first.
  if (a.reset) for (const p of a.peers) ipcRenderer.send(C.send, { to: p, signal: { kind: 'reset' } });
  const m = mesh;
  // A17 (the review of PR 127): a peer named while the microphone and the capture are still being opened waits with
  // the attach's own peers. Main names the lobby's players the moment the attach is posted (the voice is connected
  // from the join on), and a connection opened before the microphone is there offers without it: a second offer
  // follows, and a PC on 0.2.50 answers the first one many times over.
  waitingPeers = new Set(a.peers);
  await Promise.all([openMic(a.micDeviceId), openCapture(a.capture)]);
  if (mesh !== m) return;
  const peers = waitingPeers;
  waitingPeers = null;
  for (const p of peers) mesh.add(p);
  report();
  render();
}

function detach() {
  if (mesh) mesh.close();
  mesh = null;
  waitingPeers = null;
  for (const id of [...remote.keys()]) closeRemote(id);
  for (const t of localStream.getTracks()) {
    localStream.removeTrack(t);
    t.stop();
  }
  micTrack = null;
  videoTrack = null;
  srcTrack = null;
  cap = null;
  encoderKey = null;
  camMode = false;
  camFrames = 0;
  camBad = 0;
  myEyes = null;
  myEyesKey = null;
  covered = false;
  stalled = false;
  stats = null;
  $('src').srcObject = null;
  micState = 'unavailable';
  sending = false;
  stageKey = null;
  myStereo = undefined;
  peerStereo.clear();
  peerEyes.clear();
  reopens.clear();
  saveReq = null;
  if (volumeNoteTimer) clearTimeout(volumeNoteTimer);
  volumeNoteTimer = null;
  volumeNote = null;
  menu = null;
  stopBench();
  // D2.8: the table track outlives an attach (one AudioContext per page); it goes quiet until main says send again.
  setTableSend(false);
  report();
  render();
}

ipcRenderer.on(C.attach, (_e, a) => void attach(a));
ipcRenderer.on(C.signal, (_e, m) => {
  // D7.4.3: a peer's declared stereo is the page's, not the connection's; kept whether or not the peer is added yet.
  if (m.signal && m.signal.kind === 'stereo') {
    peerStereo.set(m.from, m.signal.stereo === 'sbs' || m.signal.stereo === 'mono' ? m.signal.stereo : null);
    peerEyes.set(m.from, m.signal.stereo === 'sbs' && Array.isArray(m.signal.eyes) && m.signal.eyes.length === 2 ? m.signal.eyes : null);
    return;
  }
  noteCandidate(m.from, m.signal, false);
  if (mesh) void mesh.receive(m.from, m.signal);
});
ipcRenderer.on(C.addPeer, (_e, p) => {
  // A17: while attach() still opens the microphone and the capture, the peer is added with the others after it.
  if (waitingPeers) waitingPeers.add(p);
  else if (mesh) mesh.add(p);
  report();
});
ipcRenderer.on(C.removePeer, (_e, p) => {
  if (waitingPeers) waitingPeers.delete(p);
  if (mesh) mesh.remove(p);
  closeRemote(p);
  report();
  render();
});
ipcRenderer.on(C.sending, (_e, on) => {
  sending = !!on;
  if (videoTrack) videoTrack.enabled = sending && !stalled;
  report();
  render();
});
ipcRenderer.on(C.state, (_e, s) => { panel = s; render(); });
// D10.5: the native video's footer line from the match host (null clears it).
let videoLine = '';
ipcRenderer.on(C.menu, (_e, m) => {
  menu = m && Array.isArray(m.items) ? m : null;
  render();
});
ipcRenderer.on(C.videoLine, (_e, line) => { videoLine = typeof line === 'string' ? line : ''; render(); });
// I11.12 (2026-11-24): who the native video reaches directly; the watchdog looks at once (a peer it gave up on is tried again).
ipcRenderer.on(C.videoDirect, (_e, ids) => {
  videoDirect = Array.isArray(ids) ? ids.filter((x) => typeof x === 'string') : [];
  iceWatchTick();
  report();
  render();
});
ipcRenderer.on(C.muted, (_e, on) => {
  muted = !!on;
  if (micTrack) {
    micTrack.enabled = !muted;
    micState = muted ? 'muted' : 'open';
  }
  report();
  render();
});
ipcRenderer.on(C.capture, (_e, c) => void openCapture(c));
ipcRenderer.on(C.cameraFrame, (_e, f) => void drawCamera(f));
ipcRenderer.on(C.cover, (_e, on) => {
  covered = !!on;
  paint();
});
ipcRenderer.on(C.microphone, (_e, id) => void openMic(id));
ipcRenderer.on(C.detach, () => detach());

/**
 * D7.4: the theater feed. While main wants it and the stage shows another player's video, each new video frame is
 * drawn into a canvas at the feed size and its pixels (RGBA) go to main, one frame in flight (main acks each one; a
 * lost ack is given up after a second). The up player's declared stereo says whether it is side by side (D7.4.3); only
 * a player who declared nothing is judged by its rig and the picture's aspect.
 */
let feedWanted = false;
let feedInFlight = false;
let feedSentAt = 0;
let feedLastFrame = -1;
// Made at the first theater frame: a rig that never spectates in the headset never has it.
let feedCanvas = null;
let feedCtx = null;
function feedTick() {
  if (!feedWanted) return;
  const now = Date.now();
  if (feedInFlight && now - feedSentAt < 1000) return;
  // D7.6: the bench feeds the layer by the same path (feedOut), from its canvas or the local loop's received video.
  if (bench) {
    benchFeed(bench);
    return;
  }
  if (!panel) return;
  const who = videoPeer(panel);
  if (!who || who === 'self') return;
  const v = $('video');
  if (!v.videoWidth || !v.videoHeight || v.readyState < 2) return;
  // A new decoded frame only (the stage video's own counter, else its clock).
  const q = typeof v.getVideoPlaybackQuality === 'function' ? v.getVideoPlaybackQuality() : null;
  const mark = q && q.totalVideoFrames > 0 ? q.totalVideoFrames : v.currentTime;
  if (mark === feedLastFrame) return;
  const up = panel.players.find((p) => p.id === who);
  const stereo = stereoOf(peerStereo.get(who), up ? up.rig : undefined, v.videoWidth, v.videoHeight);
  feedOut(v, v.videoWidth, v.videoHeight, mark, stereo, stereo === 'sbs' ? peerEyes.get(who) || null : null, 'peer ' + who);
}

/**
 * One frame to the layer: drawn at the feed size (feedSize, VIDEO_FEED_MAX) into the feed canvas, its pixels to main
 * (one in flight), and saved when a save runs (D7.6.3). The size handed over, or null when nothing went.
 */
function feedOut(src, w, h, mark, stereo, eyes, source) {
  const size = feedSize(w, h, stereo);
  if (!size) return null;
  try {
    if (!feedCtx) {
      feedCanvas = document.createElement('canvas');
      feedCtx = feedCanvas.getContext('2d', { alpha: false, willReadFrequently: true });
      if (!feedCtx) return null;
    }
    if (feedCanvas.width !== size.width) feedCanvas.width = size.width;
    if (feedCanvas.height !== size.height) feedCanvas.height = size.height;
    feedCtx.drawImage(src, 0, 0, size.width, size.height);
    const img = feedCtx.getImageData(0, 0, size.width, size.height);
    feedLastFrame = mark;
    feedSent++;
    feedInFlight = true;
    feedSentAt = Date.now();
    ipcRenderer.send(C.video, { width: size.width, height: size.height, rgba: new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength), stereo: stereo, eyes: eyes || null });
    saveFeedFrame(src, w, h, stereo, eyes, source);
    return size;
  } catch (e) {
    /* a frame lost; the next tick tries again */
    return null;
  }
}

/**
 * D7.6.3 (2026-11-03): main asked to save the theater frames (C.saveFrames): each frame handed to the layer is drawn at
 * its decoded size onto its own canvas and encoded to JPEG, one encode in flight (a frame that comes meanwhile is
 * counted as skipped), until the time is up or max are saved. Each goes to main on C.savedFrame.
 */
let saveReq = null;
let saveCanvas = null;
let saveCtx = null;
function saveFeedFrame(src, w, h, stereo, eyes, source) {
  const r = saveReq;
  if (!r || !(w > 0 && h > 0)) return;
  const now = Date.now();
  if (now > r.until || r.n >= r.max) {
    saveReq = null;
    return;
  }
  if (r.busy) {
    r.skipped++;
    return;
  }
  try {
    if (!saveCtx) {
      saveCanvas = document.createElement('canvas');
      saveCtx = saveCanvas.getContext('2d', { alpha: false });
      if (!saveCtx) return;
    }
    if (saveCanvas.width !== w) saveCanvas.width = w;
    if (saveCanvas.height !== h) saveCanvas.height = h;
    saveCtx.drawImage(src, 0, 0, w, h);
    const i = r.n++;
    const skipped = r.skipped;
    r.skipped = 0;
    r.busy = true;
    const done = () => { r.busy = false; };
    saveCanvas.toBlob((blob) => {
      if (!blob) return done();
      void Promise.resolve(blob.arrayBuffer()).then((buf) => {
        ipcRenderer.send(C.savedFrame, { i: i, jpeg: new Uint8Array(buf), width: w, height: h, stereo: stereo, eyes: eyes || null, at: now, source: source, skipped: skipped });
      }).catch(() => undefined).then(done);
    }, 'image/jpeg', SAVE_QUALITY);
  } catch (e) {
    r.busy = false;
  }
}
ipcRenderer.on(C.saveFrames, (_e, q) => {
  const ms = q && typeof q.ms === 'number' ? q.ms : 0;
  saveReq = ms > 0 ? { until: Date.now() + ms, max: q && typeof q.max === 'number' ? q.max : 0, n: 0, busy: false, skipped: 0 } : null;
});
setInterval(feedTick, Math.round(1000 / FEED_FPS));
ipcRenderer.on(C.videoWant, (_e, on) => {
  feedWanted = !!on;
  feedInFlight = false;
  feedLastFrame = -1;
});
ipcRenderer.on(C.videoAck, () => { feedInFlight = false; });

/**
 * D7.6 (2026-11-03): the VR test bench. Main sends the bench (C.bench) instead of an attach, then frames (C.benchFrame,
 * one in flight, acked): two eye JPEGs drawn side by side, or one whole picture, onto the bench canvas. Path direct:
 * that canvas is the stage and the theater feed (feedOut). Path loop: the canvas track goes through two
 * RTCPeerConnections in this page (the match's bitrate rule, detail kept), and the received track is the stage, fed to
 * the layer the way a peer's video is. Every second the readout goes to main (C.benchStatus).
 */
function startBench(cfg) {
  stopBench();
  if (cfg) {
    const c = document.createElement('canvas');
    c.width = 2;
    c.height = 2;
    // D7.6.9: bitrateOverride is the Match tab's cap for the loop (bits per second), or null for the match's rule.
    const override = typeof cfg.bitrate === 'number' && cfg.bitrate > 0 ? cfg.bitrate : null;
    const b = { path: cfg.path === 'loop' ? 'loop' : 'direct', canvas: c, ctx: c.getContext('2d', { alpha: false }), drawn: 0, drawnSec: 0, bad: 0, stereo: 'sbs', eyes: null, track: null, stageStream: null, streamN: 0, a: null, b: null, sender: null, bitrate: null, bitrateOverride: override, fed: null, fedSec: 0, outBytes: -1, outAt: 0, error: null };
    const t = c.captureStream(VIDEO.fps).getVideoTracks()[0] || null;
    if (!t) b.error = 'The bench canvas gave no video track.';
    else {
      try { t.contentHint = 'detail'; } catch (e) { /* older engines */ }
      b.track = t;
    }
    bench = b;
    feedLastFrame = -1;
    feedInFlight = false;
    if (t && b.path === 'direct') setBenchStream(b, new MediaStream([t]));
    else if (t) void openLoop(b);
  }
  render();
}
function stopBench() {
  const b = bench;
  if (!b) return;
  bench = null;
  for (const pc of [b.a, b.b]) {
    if (!pc) continue;
    try { pc.close(); } catch (e) { /* closed */ }
  }
  if (b.track) b.track.stop();
  stageKey = null;
}
function setBenchStream(b, s) {
  if (bench !== b) return;
  b.stageStream = s;
  b.streamN++;
  stageKey = null;
  render();
}
async function openLoop(b) {
  try {
    const a = new RTCPeerConnection({ iceServers: [] });
    const r = new RTCPeerConnection({ iceServers: [] });
    b.a = a;
    b.b = r;
    a.addEventListener('icecandidate', (e) => { if (e.candidate) void Promise.resolve(r.addIceCandidate(e.candidate)).catch(() => undefined); });
    r.addEventListener('icecandidate', (e) => { if (e.candidate) void Promise.resolve(a.addIceCandidate(e.candidate)).catch(() => undefined); });
    r.addEventListener('track', (e) => setBenchStream(b, new MediaStream([e.track])));
    b.sender = a.addTrack(b.track, new MediaStream([b.track]));
    // D8.3: as the match does: H.264 first, and the sender's remote description hinted to start at the cap.
    preferVideoCodecs(a, b.sender);
    const offer = await a.createOffer();
    await a.setLocalDescription(offer);
    await r.setRemoteDescription(offer);
    const answer = await r.createAnswer();
    await r.setLocalDescription(answer);
    await a.setRemoteDescription({ type: answer.type, sdp: withBitrateHints(answer.sdp, bitrateHintsFor(benchBitrate(b))) });
    await applyBenchBitrate(b);
  } catch (e) {
    if (bench === b) b.error = 'The local WebRTC loop did not start (' + errText(e) + ').';
    render();
  }
}
/**
 * The match's rule (videoBitrateFor, D7.4.6) on the loop's sender, from the canvas's size and the frames' stereo; or the
 * Match tab's cap override when one is set (D7.6.9), whatever the size.
 */
function benchBitrate(b) {
  return b.bitrateOverride !== null && b.bitrateOverride !== undefined ? b.bitrateOverride : videoBitrateFor({ width: b.canvas.width, height: b.canvas.height, stereo: b.stereo });
}
async function applyBenchBitrate(b) {
  if (!b.sender) return;
  const want = benchBitrate(b);
  b.bitrate = want;
  try {
    const p = b.sender.getParameters();
    if (!p.encodings || !p.encodings.length) return;
    if (p.encodings[0].maxBitrate === want) return;
    p.encodings[0].maxBitrate = want;
    p.encodings[0].maxFramerate = VIDEO.fps;
    await b.sender.setParameters(p);
  } catch (e) {
    /* no encodings before negotiation; the next size change tries again */
  }
}
async function drawBench(f) {
  const b = bench;
  let l = null;
  let r = null;
  try {
    if (!b || !b.ctx || !f || !f.left || !f.left.byteLength || typeof createImageBitmap !== 'function') {
      if (b) b.bad++;
      return;
    }
    const both = await Promise.all([
      createImageBitmap(new Blob([f.left], { type: 'image/jpeg' })),
      f.right ? createImageBitmap(new Blob([f.right], { type: 'image/jpeg' })) : Promise.resolve(null),
    ]);
    l = both[0];
    r = both[1];
    if (bench !== b) return;
    const w = f.width > 0 ? f.width : l.width;
    const h = f.height > 0 ? f.height : l.height;
    const W = r ? 2 * w : w;
    const stereo = f.stereo === 'mono' ? 'mono' : 'sbs';
    const resized = b.canvas.width !== W || b.canvas.height !== h || b.stereo !== stereo;
    if (b.canvas.width !== W) b.canvas.width = W;
    if (b.canvas.height !== h) b.canvas.height = h;
    b.stereo = stereo;
    b.eyes = f.eyes || null;
    b.ctx.drawImage(l, 0, 0, l.width || w, l.height || h, 0, 0, w, h);
    if (r) b.ctx.drawImage(r, 0, 0, r.width || w, r.height || h, w, 0, w, h);
    b.drawn++;
    b.drawnSec++;
    if (resized) void applyBenchBitrate(b);
    if (b.drawn === 1) render();
  } catch (e) {
    if (b) b.bad++;
  } finally {
    if (l && typeof l.close === 'function') l.close();
    if (r && typeof r.close === 'function') r.close();
    ipcRenderer.send(C.benchAck);
  }
}
/** The bench's theater feed: the canvas itself (direct), or the stage video once the loop delivers (loop). */
function benchFeed(b) {
  let out = null;
  if (b.path === 'direct') {
    if (!b.drawn || b.drawn === feedLastFrame) return;
    out = feedOut(b.canvas, b.canvas.width, b.canvas.height, b.drawn, b.stereo, b.eyes, 'bench (direct)');
  } else {
    const v = $('video');
    if (!b.stageStream || !v.videoWidth || !v.videoHeight || v.readyState < 2) return;
    const q = typeof v.getVideoPlaybackQuality === 'function' ? v.getVideoPlaybackQuality() : null;
    const mark = q && q.totalVideoFrames > 0 ? q.totalVideoFrames : v.currentTime;
    if (mark === feedLastFrame) return;
    out = feedOut(v, v.videoWidth, v.videoHeight, mark, b.stereo, b.eyes, 'bench (local WebRTC loop)');
  }
  if (out) {
    b.fed = { width: out.width, height: out.height, stereo: b.stereo };
    b.fedSec++;
  }
}
async function benchTick() {
  const b = bench;
  if (!b) return;
  let sent = null;
  if (b.a && b.sender && typeof b.a.getStats === 'function') {
    try {
      const rep = await b.a.getStats();
      for (const s of rep.values()) {
        if (s.type !== 'outbound-rtp' || s.kind !== 'video') continue;
        const now = Date.now();
        // bits per millisecond = kbit/s
        const kbps = b.outBytes >= 0 && s.bytesSent >= b.outBytes && now > b.outAt ? Math.round(((s.bytesSent - b.outBytes) * 8) / (now - b.outAt)) : null;
        b.outBytes = s.bytesSent;
        b.outAt = now;
        // D7.6.8: the codec (its stat, by codecId) and Chromium's encoder implementation, " (hw)" when power efficient.
        const codecStat = s.codecId ? rep.get(s.codecId) : null;
        const mime = codecStat && typeof codecStat.mimeType === 'string' ? codecStat.mimeType : '';
        const codec = mime ? mime.replace(/^video\//i, '') : null;
        const impl = typeof s.encoderImplementation === 'string' && s.encoderImplementation ? s.encoderImplementation : null;
        const encoder = impl ? impl + (s.powerEfficientEncoder === true ? ' (hw)' : '') : null;
        sent = { width: s.frameWidth || 0, height: s.frameHeight || 0, kbps: kbps, fps: typeof s.framesPerSecond === 'number' ? s.framesPerSecond : null, limit: s.qualityLimitationReason || 'none', codec: codec, encoder: encoder };
        break;
      }
    } catch (e) { /* no stats yet */ }
  }
  if (bench !== b) return;
  ipcRenderer.send(C.benchStatus, { path: b.path, drawn: b.drawnSec, bad: b.bad, fed: b.fed, fedFrames: b.fedSec, sent: sent, bitrate: b.bitrate, loopUp: !!b.stageStream, error: b.error });
  b.drawnSec = 0;
  b.fedSec = 0;
  b.bad = 0;
}
setInterval(() => void benchTick(), 1000);
ipcRenderer.on(C.bench, (_e, cfg) => startBench(cfg));
ipcRenderer.on(C.benchFrame, (_e, f) => void drawBench(f));

/**
 * D2.8 (2026-11-01): table sound. Sending: main feeds this rig's VPX sound (the helper's process-loopback tap) as 10 ms
 * float32 stereo frames; they go to an AudioWorklet ring (createTableRing) whose output is a MediaStreamAudioDestination,
 * and that track is the table track. It is added to every connection when the connection is made, like the others, and
 * stays (enabled only while sending), so the m-line set never changes mid-match (the D2.7 lesson). Its stream id goes
 * out as 'castcade-table-audio' (outgoingSdp), which is how the receivers tell it from the voice. Receiving: each peer's
 * table track plays from its own element, only while that peer is up (tablePlays) and main says hear.
 */
let tableSend = false;
let tableHear = true;
// The page's one AudioContext (D2.10 plays the voices through it too, routeVoice); null where there is none.
let tableCtx = null;
let tableDest = null;
let tableNode = null;
let tableTrack = null;
let tableTried = false;
function ensureAudioCtx() {
  if (tableCtx) return tableCtx;
  if (typeof AudioContext !== 'function') return null;
  try {
    tableCtx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
  } catch (e) {
    tableCtx = null;
  }
  return tableCtx;
}
function ensureTableTrack() {
  if (tableTrack || tableTried) return tableTrack;
  if (typeof AudioWorkletNode !== 'function' || !ensureAudioCtx()) return null;
  tableTried = true;
  try {
    tableDest = tableCtx.createMediaStreamDestination();
    try { tableDest.channelCount = 2; } catch (e) { /* fixed on some engines */ }
    tableTrack = tableDest.stream.getAudioTracks()[0] || null;
    if (tableTrack) {
      // A table is music, not speech: no speech-tuned processing on the way out.
      try { tableTrack.contentHint = 'music'; } catch (e) { /* older engines */ }
      tableTrack.enabled = tableSend;
    }
    const url = URL.createObjectURL(new Blob([TABLE_WORKLET], { type: 'application/javascript' }));
    void Promise.resolve(tableCtx.audioWorklet.addModule(url)).then(() => {
      tableNode = new AudioWorkletNode(tableCtx, 'castcade-table-ring', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
      tableNode.connect(tableDest);
    }).catch((e) => { localError = 'Table sound could not start (' + errText(e) + ').'; report(); });
  } catch (e) {
    tableTrack = null;
    localError = 'Table sound could not start (' + errText(e) + ').';
  }
  return tableTrack;
}
function attachTable(r) {
  const t = ensureTableTrack();
  if (!t) return;
  if (r.tableSender) void Promise.resolve(r.tableSender.replaceTrack(t)).catch(() => undefined);
  else r.tableSender = r.pc.addTrack(t, tableDest.stream);
}
function tableSdp(signal) {
  if (!signal || typeof signal.sdp !== 'string' || !tableDest || !tableDest.stream) return signal;
  return Object.assign({}, signal, { sdp: outgoingSdp(signal.sdp, tableDest.stream.id) });
}
function setTableSend(on) {
  if (tableSend === on) return;
  tableSend = on;
  if (tableTrack) tableTrack.enabled = on;
  if (tableNode) tableNode.port.postMessage('flush');
  if (on && tableCtx && tableCtx.state !== 'running') void Promise.resolve(tableCtx.resume()).catch(() => undefined);
}
function routeTable() {
  for (const [id, r] of remote) {
    const on = tablePlays(panel, id, tableHear);
    if (r.tableAudio.muted === !on) continue;
    r.tableAudio.muted = !on;
    if (on) void Promise.resolve(r.tableAudio.play()).catch(() => undefined);
  }
}
ipcRenderer.on(C.tableAudio, (_e, f) => {
  tableHear = !(f && f.hear === false);
  setTableSend(!!(f && f.send));
  routeTable();
});
ipcRenderer.on(C.tablePcm, (_e, pcm) => {
  if (!tableSend || !tableNode || !pcm || !pcm.byteLength) return;
  // A copy into its own buffer (the IPC's view may sit at any offset), handed to the worklet without another copy.
  const copy = new Float32Array(pcm.byteLength >> 2);
  new Uint8Array(copy.buffer).set(new Uint8Array(pcm.buffer, pcm.byteOffset, copy.byteLength));
  tableNode.port.postMessage(copy.buffer, [copy.buffer]);
});

/**
 * D2.10 (2026-11-05): voice over the game. A peer's voice: its stream -> MediaStreamAudioSourceNode -> GainNode (the
 * voice volume, past 1 for a boost) -> the context's destination (the default output: the headset in VR). The source
 * node follows the stream's first audio track at its creation, so a replaced track (a reopened connection keeps the
 * stream object) gets a new source. The element that holds the stream stays muted (see openPeer); where Web Audio is
 * missing or refuses the stream the element plays it instead, at the voice volume capped at 1.
 */
function routeVoice(r) {
  const ctx = ensureAudioCtx();
  const track = r.stream.getAudioTracks()[0] || null;
  if (ctx && typeof ctx.createMediaStreamSource === 'function' && typeof ctx.createGain === 'function') {
    try {
      if (!r.voiceGain) {
        r.voiceGain = ctx.createGain();
        r.voiceGain.connect(ctx.destination);
      }
      r.voiceGain.gain.value = gains.voice;
      if (track && r.voiceTrack !== track) {
        try { if (r.voiceSource) r.voiceSource.disconnect(); } catch (e) { /* gone */ }
        r.voiceSource = ctx.createMediaStreamSource(r.stream);
        r.voiceSource.connect(r.voiceGain);
        r.voiceTrack = track;
      }
      r.audio.muted = true;
      if (ctx.state !== 'running') void Promise.resolve(ctx.resume()).catch(() => undefined);
      return;
    } catch (e) {
      /* no Web Audio for this stream: the element plays it */
    }
  }
  r.audio.muted = false;
  r.audio.volume = Math.min(1, gains.voice);
}
function applyVolume() {
  for (const r of remote.values()) {
    routeVoice(r);
    r.tableAudio.volume = gains.table;
  }
}
ipcRenderer.on(C.volume, (_e, v) => {
  gains = volumeGains(v);
  applyVolume();
  const note = v && typeof v.note === 'string' && v.note ? v.note : null;
  if (note) {
    volumeNote = note;
    if (volumeNoteTimer) clearTimeout(volumeNoteTimer);
    volumeNoteTimer = setTimeout(() => {
      volumeNoteTimer = null;
      volumeNote = null;
      render();
    }, VOLUME_NOTE_MS);
  }
  render();
});
setInterval(report, 2000);
render();
ipcRenderer.send(C.ready);
`;
