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
    flags: Array<'table_mismatch' | 'build_mismatch' | 'disconnected'>;
  }>;
  /** `idle` before start, `playing`, `paused` (someone dropped), `over` once RESULT is in. */
  phase: 'idle' | 'playing' | 'paused' | 'over';
  /** Standings once `phase` is `over`, best first. */
  result: Array<{ id: MatchPlayerId; name: string; score: number; place: number }> | null;
  /** One line for the player: an error, "different table file", "waiting for <name>". Null when nothing to say. */
  message: string | null;
  mic: 'open' | 'muted' | 'unavailable';
}

/** One signalling envelope; the media layer never sees the protocol message around it. */
export interface MediaSignal {
  kind: 'offer' | 'answer' | 'ice';
  sdp?: string;
  candidate?: { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null };
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
  /** Per peer: ICE connection state as the browser names it (`new`, `checking`, `connected`, `failed`, …). */
  peers: Record<MatchPlayerId, { ice: string; receivingVideo: boolean; receivingAudio: boolean }>;
  mic: 'open' | 'muted' | 'unavailable';
  /** The capture source in use, for the Match tab: the window title, or null. */
  captureSource: string | null;
  lastError: string | null;
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
  /** Shows the desktop panel window (no-op in VR, where the overlay helper shows it). */
  showPanel(): void;
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

export interface VrOverlayStatus {
  state: 'stopped' | 'starting' | 'showing' | 'hidden' | 'unavailable';
  /**
   * Why `unavailable`: `steamvr_not_running`, `helper_missing`, `helper_failed:<detail>`; `runtime_not_steamvr` (B22,
   * 2026-10-31) is set by the match host, not the helper: VPX is in VR on another runtime, so the helper is not spawned.
   */
  reason: string | null;
}

/** The OpenVR overlay helper as the controller sees it (implemented by `media/vr-overlay.ts`, D7). */
export interface VrOverlay {
  start(source: PanelFrameSource): Promise<VrOverlayStatus>;
  stop(): Promise<void>;
  status(): VrOverlayStatus;
  onStatus(cb: (s: VrOverlayStatus) => void): () => void;
}

/** Default placement (alpha-match.md §5): head-anchored, 0.55 m wide, below the line of sight. */
export const VR_OVERLAY_DEFAULTS = { widthM: 0.55, anchor: 'hmd' as const, offset: [0, -0.28, -0.9] as const, alpha: 0.95 };

/** The frame pipe's header, 16 bytes little-endian: "CVO1", width, height, byteLength. */
export const VR_OVERLAY_FRAME_MAGIC = 'CVO1';
