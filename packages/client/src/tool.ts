import type { ValetAgent, PayResponse } from "./agent.js";
import { parseNear, formatNear } from "./near-amount.js";

export function toolDefinition() {
  return {
    type: "function" as const,
    function: {
      name: "valet_pay",
      description:
        "Pay NEAR from the Valet guard vault to a receiver, subject to on-chain policy and oracle risk checks.",
      parameters: {
        type: "object",
        properties: {
          receiver: {
            type: "string",
            description: "NEAR account ID of the payment recipient",
          },
          amount_near: {
            type: "string",
            description: "Amount in NEAR as a decimal string (e.g. \"1.5\")",
          },
          memo: {
            type: "string",
            description: "Optional human-readable note for audit logs",
          },
        },
        required: ["receiver", "amount_near"],
        additionalProperties: false,
      },
    },
  };
}

export async function handleToolCall(
  agent: Pick<ValetAgent, "pay">,
  args: { receiver?: string; amount_near?: string; memo?: string },
): Promise<string> {
  const receiver = args.receiver?.trim();
  const amountNear = args.amount_near?.trim();
  if (!receiver || !amountNear) {
    return "Error: receiver and amount_near are required.";
  }
  try {
    parseNear(amountNear);
  } catch {
    return `Error: invalid amount_near "${amountNear}". Use a decimal NEAR string.`;
  }
  const r = await agent.pay({ receiver, amountNear, memo: args.memo });
  return formatPayResult(r, receiver, amountNear);
}

/**
 * What the model gets to read after a payment attempt: status, stage, reason code and signal codes
 * with their weights. The oracle's sentences and the registry's evidence are left out on purpose:
 * text written by a third party has no business in the model's context.
 */
export function formatPayResult(r: PayResponse, receiver: string, amountNear: string): string {
  const lines = [
    `status=${r.status}`,
    `stage=${r.stage}`,
    `receiver=${receiver}`,
    `amount_near=${amountNear}`,
  ];
  if (r.verdict) lines.push(`verdict=${r.verdict}`);
  if (r.score != null) lines.push(`score=${r.score}`);
  if (r.reason) lines.push(`reason=${r.reason}`);
  if (r.pendingId) lines.push(`pending_id=${r.pendingId}`);
  if (r.txHash) lines.push(`tx_hash=${r.txHash}`);
  if (r.reasons.length) {
    lines.push(
      `signals=${r.reasons.map((x) => `${x.code}(${x.weight})`).join("; ")}`,
    );
  }
  if (r.status === "paid") {
    lines.push(`Paid ${amountNear} NEAR to ${receiver}.`);
  }
  return lines.join("\n");
}

export { formatNear };
