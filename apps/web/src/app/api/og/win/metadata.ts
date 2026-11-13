import type { Metadata, ResolvingMetadata } from "next";
import { isNearMode } from "@/lib/config";
import { OG_SIZE } from "@/lib/og/cards";
import type { BidMode, QueryInput } from "../bid/card";
import { parseWinCardQuery, readWinCardViewsFromConfig, winCardText, winnerViews, type WinCardViews } from "./card";
import { WIN_PARAMS, winImagePath } from "./share";

type Deps = {
  mode?: () => BidMode;
  /** The sale, its result and the fill (NEAR mode), memoized per request. The image route reads them again on its own. */
  read?: (saleId: string, bidNumber: number) => Promise<WinCardViews | null>;
};

/**
 * The result page's metadata when its link names a winning bid (`?win=12`,
 * the link the winner card's share flow posts): the winner card as og:image
 * and twitter:image, and the card's words as their title and description.
 * The page's own <title> is left alone.
 *
 * Without `win`, or when it does not check out (not a number, a mock link
 * without the sale's facts, in NEAR mode a sale that has not settled or a
 * bid that won nothing), `base` comes back unchanged, so the preview is the
 * sale's usual card.
 */
export async function withWinCard(
  base: Metadata,
  args: { params: Promise<{ id: string }>; searchParams: Promise<QueryInput>; parent: ResolvingMetadata },
  deps: Deps = {},
): Promise<Metadata> {
  const search = await args.searchParams;
  const raw = search instanceof URLSearchParams ? search.get(WIN_PARAMS.win) : search[WIN_PARAMS.win];
  if (raw === undefined || raw === null) return base;

  const mode = (deps.mode ?? (() => (isNearMode() ? "near" : "mock")))();
  const { id } = await args.params;
  const q = parseWinCardQuery(id, search, mode);
  if (!q) return base;

  let text: ReturnType<typeof winCardText>;
  if (q.sim) {
    text = winCardText({ ...q.sim, simulated: true });
  } else {
    const views = await (deps.read ?? readWinCardViewsFromConfig)(id, q.bidNumber).catch(() => null);
    const w = winnerViews(views);
    if (!w) return base;
    text = winCardText({
      ticker: w.sale.token_symbol,
      tokens: BigInt(w.fill.tokens),
      decimals: w.sale.decimals,
      price: BigInt(w.result.clearing_price),
      winners: w.result.n_winners,
      simulated: false,
    });
  }

  const url = winImagePath({ saleId: id, bidNumber: q.bidNumber, account: q.by, sim: q.sim });
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
