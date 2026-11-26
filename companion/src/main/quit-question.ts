/**
 * A17 step 9 (2026-11-27): the question Castcade asks before it closes on the lobby's PC while somebody else is
 * present in the lobby (step 8, the review of PR 138), out of index.ts so that its words and its three answers are
 * tested without Electron. index.ts hands `askQuit` the dialog; everything the answer decides is here.
 *
 * "Close" tells everyone the lobby is closed. "Keep" tells them Castcade was closed on this PC and that the lobby
 * is kept for them to wait in; the lobby is offered again at the next start. Cancel closes nothing. An answer that
 * is none of the three (a dialog closed some other way) is Cancel: Castcade never closes a lobby, or itself, on an
 * answer nobody gave.
 */

import { shortName } from '../match/short-name.js';

/** What `MatchHost.quitQuestion()` answers when there is something to ask: the lobby's code and who is present in it. */
export interface QuitQuestion {
  code: string;
  /** Who is present in the lobby. */
  names: readonly string[];
  /** The final review (finding 2): who has a place in it and is away right now. They are asked about too. */
  away?: readonly string[];
}

/** The message box, as Electron's `dialog.showMessageBox` takes it. */
export interface QuitBox {
  type: 'question';
  title: string;
  message: string;
  detail: string;
  buttons: string[];
  defaultId: number;
  cancelId: number;
  noLink: boolean;
}

export type QuitAnswer = 'close' | 'keep' | 'cancel';

export const QUIT_BUTTONS = ['Close the lobby for everyone', 'Keep the lobby (the others wait up to 20 minutes for this PC)', 'Cancel'] as const;

/** The box for a question: who is in the lobby, what each answer does. Enter keeps the lobby; Esc cancels. */
export function quitBox(q: QuitQuestion): QuitBox {
  const list = (all: readonly string[]): string => {
    const n = all.map((x) => shortName(x));
    return n.length <= 1 ? (n[0] ?? 'Somebody') : `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`;
  };
  const away = q.away ?? [];
  // Who is here, and who has a place and is away (their PC may be restarting: the lobby is theirs to come back to).
  const here = q.names.length > 0 ? `${list(q.names)} ${q.names.length > 1 ? 'are' : 'is'} in your lobby ${q.code}` : '';
  const gone = away.length > 0 ? `${list(away)} ${away.length > 1 ? 'have places' : 'has a place'} in ${here ? 'it' : `your lobby ${q.code}`} and ${away.length > 1 ? 'are' : 'is'} away right now` : '';
  return {
    type: 'question',
    title: 'Castcade',
    message: `${[here, gone].filter((x) => x !== '').join('; ') || `Somebody is in your lobby ${q.code}`}.`,
    detail:
      'Close the lobby for everyone: they are told it is closed. Keep the lobby: they are told that Castcade was closed on this PC, and wait up to 20 minutes for it; Castcade offers the lobby again when it is next started.',
    buttons: [...QUIT_BUTTONS],
    defaultId: 1,
    cancelId: 2,
    noLink: true,
  };
}

/** The button that was pressed, as what it means. */
export function quitAnswer(response: number): QuitAnswer {
  return response === 0 ? 'close' : response === 1 ? 'keep' : 'cancel';
}

/**
 * Asks, when there is something to ask. Null: nothing was asked (nobody else is present, or no lobby is this PC's):
 * the quit goes on as it always did. A dialog that cannot be shown is Cancel.
 */
export async function askQuit(q: QuitQuestion | null, show: (box: QuitBox) => Promise<{ response: number }>): Promise<QuitAnswer | null> {
  if (!q) return null;
  try {
    return quitAnswer((await show(quitBox(q))).response);
  } catch {
    return 'cancel';
  }
}

// ---- a member's quit during their own game (the final review, 2026-11-28, finding 8)

/** What `MatchHost.quitGameQuestion()` answers for a member who is a player of the game being played. */
export interface LeaveQuestion {
  code: string;
}

export const LEAVE_BUTTONS = ['Quit and give up the game', 'Cancel'] as const;

/**
 * A member chose Quit while a game they play is on: quitting leaves the lobby, and leaving gives the game up. The
 * words are the in-game menu's for the same thing (`leaveGame`, match-menu.ts). Enter and Esc are Cancel: a person
 * who only meant to restart Castcade loses nothing by a key pressed too fast.
 */
export function leaveBox(q: LeaveQuestion): QuitBox {
  return {
    type: 'question',
    title: 'Castcade',
    message: `You are playing a game in the lobby ${q.code}.`,
    detail: 'Quitting Castcade leaves the lobby: you give up the game you are playing. Your place and your microphone go; coming back is a new join.',
    buttons: [...LEAVE_BUTTONS],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  };
}

/** Null: nothing to ask. `leave`: quit, and give the game up. `cancel`: nothing closes (also for a dialog that cannot be shown). */
export async function askLeave(q: LeaveQuestion | null, show: (box: QuitBox) => Promise<{ response: number }>): Promise<'leave' | 'cancel' | null> {
  if (!q) return null;
  try {
    return (await show(leaveBox(q))).response === 0 ? 'leave' : 'cancel';
  } catch {
    return 'cancel';
  }
}

/**
 * One question at a time (finding 8): Quit chosen again in the tray while the question is up asked it a second time,
 * and the first box to be answered won. `run` is not started while another is still out; the second caller gets
 * `busy` and does nothing.
 */
export function oneAtATime<T>(): (run: () => Promise<T>) => Promise<T | 'busy'> {
  let out = false;
  return async (run) => {
    if (out) return 'busy';
    out = true;
    try {
      return await run();
    } finally {
      out = false;
    }
  };
}
