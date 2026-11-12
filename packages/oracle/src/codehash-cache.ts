import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** What the `code_hash` field of an account without a contract looks like. */
export const EMPTY_HASH = "11111111111111111111111111111111";

export function isContractCode(codeHash: string): boolean {
  return codeHash !== EMPTY_HASH;
}

export type CodeCheck = "first" | "same" | "changed";

/**
 * Remembers, per account, the code hash the oracle saw first. That hash is the baseline: it is
 * only replaced by an explicit {@link trust} call, never by a later observation. So an upgraded
 * contract keeps being reported as changed until a human has reviewed it, instead of only on the
 * first payment after the swap.
 *
 * Accounts without a contract are recorded too, so "plain account that deployed code later" is
 * also caught.
 */
export class CodeHashCache {
  private path: string | null;
  private data: Record<string, string>;

  /**
   * @param path file to persist the baselines in; defaults to `$VALET_CODEHASH_CACHE` or
   *   `.valet/codehash-cache.json`. Pass `null` to keep them in memory only (tests, demos).
   */
  constructor(path?: string | null) {
    this.path =
      path === undefined
        ? (process.env.VALET_CODEHASH_CACHE ?? resolve(process.cwd(), ".valet/codehash-cache.json"))
        : path;
    this.data = {};
    if (this.path !== null && existsSync(this.path)) {
      try {
        this.data = JSON.parse(readFileSync(this.path, "utf8")) as Record<string, string>;
      } catch {
        this.data = {};
      }
    }
  }

  /** Compare `codeHash` with the baseline, recording it as the baseline on first sight. */
  check(accountId: string, codeHash: string): CodeCheck {
    const baseline = this.data[accountId];
    if (baseline === undefined) {
      this.data[accountId] = codeHash;
      this.persist();
      return "first";
    }
    return baseline === codeHash ? "same" : "changed";
  }

  /** The recorded baseline, if any. */
  baseline(accountId: string): string | undefined {
    return this.data[accountId];
  }

  /** Accept `codeHash` as the new baseline (a human reviewed the new code). */
  trust(accountId: string, codeHash: string): void {
    this.data[accountId] = codeHash;
    this.persist();
  }

  private persist(): void {
    if (this.path === null) return;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    writeFileSync(this.path, JSON.stringify(this.data, null, 2) + "\n", { mode: 0o600 });
  }
}
