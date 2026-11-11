import { duration, priceStr, usdcStr } from "@/lib/format";
import type { Sale, SaleResult } from "@/lib/types";

export function saleHref(sale: Sale): string {
  return sale.status === "settled" || sale.status === "failed" ? `/sale/${sale.id}/result` : `/sale/${sale.id}`;
}

export const isDone = (sale: Sale) => sale.status === "settled" || sale.status === "failed";

const FAIL_TEXT: Record<NonNullable<SaleResult["failReason"]>, string> = {
  below_min_raise: "Missed its minimum raise",
  no_valid_bids: "No valid bids",
  settle_timeout: "Enclave timed out",
};

/** "1.6" for a clearing price 1.6 times the floor. */
export function floorMultiple(price: bigint, floor: bigint): string {
  const x = Number((price * 100n) / floor) / 100;
  return x.toLocaleString("en-US", { maximumFractionDigits: x >= 10 ? 0 : 2 });
}

/**
 * Where a sale is in time, as words: a headline value (often a countdown
 * target), the phrase that goes with it, and an optional call to attention.
 * `until` set means "render a live countdown to this instant" instead of `value`.
 */
export type SaleTiming = {
  /** Short phrase before the value on a large display: "Closes in". */
  label: string;
  /** Static value, when there is no countdown. */
  value?: string;
  /** Countdown target, unix ms. */
  until?: number;
  /** Phrase after the value in a table cell: "left to bid". */
  note: string;
  /** The note describes a step anyone can take now. */
  canAct?: boolean;
};

export function saleTiming(sale: Sale, now: number, result?: SaleResult | null): SaleTiming {
  const c = sale.config;
  switch (sale.status) {
    case "upcoming":
      return { label: "Opens in", until: c.bidStart, note: `then a ${duration(c.bidEnd - c.bidStart)} window` };
    case "open":
      return { label: "Closes in", until: c.bidEnd, note: "left to bid" };
    case "awaiting_close":
      return {
        label: "Window ended",
        value: `${duration(now - c.bidEnd)} ago`,
        note: "Anyone can close it now",
        canAct: true,
      };
    case "revealing":
      return {
        label: "Reveal window open for",
        value: duration(now - (sale.closedAt ?? c.bidEnd)),
        note: "Bidders are revealing",
      };
    case "clearing": {
      const closed = sale.closedAt ?? c.bidEnd;
      if (now >= closed + c.settleTimeoutMs) {
        return {
          label: "Timed out",
          value: `${duration(now - closed - c.settleTimeoutMs)} ago`,
          note: "Anyone can trigger refunds",
          canAct: true,
        };
      }
      return { label: "Clearing for", value: duration(now - closed), note: "The enclave is clearing" };
    }
    case "settled": {
      const at = sale.settledAt ?? sale.closedAt ?? c.bidEnd;
      return { label: "Cleared", value: `${duration(now - at)} ago`, note: "Tokens and refunds are claimable" };
    }
    default: {
      const at = sale.refundModeAt ?? sale.closedAt ?? c.bidEnd;
      const reason = result?.failReason ?? (sale.refundModeAt ? "settle_timeout" : null);
      return {
        label: "Failed",
        value: `${duration(now - at)} ago`,
        note: reason ? FAIL_TEXT[reason] : "Sale failed",
      };
    }
  }
}

/** The one price that matters for a sale right now, and what it is. */
export type SalePrice = {
  /** Formatted number, ready for `Price`. Null while a settled sale's result loads or is missing. */
  value: string | null;
  unit: string;
  /** What the number is: "Floor price", "Clearing price", "Refundable". */
  label: string;
  /** A second fact: "1.6x the floor". */
  note?: string;
};

export function salePrice(sale: Sale, result?: SaleResult | null): SalePrice {
  const c = sale.config;
  if (sale.status === "settled") {
    if (!result) return { value: null, unit: "USDC", label: "Clearing price" };
    const atFloor = result.clearingPrice === c.floorPrice;
    return {
      value: priceStr(result.clearingPrice),
      unit: "USDC",
      label: "Clearing price",
      note: atFloor ? "At the floor" : `${floorMultiple(result.clearingPrice, c.floorPrice)}× the floor`,
    };
  }
  if (sale.status === "failed") {
    // Deposits come back whole, except the 1% a void bid loses.
    const penalties = result?.totalPenalties ?? 0n;
    return {
      value: usdcStr(sale.totalDeposits - penalties),
      unit: "USDC",
      label: penalties > 0n ? "Refundable, after penalties" : "Refundable in full",
    };
  }
  return { value: priceStr(c.floorPrice), unit: "USDC", label: "Floor price" };
}
