import type { CheckResult, RiskEngine } from "@valet/oracle";
import type { AttestationPayload } from "@valet/oracle";

export type OracleCheckResult = CheckResult;

export async function checkViaHttp(
  oracleUrl: string,
  body: {
    guard: string;
    receiver: string;
    amount_yocto: string;
    agent?: string;
    context?: Record<string, unknown>;
  },
): Promise<OracleCheckResult> {
  const base = oracleUrl.replace(/\/$/, "");
  const res = await fetch(`${base}/v1/check`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`oracle HTTP ${res.status}: ${err}`);
  }
  const data = (await res.json()) as Record<string, unknown>;
  return {
    verdict: data.verdict as CheckResult["verdict"],
    score: Number(data.score),
    reasons: data.reasons as CheckResult["reasons"],
    reasonsHash: String(data.reasons_hash),
    attestation: data.attestation as AttestationPayload,
    evaluatedAtMs: Number(data.evaluated_at_ms),
    oraclePublicKey: String(data.oracle_public_key),
  };
}

export async function checkViaEngine(
  engine: RiskEngine,
  input: {
    guard: string;
    receiver: string;
    amountYocto: string;
    agent?: string;
    context?: Record<string, unknown>;
  },
): Promise<OracleCheckResult> {
  return engine.evaluate(input);
}
