#!/usr/bin/env node
import { loadOracleKey, ephemeralOracleKey } from "./keys.js";
import { createRpcClient, fetchChainId } from "./rpc.js";
import { createGuardReader } from "./guard-reader.js";
import { NoopActivityProvider, nearblocksUrlForChain } from "./activity.js";
import { NoopRegistry } from "./registry.js";
import { RiskEngine } from "./engine.js";
import { nearToYocto } from "./account.js";
import { startServer } from "./server.js";
import { checkGuardHardening } from "./hardening.js";
import { createRpcRegistry } from "./registry.js";
import { NearblocksProvider } from "./activity.js";
import { CodeHashCache, EMPTY_HASH } from "./codehash-cache.js";

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "--help" || cmd === "-h") {
    printHelp();
    process.exit(0);
  }

  if (cmd === "pubkey") {
    const key = loadOracleKey();
    console.log(key.nearPublicKey);
    return;
  }

  if (cmd === "serve") {
    const port = parseInt(flag(rest, "--port") ?? "8787", 10);
    const rpcUrl = flag(rest, "--rpc");
    const key = loadOracleKey();
    const rpc = createRpcClient(rpcUrl ? { url: rpcUrl } : {});
    const engine = await buildEngine(rpc, key, { rpcUrl });
    const handle = await startServer({ port, engine });
    console.log(`Oracle listening on ${handle.url}`);
    return;
  }

  if (cmd === "check") {
    const guard = flag(rest, "--guard");
    const receiver = flag(rest, "--receiver");
    const amount = flag(rest, "--amount");
    const jsonOut = rest.includes("--json");
    const rpcUrl = flag(rest, "--rpc");
    if (!guard || !receiver || !amount) {
      console.error("Usage: check --guard <id> --receiver <id> --amount <NEAR>");
      process.exit(1);
    }
    const key = loadOracleKey();
    const rpc = createRpcClient(rpcUrl ? { url: rpcUrl } : {});
    const engine = await buildEngine(rpc, key, { patient: true, rpcUrl });
    const result = await engine.evaluate({
      guard,
      receiver,
      amountYocto: nearToYocto(amount),
    });
    if (jsonOut) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    printCheckTable(result);
    return;
  }

  if (cmd === "lookup") {
    // A counterparty check on one account, no vault needed: read-only against a public RPC.
    const receiver = rest.find((a, i) => !a.startsWith("--") && rest[i - 1] !== "--rpc" && rest[i - 1] !== "--amount");
    const amount = flag(rest, "--amount") ?? "1"; // only shapes the (unused) attestation: no vault, no caps
    const jsonOut = rest.includes("--json");
    const rpcUrl = flag(rest, "--rpc");
    if (!receiver) {
      console.error("Usage: lookup <account> [--amount <NEAR>] [--rpc url] [--json]");
      process.exit(1);
    }
    const key = ephemeralOracleKey(); // signs nothing, so nothing is written to disk
    const rpc = createRpcClient(rpcUrl ? { url: rpcUrl } : {});
    const engine = await buildEngine(rpc, key, { patient: true, ephemeral: true, rpcUrl });
    const result = await engine.lookup(receiver, nearToYocto(amount));
    if (jsonOut) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    printLookup(receiver, result);
    return;
  }

  if (cmd === "doctor") {
    const guard = flag(rest, "--guard");
    const rpcUrl = flag(rest, "--rpc");
    if (!guard) {
      console.error("Usage: doctor --guard <id>");
      process.exit(1);
    }
    const rpc = createRpcClient(rpcUrl ? { url: rpcUrl } : {});
    const report = await checkGuardHardening(rpc, guard);
    for (const k of report.keys) {
      console.log(`${k.public_key}\t${k.verdict}\t${k.issues.join(",") || "-"}`);
    }
    console.log(report.pass ? "PASS" : "FAIL");
    process.exit(report.pass ? 0 : 1);
  }

  if (cmd === "trust-code") {
    const receiver = flag(rest, "--receiver");
    const rpcUrl = flag(rest, "--rpc");
    if (!receiver) {
      console.error("Usage: trust-code --receiver <id> [--rpc url]");
      process.exit(1);
    }
    const rpc = createRpcClient(rpcUrl ? { url: rpcUrl } : {});
    const account = await rpc.viewAccount(receiver);
    if (!account) {
      console.error(`Account ${receiver} does not exist.`);
      process.exit(1);
    }
    const cache = new CodeHashCache();
    const before = cache.baseline(receiver);
    cache.trust(receiver, account.code_hash);
    const show = (h: string | undefined) => (h === undefined ? "none" : h === EMPTY_HASH ? "no contract" : h);
    console.log(`Baseline for ${receiver}: ${show(before)} -> ${show(account.code_hash)}`);
    return;
  }

  console.error(`Unknown command: ${cmd}`);
  printHelp();
  process.exit(1);
}

async function buildEngine(
  rpc: ReturnType<typeof createRpcClient>,
  key: ReturnType<typeof loadOracleKey>,
  {
    patient = false,
    ephemeral = false,
    rpcUrl,
  }: { patient?: boolean; ephemeral?: boolean; rpcUrl?: string | undefined } = {},
) {
  const registryId = process.env.VALET_REGISTRY_ID;
  const registry = registryId ? createRpcRegistry(rpc, registryId) : new NoopRegistry();
  // The account history must come from the indexer of the chain the RPC serves: on the testnet that
  // is the testnet's own API. VALET_NEARBLOCKS_URL overrides the choice.
  const baseUrl = process.env.VALET_SKIP_NEARBLOCKS
    ? undefined
    : (process.env.VALET_NEARBLOCKS_URL ?? nearblocksUrlForChain(await fetchChainId(rpcUrl ? { url: rpcUrl } : {})));
  // A one-off command can wait out the indexer's rate limit; a long-running server must not.
  const activity = process.env.VALET_SKIP_NEARBLOCKS
    ? new NoopActivityProvider()
    : new NearblocksProvider({
        ...(baseUrl ? { baseUrl } : {}),
        ...(patient
          ? {
              rateLimitWaitMs: 12_000,
              onRateLimit: (ms: number) =>
                console.error(`  (Nearblocks rate limit, waiting ${ms / 1000}s; set NEARBLOCKS_API_KEY to avoid this)`),
            }
          : {}),
      });
  return new RiskEngine(
    {
      rpc,
      guard: createGuardReader(rpc),
      activity,
      registry,
      key,
      ...(ephemeral ? { codeHashCache: new CodeHashCache(null) } : {}),
    },
    {},
  );
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i >= 0 && args[i + 1]) return args[i + 1];
  return undefined;
}

function printHelp(): void {
  console.log(`valet-oracle commands:
  pubkey
  lookup <account> [--amount <NEAR>] [--rpc url] [--json]   counterparty check, no vault needed
  check --guard <id> --receiver <id> --amount <NEAR> [--rpc url] [--json]
  serve [--port 8787] [--rpc url]
  doctor --guard <id> [--rpc url]
  trust-code --receiver <id> [--rpc url]   accept the receiver's current contract code as the new baseline`);
}

function printCheckTable(result: Awaited<ReturnType<RiskEngine["evaluate"]>>): void {
  const useColor = !process.env.NO_COLOR;
  const vColor =
    result.verdict === "allow" ? "\x1b[32m" : result.verdict === "warn" ? "\x1b[33m" : "\x1b[31m";
  const reset = useColor ? "\x1b[0m" : "";
  const vc = useColor ? vColor : "";
  console.log(`Verdict: ${vc}${result.verdict}${reset}  Score: ${result.score}`);
  for (const r of result.reasons) {
    console.log(`  [${r.weight >= 0 ? "+" : ""}${r.weight}] ${r.code}: ${r.message}`);
  }
  console.log(`Reasons hash: ${result.reasonsHash}`);
  console.log(`Oracle key: ${result.oraclePublicKey}`);
}

function printLookup(
  receiver: string,
  result: Awaited<ReturnType<RiskEngine["lookup"]>>,
): void {
  const useColor = !process.env.NO_COLOR;
  const color = result.verdict === "allow" ? "\x1b[32m" : result.verdict === "warn" ? "\x1b[33m" : "\x1b[31m";
  const on = useColor ? color : "";
  const off = useColor ? "\x1b[0m" : "";
  console.log(`${receiver}: ${on}${result.verdict}${off} (score ${result.score})`);
  if (result.reasons.length === 0) console.log("  no signals fired");
  for (const r of result.reasons) {
    console.log(`  [${r.weight >= 0 ? "+" : ""}${r.weight}] ${r.code}: ${r.message}`);
  }
  if (result.reasons.some((r) => r.code === "ACCOUNT_AGE_UNKNOWN")) {
    console.log(
      "  note: age and activity come from the Nearblocks API, which rate-limits callers without a key;\n" +
        "        set NEARBLOCKS_API_KEY, or wait a minute and retry.",
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
