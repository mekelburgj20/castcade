/**
 * The review of PR 144: the fixtures the pictures of the app's other tabs are drawn from (renderer/story/app-fixtures.ts)
 * say what the app says. Every sentence there that a function of the main process makes is held here against that
 * function, as the lobby's fixtures are (match/story-fixtures.test.ts, main/story-fixtures-shell.test.ts). What ArcAid
 * itself answers (a refusal, a tournament's reason, a server error's words) is ArcAid's and is not held here.
 */
import { describe, expect, it } from 'vitest';
import { ArcaidError } from '../witness/arcaid-client.js';
import { askToTurnOnWarning } from '../witness/ask-to-turn-on.js';
import { EXIT_RUNG_LETTER, exitRungFor } from '../witness/exit-rung.js';
import { attemptStartText, attemptStatusFor, logsNotSentText, NEEDS_START_TEXT } from '../witness/witness.js';
import { PREVIEW_OVERLAPS } from './stream-host.js';
import { installWaitReason } from './updater.js';
import { pathWords, watchTableLine } from './watch-host.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
// The story files are not part of this project's TypeScript build (they are loosely typed, for the browser): loaded by path.
const story = (file: string): Promise<any> => import(/* @vite-ignore */ new URL(`../../renderer/story/${file}`, import.meta.url).href);

describe('the app tabs` story fixtures say what the app says (the review of PR 144)', () => {
  it('Status: the attempt, Start attempts, the table read only at close', async () => {
    const fx = await story('app-fixtures.ts');
    const live = fx.STATUS_LIVE;
    expect(live.attempt.text).toBe(attemptStatusFor('mb', { state: 'done', wire: null, attempt: { status: 'counted', attempt: 3, of: 5, remaining: 2, late: false, game: live.attempt.game } } as never).text);
    expect(live.attemptStart.text).toBe(attemptStartText({ status: 'started', started: [{ game: 'Monster Bash', alreadyStarted: false }] } as never));
    expect(fx.STATUS_BASIC.attempt.text).toBe(NEEDS_START_TEXT);
    // A6.3: the warning as the witness words it for a 1 beside the exe and OpenComposite's dll there.
    const exe: string = fx.STATUS_BASIC.vpxExe;
    const dir = exe.slice(0, exe.lastIndexOf('\\'));
    expect(fx.STATUS_BASIC.vrSetupWarning).toBe(
      askToTurnOnWarning({ value: 1, ini: { kind: 'beside-exe', path: `${dir}\\VPinballX.ini` }, openvr: { kind: 'opencomposite', path: `${dir}\\openvr_api.dll` }, seenRuntime: null }, exe),
    );
    const close = fx.STATUS_UNPAIRED.lastClose;
    const rung = exitRungFor({ table: close.table, live: null, unpatched: { cls: 'A', clsReason: null, rom: 'afm_113b', patchable: true, support: { readable: true, reason: '' }, noMap: false, hadManifest: false, patchRemoved: false } as never });
    expect(close.text).toBe(rung.note);
    expect(close.kind).toBe(rung.kind);
    expect(close.rung).toBe(EXIT_RUNG_LETTER[rung.kind]);
    expect(close.vpxPath === null).toBe(!rung.patchable);
  });

  it('Settings: Send logs to Arcaid support pressed twice within 10 minutes', async () => {
    const fx = await story('app-fixtures.ts');
    const limited = new ArcaidError('client', 'Too many requests', 429, { code: 'LIMITED' });
    expect(fx.FIXTURES['settings-logs-refused'].answers.sendLogs.text).toBe(logsNotSentText(limited));
  });

  it('Stream: the preview window inside the captured area', async () => {
    const fx = await story('app-fixtures.ts');
    expect(fx.PREVIEW_ON.warning).toBe(PREVIEW_OVERLAPS);
  });

  it('the update banner: waiting while a table is open', async () => {
    const fx = await story('app-fixtures.ts');
    expect(fx.FIXTURES['update-waiting'].update.waiting).toBe(installWaitReason({ match: null, watch: false, table: 'Monster Bash', vpx: true, recording: false }));
  });

  it('the 3D watch card: each member`s path, and the line about this PC`s copy of the table', async () => {
    const fx = await story('app-fixtures.ts');
    const W = fx.WATCH;
    const lines = (w: any): string[] => w.members.map((m: any) => m.line);
    expect(lines(W['hosting'])).toEqual([pathWords('self')]);
    expect(lines(W['other-plays'])).toEqual([pathWords('direct'), pathWords('self')]);
    expect(lines(W['no-path'])).toEqual([pathWords('no_path'), pathWords('self')]);
    const want = { name: W['other-plays'].player.table, size: W['other-plays'].player.size };
    expect(W['other-plays'].watchTable).toEqual({ path: W['other-plays'].watchTable.path, ...watchTableLine(want, { path: W['other-plays'].watchTable.path, size: want.size }) });
    const other = W['size-differs'].watchTable;
    expect(other).toEqual({ path: other.path, ...watchTableLine(want, { path: other.path, size: 48_190_464 }) });
  });
});
