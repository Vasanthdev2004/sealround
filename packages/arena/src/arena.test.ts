import { contractChecks, costOf, usdc } from "@fairground/clearing";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, oneToken } from "./config";
import { makeCurve, runBondingCurve } from "./launches";
import { gini } from "./metrics";
import { priceTrace, runArena, simulateRun, summarize } from "./run";
import { makeCrowd } from "./crowd";

const ONE = oneToken(DEFAULT_CONFIG);
const DEMANDS = [0.5, 1, 1.7, 2.5, 4];

describe("determinism", () => {
  it("same seed gives byte-identical output", () => {
    const a = runArena({ seed: 42, runs: 8 });
    const b = runArena({ seed: 42, runs: 8 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("a different seed gives a different crowd", () => {
    const a = runArena({ seed: 42, runs: 4 });
    const b = runArena({ seed: 43, runs: 4 });
    expect(JSON.stringify(a.rows)).not.toBe(JSON.stringify(b.rows));
  });

  it("summarize is a pure function of the rows", () => {
    const r = runArena({ seed: 7, runs: 6 });
    expect(summarize(r.rows)).toEqual(r.summary);
  });

  it("produces plain JSON (no bigint)", () => {
    const r = runArena({ seed: 1, runs: 3 });
    expect(() => JSON.stringify(r)).not.toThrow();
    expect(r.rows).toHaveLength(3);
    expect(r.assumptions.length).toBeGreaterThan(5);
  });
});

describe("Fairground invariants", () => {
  for (const demand of DEMANDS) {
    it(`every buyer pays the same price per token, bots included (demand ${demand}x)`, () => {
      const run = simulateRun(1234, demand);
      const fg = run.launches.fairground;
      const result = fg.clearing!;
      expect(result.status).toBe("settled");
      const P = result.clearingPrice;
      expect(fg.finalPrice).toBe(P);

      const buyers = fg.purchases;
      expect(buyers.length).toBeGreaterThan(0);
      for (const p of buyers) {
        // The charge is exactly tokens x P*, rounded up, for every buyer.
        expect(p.usdc).toBe(costOf(p.tokens, P, ONE));
        expect(p.priceAfter).toBe(P);
      }

      const bots = buyers.filter((p) => run.crowd[p.agent].kind === "bot");
      const humans = buyers.filter((p) => run.crowd[p.agent].kind === "human");
      expect(bots.length).toBe(DEFAULT_CONFIG.bots);
      expect(humans.length).toBeGreaterThan(0);

      // Bots pay exactly what humans pay: the same P*, so the premium is 1.
      const m = run.metrics.fairground;
      expect(m.premium).not.toBeNull();
      expect(Math.abs(m.premium! - 1)).toBeLessThan(1e-9);
      expect(m.botPrice).toBeCloseTo(Number(P) / 1e6, 9);
    });
  }

  it("never sells more than supply and passes the contract checks", () => {
    for (const demand of DEMANDS) {
      const run = simulateRun(99, demand);
      const fg = run.launches.fairground;
      expect(fg.sold <= DEFAULT_CONFIG.supply).toBe(true);
      const bidders = run.crowd.filter((a) => a.kind === "bot" || a.valuation >= DEFAULT_CONFIG.launchPrice);
      const failed = contractChecks(
        { saleSupply: DEFAULT_CONFIG.supply, floorPrice: DEFAULT_CONFIG.launchPrice, minRaise: 0n },
        bidders.map((a) => ({ bidder: a.id, deposit: a.budget })),
        fg.clearing!,
      );
      expect(failed).toEqual([]);
    }
  });

  it("bots make no profit: there is nobody left to sell to above the clearing price", () => {
    for (const seed of [5, 20261114, 31337]) {
      for (const demand of DEMANDS) {
        // At most rounding dust (micro-USDC) when a prorated buyer tops up in the pool at cost.
        expect(Math.abs(simulateRun(seed, demand).metrics.fairground.botProfit)).toBeLessThan(0.01);
      }
    }
  });
});

describe("bonding curve", () => {
  it("price strictly increases with every buy", () => {
    const curve = makeCurve(DEFAULT_CONFIG);
    let last = curve.price();
    for (const amount of ["5", "120", "0.5", "800", "40", "2500", "9"]) {
      const got = curve.buy(usdc(amount));
      expect(got > 0n).toBe(true);
      const now = curve.price();
      expect(now > last).toBe(true);
      last = now;
    }
  });

  it("buying the whole curve raises supply x launch price (within rounding)", () => {
    const curve = makeCurve(DEFAULT_CONFIG);
    const cost = curve.costToBuy(DEFAULT_CONFIG.supply);
    const target = (DEFAULT_CONFIG.supply * DEFAULT_CONFIG.launchPrice) / ONE;
    expect(cost - target <= 1n && target - cost <= 1n).toBe(true);
  });

  it("with nobody selling, the launch price path never goes down", () => {
    const crowd = makeCrowd(77, 2, { ...DEFAULT_CONFIG, bots: 0 });
    const o = runBondingCurve(crowd, { ...DEFAULT_CONFIG, bots: 0 });
    for (let i = 1; i < o.purchases.length; i++) {
      expect(o.purchases[i].priceAfter > o.purchases[i - 1].priceAfter).toBe(true);
    }
  });

  it("bots buy first, at second 0, and get the cheapest tokens", () => {
    const run = simulateRun(2024, 2);
    const trace = priceTrace(run);
    const botPoints = trace.curve.filter((p) => p.actor === "bot");
    expect(botPoints).toHaveLength(DEFAULT_CONFIG.bots);
    expect(botPoints.every((p) => p.t === 0)).toBe(true);
    const m = run.metrics.bonding_curve;
    expect(m.premium! > 1).toBe(true);
  });
});

describe("gini", () => {
  it("is 0 for equal holdings and grows with concentration", () => {
    expect(gini([5, 5, 5, 5])).toBeCloseTo(0, 12);
    expect(gini([1, 1, 1, 97])).toBeGreaterThan(0.7);
    expect(gini([0, 0, 10])).toBe(0); // zero balances are not holders
  });
});
