import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseNear, formatNear } from "../src/near-amount.js";

describe("parseNear / formatNear", () => {
  it("parses whole NEAR", () => {
    assert.equal(parseNear("1"), 10n ** 24n);
  });

  it("parses decimals without float", () => {
    assert.equal(parseNear("1.5"), 15n * 10n ** 23n);
    assert.equal(parseNear("0.01"), 10n ** 22n);
  });

  it("round-trips", () => {
    const v = parseNear("2.25");
    assert.equal(formatNear(v), "2.25");
  });

  it("rejects invalid", () => {
    assert.throws(() => parseNear("1e3"));
    assert.throws(() => parseNear("1.2.3"));
  });
});
