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
 *   fork → companion   `hello 1 <build> <editables> <table-hash> <stream-port>`   once per connection
 *   fork → companion   `state playing`                              its own table is shown and live (first after hello)
 *   fork → companion   `state watching`                             the other player's first frame is on screen
 *   fork → companion   `state failed <reason>`                      a `watch` did not work; `state playing` follows
 *   companion → fork   `watch 127.0.0.1:<port>`                     watch the stream there; again: re-aim
 *   companion → fork   `play`                                       back to the own table
 *
 * How the lines are read here (`parseControlLine`): exactly these words, fields separated by one space, nothing
 * before `hello` counts. `build`, `editables` and `table-hash` are opaque tokens; the table identity is
 * `<editables> <hash>`, compared as text. `stream-port` (rule 9) is the port the fork's stream listener is bound to:
 * the only port this PC ever offers to the others (never one Castcade picked at launch, which a table left open or a
 * second table would make stale). A `hello` whose version is not 1 makes this PC one without 3D (logged), whatever
 * follows. Nothing is commanded before the first `state playing` after `hello`.
 *
 * The rules of §3 this machine relies on, by number: every `watch`, a re-aim included, is answered by
 * `state watching` or `state failed` within `WATCH_TIMEOUT_MS` (2); after `state failed` the fork comes back by itself
 * and says `state playing` (3, 6, and 12 for a stream that stalls); a `play` while playing is answered with
 * `state playing` again (4); a re-aim is a `watch` with the same address and no `state playing` in between (11).
 *
 * The lines carry no numbers (accepted in this iteration), so the machine keeps what is outstanding unambiguous by
 * what it sends when:
 *   - `play` goes out at once, whatever is outstanding (a player's own turn never waits). From then until
 *     `state playing` (or `PLAY_WAIT_MS`, after which the fork is taken to be on its own table) no `watch` is sent
 *     (5), and a `state watching` / `state failed` that arrives is the answer to something that `play` already
 *     cancelled: ignored.
 *   - a `watch` while an earlier `watch` stands is the re-aim and goes out at once; an answer belongs to the latest.
 *   - `state playing` with no `play` outstanding while a watch stands: the fork left the watch by itself without
 *     saying `state failed` first, or the line crossed a new `watch`: 2D this turn either way.
 *   - `state watching` when nothing is to be watched (a `watch` that crossed a failure): `play` is sent again. A
 *     player is never left on another's table by a line that crossed.
 *
 * The fork acts on, and answers, only the LAST command of those it reads in one go (TCP may hand it two lines that
 * left here milliseconds apart: a grant right after a turn change). Nothing here waits for the answer to a command
 * that a later one replaced: a `play` after a `watch` takes that watch's timeout with it and expects `state playing`
 * alone (a `state watching` that comes first all the same is ignored); a second `watch` replaces the first one's
 * timeout and the one `state watching` that follows is the second's. `play` then `watch` never leave together: the
 * `watch` waits for the `play`'s answer.
 *
 * What is sent is `play` or `watch 127.0.0.1:<port>` and nothing else, ever: no empty line, no `watch` without an
 * address (the fork ignores those without an answer), no line anywhere near the 2048 bytes that would make it close
 * the connection.
 *
 * `state failed <reason>`: the reason is free text for the log and the Match tab (`refused`, `timeout`, `stalled`,
 * `lost`, `closed`, `badaddress`, `overflow` as the fork is built today); none of them is read for its meaning, and
 * one this build has never seen is a failed watch like any other.
 *
 * A `hello` whose stream port is `0` is a fork with no stream listener (its port was taken): that PC can watch, and
 * the others are told it has no build to watch (nothing is offered that nothing listens on).
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
 * connection lost) is 2D for that turn. A turn is a grant (`setTarget`'s second argument): the next player up, and
 * also a new grant to the same player (shoot again; the last player with balls left), tries again.
 *
 * The turn lock (§4.3, `whenPlaying`): at the grant the shell lifts the lock only once the fork says `state playing`,
 * `PLAY_WAIT_MS` at most, then anyway (logged). A PC whose fork is on its own table, or that has none, never waits.
 *
 * The first start (I11.4.9, `startWait`). The first turn of a match should already be in 3D, so the match's first
 * start waits for this PC while its 3D connection is still being made (the shell tells the host, which holds a start
 * as it does for a table that is not open, and never for longer than one `START_WAIT_MS` in all: `match/controller.ts`).
 * This PC is waited for while the setting is `auto` and either
 *   (a) its match table was started in the Castcade VPX build (`forkLaunched`) and that VPX is not `ready` on the
 *       control connection yet: until `FORK_HELLO_WAIT_MS` after the table was seen open (`setTableOpen`). "Seen
 *       open" is the witness finding the VPX process with the table on its command line, seconds after the start
 *       and long before the table has loaded; the fork connects at its first frame, when the load is over (Game of
 *       Thrones LE, 2026-11-20: seen at 3.4 s, connected at 14.6 s; I11.4.13). So the limit is a table's loading
 *       time, 45 s, and the one limit on a held start bounds it (`match/controller.ts`). A build from before the
 *       role `match` never connects: the shell remembers that for the run and does not wait for it again
 *       (`forkSilent`, `main/stream3d-host.ts`); or
 *   (b) its VPX is ready and nothing has been heard yet from some other player's PC (no capability: the data
 *       connection to it is not up): per player, until `START_WAIT_MS` after this PC began connecting to them (its
 *       data connections open and the player in the match, whichever came later), unless the tunnel has given up on
 *       that player (`setTunnel`: no path) or is broken. Not counted from when this PC's VPX was ready: a table left
 *       open from the last match, or a player who joins a minute after the host's table loaded, is waited for all the
 *       same. One exception (I11.4.13): a VPX that connects after its own limit (a) has passed gets its 45 s from
 *       that moment, so a table that loaded slowly is not left without the wait.
 * A PC with the setting off, with no Castcade VPX build, or whose build speaks another control version is never
 * waited for. Only while the shell says the match has not started (`setStartGate`): a next game and a rejoin never
 * wait. A new match (`reset`) starts from nothing.
 *
 * Every decision and state change is one log line starting `stream3d:`. What comes from a socket or from another PC
 * is never logged raw: a `hello` and a capability are tokens of printable ASCII or they are not read at all, a
 * `state failed` reason and a player's name lose their control characters, and the lines a peer or a fork can cause
 * at will (a line that is not one, a capability that does not read) are logged once and then counted
 * (`QUIET_LOG_MS`): `companion.log` goes to ArcAid with a tester's report.
 */

export const CONTROL_VERSION = 1;
/** A `watch` not answered by `state watching` within this falls back to the 2D video (§4.3). */
export const WATCH_TIMEOUT_MS = 5_000;
/** At the grant the lock waits this long at most for `state playing` (§4.3). */
export const PLAY_WAIT_MS = 2_000;
/** A control line is at most this long (characters, the newline apart). */
export const CONTROL_LINE_MAX = 512;
/** A line a fork or a peer can repeat at will is logged at most this often; what came meanwhile is counted. */
export const QUIET_LOG_MS = 30_000;
/**
 * Log lines written while a line of the fork is handled, per `QUIET_LOG_MS`: a match writes a handful a turn; a fork
 * that sends valid lines without end (each of them a state change here) is said once and then not logged.
 */
export const FORK_LOG_MAX = 40;
/**
 * Changes of what one PC says about its VPX that are taken per `QUIET_LOG_MS` (each is a log line, and may send this
 * PC's fork to watch or back). A fork that restarts every 2 s stays under it; past it, what the PC said last is taken
 * when the time is up.
 */
export const CAPS_CHANGES_MAX = 8;
/**
 * I11.4.9: the match's first start waits for this PC's 3D connection at most this long after its VPX was ready on the
 * control connection (or, while that VPX has not connected yet, after its table opened).
 */
export const START_WAIT_MS = 45_000;
/**
 * I11.4.9, I11.4.13: a match table started in the Castcade VPX build is waited for this long after the table was seen
 * open, for its VPX to be on the control connection. The fork connects when the table has loaded (its first frame),
 * and the table is "seen open" when its process is found, seconds into the load: 10 s were too short for a slow table.
 */
export const FORK_HELLO_WAIT_MS = 45_000;
const TOKEN = /^[\x21-\x7e]{1,128}$/;
const TABLE_IDENTITY = /^[\x21-\x7e]{1,128} [\x21-\x7e]{1,128}$/;
// eslint-disable-next-line no-control-regex -- control characters are exactly what a line must not hold
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;
// eslint-disable-next-line no-control-regex -- C0, DEL, C1 and the two Unicode line separators
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;

/** Text from a socket or another PC as a log line may carry it: no control characters, no line breaks, bounded. */
export function forLog(text: string, max = 120): string {
  return text.replace(UNPRINTABLE, ' ').trim().slice(0, max);
}

export type Watch3dSetting = 'auto' | 'off';

export type ControlLine =
  | { kind: 'hello'; version: number; build: string; editables: string; tableHash: string; streamPort: number }
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
  if (line.startsWith('state failed ')) return { kind: 'failed', reason: forLog(line.slice('state failed '.length), 200) };
  const parts = line.split(' ');
  if (parts[0] !== 'hello' || parts.length < 2 || !/^\d{1,6}$/.test(parts[1] as string)) return null;
  const version = Number(parts[1]);
  if (version !== CONTROL_VERSION) return { kind: 'hello', version, build: '', editables: '', tableHash: '', streamPort: 0 };
  if (parts.length !== 6) return null;
  const [, , build, editables, tableHash, port] = parts as [string, string, string, string, string, string];
  // The port: a port, or `0` (the fork has no stream listener).
  if (!TOKEN.test(build) || !TOKEN.test(editables) || !TOKEN.test(tableHash) || !/^(0|[1-9]\d{0,4})$/.test(port)) return null;
  const streamPort = Number(port);
  if (streamPort > 65535) return null;
  return { kind: 'hello', version, build, editables, tableHash, streamPort };
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

/**
 * What a peer said: its fork, `none`, or null for anything else (then nothing is known of it). A build and a table
 * identity are read by the rule of `hello`'s fields (tokens of printable ASCII), so what a peer sends can be logged.
 */
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
  if (typeof build !== 'string' || typeof table !== 'string' || !TOKEN.test(build) || !TABLE_IDENTITY.test(table)) return null;
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
  /** The clock of the log's rate limit; default `Date.now`. */
  now?(): number;
  watchTimeoutMs?: number;
  playWaitMs?: number;
  /** I11.4.9: `START_WAIT_MS` and `FORK_HELLO_WAIT_MS` for the tests. */
  startWaitMs?: number;
  forkHelloWaitMs?: number;
}

/** I11.4.9: whether the match's first start should wait for this PC's 3D connection (`Stream3d.startWait`). */
export interface StartWait {
  pending: boolean;
  /**
   * When (the machine's clock) this PC stops being waited for, whatever happens (b: the last of the players it
   * waits for). Null when it is not waited for, and while its VPX has not connected and its table is not open yet (the
   * limit starts when the table opens).
   */
  until: number | null;
  /** `fork`: this PC's VPX has not connected to Castcade yet (a); `peers`: nothing heard from `waitingFor` yet (b). */
  why: 'fork' | 'peers' | null;
  waitingFor: string[];
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
  /** The port the fork's stream listener is bound to, as its `hello` said; null without a ready fork. */
  streamPort: number | null;
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
  /**
   * A `watch` line has gone out since the fork last said `state playing`: it may be away from its own table. False
   * while a watch is only decided (the tunnel's listener is still opening): there is nothing to call back then.
   */
  private watchOut = false;
  /** A `play` (or a `state failed`) whose `state playing` has not come yet: no `watch` goes out meanwhile. */
  private playOut = false;
  private playTimer: unknown = null;
  private target: string | null = null;
  /** The turn the target is for (the grant, as the shell names it): a new one tries a failed watch again. */
  private turn: string | null = null;
  /** The watch of the target failed this turn: 2D until the turn changes. */
  private failed: { peer: string; detail: string; lostLink: boolean } | null = null;
  /** The port the fork's stream listener is bound to (its `hello`); null without a hello of this version. */
  private streamPort: number | null = null;
  private readonly caps = new Map<string, ForkInfo | 'none'>();
  private peers: string[] = [];
  private seq = 0;
  private watchTimer: unknown = null;
  private readonly waiters = new Set<Waiter>();
  private toldCaps: string | null = null;
  private toldPort: number | null | undefined = undefined;
  private readonly quiet = new Map<string, { at: number; n: number }>();
  /** A line of the fork is being handled: what is logged meanwhile counts against `FORK_LOG_MAX`. */
  private fromFork = false;
  private forkLog = { since: -Infinity, n: 0 };
  /** Per PC: the changes of its capability taken since `since`, and what it said last past the limit (with its timer). */
  private readonly capsRate = new Map<string, { since: number; n: number; held: { text: string | null } | null; timer: unknown }>();
  private readonly logged = new Map<string, string>();
  private readonly watchTimeoutMs: number;
  private readonly playWaitMs: number;
  private readonly startWaitMs: number;
  private readonly forkHelloWaitMs: number;
  // ---- I11.4.9: the first start waits for the 3D connection ----
  /** The match has not started yet (the shell's word): only then is anything waited for. */
  private gate = false;
  /** A match table was started in the Castcade VPX build and that VPX has not been `ready` since. */
  private expecting = false;
  /** When this PC's table opened (the shell's word); null: it is not open. */
  private tableOpenAt: number | null = null;
  /**
   * I11.4.13: when this PC's VPX was ready, if that was after its own limit (a) had passed: connecting to the others
   * counts from there, so the PC still gets its wait (b). Null otherwise: a VPX that was there in time, or drops and
   * connects again, gets no more time than the 45 s since connecting began.
   */
  private lateReadyAt: number | null = null;
  /** I11.4.13: the wait for this PC's VPX (a) ended at its limit, and that VPX has not connected since. */
  private forkLate = false;
  /** When each other player came into this match on this PC (`setPeers`): with `tunnelAt`, when connecting to them began. */
  private readonly peerSince = new Map<string, number>();
  /** When this match's data connections opened on this PC, and how long after that each PC was first heard from. */
  private tunnelAt: number | null = null;
  private readonly heardAfter = new Map<string, number>();
  private tunnelBroken = false;
  private noPath: string[] = [];
  private waitTimer: unknown = null;
  /** What the log last said this PC is waited for (`` : nothing). */
  private waitSaid = '';

  constructor(private readonly d: Stream3dDeps) {
    this.watchTimeoutMs = d.watchTimeoutMs ?? WATCH_TIMEOUT_MS;
    this.playWaitMs = d.playWaitMs ?? PLAY_WAIT_MS;
    this.startWaitMs = d.startWaitMs ?? START_WAIT_MS;
    this.forkHelloWaitMs = d.forkHelloWaitMs ?? FORK_HELLO_WAIT_MS;
  }

  // ---- the shell ----

  setSetting(s: Watch3dSetting): void {
    if (s === this.setting) return;
    this.setting = s;
    this.log(`the setting is ${s === 'auto' ? 'auto: 3D whenever both PCs can' : 'off: this PC shows the 2D video'}`);
    this.sync();
  }

  /** The other players of the match; one who left is forgotten. */
  setPeers(ids: readonly string[]): void {
    const next = [...new Set(ids)];
    if (next.length === this.peers.length && next.every((id, i) => id === this.peers[i])) return;
    this.peers = next;
    const at = this.clock();
    for (const id of next) if (!this.peerSince.has(id)) this.peerSince.set(id, at);
    for (const id of [...this.peerSince.keys()]) if (!next.includes(id)) this.peerSince.delete(id);
    for (const id of [...this.caps.keys()]) if (!next.includes(id)) this.caps.delete(id);
    for (const id of [...this.logged.keys()]) if (!next.includes(id)) this.logged.delete(id);
    for (const id of [...this.capsRate.keys()]) if (!next.includes(id)) this.forgetCapsRate(id);
    this.sync();
  }

  /** What `peer`'s PC said over the tunnel (`encodeCaps`), or null: its channel closed. */
  peerCaps(peer: string, text: string | null): void {
    const c = decodeCaps(text);
    // I11.4.9: how long the connection to that PC took, from this PC's data connections opening to its first word.
    if (c !== null && this.tunnelAt !== null && !this.heardAfter.has(peer) && this.peers.includes(peer)) this.heardAfter.set(peer, Math.max(0, this.clock() - this.tunnelAt));
    const was = this.caps.get(peer) ?? null;
    // Never the text itself in the log: it is whatever the other PC chose to send, at whatever rate.
    if (c === null && text !== null) this.logQuietly(`caps ${peer}`, `${this.name(peer)}'s PC said something about its VPX this Castcade cannot read (${text.length} characters); taken as nothing said`);
    if (JSON.stringify(c) === JSON.stringify(was)) {
      // Back to what is known: nothing held for later is newer than this.
      const r = this.capsRate.get(peer);
      if (r?.held) r.held = { text };
      return;
    }
    if (!this.takeCapsChange(peer, text)) return;
    if (c === null) this.caps.delete(peer);
    else {
      this.caps.set(peer, c);
      this.log(c === 'none' ? `${this.name(peer)}'s PC: no Castcade VPX build runs the table there` : `${this.name(peer)}'s PC: Castcade VPX build ${c.build}, table ${c.table}`);
    }
    this.sync();
  }

  /** `CAPS_CHANGES_MAX`: true when this change is taken now; false when it is kept for the end of the window. */
  private takeCapsChange(peer: string, text: string | null): boolean {
    const now = (this.d.now ?? Date.now)();
    let r = this.capsRate.get(peer);
    if (!r || now - r.since >= QUIET_LOG_MS) {
      this.forgetCapsRate(peer);
      r = { since: now, n: 0, held: null, timer: null };
      this.capsRate.set(peer, r);
    }
    r.n += 1;
    if (r.n <= CAPS_CHANGES_MAX) return true;
    if (r.held === null) {
      this.log(`${this.name(peer)}'s PC changed what it says about its VPX ${CAPS_CHANGES_MAX} times in ${QUIET_LOG_MS / 1000} s; what it says from here on is taken when that time is up`);
      const rate = r;
      r.timer = this.d.setTimeout(() => {
        if (this.capsRate.get(peer) !== rate) return;
        const held = rate.held;
        this.capsRate.delete(peer);
        if (held) this.peerCaps(peer, held.text);
      }, QUIET_LOG_MS - (now - r.since));
    }
    r.held = { text };
    return false;
  }

  private forgetCapsRate(peer: string): void {
    const r = this.capsRate.get(peer);
    if (!r) return;
    if (r.timer !== null) this.d.clearTimeout(r.timer);
    this.capsRate.delete(peer);
  }

  /**
   * §4.3: the player this PC should be watching (the one up, while this PC waits with its table locked), or null.
   * `turn` names the grant they play under: a new one for the same player is a new turn, and a watch that failed in
   * the last one is tried again.
   */
  setTarget(peer: string | null, turn: string | null = null): void {
    if (peer === this.target && turn === this.turn) return;
    this.target = peer;
    this.turn = turn;
    this.failed = null;
    this.sync();
  }

  /**
   * The match is over on this PC (or none began): nobody to watch, nothing known of anyone, the fork back on its own
   * table. The fork's own connection stays as it is (the table may stay open for the next match).
   */
  reset(): void {
    this.target = null;
    this.turn = null;
    this.failed = null;
    this.peers = [];
    this.peerSince.clear();
    this.caps.clear();
    this.logged.clear();
    for (const id of [...this.capsRate.keys()]) this.forgetCapsRate(id);
    // I11.4.9: nothing is waited for outside a match's lobby, and nothing is known of this match's tunnel.
    this.gate = false;
    this.expecting = false;
    this.forkLate = false;
    this.lateReadyAt = null;
    this.tunnelAt = null;
    this.tunnelBroken = false;
    this.noPath = [];
    this.heardAfter.clear();
    this.sync();
    this.retell();
    for (const w of [...this.waiters]) this.settle(w, false);
  }

  /** The tunnel is a new one (a match began, or its tunnel opened late): what this PC's VPX is goes out on it again. */
  retell(): void {
    this.toldCaps = null;
    this.toldPort = undefined;
    this.publish();
  }

  /**
   * I11.4.9: this match's data connections opened on this PC just now (`retell` follows): the time each other PC takes
   * to be heard from is counted from here.
   */
  tunnelOpened(): void {
    this.tunnelAt = this.clock();
    this.tunnelBroken = false;
    this.noPath = [];
    this.heardAfter.clear();
    this.retell();
    this.changed();
  }

  // ---- I11.4.9: the first start ----

  /** The match has not started yet (the lobby before game 1): only then does `startWait` ever say `pending`. */
  setStartGate(on: boolean): void {
    if (on === this.gate) return;
    this.gate = on;
    this.changed();
  }

  /** A match table was just started in the Castcade VPX build: its VPX is expected on the control connection. */
  forkLaunched(): void {
    if (this.link === 'ready' || this.link === 'version') return;
    this.expecting = true;
    // The limit counts from this start's table being seen open, not from a sighting before it.
    this.tableOpenAt = null;
    this.forkLate = false;
    this.changed();
  }

  /** The Castcade VPX build that was started did not come up (it ended, or reported a start error): nothing is expected. */
  forkGone(): void {
    if (!this.expecting) return;
    this.expecting = false;
    this.changed();
  }

  /** Whether a table is open on this PC (the witness's reading): the limit of a wait for this PC's VPX runs from then. */
  setTableOpen(open: boolean): void {
    if (open === (this.tableOpenAt !== null)) return;
    this.tableOpenAt = open ? this.clock() : null;
    this.changed();
  }

  /** What the tunnel says of its own state: broken for good (its page), and the players it found no path to. */
  setTunnel(t: { broken: boolean; noPath: readonly string[] }): void {
    const next = [...t.noPath].sort();
    if (t.broken === this.tunnelBroken && next.length === this.noPath.length && next.every((id, i) => id === this.noPath[i])) return;
    this.tunnelBroken = t.broken;
    this.noPath = next;
    this.changed();
  }

  /** When this PC began connecting to `peer`: its data connections open and the player in the match, whichever came later. */
  private connectingSince(peer: string): number {
    return Math.max(this.tunnelAt ?? -Infinity, this.lateReadyAt ?? -Infinity, this.peerSince.get(peer) ?? this.clock());
  }

  /** I11.4.12: a match table was started in the Castcade VPX build and its VPX is not on the control connection yet (it may still be loading). */
  expectingFork(): boolean {
    return this.expecting && this.link !== 'ready' && this.link !== 'version';
  }

  /**
   * I11.4.13: the VPX that was started for the match table has not connected within its limit and still has not:
   * a build from before the 3D watch in a match (or a table that takes longer than the limit to load). The shell
   * remembers it for the run, so the next start is not made to wait for the same build.
   */
  forkSilent(): boolean {
    return this.forkLate && this.link === 'none';
  }

  /** Whether the match's first start should wait for this PC now (the rule is in the header). */
  startWait(): StartWait {
    const none: StartWait = { pending: false, until: null, why: null, waitingFor: [] };
    if (!this.gate || this.setting !== 'auto') return none;
    const now = this.clock();
    if (this.link === 'ready') {
      if (this.tunnelBroken) return none;
      const unknown = this.peers.filter((id) => !this.caps.has(id) && !this.noPath.includes(id) && now < this.connectingSince(id) + this.startWaitMs);
      if (unknown.length === 0) return none;
      return { pending: true, until: Math.max(...unknown.map((id) => this.connectingSince(id) + this.startWaitMs)), why: 'peers', waitingFor: unknown };
    }
    // A VPX nobody started for this match that is between its `hello` and its first `state playing` is ready in a moment.
    if (this.link === 'version' || !this.expecting) return none;
    const until = this.tableOpenAt === null ? null : this.tableOpenAt + this.forkHelloWaitMs;
    if (until !== null && now >= until) return none;
    return { pending: true, until, why: 'fork', waitingFor: [] };
  }

  /** The log's lines about the wait (it began, it ended and why), and the timer that ends it at its limit. */
  private syncWait(): void {
    const w = this.startWait();
    if (this.waitTimer !== null) this.d.clearTimeout(this.waitTimer);
    this.waitTimer = null;
    const now = this.clock();
    // The next moment the answer changes by the clock alone: the limit of a player this PC waits for, or of its own VPX.
    const next = w.why === 'peers' ? Math.min(...w.waitingFor.map((id) => this.connectingSince(id) + this.startWaitMs)) : w.until;
    if (w.pending && next !== null) {
      this.waitTimer = this.d.setTimeout(() => {
        this.waitTimer = null;
        this.changed();
      }, Math.max(0, next - now) + 1);
    }
    const names = (ids: readonly string[]): string => ids.map((id) => this.name(id)).join(', ');
    const said = w.pending ? `${w.why}:${w.waitingFor.join(',')}` : '';
    if (said === this.waitSaid) return;
    const was = this.waitSaid;
    this.waitSaid = said;
    const secs = Math.round(this.startWaitMs / 1000);
    const forkSecs = Math.round(this.forkHelloWaitMs / 1000);
    if (w.pending) {
      this.log(
        w.why === 'fork'
          ? `the match's start waits for this PC: its Castcade VPX build has not connected to Castcade yet (${forkSecs} s at most once the table is open)`
          : `the match's start waits for the 3D connection to ${names(w.waitingFor)}: nothing heard from ${w.waitingFor.length > 1 ? 'their PCs' : 'that PC'} yet (${w.until !== null ? Math.max(0, Math.ceil((w.until - now) / 1000)) : secs} s at most)`,
      );
      return;
    }
    if (was === '') return;
    const heard = [...this.heardAfter].map(([id, ms]) => `${this.name(id)} ${(ms / 1000).toFixed(1)} s`).join(', ');
    const after = heard ? ` (heard from, after this PC's data connections opened: ${heard})` : '';
    const unknown = this.peers.filter((id) => !this.caps.has(id));
    const late = unknown.filter((id) => !this.noPath.includes(id));
    let why: string;
    if (!this.gate) why = `the match started or the lobby is gone${unknown.length > 0 ? `, with nothing heard yet from ${names(unknown)}: they are shown in the 2D video until their PC is heard from` : ''}`;
    else if (this.setting !== 'auto') why = '3D watch was turned off on this PC';
    else if (this.link === 'version') why = 'its Castcade VPX build speaks another version of the control connection';
    else if (this.link !== 'ready') {
      // Not a verdict on the build: a table that is still loading connects when it is up, and is then waited for (b).
      if (this.expecting) this.forkLate = true;
      why = this.expecting
        ? `${forkSecs} s passed since the table was seen open and its Castcade VPX build has not connected to Castcade yet (it connects when the table has loaded; a build from before the 3D watch in a match never does): a start does not wait for this PC's VPX any longer`
        : 'the Castcade VPX build is not coming (it ended, or did not start)';
    }
    else if (this.tunnelBroken) why = "this PC's data connections are not working";
    else if (unknown.length === 0) why = `this PC's 3D connections are settled${after}`;
    else if (late.length > 0) why = `${secs} s passed since this PC began connecting to ${names(late)} and nothing was heard from ${late.length > 1 ? 'their PCs' : 'that PC'}: the first turn may be the 2D video`;
    else why = `the data connection to ${names(unknown)} found no path: the 2D video serves`;
    this.log(`the match's start no longer waits for this PC: ${why}`);
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
    this.fromFork = true;
    try {
      this.takeForkLine(raw);
    } finally {
      this.fromFork = false;
    }
  }

  private takeForkLine(raw: string): void {
    const l = parseControlLine(raw);
    if (!l) {
      this.logQuietly('line', `a control line this Castcade does not know was ignored (${raw.length} characters: "${forLog(raw, 60)}")`);
      return;
    }
    if (l.kind === 'hello') return this.onHello(l);
    if (this.link === 'version') return;
    if (this.link === 'connecting') {
      this.logQuietly('early', `VPX said "${forLog(raw, 40)}" before its hello; ignored`);
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
      streamPort: this.link === 'ready' ? this.streamPort : null,
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

  /** A name comes from the other PC's HELLO: it is logged without control characters. */
  private name(peer: string): string {
    return forLog(this.d.name?.(peer) ?? peer, 64) || 'a player';
  }

  private log(line: string): void {
    if (this.fromFork) {
      const now = (this.d.now ?? Date.now)();
      if (now - this.forkLog.since >= QUIET_LOG_MS) this.forkLog = { since: now, n: 0 };
      this.forkLog.n += 1;
      if (this.forkLog.n > FORK_LOG_MAX) {
        if (this.forkLog.n === FORK_LOG_MAX + 1) this.d.log(`stream3d: VPX sent enough lines for ${FORK_LOG_MAX} log lines in ${QUIET_LOG_MS / 1000} s; what its lines do is not logged again until that time is up`);
        return;
      }
    }
    this.d.log(`stream3d: ${line}`);
  }

  /** A line the other end can cause at will: once, then counted until `QUIET_LOG_MS` has passed. */
  private logQuietly(key: string, line: string): void {
    const now = (this.d.now ?? Date.now)();
    const q = this.quiet.get(key);
    if (q && now - q.at < QUIET_LOG_MS) {
      q.n += 1;
      return;
    }
    this.quiet.set(key, { at: now, n: 0 });
    // The map is bounded by who can be a key: two words for the fork, one per player of a match.
    if (this.quiet.size > 64) this.quiet.delete(this.quiet.keys().next().value as string);
    this.log(`${line}${q && q.n > 0 ? ` (and ${q.n} more like it since the last line)` : ''}`);
  }

  private changed(): void {
    this.syncWait();
    this.d.onChange();
  }

  private clock(): number {
    return (this.d.now ?? Date.now)();
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
      this.expecting = false;
      this.log(`VPX speaks version ${l.version} of the control connection and this Castcade version ${CONTROL_VERSION}: no 3D on this PC until both are updated; the 2D video serves`);
      this.sync();
      return;
    }
    this.own = { build: l.build, table: `${l.editables} ${l.tableHash}` };
    this.streamPort = l.streamPort > 0 ? l.streamPort : null;
    this.link = 'helloed';
    this.log(`VPX said hello: build ${l.build}, table ${this.own.table}, ${this.streamPort !== null ? `its stream on 127.0.0.1:${this.streamPort}` : 'and no stream listener (port 0): this PC can watch in 3D, the others get the 2D video of it'}`);
    this.changed();
  }

  private onPlaying(): void {
    if (this.link === 'helloed') {
      // The first line after hello: the fork is on its own table and takes commands from here on.
      this.link = 'ready';
      if (this.forkLate) {
        this.forkLate = false;
        this.lateReadyAt = this.clock();
        this.log(`VPX connected ${this.tableOpenAt !== null ? `${Math.round((this.lateReadyAt - this.tableOpenAt) / 1000)} s after its table was seen open, ` : ''}after the start had stopped waiting for it: from here on this PC is waited for like any other, until the other players' PCs are heard from`);
      }
      this.expecting = false;
      this.forkState = 'playing';
      this.aimed = null;
      this.watchOut = false;
      this.log('VPX: state playing (its own table); it can be watched and can watch');
      this.sync();
      return;
    }
    if (this.playOut) {
      // The answer to a `play` (or what follows `state failed`).
      this.clearPlayOut();
      this.forkState = 'playing';
      this.watchOut = false;
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
      this.watchOut = false;
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
      this.watchOut = true;
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
      this.watchOut = false;
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
    this.streamPort = null;
    this.watchOut = false;
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
   * The others are told what this PC's VPX is, and the tunnel which port its stream is on: the one the fork's `hello`
   * named, for as long as the fork is on the control connection.
   */
  private publish(): void {
    const ready = this.link === 'ready';
    // A fork with no stream listener (hello's port 0) can watch and cannot be watched: the others are told `none`.
    const caps = encodeCaps(ready && this.streamPort !== null ? this.own : null);
    if (caps !== this.toldCaps) {
      this.toldCaps = caps;
      this.d.setCaps(caps);
    }
    const port = ready ? this.streamPort : null;
    if (port !== this.toldPort) {
      this.toldPort = port;
      this.d.setPlayerPort(port);
    }
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
    if (!this.watchOut) {
      // The watch was decided and never sent (the turn moved on while the tunnel's listener opened): the fork never
      // left its own table, and nothing waits for it.
      this.forkState = 'playing';
      this.released();
      return;
    }
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
    const noListener = (e: unknown): void => {
      if (this.seq !== mine || this.link !== 'ready') return;
      // Nothing was sent for this watch. A fork still on an earlier one is called back.
      if (reaim) this.sendPlay('the tunnel listener did not open');
      else {
        this.clearWatchTimer();
        this.seq += 1;
        this.aimed = null;
        this.forkState = 'playing';
      }
      this.fail(peer, `the tunnel's listener did not open (${e instanceof Error ? e.message : String(e)})`);
    };
    void this.d.aim(peer).then((port) => {
      if (this.seq !== mine || this.link !== 'ready') return;
      // Never a `watch` without a usable address: the fork ignores such a line and answers nothing.
      if (!Number.isInteger(port) || port < 1 || port > 65535) return noListener(new Error(`not a port: ${String(port)}`));
      if (!this.d.send(watchCommand(port))) return;
      this.watchOut = true;
      this.log(`watch 127.0.0.1:${port}: VPX is ${reaim ? 're-aimed at' : 'sent to watch'} ${this.name(peer)}'s table`);
    }, noListener);
  }
}
