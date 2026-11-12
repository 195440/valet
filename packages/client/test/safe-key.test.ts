import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { utils } from "near-api-js";
import { ValetAgent } from "../src/agent.js";

const GUARD = "vault.test.near";
const keyPair = utils.KeyPair.fromRandom("ed25519");
const publicKey = keyPair.getPublicKey().toString();

type Permission = "FullAccess" | { FunctionCall: { allowance: string | null; receiver_id: string; method_names: string[] } };
const functionCall = (receiver_id: string, method_names: string[]): Permission => ({
  FunctionCall: { allowance: "1000000000000000000000000", receiver_id, method_names },
});

// A stand-in for the RPC node: it answers `view_access_key_list` with whatever `keys` holds.
let keys: Array<{ public_key: string; access_key: { nonce: number; permission: Permission } }> = [];
let server: Server;
let rpcUrl = "";

before(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: "valet", result: { keys, block_height: 1, block_hash: "x" } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  rpcUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function agent(): ValetAgent {
  return new ValetAgent({ guardId: GUARD, agentKey: keyPair.toString(), rpcUrl, oracleUrl: "http://127.0.0.1:9" });
}

function holds(permission: Permission, publicKeyOnChain = publicKey): void {
  keys = [{ public_key: publicKeyOnChain, access_key: { nonce: 0, permission } }];
}

describe("assertSafeKey: only a function-call key limited to `pay` on the vault passes", () => {
  it("accepts the key the vault was set up with", async () => {
    holds(functionCall(GUARD, ["pay"]));
    await agent().assertSafeKey();
  });

  it("refuses a key the vault does not have", async () => {
    holds(functionCall(GUARD, ["pay"]), utils.KeyPair.fromRandom("ed25519").getPublicKey().toString());
    await assert.rejects(agent().assertSafeKey(), /agent key not found on guard vault\.test\.near/);
    keys = [];
    await assert.rejects(agent().assertSafeKey(), /agent key not found/);
  });

  it("refuses a full-access key", async () => {
    holds("FullAccess");
    await assert.rejects(agent().assertSafeKey(), /must not be FullAccess/);
  });

  it("refuses a function-call key for another contract", async () => {
    holds(functionCall("other.test.near", ["pay"]));
    await assert.rejects(agent().assertSafeKey(), /receiver_id must be vault\.test\.near, got other\.test\.near/);
  });

  it("refuses a key that may call more than `pay`", async () => {
    holds(functionCall(GUARD, ["pay", "withdraw"]));
    await assert.rejects(agent().assertSafeKey(), /method_names must be \[pay\]/);
  });

  it("refuses a key with an empty method list, which on NEAR means every method", async () => {
    holds(functionCall(GUARD, []));
    await assert.rejects(agent().assertSafeKey(), /method_names must be \[pay\]/);
  });

  it("never puts the secret key in an error", async () => {
    holds("FullAccess");
    const secret = keyPair.toString();
    await assert.rejects(agent().assertSafeKey(), (e: Error) => !e.message.includes(secret.slice("ed25519:".length)));
  });
});
