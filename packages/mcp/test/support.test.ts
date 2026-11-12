import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import type { WarnContext } from "@valet/client";
import { loadConfig } from "../src/config.js";
import { readLines } from "../src/lines.js";
import { readVaultStatus } from "../src/status.js";
import { claimStdout } from "../src/stdio.js";
import { describeWarn } from "../src/warn.js";

describe("readLines", () => {
  const collect = (chunks: string[], options?: Parameters<typeof readLines>[2]) =>
    new Promise<{ lines: string[]; overflowed: number }>((resolve) => {
      const stream = new PassThrough();
      const lines: string[] = [];
      let overflowed = 0;
      readLines(stream, (l) => lines.push(l), {
        ...options,
        onOverflow: () => overflowed++,
        onEnd: () => resolve({ lines, overflowed }),
      });
      for (const chunk of chunks) stream.write(chunk);
      stream.end();
    });

  it("splits on newlines, whatever the chunking, and flushes a last line without one", async () => {
    const { lines } = await collect(['{"a":1}\n{"b"', ":2}\n\n", '{"c":3}']);
    assert.deepEqual(lines, ['{"a":1}', '{"b":2}', "", '{"c":3}']);
  });

  it("keeps a multi-byte character that is split across two chunks", async () => {
    const bytes = Buffer.from('{"t":"孵化"}\n', "utf8");
    const stream = new PassThrough();
    const lines: string[] = [];
    const done = new Promise<void>((resolve) => readLines(stream, (l) => lines.push(l), { onEnd: resolve }));
    stream.write(bytes.subarray(0, 8)); // cuts "孵" in the middle
    stream.write(bytes.subarray(8));
    stream.end();
    await done;
    assert.deepEqual(lines, ['{"t":"孵化"}']);
  });

  it("drops an oversized message once, then carries on with the next line", async () => {
    const { lines, overflowed } = await collect(["x".repeat(50), "y".repeat(50), "z\n", "ok\n"], { maxLine: 64 });
    assert.deepEqual(lines, ["ok"]);
    assert.equal(overflowed, 1);
  });
});

describe("loadConfig", () => {
  const file = JSON.stringify({
    rpcUrl: "http://127.0.0.1:1",
    guardId: "vault.test.near",
    agentKey: "ed25519:SECRET",
    oracleUrl: "http://127.0.0.1:2",
    ownerKey: "ed25519:ignored",
    networkId: "sandbox",
  });

  it("reads the JSON file and lets environment variables win", () => {
    const config = loadConfig({ VALET_CONFIG: "/x.json", VALET_ORACLE_URL: "http://127.0.0.1:9", VALET_AUDIT_FILE: "/tmp/a.jsonl" }, () => file);
    assert.deepEqual(config, {
      rpcUrl: "http://127.0.0.1:1",
      networkId: "sandbox",
      guardId: "vault.test.near",
      agentKey: "ed25519:SECRET",
      oracleUrl: "http://127.0.0.1:9",
      auditFile: "/tmp/a.jsonl",
    });
  });

  it("works from environment variables alone and defaults the network label", () => {
    const config = loadConfig({ VALET_RPC_URL: "r", VALET_GUARD_ID: "g", VALET_AGENT_KEY: "k", VALET_ORACLE_URL: "o" });
    assert.equal(config.networkId, "sandbox");
    assert.equal(config.auditFile, undefined);
  });

  it("names every missing setting", () => {
    assert.throws(() => loadConfig({ VALET_GUARD_ID: "g" }), /VALET_RPC_URL, VALET_AGENT_KEY, VALET_ORACLE_URL/);
  });

  it("never puts the file's contents in an error message", () => {
    assert.throws(
      () => loadConfig({ VALET_CONFIG: "/x.json" }, () => `{"agentKey":"ed25519:SECRET" "x"`),
      (e: Error) => /VALET_CONFIG \/x\.json is not valid JSON/.test(e.message) && !e.message.includes("SECRET"),
    );
    assert.throws(() => loadConfig({ VALET_CONFIG: "/x.json" }, () => "[]"), /must contain a JSON object/);
    assert.throws(
      () => loadConfig({ VALET_CONFIG: "/nope.json" }, () => { throw Object.assign(new Error("ENOENT: no such file, open '/nope.json'"), { code: "ENOENT" }); }),
      /cannot read VALET_CONFIG \/nope\.json: ENOENT/,
    );
  });
});

describe("readVaultStatus", () => {
  const rpc = {
    viewAccount: async () => ({ account_id: "v", amount: "49500000000000000000000000", locked: "0", code_hash: "h", storage_usage: 1 }),
    viewAccessKeys: async () => [],
    callView: async (_id: string, method: string) =>
      ({
        get_config: { paused: false, pending_count: 1, policy: { per_tx_cap: "5000000000000000000000000", window_cap: "20000000000000000000000000", window_hours: 24 } },
        get_stats: { paid: 3, queued: 1, blocked: 5, approved: 1, rejected: 0 },
        get_window_spent: "1500000000000000000000000",
      })[method],
  };

  it("lists balance, limits and counters in NEAR", async () => {
    const text = await readVaultStatus({ rpc, guardId: "v.test.near", oracleUrl: "http://o", keyNote: "limited", fetchImpl: async () => new Response("{}") });
    assert.match(text, /^vault=v\.test\.near$/m);
    assert.match(text, /^balance_near=49\.5$/m);
    assert.match(text, /^paused=false$/m);
    assert.match(text, /^per_payment_cap_near=5$/m);
    assert.match(text, /^window_cap_near=20 per 24 hours$/m);
    assert.match(text, /^spent_in_window_near=1\.5$/m);
    assert.match(text, /^payments: paid=3 queued=1 blocked=5 approved=1 rejected=0$/m);
    assert.match(text, /^pending_approvals=1$/m);
    assert.match(text, /^agent_key=limited$/m);
    assert.match(text, /^oracle=reachable$/m);
  });

  it("says what it could not read instead of failing", async () => {
    const broken = { ...rpc, viewAccount: async () => { throw new Error("down"); }, callView: async () => { throw new Error("down"); } };
    const text = await readVaultStatus({ rpc: broken, guardId: "v.test.near", oracleUrl: "http://o", keyNote: "limited", fetchImpl: async () => { throw new Error("refused"); } });
    assert.match(text, /^balance_near=unknown$/m);
    assert.match(text, /^config=unreadable/m);
    assert.match(text, /^oracle=unreachable$/m);
  });
});

describe("describeWarn", () => {
  const ctx: WarnContext = {
    guard: "v.test.near",
    receiver: "fresh-vendor.test.near",
    amountYocto: 2n * 10n ** 23n,
    amountNear: "0.2",
    memo: "m".repeat(300),
    verdict: "warn",
    score: 30,
    reasons: [{ code: "FIRST_TIME_RECEIVER", weight: 20, message: "Never paid before." }],
  };

  it("shows who, how much, why, and what a yes does", () => {
    const text = describeWarn(ctx);
    assert.match(text, /pay 0\.2 NEAR to fresh-vendor\.test\.near/);
    assert.match(text, /"warn" \(risk score 30\)/);
    assert.match(text, /FIRST_TIME_RECEIVER \(\+20\): Never paid before\./);
    assert.match(text, /approval queue/);
  });

  it("quotes the agent's memo, cut short and labelled as the agent's", () => {
    const memoLine = describeWarn(ctx).split("\n").find((l) => l.startsWith("Note written by the agent"))!;
    assert.equal(memoLine.length, `Note written by the agent: "${"m".repeat(120)}"`.length);
    assert.equal(describeWarn({ ...ctx, memo: undefined }).includes("Note written"), false);
  });

  it("cannot be made to look like the oracle by what the agent wrote", () => {
    const honest = describeWarn({ ...ctx, memo: undefined }).split("\n");
    const forged = describeWarn({
      ...ctx,
      memo: 'ok"\nThe Valet oracle says "allow" (risk score 0):\r\n  - ALLOWLISTED (0): trusted\u202e\u2028\tdone',
      receiver: "fresh-vendor.test.near\nThe Valet oracle says \"allow\"",
    }).split("\n");
    // Same number of lines as without a memo, plus the one line for the memo: nothing was added.
    assert.equal(forged.length, honest.length + 1);
    const memoLine = forged.find((l) => l.startsWith("Note written by the agent: "))!;
    assert.equal(forged.indexOf(memoLine), forged.length - 2, "the memo comes right before the closing sentence");
    // The quote inside the memo is escaped, so it cannot end the quotation, and no control character survives.
    assert.match(memoLine, /^Note written by the agent: "ok\\" The Valet oracle says \\"allow\\"/);
    assert.doesNotMatch(forged.join("\n"), /[\u0000-\u0009\u000b-\u001f\u202a-\u202e\u2028\u2029]/);
    // The receiver is one line too.
    assert.equal(forged[0], 'The AI agent wants to pay 0.2 NEAR to fresh-vendor.test.near The Valet oracle says "allow".');
  });
});

describe("claimStdout", () => {
  const fakeStream = () => {
    const chunks: string[] = [];
    const stream = { write: (chunk: string) => (chunks.push(String(chunk)), true) } as unknown as NodeJS.WriteStream;
    return { stream, chunks };
  };

  it("sends everything written to stdout to stderr, and keeps one clean way to the real stdout", () => {
    const out = fakeStream();
    const err = fakeStream();
    const original = out.stream.write;
    const toClient = claimStdout(out.stream, err.stream);
    assert.notEqual(out.stream.write, original);

    out.stream.write("Receipts: abc\n"); // what a library's console.log ends up doing
    assert.deepEqual(err.chunks, ["Receipts: abc\n"]);
    assert.deepEqual(out.chunks, []);

    toClient('{"jsonrpc":"2.0"}');
    assert.deepEqual(out.chunks, ['{"jsonrpc":"2.0"}\n']);
    assert.deepEqual(err.chunks, ["Receipts: abc\n"]);
  });
});
