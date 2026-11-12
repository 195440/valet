const YOCTO_PER_NEAR = 10n ** 24n;

/** Parse a decimal NEAR string to yoctoNEAR (no floats). */
export function parseNear(amount: string): bigint {
  const s = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) {
    throw new Error(`invalid NEAR amount: ${amount}`);
  }
  const [whole, frac = ""] = s.split(".");
  if (frac.length > 24) {
    throw new Error(`too many decimal places (max 24): ${amount}`);
  }
  const fracPadded = frac.padEnd(24, "0");
  const w = BigInt(whole || "0");
  const f = BigInt(fracPadded || "0");
  return w * YOCTO_PER_NEAR + f;
}

/** Format yoctoNEAR as a trimmed decimal NEAR string. */
export function formatNear(yocto: bigint): string {
  if (yocto < 0n) throw new Error("negative amount");
  const whole = yocto / YOCTO_PER_NEAR;
  const frac = yocto % YOCTO_PER_NEAR;
  if (frac === 0n) return whole.toString();
  let fracStr = frac.toString().padStart(24, "0").replace(/0+$/, "");
  return `${whole}.${fracStr}`;
}

export { YOCTO_PER_NEAR };
