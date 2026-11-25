/**
 * A17 step 9 (2026-11-27): the story fixtures are true to the code, the shell's half. The sentences on the lobby's
 * screens that the controller does not make (match/story-fixtures.test.ts holds those) are each one function of the
 * shell, of one-step, of the transport or of the resume record: here every fixture that shows one is held against
 * that function, word for word. A sentence typed into a fixture from memory does not pass.
 */
import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@castcade/protocol';
import { lobbyFullSentence } from '../match/host.js';
import { shortName } from '../match/short-name.js';
import { ForeignVersionError, refusalSentence } from '../match/transport-ws.js';
import { formatWebJoinLink, inviteMessage } from './deep-link.js';
import { cannotSaveSentence, refusalShown, RELAY_WAITING, reopenedSentence, unpairedClosedSentence } from './match-host.js';
import { oldRecordSentence } from './match-resume.js';
import { changeWords, noCopyAtJoinWords } from './one-step.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
// The story files are not part of this project's TypeScript build (they are loosely typed, for the browser): loaded by path.
const story = (file: string): Promise<any> => import(/* @vite-ignore */ new URL(`../../renderer/story/${file}`, import.meta.url).href);

describe("the story fixtures say what the shell says (A17 step 9)", () => {
  it('every sentence of the shell, of one-step, of the transport and of the resume record that a fixture shows', async () => {
    const fx = await story('fixtures.ts');
    const base = await story('base.ts');
    const F = fx.FIXTURES as Record<string, any>;
    const CODE: string = fx.CODE;
    const said = new Set<string>();
    const error = (name: string): string => {
      said.add(name);
      return F[name].lastError;
    };

    // ---- a table change, as this PC's one-step says it (and the panel's line with it)
    const changes = Object.entries(F).filter(([, f]) => f.change);
    expect(changes.map(([name]) => name).sort()).toEqual(['table-asked-after-away', 'table-changing', 'table-close-it', 'table-open-it']);
    for (const [name, f] of changes) {
      const c = f.change;
      expect(c.detail, name).toBe(changeWords(c.state, c.table, c.open, c.why, c.by));
      expect(f.message, name).toBe(c.detail);
    }
    // The three kinds the pictures show: a PC that closes by itself, one whose person closes the table, one that asks first.
    expect(F['table-changing'].change.state).toBe('closing');
    expect(F['table-close-it'].change.state).toBe('close_it');
    expect([F['table-open-it'].change.why, F['table-asked-after-away'].change.why]).toEqual(['often', 'away']);

    // ---- no copy of the lobby's table at the join
    expect(F['no-table'].launch).toEqual({ state: 'needed', table: fx.TABLE, detail: noCopyAtJoinWords(fx.TABLE) });

    // ---- the invite: the link and the line for a chat
    const st = fx.status(F['four-player'], base.MATCH);
    expect(st.oneStep.link).toBe(formatWebJoinLink(CODE, 'https://arcaid.app'));
    expect(st.oneStep.message).toBe(inviteMessage(st.oneStep.link, fx.TABLE));

    // ---- a long name is cut in the fixtures as the code cuts it
    expect(fx.LONG_NAME).toHaveLength(64);
    expect(fx.shown(fx.LONG_NAME)).toBe(shortName(fx.LONG_NAME));
    expect(shortName(fx.LONG_NAME)).toHaveLength(24);
    expect(shortName('Krobs')).toBe('Krobs');

    // ---- what went wrong, at the top of the tab
    expect(error('resume-v1')).toBe(oldRecordSentence({ code: CODE, names: ['Owner'] } as Parameters<typeof oldRecordSentence>[0]));
    // The fixtures were written for the protocol this build speaks.
    expect(PROTOCOL_VERSION).toBe(7);
    expect(error('refused-old-here')).toBe(new ForeignVersionError(PROTOCOL_VERSION - 1).message);
    expect(error('refused-old-there')).toBe(refusalShown({ code: 'protocol_version', message: refusalSentence(PROTOCOL_VERSION - 1) }));
    expect(error('refused-full')).toBe(refusalShown({ code: 'match_full', message: lobbyFullSentence(4) }));
    expect(error('unpaired-closed')).toBe(unpairedClosedSentence(CODE));
    expect(error('cannot-save')).toBe(cannotSaveSentence(fx.SAVE_FOLDER, fx.SAVE_ERROR));
    expect(error('relay-waiting')).toBe(reopenedSentence(CODE, null, true));
    expect(F['relay-waiting'].relayNote).toBe(RELAY_WAITING);
    // No fixture shows a sentence at the top of the tab that is not held above.
    expect(Object.keys(F).filter((name) => F[name].lastError != null && !said.has(name))).toEqual([]);
  });
});
