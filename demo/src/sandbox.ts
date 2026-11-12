/**
 * A local NEAR chain with a Valet vault that stays up, so a real AI agent can try the guard by
 * hand through the MCP server (packages/mcp). The terminal that runs this is also the owner's
 * console: the owner's key never leaves this process, and never touches the disk.
 *
 *   npm run sandbox
 *
 * It writes the AGENT's settings to .valet/agent.json (or $VALET_SANDBOX_DIR/agent.json): the
 * vault, the function-call key and the oracle's URL. Nothing else.
 *
 * It also serves the Valet console, a web page on 127.0.0.1 where you play the AI agent, watch
 * what the guard does and act as the vault's owner. Open the link with the access token that
 * is printed below; the page can do nothing without it.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isIP } from "node:net";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { ValetAgent } from "@valet/client";
import { readVaultFacts, readVaultStatus } from "@valet/mcp";
import { createRpcClient, startServer } from "@valet/oracle";
import { REPORT_DEPOSIT, createAccount, deployGuardFixture, startSandbox, stopSandbox } from "@valet/e2e";
import { consoleFonts } from "./console/assets.js";
import { ConsoleCore, type AccountInfo } from "./console/core.js";
import { startConsoleServer, type ConsoleServer } from "./console/server.js";
import { stolenKeyAttempts, type ThiefResult } from "./console/thief.js";
import { Owner, argumentProblem, isOwnerAction } from "./owner.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dir = resolve(process.env.VALET_SANDBOX_DIR ?? join(repoRoot, ".valet"));
const agentConfigPath = join(dir, "agent.json");

const HELP = [
  "status           the vault's balance, limits and counters",
  "pending          payments waiting for your approval",
  "approve <id>     send a queued payment",
  "reject <id>      cancel a queued payment",
  "pause / unpause  the kill switch: while paused, nothing is paid",
  "allow <account>  put an account on the allow list (unallow takes it off)",
  "deny <account>   put an account on the deny list (undeny takes it off)",
  "console          print the link to the web console again",
  "help / quit",
];

async function main(): Promise<void> {
  let oracle: Awaited<ReturnType<typeof startServer>> | undefined;
  let webConsole: ConsoleServer | undefined;
  let core: ConsoleCore | undefined;
  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    console.log("\nStopping the sandbox…");
    const force = setTimeout(() => process.exit(1), 20_000);
    core?.closeAsks();
    await webConsole?.close().catch(() => undefined);
    await oracle?.close().catch(() => undefined);
    await stopSandbox().catch(() => undefined);
    clearTimeout(force);
    process.exit(0);
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => void stop());

  console.log("Starting a local NEAR chain (nearcore 2.14.0) and a Valet vault. This takes about 40 seconds.");
  await startSandbox();
  const fx = await deployGuardFixture({ withRegistry: true, fundNear: 50, lockDown: true });
  const guardId = fx.guard.accountId;

  const vendor = await createAccount("acme-vendor", 5, true);
  await fx.owner.call(fx.guard, "allow", { account_id: vendor.accountId });
  const lookalike = await createAccount("acme-vend0r", 0, true);
  const stranger = await createAccount("fresh-vendor", 0, true);
  const trap = await createAccount("quick-yield-vault", 0, true);
  const attacker = await createAccount("attacker", 0, true);
  for (let i = 1; i <= 3; i++) {
    const witness = await createAccount(`witness${i}`, 1);
    await witness.call(
      fx.registry!,
      "report",
      { account_id: trap.accountId, category: "drainer", evidence_url: `https://example.com/reports/${i}`, note: "" },
      { attachedDeposit: REPORT_DEPOSIT },
    );
  }

  oracle = await startServer({ engine: fx.engine, port: 0 });
  const oracleUrl = oracle.url;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const agentConfig = {
    networkId: "sandbox",
    rpcUrl: fx.rpc,
    oracleUrl,
    guardId,
    agentKey: fx.agentKeyPair.toString(),
    auditFile: join(dir, "audit.jsonl"),
  };
  writeFileSync(agentConfigPath, `${JSON.stringify(agentConfig, null, 2)}\n`, { mode: 0o600 });
  chmodSync(agentConfigPath, 0o600);

  // The web console plays the AI agent in this process (same function-call key, same oracle, same
  // ValetAgent wrapper the MCP server uses) and acts as the owner. It is one more way in, not a
  // different engine.
  const rpc = createRpcClient({ url: fx.rpc });
  const owner = new Owner({
    call: (method, args) => fx.owner.call(fx.guard, method, args),
    view: (method, args) => fx.guard.view(method, args),
  });
  const agent = new ValetAgent({
    guardId,
    agentKey: fx.agentKeyPair.toString(),
    rpcUrl: fx.rpc,
    networkId: "sandbox",
    oracleUrl,
    auditFile: join(dir, "audit.jsonl"),
    onWarn: (ctx) => core!.askHuman(ctx),
    onAudit: (entry) => core!.onAudit(entry),
  });
  await agent.assertSafeKey();
  const accounts: AccountInfo[] = [
    { id: vendor.accountId, role: "vendor", label: "allow-listed vendor" },
    { id: lookalike.accountId, role: "lookalike", label: "lookalike of the vendor" },
    { id: stranger.accountId, role: "stranger", label: "a stranger" },
    { id: trap.accountId, role: "scam", label: "reported 3 times" },
  ];
  const kit = { guardId, vendor: vendor.accountId, attacker: attacker.accountId, raw: fx.raw, engine: fx.engine };
  core = new ConsoleCore({
    network: "sandbox",
    guardId,
    oracleUrl,
    owner,
    agent,
    accounts,
    keyNote: "Checked on-chain when the sandbox started.",
    facts: () => readVaultFacts({ rpc, guardId, oracleUrl }),
    newStranger: async () => (await createAccount("stranger", 0)).accountId,
    thief: async () => {
      const results: ThiefResult[] = [];
      for (const attempt of stolenKeyAttempts(kit)) results.push(await attempt.run());
      return results;
    },
  });
  const requestedPort = Number(process.env.VALET_CONSOLE_PORT ?? 0);
  // Only a container needs this: Docker forwards the host's 127.0.0.1:<port> to the container's
  // 0.0.0.0:<port>, so the page is still reachable only from this machine.
  const requestedHost = process.env.VALET_CONSOLE_HOST;
  const host = requestedHost && isIP(requestedHost) !== 0 ? requestedHost : undefined;
  webConsole = await startConsoleServer(core, {
    html: () => readFileSync(join(dirname(fileURLToPath(import.meta.url)), "console", "index.html"), "utf8"),
    assets: consoleFonts(),
    port: Number.isInteger(requestedPort) && requestedPort > 0 && requestedPort < 65_536 ? requestedPort : 0,
    host,
  });
  if (host && host !== "127.0.0.1" && host !== "::1") {
    console.log(`The console listens on ${host} inside this machine. Publish its port on 127.0.0.1 only (docker run -p 127.0.0.1:${webConsole.port}:${webConsole.port}).`);
  }

  const tsx = join(repoRoot, "node_modules", ".bin", "tsx");
  const server = join(repoRoot, "packages", "mcp", "src", "server.ts");
  const clientJson = { mcpServers: { valet: { command: tsx, args: [server], env: { VALET_CONFIG: agentConfigPath } } } };
  console.log(`
Valet sandbox is up. Ctrl-C stops it and throws the chain away.

  vault      ${guardId}   50 NEAR, 5 NEAR per payment, 20 NEAR per 24 hours
  agent key  a function-call key: it can call \`pay\` on the vault and nothing else
  oracle     ${oracleUrl}
  console    ${webConsole.openUrl}
  accounts   ${vendor.accountId.padEnd(30)} allow-listed vendor
             ${lookalike.accountId.padEnd(30)} lookalike of the vendor: the scam
             ${stranger.accountId.padEnd(30)} a stranger: the oracle says warn, a human must say yes
             ${trap.accountId.padEnd(30)} reported 3 times in the shared registry: blocked

Open the console to play the AI agent and act as the owner: the link above has this run's
access token in it, and the page does nothing without it.

The agent's settings are in ${agentConfigPath}
Connect an MCP client to the Valet server, for example Claude Code:

  claude mcp add valet -e VALET_CONFIG=${agentConfigPath} -- ${tsx} ${server}

or put this in the client's MCP settings (Cursor, Claude Desktop, Codex):

${JSON.stringify(clientJson, null, 2)}

You are the vault's owner. Type a command in this terminal:
${HELP.map((line) => `  ${line}`).join("\n")}
`);

  const ownerCommand = async (line: string): Promise<string> => {
    const [command = "", arg = ""] = line.trim().split(/\s+/);
    switch (command) {
      case "status":
        return readVaultStatus({ rpc, guardId, oracleUrl, keyNote: "function-call key that can only call pay on the vault" });
      case "pending":
        return owner.describePending();
      case "approve":
      case "reject":
      case "pause":
      case "unpause":
      case "allow":
      case "unallow":
      case "deny":
      case "undeny": {
        if (!isOwnerAction(command)) return `unknown command "${command}". Type help.`;
        if (argumentProblem(command, arg)) {
          return /^(approve|reject)$/.test(command) ? `usage: ${command} <id>   (see \`pending\`)` : `usage: ${command} <account>`;
        }
        const result = await owner.run(command, arg);
        core?.record({ kind: "owner", action: command, arg: arg || undefined, ok: true, message: result.summary });
        return result.message;
      }
      case "console":
        return webConsole!.openUrl;
      case "help":
        return HELP.join("\n");
      case "quit":
      case "exit":
        process.kill(process.pid, "SIGINT");
        return "stopping";
      case "":
        return "";
      default:
        return `unknown command "${command}". Type help.`;
    }
  };

  console.log(`CONSOLE ${webConsole.openUrl}`);
  console.log(`READY ${agentConfigPath}`);
  // One command at a time: each is a transaction signed by the owner. When stdin closes (no
  // terminal), the sandbox simply keeps running until it is stopped.
  for await (const line of createInterface({ input: process.stdin })) {
    try {
      const answer = await ownerCommand(line);
      if (answer) console.log(answer.split("\n").map((l) => `  ${l}`).join("\n"));
    } catch (e) {
      console.log(`  failed: ${String((e as Error).message ?? e).split("\n")[0]}`);
    }
  }
  await new Promise<void>(() => undefined);
}

main().catch(async (e: unknown) => {
  console.error(e);
  await stopSandbox().catch(() => undefined);
  process.exit(1);
});
