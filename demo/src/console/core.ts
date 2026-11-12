/**
 * The console's brain: what happened (the feed), what the human is being asked, the stories the
 * page can play, and the vault's state as plain JSON. It knows nothing about HTTP and takes the
 * chain, the agent and the owner as dependencies, so it can be tested without a chain.
 */
import { formatNear, parseNear, type AuditEntry, type PayParams, type PayResponse, type WarnContext } from "@valet/client";
import type { VaultFacts } from "@valet/mcp";
import type { Reason } from "@valet/oracle";
import { OWNER_ACTIONS, argumentProblem, isAccountId, isOwnerAction, type Owner } from "../owner.js";
import { ApiError, type ConsoleApi } from "./server.js";
import { SCENARIOS, type AccountRole } from "./scenarios.js";
import type { ThiefResult } from "./thief.js";

export interface AccountInfo {
  id: string;
  role: AccountRole;
  label: string;
}

export interface ReasonView {
  code: string;
  weight: number;
  message: string;
  evidence?: unknown;
}

export type FeedEntry =
  | {
      kind: "payment";
      receiver: string;
      amountNear: string;
      memo?: string;
      status: string;
      stage: string;
      verdict?: string;
      score?: number;
      reasons: ReasonView[];
      reason?: string;
      pendingId?: string;
      txHash?: string;
    }
  | { kind: "owner"; action: string; arg?: string; ok: boolean; message: string }
  | { kind: "thief"; results: ThiefResult[]; stopped: number; accepted: number }
  | { kind: "note"; text: string };

export type FeedItem = FeedEntry & { seq: number; ts: string };

/** The part of `ValetAgent` the console uses. */
export interface PayingAgent {
  pay(params: PayParams): Promise<PayResponse>;
}

export interface CoreDeps {
  network: string;
  guardId: string;
  oracleUrl: string;
  owner: Owner;
  agent: PayingAgent;
  accounts: AccountInfo[];
  /** What was checked about the agent's key, in one line (shown next to the vault). */
  keyNote: string;
  facts: () => Promise<VaultFacts>;
  /** Run the stolen-key attempts on the chain. */
  thief: () => Promise<ThiefResult[]>;
  /**
   * An account nobody has paid before. The stranger story uses a new one every time, so it ends
   * the same way on every click: once a stranger has been paid, the oracle rightly stops asking.
   */
  newStranger?: () => Promise<string>;
  now?: () => number;
  /** How long a question to the human stays open. After that the answer is no. */
  askTimeoutMs?: number;
  maxFeed?: number;
}

interface Ask {
  id: string;
  receiver: string;
  amountNear: string;
  memo?: string;
  verdict: string;
  score: number;
  reasons: ReasonView[];
  askedAt: number;
  expiresAt: number;
}

/** One at a time per signer, so two quick clicks cannot sign with the same nonce. */
class Lane {
  private tail: Promise<unknown> = Promise.resolve();
  active = 0;
  run<T>(task: () => Promise<T>): Promise<T> {
    this.active++;
    const next = this.tail.then(task, task);
    this.tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next.finally(() => {
      this.active--;
    });
  }
}

const firstLine = (e: unknown): string => String((e as Error)?.message ?? e).split("\n")[0]!.slice(0, 300);

/** Text the agent wrote is capped and stripped of control characters before it is kept. */
const cleanMemo = (text: string): string =>
  text
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);

const reasonViews = (reasons: unknown): ReasonView[] =>
  ((reasons ?? []) as Reason[]).map((r) => ({ code: r.code, weight: r.weight, message: r.message, evidence: r.evidence }));

export class ConsoleCore implements ConsoleApi {
  private feed: FeedItem[] = [];
  private seq = 0;
  private asks = new Map<string, { ask: Ask; settle: (answer: boolean) => void }>();
  private askCount = 0;
  private readonly ownerLane = new Lane();
  private readonly agentLane = new Lane();
  private readonly now: () => number;

  constructor(private readonly deps: CoreDeps) {
    this.now = deps.now ?? Date.now;
  }

  // ------------------------------------------------------------------ feed

  record(entry: FeedEntry): FeedItem {
    const item = { ...entry, seq: ++this.seq, ts: new Date(this.now()).toISOString() } as FeedItem;
    this.feed.push(item);
    const max = this.deps.maxFeed ?? 300;
    if (this.feed.length > max) this.feed.splice(0, this.feed.length - max);
    return item;
  }

  /** Give this to `ValetAgent` as `onAudit`: every attempt the agent makes lands in the feed. */
  onAudit = (entry: AuditEntry): void => {
    let amountNear = entry.amount_yocto;
    try {
      amountNear = formatNear(BigInt(entry.amount_yocto));
    } catch {
      // keep the raw text
    }
    this.record({
      kind: "payment",
      receiver: entry.receiver,
      amountNear,
      memo: entry.memo ? cleanMemo(entry.memo) : undefined,
      status: entry.status,
      stage: entry.stage,
      verdict: entry.verdict,
      score: entry.score,
      reasons: reasonViews(entry.reasons),
      reason: entry.reason,
      pendingId: entry.pending_id !== undefined ? String(entry.pending_id) : undefined,
      txHash: entry.tx_hash,
    });
  };

  // ------------------------------------------------------------------ the question to the human

  /** Give this to `ValetAgent` as `onWarn`: the page shows the question and the human answers it. */
  askHuman = (ctx: WarnContext): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      const id = `q${++this.askCount}`;
      const ttl = this.deps.askTimeoutMs ?? 120_000;
      const ask: Ask = {
        id,
        receiver: ctx.receiver,
        amountNear: ctx.amountNear,
        memo: ctx.memo ? cleanMemo(ctx.memo) : undefined,
        verdict: ctx.verdict,
        score: ctx.score,
        reasons: reasonViews(ctx.reasons),
        askedAt: this.now(),
        expiresAt: this.now() + ttl,
      };
      const timer = setTimeout(() => settle(false), ttl);
      const settle = (answer: boolean): void => {
        clearTimeout(timer);
        this.asks.delete(id);
        resolve(answer);
      };
      this.asks.set(id, { ask, settle });
    });

  async answer(body: Record<string, unknown>): Promise<unknown> {
    const id = typeof body.id === "string" ? body.id : "";
    if (typeof body.approve !== "boolean") throw new ApiError(400, "approve must be true or false");
    const open = this.asks.get(id);
    if (!open) throw new ApiError(404, "that question is no longer open");
    open.settle(body.approve);
    return { ok: true };
  }

  /** Close every open question with "no" (the sandbox is stopping). */
  closeAsks(): void {
    for (const { settle } of [...this.asks.values()]) settle(false);
  }

  // ------------------------------------------------------------------ owner

  async owner(body: Record<string, unknown>): Promise<unknown> {
    const { action } = body;
    if (!isOwnerAction(action)) throw new ApiError(400, `action must be one of: ${OWNER_ACTIONS.join(", ")}`);
    const arg = body.arg === undefined ? "" : body.arg;
    if (typeof arg !== "string") throw new ApiError(400, "arg must be text");
    const problem = argumentProblem(action, arg);
    if (problem) throw new ApiError(400, problem);
    try {
      const result = await this.ownerLane.run(() => this.deps.owner.run(action, arg));
      this.record({ kind: "owner", action, arg: arg || undefined, ok: true, message: result.summary });
      return { ok: true, message: result.summary };
    } catch (e) {
      const message = firstLine(e);
      this.record({ kind: "owner", action, arg: arg || undefined, ok: false, message });
      throw new ApiError(409, message);
    }
  }

  // ------------------------------------------------------------------ the agent

  private async payAsAgent(receiver: string, amountNear: string, memo: string | undefined): Promise<PayResponse> {
    return this.agentLane.run(() => this.deps.agent.pay({ receiver, amountNear, memo }));
  }

  async pay(body: Record<string, unknown>): Promise<unknown> {
    const receiver = typeof body.receiver === "string" ? body.receiver.trim() : "";
    if (!isAccountId(receiver)) throw new ApiError(400, "receiver must be a NEAR account id");
    const amount = typeof body.amount_near === "string" ? body.amount_near.trim() : "";
    let yocto = 0n;
    try {
      yocto = parseNear(amount);
    } catch {
      throw new ApiError(400, "amount_near must be a number such as 0.5");
    }
    if (yocto <= 0n) throw new ApiError(400, "amount_near must be more than zero");
    const memo = typeof body.memo === "string" && body.memo.trim() ? cleanMemo(body.memo) : undefined;
    const response = await this.payAsAgent(receiver, amount, memo);
    return { ok: true, status: response.status, stage: response.stage };
  }

  async scenario(body: Record<string, unknown>): Promise<unknown> {
    const def = SCENARIOS.find((s) => s.id === body.id);
    if (!def) throw new ApiError(400, "unknown scenario");
    if (def.id === "thief") {
      const results = await this.agentLane.run(() => this.deps.thief());
      const accepted = results.filter((r) => r.outcome === "accepted").length;
      this.record({ kind: "thief", results, stopped: results.length - accepted, accepted });
      return { ok: true, attempts: results.length, accepted };
    }
    const account = this.deps.accounts.find((a) => a.role === def.role);
    const amountNear = def.amountNear;
    if (!account || !amountNear) throw new ApiError(400, "this scenario needs an account the sandbox did not create");
    const { newStranger } = this.deps;
    const response = await this.agentLane.run(async () => {
      const receiver = def.role === "stranger" && newStranger ? await newStranger() : account.id;
      return this.deps.agent.pay({ receiver, amountNear, memo: def.memo });
    });
    return { ok: true, status: response.status, stage: response.stage };
  }

  // ------------------------------------------------------------------ state

  async state(since: number): Promise<unknown> {
    const { deps } = this;
    const [facts, pending, lists] = await Promise.all([
      deps.facts(),
      deps.owner.pending().catch(() => null),
      deps.owner.lists().catch(() => null),
    ]);
    const near = (yocto: string | null): string | null => {
      if (yocto === null) return null;
      try {
        return formatNear(BigInt(yocto));
      } catch {
        return null;
      }
    };
    const now = this.now();
    return {
      network: deps.network,
      vault: {
        id: deps.guardId,
        balanceNear: near(facts.balanceYocto),
        paused: facts.config?.paused ?? null,
        perPaymentCapNear: near(facts.config?.perTxCapYocto ?? null),
        windowCapNear: near(facts.config?.windowCapYocto ?? null),
        windowHours: facts.config?.windowHours ?? null,
        spentInWindowNear: near(facts.windowSpentYocto),
        stats: facts.stats,
      },
      key: { note: deps.keyNote },
      oracle: { url: deps.oracleUrl, reachable: facts.oracleReachable },
      pending: pending?.map((p) => ({ id: p.id, receiver: p.receiver, amountNear: near(p.amountYocto), expiresInMin: Math.max(0, Math.round((p.expiresMs - now) / 60_000)) })) ?? null,
      lists,
      asks: [...this.asks.values()].map(({ ask }) => ({ ...ask, secondsLeft: Math.max(0, Math.round((ask.expiresAt - now) / 1000)) })),
      accounts: deps.accounts,
      scenarios: SCENARIOS.map(({ id, title, blurb, expect }) => ({ id, title, blurb, expect })),
      busy: this.agentLane.active > 0,
      seq: this.seq,
      events: this.feed.filter((item) => item.seq > since),
    };
  }
}
