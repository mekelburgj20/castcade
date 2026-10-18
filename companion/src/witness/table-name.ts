/**
 * The name a table is posted under. ArcAid matches a witness score to a game by normalising the
 * names the device sends (display name, `rom`, `slug`) and comparing them with the room's game
 * names and the catalogue; it strips a "(Manufacturer Year)" parenthetical itself, but author and
 * version suffixes such as "VPWmod v1.0" would defeat the match. So a VPX file or window name is
 * cut after the first "(… YYYY)" parenthetical when it has one, and otherwise loses a trailing
 * version token; the ROM's catalogue name travels as the `slug` so either key can hit.
 */

const MANUFACTURER_YEAR = /^(.*?\([^)]*\d{4}[^)]*\))/;
const TRAILING_VERSION = /\s+v?\d+(?:\.\d+)*[a-z]?$/i;

/** "Monster Bash (Williams 1998) VPWmod v1.0" → "Monster Bash (Williams 1998)"; "Blood Machines 2.0" → "Blood Machines". */
export function catalogueTableName(raw: string): string {
  const trimmed = raw.trim();
  const m = MANUFACTURER_YEAR.exec(trimmed);
  if (m?.[1]) return m[1].trim();
  const stripped = trimmed.replace(TRAILING_VERSION, '').trim();
  return stripped.length > 0 ? stripped : trimmed;
}
