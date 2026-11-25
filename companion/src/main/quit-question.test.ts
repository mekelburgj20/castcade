/**
 * A17 step 9 (2026-11-27): the quit question's words and its three answers, at the seam between index.ts and the
 * dialog. What each answer then does to the lobby is match-restart.test.ts ("the lobby's PC is quit…", direct and
 * through ArcAid).
 */
import { describe, expect, it } from 'vitest';
import { askQuit, quitAnswer, quitBox, QUIT_BUTTONS, type QuitBox } from './quit-question.js';

const Q = { code: 'JHDFEF', names: ['Krobs', 'Chuck', 'Dana'] };

describe('the question before Castcade closes on the lobby\'s PC (A17 step 8; its seam: step 9)', () => {
  it('says who is in the lobby and what each answer does; Enter keeps the lobby and Esc cancels', () => {
    const box = quitBox(Q);
    expect(box.message).toBe('Krobs, Chuck and Dana are in your lobby JHDFEF.');
    expect(quitBox({ code: 'JHDFEF', names: ['Krobs'] }).message).toBe('Krobs is in your lobby JHDFEF.');
    expect(quitBox({ code: 'JHDFEF', names: ['Krobs', 'Chuck'] }).message).toBe('Krobs and Chuck are in your lobby JHDFEF.');
    expect(box.buttons).toEqual(['Close the lobby for everyone', 'Keep the lobby (the others wait up to 20 minutes for this PC)', 'Cancel']);
    expect(box.detail).toContain('Close the lobby for everyone: they are told it is closed.');
    expect(box.detail).toContain('Keep the lobby: they are told that Castcade was closed on this PC, and wait up to 20 minutes for it');
    expect(box.detail).toContain('Castcade offers the lobby again when it is next started');
    // The default is the answer that loses nothing; the window's own close button and Esc are Cancel.
    expect(box.buttons[box.defaultId]).toBe(QUIT_BUTTONS[1]);
    expect(box.buttons[box.cancelId]).toBe('Cancel');
    expect(box.noLink).toBe(true);
  });

  it('the three answers: Close, Keep, Cancel; an answer that is none of them is Cancel', () => {
    expect(quitAnswer(0)).toBe('close');
    expect(quitAnswer(1)).toBe('keep');
    expect(quitAnswer(2)).toBe('cancel');
    expect(quitAnswer(-1)).toBe('cancel');
    expect(quitAnswer(7)).toBe('cancel');
  });

  it('asks only when there is something to ask, shows the box once, and hands back the answer', async () => {
    const shown: QuitBox[] = [];
    const press = (response: number) => (box: QuitBox) => {
      shown.push(box);
      return Promise.resolve({ response });
    };
    // Nobody else is present, or the lobby is not this PC's: nothing is asked, and the quit goes on as before.
    expect(await askQuit(null, press(0))).toBeNull();
    expect(shown).toEqual([]);
    expect(await askQuit(Q, press(0))).toBe('close');
    expect(await askQuit(Q, press(1))).toBe('keep');
    expect(await askQuit(Q, press(2))).toBe('cancel');
    expect(shown).toHaveLength(3);
    expect(shown.every((b) => b.message === 'Krobs, Chuck and Dana are in your lobby JHDFEF.')).toBe(true);
    // A dialog that cannot be shown closes nothing.
    expect(await askQuit(Q, () => Promise.reject(new Error('no window')))).toBe('cancel');
  });
});
