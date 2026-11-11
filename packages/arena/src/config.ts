/**
 * Arena configuration. Every number the simulator uses lives here, and the
 * assumptions list (assumptions.ts) is generated from these same values, so
 * the text next to the charts can never drift from the code.
 *
 * Units (all integers, bigint), same as @fairground/clearing:
 *   - USDC amounts: base units (6 decimals). 1 USDC = 1_000_000n.
 *   - Prices: USDC base units per WHOLE token. 0.01 USDC/token = 10_000n.
 *   - Token amounts: token base units (18 decimals).
 */

import { tokens, usdc } from "@fairground/clearing";

export type LaunchType = "bonding_curve" | "fixed_price" | "fairground";

export const LAUNCH_TYPES: LaunchType[] = ["bonding_curve", "fixed_price", "fairground"];

export const LAUNCH_LABEL: Record<LaunchType, string> = {
  bonding_curve: "Bonding curve",
  fixed_price: "Fixed price, first come",
  fairground: "Sealround",
};

export type ArenaConfig = {
  /** Humans per run. */
  humans: number;
  /** Sniper bots per run. */
  bots: number;
  /** Token decimals. */
  decimals: number;
  /** Tokens for sale, token base units. */
  supply: bigint;
  /**
   * Reference launch price, USDC base units per whole token. The fixed-price
   * sale sells at this price, Fairground uses it as the floor, and the bonding
   * curve is sized so buying it out raises supply x this price.
   */
  launchPrice: bigint;
  /** Launch window in seconds. Humans arrive in (0, window]. */
  windowSeconds: number;
  /** Arrival skew: t = 1 + (window - 1) * u^skew. Above 1 = more early arrivals. */
  arrivalSkew: number;
  /** Human valuation multiple of the launch price: lognormal median. */
  valuationMedian: number;
  /** Human valuation multiple: lognormal sigma. */
  valuationSigma: number;
  /** Valuation multiple clamp. */
  valuationMin: number;
  valuationMax: number;
  /** Human budget weights: lognormal sigma (heavier tail = more whales). */
  budgetSigma: number;
  /** Smallest human budget, USDC base units. */
  minBudget: bigint;
  /** Each bot's budget is uniform in [min, max] x supply value at the launch price. */
  botBudgetMin: number;
  botBudgetMax: number;
  /** Bots' max price in Fairground, as a multiple of the launch price. */
  botMaxPriceMultiple: bigint;
  /**
   * Bonding curve virtual token reserve as a fraction of the curve supply,
   * numerator / denominator. pump.fun: 1,073,000,000 virtual vs 793,100,000
   * sellable on the curve.
   */
  curveVirtualNum: bigint;
  curveVirtualDen: bigint;
  /** Post-launch pool liquidity: share of the supply value at the launch price, in USDC. */
  poolDepthShare: number;
  /** Trades below this many USDC base units are skipped (dust). */
  minTrade: bigint;
};

export const DEFAULT_CONFIG: ArenaConfig = {
  humans: 200,
  bots: 5,
  decimals: 18,
  supply: tokens(1_000_000),
  launchPrice: usdc("0.01"),
  windowSeconds: 1800,
  arrivalSkew: 1.5,
  valuationMedian: 1.6,
  valuationSigma: 0.55,
  valuationMin: 0.3,
  valuationMax: 12,
  budgetSigma: 0.9,
  minBudget: usdc(1),
  botBudgetMin: 0.02,
  botBudgetMax: 0.06,
  botMaxPriceMultiple: 100n,
  curveVirtualNum: 1_073_000n,
  curveVirtualDen: 793_100n,
  poolDepthShare: 0.2,
  minTrade: usdc("0.01"),
};

export const DEFAULT_SEED = 20261114;
export const DEFAULT_RUNS = 60;
export const DEFAULT_DEMAND_MIN = 0.5;
export const DEFAULT_DEMAND_MAX = 4;

/** 10^decimals: token base units per whole token. */
export const oneToken = (cfg: ArenaConfig) => 10n ** BigInt(cfg.decimals);

/** USDC raised by selling the whole supply at the launch price. */
export const supplyValue = (cfg: ArenaConfig) => (cfg.supply * cfg.launchPrice) / oneToken(cfg);

/** Scale a bigint by a float share, flooring. For sizing only, never for charges. */
export const scale = (v: bigint, share: number) =>
  (v * BigInt(Math.round(share * 1_000_000))) / 1_000_000n;
