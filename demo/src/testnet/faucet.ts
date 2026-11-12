/**
 * The testnet faucet. NEAR runs a public "helper" service that creates a funded top-level account
 * for a public key; it is the only thing in this repository that talks to it. Testnet NEAR has
 * no value, and the service decides how much a new account gets.
 */
export const TESTNET_HELPER_URL = "https://helper.testnet.near.org";

const TOP_LEVEL_TESTNET = /^[a-z0-9]+([_-][a-z0-9]+)*\.testnet$/;
const ED25519_PUBLIC_KEY = /^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/;

/** A top-level `<name>.testnet` account id: the only kind the faucet creates. */
export function isFaucetAccountId(id: string): boolean {
  return id.length <= 64 && TOP_LEVEL_TESTNET.test(id);
}

export interface FaucetRequest {
  accountId: string;
  /** `ed25519:<base58>`: the account's first full-access key. */
  publicKey: string;
  helperUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Ask the faucet for a funded account. Resolves once the service accepted the request; the
 * account shows up on the chain a few seconds later, so the caller waits for it.
 */
export async function requestFundedAccount(request: FaucetRequest): Promise<void> {
  if (!isFaucetAccountId(request.accountId)) {
    throw new Error(`"${request.accountId}" is not a top-level .testnet account id`);
  }
  if (!ED25519_PUBLIC_KEY.test(request.publicKey)) {
    throw new Error("the faucet needs an ed25519 public key (ed25519:<base58>)");
  }
  const url = `${(request.helperUrl ?? TESTNET_HELPER_URL).replace(/\/+$/, "")}/account`;
  let response: Response;
  try {
    response = await (request.fetchImpl ?? fetch)(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ newAccountId: request.accountId, newAccountPublicKey: request.publicKey }),
      signal: AbortSignal.timeout(request.timeoutMs ?? 30_000),
    });
  } catch (e) {
    throw new Error(`could not reach the testnet faucet at ${url}: ${String((e as Error).message ?? e)}`);
  }
  if (!response.ok) {
    const body = (await response.text().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 200);
    throw new Error(`the testnet faucet answered HTTP ${response.status}${body ? `: ${body}` : ""}`);
  }
}
