import type { NearAccount } from "near-workspaces";
import type { AttestationPayload } from "@valet/oracle";
import type { GuardFixture } from "../src/fixture.js";
import { decodeSuccess, type RawOutcome } from "../src/agent-raw.js";
import { NEAR } from "../src/paths.js";

export async function availableNear(account: NearAccount): Promise<bigint> {
  const b = await account.balance();
  return BigInt(b.available);
}

export interface PayResultJson {
  status: "paid" | "queued" | "blocked";
  reason?: string;
  pending_id?: string | number;
}

/** The agent calls `pay` with only its function-call key, skipping the ValetAgent wrapper. */
export async function agentPayRaw(
  fx: GuardFixture,
  receiver: string,
  amountYocto: bigint,
  attestation: AttestationPayload | null = null,
  gas?: bigint,
) {
  const outcome = await fx.raw.pay(receiver, amountYocto, attestation, gas);
  return { outcome, parseResult: () => decodeSuccess<PayResultJson>(outcome) };
}

export function payResult(tx: { parseResult: () => PayResultJson | null }): PayResultJson {
  const result = tx.parseResult();
  if (!result) throw new Error("pay returned no value");
  return result;
}

/** Ask the real oracle engine (reading the sandbox chain) for a verdict + attestation. */
export function oracleAttest(fx: GuardFixture, receiver: string, amountYocto: bigint) {
  return fx.engine.evaluate({
    guard: fx.guard.accountId,
    receiver,
    amountYocto: amountYocto.toString(),
  });
}

export type { RawOutcome };
export { NEAR };
