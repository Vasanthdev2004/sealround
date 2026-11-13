/**
 * Launch liquidity: the pool a sale seeds on the Rhea (Ref) exchange at its
 * clearing price. TypeScript twin of contracts/fairground/src/liquidity.rs
 * `pool_plan`, with the same rounding, so the web app shows the amounts the
 * contract will use.
 */

import { U128_MAX } from "./clear";

/** Most of the raise a pool may take: 50 %. */
export const MAX_RAISE_SHARE_BPS = 5_000;
/** Highest pool fee the contract accepts: 10 %. */
export const MAX_POOL_FEE_BPS = 1_000;
const BPS = 10_000n;

/** USDC and sale tokens a launch pool gets. Both zero: no pool. */
export type PoolPlan = { usdc: bigint; tokens: bigint };

const NONE: PoolPlan = { usdc: 0n, tokens: 0n };

/** 10^decimals, or null when it does not fit u128 (the contract's `one_token`). */
function oneTokenU128(decimals: number): bigint | null {
  if (!Number.isInteger(decimals) || decimals < 0) return null;
  const one = 10n ** BigInt(decimals);
  return one > U128_MAX ? null : one;
}

/**
 * The pool's amounts: `shareBps` of the raise, rounded down, buys tokens at
 * the clearing price (rounded down, at most `reserve`), and `usdc` is what
 * those tokens cost at that price, rounded up as a bid's spend is. So
 * `usdc * ONE - tokens * price` is in `[0, ONE)`: the pool's price is the
 * clearing price, at most one USDC base unit above it in total, never below.
 * Zero for both when either amount would be zero.
 *
 * All amounts in base units: `raise` and the result's `usdc` in USDC (6 dp),
 * `price` in USDC per whole token, `reserve` and `tokens` in token base units.
 */
export function poolPlan(raise: bigint, price: bigint, decimals: number, shareBps: number, reserve: bigint): PoolPlan {
  const one = oneTokenU128(decimals);
  if (one === null || raise < 0n || price < 0n || reserve < 0n) return NONE;
  const budget = (raise * BigInt(shareBps)) / BPS;
  // The contract's tokens_for is None for a zero price or a quotient past u128,
  // both far more than any reserve: then the reserve caps it.
  let tokens = reserve;
  if (price > 0n) {
    const bought = (budget * one) / price;
    if (bought <= U128_MAX && bought < reserve) tokens = bought;
  }
  let usdc = (tokens * price + one - 1n) / one;
  if (usdc > U128_MAX) usdc = 0n;
  if (tokens === 0n || usdc === 0n || usdc > budget) return NONE;
  return { usdc, tokens };
}

/**
 * Whether `usdc` for `tokens` is the clearing price `price` the way
 * `poolPlan` sets it: `usdc * ONE - tokens * price` in `[0, ONE)`.
 */
export function poolPriceMatches(usdc: bigint, tokens: bigint, price: bigint, decimals: number): boolean {
  const one = oneTokenU128(decimals);
  if (one === null || tokens <= 0n) return false;
  const excess = usdc * one - tokens * price;
  return excess >= 0n && excess < one;
}

/** A pool's price from its reserves, USDC base units per whole token, rounded down. Null for an empty pool. */
export function poolPrice(usdc: bigint, tokens: bigint, decimals: number): bigint | null {
  const one = oneTokenU128(decimals);
  if (one === null || tokens <= 0n) return null;
  return (usdc * one) / tokens;
}
