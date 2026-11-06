/**
 * D7.6.2 (2026-11-03): the VR diagnostic report. Every headset finding so far cost a two-person session and came back
 * as one fact; this writes the whole picture of how VPX reaches the headset at once, on the Match tab's "Write VR
 * report", as `vr-report-<yyyy-mm-dd-hhmmss>.md` (for a person: sections, one fact per line) and `.json` (the same
 * facts, to diff between rigs) beside `companion.log`.
 *
 * Sources, each "unknown" (or a note saying why) when it is not there, never a failure of the whole report:
 *   - the layer in VPX: its session report (CVS1 `{"kind": "session"}`, vr-layer/src/layer.cpp sessionFacts) through
 *     the match's pipe connection, else over a short connection of its own (`probeLayerSession`);
 *   - the companion: the match settings, the ICE servers (never the TURN credential), the rig and the witness's VR
 *     reading, the last controls sent to the layer, the layer camera's status, the last 60 s of `capture:` /
 *     `theater:` / `vr-layer camera:` counter lines in companion.log, the end of vr-layer.log, the VPX preview window
 *     and its fit on its display (`capture-crop.ts` cropFit / fitWarning), and the `[PlayerVR]` keys of VPX's ini.
 *
 * Pure: the builders here take a fact object; `vr-report-host.ts` gathers the facts and writes the files.
 * D7.5.9–D7.5.11 (2026-11-04): the stereo window's settings (camera view, depth, vertical offset, soft edge) print in
 * words in the settings section, and the layer's `window.tune` / `window.feather` (what it applied) in the layer
 * section, so a geometry report from the owner's sliders reads without decoding JSON.
 */
import { cropFit, fitWarning, type CropFit } from '../media/capture-crop.js';
import type { LayerCameraStatus, MediaStatus, VrOverlayStatus } from '../media/match-media-types.js';
import { pickPlayfield, type Rect, type WindowProbe } from '../media/window-geometry.js';

/** How far back the counter lines go. */
export const COUNTER_WINDOW_MS = 60_000;
/** The counter lines: the capture's and the theater's 10 s lines (rtc-host.ts), the camera's (vr-layer.ts), the feed. */
export const COUNTER_PATTERN = /(capture:|theater:|vr-layer camera:)/;
/** How many of vr-layer.log's last lines go in. */
export const LAYER_LOG_LINES = 60;

export interface VrReportWindow {
  /** Why there is no window picture (the probe failed, no VPX player window), or null. */
  note: string | null;
  /** Every VPX window the probe saw. */
  windows: Array<{ title: string; pid: number; client: Rect; monitor: string }>;
  /** The player window ("Visual Pinball Player"), the display it is on and how it fits there. */
  playfield: { title: string; pid: number; client: Rect } | null;
  display: Rect | null;
  fit: CropFit | null;
  warning: string | null;
}

export interface VrReportFacts {
  writtenAt: string;
  companion: { version: string; protocol: number };
  layer: {
    /** `match`: the match's pipe connection; `probe`: a short connection of the report's own; `none`: neither. */
    source: 'match' | 'probe' | 'none';
    connected: boolean;
    protocol: number | null;
    /** The report came in answer to this request (not a stale one from earlier). */
    fresh: boolean;
    note: string;
    receivedAt: string | null;
    session: Record<string, unknown> | null;
  };
  rig: {
    rig: string;
    reason: string;
    vrRuntime: string | null;
    /** The witness's last VR reading of the VPX process (modules, compositor, active OpenXR runtime). */
    witnessVr: Record<string, unknown> | null;
    /** The VPX running started before this companion registered its layer (it runs an older one, or none). */
    vpxBeforeLayer: boolean | null;
    overlay: VrOverlayStatus | null;
  };
  match: { role: string; phase: string; settings: Record<string, unknown> | null };
  media: Pick<MediaStatus, 'attached' | 'sending' | 'captureSource' | 'captureCrop' | 'captureStereo' | 'captureWarning' | 'lastError'> | null;
  ice: { description: string; stun: string[]; turn: { url: string; username: string; credentialSet: boolean } | null } | null;
  controls: Array<{ at: string; text: string }>;
  camera: LayerCameraStatus | null;
  counters: { file: string | null; lines: string[]; note: string | null };
  layerLog: { file: string | null; lines: string[]; note: string | null };
  window: VrReportWindow;
  ini: { path: string | null; entries: Array<{ key: string; value: string }>; note: string | null };
}

const pad = (n: number, w = 2): string => String(n).padStart(w, '0');

/** `vr-report-2026-11-03-142501` in local time (the time on the owner's clock, as in vr-layer.log). */
export function reportBaseName(d: Date): string {
  return `vr-report-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/**
 * companion.log's counter lines (`COUNTER_PATTERN`) from the last `windowMs` before `nowMs`. Each line starts with
 * its ISO time (main/log.ts); a line without one is skipped. `text` may be the rotated `.1` file and the live one joined.
 */
export function recentCounterLines(text: string, nowMs: number, windowMs: number = COUNTER_WINDOW_MS): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!COUNTER_PATTERN.test(line)) continue;
    const at = Date.parse(line.slice(0, line.indexOf(' ')));
    if (!Number.isFinite(at) || at < nowMs - windowMs || at > nowMs + 5_000) continue;
    out.push(line);
  }
  return out;
}

/** The last `n` non-empty lines. */
export function tailLines(text: string, n: number): string[] {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .slice(-n);
}

/** The window facts from a probe (or its failure): the player window, its display and its fit (capture-crop.ts). */
export function windowFacts(probe: WindowProbe | null, error: string | null): VrReportWindow {
  const none: VrReportWindow = { note: null, windows: [], playfield: null, display: null, fit: null, warning: null };
  if (!probe) return { ...none, note: error ?? 'the window probe did not run' };
  const windows = probe.windows.map((w) => ({ title: w.title, pid: w.pid, client: w.client, monitor: w.monitor }));
  const win = pickPlayfield(probe.windows);
  if (!win) return { ...none, windows, note: 'no "Visual Pinball Player" window (no table running, or VPX minimised)' };
  const out = probe.outputs.find((o) => o.monitor === win.monitor) ?? null;
  const playfield = { title: win.title, pid: win.pid, client: win.client };
  if (!out) return { ...none, windows, playfield, note: 'the player window is on no display the DXGI probe listed' };
  const fit = cropFit(win, out.desktop);
  return { note: null, windows, playfield, display: out.desktop, fit, warning: fitWarning(fit, { width: out.desktop.width, height: out.desktop.height }) };
}

/** A value for one line: strings as they are, numbers and booleans as JSON, arrays of plain values joined, null "unknown". */
function scalar(v: unknown): string | null {
  if (v === null || v === undefined) return 'unknown';
  if (typeof v === 'string') return v === '' ? '(empty)' : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v) && v.every((x) => x === null || ['string', 'number', 'boolean'].includes(typeof x))) return v.length ? v.map((x) => (x === null ? 'null' : String(x))).join(', ') : 'none';
  return null;
}

/** Nested facts as `- a.b.c: value` lines, one fact per line; arrays of objects as `a[0].b`. */
export function flattenFacts(value: unknown, prefix: string): string[] {
  const s = scalar(value);
  if (s !== null) return [`- ${prefix}: ${s}`];
  if (Array.isArray(value)) return value.length ? value.flatMap((v, i) => flattenFacts(v, `${prefix}[${i}]`)) : [`- ${prefix}: none`];
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return [`- ${prefix}: (empty)`];
  return entries.flatMap(([k, v]) => flattenFacts(v, prefix ? `${prefix}.${k}` : k));
}

const rect = (r: Rect): string => `${r.width}x${r.height} at ${r.left},${r.top}`;
const block = (lines: string[], none: string): string[] => (lines.length ? ['```', ...lines, '```'] : [`- ${none}`]);

const signedDeg = (v: unknown): string => (typeof v === 'number' && Number.isFinite(v) ? `${v < 0 ? '-' : '+'}${Math.abs(v).toFixed(1)}°` : 'unknown');
const metres = (v: unknown): string => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? `${v} m` : 'infinity');
const percent = (v: unknown): string => (typeof v === 'number' && Number.isFinite(v) ? `${Math.round(v * 1000) / 10}%` : 'unknown');
const isTune = (v: unknown): v is { depthM?: unknown; dyDeg?: unknown } => typeof v === 'object' && v !== null;
const pair = (v: unknown): [unknown, unknown] => (Array.isArray(v) && v.length === 2 ? [v[0], v[1]] : [undefined, undefined]);

/**
 * D7.5.9–D7.5.11 (2026-11-04): the four window settings in words (`Camera view: whole`, `Window depth: infinity | 2.6 m`,
 * `Vertical offset: left +0.0°, right +0.0°`, `Soft edge: 3%`), each only when the settings carry its key; the raw keys
 * leave the flattened list so each fact is on one line.
 */
export function windowSettingsLines(settings: Record<string, unknown>): { rest: Record<string, unknown>; lines: string[] } {
  const { cameraView, cameraEyes, windowDepthM, eyeOffsetDeg, softEdge, ...rest } = settings;
  const lines: string[] = [];
  if ('cameraView' in settings) lines.push(`- Camera view: ${typeof cameraView === 'string' ? cameraView : 'unknown'}`);
  // D8.1 (2026-11-05): `Camera eyes: one (left) | both`.
  if ('cameraEyes' in settings) lines.push(`- Camera eyes: ${cameraEyes === 'one' ? 'one (left)' : cameraEyes === 'both' ? 'both' : 'unknown'}`);
  if ('windowDepthM' in settings) lines.push(`- Window depth: ${metres(windowDepthM)}`);
  if ('eyeOffsetDeg' in settings) {
    const [l, r] = pair(eyeOffsetDeg);
    lines.push(`- Vertical offset: left ${signedDeg(l)}, right ${signedDeg(r)}`);
  }
  if ('softEdge' in settings) lines.push(`- Soft edge: ${percent(softEdge)}`);
  return { rest, lines };
}

/**
 * D7.5.10 / D7.5.11: the layer's session `window` block may carry `tune` and `feather` (what the layer applied, after
 * its clamps); they print in words beside the block's other facts, and leave the flattened list.
 */
export function windowTuneLines(window: unknown): { rest: unknown; lines: string[] } {
  if (typeof window !== 'object' || window === null || Array.isArray(window)) return { rest: window, lines: [] };
  const { tune, feather, ...rest } = window as Record<string, unknown>;
  const lines: string[] = [];
  if ('tune' in window) {
    const t = isTune(tune) ? tune : {};
    const [l, r] = pair(t.dyDeg);
    lines.push(`- window depth: ${tune === null ? 'infinity (default)' : metres(t.depthM)}`);
    lines.push(`- vertical offset: ${tune === null ? 'none (default)' : `left ${signedDeg(l)}, right ${signedDeg(r)}`}`);
  }
  if ('feather' in window) lines.push(`- feather: ${feather === null ? 'none (default)' : percent(feather)}`);
  return { rest, lines };
}

/** The person's report: sections, one fact per line. */
export function buildVrReportMarkdown(f: VrReportFacts): string {
  const L: string[] = [];
  L.push('# Castcade VR report', '');
  L.push(`- written: ${f.writtenAt}`, `- companion: ${f.companion.version} (match protocol ${f.companion.protocol})`, '');

  L.push('## The layer in VPX (runtime, headset, what VPX submits)', '');
  const source = f.layer.source === 'match' ? "the match's pipe connection" : f.layer.source === 'probe' ? 'a short pipe connection of the report' : 'none';
  L.push(`- source: ${source}`, `- connected: ${f.layer.connected}`, `- pipe protocol: ${f.layer.protocol ?? 'unknown'}`);
  L.push(`- report: ${f.layer.session ? (f.layer.fresh ? 'fresh (asked now)' : 'an earlier one (the layer did not answer now)') : 'none'}`);
  if (f.layer.receivedAt) L.push(`- received: ${f.layer.receivedAt}`);
  L.push(`- note: ${f.layer.note}`);
  if (f.layer.session) {
    for (const [key, value] of Object.entries(f.layer.session)) {
      L.push('', `### ${key}`, '');
      if (key === 'window') {
        const w = windowTuneLines(value);
        L.push(...flattenFacts(w.rest, key), ...w.lines);
      } else L.push(...flattenFacts(value, key));
    }
  }
  L.push('');

  L.push('## Rig', '');
  L.push(`- rig: ${f.rig.rig}`, `- reason: ${f.rig.reason}`, `- VR runtime: ${f.rig.vrRuntime ?? 'unknown'}`);
  L.push(`- VPX started before this layer was registered: ${f.rig.vpxBeforeLayer === null ? 'unknown' : f.rig.vpxBeforeLayer}`);
  L.push(...(f.rig.overlay ? flattenFacts(f.rig.overlay, 'overlay') : ['- overlay: none (no match)']));
  L.push(...(f.rig.witnessVr ? flattenFacts(f.rig.witnessVr, 'witness VR reading') : ['- witness VR reading: unknown (no table opened since the companion started)']));
  L.push('');

  L.push('## Match', '');
  L.push(`- role: ${f.match.role}`, `- phase: ${f.match.phase}`);
  if (f.match.settings) {
    const w = windowSettingsLines(f.match.settings);
    L.push(...flattenFacts(w.rest, 'settings'), ...w.lines);
  } else L.push('- settings: unknown (no match host)');
  L.push(...(f.media ? flattenFacts(f.media, 'media') : ['- media: not attached']));
  L.push('');

  L.push('## Network (ICE)', '');
  if (f.ice) {
    L.push(`- servers: ${f.ice.description}`, `- STUN: ${f.ice.stun.length ? f.ice.stun.join(', ') : 'none'}`);
    L.push(`- TURN: ${f.ice.turn ? `${f.ice.turn.url} (user ${f.ice.turn.username || 'none'}, credential ${f.ice.turn.credentialSet ? 'set' : 'not set'})` : 'none'}`);
  } else L.push('- unknown (no media settings)');
  L.push('');

  L.push('## Last controls sent to the layer', '');
  L.push(...(f.controls.length ? f.controls.map((c) => `- ${c.at}: ${c.text}`) : ['- none (no layer connection in this match)']));
  L.push('');

  L.push('## Layer camera', '');
  L.push(...(f.camera ? flattenFacts(f.camera, 'camera') : ['- unknown (no OpenXR layer in this build)']));
  L.push('');

  L.push(`## Counters, last ${COUNTER_WINDOW_MS / 1000} s (companion.log)`, '');
  if (f.counters.note) L.push(`- note: ${f.counters.note}`);
  L.push(...block(f.counters.lines, 'no capture / theater / camera counter lines in the last minute (no match running, or nothing captured)'));
  L.push('');

  L.push('## vr-layer.log, last lines', '');
  L.push(`- file: ${f.layerLog.file ?? 'unknown'}`);
  if (f.layerLog.note) L.push(`- note: ${f.layerLog.note}`);
  L.push(...block(f.layerLog.lines, 'empty'));
  L.push('');

  L.push('## VPX preview window', '');
  const w = f.window;
  if (w.note) L.push(`- note: ${w.note}`);
  if (w.playfield) L.push(`- player window: ${rect(w.playfield.client)} (pid ${w.playfield.pid}, '${w.playfield.title}')`);
  if (w.display) L.push(`- its display: ${rect(w.display)}`);
  if (w.fit) {
    L.push(`- covers the whole display: ${w.fit.fillsDisplay}`);
    L.push(`- off the display: ${w.fit.cut.top} rows top, ${w.fit.cut.bottom} rows bottom, ${w.fit.cut.left} columns left, ${w.fit.cut.right} columns right`);
  }
  L.push(`- warning: ${w.warning ?? 'none'}`);
  for (const x of w.windows) L.push(`- VPX window: ${rect(x.client)} (pid ${x.pid}, '${x.title}')`);
  L.push('');

  L.push("## VPX's ini, [PlayerVR]", '');
  L.push(`- file: ${f.ini.path ?? 'unknown'}`);
  if (f.ini.note) L.push(`- note: ${f.ini.note}`);
  for (const e of f.ini.entries) L.push(`- ${e.key} = ${e.value}`);
  L.push('');
  return L.join('\n');
}

/** The same facts for a machine (stable key order, two-space indent), to diff between rigs. */
export function buildVrReportJson(f: VrReportFacts): string {
  return `${JSON.stringify(f, null, 2)}\n`;
}
