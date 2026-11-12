import { appendFileSync } from "node:fs";

export interface AuditEntry {
  ts: string;
  guard: string;
  receiver: string;
  amount_yocto: string;
  memo?: string;
  status: string;
  stage: string;
  verdict?: string;
  score?: number;
  reasons?: unknown[];
  reason?: string;
  pending_id?: string | number;
  tx_hash?: string;
}

export function writeAudit(
  auditFile: string | undefined,
  onAudit: ((entry: AuditEntry) => void) | undefined,
  entry: AuditEntry,
): void {
  onAudit?.(entry);
  if (auditFile) {
    appendFileSync(auditFile, `${JSON.stringify(entry)}\n`, "utf8");
  }
}
