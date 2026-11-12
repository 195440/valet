import type { RpcClient } from "./rpc.js";

export interface RegistryReport {
  reporter: string;
  category: string;
  evidence_url?: string;
  note?: string;
  ts_ms: number;
}

export interface Registry {
  getReports(accountId: string): Promise<RegistryReport[]>;
}

export function createRpcRegistry(rpc: RpcClient, registryId: string): Registry {
  return {
    async getReports(accountId: string): Promise<RegistryReport[]> {
      try {
        const v = await rpc.callView(registryId, "get_reports", { account_id: accountId });
        return (v ?? []) as RegistryReport[];
      } catch {
        return [];
      }
    },
  };
}

export class NoopRegistry implements Registry {
  async getReports(): Promise<RegistryReport[]> {
    return [];
  }
}
