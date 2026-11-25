/**
 * A14 (2026-11-12): one step to a match, with everything outside faked: the match host (a small state the test moves),
 * the witness (a table opens or closes), the launcher (records what it was asked to start), the clipboard and the table
 * lists. No VPX, no Electron, no socket. The same flows over two real match hosts are in `match-host-orderings.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import type { GameFingerprint } from '@castcade/protocol';
import type { ForkIdentity } from '../launch/fork-identity.js';
import type { KnownTable } from '../launch/known-tables.js';
import type { CloseOutcome } from '../launch/vpx-close.js';
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
    /** I11.4.15: the table objects of table files by path (null, or a file not listed: not to be told). Absent: this PC cannot read them (as before I11.4.15). */
    objects?: Record<string, ForkIdentity | null>;
    /** I11.4.15: every read of a file's table objects waits for this. */
    objectsWait?: () => Promise<void>;
    /** I11.4.15: what the store answers when the build's word is kept for a file (the identity it had computed, when another). */
    learnAnswer?: { computed: ForkIdentity } | null;
    /**
     * A17 step 3: `WitnessStatus.gamesSeen` for the open table: true (the witness has evidence that a game on it would
     * be seen), false (basic mode, a partial patch, a machine without its ball ends). Default: not said.
     */
    followed?: boolean;
    /** A17 step 3: the open table has no high-score list a score could be compared with (an original). Default: it has one. */
    noList?: boolean;
    /** A17 step 3: "Change tables for me". Default on. */
    changeTablesForMe?: boolean;
    /** A17 step 3: the scores that have a place on the open table's high-score list. */
    qualifying?: number[];
    /** A17 step 3: false: this Castcade has no closer at all. */
    closer?: boolean;
    /** A17 step 10: what the lobby's PC answers to a pick made on this PC (a sentence: refused). Default: taken. */
    pickRefusal?: string;
    /** A17 step 10: the file the witness names for the open table. */
    openPath?: string;
    /** A17 step 10: this PC's own open table as it says it to the lobby. */
    ownTable?: GameFingerprint;
    autoChangesMax?: number;
  } = {},
) {
  const matchCbs = new Set<(s: MatchStatus) => void>();
  const witnessCbs = new Set<(s: { currentTable: string | null }) => void>();
  const m = { role: 'none' as MatchStatus['role'], phase: 'none' as MatchStatus['phase'], code: null as string | null, invite: null as string | null };
  let hostGame: GameFingerprint | null = null;
  let hostObjects: ForkIdentity | null = null;
  /** A17 step 3: the lobby's table (the pick, `HELLO_ACK.hostGame` in a lobby); null until a test names one with `pick()`. */
  let lobbyPick: GameFingerprint | null = null;
  let open: string | null = null;
  /** A17 step 3: the game on the open table (live mode), the controller's initials hold, the setting, and every close asked for. */
  let game: { inGame: boolean; scores: (number | null)[] } | null = null;
  const gameCbs = new Set<(g: { inGame: boolean; scores: (number | null)[] } | null) => void>();
  let tableHeld = false;
  let changeForMe = o.changeTablesForMe ?? true;
  let followed: boolean | undefined = o.followed;
  /** A17 step 3: how many VPX processes are open (null: one when a table is open, else none), the pid the table is named from, and this PC's stay in the lobby. */
  let vpxOpen: number | null = null;
  let vpxPid: number | null = 4242;
  let stay = 1;
  const closes: Array<{ table: string; pid: number; mayClose: () => boolean; answer: (r: CloseOutcome) => void }> = [];
  /** A17 step 10: every pick made on this PC, and what this PC told the lobby of its way to the lobby's table (each change of it). */
  const picks: Array<{ game: GameFingerprint; objects: ForkIdentity | null; about: string | null }> = [];
  const changes: Array<[string | null, string | null]> = [];
  const noCopy: boolean[] = [];
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
  /** I11.4.15: every launch note with its "not in 3D" flag, the files whose table objects were read, and what was learned. */
  const not3d: boolean[] = [];
  const objectsRead: string[] = [];
  const objectsSignals: AbortSignal[] = [];
  const learned: Array<[string, ForkIdentity]> = [];
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
        // A17 step 9: as match-host.ts `status()`: a member who joined by a code alone (a lobby through ArcAid) has that code as the invite; one who joined by address has none.
        Object.assign(m, { role: 'client', phase: 'lobby', code: invite.slice(-6).toUpperCase(), invite: /^[A-Za-z]{6}$/.test(invite) ? invite.toUpperCase() : null });
        sayMatch();
        return status();
      },
      status,
      onStatus: (cb) => (matchCbs.add(cb), () => void matchCbs.delete(cb)),
      hostGame: () => hostGame,
      wants3d: () => o.wants3d ?? true,
      setLaunchNote: (n, flag) => {
        notes.push(n);
        not3d.push(flag ?? false);
      },
      hostTableObjects: () => hostObjects,
      ...(o.tableLaunch ? { tableLaunch: o.tableLaunch } : {}),
      setNoCopy: (v) => void noCopy.push(v),
      tableHeld: () => tableHeld,
      lobbyTable: () => (lobbyPick ? { game: lobbyPick, joined: `stay ${stay}` } : null),
      pickTable: async (p) => {
        if (o.pickRefusal) throw new Error(o.pickRefusal);
        picks.push({ game: p.game, objects: p.objects, about: p.about ?? null });
        return status();
      },
      ownTable: () => o.ownTable ?? null,
      setTableChange: (state, line) => {
        const last = changes.at(-1);
        if (!last ? state !== null || line !== null : last[0] !== state || last[1] !== line) changes.push([state, line]);
      },
    },
    witness: {
      status: () => ({ currentTable: open, ...(followed !== undefined ? { gamesSeen: open === null ? null : followed } : {}), currentPid: open === null ? null : vpxPid, vpxOpen: vpxOpen ?? (open === null ? 0 : 1), currentIdentity: open !== null && o.openPath ? { filePath: o.openPath } : null }),
      onStatus: (cb) => (witnessCbs.add(cb), () => void witnessCbs.delete(cb)),
      liveGame: () => game,
      onGame: (cb) => (gameCbs.add(cb), () => void gameCbs.delete(cb)),
      highScoreKnown: (score) => (o.noList ? null : (o.qualifying ?? []).includes(score)),
    },
    ...(o.closer === false
      ? {}
      : {
          closer: {
            close: (table: string, pid: number, mayClose: () => boolean = () => true) => new Promise<CloseOutcome>((answer) => void closes.push({ table, pid, mayClose, answer })),
          },
        }),
    changeTablesForMe: () => changeForMe,
    ...(o.autoChangesMax !== undefined ? { autoChangesMax: o.autoChangesMax } : {}),
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
    ...(o.objects
      ? {
          tableObjects: async (path: string, signal?: AbortSignal) => {
            objectsRead.push(path);
            if (signal) objectsSignals.push(signal);
            await o.objectsWait?.();
            if (signal?.aborted) return null;
            return o.objects?.[path] ?? null;
          },
        }
      : {}),
    learnObjects: async (path, id) => {
      learned.push([path, id]);
      return o.learnAnswer ?? null;
    },
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
    closes,
    noCopy,
    picks,
    changes,
    /** A17 step 3: the game on the open table changes (a start, a score, the end; null: no live table). */
    async game(g: { inGame: boolean; scores?: (number | null)[] } | null) {
      game = g ? { inGame: g.inGame, scores: g.scores ?? [] } : null;
      gameCbs.forEach((cb) => cb(game));
      await flush();
    },
    /**
     * A17 step 3: the lobby's table is picked (the engine's pick, as the next HELLO_ACK says it to every member). With
     * no match open that is also what `hostGame()` answers.
     */
    async pick(g: GameFingerprint) {
      lobbyPick = g;
      hostGame = g;
      sayMatch();
      await flush();
    },
    /** A17 step 3: the controller's initials hold goes on or off (a match status says so). */
    async hold(on: boolean) {
      tableHeld = on;
      sayMatch();
      await flush();
    },
    /** A17 step 3: the witness has (or loses) the evidence that a game on the open table would be seen. */
    async follow(next: boolean) {
      followed = next;
      witnessCbs.forEach((cb) => cb({ currentTable: open }));
      await flush();
    },
    /** A17 step 3: how many VPX processes are open, and the pid the witness names the table from (null: not known). */
    async vpx(count: number | null, pid: number | null = 4242) {
      vpxOpen = count;
      vpxPid = pid;
      witnessCbs.forEach((cb) => cb({ currentTable: open }));
      await flush();
    },
    /**
     * A17 step 3: this PC joined the lobby again (a lobby its PC opened again under the same code, a place that ran
     * out, a reconnect): the next word on the lobby's table is the lobby as it is found, with `g` as its table.
     */
    async rejoin(g?: GameFingerprint) {
      stay += 1;
      if (g) {
        lobbyPick = g;
        hostGame = g;
      }
      sayMatch();
      await flush();
    },
    /** A17 step 3: the VPX that was asked has ended (the closer says so); the witness still names its table. */
    async ended(rung: 1 | 2 = 2) {
      closes.at(-1)?.answer({ state: 'closed', rung });
      await flush();
    },
    setChangeForMe(on: boolean) {
      changeForMe = on;
    },
    /** A17 step 3: the open table closes because it was asked to: the witness sees it go, then the closer says so. */
    async closed(rung: 1 | 2 = 2) {
      open = null;
      witnessCbs.forEach((cb) => cb({ currentTable: open }));
      closes.at(-1)?.answer({ state: 'closed', rung });
      await flush();
    },
    /** A17 step 3: this PC is in a lobby without one-step's doing (joined with the code on the Match tab). */
    async as(role: 'client') {
      Object.assign(m, { role, phase: 'lobby', code: 'JHDFEF', invite: null });
      sayMatch();
      await flush();
    },
    launched,
    launches,
    clips,
    logs,
    joins,
    hashed,
    signals,
    notes,
    not3d,
    objectsRead,
    objectsSignals,
    learned,
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
    /** I11.4.15: the host's table objects as HELLO_ACK says them (null: not said). */
    async hostSays(id: ForkIdentity | null) {
      hostObjects = id;
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
      hostObjects = null;
      lobbyPick = null;
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

  // A17 step 9 (design 11.9): the invite is on every member's tab. The fake match gives a member the code as the
  // real one does for a lobby through ArcAid (match-host.ts `status()`), and null for a lobby reached by address.
  it('a client has the link and the chat line', async () => {
    const w = world({ relay: true, arcaid: 'https://arcaid.app' });
    await w.one.joinLink('https://arcaid.app/castcade/join/JHDFEF');
    expect(w.one.status().link).toBe('https://arcaid.app/castcade/join/JHDFEF');
    expect(w.one.status().message).toContain('https://arcaid.app/castcade/join/JHDFEF');
    // Joining put nothing on this person's clipboard; Copy does, when they ask.
    expect(w.clips).toEqual([]);
    w.one.copy('link');
    w.one.copy('message');
    expect(w.clips).toEqual(['https://arcaid.app/castcade/join/JHDFEF', w.one.status().message]);
    // A member of a lobby reached by address has no invite of their own to hand on.
    const direct = world();
    await direct.one.joinLink('castcade://join/castcade%3Aws%3A%2F%2F203.0.113.7%3A27401%23HOSTED');
    expect(direct.one.status().link).toBeNull();
    expect(direct.one.status().message).toBeNull();
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

  // I11.4.15: the match night of 2026-11-23, as the two logs have it. The host's Congo is `904824…`, table objects
  // `769 fc87ddefd36bdd13`; the joining PC has two imported copies, neither the host's bytes: the standard download
  // (the same objects: 3D ran with it) and a Mixed Reality mod (`766 e4b9bf66f04cfcf9`: 2D), opened by hand 15 minutes
  // before, so it was first in the list.
  const HOST_OBJECTS = { editables: 769, hash: 'fc87ddefd36bdd13' };
  const MOD_OBJECTS = { editables: 766, hash: 'e4b9bf66f04cfcf9' };
  const CONGO_HOST = fingerprint('Congo (Williams 1995)', '90'.repeat(32));
  const MR = table('Congo (Williams 1995) MR mod', { sha256: '6d'.repeat(32), lastPlayedAt: '2026-11-23T23:55:00.000Z' });
  const STD = table('Congo (Williams 1995)_VPW_V1.0', { sha256: '34'.repeat(32), lastPlayedAt: '2026-11-20T00:00:00.000Z' });

  it("I11.4.15: two imported copies, neither the host's bytes: the one with the host's table objects is started, not the one played last; nothing warns of a different file", async () => {
    // As 0.2.50 did it (no table objects on this PC): the copy played last, and the warning about the files.
    const before = world({ tables: [MR, STD, AFM] });
    await before.hostTable(CONGO_HOST);
    await before.one.openLink(LINK, { trusted: true });
    expect(before.launched).toEqual([MR.vpxPath]);
    // With them: the standard copy, whichever was played last.
    for (const tables of [[MR, STD, AFM], [STD, MR, AFM]]) {
      const w = world({ tables, objects: { [MR.vpxPath]: MOD_OBJECTS, [STD.vpxPath]: HOST_OBJECTS } });
      await w.hostTable(CONGO_HOST);
      await w.hostSays(HOST_OBJECTS);
      await w.one.openLink(LINK, { trusted: true });
      await flush();
      expect(w.launched).toEqual([STD.vpxPath]);
      // Only the copies of that title were read, never another table.
      expect([...w.objectsRead].sort()).toEqual([MR.vpxPath, STD.vpxPath].sort());
      expect(w.logs).toContain("launch: the table objects of 2 copies of the host's Congo (Williams 1995) (table 769 fc87ddefd36bdd13): 1 the same, 1 other, 0 not to be told");
      expect(w.logs).toContain("launch: Congo (Williams 1995)_VPW_V1.0 is not the host's file and holds the same table objects (table 769 fc87ddefd36bdd13): 3D works with it");
      expect(w.logs).toContain('launch: Congo (Williams 1995)_VPW_V1.0 started (the host plays Congo (Williams 1995): same name, the same table objects)');
      // Nothing for the lobby: no note, and no word that 3D is lost.
      expect(w.notes.filter((n) => n !== null)).toEqual([]);
      expect(w.not3d).not.toContain(true);
      expect(w.logs.some((l) => l.includes('the lobby says the files differ') || l.includes('2D video'))).toBe(false);
    }
  });

  it("I11.4.15: a copy known to hold other table objects is said plainly before the start (2D); another copy on this PC that holds the host's is named, and the imported one is still the one started", async () => {
    // The mod is imported; the standard download sits in the tables folder, never imported.
    const plain = table('Congo (Williams 1995)_VPW_V1.0', { imported: false });
    const w = world({ tables: [MR, AFM], files: [plain], hashes: { [plain.vpxPath]: '34'.repeat(32) }, objects: { [MR.vpxPath]: MOD_OBJECTS, [plain.vpxPath]: HOST_OBJECTS } });
    await w.hostTable(CONGO_HOST);
    await w.hostSays(HOST_OBJECTS);
    await w.one.openLink(LINK, { trusted: true });
    await flush();
    // A match that takes turns comes before 3D (I11.4.11's rule): the imported copy.
    expect(w.launched).toEqual([MR.vpxPath]);
    const NOTE15 = 'For 3D: "Congo (Williams 1995)_VPW_V1.0" on this PC holds the same table objects as the host\'s file and is not imported. Import it in Castcade and rejoin';
    expect(w.notes.at(-1)).toBe(NOTE15);
    expect(w.not3d.at(-1)).toBe(true);
    expect(w.one.status().launch.detail).toContain(NOTE15);
    expect(w.logs).toContain(
      "launch: Congo (Williams 1995) MR mod does not hold the host's table objects (table 766 e4b9bf66f04cfcf9 here, 769 fc87ddefd36bdd13 on the host's PC): the 2D video, not 3D. Congo (Williams 1995)_VPW_V1.0 on this PC holds them and is not imported (Congo (Williams 1995) MR mod is: it reports ball ends). For 3D: import Congo (Williams 1995)_VPW_V1.0 in Castcade and rejoin",
    );
    expect(w.logs).toContain('launch: Congo (Williams 1995) MR mod started (the host plays Congo (Williams 1995): same name, other table objects)');
    await w.leave();
    expect(w.notes.at(-1)).toBeNull();

    // No copy with the host's objects on this PC at all: started all the same, and said (the lobby gets the flag, no remedy).
    const only = world({ tables: [MR], objects: { [MR.vpxPath]: MOD_OBJECTS } });
    await only.hostTable(CONGO_HOST);
    await only.hostSays(HOST_OBJECTS);
    await only.one.openLink(LINK, { trusted: true });
    await flush();
    expect(only.launched).toEqual([MR.vpxPath]);
    expect(only.notes.at(-1)).toBeNull();
    expect(only.not3d.at(-1)).toBe(true);
    expect(only.logs).toContain(
      "launch: Congo (Williams 1995) MR mod does not hold the host's table objects (table 766 e4b9bf66f04cfcf9 here, 769 fc87ddefd36bdd13 on the host's PC): the 2D video, not 3D. No copy of Congo (Williams 1995) on this PC that Castcade looked at holds them",
    );

    // The identical file passed over for an imported copy that holds the host's objects: 3D works, so nothing is named.
    const identical = table('congo host copy', { imported: false, infoName: 'Congo (Williams 1995)', sha256: '90'.repeat(32) });
    const fine = world({ tables: [STD], files: [identical], objects: { [STD.vpxPath]: HOST_OBJECTS, [identical.vpxPath]: HOST_OBJECTS } });
    await fine.hostTable(CONGO_HOST);
    await fine.hostSays(HOST_OBJECTS);
    await fine.one.openLink(LINK, { trusted: true });
    await flush();
    expect(fine.launched).toEqual([STD.vpxPath]);
    expect(fine.notes.filter((n) => n !== null)).toEqual([]);
    expect(fine.not3d).not.toContain(true);
  });

  it("I11.4.15: the identical file needs no table objects (nothing is read, nothing waited for); a copy that cannot be told from its file ranks between, and the old line about the files stands for it; a PC where 3D cannot run reads nothing", async () => {
    const same = table('Congo (Williams 1995) host file', { sha256: '90'.repeat(32) });
    const w = world({ tables: [MR, same], objects: { [MR.vpxPath]: MOD_OBJECTS }, hostHashWaitMs: 3000 });
    await w.hostTable(CONGO_HOST);
    await w.one.openLink(LINK, { trusted: true });
    expect(w.launched).toEqual([same.vpxPath]);
    expect(w.objectsRead).toEqual([]);

    // Two copies: one holds other objects, one cannot be told (a file VPX would name by a memory address): the unknown one.
    const odd = table('Congo (Williams 1995) odd', { sha256: '11'.repeat(32) });
    const u = world({ tables: [MR, odd], objects: { [MR.vpxPath]: MOD_OBJECTS, [odd.vpxPath]: null } });
    await u.hostTable(CONGO_HOST);
    await u.hostSays(HOST_OBJECTS);
    await u.one.openLink(LINK, { trusted: true });
    await flush();
    expect(u.launched).toEqual([odd.vpxPath]);
    expect(u.logs).toContain("launch: the table objects of 2 copies of the host's Congo (Williams 1995) (table 769 fc87ddefd36bdd13): 0 the same, 1 other, 1 not to be told");
    expect(u.logs).toContain("launch: no copy of Congo (Williams 1995) on this PC is the host's file; Congo (Williams 1995) odd is started by its name (the lobby says the files differ)");
    expect(u.not3d).not.toContain(true);

    // No Castcade VPX build beside VPX, or 3D watch off: the table objects buy nothing here; the old order.
    const flat = world({ tables: [MR, STD], objects: { [MR.vpxPath]: MOD_OBJECTS, [STD.vpxPath]: HOST_OBJECTS }, wants3d: false });
    await flat.hostTable(CONGO_HOST);
    await flat.hostSays(HOST_OBJECTS);
    await flat.one.openLink(LINK, { trusted: true });
    await flush();
    expect(flat.objectsRead).toEqual([]);
    expect(flat.launched).toEqual([MR.vpxPath]);

    // More than eight copies: eight are read, and the log says so.
    const many = Array.from({ length: 10 }, (_, i) => table(`Congo (Williams 1995) copy ${i}`, { sha256: String(i).repeat(64) }));
    const m = world({ tables: many, objects: Object.fromEntries(many.map((t) => [t.vpxPath, MOD_OBJECTS])) });
    await m.hostTable(CONGO_HOST);
    await m.hostSays(HOST_OBJECTS);
    await m.one.openLink(LINK, { trusted: true });
    await flush();
    expect(m.objectsRead).toHaveLength(8);
    expect(m.logs).toContain("launch: the table objects of 8 copies of the host's Congo (Williams 1995) (table 769 fc87ddefd36bdd13): 0 the same, 8 other, 0 not to be told; 2 copies more not looked at (8 at most)");
  });

  it("I11.4.15: the host's table objects come a moment after its file hash: the join waits for them (3 s at most from the hash) when the identical file is not here; a host that never says them (an older Castcade) is picked for as before", async () => {
    const w = world({ tables: [MR, STD], objects: { [MR.vpxPath]: MOD_OBJECTS, [STD.vpxPath]: HOST_OBJECTS }, hostHashWaitMs: 3000 });
    // The host's first word: its table's name. 0.6 s later the file hash; 0.5 s after that what the table holds.
    await w.hostTable(fingerprint('Congo (Williams 1995)'));
    await w.one.openLink(LINK, { trusted: true });
    expect(w.launched).toEqual([]);
    w.advance(600);
    await w.hostTable(CONGO_HOST);
    expect(w.launched).toEqual([]);
    expect(w.one.status().launch).toMatchObject({ state: 'waiting_host', detail: "The host's table is open; waiting a moment for what it holds, to start a copy here that 3D works with" });
    expect(w.objectsRead).toEqual([]);
    w.advance(500);
    await w.hostSays(HOST_OBJECTS);
    await flush();
    expect(w.launched).toEqual([STD.vpxPath]);

    // A host from before I11.4.15: nothing comes. 3 s after its hash the table is picked as it always was.
    const old = world({ tables: [MR, STD], objects: { [MR.vpxPath]: MOD_OBJECTS, [STD.vpxPath]: HOST_OBJECTS }, hostHashWaitMs: 3000 });
    await old.hostTable(CONGO_HOST);
    await old.one.openLink(LINK, { trusted: true });
    expect(old.launched).toEqual([]);
    old.advance(2900);
    old.expire();
    await flush();
    expect(old.launched).toEqual([]);
    old.advance(200);
    old.expire();
    await flush();
    expect(old.launched).toEqual([MR.vpxPath]);
    expect(old.objectsRead).toEqual([]);
    expect(old.logs).toContain("launch: the host's Congo (Williams 1995) came with no table objects in 3 s (an older Castcade there, or a file they cannot be told from); the table is picked by its file and name");
    expect(old.logs).toContain("launch: no copy of Congo (Williams 1995) on this PC is the host's file; Congo (Williams 1995) MR mod is started by its name (the lobby says the files differ)");
  });

  it("review of PR #125 (finding 5): one copy of the host's title on this PC: no word of the host's can change the pick, so nothing is waited for; when the host has said what its table holds, the one copy is still read for what the lobby says", async () => {
    // A host from before I11.4.15 (or one that cannot tell): the one copy is started at once, not 3 s later.
    const w = world({ tables: [MR, AFM], objects: { [MR.vpxPath]: MOD_OBJECTS }, hostHashWaitMs: 3000 });
    await w.hostTable(CONGO_HOST);
    await w.one.openLink(LINK, { trusted: true });
    await flush();
    expect(w.launched).toEqual([MR.vpxPath]);
    expect(w.objectsRead).toEqual([]);
    // Nothing was waited for, so the log does not say that something did not come in 3 s.
    expect(w.logs.some((l) => l.includes('came with no table objects'))).toBe(false);
    // Two copies: the wait is there, as before (the host's word decides between them).
    const two = world({ tables: [MR, STD], objects: { [MR.vpxPath]: MOD_OBJECTS, [STD.vpxPath]: HOST_OBJECTS }, hostHashWaitMs: 3000 });
    await two.hostTable(CONGO_HOST);
    await two.one.openLink(LINK, { trusted: true });
    await flush();
    expect(two.launched).toEqual([]);
    // The host's word is already there: the one copy is read (it costs no wait), and its lobby says what it means.
    const said = world({ tables: [MR, AFM], objects: { [MR.vpxPath]: MOD_OBJECTS }, hostHashWaitMs: 3000 });
    await said.hostTable(CONGO_HOST);
    await said.hostSays(HOST_OBJECTS);
    await said.one.openLink(LINK, { trusted: true });
    await flush();
    expect(said.launched).toEqual([MR.vpxPath]);
    expect(said.objectsRead).toEqual([MR.vpxPath]);
    expect(said.not3d.at(-1)).toBe(true);
  });

  it('review of PR #125 (finding 5): the reads of the table objects have 8 s in all: a file that does not come (a sleeping disk, a file that is only in the cloud) does not hold the join; what was read is used, the rest counts as not known, and the log says how many were not looked at', async () => {
    const third = table('Congo (Williams 1995) VR room', { sha256: '77'.repeat(32) });
    let release: () => void = () => undefined;
    const stuck = new Promise<void>((r) => (release = r));
    let asked = 0;
    // The first copy answers; the second never does until the test lets it.
    const w = world({ tables: [STD, MR, third], objects: { [STD.vpxPath]: HOST_OBJECTS, [MR.vpxPath]: MOD_OBJECTS, [third.vpxPath]: HOST_OBJECTS }, objectsWait: () => (++asked >= 2 ? stuck : Promise.resolve()) });
    await w.hostTable(CONGO_HOST);
    await w.hostSays(HOST_OBJECTS);
    await w.one.openLink(LINK, { trusted: true });
    await flush();
    expect(w.launched).toEqual([]);
    expect(w.objectsRead).toEqual([STD.vpxPath, MR.vpxPath]);
    // The deadline is a timer of 8 s from when the reads began.
    expect(w.timers.filter((t) => !t.dead).map((t) => t.ms)).toContain(8000);
    w.expire();
    await flush();
    expect(w.launched).toEqual([STD.vpxPath]);
    expect(w.logs).toContain("launch: the table objects of 1 copy of the host's Congo (Williams 1995) (table 769 fc87ddefd36bdd13): 1 the same, 0 other, 0 not to be told; 2 copies more not looked at (the reads took longer than 8 s)");
    // The read that was under way is not given up (its answer is kept for the next join); it starts no further read
    // and changes nothing when it comes.
    expect(w.objectsSignals.every((x) => !x.aborted)).toBe(true);
    release();
    await flush();
    expect(w.objectsRead).toEqual([STD.vpxPath, MR.vpxPath]);
    expect(w.launched).toEqual([STD.vpxPath]);

    // Nothing was read in time at all: every copy is "not known", and the pick is the old one (the list's order).
    let free: () => void = () => undefined;
    const never = new Promise<void>((r) => (free = r));
    const n = world({ tables: [MR, STD], objects: { [MR.vpxPath]: MOD_OBJECTS, [STD.vpxPath]: HOST_OBJECTS }, objectsWait: () => never });
    await n.hostTable(CONGO_HOST);
    await n.hostSays(HOST_OBJECTS);
    await n.one.openLink(LINK, { trusted: true });
    await flush();
    n.expire();
    await flush();
    expect(n.launched).toEqual([MR.vpxPath]);
    expect(n.logs).toContain("launch: the table objects of 0 copies of the host's Congo (Williams 1995) (table 769 fc87ddefd36bdd13): 0 the same, 0 other, 0 not to be told; 2 copies more not looked at (the reads took longer than 8 s)");
    expect(n.not3d).not.toContain(true);
    free();
    await flush();
    expect(n.launched).toEqual([MR.vpxPath]);
    // A run that finished in time leaves no deadline behind.
    const quick = world({ tables: [MR, STD], objects: { [MR.vpxPath]: MOD_OBJECTS, [STD.vpxPath]: HOST_OBJECTS } });
    await quick.hostTable(CONGO_HOST);
    await quick.hostSays(HOST_OBJECTS);
    await quick.one.openLink(LINK, { trusted: true });
    await flush();
    expect(quick.launched).toEqual([STD.vpxPath]);
    expect(quick.timers.filter((t) => !t.dead && t.ms === 8000)).toEqual([]);
  });

  it('I11.4.15: the reads of the table objects hold nothing up and are given up at once: the join returns while they run; the match ending, a table opened by hand or stop end them', async () => {
    const make = () => {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((r) => (release = r));
      const w = world({ tables: [MR, STD], objects: { [MR.vpxPath]: MOD_OBJECTS, [STD.vpxPath]: HOST_OBJECTS }, objectsWait: () => gate });
      return { w, release };
    };
    const a = make();
    await a.w.hostTable(CONGO_HOST);
    await a.w.hostSays(HOST_OBJECTS);
    await a.w.one.openLink(LINK, { trusted: true });
    expect(a.w.joins).toHaveLength(1);
    expect(a.w.one.status().launch).toMatchObject({ state: 'waiting_host', detail: "Looking at 2 copies of Congo (Williams 1995) on this PC: which holds the same table objects as the host's" });
    expect(a.w.objectsSignals.map((x) => x.aborted)).toEqual([false]);
    await a.w.leave();
    expect(a.w.objectsSignals[0]!.aborted).toBe(true);
    expect(a.w.one.status().launch.state).toBe('idle');
    a.release();
    await flush();
    expect(a.w.launched).toEqual([]);
    // The player opens a table by hand meanwhile: that table is the one.
    const b = make();
    await b.w.hostTable(CONGO_HOST);
    await b.w.hostSays(HOST_OBJECTS);
    await b.w.one.openLink(LINK, { trusted: true });
    await b.w.table('Congo (Williams 1995) MR mod');
    expect(b.w.objectsSignals[0]!.aborted).toBe(true);
    expect(b.w.one.status().launch.state).toBe('running');
    b.release();
    await flush();
    expect(b.w.launched).toEqual([]);
    // stop.
    const c = make();
    await c.w.hostTable(CONGO_HOST);
    await c.w.hostSays(HOST_OBJECTS);
    await c.w.one.openLink(LINK, { trusted: true });
    c.w.one.stop();
    expect(c.w.objectsSignals[0]!.aborted).toBe(true);
    c.release();
    await flush();
    expect(c.w.launched).toEqual([]);
  });

  it("I11.4.15: what the Castcade VPX build says of a table Castcade started in it is kept for that file; a word that contradicts what was computed from the file is in the log", async () => {
    const fork = (said: { editables: number; hash: string } | null): ForkLaunch => ({ options: { exe: 'C:\\vpx\\VPinballX_Castcade.exe', env: {}, what: 'for the match, in the Castcade VPX build' }, didNotStart: Promise.resolve(false), objects: Promise.resolve(said) });
    // A host's own table, and the build agrees with what was computed (or nothing was): kept, nothing said.
    const h = world({ tableLaunch: async () => fork(HOST_OBJECTS) });
    await h.one.host({ ...HOST, tablePath: MB.vpxPath });
    await flush();
    expect(h.learned).toEqual([[MB.vpxPath, HOST_OBJECTS]]);
    expect(h.logs.some((l) => l.includes('reports table'))).toBe(false);
    // A joiner's table, and the build says another identity than the file had computed to.
    const j = world({ tables: [STD], tableLaunch: async () => fork(MOD_OBJECTS), learnAnswer: { computed: HOST_OBJECTS } });
    await j.hostTable(CONGO_HOST);
    await j.one.openLink(LINK, { trusted: true });
    await flush();
    expect(j.learned).toEqual([[STD.vpxPath, MOD_OBJECTS]]);
    expect(j.logs).toContain(
      "launch: the Castcade VPX build reports table 766 e4b9bf66f04cfcf9 for Congo (Williams 1995)_VPW_V1.0; Castcade had computed 769 fc87ddefd36bdd13 from the file. The build's word is kept for this file",
    );
    // A VPX that never said hello (it closed, the start did not take): nothing is kept.
    const n = world({ tableLaunch: async () => fork(null) });
    await n.one.host({ ...HOST, tablePath: MB.vpxPath });
    await flush();
    expect(n.learned).toEqual([]);
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

describe("the lobby's table changes while a table is open here (A17 step 3)", () => {
  const AFM_OPEN = 'Attack from Mars';
  /** A PC in a lobby with a table open: it joined by the link while `open` stood open here and the lobby's table was `first`. */
  const inLobby = async (o: Parameters<typeof world>[0] = {}, open: string | null = AFM_OPEN, first = 'Attack from Mars') => {
    const w = world({ followed: true, ...o });
    if (open !== null) await w.table(open);
    await w.pick(fingerprint(first));
    await w.one.openLink(LINK, { trusted: true });
    return w;
  };
  /** The clock moves and the timers that are due run. */
  const tick = async (w: ReturnType<typeof world>, ms: number): Promise<void> => {
    w.advance(ms);
    w.expire();
    await flush();
  };
  const NOW_MB = "The lobby's table is now Monster Bash.";

  it('another table is open: closed, then started', async () => {
    const took = async (): Promise<ForkLaunch> => ({ options: { exe: 'C:\\vpx\\VPinballX_GL64_castcade.exe', what: 'for the match, in the Castcade VPX build' }, didNotStart: Promise.resolve(false) });
    const w = await inLobby({ tableLaunch: took });
    // At the join nothing changes: the table that was open is kept (the lobby says how it differs).
    expect(w.launched).toEqual([]);
    expect(w.closes).toEqual([]);
    expect(w.one.status().change).toBeNull();
    expect(w.one.status().launch.detail).toBe('Using the table that is already open: Attack from Mars');

    await w.pick(fingerprint('Monster Bash'));
    // The open table is asked to close; nothing is started beside it.
    expect(w.closes.map((c) => c.table)).toEqual([AFM_OPEN]);
    // The process that is asked is the one the witness names the table from.
    expect(w.closes[0]!.pid).toBe(4242);
    expect(w.closes[0]!.mayClose()).toBe(true);
    expect(w.launched).toEqual([]);
    expect(w.one.status().change).toEqual({ state: 'closing', table: 'Monster Bash', open: AFM_OPEN, detail: `${NOW_MB} Closing Attack from Mars; Monster Bash opens next.` });
    // More statuses while it closes ask nothing twice.
    await w.phase('lobby');
    await w.table(AFM_OPEN);
    expect(w.closes).toHaveLength(1);

    await w.closed();
    // Then this PC's copy, the way a match table is started (here: in the Castcade VPX build, as the match host says).
    expect(w.launches).toEqual([{ path: MB.vpxPath, opts: { exe: 'C:\\vpx\\VPinballX_GL64_castcade.exe', what: 'for the match, in the Castcade VPX build' } }]);
    expect(w.one.status().change).toBeNull();
    expect(w.one.status().launch).toMatchObject({ state: 'starting', table: MB.tableId });
    await w.table('Monster Bash (Williams 1998)');
    expect(w.one.status().launch).toEqual({ state: 'running', table: 'Monster Bash (Williams 1998)', detail: null });
    expect(w.closes).toHaveLength(1);
    expect(w.launched).toHaveLength(1);
    expect(w.logs).toContain("launch: the lobby's table changed from Attack from Mars to Monster Bash; Attack from Mars is open on this PC");
  });

  it('a game is running: nothing closes', async () => {
    const w = await inLobby();
    await w.game({ inGame: true });
    await w.pick(fingerprint('Monster Bash'));
    expect(w.closes).toEqual([]);
    expect(w.launched).toEqual([]);
    expect(w.one.status().change).toEqual({ state: 'own_game', table: 'Monster Bash', open: AFM_OPEN, detail: `${NOW_MB} A game is being played on this PC's table: Castcade opens Monster Bash after it.` });
    // Its scores, and every status of the match meanwhile: still nothing.
    await w.game({ inGame: true, scores: [120_000] });
    await w.phase('playing');
    await tick(w, 60_000);
    expect(w.closes).toEqual([]);
    // The game ends: its table is left alone a moment longer (the machine's own ending), then asked to close.
    await w.game({ inGame: false, scores: [1_250_000] });
    expect(w.closes).toEqual([]);
    expect(w.one.status().change?.state).toBe('own_game');
    await tick(w, 2_000);
    expect(w.closes).toEqual([]);
    await tick(w, 1_100);
    expect(w.closes.map((c) => c.table)).toEqual([AFM_OPEN]);
    await w.closed();
    expect(w.launched).toEqual([MB.vpxPath]);
  });

  it('a game that begins after the table was asked to close: nothing more is asked, and the game is waited for', async () => {
    const w = await inLobby();
    await w.pick(fingerprint('Monster Bash'));
    expect(w.closes).toHaveLength(1);
    await w.game({ inGame: true });
    // What the closer asks before its next request.
    expect(w.closes[0]!.mayClose()).toBe(false);
    w.closes[0]!.answer({ state: 'held', asked: true });
    await flush();
    expect(w.one.status().change?.state).toBe('own_game');
    expect(w.launched).toEqual([]);
    await w.game({ inGame: false, scores: [10] });
    await tick(w, 3_100);
    expect(w.closes).toHaveLength(2);
  });

  it('an initials hold, and the window of a finished game: nothing closes', async () => {
    // The match's own hold (the controller: this player's finished game made the machine's high-score list).
    const held = await inLobby();
    await held.hold(true);
    await held.pick(fingerprint('Monster Bash'));
    expect(held.closes).toEqual([]);
    expect(held.one.status().change).toMatchObject({ state: 'own_game', detail: `${NOW_MB} The high-score initials of the last game can still be entered on Attack from Mars: Castcade opens Monster Bash after that, or as soon as you close the table.` });
    await tick(held, 30_000);
    expect(held.closes).toEqual([]);
    await held.hold(false);
    expect(held.closes.map((c) => c.table)).toEqual([AFM_OPEN]);

    // The window of a finished game (A16): this player's last ball is reported and the table's own game is still on
    // (the bonus, the match animation, the initials). Then that game ends with a score that makes the list.
    const w = await inLobby({ qualifying: [82_347_460] });
    await w.game({ inGame: true, scores: [82_347_460] });
    await w.phase('over');
    await w.pick(fingerprint('Monster Bash'));
    expect(w.closes).toEqual([]);
    expect(w.one.status().change?.state).toBe('own_game');
    await w.game({ inGame: false, scores: [82_347_460] });
    await tick(w, 3_100);
    // Past the moment after the game: the score is on the list, so the table stays for the initials.
    expect(w.closes).toEqual([]);
    expect(w.one.status().change?.detail).toMatch(/high-score initials of the last game can still be entered/);
    await tick(w, 60_000);
    expect(w.closes).toEqual([]);
    expect(w.launched).toEqual([]);
    // 90 s after that game's end the wait is over.
    await tick(w, 27_000);
    expect(w.closes.map((c) => c.table)).toEqual([AFM_OPEN]);

    // A game whose score makes no list is waited for no longer than the moment after it.
    const plain = await inLobby({ qualifying: [] });
    await plain.game({ inGame: true });
    await plain.pick(fingerprint('Monster Bash'));
    await plain.game({ inGame: false, scores: [1_000] });
    await tick(plain, 3_100);
    expect(plain.closes).toHaveLength(1);

    // During the wait for the initials the person may close the table themselves: the new one opens then.
    const own = await inLobby({ qualifying: [5_000] });
    await own.game({ inGame: true });
    await own.pick(fingerprint('Monster Bash'));
    await own.game({ inGame: false, scores: [5_000] });
    await tick(own, 3_100);
    expect(own.closes).toEqual([]);
    await own.game(null);
    await own.table(null);
    expect(own.closes).toEqual([]);
    expect(own.launched).toEqual([MB.vpxPath]);
  });

  it('a table Castcade cannot follow (basic mode): never closed, the player is asked', async () => {
    const w = await inLobby({ followed: false });
    await w.pick(fingerprint('Monster Bash'));
    expect(w.closes).toEqual([]);
    expect(w.one.status().change).toEqual({ state: 'close_it', table: 'Monster Bash', open: AFM_OPEN, detail: 'Close the table on this PC: Castcade opens Monster Bash when it is closed.' });
    // Not later either, whatever is said meanwhile.
    await w.phase('lobby');
    await w.table(AFM_OPEN);
    await tick(w, 120_000);
    expect(w.closes).toEqual([]);
    expect(w.launched).toEqual([]);
    // The person closes it: the wish was waiting for the witness to see the table go.
    await w.table(null);
    expect(w.launched).toEqual([MB.vpxPath]);
    expect(w.one.status().change).toBeNull();
    expect(w.closes).toEqual([]);

    // A witness that does not say how it captures the table is a table that is not followed; so is a Castcade with no closer.
    for (const o of [{ followed: undefined }, { closer: false }] as const) {
      const v = await inLobby(o);
      await v.pick(fingerprint('Monster Bash'));
      expect(v.closes).toEqual([]);
      expect(v.one.status().change?.state).toBe('close_it');
    }
  });

  it('still open 15 s after it was asked (the closer gives up): the player is asked, nothing is asked again, and the table opens when it is closed', async () => {
    const w = await inLobby();
    await w.pick(fingerprint('Monster Bash'));
    w.closes[0]!.answer({ state: 'ask', why: '15 s after it was asked to close', asked: true });
    await flush();
    expect(w.one.status().change).toMatchObject({ state: 'close_it', detail: 'Close the table on this PC: Castcade opens Monster Bash when it is closed.' });
    await w.phase('lobby');
    await w.table(AFM_OPEN);
    expect(w.closes).toHaveLength(1);
    expect(w.launched).toEqual([]);
    await w.table(null);
    expect(w.launched).toEqual([MB.vpxPath]);
  });

  it('no copy: nothing closes', async () => {
    const w = await inLobby({ tables: [AFM] });
    await w.pick(fingerprint('Medieval Madness'));
    expect(w.closes).toEqual([]);
    expect(w.launched).toEqual([]);
    expect(w.one.status().change).toBeNull();
    expect(w.one.status().launch).toEqual({
      state: 'needed',
      table: 'Medieval Madness',
      detail: "The lobby's table is now Medieval Madness. Castcade found no copy of it on this PC: you can watch, or open it in VPX if you have it under another name. Attack from Mars stays open.",
    });
    // The lobby is told (this person is not counted for a start), and the table that stands open is not taken for the lobby's.
    expect(w.noCopy.at(-1)).toBe(true);
    await w.table(AFM_OPEN);
    await w.phase('lobby');
    expect(w.one.status().launch.state).toBe('needed');
    expect(w.noCopy.at(-1)).toBe(true);
    // The table under another name, opened by hand: used, and the lobby hears that this PC has one after all.
    await w.table('MM remake');
    expect(w.one.status().launch).toEqual({ state: 'running', table: 'MM remake', detail: null });
    expect(w.noCopy.at(-1)).toBe(false);
    expect(w.closes).toEqual([]);
  });

  it('Change tables for me off: the tab offers Open it and nothing closes or opens by itself', async () => {
    const w = await inLobby({ changeTablesForMe: false });
    await w.pick(fingerprint('Monster Bash'));
    expect(w.closes).toEqual([]);
    expect(w.one.status().change).toEqual({ state: 'offered', table: 'Monster Bash', open: AFM_OPEN, detail: `${NOW_MB} Open it: Castcade closes Attack from Mars and opens Monster Bash.` });
    await tick(w, 60_000);
    expect(w.closes).toEqual([]);
    // Open it: the same rules from here (a game would still be waited for).
    await w.one.openPick();
    expect(w.closes.map((c) => c.table)).toEqual([AFM_OPEN]);
    await w.closed();
    expect(w.launched).toEqual([MB.vpxPath]);

    // The person closes their table without pressing: nothing opens by itself; Open it then starts the table.
    const v = await inLobby({ changeTablesForMe: false });
    await v.pick(fingerprint('Monster Bash'));
    await v.table(null);
    expect(v.launched).toEqual([]);
    expect(v.one.status().change).toEqual({ state: 'offered', table: 'Monster Bash', open: null, detail: NOW_MB });
    await v.one.openPick();
    expect(v.launched).toEqual([MB.vpxPath]);
    expect(v.one.status().change).toBeNull();

    // Nothing open at the change: offered as well; and Open it with nothing waiting does nothing.
    const n = await inLobby({ changeTablesForMe: false, tables: [MB] }, null);
    expect(n.one.status().launch.state).toBe('needed');
    await n.pick(fingerprint('Monster Bash'));
    expect(n.launched).toEqual([]);
    expect(n.one.status().change).toMatchObject({ state: 'offered', open: null });
    await n.one.openPick();
    expect(n.launched).toEqual([MB.vpxPath]);
    await n.one.openPick();
    expect(n.launched).toHaveLength(1);
  });

  it('nothing is open here: the new table is started (with the setting on), also on a PC that was still loading the old one', async () => {
    const w = await inLobby({ tables: [MB] }, null);
    expect(w.one.status().launch.state).toBe('needed');
    await w.pick(fingerprint('Monster Bash'));
    expect(w.launched).toEqual([MB.vpxPath]);
    expect(w.closes).toEqual([]);
    expect(w.noCopy).toEqual([true, false]);

    // VPX was started on the old table and has not shown it yet: the change waits for it, then closes it.
    const s = await inLobby({}, null);
    expect(s.launched).toEqual([AFM.vpxPath]);
    await s.pick(fingerprint('Monster Bash'));
    expect(s.launched).toEqual([AFM.vpxPath]);
    expect(s.closes).toEqual([]);
    await s.table(AFM_OPEN);
    expect(s.closes.map((c) => c.table)).toEqual([AFM_OPEN]);
    await s.closed(1);
    expect(s.launched).toEqual([AFM.vpxPath, MB.vpxPath]);
  });

  it('the open table is itself a copy of the new table: kept, as a table open at the join is', async () => {
    const w = await inLobby({}, 'Monster Bash (Williams 1998)');
    await w.pick(fingerprint('Monster Bash'));
    expect(w.closes).toEqual([]);
    expect(w.launched).toEqual([]);
    expect(w.one.status().change).toBeNull();
    expect(w.one.status().launch).toEqual({ state: 'running', table: 'Monster Bash (Williams 1998)', detail: 'Using the table that is already open: Monster Bash (Williams 1998)' });
    // A file Castcade has in no list, with the game's title (the words before the first bracket): kept as well.
    const v = await inLobby({}, 'Monster Bash (VPW mod 1.2)');
    await v.pick(fingerprint('Monster Bash'));
    expect(v.closes).toEqual([]);
    expect(v.launched).toEqual([]);
    // A hash that arrives for the same name is no change at all.
    await v.pick(fingerprint('Monster Bash', 'cd'.repeat(32)));
    expect(v.closes).toEqual([]);
    expect(v.logs.filter((l) => /the lobby's table changed/.test(l))).toHaveLength(1);
  });

  it('a table opened by hand while the change waits is used; a second change replaces the first; the lobby ending drops it', async () => {
    const w = await inLobby();
    await w.game({ inGame: true });
    await w.pick(fingerprint('Monster Bash'));
    expect(w.one.status().change?.state).toBe('own_game');
    await w.game(null);
    await w.table('Medieval Madness');
    expect(w.one.status().change).toBeNull();
    expect(w.closes).toEqual([]);
    expect(w.launched).toEqual([]);

    // The lobby goes back to the table that is open here before the game ended: nothing to do any more.
    const back = await inLobby();
    await back.game({ inGame: true });
    await back.pick(fingerprint('Monster Bash'));
    await back.pick(fingerprint('Attack from Mars'));
    expect(back.one.status().change).toBeNull();
    await back.game({ inGame: false, scores: [1] });
    await tick(back, 100_000);
    expect(back.closes).toEqual([]);
    expect(back.launched).toEqual([]);

    // The lobby is left while a game was waited for: nothing closes afterwards.
    const gone = await inLobby();
    await gone.game({ inGame: true });
    await gone.pick(fingerprint('Monster Bash'));
    await gone.leave();
    expect(gone.one.status().change).toBeNull();
    await gone.game({ inGame: false, scores: [1] });
    await tick(gone, 100_000);
    expect(gone.closes).toEqual([]);
    expect(gone.launched).toEqual([]);
  });

  it("a match's own table is not the lobby's: a start whose first player has the game under another file name changes nothing", async () => {
    // The pick is Attack from Mars. A match starts, and `hostGame()` is from then on the open table of its first
    // player (MATCH_READY.game): another file name, another hash. Nobody's table is closed for that, and nobody's
    // PC says it has no copy.
    const w = await inLobby();
    await w.phase('playing');
    await w.hostTable(fingerprint('afm_vpw_2.0', 'ef'.repeat(32)));
    await w.phase('paused');
    await w.phase('over');
    await w.hostTable(fingerprint('Attack from Mars'));
    await tick(w, 100_000);
    expect(w.closes).toEqual([]);
    expect(w.launched).toEqual([]);
    expect(w.one.status().change).toBeNull();
    expect(w.noCopy).not.toContain(true);
    expect(w.logs.filter((l) => /the lobby's table changed/.test(l))).toEqual([]);
    // A world that names no pick at all (a match host from before the pick) follows nothing.
    const old = world({ followed: true });
    await old.table(AFM_OPEN);
    await old.hostTable(fingerprint('Attack from Mars'));
    await old.one.openLink(LINK, { trusted: true });
    await old.hostTable(fingerprint('Monster Bash'));
    expect(old.closes).toEqual([]);
    expect(old.launched).toEqual([]);
  });

  it("every PC follows a pick: one that joined with the code, and the lobby's own; a table opened by hand on the lobby's PC is no pick", async () => {
    const c = world({ followed: true });
    await c.table(AFM_OPEN);
    await c.pick(fingerprint('Attack from Mars'));
    await c.as('client');
    expect(c.closes).toEqual([]);
    // During a game too (the statuses of a game are not otherwise looked at).
    await c.phase('playing');
    await c.pick(fingerprint('Monster Bash'));
    expect(c.closes.map((x) => x.table)).toEqual([AFM_OPEN]);

    // The lobby's PC: its first open table is the pick. Another table opened by hand there is its own row's
    // business (the engine keeps the pick), and nothing is closed for it.
    const h = world({ followed: true });
    await h.table(AFM_OPEN);
    await h.one.host({ ...HOST, tablePath: null });
    await h.pick(fingerprint('Attack from Mars'));
    await h.hostTable(fingerprint('Monster Bash'));
    expect(h.closes).toEqual([]);
    expect(h.launched).toEqual([]);
    expect(h.one.status().change).toBeNull();
    // A pick by anyone (step 10 wires it): the lobby's PC closes its table like every other.
    await h.pick(fingerprint('Monster Bash'));
    expect(h.closes.map((x) => x.table)).toEqual([AFM_OPEN]);
    await h.closed();
    expect(h.launched).toEqual([MB.vpxPath]);
  });
});

describe('when Castcade is not sure, it asks the person and closes nothing (A17 step 3, review of PR 137)', () => {
  const AFM_OPEN = 'Attack from Mars';
  const NOW_MB = "The lobby's table is now Monster Bash.";
  const CLOSE_IT = 'Close the table on this PC: Castcade opens Monster Bash when it is closed.';
  const inLobby = async (o: Parameters<typeof world>[0] = {}, open: string | null = AFM_OPEN, first = 'Attack from Mars') => {
    const w = world({ followed: true, ...o });
    if (open !== null) await w.table(open);
    await w.pick(fingerprint(first));
    await w.one.openLink(LINK, { trusted: true });
    return w;
  };
  const tick = async (w: ReturnType<typeof world>, ms: number): Promise<void> => {
    w.advance(ms);
    w.expire();
    await flush();
  };

  it('finding 1: joining again is a join: the lobby is found with another table, nobody picked it, and the open table is kept', async () => {
    // The lobby's PC started again and opened the lobby under its code with the table it then had; this PC came back by itself.
    const w = await inLobby();
    await w.rejoin(fingerprint('Monster Bash'));
    expect(w.closes).toEqual([]);
    expect(w.launched).toEqual([]);
    expect(w.one.status().change).toBeNull();
    expect(w.logs).toContain("launch: this PC joined the lobby again; the lobby's table is Monster Bash (it was Attack from Mars): as at any join, the table that is open here is kept and nothing is closed");
    expect(w.logs.filter((l) => /the lobby's table changed/.test(l))).toEqual([]);
    // A reconnect that finds the same table is a join too, and says less.
    await w.rejoin();
    expect(w.closes).toEqual([]);
    // From here on a pick somebody makes while this PC is in the lobby is a change again.
    await w.pick(fingerprint('Attack from Mars'));
    expect(w.one.status().change).toBeNull();
    expect(w.closes).toEqual([]);
    await w.pick(fingerprint('Monster Bash'));
    // (Attack from Mars is open: the pick before changed nothing, this one does.)
    expect(w.closes.map((c) => c.table)).toEqual([AFM_OPEN]);

    // A lobby found again with no table named yet (its PC has none open): the first one it opens is no change either.
    const v = await inLobby();
    await v.rejoin();
    await v.pick(fingerprint('Monster Bash'));
    expect(v.closes.map((c) => c.table)).toEqual([AFM_OPEN]);
    const u = await inLobby();
    await u.rejoin(fingerprint(NO_TABLE_NAME));
    await u.rejoin(fingerprint('Monster Bash'));
    expect(u.closes).toEqual([]);
    expect(u.one.status().change).toBeNull();
  });

  it('finding 1: a change that was waiting is dropped when this PC joins again, and its open table is kept', async () => {
    const w = await inLobby();
    await w.game({ inGame: true });
    await w.pick(fingerprint('Monster Bash'));
    expect(w.one.status().change?.state).toBe('own_game');
    await w.rejoin();
    expect(w.one.status().change).toBeNull();
    expect(w.logs).toContain('launch: the table change that was waiting on this PC is dropped with it');
    await w.game({ inGame: false, scores: [1] });
    await tick(w, 200_000);
    expect(w.closes).toEqual([]);
    expect(w.launched).toEqual([]);
  });

  it('finding 2: the witness must have evidence that a game would be seen: a table that is only "live" is the person\'s to close, even with no game known', async () => {
    // A partially patched original, a Stern SAM machine, a journal session of an earlier process: the journal is read,
    // no game is ever reported on it, and one may be on.
    const w = await inLobby({ followed: false });
    await w.game({ inGame: false });
    await w.pick(fingerprint('Monster Bash'));
    expect(w.closes).toEqual([]);
    expect(w.one.status().change).toMatchObject({ state: 'close_it', detail: CLOSE_IT });
    expect(w.logs.some((l) => /is a table Castcade cannot follow \(it has no evidence that it would see a game on it\): Castcade does not close it/.test(l))).toBe(true);
    // The evidence arrives (this process's table_loaded is read): then the rules of a followed table hold.
    await w.follow(true);
    expect(w.closes.map((c) => c.table)).toEqual([AFM_OPEN]);
    // And it goes away between the decision and a request: nothing more is asked.
    await w.follow(false);
    expect(w.closes[0]!.mayClose()).toBe(false);
  });

  it('finding 4: the process asked is the one VPX that is open; two VPX open, or none Castcade can name, and the person is asked', async () => {
    const two = await inLobby();
    await two.vpx(2);
    await two.pick(fingerprint('Monster Bash'));
    expect(two.closes).toEqual([]);
    expect(two.one.status().change).toMatchObject({ state: 'close_it', detail: CLOSE_IT });
    expect(two.logs.some((l) => /2 VPX are open on this PC, and Castcade cannot tell which one a person plays on: nothing is asked to close/.test(l))).toBe(true);
    // The other VPX closes: one is left, it is the one with the table, and it is asked by its pid.
    await two.vpx(1, 7001);
    expect(two.closes.map((c) => [c.table, c.pid])).toEqual([[AFM_OPEN, 7001]]);
    // A second VPX is started before the next request: that request is not made.
    await two.vpx(2, 7001);
    expect(two.closes[0]!.mayClose()).toBe(false);
    await two.vpx(1, 7002);
    // Another process holds the table now than the one the request was for.
    expect(two.closes[0]!.mayClose()).toBe(false);

    const unknown = await inLobby();
    await unknown.vpx(1, null);
    await unknown.pick(fingerprint('Monster Bash'));
    expect(unknown.closes).toEqual([]);
    expect(unknown.one.status().change?.state).toBe('close_it');
    expect(unknown.logs.some((l) => /Castcade does not know which VPX process holds Attack from Mars: nothing is asked to close/.test(l))).toBe(true);
  });

  it('finding 5: no list to compare the score with: the table is left for the initials as long as after a score that made the list; the controller\'s hold, once over, ends the wait', async () => {
    // An original: nobody can say whether that score asks for initials.
    const w = await inLobby({ noList: true });
    await w.game({ inGame: true });
    await w.pick(fingerprint('Monster Bash'));
    await w.game({ inGame: false, scores: [1_000] });
    await tick(w, 3_100);
    expect(w.closes).toEqual([]);
    expect(w.one.status().change).toMatchObject({ state: 'own_game', detail: `${NOW_MB} The high-score initials of the last game can still be entered on Attack from Mars: Castcade opens Monster Bash after that, or as soon as you close the table.` });
    await tick(w, 80_000);
    expect(w.closes).toEqual([]);
    // 90 s after the game's end: the same number as the controller's own hold (one constant).
    await tick(w, 7_000);
    expect(w.closes.map((c) => c.table)).toEqual([AFM_OPEN]);

    // A game that is no longer read has no score at all: the same wait.
    const lost = await inLobby();
    await lost.game({ inGame: true });
    await lost.pick(fingerprint('Monster Bash'));
    await lost.game(null);
    await tick(lost, 60_000);
    expect(lost.closes).toEqual([]);
    await tick(lost, 31_000);
    expect(lost.closes).toHaveLength(1);

    // A match game whose score made the list: the controller holds the table, and its hold ending (the initials are
    // in) ends the wait; the 90 s are not sat out on top of it.
    const held = await inLobby({ qualifying: [5_000] });
    await held.game({ inGame: true });
    await held.pick(fingerprint('Monster Bash'));
    await held.game({ inGame: false, scores: [5_000] });
    await held.hold(true);
    await tick(held, 20_000);
    expect(held.closes).toEqual([]);
    await held.hold(false);
    expect(held.closes.map((c) => c.table)).toEqual([AFM_OPEN]);
  });

  it('finding 6: the VPX has ended and the witness still names its table (its close-time capture runs): nothing says "close the table", nothing is asked twice, and the new table starts when the witness is done', async () => {
    const w = await inLobby();
    await w.pick(fingerprint('Monster Bash'));
    await w.ended(1);
    expect(w.one.status().change).toMatchObject({ state: 'closing', detail: `${NOW_MB} Closing Attack from Mars; Monster Bash opens next.` });
    await w.phase('lobby');
    await w.table(AFM_OPEN);
    expect(w.closes).toHaveLength(1);
    expect(w.launched).toEqual([]);
    await w.table(null);
    expect(w.launched).toEqual([MB.vpxPath]);
    expect(w.one.status().change).toBeNull();
  });

  it('finding 7: the lobby\'s table changes and changes back while a request is out: when the table has closed, the lobby\'s table as it is then is opened', async () => {
    const w = await inLobby();
    await w.pick(fingerprint('Monster Bash'));
    expect(w.closes).toHaveLength(1);
    // Back to Attack from Mars, the table that is open: the change is gone, the request is not.
    await w.pick(fingerprint('Attack from Mars'));
    expect(w.one.status().change).toBeNull();
    expect(w.closes[0]!.mayClose()).toBe(false);
    // VPX obeys the request that was already out.
    await w.closed(1);
    expect(w.launched).toEqual([AFM.vpxPath]);
    expect(w.logs.some((l) => /Attack from Mars closed because Castcade had asked it to, for a change to Monster Bash that was taken back meanwhile: the lobby's table as it is now is started/.test(l))).toBe(true);
    expect(w.one.status().launch).toMatchObject({ state: 'starting', table: AFM.tableId });

    // The same when this PC joined again meanwhile (the change is dropped, the request is out).
    const r = await inLobby();
    await r.pick(fingerprint('Monster Bash'));
    await r.rejoin();
    expect(r.one.status().change).toBeNull();
    await r.closed(1);
    expect(r.launched).toEqual([MB.vpxPath]);

    // A request that was answered too late for the closer (15 s) and is obeyed after all, with the change taken back.
    const late = await inLobby();
    await late.pick(fingerprint('Monster Bash'));
    late.closes[0]!.answer({ state: 'ask', why: '15 s after it was asked to close', asked: true });
    await flush();
    await late.pick(fingerprint('Attack from Mars'));
    await late.table(null);
    expect(late.launched).toEqual([AFM.vpxPath]);

    // Nothing was ever sent (the window could not be asked): a table the person closes later is theirs, and nothing opens.
    const none = await inLobby();
    await none.pick(fingerprint('Monster Bash'));
    none.closes[0]!.answer({ state: 'ask', why: 'its window could not be asked', asked: false });
    await flush();
    await none.pick(fingerprint('Attack from Mars'));
    await none.table(null);
    expect(none.launched).toEqual([]);
  });

  it('finding 7: the lobby is left while a request is out: the table closes all the same, and the tab says why', async () => {
    const w = await inLobby();
    await w.pick(fingerprint('Monster Bash'));
    expect(w.closes).toHaveLength(1);
    await w.leave();
    expect(w.closes[0]!.mayClose()).toBe(false);
    expect(w.one.status().notice).toBeNull();
    await w.closed(1);
    expect(w.launched).toEqual([]);
    expect(w.one.status().notice).toBe(
      'Castcade had asked Attack from Mars to close, to open Monster Bash for the lobby. You have left that lobby since, and the request could not be taken back: the table is closed. Open it again in VPX if you want to go on playing.',
    );
    // A table opened by hand after that is nobody's business.
    await w.table('Medieval Madness');
    await w.table(null);
    expect(w.launched).toEqual([]);
  });

  it('finding 9: Change tables for me switched off after the first request: no further request is made, and nothing opens by itself afterwards', async () => {
    const w = await inLobby();
    await w.pick(fingerprint('Monster Bash'));
    expect(w.closes[0]!.mayClose()).toBe(true);
    w.setChangeForMe(false);
    expect(w.closes[0]!.mayClose()).toBe(false);
    // The closer stops there. Nothing was sent yet: the table stays, and the tab offers the change.
    w.closes[0]!.answer({ state: 'held', asked: false });
    await flush();
    expect(w.one.status().change?.state).toBe('offered');
    expect(w.closes).toHaveLength(1);
    // With Open it pressed the setting does not stand in the way.
    await w.one.openPick();
    expect(w.closes).toHaveLength(2);
    expect(w.closes[1]!.mayClose()).toBe(true);
  });

  it('a game that begins while a request is being made: the log says so, whatever becomes of the table', async () => {
    const w = await inLobby();
    await w.pick(fingerprint('Monster Bash'));
    await w.game({ inGame: true });
    expect(w.logs).toContain('launch: a game began on Attack from Mars while Castcade was asking it to close: no further request is made, and one that is already out cannot be taken back (the table then closes under the game)');
  });

  it('a table name from another PC is cleaned before it is logged or shown', async () => {
    const dirty = `Monster\r\n\u0000Bash\u2028 (Williams 1998)\t${'x'.repeat(300)}`;
    /** A control character, a line break or a line separator is in it. */
    const unprintable = (t: string): boolean => [...t].some((c) => c.charCodeAt(0) < 32 || (c.charCodeAt(0) >= 127 && c.charCodeAt(0) <= 159) || c.charCodeAt(0) === 0x2028 || c.charCodeAt(0) === 0x2029);
    // At a join by link (the lobby's table is found from what the other PC says)...
    const j = world({ followed: true, tables: [AFM] });
    await j.pick(fingerprint(dirty));
    await j.one.openLink(LINK, { trusted: true });
    // ...and at a change.
    const w = await inLobby({ tables: [AFM, MB] });
    await w.pick(fingerprint(dirty));
    for (const x of [j, w]) {
      for (const line of x.logs) expect(unprintable(line)).toBe(false);
      const st = x.one.status();
      for (const text of [st.launch.table, st.launch.detail, st.change?.table, st.change?.detail, st.notice]) if (text) expect(unprintable(text)).toBe(false);
    }
    expect(j.one.status().launch).toMatchObject({ state: 'needed' });
    expect(j.one.status().launch.table).toBe(`Monster Bash (Williams 1998) ${'x'.repeat(51)}`);
    // The table is still found from the name as it came: the title before the bracket is Monster Bash.
    expect(w.one.status().change).toMatchObject({ state: 'closing' });
    expect(w.one.status().change?.table).toBe(`Monster Bash (Williams 1998) ${'x'.repeat(51)}`);
    expect(w.logs.some((l) => l.startsWith("launch: the lobby's table changed from Attack from Mars to Monster Bash (Williams 1998) xxx"))).toBe(true);
  });
});

describe("picking the lobby's table, and what a PC says on its way to it (A17 step 10)", () => {
  const AFM_OPEN = 'Attack from Mars';
  const NOW_MB = "The lobby's table is now Monster Bash.";
  const CC: ForkIdentity = { editables: 1203, hash: '00aa11bb22cc33dd' };
  const inLobby = async (o: Parameters<typeof world>[0] = {}, open: string | null = AFM_OPEN, first = 'Attack from Mars') => {
    const w = world({ followed: true, ...o });
    if (open !== null) await w.table(open);
    await w.pick(fingerprint(first));
    await w.one.openLink(LINK, { trusted: true });
    return w;
  };
  const tick = async (w: ReturnType<typeof world>, ms: number): Promise<void> => {
    w.advance(ms);
    w.expire();
    await flush();
  };

  it("the lobby's table changed: this PC follows, and the lobby hears where it stands: closing, opening, then nothing more", async () => {
    const w = await inLobby();
    expect(w.changes).toEqual([]);
    await w.pick(fingerprint('Monster Bash'));
    expect(w.closes.map((c) => c.table)).toEqual([AFM_OPEN]);
    expect(w.changes).toEqual([['closing', `${NOW_MB} Closing Attack from Mars; Monster Bash opens next.`]]);
    await w.closed();
    expect(w.launched).toEqual([MB.vpxPath]);
    // The lobby's table is being opened here: the row says so, and there is nothing for this person to do.
    expect(w.changes.at(-1)).toEqual(['opening', null]);
    await w.table('Monster Bash (Williams 1998)');
    expect(w.changes.at(-1)).toEqual([null, null]);
    expect(w.changes).toHaveLength(3);
  });

  it('Change tables for me off: it asks; a game and a table Castcade cannot follow are said too, with the sentence the headset shows', async () => {
    const off = await inLobby({ changeTablesForMe: false });
    await off.pick(fingerprint('Monster Bash'));
    expect(off.closes).toEqual([]);
    expect(off.changes).toEqual([['offered', `${NOW_MB} Open it: Castcade closes Attack from Mars and opens Monster Bash.`]]);
    await off.one.openPick();
    expect(off.changes.at(-1)?.[0]).toBe('closing');

    const game = await inLobby();
    await game.game({ inGame: true });
    await game.pick(fingerprint('Monster Bash'));
    expect(game.changes).toEqual([['waits_game', `${NOW_MB} A game is being played on this PC's table: Castcade opens Monster Bash after it.`]]);

    const person = await inLobby({ followed: false });
    await person.pick(fingerprint('Monster Bash'));
    expect(person.changes).toEqual([['waits_person', 'Close the table on this PC: Castcade opens Monster Bash when it is closed.']]);
    await person.table(null);
    expect(person.changes.at(-1)).toEqual(['opening', null]);
    // No copy: the lobby hears that through `noCopy`, and this PC has nothing to say of a way to the table.
    const none = await inLobby({ tables: [AFM] });
    await none.pick(fingerprint('Medieval Madness'));
    expect(none.changes).toEqual([]);
    expect(none.noCopy.at(-1)).toBe(true);
  });

  it('a VPX whose table the witness cannot name is not "no table open": the new table is never started beside it, and the person is asked', async () => {
    // Nothing is named open, and a VPX runs (an editor with no table, a VPX the witness cannot read).
    const w = await inLobby({ tables: [MB] }, null);
    expect(w.one.status().launch.state).toBe('needed');
    await w.vpx(1, 7001);
    await w.pick(fingerprint('Monster Bash'));
    expect(w.launched).toEqual([]);
    expect(w.closes).toEqual([]);
    expect(w.one.status().change).toEqual({ state: 'close_it', table: 'Monster Bash', open: null, detail: `${NOW_MB} VPX is open on this PC and Castcade cannot tell which table it has: close VPX, and Castcade opens Monster Bash.` });
    expect(w.changes.at(-1)?.[0]).toBe('waits_person');
    await tick(w, 60_000);
    expect(w.launched).toEqual([]);
    // VPX is closed: the lobby's table is started.
    await w.vpx(0, null);
    expect(w.launched).toEqual([MB.vpxPath]);
    expect(w.one.status().change).toBeNull();

    // The same VPX gets a name instead (the witness reads its table after all): the rules of a named table hold.
    const v = await inLobby({}, null);
    expect(v.launched).toEqual([AFM.vpxPath]);
    await v.table(AFM_OPEN);
    await v.table(null);
    await v.vpx(1, 7002);
    await v.pick(fingerprint('Monster Bash'));
    expect(v.one.status().change?.state).toBe('close_it');
    await v.table('Medieval Madness');
    // Medieval Madness is open, it is followed, no game is on: it is asked to close, by its process.
    expect(v.closes.map((c) => [c.table, c.pid])).toEqual([['Medieval Madness', 7002]]);
    // A join is as it always was: an editor that is open does not keep the link from starting the table.
    const j = world({ followed: true });
    await j.vpx(1, 7003);
    await j.pick(fingerprint('Monster Bash'));
    await j.one.openLink(LINK, { trusted: true });
    expect(j.launched).toEqual([MB.vpxPath]);
  });

  it('after three changes that closed or opened a table by themselves within five minutes the next is only offered, until the person acts', async () => {
    const w = await inLobby();
    const tables = ['Monster Bash', 'Attack from Mars', 'Monster Bash', 'Attack from Mars', 'Monster Bash'];
    const files = ['Monster Bash (Williams 1998)', 'Attack from Mars', 'Monster Bash (Williams 1998)', 'Attack from Mars'];
    // Three changes in a row, a minute apart: each closes the open table and opens the lobby's.
    for (let i = 0; i < 3; i++) {
      await w.pick(fingerprint(tables[i]!));
      expect(w.closes, `change ${i + 1}`).toHaveLength(i + 1);
      // The limit is no reason to stop a change that has begun.
      expect(w.closes[i]!.mayClose()).toBe(true);
      await w.closed();
      await w.table(files[i]!);
      w.advance(60_000);
    }
    expect(w.launched).toHaveLength(3);
    expect(w.logs.some((l) => /this PC has changed tables by itself 3 times in 5 minutes .*the next change of the lobby's table is only offered, until the person acts/.test(l))).toBe(true);
    // The fourth, inside the five minutes: offered, whatever the setting says, and the tab says why.
    await w.pick(fingerprint(tables[3]!));
    expect(w.closes).toHaveLength(3);
    expect(w.one.status().change).toEqual({
      state: 'offered',
      table: 'Attack from Mars',
      open: 'Monster Bash (Williams 1998)',
      detail: "The lobby's table is now Attack from Mars. Open it: Castcade closes Monster Bash (Williams 1998) and opens Attack from Mars. The table has changed several times in a few minutes, so Castcade asks before it changes tables again.",
    });
    expect(w.changes.at(-1)?.[0]).toBe('offered');
    // The person presses Open it: that change is made, and from here Castcade changes tables by itself again.
    await w.one.openPick();
    expect(w.closes).toHaveLength(4);
    await w.closed();
    await w.table(files[3]!);
    await w.pick(fingerprint(tables[4]!));
    expect(w.closes).toHaveLength(5);

    // Changes that are further apart never reach the number.
    const slow = await inLobby();
    for (let i = 0; i < 5; i++) {
      await slow.pick(fingerprint(tables[i]!));
      expect(slow.closes, `change ${i + 1}`).toHaveLength(i + 1);
      await slow.closed();
      await slow.table(i % 2 === 0 ? 'Monster Bash (Williams 1998)' : 'Attack from Mars');
      slow.advance(3 * 60_000);
    }
  });

  it("pick: a table of this PC's own lists becomes the lobby's table: its name as a PC's own row names that file, the file's hash (hashed first when it never was), its ROM, and what the Castcade VPX build says of this copy", async () => {
    const named = table('mb_vpw_1.1', { infoName: 'Monster Bash (Williams 1998)', rom: 'mb_106b' });
    const w = await inLobby({ tables: [named, AFM, MB], hashes: { [named.vpxPath]: 'CD'.repeat(32) }, objects: { [named.vpxPath]: CC, [AFM.vpxPath]: null } });
    const st = await w.one.pick(named.vpxPath, 'JHDFEF-1/1/between');
    expect(st.role).toBe('client');
    expect(w.picks).toEqual([
      {
        game: { kind: 'vpx', tableName: 'Monster Bash (Williams 1998)', tableHash: 'cd'.repeat(32), romName: 'mb_106b', romHash: null, physicsHash: null, recipeVersion: null, sidecarHash: null, emulatorVersion: '' },
        objects: CC,
        about: 'JHDFEF-1/1/between',
      },
    ]);
    expect(w.hashed).toEqual([named.vpxPath]);
    // A table that is already hashed is not read again; one with no ROM, no table name of its own and nothing known
    // of its objects is picked by its file's name and hash.
    await w.one.pick(MB.vpxPath);
    expect(w.picks[1]).toEqual({ game: { ...w.picks[0]!.game, tableName: MB.tableId, tableHash: MB.sha256 }, objects: null, about: null });
    expect(w.hashed).toHaveLength(1);
    // A file that cannot be hashed is picked by its name.
    await w.one.pick(AFM.vpxPath);
    expect(w.picks[2]!.game).toMatchObject({ tableName: 'Attack from Mars', tableHash: ZERO_SHA256, romName: null });
    // Only a table of this PC's own lists: the string is a key into them, never a path.
    await expect(w.one.pick('C:\\Windows\\System32\\calc.exe')).rejects.toThrow('That table is not in the list any more: pick it again');
    expect(w.picks).toHaveLength(3);
    // What the lobby's PC says no to is the sentence the tab shows.
    const no = await inLobby({ pickRefusal: 'A game is being played: the table changes after it.' });
    await expect(no.one.pick(MB.vpxPath)).rejects.toThrow('A game is being played: the table changes after it.');
    // With no lobby there is nothing to pick for.
    const out = world();
    await expect(out.one.pick(MB.vpxPath)).rejects.toThrow('You are not in a lobby.');
  });

  it('pickOpen ("Make <table> the lobby\'s table"): the file the witness names, else a table of that name, else what this PC says of its open table', async () => {
    // By the file the witness names (two copies of one title are on this PC).
    const copy = table('Attack from Mars (copy)', { sha256: 'ef'.repeat(32) });
    const w = await inLobby({ tables: [AFM, copy, MB], openPath: copy.vpxPath.toLowerCase() }, 'Attack from Mars (copy)', 'Monster Bash');
    await w.one.pickOpen('about');
    expect(w.picks).toEqual([{ game: expect.objectContaining({ tableName: 'Attack from Mars (copy)', tableHash: 'ef'.repeat(32) }) as unknown, objects: null, about: 'about' }]);
    // By its name, when the witness names no file.
    const n = await inLobby({}, AFM_OPEN, 'Monster Bash');
    await n.one.pickOpen();
    expect(n.picks[0]!.game.tableName).toBe('Attack from Mars');
    // A table from a folder Castcade does not list: what this PC says of it to the lobby.
    const own = fingerprint('Medieval Madness', 'ab'.repeat(32));
    const f = await inLobby({ ownTable: own }, 'Medieval Madness', 'Monster Bash');
    await f.one.pickOpen();
    expect(f.picks).toEqual([{ game: own, objects: null, about: null }]);
    // Not read yet, or nothing open.
    const early = await inLobby({}, 'Medieval Madness', 'Monster Bash');
    await expect(early.one.pickOpen()).rejects.toThrow(/Castcade cannot make this table the lobby's table yet/);
    const none = await inLobby({}, null, 'Monster Bash');
    await expect(none.one.pickOpen()).rejects.toThrow('No table is open on this PC.');
  });

  it('the picker\'s own PC follows its pick like any other; picking the table that is open here closes nothing', async () => {
    // AFM is open here; this person picks Monster Bash from the list: their own table is asked to close too.
    const w = await inLobby();
    await w.one.pick(MB.vpxPath);
    await w.pick(w.picks[0]!.game);
    expect(w.closes.map((c) => c.table)).toEqual([AFM_OPEN]);
    // The table that is open here, made the lobby's: it is kept.
    const v = await inLobby({}, AFM_OPEN, 'Monster Bash');
    await v.one.pickOpen();
    await v.pick(v.picks[0]!.game);
    expect(v.closes).toEqual([]);
    expect(v.launched).toEqual([]);
    expect(v.one.status().change).toBeNull();
  });
});
