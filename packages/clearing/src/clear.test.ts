import { describe, expect, it } from "vitest";
import {
  clear,
  contractChecks,
  costOf,
  demandAt,
  prorate,
  tokensFor,
  type Bid,
  type SaleParams,
} from "./clear";
import { randomBids } from "./random";
import { tokens, usdc } from "./units";

const ONE = 10n ** 18n;
const params: SaleParams = {
  saleSupply: tokens(600_000),
  floorPrice: usdc("0.001"), // 1_000n
  minRaise: usdc(50),
};
const bid = (bidder: string, deposit: number, maxPrice: string, maxSpend: number): Bid => ({
  bidder,
  deposit: usdc(deposit),
  maxPrice: usdc(maxPrice),
  maxSpend: usdc(maxSpend),
});

describe("clear: hand-checked cases", () => {
  it("undersubscribed: clears at floor, unsold remainder", () => {
    const r = clear(params, [
      bid("a", 100, "0.002", 100),
      bid("b", 100, "0.001", 50),
    ]);
    expect(r.status).toBe("settled");
    expect(r.clearingPrice).toBe(1_000n);
    expect(r.oversubscribed).toBe(false);
    expect(r.fills[0].tokens).toBe(tokens(100_000));
    expect(r.fills[1].tokens).toBe(tokens(50_000));
    expect(r.totalRaised).toBe(usdc(150));
    expect(r.unsold).toBe(tokens(450_000));
    expect(r.fills[1].refund).toBe(usdc(50));
  });

  it("oversubscribed: everyone pays the same price, supply sells out", () => {
    // Supply 600k. At 0.002: a(600) wants 300k, b(600) wants 300k -> exactly 600k.
    const r = clear(params, [
      bid("a", 600, "0.005", 600),
      bid("b", 600, "0.002", 600),
      bid("c", 600, "0.0015", 600),
    ]);
    expect(r.clearingPrice).toBe(2_000n);
    expect(r.totalSold).toBe(params.saleSupply);
    expect(r.fills[2].tokens).toBe(0n);
    expect(r.fills[2].refund).toBe(usdc(600));
    expect(r.unsold).toBe(0n);
  });

  it("ties at the clearing price share pro rata", () => {
    // a above, b and c tied at 0.003.
    const r = clear({ ...params, saleSupply: tokens(1000), minRaise: 0n }, [
      bid("a", 10, "0.01", 1.5),     // 500 tokens at 0.003
      bid("b", 10, "0.003", 3),      // wants 1000
      bid("c", 10, "0.003", 1.5),    // wants 500
    ]);
    // D(0.003) = 500 + 1000 + 500 = 2000 >= 1000; D(0.003000001)... only a -> < 1000
    expect(r.clearingPrice).toBe(3_000n);
    expect(r.fills[0].tokens).toBe(tokens(500));
    // remaining 500 split 2:1
    const b = r.fills[1].tokens;
    const c = r.fills[2].tokens;
    expect(b + c).toBe(tokens(500));
    expect(b).toBeGreaterThan(c);
    expect(b - 2n * c <= 2n && 2n * c - b <= 2n).toBe(true);
  });

  it("min raise missed: sale fails, everyone refunded in full", () => {
    const r = clear(params, [bid("a", 10, "0.01", 10)]);
    expect(r.status).toBe("failed");
    expect(r.failReason).toBe("below_min_raise");
    expect(r.fills[0].tokens).toBe(0n);
    expect(r.fills[0].refund).toBe(usdc(10));
  });

  it("invalid bids count as zero and get full refunds", () => {
    const r = clear(params, [
      bid("a", 100, "0.01", 100),
      { bidder: "x", deposit: usdc(100), maxPrice: null, maxSpend: null },
      bid("y", 10, "0.01", 20), // spend above deposit
      bid("z", 100, "0.0009", 100), // below floor
    ]);
    expect(r.nValid).toBe(1);
    expect(r.fills.slice(1).map((f) => f.invalidReason)).toEqual([
      "decrypt_failed",
      "spend_above_deposit",
      "price_below_floor",
    ]);
    for (const f of r.fills.slice(1)) {
      expect(f.tokens).toBe(0n);
      expect(f.refund).toBe(f.deposit);
    }
  });

  it("no valid bids: failed", () => {
    const r = clear(params, []);
    expect(r.status).toBe("failed");
    expect(r.failReason).toBe("no_valid_bids");
  });

  it("bot and human pay the same clearing price", () => {
    // Supply 10,000. At P <= 0.004 both want (10 + 4) / P tokens, so P* ~ 0.0014.
    // Per-bid floor rounding leaves demand at 1400 a few base units short of
    // supply, so the integer answer is 1399.
    const r = clear({ ...params, saleSupply: tokens(10_000), minRaise: 0n }, [
      bid("sniper.testnet", 10, "1", 10), // bids at second 0, huge max price
      bid("human.testnet", 10, "0.004", 4), // bids in the last minute
    ]);
    expect(r.clearingPrice).toBe(1_399n);
    const [bot, human] = r.fills;
    // Both filled; each paid tokens * P*, never their own max price.
    expect(bot.tokens).toBeGreaterThan(0n);
    expect(human.tokens).toBeGreaterThan(0n);
    expect(bot.spent).toBe(costOf(bot.tokens, r.clearingPrice, ONE));
    expect(human.spent).toBe(costOf(human.tokens, r.clearingPrice, ONE));
  });
});

describe("prorate", () => {
  it("never exceeds weights and sums to amount", () => {
    expect(prorate(10n, [3n, 3n, 3n])).toEqual([3n, 3n, 3n]);
    expect(prorate(7n, [3n, 3n, 3n])).toEqual([3n, 2n, 2n]);
    expect(prorate(0n, [3n])).toEqual([0n]);
    expect(prorate(5n, [0n, 10n])).toEqual([0n, 5n]);
  });
});

describe("clear: invariants on 1,000 random bid sets", () => {
  for (let seed = 1; seed <= 1000; seed++) {
    it.concurrent(`seed ${seed}`, () => {
      const supply = tokens(1 + (seed % 7) * 50_000);
      const p: SaleParams = { ...params, saleSupply: supply, minRaise: usdc(seed % 3 === 0 ? 400 : 5) };
      const bids = randomBids(seed, {
        n: 1 + (seed % 120),
        floorPrice: p.floorPrice,
        maxDeposit: usdc(200),
        invalidRate: 0.08,
        tieRate: 0.35,
      });
      const r = clear(p, bids);
      const P = r.clearingPrice;

      // Deterministic.
      expect(clear(p, bids)).toEqual(r);
      // Contract-side checks pass on every honest result.
      const failed = contractChecks(p, bids, r).filter((c) => c !== "raise_at_least_min");
      expect(failed).toEqual([]);
      // Money conserved per bid.
      for (const f of r.fills) {
        expect(f.spent + f.refund).toBe(f.deposit);
        expect(f.spent >= 0n && f.refund >= 0n).toBe(true);
      }
      expect(r.totalSold <= p.saleSupply).toBe(true);
      expect(P >= p.floorPrice).toBe(true);

      if (r.status === "failed") {
        expect(r.fills.every((f) => f.tokens === 0n && f.refund === f.deposit)).toBe(true);
        return;
      }
      expect(r.totalRaised >= p.minRaise).toBe(true);

      const valid = bids
        .map((b, i) => ({ b, i }))
        .filter(({ i }) => r.fills[i].valid)
        .map(({ b, i }) => ({ i, maxPrice: b.maxPrice!, maxSpend: b.maxSpend! }));

      for (const v of valid) {
        const f = r.fills[v.i];
        const want = tokensFor(v.maxSpend, P, ONE);
        // Nobody pays more than their max spend, or gets more than they asked for.
        expect(f.spent <= v.maxSpend).toBe(true);
        expect(f.tokens <= want).toBe(true);
        // Bids below P* get nothing.
        if (v.maxPrice < P) expect(f.tokens).toBe(0n);
      }

      if (r.oversubscribed) {
        // P* is the highest price where demand covers supply.
        expect(demandAt(valid, P, ONE) >= p.saleSupply).toBe(true);
        expect(demandAt(valid, P + 1n, ONE) < p.saleSupply).toBe(true);
        expect(r.totalSold).toBe(p.saleSupply);
        // Bids strictly above P* are filled in full unless they alone exceed supply.
        const above = valid.filter((v) => v.maxPrice > P);
        const aboveDemand = above.reduce((a, v) => a + tokensFor(v.maxSpend, P, ONE), 0n);
        if (aboveDemand <= p.saleSupply) {
          for (const v of above) expect(r.fills[v.i].tokens).toBe(tokensFor(v.maxSpend, P, ONE));
        }
      } else {
        expect(P).toBe(p.floorPrice);
        for (const v of valid) expect(r.fills[v.i].tokens).toBe(tokensFor(v.maxSpend, P, ONE));
      }
    });
  }
});
