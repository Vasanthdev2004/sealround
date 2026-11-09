/**
 * Every modelling assumption, written in plain words and generated from the
 * live config so the published list always matches the code that ran.
 */

import { formatUnits } from "@fairground/clearing";
import { scale, supplyValue, type ArenaConfig } from "./config";
import { curveEndpoints } from "./launches";

const usd = (v: bigint) => formatUnits(v, 6, 2);
const price = (v: bigint) => formatUnits(v, 6, 6);
const x = (n: number, dp = 2) => `${Number(n.toFixed(dp))}x`;
const pct = (n: number) => `${Number((n * 100).toFixed(1))}%`;

export function assumptions(
  cfg: ArenaConfig,
  run: { seed: number; runs: number; demandMin: number; demandMax: number },
): string[] {
  const value = supplyValue(cfg);
  const supply = formatUnits(cfg.supply, cfg.decimals, 0);
  const { start, end } = curveEndpoints(cfg);
  const ratio = (a: bigint) => Number((a * 10_000n) / cfg.launchPrice) / 10_000;
  const virtual = Number((cfg.curveVirtualNum * 10_000n) / cfg.curveVirtualDen) / 10_000;
  const depth = scale(value, cfg.poolDepthShare);

  return [
    `Supply for sale: ${supply} tokens. Reference launch price: ${price(cfg.launchPrice)} USDC per token, so selling the whole supply at that price raises ${usd(value)} USDC.`,
    `Demand level = total human budget ÷ (supply × launch price). ${run.runs} runs, evenly spaced from ${x(run.demandMin, 1)} to ${x(run.demandMax, 1)}. Each run draws a fresh crowd from its own seed, derived from base seed ${run.seed}.`,
    `${cfg.humans} humans per run. Each has a private valuation, the most they would pay per token: lognormal, median ${x(cfg.valuationMedian)} the launch price, sigma ${cfg.valuationSigma}, clamped to ${x(cfg.valuationMin)}–${x(cfg.valuationMax, 0)}. Valuations are never shown.`,
    `Human budgets are lognormal weights (sigma ${cfg.budgetSigma}, so a few whales) scaled to the demand level, at least ${usd(cfg.minBudget)} USDC each. Humans arrive between second 1 and second ${cfg.windowSeconds.toLocaleString("en-US")}, more of them early.`,
    `${cfg.bots} sniper bots per run, each with a budget of ${pct(cfg.botBudgetMin)}–${pct(cfg.botBudgetMax)} of the supply value (${usd(scale(value, cfg.botBudgetMin))}–${usd(scale(value, cfg.botBudgetMax))} USDC). Bots act at second 0, before any human. On the bonding curve and in the fixed-price sale they buy with their whole budget. In Fairground they bid their whole budget with a max price of ${cfg.botMaxPriceMultiple}x the launch price.`,
    `Bonding curve: constant product x·y = k with virtual reserves in pump.fun proportions (virtual token reserve = ${virtual} × the curve supply). The virtual USDC reserve is set so buying the whole curve raises ${usd(value)} USDC, the same as the fixed-price sale. The price runs from ${price(start)} to ${price(end)} USDC (${x(ratio(start))} to ${x(ratio(end))} the launch price).`,
    `On the curve, buyers act in arrival order. A human buys until their budget runs out or the price reaches their valuation. The curve is a two-way market from second 0, so after each human buy, bots sell back into it with the same rule as the post-launch pool (below). The launch ends when the curve sells out or the last human has arrived.`,
    `Fixed-price sale: ${price(cfg.launchPrice)} USDC per token, first come first served until supply runs out. A human buys only if their valuation is at least the price.`,
    `Fairground: every human whose valuation is at or above the floor (the launch price) bids max price = valuation and max spend = deposit = whole budget. Humans below the floor do not bid. Clearing uses clear() from @fairground/clearing, the same rule the enclave runs. Unsold tokens are burned.`,
    `Humans are honest and simple: they bid their true valuation in Fairground and stop at it on the curve. Nobody splits across wallets.`,
    `Post-launch market, identical for all three: a constant-product pool opens at the launch's final price (curve: its last price; fixed price: ${price(cfg.launchPrice)}; Fairground: the clearing price) with ${usd(depth)} USDC of liquidity (${pct(cfg.poolDepthShare)} of the supply value) paired with tokens at that price.`,
    `Humans with budget left and a valuation above the pool price buy from the pool in arrival order, each until their budget runs out or the price reaches their valuation.`,
    `Bots sell into that demand: after each human buy, bots sell back until the price returns to where it was before that buy. A bot never sells below what it paid per token. Tokens bots cannot sell stay in their wallets.`,
    `Bot profit counts only tokens actually sold, at the average price the bot paid. Unsold tokens count as zero, not at a market value. Bots follow this one simple selling rule everywhere; bots that time their sales better would likely make more on the curve and in the fixed-price sale, so those profits are conservative.`,
    `No fees, gas, latency or MEV beyond bots acting first. Money is integer throughout (USDC 6 decimals, tokens 18 decimals); floats appear only in the reported metrics.`,
    `Deterministic: the same seed and config give byte-identical output. No LLM calls, no network.`,
  ];
}
