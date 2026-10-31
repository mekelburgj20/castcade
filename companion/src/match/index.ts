/**
 * Public surface of the match engine: the two roles (HostMatch, ClientMatch), the shared
 * Session/log/state they fold over, keys, clocks and the transports (in-memory and WebSocket).
 * No Electron, no I/O except through a Transport.
 */
export const MATCH_ENGINE_VERSION = '0.1.0';

export { realClock, ManualClock, type Clock, type TimerHandle } from './clock.js';
export { Emitter } from './events.js';
export { generateKeys, exportPublicKeyB64, importPublicKey, signCanonical, verifyCanonical, sha256Hex, type KeyPair } from './keys.js';
export {
  MatchLog,
  GENESIS_HASH,
  hashEntry,
  type LogEntry,
  type LogEntryBody,
  type LogEntryInput,
  type LogEntryKind,
  type LogEvent,
  type LogHead,
  type HostTransferEvent,
} from './log.js';
export {
  initialState,
  replayLog,
  applyEntry,
  allGamesEnded,
  nextGrantTarget,
  remainingParticipants,
  isStrictMajority,
  cloneState,
  type MatchState,
  type PlayerProgress,
  type PlayerStatus,
  type GrantTarget,
  type PendingTransfer,
} from './state.js';
export { rankEntries, pickWinner, entryStatus, logSignBody, reconnectSignBody, type ResultEntry } from './result.js';
export { Session, type SessionOptions } from './session.js';
export { MemoryBus, type MemoryBusOptions, type Transport, type MessageHandler, type PeerHandler } from './transport.js';
export {
  WsHostTransport,
  WsClientTransport,
  WsPeerTransport,
  type WsHostOptions,
  type WsClientOptions,
  type WsPeerOptions,
  type ErrorHandler,
} from './transport-ws.js';
export {
  HostMatch,
  compareFingerprints,
  type HostOptions,
  type ResumeOptions,
  type HostEvents,
  type RejectInfo,
  type RejectCode,
  type RefuseCode,
  type ReconnectCode,
  type LogSignRecord,
} from './host.js';
export {
  ClientMatch,
  type ClientOptions,
  type AdoptOptions,
  type ClientEvents,
  type DroppedInfo,
  type DesyncInfo,
  type ResultInfo,
} from './client.js';
export {
  MatchController,
  isHostRole,
  muteSignalling,
  type MatchControllerOptions,
  type ControllerStatus,
  type ControllerPhase,
  type ControllerFeed,
  type CueKind,
  type MatchRole,
  type HostRole,
  type ClientRole,
} from './controller.js';
