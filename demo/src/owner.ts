/**
 * What the vault's owner can do from the sandbox: the terminal and the web console both call
 * these, so they cannot drift apart. Every state-changing command is one transaction signed with
 * the owner's key, which never leaves the sandbox process.
 */
import { formatNear } from "@valet/client";

export const OWNER_ACTIONS = ["approve", "reject", "pause", "unpause", "allow", "unallow", "deny", "undeny"] as const;
export type OwnerAction = (typeof OWNER_ACTIONS)[number];

export function isOwnerAction(value: unknown): value is OwnerAction {
  return typeof value === "string" && (OWNER_ACTIONS as readonly string[]).includes(value);
}

/** The vault, as the owner's account sees it: a signed call and a free read. */
export interface OwnerChain {
  call(method: string, args: Record<string, unknown>): Promise<unknown>;
  view(method: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface PendingPayment {
  id: string;
  receiver: string;
  amountYocto: string;
  expiresMs: number;
}

/** A NEAR account id: 2 to 64 characters, lowercase parts joined by dots (or 64 hex digits). */
export function isAccountId(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 2 || value.length > 64) return false;
  if (/^[0-9a-f]{64}$/.test(value)) return true;
  return /^[a-z0-9]+([_-][a-z0-9]+)*(\.[a-z0-9]+([_-][a-z0-9]+)*)*$/.test(value);
}

/** Check the argument of a command before anything is signed. Returns the problem, or null. */
export function argumentProblem(action: OwnerAction, arg: unknown): string | null {
  switch (action) {
    case "approve":
    case "reject":
      return typeof arg === "string" && /^\d{1,18}$/.test(arg) ? null : `${action} needs the number of a pending payment`;
    case "allow":
    case "unallow":
    case "deny":
    case "undeny":
      return isAccountId(arg) ? null : `${action} needs a NEAR account id`;
    case "pause":
    case "unpause":
      return null;
  }
}

export interface OwnerResult {
  /** One line for the terminal. */
  message: string;
  /** One line for the web page: what happened, without the contract's JSON. */
  summary: string;
  /** What the contract returned, if anything. */
  result?: unknown;
}

export class Owner {
  constructor(private readonly chain: OwnerChain) {}

  async pending(): Promise<PendingPayment[]> {
    const rows = (await this.chain.view("get_pending", {})) as Array<{
      id: string | number;
      receiver_id: string;
      amount: string;
      expires_ms: string | number;
    }>;
    return rows.map((p) => ({ id: String(p.id), receiver: p.receiver_id, amountYocto: String(p.amount), expiresMs: Number(p.expires_ms) }));
  }

  async lists(): Promise<{ allow: string[]; deny: string[] }> {
    const [allow, deny] = (await Promise.all([this.chain.view("get_allowlist", {}), this.chain.view("get_denylist", {})])) as [string[], string[]];
    return { allow, deny };
  }

  /** Describe the queue for the terminal. */
  async describePending(now = Date.now()): Promise<string> {
    const queue = await this.pending();
    if (queue.length === 0) return "nothing is waiting for approval";
    return queue
      .map((p) => `#${p.id}  ${formatNear(BigInt(p.amountYocto))} NEAR to ${p.receiver}  (expires in about ${Math.max(0, Math.round((p.expiresMs - now) / 60_000))} min)`)
      .join("\n");
  }

  /** Run one state-changing command. Throws if the argument is wrong or the chain says no. */
  async run(action: OwnerAction, arg = ""): Promise<OwnerResult> {
    const problem = argumentProblem(action, arg);
    if (problem) throw new Error(problem);
    switch (action) {
      case "approve":
      case "reject": {
        const result = await this.chain.call(action, { id: arg });
        const message = `${action} #${arg}: ${JSON.stringify(result ?? "done")}`;
        if (action === "reject") return { message, summary: `You rejected payment #${arg}. Nothing was sent.`, result };
        const outcome = (result ?? {}) as { status?: string; reason?: string };
        const summary =
          outcome.status === "paid"
            ? `You approved payment #${arg}. The vault sent it.`
            : `You approved payment #${arg}, but the vault stopped it: ${outcome.reason ?? outcome.status ?? "unknown reason"}.`;
        return { message, summary, result };
      }
      case "pause":
      case "unpause": {
        await this.chain.call(action, {});
        return action === "pause"
          ? { message: "paused: the vault pays nobody until you unpause", summary: "You paused the vault. It pays nobody until you unpause it." }
          : { message: "unpaused", summary: "You unpaused the vault." };
      }
      case "allow":
      case "deny": {
        await this.chain.call(action, { account_id: arg });
        const list = action === "allow" ? "allow" : "deny";
        return { message: `${arg} is on the ${list} list`, summary: `You put ${arg} on the ${list} list.` };
      }
      case "unallow":
      case "undeny": {
        await this.chain.call(action, { account_id: arg });
        const list = action === "unallow" ? "allow" : "deny";
        return { message: `${arg} is off the ${list} list`, summary: `You took ${arg} off the ${list} list.` };
      }
    }
  }
}
