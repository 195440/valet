/**
 * "The agent's key is stolen": what a thief holding only the function-call key can try, sent
 * straight to the chain with the Valet wrapper skipped. Each attempt reports the real error the
 * chain or the protocol gave. If any of them is ever accepted, that is reported loudly.
 */
import { transactions, utils } from "near-api-js";
import { signAttestation, type RiskEngine } from "@valet/oracle";
import { NEAR, ephemeralOracleKey, type RawSender } from "@valet/e2e";

export interface ThiefResult {
  label: string;
  /** `stopped`: the chain or the protocol refused. `accepted`: it went through (this must never happen). */
  outcome: "stopped" | "accepted";
  by: "guard contract" | "NEAR protocol" | "nobody";
  detail: string;
  /** The transaction, when the attempt got as far as the chain (a protocol refusal never does). */
  txHash?: string;
}

export interface ThiefKit {
  guardId: string;
  vendor: string;
  attacker: string;
  raw: RawSender;
  engine: RiskEngine;
}

interface Attempt {
  label: string;
  run: () => Promise<ThiefResult>;
}

function chainReason(outcome: { status: unknown }): string | undefined {
  const value = (outcome.status as { SuccessValue?: string }).SuccessValue;
  if (!value) return undefined;
  const result = JSON.parse(Buffer.from(value, "base64").toString("utf8")) as { status?: string; reason?: string };
  return result.status === "blocked" ? (result.reason ?? "blocked") : undefined;
}

export function stolenKeyAttempts(kit: ThiefKit): Attempt[] {
  const { guardId, vendor, attacker, raw, engine } = kit;
  const forger = ephemeralOracleKey();

  const viaPay = (label: string, run: () => Promise<{ status: unknown; transaction?: { hash: string } }>): Attempt => ({
    label,
    run: async () => {
      let reason: string | undefined;
      let txHash: string | undefined;
      try {
        const outcome = await run();
        txHash = outcome.transaction?.hash;
        reason = chainReason(outcome);
      } catch (e) {
        // A call the protocol itself refuses (for example an unaffordable gas allowance) is stopped too.
        return { label, outcome: "stopped", by: "NEAR protocol", detail: (e as { type?: string }).type ?? String(e).slice(0, 120) };
      }
      return reason
        ? { label, outcome: "stopped", by: "guard contract", detail: reason, txHash }
        : { label, outcome: "accepted", by: "nobody", detail: "the vault paid: this must never happen", txHash };
    },
  });
  const viaProtocol = (label: string, run: () => Promise<unknown>): Attempt => ({
    label,
    run: async () => {
      try {
        await run();
      } catch (e) {
        return { label, outcome: "stopped", by: "NEAR protocol", detail: (e as { type?: string }).type ?? String(e).slice(0, 120) };
      }
      return { label, outcome: "accepted", by: "nobody", detail: "the protocol accepted it: this must never happen" };
    },
  });

  return [
    viaPay("pay the attacker, no oracle verdict", () => raw.pay(attacker, NEAR(1), null)),
    viaPay("pay the attacker, self-signed 'allow' verdict", async () =>
      raw.pay(
        attacker,
        NEAR(1),
        signAttestation(forger.privateKey, guardId, attacker, {
          max_amount: NEAR(1).toString(),
          verdict: "allow",
          expires_ms: String(Date.now() + 120_000),
          nonce: "1337",
          reasonsHash: "0",
        }),
      ),
    ),
    viaPay("pay the attacker, replay the vendor's real verdict", async () => {
      const genuine = await engine.evaluate({ guard: guardId, receiver: vendor, amountYocto: NEAR(1).toString() });
      return raw.pay(attacker, NEAR(1), genuine.attestation);
    }),
    viaPay("pay the allow-listed vendor 9 NEAR (cap is 5)", () => raw.pay(vendor, NEAR(9), null)),
    viaProtocol("plain NEAR transfer to the attacker", () => raw.send([transactions.transfer(NEAR(1) / 100n)], attacker)),
    viaProtocol("call withdraw() on the vault", () => raw.call(guardId, "withdraw", { to: attacker, amount: NEAR(1).toString() })),
    viaProtocol("add a full-access key for the attacker", () =>
      raw.send([transactions.addKey(utils.PublicKey.from(forger.nearPublicKey), transactions.fullAccessKey())]),
    ),
  ];
}
