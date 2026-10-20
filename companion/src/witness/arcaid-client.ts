/**
 * Thin client for ArcAid's device-facing Witness endpoints. Every call is a GET with query
 * parameters (the shape the AtGames cabinet SDK forced on the server) and the device token in the
 * `x-witness-token` header. Timestamps on the wire are epoch SECONDS (`WitnessService` floors
 * them and `VpxScoreIngestService` converts seconds to SQLite datetimes).
 *
 * `fetch` is injectable so tests never open a socket. Failures are classified, never swallowed:
 * `network` (no response, timeout) and `server` (5xx) are retryable, `auth` (401) and `client`
 * (other 4xx) are final.
 */

export type FetchLike = (input: string, init: { method: 'GET'; headers: Record<string, string>; signal: AbortSignal }) => Promise<FetchResponseLike>;

export interface FetchResponseLike {
  status: number;
  text(): Promise<string>;
}

export type QueryParams = Record<string, string | number | boolean | null | undefined>;

export type ArcaidFailureKind = 'network' | 'server' | 'auth' | 'client';

export class ArcaidError extends Error {
  readonly kind: ArcaidFailureKind;
  readonly status: number | null;
  readonly body: unknown;

  constructor(kind: ArcaidFailureKind, message: string, status: number | null = null, body: unknown = null) {
    super(message);
    this.name = 'ArcaidError';
    this.kind = kind;
    this.status = status;
    this.body = body;
  }

  get retryable(): boolean {
    return this.kind === 'network' || this.kind === 'server';
  }
}

export interface ArcaidResponse {
  status: number;
  body: Record<string, unknown>;
}

export interface CheckinResult {
  /** The server's own timestamp of the check-in (the device sends none). */
  ts: string | null;
  /** Where this device's scores go, as ArcAid words it (P9b), e.g. `Room / Tournament · CHECKED IN · READY`. */
  sendingTo: string | null;
}

export interface ScoreWireStatus {
  /**
   * `ingested` | `duplicate` | `global` | `global_duplicate` | `no_match` | `invalid` (suppressed arrives as
   * `duplicate`) | `not_sanctioned` (ArcAid 2.165.0: a Sanctioned tournament held the score out; `reasons`
   * says why and `fallback` where the play went instead, normally `global`).
   */
  status: string | null;
  game: string | null;
  reasons: string[];
  fallback: string | null;
}

export interface ArcaidClientOptions {
  baseUrl: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 15_000;

export function buildUrl(baseUrl: string, path: string, params: QueryParams): string {
  const url = new URL(path, baseUrl.replace(/\/+$/, '') + '/');
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    url.searchParams.set(k, typeof v === 'boolean' ? (v ? '1' : '0') : String(v));
  }
  return url.toString();
}

function parseBody(text: string): Record<string, unknown> {
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const defaultFetch: FetchLike = (input, init) => globalThis.fetch(input, init);

export class ArcaidClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(opts: ArcaidClientOptions) {
    this.baseUrl = opts.baseUrl;
    this.fetchImpl = opts.fetch ?? defaultFetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** One GET. Resolves on 2xx; throws `ArcaidError` for everything else. */
  async get(path: string, params: QueryParams, token: string | null): Promise<ArcaidResponse> {
    const url = buildUrl(this.baseUrl, path, params);
    const headers: Record<string, string> = { accept: 'application/json' };
    if (token) headers['x-witness-token'] = token;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: FetchResponseLike;
    try {
      res = await this.fetchImpl(url, { method: 'GET', headers, signal: controller.signal });
    } catch (err) {
      clearTimeout(timer);
      const msg = err instanceof Error && err.name === 'AbortError' ? `ArcAid did not answer within ${this.timeoutMs} ms` : `ArcAid unreachable: ${err instanceof Error ? err.message : String(err)}`;
      throw new ArcaidError('network', msg);
    }
    clearTimeout(timer);
    const body = parseBody(await res.text().catch(() => ''));
    if (res.status >= 200 && res.status < 300) return { status: res.status, body };
    const detail = typeof body['error'] === 'string' ? body['error'] : `HTTP ${res.status}`;
    if (res.status === 401) throw new ArcaidError('auth', 'unpaired by ArcAid', 401, body);
    if (res.status >= 500) throw new ArcaidError('server', `ArcAid error: ${detail}`, res.status, body);
    throw new ArcaidError('client', detail, res.status, body);
  }

  /**
   * Redeem a pairing code: `GET /api/witness/pair?code&device&username&type=desktop`. `type` is
   * read by the ArcAid change that adds desktop devices (docs/arcaid-side-changes.md §1); today's
   * server ignores it. Returns the device token, shown once.
   */
  async pair(code: string, deviceId: string, label: string): Promise<string> {
    const { body } = await this.get('api/witness/pair', { code: code.trim().toUpperCase(), device: deviceId, username: label, type: 'desktop' }, null);
    const token = body['token'];
    if (typeof token !== 'string' || !token) throw new ArcaidError('client', 'ArcAid returned no token', 200, body);
    return token;
  }

  /**
   * `GET /api/witness/report` — one table session (epoch seconds), upserted on (device, table,
   * launch): a launch-only report (no `exit`) opens the session in ArcAid's event lobby, the
   * later report with `exit` closes it.
   */
  async report(token: string, params: { device: string; table: string; launch: number; exit?: number | null; dur?: number | null }): Promise<void> {
    await this.get('api/witness/report', params, token);
  }

  /**
   * `GET /api/witness/checkin` — "no table is open on this machine right now" (ADR 0021 tier 2).
   * The server stamps the time; the reply carries the routing line and, when the device's
   * tournament is an event whose check-in window is open, the player's green light.
   */
  async checkin(token: string, device: string): Promise<CheckinResult> {
    const { body } = await this.get('api/witness/checkin', { device }, token);
    return {
      ts: typeof body['ts'] === 'string' ? body['ts'] : null,
      sendingTo: typeof body['sendingTo'] === 'string' && body['sendingTo'] ? body['sendingTo'] : null,
    };
  }

  /**
   * `GET /api/witness/score` — one game's score. A 200 is final whatever `status` says (no_match
   * is a normal answer); only transport failures and 5xx are retried.
   */
  async score(
    token: string,
    params: {
      device: string;
      table: string;
      rom: string | null;
      /** A second name key for the same table (ArcAid turns `-`/`_` into spaces and normalises it). */
      slug?: string | null;
      score: number;
      started: number;
      ended: number;
      dur: number;
      reason: string;
      restarts?: number;
      partial?: boolean;
      /** Table identity (F1): ignored by today's server, read by ArcAid item 11. */
      vps_game?: string | null;
      vps_table?: string | null;
      table_sha256?: string | null;
      table_save_rev?: number | null;
      /** Attestation (F2), compact JSON strings: settings, machine adjustments, builds + cheat flag. */
      ini?: string | null;
      adjustments?: string | null;
      build?: string | null;
    },
  ): Promise<ScoreWireStatus> {
    const { body } = await this.get('api/witness/score', params, token);
    const reasons = Array.isArray(body['reasons']) ? body['reasons'].filter((r): r is string => typeof r === 'string') : [];
    return {
      status: typeof body['status'] === 'string' ? body['status'] : null,
      game: typeof body['game'] === 'string' ? body['game'] : null,
      reasons,
      fallback: typeof body['fallback'] === 'string' ? body['fallback'] : null,
    };
  }

  /** `GET /api/witness/heartbeat` — "still here"; stale on the server after `HEARTBEAT_STALE_SEC` (300 s). */
  async heartbeat(token: string, device: string): Promise<void> {
    await this.get('api/witness/heartbeat', { device }, token);
  }
}
