import { describe, expect, it } from 'vitest';
import { MemoryFs } from './fs.js';
import { findTableFile, tableBaseName, tableRootsFor } from './table-locator.js';

const EXE = 'C:\\VPX\\VPinballX_GL64.exe';

function rig(): MemoryFs {
  const fs = new MemoryFs();
  fs.put('C:\\VPX\\VPinballX_GL64.exe', 'exe');
  fs.put('C:\\VPX\\tables\\Monster Bash (Williams 1998) VPWmod v1.0.vpx', 'vpx');
  fs.put('C:\\VPX\\tables\\Monster Bash (Williams 1998) VPWmod v1.0.ini', 'ini');
  fs.put('C:\\VPX\\tables\\Williams\\Medieval Madness (Williams 1997) VPW v1.0.1.vpx', 'vpx');
  fs.put('C:\\VPX\\tables\\a\\b\\c\\Deep.vpx', 'vpx');
  fs.put('D:\\Frontend\\Tables\\Tales from the Crypt (Data East 1993) VPW v1.22.vpx', 'vpx');
  return fs;
}

describe('table locator', () => {
  it('finds the tables folder beside the exe (any case) and appends overrides once', async () => {
    const fs = rig();
    expect(await tableRootsFor(fs, EXE)).toEqual(['C:\\VPX\\tables']);
    expect(await tableRootsFor(fs, EXE, ['D:\\Frontend\\Tables', ' ', null, 'c:\\vpx\\TABLES'])).toEqual(['C:\\VPX\\tables', 'D:\\Frontend\\Tables']);
    expect(await tableRootsFor(fs, null, ['D:\\Frontend\\Tables'])).toEqual(['D:\\Frontend\\Tables']);
    expect(await tableRootsFor(fs, 'C:\\nowhere\\VPinballX64.exe')).toEqual([]);
  });

  it('finds a table by its name, case-insensitively, up to the depth limit', async () => {
    const fs = rig();
    const roots = await tableRootsFor(fs, EXE, ['D:\\Frontend\\Tables']);
    expect(await findTableFile(fs, 'Monster Bash (Williams 1998) VPWmod v1.0', roots)).toBe('C:\\VPX\\tables\\Monster Bash (Williams 1998) VPWmod v1.0.vpx');
    expect(await findTableFile(fs, 'medieval madness (williams 1997) vpw v1.0.1', roots)).toBe('C:\\VPX\\tables\\Williams\\Medieval Madness (Williams 1997) VPW v1.0.1.vpx');
    expect(await findTableFile(fs, 'Tales from the Crypt (Data East 1993) VPW v1.22', roots)).toBe('D:\\Frontend\\Tables\\Tales from the Crypt (Data East 1993) VPW v1.22.vpx');
    expect(await findTableFile(fs, 'Deep', roots)).toBeNull(); // four levels down, default depth is three
    expect(await findTableFile(fs, 'Deep', roots, { maxDepth: 4 })).toBe('C:\\VPX\\tables\\a\\b\\c\\Deep.vpx');
    expect(await findTableFile(fs, 'Nope', roots)).toBeNull();
    expect(await findTableFile(fs, '  ', roots)).toBeNull();
  });

  it('tableBaseName strips the directory and the extension only', () => {
    expect(tableBaseName('C:\\VPX\\tables\\Monster Bash (Williams 1998) VPWmod v1.0.vpx')).toBe('Monster Bash (Williams 1998) VPWmod v1.0');
    expect(tableBaseName('/t/Attack from Mars (Bally 1995) v2.0.1.VPX')).toBe('Attack from Mars (Bally 1995) v2.0.1');
  });
});
