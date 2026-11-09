/**
 * The crowd: humans with private valuations, budgets and arrival times, plus
 * sniper bots that act at second 0. Deterministic for a given seed.
 */

import { mulberry32 } from "@fairground/clearing";
import { scale, supplyValue, type ArenaConfig } from "./config";

export type Agent = {
  /** Position in the crowd (also the bid order). Bots come first. */
  index: number;
  id: string;
  kind: "human" | "bot";
  /** Seconds after launch. Bots act at 0. */
  arrival: number;
  /**
   * Humans: the most they would pay per whole token (private, never shown).
   * Bots: the max price they bid in Fairground.
   * USDC base units per whole token.
   */
  valuation: bigint;
  /** USDC base units. */
  budget: bigint;
};

/** Standard normal from two uniforms (Box-Muller). */
function normal(rnd: () => number): number {
  const u1 = 1 - rnd(); // (0, 1]
  const u2 = rnd();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Build the crowd for one run. `demand` = total human budget divided by the
 * supply value at the launch price (1 = humans bring exactly enough USDC to
 * buy the whole supply at the launch price).
 *
 * Returned in action order: bots first (second 0), then humans by arrival.
 */
export function makeCrowd(seed: number, demand: number, cfg: ArenaConfig): Agent[] {
  const rnd = mulberry32(seed);
  const value = supplyValue(cfg);

  // Humans first, so changing bot settings never changes the human crowd.
  const raw = Array.from({ length: cfg.humans }, (_, i) => {
    const m = Math.min(
      cfg.valuationMax,
      Math.max(cfg.valuationMin, cfg.valuationMedian * Math.exp(cfg.valuationSigma * normal(rnd))),
    );
    const weight = Math.exp(cfg.budgetSigma * normal(rnd));
    const u = rnd();
    const arrival = Math.max(1, Math.round(1 + (cfg.windowSeconds - 1) * Math.pow(u, cfg.arrivalSkew)));
    return { i, m, weight, arrival };
  });
  const totalWeight = raw.reduce((a, h) => a + h.weight, 0);
  const humanTotal = scale(value, demand);

  const humans = raw
    .map((h) => {
      let budget = scale(humanTotal, h.weight / totalWeight);
      if (budget < cfg.minBudget) budget = cfg.minBudget;
      return {
        id: `human-${String(h.i + 1).padStart(3, "0")}`,
        kind: "human" as const,
        arrival: h.arrival,
        valuation: scale(cfg.launchPrice, h.m),
        budget,
      };
    })
    // Stable: equal arrival times keep their draw order.
    .sort((a, b) => a.arrival - b.arrival);

  const bots = Array.from({ length: cfg.bots }, (_, i) => ({
    id: `bot-${i + 1}`,
    kind: "bot" as const,
    arrival: 0,
    valuation: cfg.launchPrice * cfg.botMaxPriceMultiple,
    budget: scale(value, cfg.botBudgetMin + (cfg.botBudgetMax - cfg.botBudgetMin) * rnd()),
  }));

  return [...bots, ...humans].map((a, index) => ({ ...a, index }));
}
