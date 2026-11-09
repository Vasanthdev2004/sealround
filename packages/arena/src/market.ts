/**
 * Post-launch market. Identical rules for every launch type, so the
 * comparison is fair:
 *
 *   1. A constant-product pool opens at the launch's final price, with a fixed
 *      USDC depth (poolDepthShare x supply value) paired with tokens at that price.
 *   2. Humans with budget left and a valuation above the pool price buy in
 *      arrival order, each until their budget runs out or the price reaches
 *      their valuation.
 *   3. Bots sell into that demand: right after each human buy, bots (in order)
 *      sell until the price is back where it was before that buy. A bot never
 *      sells below what it paid per token. Unsold tokens stay with the bot.
 */

import { ConstantProductPool } from "./amm";
import { oneToken, scale, supplyValue, type ArenaConfig } from "./config";
import type { Agent } from "./crowd";
import type { LaunchOutcome } from "./launches";

export type MarketTrade = {
  agent: number;
  side: "buy" | "sell";
  tokens: bigint;
  usdc: bigint;
  priceAfter: bigint;
};

export type MarketOutcome = {
  openPrice: bigint;
  closePrice: bigint;
  trades: MarketTrade[];
  /** Per agent: tokens bought in the pool / USDC paid (humans). */
  bought: bigint[];
  paid: bigint[];
  /** Per agent: tokens sold into the pool / USDC received (bots). */
  sold: bigint[];
  proceeds: bigint[];
};

export function runMarket(crowd: Agent[], launch: LaunchOutcome, cfg: ArenaConfig): MarketOutcome {
  const one = oneToken(cfg);
  const depth = scale(supplyValue(cfg), cfg.poolDepthShare);
  const openPrice = launch.finalPrice;
  const pool = new ConstantProductPool(depth, (depth * one) / openPrice, one);

  const zeros = () => crowd.map(() => 0n);
  const out: MarketOutcome = {
    openPrice,
    closePrice: openPrice,
    trades: [],
    bought: zeros(),
    paid: zeros(),
    sold: zeros(),
    proceeds: zeros(),
  };

  const bots = crowd.filter((a) => a.kind === "bot");
  const holding = crowd.map((a) => launch.tokens[a.index] - launch.soldBack[a.index]);
  // A bot's average cost per whole token. A bot with no tokens never sells.
  const cost = crowd.map((a) =>
    launch.tokens[a.index] > 0n ? (launch.spent[a.index] * one) / launch.tokens[a.index] : 0n,
  );

  for (const h of crowd) {
    if (h.kind !== "human") continue;
    const left = h.budget - launch.spent[h.index];
    if (left < cfg.minTrade) continue;
    const before = pool.price();
    if (h.valuation <= before) continue;

    let spend = pool.spendToPrice(h.valuation);
    if (spend > left) spend = left;
    if (spend < cfg.minTrade) continue;
    const t = pool.buy(spend);
    if (t <= 0n) continue;
    out.bought[h.index] += t;
    out.paid[h.index] += spend;
    out.trades.push({ agent: h.index, side: "buy", tokens: t, usdc: spend, priceAfter: pool.price() });

    // Bots sell into this buy, back down to the pre-buy price, never below cost.
    for (const b of bots) {
      if (holding[b.index] <= 0n) continue;
      const target = cost[b.index] > before ? cost[b.index] : before;
      let n = pool.tokensToPrice(target);
      if (n > holding[b.index]) n = holding[b.index];
      if (n <= 0n) continue;
      const usdc = pool.sell(n);
      if (usdc <= 0n) continue;
      holding[b.index] -= n;
      out.sold[b.index] += n;
      out.proceeds[b.index] += usdc;
      out.trades.push({ agent: b.index, side: "sell", tokens: n, usdc, priceAfter: pool.price() });
    }
  }

  out.closePrice = pool.price();
  return out;
}
