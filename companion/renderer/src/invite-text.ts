/**
 * The final review (2026-11-28, finding 5): what the Join card's Paste takes from the clipboard. Everything the
 * invite's own Copy buttons give: the six-letter code, the web link (`https://…/castcade/join/JHDFEF`, Copy link),
 * the `castcade:` link or invite, and the line for a chat with one of those links inside it (Copy for chat).
 * Paste took the code and `castcade:` alone, so the link a friend copied out of the chat was refused with "The
 * clipboard does not hold a Castcade link or invite"; typed into the field, the same link joined.
 *
 * Returns what goes into the field (the link or the code), or null when the text holds none.
 */
export function inviteFromText(text: string): string | null {
  const t = text.trim();
  if (/^[A-Za-z]{6}$/.test(t)) return t.toUpperCase();
  // A link anywhere in the text, up to the next blank; what a sentence puts after it (a bracket, a full stop) is not the link's.
  const m = /(castcade:\S+|https?:\/\/\S+\/castcade\/join\/\S+)/i.exec(t);
  if (!m || m[1] === undefined) return null;
  return m[1].replace(/[)\].,;:!?'"]+$/, '');
}
