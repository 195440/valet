/**
 * A thin signer on top of near-api-js for the testnet script: keep each account's key in memory,
 * send one transaction, read what the contract returned. Nothing here is specific to Valet.
 */
import { connect, keyStores, transactions, utils } from "near-api-js";
import type { Action } from "near-api-js/lib/transaction.js";
import type { RawOutcome } from "@valet/e2e";

type Near = Awaited<ReturnType<typeof connect>>;

/** 50 TGas: plenty for a call into the guard or the registry, and unused gas is refunded. */
export const CALL_GAS = 50n * 10n ** 12n;

export class Chain {
  private constructor(
    readonly networkId: string,
    readonly rpcUrl: string,
    private readonly near: Near,
    private readonly keys: keyStores.InMemoryKeyStore,
  ) {}

  static async connect(networkId: string, rpcUrl: string): Promise<Chain> {
    const keys = new keyStores.InMemoryKeyStore();
    const near = await connect({ networkId, nodeUrl: rpcUrl, keyStore: keys } as Parameters<typeof connect>[0]);
    return new Chain(networkId, rpcUrl, near, keys);
  }

  async setKey(accountId: string, secretKey: string): Promise<void> {
    await this.keys.setKey(this.networkId, accountId, utils.KeyPair.fromString(secretKey as utils.key_pair.KeyPairString));
  }

  /** Sign with `signerId`'s key and wait for the transaction to execute. Throws if it fails. */
  async send(signerId: string, receiverId: string, actions: Action[]): Promise<RawOutcome> {
    const account = await this.near.account(signerId);
    return (await account.signAndSendTransaction({ receiverId, actions })) as unknown as RawOutcome;
  }

  call(
    signerId: string,
    contractId: string,
    method: string,
    args: Record<string, unknown>,
    options: { gas?: bigint; deposit?: bigint } = {},
  ): Promise<RawOutcome> {
    return this.send(signerId, contractId, [
      transactions.functionCall(method, args, options.gas ?? CALL_GAS, options.deposit ?? 0n),
    ]);
  }
}

/** The JSON a contract method returned, or null when it returned nothing readable. */
export function returnValue(outcome: RawOutcome): unknown {
  const candidates = [outcome.status, ...[...outcome.receipts_outcome].reverse().map((r) => r.outcome.status)];
  for (const status of candidates) {
    const value = (status as { SuccessValue?: string } | undefined)?.SuccessValue;
    if (!value) continue;
    try {
      return JSON.parse(Buffer.from(value, "base64").toString("utf8")) as unknown;
    } catch {
      return null;
    }
  }
  return null;
}

/** Poll until `check` says yes. The public RPC shows new state a few blocks late, so this is normal. */
export async function until(what: string, check: () => Promise<boolean>, timeoutMs = 60_000, everyMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check().catch(() => false)) return;
    if (Date.now() > deadline) throw new Error(`gave up waiting for ${what} after ${Math.round(timeoutMs / 1000)} s`);
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
}
