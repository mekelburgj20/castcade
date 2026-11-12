/**
 * A14 (2026-11-12): one step to a match, with everything outside faked: the match host (a small state the test moves),
 * the witness (a table opens or closes), the launcher (records what it was asked to start), the clipboard and the table
 * lists. No VPX, no Electron, no socket. The same flows over two real match hosts are in `match-host-orderings.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import type { GameFingerprint } from '@castcade/protocol';
import type { KnownTable } from '../launch/known-tables.js';
import type { LaunchResult } from '../launch/vpx-launch.js';
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

function world(o: { tables?: KnownTable[]; files?: KnownTable[]; launch?: LaunchResult; joinError?: string } = {}) {
  const matchCbs = new Set<(s: MatchStatus) => void>();
  const witnessCbs = new Set<(s: { currentTable: string | null }) => void>();
  const m = { role: 'none' as MatchStatus['role'], phase: 'none' as MatchStatus['phase'], code: null as string | null, invite: null as string | null };
  let hostGame: GameFingerprint | null = null;
  let open: string | null = null;
  const launched: string[] = [];
  const clips: string[] = [];
  const logs: string[] = [];
  const joins: Array<[string, string]> = [];
  const timers: Array<{ fn: () => void; ms: number; dead: boolean }> = [];
  const status = (): MatchStatus => ({ ...m }) as unknown as MatchStatus;
  const sayMatch = (): void => matchCbs.forEach((cb) => cb(status()));
  const one = createOneStep({
    match: {
      async host() {
        if (m.role !== 'none') throw new Error('Leave the current match first');
        Object.assign(m, { role: 'host', phase: 'lobby', code: 'HOSTED', invite: 'castcade:ws://203.0.113.7:27401#HOSTED' });
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
    },
    witness: {
      status: () => ({ currentTable: open }),
      onStatus: (cb) => (witnessCbs.add(cb), () => void witnessCbs.delete(cb)),
    },
    launcher: {
      async launch(path) {
        launched.push(path);
        return o.launch ?? { ok: true, pid: 1 };
      },
    },
    clipboard: { writeText: (t) => void clips.push(t) },
    tables: async () => o.tables ?? [MB, AFM],
    tableFiles: async () => o.files ?? [],
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
    launched,
    clips,
    logs,
    joins,
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

const HOST = { ballsPerGame: 3 as const, displayName: 'Owner' };
const LINK = 'castcade://join/JHDFEF';

describe('one step to a match: Host (A14 step 1)', () => {
  it('the table picker lists the known tables as given (most recent first)', async () => {
    const w = world();
    expect(await w.one.tables()).toEqual([
      { path: MB.vpxPath, name: MB.tableId, rom: 'mb_106b', lastPlayedAt: '2026-11-12T00:00:00.000Z' },
      { path: AFM.vpxPath, name: AFM.tableId, rom: null, lastPlayedAt: null },
    ]);
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
