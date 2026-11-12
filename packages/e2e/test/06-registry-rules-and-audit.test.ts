import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { signAttestation } from "@valet/oracle";
import { startSandbox, stopSandbox } from "../src/sandbox.js";
import { createAccount, deployGuardFixture, ephemeralOracleKey } from "../src/fixture.js";
import { eventsOf } from "../src/agent-raw.js";
import { NEAR, REPORT_DEPOSIT } from "../src/paths.js";
import { agentPayRaw, availableNear, payResult } from "./helpers.js";

before(async () => {
  await startSandbox();
});

after(async () => {
  await stopSandbox();
});

describe("registry rules", () => {
  it("rejects spam, accepts evidence, and refunds the excess deposit", { timeout: 240_000 }, async () => {
    const fx = await deployGuardFixture({ withRegistry: true, lockDown: true });
    const registry = fx.registry!;
    const target = await createAccount("scamtarget", 0);
    const reporter = await createAccount("reporter", 2);
    const valid = {
      account_id: target.accountId,
      category: "drainer",
      evidence_url: "https://example.com/evidence/drainer-1",
      note: "asked an agent to approve an unlimited allowance",
    };
    const report = (args: Record<string, unknown>, deposit = REPORT_DEPOSIT) =>
      reporter.call(registry, "report", args, { attachedDeposit: deposit });

    await assert.rejects(() => report(valid, REPORT_DEPOSIT / 2n), /attach at least 0\.01 NEAR/);
    await assert.rejects(() => report({ ...valid, evidence_url: "http://example.com/x" }), /https/);
    await assert.rejects(() => report({ ...valid, category: "rude" }), /unknown category/);
    await assert.rejects(() => report({ ...valid, note: "x".repeat(281) }), /note too long/);
    await assert.rejects(() => report({ ...valid, account_id: reporter.accountId }), /cannot report yourself/);
    assert.equal(await registry.view("get_report_count", { account_id: target.accountId }), 0);

    const before = await availableNear(reporter);
    await report(valid, NEAR(1) / 2n); // 0.5 NEAR attached, only 0.01 NEAR is kept
    const spent = before - (await availableNear(reporter));
    assert.ok(spent < NEAR(1) / 20n, `excess deposit must be refunded (spent ${spent})`);

    const reports = (await registry.view("get_reports", { account_id: target.accountId })) as Array<{
      reporter: string;
      evidence_url: string;
      category: string;
    }>;
    assert.equal(reports.length, 1);
    assert.equal(reports[0]!.reporter, reporter.accountId);
    assert.equal(reports[0]!.evidence_url, valid.evidence_url);
    assert.equal(await registry.view("get_total", {}), 1);
  });

  it("puts the reporters' evidence into the oracle's reasons", { timeout: 300_000 }, async () => {
    const fx = await deployGuardFixture({ withRegistry: true, lockDown: true });
    const target = await createAccount("flagged", 0);
    for (let i = 1; i <= 3; i++) {
      const who = await createAccount(`witness${i}`, 1);
      await who.call(
        fx.registry!,
        "report",
        { account_id: target.accountId, category: "scam", evidence_url: `https://example.com/case/${i}`, note: "" },
        { attachedDeposit: REPORT_DEPOSIT },
      );
    }
    const check = await fx.engine.evaluate({
      guard: fx.guard.accountId,
      receiver: target.accountId,
      amountYocto: NEAR(1).toString(),
    });
    assert.equal(check.verdict, "block");
    const reasons = JSON.stringify(check.reasons);
    for (let i = 1; i <= 3; i++) assert.match(reasons, new RegExp(`https://example.com/case/${i}`));
  });
});

describe("audit trail and administration", () => {
  it("emits EVENT_JSON for every outcome and keeps counters", { timeout: 240_000 }, async () => {
    const fx = await deployGuardFixture({ lockDown: false });
    const vendor = await createAccount("vendor", 0);
    const stranger = await createAccount("stranger", 0);
    await fx.owner.call(fx.guard, "allow", { account_id: vendor.accountId });

    const paid = await agentPayRaw(fx, vendor.accountId, NEAR(1));
    const paidEvent = eventsOf(paid.outcome).find((e) => e.event === "payment_paid");
    assert.equal(paidEvent?.data.receiver_id, vendor.accountId);
    assert.equal(paidEvent?.data.amount, NEAR(1).toString());
    assert.equal(paidEvent?.data.via, "allowlist");
    assert.equal(paidEvent?.data.agent_public_key, fx.raw.publicKey);

    const blocked = await agentPayRaw(fx, stranger.accountId, NEAR(1));
    assert.equal(payResult(blocked).reason, "attestation_required");
    const blockedEvent = eventsOf(blocked.outcome).find((e) => e.event === "payment_blocked");
    assert.equal(blockedEvent?.data.reason, "attestation_required");
    assert.equal(blockedEvent?.data.receiver_id, stranger.accountId);

    const stats = (await fx.guard.view("get_stats", {})) as Record<string, string | number>;
    assert.equal(stats.paid, 1);
    assert.equal(stats.blocked, 1);
    assert.equal(stats.total_paid, NEAR(1).toString());
    assert.equal(await fx.guard.view("get_window_spent", {}), NEAR(1).toString());
  });

  it("rotating the oracle key invalidates the old key's attestations", { timeout: 240_000 }, async () => {
    const fx = await deployGuardFixture({ lockDown: false });
    const receiver = await createAccount("payee", 0);
    const next = ephemeralOracleKey();
    const attest = (key: typeof next, nonce: string) =>
      signAttestation(key.privateKey, fx.guard.accountId, receiver.accountId, {
        max_amount: NEAR(1).toString(),
        verdict: "allow",
        expires_ms: String(Date.now() + 120_000),
        nonce,
        reasonsHash: "0",
      });

    await fx.owner.call(fx.guard, "set_oracle", { oracle_public_key: next.nearPublicKey });
    assert.equal(
      payResult(await agentPayRaw(fx, receiver.accountId, NEAR(1), attest(fx.oracleKey, "701"))).reason,
      "bad_signature",
    );
    assert.equal(payResult(await agentPayRaw(fx, receiver.accountId, NEAR(1), attest(next, "702"))).status, "paid");
  });
});
