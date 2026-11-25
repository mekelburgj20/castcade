/**
 * I11.4.2 (docs/design/state-stream-in-match.md §4): the state stream inside a real match. Match hosts on localhost
 * over real WebSockets (Electron stubbed, as match-host.test.ts), each with the real `stream3d-host` on a real loopback
 * control port; scripted control clients stand in for the VPX fork; the tunnels are fakes joined by a hub, signalled
 * through the match's own MEDIA_SIGNAL (`channel: 'stream'`). Each PC has a table whose journal the test writes
 * (ball ends, game starts and ends), as match-restart.test.ts has.
 *
 * What it proves: PCs with the fork watch each other in 3D by turns and show a PC without it in 2D; the headset of a PC
 * watching in 3D is never put in theater, and is when it falls back; the turn lock file of the player coming up stays
 * until its fork says `state playing`; and the fork is on its own table whenever the match gives nobody to watch: a
 * pause, the result, the initials hold, a finished game still ending on the machine, the host gone, a player gone, the
 * match left.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MatchStream3d, Stream3dHost } from './stream3d-host.js';
import type { FakeTunnel, ScriptedFork as Fork, TunnelHub as Hub } from './stream3d.test-support.js';

vi.mock('electron', () => {
  class BrowserWindow {
    webContents = { once: (_e: string, cb: () => void) => cb(), send: () => undefined };
    isDestroyed(): boolean {
      return false;
    }
    loadFile(): Promise<void> {
      return Promise.resolve();
    }
    destroy(): void {}
  }
  return { BrowserWindow, ipcMain: { on: () => undefined } };
});

const { createMatchHost, matchHalfOf } = await import('./match-host.js');
const { matchSignalling } = await import('./match-setup.js');
const { createStream3dHost } = await import('./stream3d-host.js');
const { startFakeRelay } = await import('../match/relay-fake.test-support.js');
const { ScriptedFork, TunnelHub, until } = await import('./stream3d.test-support.js');
type MatchHost = ReturnType<typeof createMatchHost>;
type Opts = Parameters<typeof createMatchHost>[0];
type WitnessHost = Opts['witness'];
type Logger = Opts['log'];
type WStatus = ReturnType<WitnessHost['status']>;
type Listener = Parameters<WitnessHost['onEvent']>[0];
type Feed = Parameters<Listener>[0];
type Mark = NonNullable<NonNullable<Parameters<Listener>[1]>['mark']>;
type FakeRelay = Awaited<ReturnType<typeof startFakeRelay>>;

const VPX = String.raw`C:\vpx\VPinballX_GL64.exe`;
const FORK = String.raw`C:\vpx\VPinballX_GL64_castcade.exe`;
const SHA = 'ab'.repeat(32);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const dirs: string[] = [];
const hosts: MatchHost[] = [];
const streams: Stream3dHost[] = [];
const forks: Fork[] = [];
const relays: FakeRelay[] = [];
afterEach(async () => {
  for (const f of forks.splice(0)) f.close();
  for (const h of hosts.splice(0)) await h.stop();
  for (const s of streams.splice(0)) await s.stop();
  for (const r of relays.splice(0)) await r.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * A PC's table: VPX with a table open and the hook journaling, whether Castcade runs or not. `castcadeStarts` is a
 * fresh witness reading the journal from the top (every event again, marked as backlog).
 */
function table(o: { qualifies?: boolean } = {}) {
  const eventCbs = new Set<Listener>();
  const journal: { ev: Feed; offset: number }[] = [];
  let offset = 100;
  let delivered: Mark | null = null;
  const markAt = (at: number): Mark => ({ path: '/journal/table.jsonl', session: 's1', loaded: 50, offset: at });
  const emit = (ev: Feed, at: number, backlog: boolean): void => {
    delivered = markAt(at);
    for (const cb of [...eventCbs]) cb(ev, { backlog, mark: markAt(at) });
  };
  const say = (ev: Feed): void => {
    offset += 10;
    journal.push({ ev, offset });
    emit(ev, offset, false);
  };
  const w = {
    status: () => ({ paired: false, currentTable: 'Monster Bash', currentIdentity: { sha256: SHA, tableInfo: null }, currentAttestation: null, captureMode: 'live', note: null }) as unknown as WStatus,
    sampleVr: async () => null,
    liveGame: () => ({ table: 'Monster Bash', inGame: false, scores: [], player: null, ball: null }),
    onEvent: (cb: Listener) => (eventCbs.add(cb), () => eventCbs.delete(cb)),
    onStatus: () => () => undefined,
    journalMark: () => delivered,
    // A16.2: does this final score have a place on the machine's high-score list?
    highScoreQualifies: () => o.qualifies === true,
  } as unknown as WitnessHost;
  return {
    w,
    gameStart: () => say({ kind: 'game_start', t: 0, players: 1 } as Feed),
    gameEnd: (score: number) => say({ kind: 'game_end', t: 0, scores: [score], players: 1 } as Feed),
    /** The table's score while a ball is in play, and a ball draining with nothing else said (A17 step 4). */
    score: (ball: number, score: number) => say({ kind: 'current_scores', t: 0, scores: [score], player: 1, ball } as Feed),
    drain: (ball: number) => say({ kind: 'ball_end', t: 0, player: 1, ball, extraBalls: 0 } as Feed),
    /** One ball played to its end at `score`; `again`: the machine has an extra ball pending (shoot again). */
    ball(ball: number, score: number, again = false) {
      say({ kind: 'current_scores', t: 0, scores: [score], player: 1, ball } as Feed);
      say({ kind: 'ball_end', t: 0, player: 1, ball, extraBalls: again ? 1 : 0 } as Feed);
      say({ kind: 'current_scores', t: 0, scores: [score], player: 1, ball } as Feed);
    },
    castcadeStarts() {
      delivered = null;
      for (const j of journal) emit(j.ev, j.offset, true);
    },
  };
}

/** `RtcHost` and the OpenXR layer as the match host sees them; the layer's modes are what the headset shows. */
function rigFakes() {
  const modes: string[] = [];
  let vr = false;
  let attached = false;
  const source = { onFrame: () => () => undefined };
  const media = {
    async attach() {
      attached = true;
    },
    addPeer: () => undefined,
    removePeer: () => undefined,
    setSending: () => undefined,
    setPanelState: () => undefined,
    setMuted: () => undefined,
    setNativeVideo: () => undefined,
    status: () => ({ attached, sending: false, peers: {}, mic: 'open', captureSource: null, lastError: null }),
    onStatus: () => () => undefined,
    frames: () => (attached && vr ? source : null),
    showPanel: () => undefined,
    async detach() {
      attached = false;
    },
    async setVr(rig: { headsetPanel: boolean }) {
      vr = rig.headsetPanel;
    },
  };
  let state: 'stopped' | 'showing' = 'stopped';
  const layer = {
    async start() {
      state = 'showing';
      return { state, reason: null };
    },
    async stop() {
      state = 'stopped';
    },
    status: () => ({ state, reason: null }),
    onStatus: () => () => undefined,
    setMode: (m: string) => void modes.push(m),
  };
  return { media: media as unknown as NonNullable<Opts['media']>, layer: layer as unknown as NonNullable<Opts['vrLayer']>, modes };
}

type Cmd = Record<string, unknown> & { cmd: string };
/** D10.3: a native video helper that is ready at once and records what it is told. */
function videoHelper() {
  const sent: Cmd[] = [];
  const helper = {
    start: () => undefined,
    stop: async () => undefined,
    send(cmd: Cmd) {
      sent.push(cmd);
      return true;
    },
    onEvent: () => () => undefined,
    status: () => ({ helper: 'ready' as const, reason: null, version: '1', encoder: 'h264_nvenc', decoder: 'nvdec', generation: 1 }),
    onStatus: () => () => undefined,
  };
  return { helper, sinks: () => sent.filter((c) => c.cmd === 'sink').map((c) => c.kind as string) };
}

interface Seat {
  name: string;
  mh: MatchHost;
  dir: string;
  lock: string;
  lines: string[];
  /** The headset's modes, in order (a headset rig). */
  modes: string[];
  /** The native video helper's sink, in order (a rig with `video`). */
  sinks: () => string[];
  stream3d: Stream3dHost;
  saved: { text: string | null };
  t: ReturnType<typeof table>;
  id(): string;
  tunnel(): FakeTunnel | undefined;
}

interface SeatOptions {
  fork?: boolean;
  /** A headset on Virtual Desktop's OpenXR runtime (the default), or a desktop PC. */
  rig?: 'vr' | 'pc';
  qualifies?: boolean;
  /** The native video helper is in this build. */
  video?: boolean;
  /** The same PC after Castcade started again: its folder, its ports file, its table. */
  again?: Seat;
  extra?: Partial<Opts>;
  /** I11.4.9: the limit of this PC's wait for its 3D connection at the first start (default: the app's 45 s). */
  startWaitMs?: number;
  /** I11.4.12: how long a fork that left the control connection is given to be back before the lobby says anything. */
  forkReconnectGraceMs?: number;
}

function seat(hub: Hub, name: string, o: SeatOptions = {}): Seat {
  const dir = o.again?.dir ?? mkdtempSync(join(tmpdir(), `castcade-s3d-${name}-`));
  if (!o.again) dirs.push(dir);
  const lines: string[] = [];
  const push = (l: string): void => void lines.push(l);
  const log = { info: push, warn: push, error: push, file: '' } as unknown as Logger;
  const t = o.again?.t ?? table({ qualifies: o.qualifies });
  const saved = o.again?.saved ?? { text: null as string | null };
  // Never bound by anything here: only the number the launch options ask the (scripted) fork to listen on. Every
  // socket of this file is opened on port 0 and its port read back (the match listener through `ephemeralPort`, the
  // control server, the relay double).
  let port = 52_000 + Math.floor(Math.random() * 500) * 10;
  let me: string | null = null;
  const stream3d = createStream3dHost({
    log: { info: push, warn: push },
    logsDir: join(dir, 'logs'),
    pageDir: dir,
    vpxExe: () => VPX,
    exists: async (p) => p === VPX || (p === FORK && o.fork !== false),
    iceServers: () => [],
    tunnel: (opts) => {
      me = opts.localId;
      return hub.make(opts);
    },
    freePort: async () => ++port,
    ports: { read: () => saved.text, write: (text) => void (saved.text = text) },
    ...(o.startWaitMs !== undefined ? { startWaitMs: o.startWaitMs } : {}),
    ...(o.forkReconnectGraceMs !== undefined ? { forkReconnectGraceMs: o.forkReconnectGraceMs } : {}),
  });
  streams.push(stream3d);
  const fakes = rigFakes();
  const video = o.video ? videoHelper() : null;
  const vr = o.rig !== 'pc';
  const lock = join(dir, 'lock', 'turn.lock');
  const mh = createMatchHost({
    file: join(dir, 'match.json'),
    keysFile: join(dir, 'match-keys.json'),
    witness: t.w,
    device: () => ({ deviceId: `dev-${name}`, deviceLabel: name }),
    appVersion: '0.2.46',
    // A18: no grace: these tests are about what follows a dropped link, not the wait before it counts.
    disconnectGraceMs: 0,
    log,
    publicIp: () => Promise.resolve('127.0.0.1'),
    lockFile: lock,
    listenAddress: '127.0.0.1',
    ephemeralPort: true,
    // A17 step 7: every match is in a lobby, and every start of a lobby counts down (5 s in the app); here it is short.
    lobby: { countdownMs: 20 },
    openPort: null,
    media: fakes.media,
    ...(vr ? { vrLayer: fakes.layer } : {}),
    rig: async () => (vr ? { rig: 'vr_headset' as const, reason: 'test', runtime: 'virtual-desktop' as const } : { rig: 'pc' as const, reason: 'test', runtime: null }),
    // The real signalling over the match socket, as the shell wires it: the tunnel's signals ride MEDIA_SIGNAL.
    signalling: (role, id) => matchSignalling(role, id),
    stream3d,
    ...(video ? { nativeVideo: { helper: video.helper as never, sendRing: 'SENDring_ABCDEFG', recvRing: 'RECVring_ABCDEFG' } } : {}),
    ...o.extra,
  });
  hosts.push(mh);
  return {
    name,
    mh,
    dir,
    lock,
    lines,
    modes: fakes.modes,
    sinks: () => video?.sinks() ?? [],
    stream3d,
    saved,
    t,
    id: () => mh.status().localId as string,
    tunnel: () => hub.all.filter((x) => x.id === me).at(-1),
  };
}

/** The fork of the seat's table on its control port, through its hello. `obey`: it answers every watch and play by itself. */
async function forkOf(s: Seat, obey = true, tableId?: string): Promise<Fork> {
  const f = await ScriptedFork.connect(await s.stream3d.controlPort());
  forks.push(f);
  f.hello(tableId);
  return obey ? f.obey() : f;
}

const view = (s: Seat): ReturnType<MatchStream3d['status']> | null => s.mh.status().stream3d;
const watching = (s: Seat): string | null => view(s)?.watching ?? null;
const lineFor = (s: Seat, other: Seat): string => view(s)?.players.find((p) => p.id === other.id())?.line ?? '';
/**
 * The seat watches `other` AND its fork has the line. `watching` alone is the decision, made a moment before the
 * `watch` line is on the socket (the tunnel's listener is asked first): a count of the fork's lines read right after
 * it is a count taken too early (the Linux CI run of 2026-11-19 read 2 where 3 was a few milliseconds away).
 */
const sees = (s: Seat, f: Fork | undefined, other: Seat): boolean => watching(s) === other.id() && (f?.got.at(-1) ?? '').startsWith('watch ');
const playerUp = (s: Seat): string | null => s.mh.status().panel?.playerUp ?? null;
const up = (s: Seat, ball?: number): boolean => s.mh.status().panel?.myTurn === true && (ball === undefined || s.mh.status().panel?.ball === ball);

/** The seat's ball `ball` ends at `score`. */
async function endBall(s: Seat, ball: number, score: number, again = false): Promise<void> {
  await until(() => up(s, ball), 8000, `${s.name}'s ball ${ball}`);
  s.t.ball(ball, score, again);
  if (!again) await until(() => !up(s, ball) || s.mh.status().phase === 'over', 8000, `${s.name}'s ball ${ball} to end`);
}

/** Castcade closes on this PC without leaving the match (a crash, as the others see it): its sockets and its control port go. */
async function crash(s: Seat): Promise<void> {
  await s.mh.stop({ keepForRestart: true });
  await s.stream3d.stop();
}

/**
 * A lobby: the first seat hosts, the others join, and the forks (all obedient unless `manual` names the seat) are on
 * their control ports, every pair of them showing each other in 3D.
 */
async function lobby(hub: Hub, specs: Array<[name: string, o?: SeatOptions]>, o: { manual?: string[]; balls?: 3 | 5 } = {}): Promise<{ seats: Seat[]; forks: Record<string, Fork> }> {
  const seats = specs.map(([name, so]) => seat(hub, name, so));
  const [host, ...others] = seats as [Seat, ...Seat[]];
  const hs = await host.mh.host({ port: 0, ballsPerGame: o.balls ?? 3, displayName: host.name });
  for (const s of others) await s.mh.join(hs.invite!, s.name);
  await until(() => seats.every((s) => s.mh.status().participants.length === seats.length), 8000, 'everyone in the lobby');
  const byName: Record<string, Fork> = {};
  const withFork = seats.filter((_, i) => specs[i]![1]?.fork !== false);
  for (const s of withFork) {
    // As one-step does when it starts the match table: the launch is what names (and saves) the control port.
    await s.mh.tableLaunch();
    byName[s.name] = await forkOf(s, !(o.manual ?? []).includes(s.name));
  }
  for (const a of withFork) {
    for (const b of withFork) {
      if (a !== b) await until(() => lineFor(a, b) === `${b.name}: 3D, on your own table`, 8000, `${a.name} to show ${b.name} in 3D`);
    }
  }
  return { seats, forks: byName };
}

describe('the state stream inside a match (I11.4.2)', () => {
  it('three players, one without the fork: the two with it watch each other in 3D by turns, everyone sees the third in 2D, the third sees 2D; the lock waits for state playing; the setting turns it off', async () => {
    const hub = new TunnelHub();
    const H = seat(hub, 'Hosty');
    const K = seat(hub, 'Krobs');
    const C = seat(hub, 'Chuck', { fork: false });

    // Before a match there is nothing to launch into.
    expect(await H.mh.tableLaunch()).toBeNull();
    expect(H.mh.status().stream3d).toBeNull();

    const hs = await H.mh.host({ port: 0, ballsPerGame: 3, displayName: 'Hosty' });
    expect(hs.settings.watch3d).toBe('auto');
    await K.mh.join(hs.invite!, 'Krobs');
    await C.mh.join(hs.invite!, 'Chuck');
    await until(() => H.mh.status().participants.length === 3 && K.mh.status().participants.length === 3 && C.mh.status().participants.length === 3);

    // §4.4: the match table of a PC with the fork starts in it, with the stream's variables; a PC without starts as ever.
    const launch = await H.mh.tableLaunch();
    expect(launch?.options).toMatchObject({ exe: FORK, env: { CASTCADE_STREAM: 'match', CASTCADE_STREAM_SOUND: '0', CASTCADE_STREAM_CONTROL: `connect:127.0.0.1:${await H.stream3d.controlPort()}` } });
    expect(launch?.options.env?.CASTCADE_STREAM_ADDR).toMatch(/^listen:127\.0\.0\.1:\d+$/);
    expect(await K.mh.tableLaunch()).not.toBeNull();
    expect(await C.mh.tableLaunch()).toBeNull();

    // The two forks come up on the same table file; the third PC's VPX never connects.
    const fh = await forkOf(H, false);
    const fk = await forkOf(K, false);

    // The lobby: every pair's data connection is signalled through the match (MEDIA_SIGNAL, channel `stream`), and
    // each PC says what its VPX is over it. One line per other player on each Match tab.
    await until(() => hub.open(H.id(), K.id()) && hub.open(H.id(), C.id()) && hub.open(K.id(), C.id()), 5000, 'the three data connections');
    await until(() => lineFor(H, K) === 'Krobs: 3D, on your own table' && lineFor(K, H) === 'Hosty: 3D, on your own table', 5000, 'the 3D lines');
    await until(() => lineFor(H, C) === 'Chuck: the 2D video (no Castcade VPX build runs the table on their PC)' && lineFor(K, C) === 'Chuck: the 2D video (no Castcade VPX build runs the table on their PC)', 5000, 'the 2D lines for Chuck');
    expect(lineFor(C, H)).toBe('Hosty: the 2D video (no Castcade VPX build runs the table on this PC)');
    expect(lineFor(C, K)).toBe('Krobs: the 2D video (no Castcade VPX build runs the table on this PC)');
    expect(view(H)).toMatchObject({ setting: 'auto', fork: 'ready', watching: null });
    expect(view(C)).toMatchObject({ fork: 'none', watching: null });
    // The lobby is `play` for everyone: no command went to any fork.
    expect(fh.got).toEqual([]);
    expect(fk.got).toEqual([]);

    // ---- game 1, ball 1: the host is up ----
    await H.mh.start();
    await until(() => K.mh.status().phase === 'playing' && C.mh.status().phase === 'playing' && playerUp(K) === H.id());
    // Krobs waits with a locked table: its fork is sent to the host's table, and its headset is never put in theater.
    await fk.next(/^watch 127\.0\.0\.1:\d+$/);
    fk.say('state watching');
    await until(() => watching(K) === H.id());
    expect(existsSync(K.lock)).toBe(true);
    await until(() => K.modes.at(-1) === 'hidden');
    expect(K.modes).not.toContain('theater');
    expect(K.lines).toContain('match: headset mode hidden (the player up is on this table in 3D: no theater picture)');
    // Chuck has no fork: theater with the 2D video, as before.
    await until(() => C.modes.at(-1) === 'theater');
    // The host plays: nothing over its table, nothing sent to its fork.
    expect(H.modes.at(-1)).toBe('hidden');
    expect(fh.got).toEqual([]);
    expect(existsSync(H.lock)).toBe(false);

    // ---- the turn goes to Krobs: play to its fork, and its lock stays until the fork is back on its own table ----
    await endBall(H, 1, 1000);
    await fk.next('play');
    await until(() => up(K));
    expect(existsSync(K.lock)).toBe(true);
    expect(K.mh.status().locked).toBe(true);
    expect(K.lines).toContain('stream3d: the table is to be unlocked; waiting for VPX to be back on its own table (2 s at most)');
    await sleep(150);
    expect(existsSync(K.lock)).toBe(true);
    fk.say('state playing');
    await until(() => !existsSync(K.lock));
    await until(() => K.mh.status().locked === false);
    expect(K.lines).toContain('stream3d: the table is unlocked (VPX is back on its own table)');
    // The host now waits and watches Krobs in 3D; Chuck stays in theater.
    await fh.next(/^watch 127\.0\.0\.1:\d+$/);
    fh.say('state watching');
    await until(() => watching(H) === K.id());
    await until(() => H.modes.at(-1) === 'hidden');
    expect(H.modes).not.toContain('theater');
    expect(existsSync(H.lock)).toBe(true);
    expect(C.modes.at(-1)).toBe('theater');

    // ---- the turn goes to Chuck: both forks are on their own tables, both headsets in theater (the 2D video) ----
    await endBall(K, 1, 900);
    await until(() => playerUp(H) === C.id() && playerUp(K) === C.id());
    await fh.next('play');
    fh.say('state playing');
    await until(() => H.modes.at(-1) === 'theater' && K.modes.at(-1) === 'theater');
    expect(watching(H)).toBeNull();
    expect(watching(K)).toBeNull();
    // Krobs's fork was on its own table already: nothing more was sent to it.
    expect(fk.count('play')).toBe(1);
    // Chuck is up and plays on a table that is unlocked at once: no fork to wait for.
    await until(() => up(C));
    expect(existsSync(C.lock)).toBe(false);

    // ---- ball 2, the host again: unlocked at once (its fork is on its own table), Krobs watches in 3D again ----
    await endBall(C, 1, 800);
    await until(() => up(H, 2));
    expect(existsSync(H.lock)).toBe(false);
    await until(() => fk.count('watch') === 2);
    fk.say('state watching');
    await until(() => watching(K) === H.id() && K.modes.at(-1) === 'hidden');

    // ---- the setting: off on Krobs's PC: its fork is called back, the theater shows the 2D video, the line says why ----
    K.mh.setSettings({ watch3d: 'off' });
    await until(() => fk.count('play') === 2);
    fk.say('state playing');
    await until(() => K.modes.at(-1) === 'theater');
    expect(lineFor(K, H)).toBe('Hosty: the 2D video (3D watch is turned off on this PC)');
    expect(K.mh.status().settings.watch3d).toBe('off');
    expect(await K.mh.tableLaunch()).toBeNull();
    // The others still watch Krobs in 3D: off is for one PC.
    expect(lineFor(H, K)).toBe('Krobs: 3D, on your own table');

    // The tunnel is told a roster only when it changes (its end reports a change on every call; the match host
    // syncs on every status): twice for the host here, once per joiner.
    expect(H.tunnel()?.setPeersCalls).toBe(2);

    // ---- leaving: the fork is left on its own table, the lock is off, the stream's connections are closed ----
    K.mh.setSettings({ watch3d: 'auto' });
    await until(() => fk.count('watch') === 3);
    fk.say('state watching');
    await until(() => watching(K) === H.id());
    const left = await K.mh.leave();
    expect(left).toMatchObject({ role: 'none', stream3d: null, locked: false });
    expect(existsSync(K.lock)).toBe(false);
    await until(() => fk.count('play') === 3);
    expect(fk.closed).toBe(false);
    await until(() => lineFor(H, K) === '' || lineFor(H, K).includes('not up yet'));
  }, 40_000);

  it('a watch that fails falls back to theater at once, and the same player under a new grant (shoot again) is tried again (A5); a lock is lifted after the 2 s limit when the fork never answers', async () => {
    const hub = new TunnelHub();
    const {
      seats: [H, K],
      forks: { Hosty: fh, Krobs: fk },
    } = (await lobby(hub, [['Hosty'], ['Krobs']], { manual: ['Hosty', 'Krobs'] })) as { seats: [Seat, Seat]; forks: Record<string, Fork> };
    await H.mh.start();
    await until(() => playerUp(K) === H.id());
    // Krobs's fork refuses the stream: theater with the 2D video for this turn.
    await fk!.next(/^watch /);
    await until(() => K.modes.at(-1) === 'hidden');
    fk!.say('state failed refused: table mismatch', 'state playing');
    await until(() => K.modes.at(-1) === 'theater');
    expect(lineFor(K, H)).toBe('Hosty: the 2D video this turn (3D did not start: refused: table mismatch)');
    expect(K.lines).toContain('stream3d: 3D watch of Hosty did not work (refused: table mismatch); the 2D video serves this turn');
    // Nothing is tried again while the same grant stands.
    await sleep(200);
    expect(fk!.count('watch')).toBe(1);

    // The host's ball 1 ends with an extra ball pending: the same player is up again, under a new grant. Tried again.
    await endBall(H, 1, 1000, true);
    await until(() => fk!.count('watch') === 2, 8000, 'the second watch after the shoot-again grant');
    fk!.say('state watching');
    await until(() => watching(K) === H.id() && K.modes.at(-1) === 'hidden');
    expect(lineFor(K, H)).toBe('Hosty: 3D, on your own table');

    // Krobs's own turn: its fork answers, the lock goes with the answer.
    await endBall(H, 1, 1500);
    await fk!.next('play');
    fk!.say('state playing');
    await until(() => up(K) && !existsSync(K.lock));
    // The host watches Krobs; at the host's next turn its fork never says `state playing`: unlocked after 2 s, logged.
    await fh!.next(/^watch /);
    fh!.say('state watching');
    await until(() => watching(H) === K.id());
    await endBall(K, 1, 900);
    await fh!.next('play');
    await until(() => up(H));
    const t0 = Date.now();
    expect(existsSync(H.lock)).toBe(true);
    await until(() => !existsSync(H.lock), 5000, 'the lock to go after the limit');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1500);
    expect(H.lines.some((l) => l.startsWith('stream3d: VPX has not said "state playing" 2 s after the turn came to this PC'))).toBe(true);
    expect(H.lines).toContain('stream3d: the table is unlocked (VPX did not answer within 2 s)');
  }, 40_000);

  it('a pause, and the restart-and-rejoin of the player who was up: nobody is watched during the pause, and after the resume both the others and the restarted PC are back in 3D', async () => {
    const hub = new TunnelHub();
    const {
      seats: [H, K, C],
      forks: { Hosty: fh, Krobs: fk },
    } = (await lobby(hub, [['Hosty'], ['Krobs'], ['Chuck']])) as { seats: [Seat, Seat, Seat]; forks: Record<string, Fork> };
    await H.mh.start();
    await endBall(H, 1, 1000);
    await endBall(K, 1, 900);
    // Chuck is up; the host and Krobs watch him in 3D.
    await until(() => up(C) && sees(H, fh, C) && sees(K, fk, C), 8000, 'both to watch Chuck');
    await until(() => H.modes.at(-1) === 'hidden' && K.modes.at(-1) === 'hidden');
    const before = { h: fh!.count('watch'), k: fk!.count('watch'), hp: fh!.count('play'), kp: fk!.count('play') };
    const control = await C.stream3d.controlPort();
    const chuck = C.id();

    // Chuck's Castcade closes in the middle of his ball (his VPX stays open, his table his own).
    await crash(C);
    await until(() => H.mh.status().phase === 'paused' && K.mh.status().phase === 'paused', 8000, 'the pause');
    // A pause gives nobody to watch: both forks are called back, the headsets show the panel that says why.
    await until(() => fh!.count('play') === before.hp + 1 && fk!.count('play') === before.kp + 1, 8000, 'both forks called back in the pause');
    await until(() => watching(H) === null && watching(K) === null);
    expect(H.modes.at(-1)).toBe('panel');
    expect(K.modes.at(-1)).toBe('panel');
    // Their tables stay locked: it is still Chuck's ball.
    expect(existsSync(H.lock)).toBe(true);
    expect(existsSync(K.lock)).toBe(true);
    expect(view(K)?.players.find((p) => p.id === chuck)?.line).toBe('Chuck: the 2D video (the 3D connection to their PC is not up yet)');

    // Castcade starts again on Chuck's PC: the same control port (the ports file), so the open table's fork is back.
    const C2 = seat(hub, 'Chuck', { again: C });
    expect(await C2.stream3d.controlPort()).toBe(control);
    await forkOf(C2);
    C2.t.castcadeStarts();
    await C2.mh.rejoin();
    await until(() => [H, K, C2].every((s) => s.mh.status().phase === 'playing'), 15_000, 'the resume');
    // The grant is issued again: the others are sent to watch Chuck again, over a data connection made anew.
    // (Once or twice each: the resume shows the old grant for a moment before the host issues it again.)
    await until(() => sees(H, fh, C2) && sees(K, fk, C2) && fh!.count('watch') > before.h && fk!.count('watch') > before.k, 10_000, 'both to watch Chuck again');
    await until(() => K.modes.at(-1) === 'hidden');
    // Chuck plays on: his table kept its keys through the restart, and nothing was sent to his fork.
    await until(() => up(C2));
    expect(existsSync(C2.lock)).toBe(false);
    expect(view(C2)).toMatchObject({ fork: 'ready', watching: null });
    // And the restarted PC watches too, when its ball is over.
    await endBall(C2, 1, 800);
    await until(() => up(H, 2) && watching(C2) === H.id(), 8000, 'the restarted PC to watch the host');
  }, 60_000);

  it("A18: a client that loses the match for a moment in the host's ball (ArcAid drops the host) and reconnects by itself: it watches the host in 3D all the while; no pause, and its fork is never called back", async () => {
    const r = await startFakeRelay({ devices: { 'dev-Hosty': 'tok-h', 'dev-Krobs': 'tok-k' } });
    relays.push(r);
    const paired = (name: string, token: string): Partial<Opts> => ({ relay: () => ({ baseUrl: r.url, deviceId: `dev-${name}`, deviceToken: token }), relayTimeouts: { connectMs: 1500, ackMs: 1500 } });
    const hub = new TunnelHub();
    const {
      seats: [H, K],
      forks: { Krobs: fk },
    } = (await lobby(hub, [
      ['Hosty', { extra: paired('Hosty', 'tok-h') }],
      ['Krobs', { extra: paired('Krobs', 'tok-k') }],
    ])) as { seats: [Seat, Seat]; forks: Record<string, Fork> };
    expect(K.mh.status().via).toBe('relay');
    await H.mh.start();
    await until(() => sees(K, fk, H));
    const before = { play: fk!.count('play'), watch: fk!.count('watch') };
    const krobsAway = (): boolean => (H.mh.status().panel?.players.find((p) => p.name === 'Krobs')?.flags ?? []).includes('disconnected');
    const phases: string[] = [];
    const offs = [H.mh.onStatus((s) => phases.push(s.phase)), K.mh.onStatus((s) => phases.push(s.phase))];
    r.dropDevice('dev-Hosty');
    // With no grace in this harness the host does show Krobs as away for the moment; then Krobs is back by itself
    // (RECONNECT). The host's ball was live throughout: nothing was paused and no grant was issued again.
    await until(() => krobsAway(), 8000, 'the drop to be seen');
    await until(() => !krobsAway() && !(K.mh.status().panel?.message ?? '').startsWith('The link to the host'), 12_000, 'Krobs to be back');
    for (const off of offs) off();
    expect(phases).not.toContain('paused');
    // The 3D watch runs over the two companions' own connection: it never stopped.
    expect(sees(K, fk, H)).toBe(true);
    expect({ play: fk!.count('play'), watch: fk!.count('watch') }).toEqual(before);
    expect(K.modes.at(-1)).toBe('hidden');
    expect(existsSync(K.lock)).toBe(true);
    // The data connection between the companions never went through ArcAid: it is the same one.
    expect(hub.all).toHaveLength(2);
  }, 40_000);

  it('A17 step 4 (2026-11-24): a pause for the player up keeps the 3D watch; the re-issued grant does not start it over; no picture: the panel', async () => {
    const r = await startFakeRelay({ devices: { 'dev-Hosty': 'tok-h', 'dev-Krobs': 'tok-k' } });
    relays.push(r);
    const paired = (name: string, token: string): Partial<Opts> => ({ relay: () => ({ baseUrl: r.url, deviceId: `dev-${name}`, deviceToken: token }), relayTimeouts: { connectMs: 1500, ackMs: 1500 }, upAwayPictureMs: 400 });
    const hub = new TunnelHub();
    const {
      seats: [H, K],
      forks: { Hosty: fh },
    } = (await lobby(hub, [
      ['Hosty', { extra: paired('Hosty', 'tok-h') }],
      ['Krobs', { extra: paired('Krobs', 'tok-k') }],
    ])) as { seats: [Seat, Seat]; forks: Record<string, Fork> };
    await H.mh.start();
    await endBall(H, 1, 1000);
    // Krobs is up; the host watches him in 3D, its headset showing nothing over the table.
    await until(() => up(K, 1) && sees(H, fh, K) && H.modes.at(-1) === 'hidden', 8000, 'the host to watch Krobs in 3D');
    const before = { play: fh!.count('play'), watch: fh!.count('watch'), modes: H.modes.length };
    // Every status of the host from here on: the phase, who the pause is for, who it watches, what the headset shows.
    const seen: Array<{ phase: string; pausedFor: string | null; watching: string | null; mode: string | undefined }> = [];
    const off = H.mh.onStatus((s) => seen.push({ phase: s.phase, pausedFor: s.panel?.pausedFor ?? null, watching: s.stream3d?.watching ?? null, mode: H.modes.at(-1) }));

    // ---- Krobs' link to the host drops in the middle of his ball (ArcAid loses him), and he is back by himself ----
    r.dropDevice('dev-Krobs');
    await until(() => seen.some((x) => x.phase === 'paused'), 8000, 'the pause for Krobs');
    await until(() => H.mh.status().phase === 'playing' && K.mh.status().phase === 'playing' && up(K, 1), 15_000, 'the resume');
    // The pause was for the player who is up, and the grant was issued again after his RESUME.
    const paused = seen.filter((x) => x.phase === 'paused');
    expect(paused.length).toBeGreaterThan(0);
    expect(paused.every((x) => x.pausedFor === K.id())).toBe(true);
    // All through it the host went on watching Krobs' table in 3D: its fork was not called back at the pause and not
    // sent to watch again at the re-issued grant, and its headset never showed the panel.
    expect(seen.every((x) => x.watching === K.id())).toBe(true);
    expect({ play: fh!.count('play'), watch: fh!.count('watch') }).toEqual({ play: before.play, watch: before.watch });
    expect(H.modes.slice(before.modes)).toEqual([]);
    expect(sees(H, fh, K)).toBe(true);
    // Its table stayed locked (it is still Krobs' ball), and the data connection is the one made in the lobby.
    expect(existsSync(H.lock)).toBe(true);
    expect(hub.all).toHaveLength(2);

    // ---- no picture: the panel ----
    // Krobs is gone from the match for good this time (his pairing is revoked: he cannot come back), still playing:
    // the pause stands, and the host keeps watching for as long as his stream arrives.
    seen.length = 0;
    r.revoke('dev-Krobs');
    r.dropDevice('dev-Krobs');
    await until(() => H.mh.status().phase === 'paused', 8000, 'the standing pause');
    expect(H.mh.status().panel).toMatchObject({ phase: 'paused', pausedFor: K.id(), playerUp: K.id(), ball: 1 });
    await sleep(900); // more than twice the time a missing picture is given
    expect(watching(H)).toBe(K.id());
    expect(H.modes.slice(before.modes)).toEqual([]);
    expect(fh!.count('play')).toBe(before.play);
    // His stream stops (his Castcade closes): the fork is called back, and with no 2D picture arriving either the
    // panel comes, as at any pause before.
    await K.stream3d.stop();
    await until(() => fh!.count('play') === before.play + 1 && watching(H) === null, 8000, 'the fork called back');
    await until(() => H.modes.at(-1) === 'panel', 4000, 'the panel');
    expect(H.modes.slice(before.modes)).toEqual(['panel']);
    // The log of the night has one line for each pause in which the picture was kept, and one for its end here.
    expect(H.lines.filter((l) => l.includes('their picture still arrives on this PC, so what this PC shows of their table stays'))).toHaveLength(2);
    expect(H.lines.filter((l) => l === "match: Krobs's picture no longer arrives on this PC (the match is still paused for them): the panel now")).toHaveLength(1);
    expect(existsSync(H.lock)).toBe(true);
    off();
  }, 60_000);

  it("A17 step 4 (the review of PR 131): a ball ended by hand in a 3D match: the fork holds that ball while the other player is watched and puts it back at the next grant; it is played out first under that grant, its drain reports nothing, and the ball after it is ball 2", async () => {
    const hub = new TunnelHub();
    const {
      seats: [H, K],
      forks: { Hosty: fh, Krobs: fk },
    } = (await lobby(hub, [['Hosty'], ['Krobs']])) as { seats: [Seat, Seat]; forks: Record<string, Fork> };
    const krobs = (): { score: number | null; ballsDone: number } | undefined => H.mh.status().panel?.players.find((p) => p.name === 'Krobs');
    await H.mh.start();
    await endBall(H, 1, 1000);
    await until(() => up(K, 1) && sees(H, fh, K), 8000, 'the host to watch Krobs in 3D');
    // Krobs plays his own table, and ends the ball by hand with it still in play.
    K.t.gameStart();
    K.t.score(1, 1200);
    await until(() => K.mh.status().endBall?.score === 1200, 8000, "Krobs' score");
    expect(K.mh.status().endBall).toMatchObject({ ball: 1, score: 1200, tableBall: true });
    await K.mh.endMyBall(K.mh.status().endBall!.grantSeq);
    // The host is up: Krobs' fork pauses his own game (the ball with it) and shows the host's table. Nothing drains.
    await until(() => up(H, 2) && sees(K, fk, H), 8000, 'Krobs to watch the host in 3D');
    await endBall(H, 2, 2000);
    // Krobs' grant for ball 2: the fork puts his own game back, the old ball where it was.
    await until(() => up(K, 2) && watching(K) === null && fk!.got.at(-1) === 'play', 8000, "Krobs' own game back for his ball 2");
    expect(K.mh.status().panel?.message).toBe('Your last ball is still on the table: play it out, then ball 2 begins');
    await until(() => sees(H, fh, K), 8000, 'the host to watch Krobs again');
    // He plays it out: the points count as they come, and its drain is the end of nothing in the match.
    K.t.score(1, 1700);
    await until(() => krobs()?.score === 1700, 8000, 'the old ball\'s points');
    K.t.drain(1);
    K.t.score(1, 1750);
    await until(() => K.lines.some((l) => l.startsWith('match: the ball that was ended by hand has ended on the table: nothing is reported for it')), 8000, 'the drain to be swallowed');
    await sleep(300);
    expect(up(K, 2)).toBe(true);
    expect(existsSync(K.lock)).toBe(false);
    expect(sees(H, fh, K)).toBe(true);
    expect(krobs()).toMatchObject({ ballsDone: 1 });
    expect(K.mh.status().panel?.message ?? '').not.toContain('still on the table');
    expect(K.lines.filter((l) => l.includes('BALL_END ball'))).toEqual(['match: BALL_END ball 1 score 1200 (ended by hand: End my ball)']);
    // The table's next ball is ball 2 of the match.
    await endBall(K, 2, 2600);
    await until(() => up(H, 3), 8000, "the host's ball 3");
    expect(krobs()).toMatchObject({ score: 2600, ballsDone: 2 });
    expect(K.lines.filter((l) => l.includes('BALL_END ball'))).toEqual(['match: BALL_END ball 1 score 1200 (ended by hand: End my ball)', 'match: BALL_END ball 2 score 2600']);
  }, 40_000);

  it('the initials hold (A16.2): a player whose finished game is on the high-score list keeps their own table; their fork is not sent to watch', async () => {
    const hub = new TunnelHub();
    const {
      seats: [H, K],
      forks: { Hosty: fh },
    } = (await lobby(hub, [['Hosty', { qualifies: true }], ['Krobs']])) as { seats: [Seat, Seat]; forks: Record<string, Fork> };
    await H.mh.start();
    for (const ball of [1, 2]) {
      await endBall(H, ball, 1000 * ball);
      await until(() => sees(H, fh, K), 8000, `the host to watch Krobs's ball ${ball}`);
      await endBall(K, ball, 900 * ball);
    }
    const watches = fh!.count('watch');
    expect(watches).toBe(2);
    // The host's last ball puts its score on the machine's list: Krobs is up, and the host's table is held for the initials.
    await endBall(H, 3, 5000);
    await until(() => up(K, 3));
    await until(() => H.lines.some((l) => l.startsWith('match: initials hold on')));
    await sleep(300);
    expect(fh!.count('watch')).toBe(watches);
    expect(watching(H)).toBeNull();
    expect(view(H)).toMatchObject({ fork: 'ready' });
    // Unlocked, and the headset on its own table (never the other player's picture): what A16.2 asks for.
    expect(existsSync(H.lock)).toBe(false);
    expect(H.modes.at(-1)).toBe('hidden');
    expect(H.mh.status().panel).toMatchObject({ phase: 'playing', myTurn: false });
    // 3D for Krobs is still what this PC would show: it just has nobody to watch while it holds its table.
    expect(lineFor(H, K)).toBe('Krobs: 3D, on your own table');
  }, 40_000);

  it('a finished game still ending on the machine (A16): the fork stays on its own table until the game end, with the 2D theater as before; then it watches', async () => {
    const hub = new TunnelHub();
    const {
      seats: [H, K],
      forks: { Hosty: fh },
    } = (await lobby(hub, [['Hosty'], ['Krobs']])) as { seats: [Seat, Seat]; forks: Record<string, Fork> };
    await H.mh.start();
    await until(() => up(H, 1));
    // The machine's own game: started with the host's first ball, and still running after its third.
    H.t.gameStart();
    for (const ball of [1, 2]) {
      await endBall(H, ball, 1000 * ball);
      await until(() => sees(H, fh, K));
      await endBall(K, ball, 900 * ball);
    }
    const watches = fh!.count('watch');
    await endBall(H, 3, 3000);
    await until(() => up(K, 3));
    await until(() => H.lines.some((l) => l.includes("my game is done and the table's own game is still on")));
    await sleep(300);
    // The bonus, the match animation: the ROM runs on, unlocked; the pause of a watch would freeze it before its game end.
    expect(fh!.count('watch')).toBe(watches);
    expect(watching(H)).toBeNull();
    expect(existsSync(H.lock)).toBe(false);
    expect(H.modes.at(-1)).toBe('theater');
    // The machine's game ends: the table locks, and now the fork is sent to Krobs's table.
    H.t.gameEnd(3000);
    await until(() => fh!.count('watch') === watches + 1 && watching(H) === K.id(), 8000, 'the watch after the game end');
    expect(existsSync(H.lock)).toBe(true);
    await until(() => H.modes.at(-1) === 'hidden');
  }, 40_000);

  it('the result, the next game and the end of the series: nobody is watched between games; the next game is watched as the first was; End match leaves every fork on its own table and every table unlocked', async () => {
    const hub = new TunnelHub();
    const {
      seats: [H, K],
      forks: { Hosty: fh, Krobs: fk },
    } = (await lobby(hub, [['Hosty'], ['Krobs']])) as { seats: [Seat, Seat]; forks: Record<string, Fork> };
    await H.mh.start();
    for (const ball of [1, 2, 3]) {
      await endBall(H, ball, 1000 * ball);
      await endBall(K, ball, 900 * ball);
    }
    await until(() => H.mh.status().phase === 'over' && K.mh.status().phase === 'over');
    // The result: the host (who watched Krobs's last ball) is called back; nobody watches anybody.
    await until(() => watching(H) === null && watching(K) === null && fh!.count('play') === fh!.count('watch') && fk!.count('play') === fk!.count('watch'), 8000, `both forks on their own tables at the result (host ${JSON.stringify(fh!.got)}, Krobs ${JSON.stringify(fk!.got)}, ${String(watching(H))} ${String(watching(K))})`);
    expect(H.modes.at(-1)).toBe('panel');
    expect(K.modes.at(-1)).toBe('panel');
    // The host's table is free for the next game (once its fork is back on it); the client's stays locked until its ball.
    await until(() => !existsSync(H.lock), 4000, "the host's table to be unlocked at the result");
    expect(existsSync(K.lock)).toBe(true);
    const watched = fk!.count('watch');

    // NEXT_GAME: the host is up on ball 1 of game 2, and Krobs watches in 3D as in game 1.
    await H.mh.start();
    await until(() => K.mh.status().series?.game === 2 && watching(K) === H.id() && fk!.count('watch') === watched + 1, 8000, 'Krobs to watch game 2');
    expect(K.modes.at(-1)).toBe('hidden');
    await endBall(H, 1, 500);
    await until(() => up(K) && !existsSync(K.lock) && watching(H) === K.id());
    await endBall(K, 1, 400);
    for (const ball of [2, 3]) {
      await endBall(H, ball, 500 * ball);
      await endBall(K, ball, 400 * ball);
    }
    await until(() => H.mh.status().phase === 'over' && K.mh.status().phase === 'over' && watching(H) === null && watching(K) === null);

    // End match (the host leaves between games): the series is over, every fork is on its own table, every table free.
    await H.mh.leave();
    expect(existsSync(H.lock)).toBe(false);
    await until(() => K.mh.status().series?.over === true);
    expect(existsSync(K.lock)).toBe(false);
    expect(watching(K)).toBeNull();
    await until(() => fh!.count('play') === fh!.count('watch') && fk!.count('play') === fk!.count('watch'), 4000, 'every watch to have been followed by a play');
    expect(fh!.closed).toBe(false);
    expect(fk!.closed).toBe(false);
  }, 60_000);

  it('the host vanishes while this PC watches it: the fork is called back, the theater is not left over a dead stream, and when the wait is over the table is free', async () => {
    const hub = new TunnelHub();
    const {
      seats: [H, K],
      forks: { Krobs: fk },
    } = (await lobby(hub, [['Hosty'], ['Krobs', { extra: { hostWaitMs: 2500, seriesOverLingerMs: 300 } }]])) as { seats: [Seat, Seat]; forks: Record<string, Fork> };
    await H.mh.start();
    await until(() => sees(K, fk, H) && K.modes.at(-1) === 'hidden');
    await crash(H);
    // The host's tunnel closed with it: nothing is known of its VPX any more, so there is no 3D to show.
    await until(() => fk!.count('play') === 1 && watching(K) === null, 8000, "Krobs's fork to be called back");
    // A17 step 7: the lobby's PC is away, said in the lobby's words (design 11.8a), with how long it is waited for.
    await until(() => (K.mh.status().panel?.message ?? '').startsWith("Hosty's PC is away. The match goes on when it is back"));
    expect(K.modes.at(-1)).not.toBe('hidden');
    expect(existsSync(K.lock)).toBe(true);
    // The wait runs out: the lobby is over for this PC (it says so for a moment), its table unlocked, its stream
    // closed, its fork still connected.
    await until(() => K.mh.status().role === 'none', 15_000, 'the lobby to end for Krobs');
    expect(K.mh.status().lastError).toMatch(/^The lobby is closed: /);
    expect(existsSync(K.lock)).toBe(false);
    expect(K.mh.status().stream3d).toBeNull();
    expect(K.tunnel()?.closed).toBe(true);
    expect(fk!.closed).toBe(false);
    expect(fk!.count('play')).toBe(1);
  }, 40_000);

  it('leaving with an unlock pending: the table is unlocked at once, not when the fork answers or the 2 s pass, and nothing fires later', async () => {
    const hub = new TunnelHub();
    const {
      seats: [H, K],
      forks: { Krobs: fk },
    } = (await lobby(hub, [['Hosty'], ['Krobs']], { manual: ['Krobs'] })) as { seats: [Seat, Seat]; forks: Record<string, Fork> };
    await H.mh.start();
    await fk!.next(/^watch /);
    fk!.say('state watching');
    await until(() => watching(K) === H.id());
    await endBall(H, 1, 1000);
    // Krobs's turn: the fork is called back and says nothing; the lock waits.
    await fk!.next('play');
    await until(() => up(K) && K.lines.includes('stream3d: the table is to be unlocked; waiting for VPX to be back on its own table (2 s at most)'));
    expect(existsSync(K.lock)).toBe(true);
    const t0 = Date.now();
    const left = await K.mh.leave();
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(left).toMatchObject({ role: 'none', locked: false });
    expect(existsSync(K.lock)).toBe(false);
    const lines = K.lines.length;
    // The fork's late answer, and the 2 s that were running: nothing comes of either.
    fk!.say('state playing');
    await sleep(2300);
    expect(existsSync(K.lock)).toBe(false);
    expect(K.mh.status()).toMatchObject({ role: 'none', locked: false });
    expect(K.lines.slice(lines).filter((l) => l.includes('unlocked'))).toEqual([]);
  }, 40_000);

  it('a player who leaves while the others watch them: every fork is called back, nobody is shown in 3D any more, and the match goes on', async () => {
    const hub = new TunnelHub();
    const {
      seats: [H, K, C],
      forks: { Hosty: fh, Chuck: fc },
    } = (await lobby(hub, [['Hosty'], ['Krobs'], ['Chuck']])) as { seats: [Seat, Seat, Seat]; forks: Record<string, Fork> };
    await H.mh.start();
    await endBall(H, 1, 1000);
    await until(() => up(K) && sees(H, fh, K) && sees(C, fc, K), 8000, 'both to watch Krobs');
    const krobs = K.id();
    const before = { hw: fh!.count('watch'), hp: fh!.count('play'), cp: fc!.count('play') };
    await K.mh.leave();
    // Krobs forfeited: the turn is Chuck's. Chuck's fork is called back to its own table, and his lock goes with its
    // answer; the host's fork is re-aimed from Krobs to Chuck (a watch, with no play between: rule 11).
    await until(() => fc!.count('play') === before.cp + 1, 8000, "Chuck's fork to be called back");
    await until(() => up(C) && !existsSync(C.lock) && watching(H) === C.id(), 8000, 'the match to go on with Chuck up');
    await until(() => fh!.count('watch') === before.hw + 1);
    expect(fh!.count('play')).toBe(before.hp);
    expect(watching(C)).toBeNull();
    // Nothing is known of Krobs's VPX any more: the tunnel to that PC closed with its match.
    expect(view(H)?.players.find((p) => p.id === krobs)?.mode ?? '2d').toBe('2d');
    expect(view(C)?.players.find((p) => p.id === krobs)?.mode ?? '2d').toBe('2d');
  }, 40_000);

  it('a desktop PC (A2): while its VPX shows the player up in 3D the native video window is not shown; it is back the moment 3D falls back', async () => {
    const hub = new TunnelHub();
    const {
      seats: [H, K],
      forks: { Krobs: fk },
    } = (await lobby(hub, [['Hosty'], ['Krobs', { rig: 'pc', video: true }]], { manual: ['Krobs'] })) as { seats: [Seat, Seat]; forks: Record<string, Fork> };
    expect(K.mh.status().rig).toBe('pc');
    // The lobby: the picture of whoever is up goes to the helper's own window.
    expect(K.sinks().at(-1)).toBe('window');
    await H.mh.start();
    await fk!.next(/^watch /);
    // From the decision on: no window over the table.
    await until(() => K.sinks().at(-1) === 'none', 5000, 'the window sink to go');
    expect(K.mh.status().media?.nativeVideo?.sink).toBe('none');
    fk!.say('state watching');
    await until(() => watching(K) === H.id());
    expect(K.sinks().at(-1)).toBe('none');
    // The stream stalls (rule 12): the 2D picture is back at once.
    fk!.say('state failed stalled', 'state playing');
    await until(() => K.sinks().at(-1) === 'window', 5000, 'the window sink to come back');
    expect(K.sinks().filter((x) => x !== 'window' && x !== 'none')).toEqual([]);
    // Its own turn (the fork is on its own table already: nothing is sent, the lock goes at once), then the host's
    // next: 3D again, the window gone again.
    await endBall(H, 1, 1000);
    await until(() => up(K) && !existsSync(K.lock));
    expect(fk!.count('play')).toBe(0);
    await endBall(K, 1, 900);
    await until(() => fk!.count('watch') === 2);
    await until(() => K.sinks().at(-1) === 'none');
    // Leaving closes the mesh: the sink is cleared as ever.
    await K.mh.leave();
    expect(K.mh.status().stream3d).toBeNull();
  }, 40_000);

  it('a headset set to show the panel on the other player\'s ball keeps the panel while the table shows them in 3D', async () => {
    const hub = new TunnelHub();
    const {
      seats: [H, K],
      forks: { Krobs: fk },
    } = (await lobby(hub, [['Hosty'], ['Krobs']])) as { seats: [Seat, Seat]; forks: Record<string, Fork> };
    K.mh.setSettings({ spectate: 'panel' });
    const from = K.modes.length;
    await H.mh.start();
    await until(() => watching(K) === H.id());
    await until(() => K.modes.at(-1) === 'panel');
    // The fork watches; the headset is neither in theater nor emptied: the player asked for the panel.
    await until(() => fk!.count('watch') === 1);
    expect(K.modes.slice(from)).not.toContain('theater');
    expect(K.modes.slice(from)).not.toContain('hidden');
    // Back to theater on the Match tab while watching: no theater picture, as for anyone watching in 3D.
    K.mh.setSettings({ spectate: 'theater' });
    await until(() => K.modes.at(-1) === 'hidden');
    expect(fk!.count('watch')).toBe(1);
  }, 40_000);

  it("D6: a PC with 3D watch off and no fork opens no tunnel; the tunnel's reports do not make the match host send its status", async () => {
    const hub = new TunnelHub();
    const H = seat(hub, 'Hosty');
    const K = seat(hub, 'Krobs', { fork: false });
    K.mh.setSettings({ watch3d: 'off' });
    const hs = await H.mh.host({ port: 0, ballsPerGame: 3, displayName: 'Hosty' });
    await K.mh.join(hs.invite!, 'Krobs');
    await until(() => H.mh.status().participants.length === 2 && K.mh.status().participants.length === 2);
    await forkOf(H);
    await sleep(100);
    // Only the host's end exists: Krobs's PC has no use for one.
    expect(hub.all.map((t) => t.id)).toEqual([H.id()]);
    expect(lineFor(K, H)).toBe('Hosty: the 2D video (3D watch is turned off on this PC)');
    expect(K.lines).toContain('stream3d: no data connections are opened on this PC: 3D watch is off and no Castcade VPX build is on the control port (they open if either changes)');
    // The host's tunnel reports a round-trip time every 2 s per peer: none of it is a new match status.
    let statuses = 0;
    H.mh.onStatus(() => void statuses++);
    for (let i = 0; i < 20; i++) {
      H.tunnel()?.report();
      await sleep(2);
    }
    expect(statuses).toBe(0);
    // The setting turned on during the lobby: the tunnel opens, and both sides know of each other.
    K.mh.setSettings({ watch3d: 'auto' });
    await until(() => hub.open(H.id(), K.id()), 5000, 'the data connection after the setting changed');
    await until(() => lineFor(H, K) === 'Krobs: the 2D video (no Castcade VPX build runs the table on their PC)');
    expect(lineFor(K, H)).toBe('Hosty: the 2D video (no Castcade VPX build runs the table on this PC)');
  }, 40_000);
});

describe('the first turn starts in 3D (I11.4.9)', () => {
  const message = (s: Seat): string => s.mh.status().panel?.message ?? '';
  /** Host and one client in the lobby, both tables started in the fork and both forks ready, the data connection still being made. */
  async function slowLobby(o: { startWaitMs?: number } = {}): Promise<{ hub: TunnelHub; H: Seat; K: Seat; fh: Fork; fk: Fork }> {
    const hub = new TunnelHub();
    hub.hold();
    const H = seat(hub, 'Hosty', o);
    const K = seat(hub, 'Krobs', o);
    const hs = await H.mh.host({ port: 0, ballsPerGame: 3, displayName: 'Hosty' });
    await K.mh.join(hs.invite!, 'Krobs');
    await until(() => H.mh.status().participants.length === 2 && K.mh.status().participants.length === 2, 8000, 'both in the lobby');
    await H.mh.tableLaunch();
    await K.mh.tableLaunch();
    const fh = await forkOf(H);
    const fk = await forkOf(K);
    await until(() => view(H)?.fork === 'ready' && view(K)?.fork === 'ready', 5000, 'both forks ready');
    return { hub, H, K, fh, fk };
  }

  it('a start from the table waits for the data connection, every lobby says so, and when it is up the countdown runs and the first turn is watched in 3D from its first moment', async () => {
    const { hub, H, K, fk } = await slowLobby();
    // Each PC told the host it is still connecting, and wrote why to its log.
    await until(() => H.mh.status().wait3d.players.length === 2 && K.mh.status().wait3d.players.length === 2, 5000, 'both PCs listed as waited for');
    expect(H.lines.some((l) => /^stream3d: the match's start waits for the 3D connection to Krobs: nothing heard from that PC yet \(4[345] s at most\)$/.test(l))).toBe(true);
    // What each PC sent is logged as sent (what the other end does with it is its own affair).
    expect(H.lines.some((l) => /^stream3d: sent to the players: this PC's 3D connection is still being made, 4[345] s at most \(stream3dWaitMs \d+\)$/.test(l))).toBe(true);
    expect(K.lines.some((l) => /^stream3d: sent to the host: this PC's 3D connection is still being made, 4[345] s at most \(stream3dWaitMs \d+\)$/.test(l))).toBe(true);
    expect(lineFor(K, H)).toBe('Hosty: the 2D video (the 3D connection to their PC is not up yet)');

    // The host starts a game on its table: no countdown; every panel says who asked, what is waited for and for how
    // long at most. A17 step 7: the start waits in the lobby's PC (`lobby.start`), announced to everyone; it was an
    // armed start of the host's own controller, and the client only read that a start would wait.
    H.t.gameStart();
    await until(() => H.mh.status().lobby?.start?.waitsFor === '3d' && K.mh.status().lobby?.start?.waitsFor === '3d', 5000, 'the start that waits for 3D, on both PCs');
    expect(message(H)).toBe('You start the match once the 3D connection to Krobs is up (45 s at most; started without it, the first turn may be the 2D video)');
    expect(message(K)).toBe('Hosty starts the match once the 3D connection to Hosty is up (45 s at most; started without it, the first turn may be the 2D video)');
    expect(H.mh.status().lobby?.startWithout).toBe('Start without 3D');
    await sleep(400);
    expect(H.mh.status().phase).toBe('lobby');
    expect(H.mh.status().panel?.countdown ?? null).toBeNull();

    // The data connection comes up: both PCs settle, the countdown of a start from the table runs, and the match starts.
    hub.release();
    await until(() => lineFor(K, H) === 'Hosty: 3D, on your own table' && lineFor(H, K) === 'Krobs: 3D, on your own table', 5000, 'the 3D lines');
    await until(() => H.mh.status().wait3d.players.length === 0, 5000, 'nobody waited for');
    expect(H.lines.some((l) => /^stream3d: the match's start no longer waits for this PC: this PC's 3D connections are settled \(heard from, after this PC's data connections opened: Krobs \d+\.\d s\)$/.test(l))).toBe(true);
    expect(H.lines).toContain("stream3d: sent to the players: this PC's 3D connection is settled (stream3dWaitMs 0)");
    await until(() => K.mh.status().phase === 'playing' || message(H).startsWith('You start the match: you, Krobs'), 5000, 'the countdown');
    expect(fk.got).toEqual([]);
    await until(() => K.mh.status().phase === 'playing' && playerUp(K) === H.id(), 9000, 'the match');
    // The first turn: Krobs' VPX is sent to the host's table at once, and its headset never shows the theater picture.
    await until(() => sees(K, fk, H), 5000, "Krobs' fork watching the host");
    await until(() => K.modes.at(-1) === 'hidden');
    expect(K.modes).not.toContain('theater');
  });

  it('Start match: the first press holds the start; at the limit of the wait it goes on by itself with the 2D video, and the watch begins in the middle of that turn when the connection comes up', async () => {
    const { hub, H, K, fk } = await slowLobby({ startWaitMs: 3000 });
    await until(() => H.mh.status().wait3d.players.length === 2, 5000, 'both PCs listed as waited for');
    const st = await H.mh.start();
    // Held: still the lobby, and the tab offers the second press (A17 step 7: "Start without 3D").
    expect(st.phase).toBe('lobby');
    expect(st.lobby).toMatchObject({ start: { waitsFor: '3d', newMatch: true }, startWithout: 'Start without 3D' });
    expect(message(H)).toBe('You start the match once the 3D connection to Krobs is up (45 s at most; started without it, the first turn may be the 2D video)');
    // 3 s after each PC began connecting to the other they stop waiting, say so, and the start that waited begins:
    // a start like any other (nothing is logged as confirmed by anybody).
    await until(() => K.mh.status().phase === 'playing' && playerUp(K) === H.id(), 9000, 'the match after the limit');
    expect(H.lines).toContain("stream3d: the match's start no longer waits for this PC: 3 s passed since this PC began connecting to Krobs and nothing was heard from that PC: the first turn may be the 2D video");
    expect(H.lines.filter((l) => l.includes('the host confirmed'))).toEqual([]);
    // The first turn begins in 2D on Krobs' PC: theater, nothing sent to its fork.
    await until(() => K.modes.at(-1) === 'theater', 5000, 'theater on the waiting PC');
    expect(lineFor(K, H)).toBe('Hosty: the 2D video (the 3D connection to their PC is not up yet)');
    expect(fk.got).toEqual([]);
    // The connection comes up in the middle of the turn: the same grant, and the fork is sent to watch.
    hub.release();
    await until(() => sees(K, fk, H), 5000, 'the watch in the middle of the turn');
    await until(() => K.modes.at(-1) === 'hidden');
    expect(playerUp(K)).toBe(H.id());
    expect(H.mh.status().panel?.ball).toBe(1);
  });

  it('Start match pressed twice (A17 step 7: the second press is "Start without 3D") starts now, whatever is still connecting', async () => {
    const { H, K } = await slowLobby();
    await until(() => H.mh.status().wait3d.players.length === 2, 5000, 'both PCs listed as waited for');
    expect((await H.mh.start()).phase).toBe('lobby');
    // A press of plain Start while a start is announced changes nothing; the second press says what it gives up.
    await H.mh.start({ now: true });
    await until(() => K.mh.status().phase === 'playing' && H.mh.status().phase === 'playing', 5000, 'the match at the second press');
    expect(H.lines).toContain("stream3d: the match's start no longer waits for this PC: the match started or the lobby is gone, with nothing heard yet from Krobs: they are shown in the 2D video until their PC is heard from");
    expect(H.mh.status().wait3d).toEqual({ players: [], seconds: 0, armed: null });
  });

  it('D3, as a lobby has it (A17 step 7): a player who joins while a start waits, with no table open, is not in that start: it begins with the people it was announced for, nothing is said to have been confirmed, and the newcomer watches', async () => {
    const { hub, H, K } = await slowLobby();
    await until(() => H.mh.status().wait3d.players.length === 2, 5000, 'both PCs listed as waited for');
    expect((await H.mh.start()).phase).toBe('lobby');
    expect(H.mh.status().lobby?.start).toMatchObject({ waitsFor: '3d', players: [H.id(), K.id()] });
    // A third player joins during the hold, with no table open yet and no Castcade VPX build.
    const closed = { ...table().w, status: () => ({ paired: false, currentTable: null, currentIdentity: null, currentAttestation: null, captureMode: 'live', note: null }) } as unknown as WitnessHost;
    const C = seat(hub, 'Chuck', { fork: false, extra: { witness: closed } });
    await C.mh.join(H.mh.status().invite!, 'Chuck');
    await until(() => H.mh.status().participants.length === 3 && H.mh.status().panel?.players.find((x) => x.name === 'Chuck')?.flags.includes('loading') === true, 8000, 'Chuck in the lobby, loading');
    // A start is for the people it was announced with: who joins later comes in at a later start. (Until the lobby
    // a held Start match was the whole roster's, so it was dropped here and the host told why: the newcomer's table
    // was not open, and starting over it would have been a start nobody confirmed.)
    expect(H.mh.status().lobby?.start?.players).toEqual([H.id(), K.id()]);
    // The connection of the two who were waited for comes up: the start counts down and the match is theirs.
    hub.release();
    await until(() => K.mh.status().phase === 'playing' && H.mh.status().phase === 'playing', 8000, 'the match of the two');
    expect(H.mh.status().lobby?.match?.players).toEqual([H.id(), K.id()]);
    expect([...H.lines, ...K.lines].filter((l) => l.includes('confirmed'))).toEqual([]);
    // The newcomer is in the lobby, set to Play, and watches this match.
    await until(() => C.mh.status().phase === 'playing', 5000, 'the newcomer watching');
    expect(C.mh.status().lobby?.members.find((m) => m.me)).toMatchObject({ stance: 'play', inMatch: false });
    expect(C.mh.status().panel?.players.map((x) => x.name)).toEqual(['Hosty', 'Krobs']);
  });

  it('a PC without the Castcade VPX build, and one with 3D watch off, are never waited for: the start is not held', async () => {
    const hub = new TunnelHub();
    hub.hold();
    const H = seat(hub, 'Hosty', { fork: false });
    const K = seat(hub, 'Krobs');
    const hs = await H.mh.host({ port: 0, ballsPerGame: 3, displayName: 'Hosty' });
    await K.mh.join(hs.invite!, 'Krobs');
    await until(() => H.mh.status().participants.length === 2 && K.mh.status().participants.length === 2, 8000, 'both in the lobby');
    await K.mh.setSettings({ watch3d: 'off' });
    expect(await H.mh.tableLaunch()).toBeNull();
    expect(await K.mh.tableLaunch()).toBeNull();
    await sleep(200);
    expect(H.mh.status().wait3d.players).toEqual([]);
    await H.mh.start();
    await until(() => K.mh.status().phase === 'playing', 5000, 'the match');
    expect([...H.lines, ...K.lines].filter((l) => l.includes("the match's start waits"))).toEqual([]);
  });
});

describe('a table that Castcade did not start in the Castcade VPX build (I11.4.12)', () => {
  const message = (s: Seat): string => s.mh.status().panel?.message ?? '';
  const NOTE = 'Not in 3D: this table is not running in the Castcade VPX build. For 3D it has to be started again by Castcade: close VPX, then host or join again';

  it('with the build beside VPX and 3D watch on, a table that is open and not on the control connection is said in the lobby, on the panel line and in the log, and no longer once Castcade has started the table', async () => {
    const hub = new TunnelHub();
    const H = seat(hub, 'Hosty');
    const K = seat(hub, 'Krobs');
    const hs = await H.mh.host({ port: 0, ballsPerGame: 3, displayName: 'Hosty' });
    await K.mh.join(hs.invite!, 'Krobs');
    await until(() => H.mh.status().participants.length === 2 && K.mh.status().participants.length === 2, 8000, 'both in the lobby');
    // Both tables are open (the witness says so) and neither was started by Castcade: nothing is on a control connection.
    await until(() => message(H).endsWith(NOTE) && message(K).endsWith(NOTE), 5000, 'the note on both lobby lines');
    // A17 step 7: the note rides on the lobby's own line (design 11.9: the starter is named).
    expect(message(K)).toBe(`Hosty starts the match from their table. To start it yourself: Start match in the menu · ${NOTE}`);
    expect(K.lines.filter((l) => l.includes('is not running in the Castcade VPX build (opened by hand'))).toHaveLength(1);
    // Krobs closes VPX and lets Castcade start the table: while it loads nothing is said, and nothing when it is up.
    await K.mh.tableLaunch();
    await until(() => !message(K).includes('not running in the Castcade VPX build'), 5000, 'the note gone while the table loads');
    expect(K.lines).toContain('stream3d: the lobby no longer says that the table is not running in the Castcade VPX build (it does not apply any more)');
    await forkOf(K);
    await until(() => view(K)?.fork === 'ready', 5000, "Krobs' fork ready");
    await sleep(100);
    expect(message(K)).not.toContain('not running in the Castcade VPX build');
    // The host's is still open by hand: its line keeps saying so, once in its log.
    expect(message(H).endsWith(NOTE)).toBe(true);
    expect(H.lines.filter((l) => l.includes('is not running in the Castcade VPX build (opened by hand'))).toHaveLength(1);
  });

  it('Castcade itself tried the build for this match and it did not start: the lobby says that 3D is not available on this PC for this match, not to start the table again', async () => {
    const hub = new TunnelHub();
    const H = seat(hub, 'Hosty');
    const K = seat(hub, 'Krobs');
    const hs = await H.mh.host({ port: 0, ballsPerGame: 3, displayName: 'Hosty' });
    await K.mh.join(hs.invite!, 'Krobs');
    await until(() => H.mh.status().participants.length === 2 && K.mh.status().participants.length === 2, 8000, 'both in the lobby');
    // Castcade starts Krobs' table in the build; the launch answers "not started" (as one-step is told), and one-step
    // starts the player's own VPX: a table is open, and it is not in the build.
    const launch = await K.mh.tableLaunch();
    launch!.notStarted!();
    const FAILED = 'Not in 3D on this PC for this match: the Castcade VPX build did not start (the log has the reason)';
    await until(() => message(K).endsWith(FAILED), 5000, 'the note that the build did not start');
    expect(message(K)).not.toContain('started again by Castcade');
    expect(K.lines.some((l) => l.includes('is not running in the Castcade VPX build (Castcade tried that build for this match and it did not start)'))).toBe(true);
  });

  it('a table Castcade started in the build whose control connection drops for a moment gets no note while the build reconnects by itself; one that stays away does', async () => {
    const hub = new TunnelHub();
    const H = seat(hub, 'Hosty', { forkReconnectGraceMs: 700 });
    const K = seat(hub, 'Krobs');
    const hs = await H.mh.host({ port: 0, ballsPerGame: 3, displayName: 'Hosty' });
    await K.mh.join(hs.invite!, 'Krobs');
    await until(() => H.mh.status().participants.length === 2, 8000, 'both in the lobby');
    await H.mh.tableLaunch();
    const f = await forkOf(H);
    await until(() => view(H)?.fork === 'ready', 5000, 'the fork ready');
    expect(message(H)).not.toContain('not running in the Castcade VPX build');
    // (This test's witness sees a table open from the start, so the note was there until Castcade started the table.)
    const said = (): number => H.lines.filter((l) => l.includes('is not running in the Castcade VPX build')).length;
    const before = said();
    // The connection drops; the build is back within its two seconds.
    f.close();
    await until(() => view(H)?.fork === 'none', 3000, 'the fork off the control connection');
    await sleep(300);
    expect(message(H)).not.toContain('not running in the Castcade VPX build');
    const again = await forkOf(H);
    await until(() => view(H)?.fork === 'ready', 5000, 'the fork back');
    await sleep(600);
    expect(said()).toBe(before);
    // It goes for good (the table was closed and opened by hand): after the grace the lobby says so.
    again.close();
    await until(() => message(H).endsWith(NOTE), 5000, 'the note after the grace');
  });

  it('never on a PC without the build, nor with 3D watch off', async () => {
    const hub = new TunnelHub();
    const H = seat(hub, 'Hosty', { fork: false });
    const K = seat(hub, 'Krobs');
    const hs = await H.mh.host({ port: 0, ballsPerGame: 3, displayName: 'Hosty' });
    await K.mh.join(hs.invite!, 'Krobs');
    await until(() => H.mh.status().participants.length === 2 && K.mh.status().participants.length === 2, 8000, 'both in the lobby');
    await until(() => message(K).includes('not running in the Castcade VPX build'), 5000, 'the note where the build is');
    await K.mh.setSettings({ watch3d: 'off' });
    await until(() => !message(K).includes('not running in the Castcade VPX build'), 5000, 'the note gone with 3D watch off');
    await sleep(150);
    expect(message(H)).not.toContain('not running in the Castcade VPX build');
    expect(H.lines.filter((l) => l.includes('not running in the Castcade VPX build'))).toEqual([]);
  });
});

describe('the table objects of the two tables, before the start (I11.4.15)', () => {
  const message = (s: Seat): string => s.mh.status().panel?.message ?? '';
  const CONGO = { editables: 769, hash: 'fc87ddefd36bdd13' };
  const STD = '769 fc87ddefd36bdd13';
  const MOD = '766 e4b9bf66f04cfcf9';
  const NOT_3D = (who: string): string => `Not in 3D with ${who}: the two table files do not hold the same table objects, so their turns are shown as the flat video`;
  /** A witness whose open table is this file (another file of the same table when `sha` is another). */
  const fileOf = (sha: string, path: string | null): WitnessHost => {
    const w = table().w;
    return { ...w, status: () => ({ ...w.status(), currentIdentity: { sha256: sha, tableInfo: null, filePath: path } }) } as unknown as WitnessHost;
  };
  const both = async (H: Seat, K: Seat): Promise<void> => {
    const hs = await H.mh.host({ port: 0, ballsPerGame: 3, displayName: 'Hosty' });
    await K.mh.join(hs.invite!, 'Krobs');
    await until(() => H.mh.status().participants.length === 2 && K.mh.status().participants.length === 2, 8000, 'both in the lobby');
  };

  it("a host says what its table holds with its fingerprint: computed from the file while its VPX is not up, its VPX's own word once it is; the joining PC has it from HELLO_ACK; a host that cannot tell says nothing", async () => {
    const hub = new TunnelHub();
    const asked: string[] = [];
    const H = seat(hub, 'Hosty', { extra: { witness: fileOf(SHA, String.raw`C:\vpx\tables\Congo.vpx`), tableObjects: async (p) => (asked.push(p), CONGO) } });
    const K = seat(hub, 'Krobs');
    await both(H, K);
    await until(() => K.mh.hostTableObjects() !== null, 5000, "the host's table objects on the joining PC");
    expect(K.mh.hostTableObjects()).toEqual(CONGO);
    expect(H.mh.hostTableObjects()).toEqual(CONGO);
    // Asked for this PC's own table file, once per file.
    expect(asked).toEqual([String.raw`C:\vpx\tables\Congo.vpx`]);
    expect(H.lines).toContain(`match: lobby update: table objects ${STD} (computed from the file); the players were told`);
    expect(K.lines).toContain(`match: the host's table objects: ${STD}`);
    // The host's VPX comes up in the Castcade build and names another identity (a file the computation got wrong, or
    // another table opened since): that is what the other PC's VPX will be compared with, so that is what is said.
    await H.mh.tableLaunch();
    await forkOf(H, true, '738 512b43b0598d481c');
    await until(() => K.mh.hostTableObjects()?.editables === 738, 5000, "the build's own word on the joining PC");
    expect(K.mh.hostTableObjects()).toEqual({ editables: 738, hash: '512b43b0598d481c' });
    expect(H.lines).toContain('match: lobby update: table objects 738 512b43b0598d481c (as the Castcade VPX build named them); the players were told');
    expect(K.lines).toContain("match: the host's table objects: 738 512b43b0598d481c");
    expect(asked).toHaveLength(1);
    // The joining PC says nothing of its own (the host needs none), and a match that ended knows none.
    await K.mh.leave();
    expect(K.mh.hostTableObjects()).toBeNull();

    // A host whose file cannot be told and whose VPX is not the build: nothing is said, and nothing breaks.
    const hub2 = new TunnelHub();
    const H2 = seat(hub2, 'Hosty', { fork: false, extra: { witness: fileOf(SHA, String.raw`C:\vpx\tables\Odd.vpx`), tableObjects: async () => null } });
    const K2 = seat(hub2, 'Krobs');
    await both(H2, K2);
    await sleep(150);
    expect(K2.mh.hostTableObjects()).toBeNull();
    expect(H2.lines.filter((l) => l.includes('table objects'))).toEqual([]);
  });

  it("review of PR #125 (finding 1): a host on which 3D cannot run (no Castcade VPX build beside its VPX, or 3D watch off) says nothing of its table's objects and reads none; a joining PC is never told to import a copy for 3D with a host that has no build", async () => {
    const REMEDY = 'For 3D: "Congo (Williams 1995)_VPW_V1.0" on this PC holds the same table objects as the host\'s file and is not imported. Import it in Castcade and rejoin';
    const hub = new TunnelHub();
    const asked: string[] = [];
    // The host has no build. Its companion could compute its table's objects, and must not: no 3D can come of it.
    const H = seat(hub, 'Hosty', { fork: false, extra: { witness: fileOf(SHA, String.raw`C:\vpx\tables\Congo.vpx`), tableObjects: async (p) => (asked.push(p), CONGO) } });
    const K = seat(hub, 'Krobs', { extra: { witness: fileOf('cd'.repeat(32), null) } });
    await both(H, K);
    await sleep(250);
    expect(K.mh.hostTableObjects()).toBeNull();
    expect(H.mh.hostTableObjects()).toBeNull();
    expect(asked).toEqual([]);
    expect(H.lines.filter((l) => l.includes('table objects'))).toEqual([]);
    // The joining PC has the build, an imported mod and a copy with other bytes. With nothing said by the host its
    // one-step has no "other objects" word; a host that says its objects all the same (a build without this fix) would
    // give it one, and the lobby must still not send the player to import a copy: the guard on this side.
    await K.mh.tableLaunch();
    K.mh.setLaunchNote(REMEDY, true);
    await forkOf(K, true, MOD);
    await until(() => lineFor(K, H) === 'Hosty: the 2D video (no Castcade VPX build runs the table on their PC)', 8000, "the joining PC to know the host has no build");
    await sleep(200);
    expect(message(K)).not.toContain('Not in 3D with');
    expect(message(K)).not.toContain('For 3D:');
    expect(message(K)).not.toContain('Import it in Castcade');
    // I11.4.11's note about the host's identical file is a remedy for 3D too: not shown for such a host either.
    K.mh.setLaunchNote('For 3D: the host\'s file is on this PC as "Congo", not imported. Import it in Castcade and rejoin', false);
    await sleep(150);
    expect(message(K)).not.toContain('For 3D:');
    expect(K.lines.filter((l) => l.includes('do not hold the same table objects'))).toHaveLength(K.lines.filter((l) => l.includes('the lobby no longer says that the table objects differ')).length);

    // The build is there and 3D watch is off on the host: nothing said, nothing read; turned on, it is said.
    const hub2 = new TunnelHub();
    const asked2: string[] = [];
    const H2 = seat(hub2, 'Hosty', { extra: { witness: fileOf(SHA, String.raw`C:\vpx\tables\Congo.vpx`), tableObjects: async (p) => (asked2.push(p), CONGO) } });
    const K2 = seat(hub2, 'Krobs');
    await H2.mh.setSettings({ watch3d: 'off' });
    await both(H2, K2);
    await sleep(250);
    expect(K2.mh.hostTableObjects()).toBeNull();
    expect(asked2).toEqual([]);
    await H2.mh.setSettings({ watch3d: 'auto' });
    await until(() => K2.mh.hostTableObjects() !== null, 5000, "the host's table objects once 3D watch is on");
    expect(K2.mh.hostTableObjects()).toEqual(CONGO);
    expect(asked2).toHaveLength(1);
    // And taken back when it is turned off again.
    await H2.mh.setSettings({ watch3d: 'off' });
    await until(() => K2.mh.hostTableObjects() === null, 5000, 'the word taken back');
  });

  it("over the wire, the night of 2026-11-23: the host says what its Congo holds, and the joining PC's Castcade starts its copy with those objects, not the mod that was played last; with only the mod there, its lobby says 2D before the table is up", async () => {
    const { createOneStep } = await import('./one-step.js');
    const { formatJoinLink } = await import('./deep-link.js');
    type Known = Awaited<ReturnType<Parameters<typeof createOneStep>[0]['tables']>>[number];
    const copy = (tableId: string, sha: string, lastPlayedAt: string): Known => ({ tableId, vpxPath: `C:\\vpx\\tables\\${tableId}.vpx`, infoName: null, rom: null, sha256: sha, imported: true, lastPlayedAt, patchedAt: null });
    // Neither copy is the host's file; the mod was opened by hand a quarter of an hour ago, so it leads the list.
    const mr = copy('Monster Bash (Williams 1998) MR mod', '6d'.repeat(32), '2026-11-23T23:55:00.000Z');
    const std = copy('Monster Bash (Williams 1998) VPW', '34'.repeat(32), '2026-11-20T00:00:00.000Z');
    const objects: Record<string, { editables: number; hash: string }> = { [mr.vpxPath]: { editables: 766, hash: 'e4b9bf66f04cfcf9' }, [std.vpxPath]: CONGO };
    const join = async (tables: Known[]) => {
      const hub = new TunnelHub();
      const H = seat(hub, 'Hosty', { extra: { witness: fileOf(SHA, String.raw`C:\vpx\tables\Monster Bash.vpx`), tableObjects: async () => CONGO } });
      const K = seat(hub, 'Krobs');
      const launched: string[] = [];
      // Krobs' VPX is closed (the seat's own witness has a table open for the turn tests): one-step sees none.
      const one = createOneStep({
        match: K.mh,
        witness: { status: () => ({ currentTable: null }), onStatus: () => () => undefined },
        launcher: {
          async launch(path) {
            launched.push(path);
            return { ok: true, pid: 1 };
          },
        },
        clipboard: { writeText: () => undefined },
        tables: async () => tables,
        tableObjects: async (p) => objects[p] ?? null,
        hostHashWaitMs: 2000,
        log: { info: (l) => void K.lines.push(l), warn: (l) => void K.lines.push(l) },
      });
      const hs = await H.mh.host({ port: 0, ballsPerGame: 3, displayName: 'Hosty' });
      await one.openLink(formatJoinLink(hs.invite!), { trusted: true });
      await until(() => launched.length === 1, 8000, 'the table started on the joining PC');
      one.stop();
      return { K, launched };
    };
    const both = await join([mr, std]);
    expect(both.launched).toEqual([std.vpxPath]);
    expect(both.K.lines).toContain(`launch: Monster Bash (Williams 1998) VPW is not the host's file and holds the same table objects (table ${STD}): 3D works with it`);
    expect(message(both.K)).not.toContain('Not in 3D with');
    // Only the mod on this PC: it is started (the match can be played), and the lobby says what that means.
    const only = await join([mr]);
    expect(only.launched).toEqual([mr.vpxPath]);
    await until(() => message(only.K).includes(NOT_3D('Hosty')), 5000, 'the word on the lobby line');
    expect(only.K.lines.some((l) => l.startsWith(`launch: Monster Bash (Williams 1998) MR mod does not hold the host's table objects (table ${MOD} here, ${STD} on the host's PC): the 2D video, not 3D.`))).toBe(true);
  });

  it('two files with other bytes and the same table objects: once both VPX are up each lobby says 3D works all the same, and nothing warns; until then nothing is said of 3D', async () => {
    const hub = new TunnelHub();
    const H = seat(hub, 'Hosty');
    const K = seat(hub, 'Krobs', { extra: { witness: fileOf('cd'.repeat(32), null) } });
    await both(H, K);
    await H.mh.tableLaunch();
    await K.mh.tableLaunch();
    await forkOf(H, true, STD);
    // Only the host's VPX is up: the files differ, and nothing is known of 3D yet.
    await until(() => view(H)?.fork === 'ready', 5000, "the host's fork");
    await sleep(100);
    expect(message(H)).toContain('same table, different file (a re-save or another download): Krobs');
    expect(message(H)).not.toContain('3D works');
    expect(message(H)).not.toContain('Not in 3D with');
    await forkOf(K, true, STD);
    await until(() => lineFor(H, K) === 'Krobs: 3D, on your own table' && lineFor(K, H) === 'Hosty: 3D, on your own table', 8000, '3D both ways');
    await until(() => message(H).includes('3D works') && message(K).includes('3D works'), 5000, 'the word on both lobby lines');
    // A17 step 7: after the lobby's own line (who starts, and how), which a lobby always has.
    expect(message(H)).toBe("Everyone in? Start a game on your table (or Start match in the menu) · same table, different file (a re-save or another download): Krobs · 3D works all the same: the files hold the same table objects");
    expect(message(K)).toBe("Hosty starts the match from their table. To start it yourself: Start match in the menu · same table, different file (a re-save or another download): you · 3D works all the same: the files hold the same table objects");
    for (const s of [H, K]) expect(s.lines.filter((l) => l.includes('do not hold the same table objects'))).toEqual([]);
  });

  it('two tables that hold other objects: both lobbies say so before the start, with who it is about, once in each log; the word goes when it no longer applies', async () => {
    const hub = new TunnelHub();
    const H = seat(hub, 'Hosty');
    const K = seat(hub, 'Krobs', { extra: { witness: fileOf('cd'.repeat(32), null) } });
    await both(H, K);
    await H.mh.tableLaunch();
    await K.mh.tableLaunch();
    await forkOf(H, true, STD);
    const mod = await forkOf(K, true, MOD);
    await until(() => message(H).endsWith(NOT_3D('Krobs')) && message(K).endsWith(NOT_3D('Hosty')), 8000, 'the word on both lobby lines');
    expect(message(H)).toBe(`Everyone in? Start a game on your table (or Start match in the menu) · same table, different file (a re-save or another download): Krobs · ${NOT_3D('Krobs')}`);
    expect(lineFor(H, K)).toBe('Krobs: the 2D video (theirs is another table file)');
    expect(H.lines.filter((l) => l === "stream3d: this PC's table and Krobs's do not hold the same table objects (both VPX said so): the 2D video between them; the lobby says so")).toHaveLength(1);
    expect(K.lines.filter((l) => l === "stream3d: this PC's table and Hosty's do not hold the same table objects (both VPX said so): the 2D video between them; the lobby says so")).toHaveLength(1);
    // Krobs closes the mod and Castcade starts his other copy, which holds the host's objects.
    mod.close();
    await until(() => view(K)?.fork === 'none', 5000, 'the mod closed');
    await K.mh.tableLaunch();
    await forkOf(K, true, STD);
    await until(() => message(H).includes('3D works') && message(K).includes('3D works'), 8000, '3D works on both lobby lines');
    expect(message(H)).not.toContain('Not in 3D with');
    expect(H.lines).toContain('stream3d: the lobby no longer says that the table objects differ (it does not apply any more)');
  });

  it("a joining PC whose table is still loading: the launch's word (the copy that was started holds other objects than the host said) is on its lobby line at once, with what to do when another copy would give 3D; it goes when the two VPX say 3D runs; never on a PC where 3D cannot run", async () => {
    const hub = new TunnelHub();
    const H = seat(hub, 'Hosty');
    const K = seat(hub, 'Krobs', { extra: { witness: fileOf('cd'.repeat(32), null) } });
    await both(H, K);
    await H.mh.tableLaunch();
    await forkOf(H, true, STD);
    // one-step started Krobs' copy in the build and knows it holds other objects; its VPX has not said hello yet.
    await K.mh.tableLaunch();
    const REMEDY = 'For 3D: "Congo (Williams 1995)_VPW_V1.0" on this PC holds the same table objects as the host\'s file and is not imported. Import it in Castcade and rejoin';
    K.mh.setLaunchNote(REMEDY, true);
    await until(() => message(K).includes(NOT_3D('Hosty')), 5000, "the launch's word on the lobby line");
    expect(message(K).endsWith(`${NOT_3D('Hosty')} · ${REMEDY}`)).toBe(true);
    expect(K.lines).toContain("stream3d: this PC's table and Hosty's do not hold the same table objects (the host's word against the copy that was started here): the 2D video between them; the lobby says so");
    // The host is not told by this (its own lobby speaks when both VPX are up).
    expect(message(H)).not.toContain('Not in 3D with');
    // Its VPX comes up and names the mod: the same word, now from both VPX, said once.
    const mod = await forkOf(K, true, MOD);
    await until(() => message(H).endsWith(NOT_3D('Krobs')), 8000, 'the word on the host');
    expect(message(K).endsWith(`${NOT_3D('Hosty')} · ${REMEDY}`)).toBe(true);
    expect(K.lines.filter((l) => l.includes("this PC's table and Hosty's do not hold the same table objects"))).toHaveLength(1);
    // The player opens a copy with the host's objects after all: the launch's word no longer applies and is dropped.
    mod.close();
    await until(() => view(K)?.fork === 'none', 5000, 'the mod closed');
    await K.mh.tableLaunch();
    await forkOf(K, true, STD);
    await until(() => message(K).includes('3D works'), 8000, '3D works');
    expect(message(K)).not.toContain('Not in 3D with');
    expect(message(K)).not.toContain('For 3D:');

    // 3D watch off on the joining PC: the launch's word is not shown (2D is what that PC asked for).
    const hub2 = new TunnelHub();
    const H2 = seat(hub2, 'Hosty');
    const K2 = seat(hub2, 'Krobs');
    await both(H2, K2);
    await K2.mh.setSettings({ watch3d: 'off' });
    K2.mh.setLaunchNote(REMEDY, true);
    await sleep(150);
    expect(message(K2)).not.toContain('Not in 3D with');
    expect(message(K2)).not.toContain('For 3D:');
  });

  it("A17 step 10 (review of PR 139): after a member's pick the early word names the person whose copy the picked table's objects are of, on the lobby's PC too, and nobody on the picker's own PC", async () => {
    const hub = new TunnelHub();
    const H = seat(hub, 'Hosty');
    const K = seat(hub, 'Krobs', { extra: { witness: fileOf('cd'.repeat(32), null) } });
    await both(H, K);
    // Krobs picks another table, with what the Castcade VPX build says of his copy of it.
    await K.mh.pickTable({ game: { kind: 'vpx', tableName: 'Attack from Mars', tableHash: 'ef'.repeat(32), romName: 'afm_113b', romHash: null, physicsHash: null, recipeVersion: null, sidecarHash: null, emulatorVersion: '' }, objects: { editables: 1203, hash: '00aa11bb22cc33dd' } });
    await until(() => H.mh.status().lobby?.table.pickedByName === 'Krobs', 5000, 'the pick on the lobby PC');
    // The lobby's PC started its own copy of it and knows that copy holds other objects than the picked one.
    H.mh.setLaunchNote(null, true);
    await until(() => message(H).includes(NOT_3D('Krobs')), 5000, "the picker's name on the lobby PC's line");
    expect(H.lines).toContain("stream3d: this PC's table and Krobs's do not hold the same table objects (what its picker said of the lobby's table against the copy that was started here): the 2D video between them; the lobby says so");
    // On the picker's own PC the same flag names nobody: the picked table's objects are those of its own copy.
    K.mh.setLaunchNote(null, true);
    await sleep(150);
    expect(message(K)).not.toContain('Not in 3D with');
  });
});

describe('the turn lock and a fork that answers at once (A8)', () => {
  it('whenPlaying that answers before it returns leaves no stale wait behind: the next lock and unlock work as ever', async () => {
    // A stream whose fork is "away" when asked and back by the time the wait is registered.
    let asked = 0;
    const stream: MatchStream3d = {
      signal: () => undefined,
      setPeers: () => undefined,
      setTarget: () => undefined,
      setSetting: () => undefined,
      showing3d: () => false,
      away: () => true,
      setStartGate: () => undefined,
      setTableOpen: () => undefined,
      startWait: () => ({ pending: false, until: null, why: null, waitingFor: [] }),
      whenPlaying: (cb) => {
        asked++;
        cb(false);
        return () => {
          throw new Error('a wait that was already answered was cancelled');
        };
      },
      status: () => ({ setting: 'auto', fork: 'ready', build: 'b', watching: null, players: [] }),
      onChange: () => () => undefined,
      close: async () => undefined,
    };
    const fake: Stream3dHost = { launch: async () => null, open: () => stream, controlPort: async () => 1, stop: async () => undefined };
    const dir = mkdtempSync(join(tmpdir(), 'castcade-s3d-a8-'));
    dirs.push(dir);
    const lines: string[] = [];
    const push = (l: string): void => void lines.push(l);
    const lock = join(dir, 'lock', 'turn.lock');
    const mh = createMatchHost({
      file: join(dir, 'match.json'),
      keysFile: join(dir, 'match-keys.json'),
      witness: table().w,
      device: () => ({ deviceId: 'dev-a8', deviceLabel: 'a8' }),
      appVersion: '0.2.46',
      // A18: no grace: these tests are about what follows a dropped link, not the wait before it counts.
      disconnectGraceMs: 0,
      log: { info: push, warn: push, error: push, file: '' } as unknown as Logger,
      publicIp: () => Promise.resolve('127.0.0.1'),
      lockFile: lock,
      listenAddress: '127.0.0.1',
      ephemeralPort: true,
      // A17 step 7: every start of a lobby counts down; long enough here for the start to be taken back while it does.
      lobby: { countdownMs: 5000 },
      openPort: null,
      signalling: (role, id) => matchSignalling(role, id),
      stream3d: fake,
    });
    hosts.push(mh);
    // A17 step 7: lock, unlock, lock, unlock by what locks a table outside a turn in a lobby: a start that counts
    // down (the tables of the people in it are locked), taken back (they are free again). Until the lobby this was
    // done with A12's "Table locked until someone joins", which a lobby does not read.
    const hs = await mh.host({ port: 0, ballsPerGame: 3, displayName: 'Hosty' });
    const K = seat(new TunnelHub(), 'Krobs', { fork: false });
    await K.mh.join(hs.invite!, 'Krobs');
    await until(() => mh.status().participants.length === 2, 8000, 'both in the lobby');
    expect(existsSync(lock)).toBe(false);
    await mh.start();
    expect(existsSync(lock)).toBe(true);
    await mh.cancelStart();
    expect(asked).toBe(1);
    expect(existsSync(lock)).toBe(false);
    expect(mh.status().locked).toBe(false);
    await mh.start();
    expect(existsSync(lock)).toBe(true);
    await mh.cancelStart();
    expect(asked).toBe(2);
    expect(existsSync(lock)).toBe(false);
    expect(lines.filter((l) => l === 'stream3d: the table is unlocked (VPX is back on its own table)')).toHaveLength(2);
    expect(lines.some((l) => l.includes('could not'))).toBe(false);
  }, 20_000);
});

describe('A17 step 2 (2026-11-24): what ends with a match, what ends with the lobby', () => {
  it('the match half leaves the state stream as it is: the tunnel open, the fork told nothing, the other PC still watching in 3D; leaving closes the tunnel', async () => {
    const hub = new TunnelHub();
    const { seats, forks: f } = await lobby(hub, [['Hosty'], ['Krobs']]);
    const [H, K] = seats as [Seat, Seat];
    await H.mh.start();
    await until(() => up(H, 1) && sees(K, f['Krobs'], H), 8000, 'Krobs to watch Hosty in 3D');
    expect(H.tunnel()?.closed).toBe(false);
    const told = f['Hosty']?.got.length;

    // The match half alone (no caller in the app before step 7; a teardown runs both halves).
    const endMatch = matchHalfOf(H.mh);
    expect(endMatch).not.toBeNull();
    endMatch!();
    // The tunnel is the lobby's: open, its peers as they were, the fork on the control connection told nothing.
    expect(H.tunnel()?.closed).toBe(false);
    expect(H.tunnel()?.peers).toEqual([K.id()]);
    expect(f['Hosty']?.got.length).toBe(told);
    expect(H.mh.status().stream3d).not.toBeNull();
    expect(lineFor(H, K)).toBe('Krobs: 3D, on your own table');
    // The other PC goes on watching the player who is up, and a ball that ends still moves the turn.
    await sleep(100);
    expect(watching(K)).toBe(H.id());
    expect(K.tunnel()?.closed).toBe(false);
    await endBall(H, 1, 1000);
    await until(() => up(K, 1), 8000, "Krobs's ball 1");
    expect(H.tunnel()?.closed).toBe(false);

    // Leave: the lobby's half closes the tunnel, as it always did.
    const left = await H.mh.leave();
    expect(left).toMatchObject({ role: 'none', stream3d: null });
    expect(H.tunnel()?.closed).toBe(true);
  }, 30_000);

  it("A17 step 7 (2026-11-25): a member who only watches, with the build: their VPX shows whoever is up in 3D by turns and is on its own table whenever no game is played; the tunnels are the lobby's, made once and kept over the end of a match; in the next match the watcher plays and is watched", async () => {
    const hub = new TunnelHub();
    const { seats, forks: f } = await lobby(hub, [['Hosty'], ['Krobs'], ['Chuck']]);
    const [H, K, C] = seats as [Seat, Seat, Seat];
    C.mh.setStance('watch');
    await until(() => H.mh.status().lobby?.members.find((m) => m.name === 'Chuck')?.stance === 'watch', 8000, 'Chuck set to Watch');
    const tunnels = [H, K, C].map((x) => x.tunnel());
    expect(f['Chuck']?.got).toEqual([]);

    await H.mh.start();
    await until(() => up(H, 1) && sees(K, f['Krobs'], H) && sees(C, f['Chuck'], H), 8000, 'both to watch Hosty in 3D');
    // The watcher is in no roster and holds no turn; its table is locked while the game is played.
    expect(C.mh.status().panel?.players.map((x) => x.name)).toEqual(['Hosty', 'Krobs']);
    expect(existsSync(C.lock)).toBe(true);
    await endBall(H, 1, 1000);
    await until(() => up(K, 1) && sees(C, f['Chuck'], K) && sees(H, f['Hosty'], K), 8000, 'both to watch Krobs in 3D');
    await endBall(K, 1, 500);
    for (let ball = 2; ball <= 3; ball++) {
      await endBall(H, ball, 1000 * ball);
      await endBall(K, ball, 500 * ball);
    }
    await until(() => [H, K, C].every((x) => x.mh.status().phase === 'over'), 8000, 'the result');
    // Between games nobody is watched: the watcher's VPX is on its own table again, and its table is its own.
    await until(() => watching(C) === null && f['Chuck']?.got.at(-1) === 'play', 8000, "Chuck's fork back on its own table");
    await until(() => existsSync(C.lock) === false, 8000, "Chuck's table unlocked");

    // End match: back to the lobby. Not one tunnel was closed or made again.
    await K.mh.endMatch({ everyone: false });
    await until(() => [H, K, C].every((x) => x.mh.status().phase === 'lobby'), 8000, 'the lobby again');
    expect([H, K, C].map((x) => x.tunnel())).toEqual(tunnels);
    expect(tunnels.map((t) => t?.closed)).toEqual([false, false, false]);
    expect(lineFor(C, H)).toBe('Hosty: 3D, on your own table');

    // The next match: the watcher plays, the lobby's PC watches, and is shown the watcher's table in 3D.
    C.mh.setStance('play');
    H.mh.setStance('watch');
    await until(() => K.mh.status().lobby?.members.find((m) => m.name === 'Hosty')?.stance === 'watch' && K.mh.status().lobby?.members.find((m) => m.name === 'Chuck')?.stance === 'play', 8000, 'the stances');
    await C.mh.start();
    await until(() => up(C, 1) && sees(H, f['Hosty'], C) && sees(K, f['Krobs'], C), 8000, 'both to watch Chuck in 3D');
    expect(H.mh.status().panel?.players.map((x) => x.name)).toEqual(['Chuck', 'Krobs']);
    expect([H, K, C].map((x) => x.tunnel())).toEqual(tunnels);
  }, 60_000);
});
