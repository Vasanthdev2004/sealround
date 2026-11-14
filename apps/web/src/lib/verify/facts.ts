/**
 * One shape for what the checks read about a sale, whether it comes from the
 * contract's views (NEAR mode, verify-sale) or from the app's own types (the
 * mock, and the browser's "your bid" check over the result it already has).
 * Amounts are bigint base units.
 */

import type { BidView, FillView, ResultView, SaleView } from "../near/views";
import type { BidRecord, Sale, SaleResult } from "../types";

export type FactBid = { index: number; bidder: string; deposit: bigint; /** Ciphertext or commitment, standard base64. */ payload: string };
export type FactFill = { index: number; bidder: string; tokens: bigint; spent: bigint; refund: bigint; penalty: bigint };

export type SaleFacts = {
  contractId: string;
  saleId: string;
  token: string;
  quoteToken: string;
  mode: "tee" | "commit_reveal";
  /** "not_final" before the sale is settled or failed. */
  status: "settled" | "failed" | "not_final";
  /** The contract's fail reason (no_bids, no_valid_bids, below_min_raise, nothing_sold, checks_failed, refund_mode). */
  failReason: string | null;
  saleSupply: bigint;
  floorPrice: bigint;
  maxPrice: bigint | null;
  minRaise: bigint;
  decimals: number;
  /** The hash frozen at close; null before. */
  bidSetHash: string | null;
  /** sha256 of the sealer output the contract received (get_result.result_sha256); null without one. */
  resultSha256: string | null;
  bidCount: number;
  price: bigint;
  totalSold: bigint;
  totalRaised: bigint;
  nValid: number;
  nInvalid: number;
  /** Bids that got tokens, as the contract counts them; null when the source does not say. */
  nWinners: number | null;
  bids: FactBid[];
  /** Empty before the sale is final. */
  fills: FactFill[];
  liquidity: {
    dex: string;
    poolTokens: bigint;
    status: string;
    poolId: number | null;
    usdc: bigint;
    tokens: bigint;
    shares: bigint;
  } | null;
};

const n = (v: string | number | bigint | null | undefined): bigint => BigInt(v ?? 0);

/** From get_sale, get_result, get_bids and get_fills, as the contract prints them. */
export function factsFromViews(
  contractId: string,
  sale: SaleView,
  result: ResultView | null,
  bids: readonly BidView[],
  fills: readonly FillView[],
): SaleFacts {
  const status = sale.status === "settled" || sale.status === "failed" ? sale.status : "not_final";
  const terms = sale.liquidity ?? null;
  const l = result?.liquidity ?? null;
  return {
    contractId,
    saleId: sale.sale_id,
    token: sale.token,
    quoteToken: sale.quote_token,
    mode: sale.reveal_mode === "CommitReveal" ? "commit_reveal" : "tee",
    status,
    failReason: result?.fail_reason ?? null,
    saleSupply: n(sale.sale_supply),
    floorPrice: n(sale.floor_price),
    maxPrice: sale.max_price === null ? null : n(sale.max_price),
    minRaise: n(sale.min_raise),
    decimals: sale.decimals,
    bidSetHash: sale.closed_at ? sale.bid_set_hash : null,
    resultSha256: result?.result_sha256 ?? null,
    bidCount: sale.bid_count,
    price: n(result?.clearing_price),
    totalSold: n(result?.total_sold),
    totalRaised: n(result?.total_raised),
    nValid: result?.n_valid ?? 0,
    nInvalid: result?.n_invalid ?? 0,
    nWinners: result ? result.n_winners : null,
    bids: [...bids]
      .sort((a, b) => a.index - b.index)
      .map((b) => ({ index: b.index, bidder: b.bidder, deposit: n(b.deposit), payload: b.payload })),
    fills: [...fills]
      .sort((a, b) => a.index - b.index)
      .map((f) => ({ index: f.index, bidder: f.bidder, tokens: n(f.tokens), spent: n(f.spent), refund: n(f.refund), penalty: n(f.penalty) })),
    liquidity: terms
      ? {
          dex: terms.dex,
          poolTokens: n(terms.pool_tokens),
          status: l?.status ?? "waiting",
          poolId: l?.pool_id ?? null,
          usdc: n(l?.usdc),
          tokens: n(l?.tokens),
          shares: n(l?.shares),
        }
      : null,
  };
}

/** From the app's own sale, result and bid list (the mock, and the browser's result page). */
export function factsFromApp(contractId: string, sale: Sale, result: SaleResult | null, bids: readonly BidRecord[]): SaleFacts {
  const c = sale.config;
  const status = result ? result.status : "not_final";
  const l = result?.liquidity ?? null;
  const fills = result?.fills ?? [];
  return {
    contractId,
    saleId: sale.id,
    token: sale.tokenAccount,
    quoteToken: c.quoteToken,
    mode: c.revealMode === "commit_reveal" ? "commit_reveal" : "tee",
    status,
    failReason: result?.chainFailReason ?? null,
    saleSupply: c.saleSupply,
    floorPrice: c.floorPrice,
    maxPrice: c.maxPrice,
    minRaise: c.minRaise,
    decimals: c.decimals,
    bidSetHash: sale.bidSetHash,
    resultSha256: result?.resultSha256 ?? null,
    bidCount: sale.bidCount,
    price: result?.clearingPrice ?? 0n,
    totalSold: result?.totalSold ?? 0n,
    totalRaised: result?.totalRaised ?? 0n,
    nValid: result?.nValid ?? 0,
    nInvalid: result?.nInvalid ?? 0,
    nWinners: null,
    bids: [...bids]
      .sort((a, b) => a.index - b.index)
      .map((b) => ({ index: b.index, bidder: b.bidder, deposit: b.deposit, payload: b.ciphertext })),
    fills: [...fills]
      .sort((a, b) => a.index - b.index)
      .map((f) => ({ index: f.index, bidder: f.bidder, tokens: f.tokens, spent: f.spent, refund: f.refund, penalty: f.penalty ?? 0n })),
    liquidity: c.liquidity
      ? {
          dex: c.liquidity.dex,
          poolTokens: c.liquidity.poolTokens,
          status: l?.stage ?? "waiting",
          poolId: l?.poolId ?? null,
          usdc: l?.usdc ?? 0n,
          tokens: l?.tokens ?? 0n,
          shares: l?.shares ?? 0n,
        }
      : null,
  };
}
