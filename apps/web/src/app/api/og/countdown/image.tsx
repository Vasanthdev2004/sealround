/**
 * Draws the countdown image (`/api/og/countdown`) in the sale card's look
 * (lib/og/cards.tsx): the token, "Bids open" or "Sealed bids close" with the
 * time in UTC, the one-price line and a few facts.
 *
 * Fallbacks, so the route always answers with an image and never a 500: bad
 * parameters, mock mode without the sale's facts, an unknown sale or a node
 * that does not answer give the generic app card; a settled or failed sale
 * gives the sale's own card (how it ended); an icon the renderer cannot draw
 * gives the same card with the monogram.
 */

import { isNearMode } from "@/lib/config";
import { AppCard, SaleCardImage, renderCard, renderCardBytes } from "@/lib/og/cards";
import { loadOgFonts, type OgFont } from "@/lib/og/fonts";
import type { SaleCard } from "@/lib/og/sale-card";
import { saleImage } from "@/lib/og/sale-image";
import {
  chainFacts,
  chainStatus,
  countdownCard,
  countdownPhase,
  parseCountdownQuery,
  readCountdownViews,
  simFacts,
  type CountdownMode,
  type CountdownViews,
} from "./card";

export type CountdownImageDeps = {
  mode?: () => CountdownMode;
  read?: (saleId: string) => Promise<CountdownViews | null>;
  fonts?: () => Promise<OgFont[] | undefined>;
  /** The sale's own card, for a settled or failed sale. */
  saleCard?: (saleId: string) => Promise<Response>;
  now?: () => number;
};

const currentMode = (): CountdownMode => (isNearMode() ? "near" : "mock");

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

function cacheControl(): string {
  if (process.env.NODE_ENV === "development") return "no-cache, no-store";
  // The phase moves with the clock (open, then closed): keep the card a minute only.
  return "public, max-age=60, s-maxage=60, stale-while-revalidate=300";
}

export async function countdownImage(params: URLSearchParams, deps: CountdownImageDeps = {}): Promise<Response> {
  const fontsP = (deps.fonts ?? loadOgFonts)().catch(() => undefined);
  let label = "a countdown card";
  try {
    const mode = (deps.mode ?? currentMode)();
    const now = (deps.now ?? Date.now)();
    const q = parseCountdownQuery(params, mode);
    if (q) {
      label = `the countdown of ${q.saleId}`;
      let card: SaleCard | null = null;
      if (q.sim) {
        const f = simFacts(q.sim);
        const phase = countdownPhase(null, f.bidStart, f.bidEnd, now);
        if (phase !== "final") card = countdownCard(f, phase);
      } else if (mode === "near") {
        const views = await (deps.read ?? readCountdownViews)(q.saleId).catch(() => null);
        if (views) {
          const f = chainFacts(views);
          const phase = countdownPhase(chainStatus(views), f.bidStart, f.bidEnd, now);
          if (phase === "final") return await (deps.saleCard ?? saleImage)(q.saleId);
          card = countdownCard(f, phase);
        }
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
