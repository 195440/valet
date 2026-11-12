import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fetchWithRetry } from "../src/sandbox.js";

type Handler = (call: number, res: ServerResponse) => void;

/** A throwaway HTTP server on a free port; `call` counts requests from 1. */
async function serve(handler: Handler) {
  let calls = 0;
  const server = createServer((_req: IncomingMessage, res: ServerResponse) => handler(++calls, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/near-sandbox.tar.gz`,
    calls: () => calls,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Promise 1000 bytes, send 3, then cut the connection: what a network hiccup looks like to fetch. */
function dropMidBody(res: ServerResponse): void {
  res.writeHead(200, { "content-length": "1000" });
  res.write("abc");
  setTimeout(() => res.destroy(), 20);
}

describe("downloading the sandbox binary", () => {
  it("retries a connection that drops in the middle of the download", async () => {
    const server = await serve((call, res) => {
      if (call === 1) return dropMidBody(res);
      res.writeHead(200, { "content-length": "7" });
      res.end("payload");
    });
    try {
      const data = await fetchWithRetry(server.url, { backoffMs: 1 });
      assert.equal(data.toString(), "payload");
      assert.equal(server.calls(), 2);
    } finally {
      await server.close();
    }
  });

  it("gives up after the last attempt and says what went wrong and where", async () => {
    const server = await serve((_call, res) => dropMidBody(res));
    try {
      await assert.rejects(
        () => fetchWithRetry(server.url, { attempts: 2, backoffMs: 1 }),
        (err: Error) =>
          /after 2 attempts/.test(err.message) && /terminated/.test(err.message) && err.message.includes(server.url),
      );
      assert.equal(server.calls(), 2);
    } finally {
      await server.close();
    }
  });

  it("does not retry a 404, asking again would not help", async () => {
    const server = await serve((_call, res) => {
      res.writeHead(404);
      res.end("nope");
    });
    try {
      await assert.rejects(() => fetchWithRetry(server.url, { backoffMs: 1 }), /after 1 attempt: 404/);
      assert.equal(server.calls(), 1);
    } finally {
      await server.close();
    }
  });
});
