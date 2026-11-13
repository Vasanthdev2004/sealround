/**
 * Launch liquidity in the web app: the pool a sale gets (lib/liquidity.ts),
 * the launch pool section of /create (its model), and the simulated chain's
 * pool from settlement to seeded or abandoned, with the token lock between.
 */
import { poolPriceMatches } from "@fairground/clearing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DRAFT, buildConfig, derive, type Draft } from "@/components/create/model";
import { FairgroundError } from "../client/errors";
import { MOCK_DEX, MockClient, USDC_TOKEN, validateConfig } from "../client/mock";
import { bpsPct, locksTokens, planFor, poolUrl, poolUsdcKept, reserveForSellOut, stepBusy, stepPhrase, unsure } from "../liquidity";
import type { LiquidityState, SaleConfig, SaleMeta } from "../types";

const USDC = 1_000_000n;
const TOKEN = 10n ** 18n;
const META: SaleMeta = { description: "A sale with a launch pool.", hue: 200 };
const MAKER = "maker.testnet";
const ALICE = "alice.testnet";
const CAROL = "carol.testnet";

/** 100k tokens for sale at 0.001 USDC, 20k reserved for a pool with 20 % of the raise. */
function poolConfig(over: Partial<SaleConfig> = {}): SaleConfig {
  const now = Date.now();
  return {
    tokenName: "Pool Test",
    tokenSymbol: "POOL",
    decimals: 18,
    totalSupply: 1_000_000n * TOKEN,
    saleSupply: 100_000n * TOKEN,
    creatorAllocation: 880_000n * TOKEN,
    lpReserve: 20_000n * TOKEN,
    floorPrice: 1000n,
    maxPrice: null,
    minRaise: USDC,
    bidStart: now,
    bidEnd: now + 60_000,
    minDeposit: USDC,
    maxDepositPerAccount: 10n * USDC,
    revealMode: "tee",
    unsoldRule: "burn",
    settleTimeoutMs: 2 * 3_600_000,
    quoteToken: USDC_TOKEN,
    liquidity: { dex: MOCK_DEX, raiseShareBps: 2000, poolTokens: 20_000n * TOKEN, feeBps: 30 },
    ...over,
  };
}

async function failure(p: Promise<unknown>): Promise<FairgroundError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof FairgroundError) return e;
    throw e;
  }
  throw new Error("expected the call to be refused");
}

async function until(check: () => Promise<boolean>, ms = 8000): Promise<void> {
  const deadline = performance.now() + ms;
  while (!(await check())) {
    if (performance.now() > deadline) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** A settled pool sale: Alice spends her whole 5 USDC, Carol 3 USDC with 33 base units left over. */
async function settledPoolSale(symbol: string) {
  vi.useFakeTimers({ toFake: ["Date"] });
  const t0 = Date.now();
  const client = new MockClient();
  await client.ready();
  const sale = await client.createSale(MAKER, poolConfig({ tokenSymbol: symbol }), META);
  for (const who of [ALICE, CAROL]) await client.faucet(who, 100n * USDC);
  await client.bid(sale.id, ALICE, 5n * USDC, { maxPrice: 2000n, maxSpend: 5n * USDC });
  await client.bid(sale.id, CAROL, 3n * USDC + 33n, { maxPrice: 1500n, maxSpend: 3n * USDC });
  vi.setSystemTime(t0 + 61_000);
  await client.closeSale(sale.id, CAROL);
  await until(async () => (await client.getSale(sale.id))!.status === "settled");
  return { client, id: sale.id, t0 };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the pool a sale gets", () => {
  it("is the share of the raise at the clearing price, capped by the reserve", () => {
    const c = poolConfig();
    // 20 % of 8 USDC buys 1,600 tokens at 0.001.
    expect(planFor(c, 8n * USDC, 1000n)).toEqual({ usdc: 1_600_000n, tokens: 1600n * TOKEN });
    // At a higher price the same share buys fewer tokens; a sell-out still takes 20 % of the tokens sold.
    expect(planFor(c, 10n * USDC, 2000n)).toEqual({ usdc: 2_000_000n, tokens: 1000n * TOKEN });
    // A small reserve caps the tokens, and the USDC follows them.
    const small = poolConfig({ liquidity: { dex: MOCK_DEX, raiseShareBps: 2000, poolTokens: 500n * TOKEN, feeBps: 30 } });
    expect(planFor(small, 8n * USDC, 1000n)).toEqual({ usdc: 500_000n, tokens: 500n * TOKEN });
    expect(planFor(poolConfig({ liquidity: null }), 8n * USDC, 1000n)).toEqual({ usdc: 0n, tokens: 0n });
    for (const raise of [8n * USDC, 10n * USDC + 7n]) {
      const p = planFor(c, raise, 1000n);
      expect(poolPriceMatches(p.usdc, p.tokens, 1000n, 18)).toBe(true);
    }
    // A sell-out of 100k tokens fills 20k of reserve, at any price.
    expect(reserveForSellOut(100_000n * TOKEN, 1000n, 18, 2000)).toBe(20_000n * TOKEN);
    expect(reserveForSellOut(100_000n * TOKEN, 7_777n, 18, 2000)).toBeLessThanOrEqual(20_000n * TOKEN);
    expect(reserveForSellOut(0n, 1000n, 18, 2000)).toBe(0n);
  });

  it("links to Rhea for the two known exchanges and says the share plainly", () => {
    expect(poolUrl("ref-finance-101.testnet", 42)).toBe("https://testnet.rhea.finance/pool/42");
    expect(poolUrl("v2.ref-finance.near", 7)).toBe("https://app.rhea.finance/pool/7");
    // A no-break space keeps the sign with its number.
    expect(bpsPct(2000)).toBe("20 %");
    expect(bpsPct(30)).toBe("0.3 %");
    expect(bpsPct(5)).toBe("0.05 %");
    expect(stepPhrase("deposit")).toBe("deposit USDC and tokens");
    const l = (stage: LiquidityState["stage"]): LiquidityState => ({
      stage,
      nextStep: null,
      inFlight: null,
      dex: MOCK_DEX,
      poolId: 1,
      usdc: 5n,
      tokens: 7n,
      shares: 0n,
      usdcOnDex: 2n,
      tokensOnDex: 0n,
      failures: 0,
      deadline: null,
    });
    expect(["waiting", "seeding"].map((s) => locksTokens(l(s as LiquidityState["stage"])))).toEqual([true, true]);
    expect(["seeded", "skipped", "cancelled", "abandoned"].some((s) => locksTokens(l(s as LiquidityState["stage"])))).toBe(false);
    expect([l("seeding"), l("seeded"), l("abandoned"), l("skipped")].map(poolUsdcKept)).toEqual([5n, 5n, 2n, 0n]);

    // A step whose answer never came no longer blocks: the next call gives it up and reads the exchange.
    const stale: LiquidityState = { ...l("seeding"), inFlight: "deposit", nextStep: "reconcile" };
    expect([stepBusy(stale), unsure(stale)]).toEqual([false, false]);
    expect(stepBusy({ ...stale, nextStep: null })).toBe(true);
    // Until the exchange is read again, an abandoned pool keeps all of its USDC from the creator.
    const reading: LiquidityState = { ...l("abandoned"), nextStep: "reconcile" };
    expect([stepBusy(reading), unsure(reading), poolUsdcKept(reading)]).toEqual([false, true, 5n]);
    expect(stepPhrase("reconcile")).toBe("read the exchange again");
  });
});

describe("the launch pool section of /create", () => {
  const draft = (over: Partial<Draft> = {}): Draft => ({ ...DEFAULT_DRAFT, name: "Pool Test", symbol: "POOLX", ...over });

  it("shows only when the contract takes launch liquidity, and reserves the rest of the supply", () => {
    const now = Date.now();
    expect(derive(draft({ poolOn: true }), new Set(), now).pool).toBeNull();
    expect(derive(draft({ poolOn: true }), new Set(), now).poolAvailable).toBe(false);
    expect(derive(draft(), new Set(), now, { pool: true }).pool).toBeNull();

    // 1M supply, 600k for sale, 100k to the creator: 300k for the pool, which takes at most 20 % of 600k.
    const d = derive(draft({ poolOn: true }), new Set(), now, { pool: true });
    expect(d.pool).toMatchObject({ shareBps: 2000, feeBps: 30, reserve: 300_000n * TOKEN, sellOut: 120_000n * TOKEN });
    expect(d.pool?.atFloor).toEqual({ usdc: 120_000_000n, tokens: 120_000n * TOKEN });
    expect(d.notices.find((n) => n.id === "pool-burn")?.text).toMatch(/other 180,000 are burned/);
    expect(d.ready?.pool).toEqual({ shareBps: 2000, feeBps: 30, tokens: 300_000n * TOKEN });

    const config = buildConfig(draft({ poolOn: true }), d.ready!, now, USDC_TOKEN, MOCK_DEX);
    expect(config.liquidity).toEqual({ dex: MOCK_DEX, raiseShareBps: 2000, poolTokens: 300_000n * TOKEN, feeBps: 30 });
    expect(config.lpReserve).toBe(300_000n * TOKEN);
    expect(() => validateConfig(config)).not.toThrow();
    // No exchange: no pool, whatever the form says.
    expect(buildConfig(draft({ poolOn: true }), d.ready!, now, USDC_TOKEN, null).liquidity).toBeUndefined();
  });

  it("refuses a share above 50 % and a pool with no reserve, and warns when a sell-out needs more", () => {
    const now = Date.now();
    for (const share of ["0", "50.5", "abc"]) {
      const d = derive(draft({ poolOn: true, poolShare: share }), new Set(), now, { pool: true });
      expect(d.errors.poolShare?.msg).toBe("Between 0.01 % and 50 % of the raise.");
      expect(d.ready).toBeNull();
    }
    expect(derive(draft({ poolOn: true, poolShare: "50" }), new Set(), now, { pool: true }).errors.poolShare).toBeUndefined();
    const none = derive(draft({ poolOn: true, creatorAllocation: "400,000" }), new Set(), now, { pool: true });
    expect(none.errors.poolTokens?.msg).toMatch(/Nothing is left for the pool/);
    const short = derive(draft({ poolOn: true, creatorAllocation: "350,000" }), new Set(), now, { pool: true });
    expect(short.notices.some((n) => n.id === "pool-short")).toBe(true);
    expect(short.ready?.pool?.tokens).toBe(50_000n * TOKEN);
  });

  it("follows the contract's limits in the simulated chain's validation", () => {
    const bad = (liquidity: Partial<NonNullable<SaleConfig["liquidity"]>>) => () =>
      validateConfig(poolConfig({ liquidity: { ...poolConfig().liquidity!, ...liquidity } }));
    expect(bad({ raiseShareBps: 0 })).toThrow(/raise_share_bps/);
    expect(bad({ raiseShareBps: 5001 })).toThrow(/raise_share_bps/);
    expect(bad({ feeBps: 0 })).toThrow(/fee_bps/);
    expect(bad({ feeBps: 1001 })).toThrow(/fee_bps/);
    expect(bad({ poolTokens: 0n })).toThrow(/pool_tokens/);
    expect(bad({ poolTokens: 10_000n * TOKEN })).toThrow(/must be the LP reserve/);
    expect(bad({})).not.toThrow();
  });
});

describe("a simulated sale with a launch pool", () => {
  it("locks the tokens until the pool is seeded, then pays everyone", async () => {
    const { client, id } = await settledPoolSale("POOL1");
    const result = (await client.getResult(id))!;
    expect(result).toMatchObject({ clearingPrice: 1000n, totalRaised: 8n * USDC, totalSold: 8000n * TOKEN });
    expect(result.liquidity).toMatchObject({
      stage: "seeding",
      nextStep: "register",
      inFlight: null,
      dex: MOCK_DEX,
      poolId: null,
      usdc: 1_600_000n,
      tokens: 1600n * TOKEN,
      simulated: true,
    });
    const sale = (await client.getSale(id))!;
    expect(result.liquidity?.deadline).toBe(sale.settledAt! + sale.config.settleTimeoutMs);
    // Burned at payout: the unsold sale supply and the reserve the pool does not take.
    expect(result.unsold).toBe((92_000n + 18_400n) * TOKEN);
    expect(result.proceeds?.allocationLocked).toBe(true);

    // Claims pay the unspent USDC only, once; a winner with nothing else waits.
    expect(await failure(client.claim(id, ALICE))).toMatchObject({ code: "invalid", reason: "liquidity_pending" });
    const before = (await client.getBalances(CAROL)).usdc;
    expect(await client.claim(id, CAROL)).toMatchObject({ tokens: 0n, refund: 33n });
    expect((await client.getBalances(CAROL)).usdc).toBe(before + 33n);
    expect((await client.getBalances(CAROL)).tokens[id] ?? 0n).toBe(0n);
    expect(await failure(client.claim(id, CAROL))).toMatchObject({ reason: "liquidity_pending" });
    expect((await client.getResult(id))!.fills[1]).toMatchObject({ claimed: false, refundClaimed: true });
    expect((await client.getEvents(id)).some((e) => e.detail === "refund_claimed" && e.account === CAROL)).toBe(true);

    // The creator gets the raise less the pool's USDC; the allocation waits.
    await client.claimProceeds(id, ALICE);
    expect((await client.getBalances(MAKER)).usdc).toBe(8n * USDC - 1_600_000n);
    expect((await client.getResult(id))!.proceeds).toMatchObject({ raisePaid: true, allocationLocked: true });
    expect(await failure(client.claimProceeds(id, ALICE))).toMatchObject({ reason: "liquidity_pending" });

    // Too early to abandon. Anyone seeds: all four steps in one call.
    expect(await failure(client.abandonLiquidity(id, ALICE))).toMatchObject({ reason: "too_early" });
    const seeded = await client.seedLiquidity(id, "anyone.testnet");
    expect(seeded.relay).toMatchObject({ paidBy: "user", simulated: true });
    expect(seeded.liquidity).toMatchObject({ stage: "seeded", nextStep: null, inFlight: null, shares: 10n ** 24n });
    expect(seeded.liquidity.poolId).toBeGreaterThanOrEqual(1000);
    const pool = (await client.getPool(id))!;
    expect(pool).toMatchObject({ dex: MOCK_DEX, amounts: [1600n * TOKEN, 1_600_000n], contractShares: 10n ** 24n, simulated: true });
    expect(pool.tokenIds).toEqual([sale.tokenAccount, USDC_TOKEN]);
    expect(poolPriceMatches(pool.amounts[1], pool.amounts[0], 1000n, 18)).toBe(true);
    expect((await client.getEvents(id)).find((e) => e.detail === "liquidity_seeded")?.note).toMatch(/keeps the LP shares/);
    expect(await failure(client.seedLiquidity(id, ALICE))).toMatchObject({ reason: "wrong_stage" });
    expect(await failure(client.abandonLiquidity(id, ALICE))).toMatchObject({ reason: "wrong_stage" });

    // Unlocked: tokens to the winners (Carol's USDC came earlier), the allocation to the creator.
    expect((await client.getResult(id))!.proceeds).toEqual({ raisePaid: true, allocationPaid: false, unsoldBurned: true, reserveReturned: true });
    expect(await client.claim(id, ALICE)).toMatchObject({ tokens: 5000n * TOKEN, refund: 0n });
    expect(await client.claim(id, CAROL)).toMatchObject({ tokens: 3000n * TOKEN, refund: 0n });
    expect((await client.getBalances(CAROL)).usdc).toBe(before + 33n);
    await client.claimProceeds(id, ALICE);
    expect((await client.getResult(id))!.proceeds).toEqual({ raisePaid: true, allocationPaid: true, unsoldBurned: true, reserveReturned: true });
    expect((await client.getBalances(MAKER)).usdc).toBe(8n * USDC - 1_600_000n);
  }, 30_000);

  it("can be abandoned after its deadline: USDC to the creator, the whole reserve burned", async () => {
    const { client, id, t0 } = await settledPoolSale("POOL2");
    await client.claimProceeds(id, ALICE);
    expect((await client.getBalances(MAKER)).usdc).toBe(8n * USDC - 1_600_000n);
    const deadline = (await client.getResult(id))!.liquidity!.deadline!;
    expect(deadline).toBeGreaterThan(t0);

    vi.setSystemTime(deadline);
    expect(await failure(client.seedLiquidity(id, ALICE))).toMatchObject({ reason: "too_late" });
    const r = await client.abandonLiquidity(id, "anyone.testnet");
    expect(r.liquidity).toMatchObject({ stage: "abandoned", usdcOnDex: 0n, tokensOnDex: 0n });
    const result = (await client.getResult(id))!;
    expect(result.unsold).toBe((92_000n + 20_000n) * TOKEN);
    expect(result.proceeds?.allocationLocked).toBeUndefined();
    expect((await client.getEvents(id)).some((e) => e.detail === "liquidity_abandoned")).toBe(true);
    expect(await failure(client.abandonLiquidity(id, ALICE))).toMatchObject({ reason: "already_done" });

    // The pool's USDC and the allocation follow in the next payout; the tokens unlock at once.
    await client.claimProceeds(id, ALICE);
    expect((await client.getBalances(MAKER)).usdc).toBe(8n * USDC);
    expect((await client.getResult(id))!.proceeds).toEqual({ raisePaid: true, allocationPaid: true, unsoldBurned: true, reserveReturned: true });
    expect(await client.claim(id, ALICE)).toMatchObject({ tokens: 5000n * TOKEN });
  }, 30_000);

  it("is cancelled when the sale fails, and the tokens never lock", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    const client = new MockClient();
    await client.ready();
    const failed = await client.createSale(MAKER, poolConfig({ tokenSymbol: "POOL3" }), META);
    vi.setSystemTime(t0 + 61_000);
    await client.closeSale(failed.id, ALICE);
    const r = (await client.getResult(failed.id))!;
    expect(r.liquidity).toMatchObject({ stage: "cancelled", usdc: 0n, tokens: 0n, deadline: null });
    expect(r.proceeds?.allocationLocked).toBeUndefined();
  }, 30_000);
});
