# Valet on the public NEAR testnet

On 2026-11-12 the nine steps of [`npm run demo`](../README.md#what-npm-run-demo-shows) were run again
on the **public NEAR testnet**: real accounts, both contracts deployed from the wasm committed in
this repository, an oracle that reads the testnet's own account history, and an explorer link for
every step that reached the chain. You do not have to take this page's word for any of it: the
[last section](#check-it-yourself) reads the same facts off the chain, with no account, no key and
no funds.

| | |
|---|---|
| Command | `npm run testnet` (about 3 minutes, testnet only) |
| Ran | 2026-11-12, 03:43 to 03:46 UTC |
| Network | NEAR testnet (nearcore 2.14.1, protocol 88) through `https://test.rpc.fastnear.com` |
| Owner account | `valet-22b84c43.testnet`, made by the public testnet faucet with 10 NEAR |
| Result | 0 NEAR reached the attackers; the script's 30 checks passed. The raw console output is [`testnet-output.txt`](testnet-output.txt) |

`npm run testnet` asks the faucet for **one** new account and builds everything else under it. Names
are random on every run, the keys are generated for the run and kept in
`.valet/testnet/<account>/keys.json` (mode 0600, git-ignored). `npm run testnet -- --rehearsal` runs
the same script on a local chain, with no network and no faucet.

## The record

### Accounts

| Role | Account | Note |
|---|---|---|
| owner (the human) | [`valet-22b84c43.testnet`](https://testnet.nearblocks.io/address/valet-22b84c43.testnet) | holds the faucet's NEAR and the full-access key; signs the owner's transactions |
| vault (guard contract) | [`vault.valet-22b84c43.testnet`](https://testnet.nearblocks.io/address/vault.valet-22b84c43.testnet) | no full-access key: the agent's function-call key is the only one |
| registry | [`registry.valet-22b84c43.testnet`](https://testnet.nearblocks.io/address/registry.valet-22b84c43.testnet) | shared blocklist; sealed, its only key is deleted |
| vendor | [`acme-vendor.valet-22b84c43.testnet`](https://testnet.nearblocks.io/address/acme-vendor.valet-22b84c43.testnet) | on the owner's allow list |
| lookalike | [`acme-vend0r.valet-22b84c43.testnet`](https://testnet.nearblocks.io/address/acme-vend0r.valet-22b84c43.testnet) | one character off the vendor |
| stranger | [`fresh-vendor.valet-22b84c43.testnet`](https://testnet.nearblocks.io/address/fresh-vendor.valet-22b84c43.testnet) | unknown to the oracle |
| reported vault | [`quick-yield-vault.valet-22b84c43.testnet`](https://testnet.nearblocks.io/address/quick-yield-vault.valet-22b84c43.testnet) | reported three times in the registry |
| attacker | [`attacker.valet-22b84c43.testnet`](https://testnet.nearblocks.io/address/attacker.valet-22b84c43.testnet) | where the thief wants the money to go |
| reporter 1 | [`witness1.valet-22b84c43.testnet`](https://testnet.nearblocks.io/address/witness1.valet-22b84c43.testnet) | files a report with 0.01 NEAR deposit |
| reporter 2 | [`witness2.valet-22b84c43.testnet`](https://testnet.nearblocks.io/address/witness2.valet-22b84c43.testnet) | files a report with 0.01 NEAR deposit |
| reporter 3 | [`witness3.valet-22b84c43.testnet`](https://testnet.nearblocks.io/address/witness3.valet-22b84c43.testnet) | files a report with 0.01 NEAR deposit |

### Contract code

| Contract | Account | Code hash on the chain (sha-256) | Checksum in this repository | Same |
|---|---|---|---|---|
| guard (the vault) | [`vault.valet-22b84c43.testnet`](https://testnet.nearblocks.io/address/vault.valet-22b84c43.testnet) | `06516ce0dee649943d3b80c747b977dbabf83b9598c998f801280117f794e04e` | `06516ce0dee649943d3b80c747b977dbabf83b9598c998f801280117f794e04e` | yes |
| registry | [`registry.valet-22b84c43.testnet`](https://testnet.nearblocks.io/address/registry.valet-22b84c43.testnet) | `9e3aa418792881ef33a5a13ac74cb54584e0d459f545263970b52106a7b8bb62` | `9e3aa418792881ef33a5a13ac74cb54584e0d459f545263970b52106a7b8bb62` | yes |

The chain stores the same 32 bytes in base58 (`RfTdYmBMwMr2SMHiVkyJVVDojeZVx2Q386fsd5YDwG1` for the vault, `BefHAMWU2fcWztrCzpoazqge14jbc3ey6AciKDwF2rth` for the registry), which is what an explorer shows.

### What happened

| # | Story | What was tried | What the system did | Transactions |
|---|---|---|---|---|
| 1 | Set up | the owner funds two new accounts, `registry` and `vault`; each deploys its contract and initialises it in one transaction; the owner adds the agent's function-call key to the vault; the vault's own full-access key is deleted; the owner allow-lists the vendor | `valet doctor` fails while that full-access key is still on the vault and passes after it is deleted; the registry has no key left at all | [deploy registry](https://testnet.nearblocks.io/txns/KH6pWpZUdzBBhMvL2JmocX1mvCUTsKitSMVee2SGtbq)<br>[deploy vault](https://testnet.nearblocks.io/txns/HMqsbhSnLnbXu2iBcw3vvtkzq7mZ2p1UKgkdjirwmBv7)<br>[add the agent's key](https://testnet.nearblocks.io/txns/4a8bgxHjLsyG2fZNYS3RYo1qsmmJFqnWhZVMnzk5Cji8)<br>[delete the full-access key](https://testnet.nearblocks.io/txns/yL9ZChJs36bRUZByQKntvXsroJx7DjQijKduy7KabZX)<br>[allow-list the vendor](https://testnet.nearblocks.io/txns/75QZySkdKW7qLHEGg8YS7yrXv9gSEwjNwAt3xwiuPV6Z) |
| 2 | Normal day | the agent pays the allow-listed vendor 1 NEAR | paid; the vendor is on the owner's allow list, so the vault pays without needing the oracle's signature (the oracle was asked anyway and said `allow`) | [pay](https://testnet.nearblocks.io/txns/6hXfX8aRrP8yjWceq8Ya8AjSwJotQJC4pzpE6FTaWJB6) |
| 3 | Prompt injection | a poisoned invoice tells the agent to pay `acme-vend0r`, one character off the real vendor | refused by the oracle (`LOOKALIKE_OF_KNOWN`) before anything was signed; the lookalike received 0 NEAR | none: nothing reached the chain |
| 4 | Warn, human says no | the agent offers a stranger 0.2 NEAR | the oracle said warn (FIRST_TIME_RECEIVER, ACCOUNT_YOUNG); the human answered no, nothing was signed | none: nothing reached the chain |
| 5 | Warn, human says yes | the same payment again; this time the human agrees | queued on-chain, no money moved; then the owner approved it in a second transaction and the vault paid 0.2 NEAR | [queue](https://testnet.nearblocks.io/txns/G4SwHXabFdUxHZtb37PQEyoH6MbWsRnqmqy1sEvH8AE6)<br>[owner approves](https://testnet.nearblocks.io/txns/GD6GrapZAsQbpdKKfLu1arSKdBege9s4M9DpRghmZVJs) |
| 6 | Shared blocklist | three accounts file a report on `quick-yield-vault` in the registry; the agent is then told to pay it 2 NEAR | refused by the oracle (`REGISTRY_REPORTS`, with the three evidence links in the reasons); it received 0 NEAR | [report 1](https://testnet.nearblocks.io/txns/J469p3Tkafuupzuf3GJjdcELbKkaHCdpWGX4qrdRLXh2)<br>[report 2](https://testnet.nearblocks.io/txns/2AvhgbtF6kVT4zFJeCjsjKqJCv8bHPsMArc31PtAGeDp)<br>[report 3](https://testnet.nearblocks.io/txns/AJhHKwJtQuprJeyETyXxP7HKDfUhU4QkjxjLnz4AfHMn) |
| 7 | Over the cap | the agent pays the allow-listed vendor 9 NEAR; the cap is 5 NEAR per payment | stopped by the vault contract (`per_tx_cap`), whatever the oracle thinks of the vendor | [pay 9 NEAR](https://testnet.nearblocks.io/txns/GjMsKe4gHXhBdDMZTfK3jngQRR35pqtyg5MvxQtK6Jch) |
| 8 | Stolen key | a thief with only the function-call key tries 7 things straight on the chain | all 7 refused: the vault answers `attestation_required`, `bad_signature` and `per_tx_cap` on-chain; the protocol refuses transfers, `withdraw` and new keys before they reach a block (those never get a transaction) | [pay the attacker, no oracle verdict](https://testnet.nearblocks.io/txns/D51wmnTgjneHgNvFrv3QpBfFbNrui5NfKiudGHCUcZag)<br>[pay the attacker, self-signed 'allow' verdict](https://testnet.nearblocks.io/txns/EfgaB3oVKJaKK2dsfuDGEJSKP8DjX3vEzRDWUZALNBGo)<br>[pay the attacker, replay the vendor's real verdict](https://testnet.nearblocks.io/txns/2XzuubJAz7B59PTrEefjwEEeR2S8TCufiiTwCemYCNt5)<br>[pay the allow-listed vendor 9 NEAR (cap is 5)](https://testnet.nearblocks.io/txns/GD37Fncx3DhdxAcZfMHZJKwZ4GHuweJpk9sjDzieER3B) |
| 9 | Kill switch | the owner pauses the vault; the agent pays the allow-listed vendor 0.5 NEAR; the owner unpauses; the agent pays again | while paused the vault blocked even the allow-listed vendor (`paused`); after the unpause the same payment went through | [pause](https://testnet.nearblocks.io/txns/AofvjsoKyLhYiMKYPRguFURxd7rSr1PbTK7djbPYqVZo)<br>[pay while paused](https://testnet.nearblocks.io/txns/BifEvb7wVkAikLaZWWD5RwC8LsimXvPacmkuASt6naMy)<br>[unpause](https://testnet.nearblocks.io/txns/BA7n9ZWNFo8XGcczBWdh8YpHRQtFx9vc7G6Xqkym6j6o)<br>[pay after unpause](https://testnet.nearblocks.io/txns/37unbhNcRBhQWqn4vnZEBjVwqjS2AKrZXeMufBzfBMuK) |

### What the vault returned

The explorer shows the refused payments as *successful* transactions. That is on purpose: the vault
does not revert a refused `pay`, it returns `{"status":"blocked","reason":"..."}` and counts it, so
every attempt shows up in the vault's own counters (`blocked: 6` after this run). Read from the
chain, what each `pay` and `approve` above returned:

| Transaction | Returned by the vault |
|---|---|
| [Normal day: the agent pays the vendor 1 NEAR](https://testnet.nearblocks.io/txns/6hXfX8aRrP8yjWceq8Ya8AjSwJotQJC4pzpE6FTaWJB6) | `{"status":"paid","reason":"allowlist"}` |
| [Warn: the agent's payment is queued](https://testnet.nearblocks.io/txns/G4SwHXabFdUxHZtb37PQEyoH6MbWsRnqmqy1sEvH8AE6) | `{"status":"queued","reason":"oracle_warn","pending_id":"1"}` |
| [Warn: the owner approves it](https://testnet.nearblocks.io/txns/GD6GrapZAsQbpdKKfLu1arSKdBege9s4M9DpRghmZVJs) | `{"status":"paid","reason":"owner_approval","pending_id":"1"}` |
| [Over the cap: 9 NEAR to the vendor](https://testnet.nearblocks.io/txns/GjMsKe4gHXhBdDMZTfK3jngQRR35pqtyg5MvxQtK6Jch) | `{"status":"blocked","reason":"per_tx_cap"}` |
| [Stolen key: pay the attacker, no oracle verdict](https://testnet.nearblocks.io/txns/D51wmnTgjneHgNvFrv3QpBfFbNrui5NfKiudGHCUcZag) | `{"status":"blocked","reason":"attestation_required"}` |
| [Stolen key: pay the attacker, self-signed 'allow' verdict](https://testnet.nearblocks.io/txns/EfgaB3oVKJaKK2dsfuDGEJSKP8DjX3vEzRDWUZALNBGo) | `{"status":"blocked","reason":"bad_signature"}` |
| [Stolen key: pay the attacker, replay the vendor's real verdict](https://testnet.nearblocks.io/txns/2XzuubJAz7B59PTrEefjwEEeR2S8TCufiiTwCemYCNt5) | `{"status":"blocked","reason":"bad_signature"}` |
| [Stolen key: pay the allow-listed vendor 9 NEAR (cap is 5)](https://testnet.nearblocks.io/txns/GD37Fncx3DhdxAcZfMHZJKwZ4GHuweJpk9sjDzieER3B) | `{"status":"blocked","reason":"per_tx_cap"}` |
| [Kill switch: pay while paused](https://testnet.nearblocks.io/txns/BifEvb7wVkAikLaZWWD5RwC8LsimXvPacmkuASt6naMy) | `{"status":"blocked","reason":"paused"}` |
| [Kill switch: pay after the unpause](https://testnet.nearblocks.io/txns/37unbhNcRBhQWqn4vnZEBjVwqjS2AKrZXeMufBzfBMuK) | `{"status":"paid","reason":"allowlist"}` |

Three of the stolen-key attempts have no row because they never reached a block: NEAR itself refuses
a plain transfer, a `withdraw` call and a new full-access key from a function-call key that may only
call `pay` on the vault (`RequiresFullAccess`, `MethodNameMismatch`). The payments the wrapper
refused (the lookalike, the stranger the human turned down, the reported account) never reached the
chain either: the oracle's reasons for them are in [`testnet-output.txt`](testnet-output.txt).

### Where the chain stood right after the run

| Account | NEAR | Why |
|---|---|---|
| vault | 3.68 | started with 5.38, paid out 1.7 (1 + 0.2 + 0.5) |
| vendor | 1.5 | the 1 NEAR and the 0.5 NEAR payments |
| stranger | 0.2 | the payment the human agreed to and the owner approved |
| attacker, lookalike, reported vault | 0 | nothing was ever sent to them |

The vault has exactly one access key: a function-call key that can only call `pay` on the vault
itself. The registry has none. The vault's counters: `{"paid":3,"queued":1,"blocked":6,"approved":1,"rejected":0,"total_paid":"1700000000000000000000000"}`.

## Check it yourself

Everything below is read-only. It needs `npm ci` once and no account, key or funds. The oracle's
account-history lookups ask the testnet's Nearblocks API, which is rate limited without a key: the
commands wait and retry.

```bash
R=valet-22b84c43.testnet
RPC=https://test.rpc.fastnear.com
```

**The vault has no full-access key.** Expect one key and `PASS`:

```bash
npx tsx packages/oracle/src/cli.ts doctor --guard vault.$R --rpc $RPC
```

```
ed25519:DAdsPhnfd7GSdQgdXfr4nd5JaC5XNVdZZnDLm3vjcnDK	PASS	-
PASS
```

**The code on the vault is the wasm of this repository.** The two lines must be identical. (For the
registry, use the account `registry.$R` and `contracts/registry/res/valet_registry.wasm`.)

```bash
# the code hash on the chain
curl -s $RPC -H 'content-type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"vault.$R\"}}" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).result.code_hash))'
# the same hash, computed from the wasm in this repository
npx tsx -e 'import { createHash } from "node:crypto"; import { readFileSync } from "node:fs"; import { base58Encode } from "./packages/oracle/src/base58.ts"; console.log(base58Encode(createHash("sha256").update(readFileSync("contracts/guard/res/valet_guard.wasm")).digest()))'
```

```
RfTdYmBMwMr2SMHiVkyJVVDojeZVx2Q386fsd5YDwG1
RfTdYmBMwMr2SMHiVkyJVVDojeZVx2Q386fsd5YDwG1
```

**The vault's own counters:**

```bash
curl -s $RPC -H 'content-type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"vault.$R\",\"method_name\":\"get_stats\",\"args_base64\":\"e30=\"}}" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(Buffer.from(JSON.parse(s).result.result).toString()))'
```

```
{"paid":3,"queued":1,"blocked":6,"approved":1,"rejected":0,"total_paid":"1700000000000000000000000"}
```

**The oracle's verdicts on the same accounts.** The reported vault, read with the registry that holds
the three reports (add `--json` to see the three evidence links):

```bash
VALET_REGISTRY_ID=registry.$R npx tsx packages/oracle/src/cli.ts lookup quick-yield-vault.$R --rpc $RPC
```

```
quick-yield-vault.valet-22b84c43.testnet: block (score 100)
  [+100] REGISTRY_REPORTS: 3 distinct reporters flagged this account
  [+25] ACCOUNT_YOUNG: Account first seen within the last 7 days
```

and the lookalike, as the vault would see it (`check` signs a verdict and prints it; it sends nothing
to the chain and writes an oracle key to `.valet/oracle-key.json` if you have none):

```bash
VALET_REGISTRY_ID=registry.$R npx tsx packages/oracle/src/cli.ts check --guard vault.$R --receiver acme-vend0r.$R --amount 4 --rpc $RPC
```

```
Verdict: block  Score: 100
  [+60] LOOKALIKE_OF_KNOWN: Receiver resembles trusted account acme-vendor.valet-22b84c43.testnet
  [+20] FIRST_TIME_RECEIVER: No prior payments from this guard to this receiver
  [+25] ACCOUNT_YOUNG: Account first seen within the last 7 days
  [+10] AMOUNT_NEAR_CAP: Amount is at least 80% of guard per-transaction cap
```

These read live data, so they drift: `ACCOUNT_YOUNG` stops firing a week after the accounts were
made on 2026-11-12, and the score then falls by 25.

## What this does not show

- **It is the testnet.** Nothing is deployed on mainnet, and the contracts are not audited. Testnet
  state is not guaranteed forever: if an explorer ever stops showing these accounts, this page and
  [`testnet-output.txt`](testnet-output.txt) are what is left of the record.
- **The agent is the script.** It calls `ValetAgent.pay` the way a model's tool call would. How a
  real model behaved against the same vault, on a local chain, is in [`real-agent-run.md`](real-agent-run.md).
- **The oracle runs on the developer's machine**, as a process on `127.0.0.1` with a key made for
  the run. Where the oracle runs and how its key is kept is the weakest part of the design: see the
  [threat model](THREAT-MODEL.md).
- **One person made every account**, the three reporters included. The registry cannot tell three
  reporters from one person with three accounts: that is the spam limit listed in the README's
  "Known limits".
