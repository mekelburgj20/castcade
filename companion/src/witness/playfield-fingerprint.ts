/**
 * Playfield fingerprint (F4, `docs/design/fairness-and-table-identity.md` §3): a SHA-256 over the playfield as the
 * ball sees it, so a VR, performance or DMD edit leaves it unchanged and a widened flipper gap or a removed post
 * changes it. The whole-file hash stays reported, never enforced.
 *
 * Input: `GameStg/GameData` (table physics + the physics materials) and every `GameItem<n>` stream
 * (`readVpxPlayfieldStreams`). Each item is `[type:u32]` then BIFF records `[len:u32][tag:4][data:len-4]`; shape
 * points follow as `DPNT` + the point's records + `ENDB`, and the item ends with a last `ENDB`.
 *
 * Every tag below was checked on 2026-10-25 against two parsers on the owner's Monster Bash: this walker's raw
 * values and vpxtool 0.33.9's JSON (field for field; all 132 physics materials identical). Tags not listed are
 * ignored, so a new VPX record never changes the hash; a renamed one makes its field null, which changes it (B4.1
 * pins the list in a test).
 *
 * Included: collidable items only (each type's own flag; a primitive marked toy never collides), with their physics,
 * position and geometry; a collidable 3D-mesh primitive contributes its vertex positions and triangle indices (not
 * normals or texture coordinates). An item whose physics come from a named material (overwrite-physics off) pulls
 * that material's physics into `materials`. Excluded: names, images, visual materials, lights, flashers, decals,
 * triggers, timers, sounds, the script, editor state. Items are sorted by content, so renaming or reordering them
 * leaves the hash alone.
 *
 * Canonical JSON: sorted keys, floats rounded to 6 places, `v` = format version. Sent as `pf<v>:<sha256>`.
 */
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import type { WitnessFs } from './fs.js';
import { readVpxPlayfieldStreams, type VpxPlayfieldStreams } from './vpx-file.js';

export const PLAYFIELD_FINGERPRINT_VERSION = 1;

/** How a tag's data is read. `v2` / `v3` are float vectors (VPOS/VSIZ carry a fourth padding float). */
type Kind = 'f' | 'i' | 's' | 'v2' | 'v3';

interface TypeSpec {
  label: string;
  /** The tag that says the item collides; absent = the type always collides. */
  collidable?: string;
  /** Fields: tag → kind. */
  fields: Record<string, Kind>;
  /** Shape points (walls, ramps, rubbers): the tags kept per point. */
  points?: Record<string, Kind>;
  /** A 3D-mesh primitive: decode its collision mesh. */
  mesh?: boolean;
}

/** Physics common to the surface types: elasticity, falloff, friction, scatter, and where they come from. */
const SURFACE_PHYSICS: Record<string, Kind> = { ELAS: 'f', ELFO: 'f', OVPH: 'i', MAPH: 's' };

/** VPX `ItemTypeEnum` → what the fingerprint keeps. Types not listed (lights, flashers, decals, triggers, timers, text, reels) are skipped. */
export const PLAYFIELD_TYPES: Record<number, TypeSpec> = {
  0: {
    label: 'wall',
    collidable: 'CLDW',
    fields: { ...SURFACE_PHYSICS, WFCT: 'f', WSCT: 'f', HTBT: 'f', HTTP: 'f', DROP: 'i', ISBS: 'i', SLGF: 'f', SLTH: 'f' },
    points: { VCEN: 'v2', POSZ: 'f', SMTH: 'i', SLNG: 'i' },
  },
  1: {
    label: 'flipper',
    fields: {
      VCEN: 'v2', BASR: 'f', ENDR: 'f', FLPR: 'f', FRMN: 'f', FRTN: 'f', ANGS: 'f', ANGE: 'f', OVRP: 'i', FORC: 'f',
      STRG: 'f', ELAS: 'f', ELFO: 'f', FRIC: 'f', RPUP: 'f', SCTR: 'f', TODA: 'f', TDAA: 'f',
      RTHF: 'f', RHGF: 'f', RWDF: 'f', FHGT: 'f', ENBL: 'i', SURF: 's',
    },
  },
  3: {
    label: 'plunger',
    fields: {
      VCEN: 'v2', WDTH: 'f', HIGH: 'f', ZADJ: 'f', HPSL: 'f', SPDP: 'f', SPDF: 'f', MEST: 'f', MECH: 'i', APLG: 'i',
      MPRK: 'f', PSCV: 'f', MOMX: 'f', SURF: 's',
    },
  },
  5: {
    label: 'bumper',
    collidable: 'COLI',
    fields: { VCEN: 'v2', RADI: 'f', THRS: 'f', FORC: 'f', BSCT: 'f', HISC: 'f', ORIN: 'f', SURF: 's' },
  },
  8: {
    label: 'kicker',
    collidable: 'EBLD',
    fields: { VCEN: 'v2', RADI: 'f', TYPE: 'i', KSCT: 'f', KHAC: 'f', KHHI: 'f', KORI: 'f', FATH: 'i', LEMO: 'i', SURF: 's' },
  },
  10: {
    label: 'gate',
    collidable: 'GCOL',
    fields: { VCEN: 'v2', LGTH: 'f', HGTH: 'f', ROTA: 'f', ELAS: 'f', GAMA: 'f', GAMI: 'f', GFRC: 'f', AFRC: 'f', GGFC: 'f', TWWA: 'i', GATY: 'i', SURF: 's' },
  },
  11: {
    label: 'spinner',
    fields: { VCEN: 'v2', ROTA: 'f', HIGH: 'f', LGTH: 'f', AFRC: 'f', SMAX: 'f', SMIN: 'f', SELA: 'f', SURF: 's' },
  },
  12: {
    label: 'ramp',
    collidable: 'CLDR',
    // Ramps have no elasticity falloff record.
    fields: {
      ELAS: 'f', OVPH: 'i', MAPH: 's', RFCT: 'f', RSCT: 'f', HTBT: 'f', HTTP: 'f', WDBT: 'f', WDTP: 'f', TYPE: 'i',
      WLHL: 'f', WLHR: 'f', RADI: 'f', RADX: 'f', RADY: 'f',
    },
    points: { VCEN: 'v2', POSZ: 'f', SMTH: 'i' },
  },
  19: {
    label: 'primitive',
    collidable: 'CLDR',
    fields: {
      ...SURFACE_PHYSICS, RFCT: 'f', RSCT: 'f', VPOS: 'v3', VSIZ: 'v3',
      RTV0: 'f', RTV1: 'f', RTV2: 'f', RTV3: 'f', RTV4: 'f', RTV5: 'f', RTV6: 'f', RTV7: 'f', RTV8: 'f',
      SIDS: 'i', CORF: 'f', U3DM: 'i',
    },
    mesh: true,
  },
  21: {
    label: 'rubber',
    collidable: 'CLDR',
    fields: { ...SURFACE_PHYSICS, RFCT: 'f', RSCT: 'f', HTTP: 'f', HTHI: 'f', WDTP: 'i', ROTX: 'f', ROTY: 'f', ROTZ: 'f' },
    points: { VCEN: 'v2', SMTH: 'i' },
  },
  22: {
    label: 'target',
    collidable: 'CLDR',
    fields: { ...SURFACE_PHYSICS, RFCT: 'f', RSCT: 'f', VPOS: 'v3', VSIZ: 'v3', ROTZ: 'f', TRTY: 'i', ISDR: 'i', LEMO: 'i', DRSP: 'f' },
  },
};

/** `GameData` table physics (the same tags `parseGameDataPhysics` reads, plus the physics loop cap). */
export const TABLE_FIELDS: Record<string, Kind> = {
  GAVT: 'f', FRCT: 'f', ELAS: 'f', ELFA: 'f', PFSC: 'f', SCAT: 'f', NDGT: 'f', SLOP: 'f', SLPX: 'f', TDFT: 'f',
  ORRP: 'i', ORPF: 'i', PHML: 'i',
};

export type Value = number | string | number[] | null;

export interface PlayfieldItem {
  type: string;
  fields: Record<string, Value>;
  points?: Record<string, Value>[];
  /** Collision mesh: vertex positions (x, y, z per vertex) and triangle indices. */
  mesh?: { positions: number[]; indices: number[] } | null;
}

export interface PlayfieldCanonical {
  v: number;
  table: Record<string, Value>;
  /** Physics of the materials an included item takes its physics from: elasticity, falloff, friction, scatter angle. */
  materials: Record<string, number[]>;
  items: PlayfieldItem[];
}

export interface PlayfieldFingerprint {
  /** `pf<v>:<sha256>`, what the score carries as `fingerprint`. */
  id: string;
  sha256: string;
  /** Included items per type label. */
  counts: Record<string, number>;
  /** The JSON that was hashed (for a diff report; never sent). */
  canonical: string;
}

interface Rec {
  tag: string;
  data: Uint8Array;
}

/** The flat record list of a BIFF body (GameData's `CODE` record carries the script after a short header). */
function records(body: Uint8Array): Rec[] {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const out: Rec[] = [];
  let pos = 0;
  while (pos + 8 <= body.length) {
    const len = view.getUint32(pos, true);
    if (len < 4) break;
    const tag = String.fromCharCode(body[pos + 4]!, body[pos + 5]!, body[pos + 6]!, body[pos + 7]!);
    if (tag === 'CODE') {
      if (pos + 12 > body.length) break;
      pos += 12 + view.getUint32(pos + 8, true);
      continue;
    }
    const end = pos + 4 + len;
    if (end > body.length) break;
    out.push({ tag, data: body.subarray(pos + 8, end) });
    pos = end;
  }
  return out;
}

const round6 = (x: number): number => (Number.isFinite(x) ? Math.round(x * 1e6) / 1e6 : 0);
const latin1 = new TextDecoder('latin1');

function decode(kind: Kind, d: Uint8Array): Value {
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  switch (kind) {
    case 'f':
      return d.length >= 4 ? round6(v.getFloat32(0, true)) : null;
    case 'i':
      return d.length >= 4 ? v.getInt32(0, true) : null;
    case 's': {
      // `[len:u32][bytes]` (ANSI); the item's own NAME is wide and never read here.
      if (d.length < 4) return null;
      const n = Math.min(v.getUint32(0, true), d.length - 4);
      return latin1.decode(d.subarray(4, 4 + n));
    }
    case 'v2':
    case 'v3': {
      const n = kind === 'v2' ? 2 : 3;
      if (d.length < n * 4) return null;
      return Array.from({ length: n }, (_, k) => round6(v.getFloat32(k * 4, true)));
    }
  }
}

function pickFields(recs: Rec[], spec: Record<string, Kind>): Record<string, Value> {
  const out: Record<string, Value> = {};
  for (const [tag, kind] of Object.entries(spec)) {
    const r = recs.find((x) => x.tag === tag);
    out[tag] = r ? decode(kind, r.data) : null;
  }
  return out;
}

/** A 3D-mesh primitive's collision mesh: positions from the 32-byte vertices, then the u16/u32 indices. */
function decodeMesh(recs: Rec[]): { positions: number[]; indices: number[] } | null {
  const get = (t: string) => recs.find((x) => x.tag === t)?.data ?? null;
  const nvRec = get('M3VN');
  const nfRec = get('M3FN');
  const vx = get('M3CX');
  const ix = get('M3CI');
  if (!nvRec || !nfRec || !vx || !ix || nvRec.length < 4 || nfRec.length < 4) return null;
  const nv = new DataView(nvRec.buffer, nvRec.byteOffset, 4).getInt32(0, true);
  const nf = new DataView(nfRec.buffer, nfRec.byteOffset, 4).getInt32(0, true);
  try {
    const verts = inflateSync(vx);
    const idx = inflateSync(ix);
    if (nv <= 0 || verts.length !== nv * 32) return null;
    const indexBytes = nv > 65535 ? 4 : 2;
    if (nf <= 0 || idx.length !== nf * indexBytes) return null;
    const vv = new DataView(verts.buffer, verts.byteOffset, verts.byteLength);
    const positions: number[] = [];
    for (let i = 0; i < nv; i++) for (let k = 0; k < 3; k++) positions.push(round6(vv.getFloat32(i * 32 + k * 4, true)));
    const iv = new DataView(idx.buffer, idx.byteOffset, idx.byteLength);
    const indices: number[] = [];
    for (let i = 0; i < nf; i++) indices.push(indexBytes === 2 ? iv.getUint16(i * 2, true) : iv.getUint32(i * 4, true));
    return { positions, indices };
  } catch {
    return null;
  }
}

/** Shape points: each `DPNT` starts one, its records run to the next `ENDB`. */
function shapePoints(recs: Rec[], spec: Record<string, Kind>): Record<string, Value>[] {
  const points: Record<string, Value>[] = [];
  let current: Rec[] | null = null;
  for (const r of recs) {
    if (r.tag === 'DPNT') {
      if (current) points.push(pickFields(current, spec));
      current = [];
    } else if (r.tag === 'ENDB') {
      if (current) points.push(pickFields(current, spec));
      current = null;
    } else if (current) {
      current.push(r);
    }
  }
  if (current) points.push(pickFields(current, spec));
  return points;
}

/** The item's own records, before its first shape point (a point's records reuse tags like VCEN and LOCK). */
function ownRecords(recs: Rec[]): Rec[] {
  const i = recs.findIndex((r) => r.tag === 'DPNT');
  return i < 0 ? recs : recs.slice(0, i);
}

const truthy = (recs: Rec[], tag: string): boolean => {
  const r = recs.find((x) => x.tag === tag);
  return !!r && r.data.length >= 4 && new DataView(r.data.buffer, r.data.byteOffset, 4).getInt32(0, true) !== 0;
};

/** Physics materials from `GameData`'s `PHMA` record: 48 bytes each, a 32-byte name then four floats. */
function physicsMaterials(gameData: Rec[]): Map<string, number[]> {
  const out = new Map<string, number[]>();
  const r = gameData.find((x) => x.tag === 'PHMA');
  if (!r) return out;
  const v = new DataView(r.data.buffer, r.data.byteOffset, r.data.byteLength);
  for (let o = 0; o + 48 <= r.data.length; o += 48) {
    const raw = r.data.subarray(o, o + 32);
    const nul = raw.indexOf(0);
    const name = latin1.decode(nul < 0 ? raw : raw.subarray(0, nul));
    out.set(name, [0, 1, 2, 3].map((k) => round6(v.getFloat32(o + 32 + k * 4, true))));
  }
  return out;
}

/** JSON with every object's keys sorted, so the same playfield always serialises to the same bytes. */
export function canonicalJson(x: unknown): string {
  if (Array.isArray(x)) return '[' + x.map(canonicalJson).join(',') + ']';
  if (x && typeof x === 'object') {
    const o = x as Record<string, unknown>;
    return '{' + Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => JSON.stringify(k) + ':' + canonicalJson(o[k])).join(',') + '}';
  }
  return JSON.stringify(x);
}

/** The canonical playfield of a table's streams (pure). */
export function canonicalPlayfield(streams: VpxPlayfieldStreams): PlayfieldCanonical {
  const gd = streams.gameData ? records(streams.gameData) : [];
  const table = pickFields(gd, TABLE_FIELDS);
  const allMaterials = physicsMaterials(gd);
  const items: PlayfieldItem[] = [];
  const used = new Set<string>();
  for (const s of streams.items) {
    const spec = PLAYFIELD_TYPES[s.type];
    if (!spec) continue;
    const recs = records(s.body);
    const own = ownRecords(recs);
    if (spec.collidable && !truthy(own, spec.collidable)) continue;
    if (spec.mesh && truthy(own, 'ISTO')) continue; // a toy primitive never collides
    const item: PlayfieldItem = { type: spec.label, fields: pickFields(own, spec.fields) };
    if (spec.points) item.points = shapePoints(recs, spec.points);
    if (spec.mesh && item.fields['U3DM'] === 1) item.mesh = decodeMesh(own);
    const mat = item.fields['MAPH'];
    if (item.fields['OVPH'] === 0 && typeof mat === 'string' && mat !== '') used.add(mat);
    items.push(item);
  }
  const materials: Record<string, number[]> = {};
  for (const name of [...used].sort()) materials[name] = allMaterials.get(name) ?? [];
  // Sort by content: names are not hashed, so a rename or a reorder changes nothing.
  const keyed = items.map((it) => ({ it, key: canonicalJson(it) }));
  keyed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { v: PLAYFIELD_FINGERPRINT_VERSION, table, materials, items: keyed.map((k) => k.it) };
}

/** Fingerprint a table's streams (pure). */
export function fingerprintPlayfield(streams: VpxPlayfieldStreams): PlayfieldFingerprint {
  const c = canonicalPlayfield(streams);
  const canonical = canonicalJson(c);
  const sha256 = createHash('sha256').update(canonical).digest('hex');
  const counts: Record<string, number> = {};
  for (const it of c.items) counts[it.type] = (counts[it.type] ?? 0) + 1;
  return { id: `pf${c.v}:${sha256}`, sha256, counts, canonical };
}

/** Read and fingerprint a `.vpx` (only `GameData` and the `GameItem*` streams are read). */
export async function readPlayfieldFingerprint(fs: WitnessFs, path: string): Promise<PlayfieldFingerprint> {
  return fingerprintPlayfield(await readVpxPlayfieldStreams(fs, path));
}
