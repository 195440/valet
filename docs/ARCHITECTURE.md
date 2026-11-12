# Architecture

Valet has four parts. Only the first one has to be trusted with money; the others make it
usable and make the dangerous cases visible.

```
 human owner ──(owner key, offline)──────────────┐ approve / reject / policy / pause / keys
                                                 v
 LLM agent ──> ValetAgent ──pay(receiver, amount, attestation)──> guard contract ──> receiver
                  |   ^        signed with the function-call key      |  (vault)
                  |   |                                               | views: allow/deny lists,
        POST /v1/check|signed verdict + reasons                       | stats, config, pending
                  v   |                                               |
               oracle ──reads──> NEAR RPC ──> accounts, keys, code    |
                  |                                                   |
                  └──reads──> registry contract (reports + evidence) ─┘
```

| Part | Where | Trust it needs |
|---|---|---|
| guard contract (vault) | `contracts/guard` | holds the funds and enforces the rules; this is the part that must be right |
| registry contract | `contracts/registry` | advice only; the guard never reads it |
| oracle | `packages/oracle` | signs verdicts; its key is set by the owner (`set_oracle`) and can be rotated |
| wrapper | `packages/client` | convenience and audit; the guard does not rely on it |
| MCP server | `packages/mcp` | exposes the wrapper to AI clients as three tools; asks the human through MCP elicitation |
| console | `demo/src/console` | a web page for the sandbox: plays the agent through the same wrapper and acts as the owner with the terminal's commands; trusts nothing it shows |

## One payment, step by step

1. The model calls the `valet_pay` tool (or the app calls `agent.pay`).
2. `ValetAgent` asks the oracle `POST /v1/check {guard, receiver, amount_yocto}`. The oracle reads
   the chain and answers `allow`, `warn` or `block`, a score, the list of reasons, and an
   attestation: an ed25519 signature over the verdict, receiver, maximum amount, expiry and a
   random nonce.
3. `block` ends here: nothing is signed, nothing is sent. `warn` calls `onWarn`; with no handler
   or a "no" it ends here as well (`no_human_handler` or `user_denied`). `allow` and an approved
   `warn` continue. Behind the MCP server, `onWarn` is an elicitation request to the client's
   user; a client that cannot show one counts as no handler.
4. The wrapper signs `pay(receiver_id, amount, attestation)` with the function-call key
   (20 TGas, no deposit) and sends it.
5. The guard runs its own checks on-chain (see the README). It does not trust steps 2 to 4: a thief
   who skips them hits the same checks and has no valid attestation.
6. On `allow` the guard transfers; on `warn` it stores a pending payment that only the owner can
   `approve` or `reject` (it expires after `pending_ttl_ms`); on a policy refusal it returns
   `{status: "blocked", reason}` and logs the reason.
7. The wrapper reads the result and the `EVENT_JSON` logs and appends one JSON line to the audit
   file (`ts, guard, receiver, amount_yocto, memo, status, stage, verdict, score, reasons, reason, pending_id, tx_hash`).

On-chain, an allow-listed receiver needs no attestation: the owner already vouched for it. The
wrapper still asks the oracle first, so a changed contract or a threat-feed hit on an allow-listed
receiver reaches the human as a `warn`.

## Attestation message

Both sides build the same eight lines, joined by `\n`, no trailing newline, and the guard checks
the signature with the `ed25519_verify` host function:

```
VALET/1
guard=<vault account>
receiver=<receiver account>
max_amount=<yoctoNEAR, decimal>
verdict=<allow|warn|block>
expires_ms=<unix ms>
nonce=<u64, decimal>
reasons=<sha-256 of the canonical reasons JSON, 64 hex chars, or "0">
```

The vault id binds it to one vault, the receiver and `max_amount` to one payment, the expiry to a
short window (120 seconds by default) and the nonce to a single use. The guard keeps every used
nonce (a few dozen bytes each, paid from the vault's balance). `reasons` is the hash of what the
oracle showed, so the audit log can prove which reasons a verdict was based on
(`GET /v1/reasons/:hash` returns them from a small in-memory cache).

## Guard state

| State | Purpose |
|---|---|
| `owner_id`, `oracle_pk`, `policy` | who decides, which oracle key is accepted, the limits |
| `allow`, `deny` | owner lists, mutually exclusive |
| `buckets` | amount paid per hour, summed over `window_hours` (1 to 72), pruned lazily |
| `nonces` | used attestation nonces |
| `pending` | up to 20 queued `warn` payments with their expiry |
| `receivers` | per-receiver paid count and total, the oracle's "prior interactions" signal |
| `stats`, `paused` | counters and the kill switch |

The vault keeps 0.05 NEAR in reserve: a payment that would eat into it fails with
`insufficient_funds`. `add_agent_key` and `revoke_agent_key` are Promises the contract sends to its
own account (an account may change its own keys), restricted to the owner.

## Oracle pipeline

`RiskEngine.evaluate` in order: read the guard config and lists; threat feed; account state; then
for a receiver that is not allow-listed the registry reports, lookalike check, receiver history,
contract checks and account age; the amount against the cap. Signals add up to a score. Any HARD
signal blocks. Thresholds: `VALET_ALLOW_BELOW` (30) and `VALET_BLOCK_FROM` (70).

State it keeps: one file with the code-hash baselines (`.valet/codehash-cache.json`, or
`$VALET_CODEHASH_CACHE`) and its signing key (`.valet/oracle-key.json`, or `ORACLE_PRIVATE_KEY`).
Both are created with mode 0600 and are git-ignored.

Reads: guard and registry views and account state use the latest block (a risk check should see
an upgrade made seconds ago); key lists use final state.

## Wrapper

`ValetAgent` holds one secret, the function-call key, in a private in-memory key store that
contains nothing else. Before use, `assertSafeKey()` reads the vault's access keys and refuses
anything except a function-call key restricted to `pay` on the vault itself. `pay()` returns a
`PayResponse` with a status:

| `status` | `stage` | Meaning |
|---|---|---|
| `refused` | `oracle` | verdict `block`; reason is the list of signal codes |
| `refused` | `user` | `warn` and no handler (`no_human_handler`) or a "no" (`user_denied`) |
| `paid`, `queued` | `chain` | the guard paid, or queued it for the owner |
| `blocked` | `chain` | the guard refused; `reason` is its reason code |
| `error` | `chain` | the transaction failed (for example `NotEnoughAllowance`) |

## Console

`npm run sandbox` also starts `demo/src/console`: a loopback HTTP server and one page. It has no
rules about money of its own. A story button calls `ValetAgent.pay`, the wrapper the MCP server
uses, and a `warn` becomes a question in the page where the MCP server would send an elicitation.
The owner side calls `Owner` (`demo/src/owner.ts`), the code behind the terminal's `pending`,
`approve`, `pause` and `allow` commands, so the page and the terminal cannot disagree. The stolen-key
story goes straight at the chain with a second signer that holds only the function-call key, like the
thief in the end-to-end tests. Calls that sign wait in one queue per signer (the agent's, the
owner's), so two clicks cannot race on a nonce. The server's rules (token, `Host` and `Origin`,
size limit, CSP, the list of owner commands) are in [THREAT-MODEL.md](THREAT-MODEL.md).

## Test harness

`packages/e2e` starts a real `near-sandbox` (nearcore 2.14.0), deploys the committed wasm and drives
it with the same code paths as production: the `ValetAgent` for the happy and warn paths and a
second signer that holds only the function-call key (`fx.raw`) to play a thief that skips the
wrapper. The fixture can delete the vault's full-access keys in one transaction (`lockDownGuard`),
which is what makes the vault immutable and what `doctor` checks.

## Decisions

- **Function-call key plus vault contract**, not a multisig or MPC. The protocol itself already
  refuses everything except one method on one contract, before any code runs, and there is no
  extra key infrastructure to get wrong.
- **Signed attestations**, not an on-chain oracle call. Checks stay cheap and the oracle can use
  RPC, an indexer and local files; the contract only verifies a signature and the bound fields.
- **`warn` is queued on-chain**, not only handled in the wrapper, so a stolen key cannot answer
  "yes" for the human.
- **The allow list outranks the registry.** Reports cost 0.01 NEAR, so they are advice. Allow-listed
  receivers lose that protection only through a change in what was trusted (new code, threat feed).
- **Refusals are returned, not panicked**, so the reason and the event stay on-chain.
- **The console is a client, not part of the trust base.** It can send eight owner commands
  (approve, reject, pause, unpause, allow, unallow, deny, undeny) and cannot withdraw, change the
  policy or touch keys; everything it displays is data from the chain, the oracle or the agent, and
  goes into the page as text.
