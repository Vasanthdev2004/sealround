/**
 * The Fairground contract's views (contracts/fairground/src/views.rs) as the
 * RPC returns them, and their translation into the app's types. Pure
 * functions: no network, no storage.
 *
 * Units on chain: u128 and u64 arrive as decimal strings; times are
 * nanoseconds. The app uses bigint amounts and millisecond times.
 */

import { formatUnits } from "@fairground/clearing";
import { appFailReason, checkRows, OUTLAYER_COMPUTE_DEPOSIT } from "../client/rules";
import { fromB64, toHex } from "../crypto";
import type {
  BidRecord,
  ChainFailReason,
  ChainSaleStatus,
  DexPool,
  LiquidityStage,
  LiquidityState,
  LiquidityStep,
  LiquidityTerms,
  ResultFill,
  Sale,
  SaleConfig,
  SaleEvent,
  SaleMeta,
  SaleResult,
  SaleStatus,
  StepState,
} from "../types";
import type { TxLogEntry } from "./tx-log";

// ---------- the views, as JSON ----------

export type SaleView = {
  sale_id: string;
  status: ChainSaleStatus;
  creator: string;
  token: string;
  quote_token: string;
  token_name: string;
  token_symbol: string;
  decimals: number;
  icon: string | null;
  description: string | null;
  website: string | null;
  total_supply: string;
  sale_supply: string;
  creator_allocation: string;
  floor_price: string;
  max_price: string | null;
  min_raise: string;
  bid_start: string;
  bid_end: string;
  min_deposit: string;
  max_deposit_per_account: string;
  max_bids: number;
  reveal_mode: "Tee" | "CommitReveal";
  reveal_window: string | null;
  reveal_end: string | null;
  settle_timeout: string;
  refund_mode_at: string | null;
  unsold_rule: "Burn";
  sealer_code_hash: string;
  sealer_pubkey: string | null;
  token_setup: StepState;
  sealer_key_setup: StepState;
  created_at: string;
  closed_at: string | null;
  bid_count: number;
  total_deposits: string;
  bid_set_hash: string;
  /** Block height of the latest sealer key request. Newer contracts only; attestation-sources.ts uses it to find the transaction. */
  key_request_block?: number | string | null;
  /** Launch liquidity terms, fixed at creation. Absent on contracts without launch liquidity. */
  liquidity?: LiquidityTermsView | null;
};

/** get_sale `liquidity` (views.rs LiquidityTermsView). */
export type LiquidityTermsView = {
  dex: string;
  raise_share_bps: number;
  pool_tokens: string;
  fee_bps: number;
};

/** get_result `liquidity` (views.rs LiquidityView). */
export type LiquidityView = {
  status: LiquidityStage;
  next_step: LiquidityStep | null;
  in_flight: LiquidityStep | null;
  dex: string;
  pool_id: number | null;
  usdc: string;
  tokens: string;
  shares: string;
  usdc_on_dex: string;
  tokens_on_dex: string;
  failures: number;
  /** Nanoseconds; null before settlement. */
  deadline: string | null;
};

/** Ref exchange `get_pool` (SIMPLE_POOL): amounts in `token_account_ids` order. */
export type RefPoolView = {
  pool_kind: string;
  token_account_ids: string[];
  amounts: string[];
  total_fee: number;
  shares_total_supply: string;
};

export type BidView = {
  index: number;
  bidder: string;
  deposit: string;
  /** Ciphertext (TEE) or 32-byte commitment (commit-reveal), standard base64. */
  payload: string;
  placed_at: string;
  revealed: boolean;
  /** Everything this bid is owed has been paid out. */
  claimed: boolean;
};

export type ResultView = {
  sale_id: string;
  status: ChainSaleStatus;
  fail_reason: ChainFailReason | null;
  clearing_price: string;
  total_sold: string;
  total_raised: string;
  unsold: string;
  n_valid: number;
  n_invalid: number;
  n_winners: number;
  failed_checks: string[];
  failed_checks_total: number;
  result_sha256: string | null;
  input_sha256: string | null;
  clear_requests: number;
  clear_attempts: number;
  /** Block height of the latest clear request. Newer contracts only; attestation-sources.ts uses it to find the transaction. */
  clear_request_block?: number | string | null;
  total_penalties: string;
  proceeds: { raise_paid: boolean; allocation_paid: boolean; unsold_burned: boolean; reserve_returned: boolean };
  /** Launch liquidity progress. Absent on contracts without launch liquidity. */
  liquidity?: LiquidityView | null;
};

export type FillView = {
  index: number;
  bidder: string;
  tokens: string;
  spent: string;
  /** Net of `penalty`. */
  refund: string;
  penalty: string;
};

// ---------- units ----------

export const nsToMs = (ns: string): number => Number(BigInt(ns) / 1_000_000n);
export const msToNs = (ms: number): string => (BigInt(Math.round(ms)) * 1_000_000n).toString();
const optMs = (ns: string | null): number | null => (ns === null ? null : nsToMs(ns));

/** The app shows two contract statuses under another name: setup as upcoming, closed (a clearing retry is possible) as clearing. */
export function foldStatus(status: ChainSaleStatus): SaleStatus {
  if (status === "setup") return "upcoming";
  if (status === "closed") return "clearing";
  return status;
}

/** A colour for the token avatar. The contract stores none, so it is derived from the sale id. */
export function hueOf(saleId: string): number {
  let h = 0;
  for (let i = 0; i < saleId.length; i++) h = (h * 31 + saleId.charCodeAt(i)) % 360;
  return h;
}

// ---------- launch liquidity ----------

export function liquidityTermsFromView(v: LiquidityTermsView | null | undefined): LiquidityTerms | null {
  if (!v) return null;
  return { dex: v.dex, raiseShareBps: v.raise_share_bps, poolTokens: BigInt(v.pool_tokens), feeBps: v.fee_bps };
}

export function liquidityFromView(v: LiquidityView | null | undefined): LiquidityState | null {
  if (!v) return null;
  return {
    stage: v.status,
    nextStep: v.next_step,
    inFlight: v.in_flight,
    dex: v.dex,
    poolId: v.pool_id,
    usdc: BigInt(v.usdc),
    tokens: BigInt(v.tokens),
    shares: BigInt(v.shares),
    usdcOnDex: BigInt(v.usdc_on_dex),
    tokensOnDex: BigInt(v.tokens_on_dex),
    failures: v.failures,
    deadline: optMs(v.deadline),
  };
}

/** Sale tokens stay locked while the launch pool waits for settlement or is being seeded (liquidity.rs `locks_tokens`). */
const locksTokens = (v: Pick<LiquidityView, "status"> | null | undefined): boolean =>
  !!v && (v.status === "waiting" || v.status === "seeding");

/**
 * USDC of the raise that is not the creator's (liquidity.rs `usdc_kept`): the
 * pool's, or after abandonment what is still on the exchange (all of the
 * pool's share while the exchange is read again).
 */
export function poolUsdcKept(
  v: Pick<LiquidityView, "status" | "usdc" | "usdc_on_dex" | "next_step" | "in_flight"> | null | undefined,
): bigint {
  if (!v) return 0n;
  if (v.status === "seeding" || v.status === "seeded") return BigInt(v.usdc);
  // While a lost step's effects are read again (a reconcile due, nothing in flight) all of the pool's share is kept.
  if (v.status === "abandoned") return BigInt(v.next_step === "reconcile" && v.in_flight === null ? v.usdc : v.usdc_on_dex);
  return 0n;
}

/**
 * The pool as the exchange reports it. `poolId` and `dex` come from the
 * sale's liquidity view; `contractShares` is get_pool_shares for the sale
 * contract.
 */
export function poolFromView(dex: string, poolId: number, v: RefPoolView, contractShares: string, readAt: number): DexPool {
  return {
    dex,
    poolId,
    tokenIds: v.token_account_ids,
    amounts: v.amounts.map((a) => BigInt(a)),
    feeBps: v.total_fee,
    sharesTotal: BigInt(v.shares_total_supply),
    contractShares: BigInt(contractShares),
    readAt,
  };
}

// ---------- sale ----------

export function saleFromView(
  v: SaleView,
  extra: { failReason?: ChainFailReason | null; createTx?: string } = {},
): Sale {
  const commitReveal = v.reveal_mode === "CommitReveal";
  const totalSupply = BigInt(v.total_supply);
  const saleSupply = BigInt(v.sale_supply);
  const liquidity = liquidityTermsFromView(v.liquidity);
  const config: SaleConfig = {
    tokenName: v.token_name,
    tokenSymbol: v.token_symbol,
    decimals: v.decimals,
    totalSupply,
    saleSupply,
    // The contract has one creator share: everything that is not for sale or for the launch pool.
    creatorAllocation: BigInt(v.creator_allocation),
    lpReserve: liquidity?.poolTokens ?? 0n,
    floorPrice: BigInt(v.floor_price),
    maxPrice: v.max_price === null ? null : BigInt(v.max_price),
    minRaise: BigInt(v.min_raise),
    bidStart: nsToMs(v.bid_start),
    bidEnd: nsToMs(v.bid_end),
    minDeposit: BigInt(v.min_deposit),
    maxDepositPerAccount: BigInt(v.max_deposit_per_account),
    revealMode: commitReveal ? "commit_reveal" : "tee",
    unsoldRule: "burn",
    settleTimeoutMs: nsToMs(v.settle_timeout),
    quoteToken: v.quote_token,
    maxBids: v.max_bids,
    ...(v.reveal_window !== null ? { revealWindowMs: nsToMs(v.reveal_window) } : {}),
    ...(liquidity ? { liquidity } : {}),
  };
  const meta: SaleMeta = {
    description: v.description ?? "",
    hue: hueOf(v.sale_id),
    ...(v.website ? { website: v.website } : {}),
  };
  const closedAt = optMs(v.closed_at);
  const failReason = v.status === "failed" ? (extra.failReason ?? null) : null;
  return {
    id: v.sale_id,
    creator: v.creator,
    tokenAccount: v.token,
    config,
    meta,
    status: foldStatus(v.status),
    createdAt: nsToMs(v.created_at),
    createTx: extra.createTx ?? "",
    sealerPubkey: v.sealer_pubkey ?? "",
    sealerCodeHash: v.sealer_code_hash,
    bidSetHash: closedAt === null ? null : v.bid_set_hash,
    closedAt,
    // The views do not record when a sale became final.
    settledAt: null,
    // Nor when refund mode was triggered: this is the earliest it could have been.
    refundModeAt:
      failReason === "refund_mode" ? (closedAt ?? config.bidEnd) + config.settleTimeoutMs : null,
    bidCount: v.bid_count,
    totalDeposits: BigInt(v.total_deposits),
    isJudgeSale: false,
    chainStatus: v.status,
    maxBids: v.max_bids,
    revealEnd: optMs(v.reveal_end),
    refundModeFrom: optMs(v.refund_mode_at),
    chainFailReason: failReason,
    tokenSetup: v.token_setup,
    sealerKeySetup: v.sealer_key_setup,
    runningBidSetHash: v.bid_set_hash,
  };
}

/** create_sale's `params` for a config (sale.rs CreateSaleParams). Times in ms in, nanoseconds out. */
export function createSaleParams(saleId: string, config: SaleConfig, meta: SaleMeta): Record<string, unknown> {
  const commitReveal = config.revealMode === "commit_reveal";
  return {
    sale_id: saleId,
    token_name: config.tokenName,
    token_symbol: config.tokenSymbol,
    decimals: config.decimals,
    total_supply: config.totalSupply.toString(),
    sale_supply: config.saleSupply.toString(),
    floor_price: config.floorPrice.toString(),
    max_price: config.maxPrice === null ? null : config.maxPrice.toString(),
    min_raise: config.minRaise.toString(),
    bid_start: msToNs(config.bidStart),
    bid_end: msToNs(config.bidEnd),
    min_deposit: config.minDeposit.toString(),
    max_deposit_per_account: config.maxDepositPerAccount.toString(),
    max_bids: config.maxBids ?? DEFAULT_MAX_BIDS,
    reveal_mode: commitReveal ? "CommitReveal" : "Tee",
    ...(commitReveal && config.revealWindowMs !== undefined ? { reveal_window: msToNs(config.revealWindowMs) } : {}),
    settle_timeout: msToNs(config.settleTimeoutMs),
    quote_token: config.quoteToken,
    ...(meta.description.trim() ? { description: meta.description.trim() } : {}),
    ...(meta.website?.trim() ? { website: meta.website.trim() } : {}),
    // The contract picks the exchange (get_config `dex`); the terms name only the share, the reserve and the fee.
    ...(config.liquidity
      ? {
          liquidity: {
            raise_share_bps: config.liquidity.raiseShareBps,
            pool_tokens: config.liquidity.poolTokens.toString(),
            fee_bps: config.liquidity.feeBps,
          },
        }
      : {}),
  };
}

/** Bid slots of a new sale when the config names none. The creator prepays storage per slot (refunded for unused ones). */
export const DEFAULT_MAX_BIDS = 100;

// ---------- bids ----------

export function bidFromView(saleId: string, v: BidView, commitReveal: boolean, log: readonly TxLogEntry[] = []): BidRecord {
  const sent = log.findLast((e) => e.kind === "bid" && e.account === v.bidder && !e.detail);
  const claim = log.findLast((e) => e.kind === "claimed" && e.account === v.bidder && !e.detail);
  return {
    saleId,
    index: v.index,
    bidder: v.bidder,
    deposit: BigInt(v.deposit),
    ciphertext: v.payload,
    placedAt: nsToMs(v.placed_at),
    txHash: sent?.txHash ?? "",
    claimed: v.claimed,
    claimTx: v.claimed ? (claim?.txHash || null) : null,
    payloadKind: commitReveal ? "commitment" : "ciphertext",
    ...(commitReveal ? { revealed: v.revealed } : {}),
  };
}

/** A commit-reveal bid's commitment as 64 lowercase hex characters, from the view's base64 payload. */
export const commitmentHexOf = (payloadBase64: string): string => toHex(fromB64(payloadBase64));

// ---------- result ----------

/**
 * What claim_proceeds would still pay the creator of a final sale
 * (claims.rs `claim_proceeds`), read from the views.
 *
 * The contract sets each of its four `proceeds` flags only when that part was
 * actually paid, so a flag stays false for good when there was nothing of the
 * part to pay: no raise on a failed sale, nothing to burn when the sale sold
 * out, no allocation when the whole supply was for sale, no reserve when every
 * bid slot went to a winner. The flags alone therefore cannot say "nothing is
 * left"; this does.
 *
 * `reserveRefund` is get_reserve_refund, the yoctoNEAR the contract would
 * return now (0 once returned). Without it the reserve counts as owed until
 * its flag is set.
 */
export function proceedsLeft(
  sale: Pick<SaleView, "status" | "token_setup" | "creator_allocation">,
  result: Pick<ResultView, "total_raised" | "unsold" | "proceeds" | "liquidity">,
  reserveRefund?: bigint,
): { raise: boolean; allocation: boolean; burn: boolean; reserve: boolean } {
  const done = result.proceeds;
  const tokenReady = sale.token_setup === "done";
  // A token deploy still in flight decides whether its NEAR comes back: nothing is returned until it ends.
  const tokenSettled = sale.token_setup !== "pending";
  return {
    // The launch pool's USDC is never the creator's while it is planned or seeded, so the raise is owed
    // exactly when the sale raised anything: the pool takes at most half.
    raise: sale.status === "settled" && !done.raise_paid && BigInt(result.total_raised) > 0n,
    // Locked while the launch pool is being seeded: claim_proceeds cannot pay it yet (see allocationLocked).
    allocation: allocationOwed(sale, result) && !locksTokens(result.liquidity),
    burn: tokenReady && !done.unsold_burned && BigInt(result.unsold) > 0n,
    reserve: tokenSettled && !done.reserve_returned && (reserveRefund === undefined || reserveRefund > 0n),
  };
}

const allocationOwed = (
  sale: Pick<SaleView, "token_setup" | "creator_allocation">,
  result: Pick<ResultView, "proceeds">,
): boolean => sale.token_setup === "done" && !result.proceeds.allocation_paid && BigInt(sale.creator_allocation) > 0n;

/**
 * The creator allocation is owed but locked: the launch pool is being seeded,
 * and claim_proceeds keeps the allocation until it is seeded or abandoned.
 */
export function allocationLocked(
  sale: Pick<SaleView, "token_setup" | "creator_allocation">,
  result: Pick<ResultView, "proceeds" | "liquidity">,
): boolean {
  return allocationOwed(sale, result) && locksTokens(result.liquidity);
}

/**
 * The result of a final sale from get_sale, get_bids, get_result and
 * get_fills; null while the sale is not final.
 *
 * `proceeds` says for each creator payout whether it is settled: paid, or
 * never owed (see `proceedsLeft`). All four true means claim_proceeds has
 * nothing left to do. Pass `reserveRefund` (get_reserve_refund) so the NEAR
 * reserve can be told apart from "none to return"; without it
 * `reserveReturned` is the contract's own flag.
 *
 * What the views cannot say is left empty rather than invented:
 * - `settleTx` is "" and `clearingMs` is 0 (the settlement transaction is
 *   OutLayer's callback, or someone's clear_onchain);
 * - why a bid is void (`invalidReason`): the contract only knows which bids
 *   pay the penalty, so `valid` is false exactly for those;
 * - `bidSetHash` is the stored hash unless the `bid_set_hash_matches` check
 *   failed, in which case the enclave's own hash is not known ("").
 */
export function resultFromViews(
  sale: SaleView,
  bids: readonly BidView[],
  result: ResultView,
  fills: readonly FillView[],
  log: readonly TxLogEntry[] = [],
  reserveRefund?: bigint,
): SaleResult | null {
  if (sale.status !== "settled" && sale.status !== "failed") return null;
  const settled = sale.status === "settled";
  const left = proceedsLeft(sale, result, reserveRefund);
  const locked = allocationLocked(sale, result);
  const liquidity = liquidityFromView(result.liquidity);
  const tokenPending = sale.token_setup === "pending";
  const commitReveal = sale.reveal_mode === "CommitReveal";
  const failReason = settled ? null : result.fail_reason;
  const clearedBy: NonNullable<SaleResult["clearedBy"]> =
    failReason === "refund_mode" || failReason === "no_bids" ? "none" : commitReveal ? "onchain" : "enclave";
  const outFills: ResultFill[] = fills.map((f) => {
    const bid = bids[f.index];
    const penalty = BigInt(f.penalty);
    const claim = log.findLast((e) => e.kind === "claimed" && e.account === f.bidder && !e.detail);
    // While the tokens are locked a claim pays only the USDC, which no view records:
    // this browser knows it when it sent that claim. The later claim then pays the tokens only.
    const refundClaim = log.findLast((e) => e.kind === "claimed" && e.account === f.bidder && e.detail === "refund_claimed");
    return {
      index: f.index,
      bidder: f.bidder,
      deposit: BigInt(bid?.deposit ?? "0"),
      tokens: BigInt(f.tokens),
      spent: BigInt(f.spent),
      refund: BigInt(f.refund),
      valid: penalty === 0n,
      penalty,
      claimed: bid?.claimed ?? false,
      claimTx: bid?.claimed ? (claim?.txHash || null) : null,
      ...(commitReveal && bid ? { revealed: bid.revealed } : {}),
      ...(refundClaim ? { refundClaimed: true } : {}),
    };
  });
  const totalSold = BigInt(result.total_sold);
  const settleLog = log.findLast(
    (e) => (e.kind === "settled" || e.kind === "failed" || e.kind === "refund_mode") && !e.detail,
  );
  return {
    status: settled ? "settled" : "failed",
    ...(settled ? {} : { failReason: appFailReason(failReason) }),
    clearingPrice: BigInt(result.clearing_price),
    fills: outFills,
    totalSold,
    totalRaised: BigInt(result.total_raised),
    unsold: BigInt(result.unsold),
    // When demand at the floor reaches the supply, clearing sells all of it.
    oversubscribed: settled && totalSold === BigInt(sale.sale_supply),
    nValid: result.n_valid,
    nInvalid: result.n_invalid,
    bidSetHash: result.failed_checks.includes("bid_set_hash_matches") ? "" : sale.bid_set_hash,
    checks:
      clearedBy === "none"
        ? []
        : checkRows(result.failed_checks, { clearedBy, hasCeiling: sale.max_price !== null }),
    settleTx: settleLog?.txHash ?? "",
    clearingMs: 0,
    totalPenalties: BigInt(result.total_penalties),
    ...(failReason ? { chainFailReason: failReason } : {}),
    failedChecks: result.failed_checks,
    failedChecksTotal: result.failed_checks_total,
    resultSha256: result.result_sha256,
    inputSha256: result.input_sha256,
    clearedBy,
    // While the token deploy is in flight nothing token-related can be paid yet, which is not the same as settled.
    proceeds: {
      raisePaid: !left.raise,
      allocationPaid: !left.allocation && !tokenPending,
      unsoldBurned: !left.burn && !tokenPending,
      reserveReturned: !left.reserve && !tokenPending,
      ...(locked ? { allocationLocked: true } : {}),
    },
    ...(liquidity ? { liquidity } : {}),
  };
}

// ---------- timeline ----------

const usdc = (v: bigint): string => {
  const whole = v / 1_000_000n;
  const frac = (v % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
};

/**
 * The sale's timeline. The contract has no event view, so the rows are
 * derived from what the views do hold, and each row says how it was obtained:
 *
 * - `source: "view"`: read from a view. Creation, every bid and the close
 *   carry their real block time (created_at, placed_at, closed_at). Reveals,
 *   the outcome, claims and creator payouts are visible in the views but not
 *   timed there: those rows have `approximate: true` and `at` is the earliest
 *   the event could have happened (or this browser's clock, when this browser
 *   sent the transaction).
 * - `source: "tx"`: only this browser knows it: a bid the contract returned
 *   (`bid_rejected` leaves no trace in any view).
 *
 * `txHash` is "" unless this browser sent the transaction (the local log).
 * Rows are newest first. Rows that share a block time are kept in order by a
 * sub-millisecond offset, so `at` can have a fraction.
 */
export function eventsFromViews(
  sale: SaleView,
  bids: readonly BidView[],
  result: ResultView | null,
  fills: readonly FillView[],
  log: readonly TxLogEntry[] = [],
): SaleEvent[] {
  const saleId = sale.sale_id;
  const commitReveal = sale.reveal_mode === "CommitReveal";
  const out: SaleEvent[] = [];
  const sent = (kind: SaleEvent["kind"], account?: string, detail?: SaleEvent["detail"]) =>
    log.findLast((e) => e.kind === kind && (account === undefined || e.account === account) && e.detail === detail);
  const view = (e: Omit<SaleEvent, "saleId" | "txHash" | "source"> & { txHash?: string }): void => {
    out.push({ saleId, txHash: "", source: "view", ...e });
  };
  /** A row whose time the views do not hold: this browser's clock if it sent the transaction, else a lower bound. */
  const untimed = (
    e: Omit<SaleEvent, "saleId" | "txHash" | "source" | "at" | "approximate">,
    lowerBound: number,
    own: TxLogEntry | undefined,
  ): void => {
    view({ ...e, at: own ? Math.max(own.at, lowerBound) : lowerBound, approximate: true, txHash: own?.txHash ?? "" });
  };

  const createdAt = nsToMs(sale.created_at);
  view({
    kind: "created",
    at: createdAt,
    account: sale.creator,
    note: `Sale created. ${sale.token_symbol} is the token account ${sale.token}, with a fixed supply and no admin key.`,
    txHash: sent("created")?.txHash ?? "",
  });
  if (sale.status === "setup") {
    const failed = sale.token_setup === "failed" || sale.sealer_key_setup === "failed";
    view({
      kind: "created",
      detail: "sale_ready",
      at: createdAt + 0.001,
      approximate: true,
      note: failed
        ? "Setup did not finish: a step failed. Anyone can retry it."
        : "Setting up: deploying the token and asking the enclave for the sale key.",
    });
  }

  for (const b of bids) {
    const deposit = BigInt(b.deposit);
    view({
      kind: "bid",
      // Bids of one block share a timestamp; the index keeps them apart and in order.
      at: nsToMs(b.placed_at) + b.index / 1000,
      account: b.bidder,
      amount: deposit,
      note: commitReveal
        ? `Committed bid with ${usdc(deposit)} USDC deposit. Price hidden until the reveal.`
        : `Sealed bid with ${usdc(deposit)} USDC deposit. Price hidden.`,
      txHash: sent("bid", b.bidder)?.txHash ?? "",
    });
  }

  const closedAt = optMs(sale.closed_at);
  if (closedAt !== null) {
    view({
      kind: "closed",
      at: closedAt,
      note: `Bid set frozen at ${sale.bid_count} bids.`,
      txHash: sent("closed")?.txHash ?? "",
    });
    if (!commitReveal && (result?.clear_requests ?? 0) > 0) {
      view({
        kind: "clearing_requested",
        at: closedAt + 0.001,
        note:
          result && result.clear_requests > 1
            ? `Sealed bids sent to the OutLayer enclave (${result.clear_requests} requests so far).`
            : "Sealed bids sent to the OutLayer enclave (yield/resume).",
      });
    }
    if (result && result.clear_attempts > 0 && sale.status === "closed") {
      view({
        kind: "clearing_requested",
        detail: "clearing_failed",
        at: closedAt + 0.002,
        approximate: true,
        note: `The enclave did not return a result (${result.clear_attempts} attempt${result.clear_attempts === 1 ? "" : "s"}). Anyone can call close_sale again.`,
      });
    }
    if (commitReveal) {
      for (const b of bids) {
        if (!b.revealed) continue;
        untimed(
          { kind: "bid", detail: "bid_revealed", account: b.bidder, note: "Bid revealed." },
          closedAt + 0.01 + b.index / 1000,
          sent("bid", b.bidder, "bid_revealed"),
        );
      }
    }
  }

  const final = sale.status === "settled" || sale.status === "failed";
  if (final && result) {
    // The earliest the sale could have become final.
    const revealEnd = optMs(sale.reveal_end);
    const base = (commitReveal ? (revealEnd ?? closedAt) : closedAt) ?? nsToMs(sale.bid_end);
    const penalties = BigInt(result.total_penalties);
    const penaltyNote = penalties > 0n ? ` Void bids lose the 1 % penalty (${usdc(penalties)} USDC in all).` : "";
    if (sale.status === "settled") {
      untimed(
        {
          kind: "settled",
          amount: BigInt(result.total_raised),
          note: `Cleared at ${usdc(BigInt(result.clearing_price))} USDC per token. ${result.n_valid} valid bids, ${result.n_invalid} void.${
            commitReveal ? " Cleared by the contract from the revealed bids." : " All contract checks passed."
          }`,
        },
        base + 0.1,
        sent("settled"),
      );
    } else if (result.fail_reason === "refund_mode") {
      untimed(
        {
          kind: "refund_mode",
          note: "Settle timeout passed with no result. Sale moved to refunds. Every deposit can be claimed in full.",
        },
        (closedAt ?? nsToMs(sale.bid_end)) + nsToMs(sale.settle_timeout),
        sent("refund_mode"),
      );
    } else {
      const note =
        result.fail_reason === "no_bids"
          ? "Closed with no bids. Nothing to refund."
          : result.fail_reason === "below_min_raise" || result.fail_reason === "nothing_sold"
            ? `Minimum raise not met. Every bidder can claim their deposit back.${penaltyNote}`
            : result.fail_reason === "no_valid_bids"
              ? `No valid bids. Every bidder can claim their deposit back.${penaltyNote}`
              : "A contract check failed. Every bidder can claim a full refund.";
      untimed({ kind: "failed", note }, base + 0.1, sent("failed"));
    }
    const liq = result.liquidity;
    if (sale.status === "settled" && liq && (liq.status === "seeded" || liq.status === "abandoned")) {
      const detail = liq.status === "seeded" ? "liquidity_seeded" : "liquidity_abandoned";
      untimed(
        {
          kind: "settled",
          detail,
          amount: BigInt(liq.usdc),
          note:
            liq.status === "seeded"
              ? `Launch pool seeded at the clearing price: ${usdc(BigInt(liq.usdc))} USDC and ${formatUnits(BigInt(liq.tokens), sale.decimals, 4)} ${sale.token_symbol}${
                  liq.pool_id !== null ? ` in pool ${liq.pool_id}` : ""
                }. The sale contract keeps the LP shares.`
              : `Launch pool not seeded by its deadline and abandoned. Its ${usdc(BigInt(liq.usdc))} USDC goes to the creator and its tokens are burned.`,
        },
        base + 0.15,
        sent("settled", undefined, detail),
      );
    }
    const p = result.proceeds;
    if (p.raise_paid || p.allocation_paid || p.unsold_burned || p.reserve_returned) {
      // The creator's raise is the total less the launch pool's USDC.
      const raise = BigInt(result.total_raised) - poolUsdcKept(liq);
      const allocationLeft = !p.allocation_paid && BigInt(sale.creator_allocation) > 0n;
      untimed(
        {
          kind: "claimed",
          detail: "proceeds_claimed",
          account: sale.creator,
          ...(p.raise_paid && raise > 0n ? { amount: raise } : {}),
          note: p.raise_paid
            ? allocationLeft && locksTokens(liq)
              ? `Creator paid ${usdc(raise)} USDC of the raise. The creator allocation unlocks once the launch pool is seeded.`
              : `Creator paid: ${usdc(raise)} USDC raised and the creator allocation. Unsold tokens burned.`
            : "Creator allocation paid. The unsold sale tokens were burned.",
        },
        base + 0.2,
        sent("claimed", sale.creator, "proceeds_claimed"),
      );
    }
    for (const b of bids) {
      // A claim while the tokens were locked paid only the USDC; no view records it, so only this browser's log knows.
      const refundOnly = sent("claimed", b.bidder, "refund_claimed");
      if (refundOnly) {
        untimed(
          {
            kind: "claimed",
            detail: "refund_claimed",
            account: b.bidder,
            amount: BigInt(fills[b.index]?.refund ?? "0"),
            note: `Claimed ${usdc(BigInt(fills[b.index]?.refund ?? "0"))} USDC unspent. The tokens unlock once the launch pool is seeded.`,
          },
          base + 0.3 + b.index / 1000,
          refundOnly,
        );
      }
      if (!b.claimed) continue;
      const fill = fills[b.index];
      const refund = BigInt(fill?.refund ?? "0");
      const tokens = BigInt(fill?.tokens ?? "0");
      const penalty = BigInt(fill?.penalty ?? "0");
      untimed(
        {
          kind: "claimed",
          account: b.bidder,
          amount: refundOnly ? 0n : refund,
          note:
            tokens > 0n
              ? refundOnly
                ? "Claimed tokens. The unspent USDC was paid earlier."
                : `Claimed tokens and ${usdc(refund)} USDC unspent.`
              : penalty > 0n
                ? `Claimed ${usdc(refund)} USDC: the deposit less the 1 % penalty for a void bid.`
                : `Claimed full refund of ${usdc(refund)} USDC.`,
        },
        base + 0.3 + b.index / 1000 + 0.0005,
        sent("claimed", b.bidder),
      );
    }
  }

  // Bids the contract returned: only the browser that sent them knows.
  for (const e of log) {
    if (e.kind !== "bid_rejected") continue;
    out.push({
      saleId,
      kind: "bid_rejected",
      at: e.at,
      txHash: e.txHash,
      note: e.note ?? "Deposit returned.",
      source: "tx",
      approximate: true,
      ...(e.account ? { account: e.account } : {}),
      ...(e.amount ? { amount: BigInt(e.amount) } : {}),
      ...(e.reason ? { reason: e.reason } : {}),
    });
  }

  return out.sort((a, b) => b.at - a.at);
}

/** What retry_setup must attach: OutLayer's compute deposit when the sale key step failed, nothing otherwise. */
export function retrySetupDeposit(sale: Pick<SaleView, "status" | "sealer_key_setup">, override?: bigint): bigint {
  const retriesKey = sale.status === "setup" && sale.sealer_key_setup === "failed";
  return retriesKey ? (override ?? OUTLAYER_COMPUTE_DEPOSIT) : 0n;
}
