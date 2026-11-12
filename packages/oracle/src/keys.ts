import {
  createPrivateKey,
  generateKeyPairSync,
  createPublicKey,
  type KeyObject,
} from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { base58Encode } from "./base58.js";

const PKCS8_SEED_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export interface OracleKeyMaterial {
  privateKey: KeyObject;
  publicKeyRaw: Uint8Array;
  nearPublicKey: string;
}

function keyFromSeed(seed: Buffer): OracleKeyMaterial {
  if (seed.length !== 32) throw new Error("ed25519 seed must be 32 bytes");
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_SEED_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  const pub = createPublicKey(privateKey);
  const der = pub.export({ format: "der", type: "spki" }) as Buffer;
  const publicKeyRaw = der.subarray(der.length - 32);
  return {
    privateKey,
    publicKeyRaw: new Uint8Array(publicKeyRaw),
    nearPublicKey: `ed25519:${base58Encode(publicKeyRaw)}`,
  };
}

function generateKey(): OracleKeyMaterial {
  const { privateKey } = generateKeyPairSync("ed25519");
  const pub = createPublicKey(privateKey);
  const der = pub.export({ format: "der", type: "spki" }) as Buffer;
  const publicKeyRaw = der.subarray(der.length - 32);
  const privDer = privateKey.export({ format: "der", type: "pkcs8" }) as Buffer;
  const seed = privDer.subarray(privDer.length - 32);
  return keyFromSeed(seed);
}

/** A throwaway key that never touches the disk: for read-only commands that sign nothing. */
export function ephemeralOracleKey(): OracleKeyMaterial {
  return generateKey();
}

export function loadOracleKey(options?: {
  keyFile?: string;
  privateKeyEnv?: string;
}): OracleKeyMaterial {
  const envSeed = options?.privateKeyEnv ?? process.env.ORACLE_PRIVATE_KEY;
  if (envSeed) {
    return keyFromSeed(Buffer.from(envSeed, "base64"));
  }
  const keyFile =
    options?.keyFile ??
    process.env.ORACLE_KEY_FILE ??
    resolve(process.cwd(), ".valet/oracle-key.json");
  if (existsSync(keyFile)) {
    const data = JSON.parse(readFileSync(keyFile, "utf8")) as { seed_base64: string };
    return keyFromSeed(Buffer.from(data.seed_base64, "base64"));
  }
  const material = generateKey();
  const dir = dirname(keyFile);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const privDer = material.privateKey.export({ format: "der", type: "pkcs8" }) as Buffer;
  const seed = privDer.subarray(privDer.length - 32);
  writeFileSync(
    keyFile,
    JSON.stringify({ seed_base64: seed.toString("base64") }, null, 2) + "\n",
    { mode: 0o600 },
  );
  return material;
}

export function exportSeedBase64(material: OracleKeyMaterial): string {
  const privDer = material.privateKey.export({ format: "der", type: "pkcs8" }) as Buffer;
  return privDer.subarray(privDer.length - 32).toString("base64");
}
