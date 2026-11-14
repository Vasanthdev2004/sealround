/**
 * The allocation on /create against what the contract does with it: without a
 * launch pool, sale.rs pays the creator every token not for sale
 * (creator_allocation = total_supply - sale_supply - pool reserve), so the
 * form must not promise an LP reserve there. Mock mode keeps its LP reserve.
 */
import { describe, expect, it } from "vitest";
import { CREATOR_WARN_BPS, DEFAULT_DRAFT, ONE, buildConfig, derive, type Draft } from "./model";

const draft = (over: Partial<Draft> = {}): Draft => ({ ...DEFAULT_DRAFT, name: "Rest Test", symbol: "REST", ...over });
const USDC = "usdc.fakes.testnet";
const DEX = "ref-finance-101.testnet";

describe("allocation on the contract", () => {
  it("gives the creator the whole rest of the supply when no launch pool is on", () => {
    // 1M supply, 600k for sale, 100k typed as the creator's: the contract pays the creator 400k.
    for (const pool of [false, true]) {
      const d = derive(draft(), new Set(), null, { pool, restToCreator: true });
      expect(d.restToCreator).toBe(true);
      expect(d.values).toMatchObject({ creator: 400_000n * ONE, lp: 0n });
      expect(d.shares).toEqual({ sale: 6000n, creator: 4000n, lp: 0n });
      expect(d.errors.creatorAllocation).toBeUndefined();
      // The creator share warning counts what the creator really gets.
      expect(d.shares!.creator).toBeGreaterThan(CREATOR_WARN_BPS);
      expect(d.notices.find((n) => n.id === "creator-share")?.text).toMatch(/You keep 40/);
      const config = buildConfig(draft(), d.ready!, Date.now(), USDC, pool ? DEX : null);
      expect(config).toMatchObject({ creatorAllocation: 400_000n * ONE, lpReserve: 0n });
      expect(config.liquidity).toBeUndefined();
    }
  });

  it("ignores the creator field there, even when it no longer fits", () => {
    const d = derive(draft({ creatorAllocation: "900,000" }), new Set(), null, { restToCreator: true });
    expect(d.errors).not.toHaveProperty("creatorAllocation");
    expect(d.values.creator).toBe(400_000n * ONE);
  });

  it("uses the creator field and reserves the rest for the pool when one is on", () => {
    const d = derive(draft({ poolOn: true }), new Set(), null, { pool: true, restToCreator: true });
    expect(d.restToCreator).toBe(false);
    expect(d.values).toMatchObject({ creator: 100_000n * ONE, lp: 300_000n * ONE });
    expect(d.ready?.pool?.tokens).toBe(300_000n * ONE);
  });
});

describe("allocation in mock mode", () => {
  it("keeps the creator field and the LP reserve", () => {
    const d = derive(draft(), new Set(), null, { pool: true });
    expect(d.restToCreator).toBe(false);
    expect(d.values).toMatchObject({ creator: 100_000n * ONE, lp: 300_000n * ONE });
    expect(d.shares).toEqual({ sale: 6000n, creator: 1000n, lp: 3000n });
    const config = buildConfig(draft(), d.ready!, Date.now(), USDC);
    expect(config).toMatchObject({ creatorAllocation: 100_000n * ONE, lpReserve: 300_000n * ONE });
  });
});
