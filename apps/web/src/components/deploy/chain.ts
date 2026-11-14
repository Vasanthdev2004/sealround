/**
 * Read-only chain helpers for the deploy page, over plain JSON-RPC, plus the
 * one signing path that uses the contract account's own key. near-api-js is
 * imported only inside that function, so the page loads without it.
 */

export const TESTNET = {
  network: "testnet" as const,
  rpcUrl: "https://rpc.testnet.fastnear.com",
  outlayer: "outlayer.testnet",
  explorerTx: "https://testnet.nearblocks.io/txns/",
  explorerAccount: "https://testnet.nearblocks.io/address/",
  // Same list as enclave/deploy/templates/new-args.testnet.json.
  quoteTokens: ["usdc.fakes.testnet", "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af"],
  // The Rhea exchange launch pools are seeded on (Rhea v1.9.19 on testnet).
  dex: "ref-finance-101.testnet",
};

/** contracts/res/fairground.wasm, 616,196 bytes (AGENTS.md "Pinned hashes"). */
export const PINNED_CONTRACT_BYTES = 616_196;
export const PINNED_CONTRACT_SHA256 = "e93c42759bd63edfba428cf16f043bdad1ae2f3a54d45ca8f9f41e74fe65a941";
/** enclave/res/fairground_sealer.wasm, the job the contract pins. */
export const PINNED_SEALER_SHA256 = "f8408a875ec685394d00937cfc320c8b5e8c2a1e8398cfdf34987aa91001d8cb";

/** The code hash NEAR reports for an account with no contract. */
const NO_CODE = "11111111111111111111111111111111";

export const YOCTO_PER_NEAR = 10n ** 24n;

export class RpcError extends Error {
  constructor(
    message: string,
    readonly cause?: string,
  ) {
    super(message);
  }
}

async function rpc<T>(rpcUrl: string, method: string, params: unknown): Promise<T> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "deploy", method, params }),
  });
  if (!res.ok) throw new RpcError(`RPC answered HTTP ${res.status}`);
  const json = (await res.json()) as {
    result?: T & { error?: string };
    error?: { message?: string; data?: unknown; cause?: { name?: string } };
  };
  if (json.error) {
    const detail = typeof json.error.data === "string" ? json.error.data : json.error.message;
    throw new RpcError(detail ?? "RPC error", json.error.cause?.name);
  }
  // Older nodes put query errors inside the result.
  if (json.result && typeof json.result.error === "string") throw new RpcError(json.result.error);
  return json.result as T;
}

export type AccountState = {
  exists: boolean;
  /** yoctoNEAR. */
  balance: bigint;
  storageBytes: number;
  /** base58, or null when no contract is deployed. */
  codeHash: string | null;
};

export async function viewAccount(rpcUrl: string, accountId: string): Promise<AccountState> {
  try {
    const r = await rpc<{ amount: string; storage_usage: number; code_hash: string }>(rpcUrl, "query", {
      request_type: "view_account",
      finality: "final",
      account_id: accountId,
    });
    return {
      exists: true,
      balance: BigInt(r.amount),
      storageBytes: r.storage_usage,
      codeHash: r.code_hash === NO_CODE ? null : r.code_hash,
    };
  } catch (e) {
    const text = e instanceof RpcError ? `${e.cause ?? ""} ${e.message}` : String(e);
    if (/UNKNOWN_ACCOUNT|does not exist/i.test(text)) return { exists: false, balance: 0n, storageBytes: 0, codeHash: null };
    throw e;
  }
}

export type AccessKey = { publicKey: string; fullAccess: boolean };

export async function listKeys(rpcUrl: string, accountId: string): Promise<AccessKey[]> {
  const r = await rpc<{ keys: { public_key: string; access_key: { permission: unknown } }[] }>(rpcUrl, "query", {
    request_type: "view_access_key_list",
    finality: "final",
    account_id: accountId,
  });
  return r.keys.map((k) => ({ publicKey: k.public_key, fullAccess: k.access_key.permission === "FullAccess" }));
}

/** A view call; returns the parsed JSON (null for a `null` answer). */
export async function viewFunction<T>(rpcUrl: string, accountId: string, method: string, args: object): Promise<T> {
  const r = await rpc<{ result: number[] }>(rpcUrl, "query", {
    request_type: "call_function",
    finality: "final",
    account_id: accountId,
    method_name: method,
    args_base64: btoa(JSON.stringify(args)),
  });
  const text = new TextDecoder().decode(new Uint8Array(r.result));
  return (text ? JSON.parse(text) : null) as T;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** base58 of a hex string, the form NEAR reports code hashes in. */
export function hexToBase58(hex: string): string {
  let n = BigInt(`0x${hex}`);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (let i = 0; i < hex.length && hex.slice(i, i + 2) === "00"; i += 2) out = `1${out}`;
  return out;
}

/** "6.5" -> yoctoNEAR. Up to 24 decimals. */
export function nearToYocto(near: string): bigint {
  const [whole, frac = ""] = near.trim().split(".");
  if (!/^\d+$/.test(whole) || !/^\d*$/.test(frac) || frac.length > 24) throw new Error(`Not a NEAR amount: ${near}`);
  return BigInt(whole) * YOCTO_PER_NEAR + BigInt(frac.padEnd(24, "0"));
}

export function formatNear(yocto: bigint, digits = 3): string {
  const whole = yocto / YOCTO_PER_NEAR;
  const frac = (yocto % YOCTO_PER_NEAR).toString().padStart(24, "0").slice(0, digits).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

/** What 4-deploy-contract.ps1 funds the account with: code plus 2 KB at 1e19 yocto per byte, plus 1 NEAR, rounded up to 0.1. */
export function fundingFor(wasmBytes: number): string {
  return (Math.ceil(((wasmBytes + 2000) / 100000 + 1) * 10) / 10).toFixed(1);
}

export type NewArgs = {
  outlayer: string;
  sealer_source: { Project: { project_id: string; version_key: string } };
  sealer_code_hash: string;
  sealer_secrets: { profile: string; account_id: string };
  allowed_quote_tokens: string[];
  /** null turns launch liquidity off. */
  dex: string | null;
};

/** The `new` arguments, the same shape as enclave/deploy/templates/new-args.testnet.json. */
export function newArgs(owner: string, project: string, sealerSha: string, profile: string): NewArgs {
  return {
    outlayer: TESTNET.outlayer,
    sealer_source: { Project: { project_id: `${owner}/${project}`, version_key: sealerSha } },
    sealer_code_hash: sealerSha,
    sealer_secrets: { profile, account_id: owner },
    allowed_quote_tokens: TESTNET.quoteTokens,
    dex: TESTNET.dex,
  };
}

type Outcome = {
  transaction: { hash: string };
  status: unknown;
  receipts_outcome: { outcome: { status: unknown } }[];
};

function failureOf(outcome: Outcome): string | null {
  const all = [outcome.status, ...outcome.receipts_outcome.map((r) => r.outcome.status)];
  for (const s of all) {
    if (s && typeof s === "object" && "Failure" in s) return JSON.stringify((s as { Failure: unknown }).Failure);
  }
  return null;
}

export type TxResult = { hash: string; failure: string | null };

/**
 * Signs one transaction from the contract account with its own key (the key
 * this page generated and the wallet added when it created the account).
 */
export async function sendAsContract(
  rpcUrl: string,
  contractId: string,
  secretKey: string,
  build: (
    a: typeof import("near-api-js").actions,
    ownKey: ReturnType<import("near-api-js").KeyPair["getPublicKey"]>,
  ) => import("near-api-js").Action[],
): Promise<TxResult> {
  const { Account, JsonRpcProvider, KeyPair, KeyPairSigner, actions } = await import("near-api-js");
  const keyPair = KeyPair.fromString(secretKey as import("near-api-js").KeyPairString);
  const account = new Account(contractId, new JsonRpcProvider({ url: rpcUrl }), new KeyPairSigner(keyPair));
  const outcome = (await account.signAndSendTransaction({
    receiverId: contractId,
    actions: build(actions, keyPair.getPublicKey()),
    waitUntil: "FINAL",
    throwOnFailure: false,
  })) as unknown as Outcome;
  return { hash: outcome.transaction.hash, failure: failureOf(outcome) };
}

/** A fresh ed25519 key pair: the contract account's only full-access key until the lock deletes it. */
export async function newKeyPair(): Promise<{ publicKey: string; secretKey: string }> {
  const { KeyPair } = await import("near-api-js");
  const kp = KeyPair.fromRandom("ed25519");
  return { publicKey: kp.getPublicKey().toString(), secretKey: kp.toString() };
}

export async function publicKeyOf(secretKey: string): Promise<string> {
  const { KeyPair } = await import("near-api-js");
  return KeyPair.fromString(secretKey as import("near-api-js").KeyPairString)
    .getPublicKey()
    .toString();
}
