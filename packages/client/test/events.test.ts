import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseEvents, decodePayResult } from "../src/events.js";

describe("parseEvents", () => {
  it("extracts valet EVENT_JSON logs", () => {
    const payload = {
      standard: "valet",
      version: "1.0.0",
      event: "payment_paid",
      data: [{ receiver_id: "v.near" }],
    };
    const logs = [`EVENT_JSON:${JSON.stringify(payload)}`];
    const ev = parseEvents({ logs });
    assert.equal(ev.length, 1);
    assert.equal(ev[0]!.event, "payment_paid");
  });
});

describe("decodePayResult", () => {
  it("decodes base64 JSON", () => {
    const json = JSON.stringify({ status: "blocked", reason: "denylisted" });
    const b64 = Buffer.from(json, "utf8").toString("base64");
    assert.deepEqual(decodePayResult(b64), { status: "blocked", reason: "denylisted" });
  });
});
