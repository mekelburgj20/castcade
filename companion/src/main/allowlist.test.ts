import { describe, expect, it } from 'vitest';
import { isAllowedExternalUrl } from './allowlist.js';

describe('isAllowedExternalUrl', () => {
  const base = 'https://arcaid.app';

  it('allows the configured ArcAid origin, any path', () => {
    expect(isAllowedExternalUrl('https://arcaid.app/account', base)).toBe(true);
    expect(isAllowedExternalUrl('https://arcaid.app/', base)).toBe(true);
    expect(isAllowedExternalUrl('http://localhost:3001/account', 'http://localhost:3001')).toBe(true);
  });

  it('allows the project GitHub page and its subpaths only', () => {
    expect(isAllowedExternalUrl('https://github.com/mekelburgj20/castcade', base)).toBe(true);
    expect(isAllowedExternalUrl('https://github.com/mekelburgj20/castcade/releases', base)).toBe(true);
    expect(isAllowedExternalUrl('https://github.com/mekelburgj20/castcade-evil', base)).toBe(false);
    expect(isAllowedExternalUrl('https://github.com/someone/else', base)).toBe(false);
    expect(isAllowedExternalUrl('https://github.com/', base)).toBe(false);
  });

  it('refuses other hosts, lookalikes, schemes and credentials', () => {
    expect(isAllowedExternalUrl('https://arcaid.app.evil.com/', base)).toBe(false);
    expect(isAllowedExternalUrl('https://evil.com/?x=https://arcaid.app', base)).toBe(false);
    expect(isAllowedExternalUrl('http://arcaid.app/', base)).toBe(false); // scheme is part of the origin
    expect(isAllowedExternalUrl('https://arcaid.app:8443/', base)).toBe(false);
    expect(isAllowedExternalUrl('https://user:pw@arcaid.app/', base)).toBe(false);
    expect(isAllowedExternalUrl('file:///C:/Windows/system32/calc.exe', base)).toBe(false);
    expect(isAllowedExternalUrl('javascript:alert(1)', base)).toBe(false);
    expect(isAllowedExternalUrl('not a url', base)).toBe(false);
    expect(isAllowedExternalUrl('https://arcaid.app/', 'garbage')).toBe(false);
  });

  it('follows the configured origin when it changes', () => {
    expect(isAllowedExternalUrl('https://arcaid.app/account', 'http://localhost:3001')).toBe(false);
  });
});
