/**
 * The five arena metrics, computed from integer outcomes. Floats appear only
 * here, in the reported numbers.
 */

import { oneToken, type ArenaConfig } from "./config";
import type { Agent } from "./crowd";
import type { LaunchOutcome } from "./launches";
import type { MarketOutcome } from "./market";

export type MetricId = "botShare" | "botProfit" | "premium" | "humansFilled" | "gini";

export const METRIC_IDS: MetricId[] = ["botShare", "botProfit", "premium", "humansFilled", "gini"];

export type MetricDef = {
  id: MetricId;
  label: string;
  definition: string;
  /** How to print it: share = percent, usdc = dollars, ratio = "1.00x", index = 0..1. */
  unit: "share" | "usdc" | "ratio" | "index";
  /** Which direction is better for humans. */
  better: "lower" | "higher";
};

export const METRICS: MetricDef[] = [
  {
    id: "botShare",
    label: "Bot share of supply",
    definition: "Tokens bought by bots at launch ÷ all tokens bought at launch.",
    unit: "share",
    better: "lower",
  },
  {
    id: "botProfit",
    label: "Bot profit",
    definition:
      "USDC bots receive selling to later human buyers, minus what they paid for the tokens they sold. Tokens they cannot sell count as zero.",
    unit: "usdc",
    better: "lower",
  },
  {
    id: "premium",
    label: "Human price premium",
    definition:
      "Median price per token paid by humans who got tokens (launch plus pool) ÷ the average price bots paid at launch.",
    unit: "ratio",
    better: "lower",
  },
  {
    id: "humansFilled",
    label: "Humans filled",
    definition: "Share of the humans holding any tokens at the end, from the launch or the pool.",
    unit: "share",
    better: "higher",
  },
  {
    id: "gini",
    label: "Holder concentration",
    definition: "Gini coefficient of final holdings across every account holding tokens. 0 = equal, 1 = one holder.",
    unit: "index",
    better: "lower",
  },
];

export type LaunchMetrics = {
  botShare: number;
  /** USDC. */
  botProfit: number;
  /** null when no human got tokens. */
  premium: number | null;
  humansFilled: number;
  gini: number;
  /** Price the post-launch pool opened at, USDC per token. */
  finalPrice: number;
  /** Average price bots paid at launch, USDC per token. */
  botPrice: number | null;
  /** Median human entry price, USDC per token. */
  humanPrice: number | null;
  /** Tokens held by buyers when the launch ends ÷ supply. */
  soldShare: number;
  /** USDC raised at launch. */
  raised: number;
  /** Share of the bots' launch tokens still unsold at the end. */
  botUnsold: number;
};

const USDC = 1e6;

/** Gini coefficient of non-negative values (0 = equal). */
export function gini(values: number[]): number {
  const xs = values.filter((v) => v > 0).sort((a, b) => a - b);
  const n = xs.length;
  if (n < 2) return 0;
  const sum = xs.reduce((a, b) => a + b, 0);
  if (sum === 0) return 0;
  let weighted = 0;
  xs.forEach((x, i) => (weighted += (i + 1) * x));
  return (2 * weighted) / (n * sum) - (n + 1) / n;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const xs = [...values].sort((a, b) => a - b);
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

export function computeMetrics(
  crowd: Agent[],
  launch: LaunchOutcome,
  market: MarketOutcome,
  cfg: ArenaConfig,
): LaunchMetrics {
  const one = oneToken(cfg);
  const toTokens = (v: bigint) => Number(v / 10n ** BigInt(Math.max(0, cfg.decimals - 6))) / 1e6;

  let botTokens = 0n;
  let botPaid = 0n;
  let botProfit = 0n;
  let botLeft = 0n;
  const humanPrices: number[] = [];
  let filled = 0;
  let humans = 0;
  const holdings: number[] = [];

  for (const a of crowd) {
    const t0 = launch.tokens[a.index];
    const s0 = launch.spent[a.index];
    if (a.kind === "bot") {
      botTokens += t0;
      botPaid += s0;
      // Realized profit: everything received for tokens sold (on the curve during
      // the launch, and in the pool after it) minus the average cost of those tokens.
      const sold = launch.soldBack[a.index] + market.sold[a.index];
      const got = launch.proceeds[a.index] + market.proceeds[a.index];
      if (sold > 0n && t0 > 0n) botProfit += got - (s0 * sold) / t0;
      const left = t0 - sold;
      botLeft += left;
      holdings.push(toTokens(left));
    } else {
      humans += 1;
      const tokens = t0 + market.bought[a.index];
      const paid = s0 + market.paid[a.index];
      holdings.push(toTokens(tokens));
      if (tokens > 0n) {
        filled += 1;
        humanPrices.push(Number((paid * one) / tokens) / USDC);
      }
    }
  }

  const botPrice = botTokens > 0n ? Number((botPaid * one) / botTokens) / USDC : null;
  const humanPrice = median(humanPrices);

  return {
    botShare: launch.sold > 0n ? Number((botTokens * 1_000_000n) / launch.sold) / 1e6 : 0,
    botProfit: Number(botProfit) / USDC,
    premium: humanPrice !== null && botPrice ? humanPrice / botPrice : null,
    humansFilled: humans > 0 ? filled / humans : 0,
    gini: gini(holdings),
    finalPrice: Number(launch.finalPrice) / USDC,
    botPrice,
    humanPrice,
    soldShare: Number((launch.netSold * 1_000_000n) / cfg.supply) / 1e6,
    raised: Number(launch.raised) / USDC,
    botUnsold: botTokens > 0n ? Number((botLeft * 1_000_000n) / botTokens) / 1e6 : 0,
  };
}
