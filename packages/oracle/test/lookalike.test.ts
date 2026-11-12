import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findLookalike } from "../src/lookalike.js";

const trusted = ["wrap.near", "intents.near", "usdt.tether-token.near"];

describe("lookalike", () => {
  it("detects typosquats", () => {
    assert.ok(findLookalike("wrap.neer", trusted)?.target === "wrap.near");
    assert.ok(findLookalike("lntents.near", trusted)?.target === "intents.near");
    assert.ok(findLookalike("usdc.n3ar", ["usdc.near"])?.target === "usdc.near");
  });

  it("rejects clearly different names", () => {
    assert.equal(findLookalike("completely-random-account.near", trusted), null);
    assert.equal(findLookalike("near", trusted), null);
    assert.equal(findLookalike("wrap.near", trusted), null);
  });
});
