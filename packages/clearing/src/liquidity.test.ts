/**
 * poolPlan must match the contract's `pool_plan` (contracts/fairground/src/
 * liquidity.rs): the cases of `tests::liquidity::the_pool_price_is_the_clearing_price`,
 * then the same sweep of every combination.
 */
import { describe, expect, it } from "vitest";
import { U128_MAX } from "./clear";
import { poolPlan, poolPrice, poolPriceMatches } from "./liquidity";

const USDC = 1_000_000n;
const TOKEN = 10n ** 18n;
const plan = (usdc: bigint, tokens: bigint) => ({ usdc, tokens });

const mulDivFloor = (a: bigint, b: bigint, d: bigint) => (a * b) / d;
const mulDivCeil = (a: bigint, b: bigint, d: bigint) => (a * b + d - 1n) / d;

describe("poolPlan", () => {
  it("matches the contract's examples", () => {
    // 18 decimals: 100 USDC raised at 0.002 USDC per token, 20 %: 20 USDC buys 10,000 tokens.
    expect(poolPlan(100n * USDC, 2_000n, 18, 2_000, U128_MAX)).toEqual(plan(20n * USDC, 10_000n * TOKEN));
    // The reserve caps the tokens and the USDC shrinks to match.
    expect(poolPlan(100n * USDC, 2_000n, 18, 2_000, 2_500n * TOKEN)).toEqual(plan(5n * USDC, 2_500n * TOKEN));
    // 0 decimals: whole tokens only; 7 USDC at 3 USDC each buys 2 tokens for 6.
    expect(poolPlan(35n * USDC, 3n * USDC, 0, 2_000, 1_000n)).toEqual(plan(6n * USDC, 2n));
    // Too little to buy one base unit, or nothing raised, or no price: no pool.
    expect(poolPlan(35n * USDC, 3n * USDC, 0, 1, 1_000n)).toEqual(plan(0n, 0n));
    expect(poolPlan(0n, 2_000n, 18, 5_000, U128_MAX)).toEqual(plan(0n, 0n));
    expect(poolPlan(100n * USDC, 0n, 18, 5_000, U128_MAX)).toEqual(plan(0n, 0n));
    // Decimals whose 10^d does not fit u128: no pool.
    expect(poolPlan(100n * USDC, 2_000n, 39, 2_000, U128_MAX)).toEqual(plan(0n, 0n));
  });

  it("prices the pool at the clearing price for every combination", () => {
    const raises = [1n, 999n, 1_000_001n, 123_456_789_012n, 10_000n * 500n * USDC, U128_MAX / 3n];
    const prices = [1n, 7n, 1_000n, 999_999n, 3n * USDC, 10n ** 20n];
    const reserves = [1n, 1_000n, 10n ** 18n + 1n, 10n ** 30n, U128_MAX];
    for (const decimals of [0, 6, 18, 24]) {
      const one = 10n ** BigInt(decimals);
      for (const raise of raises) {
        for (const price of prices) {
          for (const share of [1, 2_000, 5_000]) {
            for (const reserve of reserves) {
              const { usdc, tokens } = poolPlan(raise, price, decimals, share, reserve);
              if (tokens === 0n) {
                expect(usdc).toBe(0n);
                continue;
              }
              const budget = mulDivFloor(raise, BigInt(share), 10_000n);
              expect(usdc > 0n && usdc <= budget && tokens <= reserve).toBe(true);
              // usdc = ceil(tokens * price / one).
              expect(usdc).toBe(mulDivCeil(tokens, price, one));
              expect(poolPriceMatches(usdc, tokens, price, decimals)).toBe(true);
              // Below the reserve, one more base unit would not fit the budget.
              if (tokens < reserve) expect(mulDivCeil(tokens + 1n, price, one) > budget).toBe(true);
            }
          }
        }
      }
    }
  });

  it("takes the same share of the tokens sold at any price when the sale sells out", () => {
    // 600,000 tokens sold: 20 % of the raise buys 120,000 of them, at the floor or above.
    for (const price of [1_000n, 2_060n, 7_777n]) {
      const raise = mulDivCeil(600_000n * TOKEN, price, TOKEN);
      expect(poolPlan(raise, price, 18, 2_000, U128_MAX).tokens).toBe(120_000n * TOKEN);
    }
  });
});

describe("pool price helpers", () => {
  it("tell the clearing price from a pool's reserves", () => {
    expect(poolPrice(20n * USDC, 10_000n * TOKEN, 18)).toBe(2_000n);
    expect(poolPrice(1n, 0n, 18)).toBeNull();
    expect(poolPriceMatches(20n * USDC, 10_000n * TOKEN, 2_000n, 18)).toBe(true);
    // One base unit too little USDC puts the pool below the clearing price.
    expect(poolPriceMatches(20n * USDC - 1n, 10_000n * TOKEN, 2_000n, 18)).toBe(false);
    // A whole USDC base unit too much is more than rounding.
    expect(poolPriceMatches(20n * USDC + 1n, 10_000n * TOKEN, 2_000n, 18)).toBe(false);
  });
});
