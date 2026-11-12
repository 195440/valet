import { createHash, createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { canonicalJson } from "./canonical.js";

export type Verdict = "allow" | "warn" | "block";

export interface Reason {
  code: string;
  weight: number;
  message: string;
  evidence?: Record<string, unknown>;
}

export interface AttestationPayload {
  max_amount: string;
  verdict: Verdict;
  expires_ms: string;
  nonce: string;
  reasons: string;
  signature: string;
}

export function hashReasons(reasons: Reason[]): string {
  if (reasons.length === 0) return "0";
  return createHash("sha256").update(canonicalJson(reasons), "utf8").digest("hex");
}

export function buildAttestationMessage(
  guard: string,
  receiver: string,
  params: {
    max_amount: string;
    verdict: Verdict;
    expires_ms: string;
    nonce: string;
    reasons: string;
  },
): string {
  return [
    "VALET/1",
    `guard=${guard}`,
    `receiver=${receiver}`,
    `max_amount=${params.max_amount}`,
    `verdict=${params.verdict}`,
    `expires_ms=${params.expires_ms}`,
    `nonce=${params.nonce}`,
    `reasons=${params.reasons}`,
  ].join("\n");
}

export function signAttestation(
  privateKey: KeyObject,
  guard: string,
  receiver: string,
  params: {
    max_amount: string;
    verdict: Verdict;
    expires_ms: string;
    nonce: string;
    reasonsHash: string;
  },
): AttestationPayload {
  const message = buildAttestationMessage(guard, receiver, {
    max_amount: params.max_amount,
    verdict: params.verdict,
    expires_ms: params.expires_ms,
    nonce: params.nonce,
    reasons: params.reasonsHash,
  });
  const sig = sign(null, Buffer.from(message, "utf8"), privateKey);
  return {
    max_amount: params.max_amount,
    verdict: params.verdict,
    expires_ms: params.expires_ms,
    nonce: params.nonce,
    reasons: params.reasonsHash,
    signature: sig.toString("base64"),
  };
}

export function verifyAttestationSignature(
  publicKeyRaw32: Uint8Array,
  guard: string,
  receiver: string,
  att: AttestationPayload,
): boolean {
  const message = buildAttestationMessage(guard, receiver, {
    max_amount: att.max_amount,
    verdict: att.verdict as Verdict,
    expires_ms: att.expires_ms,
    nonce: att.nonce,
    reasons: att.reasons,
  });
  const pub = createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      Buffer.from(publicKeyRaw32),
    ]),
    format: "der",
    type: "spki",
  });
  return verify(null, Buffer.from(message, "utf8"), pub, Buffer.from(att.signature, "base64"));
}
