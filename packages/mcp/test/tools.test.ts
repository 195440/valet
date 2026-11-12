import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CheckSummary, PayParams, PayResponse } from "@valet/client";
import { createTools, isAccountId, toolDefinitions, type ToolAgent } from "../src/tools.js";

function response(overrides: Partial<PayResponse> = {}): PayResponse {
  return { status: "paid", stage: "chain", reasons: [], events: [], ...overrides };
}

function fakeAgent(options: { pay?: (p: PayParams) => Promise<PayResponse>; check?: CheckSummary } = {}) {
  const calls: { pay: PayParams[]; check: PayParams[] } = { pay: [], check: [] };
  const agent: ToolAgent = {
    async pay(params) {
      calls.pay.push(params);
      return options.pay ? options.pay(params) : response();
    },
    async check(params) {
      calls.check.push(params);
      return options.check ?? { verdict: "allow", score: 0, reasons: [] };
    },
  };
  return { agent, calls };
}

const status = async () => "vault=v.test.near";

describe("tool definitions", () => {
  it("exposes valet_pay, valet_check and valet_status with strict schemas", () => {
    assert.deepEqual(toolDefinitions.map((t) => t.name), ["valet_pay", "valet_check", "valet_status"]);
    for (const tool of toolDefinitions) {
      assert.equal((tool.inputSchema as { additionalProperties?: boolean }).additionalProperties, false, tool.name);
    }
    assert.deepEqual((toolDefinitions[0]!.inputSchema as { required: string[] }).required, ["receiver", "amount_near"]);
  });

  it("marks only valet_pay as able to change things", () => {
    const hints = Object.fromEntries(toolDefinitions.map((t) => [t.name, (t.annotations as { readOnlyHint?: boolean }).readOnlyHint]));
    assert.deepEqual(hints, { valet_pay: false, valet_check: true, valet_status: true });
  });
});

describe("valet_pay", () => {
  it("reports a payment as a plain result with no instructions to the model", async () => {
    const { agent, calls } = fakeAgent({ pay: async () => response({ txHash: "TX1", reasons: [{ code: "ALLOWLISTED", weight: 0, message: "ignored sentence" }] }) });
    const result = await createTools({ agent, status }).call("valet_pay", { receiver: " acme.near ", amount_near: "1.5", memo: "invoice 7" });
    assert.deepEqual(calls.pay, [{ receiver: "acme.near", amountNear: "1.5", memo: "invoice 7" }]);
    assert.equal(result.isError, false);
    assert.match(result.text, /^status=paid$/m);
    assert.match(result.text, /^signals=ALLOWLISTED\(0\)$/m);
    assert.match(result.text, /Paid 1.5 NEAR to acme.near\./);
    assert.doesNotMatch(result.text, /ignored sentence/, "the oracle's sentences stay out of the model's context");
    assert.doesNotMatch(result.text, /Do not retry/);
  });

  it("tells the model not to work around a refusal", async () => {
    const cases: Array<[Partial<PayResponse>, RegExp]> = [
      [{ status: "refused", stage: "oracle", reason: "LOOKALIKE_OF_KNOWN" }, /Do not retry it, split it, or pick a similar-looking account/],
      [{ status: "blocked", stage: "chain", reason: "per_tx_cap" }, /Do not retry it, split it, or send it to a different account/],
      [{ status: "queued", stage: "chain", pendingId: "3" }, /No NEAR moves until the vault's owner approves/],
      [{ status: "refused", stage: "user", reason: "user_denied" }, /The user declined this payment/],
      [{ status: "refused", stage: "user", reason: "no_human_handler" }, /cannot ask one/],
    ];
    for (const [overrides, expected] of cases) {
      const { agent } = fakeAgent({ pay: async () => response(overrides) });
      const result = await createTools({ agent, status }).call("valet_pay", { receiver: "x.near", amount_near: "1" });
      assert.match(result.text, expected, JSON.stringify(overrides));
      assert.equal(result.isError, false, "a refusal is an answer, not a tool failure");
    }
  });

  it("reports a chain error as a tool error", async () => {
    const { agent } = fakeAgent({ pay: async () => response({ status: "error", stage: "chain", reason: "NotEnoughAllowance" }) });
    const result = await createTools({ agent, status }).call("valet_pay", { receiver: "x.near", amount_near: "1" });
    assert.equal(result.isError, true);
    assert.match(result.text, /reason=NotEnoughAllowance/);
    assert.match(result.text, /may not have been sent/);
  });

  it("rejects bad arguments before anything is asked or signed", async () => {
    const bad: Array<Record<string, unknown>> = [
      {},
      { receiver: "x.near" },
      { amount_near: "1" },
      { receiver: "   ", amount_near: "1" },
      { receiver: "x.near", amount_near: "" },
      { receiver: "x.near", amount_near: "1e3" },
      { receiver: "x.near", amount_near: "-1" },
      { receiver: "x.near", amount_near: "ten" },
      { receiver: "x.near", amount_near: { value: 1 } },
      { receiver: 42, amount_near: "1" },
    ];
    const { agent, calls } = fakeAgent();
    const tools = createTools({ agent, status });
    for (const args of bad) {
      const result = await tools.call("valet_pay", args);
      assert.equal(result.isError, true, JSON.stringify(args));
      assert.match(result.text, /^Error: /);
    }
    assert.equal(calls.pay.length, 0);
  });

  it("accepts only real NEAR account ids as receivers, and says nothing of what it was given", async () => {
    const notAccounts = [
      "x", "UPPER.near", "has space.near", "new\nline.near", "-x.near", "x-.near", "x..near", ".x.near",
      "x.near.", "x@y.near", "a".repeat(65), "ünï.near", "x.near\u202e", "x.near\u0000",
    ];
    const { agent, calls } = fakeAgent();
    const tools = createTools({ agent, status });
    for (const receiver of notAccounts) {
      for (const name of ["valet_pay", "valet_check"]) {
        const result = await tools.call(name, { receiver, amount_near: "1" });
        assert.equal(result.isError, true, JSON.stringify(receiver));
        assert.match(result.text, /receiver is not a valid NEAR account id/);
        assert.doesNotMatch(result.text, /ünï|UPPER|new\nline/, "the error must not echo the input");
      }
    }
    assert.equal(calls.pay.length, 0);
    assert.equal(calls.check.length, 0);

    for (const receiver of ["acme-vendor.near", "a1.b2.c3.near", "my_vault.testnet", "ab", "a".repeat(64), "f".repeat(64), `0x${"a".repeat(40)}`]) {
      assert.equal(isAccountId(receiver), true, receiver);
    }
  });

  it("accepts a JSON number for the amount and cuts the memo to 200 characters", async () => {
    const { agent, calls } = fakeAgent();
    await createTools({ agent, status }).call("valet_pay", { receiver: "x.near", amount_near: 0.5, memo: "m".repeat(500) });
    assert.equal(calls.pay[0]!.amountNear, "0.5");
    assert.equal(calls.pay[0]!.memo!.length, 200);
  });

  it("sends payments one at a time, even when one of them fails", async () => {
    const log: string[] = [];
    let n = 0;
    const { agent } = fakeAgent({
      pay: async (p) => {
        const id = ++n;
        log.push(`start ${id} ${p.receiver}`);
        await new Promise((r) => setTimeout(r, 30));
        log.push(`end ${id}`);
        if (id === 1) throw new Error("boom");
        return response();
      },
    });
    const tools = createTools({ agent, status });
    const first = tools.call("valet_pay", { receiver: "a.near", amount_near: "1" }).catch((e: Error) => e.message);
    const second = tools.call("valet_pay", { receiver: "b.near", amount_near: "1" });
    assert.equal(await first, "boom");
    assert.equal((await second).isError, false);
    assert.deepEqual(log, ["start 1 a.near", "end 1", "start 2 b.near", "end 2"]);
  });
});

describe("valet_check", () => {
  it("shows verdict, score and signal codes, and never pays", async () => {
    const { agent, calls } = fakeAgent({
      check: { verdict: "warn", score: 30, reasons: [{ code: "FIRST_TIME_RECEIVER", weight: 20, message: "m" }, { code: "ACCOUNT_AGE_UNKNOWN", weight: 10, message: "m" }] },
    });
    const result = await createTools({ agent, status }).call("valet_check", { receiver: "new.near", amount_near: "0.2" });
    assert.match(result.text, /^verdict=warn$/m);
    assert.match(result.text, /^score=30$/m);
    assert.match(result.text, /^signals=FIRST_TIME_RECEIVER\(20\); ACCOUNT_AGE_UNKNOWN\(10\)$/m);
    assert.match(result.text, /Nothing was signed or sent/);
    assert.equal(calls.pay.length, 0);
    assert.equal(calls.check.length, 1);
  });

  it("validates its arguments like valet_pay", async () => {
    const { agent, calls } = fakeAgent();
    const result = await createTools({ agent, status }).call("valet_check", { receiver: "x.near", amount_near: "lots" });
    assert.equal(result.isError, true);
    assert.equal(calls.check.length, 0);
  });
});

describe("valet_status and unknown tools", () => {
  it("returns whatever the status reader says", async () => {
    const { agent } = fakeAgent();
    assert.deepEqual(await createTools({ agent, status }).call("valet_status", {}), { text: "vault=v.test.near" });
  });

  it("refuses a tool it does not have", async () => {
    const { agent } = fakeAgent();
    const result = await createTools({ agent, status }).call("withdraw", {});
    assert.equal(result.isError, true);
  });
});
