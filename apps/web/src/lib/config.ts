/**
 * Which chain the app talks to, read once from NEXT_PUBLIC_* variables.
 *
 * - Mock mode (the default): NEXT_PUBLIC_FAIRGROUND_CONTRACT is not set. Every
 *   page runs on the simulated chain in this browser (client/mock.ts) with a
 *   simulated wallet. Nothing below is used.
 * - NEAR mode: NEXT_PUBLIC_FAIRGROUND_CONTRACT names a deployed Fairground
 *   contract. Views go to NEXT_PUBLIC_NEAR_RPC_URL, gasless calls to
 *   NEXT_PUBLIC_RELAYER_URL, and the wallet is NEAR Connect (or, on a local
 *   sandbox only, the dev accounts in NEXT_PUBLIC_DEV_ACCOUNTS).
 *
 * Next.js inlines a NEXT_PUBLIC_* variable into the browser bundle only where
 * the code spells out `process.env.NEXT_PUBLIC_NAME`, so each one is read by
 * its full name below. apps/web/.env.example documents all of them.
 */

export type NearNetwork = "mainnet" | "testnet" | "sandbox";

/** A sandbox account and its full-access secret key ("ed25519:..."). */
export type DevAccount = { accountId: string; secretKey: string };

export type NearConfig = {
  network: NearNetwork;
  rpcUrl: string;
  /** The Fairground contract account. */
  contractId: string;
  /** USDC (NEP-141) used for balances, the faucet and storage registration. */
  usdcContract: string;
  /** Base URL of the gas relayer (apps/relayer); null = every call is a paid wallet transaction. */
  relayerUrl: string | null;
  /**
   * Sandbox dev accounts. Always empty unless the network is "sandbox" and the
   * RPC URL is on localhost or 127.0.0.1 (see devSignerAllowed).
   */
  devAccounts: DevAccount[];
  /** sha256 of our reproducible sealer build (enclave/res), 64 lowercase hex; null when not set. */
  expectedCodeHash: string | null;
  /** Block explorer base URL; null on a sandbox. */
  explorerUrl: string | null;
};

export type AppConfig = { mode: "mock" } | { mode: "near"; near: NearConfig };

/** The NEXT_PUBLIC_* variables this module reads. */
export type PublicEnv = {
  NEXT_PUBLIC_FAIRGROUND_CONTRACT?: string;
  NEXT_PUBLIC_NEAR_NETWORK?: string;
  NEXT_PUBLIC_NEAR_RPC_URL?: string;
  NEXT_PUBLIC_USDC_CONTRACT?: string;
  NEXT_PUBLIC_RELAYER_URL?: string;
  NEXT_PUBLIC_DEV_ACCOUNTS?: string;
  NEXT_PUBLIC_SEALER_CODE_HASH?: string;
};

/** A NEXT_PUBLIC_* value that is unusable. The message names the variable. */
export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

const DEFAULT_RPC: Record<NearNetwork, string> = {
  mainnet: "https://rpc.mainnet.fastnear.com",
  testnet: "https://rpc.testnet.fastnear.com",
  sandbox: "http://127.0.0.1:3030",
};

/** Circle's native USDC on mainnet, and the open test USDC on testnet. A sandbox has no default. */
const DEFAULT_USDC: Record<NearNetwork, string | null> = {
  mainnet: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  testnet: "usdc.fakes.testnet",
  sandbox: null,
};

const EXPLORER: Record<NearNetwork, string | null> = {
  mainnet: "https://nearblocks.io",
  testnet: "https://testnet.nearblocks.io",
  sandbox: null,
};

/** NEAR account ids: 2-64 chars, lowercase alphanumeric parts joined by `-`/`_`, dot-separated. */
export const ACCOUNT_ID = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

/** Hosts a dev signer may talk to. Nothing else counts as a local sandbox. */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

/**
 * True only for a sandbox network whose RPC URL is on localhost or 127.0.0.1.
 * Dev accounts hold plain secret keys in the browser bundle, so they must never
 * sign on testnet or mainnet: this is checked when the config is parsed and
 * again before a dev signer is built (near/dev-signer.ts).
 */
export function devSignerAllowed(c: { network: string; rpcUrl: string }): boolean {
  if (c.network !== "sandbox") return false;
  let url: URL;
  try {
    url = new URL(c.rpcUrl);
  } catch {
    return false;
  }
  return (url.protocol === "http:" || url.protocol === "https:") && LOCAL_HOSTS.has(url.hostname);
}

/**
 * `alice.test.near=ed25519:5Kd...,bob.test.near=ed25519:3Fz...` (commas, semicolons
 * or whitespace between entries). Throws ConfigError on a malformed entry, without
 * echoing the key.
 */
export function parseDevAccounts(raw: string | undefined): DevAccount[] {
  if (!raw || !raw.trim()) return [];
  const out: DevAccount[] = [];
  for (const entry of raw.split(/[\s,;]+/).filter(Boolean)) {
    const eq = entry.indexOf("=");
    const accountId = eq > 0 ? entry.slice(0, eq) : "";
    const secretKey = eq > 0 ? entry.slice(eq + 1) : "";
    if (!ACCOUNT_ID.test(accountId) || !/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,}$/.test(secretKey)) {
      throw new ConfigError(
        `NEXT_PUBLIC_DEV_ACCOUNTS: each entry must be <account_id>=ed25519:<base58 secret key> (entry ${out.length + 1} is not)`,
      );
    }
    if (out.some((a) => a.accountId === accountId)) {
      throw new ConfigError(`NEXT_PUBLIC_DEV_ACCOUNTS lists ${accountId} twice`);
    }
    out.push({ accountId, secretKey });
  }
  return out;
}

const clean = (v: string | undefined) => {
  const t = v?.trim();
  return t ? t : undefined;
};

/** Parses the public env. Pure, so tests can feed it any env. */
export function parseConfig(env: PublicEnv): AppConfig {
  const contractId = clean(env.NEXT_PUBLIC_FAIRGROUND_CONTRACT);
  if (!contractId) return { mode: "mock" };
  if (!ACCOUNT_ID.test(contractId)) {
    throw new ConfigError("NEXT_PUBLIC_FAIRGROUND_CONTRACT must be a NEAR account id");
  }

  const networkRaw = clean(env.NEXT_PUBLIC_NEAR_NETWORK) ?? "testnet";
  if (networkRaw !== "mainnet" && networkRaw !== "testnet" && networkRaw !== "sandbox") {
    throw new ConfigError('NEXT_PUBLIC_NEAR_NETWORK must be "testnet", "mainnet" or "sandbox"');
  }
  const network: NearNetwork = networkRaw;

  const rpcUrl = clean(env.NEXT_PUBLIC_NEAR_RPC_URL) ?? DEFAULT_RPC[network];
  try {
    const u = new URL(rpcUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("protocol");
  } catch {
    throw new ConfigError("NEXT_PUBLIC_NEAR_RPC_URL must be an http(s) URL");
  }

  const usdcContract = clean(env.NEXT_PUBLIC_USDC_CONTRACT) ?? DEFAULT_USDC[network];
  if (!usdcContract || !ACCOUNT_ID.test(usdcContract)) {
    throw new ConfigError("NEXT_PUBLIC_USDC_CONTRACT must be a NEAR account id (required on a sandbox)");
  }

  const relayerUrl = clean(env.NEXT_PUBLIC_RELAYER_URL) ?? null;
  if (relayerUrl !== null && !/^(https?:\/\/|\/)/.test(relayerUrl)) {
    throw new ConfigError("NEXT_PUBLIC_RELAYER_URL must be an http(s) URL or a same-origin path");
  }

  const hash = clean(env.NEXT_PUBLIC_SEALER_CODE_HASH)?.toLowerCase() ?? null;
  if (hash !== null && !/^[0-9a-f]{64}$/.test(hash)) {
    throw new ConfigError("NEXT_PUBLIC_SEALER_CODE_HASH must be 64 hex characters");
  }

  // Parsed for its errors either way, kept only where a dev signer is allowed.
  const devAccounts = parseDevAccounts(env.NEXT_PUBLIC_DEV_ACCOUNTS);
  const allowed = devSignerAllowed({ network, rpcUrl });

  return {
    mode: "near",
    near: {
      network,
      rpcUrl,
      contractId,
      usdcContract,
      relayerUrl,
      devAccounts: allowed ? devAccounts : [],
      expectedCodeHash: hash,
      explorerUrl: EXPLORER[network],
    },
  };
}

let cached: AppConfig | null = null;

/** The app's config. Throws ConfigError when a NEXT_PUBLIC_* value is unusable. */
export function appConfig(): AppConfig {
  cached ??= parseConfig({
    NEXT_PUBLIC_FAIRGROUND_CONTRACT: process.env.NEXT_PUBLIC_FAIRGROUND_CONTRACT,
    NEXT_PUBLIC_NEAR_NETWORK: process.env.NEXT_PUBLIC_NEAR_NETWORK,
    NEXT_PUBLIC_NEAR_RPC_URL: process.env.NEXT_PUBLIC_NEAR_RPC_URL,
    NEXT_PUBLIC_USDC_CONTRACT: process.env.NEXT_PUBLIC_USDC_CONTRACT,
    NEXT_PUBLIC_RELAYER_URL: process.env.NEXT_PUBLIC_RELAYER_URL,
    NEXT_PUBLIC_DEV_ACCOUNTS: process.env.NEXT_PUBLIC_DEV_ACCOUNTS,
    NEXT_PUBLIC_SEALER_CODE_HASH: process.env.NEXT_PUBLIC_SEALER_CODE_HASH,
  });
  return cached;
}

/** True when the app runs against a real NEAR contract (NEXT_PUBLIC_FAIRGROUND_CONTRACT is set). */
export function isNearMode(): boolean {
  return !!clean(process.env.NEXT_PUBLIC_FAIRGROUND_CONTRACT);
}

/** The NEAR config; throws in mock mode. */
export function nearConfig(): NearConfig {
  const c = appConfig();
  if (c.mode !== "near") throw new ConfigError("not in NEAR mode: NEXT_PUBLIC_FAIRGROUND_CONTRACT is not set");
  return c.near;
}
