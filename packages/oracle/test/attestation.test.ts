import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createPublicKey } from "node:crypto";
import {
  buildAttestationMessage,
  hashReasons,
  signAttestation,
  verifyAttestationSignature,
} from "../src/attestation.js";

describe("attestation", () => {
  it("golden message bytes", () => {
    const msg = buildAttestationMessage("guard.near", "receiver.near", {
      max_amount: "1000000000000000000000000",
      verdict: "warn",
      expires_ms: "1700000000000",
      nonce: "42",
      reasons: "0",
    });
    assert.equal(
      msg,
      "VALET/1\nguard=guard.near\nreceiver=receiver.near\nmax_amount=1000000000000000000000000\nverdict=warn\nexpires_ms=1700000000000\nnonce=42\nreasons=0",
    );
    assert.equal(msg.endsWith("\n"), false);
  });

  it("reasons hash key-order stability", () => {
    const a = hashReasons([
      { code: "B", weight: 1, message: "b", evidence: { z: 1, a: 2 } },
      { code: "A", weight: 2, message: "a" },
    ]);
    const b = hashReasons([
      { code: "B", weight: 1, message: "b", evidence: { a: 2, z: 1 } },
      { code: "A", weight: 2, message: "a" },
    ]);
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{64}$/);
    assert.equal(hashReasons([]), "0");
  });

  it("sign and verify roundtrip", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const pub = createPublicKey(privateKey);
    const der = pub.export({ format: "der", type: "spki" }) as Buffer;
    const raw = der.subarray(der.length - 32);
    const reasonsHash = hashReasons([{ code: "X", weight: 1, message: "m" }]);
    const att = signAttestation(privateKey, "g.near", "r.near", {
      max_amount: "999",
      verdict: "allow",
      expires_ms: "1234567890",
      nonce: "7",
      reasonsHash,
    });
    assert.ok(verifyAttestationSignature(new Uint8Array(raw), "g.near", "r.near", att));
  });
});
