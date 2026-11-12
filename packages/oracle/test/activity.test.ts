import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { NearblocksProvider, timestampToMs } from "../src/activity.js";

/**
 * Response bodies captured from https://api.nearblocks.io/v3 on 2026-11-10 (hashes shortened).
 * The first versions of this provider spoke API v1, which answered `{ account: [ {...} ] }` with
 * numeric timestamps and counted transactions at `/txns/count`. v3 answers `{ data }`, sends
 * timestamps as strings and keeps the count endpoint to itself (the count is in the account's
 * stats). The testnet's API has run v3 only since 2026-11-05: v1 there answers HTTP 410.
 */
const REAL = {
  account: {
    data: {
      account_id: "aurora",
      created: { block_timestamp: "1618480717963672677", transaction_hash: "4pXU…" },
      deleted: {},
      locked: false,
    },
  },
  /** A name nobody registered. */
  accountMissing: { data: null },
  /** A genesis account: it exists, but nobody can say when it was created. */
  accountGenesis: { data: { account_id: "testnet", created: {}, deleted: {}, locked: false } },
  stats: {
    data: {
      active_days: "2035",
      first_day: "2021-04-15",
      last_day: "2026-11-09",
      longest_streak: { days: "1890", end: "2026-11-09", start: "2021-09-07" },
      txns: "127578190",
      unique_days: "1949",
    },
  },
  statsMissing: { data: null },
  /** Oldest first: the newest deployment is the last row here, but the provider must not rely on that. */
  deployments: {
    data: [
      {
        block: { block_hash: "6MRn…", block_height: "37157754", block_timestamp: "1620821175255687198" },
        predecessor_account_id: "aurora",
        transaction_hash: "2D4R…",
      },
      {
        block: { block_hash: "4exU…", block_height: "218961585", block_timestamp: "1791390473516268947" },
        predecessor_account_id: "aurora",
        transaction_hash: "BSDx…",
      },
    ],
  },
  noDeployments: { data: [] },
  rateLimited: {
    message:
      "You have exceeded your API request limit. Please try again later or upgrade your plan for higher limits at https://nearblocks.io/apis.",
  },
  v1Retired: { data: null, errors: [{ message: "API v1 was retired on 2026-11-05. Use /v3; see /api-docs/migration." }] },
};

const AURORA_CREATED_MS = 1618480717963;

interface Call {
  url: string;
  authorization?: string;
}

/** A fetch that answers from a queue of [status, body] and records what was asked. */
function fakeFetch(...answers: Array<[number, unknown] | Error>) {
  const calls: Call[] = [];
  const impl = (async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url: String(url), authorization: init?.headers?.Authorization });
    const next = answers.length > 1 ? answers.shift()! : answers[0]!;
    if (next instanceof Error) throw next;
    const [status, body] = next;
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("timestampToMs", () => {
  it("understands nanoseconds, microseconds, milliseconds and seconds, as numbers or strings", () => {
    assert.equal(timestampToMs(1613398225524785200), 1613398225524);
    assert.equal(timestampToMs("1613398225524785200"), 1613398225524);
    assert.equal(timestampToMs(1613398225524785), 1613398225524);
    assert.equal(timestampToMs(1613398225524), 1613398225524);
    assert.equal(timestampToMs(1613398225), 1613398225000);
  });
  it("rejects anything that is not a positive time", () => {
    for (const v of [undefined, null, "", "abc", 0, -5, NaN, {}, []]) assert.equal(timestampToMs(v), null, String(v));
  });
});

describe("NearblocksProvider", () => {
  let savedKey: string | undefined;
  beforeEach(() => {
    savedKey = process.env.NEARBLOCKS_API_KEY;
    delete process.env.NEARBLOCKS_API_KEY;
  });
  afterEach(() => {
    if (savedKey === undefined) delete process.env.NEARBLOCKS_API_KEY;
    else process.env.NEARBLOCKS_API_KEY = savedKey;
  });

  it("reads the account creation time from the real v3 response", async () => {
    const { impl, calls } = fakeFetch([200, REAL.account]);
    const p = new NearblocksProvider({ fetchImpl: impl });
    const ms = await p.firstSeenMs("aurora");
    assert.equal(new Date(ms!).toISOString(), "2021-04-15T09:58:37.963Z");
    assert.equal(calls[0]!.url, "https://api.nearblocks.io/v3/accounts/aurora");
  });

  it("also reads a timestamp sent as a number", async () => {
    const p = new NearblocksProvider({
      fetchImpl: fakeFetch([200, { data: { created: { block_timestamp: 1613398225524785200 } } }]).impl,
    });
    assert.equal(await p.firstSeenMs("a.near"), 1613398225524);
  });

  it("answers null for an account that does not exist, and for one with no creation time", async () => {
    const missing = new NearblocksProvider({ fetchImpl: fakeFetch([200, REAL.accountMissing]).impl });
    assert.equal(await missing.firstSeenMs("nobody.near"), null);
    const genesis = new NearblocksProvider({ fetchImpl: fakeFetch([200, REAL.accountGenesis]).impl });
    assert.equal(await genesis.firstSeenMs("testnet"), null);
  });

  it("reads the transaction count from the account's stats: exact, zero, and capped", async () => {
    const { impl, calls } = fakeFetch(
      [200, REAL.stats],
      [200, { data: { txns: "0" } }],
      [200, { data: { txns: "10000+" } }],
      [200, REAL.statsMissing],
    );
    const p = new NearblocksProvider({ fetchImpl: impl });
    assert.equal(await p.txCount("aurora"), 127578190);
    assert.equal(await p.txCount("empty.near"), 0);
    assert.equal(await p.txCount("busy.near"), 10000, "a capped count is a lower bound, which is all the thresholds need");
    assert.equal(await p.txCount("nobody.near"), null);
    assert.equal(calls[0]!.url, "https://api.nearblocks.io/v3/accounts/aurora/stats");
  });

  it("does not read a count that is not a number", async () => {
    for (const txns of ["many", "", "-3", null, {}]) {
      const p = new NearblocksProvider({ fetchImpl: fakeFetch([200, { data: { txns } }]).impl });
      assert.equal(await p.txCount("a.near"), null, JSON.stringify(txns));
    }
  });

  it("takes the newest contract deployment, in whatever order the rows come, and null when there is none", async () => {
    const newest = "2026-10-07T16:27:53.516Z";
    const { impl, calls } = fakeFetch(
      [200, REAL.deployments],
      [200, { data: [...REAL.deployments.data].reverse() }],
      [200, REAL.noDeployments],
    );
    const p = new NearblocksProvider({ fetchImpl: impl });
    assert.equal(new Date((await p.lastDeployMs("aurora"))!).toISOString(), newest);
    assert.equal(new Date((await p.lastDeployMs("reversed.near"))!).toISOString(), newest);
    assert.equal(await p.lastDeployMs("plain.near"), null);
    assert.equal(calls[0]!.url, "https://api.nearblocks.io/v3/accounts/aurora/contract/deployments?limit=100");
  });

  it("does not ask twice for something it knows; account age is kept for good", async () => {
    let now = 1_000_000;
    const { impl, calls } = fakeFetch([200, REAL.account], [200, REAL.stats]);
    const p = new NearblocksProvider({ fetchImpl: impl, clock: () => now, ttlMs: 600_000 });
    await p.firstSeenMs("aurora");
    await p.txCount("aurora");
    now += 599_000;
    await p.firstSeenMs("aurora");
    await p.txCount("aurora");
    assert.equal(calls.length, 2);
    now += 10_000_000; // past the count's lifetime
    await p.firstSeenMs("aurora");
    assert.equal(calls.length, 2, "creation time never changes");
    await p.txCount("aurora");
    assert.equal(calls.length, 3, "the count is refreshed after its lifetime");
  });

  it("retries an unknown answer after a minute, not on every payment", async () => {
    let now = 0;
    const { impl, calls } = fakeFetch([200, REAL.accountMissing], [200, REAL.account]);
    const p = new NearblocksProvider({ fetchImpl: impl, clock: () => now });
    assert.equal(await p.firstSeenMs("later.near"), null);
    now += 30_000;
    assert.equal(await p.firstSeenMs("later.near"), null);
    assert.equal(calls.length, 1);
    now += 31_000;
    assert.equal(await p.firstSeenMs("later.near"), AURORA_CREATED_MS, "the account exists by now");
    assert.equal(calls.length, 2);
  });

  it("goes quiet for a while after HTTP 429 and says unknown, never an error", async () => {
    let now = 0;
    const { impl, calls } = fakeFetch([429, REAL.rateLimited], [200, REAL.account]);
    const p = new NearblocksProvider({ fetchImpl: impl, clock: () => now, cooldownMs: 30_000 });
    assert.equal(await p.firstSeenMs("a.near"), null);
    assert.equal(await p.txCount("a.near"), null);
    assert.equal(calls.length, 1, "no hammering while rate limited");
    now += 31_000;
    assert.equal(await p.firstSeenMs("b.near"), AURORA_CREATED_MS);
    assert.equal(calls.length, 2);
  });

  it("a command-line run can wait out a 429 and ask again", async () => {
    const waits: number[] = [];
    const { impl, calls } = fakeFetch([429, REAL.rateLimited], [429, REAL.rateLimited], [200, REAL.account]);
    const p = new NearblocksProvider({
      fetchImpl: impl,
      rateLimitWaitMs: 12_000,
      onRateLimit: (ms) => waits.push(ms),
      sleep: async () => {},
    });
    assert.equal(await p.firstSeenMs("aurora"), AURORA_CREATED_MS);
    assert.deepEqual(waits, [12_000, 12_000]);
    assert.equal(calls.length, 3);
  });

  it("gives up after the retries are used", async () => {
    const { impl, calls } = fakeFetch([429, REAL.rateLimited]);
    const p = new NearblocksProvider({
      fetchImpl: impl,
      rateLimitWaitMs: 1,
      rateLimitRetries: 2,
      sleep: async () => {},
    });
    assert.equal(await p.firstSeenMs("a.near"), null);
    assert.equal(calls.length, 3, "one try and two retries");
  });

  it("treats a network failure, a server error, a retired API version and garbage as unknown", async () => {
    const answers: Array<Error | [number, unknown]> = [
      new Error("socket hang up"),
      [503, { message: "down" }],
      [410, REAL.v1Retired],
      [200, "not an object"],
      [200, REAL.v1Retired], // an error envelope is not an answer, even with a 200
      [200, { account: [{ created: { block_timestamp: 1613398225524785200 } }] }], // the old v1 shape: not v3, so unknown
    ];
    for (const answer of answers) {
      const p = new NearblocksProvider({ fetchImpl: fakeFetch(answer).impl });
      assert.equal(await p.firstSeenMs("a.near"), null, JSON.stringify(answer instanceof Error ? answer.message : answer));
    }
  });

  it("sends the API key as a bearer token, and nothing without one", async () => {
    const withKey = fakeFetch([200, REAL.account]);
    await new NearblocksProvider({ fetchImpl: withKey.impl, apiKey: "k-123" }).firstSeenMs("a.near");
    assert.equal(withKey.calls[0]!.authorization, "Bearer k-123");
    const without = fakeFetch([200, REAL.account]);
    await new NearblocksProvider({ fetchImpl: without.impl }).firstSeenMs("a.near");
    assert.equal(without.calls[0]!.authorization, undefined);
  });

  it("encodes the account id in the URL", async () => {
    const { impl, calls } = fakeFetch([200, REAL.account]);
    await new NearblocksProvider({ fetchImpl: impl }).firstSeenMs("a/../b?x=1");
    assert.equal(calls[0]!.url, "https://api.nearblocks.io/v3/accounts/a%2F..%2Fb%3Fx%3D1");
  });

  it("asks the API it is pointed at, for example the testnet's, with or without a trailing slash", async () => {
    for (const baseUrl of ["https://api-testnet.nearblocks.io/v3", "https://api-testnet.nearblocks.io/v3/"]) {
      const { impl, calls } = fakeFetch([200, REAL.account]);
      await new NearblocksProvider({ fetchImpl: impl, baseUrl }).firstSeenMs("vault.valet-1.testnet");
      assert.equal(calls[0]!.url, "https://api-testnet.nearblocks.io/v3/accounts/vault.valet-1.testnet");
    }
  });
});
