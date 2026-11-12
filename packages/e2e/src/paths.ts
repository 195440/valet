import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(pkgRoot, "..", "..");

export const CACHE_DIR = join(pkgRoot, ".cache");

export const GUARD_WASM = join(repoRoot, "contracts", "guard", "res", "valet_guard.wasm");
export const REGISTRY_WASM = join(repoRoot, "contracts", "registry", "res", "valet_registry.wasm");

export const YOCTO = 10n ** 24n;
export const NEAR = (n: string | number) => BigInt(n) * YOCTO;
export const REPORT_DEPOSIT = 10n ** 22n;

export function defaultPolicy(overrides: Partial<{
  per_tx_cap: string;
  window_cap: string;
  window_hours: number;
  pending_ttl_ms: string;
}> = {}) {
  return {
    per_tx_cap: String(5n * YOCTO),
    window_cap: String(20n * YOCTO),
    window_hours: 24,
    pending_ttl_ms: "3600000",
    ...overrides,
  };
}
