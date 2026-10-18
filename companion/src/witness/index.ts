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
export { nodeFs, MemoryFs, isNotFound, type WitnessFs, type FileStat } from './fs.js';
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
} from './maps.js';
export {
  resolveNvramDir,
  vpxRootFromExe,
  parseRegQuery,
  createRegQueryReader,
  createStaticRegistry,
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
