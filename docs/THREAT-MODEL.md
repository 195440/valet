# Threat model

What Valet protects, from whom, and where it stops. Where a claim is backed by a test, the test is
named. All tests run on a real local chain (`npm run test:e2e`).

## What is protected

The NEAR held by the guard (vault) contract. The agent can spend it only through `pay`, inside
limits the owner set.

## Who is trusted

| Party | Trusted to | If it is compromised |
|---|---|---|
| owner key | set policy, approve queued payments, pause, add or revoke the agent key, withdraw | the vault is lost; keep it offline and out of the agent's reach |
| oracle key | sign verdicts honestly | the attacker can mint `allow` verdicts for any receiver, but only up to the caps, and only within the expiry; rotate with `set_oracle` |
| RPC node | report chain state honestly | it can hide a lookalike, an upgrade or a report; use your own node |
| indexer (Nearblocks) | report account age, transaction count and deployment history honestly | it can make a new account look old or hide a recent deployment; an unavailable or rate-limited indexer scores as unknown (age +10), never as safe. The caps do not depend on it |
| guard contract | enforce the rules | unaudited; this is the part to review |
| MCP client and its user (`packages/mcp`) | show the `warn` question to a person and report the answer | a client that always answers yes only gets payments *queued*; only the owner's `approve`, a separate on-chain transaction, sends the money |
| the sandbox's web console and the browser that shows it (`demo/src/console`) | show what happened and send the owner's eight commands: approve, reject, pause, unpause, allow, unallow, deny, undeny | whoever holds the console's token can approve queued payments and pause the vault, but cannot withdraw, change the policy or touch keys |
| the LLM, tools, web pages, invoices, other agents | nothing | assumed to be hostile |

The agent's key is **not** trusted. The design assumes it will be stolen or misused.

## Attacks and what stops them

| Attack | What stops it | Residual risk |
|---|---|---|
| **Prompt injection** makes the agent pay an attacker | oracle blocks lookalikes, unknown or reported accounts before signing; `warn` goes to a human; the guard's caps apply regardless (e2e 05, demo step 4) | an injection that names a receiver the oracle scores `allow`, or one inside the caps |
| **Stolen agent key** | function-call key: no transfer, no key changes, only `pay`; `pay` needs a valid attestation or an allow-listed receiver; caps; owner can `pause` or `revoke_agent_key` (e2e 04, demo step 7) | loss up to the caps to allow-listed or attested receivers, plus up to the gas allowance burnt as fees; lock-out |
| **Forged attestation** | ed25519 signature checked on-chain against the owner-set oracle key (e2e 02, demo step 7) | none known |
| **Replayed attestation**, for another receiver, a larger amount, another vault, or twice | bound to guard, receiver, max amount, expiry, nonce; nonces are stored (e2e 02) | none known |
| **Compromised oracle** | verdict and expiry limits; caps; `warn` still queues for the owner; `set_oracle` rotates the key (e2e 06) | an oracle that says `allow` for an attacker, within the caps |
| **Lookalike or typosquatted account** | `LOOKALIKE_OF_KNOWN` against the allow list and well-known accounts (demo step 4) | lookalikes of accounts nobody listed |
| **Bait and switch**: a trusted contract is upgraded to a drainer | code baseline: `CONTRACT_CODE_CHANGED` stays on until a human runs `trust-code`; also for allow-listed receivers (e2e 07, demo step 3); `CONTRACT_RECENTLY_DEPLOYED` reads the indexer's deployment history, so a swap in the last 7 days is flagged on first sight; both are a *warn floor*, so old-account and paid-before credit cannot cancel them (unit tests); `CONTRACT_FULL_ACCESS_KEY` flags contracts that can be swapped any time | a swap that lands between the oracle's check and the payment; a first observation that was already malicious and older than 30 days; an indexer that hides the deployment |
| **Plain account that deploys code later** | baseline records "no contract" too, so new code is flagged (e2e 07) | same as above |
| **Known scam**, reported by others | registry: 2 reporters +50, 3 block, with evidence URLs in the reasons (e2e 05, 06, demo step 6) | cheap to spam against strangers (0.01 NEAR per report); allow-listed receivers are immune; reports are advice |
| **Smear a vendor** with fake reports | owner's allow list outranks the registry | a vendor that is not allow-listed can be flagged |
| **Agent bypasses the MCP server**: a coding agent with shell access reads the settings file and signs `pay` itself | the vault's checks do not depend on the server: the key can only call `pay`, strangers need an attestation, the caps apply (demo step 7) | the same as for a stolen key: loss up to the caps |
| **A model talks the human into a yes** | the question gives the receiver, the amount and the oracle's signals first; the agent's memo comes last, quoted, cut to 120 characters and labelled as the agent's; a yes only queues the payment and the owner approves on-chain (e2e 09, unit tests) | a person who approves without reading |
| **A client that cannot ask** | the payment is refused as `no_human_handler`, never decided by the model (e2e 09) | none known |
| **Wrong key in the MCP settings** (for example a full-access key) | the server refuses to start unless the key is a function-call key limited to `pay` on the vault: `assertSafeKey` (client unit tests: full access, another receiver, extra methods, an empty method list; e2e 09: a key the vault does not know) | none known |
| **Agent keeps asking until the human says yes** | each `warn` is a separate, logged decision; the owner approves queued payments on-chain | prompt fatigue; keep `warn` rare by allow-listing known vendors |
| **Front-running initialization** | deploy and `new` in one batch transaction | if deployed in two steps, anyone can call `new` first; check `get_config` |
| **Draining by many small payments** | rolling window cap (hourly buckets, up to 72 hours) | a thief can spend the window cap again after it rolls over |
| **Gas-allowance exhaustion** | the allowance caps the gas a key can burn; owner re-keys: `revoke_agent_key`, then `add_agent_key` (e2e 04) | agent downtime until the owner acts, and up to the allowance lost as fees |
| **Untrusted free text** | report notes are never forwarded to the LLM; tool output contains codes and weights only | none known |
| **Another web page, or another machine, drives the owner's console** | it listens on `127.0.0.1` (a container opts in to another address); every request needs a random token that is printed only in the terminal's link, kept in the URL fragment and sent as a header; `Host` and `Origin` must be the console's own; the commands are the eight above; arguments are checked before anything is signed (unit tests, e2e 09 "the web console") | anything running as the same user on the same machine that can read the terminal; the console is for a sandbox chain, so what it can approve is sandbox money |
| **Markup or script in text the page shows** (an agent's memo, a receiver's name, a reason) | every string is inserted with `textContent`; the policy has a per-response nonce and no `unsafe-inline`; bodies are JSON of at most 8 KB; a unit test bans `innerHTML`, inline handlers and outside requests from the page, and an e2e test sends markup as a memo through the real agent (e2e 09) | none known |

## The oracle key: what would make it harder to abuse

Today one ed25519 key, set by the owner with `set_oracle`, signs every verdict. If it leaks, the
holder can mint `allow` verdicts for any receiver, but only up to the caps, each for 120 seconds, and
a `warn` still waits for the owner. Three things would shrink that further. None is built:

- **The oracle inside a TEE** (Intel TDX, AWS Nitro, a confidential VM). The signing key is created
  inside and never leaves; before calling `set_oracle` the owner checks the remote-attestation quote
  against the oracle's build hash and takes the public key from it. The guard needs no change. Missing
  here: quote verification in `doctor` and a reproducible oracle image. A TEE protects the key from the
  machine's operator, not from a mistake in the oracle's own scoring.
- **The quote verified on-chain**, so the guard only accepts a key attested with a given measurement
  and a rotation needs a fresh quote. That changes the contract and needs a verifier that fits NEAR's
  gas limits.
- **Two or more oracles**: `pay` accepts a verdict only when k of n independent signers (other
  operators, other data sources) signed the same message. No hardware needed, at the price of more
  calls per payment. The attested message already binds guard, receiver, amount, expiry and nonce, so
  the change is a list of keys and a threshold.

The caps hold without any of them, and they are what the rest of the design rests on.

## What Valet does not do

- It cannot tell whether a payment *should* happen. It limits how much damage a wrong one does.
- It does not protect an owner key that sits next to the agent.
- It does not detect prompt injection; it makes injection less valuable.
- It does not guarantee the oracle's verdicts. The caps are the guarantee.
- The web console and the oracle's endpoint are for a local sandbox. Do not publish them to a
  network: the console's token protects it from other web pages and other machines, not from a
  hostile process of the same user.
- The oracle's HTTP endpoint has no authentication and no rate limit. Anyone who can reach it can
  obtain verdicts, though never an `allow` for a receiver the engine scores badly. Keep it on
  `127.0.0.1` or put your own auth in front.
- The guard keeps every used nonce and every receiver's stats forever; the vault's balance pays the
  storage stake.
- A failed transfer (for example to an account deleted after the check) is not rolled back in the
  counters. The oracle blocks non-existent named accounts first.
- The contracts are unaudited. They ran on the public testnet ([record](testnet-run.md)) and were never deployed to mainnet.

## Supply chain

- The committed wasm has pinned SHA-256 values in `contracts/*/res/*.sha256` and the build script
  `scripts/build-contracts.sh` regenerates them (Rust 1.99, cargo-near 0.22, near-sdk 5.30). The
  build is not byte-reproducible across machines; compare behaviour with `npm run test:e2e`.
  The committed binaries were compiled on the author's machine. rustc embeds the absolute path of
  the cargo registry in panic messages, and before publishing that path was replaced with a neutral
  string of the same length (`/local-path-removed-before-publishing/...`). Nothing else in the
  modules changed, but it means a rebuild will not match the committed hashes.
- The sandbox binary is downloaded from NEAR's build bucket over HTTPS and checked against a
  SHA-256 pinned in `packages/e2e/src/sandbox.ts` before it is unpacked.
- `npm ci` installs from `package-lock.json`, and `.npmrc` sets `ignore-scripts=true`, so no
  dependency runs code at install time.
- `@valet/oracle` has no runtime dependencies: it imports only `node:crypto`, `node:fs`,
  `node:http`, `node:path` and uses the global `fetch`. `@valet/client` adds `near-api-js` to sign
  and send transactions.
- `npm audit` (2026-11-02) lists advisories with no upstream fix, all inside the `near-api-js` and
  `near-workspaces` dependency trees: `elliptic` (reached through `secp256k1`, i.e. secp256k1 keys,
  which Valet does not use: the oracle signs with ed25519) and `tar` (reached through the
  `near-sandbox` installer, which does not run here). `near-workspaces` belongs to the local-chain
  harness in `packages/e2e` (which the demo reuses) and only talks to a chain on `127.0.0.1`.
