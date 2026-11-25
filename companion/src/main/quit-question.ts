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

/** What `MatchHost.quitQuestion()` answers when there is something to ask: the lobby's code and who is present in it. */
export interface QuitQuestion {
  code: string;
  names: readonly string[];
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
  const who = q.names.length <= 1 ? (q.names[0] ?? 'Somebody') : `${q.names.slice(0, -1).join(', ')} and ${q.names[q.names.length - 1]}`;
  return {
    type: 'question',
    title: 'Castcade',
    message: `${who} ${q.names.length > 1 ? 'are' : 'is'} in your lobby ${q.code}.`,
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
