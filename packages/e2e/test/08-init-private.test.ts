import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { startSandbox, stopSandbox } from "../src/sandbox.js";
import { createAccount, ephemeralOracleKey } from "../src/fixture.js";
import { GUARD_WASM, REGISTRY_WASM, defaultPolicy } from "../src/paths.js";

before(async () => {
  await startSandbox();
});

after(async () => {
  await stopSandbox();
});

describe("initialization cannot be front-run", () => {
  it("only the contract's own account may call `new`, even when deploy and init are separate steps", { timeout: 240_000 }, async () => {
    const vault = await createAccount("vault", 5);
    const mallory = await createAccount("mallory", 1);
    const owner = await createAccount("owner", 1);
    await vault.deploy(readFileSync(GUARD_WASM)); // deployed, not initialized yet

    const args = {
      owner_id: mallory.accountId,
      oracle_public_key: ephemeralOracleKey().nearPublicKey,
      policy: defaultPolicy(),
    };
    await assert.rejects(() => mallory.call(vault, "new", args), /private/i);

    await vault.call(vault, "new", { ...args, owner_id: owner.accountId });
    const config = (await vault.view("get_config", {})) as { owner_id: string };
    assert.equal(config.owner_id, owner.accountId);
  });

  it("the registry is protected the same way", { timeout: 240_000 }, async () => {
    const registry = await createAccount("registry", 5);
    const mallory = await createAccount("mallory", 1);
    await registry.deploy(readFileSync(REGISTRY_WASM));
    await assert.rejects(() => mallory.call(registry, "new", { owner_id: mallory.accountId }), /private/i);
    await registry.call(registry, "new", { owner_id: registry.accountId });
  });
});
