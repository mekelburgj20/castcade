/**
 * D1.4: the overlay burned into the stream and the recording. The same state the D1.1 OBS page draws
 * (`overlayStateFrom`), as the few lines of text ffmpeg's `drawtext` re-reads every frame (`reload=1`) from
 * `OVERLAY_TEXT_FILE`; the engine overwrites that file in place when the text changes (never by rename, see
 * `ffmpeg-args.ts`). Pure. Lines stay short (≤ ~44 characters): the box is bottom-left at fontsize height/26.
 */
import type { OverlayState } from './overlay-server.js';

/** Beside `stream.json` in userData; the host joins the path. */
export const OVERLAY_TEXT_FILE = 'stream-overlay.txt';

/** What the witness recorded for the last post, in a viewer's words. */
const OUTCOME_WORDS: Record<string, string> = {
  ingested: 'posted',
  queued: 'queued',
  duplicate: 'already posted',
  rejected: 'not counted',
  skipped: 'skipped',
};

/** 4571120 → "4,571,120", whatever the machine's locale (the stream looks the same for every viewer). */
export function groupThousands(n: number): string {
  const sign = n < 0 ? '-' : '';
  const digits = String(Math.trunc(Math.abs(n)));
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ',';
    out += digits[i];
  }
  return sign + out;
}

/**
 * drawtext expands its text (`%{…}` functions, `\` escapes) even from a textfile, and a stray `%` fails the frame,
 * which stops the encode; a table name is the player's own text, so `%` and `\` go in escaped.
 */
const literal = (line: string): string => line.replace(/[\\%]/g, (c) => `\\${c}`);

/** The overlay as text: table, the game (one line per player) or the last post, the attempt, the badge. */
export function overlayText(state: OverlayState): string {
  const lines: string[] = [];
  if (state.table) lines.push(state.table);
  const game = state.game;
  if (game?.inGame) {
    const ball = game.ball != null ? ` · Ball ${game.ball}` : '';
    const scored = game.scores.map((s, i) => ({ s, p: i + 1 })).filter((x): x is { s: number; p: number } => x.s != null);
    if (scored.length === 0) lines.push(`In play${ball}`);
    for (const { s, p } of scored) {
      const up = p === game.player;
      lines.push(`${up ? '▶ ' : ''}P${p} ${groupThousands(s)}${up ? ball : ''}`);
    }
    if (state.attempt) lines.push(state.attempt);
  } else if (state.lastPost) {
    const { score, outcome } = state.lastPost;
    lines.push(`Last game: ${score != null ? groupThousands(score) : 'no score'} · ${OUTCOME_WORDS[outcome] ?? outcome}`);
  }
  lines.push(state.badge.text);
  return lines.map(literal).join('\n');
}
