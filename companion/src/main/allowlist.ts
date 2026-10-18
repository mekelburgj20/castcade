/**
 * `app:openExternal` allowlist. The renderer may only open the configured ArcAid origin and the
 * project's GitHub page; anything else (file:, javascript:, other hosts) is refused. Pure.
 */
export const PROJECT_URL = 'https://github.com/mekelburgj20/castcade';

export function isAllowedExternalUrl(candidate: string, arcaidBaseUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  if (url.username || url.password) return false;

  let arcaid: URL;
  try {
    arcaid = new URL(arcaidBaseUrl);
  } catch {
    return false;
  }
  if (url.origin === arcaid.origin) return true;

  const project = new URL(PROJECT_URL);
  if (url.origin !== project.origin) return false;
  return url.pathname === project.pathname || url.pathname.startsWith(`${project.pathname}/`);
}
