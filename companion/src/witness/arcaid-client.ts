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

export interface ScoreWireStatus {
  /** `ingested` | `duplicate` | `global` | `global_duplicate` | `no_match` | `invalid` (suppressed arrives as `duplicate`). */
  status: string | null;
  game: string | null;
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

  /** `GET /api/witness/report` — one table session (epoch seconds). Idempotent on (device, table, launch). */
  async report(token: string, params: { device: string; table: string; launch: number; exit: number; dur: number }): Promise<void> {
    await this.get('api/witness/report', params, token);
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
      score: number;
      started: number;
      ended: number;
      dur: number;
      reason: string;
      restarts?: number;
      partial?: boolean;
    },
  ): Promise<ScoreWireStatus> {
    const { body } = await this.get('api/witness/score', params, token);
    return {
      status: typeof body['status'] === 'string' ? body['status'] : null,
      game: typeof body['game'] === 'string' ? body['game'] : null,
    };
  }

  /** `GET /api/witness/heartbeat` — "still here"; stale on the server after `HEARTBEAT_STALE_SEC` (300 s). */
  async heartbeat(token: string, device: string): Promise<void> {
    await this.get('api/witness/heartbeat', { device }, token);
  }
}
