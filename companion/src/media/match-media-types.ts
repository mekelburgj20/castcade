/**
 * The contract between the three alpha-match pieces (docs/design/alpha-match.md §2, 2026-10-30): the match
 * controller drives `MatchMedia`; the panel page renders `PanelState`; the panel's frames reach the headset through
 * `PanelFrameSource` → `VrOverlay`. Types only, no Electron import: every piece unit-tests against fakes of these.
 * Changing a shape here means telling the owners of the other pieces (WORK items A6, D2, D7).
 */

/** A protocol player id (the companion's stable per-install id; see alpha-match.md §3). */
export type MatchPlayerId = string;

/** What the controller tells the media layer to draw. Everything is plain data; the panel never computes turns. */
export interface PanelState {
  /** Whose ball it is now; null before the first grant and after the result. */
  playerUp: MatchPlayerId | null;
  /** True when `playerUp` is this companion's own player. */
  myTurn: boolean;
  /** Ball number of the current grant, 1-based; null when none. */
  ball: number | null;
  ballsPerGame: number;
  players: Array<{
    id: MatchPlayerId;
    name: string;
    /** Latest score known for that player (STATE / BALL_END), null before their first ball. */
    score: number | null;
    /** Balls that player has finished. */
    ballsDone: number;
    isUp: boolean;
    /**
     * `table_mismatch`: their table differs from the host's (advisory, alpha-match.md §3); `build_mismatch` (D2.5,
     * 2026-10-31): their VPX build does (`emulatorVersion`), shown muted: the table may still be the same.
     */
    flags: Array<'table_mismatch' | 'build_mismatch' | 'disconnected' | 'loading'>;
    /**
     * D7.4 (2026-10-31): that player's declared rig (HELLO / lobby update). The headset panel reads it to tell a VR
     * sender's side-by-side preview ("both eyes") from a wide monitor picture. Absent in states made before D7.4.
     */
    rig?: 'pc' | 'vr_headset' | 'real_cabinet';
  }>;
  /**
   * `idle` before start, `playing`, `paused` (someone dropped), `over` once a game's RESULT is in. A10 (2026-11-02): a
   * match is a series, so `over` is the gap between games until `seriesOver`.
   */
  phase: 'idle' | 'playing' | 'paused' | 'over';
  /** Standings of the game just played once `phase` is `over`, best first. */
  result: Array<{ id: MatchPlayerId; name: string; score: number; place: number }> | null;
  /** A10: the game of the series being played (or just played), 1-based. Absent in states made before A10. */
  game?: number;
  /** A10: the series standings after the last RESULT (wins, then total score), best first; null before the first one. */
  series?: Array<{ id: MatchPlayerId; name: string; wins: number; games: number; total: number; place: number }> | null;
  /** A10: the series is over (the host ended it, or left between games): no next game follows. */
  seriesOver?: boolean;
  /** A11 (2026-11-02): whole seconds until the match starts from the host's table; null when no start is counting down. */
  countdown?: number | null;
  /** One line for the player: an error, "different table file", "waiting for <name>". Null when nothing to say. */
  message: string | null;
  mic: 'open' | 'muted' | 'unavailable';
}

/**
 * One signalling envelope; the media layer never sees the protocol message around it. D2.7 (2026-11-01): `reset` says
 * the sender's connections are new (its panel page was rebuilt), so the receiver reopens its own before the sender's
 * fresh offer lands. D7.4.3 (2026-11-01): `stereo` is what the sender's video is, declared by the sender (`stereo`).
 */
export interface MediaSignal {
  kind: 'offer' | 'answer' | 'ice' | 'reset' | 'stereo';
  sdp?: string;
  candidate?: { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null };
  /** On `stereo`: `sbs` (VPX's VR preview on both eyes), `mono`, or null (the sender does not know). */
  stereo?: VrStereo | null;
  /**
   * D7.5 (2026-11-02): on `stereo` from a sender whose picture is the layer camera's: each eye's fov, crop and render
   * size (`LayerCameraEye` without the data), left then right, so the receiver's stereo window is placed from the
   * sender's eyes, not its own (exact for mixed headsets). Null or absent: a screen capture (the receiver's own eyes
   * stand in, as before). Sent by the panel page once the lead wires §5a of docs/design/alpha-match.md.
   */
  eyes?: LayerCameraEyeGeometry[] | null;
}

/** How the media layer reaches the other players: the controller wraps the match transport (MEDIA_SIGNAL). */
export interface MediaSignalling {
  readonly localId: MatchPlayerId;
  send(to: MatchPlayerId, signal: MediaSignal): void;
  onSignal(cb: (from: MatchPlayerId, signal: MediaSignal) => void): () => void;
}

export interface MediaStatus {
  attached: boolean;
  sending: boolean;
  /**
   * Per peer: ICE connection state as the browser names it (`new`, `checking`, `connected`, `failed`, …). D2.7
   * (2026-11-01): `signaling` (the connection's signalling state) and `reopens` (how often the page replaced that
   * connection after a `reset` or a stale offer), so a dead connection shows in companion.log. Absent before D2.7.
   */
  peers: Record<MatchPlayerId, { ice: string; receivingVideo: boolean; receivingAudio: boolean; signaling?: string; reopens?: number; receivingTable?: boolean }>;
  mic: 'open' | 'muted' | 'unavailable';
  /** The capture source in use, for the Match tab: the window title, or null. */
  captureSource: string | null;
  /**
   * D7.4 (2026-10-31): the size of the window region sent (the crop), while the capture is live. The Match tab reads its
   * aspect: a VR rig sending a single-eye preview is told to switch VPX's preview to both eyes. Absent before D7.4.
   */
  captureCrop?: { width: number; height: number } | null;
  /**
   * D2.6 (2026-11-01): the desktop panel window (absent for the headset panel): whether it is up and where it sits
   * relative to the main window. The Match tab names it, since it is a separate window (and invisible to anyone
   * watching through Virtual Desktop: it is excluded from screen capture).
   */
  panelWindow?: { visible: boolean; side: 'right' | 'left' | 'below' | 'edge' } | null;
  /**
   * D7.4.3 (2026-11-01): what this rig tells the others its picture is (the capture's `stereo`), while the capture is
   * live: `sbs` both eyes, `mono` one picture, null not known. Absent before D7.4.3.
   */
  captureStereo?: VrStereo | null;
  /**
   * D7.4.10 (2026-11-02): the preview window covers its whole display (presented full screen once VPX has focus, which
   * stops the screen capture: Krobs' rig) or hangs off an edge (those rows are not sent), while the capture is live.
   * Absent otherwise.
   */
  captureWarning?: string | null;
  /**
   * D2.8 (2026-11-01): table sound (`media/audio-helper.ts`, audio-helper/README.md). `helper`: the helper runs
   * (`ready`) or cannot (`unavailable`: `helper_missing`, `helper_failed:<code>`); `reason` also carries a ready
   * helper's `tap_unavailable:<why>` (Windows before 10 2004: muting works, sending does not). `muted`: this rig's VPX
   * is held muted now (another player is up); `tapping`: its sound is being captured for the others (this rig is up).
   * Added by the match host (the media layer does not know it); absent when there is no helper wiring. Per peer,
   * `receivingTable` (D2.8) says their table track is live.
   */
  tableAudio?: TableAudioStatus;
  lastError: string | null;
}

/** D2.8: see `MediaStatus.tableAudio`. */
export interface TableAudioStatus {
  helper: 'ready' | 'unavailable';
  reason: string | null;
  muted: boolean;
  tapping: boolean;
}

/** D2.8: what the panel page does with table sound: send this rig's (the table track live) and play the up player's. */
export interface TableAudioFlags {
  send: boolean;
  hear: boolean;
}

/** What the match controller drives (implemented by `media/rtc-host.ts`, D2). */
export interface MatchMedia {
  /** Called at MATCH_READY with every other participant; opens the mesh. */
  attach(signalling: MediaSignalling, peers: MatchPlayerId[]): Promise<void>;
  /** A peer joined late or reconnected (A3): open or re-open its connection. */
  addPeer(peer: MatchPlayerId): void;
  removePeer(peer: MatchPlayerId): void;
  /** Video flows from this rig only while true (the player up); audio is unaffected. */
  setSending(on: boolean): void;
  setPanelState(state: PanelState): void;
  setMuted(muted: boolean): void;
  status(): MediaStatus;
  onStatus(cb: (s: MediaStatus) => void): () => void;
  /** Frames of the panel for the headset (available once attached; null on a desktop rig). */
  frames(): PanelFrameSource | null;
  /** D7.4: frames of the up player's video for theater mode (available with `frames()`); absent in fakes before D7.4. */
  videoFrames?(): VideoFrameSource | null;
  /** Shows the desktop panel window (no-op in VR, where the overlay helper shows it). */
  showPanel(): void;
  /** D2.6 (2026-11-01): hides the desktop panel window without ending anything (the Match tab's Hide panel). */
  hidePanel?(): void;
  /**
   * D2.8 (2026-11-01): table sound on the page. `send`: the table track carries this rig's VPX sound (fed by
   * `pushTableAudio`); `hear`: the up player's table track plays (never this rig's own). Absent in fakes before D2.8.
   */
  setTableAudio?(flags: TableAudioFlags): void;
  /** D2.8: one 10 ms frame of this rig's VPX sound (float32 stereo 48 kHz, the helper's frame payload). Dropped unless sending. */
  pushTableAudio?(pcm: Uint8Array): void;
  /** D2.8: the pid of the window the capture sends (the "Visual Pinball Player" window's VPX), or null with no capture. */
  capturePid?(): number | null;
  detach(): Promise<void>;
}

/** One rendered panel frame, BGRA top-down, `bgra.length === width * height * 4`. */
export interface PanelFrame {
  width: number;
  height: number;
  bgra: Uint8Array;
}

export interface PanelFrameSource {
  /** Frames arrive at up to 20 per second, only when the picture changed. */
  onFrame(cb: (frame: PanelFrame) => void): () => void;
}

/**
 * D7.4 (2026-10-31): one frame of the up player's video for theater mode, RGBA top-down (canvas `getImageData`, so
 * nobody swaps bytes), `rgba.length === width * height * 4`. `sbs`: the left half is the left eye, the right half the
 * right eye (VPX's VR preview on "both eyes").
 */
export interface VideoFrame {
  width: number;
  height: number;
  rgba: Uint8Array;
  stereo: VrStereo;
}

export interface VideoFrameSource {
  /** Frames arrive at up to 30 per second while wanted, only when the video has a new frame. */
  onFrame(cb: (frame: VideoFrame) => void): () => void;
  /** The panel page reads the video only while someone wants it (theater mode): it costs a copy per frame. */
  setWanted(on: boolean): void;
}

/**
 * D7.4 (2026-10-31): what the OpenXR layer shows (vr-layer/README.md "The pipe"). D7.4.5: the layer's CVC1 control also
 * reads an optional number `theaterScale` (the stereo window's size against life size, 0.25–4, default 1); D7.4.9
 * the companion sends it with every control, from the Match tab's "Theater size" (match settings `theaterScale`).
 */
export type VrViewMode = 'hidden' | 'panel' | 'theater';
export type VrStereo = 'mono' | 'sbs';

export interface VrOverlayStatus {
  state: 'stopped' | 'starting' | 'showing' | 'hidden' | 'unavailable';
  /**
   * Why. The SteamVR helper: `unavailable` `steamvr_not_running`, `helper_missing`, `helper_failed:<detail>`. The OpenXR
   * layer (D7.3, 2026-10-31): `unavailable` `layer_missing` / `layer_disabled`, `starting` `restart_vpx` (no answer on
   * the pipe while VPX runs: VPX predates the registration) / `register_failed`, `hidden` `pipe_closed`.
   * (`runtime_not_steamvr`, B22, is gone: every runtime has an overlay since D7.3.)
   */
  reason: string | null;
  /**
   * D7.3.3 (2026-11-02), the OpenXR layer only: the VPX running started before the layer was registered (the registry
   * value or its files changed after), so it runs an older layer or none; the Match tab says to restart VPX. Absent
   * otherwise.
   */
  vpxBeforeLayer?: true;
}

/**
 * D7.5 (2026-11-02): the layer camera (vr-layer/README.md "The camera"; docs/design/alpha-match.md §5a). What the
 * companion asks the OpenXR layer for: each of VPX's two eye views, centre-cropped to this box's aspect and scaled into
 * it (never up), at most `fps` frames a second, as JPEG over the pipe. `media/layer-camera.ts` picks the numbers.
 */
export interface LayerCameraRequest {
  width: number;
  height: number;
  fps: number;
}

/** D7.5: one eye's geometry as the sender's VPX rendered it: enough to place its picture from the sender's eye, not the receiver's. */
export interface LayerCameraEyeGeometry {
  /** The view's field of view, radians, OpenXR's order and signs: [angleLeft, angleRight, angleUp, angleDown]. */
  fov: [number, number, number, number];
  /** The crop taken inside the view's render: [x, y, width, height], y from the top. */
  rect: [number, number, number, number];
  /** The view's render size (its `imageRect`): [width, height]. */
  render: [number, number];
}

/** D7.5: one eye of a camera frame: its geometry and its JPEG. */
export interface LayerCameraEye extends LayerCameraEyeGeometry {
  data: Uint8Array;
}

/** D7.5: one camera frame off the pipe (`VrOverlay.onCameraFrame`): both eyes, left then right, each `width` x `height`. */
export interface LayerCameraFrame {
  /** The layer's frame counter (issued frames: a gap is a drop on its side). */
  n: number;
  /** Microseconds since the layer's camera started. */
  t: number;
  encoding: 'jpeg';
  width: number;
  height: number;
  eyes: LayerCameraEye[];
  /** The layer's own timings for this frame, microseconds (render thread: issue, map; worker: copy, encode). */
  us?: { issue: number; map: number; copy: number; enc: number } | null;
}

/**
 * D7.5: where the layer camera stands. `off`: not asked (or the layer stopped it: `why`); `asked`: asked, no answer
 * yet (a protocol-2 layer never answers: the fallback timer decides); `on`: the layer confirmed and frames may flow;
 * `refused`: the layer cannot read VPX's frame (`why`), the screen capture stays.
 */
export interface LayerCameraStatus {
  state: 'off' | 'asked' | 'on' | 'refused';
  why: string | null;
  /** On `on`: the graphics API read, the eye render size and the size sent per eye, as the layer said. */
  api?: string | null;
  source?: { width: number; height: number } | null;
  size?: { width: number; height: number } | null;
  /** `Date.now()` of the last frame, or null. */
  lastFrameAt: number | null;
  /** Frames received since the camera was asked. */
  frames: number;
}

/** The in-headset panel as the controller sees it: the SteamVR helper (`media/vr-overlay.ts`, D7) or the OpenXR layer (`media/vr-layer.ts`, D7.3). */
export interface VrOverlay {
  /** `video` (D7.4): the up player's video for theater mode; only the OpenXR layer takes it. */
  start(source: PanelFrameSource, video?: VideoFrameSource | null): Promise<VrOverlayStatus>;
  /**
   * D7.4 (2026-10-31): hidden on this player's own turn, theater while another is up, the panel otherwise (the match
   * host decides, `vrViewMode` in match/controller.ts). The OpenXR layer only; the SteamVR helper keeps the panel.
   */
  setMode(mode: VrViewMode): void;
  /** D7.4.9: the theater window's size against life size (0.25–4); the OpenXR layer only. Idempotent. */
  setTheaterScale?(scale: number): void;
  stop(): Promise<void>;
  status(): VrOverlayStatus;
  onStatus(cb: (s: VrOverlayStatus) => void): () => void;
  /**
   * D7.5 (2026-11-02), the OpenXR layer only (absent on the SteamVR helper and in fakes before D7.5): ask the layer for
   * the camera (or stop it with null). Sent with the control once a protocol-3 layer is on the pipe, and again on
   * every new connection while asked.
   */
  setCamera?(req: LayerCameraRequest | null): void;
  /** D7.5: every complete camera frame off the pipe, in order; frames arrive only while asked and the layer is on. */
  onCameraFrame?(cb: (frame: LayerCameraFrame) => void): () => void;
  cameraStatus?(): LayerCameraStatus;
  onCameraStatus?(cb: (s: LayerCameraStatus) => void): () => void;
  /**
   * D7.6 (2026-11-03), the OpenXR layer only: the test bench's view of the pipe (connected, its protocol, the last
   * session report, the last controls sent) and its changes.
   */
  bench?(): VrLayerBench;
  onBench?(cb: (b: VrLayerBench) => void): () => void;
  /**
   * D7.6.2: ask the connected protocol-3 layer for its session report (control `report: true`); the report that comes
   * back, or null when none came within `timeoutMs` (an older layer, VPX not rendering) or no layer is connected.
   */
  requestSession?(timeoutMs: number): Promise<LayerSessionReport | null>;
}

/**
 * D7.6.2 (2026-11-03): the layer's session report (CVS1 `{"kind": "session", ...}`, vr-layer/src/layer.cpp
 * sessionFacts): runtime, system, view configuration, VPX's fov, swapchains and last frame, the graphics binding,
 * OpenComposite's marks, the last theater placement. `facts` is the JSON as the layer sent it, minus `kind`.
 */
export interface LayerSessionReport {
  /** `Date.now()` when it arrived. */
  receivedAt: number;
  facts: Record<string, unknown>;
}

/** D7.6: the OpenXR layer as the test bench sees it. */
export interface VrLayerBench {
  /** `start` ran and `stop` did not (a match holds the overlay). */
  started: boolean;
  /** The pipe is connected to the layer in VPX. */
  connected: boolean;
  /** The connected layer's pipe protocol (1 until its hello; 0 when not connected). */
  protocol: number;
  /** The last session report from the layer (this connection or an earlier one), or null. */
  session: LayerSessionReport | null;
  /** The last controls written to the pipe, oldest first (at most `BENCH_CONTROLS`), as JSON text. */
  controls: Array<{ at: number; text: string }>;
}

/** Default placement (alpha-match.md §5): head-anchored, 0.55 m wide, below the line of sight. */
export const VR_OVERLAY_DEFAULTS = { widthM: 0.55, anchor: 'hmd' as const, offset: [0, -0.28, -0.9] as const, alpha: 0.95 };

/** The frame pipe's header, 16 bytes little-endian: "CVO1", width, height, byteLength. */
export const VR_OVERLAY_FRAME_MAGIC = 'CVO1';
/** D7.4: the same header for a video frame (RGBA) on the OpenXR layer's pipe. */
export const VR_LAYER_VIDEO_MAGIC = 'CVO2';
/** D7.5: the layer's camera frame and camera status messages (layer → companion; magic, u32 byteLength, payload). */
export const VR_LAYER_CAMERA_FRAME_MAGIC = 'CVF1';
export const VR_LAYER_CAMERA_STATUS_MAGIC = 'CVS1';
