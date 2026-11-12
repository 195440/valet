import { readFileSync, existsSync } from "node:fs";

export interface ThreatEntry {
  account_id: string;
  note: string;
  source?: string;
}

export function loadThreatFeed(path?: string): Map<string, ThreatEntry> {
  const p = path ?? process.env.VALET_THREAT_FEED;
  const map = new Map<string, ThreatEntry>();
  if (!p || !existsSync(p)) return map;
  try {
    const arr = JSON.parse(readFileSync(p, "utf8")) as ThreatEntry[];
    for (const e of arr) {
      map.set(e.account_id, e);
    }
  } catch {
    /* ignore malformed feed */
  }
  return map;
}
