/**
 * What a sale's share card and page title say, from the contract's views.
 * Pure: no network, no rendering. `cards.tsx` draws it.
 */

import { STATUS_LABEL, priceStr, tokenStr, usdcStr } from "../format";
import { foldStatus, type ResultView, type SaleView } from "../near/views";
import { isEmojiMark, parseMark, rasterIcon } from "../token-icon";
import type { ChainFailReason } from "../types";

export type CardTone = "accent" | "ok" | "warn" | "neutral";

export type CardStat = { label: string; value: string; unit?: string };

/**
 * The token's icon as the card can draw it. next/og draws PNG and JPEG data
 * URLs, not WebP or GIF (they come out blank), and has no font inside an SVG
 * image (an emoji makes it throw). So: a PNG or JPEG is an image, a mark this
 * app generated is redrawn from its colours and letters (an emoji mark shows
 * the monogram on its colour), and anything else falls back to the monogram.
 */
export type CardIcon = { kind: "image"; src: string } | { kind: "mark"; bg: string; fg: string; text: string };

export type SaleCard = {
  name: string;
  symbol: string;
  /** The token avatar's two letters, as on the sales board. */
  monogram: string;
  /** The token's icon when the card can draw it; null: the monogram. */
  icon: CardIcon | null;
  phase: string;
  tone: CardTone;
  /** The number that matters: the clearing price once settled, the floor before. Null when there is none. */
  hero: { label: string; value: string; unit: string } | null;
  /** Shown in place of a number on a sale that did not clear. */
  outcome: string | null;
  /** One line under the number. */
  line: string;
  /** A second, muted line (a failed sale's refund). */
  note: string | null;
  /** "Everyone paid the same price" is the line in accent; other lines are muted. */
  lineAccent: boolean;
  stats: CardStat[];
  network: string;
};

type SaleFields = Pick<
  SaleView,
  | "status"
  | "token_name"
  | "token_symbol"
  | "decimals"
  | "sale_supply"
  | "floor_price"
  | "min_raise"
  | "bid_count"
  | "reveal_mode"
> &
  Partial<Pick<SaleView, "icon">>;
type ResultFields = Pick<ResultView, "fail_reason" | "clearing_price" | "total_sold" | "unsold" | "proceeds">;

const NAME_MAX = 34;
const SYMBOL_MAX = 16;

const FAIL_TEXT: Record<ChainFailReason, string> = {
  no_bids: "No bids came in.",
  no_valid_bids: "No bid was valid.",
  below_min_raise: "Bids stayed below the minimum raise.",
  nothing_sold: "No bid reached the floor price.",
  checks_failed: "The result failed the contract's checks.",
  refund_mode: "The sale timed out before it cleared.",
};

/**
 * Text that renders the same offline: control characters and emoji are
 * dropped (next/og would fetch emoji images from a CDN), whitespace is
 * collapsed, and long text is cut with an ellipsis.
 */
export function cardText(raw: string, max: number): string {
  const clean = raw
    .replace(/[\p{Cc}\p{Cf}\p{Extended_Pictographic}\u{FE0F}\u{20E3}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  const chars = [...clean];
  return chars.length <= max ? clean : `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}

const count = (n: number) => n.toLocaleString("en-US");

/** The view's icon as the card draws it, or null for the monogram. */
export function cardIcon(icon: unknown, monogram: string): CardIcon | null {
  if (typeof icon !== "string" || !icon) return null;
  const mark = parseMark(icon);
  if (mark) return { kind: "mark", bg: mark.bg, fg: mark.fg, text: isEmojiMark(mark.text) ? monogram : mark.text };
  const raster = rasterIcon(icon);
  return raster && (raster.type === "png" || raster.type === "jpeg") ? { kind: "image", src: icon } : null;
}

export function saleCard(
  sale: SaleFields,
  result: ResultFields | null,
  network: string,
): SaleCard {
  const name = cardText(sale.token_name, NAME_MAX) || "Unnamed token";
  const symbol = cardText(sale.token_symbol, SYMBOL_MAX) || "TOKEN";
  const status = foldStatus(sale.status);
  const tee = sale.reveal_mode !== "CommitReveal";
  const perToken = `USDC per ${symbol}`;
  const monogram = [...symbol].slice(0, 2).join("");
  const base = {
    name,
    symbol,
    monogram,
    icon: cardIcon(sale.icon, monogram),
    phase: STATUS_LABEL[status] ?? status,
    network: `NEAR ${network}`,
    outcome: null,
    note: null,
    lineAccent: false,
  };
  const forSale: CardStat = { label: "For sale", value: tokenStr(BigInt(sale.sale_supply), sale.decimals), unit: symbol };
  const minRaise: CardStat = { label: "Min raise", value: usdcStr(BigInt(sale.min_raise)), unit: "USDC" };
  const floor = { label: "Floor price", value: priceStr(BigInt(sale.floor_price)), unit: perToken };

  if (status === "settled") {
    const stats: CardStat[] = result
      ? [
          { label: "Sold", value: tokenStr(BigInt(result.total_sold), sale.decimals), unit: symbol },
          {
            label: result.proceeds?.unsold_burned || BigInt(result.unsold) === 0n ? "Burned" : "Unsold, to burn",
            value: tokenStr(BigInt(result.unsold), sale.decimals),
            unit: symbol,
          },
          { label: "Bidders", value: count(sale.bid_count) },
        ]
      : [forSale, { label: "Bidders", value: count(sale.bid_count) }];
    return {
      ...base,
      tone: "ok",
      hero: result ? { label: "Clearing price", value: priceStr(BigInt(result.clearing_price)), unit: perToken } : null,
      outcome: result ? null : "Settled",
      line: "Everyone paid the same price.",
      lineAccent: true,
      stats,
    };
  }

  if (status === "failed") {
    const reason = result?.fail_reason ? FAIL_TEXT[result.fail_reason] : null;
    return {
      ...base,
      tone: "warn",
      hero: null,
      outcome: "Did not clear",
      line: reason ?? "No tokens were sold.",
      note: "Every valid bid gets its whole deposit back.",
      stats: [forSale, { label: "Bidders", value: count(sale.bid_count) }, minRaise],
    };
  }

  const sealedBids: CardStat = { label: "Sealed bids", value: count(sale.bid_count) };
  const line =
    status === "upcoming"
      ? "Bidding opens soon. Bids stay sealed until close."
      : status === "open"
        ? "Bids stay sealed until close. Everyone pays one clearing price."
        : tee
          ? "Bidding is closed. An attested enclave opens every bid at once."
          : "Bidding is closed. Bidders reveal their bids, then one price clears.";
  return {
    ...base,
    tone: status === "open" ? "accent" : "neutral",
    hero: floor,
    line,
    stats: [forSale, sealedBids, minRaise],
  };
}

/** Page title and description for a sale or its result, in the words of the card. */
export function saleMeta(card: SaleCard, page: "sale" | "result"): { title: string; description: string } {
  const who = `${card.name} (${card.symbol})`;
  const title = page === "result" ? `${who} result` : who;
  const stat = (label: string) => card.stats.find((s) => s.label === label);
  if (card.hero && card.lineAccent) {
    const bidders = stat("Bidders")?.value;
    const tail = bidders
      ? `${bidders} ${bidders === "1" ? "bidder" : "bidders"}, everyone paid the same price.`
      : "Everyone paid the same price.";
    return { title, description: `${who} settled at ${card.hero.value} ${card.hero.unit}. ${tail}` };
  }
  if (card.outcome === "Did not clear") {
    return { title, description: `${who} did not clear. ${card.line}${card.note ? ` ${card.note}` : ""}` };
  }
  const forSale = stat("For sale");
  const what = forSale ? `${forSale.value} ${forSale.unit}` : card.symbol;
  return { title, description: `${who}: a sealed-bid sale of ${what} on ${card.network}. ${card.line}` };
}

/**
 * Font size for the card's big number, so the value and its unit fit on one
 * 1072px line: Inter's tabular figures are about 0.62 em wide, the unit's
 * letters about 0.55 em at 32px.
 */
export function heroFontSize(value: string, unit: string): number {
  const room = 1072 - 24 - unit.length * 32 * 0.55;
  return Math.max(56, Math.min(112, Math.floor(room / (value.length * 0.62))));
}
