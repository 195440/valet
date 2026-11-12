# @valet/client

Agent-side wrapper for the Valet guard: oracle pre-check, human `warn` handling, signed `pay`
transactions, and a JSON-lines audit log. See the [top-level README](../../README.md).

## Usage

```ts
import { ValetAgent } from "@valet/client";

const agent = new ValetAgent({
  guardId: "my-vault.testnet",
  agentKey: process.env.VALET_AGENT_KEY!, // ed25519:... the function-call key; never commit it
  rpcUrl: "https://test.rpc.fastnear.com",
  networkId: "testnet",                   // default "sandbox"
  oracleUrl: "http://127.0.0.1:8787",
  onWarn: async (ctx) => confirm(`Pay ${ctx.amountNear} NEAR to ${ctx.receiver}?`),
  auditFile: "./audit.jsonl",
});

await agent.assertSafeKey(); // throws unless the key is a function-call key limited to `pay` on the guard
const result = await agent.pay({ receiver: "vendor.near", amountNear: "1.5", memo: "invoice #1" });
// result.status: "paid" | "queued" | "blocked" | "refused" | "error"
// result.stage:  "oracle" | "user" | "chain"
```

- Without `onWarn`, a `warn` verdict is refused (`no_human_handler`): the wrapper fails closed.
  `onWarn` answers `true` (go on), `false` (the human said no: `user_denied`) or `"unavailable"`
  (there was nobody to ask: `no_human_handler`).
- `await agent.check({ receiver, amountNear })` asks the oracle and returns `{verdict, score,
  reasons}`. Nothing is signed or sent, and nothing is logged.
- `block` is never signed. Nothing is sent to the chain.
- `gas` defaults to 20 TGas. A function-call key needs an allowance of about 0.021 NEAR to submit
  such a call at all (the node checks the prepaid gas at a pessimistic price).
- Use `engine` (an in-process `RiskEngine` from `@valet/oracle`) instead of `oracleUrl` to skip HTTP.
- Chain exceptions (for example `NotEnoughAllowance`) come back as `status: "error"`, not as throws.

## Tool calling

```ts
import { toolDefinition, handleToolCall } from "@valet/client";

const tools = [toolDefinition()];   // OpenAI-style `valet_pay(receiver, amount_near, memo?)`
// when the model calls the tool:
const text = await handleToolCall(agent, { receiver: "vendor.near", amount_near: "1.5" });
// "status=refused\nstage=oracle\n...\nsignals=LOOKALIKE_OF_KNOWN(60); ..." goes back to the model
```

The text for the model contains status, verdict, score, reason codes and signal weights only. Evidence
and free text from reports are never included, because they can be attacker-controlled.

Also exported: `parseNear`, `formatNear`, `parseEvents`, `decodePayResult`, `formatPayResult`.

To use the wrapper from an MCP client such as Claude Code or Cursor, see [`packages/mcp`](../mcp).

## Scripts

```bash
npm test          # 18 unit tests
npm run typecheck
```
