# Valet

[![CI](https://github.com/195440/valet/actions/workflows/ci.yml/badge.svg)](https://github.com/195440/valet/actions/workflows/ci.yml)

![Valet: give an AI agent a wallet without giving it your keys](docs/img/banner.png)

**Give an AI agent a wallet without giving it your keys.**

Valet is a spending guard for AI agents on NEAR. The agent never holds a key that can move your
funds. It holds a *function-call access key* that can do exactly one thing: call `pay` on a vault
contract. The vault enforces your limits on-chain, and an oracle checks every receiver before
the agent is allowed to sign.

![The Valet console: a poisoned invoice refused, a normal one paid](docs/img/console-overview.png)

<table>
<tr>
<td width="50%"><img src="docs/img/console-ask.png" alt="A stranger asks for money: the agent needs a human"></td>
<td width="50%"><img src="docs/img/console-thief.png" alt="The stolen-key story: seven attempts, none got through"></td>
</tr>
<tr>
<td><b>A stranger asks for 0.2 NEAR.</b> The oracle says <code>warn</code>, so the page asks a human. Yes only queues the payment; the owner still has to approve it.</td>
<td><b>The agent's key is stolen.</b> A thief with only the key tries seven things straight on the chain. Every one is refused, each with the real error.</td>
</tr>
</table>

*Screenshots of the real console against a real local NEAR chain.* **[Play the same story in your browser](https://195440.github.io/valet/)**: a replay of a recorded session, nothing to install.

Built at NEAR HACKATHON, in the **AI Security & Defense** track, and also entered in **Agent
Economy** ([what it covers there](#agent-economy-the-wallet-half)). Everything below runs locally on
a real NEAR chain (nearcore 2.14.0, the runtime mainnet uses today). No accounts, no API keys, no
funds. The same story also ran on the **public NEAR testnet**, with an explorer link for every
transaction: [`docs/testnet-run.md`](docs/testnet-run.md).

Watch the [short video](docs/valet-demo.mp4) (under two minutes) of the web console against the
real local chain (the AI agent's decisions are scripted buttons; the vault, oracle and chain are
real), or read how [a real AI agent fared](docs/real-agent-run.md) when Claude Code was pointed at
the same vault.

```
                        prompt injection, scam invoice, poisoned web page ...
                                          |
   LLM agent  --valet_pay(receiver, amount)-->  ValetAgent (wrapper)
                                                   |  1. ask the oracle: allow / warn / block + reasons
                                                   |  2. block -> refuse, warn -> ask the human
                                                   |  3. sign with the function-call key
                                                   v
   Oracle (signs verdicts)  <---------------  guard contract (the vault)  ---> receiver
     account age/activity, lookalikes,          per-tx cap, rolling window cap, allow/deny lists,
     contract code changes, history,            oracle-signed attestation for strangers,
     shared blocklist with evidence             approval queue for `warn`, kill switch
```

## Try it

Requirements: Node.js >= 22. The unit tests and `npm run lookup` run anywhere. The chain parts
(`demo`, `sandbox`, `test:e2e`) start a real local NEAR node, `near-sandbox` 2.14.0, which runs on
macOS with Apple silicon and on Linux (x64 or arm64) with **glibc 2.39 or newer** (Ubuntu 24.04,
Debian 13, Fedora 40). On anything else (an Intel Mac, Debian 12, Ubuntu 22.04) use
[Docker](#with-docker); if the node cannot start, the program says why and what to do instead of
failing with an exit code. The contracts are committed as prebuilt wasm, so no Rust is needed.

```bash
npm ci
npm run test:unit    # about 5 seconds: 205 unit tests (oracle risk engine, agent wrapper, MCP server, console, testnet script, replay page)
npm run demo         # about 1 minute: a hijacked agent against a real local chain
npm run test:e2e     # about 10 minutes: 50 tests, 42 of them on a real local chain
npm run sandbox      # a local chain that stays up: a web console to play with (see "Try it in your browser") and an MCP server for a real AI agent
npm run testnet      # about 3 minutes: the same story on the public NEAR testnet (needs a network, no local node)
```

`npm run testnet` asks the public testnet faucet for one account and builds everything under it:
real accounts, both contracts, an explorer link for every transaction, a Markdown record in
`.valet/testnet/`. It uses testnet NEAR only, and its keys are generated per run and stay on your
machine. `npm run testnet -- --rehearsal` runs the same script on a local chain. A recorded run is in
[`docs/testnet-run.md`](docs/testnet-run.md).

The first run of `demo` or `test:e2e` downloads the `near-sandbox` 2.14.0 binary once (about
30 MB, SHA-256 checked) into `packages/e2e/.cache/`. Why not the one bundled with
`near-workspaces`: it is nearcore 2.6.2 and rejects the committed wasm (see
[Runtime note](#runtime-note)). On another platform, point `NEAR_SANDBOX_BINARY_PATH` at a directory
that contains a `near-sandbox` >= 2.14.

The repository's `.npmrc` sets `ignore-scripts=true`: no dependency runs code at install time
(the `near-sandbox` package would otherwise fetch that 2.6.2 binary), and `npm ci` takes about
10 seconds.

### With Docker

```bash
docker build -t valet .            # Debian 13 + Node 22; npm ci; fetches the pinned sandbox binary once
docker run --rm valet              # the attack demo (no network needed)
docker run --rm valet npm run test:unit
docker run --rm valet npm run test:e2e
docker run --rm -it -p 127.0.0.1:8787:8787 -e VALET_CONSOLE_HOST=0.0.0.0 -e VALET_CONSOLE_PORT=8787 \
  valet npm run sandbox            # the web console: open the link it prints
```

Publish the same port number on both sides of `-p`: the console only answers requests addressed to
its own port. [CI](.github/workflows/ci.yml) runs typecheck, the unit tests and the demo on Ubuntu
24.04 for every push; the end-to-end tests run in a [second workflow](.github/workflows/e2e.yml).

### Try the oracle on real mainnet accounts

The counterparty check needs no vault, no account and no funds: it works on any account of the
real network (public RPC and the Nearblocks API, read-only).

```bash
npm run lookup -- wrap.near
npm run lookup -- v2.ref-finance.near
npm run lookup -- wrap.nearr           # a lookalike of wrap.near that nobody registered
```

Captured on 2026-11-10. This reads live data, so what you see will drift:

```
wrap.near: allow (score 0)
  [-10] ACCOUNT_OLD: Account older than 180 days
  [-10] ACTIVE_ACCOUNT: Over 1000 transactions on record

v2.ref-finance.near: allow (score 0)
  [+10] CONTRACT_RECENTLY_DEPLOYED: Contract code was deployed within the last 30 days
  [-10] ACCOUNT_OLD: Account older than 180 days
  [-10] ACTIVE_ACCOUNT: Over 1000 transactions on record

wrap.nearr: block (score 100)
  [+100] ACCOUNT_NOT_FOUND: Named receiver account does not exist on chain
  [+60] LOOKALIKE_OF_KNOWN: Receiver resembles trusted account wrap.near
```

The second one is a real contract that was last redeployed on 2026-10-30, so it sits in the
30-day band. Captured on 2026-11-06, when that deployment was less than a week old, the same
lookup said `warn` (score 30, `+30` for a deployment in the last 7 days): the oracle flags a
swapped contract on first sight from the indexer's deployment history, and the old-and-busy
signals do not cancel that (the warn floor, below). The free Nearblocks tier allows a few
requests a minute: `lookup` waits and retries when it is rate limited (set `NEARBLOCKS_API_KEY`
to avoid the wait). `--json` prints the full result. With a testnet RPC
(`--rpc https://test.rpc.fastnear.com`) the same commands read the testnet and the testnet's own
indexer; [the testnet record](docs/testnet-run.md#check-it-yourself) has commands that work on its accounts.

### What `npm run demo` shows

Nine steps, each printed and asserted; the process exits non-zero if any expectation fails. The
full output of a run is in [`docs/demo-output.txt`](docs/demo-output.txt). The last line is
`RESULT: 0 NEAR reached the attackers. 25 checks passed.`

| # | Story | What you see |
|---|-------|--------------|
| 1 | Set up | `valet doctor` says **FAIL** while the vault still has a full-access key, **PASS** after lockdown |
| 2 | Normal day | allow-listed vendor is paid 1 NEAR |
| 3 | Bait and switch | the allow-listed vendor upgrades its contract: `CONTRACT_CODE_CHANGED`, a human must confirm |
| 4 | Prompt injection | a poisoned invoice points the agent at `acme-vend0r` (lookalike): refused, nothing signed |
| 5 | Warn | unknown account: human says no, then yes; the payment is only *queued* until the owner approves |
| 6 | Shared blocklist | 3 reporters flagged an account: block, with their evidence URLs in the reasons |
| 7 | Stolen key | the thief skips the wrapper: seven attempts, seven refusals, each with the real error |
| 8 | Kill switch | owner pauses the vault: even the allow-listed vendor is blocked |
| 9 | Audit trail | wrapper log (`demo/out/audit.jsonl`) plus on-chain counters; attackers received 0 NEAR |

## How this covers the security track's requirements

| Requirement | Where | See it |
|-------------|-------|--------|
| allow / warn / block with reasons | oracle `RiskEngine`, `POST /v1/check` ([`packages/oracle`](packages/oracle)) | demo steps 2-6; `reasons` in every response |
| signals: account age and activity, contract and recent code change, prior interactions, shared blocklist with evidence | [Signals](#oracle-signals) | demo steps 3, 5, 6; e2e tests 05, 06, 07 |
| wrapper refuses to sign on `block`, asks the human on `warn` | [`packages/client`](packages/client) `ValetAgent` | demo steps 4-6; no human handler means refuse (`no_human_handler`) |
| agent signs with a function-call key scoped to one contract, never full-access | `add_agent_key` in the guard; `assertSafeKey()`; `doctor` | demo steps 1 and 7; e2e test 04; the client's unit tests for `assertSafeKey` |
| README explains the key's limits | [next section](#the-agents-key-what-it-can-and-cannot-do) | exact error names, measured on the sandbox |
| attack demo with a prompt-injected agent blocked, with the log | demo step 4, step 9 | `docs/demo-output.txt`, `demo/out/audit.jsonl` |

The demo uses a scripted stand-in for the LLM (no model key needed). That is deliberate: the
guard does not rely on the model behaving. Whatever the model decides, the same checks run. To play
the agent yourself in a browser, or to put a real model in front of the same vault, see the next two
sections.

## Try it in your browser: the console

`npm run sandbox` also serves a web page on `127.0.0.1`; the terminal prints its link, which carries
the access token, so open that one. No MCP client and no model key: you play the AI agent with six
buttons and act as the owner with the rest of the page. The buttons run the same `ValetAgent`, with
the same function-call key, oracle and contracts as the demo, on the same local chain. The page adds
no checks of its own: it shows what the guard did and why.

**Nothing to install? Open the replay.** [195440.github.io/valet](https://195440.github.io/valet/)
is this same page playing back a recorded session, with no server behind it (the file is
[`docs/index.html`](docs/index.html); to use it offline, download it with the `fonts/` folder next to
it and open it in a browser). A bar at the bottom tells the story in eleven steps and
can play them for you, or you press the highlighted buttons yourself. It is a recording, not a live
chain. Every reply on it was sent by the real sandbox when the session was recorded
(`npm run replay:record` plays the story against a fresh `npm run sandbox`; `npm run replay:build`
makes the page), and anything but the next recorded step is refused with a message that says so. The
security notes below are about the live console: the replay has no server and no token.

The page takes its look from the hackathon's own site: parchment and ink, square corners,
dot-matrix numerals, IBM Plex Mono, and a light and a dark theme (the moon button). The newest
result is repeated in the top bar, so you see it without scrolling down to the log, and a banner
stays on screen while the vault is paused.

| Button | What happens |
|---|---|
| Pay the vendor | paid: the vendor is on the owner's allow list |
| Poisoned invoice | the agent is told to pay `acme-vend0r` (a lookalike of the real vendor): refused by the oracle, nothing signed |
| A stranger asks for 0.2 NEAR | the oracle says `warn`, so the page **asks you**. No ends it; yes only queues the payment, and the owner side of the page has to approve it before any NEAR moves |
| The 900% APY vault | an account that three people reported, with evidence: refused by the oracle |
| Pay 9 NEAR | the vendor is trusted, but the vault's own cap is 5 NEAR per payment: stopped on-chain, whatever the oracle thinks |
| The agent's key is stolen | a thief who holds only the key skips Valet's software and tries seven things straight on the chain: every one is refused, each with the real error |

The screenshots at the top of this page show the question to the human and the stolen-key story.

The owner side can approve or reject queued payments, pause and unpause the vault (the kill
switch), and edit the allow and deny lists. That is the whole list: it cannot withdraw, change the
policy or touch keys, and the owner's key never leaves the sandbox process.

Because it can approve payments and pause a vault, the console is built to be hard to reach and
hard to abuse:

- It listens on `127.0.0.1` only, on a free port or the one in `VALET_CONSOLE_PORT`. A container
  sets `VALET_CONSOLE_HOST` ([Docker](#with-docker)).
- Every request needs a random token. It appears only in the link the terminal prints, in the
  `#fragment` (which browsers do not send to a server), is removed from the address bar once the
  page has loaded, and travels as a header. The `Host` and `Origin` headers must be the console's
  own, so another web page cannot drive it.
- Bodies are JSON of at most 8 KB. The page's content security policy carries a per-response nonce
  and no `unsafe-inline`; every string the page shows (memos, account ids, reasons) goes in with
  `textContent`. A unit test keeps `innerHTML`, inline handlers and outside requests out of the
  page, and an end-to-end test sends markup as a memo through the real agent.
- An agent's memo is shown as the agent's own words, quoted and labelled untrusted.
- The page loads nothing from the internet. Its three font files are served by the sandbox itself
  (`font-src 'self'`), at those exact paths and nowhere else, and a unit test checks that every
  file the page asks for is one the sandbox hands out.

## Try it with a real agent (MCP)

`npm run sandbox` starts the same local chain, vault and oracle as the demo, but keeps them up, and
`packages/mcp` is an [MCP](https://modelcontextprotocol.io) server (stdio) with three tools,
`valet_pay`, `valet_check` and `valet_status`, for any MCP client that can run one; the sandbox
prints the settings for Claude Code, Cursor, Claude Desktop and Codex.
The agent side holds only the vault's function-call key (`.valet/agent.json`, read by the MCP
server); the sandbox terminal and the [web console](#try-it-in-your-browser-the-console) are the
owner's side (the same commands, one code path), and the owner's key never leaves that process or
touches the disk.

```bash
npm run sandbox      # about 40 seconds until it prints READY; Ctrl-C throws the chain away
```

It prints the exact command that connects your client, with absolute paths, for example for Claude
Code:

```bash
claude mcp add valet -e VALET_CONFIG=<repo>/.valet/agent.json -- \
  <repo>/node_modules/.bin/tsx <repo>/packages/mcp/src/server.ts
```

(and the same as JSON for Cursor, Claude Desktop and Codex). Then ask the agent:

| Ask the agent to ... | What should happen |
|---|---|
| pay 1 NEAR to `acme-vendor.test.near` | paid: the owner allow-listed this vendor |
| pay 1 NEAR to `acme-vend0r.test.near` (what a poisoned invoice would name) | refused before anything is signed: `LOOKALIKE_OF_KNOWN`. The reply tells the model not to retry, split the amount or pick a similar-looking account |
| pay 1 NEAR to `quick-yield-vault.test.near` | refused: `REGISTRY_REPORTS`, three reporters in the shared blocklist |
| pay 9 NEAR to `acme-vendor.test.near` | the vault itself says no, on-chain: `per_tx_cap` (the limit is 5 NEAR), whatever the oracle thinks of the receiver |
| pay 0.2 NEAR to `fresh-vendor.test.near` (a stranger) | the oracle says `warn`, so **you** are asked (an MCP elicitation form, yes or no). No ends it (`user_denied`). Yes only *queues* the payment: type `pending`, then `approve <id>`, in the sandbox terminal |
| (you) type `pause` in the sandbox terminal, then ask for the first payment again | `blocked: paused`, even for the allow-listed vendor. `unpause` undoes it |

`status` in the sandbox terminal, or the `valet_status` tool, shows the balance, the limits and the
counters; `.valet/audit.jsonl` has one JSON line per attempt. What the model reads back is
`key=value` lines with codes and weights, never the oracle's or the reporters' free text.

Two honest notes:

- A client that does not support MCP elicitation cannot ask you, so a `warn` is refused
  (`no_human_handler`) instead of being decided by the model. The owner can allow-list the receiver.
- The server and the sandbox are exercised by a scripted MCP client over real stdio
  (`packages/e2e/test/09-mcp-sandbox.test.ts`), and by the official MCP TypeScript SDK's client
  (`packages/mcp/scripts/sdk-interop.mjs`, run by hand). Claude Code was also run against it with a
  real model, five prompts and all five listed in [`docs/real-agent-run.md`](docs/real-agent-run.md):
  a poisoned invoice, a stranger, the regular vendor, a lookalike account, an over-cap payment. Its
  print mode cannot show the question to a person, so the interactive form was not tried in a
  commercial client. A real model's choices are not scripted: that is why the checks are in the vault
  and not in the model.

Details: [`packages/mcp/README.md`](packages/mcp/README.md).

## Agent Economy: the wallet half

The Agent Economy track (*Give AI a wallet*) asks for agents that earn, spend, negotiate, hire
other agents and pay for things, and its example prompt starts with how the agent holds its keys and
what it cannot do without the owner. Valet is that part: a wallet an agent can really use, with a
budget it cannot exceed.

| The track asks for | What Valet has |
|---|---|
| a wallet the agent can use | real NEAR payments from a vault: the `valet_pay` tool of the MCP server, or `ValetAgent.pay` in your own code |
| everything it spends stays inside the owner's budget | a per-payment cap, a rolling window cap, allow and deny lists and a kill switch, all enforced by the contract; a payment the oracle is unsure about waits in an approval queue for the owner |
| how the agent holds its keys and what it cannot do | [the agent's key](#the-agents-key-what-it-can-and-cannot-do): a function-call key for one method, with the exact error for each forbidden action |
| a receipt for every payment | one JSON line per attempt (receiver, amount, memo, verdict, reasons, transaction hash) and an `EVENT_JSON` log on chain for every outcome |

Not covered: negotiation, hiring other agents or posting jobs on the NEAR AI Agent Market, USDC,
NEAR Intents and Chain Signatures. Payments are plain NEAR transfers on one chain, and nothing here
was run against a live market or a public network.

## The agent's key: what it can and cannot do

The agent's key is a NEAR function-call access key added to the vault account by
`add_agent_key(public_key, allowance)`. NEAR itself restricts such a key, before any contract code
runs. Measured on the sandbox (error names are near-api-js `error.type`):

| What a thief holding only this key tries | What happens |
|---|---|
| transfer NEAR out of the vault account | rejected: `RequiresFullAccess` |
| add or delete an access key | rejected: `RequiresFullAccess` |
| deploy or replace the contract, stake | rejected: `RequiresFullAccess` |
| call `withdraw`, `approve`, `set_policy`, `set_oracle`, `add_agent_key`, `pause` | rejected: `MethodNameMismatch` (the key may only call `pay`) |
| call `pay` on any other contract | rejected: `ReceiverMismatch` |
| attach a deposit | rejected: `DepositWithFunctionCall` |
| call `pay` with no verdict, a forged one, or someone else's | `blocked` on-chain: `attestation_required`, `bad_signature` |
| call `pay` above the per-payment cap or the rolling window cap | `blocked` on-chain: `per_tx_cap`, `window_cap` |

So the worst a stolen key can do is spend up to your caps on receivers the oracle vouched for or
the allow list names, and burn its gas allowance. It cannot touch the rest of the vault, and the
owner can pause the vault or revoke the key at any time.

**The gas allowance can lock the agent out.** A function-call key has a gas allowance. When it
drops below what a call needs, the key stays on the account but every call fails with
`NotEnoughAllowance`. A `pay` call burns about 4.6 TGas, which costs about 0.0003 NEAR, but the
node checks the allowance against the *prepaid* gas at a pessimistic price (30 TGas is about
0.031 NEAR, 20 TGas about 0.021 NEAR) and refunds what is unused. So:

- `ValetAgent` attaches 20 TGas by default, so the key needs at least about 0.021 NEAR of allowance
  to submit anything. The demo gives it 5 NEAR.
- Recovery: the owner calls `revoke_agent_key` and then `add_agent_key` with a fresh allowance
  (adding a key that already exists fails). Demonstrated in e2e test 04.
- A thief can burn the allowance by spamming `pay`. Gas is paid from the vault's balance and the
  allowance is the ceiling, so this locks the agent out and costs the vault up to the allowance in
  fees. Size it for a few weeks of normal use, not more.

## Guard contract (the vault)

[`contracts/guard`](contracts/guard), Rust, near-sdk 5.30. `pay` is the only agent entry point and
runs these checks in order. Refusals are *returned* as `{status: "blocked", reason}` so the audit
trail stays on-chain; only calls from the wrong account panic.

1. `paused`, `zero_amount`, `self_transfer`
2. `per_tx_cap`, `denylisted`, `window_cap` (rolling window in hourly buckets), `insufficient_funds`
3. receiver on the allow list: paid (`via: allowlist`)
4. otherwise an oracle attestation is required: `attestation_required`, `bad_verdict`,
   `bad_reasons`, `no_oracle_configured`, `oracle_key_not_ed25519`, `amount_exceeds_attestation`,
   `attestation_expired`, `nonce_replayed`, `bad_signature_length`, `bad_signature`
5. verdict `allow`: paid; `warn`: queued for the owner (`approve` or `reject`, expires after
   `pending_ttl_ms`; `pending_full` at 20 entries); `block`: `oracle_block`

An attestation is an ed25519 signature over eight lines (`VALET/1`, guard, receiver, max amount,
verdict, expiry, nonce, reasons hash), so it cannot be reused for another receiver, a larger
amount, another vault, or twice.

Owner methods: `approve reject set_policy set_oracle allow unallow deny undeny pause unpause
withdraw add_agent_key revoke_agent_key`. Views: `get_config get_stats get_window_spent
get_pending get_receiver_stats get_allowlist get_denylist is_allowed is_denied`. Every outcome
emits an `EVENT_JSON` log. The contract has no upgrade method: once the full-access keys are
deleted (`doctor` checks this), the code and the rules are final.

[`contracts/registry`](contracts/registry) is the shared blocklist. `report(account_id, category,
evidence_url, note)` needs a 0.01 NEAR deposit (excess refunded), an `https` evidence URL and a
category; one report per reporter and target; `retract` refunds. Reports are advice: the guard
owner's allow list always wins, so nobody can smear a vendor you chose to trust.

## Oracle signals

[`packages/oracle`](packages/oracle). Score below 30 is `allow`, 30 to 69 is `warn`, 70 and above
is `block`; any HARD signal blocks.

| Signal | Weight | Meaning |
|---|---|---|
| `ACCOUNT_NOT_FOUND` | HARD | named receiver does not exist |
| `DENYLISTED` | HARD | on the guard's deny list or the oracle's threat feed |
| `REGISTRY_REPORTS` | +50 / HARD | 2 reporters / 3 or more reporters, with evidence URLs |
| `LOOKALIKE_OF_KNOWN` | +60 | looks like an allow-listed or well-known account (`acme-vend0r`) |
| `NEW_IMPLICIT_ACCOUNT` | +35 | implicit account that is not funded yet |
| `CONTRACT_CODE_CHANGED` | +40, warn floor | contract code differs from the first one the oracle saw |
| `CONTRACT_RECENTLY_DEPLOYED` | +30, warn floor / +10 | code deployed in the last 7 days / 30 days, from the indexer's deployment history, so a swap is caught on first sight |
| `CONTRACT_FULL_ACCESS_KEY` | +25 | a contract that still has a full-access key can be swapped any time |
| `CONTRACT_UNKNOWN` | +15 | contract not in the known set |
| `ACCOUNT_YOUNG` / `ACCOUNT_AGE_UNKNOWN` / `ACCOUNT_OLD` | +25 / +10 / -10 | first seen under 7 days ago / unknown / over 180 days |
| `LOW_ACTIVITY` / `ACTIVE_ACCOUNT` | +10 / -10 | fewer than 5 transactions on record / 1000 or more (unknown adds nothing) |
| `FIRST_TIME_RECEIVER` / `ESTABLISHED_COUNTERPARTY` | +20 / -20 | this vault never paid it / paid it 3 times or more |
| `AMOUNT_ANOMALY` | +15 | more than 5 times the average paid to this receiver |
| `AMOUNT_NEAR_CAP` | +10 | at least 80% of the per-payment cap |
| `ALLOWLISTED` | 0 | on the owner's allow list: allowed, unless the two rows below apply |
| `CONTRACT_CODE_CHANGED`, `THREAT_FEED_ON_ALLOWLIST` on an allow-listed receiver | +40 | the owner's trust is outranked only by a change in what was trusted: a human decides |

Notes that matter when you read the demo output:

- The code baseline is the hash seen first. It is only replaced by `trust-code`, so an upgraded
  contract stays flagged on every payment until a human has reviewed it:
  `npx tsx packages/oracle/src/cli.ts trust-code --receiver <account>`.
- A *warn floor*: the trust signals above (old, busy, paid before) subtract from the score, but
  they cannot cancel evidence that the thing being trusted just changed. `CONTRACT_CODE_CHANGED`
  and a deployment in the last 7 days make the verdict at least `warn`, whatever else adds up.
- Account age, transaction count and deployment history come from the Nearblocks API (v3; the
  testnet's own API when the RPC serves the testnet; optional `NEARBLOCKS_API_KEY`). Answers are
  cached, an unknown answer is scored as unknown, never as good news, and a rate-limited indexer
  never turns into an error. The oracle server answers at once; the command-line `lookup` and
  `check` wait and retry. On a sandbox there is no indexer, so the demo shows
  `ACCOUNT_AGE_UNKNOWN`: [try the real data](#try-the-oracle-on-real-mainnet-accounts).
- Reasons carry evidence (reporters and URLs, baseline and current code hash). Free-text notes from
  reports are never forwarded: they are attacker-controlled.

HTTP: `POST /v1/check` with `{guard, receiver, amount_yocto}`, `GET /v1/pubkey`, `GET /v1/health`,
`GET /v1/reasons/:hash`. It binds to `127.0.0.1` and has no authentication: run it next to the
agent or put your own auth in front. CLI and environment variables: [`packages/oracle/README.md`](packages/oracle/README.md).

## Use it in your own agent

```ts
import { ValetAgent, toolDefinition, handleToolCall } from "@valet/client";

const agent = new ValetAgent({
  guardId: "my-vault.testnet",
  agentKey: process.env.VALET_AGENT_KEY!,          // the function-call key, never in the repo
  rpcUrl: "https://test.rpc.fastnear.com",
  networkId: "testnet",
  oracleUrl: "http://127.0.0.1:8787",
  onWarn: async (ctx) => askTheHuman(ctx),           // without it, `warn` is refused
  auditFile: "./valet-audit.jsonl",
});
await agent.assertSafeKey();   // refuses a full-access key or a key that can call more than `pay`

// plug into any tool-calling LLM
const tool = toolDefinition();                        // OpenAI-style `valet_pay`
const answer = await handleToolCall(agent, { receiver: "vendor.near", amount_near: "1.5" });
```

`handleToolCall` returns short `key=value` lines for the model (`status`, `stage`, `verdict`,
`reason`, `signals`). Evidence text is never included. For an MCP client you do not need to write
any of this: see [Try it with a real agent](#try-it-with-a-real-agent-mcp).

`npm run testnet` does the deployment below on the public testnet ([recorded run](docs/testnet-run.md));
a mainnet deployment is not part of this repository, and no mainnet account was used to build it.
The sequence, all in the contract's own API: deploy `contracts/guard/res/valet_guard.wasm` and call
`new(owner_id, oracle_public_key, policy)` in **one batch transaction** (so nobody can initialize
it first), `add_agent_key`, `allow` your vendors, delete the full-access key of the vault account,
then run `doctor --guard <vault>` and expect `PASS`. The wasm hashes are in `contracts/*/res/*.sha256`;
rebuild with `bash scripts/build-contracts.sh` (Rust and cargo-near 0.22).

## Runtime note

The committed wasm is built with cargo-near 0.22, which emits bulk-memory instructions. Those need
nearcore 2.14 or newer; mainnet runs 2.14.0 and testnet 2.14.1, both on protocol 88 (mainnet
was on 86 on 2026-11-02), read from the RPC `status` method on 2026-11-12. The sandbox package
bundled with `near-workspaces` 5.0 starts nearcore 2.6.2 and fails with `CompilationError:
PrepareError: Deserialization` on the first call, so the e2e package fetches and pins the 2.14.0
binary.

## Known limits

Valet narrows what a hijacked agent can lose. It does not make it zero.

- The oracle is a heuristic. A patient attacker can build a receiver that scores `allow`. That is
  why the on-chain caps exist: they hold no matter what the oracle says.
- Check and execution are separate steps. An attestation lives 120 seconds and is bound to the
  receiver and amount, but a receiver can change in between.
- Failed transfers (for example to an account that was deleted after the check) are not rolled
  back in the vault's counters; the oracle blocks non-existent named accounts first.
- Registry reports are cheap (0.01 NEAR) and can be spammed against strangers; three distinct
  reporters block an account that is not allow-listed. Allow-listed vendors are immune.
- The code baseline is the oracle's own first observation. The indexer's deployment history adds a
  first-sight check for the last 30 days, but it is a third party: if it is down, those signals
  are unknown (age costs +10), and if it lies, the on-chain caps still hold.
- The oracle reads account state at the latest block and key lists at final state; a RPC provider
  you do not control can lie to it. Use your own node for real money.
- The contracts are not audited. They ran on the public testnet ([record](docs/testnet-run.md)) and
  were never deployed to mainnet.
- The chain demo needs a nearcore 2.14 binary: macOS arm64 or Linux (x64, arm64) with glibc 2.39+.
  Anything else uses [Docker](#with-docker). Intel Macs are not supported natively: NEAR's
  macOS x64 build links a Homebrew library that this project does not rely on.

More detail: [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md), [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## What is not here yet

- **Tokens other than NEAR.** The vault holds and pays NEAR. USDC (NEP-141) needs a cap per token, the
  token bound into the signed verdict, and a storage deposit for receivers that are new to the token.
- **Mainnet.** The contracts ran on the public testnet ([record](docs/testnet-run.md)); nothing is
  deployed on mainnet, and no real funds were used anywhere.
- **A harder oracle key.** A TEE, an on-chain quote check or several oracles: what each would change
  is in the [threat model](docs/THREAT-MODEL.md#the-oracle-key-what-would-make-it-harder-to-abuse).
- **Packages.** `@valet/client` and `@valet/mcp` are workspaces of this repository, not on npm yet.

## Repository map

| Path | What |
|---|---|
| `contracts/guard`, `contracts/registry` | Rust contracts; prebuilt wasm and SHA-256 in `res/` next to each |
| `packages/oracle` | risk engine, signer, HTTP server, CLI (`doctor`, `check`, `trust-code`) |
| `packages/client` | `ValetAgent` wrapper, audit log, LLM tool definition |
| `packages/mcp` | MCP server (stdio): `valet_pay`, `valet_check`, `valet_status`, human confirmation by elicitation |
| `packages/e2e` | local-chain harness, end-to-end tests on it, and tests for the sandbox download and for a binary that cannot start |
| `demo` | the scripted attack story (`npm run demo`), the same story on the public testnet (`npm run testnet`), the long-running sandbox with its terminal and web console (`npm run sandbox`; the console is in `demo/src/console`), and the recorder and builder of the static replay page (`demo/src/replay`) |
| `Dockerfile`, `.github/workflows` | the image for any host, and the CI that runs the checks above |
| `docs` | architecture, threat model, recorded demo output, the testnet record, console screenshots, and the replay page (`docs/index.html` with its `fonts/`, built by `npm run replay:build`) |

## Naming

A valet key is the key you hand to a parking attendant: it starts the car and drives it, but it
does not open the trunk or the glovebox. The agent's function-call key is that key for a NEAR
vault: it can call `pay`, and nothing else on the account. (The
[Valet Key pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/valet-key) in
cloud design is the same idea: hand out a limited token, not the master key.)

## AI tools used

This project was written with AI coding agents in Cursor (agent mode). Every claim in this README
is backed by a command above; the tests and the demo are the source of truth, not this text.

## License

MIT, see [`LICENSE`](LICENSE). The console embeds IBM Plex Mono (copyright IBM Corp., under the SIL
Open Font License 1.1, [`demo/src/console/fonts/OFL.txt`](demo/src/console/fonts/OFL.txt)),
converted to WOFF2 with every glyph kept.
