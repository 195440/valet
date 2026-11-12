import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createPublicKey } from "node:crypto";
import { RiskEngine } from "../src/engine.js";
import type { GuardReader, GuardConfig } from "../src/guard-reader.js";
import type { RpcClient, AccountView, AccessKeyView } from "../src/rpc.js";
import type { ActivityProvider } from "../src/activity.js";
import type { Registry } from "../src/registry.js";
import { CodeHashCache } from "../src/codehash-cache.js";
import { base58Encode } from "../src/base58.js";
import { verifyAttestationSignature } from "../src/attestation.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";

function testKey() {
  const { privateKey } = generateKeyPairSync("ed25519");
  const pub = createPublicKey(privateKey);
  const der = pub.export({ format: "der", type: "spki" }) as Buffer;
  const publicKeyRaw = new Uint8Array(der.subarray(der.length - 32));
  return {
    privateKey,
    publicKeyRaw,
    nearPublicKey: `ed25519:${base58Encode(publicKeyRaw)}`,
  };
}

function makeEngine(
  overrides: {
    rpc?: Partial<RpcClient> & {
      accounts?: Record<string, AccountView | null>;
      keys?: Record<string, AccessKeyView[]>;
    };
    guard?: Partial<GuardReader>;
    activity?: ActivityProvider;
    registry?: Registry;
    config?: ConstructorParameters<typeof RiskEngine>[1];
    clock?: () => number;
    cachePath?: string;
  } = {},
) {
  const key = testKey();
  const defaultConfig: GuardConfig = {
    owner_id: "owner.near",
    oracle_public_key: key.nearPublicKey,
    policy: {
      per_tx_cap: "1000000000000000000000000",
      window_cap: "10000000000000000000000000",
      window_hours: 24,
      pending_ttl_ms: "3600000",
    },
    paused: false,
    pending_count: 0,
    version: "0.1.0",
  };
  const guard: GuardReader = {
    async getConfig() {
      return overrides.guard?.getConfig?.("g.near") ?? defaultConfig;
    },
    async getReceiverStats(_g, accountId) {
      return overrides.guard?.getReceiverStats?.("g", accountId) ?? null;
    },
    async isAllowed(_g, accountId) {
      return overrides.guard?.isAllowed?.("g", accountId) ?? false;
    },
    async isDenied(_g, accountId) {
      return overrides.guard?.isDenied?.("g", accountId) ?? false;
    },
    async getAllowlist() {
      return overrides.guard?.getAllowlist?.("g.near") ?? [];
    },
  };
  const accounts = overrides.rpc?.accounts ?? {};
  const keysMap = overrides.rpc?.keys ?? {};
  const rpc: RpcClient = {
    async viewAccount(id) {
      if (overrides.rpc?.viewAccount) return overrides.rpc.viewAccount(id);
      return accounts[id] ?? null;
    },
    async viewAccessKeys(id) {
      if (overrides.rpc?.viewAccessKeys) return overrides.rpc.viewAccessKeys(id);
      return keysMap[id] ?? [];
    },
    async callView() {
      return null;
    },
  };
  const activity: ActivityProvider = overrides.activity ?? {
    async firstSeenMs() {
      return null;
    },
  };
  const registry: Registry = overrides.registry ?? {
    async getReports() {
      return [];
    },
  };
  const cacheDir = overrides.cachePath ?? mkdtempSync(join(tmpdir(), "valet-cache-"));
  const engine = new RiskEngine(
    {
      rpc,
      guard,
      activity,
      registry,
      key,
      clock: overrides.clock ?? (() => 1_700_000_000_000),
      codeHashCache: new CodeHashCache(join(cacheDir, "codehash.json")),
    },
    overrides.config ?? { allowBelow: 30, blockFrom: 70 },
  );
  return { engine, key };
}

describe("RiskEngine", () => {
  it("allowlist short-circuit", async () => {
    const { engine } = makeEngine({
      guard: { async isAllowed() { return true; } },
    });
    const r = await engine.evaluate({
      guard: "g.near",
      receiver: "wrap.near",
      amountYocto: "1000",
    });
    assert.equal(r.verdict, "allow");
    assert.equal(r.score, 0);
    assert.ok(r.reasons.some((x) => x.code === "ALLOWLISTED"));
  });

  it("ACCOUNT_NOT_FOUND hard block", async () => {
    const { engine } = makeEngine({
      rpc: { accounts: {} },
    });
    const r = await engine.evaluate({
      guard: "g.near",
      receiver: "missing-account.near",
      amountYocto: "1000",
    });
    assert.equal(r.verdict, "block");
    assert.ok(r.reasons.some((x) => x.code === "ACCOUNT_NOT_FOUND"));
  });

  it("NEW_IMPLICIT_ACCOUNT", async () => {
    const implicit = "a".repeat(64);
    const { engine } = makeEngine({ rpc: { accounts: {} } });
    const r = await engine.evaluate({
      guard: "g.near",
      receiver: implicit,
      amountYocto: "1000",
    });
    assert.ok(r.reasons.some((x) => x.code === "NEW_IMPLICIT_ACCOUNT"));
  });

  it("DENYLISTED hard", async () => {
    const { engine } = makeEngine({
      guard: { async isDenied() { return true; } },
      rpc: {
        accounts: {
          "bad.near": {
            account_id: "bad.near",
            amount: "1",
            locked: "0",
            code_hash: "11111111111111111111111111111111",
            storage_usage: 0,
          },
        },
      },
    });
    const r = await engine.evaluate({ guard: "g.near", receiver: "bad.near", amountYocto: "1" });
    assert.equal(r.verdict, "block");
  });

  it("REGISTRY_REPORTS thresholds", async () => {
    const registry: Registry = {
      async getReports() {
        return [
          { reporter: "a", category: "scam", ts_ms: 1 },
          { reporter: "b", category: "scam", ts_ms: 2 },
        ];
      },
    };
    const { engine } = makeEngine({
      registry,
      rpc: {
        accounts: {
          "x.near": {
            account_id: "x.near",
            amount: "1",
            locked: "0",
            code_hash: "11111111111111111111111111111111",
            storage_usage: 0,
          },
        },
      },
    });
    const r = await engine.evaluate({ guard: "g.near", receiver: "x.near", amountYocto: "1" });
    assert.ok(r.reasons.some((x) => x.code === "REGISTRY_REPORTS" && x.weight === 50));
  });

  it("REGISTRY_REPORTS hard at 3 reporters", async () => {
    const registry: Registry = {
      async getReports() {
        return [
          { reporter: "a", category: "s", ts_ms: 1 },
          { reporter: "b", category: "s", ts_ms: 2 },
          { reporter: "c", category: "s", ts_ms: 3 },
        ];
      },
    };
    const { engine } = makeEngine({
      registry,
      rpc: {
        accounts: {
          "x.near": {
            account_id: "x.near",
            amount: "1",
            locked: "0",
            code_hash: "11111111111111111111111111111111",
            storage_usage: 0,
          },
        },
      },
    });
    const r = await engine.evaluate({ guard: "g.near", receiver: "x.near", amountYocto: "1" });
    assert.equal(r.verdict, "block");
  });

  it("verdict thresholds warn vs block", async () => {
    const { engine } = makeEngine({
      rpc: {
        accounts: {
          "merchant-alpha.near": {
            account_id: "merchant-alpha.near",
            amount: "1",
            locked: "0",
            code_hash: "11111111111111111111111111111111",
            storage_usage: 0,
          },
        },
      },
      guard: {
        async getReceiverStats() {
          return null;
        },
      },
    });
    const r = await engine.evaluate({
      guard: "g.near",
      receiver: "merchant-alpha.near",
      amountYocto: "1",
    });
    // FIRST_TIME (+20) + AGE_UNKNOWN (+10) = 30 -> not < 30, so warn
    assert.equal(r.verdict, "warn");
  });

  it("signed block attestation", async () => {
    const { engine, key } = makeEngine({
      guard: { async isDenied() { return true; } },
      rpc: {
        accounts: {
          "b.near": {
            account_id: "b.near",
            amount: "1",
            locked: "0",
            code_hash: "11111111111111111111111111111111",
            storage_usage: 0,
          },
        },
      },
    });
    const r = await engine.evaluate({ guard: "g.near", receiver: "b.near", amountYocto: "500" });
    assert.equal(r.verdict, "block");
    assert.equal(r.attestation.verdict, "block");
    assert.ok(
      verifyAttestationSignature(key.publicKeyRaw, "g.near", "b.near", r.attestation),
    );
  });

  it("GUARD_UNREADABLE when config missing", async () => {
    const { engine } = makeEngine({
      guard: { async getConfig() { return null; } },
    });
    const r = await engine.evaluate({ guard: "g.near", receiver: "near", amountYocto: "1" });
    assert.ok(r.reasons.some((x) => x.code === "GUARD_UNREADABLE"));
  });

  it("LOOKALIKE_OF_KNOWN", async () => {
    const { engine } = makeEngine({
      rpc: {
        accounts: {
          "wrap.neer": {
            account_id: "wrap.neer",
            amount: "1",
            locked: "0",
            code_hash: "11111111111111111111111111111111",
            storage_usage: 0,
          },
        },
      },
    });
    const r = await engine.evaluate({ guard: "g.near", receiver: "wrap.neer", amountYocto: "1" });
    assert.ok(r.reasons.some((x) => x.code === "LOOKALIKE_OF_KNOWN"));
  });

  it("CONTRACT signals", async () => {
    const dir = mkdtempSync(join(tmpdir(), "valet-ch-"));
    const code = "deadbeefdeadbeefdeadbeefdeadbeef";
    const { engine } = makeEngine({
      cachePath: dir,
      rpc: {
        accounts: {
          "c.near": {
            account_id: "c.near",
            amount: "1",
            locked: "0",
            code_hash: code,
            storage_usage: 100,
          },
        },
        keys: {
          "c.near": [
            {
              public_key: "ed25519:z",
              access_key: { nonce: 0, permission: "FullAccess" },
            },
          ],
        },
      },
    });
    await engine.evaluate({ guard: "g.near", receiver: "c.near", amountYocto: "1" });
    const r2 = await engine.evaluate({ guard: "g.near", receiver: "c.near", amountYocto: "1" });
    assert.ok(r2.reasons.some((x) => x.code === "CONTRACT_UNKNOWN"));
    assert.ok(r2.reasons.some((x) => x.code === "CONTRACT_FULL_ACCESS_KEY"));
    const changed = makeEngine({
      cachePath: dir,
      rpc: {
        accounts: {
          "c.near": {
            account_id: "c.near",
            amount: "1",
            locked: "0",
            code_hash: "cccccccccccccccccccccccccccccccc",
            storage_usage: 100,
          },
        },
        keys: { "c.near": [] },
      },
    });
    const r3 = await changed.engine.evaluate({
      guard: "g.near",
      receiver: "c.near",
      amountYocto: "1",
    });
    assert.ok(r3.reasons.some((x) => x.code === "CONTRACT_CODE_CHANGED"));
  });
});

describe("code baseline", () => {
  const account = (code_hash: string): AccountView => ({
    account_id: "shop.near",
    amount: "1",
    locked: "0",
    code_hash,
    storage_usage: 100,
  });
  const EMPTY = "11111111111111111111111111111111";
  const V1 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const V2 = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

  /** An engine whose receiver code can be swapped between calls and whose baseline persists. */
  function rig(options: { allowed?: boolean; threatFeed?: string } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "valet-baseline-"));
    let current = V1;
    const { engine } = makeEngine({
      cachePath: dir,
      rpc: { viewAccount: async () => account(current) },
      guard: { async isAllowed() { return options.allowed ?? false; } },
      config: { allowBelow: 30, blockFrom: 70, threatFeedPath: options.threatFeed },
    });
    return {
      engine,
      deploy(hash: string) {
        current = hash;
      },
      check: () => engine.evaluate({ guard: "g.near", receiver: "shop.near", amountYocto: "1" }),
    };
  }
  const codes = (r: { reasons: Array<{ code: string }> }) => r.reasons.map((x) => x.code);

  it("keeps flagging an upgraded contract until a human trusts the new code", async () => {
    const t = rig();
    assert.ok(!codes(await t.check()).includes("CONTRACT_CODE_CHANGED"));
    t.deploy(V2);
    assert.ok(codes(await t.check()).includes("CONTRACT_CODE_CHANGED"));
    assert.ok(
      codes(await t.check()).includes("CONTRACT_CODE_CHANGED"),
      "the second check after the swap must still be flagged",
    );
    const trusted = await t.engine.trustCurrentCode("shop.near");
    assert.deepEqual(trusted, { baseline: V1, trusted: V2 });
    assert.ok(!codes(await t.check()).includes("CONTRACT_CODE_CHANGED"));
  });

  it("flags a plain account that deploys a contract after it was first seen", async () => {
    const t = rig();
    t.deploy(EMPTY);
    await t.check();
    t.deploy(V1);
    const r = await t.check();
    assert.ok(codes(r).includes("CONTRACT_CODE_CHANGED"));
    assert.match(r.reasons.find((x) => x.code === "CONTRACT_CODE_CHANGED")!.message, /no contract/);
  });

  it("asks a human when an allow-listed contract is upgraded", async () => {
    const t = rig({ allowed: true });
    const before = await t.check();
    assert.equal(before.verdict, "allow");
    assert.equal(before.score, 0);
    t.deploy(V2);
    const after = await t.check();
    assert.equal(after.verdict, "warn");
    assert.ok(codes(after).includes("ALLOWLISTED"));
    assert.ok(codes(after).includes("CONTRACT_CODE_CHANGED"));
    await t.engine.trustCurrentCode("shop.near");
    assert.equal((await t.check()).verdict, "allow");
  });

  it("threat feed: hard block for strangers, a human decision for allow-listed receivers", async () => {
    const feed = join(mkdtempSync(join(tmpdir(), "valet-feed-")), "feed.json");
    writeFileSync(
      feed,
      JSON.stringify([{ account_id: "shop.near", note: "reported drainer", source: "test" }]),
    );
    const stranger = await rig({ threatFeed: feed }).check();
    assert.equal(stranger.verdict, "block");
    assert.ok(codes(stranger).includes("DENYLISTED"));

    const trusted = await rig({ allowed: true, threatFeed: feed }).check();
    assert.equal(trusted.verdict, "warn");
    assert.ok(codes(trusted).includes("THREAT_FEED_ON_ALLOWLIST"));
    assert.ok(!codes(trusted).includes("DENYLISTED"));
  });
});

describe("history signals and the warn floor", () => {
  const V1 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const DAY = 86_400_000;
  const NOW = 1_700_000_000_000; // the clock makeEngine() uses
  const contract: AccountView = {
    account_id: "vendor.near",
    amount: "1",
    locked: "0",
    code_hash: V1,
    storage_usage: 100,
  };
  const established = {
    async getReceiverStats() {
      return { paid_count: 5, total_paid: "5", first_paid_ms: NOW - 40 * DAY, last_paid_ms: NOW - DAY };
    },
  };

  /** What the indexer says, in days before NOW; a missing field means "unknown". */
  const history = (h: { age?: number; count?: number; deployed?: number }): ActivityProvider => ({
    async firstSeenMs() {
      return h.age === undefined ? null : NOW - h.age * DAY;
    },
    async txCount() {
      return h.count ?? null;
    },
    async lastDeployMs() {
      return h.deployed === undefined ? null : NOW - h.deployed * DAY;
    },
  });

  function vendor(h: Parameters<typeof history>[0], guard: Partial<GuardReader> = {}) {
    return makeEngine({
      rpc: { accounts: { "vendor.near": contract }, keys: { "vendor.near": [] } },
      activity: history(h),
      guard,
      config: { allowBelow: 30, blockFrom: 70, knownContracts: ["vendor.near"] },
    }).engine;
  }
  const check = (e: RiskEngine) => e.evaluate({ guard: "g.near", receiver: "vendor.near", amountYocto: "1" });
  const find = (r: { reasons: Array<{ code: string; weight: number }> }, code: string) =>
    r.reasons.find((x) => x.code === code);

  it("flags code deployed within a week on first sight, and trust signals cannot cancel it", async () => {
    // Paid 5 times before (-20), old (-10) and busy (-10) would add up to -40 against the +30.
    const r = await check(vendor({ age: 900, count: 50_000, deployed: 3 }, established));
    assert.equal(find(r, "CONTRACT_RECENTLY_DEPLOYED")?.weight, 30);
    assert.equal(find(r, "ESTABLISHED_COUNTERPARTY")?.weight, -20);
    assert.equal(r.verdict, "warn", "a swapped contract needs a human, whatever the history says");
    assert.equal(r.score, 30, "the score shown matches the verdict");
  });

  it("weighs code deployed within a month lightly and without a floor", async () => {
    const r = await check(vendor({ age: 900, count: 50_000, deployed: 20 }, established));
    assert.equal(find(r, "CONTRACT_RECENTLY_DEPLOYED")?.weight, 10);
    assert.equal(r.verdict, "allow");
  });

  it("ignores old deployments, unknown deployments and an indexer clock ahead of ours", async () => {
    for (const deployed of [31, 400, undefined, -2]) {
      const r = await check(vendor({ age: 900, count: 50_000, deployed }, established));
      assert.equal(find(r, "CONTRACT_RECENTLY_DEPLOYED"), undefined, `deployed=${deployed}`);
    }
  });

  it("does not count the same upgrade twice when the baseline already caught it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "valet-dup-"));
    const rpcFor = (code: string) => ({
      accounts: { "vendor.near": { ...contract, code_hash: code } },
      keys: { "vendor.near": [] },
    });
    const config = { allowBelow: 30, blockFrom: 70, knownContracts: ["vendor.near"] };
    await makeEngine({ cachePath: dir, rpc: rpcFor(V1), config }).engine.evaluate({
      guard: "g.near",
      receiver: "vendor.near",
      amountYocto: "1",
    });
    const r = await makeEngine({
      cachePath: dir,
      rpc: rpcFor("BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"),
      activity: history({ age: 900, count: 50_000, deployed: 1 }),
      guard: established,
      config,
    }).engine.evaluate({ guard: "g.near", receiver: "vendor.near", amountYocto: "1" });
    assert.ok(find(r, "CONTRACT_CODE_CHANGED"));
    assert.equal(find(r, "CONTRACT_RECENTLY_DEPLOYED"), undefined);
    assert.equal(r.verdict, "warn", "a code change is also a floor");
  });

  it("scores activity: thin history +10, a busy account -10, unknown adds nothing", async () => {
    const codes = async (count: number | undefined) =>
      (await check(vendor({ age: 900, count }))).reasons.map((x) => `${x.code}:${x.weight}`);
    assert.ok((await codes(0)).includes("LOW_ACTIVITY:10"));
    assert.ok((await codes(4)).includes("LOW_ACTIVITY:10"));
    const five = await codes(5);
    assert.ok(!five.some((c) => c.startsWith("LOW_ACTIVITY") || c.startsWith("ACTIVE_ACCOUNT")));
    const busy = await codes(1000);
    assert.ok(busy.includes("ACTIVE_ACCOUNT:-10"));
    const unknown = await codes(undefined);
    assert.ok(!unknown.some((c) => c.startsWith("LOW_ACTIVITY") || c.startsWith("ACTIVE_ACCOUNT")));
  });

  it("lookup() checks the receiver alone: no vault reads, no attestation", async () => {
    let guardReads = 0;
    const engine = vendor(
      { age: 2, count: 1 },
      {
        async getConfig() {
          guardReads++;
          return null;
        },
      },
    );
    const r = await engine.lookup("vendor.near");
    assert.equal(guardReads, 0);
    assert.ok(!("attestation" in r));
    const codes = r.reasons.map((x) => x.code);
    assert.ok(!codes.includes("GUARD_UNREADABLE"));
    assert.ok(!codes.includes("FIRST_TIME_RECEIVER"), "payment history belongs to a vault");
    assert.ok(codes.includes("ACCOUNT_YOUNG"));
    assert.ok(codes.includes("LOW_ACTIVITY"));
  });

  it("lookup() still blocks a lookalike and a missing account", async () => {
    const { engine } = makeEngine({ rpc: { accounts: {} } });
    const r = await engine.lookup("wrap.neer");
    assert.equal(r.verdict, "block");
    const codes = r.reasons.map((x) => x.code);
    assert.ok(codes.includes("ACCOUNT_NOT_FOUND"));
    assert.ok(codes.includes("LOOKALIKE_OF_KNOWN"));
  });
});
