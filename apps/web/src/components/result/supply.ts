/**
 * Pure helpers for the supply story on the result page: where every token of
 * the supply went, the burn, the fair-launch scorecard and the hand-off to
 * trading. All token and USDC amounts stay bigint; floats appear only for
 * shares and ratios.
 *
 * The accounting follows the contract (sale.rs `unsold`, `creator_allocation`,
 * liquidity.rs `tokens_kept`):
 *
 *   total supply = sold to winners + launch pool + creator allocation + burned
 *
 * where "burned" is get_result `unsold`: the sale supply nobody bought (all of
 * it on a failed sale) plus the launch pool reserve the pool does not take.
 * The simulated chain also sets aside an LP reserve for sales without a launch
 * pool; a contract has none (its creator allocation is everything that is not
 * for sale or for the pool), so that part is zero on NEAR.
 */

import type { LaunchType, MetricId } from "@fairground/arena";
import { usdcStr } from "@/lib/format";
import { isRhea, poolUrl, unsure } from "@/lib/liquidity";
import type { LiquidityState, Sale, SaleResult } from "@/lib/types";
import { isBot, rolesKnown, type ResultFill } from "./compute";

// ---------- where every token went ----------

/** The parts of the supply, in the one order every view of them uses. */
export const SUPPLY_PARTS = ["sold", "pool", "creator", "reserve", "burned"] as const;
export type SupplyPartId = (typeof SUPPLY_PARTS)[number];

/**
 * burned: claim_proceeds has burned all of it. owed: none of it is burned yet.
 * partial: more is owed, and an earlier creator payout may have burned part
 * of it (an abandoned pool adds its tokens to the burn after the first
 * payout); the views say only that something is still owed. unknown: the
 * result carries no payout flags. none: nothing to burn.
 */
export type BurnState = "burned" | "owed" | "partial" | "unknown" | "none";

export type SupplyLedger = {
  /** Minted at creation (get_sale total_supply). */
  total: bigint;
  /** Bought by the winners (get_result total_sold; 0 on a failed sale). */
  sold: bigint;
  /** Kept for the launch pool: in it, being seeded, or still on the exchange after it was abandoned. */
  pool: bigint;
  creator: bigint;
  /** The simulated chain's LP reserve of a sale without a launch pool. 0 on NEAR. */
  reserve: bigint;
  /** Burned or to be burned at claim_proceeds (get_result unsold). */
  burn: bigint;
  /** Of `burn`: the sale supply nobody bought. */
  burnUnsold: bigint;
  /** Of `burn`: the launch pool reserve the pool does not take. */
  burnPool: bigint;
  /** The supply once the burn has landed. */
  after: bigint;
  /** sold + pool + creator + reserve + burn - total, in base units. 0 when the views add up. */
  gap: bigint;
  burnState: BurnState;
  /** The token's total supply now, when the views say it: null while part of the burn may have landed. */
  supplyNow: bigint | null;
  /** The sale tokens stay in the contract while the launch pool waits to be seeded. */
  locked: boolean;
};

/**
 * Sale tokens the launch pool keeps out of the burn (liquidity.rs
 * `tokens_kept`): its tokens while it is being seeded or once seeded, and
 * after abandonment what is still on the exchange (all of the pool's tokens
 * while the exchange is read again).
 */
export function poolTokensKept(l: LiquidityState | null | undefined): bigint {
  if (!l) return 0n;
  if (l.stage === "seeding" || l.stage === "seeded") return l.tokens;
  if (l.stage === "abandoned") return unsure(l) ? l.tokens : l.tokensOnDex;
  return 0n;
}

/** The burn's state from the payout flags. */
export function burnStateOf(result: Pick<SaleResult, "unsold" | "proceeds" | "liquidity">): BurnState {
  if (result.unsold <= 0n) return "none";
  const p = result.proceeds;
  if (!p) return "unknown";
  if (p.unsoldBurned) return "burned";
  // The first payout always settles the reserve flag; after it, more to burn means the pool was abandoned later
  // (or a burn failed and is owed again). Either way the views cannot say how much already burned.
  if (p.reserveReturned && result.liquidity?.stage === "abandoned") return "partial";
  return "owed";
}

/** Where every token of the supply went, from the views. */
export function supplyLedger(
  sale: Pick<Sale, "config">,
  result: Pick<SaleResult, "status" | "totalSold" | "unsold" | "proceeds" | "liquidity">,
): SupplyLedger {
  const c = sale.config;
  const settled = result.status === "settled";
  const sold = settled ? result.totalSold : 0n;
  const pool = c.liquidity ? poolTokensKept(result.liquidity) : 0n;
  const reserve = c.liquidity ? 0n : c.lpReserve;
  const creator = c.creatorAllocation;
  const burn = result.unsold;
  const saleLeft = c.saleSupply - sold;
  const burnUnsold = burn < saleLeft ? burn : saleLeft;
  const burnPool = burn - burnUnsold;
  const burnState = burnStateOf(result);
  const after = c.totalSupply - burn;
  return {
    total: c.totalSupply,
    sold,
    pool,
    creator,
    reserve,
    burn,
    burnUnsold,
    burnPool,
    after,
    gap: sold + pool + creator + reserve + burn - c.totalSupply,
    burnState,
    supplyNow: burnState === "burned" || burnState === "none" ? after : burnState === "owed" ? c.totalSupply : null,
    locked: !!result.liquidity && (result.liquidity.stage === "waiting" || result.liquidity.stage === "seeding"),
  };
}

/**
 * What the pool's part of the burn is, after "the N SYM": the reserve a seeded
 * pool did not need, or the reserve of a pool that never opened.
 */
export function poolLeftover(l: LiquidityState | null | undefined): string {
  switch (l?.stage) {
    case "seeding":
    case "seeded":
      return "left over in the pool reserve";
    case "abandoned":
      return "reserved for the abandoned pool";
    case "skipped":
      return "reserved for the skipped pool";
    default:
      return "reserved for the launch pool";
  }
}

/** The ledger's parts in the fixed order, without the empty ones. */
export function supplyParts(l: SupplyLedger): { id: SupplyPartId; amount: bigint }[] {
  const amounts: Record<SupplyPartId, bigint> = {
    sold: l.sold,
    pool: l.pool,
    creator: l.creator,
    reserve: l.reserve,
    burned: l.burn,
  };
  return SUPPLY_PARTS.map((id) => ({ id, amount: amounts[id] })).filter((p) => p.amount > 0n);
}

/** a / b as a fraction (0 to 1), to six decimals. 0 when b is 0. */
export function share(a: bigint, b: bigint): number {
  if (b <= 0n) return 0;
  return Number((a * 1_000_000n) / b) / 1_000_000;
}

/** A share as a percentage for a label: "15%", "4.2%", "<0.1%", "0%". */
export function shareStr(f: number): string {
  const p = f * 100;
  if (p === 0) return "0%";
  if (p < 0.1) return "<0.1%";
  if (p >= 99.95 && p < 100) return ">99.9%";
  return `${p >= 10 ? Math.round(p) : p.toFixed(1)}%`;
}

// ---------- the fair-launch scorecard ----------

export type Scorecard = {
  /** Demo labels say which winners are bots (the simulated chain only). */
  rolesKnown: boolean;
  bids: number;
  /** Bids from accounts labelled bots (0 when roles are not known). */
  botBids: number;
  winners: number;
  /** Bots' tokens / tokens sold. Null when roles are not known. */
  botShare: number | null;
  /**
   * Median price per token people paid / the average price bots paid. With
   * no roles: the highest price per token any winner paid / the lowest, which
   * no group's premium can exceed (`bounded`). Null without a pair to compare.
   */
  premium: number | null;
  /**
   * What bots would make reselling their tokens to people at the median price
   * people paid, USDC base units (never below 0). With no roles: the most any
   * set of winners could make that way at the highest price any winner paid
   * (`bounded`).
   */
  botProfit: bigint | null;
  /** True when premium and botProfit are role-free upper bounds. */
  bounded: boolean;
  /** Share of tokens sold held by the 10 largest winners. */
  top10: number;
  /** Gini of the winners' tokens: 0 even, 1 one holder. */
  gini: number;
};

/** Price per whole token a fill paid, USDC base units (spent / tokens, floored). */
const priceOf = (f: ResultFill, one: bigint): bigint => (f.spent * one) / f.tokens;

function median(xs: bigint[]): bigint | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2n;
}

/** a / b as a float ratio, to six decimals. */
const ratio = (a: bigint, b: bigint): number => Number((a * 1_000_000n) / b) / 1_000_000;

/** Gini coefficient over bigint amounts, exact up to the final division. 0 = even, 1 = one holder. */
export function giniOf(values: bigint[]): number {
  const xs = values.filter((v) => v > 0n).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const n = BigInt(xs.length);
  if (n < 2n) return 0;
  const total = xs.reduce((a, b) => a + b, 0n);
  let weighted = 0n;
  xs.forEach((x, i) => (weighted += BigInt(i + 1) * x));
  // (2 * sum(i * x_i)) / (n * total) - (n + 1) / n, as one fraction.
  const num = 2n * weighted - (n + 1n) * total;
  return Number((num * 1_000_000n) / (n * total)) / 1_000_000;
}

/** This sale's measures for the scorecard, from its (effective) fills. */
export function scorecard(fills: ResultFill[], decimals: number): Scorecard {
  const one = 10n ** BigInt(decimals);
  const known = rolesKnown(fills);
  const winners = fills.filter((f) => f.tokens > 0n);
  const sold = winners.reduce((a, f) => a + f.tokens, 0n);
  const top = [...winners]
    .sort((a, b) => (b.tokens > a.tokens ? 1 : b.tokens < a.tokens ? -1 : 0))
    .slice(0, 10)
    .reduce((a, f) => a + f.tokens, 0n);
  const base = {
    rolesKnown: known,
    bids: fills.length,
    botBids: known ? fills.filter(isBot).length : 0,
    winners: winners.length,
    top10: share(top, sold),
    gini: giniOf(winners.map((f) => f.tokens)),
  };

  if (winners.length === 0) return { ...base, botShare: null, premium: null, botProfit: null, bounded: !known };

  if (!known) {
    const prices = winners.map((f) => priceOf(f, one));
    const max = prices.reduce((a, b) => (b > a ? b : a));
    const min = prices.reduce((a, b) => (b < a ? b : a));
    const spent = winners.reduce((a, f) => a + f.spent, 0n);
    const resale = (sold * max) / one;
    return {
      ...base,
      botShare: null,
      premium: min > 0n ? ratio(max, min) : null,
      botProfit: resale > spent ? resale - spent : 0n,
      bounded: true,
    };
  }

  const bots = winners.filter(isBot);
  const people = winners.filter((f) => !isBot(f));
  const botTokens = bots.reduce((a, f) => a + f.tokens, 0n);
  const botSpent = bots.reduce((a, f) => a + f.spent, 0n);
  const botAvg = botTokens > 0n ? (botSpent * one) / botTokens : null;
  const personMedian = median(people.map((f) => priceOf(f, one)));
  const resale = personMedian !== null ? (botTokens * personMedian) / one : null;
  return {
    ...base,
    botShare: share(botTokens, sold),
    premium: botAvg !== null && botAvg > 0n && personMedian !== null ? ratio(personMedian, botAvg) : null,
    // No bot bought anything: there is nothing to resell, so no profit.
    botProfit: botTokens === 0n ? 0n : resale === null ? null : resale > botSpent ? resale - botSpent : 0n,
    bounded: false,
  };
}

/** The Bot Arena's launch types, in the order the scorecard shows them (Sealround first, as on /arena). */
export const SIM_LAUNCHES = ["fairground", "bonding_curve", "fixed_price"] as const satisfies readonly LaunchType[];

/** The Arena summary the scorecard reads: the mean of each measure per launch type. */
export type SimSummary = Record<LaunchType, Record<MetricId, { mean: number }>>;

export type ScoreMetric = "botShare" | "premium" | "botProfit" | "top10" | "gini";

export type ScoreRow = {
  id: ScoreMetric;
  label: string;
  /** This sale's value, formatted. */
  sale: string;
  /** The simulated averages, formatted; null where the simulation does not measure it. */
  sims: Record<(typeof SIM_LAUNCHES)[number], string> | null;
};

const pct1 = (f: number) => `${(f * 100).toFixed(1)}%`;
const times = (r: number) => `${r.toFixed(2)}×`;
const wholeUsdc = (v: number) => `${(Math.round(v) || 0).toLocaleString("en-US")} USDC`;

/**
 * The scorecard's rows: this sale next to the Arena's simulated averages, on
 * the measures a memecoin buyer cares about. Lower is better on every row.
 * Bounds (no roles on a real contract) carry a "≤".
 */
export function scoreRows(card: Scorecard, sims: SimSummary): ScoreRow[] {
  const sim = (id: MetricId, fmt: (v: number) => string) =>
    Object.fromEntries(SIM_LAUNCHES.map((t) => [t, fmt(sims[t][id].mean)])) as ScoreRow["sims"];
  const bound = card.bounded ? "≤ " : "";
  return [
    {
      id: "botShare",
      label: "Bots' share of tokens sold",
      sale: card.botShare === null ? "Not on chain" : pct1(card.botShare),
      sims: sim("botShare", pct1),
    },
    {
      id: "premium",
      label: "Price people paid over bots",
      sale: card.premium === null ? "–" : `${bound}${times(card.premium)}`,
      sims: sim("premium", times),
    },
    {
      id: "botProfit",
      label: "Bot profit",
      sale: card.botProfit === null ? "–" : `${bound}${usdcStr(card.botProfit)} USDC`,
      sims: sim("botProfit", wholeUsdc),
    },
    { id: "top10", label: "Top 10 holders' share", sale: pct1(card.top10), sims: null },
    { id: "gini", label: "Holder concentration (Gini)", sale: card.gini.toFixed(2), sims: sim("gini", (v) => v.toFixed(2)) },
  ];
}

// ---------- trading ----------

/**
 * Where the sale's tokens trade, if Sealround opened a market for them.
 * - open: the launch pool is seeded. `href` is the pool's page (Rhea) or the
 *   exchange on the explorer; on the simulated chain it is Rhea's home page,
 *   never a pool id that does not exist there (`simulated`).
 * - soon: the pool is being seeded; trading opens once it is.
 * - none: no Sealround pool (no launch liquidity, or it was skipped,
 *   cancelled or abandoned). Making a market is the creator's job.
 */
export type TradeState =
  | { kind: "open"; href: string | null; venue: string | null; poolId: number | null; simulated: boolean }
  | { kind: "soon" }
  | { kind: "none"; why: "no_pool" | "skipped" | "cancelled" | "abandoned" };

/** Rhea's app for an exchange account Rhea runs ("https://testnet.rhea.finance"), else null. */
export function rheaHome(dex: string): string | null {
  if (!isRhea(dex)) return null;
  const url = poolUrl(dex, 0);
  return url ? new URL(url).origin : null;
}

export function tradeState(l: LiquidityState | null | undefined): TradeState {
  if (!l) return { kind: "none", why: "no_pool" };
  switch (l.stage) {
    case "seeded": {
      const venue = isRhea(l.dex) ? "Rhea" : null;
      if (l.simulated) return { kind: "open", href: rheaHome(l.dex), venue, poolId: l.poolId, simulated: true };
      return { kind: "open", href: poolUrl(l.dex, l.poolId), venue, poolId: l.poolId, simulated: false };
    }
    case "waiting":
    case "seeding":
      return { kind: "soon" };
    default:
      return { kind: "none", why: l.stage };
  }
}
