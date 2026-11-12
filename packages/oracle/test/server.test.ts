import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { startServer } from "../src/server.js";
import { RiskEngine } from "../src/engine.js";
import { CodeHashCache } from "../src/codehash-cache.js";
import { generateKeyPairSync, createPublicKey } from "node:crypto";
import { base58Encode } from "../src/base58.js";
import type { GuardReader } from "../src/guard-reader.js";
import type { RpcClient } from "../src/rpc.js";

function minimalEngine(): RiskEngine {
  const { privateKey } = generateKeyPairSync("ed25519");
  const pub = createPublicKey(privateKey);
  const der = pub.export({ format: "der", type: "spki" }) as Buffer;
  const publicKeyRaw = new Uint8Array(der.subarray(der.length - 32));
  const guard: GuardReader = {
    async getConfig() {
      return null;
    },
    async getReceiverStats() {
      return null;
    },
    async isAllowed() {
      return false;
    },
    async isDenied() {
      return false;
    },
    async getAllowlist() {
      return [];
    },
  };
  const rpc: RpcClient = {
    async viewAccount(id) {
      if (id === "near") {
        return {
          account_id: "near",
          amount: "1",
          locked: "0",
          code_hash: "11111111111111111111111111111111",
          storage_usage: 0,
        };
      }
      return null;
    },
    async viewAccessKeys() {
      return [];
    },
    async callView() {
      return null;
    },
  };
  return new RiskEngine({
    rpc,
    guard,
    activity: { async firstSeenMs() { return null; } },
    registry: { async getReports() { return []; } },
    key: {
      privateKey,
      publicKeyRaw,
      nearPublicKey: `ed25519:${base58Encode(publicKeyRaw)}`,
    },
    clock: () => 1_700_000_000_000,
    codeHashCache: new CodeHashCache(null),
  });
}

describe("HTTP server", () => {
  it("check, health, pubkey, reasons LRU", async () => {
    const engine = minimalEngine();
    const handle = await startServer({ port: 0, engine });
    const base = handle.url;

    const health = await fetch(`${base}/v1/health`);
    assert.equal(health.status, 200);

    const pk = await fetch(`${base}/v1/pubkey`);
    const pkJson = (await pk.json()) as { oracle_public_key: string };
    assert.ok(pkJson.oracle_public_key.startsWith("ed25519:"));

    const check = await fetch(`${base}/v1/check`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        guard: "guard.near",
        receiver: "near",
        amount_yocto: "1000000000000000000000000",
      }),
    });
    assert.equal(check.status, 200);
    const body = (await check.json()) as {
      verdict: string;
      reasons_hash: string;
      attestation: { signature: string };
    };
    assert.ok(body.attestation.signature);

    const reasons = await fetch(`${base}/v1/reasons/${body.reasons_hash}`);
    assert.equal(reasons.status, 200);

    await handle.close();
  });
});
