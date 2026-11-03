/**
 * D7.6.2 (2026-11-03): gathers the VR report's facts (`vr-report.ts` builds the files) and writes
 * `vr-report-<date>.md` / `.json` beside companion.log. Each source is asked on its own and fails on its own: a probe
 * that times out, a log that cannot be read or an ini that is not found becomes a note in its section.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describeIce, type MediaSettingsStore } from '../media/media-settings.js';
import type { VrOverlay } from '../media/match-media-types.js';
import { probeLayerSession, type LayerProbeResult } from '../media/vr-layer.js';
import { probeWindows, type WindowProbe } from '../media/window-geometry.js';
import type { WitnessFs } from '../witness/fs.js';
import { iniEntries, locateMainIni, parseIni } from '../witness/ini-attestation.js';
import type { WitnessStatus } from '../witness/types.js';
import { describeError } from './log.js';
import type { MatchHost } from './match-host.js';
import {
  buildVrReportJson,
  buildVrReportMarkdown,
  LAYER_LOG_LINES,
  recentCounterLines,
  reportBaseName,
  tailLines,
  windowFacts,
  type VrReportFacts,
} from './vr-report.js';

/** How long the layer has to answer a report request (it answers at its next frame). */
export const LAYER_REPORT_TIMEOUT_MS = 4000;
const WINDOW_PROBE_TIMEOUT_MS = 15_000;

export interface VrReportDeps {
  /** companion.log; the report goes beside it. */
  logFile: string;
  /** %LOCALAPPDATA%\Castcade\logs\vr-layer.log, or null when LOCALAPPDATA is unset. */
  layerLogFile: string | null;
  appVersion: string;
  protocol: number;
  match: MatchHost | null;
  /** The OpenXR layer overlay (`createVrLayerOverlay`), or null when this build has none. */
  vrLayer: VrOverlay | null;
  mediaSettings: MediaSettingsStore | null;
  witness: { status(): WitnessStatus };
  fs: WitnessFs;
  log: (line: string) => void;
  /** Test seams. */
  probeWindows?: () => Promise<WindowProbe>;
  probeLayer?: (timeoutMs: number) => Promise<LayerProbeResult>;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
}

const readText = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};

async function layerFacts(d: VrReportDeps): Promise<VrReportFacts['layer']> {
  const iso = (ms: number) => new Date(ms).toISOString();
  const overlay = d.vrLayer;
  const bench = overlay?.bench?.() ?? null;
  if (!overlay || !bench) {
    return { source: 'none', connected: false, protocol: null, fresh: false, note: overlay ? 'this overlay has no test bench' : 'no OpenXR layer in this build', receivedAt: null, session: null };
  }
  if (bench.connected) {
    const fresh = bench.protocol >= 3 && overlay.requestSession ? await overlay.requestSession(LAYER_REPORT_TIMEOUT_MS) : null;
    const s = fresh ?? overlay.bench?.().session ?? bench.session;
    const note = fresh
      ? "asked over the match's pipe connection"
      : bench.protocol < 3
        ? `the layer speaks pipe protocol ${bench.protocol}, before the session report: restart VPX with this Castcade's layer`
        : `the layer did not answer within ${LAYER_REPORT_TIMEOUT_MS / 1000} s (a layer before 0.5.0, or VPX is not rendering VR frames)${s ? '; the last report it sent is shown' : ''}`;
    return { source: 'match', connected: true, protocol: bench.protocol, fresh: fresh !== null, note, receivedAt: s ? iso(s.receivedAt) : null, session: s?.facts ?? null };
  }
  if (!bench.started) {
    const probe = d.probeLayer ?? ((timeoutMs: number) => probeLayerSession({ timeoutMs }));
    const r = await probe(LAYER_REPORT_TIMEOUT_MS);
    const s = r.session ?? bench.session;
    return {
      source: r.connected ? 'probe' : 'none',
      connected: r.connected,
      protocol: r.protocol,
      fresh: r.session !== null,
      note: r.session ? r.note : `${r.note}${s ? '; the last report seen in this run is shown' : ''}`,
      receivedAt: s ? iso(s.receivedAt) : null,
      session: s?.facts ?? null,
    };
  }
  // The match holds the overlay but its pipe is not connected: a probe would only race its retries.
  const st = overlay.status();
  const s = bench.session;
  return {
    source: 'none',
    connected: false,
    protocol: null,
    fresh: false,
    note: `the match's layer connection is not up (${st.state}${st.reason ? `, ${st.reason}` : ''})${s ? '; the last report seen in this run is shown' : ''}`,
    receivedAt: s ? iso(s.receivedAt) : null,
    session: s?.facts ?? null,
  };
}

async function iniFacts(d: VrReportDeps): Promise<VrReportFacts['ini']> {
  const exe = d.witness.status().vpxExe;
  if (!exe) return { path: null, entries: [], note: "not read: VPX's exe is not known yet (the witness has not seen VPX run)" };
  try {
    const path = await locateMainIni({ fs: d.fs, exe, env: d.env ?? process.env });
    if (!path) return { path: null, entries: [], note: `not read: no VPinballX.ini beside ${exe} or under %APPDATA%\\VPinballX` };
    const text = new TextDecoder().decode(await d.fs.readFile(path));
    return { path, entries: iniEntries(parseIni(text), 'PlayerVR'), note: '-Ini on VPX\'s command line is not seen here' };
  } catch (e) {
    return { path: null, entries: [], note: `not read: ${(e as Error).message}` };
  }
}

async function windowSection(d: VrReportDeps): Promise<VrReportFacts['window']> {
  try {
    const probe = d.probeWindows ?? (() => probeWindows(WINDOW_PROBE_TIMEOUT_MS));
    return windowFacts(await probe(), null);
  } catch (e) {
    return windowFacts(null, `the window probe failed: ${(e as Error).message}`);
  }
}

export async function collectVrReport(d: VrReportDeps): Promise<VrReportFacts> {
  const at = (d.now ?? (() => new Date()))();
  const [layer, ini, window] = await Promise.all([layerFacts(d), iniFacts(d), windowSection(d)]);
  const ms = d.match?.status() ?? null;
  const ws = d.witness.status();
  const media = d.mediaSettings?.get() ?? null;
  const bench = d.vrLayer?.bench?.() ?? null;

  const logText = [readText(`${d.logFile}.1`), readText(d.logFile)].filter((t): t is string => t !== null).join('\n');
  const layerLogText = d.layerLogFile ? readText(d.layerLogFile) : null;
  const m = ms?.media ?? null;
  return {
    writtenAt: at.toISOString(),
    companion: { version: d.appVersion, protocol: d.protocol },
    layer,
    rig: {
      rig: ms?.rig ?? 'unknown',
      reason: ms?.rigReason ?? 'unknown (no match host)',
      vrRuntime: ms?.vrRuntime ?? null,
      witnessVr: (ws.currentAttestation?.vr as unknown as Record<string, unknown> | null | undefined) ?? null,
      vpxBeforeLayer: d.vrLayer ? d.vrLayer.status().vpxBeforeLayer === true : null,
      overlay: ms?.vrOverlay ?? null,
    },
    match: { role: ms?.role ?? 'none', phase: ms?.phase ?? 'none', settings: ms ? { ...ms.settings } : null },
    media: m
      ? {
          attached: m.attached,
          sending: m.sending,
          captureSource: m.captureSource,
          captureCrop: m.captureCrop ?? null,
          captureStereo: m.captureStereo ?? null,
          captureWarning: m.captureWarning ?? null,
          lastError: m.lastError,
        }
      : null,
    ice: media ? { description: describeIce(media), stun: [...media.stun], turn: media.turn ? { url: media.turn.url, username: media.turn.username, credentialSet: media.turn.credential !== '' } : null } : null,
    controls: (bench?.controls ?? []).map((c) => ({ at: new Date(c.at).toISOString(), text: c.text })),
    camera: d.vrLayer?.cameraStatus?.() ?? null,
    counters: {
      file: d.logFile,
      lines: logText ? recentCounterLines(logText, at.getTime()) : [],
      note: logText ? null : `could not read ${d.logFile}`,
    },
    layerLog: {
      file: d.layerLogFile,
      lines: layerLogText ? tailLines(layerLogText, LAYER_LOG_LINES) : [],
      note: layerLogText ? null : d.layerLogFile ? `could not read ${d.layerLogFile} (the layer never loaded on this PC?)` : 'LOCALAPPDATA is not set',
    },
    window,
    ini,
  };
}

/** Gathers the facts and writes both files; resolves with their paths. Throws only when the files cannot be written. */
export async function writeVrReport(d: VrReportDeps): Promise<{ md: string; json: string }> {
  const facts = await collectVrReport(d);
  const dir = dirname(d.logFile);
  const base = join(dir, reportBaseName(new Date(facts.writtenAt)));
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${base}.md`, buildVrReportMarkdown(facts), 'utf8');
    writeFileSync(`${base}.json`, buildVrReportJson(facts), 'utf8');
  } catch (e) {
    d.log(`vr-report: could not write ${base}.md / .json: ${describeError(e)}`);
    throw e;
  }
  d.log(`vr-report: wrote ${base}.md and .json (layer ${facts.layer.source}${facts.layer.fresh ? ', fresh report' : ''}: ${facts.layer.note})`);
  return { md: `${base}.md`, json: `${base}.json` };
}
