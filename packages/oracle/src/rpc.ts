/**
 * The public mainnet endpoint used when nothing else is configured: the free FastNEAR one that the
 * NEAR documentation lists (https://docs.near.org/api/rpc/providers). rpc.mainnet.near.org and
 * rpc.testnet.near.org answer HTTP 429 "THIS ENDPOINT IS DEPRECATED" to most calls now.
 */
export const DEFAULT_RPC_URL = "https://free.rpc.fastnear.com";

export interface AccountView {
  account_id: string;
  amount: string;
  locked: string;
  code_hash: string;
  storage_usage: number;
}

export interface AccessKeyView {
  public_key: string;
  access_key: {
    nonce: number;
    permission: "FullAccess" | FunctionCallPermission;
  };
}

export interface FunctionCallPermission {
  FunctionCall: {
    allowance: string | null;
    receiver_id: string;
    method_names: string[];
  };
}

export interface RpcClient {
  viewAccount(id: string): Promise<AccountView | null>;
  viewAccessKeys(id: string): Promise<AccessKeyView[]>;
  callView(contractId: string, method: string, args: unknown): Promise<unknown>;
}

export interface RpcOptions {
  url?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

async function rpcFetch(
  url: string,
  body: unknown,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      const json = (await res.json()) as {
        error?: { code?: number; message?: string; cause?: { name?: string } };
        result?: unknown;
      };
      if (json.error) {
        const msg = json.error.message ?? "";
        const data = String((json.error as { data?: unknown }).data ?? "");
        if (
          json.error.code === -32000 &&
          (msg.includes("does not exist") ||
            data.includes("does not exist") ||
            json.error.cause?.name === "UNKNOWN_ACCOUNT")
        ) {
          return { __unknown: true };
        }
        throw new Error(`RPC error: ${msg}`);
      }
      return json.result;
    } catch (e) {
      lastErr = e;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

export function createRpcClient(options: RpcOptions = {}): RpcClient {
  const url = options.url ?? process.env.NEAR_RPC_URL ?? DEFAULT_RPC_URL;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    // Account state is read at `optimistic` finality: a risk check should see a contract swap or a
    // freshly created account as soon as possible. `final` lags a few blocks, which would hide an
    // upgrade made seconds ago and report a brand-new account as non-existent.
    async viewAccount(id: string): Promise<AccountView | null> {
      const result = await rpcFetch(
        url,
        {
          jsonrpc: "2.0",
          id: "valet",
          method: "query",
          params: {
            request_type: "view_account",
            finality: "optimistic",
            account_id: id,
          },
        },
        timeoutMs,
        fetchImpl,
      );
      if (result && typeof result === "object" && "__unknown" in result) return null;
      return result as AccountView;
    },

    async viewAccessKeys(id: string): Promise<AccessKeyView[]> {
      const result = await rpcFetch(
        url,
        {
          jsonrpc: "2.0",
          id: "valet",
          method: "query",
          params: {
            request_type: "view_access_key_list",
            finality: "final",
            account_id: id,
          },
        },
        timeoutMs,
        fetchImpl,
      );
      return (result as { keys: AccessKeyView[] }).keys ?? [];
    },

    // Contract views (the guard's own lists/stats, registry reports) are advisory inputs: the guard
    // re-checks everything authoritatively when `pay` executes. So read the freshest state; waiting
    // for `final` would make an owner's allow/deny change invisible for a few blocks.
    async callView(contractId: string, method: string, args: unknown): Promise<unknown> {
      const result = await rpcFetch(
        url,
        {
          jsonrpc: "2.0",
          id: "valet",
          method: "query",
          params: {
            request_type: "call_function",
            finality: "optimistic",
            account_id: contractId,
            method_name: method,
            args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
          },
        },
        timeoutMs,
        fetchImpl,
      );
      const r = result as { result?: number[] };
      const bytes = Buffer.from(r.result ?? []);
      const text = bytes.toString("utf8");
      return JSON.parse(text) as unknown;
    },
  };
}

/**
 * The chain id the node serves ("mainnet", "testnet", "localnet", ...), or null when it will not
 * say. The command line uses it to pick the account-history API that matches the chain.
 */
export async function fetchChainId(options: RpcOptions = {}): Promise<string | null> {
  const url = options.url ?? process.env.NEAR_RPC_URL ?? DEFAULT_RPC_URL;
  try {
    const result = await rpcFetch(
      url,
      { jsonrpc: "2.0", id: "valet", method: "status", params: [] },
      options.timeoutMs ?? 15_000,
      options.fetchImpl ?? fetch,
    );
    const id = (result as { chain_id?: unknown } | null)?.chain_id;
    return typeof id === "string" ? id : null;
  } catch {
    return null;
  }
}
