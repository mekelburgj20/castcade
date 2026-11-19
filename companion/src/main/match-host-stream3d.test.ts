/**
 * I11.4.2 (docs/design/state-stream-in-match.md §4): the state stream inside a real match. Three match hosts on
 * localhost over real WebSockets (Electron stubbed, as match-host.test.ts), each with the real `stream3d-host` on a
 * real loopback control port; scripted control clients stand in for the VPX fork on two of the PCs, the third has
 * none; the tunnels are fakes joined by a hub, signalled through the match's own MEDIA_SIGNAL (`channel: 'stream'`).
 *
 * What it proves: the two PCs with the fork watch each other in 3D by turns and show the third in 2D; the third shows
 * both in 2D; the headset of a PC watching in 3D is never put in theater, and is when it falls back; the turn lock
 * file of the player coming up stays until its fork says `state playing`; the setting turns it off for one PC; a match
 * table is launched in the fork.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ScriptedFork as Fork, TunnelHub as Hub } from './stream3d.test-support.js';

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
const { ScriptedFork, TunnelHub, until } = await import('./stream3d.test-support.js');
type MatchHost = ReturnType<typeof createMatchHost>;
type Opts = Parameters<typeof createMatchHost>[0];
type WitnessHost = Opts['witness'];
type Logger = Opts['log'];
type Feed = Parameters<Parameters<WitnessHost['onEvent']>[0]>[0];

const VPX = String.raw`C:\vpx\VPinballX_GL64.exe`;
const FORK = String.raw`C:\vpx\VPinballX_GL64_castcade.exe`;
const SHA = 'ab'.repeat(32);

const dirs: string[] = [];
const hosts: MatchHost[] = [];
const streams: Array<ReturnType<typeof createStream3dHost>> = [];
const forks: Fork[] = [];
afterEach(async () => {
  for (const f of forks.splice(0)) f.close();
  for (const h of hosts.splice(0)) await h.stop();
  for (const s of streams.splice(0)) await s.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A headset rig on Virtual Desktop's OpenXR runtime: the panel goes through the layer, whose modes the test reads. */
function headset() {
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

interface Seat {
  name: string;
  mh: MatchHost;
  lock: string;
  lines: string[];
  modes: string[];
  stream3d: ReturnType<typeof createStream3dHost>;
  feed(ev: Feed): void;
  id(): string;
}

function seat(hub: Hub, name: string, o: { fork: boolean }): Seat {
  const dir = mkdtempSync(join(tmpdir(), `castcade-s3d-${name}-`));
  dirs.push(dir);
  const lines: string[] = [];
  const push = (l: string): void => void lines.push(l);
  const log = { info: push, warn: push, error: push, file: '' } as unknown as Logger;
  const cbs: Array<(ev: Feed) => void> = [];
  const witness = {
    status: () => ({ paired: false, currentTable: 'Monster Bash', currentIdentity: { sha256: SHA, tableInfo: null }, currentAttestation: null, captureMode: 'live' }),
    sampleVr: async () => null,
    onEvent: (cb: (ev: Feed) => void) => (cbs.push(cb), () => undefined),
    onStatus: () => () => undefined,
  } as unknown as WitnessHost;
  let port = 52_000 + Math.floor(Math.random() * 500) * 10;
  const stream3d = createStream3dHost({
    log: { info: push, warn: push },
    logsDir: join(dir, 'logs'),
    pageDir: dir,
    vpxExe: () => VPX,
    exists: async (p) => p === VPX || (p === FORK && o.fork),
    iceServers: () => [],
    tunnel: (t) => hub.make(t),
    freePort: async () => ++port,
  });
  streams.push(stream3d);
  const h = headset();
  const lock = join(dir, 'lock', 'turn.lock');
  const mh = createMatchHost({
    file: join(dir, 'match.json'),
    keysFile: join(dir, 'match-keys.json'),
    witness,
    device: () => ({ deviceId: `dev-${name}`, deviceLabel: name }),
    appVersion: '0.2.46',
    log,
    publicIp: () => Promise.resolve('127.0.0.1'),
    lockFile: lock,
    listenAddress: '127.0.0.1',
    openPort: null,
    media: h.media,
    vrLayer: h.layer,
    rig: async () => ({ rig: 'vr_headset' as const, reason: 'test', runtime: 'virtual-desktop' as const }),
    // The real signalling over the match socket, as the shell wires it: the tunnel's signals ride MEDIA_SIGNAL.
    signalling: (role, id) => matchSignalling(role, id),
    stream3d,
  });
  hosts.push(mh);
  return { name, mh, lock, lines, modes: h.modes, stream3d, feed: (ev) => cbs.forEach((cb) => cb(ev)), id: () => mh.status().localId as string };
}

async function forkOf(s: Seat, table?: string): Promise<Fork> {
  const f = await ScriptedFork.connect(await s.stream3d.controlPort());
  forks.push(f);
  f.hello(table);
  return f;
}

const lineFor = (s: Seat, other: Seat): string => s.mh.status().stream3d?.players.find((p) => p.id === other.id())?.line ?? '';
const playerUp = (s: Seat): string | null => s.mh.status().panel?.playerUp ?? null;

/** The seat's ball `ball` ends at `score` (the journal's events, as the witness feeds them). */
async function endBall(s: Seat, ball: number, score: number): Promise<void> {
  await until(() => s.mh.status().panel?.myTurn === true && s.mh.status().panel?.ball === ball, 5000, `${s.name}'s ball ${ball}`);
  s.feed({ kind: 'current_scores', t: 0, scores: [score], player: 1, ball } as Feed);
  s.feed({ kind: 'ball_end', t: 0, player: 1, ball, extraBalls: 0 } as Feed);
  s.feed({ kind: 'current_scores', t: 0, scores: [score], player: 1, ball } as Feed);
  await until(() => s.mh.status().panel?.myTurn !== true, 5000, `${s.name}'s turn to end`);
}

describe('the state stream inside a match (I11.4.2)', () => {
  it('three players, one without the fork: the two with it watch each other in 3D by turns, everyone sees the third in 2D, the third sees 2D; the lock waits for state playing; the setting turns it off', async () => {
    const hub = new TunnelHub();
    const H = seat(hub, 'host', { fork: true });
    const K = seat(hub, 'krobs', { fork: true });
    const C = seat(hub, 'chuck', { fork: false });

    // Before a match there is nothing to launch into.
    expect(await H.mh.tableLaunch()).toBeNull();
    expect(H.mh.status().stream3d).toBeNull();

    const port = 46_000 + Math.floor(Math.random() * 2000);
    const hs = await H.mh.host({ port, ballsPerGame: 3, displayName: 'Hosty' });
    expect(hs.settings.watch3d).toBe('auto');
    await K.mh.join(hs.invite!, 'Krobs');
    await C.mh.join(hs.invite!, 'Chuck');
    await until(() => H.mh.status().participants.length === 3 && K.mh.status().participants.length === 3 && C.mh.status().participants.length === 3);

    // §4.4: the match table of a PC with the fork starts in it, with the stream's variables; a PC without starts as ever.
    const launch = await H.mh.tableLaunch();
    expect(launch).toMatchObject({ exe: FORK, env: { CASTCADE_STREAM: 'match', CASTCADE_STREAM_SOUND: '0', CASTCADE_STREAM_CONTROL: `connect:127.0.0.1:${await H.stream3d.controlPort()}` } });
    expect(launch?.env?.CASTCADE_STREAM_ADDR).toMatch(/^listen:127\.0\.0\.1:\d+$/);
    expect(await K.mh.tableLaunch()).not.toBeNull();
    expect(await C.mh.tableLaunch()).toBeNull();

    // The two forks come up on the same table file; the third PC's VPX never connects.
    const fh = await forkOf(H);
    const fk = await forkOf(K);

    // The lobby: every pair's data connection is signalled through the match (MEDIA_SIGNAL, channel `stream`), and
    // each PC says what its VPX is over it. One line per other player on each Match tab.
    await until(() => hub.open(H.id(), K.id()) && hub.open(H.id(), C.id()) && hub.open(K.id(), C.id()), 5000, 'the three data connections');
    await until(() => lineFor(H, K) === 'Krobs: 3D, on your own table' && lineFor(K, H) === 'Hosty: 3D, on your own table', 5000, 'the 3D lines');
    await until(() => lineFor(H, C) === 'Chuck: the 2D video (no Castcade VPX build runs the table on their PC)' && lineFor(K, C) === 'Chuck: the 2D video (no Castcade VPX build runs the table on their PC)', 5000, 'the 2D lines for Chuck');
    expect(lineFor(C, H)).toBe('Hosty: the 2D video (no Castcade VPX build runs the table on this PC)');
    expect(lineFor(C, K)).toBe('Krobs: the 2D video (no Castcade VPX build runs the table on this PC)');
    expect(H.mh.status().stream3d).toMatchObject({ setting: 'auto', fork: 'ready', watching: null });
    expect(C.mh.status().stream3d).toMatchObject({ fork: 'none', watching: null });
    // The lobby is `play` for everyone: no command went to any fork.
    expect(fh.got).toEqual([]);
    expect(fk.got).toEqual([]);

    // ---- game 1, ball 1: the host is up ----
    await H.mh.start({ anyway: true });
    await until(() => K.mh.status().phase === 'playing' && C.mh.status().phase === 'playing' && playerUp(K) === H.id());
    // Krobs waits with a locked table: its fork is sent to the host's table, and its headset is never put in theater.
    await fk.next(/^watch 127\.0\.0\.1:\d+$/);
    fk.say('state watching');
    await until(() => K.mh.status().stream3d?.watching === H.id());
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
    await until(() => K.mh.status().panel?.myTurn === true);
    expect(existsSync(K.lock)).toBe(true);
    expect(K.mh.status().locked).toBe(true);
    expect(K.lines).toContain('stream3d: the table is to be unlocked; waiting for VPX to be back on its own table (2 s at most)');
    await new Promise((r) => setTimeout(r, 150));
    expect(existsSync(K.lock)).toBe(true);
    fk.say('state playing');
    await until(() => !existsSync(K.lock));
    await until(() => K.mh.status().locked === false);
    expect(K.lines).toContain('stream3d: the table is unlocked (VPX is back on its own table)');
    // The host now waits and watches Krobs in 3D; Chuck stays in theater.
    await fh.next(/^watch 127\.0\.0\.1:\d+$/);
    fh.say('state watching');
    await until(() => H.mh.status().stream3d?.watching === K.id());
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
    expect(H.mh.status().stream3d?.watching).toBeNull();
    expect(K.mh.status().stream3d?.watching).toBeNull();
    // Krobs's fork was on its own table already: nothing more was sent to it.
    expect(fk.got.filter((l) => l === 'play')).toHaveLength(1);
    // Chuck is up and plays on a table that is unlocked at once: no fork to wait for.
    await until(() => C.mh.status().panel?.myTurn === true);
    expect(existsSync(C.lock)).toBe(false);

    // ---- ball 2, the host again: unlocked at once (its fork is on its own table), Krobs watches in 3D again ----
    await endBall(C, 1, 800);
    await until(() => H.mh.status().panel?.myTurn === true && H.mh.status().panel?.ball === 2);
    expect(existsSync(H.lock)).toBe(false);
    const before = fk.got.length;
    await fk.next(/^watch 127\.0\.0\.1:\d+$/, before);
    fk.say('state watching');
    await until(() => K.mh.status().stream3d?.watching === H.id() && K.modes.at(-1) === 'hidden');

    // ---- the setting: off on Krobs's PC: its fork is called back, the theater shows the 2D video, the line says why ----
    K.mh.setSettings({ watch3d: 'off' });
    await fk.next('play', before + 1);
    fk.say('state playing');
    await until(() => K.modes.at(-1) === 'theater');
    expect(lineFor(K, H)).toBe('Hosty: the 2D video (3D watch is turned off on this PC)');
    expect(K.mh.status().settings.watch3d).toBe('off');
    expect(await K.mh.tableLaunch()).toBeNull();
    // The others still watch Krobs in 3D: off is for one PC.
    expect(lineFor(H, K)).toBe('Krobs: 3D, on your own table');

    // The tunnel is told a roster only when it changes (its end reports a change on every call; the match host
    // syncs on every status): twice for the host here, once per joiner.
    expect(hub.all.find((t) => t.id === H.id())?.setPeersCalls).toBe(2);

    // ---- leaving: the fork is left on its own table, the lock is off, the stream's connections are closed ----
    K.mh.setSettings({ watch3d: 'auto' });
    await fk.next(/^watch /, fk.got.length);
    fk.say('state watching');
    await until(() => K.mh.status().stream3d?.watching === H.id());
    const left = await K.mh.leave();
    expect(left).toMatchObject({ role: 'none', stream3d: null, locked: false });
    expect(existsSync(K.lock)).toBe(false);
    await fk.next('play', fk.got.length - 1);
    expect(fk.closed).toBe(false);
    await until(() => lineFor(H, K) === '' || lineFor(H, K).includes('not up yet'));
  }, 40_000);

  it('a watch that fails falls back to theater at once; a lock is lifted after the 2 s limit when the fork never answers', async () => {
    const hub = new TunnelHub();
    const H = seat(hub, 'host2', { fork: true });
    const K = seat(hub, 'krobs2', { fork: true });
    const port = 46_000 + Math.floor(Math.random() * 2000);
    const hs = await H.mh.host({ port, ballsPerGame: 3, displayName: 'Hosty' });
    await K.mh.join(hs.invite!, 'Krobs');
    await H.mh.tableLaunch();
    await K.mh.tableLaunch();
    const fh = await forkOf(H);
    const fk = await forkOf(K);
    await until(() => lineFor(H, K) === 'Krobs: 3D, on your own table' && lineFor(K, H) === 'Hosty: 3D, on your own table');
    await H.mh.start({ anyway: true });
    await until(() => playerUp(K) === H.id());
    // Krobs's fork refuses the stream: theater with the 2D video for this turn.
    await fk.next(/^watch /);
    await until(() => K.modes.at(-1) === 'hidden');
    fk.say('state failed refused: table mismatch', 'state playing');
    await until(() => K.modes.at(-1) === 'theater');
    expect(lineFor(K, H)).toBe('Hosty: the 2D video this turn (3D did not start: refused: table mismatch)');
    expect(K.lines).toContain('stream3d: 3D watch of Hosty did not work (refused: table mismatch); the 2D video serves this turn');
    // Its own turn: the fork is on its own table, the lock goes at once.
    await endBall(H, 1, 1000);
    await until(() => K.mh.status().panel?.myTurn === true);
    await until(() => !existsSync(K.lock));
    // The host watches Krobs; at the host's next turn its fork never says `state playing`: unlocked after 2 s, logged.
    await fh.next(/^watch /);
    fh.say('state watching');
    await until(() => H.mh.status().stream3d?.watching === K.id());
    await endBall(K, 1, 900);
    await fh.next('play');
    await until(() => H.mh.status().panel?.myTurn === true);
    const t0 = Date.now();
    expect(existsSync(H.lock)).toBe(true);
    await until(() => !existsSync(H.lock), 5000, 'the lock to go after the limit');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1500);
    expect(H.lines.some((l) => l.startsWith('stream3d: VPX has not said "state playing" 2 s after the turn came to this PC'))).toBe(true);
    expect(H.lines).toContain('stream3d: the table is unlocked (VPX did not answer within 2 s)');
    // The next turn of Krobs tries 3D again (the failure was for one turn).
    await until(() => fk.got.filter((l) => l.startsWith('watch ')).length === 2, 5000, "the second watch to Krobs's fork");
    expect(lineFor(K, H)).toBe('Hosty: 3D, on your own table');
  }, 40_000);
});
