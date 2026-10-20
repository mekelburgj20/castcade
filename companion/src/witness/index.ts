/**
 * Public surface of the witness module. The Electron shell imports `createWitness` and the types
 * in `./types.js`; everything else is exported for tests, tooling and later phases (live mode).
 */
export * from './types.js';
export {
  createWitness,
  outcomeForWire,
  outcomeForPost,
  resolveTableName,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_NV_ALIVE_POLL_MS,
  UNKNOWN_TABLE,
  type WitnessDeps,
  type ResolvedTable,
} from './witness.js';
export { ArcaidClient, ArcaidError, buildUrl, type FetchLike, type FetchResponseLike, type ArcaidFailureKind, type ScoreWireStatus } from './arcaid-client.js';
export { decideCapture, countPlayers, MIN_SESSION_SEC, EXIT_SAMPLE_REASON, type CaptureDecision, type CaptureInput } from './capture.js';
export { nodeFs, MemoryFs, isNotFound, type WitnessFs, type FileStat, type RandomAccessFile } from './fs.js';
export { replayJournal, readJournalLines, type JournalReplay } from './journal-replay.js';
export {
  compileMap,
  compilePlatform,
  createMapCorpus,
  decodeGameState,
  decodeHighScores,
  decodeLastPlayed,
  hasScores,
  romFromNvName,
  sameGame,
  stripRomVersion,
  NvMemory,
  type CompiledMap,
  type GameState,
  type HighScore,
  type MapCorpus,
  type Platform,
  type AdjustmentDescriptor,
  flattenAdjustments,
} from './maps.js';
export {
  resolveNvramDir,
  vpxRootFromExe,
  parseRegQuery,
  parseRegValues,
  parseRegNumber,
  regNumber,
  createRegQueryReader,
  createStaticRegistry,
  REG_DEFAULT_NAME,
  type RegValue,
  VPM_GLOBALS_KEY,
  NVRAM_DIRECTORY_VALUE,
  type RegistryReader,
  type ResolvedNvramDir,
} from './nvram-dir.js';
export { snapshotNvFiles, changedNvFiles, waitForNvChange, type NvSnapshot, type NvFileSnapshot } from './nvram-snapshot.js';
export {
  ProcessWatch,
  createPowershellLister,
  parsePlayArg,
  parsePositionalVpx,
  parseSwitchPath,
  parseTableArg,
  parseWindowTitle,
  parseCimProcesses,
  parseCimDate,
  splitCommandLine,
  tableNameFromPath,
  isVpxExe,
  type ProcessInfo,
  type ProcessLister,
  type VpxLaunch,
  type VpxExit,
  type VpxTitle,
  type ParsedTitle,
  type TableSource,
} from './process-watch.js';
export { PostQueue, QUEUE_FILE, type QueuedPost, type PostInput, type PostResult } from './queue.js';
export { catalogueTableName } from './table-name.js';
export * from './identity-types.js';
export { createIdentityResolver, type IdentityResolver, type IdentityResolverDeps } from './identity-resolver.js';
export { createIdentityStore, IDENTITY_FILE, type IdentityStore, type CachedFacts, type Confirmation } from './identity-store.js';
export { findTableFile, tableRootsFor, tableBaseName } from './table-locator.js';
export { createVpsIndex, normalizeVpsName, romFamily, tableLabel, indexGames, sameManufacturer } from './vps-index.js';
export { matchGame, matchTable, parseTableFileName, namePrefixes, versionFromName, versionForms, TABLE_SCORES, TABLE_MARGIN, type ParsedTableFileName } from './table-match.js';
export { readVpxFacts, sha256File, parseTableInfo, parseGameDataPhysics, EMPTY_TABLE_INFO, DEFAULT_SHA256_CHUNK_BYTES, type Sha256Options } from './vpx-file.js';
export * from './attestation-types.js';
export { parseIni, iniGet, iniEntries, iniNumber, iniBool, locateMainIni, defaultTableIni, readIniAttestation, describeIni, physicsSetFrom, flipperSetFrom, MAIN_INI_NAME, type IniData, type IniAttestationInput } from './ini-attestation.js';
export { decodeAdjustments, adjustmentsReport, describeAdjustments, isFairnessLabel, FAIRNESS_LABELS, MAX_CHECKED } from './adjustments.js';
export { parsePeVersion, attestBinary, knownBuildFor, locateVpinmameDll, vpmCheatFlag, createBuildAttester, describeBuild, KNOWN_BUILDS, VPM_CONTROLLER_CLSID_KEY, VPM_SETTINGS_KEY, type BuildAttester, type BuildAttesterDeps } from './build-attestation.js';
