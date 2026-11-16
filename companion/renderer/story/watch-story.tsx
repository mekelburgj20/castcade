/**
 * I11.4.1 (2026-11-16): a story page for the 3D watch card, never shipped (the build's only input is index.html). It
 * renders the real Match view with a stub `window.castcade` whose 3D watch status is the one `?state=` names, so each
 * state of the card can be looked at in a browser without Electron:
 *
 *   npx vite --config renderer/story/vite.config.mjs      (from companion/; serves 127.0.0.1 only)
 *   http://127.0.0.1:5199/story/watch.html?state=hosting
 *
 * Nothing here talks to anything: every bridge call answers from the tables below.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Match } from '../src/views/Match.js';
import { useCastcade } from '../src/useCastcade.js';
import '../src/app.css';

const TABLE = 'Nudge Test and Calibration.vpx';
const SIZE = 4_952_064;
const FORK_LINE = String.raw`The Castcade VPX build (VPinballX_GL64_castcade.exe) is not beside your VPX: copy it into C:\Users\you\VPX, next to VPinballX_GL64.exe.`;

const off: WatchStatus = {
  state: 'off',
  role: null,
  code: null,
  members: [],
  player: null,
  local: { vpx: 'none', table: null, pid: null },
  watchTable: null,
  fork: { present: false, path: null, line: null },
  relayLine: null,
  error: null,
  ended: null,
};
const me = { id: 'krobs', name: 'Krobs', me: true, host: false, path: 'self' as const, line: 'this PC' };
const owner = (path: WatchStatus['members'][number]['path'], line: string) => ({ id: 'owner', name: 'Owner', me: false, host: true, path, line });
const on = (o: Partial<WatchStatus>): WatchStatus => ({ ...off, state: 'on', role: 'client', code: 'QWERTY', fork: { present: true, path: null, line: null }, ...o });
const playing = { id: 'owner', name: 'Owner', me: false, table: TABLE, size: SIZE };

const STATES: Record<string, WatchStatus> = {
  idle: off,
  connecting: { ...off, state: 'connecting' },
  hosting: on({ role: 'host', members: [{ id: 'owner', name: 'Owner', me: true, host: true, path: 'self', line: 'this PC' }] }),
  'joined-connecting': on({ members: [owner('connecting', 'connecting…'), me] }),
  direct: on({ members: [owner('direct', 'connected directly'), me] }),
  'no-path': on({ members: [owner('no_path', 'no direct path between your routers'), me] }),
  'other-plays': on({ members: [owner('direct', 'connected directly'), me], player: playing, watchTable: { path: String.raw`C:\VPX\tables\${TABLE}`, line: `Your copy of ${TABLE} matches the player's in size.`, warn: false } }),
  'i-play': on({ members: [owner('direct', 'connected directly'), me], player: { id: 'krobs', name: 'Krobs', me: true, table: TABLE, size: SIZE }, local: { vpx: 'playing', table: TABLE, pid: 4242 } }),
  'i-watch': on({ members: [owner('direct', 'connected directly'), me], player: playing, local: { vpx: 'watching', table: TABLE, pid: 4243 } }),
  // What watch-host.ts sets when Play finds no fork: the fork line, which is also the error.
  'error-fork': on({ members: [owner('direct', 'connected directly'), me], fork: { present: false, path: null, line: FORK_LINE }, error: FORK_LINE }),
  'error-fork-idle': { ...off, fork: { present: false, path: null, line: FORK_LINE }, error: null },
  'error-unpaired': { ...off, error: '3D watch goes through ArcAid: pair this PC with ArcAid first (Settings).' },
  'error-match-code': { ...off, error: 'Nothing answered on ABCDEF as a 3D watch session. If that is a match code, join it with Join a match above.' },
  'error-no-table': on({ members: [owner('direct', 'connected directly'), me], player: playing, watchTable: { path: null, line: `${TABLE} is not in your tables: pick your copy of the file to watch.`, warn: true } }),
  'error-size': on({
    members: [owner('direct', 'connected directly'), me],
    player: playing,
    watchTable: {
      path: String.raw`D:\Tables\${TABLE}`,
      line: `Your ${TABLE} is not the same size as the player's (4,951,000 bytes here, 4,952,064 there). If it is another version, VPX says "not the same table" when you watch.`,
      warn: true,
    },
  }),
  ended: { ...off, state: 'ended', ended: 'the host ended the session' },
};

const which = new URLSearchParams(location.search).get('state') ?? 'idle';
const watch = STATES[which] ?? off;

const settings: MatchSettings = {
  port: 27401,
  ballsPerGame: 3,
  displayName: 'Krobs',
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
};

const match: MatchStatus = {
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
  startWarnings: [],
  advisories: [],
  pass: null,
  transfer: null,
  series: null,
  panel: null,
  media: null,
  previewAdvice: null,
  vrOverlay: null,
  vrBench: null,
  rig: 'pc',
  rigReason: 'no headset',
  vrRuntime: null,
  microphones: [],
  micDeviceId: null,
  muted: false,
  turn: null,
  videoPath: 'native',
  videoMaxKbps: 20_000,
  videoPin: null,
  locked: false,
  settings,
  defaultName: 'KROBS-PC',
  lastError: null,
  menuKeyProblem: null,
  bench: null,
  resume: null,
};

const oneStep: OneStepStatus = { link: null, message: null, copied: false, pending: null, launch: { state: 'idle', table: null, detail: null }, tableToStart: null, notice: null, attention: 0 };

/** An API object: what it has, as given; any other call answers null; any other `onX` subscription is a no-op. */
const api = (o: Record<string, unknown>): Record<string, unknown> =>
  new Proxy(o, {
    get(t, key: string) {
      if (key in t) return t[key];
      if (key.startsWith('on')) return () => () => undefined;
      return () => Promise.resolve(null);
    },
  });
const ok =
  <T,>(v: T) =>
  (): Promise<T> =>
    Promise.resolve(v);

const bridge = api({
  appVersion: '0.2.43',
  protocolVersion: 5,
  platform: 'win32',
  witness: api({ status: ok({ paired: true, running: true, currentTable: null }) }),
  settings: api({ get: ok({}) }),
  app: api({ versions: ok(null), logPath: ok(String.raw`C:\logs\companion.log`), loginItem: api({ get: ok({ supported: false, openAtLogin: false }) }), clipboardText: ok('') }),
  match: api({ status: ok(match), benchClips: ok([]) }),
  launch: api({ status: ok(oneStep), tables: ok([{ path: String.raw`C:\VPX\tables\${TABLE}`, name: 'Nudge Test and Calibration', rom: null, lastPlayedAt: null, imported: false }]), browse: ok([]) }),
  watch: api({ status: ok(watch), pickTable: ok(null) }),
}) as unknown as CastcadeBridge;
Object.defineProperty(window, 'castcade', { value: bridge });

function Story() {
  const state = useCastcade();
  return (
    <main className="shell">
      <header className="top">
        <h1>
          <span className="dot on" aria-hidden="true" /> Castcade
        </h1>
        <nav className="tabs" aria-label="Views">
          {['Pairing', 'Status', 'Stream', 'Match', 'Settings'].map((t) => (
            <button key={t} type="button" className={t === 'Match' ? 'tab active' : 'tab'}>
              {t}
            </button>
          ))}
        </nav>
      </header>
      <Match state={state} />
    </main>
  );
}

const root = document.getElementById('root');
if (root) createRoot(root).render(
  <StrictMode>
    <Story />
  </StrictMode>,
);
