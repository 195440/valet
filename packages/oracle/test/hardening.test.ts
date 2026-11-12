import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkGuardHardening } from "../src/hardening.js";
import type { RpcClient, AccessKeyView } from "../src/rpc.js";

function mockRpc(keys: AccessKeyView[]): RpcClient {
  return {
    async viewAccount() {
      return null;
    },
    async viewAccessKeys() {
      return keys;
    },
    async callView() {
      return null;
    },
  };
}

describe("guard hardening", () => {
  const guard = "agent-guard.near";

  it("PASS clean function-call key", async () => {
    const report = await checkGuardHardening(
      mockRpc([
        {
          public_key: "ed25519:abc",
          access_key: {
            nonce: 0,
            permission: {
              FunctionCall: {
                allowance: "100",
                receiver_id: guard,
                method_names: ["pay"],
              },
            },
          },
        },
      ]),
      guard,
    );
    assert.equal(report.pass, true);
  });

  it("FAIL full-access key", async () => {
    const report = await checkGuardHardening(
      mockRpc([
        {
          public_key: "ed25519:bad",
          access_key: { nonce: 0, permission: "FullAccess" },
        },
      ]),
      guard,
    );
    assert.equal(report.pass, false);
  });

  it("FAIL wrong receiver", async () => {
    const report = await checkGuardHardening(
      mockRpc([
        {
          public_key: "ed25519:x",
          access_key: {
            nonce: 0,
            permission: {
              FunctionCall: {
                allowance: "1",
                receiver_id: "other.near",
                method_names: ["pay"],
              },
            },
          },
        },
      ]),
      guard,
    );
    assert.equal(report.pass, false);
  });

  it("FAIL extra method", async () => {
    const report = await checkGuardHardening(
      mockRpc([
        {
          public_key: "ed25519:x",
          access_key: {
            nonce: 0,
            permission: {
              FunctionCall: {
                allowance: "1",
                receiver_id: guard,
                method_names: ["pay", "withdraw"],
              },
            },
          },
        },
      ]),
      guard,
    );
    assert.equal(report.pass, false);
  });
});
