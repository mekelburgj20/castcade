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

const { createMatchHost } = await import('./match-host.js');
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
    log,
    publicIp: () => Promise.resolve('127.0.0.1'),
    lockFile: lock,
    listenAddress: '127.0.0.1',
    ephemeralPort: true,
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

  it('a client that loses the match for a moment (ArcAid drops the host) and reconnects by itself: called back for the pause, watching again after it', async () => {
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
    r.dropDevice('dev-Hosty');
    await until(() => K.mh.status().phase === 'paused' || fk!.count('play') === 1, 8000, 'the drop to be seen');
    // Back by itself (RECONNECT, then its own RESUME): the grant is issued again and Krobs watches the host again.
    await until(() => H.mh.status().phase === 'playing' && K.mh.status().phase === 'playing' && sees(K, fk, H) && fk!.count('watch') >= 2, 12_000, 'Krobs to watch again after the reconnect');
    expect(fk!.count('play')).toBeGreaterThanOrEqual(1);
    expect(K.modes.at(-1)).toBe('hidden');
    expect(existsSync(K.lock)).toBe(true);
    // The data connection between the companions never went through ArcAid: it is the same one.
    expect(hub.all).toHaveLength(2);
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
    } = (await lobby(hub, [['Hosty'], ['Krobs', { extra: { hostWaitMs: 2500 } }]])) as { seats: [Seat, Seat]; forks: Record<string, Fork> };
    await H.mh.start();
    await until(() => sees(K, fk, H) && K.modes.at(-1) === 'hidden');
    await crash(H);
    // The host's tunnel closed with it: nothing is known of its VPX any more, so there is no 3D to show.
    await until(() => fk!.count('play') === 1 && watching(K) === null, 8000, "Krobs's fork to be called back");
    await until(() => (K.mh.status().panel?.message ?? '').startsWith("The host's Castcade closed or lost its connection."));
    expect(K.modes.at(-1)).not.toBe('hidden');
    expect(existsSync(K.lock)).toBe(true);
    // The wait runs out: the match is over for this PC, its table unlocked, its stream closed, its fork still connected.
    await until(() => K.mh.status().role === 'none', 15_000, 'the match to end for Krobs');
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

    // The host starts a game on its table: no countdown, the lobby line says what is waited for and how to start now.
    H.t.gameStart();
    await until(() => /^The match starts once the 3D connection to Krobs is up, or in \d+ s \(Start match on the Match tab starts it now; the first turn may then be the 2D video\)$/.test(message(H)), 5000, "the host's lobby line");
    expect(H.mh.status().wait3d.armed).toBe('table');
    expect(message(K)).toBe('Waiting for Hosty to start a game on the table · the 3D connection to Hosty is still being made (the start waits for it, 45 s at most)');
    await sleep(400);
    expect(H.mh.status().phase).toBe('lobby');
    expect(H.mh.status().panel?.countdown ?? null).toBeNull();

    // The data connection comes up: both PCs settle, the countdown of a start from the table runs, and the match starts.
    hub.release();
    await until(() => lineFor(K, H) === 'Hosty: 3D, on your own table' && lineFor(H, K) === 'Krobs: 3D, on your own table', 5000, 'the 3D lines');
    await until(() => H.mh.status().wait3d.players.length === 0, 5000, 'nobody waited for');
    expect(H.lines.some((l) => /^stream3d: the match's start no longer waits for this PC: this PC's 3D connections are settled \(heard from, after this PC's data connections opened: Krobs \d+\.\d s\)$/.test(l))).toBe(true);
    expect(H.lines).toContain("stream3d: sent to the players: this PC's 3D connection is settled (stream3dWaitMs 0)");
    expect(H.lines).toContain('match: the 3D connections are settled; the start from the table goes on');
    await until(() => message(H).startsWith('Starting the match'), 5000, 'the countdown');
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
    // Held: still the lobby, and the line says a second press starts now.
    expect(st.phase).toBe('lobby');
    expect(H.mh.status().wait3d.armed).toBe('tab');
    expect(message(H)).toMatch(/^The match starts once the 3D connection to Krobs is up, or in \d+ s \(Start match again starts it now; the first turn may then be the 2D video\)$/);
    // 3 s after each PC began connecting to the other they stop waiting, say so, and the held start happens: a start
    // like any other (nothing is logged as confirmed by the host).
    await until(() => K.mh.status().phase === 'playing' && playerUp(K) === H.id(), 9000, 'the match after the limit');
    expect(H.lines).toContain("stream3d: the match's start no longer waits for this PC: 3 s passed since this PC began connecting to Krobs and nothing was heard from that PC: the first turn may be the 2D video");
    expect(H.lines).toContain('match: the held Start match comes due: the match starts now');
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

  it('Start match pressed twice starts now, whatever is still connecting', async () => {
    const { H, K } = await slowLobby();
    await until(() => H.mh.status().wait3d.players.length === 2, 5000, 'both PCs listed as waited for');
    expect((await H.mh.start()).phase).toBe('lobby');
    await H.mh.start();
    await until(() => K.mh.status().phase === 'playing' && H.mh.status().phase === 'playing', 5000, 'the match at the second press');
    expect(H.lines).toContain("stream3d: the match's start no longer waits for this PC: the match started or the lobby is gone, with nothing heard yet from Krobs: they are shown in the 2D video until their PC is heard from");
    expect(H.mh.status().wait3d).toEqual({ players: [], seconds: 0, armed: null });
  });

  it('D3: a held Start match that comes due when it cannot simply start (a player joined during the hold and has no table open) is dropped and said, not started as if the host had confirmed; the next press starts', async () => {
    const { hub, H, K } = await slowLobby();
    await until(() => H.mh.status().wait3d.players.length === 2, 5000, 'both PCs listed as waited for');
    expect((await H.mh.start()).phase).toBe('lobby');
    expect(H.mh.status().wait3d.armed).toBe('tab');
    // A third player joins during the hold, with no table open yet and no Castcade VPX build.
    const closed = { ...table().w, status: () => ({ paired: false, currentTable: null, currentIdentity: null, currentAttestation: null, captureMode: 'live', note: null }) } as unknown as WitnessHost;
    const C = seat(hub, 'Chuck', { fork: false, extra: { witness: closed } });
    await C.mh.join(H.mh.status().invite!, 'Chuck');
    await until(() => H.mh.status().participants.length === 3 && H.mh.status().panel?.players.find((x) => x.name === 'Chuck')?.flags.includes('loading') === true, 8000, 'Chuck in the lobby, loading');
    // The connection of the two who were waited for comes up: the hold is due.
    hub.release();
    await until(() => H.mh.status().wait3d.armed === null, 8000, 'the hold dropped');
    expect(H.mh.status().phase).toBe('lobby');
    expect(H.mh.status().lastError).toBe('The match did not start by itself: Chuck has no table open yet. Press Start match to start it now.');
    await sleep(300);
    // Once, not again and again; nothing started; nothing claims a confirmation.
    expect(H.lines.filter((l) => l.includes('the held Start match came due and was not started: Chuck has no table open yet'))).toHaveLength(1);
    expect(H.lines).toContain('match: the held Start match is off: Chuck has no table open yet; the next press of Start match is not held');
    expect([...H.lines, ...K.lines].filter((l) => l.includes('the host confirmed') || l.includes('started with'))).toEqual([]);
    expect(K.mh.status().phase).toBe('lobby');
    // The host presses Start match: nobody is waited for any more, and it starts as a press always did.
    await H.mh.start();
    await until(() => K.mh.status().phase === 'playing' && C.mh.status().phase === 'playing', 5000, 'the match at the press');
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
      log: { info: push, warn: push, error: push, file: '' } as unknown as Logger,
      publicIp: () => Promise.resolve('127.0.0.1'),
      lockFile: lock,
      listenAddress: '127.0.0.1',
      ephemeralPort: true,
      openPort: null,
      signalling: (role, id) => matchSignalling(role, id),
      stream3d: fake,
    });
    hosts.push(mh);
    // A12: the host's table locked until someone joins, then free, then locked again: lock, unlock, lock, unlock.
    mh.setSettings({ preMatchPlay: 'locked' });
    await mh.host({ port: 0, ballsPerGame: 3, displayName: 'Hosty' });
    expect(existsSync(lock)).toBe(true);
    mh.setSettings({ preMatchPlay: 'free' });
    expect(asked).toBe(1);
    expect(existsSync(lock)).toBe(false);
    expect(mh.status().locked).toBe(false);
    mh.setSettings({ preMatchPlay: 'locked' });
    expect(existsSync(lock)).toBe(true);
    mh.setSettings({ preMatchPlay: 'free' });
    expect(asked).toBe(2);
    expect(existsSync(lock)).toBe(false);
    expect(lines.filter((l) => l === 'stream3d: the table is unlocked (VPX is back on its own table)')).toHaveLength(2);
    expect(lines.some((l) => l.includes('could not'))).toBe(false);
  }, 20_000);
});
