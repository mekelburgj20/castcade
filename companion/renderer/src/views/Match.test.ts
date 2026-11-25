/**
 * The review of PR 144: what the Match tab itself decides about what a person reads (the rest is the controller's and
 * is held by the story tests): the row of the game's own presses, the lobby's invite (collapsed once somebody has
 * joined, open while alone, its region always there for `aria-controls`), and "starts from the table" only while the
 * lobby has a table. Drawn with React's server renderer: no window needed.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { hasControls, LobbyInvite, memberWords } from './Match.js';

type Lobby = NonNullable<MatchStatus['lobby']>;
type Member = Lobby['members'][number];

const member = (id: string, o: Partial<Member> = {}): Member => ({ id, name: id[0]!.toUpperCase() + id.slice(1), rig: 'vr_headset', stance: 'play', opener: false, me: false, starter: false, inMatch: false, flags: [], awaySince: null, ...o });

/** A Match status in a lobby, with what a case needs (the rest empty). */
function status(o: { lobby?: Partial<Lobby>; st?: Partial<MatchStatus> } = {}): MatchStatus {
  const lobby = {
    stance: 'play',
    starter: 'owner',
    members: [member('owner', { opener: true, me: true, starter: true })],
    match: null,
    table: { name: 'Monster Bash (Williams 1998)', pickedBy: 'owner', pickedByName: 'Owner', off: null, endsMatch: false, changing: false },
    start: null,
    startButton: { label: 'Start match', line: '', off: null },
    tabLine: null,
    newMatch: null,
    gameKey: '',
    startWithout: null,
    end: null,
    giveUp: false,
    hostAway: null,
    over: false,
    lastMatch: null,
    waitedFor: null,
    awayQuestion: null,
    ...o.lobby,
  } as unknown as Lobby;
  return { role: 'host', phase: 'lobby', transfer: null, canResume: false, pass: null, endBall: null, invite: 'JHDFEF', via: 'relay', relayNote: null, lastError: null, directInvite: null, portMapping: null, ipSource: null, port: 27401, hostId: 'owner', participants: [], lobby, ...o.st } as unknown as MatchStatus;
}

describe('the row of the game`s own presses (hasControls)', () => {
  it('is not drawn in a lobby with nothing to press (it stood empty, a band of space)', () => {
    expect(hasControls(status())).toBe(false);
    expect(hasControls(status({ st: { role: 'client' } }))).toBe(false);
  });

  it('is drawn for each of its six buttons, by that button`s own condition', () => {
    expect(hasControls(status({ st: { phase: 'paused', canResume: true } }))).toBe(true);
    expect(hasControls(status({ st: { phase: 'paused', canResume: true, transfer: { reason: 'host_left', proposer: 'x', newHost: null } as never } }))).toBe(false);
    expect(hasControls(status({ st: { role: 'client', phase: 'paused', canResume: true } }))).toBe(false);
    expect(hasControls(status({ st: { phase: 'playing', pass: { name: 'Krobs', ball: 1, score: 10 } as never } }))).toBe(true);
    expect(hasControls(status({ st: { role: 'client', phase: 'playing', endBall: { score: 10 } as never } }))).toBe(true);
    expect(hasControls(status({ st: { phase: 'lobby', endBall: { score: 10 } as never } }))).toBe(false);
    expect(hasControls(status({ lobby: { giveUp: true } }))).toBe(true);
    expect(hasControls(status({ lobby: { end: 'match' } }))).toBe(true);
    expect(hasControls(status({ lobby: { end: 'everyone' } }))).toBe(true);
  });
});

describe('the lobby`s invite (LobbyInvite)', () => {
  const one = { link: 'https://arcaid.app/castcade/join/JHDFEF', message: 'Castcade lobby: https://arcaid.app/castcade/join/JHDFEF' } as unknown as OneStepStatus;
  const draw = (members: number): string =>
    renderToStaticMarkup(createElement(LobbyInvite, { bridge: {} as CastcadeBridge, st: status({ lobby: { members: ['owner', 'krobs', 'chuck', 'dana'].slice(0, members).map((id) => member(id)) } }), one }));

  it('is open while the lobby`s PC is alone: the link and how to send it are in sight', () => {
    const html = draw(1);
    expect(html).toContain('aria-expanded="true"');
    expect(html).toMatch(/<div id="lobby-invite-more" class="cc-stack">/);
    expect(html).toContain('Send the code or the link');
  });

  it('is its Copy buttons once somebody has joined; what opens is still there, hidden, so the toggle`s aria-controls names it', () => {
    const html = draw(2);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-controls="lobby-invite-more"');
    expect(html).toMatch(/<div id="lobby-invite-more" class="cc-stack" hidden="">/);
    for (const copy of ['Copy code', 'Copy link', 'Copy for chat']) expect(html).toContain(copy);
  });
});

describe('a member`s row (memberWords)', () => {
  it('says the starter "starts from the table" only while the lobby has a table, and not during a game', () => {
    expect(memberWords(status(), 'owner', 0).text).toBe(' · VR · PLAY · starts from the table');
    expect(memberWords(status({ lobby: { table: { name: null, pickedBy: null, pickedByName: null, off: null, endsMatch: false, changing: false } } }), 'owner', 0).text).toBe(' · VR · PLAY');
    expect(memberWords(status({ st: { phase: 'playing' } }), 'owner', 0).text).toBe(' · VR · PLAY');
  });

  it('says AWAY with the time since, as this PC has known it', () => {
    const st = status({ lobby: { members: [member('owner', { starter: true }), member('dana', { rig: 'pc', flags: ['away'], awaySince: 0 })] } });
    expect(memberWords(st, 'dana', 42_000)).toEqual({ text: ' · PC · PLAY', flags: ['AWAY 0:42'] });
  });
});
