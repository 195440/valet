import { generateKeyPairSync, createPublicKey, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { NearAccount, Worker } from "near-workspaces";
import { KeyPair } from "near-workspaces";
import { ValetAgent } from "@valet/client";
import {
  CodeHashCache,
  RiskEngine,
  createRpcClient,
  createGuardReader,
  NoopActivityProvider,
  NoopRegistry,
  createRpcRegistry,
  type Registry,
  checkGuardHardening,
  base58Encode,
  type OracleKeyMaterial,
} from "@valet/oracle";
import { GUARD_WASM, REGISTRY_WASM, NEAR, defaultPolicy } from "./paths.js";
import { getWorker, rpcUrl } from "./sandbox.js";
import { rawSender, type RawSender } from "./agent-raw.js";

function isFullAccess(perm: unknown): boolean {
  if (perm === "FullAccess") return true;
  return typeof perm === "object" && perm !== null && "FullAccess" in perm;
}

async function waitForAccessKeys(
  guardId: string,
  minKeys: number,
  timeoutMs = 15_000,
): Promise<void> {
  const rpc = createRpcClient({ url: rpcUrl() });
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const keys = await rpc.viewAccessKeys(guardId);
    if (keys.length >= minKeys) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timeout waiting for ${minKeys} access keys on ${guardId}`);
}

export interface GuardFixture {
  worker: Worker;
  root: NearAccount;
  owner: NearAccount;
  guard: NearAccount;
  agentKeyPair: KeyPair;
  agent: ValetAgent;
  /** The agent key used directly, bypassing the ValetAgent wrapper (a compromised agent). */
  raw: RawSender;
  engine: RiskEngine;
  oracleKey: OracleKeyMaterial;
  registry?: NearAccount;
  rpc: string;
}

export function ephemeralOracleKey(): OracleKeyMaterial {
  const { privateKey } = generateKeyPairSync("ed25519");
  const pub = createPublicKey(privateKey);
  const der = pub.export({ format: "der", type: "spki" }) as Buffer;
  const publicKeyRaw = new Uint8Array(der.subarray(der.length - 32));
  return {
    privateKey,
    publicKeyRaw,
    nearPublicKey: `ed25519:${base58Encode(publicKeyRaw)}`,
  };
}

/**
 * Create an account, deploy `wasm` and call its init method in ONE transaction signed by the
 * account itself. The contracts' `new` is `#[private]`, so it only accepts a call whose
 * predecessor is the contract account: nobody can initialize it between deploy and init.
 */
async function deployInitialized(
  prefix: string,
  wasmPath: string,
  initMethod: string,
  initArgs: Record<string, unknown>,
  balance: bigint,
): Promise<NearAccount> {
  const account = await getWorker().rootAccount.createSubAccount(`${prefix}-${randomBytes(3).toString("hex")}`, {
    initialBalance: balance,
  });
  const tx = await account.batch(account).deployContract(readFileSync(wasmPath)).functionCall(initMethod, initArgs).transact();
  if (tx.failed) {
    throw new Error(`deploy + ${initMethod} failed for ${account.accountId}: ${tx.receiptFailureMessages?.join("; ")}`);
  }
  return account;
}

export async function deployGuardFixture(options: {
  policy?: ReturnType<typeof defaultPolicy>;
  fundNear?: number;
  oracleKey?: OracleKeyMaterial;
  withRegistry?: boolean;
  /** Gas allowance of the agent's function-call key (yoctoNEAR). Default 5 NEAR. */
  agentAllowance?: bigint;
  lockDown?: boolean;
} = {}): Promise<GuardFixture> {
  const worker = getWorker();
  const root = worker.rootAccount;
  const owner = await root.createSubAccount(`owner-${randomBytes(4).toString("hex")}`);
  const oracleKey = options.oracleKey ?? ephemeralOracleKey();
  const policy = options.policy ?? defaultPolicy();

  const guard = await deployInitialized("guard", GUARD_WASM, "new", {
    owner_id: owner.accountId,
    oracle_public_key: oracleKey.nearPublicKey,
    policy,
  }, NEAR(options.fundNear ?? 50));

  let registry: NearAccount | undefined;
  const rpc = rpcUrl();
  const rpcClient = createRpcClient({ url: rpc });
  let registryDep: Registry = new NoopRegistry();
  if (options.withRegistry) {
    registry = await deployInitialized("registry", REGISTRY_WASM, "new", { owner_id: owner.accountId }, NEAR(10));
    registryDep = createRpcRegistry(rpcClient, registry.accountId);
  }

  const agentKeyPair = KeyPair.fromRandom("ed25519");
  const allowance = options.agentAllowance ?? NEAR(5);
  await owner.call(guard, "add_agent_key", {
    public_key: agentKeyPair.getPublicKey().toString(),
    allowance: allowance.toString(),
  });
  await waitForAccessKeys(guard.accountId, 2);

  const engine = new RiskEngine(
    {
      rpc: rpcClient,
      guard: createGuardReader(rpcClient),
      activity: new NoopActivityProvider(),
      registry: registryDep,
      key: oracleKey,
      // Baselines must not leak between sandbox runs: account names repeat, chains do not.
      codeHashCache: new CodeHashCache(null),
    },
    { allowBelow: 30, blockFrom: 70, ttlMs: 120_000 },
  );

  const agent = new ValetAgent({
    guardId: guard.accountId,
    agentKey: agentKeyPair.toString(),
    rpcUrl: rpc,
    networkId: "sandbox",
    engine,
  });

  const raw = await rawSender({
    accountId: guard.accountId,
    rpcUrl: rpc,
    secretKey: agentKeyPair.toString(),
  });

  if (options.lockDown) {
    await lockDownGuard(guard);
  }

  return {
    worker,
    root,
    owner,
    guard,
    agentKeyPair,
    agent,
    raw,
    engine,
    oracleKey,
    registry,
    rpc,
  };
}

/**
 * Remove every full-access key of the guard account in ONE transaction (the signing key included),
 * which makes the contract immutable: afterwards only the agent's function-call key remains.
 * The RPC view lags behind by a few blocks, so we wait for it instead of re-sending the delete.
 */
export async function lockDownGuard(guard: NearAccount): Promise<void> {
  const rpc = createRpcClient({ url: rpcUrl() });
  const hasFullAccess = async () =>
    (await rpc.viewAccessKeys(guard.accountId)).filter((k) => isFullAccess(k.access_key.permission));
  const full = await hasFullAccess();
  if (full.length === 0) return;
  let batch = guard.batch(guard);
  for (const key of full) batch = batch.deleteKey(key.public_key);
  const tx = await batch.transact();
  if (!tx.succeeded) {
    throw new Error(`deleteKey failed: ${tx.receiptFailureMessages?.join("; ")}`);
  }
  const deadline = Date.now() + 20_000;
  while ((await hasFullAccess()).length > 0) {
    if (Date.now() > deadline) throw new Error("lockDownGuard: full-access key still visible after 20s");
    await new Promise((r) => setTimeout(r, 250));
  }
}

export async function assertHardening(guardId: string, expectPass: boolean): Promise<void> {
  const report = await checkGuardHardening(createRpcClient({ url: rpcUrl() }), guardId);
  if (report.pass !== expectPass) {
    throw new Error(
      `hardening expected ${expectPass} got ${report.pass}: ${JSON.stringify(report.keys)}`,
    );
  }
}

/** Create a sub-account and wait until the (finality=final) RPC view can see it. */
export async function createAccount(prefix: string, near = 5, exactName = false): Promise<NearAccount> {
  const id = exactName ? prefix : `${prefix}-${randomBytes(3).toString("hex")}`;
  const account = await getWorker().rootAccount.createSubAccount(id, { initialBalance: NEAR(near) });
  const rpc = createRpcClient({ url: rpcUrl() });
  const deadline = Date.now() + 20_000;
  while ((await rpc.viewAccount(account.accountId)) === null) {
    if (Date.now() > deadline) throw new Error(`${account.accountId} not visible on the RPC after 20s`);
    await new Promise((r) => setTimeout(r, 250));
  }
  return account;
}

export function parsePayResult(tx: { parseResult?: () => unknown; receipts_outcome?: unknown[] }) {
  try {
    return tx.parseResult?.() as { status: string; reason?: string; pending_id?: string };
  } catch {
    return null;
  }
}
