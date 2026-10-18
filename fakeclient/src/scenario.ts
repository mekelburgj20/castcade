/**
 * Scenario files: what each scripted player does (scores per ball, extra balls, going silent,
 * sending bad BALL_ENDs, a differing fingerprint) and what the match looks like (balls, host,
 * a forced host transfer). Loaded from `fakeclient/scenarios/*.json` or synthesized for the CLI.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { GameFingerprint, PlayerId } from '@castcade/protocol';

export interface PlayerScript {
  playerId: PlayerId;
  displayName?: string;
  rig?: 'pc' | 'vr_headset' | 'real_cabinet';
  /** Cumulative score reported at the end of ball 1, 2, 3, ... */
  scores: number[];
  /** Balls on which the first BALL_END says shootAgain: true (the re-grant then ends the ball). */
  shootAgainOn?: number[];
  /** Send GAME_OVER right after this ball ends (must be below ballsPerGame to mean anything). */
  gameOverAfterBall?: number;
  /** Ignore the first grant for this ball, so the host's ball-end timeout fires. */
  silentOnBall?: number;
  /** On this ball, first send a BALL_END carrying the previous grantSeq (expect REJECT stale_grant). */
  staleBallEndOnBall?: number;
  /** Once, send a BALL_END while someone else holds the grant (expect REJECT not_grant_holder). */
  rogueBallEnd?: boolean;
  /** Fingerprint overrides for this player; any difference from the host's gets refused. */
  game?: Partial<GameFingerprint>;
}

export interface TransferScript {
  /** Trigger when the host has played this many balls and the next grant goes to someone else. */
  afterHostBall: number;
  /** Who should end up host (for host_left this must be the lowest remaining playerId). */
  to: PlayerId;
  reason: 'host_requested' | 'host_left';
}

export interface Scenario {
  name: string;
  description?: string;
  matchId: string;
  ballsPerGame: number;
  host: PlayerId;
  players: PlayerScript[];
  transfer?: TransferScript;
  /** Players whose HELLO the host must refuse. */
  expectRefused?: PlayerId[];
  /** What the host-role fake player does on a PAUSE for a player who is gone. */
  hostPolicy?: { onDisconnect: 'forfeit' | 'wait' };
  /** Host timeout before PAUSE(ball_end_timeout); scenarios with a silent player set it short. */
  ballEndTimeoutMs?: number;
  logSignTimeoutMs?: number;
  expect?: {
    winner?: PlayerId | null;
    ranks?: Record<PlayerId, number>;
    hostTransfers?: number;
    statuses?: Record<PlayerId, 'finished' | 'forfeit' | 'abandoned' | 'disconnected'>;
  };
}

export const defaultFingerprint: GameFingerprint = {
  kind: 'vpx',
  tableName: 'Medieval Madness (Williams 1997) VPW v1.0.1',
  tableHash: 'ab'.repeat(32),
  romName: 'mm_109c',
  romHash: 'cd'.repeat(32),
  physicsHash: null,
  recipeVersion: '0.1.0',
  sidecarHash: 'ef'.repeat(32),
  emulatorVersion: '10.8.0',
};

export const SCENARIO_NAMES = [
  'two-player-three-ball',
  'four-player-transfer-requested',
  'four-player-transfer-host-left',
  'fingerprint-mismatch',
  'rogue-ball-end',
  'silent-client-pause',
  'extra-ball',
  'game-over-early',
] as const;
export type ScenarioName = (typeof SCENARIO_NAMES)[number];

function scenariosDir(): URL {
  // Works from src/ (tsx, vitest) and from dist/ (built CLI): both sit one level below the package root.
  return new URL('../scenarios/', import.meta.url);
}

export function scenarioPath(name: string): string {
  return fileURLToPath(new URL(`${name}.json`, scenariosDir()));
}

/** Load by bundled name or by file path. Validates the shape enough to fail early. */
export function loadScenario(nameOrPath: string): Scenario {
  const path = /[\\/]|\.json$/.test(nameOrPath) ? nameOrPath : scenarioPath(nameOrPath);
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  return validateScenario(raw, path);
}

export function validateScenario(raw: unknown, source = '<inline>'): Scenario {
  if (typeof raw !== 'object' || raw === null) throw new Error(`${source}: scenario must be an object`);
  const s = raw as Partial<Scenario>;
  if (typeof s.name !== 'string') throw new Error(`${source}: name is required`);
  if (typeof s.matchId !== 'string') throw new Error(`${source}: matchId is required`);
  if (typeof s.ballsPerGame !== 'number' || s.ballsPerGame < 1) throw new Error(`${source}: ballsPerGame must be >= 1`);
  if (typeof s.host !== 'string') throw new Error(`${source}: host is required`);
  if (!Array.isArray(s.players) || s.players.length < 2) throw new Error(`${source}: at least two players`);
  for (const p of s.players) {
    if (typeof p.playerId !== 'string') throw new Error(`${source}: every player needs a playerId`);
    if (!Array.isArray(p.scores)) throw new Error(`${source}: ${p.playerId} needs a scores array`);
  }
  if (!s.players.some((p) => p.playerId === s.host)) throw new Error(`${source}: host ${s.host} is not a player`);
  return s as Scenario;
}

export interface GenerateOptions {
  players: number;
  ballsPerGame: number;
  matchId?: string;
  transfer?: 'host_requested' | 'host_left' | null;
  hostId?: PlayerId;
}

/** A plain N-player scenario with distinct, deterministic scores (player i scores i*1000 per ball). */
export function generateScenario(opts: GenerateOptions): Scenario {
  const ids = Array.from({ length: opts.players }, (_, i) => `p${i + 1}`);
  const host = opts.hostId ?? ids[0] ?? 'p1';
  const players: PlayerScript[] = ids.map((id, i) => ({
    playerId: id,
    displayName: `Player ${i + 1}`,
    scores: Array.from({ length: opts.ballsPerGame }, (_, b) => (i + 1) * 1000 * (b + 1) + (b + 1) * 7),
  }));
  const scenario: Scenario = {
    name: `generated-${opts.players}p-${opts.ballsPerGame}b${opts.transfer ? `-${opts.transfer}` : ''}`,
    matchId: opts.matchId ?? 'LOCAL-1',
    ballsPerGame: opts.ballsPerGame,
    host,
    players,
    hostPolicy: { onDisconnect: 'forfeit' },
  };
  if (opts.transfer) {
    const to = ids.filter((id) => id !== host).sort()[0];
    if (!to) throw new Error('a transfer needs a second player');
    scenario.transfer = { afterHostBall: Math.min(2, opts.ballsPerGame), to, reason: opts.transfer };
  }
  return scenario;
}

/** Default scores for a CLI `join` without --scores: the digits in the id pick the curve. */
export function defaultScores(playerId: string, ballsPerGame: number): number[] {
  const n = Number.parseInt(playerId.replace(/\D/g, ''), 10) || 1;
  return Array.from({ length: ballsPerGame }, (_, b) => n * 1000 * (b + 1) + (b + 1) * 7);
}
