const IMPLICIT_HEX = /^[0-9a-f]{64}$/;
const ETH_IMPLICIT = /^0x[0-9a-f]{40}$/i;
const NAMED =
  /^(([a-z0-9]+[-_])*[a-z0-9]+\.)*([a-z0-9]+[-_])*[a-z0-9]+$/;

export function isValidNearAccountId(id: string): boolean {
  if (id.length < 2 || id.length > 64) return false;
  if (IMPLICIT_HEX.test(id) || ETH_IMPLICIT.test(id)) return true;
  return NAMED.test(id);
}

export function isImplicitAccount(id: string): boolean {
  return IMPLICIT_HEX.test(id) || ETH_IMPLICIT.test(id);
}

export function isNamedAccount(id: string): boolean {
  return isValidNearAccountId(id) && !isImplicitAccount(id);
}

/** Positive decimal string (yoctoNEAR). */
export function isPositiveDecimal(s: string): boolean {
  if (!/^[0-9]+$/.test(s) || s === "0") return false;
  return true;
}

const NEAR_YOCTO = 1_000_000_000_000_000_000_000_000n;

export function nearToYocto(near: string): string {
  const parts = near.trim().split(".");
  if (parts.length > 2) throw new Error("invalid NEAR amount");
  const whole = BigInt(parts[0] || "0");
  let frac = parts[1] ?? "";
  if (frac.length > 24) throw new Error("too many decimal places");
  frac = frac.padEnd(24, "0");
  const yocto = whole * NEAR_YOCTO + BigInt(frac || "0");
  if (yocto <= 0n) throw new Error("amount must be positive");
  return yocto.toString();
}
