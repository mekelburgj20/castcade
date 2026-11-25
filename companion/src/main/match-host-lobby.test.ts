/**
 * A17 step 7 (2026-11-25, docs/design/alpha-match.md section 11.12): the shell with the lobby on. Real match hosts
 * (Electron stubbed: the cue window only), through the relay double or over their own listeners, each with a rig the
 * test drives (a table whose hook journals: `gameStart`, `ball`, `gameEnd`) and recording fakes for what a lobby must
 * leave alone between matches: the panel page (its voice peers, its attach and detach), the table sound helper, the
 * video helper and the state stream's tunnel.
 *
 * What is pinned here: one lobby, many matches (not one voice peer added or removed between two matches); a member
 * who watches (locked while a game is played, shown and played the player who is up, reports nothing; left alone in
 * a game of their own); the lobby's PC that only watches; a member who joins while a ball is in play; a start asked
 * for by a client, from the button and from the starter's own table; a waiting player whose link drops; the lobby's
 * PC whose connection to ArcAid is away for a while during a ball; a member who leaves; the lobby closed.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

const { createMatchHost } = await import('./match-host.js');
const { matchSignalling } = await import('./match-setup.js');
const { startFakeRelay } = await import('../match/relay-fake.test-support.js');
const { RelayHostTransport } = await import('../match/transport-relay.js');
const { RESUME_FILE } = await import('./match-resume.js');
const { headerText } = await import('../media/panel-page.js');
type FakeRelay = Awaited<ReturnType<typeof startFakeRelay>>;
type MatchHost = ReturnType<typeof createMatchHost>;
type Options = Parameters<typeof createMatchHost>[0];
type WitnessHost = Options['witness'];
type Logger = Options['log'];
type WStatus = ReturnType<WitnessHost['status']>;
type Listener = Parameters<WitnessHost['onEvent']>[0];
type Feed = Parameters<Listener>[0];

const SHA = 'ab'.repeat(32);

const until = async (cond: () => boolean, ms = 8000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A rig: VPX with a table open and the hook journaling; the test is the player. `ballEnds: false`: a machine whose ball ends cannot be read (C18). */
function rig(o: { table?: boolean; ballEnds?: boolean } = {}) {
  const eventCbs = new Set<Listener>();
  const statusCbs = new Set<(s: WStatus) => void>();
  let inGame = false;
  let open = o.table !== false;
  // A17 step 10: the table that is open can be another one (the PC closed its table and opened the lobby's).
  let name = 'Test Table';
  let sha = SHA;
  const say = (ev: Feed): void => {
    if (ev.kind === 'game_start') inGame = true;
    else if (ev.kind === 'game_end' || ev.kind === 'game_abandoned') inGame = false;
    for (const cb of [...eventCbs]) cb(ev, { backlog: false, mark: { path: '/journal/table.jsonl', session: 's1', loaded: 50, offset: 100 } });
  };
  const status = (): WStatus =>
    ({
      paired: false,
      currentTable: open ? name : null,
      currentIdentity: open ? { sha256: sha, tableInfo: null } : null,
      currentAttestation: null,
      captureMode: open ? 'live' : 'none',
      note: null,
      ...(o.ballEnds === false ? { ballEnds: false, ballEndsNote: 'this machine does not say when a ball ends' } : {}),
    }) as unknown as WStatus;
  const w = {
    status,
    sampleVr: async () => null,
    liveGame: () => ({ table: name, inGame, scores: [], player: null, ball: null }),
    onEvent: (cb: Listener) => (eventCbs.add(cb), () => eventCbs.delete(cb)),
    onStatus: (cb: (s: WStatus) => void) => (statusCbs.add(cb), () => statusCbs.delete(cb)),
    journalMark: () => null,
  } as unknown as WitnessHost;
  return {
    w,
    gameStart: () => say({ kind: 'game_start', t: 0, players: 1 } as Feed),
    score: (ball: number, score: number) => say({ kind: 'current_scores', t: 0, scores: [score], player: 1, ball } as Feed),
    ballEnd: (ball: number) => say({ kind: 'ball_end', t: 0, player: 1, ball, extraBalls: 0 } as Feed),
    gameEnd: (score: number) => say({ kind: 'game_end', t: 0, scores: [score], players: 1 } as Feed),
    /** One ball played to its end at `score`. */
    ball(ball: number, score: number) {
      this.score(ball, score);
      this.ballEnd(ball);
      this.score(ball, score);
    },
    /** The table closes (VPX quits), or opens. */
    exit: () => {
      inGame = false;
      for (const cb of [...eventCbs]) cb({ kind: 'table_exit' } as unknown as Feed, undefined);
    },
    openTable: () => {
      open = true;
      for (const cb of [...statusCbs]) cb(status());
    },
    /** A17 step 10: this PC's VPX has another table open now (closed and opened: one status, as the lobby hears it in the end). */
    setTable: (table: string, hash: string) => {
      name = table;
      sha = hash;
      open = true;
      inGame = false;
      for (const cb of [...statusCbs]) cb(status());
    },
    inGame: () => inGame,
  };
}

/**
 * The panel page, recording: the voice peers it was told to open and close, its attach and detach, what it sends.
 * Every connection it holds is up (its own word, whatever the match's link does: A18), and `seen` names the players
 * whose picture arrives on it.
 */
function page() {
  const log: string[] = [];
  let attached = false;
  const seen = new Set<string>();
  const media = {
    async attach() {
      attached = true;
      log.push('attach');
    },
    addPeer: (p: string) => void log.push(`addPeer ${p}`),
    removePeer: (p: string) => void log.push(`removePeer ${p}`),
    setSending: (on: boolean) => void (log.at(-1) !== `sending ${on}` && log.push(`sending ${on}`)),
    setPanelState: () => undefined,
    setMuted: () => undefined,
    setTableAudio: (x: { send: boolean; hear: boolean }) => void (log.at(-1) !== `table send ${x.send} hear ${x.hear}` && log.push(`table send ${x.send} hear ${x.hear}`)),
    status: () => ({ attached, sending: false, peers: Object.fromEntries(held().map((id) => [id, { ice: 'connected', receivingVideo: seen.has(id), receivingAudio: true }])), mic: 'open', captureSource: null, lastError: null }),
    onStatus: () => () => undefined,
    frames: () => null,
    videoFrames: () => null,
    showPanel: () => undefined,
    capturePid: () => 4242,
    async detach() {
      attached = false;
      log.push('detach');
    },
    async setVr() {},
  };
  /** The peers the page holds now. */
  function held(): string[] {
    const set = new Set<string>();
    for (const l of log) {
      if (l.startsWith('addPeer ')) set.add(l.slice(8));
      if (l.startsWith('removePeer ')) set.delete(l.slice(11));
    }
    return [...set].sort();
  }
  const voiceCalls = (): string[] => log.filter((l) => l.startsWith('addPeer ') || l.startsWith('removePeer '));
  return { media: media as unknown as NonNullable<Options['media']>, log, held, voiceCalls, seen };
}

/** The table sound helper, recording what it is told to mute and tap. */
function tableSound() {
  const wants: Array<{ mutePid: number | null; tapPid: number | null }> = [];
  const ta = {
    start: () => undefined,
    apply: (w: { mutePid: number | null; tapPid: number | null }) => void wants.push({ ...w }),
    level: () => undefined,
    unlevel: () => undefined,
    status: () => ({ helper: 'ready' as const, reason: null, muted: false, tapping: false }),
    onStatus: () => () => undefined,
    onFrame: () => () => undefined,
    stop: async () => undefined,
  };
  return { ta: ta as unknown as NonNullable<Options['tableAudio']>, last: () => wants.at(-1) ?? { mutePid: null, tapPid: null }, count: () => wants.length, since: (n: number) => wants.slice(n) };
}

type Cmd = Record<string, unknown> & { cmd: string };
type Ev = Record<string, unknown> & { event: string };
/** The video helper, ready at once, recording its commands (`peer` opens a connection, `close` closes one). */
function videoHelper() {
  const sent: Cmd[] = [];
  const eventCbs = new Set<(e: Ev) => void>();
  const say = (e: Ev) => eventCbs.forEach((cb) => cb(e));
  const helper = {
    start: () => undefined,
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
  const peers = (): string[] => sent.filter((c) => c.cmd === 'peer').map((c) => String(c.id));
  const closed = (): string[] => sent.filter((c) => c.cmd === 'close' || c.cmd === 'unpeer').map((c) => String(c.id));
  return { helper: helper as unknown as NonNullable<Options['nativeVideo']>['helper'], sent, peers, closed };
}

const dirs: string[] = [];
const hosts: MatchHost[] = [];
const relays: FakeRelay[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.stop();
  for (const r of relays.splice(0)) await r.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Seat {
  mh: MatchHost;
  r: ReturnType<typeof rig>;
  page: ReturnType<typeof page>;
  sound: ReturnType<typeof tableSound>;
  video: ReturnType<typeof videoHelper>;
  lock: string;
  dir: string;
  lines: string[];
  id: () => string;
}

/** A Castcade on a rig. The lobby's clocks are short: a start counts down 150 ms (5 s in the app). */
function seat(name: string, extra: Partial<Options> = {}, r0: ReturnType<typeof rig> = rig(), dir0?: string): Seat {
  const dir = dir0 ?? mkdtempSync(join(tmpdir(), `castcade-lobby-${name}-`));
  if (!dir0) dirs.push(dir);
  const lock = join(dir, 'lock', 'turn.lock');
  const lines: string[] = [];
  const log = { info: (l: string) => void lines.push(l), warn: (l: string) => void lines.push(l), error: (l: string) => void lines.push(l), file: '' } as unknown as Logger;
  const p = page();
  const sound = tableSound();
  const video = videoHelper();
  const mh = createMatchHost({
    file: join(dir, 'match.json'),
    keysFile: join(dir, 'match-keys.json'),
    witness: r0.w,
    device: () => ({ deviceId: `dev-${name}`, deviceLabel: name }),
    appVersion: '0.2.51',
    log,
    publicIp: () => Promise.resolve('127.0.0.1'),
    lockFile: lock,
    listenAddress: '127.0.0.1',
    openPort: null,
    ephemeralPort: true,
    media: p.media,
    tableAudio: sound.ta,
    nativeVideo: { helper: video.helper, sendRing: `send-${name}`, recvRing: `recv-${name}` },
    signalling: (role: Parameters<typeof matchSignalling>[0], me: string) => matchSignalling(role, me),
    lobby: { countdownMs: 150 },
    seriesOverLingerMs: 300,
    ...extra,
  });
  hosts.push(mh);
  return { mh, r: r0, page: p, sound, video, lock, dir, lines, id: () => mh.status().localId as string };
}

const relay = async (o: { hostGraceMs?: number } = {}): Promise<FakeRelay> => {
  const r = await startFakeRelay({ devices: { 'dev-h': 'tok-h', 'dev-a': 'tok-a', 'dev-b': 'tok-b', 'dev-c': 'tok-c' }, ...o });
  relays.push(r);
  return r;
};
const via = (r: FakeRelay, id: string): Partial<Options> => ({ relay: () => ({ baseUrl: r.url, deviceId: `dev-${id}`, deviceToken: `tok-${id}` }), relayTimeouts: { connectMs: 1500, ackMs: 1500 } });

const up = (s: Seat, ball: number): boolean => s.mh.status().panel?.myTurn === true && s.mh.status().panel?.ball === ball && s.mh.status().locked === false;
const member = (s: Seat, name: string) => s.mh.status().lobby?.members.find((m) => m.name === name);
const names = (s: Seat): string[] => (s.mh.status().lobby?.members ?? []).map((m) => m.name);
const players = (s: Seat): string[] => (s.mh.status().panel?.players ?? []).map((p) => p.name);

/** A game of `balls` balls each, played by `order` in turn, each ball worth 100 more than the player's last. */
async function playGame(order: Seat[], balls: number, base = 100): Promise<void> {
  const score = new Map<Seat, number>();
  for (let ball = 1; ball <= balls; ball++) {
    for (const s of order) {
      await until(() => up(s, ball));
      if (ball === 1 && !s.r.inGame()) s.r.gameStart();
      const next = (score.get(s) ?? 0) + base + order.indexOf(s) * 10;
      score.set(s, next);
      s.r.ball(ball, next);
    }
  }
  for (const s of order) if (s.r.inGame()) s.r.gameEnd(score.get(s) ?? 0);
}

describe('A17 step 7: one lobby, many matches', () => {
  it('an evening of two matches with a watcher, through ArcAid: the voice, the video helper and the link are made once; a match that ends closes nothing; the watcher plays the next one', async () => {
    const r = await relay();
    const H = seat('h', via(r, 'h'));
    const A = seat('a', via(r, 'a'));
    const B = seat('b', via(r, 'b'));
    const hs = await H.mh.host({ port: 0, ballsPerGame: 2, displayName: 'Owner' });
    expect(hs.invite).toMatch(/^[A-Z]{6}$/);
    expect(hs).toMatchObject({ role: 'host', phase: 'lobby' });
    // The room is open to newcomers for the whole evening: never locked.
    expect(r.locked(hs.code!)).toBe(false);
    await A.mh.join(hs.invite!, 'Krobs');
    // B joins set to Watch (the choice is kept per PC and said at the join).
    B.mh.setStance('watch');
    await B.mh.join(hs.invite!, 'Chuck');
    await until(() => names(H).length === 3 && names(A).length === 3 && names(B).length === 3);
    expect(names(A)).toEqual(['Owner', 'Krobs', 'Chuck']);
    expect(H.mh.status().lobby?.members.map((m) => [m.name, m.stance, m.opener])).toEqual([
      ['Owner', 'play', true],
      ['Krobs', 'play', false],
      ['Chuck', 'watch', false],
    ]);
    // Everyone hears everyone before any match: a full mesh of three.
    await until(() => H.page.held().length === 2 && A.page.held().length === 2 && B.page.held().length === 2);
    const voiceBefore = [H, A, B].map((s) => s.page.voiceCalls().length);
    const videoBefore = [H, A, B].map((s) => s.video.peers().length);
    expect(videoBefore).toEqual([2, 2, 2]);

    // The start line says who plays and who watches; the starter is the opener (first in the lobby set to Play).
    expect(A.mh.status().lobby).toMatchObject({ starter: H.id(), startButton: { label: 'Start match', off: null, line: 'Owner and Krobs play. Chuck watches.' } });
    expect(B.mh.status().panel?.message).toBe('You are set to Watch: the match starts without you');
    expect(H.mh.status().panel?.message).toBe('Everyone in? Start a game on your table (or Start match in the menu)');
    expect(A.mh.status().panel?.message).toBe('Owner starts the match from their table. To start it yourself: Start match in the menu');

    // Match 1, asked for by the opener from the Match tab: it counts down for everyone, then starts with the asker first.
    await H.mh.start();
    await until(() => A.mh.status().lobby?.start?.seconds !== undefined && A.mh.status().lobby?.start !== null);
    expect(A.mh.status().lobby?.start).toMatchObject({ by: H.id(), newMatch: true, waitsFor: null, players: [H.id(), A.id()] });
    expect(A.mh.status().panel?.message).toBe('Owner starts the match: Owner, you');
    // The tables of the people in the start are locked while it counts down; the watcher's is not.
    await until(() => A.mh.status().locked === true);
    expect(B.mh.status().locked).toBe(false);
    await until(() => up(H, 1));
    expect(H.mh.status().lobby?.match).toMatchObject({ id: `${hs.code}-1`, state: 'game', players: [H.id(), A.id()] });
    // The watcher: in no roster, locked while the game is played, shown the players of the match.
    await until(() => B.mh.status().phase === 'playing' && B.mh.status().locked === true);
    expect(players(B)).toEqual(['Owner', 'Krobs']);
    expect(B.mh.status().panel).toMatchObject({ myTurn: false, playerUp: H.id() });
    // The watcher hears the table of the player who is up, and its own is muted; it never sends.
    expect(B.page.log).toContain('table send false hear true');
    expect(B.sound.last()).toEqual({ mutePid: 4242, tapPid: null });

    await playGame([H, A], 2);
    await until(() => H.mh.status().phase === 'over' && A.mh.status().phase === 'over' && B.mh.status().phase === 'over');
    // Between games: the starter's table is free, the other player's locked, the watcher's free.
    expect([H, A, B].map((s) => s.mh.status().locked)).toEqual([false, true, false]);
    expect(A.mh.status().lobby?.startButton).toMatchObject({ label: 'Next game' });

    // End match, asked for by the client: everyone is back in the lobby and nothing closes.
    await A.mh.endMatch({ everyone: false });
    await until(() => [H, A, B].every((s) => s.mh.status().phase === 'lobby' && s.mh.status().lobby?.match === null));
    expect([H, A, B].map((s) => s.mh.status().locked)).toEqual([false, false, false]);
    expect([H, A, B].map((s) => s.mh.status().role)).toEqual(['host', 'client', 'client']);
    expect(H.mh.status().panel?.message).toMatch(/^Match over after 1 game · /);
    // A17 step 8: the record is the lobby's: it stays when a match ends, and says that no match is open.
    expect(JSON.parse(readFileSync(join(A.dir, RESUME_FILE), 'utf8'))).toMatchObject({ version: 2, role: 'client', code: hs.code, matchId: null, log: [] });

    // The watcher sets themselves to Play, the opener to Watch: match 2 is the other two, started by B.
    B.mh.setStance('play');
    H.mh.setStance('watch');
    await until(() => member(A, 'Chuck')?.stance === 'play' && member(A, 'Owner')?.stance === 'watch');
    await B.mh.start();
    await until(() => up(B, 1), 10_000);
    expect(H.mh.status().lobby?.match).toMatchObject({ id: `${hs.code}-2`, players: [B.id(), A.id()] });
    // The lobby's PC only watches: it arbitrates, is locked, is in no roster and holds no turn.
    await until(() => H.mh.status().phase === 'playing' && H.mh.status().locked === true);
    expect(players(H)).toEqual(['Chuck', 'Krobs']);
    await playGame([B, A], 2);
    await until(() => [H, A, B].every((s) => s.mh.status().phase === 'over'));
    expect(H.mh.status().panel?.result?.map((x) => x.name)).toEqual(['Krobs', 'Chuck']);

    // Not one voice connection was opened or closed since the join, and not one of the video helper's.
    expect([H, A, B].map((s) => s.page.voiceCalls().length)).toEqual(voiceBefore);
    expect([H, A, B].map((s) => s.video.peers().length)).toEqual(videoBefore);
    expect([H, A, B].flatMap((s) => s.video.closed())).toEqual([]);
    expect([H, A, B].flatMap((s) => s.page.log.filter((l) => l === 'detach'))).toEqual([]);
    expect(r.locked(hs.code!)).toBe(false);

    // The opener closes the lobby: everyone is told, lets go of every voice at once, and closes by itself.
    await H.mh.leave();
    expect(H.mh.status().role).toBe('none');
    await until(() => A.page.held().length === 0 && B.page.held().length === 0);
    expect(A.mh.status().panel?.message).toBe('The lobby is closed: Owner closed the lobby');
    await until(() => A.mh.status().role === 'none' && B.mh.status().role === 'none');
    expect(A.mh.status().lastError).toBe('The lobby is closed: Owner closed the lobby');
    expect([A, B].map((s) => existsSync(s.lock))).toEqual([false, false]);
  }, 60_000);

  it('a start asked for by a client: from the button, and from the starter\'s own table (that game is the next game\'s first, and what it says in the countdown counts); anybody else\'s game on a table is their own, and a start waits for it', async () => {
    const H = seat('h', { relay: () => null });
    const A = seat('a', { relay: () => null });
    const hs = await H.mh.host({ port: 0, ballsPerGame: 3, displayName: 'Owner' });
    await A.mh.join(hs.invite!, 'Krobs');
    await until(() => names(H).length === 2 && names(A).length === 2);

    // (1) The client presses Start: both PCs count down with the client's name, and the client goes first.
    await A.mh.start();
    await until(() => (H.mh.status().lobby?.start ?? null) !== null);
    expect(H.mh.status().lobby?.start).toMatchObject({ by: A.id(), players: [A.id(), H.id()], newMatch: true, waitsFor: null });
    expect(H.mh.status().panel?.message).toBe('Krobs starts the match: Krobs, you');
    expect(typeof H.mh.status().panel?.countdown).toBe('number');
    await until(() => up(A, 1));
    expect(H.mh.status().locked).toBe(true);
    await playGame([A, H], 3);
    await until(() => H.mh.status().phase === 'over' && A.mh.status().phase === 'over');

    // (2) Between games the starter is the player who went first, here the client. A game it starts on its own
    // table asks for the next game; the lobby's PC, a player of the match, is locked and cannot.
    expect([H.mh.status().lobby?.starter, A.mh.status().lobby?.starter]).toEqual([A.id(), A.id()]);
    expect([H.mh.status().locked, A.mh.status().locked]).toEqual([true, false]);
    expect(A.mh.status().panel?.message).toBe('Next game: start a game on your table (or Next game in the menu)');
    expect(H.mh.status().panel?.message).toBe('Next game: Krobs starts a game on their table. To start it yourself: Next game in the menu');
    A.r.gameStart();
    await until(() => (H.mh.status().lobby?.start ?? null) !== null);
    expect(H.mh.status().lobby?.start).toMatchObject({ by: A.id(), players: [A.id(), H.id()], newMatch: false, waitsFor: null });
    expect(H.mh.status().panel?.message).toBe('Krobs starts the next game: Krobs, you');
    // What that table says while the start counts down is this player's first ball: nothing of it is lost.
    A.r.score(1, 700);
    expect(A.mh.status().locked).toBe(false);
    await until(() => up(A, 1));
    await until(() => H.mh.status().panel?.players.find((x) => x.name === 'Krobs')?.score === 700);
    expect(A.mh.status().panel?.message ?? '').not.toContain('Press Start');
    expect(A.mh.status().lobby?.match).toMatchObject({ game: 2, state: 'game' });
    // The rest of game 2.
    A.r.ball(1, 900);
    for (let ball = 1; ball <= 3; ball++) {
      await until(() => up(H, ball));
      if (ball === 1) H.r.gameStart();
      H.r.ball(ball, ball * 50);
      if (ball < 3) {
        await until(() => up(A, ball + 1));
        A.r.ball(ball + 1, 900 + ball * 100);
      }
    }
    A.r.gameEnd(1100);
    H.r.gameEnd(150);
    await until(() => H.mh.status().phase === 'over' && A.mh.status().phase === 'over');
    // One game each (the opener took game 1 by thirty points); the tally goes on from game to game.
    expect(H.mh.status().panel?.series?.map((x) => [x.name, x.wins, x.games])).toEqual([
      ['Krobs', 1, 2],
      ['Owner', 1, 2],
    ]);

    // (3) Back in the lobby the starter is the first member set to Play: the opener. The client's game on its own
    // table is never a request: it is a game of its own, which every roster says, and a start waits for it.
    await H.mh.endMatch({ everyone: false });
    await until(() => A.mh.status().phase === 'lobby' && H.mh.status().phase === 'lobby');
    expect(A.mh.status().lobby?.starter).toBe(H.id());
    A.r.gameStart();
    await until(() => member(H, 'Krobs')?.flags.includes('own_game') === true);
    expect(H.mh.status().lobby?.start).toBeNull();
    await H.mh.start();
    await until(() => H.mh.status().lobby?.start?.waitsFor === 'own_games');
    expect(H.mh.status().lobby).toMatchObject({ start: { line: "You start the match once the game on Krobs' table has ended" }, startWithout: 'Start without Krobs' });
    // Never in the middle of a game of one's own: the table stays that player's.
    expect(A.mh.status().locked).toBe(false);
    A.r.gameEnd(123);
    await until(() => member(H, 'Krobs')?.flags.includes('own_game') === false);
    await until(() => up(H, 1));
    expect(H.mh.status().lobby?.match).toMatchObject({ id: `${hs.code}-2`, players: [H.id(), A.id()] });

    // (4) Cancel: a start that counts down is taken back by the other person, and both tables are free again.
    await H.mh.endMatch({ everyone: true });
    await until(() => A.mh.status().phase === 'lobby' && H.mh.status().phase === 'lobby');
    expect(H.lines.some((l) => l.includes('End match for everyone'))).toBe(true);
    expect(H.mh.status().panel?.message).toMatch(/^Match ended · game 1 not finished · /);
  }, 60_000);

  it('a watcher\'s own table: a game of their own that runs when the match starts is left alone (table, view and sound) until it ends, then the lock goes on; its game end and its table closing during the match send nothing and put nothing on its panel', async () => {
    const H = seat('h', { relay: () => null });
    const A = seat('a', { relay: () => null });
    const W = seat('b', { relay: () => null });
    const hs = await H.mh.host({ port: 0, ballsPerGame: 3, displayName: 'Owner' });
    await A.mh.join(hs.invite!, 'Krobs');
    W.mh.setStance('watch');
    await W.mh.join(hs.invite!, 'Chuck');
    await until(() => names(W).length === 3 && names(H).length === 3);
    // The watcher plays alone in the lobby: the lobby is told, and every roster says OWN GAME.
    W.r.gameStart();
    W.r.score(1, 5000);
    await until(() => member(H, 'Chuck')?.flags.includes('own_game') === true);
    await H.mh.start();
    await until(() => up(H, 1));
    await until(() => W.mh.status().phase === 'playing');
    // The match is played; the watcher keeps their own table, its sound, and is not played the other table.
    expect(W.mh.status().locked).toBe(false);
    expect(W.sound.last()).toEqual({ mutePid: null, tapPid: null });
    expect(W.page.log.filter((l) => l.startsWith('table send'))).not.toContain('table send false hear true');
    const sentBefore = H.lines.filter((l) => l.includes('rejected') || l.includes('REJECT')).length;
    // Their own game ends: nothing is sent to the match, nothing is on their panel, and now the lock goes on.
    W.r.ballEnd(1);
    W.r.gameEnd(5000);
    await until(() => W.mh.status().locked === true);
    await until(() => member(H, 'Chuck')?.flags.includes('own_game') === false);
    expect(W.sound.last()).toEqual({ mutePid: 4242, tapPid: null });
    expect(W.page.log).toContain('table send false hear true');
    expect(W.mh.status().panel?.message ?? null).toBeNull();
    // Their table closes during the match: no forfeit, no line, no rejection anywhere.
    W.r.exit();
    await sleep(150);
    expect(W.mh.status().panel?.message ?? null).toBeNull();
    expect(W.lines.filter((l) => /GAME_OVER|FORFEIT|rejected/.test(l))).toEqual([]);
    expect(H.lines.filter((l) => l.includes('rejected') || l.includes('REJECT')).length).toBe(sentBefore);
    expect(H.mh.status().panel?.players.map((x) => x.name)).toEqual(['Owner', 'Krobs']);
    // The game goes on as if nothing had happened.
    H.r.gameStart();
    H.r.ball(1, 100);
    await until(() => up(A, 1));
    // The watcher leaves in the middle of it: the players see only the row go; the place is free at once.
    await W.mh.leave();
    await until(() => names(H).length === 2 && names(A).length === 2);
    expect(up(A, 1)).toBe(true);
    expect(H.mh.status().phase).toBe('playing');
    expect(H.lines.filter((l) => l.includes('FORFEIT'))).toEqual([]);
  }, 60_000);

  it('a member joins while a ball is in play: they are in the roster and hear everyone at once, and watch; the video connection between them and the player who is up is opened only when that ball has ended', async () => {
    const r = await relay();
    const H = seat('h', via(r, 'h'));
    const A = seat('a', via(r, 'a'));
    const N = seat('b', via(r, 'b'));
    const hs = await H.mh.host({ port: 0, ballsPerGame: 3, displayName: 'Owner' });
    await A.mh.join(hs.invite!, 'Krobs');
    await until(() => names(A).length === 2);
    await H.mh.start();
    await until(() => up(H, 1));
    H.r.gameStart();
    H.r.score(1, 4200);
    await until(() => A.mh.status().panel?.players.find((x) => x.name === 'Owner')?.score === 4200);

    // The newcomer joins in the middle of the opener's ball.
    await N.mh.join(hs.invite!, 'Chuck');
    await until(() => N.mh.status().phase === 'playing' && names(N).length === 3 && names(H).length === 3);
    // In the lobby, in no roster: a watcher of the match that is open, locked while it is played.
    expect(N.mh.status().lobby?.match).toMatchObject({ id: `${hs.code}-1`, state: 'game', players: [H.id(), A.id()] });
    expect(players(N)).toEqual(['Owner', 'Krobs']);
    expect(N.mh.status().panel).toMatchObject({ playerUp: H.id(), myTurn: false, ball: 1 });
    expect(N.mh.status().locked).toBe(true);
    // The voice at once, with everyone, the player who is up included.
    await until(() => N.page.held().length === 2 && H.page.held().length === 2 && A.page.held().length === 2);
    // The video: with the waiting player at once; with the player who is on a ball, not yet, on either PC.
    await until(() => N.video.peers().includes(A.id()) && A.video.peers().includes(N.id()));
    expect(N.video.peers()).not.toContain(H.id());
    expect(H.video.peers()).toEqual([A.id()]);
    // The ball ends: now the two are connected, and the game goes on.
    H.r.ball(1, 4300);
    await until(() => up(A, 1));
    await until(() => H.video.peers().includes(N.id()) && N.video.peers().includes(H.id()));
    expect(H.lines.some((l) => l.includes('the ball that was in play when they came together has ended'))).toBe(true);
    // The newcomer joined on Play: the next game of the open match is still its two players'; a new match takes them in.
    expect(N.mh.status().lobby?.stance).toBe('play');
    expect(N.mh.status().panel?.players.find((x) => x.name === 'Owner')?.score).toBe(4300);
  }, 60_000);

  it('Cancel the start frees both tables; a member who is not in the open match starts a new one by name (Start a new match), and Next game stays the match\'s own players\'', async () => {
    const H = seat('h', { relay: () => null, lobby: { countdownMs: 4000 } });
    const A = seat('a', { relay: () => null });
    const B = seat('b', { relay: () => null });
    const hs = await H.mh.host({ port: 0, ballsPerGame: 3, displayName: 'Owner' });
    await A.mh.join(hs.invite!, 'Krobs');
    await until(() => names(H).length === 2 && names(A).length === 2);
    // A start counts down (4 s here): both tables are locked; the other person takes it back, and both are free.
    await H.mh.start();
    await until(() => A.mh.status().locked === true && H.mh.status().locked === true);
    expect(H.mh.status().panel?.countdown).toBeGreaterThan(0);
    await A.mh.cancelStart();
    await until(() => A.mh.status().locked === false && H.mh.status().locked === false);
    expect(H.mh.status().lobby?.start).toBeNull();
    expect(H.mh.status().lastError).toBe('Krobs cancelled the start.');
    expect(H.mh.status().phase).toBe('lobby');
    // A second press of Start while one counts down changes nothing: the asker sees the start that is announced.
    await H.mh.start();
    await A.mh.start();
    await until(() => (A.mh.status().lobby?.start ?? null) !== null);
    expect(A.mh.status().lobby?.start).toMatchObject({ by: H.id(), players: [H.id(), A.id()] });
    await until(() => up(H, 1), 10_000);
    // A third person joins during the match, set to Play: they watch it.
    await B.mh.join(hs.invite!, 'Chuck');
    await playGame([H, A], 3);
    await until(() => [H, A, B].every((s) => s.mh.status().phase === 'over'));
    // Between games: Next game is the open match's own players'; the newcomer comes in only by a new match, which
    // is offered because somebody outside the match is set to Play.
    expect(B.mh.status().lobby).toMatchObject({ startButton: { label: 'Next game' }, newMatch: { line: 'Chuck plays too. The match that is open ends at Krobs 1, Owner 0.', warnings: [] } });
    expect(B.mh.status().panel?.message).toBe('You are watching this match: you are in when somebody starts a new match');
    await B.mh.start({ newMatch: true });
    await until(() => H.mh.status().lobby?.start?.newMatch === true);
    expect(H.mh.status().lobby?.start?.players).toEqual([B.id(), H.id(), A.id()]);
    await until(() => up(B, 1), 15_000);
    // The match that was open ended at that moment, with its tally; the new one is everyone set to Play, the asker first.
    expect(H.lines.some((l) => l.includes(`the match in ${hs.code} is over (1 game with a result: a new match was started)`))).toBe(true);
    expect(H.lines.some((l) => l.includes('FORFEIT'))).toBe(false);
    expect(H.mh.status().lobby?.match).toMatchObject({ id: `${hs.code}-2`, players: [B.id(), H.id(), A.id()] });
    expect(players(A)).toEqual(['Chuck', 'Owner', 'Krobs']);
  }, 60_000);

  it('a waiting player\'s link drops while another is on a ball (ruling 8): the player who is up sees only the row say AWAY; no pause, no voice connection opened or closed; the game waits at the absent player\'s own turn, and the lobby\'s PC plays on without them', async () => {
    const r = await relay();
    const grace = { disconnectGraceMs: 200 };
    const H = seat('h', { ...via(r, 'h'), ...grace });
    const A = seat('a', { ...via(r, 'a'), ...grace });
    const B = seat('b', { ...via(r, 'b'), ...grace });
    const hs = await H.mh.host({ port: 0, ballsPerGame: 3, displayName: 'Owner' });
    await A.mh.join(hs.invite!, 'Krobs');
    await B.mh.join(hs.invite!, 'Chuck');
    await until(() => names(H).length === 3 && [H, A, B].every((s) => s.page.held().length === 2));
    await H.mh.start();
    await until(() => up(H, 1));
    H.r.gameStart();
    H.r.score(1, 300);
    const voice = [H, A].map((s) => s.page.voiceCalls().length);
    const seen: string[] = [];
    const off = H.mh.onStatus((s) => void seen.push(`${s.phase}/${s.locked}`));

    // Chuck's link to ArcAid goes and does not come back (the pairing is revoked): past the grace Chuck is away.
    r.revoke('dev-b');
    r.dropDevice('dev-b');
    await until(() => member(H, 'Chuck')?.flags.includes('away') === true && member(A, 'Chuck')?.flags.includes('away') === true);
    // For the player who is up nothing else changed: playing, unlocked, the same voice connections.
    expect(new Set(seen)).toEqual(new Set(['playing/false']));
    expect([H, A].map((s) => s.page.voiceCalls().length)).toEqual(voice);
    expect(H.mh.status().lobby?.waitedFor).toBeNull();
    expect(H.lines.some((l) => l.includes('Chuck is away') && l.includes('nothing is paused for it'))).toBe(true);
    off();

    // The ball goes on and ends; Krobs plays; then the turn reaches Chuck, who is away: now the game waits, for Chuck.
    H.r.ball(1, 400);
    await until(() => up(A, 1));
    A.r.gameStart();
    A.r.ball(1, 500);
    await until(() => H.mh.status().phase === 'paused' && A.mh.status().phase === 'paused');
    expect(H.mh.status().panel?.message).toBe('Waiting for Chuck to come back');
    expect(H.mh.status().lobby?.waitedFor).toMatchObject({ name: 'Chuck' });
    expect(H.mh.status().lobby?.awayQuestion).toBeNull();
    // Play on without Chuck (the lobby's PC): Chuck is out of this game, and the turn goes on.
    await H.mh.playOnWithout();
    await until(() => up(H, 2));
    expect(H.mh.status().lobby?.waitedFor).toBeNull();
    expect(names(H)).toEqual(['Owner', 'Krobs', 'Chuck']);
  }, 60_000);

  it('the player who is up drops and is still seen playing: no clock forfeits them; the lobby\'s PC is asked, and End their ball passes the turn at the score as it stands', async () => {
    const r = await relay();
    const H = seat('h', { ...via(r, 'h'), disconnectGraceMs: 100, lobby: { countdownMs: 50, turnMs: 400 } });
    const A = seat('a', { ...via(r, 'a'), disconnectGraceMs: 100 });
    const hs = await H.mh.host({ port: 0, ballsPerGame: 3, displayName: 'Owner' });
    await A.mh.join(hs.invite!, 'Krobs');
    await until(() => names(H).length === 2);
    await A.mh.start();
    await until(() => up(A, 1));
    A.r.gameStart();
    A.r.score(1, 12_300);
    await until(() => H.mh.status().panel?.players.find((x) => x.name === 'Krobs')?.score === 12_300);
    // Krobs' picture reaches the lobby's PC (it never crossed ArcAid); his link to the lobby does not.
    H.page.seen.add(A.id());
    r.revoke('dev-a');
    r.dropDevice('dev-a');
    await until(() => H.mh.status().phase === 'paused');
    expect(H.mh.status().lobby?.waitedFor).toMatchObject({ name: 'Krobs' });
    // The turn clock (0.4 s here, three minutes in the app) runs out: nothing is done by itself. The owner is asked.
    await until(() => H.mh.status().lobby?.awayQuestion !== null, 5000);
    expect(H.mh.status().lobby?.awayQuestion).toMatchObject({ name: 'Krobs', score: 12_300 });
    expect(H.lines.filter((l) => l.includes('FORFEIT'))).toEqual([]);
    // Keep waiting: asked again after another turn clock.
    await H.mh.answerAway('wait');
    expect(H.mh.status().lobby?.awayQuestion).toBeNull();
    await until(() => H.mh.status().lobby?.awayQuestion !== null, 5000);
    // End their ball: the turn passes at the score of his last STATE, not at his last logged score (0).
    await H.mh.answerAway('end_ball');
    await until(() => up(H, 1));
    expect(H.mh.status().panel?.players.find((x) => x.name === 'Krobs')).toMatchObject({ score: 12_300, ballsDone: 1 });
    await expect(H.mh.answerAway('wait')).rejects.toThrow(/Nobody is asked about now/);
  }, 60_000);

  it("the lobby PC's connection to ArcAid is away for a while during a member's ball: nobody is paused on any PC; the ball ends meanwhile, that table locks at once, and the ball end is reported when the lobby's PC is back; then the turn goes on", async () => {
    const r = await relay();
    // A member asks for a room that is gone again soon here (5 s, 25 s, then 150 s in the app).
    const soon = { relayRejoin: { gapsMs: [200, 400, 800] } };
    const H = seat('h', { ...via(r, 'h') });
    const A = seat('a', { ...via(r, 'a'), ...soon });
    const hs = await H.mh.host({ port: 0, ballsPerGame: 3, displayName: 'Owner' });
    await A.mh.join(hs.invite!, 'Krobs');
    await until(() => names(H).length === 2);
    await A.mh.start();
    await until(() => up(A, 1));
    A.r.gameStart();
    A.r.score(1, 700);
    await until(() => H.mh.status().panel?.players.find((x) => x.name === 'Krobs')?.score === 700);
    const phases = { h: [] as string[], a: [] as string[] };
    const offs = [H.mh.onStatus((s) => void phases.h.push(s.phase)), A.mh.onStatus((s) => void phases.a.push(s.phase))];

    // ArcAid is gone for a second and a half (a deploy): the room is lost with it.
    void r.restart(1500);
    await until(() => H.lines.some((l) => l.includes('ArcAid is not carrying this lobby for the moment')));
    // The ball in play goes on undisturbed, and ends: the player's own Castcade locks the table (no answer will come
    // to tell it) and keeps the ball end to report.
    expect(A.mh.status()).toMatchObject({ phase: 'playing', locked: false });
    A.r.ball(1, 900);
    await until(() => A.mh.status().locked === true);
    expect(A.lines.filter((l) => l.startsWith('match: BALL_END ball 1 score 900'))).toHaveLength(1);
    // The lobby's PC registers the code again; the member asks for the room again and comes back by itself; the ball
    // end that was kept is reported, once, and the next turn starts.
    await until(() => H.lines.some((l) => l.includes(`ArcAid carries ${hs.code} again`)), 15_000);
    await until(() => up(H, 1), 20_000);
    expect(H.mh.status().panel?.players.find((x) => x.name === 'Krobs')).toMatchObject({ score: 900, ballsDone: 1 });
    for (const o of offs) o();
    // Nobody was paused for it, on either PC, and nobody was counted out.
    expect(phases.h.filter((x) => x !== 'playing')).toEqual([]);
    expect(phases.a.filter((x) => x !== 'playing')).toEqual([]);
    expect([...H.lines, ...A.lines].filter((l) => l.includes('FORFEIT') || l.includes('rejected'))).toEqual([]);
    expect(names(H)).toEqual(['Owner', 'Krobs']);
    expect(r.locked(hs.code!)).toBe(false);
  }, 90_000);

  it('a PC on protocol 6 (Castcade 0.2.50) is refused with the sentence, in both directions: its HELLO at this lobby, and this PC\'s join at a lobby of that build', async () => {
    const { WebSocket, WebSocketServer } = await import('ws');
    // (1) A 0.2.50 PC joins this lobby: the answer is in ITS version, so it can show the sentence.
    const H = seat('h', { relay: () => null });
    const hs = await H.mh.host({ port: 0, ballsPerGame: 3, displayName: 'Owner' });
    const old = new WebSocket(`ws://127.0.0.1:${hs.port}`);
    await new Promise<void>((resolve, reject) => {
      old.once('open', () => resolve());
      old.once('error', reject);
    });
    const reply = new Promise<string>((resolve) => old.once('message', (d) => resolve(String(d))));
    old.send(JSON.stringify({ v: 6, type: 'HELLO', matchId: null, seq: 1, ts: 1, from: 'old-pc', payload: { protocolVersion: 6, companionVersion: '0.2.50', throwdownCode: hs.code } }));
    expect(JSON.parse(await reply)).toMatchObject({
      v: 6,
      type: 'REFUSE',
      payload: { code: 'protocol_version', message: 'This lobby needs Castcade 0.2.51 or newer (protocol 7; this PC sent 6). Update Castcade on this PC (Settings, Check for updates) and join again.' },
    });
    old.close();
    expect(names(H)).toEqual(['Owner']);

    // (2) This PC joins a lobby of a 0.2.50 host, which answers in its own version: this PC says which versions the
    // two have, at once, and opens no page and no microphone.
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    server.on('connection', (socket) => {
      socket.on('message', () => {
        socket.send(JSON.stringify({ v: 6, type: 'REFUSE', matchId: null, seq: 1, ts: 1, from: 'old-host', payload: { code: 'protocol_version', message: 'host speaks protocol 6', mismatches: [] } }), () => socket.close());
      });
    });
    try {
      const C = seat('a', { relay: () => null });
      const port = (server.address() as { port: number }).port;
      await expect(C.mh.join(`castcade:ws://127.0.0.1:${port}#ABCDEF`, 'Krobs')).rejects.toThrow(
        "The lobby's PC runs another version of Castcade (protocol 6; this PC has 7). Both need the same: Castcade is updated on the lobby's PC (Settings, Check for updates), then join again.",
      );
      expect(C.mh.status()).toMatchObject({ role: 'none', phase: 'none' });
      expect(C.page.log.filter((l) => l === 'attach' || l.startsWith('addPeer'))).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30_000);

  it("the review of PR 136: Give up this game with the table's game still running: the player watches the rest of the game as anybody who is out of it, nothing says OWN GAME, and the next game starts for both", async () => {
    const H = seat('h', { relay: () => null });
    const A = seat('a', { relay: () => null });
    const hs = await H.mh.host({ port: 0, ballsPerGame: 2, displayName: 'Owner' });
    await A.mh.join(hs.invite!, 'Krobs');
    await until(() => names(H).length === 2 && names(A).length === 2);
    await H.mh.start();
    await until(() => up(H, 1));
    H.r.gameStart();
    H.r.ball(1, 100);
    await until(() => up(A, 1));
    A.r.gameStart();
    A.r.score(1, 50);
    await until(() => H.mh.status().panel?.players.find((x) => x.name === 'Krobs')?.score === 50);
    expect(A.mh.status().lobby?.giveUp).toBe(true);
    await A.mh.giveUp();
    // Out of the game with the table's game still on: locked, and a watcher of the rest of it: the table of the
    // player who is up is played to him, and his own is muted.
    await until(() => up(H, 2) && A.mh.status().locked === true);
    expect(A.r.inGame()).toBe(true);
    expect(member(A, 'Krobs')?.flags).not.toContain('own_game');
    await until(() => A.sound.last()?.mutePid === 4242);
    expect(A.page.log.at(-1)).toBe('table send false hear true');
    H.r.ball(2, 200);
    H.r.gameEnd(200);
    await until(() => H.mh.status().phase === 'over' && A.mh.status().phase === 'over');
    // Between games: Krobs' table is locked (he does not start the next game) with that game still on it. It is not
    // a game of his own: no row says so, on either PC.
    expect(A.mh.status().locked).toBe(true);
    expect(existsSync(A.lock)).toBe(true);
    expect(A.r.inGame()).toBe(true);
    expect([H, A].flatMap((s) => s.mh.status().lobby?.members.flatMap((m) => m.flags) ?? [])).not.toContain('own_game');
    expect(H.mh.status().lobby).toMatchObject({ starter: H.id(), startButton: { label: 'Next game', off: null } });
    // The next game is asked for and starts: nothing is waited for.
    await H.mh.start();
    await until(() => (H.mh.status().lobby?.start ?? null) !== null || H.mh.status().phase === 'playing');
    expect(H.mh.status().lobby?.start?.waitsFor ?? null).toBeNull();
    await until(() => up(H, 1) && H.mh.status().series?.game === 2, 10_000);
    // Krobs plays it: what is left of the game he gave up reports nothing; the game he then starts is this game's.
    H.r.gameStart();
    H.r.ball(1, 300);
    await until(() => up(A, 1));
    A.r.gameEnd(50);
    A.r.gameStart();
    A.r.ball(1, 400);
    await until(() => up(H, 2));
    expect(H.mh.status().panel?.players.find((x) => x.name === 'Krobs')).toMatchObject({ score: 400, ballsDone: 1 });
    expect(A.lines.filter((l) => l.startsWith('match: BALL_END ball'))).toEqual(['match: BALL_END ball 1 score 400']);
  }, 60_000);

  it('the review of PR 136: End match and End match for everyone are two requests, and a press is only about what it was pressed for: End match pressed as the next game begins ends nothing; nor does a press about a game that is over, or a member\'s for everyone', async () => {
    const H = seat('h', { relay: () => null });
    const A = seat('a', { relay: () => null });
    const hs = await H.mh.host({ port: 0, ballsPerGame: 2, displayName: 'Owner' });
    await A.mh.join(hs.invite!, 'Krobs');
    await until(() => names(H).length === 2 && names(A).length === 2);
    expect(H.mh.status().lobby?.gameKey).toBe('');
    await expect(H.mh.endMatch({ everyone: false })).rejects.toThrow('No match is open: nothing was ended.');
    await H.mh.start();
    await playGame([H, A], 2);
    await until(() => H.mh.status().phase === 'over' && A.mh.status().phase === 'over');
    const between = H.mh.status().lobby!.gameKey;
    expect(between).toBe(`${hs.code}-1/1/between`);
    expect(H.mh.status().lobby?.end).toBe('match');
    // Between games there is no game to end for everyone.
    await expect(H.mh.endMatch({ everyone: true })).rejects.toThrow(/no game is being played now/);

    // The next game counts down and begins. The End match that was pressed between games (on the tab as the
    // countdown ran out, or as the second choose in the menu) arrives now.
    await A.mh.start();
    await until(() => up(A, 1) && H.mh.status().series?.game === 2);
    const during = H.mh.status().lobby!.gameKey;
    expect(during).toBe(`${hs.code}-1/2/game`);
    await expect(H.mh.endMatch({ everyone: false, about: between })).rejects.toThrow('The match was not ended: a game has begun since that press.');
    await expect(H.mh.endMatch({ everyone: false })).rejects.toThrow(/a game is being played/);
    await expect(A.mh.endMatch({ everyone: false, about: between })).rejects.toThrow(/a game has begun since that press/);
    // A member never ends a game for everyone; and a for-everyone press about another game than this one ends nothing.
    await expect(A.mh.endMatch({ everyone: true, about: during })).rejects.toThrow("During a game only the lobby's PC ends the match.");
    await expect(H.mh.endMatch({ everyone: true, about: `${hs.code}-1/1/game` })).rejects.toThrow('The match was not ended: the game that press was about is over.');
    // So is Give up this game: a question asked in one game is not answered in the next.
    await expect(A.mh.giveUp({ about: `${hs.code}-1/1/game` })).rejects.toThrow('Nothing was given up: the game that press was about is over.');
    await sleep(200);
    // Nothing of all that touched the game that is being played, or the player who is up.
    expect([H, A].map((x) => x.mh.status().phase)).toEqual(['playing', 'playing']);
    expect(up(A, 1)).toBe(true);
    expect(H.mh.status().lobby?.match).toMatchObject({ id: `${hs.code}-1`, game: 2, state: 'game' });
    expect([...H.lines, ...A.lines].filter((l) => l.includes('MATCH_END') || l.includes('Match ended') || l.includes('FORFEIT'))).toEqual([]);

    // The press that is about this game, on the lobby's PC, does end it for everyone.
    await H.mh.endMatch({ everyone: true, about: during });
    await until(() => [H, A].every((x) => x.mh.status().phase === 'lobby'));
    expect(H.mh.status().panel?.message).toMatch(/^Match ended · game 2 not finished/);
  }, 60_000);

  it("the review of PR 136: Start a new match is checked for the new match's players: a table among them that cannot report ball ends is said in its question and needs the answer, though the next game's players are all fine", async () => {
    const H = seat('h', { relay: () => null });
    const A = seat('a', { relay: () => null });
    // Dana's machine does not say when a ball ends.
    const D = seat('d', { relay: () => null }, rig({ ballEnds: false }));
    const hs = await H.mh.host({ port: 0, ballsPerGame: 1, displayName: 'Owner' });
    await A.mh.join(hs.invite!, 'Krobs');
    await until(() => names(H).length === 2);
    await H.mh.start();
    await until(() => up(H, 1));
    await D.mh.join(hs.invite!, 'Dana');
    await playGame([H, A], 1);
    await until(() => [H, A, D].every((x) => x.mh.status().phase === 'over'));
    // The next game is Owner's and Krobs': nothing to warn about there. The new match would have Dana in it.
    expect(H.mh.status().startWarnings).toEqual([]);
    const said = "Dana's table cannot report ball ends: it is not patched, an original table, or a machine whose ball ends cannot be read";
    expect(H.mh.status().lobby?.newMatch).toMatchObject({ line: 'Dana plays too. The match that is open ends at Krobs 1, Owner 0.', warnings: [said] });
    expect(D.mh.status().lobby?.newMatch?.warnings).toEqual(['Your table cannot report ball ends: this machine does not say when a ball ends']);
    // Without the answer it is refused, with that table named; nothing starts, and the open match is as it was.
    await expect(H.mh.start({ newMatch: true })).rejects.toThrow(new RegExp(`^${said.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\. Start anyway to play it by hand`));
    expect(H.mh.status().lobby?.start ?? null).toBeNull();
    expect(H.mh.status().lobby?.match).toMatchObject({ id: `${hs.code}-1`, state: 'between' });
    // With it (the tab's confirm row and the menu's second choose send both): the new match, Dana in it.
    await H.mh.start({ newMatch: true, anyway: true });
    await until(() => H.mh.status().lobby?.match?.id === `${hs.code}-2` && up(H, 1), 15_000);
    expect(H.mh.status().lobby?.match?.players).toEqual([H.id(), A.id(), D.id()]);
    await until(() => players(D).length === 3);
    expect(players(D)).toEqual(['Owner', 'Krobs', 'Dana']);
  }, 60_000);

  it("a lobby's PC that vanishes with no match open and never returns (through ArcAid): the members are told it is away and for how long they wait, keep their tables and their voices, ask ArcAid seldom, and when the wait is over the lobby is closed for them with the reason and nothing is kept", async () => {
    const r = await relay({ hostGraceMs: 100 });
    // A member's own grace is short here, and the wait six seconds (twenty minutes in the app).
    const wait = { hostWaitMs: 6000, disconnectGraceMs: 200, relayRejoin: { gapsMs: [300, 600, 1200] } };
    const H = seat('h', via(r, 'h'));
    const A = seat('a', { ...via(r, 'a'), ...wait });
    const B = seat('b', { ...via(r, 'b'), ...wait });
    const hs = await H.mh.host({ port: 0, ballsPerGame: 3, displayName: 'Owner' });
    await A.mh.join(hs.invite!, 'Krobs');
    B.mh.setStance('watch');
    await B.mh.join(hs.invite!, 'Chuck');
    await until(() => [H, A, B].every((x) => names(x).length === 3 && x.page.held().length === 2));
    const voice = [A, B].map((x) => x.page.voiceCalls().length);

    // The lobby's PC is gone for good as far as ArcAid can tell (its pairing is no longer accepted): the room closes.
    r.revoke('dev-h');
    r.dropDevice('dev-h');
    await until(() => r.rooms().length === 0);
    await until(() => [A, B].every((x) => x.mh.status().lobby?.hostAway != null));
    for (const x of [A, B]) {
      // Still in the lobby, as a member; the table is the owner's, and nothing was saved to come back to.
      expect(x.mh.status()).toMatchObject({ role: 'client', phase: 'lobby', locked: false });
      expect(x.mh.status().panel?.message).toMatch(/^Owner's PC is away\. The lobby goes on when it is back: waiting up to 1 minute \(1 min left\)\. You can keep talking; Leave lobby ends the wait for you\.$/);
      expect(x.mh.status().lobby?.startButton.off).toBe("The lobby's PC is away.");
      expect(member(x, 'Owner')?.flags).toContain('away');
      // A17 step 8: the record of the lobby is there for as long as this PC is in it.
      expect(existsSync(join(x.dir, RESUME_FILE))).toBe(true);
    }
    // Nothing can be started or cancelled meanwhile: it is said at once, not sent into a link that is down.
    await expect(A.mh.start()).rejects.toThrow("The lobby's PC is away: this has to wait until it is back.");
    await expect(A.mh.cancelStart()).rejects.toThrow("The lobby's PC is away: this has to wait until it is back.");
    // The row of the lobby's PC says since when.
    expect(member(A, 'Owner')?.awaySince).toBeGreaterThan(Date.now() - 10_000);
    // The two members go on hearing each other (and would hear the lobby's PC, were it only its ArcAid link): no
    // voice connection was closed for it.
    await sleep(1500);
    expect([A, B].map((x) => x.page.voiceCalls().length)).toEqual(voice);
    expect([A, B].map((x) => x.page.held().length)).toEqual([2, 2]);

    // The wait is over: closed for each, with the reason.
    await until(() => A.mh.status().role === 'none' && B.mh.status().role === 'none', 20_000);
    for (const x of [A, B]) {
      expect(x.mh.status().lastError).toBe("The lobby is closed: Owner's PC did not come back");
      expect(x.page.held()).toEqual([]);
      expect(existsSync(x.lock)).toBe(false);
      expect(existsSync(join(x.dir, RESUME_FILE))).toBe(false);
    }
    // ArcAid was asked for the room a handful of times by each in all that time, far under its limit.
    expect(r.misses.get('dev-a') ?? 0).toBeGreaterThanOrEqual(2);
    expect(r.misses.get('dev-a') ?? 0).toBeLessThanOrEqual(6);
    // A17 step 8: on the lobby's PC itself, whose pairing ArcAid no longer accepts: it asked for its room three
    // times, a few seconds apart, and then closed the lobby for itself, with what happened and where to pair again.
    // Its record is gone with it. (Until this step it went on asking for ever, and nothing ended.)
    await until(() => H.mh.status().role === 'none', 30_000);
    expect(H.mh.status().lastError).toBe(
      `The lobby ${hs.code} is closed on this PC: this PC is no longer paired with ArcAid, so the others cannot reach it. Pair it again in Settings (Pair with ArcAid), then open a new lobby and send the new code.`,
    );
    expect(existsSync(join(H.dir, RESUME_FILE))).toBe(false);
    expect(H.lines.filter((l) => l.includes('ArcAid did not accept this device'))).toHaveLength(3);
  }, 90_000);

  it("the review of PR 136: ArcAid's room is gone for good while somebody is connected to the lobby PC's own port: the lobby goes on for them (a game they play is not ended), the owner is told, and whoever came through ArcAid is away", async () => {
    const r = await relay({ hostGraceMs: 100 });
    const H = seat('h', { ...via(r, 'h'), disconnectGraceMs: 100, lobby: { countdownMs: 150, placeMs: 400, returnAllowMs: 0 } });
    const A = seat('a', { ...via(r, 'a'), hostWaitMs: 1500, relayRejoin: { gapsMs: [200, 400, 800] } });
    const B = seat('b', { relay: () => null });
    const hs = await H.mh.host({ port: 0, ballsPerGame: 3, displayName: 'Owner' });
    expect(hs.via).toBe('relay');
    await A.mh.join(hs.invite!, 'Krobs');
    A.mh.setStance('watch');
    // Chuck is on the same network and joins by the address invite.
    expect(hs.directInvite ?? H.mh.status().directInvite).toMatch(/^castcade:/);
    await B.mh.join((hs.directInvite ?? H.mh.status().directInvite)!, 'Chuck');
    await until(() => names(H).length === 3 && member(H, 'Krobs')?.stance === 'watch');
    await H.mh.start();
    await until(() => up(H, 1) && B.mh.status().phase === 'playing');
    H.r.gameStart();
    H.r.score(1, 250);
    const seen: string[] = [];
    const off = B.mh.onStatus((s) => void seen.push(s.phase));

    // The same device opens another room from another socket: ArcAid closes this one for good (`replaced`).
    const other = new RelayHostTransport({ localId: 'elsewhere', baseUrl: r.url, auth: { deviceId: 'dev-h', deviceToken: 'tok-h' } });
    await other.host('OTHERX');
    await until(() => (H.mh.status().lastError ?? '').startsWith('ArcAid closed the room of the lobby'));
    other.close();
    expect(H.mh.status().lastError).toBe(
      `ArcAid closed the room of the lobby ${hs.code} and it could not be opened again. The lobby goes on for Chuck, connected to this PC directly. Whoever came through ArcAid cannot come back, and the code no longer works: for a new code, close the lobby and open a new one.`,
    );
    expect(H.mh.status()).toMatchObject({ role: 'host', phase: 'playing', via: 'direct' });
    // The game goes on for the two who can reach each other: the ball ends, the turn passes to Chuck.
    H.r.ball(1, 300);
    await until(() => up(B, 1));
    off();
    expect(seen.filter((x) => x !== 'playing')).toEqual([]);
    // Krobs came through ArcAid: away on the lobby PC's roster, then the place goes; on his own PC the wait ends.
    await until(() => !names(H).includes('Krobs'), 15_000);
    await until(() => A.mh.status().role === 'none', 15_000);
    await until(() => names(B).length === 2);
    expect(names(B)).toEqual(['Owner', 'Chuck']);

    // With nobody on the lobby PC's own port there is nobody to keep it for: it is closed, and its owner is told why.
    const r2 = await relay();
    const H2 = seat('c', via(r2, 'c'));
    const A2 = seat('a', via(r2, 'a'));
    const hs2 = await H2.mh.host({ port: 0, ballsPerGame: 3, displayName: 'Owner' });
    await A2.mh.join(hs2.invite!, 'Krobs');
    await until(() => names(H2).length === 2);
    const other2 = new RelayHostTransport({ localId: 'elsewhere', baseUrl: r2.url, auth: { deviceId: 'dev-c', deviceToken: 'tok-c' } });
    await other2.host('OTHERY');
    await until(() => H2.mh.status().role === 'none');
    expect(H2.mh.status().lastError).toBe(`The lobby ${hs2.code} is closed: ArcAid closed its room and it could not be opened again. Open a new lobby and send the new code.`);
    await until(() => A2.mh.status().role === 'none', 15_000);
    other2.close();
  }, 90_000);

  it("the review of PR 136 (the owner's standing rule on the changed path): a waiting player's Castcade restarts for an update during another player's ball and comes back by a fresh join: on the PC of the player who is up nothing is paused, locked or muted, and no connection but the returning PC's own is closed or made", async () => {
    const H = seat('h', { relay: () => null, disconnectGraceMs: 100 });
    const A = seat('a', { relay: () => null, disconnectGraceMs: 100 });
    const C = seat('c', { relay: () => null, disconnectGraceMs: 100 });
    const hs = await H.mh.host({ port: 0, ballsPerGame: 3, displayName: 'Owner' });
    await A.mh.join(hs.invite!, 'Krobs');
    await C.mh.join(hs.invite!, 'Chuck');
    await until(() => [H, A, C].every((x) => names(x).length === 3 && x.page.held().length === 2));
    // Krobs starts and is up on ball 1: the lobby's PC and Chuck wait.
    await A.mh.start();
    await until(() => up(A, 1) && C.mh.status().phase === 'playing' && H.mh.status().phase === 'playing');
    A.r.gameStart();
    A.r.score(1, 300);
    await until(() => C.mh.status().panel?.players.find((x) => x.name === 'Krobs')?.score === 300);
    const cid = C.id();
    // From here on, everything the PC of the player who is up is told.
    const seen: string[] = [];
    const off = A.mh.onStatus((s) => void seen.push(`${s.phase}/${s.locked}/${s.panel?.myTurn === true}`));
    const base = { sound: A.sound.count(), page: A.page.log.length, video: A.video.sent.length };

    // Chuck's Castcade restarts itself (an update): the match is not left, and a record is kept.
    await C.mh.stop({ keepForRestart: true });
    expect(existsSync(join(C.dir, RESUME_FILE))).toBe(true);
    await until(() => member(A, 'Chuck')?.flags.includes('away') === true && member(H, 'Chuck')?.flags.includes('away') === true);
    // The ball goes on meanwhile.
    A.r.score(1, 450);
    await until(() => H.mh.status().panel?.players.find((x) => x.name === 'Krobs')?.score === 450);
    // The same PC, Castcade started again: it goes back by itself (a fresh engine, its own signed HELLO, the whole log).
    const C2 = seat('c', { relay: () => null, disconnectGraceMs: 100 }, C.r, C.dir);
    expect(C2.mh.status().resume).toMatchObject({ role: 'client', auto: true });
    await C2.mh.rejoin();
    await until(() => C2.mh.status().phase === 'playing' && member(A, 'Chuck')?.flags.includes('away') === false && member(H, 'Chuck')?.flags.includes('away') === false);
    expect(C2.id()).toBe(cid);
    expect(players(C2)).toEqual(['Krobs', 'Owner', 'Chuck']);
    // (The score of the ball in play is not in the log: the PC that came back shows it from that player's next STATE.)
    expect(C2.mh.status().locked).toBe(true);
    await until(() => C2.page.held().length === 2);
    A.r.score(1, 600);
    await until(() => C2.mh.status().panel?.players.find((x) => x.name === 'Krobs')?.score === 600);
    off();

    // The player who is up, through all of it: playing, unlocked, their turn. Never paused, never locked.
    expect([...new Set(seen)]).toEqual(['playing/false/true']);
    expect(A.lines.filter((l) => /PAUSE|paused/i.test(l))).toEqual([]);
    // Their table sound was not touched: their own VPX is tapped and never muted.
    expect(A.sound.last()).toEqual({ mutePid: null, tapPid: 4242 });
    expect(A.sound.since(base.sound).filter((w) => w.mutePid !== null || w.tapPid !== 4242)).toEqual([]);
    // Their page: nothing but the voice connection to the PC that restarted (its process was gone) was closed or
    // made, and they never stopped sending.
    const pageSince = A.page.log.slice(base.page);
    expect(pageSince.filter((l) => !l.includes(cid))).toEqual([]);
    expect(pageSince.filter((l) => l.startsWith('sending') || l.startsWith('table send') || l === 'detach' || l === 'attach')).toEqual([]);
    // Their video helper: the same; the connection to the lobby's PC was neither closed nor made again.
    const videoSince = A.video.sent.slice(base.video).filter((c) => c.cmd === 'peer' || c.cmd === 'close' || c.cmd === 'unpeer');
    expect(videoSince.filter((c) => String(c.id) !== cid)).toEqual([]);
    // The ball ends as any ball: the turn goes on to the lobby's PC, then to the PC that came back.
    A.r.ball(1, 700);
    await until(() => up(H, 1));
    H.r.gameStart();
    H.r.ball(1, 100);
    await until(() => up(C2, 1));
  }, 60_000);
});

describe('A17 step 10: the table changes in a lobby', () => {
  const AFM = 'Attack from Mars';
  const AFM_SHA = 'cd'.repeat(32);
  const OBJECTS = { editables: 1203, hash: '00aa11bb22cc33dd' };
  /** A pick as a PC makes it from its table list: the identity keys, nothing of a copy. */
  const pickOf = (tableName: string, tableHash: string, romName: string | null = null) => ({ kind: 'vpx' as const, tableName, tableHash, romName, romHash: null, physicsHash: null, recipeVersion: null, sidecarHash: null, emulatorVersion: '' });
  const flags = (s: Seat, who: string): string[] => member(s, who)?.flags ?? [];
  const two = async (ballsPerGame: 3 | 5 = 3) => {
    const H = seat('h');
    const A = seat('a');
    const hs = await H.mh.host({ port: 0, ballsPerGame, displayName: 'Owner' });
    await A.mh.join(hs.invite!, 'Krobs');
    await until(() => names(H).length === 2 && names(A).length === 2 && H.page.held().length === 1 && A.page.held().length === 1);
    return { H, A };
  };

  it("anyone picks the lobby's table: every PC hears the pick and who made it, each row is compared with it, the header says CHANGING TABLE while PCs are on their way, and a match on the new table starts with the voice peers untouched", async () => {
    const { H, A } = await two(3);
    const voiceBefore = [H, A].map((s) => s.page.voiceCalls().length);
    const videoBefore = [H, A].map((s) => s.video.peers().length);
    expect(H.mh.status().lobby?.table).toEqual({ name: 'Test Table', pickedBy: H.id(), pickedByName: 'Owner', off: null, endsMatch: false, changing: false });

    // The member picks, with what the Castcade VPX build says of its copy.
    await A.mh.pickTable({ game: pickOf(AFM, AFM_SHA, 'afm_113b'), objects: OBJECTS });
    await until(() => H.mh.status().lobby?.table.name === AFM && A.mh.status().lobby?.table.name === AFM);
    for (const s of [H, A]) {
      expect(s.mh.status().lobby?.table).toMatchObject({ name: AFM, pickedBy: A.id(), pickedByName: 'Krobs', off: null });
      expect(s.mh.lobbyTable()?.game).toEqual(pickOf(AFM, AFM_SHA, 'afm_113b'));
      // The 3D ranking of every PC's copies follows the picked table, on the lobby's PC too.
      expect(s.mh.hostTableObjects()).toEqual(OBJECTS);
      // Both still have the old table open: another game than the lobby's.
      expect([flags(s, 'Owner'), flags(s, 'Krobs')]).toEqual([['other_table'], ['other_table']]);
    }
    // The lobby PC's own table (still the old one) is its row's business: it is not the lobby's table any more.
    expect(H.mh.ownTable()?.tableName).toBe('Test Table');

    // Each PC says where it stands on its way (the shell's one-step does; here the test is it).
    A.mh.setTableChange('closing', null);
    H.mh.setTableChange('waits_person', `Close the table on this PC: Castcade opens ${AFM} when it is closed.`);
    await until(() => flags(H, 'Krobs').includes('changing') && flags(A, 'Owner').includes('close_table'));
    for (const s of [H, A]) {
      expect(s.mh.status().lobby?.table.changing).toBe(true);
      expect(headerText(s.mh.status().panel!)).toBe('CHANGING TABLE · ATTACK FROM MARS');
    }
    // The person who has to act reads it on their own panel (the headset), not only on the Match tab.
    expect(H.mh.status().panel?.message).toBe(`Close the table on this PC: Castcade opens ${AFM} when it is closed.`);
    // A start asked for meanwhile waits for the tables, and says for whose.
    await A.mh.start();
    await until(() => H.mh.status().lobby?.start?.waitsFor === 'other_tables');
    expect(H.mh.status().lobby?.start?.waitsOn.sort()).toEqual([H.id(), A.id()].sort());
    await A.mh.cancelStart();
    await until(() => H.mh.status().lobby?.start === null);

    // Both tables are closed and the new one opened; each PC has nothing more to say.
    A.r.setTable(AFM, AFM_SHA);
    A.mh.setTableChange('opening', null);
    A.mh.setTableChange(null, null);
    H.r.setTable(AFM, AFM_SHA);
    H.mh.setTableChange(null, null);
    await until(() => [flags(H, 'Owner'), flags(H, 'Krobs'), flags(A, 'Owner'), flags(A, 'Krobs')].every((f) => f.length === 0));
    for (const s of [H, A]) {
      expect(s.mh.status().lobby?.table.changing).toBe(false);
      expect(headerText(s.mh.status().panel!)).not.toMatch(/CHANGING TABLE/);
      expect(s.mh.status().participants.map((x) => x.tableNote)).toEqual([null, null]);
    }

    // A match on the new table, asked for by the member: played to its end.
    await A.mh.start();
    await until(() => A.mh.status().phase === 'playing' && H.mh.status().phase === 'playing', 15_000);
    expect(A.mh.hostGame()?.tableName).toBe(AFM);
    await playGame([A, H], 3);
    await until(() => H.mh.status().phase === 'over' && A.mh.status().phase === 'over');
    // Not one voice peer was added or removed for the change of table or for the match after it, and the video
    // helper holds the peers it held.
    expect([H, A].map((s) => s.page.voiceCalls().length)).toEqual(voiceBefore);
    expect([H, A].map((s) => s.video.peers().length)).toEqual(videoBefore);
    expect([H, A].map((s) => s.page.log.filter((l) => l === 'detach').length)).toEqual([0, 0]);
  }, 60_000);

  it('a pick is refused with a sentence while a start counts down and while a game is played; between games it ends the open match, after the press said so; and the table cannot change again at once', async () => {
    const H = seat('h', { lobby: { countdownMs: 600 } });
    const A = seat('a');
    const hs = await H.mh.host({ port: 0, ballsPerGame: 3, displayName: 'Owner' });
    await A.mh.join(hs.invite!, 'Krobs');
    await until(() => names(H).length === 2 && names(A).length === 2);
    const afm = { game: pickOf(AFM, AFM_SHA), objects: null };
    // While a start counts down: on the PC that asked, and on the other.
    await H.mh.start();
    await until(() => A.mh.status().lobby?.start !== null && A.mh.status().lobby?.start !== undefined);
    expect(A.mh.status().lobby?.table.off).toBe('A match is starting: cancel the start to change the table.');
    await expect(A.mh.pickTable(afm)).rejects.toThrow('A match is starting: cancel the start to change the table.');
    await expect(H.mh.pickTable(afm)).rejects.toThrow('A match is starting: cancel the start to change the table.');
    // While a game is played.
    await until(() => H.mh.status().phase === 'playing' && A.mh.status().phase === 'playing', 15_000);
    await expect(A.mh.pickTable(afm)).rejects.toThrow('A game is being played: the table changes after it.');
    await expect(H.mh.pickTable(afm)).rejects.toThrow('A game is being played: the table changes after it.');
    expect(H.mh.status().lobby?.table.name).toBe('Test Table');
    await playGame([H, A], 3);
    await until(() => H.mh.status().phase === 'over' && A.mh.status().phase === 'over' && A.mh.status().lobby?.match?.state === 'between');
    // Between games: a pick ends the open match, and the tab asked first (`endsMatch`).
    expect(A.mh.status().lobby?.table).toMatchObject({ off: null, endsMatch: true });
    const about = A.mh.status().lobby!.gameKey;
    // A press about a lobby that has moved on changes nothing.
    await expect(A.mh.pickTable({ ...afm, about: 'ZZZZZZ-9/1/between' })).rejects.toThrow(/The table was not changed: the lobby is not as it was when you pressed/);
    expect(A.mh.status().lobby?.match).not.toBeNull();
    await A.mh.pickTable({ ...afm, about });
    await until(() => H.mh.status().lobby?.match === null && A.mh.status().lobby?.match === null);
    expect(H.mh.status().lobby?.table).toMatchObject({ name: AFM, pickedByName: 'Krobs', endsMatch: false });
    expect(H.lines.some((l) => /the table changed/.test(l))).toBe(true);
    // Everyone is still in the lobby, and nobody's voice was touched.
    expect([names(H), names(A)]).toEqual([
      ['Owner', 'Krobs'],
      ['Owner', 'Krobs'],
    ]);
    // Limits on how often the lobby's table can change: the same member again at once is told so (a client hears
    // it from the lobby's PC a moment later; the lobby's PC itself at once).
    await A.mh.pickTable({ game: pickOf('Medieval Madness', 'ef'.repeat(32)), objects: null });
    await until(() => /You changed the lobby's table a moment ago: you can change it again in \d+ s\./.test(A.mh.status().lastError ?? '') || /You changed the lobby's table a moment ago/.test(A.mh.status().panel?.message ?? ''));
    await expect(H.mh.pickTable({ game: pickOf('Medieval Madness', 'ef'.repeat(32)), objects: null })).rejects.toThrow(/The lobby's table was changed a moment ago: it can be changed again in \d+ s\./);
    expect(H.mh.status().lobby?.table.name).toBe(AFM);
  }, 60_000);

  it("a pick before the picker's table is open flags nobody: the member who has that file open is not said to have another, and the picker's own row is the loading one", async () => {
    // The lobby's PC has no VPX open; the member has Test Table open.
    const H = seat('h', {}, rig({ table: false }));
    const A = seat('a');
    const hs = await H.mh.host({ port: 0, ballsPerGame: 3, displayName: 'Owner' });
    await A.mh.join(hs.invite!, 'Krobs');
    await until(() => names(H).length === 2 && names(A).length === 2);
    expect(H.mh.status().lobby?.table.name).toBeNull();
    // The lobby's PC picks that table from its own list, with the ROM its import read (a PC's own row names none).
    await H.mh.pickTable({ game: pickOf('Test Table', SHA, 'tt_10'), objects: OBJECTS });
    await until(() => A.mh.status().lobby?.table.name === 'Test Table');
    await sleep(100);
    for (const s of [H, A]) {
      expect(s.mh.status().lobby?.table).toMatchObject({ name: 'Test Table', pickedByName: 'Owner' });
      expect(flags(s, 'Krobs')).toEqual([]);
      expect(flags(s, 'Owner')).toEqual(['loading']);
      const krobs = s.mh.status().participants.find((x) => x.name === 'Krobs');
      expect([krobs?.tableMatch, krobs?.tableNote]).toEqual([true, null]);
      expect(s.mh.hostTableObjects()).toEqual(OBJECTS);
    }
    // The lobby's PC opens it: nobody is flagged, and nobody was.
    H.r.openTable();
    await until(() => flags(A, 'Owner').length === 0);
    expect(A.mh.status().participants.map((x) => x.tableNote)).toEqual([null, null]);
    expect(H.mh.ownTable()?.tableName).toBe('Test Table');
  }, 60_000);
});
