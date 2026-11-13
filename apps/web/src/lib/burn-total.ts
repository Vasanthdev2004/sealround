/**
 * The burn counter: how much of the supply Sealround launches minted burned
 * because demand did not take it. Pure: it reads sales and their results and
 * never fetches anything.
 *
 * The headline is the average of each launch's own burned share, not a sum
 * of tokens. Every launch mints its own token, with its own decimals and its
 * own supply. Adding base units of different tokens mixes units (a base unit
 * of an 18-decimal token is not a base unit of a 6-decimal one), and even
 * whole tokens do not compare: one launch of a billion tokens would drown out
 * fifty launches of a million. So each launch reports its burn over its own
 * minted supply (exact in its own units up to the final division), and the
 * headline gives every launch one equal vote: the mean of those shares, with
 * the count of launches behind it. The per-launch rows stay in the result so
 * a page can show the spread behind the mean.
 *
 * What counts:
 * - Settled sales are launches. Their burn is the sale supply nobody bought
 *   plus any launch pool reserve the pool did not take (the result page's
 *   ledger, `supplyLedger`), burned at the creator payout. A burn that is
 *   owed but not yet sent is still certain (anyone can send the payout), so
 *   it counts, and the words say "burned or set to burn" while any is owed.
 * - Failed sales are counted apart. Their whole sale supply burns because the
 *   minimum raise was not met. That is a different story from "demand set the
 *   supply", and mixing it in would pull the average up.
 * - Sales whose token was never deployed minted nothing and are left out.
 */

import { burnStateOf, share, shareStr, supplyLedger, type BurnState } from "@/components/result/supply";
import { tokenStr } from "./format";
import type { Sale, SaleResult } from "./types";

/** At most this many final sales are read for the counter, newest first. */
export const BURN_CAP = 20;

/** One final sale's burn, in its own token's units. */
export type LaunchBurn = {
  id: string;
  name: string;
  symbol: string;
  hue: number;
  icon: string | null;
  decimals: number;
  status: "settled" | "failed";
  /** Minted at creation (get_sale total_supply), base units. */
  minted: bigint;
  /** Burned or to burn at the creator payout (get_result unsold), base units. */
  burn: bigint;
  /** The supply once the burn has landed, base units. */
  after: bigint;
  /** burn / minted, 0 to 1. */
  share: number;
  state: BurnState;
  /** The burn has landed, or there is nothing to burn. */
  landed: boolean;
  /** When bidding ended (ms), the order rows are listed in. */
  endedAt: number;
};

export type BurnTotal = {
  /** Settled launches counted. */
  launches: number;
  /** Mean of the settled launches' burn shares (0 to 1); null when there are none. */
  meanShare: number | null;
  /** Settled launches that burn anything. */
  withBurn: number;
  /** Settled launches whose burn is still owed (the creator payout has not burned all of it). */
  owed: number;
  /** Failed sales read (counted apart from the launches). */
  failed: number;
  /** Every sale read, settled and failed, newest first. */
  rows: LaunchBurn[];
  /** Final sales not read because only the newest `BURN_CAP` are. */
  beyondCap: number;
  /** Final sales read whose result could not be loaded. */
  unread: number;
};

/** A sale is final and its token was minted. */
function finalWithToken(s: Sale): boolean {
  if (s.status !== "settled" && s.status !== "failed") return false;
  return !s.tokenSetup || s.tokenSetup === "done";
}

const newestFirst = (a: Sale, b: Sale) => b.config.bidEnd - a.config.bidEnd || b.createdAt - a.createdAt;

/** The final sales with a minted token to read, newest first, at most `cap`; and how many were left out. */
export function finalSales(sales: Sale[], cap = BURN_CAP): { sales: Sale[]; beyond: number } {
  const all = sales.filter(finalWithToken).sort(newestFirst);
  return { sales: all.slice(0, cap), beyond: Math.max(0, all.length - cap) };
}

/** One sale's burn from its views. Null when the sale is not final or minted nothing. */
export function launchBurn(sale: Sale, result: SaleResult): LaunchBurn | null {
  if (result.status !== "settled" && result.status !== "failed") return null;
  if (sale.tokenSetup && sale.tokenSetup !== "done") return null;
  const c = sale.config;
  if (c.totalSupply <= 0n) return null;
  const l = supplyLedger(sale, result);
  const state = burnStateOf(result);
  return {
    id: sale.id,
    name: c.tokenName,
    symbol: c.tokenSymbol,
    hue: sale.meta.hue,
    icon: sale.meta.icon ?? null,
    decimals: c.decimals,
    status: result.status,
    minted: l.total,
    burn: l.burn,
    after: l.after,
    share: share(l.burn, l.total),
    state,
    landed: state === "burned" || state === "none",
    endedAt: c.bidEnd,
  };
}

/**
 * The counter over the sales read (from `finalSales`) and their results. A
 * sale with no result in `results` (missing, null or failed to load) counts
 * as unread. `beyond` is `finalSales`' count of sales left out.
 */
export function burnTotal(
  sales: Sale[],
  results: ReadonlyMap<string, SaleResult | null | undefined>,
  beyond = 0,
): BurnTotal {
  const rows: LaunchBurn[] = [];
  let unread = 0;
  for (const s of [...sales].sort(newestFirst)) {
    const r = results.get(s.id);
    const row = r ? launchBurn(s, r) : null;
    if (row) rows.push(row);
    else unread++;
  }
  const launches = rows.filter((r) => r.status === "settled");
  const meanShare = launches.length
    ? launches.reduce((a, r) => a + r.share, 0) / launches.length
    : null;
  return {
    launches: launches.length,
    meanShare,
    withBurn: launches.filter((r) => r.burn > 0n).length,
    owed: launches.filter((r) => !r.landed).length,
    failed: rows.length - launches.length,
    rows,
    beyondCap: beyond,
    unread,
  };
}

/**
 * The counter's headline: the figure and the sentence after it. Null when no
 * launch was read (the page then says so instead of showing a number).
 */
export function burnHeadline(t: BurnTotal): { value: string; line: string } | null {
  if (t.meanShare === null || t.launches === 0) return null;
  const n = t.launches;
  if (t.withBurn === 0) {
    return {
      value: "0%",
      line:
        n === 1
          ? "burned: the one launch so far sold every token for sale."
          : `burned: all ${n} launches sold every token for sale.`,
    };
  }
  const verb = t.owed > 0 ? "burned or set to burn" : "burned";
  return {
    value: shareStr(t.meanShare),
    line:
      n === 1
        ? `of the one launch's supply ${verb} because demand did not take it.`
        : `of each launch's supply ${verb} because demand did not take it, on average across ${n} launches.`,
  };
}

/**
 * The token page's line: this launch's burn next to the average. `total` may
 * be null while it loads; the line then says only this launch's part.
 */
export function launchVsAll(own: LaunchBurn, total: BurnTotal | null): string {
  const sym = own.symbol;
  const mine =
    own.burn === 0n
      ? `This launch sold every ${sym} for sale, so none of its supply burned.`
      : own.landed
        ? `This launch burned ${shareStr(own.share)} of its supply because demand did not take it.`
        : `This launch burns ${shareStr(own.share)} of its supply at the creator payout, because demand did not take it.`;
  if (!total || total.meanShare === null) return mine;
  const others = total.rows.some((r) => r.status === "settled" && r.id !== own.id);
  if (!others) return mine;
  const scope = total.beyondCap > 0 ? `the newest ${total.launches} Sealround launches` : `${total.launches} Sealround launches`;
  if (total.withBurn === 0) return `${mine} None of ${total.beyondCap > 0 ? scope : `the ${scope}`} burned any supply.`;
  return `${mine} Across ${scope}, the average burn is ${shareStr(total.meanShare)} of supply.`;
}

export type BurnWhere = "simulated" | "sandbox" | "testnet" | "mainnet";

const TAIL: Record<BurnWhere, string> = {
  simulated: "Simulated sealed-bid launch on Sealround.",
  sandbox: "Sealed-bid launch on a local NEAR sandbox.",
  testnet: "Sealed-bid launch on NEAR testnet.",
  mainnet: "Sealed-bid launch on NEAR.",
};

/** The X post for the burn moment. Facts only: what burned, why, and the supply after. */
export function burnShareText(
  symbol: string,
  decimals: number,
  burned: bigint,
  supplyAfter: bigint,
  where: BurnWhere,
): string {
  const sym = `$${symbol}`;
  return `${tokenStr(burned, decimals)} ${sym} burned for good. Demand did not take them, so the supply is now ${tokenStr(supplyAfter, decimals)}. ${TAIL[where]}`;
}
