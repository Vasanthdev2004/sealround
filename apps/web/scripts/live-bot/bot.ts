/**
 * The live sniper bot: what each command does. Shared by the CLI (run.ts) and
 * its sandbox test (sandbox-test.ts).
 *
 * The bot drives the code the web app runs in NEAR mode, nothing of its own:
 * - NearClient (src/lib/client/near.ts) for every write, with its checks
 *   before signing, the relayed (gasless) path and the paid fallback;
 * - the bid sealing and commitments of src/lib/crypto.ts, so the sealed-bid
 *   format is the one the app, the relayer, the contract and the enclave share;
 * - the relayer client's key-pair signer and action builders;
 * - @fairground/clearing's costOf for the price check in `report`.
 *
 * The bot's key comes from LIVE_BOT_PRIVATE_KEY or a near-cli credentials
 * file (see run.ts), lives only in this process, and is never printed.
 *
 * Every amount is checked and printed in base units as well as in readable
 * form: USDC has 6 decimals, sale tokens usually 18, prices are USDC base
 * units per whole token (what the contract stores).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { costOf, formatUnits, parseUnits, U128_MAX } from "@fairground/clearing";
import {
  bidOutcome,
  createRelayerClient,
  keyPairSigner,
  RelayerError,
  sealedBidLength,
  summarizeOutcome,
  type ActionSigner,
  type FairgroundAction,
} from "@fairground/relayer-client";
import { JsonRpcProvider, KeyPair, type KeyPairString } from "near-api-js";
import { FairgroundError } from "../../src/lib/client/errors";
import { NearClient } from "../../src/lib/client/near";
import { bidTermsProblem, invalidBidPenalty, SALE_ID } from "../../src/lib/client/rules";
import { ACCOUNT_ID, parseConfig, type NearNetwork } from "../../src/lib/config";
import { bidCommitment, fromB64, randomHex, sealBid, sealedBidLen, sha256Hex, toHex } from "../../src/lib/crypto";
import { createRpc, type NearRpc } from "../../src/lib/near/rpc";
import { staticSigners } from "../../src/lib/near/signers";
import type { BidView, ResultView, SaleView } from "../../src/lib/near/views";
import type { BidResult } from "../../src/lib/types";
import { REPO_DIR } from "../e2e/chain";

const TGAS = 1_000_000_000_000n;
const MS = 1_000_000n;
const FINAL = ["settled", "failed"];
const BIDDABLE = ["setup", "upcoming", "open"];

/** The RPC each network uses when --rpc is not given: the defaults of src/lib/config.ts. */
export const DEFAULT_RPC: Record<NearNetwork, string> = {
  mainnet: "https://rpc.mainnet.fastnear.com",
  testnet: "https://rpc.testnet.fastnear.com",
  sandbox: "http://127.0.0.1:3030",
};

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- errors

export type BotErrorCode =
  | "usage"
  | "missing_key"
  | "bad_key"
  | "key_mismatch"
  | "mainnet_not_confirmed"
  | "wrong_network"
  | "rpc_unreachable"
  | "contract_not_found"
  | "not_fairground"
  | "account_not_found"
  | "sale_not_found"
  | "sale_closed"
  | "not_settled"
  | "already_bid"
  | "no_bid"
  | "no_receipt"
  | "invalid_terms"
  | "over_budget"
  | "insufficient_usdc"
  | "victim_has_no_bid"
  | "timeout"
  | "bid_failed"
  | "claim_failed"
  | "reveal_failed";

/** A failure the bot explains in plain words. Exit code 2: refused before anything was sent; 1: failed on the way. */
export class BotError extends Error {
  override readonly name = "BotError";
  readonly code: BotErrorCode;
  readonly exitCode: number;

  constructor(code: BotErrorCode, message: string, exitCode = 2) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
  }
}

const usage = (message: string) => new BotError("usage", message);
export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A FairgroundError (the app client's) in one line: its message, code, reason and transaction. */
export function describe(e: unknown): string {
  if (!(e instanceof FairgroundError)) return errorText(e);
  const tags = [e.code, e.reason].filter(Boolean).join(": ");
  return `${e.message} [${tags}]${e.txHash ? ` tx ${e.txHash}` : ""}`;
}

// ---------------------------------------------------------------- options

export type BotOptions = {
  network: NearNetwork;
  rpcUrl: string;
  contractId: string;
  saleId: string;
  /** The bot's account (whose fill `report` reads). */
  accountId: string | null;
  /** The bot's secret key ("ed25519:..."), from LIVE_BOT_PRIVATE_KEY or a key file. Never from a flag. */
  secretKey: string | null;
  /** Where the key came from, for messages: never the key itself. */
  keySource: string | null;
  /** The gas relayer; null = the bot signs and pays every call itself. */
  relayerUrl: string | null;
  /** Readable amounts as given ("5", "0.02"), parsed with the quote token's decimals. */
  deposit: string | null;
  maxPrice: string | null;
  maxSpend: string | null;
  /** copycat: whose sealed bid to replay. */
  victim: string | null;
  /** Where snipe and copycat keep their receipts (the bid's terms and salt). */
  receiptDir: string;
  pollMs: number;
  maxWaitMs: number;
  allowMainnet: boolean;
  /** report: claim the bot's tokens and refund if not claimed yet. */
  claim: boolean;
  /** report and reveal: wait for the sale to reach the right phase instead of refusing. */
  wait: boolean;
  /** Progress lines. */
  say: (line: string) => void;
};

// ---------------------------------------------------------------- raw RPC

/** The node refused a request (an unknown account or access key, a failed query). */
class RpcFailure extends Error {
  override readonly name = "RpcFailure";
}

/** One JSON-RPC call for what the app's reader (near/rpc.ts) does not cover: status, accounts, keys, blocks, transactions. */
async function rpcCall<T>(url: string, method: string, params: unknown): Promise<T> {
  let body: { result?: T & { error?: unknown }; error?: unknown };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "live-bot", method, params }),
      signal: AbortSignal.timeout(20_000),
    });
    body = (await res.json()) as typeof body;
  } catch (e) {
    throw new BotError("rpc_unreachable", `Could not reach the NEAR RPC at ${url} (${errorText(e)}).`, 1);
  }
  if (body.error) throw new RpcFailure(`${method}: ${JSON.stringify(body.error).slice(0, 300)}`);
  // Older nodes report a failed query inside the result.
  if (body.result && typeof body.result.error === "string") throw new RpcFailure(`${method}: ${body.result.error.slice(0, 300)}`);
  return body.result as T;
}

export type Head = { height: number; timeNs: bigint };

export async function chainHead(url: string): Promise<Head> {
  const block = await rpcCall<{ header: { height: number; timestamp_nanosec: string } }>(url, "block", { finality: "optimistic" });
  return { height: block.header.height, timeNs: BigInt(block.header.timestamp_nanosec) };
}

async function accountExists(url: string, accountId: string): Promise<boolean> {
  try {
    await rpcCall(url, "query", { request_type: "view_account", finality: "optimistic", account_id: accountId });
    return true;
  } catch (e) {
    if (e instanceof RpcFailure) return false;
    throw e;
  }
}

async function nearBalance(url: string, accountId: string): Promise<bigint> {
  const account = await rpcCall<{ amount: string }>(url, "query", { request_type: "view_account", finality: "optimistic", account_id: accountId });
  return BigInt(account.amount);
}

// ---------------------------------------------------------------- session

export type Quote = { id: string; decimals: number; symbol: string };

/** Everything a command needs, checked once: the right chain, the contract, the sale, the bot's key. */
export type Session = {
  opts: BotOptions;
  chainId: string;
  rpc: NearRpc;
  sale: SaleView;
  quote: Quote;
  /** The web app's NEAR client, signing as the bot (when a key was given). */
  client: NearClient;
  signer: ActionSigner | null;
  /** The relayer's account, from its policy: the signer of the bot's relayed transactions. */
  relayerAccount: string | null;
  /** sha256 of enclave/res/fairground_sealer.wasm as this repository pins it, if the file is there. */
  repoSealerHash: string | null;
};

function repoSealerHash(): string | null {
  try {
    const pin = readFileSync(path.join(REPO_DIR, "enclave", "res", "fairground_sealer.wasm.sha256"), "utf8");
    const hash = pin.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
    return /^[0-9a-f]{64}$/.test(hash) ? hash : null;
  } catch {
    return null;
  }
}

/** Parses the key without ever putting it in a message. */
function parseKey(opts: BotOptions): KeyPair | null {
  if (!opts.secretKey) return null;
  try {
    if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,}$/.test(opts.secretKey.trim())) throw new Error("shape");
    return KeyPair.fromString(opts.secretKey.trim() as KeyPairString);
  } catch {
    throw new BotError("bad_key", `The key from ${opts.keySource ?? "the environment"} is not an "ed25519:<base58>" secret key (it is not shown here).`);
  }
}

export async function connect(opts: BotOptions, need: {
  account: boolean;
  key: boolean;
  quoteMetadata?: boolean;
  sponsoredOnly?: boolean;
}): Promise<Session> {
  const say = opts.say;
  // Local checks first: nothing goes over the network before they pass.
  if (opts.network === "mainnet" && !opts.allowMainnet) {
    throw new BotError("mainnet_not_confirmed", "This would act on mainnet, with real funds. Add --yes-mainnet to confirm.");
  }
  if (!ACCOUNT_ID.test(opts.contractId)) throw usage(`--contract must be a NEAR account id (got "${opts.contractId}").`);
  if (!SALE_ID.test(opts.saleId)) throw usage(`--sale must be a sale id: 1-32 of a-z 0-9 _ - (got "${opts.saleId}").`);
  if (need.account && !opts.accountId) throw usage("--account (or LIVE_BOT_ACCOUNT) is required: the bot's account id.");
  if (opts.accountId && !ACCOUNT_ID.test(opts.accountId)) throw usage(`--account must be a NEAR account id (got "${opts.accountId}").`);
  if (need.key && !opts.secretKey) {
    throw new BotError(
      "missing_key",
      "No key for the bot account. Put its full-access secret key in the LIVE_BOT_PRIVATE_KEY environment variable (ed25519:...), or pass --key-file <near-cli credentials json>. Never put the key on the command line.",
    );
  }
  const keyPair = need.key ? parseKey(opts) : null;

  // 1. The chain behind the RPC URL is the network the bot was told.
  const { chain_id: chainId } = await rpcCall<{ chain_id: string }>(opts.rpcUrl, "status", []);
  const publicChain = chainId === "testnet" || chainId === "mainnet";
  if (opts.network === "sandbox" ? publicChain : chainId !== opts.network) {
    throw new BotError("wrong_network", `The RPC at ${opts.rpcUrl} serves the chain "${chainId}", but --network is ${opts.network}. Check --network and --rpc.`);
  }

  // 2. The contract is a Sealround contract.
  if (!(await accountExists(opts.rpcUrl, opts.contractId))) {
    throw new BotError("contract_not_found", `There is no account ${opts.contractId} on ${opts.network} (chain "${chainId}"). Wrong --network or --contract?`);
  }
  const rpc = createRpc(opts.rpcUrl);
  try {
    await rpc.view<unknown>(opts.contractId, "get_config");
  } catch (e) {
    throw new BotError("not_fairground", `${opts.contractId} does not answer get_config, so it is not a Sealround contract (${errorText(e)}).`);
  }

  // 3. The sale.
  const sale = await rpc.view<SaleView | null>(opts.contractId, "get_sale", { sale_id: opts.saleId });
  if (!sale) {
    const ids = (await rpc.view<SaleView[]>(opts.contractId, "get_sales", { from_index: 0, limit: 200 }).catch(() => [])).map((s) => s.sale_id);
    throw new BotError(
      "sale_not_found",
      `There is no sale "${opts.saleId}" on ${opts.contractId}.${ids.length > 0 ? ` Sales there: ${ids.slice(-12).join(", ")}.` : " It has no sales yet."}`,
    );
  }
  const meta = await rpc.view<{ decimals: number; symbol: string }>(sale.quote_token, "ft_metadata").catch(() => {
    if (need.quoteMetadata) throw usage("Cannot verify the quote token's units. Check the sale before bidding.");
    return { decimals: 6, symbol: "USDC" };
  });
  if (need.quoteMetadata && (!Number.isInteger(meta.decimals) || meta.decimals < 0 || meta.decimals > 38)) {
    throw usage("The quote token has unsupported decimals.");
  }
  const quote = { id: sale.quote_token, decimals: meta.decimals, symbol: meta.symbol };

  // 4. The bot account and its key: a full-access key of that account.
  if (opts.accountId && need.account && !(await accountExists(opts.rpcUrl, opts.accountId))) {
    throw new BotError("account_not_found", `There is no account ${opts.accountId} on ${opts.network}.`);
  }
  let signer: ActionSigner | null = null;
  if (keyPair && opts.accountId) {
    const publicKey = keyPair.getPublicKey().toString();
    let permission: unknown;
    try {
      permission = (
        await rpcCall<{ permission: unknown }>(opts.rpcUrl, "query", {
          request_type: "view_access_key",
          finality: "optimistic",
          account_id: opts.accountId,
          public_key: publicKey,
        })
      ).permission;
    } catch (e) {
      if (e instanceof RpcFailure) {
        throw new BotError("key_mismatch", `The key from ${opts.keySource} (public key ${publicKey}) is not an access key of ${opts.accountId} on ${opts.network}.`);
      }
      throw e;
    }
    if (permission !== "FullAccess") {
      throw new BotError(
        "key_mismatch",
        `The key from ${opts.keySource} is a function-call key of ${opts.accountId}. A bid is an ft_transfer_call with 1 yoctoNEAR attached, which needs a full-access key.`,
      );
    }
    signer = keyPairSigner({ accountId: opts.accountId, keyPair, provider: new JsonRpcProvider({ url: opts.rpcUrl }) });
  }

  // 5. The app's client, built the way the app builds it from its NEXT_PUBLIC_* values, signing as the bot.
  const config = parseConfig({
    NEXT_PUBLIC_FAIRGROUND_CONTRACT: opts.contractId,
    NEXT_PUBLIC_NEAR_NETWORK: opts.network,
    NEXT_PUBLIC_NEAR_RPC_URL: opts.rpcUrl,
    NEXT_PUBLIC_USDC_CONTRACT: sale.quote_token,
    NEXT_PUBLIC_RELAYER_URL: opts.relayerUrl ?? undefined,
  });
  if (config.mode !== "near") throw usage("the configuration does not select NEAR mode");
  const signers = staticSigners(signer && opts.accountId ? { [opts.accountId]: signer } : {}, opts.accountId ?? undefined);
  const client = new NearClient(config.near, { signers, cacheMs: 0, waitMs: 60_000, pollMs: 500 });
  client.subscribeNotices((n) => {
    if (need.sponsoredOnly && n.kind === "paid_fallback") return;
    say(`note: ${n.message}`);
  });

  let relayerAccount: string | null = null;
  if (opts.relayerUrl && need.key) {
    const policy = await client.getRelayerPolicy();
    const fallback = need.sponsoredOnly ? "the bid requires sponsorship" : "the bot will pay for its own transactions";
    if (!policy) {
      say(`warning: the relayer at ${opts.relayerUrl} did not answer GET /policy; ${fallback}.`);
    } else {
      relayerAccount = policy.relayerAccountId;
      if (!policy.usdcContracts.includes(sale.quote_token)) say(`warning: the relayer does not relay ${sale.quote_token}; ${fallback}.`);
    }
  }
  return { opts, chainId, rpc, sale, quote, client, signer, relayerAccount, repoSealerHash: repoSealerHash() };
}

// ---------------------------------------------------------------- helpers

const freshSale = async (s: Session) => (await s.rpc.view<SaleView | null>(s.opts.contractId, "get_sale", { sale_id: s.opts.saleId }))!;
const bidOf = (s: Session, bidder: string) => s.rpc.view<BidView | null>(s.opts.contractId, "get_bid", { sale_id: s.opts.saleId, bidder });
const ftBalance = async (s: Session, token: string, accountId: string) =>
  BigInt((await s.rpc.view<string | null>(token, "ft_balance_of", { account_id: accountId }).catch(() => "0")) ?? "0");

/** Place one bid in an open enclave sale using the web client's sealing and signing path. */
export async function budgetedBid(s: Session, budgetInput: string) {
  const { opts, sale, quote, client } = s;
  const bidder = opts.accountId!;
  const deposit = amount("--deposit", opts.deposit, quote.decimals);
  const budget = amount("--budget", budgetInput, quote.decimals);
  if (deposit > budget) {
    throw new BotError("over_budget", "The public deposit exceeds --budget. No bid was sent.");
  }
  const maxPrice = amount("--max-price", opts.maxPrice, quote.decimals, { privateLimit: true });
  const maxSpend = opts.maxSpend === null ? deposit : amount("--max-spend", opts.maxSpend, quote.decimals, { privateLimit: true });
  const problem = bidTermsProblem({ maxPrice, maxSpend }, deposit, BigInt(sale.floor_price));
  if (problem || maxPrice > U128_MAX) {
    throw new BotError("invalid_terms", problem ?? "Max price exceeds the supported range.");
  }
  if (sale.reveal_mode !== "Tee") throw usage("bid requires a sale that seals bids to an enclave.");
  if (sale.status !== "open") throw new BotError("sale_closed", `Sale ${sale.sale_id} is ${sale.status}. Bid only while it is open.`);
  if (await bidOf(s, bidder)) throw new BotError("already_bid", `${bidder} already has a bid in ${sale.sale_id}.`);
  if (await ftBalance(s, quote.id, bidder) < deposit) {
    throw new BotError("insufficient_usdc", `${bidder} does not hold enough ${quote.symbol} for the deposit.`);
  }

  let placed: BidResult;
  try {
    placed = await client.bid(sale.sale_id, bidder, deposit, { maxPrice, maxSpend }, {
      onPaidFallback: () => {
        if (opts.relayerUrl) throw new Error("Relayed bid required.");
      },
    });
  } catch (error) {
    if (error instanceof FairgroundError && error.code === "cancelled") {
      throw new BotError("bid_failed", "The relayer could not sponsor the bid. No paid transaction was sent.");
    }
    const requestId = error instanceof FairgroundError ? error.requestId : null;
    const request = requestId ? ` Relayer request: ${requestId}.` : "";
    throw new BotError("bid_failed", `${describe(error)}${request} Check the account's bid with status before retrying.`, 1);
  }
  return {
    command: "bid" as const,
    ok: true,
    network: opts.network,
    contract: opts.contractId,
    saleId: sale.sale_id,
    bidder,
    quote,
    deposit: placed.deposit.toString(),
    index: placed.index,
    txHash: placed.relay?.txHash ?? placed.txHash ?? null,
    paidBy: placed.relay?.paidBy ?? null,
  };
}

/** "1 m 05 s", "3.2 s", "2 h 10 m". */
export function duration(ms: number): string {
  const abs = Math.abs(ms);
  if (abs < 10_000) return `${(ms / 1000).toFixed(abs < 1000 ? 3 : 1)} s`;
  const s = Math.round(abs / 1000);
  const text = s < 3600 ? `${Math.floor(s / 60)} m ${String(s % 60).padStart(2, "0")} s` : `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")} m`;
  return ms < 0 ? `-${text}` : text;
}

/** A readable amount from user input, in base units. */
function amount(flag: string, value: string | null, decimals: number, { privateLimit = false } = {}): bigint {
  if (value === null || value.trim() === "") throw usage(`${flag} is required.`);
  try {
    const v = parseUnits(value, decimals);
    if (v <= 0n) throw new Error("must be above zero");
    return v;
  } catch (e) {
    if (privateLimit) throw usage(`${flag} must be a positive amount with at most ${decimals} decimals.`);
    throw usage(`${flag} "${value}" is not an amount with at most ${decimals} decimals (${errorText(e)}).`);
  }
}

export const fmt = (value: bigint, decimals: number) => formatUnits(value, decimals);

function saleClosed(s: Session, sale: SaleView, now: Head): BotError {
  const ago = Number((now.timeNs - BigInt(sale.bid_end)) / MS);
  return new BotError(
    "sale_closed",
    `Sale ${sale.sale_id} is ${sale.status.replace(/_/g, " ")}: its bid window closed ${duration(ago)} ago by the chain clock. There is nothing to bid on.`,
  );
}

/** Polls `read` until `done` says so, or the bot's --max-wait runs out. */
async function waitUntil<T>(s: Session, what: string, read: () => Promise<T>, done: (value: T) => boolean, every = 2_000): Promise<T> {
  const deadline = Date.now() + s.opts.maxWaitMs;
  let said = 0;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() >= deadline) throw new BotError("timeout", `Gave up waiting for ${what} after ${duration(s.opts.maxWaitMs)} (--max-wait).`, 1);
    if (Date.now() - said > 30_000) {
      s.opts.say(`waiting for ${what}`);
      said = Date.now();
    }
    await sleep(every);
  }
}

/**
 * Waits on the chain clock (the head block's timestamp, which the contract's
 * `bid_start` check uses) until the bid window is open. Polls every --poll-ms
 * in the last seconds. Returns the first open head block the bot saw.
 */
async function waitForOpen(s: Session, sale: SaleView): Promise<{ head: Head; waitedMs: number; lateByMs: number }> {
  const start = BigInt(sale.bid_start);
  const began = Date.now();
  const deadline = began + s.opts.maxWaitMs;
  let said = 0;
  let warmed = false;
  for (let first = true; ; first = false) {
    const head = await chainHead(s.opts.rpcUrl);
    if (head.timeNs >= start) {
      return { head, waitedMs: Date.now() - began, lateByMs: first ? Number((head.timeNs - start) / MS) : 0 };
    }
    const leftMs = Number((start - head.timeNs) / MS);
    if (Date.now() >= deadline) {
      throw new BotError("timeout", `The sale opens in ${duration(leftMs)} by the chain clock, beyond --max-wait (${duration(s.opts.maxWaitMs)}).`, 1);
    }
    if (Date.now() - said > (leftMs > 120_000 ? 60_000 : 10_000)) {
      s.opts.say(`opens in ${duration(leftMs)} (chain clock, block ${head.height})`);
      said = Date.now();
    }
    // The relayer's policy is cached for 15 s: ask for it just before the open so the bid does not wait on it.
    if (!warmed && leftMs < 5_000) {
      warmed = true;
      await s.client.getRelayerPolicy();
    }
    await sleep(leftMs > 6_000 ? Math.min(leftMs - 4_000, 10_000) : Math.max(10, Math.min(s.opts.pollMs, leftMs)));
  }
}

/** Refusals that only say "not open yet" (a lagging RPC node or relayer): the bid can be sent again. */
function notOpenYet(e: unknown): boolean {
  if (!(e instanceof FairgroundError) || e.maybeSubmitted) return false;
  return (
    (e.code === "invalid" && e.reason === "not_open") ||
    (e.code === "relayer_refused" && e.reason === "wrong_phase") ||
    (e.code === "bid_rejected" && e.reason === "not_open")
  );
}

/** The block in which Fairground's ft_on_transfer accepted the bid, read from the transaction. Best effort. */
async function bidBlock(s: Session, txHash: string, sender: string | null): Promise<Head | null> {
  if (!sender) return null;
  try {
    const tx = await rpcCall<{ receipts_outcome: { block_hash: string; outcome: { executor_id: string; logs: string[] } }[] }>(s.opts.rpcUrl, "tx", {
      tx_hash: txHash,
      sender_account_id: sender,
      wait_until: "EXECUTED_OPTIMISTIC",
    });
    const receipt = tx.receipts_outcome.find((r) => r.outcome.executor_id === s.opts.contractId && r.outcome.logs.some((l) => l.includes('"bid_placed"')));
    if (!receipt) return null;
    const block = await rpcCall<{ header: { height: number; timestamp_nanosec: string } }>(s.opts.rpcUrl, "block", { block_id: receipt.block_hash });
    return { height: block.header.height, timeNs: BigInt(block.header.timestamp_nanosec) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- receipts

/**
 * What the bot keeps about its own bid, on this machine only: the terms and
 * the salt (a commit-reveal bid cannot be revealed without them), and how it
 * was sent. Written before a snipe is sent, so a bid that lands can always be
 * revealed. Sensitive until the sale closes: it holds the bot's max price.
 */
export type Receipt = {
  v: 1;
  kind: "snipe" | "copycat";
  network: NearNetwork;
  contract: string;
  saleId: string;
  bidder: string;
  mode: "tee" | "commit_reveal";
  deposit: string;
  maxPrice?: string;
  maxSpend?: string;
  salt?: string;
  victim?: string;
  payloadSha256?: string;
  txHash?: string | null;
  index?: number;
  placedAtNs?: string;
  landedAfterMs?: number;
  savedAt: string;
};

export function receiptPath(opts: Pick<BotOptions, "receiptDir" | "network" | "contractId" | "saleId">, bidder: string): string {
  return path.join(opts.receiptDir, opts.network, opts.contractId, opts.saleId, `${bidder}.json`);
}

function saveReceipt(opts: BotOptions, receipt: Receipt): string {
  const file = receiptPath(opts, receipt.bidder);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`);
  return file;
}

export function loadReceipt(opts: BotOptions, bidder: string): Receipt | null {
  const file = receiptPath(opts, bidder);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Receipt;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- status

export type StatusResult = {
  command: "status";
  ok: true;
  network: NearNetwork;
  chainId: string;
  contract: string;
  sale: {
    id: string;
    status: string;
    mode: "tee" | "commit_reveal";
    creator: string;
    token: string;
    quoteToken: string;
    bidStartNs: string;
    bidEndNs: string;
    opensInMs: number;
    closesInMs: number;
    floorPrice: string;
    maxPrice: string | null;
    minDeposit: string;
    maxDepositPerAccount: string;
    bidCount: number;
    maxBids: number;
    totalDeposits: string;
    sealerCodeHash: string;
    repoSealerHash: string | null;
    sealerPubkey: string | null;
  };
  quote: Quote;
  account: null | { id: string; near: string; usdc: string; bid: null | { index: number; deposit: string; placedAtNs: string; claimed: boolean } };
  relayer: null | { url: string; account: string | null; methods: string[] };
};

export async function status(s: Session): Promise<StatusResult> {
  const sale = await freshSale(s);
  const now = await chainHead(s.opts.rpcUrl);
  const bot = s.opts.accountId;
  let account: StatusResult["account"] = null;
  if (bot && (await accountExists(s.opts.rpcUrl, bot))) {
    const bid = await bidOf(s, bot);
    account = {
      id: bot,
      near: (await nearBalance(s.opts.rpcUrl, bot)).toString(),
      usdc: (await ftBalance(s, sale.quote_token, bot)).toString(),
      bid: bid && { index: bid.index, deposit: bid.deposit, placedAtNs: bid.placed_at, claimed: bid.claimed },
    };
  }
  const policy = s.opts.relayerUrl ? await s.client.getRelayerPolicy() : null;
  return {
    command: "status",
    ok: true,
    network: s.opts.network,
    chainId: s.chainId,
    contract: s.opts.contractId,
    sale: {
      id: sale.sale_id,
      status: sale.status,
      mode: sale.reveal_mode === "Tee" ? "tee" : "commit_reveal",
      creator: sale.creator,
      token: sale.token,
      quoteToken: sale.quote_token,
      bidStartNs: sale.bid_start,
      bidEndNs: sale.bid_end,
      opensInMs: Number((BigInt(sale.bid_start) - now.timeNs) / MS),
      closesInMs: Number((BigInt(sale.bid_end) - now.timeNs) / MS),
      floorPrice: sale.floor_price,
      maxPrice: sale.max_price,
      minDeposit: sale.min_deposit,
      maxDepositPerAccount: sale.max_deposit_per_account,
      bidCount: sale.bid_count,
      maxBids: sale.max_bids,
      totalDeposits: sale.total_deposits,
      sealerCodeHash: sale.sealer_code_hash,
      repoSealerHash: s.repoSealerHash,
      sealerPubkey: sale.sealer_pubkey,
    },
    quote: s.quote,
    account,
    relayer: s.opts.relayerUrl ? { url: s.opts.relayerUrl, account: policy?.relayerAccountId ?? null, methods: policy?.methods ?? [] } : null,
  };
}

// ---------------------------------------------------------------- snipe

export type SnipeResult = {
  command: "snipe";
  ok: true;
  network: NearNetwork;
  contract: string;
  saleId: string;
  bidder: string;
  mode: "tee" | "commit_reveal";
  deposit: string;
  maxPrice: string;
  maxSpend: string;
  quote: Quote;
  /** The transaction that carried the bid (signed by the relayer when gasless). */
  txHash: string | null;
  paidBy: "relayer" | "user" | null;
  fallbackReason: string | null;
  /** The bid's place in the sale: 0 = first. */
  index: number;
  bidStartNs: string;
  /** The block time at which the contract accepted the bid (get_bid placed_at). */
  placedAtNs: string;
  /** placed_at - bid_start, ms (chain clock). */
  landedAfterMs: number;
  /** The second of the sale it landed in, counted from 0. */
  landedInSecond: number;
  /** The first block the bot saw at or after the open, and the block that accepted the bid. */
  openBlock: number;
  bidBlock: number | null;
  /** How long the bot waited for the open (wall clock), and how late it started if the sale was already open. */
  waitedMs: number;
  startedLateByMs: number;
  /** Sends: more than 1 when an RPC node or the relayer still saw the sale closed. */
  attempts: number;
  sealedBytes: number | null;
  receiptFile: string;
};

/**
 * Waits for the sale to open and places the bot's bid in the first block it
 * can: the bid is sealed (or committed) and its receipt saved before the open,
 * the relayer's policy is fetched just before, and the bid is sent the moment
 * the chain's head block reaches bid_start.
 */
export async function snipe(s: Session): Promise<SnipeResult> {
  const { opts, client } = s;
  const bot = opts.accountId!;
  let sale = await freshSale(s);
  const now = await chainHead(opts.rpcUrl);
  if (!BIDDABLE.includes(sale.status)) throw saleClosed(s, sale, now);
  const existing = await bidOf(s, bot);
  if (existing) throw new BotError("already_bid", `${bot} already has a bid in ${opts.saleId} (index ${existing.index}). One bid per account.`);

  const deposit = amount("--deposit", opts.deposit, s.quote.decimals);
  const maxPrice = amount("--max-price", opts.maxPrice, s.quote.decimals);
  const maxSpend = opts.maxSpend === null ? deposit : amount("--max-spend", opts.maxSpend, s.quote.decimals);
  const problem = bidTermsProblem({ maxPrice, maxSpend }, deposit, BigInt(sale.floor_price));
  if (problem) throw new BotError("invalid_terms", `${problem} Such a bid would be void and lose 1 % of its deposit.`);
  const q = (v: bigint | string) => `${fmt(BigInt(v), s.quote.decimals)} ${s.quote.symbol}`;
  if (deposit < BigInt(sale.min_deposit)) throw new BotError("invalid_terms", `--deposit ${q(deposit)} is below the sale's minimum of ${q(sale.min_deposit)}.`);
  if (deposit > BigInt(sale.max_deposit_per_account)) throw new BotError("invalid_terms", `--deposit ${q(deposit)} is above the sale's per-account maximum of ${q(sale.max_deposit_per_account)}.`);
  const held = await ftBalance(s, sale.quote_token, bot);
  if (held < deposit) throw new BotError("insufficient_usdc", `${bot} holds ${q(held)}, and the bid needs ${q(deposit)}.`);

  if (sale.status === "setup") {
    opts.say("the sale is still in setup (token or sale key not ready): waiting");
    sale = await waitUntil(s, "the sale to finish its setup", () => freshSale(s), (v) => v.status !== "setup");
    if (!BIDDABLE.includes(sale.status)) throw saleClosed(s, sale, await chainHead(opts.rpcUrl));
  }

  // Seal (or commit) now, and save the receipt before anything is sent.
  const tee = sale.reveal_mode === "Tee";
  const salt = randomHex(16);
  let ciphertext = "";
  let commitment = "";
  if (tee) {
    if (!sale.sealer_pubkey) throw new BotError("bid_failed", "The sale has no sale key, so a bid cannot be sealed.");
    ciphertext = await sealBid(sale.sealer_pubkey, { sale_id: opts.saleId, bidder: bot, max_price: maxPrice.toString(), max_spend: maxSpend.toString(), salt });
    const bytes = fromB64(ciphertext).length;
    if (bytes !== sealedBidLen(opts.saleId, bot)) throw new BotError("bid_failed", `The sealed bid is ${bytes} bytes, not ${sealedBidLen(opts.saleId, bot)}.`, 1);
  } else {
    commitment = bidCommitment({ saleId: opts.saleId, bidder: bot, maxPrice, maxSpend, salt });
  }
  const receipt: Receipt = {
    v: 1,
    kind: "snipe",
    network: opts.network,
    contract: opts.contractId,
    saleId: opts.saleId,
    bidder: bot,
    mode: tee ? "tee" : "commit_reveal",
    deposit: deposit.toString(),
    maxPrice: maxPrice.toString(),
    maxSpend: maxSpend.toString(),
    salt,
    payloadSha256: await sha256Hex(tee ? fromB64(ciphertext) : commitment),
    savedAt: new Date().toISOString(),
  };
  const receiptFile = saveReceipt(opts, receipt);
  opts.say(
    tee
      ? `sealed the bid to the sale key ${sale.sealer_pubkey!.slice(0, 12)}... (${fromB64(ciphertext).length} bytes); receipt: ${receiptFile}`
      : `committed to the bid (commitment ${commitment.slice(0, 12)}...); the salt is in the receipt: ${receiptFile}`,
  );
  opts.say(`terms: deposit ${q(deposit)}, max price ${q(maxPrice)} per token, max spend ${q(maxSpend)}; ${opts.relayerUrl ? `gasless through ${opts.relayerUrl}` : "signed and paid by the bot"}`);

  const opened = await waitForOpen(s, sale);
  if (opened.lateByMs > 0) opts.say(`the sale was already open for ${duration(opened.lateByMs)}: bidding now`);
  else opts.say(`open at block ${opened.head.height}: firing`);

  const fired = Date.now();
  let attempts = 0;
  let placed: BidResult;
  for (;;) {
    attempts += 1;
    try {
      placed = tee ? await client.placeBid(opts.saleId, bot, deposit, ciphertext) : await client.placeBidPayload(opts.saleId, bot, deposit, { commitment });
      break;
    } catch (e) {
      if (notOpenYet(e) && attempts < 40 && Date.now() - fired < 30_000) {
        await sleep(Math.min(opts.pollMs, 250));
        continue;
      }
      throw new BotError("bid_failed", `The bid did not go in: ${describe(e)}`, 1);
    }
  }

  const view = (await bidOf(s, bot))!;
  const start = BigInt(sale.bid_start);
  const landedNs = BigInt(view.placed_at) - start;
  const txHash = placed.relay?.txHash ?? null;
  const paidBy = placed.relay?.paidBy ?? null;
  const block = txHash ? await bidBlock(s, txHash, paidBy === "relayer" ? s.relayerAccount : bot) : null;
  const landedAfterMs = Number(landedNs) / 1e6;
  saveReceipt(opts, { ...receipt, txHash, index: view.index, placedAtNs: view.placed_at, landedAfterMs, savedAt: new Date().toISOString() });
  return {
    command: "snipe",
    ok: true,
    network: opts.network,
    contract: opts.contractId,
    saleId: opts.saleId,
    bidder: bot,
    mode: tee ? "tee" : "commit_reveal",
    deposit: deposit.toString(),
    maxPrice: maxPrice.toString(),
    maxSpend: maxSpend.toString(),
    quote: s.quote,
    txHash,
    paidBy,
    fallbackReason: placed.relay?.fallbackReason ?? null,
    index: view.index,
    bidStartNs: sale.bid_start,
    placedAtNs: view.placed_at,
    landedAfterMs,
    landedInSecond: Number(landedNs / 1_000_000_000n),
    openBlock: opened.head.height,
    bidBlock: block?.height ?? null,
    waitedMs: opened.waitedMs,
    startedLateByMs: opened.lateByMs,
    attempts,
    sealedBytes: tee ? fromB64(ciphertext).length : null,
    receiptFile,
  };
}

// ---------------------------------------------------------------- copycat

export type CopycatResult = {
  command: "copycat";
  ok: true;
  network: NearNetwork;
  contract: string;
  saleId: string;
  bidder: string;
  victim: string;
  mode: "tee" | "commit_reveal";
  victimIndex: number;
  victimDeposit: string;
  deposit: string;
  quote: Quote;
  /** The copied payload: its size, and the only size the contract takes from the bot. */
  payloadBytes: number;
  expectedBytes: number | null;
  /**
   * rejected_on_chain: the contract returned the deposit (bid_rejected), the bot holds no bid.
   * accepted_void_at_clearing: the contract took the bytes (it cannot read a sealed bid); the enclave voids it.
   * accepted_cannot_reveal: commit-reveal; the commitment binds the victim's account, so the bot can never reveal it.
   */
  outcome: "rejected_on_chain" | "accepted_void_at_clearing" | "accepted_cannot_reveal";
  /** The contract's bid_rejected reason, or why the bid will be void. */
  reason: string;
  txHash: string | null;
  paidBy: "relayer" | "user" | null;
  /** accepted: where the copy sits in the sale. */
  index: number | null;
  /** What the app (before signing) and the relayer (before paying) said about the copy. */
  appRefusal: string | null;
  relayerRefusal: string | null;
  /** rejected_on_chain: the bot's USDC before and after: the deposit came back in full. */
  usdcBefore: string | null;
  usdcAfter: string | null;
  penaltyIfVoid: string;
  receiptFile: string;
};

/**
 * Reads another bidder's sealed bid (or commitment) from the chain and
 * submits the same bytes from the bot account. A sealed bid names its bidder
 * inside the encryption and its length depends on the bidder's account id, so:
 * - a copy from an account id of another length is refused by the contract
 *   (`wrong_ciphertext_length`, deposit returned). The app and the relayer
 *   refuse it first; the bot then sends it as its own transaction anyway, to
 *   show the contract's own refusal;
 * - a copy from an account id of the same length is accepted (the contract
 *   cannot read it), and the enclave finds the plaintext names the victim:
 *   the bid is void, wins nothing and pays the 1 % invalid-bid penalty;
 * - a copied commit-reveal commitment can never be revealed by the bot (it
 *   binds the victim's account id): unrevealed, void, 1 % penalty.
 */
export async function copycat(s: Session): Promise<CopycatResult> {
  const { opts, client } = s;
  const bot = opts.accountId!;
  const victim = opts.victim;
  if (!victim) throw usage("--victim (or LIVE_BOT_VICTIM) is required: the bidder whose sealed bid to replay.");
  if (!ACCOUNT_ID.test(victim)) throw usage(`--victim must be a NEAR account id (got "${victim}").`);
  if (victim === bot) throw usage("--victim must be another account than the bot.");

  let sale = await freshSale(s);
  if (!BIDDABLE.includes(sale.status)) throw saleClosed(s, sale, await chainHead(opts.rpcUrl));
  const existing = await bidOf(s, bot);
  if (existing) throw new BotError("already_bid", `${bot} already has a bid in ${opts.saleId} (index ${existing.index}). Use another account for the copycat.`);

  if (sale.status !== "open") {
    opts.say("the sale is not open yet: waiting");
    sale = await waitUntil(s, "the sale to open", () => freshSale(s), (v) => v.status !== "setup" && v.status !== "upcoming", 1_000);
    if (sale.status !== "open") throw saleClosed(s, sale, await chainHead(opts.rpcUrl));
  }
  let target = await bidOf(s, victim);
  if (!target) {
    opts.say(`${victim} has no bid in ${opts.saleId} yet: waiting for one to copy`);
    target = await waitUntil(s, `${victim}'s bid`, () => bidOf(s, victim), (b) => b !== null, 1_000);
  }
  const victimBid = target!;

  const deposit = opts.deposit === null ? BigInt(sale.min_deposit) : amount("--deposit", opts.deposit, s.quote.decimals);
  const q = (v: bigint | string) => `${fmt(BigInt(v), s.quote.decimals)} ${s.quote.symbol}`;
  if (deposit < BigInt(sale.min_deposit) || deposit > BigInt(sale.max_deposit_per_account)) {
    throw new BotError("invalid_terms", `--deposit must be between ${q(sale.min_deposit)} and ${q(sale.max_deposit_per_account)} for this sale.`);
  }
  const held = await ftBalance(s, sale.quote_token, bot);
  if (held < deposit) throw new BotError("insufficient_usdc", `${bot} holds ${q(held)}, and the copy needs a deposit of ${q(deposit)}.`);

  const bytes = fromB64(victimBid.payload);
  const tee = sale.reveal_mode === "Tee";
  opts.say(`copying ${victim}'s ${tee ? "sealed bid" : "commitment"} (bid #${victimBid.index}, ${bytes.length} bytes, deposit ${q(victimBid.deposit)}) into a bid from ${bot} with a deposit of ${q(deposit)}`);

  const base = {
    command: "copycat" as const,
    ok: true as const,
    network: opts.network,
    contract: opts.contractId,
    saleId: opts.saleId,
    bidder: bot,
    victim,
    mode: tee ? ("tee" as const) : ("commit_reveal" as const),
    victimIndex: victimBid.index,
    victimDeposit: victimBid.deposit,
    deposit: deposit.toString(),
    quote: s.quote,
    payloadBytes: bytes.length,
    expectedBytes: tee ? sealedBidLength(opts.saleId, bot) : null,
    penaltyIfVoid: invalidBidPenalty(deposit).toString(),
  };
  const keep = (extra: Partial<Receipt>) =>
    saveReceipt(opts, {
      v: 1,
      kind: "copycat",
      network: opts.network,
      contract: opts.contractId,
      saleId: opts.saleId,
      bidder: bot,
      mode: base.mode,
      deposit: deposit.toString(),
      victim,
      savedAt: new Date().toISOString(),
      ...extra,
    });

  if (!tee) {
    const placed = await client.placeBidPayload(opts.saleId, bot, deposit, { commitment: toHex(bytes) }).catch((e: unknown) => {
      throw new BotError("bid_failed", `The copied commitment did not go in: ${describe(e)}`, 1);
    });
    const receiptFile = keep({ txHash: placed.relay?.txHash ?? null, index: placed.index });
    return {
      ...base,
      outcome: "accepted_cannot_reveal",
      reason: `the commitment is sha256 over the sale id, ${victim} and the hidden terms and salt: ${bot} can never reveal it, and an unrevealed bid is void at clear_onchain`,
      txHash: placed.relay?.txHash ?? null,
      paidBy: placed.relay?.paidBy ?? null,
      index: placed.index,
      appRefusal: null,
      relayerRefusal: null,
      usdcBefore: null,
      usdcAfter: null,
      receiptFile,
    };
  }

  if (bytes.length === base.expectedBytes) {
    // Same length: nothing outside the enclave can tell the copy from a real bid.
    const placed = await client.placeBid(opts.saleId, bot, deposit, victimBid.payload).catch((e: unknown) => {
      throw new BotError("bid_failed", `The copied bid did not go in: ${describe(e)}`, 1);
    });
    const receiptFile = keep({ txHash: placed.relay?.txHash ?? null, index: placed.index });
    return {
      ...base,
      outcome: "accepted_void_at_clearing",
      reason: `the sealed plaintext names ${victim}, not ${bot}: the enclave marks the bid invalid (bidder_mismatch); it wins nothing and pays the 1 % penalty`,
      txHash: placed.relay?.txHash ?? null,
      paidBy: placed.relay?.paidBy ?? null,
      index: placed.index,
      appRefusal: null,
      relayerRefusal: null,
      usdcBefore: null,
      usdcAfter: null,
      receiptFile,
    };
  }

  // Another length. 1: the app refuses it before signing.
  let appRefusal: string | null = null;
  try {
    await client.placeBid(opts.saleId, bot, deposit, victimBid.payload);
  } catch (e) {
    if (!(e instanceof FairgroundError) || e.reason !== "wrong_ciphertext_length") throw new BotError("bid_failed", `Unexpected answer from the app client: ${describe(e)}`, 1);
    appRefusal = `${e.message} [${e.code}: ${e.reason}]`;
  }
  if (appRefusal === null) throw new BotError("bid_failed", "The app client sent a copy of the wrong length: that is a bug in its checks.", 1);
  opts.say(`the app refuses it before signing: ${appRefusal}`);

  // The raw call, built here because the app's builders refuse a box of the wrong length.
  const action: FairgroundAction = {
    receiverId: sale.quote_token,
    methodName: "ft_transfer_call",
    args: { receiver_id: opts.contractId, amount: deposit.toString(), msg: JSON.stringify({ sale_id: opts.saleId, ciphertext: victimBid.payload }) },
    gas: 100n * TGAS,
    deposit: 1n,
  };

  // 2. The relayer refuses to pay for it (it checks the same length).
  let relayerRefusal: string | null = null;
  if (opts.relayerUrl) {
    try {
      const relayed = await createRelayerClient({ url: opts.relayerUrl }).relay(await s.signer!.signDelegate(action));
      relayerRefusal = `relayed anyway (${relayed.status}, tx ${relayed.tx_hash}): the relayer did not check the length`;
    } catch (e) {
      relayerRefusal = e instanceof RelayerError ? `${e.reason}${e.maybeSubmitted ? " (may have been submitted)" : ""}` : errorText(e);
    }
    opts.say(`the relayer: ${relayerRefusal}`);
  }

  // 3. The contract: the bot sends it as its own transaction and pays the gas.
  const usdcBefore = await ftBalance(s, sale.quote_token, bot);
  const summary = summarizeOutcome(await s.signer!.sendTransaction(action), opts.contractId);
  const outcome = bidOutcome(summary.events);
  // ft_resolve_transfer returns the deposit a receipt later: wait for the balance to come back.
  let usdcAfter = await ftBalance(s, sale.quote_token, bot);
  for (let i = 0; i < 20 && usdcAfter !== usdcBefore; i++) {
    await sleep(500);
    usdcAfter = await ftBalance(s, sale.quote_token, bot);
  }
  const stillNoBid = (await bidOf(s, bot)) === null;
  if (outcome.kind !== "rejected" || !stillNoBid) {
    throw new BotError("bid_failed", `The contract did not refuse the copy: outcome ${JSON.stringify(outcome)}, tx ${summary.txHash}, bid on chain: ${!stillNoBid}.`, 1);
  }
  const receiptFile = keep({ txHash: summary.txHash });
  return {
    ...base,
    outcome: "rejected_on_chain",
    reason: outcome.reason,
    txHash: summary.txHash,
    paidBy: "user",
    index: null,
    appRefusal,
    relayerRefusal,
    usdcBefore: usdcBefore.toString(),
    usdcAfter: usdcAfter.toString(),
    receiptFile,
  };
}

// ---------------------------------------------------------------- report

export type FillRow = {
  index: number;
  bidder: string;
  deposit: string;
  tokens: string;
  spent: string;
  refund: string;
  penalty: string;
  valid: boolean;
  claimed: boolean;
  /** ceil(tokens x clearing price / 10^decimals): what a winner must pay. */
  owed: string;
  /** spent = owed. */
  paysClearingPrice: boolean;
};

export type Check = { name: string; ok: boolean; detail: string };

export type ReportResult = {
  command: "report";
  ok: boolean;
  network: NearNetwork;
  contract: string;
  saleId: string;
  bidder: string;
  quote: Quote;
  token: { id: string; decimals: number; symbol: string };
  saleStatus: string;
  failReason: string | null;
  clearedBy: string | null;
  clearingPrice: string;
  floorPrice: string;
  maxPrice: string | null;
  totalSold: string;
  totalRaised: string;
  nValid: number;
  nInvalid: number;
  /** The bot's fill. */
  fill: FillRow;
  /** tokens x price in quote base units, exact (a fraction of a base unit is possible), and what the rounding up added: always under one base unit. */
  exactCost: string;
  roundingUp: string;
  /** spent x 10^decimals / tokens: what the bot paid per whole token, in quote base units, exact or to 12 places. */
  pricePaidPerToken: string | null;
  /** From the bot's receipt: the max price it bid, and how it got in. */
  botMaxPrice: string | null;
  botLandedAfterMs: number | null;
  copiedFrom: string | null;
  /** Every bid of the sale, in order. */
  fills: FillRow[];
  winners: number;
  winnersPayingClearingPrice: number;
  checks: Check[];
  claim: null | {
    status: "claimed" | "already_claimed";
    txHash: string | null;
    paidBy: "relayer" | "user" | null;
    tokens: string;
    refund: string;
    tokensReceived: string;
    usdcReceived: string;
  };
};

/** `num / den` as a decimal with up to `places` fraction digits; marked with "..." when it does not end there. */
export function ratio(num: bigint, den: bigint, places: number): string {
  const whole = num / den;
  let rest = num % den;
  let frac = "";
  for (let i = 0; i < places && rest !== 0n; i++) {
    rest *= 10n;
    frac += (rest / den).toString();
    rest %= den;
  }
  return `${whole}${frac ? `.${frac}` : ""}${rest !== 0n ? "..." : ""}`;
}

/**
 * Reads the settled sale and proves, to the smallest unit, what the bot paid:
 * spent = ceil(tokens x clearing price / 10^decimals), the same rule as every
 * other winner (the contract checks it as spent_equals_tokens_times_price).
 * With --claim, claims the bot's tokens and refund if not yet claimed.
 */
export async function report(s: Session, { readLocalReceipt = true } = {}): Promise<ReportResult> {
  const { opts, client } = s;
  const bot = opts.accountId!;
  let sale = await freshSale(s);
  if (!FINAL.includes(sale.status)) {
    if (!opts.wait) {
      const hint =
        sale.status === "awaiting_close" || sale.status === "closed"
          ? "Someone must call close_sale (the sale page's Close button)."
          : sale.status === "revealing"
            ? "After the reveal window, anyone can call clear_onchain."
            : sale.status === "clearing"
              ? "The enclave is clearing it."
              : "Its bid window is not over.";
      throw new BotError("not_settled", `Sale ${opts.saleId} is ${sale.status.replace(/_/g, " ")}, not settled or failed. ${hint} Add --wait to wait for it.`);
    }
    sale = await waitUntil(s, `sale ${opts.saleId} to settle`, () => freshSale(s), (v) => FINAL.includes(v.status), 3_000);
  }
  const result = await client.getResult(opts.saleId);
  const raw = await s.rpc.view<ResultView | null>(opts.contractId, "get_result", { sale_id: opts.saleId });
  if (!result || !raw) throw new BotError("not_settled", `Sale ${opts.saleId} has no result yet.`, 1);

  const one = 10n ** BigInt(sale.decimals);
  const price = result.clearingPrice;
  const rows: FillRow[] = result.fills.map((f) => {
    const owed = costOf(f.tokens, price, one);
    return {
      index: f.index,
      bidder: f.bidder,
      deposit: f.deposit.toString(),
      tokens: f.tokens.toString(),
      spent: f.spent.toString(),
      refund: f.refund.toString(),
      penalty: (f.penalty ?? 0n).toString(),
      valid: f.valid,
      claimed: f.claimed,
      owed: owed.toString(),
      paysClearingPrice: f.spent === owed,
    };
  });
  const mine = result.fills.find((f) => f.bidder === bot);
  const row = rows.find((r) => r.bidder === bot);
  if (!mine || !row) throw new BotError("no_bid", `${bot} has no bid in sale ${opts.saleId}.`);

  const receipt = readLocalReceipt ? loadReceipt(opts, bot) : null;
  const tokenMeta = await s.rpc.view<{ symbol: string; decimals: number }>(sale.token, "ft_metadata").catch(() => ({ symbol: sale.token_symbol, decimals: sale.decimals }));
  const penalty = mine.penalty ?? 0n;
  const exact = mine.tokens * price; // in quote base units x 10^decimals
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail: string) => void checks.push({ name, ok, detail });
  const q = (v: bigint) => `${fmt(v, s.quote.decimals)} ${s.quote.symbol}`;

  check("deposit = spent + refund + penalty", mine.deposit === mine.spent + mine.refund + penalty, `${mine.deposit} = ${mine.spent} + ${mine.refund} + ${penalty}`);
  if (mine.tokens > 0n) {
    check(
      "spent = ceil(tokens x clearing price / 10^decimals)",
      row.paysClearingPrice,
      `${mine.spent} = ceil(${mine.tokens} x ${price} / 10^${sale.decimals}) = ${row.owed}`,
    );
    check(
      "the rounding up is less than one base unit",
      mine.spent * one >= exact && mine.spent * one - exact < one,
      `${mine.spent} - ${ratio(exact, one, sale.decimals)} = ${ratio(mine.spent * one - exact, one, sale.decimals)} base units`,
    );
    if (receipt?.maxPrice) check("the bot bid at least the clearing price", BigInt(receipt.maxPrice) >= price, `max price ${receipt.maxPrice} >= ${price}`);
  } else if (!mine.valid) {
    check("a void bid wins nothing and pays nothing", mine.tokens === 0n && mine.spent === 0n, `tokens ${mine.tokens}, spent ${mine.spent}`);
    check("a void bid pays the 1 % penalty, rounded up", penalty === invalidBidPenalty(mine.deposit), `${penalty} = ceil(${mine.deposit} / 100) = ${invalidBidPenalty(mine.deposit)}`);
  }
  const winners = rows.filter((r) => BigInt(r.tokens) > 0n);
  const fair = winners.filter((r) => r.paysClearingPrice);
  check("every winner paid the clearing price by the same rule", fair.length === winners.length, `${fair.length} of ${winners.length} winners`);
  if (result.status === "settled") check("clearing price >= floor", price >= BigInt(sale.floor_price), `${price} >= ${sale.floor_price}`);

  let claim: ReportResult["claim"] = null;
  if (opts.claim) {
    if (mine.claimed) {
      claim = { status: "already_claimed", txHash: mine.claimTx, paidBy: null, tokens: mine.tokens.toString(), refund: mine.refund.toString(), tokensReceived: "0", usdcReceived: "0" };
    } else {
      const [usdc0, tokens0] = [await ftBalance(s, sale.quote_token, bot), await ftBalance(s, sale.token, bot)];
      const got = await client.claim(opts.saleId, bot).catch((e: unknown) => {
        throw new BotError("claim_failed", `The claim did not go through: ${describe(e)}`, 1);
      });
      const [usdc1, tokens1] = [await ftBalance(s, sale.quote_token, bot), await ftBalance(s, sale.token, bot)];
      claim = {
        status: "claimed",
        txHash: got.txHash,
        paidBy: got.relay?.paidBy ?? null,
        tokens: got.tokens.toString(),
        refund: got.refund.toString(),
        tokensReceived: (tokens1 - tokens0).toString(),
        usdcReceived: (usdc1 - usdc0).toString(),
      };
      check("the claim paid out the fill's tokens", tokens1 - tokens0 === mine.tokens, `${tokens1 - tokens0} = ${mine.tokens}`);
      check("the claim paid out the fill's refund", usdc1 - usdc0 === mine.refund, `${q(usdc1 - usdc0)} = ${q(mine.refund)}`);
    }
  }

  return {
    command: "report",
    ok: checks.every((c) => c.ok),
    network: opts.network,
    contract: opts.contractId,
    saleId: opts.saleId,
    bidder: bot,
    quote: s.quote,
    token: { id: sale.token, decimals: tokenMeta.decimals, symbol: tokenMeta.symbol },
    saleStatus: result.status,
    failReason: raw.fail_reason,
    clearedBy: result.clearedBy ?? null,
    clearingPrice: price.toString(),
    floorPrice: sale.floor_price,
    maxPrice: sale.max_price,
    totalSold: result.totalSold.toString(),
    totalRaised: result.totalRaised.toString(),
    nValid: result.nValid,
    nInvalid: result.nInvalid,
    fill: row,
    exactCost: ratio(exact, one, sale.decimals),
    roundingUp: ratio(mine.spent * one - exact, one, sale.decimals),
    pricePaidPerToken: mine.tokens > 0n ? ratio(mine.spent * one, mine.tokens, 12) : null,
    botMaxPrice: receipt?.maxPrice ?? null,
    botLandedAfterMs: receipt?.landedAfterMs ?? null,
    copiedFrom: receipt?.victim ?? null,
    fills: rows,
    winners: winners.length,
    winnersPayingClearingPrice: fair.length,
    checks,
    claim,
  };
}

// ---------------------------------------------------------------- reveal

export type RevealResult = { command: "reveal"; ok: true; network: NearNetwork; contract: string; saleId: string; bidder: string; txHash: string; paidBy: "relayer" | "user" | null };

/** Commit-reveal sales: reveals the bot's bid with the terms and salt from its snipe receipt. */
export async function reveal(s: Session): Promise<RevealResult> {
  const { opts, client } = s;
  const bot = opts.accountId!;
  const receipt = loadReceipt(opts, bot);
  if (!receipt || receipt.kind !== "snipe" || !receipt.salt || !receipt.maxPrice || !receipt.maxSpend) {
    throw new BotError("no_receipt", `No snipe receipt with a salt at ${receiptPath(opts, bot)}: the bid cannot be revealed without it.`);
  }
  let sale = await freshSale(s);
  if (sale.reveal_mode !== "CommitReveal") throw usage(`Sale ${opts.saleId} is a sealed-bid (TEE) sale: there is nothing to reveal, the enclave opens the bids.`);
  if (sale.status !== "revealing") {
    if (!opts.wait || !BIDDABLE.concat("awaiting_close").includes(sale.status)) {
      throw new BotError("sale_closed", `Sale ${opts.saleId} is ${sale.status.replace(/_/g, " ")}: bids can be revealed only while it is revealing.${opts.wait ? "" : " Add --wait to wait for the close."}`);
    }
    sale = await waitUntil(s, `sale ${opts.saleId} to be closed for reveals`, () => freshSale(s), (v) => !BIDDABLE.concat("awaiting_close").includes(v.status), 3_000);
  }
  const done = await client
    .revealBid(opts.saleId, bot, { maxPrice: BigInt(receipt.maxPrice), maxSpend: BigInt(receipt.maxSpend), salt: receipt.salt })
    .catch((e: unknown) => {
      throw new BotError("reveal_failed", `The reveal did not go through: ${describe(e)}`, 1);
    });
  return { command: "reveal", ok: true, network: opts.network, contract: opts.contractId, saleId: opts.saleId, bidder: bot, txHash: done.txHash, paidBy: done.relay?.paidBy ?? null };
}
