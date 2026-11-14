/**
 * What each Sealround MCP tool does. Every function returns a plain JSON
 * object for the tool result, or throws a ToolError (session.ts turns any
 * other error into one). server.ts registers them.
 *
 * Nothing here has its own chain logic: reads and writes go through the web
 * app's NearClient (src/lib/client/near.ts) built by the live bot's connect,
 * bids are sealed by src/lib/crypto.ts `sealBid` (the format the app, the
 * relayer, the contract and the enclave share), results come from the live
 * bot's `report` (the code of `live-bot result`), and verify_sale runs the
 * checks of scripts/verify-sale.ts: NearClient.verifySale (verifySaleRuns
 * from src/lib/near/attestation-sources.ts) and checkBidSet from
 * src/lib/bid-inclusion.ts.
 *
 * Amounts are given as { amount, base, symbol }: `amount` in whole units
 * (USDC, tokens), `base` in the token's smallest unit as the contract stores
 * it. A price is quote-token units per whole sale token.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { costOf, formatUnits, parseUnits, U128_MAX } from "@fairground/clearing";
import { chainHead, describe, duration, report, sleep, type Quote, type ReportResult, type Session } from "../live-bot/bot";
import { checkBidSet, placeOf } from "../../src/lib/bid-inclusion";
import { FairgroundError } from "../../src/lib/client/errors";
import { bidTermsProblem } from "../../src/lib/client/rules";
import { ACCOUNT_ID } from "../../src/lib/config";
import { fromB64, randomHex, sealBid, sealedBidLen, sha256Hex } from "../../src/lib/crypto";
import { jsonRpc, viewCall } from "../../src/lib/near/attestation-sources";
import type { NearRpc } from "../../src/lib/near/rpc";
import type { BidView, SaleView } from "../../src/lib/near/views";
import type { AttestedRun, BidResult, ChainSaleStatus, MissingRun, SaleResult } from "../../src/lib/types";
import { CHAIN_LABELS, RUN_LABELS } from "../../src/lib/verify/labels";
import type { FullVerification } from "../../src/lib/verify/types";
import { ENV, ToolError, type ServerConfig } from "./config";
import { asToolError, openChain, openSale, refuseWriteLocally, requireSaleId } from "./session";

const MS = 1_000_000n;
const FINAL: ChainSaleStatus[] = ["settled", "failed"];

// ---------------------------------------------------------------- formatting

type Amount = { amount: string; base: string; symbol: string };

/** Whole units without thousands separators: "1234.5". */
const plain = (value: bigint, decimals: number) => formatUnits(value, decimals).replace(/,/g, "");
const money = (base: bigint | string, decimals: number, symbol: string): Amount => ({
  amount: plain(BigInt(base), decimals),
  base: BigInt(base).toString(),
  symbol,
});
const isoOfNs = (ns: string | null | undefined): string | null => (ns ? new Date(Number(BigInt(ns) / MS)).toISOString() : null);
const secondsBetween = (fromNs: bigint, toNs: string) => Math.round(Number((BigInt(toNs) - fromNs) / MS) / 1000);

/** What the sale is doing now and what an agent can do next, by the contract's status and the chain clock. */
function phaseOf(v: SaleView, nowNs: bigint): { phase: string; whatNext: string } {
  const left = (ns: string) => duration(Number((BigInt(ns) - nowNs) / MS));
  const tee = v.reveal_mode === "Tee";
  switch (v.status) {
    case "setup":
      return { phase: "The sale token or the sale key is not ready yet.", whatNext: "Wait. Bids open at bid_start once the setup is done." };
    case "upcoming":
      return { phase: `Bids open in ${left(v.bid_start)} (chain clock).`, whatNext: tee ? "Call sealround_place_bid once it is open." : "Commit-reveal sale: this server bids only in sealed-bid (TEE) sales." };
    case "open":
      return {
        phase: `Open for bids; closes in ${left(v.bid_end)} (chain clock).`,
        whatNext: tee ? "sealround_place_bid, with a max_deposit the user approved." : "Commit-reveal sale: this server bids only in sealed-bid (TEE) sales.",
      };
    case "awaiting_close":
      return { phase: "The bid window is over and nobody has closed the sale yet.", whatNext: "Anyone can call close_sale (the sale page's Close button); the enclave then clears it." };
    case "clearing":
      return { phase: "Closed; the enclave is clearing it.", whatNext: "Wait, then sealround_get_result." };
    case "closed":
      return { phase: "Closed; a clearing attempt ended without a result.", whatNext: "Anyone can call close_sale again to retry the clearing." };
    case "revealing":
      return { phase: `Commit-reveal: the reveal window ends ${isoOfNs(v.reveal_end) ?? "soon"}.`, whatNext: "Bidders reveal their bids; then anyone calls clear_onchain." };
    case "settled":
      return { phase: "Settled: every winner pays the one clearing price.", whatNext: "sealround_get_result for the price and the fill, then sealround_claim for tokens and refund." };
    case "failed":
      return { phase: "Failed: no tokens are sold and every deposit is refunded.", whatNext: "sealround_claim returns the deposit (less the 1 % penalty of a void bid)." };
  }
}

const tokenOf = (v: SaleView) => ({ symbol: v.token_symbol, decimals: v.decimals });

// ---------------------------------------------------------------- reads shared by the tools

const bidOf = (s: Session, bidder: string) => s.rpc.view<BidView | null>(s.opts.contractId, "get_bid", { sale_id: s.opts.saleId, bidder });
const ftBalance = async (rpc: NearRpc, token: string, account: string) =>
  BigInt((await rpc.view<string | null>(token, "ft_balance_of", { account_id: account }).catch(() => "0")) ?? "0");

async function quoteOf(rpc: NearRpc, token: string, cache: Map<string, Quote>): Promise<Quote> {
  const hit = cache.get(token);
  if (hit) return hit;
  const meta = await rpc.view<{ decimals: number; symbol: string }>(token, "ft_metadata").catch(() => ({ decimals: 6, symbol: "USDC" }));
  const quote = { id: token, decimals: meta.decimals, symbol: meta.symbol };
  cache.set(token, quote);
  return quote;
}

/** The public view of one bid: never its sealed payload. */
function publicBid(b: BidView, q: Quote) {
  return { index: b.index, deposit: money(b.deposit, q.decimals, q.symbol), placedAt: isoOfNs(b.placed_at), claimed: b.claimed };
}

// ---------------------------------------------------------------- list_sales, get_sale

export const PHASES = ["all", "upcoming", "open", "closing", "settled", "failed", "final"] as const;
export type PhaseFilter = (typeof PHASES)[number];
const PHASE_STATUSES: Record<PhaseFilter, ChainSaleStatus[] | null> = {
  all: null,
  upcoming: ["setup", "upcoming"],
  open: ["open"],
  closing: ["awaiting_close", "clearing", "closed", "revealing"],
  settled: ["settled"],
  failed: ["failed"],
  final: ["settled", "failed"],
};

function saleSummary(v: SaleView, q: Quote, nowNs: bigint) {
  const t = tokenOf(v);
  return {
    id: v.sale_id,
    status: v.status,
    ...phaseOf(v, nowNs),
    mode: v.reveal_mode === "Tee" ? "tee" : "commit_reveal",
    token: { name: v.token_name, symbol: t.symbol },
    bidStart: isoOfNs(v.bid_start),
    bidEnd: isoOfNs(v.bid_end),
    floorPrice: money(v.floor_price, q.decimals, `${q.symbol} per ${t.symbol}`),
    bidCount: v.bid_count,
    maxBids: v.max_bids,
    totalDeposits: money(v.total_deposits, q.decimals, q.symbol),
  };
}

export async function listSales(cfg: ServerConfig, input: { phase?: PhaseFilter; limit?: number }) {
  const phase = input.phase ?? "all";
  const limit = input.limit ?? 50;
  const { chainId, rpc } = await openChain(cfg);
  const views: SaleView[] = [];
  for (;;) {
    const page = await rpc.view<SaleView[]>(cfg.contractId, "get_sales", { from_index: views.length, limit: 200 });
    views.push(...page);
    if (page.length < 200) break;
  }
  const want = PHASE_STATUSES[phase];
  const matching = views.filter((v) => !want || want.includes(v.status)).sort((a, b) => (BigInt(b.created_at) > BigInt(a.created_at) ? 1 : -1));
  const head = await chainHead(cfg.rpcUrl);
  const quotes = new Map<string, Quote>();
  const sales = [];
  for (const v of matching.slice(0, limit)) sales.push(saleSummary(v, await quoteOf(rpc, v.quote_token, quotes), head.timeNs));
  return {
    ok: true,
    network: cfg.network,
    chainId,
    contract: cfg.contractId,
    chainTime: new Date(Number(head.timeNs / MS)).toISOString(),
    phase,
    total: views.length,
    matching: matching.length,
    sales,
  };
}

export async function getSale(cfg: ServerConfig, input: { sale_id: string }) {
  const notes: string[] = [];
  const s = await openSale(cfg, input.sale_id, {}, notes);
  const v = s.sale;
  const q = s.quote;
  const t = tokenOf(v);
  const head = await chainHead(cfg.rpcUrl);
  const per = `${q.symbol} per ${t.symbol}`;
  const closed = v.closed_at !== null;
  let account = null;
  if (cfg.accountId) {
    const bid = await bidOf(s, cfg.accountId);
    account = {
      id: cfg.accountId,
      quoteBalance: money(await ftBalance(s.rpc, v.quote_token, cfg.accountId), q.decimals, q.symbol),
      bid: bid ? publicBid(bid, q) : null,
    };
  }
  return {
    ok: true,
    network: cfg.network,
    chainId: s.chainId,
    contract: cfg.contractId,
    sale: {
      id: v.sale_id,
      status: v.status,
      ...phaseOf(v, head.timeNs),
      mode: v.reveal_mode === "Tee" ? "tee" : "commit_reveal",
      bidsSealedToEnclave: v.reveal_mode === "Tee",
      creator: v.creator,
      description: v.description,
      website: v.website,
      token: {
        account: v.token,
        name: v.token_name,
        symbol: t.symbol,
        decimals: t.decimals,
        totalSupply: money(v.total_supply, t.decimals, t.symbol),
        saleSupply: money(v.sale_supply, t.decimals, t.symbol),
        creatorAllocation: money(v.creator_allocation, t.decimals, t.symbol),
      },
      quoteToken: { account: q.id, symbol: q.symbol, decimals: q.decimals },
      rules: {
        floorPrice: money(v.floor_price, q.decimals, per),
        maxPrice: v.max_price === null ? null : money(v.max_price, q.decimals, per),
        minRaise: money(v.min_raise, q.decimals, q.symbol),
        minDeposit: money(v.min_deposit, q.decimals, q.symbol),
        maxDepositPerAccount: money(v.max_deposit_per_account, q.decimals, q.symbol),
        maxBids: v.max_bids,
        oneBidPerAccount: true,
        unsoldTokens: "burned",
        invalidBidPenalty: "1 % of the deposit, rounded up",
        pricing: "Single price: every winner pays the same clearing price, spend rounded up to the smallest quote unit.",
        settleTimeoutSeconds: Number(BigInt(v.settle_timeout) / MS / 1000n),
        revealWindowSeconds: v.reveal_window === null ? null : Number(BigInt(v.reveal_window) / MS / 1000n),
        liquidity: v.liquidity
          ? {
              dex: v.liquidity.dex,
              raiseSharePercent: v.liquidity.raise_share_bps / 100,
              poolTokens: money(v.liquidity.pool_tokens, t.decimals, t.symbol),
              feePercent: v.liquidity.fee_bps / 100,
              note: "After settlement a pool is seeded at exactly the clearing price; sale tokens stay locked until it is seeded or abandoned.",
            }
          : null,
      },
      timing: {
        chainTime: new Date(Number(head.timeNs / MS)).toISOString(),
        createdAt: isoOfNs(v.created_at),
        bidStart: isoOfNs(v.bid_start),
        bidEnd: isoOfNs(v.bid_end),
        opensInSeconds: Math.max(0, secondsBetween(head.timeNs, v.bid_start)),
        closesInSeconds: Math.max(0, secondsBetween(head.timeNs, v.bid_end)),
        closedAt: isoOfNs(v.closed_at),
        revealEnd: isoOfNs(v.reveal_end),
        refundModeFrom: isoOfNs(v.refund_mode_at),
      },
      totals: {
        bidCount: v.bid_count,
        maxBids: v.max_bids,
        totalDeposits: money(v.total_deposits, q.decimals, q.symbol),
      },
      enclave: {
        sealerCodeHash: v.sealer_code_hash,
        repoSealerHash: s.repoSealerHash,
        saleKeyReady: v.sealer_pubkey !== null,
        saleKey: v.sealer_pubkey,
        bidSetHash: closed ? v.bid_set_hash : null,
      },
    },
    account,
    notes,
  };
}

// ---------------------------------------------------------------- place_bid

type AmountInput = string | number;
const DECIMAL = /^\d+(\.\d+)?$/;

function decimalText(name: string, value: AmountInput): string {
  const text = String(value).trim();
  if (!DECIMAL.test(text)) throw new ToolError("usage", `${name} must be a positive decimal amount such as "0.02" (got "${text}").`, { nothingSent: true });
  return text;
}

/** a < b: -1, a = b: 0, a > b: 1, for two decimal strings, exactly. */
function compareDecimals(a: string, b: string): number {
  const places = Math.max(a.split(".")[1]?.length ?? 0, b.split(".")[1]?.length ?? 0);
  const [x, y] = [parseUnits(a, places), parseUnits(b, places)];
  return x === y ? 0 : x < y ? -1 : 1;
}

/** A decimal amount in base units of the quote token. Private limits are not echoed in the message. */
function baseUnits(name: string, text: string, decimals: number, privateLimit = false): bigint {
  let v: bigint;
  try {
    v = parseUnits(text, decimals);
  } catch {
    throw new ToolError("usage", `${name} has more than ${decimals} decimals${privateLimit ? "" : ` ("${text}")`}.`, { nothingSent: true });
  }
  if (v <= 0n) throw new ToolError("usage", `${name} must be above zero.`, { nothingSent: true });
  return v;
}

/**
 * What this server keeps about a bid it placed, on this machine only. A TEE
 * bid needs nothing to be opened (the enclave opens it), so this is the
 * bidder's own record: the terms and salt sealed in the bid, the hash of the
 * sealed bytes on chain, and how it was sent. Private until the sale closes.
 */
type BidSecret = {
  format: "sealround-bid-secret";
  version: 1;
  note: string;
  network: string;
  contract: string;
  saleId: string;
  bidder: string;
  mode: "tee";
  quote: Quote;
  deposit: string;
  maxPrice: string;
  maxSpend: string;
  salt: string;
  saleKey: string;
  sealedBytes: number;
  ciphertextSha256: string;
  status: "sending" | "placed" | "not_placed" | "unknown";
  txHash: string | null;
  index: number | null;
  placedAt: string | null;
  error: string | null;
  savedAt: string;
};

export function secretPath(cfg: ServerConfig, saleId: string, bidder: string): string {
  return path.join(cfg.secretDir, cfg.network, cfg.contractId, saleId, `${bidder}.json`);
}

function writeSecret(file: string, secret: BidSecret): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ ...secret, savedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
}

function readSecretStatus(file: string): { status: string; txHash: string | null } | null {
  if (!existsSync(file)) return null;
  try {
    const s = JSON.parse(readFileSync(file, "utf8")) as Partial<BidSecret>;
    return { status: s.status ?? "unknown", txHash: s.txHash ?? null };
  } catch {
    return { status: "unreadable", txHash: null };
  }
}

export type PlaceBidInput = {
  sale_id: string;
  max_price: AmountInput;
  max_spend: AmountInput;
  max_deposit: AmountInput;
  deposit?: AmountInput;
  direct?: boolean;
};

/**
 * One sealed bid, under the same rules as `live-bot bid` (bot.ts budgetedBid):
 * the public deposit must not exceed the approved max_deposit; the terms must
 * make a valid bid; the sale must be an open TEE sale; one bid per account;
 * enough of the quote token. It goes through the relayer, and a bid the relayer
 * cannot sponsor is refused, never paid, unless `direct` is set.
 *
 * Unlike `live-bot bid` (client.bid seals internally), this seals with the same
 * sealBid itself, so it can save the terms and salt before anything is sent.
 */
export async function placeBid(cfg: ServerConfig, input: PlaceBidInput) {
  const notes: string[] = [];
  const direct = input.direct === true;
  // 1. Everything that needs no network.
  refuseWriteLocally(cfg);
  const saleId = requireSaleId(input.sale_id);
  const maxPriceText = decimalText("max_price", input.max_price);
  const maxSpendText = decimalText("max_spend", input.max_spend);
  const budgetText = decimalText("max_deposit", input.max_deposit);
  const depositText = input.deposit === undefined ? maxSpendText : decimalText("deposit", input.deposit);
  if (compareDecimals(depositText, budgetText) > 0) {
    throw new ToolError("over_budget", `The public deposit (${depositText}) exceeds max_deposit (${budgetText}). No bid was sent.`, { nothingSent: true });
  }
  if (!cfg.relayerUrl && !direct) {
    throw new ToolError(
      "not_sponsored",
      `No relayer is configured (${ENV.relayer}), so the account would pay the NEAR gas. Pass direct: true only if the user approved paying gas.`,
      { nothingSent: true },
    );
  }

  // 2. The live bot's connect: network, contract, sale, quote token units, a full-access key of the account.
  const s = await openSale(cfg, saleId, { account: true, write: true, quoteMetadata: true, sponsoredOnly: !direct }, notes, {
    extra: { relayerUrl: direct ? null : cfg.relayerUrl },
  });
  const { sale, quote, client } = s;
  const bidder = cfg.accountId!;
  const q = (v: bigint | string) => `${plain(BigInt(v), quote.decimals)} ${quote.symbol}`;

  // 3. budgetedBid's checks, in its order, then the deposit limits placeBid would refuse.
  const deposit = baseUnits("deposit", depositText, quote.decimals);
  const budget = baseUnits("max_deposit", budgetText, quote.decimals);
  if (deposit > budget) throw new ToolError("over_budget", "The public deposit exceeds max_deposit. No bid was sent.", { nothingSent: true });
  const maxPrice = baseUnits("max_price", maxPriceText, quote.decimals, true);
  const maxSpend = baseUnits("max_spend", maxSpendText, quote.decimals, true);
  const problem = bidTermsProblem({ maxPrice, maxSpend }, deposit, BigInt(sale.floor_price));
  if (problem || maxPrice > U128_MAX) {
    throw new ToolError("invalid_terms", `${problem ?? "max_price exceeds the supported range."} Such a bid would be void and lose 1 % of its deposit.`, { nothingSent: true });
  }
  if (sale.reveal_mode !== "Tee") throw new ToolError("usage", `Sale ${saleId} is a commit-reveal sale. This server bids only in sealed-bid (TEE) sales.`, { nothingSent: true });
  if (sale.status !== "open") {
    const head = await chainHead(cfg.rpcUrl);
    throw new ToolError("sale_closed", `Sale ${saleId} is ${sale.status.replace(/_/g, " ")}. ${phaseOf(sale, head.timeNs).phase} Bid only while it is open.`, { nothingSent: true });
  }
  if (deposit < BigInt(sale.min_deposit)) throw new ToolError("invalid_terms", `The deposit ${q(deposit)} is below the sale's minimum of ${q(sale.min_deposit)}.`, { nothingSent: true });
  if (deposit > BigInt(sale.max_deposit_per_account)) {
    throw new ToolError("invalid_terms", `The deposit ${q(deposit)} is above the sale's per-account maximum of ${q(sale.max_deposit_per_account)}.`, { nothingSent: true });
  }
  if (await bidOf(s, bidder)) throw new ToolError("already_bid", `${bidder} already has a bid in ${saleId}. One bid per account.`, { nothingSent: true });
  const held = await ftBalance(s.rpc, quote.id, bidder);
  if (held < deposit) throw new ToolError("insufficient_usdc", `${bidder} holds ${q(held)}; the deposit needs ${q(deposit)}.`, { nothingSent: true });
  if (!direct) {
    const policy = await client.getRelayerPolicy();
    if (!policy || !policy.usdcContracts.includes(sale.quote_token)) {
      throw new ToolError(
        "not_sponsored",
        `${policy ? `The relayer does not sponsor bids in ${sale.quote_token}` : `The relayer at ${cfg.relayerUrl} did not answer GET /policy`}. No bid was sent. Pass direct: true only if the user approved paying the NEAR gas.`,
        { nothingSent: true },
      );
    }
  }
  if (!sale.sealer_pubkey) throw new ToolError("bid_failed", "The sale has no sale key, so a bid cannot be sealed.", { nothingSent: true });

  // 4. Seal with the app's code, keep the secret on this machine, then send.
  const salt = randomHex(16);
  const ciphertext = await sealBid(sale.sealer_pubkey, { sale_id: saleId, bidder, max_price: maxPrice.toString(), max_spend: maxSpend.toString(), salt });
  const sealed = fromB64(ciphertext);
  if (sealed.length !== sealedBidLen(saleId, bidder)) {
    throw new ToolError("bid_failed", `The sealed bid is ${sealed.length} bytes, not ${sealedBidLen(saleId, bidder)}. Nothing was sent.`, { nothingSent: true });
  }
  const secretFile = secretPath(cfg, saleId, bidder);
  const secret: BidSecret = {
    format: "sealround-bid-secret",
    version: 1,
    note: "Private until the sale closes: it holds the bid's max price, max spend and salt.",
    network: cfg.network,
    contract: cfg.contractId,
    saleId,
    bidder,
    mode: "tee",
    quote,
    deposit: deposit.toString(),
    maxPrice: maxPrice.toString(),
    maxSpend: maxSpend.toString(),
    salt,
    saleKey: sale.sealer_pubkey,
    sealedBytes: sealed.length,
    ciphertextSha256: await sha256Hex(sealed),
    status: "sending",
    txHash: null,
    index: null,
    placedAt: null,
    error: null,
    savedAt: "",
  };
  writeSecret(secretFile, secret);

  let placed: BidResult;
  try {
    placed = await client.placeBid(saleId, bidder, deposit, ciphertext, {
      onPaidFallback: () => {
        if (!direct) throw new Error("Relayed bid required.");
      },
    });
  } catch (error) {
    const unknown = !(error instanceof FairgroundError) || error.maybeSubmitted || error.code === "rpc_error";
    writeSecret(secretFile, { ...secret, status: unknown ? "unknown" : "not_placed", error: describe(error) });
    if (error instanceof FairgroundError && error.code === "cancelled") {
      throw new ToolError("not_sponsored", "The relayer could not sponsor the bid. No paid transaction was sent.", { nothingSent: true, secretFile });
    }
    const e = asToolError(error);
    const request = error instanceof FairgroundError && error.requestId ? ` Relayer request: ${error.requestId}.` : "";
    throw new ToolError(e.code === "invalid" ? "bid_failed" : e.code, `${e.message}.${request} Check the account's bid with sealround_my_bid before retrying.`, {
      ...e.extra,
      secretFile,
    });
  }
  const txHash = placed.relay?.txHash ?? placed.txHash ?? null;
  const view = await bidOf(s, bidder);
  writeSecret(secretFile, { ...secret, status: "placed", txHash, index: placed.index, placedAt: isoOfNs(view?.placed_at) });
  return {
    ok: true,
    network: cfg.network,
    contract: cfg.contractId,
    saleId,
    bidder,
    index: placed.index,
    txHash,
    paidBy: placed.relay?.paidBy ?? null,
    deposit: money(placed.deposit, quote.decimals, quote.symbol),
    sealedBytes: sealed.length,
    secretFile,
    privacy: "The deposit is public. The max price and max spend are sealed to the sale's enclave key and are only in the secret file on this machine.",
    notes,
  };
}

// ---------------------------------------------------------------- my_bid, get_result

/** What the account can still claim, from its fill and the launch pool's lock. */
function claimable(r: ReportResult, result: SaleResult) {
  const locked = !!result.liquidity && (result.liquidity.stage === "waiting" || result.liquidity.stage === "seeding");
  const tokens = BigInt(r.fill.tokens);
  const refund = BigInt(r.fill.refund);
  if (r.fill.claimed) return { tokens: money(0n, r.token.decimals, r.token.symbol), refund: money(0n, r.quote.decimals, r.quote.symbol), tokensLocked: false, alreadyClaimed: true };
  return {
    tokens: money(locked ? 0n : tokens, r.token.decimals, r.token.symbol),
    refund: money(refund, r.quote.decimals, r.quote.symbol),
    tokensLocked: locked && tokens > 0n,
    alreadyClaimed: false,
    ...(locked && tokens > 0n ? { lockNote: "The sale tokens stay locked until the launch pool is seeded (or abandoned after its deadline). A claim now pays the refund only." } : {}),
  };
}

/** The account's fill, by the live bot's `report` (the code of `live-bot result`): the price rule checked to the smallest unit. */
async function accountResult(s: Session, account: string, result: SaleResult) {
  const r = await report({ ...s, opts: { ...s.opts, accountId: account, claim: false, wait: false } }, { readLocalReceipt: false });
  const t = r.token;
  const qd = r.quote.decimals;
  const per = `${r.quote.symbol} per ${t.symbol}`;
  return {
    account,
    fill: {
      index: r.fill.index,
      valid: r.fill.valid,
      deposit: money(r.fill.deposit, qd, r.quote.symbol),
      tokens: money(r.fill.tokens, t.decimals, t.symbol),
      spent: money(r.fill.spent, qd, r.quote.symbol),
      refund: money(r.fill.refund, qd, r.quote.symbol),
      penalty: money(r.fill.penalty, qd, r.quote.symbol),
      claimed: r.fill.claimed,
      won: BigInt(r.fill.tokens) > 0n,
      paysClearingPrice: r.fill.paysClearingPrice,
      // spent / tokens per whole token; "..." marks a ratio that does not end within 12 places.
      pricePaidPerToken: r.pricePaidPerToken === null ? null : { amount: shiftDecimal(r.pricePaidPerToken, qd), base: r.pricePaidPerToken, symbol: per },
    },
    claimable: claimable(r, result),
    checks: r.checks,
    checksPassed: r.ok,
  };
}

/** A decimal in base units ("2034.5...") as whole units ("0.0020345..." for 6 decimals), keeping a trailing "...". */
function shiftDecimal(baseValue: string, decimals: number): string {
  const inexact = baseValue.endsWith("...");
  const [int, frac = ""] = baseValue.replace(/\.\.\.$/, "").split(".");
  const padded = int.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals).replace(/^0+(?=\d)/, "");
  const fraction = (padded.slice(padded.length - decimals) + frac).replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""}${inexact ? "..." : ""}`;
}

/** The sale-wide result, the same for everyone. */
function saleResult(v: SaleView, q: Quote, result: SaleResult, includeFills: boolean) {
  const t = tokenOf(v);
  const one = 10n ** BigInt(v.decimals);
  const price = result.clearingPrice;
  const winners = result.fills.filter((f) => f.tokens > 0n);
  const fair = winners.filter((f) => f.spent === costOf(f.tokens, price, one));
  return {
    status: result.status,
    failReason: result.chainFailReason ?? null,
    clearedBy: result.clearedBy ?? null,
    clearingPrice: money(price, q.decimals, `${q.symbol} per ${t.symbol}`),
    totalSold: money(result.totalSold, t.decimals, t.symbol),
    totalRaised: money(result.totalRaised, q.decimals, q.symbol),
    unsoldBurned: money(result.unsold, t.decimals, t.symbol),
    validBids: result.nValid,
    invalidBids: result.nInvalid,
    winners: winners.length,
    everyWinnerPaidClearingPrice: fair.length === winners.length,
    rule: "spent = ceil(tokens x clearing price / 10^decimals) for every winner",
    contractChecks: result.checks.map((c) => ({ id: c.id, label: c.label, passed: c.passed })),
    liquidity: result.liquidity
      ? {
          stage: result.liquidity.stage,
          poolId: result.liquidity.poolId,
          usdc: money(result.liquidity.usdc, q.decimals, q.symbol),
          tokens: money(result.liquidity.tokens, t.decimals, t.symbol),
          lpSharesHeldByContract: result.liquidity.shares.toString(),
        }
      : null,
    ...(includeFills
      ? {
          fills: result.fills.map((f) => ({
            index: f.index,
            bidder: f.bidder,
            valid: f.valid,
            deposit: plain(f.deposit, q.decimals),
            tokens: plain(f.tokens, t.decimals),
            spent: plain(f.spent, q.decimals),
            refund: plain(f.refund, q.decimals),
            penalty: plain(f.penalty ?? 0n, q.decimals),
            claimed: f.claimed,
          })),
          fillUnits: { deposit: q.symbol, tokens: t.symbol, spent: q.symbol, refund: q.symbol, penalty: q.symbol },
        }
      : {}),
  };
}

export async function myBid(cfg: ServerConfig, input: { sale_id: string }) {
  const notes: string[] = [];
  if (!cfg.accountId) throw new ToolError("usage", `No account configured: set ${ENV.account} (or ${ENV.keyFile}).`, { nothingSent: true });
  const s = await openSale(cfg, input.sale_id, { account: true }, notes);
  const account = cfg.accountId;
  const v = s.sale;
  const head = await chainHead(cfg.rpcUrl);
  const bid = await bidOf(s, account);
  const file = secretPath(cfg, v.sale_id, account);
  const secret = readSecretStatus(file);
  let outcome = null;
  if (bid && FINAL.includes(v.status)) {
    const result = await s.client.getResult(v.sale_id);
    if (result) outcome = await accountResult(s, account, result);
  }
  return {
    ok: true,
    network: cfg.network,
    contract: cfg.contractId,
    saleId: v.sale_id,
    account,
    status: v.status,
    ...phaseOf(v, head.timeNs),
    bid: bid ? publicBid(bid, s.quote) : null,
    secretFile: secret ? { path: file, status: secret.status, txHash: secret.txHash } : null,
    result: outcome,
    notes,
  };
}

export async function getResult(cfg: ServerConfig, input: { sale_id: string; account?: string; include_fills?: boolean; wait_seconds?: number }) {
  const notes: string[] = [];
  const account = input.account?.trim() || cfg.accountId;
  if (account && !ACCOUNT_ID.test(account)) throw new ToolError("usage", `account must be a NEAR account id (got "${account}").`, { nothingSent: true });
  const s = await openSale(cfg, input.sale_id, {}, notes, { account });
  let v = s.sale;
  const deadline = Date.now() + Math.min(Math.max(input.wait_seconds ?? 0, 0), 300) * 1000;
  while (!FINAL.includes(v.status) && Date.now() < deadline) {
    await sleep(3_000);
    v = (await s.rpc.view<SaleView | null>(cfg.contractId, "get_sale", { sale_id: v.sale_id }))!;
  }
  const head = await chainHead(cfg.rpcUrl);
  const base = { ok: true, network: cfg.network, contract: cfg.contractId, saleId: v.sale_id, status: v.status, ...phaseOf(v, head.timeNs) };
  if (!FINAL.includes(v.status)) {
    return { ...base, final: false, bidCount: v.bid_count, totalDeposits: money(v.total_deposits, s.quote.decimals, s.quote.symbol), notes };
  }
  const result = await s.client.getResult(v.sale_id);
  if (!result) throw new ToolError("not_settled", `Sale ${v.sale_id} has no result yet.`);
  let mine = null;
  if (account) {
    const bid = await bidOf(s, account);
    mine = bid ? await accountResult(s, account, result) : { account, fill: null, note: `${account} has no bid in this sale.` };
  }
  return { ...base, final: true, result: saleResult(v, s.quote, result, input.include_fills === true), account: mine, notes };
}

// ---------------------------------------------------------------- claim

export async function claim(cfg: ServerConfig, input: { sale_id: string; direct?: boolean }) {
  const notes: string[] = [];
  const direct = input.direct === true;
  refuseWriteLocally(cfg);
  const saleId = requireSaleId(input.sale_id);
  if (!cfg.relayerUrl && !direct) {
    throw new ToolError(
      "not_sponsored",
      `No relayer is configured (${ENV.relayer}), so the account would pay the NEAR gas. Pass direct: true only if the user approved paying gas.`,
      { nothingSent: true },
    );
  }
  const s = await openSale(cfg, saleId, { account: true, write: true }, notes, { extra: { relayerUrl: direct ? null : cfg.relayerUrl } });
  const { sale, quote, client } = s;
  const bidder = cfg.accountId!;
  if (!FINAL.includes(sale.status)) {
    const head = await chainHead(cfg.rpcUrl);
    throw new ToolError("not_settled", `Sale ${saleId} is ${sale.status.replace(/_/g, " ")}, not settled or failed: nothing to claim yet. ${phaseOf(sale, head.timeNs).phase}`, { nothingSent: true });
  }
  const bid = await bidOf(s, bidder);
  if (!bid) throw new ToolError("no_bid", `${bidder} has no bid in sale ${saleId}.`, { nothingSent: true });
  if (bid.claimed) throw new ToolError("already_claimed", `${bidder} already claimed everything this bid is owed.`, { nothingSent: true });
  if (!direct) {
    const policy = await client.getRelayerPolicy();
    if (!policy || !policy.methods.includes("claim")) {
      throw new ToolError(
        "not_sponsored",
        `${policy ? "The relayer does not sponsor claim" : `The relayer at ${cfg.relayerUrl} did not answer GET /policy`}. Nothing was sent. Pass direct: true only if the user approved paying the NEAR gas.`,
        { nothingSent: true },
      );
    }
  }
  const t = tokenOf(sale);
  const before = [await ftBalance(s.rpc, sale.quote_token, bidder), await ftBalance(s.rpc, sale.token, bidder)];
  const got = await client
    .claim(saleId, bidder, {
      onPaidFallback: () => {
        if (!direct) throw new Error("Relayed claim required.");
      },
    })
    .catch((e: unknown) => {
      if (e instanceof FairgroundError && e.code === "cancelled") {
        throw new ToolError("not_sponsored", "The relayer could not sponsor the claim. No paid transaction was sent.", { nothingSent: true });
      }
      throw asToolError(e);
    });
  const after = [await ftBalance(s.rpc, sale.quote_token, bidder), await ftBalance(s.rpc, sale.token, bidder)];
  return {
    ok: true,
    network: cfg.network,
    contract: cfg.contractId,
    saleId,
    account: bidder,
    txHash: got.txHash || null,
    paidBy: got.relay?.paidBy ?? null,
    tokens: money(got.tokens, t.decimals, t.symbol),
    refund: money(got.refund, quote.decimals, quote.symbol),
    received: {
      tokens: money(after[1] - before[1], t.decimals, t.symbol),
      quote: money(after[0] - before[0], quote.decimals, quote.symbol),
    },
    notes,
  };
}

// ---------------------------------------------------------------- verify_sale

function checkResult(ok: boolean | null) {
  return ok === true ? "pass" : ok === false ? "fail" : "not_run";
}

function runOut(run: AttestedRun | MissingRun) {
  const name = run.kind === "clear" ? "Clearing run" : "Sale key run";
  if (!run.found) return { kind: run.kind, name, found: false, reason: run.reason, message: run.message };
  return {
    kind: run.kind,
    name,
    found: true,
    txHash: run.txHash,
    signer: run.signer,
    method: run.method,
    foundVia: run.txSource,
    ...(run.scannedBlock ? { scannedBlock: run.scannedBlock } : {}),
    attestationId: run.attestationId,
    taskId: run.taskId,
    requestId: run.requestId,
    blockHeight: run.blockHeight,
    at: new Date(run.at).toISOString(),
    checks: run.checks.map((c) => ({ id: c.id, label: RUN_LABELS[c.id], result: checkResult(c.ok), evidence: c.items })),
    tdxQuote: `${run.quote.length} base64 characters (not included here)`,
    notCheckedHere: run.verifierUrl ? `The quote's signature chain up to Intel. OutLayer's verifier checks it: ${run.verifierUrl}` : "The quote's signature chain up to Intel.",
  };
}

export async function verifySale(cfg: ServerConfig, input: { sale_id: string }) {
  const notes: string[] = [];
  const s = await openSale(cfg, input.sale_id, {}, notes, { account: null });
  const saleId = s.opts.saleId;
  const verification: FullVerification = await s.client.verifySale(saleId);

  // The bid set, as scripts/verify-sale.ts reads it: every bid the contract lists, hashed the way it froze them.
  const rpc = jsonRpc([cfg.rpcUrl]);
  const sale = await viewCall<{ bid_count: number; bid_set_hash: string; closed_at: string | null }>(rpc, cfg.contractId, "get_sale", { sale_id: saleId });
  const bids: { index: number; bidder: string; deposit: string; payload: string }[] = [];
  for (let from = 0; from < sale.bid_count; from += 50) {
    bids.push(...(await viewCall<typeof bids>(rpc, cfg.contractId, "get_bids", { sale_id: saleId, from_index: from, limit: 50 })));
  }
  const frozen = sale.closed_at !== null;
  const bidSet = checkBidSet(
    saleId,
    bids.map((b) => ({ index: b.index, bidder: b.bidder, deposit: BigInt(b.deposit), ciphertext: b.payload })),
    frozen ? sale.bid_set_hash : null,
    sale.bid_count,
  );

  const runs = [verification.key, verification.clear].filter((r): r is AttestedRun | MissingRun => r !== null);
  const chain = verification.chain;
  const chainChecks = chain?.checks.map((c) => ({
    id: c.id,
    label: CHAIN_LABELS[c.id],
    result: c.applies ? checkResult(c.ok) : "not_applicable" as const,
    evidence: c.items,
    ...(c.note ? { note: c.note } : {}),
    ...(c.subject ? { subject: c.subject } : {}),
  })) ?? [];
  const failed = (frozen && !bidSet.matches)
    || runs.some((r) => r.found && r.checks.some((c) => c.ok === false))
    || chainChecks.some((c) => c.result === "fail");
  const incomplete = !chain || runs.some((r) => !r.found || r.checks.some((c) => c.ok === null))
    || chainChecks.some((c) => c.result === "not_run");
  const verdict = failed ? "fail" : incomplete ? "incomplete" : "pass";
  const account = cfg.accountId;
  return {
    // As verify-sale's exit code: true only when every check that applies ran and passed.
    ok: verdict === "pass",
    verdict,
    summary:
      verdict === "pass"
        ? "Every applicable check passed."
        : verdict === "fail"
          ? "A check failed. See the enclave runs, bid set and contract checks."
          : "Some checks could not run. See the enclave runs and contract checks for details.",
    network: cfg.network,
    contract: cfg.contractId,
    saleId,
    checkedAt: new Date(verification.checkedAt).toISOString(),
    pinnedSealer: verification.pinnedWasm,
    repoSealerHash: s.repoSealerHash,
    runs: runs.map(runOut),
    ...(runs.length === 0 ? { runsNote: "This sale has no enclave run to check (a commit-reveal sale, or no clearing result yet)." } : {}),
    chain: chain
      ? { available: true, simulated: chain.simulated, checks: chainChecks }
      : { available: false, checks: chainChecks, note: "Contract and rule checks are unavailable on this network." },
    bidSet: {
      frozen,
      result: frozen ? (bidSet.matches ? "pass" : "fail") : "not_frozen_yet",
      listed: bidSet.count,
      bidCount: bidSet.expectedCount,
      recomputedHash: bidSet.recomputed,
      frozenHash: bidSet.stored,
      ...(account ? { accountPlace: placeOf(bidSet, account), account } : {}),
      ...(bidSet.bidders.length <= 100 ? { bidders: bidSet.bidders } : { biddersNote: `${bidSet.bidders.length} bidders; not listed here.` }),
    },
    notes,
  };
}
