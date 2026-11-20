/**
 * I11.4.2: the state stream inside a match, as one PC decides it (`stream3d.ts`), with a scripted fork: the lines of
 * the control connection as §3 of docs/design/state-stream-in-match.md writes them, every row of the §4.3 table, every
 * fail-safe, the capability exchange, and the turn lock that waits for `state playing`. Time is a manual clock.
 */
import { describe, expect, it } from 'vitest';
import { ManualClock } from './clock.js';
import { CAPS_CHANGES_MAX, CONTROL_LINE_MAX, FORK_HELLO_WAIT_MS, FORK_LOG_MAX, PLAY_WAIT_MS, QUIET_LOG_MS, START_WAIT_MS, Stream3d, WATCH_TIMEOUT_MS, decide, decodeCaps, encodeCaps, forLog, parseControlLine, viewWords, watchCommand, type ForkInfo } from './stream3d.js';

const HELLO = 'hello 1 10.8.0.2078.castcade 617 9f3a61c2d4e5b701 50001';
const TABLE = '617 9f3a61c2d4e5b701';
const BUILD = '10.8.0.2078.castcade';
const SAME: ForkInfo = { build: BUILD, table: TABLE };
const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function rig(o: { aim?: (peer: string) => Promise<number>; name?: (id: string) => string } = {}) {
  const clock = new ManualClock();
  const sent: string[] = [];
  const logs: string[] = [];
  const aims: string[] = [];
  const ports: Array<number | null> = [];
  const caps: string[] = [];
  let connected = false;
  let changes = 0;
  const m = new Stream3d({
    log: (l) => void logs.push(l),
    send: (line) => {
      if (!connected) return false;
      sent.push(line);
      return true;
    },
    aim:
      o.aim ??
      (async (peer) => {
        aims.push(peer);
        return 50_002;
      }),
    setPlayerPort: (p) => void ports.push(p),
    setCaps: (c) => void caps.push(c),
    onChange: () => void changes++,
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeout: (h) => clock.clearTimeout(h),
    name: o.name ?? ((id) => ({ a: 'Owner', b: 'Krobs', c: 'Chuck' })[id] ?? id),
    now: () => clock.now(),
  });
  const fork = {
    connect(): void {
      connected = true;
      m.forkConnected();
    },
    say(...lines: string[]): void {
      for (const l of lines) m.forkLine(l);
    },
    drop(why = 'VPX closed it'): void {
      connected = false;
      m.forkDisconnected(why);
    },
    /** The fork as a good table start: connects, says hello and its first `state playing`. */
    up(): void {
      fork.connect();
      fork.say(HELLO, 'state playing');
    },
  };
  return { m, clock, sent, logs, aims, ports, caps, fork, changes: () => changes };
}

/** A PC with its fork up (its hello names stream port 50001), in a match with `peers`, each of whom said the same table. */
async function inMatch(peers: string[] = ['b'], o: Parameters<typeof rig>[0] = {}) {
  const r = rig(o);
  r.m.setPeers(peers);
  r.fork.up();
  for (const p of peers) r.m.peerCaps(p, encodeCaps(SAME));
  await flush();
  return r;
}

describe('the control connection, as read (§3)', () => {
  it('reads the four lines exactly', () => {
    expect(parseControlLine(HELLO)).toEqual({ kind: 'hello', version: 1, build: BUILD, editables: '617', tableHash: '9f3a61c2d4e5b701', streamPort: 50_001 });
    expect(parseControlLine('hello 1 b 1 h 65535')).toMatchObject({ streamPort: 65_535 });
    // Port 0: a fork with no stream listener (as the fork is built: "0: it has none").
    expect(parseControlLine('hello 1 b 1 h 0')).toMatchObject({ kind: 'hello', version: 1, streamPort: 0 });
    // Any reason is a reason: the ones the fork has today, and one it does not have yet.
    for (const reason of ['refused', 'timeout', 'stalled', 'lost', 'closed', 'badaddress', 'overflow', 'something-new-in-2027']) {
      expect(parseControlLine(`state failed ${reason}`)).toEqual({ kind: 'failed', reason });
    }
    expect(parseControlLine('state playing')).toEqual({ kind: 'state', state: 'playing' });
    expect(parseControlLine('state watching')).toEqual({ kind: 'state', state: 'watching' });
    expect(parseControlLine('state failed table mismatch: 617 editables here, 615 there')).toEqual({ kind: 'failed', reason: 'table mismatch: 617 editables here, 615 there' });
    expect(parseControlLine('state failed')).toEqual({ kind: 'failed', reason: '' });
    // One carriage return before the newline is let go (a Windows writer).
    expect(parseControlLine('state playing\r')).toEqual({ kind: 'state', state: 'playing' });
  });

  it('refuses everything else', () => {
    for (const bad of [
      '',
      'state',
      'state paused',
      'state  playing',
      ' state playing',
      'state playing ',
      'STATE PLAYING',
      'state failedtoday',
      'hello',
      'hello one b 1 2',
      'hello 1',
      'hello 1 build 617',
      'hello 1 build 617 hash extra',
      // Rule 9: the fifth field is the stream port, a port.
      'hello 1 build 617 hash',
      'hello 1 build 617 hash 65536',
      'hello 1 build 617 hash 050001',
      'hello 1 build 617 hash 50001 more',
      'hello 1 build 617 hash -1',
      'hello 1  617 hash',
      'hello 1 build 617 ha\tsh',
      'play',
      'watch 127.0.0.1:1',
      'state playing\u0000',
      `state failed ${'x'.repeat(CONTROL_LINE_MAX)}`,
    ]) {
      expect(parseControlLine(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('a hello of another version is read for its version only, whatever follows it', () => {
    expect(parseControlLine('hello 2 build 617 hash and more fields')).toEqual({ kind: 'hello', version: 2, build: '', editables: '', tableHash: '', streamPort: 0 });
    expect(parseControlLine('hello 0')).toEqual({ kind: 'hello', version: 0, build: '', editables: '', tableHash: '', streamPort: 0 });
  });

  it('writes the two commands exactly', () => {
    expect(watchCommand(50_002)).toBe('watch 127.0.0.1:50002');
    expect(() => watchCommand(0)).toThrow();
    expect(() => watchCommand(70_000)).toThrow();
  });
});

describe('what a PC says about itself, and the decision (§4.2)', () => {
  it('the capability text round-trips; junk is nothing said', () => {
    expect(decodeCaps(encodeCaps(SAME))).toEqual(SAME);
    expect(decodeCaps(encodeCaps(null))).toBe('none');
    for (const bad of [null, '', 'x', '{}', '{"v":2,"fork":null}', '{"v":1}', '{"v":1,"fork":{"build":"b"}}', '{"v":1,"fork":{"build":"","table":"t"}}', '{"v":1,"fork":"none"}', `{"v":1,"fork":{"build":"b","table":"${'t'.repeat(400)}"}}`]) {
      expect(decodeCaps(bad), String(bad)).toBeNull();
    }
    // A6: a build and a table identity are tokens of printable ASCII, as in hello: nothing else is read (or logged).
    const caps = (build: string, table: string): string => JSON.stringify({ v: 1, fork: { build, table } });
    for (const [build, table] of [
      ['10.8.0\nstream3d: forged line', TABLE],
      ['two words', TABLE],
      [BUILD, '617'],
      [BUILD, '617  9f3a'],
      [BUILD, '617 9f3a extra'],
      [BUILD, '617 9f3a\u2028'],
      [BUILD, `617 ${'h'.repeat(129)}`],
      ['b\u0085', TABLE],
    ] as const) {
      expect(decodeCaps(caps(build, table)), JSON.stringify([build, table])).toBeNull();
    }
  });

  it('3D only when the setting allows, both VPX are the Castcade build and both name the same table', () => {
    expect(decide({ setting: 'auto', own: SAME, peer: SAME })).toEqual({ mode: '3d' });
    // Another build on the same table is still 3D here: the stream's own HELLO check is the judge of that.
    expect(decide({ setting: 'auto', own: SAME, peer: { build: 'other', table: TABLE } })).toEqual({ mode: '3d' });
    expect(decide({ setting: 'off', own: SAME, peer: SAME })).toEqual({ mode: '2d', why: 'off' });
    expect(decide({ setting: 'auto', own: null, peer: SAME })).toEqual({ mode: '2d', why: 'no_fork_here' });
    expect(decide({ setting: 'auto', own: 'version', peer: SAME })).toEqual({ mode: '2d', why: 'fork_version' });
    expect(decide({ setting: 'auto', own: SAME, peer: null })).toEqual({ mode: '2d', why: 'not_connected' });
    expect(decide({ setting: 'auto', own: SAME, peer: 'none' })).toEqual({ mode: '2d', why: 'no_fork_there' });
    expect(decide({ setting: 'auto', own: SAME, peer: { build: BUILD, table: '615 9f3a61c2d4e5b701' } })).toEqual({ mode: '2d', why: 'other_table' });
  });

  it('says each in plain words', () => {
    expect(viewWords({ mode: '3d' })).toBe('3D, on your own table');
    expect(viewWords({ mode: '2d', why: 'off' })).toBe('the 2D video (3D watch is turned off on this PC)');
    expect(viewWords({ mode: '2d', why: 'no_fork_here' })).toBe('the 2D video (no Castcade VPX build runs the table on this PC)');
    expect(viewWords({ mode: '2d', why: 'no_fork_there' })).toBe('the 2D video (no Castcade VPX build runs the table on their PC)');
    expect(viewWords({ mode: '2d', why: 'other_table' })).toBe('the 2D video (theirs is another table file)');
    expect(viewWords({ mode: '2d', why: 'failed', detail: 'table mismatch' })).toBe('the 2D video this turn (3D did not start: table mismatch)');
  });
});

describe('the turn (§4.3)', () => {
  it('row 1: this PC is up or holds its table: the fork is on its own table, nothing is sent, the others may watch it', async () => {
    const r = await inMatch();
    // The lobby, this player's own turn, between games, the initials hold: the shell names nobody.
    r.m.setTarget(null);
    expect(r.sent).toEqual([]);
    expect(r.aims).toEqual([]);
    expect(r.ports.at(-1)).toBe(50_001);
    expect(r.m.status()).toMatchObject({ fork: 'ready', state: 'playing', target: null, showing3d: false, build: BUILD, table: TABLE });
    expect(r.m.away()).toBe(false);
  });

  it('row 2: another player is up and 3D is possible: the tunnel is aimed at them, the fork is told to watch, the headset shows no theater picture', async () => {
    const r = await inMatch();
    r.m.setTarget('b');
    // No theater picture from the decision on (the row of the table), before the fork has answered.
    expect(r.m.showing3d()).toBe(true);
    await flush();
    expect(r.aims).toEqual(['b']);
    expect(r.sent).toEqual(['watch 127.0.0.1:50002']);
    expect(r.m.status()).toMatchObject({ state: 'entering', target: 'b', showing3d: true });
    r.fork.say('state watching');
    expect(r.m.status()).toMatchObject({ state: 'watching', target: 'b', showing3d: true, peers: { b: { mode: '3d' } } });
    // Nothing more is sent while the turn lasts, and nothing times out.
    r.clock.advance(60_000);
    expect(r.sent).toEqual(['watch 127.0.0.1:50002']);
    expect(r.m.showing3d()).toBe(true);
    expect(r.logs).toContain("stream3d: watch 127.0.0.1:50002: VPX is sent to watch Krobs's table");
    expect(r.logs).toContain("stream3d: VPX: state watching: Krobs's table is on screen in 3D");
  });

  it('row 2, the next player up: a second watch re-aims, with no play between', async () => {
    const r = await inMatch(['b', 'c']);
    r.m.setTarget('b');
    await flush();
    r.fork.say('state watching');
    r.m.setTarget('c');
    expect(r.m.showing3d()).toBe(true);
    await flush();
    expect(r.aims).toEqual(['b', 'c']);
    expect(r.sent).toEqual(['watch 127.0.0.1:50002', 'watch 127.0.0.1:50002']);
    expect(r.m.status().state).toBe('entering');
    r.fork.say('state watching');
    expect(r.m.status()).toMatchObject({ state: 'watching', target: 'c', showing3d: true });
    expect(r.logs).toContain("stream3d: watch 127.0.0.1:50002: VPX is re-aimed at Chuck's table");
  });

  it('row 1 after row 2: the turn comes to this PC: play, and the fork is on its own table again', async () => {
    const r = await inMatch();
    r.m.setTarget('b');
    await flush();
    r.fork.say('state watching');
    r.m.setTarget(null);
    expect(r.sent).toEqual(['watch 127.0.0.1:50002', 'play']);
    expect(r.m.status()).toMatchObject({ state: 'leaving', showing3d: false });
    r.fork.say('state playing');
    expect(r.m.status()).toMatchObject({ state: 'playing', showing3d: false });
    expect(r.m.away()).toBe(false);
  });

  it('row 3: another player is up and 3D is not possible: the fork stays on its own table, whatever the reason', async () => {
    const cases: Array<[string, (r: ReturnType<typeof rig>) => void, string]> = [
      ['the setting is off', (r) => r.m.setSetting('off'), 'off'],
      ['their PC has no fork', (r) => r.m.peerCaps('b', encodeCaps(null)), 'no_fork_there'],
      ['nothing heard from their PC', (r) => r.m.peerCaps('b', null), 'not_connected'],
      ['another table file', (r) => r.m.peerCaps('b', encodeCaps({ build: BUILD, table: '615 0000000000000001' })), 'other_table'],
    ];
    for (const [what, make, why] of cases) {
      const r = await inMatch();
      make(r);
      r.m.setTarget('b');
      await flush();
      expect(r.sent, what).toEqual([]);
      expect(r.aims, what).toEqual([]);
      expect(r.m.status(), what).toMatchObject({ state: 'playing', showing3d: false, peers: { b: { mode: '2d', why } } });
    }
  });

  it('a three-player match where one PC has no fork: the two with it watch each other in 3D; the third is shown in 2D', async () => {
    // This PC (a) and b run the build; c does not.
    const r = await inMatch(['b', 'c']);
    r.m.peerCaps('c', encodeCaps(null));
    expect(r.m.status().peers).toEqual({ b: { mode: '3d' }, c: { mode: '2d', why: 'no_fork_there' } });
    r.m.setTarget('b');
    await flush();
    r.fork.say('state watching');
    expect(r.m.showing3d()).toBe(true);
    // c is up: the fork is called back and the theater shows c's video.
    r.m.setTarget('c');
    expect(r.sent).toEqual(['watch 127.0.0.1:50002', 'play']);
    expect(r.m.showing3d()).toBe(false);
    r.fork.say('state playing');
    // b again.
    r.m.setTarget('b');
    await flush();
    expect(r.sent.at(-1)).toBe('watch 127.0.0.1:50002');
    expect(r.logs).toContain('stream3d: Chuck: this PC shows the 2D video (no Castcade VPX build runs the table on their PC)');
    expect(r.logs).toContain('stream3d: Krobs: this PC shows 3D, on your own table');
  });

  it('the setting turned off during a watch calls the fork back; back on auto the watch starts again', async () => {
    const r = await inMatch();
    r.m.setTarget('b');
    await flush();
    r.fork.say('state watching');
    r.m.setSetting('off');
    expect(r.sent.at(-1)).toBe('play');
    expect(r.m.showing3d()).toBe(false);
    r.fork.say('state playing');
    r.m.setSetting('auto');
    await flush();
    expect(r.sent).toEqual(['watch 127.0.0.1:50002', 'play', 'watch 127.0.0.1:50002']);
  });

  it("what a PC says arrives late (the data connection took a minute): the watch begins in the middle of the turn; their connection closing ends it", async () => {
    const r = rig();
    r.m.setPeers(['b']);
    r.fork.up();
    r.m.setTarget('b');
    await flush();
    expect(r.sent).toEqual([]);
    expect(r.m.status().peers).toEqual({ b: { mode: '2d', why: 'not_connected' } });
    r.m.peerCaps('b', encodeCaps(SAME));
    await flush();
    expect(r.sent).toEqual(['watch 127.0.0.1:50002']);
    r.fork.say('state watching');
    r.m.peerCaps('b', null);
    expect(r.sent.at(-1)).toBe('play');
    expect(r.m.showing3d()).toBe(false);
  });
});

describe('the fail-safes (§4.3 row 3)', () => {
  it('state failed: the 2D video this turn, no play is sent (the fork goes back by itself), the next turn tries again', async () => {
    const r = await inMatch();
    r.m.setTarget('b');
    await flush();
    r.fork.say('state failed table mismatch: 617 editables here, 615 there');
    expect(r.m.status()).toMatchObject({ showing3d: false, state: 'leaving', peers: { b: { mode: '2d', why: 'failed', detail: 'table mismatch: 617 editables here, 615 there' } } });
    expect(r.sent).toEqual(['watch 127.0.0.1:50002']);
    r.fork.say('state playing');
    expect(r.m.status().state).toBe('playing');
    // Nothing is tried again while the same player is up.
    r.clock.advance(60_000);
    await flush();
    expect(r.sent).toEqual(['watch 127.0.0.1:50002']);
    expect(r.logs).toContain('stream3d: 3D watch of Krobs did not work (table mismatch: 617 editables here, 615 there); the 2D video serves this turn');
    // This PC's own turn, then b again: a fresh try.
    r.m.setTarget(null);
    r.m.setTarget('b');
    await flush();
    expect(r.sent).toEqual(['watch 127.0.0.1:50002', 'watch 127.0.0.1:50002']);
    expect(r.m.status().peers).toEqual({ b: { mode: '3d' } });
  });

  it('no state watching within 5 s: play, and the 2D video this turn', async () => {
    const r = await inMatch();
    r.m.setTarget('b');
    await flush();
    r.clock.advance(WATCH_TIMEOUT_MS - 1);
    expect(r.m.showing3d()).toBe(true);
    expect(r.sent).toEqual(['watch 127.0.0.1:50002']);
    r.clock.advance(1);
    expect(r.sent).toEqual(['watch 127.0.0.1:50002', 'play']);
    expect(r.m.status()).toMatchObject({ showing3d: false, peers: { b: { mode: '2d', why: 'failed' } } });
    expect(r.logs).toContain('stream3d: 3D watch of Krobs did not work (VPX did not show their table within 5 s); the 2D video serves this turn');
    // The fork's own late answer changes nothing: a `state watching` after the play is the cancelled watch's.
    r.fork.say('state watching', 'state playing');
    expect(r.m.status()).toMatchObject({ state: 'playing', showing3d: false });
    expect(r.sent).toEqual(['watch 127.0.0.1:50002', 'play']);
  });

  it('a re-aim not answered within 5 s falls back as a first watch does', async () => {
    const r = await inMatch(['b', 'c']);
    r.m.setTarget('b');
    await flush();
    r.fork.say('state watching');
    r.m.setTarget('c');
    await flush();
    r.clock.advance(WATCH_TIMEOUT_MS);
    expect(r.sent).toEqual(['watch 127.0.0.1:50002', 'watch 127.0.0.1:50002', 'play']);
    expect(r.m.status()).toMatchObject({ showing3d: false, peers: { b: { mode: '3d' }, c: { mode: '2d', why: 'failed' } } });
  });

  it('the control connection lost during a watch: the 2D video at once, nobody waits, and a fork that comes back does not take this turn over', async () => {
    const r = await inMatch();
    r.m.setTarget('b');
    await flush();
    r.fork.say('state watching');
    let unlocked: boolean | null = null;
    r.m.whenPlaying((late) => (unlocked = late));
    r.fork.drop('socket error ECONNRESET');
    expect(r.m.status()).toMatchObject({ fork: 'none', state: null, showing3d: false, peers: { b: { mode: '2d', why: 'failed', detail: 'the control connection to VPX was lost' } } });
    // The fork is on its own table by its own rule: the lock does not wait for a line that cannot come.
    expect(unlocked).toBe(false);
    expect(r.caps.at(-1)).toBe(encodeCaps(null));
    expect(r.ports.at(-1)).toBeNull();
    expect(r.logs).toContain('stream3d: the control connection to VPX is gone (socket error ECONNRESET): no 3D on this PC until it is back; VPX goes back to its own table by itself');
    // It reconnects 2 s later (its retry): this turn stays 2D; the next one is 3D again.
    const before = r.sent.length;
    r.fork.up();
    await flush();
    expect(r.sent.length).toBe(before);
    expect(r.m.status().peers).toEqual({ b: { mode: '2d', why: 'failed', detail: 'the control connection to VPX was lost' } });
    r.m.setTarget(null);
    r.m.setTarget('b');
    await flush();
    expect(r.sent.at(-1)).toBe('watch 127.0.0.1:50002');
  });

  it('the fork never connects (an older build, a table opened by hand, no build at all): 2D, nothing is ever sent, the others are told none', async () => {
    const r = rig();
    r.m.setPeers(['b']);
    r.m.peerCaps('b', encodeCaps(SAME));
    r.m.setTarget('b');
    r.clock.advance(120_000);
    await flush();
    expect(r.sent).toEqual([]);
    expect(r.aims).toEqual([]);
    expect(r.m.status()).toMatchObject({ fork: 'none', state: null, showing3d: false, peers: { b: { mode: '2d', why: 'no_fork_here' } } });
    expect(r.caps).toEqual([encodeCaps(null)]);
    expect(r.ports.at(-1) ?? null).toBeNull();
    expect(r.m.away()).toBe(false);
    expect(r.logs).toContain('stream3d: Krobs: this PC shows the 2D video (no Castcade VPX build runs the table on this PC)');
  });

  it('hello with another version: this PC has no 3D, the log says why, nothing is commanded and the others are told none', async () => {
    const r = rig();
    r.m.setPeers(['b']);
    r.m.peerCaps('b', encodeCaps(SAME));
    r.fork.connect();
    r.fork.say('hello 2 10.9.0 617 9f3a61c2d4e5b701 something-new', 'state playing');
    r.m.setTarget('b');
    await flush();
    expect(r.sent).toEqual([]);
    expect(r.m.status()).toMatchObject({ fork: 'version', state: null, showing3d: false, peers: { b: { mode: '2d', why: 'fork_version' } } });
    expect(r.caps.at(-1)).toBe(encodeCaps(null));
    expect(r.ports.at(-1) ?? null).toBeNull();
    expect(r.logs).toContain('stream3d: VPX speaks version 2 of the control connection and this Castcade version 1: no 3D on this PC until both are updated; the 2D video serves');
  });

  it('the fork back on its own table unasked (the stream closed under it): the 2D video this turn', async () => {
    const r = await inMatch();
    r.m.setTarget('b');
    await flush();
    r.fork.say('state watching');
    r.fork.say('state playing');
    expect(r.m.status()).toMatchObject({ state: 'playing', showing3d: false, peers: { b: { mode: '2d', why: 'failed', detail: 'VPX went back to its own table' } } });
    expect(r.sent).toEqual(['watch 127.0.0.1:50002']);
  });

  it("the tunnel's listener that does not open is a failure like any other", async () => {
    const r = await inMatch(['b'], { aim: () => Promise.reject(new Error('EADDRNOTAVAIL')) });
    r.m.setTarget('b');
    await flush();
    expect(r.sent).toEqual([]);
    expect(r.m.status()).toMatchObject({ state: 'playing', showing3d: false, peers: { b: { mode: '2d', why: 'failed' } } });
    expect(r.m.away()).toBe(false);
  });

  it('nothing is commanded before the first state playing after hello, and lines out of place are ignored', async () => {
    const r = rig();
    r.m.setPeers(['b']);
    r.m.peerCaps('b', encodeCaps(SAME));
    r.m.setTarget('b');
    r.fork.connect();
    r.fork.say('state playing');
    expect(r.m.status().fork).toBe('connecting');
    r.fork.say(HELLO);
    await flush();
    // Hello alone is not enough: the others are not told yet and no watch goes out.
    expect(r.sent).toEqual([]);
    expect(r.caps.at(-1)).toBe(encodeCaps(null));
    r.fork.say('nonsense', HELLO);
    expect(r.logs.some((l) => l.includes('said hello twice'))).toBe(true);
    r.fork.say('state playing');
    await flush();
    expect(r.caps.at(-1)).toBe(encodeCaps(SAME));
    expect(r.ports.at(-1)).toBe(50_001);
    expect(r.sent).toEqual(['watch 127.0.0.1:50002']);
    expect(r.logs.some((l) => l.includes('a control line this Castcade does not know was ignored'))).toBe(true);
  });
});

describe('lines that cross', () => {
  it('a watch that was decided and never sent (the turn moved on while the listener opened): no play, and the lock does not wait', async () => {
    let open: (port: number) => void = () => undefined;
    const r = await inMatch(['b'], { aim: () => new Promise<number>((resolve) => (open = resolve)) });
    r.m.setTarget('b', '1');
    expect(r.m.showing3d()).toBe(true);
    // The player up drains at once: this PC's turn, before a line went to the fork.
    r.m.setTarget(null);
    expect(r.sent).toEqual([]);
    expect(r.m.away()).toBe(false);
    const calls: boolean[] = [];
    r.m.whenPlaying((late) => void calls.push(late));
    expect(calls).toEqual([false]);
    // The listener opens late: its watch is not sent any more.
    open(50_002);
    await flush();
    expect(r.sent).toEqual([]);
    expect(r.m.status()).toMatchObject({ state: 'playing', showing3d: false });
  });

  it('a watch asked while a play is unanswered waits for state playing; a state watching in between is the cancelled watch', async () => {
    const r = await inMatch(['b', 'c']);
    r.m.setTarget('b');
    await flush();
    // The turn comes here before the fork answered, and goes on to c at once (a passed turn).
    r.m.setTarget(null);
    r.m.setTarget('c');
    await flush();
    expect(r.sent).toEqual(['watch 127.0.0.1:50002', 'play']);
    expect(r.m.showing3d()).toBe(false);
    // The first watch's answer arrives after the play went out: not c's.
    r.fork.say('state watching');
    expect(r.m.status()).toMatchObject({ state: 'leaving', showing3d: false });
    r.fork.say('state playing');
    await flush();
    expect(r.sent).toEqual(['watch 127.0.0.1:50002', 'play', 'watch 127.0.0.1:50002']);
    expect(r.aims).toEqual(['b', 'c']);
    expect(r.m.showing3d()).toBe(true);
    r.fork.say('state watching');
    expect(r.m.status()).toMatchObject({ state: 'watching', target: 'c' });
  });

  it('a play the fork had no use for is not answered: after 2 s it is taken as on its own table and a waiting watch goes out', async () => {
    const r = await inMatch(['b', 'c']);
    r.m.setTarget('b');
    await flush();
    r.m.setTarget(null);
    r.m.setTarget('c');
    r.clock.advance(PLAY_WAIT_MS);
    await flush();
    expect(r.sent).toEqual(['watch 127.0.0.1:50002', 'play', 'watch 127.0.0.1:50002']);
    expect(r.logs).toContain('stream3d: VPX has not said "state playing" within 2 s; taken as back on its own table');
  });

  it('a state watching when nothing is to be watched (a watch that crossed a failure): play is sent again', async () => {
    const r = await inMatch(['b', 'c']);
    r.m.setTarget('b');
    await flush();
    // The fork fails b's watch at the moment c comes up: `state failed` crosses the re-aim and is read as c's.
    r.m.setTarget('c');
    await flush();
    r.fork.say('state failed no answer from the player', 'state playing');
    expect(r.m.status()).toMatchObject({ state: 'playing', showing3d: false });
    // The re-aim took hold in the fork after all.
    r.fork.say('state watching');
    expect(r.sent).toEqual(['watch 127.0.0.1:50002', 'watch 127.0.0.1:50002', 'play']);
    r.fork.say('state playing');
    expect(r.m.status()).toMatchObject({ state: 'playing', showing3d: false });
    expect(r.m.away()).toBe(false);
  });
});

describe('a failed watch is for one turn, and a turn is a grant (A5)', () => {
  it('a new grant to the same player (shoot again, the last player with balls left) tries 3D again', async () => {
    const r = await inMatch();
    r.m.setTarget('b', '7');
    await flush();
    r.fork.say('state failed refused', 'state playing');
    expect(r.m.status().peers).toEqual({ b: { mode: '2d', why: 'failed', detail: 'refused' } });
    // The same grant said again (every status of the match says it): nothing.
    r.m.setTarget('b', '7');
    await flush();
    expect(r.sent).toEqual(['watch 127.0.0.1:50002']);
    // b's extra ball: the same player, another grant.
    r.m.setTarget('b', '8');
    await flush();
    expect(r.sent).toEqual(['watch 127.0.0.1:50002', 'watch 127.0.0.1:50002']);
    expect(r.m.status()).toMatchObject({ showing3d: true, peers: { b: { mode: '3d' } } });
    r.fork.say('state watching');
    // A watch that works is not sent again when the grant changes under it (b shoots again while this PC watches).
    r.m.setTarget('b', '9');
    await flush();
    expect(r.sent).toHaveLength(2);
    expect(r.m.status()).toMatchObject({ state: 'watching', showing3d: true });
  });

  it('after a timeout too, and the new try waits for the answer to the play that ended the old one', async () => {
    const r = await inMatch();
    r.m.setTarget('b', '7');
    await flush();
    r.clock.advance(WATCH_TIMEOUT_MS);
    expect(r.sent).toEqual(['watch 127.0.0.1:50002', 'play']);
    r.m.setTarget('b', '8');
    await flush();
    expect(r.sent).toHaveLength(2);
    r.fork.say('state playing');
    await flush();
    expect(r.sent).toEqual(['watch 127.0.0.1:50002', 'play', 'watch 127.0.0.1:50002']);
  });
});

describe('a fork that does not keep to the rules of §3 (C2)', () => {
  it('silent on a re-aim (rule 2 broken): after 5 s it is called back and the turn is 2D', async () => {
    const r = await inMatch(['b', 'c']);
    r.m.setTarget('b', '1');
    await flush();
    r.fork.say('state watching');
    r.m.setTarget('c', '2');
    await flush();
    // It re-aimed and shows c, but never says so.
    r.clock.advance(WATCH_TIMEOUT_MS - 1);
    expect(r.m.showing3d()).toBe(true);
    r.clock.advance(1);
    expect(r.sent).toEqual(['watch 127.0.0.1:50002', 'watch 127.0.0.1:50002', 'play']);
    expect(r.m.status()).toMatchObject({ showing3d: false, peers: { c: { mode: '2d', why: 'failed' } } });
    r.fork.say('state playing');
    expect(r.m.away()).toBe(false);
  });

  it('state playing between two players (rule 11 broken): the turn is 2D, and the fork that then shows the next player is called back', async () => {
    const r = await inMatch(['b', 'c']);
    r.m.setTarget('b', '1');
    await flush();
    r.fork.say('state watching');
    r.m.setTarget('c', '2');
    await flush();
    r.fork.say('state playing');
    expect(r.m.status()).toMatchObject({ state: 'playing', showing3d: false, peers: { c: { mode: '2d', why: 'failed', detail: 'VPX went back to its own table' } } });
    // The headset is in theater now; the fork must not stay on c's table under it.
    r.fork.say('state watching');
    expect(r.sent).toEqual(['watch 127.0.0.1:50002', 'watch 127.0.0.1:50002', 'play']);
    expect(r.m.away()).toBe(true);
    r.fork.say('state playing');
    expect(r.m.status()).toMatchObject({ state: 'playing', showing3d: false });
    expect(r.m.away()).toBe(false);
    // The next turn is 3D again.
    r.m.setTarget('b', '3');
    await flush();
    expect(r.sent.at(-1)).toBe('watch 127.0.0.1:50002');
  });

  it('rule 4: a play the fork had no use for is answered at once: nothing waits the 2 s', async () => {
    const r = await inMatch(['b', 'c']);
    r.m.setTarget('b', '1');
    await flush();
    // The fork failed and came back by itself a moment before this PC's own turn: both lines cross the play.
    r.m.setTarget(null);
    expect(r.sent).toEqual(['watch 127.0.0.1:50002', 'play']);
    const calls: boolean[] = [];
    r.m.whenPlaying((late) => void calls.push(late));
    r.fork.say('state failed no answer from the player', 'state playing');
    // The first `state playing` is the one that followed the failure; the lock is off with it.
    expect(calls).toEqual([false]);
    expect(r.m.status()).toMatchObject({ state: 'playing', showing3d: false });
    // The answer to the redundant play arrives after: it changes nothing, and is not read as the fork leaving a watch.
    r.m.setTarget('c', '2');
    await flush();
    expect(r.sent).toEqual(['watch 127.0.0.1:50002', 'play', 'watch 127.0.0.1:50002']);
    r.fork.say('state watching');
    expect(r.m.status()).toMatchObject({ state: 'watching', target: 'c', showing3d: true });
    expect(r.logs.some((l) => l.includes('taken as back on its own table'))).toBe(false);
  });

  it('rule 4, the other order: the answer to a redundant play that arrives after a new watch went out costs that turn its 3D and nothing else (accepted)', async () => {
    const r = await inMatch(['b', 'c']);
    r.m.setTarget('b', '1');
    await flush();
    r.m.setTarget(null);
    r.fork.say('state failed stalled', 'state playing');
    r.m.setTarget('c', '2');
    await flush();
    expect(r.sent).toEqual(['watch 127.0.0.1:50002', 'play', 'watch 127.0.0.1:50002']);
    // The second `state playing` (the play's own) lands now.
    r.fork.say('state playing');
    expect(r.m.status()).toMatchObject({ showing3d: false, peers: { c: { mode: '2d', why: 'failed' } } });
    // The fork does watch c: it is called back, so the theater is not over someone else's table.
    r.fork.say('state watching');
    expect(r.sent.at(-1)).toBe('play');
    r.fork.say('state playing');
    expect(r.m.away()).toBe(false);
    r.m.setTarget('b', '3');
    await flush();
    r.fork.say('state watching');
    expect(r.m.status()).toMatchObject({ state: 'watching', target: 'b', showing3d: true });
  });

  it('rule 12: state failed stalled in the middle of a watch: the 2D video at once, no play, and the next grant tries again', async () => {
    const r = await inMatch();
    r.m.setTarget('b', '1');
    await flush();
    r.fork.say('state watching');
    r.clock.advance(40_000);
    r.fork.say('state failed stalled');
    expect(r.m.status()).toMatchObject({ state: 'leaving', showing3d: false, peers: { b: { mode: '2d', why: 'failed', detail: 'stalled' } } });
    expect(r.m.away()).toBe(true);
    r.fork.say('state playing');
    expect(r.m.away()).toBe(false);
    expect(r.sent).toEqual(['watch 127.0.0.1:50002']);
    expect(r.logs).toContain('stream3d: 3D watch of Krobs did not work (stalled); the 2D video serves this turn');
    r.m.setTarget('b', '2');
    await flush();
    expect(r.sent).toEqual(['watch 127.0.0.1:50002', 'watch 127.0.0.1:50002']);
  });

  it('a state failed that is never followed by state playing: taken as back after 2 s, and the lock does not wait longer', async () => {
    const r = await inMatch();
    r.m.setTarget('b', '1');
    await flush();
    r.fork.say('state watching', 'state failed stalled');
    const calls: boolean[] = [];
    r.m.whenPlaying((late) => void calls.push(late));
    r.m.setTarget(null);
    // No second play: the fork said it is on its way back.
    expect(r.sent).toEqual(['watch 127.0.0.1:50002']);
    r.clock.advance(PLAY_WAIT_MS);
    expect(calls).toHaveLength(1);
    expect(r.m.away()).toBe(false);
  });
});

describe('what reaches the log (A6)', () => {
  // eslint-disable-next-line no-control-regex -- the test is about control characters
  const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

  it('forLog takes control characters and line breaks out and bounds the length', () => {
    expect(forLog('a\r\nb\u0000c\u0085d\u2028e\u001b[31m')).toBe('a b c d e [31m');
    expect(forLog('x'.repeat(500))).toHaveLength(120);
    expect(forLog('  padded  ', 4)).toBe('padd');
  });

  it('a fork that sends lines this Castcade does not know is logged once, then counted', async () => {
    const r = await inMatch();
    const before = r.logs.length;
    for (let i = 0; i < 500; i++) r.fork.say(`debug frame ${i}`);
    expect(r.logs.slice(before)).toEqual(['stream3d: a control line this Castcade does not know was ignored (13 characters: "debug frame 0")']);
    r.clock.advance(QUIET_LOG_MS);
    r.fork.say('debug again');
    expect(r.logs.slice(before + 1)).toEqual(['stream3d: a control line this Castcade does not know was ignored (11 characters: "debug again") (and 499 more like it since the last line)']);
  });

  it('nothing a fork sends reaches the log with a control character in it', async () => {
    const r = await inMatch();
    r.m.setTarget('b', '1');
    await flush();
    r.fork.say('junk\u0085stream3d: forged\u2028line\u009b[2J');
    // A C0 character makes the whole line unreadable; the others are taken out of a reason.
    r.fork.say('state failed bad\u0007bell');
    r.fork.say('state failed refused\u2028stream3d: forged\u0085line');
    expect(r.m.status().peers).toEqual({ b: { mode: '2d', why: 'failed', detail: 'refused stream3d: forged line' } });
    for (const l of r.logs) expect(CONTROL.test(l), JSON.stringify(l)).toBe(false);
    expect(r.logs.filter((l) => l.startsWith('stream3d:')).length).toBe(r.logs.length);
  });

  it("a peer's capability that does not read is never logged itself, and is logged once however often it comes", async () => {
    const r = await inMatch();
    const before = r.logs.length;
    const forged = JSON.stringify({ v: 1, fork: { build: '10.8.0\nstream3d: Krobs: this PC shows 3D', table: TABLE } });
    for (let i = 0; i < 300; i++) r.m.peerCaps('b', forged);
    const lines = r.logs.slice(before);
    // One line for what came (and one for what this PC shows of b now that nothing is known of its VPX).
    expect(lines.filter((l) => l.includes('cannot read'))).toEqual([`stream3d: Krobs's PC said something about its VPX this Castcade cannot read (${forged.length} characters); taken as nothing said`]);
    expect(lines).toHaveLength(2);
    for (const l of r.logs) expect(CONTROL.test(l) || l.includes('forged') || l.includes('10.8.0\\n'), JSON.stringify(l)).toBe(false);
    expect(r.m.status().peers).toEqual({ b: { mode: '2d', why: 'not_connected' } });
  });

  it('a fork that sends valid lines without end (each a state change here) fills no log: said once, and what it says still counts', async () => {
    const r = await inMatch();
    const before = r.logs.length;
    // It says it watches when nothing is to be watched (each time a `play` goes back), then that it plays, for ever.
    for (let i = 0; i < 2000; i++) r.fork.say('state watching', 'state playing');
    const lines = r.logs.slice(before);
    // (The hello of this fork counted against the same 30 s.)
    expect(lines.length).toBeLessThanOrEqual(FORK_LOG_MAX + 1);
    expect(lines.length).toBeGreaterThan(FORK_LOG_MAX - 10);
    expect(lines.at(-1)).toBe(`stream3d: VPX sent enough lines for ${FORK_LOG_MAX} log lines in 30 s; what its lines do is not logged again until that time is up`);
    // The machine itself is where the lines left it: on its own table, a real turn works as ever.
    expect(r.m.away()).toBe(false);
    r.clock.advance(QUIET_LOG_MS);
    const sent = r.sent.length;
    r.m.setTarget('b', '1');
    await flush();
    r.fork.say('state watching');
    expect(r.sent.slice(sent)).toEqual(['watch 127.0.0.1:50002']);
    expect(r.logs.at(-1)).toBe("stream3d: VPX: state watching: Krobs's table is on screen in 3D");
  });

  it("a PC that changes what it says about its VPX without end: a few changes are taken, then the last word when the time is up; the log and this PC's fork are left alone meanwhile", async () => {
    const r = await inMatch();
    r.m.setTarget('b', '1');
    await flush();
    r.fork.say('state watching');
    const before = { logs: r.logs.length, sent: r.sent.length };
    const none = encodeCaps(null);
    const same = encodeCaps(SAME);
    // b says "none", then "the build", 500 times over (a data channel carries thousands of frames a second).
    for (let i = 0; i < 500; i++) {
      r.m.peerCaps('b', none);
      r.m.peerCaps('b', same);
    }
    // Each change taken is at most a `play` or a `watch` for this PC's fork: bounded by the limit, not by the peer.
    expect(r.sent.length - before.sent).toBeLessThanOrEqual(CAPS_CHANGES_MAX);
    expect(r.logs.length - before.logs).toBeLessThan(CAPS_CHANGES_MAX * 4 + 2);
    expect(r.logs.filter((l) => l.includes('changed what it says about its VPX'))).toEqual(["stream3d: Krobs's PC changed what it says about its VPX 8 times in 30 s; what it says from here on is taken when that time is up"]);
    const quiet = r.logs.length;
    for (let i = 0; i < 500; i++) {
      r.m.peerCaps('b', none);
      r.m.peerCaps('b', same);
    }
    expect(r.logs.length).toBe(quiet);
    // Its last word was "the build": taken when the 30 s are over, and the match goes on in 3D.
    r.fork.say('state playing');
    r.clock.advance(QUIET_LOG_MS);
    await flush();
    expect(r.m.status().peers).toEqual({ b: { mode: '3d' } });
    // And a PC that says the same thing again and again costs nothing at all.
    const settled = r.logs.length;
    for (let i = 0; i < 500; i++) r.m.peerCaps('b', same);
    expect(r.logs.length).toBe(settled);
  });

  it("a player's name (it comes from the other PC's HELLO) is logged without its control characters", async () => {
    const r = await inMatch(['b'], { name: () => 'Kro\nbs\u0085\u2028the\u0000Great' });
    r.m.setTarget('b', '1');
    await flush();
    r.fork.say('state watching');
    expect(r.logs).toContain("stream3d: VPX: state watching: Kro bs the Great's table is on screen in 3D");
    for (const l of r.logs) expect(CONTROL.test(l), JSON.stringify(l)).toBe(false);
  });
});

describe('the fork acts on, and answers, only the last command of one read (the fork\'s fix round)', () => {
  it('watch, then play at once (a grant right after a turn change): one state playing and no state watching, and nothing is left waiting', async () => {
    const r = await inMatch();
    r.m.setTarget('b', '1');
    await flush();
    // The lock of this PC's own turn, then the turn: both lines are on the socket within a millisecond.
    const calls: boolean[] = [];
    r.m.whenPlaying((late) => void calls.push(late));
    r.m.setTarget(null);
    expect(r.sent).toEqual(['watch 127.0.0.1:50002', 'play']);
    // The fork read both in one go: the watch is not gone through, and not answered.
    r.fork.say('state playing');
    expect(calls).toEqual([false]);
    expect(r.m.status()).toMatchObject({ state: 'playing', showing3d: false, target: null });
    expect(r.m.away()).toBe(false);
    // The watch's 5 s were taken away with it: no fall-back for a watch nobody asked for any more, no second play.
    const logs = r.logs.length;
    r.clock.advance(WATCH_TIMEOUT_MS * 3);
    await flush();
    expect(r.sent).toEqual(['watch 127.0.0.1:50002', 'play']);
    expect(r.logs.slice(logs)).toEqual([]);
    expect(r.logs.some((l) => l.includes('did not work'))).toBe(false);
    // And the next turn is 3D: that watch never failed.
    r.m.setTarget('b', '2');
    await flush();
    expect(r.m.status().peers).toEqual({ b: { mode: '3d' } });
    expect(r.sent.at(-1)).toBe('watch 127.0.0.1:50002');
    r.fork.say('state watching');
    expect(r.m.status()).toMatchObject({ state: 'watching', showing3d: true });
  });

  it('watch, then play, read apart after all: the state watching that comes first is ignored, the state playing ends it', async () => {
    const r = await inMatch();
    r.m.setTarget('b', '1');
    await flush();
    r.m.setTarget(null);
    r.fork.say('state watching', 'state playing');
    expect(r.m.status()).toMatchObject({ state: 'playing', showing3d: false });
    r.clock.advance(WATCH_TIMEOUT_MS * 3);
    expect(r.sent).toEqual(['watch 127.0.0.1:50002', 'play']);
    expect(r.logs.some((l) => l.includes('did not work'))).toBe(false);
  });

  it('watch A, then watch B at once (two turn changes on top of each other): one state watching, and it is B\'s; no fall-back for A', async () => {
    const r = await inMatch(['b', 'c']);
    r.m.setTarget('b', '1');
    await flush();
    r.m.setTarget('c', '2');
    await flush();
    expect(r.sent).toEqual(['watch 127.0.0.1:50002', 'watch 127.0.0.1:50002']);
    // One answer for the two.
    r.clock.advance(300);
    r.fork.say('state watching');
    expect(r.m.status()).toMatchObject({ state: 'watching', target: 'c', showing3d: true, peers: { b: { mode: '3d' }, c: { mode: '3d' } } });
    // Nothing waits for an answer to the first watch: no timeout, no play, no failed watch of anyone.
    r.clock.advance(WATCH_TIMEOUT_MS * 3);
    await flush();
    expect(r.sent).toHaveLength(2);
    expect(r.m.showing3d()).toBe(true);
    expect(r.logs.some((l) => l.includes('did not work'))).toBe(false);
  });

  it('watch A, then watch B at once, and B fails: the one state failed is B\'s, and A is not marked', async () => {
    const r = await inMatch(['b', 'c']);
    r.m.setTarget('b', '1');
    await flush();
    r.m.setTarget('c', '2');
    await flush();
    r.fork.say('state failed refused', 'state playing');
    expect(r.m.status()).toMatchObject({ state: 'playing', showing3d: false, peers: { b: { mode: '3d' }, c: { mode: '2d', why: 'failed', detail: 'refused' } } });
    r.clock.advance(WATCH_TIMEOUT_MS * 3);
    expect(r.sent).toHaveLength(2);
  });
});

describe('what the companion sends, and what it takes for a reason', () => {
  it('every line it ever sends is `play` or `watch 127.0.0.1:<port>`: never an empty line, never a watch without an address, never a long one', async () => {
    const r = await inMatch(['b', 'c']);
    // A busy match: turns, re-aims, failures, a timeout, the setting, a capability that goes and comes back.
    for (let n = 1; n <= 12; n++) {
      r.m.setTarget(n % 3 === 0 ? null : n % 3 === 1 ? 'b' : 'c', String(n));
      await flush();
      if (n % 4 === 0) r.fork.say('state failed stalled', 'state playing');
      else if (n % 5 === 0) r.clock.advance(WATCH_TIMEOUT_MS);
      else r.fork.say(n % 3 === 0 ? 'state playing' : 'state watching');
      if (n === 6) r.m.setSetting('off');
      if (n === 7) r.m.setSetting('auto');
      if (n === 9) r.m.peerCaps('b', null);
      if (n === 10) r.m.peerCaps('b', encodeCaps(SAME));
      r.fork.say('state playing');
      r.clock.advance(PLAY_WAIT_MS);
      await flush();
    }
    expect(r.sent.length).toBeGreaterThan(8);
    for (const line of r.sent) expect(line, JSON.stringify(line)).toMatch(/^(play|watch 127\.0\.0\.1:[1-9]\d{0,4})$/);
  });

  it('a tunnel that names no usable port: no watch is sent at all (the fork would ignore a watch without an address and answer nothing), and the turn is 2D', async () => {
    for (const port of [0, Number.NaN, 70_000, -1, 1.5]) {
      const r = await inMatch(['b'], { aim: async () => port });
      r.m.setTarget('b', '1');
      await flush();
      expect(r.sent, String(port)).toEqual([]);
      expect(r.m.status(), String(port)).toMatchObject({ state: 'playing', showing3d: false, peers: { b: { mode: '2d', why: 'failed' } } });
      expect(r.m.away()).toBe(false);
    }
  });

  it('a reason this build has never seen (badaddress, overflow, anything): a failed watch like any other', async () => {
    for (const reason of ['badaddress', 'overflow', 'something-new-in-2027']) {
      const r = await inMatch();
      r.m.setTarget('b', '1');
      await flush();
      r.fork.say('state watching');
      r.fork.say(`state failed ${reason}`);
      expect(r.m.status(), reason).toMatchObject({ state: 'leaving', showing3d: false, peers: { b: { mode: '2d', why: 'failed', detail: reason } } });
      r.fork.say('state playing');
      expect(r.m.away()).toBe(false);
      // No play was sent for it, and the next grant tries again.
      expect(r.sent).toEqual(['watch 127.0.0.1:50002']);
      r.m.setTarget('b', '2');
      await flush();
      expect(r.sent).toHaveLength(2);
    }
  });

  it('hello with stream port 0 (the fork has no stream listener): this PC watches in 3D, and the others are told it has nothing to watch', async () => {
    const r = rig();
    r.m.setPeers(['b']);
    r.fork.connect();
    r.fork.say('hello 1 10.8.0.2078.castcade 617 9f3a61c2d4e5b701 0', 'state playing');
    r.m.peerCaps('b', encodeCaps(SAME));
    expect(r.m.status()).toMatchObject({ fork: 'ready', streamPort: null, peers: { b: { mode: '3d' } } });
    expect(r.caps.at(-1)).toBe(encodeCaps(null));
    expect(r.ports.at(-1) ?? null).toBeNull();
    r.m.setTarget('b', '1');
    await flush();
    expect(r.sent).toEqual(['watch 127.0.0.1:50002']);
    expect(r.logs.some((l) => l.includes('no stream listener (port 0)'))).toBe(true);
  });
});

describe('the turn lock waits for state playing (§4.3)', () => {
  it('lifted at once when the fork is on its own table, or there is none', async () => {
    const none = rig();
    const calls: boolean[] = [];
    none.m.whenPlaying((late) => void calls.push(late));
    const r = await inMatch();
    r.m.whenPlaying((late) => void calls.push(late));
    expect(calls).toEqual([false, false]);
  });

  it('at the grant after a watch: lifted only when the fork says state playing', async () => {
    const r = await inMatch();
    r.m.setTarget('b');
    await flush();
    r.fork.say('state watching');
    // The controller unlocks first (the grant), the shell names nobody right after.
    const calls: boolean[] = [];
    r.m.whenPlaying((late) => void calls.push(late));
    r.m.setTarget(null);
    expect(r.sent.at(-1)).toBe('play');
    r.clock.advance(PLAY_WAIT_MS - 1);
    expect(calls).toEqual([]);
    r.fork.say('state playing');
    expect(calls).toEqual([false]);
    // The 2 s limit that was running is off: nothing fires later.
    r.clock.advance(10_000);
    expect(calls).toEqual([false]);
    expect(r.logs.some((l) => l.includes('unlocked anyway'))).toBe(false);
  });

  it('after the 2 s limit: lifted anyway, and logged', async () => {
    const r = await inMatch();
    r.m.setTarget('b');
    await flush();
    r.fork.say('state watching');
    const calls: boolean[] = [];
    r.m.whenPlaying((late) => void calls.push(late));
    r.m.setTarget(null);
    r.clock.advance(PLAY_WAIT_MS - 1);
    expect(calls).toEqual([]);
    r.clock.advance(1);
    expect(calls).toEqual([true]);
    expect(r.logs).toContain('stream3d: VPX has not said "state playing" 2 s after the turn came to this PC; the table is unlocked anyway');
    // A late answer does not call it twice.
    r.fork.say('state playing');
    expect(calls).toEqual([true]);
  });

  it('a wait that is cancelled (the table is locked again first) never fires; the end of the match lets everyone go', async () => {
    const r = await inMatch();
    r.m.setTarget('b');
    await flush();
    r.fork.say('state watching');
    const calls: string[] = [];
    const cancel = r.m.whenPlaying(() => void calls.push('cancelled one'));
    cancel();
    r.m.whenPlaying(() => void calls.push('kept one'));
    r.m.reset();
    expect(calls).toEqual(['kept one']);
    expect(r.sent.at(-1)).toBe('play');
    r.clock.advance(10_000);
    expect(calls).toEqual(['kept one']);
  });
});

describe('what the others are told, and whether they may watch this PC', () => {
  it('none until the fork is ready, its build and table then, none again when it is gone; the stream port follows', async () => {
    const r = rig();
    r.m.setPeers(['b']);
    expect(r.caps).toEqual([encodeCaps(null)]);
    r.fork.connect();
    r.fork.say(HELLO);
    expect(r.caps).toEqual([encodeCaps(null)]);
    r.fork.say('state playing');
    expect(r.caps).toEqual([encodeCaps(null), encodeCaps(SAME)]);
    expect(r.ports.filter((p) => p !== null)).toEqual([50_001]);
    r.fork.drop();
    expect(r.caps.at(-1)).toBe(encodeCaps(null));
    expect(r.ports.at(-1)).toBeNull();
  });

  it('rule 9: the port offered to the others is the one hello names, on every connection anew', async () => {
    const r = rig();
    r.m.setPeers(['b']);
    r.fork.up();
    expect(r.ports.at(-1)).toBe(50_001);
    expect(r.m.status().streamPort).toBe(50_001);
    // The table is closed and another started: its listener is bound elsewhere, and says so.
    r.fork.drop();
    expect(r.ports.at(-1)).toBeNull();
    expect(r.m.status().streamPort).toBeNull();
    r.fork.connect();
    r.fork.say('hello 1 10.8.0.2078.castcade 617 9f3a61c2d4e5b701 50977', 'state playing');
    expect(r.ports.at(-1)).toBe(50_977);
    expect(r.logs).toContain('stream3d: VPX said hello: build 10.8.0.2078.castcade, table 617 9f3a61c2d4e5b701, its stream on 127.0.0.1:50977');
  });

  it('a new match starts from nothing: nobody known, this PC said again on the new connections', async () => {
    const r = await inMatch();
    const told = r.caps.length;
    r.m.reset();
    expect(r.m.status()).toMatchObject({ target: null, peers: {} });
    expect(r.caps.length).toBe(told + 1);
    expect(r.caps.at(-1)).toBe(encodeCaps(SAME));
    r.m.setPeers(['b']);
    expect(r.m.status().peers).toEqual({ b: { mode: '2d', why: 'not_connected' } });
  });
});

// ------------------------------------------------------------------------------------------------
// I11.4.9: the match's first start waits for the 3D connection
// ------------------------------------------------------------------------------------------------

describe('the first start waits for the 3D connection (I11.4.9)', () => {
  /** A PC in the lobby of a match with `peers`: the gate is on, the data connections open, nothing known of anyone. */
  function lobby(peers: string[] = ['b']) {
    const r = rig();
    r.m.reset();
    r.m.setStartGate(true);
    r.m.tunnelOpened();
    r.m.setPeers(peers);
    return r;
  }
  const NONE = { pending: false, until: null, why: null, waitingFor: [] };
  const waitLines = (r: ReturnType<typeof rig>): string[] => r.logs.filter((l) => l.includes("the match's start"));

  it('(b) a ready fork waits for every other PC nothing has been heard from, and settles when the last one speaks', () => {
    const r = lobby(['b', 'c']);
    const t0 = r.clock.now();
    expect(r.m.startWait()).toEqual(NONE); // no fork: never waited for
    r.clock.advance(2_000);
    r.fork.up();
    // 45 s from when this PC began connecting to them (the tunnel opened with both in the match), not from the fork.
    expect(r.m.startWait()).toEqual({ pending: true, until: t0 + START_WAIT_MS, why: 'peers', waitingFor: ['b', 'c'] });
    expect(waitLines(r)).toEqual(["stream3d: the match's start waits for the 3D connection to Krobs, Chuck: nothing heard from their PCs yet (43 s at most)"]);
    r.clock.advance(11_200);
    r.m.peerCaps('b', encodeCaps(SAME));
    expect(r.m.startWait()).toMatchObject({ pending: true, waitingFor: ['c'], until: t0 + START_WAIT_MS });
    r.clock.advance(300);
    // A PC with no Castcade VPX build is heard from too: nothing more will come from it.
    r.m.peerCaps('c', encodeCaps(null));
    expect(r.m.startWait().pending).toBe(false);
    // How long each connection took, from this PC's data connections opening to the first word.
    expect(waitLines(r).at(-1)).toBe("stream3d: the match's start no longer waits for this PC: this PC's 3D connections are settled (heard from, after this PC's data connections opened: Krobs 13.2 s, Chuck 13.5 s)");
  });

  it('(b) the limit is per player: 45 s after this PC began connecting to them, whatever the connections say', () => {
    const r = lobby();
    const t0 = r.clock.now();
    r.fork.up();
    const changes = r.changes();
    r.clock.advance(START_WAIT_MS - 1);
    expect(r.m.startWait().pending).toBe(true);
    r.clock.advance(2);
    expect(r.m.startWait()).toEqual(NONE);
    // The shell is told at the limit (it re-reads `startWait`), and the log says what ended the wait.
    expect(r.changes()).toBeGreaterThan(changes);
    expect(waitLines(r).at(-1)).toBe("stream3d: the match's start no longer waits for this PC: 45 s passed since this PC began connecting to Krobs and nothing was heard from that PC: the first turn may be the 2D video");
    // A third player joins now: this PC begins connecting to them now, and waits for them 45 s from here; not for Krobs again.
    r.clock.advance(10_000);
    r.m.setPeers(['b', 'c']);
    expect(r.m.startWait()).toEqual({ pending: true, until: r.clock.now() + START_WAIT_MS, why: 'peers', waitingFor: ['c'] });
    expect(r.clock.now() - t0).toBeGreaterThan(START_WAIT_MS);
  });

  it('(b) a table left open from the last match, its VPX ready long before this lobby: waited for all the same (the limit runs from this match)', () => {
    const r = rig();
    r.fork.up();
    r.clock.advance(60_000);
    // The new match: Host or Join, the data connections open, the other player is in.
    r.m.reset();
    r.m.setStartGate(true);
    r.m.tunnelOpened();
    r.m.setPeers(['b']);
    expect(r.m.startWait()).toEqual({ pending: true, until: r.clock.now() + START_WAIT_MS, why: 'peers', waitingFor: ['b'] });
  });

  it("(b) a player who joins 50 s after the host's VPX was ready is waited for, 45 s from their joining", () => {
    const r = rig();
    r.m.reset();
    r.m.setStartGate(true);
    r.m.tunnelOpened();
    r.fork.up();
    expect(r.m.startWait()).toEqual(NONE); // alone in the lobby
    r.clock.advance(50_000);
    r.m.setPeers(['b']);
    expect(r.m.startWait()).toEqual({ pending: true, until: r.clock.now() + START_WAIT_MS, why: 'peers', waitingFor: ['b'] });
    // Data connections that open late (this PC had no use for them before): connecting begins then.
    r.clock.advance(5_000);
    r.m.tunnelOpened();
    expect(r.m.startWait()).toMatchObject({ pending: true, until: r.clock.now() + START_WAIT_MS });
  });

  it('(a) a match table started in the Castcade VPX build is waited for until its VPX is ready: no limit while the table loads, 10 s once it is open', () => {
    const r = lobby();
    const t0 = r.clock.now();
    r.m.forkLaunched();
    // The table is still loading: no limit runs yet (the lobby's wait for an open table is what holds a start).
    expect(r.m.startWait()).toEqual({ pending: true, until: null, why: 'fork', waitingFor: [] });
    expect(waitLines(r)).toEqual(["stream3d: the match's start waits for this PC: its Castcade VPX build has not connected to Castcade yet (10 s at most once the table is open)"]);
    r.clock.advance(30_000);
    expect(r.m.startWait().pending).toBe(true);
    r.m.setTableOpen(true);
    const opened = r.clock.now();
    expect(r.m.startWait()).toEqual({ pending: true, until: opened + FORK_HELLO_WAIT_MS, why: 'fork', waitingFor: [] });
    r.clock.advance(1_500);
    r.fork.connect();
    r.fork.say(HELLO);
    expect(r.m.startWait()).toMatchObject({ pending: true, why: 'fork' }); // hello, not ready yet
    r.fork.say('state playing');
    // Ready: now (b), and its limit is the one that has been running since this PC began connecting to Krobs.
    expect(r.m.startWait()).toEqual({ pending: true, until: t0 + START_WAIT_MS, why: 'peers', waitingFor: ['b'] });
    r.m.peerCaps('b', encodeCaps(SAME));
    expect(r.m.startWait().pending).toBe(false);
  });

  it('(a) then (b) is never more than 45 s from when connecting began: the two limits do not add up', () => {
    const r = lobby();
    const t0 = r.clock.now();
    r.m.forkLaunched();
    r.m.setTableOpen(true);
    r.clock.advance(FORK_HELLO_WAIT_MS - 1_000);
    expect(r.m.startWait().pending).toBe(true);
    r.fork.up();
    expect(r.m.startWait()).toMatchObject({ pending: true, why: 'peers', until: t0 + START_WAIT_MS });
    r.clock.advance(START_WAIT_MS - FORK_HELLO_WAIT_MS + 1_001);
    expect(r.m.startWait()).toEqual(NONE);
    expect(r.clock.now() - t0).toBe(START_WAIT_MS + 1);
  });

  it('(a) the limit: a build that never connects (one from before the 3D watch in a match) costs 10 s after the table opened, not 45', () => {
    const r = lobby();
    r.m.forkLaunched();
    r.m.setTableOpen(true);
    r.clock.advance(FORK_HELLO_WAIT_MS - 1);
    expect(r.m.startWait().pending).toBe(true);
    r.clock.advance(2);
    expect(r.m.startWait()).toEqual(NONE);
    expect(waitLines(r).at(-1)).toBe("stream3d: the match's start no longer waits for this PC: 10 s passed since the table opened and its Castcade VPX build has not connected to Castcade (a build from before the 3D watch in a match does not): the match starts with the 2D video on this PC");
    r.clock.advance(START_WAIT_MS);
    expect(r.m.startWait()).toEqual(NONE);
  });

  it('(a) a Castcade VPX build that did not start, or ended, is not waited for from that moment, also when the table then opens in the player own VPX', () => {
    const r = lobby();
    r.m.forkLaunched();
    expect(r.m.startWait().pending).toBe(true);
    // The launch answered "not started" (no process, so no exit), or the process ended: the same word here.
    r.m.forkGone();
    expect(r.m.startWait()).toEqual(NONE);
    expect(waitLines(r).at(-1)).toBe("stream3d: the match's start no longer waits for this PC: the Castcade VPX build is not coming (it ended, or did not start)");
    r.clock.advance(30_000);
    r.m.setTableOpen(true);
    expect(r.m.startWait()).toEqual(NONE);
  });

  it('never waited for: the setting off, no Castcade VPX build, a build of another control version', () => {
    // Off, with a ready fork and nothing heard.
    const off = lobby();
    off.m.setSetting('off');
    off.fork.up();
    expect(off.m.startWait().pending).toBe(false);
    off.m.forkLaunched();
    expect(off.m.startWait().pending).toBe(false);
    // No fork at all.
    const none = lobby();
    none.clock.advance(5_000);
    expect(none.m.startWait().pending).toBe(false);
    // Another control version: launched, connected, and not a build this Castcade can talk to.
    const ver = lobby();
    ver.m.forkLaunched();
    expect(ver.m.startWait().pending).toBe(true);
    ver.fork.connect();
    ver.fork.say('hello 2 whatever');
    expect(ver.m.startWait().pending).toBe(false);
    expect(waitLines(ver).at(-1)).toBe("stream3d: the match's start no longer waits for this PC: its Castcade VPX build speaks another version of the control connection");
    // Turned off while waited for.
    const turned = lobby();
    turned.fork.up();
    expect(turned.m.startWait().pending).toBe(true);
    turned.m.setSetting('off');
    expect(turned.m.startWait().pending).toBe(false);
    expect(waitLines(turned).at(-1)).toBe("stream3d: the match's start no longer waits for this PC: 3D watch was turned off on this PC");
  });

  it('(b) a connection the tunnel gave up on, or a tunnel that is broken, is not waited for', () => {
    const r = lobby(['b', 'c']);
    r.fork.up();
    r.m.setTunnel({ broken: false, noPath: ['b'] });
    expect(r.m.startWait()).toMatchObject({ pending: true, waitingFor: ['c'] });
    r.m.setTunnel({ broken: false, noPath: ['b', 'c'] });
    expect(r.m.startWait().pending).toBe(false);
    expect(waitLines(r).at(-1)).toBe("stream3d: the match's start no longer waits for this PC: the data connection to Krobs, Chuck found no path: the 2D video serves");
    // A path found after all: waited for again, inside the same 45 s.
    r.m.setTunnel({ broken: false, noPath: [] });
    expect(r.m.startWait()).toMatchObject({ pending: true, waitingFor: ['b', 'c'] });
    r.m.setTunnel({ broken: true, noPath: [] });
    expect(r.m.startWait().pending).toBe(false);
    expect(waitLines(r).at(-1)).toBe("stream3d: the match's start no longer waits for this PC: this PC's data connections are not working");
  });

  it('only the first start: with the gate off (the match runs, a next game, a rejoin) nothing is ever waited for', () => {
    const r = rig();
    r.m.reset();
    r.m.tunnelOpened();
    r.m.setPeers(['b']);
    r.m.forkLaunched();
    expect(r.m.startWait().pending).toBe(false);
    r.fork.up();
    expect(r.m.startWait().pending).toBe(false);
    expect(waitLines(r)).toEqual([]);
    // The lobby: waited for. The match starts (the host started anyway): not any more, and the log says what that means.
    r.m.setStartGate(true);
    expect(r.m.startWait().pending).toBe(true);
    r.m.setStartGate(false);
    expect(r.m.startWait().pending).toBe(false);
    expect(waitLines(r).at(-1)).toBe("stream3d: the match's start no longer waits for this PC: the match started or the lobby is gone, with nothing heard yet from Krobs: they are shown in the 2D video until their PC is heard from");
  });

  it('a VPX that drops and connects again in the lobby does not get more time; a new match starts from nothing', () => {
    const r = lobby();
    const t0 = r.clock.now();
    r.fork.up();
    r.clock.advance(40_000);
    r.fork.drop();
    expect(r.m.startWait()).toEqual(NONE); // no fork, none expected
    r.fork.up();
    // The same 45 s since this PC began connecting to Krobs: 5 s are left of them.
    expect(r.m.startWait()).toEqual({ pending: true, until: t0 + START_WAIT_MS, why: 'peers', waitingFor: ['b'] });
    r.clock.advance(5_001);
    expect(r.m.startWait()).toEqual(NONE);
    // The next match on the same open table: everything is counted from that match.
    r.m.reset();
    expect(r.m.startWait()).toEqual(NONE);
    r.m.setStartGate(true);
    r.m.tunnelOpened();
    r.m.setPeers(['b']);
    expect(r.m.startWait()).toEqual({ pending: true, until: r.clock.now() + START_WAIT_MS, why: 'peers', waitingFor: ['b'] });
  });

  it('the mid-turn switch that exists without the wait: a target set while nothing is heard of the player, and the watch goes out when their PC speaks, with no new grant', async () => {
    const r = rig();
    r.m.setPeers(['b']);
    r.fork.up();
    // The match started anyway: the player up is b, this PC waits with its table locked, and b's PC has said nothing.
    r.m.setTarget('b', '1');
    await flush();
    expect(r.m.status().peers).toEqual({ b: { mode: '2d', why: 'not_connected' } });
    expect(r.m.showing3d()).toBe(false);
    expect(r.sent).toEqual([]);
    // b's PC is heard from in the middle of the turn (the data connection came up): the same grant, and the fork is sent.
    r.m.peerCaps('b', encodeCaps(SAME));
    await flush();
    expect(r.sent).toEqual(['watch 127.0.0.1:50002']);
    expect(r.m.showing3d()).toBe(true);
    r.fork.say('state watching');
    expect(r.m.status()).toMatchObject({ state: 'watching', target: 'b', showing3d: true, peers: { b: { mode: '3d' } } });
  });
});
