/**
 * A14 (2026-11-12): one step to a match, with everything outside faked: the match host (a small state the test moves),
 * the witness (a table opens or closes), the launcher (records what it was asked to start), the clipboard and the table
 * lists. No VPX, no Electron, no socket. The same flows over two real match hosts are in `match-host-orderings.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import type { GameFingerprint } from '@castcade/protocol';
import type { KnownTable } from '../launch/known-tables.js';
import type { ForkLaunch, LaunchOptions, LaunchResult, VpxLauncher } from '../launch/vpx-launch.js';
import { formatJoinLink } from './deep-link.js';
import type { MatchStatus } from './match-host.js';
import { NO_TABLE_NAME, ZERO_SHA256 } from './match-setup.js';
import { createOneStep, linkJoinFailure } from './one-step.js';

const TABLES = 'C:\\vpx\\tables';
const table = (tableId: string, o: Partial<KnownTable> = {}): KnownTable => ({
  tableId,
  vpxPath: `${TABLES}\\${tableId}.vpx`,
  infoName: null,
  rom: null,
  sha256: null,
  imported: true,
  lastPlayedAt: null,
  patchedAt: null,
  ...o,
});
const MB = table('Monster Bash (Williams 1998)', { sha256: 'ab'.repeat(32), lastPlayedAt: '2026-11-12T00:00:00.000Z', rom: 'mb_106b' });
const AFM = table('Attack from Mars');
const fingerprint = (tableName: string, tableHash = ZERO_SHA256): GameFingerprint => ({
  kind: 'vpx',
  tableName,
  tableHash,
  romName: null,
  romHash: null,
  physicsHash: null,
  recipeVersion: '1',
  sidecarHash: null,
  emulatorVersion: 'x',
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

function world(
  o: {
    tables?: KnownTable[];
    files?: KnownTable[];
    launch?: LaunchResult;
    joinError?: string;
    relay?: boolean;
    arcaid?: string;
    /** I11.4.2: what the match host says about starting a match table (the fork's options, or null); absent: it has no say. */
    tableLaunch?: () => Promise<ForkLaunch | null>;
    /** I11.4.2: the result of a launch that names another exe (the fork). */
    forkLaunch?: LaunchResult;
    /** I11.4.11: the hashes of table files by path (a file not listed cannot be read), and every path asked for. */
    hashes?: Record<string, string>;
    /** I11.4.11: how long a join waits for the host's file hash. Default here 0: the host's fingerprints of these tests carry a name only. */
    hostHashWaitMs?: number;
    /** I11.4.11: 3D can run on this PC (the fork beside VPX, 3D watch on). Default true. */
    wants3d?: boolean;
    /** I11.4.11: every read of a file waits for this (a 300 MB table takes its time). */
    hashWait?: () => Promise<void>;
  } = {},
) {
  const matchCbs = new Set<(s: MatchStatus) => void>();
  const witnessCbs = new Set<(s: { currentTable: string | null }) => void>();
  const m = { role: 'none' as MatchStatus['role'], phase: 'none' as MatchStatus['phase'], code: null as string | null, invite: null as string | null };
  let hostGame: GameFingerprint | null = null;
  let open: string | null = null;
  const launched: string[] = [];
  /** I11.4.2: every launch with the options it was given (null: the plain A14 launch). */
  const launches: Array<{ path: string; opts: LaunchOptions | null }> = [];
  const clips: string[] = [];
  const logs: string[] = [];
  const joins: Array<[string, string]> = [];
  const timers: Array<{ fn: () => void; ms: number; dead: boolean }> = [];
  const hashed: string[] = [];
  const signals: AbortSignal[] = [];
  const notes: Array<string | null> = [];
  let clock = 1_000_000;
  const status = (): MatchStatus => ({ ...m }) as unknown as MatchStatus;
  const launcher: VpxLauncher = {
    async launch(path, opts) {
      launched.push(path);
      launches.push({ path, opts: opts ?? null });
      if (opts?.exe && o.forkLaunch) return o.forkLaunch;
      return o.launch ?? { ok: true, pid: 1 };
    },
  };
  const sayMatch = (): void => matchCbs.forEach((cb) => cb(status()));
  const one = createOneStep({
    match: {
      async host() {
        if (m.role !== 'none') throw new Error('Leave the current match first');
        // D10.8: through ArcAid the invite is the code alone; on the listener it is the address invite.
        Object.assign(m, { role: 'host', phase: 'lobby', code: 'HOSTED', invite: o.relay ? 'HOSTED' : 'castcade:ws://203.0.113.7:27401#HOSTED' });
        hostGame = fingerprint(open ?? NO_TABLE_NAME);
        sayMatch();
        return status();
      },
      async join(invite, name) {
        joins.push([invite, name]);
        if (o.joinError) throw new Error(o.joinError);
        Object.assign(m, { role: 'client', phase: 'lobby', code: invite.slice(-6).toUpperCase(), invite: null });
        sayMatch();
        return status();
      },
      status,
      onStatus: (cb) => (matchCbs.add(cb), () => void matchCbs.delete(cb)),
      hostGame: () => hostGame,
      wants3d: () => o.wants3d ?? true,
      setLaunchNote: (n) => void notes.push(n),
      ...(o.tableLaunch ? { tableLaunch: o.tableLaunch } : {}),
    },
    witness: {
      status: () => ({ currentTable: open }),
      onStatus: (cb) => (witnessCbs.add(cb), () => void witnessCbs.delete(cb)),
    },
    launcher,
    clipboard: { writeText: (t) => void clips.push(t) },
    tables: async () => o.tables ?? [MB, AFM],
    tableFiles: async () => o.files ?? [],
    ...(o.hashes
      ? {
          hashTable: async (path: string, signal?: AbortSignal) => {
            hashed.push(path);
            if (signal) signals.push(signal);
            await o.hashWait?.();
            if (signal?.aborted) return null;
            return o.hashes?.[path] ?? null;
          },
        }
      : {}),
    hostHashWaitMs: o.hostHashWaitMs ?? 0,
    now: () => clock,
    arcaidBaseUrl: () => o.arcaid ?? null,
    log: { info: (l) => void logs.push(l), warn: (l) => void logs.push(l) },
    setTimeout: (fn, ms) => {
      const t = { fn, ms, dead: false };
      timers.push(t);
      return t;
    },
    clearTimeout: (h) => void ((h as { dead: boolean }).dead = true),
  });
  return {
    one,
    launcher,
    launched,
    launches,
    clips,
    logs,
    joins,
    hashed,
    signals,
    notes,
    timers,
    /** The clock of the wait for the host's file hash moves on. */
    advance(ms: number) {
      clock += ms;
    },
    /** The witness sees a table open (or, with null, VPX close). */
    async table(name: string | null) {
      open = name;
      witnessCbs.forEach((cb) => cb({ currentTable: open }));
      await flush();
    },
    /** The host's table as HELLO_ACK says it. */
    async hostTable(g: GameFingerprint | null) {
      hostGame = g;
      sayMatch();
      await flush();
    },
    /** The match's phase moves (a pause while the relay reconnects, the start). */
    async phase(phase: MatchStatus['phase']) {
      m.phase = phase;
      sayMatch();
      await flush();
    },
    async leave() {
      Object.assign(m, { role: 'none', phase: 'none', code: null, invite: null });
      hostGame = null;
      sayMatch();
      await flush();
    },
    /** Run the launch-wait timer, if it is still armed. */
    expire() {
      for (const t of timers.splice(0)) if (!t.dead) t.fn();
    },
  };
}

// `startTable: true` is the one-press Host of 0.2.40 (the setting "Start the table as soon as I host"); A14.7's tests turn it off.
const HOST = { ballsPerGame: 3 as const, displayName: 'Owner', startTable: true };
const LINK = 'castcade://join/JHDFEF';

describe('one step to a match: Host (A14 step 1)', () => {
  it('the table picker lists the known tables as given (most recent first)', async () => {
    const w = world();
    expect(await w.one.tables()).toEqual([
      { path: MB.vpxPath, name: MB.tableId, rom: 'mb_106b', lastPlayedAt: '2026-11-12T00:00:00.000Z', imported: true },
      { path: AFM.vpxPath, name: AFM.tableId, rom: null, lastPlayedAt: null, imported: true },
    ]);
  });

  it('Browse lists the other table files of the tables folder; one of them can be hosted and is started like any other', async () => {
    const raw = table('Dark Chaos', { imported: false });
    const w = world({ files: [raw] });
    expect(await w.one.browse()).toEqual([{ path: raw.vpxPath, name: 'Dark Chaos', rom: null, lastPlayedAt: null, imported: false }]);
    const st = await w.one.host({ ...HOST, tablePath: raw.vpxPath });
    expect(st.role).toBe('host');
    expect(w.launched).toEqual([raw.vpxPath]);
    // Still only this disk's own listing: a path that is in neither list is refused.
    const v = world({ files: [raw] });
    await expect(v.one.host({ ...HOST, tablePath: 'C:\\elsewhere\\Dark Chaos.vpx' })).rejects.toThrow(/not in the list/);
    expect(v.launched).toEqual([]);
  });

  it('D10.8: the join link is built from the relay code when ArcAid carries the match, from the address invite otherwise', async () => {
    const relay = world({ relay: true });
    await relay.one.host({ ...HOST, tablePath: null });
    expect(relay.one.status().link).toBe('castcade://join/HOSTED');
    expect(relay.clips).toEqual(['castcade://join/HOSTED']);
    const direct = world();
    await direct.one.host({ ...HOST, tablePath: null });
    expect(direct.one.status().link).toBe('castcade://join/castcade%3Aws%3A%2F%2F203.0.113.7%3A27401%23HOSTED');
    // A14.2: with an https ArcAid the relay match's link is the clickable web form; an address invite keeps castcade://.
    const web = world({ relay: true, arcaid: 'https://arcaid.app' });
    await web.one.host({ ...HOST, tablePath: null });
    expect(web.one.status().link).toBe('https://arcaid.app/castcade/join/HOSTED');
    expect(web.one.status().message).toBe('Castcade match: https://arcaid.app/castcade/join/HOSTED');
    expect(web.clips).toEqual(['https://arcaid.app/castcade/join/HOSTED']);
    const webDirect = world({ arcaid: 'https://arcaid.app' });
    await webDirect.one.host({ ...HOST, tablePath: null });
    expect(webDirect.one.status().link).toBe('castcade://join/castcade%3Aws%3A%2F%2F203.0.113.7%3A27401%23HOSTED');
    // The web link pasted into the Join box joins like the castcade:// one.
    const guest = world();
    expect((await guest.one.joinLink('https://arcaid.app/castcade/join/JHDFEF')).role).toBe('client');
  });

  it('hosts, puts the join link on the clipboard and starts VPX on the picked table; the table opening ends the wait', async () => {
    const w = world();
    const st = await w.one.host({ ...HOST, tablePath: MB.vpxPath });
    expect(st).toMatchObject({ role: 'host', code: 'HOSTED' });
    const link = formatJoinLink('castcade:ws://203.0.113.7:27401#HOSTED')!;
    expect(w.clips).toEqual([link]);
    expect(w.launched).toEqual([MB.vpxPath]);
    expect(w.one.status()).toMatchObject({
      link,
      copied: true,
      message: `Castcade match on ${MB.tableId}: ${link} (copy the link, then in Castcade press Match, Paste, Join)`,
      launch: { state: 'starting', table: MB.tableId },
    });
    await w.table('Monster Bash');
    expect(w.one.status().launch).toEqual({ state: 'running', table: 'Monster Bash', detail: null });
    // More statuses start nothing more and copy nothing more.
    await w.hostTable(fingerprint('Monster Bash'));
    expect(w.launched).toHaveLength(1);
    expect(w.clips).toHaveLength(1);
    // Copy buttons: the chat line, then the link again.
    w.one.copy('message');
    w.one.copy('link');
    expect(w.clips.slice(1)).toEqual([`Castcade match on Monster Bash: ${link} (copy the link, then in Castcade press Match, Paste, Join)`, link]);
  });

  it('a table that is already open is used: nothing is started, whatever was picked', async () => {
    const w = world();
    await w.table('Medieval Madness');
    await w.one.host({ ...HOST, tablePath: MB.vpxPath });
    expect(w.launched).toEqual([]);
    expect(w.clips).toHaveLength(1);
    expect(w.one.status().launch).toEqual({ state: 'running', table: 'Medieval Madness', detail: 'Using the table that is already open: Medieval Madness' });
    expect(w.one.status().message).toContain('Castcade match on Medieval Madness:');
  });

  it('no pick: hosts and copies the link, starts nothing (the player opens a table, in any order)', async () => {
    const w = world();
    await w.one.host({ ...HOST, tablePath: null });
    expect(w.launched).toEqual([]);
    expect(w.clips).toHaveLength(1);
    expect(w.one.status().launch.state).toBe('idle');
  });

  it('only a table from the list is ever started: a path the renderer made up is refused before anything is hosted', async () => {
    const w = world();
    await expect(w.one.host({ ...HOST, tablePath: 'C:\\Windows\\System32\\calc.exe' })).rejects.toThrow(/not in the list/);
    await expect(w.one.host({ ...HOST, tablePath: `${TABLES}\\Unknown.vpx` })).rejects.toThrow(/not in the list/);
    expect(w.launched).toEqual([]);
    expect(w.clips).toEqual([]);
    expect(w.one.status().link).toBeNull();
  });

  it('VPX that does not start, or never shows the table, is said on the tab and the match stays hosted', async () => {
    const bad = world({ launch: { ok: false, reason: 'the VPX program Castcade remembers is no longer there' } });
    const st = await bad.one.host({ ...HOST, tablePath: MB.vpxPath });
    expect(st.role).toBe('host');
    expect(bad.one.status().launch).toMatchObject({ state: 'failed', detail: expect.stringContaining('Open it in VPX yourself; the match waits.') });

    const slow = world();
    await slow.one.host({ ...HOST, tablePath: MB.vpxPath });
    slow.expire();
    expect(slow.one.status().launch).toMatchObject({ state: 'failed', detail: expect.stringContaining('did not open') });
    // It opened after all: the tab follows.
    await slow.table('Monster Bash');
    expect(slow.one.status().launch.state).toBe('running');
    expect(slow.launched).toHaveLength(1);
  });

  it('leaving the match clears the link and the launch line; a table still starting is not started twice by the next Host', async () => {
    const w = world();
    await w.one.host({ ...HOST, tablePath: MB.vpxPath });
    await w.leave();
    expect(w.one.status()).toMatchObject({ link: null, message: null, copied: false });
    await w.table('Monster Bash');
    await w.one.host({ ...HOST, tablePath: MB.vpxPath });
    expect(w.launched).toHaveLength(1);
    expect(w.clips).toHaveLength(2);
  });
});

describe('a match table in the Castcade VPX build (I11.4.2, §4.4)', () => {
  const FORK = 'C:\\vpx\\VPinballX_GL64_castcade.exe';
  const forkOpts = (): LaunchOptions => ({ exe: FORK, env: { CASTCADE_STREAM: 'match', CASTCADE_STREAM_ADDR: 'listen:127.0.0.1:51000', CASTCADE_STREAM_CONTROL: 'connect:127.0.0.1:51002', CASTCADE_STREAM_SOUND: '0' }, what: 'for the match, in the Castcade VPX build' });
  /** What the match host answers: the options, and (later) whether the start took. `failed` settles `didNotStart`. */
  const fork = (): { launch: ForkLaunch; failed: (v: boolean) => void } => {
    let failed: (v: boolean) => void = () => undefined;
    const didNotStart = new Promise<boolean>((r) => (failed = r));
    return { launch: { options: forkOpts(), didNotStart }, failed };
  };
  const took = async (): Promise<ForkLaunch> => ({ options: forkOpts(), didNotStart: Promise.resolve(false) });

  it("the host's table and a joiner's table start with the options the match host gives (the fork, the stream's variables)", async () => {
    const h = world({ tableLaunch: took });
    await h.one.host({ ...HOST, tablePath: MB.vpxPath });
    expect(h.launches).toEqual([{ path: MB.vpxPath, opts: forkOpts() }]);
    expect(h.one.status().launch).toMatchObject({ state: 'starting', table: MB.tableId });
    const j = world({ tableLaunch: took });
    await j.one.openLink(LINK, { trusted: true });
    await j.hostTable(fingerprint('Monster Bash (Williams 1998)', MB.sha256!));
    expect(j.launches).toEqual([{ path: MB.vpxPath, opts: forkOpts() }]);
  });

  it('nothing to say (the setting off, no fork beside VPX), or no say at all: the plain launch, exactly as before', async () => {
    const none = world({ tableLaunch: async () => null });
    await none.one.host({ ...HOST, tablePath: MB.vpxPath });
    expect(none.launches).toEqual([{ path: MB.vpxPath, opts: null }]);
    const old = world();
    await old.one.host({ ...HOST, tablePath: MB.vpxPath });
    expect(old.launches).toEqual([{ path: MB.vpxPath, opts: null }]);
    // The match host failing to answer is no reason not to start the table.
    const broken = world({ tableLaunch: () => Promise.reject(new Error('no port')) });
    await broken.one.host({ ...HOST, tablePath: MB.vpxPath });
    expect(broken.launches).toEqual([{ path: MB.vpxPath, opts: null }]);
  });

  it('a fork that does not start is said in the log and the table starts in the player\'s own VPX', async () => {
    const w = world({ tableLaunch: took, forkLaunch: { ok: false, reason: 'VPinballX_GL64_castcade.exe is not in C:\\vpx' } });
    await w.one.host({ ...HOST, tablePath: MB.vpxPath });
    expect(w.launches).toEqual([
      { path: MB.vpxPath, opts: forkOpts() },
      { path: MB.vpxPath, opts: null },
    ]);
    expect(w.one.status().launch).toMatchObject({ state: 'starting', table: MB.tableId });
    expect(w.logs).toContain('launch: the Castcade VPX build did not start (VPinballX_GL64_castcade.exe is not in C:\\vpx); starting the table in your own VPX');
  });

  it('I11.4.9: a fork launch that answers "not started" (no process, so no exit ever comes) is said to the match host at once, before the own VPX is started', async () => {
    const order: string[] = [];
    const w = world({
      tableLaunch: async () => ({ options: forkOpts(), didNotStart: new Promise<boolean>(() => undefined), notStarted: () => void order.push('notStarted') }),
      forkLaunch: { ok: false, reason: 'the table file is no longer there' },
    });
    await w.one.host({ ...HOST, tablePath: MB.vpxPath });
    expect(order).toEqual(['notStarted']);
    expect(w.launches.map((l) => l.opts === null)).toEqual([false, true]);
    // A fork that did start is never told so.
    const ok: string[] = [];
    const v = world({ tableLaunch: async () => ({ options: forkOpts(), didNotStart: Promise.resolve(false), notStarted: () => void ok.push('notStarted') }) });
    await v.one.host({ ...HOST, tablePath: MB.vpxPath });
    expect(ok).toEqual([]);
  });

  it('A1: a fork whose start fails after the spawn answered ok (an error from the system, an exe that ends at once): the table starts in the player\'s own VPX', async () => {
    // `launch` says ok as soon as the process is spawned: this is what a real EACCES, or a fork that dies, looks like.
    const f = fork();
    const w = world({ tableLaunch: async () => f.launch });
    await w.one.host({ ...HOST, tablePath: MB.vpxPath });
    expect(w.launches).toEqual([{ path: MB.vpxPath, opts: forkOpts() }]);
    f.failed(true);
    await flush();
    expect(w.launches).toEqual([
      { path: MB.vpxPath, opts: forkOpts() },
      { path: MB.vpxPath, opts: null },
    ]);
    expect(w.logs).toContain('launch: the Castcade VPX build did not start (it ended at once); starting the table in your own VPX');
    // The Match tab still waits for that table, and its opening ends the wait as ever.
    expect(w.one.status().launch).toMatchObject({ state: 'starting', table: MB.tableId });
    await w.table('Monster Bash');
    expect(w.one.status().launch).toMatchObject({ state: 'running' });
  });

  it('A1: a start that took is left alone; one that failed after the match ended, or after a table opened, starts nothing', async () => {
    const ok = fork();
    const a = world({ tableLaunch: async () => ok.launch });
    await a.one.host({ ...HOST, tablePath: MB.vpxPath });
    ok.failed(false);
    await flush();
    expect(a.launches).toHaveLength(1);

    const gone = fork();
    const b = world({ tableLaunch: async () => gone.launch });
    await b.one.host({ ...HOST, tablePath: MB.vpxPath });
    await b.leave();
    gone.failed(true);
    await flush();
    expect(b.launches).toHaveLength(1);

    const opened = fork();
    const c = world({ tableLaunch: async () => opened.launch });
    await c.one.host({ ...HOST, tablePath: MB.vpxPath });
    await c.table('Monster Bash');
    opened.failed(true);
    await flush();
    expect(c.launches).toHaveLength(1);
  });

  it("A1: the player's own VPX not starting either is said on the tab", async () => {
    const f = fork();
    let n = 0;
    const w = world({ tableLaunch: async () => f.launch });
    // The first launch (the fork) is spawned; the second (the plain one) fails outright.
    const real = w.launcher.launch;
    w.launcher.launch = async (path, opts) => (n++ === 0 ? real(path, opts) : (w.launches.push({ path, opts: opts ?? null }), { ok: false, reason: 'the VPX program Castcade remembers is no longer there' }));
    await w.one.host({ ...HOST, tablePath: MB.vpxPath });
    f.failed(true);
    await flush();
    expect(w.launches).toHaveLength(2);
    expect(w.one.status().launch).toMatchObject({ state: 'failed', table: MB.tableId });
    expect(w.one.status().launch.detail).toContain('Open it in VPX yourself; the match waits.');
  });

  it('a table that is already open is used as it is: the match host is not even asked', async () => {
    let asked = 0;
    const w = world({ tableLaunch: async () => (asked++, took()) });
    await w.table('Monster Bash');
    await w.one.host({ ...HOST, tablePath: MB.vpxPath });
    expect(w.launches).toEqual([]);
    expect(asked).toBe(0);
  });
});

describe('the invite before the table (A14.7)', () => {
  const LATER = { ...HOST, startTable: false };

  it('Host gives the invite and starts nothing; Start the table then starts the picked table, once', async () => {
    const w = world({ relay: true, arcaid: 'https://arcaid.app' });
    const st = await w.one.host({ ...LATER, tablePath: MB.vpxPath });
    expect(st).toMatchObject({ role: 'host', code: 'HOSTED' });
    // The link is on the clipboard and on the card; VPX was not asked for anything.
    expect(w.clips).toEqual(['https://arcaid.app/castcade/join/HOSTED']);
    expect(w.launched).toEqual([]);
    expect(w.one.status()).toMatchObject({
      link: 'https://arcaid.app/castcade/join/HOSTED',
      copied: true,
      message: `Castcade match on ${MB.tableId}: https://arcaid.app/castcade/join/HOSTED`,
      tableToStart: MB.tableId,
      launch: { state: 'idle' },
    });
    // Lobby statuses while the host is in Discord (a friend joins, the roster moves) start nothing.
    await w.hostTable(fingerprint(NO_TABLE_NAME));
    await w.phase('lobby');
    expect(w.launched).toEqual([]);
    expect(w.one.status().tableToStart).toBe(MB.tableId);
    // Start the table.
    const s = await w.one.startTable();
    expect(w.launched).toEqual([MB.vpxPath]);
    expect(s).toMatchObject({ tableToStart: null, launch: { state: 'starting', table: MB.tableId } });
    // A second press has nothing left to start.
    await w.one.startTable();
    expect(w.launched).toHaveLength(1);
    await w.table('Monster Bash');
    expect(w.one.status().launch).toEqual({ state: 'running', table: 'Monster Bash', detail: null });
    expect(w.clips).toHaveLength(1);
  });

  it('a table the host opens by hand meanwhile is the one that is used: the button goes and nothing is started', async () => {
    const w = world();
    await w.one.host({ ...LATER, tablePath: MB.vpxPath });
    await w.table('Medieval Madness');
    expect(w.one.status().tableToStart).toBeNull();
    await w.one.startTable();
    expect(w.launched).toEqual([]);
    // Closing it does not bring the held table back.
    await w.table(null);
    expect(w.one.status().tableToStart).toBeNull();
  });

  it('no pick, or a table already open at Host: nothing is held', async () => {
    const none = world();
    await none.one.host({ ...LATER, tablePath: null });
    expect(none.one.status().tableToStart).toBeNull();
    const open = world();
    await open.table('Medieval Madness');
    await open.one.host({ ...LATER, tablePath: MB.vpxPath });
    expect(open.one.status().tableToStart).toBeNull();
    expect(open.launched).toEqual([]);
  });

  it('the match ending drops the held table; the next Host holds its own pick', async () => {
    const w = world();
    await w.one.host({ ...LATER, tablePath: MB.vpxPath });
    await w.leave();
    expect(w.one.status().tableToStart).toBeNull();
    await w.one.startTable();
    expect(w.launched).toEqual([]);
    await w.one.host({ ...LATER, tablePath: AFM.vpxPath });
    expect(w.one.status().tableToStart).toBe(AFM.tableId);
    await w.one.startTable();
    expect(w.launched).toEqual([AFM.vpxPath]);
  });

  it('VPX that does not start from Start the table is said on the tab and the match stays hosted', async () => {
    const w = world({ launch: { ok: false, reason: 'the VPX program Castcade remembers is no longer there' } });
    await w.one.host({ ...LATER, tablePath: MB.vpxPath });
    const s = await w.one.startTable();
    expect(s.launch).toMatchObject({ state: 'failed', detail: expect.stringContaining('Open it in VPX yourself; the match waits.') });
    expect(w.one.status().link).not.toBeNull();
  });
});

describe('one step to a match: a link (A14 step 2)', () => {
  it('trusted (the Match tab was showing): joins with the saved name and starts the same table here', async () => {
    const w = world();
    await w.hostTable(fingerprint('Monster Bash', 'ab'.repeat(32)));
    const s = await w.one.openLink(LINK, { trusted: true });
    expect(w.joins).toEqual([['JHDFEF', '']]);
    expect(w.launched).toEqual([MB.vpxPath]);
    expect(s).toMatchObject({ pending: null, notice: null, attention: 1, launch: { state: 'starting', table: MB.tableId } });
    await w.table('Monster Bash');
    expect(w.one.status().launch.state).toBe('running');
  });

  it('from outside (the app closed, hidden or on another tab): nothing is joined and nothing starts until the player clicks', async () => {
    const w = world();
    await w.hostTable(fingerprint('Monster Bash'));
    const s = await w.one.openLink(formatJoinLink('castcade:ws://203.0.113.7:27401#ABCDEF')!, { trusted: false });
    expect(s).toMatchObject({ pending: { code: 'ABCDEF', address: '203.0.113.7:27401' }, attention: 1 });
    expect(w.joins).toEqual([]);
    expect(w.launched).toEqual([]);
    // Not now: the link is dropped.
    expect(w.one.dismiss().pending).toBeNull();
    await w.one.confirm();
    expect(w.joins).toEqual([]);
    // Again, and this time the click.
    await w.one.openLink(LINK, { trusted: false });
    await w.one.confirm();
    expect(w.joins).toEqual([['JHDFEF', '']]);
    expect(w.launched).toEqual([MB.vpxPath]);
    expect(w.one.status()).toMatchObject({ pending: null, attention: 2 });
  });

  it("joined before the host's table is open: waits, then starts the table once the host's fingerprint names it", async () => {
    const w = world();
    await w.hostTable(fingerprint(NO_TABLE_NAME));
    await w.one.openLink(LINK, { trusted: true });
    expect(w.launched).toEqual([]);
    expect(w.one.status().launch).toMatchObject({ state: 'waiting_host' });
    await w.hostTable(fingerprint('Attack from Mars'));
    expect(w.launched).toEqual([AFM.vpxPath]);
    await w.hostTable(fingerprint('Monster Bash'));
    expect(w.launched).toHaveLength(1);
  });

  it("the wait for the host's table outlasts a pause (the relay reconnecting, its bounded retry): the wish is kept and the table starts when the fingerprint comes", async () => {
    const w = world();
    await w.hostTable(fingerprint(NO_TABLE_NAME));
    await w.one.openLink(LINK, { trusted: true });
    await w.phase('paused');
    await w.phase('lobby');
    expect(w.launched).toEqual([]);
    expect(w.one.status().launch.state).toBe('waiting_host');
    await w.hostTable(fingerprint('Monster Bash', 'ab'.repeat(32)));
    expect(w.launched).toEqual([MB.vpxPath]);
  });

  it("D10.8: a link opened after the match started is told so in the relay's own words, and nothing starts", async () => {
    const locked = 'That match has already started (JHDFEF): only its players can come back to it.';
    const w = world({ joinError: locked });
    await w.hostTable(fingerprint('Monster Bash'));
    const s = await w.one.openLink(LINK, { trusted: true });
    expect(s.notice).toBe(locked);
    expect(w.launched).toEqual([]);
    expect(s.launch.state).toBe('idle');
    expect(linkJoinFailure('ArcAid did not accept this PC: pair it with ArcAid again in Settings, then join.')).toBe('ArcAid did not accept this PC: pair it with ArcAid again in Settings, then join.');
    expect(linkJoinFailure('This PC is no longer paired with ArcAid')).toBe('This PC is no longer paired with ArcAid');
  });

  it('a table already open here is kept: nothing is started; one that opens while waiting for the host ends the wait', async () => {
    const w = world();
    await w.table('Monster Bash');
    await w.hostTable(fingerprint('Monster Bash'));
    await w.one.openLink(LINK, { trusted: true });
    expect(w.launched).toEqual([]);
    expect(w.one.status().launch).toMatchObject({ state: 'running', table: 'Monster Bash' });

    const v = world();
    await v.hostTable(fingerprint(NO_TABLE_NAME));
    await v.one.openLink(LINK, { trusted: true });
    await v.table('Monster Bash');
    await v.hostTable(fingerprint('Monster Bash'));
    expect(v.launched).toEqual([]);
    expect(v.one.status().launch.state).toBe('running');
  });

  it('no copy of the host table here: says which table is needed and stays joined; opening one by hand clears it', async () => {
    const w = world();
    await w.hostTable(fingerprint('Twilight Zone'));
    await w.one.openLink(LINK, { trusted: true });
    expect(w.launched).toEqual([]);
    expect(w.one.status().launch).toMatchObject({ state: 'needed', table: 'Twilight Zone', detail: expect.stringContaining('The host plays Twilight Zone.') });
    expect(w.joins).toHaveLength(1);
    await w.table('TZ by another name');
    expect(w.one.status().launch.state).toBe('running');
  });

  it('a table that was never imported is still found in the tables folder; an imported copy is preferred', async () => {
    const found = table('Twilight Zone (Bally 1993)', { imported: false });
    const w = world({ files: [found] });
    await w.hostTable(fingerprint('Twilight Zone'));
    await w.one.openLink(LINK, { trusted: true });
    expect(w.launched).toEqual([found.vpxPath]);

    const both = world({ files: [table('Attack from Mars (Bally 1995)', { imported: false })] });
    await both.hostTable(fingerprint('Attack from Mars (Bally 1995) 2.0'));
    await both.one.openLink(LINK, { trusted: true });
    expect(both.launched).toEqual([AFM.vpxPath]);
  });

  const HOSTFILE = 'fc'.repeat(32);
  const NOTE = (file: string): string => `For 3D: the host's file is on this PC as "${file}", not imported. Import it in Castcade and rejoin`;

  it('I11.4.11: a table that can report ball ends is never displaced: an imported same-name copy is started although the identical file is here, not imported; the launch and the lobby say which file to import for 3D', async () => {
    // An imported, modified copy (hashed: another file), and the plain download in the tables folder (never hashed).
    const modified = table('Congo (Williams 1995) MR mod', { sha256: '76'.repeat(32) });
    const plain = table('Congo (Williams 1995)_VPW_V1.0', { imported: false });
    const other = table('Congo (Williams 1995) VR room', { imported: false });
    const w = world({ tables: [modified, AFM], files: [other, plain], hashes: { [plain.vpxPath]: HOSTFILE, [other.vpxPath]: '11'.repeat(32) } });
    await w.hostTable(fingerprint('Congo (Williams 1995)', HOSTFILE));
    await w.one.openLink(LINK, { trusted: true });
    await flush();
    // The imported copy: its ball ends are reported, so the match takes turns (in 2D), as it did before.
    expect(w.launched).toEqual([modified.vpxPath]);
    // Only the copies of that title with no hash were read, and no further once the file was found.
    expect(w.hashed).toEqual([other.vpxPath, plain.vpxPath]);
    expect(w.notes.at(-1)).toBe(NOTE('Congo (Williams 1995)_VPW_V1.0'));
    expect(w.one.status().launch.detail).toContain(NOTE('Congo (Williams 1995)_VPW_V1.0'));
    expect(w.logs).toContain("launch: the host's file is on this PC as Congo (Williams 1995)_VPW_V1.0, not imported; Congo (Williams 1995) MR mod (imported: it reports ball ends) is started. For 3D: import Congo (Williams 1995)_VPW_V1.0 in Castcade and rejoin");
    // The note is this match's: it goes with it.
    await w.leave();
    expect(w.notes.at(-1)).toBeNull();
  });

  it('I11.4.11: among imported tables the identical file wins; with no imported copy of the game the identical file wins over another found file', async () => {
    // Two imported copies; the identical one changed since it was read, so nothing knows its hash.
    const modified = table('Congo (Williams 1995) MR mod', { sha256: '76'.repeat(32) });
    const same = table('Congo (Williams 1995)_VPW_V1.0');
    const w = world({ tables: [modified, same], hashes: { [same.vpxPath]: HOSTFILE } });
    await w.hostTable(fingerprint('Congo (Williams 1995)', HOSTFILE));
    await w.one.openLink(LINK, { trusted: true });
    await flush();
    expect(w.launched).toEqual([same.vpxPath]);
    expect(w.notes.filter((n) => n !== null)).toEqual([]);
    expect(w.logs.some((l) => l.includes('started (the host plays Congo (Williams 1995): same file)'))).toBe(true);
    // No imported copy at all (the case that was started "not imported" before): the identical file, not the first by name.
    const other = table('Congo (Williams 1995) VR room', { imported: false });
    const plain = table('Congo (Williams 1995)_VPW_V1.0', { imported: false });
    const f = world({ tables: [AFM], files: [other, plain], hashes: { [plain.vpxPath]: HOSTFILE, [other.vpxPath]: '11'.repeat(32) } });
    await f.hostTable(fingerprint('Congo (Williams 1995)', HOSTFILE));
    await f.one.openLink(LINK, { trusted: true });
    await flush();
    expect(f.launched).toEqual([plain.vpxPath]);
    expect(f.logs.some((l) => l.includes('started (the host plays Congo (Williams 1995): same file, not imported)'))).toBe(true);
  });

  it('I11.4.11: no copy here is the host file: the same-name copy is started as before, and the log says the files differ; a file that cannot be read is passed over; more than eight are not all read, and the log says so', async () => {
    const modified = table('Congo (Williams 1995) MR mod', { sha256: '76'.repeat(32) });
    const broken = table('Congo (Williams 1995) copy', { imported: false });
    const w = world({ tables: [modified], files: [broken], hashes: {} });
    await w.hostTable(fingerprint('Congo (Williams 1995)', HOSTFILE));
    await w.one.openLink(LINK, { trusted: true });
    await flush();
    expect(w.hashed).toEqual([broken.vpxPath]);
    expect(w.launched).toEqual([modified.vpxPath]);
    expect(w.logs).toContain("launch: hashed 0 of 1 copy of the host's Congo (Williams 1995) that had no hash: none is the identical file");
    expect(w.logs).toContain("launch: no copy of Congo (Williams 1995) on this PC is the host's file; Congo (Williams 1995) MR mod is started by its name (the lobby says the files differ)");
    // Ten copies with no hash: eight are read.
    const many = Array.from({ length: 10 }, (_, i) => table(`Congo (Williams 1995) copy ${i}`, { imported: false }));
    const m = world({ tables: [], files: many, hashes: Object.fromEntries(many.map((t, i) => [t.vpxPath, String(i).repeat(64)])) });
    await m.hostTable(fingerprint('Congo (Williams 1995)', HOSTFILE));
    await m.one.openLink(LINK, { trusted: true });
    await flush();
    expect(m.hashed).toHaveLength(8);
    expect(m.logs).toContain("launch: hashed 8 of 8 copies of the host's Congo (Williams 1995) that had no hash: none is the identical file; 2 more copies were not looked at (8 at most)");
  });

  it('I11.4.11: nothing is hashed when a table with the host hash is known already, when the host names no hash, or on a PC where 3D cannot run (nothing is said there either)', async () => {
    const same = table('Congo (Williams 1995)', { sha256: HOSTFILE });
    const copy = table('Congo (Williams 1995) again', { imported: false });
    const known = world({ tables: [same, AFM], files: [copy], hashes: { [copy.vpxPath]: HOSTFILE } });
    await known.hostTable(fingerprint('Congo (Williams 1995)', HOSTFILE));
    await known.one.openLink(LINK, { trusted: true });
    expect(known.hashed).toEqual([]);
    expect(known.launched).toEqual([same.vpxPath]);
    const nameOnly = world({ tables: [AFM], files: [copy], hashes: { [copy.vpxPath]: HOSTFILE } });
    await nameOnly.hostTable(fingerprint('Congo (Williams 1995)'));
    await nameOnly.one.openLink(LINK, { trusted: true });
    expect(nameOnly.hashed).toEqual([]);
    expect(nameOnly.launched).toEqual([copy.vpxPath]);
    // No Castcade VPX build beside VPX, or 3D watch off: the identical file buys nothing here.
    const modified = table('Congo (Williams 1995) MR mod', { sha256: '76'.repeat(32) });
    const flat = world({ tables: [modified], files: [copy], hashes: { [copy.vpxPath]: HOSTFILE }, wants3d: false });
    await flat.hostTable(fingerprint('Congo (Williams 1995)', HOSTFILE));
    await flat.one.openLink(LINK, { trusted: true });
    await flush();
    expect(flat.hashed).toEqual([]);
    expect(flat.launched).toEqual([modified.vpxPath]);
    expect(flat.notes.filter((n) => n !== null)).toEqual([]);
  });

  it('I11.4.11: the reads hold nothing up and are given up at once: the join returns while they run; the match ending, a table opened by hand, a new join or stop abort the read in progress and clear the launch state', async () => {
    const copy = table('Congo (Williams 1995) again', { imported: false });
    const make = () => {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((r) => (release = r));
      const w = world({ tables: [AFM], files: [copy], hashes: { [copy.vpxPath]: HOSTFILE }, hashWait: () => gate });
      return { w, release };
    };
    // The match ends while the file is read.
    const a = make();
    await a.w.hostTable(fingerprint('Congo (Williams 1995)', HOSTFILE));
    // The join comes back to its caller with the read still running (a 300 MB file takes seconds).
    await a.w.one.openLink(LINK, { trusted: true });
    expect(a.w.joins).toHaveLength(1);
    expect(a.w.one.status().launch).toMatchObject({ state: 'waiting_host' });
    expect(a.w.one.status().launch.detail).toBe("Looking for the host's file among 1 copy of Congo (Williams 1995) on this PC");
    expect(a.w.signals.map((x) => x.aborted)).toEqual([false]);
    await a.w.leave();
    expect(a.w.signals[0]!.aborted).toBe(true);
    expect(a.w.one.status().launch.state).toBe('idle');
    a.release();
    await flush();
    expect(a.w.launched).toEqual([]);
    // The player opens a table by hand meanwhile: that table is the one, and the read is given up.
    const b = make();
    await b.w.hostTable(fingerprint('Congo (Williams 1995)', HOSTFILE));
    await b.w.one.openLink(LINK, { trusted: true });
    await b.w.table('Congo (Williams 1995) MR mod');
    expect(b.w.signals[0]!.aborted).toBe(true);
    expect(b.w.one.status().launch.state).toBe('running');
    b.release();
    await flush();
    expect(b.w.launched).toEqual([]);
    // stop.
    const c = make();
    await c.w.hostTable(fingerprint('Congo (Williams 1995)', HOSTFILE));
    await c.w.one.openLink(LINK, { trusted: true });
    c.w.one.stop();
    expect(c.w.signals[0]!.aborted).toBe(true);
    c.release();
    await flush();
    expect(c.w.launched).toEqual([]);
  });

  it("I11.4.11: the host's table is named a moment before its file is hashed: the join waits for the hash (3 s at most) instead of picking by name at once", async () => {
    const modified = table('Congo (Williams 1995) MR mod', { sha256: '76'.repeat(32) });
    const same = table('Congo (Williams 1995)_VPW_V1.0', { sha256: HOSTFILE });
    const w = world({ tables: [modified, same], hostHashWaitMs: 3000 });
    // The host's first word: the file's name, no hash yet.
    await w.hostTable(fingerprint('Congo (Williams 1995)_VPW_V1.0'));
    await w.one.openLink(LINK, { trusted: true });
    expect(w.launched).toEqual([]);
    expect(w.one.status().launch).toMatchObject({ state: 'waiting_host' });
    // Its second, 0.4 s later: the TableInfo name and the hash. The identical file is started, not the first by name.
    w.advance(400);
    await w.hostTable(fingerprint('Congo (Williams 1995)', HOSTFILE));
    expect(w.launched).toEqual([same.vpxPath]);

    // A host whose file is never hashed (its witness cannot read it): after 3 s the table is looked for by name.
    const never = world({ tables: [modified], hostHashWaitMs: 3000 });
    await never.hostTable(fingerprint('Congo (Williams 1995)'));
    await never.one.openLink(LINK, { trusted: true });
    expect(never.launched).toEqual([]);
    never.advance(3001);
    never.expire();
    await flush();
    expect(never.launched).toEqual([modified.vpxPath]);
    expect(never.logs).toContain("launch: the host's Congo (Williams 1995) came with no file hash in 3 s; the table is looked for by name");
  });

  it("the host's fingerprint is only compared, never run: a path in the table name starts nothing", async () => {
    const w = world();
    await w.hostTable(fingerprint('C:\\Windows\\System32\\calc.exe'));
    await w.one.openLink(LINK, { trusted: true });
    expect(w.launched).toEqual([]);
    expect(w.one.status().launch.state).toBe('needed');
  });

  it('a link for a match that is gone says so; a refusal says why; nothing starts', async () => {
    const gone = world({ joinError: 'Could not reach the host at 203.0.113.7:27401 (no answer in 10 s). Check the invite, and that the host forwarded the TCP port to their PC.' });
    const s = await gone.one.openLink(LINK, { trusted: true });
    expect(s.notice).toMatch(/^That match is gone or cannot be reached: ask the host for a new link\./);
    expect(gone.launched).toEqual([]);
    expect(linkJoinFailure('The host refused: the match has started')).toBe('Could not join that match. The host refused: the match has started');
    // D10.8: an answer that already says what to do is passed on as it is; a code ArcAid does not know is a match that is gone.
    const notPaired = 'This invite goes through ArcAid, and this PC is not paired with ArcAid yet: pair it in Settings, or ask the host for a direct invite (castcade:ws://…).';
    expect(linkJoinFailure(notPaired)).toBe(notPaired);
    expect(linkJoinFailure('No match with the code JHDFEF: check the code with the host (a match that ended, or whose host has been gone for a while, is closed).')).toMatch(/^That match is gone or cannot be reached/);
    // A refused connection is a match that is gone, not a refusal by the host; a stack never reaches the player.
    expect(linkJoinFailure('Error: connect ECONNREFUSED 203.0.113.7:27401\n    at TCPConnectWrap.afterConnect (node:net:1637:16). Check the invite.')).toBe(
      'That match is gone or cannot be reached: ask the host for a new link. (connect ECONNREFUSED 203.0.113.7:27401)',
    );
    // From the confirmation click too.
    await gone.one.openLink(LINK, { trusted: false });
    expect((await gone.one.confirm()).notice).toMatch(/^That match is gone/);
  });

  it('text that is not a join link is ignored with a line; a link while in a match joins nothing', async () => {
    const w = world();
    for (const bad of ['castcade://join/JHDFEF --no-sandbox', 'castcade://run/calc', 'castcade://join/..%2F..%2Fx']) {
      expect((await w.one.openLink(bad, { trusted: true })).notice).toBe('That link is not a Castcade match link.');
    }
    expect(w.joins).toEqual([]);
    await w.one.openLink(LINK, { trusted: true });
    expect((await w.one.openLink(LINK, { trusted: true })).notice).toBe('You are already in this match.');
    expect((await w.one.openLink('castcade://join/ABCDEF', { trusted: false })).notice).toBe('That link is for another match: leave this one first, then open the link again.');
    expect(w.one.status().pending).toBeNull();
    expect(w.joins).toHaveLength(1);
  });

  it('the match ending while VPX is still to be started drops the wish; a link pasted on the Match tab joins at once and throws what went wrong', async () => {
    const w = world();
    await w.hostTable(fingerprint(NO_TABLE_NAME));
    await w.one.openLink(LINK, { trusted: true });
    await w.leave();
    await w.hostTable(fingerprint('Monster Bash'));
    expect(w.launched).toEqual([]);
    expect(w.one.status().launch.state).toBe('idle');

    const st = await w.one.joinLink(' castcade://join/JHDFEF ');
    expect(st.role).toBe('client');
    expect(w.launched).toEqual([MB.vpxPath]);
    await expect(w.one.joinLink('castcade://join/nope')).rejects.toThrow(/not a Castcade match link/);
    await expect(w.one.joinLink(LINK)).rejects.toThrow('You are already in this match.');
  });
});
