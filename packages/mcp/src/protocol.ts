/**
 * The core of an MCP server: newline-delimited JSON-RPC 2.0 (the stdio transport), with only what
 * a tool server needs: initialize, ping, tools/list, tools/call, and the server-to-client
 * elicitation/create request that puts a question to the human. No dependencies.
 *
 * The class never touches stdin or stdout itself. Lines come in through `receive()`, messages go
 * out through the `send` option, so tests can drive it in memory.
 */

/** Newest first. A client that asks for one of these gets it back; anything else gets the newest. */
export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

export interface ToolDefinition {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface ToolResult {
  text: string;
  /** True when the tool itself failed. A refused payment is a normal answer, not a failure. */
  isError?: boolean;
}

export interface McpServerOptions {
  name: string;
  title?: string;
  version: string;
  instructions?: string;
  tools: ToolDefinition[];
  callTool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  /** Write one JSON-RPC message to the client. The caller adds the newline. */
  send(message: Record<string, unknown>): void;
  log?(line: string): void;
  /** How long `askHuman` waits for an answer before it counts as a no. Default 120 s. */
  askTimeoutMs?: number;
}

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const APPROVE_SCHEMA = {
  type: "object",
  properties: {
    approve: {
      type: "boolean",
      title: "Approve this payment",
      description: "Yes puts the payment into the vault's approval queue. No cancels it.",
      default: false,
    },
  },
  required: ["approve"],
};

export class McpServer {
  private clientCapabilities: Record<string, unknown> = {};
  private nextRequestId = 1;
  private readonly waiting = new Map<string, (message: Record<string, unknown>) => void>();
  private readonly inflight = new Set<Promise<void>>();

  constructor(private readonly options: McpServerOptions) {}

  /** True when the client declared that it can show a question to the human. */
  get canAskHuman(): boolean {
    const elicitation = this.clientCapabilities.elicitation;
    // `{}` is the original form-only capability; newer clients may list "form" and/or "url".
    return isObject(elicitation) && (Object.keys(elicitation).length === 0 || "form" in elicitation);
  }

  /** Feed one line from the client. Never throws; replies go out through `options.send`. */
  receive(line: string): void {
    const text = line.trim();
    if (!text) return;
    const task = this.handleLine(text).catch((e) => this.log(`internal error: ${String(e)}`));
    this.inflight.add(task);
    void task.finally(() => this.inflight.delete(task));
  }

  /** Resolves when every message received so far has been answered. */
  async idle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
  }

  /**
   * Ask the person behind the client a yes/no question (MCP elicitation). The answer comes from
   * the client's own UI, so the model cannot give it. Anything but an explicit yes is a no:
   * a client without elicitation, a decline, a cancel, a malformed answer, or no answer in time.
   */
  async askHuman(message: string): Promise<boolean> {
    if (!this.canAskHuman) return false;
    const id = `valet-${this.nextRequestId++}`;
    const reply = new Promise<Record<string, unknown>>((resolve) => this.waiting.set(id, resolve));
    this.options.send({
      jsonrpc: "2.0",
      id,
      method: "elicitation/create",
      params: { message, requestedSchema: APPROVE_SCHEMA },
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), this.options.askTimeoutMs ?? 120_000);
    });
    const answer = await Promise.race([reply, timeout]);
    clearTimeout(timer);
    this.waiting.delete(id);
    if (answer === null) {
      this.options.send({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: id, reason: "Valet stopped waiting for an answer" },
      });
      return false;
    }
    const result = answer.result;
    return (
      isObject(result) &&
      result.action === "accept" &&
      isObject(result.content) &&
      result.content.approve === true
    );
  }

  // ------------------------------------------------------------------ internals

  private log(line: string): void {
    this.options.log?.(line);
  }

  private async handleLine(line: string): Promise<void> {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.sendError(null, -32700, "Parse error");
      return;
    }
    if (Array.isArray(message)) {
      this.sendError(null, -32600, "Batch requests are not supported");
      return;
    }
    if (!isObject(message) || message.jsonrpc !== "2.0") {
      this.sendError(null, -32600, "Invalid Request");
      return;
    }

    if (typeof message.method !== "string") {
      this.acceptResponse(message);
      return;
    }
    const { method, id, params } = message;
    if (id === undefined) {
      // A notification: nothing to answer. "initialized", "cancelled" and the rest need no action.
      return;
    }
    if (typeof id !== "string" && typeof id !== "number") {
      this.sendError(null, -32600, "Invalid Request: id must be a string or a number");
      return;
    }
    try {
      const result = await this.dispatch(method, params);
      this.options.send({ jsonrpc: "2.0", id, result });
    } catch (e) {
      if (e instanceof RpcError) {
        this.sendError(id, e.code, e.message);
      } else {
        this.log(`internal error in ${method}: ${String(e)}`);
        this.sendError(id, -32603, "Internal error");
      }
    }
  }

  private acceptResponse(message: Record<string, unknown>): void {
    if (typeof message.id !== "string") return;
    const resolve = this.waiting.get(message.id);
    if (resolve) {
      this.waiting.delete(message.id);
      resolve(message);
    }
  }

  private async dispatch(method: string, params: unknown): Promise<Record<string, unknown>> {
    switch (method) {
      case "initialize":
        return this.initialize(params);
      case "ping":
        return {};
      case "tools/list":
        return { tools: this.options.tools };
      case "tools/call":
        return this.callTool(params);
      default:
        throw new RpcError(-32601, `Method not found: ${method}`);
    }
  }

  private initialize(params: unknown): Record<string, unknown> {
    const p = isObject(params) ? params : {};
    this.clientCapabilities = isObject(p.capabilities) ? p.capabilities : {};
    const requested = typeof p.protocolVersion === "string" ? p.protocolVersion : "";
    const result: Record<string, unknown> = {
      protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
      capabilities: { tools: {} },
      serverInfo: {
        name: this.options.name,
        title: this.options.title ?? this.options.name,
        version: this.options.version,
      },
    };
    if (this.options.instructions) result.instructions = this.options.instructions;
    return result;
  }

  private async callTool(params: unknown): Promise<Record<string, unknown>> {
    if (!isObject(params) || typeof params.name !== "string") {
      throw new RpcError(-32602, "Invalid params: name is required");
    }
    const name = params.name;
    if (!this.options.tools.some((tool) => tool.name === name)) {
      throw new RpcError(-32602, `Unknown tool: ${name}`);
    }
    if (params.arguments !== undefined && !isObject(params.arguments)) {
      throw new RpcError(-32602, "Invalid params: arguments must be an object");
    }
    try {
      const result = await this.options.callTool(name, (params.arguments as Record<string, unknown>) ?? {});
      return {
        content: [{ type: "text", text: result.text }],
        ...(result.isError ? { isError: true } : {}),
      };
    } catch (e) {
      this.log(`tool ${name} failed: ${String(e)}`);
      return {
        content: [{ type: "text", text: `Error: ${String((e as Error)?.message ?? e).slice(0, 300)}` }],
        isError: true,
      };
    }
  }

  private sendError(id: string | number | null, code: number, message: string): void {
    this.options.send({ jsonrpc: "2.0", id, error: { code, message } });
  }
}
