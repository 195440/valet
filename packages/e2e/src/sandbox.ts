import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Worker } from "near-workspaces";
import { CACHE_DIR } from "./paths.js";

const run = promisify(execFile);

/**
 * The committed wasm is built by cargo-near 0.22, which emits bulk-memory instructions that need a
 * nearcore >= 2.14 runtime (mainnet runs 2.14.0). `near-sandbox@0.1.x` defaults to 2.6.2, which
 * rejects the wasm, so we fetch the matching sandbox binary once and cache it.
 */
export const SANDBOX_VERSION = "2.14.0";

/** SHA-256 of the official `near-sandbox.tar.gz` for each platform (version {@link SANDBOX_VERSION}). */
const TARBALL_SHA256: Record<string, string> = {
  "Darwin-arm64": "ea53448ef97540c012e5c3d967c74d78292b0465a98cf7027811a936718fe232",
  "Linux-x86_64": "a0ba004218b218bd74351795e7ce2eda4a2b6af5cd3e252bd5e8bfe3c8f2e691",
  "Linux-aarch64": "d6b1ff773895972cd2fa098193c5d6cbc046912ff40bfe860e6c7abe807deedb",
};

function platformKey(): string {
  if (process.platform === "darwin" && process.arch === "arm64") return "Darwin-arm64";
  if (process.platform === "linux" && process.arch === "x64") return "Linux-x86_64";
  if (process.platform === "linux" && process.arch === "arm64") return "Linux-aarch64";
  throw new Error(
    `No prebuilt near-sandbox ${SANDBOX_VERSION} is pinned for ${process.platform}/${process.arch}. ` +
      "Run the project in Docker (`docker build -t valet . && docker run --rm valet`), or put a near-sandbox >= 2.14 " +
      "binary in a directory and export NEAR_SANDBOX_BINARY_PATH=<that directory>.",
  );
}

/** Why a fetch failed, including the socket error that undici hides behind a bare "terminated". */
function describeFetchError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  return err.cause instanceof Error ? `${err.message}: ${err.cause.message}` : err.message;
}

/**
 * GET a URL into memory. A dropped connection or a 5xx is retried (the first run downloads 30 MB
 * and one network hiccup should not end it); a 4xx is not, asking again will not help.
 */
export async function fetchWithRetry(
  url: string,
  { attempts = 3, backoffMs = 2000 }: { attempts?: number; backoffMs?: number } = {},
): Promise<Buffer> {
  let reason = "";
  let tries = 0;
  while (tries < attempts) {
    tries++;
    try {
      const res = await fetch(url);
      if (res.ok) return Buffer.from(await res.arrayBuffer());
      reason = `${res.status} ${res.statusText}`;
      if (res.status < 500) break;
    } catch (err) {
      reason = describeFetchError(err);
    }
    if (tries < attempts) {
      console.error(`[valet-e2e] download attempt ${tries}/${attempts} failed (${reason}); retrying`);
      await new Promise((resolve) => setTimeout(resolve, backoffMs * tries));
    }
  }
  throw new Error(`download failed after ${tries} attempt${tries === 1 ? "" : "s"}: ${reason} (${url})`);
}

async function downloadSandbox(dir: string): Promise<void> {
  const url = `https://s3-us-west-1.amazonaws.com/build.nearprotocol.com/nearcore/${platformKey()}/${SANDBOX_VERSION}/near-sandbox.tar.gz`;
  console.error(`[valet-e2e] downloading near-sandbox ${SANDBOX_VERSION} (one time, ~30 MB)`);
  let data: Buffer;
  try {
    data = await fetchWithRetry(url);
  } catch (err) {
    throw new Error(
      `${(err as Error).message}. Offline? Put a near-sandbox >= 2.14 binary in a directory and ` +
        "export NEAR_SANDBOX_BINARY_PATH=<that directory>.",
    );
  }
  const actual = createHash("sha256").update(data).digest("hex");
  const expected = TARBALL_SHA256[platformKey()];
  if (actual !== expected) {
    throw new Error(
      `near-sandbox ${SANDBOX_VERSION} checksum mismatch for ${platformKey()}: expected ${expected}, got ${actual}. ` +
        "Refusing to unpack it.",
    );
  }
  await mkdir(dir, { recursive: true });
  const tarball = join(dir, "near-sandbox.tar.gz");
  await writeFile(tarball, data);
  await run("tar", ["xzf", tarball, "-C", dir, "--strip-components=1"]);
  await chmod(join(dir, "near-sandbox"), 0o755);
}

/** The glibc this process runs on (Linux only), as `2.36`. */
function systemGlibc(): string | undefined {
  const header = (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header;
  return header?.glibcVersionRuntime;
}

const versionParts = (v: string): number[] => v.split(".").map(Number);
const newerThan = (a: string, b: string): boolean => {
  const [x, y] = [versionParts(a), versionParts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
};

/**
 * Say why a sandbox binary will not start. The usual reason on Linux is a glibc that is older than
 * the one it was built with, which the loader reports as "version `GLIBC_2.39' not found". Left
 * alone, that shows up one layer up as a bare "Process exited with code 1".
 *
 * `glibc` is the local version; leave it out to ask this machine, pass `null` when it is not known
 * (a default parameter would also answer for `undefined`, so `null` is the explicit "unknown").
 */
export function explainUnrunnable(output: string, glibc: string | null = systemGlibc() ?? null): string {
  const needed = [...output.matchAll(/GLIBC_(\d+(?:\.\d+)*)'? not found/g)].map((m) => m[1]!).reduce<string | undefined>((max, v) => (max === undefined || newerThan(v, max) ? v : max), undefined);
  if (needed) {
    return (
      `near-sandbox ${SANDBOX_VERSION} cannot start here: it needs glibc ${needed} or newer (Ubuntu 24.04, Debian 13, Fedora 40) ` +
      `and this machine has ${glibc ?? "an older one"}. The chain demo, the sandbox and the end-to-end tests need it; ` +
      "the unit tests and `npm run lookup` do not. Run the project in Docker instead " +
      "(`docker build -t valet . && docker run --rm valet`), use a newer system, or point NEAR_SANDBOX_BINARY_PATH " +
      "at a near-sandbox >= 2.14 that runs here."
    );
  }
  const firstLine = output.split("\n").find((l) => l.trim() !== "")?.trim() ?? "no output";
  return `near-sandbox ${SANDBOX_VERSION} cannot be executed here: ${firstLine.slice(0, 300)}`;
}

interface Probe {
  /** `neard (release 2.14.0) ...` -> [2, 14, 0]; null when there is no binary or it did not answer. */
  version: number[] | null;
  /** What the binary printed when it would not start, if it exists and failed. */
  failure: string | null;
}

async function probe(dir: string): Promise<Probe> {
  const bin = join(dir, "near-sandbox");
  if (!existsSync(bin)) return { version: null, failure: null };
  try {
    const { stdout } = await run(bin, ["--version"]);
    const m = /release (\d+)\.(\d+)\.(\d+)/.exec(stdout);
    return { version: m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null, failure: null };
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    return { version: null, failure: `${err.stderr ?? ""}${err.message ?? ""}` };
  }
}

const isNewEnough = (p: Probe): boolean => p.version !== null && (p.version[0]! > 2 || (p.version[0] === 2 && p.version[1]! >= 14));

/**
 * Point near-sandbox at a >= 2.14 binary: a directory from `NEAR_SANDBOX_BINARY_PATH` if it is new
 * enough, otherwise the cached download (fetched on first use).
 */
export async function ensureSandboxBinary(): Promise<string> {
  const custom = process.env.NEAR_SANDBOX_BINARY_PATH;
  const cached = join(CACHE_DIR, `near-sandbox-${SANDBOX_VERSION}`);
  let dir: string;
  const customProbe = custom ? await probe(custom) : undefined;
  if (custom && customProbe && isNewEnough(customProbe)) {
    dir = custom;
  } else {
    if (custom) {
      console.error(`[valet-e2e] ignoring NEAR_SANDBOX_BINARY_PATH=${custom}: need near-sandbox >= 2.14 that runs here`);
    }
    let have = await probe(cached);
    if (!have.failure && !isNewEnough(have)) {
      await downloadSandbox(cached);
      have = await probe(cached);
    }
    // A binary that is there but will not start is not fixed by downloading it again.
    if (have.failure) throw new Error(explainUnrunnable(have.failure));
    dir = cached;
  }
  // near-sandbox@0.1.x only honours the directory variable when the flag variable is also set.
  process.env.NEAR_SANDBOX_BINARY_PATH = dir;
  process.env.NEAR_SANDBOX_BIN_PATH = dir;
  return dir;
}

/**
 * near-workspaces asks `near-sandbox@0.1.x` for the binary, and that package throws "Unsupported
 * platform" on every platform it has no 2.6.2 download for (Linux arm64, which is what Docker runs
 * on Apple silicon, and macOS x64), even when NEAR_SANDBOX_BINARY_PATH points at a working binary.
 * The right binary is already here and checked, so answer the same question without the platform test.
 */
export function allowEveryPlatform(): void {
  const fromWorkspaces = createRequire(createRequire(import.meta.url).resolve("near-workspaces"));
  const module = fromWorkspaces("near-sandbox/dist/getBinary") as { getBinary: (name?: string) => Promise<unknown> };
  const { Binary } = fromWorkspaces("near-sandbox") as { Binary: { create: (name: string, urls: string[]) => Promise<unknown> } };
  // The install directory comes from NEAR_SANDBOX_BINARY_PATH, which ensureSandboxBinary() has set. The URL
  // is only used to install a binary that is missing, which never happens after that.
  const url = `https://s3-us-west-1.amazonaws.com/build.nearprotocol.com/nearcore/${process.platform}-${process.arch}/${SANDBOX_VERSION}/near-sandbox.tar.gz`;
  module.getBinary = (name = "near-sandbox") => Binary.create(name, [url]);
}

let worker: Worker | null = null;

/**
 * near-api-js and near-workspaces print every receipt, contract log line and nonce retry to the
 * console, which buries test and demo output. Drop exactly those lines (errors and everything
 * else still pass through). Set VALET_E2E_VERBOSE=1 to see them.
 */
export function quietNearLogs(): void {
  if (process.env.VALET_E2E_VERBOSE || process.env.NEAR_WORKSPACES_NO_LOGS === "1") return;
  process.env.NEAR_WORKSPACES_NO_LOGS = "1";
  const noise = /^\s*(Receipts?: |Log \[|Contract logs from |Retrying transaction )/;
  for (const level of ["log", "warn"] as const) {
    const original = console[level].bind(console);
    console[level] = (first?: unknown, ...rest: unknown[]) => {
      if (typeof first === "string" && noise.test(first)) return;
      original(first, ...rest);
    };
  }
}

export async function startSandbox(): Promise<Worker> {
  if (worker) return worker;
  quietNearLogs();
  await ensureSandboxBinary();
  allowEveryPlatform();
  const { Worker: W } = await import("near-workspaces");
  worker = await W.init();
  return worker;
}

export async function stopSandbox(): Promise<void> {
  if (!worker) return;
  const w = worker;
  worker = null;
  await w.tearDown();
}

export function getWorker(): Worker {
  if (!worker) throw new Error("sandbox not started; call startSandbox() first");
  return worker;
}

export function rpcUrl(): string {
  const w = getWorker();
  const p = w.provider as { connection?: { url?: string }; config?: { rpcAddr?: string } };
  return p.connection?.url ?? p.config?.rpcAddr ?? "http://127.0.0.1:3030";
}
