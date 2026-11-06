/**
 * D2.8 (2026-11-01): the table-sound helper as the match host drives it. Spawns `castcade-audio.exe`
 * (audio-helper/README.md), writes its stdin commands from a wanted state (`apply`), parses its stdout (event lines and
 * `CAU1` audio frames) and copies its stderr into the companion log. No Electron here; the caller resolves the exe
 * (`resolveAudioHelper`) and wires the frames to the panel page.
 *
 * Rules:
 *   - `apply({ mutePid, tapPid })` is the whole wanted state; only the difference from what the helper was told goes out
 *     (`unmute` the old pid before `mute` the new one), and a restarted helper is told it all again;
 *   - started at the first `start()` / `apply()`; a missing exe → `unavailable helper_missing`, a start-up failure (an
 *     exit before `ready`, or exit 2 / 64) → `unavailable helper_failed:<code>`; any other exit we did not ask for →
 *     a restart, at most one every `RESTART_MIN_MS`;
 *   - a `tap-error` is retried after `RESTART_MIN_MS` while the tap is still wanted; `tap-unavailable` (Windows before
 *     10 2004) is final for this run and shows in `reason` while muting carries on;
 *   - `stop()` ends stdin: the helper unmutes everything it muted and exits; killed after `STOP_GRACE_MS`. Killing the
 *     companion closes the pipe the same way, and the helper's `--state` file covers a helper that was killed itself;
 *   - D2.10 (2026-11-05): `level(pid, percent)` / `unlevel()` set and restore the session volume of that VPX's tree
 *     (helper 0.2.0's `level` / `unlevel`); the same difference-only sync and restart replay. A helper that does not
 *     know the command (0.1.0 answers `error unknown_command level`) is told once in the log and asked no more.
 * Nothing here ever blocks a match: every failure is a status.
 */
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { TableAudioStatus } from './match-media-types.js';

export const AUDIO_HELPER_EXE = 'castcade-audio.exe';
export const AUDIO_FRAME_MAGIC = 'CAU1';
/** 10 ms of float32 stereo at 48 kHz. */
export const AUDIO_FRAME_BYTES = 3840;
/** A length field above this is garbage (the parser resyncs); the helper never sends more than 10 ms. */
export const MAX_AUDIO_FRAME_BYTES = 64 * 1024;
/** Text without a newline that grows past this is dropped (the stream is not ours). */
const MAX_LINE = 4096;
export const RESTART_MIN_MS = 5000;
export const STOP_GRACE_MS = 3000;

// ---- where the exe is ----

export interface AudioHelperPathInput {
  packaged: boolean;
  /** process.resourcesPath when packaged. */
  resourcesPath: string;
  /** The companion package directory (dev runs). */
  companionDir: string;
}

/**
 * Packaged: `resources/audio-helper/` (fetch-audio-helper.mjs, shipped by electron-builder.yml). Dev: a local CMake build
 * (`audio-helper/build/Release/`) first, else a fetched copy in `companion/resources/audio-helper/`. Null when none.
 */
export function resolveAudioHelper(i: AudioHelperPathInput, exists: (p: string) => boolean = existsSync): string | null {
  const candidates = i.packaged
    ? [join(i.resourcesPath, 'audio-helper', AUDIO_HELPER_EXE)]
    : [resolve(i.companionDir, '..', 'audio-helper', 'build', 'Release', AUDIO_HELPER_EXE), resolve(i.companionDir, 'resources', 'audio-helper', AUDIO_HELPER_EXE)];
  return candidates.find((p) => exists(p)) ?? null;
}

// ---- stdout: lines and frames ----

export type HelperOutput = { kind: 'frame'; pcm: Uint8Array } | { kind: 'line'; text: string } | { kind: 'resync'; skipped: number };

const MAGIC = [0x43, 0x41, 0x55, 0x31]; // "CAU1"

function indexOfMagic(b: Uint8Array, from: number): number {
  for (let i = from; i + 3 < b.length; i++) if (b[i] === MAGIC[0] && b[i + 1] === MAGIC[1] && b[i + 2] === MAGIC[2] && b[i + 3] === MAGIC[3]) return i;
  return -1;
}

/** True when `b` ends in a proper prefix of the magic at `at` (more bytes may make it whole). */
function magicPrefixAt(b: Uint8Array, at: number): boolean {
  for (let i = at; i < b.length; i++) if (b[i] !== MAGIC[i - at]) return false;
  return at < b.length;
}

/**
 * The helper's stdout, in whatever chunks the pipe gives: `CAU1` + u32 LE byteLength + payload is a frame; text up to
 * a newline that comes before the next magic is an event line; anything else is skipped up to the next magic and
 * reported once as a `resync`. A length that is not a whole number of float32 samples, or is too large, is garbage.
 */
export function createOutputParser(onOut: (o: HelperOutput) => void): { push(chunk: Uint8Array): void } {
  let buf = new Uint8Array(0);
  const take = (n: number): void => {
    buf = buf.subarray(n);
  };
  return {
    push(chunk) {
      if (chunk.length === 0) return;
      const joined = new Uint8Array(buf.length + chunk.length);
      joined.set(buf, 0);
      joined.set(chunk, buf.length);
      buf = joined;
      for (;;) {
        if (buf.length === 0) return;
        // A frame starts here (or may: fewer than 4 bytes that begin the magic).
        const atFrame = buf.length >= 4 ? indexOfMagic(buf.subarray(0, 4), 0) === 0 : magicPrefixAt(buf, 0);
        if (atFrame) {
          if (buf.length < 8) return;
          const len = buf[4]! | (buf[5]! << 8) | (buf[6]! << 16) | (buf[7]! * 0x1000000);
          if (len % 4 !== 0 || len > MAX_AUDIO_FRAME_BYTES) {
            // Not a frame after all: skip this magic and look for the next one.
            const next = indexOfMagic(buf, 1);
            const skip = next < 0 ? buf.length : next;
            onOut({ kind: 'resync', skipped: skip });
            take(skip);
            continue;
          }
          if (buf.length < 8 + len) return;
          // A copy: the payload outlives this chunk (it goes on to the panel page).
          onOut({ kind: 'frame', pcm: buf.slice(8, 8 + len) });
          take(8 + len);
          continue;
        }
        const nl = buf.indexOf(0x0a);
        const m = indexOfMagic(buf, 0);
        if (nl >= 0 && (m < 0 || nl < m)) {
          const text = new TextDecoder().decode(buf.subarray(0, nl)).replace(/\r$/, '').trim();
          take(nl + 1);
          if (text) onOut({ kind: 'line', text });
          continue;
        }
        if (m > 0) {
          onOut({ kind: 'resync', skipped: m });
          take(m);
          continue;
        }
        // No newline and no magic yet: a line still arriving, unless it is far too long to be one.
        if (buf.length > MAX_LINE) {
          let keep = 0;
          for (let k = Math.max(0, buf.length - 3); k < buf.length; k++) {
            if (magicPrefixAt(buf, k)) {
              keep = buf.length - k;
              break;
            }
          }
          onOut({ kind: 'resync', skipped: buf.length - keep });
          take(buf.length - keep);
        }
        return;
      }
    },
  };
}

// ---- the process ----

export interface TableAudioWant {
  /** Mute this VPX (and its tree, PinUP, B2S); null: nothing muted. */
  mutePid: number | null;
  /** Capture this VPX's sound; null: no capture. */
  tapPid: number | null;
}

/** D2.10: a session level wanted on a VPX's tree: `percent` 10–100 of the sessions' own volume. */
export interface TableAudioLevel {
  pid: number;
  percent: number;
}

export interface TableAudioHelper {
  /** Starts the helper if it is not running (idempotent); its availability shows in `status()`. */
  start(): void;
  /** The whole wanted state (mute and tap); starts the helper when needed. */
  apply(want: TableAudioWant): void;
  /** D2.10: set the session volume of `pid`'s tree to `percent` (10–100) until `unlevel`; starts the helper when needed. */
  level(pid: number, percent: number): void;
  /** D2.10: restore the levelled sessions; with a pid, only when that is the pid levelled (a no-op otherwise). */
  unlevel(pid?: number): void;
  status(): TableAudioStatus;
  onStatus(cb: (s: TableAudioStatus) => void): () => void;
  /** Frames while tapping: float32 stereo 48 kHz, 10 ms each. */
  onFrame(cb: (pcm: Uint8Array) => void): () => void;
  /** Unmutes, untaps, ends the helper. */
  stop(): Promise<void>;
}

type Spawn = (cmd: string, args: string[], opts: { windowsHide: boolean; stdio: ['pipe', 'pipe', 'pipe'] }) => ChildProcess;

export interface TableAudioHelperOptions {
  /** From `resolveAudioHelper`; null → `unavailable helper_missing`. */
  exePath: string | null;
  /** `--state`: where the helper records what it muted (a crash recovery); null: none. */
  stateFile: string | null;
  log: (line: string) => void;
  spawn?: Spawn;
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (h: unknown) => void;
}

const NOTHING: TableAudioWant = { mutePid: null, tapPid: null };

export function createTableAudioHelper(opts: TableAudioHelperOptions): TableAudioHelper {
  const sp: Spawn = opts.spawn ?? (nodeSpawn as unknown as Spawn);
  const now = opts.now ?? Date.now;
  const later = opts.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = opts.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const statusListeners = new Set<(s: TableAudioStatus) => void>();
  const frameListeners = new Set<(pcm: Uint8Array) => void>();
  let want: TableAudioWant = { ...NOTHING };
  /** What the running helper was told. */
  let told: TableAudioWant = { ...NOTHING };
  /** D2.10: the level wanted and the one the running helper was told. */
  let wantLevel: TableAudioLevel | null = null;
  let toldLevel: TableAudioLevel | null = null;
  /** D2.10: the helper answered `error unknown_command level` (a 0.1.0 helper): asked no more this run. */
  let levelUnavailable = false;
  let helperVersion: string | null = null;
  let child: ChildProcess | null = null;
  let ready = false;
  let stopping = false;
  let gaveUp: string | null = opts.exePath ? null : 'helper_missing';
  let tapUnavailable: string | null = null;
  let lastSpawn = -Infinity;
  let restartTimer: unknown = null;
  let tapRetry: unknown = null;
  let mutedPid: number | null = null;
  let mutedCount = 0;
  let tapping = false;
  let current: TableAudioStatus = { helper: gaveUp ? 'unavailable' : 'ready', reason: gaveUp, muted: false, tapping: false };
  let missingSaid = false;

  const computed = (): TableAudioStatus => ({
    helper: gaveUp ? 'unavailable' : 'ready',
    reason: gaveUp ?? (tapUnavailable ? `tap_unavailable:${tapUnavailable}` : null),
    muted: !gaveUp && mutedPid !== null && mutedPid === told.mutePid,
    tapping: !gaveUp && tapping,
  });
  const emit = (): void => {
    const s = computed();
    if (s.helper === current.helper && s.reason === current.reason && s.muted === current.muted && s.tapping === current.tapping) return;
    current = s;
    for (const l of [...statusListeners]) l(s);
  };

  const write = (line: string): void => {
    const c = child;
    if (!c || !ready || !c.stdin || c.stdin.destroyed) return;
    c.stdin.write(`${line}\n`);
  };

  /** Tell the helper the difference between what it was told and what is wanted. */
  const sync = (): void => {
    if (!child || !ready) return;
    if (want.mutePid !== told.mutePid) {
      if (told.mutePid !== null) write(`unmute ${told.mutePid}`);
      if (want.mutePid !== null) write(`mute ${want.mutePid}`);
      told = { ...told, mutePid: want.mutePid };
    }
    if (want.tapPid !== told.tapPid) {
      if (want.tapPid === null) write('untap');
      else if (!tapUnavailable) write(`tap ${want.tapPid}`);
      told = { ...told, tapPid: want.tapPid };
    }
    // D2.10: a changed pid restores the old tree first; a changed percent on the same pid is one `level` again.
    if (wantLevel?.pid !== toldLevel?.pid || wantLevel?.percent !== toldLevel?.percent) {
      if (toldLevel && wantLevel?.pid !== toldLevel.pid) write(`unlevel ${toldLevel.pid}`);
      if (wantLevel && !levelUnavailable) write(`level ${wantLevel.pid} ${wantLevel.percent}`);
      toldLevel = wantLevel && !levelUnavailable ? { ...wantLevel } : null;
    }
    emit();
  };

  const onLine = (text: string): void => {
    const [word, a, b] = text.split(/\s+/);
    switch (word) {
      case 'ready':
        ready = true;
        told = { ...NOTHING };
        toldLevel = null;
        helperVersion = a ?? null;
        opts.log(`audio: helper ${helperVersion ?? '(no version)'} ready`);
        sync();
        break;
      case 'muted': {
        const pid = Number(a);
        const n = Number(b);
        if (pid !== mutedPid || n !== mutedCount) opts.log(`audio: muted VPX pid ${pid} (${n} session${n === 1 ? '' : 's'})`);
        mutedPid = pid;
        mutedCount = n;
        break;
      }
      case 'unmuted': {
        const pid = Number(a);
        opts.log(`audio: unmuted VPX pid ${pid} (${Number(b)} session${Number(b) === 1 ? '' : 's'})`);
        if (mutedPid === pid) {
          mutedPid = null;
          mutedCount = 0;
        }
        break;
      }
      case 'tap-on':
        if (!tapping) opts.log(`audio: tap on (VPX pid ${a})`);
        tapping = true;
        break;
      case 'tap-off':
        if (tapping) opts.log('audio: tap off');
        tapping = false;
        break;
      case 'leveled': {
        const n = Number(b);
        opts.log(`audio: my table at ${toldLevel?.percent ?? '?'} % (VPX pid ${Number(a)}, ${n} session${n === 1 ? '' : 's'})`);
        break;
      }
      case 'unleveled': {
        const n = Number(b);
        opts.log(`audio: my table back to its own volume (VPX pid ${Number(a)}, ${n} session${n === 1 ? '' : 's'})`);
        break;
      }
      case 'error':
        if (a === 'unknown_command' && (b === 'level' || b === 'unlevel')) {
          if (!levelUnavailable) opts.log(`audio: this helper (${helperVersion ?? 'unknown version'}) cannot change my table's volume; castcade-audio 0.2.0 or newer does`);
          levelUnavailable = true;
          toldLevel = null;
          break;
        }
        opts.log(`audio: ${text}`);
        break;
      case 'tap-unavailable':
        if (tapUnavailable === null) opts.log(`audio: sending table sound is unavailable here (${a ?? 'unknown'}); muting still works`);
        tapUnavailable = a ?? 'unknown';
        tapping = false;
        break;
      case 'tap-error': {
        opts.log(`audio: tap error: ${a ?? 'unknown'}`);
        tapping = false;
        // Told nothing now: the next sync (in a while) asks again if the tap is still wanted.
        told = { ...told, tapPid: null };
        if (!tapRetry) {
          tapRetry = later(() => {
            tapRetry = null;
            sync();
          }, RESTART_MIN_MS);
        }
        break;
      }
      default:
        opts.log(`audio: ${text}`);
    }
    emit();
  };

  const launch = (): void => {
    if (!opts.exePath || child || stopping || gaveUp) return;
    const args = opts.stateFile ? ['--state', opts.stateFile] : [];
    let c: ChildProcess;
    try {
      c = sp(opts.exePath, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      giveUp(`helper_failed:${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    child = c;
    ready = false;
    lastSpawn = now();
    let sawReady = false;
    let resyncs = 0;
    const parser = createOutputParser((o) => {
      if (child !== c) return;
      if (o.kind === 'frame') {
        if (!tapping) return;
        for (const l of [...frameListeners]) {
          try {
            l(o.pcm);
          } catch {
            // a listener's fault is its own
          }
        }
      } else if (o.kind === 'line') {
        if (o.text.startsWith('ready')) sawReady = true;
        onLine(o.text);
      } else if (resyncs++ === 0) {
        opts.log(`audio: skipped ${o.skipped} unreadable byte(s) from the helper (logged once per run of it)`);
      }
    });
    c.stdin?.on('error', () => {}); // EPIPE when the helper exits first; the exit handler reports it
    c.stdout?.on('data', (b: Buffer) => parser.push(b));
    readLines(c.stderr, (line) => opts.log(line.startsWith('audio:') ? line : `audio: ${line}`));
    let exited = false;
    const onExit = (code: number | null, why: string): void => {
      if (exited) return;
      exited = true;
      if (child !== c) return;
      child = null;
      ready = false;
      told = { ...NOTHING };
      toldLevel = null;
      mutedPid = null;
      mutedCount = 0;
      tapping = false;
      if (stopping) {
        emit();
        return;
      }
      if (!sawReady || code === 2 || code === 64) {
        giveUp(`helper_failed:${code ?? why}`);
        return;
      }
      const wait = Math.max(0, lastSpawn + RESTART_MIN_MS - now());
      opts.log(`audio: helper exited (${why}); restarting in ${Math.round(wait / 100) / 10} s`);
      emit();
      restartTimer = later(() => {
        restartTimer = null;
        launch();
      }, wait);
    };
    c.on('error', (e: NodeJS.ErrnoException) => {
      if (child !== c) return;
      opts.log(`audio: helper failed to start: ${e.message}`);
      child = null;
      exited = true;
      giveUp(e.code === 'ENOENT' ? 'helper_missing' : `helper_failed:${e.code ?? 'spawn'}`);
    });
    c.on('close', (code: number | null, signal: NodeJS.Signals | null) => onExit(code, code !== null ? `code ${code}` : `signal ${signal ?? 'unknown'}`));
  };

  function giveUp(reason: string): void {
    gaveUp = reason;
    if (restartTimer) cancel(restartTimer);
    restartTimer = null;
    opts.log(`audio: table sound unavailable (${reason}); the match goes on with each table's own sound`);
    emit();
  }

  const start = (): void => {
    if (!opts.exePath) {
      if (!missingSaid) {
        missingSaid = true;
        opts.log('audio: no table-sound helper in this build; every rig hears its own table');
      }
      return;
    }
    if (child || restartTimer) return;
    stopping = false;
    launch();
  };

  return {
    start,
    apply(next) {
      want = { mutePid: next.mutePid, tapPid: next.tapPid };
      if (want.mutePid !== null || want.tapPid !== null) start();
      sync();
    },
    level(pid, percent) {
      const pct = Math.min(100, Math.max(10, Math.round(percent)));
      if (!Number.isInteger(pid) || pid <= 0) return;
      if (wantLevel?.pid === pid && wantLevel.percent === pct) return;
      wantLevel = { pid, percent: pct };
      start();
      sync();
    },
    unlevel(pid) {
      if (!wantLevel || (pid !== undefined && wantLevel.pid !== pid)) return;
      wantLevel = null;
      sync();
    },
    status: () => current,
    onStatus(cb) {
      statusListeners.add(cb);
      return () => void statusListeners.delete(cb);
    },
    onFrame(cb) {
      frameListeners.add(cb);
      return () => void frameListeners.delete(cb);
    },
    async stop() {
      want = { ...NOTHING };
      wantLevel = null;
      stopping = true;
      if (restartTimer) cancel(restartTimer);
      if (tapRetry) cancel(tapRetry);
      restartTimer = null;
      tapRetry = null;
      const c = child;
      if (!c) {
        emit();
        return;
      }
      await new Promise<void>((done) => {
        const t = setTimeout(() => {
          c.kill();
          done();
        }, STOP_GRACE_MS);
        c.once('close', () => {
          clearTimeout(t);
          done();
        });
        // The helper unmutes and untaps on EOF; `quit` first says so explicitly.
        if (c.stdin && !c.stdin.destroyed) {
          c.stdin.write('quit\n');
          c.stdin.end();
        }
      });
      child = null;
      emit();
    },
  };
}

function readLines(stream: NodeJS.ReadableStream | null | undefined, cb: (line: string) => void): void {
  let carry = '';
  stream?.on('data', (b: Buffer) => {
    const parts = (carry + b.toString('utf8')).split(/\r?\n/);
    carry = parts.pop() ?? '';
    for (const p of parts) if (p.trim()) cb(p.trim());
  });
  stream?.on('end', () => {
    if (carry.trim()) cb(carry.trim());
    carry = '';
  });
}
