/**
 * A6 (2026-10-30): the pure parts of `match-host.ts`, apart so they unit-test without Electron: the match settings in
 * `<userData>/match.json`, the match keys in `<userData>/match-keys.json`, the invite string, the match code, the
 * GameFingerprint the witness's current table gives, the rig, the lock path
 * the hook reads (docs/design/alpha-match.md §1, §3) and the media signalling over the role (§4, D2).
 */
import { createPrivateKey, createPublicKey, randomInt, randomUUID } from 'node:crypto';
import type { NetworkInterfaceInfo } from 'node:os';
import { win32 } from 'node:path';
import { PlayerId, type GameFingerprint, type PayloadOf } from '@castcade/protocol';
import type { ClientMatch } from '../match/client.js';
import { HostMatch } from '../match/host.js';
import { exportPublicKeyB64, generateKeys, type KeyPair } from '../match/keys.js';
import type { MediaSignal, MediaSignalling } from '../media/match-media-types.js';
import type { WitnessStatus } from '../witness/types.js';
import { describeVrEvidence, vrRuntimeOf, type VrObservation, type VrRuntime } from '../witness/vr-detect.js';

export const DEFAULT_MATCH_PORT = 27401;
export const ZERO_SHA256 = '0'.repeat(64);

export interface MatchSettings {
  port: number;
  ballsPerGame: 3 | 5;
  /** Null: the pairing label (`deviceLabel`). */
  displayName: string | null;
  /** The turn cue's loudness, 0–100. */
  cueVolume: number;
  /** D7.4 (2026-10-31): the headset on this player's own ball (OpenXR layer rigs): nothing over the table, or the panel. */
  theaterDuringMyTurn: 'hidden' | 'panel';
  /** D7.4: the headset while another player is up: their video where the table was (theater), or the panel. */
  spectate: 'theater' | 'panel';
  /**
   * D7.4.3 (2026-11-01): what this rig's VR preview sends, as told to the others: `auto` reads `[PlayerVR] VRPreview`
   * from VPX's ini (media/preview-stereo.ts), `mono` one eye, `sbs` both eyes side by side.
   */
  previewStereo: 'auto' | 'mono' | 'sbs';
  /**
   * D2.8 (2026-11-01): table sound (media/table-audio-policy.ts): mute this rig's VPX while another player is up, send
   * its sound while this rig is up, play the up player's table. All on by default.
   */
  tableMuteMine: boolean;
  tableSendMine: boolean;
  tableHearOthers: boolean;
  /**
   * D7.4.9 (2026-11-02): the theater window's size against life size (0.25–4, the layer's range): 1 life size, 0.8 or 0.6
   * a smaller, sharper picture (the same pixels over less of the view). Sent live in the layer's control.
   */
  theaterScale: number;
  /**
   * D7.5 (2026-11-02): where a VR sender's picture comes from (media/layer-camera.ts): `screen`, the screen capture of
   * VPX's VR preview window; `layer`, the Castcade OpenXR layer copies the eye views out of VPX's frame (falls back to
   * the screen capture on PC rigs, SteamVR rigs and a layer that cannot read the frame). D8.1 (2026-11-05, ADR 0009):
   * `layer` is the default (no desktop window is needed; the 2026-11-04 run captured a PuP DMD over the preview).
   */
  cameraSource: 'screen' | 'layer';
  /**
   * D8.1 (2026-11-05, ADR 0009: spectating is 2D): what the layer camera sends: `one`, one eye (the left) as a flat
   * picture (the default); `both`, both eyes side by side (the stereo window of 0.2.35, kept as shipped).
   */
  cameraEyes: 'one' | 'both';
  /**
   * D8.1: the settings' version, for one-time migrations at load (`loadMatchSettings`): absent or 1 = a `match.json`
   * from 0.2.35 or before (its `cameraSource` is set to `layer` and `cameraEyes` to `one` once); 2 = current.
   */
  settingsVersion: number;
  /**
   * D7.5.9 (2026-11-04): what the layer camera crops per eye: `whole`, each eye's whole render (the frame's edges land
   * at the lens edges, so no frame sits in the shared field: the owner's 0.2.34 finding was the window's frame
   * doubling while the eyes converged on the table); `window`, the tall 1:2 centre crop of 0.2.34.
   */
  cameraView: 'whole' | 'window';
  /**
   * D7.5.10 (2026-11-04): the stereo window's depth in metres (0.3–100), or null for infinity (the layer's default,
   * as rendered). Sent in the layer's control `tune`; a tuning knob for the owner's geometry reports.
   */
  windowDepthM: number | null;
  /** D7.5.10: a vertical offset per eye in degrees (±10, left then right); a non-zero value needed to fuse says the reported field of view is off. */
  eyeOffsetDeg: [number, number];
  /** D7.5.11 (2026-11-04): the fraction of one eye's half width over which the window fades to black at its edges (0–0.25). */
  softEdge: number;
  // A12 (2026-11-05): the host's table before the match: free play until the lobby is complete (then the running
  // game must end before the Start that begins the match), or locked until someone joins. The owner's 2026-11-05
  // match: Start pressed before the other player joined, the join started nothing, host again.
  preMatchPlay: 'free' | 'locked';
  /*
   * D2.10 (2026-11-05): voice over the game. Both testers heard the table over the other player's voice; these three
   * are percentages, saved like the rest and applied live mid-match (Ctrl+Alt+arrows while playing, match-host.ts).
   */
  /** The other players' voices as this rig plays them, 0–300 (above 100 is a boost: a GainNode on the panel page). */
  voiceVolume: number;
  /** The up player's table sound as this rig plays it, 0–100 (the table element's volume). */
  othersTableVolume: number;
  /** This rig's own VPX session volume while this player is up, 10–100 (100 = untouched; the helper's `level`). */
  myTableWhileUp: number;
}

export const DEFAULT_MATCH_SETTINGS: MatchSettings = {
  port: DEFAULT_MATCH_PORT,
  ballsPerGame: 3,
  displayName: null,
  cueVolume: 80,
  theaterDuringMyTurn: 'hidden',
  spectate: 'theater',
  previewStereo: 'auto',
  tableMuteMine: true,
  tableSendMine: true,
  tableHearOthers: true,
  theaterScale: 1,
  cameraSource: 'layer',
  cameraEyes: 'one',
  settingsVersion: 2,
  cameraView: 'whole',
  windowDepthM: null,
  eyeOffsetDeg: [0, 0],
  softEdge: 0.03,
  // A12 (2026-11-05)
  preMatchPlay: 'free',
  // D2.10 (2026-11-05)
  voiceVolume: 150,
  othersTableVolume: 100,
  myTableWhileUp: 100,
};

/** D8.1: the current `settingsVersion`; a saved file below it is migrated once at load (`loadMatchSettings`). */
export const MATCH_SETTINGS_VERSION = 2;

/** D2.10: the three volume settings' ranges, in percent. */
export const VOLUME_RANGE = { voiceVolume: [0, 300], othersTableVolume: [0, 100], myTableWhileUp: [10, 100] } as const;

/** D2.10: a finite number rounded and clamped to `[lo, hi]`, else null. */
export function cleanPercent(v: unknown, lo: number, hi: number): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.min(hi, Math.max(lo, Math.round(v)));
}

export function cleanPort(v: unknown): number | null {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isInteger(n) && n >= 1024 && n <= 65535 ? n : null;
}

/** D7.4.9: a finite number in the layer's 0.25–4 range (clamped, two decimals), else null. */
export function cleanTheaterScale(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.round(Math.min(4, Math.max(0.25, v)) * 100) / 100;
}

/** D7.5.10: a finite number in the layer's 0.3–100 m range (two decimals), else null (infinity). */
export function cleanWindowDepth(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0.3 || v > 100) return null;
  return Math.round(v * 100) / 100;
}

/** D7.5.10: two finite degrees, each clamped to ±10 and rounded to a tenth; null when the pair is not one. */
export function cleanEyeOffset(v: unknown): [number, number] | null {
  if (!Array.isArray(v) || v.length !== 2) return null;
  const out: number[] = [];
  for (const d of v as unknown[]) {
    if (typeof d !== 'number' || !Number.isFinite(d)) return null;
    out.push(Math.round(Math.min(10, Math.max(-10, d)) * 10) / 10 + 0); // + 0: never -0
  }
  return [out[0]!, out[1]!];
}

/** D7.5.11: a finite fraction clamped to 0–0.25 (three decimals), else null. */
export function cleanSoftEdge(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.round(Math.min(0.25, Math.max(0, v)) * 1000) / 1000;
}

/** ParticipantInfo.displayName: 1–64 characters. */
export function cleanName(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim().slice(0, 64);
  return t === '' ? null : t;
}

export function patchMatchSettings(current: MatchSettings, patch: unknown): MatchSettings {
  const p = (typeof patch === 'object' && patch !== null ? patch : {}) as Record<string, unknown>;
  const next = { ...current };
  if ('port' in p) next.port = cleanPort(p.port) ?? current.port;
  if ('ballsPerGame' in p) next.ballsPerGame = p.ballsPerGame === 5 ? 5 : p.ballsPerGame === 3 ? 3 : current.ballsPerGame;
  if ('displayName' in p) next.displayName = cleanName(p.displayName);
  if ('cueVolume' in p && typeof p.cueVolume === 'number' && Number.isFinite(p.cueVolume)) next.cueVolume = Math.min(100, Math.max(0, Math.round(p.cueVolume)));
  if (p.theaterDuringMyTurn === 'hidden' || p.theaterDuringMyTurn === 'panel') next.theaterDuringMyTurn = p.theaterDuringMyTurn;
  if (p.spectate === 'theater' || p.spectate === 'panel') next.spectate = p.spectate;
  if (p.previewStereo === 'auto' || p.previewStereo === 'mono' || p.previewStereo === 'sbs') next.previewStereo = p.previewStereo;
  if (typeof p.tableMuteMine === 'boolean') next.tableMuteMine = p.tableMuteMine;
  if (typeof p.tableSendMine === 'boolean') next.tableSendMine = p.tableSendMine;
  if (typeof p.tableHearOthers === 'boolean') next.tableHearOthers = p.tableHearOthers;
  if ('theaterScale' in p) next.theaterScale = cleanTheaterScale(p.theaterScale) ?? current.theaterScale;
  if (p.cameraSource === 'screen' || p.cameraSource === 'layer') next.cameraSource = p.cameraSource;
  // D8.1: the eyes: two words, anything else keeps the current one. `settingsVersion` is never patched: the loader owns it.
  if (p.cameraEyes === 'one' || p.cameraEyes === 'both') next.cameraEyes = p.cameraEyes;
  if (p.cameraView === 'whole' || p.cameraView === 'window') next.cameraView = p.cameraView;
  // D7.5.10: a depth outside the range (or null, or not a number) is infinity: the knob's own "as rendered".
  if ('windowDepthM' in p) next.windowDepthM = cleanWindowDepth(p.windowDepthM);
  if ('eyeOffsetDeg' in p) next.eyeOffsetDeg = cleanEyeOffset(p.eyeOffsetDeg) ?? current.eyeOffsetDeg;
  if ('softEdge' in p) next.softEdge = cleanSoftEdge(p.softEdge) ?? current.softEdge;
  // A12 (2026-11-05)
  if (p.preMatchPlay === 'free' || p.preMatchPlay === 'locked') next.preMatchPlay = p.preMatchPlay;
  // D2.10: the three volumes, each clamped to its range; anything that is not a number keeps the current value.
  for (const k of ['voiceVolume', 'othersTableVolume', 'myTableWhileUp'] as const) {
    if (k in p) next[k] = cleanPercent(p[k], VOLUME_RANGE[k][0], VOLUME_RANGE[k][1]) ?? current[k];
  }
  return next;
}

/** The settings in `match.json`, migrated (D8.1); `loadMatchSettings` says whether they were. */
export function readMatchSettings(text: string | null): MatchSettings {
  return loadMatchSettings(text).settings;
}

/**
 * D8.1 (2026-11-05): `match.json` read, with the one-time migrations its `settingsVersion` calls for. A file without
 * one (0.2.35 and before: the testers set Camera to the screen capture by hand for the 2D test, and would otherwise keep
 * the old camera; and `cameraEyes` did not exist) gets `cameraSource: 'layer'` and `cameraEyes: 'one'` once and is
 * saved at version 2 by the match host; `migrated` is the sentence for the log, or null when nothing changed. No file,
 * or an unreadable one: the defaults, which are already current.
 */
export function loadMatchSettings(text: string | null): { settings: MatchSettings; migrated: string | null } {
  if (!text) return { settings: { ...DEFAULT_MATCH_SETTINGS }, migrated: null };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { settings: { ...DEFAULT_MATCH_SETTINGS }, migrated: null };
  }
  const settings = patchMatchSettings(DEFAULT_MATCH_SETTINGS, raw);
  const v = typeof raw === 'object' && raw !== null ? (raw as { settingsVersion?: unknown }).settingsVersion : undefined;
  const version = typeof v === 'number' && Number.isInteger(v) && v >= 1 ? v : 1;
  settings.settingsVersion = MATCH_SETTINGS_VERSION;
  if (version >= 2) return { settings, migrated: null };
  // Version 1 → 2 (ADR 0009): the layer camera, one eye, whatever the file said.
  settings.cameraSource = 'layer';
  settings.cameraEyes = 'one';
  return { settings, migrated: `match.json from before 0.2.36 (settings version ${version}): camera set to the VR layer, one eye (ADR 0009); saved as version ${MATCH_SETTINGS_VERSION}` };
}

export function writeMatchSettings(s: MatchSettings): string {
  return `${JSON.stringify({ v: 1, ...s }, null, 2)}\n`;
}

// ---------------------------------------------------------------------------------------- keys --

export interface MatchIdentity {
  keys: KeyPair;
  /** A stable per-install id for when the companion is not paired (§3). */
  installId: string;
}

/** `<userData>/match-keys.json`: the Ed25519 pair (PKCS#8 PEM; a match key, not an account credential) and the install id. */
export function serializeMatchIdentity(id: MatchIdentity): string {
  const pem = id.keys.privateKey.export({ format: 'pem', type: 'pkcs8' });
  return `${JSON.stringify({ v: 1, installId: id.installId, publicKey: id.keys.publicKeyB64, privateKey: pem }, null, 2)}\n`;
}

/** Null when the text is missing or unusable; the caller then generates a fresh identity. */
export function parseMatchIdentity(text: string | null): MatchIdentity | null {
  if (!text) return null;
  try {
    const j = JSON.parse(text) as { installId?: unknown; privateKey?: unknown };
    if (typeof j.privateKey !== 'string' || typeof j.installId !== 'string' || !PlayerId.safeParse(j.installId).success) return null;
    const privateKey = createPrivateKey(j.privateKey);
    if (privateKey.asymmetricKeyType !== 'ed25519') return null;
    const publicKey = createPublicKey(privateKey);
    return { keys: { privateKey, publicKey, publicKeyB64: exportPublicKeyB64(publicKey) }, installId: j.installId };
  } catch {
    return null;
  }
}

export function newMatchIdentity(): MatchIdentity {
  return { keys: generateKeys(), installId: randomUUID() };
}

// ------------------------------------------------------------------------------------- invites --

/** Upper-case letters without I and O (read aloud over voice, typed from a screenshot). */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

/** The match id: six letters from a CSPRNG (24^6 ≈ 1.9e8; one match per invite). */
export function newMatchCode(rand: (max: number) => number = randomInt): string {
  let s = '';
  for (let i = 0; i < 6; i++) s += CODE_ALPHABET[rand(CODE_ALPHABET.length)];
  return s;
}

export function formatInvite(ip: string, port: number, code: string): string {
  const host = ip.includes(':') ? `[${ip}]` : ip;
  return `castcade:ws://${host}:${port}#${code}`;
}

const INVITE = /^castcade:(ws:\/\/(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+):(\d{1,5}))\/?#([A-Za-z]{6})$/;

/** The invite as pasted (Discord may wrap it in backticks or quotes); throws a sentence the Match tab shows. */
export function parseInvite(text: string): { url: string; host: string; port: number; code: string } {
  const t = text.trim().replace(/^[`'"<]+|[`'">]+$/g, '');
  const m = INVITE.exec(t);
  const port = m ? Number(m[3]) : 0;
  if (!m || port < 1 || port > 65535) {
    throw new Error('That is not a Castcade invite. It looks like castcade:ws://203.0.113.7:27401#ABCDEF: ask the host to copy it again.');
  }
  return { url: m[1]!, host: m[2]!, port, code: m[4]!.toUpperCase() };
}

export function isIpv4(s: string): boolean {
  const parts = s.split('.');
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

/** The first non-internal IPv4 (`os.networkInterfaces()`), skipping link-local 169.254/16; null when none. */
export function pickLanAddress(ifaces: Record<string, NetworkInterfaceInfo[] | undefined>): string | null {
  for (const list of Object.values(ifaces)) {
    for (const i of list ?? []) {
      if (i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.')) return i.address;
    }
  }
  return null;
}

// --------------------------------------------------------------------------------- fingerprint --

/** What `gameFingerprintFrom` names the table when the witness knows none. */
export const NO_TABLE_NAME = 'no table open';

/**
 * A11 (2026-11-02): whether a lobby fingerprint says the player has a table open: a table hash, or at least a table
 * name (the hash can come a moment after the name). The match starts from the host's table only when every one is.
 */
export function isTableOpen(game: GameFingerprint): boolean {
  return game.tableHash !== ZERO_SHA256 || game.tableName !== NO_TABLE_NAME;
}

/**
 * §3: what this companion says about its table at HELLO. Only fields both rigs compute the same way for the same file
 * go in (a ROM or physics hash one side may lack would read as a different table): the table name and the original
 * `.vpx`'s SHA-256 (zeros when no table is known yet), the recipe this build renders, the VPX build's version.
 */
export function gameFingerprintFrom(status: WitnessStatus, recipeVersion: string): GameFingerprint {
  const id = status.currentIdentity;
  const name = (id?.tableInfo?.tableName?.trim() || status.currentTable?.trim() || NO_TABLE_NAME).slice(0, 200);
  const sha = id?.sha256?.toLowerCase() ?? null;
  const vpx = status.currentAttestation?.build?.vpx?.version ?? null;
  const emulator = (vpx?.fileVersionText ?? vpx?.fileVersion ?? 'unknown').slice(0, 64);
  return {
    kind: 'vpx',
    tableName: name,
    tableHash: sha && /^[0-9a-f]{64}$/.test(sha) ? sha : ZERO_SHA256,
    romName: null,
    romHash: null,
    physicsHash: null,
    recipeVersion: recipeVersion.slice(0, 32),
    sidecarHash: null,
    emulatorVersion: emulator,
  };
}

export function rigFrom(status: WitnessStatus): 'vr_headset' | 'pc' {
  return status.currentAttestation?.vr?.inVr === true ? 'vr_headset' : 'pc';
}

export type Rig = 'vr_headset' | 'pc';

/** The match host's rig decision and the evidence behind it (the log line and the Match tab say both). */
export interface RigDecision {
  rig: Rig;
  reason: string;
  /**
   * B22 (2026-10-31): the VR runtime when `rig` is `vr_headset`, else null. Only `steamvr` gets the in-headset panel
   * (the OpenVR overlay helper draws into SteamVR's compositor); any other runtime keeps a visible desktop panel.
   */
  runtime: VrRuntime | null;
}

/**
 * A6 (2026-10-31): the rig at host / join. The running VPX process is probed now when there is one: the witness's
 * attestation can hold a sample taken before the player started (the owner's first alpha match opened the desktop
 * panel in VR because of exactly that). With no VPX open, or no answer, the witness's last sample decides.
 */
export async function decideRig(w: { status(): WitnessStatus; sampleVr(): Promise<VrObservation | null> }): Promise<RigDecision> {
  const now = await w.sampleVr().catch(() => null);
  if (now) return { rig: now.inVr ? 'vr_headset' : 'pc', reason: `VPX probed now: ${describeVrEvidence(now)}`, runtime: now.inVr ? vrRuntimeOf(now) : null };
  return rigFromStatus(w.status());
}

/** The decision from the witness's last sample alone (no VPX to probe, or a later status change). */
export function rigFromStatus(status: WitnessStatus): RigDecision {
  const vr = status.currentAttestation?.vr;
  if (!vr) return { rig: 'pc', reason: 'no VPX table open to probe; monitor assumed', runtime: null };
  const rig = rigFrom(status);
  return { rig, reason: `the witness's sample at ${vr.sampledAt}: ${describeVrEvidence(vr)}`, runtime: rig === 'vr_headset' ? vrRuntimeOf(vr) : null };
}

/** Where the hook looks (vpx-hook/castcade.vbs: %LOCALAPPDATA%, else %TEMP%, else C:\Castcade; then \Castcade\lock). */
export function lockPathFrom(env: Record<string, string | undefined>): string {
  const root = env.LOCALAPPDATA || env.TEMP || 'C:\\Castcade';
  return win32.join(root, 'Castcade', 'lock', 'turn.lock');
}

// ---------------------------------------------------------------------------------- signalling --

/** Signals held while the media layer has no listener; far more than one offer, answer and its ICE candidates. */
export const SIGNAL_BUFFER_MAX = 256;

/**
 * D2 in the shell (2026-10-30): the media layer's `MediaSignalling` over the role's MEDIA_SIGNAL. It listens from the
 * role's creation (before HELLO) because the engine's emitter drops an event nobody listens to, while the media layer
 * listens only from its `attach` (after the join resolves): a signal landing in between waits here and is handed over
 * when `onSignal` gets its listener. It follows the role through a host transfer (a HostMatch to the ClientMatch it
 * hands over to, a ClientMatch to the HostMatch it becomes), so the mesh keeps its signalling when the host changes.
 */
export function matchSignalling(role: HostMatch | ClientMatch, localId: string, max = SIGNAL_BUFFER_MAX): MediaSignalling {
  let current: HostMatch | ClientMatch = role;
  let listener: ((from: string, signal: MediaSignal) => void) | null = null;
  const held: Array<[string, MediaSignal]> = [];
  const deliver = (from: string, p: PayloadOf<'MEDIA_SIGNAL'>): void => {
    // The media layer never sees the envelope: `to` is this player.
    const signal: MediaSignal = { kind: p.kind };
    if (p.sdp !== undefined) signal.sdp = p.sdp;
    if (p.candidate !== undefined) signal.candidate = { ...p.candidate };
    if (p.stereo !== undefined) signal.stereo = p.stereo;
    // D10.3: the native helper's signals; the schema defaults it to `rtc`, which is left implicit here (as 0.2.36 read it).
    if (p.channel === 'video') signal.channel = 'video';
    if (listener) return listener(from, signal);
    held.push([from, signal]);
    if (held.length > max) held.shift();
  };
  const bind = (r: HostMatch | ClientMatch): void => {
    current = r;
    if (r instanceof HostMatch) {
      r.on('mediaSignal', ({ from, signal }) => deliver(from, signal));
      r.on('hostTransfer', (t) => bind(t.client));
    } else {
      r.on('mediaSignal', ({ from, signal }) => deliver(from, signal));
      r.on('becameHost', (h) => bind(h));
    }
  };
  bind(role);
  return {
    localId,
    send: (to, signal) => {
      current.sendMediaSignal(to, signal);
    },
    onSignal(cb) {
      listener = cb;
      for (const [from, signal] of held.splice(0)) cb(from, signal);
      return () => {
        if (listener === cb) listener = null;
      };
    },
  };
}
