/**
 * Contract for table identity (F1 of `docs/design/fairness-and-table-identity.md`): what a `.vpx`
 * file says about itself, what the VPS database knows about games and tables, and how the two are
 * matched. Three modules implement it and are built by different agents against this file:
 *
 * - `vpx-file.ts`      reads a `.vpx` (OLE compound file) without loading it whole: TableInfo
 *                      strings, the file version, the table's physics scalars, a streaming SHA-256.
 * - `vps-index.ts`     loads the compact VPS index (`resources/vps/index.json`, built by
 *                      `scripts/fetch-vps.mjs`) and answers "which game has this ROM / name".
 * - `table-match.ts`   scores a game's VPS table files against the evidence from the file.
 *
 * `witness.ts` composes them into a `TableIdentity` per session and puts the ids on the wire.
 * Keep this file additive.
 */

// ------------------------------------------------------------------------------ the .vpx file --

/** The `TableInfo` storage of a `.vpx`: UTF-16LE strings, no terminator; every stream optional. */
export interface VpxTableInfo {
  tableName: string | null;
  authorName: string | null;
  tableVersion: string | null;
  releaseDate: string | null;
  /** `TableSaveDate` as written by VPX, e.g. `Tue Jan  6 20:19:27 2026`. */
  saveDate: string | null;
  /** `TableSaveRev`, advanced by VPX on every editor save. */
  saveRev: number | null;
  manufacturer: string | null;
  year: number | null;
  /** Every TableInfo stream by name, decoded, for anything not modelled above (blurb, rules, ...). */
  raw: Record<string, string>;
}

/** Table-level physics scalars from `GameStg/GameData` (BIFF records; floats). Null when absent. */
export interface VpxTablePhysics {
  gravity: number | null; // GAVT
  friction: number | null; // FRCT
  elasticity: number | null; // ELAS
  elasticityFalloff: number | null; // ELFA
  playfieldScatter: number | null; // PFSC
  defaultScatter: number | null; // SCAT
  nudgeTime: number | null; // NDGT
  slopeMin: number | null; // SLOP (degrees)
  slopeMax: number | null; // SLPX (degrees)
}

export interface VpxFileFacts {
  path: string;
  size: number;
  mtimeMs: number;
  /** `GameStg/Version` (int32), e.g. 1080 for a table last saved by VPX 10.8.0. */
  fileVersion: number | null;
  tableInfo: VpxTableInfo;
  physics: VpxTablePhysics | null;
  /** Byte length of the embedded script (the `CODE` record), or null when not found. */
  scriptBytes: number | null;
}

// -------------------------------------------------------------------------------- VPS index --

export interface VpsTableEntry {
  /** VPS table id (the sheet's `VPS-ID` / `WebGameID`), e.g. `rxmbAdBi`. */
  id: string;
  authors: string[];
  version: string | null;
  /** VPS feature tags as published, e.g. `MOD`, `VR`, `FSS`, `nFozzy`, `no ROM`. */
  features: string[];
  /** `VPX`, `FP`, `FX`, `FX3`, `VP9`, ... */
  format: string | null;
  comment: string | null;
  updatedAt: number | null;
}

export interface VpsGameEntry {
  /** VPS game id (the sheet's `MasterID`), e.g. `F1Skyh5h` for Monster Bash. */
  id: string;
  name: string;
  manufacturer: string | null;
  year: number | null;
  /** `SS`, `EM`, `PM`, `OG`, ... */
  type: string | null;
  /** PinMAME ROM ids VPS lists for the game (`romFiles[].version`), lower-cased. */
  roms: string[];
  tables: VpsTableEntry[];
}

/** Shape of `resources/vps/index.json` (and of the `fixtures/vps/index.json` subset). */
export interface VpsIndexFile {
  /** The vps-db git commit the index was built from. */
  version: string;
  generatedAt: string;
  games: VpsGameEntry[];
}

export interface VpsIndex {
  version(): Promise<string | null>;
  game(id: string): Promise<VpsGameEntry | null>;
  /**
   * Games whose ROM list contains `rom` (case-insensitive). When none lists it exactly, games whose
   * ROMs share its family (the part before the version suffix, `mm` of `mm_109c`, by the same rule
   * as `stripRomVersion`'s cousin for ids), so an unlisted revision still finds the game. Empty when
   * nothing matches. Order: exact hits first, then family hits, each by name.
   */
  gamesForRom(rom: string): Promise<VpsGameEntry[]>;
  /**
   * Games whose normalised name equals the normalised `name` (case-insensitive, punctuation and
   * spacing folded). `hint.manufacturer` / `hint.year` narrow a tie but never widen a miss.
   */
  gamesByName(name: string, hint?: { manufacturer?: string | null; year?: number | null }): Promise<VpsGameEntry[]>;
}

// ---------------------------------------------------------------------------------- matching --

export type MatchConfidence =
  | 'exact' // one candidate, or one candidate clearly ahead on strong evidence
  | 'likely' // best candidate ahead but on weaker evidence (name only, partial author overlap)
  | 'ambiguous' // several candidates, none clearly ahead; the player is asked once
  | 'none'; // no candidate

export interface TableMatchCandidate {
  table: VpsTableEntry;
  score: number;
  reasons: string[];
}

export interface TableMatch {
  table: VpsTableEntry | null;
  confidence: MatchConfidence;
  /** Every VPX-format table of the game, best first; what the picker shows when ambiguous. */
  candidates: TableMatchCandidate[];
}

/** What the companion knows about the file when it asks "which of this game's tables is it". */
export interface TableMatchEvidence {
  /** File name without directory or extension, e.g. `Monster Bash (Williams 1998) VPWmod v1.0`. */
  fileName: string | null;
  tableInfo: Pick<VpxTableInfo, 'tableName' | 'authorName' | 'tableVersion'> | null;
}

export interface GameMatchEvidence {
  /** PinMAME ROM id from the `.nv` that changed, e.g. `mb_106b`. */
  rom: string | null;
  /** The ROM's descriptive name from `romnames.json` with its version stripped, e.g. `Monster Bash`. */
  romName: string | null;
  fileName: string | null;
  tableInfo: Pick<VpxTableInfo, 'tableName' | 'manufacturer' | 'year'> | null;
}

export type GameMatchSource = 'rom' | 'tableinfo' | 'filename' | 'none';

export interface GameMatch {
  game: VpsGameEntry | null;
  confidence: MatchConfidence;
  source: GameMatchSource;
  candidates: VpsGameEntry[];
}

// --------------------------------------------------------------------------------- identity --

/** A short human label for a VPS table: first author(s), version, notable features. */
export interface VpsTableRef {
  id: string;
  label: string;
}

export interface VpsGameRef {
  id: string;
  name: string;
  manufacturer: string | null;
  year: number | null;
}

/** What rides with a capture (and shows in Status). Everything optional: identity never blocks a post. */
export interface TableIdentity {
  filePath: string | null;
  vpsGame: VpsGameRef | null;
  gameConfidence: MatchConfidence;
  gameSource: GameMatchSource;
  vpsTable: VpsTableRef | null;
  tableConfidence: MatchConfidence;
  /** True when `vpsTable` came from the player's one-time confirmation for this file. */
  confirmed: boolean;
  /** The picker's choices when `tableConfidence` is `ambiguous` (or the player wants to correct). */
  tableChoices: VpsTableRef[];
  sha256: string | null;
  saveRev: number | null;
  tableInfo: VpxTableInfo | null;
  physics: VpxTablePhysics | null;
  /** Human-readable notes: how each part was derived, what failed. */
  notes: string[];
}
