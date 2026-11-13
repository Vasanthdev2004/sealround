/**
 * Pure helpers for the token page (/token/[id]) and its share card: the key
 * figures of a settled sale's token and the words of its X post. Amounts stay
 * bigint. The supply figures come from the result page's ledger
 * (`supplyLedger`), so both pages say the same thing.
 */

import { poolPrice } from "@fairground/clearing";
import type { ShareWhere } from "@/components/result/share-text";
import { supplyLedger, type SupplyLedger, type TradeState } from "@/components/result/supply";
import { priceStr, tokenStr } from "@/lib/format";
import type { Sale, SaleResult } from "@/lib/types";

export type TokenFigures = {
  /** The clearing price every winner paid, USDC base units per whole token. */
  launchPrice: bigint;
  /** The seeded launch pool's opening price; null without a seeded pool. */
  poolPrice: bigint | null;
  /** The supply now, or after the burn when the views cannot say how much of it landed. */
  supply: { label: string; value: bigint };
  /** The launch burn: unsold sale supply plus any pool reserve the pool did not take. */
  burn: { label: string; value: bigint; done: boolean };
  /** Accounts that bought tokens in the sale. */
  holders: number;
  /** USDC the sale raised, base units. */
  raised: bigint;
  ledger: SupplyLedger;
};

type ResultFields = Pick<
  SaleResult,
  "status" | "clearingPrice" | "totalSold" | "totalRaised" | "unsold" | "proceeds" | "liquidity"
>;

/** Winners: fills that got tokens. */
export const holdersOf = (fills: { tokens: bigint }[]): number => fills.filter((f) => f.tokens > 0n).length;

/** The key figures of a settled sale's token. `holders` is the number of winners. */
export function tokenFigures(sale: Pick<Sale, "config">, result: ResultFields, holders: number): TokenFigures {
  const c = sale.config;
  const ledger = supplyLedger(sale, result);
  const l = result.liquidity;
  const done = ledger.burnState === "burned" || ledger.burnState === "none";
  return {
    launchPrice: result.clearingPrice,
    poolPrice: l?.stage === "seeded" ? poolPrice(l.usdc, l.tokens, c.decimals) : null,
    supply:
      ledger.supplyNow !== null
        ? { label: "Supply now", value: ledger.supplyNow }
        : { label: "Supply after the burn", value: ledger.after },
    burn: {
      label: done ? "Burned at launch" : ledger.burnState === "partial" ? "Burned or to burn" : "To burn",
      value: ledger.burn,
      done,
    },
    holders,
    raised: result.totalRaised,
    ledger,
  };
}

// ---------- sharing ----------

const TAIL: Record<ShareWhere, string> = {
  simulated: "Simulated sealed-bid launch on Sealround.",
  sandbox: "Sealed-bid launch on a local NEAR sandbox.",
  testnet: "Sealed-bid launch on NEAR testnet.",
  mainnet: "Sealed-bid launch on NEAR.",
};

/**
 * The X post for a token: its launch price, the burn and where it trades.
 * Facts only. A simulated pool is never called trading.
 */
export function tokenShareText(
  sale: Pick<Sale, "config">,
  f: Pick<TokenFigures, "launchPrice" | "burn" | "holders">,
  trade: TradeState,
  where: ShareWhere,
): string {
  const c = sale.config;
  const sym = `$${c.tokenSymbol}`;
  const price = `${priceStr(f.launchPrice)} USDC per token`;
  const parts = [
    f.holders === 1
      ? `${sym} launched at ${price}, the clearing price its one winner paid.`
      : `${sym} launched at ${price}, the one price all ${f.holders} winners paid, bots included.`,
  ];
  if (f.burn.value > 0n) parts.push(`${tokenStr(f.burn.value, c.decimals)} ${sym} ${f.burn.done ? "burned" : "to burn"}.`);
  if (trade.kind === "open" && !trade.simulated && trade.venue) parts.push(`Trading on ${trade.venue}.`);
  parts.push(TAIL[where]);
  return parts.join(" ");
}

/**
 * The page to link. A judge-mode sale exists only in the browser that ran it,
 * so for those the link is the judge page, where anyone can run their own.
 */
export function tokenSharePath(sale: Pick<Sale, "id" | "isJudgeSale">, simulated: boolean): string {
  return simulated && sale.isJudgeSale ? "/judge" : `/token/${encodeURIComponent(sale.id)}`;
}
