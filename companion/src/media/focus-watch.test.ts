import { describe, expect, it } from 'vitest';
import { isVpxExe, parseFocusLine } from './focus-watch.js';

describe('focus watch (D1.9)', () => {
  it('VPX is any VPinballX build; anything else in front is not', () => {
    for (const exe of ['VPinballX', 'VPinballX64', 'VPinballX_GL64', 'vpinballx']) expect(isVpxExe(exe)).toBe(true);
    for (const exe of ['Discord', 'explorer', 'B2SBackglassServerEXE', 'Castcade', '']) expect(isVpxExe(exe)).toBe(false);
  });

  it('reads the watcher\'s JSON lines and ignores anything else', () => {
    expect(parseFocusLine('{"pid":17128,"exe":"Code"}\r')).toEqual({ pid: 17128, exe: 'Code' });
    expect(parseFocusLine('{"pid":0,"exe":""}')).toEqual({ pid: 0, exe: '' });
    expect(parseFocusLine('Add-Type : warning')).toBeNull();
    expect(parseFocusLine('{"pid":"x"}')).toBeNull();
    expect(parseFocusLine('{broken')).toBeNull();
  });
});
