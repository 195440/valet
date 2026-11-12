import type { AccessKeyView, RpcClient } from "./rpc.js";

export interface KeyHardeningResult {
  public_key: string;
  verdict: "PASS" | "FAIL";
  issues: string[];
}

export interface GuardHardeningReport {
  guard_id: string;
  keys: KeyHardeningResult[];
  pass: boolean;
}

function analyseKey(key: AccessKeyView, guardId: string): KeyHardeningResult {
  const issues: string[] = [];
  const perm = key.access_key.permission;
  if (perm === "FullAccess") {
    issues.push("full_access_key_present");
    return { public_key: key.public_key, verdict: "FAIL", issues };
  }
  const fc = perm.FunctionCall;
  if (!fc) {
    issues.push("unknown_permission");
    return { public_key: key.public_key, verdict: "FAIL", issues };
  }
  if (fc.receiver_id !== guardId) {
    issues.push(`wrong_receiver_id:${fc.receiver_id}`);
  }
  const methods = [...fc.method_names].sort().join(",");
  if (methods !== "pay") {
    issues.push(`wrong_methods:${methods || "(empty)"}`);
  }
  if (fc.method_names.length !== 1 || fc.method_names[0] !== "pay") {
    issues.push("method_names_must_be_exactly_pay");
  }
  return {
    public_key: key.public_key,
    verdict: issues.length === 0 ? "PASS" : "FAIL",
    issues,
  };
}

export async function checkGuardHardening(
  rpc: RpcClient,
  guardId: string,
): Promise<GuardHardeningReport> {
  const keys = await rpc.viewAccessKeys(guardId);
  const results = keys.map((k) => analyseKey(k, guardId));
  const noFull = !keys.some((k) => k.access_key.permission === "FullAccess");
  const allFcPass =
    keys.length > 0 &&
    keys.every((k) => {
      if (k.access_key.permission === "FullAccess") return false;
      return analyseKey(k, guardId).verdict === "PASS";
    });
  return {
    guard_id: guardId,
    keys: results,
    pass: noFull && allFcPass,
  };
}
