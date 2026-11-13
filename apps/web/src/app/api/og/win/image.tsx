/**
 * Draws the winner card (`/api/og/win`) in the sale card's look
 * (lib/og/cards.tsx): the token, "No bot paid less.", "I got 12.48K $NOSNIPE
 * at 0.0016 USDC each.", how many winners paid that one price, and the
 * sale's clearing price, winners and bids.
 *
 * Fallbacks, so the route always answers with an image and never a 500: bad
 * parameters, mock mode without the sale's facts, an unknown sale, a sale
 * that has not settled or did not clear, a bid that won nothing, a node that
 * does not answer in time or answers in another shape all give the generic
 * app card; an icon the renderer cannot draw gives the same card with the
 * monogram.
 */

import { isNearMode } from "@/lib/config";
import { SaleCardImage, renderCardBytes } from "@/lib/og/cards";
import { loadOgFonts, type OgFont } from "@/lib/og/fonts";
import type { SaleCard } from "@/lib/og/sale-card";
import type { BidMode } from "../bid/card";
import { genericCard } from "../bid/image";
import { BID_LIMITS } from "../bid/share";
import {
  chainWinCard,
  mockWinCard,
  parseWinCardQuery,
  readWinCardViewsFromConfig,
  winnerViews,
  type WinCardViews,
} from "./card";
import { WIN_PARAMS } from "./share";

export type WinImageDeps = {
  mode?: () => BidMode;
  read?: (saleId: string, bidNumber: number) => Promise<WinCardViews | null>;
  fonts?: () => Promise<OgFont[] | undefined>;
};

const currentMode = (): BidMode => (isNearMode() ? "near" : "mock");

/** Draws the card; on a failure with the token's icon, the same card with the monogram. (A copy of ../bid/image.tsx's.) */
async function draw(card: SaleCard, fonts: OgFont[] | undefined, label: string): Promise<ArrayBuffer> {
  try {
    return await renderCardBytes(<SaleCardImage card={card} />, fonts);
  } catch (e) {
    if (!card.icon) throw e;
    console.warn(`[og] icon of ${label} did not render, drawing the monogram: ${e instanceof Error ? e.message : e}`);
    return renderCardBytes(<SaleCardImage card={{ ...card, icon: null }} />, fonts);
  }
}

function cacheControl(): string {
  if (process.env.NODE_ENV === "development") return "no-cache, no-store";
  // A settled sale's fills, price and counts no longer change, in NEAR mode as in a mock link.
  return "public, max-age=3600, s-maxage=86400";
}

export async function winImage(params: URLSearchParams, deps: WinImageDeps = {}): Promise<Response> {
  const fontsP = (deps.fonts ?? loadOgFonts)().catch(() => undefined);
  let label = "a winner card";
  try {
    const mode = (deps.mode ?? currentMode)();
    const sales = params.getAll(WIN_PARAMS.sale);
    const saleId = sales.length === 1 && sales[0].length <= BID_LIMITS.raw ? sales[0] : "";
    const q = parseWinCardQuery(saleId, params, mode);
    if (q) {
      label = `win #${q.bidNumber} of ${q.saleId}`;
      let card: SaleCard | null = null;
      if (q.sim) {
        card = mockWinCard({ ...q, sim: q.sim });
      } else if (mode === "near") {
        const views = await (deps.read ?? readWinCardViewsFromConfig)(q.saleId, q.bidNumber).catch(() => null);
        const winner = winnerViews(views);
        if (winner) card = chainWinCard(winner, q);
      }
      if (card) {
        const bytes = await draw(card, await fontsP, label);
        return new Response(bytes, { headers: { "content-type": "image/png", "cache-control": cacheControl() } });
      }
    }
  } catch (e) {
    console.warn(`[og] ${label} failed, serving the generic card: ${e instanceof Error ? e.message : e}`);
  }
  return genericCard(await fontsP);
}
