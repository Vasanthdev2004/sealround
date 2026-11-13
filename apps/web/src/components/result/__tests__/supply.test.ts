import { describe, expect, it } from "vitest";
import { report } from "@/components/arena/data";
import type { LiquidityState, ProceedsState, ResultFill, SaleConfig, SaleResult } from "@/lib/types";
import {
  burnStateOf,
  giniOf,
  poolLeftover,
  poolTokensKept,
  rheaHome,
  scorecard,
  scoreRows,
  share,
  shareStr,
  supplyLedger,
  supplyParts,
  tradeState,
  type SimSummary,
} from "../supply";

// A token with 18 decimals, so every amount is far past 2^53 and only bigint arithmetic adds up.
const ONE = 10n ** 18n;
const USDC = 1_000_000n;
const T = (n: number | bigint) => BigInt(n) * ONE;

const TOTAL = T(1_000_000_000);
const SALE = T(400_000_000);
const POOL_TOKENS = T(100_000_000);
// An odd base-unit remainder in the creator allocation, so a rounding slip anywhere shows.
const CREATOR = TOTAL - SALE - POOL_TOKENS;

function config(over: Partial<SaleConfig> = {}): SaleConfig {
  return {
    tokenName: "Test",
    tokenSymbol: "TST",
    decimals: 18,
    totalSupply: TOTAL,
    saleSupply: SALE,
    creatorAllocation: CREATOR,
    lpReserve: POOL_TOKENS,
    floorPrice: 1_000n,
    maxPrice: null,
    minRaise: 0n,
    bidStart: 0,
    bidEnd: 1,
    minDeposit: USDC,
    maxDepositPerAccount: 1_000n * USDC,
    revealMode: "sealed",
    unsoldRule: "burn",
    settleTimeoutMs: 1,
    quoteToken: "usdc.test",
    ...over,
  } as SaleConfig;
}

const withPool = (over: Partial<SaleConfig> = {}) =>
  config({
    liquidity: { dex: "ref-finance-101.testnet", raiseShareBps: 2_000, poolTokens: POOL_TOKENS, feeBps: 30 },
    ...over,
  });

function liquidity(over: Partial<LiquidityState>): LiquidityState {
  return {
    stage: "seeded",
    nextStep: null,
    inFlight: null,
    dex: "ref-finance-101.testnet",
    poolId: 42,
    usdc: 0n,
    tokens: 0n,
    shares: 0n,
    usdcOnDex: 0n,
    tokensOnDex: 0n,
    failures: 0,
    deadline: null,
    ...over,
  };
}

const unpaid: ProceedsState = { raisePaid: false, allocationPaid: false, unsoldBurned: false, reserveReturned: false };
const paid: ProceedsState = { raisePaid: true, allocationPaid: true, unsoldBurned: true, reserveReturned: true };

type R = Pick<SaleResult, "status" | "totalSold" | "unsold" | "proceeds" | "liquidity">;

/** The contract's get_result.unsold: unsold sale supply plus the pool reserve the pool keeps out. */
function result(c: SaleConfig, sold: bigint, over: Partial<R> = {}): R {
  const status = over.status ?? "settled";
  const liq = over.liquidity ?? null;
  const saleLeft = status === "failed" ? c.saleSupply : c.saleSupply - sold;
  const poolLeft = c.liquidity ? c.liquidity.poolTokens - poolTokensKept(liq) : 0n;
  return {
    status,
    totalSold: status === "failed" ? 0n : sold,
    unsold: saleLeft + poolLeft,
    proceeds: unpaid,
    liquidity: liq,
    ...over,
  };
}

const sumParts = (l: ReturnType<typeof supplyLedger>) => supplyParts(l).reduce((a, p) => a + p.amount, 0n);

describe("supplyLedger: the parts add up to the supply at launch, in base units", () => {
  it("sold out, no pool (NEAR: no reserve)", () => {
    const c = config({ lpReserve: 0n, creatorAllocation: TOTAL - SALE });
    const l = supplyLedger({ config: c }, result(c, SALE));
    expect(l.gap).toBe(0n);
    expect(sumParts(l)).toBe(TOTAL);
    expect(l.burn).toBe(0n);
    expect(l.burnState).toBe("none");
    expect(l.after).toBe(TOTAL);
    expect(l.supplyNow).toBe(TOTAL);
    expect(supplyParts(l).map((p) => p.id)).toEqual(["sold", "creator"]);
  });

  it("partly sold, no pool, burn owed then burned", () => {
    const c = config({ lpReserve: 0n, creatorAllocation: TOTAL - SALE });
    const sold = SALE / 3n + 7n; // not a whole token
    const owed = supplyLedger({ config: c }, result(c, sold));
    expect(owed.gap).toBe(0n);
    expect(sumParts(owed)).toBe(TOTAL);
    expect(owed.burn).toBe(SALE - sold);
    expect(owed.burnUnsold).toBe(SALE - sold);
    expect(owed.burnPool).toBe(0n);
    expect(owed.burnState).toBe("owed");
    expect(owed.supplyNow).toBe(TOTAL);
    expect(owed.after).toBe(TOTAL - (SALE - sold));

    const done = supplyLedger({ config: c }, result(c, sold, { proceeds: paid }));
    expect(done.burnState).toBe("burned");
    expect(done.supplyNow).toBe(done.after);
  });

  it("the simulated chain's LP reserve without a pool is its own part", () => {
    const c = config();
    const sold = SALE / 2n;
    const l = supplyLedger({ config: c }, result(c, sold));
    expect(l.reserve).toBe(POOL_TOKENS);
    expect(l.pool).toBe(0n);
    expect(l.gap).toBe(0n);
    expect(sumParts(l)).toBe(TOTAL);
    expect(supplyParts(l).map((p) => p.id)).toEqual(["sold", "creator", "reserve", "burned"]);
  });

  it("failed sale with a pool: the whole sale supply and the whole pool reserve burn", () => {
    const c = withPool();
    const r = result(c, 0n, { status: "failed", liquidity: liquidity({ stage: "cancelled", poolId: null }) });
    const l = supplyLedger({ config: c }, r);
    expect(l.sold).toBe(0n);
    expect(l.pool).toBe(0n);
    expect(l.burn).toBe(SALE + POOL_TOKENS);
    expect(l.burnUnsold).toBe(SALE);
    expect(l.burnPool).toBe(POOL_TOKENS);
    expect(l.gap).toBe(0n);
    expect(sumParts(l)).toBe(TOTAL);
    // The creator allocation is paid on a failed sale too.
    expect(l.creator).toBe(CREATOR);
  });

  it("failed sale with a non-zero totalSold in the result still counts nothing sold", () => {
    const c = config({ lpReserve: 0n, creatorAllocation: TOTAL - SALE });
    const l = supplyLedger({ config: c }, { ...result(c, 0n, { status: "failed" }), totalSold: T(5) });
    expect(l.sold).toBe(0n);
    expect(l.gap).toBe(0n);
  });

  it.each([
    ["seeding", liquidity({ stage: "seeding", nextStep: "register", poolId: null }), true],
    ["seeded", liquidity({ stage: "seeded", shares: 10n ** 24n }), false],
  ] as const)("pool %s: the pool keeps its tokens, the rest of the reserve burns", (_, base, locked) => {
    const c = withPool();
    const sold = (SALE * 3n) / 4n + 1n;
    const keep = sold / 5n; // the pool gets 20 % of the tokens sold
    const liq = { ...base, tokens: keep };
    const l = supplyLedger({ config: c }, result(c, sold, { liquidity: liq }));
    expect(l.pool).toBe(keep);
    expect(l.burnUnsold).toBe(SALE - sold);
    expect(l.burnPool).toBe(POOL_TOKENS - keep);
    expect(l.gap).toBe(0n);
    expect(sumParts(l)).toBe(TOTAL);
    expect(l.locked).toBe(locked);
  });

  it("sold out with a pool: only the pool's spare reserve burns", () => {
    const c = withPool();
    const keep = SALE / 5n;
    const l = supplyLedger({ config: c }, result(c, SALE, { liquidity: liquidity({ tokens: keep }) }));
    expect(l.burnUnsold).toBe(0n);
    expect(l.burnPool).toBe(POOL_TOKENS - keep);
    expect(l.gap).toBe(0n);
  });

  it("abandoned pool: tokens still on the exchange are kept until withdrawn", () => {
    const c = withPool();
    const sold = SALE / 2n;
    const onDex = T(1_234) + 5n;
    const liq = liquidity({ stage: "abandoned", tokens: sold / 5n, tokensOnDex: onDex, poolId: null });
    const l = supplyLedger({ config: c }, result(c, sold, { liquidity: liq }));
    expect(l.pool).toBe(onDex);
    expect(l.burnPool).toBe(POOL_TOKENS - onDex);
    expect(l.gap).toBe(0n);
    expect(sumParts(l)).toBe(TOTAL);
  });

  it("abandoned and unsure: all of the pool's tokens are held until the exchange is read", () => {
    const c = withPool();
    const sold = SALE / 2n;
    const liq = liquidity({ stage: "abandoned", tokens: sold / 5n, nextStep: "reconcile", inFlight: null });
    const l = supplyLedger({ config: c }, result(c, sold, { liquidity: liq }));
    expect(l.pool).toBe(sold / 5n);
    expect(l.gap).toBe(0n);
  });

  it("skipped pool: the whole reserve burns", () => {
    const c = withPool();
    const sold = SALE / 10n;
    const liq = liquidity({ stage: "skipped", poolId: null });
    const l = supplyLedger({ config: c }, result(c, sold, { liquidity: liq }));
    expect(l.pool).toBe(0n);
    expect(l.burnPool).toBe(POOL_TOKENS);
    expect(l.gap).toBe(0n);
    expect(sumParts(l)).toBe(TOTAL);
  });

  it("reports a gap when the views disagree", () => {
    const c = config({ lpReserve: 0n, creatorAllocation: TOTAL - SALE });
    const l = supplyLedger({ config: c }, { ...result(c, SALE / 2n), unsold: SALE / 2n - 3n });
    expect(l.gap).toBe(-3n);
  });
});

describe("burnStateOf", () => {
  const base = { unsold: 5n, liquidity: null };
  it("none when nothing is left to burn", () => {
    expect(burnStateOf({ ...base, unsold: 0n, proceeds: unpaid })).toBe("none");
  });
  it("unknown without proceeds flags", () => {
    expect(burnStateOf({ ...base, proceeds: undefined })).toBe("unknown");
  });
  it("burned once the payout burned it", () => {
    expect(burnStateOf({ ...base, proceeds: paid })).toBe("burned");
  });
  it("owed before the payout", () => {
    expect(burnStateOf({ ...base, proceeds: unpaid })).toBe("owed");
  });
  it("partial when more is owed after an abandoned pool and an earlier payout", () => {
    const proceeds = { ...paid, unsoldBurned: false };
    expect(burnStateOf({ ...base, proceeds, liquidity: liquidity({ stage: "abandoned" }) })).toBe("partial");
    expect(burnStateOf({ ...base, proceeds, liquidity: liquidity({ stage: "seeded" }) })).toBe("owed");
  });
});

describe("poolLeftover", () => {
  it("names the pool's part of the burn by stage", () => {
    expect(poolLeftover(liquidity({ stage: "seeded" }))).toBe("left over in the pool reserve");
    expect(poolLeftover(liquidity({ stage: "seeding" }))).toBe("left over in the pool reserve");
    expect(poolLeftover(liquidity({ stage: "abandoned" }))).toBe("reserved for the abandoned pool");
    expect(poolLeftover(liquidity({ stage: "skipped" }))).toBe("reserved for the skipped pool");
    expect(poolLeftover(liquidity({ stage: "cancelled" }))).toBe("reserved for the launch pool");
    expect(poolLeftover(null)).toBe("reserved for the launch pool");
  });
});

describe("share and shareStr", () => {
  it("formats shares for labels", () => {
    expect(share(1n, 3n)).toBe(0.333333);
    expect(share(1n, 0n)).toBe(0);
    expect(shareStr(0)).toBe("0%");
    expect(shareStr(0.0004)).toBe("<0.1%");
    expect(shareStr(0.042)).toBe("4.2%");
    expect(shareStr(0.4)).toBe("40%");
    expect(shareStr(0.9996)).toBe(">99.9%");
    expect(shareStr(1)).toBe("100%");
  });
});

// ---------- scorecard ----------

let idx = 0;
function fill(tokens: number, priceUsdc: number, tag?: ResultFill["tag"]): ResultFill {
  const t = T(tokens);
  const spent = (BigInt(Math.round(priceUsdc * 1_000_000)) * t) / ONE;
  return {
    index: idx++,
    bidder: `b${idx}.test`,
    deposit: spent + USDC,
    tokens: t,
    spent,
    refund: USDC,
    valid: true,
    claimed: false,
    claimTx: null,
    tag,
  };
}
const loser = (tag?: ResultFill["tag"]): ResultFill => ({ ...fill(0, 0, tag), refund: 5n * USDC, deposit: 5n * USDC });

describe("giniOf", () => {
  it("is 0 when everyone holds the same and for fewer than two holders", () => {
    expect(giniOf([5n, 5n, 5n, 5n])).toBe(0);
    expect(giniOf([7n])).toBe(0);
    expect(giniOf([])).toBe(0);
  });
  it("matches the textbook value", () => {
    // Values 1, 2, 3, 4: G = (2 * 30) / (4 * 10) - 5/4 = 0.25
    expect(giniOf([4n, 1n, 3n, 2n])).toBe(0.25);
    // One holder of two takes everything but one unit: close to 0.5 = (n - 1) / n.
    expect(giniOf([1n, 10n ** 30n])).toBeCloseTo(0.5, 5);
  });
  it("ignores zero holdings", () => {
    expect(giniOf([0n, 0n, 4n, 1n, 3n, 2n])).toBe(0.25);
  });
});

describe("scorecard", () => {
  it("one clearing price, with demo roles: bots pay what people pay and make nothing reselling", () => {
    const fills = [
      fill(100, 0.002, "bot"),
      fill(300, 0.002, "bot"),
      fill(200, 0.002),
      fill(200, 0.002, "you"),
      fill(200, 0.002),
      loser("bot"),
      loser(),
    ];
    const card = scorecard(fills, 18);
    expect(card.rolesKnown).toBe(true);
    expect(card.bids).toBe(7);
    expect(card.botBids).toBe(3);
    expect(card.winners).toBe(5);
    expect(card.botShare).toBe(0.4); // 400 of 1,000
    expect(card.premium).toBe(1);
    expect(card.botProfit).toBe(0n);
    expect(card.bounded).toBe(false);
    expect(card.top10).toBe(1);
    // Holdings 100, 200, 200, 200, 300: G = 2 * (100 + 400 + 600 + 800 + 1500) / (5 * 1000) - 6/5 = 0.16
    expect(card.gini).toBe(0.16);
  });

  it("pay-as-bid prices: bots buy cheap and profit at the people's median price", () => {
    // Bots paid 0.001 per token, people 0.002, 0.003 and 0.004 (median 0.003).
    const fills = [fill(1_000, 0.001, "bot"), fill(10, 0.002), fill(10, 0.003, "sim"), fill(10, 0.004)];
    const card = scorecard(fills, 18);
    expect(card.botShare).toBe(share(T(1_000), T(1_030)));
    expect(card.premium).toBe(3);
    // 1,000 tokens resold at 0.003 = 3 USDC, bought for 1 USDC.
    expect(card.botProfit).toBe(2n * USDC);
  });

  it("no bot won: no profit and no premium", () => {
    const card = scorecard([fill(10, 0.002), fill(10, 0.002), loser("bot")], 18);
    expect(card.botShare).toBe(0);
    expect(card.botProfit).toBe(0n);
    expect(card.premium).toBeNull();
  });

  it("without roles (a real contract): role-free bounds only", () => {
    const fills = [fill(500, 0.002), fill(300, 0.002), fill(200, 0.002), loser()];
    const card = scorecard(fills, 18);
    expect(card.rolesKnown).toBe(false);
    expect(card.botBids).toBe(0);
    expect(card.botShare).toBeNull();
    expect(card.premium).toBe(1);
    expect(card.botProfit).toBe(0n);
    expect(card.bounded).toBe(true);
  });

  it("without roles, uneven prices bound what anyone could make", () => {
    const card = scorecard([fill(100, 0.001), fill(100, 0.002)], 18);
    expect(card.premium).toBe(2);
    // 200 tokens at the top price 0.002 = 0.4 USDC, all spent 0.3 USDC.
    expect(card.botProfit).toBe(100_000n);
  });

  it("top 10 share counts only the ten largest winners", () => {
    const fills = [...Array.from({ length: 10 }, () => fill(10, 0.002)), ...Array.from({ length: 10 }, () => fill(1, 0.002))];
    expect(scorecard(fills, 18).top10).toBe(share(T(100), T(110)));
  });

  it("nobody won", () => {
    const card = scorecard([loser(), loser()], 18);
    expect(card.winners).toBe(0);
    expect(card.premium).toBeNull();
    expect(card.botProfit).toBeNull();
    expect(card.top10).toBe(0);
  });
});

describe("scoreRows", () => {
  const m = (botShare: number, premium: number, botProfit: number, gini: number) =>
    ({ botShare: { mean: botShare }, premium: { mean: premium }, botProfit: { mean: botProfit }, gini: { mean: gini } }) as never;
  const sims: SimSummary = {
    fairground: m(0.157, 1, 0, 0.5),
    bonding_curve: m(0.345, 2.61, 1268.6, 0.52),
    fixed_price: m(0.209, 1, 177.2, 0.5),
  } as SimSummary;

  it("formats this sale beside the simulated averages", () => {
    const card = scorecard([fill(100, 0.002, "bot"), fill(700, 0.002), fill(200, 0.002)], 18);
    const rows = scoreRows(card, sims);
    expect(rows.map((r) => r.id)).toEqual(["botShare", "premium", "botProfit", "top10", "gini"]);
    expect(rows[0]).toMatchObject({ sale: "10.0%", sims: { fairground: "15.7%", bonding_curve: "34.5%", fixed_price: "20.9%" } });
    expect(rows[1]).toMatchObject({ sale: "1.00×", sims: { bonding_curve: "2.61×" } });
    expect(rows[2]).toMatchObject({ sale: "0 USDC", sims: { fairground: "0 USDC", bonding_curve: "1,269 USDC", fixed_price: "177 USDC" } });
    expect(rows[3]).toMatchObject({ sale: "100.0%", sims: null });
    expect(rows[4].sims).toEqual({ fairground: "0.50", bonding_curve: "0.52", fixed_price: "0.50" });
  });

  it("marks role-free bounds and says the bots' share is not on chain", () => {
    const rows = scoreRows(scorecard([fill(100, 0.002), fill(100, 0.002)], 18), sims);
    expect(rows[0].sale).toBe("Not on chain");
    expect(rows[1].sale).toBe("≤ 1.00×");
    expect(rows[2].sale.startsWith("≤ 0")).toBe(true);
  });

  it("reads the committed Arena report", () => {
    const rows = scoreRows(scorecard([fill(1, 0.002, "bot")], 18), report.summary as SimSummary);
    for (const r of rows.filter((x) => x.sims)) {
      for (const v of Object.values(r.sims!)) expect(v).not.toMatch(/NaN|undefined/);
    }
  });
});

// ---------- trading ----------

describe("tradeState and rheaHome", () => {
  it("knows Rhea's apps", () => {
    expect(rheaHome("ref-finance-101.testnet")).toBe("https://testnet.rhea.finance");
    expect(rheaHome("v2.ref-finance.near")).toBe("https://app.rhea.finance");
    expect(rheaHome("dex.test")).toBeNull();
  });

  it("a seeded pool on a real chain links its own pool page", () => {
    expect(tradeState(liquidity({ stage: "seeded", poolId: 7 }))).toEqual({
      kind: "open",
      href: "https://testnet.rhea.finance/pool/7",
      venue: "Rhea",
      poolId: 7,
      simulated: false,
    });
  });

  it("a simulated pool never links a pool id: Rhea's home page only", () => {
    const t = tradeState(liquidity({ stage: "seeded", poolId: 3, simulated: true }));
    expect(t).toMatchObject({ kind: "open", href: "https://testnet.rhea.finance", simulated: true });
    expect(t.kind === "open" && t.href).not.toContain("/pool/");
  });

  it("an unknown exchange has no venue name", () => {
    const t = tradeState(liquidity({ stage: "seeded", dex: "dex.test", poolId: 1 }));
    expect(t).toMatchObject({ kind: "open", venue: null });
  });

  it("trading opens once seeded", () => {
    expect(tradeState(liquidity({ stage: "seeding" }))).toEqual({ kind: "soon" });
    expect(tradeState(liquidity({ stage: "waiting" }))).toEqual({ kind: "soon" });
  });

  it("no Sealround pool otherwise", () => {
    expect(tradeState(null)).toEqual({ kind: "none", why: "no_pool" });
    expect(tradeState(undefined)).toEqual({ kind: "none", why: "no_pool" });
    for (const stage of ["skipped", "cancelled", "abandoned"] as const) {
      expect(tradeState(liquidity({ stage }))).toEqual({ kind: "none", why: stage });
    }
  });
});
