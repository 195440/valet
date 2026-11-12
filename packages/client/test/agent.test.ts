import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { ValetAgent } from "../src/agent.js";
import type { RiskEngine, CheckResult } from "@valet/oracle";

function mockEngine(verdict: CheckResult["verdict"]): RiskEngine {
  return {
    oraclePublicKey: "ed25519:111",
    evaluate: async () =>
      ({
        verdict,
        score: verdict === "block" ? 100 : 10,
        reasons: [{ code: "TEST", weight: 10, message: "test" }],
        reasonsHash: "0",
        attestation: {
          max_amount: "1000",
          verdict,
          expires_ms: String(Date.now() + 60_000),
          nonce: "1",
          reasons: "0",
          signature: "abc",
        },
        evaluatedAtMs: Date.now(),
        oraclePublicKey: "ed25519:111",
      }) satisfies CheckResult,
  } as unknown as RiskEngine;
}

describe("ValetAgent flow (mocked chain)", () => {
  it("refuses at oracle on block verdict", async () => {
    const audits: unknown[] = [];
    const agent = new ValetAgent({
      guardId: "g.test.near",
      agentKey: "ed25519:3D4Y6X5kVs7ZQ8Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9",
      rpcUrl: "http://127.0.0.1:9",
      engine: mockEngine("block"),
      onAudit: (e) => audits.push(e),
    });
    // invalid key format will fail assertSafeKey but pay should still refuse oracle first
    const r = await agent.pay({ receiver: "evil.near", amountNear: "1" });
    assert.equal(r.status, "refused");
    assert.equal(r.stage, "oracle");
    assert.equal(audits.length, 1);
  });

  it("refuses at user when warn denied", async () => {
    const agent = new ValetAgent({
      guardId: "g.test.near",
      agentKey: "ed25519:3D4Y6X5kVs7ZQ8Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9",
      rpcUrl: "http://127.0.0.1:9",
      engine: mockEngine("warn"),
      onWarn: async () => false,
    });
    const r = await agent.pay({ receiver: "new.near", amountNear: "0.1" });
    assert.equal(r.status, "refused");
    assert.equal(r.stage, "user");
  });

  it("tells a human's no from there being nobody to ask", async () => {
    const make = (answer: boolean | "unavailable") =>
      new ValetAgent({
        guardId: "g.test.near",
        agentKey: "ed25519:3D4Y6X5kVs7ZQ8Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9",
        rpcUrl: "http://127.0.0.1:9",
        engine: mockEngine("warn"),
        onWarn: async () => answer,
      });
    assert.equal((await make(false).pay({ receiver: "new.near", amountNear: "0.1" })).reason, "user_denied");
    assert.equal((await make("unavailable").pay({ receiver: "new.near", amountNear: "0.1" })).reason, "no_human_handler");
  });

  it("check() reports the verdict and never touches the chain or the audit log", async () => {
    const audits: unknown[] = [];
    const agent = new ValetAgent({
      guardId: "g.test.near",
      agentKey: "ed25519:3D4Y6X5kVs7ZQ8Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9",
      rpcUrl: "http://127.0.0.1:9", // nothing listens here: a chain call would throw
      engine: mockEngine("warn"),
      onAudit: (e) => audits.push(e),
    });
    const r = await agent.check({ receiver: "new.near", amountNear: "0.1" });
    assert.deepEqual(Object.keys(r).sort(), ["reasons", "score", "verdict"]);
    assert.equal(r.verdict, "warn");
    assert.equal(r.reasons[0]?.code, "TEST");
    assert.equal(audits.length, 0);
  });

  it("refuses a warn when no human handler is configured (fail closed)", async () => {
    const agent = new ValetAgent({
      guardId: "g.test.near",
      agentKey: "ed25519:3D4Y6X5kVs7ZQ8Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9",
      rpcUrl: "http://127.0.0.1:9",
      engine: mockEngine("warn"),
    });
    const r = await agent.pay({ receiver: "new.near", amountNear: "0.1" });
    assert.equal(r.status, "refused");
    assert.equal(r.stage, "user");
    assert.equal(r.reason, "no_human_handler");
  });
});
