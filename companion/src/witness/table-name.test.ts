import { describe, expect, it } from 'vitest';
import { catalogueTableName } from './table-name.js';

describe('catalogueTableName', () => {
  it('cuts after the manufacturer/year parenthetical', () => {
    expect(catalogueTableName('Monster Bash (Williams 1998) VPWmod v1.0')).toBe('Monster Bash (Williams 1998)');
    expect(catalogueTableName('Medieval Madness (Williams 1997) VPW v1.0.1')).toBe('Medieval Madness (Williams 1997)');
    expect(catalogueTableName('Tales from the Crypt (Data East 1993) VPW v1.22')).toBe('Tales from the Crypt (Data East 1993)');
    expect(catalogueTableName('Iron Maiden LOTB (Original 2020)')).toBe('Iron Maiden LOTB (Original 2020)');
  });
  it('otherwise drops a trailing version token and leaves the rest alone', () => {
    expect(catalogueTableName('Blood Machines 2.0')).toBe('Blood Machines');
    expect(catalogueTableName('Monster Bash')).toBe('Monster Bash');
    expect(catalogueTableName('mb_106b')).toBe('mb_106b');
    expect(catalogueTableName('  Attack from Mars v1.2b ')).toBe('Attack from Mars');
  });
});
