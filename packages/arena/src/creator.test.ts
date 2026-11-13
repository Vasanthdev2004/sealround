import { poolPriceMatches, tokens, usdc } from "@fairground/clearing";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "./config";
import {
  CREATOR_DEMANDS,
  CREATOR_SEEDS,
  CREATOR_TABLE_DEMANDS,
  creatorConfig,
  creatorSeeds,
  runCreatorSale,
  simulateCreatorLevel,
  sweepCreator,
  type CreatorRules,
} from "./creator";
import { makeCrowd } from "./crowd";
import { simulateRun } from "./run";

/** The /create form's defaults: 600,000 tokens at a 0.001 floor, 50 USDC min raise, 1 to 10 USDC deposits, 100 slots. */
const RULES: CreatorRules = {
  supply: tokens(600_000),
  decimals: 18,
  floor: usdc("0.001"),
  ceiling: null,
  minRaise: usdc(50),
  minDeposit: usdc(1),
  maxDeposit: usdc(10),
  maxBids: 100,
  pool: null,
};
const POOL = { shareBps: 2_000, reserve: tokens(300_000) };

/** JSON with bigints as strings, to compare whole results. */
const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));

describe("creator sweep", () => {
  it("is deterministic", () => {
    const a = sweepCreator(RULES);
    const b = sweepCreator(RULES);
    expect(json(a)).toBe(json(b));
    expect(a).toHaveLength(CREATOR_DEMANDS.length);
    expect(a.every((l) => l.runs.length === CREATOR_SEEDS)).toBe(true);
  });

  it("covers the table's demand levels and uses the same crowds at every level", () => {
    for (const d of CREATOR_TABLE_DEMANDS) expect(CREATOR_DEMANDS).toContain(d);
    const seeds = creatorSeeds();
    for (const level of sweepCreator(RULES)) expect(level.runs.map((r) => r.seed)).toEqual(seeds);
  });

  it("burns exactly the sale supply that does not sell", () => {
    for (const rules of [RULES, { ...RULES, pool: POOL }, { ...RULES, ceiling: usdc("0.0012") }]) {
      for (const level of sweepCreator(rules)) {
        expect(level.sold + level.burned).toBe(rules.supply);
        for (const r of level.runs) {
          expect(r.burned).toBe(rules.supply - r.sold);
          expect(r.sold <= rules.supply).toBe(true);
        }
      }
    }
  });

  it("sells more and burns less as demand rises", () => {
    const levels = sweepCreator({ ...RULES, maxDeposit: usdc(1_000), maxBids: 500 });
    for (let i = 1; i < levels.length; i++) expect(levels[i].burned <= levels[i - 1].burned).toBe(true);
    expect(levels[0].burned > 0n).toBe(true);
    expect(levels[levels.length - 1].burned).toBe(0n);
  });

  it("fails and refunds everyone when the min raise is not met", () => {
    const rules = { ...RULES, minRaise: usdc(1_000_000), pool: POOL };
    for (const level of sweepCreator(rules, { demands: [0.5, 4] })) {
      expect(level.settled).toBe(0);
      expect(level.clearingPrice).toBeNull();
      expect(level.sold).toBe(0n);
      expect(level.raised).toBe(0n);
      expect(level.burned).toBe(rules.supply);
      expect(level.reserveBurned).toBe(POOL.reserve);
      expect(level.filledShare).toBe(0);
      expect(level.botProfit).toBe(0);
      expect(level.poolPrice).toBeNull();
      for (const r of level.runs) {
        expect(r.status).toBe("failed");
        expect(r.failReason).toBe("below_min_raise");
      }
    }
  });

  it("settles once demand brings the min raise", () => {
    // 300 USDC: more than half the supply at the floor.
    const levels = sweepCreator({ ...RULES, minRaise: usdc(300) }, { demands: [0.5, 4] });
    expect(levels[0].settled).toBeLessThan(CREATOR_SEEDS);
    expect(levels[1].settled).toBe(CREATOR_SEEDS);
    for (const r of levels[1].runs) expect(r.raised >= usdc(300)).toBe(true);
  });

  it("keeps the bid slots, the deposit limits and the ceiling", () => {
    const rules = { ...RULES, ceiling: usdc("0.0011") };
    const cfg = creatorConfig(rules);
    for (const demand of [0.5, 2, 4]) {
      for (const seed of creatorSeeds()) {
        const r = runCreatorSale(makeCrowd(seed, demand, cfg), rules, cfg, seed, demand);
        expect(r.bids).toBeLessThanOrEqual(rules.maxBids);
        expect(r.bids + r.slotsFull + r.belowMin).toBe(r.wanted);
        expect(r.clearingPrice <= rules.ceiling!).toBe(true);
        expect(r.clearingPrice >= rules.floor).toBe(true);
        const fills = r.status === "settled" ? r.filled : 0;
        expect(fills).toBeLessThanOrEqual(r.bids);
      }
    }
  });

  it("opens the launch pool at the clearing price and burns the reserve it does not take", () => {
    for (const level of sweepCreator({ ...RULES, pool: POOL }, { demands: CREATOR_TABLE_DEMANDS })) {
      for (const r of level.runs) {
        expect(r.status).toBe("settled");
        expect(r.pool).not.toBeNull();
        expect(poolPriceMatches(r.pool!.usdc, r.pool!.tokens, r.clearingPrice, 18)).toBe(true);
        expect(r.poolPrice).toBe(r.clearingPrice);
        expect(r.reserveBurned).toBe(POOL.reserve - r.pool!.tokens);
        // The pool takes its share of the raise, never more.
        expect(r.pool!.usdc <= (r.raised * 2_000n) / 10_000n).toBe(true);
      }
    }
  });

  it("with no cap, no slot limit and no min raise, matches the Arena's Sealround run", () => {
    const cfg = DEFAULT_CONFIG;
    const open: CreatorRules = {
      supply: cfg.supply,
      decimals: cfg.decimals,
      floor: cfg.launchPrice,
      ceiling: null,
      minRaise: 0n,
      minDeposit: 1n,
      maxDeposit: usdc(1_000_000_000),
      maxBids: 10_000,
      pool: null,
    };
    for (const demand of [0.5, 1.7, 4]) {
      for (const seed of [5, 20261114]) {
        const arena = simulateRun(seed, demand);
        const mine = runCreatorSale(arena.crowd, open, creatorConfig(open), seed, demand);
        expect(mine.clearingPrice).toBe(arena.launches.fairground.finalPrice);
        expect(mine.sold).toBe(arena.launches.fairground.sold);
        expect(mine.raised).toBe(arena.launches.fairground.raised);
        expect(mine.botProfit).toBe(Math.round(arena.metrics.fairground.botProfit * 100) / 100 || 0);
        // Nobody is turned away, so nobody is left to sell to above the clearing price.
        expect(Math.abs(mine.botProfit)).toBeLessThan(0.01);
      }
    }
  });

  it("bots profit only from demand the sale turned away or capped", () => {
    // Slots full and a 10 USDC cap: people who wanted more buy after the sale, and bots sell to them.
    const tight = simulateCreatorLevel(RULES, 2);
    expect(tight.slotsFull + tight.capped).toBeGreaterThan(0);
    expect(tight.botProfit).toBeGreaterThan(0);
    // Room for every bid in full: nothing is left to sell into.
    const roomy = simulateCreatorLevel({ ...RULES, maxDeposit: usdc(100_000), maxBids: 500 }, 2);
    expect(roomy.turnedAway + roomy.capped).toBe(0);
    expect(Math.abs(roomy.botProfit)).toBeLessThan(0.01);
  });

  it("takes a crowd size", () => {
    const small = simulateCreatorLevel(RULES, 1, { humans: 50 });
    const large = simulateCreatorLevel(RULES, 1, { humans: 1_000 });
    expect(small.wanted).toBeLessThan(60);
    expect(large.wanted).toBeGreaterThan(500);
    expect(large.bids).toBe(RULES.maxBids);
  });
});
