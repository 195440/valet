import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { base58Encode, base58Decode } from "../src/base58.js";

describe("base58", () => {
  it("roundtrip and known vector", () => {
    const empty = new Uint8Array([]);
    assert.equal(base58Encode(empty), "");
    const bytes = new Uint8Array([0, 0, 1, 2, 3]);
    const enc = base58Encode(bytes);
    assert.deepEqual(base58Decode(enc), bytes);
  });

  it("NEAR-style pubkey payload", () => {
    const pk = new Uint8Array(32).fill(0xab);
    const enc = base58Encode(pk);
    assert.ok(enc.length > 10);
    assert.deepEqual(base58Decode(enc), pk);
  });
});
