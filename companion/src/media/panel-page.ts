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
import type { MatchPlayerId, MediaStatus, PanelState } from './match-media-types.js';
import type { IceServer } from './media-settings.js';
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
  // page -> main
  ready: 'castcade-panel:ready',
  send: 'castcade-panel:send',
  status: 'castcade-panel:status',
  devices: 'castcade-panel:devices',
  /** D7.4: `{ width, height, rgba: Uint8Array, stereo: 'mono' | 'sbs' }`, the stage video's pixels. */
  video: 'castcade-panel:video',
} as const;

/** The picture sent while this rig is up (alpha-match.md §4): the VR preview window is set to 1280x720. */
export const PANEL_VIDEO = { width: 1280, height: 720, fps: 30, maxBitrate: 2_500_000 } as const;

/**
 * D7.4 (2026-10-31): the video the headset's theater mode gets, at the received size up to these (a larger one is
 * scaled down, aspect kept): a mono picture up to 1080p, a side-by-side one up to two 1080p halves. Each frame is a
 * copy (getImageData, IPC, the pipe), so at most `fps` a second and only when the video has a new frame.
 */
export const VIDEO_FEED_MAX = { mono: { width: 1920, height: 1080 }, sbs: { width: 3840, height: 1080 }, fps: 30 } as const;
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
  /** D7.4.6: the outbound video as the first peer's connection reports it (the tick before's reading); absent before one. */
  sent?: { width: number; height: number; kbps: number | null; limit: string };
  /** D7.4.6: the stage video's decoded frame size, while theater wanted the feed. */
  decodedSize?: { width: number; height: number };
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

/** `YOUR BALL 2` / `KROBS IS UP`, or the phase when nobody is. */
export function headerText(s: PanelState): string {
  if (s.phase === 'over') return 'MATCH OVER';
  if (s.phase === 'idle') return 'WAITING FOR THE START';
  const up = s.players.find((p) => p.id === s.playerUp);
  const ball = s.ball !== null ? ' ' + s.ball : '';
  const turn = s.myTurn ? 'YOUR BALL' + ball : up ? up.name.toUpperCase() + ' IS UP' : 'WAITING';
  return s.phase === 'paused' ? 'PAUSED · ' + turn : turn;
}

export function scoreText(score: number | null): string {
  return score === null ? '–' : score.toLocaleString('en-US');
}

/** The score strip: players in the controller's order while playing, the standings by place once it is over. */
export function stripRows(s: PanelState): StripRow[] {
  if (s.phase === 'over' && s.result) {
    return [...s.result]
      .sort((a, b) => a.place - b.place)
      .map((r) => ({ id: r.id, name: r.name, score: scoreText(r.score), detail: '#' + r.place, up: false, flags: [], notes: [] }));
  }
  return s.players.map((p) => {
    const detail = p.isUp && s.ball !== null ? 'BALL ' + s.ball : p.ballsDone >= s.ballsPerGame ? 'DONE' : p.ballsDone + '/' + s.ballsPerGame;
    const flags = p.flags.filter((f) => f !== 'build_mismatch').map((f) => (f === 'table_mismatch' ? 'DIFFERENT TABLE' : f === 'disconnected' ? 'OFFLINE' : String(f).toUpperCase()));
    const notes = p.flags.includes('build_mismatch') ? ['DIFFERENT VPX BUILD'] : [];
    return { id: p.id, name: p.name, score: scoreText(p.score), detail, up: p.isUp, flags, notes };
  });
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
export function stageText(s: PanelState | null, hasVideo: boolean): string {
  if (!s || hasVideo) return '';
  if (s.phase === 'over' || s.phase === 'idle') return '';
  if (s.myTurn) return 'NO PICTURE FROM YOUR TABLE';
  const up = s.players.find((p) => p.id === s.playerUp);
  return up ? 'WAITING FOR ' + up.name.toUpperCase() + "'S TABLE" : '';
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

/** D7.4: the size the theater feed is read at: the video's own, scaled down into the limit for its kind, even sides. */
export function feedSize(videoWidth: number, videoHeight: number, stereo: 'mono' | 'sbs'): { width: number; height: number } | null {
  if (!(videoWidth >= 2 && videoHeight >= 2)) return null;
  const max = stereo === 'sbs' ? { width: 3840, height: 1080 } : { width: 1920, height: 1080 };
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

const HELPERS = [videoBitrateFor, headerText, scoreText, stripRows, micText, videoPeer, stageText, videoCropRect, paintFrame, stereoOf, feedSize, stallStep];

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
  body { display: grid; grid-template-rows: auto 1fr auto auto; gap: 1vmin; padding: 1.5vmin; }
  #head { font-size: 7.5vmin; line-height: 1.1; letter-spacing: 0.04em; text-align: center; padding: 1vmin 0; }
  #head.mine { color: var(--mine); }
  #stage { position: relative; min-height: 0; background: var(--panel); border-radius: 1vmin; overflow: hidden; }
  #video { width: 100%; height: 100%; object-fit: contain; display: block; background: #000; }
  #idle { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; text-align: center;
    padding: 4vmin; font-size: 4.5vmin; color: var(--dim); }
  #strip { display: grid; gap: 0.6vmin; }
  .row { display: grid; grid-template-columns: 1fr auto auto; gap: 2vmin; align-items: baseline; padding: 0.6vmin 1.5vmin;
    background: var(--panel); border-radius: 0.8vmin; font-size: 4.8vmin; }
  .row.up { outline: 0.5vmin solid var(--up); }
  .row .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row .detail { color: var(--dim); font-size: 3.6vmin; }
  .row .score { font-variant-numeric: tabular-nums; }
  .row .flag { color: var(--bad); font-size: 3vmin; margin-left: 1.5vmin; }
  .row .note { color: var(--dim); font-size: 3vmin; font-weight: 400; margin-left: 1.5vmin; }
  footer { display: flex; gap: 2vmin; align-items: baseline; font-size: 3.8vmin; min-height: 4.5vmin; }
  #mic { color: var(--dim); white-space: nowrap; }
  #mic.muted, #mic.none { color: var(--bad); }
  #msg { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style></head>
<body class="${opts.vr ? 'vr' : 'desktop'}">
<div id="head">CASTCADE MATCH</div>
<div id="stage"><video id="video" autoplay playsinline muted></video><div id="idle"></div></div>
<video id="src" autoplay playsinline muted style="position: fixed; left: 0; top: 0; width: 2px; height: 2px; opacity: 0; pointer-events: none"></video>
<div id="strip"></div>
<footer><span id="mic"></span><span id="msg"></span></footer>
<script>
'use strict';
const { ipcRenderer } = require('electron');
const C = ${JSON.stringify(PANEL_CHANNELS)};
const VIDEO = ${JSON.stringify(PANEL_VIDEO)};
const FEED_FPS = ${VIDEO_FEED_MAX.fps};
const STALL_MS = ${CAPTURE_STALL_MS};
const STATS_MS = ${STATS_MS};
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
 * sender has encodings, remote audio played by one muted-free <audio> per peer, the stage <video> muted.
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
const $ = (id) => document.getElementById(id);
const errText = (e) => (e && e.message ? e.message : String(e));

function report() {
  const peers = {};
  for (const [id, r] of remote) {
    const v = r.stream.getVideoTracks()[0];
    const a = r.stream.getAudioTracks()[0];
    peers[id] = {
      ice: r.pc.iceConnectionState,
      receivingVideo: !!v && v.readyState === 'live' && !v.muted,
      receivingAudio: !!a && a.readyState === 'live' && !a.muted,
      signaling: r.pc.signalingState,
      reopens: reopens.get(id) || 0,
    };
  }
  ipcRenderer.send(C.status, { sending: sending, peers: peers, mic: micState, capturing: !!videoTrack, error: localError, captureStalled: stalled, stats: stats });
}

function fail(msg) {
  localError = msg;
  report();
  render();
}

function render() {
  const head = $('head');
  if (!panel) {
    head.textContent = 'CASTCADE MATCH';
    head.className = '';
  } else {
    head.textContent = headerText(panel);
    head.className = panel.myTurn && panel.phase === 'playing' ? 'mine' : '';
  }
  const who = panel ? videoPeer(panel) : null;
  let stream = null;
  if (who === 'self') stream = videoTrack ? new MediaStream([videoTrack]) : null;
  else if (who && remote.has(who)) stream = remote.get(who).stream;
  const key = who === 'self' ? 'self:' + (videoTrack ? videoTrack.id : '') : who ? 'peer:' + who : '';
  const video = $('video');
  if (key !== stageKey) {
    stageKey = key;
    video.srcObject = stream;
  }
  const hasVideo = !!stream && stream.getVideoTracks().some((t) => t.readyState === 'live' && (who === 'self' || !t.muted));
  $('idle').textContent = stageText(panel, hasVideo);
  const strip = $('strip');
  strip.replaceChildren();
  for (const row of panel ? stripRows(panel) : []) {
    const el = document.createElement('div');
    el.className = row.up ? 'row up' : 'row';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = row.name;
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
  const mic = panel ? panel.mic : micState;
  $('mic').textContent = micText(mic);
  $('mic').className = mic === 'open' ? '' : mic === 'muted' ? 'muted' : 'none';
  $('msg').textContent = (panel && panel.message) || localError || '';
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

/** D2.5: one frame of the match video onto the canvas (the crop, or the cover). */
function paint() {
  if (!cap || !ctx) return;
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
/** D7.4.3: a new declared stereo goes to every peer (a new connection gets it from openPeer); none given, nothing said. */
function noteStereo(s) {
  if (s === undefined) return;
  const v = s === 'sbs' || s === 'mono' ? s : null;
  if (v === myStereo) return;
  myStereo = v;
  if (mesh) for (const id of remote.keys()) sendStereo(id);
}
function sendStereo(peer) {
  if (myStereo === undefined) return;
  ipcRenderer.send(C.send, { to: peer, signal: { kind: 'stereo', stereo: myStereo } });
}

async function openCapture(c) {
  if (!c) {
    if (srcTrack || videoTrack) dropCapture();
    return;
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
  if (!videoTrack || videoTrack.readyState !== 'live') {
    const out = canvas.captureStream(VIDEO.fps).getVideoTracks()[0];
    if (!out) {
      fail('Could not capture ' + c.label + ' (the canvas gave no track).');
      return;
    }
    // D7.4.6: theater shows this life-size in a headset, so under a thin uplink keep the resolution and drop frames.
    try { out.contentHint = 'detail'; } catch (e) { /* older engines */ }
    out.enabled = sending && !stalled;
    videoTrack = out;
    localStream.addTrack(out);
    for (const r of remote.values()) attachVideo(r);
  }
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
  if (sending && srcTrack) capture = capFrames;
  capFrames = 0;
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
  if (capture === null && decoded === null) return;
  statsSeq++;
  stats = { seq: statsSeq, capture: capture, decoded: decoded, toLayer: toLayer };
  // D7.4.6: sizes and rates, from the probe of the tick before (getStats is async); keys absent until there is one.
  if (capture !== null && outInfo) stats.sent = outInfo;
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
      outInfo = { width: s.frameWidth || 0, height: s.frameHeight || 0, kbps: kbps, limit: s.qualityLimitationReason || 'none' };
      return;
    }
  } catch (e) { /* no stats yet */ }
}
setInterval(statsTick, STATS_MS);

function attachAudio(r) {
  if (!micTrack) return;
  if (r.audioSender) void r.audioSender.replaceTrack(micTrack);
  else r.audioSender = r.pc.addTrack(micTrack, localStream);
}

function attachVideo(r) {
  if (!videoTrack) return;
  if (r.videoSender) void r.videoSender.replaceTrack(videoTrack);
  else r.videoSender = r.pc.addTrack(videoTrack, localStream);
  void applyBitrate(r);
}

async function applyBitrate(r) {
  const sender = r.videoSender;
  if (!sender) return;
  try {
    const p = sender.getParameters();
    if (!p.encodings || !p.encodings.length) return;
    // D7.4.6: a cap per shape, from the crop actually sent (it changes when the window does).
    const want = cap ? videoBitrateFor({ width: cap.out.width, height: cap.out.height, stereo: myStereo }) : VIDEO.maxBitrate;
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
  try { r.pc.close(); } catch (e) { /* closed */ }
  if (stageKey === 'peer:' + peer) stageKey = null;
}

/** The mesh's factory: a connection to one peer with our tracks on it. */
function openPeer(peer) {
  closeRemote(peer);
  const pc = new RTCPeerConnection({ iceServers: ice, bundlePolicy: 'max-bundle' });
  const r = { pc: pc, stream: new MediaStream(), audio: new Audio(), audioSender: null, videoSender: null, retry: null };
  r.audio.autoplay = true;
  r.audio.srcObject = r.stream;
  pc.addEventListener('track', (e) => {
    const t = e.track;
    for (const old of r.stream.getTracks()) if (old.kind === t.kind && old !== t) r.stream.removeTrack(old);
    r.stream.addTrack(t);
    t.addEventListener('mute', () => { report(); render(); });
    t.addEventListener('unmute', () => { report(); render(); });
    void r.audio.play().catch(() => undefined);
    if (stageKey === 'peer:' + peer) stageKey = null;
    report();
    render();
  });
  pc.addEventListener('iceconnectionstatechange', () => {
    if (pc.iceConnectionState === 'failed') pc.restartIce();
    report();
  });
  pc.addEventListener('signalingstatechange', () => {
    if (pc.signalingState === 'stable') void applyBitrate(r);
    report();
  });
  remote.set(peer, r);
  attachAudio(r);
  attachVideo(r);
  // An offer lost on the way (the peer attached late, a reconnect) is sent again until the connection is up.
  r.retry = setInterval(() => {
    const n = mesh && mesh.get(peer);
    const st = pc.iceConnectionState;
    if (n && n.pc === pc && st !== 'connected' && st !== 'completed') n.resendOffer();
  }, 5000);
  sendStereo(peer);
  return pc;
}

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
    (to, signal) => ipcRenderer.send(C.send, { to: to, signal: signal }),
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
  await Promise.all([openMic(a.micDeviceId), openCapture(a.capture)]);
  if (mesh !== m) return;
  for (const p of a.peers) mesh.add(p);
  report();
  render();
}

function detach() {
  if (mesh) mesh.close();
  mesh = null;
  for (const id of [...remote.keys()]) closeRemote(id);
  for (const t of localStream.getTracks()) {
    localStream.removeTrack(t);
    t.stop();
  }
  micTrack = null;
  videoTrack = null;
  srcTrack = null;
  cap = null;
  covered = false;
  stalled = false;
  stats = null;
  $('src').srcObject = null;
  micState = 'unavailable';
  sending = false;
  stageKey = null;
  myStereo = undefined;
  peerStereo.clear();
  reopens.clear();
  report();
  render();
}

ipcRenderer.on(C.attach, (_e, a) => void attach(a));
ipcRenderer.on(C.signal, (_e, m) => {
  // D7.4.3: a peer's declared stereo is the page's, not the connection's; kept whether or not the peer is added yet.
  if (m.signal && m.signal.kind === 'stereo') {
    peerStereo.set(m.from, m.signal.stereo === 'sbs' || m.signal.stereo === 'mono' ? m.signal.stereo : null);
    return;
  }
  if (mesh) void mesh.receive(m.from, m.signal);
});
ipcRenderer.on(C.addPeer, (_e, p) => { if (mesh) mesh.add(p); report(); });
ipcRenderer.on(C.removePeer, (_e, p) => {
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
  if (!feedWanted || !panel) return;
  const now = Date.now();
  if (feedInFlight && now - feedSentAt < 1000) return;
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
  const size = feedSize(v.videoWidth, v.videoHeight, stereo);
  if (!size) return;
  try {
    if (!feedCtx) {
      feedCanvas = document.createElement('canvas');
      feedCtx = feedCanvas.getContext('2d', { alpha: false, willReadFrequently: true });
      if (!feedCtx) return;
    }
    if (feedCanvas.width !== size.width) feedCanvas.width = size.width;
    if (feedCanvas.height !== size.height) feedCanvas.height = size.height;
    feedCtx.drawImage(v, 0, 0, size.width, size.height);
    const img = feedCtx.getImageData(0, 0, size.width, size.height);
    feedLastFrame = mark;
    feedSent++;
    feedInFlight = true;
    feedSentAt = now;
    ipcRenderer.send(C.video, { width: size.width, height: size.height, rgba: new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength), stereo: stereo });
  } catch (e) {
    /* a frame lost; the next tick tries again */
  }
}
setInterval(feedTick, Math.round(1000 / FEED_FPS));
ipcRenderer.on(C.videoWant, (_e, on) => {
  feedWanted = !!on;
  feedInFlight = false;
  feedLastFrame = -1;
});
ipcRenderer.on(C.videoAck, () => { feedInFlight = false; });
setInterval(report, 2000);
render();
ipcRenderer.send(C.ready);
`;
