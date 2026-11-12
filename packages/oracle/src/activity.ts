/**
 * Where an account's history comes from. The chain RPC cannot answer "when was this account
 * created" or "how often is it used", so the oracle asks an indexer. Every method returns `null`
 * when the answer is unknown (indexer down, rate limited, unsupported), and the engine treats
 * unknown as unknown, never as good news.
 */
export interface ActivityProvider {
  /** When the account was created (ms since epoch). */
  firstSeenMs(accountId: string): Promise<number | null>;
  /** How many transactions involve the account. */
  txCount?(accountId: string): Promise<number | null>;
  /** When the account's contract code was last deployed (ms since epoch); null if never. */
  lastDeployMs?(accountId: string): Promise<number | null>;
}

export class NoopActivityProvider implements ActivityProvider {
  async firstSeenMs(): Promise<number | null> {
    return null;
  }
}

/**
 * Turn a chain timestamp into milliseconds. Nearblocks sends nanoseconds, as a JSON number for
 * `account` and as a string for the other endpoints.
 */
export function timestampToMs(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n > 1e17) return Math.floor(n / 1_000_000); // nanoseconds
  if (n > 1e14) return Math.floor(n / 1_000); // microseconds
  if (n > 1e11) return Math.floor(n); // milliseconds
  return Math.floor(n * 1_000); // seconds
}

export interface NearblocksOptions {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  /** The API root with its version. Default https://api.nearblocks.io/v3; the testnet's is `NEARBLOCKS_TESTNET_V3`. */
  baseUrl?: string;
  clock?: () => number;
  /** How long a transaction count or deployment answer is reused. Account age is kept for good. */
  ttlMs?: number;
  /** Pause after an HTTP 429 or a network failure, so a rate-limited oracle does not hammer. */
  cooldownMs?: number;
  /**
   * For a command-line run that can afford to wait: on HTTP 429, sleep this long and ask again
   * (up to `rateLimitRetries` times) before giving up. A server leaves this unset and answers
   * "unknown" at once.
   */
  rateLimitWaitMs?: number;
  rateLimitRetries?: number;
  onRateLimit?: (waitMs: number) => void;
  sleep?: (ms: number) => Promise<void>;
}

type Fetched = { healthy: true; body: Record<string, unknown> } | { healthy: false };
type Loaded = { healthy: boolean; value: number | null };

const MAX_MEMO = 2_000;
/** An unknown answer (failure, or "nothing there yet") is asked again after this long. */
const RETRY_UNKNOWN_MS = 60_000;

/** Nearblocks API v3 (v1 and v2 are being switched off; the testnet already runs v3 only). */
const NEARBLOCKS_V3 = "https://api.nearblocks.io/v3";
/** The testnet has its own API root: the mainnet one knows nothing about testnet accounts. */
export const NEARBLOCKS_TESTNET_V3 = "https://api-testnet.nearblocks.io/v3";

/**
 * The API root that matches a chain id from an RPC `status`. Undefined means the default
 * (mainnet), which is also what a node that will not say its chain gets.
 */
export function nearblocksUrlForChain(chainId: string | null | undefined): string | undefined {
  return chainId === "testnet" ? NEARBLOCKS_TESTNET_V3 : undefined;
}
/** One page of deployments: the API allows at most 100 rows, which is more than any real contract has. */
const DEPLOYMENTS_PAGE = 100;

/** Every v3 answer is `{ data, errors?, meta? }`; an answer that carries errors is not an answer. */
function dataOf(body: Record<string, unknown>): unknown {
  if (Array.isArray(body.errors) && body.errors.length > 0) return undefined;
  return "data" in body ? body.data : undefined;
}

/**
 * Account history from the Nearblocks indexer (https://api.nearblocks.io, API v3; the testnet one
 * is https://api-testnet.nearblocks.io/v3). Without an API key the free tier allows only a handful
 * of requests per minute: answers are cached, and a rate-limited lookup comes back `null`, which
 * the engine scores as "unknown".
 */
export class NearblocksProvider implements ActivityProvider {
  private memo = new Map<string, { expiresAt: number; value: number | null }>();
  private cooldownUntil = 0;

  constructor(private options: NearblocksOptions = {}) {}

  async firstSeenMs(accountId: string): Promise<number | null> {
    return this.cached(`age:${accountId}`, Infinity, async () => {
      const r = await this.get(`/accounts/${encodeURIComponent(accountId)}`);
      if (!r.healthy) return { healthy: false, value: null };
      // `data` is the account, or null for a name nobody registered; a genesis account has no `created`.
      const data = dataOf(r.body);
      if (data === undefined) return { healthy: false, value: null };
      const created = (data as { created?: { block_timestamp?: unknown } } | null)?.created;
      return { healthy: true, value: timestampToMs(created?.block_timestamp) };
    });
  }

  async txCount(accountId: string): Promise<number | null> {
    return this.cached(`txs:${accountId}`, this.options.ttlMs ?? 600_000, async () => {
      // v3 keeps `/txns/count` to itself; the account's stats carry the same number as a string.
      const r = await this.get(`/accounts/${encodeURIComponent(accountId)}/stats`);
      if (!r.healthy) return { healthy: false, value: null };
      const data = dataOf(r.body);
      if (data === undefined) return { healthy: false, value: null };
      const raw = (data as { txns?: unknown } | null)?.txns;
      // A capped count reads "10000+": a lower bound is all the thresholds need.
      const digits = typeof raw === "string" ? /^(\d+)\+?$/.exec(raw)?.[1] : typeof raw === "number" ? String(raw) : undefined;
      const n = digits === undefined ? NaN : Number(digits);
      return { healthy: true, value: Number.isFinite(n) && n >= 0 ? n : null };
    });
  }

  async lastDeployMs(accountId: string): Promise<number | null> {
    return this.cached(`deploy:${accountId}`, this.options.ttlMs ?? 600_000, async () => {
      const r = await this.get(`/accounts/${encodeURIComponent(accountId)}/contract/deployments?limit=${DEPLOYMENTS_PAGE}`);
      if (!r.healthy) return { healthy: false, value: null };
      const list = dataOf(r.body);
      if (list === undefined) return { healthy: false, value: null };
      if (!Array.isArray(list)) return { healthy: true, value: null };
      let newest: number | null = null;
      for (const d of list as Array<{ block?: { block_timestamp?: unknown } }>) {
        const ms = timestampToMs(d?.block?.block_timestamp);
        if (ms !== null && (newest === null || ms > newest)) newest = ms;
      }
      return { healthy: true, value: newest };
    });
  }

  private now(): number {
    return (this.options.clock ?? Date.now)();
  }

  private async cached(
    key: string,
    ttlMs: number,
    load: () => Promise<Loaded>,
  ): Promise<number | null> {
    const now = this.now();
    const hit = this.memo.get(key);
    if (hit && now < hit.expiresAt) return hit.value;
    let loaded: Loaded;
    try {
      loaded = await load();
    } catch {
      loaded = { healthy: false, value: null };
    }
    const keep = loaded.healthy && loaded.value !== null ? ttlMs : RETRY_UNKNOWN_MS;
    if (this.memo.size >= MAX_MEMO) this.memo.delete(this.memo.keys().next().value as string);
    this.memo.set(key, { expiresAt: now + keep, value: loaded.value });
    return loaded.value;
  }

  /** GET a JSON document; a pause after 429 or a network error, `healthy: false` on any failure. */
  private async get(path: string): Promise<Fetched> {
    if (this.now() < this.cooldownUntil) return { healthy: false };
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const base = (this.options.baseUrl ?? NEARBLOCKS_V3).replace(/\/+$/, "");
    const headers: Record<string, string> = { Accept: "application/json" };
    const key = this.options.apiKey ?? process.env.NEARBLOCKS_API_KEY;
    if (key) headers.Authorization = `Bearer ${key}`;
    const wait = this.options.rateLimitWaitMs ?? 0;
    const retries = this.options.rateLimitRetries ?? 3;
    try {
      for (let attempt = 0; ; attempt++) {
        const res = await fetchImpl(`${base}${path}`, { headers });
        if (res.status === 429) {
          if (wait > 0 && attempt < retries) {
            this.options.onRateLimit?.(wait);
            await (this.options.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))))(wait);
            continue;
          }
          this.cooldownUntil = this.now() + (this.options.cooldownMs ?? 30_000);
          return { healthy: false };
        }
        if (!res.ok) return { healthy: false };
        const body = (await res.json()) as Record<string, unknown> | null;
        return body && typeof body === "object" ? { healthy: true, body } : { healthy: false };
      }
    } catch {
      this.cooldownUntil = this.now() + (this.options.cooldownMs ?? 30_000);
      return { healthy: false };
    }
  }
}
