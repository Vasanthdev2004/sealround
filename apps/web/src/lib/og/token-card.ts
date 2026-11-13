/**
 * What a token page's share card and title say (`/token/[id]`), from the
 * contract's views. Pure: no network, no rendering. The card is the sale
 * card's layout (`SaleCardImage`) with the token's launch figures.
 *
 * Only a settled sale has a token page card. Before that, or for a failed
 * sale, the caller draws the sale's own card.
 */

import { tokenFigures } from "@/components/token/figures";
import { priceStr, tokenStr } from "../format";
import { resultFromViews, saleFromView } from "../near/views";
import { cardText, saleCard, type SaleCard } from "./sale-card";
import type { SaleCardViews } from "./sale-data";

const count = (n: number) => n.toLocaleString("en-US");

/** The token card of a settled sale; null for any other sale, or without its result. */
export function tokenCard(views: SaleCardViews): SaleCard | null {
  const { sale: sv, result: rv, network } = views;
  if (sv.status !== "settled" || !rv) return null;
  const sale = saleFromView(sv);
  // Fills are not read for a card: the winners count comes from get_result.
  const result = resultFromViews(sv, [], rv, []);
  if (!result || result.status !== "settled") return null;
  const f = tokenFigures(sale, result, rv.n_winners);
  const base = saleCard(sv, rv, network);
  const sym = base.symbol;
  const seeded = result.liquidity?.stage === "seeded";
  return {
    ...base,
    phase: seeded ? "Trading on Rhea" : "Launched",
    tone: "ok",
    hero: { label: "Launch price", value: priceStr(f.launchPrice), unit: `USDC per ${sym}` },
    outcome: null,
    line: f.holders === 1 ? "The clearing price its one winner paid." : "Every winner paid the same price, bots included.",
    lineAccent: true,
    note: f.poolPrice !== null ? `Pool opened at ${priceStr(f.poolPrice)} USDC per ${sym}.` : null,
    stats: [
      { label: f.supply.label === "Supply now" ? "Supply now" : "Supply after burn", value: tokenStr(f.supply.value, sale.config.decimals), unit: sym },
      { label: f.burn.done ? "Burned" : "To burn", value: tokenStr(f.burn.value, sale.config.decimals), unit: sym },
      { label: "Holders at launch", value: count(f.holders) },
      // Compact like the other stats, so a large raise fits its cell.
      { label: "Raised", value: tokenStr(f.raised, 6), unit: "USDC" },
    ],
  };
}

/** Page title and description of a token page. */
export function tokenMeta(views: SaleCardViews): { title: string; description: string } {
  const { sale: sv } = views;
  const name = cardText(sv.token_name, 60) || "Unnamed token";
  const symbol = cardText(sv.token_symbol, 16) || "TOKEN";
  const title = `$${symbol} on Sealround`;
  const card = tokenCard(views);
  if (card?.hero) {
    const holders = card.stats.find((s) => s.label === "Holders at launch")?.value ?? "0";
    const burn = card.stats.find((s) => s.label === "Burned" || s.label === "To burn");
    const burnLine = burn && burn.value !== "0" ? ` ${burn.value} ${symbol} ${burn.label === "Burned" ? "burned" : "to burn"}.` : "";
    return {
      title,
      description: `${name} launched at ${card.hero.value} ${card.hero.unit}, one price for every winner. ${holders} ${
        holders === "1" ? "holder" : "holders"
      } at launch.${burnLine}`,
    };
  }
  if (sv.status === "failed") {
    return { title, description: `The ${name} sale did not clear, so no ${symbol} trades. Every valid bid gets its deposit back.` };
  }
  return { title, description: `${name} (${symbol}) launches when its sealed-bid sale on Sealround settles.` };
}
