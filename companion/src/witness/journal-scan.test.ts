import { describe, expect, it } from 'vitest';
import { MemoryFs } from './fs.js';
import { newestJournalSince, parseSessionStamp } from './journal-scan.js';

const T0 = new Date(2026, 9, 30, 3, 0, 0).getTime();

function stamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const loaded = (table: string, atMs: number) => `{"event":"table_loaded","t":0,"table":"${table}","recipe":"A","rom":"tftc_400","lib":"0.4.0","session":"${stamp(atMs)}","locked":false}`;
const delta = '{"event":"nvram_delta","t":12.5,"n":1,"d":[[1,2,3]]}';

describe('newestJournalSince (B18)', () => {
  it('takes the journal with the newest table_loaded inside the window', async () => {
    const fs = new MemoryFs(() => T0);
    fs.put('/journal/Older_Table.jsonl', loaded('Older Table', T0 + 10_000) + '\n' + delta + '\n', T0 + 20_000);
    fs.put('/journal/Newest_Table.jsonl', loaded('Newest Table', T0 + 60_000) + '\n' + delta + '\n', T0 + 70_000);
    fs.put('/journal/notes.txt', loaded('Not a journal', T0 + 90_000) + '\n', T0 + 90_000);
    const c = await newestJournalSince(fs, '/journal', T0);
    expect(c).toEqual({
      tableId: 'Newest_Table',
      table: 'Newest Table',
      path: '/journal/Newest_Table.jsonl',
      sessionStamp: stamp(T0 + 60_000),
      stampMs: parseSessionStamp(stamp(T0 + 60_000)),
      mtimeMs: T0 + 70_000,
    });
  });

  it('never opens a file last written before the window', async () => {
    const fs = new MemoryFs(() => T0);
    // The stamp alone would qualify; the mtime says the file was not written during this process.
    fs.put('/journal/Stale.jsonl', loaded('Stale', T0 + 60_000) + '\n', T0 - 1);
    const opened: string[] = [];
    const readFile = fs.readFile.bind(fs);
    fs.readFile = async (p) => {
      opened.push(p);
      return readFile(p);
    };
    expect(await newestJournalSince(fs, '/journal', T0)).toBeNull();
    expect(opened).toEqual([]);
  });

  it('a table_loaded stamped before the window disqualifies the file, however recently it was written', async () => {
    const fs = new MemoryFs(() => T0);
    fs.put('/journal/Yesterday.jsonl', loaded('Yesterday', T0 - 24 * 3_600_000) + '\n' + delta + '\n', T0 + 5_000);
    expect(await newestJournalSince(fs, '/journal', T0)).toBeNull();
  });

  it('uses the last table_loaded of a file holding two sessions, and tolerates a torn last line', async () => {
    const fs = new MemoryFs(() => T0);
    const text = [loaded('Two Sessions', T0 - 3_600_000), delta, loaded('Two Sessions', T0 + 30_000), delta, '{"event":"nvram_del'].join('\n');
    fs.put('/journal/Two_Sessions.jsonl', text, T0 + 40_000);
    const c = await newestJournalSince(fs, '/journal', T0);
    expect(c).toMatchObject({ tableId: 'Two_Sessions', table: 'Two Sessions', sessionStamp: stamp(T0 + 30_000) });
  });

  it('a missing journal directory is nothing found', async () => {
    expect(await newestJournalSince(new MemoryFs(() => T0), '/journal', T0)).toBeNull();
  });
});
