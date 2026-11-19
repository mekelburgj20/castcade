/**
 * I11.4.2: the state stream inside a match, as one PC decides it (`stream3d.ts`), with a scripted fork: the lines of
 * the control connection as §3 of docs/design/state-stream-in-match.md writes them, every row of the §4.3 table, every
 * fail-safe, the capability exchange, and the turn lock that waits for `state playing`. Time is a manual clock.
 */
import { describe, expect, it } from 'vitest';
import { ManualClock } from './clock.js';
import { CONTROL_LINE_MAX, PLAY_WAIT_MS, Stream3d, WATCH_TIMEOUT_MS, decide, decodeCaps, encodeCaps, parseControlLine, viewWords, watchCommand, type ForkInfo } from './stream3d.js';

const HELLO = 'hello 1 10.8.0.2078.castcade 617 9f3a61c2d4e5b701';
const TABLE = '617 9f3a61c2d4e5b701';
const BUILD = '10.8.0.2078.castcade';
const SAME: ForkInfo = { build: BUILD, table: TABLE };
const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function rig(o: { aim?: (peer: string) => Promise<number> } = {}) {
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
    name: (id) => ({ a: 'Owner', b: 'Krobs', c: 'Chuck' })[id] ?? id,
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

/** A PC with its fork up on stream port 50001, in a match with `peers`, each of whom said the same table. */
async function inMatch(peers: string[] = ['b'], o: Parameters<typeof rig>[0] = {}) {
  const r = rig(o);
  r.m.setStreamPort(50_001);
  r.m.setPeers(peers);
  r.fork.up();
  for (const p of peers) r.m.peerCaps(p, encodeCaps(SAME));
  await flush();
  return r;
}

describe('the control connection, as read (§3)', () => {
  it('reads the four lines exactly', () => {
    expect(parseControlLine(HELLO)).toEqual({ kind: 'hello', version: 1, build: BUILD, editables: '617', tableHash: '9f3a61c2d4e5b701' });
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
    expect(parseControlLine('hello 2 build 617 hash and more fields')).toEqual({ kind: 'hello', version: 2, build: '', editables: '', tableHash: '' });
    expect(parseControlLine('hello 0')).toEqual({ kind: 'hello', version: 0, build: '', editables: '', tableHash: '' });
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
    r.m.setStreamPort(50_001);
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
    r.m.setStreamPort(50_001);
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
    r.m.setStreamPort(50_001);
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
    r.m.setStreamPort(50_001);
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
    r.m.setStreamPort(50_001);
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

  it('a fork on the control connection whose stream port Castcade does not know still watches; the others are told none until the port is known', async () => {
    const r = rig();
    r.m.setPeers(['b']);
    r.fork.up();
    r.m.peerCaps('b', encodeCaps(SAME));
    r.m.setTarget('b');
    await flush();
    expect(r.sent).toEqual(['watch 127.0.0.1:50002']);
    expect(r.ports.at(-1) ?? null).toBeNull();
    // Nobody is sent to a stream that is not there.
    expect(r.caps.at(-1)).toBe(encodeCaps(null));
    expect(r.logs.filter((l) => l.includes('does not know its stream port'))).toHaveLength(1);
    // The port becomes known (Castcade restarted under the open table and read its saved ports): the others are told.
    r.m.setStreamPort(50_001);
    expect(r.caps.at(-1)).toBe(encodeCaps(SAME));
    expect(r.ports.at(-1)).toBe(50_001);
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
