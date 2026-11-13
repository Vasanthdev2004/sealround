/**
 * Draws the "I'm in" bid card (`/api/og/bid`) in the sale card's look
 * (lib/og/cards.tsx): the token, "I'm in.", "Sealed bid #12 in $NOSNIPE",
 * the reveal time and the sale's public totals.
 *
 * Fallbacks, so the route always answers with an image and never a 500:
 * bad parameters, mock mode without a ticker, an unknown sale or a node that
 * does not answer give the generic app card; a NEAR sale that has no bid at
 * that number gives the sale's own card; an icon the renderer cannot draw
 * gives the same card with the monogram.
 */

import { isNearMode } from "@/lib/config";
import { AppCard, SaleCardImage, renderCard, renderCardBytes } from "@/lib/og/cards";
import { loadOgFonts, type OgFont } from "@/lib/og/fonts";
import type { SaleCard } from "@/lib/og/sale-card";
import { saleImage } from "@/lib/og/sale-image";
import {
  chainBidCard,
  mockBidCard,
  parseBidCardQuery,
  readBidCardViewsFromConfig,
  type BidCardViews,
  type BidMode,
} from "./card";
import { BID_LIMITS, BID_PARAMS } from "./share";

export type BidImageDeps = {
  mode?: () => BidMode;
  read?: (saleId: string, bidNumber: number) => Promise<BidCardViews | null>;
  fonts?: () => Promise<OgFont[] | undefined>;
  /** The sale's own card, for a sale without a bid at that number. */
  saleCard?: (saleId: string) => Promise<Response>;
};

const currentMode = (): BidMode => (isNearMode() ? "near" : "mock");

/** The generic app card. */
export function genericCard(fonts: OgFont[] | undefined): Response {
  return renderCard(<AppCard />, fonts);
}

/** Draws the card; on a failure with the token's icon, the same card with the monogram. */
async function draw(card: SaleCard, fonts: OgFont[] | undefined, label: string): Promise<ArrayBuffer> {
  try {
    return await renderCardBytes(<SaleCardImage card={card} />, fonts);
  } catch (e) {
    if (!card.icon) throw e;
    console.warn(`[og] icon of ${label} did not render, drawing the monogram: ${e instanceof Error ? e.message : e}`);
    return renderCardBytes(<SaleCardImage card={{ ...card, icon: null }} />, fonts);
  }
}

function cacheControl(mode: BidMode): string {
  if (process.env.NODE_ENV === "development") return "no-cache, no-store";
  // NEAR: the totals move, so a CDN keeps the card for a few minutes. Mock: the link alone decides the card.
  return mode === "near"
    ? "public, max-age=0, s-maxage=300, stale-while-revalidate=600"
    : "public, max-age=3600, s-maxage=86400";
}

export async function bidImage(params: URLSearchParams, deps: BidImageDeps = {}): Promise<Response> {
  const fontsP = (deps.fonts ?? loadOgFonts)().catch(() => undefined);
  let label = "a bid card";
  try {
    const mode = (deps.mode ?? currentMode)();
    const sales = params.getAll(BID_PARAMS.sale);
    const saleId = sales.length === 1 && sales[0].length <= BID_LIMITS.raw ? sales[0] : "";
    const q = parseBidCardQuery(saleId, params, mode);
    if (q) {
      label = `bid #${q.bidNumber} of ${q.saleId}`;
      let card: SaleCard | null = null;
      if (q.sim) {
        card = mockBidCard({ ...q, sim: q.sim });
      } else if (mode === "near") {
        const views = await (deps.read ?? readBidCardViewsFromConfig)(q.saleId, q.bidNumber).catch(() => null);
        if (views && !views.bid) return await (deps.saleCard ?? saleImage)(q.saleId);
        if (views?.bid) card = chainBidCard({ ...views, bid: views.bid }, q);
      }
      if (card) {
        const bytes = await draw(card, await fontsP, label);
        return new Response(bytes, { headers: { "content-type": "image/png", "cache-control": cacheControl(mode) } });
      }
    }
  } catch (e) {
    console.warn(`[og] ${label} failed, serving the generic card: ${e instanceof Error ? e.message : e}`);
  }
  return genericCard(await fontsP);
}
