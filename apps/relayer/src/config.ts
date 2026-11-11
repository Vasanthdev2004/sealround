/**
 * Configuration from environment variables, validated once at startup. Every
 * problem is reported at once, and the private key's value never appears in an
 * error message.
 */
import { KeyPair, teraToGas, type KeyPairString } from "near-api-js";
import type { RelayPolicy } from "./policy.ts";

export const NETWORKS = ["sandbox", "testnet", "mainnet"] as const;
export type Network = (typeof NETWORKS)[number];

export interface Limits {
  relaysPerSenderPerHour: number;
  requestsPerIpPerHour: number;
  storagePerIpPerDay: number;
  /** Hard cap on what relays cost per UTC day, in yoctoNEAR. */
  dailyBudget: bigint;
  /** Hard cap on what storage registrations cost per UTC day, in yoctoNEAR; separate, so they can never use up the budget bids rely on. */
  storageBudget: bigint;
}

export interface RelayerConfig {
  network: Network;
  rpcUrl: string;
  relayerAccountId: string;
  /** Full-access key of the relayer account; signs every transaction it pays for. Never logged. */
  relayerKey: KeyPair;
  policy: RelayPolicy;
  limits: Limits;
  /** How long /relay and /storage wait for the outcome once the transaction is in a block, before answering "pending"; 0 answers as soon as it is. */
  relayWaitMs: number;
  port: number;
  /** Browser origins allowed to call the relayer; empty means no CORS headers. */
  corsOrigins: string[];
  /** Header carrying the client IP behind a trusted proxy (`x-real-ip` on Vercel); unset means the socket address. */
  clientIpHeader: string | undefined;
  /** How many trusted proxies append to `clientIpHeader`: the client is that many entries from the right. */
  trustedProxyHops: number;
}

export class ConfigError extends Error {
  override name = "ConfigError";
  constructor(problems: string[]) {
    super(`invalid relayer configuration:\n  - ${problems.join("\n  - ")}`);
  }
}

/** Wallets and relayers cap a transaction at 300 TGas (the protocol allows 1 PGas). */
const MAX_GAS_TGAS = 300;
/**
 * Default cap: the largest call the client builds (claim_proceeds) attaches 150.
 * The relayer must hold gas x 1e9 yocto per transaction in flight (protocol 88's
 * floor price), so a lower cap lets the same balance carry more at once.
 */
const DEFAULT_MAX_GAS_TGAS = 150;
/** A Fairground delegate holds one call; two allow e.g. claiming two sales at once. */
const MAX_ACTIONS = 2;
/** The delegate receipt applies a block or two after the outer transaction lands. */
const MIN_BLOCKS_LEFT = 5;

/** NEAR account id rules: 2-64 chars, lowercase alphanumeric parts joined by `-`/`_`, dot-separated. */
const ACCOUNT_ID = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

export function isAccountId(value: string): boolean {
  return ACCOUNT_ID.test(value);
}

export function loadConfig(env: Record<string, string | undefined>): RelayerConfig {
  const problems: string[] = [];
  const problem = (message: string) => {
    problems.push(message);
    return undefined;
  };

  const text = (name: string, fallback?: string): string | undefined => {
    const value = env[name]?.trim();
    if (value) return value;
    return fallback ?? problem(`${name} is required`);
  };
  const integer = (name: string, fallback: number, min: number, max: number): number => {
    const value = text(name, String(fallback)) ?? "";
    const parsed = /^\d+$/.test(value) ? Number(value) : NaN;
    if (parsed >= min && parsed <= max) return parsed;
    problem(`${name} must be an integer from ${min} to ${max}`);
    return fallback;
  };
  const accountId = (name: string): string => {
    const value = text(name) ?? "";
    if (value && !isAccountId(value)) problem(`${name} is not a valid NEAR account id`);
    return value;
  };

  const network = text("NETWORK") as Network | undefined;
  if (network && !NETWORKS.includes(network)) problem(`NETWORK must be one of ${NETWORKS.join(", ")}`);

  const rpcUrl = text("NEAR_RPC_URL") ?? "";
  if (rpcUrl && !/^https?:$/.test(safeUrl(rpcUrl)?.protocol ?? "")) problem("NEAR_RPC_URL must be an http(s) URL");

  const relayerAccountId = accountId("RELAYER_ACCOUNT_ID");
  const relayerKey = parseKey(text("RELAYER_PRIVATE_KEY"), problem);
  const fairgroundContract = accountId("FAIRGROUND_CONTRACT");

  const usdcContracts = (text("USDC_CONTRACTS") ?? "").split(",").map((id) => id.trim()).filter(Boolean);
  for (const id of usdcContracts) if (!isAccountId(id)) problem(`USDC_CONTRACTS: "${id}" is not a valid NEAR account id`);
  if (env["USDC_CONTRACTS"] && usdcContracts.length === 0) problem("USDC_CONTRACTS must list at least one token");

  const corsOrigins = (env["CORS_ORIGINS"] ?? "").split(",").map((origin) => origin.trim()).filter(Boolean);
  for (const origin of corsOrigins) {
    if (safeUrl(origin)?.origin !== origin) problem(`CORS_ORIGINS: "${origin}" is not an origin like https://app.example`);
  }

  const clientIpHeader = env["CLIENT_IP_HEADER"]?.trim().toLowerCase() || undefined;
  if (clientIpHeader && !/^[a-z0-9-]+$/.test(clientIpHeader)) problem("CLIENT_IP_HEADER must be a header name");
  const trustedProxyHops = integer("TRUSTED_PROXY_HOPS", 1, 1, 10);

  const near = (name: string, fallback: string): bigint => {
    const amount = parseNear(text(name, fallback) ?? "");
    if (amount === undefined) problem(`${name} must be a NEAR amount such as 5 or 0.5`);
    return amount ?? 0n;
  };

  const policy: RelayPolicy = {
    relayerAccountId,
    fairgroundContract,
    usdcContracts,
    maxGas: teraToGas(integer("MAX_GAS_TGAS", DEFAULT_MAX_GAS_TGAS, 1, MAX_GAS_TGAS)),
    maxActions: MAX_ACTIONS,
    minBlocksLeft: BigInt(MIN_BLOCKS_LEFT),
    maxDelegateBlocks: BigInt(integer("MAX_DELEGATE_BLOCKS", 1200, MIN_BLOCKS_LEFT, 100_000)),
  };
  const limits: Limits = {
    relaysPerSenderPerHour: integer("RELAYS_PER_SENDER_PER_HOUR", 30, 1, 100_000),
    requestsPerIpPerHour: integer("REQUESTS_PER_IP_PER_HOUR", 120, 1, 1_000_000),
    storagePerIpPerDay: integer("STORAGE_PER_IP_PER_DAY", 3, 0, 100_000),
    dailyBudget: near("DAILY_BUDGET_NEAR", "5"),
    storageBudget: near("STORAGE_BUDGET_NEAR", "0.5"),
  };
  const relayWaitMs = integer("RELAY_WAIT_MS", 15_000, 0, 60_000);
  const port = integer("PORT", 8787, 1, 65_535);

  if (problems.length > 0 || !network || !relayerKey) throw new ConfigError(problems);
  return { network, rpcUrl, relayerAccountId, relayerKey, policy, limits, relayWaitMs, port, corsOrigins, clientIpHeader, trustedProxyHops };
}

function parseKey(value: string | undefined, problem: (message: string) => undefined): KeyPair | undefined {
  if (value === undefined) return undefined;
  if (!value.startsWith("ed25519:")) return problem("RELAYER_PRIVATE_KEY must be an ed25519:... secret key");
  try {
    return KeyPair.fromString(value as KeyPairString);
  } catch {
    return problem("RELAYER_PRIVATE_KEY is not a valid ed25519 secret key");
  }
}

/** "1.5" NEAR -> yoctoNEAR (10^24), exactly, with no floating point. */
export function parseNear(value: string): bigint | undefined {
  const match = /^(\d+)(?:\.(\d{1,24}))?$/.exec(value);
  if (!match) return undefined;
  const [, whole = "0", fraction = ""] = match;
  return BigInt(whole) * 10n ** 24n + BigInt(fraction.padEnd(24, "0"));
}

function safeUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}
