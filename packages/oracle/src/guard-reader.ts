import type { RpcClient } from "./rpc.js";

export interface GuardPolicy {
  per_tx_cap: string;
  window_cap: string;
  window_hours: number;
  pending_ttl_ms: string;
}

export interface GuardConfig {
  owner_id: string;
  oracle_public_key: string | null;
  policy: GuardPolicy;
  paused: boolean;
  pending_count: number;
  version: string;
}

export interface ReceiverStats {
  paid_count: number;
  total_paid: string;
  first_paid_ms: number;
  last_paid_ms: number;
}

export interface GuardReader {
  getConfig(guardId: string): Promise<GuardConfig | null>;
  getReceiverStats(guardId: string, accountId: string): Promise<ReceiverStats | null>;
  isAllowed(guardId: string, accountId: string): Promise<boolean>;
  isDenied(guardId: string, accountId: string): Promise<boolean>;
  getAllowlist(guardId: string, fromIndex?: number, limit?: number): Promise<string[]>;
}

export function createGuardReader(rpc: RpcClient): GuardReader {
  return {
    async getConfig(guardId: string): Promise<GuardConfig | null> {
      try {
        return (await rpc.callView(guardId, "get_config", {})) as GuardConfig;
      } catch {
        return null;
      }
    },
    async getReceiverStats(guardId: string, accountId: string): Promise<ReceiverStats | null> {
      try {
        const v = await rpc.callView(guardId, "get_receiver_stats", { account_id: accountId });
        if (v === null || v === undefined) return null;
        return v as ReceiverStats;
      } catch {
        return null;
      }
    },
    async isAllowed(guardId: string, accountId: string): Promise<boolean> {
      try {
        return (await rpc.callView(guardId, "is_allowed", { account_id: accountId })) as boolean;
      } catch {
        return false;
      }
    },
    async isDenied(guardId: string, accountId: string): Promise<boolean> {
      try {
        return (await rpc.callView(guardId, "is_denied", { account_id: accountId })) as boolean;
      } catch {
        return false;
      }
    },
    async getAllowlist(guardId: string, fromIndex = 0, limit = 100): Promise<string[]> {
      try {
        return (await rpc.callView(guardId, "get_allowlist", {
          from_index: fromIndex,
          limit,
        })) as string[];
      } catch {
        return [];
      }
    },
  };
}

/** Stub for smoke tests without a deployed guard. */
export function stubGuardReader(): GuardReader {
  return {
    async getConfig() {
      return null;
    },
    async getReceiverStats() {
      return null;
    },
    async isAllowed() {
      return false;
    },
    async isDenied() {
      return false;
    },
    async getAllowlist() {
      return [];
    },
  };
}
