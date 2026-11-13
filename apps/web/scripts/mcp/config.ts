/**
 * The MCP server's settings. They come from the environment only: an MCP
 * client starts the server with the `env` of its config entry, and a key
 * there never lands in a shell history or in a tool argument.
 *
 *   SEALROUND_NETWORK        sandbox | testnet | mainnet (required)
 *   SEALROUND_CONTRACT       the Sealround contract account (required)
 *   SEALROUND_RPC_URL        default: the network's public RPC (http://127.0.0.1:3030 on a sandbox)
 *   SEALROUND_RELAYER_URL    the gas relayer; without it every write needs `direct: true`
 *   SEALROUND_ACCOUNT        the account that bids and claims (or the key file's account_id)
 *   SEALROUND_PRIVATE_KEY    its full-access key, "ed25519:..."; or
 *   SEALROUND_KEY_FILE       a near-cli credentials JSON file holding it
 *   SEALROUND_ALLOW_MAINNET  1 to allow place_bid and claim on mainnet
 *   SEALROUND_SECRET_DIR     where place_bid saves bid secret files (default scripts/mcp/.run/bid-secrets)
 *
 * The key is read once, kept in a private field, and never logged, returned
 * or put in an error message. Every tool result is also passed through
 * `redact` before it leaves the process, in case some message quoted it.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { ACCOUNT_ID, type NearNetwork } from "../../src/lib/config";
import { DEFAULT_RPC } from "../live-bot/bot";

export const ENV = {
  network: "SEALROUND_NETWORK",
  contract: "SEALROUND_CONTRACT",
  rpc: "SEALROUND_RPC_URL",
  relayer: "SEALROUND_RELAYER_URL",
  account: "SEALROUND_ACCOUNT",
  key: "SEALROUND_PRIVATE_KEY",
  keyFile: "SEALROUND_KEY_FILE",
  allowMainnet: "SEALROUND_ALLOW_MAINNET",
  secretDir: "SEALROUND_SECRET_DIR",
} as const;

/** This folder. tsx loads the scripts as CommonJS, where __dirname exists (see scripts/e2e/chain.ts). */
export const MCP_DIR = typeof __dirname === "string" ? __dirname : path.resolve("scripts/mcp");

/** A refusal or failure a tool reports: a code to switch on and a plain message. */
export class ToolError extends Error {
  override readonly name = "ToolError";
  constructor(
    readonly code: string,
    message: string,
    /** Extra fields for the error object: nothingSent, maybeSubmitted, txHash, secretFile... */
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** The account key: held in a private field, so JSON.stringify and inspection never show it. */
export class AccountKey {
  readonly #secret: string | null;
  /** Where it came from, for messages: an environment variable name or a file path, never the key. */
  readonly source: string | null;
  /** The account id the key file names, if any. */
  readonly fileAccount: string | null;
  /** Why the key could not be read; reported by the tools that need it. */
  readonly problem: ToolError | null;

  constructor(env: NodeJS.ProcessEnv) {
    const fromEnv = env[ENV.key]?.trim() || null;
    const file = env[ENV.keyFile]?.trim() || null;
    let secret: string | null = null;
    let source: string | null = null;
    let fileAccount: string | null = null;
    let problem: ToolError | null = null;
    if (fromEnv && file) {
      problem = new ToolError("config", `Both ${ENV.key} and ${ENV.keyFile} are set: use one.`);
    } else if (fromEnv) {
      [secret, source] = [fromEnv, ENV.key];
    } else if (file) {
      source = `the key file ${file}`;
      try {
        const parsed = JSON.parse(readFileSync(file, "utf8")) as { account_id?: unknown; private_key?: unknown; secret_key?: unknown };
        const value = parsed.private_key ?? parsed.secret_key;
        if (typeof value !== "string" || !value.trim()) problem = new ToolError("bad_key", `The key file ${file} has no "private_key".`);
        else secret = value.trim();
        fileAccount = typeof parsed.account_id === "string" ? parsed.account_id : null;
      } catch {
        problem = new ToolError("bad_key", `Could not read the key file ${file} as near-cli credentials JSON.`);
      }
    }
    this.#secret = secret;
    this.source = source;
    this.fileAccount = fileAccount;
    this.problem = problem;
  }

  get present(): boolean {
    return this.#secret !== null;
  }

  /** The key, for the live bot's connect() only. */
  reveal(): string | null {
    return this.#secret;
  }

  /** `text` with every copy of the key (whole, or its base58 part) replaced. */
  redact(text: string): string {
    const secret = this.#secret;
    if (!secret) return text;
    let out = text.split(secret).join("[redacted key]");
    const body = secret.includes(":") ? secret.slice(secret.indexOf(":") + 1) : secret;
    if (body.length >= 16) out = out.split(body).join("[redacted key]");
    return out;
  }

  toJSON(): Record<string, unknown> {
    return { present: this.present, source: this.source };
  }
}

export type ServerConfig = {
  network: NearNetwork;
  rpcUrl: string;
  contractId: string;
  relayerUrl: string | null;
  /** The account that bids and claims; null when none is configured. */
  accountId: string | null;
  allowMainnet: boolean;
  secretDir: string;
  key: AccountKey;
};

/** The settings, or what is wrong with them. `key` is there either way, so every answer can be redacted. */
export type LoadedConfig = { config: ServerConfig; problem: null; key: AccountKey } | { config: null; problem: ToolError; key: AccountKey };

const httpUrl = (v: string) => {
  try {
    return /^https?:$/.test(new URL(v).protocol);
  } catch {
    return false;
  }
};

/** Reads the settings. A problem is kept and reported by every tool call, so the server still starts and can say what is wrong. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): LoadedConfig {
  const key = new AccountKey(env);
  const value = (name: string) => env[name]?.trim() || null;
  const fail = (message: string): LoadedConfig => ({ config: null, problem: new ToolError("config", message), key });

  const network = value(ENV.network);
  if (network !== "sandbox" && network !== "testnet" && network !== "mainnet") {
    return fail(`${ENV.network} must be sandbox, testnet or mainnet${network ? ` (got "${network}")` : ""}.`);
  }
  const contractId = value(ENV.contract);
  if (!contractId || !ACCOUNT_ID.test(contractId)) {
    return fail(`${ENV.contract} must be the Sealround contract's account id${contractId ? ` (got "${contractId}")` : ""}.`);
  }
  const rpcUrl = value(ENV.rpc) ?? DEFAULT_RPC[network];
  if (!httpUrl(rpcUrl)) return fail(`${ENV.rpc} must be an http(s) URL (got "${rpcUrl}").`);
  const relayerUrl = value(ENV.relayer);
  if (relayerUrl !== null && !httpUrl(relayerUrl)) return fail(`${ENV.relayer} must be an http(s) URL (got "${relayerUrl}").`);
  const accountId = value(ENV.account) ?? key.fileAccount;
  if (accountId !== null && !ACCOUNT_ID.test(accountId)) return fail(`${ENV.account} must be a NEAR account id (got "${accountId}").`);
  if (key.fileAccount && accountId !== key.fileAccount) {
    return fail(`The key file belongs to ${key.fileAccount}, not to ${ENV.account} ${accountId}.`);
  }
  return {
    config: {
      network,
      rpcUrl,
      contractId,
      relayerUrl,
      accountId,
      allowMainnet: /^(1|true|yes)$/i.test(value(ENV.allowMainnet) ?? ""),
      secretDir: path.resolve(value(ENV.secretDir) ?? path.join(MCP_DIR, ".run", "bid-secrets")),
      key,
    },
    problem: null,
    key,
  };
}
