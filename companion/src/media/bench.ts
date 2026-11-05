/**
 * D7.6 (2026-11-03): the VR test bench, pure parts. The bench puts the headset in theater with no second player: the
 * media layer is attached without a match (local only, no peers, no listener; refused while a match is on), and the
 * layer shows a chosen source by a chosen path exactly as a receiver would:
 *
 *   - sources: a saved clip folder (D7.6.3, `frame-clip.ts`), looped at its recorded fps; or "my own table, live": this
 *     rig's layer camera (VPX in VR with the layer on pipe protocol 3; the camera reads VPX's submitted eye views
 *     before theater replaces them);
 *   - paths: `direct` (the frames drawn on a canvas in the panel page and handed to the layer as the theater feed, no
 *     encoder) or `loop` (a local WebRTC loop inside the panel page: two RTCPeerConnections, the canvas track sent
 *     from one to the other under the match's bitrate rule `videoBitrateFor`, the received track fed to the layer the
 *     way a peer's is), so the encoder's detail and bitrate are in the picture.
 *
 * The owner's question this answers (2026-11-03): geometry, scale, detail and frame rate alone, in five minutes.
 */
import type { VrStereo } from './match-media-types.js';

export type BenchSource = 'clip' | 'live';
export type BenchPath = 'direct' | 'loop';
export type BenchView = 'theater' | 'direct';

/** D7.6.9 (2026-11-03): the bitrate cap override on the loop, in bits per second: 1 to 100 Mbps. */
export const BENCH_BITRATE_MIN = 1_000_000;
export const BENCH_BITRATE_MAX = 100_000_000;

/**
 * What the Match tab asks for. `clip`: a folder under `<logs>/frames` and the side to play (sender eyes or received
 * frames). `bitrate` (D7.6.9): path `loop`'s cap in bits per second, or null for the match's rule (`videoBitrateFor`).
 */
export interface BenchRequest {
  source: BenchSource;
  path: BenchPath;
  clip: { name: string; side: 'sender' | 'receiver' } | null;
  bitrate: number | null;
}

/** The request from the renderer, checked; a string says what is wrong. Clip names are folder names only (no path). */
export function benchRequestFrom(raw: unknown): BenchRequest | string {
  if (typeof raw !== 'object' || raw === null) return 'No bench settings given';
  const v = raw as { source?: unknown; path?: unknown; clip?: unknown; bitrate?: unknown };
  const source = v.source === 'live' ? 'live' : v.source === 'clip' ? 'clip' : null;
  if (!source) return 'Pick a source: a saved clip, or your own table live';
  const path = v.path === 'loop' ? 'loop' : 'direct';
  // D7.6.9: the cap override is null (the match's rule) or a whole number of bits per second within the range.
  const b = v.bitrate;
  if (b !== undefined && b !== null && !(typeof b === 'number' && Number.isInteger(b) && b >= BENCH_BITRATE_MIN && b <= BENCH_BITRATE_MAX)) {
    return `The bitrate cap must be between ${BENCH_BITRATE_MIN / 1e6} and ${BENCH_BITRATE_MAX / 1e6} Mbps, or the match's rule`;
  }
  const bitrate = typeof b === 'number' ? b : null;
  if (source === 'live') return { source, path, clip: null, bitrate };
  const c = (typeof v.clip === 'object' && v.clip !== null ? v.clip : {}) as { name?: unknown; side?: unknown };
  if (typeof c.name !== 'string' || !/^\d{4}-\d{2}-\d{2}-\d{6}(-\d+)?$/.test(c.name)) return 'Pick a saved clip (Save 2 s of frames makes one)';
  return { source, path, clip: { name: c.name, side: c.side === 'receiver' ? 'receiver' : 'sender' }, bitrate };
}

export type BenchState = 'off' | 'starting' | 'running';
export type BenchEvent = { kind: 'start'; matchOn: boolean } | { kind: 'started' } | { kind: 'failed' } | { kind: 'stop' } | { kind: 'match' };

/**
 * The bench's state machine. `start` is refused while a match is on or the bench already runs; `stop`, a failure, and a
 * match starting all end it and detach the media. `refuse` is the player's text; `detach`: tear the bench down now.
 */
export function benchStep(state: BenchState, e: BenchEvent): { state: BenchState; refuse?: string; detach?: boolean } {
  switch (e.kind) {
    case 'start':
      if (e.matchOn) return { state, refuse: 'A match is on: the VR test bench runs only without a match. Leave the match first.' };
      if (state !== 'off') return { state, refuse: 'The VR test bench is running already: stop it first.' };
      return { state: 'starting' };
    case 'started':
      return { state: state === 'starting' ? 'running' : state };
    case 'failed':
    case 'stop':
    case 'match':
      return state === 'off' ? { state } : { state: 'off', detach: true };
  }
}

/** Why "my own table, live" cannot run on this rig, or null when it can (VR off SteamVR, with the OpenXR layer). */
export function liveRefusal(rig: 'pc' | 'vr_headset' | 'real_cabinet', runtime: string | null, hasLayer: boolean): string | null {
  if (rig !== 'vr_headset') return 'Your own table, live needs VPX running in VR (the witness reads the monitor now): open the table in VR first.';
  if (runtime === 'steamvr') return 'Your own table, live needs the Castcade OpenXR layer, which does not run under SteamVR: theater is not available there.';
  if (!hasLayer) return 'Your own table, live needs the Castcade OpenXR layer, which is not in this build.';
  return null;
}

/** The panel page's report every second while the bench runs (page -> main). */
export interface BenchPageReport {
  path: BenchPath;
  /** Frames drawn on the bench canvas in the last second, and frames that did not decode. */
  drawn: number;
  bad: number;
  /** The last picture handed to the layer, and how many in the last second. */
  fed: { width: number; height: number; stereo: VrStereo } | null;
  fedFrames: number;
  /**
   * Path `loop`: the sending connection's outbound video (getStats), and the cap set on it; null before stats.
   * D7.6.8 (2026-11-03): `codec` is the codec stat's mimeType without "video/" ("VP8", "H264", "AV1"); `encoder` is
   * Chromium's `encoderImplementation` ("libvpx", "OpenH264", "MediaFoundationVideoEncodeAccelerator"...), " (hw)"
   * appended when it reports `powerEfficientEncoder`; null when the engine does not say.
   */
  sent: { width: number; height: number; kbps: number | null; fps: number | null; limit: string; codec: string | null; encoder: string | null } | null;
  bitrate: number | null;
  /** The stage has a picture (path `loop`: the received track arrived). */
  loopUp: boolean;
  error: string | null;
}

/** A page report, checked; null when it is not one. */
export function benchReportFrom(m: unknown): BenchPageReport | null {
  if (typeof m !== 'object' || m === null) return null;
  const v = m as Record<string, unknown>;
  const n = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : 0);
  const size = (x: unknown): { width: number; height: number } | null => {
    const s = x as { width?: unknown; height?: unknown } | null;
    return s && typeof s.width === 'number' && typeof s.height === 'number' ? { width: s.width, height: s.height } : null;
  };
  const fedSize = size(v.fed);
  const fed = fedSize ? { ...fedSize, stereo: (v.fed as { stereo?: unknown }).stereo === 'sbs' ? ('sbs' as const) : ('mono' as const) } : null;
  const s = v.sent as Record<string, unknown> | null | undefined;
  const sentSize = size(s);
  const sent =
    s && sentSize
      ? {
          ...sentSize,
          kbps: typeof s.kbps === 'number' ? s.kbps : null,
          fps: typeof s.fps === 'number' ? s.fps : null,
          limit: typeof s.limit === 'string' ? s.limit.slice(0, 40) : 'none',
          codec: typeof s.codec === 'string' && s.codec ? s.codec.slice(0, 32) : null,
          encoder: typeof s.encoder === 'string' && s.encoder ? s.encoder.slice(0, 64) : null,
        }
      : null;
  return {
    path: v.path === 'loop' ? 'loop' : 'direct',
    drawn: n(v.drawn),
    bad: n(v.bad),
    fed,
    fedFrames: n(v.fedFrames),
    sent,
    bitrate: typeof v.bitrate === 'number' ? v.bitrate : null,
    loopUp: v.loopUp === true,
    error: typeof v.error === 'string' ? v.error.slice(0, 300) : null,
  };
}

const mbps = (bits: number): string => `${(bits / 1e6).toFixed(1)} Mbps`;
/** D7.6.9: the cap in the start line, without a forced decimal ("16 Mbps", "12.5 Mbps"). */
const mbpsShort = (bits: number): string => `${Number((bits / 1e6).toFixed(1))} Mbps`;

/**
 * The live readout line (the Match tab, and companion.log every 10 s): frames a second drawn, the size handed to the
 * layer and at what rate, and on path `loop` the encoder's sent size, bitrate, fps, codec and encoder (D7.6.8) and
 * `qualityLimitationReason`.
 */
export function benchReadout(i: { report: BenchPageReport | null; headset: boolean; path: BenchPath; source: BenchSource; camera?: { state: string; why: string | null } | null }): string {
  const parts: string[] = [];
  const r = i.report;
  if (!r) parts.push('the panel is starting');
  else {
    parts.push(r.drawn > 0 ? `${r.drawn} fps drawn${r.bad ? ` (${r.bad} unreadable)` : ''}` : `no frame drawn${r.bad ? ` (${r.bad} unreadable)` : ''}`);
    if (!i.headset) parts.push('no headset layer: the picture is in the desktop panel');
    else if (r.fed) parts.push(`${r.fed.width}x${r.fed.height} ${r.fed.stereo} to the layer at ${r.fedFrames} fps`);
    else parts.push('nothing handed to the layer yet');
    if (i.path === 'loop') {
      const s = r.sent;
      if (s && s.width > 0) {
        const codec = s.codec ? `, ${s.codec}${s.encoder ? ` via ${s.encoder}` : ''}` : '';
        parts.push(`encoder sent ${s.width}x${s.height}${s.kbps !== null ? ` at ${mbps(s.kbps * 1000)}` : ''}${r.bitrate ? ` (cap ${mbps(r.bitrate)})` : ''}${s.fps !== null ? `, ${Math.round(s.fps)} fps` : ''}${codec}, limited by ${s.limit}`);
      }
      else parts.push(r.loopUp ? 'encoder: no stats yet' : 'local WebRTC loop connecting');
    }
    if (r.error) parts.push(r.error);
  }
  const c = i.camera;
  if (i.source === 'live' && c && c.state !== 'on') parts.push(`layer camera ${c.state}${c.why ? ` (${c.why})` : ''}`);
  return parts.join(' · ');
}

/** What to look at while the bench runs (the owner's words, 2026-11-03). */
export const BENCH_HEADSET_HINT = 'In the headset: a single window straight ahead, life size at Theater size 1; the picture should fuse without effort; compare detail with the direct view.';
export const BENCH_DESKTOP_HINT = 'On this PC the picture shows in the desktop panel window ("Castcade match"); theater in the headset needs VPX in VR with the Castcade OpenXR layer.';

export function benchHint(headset: boolean, view: BenchView): string {
  if (!headset) return BENCH_DESKTOP_HINT;
  return view === 'direct' ? "VPX's own view is showing now (the bench keeps running): switch back to compare." : BENCH_HEADSET_HINT;
}

/** The bench as the Match tab sees it (`MatchStatus.bench`); null while it is off. */
export interface BenchStatus {
  state: 'starting' | 'running';
  source: BenchSource;
  path: BenchPath;
  clip: string | null;
  /** The OpenXR layer shows it in theater (else the desktop panel window). */
  headset: boolean;
  view: BenchView;
  readout: string;
  hint: string;
}

/**
 * The words for the start line in the log. D7.6.9: the loop's cap override, when one is set. D7.5.9 (2026-11-04):
 * the camera's view on "my own table, live" (`view`, null when the source is a clip).
 */
export function benchWords(o: { source: BenchSource; path: BenchPath; clip?: { name: string; side: string; frames: number; fps: number } | null; headset: boolean; bitrate?: number | null; view?: 'whole' | 'window' | null }): string {
  const view = o.source === 'live' && o.view ? `, ${o.view} view` : '';
  const src = o.source === 'live' ? `my own table, live (the layer camera${view})` : o.clip ? `clip ${o.clip.name} (${o.clip.side} side, ${o.clip.frames} frames at ${o.clip.fps} fps)` : 'a clip';
  const path = o.path === 'loop' ? 'through a local WebRTC loop' : 'straight to the layer';
  const cap = o.path === 'loop' && o.bitrate ? `, cap ${mbpsShort(o.bitrate)}` : '';
  return `${src}, ${path}, ${o.headset ? 'theater in the headset' : 'the desktop panel'}${cap}`;
}
