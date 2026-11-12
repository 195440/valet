import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { signAttestation } from "@valet/oracle";
import { startSandbox, stopSandbox } from "../src/sandbox.js";
import { deployGuardFixture, createAccount } from "../src/fixture.js";
import { agentPayRaw, availableNear, payResult, NEAR } from "./helpers.js";

before(async () => {
  await startSandbox();
});

after(async () => {
  await stopSandbox();
});

describe("warn queue + policy", () => {
  it("warn queues; owner approve pays; reject does not", { timeout: 180_000 }, async () => {
    const fx = await deployGuardFixture({ lockDown: true });
    const recv = await createAccount("warnrecv", 0);
    const amt = NEAR(1);
    const att = signAttestation(fx.oracleKey.privateKey, fx.guard.accountId, recv.accountId, {
      max_amount: amt.toString(),
      verdict: "warn",
      expires_ms: String(Date.now() + 3600_000),
      nonce: "501",
      reasonsHash: "0",
    });
    const balanceBefore = await availableNear(recv);
    const tx = await agentPayRaw(fx, recv.accountId, amt, att);
    const pr = payResult(tx);
    assert.equal(pr.status, "queued");
    assert.ok(pr.pending_id);
    assert.equal(await availableNear(recv), balanceBefore, "queued payments must not move money");
    const paid = await fx.owner.call(fx.guard, "approve", { id: String(pr.pending_id) });
    assert.equal((paid as { status: string }).status, "paid");
    const afterApprove = await availableNear(recv);
    assert.equal(afterApprove - balanceBefore, amt, "approval moves exactly the queued amount");
    // second warn + reject
    const att2 = signAttestation(fx.oracleKey.privateKey, fx.guard.accountId, recv.accountId, {
      max_amount: amt.toString(),
      verdict: "warn",
      expires_ms: String(Date.now() + 3600_000),
      nonce: "502",
      reasonsHash: "0",
    });
    const tx2 = await agentPayRaw(fx, recv.accountId, amt, att2);
    const id2 = payResult(tx2).pending_id;
    await fx.owner.call(fx.guard, "reject", { id: String(id2) });
    assert.equal(await availableNear(recv), afterApprove, "a rejected payment moves nothing");
    await assert.rejects(
      () => fx.raw.call(fx.guard.accountId, "approve", { id: String(id2) }),
      (e: { type?: string }) => e.type === "MethodNameMismatch",
    );
  });

  it("caps, deny, pause, withdraw, insufficient", { timeout: 240_000 }, async () => {
    const fx = await deployGuardFixture({
      lockDown: true,
      policy: {
        per_tx_cap: String(NEAR(2)),
        window_cap: String(NEAR(3)),
        window_hours: 24,
        pending_ttl_ms: "3600000",
      },
      fundNear: 10,
    });
    const v = await createAccount("capv", 0);
    await fx.owner.call(fx.guard, "allow", { account_id: v.accountId });
    let pr = payResult(await agentPayRaw(fx, v.accountId, NEAR(3)));
    assert.equal(pr.reason, "per_tx_cap");
    for (let i = 0; i < 3; i++) {
      assert.equal(payResult(await agentPayRaw(fx, v.accountId, NEAR(1))).status, "paid");
    }
    // 3 NEAR already spent in the window: the 4th NEAR crosses window_cap (3 NEAR).
    pr = payResult(await agentPayRaw(fx, v.accountId, NEAR(1)));
    assert.equal(pr.reason, "window_cap");
    const att = signAttestation(fx.oracleKey.privateKey, fx.guard.accountId, v.accountId, {
      max_amount: NEAR(1).toString(),
      verdict: "allow",
      expires_ms: String(Date.now() + 120_000),
      nonce: "601",
      reasonsHash: "0",
    });
    await fx.owner.call(fx.guard, "unallow", { account_id: v.accountId });
    pr = payResult(await agentPayRaw(fx, v.accountId, NEAR(1), att));
    assert.equal(pr.reason, "window_cap");

    const denied = await createAccount("denied", 0);
    await fx.owner.call(fx.guard, "deny", { account_id: denied.accountId });
    pr = payResult(await agentPayRaw(fx, denied.accountId, NEAR(1)));
    assert.equal(pr.reason, "denylisted");
    await fx.owner.call(fx.guard, "allow", { account_id: denied.accountId });
    assert.equal(await fx.guard.view("is_denied", { account_id: denied.accountId }), false);
    assert.equal(await fx.guard.view("is_allowed", { account_id: denied.accountId }), true);

    await fx.owner.call(fx.guard, "pause", {});
    pr = payResult(await agentPayRaw(fx, v.accountId, NEAR(1)));
    assert.equal(pr.reason, "paused");
    await fx.owner.call(fx.guard, "unpause", {});

    const ownerBefore = await availableNear(fx.owner);
    await fx.owner.call(fx.guard, "withdraw", { to: fx.owner.accountId, amount: NEAR(1).toString() });
    assert.ok((await availableNear(fx.owner)) > ownerBefore);
    const mallory = await createAccount("mallory", 1);
    await assert.rejects(
      () => mallory.call(fx.guard, "withdraw", { to: mallory.accountId, amount: NEAR(1).toString() }),
      /owner-only/,
    );

    // Raise the window cap, then drain the vault: a payment beyond the free balance is refused.
    await fx.owner.call(fx.guard, "set_policy", {
      policy: { per_tx_cap: String(NEAR(2)), window_cap: String(NEAR(20)), window_hours: 24, pending_ttl_ms: "3600000" },
    });
    const { available } = await fx.guard.balance();
    await fx.owner.call(fx.guard, "withdraw", {
      to: fx.owner.accountId,
      amount: (BigInt(available.toString()) - NEAR(1) / 2n).toString(),
    });
    pr = payResult(await agentPayRaw(fx, v.accountId, NEAR(1)));
    assert.equal(pr.reason, "insufficient_funds");
  });
});
