import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { startSandbox, stopSandbox } from "../src/sandbox.js";
import { deployGuardFixture, assertHardening, createAccount, lockDownGuard } from "../src/fixture.js";
import { agentPayRaw, availableNear, payResult, NEAR } from "./helpers.js";

before(async () => {
  await startSandbox();
});

after(async () => {
  await stopSandbox();
});

describe("allowlist + hardening", () => {
  it("allowlisted receiver pays and updates stats", { timeout: 120_000 }, async () => {
    const fx = await deployGuardFixture();
    await assertHardening(fx.guard.accountId, false);
    const vendor = await createAccount("vendor", 0);
    await fx.owner.call(fx.guard, "allow", { account_id: vendor.accountId });
    const before = await availableNear(vendor);
    const tx = await agentPayRaw(fx, vendor.accountId, NEAR(1));
    const pr = payResult(tx);
    assert.equal(pr.status, "paid");
    assert.equal(await availableNear(vendor), before + NEAR(1));
    const stats = (await fx.guard.view("get_receiver_stats", {
      account_id: vendor.accountId,
    })) as { paid_count: number };
    assert.equal(stats.paid_count, 1);
    await assertHardening(fx.guard.accountId, false);
    await lockDownGuard(fx.guard);
    await assertHardening(fx.guard.accountId, true);
  });

  it("direct pay without attestation blocked for unknown receiver", { timeout: 120_000 }, async () => {
    const fx = await deployGuardFixture({ lockDown: true });
    const recv = await createAccount("recv", 0);
    const before = await availableNear(recv);
    const tx = await agentPayRaw(fx, recv.accountId, NEAR(1), null);
    const pr = payResult(tx);
    assert.equal(pr.status, "blocked");
    assert.equal(pr.reason, "attestation_required");
    assert.equal(await availableNear(recv), before);
  });
});
