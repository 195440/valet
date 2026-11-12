import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { McpServer, PROTOCOL_VERSIONS, type McpServerOptions } from "../src/protocol.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Msg = Record<string, any>;

function harness(overrides: Partial<McpServerOptions> = {}) {
  const sent: Msg[] = [];
  const server: McpServer = new McpServer({
    name: "valet",
    version: "9.9.9",
    instructions: "be careful",
    tools: [{ name: "echo", description: "echo", inputSchema: { type: "object" } }],
    callTool: async (_name, args) => ({ text: `echo ${JSON.stringify(args)}` }),
    send: (message) => sent.push(message),
    ...overrides,
  });
  const feed = async (message: unknown): Promise<void> => {
    server.receive(typeof message === "string" ? message : JSON.stringify(message));
    await server.idle();
  };
  const initialize = (capabilities: Msg = {}, protocolVersion = "2025-06-18") =>
    feed({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion, capabilities, clientInfo: { name: "t", version: "1" } } });
  return { server, sent, feed, initialize };
}

describe("MCP handshake", () => {
  it("answers initialize with the requested version, the tools capability and the server info", async () => {
    const { sent, initialize } = harness();
    await initialize({}, "2025-03-26");
    assert.equal(sent.length, 1);
    const result = sent[0]!.result;
    assert.equal(sent[0]!.id, 0);
    assert.equal(result.protocolVersion, "2025-03-26");
    assert.deepEqual(result.capabilities, { tools: {} });
    assert.equal(result.serverInfo.name, "valet");
    assert.equal(result.serverInfo.version, "9.9.9");
    assert.equal(result.instructions, "be careful");
  });

  it("answers an unknown protocol version with the newest one it knows", async () => {
    const { sent, initialize } = harness();
    await initialize({}, "2099-01-01");
    assert.equal(sent[0]!.result.protocolVersion, PROTOCOL_VERSIONS[0]);
  });

  it("answers ping and stays silent on notifications", async () => {
    const { sent, feed } = harness();
    await feed({ jsonrpc: "2.0", method: "notifications/initialized" });
    await feed({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } });
    assert.equal(sent.length, 0);
    await feed({ jsonrpc: "2.0", id: "p", method: "ping" });
    assert.deepEqual(sent, [{ jsonrpc: "2.0", id: "p", result: {} }]);
  });

  it("lists its tools", async () => {
    const { sent, feed } = harness();
    await feed({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    assert.deepEqual(sent[0]!.result.tools.map((t: Msg) => t.name), ["echo"]);
  });
});

describe("tools/call", () => {
  it("wraps the tool's text in a content block", async () => {
    const { sent, feed } = harness();
    await feed({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo", arguments: { a: 1 } } });
    assert.deepEqual(sent[0]!.result, { content: [{ type: "text", text: 'echo {"a":1}' }] });
  });

  it("runs a call without arguments with an empty object", async () => {
    const { sent, feed } = harness();
    await feed({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo" } });
    assert.equal(sent[0]!.result.content[0].text, "echo {}");
  });

  it("marks a failed tool with isError", async () => {
    const { sent, feed } = harness({ callTool: async () => ({ text: "nope", isError: true }) });
    await feed({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo" } });
    assert.deepEqual(sent[0]!.result, { content: [{ type: "text", text: "nope" }], isError: true });
  });

  it("turns a thrown error into an isError result instead of dying", async () => {
    const logs: string[] = [];
    const { sent, feed } = harness({
      callTool: async () => {
        throw new Error("x".repeat(1_000));
      },
      log: (line) => logs.push(line),
    });
    await feed({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo" } });
    const result = sent[0]!.result;
    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.startsWith("Error: xxx"));
    assert.ok(result.content[0].text.length <= 310);
    assert.equal(logs.length, 1);
  });

  it("rejects unknown tools and malformed params with -32602", async () => {
    const { sent, feed } = harness();
    await feed({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "nope" } });
    await feed({ jsonrpc: "2.0", id: 2, method: "tools/call", params: {} });
    await feed({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "echo", arguments: [1] } });
    await feed({ jsonrpc: "2.0", id: 4, method: "tools/call" });
    assert.deepEqual(sent.map((m) => [m.id, m.error?.code]), [[1, -32602], [2, -32602], [3, -32602], [4, -32602]]);
  });
});

describe("JSON-RPC errors", () => {
  it("answers unknown methods with -32601 and the request's id", async () => {
    const { sent, feed } = harness();
    await feed({ jsonrpc: "2.0", id: 7, method: "resources/list" });
    assert.equal(sent[0]!.id, 7);
    assert.equal(sent[0]!.error.code, -32601);
  });

  it("answers garbage, batches and bad envelopes without crashing", async () => {
    const { sent, feed } = harness();
    await feed("{not json");
    await feed("[]");
    await feed({ jsonrpc: "1.0", id: 1, method: "ping" });
    await feed({ jsonrpc: "2.0", id: null, method: "ping" });
    await feed({ jsonrpc: "2.0", id: { a: 1 }, method: "ping" });
    await feed("42");
    assert.deepEqual(sent.map((m) => [m.id, m.error.code]), [
      [null, -32700],
      [null, -32600],
      [null, -32600],
      [null, -32600],
      [null, -32600],
      [null, -32600],
    ]);
  });

  it("ignores blank lines", async () => {
    const { sent, feed } = harness();
    await feed("");
    await feed("   ");
    assert.equal(sent.length, 0);
  });
});

describe("asking the human (elicitation)", () => {
  const answer = async (sent: Msg[], feed: (m: unknown) => Promise<void>, result: Msg) => {
    const request = sent.find((m) => m.method === "elicitation/create")!;
    await feed({ jsonrpc: "2.0", id: request.id, result });
  };

  it("is a no when the client never said it can ask", async () => {
    const { server, sent, initialize } = harness();
    await initialize({ roots: {} });
    assert.equal(server.canAskHuman, false);
    assert.equal(await server.askHuman("pay?"), false);
    assert.equal(sent.filter((m) => m.method === "elicitation/create").length, 0);
  });

  it("recognises the elicitation capability in its old and new forms", async () => {
    for (const [capability, expected] of [
      [{}, true],
      [{ form: {} }, true],
      [{ form: {}, url: {} }, true],
      [{ url: {} }, false],
    ] as const) {
      const { server, initialize } = harness();
      await initialize({ elicitation: capability });
      assert.equal(server.canAskHuman, expected, JSON.stringify(capability));
    }
  });

  it("sends a form with one boolean and returns true only for an explicit yes", async () => {
    const { server, sent, feed, initialize } = harness();
    await initialize({ elicitation: {} });
    const pending = server.askHuman("Pay 1 NEAR?");
    const request = sent.find((m) => m.method === "elicitation/create")!;
    assert.equal(request.params.message, "Pay 1 NEAR?");
    assert.deepEqual(request.params.requestedSchema.required, ["approve"]);
    assert.equal(request.params.requestedSchema.properties.approve.type, "boolean");
    await answer(sent, feed, { action: "accept", content: { approve: true } });
    assert.equal(await pending, true);
  });

  it("treats decline, cancel, a missing field, a non-boolean and an error reply as no", async () => {
    const replies: Msg[] = [
      { result: { action: "accept", content: { approve: false } } },
      { result: { action: "decline" } },
      { result: { action: "cancel" } },
      { result: { action: "accept" } },
      { result: { action: "accept", content: {} } },
      { result: { action: "accept", content: { approve: "true" } } },
      { result: { action: "accept", content: { approve: 1 } } },
      { result: "yes" },
      { error: { code: -32601, message: "no elicitation here" } },
    ];
    for (const reply of replies) {
      const { server, sent, feed, initialize } = harness();
      await initialize({ elicitation: {} });
      const pending = server.askHuman("q");
      const request = sent.find((m) => m.method === "elicitation/create")!;
      await feed({ jsonrpc: "2.0", id: request.id, ...reply });
      assert.equal(await pending, false, JSON.stringify(reply));
    }
  });

  it("ignores answers to other requests and gives up after the timeout, telling the client", async () => {
    const { server, sent, feed, initialize } = harness({ askTimeoutMs: 40 });
    await initialize({ elicitation: {} });
    const pending = server.askHuman("q");
    await feed({ jsonrpc: "2.0", id: "someone-else", result: { action: "accept", content: { approve: true } } });
    assert.equal(await pending, false);
    const cancelled = sent.find((m) => m.method === "notifications/cancelled")!;
    assert.equal(cancelled.params.requestId, sent.find((m) => m.method === "elicitation/create")!.id);
  });

  it("does not let a late answer approve a payment that already timed out", async () => {
    const { server, sent, feed, initialize } = harness({ askTimeoutMs: 20 });
    await initialize({ elicitation: {} });
    assert.equal(await server.askHuman("q"), false);
    await answer(sent, feed, { action: "accept", content: { approve: true } });
    // a second question gets its own id, so the stale answer cannot satisfy it
    const second = server.askHuman("q2");
    const ids = sent.filter((m) => m.method === "elicitation/create").map((m) => m.id);
    assert.equal(new Set(ids).size, 2);
    await feed({ jsonrpc: "2.0", id: ids[1], result: { action: "decline" } });
    assert.equal(await second, false);
  });

  it("keeps serving other requests while a question is open", async () => {
    let asked: Promise<boolean> | undefined;
    const { server, sent, feed, initialize } = harness({
      callTool: async () => {
        asked = server.askHuman("ok?");
        return { text: `human said ${(await asked) ? "yes" : "no"}` };
      },
    });
    await initialize({ elicitation: {} });
    server.receive(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo" } }));
    // (not `feed`: it waits for every call in flight, and this one waits for us)
    server.receive(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }));
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(sent.some((m) => m.id === 2 && m.result), "ping answered while the question is open");
    assert.ok(!sent.some((m) => m.id === 1), "the call is still waiting for the human");
    await answer(sent, feed, { action: "accept", content: { approve: true } });
    await server.idle();
    assert.equal(sent.find((m) => m.id === 1)!.result.content[0].text, "human said yes");
  });
});
