/**
 * The token page's figures and its X post: launch price, pool price, supply
 * and burn from the result's ledger, holders, and the share text and link.
 */
import { describe, expect, it } from "vitest";
import type { TradeState } from "@/components/result/supply";
import type { LiquidityState, ProceedsState, SaleConfig, SaleResult } from "@/lib/types";
import { holdersOf, tokenFigures, tokenSharePath, tokenShareText } from "../figures";

const ONE = 10n ** 18n;
const T = (n: number | bigint) => BigInt(n) * ONE;
const USDC = 1_000_000n;

const TOTAL = T(1_000_000);
const FOR_SALE = T(400_000);
const POOL = T(100_000);

function config(over: Partial<SaleConfig> = {}): SaleConfig {
  return {
    tokenName: "Lantern",
    tokenSymbol: "LNTN",
    decimals: 18,
    totalSupply: TOTAL,
    saleSupply: FOR_SALE,
    creatorAllocation: TOTAL - FOR_SALE - POOL,
    lpReserve: POOL,
    floorPrice: 1_000n,
    maxPrice: null,
    minRaise: 0n,
    bidStart: 0,
    bidEnd: 1,
    minDeposit: USDC,
    maxDepositPerAccount: 1_000n * USDC,
    revealMode: "tee",
    unsoldRule: "burn",
    settleTimeoutMs: 1,
    quoteToken: "usdc.test",
    ...over,
  };
}

const withPool = () =>
  config({ liquidity: { dex: "ref-finance-101.testnet", raiseShareBps: 2_000, poolTokens: POOL, feeBps: 30 } });

function liquidity(over: Partial<LiquidityState> = {}): LiquidityState {
  return {
    stage: "seeded",
    nextStep: null,
    inFlight: null,
    dex: "ref-finance-101.testnet",
    poolId: 7,
    usdc: 0n,
    tokens: 0n,
    shares: 10n ** 24n,
    usdcOnDex: 0n,
    tokensOnDex: 0n,
    failures: 0,
    deadline: null,
    ...over,
  };
}

const paid: ProceedsState = { raisePaid: true, allocationPaid: true, unsoldBurned: true, reserveReturned: true };
const unpaid: ProceedsState = { raisePaid: false, allocationPaid: false, unsoldBurned: false, reserveReturned: false };

type R = Pick<SaleResult, "status" | "clearingPrice" | "totalSold" | "totalRaised" | "unsold" | "proceeds" | "liquidity">;

function result(over: Partial<R> = {}): R {
  return {
    status: "settled",
    clearingPrice: 1_956n,
    totalSold: T(300_000),
    totalRaised: 586_800_000n,
    unsold: T(100_000),
    proceeds: paid,
    liquidity: null,
    ...over,
  };
}

describe("tokenFigures", () => {
  it("gives the launch price, the supply after a burn that landed, the burn and the raise", () => {
    const f = tokenFigures({ config: config() }, result(), 41);
    expect(f.launchPrice).toBe(1_956n);
    expect(f.poolPrice).toBeNull();
    expect(f.supply).toEqual({ label: "Supply now", value: TOTAL - T(100_000) });
    expect(f.burn).toEqual({ label: "Burned at launch", value: T(100_000), done: true });
    expect(f.holders).toBe(41);
    expect(f.raised).toBe(586_800_000n);
  });

  it("keeps the whole supply until the burn lands, and says the burn is still to come", () => {
    const f = tokenFigures({ config: config() }, result({ proceeds: unpaid }), 41);
    expect(f.supply).toEqual({ label: "Supply now", value: TOTAL });
    expect(f.burn).toEqual({ label: "To burn", value: T(100_000), done: false });
  });

  it("says the supply after the burn when the views cannot say how much already burned", () => {
    const f = tokenFigures(
      { config: withPool() },
      result({
        proceeds: { ...unpaid, reserveReturned: true },
        liquidity: liquidity({ stage: "abandoned", tokensOnDex: 0n, usdcOnDex: 0n }),
        unsold: T(200_000),
      }),
      41,
    );
    expect(f.supply.label).toBe("Supply after the burn");
    expect(f.supply.value).toBe(TOTAL - T(200_000));
    expect(f.burn.label).toBe("Burned or to burn");
    expect(f.poolPrice).toBeNull();
  });

  it("burns nothing on a sell-out", () => {
    const f = tokenFigures({ config: config() }, result({ totalSold: FOR_SALE, unsold: 0n }), 50);
    expect(f.burn).toEqual({ label: "Burned at launch", value: 0n, done: true });
    expect(f.supply.value).toBe(TOTAL);
  });

  it("gives a seeded pool's opening price from its reserves", () => {
    // 20 % of the raise and the tokens it buys at the clearing price.
    const usdc = 117_360_000n;
    const tokens = (usdc * ONE) / 1_956n;
    const f = tokenFigures(
      { config: withPool() },
      result({ liquidity: liquidity({ usdc, tokens }), unsold: T(100_000) + POOL - tokens }),
      41,
    );
    expect(f.poolPrice).toBe(1_956n);
  });

  it("has no pool price while the pool is being seeded", () => {
    const f = tokenFigures({ config: withPool() }, result({ liquidity: liquidity({ stage: "seeding", usdc: 1n, tokens: 1n }) }), 1);
    expect(f.poolPrice).toBeNull();
  });

  it("counts the winners as holders", () => {
    expect(holdersOf([{ tokens: 1n }, { tokens: 0n }, { tokens: 5n }])).toBe(2);
    expect(holdersOf([])).toBe(0);
  });
});

describe("tokenShareText", () => {
  const sale = { config: config() };
  const none: TradeState = { kind: "none", why: "no_pool" };
  const rhea: TradeState = { kind: "open", href: "https://testnet.rhea.finance/pool/7", venue: "Rhea", poolId: 7, simulated: false };
  const simRhea: TradeState = { ...rhea, href: "https://testnet.rhea.finance", simulated: true };
  const burned = { label: "Burned at launch", value: T(17_600), done: true };

  it("states the price, the winners, the burn and the network", () => {
    const text = tokenShareText(sale, { launchPrice: 1_956n, burn: burned, holders: 41 }, rhea, "testnet");
    expect(text).toBe(
      "$LNTN launched at 0.001956 USDC per token, the one price all 41 winners paid, bots included. 17.6K $LNTN burned. Trading on Rhea. Sealed-bid launch on NEAR testnet.",
    );
  });

  it("says simulated in mock mode and never calls a simulated pool trading", () => {
    const text = tokenShareText(sale, { launchPrice: 1_956n, burn: burned, holders: 41 }, simRhea, "simulated");
    expect(text).toContain("Simulated sealed-bid launch on Sealround.");
    expect(text).not.toContain("Trading");
  });

  it("says a burn still to come, leaves out an empty burn, and words a single winner", () => {
    const owed = tokenShareText(sale, { launchPrice: 1_000n, burn: { ...burned, done: false }, holders: 2 }, none, "mainnet");
    expect(owed).toContain("17.6K $LNTN to burn.");
    expect(owed).toContain("Sealed-bid launch on NEAR.");
    const one = tokenShareText(sale, { launchPrice: 1_000n, burn: { ...burned, value: 0n }, holders: 1 }, none, "sandbox");
    expect(one).toBe("$LNTN launched at 0.001 USDC per token, the clearing price its one winner paid. Sealed-bid launch on a local NEAR sandbox.");
  });

  it("fits a post with its link (X counts a link as 23 characters)", () => {
    const long = { config: config({ tokenSymbol: "ABCDEFGHIJKLMNOP" }) };
    const text = tokenShareText(long, { launchPrice: 123_456_789n, burn: { ...burned, value: T(123_456_789) }, holders: 500 }, rhea, "testnet");
    expect(text.length + 1 + 23).toBeLessThanOrEqual(280);
  });
});

describe("tokenSharePath", () => {
  it("links the token page, or the judge page for a judge-mode sale in the browser that ran it", () => {
    expect(tokenSharePath({ id: "lantern", isJudgeSale: false }, true)).toBe("/token/lantern");
    expect(tokenSharePath({ id: "judge-3", isJudgeSale: true }, true)).toBe("/judge");
    expect(tokenSharePath({ id: "judge-3", isJudgeSale: true }, false)).toBe("/token/judge-3");
  });
});
