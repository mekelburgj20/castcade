/**
 * Sandboxed preload (CommonJS: Electron's sandboxed preloads cannot be ESM, hence `.cts`).
 * Exposes exactly { appVersion, protocolVersion, platform } to the renderer as `window.castcade`.
 * The two versions arrive on argv via `webPreferences.additionalArguments` (see main/index.ts).
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
import electron = require('electron');

function argValue(flag: string): string {
  const prefix = `--${flag}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : 'unknown';
}

const castcade = {
  appVersion: argValue('castcade-app-version'),
  protocolVersion: Number(argValue('castcade-protocol-version')),
  platform: process.platform,
};

export type CastcadeBridge = typeof castcade;

electron.contextBridge.exposeInMainWorld('castcade', castcade);
