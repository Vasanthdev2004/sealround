/**
 * The local chain of the sandbox end-to-end run: the Docker container that
 * runs the nearcore sandbox, and the harness's own way of reading and writing
 * the chain.
 *
 * The harness never reads the chain through the code under test: balances,
 * views and nonces here go over raw JSON-RPC, and setup transactions through
 * near-api-js accounts, so a bug in apps/web/src/lib cannot hide itself.
 *
 * The container recipe is the one of scripts/sandbox.ps1 and
 * apps/relayer/scripts/sandbox.ps1 (debian:trixie-slim, the cached Linux
 * near-sandbox binary mounted read-only, a fresh chain on every start), under
 * its own name and port so it can run next to theirs.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, nearToYocto, type KeyPairString } from "near-api-js";

/**
 * This folder. tsx loads these files as CommonJS (apps/web/package.json names
 * no module type), where __dirname exists; the other branch is for the day the
 * package becomes an ES module.
 */
export const E2E_DIR = typeof __dirname === "string" ? __dirname : path.dirname(fileURLToPath(import.meta.url));
/** apps/web */
export const WEB_DIR = path.resolve(E2E_DIR, "../..");
/** The repository root. */
export const REPO_DIR = path.resolve(WEB_DIR, "../..");

export const SANDBOX_NAME = "near-sandbox-web";
export const SANDBOX_PORT = 3050;
const SANDBOX_VERSION = "2.14.0";
const SANDBOX_IMAGE = "debian:trixie-slim";
/** Block time one forwarded block adds (measured by contracts/tests: about 0.29 s). */
const NS_PER_FORWARDED_BLOCK = 290_000_000n;

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function docker(args: string[]): { code: number; out: string } {
  const run = spawnSync("docker", args, { encoding: "utf8", windowsHide: true });
  if (run.error) return { code: 1, out: run.error.message };
  return { code: run.status ?? 1, out: `${run.stdout ?? ""}${run.stderr ?? ""}`.trim() };
}

/** Removes the container and its chain. True when it is gone (or was never there). */
export function removeSandbox(): boolean {
  const removed = docker(["rm", "-f", SANDBOX_NAME]);
  return removed.code === 0 || /No such container/i.test(removed.out);
}

/** Whether a container of this name exists, running or not. */
export function sandboxExists(): boolean {
  return docker(["inspect", "--format", "{{.State.Status}}", SANDBOX_NAME]).code === 0;
}

export type Validator = { accountId: string; secretKey: string };

/**
 * Starts a fresh chain in the container and waits for its RPC. Returns the
 * RPC URL and the validator key, which is the key of the sandbox root account.
 */
export async function startSandbox(): Promise<{ rpcUrl: string; validator: Validator }> {
  if (docker(["version", "--format", "{{.Server.Version}}"]).code !== 0) {
    throw new Error("Docker is not running (docker version failed). Start Docker Desktop and run again.");
  }
  if (!removeSandbox()) throw new Error(`could not remove an old ${SANDBOX_NAME} container`);

  const binDir = path.join(REPO_DIR, ".sandbox-bin", SANDBOX_VERSION, "Linux-x86_64");
  if (!existsSync(path.join(binDir, "near-sandbox"))) {
    throw new Error(
      `no sandbox binary at ${path.join(binDir, "near-sandbox")}: run scripts\\sandbox.ps1 once (it downloads nearcore sandbox ${SANDBOX_VERSION}), then scripts\\sandbox.ps1 -Stop`,
    );
  }
  const started = docker([
    "run", "-d", "--name", SANDBOX_NAME, "-p", `127.0.0.1:${SANDBOX_PORT}:3030`,
    "-v", `${binDir}:/opt/sbx:ro`, SANDBOX_IMAGE,
    "sh", "-c",
    "/opt/sbx/near-sandbox --home /data init --fast && exec /opt/sbx/near-sandbox --home /data run --rpc-addr 0.0.0.0:3030 --network-addr 0.0.0.0:3031",
  ]);
  if (started.code !== 0) throw new Error(`docker run failed: ${started.out}`);

  const rpcUrl = `http://127.0.0.1:${SANDBOX_PORT}`;
  let ready = false;
  for (let i = 0; i < 120 && !ready; i++) {
    try {
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "status", method: "status", params: [] }),
        signal: AbortSignal.timeout(2_000),
      });
      const body = (await res.json()) as { result?: { sync_info?: { latest_block_height?: number } } };
      ready = (body.result?.sync_info?.latest_block_height ?? 0) > 1;
    } catch {
      // not up yet
    }
    if (!ready) await sleep(500);
  }
  if (!ready) {
    const logs = docker(["logs", "--tail", "30", SANDBOX_NAME]).out;
    throw new Error(`the sandbox RPC did not come up at ${rpcUrl} within 60 s\n${logs}`);
  }

  const key = docker(["exec", SANDBOX_NAME, "cat", "/data/validator_key.json"]);
  if (key.code !== 0) throw new Error(`could not read the validator key: ${key.out}`);
  const parsed = JSON.parse(key.out) as { account_id: string; secret_key?: string; private_key?: string };
  const secretKey = parsed.secret_key ?? parsed.private_key;
  if (!secretKey) throw new Error("the validator key file holds no secret key");
  return { rpcUrl, validator: { accountId: parsed.account_id, secretKey } };
}

/** An account the harness holds the full-access key of. */
export type Named = {
  id: string;
  key: KeyPair;
  /** "ed25519:..." secret key, as NEXT_PUBLIC_DEV_ACCOUNTS takes it. */
  secret: string;
  publicKey: string;
  account: Account;
};

type RpcError = { name?: string; cause?: { name?: string; info?: unknown }; message?: string; data?: unknown };

/** The harness's own reader and clock of the chain. */
export class Chain {
  readonly provider: JsonRpcProvider;
  private nextId = 1;

  constructor(readonly rpcUrl: string) {
    this.provider = new JsonRpcProvider({ url: rpcUrl });
  }

  /** One raw JSON-RPC call. Throws with the node's error. */
  async rpc<T>(method: string, params: unknown): Promise<T> {
    const res = await fetch(this.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await res.json()) as { result?: T; error?: RpcError };
    if (body.error) throw new Error(`RPC ${method}: ${JSON.stringify(body.error).slice(0, 500)}`);
    return body.result as T;
  }

  /** A contract view at the optimistic head. */
  async view<T>(contractId: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
    const result = await this.rpc<{ result?: number[]; error?: string }>("query", {
      request_type: "call_function",
      finality: "optimistic",
      account_id: contractId,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
    });
    if (typeof result.error === "string") throw new Error(`${contractId}.${method}: ${result.error}`);
    const text = Buffer.from(result.result ?? []).toString("utf8");
    return (text === "" ? null : JSON.parse(text)) as T;
  }

  /** The account's NEAR balance in yoctoNEAR. */
  async nearOf(accountId: string): Promise<bigint> {
    const account = await this.rpc<{ amount: string }>("query", { request_type: "view_account", finality: "optimistic", account_id: accountId });
    return BigInt(account.amount);
  }

  async accountExists(accountId: string): Promise<boolean> {
    try {
      await this.nearOf(accountId);
      return true;
    } catch {
      return false;
    }
  }

  /** The nonce of one access key: it moves exactly when a transaction or delegate signed by the key is accepted. */
  async nonceOf(who: Pick<Named, "id" | "publicKey">): Promise<bigint> {
    const key = await this.rpc<{ nonce: number | string }>("query", {
      request_type: "view_access_key",
      finality: "optimistic",
      account_id: who.id,
      public_key: who.publicKey,
    });
    return BigInt(key.nonce);
  }

  async head(): Promise<{ height: number; timeNs: bigint }> {
    const block = await this.rpc<{ header: { height: number; timestamp_nanosec: string } }>("block", { finality: "optimistic" });
    return { height: block.header.height, timeNs: BigInt(block.header.timestamp_nanosec) };
  }

  async nowNs(): Promise<bigint> {
    return (await this.head()).timeNs;
  }

  /**
   * Moves the chain clock to at least `atNs` with the sandbox's fast-forward
   * (no waiting for real time). After it the chain's clock stays ahead of the
   * wall clock, which is why nothing in this run compares the two.
   */
  async advanceTo(atNs: bigint): Promise<void> {
    // At most 1,000 blocks a call: a sandbox that has run for hours forwards
    // about 100 blocks a second, and each call has 30 s (`rpc`).
    for (let i = 0; i < 60; i++) {
      const now = await this.nowNs();
      if (now >= atNs) return;
      const blocks = Number((atNs - now) / NS_PER_FORWARDED_BLOCK + 2n);
      await this.rpc("sandbox_fast_forward", { delta_height: Math.min(blocks, 1_000) });
    }
    throw new Error(`the sandbox clock did not reach ${atNs} after 60 fast-forwards`);
  }

  /** NEP-141 balance, 0 for an account that is not registered. */
  async ft(token: string, accountId: string): Promise<bigint> {
    return BigInt(await this.view<string>(token, "ft_balance_of", { account_id: accountId }));
  }

  async ftSupply(token: string): Promise<bigint> {
    return BigInt(await this.view<string>(token, "ft_total_supply"));
  }

  async ftRegistered(token: string, accountId: string): Promise<boolean> {
    return (await this.view<unknown>(token, "storage_balance_of", { account_id: accountId })) !== null;
  }

  /**
   * The NEAR balance once it has stopped moving for five blocks: gas refunds
   * land in receipts a few blocks after a transaction is reported executed.
   */
  async settledNear(accountId: string): Promise<bigint> {
    let balance = await this.nearOf(accountId);
    let since = (await this.head()).height;
    for (const deadline = Date.now() + 30_000; Date.now() < deadline; ) {
      await sleep(200);
      const [now, { height }] = [await this.nearOf(accountId), await this.head()];
      if (now !== balance) [balance, since] = [now, height];
      else if (height - since >= 5) return balance;
    }
    throw new Error(`${accountId}'s NEAR balance did not settle within 30 s`);
  }

  /** The root account, which owns every other account of the run. */
  root(validator: Validator): Account {
    return new Account(validator.accountId, this.provider, validator.secretKey as KeyPairString);
  }

  /** Creates `<name>.<root>` with a fresh full-access key and `near` NEAR. */
  async createAccount(root: Account, name: string, near: number): Promise<Named> {
    const key = KeyPair.fromRandom("ed25519");
    const id = `${name}.${root.accountId}`;
    await root.createAccount({ newAccountId: id, publicKey: key.getPublicKey(), nearToTransfer: nearToYocto(near) });
    return {
      id,
      key,
      secret: key.toString(),
      publicKey: key.getPublicKey().toString(),
      account: new Account(id, this.provider, new KeyPairSigner(key)),
    };
  }
}
