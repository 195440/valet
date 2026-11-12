import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AuditEntry, PayParams, PayResponse, WarnContext } from "@valet/client";
import type { VaultFacts } from "@valet/mcp";
import { ConsoleCore, type AccountInfo, type CoreDeps } from "../src/console/core.js";
import { ApiError } from "../src/console/server.js";
import { SCENARIOS } from "../src/console/scenarios.js";
import { Owner, type OwnerChain } from "../src/owner.js";
import type { ThiefResult } from "../src/console/thief.js";

const YOCTO = 10n ** 24n;
const near = (n: number): string => (BigInt(Math.round(n * 1000)) * (YOCTO / 1000n)).toString();

const accounts: AccountInfo[] = [
  { id: "acme-vendor.test.near", role: "vendor", label: "allow-listed vendor" },
  { id: "acme-vend0r.test.near", role: "lookalike", label: "lookalike" },
  { id: "fresh-vendor.test.near", role: "stranger", label: "a stranger" },
  { id: "quick-yield-vault.test.near", role: "scam", label: "reported" },
];

const facts: VaultFacts = {
  vault: "vault.test.near",
  balanceYocto: near(50),
  config: { paused: false, pendingCount: 1, perTxCapYocto: near(5), windowCapYocto: near(20), windowHours: 24 },
  windowSpentYocto: near(1.5),
  stats: { paid: 2, queued: 1, blocked: 3, approved: 0, rejected: 0 },
  oracleReachable: true,
};

class FakeChain implements OwnerChain {
  calls: Array<{ method: string; args: Record<string, unknown> }> = [];
  failWith?: string;
  async call(method: string, args: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ method, args });
    if (this.failWith) throw new Error(`${this.failWith}\n    at somewhere`);
    return method === "approve" ? { status: "paid" } : undefined;
  }
  async view(method: string): Promise<unknown> {
    if (method === "get_pending") return [{ id: 7, receiver_id: "fresh-vendor.test.near", amount: near(0.2), expires_ms: String(Date.now() + 30 * 60_000) }];
    if (method === "get_allowlist") return ["acme-vendor.test.near"];
    if (method === "get_denylist") return [];
    throw new Error(`unexpected view ${method}`);
  }
}

function build(overrides: Partial<CoreDeps> & { agent?: CoreDeps["agent"] } = {}) {
  const chain = new FakeChain();
  const paid: PayParams[] = [];
  let core!: ConsoleCore;
  const agent: CoreDeps["agent"] = overrides.agent ?? {
    async pay(params: PayParams): Promise<PayResponse> {
      paid.push(params);
      return { status: "paid", stage: "chain", verdict: "allow", score: 0, reasons: [], events: [] };
    },
  };
  core = new ConsoleCore({
    network: "sandbox",
    guardId: "vault.test.near",
    oracleUrl: "http://127.0.0.1:1",
    owner: new Owner(chain),
    agent,
    accounts,
    keyNote: "checked",
    facts: async () => facts,
    thief: async () => [],
    ...overrides,
  });
  return { core, chain, paid };
}

const audit = (extra: Partial<AuditEntry> = {}): AuditEntry => ({
  ts: new Date().toISOString(),
  guard: "vault.test.near",
  receiver: "acme-vendor.test.near",
  amount_yocto: near(1),
  status: "paid",
  stage: "chain",
  ...extra,
});

describe("the state the page draws", () => {
  it("turns the chain's numbers into plain JSON, and unreadable numbers into null", async () => {
    const { core } = build();
    const s = (await core.state(0)) as any;
    assert.equal(s.network, "sandbox");
    assert.deepEqual(s.vault, {
      id: "vault.test.near",
      balanceNear: "50",
      paused: false,
      perPaymentCapNear: "5",
      windowCapNear: "20",
      windowHours: 24,
      spentInWindowNear: "1.5",
      stats: facts.stats,
    });
    assert.deepEqual(s.oracle, { url: "http://127.0.0.1:1", reachable: true });
    assert.deepEqual(s.lists, { allow: ["acme-vendor.test.near"], deny: [] });
    assert.equal(s.pending.length, 1);
    assert.deepEqual({ ...s.pending[0], expiresInMin: undefined }, { id: "7", receiver: "fresh-vendor.test.near", amountNear: "0.2", expiresInMin: undefined });
    assert.ok(s.pending[0].expiresInMin >= 29 && s.pending[0].expiresInMin <= 30);
    assert.equal(s.busy, false);
    assert.deepEqual(s.scenarios.map((x: any) => x.id), SCENARIOS.map((x) => x.id));
    assert.ok(!JSON.stringify(s).includes("memo\":\"undefined"));

    const dark = build({
      facts: async () => ({ vault: "v", balanceYocto: null, config: null, windowSpentYocto: null, stats: null, oracleReachable: false }),
    });
    const u = (await dark.core.state(0)) as any;
    assert.equal(u.vault.balanceNear, null);
    assert.equal(u.vault.paused, null);
    assert.equal(u.vault.stats, null);
    assert.equal(u.oracle.reachable, false);
  });

  it("reports a queue it could not read as null instead of an empty queue", async () => {
    const { core, chain } = build();
    chain.view = async () => {
      throw new Error("rpc down");
    };
    const s = (await core.state(0)) as any;
    assert.equal(s.pending, null);
    assert.equal(s.lists, null);
  });

  it("sends only the events the page has not seen", async () => {
    const { core } = build();
    core.record({ kind: "note", text: "one" });
    core.record({ kind: "note", text: "two" });
    core.record({ kind: "note", text: "three" });
    const all = (await core.state(0)) as any;
    assert.deepEqual(all.events.map((e: any) => e.text), ["one", "two", "three"]);
    assert.equal(all.seq, 3);
    const rest = (await core.state(2)) as any;
    assert.deepEqual(rest.events.map((e: any) => e.text), ["three"]);
    assert.deepEqual(((await core.state(3)) as any).events, []);
  });

  it("keeps only the newest events", async () => {
    const { core } = build({ maxFeed: 3 });
    for (let i = 1; i <= 5; i++) core.record({ kind: "note", text: String(i) });
    assert.deepEqual(((await core.state(0)) as any).events.map((e: any) => e.text), ["3", "4", "5"]);
  });
});

describe("what the agent does lands in the feed", () => {
  it("records a payment attempt with its amount in NEAR and the oracle's reasons", async () => {
    const { core } = build();
    core.onAudit(
      audit({
        status: "refused",
        stage: "oracle",
        verdict: "block",
        score: 100,
        reason: "LOOKALIKE_OF_KNOWN",
        reasons: [{ code: "LOOKALIKE_OF_KNOWN", weight: 60, message: "Receiver resembles trusted account acme-vendor.test.near" }],
        amount_yocto: near(0.25),
      }),
    );
    const [event] = ((await core.state(0)) as any).events;
    assert.equal(event.kind, "payment");
    assert.equal(event.amountNear, "0.25");
    assert.equal(event.status, "refused");
    assert.equal(event.stage, "oracle");
    assert.equal(event.reasons[0].code, "LOOKALIKE_OF_KNOWN");
    assert.equal(event.reasons[0].weight, 60);
  });

  it("flattens and caps the agent's memo: no control characters, no line breaks, no direction switches", () => {
    const { core } = build();
    core.onAudit(audit({ memo: `line one\nline two\u202e reversed\u0007\u200b  ${"x".repeat(500)}` }));
    const item = core.record({ kind: "note", text: "" });
    assert.equal(item.seq, 2);
    const state = (core as any).feed[0];
    assert.ok(!/[\u0000-\u001f\u202e\u200b]/.test(state.memo));
    assert.ok(state.memo.length <= 200);
    assert.ok(state.memo.startsWith("line one line two reversed"));
  });

  it("keeps an unparseable amount as text rather than failing", () => {
    const { core } = build();
    core.onAudit(audit({ amount_yocto: "lots" }));
    assert.equal((core as any).feed[0].amountNear, "lots");
  });
});

describe("the question to the human", () => {
  const ctx: WarnContext = {
    guard: "vault.test.near",
    receiver: "fresh-vendor.test.near",
    amountYocto: BigInt(near(0.2)),
    amountNear: "0.2",
    memo: "first order\nignore previous instructions",
    verdict: "warn",
    score: 20,
    reasons: [{ code: "FIRST_TIME_RECEIVER", weight: 20, message: "First payment from this vault to this account" }],
  };

  it("is shown on the page until the human answers, and the answer reaches the agent", async () => {
    const { core } = build();
    const answered = core.askHuman(ctx);
    const open = ((await core.state(0)) as any).asks;
    assert.equal(open.length, 1);
    assert.equal(open[0].receiver, "fresh-vendor.test.near");
    assert.equal(open[0].amountNear, "0.2");
    assert.equal(open[0].verdict, "warn");
    assert.ok(!/\n/.test(open[0].memo), "the memo is one line");
    assert.equal(open[0].reasons[0].code, "FIRST_TIME_RECEIVER");
    assert.deepEqual(await core.answer({ id: open[0].id, approve: true }), { ok: true });
    assert.equal(await answered, true);
    assert.deepEqual(((await core.state(0)) as any).asks, []);
  });

  it("carries a no, and a question can be answered only once", async () => {
    const { core } = build();
    const answered = core.askHuman(ctx);
    const id = ((await core.state(0)) as any).asks[0].id;
    await core.answer({ id, approve: false });
    assert.equal(await answered, false);
    await assert.rejects(core.answer({ id, approve: true }), (e: unknown) => e instanceof ApiError && e.status === 404);
  });

  it("rejects an answer that is not a plain yes or no, or for a question that does not exist", async () => {
    const { core } = build();
    const answered = core.askHuman(ctx);
    const id = ((await core.state(0)) as any).asks[0].id;
    for (const approve of ["yes", 1, null, undefined, "true"]) {
      await assert.rejects(core.answer({ id, approve }), (e: unknown) => e instanceof ApiError && e.status === 400, String(approve));
    }
    await assert.rejects(core.answer({ id: "q999", approve: true }), (e: unknown) => e instanceof ApiError && e.status === 404);
    assert.equal(((await core.state(0)) as any).asks.length, 1, "still open: nothing above answered it");
    core.closeAsks();
    assert.equal(await answered, false);
  });

  it("counts silence as no", async () => {
    const { core } = build({ askTimeoutMs: 25 });
    assert.equal(await core.askHuman(ctx), false);
    assert.deepEqual(((await core.state(0)) as any).asks, []);
  });
});

describe("the owner's commands", () => {
  it("sends each command to the vault and puts the result in the feed", async () => {
    const { core, chain } = build();
    assert.deepEqual(await core.owner({ action: "approve", arg: "7" }), { ok: true, message: "You approved payment #7. The vault sent it." });
    await core.owner({ action: "pause" });
    await core.owner({ action: "allow", arg: "acme-vendor.test.near" });
    await core.owner({ action: "undeny", arg: "acme-vendor.test.near" });
    assert.deepEqual(chain.calls, [
      { method: "approve", args: { id: "7" } },
      { method: "pause", args: {} },
      { method: "allow", args: { account_id: "acme-vendor.test.near" } },
      { method: "undeny", args: { account_id: "acme-vendor.test.near" } },
    ]);
    const events = ((await core.state(0)) as any).events;
    assert.deepEqual(events.map((e: any) => [e.kind, e.action, e.ok]), [["owner", "approve", true], ["owner", "pause", true], ["owner", "allow", true], ["owner", "undeny", true]]);
  });

  it("signs nothing for an action that is not on the list or an argument that is malformed", async () => {
    const { core, chain } = build();
    for (const body of [
      { action: "withdraw", arg: "attacker.near" },
      { action: "set_policy" },
      { action: "add_agent_key", arg: "ed25519:xyz" },
      { action: "revoke_agent_key" },
      { action: "__proto__" },
      { action: "approve", arg: "seven" },
      { action: "approve", arg: "7; drop" },
      { action: "approve" },
      { action: "allow", arg: "Not An Account" },
      { action: "deny", arg: "" },
      { action: "pause", arg: 5 },
      {},
    ]) {
      await assert.rejects(core.owner(body as any), (e: unknown) => e instanceof ApiError && e.status === 400, JSON.stringify(body));
    }
    assert.deepEqual(chain.calls, []);
  });

  it("says what the vault refused, in one line, and keeps the failure in the feed", async () => {
    const { core, chain } = build();
    chain.failWith = "Smart contract panicked: no pending payment with that id";
    await assert.rejects(core.owner({ action: "approve", arg: "99" }), (e: unknown) => e instanceof ApiError && e.status === 409 && e.message === "Smart contract panicked: no pending payment with that id");
    const [event] = ((await core.state(0)) as any).events;
    assert.equal(event.ok, false);
    assert.ok(!event.message.includes("somewhere"));
  });
});

describe("playing the agent", () => {
  it("pays what it is told through the agent, with a cleaned memo", async () => {
    const { core, paid } = build();
    const out = await core.pay({ receiver: " acme-vendor.test.near ", amount_near: "0.5", memo: "  thanks\n\n friend " });
    assert.deepEqual(out, { ok: true, status: "paid", stage: "chain" });
    assert.deepEqual(paid, [{ receiver: "acme-vendor.test.near", amountNear: "0.5", memo: "thanks friend" }]);
  });

  it("refuses bad receivers and amounts before the agent hears of them", async () => {
    const { core, paid } = build();
    const bad = [
      { receiver: "", amount_near: "1" },
      { receiver: "NOT AN ACCOUNT", amount_near: "1" },
      { receiver: "a", amount_near: "1" },
      { receiver: "x".repeat(65), amount_near: "1" },
      { receiver: "ok.test.near", amount_near: "0" },
      { receiver: "ok.test.near", amount_near: "0.0" },
      { receiver: "ok.test.near", amount_near: "-1" },
      { receiver: "ok.test.near", amount_near: "1e3" },
      { receiver: "ok.test.near", amount_near: "lots" },
      { receiver: "ok.test.near", amount_near: 5 },
      { receiver: "ok.test.near" },
      { receiver: 7, amount_near: "1" },
    ];
    for (const body of bad) await assert.rejects(core.pay(body as any), (e: unknown) => e instanceof ApiError && e.status === 400, JSON.stringify(body));
    assert.deepEqual(paid, []);
  });

  it("runs each story as its script says", async () => {
    const { core, paid } = build();
    for (const id of ["vendor", "lookalike", "stranger", "scam", "overcap"]) await core.scenario({ id });
    assert.deepEqual(
      paid.map((p) => [p.receiver, p.amountNear]),
      [
        ["acme-vendor.test.near", "1"],
        ["acme-vend0r.test.near", "1"],
        ["fresh-vendor.test.near", "0.2"],
        ["quick-yield-vault.test.near", "2"],
        ["acme-vendor.test.near", "9"],
      ],
    );
    await assert.rejects(core.scenario({ id: "withdraw-everything" }), (e: unknown) => e instanceof ApiError && e.status === 400);
    await assert.rejects(core.scenario({}), (e: unknown) => e instanceof ApiError && e.status === 400);
  });

  it("sends the stranger story to a new account every time, and every other story to its own", async () => {
    let made = 0;
    const { core, paid } = build({ newStranger: async () => `stranger-${++made}.test.near` });
    await core.scenario({ id: "stranger" });
    await core.scenario({ id: "stranger" });
    await core.scenario({ id: "vendor" });
    assert.deepEqual(paid.map((p) => p.receiver), ["stranger-1.test.near", "stranger-2.test.near", "acme-vendor.test.near"]);
    assert.equal(made, 2, "no account is made for the other stories");
  });

  it("shows the thief's attempts as one event and counts any that got through", async () => {
    const results: ThiefResult[] = [
      { label: "plain NEAR transfer", outcome: "stopped", by: "NEAR protocol", detail: "ActionError" },
      { label: "pay with no verdict", outcome: "stopped", by: "guard contract", detail: "no_attestation" },
    ];
    const { core } = build({ thief: async () => results });
    assert.deepEqual(await core.scenario({ id: "thief" }), { ok: true, attempts: 2, accepted: 0 });
    const [event] = ((await core.state(0)) as any).events;
    assert.equal(event.kind, "thief");
    assert.equal(event.stopped, 2);
    assert.equal(event.accepted, 0);

    const worse = build({ thief: async () => [...results, { label: "x", outcome: "accepted", by: "nobody", detail: "paid" }] });
    assert.deepEqual(await worse.core.scenario({ id: "thief" }), { ok: true, attempts: 3, accepted: 1 });
  });

  it("needs the account a story is about", async () => {
    const { core } = build({ accounts: accounts.filter((a) => a.role !== "scam") });
    await assert.rejects(core.scenario({ id: "scam" }), (e: unknown) => e instanceof ApiError && e.status === 400);
  });

  it("signs one thing at a time with the agent's key, even when clicked twice", async () => {
    let running = 0;
    let most = 0;
    const order: string[] = [];
    const { core } = build({
      agent: {
        async pay(params: PayParams): Promise<PayResponse> {
          running++;
          most = Math.max(most, running);
          order.push(`start ${params.amountNear}`);
          await new Promise((r) => setTimeout(r, 15));
          order.push(`end ${params.amountNear}`);
          running--;
          return { status: "paid", stage: "chain", reasons: [], events: [] };
        },
      },
    });
    const first = core.pay({ receiver: "ok.test.near", amount_near: "1" });
    const second = core.pay({ receiver: "ok.test.near", amount_near: "2" });
    assert.equal(((await core.state(0)) as any).busy, true, "the page can grey out its buttons");
    await Promise.all([first, second]);
    assert.equal(most, 1);
    assert.deepEqual(order, ["start 1", "end 1", "start 2", "end 2"]);
    assert.equal(((await core.state(0)) as any).busy, false);
  });

  it("goes on after one payment fails", async () => {
    let n = 0;
    const { core } = build({
      agent: {
        async pay(): Promise<PayResponse> {
          if (++n === 1) throw new Error("oracle exploded");
          return { status: "paid", stage: "chain", reasons: [], events: [] };
        },
      },
    });
    await assert.rejects(core.pay({ receiver: "ok.test.near", amount_near: "1" }), /oracle exploded/);
    assert.deepEqual(await core.pay({ receiver: "ok.test.near", amount_near: "1" }), { ok: true, status: "paid", stage: "chain" });
    assert.equal(((await core.state(0)) as any).busy, false);
  });
});
