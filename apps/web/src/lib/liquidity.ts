/**
 * Launch liquidity in the web app: labels, the pool link and the amounts a
 * sale's pool gets. The amounts come from `poolPlan` in @fairground/clearing,
 * the TypeScript twin of the contract's `pool_plan`, so the pages show what
 * the contract will use.
 *
 * The rule in one line: at settlement the pool takes `raiseShareBps` of the
 * raise and buys sale tokens with it at the clearing price, from the reserve.
 * Every winner paid that price, so the pool gets that share of the tokens
 * sold, whatever the price. Reserved tokens the pool does not take are burned.
 */

import { MAX_POOL_FEE_BPS, MAX_RAISE_SHARE_BPS, poolPlan, U128_MAX, type PoolPlan } from "@fairground/clearing";
import { accountUrl } from "./format";
import type { LiquidityStage, LiquidityState, LiquidityStep, SaleConfig } from "./types";

export { MAX_POOL_FEE_BPS, MAX_RAISE_SHARE_BPS };

/** The /create defaults: 20 % of the raise, a 0.3 % pool fee. */
export const DEFAULT_RAISE_SHARE_BPS = 2_000;
export const DEFAULT_POOL_FEE_BPS = 30;

/** The Rhea (formerly Ref Finance) exchanges the app links to, by exchange account. */
const RHEA_APP = new Map([
  ["ref-finance-101.testnet", "https://testnet.rhea.finance"],
  ["v2.ref-finance.near", "https://app.rhea.finance"],
]);

/** True for the two Rhea exchanges the app knows. */
export const isRhea = (dex: string): boolean => RHEA_APP.has(dex);

/**
 * Where to see a pool: its page on Rhea for the two known exchanges, else the
 * exchange account on the block explorer. Null when there is nothing to link
 * to (a sandbox has no explorer).
 */
export function poolUrl(dex: string, poolId: number | null): string | null {
  const app = RHEA_APP.get(dex);
  if (app && poolId !== null) return `${app}/pool/${poolId}`;
  const url = accountUrl(dex);
  return url === "#" ? null : url;
}

export const STAGE_LABEL: Record<LiquidityStage, string> = {
  waiting: "Waiting",
  seeding: "Being seeded",
  seeded: "Seeded",
  skipped: "Skipped",
  cancelled: "Cancelled",
  abandoned: "Abandoned",
};

export const STEP_LABEL: Record<LiquidityStep, string> = {
  register: "Register on the exchange",
  create_pool: "Create the pool",
  deposit: "Deposit USDC and tokens",
  add_liquidity: "Add the liquidity",
  withdraw: "Withdraw from the exchange",
  reconcile: "Read the exchange again",
};

/** A step as the end of a sentence: "deposit USDC and tokens". */
export const stepPhrase = (step: LiquidityStep): string => {
  const label = STEP_LABEL[step];
  return label[0].toLowerCase() + label.slice(1);
};

/** seed_liquidity's steps, in order. */
export const SEED_STEPS: readonly LiquidityStep[] = ["register", "create_pool", "deposit", "add_liquidity"];

/** Sale tokens stay locked while the pool waits for settlement or is being seeded. */
export const locksTokens = (l: Pick<LiquidityState, "stage"> | null | undefined): boolean =>
  !!l && (l.stage === "waiting" || l.stage === "seeding");

/**
 * A step waits for the exchange's answer, so neither method can run. A step
 * that waited too long does not count: the next call gives it up and reads
 * the exchange again (`nextStep` "reconcile").
 */
export const stepBusy = (l: Pick<LiquidityState, "inFlight" | "nextStep">): boolean =>
  l.inFlight !== null && l.nextStep !== "reconcile";

/**
 * The record does not know what is on the exchange until it is read again
 * (liquidity.rs `unsure`): the views show it as a reconcile due with nothing in flight.
 */
export const unsure = (l: Pick<LiquidityState, "inFlight" | "nextStep">): boolean =>
  l.inFlight === null && l.nextStep === "reconcile";

/**
 * USDC of the raise that is not the creator's (liquidity.rs `usdc_kept`): the
 * pool's, or after abandonment what is still on the exchange (all of the
 * pool's share while the exchange is read again).
 */
export function poolUsdcKept(l: LiquidityState | null | undefined): bigint {
  if (!l) return 0n;
  if (l.stage === "seeding" || l.stage === "seeded") return l.usdc;
  if (l.stage === "abandoned") return unsure(l) ? l.usdc : l.usdcOnDex;
  return 0n;
}

/** "20 %" from basis points. */
export function bpsPct(bps: number | bigint): string {
  const n = Number(bps) / 100;
  return `${n.toLocaleString("en-US", { maximumFractionDigits: 2 })} %`;
}

/** The pool a sale gets at `price` (USDC per whole token) when it raises `raise`. */
export function planFor(config: SaleConfig, raise: bigint, price: bigint): PoolPlan {
  const l = config.liquidity;
  if (!l) return { usdc: 0n, tokens: 0n };
  return poolPlan(raise, price, config.decimals, l.raiseShareBps, l.poolTokens);
}

/**
 * Reserve that covers a sell-out: `shareBps` of the sale supply, the most the
 * pool can take (what the share of the raise buys at any clearing price when
 * every token sells). Worked out with poolPlan at `price`, so it carries the
 * contract's rounding.
 */
export function reserveForSellOut(saleSupply: bigint, price: bigint, decimals: number, shareBps: number): bigint {
  if (saleSupply <= 0n || price <= 0n) return 0n;
  const one = 10n ** BigInt(decimals);
  const raise = (saleSupply * price + one - 1n) / one;
  return poolPlan(raise, price, decimals, shareBps, U128_MAX).tokens;
}
