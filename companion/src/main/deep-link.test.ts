/** A14 (2026-11-12): the join link is untrusted input: only the exact shape is taken, and only an invite comes out. */
import { describe, expect, it } from 'vitest';
import {
  formatJoinLink,
  formatWebJoinLink,
  inviteFacts,
  inviteMessage,
  linkFromArgv,
  linkIsTrusted,
  looksLikeLink,
  looksLikePastedLink,
  parseJoinLink,
  registerLinkProtocol,
} from './deep-link.js';

const ADDRESS = 'castcade:ws://203.0.113.7:27401#ABCDEF';

describe('the join link (A14)', () => {
  it('carries either invite, URL-encoded, and reads back to the same invite', () => {
    expect(formatJoinLink('JHDFEF')).toBe('castcade://join/JHDFEF');
    expect(formatJoinLink(ADDRESS)).toBe('castcade://join/castcade%3Aws%3A%2F%2F203.0.113.7%3A27401%23ABCDEF');
    expect(formatJoinLink('castcade:ws://[2001:db8::1]:27401#ABCDEF')).toBe('castcade://join/castcade%3Aws%3A%2F%2F%5B2001%3Adb8%3A%3A1%5D%3A27401%23ABCDEF');
    expect(parseJoinLink('castcade://join/JHDFEF')).toEqual({ invite: 'JHDFEF', code: 'JHDFEF', address: null });
    expect(parseJoinLink('castcade://join/jhdfef/')).toEqual({ invite: 'JHDFEF', code: 'JHDFEF', address: null });
    expect(parseJoinLink(formatJoinLink(ADDRESS)!)).toEqual({ invite: ADDRESS, code: 'ABCDEF', address: '203.0.113.7:27401' });
    expect(parseJoinLink('CASTCADE://JOIN/JHDFEF')?.code).toBe('JHDFEF');
    expect(parseJoinLink(formatJoinLink('castcade:ws://[2001:db8::1]:27401#abcdef')!)).toMatchObject({ code: 'ABCDEF', address: '[2001:db8::1]:27401' });
    expect(formatJoinLink('not an invite')).toBeNull();
  });

  it('refuses everything that is not exactly a join link', () => {
    const bad = [
      '',
      'castcade://join/',
      'castcade://join',
      'castcade://host/JHDFEF',
      'castcade://join/JHDFEF?x=1',
      'castcade://join/JHDFEF#frag',
      'castcade://join/JHDFEF/extra',
      'castcade://join/JHDFE', // five letters
      'castcade://join/JHDFEF1',
      'castcade://join/JHDFEF --gpu-launcher=calc.exe',
      'castcade://join/JHDFEF" --inspect',
      'castcade://join/..%2F..%2Fwindows%2Fsystem32',
      'castcade://join/C%3A%5CWindows%5Csystem32%5Ccalc.exe',
      'castcade://join/%E0%A4%A', // not valid percent-encoding
      'castcade://join/castcade%3Awss%3A%2F%2Fexample.org%3A443%23ABCDEF', // not ws://
      'castcade://join/castcade%3Aws%3A%2F%2Fexample.org%3A99999%23ABCDEF', // not a port
      'castcade://join/castcade%3Aws%3A%2F%2Fexample.org%3A27401%2Fpath%23ABCDEF',
      'castcade://join/castcade%3Aws%3A%2F%2Fuser%40example.org%3A27401%23ABCDEF',
      'castcade://join/file%3A%2F%2F%2Fetc%2Fpasswd',
      'https://example.org/castcade://join/JHDFEF',
      ' castcade://join/JHDFEF\ncastcade://join/ABCDEF',
      `castcade://join/${'A'.repeat(400)}`,
      ADDRESS, // an invite, not a link
    ];
    for (const text of bad) expect(parseJoinLink(text), text).toBeNull();
    expect(parseJoinLink(undefined as unknown as string)).toBeNull();
  });

  it('inviteFacts takes the two invite shapes and nothing else', () => {
    expect(inviteFacts('abcdef')).toEqual({ invite: 'ABCDEF', code: 'ABCDEF', address: null });
    expect(inviteFacts(ADDRESS)).toEqual({ invite: ADDRESS, code: 'ABCDEF', address: '203.0.113.7:27401' });
    expect(inviteFacts('castcade:ws://203.0.113.7:0#ABCDEF')).toBeNull();
    expect(inviteFacts('castcade:JHDFEF')).toBeNull();
  });

  it('from the command line only an argument that starts with castcade:// is looked at', () => {
    expect(linkFromArgv(['C:\\Program\\Castcade.exe', '--hidden'])).toBeNull();
    expect(linkFromArgv(['C:\\Program\\Castcade.exe', '--allow-file-access-from-files', 'castcade://join/JHDFEF'])).toBe('castcade://join/JHDFEF');
    expect(linkFromArgv(['Castcade.exe', '--x=castcade://join/JHDFEF'])).toBeNull();
    // Whatever it finds is still only text: a bad one is refused by the parser.
    expect(parseJoinLink(linkFromArgv(['Castcade.exe', 'castcade://join/JHDFEF --no-sandbox'])!)).toBeNull();
    expect(looksLikeLink('  Castcade://join/x')).toBe(true);
    expect(looksLikeLink(ADDRESS)).toBe(false);
  });

  it('the chat line says the table and what to do with a link that is not clickable', () => {
    expect(inviteMessage('castcade://join/JHDFEF', 'Monster Bash')).toBe('Castcade match on Monster Bash: castcade://join/JHDFEF (copy the link, then in Castcade press Match, Paste, Join)');
    expect(inviteMessage('https://arcaid.app/castcade/join/JHDFEF', 'Monster Bash')).toBe('Castcade match on Monster Bash: https://arcaid.app/castcade/join/JHDFEF');
    expect(inviteMessage('castcade://join/JHDFEF', null)).toBe('Castcade match: castcade://join/JHDFEF (copy the link, then in Castcade press Match, Paste, Join)');
  });
});

describe('registering castcade:// and trusting a link (A14)', () => {
  const fake = (answer: boolean | Error) => {
    const calls: unknown[][] = [];
    return {
      calls,
      app: {
        setAsDefaultProtocolClient: (...a: unknown[]) => {
          calls.push(a);
          if (answer instanceof Error) throw answer;
          return answer;
        },
      },
    };
  };

  it('the installed app registers the scheme for itself; a development run only when asked, with its own entry', () => {
    const packaged = fake(true);
    expect(registerLinkProtocol(packaged.app, { packaged: true, execPath: 'C:\\app\\Castcade.exe', devEntry: null })).toBe('links: castcade:// opens this app');
    expect(packaged.calls).toEqual([['castcade']]);

    const dev = fake(true);
    expect(registerLinkProtocol(dev.app, { packaged: false, execPath: 'C:\\node\\electron.exe', devEntry: null })).toMatch(/not registered \(a development run/);
    expect(dev.calls).toEqual([]);
    expect(registerLinkProtocol(dev.app, { packaged: false, execPath: 'C:\\node\\electron.exe', devEntry: 'C:\\repo\\companion' })).toBe('links: castcade:// opens this development run');
    expect(dev.calls).toEqual([['castcade', 'C:\\node\\electron.exe', ['C:\\repo\\companion']]]);
  });

  it('a refusal or an exception is a log line, never a crash', () => {
    expect(registerLinkProtocol(fake(false).app, { packaged: true, execPath: 'x', devEntry: null })).toMatch(/did not take/);
    expect(registerLinkProtocol(fake(new Error('registry locked')).app, { packaged: true, execPath: 'x', devEntry: null })).toBe('links: castcade:// could not be registered: registry locked');
  });

  it('a link acts without a click only when the window was on screen with the Match tab showing', () => {
    const on = { exists: true, visible: true, minimized: false, matchTab: true };
    expect(linkIsTrusted(on)).toBe(true);
    expect(linkIsTrusted({ ...on, matchTab: false })).toBe(false);
    expect(linkIsTrusted({ ...on, visible: false })).toBe(false);
    expect(linkIsTrusted({ ...on, minimized: true })).toBe(false);
    expect(linkIsTrusted({ ...on, exists: false })).toBe(false);
  });
});

describe('the clickable web join link (A14.2)', () => {
  it('is made only for a code invite and an https ArcAid; upper-case code, no trailing slash', () => {
    expect(formatWebJoinLink('jhdfef', 'https://arcaid.app/')).toBe('https://arcaid.app/castcade/join/JHDFEF');
    expect(formatWebJoinLink('JHDFEF', 'https://arcaid.app/some/path')).toBe('https://arcaid.app/castcade/join/JHDFEF');
    expect(formatWebJoinLink('castcade:ws://203.0.113.7:27401#ABCDEF', 'https://arcaid.app')).toBeNull();
    expect(formatWebJoinLink('JHDFEF', 'http://localhost:3001')).toBeNull();
    expect(formatWebJoinLink('JHDFEF', null)).toBeNull();
    expect(formatWebJoinLink('JHDFEF', 'not a url')).toBeNull();
    expect(formatWebJoinLink('nope', 'https://arcaid.app')).toBeNull();
  });

  it('pasted into the Join box it reads like the castcade:// form, and nothing else on the web does', () => {
    expect(parseJoinLink('https://arcaid.app/castcade/join/jhdfef')).toEqual({ invite: 'JHDFEF', code: 'JHDFEF', address: null });
    expect(parseJoinLink(' https://arcaid.app/castcade/join/JHDFEF/ ')).toEqual({ invite: 'JHDFEF', code: 'JHDFEF', address: null });
    expect(parseJoinLink('https://arcaid.app/castcade/join/castcade%3Aws%3A%2F%2F203.0.113.7%3A27401%23ABCDEF')?.address).toBe('203.0.113.7:27401');
    for (const bad of [
      'http://arcaid.app/castcade/join/JHDFEF',
      'https://arcaid.app/castcade/join/JHDFEF?x=1',
      'https://arcaid.app/castcade/join/JHDFEF/extra',
      'https://arcaid.app/castcade/join/JHDFE',
      'https://arcaid.app/other/JHDFEF',
      'https://user@arcaid.app/castcade/join/JHDFEF',
    ]) {
      expect(parseJoinLink(bad), bad).toBeNull();
    }
    expect(looksLikePastedLink('https://arcaid.app/castcade/join/JHDFEF')).toBe(true);
    expect(looksLikePastedLink('castcade://join/JHDFEF')).toBe(true);
    expect(looksLikePastedLink('JHDFEF')).toBe(false);
    expect(looksLikePastedLink('castcade:ws://203.0.113.7:27401#ABCDEF')).toBe(false);
    // The command line still takes only castcade://.
    expect(linkFromArgv(['Castcade.exe', 'https://arcaid.app/castcade/join/JHDFEF'])).toBeNull();
  });
});
