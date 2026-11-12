import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { ApiError, TOKEN_HEADER, startConsoleServer, type ConsoleApi, type ConsoleServer } from "../src/console/server.js";

const calls: Array<{ method: string; body?: unknown; since?: number }> = [];

const api: ConsoleApi = {
  state: async (since) => {
    calls.push({ method: "state", since });
    return { ok: true, since };
  },
  owner: async (body) => {
    calls.push({ method: "owner", body });
    if (body.fail === "known") throw new ApiError(409, "the vault said no");
    if (body.fail === "unknown") throw new Error("boom: secret detail\n    at stack line");
    return { ok: true };
  },
  pay: async (body) => (calls.push({ method: "pay", body }), { ok: true }),
  scenario: async (body) => (calls.push({ method: "scenario", body }), { ok: true }),
  answer: async (body) => (calls.push({ method: "answer", body }), { ok: true }),
};

let server: ConsoleServer;

before(async () => {
  server = await startConsoleServer(api, {
    html: '<!doctype html><style nonce="__NONCE__"></style><script nonce="__NONCE__"></script>',
    assets: { "/fonts/test.woff2": { type: "font/woff2", body: Buffer.from("wOF2-test-bytes") } },
  });
});

after(async () => {
  await server.close();
});

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  json: () => any;
}

/** node:http, because fetch does not let a test lie about the Host header. */
function call(options: { method?: string; path: string; headers?: Record<string, string>; body?: string }): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port: server.port, method: options.method ?? "GET", path: options.path, headers: options.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json: () => JSON.parse(text) });
        });
      },
    );
    req.on("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

const authed = (extra: Record<string, string> = {}): Record<string, string> => ({ [TOKEN_HEADER]: server.token, ...extra });
const json = { "content-type": "application/json" };

describe("the console page", () => {
  it("is served without the token, with a fresh nonce in the page and in the policy", async () => {
    const a = await call({ path: "/" });
    const b = await call({ path: "/" });
    assert.equal(a.status, 200);
    assert.match(String(a.headers["content-type"]), /^text\/html/);
    const nonceInPage = /<script nonce="([^"]+)">/.exec(a.text)?.[1];
    assert.ok(nonceInPage && !a.text.includes("__NONCE__"));
    const policy = String(a.headers["content-security-policy"]);
    assert.ok(policy.includes(`script-src 'nonce-${nonceInPage}'`));
    assert.ok(policy.includes(`style-src 'nonce-${nonceInPage}'`));
    assert.ok(!/unsafe-inline|unsafe-eval/.test(policy));
    assert.match(policy, /default-src 'none'/);
    assert.match(policy, /connect-src 'self'/);
    assert.match(policy, /font-src 'self'/);
    assert.match(policy, /frame-ancestors 'none'/);
    assert.notEqual(/<script nonce="([^"]+)">/.exec(b.text)?.[1], nonceInPage, "a new nonce for every response");
    assert.equal(a.headers["cache-control"], "no-store");
    assert.equal(a.headers["x-content-type-options"], "nosniff");
    assert.equal(a.headers["x-frame-options"], "DENY");
    assert.equal(a.headers["access-control-allow-origin"], undefined, "no CORS: other sites cannot read anything");
  });

  it("serves only the page and its fonts without a token, and nothing else is there", async () => {
    assert.equal((await call({ path: "/favicon.ico" })).status, 404);
    assert.equal((await call({ path: "/index.html" })).status, 404);
    assert.equal((await call({ method: "POST", path: "/" })).status, 405);
  });

  it("hands out a font as it is, by its exact path and only to a GET", async () => {
    const font = await call({ path: "/fonts/test.woff2" });
    assert.equal(font.status, 200);
    assert.equal(font.headers["content-type"], "font/woff2");
    assert.equal(font.text, "wOF2-test-bytes");
    assert.equal(font.headers["x-content-type-options"], "nosniff");
    assert.equal(font.headers["cross-origin-resource-policy"], "same-origin");
    assert.equal(font.headers["access-control-allow-origin"], undefined);
    assert.equal((await call({ method: "POST", path: "/fonts/test.woff2" })).status, 405);
    assert.equal((await call({ method: "PUT", path: "/fonts/test.woff2" })).status, 405);
    // Nothing is looked up on disk: only the paths the server was given exist.
    for (const path of ["/fonts/", "/fonts", "/fonts/test.woff", "/fonts/TEST.woff2", "/fonts/other.woff2", "/fonts/../index.html", "/fonts/%2e%2e/test.woff2", "/fonts/test.woff2/x", "//fonts/test.woff2"]) {
      assert.equal((await call({ path })).status, 404, path);
    }
    assert.equal((await call({ path: "/fonts/test.woff2", headers: { host: "evil.example" } })).status, 403, "the Host check covers fonts too");
  });

  it("listens on the loopback address and offers the token only in the fragment", () => {
    assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    assert.equal(server.openUrl, `${server.url}#token=${server.token}`);
    assert.match(server.token, /^[0-9a-f]{48}$/);
  });
});

describe("who may use the API", () => {
  it("refuses a request without the token, or with a wrong one, before it reaches any handler", async () => {
    const before = calls.length;
    assert.equal((await call({ path: "/api/state" })).status, 401);
    assert.equal((await call({ path: "/api/state", headers: { [TOKEN_HEADER]: "nope" } })).status, 401);
    assert.equal((await call({ path: "/api/state", headers: { [TOKEN_HEADER]: `${server.token}0` } })).status, 401, "a longer token is wrong too");
    assert.equal((await call({ path: "/api/state", headers: { [TOKEN_HEADER]: server.token.slice(0, -1) } })).status, 401);
    assert.equal((await call({ method: "POST", path: "/api/owner", headers: json, body: '{"action":"pause"}' })).status, 401);
    assert.equal(calls.length, before, "nothing ran");
  });

  it("does not take the token from the query string", async () => {
    assert.equal((await call({ path: `/api/state?token=${server.token}` })).status, 401);
  });

  it("refuses a Host that is not the server's own name (DNS rebinding)", async () => {
    const before = calls.length;
    for (const host of ["evil.example", `evil.example:${server.port}`, `127.0.0.1.evil.example:${server.port}`, `127.0.0.1:${server.port + 1}`]) {
      const reply = await call({ path: "/api/state", headers: authed({ host }) });
      assert.equal(reply.status, 403, host);
      assert.equal((await call({ path: "/", headers: { host } })).status, 403, `${host} gets no page either`);
    }
    assert.equal(calls.length, before);
    assert.equal((await call({ path: "/api/state", headers: authed({ host: `localhost:${server.port}` }) })).status, 200, "localhost is the same machine");
  });

  it("refuses a request that names another origin, even with the token", async () => {
    const before = calls.length;
    const evil = await call({ method: "POST", path: "/api/owner", headers: authed({ ...json, origin: "http://evil.example" }), body: '{"action":"pause"}' });
    assert.equal(evil.status, 403);
    const nullOrigin = await call({ method: "POST", path: "/api/owner", headers: authed({ ...json, origin: "null" }), body: '{"action":"pause"}' });
    assert.equal(nullOrigin.status, 403, "a sandboxed iframe sends Origin: null");
    assert.equal(calls.length, before);
    const own = await call({ method: "POST", path: "/api/owner", headers: authed({ ...json, origin: `http://127.0.0.1:${server.port}` }), body: '{"action":"pause"}' });
    assert.equal(own.status, 200);
  });
});

describe("the API", () => {
  it("passes `since` to the state handler, and treats nonsense as 0", async () => {
    await call({ path: "/api/state?since=17", headers: authed() });
    await call({ path: "/api/state?since=abc", headers: authed() });
    await call({ path: "/api/state?since=-5", headers: authed() });
    await call({ path: "/api/state", headers: authed() });
    assert.deepEqual(calls.slice(-4).map((c) => c.since), [17, 0, 0, 0]);
  });

  it("needs JSON for every POST, and a small one", async () => {
    assert.equal((await call({ method: "POST", path: "/api/owner", headers: authed({ "content-type": "text/plain" }), body: '{"action":"pause"}' })).status, 415);
    assert.equal((await call({ method: "POST", path: "/api/owner", headers: authed({ "content-type": "application/x-www-form-urlencoded" }), body: "action=pause" })).status, 415);
    assert.equal((await call({ method: "POST", path: "/api/owner", headers: authed() })).status, 415, "no content type");
    assert.equal((await call({ method: "POST", path: "/api/owner", headers: authed(json), body: "{not json" })).status, 400);
    assert.equal((await call({ method: "POST", path: "/api/owner", headers: authed(json), body: "[1,2]" })).status, 400);
    assert.equal((await call({ method: "POST", path: "/api/owner", headers: authed(json), body: '"text"' })).status, 400);
    const big = await call({ method: "POST", path: "/api/owner", headers: authed(json), body: JSON.stringify({ action: "pause", pad: "x".repeat(20_000) }) });
    assert.equal(big.status, 413);
    assert.equal((await call({ method: "POST", path: "/api/owner", headers: authed({ "content-type": "application/json; charset=utf-8" }), body: '{"action":"pause"}' })).status, 200);
    assert.equal((await call({ method: "POST", path: "/api/owner", headers: authed(json), body: "" })).status, 200, "an empty body is an empty object");
  });

  it("routes each endpoint to its handler with the parsed body", async () => {
    for (const [path, name] of [["/api/owner", "owner"], ["/api/pay", "pay"], ["/api/scenario", "scenario"], ["/api/answer", "answer"]] as const) {
      const reply = await call({ method: "POST", path, headers: authed(json), body: JSON.stringify({ marker: name }) });
      assert.equal(reply.status, 200, path);
      assert.deepEqual(calls.at(-1), { method: name, body: { marker: name } });
    }
  });

  it("rejects the wrong method and unknown endpoints", async () => {
    assert.equal((await call({ method: "GET", path: "/api/owner", headers: authed() })).status, 405);
    assert.equal((await call({ method: "POST", path: "/api/state", headers: authed(json), body: "{}" })).status, 405);
    assert.equal((await call({ method: "PUT", path: "/api/pay", headers: authed(json), body: "{}" })).status, 405);
    assert.equal((await call({ method: "GET", path: "/api/nothing", headers: authed() })).status, 404);
    assert.equal((await call({ method: "GET", path: "/api/constructor", headers: authed() })).status, 404);
    assert.equal((await call({ method: "GET", path: "/api/__proto__", headers: authed() })).status, 404);
  });

  it("returns a handler's refusal as JSON with its status, and hides the stack of a real failure", async () => {
    const known = await call({ method: "POST", path: "/api/owner", headers: authed(json), body: '{"fail":"known"}' });
    assert.equal(known.status, 409);
    assert.deepEqual(known.json(), { ok: false, error: "the vault said no" });
    const unknown = await call({ method: "POST", path: "/api/owner", headers: authed(json), body: '{"fail":"unknown"}' });
    assert.equal(unknown.status, 500);
    assert.equal(unknown.json().error, "boom: secret detail", "first line only");
    assert.ok(!unknown.text.includes("stack line"));
  });
});
