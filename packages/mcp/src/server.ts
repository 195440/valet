/**
 * Valet MCP server (stdio). Gives an MCP client (Claude Code, Cursor, Codex, ...) three tools:
 * valet_pay, valet_check, valet_status. The agent behind the client holds only the vault's
 * function-call key; every payment goes through the oracle and the vault's on-chain limits.
 *
 *   VALET_CONFIG=.valet/agent.json npx tsx packages/mcp/src/server.ts
 *
 * stdout carries protocol messages only (see stdio.ts). Everything else goes to stderr.
 */
import { writeToClient } from "./stdout-guard.js"; // first: see the file
import { ValetAgent } from "@valet/client";
import { createRpcClient } from "@valet/oracle";
import { loadConfig } from "./config.js";
import { readLines } from "./lines.js";
import { McpServer } from "./protocol.js";
import { readVaultStatus } from "./status.js";
import { createTools, instructions } from "./tools.js";
import { describeWarn } from "./warn.js";

const VERSION = "0.1.0";
const log = (line: string): void => void process.stderr.write(`[valet-mcp] ${line}\n`);

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const askTimeoutMs = Number(process.env.VALET_ASK_TIMEOUT_MS) || undefined;

  let mcp: McpServer | undefined;
  const agent = new ValetAgent({
    guardId: config.guardId,
    agentKey: config.agentKey,
    rpcUrl: config.rpcUrl,
    networkId: config.networkId,
    oracleUrl: config.oracleUrl,
    auditFile: config.auditFile,
    // The question goes to the person at the client. A client that cannot ask has no human to answer.
    onWarn: async (ctx) => (mcp?.canAskHuman ? mcp.askHuman(describeWarn(ctx)) : "unavailable"),
  });

  // Fail closed: if this key could do more than call `pay` on the vault, do not start at all.
  await agent.assertSafeKey();
  const keyNote = "function-call key that can only call pay on the vault (checked at startup)";

  const rpc = createRpcClient({ url: config.rpcUrl });
  const tools = createTools({
    agent,
    status: () => readVaultStatus({ rpc, guardId: config.guardId, oracleUrl: config.oracleUrl, keyNote }),
  });

  mcp = new McpServer({
    name: "valet",
    title: "Valet",
    version: VERSION,
    instructions,
    tools: tools.definitions,
    callTool: tools.call,
    send: (message) => writeToClient(JSON.stringify(message)),
    log,
    askTimeoutMs,
  });
  const server = mcp;

  log(`ready: vault ${config.guardId}, agent key ${agent.agentPublicKey.slice(0, 20)}…`);
  readLines(process.stdin, (line) => server.receive(line), {
    onOverflow: () => log("dropped an oversized message"),
    onEnd: () => {
      void server.idle().then(() => process.exit(0));
    },
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => process.exit(0));
}

main().catch((e: unknown) => {
  log(`cannot start: ${(e as Error)?.message ?? String(e)}`);
  process.exit(1);
});
