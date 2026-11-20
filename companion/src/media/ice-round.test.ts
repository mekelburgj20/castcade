/**
 * I11.12 (2026-11-20): one log line per ICE round (`iceRoundLine`, `iceRoundOver`, panel-page.ts), the same for voice
 * (the panel page) and the 3D watch tunnel (its page): what each kind of candidate pair sent and received, and when
 * the round got its remote description, went to `checking` and connected. On `getStats()` shapes recorded from the
 * real 3D watch page in Electron (`ice-round.test-data.json`), and on the shape the two-router nights point at: every
 * pair in progress, checks sent, none answered.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { iceCandidateIds, iceRoundLine, iceRoundOver, iceRoundSeen, iceRoundStart, type IceRound, type IceRoundPeer } from './panel-page.js';
import { firstRestartMs, watchPageHtml } from '../watch/watch-page.js';
import { ICE_WATCH, iceWatchStep, panelPageHtml } from './panel-page.js';

type Entry = Record<string, unknown>;
const recorded = JSON.parse(readFileSync(new URL('./ice-round.test-data.json', import.meta.url), 'utf8')) as { first: Entry[]; second: Entry[] };
const pairsOf = (entries: Entry[]): Entry[] => entries.filter((e) => e.type === 'candidate-pair');
/** Nothing that is an address, a port after one, a ufrag or SDP may be in a line: words, counts and times only. */
const SAFE_LINE = /^[A-Za-z0-9 ,;:.()>-]+$/;

/** A round that began at `at`, saw its remote description `remoteMs` later and `checking` at `checkingMs`. */
function round(n: number, at: number, remoteMs: number | null, checkingMs: number | null, known: IceRound['known'] = null): IceRound {
  return { ...iceRoundStart(n, at, null, known), remoteMs, checkingMs };
}

/** What the logs of 2026-11-18 describe: pairs formed both ways, checks going out, nothing coming back. */
function stalled(): Entry[] {
  const out: Entry[] = [{ id: 'T01', type: 'transport' }];
  const local = [
    ['L1', 'host'],
    ['L2', 'srflx'],
  ] as const;
  const remote = [
    ['R1', 'host'],
    ['R2', 'srflx'],
  ] as const;
  for (const [id, candidateType] of local) out.push({ id, type: 'local-candidate', candidateType, protocol: 'udp', address: '192.0.2.10', port: 50_000, usernameFragment: 'abcd' });
  for (const [id, candidateType] of remote) out.push({ id, type: 'remote-candidate', candidateType, protocol: 'udp', address: '198.51.100.7', port: 61_000, usernameFragment: 'wxyz' });
  for (const [l] of local) for (const [r] of remote) out.push({ id: `CP${l}_${r}`, type: 'candidate-pair', localCandidateId: l, remoteCandidateId: r, state: 'in-progress', nominated: false, requestsSent: 21, responsesReceived: 0, requestsReceived: 0, responsesSent: 0 });
  return out;
}

describe('the line of one ICE round (I11.12)', () => {
  it('the round the two-router nights describe: every pair in progress, checks sent, none answered, none received', () => {
    const line = iceRoundLine(round(1, 1_000, 150, 160), 11_400, 'restart 1 of 3 decided here', false, 'checking', stalled(), null);
    expect(line).toBe(
      'ICE round 1: restart 1 of 3 decided here after 10.40 s (ice checking); remote description at 0.15 s, checking at 0.16 s, not connected; 4 pairs: ' +
        'host>host udp in-progress sent 21 answered 0, received 0 answered 0; host>srflx udp in-progress sent 21 answered 0, received 0 answered 0; ' +
        'srflx>host udp in-progress sent 21 answered 0, received 0 answered 0; srflx>srflx udp in-progress sent 21 answered 0, received 0 answered 0',
    );
    expect(line).toMatch(SAFE_LINE);
  });

  it('the other picture a stalled round can show: checks arrive and are answered here, and nothing this side sends is answered', () => {
    const entries = stalled().map((e) => (e.id === 'CPL1_R2' ? { ...e, requestsReceived: 19, responsesSent: 19 } : e));
    const line = iceRoundLine(round(1, 0, 150, 160), 10_000, 'restart 1 of 3 by the peer', false, 'checking', entries, null);
    expect(line).toContain('host>srflx udp in-progress sent 21 answered 0, received 19 answered 19');
    // Pairs that read the same are counted, not repeated.
    const same = stalled().map((e) => (e.type === 'local-candidate' ? { ...e, candidateType: 'host' } : e.type === 'remote-candidate' ? { ...e, candidateType: 'srflx' } : e));
    expect(iceRoundLine(round(1, 0, 150, 160), 10_000, 'restart 1 of 3 decided here', false, 'checking', same, null)).toContain('; 4 pairs: 4x host>srflx udp in-progress sent 21 answered 0, received 0 answered 0');
  });

  it('a recorded report after a connect: every pair is counted, the selected one is named, and nothing but words, counts and times is in the line', () => {
    const line = iceRoundLine(round(1, 0, 12, 14), 20, 'connected', true, 'connected', recorded.first, null);
    expect(line.startsWith(`ICE round 1: connected after 0.02 s (ice connected); remote description at 0.01 s, checking at 0.01 s, connected at 0.02 s; ${pairsOf(recorded.first).length} pairs: `)).toBe(true);
    // Exactly one kind of pair is the selected one, and it worked both ways.
    const kinds = line.split(' pairs: ')[1]!.split('; ');
    const selected = kinds.filter((k) => k.includes(' selected '));
    expect(selected).toHaveLength(1);
    expect(selected[0]).toMatch(/^host>host udp succeeded selected sent [1-9]\d* answered [1-9]\d*, received \d+ answered \d+$/);
    // It is the first one named: what won comes before what only waited.
    expect(kinds[0]).toBe(selected[0]);
    // The counts of all kinds add up to the pairs of the report.
    const total = kinds.reduce((n, k) => n + Number(/^(\d+)x /.exec(k)?.[1] ?? 1), 0);
    expect(total).toBe(pairsOf(recorded.first).length);
    expect(line).toMatch(SAFE_LINE);
  });

  it('a recorded report after an ICE restart: the candidates of the round before are marked, and the pair that won is the first one named', () => {
    const known = iceCandidateIds(recorded.first);
    expect(known.local.length).toBeGreaterThan(0);
    expect(known.remote.length).toBeGreaterThan(0);
    const second = pairsOf(recorded.second);
    const isOld = (p: Entry): [boolean, boolean] => [known.local.includes(p.localCandidateId as string), known.remote.includes(p.remoteCandidateId as string)];
    // What Chromium did at that restart, as recorded on the side that restarted: its new ports were paired with the
    // peer's old candidates as well as its new ones (and its old ports with nothing new), and the pair that was
    // selected afterwards is one of those: a new local candidate, an old remote one.
    const mix = (lo: boolean, ro: boolean): number => second.filter((p) => isOld(p)[0] === lo && isOld(p)[1] === ro).length;
    expect([mix(true, true), mix(false, true), mix(false, false), mix(true, false)]).toEqual([21, 20, 21, 0]);
    const line = iceRoundLine(round(2, 0, 150, 160, known), 500, 'connected', true, 'connected', recorded.second, null);
    expect(line).toContain(`; ${second.length} pairs: `);
    const kinds = line.split(' pairs: ')[1]!.split('; ');
    expect(kinds[0]).toMatch(/^host>host\(old\) udp succeeded selected sent [1-9]\d* answered [1-9]\d*, received \d+ answered \d+$/);
    // More kinds than a line holds: the twelve that say most are named (the pairs that worked before any that only waited).
    expect(kinds).toHaveLength(13);
    expect(kinds.at(-1)).toMatch(/^and \d+ more kinds$/);
    expect(kinds.slice(0, 12).filter((k) => / waiting sent 0 answered 0, received 0 answered 0$/.test(k))).toEqual([]);
    expect(line.length).toBeLessThan(1200);
    expect(line).toMatch(SAFE_LINE);
    // A round that did not connect is read a moment after the next one began: with `only`, the pairs of the look before.
    const only = iceRoundLine(round(1, 0, 150, 160), 10_000, 'restart 1 of 3 decided here', false, 'checking', recorded.second, known);
    expect(only).toContain(`; ${mix(true, true)} pairs: `);
    expect(only).not.toContain('(old)');
  });

  it('never an address, whatever a report holds: a type, a protocol or a state that is not a plain word reads as ?', () => {
    const entries: Entry[] = [
      { id: 'T', type: 'transport', selectedCandidatePairId: 'P' },
      { id: 'L', type: 'local-candidate', candidateType: '203.0.113.7', protocol: 'udp 203.0.113.7:50000', address: '203.0.113.7', ip: '203.0.113.7', port: 50_000, usernameFragment: 'SeCr', url: 'stun:203.0.113.9' },
      { id: 'R', type: 'remote-candidate', candidateType: 'srflx', protocol: 'udp', address: '198.51.100.7', port: 61_000 },
      { id: 'P', type: 'candidate-pair', localCandidateId: 'L', remoteCandidateId: 'R', state: 'a=ice-ufrag:SeCr', requestsSent: '21; 203.0.113.7', responsesReceived: -4, requestsReceived: 2.6, responsesSent: Infinity },
    ];
    const line = iceRoundLine(round(1, 0, null, null), 1_000, 'gave up after 3 restart(s)', false, 'checking', entries, null);
    expect(line).toBe('ICE round 1: gave up after 3 restart(s) after 1.00 s (ice checking); remote description not seen, checking not seen, not connected; 1 pair: ?>srflx ? ? selected sent 0 answered 0, received 3 answered 0');
    expect(line).not.toMatch(/203|198\.51|SeCr|ufrag|stun/);
  });

  it('no pairs at all, and more kinds than a line should hold', () => {
    expect(iceRoundLine(round(3, 0, null, null), 40_000, 'restart 3 of 3 decided here', false, 'new', [], null)).toBe('ICE round 3: restart 3 of 3 decided here after 40.00 s (ice new); remote description not seen, checking not seen, not connected; 0 pairs');
    const many: Entry[] = [{ id: 'L', type: 'local-candidate', candidateType: 'host', protocol: 'udp' }, { id: 'R', type: 'remote-candidate', candidateType: 'host', protocol: 'udp' }];
    for (let i = 0; i < 14; i++) many.push({ id: `P${i}`, type: 'candidate-pair', localCandidateId: 'L', remoteCandidateId: 'R', state: 'in-progress', requestsSent: i });
    const line = iceRoundLine(round(1, 0, 0, 0), 1_000, 'restart 1 of 3 decided here', false, 'checking', many, null);
    expect(line).toContain('; 14 pairs: ');
    expect(line.endsWith('; and 2 more kinds')).toBe(true);
    // The kind that sent nothing is the one left for last.
    expect(line).not.toContain('in-progress sent 0 answered 0');
    expect(line.length).toBeLessThan(1200);
  });
});

describe("a round's times (I11.12)", () => {
  it('round 1: the remote description, then the first checking, each counted from the peer connection opening', () => {
    const r = iceRoundStart(1, 1_000, null, null);
    iceRoundSeen(r, 1_010, 'new', null);
    expect(r).toMatchObject({ remoteMs: null, checkingMs: null });
    iceRoundSeen(r, 1_150, 'new', 'uf1');
    iceRoundSeen(r, 1_163, 'checking', 'uf1');
    iceRoundSeen(r, 5_000, 'checking', 'uf1');
    expect(r).toMatchObject({ remoteMs: 150, checkingMs: 163 });
  });

  it('a restart round: its own remote description is the one whose ICE credentials are new; checking counts from there', () => {
    const r = iceRoundStart(2, 20_000, 'uf1', { local: ['L1'], remote: ['R1'] });
    // Still the old description, still checking: neither is this round's.
    iceRoundSeen(r, 20_050, 'checking', 'uf1');
    expect(r).toMatchObject({ remoteMs: null, checkingMs: null });
    iceRoundSeen(r, 20_148, 'checking', 'uf2');
    expect(r).toMatchObject({ remoteMs: 148, checkingMs: 148 });
  });

  it('after a connect the next round begins when the connection is in trouble again, not at the connect', () => {
    const r = iceRoundStart(2, 1_000, 'uf1', null);
    r.idle = true;
    iceRoundSeen(r, 60_000, 'connected', 'uf1');
    iceRoundSeen(r, 90_000, 'completed', 'uf1');
    expect(r).toMatchObject({ at: 1_000, idle: true });
    iceRoundSeen(r, 600_000, 'disconnected', 'uf1');
    expect(r).toMatchObject({ at: 600_000, idle: false, remoteMs: null, checkingMs: null, ufrag: 'uf1' });
  });
});

describe('the end of a round, as both pages call it (I11.12)', () => {
  const peer = (o: { stats?: Entry[] | 'throws' | 'rejects' | 'absent'; ice?: string; sdp?: string | null; ids?: IceRoundPeer['ids'] } = {}): IceRoundPeer => ({
    pc: {
      iceConnectionState: o.ice ?? 'checking',
      remoteDescription: o.sdp === null ? null : { sdp: o.sdp ?? 'v=0\r\na=ice-ufrag:uf1\r\n' },
      ...(o.stats === 'absent'
        ? {}
        : {
            getStats: () => {
              if (o.stats === 'throws') throw new Error('closed');
              if (o.stats === 'rejects') return Promise.reject(new Error('closed'));
              return Promise.resolve(new Map((o.stats ?? stalled()).map((e) => [e.id as string, e])));
            },
          }),
    },
    round: { ...iceRoundStart(1, 0, null, null), remoteMs: 150, checkingMs: 160 },
    ids: o.ids ?? null,
  });
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };

  it('a restart decided here: one line from the stats, and round 2 begins with what was known of the candidates', async () => {
    const ids = iceCandidateIds(stalled());
    const r = peer({ ids });
    const lines: string[] = [];
    iceRoundOver(r, 'restart 1 of 3 decided here', false, false, 10_400, (l) => lines.push(l));
    // The next round began at once: the restart that follows belongs to it.
    expect(r.round).toEqual({ n: 2, at: 10_400, ufrag: 'uf1', remoteMs: null, checkingMs: null, known: ids, idle: false });
    expect(lines).toEqual([]);
    await flush();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^ICE round 1: restart 1 of 3 decided here after 10\.40 s \(ice checking\); remote description at 0\.15 s, checking at 0\.16 s, not connected; 4 pairs: /);
  });

  it("a restart the peer made: this side has already answered, so the new round's remote description is there from its start", async () => {
    const r = peer({ sdp: 'v=0\r\na=ice-ufrag:uf2\r\n' });
    const lines: string[] = [];
    iceRoundOver(r, 'restart 1 of 3 by the peer', false, true, 15_000, (l) => lines.push(l));
    expect(r.round).toMatchObject({ n: 2, at: 15_000, ufrag: 'uf2', remoteMs: 0, idle: false });
    await flush();
    expect(lines[0]).toContain('restart 1 of 3 by the peer after 15.00 s');
  });

  it('a connect: the line says when, with every pair of the report; the next round waits for trouble', async () => {
    const r = peer({ ice: 'connected', stats: recorded.first, ids: { local: [], remote: [] } });
    const lines: string[] = [];
    iceRoundOver(r, 'connected', true, false, 420, (l) => lines.push(l));
    expect(r.round).toMatchObject({ n: 2, idle: true });
    await flush();
    expect(lines[0]).toContain(`connected at 0.42 s; ${pairsOf(recorded.first).length} pairs: `);
  });

  it('no stats (none in this browser, a closed connection): the line is written all the same, and says so', async () => {
    for (const stats of ['absent', 'throws', 'rejects'] as const) {
      const lines: string[] = [];
      iceRoundOver(peer({ stats }), 'gave up after 3 restart(s)', false, false, 110_000, (l) => lines.push(l));
      await flush();
      expect(lines, stats).toEqual(['ICE round 1: gave up after 3 restart(s) after 110.00 s (ice checking); remote description at 0.15 s, checking at 0.16 s, not connected; 0 pairs (no stats)']);
    }
  });
});

describe('both pages carry it (I11.12)', () => {
  const scriptOf = (html: string): string => /<script>([\s\S]*)<\/script>/.exec(html)?.[1] ?? '';
  for (const [name, html] of [
    ['the 3D watch page (the tunnel)', watchPageHtml()],
    ['the panel page (voice)', panelPageHtml({ vr: false })],
  ] as const) {
    it(`${name}: the shared functions are embedded, the page calls them at a restart, at a restart by the peer, at a connect and at giving up, and the script parses`, () => {
      const script = scriptOf(html);
      for (const fn of ['function iceRoundStart', 'function iceRoundSeen', 'function iceCandidateIds', 'function iceRoundLine', 'function iceRoundOver', 'function roundSeen', 'function roundOver']) expect(script, fn).toContain(fn);
      expect(script).toContain("roundOver(peer, r, 'restart ' + (w.restarts + 1) + ' of ' + ICE_WATCH.backoffMs.length + ' decided here', false, false);");
      expect(script).toContain("roundOver(peer, r, 'restart ' + w.restarts + ' of ' + ICE_WATCH.backoffMs.length + ' by the peer', false, true);");
      expect(script).toContain("roundOver(peer, r, 'connected', true, false);");
      expect(script).toContain("roundOver(peer, r, 'gave up after ' + w.restarts + ' restart(s)', false, false);");
      expect(script).toContain('r.ids = iceCandidateIds(entries);');
      // Compiled, not run: a syntax error in the embedded source would throw here.
      expect(() => new Function('require', script)).not.toThrow();
    });
  }
});

describe('the early restart, an experiment that is off unless asked for (I11.12)', () => {
  it('CASTCADE_ICE_FIRST_RESTART_MS: 500 to 9000 ms, anything else is no experiment', () => {
    expect(firstRestartMs(undefined)).toBeNull();
    for (const bad of ['', '0', '499', '9001', '2.5', '2500ms', '-2500', 'yes', '25000']) expect(firstRestartMs(bad), bad).toBeNull();
    expect(firstRestartMs('500')).toBe(500);
    expect(firstRestartMs(' 2500 ')).toBe(2500);
    expect(firstRestartMs('9000')).toBe(9000);
  });

  it('with it, the watchdog restarts once early and then goes on as it always did; without it, nothing changes', () => {
    const usual = { backoffMs: ICE_WATCH.backoffMs, lagMs: ICE_WATCH.lagMs };
    const early = { backoffMs: [2500, ...ICE_WATCH.backoffMs], lagMs: ICE_WATCH.lagMs };
    // The side that leads: at 2.5 s instead of 10 s; the restart after that comes 10 s later, and so on.
    expect(iceWatchStep('checking', 2_400, 0, true, early)).toBe('wait');
    expect(iceWatchStep('checking', 2_500, 0, true, early)).toBe('restart');
    expect(iceWatchStep('checking', 2_500, 0, true, usual)).toBe('wait');
    expect(iceWatchStep('checking', 9_900, 1, true, early)).toBe('wait');
    expect(iceWatchStep('checking', 10_000, 1, true, early)).toBe('restart');
    expect(iceWatchStep('checking', 40_000, 3, true, early)).toBe('restart');
    expect(iceWatchStep('checking', 40_000, 4, true, early)).toBe('give_up');
    // The other side still gives the lead its 5 s.
    expect(iceWatchStep('checking', 7_400, 0, false, early)).toBe('wait');
    expect(iceWatchStep('checking', 7_500, 0, false, early)).toBe('restart');
  });

  it('only the 3D watch page knows it, and takes it from its configuration', () => {
    const watch = watchPageHtml();
    expect(watch).toContain('let ICE_WATCH = ICE_WATCH_BASE;');
    expect(watch).toContain('backoffMs: [cfg.firstRestartMs].concat(ICE_WATCH_BASE.backoffMs)');
    expect(panelPageHtml({ vr: false })).not.toContain('firstRestartMs');
  });
});
