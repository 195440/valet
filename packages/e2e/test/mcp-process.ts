/** Helpers for test 09: run the real sandbox and the real MCP server as child processes. */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const tsxBin = join(repoRoot, "node_modules", ".bin", "tsx");
export const sandboxScript = join(repoRoot, "demo", "src", "sandbox.ts");
export const mcpServerScript = join(repoRoot, "packages", "mcp", "src", "server.ts");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Child {
  readonly child: ChildProcessWithoutNullStreams;
  readonly stdout: string[] = [];
  stderr = "";
  readonly exited: Promise<number | null>;
  private lineListeners: Array<(line: string) => void> = [];

  constructor(script: string, env: Record<string, string | undefined>) {
    this.child = spawn(tsxBin, [script], {
      cwd: repoRoot,
      env: { ...process.env, NO_COLOR: "1", ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => (this.stderr += chunk));
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      this.stdout.push(line);
      for (const listener of this.lineListeners) listener(line);
    });
    this.exited = new Promise((resolve) => this.child.on("exit", (code) => resolve(code)));
  }

  onLine(listener: (line: string) => void): void {
    this.lineListeners.push(listener);
  }

  write(text: string): void {
    this.child.stdin.write(text);
  }

  /** Wait for a stdout line matching `pattern`, looking only at lines after `fromIndex`. */
  async waitForLine(pattern: RegExp, timeoutMs: number, fromIndex = 0): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.stdout.slice(fromIndex).find((line) => pattern.test(line));
      if (hit !== undefined) return hit;
      if (this.child.exitCode !== null) throw new Error(`process exited (${this.child.exitCode}) before ${pattern}. stderr: ${this.stderr.slice(-500)}`);
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${pattern}. stdout so far:\n${this.stdout.slice(-15).join("\n")}`);
      await sleep(100);
    }
  }

  async stop(signal: NodeJS.Signals = "SIGINT", timeoutMs = 60_000): Promise<number | null> {
    if (this.child.exitCode !== null) return this.child.exitCode;
    this.child.kill(signal);
    const result = await Promise.race([this.exited, sleep(timeoutMs).then(() => "timeout" as const)]);
    if (result === "timeout") {
      this.child.kill("SIGKILL");
      throw new Error(`did not stop within ${timeoutMs} ms after ${signal}`);
    }
    return result;
  }
}

/** The owner's console is the sandbox's stdin: send a command, wait for what it prints. */
export async function ownerCommand(sandbox: Child, command: string, expect: RegExp, timeoutMs = 90_000): Promise<string> {
  const from = sandbox.stdout.length;
  sandbox.write(`${command}\n`);
  return sandbox.waitForLine(expect, timeoutMs, from);
}

export type ToolReply = { text: string; isError: boolean };

/** A bare-bones MCP client over a child's stdio. */
export class McpClient {
  /** Lines the server wrote to stdout that are not JSON. There must be none. */
  readonly garbage: string[] = [];
  /** Answers the server's own requests (elicitation). */
  onServerRequest: (method: string, params: Record<string, unknown>) => unknown = () => ({ action: "cancel" });
  readonly asked: Array<Record<string, unknown>> = [];
  private nextId = 1;
  private readonly waiting = new Map<number, (message: Record<string, unknown>) => void>();

  constructor(readonly proc: Child) {
    proc.onLine((line) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        this.garbage.push(line);
        return;
      }
      if (typeof message.method === "string" && message.id !== undefined) {
        const params = (message.params ?? {}) as Record<string, unknown>;
        this.asked.push({ method: message.method, ...params });
        const result = this.onServerRequest(message.method, params);
        proc.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
      } else if (typeof message.id === "number") {
        this.waiting.get(message.id)?.(message);
        this.waiting.delete(message.id);
      }
    });
  }

  request(method: string, params: Record<string, unknown> = {}, timeoutMs = 90_000): Promise<Record<string, any>> {
    const id = this.nextId++;
    const reply = new Promise<Record<string, unknown>>((resolve, reject) => {
      this.waiting.set(id, resolve);
      setTimeout(() => reject(new Error(`no answer to ${method} within ${timeoutMs} ms`)), timeoutMs).unref();
    });
    this.proc.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return reply as Promise<Record<string, any>>;
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    this.proc.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async initialize(capabilities: Record<string, unknown>): Promise<Record<string, any>> {
    const reply = await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities,
      clientInfo: { name: "valet-e2e", version: "0" },
    });
    this.notify("notifications/initialized");
    return reply.result;
  }

  async tool(name: string, args: Record<string, unknown> = {}): Promise<ToolReply> {
    const reply = await this.request("tools/call", { name, arguments: args });
    if (reply.error) throw new Error(`${name}: JSON-RPC error ${JSON.stringify(reply.error)}`);
    return { text: String(reply.result.content?.[0]?.text ?? ""), isError: reply.result.isError === true };
  }

  /** Close stdin like a client that quits; the server must exit cleanly. */
  async close(): Promise<number | null> {
    this.proc.child.stdin.end();
    return Promise.race([this.proc.exited, sleep(30_000).then(() => "timeout" as const)]).then((r) => {
      if (r === "timeout") throw new Error("the MCP server did not exit when stdin closed");
      return r;
    });
  }
}
