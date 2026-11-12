import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OWNER_ACTIONS, Owner, argumentProblem, isAccountId, isOwnerAction, type OwnerChain } from "../src/owner.js";

describe("isAccountId", () => {
  it("accepts NEAR account ids", () => {
    for (const id of ["acme-vendor.test.near", "alice.near", "a1", "x_y-z.near", "wrap.near", "0".repeat(64), "a".repeat(64), "sub.domain.example.near"]) {
      assert.equal(isAccountId(id), true, id);
    }
  });

  it("rejects everything else", () => {
    for (const id of ["", "a", "A.near", "has space.near", ".near", "near.", "a..b", "-a.near", "a-.near", "a_.near", "a--b.near", "x".repeat(65), "a/b", "a@b", "a.near\n", "ａ.near"]) {
      assert.equal(isAccountId(id), false, JSON.stringify(id));
    }
    for (const value of [undefined, null, 5, {}, []]) assert.equal(isAccountId(value), false);
  });
});

describe("owner actions", () => {
  it("are a short, fixed list: nothing that moves money or keys", () => {
    assert.deepEqual([...OWNER_ACTIONS].sort(), ["allow", "approve", "deny", "pause", "reject", "unallow", "undeny", "unpause"]);
    for (const dangerous of ["withdraw", "add_agent_key", "revoke_agent_key", "set_policy", "set_oracle", "pay", "toString", "constructor"]) {
      assert.equal(isOwnerAction(dangerous), false, dangerous);
    }
  });

  it("check their argument before anything is signed", () => {
    assert.equal(argumentProblem("approve", "12"), null);
    assert.match(argumentProblem("approve", "twelve") ?? "", /number of a pending payment/);
    assert.match(argumentProblem("reject", "") ?? "", /number/);
    assert.match(argumentProblem("reject", "1".repeat(19)) ?? "", /number/);
    assert.equal(argumentProblem("allow", "acme.near"), null);
    assert.match(argumentProblem("deny", "Not Valid") ?? "", /account id/);
    assert.equal(argumentProblem("pause", ""), null);
    assert.equal(argumentProblem("unpause", undefined), null);
  });
});

describe("Owner", () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const chain: OwnerChain = {
    async call(method, args) {
      calls.push([method, args]);
      return method === "approve" ? { status: "paid" } : undefined;
    },
    async view(method) {
      if (method === "get_pending") {
        return [
          { id: 3, receiver_id: "fresh-vendor.test.near", amount: "200000000000000000000000", expires_ms: String(Date.now() + 10 * 60_000) },
          { id: "4", receiver_id: "old.test.near", amount: "1500000000000000000000000", expires_ms: 1 },
        ];
      }
      return method === "get_allowlist" ? ["a.near"] : ["b.near"];
    },
  };
  const owner = new Owner(chain);

  it("lists the queue with ids as text and amounts in yocto", async () => {
    assert.deepEqual((await owner.pending()).map((p) => [p.id, p.receiver, p.amountYocto]), [
      ["3", "fresh-vendor.test.near", "200000000000000000000000"],
      ["4", "old.test.near", "1500000000000000000000000"],
    ]);
  });

  it("describes the queue for the terminal, expired entries as 0 minutes", async () => {
    const text = await owner.describePending(Date.now());
    const lines = text.split("\n");
    assert.match(lines[0]!, /^#3 {2}0\.2 NEAR to fresh-vendor\.test\.near {2}\(expires in about (9|10) min\)$/);
    assert.match(lines[1]!, /^#4 {2}1\.5 NEAR to old\.test\.near {2}\(expires in about 0 min\)$/);
    assert.equal(await new Owner({ ...chain, view: async () => [] }).describePending(), "nothing is waiting for approval");
  });

  it("lists both lists", async () => {
    assert.deepEqual(await owner.lists(), { allow: ["a.near"], deny: ["b.near"] });
  });

  it("words each result twice: the terminal's line and a plain sentence for the page", async () => {
    const sentences = async (action: Parameters<Owner["run"]>[0], arg: string, chainResult?: unknown) =>
      (await new Owner({ ...chain, call: async () => chainResult }).run(action, arg)).summary;
    assert.equal(await sentences("approve", "3", { status: "paid" }), "You approved payment #3. The vault sent it.");
    assert.equal(await sentences("approve", "3", { status: "blocked", reason: "paused" }), "You approved payment #3, but the vault stopped it: paused.");
    assert.equal(await sentences("approve", "3", undefined), "You approved payment #3, but the vault stopped it: unknown reason.");
    assert.equal(await sentences("reject", "4"), "You rejected payment #4. Nothing was sent.");
    assert.equal(await sentences("pause", ""), "You paused the vault. It pays nobody until you unpause it.");
    assert.equal(await sentences("unpause", ""), "You unpaused the vault.");
    assert.equal(await sentences("allow", "a.near"), "You put a.near on the allow list.");
    assert.equal(await sentences("deny", "b.near"), "You put b.near on the deny list.");
    assert.equal(await sentences("unallow", "a.near"), "You took a.near off the allow list.");
    assert.equal(await sentences("undeny", "b.near"), "You took b.near off the deny list.");
  });

  it("calls the vault with the right arguments and words the result", async () => {
    calls.length = 0;
    assert.equal((await owner.run("approve", "3")).message, 'approve #3: {"status":"paid"}');
    assert.equal((await owner.run("reject", "4")).message, 'reject #4: "done"');
    assert.equal((await owner.run("pause")).message, "paused: the vault pays nobody until you unpause");
    assert.equal((await owner.run("unpause")).message, "unpaused");
    assert.equal((await owner.run("allow", "a.near")).message, "a.near is on the allow list");
    assert.equal((await owner.run("unallow", "a.near")).message, "a.near is off the allow list");
    assert.equal((await owner.run("deny", "b.near")).message, "b.near is on the deny list");
    assert.equal((await owner.run("undeny", "b.near")).message, "b.near is off the deny list");
    assert.deepEqual(calls, [
      ["approve", { id: "3" }],
      ["reject", { id: "4" }],
      ["pause", {}],
      ["unpause", {}],
      ["allow", { account_id: "a.near" }],
      ["unallow", { account_id: "a.near" }],
      ["deny", { account_id: "b.near" }],
      ["undeny", { account_id: "b.near" }],
    ]);
  });

  it("throws on a bad argument without calling the vault", async () => {
    calls.length = 0;
    await assert.rejects(owner.run("approve", "x"), /number of a pending payment/);
    await assert.rejects(owner.run("allow", "NOPE"), /account id/);
    assert.deepEqual(calls, []);
  });
});
