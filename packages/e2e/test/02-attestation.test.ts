import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { signAttestation } from "@valet/oracle";
import { startSandbox, stopSandbox } from "../src/sandbox.js";
import { deployGuardFixture, createAccount } from "../src/fixture.js";
import { agentPayRaw, availableNear, oracleAttest, payResult, NEAR } from "./helpers.js";

before(async () => {
  await startSandbox();
});

after(async () => {
  await stopSandbox();
});

describe("attestation enforcement", () => {
  it("valid allow attestation pays; replay nonce_replayed", { timeout: 180_000 }, async () => {
    const fx = await deployGuardFixture({ lockDown: true });
    const recv = await createAccount("recv2", 0);
    const amt = NEAR(1);
    const allowAtt = signAttestation(fx.oracleKey.privateKey, fx.guard.accountId, recv.accountId, {
      max_amount: amt.toString(),
      verdict: "allow",
      expires_ms: String(Date.now() + 120_000),
      nonce: "42",
      reasonsHash: "0",
    });
    const tx1 = await agentPayRaw(fx, recv.accountId, amt, allowAtt);
    assert.equal(payResult(tx1).status, "paid");
    const tx2 = await agentPayRaw(fx, recv.accountId, amt, allowAtt);
    assert.equal(payResult(tx2).reason, "nonce_replayed");
  });

  it("tampered attestations blocked", { timeout: 180_000 }, async () => {
    const fx = await deployGuardFixture({ lockDown: true });
    const recv = await createAccount("recv3", 0);
    const other = await createAccount("recv4", 0);
    const amt = NEAR(1);
    const base = signAttestation(fx.oracleKey.privateKey, fx.guard.accountId, recv.accountId, {
      max_amount: amt.toString(),
      verdict: "allow",
      expires_ms: String(Date.now() + 120_000),
      nonce: "100",
      reasonsHash: "0",
    });
    const wrongReceiver = { ...base, nonce: "101" };
    const txWr = await agentPayRaw(fx, other.accountId, amt, wrongReceiver);
    assert.equal(payResult(txWr).reason, "bad_signature");

    const bigAmt = { ...base, max_amount: NEAR(2).toString(), nonce: "102" };
    const txBig = await agentPayRaw(fx, recv.accountId, NEAR(2), bigAmt);
    assert.equal(payResult(txBig).reason, "bad_signature");

    const overPay = { ...base, nonce: "103" };
    const txOver = await agentPayRaw(fx, recv.accountId, NEAR(2), overPay);
    assert.equal(payResult(txOver).reason, "amount_exceeds_attestation");

    const blockVerdict = signAttestation(fx.oracleKey.privateKey, fx.guard.accountId, recv.accountId, {
      max_amount: amt.toString(),
      verdict: "block",
      expires_ms: String(Date.now() + 120_000),
      nonce: "104",
      reasonsHash: "0",
    });
    assert.equal(payResult(await agentPayRaw(fx, recv.accountId, amt, blockVerdict)).reason, "oracle_block");

    const expired = signAttestation(fx.oracleKey.privateKey, fx.guard.accountId, recv.accountId, {
      max_amount: amt.toString(),
      verdict: "allow",
      expires_ms: "1",
      nonce: "105",
      reasonsHash: "0",
    });
    assert.equal(payResult(await agentPayRaw(fx, recv.accountId, amt, expired)).reason, "attestation_expired");

    const wrongGuard = signAttestation(fx.oracleKey.privateKey, "wrong.test.near", recv.accountId, {
      max_amount: amt.toString(),
      verdict: "allow",
      expires_ms: String(Date.now() + 120_000),
      nonce: "106",
      reasonsHash: "0",
    });
    assert.equal(payResult(await agentPayRaw(fx, recv.accountId, amt, wrongGuard)).reason, "bad_signature");

    const { privateKey: alienPriv } = generateKeyPairSync("ed25519");
    const alienAtt = signAttestation(alienPriv, fx.guard.accountId, recv.accountId, {
      max_amount: amt.toString(),
      verdict: "allow",
      expires_ms: String(Date.now() + 120_000),
      nonce: "107",
      reasonsHash: "0",
    });
    assert.equal(payResult(await agentPayRaw(fx, recv.accountId, amt, alienAtt)).reason, "bad_signature");
  });

  it("no_oracle_configured when oracle cleared", { timeout: 120_000 }, async () => {
    const fx = await deployGuardFixture({ lockDown: true });
    await fx.owner.call(fx.guard, "set_oracle", { oracle_public_key: null });
    const recv = await createAccount("recv5", 0);
    const att = signAttestation(fx.oracleKey.privateKey, fx.guard.accountId, recv.accountId, {
      max_amount: NEAR(1).toString(),
      verdict: "allow",
      expires_ms: String(Date.now() + 120_000),
      nonce: "200",
      reasonsHash: "0",
    });
    const balanceBefore = await availableNear(recv);
    const pr = payResult(await agentPayRaw(fx, recv.accountId, NEAR(1), att));
    assert.equal(pr.reason, "no_oracle_configured");
    assert.equal(await availableNear(recv), balanceBefore);
  });
});
