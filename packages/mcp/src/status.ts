import { formatNear } from "@valet/client";
import type { RpcClient } from "@valet/oracle";

type Reading<T> = { ok: true; value: T } | { ok: false };

async function read<T>(fn: () => Promise<T>): Promise<Reading<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch {
    return { ok: false };
  }
}

function near(yocto: unknown): string {
  try {
    return formatNear(BigInt(String(yocto)));
  } catch {
    return "unknown";
  }
}

export interface StatusOptions {
  rpc: RpcClient;
  guardId: string;
  oracleUrl: string;
  /** What was verified about the agent's key when the server started. */
  keyNote: string;
  fetchImpl?: typeof fetch;
}

interface GuardConfigView {
  paused: boolean;
  pending_count: number;
  policy: { per_tx_cap: string; window_cap: string; window_hours: number };
}

export interface VaultCounters {
  paid: number;
  queued: number;
  blocked: number;
  approved: number;
  rejected: number;
}

/**
 * What the chain and the oracle say about the vault right now. A reading that failed is `null`,
 * never a guess: callers show it as `unknown`.
 */
export interface VaultFacts {
  vault: string;
  balanceYocto: string | null;
  config: {
    paused: boolean;
    pendingCount: number;
    perTxCapYocto: string;
    windowCapYocto: string;
    windowHours: number;
  } | null;
  windowSpentYocto: string | null;
  stats: VaultCounters | null;
  oracleReachable: boolean;
}

export async function readVaultFacts(options: Omit<StatusOptions, "keyNote">): Promise<VaultFacts> {
  const { rpc, guardId } = options;
  const doFetch = options.fetchImpl ?? fetch;
  const [account, config, stats, windowSpent, oracle] = await Promise.all([
    read(() => rpc.viewAccount(guardId)),
    read(async () => (await rpc.callView(guardId, "get_config", {})) as GuardConfigView),
    read(async () => (await rpc.callView(guardId, "get_stats", {})) as VaultCounters),
    read(() => rpc.callView(guardId, "get_window_spent", {})),
    read(async () => {
      const res = await doFetch(`${options.oracleUrl.replace(/\/$/, "")}/v1/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      return res.ok;
    }),
  ]);
  return {
    vault: guardId,
    balanceYocto: account.ok && account.value ? String(account.value.amount) : null,
    config: config.ok
      ? {
          paused: config.value.paused,
          pendingCount: config.value.pending_count,
          perTxCapYocto: String(config.value.policy.per_tx_cap),
          windowCapYocto: String(config.value.policy.window_cap),
          windowHours: config.value.policy.window_hours,
        }
      : null,
    windowSpentYocto: windowSpent.ok ? String(windowSpent.value) : null,
    stats: stats.ok ? stats.value : null,
    oracleReachable: oracle.ok && oracle.value,
  };
}

/** The vault at a glance, as `key=value` lines. A reading that fails shows up as `unknown`. */
export async function readVaultStatus(options: StatusOptions): Promise<string> {
  const facts = await readVaultFacts(options);
  const lines = [`vault=${facts.vault}`];
  lines.push(`balance_near=${facts.balanceYocto !== null ? near(facts.balanceYocto) : "unknown"}`);
  if (facts.config) {
    const c = facts.config;
    lines.push(
      `paused=${c.paused}`,
      `per_payment_cap_near=${near(c.perTxCapYocto)}`,
      `window_cap_near=${near(c.windowCapYocto)} per ${c.windowHours} hours`,
      `spent_in_window_near=${facts.windowSpentYocto !== null ? near(facts.windowSpentYocto) : "unknown"}`,
      `pending_approvals=${c.pendingCount}`,
    );
  } else {
    lines.push("config=unreadable (is the vault deployed on this chain?)");
  }
  if (facts.stats) {
    const s = facts.stats;
    lines.push(`payments: paid=${s.paid} queued=${s.queued} blocked=${s.blocked} approved=${s.approved} rejected=${s.rejected}`);
  }
  lines.push(`agent_key=${options.keyNote}`);
  lines.push(`oracle=${facts.oracleReachable ? "reachable" : "unreachable"}`);
  return lines.join("\n");
}
