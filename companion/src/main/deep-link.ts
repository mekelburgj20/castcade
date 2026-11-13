/**
 * A14 (2026-11-12): the join link, `castcade://join/<invite>`. `<invite>` is the invite string, URL-encoded: the
 * six-letter match code once matches go through ArcAid (D10.8), or today's address form
 * (`castcade:ws://203.0.113.7:27401#ABCDEF`). Pure: no Electron here, so every rule below is unit-tested.
 *
 * A link is untrusted input: any web page or chat message can hand one to Windows. So:
 * - only this exact shape is taken (scheme `castcade`, the word `join`, one path segment, nothing after it), at most
 *   `LINK_MAX` characters, and the decoded invite must be one of the two invite shapes, character for character;
 * - what comes out is the invite and nothing else: no part of a link is ever used as a file path, a program, a
 *   command-line switch or a shell string. The table that is started is looked up on this PC (`launch/find-table.ts`);
 * - from the command line only an argument that starts with `castcade://` is looked at (`linkFromArgv`).
 */

export const LINK_SCHEME = 'castcade';
export const LINK_MAX = 300;

/** The six-letter match code (D10.8's relay invite). */
const CODE = /^[A-Za-z]{6}$/;
/** The address invite, as `match-setup.ts` `parseInvite` takes it. */
const ADDRESS = /^castcade:ws:\/\/(\[[0-9A-Fa-f:.]{2,45}\]|[A-Za-z0-9.-]{1,253}):(\d{1,5})\/?#([A-Za-z]{6})$/;
const LINK = /^castcade:\/\/join\/([A-Za-z0-9%._~-]{1,280})\/?$/i;
/**
 * A14.2: the same link as a web address chat apps make clickable, `https://arcaid.app/castcade/join/<invite>` (ArcAid
 * 2.243.0 serves a page there that opens `castcade://join/<invite>`). Pasted into the Join box it is read like the
 * `castcade://` form: only the invite comes out of it, whatever the host name.
 */
const WEB_LINK = /^https:\/\/[A-Za-z0-9.-]{1,253}(?::\d{1,5})?\/castcade\/join\/([A-Za-z0-9%._~-]{1,280})\/?$/i;

export interface JoinLink {
  /** The invite to give `MatchHost.join`: `ABCDEF` or `castcade:ws://host:port#ABCDEF`. */
  invite: string;
  /** The match code, upper-case. */
  code: string;
  /** Where the link leads, for the confirmation: `host:port` for an address invite, null for a code (ArcAid). */
  address: string | null;
}

/** The invite checked against the two shapes; null when it is neither. */
export function inviteFacts(invite: string): JoinLink | null {
  if (CODE.test(invite)) return { invite: invite.toUpperCase(), code: invite.toUpperCase(), address: null };
  const m = ADDRESS.exec(invite);
  if (!m) return null;
  const port = Number(m[2]);
  if (port < 1 || port > 65535) return null;
  return { invite, code: m[3]!.toUpperCase(), address: `${m[1]!}:${port}` };
}

/** The link for an invite; null for a string that is not an invite. */
export function formatJoinLink(invite: string): string | null {
  const f = inviteFacts(invite.trim());
  return f ? `${LINK_SCHEME}://join/${encodeURIComponent(f.invite)}` : null;
}

/**
 * A14.2: the clickable form, for a match that goes through ArcAid (the invite is the code) and an ArcAid reached over
 * https. Null otherwise: an address invite keeps the `castcade://` form (it would put the host's address in a web
 * request, and needs an encoded `/` and `#` through ArcAid's proxy). The page takes the code in upper case, with no
 * trailing slash.
 */
export function formatWebJoinLink(invite: string, arcaidBaseUrl: string | null): string | null {
  const f = inviteFacts(invite.trim());
  if (!f || f.address !== null || !arcaidBaseUrl) return null;
  let base: URL;
  try {
    base = new URL(arcaidBaseUrl);
  } catch {
    return null;
  }
  if (base.protocol !== 'https:') return null;
  return `${base.origin}/castcade/join/${f.code}`;
}

/** A join link, or null: anything that is not exactly one is refused whole. */
export function parseJoinLink(text: string): JoinLink | null {
  if (typeof text !== 'string' || text.length > LINK_MAX) return null;
  const m = LINK.exec(text.trim()) ?? WEB_LINK.exec(text.trim());
  if (!m) return null;
  let invite: string;
  try {
    invite = decodeURIComponent(m[1]!);
  } catch {
    return null;
  }
  return inviteFacts(invite);
}

/** True for text that claims to be a link (`castcade://…`), whether or not it is a good one. */
export function looksLikeLink(text: string): boolean {
  return /^castcade:\/\//i.test(text.trim());
}

/** True for text pasted into the Join box that claims to be a link: `castcade://…`, or the web form (A14.2). */
export function looksLikePastedLink(text: string): boolean {
  return looksLikeLink(text) || /^https:\/\/[^/\s]+\/castcade\/join\//i.test(text.trim());
}

/**
 * The link Windows put on the command line (`"Castcade.exe" "castcade://join/…"`; a second instance hands its
 * arguments to the first): the first argument that starts with `castcade://`, as it came. Null when there is none.
 */
export function linkFromArgv(argv: readonly string[]): string | null {
  for (const a of argv) if (typeof a === 'string' && looksLikeLink(a)) return a.trim();
  return null;
}

/** The line for Discord and other chats: a web link is clickable there, a `castcade://` link is plain text. */
export function inviteMessage(link: string, table: string | null): string {
  if (/^https:\/\//i.test(link)) return `Castcade match${table ? ` on ${table}` : ''}: ${link}`;
  return `Castcade match${table ? ` on ${table}` : ''}: ${link} (copy the link, then in Castcade press Match, Paste, Join)`;
}

// ------------------------------------------------------------------------------- registration --

/** What Electron's `app` offers for a URL scheme (injected, so the registration is tested with a fake). */
export interface ProtocolRegistrar {
  setAsDefaultProtocolClient(scheme: string, path?: string, args?: string[]): boolean;
}

/**
 * Registers `castcade://` for this user (Electron writes `HKCU\Software\Classes\castcade`; the installer writes the
 * same keys, `build/installer.nsh`, so a link works before the app's first run). Packaged: the installed exe. A
 * development run registers only when asked (`devEntry`: the app folder Electron was started with), so `npm run dev`
 * does not take the links away from the installed app. Returns the sentence for the log.
 */
export function registerLinkProtocol(app: ProtocolRegistrar, o: { packaged: boolean; execPath: string; devEntry: string | null }): string {
  try {
    if (o.packaged) return app.setAsDefaultProtocolClient(LINK_SCHEME) ? 'links: castcade:// opens this app' : 'links: Windows did not take the castcade:// registration; a join link will not open Castcade';
    if (!o.devEntry) return 'links: castcade:// not registered (a development run; set CASTCADE_REGISTER_LINKS=1 to register it)';
    return app.setAsDefaultProtocolClient(LINK_SCHEME, o.execPath, [o.devEntry]) ? 'links: castcade:// opens this development run' : 'links: Windows did not take the castcade:// registration';
  } catch (e) {
    return `links: castcade:// could not be registered: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * Whether a link may act without a click: only when Castcade's window was already on screen with the Match tab
 * showing when the link arrived. A closed, hidden or minimised window, or another tab, means the player is not
 * looking at it: the link then waits for the Match tab's confirmation.
 */
export function linkIsTrusted(w: { exists: boolean; visible: boolean; minimized: boolean; matchTab: boolean }): boolean {
  return w.exists && w.visible && !w.minimized && w.matchTab;
}
