import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Chain, returnValue, until } from "../src/testnet/chain.js";
import { TESTNET_HELPER_URL, isFaucetAccountId, requestFundedAccount } from "../src/testnet/faucet.js";
import { explorerFor } from "../src/testnet/links.js";
import { renderMarkdown, type RunRecord } from "../src/testnet/record.js";

const PUBLIC_KEY = "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp";

function fakeFetch(status: number, body = "", seen: Array<{ url: string; init: RequestInit }> = []): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} });
    return new Response(body, { status });
  }) as typeof fetch;
}

describe("the testnet faucet", () => {
  it("only creates top-level .testnet accounts", () => {
    for (const id of ["valet-1a2b3c4d.testnet", "a1.testnet", "x_y-z.testnet"]) assert.equal(isFaucetAccountId(id), true, id);
    for (const id of ["valet.near", "vault.valet-1a2b3c4d.testnet", "testnet", ".testnet", "A.testnet", "a b.testnet", `${"a".repeat(60)}.testnet`, "a.testnet\n"]) {
      assert.equal(isFaucetAccountId(id), false, JSON.stringify(id));
    }
  });

  it("sends the account and its public key to the helper, and nothing else", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    await requestFundedAccount({ accountId: "valet-1a2b3c4d.testnet", publicKey: PUBLIC_KEY, fetchImpl: fakeFetch(200, "", seen) });
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.url, `${TESTNET_HELPER_URL}/account`);
    assert.equal(seen[0]!.init.method, "POST");
    assert.deepEqual(JSON.parse(String(seen[0]!.init.body)), { newAccountId: "valet-1a2b3c4d.testnet", newAccountPublicKey: PUBLIC_KEY });
  });

  it("honours a custom helper URL and trims its trailing slash", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    await requestFundedAccount({ accountId: "a1.testnet", publicKey: PUBLIC_KEY, helperUrl: "https://faucet.example/", fetchImpl: fakeFetch(200, "", seen) });
    assert.equal(seen[0]!.url, "https://faucet.example/account");
  });

  it("refuses a bad request before it touches the network", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = fakeFetch(200, "", seen);
    await assert.rejects(requestFundedAccount({ accountId: "vault.valet.testnet", publicKey: PUBLIC_KEY, fetchImpl }), /top-level \.testnet/);
    await assert.rejects(requestFundedAccount({ accountId: "a1.testnet", publicKey: "secp256k1:abc", fetchImpl }), /ed25519 public key/);
    await assert.rejects(requestFundedAccount({ accountId: "a1.testnet", publicKey: "ed25519:0OIl", fetchImpl }), /ed25519 public key/);
    assert.equal(seen.length, 0);
  });

  it("says what the faucet answered when it refuses", async () => {
    await assert.rejects(
      requestFundedAccount({ accountId: "a1.testnet", publicKey: PUBLIC_KEY, fetchImpl: fakeFetch(429, "  Too   many\nrequests ") }),
      /HTTP 429: Too many requests/,
    );
    await assert.rejects(requestFundedAccount({ accountId: "a1.testnet", publicKey: PUBLIC_KEY, fetchImpl: fakeFetch(500) }), /HTTP 500$/);
  });

  it("says so when the faucet cannot be reached", async () => {
    const fetchImpl = (async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    }) as unknown as typeof fetch;
    await assert.rejects(requestFundedAccount({ accountId: "a1.testnet", publicKey: PUBLIC_KEY, fetchImpl }), /could not reach the testnet faucet.*ENOTFOUND/);
  });
});

describe("explorer links", () => {
  it("point at nearblocks on the testnet and nowhere on a local chain", () => {
    const testnet = explorerFor("testnet");
    assert.equal(testnet.tx("AbC123"), "https://testnet.nearblocks.io/txns/AbC123");
    assert.equal(testnet.account("vault.valet-1.testnet"), "https://testnet.nearblocks.io/address/vault.valet-1.testnet");
    for (const network of ["sandbox", "mainnet", ""]) {
      assert.equal(explorerFor(network).tx("AbC123"), undefined, network);
      assert.equal(explorerFor(network).account("a.near"), undefined, network);
    }
  });

  it("do not let an odd hash change the URL", () => {
    assert.equal(explorerFor("testnet").tx("a/b?c=d"), "https://testnet.nearblocks.io/txns/a%2Fb%3Fc%3Dd");
  });
});

describe("the written record", () => {
  const record: RunRecord = {
    networkId: "testnet",
    rpcUrl: "https://test.rpc.fastnear.com",
    startedAt: "2026-11-10T10:00:00.000Z",
    accounts: [{ role: "vault", id: "vault.valet-1.testnet", note: "a | b\nc" }],
    code: [
      { contract: "guard", account: "vault.valet-1.testnet", onChain: "ab", repo: "ab" },
      { contract: "registry", account: "registry.valet-1.testnet", onChain: "cd", repo: "ef" },
      { contract: "other", account: "other.valet-1.testnet", onChain: "12", repo: null },
    ],
    entries: [
      { story: "Normal day", did: "pay 1 NEAR", happened: "paid", txs: [{ label: "pay", hash: "H1" }] },
      { story: "Injection", did: "pay | lookalike", happened: "refused\nby the oracle", txs: [] },
      { story: "Cap", did: "pay 9", happened: "stopped", txs: [{ label: "a", hash: "H2" }, { label: "b", hash: "H3" }] },
    ],
    checks: 25,
  };

  it("links every account and transaction on the testnet", () => {
    const md = renderMarkdown(record, explorerFor("testnet"));
    assert.match(md, /\[`vault\.valet-1\.testnet`\]\(https:\/\/testnet\.nearblocks\.io\/address\/vault\.valet-1\.testnet\)/);
    assert.match(md, /\[pay\]\(https:\/\/testnet\.nearblocks\.io\/txns\/H1\)/);
    assert.match(md, /\[a\]\(https:\/\/testnet\.nearblocks\.io\/txns\/H2\)<br>\[b\]\(https:\/\/testnet\.nearblocks\.io\/txns\/H3\)/);
    assert.match(md, /25 checks passed\./);
  });

  it("keeps every table row on one line, whatever the text contains", () => {
    const md = renderMarkdown(record, explorerFor("testnet"));
    for (const line of md.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| ---"))) {
      const cells = line.replace(/\\\|/g, "").split("|").length - 2;
      assert.ok(cells === 3 || cells === 5, `unexpected column count in: ${line}`);
    }
    assert.match(md, /a \\\| b c/);
    assert.match(md, /refused by the oracle/);
  });

  it("compares the code on the chain with the checksum in the repository", () => {
    const rows = renderMarkdown(record, explorerFor("testnet")).split("\n");
    assert.ok(rows.find((l) => l.includes("| guard |"))!.endsWith("| yes |"));
    assert.ok(rows.find((l) => l.includes("| registry |"))!.endsWith("| NO |"));
    assert.ok(rows.find((l) => l.includes("| other |"))!.endsWith("| unknown |"));
  });

  it("says plainly when nothing reached the chain, and uses no links on a local chain", () => {
    const md = renderMarkdown(record, explorerFor("sandbox"));
    assert.match(md, /none: nothing reached the chain/);
    assert.doesNotMatch(md, /nearblocks/);
    assert.match(md, /pay `H1…`/);
  });
});

describe("reading a contract's answer", () => {
  const outcome = (top: unknown, receipts: unknown[]) =>
    ({ status: top, receipts_outcome: receipts.map((status) => ({ outcome: { status } })) }) as unknown as Parameters<typeof returnValue>[0];
  const encode = (value: unknown) => ({ SuccessValue: Buffer.from(JSON.stringify(value)).toString("base64") });

  it("reads the transaction's own return value", () => {
    assert.deepEqual(returnValue(outcome(encode({ status: "paid" }), [])), { status: "paid" });
  });

  it("falls back to the last receipt that returned something", () => {
    assert.deepEqual(returnValue(outcome({ SuccessValue: "" }, [encode({ n: 1 }), encode({ n: 2 }), { SuccessValue: "" }])), { n: 2 });
  });

  it("returns null for no value, and for a value that is not JSON", () => {
    assert.equal(returnValue(outcome({ SuccessValue: "" }, [{ SuccessValue: "" }])), null);
    assert.equal(returnValue(outcome({ SuccessValue: Buffer.from("not json").toString("base64") }, [])), null);
    assert.equal(returnValue(outcome({ Failure: {} }, [])), null);
  });
});

describe("waiting for the chain", () => {
  it("returns as soon as the check passes, even after a failed attempt", async () => {
    let calls = 0;
    await until(
      "the thing",
      async () => {
        calls++;
        if (calls === 1) throw new Error("rpc hiccup");
        return calls >= 3;
      },
      2_000,
      5,
    );
    assert.equal(calls, 3);
  });

  it("names what it was waiting for when it gives up", async () => {
    await assert.rejects(until("the vault to exist", async () => false, 30, 5), /gave up waiting for the vault to exist/);
  });
});

describe("the chain wrapper", () => {
  it("exposes the network it was given", async () => {
    // Connecting does not talk to the network; sending does.
    const chain = await Chain.connect("testnet", "http://127.0.0.1:9");
    assert.equal(chain.networkId, "testnet");
    assert.equal(chain.rpcUrl, "http://127.0.0.1:9");
  });
});
