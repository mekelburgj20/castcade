/**
 * A17 step 7 (2026-11-25, the review of PR 136): what the Match tab sends for the lobby's presses, read in the main
 * process. A value that is not one of the choices is refused, never read as one of them: "anything that is not
 * `watch` is `play`" would put a watcher into the next start, and "anything else is `wait`" would close a question
 * for another turn clock. A press also says what it was made against (`about`, `player`), which the match host
 * checks (`match-host.ts`): a press about a game or a player that is no longer the one there does nothing.
 */
import type { Stance } from '@castcade/protocol';

const field = (o: unknown, key: string): unknown => (o !== null && typeof o === 'object' ? (o as Record<string, unknown>)[key] : undefined);
/** A short string, or null when none was sent. Throws for anything else. */
function text(v: unknown, what: string): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || v.length > 200) throw new Error(`${what}: not understood, nothing was done`);
  return v;
}

export function readStance(v: unknown): Stance {
  if (v === 'play' || v === 'watch') return v;
  throw new Error('Play or Watch: not understood, nothing was changed');
}

export function readAwayAnswer(answer: unknown, o: unknown): { answer: 'wait' | 'end_ball' | 'play_on'; player: string | null } {
  if (answer !== 'wait' && answer !== 'end_ball' && answer !== 'play_on') throw new Error('The answer about the player who is away: not understood, nothing was done');
  return { answer, player: text(field(o, 'player'), 'The answer about the player who is away') };
}

export function readEndMatch(o: unknown): { everyone: boolean; about: string | null } {
  const everyone = field(o, 'everyone');
  if (typeof everyone !== 'boolean') throw new Error('End match: not understood, nothing was ended');
  return { everyone, about: text(field(o, 'about'), 'End match') };
}

export const readAbout = (o: unknown, what: string): { about: string | null } => ({ about: text(field(o, 'about'), what) });
export const readPlayer = (o: unknown, what: string): { player: string | null } => ({ player: text(field(o, 'player'), what) });
