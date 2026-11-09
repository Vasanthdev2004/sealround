/**
 * The three launch types, run on the same crowd.
 *
 *   bonding curve: constant product with virtual reserves; buyers act in
 *                  arrival order and push the price up as they buy.
 *   fixed price:   first come, first served at the launch price until supply
 *                  runs out.
 *   Fairground:    sealed bids, one uniform clearing price via clear() from
 *                  @fairground/clearing (the same code the enclave runs).
 */

import { clear, costOf, tokensFor, type Bid, type ClearingResult } from "@fairground/clearing";
import { ConstantProductPool } from "./amm";
import { oneToken, supplyValue, type ArenaConfig, type LaunchType } from "./config";
import type { Agent } from "./crowd";

export type Purchase = {
  agent: number;
  /** Seconds after launch. Fairground fills settle when the window closes. */
  t: number;
  tokens: bigint;
  usdc: bigint;
  /** Spot price right after this purchase, USDC base units per whole token. */
  priceAfter: bigint;
};

/** Price after one arrival has acted (and, on the curve, after bots answered it). */
export type PathPoint = {
  agent: number;
  t: number;
  price: bigint;
  /** Tokens this arrival bought. */
  bought: bigint;
  /** USDC this arrival paid. */
  paid: bigint;
  /** Tokens bots sold back into the curve right after this buy. */
  botsSold: bigint;
};

export type LaunchOutcome = {
  type: LaunchType;
  /** Price before anyone buys. */
  startPrice: bigint;
  /** Price the post-launch pool opens at. */
  finalPrice: bigint;
  purchases: Purchase[];
  /** Price path, one point per arrival that traded. */
  path: PathPoint[];
  /** Tokens bought at launch, per agent (crowd order). */
  tokens: bigint[];
  /** USDC paid at launch, per agent. */
  spent: bigint[];
  /** Tokens sold back during the launch, per agent (bots on the curve only). */
  soldBack: bigint[];
  /** USDC received for tokens sold back during the launch, per agent. */
  proceeds: bigint[];
  /** Tokens bought at launch, gross (every buy, including tokens bots later sold back). */
  sold: bigint;
  /** Tokens held by buyers when the launch ends (gross buys minus sell-backs). */
  netSold: bigint;
  /** USDC raised at launch (net of what bots took back out of the curve). */
  raised: bigint;
  /** Second the supply ran out, or null if it never did. */
  soldOutAt: number | null;
  /** Fairground only: the full clearing result. */
  clearing?: ClearingResult;
};

function emptyOutcome(type: LaunchType, crowd: Agent[], price: bigint): LaunchOutcome {
  return {
    type,
    startPrice: price,
    finalPrice: price,
    purchases: [],
    path: [],
    tokens: crowd.map(() => 0n),
    spent: crowd.map(() => 0n),
    soldBack: crowd.map(() => 0n),
    proceeds: crowd.map(() => 0n),
    sold: 0n,
    netSold: 0n,
    raised: 0n,
    soldOutAt: null,
  };
}

function record(o: LaunchOutcome, p: Purchase) {
  o.purchases.push(p);
  o.tokens[p.agent] += p.tokens;
  o.spent[p.agent] += p.usdc;
  o.sold += p.tokens;
  o.netSold += p.tokens;
  o.raised += p.usdc;
}

/** Path for launches where nobody sells back: one point per purchase. */
function pathFromPurchases(o: LaunchOutcome) {
  o.path = o.purchases.map((p) => ({
    agent: p.agent,
    t: p.t,
    price: p.priceAfter,
    bought: p.tokens,
    paid: p.usdc,
    botsSold: 0n,
  }));
}

/** Virtual reserves for the bonding curve, sized so a full buyout raises supply x launch price. */
export function curveReserves(cfg: ArenaConfig): { x0: bigint; y0: bigint } {
  const y0 = (cfg.supply * cfg.curveVirtualNum) / cfg.curveVirtualDen;
  // Buying S tokens from (x0, y0) costs x0 * S / (y0 - S). Set that equal to V.
  const x0 = (supplyValue(cfg) * (y0 - cfg.supply)) / cfg.supply;
  return { x0, y0 };
}

export function makeCurve(cfg: ArenaConfig): ConstantProductPool {
  const { x0, y0 } = curveReserves(cfg);
  return new ConstantProductPool(x0, y0, oneToken(cfg));
}

/** Curve price before the first buy and after the whole supply is bought. */
export function curveEndpoints(cfg: ArenaConfig): { start: bigint; end: bigint } {
  const curve = makeCurve(cfg);
  const start = curve.price();
  curve.applyBuy(curve.costToBuy(cfg.supply), cfg.supply);
  return { start, end: curve.price() };
}

export function runBondingCurve(crowd: Agent[], cfg: ArenaConfig): LaunchOutcome {
  const one = oneToken(cfg);
  const curve = makeCurve(cfg);
  const o = emptyOutcome("bonding_curve", crowd, curve.price());
  const bots = crowd.filter((a) => a.kind === "bot");
  let remaining = cfg.supply;

  for (const a of crowd) {
    // The curve has sold out (graduated): the launch is over.
    if (remaining === 0n) break;
    const before = curve.price();

    // Bots spend their whole budget. Humans stop when the price reaches their valuation.
    let spend = a.budget;
    if (a.kind === "human") {
      const toValuation = curve.spendToPrice(a.valuation);
      if (toValuation < spend) spend = toValuation;
    }
    if (spend < cfg.minTrade) continue;

    let tokens = curve.quoteBuy(spend);
    if (tokens >= remaining) {
      tokens = remaining;
      spend = curve.costToBuy(tokens);
    }
    if (tokens <= 0n) continue;

    curve.applyBuy(spend, tokens);
    remaining -= tokens;
    record(o, { agent: a.index, t: a.arrival, tokens, usdc: spend, priceAfter: curve.price() });

    // The curve is a two-way market from second 0, so bots sell into each human
    // buy with the same rule as the post-launch pool: back down to the pre-buy
    // price, never below what they paid per token.
    let botsSold = 0n;
    if (a.kind === "human") {
      for (const b of bots) {
        const held = o.tokens[b.index] - o.soldBack[b.index];
        if (held <= 0n) continue;
        const cost = (o.spent[b.index] * one) / o.tokens[b.index];
        let n = curve.tokensToPrice(cost > before ? cost : before);
        if (n > held) n = held;
        if (n <= 0n) continue;
        const usdc = curve.sell(n);
        if (usdc <= 0n) continue;
        o.soldBack[b.index] += n;
        o.proceeds[b.index] += usdc;
        o.netSold -= n;
        o.raised -= usdc;
        remaining += n;
        botsSold += n;
      }
    }

    o.path.push({ agent: a.index, t: a.arrival, price: curve.price(), bought: tokens, paid: spend, botsSold });
    if (remaining === 0n) o.soldOutAt = a.arrival;
  }

  o.finalPrice = curve.price();
  return o;
}

export function runFixedPrice(crowd: Agent[], cfg: ArenaConfig): LaunchOutcome {
  const one = oneToken(cfg);
  const price = cfg.launchPrice;
  const o = emptyOutcome("fixed_price", crowd, price);
  let remaining = cfg.supply;

  for (const a of crowd) {
    if (remaining === 0n) break;
    if (a.kind === "human" && a.valuation < price) continue;
    let tokens = tokensFor(a.budget, price, one);
    if (tokens > remaining) tokens = remaining;
    if (tokens <= 0n) continue;
    const usdc = costOf(tokens, price, one);
    if (usdc < cfg.minTrade) continue;
    remaining -= tokens;
    record(o, { agent: a.index, t: a.arrival, tokens, usdc, priceAfter: price });
    if (remaining === 0n) o.soldOutAt = a.arrival;
  }

  pathFromPurchases(o);
  return o;
}

export function runFairground(crowd: Agent[], cfg: ArenaConfig): LaunchOutcome {
  const floor = cfg.launchPrice;
  const o = emptyOutcome("fairground", crowd, floor);

  // Humans whose valuation is below the floor do not bid. Everyone else bids
  // max price = valuation, max spend = deposit = whole budget. Bots bid a very
  // high max price. Bid order = arrival order (bots first).
  const bidders = crowd.filter((a) => a.kind === "bot" || a.valuation >= floor);
  const bids: Bid[] = bidders.map((a) => ({
    bidder: a.id,
    deposit: a.budget,
    maxPrice: a.valuation,
    maxSpend: a.budget,
  }));

  const result = clear({ saleSupply: cfg.supply, floorPrice: floor, minRaise: 0n, decimals: cfg.decimals }, bids);
  o.clearing = result;
  o.finalPrice = result.clearingPrice;
  if (result.status !== "settled") return o;

  result.fills.forEach((f, k) => {
    if (f.tokens <= 0n) return;
    record(o, {
      agent: bidders[k].index,
      t: cfg.windowSeconds,
      tokens: f.tokens,
      usdc: f.spent,
      priceAfter: result.clearingPrice,
    });
  });
  if (result.unsold === 0n) o.soldOutAt = cfg.windowSeconds;
  pathFromPurchases(o);
  return o;
}

export function runLaunch(type: LaunchType, crowd: Agent[], cfg: ArenaConfig): LaunchOutcome {
  if (type === "bonding_curve") return runBondingCurve(crowd, cfg);
  if (type === "fixed_price") return runFixedPrice(crowd, cfg);
  return runFairground(crowd, cfg);
}
