/** The sandbox binary's pre-flight: what a user sees when nearcore cannot start on their machine. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SANDBOX_VERSION, allowEveryPlatform, explainUnrunnable } from "../src/sandbox.js";

/** What the loader printed on Debian 12 (glibc 2.36), captured from `near-sandbox --version`. */
const DEBIAN_12 = [
  "/work/packages/e2e/.cache/near-sandbox-2.14.0/near-sandbox: /lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.38' not found (required by /work/packages/e2e/.cache/near-sandbox-2.14.0/near-sandbox)",
  "/work/packages/e2e/.cache/near-sandbox-2.14.0/near-sandbox: /lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.39' not found (required by /work/packages/e2e/.cache/near-sandbox-2.14.0/near-sandbox)",
].join("\n");

describe("explainUnrunnable", () => {
  it("turns a glibc error into what is needed, what is here, and what to do instead", () => {
    const text = explainUnrunnable(DEBIAN_12, "2.36");
    assert.match(text, new RegExp(`near-sandbox ${SANDBOX_VERSION} cannot start here`));
    assert.match(text, /needs glibc 2\.39 or newer/, "the newest version asked for, not the first");
    assert.match(text, /this machine has 2\.36/);
    assert.match(text, /Ubuntu 24\.04, Debian 13/);
    assert.match(text, /docker build -t valet \. && docker run --rm valet/);
    assert.match(text, /unit tests and `npm run lookup` do not/);
    assert.match(text, /NEAR_SANDBOX_BINARY_PATH/);
  });

  it("does not need to know the local glibc", () => {
    // `null` is "not known", whatever this host is: on a Linux machine, leaving the argument out would
    // ask the host and find its real glibc (the first version of this test did, and failed on CI).
    assert.match(explainUnrunnable(DEBIAN_12, null), /this machine has an older one/);
  });

  it("picks the newest requirement even when a two-digit minor comes after a one-digit one", () => {
    const text = explainUnrunnable("version `GLIBC_2.9' not found\nversion `GLIBC_2.100' not found\nversion `GLIBC_2.39' not found", "2.31");
    assert.match(text, /needs glibc 2\.100 or newer/);
  });

  it("reports any other failure by its first line", () => {
    const text = explainUnrunnable("\n  Illegal instruction (core dumped)\nmore\n");
    assert.match(text, /cannot be executed here: Illegal instruction \(core dumped\)$/);
    assert.match(explainUnrunnable(""), /cannot be executed here: no output$/);
  });
});

describe("allowEveryPlatform", () => {
  it("lets near-workspaces find the binary on Linux arm64, which near-sandbox@0.1.x refuses", async () => {
    const dir = await mkdtemp(join(tmpdir(), "valet-binary-"));
    await writeFile(join(dir, "near-sandbox"), "#!/bin/sh\n");
    const saved = { type: os.type, arch: os.arch, path: process.env.NEAR_SANDBOX_BINARY_PATH, flag: process.env.NEAR_SANDBOX_BIN_PATH };
    // Exactly what near-workspaces calls (internal-utils.js), found the way it finds it.
    const fromWorkspaces = createRequire(createRequire(import.meta.url).resolve("near-workspaces"));
    const getBinary = fromWorkspaces("near-sandbox/dist/getBinary") as { getBinary: () => Promise<{ binPath: string }> };
    const original = getBinary.getBinary;
    try {
      os.type = () => "Linux";
      os.arch = () => "arm64";
      process.env.NEAR_SANDBOX_BINARY_PATH = dir;
      process.env.NEAR_SANDBOX_BIN_PATH = dir;
      assert.throws(() => original(), /Unsupported platform: Linux arm64/, "the problem this works around");
      allowEveryPlatform();
      const binary = await getBinary.getBinary();
      assert.equal(binary.binPath, join(dir, "near-sandbox"));
    } finally {
      os.type = saved.type;
      os.arch = saved.arch;
      getBinary.getBinary = original;
      if (saved.path === undefined) delete process.env.NEAR_SANDBOX_BINARY_PATH; else process.env.NEAR_SANDBOX_BINARY_PATH = saved.path;
      if (saved.flag === undefined) delete process.env.NEAR_SANDBOX_BIN_PATH; else process.env.NEAR_SANDBOX_BIN_PATH = saved.flag;
    }
  });
});
