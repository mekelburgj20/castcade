/**
 * I11.4.2 (2026-11-19, ADR 0011, docs/design/state-stream-in-match.md §3 and §4): the state stream inside a match, as
 * this PC decides it. In a match, a player who waits sees the player who is up on their own VPX table, in 3D, when
 * both PCs run the Castcade VPX build on the identical table file; otherwise the 2D video, as before.
 *
 * Pure: no sockets, no Electron, no timers of its own. `main/stream3d-host.ts` owns the loopback control server the
 * fork connects to and the tunnel end (`watch/tunnel-end.ts`), and drives this machine; the tests drive it with a
 * scripted fork.
 *
 * The control connection (§3, a contract with the fork). UTF-8 lines ending in `\n`:
 *
 *   fork → companion   `hello 1 <build> <editables> <table-hash>`   once per connection
 *   fork → companion   `state playing`                              its own table is shown and live (first after hello)
 *   fork → companion   `state watching`                             the other player's first frame is on screen
 *   fork → companion   `state failed <reason>`                      a `watch` did not work; `state playing` follows
 *   companion → fork   `watch 127.0.0.1:<port>`                     watch the stream there; again: re-aim
 *   companion → fork   `play`                                       back to the own table
 *
 * How the lines are read here (`parseControlLine`): exactly these words, fields separated by one space, nothing
 * before `hello` counts. The three fields of `hello` are opaque tokens; the table identity is `<editables> <hash>`,
 * compared as text. A `hello` whose version is not 1 makes this PC one without 3D (logged), whatever follows. Nothing
 * is commanded before the first `state playing` after `hello`.
 *
 * What this machine expects of the fork beyond the table of §3 (said here because the other side is built from the
 * same page): EVERY `watch` is answered by `state watching` or `state failed`, a re-aim included, within
 * `WATCH_TIMEOUT_MS`; a `play` sent while the fork is not on its own table is answered by `state playing`.
 *
 * The lines carry no numbers, so the machine keeps what is outstanding unambiguous by what it sends when:
 *   - `play` goes out at once, whatever is outstanding (a player's own turn never waits). From then until
 *     `state playing` (or `PLAY_WAIT_MS`, after which the fork is taken to be on its own table: it may not answer a
 *     `play` it had no use for) no `watch` is sent, and a `state watching` / `state failed` that arrives is the
 *     answer to something that `play` already cancelled: ignored.
 *   - a `watch` while an earlier `watch` stands is the re-aim of §3 and goes out at once; an answer belongs to the
 *     latest one.
 *   - `state playing` with no `play` outstanding while a watch stands: the fork left the watch by itself (2D this turn).
 *   - `state watching` when nothing is to be watched (a `watch` that crossed a failure): `play` is sent again. A
 *     player is never left on another's table by a line that crossed.
 *
 * The turn (§4.3). The shell says who this PC should be watching (`setTarget`): the player up while this PC waits with
 * its table locked, else nobody (it is up, or holds its table: the lobby, between games, a pause, the initials hold,
 * the window in which a finished game ends on the machine).
 *
 *   target        3D possible   fork            tunnel                         headset
 *   nobody        -             `play`          the own port for the others    own table, as before
 *   a player      yes           `watch` (aim)   the listener aimed at them     no theater picture (`showing3d`)
 *   a player      no            `play`          -                              theater with the 2D video, as before
 *
 * The tunnel is given this PC's stream port for as long as the fork is on the control connection, in all three rows
 * and not only the first: the others aim at this PC the moment its turn begins, and one of them may connect a moment
 * before this PC has handled its own grant; refused, its fork would report a failed watch and show 2D for the turn.
 *
 * "Possible" (§4.2, `decide`): the setting is `auto`, this PC's VPX is on the control connection, the other PC said
 * (over the tunnel's own channel, `encodeCaps`) that its VPX is too, and both name the same table identity. A watch
 * that fails (`state failed`, no `state watching` in time, the fork back on its own table unasked, the control
 * connection lost) is 2D until the target changes: the next turn tries again.
 *
 * The turn lock (§4.3, `whenPlaying`): at the grant the shell lifts the lock only once the fork says `state playing`,
 * `PLAY_WAIT_MS` at most, then anyway (logged). A PC whose fork is on its own table, or that has none, never waits.
 *
 * Every decision and state change is one log line starting `stream3d:`.
 */

export const CONTROL_VERSION = 1;
/** A `watch` not answered by `state watching` within this falls back to the 2D video (§4.3). */
export const WATCH_TIMEOUT_MS = 5_000;
/** At the grant the lock waits this long at most for `state playing` (§4.3). */
export const PLAY_WAIT_MS = 2_000;
/** A control line is at most this long (characters, the newline apart). */
export const CONTROL_LINE_MAX = 512;
const TOKEN = /^[\x21-\x7e]{1,128}$/;
// eslint-disable-next-line no-control-regex -- control characters are exactly what a line must not hold
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

export type Watch3dSetting = 'auto' | 'off';

export type ControlLine =
  | { kind: 'hello'; version: number; build: string; editables: string; tableHash: string }
  | { kind: 'state'; state: 'playing' | 'watching' }
  | { kind: 'failed'; reason: string };

/**
 * One line from the fork (without its `\n`; one `\r` before it is let go), or null for anything that is not one of
 * the four. A `hello` of another version is returned with empty fields: only its version is read.
 */
export function parseControlLine(raw: string): ControlLine | null {
  const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
  if (line.length === 0 || line.length > CONTROL_LINE_MAX || CONTROL_CHARS.test(line)) return null;
  if (line === 'state playing') return { kind: 'state', state: 'playing' };
  if (line === 'state watching') return { kind: 'state', state: 'watching' };
  if (line === 'state failed') return { kind: 'failed', reason: '' };
  if (line.startsWith('state failed ')) return { kind: 'failed', reason: line.slice('state failed '.length).trim().slice(0, 200) };
  const parts = line.split(' ');
  if (parts[0] !== 'hello' || parts.length < 2 || !/^\d{1,6}$/.test(parts[1] as string)) return null;
  const version = Number(parts[1]);
  if (version !== CONTROL_VERSION) return { kind: 'hello', version, build: '', editables: '', tableHash: '' };
  if (parts.length !== 5) return null;
  const [, , build, editables, tableHash] = parts as [string, string, string, string, string];
  if (!TOKEN.test(build) || !TOKEN.test(editables) || !TOKEN.test(tableHash)) return null;
  return { kind: 'hello', version, build, editables, tableHash };
}

/** `watch 127.0.0.1:<port>`: the fork connects to the tunnel's listener on this PC. */
export function watchCommand(port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`not a port: ${port}`);
  return `watch 127.0.0.1:${port}`;
}
export const PLAY_COMMAND = 'play';

// ------------------------------------------------------------------------------ what a PC says --

/** A PC's VPX as the control connection's `hello` gave it. */
export interface ForkInfo {
  build: string;
  /** The table identity the stream's own HELLO checks: `<editables> <table-hash>`. */
  table: string;
}

const CAPS_VERSION = 1;

/** What this PC tells the others over the tunnel's own channel: its fork, or that it has none. */
export function encodeCaps(fork: ForkInfo | null): string {
  return JSON.stringify({ v: CAPS_VERSION, fork: fork ? { build: fork.build, table: fork.table } : null });
}

/** What a peer said: its fork, `none`, or null for anything else (then nothing is known of it). */
export function decodeCaps(text: string | null): ForkInfo | 'none' | null {
  if (text === null || text.length > 1024) return null;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null || (v as { v?: unknown }).v !== CAPS_VERSION) return null;
  const fork = (v as { fork?: unknown }).fork;
  if (fork === null) return 'none';
  if (typeof fork !== 'object' || fork === undefined) return null;
  const { build, table } = fork as { build?: unknown; table?: unknown };
  if (typeof build !== 'string' || typeof table !== 'string' || build.length === 0 || build.length > 128 || table.length === 0 || table.length > 300) return null;
  return { build, table };
}

// ----------------------------------------------------------------------------------- the view --

/** Why this PC shows a player in 2D. */
export type Why2d =
  /** The setting is off on this PC. */
  | 'off'
  /** No Castcade VPX build runs the table on this PC (none beside VPX, a table opened by hand, an older build). */
  | 'no_fork_here'
  /** This PC's fork speaks another version of the control connection. */
  | 'fork_version'
  /** The other PC said its VPX is not the Castcade build. */
  | 'no_fork_there'
  /** Nothing heard from the other PC yet (the data connection to it is not up). */
  | 'not_connected'
  /** Both run the build, on different table files. */
  | 'other_table'
  /** A watch of this player did not work this turn. */
  | 'failed';

export type View3d = { mode: '3d' } | { mode: '2d'; why: Why2d; detail?: string };

export interface DecideInput {
  setting: Watch3dSetting;
  /** This PC's fork: on the control connection with `hello 1` (and its first `state playing`), another version, or none. */
  own: ForkInfo | 'version' | null;
  /** What the other PC said: its fork, `none`, or null (nothing yet). */
  peer: ForkInfo | 'none' | null;
}

/** §4.2: 3D or 2D for one other player, and why. Pure. */
export function decide(i: DecideInput): View3d {
  if (i.setting !== 'auto') return { mode: '2d', why: 'off' };
  if (i.own === null) return { mode: '2d', why: 'no_fork_here' };
  if (i.own === 'version') return { mode: '2d', why: 'fork_version' };
  if (i.peer === null) return { mode: '2d', why: 'not_connected' };
  if (i.peer === 'none') return { mode: '2d', why: 'no_fork_there' };
  if (i.peer.table !== i.own.table) return { mode: '2d', why: 'other_table' };
  return { mode: '3d' };
}

/** The Match tab's words for what this PC shows of one other player (after their name and a colon). */
export function viewWords(v: View3d): string {
  if (v.mode === '3d') return '3D, on your own table';
  switch (v.why) {
    case 'off':
      return 'the 2D video (3D watch is turned off on this PC)';
    case 'no_fork_here':
      return 'the 2D video (no Castcade VPX build runs the table on this PC)';
    case 'fork_version':
      return 'the 2D video (the Castcade VPX build on this PC and this Castcade are different versions: update both)';
    case 'no_fork_there':
      return 'the 2D video (no Castcade VPX build runs the table on their PC)';
    case 'not_connected':
      return 'the 2D video (the 3D connection to their PC is not up yet)';
    case 'other_table':
      return 'the 2D video (theirs is another table file)';
    case 'failed':
      return `the 2D video this turn (3D did not start${v.detail ? `: ${v.detail}` : ''})`;
  }
}

// -------------------------------------------------------------------------------- the machine --

export interface Stream3dDeps {
  /** Without the `stream3d: ` prefix: the machine adds it. */
  log(line: string): void;
  /** One line to the fork (no newline). False: there is no control connection. */
  send(line: string): boolean;
  /** The tunnel's loopback listener, aimed at `peer`'s table: the port this PC's fork connects to. */
  aim(peer: string): Promise<number>;
  /** The port this PC's fork streams on while the others may watch it (null: they may not). */
  setPlayerPort(port: number | null): void;
  /** What the other PCs are told about this one (`encodeCaps`). */
  setCaps(caps: string): void;
  /** Something `status()` shows changed. */
  onChange(): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** A player's name for the log; default: the id. */
  name?(peer: string): string;
  watchTimeoutMs?: number;
  playWaitMs?: number;
}

export interface Stream3dStatus {
  setting: Watch3dSetting;
  /**
   * This PC's VPX on the control connection: `none`; `connecting` (connected, no `hello` and first `state playing`
   * yet); `version` (a `hello` of another version); `ready`.
   */
  fork: 'none' | 'connecting' | 'version' | 'ready';
  build: string | null;
  table: string | null;
  /** What the fork shows, as far as this PC knows: null without a ready fork. */
  state: 'playing' | 'entering' | 'watching' | 'leaving' | null;
  /** The player this PC should be watching now (the shell's `setTarget`). */
  target: string | null;
  /** The fork is aimed at the target (asked, or confirmed): the headset shows no theater picture. */
  showing3d: boolean;
  /** Per other player: what this PC shows of them when they are up. */
  peers: Record<string, View3d>;
}

type ForkState = 'playing' | 'entering' | 'watching' | 'leaving';
interface Waiter {
  cb: (late: boolean) => void;
  timer: unknown;
}

export class Stream3d {
  private setting: Watch3dSetting = 'auto';
  private link: 'none' | 'connecting' | 'helloed' | 'version' | 'ready' = 'none';
  private own: ForkInfo | null = null;
  private forkState: ForkState = 'playing';
  /** The player the fork was last asked to watch; null after `play` (and before any `watch`). */
  private aimed: string | null = null;
  /** A `play` (or a `state failed`) whose `state playing` has not come yet: no `watch` goes out meanwhile. */
  private playOut = false;
  private playTimer: unknown = null;
  private target: string | null = null;
  /** The watch of the target failed this turn: 2D until the target changes. */
  private failed: { peer: string; detail: string; lostLink: boolean } | null = null;
  private streamPort: number | null = null;
  private readonly caps = new Map<string, ForkInfo | 'none'>();
  private peers: string[] = [];
  private seq = 0;
  private watchTimer: unknown = null;
  private readonly waiters = new Set<Waiter>();
  private toldCaps: string | null = null;
  private toldPort: number | null | undefined = undefined;
  private saidBlind = false;
  private readonly logged = new Map<string, string>();
  private readonly watchTimeoutMs: number;
  private readonly playWaitMs: number;

  constructor(private readonly d: Stream3dDeps) {
    this.watchTimeoutMs = d.watchTimeoutMs ?? WATCH_TIMEOUT_MS;
    this.playWaitMs = d.playWaitMs ?? PLAY_WAIT_MS;
  }

  // ---- the shell ----

  setSetting(s: Watch3dSetting): void {
    if (s === this.setting) return;
    this.setting = s;
    this.log(`the setting is ${s === 'auto' ? 'auto: 3D whenever both PCs can' : 'off: this PC shows the 2D video'}`);
    this.sync();
  }

  /** The port the fork Castcade started on this PC listens on (its `CASTCADE_STREAM_ADDR`), null when it is gone. */
  setStreamPort(port: number | null): void {
    if (port === this.streamPort) return;
    this.streamPort = port;
    this.publish();
  }

  /** The other players of the match; one who left is forgotten. */
  setPeers(ids: readonly string[]): void {
    const next = [...new Set(ids)];
    if (next.length === this.peers.length && next.every((id, i) => id === this.peers[i])) return;
    this.peers = next;
    for (const id of [...this.caps.keys()]) if (!next.includes(id)) this.caps.delete(id);
    for (const id of [...this.logged.keys()]) if (!next.includes(id)) this.logged.delete(id);
    this.sync();
  }

  /** What `peer`'s PC said over the tunnel (`encodeCaps`), or null: its channel closed. */
  peerCaps(peer: string, text: string | null): void {
    const c = decodeCaps(text);
    const was = this.caps.get(peer) ?? null;
    if (c === null) {
      if (text !== null) this.log(`${this.name(peer)}'s PC said something about its VPX this Castcade cannot read; taken as nothing said`);
      if (was === null) return;
      this.caps.delete(peer);
    } else {
      if (JSON.stringify(c) === JSON.stringify(was)) return;
      this.caps.set(peer, c);
      this.log(c === 'none' ? `${this.name(peer)}'s PC: no Castcade VPX build runs the table there` : `${this.name(peer)}'s PC: Castcade VPX build ${c.build}, table ${c.table}`);
    }
    this.sync();
  }

  /** §4.3: the player this PC should be watching (the one up, while this PC waits with its table locked), or null. */
  setTarget(peer: string | null): void {
    if (peer === this.target) return;
    this.target = peer;
    this.failed = null;
    this.sync();
  }

  /**
   * The match is over on this PC (or none began): nobody to watch, nothing known of anyone, the fork back on its own
   * table. The fork's own connection stays as it is (the table may stay open for the next match).
   */
  reset(): void {
    this.target = null;
    this.failed = null;
    this.peers = [];
    this.caps.clear();
    this.logged.clear();
    this.toldCaps = null;
    this.toldPort = undefined;
    this.sync();
    for (const w of [...this.waiters]) this.settle(w, false);
  }

  /** The fork is, or is being sent, away from its own table: the turn lock waits for it (`whenPlaying`). */
  away(): boolean {
    return this.link === 'ready' && this.forkState !== 'playing';
  }

  /**
   * §4.3: `cb` once the fork is back on its own table (`state playing`), at once when it is not away, and after
   * `PLAY_WAIT_MS` whatever it says (`late` true, logged). Returns a cancel.
   */
  whenPlaying(cb: (late: boolean) => void): () => void {
    if (!this.away()) {
      cb(false);
      return () => undefined;
    }
    const w: Waiter = { cb, timer: null };
    w.timer = this.d.setTimeout(() => {
      if (!this.waiters.has(w)) return;
      this.log(`VPX has not said "state playing" ${this.playWaitMs / 1000} s after the turn came to this PC; the table is unlocked anyway`);
      this.settle(w, true);
    }, this.playWaitMs);
    this.waiters.add(w);
    return () => {
      if (!this.waiters.delete(w)) return;
      this.d.clearTimeout(w.timer);
    };
  }

  // ---- the control connection ----

  forkConnected(): void {
    this.dropLink(null);
    this.link = 'connecting';
    this.log('the Castcade VPX build connected to the control port');
    this.changed();
  }

  forkLine(raw: string): void {
    if (this.link === 'none') return;
    const l = parseControlLine(raw);
    if (!l) {
      this.log(`a control line this Castcade does not know was ignored (${raw.length} characters: ${JSON.stringify(raw.slice(0, 60))})`);
      return;
    }
    if (l.kind === 'hello') return this.onHello(l);
    if (this.link === 'version') return;
    if (this.link === 'connecting') {
      this.log(`VPX said "${raw.slice(0, 40)}" before its hello; ignored`);
      return;
    }
    if (l.kind === 'failed') return this.onFailed(l.reason);
    if (l.state === 'watching') return this.onWatching();
    return this.onPlaying();
  }

  forkDisconnected(why: string): void {
    if (this.link === 'none') return;
    this.dropLink(why);
    this.sync();
  }

  status(): Stream3dStatus {
    const peers: Stream3dStatus['peers'] = {};
    for (const id of this.peers) peers[id] = this.viewOf(id);
    return {
      setting: this.setting,
      fork: this.link === 'helloed' ? 'connecting' : this.link,
      build: this.own?.build ?? null,
      table: this.own?.table ?? null,
      state: this.link === 'ready' ? this.forkState : null,
      target: this.target,
      showing3d: this.showing3d(),
      peers,
    };
  }

  /** §4.3 row 2: the fork is aimed at the player this PC should be watching: no theater picture. */
  showing3d(): boolean {
    return this.link === 'ready' && this.target !== null && this.aimed === this.target && (this.forkState === 'entering' || this.forkState === 'watching');
  }

  // ---- inside ----

  private name(peer: string): string {
    return this.d.name?.(peer) ?? peer;
  }

  private log(line: string): void {
    this.d.log(`stream3d: ${line}`);
  }

  private changed(): void {
    this.d.onChange();
  }

  private ownFor(): DecideInput['own'] {
    return this.link === 'ready' && this.own ? this.own : this.link === 'version' ? 'version' : null;
  }

  private viewOf(peer: string): View3d {
    const v = decide({ setting: this.setting, own: this.ownFor(), peer: this.caps.get(peer) ?? null });
    // A watch that failed this turn stays 2D until the target changes. After a lost control connection that holds
    // even once the fork is back (it does not take the turn over again), and the line says what happened.
    if (this.failed?.peer === peer && this.target === peer && (v.mode === '3d' || (this.failed.lostLink && v.why === 'no_fork_here'))) return { mode: '2d', why: 'failed', detail: this.failed.detail };
    return v;
  }

  private onHello(l: Extract<ControlLine, { kind: 'hello' }>): void {
    if (this.link !== 'connecting') {
      this.log('VPX said hello twice on one connection; the second is ignored');
      return;
    }
    if (l.version !== CONTROL_VERSION) {
      this.link = 'version';
      this.log(`VPX speaks version ${l.version} of the control connection and this Castcade version ${CONTROL_VERSION}: no 3D on this PC until both are updated; the 2D video serves`);
      this.sync();
      return;
    }
    this.own = { build: l.build, table: `${l.editables} ${l.tableHash}` };
    this.link = 'helloed';
    this.log(`VPX said hello: build ${l.build}, table ${this.own.table}`);
    this.changed();
  }

  private onPlaying(): void {
    if (this.link === 'helloed') {
      // The first line after hello: the fork is on its own table and takes commands from here on.
      this.link = 'ready';
      this.forkState = 'playing';
      this.aimed = null;
      this.log('VPX: state playing (its own table); it can be watched and can watch');
      this.sync();
      return;
    }
    if (this.playOut) {
      // The answer to a `play` (or what follows `state failed`).
      this.clearPlayOut();
      this.forkState = 'playing';
      this.log('VPX: state playing (back on its own table)');
      this.released();
      // A watch that waited for this answer goes out now.
      this.sync();
      return;
    }
    if (this.aimed !== null) {
      // Unasked: the fork left the watch by itself (the stream closed, or was refused without a `state failed`).
      const peer = this.aimed;
      this.clearWatchTimer();
      this.seq += 1;
      this.aimed = null;
      this.forkState = 'playing';
      this.released();
      this.fail(peer, 'VPX went back to its own table');
      return;
    }
    if (this.forkState !== 'playing') {
      this.forkState = 'playing';
      this.log('VPX: state playing (back on its own table)');
    }
    this.released();
  }

  private onWatching(): void {
    if (this.link !== 'ready') return;
    if (this.playOut) {
      // It answers a `watch` the outstanding `play` cancelled: the `state playing` of that `play` follows.
      this.log('VPX: state watching, after it was called back; waiting for its state playing');
      return;
    }
    if (this.aimed === null) {
      // A `watch` that crossed a failure took hold after all, and nothing is to be watched: back to the own table.
      this.sendPlay('VPX says it watches, and nothing is to be watched');
      this.changed();
      return;
    }
    this.clearWatchTimer();
    const was = this.forkState;
    this.forkState = 'watching';
    if (was !== 'watching') this.log(`VPX: state watching: ${this.name(this.aimed)}'s table is on screen in 3D`);
    this.changed();
  }

  private onFailed(reason: string): void {
    if (this.link !== 'ready') return;
    const why = reason || 'no reason given';
    if (this.playOut) {
      this.log(`VPX: state failed (${why}), after it was called back; waiting for its state playing`);
      return;
    }
    const peer = this.aimed;
    if (peer === null) {
      this.log(`VPX: state failed (${why}), with no watch asked; ignored`);
      return;
    }
    // The fork goes back by itself and says `state playing` next (§3): no `play` is sent, and no `watch` before it.
    this.clearWatchTimer();
    this.seq += 1;
    this.aimed = null;
    this.forkState = 'leaving';
    this.armPlayOut();
    this.fail(peer, why);
  }

  /** The watch of `peer` did not work: 2D for them until the target changes. */
  private fail(peer: string, detail: string, lostLink = false): void {
    this.log(`3D watch of ${this.name(peer)} did not work (${detail}); the 2D video serves this turn`);
    if (this.target === peer) this.failed = { peer, detail, lostLink };
    this.sync();
  }

  /** The fork is on its own table: whoever waited for that goes on. */
  private released(): void {
    for (const w of [...this.waiters]) this.settle(w, false);
    this.changed();
  }

  private settle(w: Waiter, late: boolean): void {
    if (!this.waiters.delete(w)) return;
    this.d.clearTimeout(w.timer);
    w.cb(late);
  }

  private clearWatchTimer(): void {
    if (this.watchTimer !== null) this.d.clearTimeout(this.watchTimer);
    this.watchTimer = null;
  }

  private clearPlayOut(): void {
    if (this.playTimer !== null) this.d.clearTimeout(this.playTimer);
    this.playTimer = null;
    this.playOut = false;
  }

  /** `state playing` is due (a `play` went out, or `state failed` came): until it comes, or the wait is over, no `watch`. */
  private armPlayOut(): void {
    this.clearPlayOut();
    this.playOut = true;
    this.playTimer = this.d.setTimeout(() => {
      this.playTimer = null;
      if (!this.playOut) return;
      this.playOut = false;
      this.forkState = 'playing';
      this.log(`VPX has not said "state playing" within ${this.playWaitMs / 1000} s; taken as back on its own table`);
      this.released();
      this.sync();
    }, this.playWaitMs);
  }

  private dropLink(why: string | null): void {
    const had = this.link !== 'none';
    const watching = this.link === 'ready' && this.aimed !== null ? this.aimed : null;
    this.clearWatchTimer();
    this.clearPlayOut();
    this.seq += 1;
    this.link = 'none';
    this.own = null;
    this.forkState = 'playing';
    this.aimed = null;
    if (had && why !== null) this.log(`the control connection to VPX is gone (${why}): no 3D on this PC until it is back${watching ? '; VPX goes back to its own table by itself' : ''}`);
    // What this turn's line says: the watch was on and its connection went (a fork that comes back does not take the turn over again).
    if (watching !== null && this.target === watching) this.failed = { peer: watching, detail: 'the control connection to VPX was lost', lostLink: true };
    // A lost connection sends the fork back to its own table (§2 fail-safe): nothing waits for a line that cannot come.
    for (const w of [...this.waiters]) this.settle(w, false);
    this.changed();
  }

  /**
   * The others are told what this PC's VPX is; the tunnel is told whether they may watch it. A fork whose stream port
   * Castcade does not know (it was not started in this run) can watch, but cannot be watched: the others are told
   * `none`, so nobody's VPX is sent to a stream that is not there.
   */
  private publish(): void {
    const port = this.link === 'ready' ? this.streamPort : null;
    const caps = encodeCaps(this.link === 'ready' && port !== null ? this.own : null);
    if (caps !== this.toldCaps) {
      this.toldCaps = caps;
      this.d.setCaps(caps);
    }
    if (port !== this.toldPort) {
      this.toldPort = port;
      this.d.setPlayerPort(port);
    }
    const blind = this.link === 'ready' && port === null;
    if (blind && !this.saidBlind) this.log('VPX is on the control connection, but Castcade does not know its stream port (it did not start that table in this run): this PC can watch in 3D, the others get the 2D video of it');
    this.saidBlind = blind;
  }

  /** Bring the fork and the tunnel to what the target, the setting and the capabilities call for. */
  private sync(): void {
    this.publish();
    for (const id of this.peers) {
      const words = viewWords(this.viewOf(id));
      if (this.logged.get(id) === words) continue;
      this.logged.set(id, words);
      this.log(`${this.name(id)}: this PC shows ${words}`);
    }
    if (this.link === 'ready') {
      const t = this.target;
      const want = t !== null && this.viewOf(t).mode === '3d' ? t : null;
      if (want === null) {
        if (this.aimed !== null) this.sendPlay(t === null ? 'nobody to watch: this PC is up or holds its table' : `${this.name(t)} is shown in 2D`);
      } else if (this.aimed !== want && !this.playOut) this.startWatch(want);
    }
    this.changed();
  }

  private sendPlay(why: string): void {
    this.clearWatchTimer();
    this.seq += 1;
    this.aimed = null;
    if (!this.d.send(PLAY_COMMAND)) {
      // No connection to send on: the fork is on its own table by its own rule (§2 fail-safe).
      this.forkState = 'playing';
      return;
    }
    this.forkState = 'leaving';
    this.armPlayOut();
    this.log(`play: VPX is called back to its own table (${why})`);
  }

  private startWatch(peer: string): void {
    const mine = ++this.seq;
    const reaim = this.aimed !== null;
    this.clearWatchTimer();
    this.aimed = peer;
    this.forkState = 'entering';
    // The timeout runs from the decision: a listener that does not open is a failure like any other.
    this.watchTimer = this.d.setTimeout(() => {
      this.watchTimer = null;
      if (this.seq !== mine || this.aimed !== peer || this.forkState !== 'entering') return;
      this.sendPlay(`no "state watching" within ${this.watchTimeoutMs / 1000} s`);
      this.fail(peer, `VPX did not show their table within ${this.watchTimeoutMs / 1000} s`);
    }, this.watchTimeoutMs);
    void this.d.aim(peer).then(
      (port) => {
        if (this.seq !== mine || this.link !== 'ready') return;
        if (!this.d.send(watchCommand(port))) return;
        this.log(`watch 127.0.0.1:${port}: VPX is ${reaim ? 're-aimed at' : 'sent to watch'} ${this.name(peer)}'s table`);
      },
      (e: unknown) => {
        if (this.seq !== mine || this.link !== 'ready') return;
        // Nothing was sent for this watch. A fork still on an earlier one is called back.
        if (reaim) this.sendPlay('the tunnel listener did not open');
        else {
          this.clearWatchTimer();
          this.seq += 1;
          this.aimed = null;
          this.forkState = 'playing';
        }
        this.fail(peer,`the tunnel's listener did not open (${e instanceof Error ? e.message : String(e)})`);
      },
    );
  }
}
