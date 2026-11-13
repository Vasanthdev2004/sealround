import type { Metadata, ResolvingMetadata } from "next";
import { isNearMode } from "@/lib/config";
import { nsToMs } from "@/lib/near/views";
import { OG_SIZE } from "@/lib/og/cards";
import { saleViewsForCard, type SaleCardViews } from "@/lib/og/sale-data";
import { bidCardText, parseBidCardQuery, type BidMode, type QueryInput } from "./card";
import { BID_PARAMS, bidImagePath } from "./share";

type Deps = {
  mode?: () => BidMode;
  /** The sale for its ticker and reveal time (NEAR mode); memoized with the page's own read. */
  read?: (saleId: string) => Promise<SaleCardViews | null>;
};

/**
 * The sale page's metadata when its link names a bid (`?bid=12`, the link
 * the "I'm in" share flow posts): the bid card as og:image and twitter:image,
 * and the card's words as their title and description. The page's own
 * <title> is left alone.
 *
 * Without `bid`, or when it does not check out (not a number, a bid the sale
 * does not have yet, a mock link without its ticker), `base` comes back
 * unchanged, so the preview is the sale's usual card. The image route checks
 * the bid again against get_bids before it draws it.
 */
export async function withBidCard(
  base: Metadata,
  args: { params: Promise<{ id: string }>; searchParams: Promise<QueryInput>; parent: ResolvingMetadata },
  deps: Deps = {},
): Promise<Metadata> {
  const search = await args.searchParams;
  const raw = search instanceof URLSearchParams ? search.get(BID_PARAMS.bid) : search[BID_PARAMS.bid];
  if (raw === undefined || raw === null) return base;

  const mode = (deps.mode ?? (() => (isNearMode() ? "near" : "mock")))();
  const { id } = await args.params;
  const q = parseBidCardQuery(id, search, mode);
  if (!q) return base;

  let ticker: string;
  let revealAt: number | null;
  if (q.sim) {
    ticker = q.sim.ticker;
    revealAt = q.sim.revealAt;
  } else {
    const views = await (deps.read ?? saleViewsForCard)(id).catch(() => null);
    // A bid number past the sale's count is not a bid (yet): keep the sale's own card.
    if (!views || q.bidNumber > views.sale.bid_count) return base;
    ticker = views.sale.token_symbol;
    revealAt = nsToMs(views.sale.bid_end);
  }

  const text = bidCardText({ ticker, bidNumber: q.bidNumber, revealAt, simulated: !!q.sim });
  const url = bidImagePath({ saleId: id, bidNumber: q.bidNumber, account: q.by, sim: q.sim });
  const image = { url, ...OG_SIZE, alt: text.alt, type: "image/png" };
  const og = (await args.parent).openGraph;
  return {
    ...base,
    openGraph: {
      type: "website",
      ...(og?.siteName ? { siteName: og.siteName } : {}),
      ...(og?.locale ? { locale: og.locale } : {}),
      title: text.title,
      description: text.description,
      images: [image],
    },
    twitter: { card: "summary_large_image", title: text.title, description: text.description, images: [image] },
  };
}
