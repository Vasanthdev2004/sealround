/**
 * How a tool reaches the chain: the live bot's own `connect` (scripts/live-bot/bot.ts),
 * so every check before signing is the one `live-bot bid` runs, in the same
 * order: mainnet needs an explicit opt-in, the RPC must serve the configured
 * network (`status` chain_id), the contract must answer get_config, the sale
 * must exist, the quote token's units must be readable, and the key must be a
 * full-access key of the account on that network. The client it builds is the
 * web app's NearClient with the bot's key-pair signer.
 *
 * The checks this server can make without the network run first, worded for
 * an MCP client (environment variables and tool arguments, not CLI flags).
 * The live bot's own messages name its flags; `toolText` rewrites them.
 */
import { BotError, connect, describe, errorText, type BotOptions, type Session } from "../live-bot/bot";
import { FairgroundError } from "../../src/lib/client/errors";
import { SALE_ID } from "../../src/lib/client/rules";
import { createRpc, type NearRpc } from "../../src/lib/near/rpc";
import { ENV, MCP_DIR, ToolError, type ServerConfig } from "./config";
import path from "node:path";

/** The live bot's flags, in this server's terms. */
const TERMS: Record<string, string> = {
  "--network": ENV.network,
  "--rpc": ENV.rpc,
  "--contract": ENV.contract,
  "--account": ENV.account,
  "--key-file": ENV.keyFile,
  "--relayer": ENV.relayer,
  "--yes-mainnet": `${ENV.allowMainnet}=1`,
  "--sale": "sale_id",
  "--budget": "max_deposit",
  "--deposit": "deposit",
  "--max-price": "max_price",
  "--max-spend": "max_spend",
  "--direct": "direct: true",
  "--wait": "wait_seconds",
  "--max-wait": "wait_seconds",
};

/** A live-bot message in this server's words. */
export function toolText(message: string): string {
  return message
    .replace(/ \(or LIVE_BOT_[A-Z_]+\)/g, "")
    .replace(/--[a-z][a-z-]*/g, (flag) => TERMS[flag] ?? flag)
    .replace(/LIVE_BOT_PRIVATE_KEY/g, ENV.key)
    .replace(/the status command|with status/g, "with sealround_my_bid");
}

/** Any error as a ToolError. A live-bot refusal (its exit code 2) and a client check that failed before signing sent nothing. */
export function asToolError(e: unknown): ToolError {
  if (e instanceof ToolError) return e;
  if (e instanceof BotError) {
    return new ToolError(e.code, toolText(e.message), e.exitCode === 2 ? { nothingSent: true } : {});
  }
  if (e instanceof FairgroundError) {
    const before = e.code === "invalid" || e.code === "cancelled" || e.code === "not_connected" || e.code === "relayer_refused";
    return new ToolError(e.reason && e.code === "invalid" ? e.reason : e.code, describe(e), {
      ...(before ? { nothingSent: true } : {}),
      ...(e.maybeSubmitted ? { maybeSubmitted: true } : {}),
      ...(e.txHash ? { txHash: e.txHash } : {}),
      ...(e.requestId ? { relayerRequestId: e.requestId } : {}),
    });
  }
  return new ToolError("error", errorText(e));
}

export type Need = {
  /** The configured account must exist (and be set). */
  account?: boolean;
  /** A write: the key must be present and be a full-access key of the account. */
  write?: boolean;
  /** place_bid: the quote token's metadata must be readable. */
  quoteMetadata?: boolean;
  /** place_bid through the relayer: a bid that cannot be sponsored is refused, never paid. */
  sponsoredOnly?: boolean;
};

export function requireSaleId(saleId: string): string {
  const id = saleId.trim();
  if (!SALE_ID.test(id)) throw new ToolError("usage", `sale_id must be a sale id: 1-32 of a-z 0-9 _ - (got "${saleId}").`, { nothingSent: true });
  return id;
}

/** The live bot's options for this server's config and one sale. */
function botOptions(cfg: ServerConfig, saleId: string, account: string | null, write: boolean, notes: string[], extra: Partial<BotOptions>): BotOptions {
  return {
    network: cfg.network,
    rpcUrl: cfg.rpcUrl,
    contractId: cfg.contractId,
    saleId,
    accountId: account,
    secretKey: write ? cfg.key.reveal() : null,
    keySource: write ? cfg.key.source : null,
    relayerUrl: cfg.relayerUrl,
    deposit: null,
    maxPrice: null,
    maxSpend: null,
    victim: null,
    // Only read by the bot's snipe and reveal receipts; this server keeps its own bid secrets.
    receiptDir: path.join(MCP_DIR, ".run", "unused-receipts"),
    pollMs: 500,
    maxWaitMs: 1_000,
    // Reads are allowed on mainnet (verify-sale reads mainnet without a flag); writes are checked below first.
    allowMainnet: write ? cfg.allowMainnet : true,
    claim: false,
    wait: false,
    say: (line) => {
      notes.push(toolText(line));
      process.stderr.write(`[sealround-mcp] ${toolText(line)}\n`);
    },
    ...extra,
  };
}

/**
 * Checks what can be checked without the network, then runs the live bot's
 * connect for `saleId`. `account` overrides the configured account for reads.
 */
export async function openSale(
  cfg: ServerConfig,
  saleIdInput: string,
  need: Need,
  notes: string[],
  opts: { account?: string | null; extra?: Partial<BotOptions> } = {},
): Promise<Session> {
  const saleId = requireSaleId(saleIdInput);
  const account = opts.account === undefined ? cfg.accountId : opts.account;
  if (need.write) refuseWriteLocally(cfg);
  if ((need.account || need.write) && !account) {
    throw new ToolError("usage", `No account configured: set ${ENV.account} (or ${ENV.keyFile}, whose account_id is used).`, { nothingSent: true });
  }
  try {
    return await connect(botOptions(cfg, saleId, account, !!need.write, notes, opts.extra ?? {}), {
      account: !!(need.account || need.write),
      key: !!need.write,
      quoteMetadata: need.quoteMetadata,
      sponsoredOnly: need.sponsoredOnly,
    });
  } catch (e) {
    throw asToolError(e);
  }
}

/** The checks a write makes before anything goes over the network: mainnet opt-in, a key. */
export function refuseWriteLocally(cfg: ServerConfig): void {
  if (cfg.network === "mainnet" && !cfg.allowMainnet) {
    throw new ToolError(
      "mainnet_not_confirmed",
      `This would act on mainnet, with real funds. The server refuses mainnet writes unless ${ENV.allowMainnet}=1 is set in its environment.`,
      { nothingSent: true },
    );
  }
  if (cfg.key.problem) throw new ToolError(cfg.key.problem.code, cfg.key.problem.message, { nothingSent: true });
  if (!cfg.key.present) {
    throw new ToolError(
      "missing_key",
      `No key for the account. Set ${ENV.key} (ed25519:...) or ${ENV.keyFile} (a near-cli credentials JSON) in the server's environment. Read-only tools work without it.`,
      { nothingSent: true },
    );
  }
}

// ---------------------------------------------------------------- chain without a sale

/** The node refused a request (as opposed to not answering). */
class RpcRefused extends Error {}

async function rawRpc<T>(url: string, method: string, params: unknown): Promise<T> {
  let body: { result?: T; error?: unknown };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "sealround-mcp", method, params }),
      signal: AbortSignal.timeout(20_000),
    });
    body = (await res.json()) as typeof body;
  } catch (e) {
    throw new ToolError("rpc_unreachable", `Could not reach the NEAR RPC at ${url} (${errorText(e)}).`);
  }
  if (body.error) throw new RpcRefused(`${method}: ${JSON.stringify(body.error).slice(0, 300)}`);
  return body.result as T;
}

/**
 * For the tools that name no sale (list_sales): the same first checks as the
 * live bot's connect: the RPC serves the configured network, and the contract
 * exists and answers get_config.
 */
export async function openChain(cfg: ServerConfig): Promise<{ chainId: string; rpc: NearRpc }> {
  const { chain_id: chainId } = await rawRpc<{ chain_id: string }>(cfg.rpcUrl, "status", []).catch((e: unknown) => {
    throw e instanceof ToolError ? e : new ToolError("rpc_unreachable", `The RPC at ${cfg.rpcUrl} did not answer status (${errorText(e)}).`);
  });
  const publicChain = chainId === "testnet" || chainId === "mainnet";
  if (cfg.network === "sandbox" ? publicChain : chainId !== cfg.network) {
    throw new ToolError(
      "wrong_network",
      `The RPC at ${cfg.rpcUrl} serves the chain "${chainId}", but ${ENV.network} is ${cfg.network}. Check ${ENV.network} and ${ENV.rpc}.`,
    );
  }
  try {
    await rawRpc(cfg.rpcUrl, "query", { request_type: "view_account", finality: "optimistic", account_id: cfg.contractId });
  } catch (e) {
    if (e instanceof RpcRefused) {
      throw new ToolError("contract_not_found", `There is no account ${cfg.contractId} on ${cfg.network} (chain "${chainId}"). Check ${ENV.network} and ${ENV.contract}.`);
    }
    throw e;
  }
  const rpc = createRpc(cfg.rpcUrl);
  try {
    await rpc.view<unknown>(cfg.contractId, "get_config");
  } catch (e) {
    throw new ToolError("not_fairground", `${cfg.contractId} does not answer get_config, so it is not a Sealround contract (${errorText(e)}).`);
  }
  return { chainId, rpc };
}
