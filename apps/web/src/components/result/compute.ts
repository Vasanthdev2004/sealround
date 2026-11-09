/**
 * Pure helpers for the result page. All money stays bigint; floats appear only
 * for percentages and chart display.
 */

import { formatUnits, type InvalidReason } from "@fairground/clearing";
import type { Tone } from "@/lib/format";
import type { Sale, SaleResult } from "@/lib/types";

export type ResultFill = SaleResult["fills"][number];

/** Plain words for every reason a sealed bid can be void. */
export const VOID_TEXT: Record<InvalidReason, string> = {
  decrypt_failed: "Could not be decrypted",
  bidder_mismatch: "Copied ciphertext",
  spend_above_deposit: "Max spend above deposit",
  price_below_floor: "Below floor",
  zero_spend: "Zero max spend",
};

export const VOID_LONG: Record<InvalidReason, string> = {
  decrypt_failed: "The enclave could not decrypt this bid, so it counts as zero.",
  bidder_mismatch:
    "This ciphertext was sealed by another account and copied. The enclave voids copies, so it counts as zero.",
  spend_above_deposit: "The sealed max spend was larger than the deposit, so the bid counts as zero.",
  price_below_floor: "The sealed max price was below the floor, so the bid counts as zero.",
  zero_spend: "The sealed max spend was zero, so the bid counts as zero.",
};

/**
 * Fills as the bidder experiences them. On a failed sale nobody gets tokens
 * and every deposit comes back, whatever the enclave computed.
 */
export function effectiveFills(result: SaleResult): ResultFill[] {
  if (result.status !== "failed") return result.fills;
  return result.fills.map((f) => ({ ...f, tokens: 0n, spent: 0n, refund: f.deposit }));
}

export type FillStatus = "filled" | "partial" | "refunded" | "void";

export function fillStatus(f: ResultFill): FillStatus {
  if (!f.valid) return "void";
  if (f.tokens === 0n) return "refunded";
  return f.refund > 0n ? "partial" : "filled";
}

export const isBot = (f: Pick<ResultFill, "tag">) => f.tag === "bot";
export const isYou = (f: Pick<ResultFill, "tag" | "bidder">, account: string | null) =>
  f.tag === "you" || (!!account && f.bidder === account);

export type GroupStats = {
  /** Bids in the group. */
  bids: number;
  /** Bids that received tokens. */
  filled: number;
  tokens: bigint;
  spent: bigint;
  /** spent / tokens in USDC base units per whole token, floored. null when nothing was bought. */
  avgPrice: bigint | null;
};

export function groupStats(fills: ResultFill[], decimals: number): GroupStats {
  let tokens = 0n;
  let spent = 0n;
  let filled = 0;
  for (const f of fills) {
    tokens += f.tokens;
    spent += f.spent;
    if (f.tokens > 0n) filled += 1;
  }
  const one = 10n ** BigInt(decimals);
  return {
    bids: fills.length,
    filled,
    tokens,
    spent,
    avgPrice: tokens > 0n ? (spent * one) / tokens : null,
  };
}

/** a / b as a percentage with two decimals of precision. */
export function pct(a: bigint, b: bigint): number {
  if (b === 0n) return 0;
  return Number((a * 10_000n) / b) / 100;
}

export function pctStr(p: number): string {
  if (p > 0 && p < 0.1) return "<0.1%";
  return `${p.toFixed(p >= 10 ? 0 : 1)}%`;
}

/** "3.1×" — how far the clearing price sits above the floor. */
export function floorMultiple(price: bigint, floor: bigint): string {
  if (floor <= 0n) return "–";
  return `${(Number((price * 100n) / floor) / 100).toFixed(1)}×`;
}

/** Token base units to a float, for charts only. */
export function toFloat(v: bigint, decimals: number): number {
  return Number(formatUnits(v, decimals, 6).replaceAll(",", ""));
}

/** Gini coefficient of non-negative values, 0 = perfectly even, 1 = one holder. */
export function gini(values: number[]): number {
  const xs = values.filter((v) => v > 0).sort((a, b) => a - b);
  const n = xs.length;
  if (n < 2) return 0;
  const total = xs.reduce((a, b) => a + b, 0);
  if (total === 0) return 0;
  let weighted = 0;
  xs.forEach((x, i) => (weighted += (i + 1) * x));
  return (2 * weighted) / (n * total) - (n + 1) / n;
}

/** Share of `total` held by the `k` largest fills. */
export function topShare(fills: ResultFill[], k: number, total: bigint): number {
  const top = [...fills]
    .sort((a, b) => (b.tokens > a.tokens ? 1 : b.tokens < a.tokens ? -1 : 0))
    .slice(0, k)
    .reduce((a, f) => a + f.tokens, 0n);
  return pct(top, total);
}

/** Plain-words explanation for a failed sale. */
export function failText(result: SaleResult, sale: Sale): { title: string; body: string } {
  switch (result.failReason) {
    case "below_min_raise":
      return {
        title: "Minimum raise not met",
        body: "The valid sealed bids did not add up to the minimum raise the creator locked at launch, so the sale did not go ahead. No tokens were sold.",
      };
    case "no_valid_bids":
      return {
        title: "No valid bids",
        body: "None of the sealed bids could be used: each one failed to decrypt, was below the floor, or broke a rule. Nothing was sold.",
      };
    case "settle_timeout":
      return {
        title: "The enclave never answered",
        body: `No clearing result arrived within the ${Math.round(
          sale.config.settleTimeoutMs / 3_600_000,
        )}-hour settle timeout. After that anyone can switch the sale to refunds, and someone did. Sealed bids were never opened.`,
      };
    default:
      return {
        title: "A contract check failed",
        body: "The enclave returned a result, but the contract's own checks rejected it, so the sale moved to refunds instead of settling.",
      };
  }
}

export const STATUS_BADGE: Record<FillStatus, { label: string; tone: Tone; title: string }> = {
  filled: { label: "Filled", tone: "ok", title: "Got tokens and spent the whole deposit." },
  partial: {
    label: "Partly filled",
    tone: "accent",
    title:
      "Got tokens and some USDC back: the bid was pro-rated at the clearing price, or its max spend was below the deposit.",
  },
  refunded: { label: "Refunded", tone: "neutral", title: "No tokens. The whole deposit comes back." },
  void: { label: "Void", tone: "bad", title: "The bid could not be used. The whole deposit comes back." },
};
