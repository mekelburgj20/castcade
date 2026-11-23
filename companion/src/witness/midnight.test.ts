import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { JournalDetector, type JournalEvent } from './journal-detector.js';
import { compileMap, createMapCorpus, gameStateOffsets, highScoreOffsets, watchOffsets, type CompiledMap } from './maps.js';
import { MIDNIGHT_GAME_NOTE, midnightCount, midnightEnabled, midnightEvidence, midnightLine, midnightSettingLine, midnightSpan, midnightWatchOffsets, midnightWire, utcOffsetMinutes } from './midnight.js';

const corpus = createMapCorpus(fileURLToPath(new URL('../../../fixtures/maps', import.meta.url)));
const mapOf = async (rom: string): Promise<CompiledMap> => {
  const map = await corpus.mapFor(rom);
  if (!map) throw new Error(`no vendored map for ${rom}`);
  return map;
};

describe('midnightEvidence (B26.4): the counter and the setting, from the vendored maps', () => {
  it('Congo: the audit B.4 31 from the map, the adjustment A.2 14 from the supplement, for congo_21 only', async () => {
    const map = await mapOf('congo_21');
    const e = midnightEvidence(map, 'congo_21');
    expect(e.counter).toEqual({ name: 'B.4 31 SPECIAL MODES', entry: { label: 'SPECIAL MODES', start: 6857, encoding: 'int', length: 3 } });
    expect(e.setting).toMatchObject({ name: 'A.2 14 Special Mode', entry: { start: 7265, length: 2, encoding: 'int' }, on: 1, off: 0 });
    // The ROM's name as a table script may write it.
    expect(midnightEvidence(map, 'Congo_21').setting?.name).toBe('A.2 14 Special Mode');
    // The other ROMs of the same map: the counter (the map claims it for them), not the unverified setting.
    for (const rom of ['congo_20', 'congo_13', 'congo_11', 'congo_20s10k']) {
      const other = midnightEvidence(await mapOf(rom), rom);
      expect(other.counter?.name).toBe('B.4 31 SPECIAL MODES');
      expect(other.setting).toBeNull();
    }
    // No ROM named: the map alone.
    expect(midnightEvidence(map)).toMatchObject({ counter: { name: 'B.4 31 SPECIAL MODES' }, setting: null });
  });

  it('Johnny Mnemonic: both from the map (audit B.4 35, adjustment A.2 12, NO / YES)', async () => {
    const e = midnightEvidence(await mapOf('jm_12r'), 'jm_12r');
    expect(e.counter).toMatchObject({ name: 'B.4 35 Special Modes', entry: { start: 6881, length: 3 } });
    expect(e.setting).toMatchObject({ name: 'A.2 12 Special Mode', entry: { start: 7132, encoding: 'enum' }, on: 1, off: 0 });
  });

  it('Who Dunnit ("SPECIAL MODES"): a counter, no setting; its "Midnight Champ" is a champion, not an audit', async () => {
    const wd = await mapOf('wd_12');
    expect(midnightEvidence(wd, 'wd_12')).toMatchObject({ counter: { name: 'B.4 61 SPECIAL MODES', entry: { start: 7013, length: 3 } }, setting: null });
    expect(wd.audits.filter((a) => /midnight/i.test(a.label))).toEqual([]);
  });

  it("a machine with a clock in its own rules is not monitored by that clock's audit: FunHouse's MIDNIGHT GAMES / 11:45 GAMES, Theatre of Magic's Midnight (its Midnight Multiball, beside Got to 6 PM)", async () => {
    const fh = await mapOf('fh_l9');
    expect(fh.audits.map((a) => a.label)).toEqual(expect.arrayContaining(['MIDNIGHT GAMES', '11:45 GAMES']));
    expect(midnightEvidence(fh, 'fh_l9')).toEqual({ counter: null, setting: null });
    expect(midnightWatchOffsets(fh, 'fh_l9')).toEqual([]);
    const tom = await mapOf('tom_13');
    expect(tom.audits.map((a) => a.label)).toEqual(expect.arrayContaining(['Midnight', 'Got to 6 PM']));
    expect(midnightEvidence(tom, 'tom_13')).toEqual({ counter: null, setting: null });
    expect(midnightWatchOffsets(tom, 'tom_13')).toEqual([]);
  });

  it('nor any machine without such an audit, nor no map', async () => {
    for (const rom of ['mm_109c', 'mb_106b', 'afm_113', 'tftc_400', 'acd_170h', 'cueball']) {
      expect(midnightEvidence(await mapOf(rom), rom)).toEqual({ counter: null, setting: null });
    }
    expect(midnightEvidence(null, 'congo_21')).toEqual({ counter: null, setting: null });
    expect(midnightWatchOffsets(null, 'congo_21')).toEqual([]);
  });

  it('only an audit labelled exactly so counts, and only an int inside the NVRAM region', () => {
    const map = (label: string, entry: object = {}): CompiledMap =>
      compileMap({ _fileformat: 0.8, _metadata: { version: 1, roms: ['x'], ramsize: 64 }, audits: { 'B.4 FEATURE AUDS.': { '07': { label, start: 10, encoding: 'int', length: 3, ...entry } } } }, () => null);
    for (const label of ['SPECIAL MODES', 'Special Mode', 'MIDNIGHT MADNESS', 'Midnight Madness', ' special  modes ']) expect(midnightEvidence(map(label), 'x').counter?.name).toBe(`B.4 07 ${label}`);
    for (const label of ['Midnight', 'MIDNIGHT GAMES', '11:45 GAMES', 'Midnight Champ', 'Midnight Multiball', 'SPECIAL MODES STARTED', 'SPECIALS', 'MODES']) expect(midnightEvidence(map(label), 'x').counter).toBeNull();
    expect(midnightEvidence(map('SPECIAL MODES', { encoding: 'bcd' }), 'x').counter).toBeNull();
    expect(midnightEvidence(map('SPECIAL MODES', { start: 63 }), 'x').counter).toBeNull();
  });

  it('the watch list gains the counter and the setting bytes, and nothing on a machine without them', async () => {
    const congo = await mapOf('congo_21');
    expect(midnightWatchOffsets(congo, 'congo_21')).toEqual([6857, 6858, 6859, 7265, 7266]);
    expect(midnightWatchOffsets(congo, 'congo_20')).toEqual([6857, 6858, 6859]);
    expect(midnightWatchOffsets(await mapOf('jm_12r'), 'jm_12r')).toEqual([6881, 6882, 6883, 7132]);
    const base = [...new Set([...gameStateOffsets(congo), ...highScoreOffsets(congo)])].sort((a, b) => a - b);
    expect(watchOffsets(congo)).toEqual(base);
    const all = watchOffsets(congo, midnightWatchOffsets(congo, 'congo_21'));
    expect(all).toEqual([...new Set([...base, 6857, 6858, 6859, 7265, 7266])].sort((a, b) => a - b));
    expect(all.length).toBe(base.length + 5);
    const mm = await mapOf('mm_109c');
    expect(watchOffsets(mm, midnightWatchOffsets(mm, 'mm_109c'))).toEqual(watchOffsets(mm));
  });

  it('the counter and the setting decode from NVRAM bytes; a setting that is neither YES nor NO is not a reading', async () => {
    const congo = await mapOf('congo_21');
    const e = midnightEvidence(congo, 'congo_21');
    const nv = new Uint8Array(0x3000);
    expect(midnightCount(congo, e, nv)).toBe(0);
    expect(midnightEnabled(congo, e, nv)).toBe(false);
    nv[6858] = 1;
    nv[6859] = 2;
    nv[7266] = 1;
    expect(midnightCount(congo, e, nv)).toBe(258);
    expect(midnightEnabled(congo, e, nv)).toBe(true);
    // A WPC boot's RAM test fills the bytes with 0x55, then 0xAA; and the pair's first byte is never set.
    for (const fill of [0x55, 0xaa]) expect(midnightEnabled(congo, e, new Uint8Array(0x3000).fill(fill))).toBeNull();
    nv[7265] = 1;
    expect(midnightEnabled(congo, e, nv)).toBeNull();
    // A file too short to hold them, and a ROM with no evidence.
    expect(midnightCount(congo, e, new Uint8Array(100))).toBeNull();
    expect(midnightEnabled(congo, e, new Uint8Array(100))).toBeNull();
    expect(midnightCount(congo, midnightEvidence(null), nv)).toBeNull();
    expect(midnightEnabled(congo, midnightEvidence(congo, 'congo_20'), nv)).toBeNull();

    const jm = await mapOf('jm_12r');
    const je = midnightEvidence(jm, 'jm_12r');
    const jnv = new Uint8Array(0x3000);
    expect(midnightEnabled(jm, je, jnv)).toBe(false);
    jnv[7132] = 1;
    expect(midnightEnabled(jm, je, jnv)).toBe(true);
    jnv[7132] = 2;
    expect(midnightEnabled(jm, je, jnv)).toBeNull();
  });
});

describe('the wording (B26.4)', () => {
  const ON = { enabled: true, adjustment: 'A.2 14 Special Mode' };
  const OFF = { enabled: false, adjustment: 'A.2 14 Special Mode' };

  it('a ball the mode ran on: a fact, the ball named, right for a name that ends in s', () => {
    expect(midnightLine('Krobs', 2)).toBe("Midnight Madness ran on Krobs' ball 2 (counted by that table's ROM)");
    expect(midnightLine('ChuckRibbits', 1)).toBe("Midnight Madness ran on ChuckRibbits' ball 1 (counted by that table's ROM)");
    expect(midnightLine('Hosty', 3)).toBe("Midnight Madness ran on Hosty's ball 3 (counted by that table's ROM)");
    expect(midnightLine(null, 3)).toBe("Midnight Madness ran on your ball 3 (counted by your table's ROM)");
    expect(MIDNIGHT_GAME_NOTE).toBe('Midnight Madness ran during the game (counted by the ROM)');
    for (const s of [midnightLine('Krobs', 2), midnightLine(null, 1), MIDNIGHT_GAME_NOTE]) expect(s).not.toMatch(/may|clock|\?/);
  });

  it('the setting line: ON on one table, on several, on every table', () => {
    expect(midnightSettingLine([{ name: null, setting: null }, { name: 'Krobs', setting: ON }])).toBe("Midnight Madness is ON on Krobs' table (adjustment A.2 14 Special Mode)");
    expect(midnightSettingLine([{ name: null, setting: ON }, { name: 'Krobs', setting: null }])).toBe('Midnight Madness is ON on your table (adjustment A.2 14 Special Mode)');
    expect(midnightSettingLine([{ name: null, setting: ON }, { name: 'Krobs', setting: ON }])).toBe('Midnight Madness is ON on every table (adjustment A.2 14 Special Mode)');
    expect(midnightSettingLine([{ name: 'Hosty', setting: ON }, { name: null, setting: ON }, { name: 'Krobs', setting: null }])).toBe("Midnight Madness is ON on Hosty's table and your table (adjustment A.2 14 Special Mode)");
    expect(midnightSettingLine([{ name: 'Hosty', setting: ON }, { name: null, setting: ON }, { name: 'Krobs', setting: ON }, { name: 'Chuck', setting: null }])).toBe(
      "Midnight Madness is ON on Hosty's table, your table and Krobs' table (adjustment A.2 14 Special Mode)",
    );
    // A lone player (a lobby of one): never "every table".
    expect(midnightSettingLine([{ name: null, setting: ON }])).toBe('Midnight Madness is ON on your table (adjustment A.2 14 Special Mode)');
  });

  it('the setting line: it differs between tables, said plainly; a rig that reported nothing is left out', () => {
    expect(midnightSettingLine([{ name: null, setting: OFF }, { name: 'Krobs', setting: ON }])).toBe(
      "Midnight Madness differs between tables: ON on Krobs' table, OFF on your table (adjustment A.2 14 Special Mode)",
    );
    expect(midnightSettingLine([{ name: 'Hosty', setting: ON }, { name: null, setting: ON }, { name: 'Krobs', setting: OFF }, { name: 'Chuck', setting: null }])).toBe(
      "Midnight Madness differs between tables: ON on Hosty's table and your table, OFF on Krobs' table (adjustment A.2 14 Special Mode)",
    );
  });

  it('the setting line: nothing when it is OFF everywhere it could be read, or nobody could read it', () => {
    expect(midnightSettingLine([{ name: null, setting: OFF }, { name: 'Krobs', setting: OFF }])).toBeNull();
    expect(midnightSettingLine([{ name: null, setting: OFF }, { name: 'Krobs', setting: null }])).toBeNull();
    expect(midnightSettingLine([{ name: null, setting: null }, { name: 'Krobs', setting: null }])).toBeNull();
    expect(midnightSettingLine([])).toBeNull();
  });
});

describe('what goes with a score (B26.6): the clock offset and what the rig knows', () => {
  const ON = { enabled: true, adjustment: 'A.2 14 Special Mode' };
  const OFF = { enabled: false, adjustment: 'A.2 14 Special Mode' };

  it('the offset is minutes east of UTC on this machine at that moment, whatever its time zone', () => {
    const at = Date.UTC(2026, 10, 22, 7, 36, 42);
    expect(utcOffsetMinutes(at)).toBe(0 - new Date(at).getTimezoneOffset());
    expect(Number.isInteger(utcOffsetMinutes(at))).toBe(true);
    // A machine set to UTC (CI is) must give 0, never -0.
    expect(Object.is(utcOffsetMinutes(at), -0)).toBe(false);
    expect(Math.abs(utcOffsetMinutes(at))).toBeLessThanOrEqual(14 * 60);
  });

  it('the setting and the count, each only when known; nothing known sends nothing', () => {
    expect(midnightWire({ setting: null, ran: null })).toBeNull();
    expect(JSON.parse(midnightWire({ setting: ON, ran: null })!)).toEqual({ setting: 'on', adjustment: 'A.2 14 Special Mode' });
    expect(JSON.parse(midnightWire({ setting: OFF, ran: false })!)).toEqual({ setting: 'off', adjustment: 'A.2 14 Special Mode', ran: false });
    // A ROM whose audit is watched but whose adjustment is not readable (congo_20): the count alone.
    expect(JSON.parse(midnightWire({ setting: null, ran: true })!)).toEqual({ ran: true });
    // B26.7: a rise that cannot be placed in one game is its own key, and enough on its own to send the param.
    expect(JSON.parse(midnightWire({ setting: null, ran: null, ranSpan: true })!)).toEqual({ ran_span: true });
    expect(JSON.parse(midnightWire({ setting: ON, ran: null, ranSpan: true })!)).toEqual({ setting: 'on', adjustment: 'A.2 14 Special Mode', ran_span: true });
    expect(midnightWire({ setting: null, ran: null, ranSpan: false })).toBeNull();
  });

  it('B26.7, basic mode: the audit in the .nv before the sitting and after it: same, rose, or nothing to say', async () => {
    const congo = await mapOf('congo_21');
    const e = midnightEvidence(congo, 'congo_21');
    const nv = (count: number): Uint8Array => {
      const b = new Uint8Array(0x3000);
      b[6859] = count;
      return b;
    };
    expect(midnightSpan(congo, e, nv(3), nv(3))).toBe('same');
    expect(midnightSpan(congo, e, nv(3), nv(4))).toBe('rose');
    expect(midnightSpan(congo, e, nv(0), nv(2))).toBe('rose');
    // An audit reset in the service menu, a first run with no .nv yet, a file too short, a ROM with no such audit.
    expect(midnightSpan(congo, e, nv(3), nv(0))).toBeNull();
    expect(midnightSpan(congo, e, null, nv(1))).toBeNull();
    expect(midnightSpan(congo, e, nv(1), null)).toBeNull();
    expect(midnightSpan(congo, e, new Uint8Array(100), nv(1))).toBeNull();
    expect(midnightSpan(congo, midnightEvidence(null), nv(1), nv(2))).toBeNull();
    expect(midnightSpan(null, e, nv(1), nv(2))).toBeNull();
  });
});

describe('the journal detector (B26.4): the counter going up during a game, and the setting', () => {
  let CONGO: CompiledMap;
  beforeAll(async () => {
    CONGO = await mapOf('congo_21');
  });
  // The Congo map: game over at 135 (bool), player at 946, ball at 947, player 1's score at 5792 (BCD, 6 bytes).
  const GAME_OVER = 135;
  const PLAYER = 946;
  const BALL = 947;
  const SCORE = 5792;
  const COUNT = 6857;
  const SETTING = 7265;

  /** A Congo table whose patch journals `watch` only; `count` Special Modes so far, the adjustment at `setting`. */
  class Table {
    readonly detector: JournalDetector;
    readonly events: JournalEvent[] = [];
    readonly buf = new Uint8Array(0x3000);
    private last: Uint8Array;
    private t = 1;
    constructor(opts: { rom?: string; count?: number; setting?: number; watch?: number[] } = {}) {
      const rom = opts.rom ?? 'congo_21';
      this.watch = new Set(opts.watch ?? watchOffsets(CONGO, midnightWatchOffsets(CONGO, rom)));
      this.detector = new JournalDetector({ mapFor: () => CONGO });
      this.buf[GAME_OVER] = 1;
      this.setCount(opts.count ?? 3);
      this.buf[SETTING + 1] = opts.setting ?? 1;
      this.feed({ event: 'table_loaded', t: 0, table: 'Congo', recipe: 'A', rom, lib: '0.5.1', session: 's', locked: false });
      this.feed({ event: 'nvram_full', t: 0.5, bytes: [...this.buf] });
      this.last = Uint8Array.from(this.buf);
    }
    private readonly watch: Set<number>;
    private feed(line: object): JournalEvent[] {
      const out = this.detector.feed(JSON.stringify(line));
      this.events.push(...out);
      return out;
    }
    setCount(n: number): void {
      this.buf[COUNT] = (n >> 16) & 0xff;
      this.buf[COUNT + 1] = (n >> 8) & 0xff;
      this.buf[COUNT + 2] = n & 0xff;
    }
    step(): JournalEvent[] {
      const d: [number, number, number][] = [];
      for (let i = 0; i < this.buf.length; i++) if (this.buf[i] !== this.last[i] && this.watch.has(i)) d.push([i, this.buf[i]!, this.last[i]!]);
      this.last = Uint8Array.from(this.buf);
      return d.length ? this.feed({ event: 'nvram_delta', t: this.t++, n: d.length, d }) : [];
    }
    full(): JournalEvent[] {
      this.last = Uint8Array.from(this.buf);
      return this.feed({ event: 'nvram_full', t: this.t++, bytes: [...this.buf] });
    }
    start(): JournalEvent[] {
      this.buf[GAME_OVER] = 0;
      this.buf[PLAYER] = 1;
      this.buf[BALL] = 1;
      this.buf.fill(0, SCORE, SCORE + 6);
      return this.step();
    }
    end(): JournalEvent[] {
      this.buf[GAME_OVER] = 1;
      return this.step();
    }
  }
  const kinds = (ev: JournalEvent[]): string[] => ev.map((e) => e.kind);
  const midnights = (ev: JournalEvent[]): JournalEvent[] => ev.filter((e) => e.kind === 'midnight_madness');

  it('the first NVRAM is the baseline: no event for the counter, the setting is announced once', () => {
    const tb = new Table({ count: 41 });
    expect(tb.events).toEqual([expect.objectContaining({ kind: 'table_loaded' }), { kind: 'midnight_setting', t: 0.5, setting: { enabled: true, adjustment: 'A.2 14 Special Mode' } }]);
    expect(tb.detector.midnightCounter).toBe('B.4 31 SPECIAL MODES');
    expect(tb.detector.midnightSetting).toEqual({ enabled: true, adjustment: 'A.2 14 Special Mode' });
  });

  it('the counter going up while a game is in play is a Midnight Madness, with the ball it happened on', () => {
    const tb = new Table({ count: 3 });
    expect(kinds(tb.start())).toEqual(['game_start']);
    tb.buf[BALL] = 2;
    expect(kinds(tb.step())).toEqual(['ball_end']);
    tb.setCount(4);
    expect(tb.step()).toEqual([{ kind: 'midnight_madness', t: 3, audit: 'B.4 31 SPECIAL MODES', from: 3, to: 4, player: 1, ball: 2 }]);
    // Once: the same value written again, and the rest of the game, say nothing more.
    expect(tb.detector.feed(JSON.stringify({ event: 'nvram_delta', t: 9, n: 1, d: [[COUNT + 2, 4, 4]] }))).toEqual([]);
    expect(kinds(tb.end())).toEqual(['ball_end', 'game_end']);
    expect(midnights(tb.events)).toHaveLength(1);
    // Not a game event: nothing is counted.
    expect(tb.detector.summary()).toMatchObject({ inGame: false, counts: { game_start: 1, ball_end: 2, game_end: 1 } });
    // A second one in the next game counts again, from the new baseline.
    tb.start();
    tb.setCount(5);
    expect(tb.step()).toMatchObject([{ kind: 'midnight_madness', from: 4, to: 5, ball: 1 }]);
  });

  it('a periodic snapshot that shows a higher count during a game says so too', () => {
    const tb = new Table({ count: 3, watch: gameStateOffsets(CONGO) });
    tb.start();
    tb.setCount(4);
    expect(tb.step()).toEqual([]);
    expect(tb.full()).toMatchObject([{ kind: 'midnight_madness', from: 3, to: 4, ball: 1 }]);
  });

  it('the counter going up with no game in play is not one: before any game, and between games; the baseline moves', () => {
    const tb = new Table({ count: 3 });
    tb.setCount(4);
    expect(tb.step()).toEqual([]);
    tb.start();
    tb.end();
    tb.setCount(6);
    expect(tb.step()).toEqual([]);
    // The next game starts from 6: going to 6 again is nothing, going to 7 is one.
    tb.start();
    expect(tb.step()).toEqual([]);
    tb.setCount(7);
    expect(tb.step()).toMatchObject([{ kind: 'midnight_madness', from: 6, to: 7 }]);
  });

  it('a decrease is never one (an audit reset in the service menu), and it moves the baseline', () => {
    const tb = new Table({ count: 9 });
    tb.start();
    tb.setCount(0);
    expect(tb.step()).toEqual([]);
    tb.setCount(1);
    expect(tb.step()).toMatchObject([{ kind: 'midnight_madness', from: 0, to: 1 }]);
  });

  it("a WPC boot's RAM test (0x55, then 0xAA, then the real bytes, no game open) flags nothing and leaves the setting as it was", () => {
    const tb = new Table({ count: 3 });
    const real = Uint8Array.from(tb.buf);
    for (const fill of [0x55, 0xaa]) {
      for (const off of [COUNT, COUNT + 1, COUNT + 2, SETTING, SETTING + 1]) tb.buf[off] = fill;
      const out = tb.step();
      expect(midnights(out)).toEqual([]);
      // The first fill takes the reading away; the second is no news.
      expect(out).toEqual(fill === 0x55 ? [{ kind: 'midnight_setting', t: 1, setting: null }] : []);
      expect(tb.detector.midnightSetting).toBeNull();
    }
    tb.buf.set(real);
    expect(tb.step()).toEqual([{ kind: 'midnight_setting', t: 3, setting: { enabled: true, adjustment: 'A.2 14 Special Mode' } }]);
    tb.start();
    expect(midnights(tb.events)).toEqual([]);
  });

  it('the setting follows the adjustment: OFF at load, ON after the operator changes it', () => {
    const tb = new Table({ setting: 0 });
    expect(tb.detector.midnightSetting).toEqual({ enabled: false, adjustment: 'A.2 14 Special Mode' });
    tb.buf[SETTING + 1] = 1;
    expect(tb.step()).toEqual([{ kind: 'midnight_setting', t: 1, setting: { enabled: true, adjustment: 'A.2 14 Special Mode' } }]);
    expect(tb.detector.midnightSetting).toEqual({ enabled: true, adjustment: 'A.2 14 Special Mode' });
  });

  it('congo_20: the counter is monitored, the setting is not read; a map set after the first NVRAM takes its baseline then', () => {
    const tb = new Table({ rom: 'congo_20', count: 3 });
    expect(kinds(tb.events)).toEqual(['table_loaded']);
    expect(tb.detector.midnightSetting).toBeNull();
    tb.start();
    tb.setCount(4);
    expect(tb.step()).toMatchObject([{ kind: 'midnight_madness', from: 3, to: 4 }]);

    const late = new JournalDetector();
    late.feed(JSON.stringify({ event: 'table_loaded', t: 0, table: 'Congo', recipe: 'A', rom: 'congo_21', lib: '0.5.1', session: 's', locked: false }));
    const buf = new Uint8Array(0x3000);
    buf[GAME_OVER] = 1;
    buf[COUNT + 2] = 7;
    buf[SETTING + 1] = 1;
    expect(late.feed(JSON.stringify({ event: 'nvram_full', t: 0.5, bytes: [...buf] }))).toEqual([]);
    expect(late.midnightSetting).toBeNull();
    late.setMap(CONGO);
    expect(late.midnightSetting).toEqual({ enabled: true, adjustment: 'A.2 14 Special Mode' });
    // In play, 7 again is the baseline, 8 is one.
    const d = (...t: [number, number][]) => late.feed(JSON.stringify({ event: 'nvram_delta', t: 2, n: t.length, d: t.map(([i, v]) => [i, v, 0]) }));
    expect(kinds(d([GAME_OVER, 0], [PLAYER, 1], [BALL, 1]))).toEqual(['game_start', 'midnight_setting']);
    expect(midnights(d([COUNT + 2, 8]))).toMatchObject([{ from: 7, to: 8, ball: 1 }]);
  });

  it('a machine with no such audit is not monitored: nothing, whatever its bytes do', async () => {
    const mm = await mapOf('mm_109c');
    const det = new JournalDetector({ mapFor: () => mm });
    det.feed(JSON.stringify({ event: 'table_loaded', t: 0, table: 'MM', recipe: 'A', rom: 'mm_109c', lib: '0.5.1', session: 's', locked: false }));
    const buf = new Uint8Array(0x3000);
    expect(det.feed(JSON.stringify({ event: 'nvram_full', t: 0.5, bytes: [...buf] }))).toEqual([]);
    buf.fill(9, 6000, 8000);
    const out = det.feed(JSON.stringify({ event: 'nvram_full', t: 5, bytes: [...buf] }));
    expect(out.filter((e) => e.kind === 'midnight_madness' || e.kind === 'midnight_setting')).toEqual([]);
    expect(det.midnightCounter).toBeNull();
    expect(det.midnightSetting).toBeNull();
  });
});
