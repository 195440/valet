import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { RiskEngine } from "./engine.js";
import { isPositiveDecimal, isValidNearAccountId } from "./account.js";
import type { Reason } from "./attestation.js";

const MAX_BODY = 8192;

class ReasonsLru {
  private map = new Map<string, Reason[]>();
  private order: string[] = [];

  set(hash: string, reasons: Reason[]): void {
    if (this.map.has(hash)) {
      this.order = this.order.filter((h) => h !== hash);
    }
    this.map.set(hash, reasons);
    this.order.push(hash);
    while (this.order.length > 500) {
      const old = this.order.shift()!;
      this.map.delete(old);
    }
  }

  get(hash: string): Reason[] | undefined {
    return this.map.get(hash);
  }
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("body_too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export interface ServerHandle {
  url: string;
  close(): Promise<void>;
}

export function startServer(options: {
  port?: number;
  host?: string;
  engine: RiskEngine;
}): Promise<ServerHandle> {
  const lru = new ReasonsLru();
  const host = options.host ?? "127.0.0.1";
  const cors = process.env.VALET_CORS_ORIGIN;

  const server = createServer(async (req, res) => {
    try {
      if (cors) {
        res.setHeader("Access-Control-Allow-Origin", cors);
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
        if (req.method === "OPTIONS") {
          res.writeHead(204);
          res.end();
          return;
        }
      }

      const url = new URL(req.url ?? "/", `http://${host}`);

      if (req.method === "GET" && url.pathname === "/v1/health") {
        json(res, 200, { status: "ok" });
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/pubkey") {
        json(res, 200, { oracle_public_key: options.engine.oraclePublicKey });
        return;
      }

      if (req.method === "GET" && url.pathname.startsWith("/v1/reasons/")) {
        const hash = decodeURIComponent(url.pathname.slice("/v1/reasons/".length));
        const reasons = lru.get(hash);
        if (!reasons) {
          json(res, 404, { error: "not_found" });
          return;
        }
        json(res, 200, { reasons_hash: hash, reasons });
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/check") {
        let raw: string;
        try {
          raw = await readBody(req, MAX_BODY);
        } catch (e) {
          json(res, 413, { error: String(e) });
          return;
        }
        let body: unknown;
        try {
          body = JSON.parse(raw);
        } catch {
          json(res, 400, { error: "invalid_json" });
          return;
        }
        const b = body as Record<string, unknown>;
        const guard = String(b.guard ?? "");
        const receiver = String(b.receiver ?? "");
        const amount_yocto = String(b.amount_yocto ?? "");
        if (!isValidNearAccountId(guard) || !isValidNearAccountId(receiver)) {
          json(res, 400, { error: "invalid_account_id" });
          return;
        }
        if (!isPositiveDecimal(amount_yocto)) {
          json(res, 400, { error: "invalid_amount" });
          return;
        }
        const result = await options.engine.evaluate({
          guard,
          receiver,
          amountYocto: amount_yocto,
          agent: b.agent ? String(b.agent) : undefined,
          context: b.context as Record<string, unknown> | undefined,
        });
        lru.set(result.reasonsHash, result.reasons);
        json(res, 200, {
          verdict: result.verdict,
          score: result.score,
          reasons: result.reasons,
          reasons_hash: result.reasonsHash,
          attestation: result.attestation,
          evaluated_at_ms: result.evaluatedAtMs,
          oracle_public_key: result.oraclePublicKey,
        });
        return;
      }

      json(res, 404, { error: "not_found" });
    } catch (e) {
      json(res, 500, { error: String(e) });
    }
  });

  return new Promise((resolve) => {
    server.listen(options.port ?? 8787, host, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : options.port ?? 8787;
      resolve({
        url: `http://${host}:${port}`,
        close: () =>
          new Promise((res, rej) => server.close((err) => (err ? rej(err) : res()))),
      });
    });
  });
}

function json(res: ServerResponse, code: number, data: unknown): void {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}
