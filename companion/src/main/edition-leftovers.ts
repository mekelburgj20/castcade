/**
 * E10: what a full install leaves that the Witness edition must not keep, removed when the Witness edition starts
 * (installed over a full install, which keeps the same userData and install folder):
 *   - Castcade's OpenXR implicit-layer registration under `HKCU\SOFTWARE\Khronos\OpenXR\1\ApiLayers\Implicit`, which
 *     the full app writes at every start (D7.3.3, `registerVrLayer` in media/vr-layer.ts): every OpenXR app would keep
 *     loading the layer from a folder the Witness edition never refreshes. Only a value that points at Castcade's layer
 *     (the manifest `XrApiLayer_castcade_panel.json`) is removed; any other layer is left alone;
 *   - the `castcade://` link (A14), which would start the Witness edition for a match it cannot join. The installer
 *     removes the key too (build/installer.nsh); this covers a Witness edition started without it.
 * Best-effort: every step is logged, nothing throws.
 */
import { execFile } from 'node:child_process';
import { LINK_SCHEME } from './deep-link.js';
import { deleteArgs, OPENXR_IMPLICIT_LAYERS_KEY, parseRegQuery, queryArgs, VR_LAYER_JSON, type Exec } from '../media/vr-layer.js';

/** The value name is Castcade's layer manifest (a path ending in `\XrApiLayer_castcade_panel.json`, any folder). */
export function isCastcadeLayer(valueName: string): boolean {
  const n = valueName.trim().toLowerCase();
  const json = VR_LAYER_JSON.toLowerCase();
  return n === json || n.endsWith(`\\${json}`) || n.endsWith(`/${json}`);
}

const execReg: Exec = (file, args) =>
  new Promise((done, fail) => {
    execFile(file, args, { windowsHide: true }, (err, stdout) => (err ? fail(err) : done({ stdout: String(stdout) })));
  });

export interface LeftoverResult {
  /** The layer registrations removed (value names). */
  layers: string[];
  /** What the link protocol's removal said: true (removed, or none was there for this exe), false, or null (it threw). */
  link: boolean | null;
}

export async function removeFullEditionLeftovers(o: {
  protocol: { removeAsDefaultProtocolClient(scheme: string): boolean };
  log: (line: string) => void;
  exec?: Exec;
}): Promise<LeftoverResult> {
  const exec = o.exec ?? execReg;
  const layers: string[] = [];
  try {
    // `reg query` exits 1 when the key does not exist: nothing registered.
    const values = parseRegQuery((await exec('reg.exe', queryArgs()).catch(() => ({ stdout: '' }))).stdout);
    for (const v of values.filter((x) => isCastcadeLayer(x.name))) {
      try {
        await exec('reg.exe', deleteArgs(v.name));
        layers.push(v.name);
        o.log(`edition: removed Castcade's OpenXR layer registration ${v.name} (a full install's; the Witness edition has no headset panel)`);
      } catch (e) {
        o.log(`edition: could not remove the OpenXR layer registration ${v.name} under ${OPENXR_IMPLICIT_LAYERS_KEY}: ${(e as Error).message}`);
      }
    }
    if (values.every((x) => !isCastcadeLayer(x.name))) o.log('edition: no Castcade OpenXR layer registration to remove');
  } catch (e) {
    o.log(`edition: could not read ${OPENXR_IMPLICIT_LAYERS_KEY}: ${(e as Error).message}`);
  }
  let link: boolean | null;
  try {
    link = o.protocol.removeAsDefaultProtocolClient(LINK_SCHEME);
    o.log(link ? `edition: ${LINK_SCHEME}:// does not open this app (the Witness edition has no matches)` : `edition: Windows kept a ${LINK_SCHEME}:// registration (it may belong to another Castcade folder)`);
  } catch (e) {
    link = null;
    o.log(`edition: could not remove the ${LINK_SCHEME}:// registration: ${(e as Error).message}`);
  }
  return { layers, link };
}
