import { randomBytes } from "node:crypto";
import type { KeyObject } from "node:crypto";
import {
  hashReasons,
  signAttestation,
  type AttestationPayload,
  type Reason,
  type Verdict,
} from "./attestation.js";
import type { ActivityProvider } from "./activity.js";
import { isImplicitAccount, isNamedAccount } from "./account.js";
import { CodeHashCache, EMPTY_HASH, isContractCode } from "./codehash-cache.js";
import type { GuardReader } from "./guard-reader.js";
import { findLookalike } from "./lookalike.js";
import type { Registry } from "./registry.js";
import type { AccountView, RpcClient } from "./rpc.js";
import { loadThreatFeed } from "./threat-feed.js";
import type { OracleKeyMaterial } from "./keys.js";
import type { RegistryReport } from "./registry.js";

export interface Signal extends Reason {
  hard?: boolean;
  /**
   * Trust signals (old account, busy account, paid before) subtract from the score, but they must
   * not cancel evidence that the thing being trusted just changed. A receiver with a floor signal
   * is at least `warn`, whatever else the score says.
   */
  warnFloor?: boolean;
}

export interface RiskEngineConfig {
  allowBelow?: number;
  blockFrom?: number;
  ttlMs?: number;
  knownAccounts?: string[];
  knownContracts?: string[];
  threatFeedPath?: string;
}

export interface RiskEngineDeps {
  rpc: RpcClient;
  guard: GuardReader;
  activity: ActivityProvider;
  registry: Registry;
  clock?: () => number;
  key: OracleKeyMaterial;
  codeHashCache?: CodeHashCache;
}

export interface EvaluateInput {
  guard: string;
  receiver: string;
  amountYocto: string;
  agent?: string;
  context?: Record<string, unknown>;
}

export interface CheckResult {
  verdict: Verdict;
  score: number;
  reasons: Reason[];
  reasonsHash: string;
  attestation: AttestationPayload;
  evaluatedAtMs: number;
  oraclePublicKey: string;
}

const DEFAULT_KNOWN = [
  "wrap.near",
  "intents.near",
  "usdt.tether-token.near",
  "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  "aurora",
  "near",
  "app.nearcrowd.near",
  "v2.ref-finance.near",
  "token.sweat",
];

/** Weight of the signals that turn an allow-listed receiver into a "warn" (a human decides). */
const WARN_ON_ALLOWLIST = 40;

/** Fewer transactions than this on record is thin history; at least `ACTIVE_FROM` is a busy account. */
const LOW_ACTIVITY_BELOW = 5;
const ACTIVE_FROM = 1000;
const DAY_MS = 86_400_000;

function clampScore(n: number): number {
  return Math.max(0, Math.min(100, n));
}

/** The 0-100 score of a set of signals, lifted to the allow threshold when a floor signal fired. */
function scoreOf(signals: Signal[], allowBelow: number): number {
  const score = clampScore(signals.reduce((a, s) => a + s.weight, 0));
  return signals.some((s) => s.warnFloor) ? Math.max(score, allowBelow) : score;
}

function verdictFromSignals(
  signals: Signal[],
  allowBelow: number,
  blockFrom: number,
): Verdict {
  if (signals.some((s) => s.hard)) return "block";
  const score = scoreOf(signals, allowBelow);
  if (score < allowBelow) return "allow";
  if (score < blockFrom) return "warn";
  return "block";
}

export class RiskEngine {
  private allowBelow: number;
  private blockFrom: number;
  private ttlMs: number;
  private knownAccounts: Set<string>;
  private knownContracts: Set<string>;
  private threatFeed: Map<string, { note: string; source?: string }>;
  private cache: CodeHashCache;

  constructor(
    private deps: RiskEngineDeps,
    config: RiskEngineConfig = {},
  ) {
    this.allowBelow = config.allowBelow ?? Number(process.env.VALET_ALLOW_BELOW ?? 30);
    this.blockFrom = config.blockFrom ?? Number(process.env.VALET_BLOCK_FROM ?? 70);
    this.ttlMs = config.ttlMs ?? 120_000;
    this.knownAccounts = new Set(config.knownAccounts ?? DEFAULT_KNOWN);
    this.knownContracts = new Set(config.knownContracts ?? []);
    this.threatFeed = loadThreatFeed(config.threatFeedPath);
    this.cache = deps.codeHashCache ?? new CodeHashCache();
  }

  get oraclePublicKey(): string {
    return this.deps.key.nearPublicKey;
  }

  async evaluate(input: EvaluateInput): Promise<CheckResult> {
    const signals: Signal[] = [];
    // An empty guard id means "no vault": a counterparty check on the receiver alone (`lookup`).
    const hasGuard = input.guard !== "";
    const cfg = hasGuard ? await this.deps.guard.getConfig(input.guard) : null;
    const guardReadable = cfg !== null;

    if (hasGuard && !guardReadable) {
      signals.push({
        code: "GUARD_UNREADABLE",
        weight: 10,
        message: "Could not read guard contract state",
      });
    }

    let allowed = false;
    if (guardReadable) {
      allowed = await this.deps.guard.isAllowed(input.guard, input.receiver);
      if (allowed) {
        signals.push({
          code: "ALLOWLISTED",
          weight: 0,
          message: "Receiver is on the guard allow list",
        });
      } else {
        const denied = await this.deps.guard.isDenied(input.guard, input.receiver);
        if (denied) {
          signals.push({
            code: "DENYLISTED",
            weight: 100,
            hard: true,
            message: "Receiver is deny-listed on the guard",
          });
        }
      }
    }

    const threat = this.threatFeed.get(input.receiver);
    if (threat && !allowed) {
      signals.push({
        code: "DENYLISTED",
        weight: 100,
        hard: true,
        message: `Local threat feed: ${threat.note}`,
        evidence: { source: threat.source },
      });
    }

    const account = await this.deps.rpc.viewAccount(input.receiver);

    if (allowed) {
      // The owner's allow list outranks advisory signals (registry reports, lookalikes, history).
      // Two things still stop the payment for a human decision, because they contradict the
      // trust the owner gave: the oracle's own threat feed, and code that changed since the
      // oracle first saw the account (an upgrade after trust was earned).
      if (threat) {
        signals.push({
          code: "THREAT_FEED_ON_ALLOWLIST",
          weight: WARN_ON_ALLOWLIST,
          message: `Allow-listed receiver is in the oracle's threat feed: ${threat.note}`,
          evidence: { source: threat.source },
        });
      }
      const changed = this.codeChangeSignal(input.receiver, account);
      if (changed) signals.push(changed);
      return this.finalise(input, signals, signals.every((s) => s.weight === 0));
    }

    if (isNamedAccount(input.receiver) && account === null) {
      signals.push({
        code: "ACCOUNT_NOT_FOUND",
        weight: 100,
        hard: true,
        message: "Named receiver account does not exist on chain",
      });
    }
    if (isImplicitAccount(input.receiver) && account === null) {
      signals.push({
        code: "NEW_IMPLICIT_ACCOUNT",
        weight: 35,
        message: "Implicit account not yet funded on chain",
      });
    }

    // Registry
    const reports = await this.deps.registry.getReports(input.receiver);
    const reporters = new Set(reports.map((r) => r.reporter));
    if (reporters.size >= 3) {
      signals.push({
        code: "REGISTRY_REPORTS",
        weight: 100,
        hard: true,
        message: `${reporters.size} distinct reporters flagged this account`,
        evidence: registryEvidence(reports),
      });
    } else if (reporters.size >= 2) {
      signals.push({
        code: "REGISTRY_REPORTS",
        weight: 50,
        message: `${reporters.size} distinct reporters flagged this account`,
        evidence: registryEvidence(reports),
      });
    }

    // Lookalike
    const allowlist = guardReadable
      ? await this.deps.guard.getAllowlist(input.guard)
      : [];
    const trusted = [...this.knownAccounts, ...allowlist];
    const look = findLookalike(input.receiver, trusted);
    if (look) {
      signals.push({
        code: "LOOKALIKE_OF_KNOWN",
        weight: 60,
        message: `Receiver resembles trusted account ${look.target}`,
        evidence: { target: look.target, distance: look.distance },
      });
    }

    // Receiver stats
    if (guardReadable) {
      const stats = await this.deps.guard.getReceiverStats(input.guard, input.receiver);
      if (!stats || stats.paid_count === 0) {
        signals.push({
          code: "FIRST_TIME_RECEIVER",
          weight: 20,
          message: "No prior payments from this guard to this receiver",
        });
      } else if (stats.paid_count >= 3) {
        signals.push({
          code: "ESTABLISHED_COUNTERPARTY",
          weight: -20,
          message: `Guard paid this receiver ${stats.paid_count} times before`,
        });
        const avg =
          BigInt(stats.total_paid) / BigInt(stats.paid_count);
        if (BigInt(input.amountYocto) > avg * 5n) {
          signals.push({
            code: "AMOUNT_ANOMALY",
            weight: 15,
            message: "Amount exceeds 5× historical average to this receiver",
            evidence: { average_yocto: avg.toString() },
          });
        }
      }
    }

    if (account) {
      if (isContractCode(account.code_hash)) {
        const known =
          this.knownContracts.has(input.receiver) ||
          this.knownAccounts.has(input.receiver);
        if (!known) {
          signals.push({
            code: "CONTRACT_UNKNOWN",
            weight: 15,
            message: "Receiver is a contract not in the known set",
          });
        }
        let keys: Awaited<ReturnType<RpcClient["viewAccessKeys"]>> = [];
        try {
          keys = await this.deps.rpc.viewAccessKeys(input.receiver);
        } catch {
          /* e.g. TOO_MANY_ACCESS_KEYS on system accounts */
        }
        const full = keys.filter((k) => k.access_key.permission === "FullAccess");
        if (full.length >= 1) {
          signals.push({
            code: "CONTRACT_FULL_ACCESS_KEY",
            weight: 25,
            message: "Contract account still has full-access keys",
            evidence: { count: full.length },
          });
        }
      }

      const changed = this.codeChangeSignal(input.receiver, account);
      if (changed) signals.push(changed);
      // The baseline above only knows what this oracle has seen. The indexer knows when the code
      // was deployed, so a contract swapped last week is flagged on first sight too.
      if (!changed && isContractCode(account.code_hash)) {
        const recent = await this.recentDeploySignal(input.receiver);
        if (recent) signals.push(recent);
      }

      const firstSeen = await this.deps.activity.firstSeenMs(input.receiver);
      const now = (this.deps.clock ?? Date.now)();
      if (firstSeen === null) {
        signals.push({
          code: "ACCOUNT_AGE_UNKNOWN",
          weight: 10,
          message: "Could not determine account age",
        });
      } else {
        const ageDays = (now - firstSeen) / (86_400_000);
        if (ageDays < 7) {
          signals.push({
            code: "ACCOUNT_YOUNG",
            weight: 25,
            message: "Account first seen within the last 7 days",
          });
        } else if (ageDays > 180) {
          signals.push({
            code: "ACCOUNT_OLD",
            weight: -10,
            message: "Account older than 180 days",
          });
        }
      }

      // Activity history. An unknown count adds nothing: age already carries the "unknown" cost.
      const txCount = (await this.deps.activity.txCount?.(input.receiver)) ?? null;
      if (txCount !== null) {
        if (txCount < LOW_ACTIVITY_BELOW) {
          signals.push({
            code: "LOW_ACTIVITY",
            weight: 10,
            message: `Only ${txCount} transaction${txCount === 1 ? "" : "s"} on record`,
          });
        } else if (txCount >= ACTIVE_FROM) {
          signals.push({
            code: "ACTIVE_ACCOUNT",
            weight: -10,
            message: `Over ${ACTIVE_FROM} transactions on record`,
          });
        }
      }
    }

    if (guardReadable && cfg?.policy?.per_tx_cap) {
        const cap = BigInt(cfg.policy.per_tx_cap);
        const amt = BigInt(input.amountYocto);
        if (cap > 0n && amt * 100n >= cap * 80n) {
          signals.push({
            code: "AMOUNT_NEAR_CAP",
            weight: 10,
            message: "Amount is at least 80% of guard per-transaction cap",
          });
        }
    }

    return this.finalise(input, signals, allowed);
  }

  /**
   * Compare the receiver's current code with the baseline the oracle recorded when it first saw
   * the account. Covers upgrades, code deployed to a previously plain account, and removal.
   */
  private codeChangeSignal(receiver: string, account: AccountView | null): Signal | null {
    if (!account) return null;
    const baseline = this.cache.baseline(receiver);
    if (this.cache.check(receiver, account.code_hash) !== "changed" || baseline === undefined) {
      return null;
    }
    const was = baseline === EMPTY_HASH ? "no contract" : `code ${baseline.slice(0, 8)}…`;
    const now = account.code_hash === EMPTY_HASH ? "no contract" : `code ${account.code_hash.slice(0, 8)}…`;
    return {
      code: "CONTRACT_CODE_CHANGED",
      weight: 40,
      warnFloor: true,
      message:
        `Receiver's contract changed since the oracle first saw it (${was} → ${now}). ` +
        "Review the new code, then run `trust-code` to accept it.",
      evidence: { baseline, current: account.code_hash },
    };
  }

  /** Contract code deployed in the last 7 days weighs +30, in the last 30 days +10. */
  private async recentDeploySignal(receiver: string): Promise<Signal | null> {
    const deployedMs = (await this.deps.activity.lastDeployMs?.(receiver)) ?? null;
    if (deployedMs === null) return null;
    const ageMs = (this.deps.clock ?? Date.now)() - deployedMs;
    if (ageMs < 0) return null; // the indexer's clock is ahead of ours: no conclusion
    const evidence = { deployed_at: new Date(deployedMs).toISOString() };
    if (ageMs <= 7 * DAY_MS) {
      return {
        code: "CONTRACT_RECENTLY_DEPLOYED",
        weight: 30,
        warnFloor: true,
        message: "Contract code was deployed within the last 7 days",
        evidence,
      };
    }
    if (ageMs <= 30 * DAY_MS) {
      return {
        code: "CONTRACT_RECENTLY_DEPLOYED",
        weight: 10,
        message: "Contract code was deployed within the last 30 days",
        evidence,
      };
    }
    return null;
  }

  /**
   * A counterparty check on the receiver alone: no vault, so no vault-specific signals (allow
   * list, payment history, caps) and no attestation. This is what `valet-oracle lookup` prints.
   */
  async lookup(receiver: string, amountYocto = "0"): Promise<Omit<CheckResult, "attestation">> {
    const { attestation: _attestation, ...result } = await this.evaluate({
      guard: "",
      receiver,
      amountYocto,
    });
    return result;
  }

  /**
   * Accept the receiver's current code as the new baseline. Call this only after a human has
   * reviewed the new contract.
   */
  async trustCurrentCode(receiver: string): Promise<{ baseline: string | undefined; trusted: string }> {
    const account = await this.deps.rpc.viewAccount(receiver);
    if (!account) throw new Error(`account ${receiver} does not exist`);
    const baseline = this.cache.baseline(receiver);
    this.cache.trust(receiver, account.code_hash);
    return { baseline, trusted: account.code_hash };
  }

  private finalise(
    input: EvaluateInput,
    signals: Signal[],
    allowShortCircuit: boolean,
  ): CheckResult {
    const reasons: Reason[] = signals.map(({ hard: _h, warnFloor: _f, ...r }) => r);
    const reasonsHash = hashReasons(reasons);
    const evaluatedAtMs = (this.deps.clock ?? Date.now)();
    let verdict: Verdict;
    if (allowShortCircuit) {
      verdict = "allow";
    } else {
      verdict = verdictFromSignals(signals, this.allowBelow, this.blockFrom);
    }
    const score = allowShortCircuit ? 0 : scoreOf(signals, this.allowBelow);
    const nonceBuf = randomBytes(8);
    const nonce = BigInt(`0x${nonceBuf.toString("hex")}`).toString();
    const expires_ms = (evaluatedAtMs + this.ttlMs).toString();
    const attestation = signAttestation(
      this.deps.key.privateKey,
      input.guard,
      input.receiver,
      {
        max_amount: input.amountYocto,
        verdict,
        expires_ms,
        nonce,
        reasonsHash,
      },
    );
    return {
      verdict,
      score,
      reasons,
      reasonsHash,
      attestation,
      evaluatedAtMs,
      oraclePublicKey: this.deps.key.nearPublicKey,
    };
  }
}

/**
 * What a human needs to judge a registry flag: who reported, in which category, and where the
 * evidence lives. Free-text notes are left out on purpose: they are attacker-controlled.
 */
function registryEvidence(reports: RegistryReport[]) {
  return {
    reporters: [...new Set(reports.map((r) => r.reporter))],
    reports: reports.slice(0, 5).map((r) => ({
      reporter: r.reporter,
      category: r.category,
      evidence_url: r.evidence_url,
    })),
  };
}
