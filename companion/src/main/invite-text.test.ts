/**
 * The final review (2026-11-28, finding 5): the Join card's Paste takes everything the invite's own Copy buttons
 * give. The function is the renderer's (`renderer/src/invite-text.ts`, not part of this project's TypeScript build:
 * loaded by path); what Copy gives is made here with the main process's own functions.
 */
import { describe, expect, it } from 'vitest';
import { formatJoinLink, formatWebJoinLink, inviteMessage, parseJoinLink } from './deep-link.js';

const load = (): Promise<{ inviteFromText(text: string): string | null }> => import(/* @vite-ignore */ new URL('../../renderer/src/invite-text.ts', import.meta.url).href);

describe("the Join card's Paste (the final review, finding 5)", () => {
  it('takes the code, the web link, the castcade link, and the chat line with either link in it; and nothing else', async () => {
    const { inviteFromText } = await load();
    const web = formatWebJoinLink('JHDFEF', 'https://arcaid.app') as string;
    const plain = formatJoinLink('JHDFEF');
    expect(web).toBe('https://arcaid.app/castcade/join/JHDFEF');
    // Copy code.
    expect(inviteFromText('JHDFEF')).toBe('JHDFEF');
    expect(inviteFromText('  jhdfef\n')).toBe('JHDFEF');
    // Copy link, in both forms: it was refused ("The clipboard does not hold a Castcade link or invite").
    expect(inviteFromText(web)).toBe(web);
    expect(inviteFromText(plain)).toBe(plain);
    // Copy for chat, in both forms: the link is taken out of the line.
    expect(inviteFromText(inviteMessage(web, 'Monster Bash (Williams 1998)'))).toBe(web);
    expect(inviteFromText(inviteMessage(plain, 'Monster Bash (Williams 1998)'))).toBe(plain);
    expect(inviteFromText(`come play: ${web}.`)).toBe(web);
    // An address invite (a lobby reached at its PC's address).
    expect(inviteFromText('castcade:ws://203.0.113.7:27401#JHDFEF')).toBe('castcade:ws://203.0.113.7:27401#JHDFEF');
    // What Paste hands on is what a join by link understands.
    for (const text of [web, plain, inviteMessage(web, null), inviteMessage(plain, 'Congo')]) expect(parseJoinLink(inviteFromText(text) as string)).not.toBeNull();
    // Nothing of Castcade's.
    expect(inviteFromText('')).toBeNull();
    expect(inviteFromText('hello there')).toBeNull();
    expect(inviteFromText('https://example.org/some/page')).toBeNull();
    expect(inviteFromText('ABCDEFG')).toBeNull();
  });
});
