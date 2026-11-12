import { connect, keyStores, utils } from "near-api-js";
import { functionCall } from "near-api-js/lib/transaction.js";
import type { RiskEngine } from "@valet/oracle";
import type { Reason, Verdict } from "@valet/oracle";
import { createRpcClient } from "@valet/oracle";
import { parseNear } from "./near-amount.js";
import { decodePayResult, parseEvents, type ParsedEvent } from "./events.js";
import { checkViaEngine, checkViaHttp } from "./oracle-client.js";
import { writeAudit, type AuditEntry } from "./audit.js";

/**
 * `pay` burns ~5 TGas. The node checks the key's allowance against the *prepaid* gas at a
 * pessimistic price (30 TGas ~ 0.031 NEAR), so attaching less keeps small allowances usable.
 */
const DEFAULT_GAS = 20_000_000_000_000n;

export interface WarnContext {
  guard: string;
  receiver: string;
  amountYocto: bigint;
  amountNear: string;
  memo?: string;
  verdict: Verdict;
  score: number;
  reasons: Reason[];
}

export interface PayParams {
  receiver: string;
  amountNear: string;
  memo?: string;
}

export interface PayResponse {
  status: "paid" | "queued" | "blocked" | "refused" | "error";
  stage: "oracle" | "user" | "chain";
  verdict?: Verdict;
  score?: number;
  reasons: Reason[];
  reason?: string;
  pendingId?: string;
  txHash?: string;
  events: ParsedEvent[];
}

/** What the oracle thinks of a payment. Nothing is signed or sent. */
export interface CheckSummary {
  verdict: Verdict;
  score: number;
  reasons: Reason[];
}

export interface ValetAgentOptions {
  guardId: string;
  agentKey: string;
  rpcUrl: string;
  networkId?: string;
  oracleUrl?: string;
  engine?: RiskEngine;
  /**
   * Asked when the oracle says `warn`. `true` goes on, `false` is a refusal by the human
   * (`user_denied`), and `"unavailable"` means there was nobody to ask (`no_human_handler`).
   * Leaving it out is the same as always answering `"unavailable"`.
   */
  onWarn?: (ctx: WarnContext) => Promise<boolean | "unavailable">;
  auditFile?: string;
  onAudit?: (entry: AuditEntry) => void;
  gas?: bigint;
}

export class ValetAgent {
  readonly guardId: string;
  private agentKey: string;
  private rpcUrl: string;
  private networkId: string;
  private oracleUrl?: string;
  private engine?: RiskEngine;
  private onWarn?: ValetAgentOptions["onWarn"];
  private auditFile?: string;
  private onAudit?: (entry: AuditEntry) => void;
  private gas: bigint;

  constructor(options: ValetAgentOptions) {
    this.guardId = options.guardId;
    this.agentKey = options.agentKey;
    this.rpcUrl = options.rpcUrl;
    this.networkId = options.networkId ?? "sandbox";
    this.oracleUrl = options.oracleUrl;
    this.engine = options.engine;
    this.onWarn = options.onWarn;
    this.auditFile = options.auditFile;
    this.onAudit = options.onAudit;
    this.gas = options.gas ?? DEFAULT_GAS;
    if (!this.oracleUrl && !this.engine) {
      throw new Error("ValetAgent requires oracleUrl or engine");
    }
  }

  get agentPublicKey(): string {
    return utils.KeyPair.fromString(this.agentKey).getPublicKey().toString();
  }

  async assertSafeKey(): Promise<void> {
    const rpc = createRpcClient({ url: this.rpcUrl });
    const keys = await rpc.viewAccessKeys(this.guardId);
    const pub = this.agentPublicKey;
    const match = keys.find((k) => k.public_key === pub);
    if (!match) {
      throw new Error(`agent key not found on guard ${this.guardId}`);
    }
    const perm = match.access_key.permission;
    if (perm === "FullAccess") {
      throw new Error("agent key must not be FullAccess");
    }
    const fc = (perm as { FunctionCall?: { receiver_id: string; method_names: string[] } })
      .FunctionCall;
    if (!fc) throw new Error("agent key must be FunctionCall");
    if (fc.receiver_id !== this.guardId) {
      throw new Error(`agent key receiver_id must be ${this.guardId}, got ${fc.receiver_id}`);
    }
    const methods = [...fc.method_names].sort().join(",");
    if (methods !== "pay") {
      throw new Error(`agent key method_names must be [pay], got ${fc.method_names.join(",")}`);
    }
  }

  /** Ask the oracle about a payment without signing or sending anything. */
  async check(params: PayParams): Promise<CheckSummary> {
    const { verdict, score, reasons } = await this.askOracle(params, parseNear(params.amountNear));
    return { verdict, score, reasons };
  }

  /**
   * Oracle first, chain second. `block` never reaches the network, `warn` needs a human answer
   * (no handler configured means no answer, so it is refused), `allow` is sent with its attestation.
   */
  async pay(params: PayParams): Promise<PayResponse> {
    const amountYocto = parseNear(params.amountNear);
    const check = await this.askOracle(params, amountYocto);
    const finish = (resp: PayResponse): PayResponse => {
      writeAudit(this.auditFile, this.onAudit, {
        ts: new Date().toISOString(),
        guard: this.guardId,
        receiver: params.receiver,
        amount_yocto: amountYocto.toString(),
        memo: params.memo,
        status: resp.status,
        stage: resp.stage,
        verdict: check.verdict,
        score: check.score,
        reasons: check.reasons,
        reason: resp.reason,
        pending_id: resp.pendingId,
        tx_hash: resp.txHash,
      });
      return resp;
    };
    const respond = (
      status: PayResponse["status"],
      stage: PayResponse["stage"],
      extra: Partial<PayResponse> = {},
    ): PayResponse =>
      finish({
        status,
        stage,
        verdict: check.verdict,
        score: check.score,
        reasons: check.reasons,
        events: [],
        ...extra,
      });

    if (check.verdict === "block") {
      return respond("refused", "oracle", {
        reason: check.reasons.map((r: Reason) => r.code).join(",") || "block",
      });
    }

    if (check.verdict === "warn") {
      if (!this.onWarn) return respond("refused", "user", { reason: "no_human_handler" });
      const answer = await this.onWarn({
        guard: this.guardId,
        receiver: params.receiver,
        amountYocto,
        amountNear: params.amountNear,
        memo: params.memo,
        verdict: check.verdict,
        score: check.score,
        reasons: check.reasons,
      });
      if (answer === "unavailable") return respond("refused", "user", { reason: "no_human_handler" });
      if (answer !== true) return respond("refused", "user", { reason: "user_denied" });
    }

    let outcome: Awaited<ReturnType<ValetAgent["submitPay"]>>;
    try {
      outcome = await this.submitPay(params.receiver, amountYocto, toContractAttestation(check.attestation));
    } catch (e) {
      const err = e as { type?: string; message?: string };
      return respond("error", "chain", { reason: err.type ?? String(err.message ?? e).slice(0, 200) });
    }
    const payResult = decodePayResult(extractReturnValue(outcome));
    return respond(mapChainStatus(payResult?.status), "chain", {
      reason: payResult?.reason ?? undefined,
      pendingId: payResult?.pending_id != null ? String(payResult.pending_id) : undefined,
      txHash: outcome.transaction.hash,
      events: parseEvents({ receipts_outcome: outcome.receipts_outcome }),
    });
  }

  private askOracle(params: PayParams, amountYocto: bigint) {
    const request = {
      guard: this.guardId,
      receiver: params.receiver,
      agent: this.agentPublicKey,
      context: params.memo ? { memo: params.memo } : undefined,
    };
    return this.engine
      ? checkViaEngine(this.engine, { ...request, amountYocto: amountYocto.toString() })
      : checkViaHttp(this.oracleUrl!, { ...request, amount_yocto: amountYocto.toString() });
  }

  private async submitPay(
    receiver: string,
    amountYocto: bigint,
    attestation: Record<string, unknown> | null,
  ) {
    const keyPair = utils.KeyPair.fromString(this.agentKey);
    const keyStore = new keyStores.InMemoryKeyStore();
    await keyStore.setKey(this.networkId, this.guardId, keyPair);
    const near = await connect({
      networkId: this.networkId,
      nodeUrl: this.rpcUrl,
      keyStore,
    } as import("near-api-js/lib/connect.js").ConnectConfig);
    const account = await near.account(this.guardId);
    return account.signAndSendTransaction({
      receiverId: this.guardId,
      actions: [
        functionCall(
          "pay",
          {
            receiver_id: receiver,
            amount: amountYocto.toString(),
            attestation,
          },
          this.gas,
          0n,
        ),
      ],
    });
  }
}

function toContractAttestation(att: {
  max_amount: string;
  verdict: string;
  expires_ms: string;
  nonce: string;
  reasons: string;
  signature: string;
}): Record<string, unknown> {
  return {
    max_amount: att.max_amount,
    verdict: att.verdict,
    expires_ms: att.expires_ms,
    nonce: att.nonce,
    reasons: att.reasons,
    signature: att.signature,
  };
}

function extractReturnValue(outcome: {
  status: unknown;
  receipts_outcome: Array<{ outcome: { status: unknown } }>;
}): string | null {
  const top = outcome.status as { SuccessValue?: string };
  if (top?.SuccessValue) return top.SuccessValue;
  for (let i = outcome.receipts_outcome.length - 1; i >= 0; i--) {
    const st = outcome.receipts_outcome[i]!.outcome.status as { SuccessValue?: string };
    if (st?.SuccessValue) return st.SuccessValue;
  }
  return null;
}

function mapChainStatus(status: string | undefined): PayResponse["status"] {
  if (status === "paid") return "paid";
  if (status === "queued") return "queued";
  if (status === "blocked") return "blocked";
  return "blocked";
}
