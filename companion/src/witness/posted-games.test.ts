import { describe, expect, it } from 'vitest';
import { MemoryFs } from './fs.js';
import { attemptKey, createPostedGames, MAX_POSTED_GAMES, POSTED_GAMES_FILE, postedGameKey } from './posted-games.js';

const FILE = `/data/${POSTED_GAMES_FILE}`;

describe('posted games (B17)', () => {
  it('keys a game by table and the attempt key ArcAid sees', () => {
    expect(attemptKey('2026-10-28T21:04:11', 123, 41.2345)).toBe('2026-10-28T21:04:11#41235');
    expect(attemptKey(null, 1_760_000_000_000, 2)).toBe('1760000000000#2000');
    expect(attemptKey(null, null, 2)).toBe('0#2000');
    expect(postedGameKey('TFTC', '2026-10-28T21:04:11#41235')).toBe('TFTC@2026-10-28T21:04:11#41235');
  });

  it('remembers an added key across a reload from the same files', async () => {
    const fs = new MemoryFs();
    const a = createPostedGames(fs, '/data', () => 1_760_000_000_000);
    await a.load();
    expect(a.has('T@s#1')).toBe(false);
    await a.add('T@s#1');
    await a.add('T@s#1');
    expect(a.has('T@s#1')).toBe(true);
    expect(a.size()).toBe(1);
    expect(fs.text(FILE)).toContain('"T@s#1": "2025-10-09T08:53:20.000Z"');

    const b = createPostedGames(fs, '/data');
    await b.load();
    expect(b.has('T@s#1')).toBe(true);
    expect(b.has('T@s#2')).toBe(false);
  });

  it('loads a missing file as empty, and a garbage file as empty that the next add rewrites cleanly', async () => {
    const fs = new MemoryFs();
    const missing = createPostedGames(fs, '/data');
    await missing.load();
    expect(missing.size()).toBe(0);

    fs.put(FILE, '{"version":1,"keys":{"T@s#1":');
    const torn = createPostedGames(fs, '/data');
    await torn.load();
    expect(torn.size()).toBe(0);
    await torn.add('T@s#2');
    expect(JSON.parse(fs.text(FILE)!)).toEqual({ version: 1, keys: { 'T@s#2': expect.any(String) } });
  });

  it(`keeps only the newest ${MAX_POSTED_GAMES} keys`, async () => {
    const fs = new MemoryFs();
    let t = 1_760_000_000_000;
    const p = createPostedGames(fs, '/data', () => (t += 1000));
    await p.load();
    for (let i = 0; i < MAX_POSTED_GAMES + 5; i++) await p.add(`T@s#${i}`);
    expect(p.size()).toBe(MAX_POSTED_GAMES);
    expect(p.has('T@s#4')).toBe(false);
    expect(p.has('T@s#5')).toBe(true);
    expect(p.has(`T@s#${MAX_POSTED_GAMES + 4}`)).toBe(true);
    const reloaded = createPostedGames(fs, '/data');
    await reloaded.load();
    expect(reloaded.size()).toBe(MAX_POSTED_GAMES);
    expect(reloaded.has('T@s#0')).toBe(false);
  });
});
