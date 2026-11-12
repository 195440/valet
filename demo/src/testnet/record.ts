/**
 * What a testnet run leaves behind: the accounts it made, the contract code it deployed and, for
 * every story, what was tried, what the system did and which transactions landed on the chain.
 * `renderMarkdown` turns that into the tables of `docs/testnet-run.md`.
 */
import type { Explorer } from "./links.js";

export interface RecordAccount {
  role: string;
  id: string;
  note: string;
}

export interface RecordTx {
  label: string;
  hash: string;
}

export interface RecordEntry {
  story: string;
  did: string;
  happened: string;
  txs: RecordTx[];
}

export interface CodeCheck {
  contract: string;
  account: string;
  /** What the chain reports for the account's code, as lowercase hex. */
  onChain: string;
  /** The checksum committed next to the wasm in this repository, if it could be read. */
  repo: string | null;
}

export interface RunRecord {
  networkId: string;
  rpcUrl: string;
  startedAt: string;
  finishedAt?: string;
  accounts: RecordAccount[];
  code: CodeCheck[];
  entries: RecordEntry[];
  checks: number;
}

/** One table cell: no line breaks, and a pipe must not end the cell. */
function cell(text: string): string {
  return text.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}

function code(text: string): string {
  return `\`${text.replace(/`/g, "'")}\``;
}

function accountCell(id: string, explorer: Explorer): string {
  const url = explorer.account(id);
  return url ? `[${code(id)}](${url})` : code(id);
}

function txCell(txs: RecordTx[], explorer: Explorer): string {
  if (txs.length === 0) return "none: nothing reached the chain";
  return txs
    .map((tx) => {
      const url = explorer.tx(tx.hash);
      return url ? `[${cell(tx.label)}](${url})` : `${cell(tx.label)} ${code(`${tx.hash.slice(0, 8)}…`)}`;
    })
    .join("<br>");
}

export function renderMarkdown(record: RunRecord, explorer: Explorer): string {
  const out: string[] = [];
  out.push("### Accounts", "", "| Role | Account | Note |", "|---|---|---|");
  for (const a of record.accounts) out.push(`| ${cell(a.role)} | ${accountCell(a.id, explorer)} | ${cell(a.note)} |`);

  out.push("", "### Contract code", "");
  out.push("| Contract | Account | Code hash on the chain (sha-256) | Checksum in this repository | Same |", "|---|---|---|---|---|");
  for (const c of record.code) {
    const same = c.repo === null ? "unknown" : c.repo === c.onChain ? "yes" : "NO";
    out.push(
      `| ${cell(c.contract)} | ${accountCell(c.account, explorer)} | ${code(c.onChain)} | ${c.repo ? code(c.repo) : "unreadable"} | ${same} |`,
    );
  }

  out.push("", "### What happened", "", "| # | Story | What was tried | What the system did | Transactions |", "|---|---|---|---|---|");
  record.entries.forEach((e, i) => {
    out.push(`| ${i + 1} | ${cell(e.story)} | ${cell(e.did)} | ${cell(e.happened)} | ${txCell(e.txs, explorer)} |`);
  });

  out.push("", `${record.checks} checks passed.`);
  return `${out.join("\n")}\n`;
}
