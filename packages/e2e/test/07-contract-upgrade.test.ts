import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { NearAccount } from "near-workspaces";
import { ValetAgent } from "@valet/client";
import { createRpcClient } from "@valet/oracle";
import { startSandbox, stopSandbox, rpcUrl } from "../src/sandbox.js";
import { createAccount, deployGuardFixture, type GuardFixture } from "../src/fixture.js";
import { GUARD_WASM, NEAR, REGISTRY_WASM } from "../src/paths.js";

before(async () => {
  await startSandbox();
});

after(async () => {
  await stopSandbox();
});

const rpc = () => createRpcClient({ url: rpcUrl() });
const amountOf = async (account: NearAccount) => BigInt((await rpc().viewAccount(account.accountId))!.amount);

async function codeHash(account: NearAccount): Promise<string> {
  return (await rpc().viewAccount(account.accountId))!.code_hash;
}

async function waitForCode(account: NearAccount, accept: (hash: string) => boolean): Promise<string> {
  for (let i = 0; i < 80; i++) {
    const hash = await codeHash(account);
    if (accept(hash)) return hash;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${account.accountId}: code did not reach the expected state`);
}

/** The signer of a deploy gets its gas refund a few blocks later: wait for a stable balance. */
async function settle(account: NearAccount): Promise<void> {
  let last = await amountOf(account);
  for (let stable = 0; stable < 4; ) {
    await new Promise((r) => setTimeout(r, 500));
    const now = await amountOf(account);
    stable = now === last ? stable + 1 : 0;
    last = now;
  }
}

function agentWith(fx: GuardFixture, onWarn?: () => Promise<boolean>): ValetAgent {
  return new ValetAgent({
    guardId: fx.guard.accountId,
    agentKey: fx.agentKeyPair.toString(),
    rpcUrl: fx.rpc,
    networkId: "sandbox",
    engine: fx.engine,
    onWarn,
  });
}

describe("contract upgrade after trust was earned", () => {
  it("holds back an allow-listed vendor whose code changed, until a human trusts it", { timeout: 300_000 }, async () => {
    const fx = await deployGuardFixture({ lockDown: true });
    const vendor = await createAccount("upgradable-vendor", 5);
    await vendor.deploy(readFileSync(REGISTRY_WASM));
    const v1 = await waitForCode(vendor, (h) => h !== "11111111111111111111111111111111");
    await fx.owner.call(fx.guard, "allow", { account_id: vendor.accountId });

    // Day one: the vendor is paid and the oracle records v1 as the baseline.
    await settle(vendor);
    let before = await amountOf(vendor);
    const first = await fx.agent.pay({ receiver: vendor.accountId, amountNear: "1" });
    assert.equal(first.status, "paid");
    assert.equal((await amountOf(vendor)) - before, NEAR(1));

    // The vendor ships different code.
    await vendor.deploy(readFileSync(GUARD_WASM));
    const v2 = await waitForCode(vendor, (h) => h !== v1);
    await settle(vendor);
    before = await amountOf(vendor);

    // No human handler: the wrapper fails closed, and keeps doing so on every retry.
    for (let attempt = 0; attempt < 2; attempt++) {
      const held = await fx.agent.pay({ receiver: vendor.accountId, amountNear: "1" });
      assert.equal(held.status, "refused");
      assert.equal(held.stage, "user");
      assert.equal(held.reason, "no_human_handler");
      assert.equal(held.verdict, "warn");
      const changed = held.reasons.find((r) => r.code === "CONTRACT_CODE_CHANGED");
      assert.ok(changed, "CONTRACT_CODE_CHANGED must be among the reasons");
      assert.deepEqual(changed.evidence, { baseline: v1, current: v2 });
      assert.ok(held.reasons.some((r) => r.code === "ALLOWLISTED"));
    }

    // A human who says no stops it too.
    const declined = await agentWith(fx, async () => false).pay({ receiver: vendor.accountId, amountNear: "1" });
    assert.equal(declined.status, "refused");
    assert.equal(declined.reason, "user_denied");
    assert.equal(await amountOf(vendor), before, "nothing may have been paid so far");

    // Reviewing the new code and trusting it clears the flag; the next payment needs no prompt.
    const trusted = await fx.engine.trustCurrentCode(vendor.accountId);
    assert.deepEqual(trusted, { baseline: v1, trusted: v2 });
    const after = await fx.agent.pay({ receiver: vendor.accountId, amountNear: "1" });
    assert.equal(after.status, "paid");
    assert.equal((await amountOf(vendor)) - before, NEAR(1));
  });

  it("flags a plain account that deploys a contract after the oracle first saw it", { timeout: 240_000 }, async () => {
    const fx = await deployGuardFixture({ lockDown: true });
    const stranger = await createAccount("late-deployer", 5);
    const first = await fx.engine.evaluate({
      guard: fx.guard.accountId,
      receiver: stranger.accountId,
      amountYocto: NEAR(1).toString(),
    });
    assert.ok(!first.reasons.some((r) => r.code === "CONTRACT_CODE_CHANGED"));

    await stranger.deploy(readFileSync(REGISTRY_WASM));
    await waitForCode(stranger, (h) => h !== "11111111111111111111111111111111");
    const second = await fx.engine.evaluate({
      guard: fx.guard.accountId,
      receiver: stranger.accountId,
      amountYocto: NEAR(1).toString(),
    });
    const changed = second.reasons.find((r) => r.code === "CONTRACT_CODE_CHANGED");
    assert.ok(changed, "code deployed after the first sighting must be flagged");
    assert.match(changed.message, /no contract/);
    assert.ok(second.score > first.score);
  });
});
