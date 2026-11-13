/**
 * Simulate one creator's sale before it exists: the Arena's crowd (humans with
 * private valuations and budgets, plus sniper bots at second 0) bidding into a
 * Sealround sale with the creator's own rules, across a range of demand.
 *
 * What the creator's rules change, compared with the Arena's Sealround run:
 *   - sale supply and floor price replace the Arena's supply and launch price;
 *   - a deposit must be between the minimum and the per-account cap, so each
 *     bidder deposits min(budget, cap) and a budget below the minimum cannot bid;
 *   - the sale takes at most `maxBids` bids, first come first served (bots act
 *     at second 0, so they always get a slot);
 *   - the max price ceiling and the min raise go to clear() as the contract
 *     sends them; below the min raise the sale fails and everyone is refunded;
 *   - with a launch pool, the post-launch market is that pool, seeded at the
 *     clearing price with poolPlan(); without one it is the Arena's pool.
 *
 * Everything else is the Arena's model and assumptions (assumptions.ts).
 * Deterministic: the same rules, demand levels and seeds give the same result.
 */

import { clear, poolPlan, poolPrice, type Bid, type ClearingResult, type PoolPlan } from "@fairground/clearing";
import { DEFAULT_CONFIG, DEFAULT_SEED, scale, supplyValue, type ArenaConfig } from "./config";
import { makeCrowd, type Agent } from "./crowd";
import type { LaunchOutcome } from "./launches";
import { runMarket, type MarketOutcome } from "./market";
import { computeMetrics } from "./metrics";
import { runSeed } from "./run";

/** The creator's sale rules, in the units of @fairground/clearing. */
export type CreatorRules = {
  /** Tokens for sale, token base units. */
  supply: bigint;
  /** Token decimals. */
  decimals: number;
  /** Floor price, USDC base units per whole token. */
  floor: bigint;
  /** Max price ceiling, USDC base units per whole token; null = none. */
  ceiling: bigint | null;
  /** Min raise, USDC base units. Below it the sale fails. */
  minRaise: bigint;
  /** Smallest deposit the sale takes, USDC base units. */
  minDeposit: bigint;
  /** Largest deposit per account, USDC base units. */
  maxDeposit: bigint;
  /** Bid slots: the sale takes at most this many bids. */
  maxBids: number;
  /** Launch pool: share of the raise (basis points) and the tokens reserved for it. */
  pool: { shareBps: number; reserve: bigint } | null;
};

export type CreatorRun = {
  seed: number;
  demand: number;
  status: ClearingResult["status"];
  failReason?: ClearingResult["failReason"];
  /** USDC base units per whole token. Only meaningful when settled. */
  clearingPrice: bigint;
  /** Sale tokens bought. Zero when the sale fails. */
  sold: bigint;
  /** Sale supply burned at payout: supply - sold (the whole supply when the sale fails). */
  burned: bigint;
  /** Pool reserve burned at payout: what the pool does not take (all of it when the sale fails). */
  reserveBurned: bigint;
  /** USDC raised. Zero when the sale fails. */
  raised: bigint;
  /** Humans and bots who would bid at the floor or above. */
  wanted: number;
  /** Bids the sale took. */
  bids: number;
  /** Wanted to bid but the bid slots were full. */
  slotsFull: number;
  /** Wanted to bid but their budget is below the minimum deposit. */
  belowMin: number;
  /** Bids whose budget was above the per-account cap, so they deposited the cap. */
  capped: number;
  /** Bids that got tokens. */
  filled: number;
  /** Tokens bots got. */
  botTokens: bigint;
  /** What bots made selling into the post-launch market, USDC (the Arena's metric). */
  botProfit: number;
  /** The launch pool, when the sale has one and it settled with a pool the contract would seed. */
  pool: PoolPlan | null;
  /** The launch pool's starting price, USDC base units per whole token. */
  poolPrice: bigint | null;
};

/** Crowd settings for a creator's sale: the Arena's, sized to the creator's supply and floor. */
export function creatorConfig(rules: CreatorRules, humans = DEFAULT_CONFIG.humans): ArenaConfig {
  return { ...DEFAULT_CONFIG, humans, supply: rules.supply, launchPrice: rules.floor, decimals: rules.decimals };
}

const minB = (a: bigint, b: bigint) => (a < b ? a : b);

/** One crowd through the creator's sale, then through the post-launch market. */
export function runCreatorSale(crowd: Agent[], rules: CreatorRules, cfg: ArenaConfig, seed = 0, demand = 0): CreatorRun {
  const one = 10n ** BigInt(rules.decimals);

  // Bids in action order (bots at second 0, then humans by arrival). Humans
  // below the floor do not bid; everyone else bids max price = valuation and
  // max spend = deposit = their budget up to the cap.
  const bidders: Agent[] = [];
  const bids: Bid[] = [];
  let wanted = 0;
  let slotsFull = 0;
  let belowMin = 0;
  let capped = 0;
  for (const a of crowd) {
    if (a.kind === "human" && a.valuation < rules.floor) continue;
    wanted += 1;
    const deposit = minB(a.budget, rules.maxDeposit);
    if (deposit < rules.minDeposit) {
      belowMin += 1;
      continue;
    }
    if (bids.length >= rules.maxBids) {
      slotsFull += 1;
      continue;
    }
    if (a.budget > rules.maxDeposit) capped += 1;
    bidders.push(a);
    bids.push({ bidder: a.id, deposit, maxPrice: a.valuation, maxSpend: deposit });
  }

  const result = clear(
    {
      saleSupply: rules.supply,
      floorPrice: rules.floor,
      minRaise: rules.minRaise,
      decimals: rules.decimals,
      maxPrice: rules.ceiling,
    },
    bids,
  );

  // The launch as the Arena's metrics read it.
  const zeros = () => crowd.map(() => 0n);
  const launch: LaunchOutcome = {
    type: "fairground",
    startPrice: rules.floor,
    finalPrice: result.clearingPrice,
    purchases: [],
    path: [],
    tokens: zeros(),
    spent: zeros(),
    soldBack: zeros(),
    proceeds: zeros(),
    sold: result.totalSold,
    netSold: result.totalSold,
    raised: result.totalRaised,
    soldOutAt: result.status === "settled" && result.unsold === 0n ? cfg.windowSeconds : null,
    clearing: result,
  };
  let filled = 0;
  let botTokens = 0n;
  result.fills.forEach((f, k) => {
    if (f.tokens <= 0n) return;
    const a = bidders[k];
    launch.tokens[a.index] = f.tokens;
    launch.spent[a.index] = f.spent;
    launch.purchases.push({
      agent: a.index,
      t: cfg.windowSeconds,
      tokens: f.tokens,
      usdc: f.spent,
      priceAfter: result.clearingPrice,
    });
    filled += 1;
    if (a.kind === "bot") botTokens += f.tokens;
  });

  const settled = result.status === "settled";
  const reserve = rules.pool?.reserve ?? 0n;
  let pool: PoolPlan | null = null;
  if (settled && rules.pool) {
    const plan = poolPlan(result.totalRaised, result.clearingPrice, rules.decimals, rules.pool.shareBps, reserve);
    if (plan.tokens > 0n) pool = plan;
  }

  // Post-launch market: the creator's pool, or the Arena's when the sale has none.
  // A failed sale, or a pool the contract would skip, leaves nothing to trade.
  let market: MarketOutcome | null = null;
  if (settled && result.clearingPrice > 0n) {
    if (rules.pool) {
      if (pool) market = runMarket(crowd, launch, cfg, pool);
    } else {
      const depth = scale(supplyValue(cfg), cfg.poolDepthShare);
      if (depth > 0n && (depth * one) / result.clearingPrice > 0n) market = runMarket(crowd, launch, cfg);
    }
  }
  const botProfit = market ? computeMetrics(crowd, launch, market, cfg).botProfit : 0;

  return {
    seed,
    demand,
    status: result.status,
    ...(result.failReason ? { failReason: result.failReason } : {}),
    clearingPrice: result.clearingPrice,
    sold: result.totalSold,
    burned: rules.supply - result.totalSold,
    reserveBurned: reserve - (pool?.tokens ?? 0n),
    raised: result.totalRaised,
    wanted,
    bids: bids.length,
    slotsFull,
    belowMin,
    capped,
    filled: settled ? filled : 0,
    botTokens: settled ? botTokens : 0n,
    // `|| 0` turns -0 into 0.
    botProfit: Math.round(botProfit * 100) / 100 || 0,
    pool,
    poolPrice: pool ? poolPrice(pool.usdc, pool.tokens, rules.decimals) : null,
  };
}

// ---------- the sweep ----------

/** Demand levels the sweep runs: 0.5x to 4x in steps of 0.25x. */
export const CREATOR_DEMANDS: number[] = Array.from({ length: 15 }, (_, i) => 0.5 + i * 0.25);

/** The levels worth a column in a table. */
export const CREATOR_TABLE_DEMANDS = [0.5, 1, 2, 4];

/** Crowds per demand level. */
export const CREATOR_SEEDS = 5;

/**
 * Seeds for the sweep: the same crowds at every demand level, so a change
 * between levels comes from demand, not from a different draw.
 */
export const creatorSeeds = (n = CREATOR_SEEDS, base = DEFAULT_SEED) =>
  Array.from({ length: n }, (_, i) => runSeed(base, i));

export type CreatorLevel = {
  demand: number;
  runs: CreatorRun[];
  /** Runs that met the min raise and settled. */
  settled: number;
  /** Mean clearing price over the runs that settled; null when none did. */
  clearingPrice: bigint | null;
  /** Mean over all runs (a failed run sells nothing). */
  sold: bigint;
  /** supply - sold: the mean sale supply burned. */
  burned: bigint;
  /** Mean pool reserve burned. */
  reserveBurned: bigint;
  /** Mean over all runs (a failed run raises nothing). */
  raised: bigint;
  /** Mean share of the bids that got tokens. */
  filledShare: number;
  /** Mean bids taken. */
  bids: number;
  /** Mean people who would bid at the floor or above. */
  wanted: number;
  /** Mean bidders turned away: slots full or below the minimum deposit. */
  turnedAway: number;
  /** Of those, mean turned away because the bid slots were full. */
  slotsFull: number;
  /** Of those, mean turned away because their budget is below the minimum deposit. */
  belowMin: number;
  /** Mean bids held to the per-account cap. */
  capped: number;
  /** Mean bot profit, USDC. */
  botProfit: number;
  /** Mean launch pool starting price over runs with a pool; null when none. */
  poolPrice: bigint | null;
};

const meanB = (vs: bigint[]) => (vs.length ? vs.reduce((a, b) => a + b, 0n) / BigInt(vs.length) : 0n);
const meanN = (vs: number[]) => (vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : 0);

/** Summarize the runs of one demand level. */
export function summarizeLevel(rules: CreatorRules, demand: number, runs: CreatorRun[]): CreatorLevel {
  const settled = runs.filter((r) => r.status === "settled");
  const pooled = settled.filter((r) => r.poolPrice !== null).map((r) => r.poolPrice!);
  const sold = meanB(runs.map((r) => r.sold));
  return {
    demand,
    runs,
    settled: settled.length,
    clearingPrice: settled.length ? meanB(settled.map((r) => r.clearingPrice)) : null,
    sold,
    burned: rules.supply - sold,
    reserveBurned: meanB(runs.map((r) => r.reserveBurned)),
    raised: meanB(runs.map((r) => r.raised)),
    filledShare: meanN(runs.map((r) => (r.bids > 0 ? r.filled / r.bids : 0))),
    bids: meanN(runs.map((r) => r.bids)),
    wanted: meanN(runs.map((r) => r.wanted)),
    turnedAway: meanN(runs.map((r) => r.slotsFull + r.belowMin)),
    slotsFull: meanN(runs.map((r) => r.slotsFull)),
    belowMin: meanN(runs.map((r) => r.belowMin)),
    capped: meanN(runs.map((r) => r.capped)),
    botProfit: Math.round(meanN(runs.map((r) => r.botProfit)) * 100) / 100 || 0,
    poolPrice: pooled.length ? meanB(pooled) : null,
  };
}

export type CreatorOptions = {
  /** Crowds per level (default 5). */
  seeds?: number[];
  /** Humans per crowd (default the Arena's 200). */
  humans?: number;
};

/** One demand level: the same crowds as every other level, scaled to this demand. */
export function simulateCreatorLevel(rules: CreatorRules, demand: number, opts: CreatorOptions = {}): CreatorLevel {
  const cfg = creatorConfig(rules, opts.humans);
  const seeds = opts.seeds ?? creatorSeeds();
  const runs = seeds.map((s) => runCreatorSale(makeCrowd(s, demand, cfg), rules, cfg, s, demand));
  return summarizeLevel(rules, demand, runs);
}

/** The whole sweep, every level in `demands` (default 0.5x to 4x). */
export function sweepCreator(
  rules: CreatorRules,
  opts: CreatorOptions & { demands?: number[] } = {},
): CreatorLevel[] {
  return (opts.demands ?? CREATOR_DEMANDS).map((d) => simulateCreatorLevel(rules, d, opts));
}
