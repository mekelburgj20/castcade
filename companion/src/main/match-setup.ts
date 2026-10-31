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
}

export const DEFAULT_MATCH_SETTINGS: MatchSettings = { port: DEFAULT_MATCH_PORT, ballsPerGame: 3, displayName: null, cueVolume: 80 };

export function cleanPort(v: unknown): number | null {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isInteger(n) && n >= 1024 && n <= 65535 ? n : null;
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
  return next;
}

export function readMatchSettings(text: string | null): MatchSettings {
  if (!text) return { ...DEFAULT_MATCH_SETTINGS };
  try {
    return patchMatchSettings(DEFAULT_MATCH_SETTINGS, JSON.parse(text));
  } catch {
    return { ...DEFAULT_MATCH_SETTINGS };
  }
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

/**
 * §3: what this companion says about its table at HELLO. Only fields both rigs compute the same way for the same file
 * go in (a ROM or physics hash one side may lack would read as a different table): the table name and the original
 * `.vpx`'s SHA-256 (zeros when no table is known yet), the recipe this build renders, the VPX build's version.
 */
export function gameFingerprintFrom(status: WitnessStatus, recipeVersion: string): GameFingerprint {
  const id = status.currentIdentity;
  const name = (id?.tableInfo?.tableName?.trim() || status.currentTable?.trim() || 'no table open').slice(0, 200);
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
