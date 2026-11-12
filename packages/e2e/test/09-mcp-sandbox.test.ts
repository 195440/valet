/**
 * The path a real agent takes: `npm run sandbox` in one terminal, the MCP server in the AI client.
 * Both run here as child processes, exactly as the README starts them, and talk over stdio.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyPair } from "near-workspaces";
import { createRpcClient } from "@valet/oracle";
import { Child, McpClient, mcpServerScript, ownerCommand, sandboxScript } from "./mcp-process.js";

const YOCTO = 10n ** 24n;
const VENDOR = "acme-vendor.test.near";
const LOOKALIKE = "acme-vend0r.test.near";
const STRANGER = "fresh-vendor.test.near";
const TRAP = "quick-yield-vault.test.near";
const ATTACKER = "attacker.test.near"; // made by the sandbox for the console's stolen-key story

let dir: string;
let sandbox: Child;
let settings: { networkId: string; rpcUrl: string; oracleUrl: string; guardId: string; agentKey: string; auditFile: string };
let rpc: ReturnType<typeof createRpcClient>;
const spawned: Child[] = [];

const amountOf = async (id: string): Promise<bigint> => BigInt((await rpc.viewAccount(id))!.amount);

async function waitForAmount(id: string, expected: bigint, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = 0n;
  while (Date.now() < deadline) {
    last = await amountOf(id);
    if (last === expected) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  assert.equal(last, expected, `${id} balance`);
}

function startMcp(extraEnv: Record<string, string | undefined> = { VALET_CONFIG: join(dir, "agent.json") }): McpClient {
  const proc = new Child(mcpServerScript, { VALET_CONFIG: undefined, VALET_RPC_URL: undefined, VALET_GUARD_ID: undefined, VALET_AGENT_KEY: undefined, VALET_ORACLE_URL: undefined, ...extraEnv });
  spawned.push(proc);
  return new McpClient(proc);
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "valet-sandbox-"));
  sandbox = new Child(sandboxScript, { VALET_SANDBOX_DIR: dir });
  spawned.push(sandbox);
  await sandbox.waitForLine(/^READY /, 280_000);
  settings = JSON.parse(readFileSync(join(dir, "agent.json"), "utf8"));
  rpc = createRpcClient({ url: settings.rpcUrl });
}, { timeout: 300_000 });

after(async () => {
  for (const proc of spawned.slice().reverse()) await proc.stop("SIGINT", 60_000).catch(() => proc.child.kill("SIGKILL"));
  rmSync(dir, { recursive: true, force: true });
}, { timeout: 180_000 });

describe("npm run sandbox", () => {
  it("writes the agent's settings and nothing of the owner's, and the vault is locked down", { timeout: 60_000 }, async () => {
    assert.deepEqual(Object.keys(settings).sort(), ["agentKey", "auditFile", "guardId", "networkId", "oracleUrl", "rpcUrl"]);
    assert.equal(statSync(join(dir, "agent.json")).mode & 0o777, 0o600, "the file holds a key, so only the user may read it");
    const secretKey = /ed25519:[1-9A-HJ-NP-Za-km-z]{80,}/; // a public key has 44 characters after the prefix
    assert.doesNotMatch(sandbox.stdout.join("\n"), secretKey, "the console never prints a secret key");

    const keys = await rpc.viewAccessKeys(settings.guardId);
    assert.equal(keys.length, 1, "only the agent's key is left on the vault");
    const permission = keys[0]!.access_key.permission as { FunctionCall: { receiver_id: string; method_names: string[] } };
    assert.equal(permission.FunctionCall.receiver_id, settings.guardId);
    assert.deepEqual(permission.FunctionCall.method_names, ["pay"]);
  });
});

describe("an AI client that cannot ask its human", () => {
  it("never gets a warn through: the answer is no_human_handler and nothing is queued", { timeout: 120_000 }, async () => {
    const client = startMcp();
    await client.initialize({});
    const before = (await client.tool("valet_status")).text;
    const reply = await client.tool("valet_pay", { receiver: "fresh-vendor.test.near", amount_near: "0.1" });
    assert.match(reply.text, /^status=refused$/m);
    assert.match(reply.text, /^reason=no_human_handler$/m);
    assert.match(reply.text, /cannot ask one/);
    assert.deepEqual(client.asked, []);
    const pending = /^pending_approvals=(\d+)$/m;
    assert.equal(pending.exec((await client.tool("valet_status")).text)![1], pending.exec(before)![1]);
    assert.deepEqual(client.garbage, []);
    assert.equal(await client.close(), 0);
  });
});

describe("an AI client that can ask its human (MCP elicitation)", () => {
  let client: McpClient;

  before(async () => {
    client = startMcp();
    const init = await client.initialize({ elicitation: {} });
    assert.equal(init.protocolVersion, "2025-06-18");
    assert.equal(init.serverInfo.name, "valet");
    assert.match(init.instructions, /Never retry it, split it/);
  }, { timeout: 60_000 });

  it("lists exactly three tools", { timeout: 60_000 }, async () => {
    const list = await client.request("tools/list");
    assert.deepEqual(list.result.tools.map((t: { name: string }) => t.name), ["valet_pay", "valet_check", "valet_status"]);
  });

  it("shows the vault's state", { timeout: 60_000 }, async () => {
    const status = await client.tool("valet_status");
    assert.equal(status.isError, false);
    assert.match(status.text, new RegExp(`^vault=${settings.guardId.replace(/\./g, "\\.")}$`, "m"));
    assert.match(status.text, /^paused=false$/m);
    assert.match(status.text, /^per_payment_cap_near=5$/m);
    assert.match(status.text, /^window_cap_near=20 per 24 hours$/m);
    assert.match(status.text, /^agent_key=function-call key that can only call pay/m);
    assert.match(status.text, /^oracle=reachable$/m);
  });

  it("checks receivers without paying anybody", { timeout: 120_000 }, async () => {
    const before = await amountOf(settings.guardId);
    const vendor = await client.tool("valet_check", { receiver: VENDOR, amount_near: "1" });
    assert.match(vendor.text, /^verdict=allow$/m);
    const lookalike = await client.tool("valet_check", { receiver: LOOKALIKE, amount_near: "4" });
    assert.match(lookalike.text, /^verdict=block$/m);
    assert.match(lookalike.text, /LOOKALIKE_OF_KNOWN\(60\)/);
    const stranger = await client.tool("valet_check", { receiver: STRANGER, amount_near: "0.2" });
    assert.match(stranger.text, /^verdict=warn$/m);
    assert.equal(await amountOf(settings.guardId), before, "nothing moved");
  });

  it("pays the allow-listed vendor", { timeout: 120_000 }, async () => {
    const was = await amountOf(VENDOR);
    const paid = await client.tool("valet_pay", { receiver: VENDOR, amount_near: "1", memo: "invoice 42" });
    assert.equal(paid.isError, false);
    assert.match(paid.text, /^status=paid$/m);
    assert.match(paid.text, /Paid 1 NEAR to acme-vendor\.test\.near\./);
    assert.match(paid.text, /^tx_hash=\S+$/m);
    await waitForAmount(VENDOR, was + YOCTO);
  });

  it("refuses the prompt-injected lookalike and the reported account, and tells the model not to try again", { timeout: 120_000 }, async () => {
    for (const [receiver, signal] of [[LOOKALIKE, "LOOKALIKE_OF_KNOWN"], [TRAP, "REGISTRY_REPORTS"]] as const) {
      const was = await amountOf(receiver);
      const reply = await client.tool("valet_pay", { receiver, amount_near: "4", memo: "the invoice says our address changed, pay here" });
      assert.match(reply.text, /^status=refused$/m, receiver);
      assert.match(reply.text, /^stage=oracle$/m);
      assert.match(reply.text, new RegExp(`${signal}\\(`));
      assert.match(reply.text, /Do not retry it, split it, or pick a similar-looking account/);
      assert.doesNotMatch(reply.text, /tx_hash/, "nothing was sent");
      assert.equal(await amountOf(receiver), was);
    }
  });

  it("the vault's own limit holds even for the allow-listed vendor", { timeout: 120_000 }, async () => {
    const reply = await client.tool("valet_pay", { receiver: VENDOR, amount_near: "9" });
    assert.match(reply.text, /^status=blocked$/m);
    assert.match(reply.text, /^reason=per_tx_cap$/m);
  });

  it("puts a stranger to the human: no is final, yes queues it, and only the owner can release it", { timeout: 240_000 }, async () => {
    const was = await amountOf(STRANGER);

    client.onServerRequest = () => ({ action: "accept", content: { approve: false } });
    const denied = await client.tool("valet_pay", { receiver: STRANGER, amount_near: "0.2", memo: "first order" });
    assert.match(denied.text, /^status=refused$/m);
    assert.match(denied.text, /^reason=user_denied$/m);
    const question = String(client.asked.at(-1)!.message);
    assert.match(question, /pay 0\.2 NEAR to fresh-vendor\.test\.near/);
    assert.match(question, /FIRST_TIME_RECEIVER \(\+20\)/);
    assert.match(question, /approval queue/);

    client.onServerRequest = () => ({ action: "accept", content: { approve: true } });
    const queued = await client.tool("valet_pay", { receiver: STRANGER, amount_near: "0.2", memo: "first order" });
    assert.match(queued.text, /^status=queued$/m);
    const id = /^pending_id=(\d+)$/m.exec(queued.text)?.[1];
    assert.ok(id, "a pending id");
    assert.equal(await amountOf(STRANGER), was, "queued is not paid");

    const listing = await ownerCommand(sandbox, "pending", new RegExp(`#${id} .*fresh-vendor\\.test\\.near`));
    assert.match(listing, /0\.2 NEAR/);
    await ownerCommand(sandbox, `approve ${id}`, /"status":"paid"/);
    await waitForAmount(STRANGER, was + YOCTO / 5n);
  });

  it("the owner's kill switch stops everything, the allow-listed vendor included", { timeout: 240_000 }, async () => {
    await ownerCommand(sandbox, "pause", /paused: the vault pays nobody/);
    const status = await client.tool("valet_status");
    assert.match(status.text, /^paused=true$/m);
    const was = await amountOf(VENDOR);
    const blocked = await client.tool("valet_pay", { receiver: VENDOR, amount_near: "1" });
    assert.match(blocked.text, /^status=blocked$/m);
    assert.match(blocked.text, /^reason=paused$/m);
    assert.equal(await amountOf(VENDOR), was);

    await ownerCommand(sandbox, "unpause", /^\s*unpaused$/);
    const again = await client.tool("valet_pay", { receiver: VENDOR, amount_near: "1" });
    assert.match(again.text, /^status=paid$/m);
  });

  it("rejects bad input as a tool error and unknown tools as a protocol error", { timeout: 60_000 }, async () => {
    const bad = await client.tool("valet_pay", { receiver: VENDOR, amount_near: "lots" });
    assert.equal(bad.isError, true);
    const unknown = await client.request("tools/call", { name: "withdraw", arguments: {} });
    assert.equal(unknown.error.code, -32602);
  });

  it("keeps stdout for the protocol, and exits when the client goes away", { timeout: 60_000 }, async () => {
    assert.deepEqual(client.garbage, [], "no stray output on the protocol channel");
    assert.match(client.proc.stderr, /^\[valet-mcp\] ready: vault /m);
    assert.equal(await client.close(), 0);
  });
});

describe("the MCP server fails closed", () => {
  it("does not start without settings, and says which ones", { timeout: 60_000 }, async () => {
    const proc = new Child(mcpServerScript, { VALET_CONFIG: undefined, VALET_RPC_URL: undefined, VALET_GUARD_ID: undefined, VALET_AGENT_KEY: undefined, VALET_ORACLE_URL: undefined });
    assert.equal(await proc.exited, 1);
    assert.match(proc.stderr, /cannot start: missing settings: VALET_RPC_URL, VALET_GUARD_ID, VALET_AGENT_KEY, VALET_ORACLE_URL/);
    assert.equal(proc.stdout.length, 0);
  });

  it("does not start with a key the vault does not know", { timeout: 60_000 }, async () => {
    const other = join(dir, "other-agent.json");
    writeFileSync(other, JSON.stringify({ ...settings, agentKey: KeyPair.fromRandom("ed25519").toString() }), { mode: 0o600 });
    const proc = new Child(mcpServerScript, { VALET_CONFIG: other });
    spawned.push(proc);
    assert.equal(await proc.exited, 1);
    assert.match(proc.stderr, /cannot start: agent key not found on guard/);
    assert.doesNotMatch(proc.stderr, new RegExp(settings.agentKey.slice(8, 30)), "the key does not leak into the log");
  });
});

describe("the audit log", () => {
  it("has one line per attempt, in order, with the reason", { timeout: 60_000 }, () => {
    const entries = readFileSync(settings.auditFile, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { receiver: string; status: string; stage: string; reason?: string });
    const summary = entries.map((e) => `${e.receiver.split(".")[0]} ${e.status}/${e.stage}${e.reason ? ` ${e.reason.split(",")[0]}` : ""}`);
    assert.deepEqual(summary, [
      "fresh-vendor refused/user no_human_handler",
      "acme-vendor paid/chain allowlist",
      "acme-vend0r refused/oracle LOOKALIKE_OF_KNOWN",
      "quick-yield-vault refused/oracle REGISTRY_REPORTS",
      "acme-vendor blocked/chain per_tx_cap",
      "fresh-vendor refused/user user_denied",
      "fresh-vendor queued/chain oracle_warn",
      "acme-vendor blocked/chain paused",
      "acme-vendor paid/chain allowlist",
    ]);
  });
});

describe("the web console", () => {
  // It runs after the audit-log test on purpose: the console's agent writes to the same audit file.
  let base: string;
  let token: string;

  const api = async (path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> => {
    const res = await fetch(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "x-valet-token": token, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const state = async (): Promise<any> => (await api("/api/state")).json;
  const lastPayment = async (): Promise<any> => (await state()).events.filter((e: any) => e.kind === "payment").at(-1);

  before(() => {
    const line = sandbox.stdout.find((l) => l.startsWith("CONSOLE "));
    assert.ok(line, "the sandbox prints the console's link");
    const url = new URL(line.slice("CONSOLE ".length));
    assert.equal(url.hostname, "127.0.0.1");
    token = new URLSearchParams(url.hash.slice(1)).get("token") ?? "";
    assert.match(token, /^[0-9a-f]{48}$/);
    base = `${url.protocol}//${url.host}`;
  });

  it("shows the real vault, and refuses anyone without the token", { timeout: 60_000 }, async () => {
    const s = await state();
    assert.equal(s.vault.id, settings.guardId);
    assert.equal(s.vault.paused, false);
    assert.equal(s.vault.perPaymentCapNear, "5");
    assert.equal(s.vault.windowCapNear, "20");
    assert.equal(s.oracle.reachable, true);
    assert.deepEqual(s.lists.allow, [VENDOR]);
    assert.equal(s.scenarios.length, 6);
    assert.ok(!JSON.stringify(s).includes(settings.agentKey), "no key material in the page's data");
    assert.equal((await fetch(`${base}/api/state`)).status, 401);
    assert.equal((await fetch(`${base}/api/state`, { headers: { "x-valet-token": "0".repeat(48) } })).status, 401);
    const page = await fetch(base);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<title>Valet console<\/title>/);
  });

  it("plays the poisoned invoice through the real agent: refused by the oracle, nothing signed", { timeout: 120_000 }, async () => {
    const before = await amountOf(LOOKALIKE);
    const out = await api("/api/scenario", { id: "lookalike" });
    assert.deepEqual(out.json, { ok: true, status: "refused", stage: "oracle" });
    assert.equal(await amountOf(LOOKALIKE), before);
    const event = await lastPayment();
    assert.equal(event.receiver, LOOKALIKE);
    assert.equal(event.verdict, "block");
    assert.ok(event.reasons.some((r: any) => r.code === "LOOKALIKE_OF_KNOWN"));
  });

  it("asks the human about a stranger in the page: no is final, yes queues it, the owner's click pays it", { timeout: 240_000 }, async () => {
    // A no.
    const denied = api("/api/scenario", { id: "stranger" });
    let asks: any[] = [];
    for (let i = 0; i < 100 && asks.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 200));
      asks = (await state()).asks;
    }
    assert.equal(asks.length, 1, "the page is asked");
    assert.equal(asks[0].verdict, "warn");
    assert.equal(asks[0].amountNear, "0.2");
    assert.equal((await state()).busy, true, "the page greys out the buttons while the agent waits");
    assert.deepEqual((await api("/api/answer", { id: asks[0].id, approve: false })).json, { ok: true });
    assert.deepEqual((await denied).json, { ok: true, status: "refused", stage: "user" });
    assert.equal((await lastPayment()).reason, "user_denied");
    assert.deepEqual((await state()).pending, [], "a no queues nothing");

    // A yes: a new stranger each time, so the oracle asks again.
    const queued = api("/api/scenario", { id: "stranger" });
    asks = [];
    for (let i = 0; i < 100 && asks.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 200));
      asks = (await state()).asks;
    }
    assert.equal(asks.length, 1);
    assert.notEqual(asks[0].receiver, STRANGER, "not the stranger from before");
    const stranger = asks[0].receiver as string;
    await api("/api/answer", { id: asks[0].id, approve: true });
    assert.deepEqual((await queued).json, { ok: true, status: "queued", stage: "chain" });
    const was = await amountOf(stranger);
    const pending = (await state()).pending as any[];
    assert.equal(pending.length, 1);
    assert.equal(pending[0].receiver, stranger);
    assert.equal(await amountOf(stranger), was, "queued is not paid");

    const approved = await api("/api/owner", { action: "approve", arg: pending[0].id });
    assert.equal(approved.status, 200);
    assert.match(approved.json.message, /You approved payment #\d+\. The vault sent it\./);
    await waitForAmount(stranger, was + YOCTO / 5n);
    assert.deepEqual((await state()).pending, []);
  });

  it("lets the owner act only within the short list, and checks every argument", { timeout: 120_000 }, async () => {
    const vaultBefore = await amountOf(settings.guardId);
    for (const body of [{ action: "withdraw", arg: "attacker.test.near" }, { action: "add_agent_key", arg: "x" }, { action: "approve", arg: "1; DROP" }, { action: "allow", arg: "NOT AN ACCOUNT" }]) {
      assert.equal((await api("/api/owner", body)).status, 400, JSON.stringify(body));
    }
    assert.equal((await api("/api/owner", { action: "approve", arg: "99999" })).status, 409, "the vault's refusal comes back as a conflict");
    assert.equal((await api("/api/owner", { action: "pause" }, { origin: "http://evil.example" })).status, 403, "another site's page cannot press the owner's buttons");
    assert.equal((await state()).vault.paused, false);
    assert.ok(vaultBefore - (await amountOf(settings.guardId)) < YOCTO / 100n, "the vault lost nothing but gas");
  });

  it("the kill switch in the page stops the vendor too, and unpausing restores it", { timeout: 120_000 }, async () => {
    await api("/api/owner", { action: "pause" });
    assert.equal((await state()).vault.paused, true);
    const blocked = await api("/api/scenario", { id: "vendor" });
    assert.deepEqual(blocked.json, { ok: true, status: "blocked", stage: "chain" });
    assert.equal((await lastPayment()).reason, "paused");
    await api("/api/owner", { action: "unpause" });
    assert.equal((await state()).vault.paused, false);
    assert.equal((await api("/api/scenario", { id: "vendor" })).json.status, "paid");
  });

  it("runs the stolen-key story on the chain: every attempt is refused and the attacker gets nothing", { timeout: 180_000 }, async () => {
    const before = await amountOf(ATTACKER);
    const out = await api("/api/scenario", { id: "thief" });
    assert.deepEqual(out.json, { ok: true, attempts: 7, accepted: 0 });
    const event = (await state()).events.filter((e: any) => e.kind === "thief").at(-1);
    assert.equal(event.stopped, 7);
    assert.deepEqual(
      event.results.map((r: any) => r.detail),
      ["attestation_required", "bad_signature", "bad_signature", "per_tx_cap", "RequiresFullAccess", "MethodNameMismatch", "RequiresFullAccess"],
    );
    assert.equal(await amountOf(ATTACKER), before);
  });

  it("keeps an agent's note as text: no markup travels through the API as anything but a string", { timeout: 120_000 }, async () => {
    const note = `<img src=x onerror="alert(1)">\n\u202eevil`;
    await api("/api/pay", { receiver: VENDOR, amount_near: "0.1", memo: note });
    const event = await lastPayment();
    assert.equal(typeof event.memo, "string");
    assert.ok(!/[\n\u202e]/.test(event.memo));
    const audit = readFileSync(settings.auditFile, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { memo?: string });
    assert.ok(audit.every((e) => e.memo === undefined || !/[\n\u202e]/.test(e.memo)), "the audit log is clean too");
  });
});
