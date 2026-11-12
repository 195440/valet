// An independent check of the MCP server: the official MCP TypeScript SDK's client talks to it
// over stdio, answers its yes/no question, and the replies are checked.
//
// Not part of `npm test`: the SDK is not a dependency of this repository.
//
//   terminal 1:  npm run sandbox
//   terminal 2:  npm install --no-save @modelcontextprotocol/sdk
//                node packages/mcp/scripts/sdk-interop.mjs [path/to/agent.json]
//
// It pays 0.1 NEAR to the allow-listed vendor and queues one 0.1 NEAR payment to the stranger
// (the owner can `reject` it in the sandbox terminal). Last run: SDK 1.32.2, all checks passed.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const config = resolve(process.argv[2] ?? process.env.VALET_CONFIG ?? join(repo, ".valet", "agent.json"));

const transport = new StdioClientTransport({
  command: join(repo, "node_modules", ".bin", "tsx"),
  args: [join(repo, "packages", "mcp", "src", "server.ts")],
  env: { VALET_CONFIG: config },
  stderr: "pipe",
});
let stderr = "";
transport.stderr?.on("data", (chunk) => (stderr += String(chunk)));

// The person at the client: answers come from this queue, and everything asked is kept.
const answers = [];
const questions = [];
const client = new Client({ name: "sdk-interop", version: "0.0.1" }, { capabilities: { elicitation: {} } });
client.setRequestHandler(ElicitRequestSchema, async (request) => {
  questions.push(request.params);
  return { action: "accept", content: { approve: answers.shift() ?? false } };
});

const call = async (name, args) => {
  const result = await client.callTool({ name, arguments: args });
  return { text: result.content.map((part) => part.text).join("\n"), isError: result.isError === true };
};

await client.connect(transport);
try {
  assert.equal(client.getServerVersion()?.name, "valet");
  assert.match(client.getInstructions() ?? "", /spending guard/);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["valet_check", "valet_pay", "valet_status"]);
  assert.equal(tools.find((t) => t.name === "valet_pay")?.annotations?.readOnlyHint, false);
  assert.equal(tools.find((t) => t.name === "valet_check")?.annotations?.readOnlyHint, true);

  assert.match((await call("valet_status", {})).text, /^paused=false$/m);
  assert.match((await call("valet_check", { receiver: "acme-vend0r.test.near", amount_near: "1" })).text, /LOOKALIKE_OF_KNOWN/);
  assert.match((await call("valet_pay", { receiver: "acme-vendor.test.near", amount_near: "0.1", memo: "sdk interop" })).text, /^status=paid$/m);

  answers.push(false);
  assert.match((await call("valet_pay", { receiver: "fresh-vendor.test.near", amount_near: "0.1" })).text, /^reason=user_denied$/m);
  answers.push(true);
  assert.match((await call("valet_pay", { receiver: "fresh-vendor.test.near", amount_near: "0.1" })).text, /^status=queued$/m);
  assert.equal(questions.length, 2);
  assert.match(String(questions[1].message), /approval queue/);
  assert.deepEqual(questions[1].requestedSchema.required, ["approve"]);

  assert.equal((await call("valet_pay", { receiver: "acme-vendor.test.near", amount_near: "nope" })).isError, true);
  await assert.rejects(client.callTool({ name: "no_such_tool", arguments: {} }), /Unknown tool/);
  assert.doesNotMatch(stderr, /ed25519:[1-9A-HJ-NP-Za-km-z]{80,}/, "a secret key was written to stderr");
  console.log("SDK interop check passed: initialize, tools/list, tools/call and the elicitation round trip.");
} finally {
  await client.close();
}
