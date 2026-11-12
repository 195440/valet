import { readFileSync } from "node:fs";

export interface ValetMcpConfig {
  rpcUrl: string;
  /** Only a label for near-api-js's key store; it does not change what is signed. */
  networkId: string;
  /** The vault account (the guard contract). */
  guardId: string;
  /** The agent's function-call key, `ed25519:...`. A secret: never log it. */
  agentKey: string;
  oracleUrl: string;
  auditFile?: string;
}

type Env = Record<string, string | undefined>;

const KEYS = ["rpcUrl", "networkId", "guardId", "agentKey", "oracleUrl", "auditFile"] as const;

const ENV_NAMES: Record<(typeof KEYS)[number], string> = {
  rpcUrl: "VALET_RPC_URL",
  networkId: "VALET_NETWORK_ID",
  guardId: "VALET_GUARD_ID",
  agentKey: "VALET_AGENT_KEY",
  oracleUrl: "VALET_ORACLE_URL",
  auditFile: "VALET_AUDIT_FILE",
};

/**
 * Settings come from the JSON file named by `VALET_CONFIG` (extra fields are ignored) and from
 * `VALET_*` environment variables, which win over the file.
 */
export function loadConfig(env: Env, readFile: (path: string) => string = (p) => readFileSync(p, "utf8")): ValetMcpConfig {
  let fromFile: Record<string, unknown> = {};
  const path = env.VALET_CONFIG;
  if (path) {
    // These messages name the file and never quote it: it holds the agent's key, and
    // JSON.parse likes to echo a piece of the text it choked on.
    let text: string;
    try {
      text = readFile(path);
    } catch (e) {
      throw new Error(`cannot read VALET_CONFIG ${path}: ${(e as NodeJS.ErrnoException).code ?? "read failed"}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`VALET_CONFIG ${path} is not valid JSON`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`VALET_CONFIG ${path} must contain a JSON object`);
    }
    fromFile = parsed as Record<string, unknown>;
  }

  const value = (key: (typeof KEYS)[number]): string | undefined => {
    const fromEnv = env[ENV_NAMES[key]];
    if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
    const fromJson = fromFile[key];
    return typeof fromJson === "string" && fromJson !== "" ? fromJson : undefined;
  };

  const missing = (["rpcUrl", "guardId", "agentKey", "oracleUrl"] as const).filter((key) => !value(key));
  if (missing.length > 0) {
    throw new Error(
      `missing settings: ${missing.map((key) => ENV_NAMES[key]).join(", ")}. ` +
        "Set them, or point VALET_CONFIG at a JSON file (the local sandbox writes .valet/sandbox.json).",
    );
  }

  return {
    rpcUrl: value("rpcUrl")!,
    networkId: value("networkId") ?? "sandbox",
    guardId: value("guardId")!,
    agentKey: value("agentKey")!,
    oracleUrl: value("oracleUrl")!,
    auditFile: value("auditFile"),
  };
}
