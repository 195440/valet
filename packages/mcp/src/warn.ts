import type { WarnContext } from "@valet/client";

const MEMO_SHOWN = 120;

/**
 * Text the model wrote (the memo, the receiver) is flattened to one line: no line breaks, control
 * characters or direction switches, so it cannot pass for a line of the oracle's own.
 */
const oneLine = (text: string): string =>
  text
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * The question a human sees when the oracle says `warn`. The signal sentences come from our own
 * engine. The memo was written by the agent, so it is quoted and labelled as such.
 */
export function describeWarn(ctx: WarnContext): string {
  const signals = ctx.reasons
    .map((r) => `  - ${r.code} (${r.weight > 0 ? "+" : ""}${r.weight}): ${oneLine(r.message)}`)
    .join("\n");
  const lines = [
    `The AI agent wants to pay ${ctx.amountNear} NEAR to ${oneLine(ctx.receiver)}.`,
    `The Valet oracle says "${ctx.verdict}" (risk score ${ctx.score}):`,
    signals,
  ];
  const memo = ctx.memo ? oneLine(ctx.memo).slice(0, MEMO_SHOWN) : "";
  if (memo) lines.push(`Note written by the agent: ${JSON.stringify(memo)}`); // JSON quoting: a quote inside cannot end it
  lines.push("If you approve, the payment goes into the vault's approval queue. NEAR moves only after the vault's owner approves it there.");
  return lines.join("\n");
}
