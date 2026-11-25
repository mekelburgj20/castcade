/**
 * A6 (2026-10-30): two match hosts on localhost over real WebSockets, Electron stubbed (the cue window only): host,
 * join with a different table file (accepted by the host's `advise` policy and flagged on both sides: the client from
 * HELLO_ACK's hostGame), start, the turn lock file on each rig, leave.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

const { ballEndsFrom, createMatchHost } = await import('./match-host.js');
const { createMediaSettingsStore } = await import('../media/media-settings.js');
const { matchSignalling } = await import('./match-setup.js');
const { startFakeRelay } = await import('../match/relay-fake.test-support.js');
type FakeRelay = Awaited<ReturnType<typeof startFakeRelay>>;
type PortMapResult = Awaited<ReturnType<NonNullable<Parameters<typeof createMatchHost>[0]['openPort']>>>;
type MatchHost = ReturnType<typeof createMatchHost>;
type WitnessHost = Parameters<typeof createMatchHost>[0]['witness'];
type Logger = Parameters<typeof createMatchHost>[0]['log'];

const logger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined, file: '' } as unknown as Logger;

function witness(sha: string): WitnessHost {
  return {
    status: () => ({ paired: false, currentTable: 'Monster Bash', currentIdentity: { sha256: sha, tableInfo: null }, currentAttestation: null }),
    sampleVr: async () => null,
    onEvent: () => () => undefined,
    onStatus: () => () => undefined,
  } as unknown as WitnessHost;
}

const dirs: string[] = [];
const hosts: MatchHost[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function make(name: string, sha: string, extra: Partial<Parameters<typeof createMatchHost>[0]> = {}): { mh: MatchHost; lock: string } {
  const dir = mkdtempSync(join(tmpdir(), `castcade-match-${name}-`));
  dirs.push(dir);
  const lock = join(dir, 'lock', 'turn.lock');
  const mh = createMatchHost({
    file: join(dir, 'match.json'),
    keysFile: join(dir, 'match-keys.json'),
    witness: witness(sha),
    device: () => ({ deviceId: `dev-${name}`, deviceLabel: name }),
    appVersion: '0.2.21',
    // A18: no grace: these tests are about what follows a dropped link, not the wait before it counts (it has its own).
    disconnectGraceMs: 0,
    log: logger,
    publicIp: () => Promise.resolve('127.0.0.1'),
    lockFile: lock,
    listenAddress: '127.0.0.1',
    // D10.8: no search of the network the tests run on.
    openPort: null,
    ...extra,
  });
  hosts.push(mh);
  return { mh, lock };
}

/** D2.8 / D2.10: a table-sound helper that records what it is told. */
type Want = { mutePid: number | null; tapPid: number | null };
const fakeAudio = () => {
  const wants: Want[] = [];
  const levels: string[] = [];
  let started = 0;
  const ta = {
    start: () => void started++,
    apply: (w: Want) => void wants.push({ ...w }),
    level: (pid: number, pct: number) => {
      if (levels.at(-1) !== `level ${pid} ${pct}`) levels.push(`level ${pid} ${pct}`);
    },
    unlevel: () => {
      if (levels.length > 0 && levels.at(-1) !== 'unlevel') levels.push('unlevel');
    },
    status: () => ({ helper: 'ready' as const, reason: null, muted: false, tapping: false }),
    onStatus: () => () => undefined,
    onFrame: () => () => undefined,
    stop: async () => undefined,
  };
  return { ta, wants, levels: () => levels, last: () => wants.at(-1), started: () => started };
};

const until = async (cond: () => boolean, ms = 3000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

type Cmd = Record<string, unknown> & { cmd: string };
type Ev = Record<string, unknown> & { event: string };
/** D10.3: a video helper that is ready at once and answers like the fake exe: an offer when it initiates, an answer + connected on an offer. */
const stubHelper = () => {
  const sent: Cmd[] = [];
  const eventCbs = new Set<(e: Ev) => void>();
  let started = 0;
  const say = (e: Ev) => eventCbs.forEach((cb) => cb(e));
  const helper = {
    start: () => void started++,
    stop: async () => undefined,
    send(cmd: Cmd) {
      sent.push(cmd);
      if (cmd.cmd === 'peer' && cmd.initiator) setImmediate(() => say({ event: 'signal', id: cmd.id, kind: 'offer', sdp: `v=0 offer to ${String(cmd.id)}` }));
      if (cmd.cmd === 'signal' && cmd.kind === 'offer') {
        setImmediate(() => {
          say({ event: 'signal', id: cmd.id, kind: 'answer', sdp: 'v=0 answer' });
          say({ event: 'peer', id: cmd.id, ice: 'connected', pair: 'host<->host' });
        });
      }
      if (cmd.cmd === 'signal' && cmd.kind === 'answer') setImmediate(() => say({ event: 'peer', id: cmd.id, ice: 'connected', pair: 'host<->host' }));
      return true;
    },
    onEvent: (cb: (e: Ev) => void) => {
      eventCbs.add(cb);
      return () => void eventCbs.delete(cb);
    },
    status: () => ({ helper: 'ready' as const, reason: null, version: '1', encoder: 'h264_nvenc', decoder: 'nvdec', generation: 1 }),
    onStatus: () => () => undefined,
  };
  const of = (cmd: string) => sent.filter((c) => c.cmd === cmd);
  return { helper, sent, of, say, started: () => started };
};

describe('match host (A6)', () => {
  it('host, join with a different table file (advisory), start: the lock follows the grant; leave unlocks', async () => {
    const H = make('host', 'ab'.repeat(32));
    const C = make('client', 'cd'.repeat(32));
    const port = 41000 + Math.floor(Math.random() * 2000);
    const hs = await H.mh.host({ port, ballsPerGame: 3, displayName: 'Hosty' });
    expect(hs).toMatchObject({ role: 'host', phase: 'lobby', ipSource: 'public', port });
    expect(hs.invite).toMatch(new RegExp(`^castcade:ws://127\\.0\\.0\\.1:${port}#[A-Z]{6}$`));
    expect(hs.panel).toMatchObject({ phase: 'idle', message: 'Waiting for players' });

    await expect(C.mh.join('castcade:nope', 'Krobs')).rejects.toThrow(/not a Castcade invite/);
    const cs = await C.mh.join(hs.invite!, 'Krobs');
    expect(cs).toMatchObject({ role: 'client', phase: 'lobby' });
    expect(cs.participants.map((p) => [p.name, p.tableMatch])).toEqual([
      ['Hosty', true],
      ['Krobs', false],
    ]);
    await until(() => H.mh.status().participants.length === 2);
    expect(H.mh.status().participants.find((p) => p.name === 'Krobs')?.tableMatch).toBe(false);
    // Same table name, another hash (D2.5, 2026-10-31): the same table in another file.
    expect(H.mh.status().panel?.message).toBe('same table, different file (a re-save or another download): Krobs');
    expect(C.mh.status().panel?.message).toBe('same table, different file (a re-save or another download): you');
    expect(H.mh.status().participants.find((p) => p.name === 'Krobs')).toMatchObject({ tableNote: 'same table, different file (a re-save or another download)', buildMatch: true });
    expect(C.mh.status().panel?.players.find((p) => p.name === 'Krobs')?.flags).toEqual(['table_mismatch']);

    await H.mh.start();
    await until(() => C.mh.status().phase === 'playing');
    // The host has ball 1: its table is open, the client's is locked.
    expect(H.mh.status()).toMatchObject({ phase: 'playing', locked: false });
    expect(existsSync(H.lock)).toBe(false);
    expect(C.mh.status().locked).toBe(true);
    expect(existsSync(C.lock)).toBe(true);
    expect(C.mh.status().panel).toMatchObject({ myTurn: false, ball: 1 });

    const left = await C.mh.leave();
    expect(left).toMatchObject({ role: 'none', phase: 'none', locked: false });
    expect(existsSync(C.lock)).toBe(false);
    await until(() => H.mh.status().panel?.players.find((p) => p.name === 'Krobs')?.flags.includes('disconnected') === true);
  }, 15_000);

  it('D2.8 (2026-11-01): table sound follows the turn: the player up taps, the other is muted; leaving unmutes', async () => {
    const withPid = (sha: string, pid: number): WitnessHost => ({ ...witness(sha), vpxPid: () => pid }) as unknown as WitnessHost;
    const ha = fakeAudio();
    const ca = fakeAudio();
    const H = make('ta-host', 'ab'.repeat(32), { witness: withPid('ab'.repeat(32), 111), tableAudio: ha.ta });
    const C = make('ta-client', 'ab'.repeat(32), { witness: withPid('ab'.repeat(32), 222), tableAudio: ca.ta });
    const port = 41000 + Math.floor(Math.random() * 2000);
    const hs = await H.mh.host({ port, ballsPerGame: 3, displayName: 'Hosty' });
    expect(ha.started()).toBe(1); // the helper comes up with the match, before any ball
    expect(ha.last()).toEqual({ mutePid: null, tapPid: null }); // the lobby touches nothing
    await C.mh.join(hs.invite!, 'Krobs');
    await H.mh.start();
    await until(() => C.mh.status().phase === 'playing' && C.mh.status().panel?.ball === 1);
    // The host has ball 1: it sends its table, the client's VPX is muted.
    await until(() => ha.last()?.tapPid === 111 && ca.last()?.mutePid === 222);
    expect(ha.last()).toEqual({ mutePid: null, tapPid: 111 });
    expect(ca.last()).toEqual({ mutePid: 222, tapPid: null });
    // Off on the Match tab: the client's VPX is not muted any more.
    C.mh.setSettings({ tableMuteMine: false });
    expect(ca.last()).toEqual({ mutePid: null, tapPid: null });
    C.mh.setSettings({ tableMuteMine: true });
    expect(ca.last()).toEqual({ mutePid: 222, tapPid: null });
    await C.mh.leave();
    expect(ca.last()).toEqual({ mutePid: null, tapPid: null });
  }, 15_000);

  it('A16.2.2 (2026-11-16): during an initials hold my own table is not muted although the other player is up; a table with no hold is', async () => {
    type Feed = Parameters<Parameters<WitnessHost['onEvent']>[0]>[0];
    const playing = (pid: number, qualifies: boolean) => {
      const cbs: ((ev: Feed) => void)[] = [];
      const w = { ...witness('ab'.repeat(32)), vpxPid: () => pid, onEvent: (cb: (ev: Feed) => void) => (cbs.push(cb), () => undefined), highScoreQualifies: () => qualifies } as unknown as WitnessHost;
      return { w, feed: (ev: Feed) => cbs.forEach((cb) => cb(ev)) };
    };
    const lines: string[] = [];
    const hostLog = { info: (l: string) => void lines.push(l), warn: () => undefined, error: () => undefined, file: '' } as unknown as Logger;
    const hw = playing(111, true);
    const cw = playing(222, false);
    const ha = fakeAudio();
    const ca = fakeAudio();
    const H = make('hold-host', 'ab'.repeat(32), { witness: hw.w, tableAudio: ha.ta, log: hostLog });
    const C = make('hold-client', 'ab'.repeat(32), { witness: cw.w, tableAudio: ca.ta });
    const port = 41000 + Math.floor(Math.random() * 2000);
    const hs = await H.mh.host({ port, ballsPerGame: 3, displayName: 'Hosty' });
    await C.mh.join(hs.invite!, 'Krobs');
    await H.mh.start();
    const play =async (mh: MatchHost, seat: { feed: (ev: Feed) => void }, ball: number, score: number): Promise<void> => {
      await until(() => mh.status().panel?.myTurn === true && mh.status().panel?.ball === ball);
      seat.feed({ kind: 'current_scores', t: 0, scores: [score], player: 1, ball } as Feed);
      seat.feed({ kind: 'ball_end', t: 0, player: 1, ball, extraBalls: 0 } as Feed);
      seat.feed({ kind: 'current_scores', t: 0, scores: [score], player: 1, ball } as Feed);
      await until(() => mh.status().panel?.myTurn !== true);
    };
    // Balls 1 and 2: nobody's game is done, so the table of whoever is not up is muted.
    for (const ball of [1, 2]) {
      await play(H.mh, hw, ball, 1000 * ball);
      await until(() => ha.last()?.mutePid === 111);
      await play(C.mh, cw, ball, 900 * ball);
    }
    // The host's last ball makes its machine's list: the client is up, and the host's table stays audible, unsent.
    await play(H.mh, hw, 3, 5000);
    await until(() => C.mh.status().panel?.myTurn === true && C.mh.status().panel?.ball === 3);
    await until(() => ha.last()?.mutePid === null);
    expect(ha.last()).toEqual({ mutePid: null, tapPid: null });
    expect(H.mh.status().panel).toMatchObject({ phase: 'playing', myTurn: false });
    expect(lines.some((l) => l.startsWith('match: table sound: mute off (initials hold), send off, play '))).toBe(true);
    // The client is up and sends its own; it was never held.
    expect(ca.last()).toEqual({ mutePid: null, tapPid: 222 });
  }, 15_000);

  it("B26.4 (2026-11-16): over the real socket: the client's witness reads the setting (ON) and both Match tabs say so from the lobby on; its ROM counts a Midnight Madness on ball 3 and both tabs flag that ball; the host's witness, which knows nothing, reports nothing", async () => {
    type Feed = Parameters<Parameters<WitnessHost['onEvent']>[0]>[0];
    type Ran = Parameters<Parameters<NonNullable<WitnessHost['onMidnightMadness']>>[0]>[0];
    const playing = (setting: { enabled: boolean; adjustment: string } | null) => {
      const cbs: ((ev: Feed) => void)[] = [];
      const ran: ((ev: Ran) => void)[] = [];
      const w = {
        ...witness('ab'.repeat(32)),
        onEvent: (cb: (ev: Feed) => void) => (cbs.push(cb), () => undefined),
        onMidnightMadness: (cb: (ev: Ran) => void) => (ran.push(cb), () => undefined),
        midnightSetting: () => setting,
      } as unknown as WitnessHost;
      return { w, feed: (ev: Feed) => cbs.forEach((cb) => cb(ev)), midnight: (ev: Ran) => ran.forEach((cb) => cb(ev)) };
    };
    const hw = playing(null);
    const cw = playing({ enabled: true, adjustment: 'A.2 14 Special Mode' });
    const H = make('mid-host', 'ab'.repeat(32), { witness: hw.w });
    const C = make('mid-client', 'ab'.repeat(32), { witness: cw.w });
    const port = 41000 + Math.floor(Math.random() * 2000);
    const hs = await H.mh.host({ port, ballsPerGame: 3, displayName: 'Hosty' });
    await C.mh.join(hs.invite!, 'Krobs');
    // The lobby: the client read its table; the host could not read its own and is left out, not guessed.
    const ON_KROBS = "Midnight Madness is ON on Krobs' table (adjustment A.2 14 Special Mode)";
    const ON_MINE = 'Midnight Madness is ON on your table (adjustment A.2 14 Special Mode)';
    await until(() => H.mh.status().advisories.length === 1);
    expect(H.mh.status()).toMatchObject({ phase: 'lobby', advisories: [ON_KROBS] });
    expect(C.mh.status().advisories).toEqual([ON_MINE]);
    await H.mh.start();
    const play = async (mh: MatchHost, seat: ReturnType<typeof playing>, ball: number, score: number, midnight = false): Promise<void> => {
      await until(() => mh.status().panel?.myTurn === true && mh.status().panel?.ball === ball);
      seat.feed({ kind: 'current_scores', t: 0, scores: [score], player: 1, ball } as Feed);
      if (midnight) seat.midnight({ kind: 'midnight_madness', t: 0, audit: 'B.4 31 SPECIAL MODES', from: 3, to: 4, player: 1, ball });
      seat.feed({ kind: 'ball_end', t: 0, player: 1, ball, extraBalls: 0 } as Feed);
      seat.feed({ kind: 'current_scores', t: 0, scores: [score], player: 1, ball } as Feed);
      await until(() => mh.status().panel?.myTurn !== true);
    };
    await play(H.mh, hw, 1, 1000);
    await play(C.mh, cw, 1, 900);
    await play(H.mh, hw, 2, 2000);
    await play(C.mh, cw, 2, 1800);
    expect(H.mh.status().advisories).toEqual([ON_KROBS]);
    expect(C.mh.status().advisories).toEqual([ON_MINE]);
    await play(H.mh, hw, 3, 3000);
    await play(C.mh, cw, 3, 2700, true);
    await until(() => H.mh.status().advisories.length === 2 && H.mh.status().phase === 'over');
    expect(H.mh.status().advisories).toEqual([ON_KROBS, "Midnight Madness ran on Krobs' ball 3 (counted by that table's ROM)"]);
    expect(C.mh.status().advisories).toEqual([ON_MINE, "Midnight Madness ran on your ball 3 (counted by your table's ROM)"]);
    // The result is the scores': the host won; Krobs' row carries the flag.
    expect(H.mh.status().panel?.result).toEqual([
      { id: H.mh.status().localId, name: 'Hosty', score: 3000, place: 1 },
      { id: C.mh.status().localId, name: 'Krobs', score: 2700, place: 2, flags: ['midnight'] },
    ]);
  }, 20_000);

  it('D10.3 (2026-11-07): native video: one helper peer per rig over the real signalling (channel video), the lower id offers, send follows the turn, the rings reach the media layer; the setting is saved', async () => {
    const lines: string[] = [];
    const hostLog = { info: (l: string) => void lines.push(l), warn: (l: string) => void lines.push(l), error: (l: string) => void lines.push(l), file: '' } as unknown as Logger;
    const hooks: Array<{ ring: string; onSource: (b: { width: number; height: number; fps: number } | null) => void; onWindow?: (w: { pid: number; title: string; width: number; height: number; fps: number } | null) => void } | null> = [];
    const media = {
      attach: async () => undefined,
      addPeer: () => undefined,
      removePeer: () => undefined,
      setSending: () => undefined,
      setPanelState: () => undefined,
      setMuted: () => undefined,
      status: () => ({ attached: true, sending: false, peers: {}, mic: 'unavailable' as const, captureSource: null, lastError: null }),
      onStatus: () => () => undefined,
      frames: () => null,
      showPanel: () => undefined,
      setNativeVideo: (h: (typeof hooks)[number]) => void hooks.push(h),
      detach: async () => undefined,
    };
    const hv = stubHelper();
    const cv = stubHelper();
    const hdir = mkdtempSync(join(tmpdir(), 'castcade-video-h-'));
    dirs.push(hdir);
    const hostSettings = createMediaSettingsStore(join(hdir, 'media.json'));
    // The real signalling over the match socket (match-setup.ts), as the shell wires it.
    const signalling = (role: Parameters<typeof matchSignalling>[0], id: string) => matchSignalling(role, id);
    const H = make('vid-host', 'ab'.repeat(32), { media: media as never, mediaSettings: hostSettings, signalling, log: hostLog, nativeVideo: { helper: hv.helper as never, sendRing: 'HOSTsend_ABCDEFG', recvRing: 'HOSTrecv_ABCDEFG' } });
    const C = make('vid-client', 'ab'.repeat(32), { signalling, nativeVideo: { helper: cv.helper as never, sendRing: 'CLNTsend_ABCDEFG', recvRing: 'CLNTrecv_ABCDEFG' } });
    const port = 41000 + Math.floor(Math.random() * 2000);
    const hs = await H.mh.host({ port, ballsPerGame: 3, displayName: 'Hosty' });
    expect(hs.videoPath).toBe('native');
    // The helper comes up with the match; the media layer is told the send ring; no sink ring without the OpenXR layer.
    expect(hv.started()).toBe(1);
    expect(hooks).toHaveLength(1);
    expect(hooks[0]?.ring).toBe('HOSTsend_ABCDEFG');
    // (A ready helper is told the whole empty state at creation, then each setting once: the last of each is the rig's.)
    expect(hv.of('sink').at(-1)).toEqual({ cmd: 'sink', kind: 'window' });
    expect(hv.of('ice').at(-1)).toEqual({ cmd: 'ice', servers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }] });
    expect(hs.media?.nativeVideo).toMatchObject({ helper: 'ready', encoder: 'h264_nvenc', sending: false, sink: 'window', peers: {} });
    await C.mh.join(hs.invite!, 'Krobs');
    // One peer each; the lower id (a per-run player id while unpaired) offers and the other waits; the offer and the
    // answer crossed the match socket as MEDIA_SIGNAL {channel: 'video'} and both helpers report connected.
    const hid = H.mh.status().localId!;
    const cid = C.mh.status().localId!;
    const clientOffers = cid < hid;
    const [offerer, offeree, offereeId] = clientOffers ? [cv, hv, hid] : [hv, cv, cid];
    await until(() => hv.of('peer').length === 1 && cv.of('peer').length === 1);
    expect(hv.of('peer')).toEqual([{ cmd: 'peer', id: cid, initiator: !clientOffers }]);
    expect(cv.of('peer')).toEqual([{ cmd: 'peer', id: hid, initiator: clientOffers }]);
    await until(() => offeree.of('signal').some((s) => s.kind === 'offer') && offerer.of('signal').some((s) => s.kind === 'answer'));
    expect(offeree.of('signal')[0]).toMatchObject({ kind: 'offer', sdp: `v=0 offer to ${offereeId}` });
    await until(() => H.mh.status().media?.nativeVideo?.peers[cid]?.ice === 'connected' && C.mh.status().media === null);
    expect(H.mh.status().media?.nativeVideo?.peers[cid]).toMatchObject({ ice: 'connected', pair: 'host↔host' });
    // The media layer's camera feeds the ring: the helper is pointed at the box.
    hooks[0]?.onSource({ width: 1440, height: 1440, fps: 60 });
    expect(hv.of('source').at(-1)).toEqual({ cmd: 'source', kind: 'ring', token: 'HOSTsend_ABCDEFG', width: 1440, height: 1440, fps: 60 });
    expect(H.mh.status().media?.nativeVideo?.source).toMatchObject({ kind: 'ring', width: 1440, height: 1440, fps: 60 });
    // D10.6: the screen capture's pick on a desktop rig: the helper captures that window itself; gone → none.
    hooks[0]?.onWindow?.({ pid: 4242, title: 'Visual Pinball Player', width: 1280, height: 720, fps: 30 });
    expect(hv.of('source').at(-1)).toEqual({ cmd: 'source', kind: 'wgc', pid: 4242, title: 'Visual Pinball Player', width: 1280, height: 720, fps: 30 });
    expect(H.mh.status().media?.nativeVideo?.source).toMatchObject({ kind: 'wgc', width: 1280, height: 720, fps: 30 });
    hooks[0]?.onWindow?.(null);
    expect(hv.of('source').at(-1)).toEqual({ cmd: 'source', kind: 'none' });
    hooks[0]?.onSource({ width: 1440, height: 1440, fps: 60 });
    // The turn: the host has ball 1, so its sender is on; the client's never was.
    await H.mh.start();
    await until(() => hv.of('send').some((s) => s.on === true));
    expect(cv.of('send').map((s) => s.on)).toEqual([false]);
    expect(H.mh.status().media?.nativeVideo?.sending).toBe(true);
    // The setting is saved and shown; it takes effect at the next match.
    expect(H.mh.setVideoPath('electron').videoPath).toBe('electron');
    expect(hostSettings.get().videoPath).toBe('electron');
    expect(H.mh.status().media?.nativeVideo).toBeDefined();
    H.mh.setVideoPath('native');
    // D10.5: the ladder's controls. The helper was told the default ceiling at the start; a pin reaches the running
    // mesh at once and lives in memory only; the ceiling is saved (rounded, clamped) and reaches the mesh too.
    expect(hs.videoMaxKbps).toBe(20_000);
    expect(hs.videoPin).toBeNull();
    expect(hv.of('rungs').at(-1)).toEqual({ cmd: 'rungs', max_kbps: 20_000 });
    expect(H.mh.status().media?.nativeVideo).toMatchObject({ maxKbps: 20_000, pin: null });
    const pinned = H.mh.setVideoRungs({ pin: 4 });
    expect(pinned.videoPin).toBe(4);
    expect(hv.of('rungs').at(-1)).toEqual({ cmd: 'rungs', max_kbps: 20_000, pin: 4 });
    expect(hostSettings.get()).not.toHaveProperty('videoPin');
    const capped = H.mh.setVideoRungs({ maxKbps: 8000.4 });
    expect(capped.videoMaxKbps).toBe(8000);
    expect(hostSettings.get().videoMaxKbps).toBe(8000);
    expect(hv.of('rungs').at(-1)).toEqual({ cmd: 'rungs', max_kbps: 8000, pin: 4 });
    expect(H.mh.setVideoRungs({ pin: null, maxKbps: 10 }).videoPin).toBeNull();
    expect(hostSettings.get().videoMaxKbps).toBe(500);
    expect(hv.of('rungs').at(-1)).toEqual({ cmd: 'rungs', max_kbps: 500 });
    expect(H.mh.status().media?.nativeVideo?.ladder[4]).toEqual({ rung: 5, width: 720, height: 720, fps: 60, kbps: 4000 });
    H.mh.setVideoRungs({ maxKbps: 20_000 });
    expect(H.mh.status().media?.nativeVideo?.fallback).toBe(false);
    expect(hooks).toHaveLength(1);
    // D10.3.6: the helper gives the client's connection up (its ICE restarts exhausted): the status says fallback, the
    // line is logged once, and the hook comes off for the rest of the match: the media layer re-asks the camera without
    // the ring, hands the window back and lets the page's video track send (rtc-host's setNativeVideo(null) tests).
    hv.say({ event: 'peer', id: cid, ice: 'failed', restarts: 3, restarts_exhausted: true });
    expect(H.mh.status().media?.nativeVideo).toMatchObject({ helper: 'ready', encoder: 'h264_nvenc', fallback: true, peers: { [cid]: { ice: 'failed', failed: true } } });
    expect(lines.filter((l) => l.startsWith('media: native video failed'))).toEqual([`media: native video failed to connect (peer ${cid}, 3 restarts); the Electron video serves this match`]);
    expect(lines).toContain('match: native video: the Electron video serves the rest of this match');
    expect(hooks).toHaveLength(2);
    expect(hooks.at(-1)).toBeNull();
    // What the media layer answers with: the source handed back reaches the helper as `source none`.
    hooks[0]?.onSource(null);
    expect(hv.of('source').at(-1)).toEqual({ cmd: 'source', kind: 'none' });
    // A native connection later does not take the picture over mid-match: the hook stays off, the flag holds.
    hv.say({ event: 'peer', id: cid, ice: 'connected', pair: 'host<->host', restarts: 4 });
    expect(H.mh.status().media?.nativeVideo).toMatchObject({ fallback: true, peers: { [cid]: { ice: 'connected', failed: false } } });
    expect(hooks).toHaveLength(2);
    // Leaving closes the peer, stops sending and clears the rings; the helper itself is left for the next match.
    await C.mh.leave();
    expect(cv.of('close')).toEqual([{ cmd: 'close', id: hid }]);
    expect(cv.of('source').at(-1)).toEqual({ cmd: 'source', kind: 'none' });
    await H.mh.leave();
    expect(hooks.at(-1)).toBeNull();
    expect(hv.of('send').at(-1)).toEqual({ cmd: 'send', on: false });
    expect(hv.of('close')).toEqual([{ cmd: 'close', id: cid }]);
  }, 15_000);

  it('D10.3.8 (2026-11-07): theater on the ring with no native frame from the player up for 5 s: the ring is un-named (the layer draws the Electron frames), said once, theaterPath pipe; frames for 3 s name it again; nothing switches outside theater', async () => {
    // The theater-path clock and Date are faked; the sockets, the stub helper's setImmediate and `until` stay real.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    try {
      const hv = stubHelper();
      const cv = stubHelper();
      const lines: string[] = [];
      const clientLog = { info: (l: string) => void lines.push(l), warn: (l: string) => void lines.push(l), error: (l: string) => void lines.push(l), file: '' } as unknown as Logger;
      const theaterLines = () => lines.filter((l) => l.startsWith('media: theater:'));
      const signalling = (role: Parameters<typeof matchSignalling>[0], id: string) => matchSignalling(role, id);
      const layer = fakeOverlay();
      const m = fakeMedia();
      const H = make('tp-host', 'ab'.repeat(32), { signalling, nativeVideo: { helper: hv.helper as never, sendRing: 'HOSTsend_ABCDEFG', recvRing: 'HOSTrecv_ABCDEFG' } });
      // The client is a VR rig on Virtual Desktop's OpenXR runtime: its sink is the layer's ring.
      const C = make('tp-client', 'ab'.repeat(32), { witness: liveWitness(VR_VD, VR_OFF).w, media: m.media, vrLayer: layer.overlay, signalling, log: clientLog, nativeVideo: { helper: cv.helper as never, sendRing: 'CLNTsend_ABCDEFG', recvRing: 'CLNTrecv_ABCDEFG' } });
      const port = 45000 + Math.floor(Math.random() * 2000);
      const hs = await H.mh.host({ port, ballsPerGame: 3, displayName: 'Hosty' });
      await C.mh.join(hs.invite!, 'Krobs');
      const hid = H.mh.status().localId!;
      await until(() => C.mh.status().media?.nativeVideo?.peers[hid]?.ice === 'connected');
      expect(cv.of('sink').at(-1)).toEqual({ cmd: 'sink', kind: 'ring', token: 'CLNTrecv_ABCDEFG' });
      expect(layer.rings).toEqual(['CLNTrecv_ABCDEFG']);
      expect(C.mh.status().media?.nativeVideo?.theaterPath).toBeNull();
      // The lobby (the panel, not theater): 10 s of empty recv stats switch nothing.
      cv.say({ event: 'stats', id: hid, dir: 'recv', fps: 0, kbps: 0, width: 0, height: 0 });
      vi.advanceTimersByTime(10_000);
      expect(layer.rings).toEqual(['CLNTrecv_ABCDEFG']);
      expect(theaterLines()).toEqual([]);
      // The host's ball 1: the client's headset goes to theater on the ring; 5 s without a native frame un-names it, once.
      await H.mh.start();
      await until(() => layer.modes.at(-1) === 'theater');
      expect(C.mh.status().media?.nativeVideo?.theaterPath).toBe('ring');
      vi.advanceTimersByTime(4_999);
      expect(layer.rings).toEqual(['CLNTrecv_ABCDEFG']);
      expect(C.mh.status().media?.nativeVideo?.theaterPath).toBe('ring');
      vi.advanceTimersByTime(1);
      expect(layer.rings).toEqual(['CLNTrecv_ABCDEFG', null]);
      expect(theaterLines()).toEqual(['media: theater: no native frames from Hosty for 5 s; drawing the Electron frames']);
      expect(C.mh.status().media?.nativeVideo?.theaterPath).toBe('pipe');
      vi.advanceTimersByTime(10_000);
      expect(layer.rings).toEqual(['CLNTrecv_ABCDEFG', null]);
      expect(theaterLines()).toHaveLength(1);
      // Native frames again: after 3 s of them the ring is named again, said once.
      cv.say({ event: 'stats', id: hid, dir: 'recv', fps: 60, kbps: 8000, width: 1354, height: 1440 });
      vi.advanceTimersByTime(2_999);
      expect(layer.rings).toEqual(['CLNTrecv_ABCDEFG', null]);
      vi.advanceTimersByTime(1);
      expect(layer.rings).toEqual(['CLNTrecv_ABCDEFG', null, 'CLNTrecv_ABCDEFG']);
      expect(theaterLines()).toEqual(['media: theater: no native frames from Hosty for 5 s; drawing the Electron frames', 'media: theater: native frames from Hosty for 3 s; drawing the frame ring again']);
      expect(C.mh.status().media?.nativeVideo?.theaterPath).toBe('ring');
      // Leaving lets the ring go, as before.
      await C.mh.leave();
      expect(layer.rings.at(-1)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  }, 15_000);

  it('D2.10 (2026-11-05): voice over the game: the volumes reach the media layer, my table is levelled on my ball, the keys live with the match', async () => {
    type Volume = { voice: number; table: number; note?: string | null };
    const volumes: Volume[] = [];
    const media = {
      attach: async () => undefined,
      addPeer: () => undefined,
      removePeer: () => undefined,
      setSending: () => undefined,
      setPanelState: () => undefined,
      setMuted: () => undefined,
      status: () => ({ attached: false, sending: false, peers: {}, mic: 'unavailable' as const, captureSource: null, lastError: null }),
      onStatus: () => () => undefined,
      frames: () => null,
      showPanel: () => undefined,
      setVolume: (v: Volume) => void volumes.push({ ...v }),
      detach: async () => undefined,
    };
    const held = new Map<string, () => void>();
    const shortcuts = {
      register: (acc: string, cb: () => void) => {
        if (acc === 'Control+Alt+Down') return false; // another app holds it: logged, the rest still work
        held.set(acc, cb);
        return true;
      },
      unregister: (acc: string) => void held.delete(acc),
    };
    const withPid = (sha: string, pid: number): WitnessHost => ({ ...witness(sha), vpxPid: () => pid }) as unknown as WitnessHost;
    const ha = fakeAudio();
    const ca = fakeAudio();
    const H = make('vol-host', 'ab'.repeat(32), { witness: withPid('ab'.repeat(32), 111), tableAudio: ha.ta, media: media as never, shortcuts });
    const C = make('vol-client', 'ab'.repeat(32), { witness: withPid('ab'.repeat(32), 222), tableAudio: ca.ta });
    // The defaults reach the media layer at creation; a Match tab change goes live and is saved.
    expect(volumes).toEqual([{ voice: 150, table: 100, note: null }]);
    expect(held.size).toBe(0);
    H.mh.setSettings({ voiceVolume: 120, othersTableVolume: 60, myTableWhileUp: 40 });
    expect(volumes.at(-1)).toEqual({ voice: 120, table: 60, note: null });
    expect(ha.levels()).toEqual([]); // no match: nothing levelled
    const port = 43000 + Math.floor(Math.random() * 2000);
    const hs = await H.mh.host({ port, ballsPerGame: 3, displayName: 'Hosty' });
    // D8.10: the menu's two keys are held with them.
    expect([...held.keys()].sort()).toEqual(['Control+Alt+K', 'Control+Alt+Left', 'Control+Alt+M', 'Control+Alt+Right', 'Control+Alt+Up']);
    await C.mh.join(hs.invite!, 'Krobs');
    await H.mh.start();
    await until(() => H.mh.status().phase === 'playing' && H.mh.status().panel?.myTurn === true);
    // The host's ball: its VPX goes to 40 %; the client's (not up) is not levelled.
    await until(() => ha.levels().at(-1) === 'level 111 40');
    expect(ca.levels()).toEqual([]);
    // Ctrl+Alt+Right: 50 %, saved, pushed with a note, the helper told; Ctrl+Alt+Up: the voice 130 %.
    held.get('Control+Alt+Right')!();
    expect(H.mh.status().settings.myTableWhileUp).toBe(50);
    expect(volumes.at(-1)).toEqual({ voice: 120, table: 60, note: 'My table 50 %' });
    expect(ha.levels().at(-1)).toBe('level 111 50');
    held.get('Control+Alt+Up')!();
    expect(H.mh.status().settings.voiceVolume).toBe(130);
    expect(volumes.at(-1)).toEqual({ voice: 130, table: 60, note: 'Voice 130 %' });
    // At the limit the press is harmless.
    for (let i = 0; i < 40; i++) held.get('Control+Alt+Up')!();
    expect(H.mh.status().settings.voiceVolume).toBe(300);
    // 100 % on the Match tab: the level is lifted while still up.
    H.mh.setSettings({ myTableWhileUp: 100 });
    expect(ha.levels().at(-1)).toBe('unlevel');
    H.mh.setSettings({ myTableWhileUp: 70 });
    expect(ha.levels().at(-1)).toBe('level 111 70');
    // Leaving lifts it and releases the keys.
    await H.mh.leave();
    expect(ha.levels().at(-1)).toBe('unlevel');
    expect(held.size).toBe(0);
    const saved = JSON.parse(readFileSync(join(dirs[dirs.length - 2]!, 'match.json'), 'utf8')) as { voiceVolume: number; myTableWhileUp: number };
    expect(saved).toMatchObject({ voiceVolume: 300, myTableWhileUp: 70 });
  }, 15_000);

  it('D2.9: the TURN relay is saved in media.json; the status shows url and username, never the credential', () => {
    const dir = mkdtempSync(join(tmpdir(), 'castcade-match-turn-'));
    dirs.push(dir);
    const file = join(dir, 'media.json');
    const { mh } = make('turn', 'ab'.repeat(32), { mediaSettings: createMediaSettingsStore(file) });
    expect(mh.status().turn).toBeNull();
    const set = mh.setTurn({ url: ' turn:relay.example.org:3478 ', username: 'castcade', credential: 's3cret' });
    expect(set.turn).toEqual({ url: 'turn:relay.example.org:3478', username: 'castcade', credentialSet: true });
    expect(JSON.stringify(set)).not.toContain('s3cret');
    // a null credential keeps the saved one
    mh.setTurn({ url: 'turns:relay.example.org:5349', username: 'castcade', credential: null });
    expect(createMediaSettingsStore(file).get().turn).toEqual({ url: 'turns:relay.example.org:5349', username: 'castcade', credential: 's3cret' });
    expect(() => mh.setTurn({ url: 'http://relay.example.org', username: 'u', credential: 'c' })).toThrow(/turn: or turns:/);
    expect(createMediaSettingsStore(file).get().turn?.url).toBe('turns:relay.example.org:5349');
    expect(mh.setTurn(null).turn).toBeNull();
    expect(mh.setTurn({ url: '  ', username: 'x', credential: 'y' }).turn).toBeNull();
    expect(createMediaSettingsStore(file).get().turn).toBeNull();
  });

  it('microphone and mute: saved in media.json and live on the media layer when there is one (D2)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'castcade-match-mic-'));
    dirs.push(dir);
    const file = join(dir, 'media.json');
    const bare = make('bare', 'ab'.repeat(32), { mediaSettings: createMediaSettingsStore(file) });
    expect(bare.mh.status()).toMatchObject({ microphones: [], micDeviceId: null, muted: false });
    expect(bare.mh.setMicrophone('headset-1')).toMatchObject({ micDeviceId: 'headset-1' });
    expect(bare.mh.setMuted(true)).toMatchObject({ muted: true });
    expect(createMediaSettingsStore(file).get()).toMatchObject({ micDeviceId: 'headset-1', muted: true });
    expect(bare.mh.setMicrophone(null).micDeviceId).toBeNull();

    const calls: string[] = [];
    const settings = createMediaSettingsStore(join(dir, 'media2.json'));
    let onMics: (() => void) | null = null;
    const media = {
      microphones: () => [{ deviceId: 'headset-1', label: 'Headset' }],
      onMicrophones: (cb: () => void) => {
        onMics = cb;
        return () => undefined;
      },
      setMicrophone: (id: string | null) => {
        calls.push(`mic ${id}`);
        settings.patch({ micDeviceId: id });
      },
      setMuted: (m: boolean) => {
        calls.push(`muted ${m}`);
        settings.patch({ muted: m });
      },
      onStatus: () => () => undefined,
      status: () => null,
    } as unknown as NonNullable<Parameters<typeof createMatchHost>[0]['media']>;
    const live = make('live', 'ab'.repeat(32), { media, mediaSettings: settings });
    const seen: number[] = [];
    live.mh.onStatus((st) => seen.push(st.microphones.length));
    expect(live.mh.status().microphones).toEqual([{ deviceId: 'headset-1', label: 'Headset' }]);
    live.mh.setMicrophone('headset-1');
    live.mh.setMuted(true);
    expect(calls).toEqual(['mic headset-1', 'muted true']);
    expect(live.mh.status()).toMatchObject({ micDeviceId: 'headset-1', muted: true });
    seen.length = 0;
    (onMics as (() => void) | null)?.();
    expect(seen).toEqual([1]);
  });

  it('D2.6 (2026-11-01): Show panel / Hide panel reach the media layer and push a status; without a media layer or a hide hook they are no-ops', () => {
    const calls: string[] = [];
    const media = {
      showPanel: () => calls.push('show'),
      hidePanel: () => calls.push('hide'),
      onStatus: () => () => undefined,
      status: () => null,
    } as unknown as NonNullable<Parameters<typeof createMatchHost>[0]['media']>;
    const live = make('panel', 'ab'.repeat(32), { media });
    let pushed = 0;
    live.mh.onStatus(() => pushed++);
    expect(live.mh.showPanel()).toMatchObject({ role: 'none' });
    expect(live.mh.hidePanel()).toMatchObject({ role: 'none' });
    expect(calls).toEqual(['show', 'hide']);
    expect(pushed).toBe(2);
    const bare = make('panel-bare', 'ab'.repeat(32));
    expect(() => bare.mh.showPanel()).not.toThrow();
    expect(() => bare.mh.hidePanel()).not.toThrow();
    const noHide = make('panel-nohide', 'ab'.repeat(32), { media: { ...media, hidePanel: undefined } as unknown as typeof media });
    expect(() => noHide.mh.hidePanel()).not.toThrow();
  });
});

// ---- A6 (2026-10-31): the rig decision at host / join, and the late switch into the headset ----

type MediaOpt = NonNullable<Parameters<typeof createMatchHost>[0]['media']>;
type OverlayOpt = NonNullable<Parameters<typeof createMatchHost>[0]['vrOverlay']>;
type WStatus = ReturnType<WitnessHost['status']>;

type Vr = { inVr: boolean; runtime: string | null; runtimeLoaded: boolean; compositorRunning: boolean; vrCapableBuild: boolean; activeOpenXrRuntime: string | null; sampledAt: string };
const VR_ON: Vr = { inVr: true, runtime: 'steamvr', runtimeLoaded: true, compositorRunning: true, vrCapableBuild: true, activeOpenXrRuntime: null, sampledAt: '2026-10-31T06:07:47.000Z' };
const VR_OFF: Vr = { inVr: false, runtime: null, runtimeLoaded: false, compositorRunning: true, vrCapableBuild: true, activeOpenXrRuntime: null, sampledAt: '2026-10-31T06:07:40.000Z' };
/** B22: the owner's rig, VPX on Virtual Desktop's OpenXR runtime (no vrclient, no SteamVR). */
const VD_JSON = 'C:\\Program Files\\Virtual Desktop Streamer\\OpenXR\\virtualdesktop-openxr.json';
const VR_VD: Vr = { inVr: true, runtime: 'virtual-desktop', runtimeLoaded: false, compositorRunning: false, vrCapableBuild: true, activeOpenXrRuntime: VD_JSON, sampledAt: '2026-10-31T06:07:50.000Z' };

/** A witness whose status the test changes and announces, and whose live probe answers `live`. */
function liveWitness(live: Vr | null, vr: Vr | null = VR_OFF) {
  const listeners = new Set<(s: WStatus) => void>();
  let attestation: { vr: Vr | null } | null = vr ? { vr } : null;
  const status = (): WStatus => ({ paired: false, currentTable: 'Monster Bash', currentIdentity: { sha256: 'ab'.repeat(32), tableInfo: null }, currentAttestation: attestation }) as unknown as WStatus;
  const w = {
    status,
    sampleVr: async () => live,
    onEvent: () => () => undefined,
    onStatus: (cb: (s: WStatus) => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  } as unknown as WitnessHost;
  return {
    w,
    /** The witness re-sampled (table_loaded) and emitted its status. */
    setVr(next: Vr | null) {
      attestation = { vr: next };
      for (const l of listeners) l(status());
    },
  };
}

/** `RtcHost` as the match host sees it: records calls; frames only from an offscreen (VR) panel. */
function fakeMedia() {
  const calls: string[] = [];
  let vr = false;
  let attached = false;
  const source = { onFrame: () => () => undefined };
  const video = { onFrame: () => () => undefined, setWanted: () => undefined };
  const media = {
    async attach(_sig: unknown, peers: string[]) {
      attached = true;
      calls.push(`attach ${vr ? 'vr' : 'desktop'} ${peers.length}`);
    },
    addPeer: () => undefined,
    removePeer: () => undefined,
    setSending: () => undefined,
    setPanelState: () => undefined,
    setMuted: () => undefined,
    status: () => ({ attached, sending: false, peers: {}, mic: 'open', captureSource: null, lastError: null }),
    onStatus: () => () => undefined,
    frames: () => (attached && vr ? source : null),
    videoFrames: () => (attached && vr ? video : null),
    showPanel: () => {
      if (!vr) calls.push('showPanel');
    },
    async detach() {
      attached = false;
      calls.push('detach');
    },
    async setVr(rig: { inVr: boolean; headsetPanel: boolean }) {
      // `setVr true` / `false`: the panel window kind; ` (in VR)` marks a VR rig with a desktop panel (B22).
      calls.push(`setVr ${rig.headsetPanel}${rig.inVr && !rig.headsetPanel ? ' (in VR)' : ''}`);
      // As RtcHost: headset -> desktop while attached is ignored.
      if (attached && !rig.headsetPanel) return;
      vr = rig.headsetPanel;
    },
    refreshMicrophones: async () => {
      calls.push('refreshMicrophones');
    },
  };
  return { media: media as unknown as MediaOpt, calls, source, video };
}

function fakeOverlay() {
  const started: unknown[] = [];
  const videos: unknown[] = [];
  const modes: string[] = [];
  /** D10.3.8: every `setVideoRing` as the OpenXR layer would hear it (a token, or null for the pipe frames), changes only. */
  const rings: Array<string | null> = [];
  let stops = 0;
  let state: 'stopped' | 'showing' = 'stopped';
  const overlay = {
    setVideoRing: (token: string | null) => {
      if (rings.length === 0 || rings.at(-1) !== token) rings.push(token);
    },
    async start(src: unknown, video?: unknown) {
      started.push(src);
      videos.push(video ?? null);
      state = 'showing';
      return { state, reason: null };
    },
    async stop() {
      stops++;
      state = 'stopped';
    },
    status: () => ({ state, reason: null }),
    onStatus: () => () => undefined,
    setMode: (m: string) => void modes.push(m),
  };
  return { overlay: overlay as unknown as OverlayOpt, started, videos, modes, rings, stops: () => stops };
}

describe('match host: the rig (A6, 2026-10-31)', () => {
  const port = (): number => 43000 + Math.floor(Math.random() * 2000);
  const logLines = (): { log: Logger; lines: string[] } => {
    const lines: string[] = [];
    const push = (l: string): number => lines.push(l);
    return { log: { info: push, warn: push, error: push, file: '' } as unknown as Logger, lines };
  };

  it('host: the running VPX probed now says VR → offscreen panel and the overlay at once, whatever the stale attestation said', async () => {
    const wit = liveWitness(VR_ON, VR_OFF);
    const m = fakeMedia();
    const o = fakeOverlay();
    const { log, lines } = logLines();
    const H = make('vr', 'ab'.repeat(32), { witness: wit.w, media: m.media, vrOverlay: o.overlay, log });
    const st = await H.mh.host({ port: port(), ballsPerGame: 3, displayName: 'Owner' });
    expect(m.calls).toEqual(['setVr true', 'attach vr 0']);
    expect(o.started).toEqual([m.source]);
    expect(st).toMatchObject({ rig: 'vr_headset', rigReason: 'VPX probed now: vrclient loaded, compositor running', vrOverlay: { state: 'showing' } });
    expect(st.participants[0]?.rig).toBe('vr_headset');
    expect(lines).toContain('match: rig vr_headset via steamvr (VPX probed now: vrclient loaded, compositor running)');
  });

  it('host on the monitor reading, then the witness reads VR (table_loaded): the panel moves into the headset and the overlay starts; the reverse is ignored', async () => {
    const wit = liveWitness(null, VR_OFF);
    const m = fakeMedia();
    const o = fakeOverlay();
    const { log, lines } = logLines();
    const H = make('late', 'ab'.repeat(32), { witness: wit.w, media: m.media, vrOverlay: o.overlay, log });
    const st = await H.mh.host({ port: port(), ballsPerGame: 3, displayName: 'Owner' });
    expect(st).toMatchObject({ rig: 'pc', rigReason: "the witness's sample at 2026-10-31T06:07:40.000Z: vrclient not loaded, compositor running" });
    expect(m.calls).toEqual(['setVr false', 'attach desktop 0', 'showPanel']);
    expect(o.started).toEqual([]);

    const seen: string[] = [];
    H.mh.onStatus((s) => seen.push(s.rig));
    wit.setVr(VR_ON);
    await until(() => o.started.length === 1);
    expect(m.calls.slice(3)).toEqual(['setVr true']);
    expect(o.started).toEqual([m.source]);
    expect(H.mh.status()).toMatchObject({ rig: 'vr_headset', vrOverlay: { state: 'showing' } });
    expect(H.mh.status().rigReason).toMatch(/^switched after hosting: the witness's sample at .*: vrclient loaded, compositor running$/);
    expect(seen).toContain('vr_headset');
    expect(lines.some((l) => l.startsWith('match: rig vr_headset (switched after hosting'))).toBe(true);

    // A second VR status: nothing more. VR -> monitor: logged once, the headset panel stays.
    wit.setVr(VR_ON);
    wit.setVr(VR_OFF);
    wit.setVr(VR_OFF);
    await new Promise((r) => setTimeout(r, 20));
    expect(o.started).toHaveLength(1);
    expect(m.calls.slice(3)).toEqual(['setVr true']);
    expect(H.mh.status().rig).toBe('vr_headset');
    expect(lines.filter((l) => l.includes('the panel stays in the headset'))).toHaveLength(1);
  });

  it('D7.4.3 (2026-11-01): the preview setting reaches the media layer at start and on change; the advice reads the declared stereo', async () => {
    const wit = liveWitness(VR_VD, VR_VD);
    const m = fakeMedia();
    const told: string[] = [];
    let media = { captureCrop: { width: 1920, height: 1080 }, captureStereo: 'sbs' as 'sbs' | 'mono' | null };
    const base = m.media as unknown as Record<string, unknown> & { status: () => Record<string, unknown> };
    const withStereo = {
      ...base,
      status: () => ({ ...base.status(), ...media }),
      setPreviewStereo: (s: string) => void told.push(s),
    } as unknown as MediaOpt;
    const H = make('stereo', 'ab'.repeat(32), { witness: wit.w, media: withStereo });
    expect(told).toEqual(['auto']);
    expect(H.mh.status().previewAdvice).toBeNull(); // no match: no picture sent
    await H.mh.host({ port: port(), ballsPerGame: 3, displayName: 'Owner' });
    // D8.7 (ADR 0009): both eyes gets told to set one eye, whatever the window; one eye is right and gets nothing.
    expect(H.mh.status().previewAdvice).toMatch(/^You are sending both eyes side by side/);
    media = { captureCrop: { width: 1440, height: 1392 }, captureStereo: 'sbs' };
    expect(H.mh.status().previewAdvice).toMatch(/^You are sending both eyes side by side/);
    media = { captureCrop: { width: 1280, height: 720 }, captureStereo: 'mono' };
    expect(H.mh.status().previewAdvice).toBeNull();
    H.mh.setSettings({ previewStereo: 'sbs' });
    H.mh.setSettings({ previewStereo: 'sbs' });
    expect(told).toEqual(['auto', 'sbs']);
    expect(H.mh.status().settings.previewStereo).toBe('sbs');
  });

  it('no VPX open and no sample: the monitor, said so; no match shows the witness reading', async () => {
    const wit = liveWitness(null, null);
    const m = fakeMedia();
    const H = make('none', 'ab'.repeat(32), { witness: wit.w, media: m.media });
    expect(H.mh.status()).toMatchObject({ rig: 'pc', rigReason: 'no match; decided again when you host or join (no VPX table open to probe; monitor assumed)' });
    const st = await H.mh.host({ port: port(), ballsPerGame: 3, displayName: 'Owner' });
    expect(st).toMatchObject({ rig: 'pc', rigReason: 'no VPX table open to probe; monitor assumed', vrRuntime: null });
  });

  it("D7.3 (2026-10-31): VR on Virtual Desktop's OpenXR runtime: offscreen panel into the OpenXR layer, not the SteamVR helper", async () => {
    const wit = liveWitness(VR_VD, VR_OFF);
    const m = fakeMedia();
    const o = fakeOverlay();
    const layer = fakeOverlay();
    const { log, lines } = logLines();
    const H = make('vd', 'ab'.repeat(32), { witness: wit.w, media: m.media, vrOverlay: o.overlay, vrLayer: layer.overlay, log });
    const st = await H.mh.host({ port: port(), ballsPerGame: 3, displayName: 'Owner' });
    expect(m.calls).toEqual(['setVr true', 'attach vr 0']);
    expect(layer.started).toEqual([m.source]);
    // D7.4: the layer gets the video source for theater, and the lobby's mode (the panel) once, before it starts.
    expect(layer.videos).toEqual([m.video]);
    expect(layer.modes).toEqual(['panel']);
    expect(lines).toContain('match: headset mode panel');
    expect(o.started).toEqual([]);
    expect(st).toMatchObject({ rig: 'vr_headset', vrRuntime: 'virtual-desktop', vrOverlay: { state: 'showing' } });
    expect(st.rigReason).toBe(`VPX probed now: Virtual Desktop (OpenXR), vrclient not loaded, compositor not running, active OpenXR runtime ${VD_JSON}`);
    expect(st.participants[0]?.rig).toBe('vr_headset');
    expect(lines.some((l) => l.startsWith('match: rig vr_headset via virtual-desktop ('))).toBe(true);
    expect(lines).toContain('match: VR overlay showing via the OpenXR layer (virtual-desktop)');

    // More VD readings change nothing; a SteamVR reading (VPX restarted through SteamVR) swaps the layer for the helper.
    wit.setVr(VR_VD);
    await new Promise((r) => setTimeout(r, 20));
    expect(m.calls).toHaveLength(2);
    expect(layer.started).toHaveLength(1);
    wit.setVr(VR_ON);
    await until(() => o.started.length === 1);
    expect(layer.stops()).toBe(1);
    expect(o.started).toEqual([m.source]);
    // D7.4: the new overlay is told the mode too (the SteamVR helper ignores anything but the panel).
    expect(o.modes).toEqual(['panel']);
    expect(m.calls.slice(2)).toEqual(['setVr true']);
    expect(H.mh.status()).toMatchObject({ rig: 'vr_headset', vrRuntime: 'steamvr', vrOverlay: { state: 'showing' } });
    await H.mh.leave();
    expect(o.stops()).toBe(1);
    expect(layer.stops()).toBe(1);
  });

  it('D7.3: hosted on the monitor reading, then the witness reads VR on Virtual Desktop: the panel moves into the headset through the layer', async () => {
    const wit = liveWitness(null, VR_OFF);
    const m = fakeMedia();
    const o = fakeOverlay();
    const layer = fakeOverlay();
    const H = make('vd-late', 'ab'.repeat(32), { witness: wit.w, media: m.media, vrOverlay: o.overlay, vrLayer: layer.overlay });
    await H.mh.host({ port: port(), ballsPerGame: 3, displayName: 'Owner' });
    expect(m.calls).toEqual(['setVr false', 'attach desktop 0', 'showPanel']);
    expect(H.mh.status().vrOverlay).toEqual({ state: 'stopped', reason: null }); // the monitor: the SteamVR helper's (idle) status, as before
    wit.setVr(VR_VD);
    await until(() => layer.started.length === 1);
    expect(m.calls.slice(3)).toEqual(['setVr true']);
    expect(o.started).toEqual([]);
    expect(H.mh.status()).toMatchObject({ rig: 'vr_headset', vrRuntime: 'virtual-desktop', vrOverlay: { state: 'showing' } });
  });

  it('D7.3: an OpenXR runtime with no layer set up: no overlay status, and the log says why', async () => {
    const wit = liveWitness(VR_VD, VR_OFF);
    const m = fakeMedia();
    const o = fakeOverlay();
    const { log, lines } = logLines();
    const H = make('vd-nolayer', 'ab'.repeat(32), { witness: wit.w, media: m.media, vrOverlay: o.overlay, log });
    const st = await H.mh.host({ port: port(), ballsPerGame: 3, displayName: 'Owner' });
    expect(o.started).toEqual([]);
    expect(st).toMatchObject({ rig: 'vr_headset', vrRuntime: 'virtual-desktop', vrOverlay: null });
    expect(lines).toContain('match: in VR but no OpenXR layer; showing the desktop panel');
  });

  it('D8.12 (2026-11-15): the corner scoreboard: its page on a layer rig while the setting is on, no corner in the lobby, the setting applied live; never asked of the SteamVR helper', async () => {
    const withBoard = (m: ReturnType<typeof fakeMedia>) => {
      const pages: boolean[] = [];
      let on = false;
      const board = { onFrame: () => () => undefined };
      const base = m.media as unknown as Record<string, unknown> & { frames: () => unknown };
      const media = {
        ...base,
        setScoreboard: (want: boolean) => {
          if (want !== on) pages.push(want);
          on = want;
        },
        scoreboardFrames: () => (on && base.frames() ? board : null),
      } as unknown as MediaOpt;
      return { media, pages, board };
    };
    const asked = (o: ReturnType<typeof fakeOverlay>) => {
      const said: Array<{ frames: unknown; corner: string | null; place: unknown; anchor?: string }> = [];
      (o.overlay as unknown as Record<string, unknown>).setScoreboard = (x: { frames: unknown; corner: string | null; place: unknown; anchor?: string }) => {
        const last = said.at(-1);
        if (!last || last.frames !== x.frames || last.corner !== x.corner || last.place !== x.place || last.anchor !== x.anchor) said.push(x);
      };
      return said;
    };
    // Virtual Desktop: the OpenXR layer. The lobby: the page is up (its first paint is kept), no corner yet.
    const m = fakeMedia();
    const b = withBoard(m);
    const layer = fakeOverlay();
    const said = asked(layer);
    const H = make('board', 'ab'.repeat(32), { witness: liveWitness(VR_VD, VR_OFF).w, media: b.media, vrLayer: layer.overlay });
    await H.mh.host({ port: port(), ballsPerGame: 3, displayName: 'Owner' });
    expect(H.mh.status().settings).toMatchObject({ scoreboard: true, scoreboardCorner: 'top-right' });
    expect(b.pages).toEqual([true]);
    // D8.12.3: fixed in the room is the default, and rides along with every call.
    expect(H.mh.status().settings.scoreboardAnchor).toBe('room');
    expect(said.at(-1)).toEqual({ frames: b.board, corner: null, place: null, anchor: 'room' });
    // Off on the Match tab: the page goes and the layer is told there are no frames; on again: back.
    H.mh.setSettings({ scoreboard: false });
    expect(b.pages).toEqual([true, false]);
    expect(said.at(-1)).toEqual({ frames: null, corner: null, place: null, anchor: 'room' });
    H.mh.setSettings({ scoreboard: true, scoreboardCorner: 'top-left' });
    expect(b.pages).toEqual([true, false, true]);
    expect(said.at(-1)).toEqual({ frames: b.board, corner: null, place: null, anchor: 'room' });
    // The placement knob (match.json; no UI) rides along.
    H.mh.setSettings({ scoreboardPlace: { offset: [0.5, 0.45, 1.2], widthM: 0.4 } } as never);
    expect(said.at(-1)).toEqual({ frames: b.board, corner: null, place: { offset: [0.5, 0.45, 1.2], widthM: 0.4 }, anchor: 'room' });
    // D8.12.3: "Follows my head" on the Match tab reaches the layer at once, and back.
    H.mh.setSettings({ scoreboardAnchor: 'head' });
    expect(said.at(-1)).toEqual({ frames: b.board, corner: null, place: { offset: [0.5, 0.45, 1.2], widthM: 0.4 }, anchor: 'head' });
    H.mh.setSettings({ scoreboardAnchor: 'room' });
    expect(said.at(-1)?.anchor).toBe('room');
    await H.mh.leave();

    // SteamVR: the helper draws the panel only; no scoreboard page is opened for it.
    const m2 = fakeMedia();
    const b2 = withBoard(m2);
    const helper = fakeOverlay();
    const H2 = make('board-steam', 'ab'.repeat(32), { witness: liveWitness(VR_ON, VR_OFF).w, media: b2.media, vrOverlay: helper.overlay });
    await H2.mh.host({ port: port(), ballsPerGame: 3, displayName: 'Owner' });
    expect(helper.started).toHaveLength(1);
    expect(b2.pages).toEqual([]);
    await H2.mh.leave();
  });

  it('B22: the Match tab opening lists the microphones when no match runs, never during one', async () => {
    const m = fakeMedia();
    const H = make('mics', 'ab'.repeat(32), { witness: liveWitness(null, null).w, media: m.media });
    H.mh.refreshMicrophones();
    expect(m.calls).toEqual(['refreshMicrophones']);
    await H.mh.host({ port: port(), ballsPerGame: 3, displayName: 'Owner' });
    H.mh.refreshMicrophones();
    expect(m.calls.filter((c) => c === 'refreshMicrophones')).toHaveLength(1);
    // A bare media layer (no picker) is fine.
    make('mics-bare', 'ab'.repeat(32)).mh.refreshMicrophones();
  });
});

// ---- A6 (2026-10-31): the lobby refresh of the rig and the table (the first two-player match) ----

/** A witness with no table until `load`: then a table (sha) and a VR sample, announced like a `table_loaded` status. */
function loadingWitness() {
  const listeners = new Set<(s: WStatus) => void>();
  let table: { sha: string; vr: Vr | null } | null = null;
  const status = (): WStatus =>
    ({
      paired: false,
      currentTable: table ? 'Monster Bash' : null,
      currentIdentity: table ? { sha256: table.sha, tableInfo: null } : null,
      currentAttestation: table?.vr ? { vr: table.vr } : null,
    }) as unknown as WStatus;
  const w = {
    status,
    // The live probe reads the running VPX: nothing before the table opens.
    sampleVr: async () => table?.vr ?? null,
    onEvent: () => () => undefined,
    onStatus: (cb: (s: WStatus) => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  } as unknown as WitnessHost;
  return {
    w,
    load(sha: string, vr: Vr | null) {
      table = { sha, vr };
      for (const l of listeners) l(status());
    },
  };
}

describe('match host: the lobby refresh (A6, 2026-10-31)', () => {
  const port = (): number => 45000 + Math.floor(Math.random() * 2000);
  const row = (mh: MatchHost, name: string) => mh.status().participants.find((p) => p.name === name);

  it('a client whose table loads after joining: the right rig and no false mismatch on both sides; a real mismatch still flags; after the start nothing changes', async () => {
    const H = make('lobby-host', 'ab'.repeat(32));
    const krobs = loadingWitness();
    const C = make('lobby-client', 'ab'.repeat(32), { witness: krobs.w });
    const hs = await H.mh.host({ port: port(), ballsPerGame: 3, displayName: 'Owner' });
    await C.mh.join(hs.invite!, 'Krobs');
    await until(() => H.mh.status().participants.length === 2);
    // As in the match: joined before the table loaded.
    expect(row(H.mh, 'Krobs')).toMatchObject({ rig: 'pc', tableMatch: false });
    expect(row(C.mh, 'Krobs')).toMatchObject({ rig: 'pc', tableMatch: false });

    krobs.load('ab'.repeat(32), VR_VD);
    await until(() => row(H.mh, 'Krobs')?.rig === 'vr_headset' && row(H.mh, 'Krobs')?.tableMatch === true);
    await until(() => row(C.mh, 'Krobs')?.rig === 'vr_headset' && row(C.mh, 'Krobs')?.tableMatch === true);
    expect(C.mh.status().rig).toBe('vr_headset');
    expect(H.mh.status().panel?.message).toBe('Everyone in? Start a game on your table (or press Start match)');
    expect(C.mh.status().panel?.message).toBe('Waiting for Owner to start a game on the table');

    // A different table file is still a difference.
    krobs.load('cd'.repeat(32), VR_VD);
    await until(() => row(H.mh, 'Krobs')?.tableMatch === false && row(C.mh, 'Krobs')?.tableMatch === false);
    expect(H.mh.status().panel?.message).toBe('same table, different file (a re-save or another download): Krobs');

    // After MATCH_READY the roster is final: a table load changes nothing.
    await H.mh.start();
    await until(() => C.mh.status().phase === 'playing');
    krobs.load('ab'.repeat(32), VR_VD);
    await new Promise((r) => setTimeout(r, 100));
    expect(row(H.mh, 'Krobs')).toMatchObject({ rig: 'vr_headset', tableMatch: false });
    expect(row(C.mh, 'Krobs')).toMatchObject({ rig: 'vr_headset', tableMatch: false });
  }, 15_000);

  it("the host's own table loads after hosting: its row and the client's flag follow", async () => {
    const owner = loadingWitness();
    const H = make('lobby-host2', 'ab'.repeat(32), { witness: owner.w });
    const C = make('lobby-client2', 'ab'.repeat(32));
    const hs = await H.mh.host({ port: port(), ballsPerGame: 3, displayName: 'Owner' });
    await C.mh.join(hs.invite!, 'Krobs');
    await until(() => H.mh.status().participants.length === 2);
    expect(row(H.mh, 'Krobs')?.tableMatch).toBe(false);
    expect(row(C.mh, 'Owner')?.rig).toBe('pc');

    owner.load('ab'.repeat(32), VR_ON);
    await until(() => row(H.mh, 'Krobs')?.tableMatch === true && row(C.mh, 'Krobs')?.tableMatch === true);
    await until(() => row(C.mh, 'Owner')?.rig === 'vr_headset');
    expect(row(H.mh, 'Owner')?.rig).toBe('vr_headset');
  }, 15_000);

  it('A6.1 (2026-11-01): a rig that reads VR only after Start is told to the others (the host\'s own and a client\'s); the table is not', async () => {
    const owner = loadingWitness();
    const krobs = loadingWitness();
    const H = make('late-host', 'ab'.repeat(32), { witness: owner.w });
    const C = make('late-client', 'ab'.repeat(32), { witness: krobs.w });
    const hs = await H.mh.host({ port: port(), ballsPerGame: 3, displayName: 'Owner' });
    await C.mh.join(hs.invite!, 'Krobs');
    await until(() => H.mh.status().participants.length === 2);
    await H.mh.start();
    await until(() => C.mh.status().phase === 'playing');
    expect(row(C.mh, 'Owner')?.rig).toBe('pc');

    // The owner's table finished loading in the headset 7 s after Start (TLBHMU).
    owner.load('ab'.repeat(32), VR_VD);
    await until(() => row(C.mh, 'Owner')?.rig === 'vr_headset');
    expect(row(H.mh, 'Owner')?.rig).toBe('vr_headset');
    expect(H.mh.status().panel?.players.find((p) => p.name === 'Owner')?.rig).toBe('vr_headset');
    expect(C.mh.status().panel?.players.find((p) => p.name === 'Owner')?.rig).toBe('vr_headset');

    // And a client's, on another table file: the rig goes, the fingerprint in the log stays.
    const flag = row(H.mh, 'Krobs')?.tableMatch;
    krobs.load('cd'.repeat(32), VR_VD);
    await until(() => row(H.mh, 'Krobs')?.rig === 'vr_headset');
    await until(() => row(C.mh, 'Krobs')?.rig === 'vr_headset');
    expect(row(H.mh, 'Krobs')?.tableMatch).toBe(flag); // as MATCH_READY said
  }, 15_000);
});

describe('match host: A8 (2026-10-31)', () => {
  const port = (): number => 47000 + Math.floor(Math.random() * 2000);
  const row = (mh: MatchHost, name: string) => mh.status().participants.find((p) => p.name === name);
  /** Resolves when a TCP connection to the port opens, rejects when it is refused. */
  const probe = (p: number): Promise<void> =>
    new Promise((resolve, reject) => {
      const s = createConnection({ host: '127.0.0.1', port: p });
      s.once('connect', () => {
        s.destroy();
        resolve();
      });
      s.once('error', reject);
    });

  it('the listener opens only after the panel is up and the public-IP lookup answered; the invite comes with it', async () => {
    let answer: (ip: string | null) => void = () => undefined;
    const ip = new Promise<string | null>((r) => (answer = r));
    const shown: string[] = [];
    const media = {
      attach: () => Promise.resolve(),
      addPeer: () => undefined,
      removePeer: () => undefined,
      setSending: () => undefined,
      setPanelState: () => undefined,
      setMuted: () => undefined,
      status: () => ({ attached: true, sending: false, peers: {}, mic: 'open' as const, captureSource: null, lastError: null }),
      onStatus: () => () => undefined,
      frames: () => null,
      showPanel: () => shown.push('panel'),
      detach: () => Promise.resolve(),
    };
    const H = make('order-host', 'ab'.repeat(32), { publicIp: () => ip, media });
    const p = port();
    const hosting = H.mh.host({ port: p, ballsPerGame: 3, displayName: 'Owner' });
    await new Promise((r) => setTimeout(r, 50));
    // Still waiting for the address: nobody can connect, no invite, no panel yet.
    await expect(probe(p)).rejects.toThrow();
    expect(H.mh.status().invite).toBeNull();
    expect(shown).toEqual([]);
    answer(null);
    const hs = await hosting;
    expect(shown).toEqual(['panel']);
    expect(hs.ipSource).toBe('lan');
    expect(hs.invite).toMatch(new RegExp(`:${p}#[A-Z]{6}$`));
    await probe(p);
  }, 15_000);

  it('a port already in use: the half-built match is torn down, and hosting again works', async () => {
    const blocker = createServer();
    const p = port();
    await new Promise<void>((r) => blocker.listen(p, '127.0.0.1', () => r()));
    try {
      const H = make('busy-host', 'ab'.repeat(32));
      await expect(H.mh.host({ port: p, ballsPerGame: 3, displayName: 'Owner' })).rejects.toThrow(/already in use/);
      expect(H.mh.status()).toMatchObject({ role: 'none', phase: 'none', invite: null, locked: false });
      const hs = await H.mh.host({ port: port(), ballsPerGame: 3, displayName: 'Owner' });
      expect(hs.role).toBe('host');
    } finally {
      blocker.close();
    }
  }, 15_000);

  it('3 players: the client with the same table sees the other client flagged "different table file"', async () => {
    const H = make('three-host', 'ab'.repeat(32));
    const A = make('three-a', 'cd'.repeat(32));
    const B = make('three-b', 'ab'.repeat(32));
    const hs = await H.mh.host({ port: port(), ballsPerGame: 3, displayName: 'Owner' });
    await A.mh.join(hs.invite!, 'Krobs');
    await B.mh.join(hs.invite!, 'Third');
    await until(() => B.mh.status().participants.length === 3 && A.mh.status().participants.length === 3);
    expect(row(B.mh, 'Krobs')).toMatchObject({ tableMatch: false, tableNote: 'same table, different file (a re-save or another download)' });
    expect(row(B.mh, 'Third')?.tableMatch).toBe(true);
    expect(row(A.mh, 'Krobs')?.tableMatch).toBe(false);
    expect(row(A.mh, 'Third')?.tableMatch).toBe(true);
    expect(row(H.mh, 'Krobs')?.tableMatch).toBe(false);
    expect(H.mh.status().transfer).toBeNull();
    // Resume is the host's, and only for a pause.
    await expect(B.mh.resume()).rejects.toThrow(/Only the host/);
    await expect(H.mh.resume()).rejects.toThrow(/not paused/);
  }, 15_000);
});

describe('match host: a series (A10, 2026-11-02)', () => {
  type Feed = Parameters<Parameters<WitnessHost['onEvent']>[0]>[0];
  /** A witness whose detector events the test feeds by hand. */
  const feeding = (sha: string): { w: WitnessHost; feed: (ev: Feed) => void } => {
    const cbs: ((ev: Feed) => void)[] = [];
    const w = { ...witness(sha), onEvent: (cb: (ev: Feed) => void) => (cbs.push(cb), () => undefined) } as unknown as WitnessHost;
    return { w, feed: (ev) => cbs.forEach((cb) => cb(ev)) };
  };
  const scores = (s: number): Feed => ({ kind: 'current_scores', t: 0, scores: [s], player: 1, ball: 1 }) as Feed;
  const ballEnd = (ball: number): Feed => ({ kind: 'ball_end', t: 0, player: 1, ball, extraBalls: 0 }) as Feed;

  it('Start match, then Next game (the same call) between games; the host leaving between games is End match for everyone', async () => {
    const hw = feeding('ab'.repeat(32));
    const cw = feeding('ab'.repeat(32));
    const H = make('series-host', 'ab'.repeat(32), { witness: hw.w });
    const C = make('series-client', 'ab'.repeat(32), { witness: cw.w });
    const port = 43000 + Math.floor(Math.random() * 2000);
    const hs = await H.mh.host({ port, ballsPerGame: 3, displayName: 'Hosty' });
    await C.mh.join(hs.invite!, 'Krobs');
    await until(() => H.mh.status().participants.length === 2);
    await H.mh.start();
    const playGame = async (base: number): Promise<void> => {
      for (let ball = 1; ball <= 3; ball++) {
        for (const [who, seat] of [
          ['Hosty', hw],
          ['Krobs', cw],
        ] as const) {
          const mh = who === 'Hosty' ? H.mh : C.mh;
          await until(() => mh.status().panel?.myTurn === true && mh.status().panel?.ball === ball);
          const s = base * ball + (who === 'Hosty' ? 10 : 20);
          seat.feed(scores(s));
          seat.feed(ballEnd(ball));
          seat.feed(scores(s));
          await until(() => mh.status().panel?.myTurn !== true || mh.status().phase === 'over');
        }
      }
      await until(() => H.mh.status().phase === 'over' && C.mh.status().phase === 'over');
    };
    await playGame(1000);
    expect(H.mh.status()).toMatchObject({ phase: 'over', locked: false, series: { game: 1, over: false, nextGameBlocker: null } });
    expect(C.mh.status()).toMatchObject({ phase: 'over', locked: true, series: { game: 1, over: false } });
    expect(existsSync(C.lock)).toBe(true);
    // A client cannot start the next game.
    await expect(C.mh.start()).rejects.toThrow(/Only the host/);
    const next = await H.mh.start();
    expect(next.series).toMatchObject({ game: 2, over: false });
    await until(() => C.mh.status().series?.game === 2 && C.mh.status().phase === 'playing');
    await playGame(2000);
    expect(C.mh.status().panel?.series?.map((x) => x.games)).toEqual([2, 2]);
    // End match: the host tears down at once; the client's series is over and its table free.
    const left = await H.mh.leave();
    expect(left).toMatchObject({ role: 'none' });
    await until(() => C.mh.status().series?.over === true);
    expect(C.mh.status()).toMatchObject({ phase: 'over', locked: false });
    expect(existsSync(C.lock)).toBe(false);
    expect(C.mh.status().panel?.message).toBe('The host ended the match after 2 games');
  }, 20_000);
});

describe('match host: the VR test bench (D7.6.1, 2026-11-03)', () => {
  it('vrBench mirrors the layer (null without one); setVrTest reaches the layer', () => {
    expect(make('bench-none', 'ab'.repeat(32)).mh.status().vrBench).toBeNull();
    const tests: Array<string | null> = [];
    let test: 'pattern' | null = null;
    const layer = {
      ...(fakeOverlay().overlay as unknown as Record<string, unknown>),
      bench: () => ({ started: true, connected: true, protocol: 3, session: null, controls: [], test }),
      onBench: () => () => undefined,
      setTest: (t: 'pattern' | null) => {
        tests.push(t);
        test = t;
      },
    } as unknown as OverlayOpt;
    const H = make('bench', 'ab'.repeat(32), { vrLayer: layer });
    expect(H.mh.status().vrBench).toEqual({ connected: true, protocol: 3, pattern: false });
    expect(H.mh.setVrTest('pattern').vrBench).toEqual({ connected: true, protocol: 3, pattern: true });
    H.mh.setVrTest(null);
    expect(tests).toEqual(['pattern', null]);
  });
});

describe('match host: the settings migration (D8.1, 2026-11-05)', () => {
  it('a match.json from 0.2.35 (no settingsVersion, screen capture by hand) is set to the VR layer, one eye, once, and saved at version 2; a current file is left alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'castcade-match-migrate-'));
    dirs.push(dir);
    const file = join(dir, 'match.json');
    writeFileSync(file, '{"v":1,"port":27401,"ballsPerGame":3,"displayName":"Krobs","cueVolume":80,"theaterScale":0.8,"cameraSource":"screen","cameraView":"window"}\n');
    const media = { setCameraEyes: vi.fn(), setCameraSource: vi.fn(), onStatus: () => () => undefined, status: () => null };
    const a = make('migrate', 'ab'.repeat(32), { file, media: media as never });
    expect(a.mh.status().settings).toMatchObject({ displayName: 'Krobs', theaterScale: 0.8, cameraView: 'window', cameraSource: 'layer', cameraEyes: 'one', settingsVersion: 2 });
    expect(media.setCameraSource).toHaveBeenCalledWith('layer');
    expect(media.setCameraEyes).toHaveBeenCalledWith('one');
    const saved = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(saved).toMatchObject({ settingsVersion: 2, cameraSource: 'layer', cameraEyes: 'one', theaterScale: 0.8 });
    // The player goes back to the screen capture, both eyes: a second start keeps that (version 2 is not migrated again).
    a.mh.setSettings({ cameraSource: 'screen', cameraEyes: 'both' });
    expect(media.setCameraEyes).toHaveBeenLastCalledWith('both');
    const b = make('migrate2', 'ab'.repeat(32), { file });
    expect(b.mh.status().settings).toMatchObject({ cameraSource: 'screen', cameraEyes: 'both', settingsVersion: 2 });
  });
});

describe('match host: tables that cannot report ball ends (A13, 2026-11-12)', () => {
  type WStatus = ReturnType<WitnessHost['status']>;
  const DARK = "Dark Chaos is an original table (no ROM). Castcade can't read an original's score yet.";
  /** A witness whose open table is followed live or not (`captureMode`), switchable like a table change. */
  const capturing = (sha: string, mode: 'live' | 'basic') => {
    const listeners = new Set<(s: WStatus) => void>();
    let now = mode;
    const status = (): WStatus =>
      ({
        paired: false,
        currentTable: 'Dark Chaos',
        currentIdentity: { sha256: sha, tableInfo: null },
        currentAttestation: null,
        captureMode: now,
        note: now === 'basic' ? DARK : null,
      }) as unknown as WStatus;
    const w = {
      status,
      sampleVr: async () => null,
      onEvent: () => () => undefined,
      onStatus: (cb: (s: WStatus) => void) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
    } as unknown as WitnessHost;
    return {
      w,
      set(next: 'live' | 'basic') {
        now = next;
        for (const l of listeners) l(status());
      },
    };
  };
  const row = (mh: MatchHost, name: string) => mh.status().participants.find((p) => p.name === name);

  it('C18: a table that is followed live but gives no ball ends (Stern SAM) is not promised to the lobby', () => {
    const SAM = "on Stern SAM the ball in play and the player up are out of Castcade's reach (CPU RAM). The scores and the end of the game are read, the end of a ball is not; the host passes each turn by hand (Pass the turn)";
    expect(ballEndsFrom({ captureMode: 'live', note: null, ballEnds: false, ballEndsNote: SAM })).toEqual({ ready: false, reason: SAM });
    expect(ballEndsFrom({ captureMode: 'live', note: null, ballEnds: true, ballEndsNote: null })).toEqual({ ready: true, reason: null });
    // Live, and the witness does not know the ROM yet: nothing is said (unknown is never warned about, and never promised).
    expect(ballEndsFrom({ captureMode: 'live', note: null, ballEnds: null, ballEndsNote: null })).toEqual({ ready: null, reason: null });
    // A status that does not carry the field reads as before.
    expect(ballEndsFrom({ captureMode: 'live', note: null })).toEqual({ ready: true, reason: null });
    expect(ballEndsFrom({ captureMode: 'basic', note: DARK, ballEnds: false, ballEndsNote: null })).toEqual({ ready: false, reason: DARK });
    expect(ballEndsFrom({ captureMode: null, note: null, ballEnds: null, ballEndsNote: null })).toEqual({ ready: null, reason: null });
  });

  it('the flag reaches the host and every lobby, follows the table, and the start needs Start anyway; then the host passes each turn', async () => {
    const sha = 'ab'.repeat(32);
    const hw = capturing(sha, 'basic');
    const cw = capturing(sha, 'basic');
    const H = make('a13-host', sha, { witness: hw.w });
    const C = make('a13-client', sha, { witness: cw.w });
    const port = 47000 + Math.floor(Math.random() * 2000);
    const hs = await H.mh.host({ port, ballsPerGame: 3, displayName: 'Owner' });
    // Alone in the lobby the host already reads why its own table will not do.
    expect(hs.panel?.message).toBe(`Waiting for players · Your table cannot report ball ends: ${DARK}`);
    await C.mh.join(hs.invite!, 'Krobs');
    await until(() => H.mh.status().participants.length === 2);
    await until(() => row(C.mh, 'Owner')?.ballEnds === false);
    expect(row(H.mh, 'Owner')?.ballEnds).toBe(false);
    expect(row(H.mh, 'Krobs')?.ballEnds).toBe(false);
    expect(row(C.mh, 'Krobs')?.ballEnds).toBe(false);
    expect(H.mh.status().startWarnings).toHaveLength(2);
    expect(C.mh.status().startWarnings).toContain(`Your table cannot report ball ends: ${DARK}`);

    // Krobs opens a patched table: the host hears of it in the lobby, and only the host's own table is left.
    cw.set('live');
    await until(() => row(H.mh, 'Krobs')?.ballEnds === true);
    await until(() => row(C.mh, 'Krobs')?.ballEnds === true);
    expect(H.mh.status().startWarnings).toEqual([`Your table cannot report ball ends: ${DARK}`]);
    expect(C.mh.status().startWarnings).toHaveLength(1);
    expect(C.mh.status().startWarnings[0]).toMatch(/^Owner's table cannot report ball ends: /);

    // Start match is not refused for good: it asks for the host's confirmation.
    await expect(H.mh.start()).rejects.toThrow(/Your table cannot report ball ends.*Start anyway/);
    expect(H.mh.status()).toMatchObject({ phase: 'lobby' });
    expect(H.mh.status().lastError).toMatch(/Start anyway/);
    await expect(C.mh.passTurn()).rejects.toThrow(/Only the host/);
    const started = await H.mh.start({ anyway: true });
    expect(started).toMatchObject({ phase: 'playing', lastError: null, startWarnings: [] });
    await until(() => C.mh.status().phase === 'playing');

    // The host's ball never ends by itself: Pass the turn, for its own ball and then for the client's.
    expect(H.mh.status().pass).toEqual({ name: 'Owner', ball: 1, score: 0 });
    expect(C.mh.status().pass).toBeNull();
    await H.mh.passTurn();
    await until(() => C.mh.status().panel?.myTurn === true);
    expect(H.mh.status()).toMatchObject({ locked: true, pass: { name: 'Krobs', ball: 1, score: 0 } });
    expect(existsSync(H.lock)).toBe(true);
    await H.mh.passTurn();
    await until(() => H.mh.status().panel?.myTurn === true && H.mh.status().panel?.ball === 2);
    await until(() => C.mh.status().locked);
    expect(existsSync(C.lock)).toBe(true);
    expect(C.mh.status().panel?.players.map((p) => p.ballsDone)).toEqual([1, 1]);
  }, 20_000);

  it('with nothing known about any table the start goes as before, with no confirmation', async () => {
    const H = make('a13-plain-host', 'ab'.repeat(32));
    const C = make('a13-plain-client', 'ab'.repeat(32));
    const hs = await H.mh.host({ port: 47000 + Math.floor(Math.random() * 2000), ballsPerGame: 3, displayName: 'Owner' });
    await C.mh.join(hs.invite!, 'Krobs');
    await until(() => H.mh.status().participants.length === 2);
    expect(H.mh.status().startWarnings).toEqual([]);
    expect(H.mh.status().participants.map((p) => p.ballEnds)).toEqual([null, null]);
    await H.mh.start();
    await expect(H.mh.passTurn()).resolves.toMatchObject({ phase: 'playing' });
  }, 15_000);
});

describe('D10.8 (2026-11-12): match control through ArcAid, and the router port as the fallback', () => {
  const relays: FakeRelay[] = [];
  afterEach(async () => {
    // The hosts first (their sockets), then the relay they talk to.
    for (const h of hosts.splice(0)) await h.stop();
    for (const r of relays.splice(0)) await r.close();
  });
  const fakeRelay = async (): Promise<FakeRelay> => {
    const r = await startFakeRelay({ devices: { 'dev-h': 'tok-h', 'dev-c': 'tok-c' } });
    relays.push(r);
    return r;
  };
  const paired = (r: { url: string }, id: 'h' | 'c', token = `tok-${id}`) => ({
    relay: () => ({ baseUrl: r.url, deviceId: `dev-${id}`, deviceToken: token }),
    relayTimeouts: { connectMs: 1500, ackMs: 1500 },
  });
  // The hosts here listen on a port the OS picks (`host({ port: 0 })` with the `ephemeralPort` seam): a port picked
  // by the test and bound later can sit in a range Windows has reserved (EACCES on a CI runner).
  const mk = (name: string, extra: Partial<Parameters<typeof createMatchHost>[0]> = {}) => make(name, 'ab'.repeat(32), { ephemeralPort: true, ...extra });
  const collect = () => {
    const lines: string[] = [];
    const log = { info: (l: string) => lines.push(l), warn: (l: string) => lines.push(l), error: (l: string) => lines.push(l), file: '' } as unknown as Logger;
    return { lines, log };
  };

  it('a paired host: the invite is the code alone; a paired player joins by code through ArcAid, an unpaired one by the address invite; the match plays, and survives the host losing ArcAid for a moment', async () => {
    const r = await fakeRelay();
    const hl = collect();
    const H = mk('relay-host', { ...paired(r, 'h'), log: hl.log });
    const C = mk('relay-client', paired(r, 'c'));
    const D = mk('relay-direct', { relay: () => null });
    const hs = await H.mh.host({ port: 0, ballsPerGame: 3, displayName: 'Owner' });
    const port = hs.port!;
    expect(port).toBeGreaterThan(0);
    expect(hs.invite).toMatch(/^[A-HJ-NP-Z]{6}$/);
    expect(hs).toMatchObject({ role: 'host', phase: 'lobby', via: 'relay', path: 'Through ArcAid', code: hs.invite, port, portMapping: null, relayNote: null });
    expect(hs.directInvite).toBe(`castcade:ws://127.0.0.1:${port}#${hs.invite}`);
    expect(r.rooms()).toEqual([hs.invite]);

    const cs = await C.mh.join(` ${hs.invite!.toLowerCase()} `, 'Krobs');
    expect(cs).toMatchObject({ role: 'client', phase: 'lobby', via: 'relay', path: 'Through ArcAid', code: hs.invite, port: null });
    const ds = await D.mh.join(hs.directInvite!, 'Chuck');
    expect(ds).toMatchObject({ role: 'client', via: 'direct', path: `Direct to 127.0.0.1:${port}` });
    await until(() => H.mh.status().participants.length === 3 && C.mh.status().participants.length === 3);
    expect(C.mh.status().participants.map((p) => p.name)).toEqual(['Owner', 'Krobs', 'Chuck']);

    await H.mh.start();
    await until(() => C.mh.status().phase === 'playing' && D.mh.status().phase === 'playing');
    expect(C.mh.status().locked).toBe(true);
    expect(C.mh.status().panel).toMatchObject({ myTurn: false, ball: 1 });

    // The host's socket to ArcAid drops: the relay player is out for a moment, resumes by itself, and the match goes on.
    // A18: it is the host's ball, so nothing pauses for the player who is away (with no grace here, the host does
    // show that player as away until it is back).
    const krobsAway = (): boolean => (H.mh.status().panel?.players.find((p) => p.name === 'Krobs')?.flags ?? []).includes('disconnected');
    const phases: string[] = [];
    const off = H.mh.onStatus((s) => phases.push(s.phase));
    r.dropDevice('dev-h');
    await until(() => hl.lines.some((l) => l.includes('ArcAid is not carrying this match for the moment')));
    await until(() => krobsAway());
    await until(() => hl.lines.some((l) => l.includes(`ArcAid carries ${hs.invite} again`)), 6000);
    await until(() => !krobsAway() && C.mh.status().phase === 'playing' && H.mh.status().path === 'Through ArcAid', 8000);
    off();
    expect(phases).not.toContain('paused');
    expect(H.mh.status()).toMatchObject({ phase: 'playing', locked: false });
    // Why the socket closed is in the log (socket.io's reason; no address).
    expect(hl.lines.filter((l) => l.includes('the connection to ArcAid closed (')).length).toBeGreaterThan(0);
    // The token never reaches the log.
    expect(hl.lines.join('\n')).not.toContain('tok-h');

    await C.mh.leave();
    await H.mh.leave();
    expect(H.mh.status()).toMatchObject({ via: null, path: null, invite: null, directInvite: null });
  }, 30_000);

  it("A18: two players through ArcAid drop at once in the host's ball (the host lost ArcAid): nobody is paused for, both come back by themselves, and the turn moves on to each", async () => {
    const r = await startFakeRelay({ devices: { 'dev-h': 'tok-h', 'dev-c': 'tok-c', 'dev-d': 'tok-d' } });
    relays.push(r);
    const H = mk('relay3-host', paired(r, 'h'));
    const C = mk('relay3-c', paired(r, 'c'));
    const D = mk('relay3-d', { relay: () => ({ baseUrl: r.url, deviceId: 'dev-d', deviceToken: 'tok-d' }), relayTimeouts: { connectMs: 1500, ackMs: 1500 } });
    const hs = await H.mh.host({ port: 0, ballsPerGame: 3, displayName: 'Owner' });
    await C.mh.join(hs.invite!, 'Krobs');
    await D.mh.join(hs.invite!, 'Chuck');
    await until(() => H.mh.status().participants.length === 3);
    await H.mh.start();
    await until(() => C.mh.status().phase === 'playing' && D.mh.status().phase === 'playing');
    const away = (): string[] => (H.mh.status().panel?.players ?? []).filter((p) => p.flags.includes('disconnected')).map((p) => p.name);
    const phases: string[] = [];
    const off = H.mh.onStatus((s) => phases.push(s.phase));
    r.dropDevice('dev-h');
    await until(() => away().length === 2);
    // Both come back by RECONNECT. The host's ball went on meanwhile: there was no pause to resume.
    await until(() => away().length === 0 && [H, C, D].every((x) => x.mh.status().phase === 'playing'), 10_000);
    off();
    expect(phases).not.toContain('paused');
    // The turn moves on to each of them: nobody is left "disconnected" in the log.
    await H.mh.passTurn();
    await until(() => C.mh.status().panel?.myTurn === true || D.mh.status().panel?.myTurn === true, 6000);
    await H.mh.passTurn();
    await until(() => [C, D].filter((x) => x.mh.status().panel?.players.some((p) => p.ballsDone === 1)).length === 2, 6000);
    await until(() => [H, C, D].every((x) => x.mh.status().phase === 'playing'), 6000);
    expect(H.mh.status().panel?.players.flatMap((p) => p.flags)).not.toContain('disconnected');
  }, 40_000);

  /**
   * A18: a seat whose fakes record what a drop could disturb: the page's peers (its connections are up as long as the
   * page holds them, whatever the match's control link does), the table sound and the native video sender.
   */
  const a18Seat = (name: string, id: 'h' | 'c', r: { url: string }, pid: number, graceMs: number) => {
    // The table's hook, as the witness passes it on: `feed` is the table saying something.
    type TableEvent = Parameters<Parameters<WitnessHost['onEvent']>[0]>[0];
    const heard = new Set<(ev: TableEvent) => void>();
    const withPid = (sha: string): WitnessHost => ({ ...witness(sha), vpxPid: () => pid, onEvent: (cb: (ev: TableEvent) => void) => (heard.add(cb), () => heard.delete(cb)) }) as unknown as WitnessHost;
    const feed = (ev: Record<string, unknown>): void => heard.forEach((cb) => cb({ t: 0, player: 1, ...ev } as unknown as TableEvent));
    const page = { added: [] as string[], removed: [] as string[] };
    const base = fakeMedia().media as unknown as Record<string, unknown> & { status(): Record<string, unknown> };
    const media = {
      ...base,
      addPeer: (p: string) => void page.added.push(p),
      removePeer: (p: string) => void page.removed.push(p),
      status: () => ({ ...base.status(), peers: Object.fromEntries(page.added.filter((p) => !page.removed.includes(p)).map((p) => [p, { ice: 'connected', receivingVideo: false, receivingAudio: true }])) }),
    };
    const audio = fakeAudio();
    const video = stubHelper();
    const log = collect();
    const signalling = (role: Parameters<typeof matchSignalling>[0], me: string) => matchSignalling(role, me);
    const seat = mk(name, {
      ...paired(r, id),
      witness: withPid('ab'.repeat(32)),
      media: media as never,
      tableAudio: audio.ta,
      signalling,
      nativeVideo: { helper: video.helper as never, sendRing: `${name}-send-ABCDEFG`, recvRing: `${name}-recv-ABCDEFG` },
      log: log.log,
      disconnectGraceMs: graceMs,
    });
    // Every status this seat raised: the phase, whether its table is locked, the panel's line and who it shows as away.
    const seen: Array<{ phase: string; locked: boolean; message: string | null; away: string[] }> = [];
    seat.mh.onStatus((s) => seen.push({ phase: s.phase, locked: s.locked, message: s.panel?.message ?? null, away: (s.panel?.players ?? []).filter((p) => p.flags.includes('disconnected')).map((p) => p.name) }));
    return { ...seat, page, audio, video, lines: log.lines, seen, feed };
  };

  it("A18: the ball of the player who is up ends while ArcAid is away for a moment: the ball end it reported into the dead link counts, once, and the turn passes on with no pause", async () => {
    const r = await fakeRelay();
    const H = a18Seat('a18c-host', 'h', r, 111, 4000);
    const C = a18Seat('a18c-client', 'c', r, 222, 4000);
    const hs = await H.mh.host({ port: 0, ballsPerGame: 3, displayName: 'Owner' });
    await C.mh.join(hs.invite!, 'Krobs');
    await until(() => H.mh.status().participants.length === 2);
    await H.mh.start();
    await until(() => C.mh.status().phase === 'playing');
    await H.mh.passTurn();
    await until(() => C.mh.status().panel?.myTurn === true && C.mh.status().locked === false, 8000);
    C.feed({ kind: 'game_start', players: 1 });
    C.feed({ kind: 'current_scores', scores: [1200], ball: 1 });
    await until(() => H.mh.status().panel?.players.find((p) => p.name === 'Krobs')?.score === 1200);
    const before = { hSeen: H.seen.length, cSeen: C.seen.length };

    // ArcAid loses the host; the client does not know yet. Its ball drains: the BALL_END goes to a relay that has
    // nobody to hand it to.
    r.dropDevice('dev-h');
    await until(() => H.lines.some((l) => l.includes('ArcAid is not carrying this match for the moment')));
    C.feed({ kind: 'current_scores', scores: [4200], ball: 1 });
    C.feed({ kind: 'ball_end', ball: 1, extraBalls: 0 });
    C.feed({ kind: 'current_scores', scores: [4250], ball: 1 });
    expect(C.lines.filter((l) => l.startsWith('match: BALL_END ball 1 score 4250'))).toHaveLength(1);
    // Everybody is back by themselves; the ball end is sent again, the host takes it, and its own ball 2 is next.
    await until(() => H.mh.status().panel?.myTurn === true && H.mh.status().panel?.ball === 2, 10_000);
    const krobs = H.mh.status().panel?.players.find((p) => p.name === 'Krobs');
    expect(krobs).toMatchObject({ score: 4250, ballsDone: 1 });
    await until(() => C.mh.status().panel?.players.find((p) => p.name === 'Krobs')?.ballsDone === 1 && C.mh.status().locked === true);
    // One ball end, reported once by the table's side, never rejected, and no pause or away on either PC.
    expect(C.lines.filter((l) => l.includes('BALL_END ball 1'))).toHaveLength(1);
    expect(H.lines.concat(C.lines).filter((l) => l.includes('rejected') || l.includes('table event(s) since the log last grew'))).toEqual([]);
    expect(H.seen.slice(before.hSeen).filter((x) => x.phase !== 'playing' || x.away.length > 0)).toEqual([]);
    expect(C.seen.slice(before.cSeen).filter((x) => x.phase !== 'playing' || x.away.length > 0 || (x.message ?? '').includes('link'))).toEqual([]);
  }, 30_000);

  it("A18 (match ECVYGP, 2026-11-23): ArcAid drops the match for a moment in the host's ball: no pause on either PC, nobody shown as away, the table sound and the picture as they were, and the voice connection is not made again", async () => {
    const r = await fakeRelay();
    const H = a18Seat('a18-host', 'h', r, 111, 4000);
    const C = a18Seat('a18-client', 'c', r, 222, 4000);
    const hs = await H.mh.host({ port: 0, ballsPerGame: 3, displayName: 'Owner' });
    await C.mh.join(hs.invite!, 'Krobs');
    await until(() => H.mh.status().participants.length === 2);
    await H.mh.start();
    // The host has ball 1: it sends its table's sound and its picture; the client's VPX is muted.
    await until(() => C.mh.status().phase === 'playing' && H.audio.last()?.tapPid === 111 && C.audio.last()?.mutePid === 222 && H.video.of('send').at(-1)?.on === true);
    await until(() => H.page.added.length === 1 && C.page.added.length === 1);
    const before = { hAudio: H.audio.wants.length, cAudio: C.audio.wants.length, hSend: H.video.of('send').length, cSend: C.video.of('send').length, hSeen: H.seen.length, cSeen: C.seen.length };

    r.dropDevice('dev-h');
    await until(() => H.lines.some((l) => l.includes('ArcAid is not carrying this match for the moment')));
    await until(() => H.lines.some((l) => l.includes(`ArcAid carries ${hs.invite} again`)), 6000);
    // The client is back on the link by itself: the host can pass its turn and the client's grant arrives. (A grant
    // that came due before the client was back would have waited for it: `match/host.ts`.)
    await H.mh.passTurn();
    await until(() => C.mh.status().panel?.myTurn === true && C.mh.status().locked === false, 8000);

    // Up to the pass, nothing either player could see: every status says playing, nobody away, no line about a link;
    // the host's table never locked and the client's stayed locked.
    const during = (s: typeof H): typeof H.seen => s.seen.slice(s === H ? before.hSeen : before.cSeen).filter((x) => x.phase !== 'playing' || x.away.length > 0 || (x.message ?? '').includes('link'));
    expect(during(H)).toEqual([]);
    expect(during(C)).toEqual([]);
    expect(H.lines.concat(C.lines).filter((l) => l.includes('the link to the host dropped') || l.includes('Paused'))).toEqual([]);
    // The voice connection was not closed and not made again, on either PC.
    expect(H.page).toEqual({ added: [C.mh.status().localId], removed: [] });
    expect(C.page).toEqual({ added: [H.mh.status().localId], removed: [] });
    // The table sound, as the helpers were told it from the drop on (each change once): the host sent its table until
    // the pass and is muted from then on; the client was muted until its grant and sends from then on. Nothing else.
    const sound = (s: typeof H, from: number): string =>
      s.audio.wants
        .slice(from)
        .map((w) => (w.tapPid !== null ? 'send' : w.mutePid !== null ? 'mute' : 'off'))
        .filter((x, i, all) => x !== all[i - 1])
        .join(' > ');
    expect(['mute', 'send > mute']).toContain(sound(H, before.hAudio));
    expect(['send', 'mute > send']).toContain(sound(C, before.cAudio));
    // The picture: the host's sender went off once, at the pass, and the client's on once, at its grant.
    expect(H.video.of('send').slice(before.hSend).map((s) => s.on)).toEqual([false]);
    expect(C.video.of('send').slice(before.cSend).map((s) => s.on)).toEqual([true]);
    // Why the socket closed is in the host's log, and one line each for a drop that nobody saw.
    expect(H.lines.some((l) => l.includes('the connection to ArcAid closed ('))).toBe(true);
    expect(H.lines).toContain("match: Krobs's link to this host was away for a moment and is back; nothing was paused or shown");
    expect(C.lines.some((l) => l.startsWith('match: the link to the host was away for a moment and is back ('))).toBe(true);
  }, 30_000);

  it('A17 step 1 (2026-11-24): two PCs hold each other\'s voice connection from the join on, before anything is started; Start match, every turn, the result and Next game open and close nothing', async () => {
    const r = await fakeRelay();
    const H = a18Seat('a17-host', 'h', r, 111, 4000);
    const C = a18Seat('a17-client', 'c', r, 222, 4000);
    const hs = await H.mh.host({ port: 0, ballsPerGame: 3, displayName: 'Owner' });
    // Alone in the lobby: nobody to talk to yet.
    expect(H.page).toEqual({ added: [], removed: [] });
    await C.mh.join(hs.invite!, 'Krobs');
    await until(() => H.mh.status().participants.length === 2 && C.mh.status().participants.length === 2);
    // The lobby, with nothing started: each page was given the other player.
    await until(() => H.page.added.length === 1 && C.page.added.length === 1);
    expect([H.mh.status().phase, C.mh.status().phase]).toEqual(['lobby', 'lobby']);
    const pages = { h: { added: [C.mh.status().localId], removed: [] }, c: { added: [H.mh.status().localId], removed: [] } };
    const same = (): void => expect({ h: H.page, c: C.page }).toEqual(pages);
    same();
    expect(H.lines.filter((l) => l.includes('voice with Krobs is being connected now, in the lobby'))).toHaveLength(1);
    expect(C.lines.filter((l) => l.includes('voice with Owner is being connected now, in the lobby'))).toHaveLength(1);

    // MATCH_READY.
    await H.mh.start();
    await until(() => C.mh.status().phase === 'playing' && H.mh.status().panel?.myTurn === true);
    same();
    /** A game of three balls each, reported by each table. */
    const playGame = async (base: number): Promise<void> => {
      for (let ball = 1; ball <= 3; ball++) {
        for (const seat of [H, C]) {
          await until(() => seat.mh.status().panel?.myTurn === true && seat.mh.status().panel?.ball === ball, 8000);
          const s = base * ball;
          seat.feed({ kind: 'current_scores', scores: [s], ball });
          seat.feed({ kind: 'ball_end', ball, extraBalls: 0 });
          seat.feed({ kind: 'current_scores', scores: [s], ball });
          await until(() => seat.mh.status().panel?.myTurn !== true || seat.mh.status().phase === 'over', 8000);
        }
      }
      await until(() => H.mh.status().phase === 'over' && C.mh.status().phase === 'over', 8000);
    };
    await playGame(1000);
    same();

    // NEXT_GAME, and a second game to its result.
    await until(() => H.mh.status().series?.nextGameBlocker === null, 12_000);
    await H.mh.start();
    await until(() => C.mh.status().series?.game === 2 && C.mh.status().phase === 'playing');
    same();
    await playGame(2000);
    same();
    expect(H.lines.concat(C.lines).filter((l) => l.includes('is being connected now'))).toHaveLength(2);
  }, 60_000);

  it("A18: the player who is up loses the host for longer than the grace: the others wait, and on that player's own PC the table is never locked, its sound and its picture are never cut, through the pause it finds at its return", async () => {
    const r = await fakeRelay();
    const H = a18Seat('a18b-host', 'h', r, 111, 0);
    const C = a18Seat('a18b-client', 'c', r, 222, 0);
    const hs = await H.mh.host({ port: 0, ballsPerGame: 3, displayName: 'Owner' });
    await C.mh.join(hs.invite!, 'Krobs');
    await until(() => H.mh.status().participants.length === 2);
    await H.mh.start();
    await until(() => C.mh.status().phase === 'playing');
    await H.mh.passTurn();
    // The client is up: its table is unlocked, it sends its sound and its picture.
    await until(() => C.mh.status().panel?.myTurn === true && C.mh.status().locked === false && C.audio.last()?.tapPid === 222 && C.video.of('send').at(-1)?.on === true, 8000);
    const before = { cAudio: C.audio.wants.length, cSend: C.video.of('send').length, cSeen: C.seen.length };

    r.dropDevice('dev-h');
    // The host cannot reach the player who holds the grant: the others (here the host itself) wait for it.
    await until(() => H.mh.status().phase === 'paused', 8000);
    expect(H.mh.status().panel?.message).toBe('Paused: waiting for Krobs to reconnect');
    // The client finds that pause in what it missed, resumes it itself, and the match plays on.
    await until(() => C.seen.slice(before.cSeen).some((x) => x.phase === 'paused'), 8000);
    await until(() => H.mh.status().phase === 'playing' && C.mh.status().phase === 'playing' && C.mh.status().panel?.myTurn === true, 8000);
    // On the client's own PC, all the while: never locked, the table's sound always sent, the sender never off.
    expect(C.seen.slice(before.cSeen).filter((x) => x.locked)).toEqual([]);
    expect(existsSync(C.lock)).toBe(false);
    expect(C.audio.wants.slice(before.cAudio).filter((w) => w.tapPid !== 222 || w.mutePid !== null)).toEqual([]);
    expect(C.video.of('send').slice(before.cSend)).toEqual([]);
    expect(C.lines.some((l) => l.includes('back after a drop; resuming the match'))).toBe(true);
  }, 30_000);

  it('a join by code says what went wrong: not paired, no such match, ArcAid refusing the device, ArcAid unreachable', async () => {
    const r = await fakeRelay();
    const unpaired = mk('relay-unpaired', { relay: () => null });
    await expect(unpaired.mh.join('JHDFEF', 'Krobs')).rejects.toThrow(/goes through ArcAid, and this PC is not paired/);
    expect(unpaired.mh.status()).toMatchObject({ role: 'none', phase: 'none' });
    expect(unpaired.mh.status().lastError).toMatch(/not paired/);

    const C = mk('relay-nomatch', paired(r, 'c'));
    await expect(C.mh.join('JHDFEF', 'Krobs')).rejects.toThrow(/^No match with the code JHDFEF: check the code with the host/);

    const bad = mk('relay-badtoken', paired(r, 'c', 'stale'));
    await expect(bad.mh.join('JHDFEF', 'Krobs')).rejects.toThrow(/ArcAid did not accept this PC: pair it with ArcAid again/);

    const gone = mk('relay-gone', { relay: () => ({ baseUrl: 'http://127.0.0.1:9', deviceId: 'dev-c', deviceToken: 'tok-c' }), relayTimeouts: { connectMs: 300, ackMs: 300 } });
    await expect(gone.mh.join('JHDFEF', 'Krobs')).rejects.toThrow(/^ArcAid could not be reached \(.*\): check this PC's internet connection, or ask the host for a direct invite/);
    expect(gone.mh.status().lastError).not.toContain('tok-c');
  }, 20_000);

  it('ArcAid restarts mid-match (a deploy loses the room): the host opens the same code again, the relay player resumes by itself, and the room is locked again; leaving closes it at once', async () => {
    const r = await startFakeRelay({ devices: { 'dev-h': 'tok-h', 'dev-c': 'tok-c', 'dev-d': 'tok-d' } });
    relays.push(r);
    const hl = collect();
    const H = mk('restart-host', { ...paired(r, 'h'), log: hl.log });
    const C = mk('restart-client', paired(r, 'c'));
    const hs = await H.mh.host({ port: 0, ballsPerGame: 3, displayName: 'Owner' });
    const code = hs.invite!;
    await C.mh.join(code, 'Guest');
    await until(() => H.mh.status().participants.length === 2);
    expect(r.locked(code)).toBe(false);
    await H.mh.start();
    await until(() => C.mh.status().phase === 'playing' && r.locked(code));

    // The match started: a device that was never in it is refused by ArcAid, by name.
    const late = mk('restart-late', { relay: () => ({ baseUrl: r.url, deviceId: 'dev-d', deviceToken: 'tok-d' }), relayTimeouts: { connectMs: 1500, ackMs: 1500 } });
    await expect(late.mh.join(code, 'Late')).rejects.toThrow(/^That match has already started/);

    await r.restart(400);
    await until(() => hl.lines.some((l) => l.includes('ArcAid is not carrying this match for the moment')));
    await until(() => hl.lines.some((l) => l.includes(`ArcAid carries ${code} again`)), 10_000);
    // A18: the host's ball was never paused for the player a deploy took away; that player is back by itself.
    await until(() => H.mh.status().panel?.players.some((p) => p.flags.includes('disconnected')) === false && C.mh.status().phase === 'playing' && H.mh.status().path === 'Through ArcAid', 20_000);
    expect(H.mh.status().phase).toBe('playing');
    expect(r.rooms()).toEqual([code]);
    // Locked again once its player was back, and never while the player was still on the way.
    await until(() => r.locked(code), 5000);
    expect(r.misses.get('dev-c') ?? 0).toBeLessThanOrEqual(5);
    await H.mh.passTurn();
    await until(() => C.mh.status().panel?.myTurn === true, 6000);

    // A deliberate leave says so to ArcAid: the room is gone at once, not after the 30 s grace.
    await C.mh.leave();
    await H.mh.leave();
    await until(() => r.rooms().length === 0, 2000);
    expect(hl.lines.join('\n')).not.toContain('tok-h');
  }, 60_000);

  it('a host ArcAid refuses in the ack (a stale token; the socket itself connects) hosts on its listener and says to pair again', async () => {
    const r = await fakeRelay();
    const H = mk('relay-stale-host', { ...paired(r, 'h', 'stale'), openPort: null });
    const hs = await H.mh.host({ port: 0, ballsPerGame: 3, displayName: 'Owner' });
    expect(hs).toMatchObject({ role: 'host', via: 'direct', relayNote: 'ArcAid did not accept this PC: pair it again in Settings to host without a port forward' });
    expect(hs.invite).toBe(`castcade:ws://127.0.0.1:${hs.port}#${hs.code}`);
    expect(r.rooms()).toEqual([]);
  }, 15_000);

  it('no relay (ArcAid unreachable): the address invite as before; the router is asked in the background and the tab says what came of it; leaving removes the mapping', async () => {
    const calls: string[] = [];
    let answer: (r: PortMapResult) => void = () => undefined;
    const pending = new Promise<PortMapResult>((res) => (answer = res));
    const mapping = { externalIp: null, leaseSeconds: 3600, gateway: '192.168.1.1', renew: async () => true, remove: async () => (calls.push('remove'), true) };
    const H = mk('fallback-host', {
      relay: () => ({ baseUrl: 'http://127.0.0.1:9', deviceId: 'dev-h', deviceToken: 'tok-h' }),
      relayTimeouts: { connectMs: 300, ackMs: 300 },
      openPort: (p) => (calls.push(`open ${p}`), pending),
    });
    const hs = await H.mh.host({ port: 0, ballsPerGame: 3, displayName: 'Owner' });
    const port = hs.port!;
    expect(hs.invite).toBe(`castcade:ws://127.0.0.1:${port}#${hs.code}`);
    expect(hs).toMatchObject({ via: 'direct', path: `Direct to 127.0.0.1:${port}`, directInvite: null, relayNote: 'ArcAid could not be reached', portMapping: { state: 'trying' } });
    expect(calls).toEqual([`open ${port}`]);
    answer({ ok: true, mapping: { ...mapping, externalPort: port } });
    await until(() => H.mh.status().portMapping?.state === 'opened');
    expect(H.mh.status().portMapping?.line).toBe('Port opened on your router automatically');
    // A player still joins on the listener.
    const C = mk('fallback-client');
    expect(await C.mh.join(hs.invite!, 'Krobs')).toMatchObject({ via: 'direct', path: `Direct to 127.0.0.1:${port}` });
    await C.mh.leave();
    await H.mh.leave();
    expect(calls).toEqual([`open ${port}`, 'remove']);
    expect(H.mh.status().portMapping).toBeNull();
  }, 15_000);

  it('an unpaired host whose router does not open the port is told to forward it or pair; a mapping that arrives after the match ended is removed', async () => {
    const H = mk('fallback-unpaired', { relay: () => null, openPort: async () => ({ ok: false, reason: 'no UPnP router answered' }) });
    const port = (await H.mh.host({ port: 0, ballsPerGame: 3, displayName: 'Owner' })).port!;
    await until(() => H.mh.status().portMapping?.state === 'failed');
    expect(H.mh.status()).toMatchObject({
      via: 'direct',
      relayNote: 'This PC is not paired with ArcAid',
      portMapping: { line: `Your router did not open the port: forward TCP ${port}, or pair with ArcAid to host without it` },
    });
    await H.mh.leave();

    let removed = 0;
    let answer: (r: PortMapResult) => void = () => undefined;
    const late = mk('fallback-late', { openPort: () => new Promise<PortMapResult>((res) => (answer = res)) });
    await late.mh.host({ port: 0, ballsPerGame: 3, displayName: 'Owner' });
    await late.mh.leave();
    answer({ ok: true, mapping: { externalPort: 1, externalIp: null, leaseSeconds: 3600, gateway: 'g', renew: async () => true, remove: async () => (removed++, true) } });
    await until(() => removed === 1);
    expect(late.mh.status().portMapping).toBeNull();
  }, 15_000);

  it('a paired host whose port is taken hosts through ArcAid only', async () => {
    const r = await fakeRelay();
    const blocker = createServer();
    // The OS picks the blocker's port, and the host is then asked for exactly that one: taken for certain.
    await new Promise<void>((res) => blocker.listen(0, '127.0.0.1', () => res()));
    const p = (blocker.address() as { port: number }).port;
    try {
      const H = mk('relay-only', paired(r, 'h'));
      const hs = await H.mh.host({ port: p, ballsPerGame: 3, displayName: 'Owner' });
      expect(hs).toMatchObject({ role: 'host', via: 'relay', port: null, directInvite: null, endpoint: null });
      const C = mk('relay-only-client', paired(r, 'c'));
      expect(await C.mh.join(hs.invite!, 'Krobs')).toMatchObject({ role: 'client', via: 'relay' });
    } finally {
      blocker.close();
    }
  }, 15_000);
});

describe('match host: the in-game menu and the quiet lobby (D8.9 / D8.10, 2026-11-14)', () => {
  it('the lobby panel gets out of the way, the menu key brings up the menu, and its lines start the match, move the volumes and mute the mic', async () => {
    type Menu = { items: Array<{ label: string; value: string | null; off: boolean }>; index: number; note: string | null; hint: string } | null;
    const menus: Menu[] = [];
    const volumes: Array<{ voice: number; table: number }> = [];
    const muted: boolean[] = [];
    const m = fakeMedia();
    const media = { ...m.media, setMenu: (v: Menu) => void menus.push(v), setVolume: (v: { voice: number; table: number }) => void volumes.push({ voice: v.voice, table: v.table }), setMuted: (on: boolean) => void muted.push(on) };
    const o = fakeOverlay();
    const held = new Map<string, () => void>();
    const shortcuts = { register: (acc: string, cb: () => void) => (held.set(acc, cb), true), unregister: (acc: string) => void held.delete(acc) };
    let t = 1_000_000;
    const H = make('menu-host', 'ab'.repeat(32), { witness: liveWitness(VR_ON, VR_OFF).w, media: media as never, vrOverlay: o.overlay, shortcuts, now: () => t });
    const C = make('menu-client', 'ab'.repeat(32));
    const press = (acc: string, after = 1000): void => {
      t += after;
      held.get(acc)!();
    };
    const hs = await H.mh.host({ port: 43000 + Math.floor(Math.random() * 2000), ballsPerGame: 3, displayName: 'Owner' });
    // D8.9: the panel shows at Host, then leaves the table alone once the lobby has been quiet for 8 s.
    expect(o.modes.at(-1)).toBe('panel');
    t += 9000;
    H.mh.setSettings({ cueVolume: 70 });
    expect(o.modes.at(-1)).toBe('hidden');
    expect([...held.keys()]).toEqual(expect.arrayContaining(['Control+Alt+M', 'Control+Alt+K']));
    expect(held.has('Up')).toBe(false);
    // The menu key: the panel is back with the menu on it; the arrows are held only while it is open.
    press('Control+Alt+M');
    expect(o.modes.at(-1)).toBe('panel');
    expect(menus.at(-1)).toMatchObject({ index: 0, note: null });
    expect(menus.at(-1)!.items[0]).toEqual({ label: 'Start match', value: null, off: true });
    expect(menus.at(-1)!.hint).toBe('Ctrl+Alt+M: next line · Ctrl+Alt+K, or Ctrl+Alt+M twice quickly: choose · the arrow keys work too');
    expect([...held.keys()]).toEqual(expect.arrayContaining(['Up', 'Down', 'Left', 'Right']));
    press('Control+Alt+K');
    expect(menus.at(-1)!.note).toBe('Nobody has joined yet');
    await C.mh.join(hs.invite!, 'Krobs');
    await until(() => H.mh.status().participants.length === 2 && menus.at(-1)?.items[0]?.off === false);
    // One spare button: the menu key moves down a line; pressed again within a moment it chooses the line it left.
    press('Control+Alt+M');
    expect(menus.at(-1)!.index).toBe(1);
    press('Control+Alt+M', 200);
    await until(() => H.mh.status().phase === 'playing' && H.mh.status().panel?.myTurn === true);
    expect(menus.at(-1)).toBeNull();
    expect(held.has('Up')).toBe(false);
    expect(o.modes.at(-1)).toBe('hidden'); // my ball: nothing over the table
    // A key held down (repeats 33 ms apart) is one press.
    press('Control+Alt+M');
    press('Control+Alt+M', 33);
    press('Control+Alt+M', 33);
    expect(o.modes.at(-1)).toBe('panel');
    expect(menus.at(-1)).toMatchObject({ index: 0 });
    expect(menus.at(-1)!.items.map((i) => i.label)).toEqual(['Voice volume', 'Their table sound', 'My table while I play', 'Microphone', 'Leave match', 'Close menu']);
    // The volumes: the arrow raises, the choose key raises too; saved and pushed live.
    press('Right');
    expect(H.mh.status().settings.voiceVolume).toBe(175);
    expect(volumes.at(-1)).toEqual({ voice: 175, table: 100 });
    press('Control+Alt+K');
    expect(menus.at(-1)!.items[0]!.value).toBe('200 %');
    press('Down');
    press('Left');
    expect(H.mh.status().settings.othersTableVolume).toBe(90);
    press('Down');
    press('Left');
    expect(H.mh.status().settings.myTableWhileUp).toBe(90);
    // The microphone, then Close menu: the table is clear again and the arrows are let go.
    press('Down');
    press('Control+Alt+K');
    expect(muted).toEqual([true]);
    press('Down');
    press('Down');
    press('Control+Alt+K');
    expect(menus.at(-1)).toBeNull();
    expect(o.modes.at(-1)).toBe('hidden');
    expect(held.has('Left')).toBe(false);
    // A new key on the Match tab is taken at once; leaving lets every key go.
    H.mh.setSettings({ menuKey: 'F9' });
    expect(held.has('F9')).toBe(true);
    expect(held.has('Control+Alt+M')).toBe(false);
    await H.mh.leave();
    expect(held.size).toBe(0);
  }, 15_000);

  it('D8.12.3: "Put the scoreboard where I look" is on the menu of a layer rig in a match, asks the layer once, and is off for a layer that cannot', async () => {
    type Menu = { items: Array<{ label: string; value: string | null; off: boolean }>; index: number; note: string | null; hint: string } | null;
    const menus: Menu[] = [];
    const m = fakeMedia();
    const board = { onFrame: () => () => undefined };
    let page = false;
    const media = { ...m.media, setMenu: (v: Menu) => void menus.push(v), setScoreboard: (want: boolean) => void (page = want), scoreboardFrames: () => (page ? board : null) };
    const layer = fakeOverlay();
    let protocol: number | null = 5;
    let placed = 0;
    const anchors: Array<string | undefined> = [];
    Object.assign(layer.overlay as unknown as Record<string, unknown>, {
      setScoreboard: (x: { anchor?: string }) => void anchors.push(x.anchor),
      layerProtocol: () => protocol,
      placeScoreboard: () => (placed++, 'placed'),
    });
    const held = new Map<string, () => void>();
    const shortcuts = { register: (acc: string, cb: () => void) => (held.set(acc, cb), true), unregister: (acc: string) => void held.delete(acc) };
    let t = 1_000_000;
    const H = make('menu-board', 'ab'.repeat(32), { witness: liveWitness(VR_VD, VR_OFF).w, media: media as never, vrLayer: layer.overlay, shortcuts, now: () => t });
    const C = make('menu-board-client', 'ab'.repeat(32));
    const press = (acc: string, after = 1000): void => {
      t += after;
      held.get(acc)!();
    };
    const labels = (): string[] => menus.at(-1)!.items.map((i) => i.label);
    const LINE = 'Put the scoreboard where I look';
    const hs = await H.mh.host({ port: 43000 + Math.floor(Math.random() * 2000), ballsPerGame: 3, displayName: 'Owner' });
    await C.mh.join(hs.invite!, 'Krobs');
    await until(() => H.mh.status().participants.length === 2);
    // The lobby has no scoreboard, so no such line.
    press('Control+Alt+M');
    expect(labels()).not.toContain(LINE);
    press('Control+Alt+K'); // Start match
    await until(() => H.mh.status().phase === 'playing' && H.mh.status().panel?.myTurn === true);
    expect(anchors.at(-1)).toBe('room');
    // In the match: the line is there, between the microphone and Leave match; choosing it asks the layer once and closes the menu.
    press('Control+Alt+M');
    expect(labels()).toEqual(['Voice volume', 'Their table sound', 'My table while I play', 'Microphone', LINE, 'Leave match', 'Close menu']);
    expect(menus.at(-1)!.items[4]!.off).toBe(false);
    for (let i = 0; i < 4; i++) press('Down');
    expect(placed).toBe(0);
    press('Control+Alt+K');
    expect(placed).toBe(1);
    expect(menus.at(-1)).toBeNull();
    expect(layer.modes.at(-1)).toBe('hidden'); // the panel is gone: the table and the scoreboard at its new place
    // The layer in VPX is 0.7.0 (protocol 4): the line is greyed, says why, and nothing is asked.
    protocol = 4;
    press('Control+Alt+M');
    expect(menus.at(-1)!.items[4]).toEqual({ label: LINE, value: null, off: true });
    for (let i = 0; i < 4; i++) press('Down');
    press('Control+Alt+K');
    expect(placed).toBe(1);
    expect(menus.at(-1)!.note).toBe('Restart VPX first: until then the scoreboard follows your head');
    // "Follows my head" on the Match tab: the line goes (the open menu follows), and comes back with the room.
    protocol = 5;
    H.mh.setSettings({ scoreboardAnchor: 'head' });
    expect(labels()).not.toContain(LINE);
    H.mh.setSettings({ scoreboardAnchor: 'room' });
    expect(labels()).toContain(LINE);
    H.mh.setSettings({ scoreboard: false });
    expect(labels()).not.toContain(LINE);
    await H.mh.leave();
    await C.mh.leave().catch(() => undefined);
  }, 15_000);

  it('says so when another program holds the menu key', async () => {
    const shortcuts = { register: (acc: string) => acc !== 'Control+Alt+M', unregister: () => undefined };
    const H = make('menu-taken', 'ab'.repeat(32), { shortcuts });
    const st = await H.mh.host({ port: 43000 + Math.floor(Math.random() * 2000), ballsPerGame: 3, displayName: 'Owner' });
    expect(st.menuKeyProblem).toBe('Ctrl+Alt+M could not be taken (another program holds it): choose another key');
    await H.mh.leave();
    expect(H.mh.status().menuKeyProblem).toBeNull();
  });
});

describe('match host: VPX gets the foreground back from Castcade (I11.4.18, 2026-11-24)', () => {
  /** A faked window interface: whether a Castcade window is the active one, and what a handover answers. */
  const windows = (answer: { ok: boolean; title: string | null; why: string | null } = { ok: true, title: 'Visual Pinball Player', why: null }) => {
    const w = { active: true, gives: 0, answer };
    const foreground = {
      castcadeActive: () => w.active,
      give: async () => {
        w.gives += 1;
        return w.answer;
      },
    };
    return { w, foreground };
  };
  const logLines = () => {
    const lines: string[] = [];
    const log = { info: (l: string) => void lines.push(l), warn: (l: string) => void lines.push(l), error: (l: string) => void lines.push(l), file: '' } as unknown as Logger;
    return { lines, log };
  };
  const pair = async (hostExtra: Parameters<typeof make>[2], clientExtra: Parameters<typeof make>[2] = {}) => {
    const H = make('fg-host', 'ab'.repeat(32), { ephemeralPort: true, ...hostExtra });
    const C = make('fg-client', 'ab'.repeat(32), clientExtra);
    const hs = await H.mh.host({ port: 0, ballsPerGame: 3, displayName: 'Owner' });
    await C.mh.join(hs.invite!, 'Krobs');
    await until(() => H.mh.status().participants.length === 2);
    return { H, C };
  };

  it('Start match pressed on the Match tab while Castcade is the active window: VPX is given the foreground, once, with one log line', async () => {
    const hw = windows();
    const hl = logLines();
    const { H, C } = await pair({ foreground: hw.foreground, log: hl.log });
    expect(hw.w.gives).toBe(0); // hosting and a lobby give nothing: the table is not this match's to play yet
    await H.mh.start();
    await until(() => H.mh.status().panel?.myTurn === true && C.mh.status().phase === 'playing');
    await until(() => hl.lines.some((l) => l.startsWith('match: gave VPX the foreground (')));
    // The press and the grant it brings are one moment: one handover.
    expect(hw.w.gives).toBe(1);
    expect(hl.lines.filter((l) => l.includes('VPX the foreground'))).toHaveLength(1);
  }, 20_000);

  it('a grant that reaches this PC while a Castcade window is the active one gives VPX the foreground; while VPX or a third program is in front nothing is touched', async () => {
    const hw = windows();
    const cw = windows();
    const cl = logLines();
    hw.w.active = false; // the host is in VPX (or elsewhere): never touched
    cw.w.active = false; // the guest is elsewhere when the match starts
    const { H, C } = await pair({ foreground: hw.foreground }, { foreground: cw.foreground, log: cl.log });
    await H.mh.start();
    await until(() => C.mh.status().phase === 'playing');
    expect(hw.w.gives).toBe(0);
    // The guest clicks into Castcade (the Match tab) while it waits; then its turn comes.
    cw.w.active = true;
    await H.mh.passTurn();
    await until(() => C.mh.status().panel?.myTurn === true);
    await until(() => cw.w.gives === 1);
    await until(() => cl.lines.some((l) => l.startsWith('match: gave VPX the foreground (the turn came to this PC')));
    // The same turn, later status changes: not again.
    C.mh.setSettings({ cueVolume: 60 });
    expect(cw.w.gives).toBe(1);
    expect(hw.w.gives).toBe(0);
  }, 20_000);

  it('when it cannot be done the log says why and what to do, once', async () => {
    const hw = windows({ ok: false, title: null, why: 'no "Visual Pinball Player" window was found' });
    const hl = logLines();
    const { H } = await pair({ foreground: hw.foreground, log: hl.log });
    await H.mh.start();
    await until(() => hl.lines.some((l) => l.includes('could not give VPX the foreground')));
    expect(hl.lines.filter((l) => l.includes('VPX the foreground'))).toEqual(['match: could not give VPX the foreground (the turn came to this PC): no "Visual Pinball Player" window was found. Click the table to play']);
    expect(hw.w.gives).toBe(1);
  }, 20_000);

  it('never while the in-game menu is open', async () => {
    const hw = windows();
    const held = new Map<string, () => void>();
    const shortcuts = { register: (acc: string, cb: () => void) => (held.set(acc, cb), true), unregister: (acc: string) => void held.delete(acc) };
    let t = 1_000_000;
    const { H } = await pair({ foreground: hw.foreground, shortcuts, now: () => t });
    t += 1000;
    held.get('Control+Alt+M')!();
    await H.mh.start();
    await until(() => H.mh.status().panel?.myTurn === true);
    await new Promise((r) => setTimeout(r, 50));
    expect(hw.w.gives).toBe(0);
  }, 20_000);
});
