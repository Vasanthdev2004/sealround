/**
 * Pure maths for the demand meter on the sale page. Only public data goes in:
 * the sale's rules, the deposit total, and each bid's deposit, time and
 * payload length. Max prices and spends are sealed and never appear here.
 *
 * What the deposits prove, from the clearing rule (packages/clearing clear.ts):
 * a bid's max spend is at most its deposit, so the sale can raise at most the
 * deposits. The price P* is the highest P at or above the floor where the
 * demand D(P) = sum of floor(maxSpend * ONE / P) covers the supply S, else the
 * floor. D(P) <= deposits * ONE / P, so:
 *
 * - deposits below the min raise: a close now fails the sale and refunds everyone;
 * - deposits below S at the floor: not every token can sell, and P* is the floor;
 * - P* <= max(floor, floor(deposits * ONE / S)), and never above the max price.
 *
 * That last line is a ceiling, not a forecast: the sealed max prices decide
 * where the price lands, and most of it may sit at the floor.
 *
 * The launch pool does not change any of this. Its tokens come from a reserve
 * outside the supply for sale, and its USDC is a share of the raise, so the
 * targets use `saleSupply` and the min raise is checked on the whole raise.
 */

import { sealedBidLen } from "@/lib/crypto";
import type { BidRecord, SaleConfig } from "@/lib/types";

export type TargetId = "min_raise" | "floor_sell_out" | "max_sell_out";

export type Target = {
  id: TargetId;
  /** USDC base units. */
  amount: bigint;
  reached: boolean;
  /** Deposits over the amount, 0 to 1 (1 once reached). */
  share: number;
  /** USDC still missing, 0 once reached. */
  toGo: bigint;
};

export type Demand = {
  deposits: bigint;
  /**
   * The min raise (when above zero), every token at the floor, and with a max
   * price every token at that price: in that order, which is not always
   * smallest first (a min raise can sit above the floor sell-out).
   */
  targets: Target[];
  /** What every token for sale costs at the floor, USDC base units, rounded up. */
  floorSellOut: bigint;
  /** Deposits over `floorSellOut`, floored to a hundredth. 0 without a sale supply. */
  coverage: number;
  /** The highest clearing price these deposits allow, USDC base units per whole token. */
  priceCap: bigint;
  /** `priceCap` over the floor, floored to a hundredth. */
  capMultiple: number;
  /** The sale's max price, not the deposits, sets `priceCap`. */
  cappedByMax: boolean;
  /** A close now would fail the sale: the deposits cannot reach the min raise. */
  belowMinRaise: boolean;
  /** No price above the floor is reachable with these deposits (or the max price is the floor). */
  floorOnly: boolean;
};

type DemandConfig = Pick<SaleConfig, "saleSupply" | "floorPrice" | "maxPrice" | "minRaise" | "decimals">;

/** a / b as a number floored to a hundredth; 0 when b is not positive. Never rounds up. */
export function ratio(a: bigint, b: bigint): number {
  if (b <= 0n || a <= 0n) return 0;
  return Number((a * 100n) / b) / 100;
}

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/** USDC, rounded up, that buys `supply` token base units at `price` (USDC base units per whole token). */
export function costAt(supply: bigint, price: bigint, decimals: number): bigint {
  if (supply <= 0n || price <= 0n) return 0n;
  return ceilDiv(supply * price, 10n ** BigInt(decimals));
}

function target(id: TargetId, amount: bigint, deposits: bigint): Target {
  const reached = deposits >= amount;
  return {
    id,
    amount,
    reached,
    share: reached ? 1 : ratio(deposits, amount),
    toGo: reached ? 0n : amount - deposits,
  };
}

/** Everything the meter shows for `deposits` (USDC base units) under a sale's rules. */
export function demandOf(c: DemandConfig, deposits: bigint): Demand {
  const one = 10n ** BigInt(c.decimals);
  const floorSellOut = costAt(c.saleSupply, c.floorPrice, c.decimals);
  const targets: Target[] = [];
  if (c.minRaise > 0n) targets.push(target("min_raise", c.minRaise, deposits));
  targets.push(target("floor_sell_out", floorSellOut, deposits));
  if (c.maxPrice !== null) targets.push(target("max_sell_out", costAt(c.saleSupply, c.maxPrice, c.decimals), deposits));

  const byDeposits = c.saleSupply > 0n ? (deposits * one) / c.saleSupply : 0n;
  const uncapped = byDeposits > c.floorPrice ? byDeposits : c.floorPrice;
  const cappedByMax = c.maxPrice !== null && c.maxPrice < uncapped;
  const priceCap = cappedByMax ? c.maxPrice! : uncapped;

  return {
    deposits,
    targets,
    floorSellOut,
    coverage: ratio(deposits, floorSellOut),
    priceCap,
    capMultiple: ratio(priceCap, c.floorPrice),
    cappedByMax,
    belowMinRaise: deposits < c.minRaise,
    floorOnly: priceCap <= c.floorPrice,
  };
}

/**
 * "3.12×", "2×", "12×": a multiple for display, floored, never rounded up.
 * Under 10 up to two decimals (as the sales list writes "2.06× the floor"),
 * from 10 none.
 */
export function multipleStr(x: number): string {
  if (!Number.isFinite(x) || x <= 0) return "0×";
  if (x >= 10) return `${Math.floor(x).toLocaleString("en-US")}×`;
  return `${(Math.floor(Math.round(x * 1e6) / 1e4) / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}×`;
}

/** "62 %": a share floored to a whole percent, so a target never shows 100 % before it is reached. */
export function shareStr(share: number): string {
  const n = Math.max(0, Math.min(100, Math.floor(share * 100)));
  return `${n} %`;
}

// ---------- bids over time ----------

/** Slice lengths the chart may use, ms, shortest first. */
const SLICE_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400].map(
  (s) => s * 1000,
);

/** The shortest round slice that cuts `span` ms into at most `max` slices. */
export function sliceLength(span: number, max: number): number {
  const m = Math.max(1, Math.floor(max));
  return SLICE_STEPS.find((s) => Math.ceil(span / s) <= m) ?? Math.ceil(span / m);
}

export type Slice = {
  /** ms after the open where the slice starts and ends (the last one ends at the close). */
  from: number;
  to: number;
  bids: number;
  /** Deposits of the bids in this slice, USDC base units. */
  deposits: bigint;
  /** Bids and deposits from the open to the end of this slice. */
  totalBids: number;
  totalDeposits: bigint;
};

/**
 * The bid window cut into slices of `slice` ms from the open, each with the
 * bids that landed in it. A bid stamped before the open counts in the first
 * slice, one at or after the close in the last. Every slice is returned; the
 * chart decides which lie in the future.
 */
export function bucketBids(
  bids: readonly Pick<BidRecord, "placedAt" | "deposit">[],
  open: number,
  close: number,
  slice: number,
): Slice[] {
  const span = Math.max(1, close - open);
  const step = Math.max(1, slice);
  const n = Math.max(1, Math.ceil(span / step));
  const out: Slice[] = Array.from({ length: n }, (_, i) => ({
    from: i * step,
    to: Math.min(span, (i + 1) * step),
    bids: 0,
    deposits: 0n,
    totalBids: 0,
    totalDeposits: 0n,
  }));
  for (const b of bids) {
    const at = Math.min(Math.max(b.placedAt - open, 0), span);
    const i = Math.min(n - 1, Math.floor(at / step));
    out[i].bids += 1;
    out[i].deposits += b.deposit;
  }
  let bidsSoFar = 0;
  let depositsSoFar = 0n;
  for (const s of out) {
    bidsSoFar += s.bids;
    depositsSoFar += s.deposits;
    s.totalBids = bidsSoFar;
    s.totalDeposits = depositsSoFar;
  }
  return out;
}

/**
 * "+3s", "+1m 30s", "+2h", "+1h 10m", "+1d 6h": an offset from the open, exact
 * for every slice edge (whole seconds; a slice of an hour or more is whole minutes).
 */
export function offsetLabel(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const pair = (big: number, unit: string, small: number, sub: string) => `+${big}${unit}${small ? ` ${small}${sub}` : ""}`;
  if (s < 60) return `+${s}s`;
  if (s < 3600) return pair(Math.floor(s / 60), "m", s % 60, "s");
  if (s < 86400) return pair(Math.floor(s / 3600), "h", Math.floor((s % 3600) / 60), "m");
  return pair(Math.floor(s / 86400), "d", Math.floor((s % 86400) / 3600), "h");
}

/** Index of the slice with the most bids (the first on a tie), or -1 when none has any. */
export function busiestSlice(slices: readonly Pick<Slice, "bids">[]): number {
  let best = -1;
  slices.forEach((s, i) => {
    if (s.bids > 0 && (best < 0 || s.bids > slices[best].bids)) best = i;
  });
  return best;
}

/** Round gridline values for a count axis from 0 to at least `max`: 2 to 5 values, a 1, 2 or 5 step. */
export function countTicks(max: number): number[] {
  const top = Math.max(1, Math.ceil(max));
  let step = 1;
  for (let mag = 1; ; mag *= 10) {
    const s = [1, 2, 5].map((k) => k * mag).find((k) => Math.ceil(top / k) <= 4);
    if (s) {
      step = s;
      break;
    }
  }
  const last = Math.ceil(top / step) * step;
  const out: number[] = [];
  for (let v = 0; v <= last; v += step) out.push(v);
  return out;
}

// ---------- what the chain sees ----------

/** Bytes a canonical padded base64 string decodes to. */
export function base64Bytes(b64: string): number {
  const s = b64.trim();
  if (s.length === 0) return 0;
  const pad = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
  return Math.floor((s.length * 3) / 4) - pad;
}

/** A commit-reveal commitment: one sha256, 32 bytes. */
export const COMMITMENT_BYTES = 32;

export type SizeCheck = {
  /** Bids whose payload is exactly the length the rule gives. */
  exact: number;
  total: number;
};

/**
 * The leak check anyone can run on the public bid list: every sealed bid is
 * exactly 224 + len(sale id) + len(bidder) bytes (the amounts inside are
 * padded to 39 digits, so no price or spend changes the length), and every
 * commit-reveal commitment is 32 bytes.
 */
export function sizeCheck(
  saleId: string,
  commit: boolean,
  bids: readonly Pick<BidRecord, "bidder" | "ciphertext">[],
): SizeCheck {
  let exact = 0;
  for (const b of bids) {
    const want = commit ? COMMITMENT_BYTES : sealedBidLen(saleId, b.bidder);
    if (base64Bytes(b.ciphertext) === want) exact += 1;
  }
  return { exact, total: bids.length };
}
