/**
 * The HTTP side of the web console: a small server for one person on this machine.
 *
 * It can approve payments and pause the vault, so it is built like something that holds that
 * power:
 *   - it listens on 127.0.0.1 only;
 *   - every call needs a random token that exists only in the URL printed to the terminal, sent
 *     as a header (a header the browser will not attach to a request from another site);
 *   - the Host header must be the server's own name (a DNS-rebinding page is refused);
 *   - a request that names another Origin is refused, and bodies must be small JSON.
 * The page itself carries no secret and no data, so serving it without the token is harmless. Its
 * fonts are the same: fixed files, by exact path, GET only.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export const TOKEN_HEADER = "x-valet-token";
const MAX_BODY_BYTES = 8 * 1024;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** What the page can ask for. Each handler validates its own input and throws `ApiError` on bad input. */
export interface ConsoleApi {
  state(since: number): Promise<unknown>;
  owner(body: Record<string, unknown>): Promise<unknown>;
  pay(body: Record<string, unknown>): Promise<unknown>;
  scenario(body: Record<string, unknown>): Promise<unknown>;
  answer(body: Record<string, unknown>): Promise<unknown>;
}

/** A fixed file the page needs, such as a font. */
export interface ConsoleAsset {
  type: string;
  body: Uint8Array;
}

export interface ConsoleServerOptions {
  /** The page, with `__NONCE__` where its script and style tags take their nonce. A function is called for every request, so editing the page needs no restart. */
  html: string | (() => string);
  /** Files served as they are at an exact path such as `/fonts/a.woff2`, to anyone who can reach the page. Nothing else is looked up on disk. */
  assets?: Record<string, ConsoleAsset>;
  port?: number;
  /**
   * The address to listen on. Loopback unless told otherwise: a container needs 0.0.0.0 inside so
   * that Docker can forward `127.0.0.1:<port>` of the host to it. The token and the Host and
   * Origin checks apply either way.
   */
  host?: string;
  token?: string;
}

export interface ConsoleServer {
  url: string;
  /** The address to open: the URL with the token in the fragment, which browsers never send. */
  openUrl: string;
  port: number;
  token: string;
  close(): Promise<void>;
}

function sameToken(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function headerOf(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function send(res: ServerResponse, status: number, body: string | Uint8Array, type: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cross-origin-resource-policy": "same-origin",
    ...extra,
  });
  res.end(body);
}

const sendJson = (res: ServerResponse, status: number, value: unknown): void =>
  send(res, status, JSON.stringify(value), "application/json; charset=utf-8");

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const type = headerOf(req, "content-type") ?? "";
  if (!/^application\/json(\s*;|$)/i.test(type)) throw new ApiError(415, "send application/json");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new ApiError(413, "request too large");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ApiError(400, "body is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new ApiError(400, "body must be a JSON object");
  return parsed as Record<string, unknown>;
}

export async function startConsoleServer(api: ConsoleApi, options: ConsoleServerOptions): Promise<ConsoleServer> {
  const token = options.token ?? randomBytes(24).toString("hex");
  const assets = new Map(Object.entries(options.assets ?? {}));
  let port = 0;
  const allowedHosts = (): Set<string> => new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const host = headerOf(req, "host");
    if (!host || !allowedHosts().has(host.toLowerCase())) throw new ApiError(403, "unexpected Host header");
    const url = new URL(req.url ?? "/", `http://${host}`);
    const method = req.method ?? "GET";

    if (url.pathname === "/") {
      if (method !== "GET") throw new ApiError(405, "GET only");
      const nonce = randomBytes(16).toString("base64");
      const csp = [
        "default-src 'none'",
        `script-src 'nonce-${nonce}'`,
        `style-src 'nonce-${nonce}'`,
        "font-src 'self'",
        "connect-src 'self'",
        "img-src 'self' data:",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
      ].join("; ");
      const page = typeof options.html === "function" ? options.html() : options.html;
      send(res, 200, page.replaceAll("__NONCE__", nonce), "text/html; charset=utf-8", {
        "content-security-policy": csp,
        "x-frame-options": "DENY",
      });
      return;
    }

    const asset = assets.get(url.pathname);
    if (asset) {
      if (method !== "GET") throw new ApiError(405, "GET only");
      send(res, 200, asset.body, asset.type, { "cache-control": "public, max-age=3600" });
      return;
    }

    if (!url.pathname.startsWith("/api/")) throw new ApiError(404, "not found");

    // Everything below can act for the owner or the agent.
    if (!sameToken(headerOf(req, TOKEN_HEADER), token)) throw new ApiError(401, "missing or wrong token: open the URL the sandbox printed");
    const origin = headerOf(req, "origin");
    if (origin !== undefined && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) {
      throw new ApiError(403, "unexpected Origin");
    }

    if (url.pathname === "/api/state") {
      if (method !== "GET") throw new ApiError(405, "GET only");
      const raw = url.searchParams.get("since") ?? "0";
      const since = /^\d{1,12}$/.test(raw) ? Number(raw) : 0;
      sendJson(res, 200, await api.state(since));
      return;
    }
    const posts: Record<string, (body: Record<string, unknown>) => Promise<unknown>> = {
      "/api/owner": (b) => api.owner(b),
      "/api/pay": (b) => api.pay(b),
      "/api/scenario": (b) => api.scenario(b),
      "/api/answer": (b) => api.answer(b),
    };
    const post = posts[url.pathname];
    if (!post) throw new ApiError(404, "no such endpoint");
    if (method !== "POST") throw new ApiError(405, "POST only");
    sendJson(res, 200, await post(await readJson(req)));
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (e instanceof ApiError) {
        sendJson(res, e.status, { ok: false, error: e.message });
        return;
      }
      sendJson(res, 500, { ok: false, error: String((e as Error)?.message ?? e).split("\n")[0]!.slice(0, 300) });
    });
  });
  // One person, a handful of requests: no need to hold idle sockets open when the sandbox stops.
  server.keepAliveTimeout = 2_000;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => resolve());
  });
  port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}/`;
  return {
    url,
    openUrl: `${url}#token=${token}`,
    port,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
