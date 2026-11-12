import { connect, keyStores, transactions, utils } from "near-api-js";
import type { Action } from "near-api-js/lib/transaction.js";

const NETWORK_ID = "sandbox";
export const DEFAULT_GAS = 20n * 10n ** 12n;

/**
 * A "compromised agent": it holds only the secret of its access key (never the guard's full-access
 * key) and can send *any* transaction as the guard account, bypassing the ValetAgent wrapper.
 * This is what an attacker who stole the agent's key can do, so tests use it to prove the chain,
 * not the wrapper, is what stops them.
 */
export interface RawSender {
  readonly publicKey: string;
  send(actions: Action[], receiverId?: string): Promise<RawOutcome>;
  call(receiverId: string, method: string, args: object, gas?: bigint): Promise<RawOutcome>;
  pay(
    receiver: string,
    amountYocto: bigint,
    attestation: object | null,
    gas?: bigint,
  ): Promise<RawOutcome>;
}

/** The slice of a final execution outcome the tests read (near-api-js' own typings degrade to `any`). */
export interface RawOutcome {
  status: unknown;
  transaction: { hash: string };
  transaction_outcome: { id: string; outcome: { gas_burnt: number | string; logs: string[] } };
  receipts_outcome: Array<{ id: string; outcome: { gas_burnt: number | string; logs: string[]; status: unknown } }>;
}

export async function rawSender(options: {
  accountId: string;
  rpcUrl: string;
  secretKey: string;
}): Promise<RawSender> {
  const keyPair = utils.KeyPair.fromString(options.secretKey as utils.key_pair.KeyPairString);
  const keyStore = new keyStores.InMemoryKeyStore();
  await keyStore.setKey(NETWORK_ID, options.accountId, keyPair);
  const near = await connect({
    networkId: NETWORK_ID,
    nodeUrl: options.rpcUrl,
    keyStore,
  } as Parameters<typeof connect>[0]);
  const account = await near.account(options.accountId);

  const send = async (actions: Action[], receiverId = options.accountId) =>
    (await account.signAndSendTransaction({ receiverId, actions })) as unknown as RawOutcome;
  const call = (receiverId: string, method: string, args: object, gas = DEFAULT_GAS) =>
    send([transactions.functionCall(method, args, gas, 0n)], receiverId);

  return {
    publicKey: keyPair.getPublicKey().toString(),
    send,
    call,
    pay: (receiver, amountYocto, attestation, gas) =>
      call(
        options.accountId,
        "pay",
        { receiver_id: receiver, amount: amountYocto.toString(), attestation },
        gas,
      ),
  };
}

/** Decode the JSON the contract method returned (`SuccessValue`), or null if it returned nothing. */
export function decodeSuccess<T = unknown>(outcome: RawOutcome): T | null {
  const status = outcome.status as { SuccessValue?: string };
  if (!status.SuccessValue) return null;
  return JSON.parse(Buffer.from(status.SuccessValue, "base64").toString("utf8")) as T;
}

/** Every `EVENT_JSON:` log of every receipt, parsed. */
export function eventsOf(outcome: RawOutcome): Array<{ event: string; data: Record<string, unknown> }> {
  return outcome.receipts_outcome
    .flatMap((r) => r.outcome.logs)
    .filter((l) => l.startsWith("EVENT_JSON:"))
    .map((l) => {
      const parsed = JSON.parse(l.slice("EVENT_JSON:".length)) as {
        event: string;
        data: Array<Record<string, unknown>>;
      };
      return { event: parsed.event, data: parsed.data[0] ?? {} };
    });
}

/** Gas actually burnt by the whole transaction (all receipts). */
export function gasBurnt(outcome: RawOutcome): bigint {
  return (
    BigInt(outcome.transaction_outcome.outcome.gas_burnt) +
    outcome.receipts_outcome.reduce((sum, r) => sum + BigInt(r.outcome.gas_burnt), 0n)
  );
}
