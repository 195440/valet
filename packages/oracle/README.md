# @valet/oracle

Off-chain risk oracle for [Valet](../../README.md). It evaluates `(guard, receiver, amount)` against
on-chain signals and returns `allow`, `warn` or `block` with reasons and an ed25519 attestation
the guard contract verifies. The signals and thresholds are in the
[top-level README](../../README.md#oracle-signals).

## HTTP API

Binds to `127.0.0.1` by default. There is no authentication or rate limit: run it next to the agent
or put your own auth in front.

- `POST /v1/check` with `{ guard, receiver, amount_yocto, agent?, context? }` returns
  `{ verdict, score, reasons, reasons_hash, attestation, evaluated_at_ms, oracle_public_key }`
- `GET /v1/health`
- `GET /v1/pubkey`
- `GET /v1/reasons/:hash` resolves a recent reasons hash (in-memory cache of the last 500)

## CLI

```bash
npx tsx src/cli.ts pubkey                                           # the key to pass to the guard's set_oracle
npx tsx src/cli.ts lookup wrap.near [--amount 1] [--rpc url] [--json]   # counterparty check, no vault needed (from the repo root: npm run lookup -- wrap.near)
npx tsx src/cli.ts check --guard g.near --receiver wrap.near --amount 0.1 [--rpc url] [--json]
npx tsx src/cli.ts serve --port 8787 [--rpc url]
npx tsx src/cli.ts doctor --guard g.near [--rpc url]                # PASS/FAIL: no full-access key, only `pay` for the agent
npx tsx src/cli.ts trust-code --receiver vendor.near [--rpc url]    # accept the receiver's current contract code
```

`trust-code` is the human step after a `CONTRACT_CODE_CHANGED` flag: review the new contract, then
accept it as the new baseline. Until then the receiver keeps being flagged on every check.

## Environment

| Variable | Default |
|----------|---------|
| `NEAR_RPC_URL` | `https://free.rpc.fastnear.com` (mainnet; `https://test.rpc.fastnear.com` is the testnet's) |
| `ORACLE_KEY_FILE` | `.valet/oracle-key.json` (created with mode 0600 on first use) |
| `ORACLE_PRIVATE_KEY` | base64 ed25519 seed; overrides the key file |
| `VALET_CODEHASH_CACHE` | `.valet/codehash-cache.json` (code baselines) |
| `VALET_ALLOW_BELOW` | `30` |
| `VALET_BLOCK_FROM` | `70` |
| `VALET_THREAT_FEED` | path to a JSON array of `{ account_id, note, source? }` |
| `VALET_REGISTRY_ID` | account of the report registry contract (none: no registry signals) |
| `NEARBLOCKS_API_KEY` | optional; account age, transaction count and deployment history come from the Nearblocks API (the free tier is rate limited) |
| `VALET_NEARBLOCKS_URL` | API root of the account-history indexer, with its version. Default: picked from the chain the RPC serves, `https://api.nearblocks.io/v3` for mainnet and `https://api-testnet.nearblocks.io/v3` for the testnet |
| `VALET_SKIP_NEARBLOCKS` | set to skip the age lookup (age stays unknown) |
| `VALET_CORS_ORIGIN` | optional CORS origin |

Everything under `.valet/` is git-ignored.

## Development

```bash
npm test                         # 55 unit tests, no network
npm run typecheck
npx tsx scripts/live-smoke.ts    # read-only check against mainnet RPC
```
