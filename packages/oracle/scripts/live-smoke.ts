import { createRpcClient } from "../src/rpc.js";
import { stubGuardReader } from "../src/guard-reader.js";
import { NoopActivityProvider } from "../src/activity.js";
import { NoopRegistry } from "../src/registry.js";
import { RiskEngine } from "../src/engine.js";
import { CodeHashCache } from "../src/codehash-cache.js";
import { loadOracleKey } from "../src/keys.js";

const GUARD = "smoke-guard.near";
const RECEIVERS = [
  "near",
  "wrap.near",
  "aurora",
  `nonexistent-${Date.now()}.near`,
  "f".repeat(64),
  "v2.ref-finance.near",
];

async function main(): Promise<void> {
  const rpc = createRpcClient();
  const key = loadOracleKey();
  const engine = new RiskEngine({
    rpc,
    guard: stubGuardReader(),
    activity: new NoopActivityProvider(),
    registry: new NoopRegistry(),
    key,
    codeHashCache: new CodeHashCache(null),
  });

  let ok = true;
  console.log("Live smoke (mainnet RPC, stub guard)\n");
  for (const receiver of RECEIVERS) {
    try {
      const r = await engine.evaluate({
        guard: GUARD,
        receiver,
        amountYocto: "1000000000000000000000000",
      });
      console.log(`${receiver}\t${r.verdict}\tscore=${r.score}`);
    } catch (e) {
      ok = false;
      console.log(`${receiver}\tERROR\t${e}`);
    }
  }
  console.log(`\nNetwork: ${ok ? "OK" : "partial failures"}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
