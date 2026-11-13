/**
 * The words and link behind "Share on X". Facts only, from the result: the
 * clearing price, and when the first and last winning bids landed.
 */

import { priceStr } from "@/lib/format";
import type { Sale, SaleResult } from "@/lib/types";
import { failText } from "./compute";
import { afterOpen, beforeClose, type Timeline } from "./timeline";

export type ShareWhere = "simulated" | "sandbox" | "testnet" | "mainnet";

export function shareText(
  sale: Sale,
  result: SaleResult,
  timeline: Timeline | null,
  where: ShareWhere,
): string {
  const sym = `$${sale.config.tokenSymbol}`;
  const tail =
    where === "simulated"
      ? "Simulated sealed-bid launch on Sealround."
      : where === "sandbox"
        ? "Sealed-bid launch on a local NEAR sandbox."
        : where === "testnet"
          ? "Sealed-bid launch on NEAR testnet."
          : "Sealed-bid launch on NEAR.";

  if (result.status === "failed") {
    const { title } = failText(result, sale);
    return `The ${sym} sale sold no tokens (${title.toLowerCase()}), so the deposits go back. ${tail}`;
  }

  const price = `${priceStr(result.clearingPrice)} USDC per token`;
  const t = timeline;
  if (t?.bot && t.person && t.bot.at < t.person.at) {
    return `Bots and people paid the same ${price} for ${sym}. A bot bid ${afterOpen(t.bot)}, a person ${beforeClose(t.person)}. ${tail}`;
  }
  const a = t?.firstWinner;
  const b = t?.lastWinner;
  if (a && b && a.at < b.at) {
    return `Everyone paid ${price} for ${sym}, bots included. The first winning bid landed ${afterOpen(a)}, the last ${beforeClose(b)}. ${tail}`;
  }
  return `Everyone paid ${price} for ${sym}, bots included. ${tail}`;
}

/**
 * The page to link. A judge-mode sale exists only in the browser that ran
 * it, so for those the link is the judge page, where anyone can run their own.
 */
export function sharePath(sale: Pick<Sale, "id" | "isJudgeSale">, simulated: boolean): string {
  return simulated && sale.isJudgeSale ? "/judge" : `/sale/${encodeURIComponent(sale.id)}/result`;
}

/** X's post intent. No script, no tracking: a plain link the viewer opens. */
export function xIntentUrl(text: string, url: string | null): string {
  const q = `text=${encodeURIComponent(text)}${url ? `&url=${encodeURIComponent(url)}` : ""}`;
  return `https://x.com/intent/post?${q}`;
}
