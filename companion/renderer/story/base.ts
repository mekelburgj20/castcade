/**
 * A17 step 9 (2026-11-27): what the lobby story pages share: a `MatchStatus` with nothing going on (a fixture
 * overrides what its state needs, fixtures.ts `status()`), and the stub bridge. Nothing here talks to anything.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

export const SETTINGS: any = {
  port: 27401,
  ballsPerGame: 3,
  displayName: 'Owner',
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
  preMatchPlay: 'free',
  startTableOnHost: false,
  voiceVolume: 150,
  othersTableVolume: 100,
  myTableWhileUp: 100,
  menuKey: 'Control+Alt+M',
  menuChooseKey: 'Control+Alt+K',
  scoreboard: true,
  scoreboardCorner: 'top-right',
  scoreboardPlace: null,
  watch3d: 'auto',
  stance: 'play',
  changeTablesForMe: true,
};

export const MATCH: any = {
  role: 'none',
  phase: 'none',
  endpoint: null,
  invite: null,
  directInvite: null,
  ipSource: null,
  via: null,
  path: null,
  relayNote: null,
  portMapping: null,
  port: null,
  code: null,
  localId: null,
  hostId: null,
  participants: [],
  lobby: null,
  startWarnings: [],
  wait3d: { players: [], seconds: 0, armed: null },
  advisories: [],
  pass: null,
  endBall: null,
  transfer: null,
  series: null,
  panel: null,
  media: null,
  previewAdvice: null,
  vrOverlay: null,
  vrBench: null,
  rig: 'vr_headset',
  rigReason: 'a headset runtime is active',
  vrRuntime: 'virtual-desktop',
  microphones: [{ deviceId: 'default', label: 'Headset microphone' }],
  micDeviceId: null,
  muted: false,
  turn: null,
  videoPath: 'native',
  videoMaxKbps: 20_000,
  videoPin: null,
  locked: false,
  stream3d: null,
  settings: SETTINGS,
  defaultName: 'Owner',
  lastError: null,
  menuKeyProblem: null,
  bench: null,
  resume: null,
};

export const WATCH: any = {
  state: 'off',
  role: null,
  code: null,
  members: [],
  player: null,
  local: { vpx: 'none', table: null, pid: null },
  watchTable: null,
  fork: { present: true, path: null, line: null },
  relayLine: null,
  error: null,
  ended: null,
};

const TABLES = ['Monster Bash (Williams 1998)', 'Congo (Williams 1995)', 'Attack from Mars (Bally 1995)', 'Medieval Madness (Williams 1997)'].map((name, i) => ({
  path: `story:${i}`,
  name,
  rom: ['mb_106b', 'congo_21', 'afm_113b', 'mm_109c'][i],
  lastPlayedAt: null,
  imported: true,
}));

/** An API object: what it has, as given; any other call answers null; any other `onX` subscription is a no-op. */
export const api = (o: Record<string, unknown>): Record<string, unknown> =>
  new Proxy(o, {
    get(t, key: string) {
      if (key in t) return t[key];
      if (typeof key === 'string' && key.startsWith('on')) return () => () => undefined;
      return () => Promise.resolve(null);
    },
  });
export const ok =
  <T,>(v: T) =>
  (): Promise<T> =>
    Promise.resolve(v);

/** `window.castcade` for a story: the given match and one-step status, a paired Witness, a few tables in the picker. */
export function installBridge(match: unknown, oneStep: unknown, o: { paired?: boolean; tableOpen?: string | null } = {}): void {
  const bridge = api({
    appVersion: '0.2.51',
    protocolVersion: 7,
    platform: 'win32',
    witness: api({ status: ok({ paired: o.paired !== false, running: true, currentTable: o.tableOpen ?? null }) }),
    settings: api({ get: ok({}) }),
    app: api({ versions: ok(null), logPath: ok('companion.log'), loginItem: api({ get: ok({ supported: false, openAtLogin: false }) }), clipboardText: ok('') }),
    match: api({ status: ok(match), benchClips: ok([]) }),
    launch: api({ status: ok(oneStep), tables: ok(TABLES), browse: ok([]), pick: ok(null) }),
    watch: api({ status: ok(WATCH), pickTable: ok(null) }),
  });
  Object.defineProperty(window, 'castcade', { value: bridge });
}
