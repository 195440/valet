import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fetchChainId } from "../src/rpc.js";
import { NEARBLOCKS_TESTNET_V3, nearblocksUrlForChain } from "../src/activity.js";

/** A fetch that answers every JSON-RPC call with `body`, recording what was asked. */
function rpcAnswering(body: unknown, status = 200) {
  const calls: Array<{ url: string; body: { method?: string } }> = [];
  const impl = (async (url: string, init?: { body?: string }) => {
    calls.push({ url: String(url), body: JSON.parse(init?.body ?? "{}") });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("fetchChainId", () => {
  it("asks the node's status and returns its chain id", async () => {
    // What a testnet node answers (the rest of the status is left out).
    const { impl, calls } = rpcAnswering({ jsonrpc: "2.0", id: "valet", result: { chain_id: "testnet", protocol_version: 88 } });
    assert.equal(await fetchChainId({ url: "https://rpc.example/testnet", fetchImpl: impl }), "testnet");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://rpc.example/testnet");
    assert.equal(calls[0]!.body.method, "status");
  });

  it("returns null when the answer carries no chain id", async () => {
    for (const result of [{}, { chain_id: 7 }, null]) {
      const { impl } = rpcAnswering({ jsonrpc: "2.0", id: "valet", result });
      assert.equal(await fetchChainId({ fetchImpl: impl }), null, JSON.stringify(result));
    }
  });

  it("returns null, not an error, when the node cannot be asked", async () => {
    const impl = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as unknown as typeof fetch;
    assert.equal(await fetchChainId({ url: "http://127.0.0.1:1", fetchImpl: impl, timeoutMs: 200 }), null);
  });
});

describe("nearblocksUrlForChain", () => {
  it("sends the testnet to its own API and leaves every other chain on the default", () => {
    assert.equal(nearblocksUrlForChain("testnet"), NEARBLOCKS_TESTNET_V3);
    assert.equal(NEARBLOCKS_TESTNET_V3, "https://api-testnet.nearblocks.io/v3");
    for (const chain of ["mainnet", "localnet", "", null, undefined]) {
      assert.equal(nearblocksUrlForChain(chain), undefined, String(chain));
    }
  });
});
