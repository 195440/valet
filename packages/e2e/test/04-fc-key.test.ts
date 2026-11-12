import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { transactions, utils } from "near-api-js";
import { KeyPair } from "near-workspaces";
import { startSandbox, stopSandbox } from "../src/sandbox.js";
import { createAccount, deployGuardFixture } from "../src/fixture.js";
import { NEAR } from "../src/paths.js";
import { availableNear, agentPayRaw, payResult } from "./helpers.js";

before(async () => {
  await startSandbox();
});

after(async () => {
  await stopSandbox();
});

const MILLI_NEAR = NEAR(1) / 1000n;
const publicKey = (kp: KeyPair) => utils.PublicKey.from(kp.getPublicKey().toString());

/** The chain (not our code) must refuse, and with this exact protocol error type. */
async function assertChainRejects(label: string, attempt: () => Promise<unknown>, type: string) {
  await assert.rejects(attempt, (e: { type?: string; message?: string }) => {
    assert.equal(e.type, type, `${label}: expected ${type}, got ${e.type}: ${e.message}`);
    return true;
  });
}

describe("function-call key limits: what a stolen agent key can and cannot do", () => {
  it("cannot move NEAR, change keys, deploy, stake, or call anything but `pay` on the guard", { timeout: 180_000 }, async () => {
    const fx = await deployGuardFixture({ lockDown: true });
    const target = await createAccount("target", 0);
    const targetBefore = await availableNear(target);
    const guardId = fx.guard.accountId;
    const ownerMethods: Array<[string, object]> = [
      ["withdraw", { to: target.accountId, amount: MILLI_NEAR.toString() }],
      ["approve", { id: "1" }],
      ["set_policy", { policy: { per_tx_cap: "1", window_cap: "1", window_hours: 1, pending_ttl_ms: "60000" } }],
      ["add_agent_key", { public_key: fx.raw.publicKey, allowance: "1" }],
      ["set_oracle", { oracle_public_key: null }],
      ["pause", {}],
    ];

    await assertChainRejects("transfer to a third party", () => fx.raw.send([transactions.transfer(MILLI_NEAR)], target.accountId), "RequiresFullAccess");
    await assertChainRejects("transfer to the guard itself", () => fx.raw.send([transactions.transfer(MILLI_NEAR)]), "RequiresFullAccess");
    await assertChainRejects("add a full-access key", () => fx.raw.send([transactions.addKey(publicKey(KeyPair.fromRandom("ed25519")), transactions.fullAccessKey())]), "RequiresFullAccess");
    await assertChainRejects("delete a key", () => fx.raw.send([transactions.deleteKey(utils.PublicKey.from(fx.raw.publicKey))]), "RequiresFullAccess");
    await assertChainRejects("deploy code", () => fx.raw.send([transactions.deployContract(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]))]), "RequiresFullAccess");
    await assertChainRejects("stake", () => fx.raw.send([transactions.stake(MILLI_NEAR, utils.PublicKey.from(fx.raw.publicKey))]), "RequiresFullAccess");
    for (const [method, args] of ownerMethods) {
      await assertChainRejects(`call ${method}`, () => fx.raw.call(guardId, method, args), "MethodNameMismatch");
    }
    await assertChainRejects("call `pay` on another contract", () => fx.raw.call(target.accountId, "pay", {}), "ReceiverMismatch");
    await assertChainRejects(
      "attach a deposit to `pay`",
      () => fx.raw.send([transactions.functionCall("pay", { receiver_id: target.accountId, amount: "1", attestation: null }, 20n * 10n ** 12n, 1n)]),
      "DepositWithFunctionCall",
    );

    assert.equal(await availableNear(target), targetBefore, "no NEAR may have moved");
  });

  it("a key whose gas allowance runs out is locked out until the owner re-keys it", { timeout: 240_000 }, async () => {
    // Just above what one 20 TGas call needs at submission time (~0.0206 NEAR), so it runs dry fast.
    const fx = await deployGuardFixture({ agentAllowance: 22n * 10n ** 21n });
    const vendor = await createAccount("vendor", 0);
    await fx.owner.call(fx.guard, "allow", { account_id: vendor.accountId });

    let served = 0;
    let lockout: { type?: string; message?: string } | null = null;
    for (let i = 0; i < 40 && !lockout; i++) {
      try {
        assert.equal(payResult(await agentPayRaw(fx, vendor.accountId, MILLI_NEAR)).status, "paid");
        served++;
      } catch (e) {
        lockout = e as { type?: string; message?: string };
      }
    }
    assert.ok(lockout, "the allowance must run out");
    assert.equal(lockout.type, "NotEnoughAllowance", lockout.message);
    assert.ok(served >= 1, "at least one call fits in the allowance");

    // The key still exists on-chain, the money is still safe, and the agent simply cannot act.
    const agentKey = fx.raw.publicKey;
    await assert.rejects(() => fx.owner.call(fx.guard, "add_agent_key", { public_key: agentKey, allowance: NEAR(1).toString() }));
    await fx.owner.call(fx.guard, "revoke_agent_key", { public_key: agentKey });
    await fx.owner.call(fx.guard, "add_agent_key", { public_key: agentKey, allowance: NEAR(1).toString() });
    await waitForAgentKey(fx.rpc, fx.guard.accountId, agentKey);

    const paid = payResult(await agentPayRaw(fx, vendor.accountId, MILLI_NEAR));
    assert.equal(paid.status, "paid");
  });
});

async function waitForAgentKey(rpcUrl: string, guardId: string, publicKey: string) {
  const { createRpcClient } = await import("@valet/oracle");
  const rpc = createRpcClient({ url: rpcUrl });
  for (let i = 0; i < 40; i++) {
    const keys = await rpc.viewAccessKeys(guardId);
    const key = keys.find((k) => k.public_key === publicKey);
    const allowance = (key?.access_key.permission as { FunctionCall?: { allowance: string } } | undefined)?.FunctionCall?.allowance;
    if (allowance && BigInt(allowance) >= NEAR(1) / 2n) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("re-added agent key never became visible");
}
