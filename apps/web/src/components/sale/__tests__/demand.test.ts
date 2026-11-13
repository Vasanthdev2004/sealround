import { describe, expect, it } from "vitest";
import { clear, type Bid } from "@fairground/clearing";
import { sealedBidLen, toB64 } from "@/lib/crypto";
import type { SaleConfig } from "@/lib/types";
import {
  base64Bytes,
  bucketBids,
  busiestSlice,
  costAt,
  countTicks,
  demandOf,
  multipleStr,
  offsetLabel,
  ratio,
  shareStr,
  sizeCheck,
  sliceLength,
} from "../demand";

const USDC = 1_000_000n;
const TOKEN = 10n ** 18n;

/** The judge run's terms: 100,000 tokens for sale, floor 0.001 USDC, min raise 50 USDC. */
function config(over: Partial<SaleConfig> = {}): SaleConfig {
  return {
    tokenName: "Judge Run 1",
    tokenSymbol: "JDG1",
    decimals: 18,
    totalSupply: 220_000n * TOKEN,
    saleSupply: 100_000n * TOKEN,
    creatorAllocation: 100_000n * TOKEN,
    lpReserve: 20_000n * TOKEN,
    floorPrice: 1_000n,
    maxPrice: null,
    minRaise: 50n * USDC,
    bidStart: 0,
    bidEnd: 25_000,
    minDeposit: USDC,
    maxDepositPerAccount: 10n * USDC,
    revealMode: "tee",
    unsoldRule: "burn",
    settleTimeoutMs: 7_200_000,
    quoteToken: "usdc.testnet",
    ...over,
  };
}

const ids = (d: ReturnType<typeof demandOf>) => d.targets.map((t) => t.id);

describe("demand targets", () => {
  it("prices a sell-out at the floor from the supply for sale, rounded up", () => {
    expect(costAt(100_000n * TOKEN, 1_000n, 18)).toBe(100n * USDC);
    // One base unit more than a whole token at 1 micro-USDC: a fraction of a micro-USDC, rounded up.
    expect(costAt(TOKEN + 1n, 1n, 18)).toBe(2n);
    expect(costAt(0n, 1_000n, 18)).toBe(0n);
  });

  it("has nothing covered and the floor as the cap with no deposits", () => {
    const d = demandOf(config(), 0n);
    expect(ids(d)).toEqual(["min_raise", "floor_sell_out"]);
    expect(d.targets.map((t) => [t.reached, t.share, t.toGo])).toEqual([
      [false, 0, 50n * USDC],
      [false, 0, 100n * USDC],
    ]);
    expect(d.belowMinRaise).toBe(true);
    expect(d.floorOnly).toBe(true);
    expect(d.coverage).toBe(0);
    expect(d.priceCap).toBe(1_000n);
    expect(d.capMultiple).toBe(1);
  });

  it("covers the min raise first, then the floor sell-out", () => {
    const d = demandOf(config(), 62n * USDC);
    expect(d.targets[0]).toMatchObject({ id: "min_raise", reached: true, share: 1, toGo: 0n });
    expect(d.targets[1]).toMatchObject({ id: "floor_sell_out", reached: false, share: 0.62, toGo: 38n * USDC });
    expect(d.belowMinRaise).toBe(false);
    expect(d.floorOnly).toBe(true);
    expect(d.priceCap).toBe(1_000n);
    expect(d.coverage).toBe(0.62);
  });

  it("caps the price at what the deposits could pay for every token", () => {
    const d = demandOf(config(), 351_390_000n);
    expect(d.targets.every((t) => t.reached)).toBe(true);
    expect(d.coverage).toBe(3.51);
    // floor(351.39 USDC / 100,000 tokens) = 0.0035139 USDC, in micro-USDC per token: 3513.
    expect(d.priceCap).toBe(3_513n);
    expect(d.capMultiple).toBe(3.51);
    expect(d.cappedByMax).toBe(false);
    expect(d.floorOnly).toBe(false);
  });

  it("covers the floor sell-out exactly at its amount, with the price still at the floor", () => {
    const d = demandOf(config(), 100n * USDC);
    expect(d.targets[1]).toMatchObject({ reached: true, toGo: 0n });
    expect(d.coverage).toBe(1);
    expect(d.priceCap).toBe(1_000n);
    expect(d.floorOnly).toBe(true);
    // One micro-USDC per token more needs 0.1 USDC more for 100,000 tokens.
    expect(demandOf(config(), 100_100_000n - 1n).floorOnly).toBe(true);
    expect(demandOf(config(), 100_100_000n).priceCap).toBe(1_001n);
  });

  it("adds the max price sell-out with a ceiling, and the ceiling caps the price", () => {
    const c = config({ maxPrice: 2_000n });
    const low = demandOf(c, 150n * USDC);
    expect(ids(low)).toEqual(["min_raise", "floor_sell_out", "max_sell_out"]);
    expect(low.targets[2]).toMatchObject({ amount: 200n * USDC, reached: false, share: 0.75, toGo: 50n * USDC });
    expect(low.priceCap).toBe(1_500n);
    expect(low.cappedByMax).toBe(false);

    const high = demandOf(c, 351_390_000n);
    expect(high.targets[2].reached).toBe(true);
    expect(high.priceCap).toBe(2_000n);
    expect(high.cappedByMax).toBe(true);
    expect(high.capMultiple).toBe(2);
    // Coverage still says what the deposits could buy at the floor.
    expect(high.coverage).toBe(3.51);
  });

  it("is floor only when the max price is the floor", () => {
    const d = demandOf(config({ maxPrice: 1_000n }), 500n * USDC);
    expect(d.priceCap).toBe(1_000n);
    expect(d.floorOnly).toBe(true);
  });

  it("leaves the launch pool out: its reserve is not supply for sale", () => {
    const plain = demandOf(config({ liquidity: null, lpReserve: 0n }), 120n * USDC);
    const pool = demandOf(
      config({ liquidity: { dex: "dex.testnet", raiseShareBps: 2_000, poolTokens: 20_000n * TOKEN, feeBps: 30 } }),
      120n * USDC,
    );
    expect(pool).toEqual(plain);
    expect(pool.floorSellOut).toBe(100n * USDC);
  });

  it("drops a zero min raise and keeps a min raise above the floor sell-out in place", () => {
    expect(ids(demandOf(config({ minRaise: 0n }), 10n * USDC))).toEqual(["floor_sell_out"]);
    const d = demandOf(config({ minRaise: 150n * USDC }), 120n * USDC);
    expect(d.targets.map((t) => [t.id, t.reached])).toEqual([
      ["min_raise", false],
      ["floor_sell_out", true],
    ]);
    expect(d.belowMinRaise).toBe(true);
  });

  it("never claims more than the clearing rule allows", () => {
    // Random bid sets, cleared by the reference clearing: the price stays at or
    // under the cap, at the floor when the meter says floor only, and a sale
    // whose deposits miss the min raise fails.
    let seed = 7;
    const rand = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    for (let run = 0; run < 300; run++) {
      const c = config({
        maxPrice: rand() < 0.3 ? 1_000n + BigInt(Math.floor(rand() * 4_000)) : null,
        minRaise: BigInt(Math.floor(rand() * 150)) * USDC,
      });
      const n = 1 + Math.floor(rand() * 40);
      const bids: Bid[] = Array.from({ length: n }, (_, i) => {
        const deposit = USDC + BigInt(Math.floor(rand() * 9_000_000));
        return {
          bidder: `b${i}.testnet`,
          deposit,
          maxPrice: 1_000n + BigInt(Math.floor(rand() * 8_000)),
          maxSpend: 1n + BigInt(Math.floor(rand() * Number(deposit))),
        };
      });
      const deposits = bids.reduce((a, b) => a + b.deposit, 0n);
      const d = demandOf(c, deposits);
      const r = clear(
        { saleSupply: c.saleSupply, floorPrice: c.floorPrice, minRaise: c.minRaise, decimals: c.decimals, maxPrice: c.maxPrice },
        bids,
      );
      if (r.status === "settled") {
        expect(r.clearingPrice).toBeLessThanOrEqual(d.priceCap);
        if (d.floorOnly) expect(r.clearingPrice).toBe(c.floorPrice);
        expect(r.totalRaised).toBeLessThanOrEqual(deposits);
        if (!d.targets.find((t) => t.id === "floor_sell_out")!.reached) expect(r.unsold).toBeGreaterThan(0n);
      }
      if (d.belowMinRaise) expect(r.status).toBe("failed");
    }
  });
});

describe("display", () => {
  it("floors ratios, multiples and shares, never rounding up", () => {
    expect(ratio(2n, 3n)).toBe(0.66);
    expect(ratio(5n, 0n)).toBe(0);
    expect(multipleStr(2.06)).toBe("2.06×");
    expect(multipleStr(3.519)).toBe("3.51×");
    expect(multipleStr(2)).toBe("2×");
    expect(multipleStr(12.9)).toBe("12×");
    expect(multipleStr(0)).toBe("0×");
    expect(shareStr(0.999)).toBe("99 %");
    expect(shareStr(1)).toBe("100 %");
    expect(shareStr(0.004)).toBe("0 %");
  });
});

describe("bids over time", () => {
  it("picks the shortest round slice that fits", () => {
    expect(sliceLength(25_000, 36)).toBe(1_000);
    expect(sliceLength(25_000, 20)).toBe(2_000);
    expect(sliceLength(10 * 60_000, 36)).toBe(30_000);
    expect(sliceLength(9_600_000, 36)).toBe(300_000);
    expect(sliceLength(9_600_000, 20)).toBe(600_000);
    expect(sliceLength(3 * 86_400_000, 36)).toBe(7_200_000);
  });

  it("buckets bids by time from the open, with running totals", () => {
    const bids = [
      { placedAt: 1_000 - 50, deposit: 10n * USDC }, // a hair before the open: first slice
      { placedAt: 1_000, deposit: 10n * USDC },
      { placedAt: 1_900, deposit: 2n * USDC },
      { placedAt: 4_500, deposit: 5n * USDC },
      { placedAt: 26_000, deposit: 1n * USDC }, // at the close: last slice
    ];
    const s = bucketBids(bids, 1_000, 26_000, 2_000);
    expect(s).toHaveLength(13);
    expect(s[0]).toMatchObject({ from: 0, to: 2_000, bids: 3, deposits: 22n * USDC, totalBids: 3, totalDeposits: 22n * USDC });
    expect(s[1]).toMatchObject({ bids: 1, deposits: 5n * USDC, totalBids: 4, totalDeposits: 27n * USDC });
    expect(s[2]).toMatchObject({ bids: 0, totalBids: 4 });
    // The last slice is cut short at the close.
    expect(s[12]).toMatchObject({ from: 24_000, to: 25_000, bids: 1, totalBids: 5, totalDeposits: 28n * USDC });
  });

  it("returns one empty slice for an empty window and finds the busiest slice", () => {
    expect(bucketBids([], 0, 0, 1_000)).toEqual([
      { from: 0, to: 1, bids: 0, deposits: 0n, totalBids: 0, totalDeposits: 0n },
    ]);
    expect(busiestSlice([{ bids: 0 }, { bids: 3 }, { bids: 1 }, { bids: 3 }])).toBe(1);
    expect(busiestSlice([{ bids: 0 }, { bids: 0 }])).toBe(-1);
  });

  it("gives the count axis two to five round values", () => {
    expect(countTicks(0)).toEqual([0, 1]);
    expect(countTicks(3)).toEqual([0, 1, 2, 3]);
    expect(countTicks(4)).toEqual([0, 1, 2, 3, 4]);
    expect(countTicks(7)).toEqual([0, 2, 4, 6, 8]);
    expect(countTicks(50)).toEqual([0, 20, 40, 60]);
    expect(countTicks(130)).toEqual([0, 50, 100, 150]);
  });

  it("labels slice edges exactly", () => {
    expect(offsetLabel(0)).toBe("+0s");
    expect(offsetLabel(4_000)).toBe("+4s");
    expect(offsetLabel(90_000)).toBe("+1m 30s");
    expect(offsetLabel(600_000)).toBe("+10m");
    expect(offsetLabel(3_600_000)).toBe("+1h");
    expect(offsetLabel(4_200_000)).toBe("+1h 10m");
    expect(offsetLabel(108_000_000)).toBe("+1d 6h");
  });
});

describe("what the chain sees", () => {
  const b64OfLen = (n: number) => toB64(new Uint8Array(n));

  it("decodes padded base64 lengths", () => {
    expect(base64Bytes("AAAA")).toBe(3);
    expect(base64Bytes("AAA=")).toBe(2);
    expect(base64Bytes("AA==")).toBe(1);
    expect(base64Bytes("")).toBe(0);
    expect(base64Bytes(b64OfLen(242))).toBe(242);
  });

  it("checks every sealed bid against 224 + sale id + account bytes", () => {
    const bids = [
      { bidder: "alice.testnet", ciphertext: b64OfLen(sealedBidLen("fairt", "alice.testnet")) },
      { bidder: "a-much-longer-name.testnet", ciphertext: b64OfLen(224 + 5 + 26) },
      { bidder: "bob.testnet", ciphertext: b64OfLen(sealedBidLen("fairt", "bob.testnet") + 1) },
    ];
    expect(sealedBidLen("fairt", "alice.testnet")).toBe(224 + 5 + 13);
    expect(sizeCheck("fairt", false, bids)).toEqual({ exact: 2, total: 3 });
    expect(sizeCheck("fairt", false, [])).toEqual({ exact: 0, total: 0 });
  });

  it("checks every commitment is 32 bytes", () => {
    const bids = [
      { bidder: "alice.testnet", ciphertext: b64OfLen(32) },
      { bidder: "bob.testnet", ciphertext: b64OfLen(31) },
    ];
    expect(sizeCheck("crt", true, bids)).toEqual({ exact: 1, total: 2 });
  });
});
