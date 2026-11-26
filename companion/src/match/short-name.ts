/**
 * The final review (2026-11-28, finding 10): a name as it is shown inside a sentence, a header or a button. The name
 * field takes 64 characters, and one such name without a space pushed the panel's header and stage text off both
 * edges, took every score off the scoreboard card and cut the first words off the tab's buttons. A long name is cut
 * to `max` characters, the last of them an ellipsis; a row that shows a name alone cuts it in its own box instead
 * (the pages' styles), so that what stands beside it (a score, AWAY) stays.
 *
 * Self-contained: the panel and scoreboard pages embed it by its source text.
 */
export function shortName(name: string, max = 24): string {
  const chars = Array.from(String(name));
  return chars.length <= max ? String(name) : chars.slice(0, Math.max(1, max - 1)).join('') + '…';
}
