# @valet/mcp

An [MCP](https://modelcontextprotocol.io) server (stdio) that lets an AI agent pay from a Valet
vault. The agent behind the MCP client holds only the vault's function-call key. Every payment goes
through the oracle's risk check and the vault's on-chain limits, and a `warn` is put to the human.

No dependencies besides the other Valet packages: the protocol layer (`src/protocol.ts`) is about
250 lines of JSON-RPC.

## Run it

Against the local sandbox (`npm run sandbox` prints the exact command for your client):

```bash
claude mcp add valet -e VALET_CONFIG=/path/to/valet/.valet/agent.json -- \
  /path/to/valet/node_modules/.bin/tsx /path/to/valet/packages/mcp/src/server.ts
```

Other clients (Cursor, Claude Desktop, Codex) take the same thing as JSON:

```json
{
  "mcpServers": {
    "valet": {
      "command": "/path/to/valet/node_modules/.bin/tsx",
      "args": ["/path/to/valet/packages/mcp/src/server.ts"],
      "env": { "VALET_CONFIG": "/path/to/valet/.valet/agent.json" }
    }
  }
}
```

## Settings

A JSON file named by `VALET_CONFIG`, and/or environment variables. Variables win over the file.
Unknown fields in the file are ignored.

| Variable | File field | Meaning |
|---|---|---|
| `VALET_RPC_URL` | `rpcUrl` | NEAR RPC endpoint (required) |
| `VALET_GUARD_ID` | `guardId` | the vault account (required) |
| `VALET_AGENT_KEY` | `agentKey` | the agent's function-call key, `ed25519:...` (required, a secret) |
| `VALET_ORACLE_URL` | `oracleUrl` | the oracle's HTTP endpoint (required) |
| `VALET_NETWORK_ID` | `networkId` | label for the key store, default `sandbox` |
| `VALET_AUDIT_FILE` | `auditFile` | append one JSON line per payment attempt |
| `VALET_ASK_TIMEOUT_MS` | | how long to wait for the human's answer, default 120000 |

## Tools

| Tool | What it does | Read-only |
|---|---|---|
| `valet_pay(receiver, amount_near, memo?)` | oracle check, then (if allowed) `pay` on the vault | no |
| `valet_check(receiver, amount_near)` | the oracle's verdict, score and signal codes; nothing is signed or sent | yes |
| `valet_status()` | balance, caps, spent in the window, counters, paused, pending approvals | yes |

A payment ends as `paid`, `queued` (held for the owner), `blocked` (the vault said no, with its
reason), `refused` (the oracle or the human said no, nothing was signed) or `error`. What the model
reads is `key=value` lines: status, stage, verdict, score, reason code, signal codes with weights.
The oracle's sentences and the registry's evidence text stay out of the model's context, because a
third party wrote them. Refusals come with an instruction not to retry, split the amount or pick a
similar-looking account; that is only a hint to the model, the vault enforces the limits either way.

## How `warn` is handled

The oracle says `warn` for receivers it cannot vouch for. Valet does not let the model decide that:

- If the client declared the MCP **elicitation** capability, the server sends it a yes/no form with
  the receiver, the amount, the signal codes and sentences, and the agent's memo (quoted, labelled
  as the agent's). Only an explicit yes counts. Decline, cancel, a malformed answer, an error or
  no answer within `VALET_ASK_TIMEOUT_MS` all mean no. The answer comes from the client's UI,
  not from the model.
- If the client has no such capability, the payment is refused with `no_human_handler`. Nothing is
  signed. The owner can allow-list the receiver.
- A yes does not send money: the payment lands in the vault's approval queue, and the owner
  approves it there (`approve <id>` in the sandbox console).

## Safety properties

- The server refuses to start (exit code 1) unless `assertSafeKey()` passes: the configured key must
  exist on the vault, be a function-call key, limited to the vault account and to the method `pay`.
- Payments are serialized: they share one access key, and two in flight would race on its nonce.
- stdout carries protocol messages only. Anything else written to stdout (near-api-js logs
  receipts with `console.log`) is rerouted to stderr before any other module loads.
- Error messages about the settings file never quote it: it holds the agent's key.
- Over-long lines (more than 1 MB) are dropped; malformed JSON gets a JSON-RPC parse error.
- The receiver must be a valid NEAR account id (2 to 64 characters, lowercase letters, digits, `-`,
  `_`, `.`) before anything is asked or signed; the error does not echo what it was given.
- What the model wrote (the memo, the receiver) is flattened to one line, stripped of control and
  direction-switching characters, and the memo is JSON-quoted, before a person sees it: it cannot
  pass for a line of the oracle's own.

## Tests

`npm test -w @valet/mcp` runs 45 unit tests (protocol, tools, settings, line reader, stdout guard,
status). `packages/e2e/test/09-mcp-sandbox.test.ts` starts the real sandbox and the real server as
child processes and drives them over stdio: allow, refuse, human yes and no, owner approval, kill
switch, fail-closed startup, audit log. It uses a scripted MCP client.

`scripts/sdk-interop.mjs` is an independent check that is not part of `npm test`: the official MCP
TypeScript SDK's client (1.32.2 when last run) connects to the server, lists the tools, makes
payments and answers the elicitation question. The SDK is not a dependency of this repository:

```bash
npm run sandbox                                   # terminal 1
npm install --no-save @modelcontextprotocol/sdk   # terminal 2
node packages/mcp/scripts/sdk-interop.mjs
```

Claude Code (print mode, a real model) has been run against it: five prompts, written up in
[`docs/real-agent-run.md`](../../docs/real-agent-run.md). Print mode cannot show the elicitation form to a
person, so the interactive question has not been tried in a commercial client, and Cursor, Claude
Desktop and Codex have not been tried at all.
