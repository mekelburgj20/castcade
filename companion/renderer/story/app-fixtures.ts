/**
 * The Arcaid look (2026-11-25): what the app's other tabs are drawn from in the story pages (app.html, app-story.tsx):
 * Pairing, Status, Stream, Settings (with Import tables), the update banner, the 3D watch card on the Match tab, and
 * the Witness edition. Every name, path, id and address here is invented (Owner, Krobs, Chuck, Dana; C:\Games\...;
 * a loopback port), and the sentences are the ones the main process makes (witness.ts, exit-rung.ts), so a picture
 * shows what a player would read. Nothing here talks to anything.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

const VPX_DIR = String.raw`C:\Games\Visual Pinball`;
const TABLES_DIR = String.raw`C:\Games\Visual Pinball\Tables`;
const APPDATA = String.raw`C:\Users\Owner\AppData\Roaming\Castcade`;
const T0 = '2026-11-25T20:14:03Z';
const at = (min: number): string => new Date(Date.parse(T0) + min * 60_000).toISOString();

export const SETTINGS = {
  arcaidBaseUrl: 'https://arcaid.app',
  deviceId: 'dsk_7f3a9c2e41b84d0e',
  deviceLabel: 'OWNER-PC',
  mapsDir: `${APPDATA}\\maps`,
  nvramDir: null,
  dataDir: APPDATA,
  vpsDir: `${APPDATA}\\vps`,
  tablesDir: null,
  hasToken: true,
};

export const VERSIONS = { app: '0.2.51', protocol: 7, electron: '44.9.0', chrome: '146.0.7680.65', node: '24.11.0', packaged: true };

const identity = (o: Partial<any> = {}): any => ({
  filePath: `${TABLES_DIR}\\Monster Bash (Williams 1998) VPW 1.2.vpx`,
  vpsGame: { id: 'Xb2fT9qLmN', name: 'Monster Bash', manufacturer: 'Williams', year: 1998 },
  gameConfidence: 'exact',
  gameSource: 'rom',
  vpsTable: { id: 'kQ7wR2zPd4', label: 'VPW 1.2 (VPin Workshop)' },
  tableConfidence: 'exact',
  confirmed: false,
  tableChoices: [
    { id: 'kQ7wR2zPd4', label: 'VPW 1.2 (VPin Workshop)' },
    { id: 'Hn3vX8cLs1', label: 'VR Room 2.0 (Sixtoe)' },
  ],
  sha256: '9c1f4e2ab7d03358e6c41f0b2a97de51c3b8a0f6d2e47b19a5c08f3e6d71b224',
  fingerprint: null,
  saveRev: 412,
  tableInfo: { tableName: 'Monster Bash', authorName: 'VPin Workshop', tableVersion: '1.2', releaseDate: null, saveDate: null, saveRev: 412, manufacturer: 'Williams', year: 1998, raw: {} },
  physics: { gravity: null, friction: null, elasticity: null, elasticityFalloff: null, playfieldScatter: null, defaultScatter: null, nudgeTime: null, slopeMin: 6, slopeMax: 6.5, difficulty: 0.5, overridePhysicsSet: 0, overridePhysicsFlippers: false },
  notes: [],
  ...o,
});

const nudge = { strength: null, sensitivity: null, legacy: false, legacyStrength: null, analogGainX: null, analogGainY: null, filter: null, accelEnabled: true, accelGainX: 150, accelGainY: 150, accelMaxX: null, accelMaxY: null, accelVelocityInput: null, tiltSensitivity: null, tiltSensitivityEffective: 400 };
const checked = ['Balls per game', 'Replay boost', 'Tilt warnings', 'Extra ball limit', 'Match feature', 'Free play', 'Ball save time', 'Game difficulty', 'Replay level 1', 'Special award', 'Extra ball award', 'Novelty mode'].map((label, i) => ({
  group: 'Standard',
  label,
  value: i,
  shown: i,
  text: null,
  factory: i,
  isFactory: true,
}));
const bin = (file: string, ver: string, label: string): any => ({
  path: `${VPX_DIR}\\${file}`,
  size: 31_457_280,
  sha256: '4b7e2d91c0a8f35e6d14b27c9a0e3f58b16d2c47e9a03f81b5c6d72e0a49f138',
  version: { fileVersion: ver, fileVersionText: ver, productVersionText: null, description: null },
  known: { id: label, label, kind: 'official' },
  family: 'official',
});
const attestation = (o: Partial<any> = {}): any => ({
  measuredAt: at(0),
  ini: {
    mainIni: `${VPX_DIR}\\VPinballX.ini`,
    tableIni: null,
    physicsSet: 0,
    physicsSetName: null,
    physicsSetValues: null,
    physicsFlippersOverridden: false,
    flipperSetValues: null,
    stockPhysics: true,
    tableDifficulty: 0.5,
    difficultyOverride: null,
    effectiveDifficulty: 0.5,
    slope: { min: 6, max: 6.5, effective: 6.25 },
    nudge,
    tableOptions: { 'Cabinet mode': 1, 'Ball brightness': 2, 'Flipper colour': 0 },
    tableOverrides: {},
    playerOverrides: [],
    notes: [],
  },
  build: { vpx: bin('VPinballX64.exe', '10.8.0.2051', 'official VPX 10.8.0 release'), vpinmame: bin('VPinMAME\\VPinMAME64.dll', '3.6.0.1263', 'official VPinMAME 3.6.0 release'), notes: [] },
  vr: { inVr: false, runtime: null, runtimeLoaded: false, compositorRunning: false, vrCapableBuild: true, activeOpenXrRuntime: null, sampledAt: at(0) },
  adjustments: { rom: 'mb_106b', total: 54, checked, nonFactory: [], unjudged: 2 },
  vpmCheat: false,
  iniChanged: false,
  notes: [],
  engine: {
    atStart: { t: 0, reason: 'game_start', difficulty: 0.5, slopeMin: 6, slopeMax: 6.5, physicsSet: 0, gravity: null, friction: null, elasticity: null, elasticityFalloff: null, scatter: null, nudgeTime: null, nudge: { xmax: null, ymax: null, xgain: null, ygain: null, deadZone: null, tilt: 400 } },
    changes: [],
  },
  ...o,
});

const vpsIndex = { source: 'refreshed', version: 'b41f2c07e9', games: 2702, tables: 9824, builtAt: '2026-11-25T04:10:00Z', checkedAt: '2026-11-25T16:10:00Z' };

const lastCapture = (o: Partial<any> = {}): any => ({
  table: 'Medieval Madness (Williams 1997)',
  rom: 'mm_109c',
  players: 1,
  score: 48_215_660,
  launchedAt: at(-52),
  exitedAt: at(-31),
  outcome: 'ingested',
  mode: 'live',
  attempt: { n: 2, of: 5, remaining: 3 },
  identity: identity({
    filePath: `${TABLES_DIR}\\Medieval Madness (Williams 1997) VPW 2.0.vpx`,
    vpsGame: { id: 'Mm7Qe2LxP0', name: 'Medieval Madness', manufacturer: 'Williams', year: 1997 },
    vpsTable: { id: 'Vb9cK3tWq8', label: 'VPW 2.0 (VPin Workshop)' },
  }),
  attestation: attestation(),
  ...o,
});

/** A paired PC, watching, with Monster Bash open in live mode and a score posted earlier. */
export const STATUS_LIVE: any = {
  paired: true,
  running: true,
  vpxExe: `${VPX_DIR}\\VPinballX64.exe`,
  nvramDir: `${VPX_DIR}\\VPinMAME\\nvram`,
  mapsVersion: '0.14.2',
  currentTable: 'Monster Bash (Williams 1998)',
  currentIdentity: identity(),
  currentAttestation: attestation(),
  vpsVersion: 'b41f2c07e9',
  vpsIndex,
  lastCapture: lastCapture(),
  queued: 0,
  lastHeartbeatAt: at(-1),
  lastCheckinAt: at(-6),
  sendingTo: "Dana's Pinball Night · Monster Bash Madness",
  lastError: null,
  note: null,
  captureMode: 'live',
  attempt: { key: 'mb', state: 'counted', n: 3, of: 5, remaining: 2, late: false, game: 'Monster Bash', text: 'Attempt 3 of 5', needsStart: false },
  attemptStart: { at: at(-58), status: 'started', text: 'Start attempts pressed for Monster Bash' },
  patchNow: null,
  lastClose: null,
};

/** Paired and watching, VPX not open, nothing captured yet: the empty state. */
export const STATUS_EMPTY: any = {
  ...STATUS_LIVE,
  currentTable: null,
  currentIdentity: null,
  currentAttestation: null,
  lastCapture: null,
  captureMode: null,
  attempt: null,
  attemptStart: null,
  vpxExe: null,
  sendingTo: 'every room you belong to',
};

/** Basic mode with Patch now offered, a table that needs Start attempts, a refused post, a queued one, the table chosen by the player. */
export const STATUS_BASIC: any = {
  ...STATUS_LIVE,
  currentTable: 'Congo (Williams 1995)',
  currentIdentity: identity({
    filePath: `${TABLES_DIR}\\Congo (Williams 1995) 1.1.vpx`,
    vpsGame: { id: 'Cg4nN8wQx2', name: 'Congo', manufacturer: 'Williams', year: 1995 },
    vpsTable: { id: 'Zt5rY1mKc6', label: '1.1 (Dana)' },
    tableConfidence: 'likely',
    confirmed: true,
    tableChoices: [
      { id: 'Zt5rY1mKc6', label: '1.1 (Dana)' },
      { id: 'Pq2sD7hJv3', label: 'VPW 1.0 (VPin Workshop)' },
    ],
    tableInfo: { tableName: 'Congo', authorName: 'Dana', tableVersion: '1.1', releaseDate: null, saveDate: null, saveRev: 96, manufacturer: 'Williams', year: 1995, raw: {} },
    saveRev: 96,
  }),
  currentAttestation: attestation({
    ini: { ...attestation().ini, physicsSet: 2, physicsSetName: 'Chuck tuned', physicsFlippersOverridden: true, difficultyOverride: 0.7, effectiveDifficulty: 0.7 },
    adjustments: { rom: 'congo_21', total: 48, checked, nonFactory: ['Ball save time', 'Tilt warnings'], unjudged: 0 },
  }),
  captureMode: 'basic',
  note: 'Congo (Williams 1995) is not patched: only the last game of this session will post. Press Patch now (or Settings → Import tables → Patch my tables), then relaunch the table.',
  patchNow: { table: 'Congo (Williams 1995)', vpxPath: `${TABLES_DIR}\\Congo (Williams 1995) 1.1.vpx` },
  attempt: { key: 'congo', state: 'no_match', n: null, of: null, remaining: null, late: false, game: 'Congo', text: 'This table needs Start attempts: press the button on Status, then start a new game.', needsStart: true },
  attemptStart: { at: at(-3), status: 'not_open', text: 'No tournament of yours limits attempts on this table right now' },
  queued: 2,
  lastCapture: lastCapture({
    table: 'Attack from Mars (Bally 1995)',
    rom: 'afm_113b',
    score: 3_120_455_870,
    outcome: 'rejected',
    detail: 'the tournament closed at 20:00',
    mode: 'basic',
    attempt: null,
    identity: identity({
      filePath: `${TABLES_DIR}\\Attack from Mars (Bally 1995).vpx`,
      vpsGame: { id: 'Af2mR8sKq4', name: 'Attack from Mars', manufacturer: 'Bally', year: 1995 },
      vpsTable: { id: 'Wd6nP3cHx9', label: '2.1 (Chuck)' },
    }),
  }),
  lastError: 'heartbeat: ArcAid error: 503 Service Unavailable',
};

/** Not paired and paused; the last table closed with only its score at close read, and Patch now offered for it. */
export const STATUS_UNPAIRED: any = {
  ...STATUS_EMPTY,
  paired: false,
  running: false,
  sendingTo: null,
  lastHeartbeatAt: null,
  lastCheckinAt: null,
  vpxExe: `${VPX_DIR}\\VPinballX64.exe`,
  lastClose: {
    table: 'Attack from Mars (Bally 1995)',
    at: at(-12),
    rung: 'C',
    kind: 'unpatched',
    text: 'Attack from Mars (Bally 1995): only the score at close was read, not every game, because the table has no Castcade patch beside it.',
    vpxPath: `${TABLES_DIR}\\Attack from Mars (Bally 1995).vpx`,
  },
};

/** A table Castcade is not sure of: the picker is open by itself. */
export const STATUS_AMBIGUOUS: any = {
  ...STATUS_LIVE,
  currentTable: 'Theatre of Magic (Bally 1995)',
  currentIdentity: identity({
    filePath: `${TABLES_DIR}\\TOM.vpx`,
    vpsGame: { id: 'Tm6bH4nRw9', name: 'Theatre of Magic', manufacturer: 'Bally', year: 1995 },
    gameConfidence: 'likely',
    gameSource: 'rom',
    vpsTable: null,
    tableConfidence: 'ambiguous',
    tableChoices: [
      { id: 'Lw8eC2xFa5', label: '3.0 (Dana and Krobs)' },
      { id: 'Rj1tM6pQz7', label: 'VPW 1.1 (VPin Workshop)' },
      { id: 'Ny3gS9kBd2', label: 'Mod 2.4 (Chuck)' },
    ],
    tableInfo: { tableName: 'Theatre of Magic', authorName: null, tableVersion: null, releaseDate: null, saveDate: null, saveRev: 37, manufacturer: null, year: null, raw: {} },
    sha256: null,
    notes: ['three VPS tables share this ROM; the file name names none of them'],
  }),
  attempt: null,
};

/** Stream: nothing running, a key saved, the OBS overlay running. */
export const STREAM_IDLE: any = { state: 'idle', live: false, recording: false, wantsLive: false, wantsRecording: false, session: null, segment: null, table: null, picture: null, health: null, restarts: 0, covered: false, lastError: null, since: null };
export const STREAM_CAPTURING: any = {
  state: 'capturing',
  live: true,
  recording: true,
  wantsLive: true,
  wantsRecording: true,
  session: '2026-11-25_20-14-03',
  segment: 'Monster Bash 20-31-40.mkv',
  table: 'Monster Bash',
  picture: { width: 1080, height: 1920 },
  health: { frames: 18_432, fps: 22.4, speed: 0.93 },
  restarts: 1,
  covered: false,
  lastError: 'the capture restarted after VPX resized its window',
  since: at(-17),
};
export const STREAM_SETTINGS: any = {
  preset: '1080p30',
  orientation: 'portrait',
  shiftPercent: 0,
  rotate: 90,
  service: 'twitch',
  customIngest: null,
  recordingsDir: null,
  keepSessions: 20,
  maxRecordings: null,
  gameVolume: 100,
  audioLateMs: 120,
  overlay: true,
  hasKey: true,
  defaultRecordingsDir: String.raw`C:\Users\Owner\Videos\Castcade`,
};
export const PREVIEW_OFF: any = { previewing: false, picture: null, warning: null, error: null };
export const PREVIEW_ON: any = { previewing: true, picture: { width: 1080, height: 1920 }, warning: 'The preview window sits inside the captured area: move it to another screen, or viewers see it too.', error: null };
export const OVERLAY_URL = 'http://127.0.0.1:27460/overlay';

/** Import tables: what Castcade sees in the folder, what Patch my tables did, what Remove did. */
const TABLE_FILES = [
  ['Monster Bash (Williams 1998) VPW 1.2', 'mb_106b', 'patch'],
  ['Medieval Madness (Williams 1997) VPW 2.0', 'mm_109c', 'already'],
  ['Congo (Williams 1995) 1.1', 'congo_21', 'repatch'],
  ['Attack from Mars (Bally 1995)', 'afm_113b', 'patch'],
  ['Theatre of Magic (Bally 1995)', 'tom_14hb', 'patch'],
  ['Twilight Zone (Bally 1993)', 'tz_94ch', 'unreadable'],
  ['Pinball Magic (Capcom 1995)', 'pmv112', 'unsupported'],
  ['Krobs Original Haunted Arcade', null, 'skip'],
  ['Cirqus Voltaire (Bally 1997)', 'cv_14', 'foreign'],
  ['The Addams Family (Bally 1992)', 'taf_l7', 'already'],
] as const;
const REASON: Record<string, string> = {
  unreadable: "WPC-95 machines keep the score where the maps don't say yet",
  unsupported: 'Capcom: no map for this machine',
  skip: 'an original table (no ROM): its recipe does not exist yet',
  foreign: 'Cirqus Voltaire (Bally 1997).vbs is not Castcade’s',
};
export const PLAN: any = {
  dir: TABLES_DIR,
  items: TABLE_FILES.map(([id, rom, action]) => ({ vpxPath: `${TABLES_DIR}\\${id}.vpx`, tableId: id, action, cls: null, rom, reason: REASON[action] ?? '' })),
  counts: TABLE_FILES.reduce((c: Record<string, number>, [, , a]) => ({ ...c, [a]: (c[a] ?? 0) + 1 }), { patch: 0, repatch: 0, already: 0, skip: 0, foreign: 0, unsupported: 0, unreadable: 0 }),
};
export const APPLIED: any = {
  dir: TABLES_DIR,
  patched: ['Monster Bash (Williams 1998) VPW 1.2', 'Congo (Williams 1995) 1.1', 'Attack from Mars (Bally 1995)'],
  failed: [{ tableId: 'Theatre of Magic (Bally 1995)', error: 'EBUSY: the file is open in another program' }],
  already: 2,
  skipped: 4,
  unpatched: 1,
  libInstalled: 'updated',
  scriptsDir: `${VPX_DIR}\\Scripts`,
};
export const REMOVED: any = { dir: TABLES_DIR, removed: ['Monster Bash (Williams 1998) VPW 1.2', 'Medieval Madness (Williams 1997) VPW 2.0', 'Congo (Williams 1995) 1.1', 'The Addams Family (Bally 1992)'], keptForeign: ['Cirqus Voltaire (Bally 1997)'] };
export const TABLES_DEFAULTS: any = { tablesDir: TABLES_DIR, scriptsDir: `${VPX_DIR}\\Scripts`, vpxExe: `${VPX_DIR}\\VPinballX64.exe`, hookVersion: '0.6.0' };

/** The 3D watch card (Match tab), seen from Krobs' PC; the session's other member is Owner. */
const TABLE = 'Monster Bash (Williams 1998) VPW 1.2.vpx';
const watchOff: any = { state: 'off', role: null, code: null, members: [], player: null, local: { vpx: 'none', table: null, pid: null }, watchTable: null, fork: { present: true, path: null, line: null }, relayLine: null, error: null, ended: null };
const krobs = { id: 'krobs', name: 'Krobs', me: true, host: false, path: 'self', line: 'this PC' };
const owner = (path: string, line: string) => ({ id: 'owner', name: 'Owner', me: false, host: true, path, line });
const on = (o: Partial<any>): any => ({ ...watchOff, state: 'on', role: 'client', code: 'QWERTY', ...o });
const ownerPlays = { id: 'owner', name: 'Owner', me: false, table: TABLE, size: 48_211_968 };
const FORK_LINE = String.raw`The Castcade VPX build (VPinballX_GL64_castcade.exe) is not beside your VPX: copy it into C:\Games\Visual Pinball, next to VPinballX_GL64.exe.`;
export const WATCH: Record<string, any> = {
  idle: watchOff,
  'ended-fork': { ...watchOff, ended: 'the host ended the session', fork: { present: false, path: null, line: FORK_LINE } },
  hosting: on({ role: 'host', members: [{ id: 'owner', name: 'Owner', me: true, host: true, path: 'self', line: 'this PC' }] }),
  'no-path': on({ members: [owner('no_path', 'no direct path between your routers'), krobs], relayLine: 'Signalling goes through ArcAid; the table stream needs a direct path.' }),
  'other-plays': on({ members: [owner('direct', 'connected directly'), krobs], player: ownerPlays, watchTable: { path: `${TABLES_DIR}\\${TABLE}`, line: `Your copy of ${TABLE} matches the player's in size.`, warn: false } }),
  'size-differs': on({
    members: [owner('direct', 'connected directly'), krobs],
    player: ownerPlays,
    watchTable: { path: String.raw`D:\Pinball\${TABLE}`, line: `Your ${TABLE} is not the same size as the player's (48,190,464 bytes here, 48,211,968 there). If it is another version, VPX says "not the same table" when you watch.`, warn: true },
  }),
  watching: on({ members: [owner('direct', 'connected directly'), krobs], player: ownerPlays, local: { vpx: 'watching', table: TABLE, pid: 4243 } }),
};

export interface AppFixture {
  says: string;
  /** The tab pressed once the app has drawn. */
  tab: 'Pairing' | 'Status' | 'Stream' | 'Match' | 'Settings';
  edition?: 'full' | 'witness';
  /** null: the witness module has not answered yet. */
  status: any;
  settings?: any;
  update?: any;
  stream?: any;
  streamSettings?: any | 'never';
  preview?: any;
  overlay?: string | null | 'never';
  watch?: any;
  /** What the bridge answers to a press (the stub's other calls answer as the fixture's state). */
  answers?: Record<string, unknown>;
  /** The app's 3D watch card alone (the rest of the Match tab hidden): the card's own pictures. */
  focus?: string;
}

const UPDATE_READY = { ready: '0.2.52', waiting: null, installing: false, lastAttempt: null };

export const FIXTURES: Record<string, AppFixture> = {
  'pairing-unpaired': { says: 'Pairing, not paired yet: the code form', tab: 'Pairing', status: STATUS_UNPAIRED, settings: { ...SETTINGS, hasToken: false } },
  'pairing-paired': { says: 'Pairing, paired with arcaid.app', tab: 'Pairing', status: STATUS_LIVE },
  'pairing-refused': { says: 'Pairing, a code ArcAid refused (Pair pressed)', tab: 'Pairing', status: STATUS_UNPAIRED, settings: { ...SETTINGS, hasToken: false }, answers: { pair: new Error('Pairing code is invalid or has expired') } },
  'pairing-unpaired-notice': { says: 'Pairing, just unpaired (Unpair pressed): the notice', tab: 'Pairing', status: STATUS_LIVE, answers: { unpair: STATUS_UNPAIRED } },
  'status-loading': { says: 'Status before the witness module has answered (the loading state)', tab: 'Status', status: null },
  'status-live': { says: 'Status, paired and watching, Monster Bash open in live mode, a score posted earlier', tab: 'Status', status: STATUS_LIVE },
  'status-empty': { says: 'Status, paired and watching, VPX not open and nothing captured yet (the empty state)', tab: 'Status', status: STATUS_EMPTY },
  'status-basic': { says: 'Status, Congo open in basic mode (Patch now offered), Start attempts needed, a refused post, a heartbeat error', tab: 'Status', status: STATUS_BASIC },
  'status-unpaired': { says: 'Status, not paired and paused, the last table read only at close (Patch now offered)', tab: 'Status', status: STATUS_UNPAIRED },
  'status-ambiguous': { says: 'Status, a table Castcade is not sure of: the picker asks which one it is', tab: 'Status', status: STATUS_AMBIGUOUS },
  'stream-idle': { says: 'Stream, nothing running, a key saved, the OBS overlay running', tab: 'Stream', status: STATUS_LIVE, stream: STREAM_IDLE, streamSettings: STREAM_SETTINGS, preview: PREVIEW_OFF, overlay: OVERLAY_URL },
  'stream-live': { says: 'Stream, live and recording with the preview open: the health numbers (frame rate and speed low), the preview warning', tab: 'Stream', status: STATUS_LIVE, stream: STREAM_CAPTURING, streamSettings: STREAM_SETTINGS, preview: PREVIEW_ON, overlay: OVERLAY_URL },
  'stream-loading': { says: 'Stream before its settings have arrived (the loading state)', tab: 'Stream', status: STATUS_LIVE, stream: STREAM_IDLE, streamSettings: 'never', preview: PREVIEW_OFF, overlay: 'never' },
  'stream-custom': { says: 'Stream, no key, Other (RTMP URL), horizontal, the overlay not running, Advanced open', tab: 'Stream', status: STATUS_LIVE, stream: STREAM_IDLE, streamSettings: { ...STREAM_SETTINGS, service: 'custom', customIngest: 'rtmp://live.example.net/app/', hasKey: false, orientation: 'landscape', rotate: 0, recordingsDir: String.raw`D:\Recordings\Pinball`, maxRecordings: 200 }, preview: PREVIEW_OFF, overlay: null },
  settings: { says: 'Settings, paired, Start with Windows on', tab: 'Settings', status: STATUS_LIVE },
  'settings-saved': { says: 'Settings, the ArcAid URL changed and Save URL pressed: what says it was saved', tab: 'Settings', status: STATUS_LIVE },
  'settings-plan': { says: 'Settings, Import tables: Preview what will change pressed (the list)', tab: 'Settings', status: STATUS_LIVE, answers: { plan: PLAN } },
  'settings-plan-empty': {
    says: 'Settings, Import tables: Preview what will change pressed on a folder with no .vpx file (the empty result)',
    tab: 'Settings',
    status: STATUS_LIVE,
    answers: { plan: { dir: String.raw`C:\Games\Visual Pinball\Media`, items: [], counts: { patch: 0, repatch: 0, already: 0, skip: 0, foreign: 0, unsupported: 0, unreadable: 0 } } },
  },
  'settings-applied': { says: 'Settings, Import tables: Patch my tables pressed (done, one table failed)', tab: 'Settings', status: STATUS_LIVE, answers: { apply: APPLIED } },
  'settings-removed': { says: 'Settings, Import tables: Remove all Castcade patches pressed', tab: 'Settings', status: STATUS_LIVE, answers: { removeAll: REMOVED } },
  'settings-logs': { says: 'Settings, Send logs to Arcaid support pressed: sent', tab: 'Settings', status: STATUS_LIVE, answers: { sendLogs: { ok: true, text: 'Logs sent to Arcaid support: 9 files, 4,318 KB.' } } },
  'settings-logs-refused': { says: 'Settings, Send logs to Arcaid support pressed twice within 10 minutes: refused', tab: 'Settings', status: STATUS_LIVE, answers: { sendLogs: { ok: false, text: 'Logs not sent: ArcAid takes one set of logs from a PC in 10 minutes, and this PC asked less than 10 minutes ago. If that one went through, Arcaid support has it; otherwise press again in a few minutes.' } } },
  'update-ready': { says: 'An update downloaded and ready to install, above the Status tab', tab: 'Status', status: STATUS_EMPTY, update: UPDATE_READY },
  'update-waiting': { says: 'An update ready, waiting while a table is open; the last install did not finish', tab: 'Status', status: STATUS_LIVE, update: { ...UPDATE_READY, waiting: 'until Monster Bash is closed', lastAttempt: 'not_finished' } },
  'update-installing': { says: 'Restart and update pressed: the installer is starting', tab: 'Status', status: STATUS_LIVE, update: { ...UPDATE_READY, installing: true } },
  'witness-pairing': { says: 'Witness edition (cabinet), Pairing, not paired yet', tab: 'Pairing', edition: 'witness', status: STATUS_UNPAIRED, settings: { ...SETTINGS, hasToken: false, deviceLabel: 'CABINET-4KP' } },
  'witness-status': { says: 'Witness edition (cabinet), Status, paired and watching, a table open', tab: 'Status', edition: 'witness', status: STATUS_LIVE, settings: { ...SETTINGS, deviceLabel: 'CABINET-4KP' } },
  'witness-settings': { says: 'Witness edition (cabinet), Settings', tab: 'Settings', edition: 'witness', status: STATUS_LIVE, settings: { ...SETTINGS, deviceLabel: 'CABINET-4KP' }, update: UPDATE_READY },
  ...Object.fromEntries(
    Object.entries(WATCH).map(([name, w]) => [
      `watch-${name}`,
      { says: `Match tab, the 3D watch card alone, Krobs' PC: ${name.replace(/-/g, ' ')}`, tab: 'Match', status: STATUS_LIVE, watch: w, focus: '3D watch' } satisfies AppFixture,
    ]),
  ),
};
