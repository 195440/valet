import type { Reason } from "@valet/oracle";

export interface ParsedEvent {
  standard: string;
  version: string;
  event: string;
  data: Record<string, unknown>[];
}

export interface PayResult {
  status: string;
  reason?: string | null;
  pending_id?: string | number | null;
}

function decodeLogLine(line: string): ParsedEvent | null {
  const prefix = "EVENT_JSON:";
  const idx = line.indexOf(prefix);
  if (idx === -1) return null;
  try {
    return JSON.parse(line.slice(idx + prefix.length)) as ParsedEvent;
  } catch {
    return null;
  }
}

/** Collect `EVENT_JSON:` valet logs from an execution outcome or receipt list. */
export function parseEvents(source: {
  receipts_outcome?: Array<{ outcome?: { logs?: string[] } }>;
  logs?: string[];
}): ParsedEvent[] {
  const lines: string[] = [];
  if (source.logs) lines.push(...source.logs);
  for (const r of source.receipts_outcome ?? []) {
    for (const log of r.outcome?.logs ?? []) lines.push(log);
  }
  const out: ParsedEvent[] = [];
  for (const line of lines) {
    const ev = decodeLogLine(line);
    if (ev?.standard === "valet") out.push(ev);
  }
  return out;
}

export function decodePayResult(successValueBase64: string | null | undefined): PayResult | null {
  if (!successValueBase64) return null;
  try {
    const json = Buffer.from(successValueBase64, "base64").toString("utf8");
    return JSON.parse(json) as PayResult;
  } catch {
    return null;
  }
}

export type { Reason };
