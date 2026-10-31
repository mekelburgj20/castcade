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
  // page -> main
  ready: 'castcade-panel:ready',
  send: 'castcade-panel:send',
  status: 'castcade-panel:status',
  devices: 'castcade-panel:devices',
} as const;

/** The picture sent while this rig is up (alpha-match.md §4): the VR preview window is set to 1280x720. */
export const PANEL_VIDEO = { width: 1280, height: 720, fps: 30, maxBitrate: 2_500_000 } as const;

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
}

export interface PanelAttach {
  localId: MatchPlayerId;
  peers: MatchPlayerId[];
  ice: IceServer[];
  capture: PanelCapture | null;
  micDeviceId: string | null;
  muted: boolean;
  sending: boolean;
}

/** What the page reports; `rtc-host.ts` adds `attached` and `captureSource`. */
export interface PanelPageStatus {
  sending: boolean;
  peers: MediaStatus['peers'];
  mic: MediaStatus['mic'];
  capturing: boolean;
  error: string | null;
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

const HELPERS = [headerText, scoreText, stripRows, micText, videoPeer, stageText, videoCropRect, paintFrame];

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
const canvas = document.createElement('canvas');
const ctx = canvas.getContext('2d', { alpha: false });
let panel = null;
let localError = null;
let stageKey = null;
const localStream = new MediaStream();
const remote = new Map();
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
    };
  }
  ipcRenderer.send(C.status, { sending: sending, peers: peers, mic: micState, capturing: !!videoTrack, error: localError });
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
async function openCapture(c) {
  if (!c) {
    if (srcTrack || videoTrack) dropCapture();
    return;
  }
  if (cap && srcTrack && srcTrack.readyState === 'live' && cap.sourceId === c.sourceId) {
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
    // Pinball is motion: keep the frame rate, give up sharpness first under a thin uplink.
    try { out.contentHint = 'motion'; } catch (e) { /* older engines */ }
    out.enabled = sending;
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
    if (p.encodings[0].maxBitrate === VIDEO.maxBitrate) return;
    p.encodings[0].maxBitrate = VIDEO.maxBitrate;
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
  $('src').srcObject = null;
  micState = 'unavailable';
  sending = false;
  stageKey = null;
  report();
  render();
}

ipcRenderer.on(C.attach, (_e, a) => void attach(a));
ipcRenderer.on(C.signal, (_e, m) => { if (mesh) void mesh.receive(m.from, m.signal); });
ipcRenderer.on(C.addPeer, (_e, p) => { if (mesh) mesh.add(p); report(); });
ipcRenderer.on(C.removePeer, (_e, p) => {
  if (mesh) mesh.remove(p);
  closeRemote(p);
  report();
  render();
});
ipcRenderer.on(C.sending, (_e, on) => {
  sending = !!on;
  if (videoTrack) videoTrack.enabled = sending;
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
setInterval(report, 2000);
render();
ipcRenderer.send(C.ready);
`;
